// ChatGPT 대화 하나 = `codex app-server` 프로세스 하나 + Codex 스레드 하나.
//   thread/start(새 대화) · thread/resume(이어서, 스레드 ID = 대화의 sessionId) → turn/start(질문) → 알림(item/*, turn/completed)
//   Codex 자체 도구는 꺼 두고(launch.ts) 앱 도구를 동적 도구로 준다 → Codex가 item/tool/call로 부르면
//   대화 관리의 권한 확인(canUseTool)을 거쳐 앱이 실행하고 결과를 돌려준다 (Gemini와 같은 도구·규칙)
// 확인: codex-cli 0.163.0 + 가짜 Responses API 서버 (scripts/codex-smoke.mjs)
import type { ClaudeErrorCode } from '../../shared/desktop-api';
import { Aborted, AgentQueryBase, type ToolOutcome } from '../ai/agent-query';
import { EngineError, type EngineOpenOptions } from '../ai/engine';
import { FS_TOOLS, runFsTool } from '../ai/fstools';
import { codexTools, toClaudeTool } from '../ai/tools';
import type { CliTarget } from '../claude/cli';
import type { LaunchPlan } from './launch';
import { AppServer, RpcError } from './rpc';

export interface CodexQueryDeps {
  launch(): Promise<{ target: CliTarget; plan: LaunchPlan }>;
  appVersion: string;
  commandTimeoutMs?: number;
  /** 시험용: thread/start·resume에 같이 보낼 설정 */
  extraConfig?: Record<string, unknown>;
}

interface TurnInfo {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: { message?: string; codexErrorInfo?: unknown; additionalDetails?: string | null } | null;
}

/** Codex 오류 정보 → 오류 종류와 문구 */
export function codexError(err: TurnInfo['error'] | undefined): { code: ClaudeErrorCode; detail: string } {
  const info = err?.codexErrorInfo;
  const msg = String(err?.message ?? 'Codex 오류').trim();
  const detail = err?.additionalDetails && !msg.includes(err.additionalDetails) ? `${msg} (${err.additionalDetails})` : msg;
  const obj = info && typeof info === 'object' ? (Object.values(info as Record<string, unknown>)[0] as { httpStatusCode?: number | null } | undefined) : undefined;
  const http = typeof obj?.httpStatusCode === 'number' ? obj.httpStatusCode : (/\bstatus (\d{3})\b/.exec(msg)?.[1] ? Number(/\bstatus (\d{3})\b/.exec(msg)![1]) : null);
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded') return { code: /billing|credits?|결제/i.test(detail) ? 'billing' : 'limit', detail };
  if (info === 'unauthorized' || http === 401 || http === 403) return { code: 'auth', detail };
  if (http === 429) return { code: 'limit', detail };
  if (http === 402) return { code: 'billing', detail };
  if (info === 'contextWindowExceeded') return { code: 'other', detail: `대화가 너무 길어 더 이어 갈 수 없습니다. 새 대화로 시작해 주세요 (${detail})` };
  if (info === 'serverOverloaded' || info === 'internalServerError' || (http !== null && http >= 500)) return { code: 'other', detail: `서버 혼잡: ${detail}` };
  if (obj && http === null) return { code: 'offline', detail };
  if (/not logged in|login required|codex login/i.test(detail)) return { code: 'auth', detail };
  return { code: 'other', detail };
}

export class CodexQuery extends AgentQueryBase {
  private server: AppServer | null = null;
  private threadId = '';
  private turnId = '';
  private activeModel = '';
  private fixedModel?: string;
  private resumeMissing = false;
  private waiter: { resolve(t: TurnInfo): void; reject(e: Error): void } | null = null;
  private msgs = new Map<string, { begun: boolean; text: string }>();
  private lastText = '';
  /** 다음 턴에 모델을 바꿔 보낸다 */
  private modelDirty = false;

  private constructor(
    o: EngineOpenOptions,
    private deps: CodexQueryDeps,
  ) {
    super(o);
  }

  static async open(o: EngineOpenOptions, deps: CodexQueryDeps): Promise<CodexQuery> {
    const q = new CodexQuery(o, deps);
    try {
      await q.connect();
    } catch (e) {
      q.server?.close();
      throw e;
    }
    q.start();
    return q;
  }

