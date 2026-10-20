// Gemini·ChatGPT 엔진의 공통 뼈대: 스트리밍 입력의 사용자 메시지마다 한 턴을 돌리고,
// Claude Agent SDK와 같은 모양의 메시지(engine.ts 설명)를 대화 관리에 흘려보낸다.
// 앱 도구(DB·계획 승인·파일 도구)는 대화 관리의 권한 확인(canUseTool)을 거쳐 실행한다.
import { randomBytes } from 'node:crypto';
import type { ClaudeErrorCode } from '../../shared/desktop-api';
import type { SDKUserMessage } from '../claude/sdk';
import type { ToolText } from '../claude/tools';
import { EngineError, type EngineOpenOptions, type RunningQuery } from './engine';

export type Msg = Record<string, unknown>;

/** 도구 실행 결과 */
export interface ToolOutcome {
  /** 모델에 돌려줄 글 */
  text: string;
  isError: boolean;
  /** 작업 내역 요약용 (Claude 도구 결과 모양: Grep numMatches · Glob numFiles · Edit structuredPatch · Write type) */
  structured?: unknown;
}

export class Chan<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(v: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }
  end(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as T, done: true });
  }
  get ended(): boolean {
    return this.done;
  }
  next(): Promise<IteratorResult<T>> {
    if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
}

export function userText(u: SDKUserMessage): string {
  const c = u?.message?.content as unknown;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  return '';
}

export function newToolId(prefix = 'toolu_'): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

/** 중지(AbortSignal)로 끝남 */
export class Aborted extends Error {
  constructor() {
    super('중지됨');
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Aborted();
}

const NET_CODES = /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_CERT_\w+|UND_ERR_\w+)\b|fetch failed|network error/i;

export function toolText(t: ToolText): ToolOutcome {
  return { text: t.content.map((c) => c.text).join('\n'), isError: !!t.isError };
}

export abstract class AgentQueryBase implements RunningQuery {
  protected out = new Chan<Msg>();
  protected closed = false;
  /** 수정 허용 (acceptEdits) */
  protected editMode: boolean;
  /** 이 대화의 모델 ('' = 연결의 기본 모델) */
  protected model: string;
  private turn: AbortController | null = null;
  private seq = 0;
  private disposed = false;

  constructor(protected o: EngineOpenOptions) {
    this.editMode = o.mode === 'edit';
    this.model = o.model ?? '';
  }

  /** 지금 턴의 중지 신호 (턴 밖이면 없음) */
  protected get turnSignal(): AbortSignal | undefined {
    return this.turn?.signal;
  }

  /** 엔진이 준비를 마친 뒤 부른다 */
  protected start(): void {
    void this.loop();
  }

  /** 한 턴: 사용자 글 → (도구를 쓰며) 답변 → result 메시지. 실패는 throw (중지면 Aborted) */
  protected abstract runTurn(text: string, signal: AbortSignal): Promise<void>;

  /** 연결 정리 (프로세스 끄기 등). 한 번만 불린다 */
  protected async dispose(): Promise<void> {}

  /** 모델 바꾸기·모드 바꾸기를 엔진에 알림 (Codex는 다음 턴 설정에 씀) */
  protected onModeChange(): void {}