  private async connect(): Promise<void> {
    const { target, plan } = await this.deps.launch();
    this.fixedModel = plan.fixedModel;
    this.server = await AppServer.start({
      target,
      args: plan.args,
      env: plan.env,
      cwd: this.o.cwd,
      appVersion: this.deps.appVersion,
      onNotification: (m, p) => this.onNotification(m, p),
      onRequest: (m, p) => this.onRequest(m, p),
      onExit: (x) => {
        this.waiter?.reject(new EngineError(`Codex가 응답 도중 끝났습니다 (종료 코드 ${x.code ?? x.signal})${x.stderr.trim() ? `: ${x.stderr.trim().split('\n').pop()}` : ''}`, 'other'));
        // 다음 메시지 때 대화 관리가 새로 연다 (오류 결과를 먼저 보낸 뒤 닫는다)
        setTimeout(() => this.close(), 0);
      },
      stderr: (s) => this.o.stderr?.(s),
    });
    // 사용자 Codex 설정의 MCP 서버는 끈다 (그 도구로 작업 폴더 밖을 읽지 않게)
    const cfg = await this.server.request<{ config?: { mcp_servers?: Record<string, unknown> } }>('config/read', { cwd: this.o.cwd }, 20000).catch(() => null);
    const mcpOff = Object.fromEntries(Object.keys(cfg?.config?.mcp_servers ?? {}).map((n) => [n, { enabled: false }]));
    const config = { ...(Object.keys(mcpOff).length ? { mcp_servers: mcpOff } : {}), ...(this.deps.extraConfig ?? {}) };
    const model = this.fixedModel || this.model || null;
    const common = {
      cwd: this.o.cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      baseInstructions: this.o.instructions,
      ...(Object.keys(config).length ? { config } : {}),
      ...(model ? { model } : {}),
    };
    if (this.o.resume) {
      try {
        const r = await this.server.request<{ thread: { id: string }; model: string }>('thread/resume', { threadId: this.o.resume, ...common, excludeTurns: true }, 60000);
        this.threadId = r.thread.id;
        this.activeModel = r.model;
      } catch (e) {
        if (!(e instanceof RpcError) || !/no rollout|not found|unknown thread|invalid thread/i.test(e.message)) throw e;
        // 대화 관리가 맥락을 붙여 새 스레드로 다시 보낸다
        this.resumeMissing = true;
        this.threadId = this.o.resume;
      }
      return;
    }
    const r = await this.server.request<{ thread: { id: string }; model: string }>(
      'thread/start',
      // 스레드의 도구는 처음에 정해진다 → 수정·명령 도구는 늘 주고 쓸 때 막기 규칙으로 판단 (원본 없는 대화만 뺌)
      { ...common, ephemeral: false, dynamicTools: codexTools({ readOnly: this.o.readOnly, shell: !this.o.readOnly }) },
      60000,
    );
    this.threadId = r.thread.id;
    this.activeModel = r.model;
  }

  override async setModel(model?: string): Promise<void> {
    await super.setModel(model);
    this.modelDirty = true;
  }

  protected async runTurn(text: string, signal: AbortSignal): Promise<void> {
    if (this.resumeMissing) {
      this.emitNoSession(this.threadId);
      return;
    }
    const server = this.server;
    if (!server?.alive) throw new EngineError('Codex 연결이 끊겼습니다. 다시 보내 주세요', 'other');
    const model = this.fixedModel || this.model;
    this.emitInit(this.threadId, model || this.activeModel);
    this.lastText = '';
    this.msgs.clear();
    const done = new Promise<TurnInfo>((resolve, reject) => (this.waiter = { resolve, reject }));
    done.catch(() => undefined);
    const params: Record<string, unknown> = { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }] };
    if (this.modelDirty && !this.fixedModel) params.model = model || null;
    this.modelDirty = false;
    this.turnId = '';
    const started = await server.request<{ turn: { id: string } }>('turn/start', params, 60000);
    this.turnId = started.turn.id;
    const interrupt = () => void server.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 15000).catch(() => undefined);
    if (signal.aborted) interrupt();
    signal.addEventListener('abort', interrupt, { once: true });
    try {
      const turn = await done;
      if (turn.status === 'completed') {
        this.emitSuccess(this.lastText);
        return;
      }
      if (turn.status === 'interrupted') throw new Aborted();
      const { code, detail } = codexError(turn.error);
      throw new EngineError(detail, code);
    } finally {
      signal.removeEventListener('abort', interrupt);
      this.waiter = null;
    }
  }

  private onNotification(method: string, p: Record<string, any>): void {
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'item/started': {
        const it = p.item ?? {};
        if (it.type === 'agentMessage') this.msgs.set(String(it.id), { begun: false, text: '' });
        else if (it.type === 'commandExecution') this.emitAssistant(this.newMessageId(), [{ type: 'tool_use', id: `toolu_${it.id}`, name: 'Bash', input: { command: String(it.command ?? '') } }]);
        else if (it.type === 'fileChange') {
          const file = String(it.changes?.[0]?.path ?? '');
          this.emitAssistant(this.newMessageId(), [{ type: 'tool_use', id: `toolu_${it.id}`, name: 'Edit', input: { file_path: file } }]);
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const id = String(p.itemId ?? '');
        const m = this.msgs.get(id) ?? { begun: false, text: '' };
        this.msgs.set(id, m);
        if (!m.begun) {
          this.beginMessage(id);
          m.begun = true;
        }
        m.text += String(p.delta ?? '');
        this.textDelta(id, 0, String(p.delta ?? ''));
        break;
      }
      case 'item/completed': {
        const it = p.item ?? {};
        if (it.type === 'agentMessage') {
          const id = String(it.id);
          const m = this.msgs.get(id);
          const text = typeof it.text === 'string' ? it.text : (m?.text ?? '');
          if (m?.begun) this.endMessage(id);
          if (text.trim()) {
            this.emitAssistant(id, [{ type: 'text', text }]);
            this.lastText = text;
          }
          this.msgs.delete(id);
        } else if (it.type === 'commandExecution') {
          const ok = it.status === 'completed' && (it.exitCode === 0 || it.exitCode === null || it.exitCode === undefined);
          this.emitToolResult(`toolu_${it.id}`, { text: String(it.aggregatedOutput ?? (it.status === 'declined' ? '사용자가 명령 실행을 거부했습니다' : '')), isError: !ok });
        } else if (it.type === 'fileChange') {
          this.emitToolResult(`toolu_${it.id}`, { text: it.status === 'completed' ? '고쳤습니다' : '고치지 않았습니다', isError: it.status !== 'completed' });
        }
        break;
      }
      case 'error': {
        // 다시 시도하는 중 ('Reconnecting... 2/5')
        if (p.willRetry) {
          const m = /(\d+)\s*\/\s*(\d+)/.exec(String(p.error?.message ?? ''));
          if (m) this.emitRetry(Number(m[1]) + 1, Number(m[2]) + 1);
        }
        break;
      }
      case 'turn/completed': {
        const turn = p.turn as TurnInfo | undefined;
        if (turn && (!this.turnId || turn.id === this.turnId)) this.waiter?.resolve(turn);
        break;
      }
      default:
        break;
    }
  }

  private async onRequest(method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case 'item/tool/call':
        return this.dynamicTool(p);
      case 'item/commandExecution/requestApproval': {
        // Codex 셸은 꺼 두지만, 혹시 오면 앱 규칙(허용 목록 + 매번 확인)으로
        const perm = await this.o.canUseTool('Bash', { command: String(p.command ?? '') }, { signal: this.turnSignal });
        return { decision: perm.behavior === 'allow' ? 'accept' : 'decline' };
      }
      case 'item/fileChange/requestApproval':
        return { decision: 'decline' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return { decision: { denied: { rejection: '이 앱에서는 Codex 자체 도구를 쓰지 않습니다' } } };
      case 'currentTime/read':
        return { currentTimeAt: Date.now() };
      default:
        throw new Error(`이 앱에서 지원하지 않는 요청입니다: ${method}`);
    }
  }

  /** 앱 도구 실행 → 동적 도구 결과 */
  private async dynamicTool(p: Record<string, any>): Promise<unknown> {
    const name = String(p.tool ?? '');
    const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
    const toolUseId = `toolu_${String(p.callId ?? this.newMessageId())}`;
    const c = toClaudeTool(name, args);
    this.emitAssistant(this.newMessageId(), [{ type: 'tool_use', id: toolUseId, name: c?.name ?? name, input: c?.input ?? args }]);
    const signal = this.turnSignal ?? new AbortController().signal;
    let out: ToolOutcome;
    if (!c) {
      out = { text: `이 앱에 없는 도구입니다: ${name}`, isError: true };
      this.emitToolResult(toolUseId, out);
    } else {
      try {
        out = await this.runTool(toolUseId, c.name, c.input, signal);
      } catch {
        out = { text: '사용자가 중지했습니다', isError: true };
      }
    }
    return { contentItems: [{ type: 'inputText', text: out.text }], success: !out.isError };
  }

  protected override async execTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    if (FS_TOOLS.has(name)) return runFsTool(name, input, { cwd: this.o.cwd, signal, commandTimeoutMs: this.deps.commandTimeoutMs });
    return super.execTool(name, input, signal);
  }

  protected override async dispose(): Promise<void> {
    this.waiter?.reject(new Aborted());
    this.server?.close();
    this.server = null;
  }
}