  private async loop(): Promise<void> {
    try {
      for await (const u of this.o.input) {
        if (this.closed) break;
        const ac = new AbortController();
        this.turn = ac;
        try {
          await this.runTurn(userText(u), ac.signal);
        } catch (e) {
          if (this.closed) break;
          if (ac.signal.aborted || e instanceof Aborted) this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['사용자가 중지했습니다'] });
          else {
            const { code, detail } = this.describeError(e);
            this.emitFailure(code, detail);
          }
        } finally {
          if (this.turn === ac) this.turn = null;
        }
      }
    } catch (e) {
      if (!this.closed) {
        const { code, detail } = this.describeError(e);
        this.emitFailure(code, detail);
      }
    } finally {
      this.out.end();
      await this.runDispose();
    }
  }

  private async runDispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.dispose();
    } catch {
      // 이미 끝남
    }
  }

  protected describeError(e: unknown): { code: ClaudeErrorCode; detail: string } {
    if (e instanceof EngineError) return { code: e.code, detail: e.message };
    const err = e as NodeJS.ErrnoException & { cause?: { code?: string; message?: string } };
    const text = `${err?.message ?? String(e)}${err?.cause ? ` (${err.cause.code ?? ''} ${err.cause.message ?? ''})` : ''}`.trim();
    if (NET_CODES.test(text) || NET_CODES.test(err?.code ?? '')) return { code: 'offline', detail: text };
    return { code: 'other', detail: text };
  }

  // ---------------------------------------------------------------- RunningQuery

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => this.out.next(),
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }

  async interrupt(): Promise<void> {
    this.turn?.abort();
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.editMode = mode === 'acceptEdits' || mode === 'bypassPermissions';
    this.onModeChange();
  }

  async setModel(model?: string): Promise<void> {
    this.model = model ?? '';
    this.onModeChange();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turn?.abort();
    this.out.end();
    void this.runDispose();
  }

  // ---------------------------------------------------------------- 메시지 보내기

  protected emit(m: Msg): void {
    if (!this.closed) this.out.push(m);
  }

  protected emitInit(sessionId: string, model: string): void {
    this.emit({ type: 'system', subtype: 'init', session_id: sessionId, model, apiKeySource: 'none' });
  }

  protected newMessageId(): string {
    return `msg_${Date.now().toString(36)}_${++this.seq}`;
  }

  /** 답변 글 스트리밍: begin → delta… → end, 끝나면 emitAssistant로 전체 글(과 도구 호출)을 보낸다 */
  protected beginMessage(id: string): void {
    this.emit({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null });
  }

  private started = new Set<string>();

  protected textDelta(id: string, index: number, text: string): void {
    if (!text) return;
    const k = `${id}:${index}`;
    if (!this.started.has(k)) {
      this.started.add(k);
      this.emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
    }
    this.emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
  }

  protected endMessage(id: string): void {
    for (const k of [...this.started]) if (k.startsWith(`${id}:`)) this.started.delete(k);
    this.emit({ type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null });
  }

  protected emitAssistant(id: string, content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[]): void {
    if (!content.length) return;
    this.emit({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null });
  }

  protected emitToolResult(toolUseId: string, r: ToolOutcome): void {
    this.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: r.text, ...(r.isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: null,
      ...(r.structured !== undefined ? { tool_use_result: r.structured } : {}),
    });
  }

  protected emitRetry(attempt: number, max: number): void {
    this.emit({ type: 'system', subtype: 'api_retry', attempt, max_retries: max });
  }

  protected emitSuccess(text: string): void {
    this.emit({ type: 'result', subtype: 'success', is_error: false, result: text });
  }

  protected emitFailure(code: ClaudeErrorCode, detail: string): void {
    this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [detail], pa_code: code });
  }

  /** 이어서 할 대화 기록이 없음 → 대화 관리가 맥락을 붙여 새로 보낸다 */
  protected emitNoSession(sessionId: string): void {
    this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${sessionId}`] });
  }

  // ---------------------------------------------------------------- 앱 도구

  /**
   * 앱 도구 하나: 권한 확인(대화 관리) → 실행 → tool_result 메시지. name·input은 Claude 도구 모양.
   * 중지되면 Aborted를 던진다
   */
  protected async runTool(toolUseId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    let r: ToolOutcome;
    try {
      const perm = await this.o.canUseTool(name, input, { signal });
      throwIfAborted(signal);
      r = perm.behavior === 'deny' ? { text: perm.message, isError: true } : await this.execTool(name, perm.updatedInput ?? input, signal);
    } catch (e) {
      if (signal.aborted || e instanceof Aborted) throw new Aborted();
      r = { text: `도구를 실행하지 못했습니다: ${(e as Error)?.message ?? String(e)}`, isError: true };
    }
    throwIfAborted(signal);
    this.emitToolResult(toolUseId, r);
    return r;
  }

  /** 권한 확인을 마친 도구 실행 (DB·계획 승인은 여기서, 파일·명령 도구는 엔진이 더한다) */
  protected async execTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    void signal;
    switch (name) {
      case 'ExitPlanMode':
        return { text: '사용자가 계획을 승인했습니다. 이제 수정 허용 모드라 작업 사본 안의 파일을 고칠 수 있습니다. 승인한 계획대로 진행하세요.', isError: false };
      case 'mcp__projdb__db_list':
        return toolText(await this.o.db.db_list({}));
      case 'mcp__projdb__db_select':
        return toolText(await this.o.db.db_select(input as { sql: string; env?: 'dev' | 'qa' | 'prod'; max_rows?: number }));
      case 'mcp__projdb__db_propose_change':
        return toolText(await this.o.db.db_propose_change(input as { sql: string; env?: 'dev' | 'qa' | 'prod'; description: string; revert_sql?: string }));
      default:
        return { text: `이 앱에 없는 도구입니다: ${name}`, isError: true };
    }
  }
}
