// AI 대화 관리: 대화마다 AI 연결 하나를 스트리밍 입력으로 열어 두고(15분 쉬면 닫음, 다시 보낼 때 이어서),
// 메시지를 화면 항목(ChatItem)으로 바꿔 claude.item·claude.state 이벤트로 보낸다.
//   Claude: PC의 Claude Code를 Agent SDK query()로 / Gemini·ChatGPT: ai/engine.ts의 엔진 (같은 모양의 메시지를 흘림)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AiProvider, ChatItem, ChatMode, ClaudeStartOptions, Conversation, ConversationSummary, Env, PendingRequest, QueryCard } from '../../shared/desktop-api';
import { AI_LABEL, ENV_LABEL } from '../../shared/desktop-api';
import { type AiEngine, EngineError, type EngineMap, type EngineProvider, type RunningQuery, type StatusReport } from '../ai/engine';
import { getAiSettings, isProvider } from '../ai/settings';
import { isEmptyDir } from '../fsutil';
import { host } from '../host';
import { DesktopError, emit } from '../ipc';
import { checkRoot } from '../project';
import { services, type DbSelectAsk } from '../services';
import { dataDir, newId, nowIso } from '../store';
import { type ActEntry, applyResult, describeTool, summarize } from './activity';
import { cleanModel, getStored, type StoredConfig } from './config';
import { carryTranscript, deleteConvFile, exportFileName, listConvs, loadConv, providerOf, publicConv, saveConv, type StoredConversation, toMarkdown, validId } from './conversations';
import { buildCliEnv, claudeConfigDir } from './env';
import { type Classified, classifyError } from './errors';
import { type GuardContext, isPlanFile, MSG_READONLY, permissionDefault, preToolUse, secretDenyRules, SHELL_TOOLS } from './guards';
import { buildFirstMessage, buildSystemAppend, MAX_CARRY, shortTitle } from './prompt';
import type { ModelCatalog } from './models';
import { createSdkMcpServer, InputQueue, type Options, type QueryFn, tool, userMessage } from './sdk';
import { type StatusManager, textOf } from './status';
import { createDbServer, DB_TOOL_NAMES, makeDbHandlers } from './tools';

export const NEW_TITLE = '새 대화';
const IDLE_MS = 15 * 60 * 1000;
const EMIT_MS = 50;
const SAVE_MS = 1000;

export interface ManagerOptions {
  queryFn: QueryFn;
  status: StatusManager;
  idleMs?: number;
  /** [중지] 뒤 결과를 기다리는 시간 */
  interruptGraceMs?: number;
  createServer?: typeof createSdkMcpServer;
  toolFn?: typeof tool;
  /** 모델 이름 (모델을 바꿨다는 안내에 씀) */
  models?: ModelCatalog;
  /** Claude 말고 다른 AI (Gemini·ChatGPT) */
  engines?: EngineMap;
}

class RunError extends Error {
  constructor(public classified: Classified) {
    super(classified.message);
  }
}

interface PendingEntry {
  req: PendingRequest;
  resolve(allow: boolean): void;
}

interface AssistantState {
  itemId: string;
  texts: { idx?: number; text: string; final: boolean }[];
  streaming: boolean;
  added: boolean;
  at: string;
}

interface TurnState {
  startedAt: number;
  /** 화면에 보인 질문 / CLI에 보낸 내용 (맥락 포함) */
  userText: string;
  content: string;
  activityId?: string;
  activityAt?: string;
  activityAdded?: boolean;
  entries: ActEntry[];
  byTool: Map<string, ActEntry | null>;
  assistants: Map<string, AssistantState>;
  curMsgId?: string;
  edited: Set<string>;
  hadError: boolean;
  gotInit: boolean;
  gotResult: boolean;
  retryNoticed: boolean;
  compactNoticed: boolean;
  fallbackTried: boolean;
}

class Session {
  q: RunningQuery | null = null;
  input: InputQueue | null = null;
  /** 일부러 닫은 query (끝나도 오류로 보지 않음) */
  closing = new Set<RunningQuery>();
  running = false;
  pendings: PendingEntry[] = [];
  turn: TurnState | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  emitTimer: NodeJS.Timeout | null = null;
  saveTimer: NodeJS.Timeout | null = null;
  dirty = new Set<string>();
  stderr = '';
  interrupted = false;
  waiters: (() => void)[] = [];
  resumeAttempt = false;
  apiKeySource?: string;
  guard: GuardContext | null = null;
  cfg: StoredConfig | null = null;
  /** 다음 메시지 때 CLI를 새로 연다 (열린 CLI가 모델 바꾸기를 못 함 · 응답 중에 설정·로그인이 바뀜) */
  reopen = false;
  constructor(public conv: StoredConversation) {}
  get provider(): AiProvider {
    return providerOf(this.conv);
  }
  /** 보이는 AI 이름 (Claude · Gemini · ChatGPT) */
  get ai(): string {
    return AI_LABEL[this.provider];
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('시간 초과')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class ClaudeManager {
  private sessions = new Map<string, Session>();
  private cardUnsub: (() => void) | null = null;
  private queryFn: QueryFn;
  private status: StatusManager;
  private idleMs: number;
  private graceMs: number;
  private createServer: typeof createSdkMcpServer;
  private toolFn: typeof tool;
  private models: ModelCatalog | undefined;
  private engines: EngineMap;

  constructor(o: ManagerOptions) {
    this.queryFn = o.queryFn;
    this.status = o.status;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.graceMs = o.interruptGraceMs ?? 10000;
    this.createServer = o.createServer ?? createSdkMcpServer;
    this.toolFn = o.toolFn ?? tool;
    this.models = o.models;
    this.engines = o.engines ?? {};
  }

  // ---------------------------------------------------------------- AI별

  private engine(p: AiProvider): AiEngine | undefined {
    return p === 'claude' ? undefined : this.engines[p];
  }

  private async enabledFor(p: AiProvider): Promise<boolean> {
    if (p === 'claude') return (await getStored()).enabled;
    return (await this.engine(p)?.enabled()) ?? false;
  }

  private offError(p: AiProvider, starting: boolean): DesktopError {
    const where = p === 'claude' ? 'Claude 연결' : `설정 > AI 연결 > ${AI_LABEL[p]}`;
    return new DesktopError(`${AI_LABEL[p]} 연동이 꺼져 있습니다. ${where}에서 ${starting ? '켠 뒤 시작해' : '켜'} 주세요.`, 'off');
  }

  /** 연결 설정의 기본 모델 ('' = 그 AI의 기본값) */
  private async defaultModel(p: AiProvider): Promise<string> {
    if (p === 'claude') return (await getStored()).model ?? '';
    return (await this.engine(p)?.defaultModel()) ?? '';
  }

  private modelLabel(p: AiProvider, model: string): string {
    if (p === 'claude') return this.models?.label(model) ?? (model || 'Claude Code 기본값');
    return this.engine(p)?.models.label(model) ?? (model || `${AI_LABEL[p]} 기본 모델`);
  }

  /** 대화에서 알게 된 연결 상태를 그 AI의 상태에 알린다 */
  private report(s: Session, r: StatusReport): void {
    const p = s.provider;
    if (p === 'claude') void this.status.report(r).catch(() => undefined);
    else void this.engine(p)?.status.report(r).catch(() => undefined);
  }

  // ---------------------------------------------------------------- 채널

  async start(root: string | null, opts: ClaudeStartOptions = {}): Promise<Conversation> {
    const provider: AiProvider = isProvider(opts.provider) ? opts.provider : (await getAiSettings()).defaultProvider;
    if (provider !== 'claude' && !this.engine(provider)) throw new DesktopError(`${AI_LABEL[provider]} 연결을 이 앱에서 쓸 수 없습니다`, 'unavailable');
    if (!(await this.enabledFor(provider))) throw this.offError(provider, true);
    // 고른 모델 ('' = 그 AI의 기본값). 고르지 않았으면 그 AI 연결의 기본 모델을 따른다
    const model = typeof opts.model === 'string' ? (cleanModel(opts.model) ?? '') : undefined;
    // 다른 AI로 새 대화: 이전 대화의 맥락(화면·테이블 등)과 질문·답변 글(carry 켬)을 붙인다
    let context = opts.context;
    let references = opts.references;
    let from: StoredConversation | null = null;
    if (typeof opts.carryFrom === 'string' && opts.carryFrom) {
      from = validId(opts.carryFrom) ? ((this.sessions.get(opts.carryFrom) ?? (await this.load(opts.carryFrom)))?.conv ?? null) : null;
      if (!from) throw new DesktopError('이전 대화를 찾을 수 없습니다', 'not-found');
      const text = carryTranscript(publicConv(from), MAX_CARRY);
      const base = context ?? from.context;
      const chips = (base?.chips ?? []).filter((c) => c.kind !== 'conversation');
      if (text) chips.push({ kind: 'conversation', label: `이전 대화 (${AI_LABEL[providerOf(from)]})`, text });
      context = chips.length ? { title: base?.title || from.title, chips } : undefined;
      references ??= from.references;
    }
    const id = newId('c');
    const now = nowIso();
    let cwd: string;
    let kind: Conversation['kind'] = 'issue';
    let workId: string | undefined;
    let readOnly = false;
    let convRoot: string | null = null;
    if (from?.kind === 'new') {
      // 새 프로젝트 대화를 다른 AI로: 같은 폴더에서 이어서 (이미 만든 파일이 있으므로 빈 폴더 검사는 하지 않음)
      if (!from.root || !fs.existsSync(from.cwd)) throw new DesktopError('새 프로젝트 폴더를 찾을 수 없습니다', 'not-found');
      convRoot = from.root;
      cwd = from.cwd;
      kind = 'new';
    } else if (opts.newProject) {
      if (typeof root !== 'string' || !root) throw new DesktopError('새 프로젝트를 만들 폴더를 골라 주세요', 'invalid');
      convRoot = checkRoot(root);
      if (!(await isEmptyDir(convRoot))) throw new DesktopError('선택한 폴더가 비어 있지 않습니다. 새 프로젝트는 빈 폴더에서 시작해 주세요.', 'not-empty');
      cwd = convRoot;
      kind = 'new';
    } else if (root) {
      convRoot = checkRoot(root);
      const work = services.work;
      if (!work) throw new DesktopError('작업 사본 기능이 아직 준비되지 않아 대화를 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'unavailable');
      const copy = await work.create(convRoot, { conversationId: id });
      cwd = copy.path;
      workId = copy.id;
    } else {
      // ZIP·결과 파일로 연 프로젝트: 빈 폴더에서 분석 결과만으로 대화 (수정 불가)
      cwd = path.join(dataDir(), 'claude-empty', id);
      await fsp.mkdir(cwd, { recursive: true });
      readOnly = true;
    }
    const conv: StoredConversation = {
      id,
      provider,
      root: convRoot,
      kind,
      title: NEW_TITLE,
      createdAt: now,
      updatedAt: now,
      mode: 'plan',
      items: [],
      running: false,
      cwd,
      ...(model !== undefined ? { model } : {}),
      ...(workId ? { workId } : {}),
      ...(readOnly ? { readOnly } : {}),
      ...(context ? { context } : {}),
      ...(references?.length ? { references: references.map((r) => ({ name: String(r.name ?? ''), text: String(r.text ?? '') })) } : {}),
    };
    await saveConv(conv);
    this.sessions.set(id, new Session(conv));
    return publicConv(conv);
  }

  async list(root: string | null): Promise<ConversationSummary[]> {
    const r = root ? path.resolve(root) : null;
    const list = await listConvs(r);
    // 열려 있는 대화는 메모리 값으로
    return list.map((x) => {
      const s = this.sessions.get(x.id);
      return s ? { ...x, title: s.conv.title, updatedAt: s.conv.updatedAt, mode: s.conv.mode, items: s.conv.items.length } : x;
    });
  }

  async get(id: string): Promise<Conversation | null> {
    if (!validId(id)) return null;
    const s = this.sessions.get(id) ?? (await this.load(id));
    if (!s) return null;
    return publicConv(s.conv, { running: s.running, pending: s.pendings[0]?.req });
  }

  async send(id: string, text: string, opts: { wait?: boolean } = {}): Promise<void> {
    const s = await this.session(id);
    if (!(await this.enabledFor(s.provider))) throw this.offError(s.provider, false);
    const body = String(text ?? '').trim();
    if (!body) throw new DesktopError('보낼 내용이 없습니다', 'invalid');
    if (body.length > 200000) throw new DesktopError('보낼 내용이 너무 깁니다', 'invalid');
    // 기다리던 여럿이 한꺼번에 깨어날 수 있으므로 다시 확인
    while (s.running) {
      if (!opts.wait) throw new DesktopError(`${s.ai}가 응답하는 중입니다. 끝난 뒤 보내거나 [중지]를 눌러 주세요.`, 'busy');
      await new Promise<void>((r) => s.waiters.push(r));
    }
    this.clearIdle(s);
    if (s.reopen) {
      s.reopen = false;
      this.closeQuery(s);
    }
    const content = s.conv.contextSent ? body : buildFirstMessage(body, s.conv.context, s.conv.references);
    if (s.conv.title === NEW_TITLE || !s.conv.items.some((i) => i.type === 'user')) s.conv.title = shortTitle(body);
    this.addItem(s, { id: newId('u'), type: 'user', text: body, at: nowIso() });
    s.running = true;
    s.interrupted = false;
    const turn = this.newTurn(body, content);
    s.turn = turn;
    this.emitState(s);
    try {
      if (!s.q) await this.open(s);
      // 여는 동안 [중지]·삭제됨 → 보내지 않는다
      if (s.turn !== turn || !s.input) return;
      s.input.push(userMessage(content));
      s.conv.contextSent = true;
    } catch (e) {
      const c = this.classifyThrown(s, e);
      this.addError(s, c);
      this.report(s, { ok: false, code: c.code, detail: c.detail });
      this.endTurn(s);
    }
    this.scheduleSave(s);
  }

  private classifyThrown(s: Session, e: unknown): Classified {
    if (e instanceof RunError) return e.classified;
    if (e instanceof EngineError) return classifyError({ text: e.message, code: e.code, provider: s.provider });
    return classifyError({ text: (e as Error)?.message ?? String(e), errno: (e as NodeJS.ErrnoException)?.code, provider: s.provider });
  }

  async setMode(id: string, mode: ChatMode, via: 'user' | 'plan' = 'user'): Promise<void> {
    if (mode !== 'plan' && mode !== 'edit') throw new DesktopError('모드가 올바르지 않습니다', 'invalid');
    const s = await this.session(id);
    if (mode === 'edit' && s.conv.readOnly) throw new DesktopError('원본 폴더 없이 연 프로젝트(ZIP·결과 파일)는 수정할 수 없습니다', 'readonly');
    // 계획 승인을 기다리는 중이면 [수정 진행]과 같다
    const plan = s.pendings.find((p) => p.req.kind === 'plan');
    if (mode === 'edit' && plan) {
      plan.resolve(true);
      return;
    }
    if (s.conv.mode === mode) return;
    this.switchMode(s, mode, via, true);
  }

  /** 대화의 모델 바꾸기 ('' = 그 AI의 기본값). 열린 연결에는 바로 알리고(응답 중이면 다음 응답부터), 닫혀 있으면 다음에 열 때 */
  async setModel(id: string, raw: string): Promise<void> {
    const model = typeof raw === 'string' ? (cleanModel(raw) ?? '') : '';
    const s = await this.session(id);
    const before = s.conv.model !== undefined ? s.conv.model : await this.defaultModel(s.provider);
    s.conv.model = model;
    if (before !== model) {
      if (s.q) {
        try {
          await withTimeout(s.q.setModel(model || undefined), 5000);
        } catch {
          // 이 CLI가 모델 바꾸기를 못 하면 다음 메시지 때 새 모델로 다시 연다 (대화는 이어 감)
          s.reopen = true;
        }
      }
      this.addNotice(s, `모델을 ${this.modelLabel(s.provider, model)}(으)로 바꿨습니다${s.running ? ' · 다음 응답부터 적용됩니다' : ''}`);
    }
    this.emitState(s);
    this.scheduleSave(s);
  }

  async interrupt(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || !s.running) return;
    s.interrupted = true;
    for (const p of [...s.pendings]) p.resolve(false);
    const q = s.q;
    const force = () => {
      if (!s.running) return;
      this.closeQuery(s);
      this.addNotice(s, '응답을 중지했습니다');
      this.endTurn(s);
    };
    if (!q) {
      force();
      return;
    }
    try {
      await withTimeout(q.interrupt(), 5000);
    } catch {
      force();
      return;
    }
    // 결과가 오지 않으면 프로세스를 닫는다
    const t = setTimeout(() => {
      if (s.running && s.interrupted) force();
    }, this.graceMs);
    t.unref?.();
  }

  async respond(id: string, requestId: string, allow: boolean): Promise<void> {
    const s = this.sessions.get(id);
    const p = s?.pendings.find((x) => x.req.requestId === requestId);
    if (!s || !p) throw new DesktopError('이미 끝난 요청입니다', 'gone');
    p.resolve(!!allow);
  }

  async delete(id: string): Promise<void> {
    if (!validId(id)) return;
    const s = this.sessions.get(id);
    // 앱이 보관한 AI 대화 기록 (Gemini) — Claude Code·Codex는 자기 기록을 PC에 남긴다
    const conv = s?.conv ?? (await loadConv(id).catch(() => null));
    const engine = conv ? this.engine(providerOf(conv)) : undefined;
    if (engine?.forget && conv?.sessionId) await engine.forget(conv.sessionId).catch(() => undefined);
    if (s) {
      for (const p of [...s.pendings]) p.resolve(false);
      this.closeQuery(s);
      this.clearIdle(s);
      if (s.saveTimer) clearTimeout(s.saveTimer);
      if (s.emitTimer) clearTimeout(s.emitTimer);
      s.running = false;
      for (const w of s.waiters.splice(0)) w();
      this.sessions.delete(id);
    }
    await deleteConvFile(id);
  }

  /** 프로젝트의 대화를 모두 지움 (열려 있는 대화는 멈추고 닫음) */
  async clear(root: string): Promise<number> {
    const r = checkRoot(root);
    const ids = new Set((await listConvs(r)).map((c) => c.id));
    for (const s of this.sessions.values()) if (s.conv.root && path.resolve(s.conv.root) === r) ids.add(s.conv.id);
    for (const id of ids) await this.delete(id);
    return ids.size;
  }

  async exportMarkdown(id: string): Promise<string | false> {
    const s = await this.session(id);
    const md = toMarkdown(publicConv(s.conv), s.conv.root ?? undefined);
    return host().saveFile(exportFileName(s.conv), md, [{ name: 'Markdown', extensions: ['md'] }]);
  }

  /**
   * 설정·로그인이 바뀜: 쉬고 있는 연결(Claude 프로세스 등)은 바로 닫고, 응답 중인 것은 다음 메시지 때 새로 연다
   * (다음 메시지에 새 환경·새 로그인으로 다시 열고 대화는 이어 간다). provider를 주면 그 AI의 대화만
   */
  closeIdle(provider?: AiProvider): void {
    for (const s of this.sessions.values()) {
      if (provider && s.provider !== provider) continue;
      if (!s.running && !s.pendings.length) this.closeQuery(s);
      else if (s.q) s.reopen = true;
    }
  }

  /** 연동을 끔 / 앱 종료. provider를 주면 그 AI의 대화만 */
  async closeAll(provider?: AiProvider): Promise<void> {
    const saves: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (provider && s.provider !== provider) continue;
      for (const p of [...s.pendings]) p.resolve(false);
      this.closeQuery(s);
      this.clearIdle(s);
      if (s.running) {
        s.running = false;
        s.turn = null;
        this.emitState(s);
      }
      saves.push(this.saveNow(s));
    }
    await Promise.all(saves);
  }

  ensureCardSubscription(): void {
    if (this.cardUnsub || !services.db) return;
    this.cardUnsub = services.db.onCard((card) => void this.onCard(card));
  }

  // ---------------------------------------------------------------- 내부: 대화 불러오기

  private async load(id: string): Promise<Session | null> {
    const conv = await loadConv(id);
    if (!conv) return null;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const s = new Session(conv);
    this.sessions.set(id, s);
    return s;
  }

  private async session(id: string): Promise<Session> {
    if (!validId(id)) throw new DesktopError('대화를 찾을 수 없습니다', 'not-found');
    const s = this.sessions.get(id) ?? (await this.load(id));
    if (!s) throw new DesktopError('대화를 찾을 수 없습니다', 'not-found');
    return s;
  }

  private newTurn(userText: string, content: string): TurnState {
    return {
      startedAt: Date.now(),
      userText,
      content,
      entries: [],
      byTool: new Map(),
      assistants: new Map(),
      edited: new Set(),
      hadError: false,
      gotInit: false,
      gotResult: false,
      retryNoticed: false,
      compactNoticed: false,
      fallbackTried: false,
    };
  }

  // ---------------------------------------------------------------- 내부: SDK query 열기

  /** 작업 폴더가 없어졌으면 (작업 사본을 버림 등) 다시 만든다 */
  private async ensureCwd(s: Session): Promise<void> {
    const c = s.conv;
    if (fs.existsSync(c.cwd)) return;
    if (c.readOnly) {
      await fsp.mkdir(c.cwd, { recursive: true });
      return;
    }
    if (c.kind === 'new') throw new RunError({ code: 'other', message: `오류: 새 프로젝트 폴더를 찾을 수 없습니다: ${c.cwd}`, detail: c.cwd });
    const work = services.work;
    if (!c.root || !work) throw new RunError({ code: 'other', message: '오류: 작업 사본을 찾을 수 없습니다', detail: c.cwd });
    const existing = c.workId ? await work.get(c.workId).catch(() => null) : null;
    if (existing && fs.existsSync(existing.path)) {
      c.cwd = existing.path;
      return;
    }
    const copy = await work.create(c.root, { conversationId: c.id });
    c.cwd = copy.path;
    c.workId = copy.id;
    // 작업 폴더가 바뀌면 이전 AI 세션은 이어 갈 수 없다
    c.sessionId = undefined;
    this.addNotice(s, '작업 사본이 없어 원본의 지금 상태로 새로 만들었습니다');
    this.emitState(s);
  }

  private dbHandlers(s: Session): ReturnType<typeof makeDbHandlers> {
    return makeDbHandlers({
      root: s.conv.root,
      conversationId: s.conv.id,
      ask: (q) => this.askSelect(s, q),
      onSelect: (x) => this.addItem(s, { id: newId('sel'), type: 'select', env: x.env, db: x.db, sql: x.sql, rows: x.rows, maskedColumns: x.maskedColumns, ms: x.ms, at: nowIso() }),
      onProposal: (card) => {
        this.ensureCardSubscription();
        this.addItem(s, { id: `q-${card.id}`, type: 'query', card, at: nowIso() });
      },
      onNotice: (n) => this.addNotice(s, n.text, n.msg, n.vars),
    });
  }

  private async open(s: Session): Promise<void> {
    const p = s.provider;
    if (p !== 'claude') return this.openEngine(s, p);
    const cfg = await getStored();
    s.cfg = cfg;
    const ai = await getAiSettings();
    const cli = await this.status.cliTarget();
    if (!cli.ok) {
      const c = classifyError({ text: cli.message });
      throw new RunError({ ...c, code: 'missing', message: `Claude CLI 실행 실패: ${cli.message}` });
    }
    await this.ensureCwd(s);
    const env = await buildCliEnv(cfg, { appVersion: host().appVersion });
    const guard: GuardContext = {
      cwd: s.conv.cwd,
      mode: () => s.conv.mode,
      readOnly: !!s.conv.readOnly,
      shellAllow: ai.shellAllow,
      claudeDir: claudeConfigDir(env),
    };
    s.guard = guard;
    const handlers = this.dbHandlers(s);
    const server = createDbServer(this.createServer, this.toolFn, handlers);
    // 쓰지 않는 도구: 웹, 질문 창·모드 전환(앱이 정함), 워크트리, 예약·원격 실행, claude.ai 연동(디자인·아티팩트·파일 보내기)
    // (실제 CLI 2.1.302의 system/init tools 목록에서 확인. 없는 이름은 CLI가 무시)
    const disallowed = [
      'WebFetch', 'WebSearch', 'AskUserQuestion', 'EnterPlanMode', 'EnterWorktree', 'ExitWorktree',
      'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup', 'PushNotification', 'Workflow', 'SendMessage',
      'DesignSync', 'ClaudeDesign', 'Artifact', 'SendUserFile', 'Projects', 'OfferChromeSetup',
    ];
    if (!ai.shellAllow.length || s.conv.readOnly) disallowed.push('Bash', 'PowerShell', 'Monitor');
    const summary = s.conv.context?.chips?.find((c) => c.kind === 'summary')?.text;
    const input = new InputQueue();
    const options: Options = {
      pathToClaudeCodeExecutable: cli.target.exec,
      ...(cli.target.node ? { executable: cli.target.node as 'node' } : {}),
      cwd: s.conv.cwd,
      env,
      permissionMode: s.conv.mode === 'edit' ? 'acceptEdits' : 'plan',
      // 사용자 설정만 읽는다: 프로젝트·로컬 설정, 프로젝트 MCP(.mcp.json), 프로젝트 훅, CLAUDE.md는 읽지 않음
      settingSources: ['user'],
      strictMcpConfig: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemAppend({ kind: s.conv.kind, readOnly: !!s.conv.readOnly, shellAllow: ai.shellAllow, summary, projectName: s.conv.root ? path.basename(s.conv.root) : undefined }),
      },
      includePartialMessages: true,
      disallowedTools: disallowed,
      // 네이티브 CLI는 Grep·Glob을 이름을 적어야 준다 (sdk.d.ts tools 옵션 설명). projdb 도구는 계획 모드에서도 바로 허용.
      // 허용 규칙은 canUseTool을 건너뛰므로(SDK 경고 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) 검사는 PreToolUse 훅이 한다
      allowedTools: ['Grep', 'Glob', ...DB_TOOL_NAMES],
      mcpServers: { projdb: server },
      canUseTool: (name, input2, o) => this.canUseTool(s, guard, name, input2, o.signal),
      hooks: { PreToolUse: [{ hooks: [async (inp) => this.preToolHook(guard, inp as unknown as Record<string, unknown>)] }] },
      settings: { permissions: { deny: secretDenyRules() } },
      stderr: (d: string) => {
        s.stderr = (s.stderr + d).slice(-4000);
      },
      ...(s.conv.sessionId ? { resume: s.conv.sessionId } : {}),
      // 대화에서 고른 모델 ('' = Claude Code 기본값), 고르지 않았으면 Claude 연결의 기본 모델
      ...((s.conv.model ?? cfg.model) ? { model: s.conv.model ?? cfg.model } : {}),
    };
    s.stderr = '';
    s.resumeAttempt = !!s.conv.sessionId;
    const q = this.queryFn({ prompt: input, options });
    s.q = q;
    s.input = input;
    this.consume(s, q);
  }

  /** Gemini·ChatGPT: 엔진이 앱 도구·권한 확인을 이 대화 관리에 맡긴다 */
  private async openEngine(s: Session, provider: EngineProvider): Promise<void> {
    const engine = this.engine(provider);
    if (!engine) throw new RunError({ code: 'missing', message: `${AI_LABEL[provider]} 연결을 이 앱에서 쓸 수 없습니다`, detail: provider });
    s.cfg = null;
    await this.ensureCwd(s);
    const ai = await getAiSettings();
    const guard: GuardContext = {
      cwd: s.conv.cwd,
      mode: () => s.conv.mode,
      readOnly: !!s.conv.readOnly,
      shellAllow: ai.shellAllow,
      // Claude Code 계획 파일 자리 (다른 AI는 쓰지 않음 — 앱 폴더 안의 빈 자리)
      claudeDir: path.join(dataDir(), 'ai-sessions', 'none'),
    };
    s.guard = guard;
    const summary = s.conv.context?.chips?.find((c) => c.kind === 'summary')?.text;
    const shellAllow = s.conv.readOnly ? [] : ai.shellAllow;
    const input = new InputQueue();
    s.stderr = '';
    s.resumeAttempt = !!s.conv.sessionId;
    const q = await engine.open({
      conversationId: s.conv.id,
      cwd: s.conv.cwd,
      mode: s.conv.mode,
      readOnly: !!s.conv.readOnly,
      kind: s.conv.kind,
      model: s.conv.model ?? (await engine.defaultModel()) ?? '',
      instructions: buildSystemAppend({
        kind: s.conv.kind,
        readOnly: !!s.conv.readOnly,
        shellAllow,
        summary,
        projectName: s.conv.root ? path.basename(s.conv.root) : undefined,
        // Gemini·ChatGPT 모두 앱 도구로 일한다 (ChatGPT는 Codex 자체 도구를 끔)
        tools: 'agent',
      }),
      shellAllow,
      ...(s.conv.sessionId ? { resume: s.conv.sessionId } : {}),
      input,
      db: this.dbHandlers(s),
      canUseTool: (name, inp, o) => this.canUseTool(s, guard, name, inp, o.signal),
      stderr: (d: string) => {
        s.stderr = (s.stderr + d).slice(-4000);
      },
    });
    // 여는 동안 닫혔으면(삭제·연동 끔) 바로 닫는다
    if (!this.sessions.has(s.conv.id)) {
      input.end();
      q.close();
      return;
    }
    s.q = q;
    s.input = input;
    this.consume(s, q);
  }

  private closeQuery(s: Session): void {
    const q = s.q;
    const input = s.input;
    s.q = null;
    s.input = null;
    input?.end();
    if (q) {
      s.closing.add(q);
      try {
        q.close();
      } catch {
        // 이미 끝남
      }
    }
  }

  private clearIdle(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }

  private armIdle(s: Session): void {
    this.clearIdle(s);
    if (!s.q) return;
    s.idleTimer = setTimeout(() => {
      if (!s.running && !s.pendings.length) this.closeQuery(s);
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  private consume(s: Session, q: RunningQuery): void {
    void (async () => {
      let error: unknown = null;
      try {
        for await (const m of q) await this.onMessage(s, m as unknown as Record<string, any>);
      } catch (e) {
        error = e;
      }
      const intentional = s.closing.delete(q);
      if (s.q === q) {
        s.q = null;
        s.input?.end();
        s.input = null;
      }
      if (!intentional) {
        // 앱 쪽 처리 오류로 끝났어도 CLI 프로세스는 남기지 않는다
        try {
          q.close();
        } catch {
          // 이미 끝남
        }
      }
      if (intentional || !s.running || !s.turn || s.turn.gotResult) return;
      // 응답 도중 끝남 (프로세스 오류·인증 실패로 종료 등)
      const err = error as NodeJS.ErrnoException | null;
      const text = `${err?.message ?? `${s.provider === 'claude' ? 'Claude CLI' : s.ai}가 응답 도중 끝났습니다`}\n${s.stderr}`;
      if (s.resumeAttempt && !s.turn.gotInit && !s.turn.fallbackTried && /No conversation found|--resume|session id|not a valid uuid/i.test(text)) {
        await this.resumeFallback(s);
        return;
      }
      const c = error instanceof EngineError ? classifyError({ text, code: error.code, provider: s.provider }) : classifyError({ text, errno: err?.code, provider: s.provider });
      if (!s.turn.hadError) {
        this.addError(s, c);
        this.report(s, { ok: false, code: c.code, detail: c.detail });
      }
      this.endTurn(s);
    })();
  }

  /** 이어서 대화할 AI 세션을 찾지 못함 → 새 세션으로 같은 질문을 (맥락 포함) 다시 보낸다 */
  private async resumeFallback(s: Session): Promise<void> {
    const t = s.turn!;
    t.fallbackTried = true;
    s.conv.sessionId = undefined;
    this.closeQuery(s);
    this.addNotice(s, `이전 ${s.ai} 대화 기록을 찾지 못해 새로 이어서 진행합니다 (앞의 대화 내용은 ${s.ai}가 기억하지 못합니다)`);
    try {
      await this.open(s);
      if (s.turn !== t || !s.input) return;
      s.input.push(userMessage(buildFirstMessage(t.userText, s.conv.context, s.conv.references)));
    } catch (e) {
      const c = this.classifyThrown(s, e);
      this.addError(s, c);
      this.endTurn(s);
    }
  }

  // ---------------------------------------------------------------- 내부: 메시지 → 화면 항목

  private async onMessage(s: Session, m: Record<string, any>): Promise<void> {
    switch (m.type) {
      case 'system':
        this.onSystem(s, m);
        break;
      case 'stream_event':
        this.onStream(s, m);
        break;
      case 'assistant':
        this.onAssistant(s, m);
        break;
      case 'user':
        this.onUser(s, m);
        break;
      case 'result':
        await this.onResult(s, m);
        break;
      default:
        break;
    }
  }

  private onSystem(s: Session, m: Record<string, any>): void {
    const t = s.turn;
    if (m.subtype === 'init') {
      if (t) t.gotInit = true;
      s.apiKeySource = m.apiKeySource;
      if (typeof m.session_id === 'string' && m.session_id && m.session_id !== s.conv.sessionId) {
        s.conv.sessionId = m.session_id;
        this.scheduleSave(s);
      }
      // 실제로 쓰는 모델 (별칭·기본값이 가리키는 모델 이름)
      if (typeof m.model === 'string' && m.model && m.model !== s.conv.activeModel) {
        s.conv.activeModel = m.model;
        this.scheduleSave(s);
        this.emitState(s);
      }
      if (s.cfg && s.provider === 'claude') this.status.noteInit(s.cfg, m);
      return;
    }
    if (!t) return;
    if (m.subtype === 'api_retry' && !t.retryNoticed && Number(m.attempt) >= 2) {
      t.retryNoticed = true;
      this.addNotice(s, `${s.ai} 서버 응답이 늦어 다시 시도하는 중입니다 (${m.attempt}/${m.max_retries})`);
    } else if (m.subtype === 'status' && m.status === 'compacting' && !t.compactNoticed) {
      t.compactNoticed = true;
      this.addNotice(s, '대화가 길어져 앞부분을 요약하는 중입니다');
    }
  }

  private assistantFor(s: Session, msgId: string | undefined): AssistantState {
    const t = s.turn!;
    const key = msgId || 'msg';
    let a = t.assistants.get(key);
    if (!a) {
      a = { itemId: newId('a'), texts: [], streaming: true, added: false, at: nowIso() };
      t.assistants.set(key, a);
    }
    return a;
  }

  private renderAssistant(s: Session, a: AssistantState, immediate: boolean): void {
    const text = a.texts
      .map((x) => x.text)
      .filter((x) => x.trim())
      .join('\n\n');
    if (!text) return;
    const item: ChatItem = { id: a.itemId, type: 'assistant', text, at: a.at, ...(a.streaming && s.running ? { streaming: true } : {}) };
    if (!a.added) {
      a.added = true;
      this.addItem(s, item);
    } else this.updateItem(s, item, immediate);
  }

  private onStream(s: Session, m: Record<string, any>): void {
    const t = s.turn;
    if (!t || m.parent_tool_use_id) return;
    const ev = m.event ?? {};
    switch (ev.type) {
      case 'message_start':
        t.curMsgId = ev.message?.id;
        break;
      case 'content_block_start':
        if (ev.content_block?.type === 'text') this.assistantFor(s, t.curMsgId).texts.push({ idx: ev.index, text: String(ev.content_block.text ?? ''), final: false });
        break;
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta') {
          const a = this.assistantFor(s, t.curMsgId);
          let e = a.texts.find((x) => x.idx === ev.index && !x.final);
          if (!e) {
            e = { idx: ev.index, text: '', final: false };
            a.texts.push(e);
          }
          e.text += String(ev.delta.text ?? '');
          this.renderAssistant(s, a, false);
        }
        break;
      case 'message_stop': {
        const a = t.assistants.get(t.curMsgId || 'msg');
        if (a) {
          a.streaming = false;
          this.renderAssistant(s, a, true);
        }
        break;
      }
      default:
        break;
    }
  }

  private onAssistant(s: Session, m: Record<string, any>): void {
    const t = s.turn;
    if (!t) return;
    const msg = m.message ?? {};
    const sub = !!m.parent_tool_use_id;
    if (m.error && !sub) {
      if (!t.hadError) {
        const c = classifyError({ assistantError: m.error, text: textOf(msg.content), provider: s.provider });
        t.hadError = true;
        this.addError(s, c);
        this.report(s, { ok: false, code: c.code, detail: c.detail });
      }
      return;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'text' && !sub) {
        const a = this.assistantFor(s, msg.id);
        const e = a.texts.find((x) => !x.final);
        if (e) {
          e.text = String(b.text ?? '');
          e.final = true;
        } else a.texts.push({ text: String(b.text ?? ''), final: true });
        this.renderAssistant(s, a, true);
      } else if (b?.type === 'tool_use') {
        this.onToolUse(s, String(b.id), String(b.name), (b.input ?? {}) as Record<string, unknown>, sub);
      }
    }
  }

  private onToolUse(s: Session, id: string, name: string, input: Record<string, unknown>, sub: boolean): void {
    const t = s.turn!;
    if (t.byTool.has(id)) return;
    const guard = s.guard;
    const e = describeTool({ cwd: s.conv.cwd, isPlanFile: (p) => (guard ? isPlanFile(p, guard) : false) }, id, name, input);
    t.byTool.set(id, e);
    if (!e) return;
    if (sub) e.sub = true;
    t.entries.push(e);
    this.renderActivity(s);
  }

  private onUser(s: Session, m: Record<string, any>): void {
    const t = s.turn;
    if (!t || m.isReplay) return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    const results = content.filter((b: any) => b?.type === 'tool_result');
    let changed = false;
    for (const b of results) {
      const e = t.byTool.get(String(b.tool_use_id));
      if (!e) continue;
      applyResult(e, { isError: !!b.is_error, text: textOf(b.content), structured: results.length === 1 ? m.tool_use_result : undefined });
      if (e.kind === 'edit' && e.ok && !e.internal && e.file) t.edited.add(e.file);
      changed = true;
    }
    if (changed) this.renderActivity(s);
  }

  private renderActivity(s: Session): void {
    const t = s.turn;
    if (!t || !t.entries.length) return;
    t.activityId ??= newId('act');
    t.activityAt ??= nowIso();
    const item: ChatItem = {
      id: t.activityId,
      type: 'activity',
      summary: summarize(t.entries),
      items: t.entries.map((e) => ({ kind: e.kind, label: e.label, ...(e.file && !e.internal ? { file: e.file } : {}), ...(e.line ? { line: e.line } : {}) })),
      at: t.activityAt,
    };
    if (!t.activityAdded) {
      t.activityAdded = true;
      this.addItem(s, item);
    } else this.updateItem(s, item, true);
  }

  private async onResult(s: Session, m: Record<string, any>): Promise<void> {
    const t = s.turn;
    if (!t || t.gotResult) return;
    const errText = m.is_error ? (m.subtype === 'success' ? String(m.result ?? '') : (Array.isArray(m.errors) ? m.errors : []).join('; ')) : '';
    if (m.is_error && s.resumeAttempt && !t.fallbackTried && !s.interrupted && /No conversation found|session .*not found|could not find (a )?session/i.test(errText)) {
      await this.resumeFallback(s);
      return;
    }
    t.gotResult = true;
    s.resumeAttempt = false;
    for (const a of t.assistants.values()) {
      a.streaming = false;
      this.renderAssistant(s, a, true);
    }
    const failed = !!m.is_error || m.subtype !== 'success';
    if (failed) {
      if (!t.hadError && !s.interrupted) {
        const c = classifyError({ text: errText || String(m.subtype ?? ''), startupReason: m.startup_failure_reason, status: m.api_error_status, code: m.pa_code, provider: s.provider });
        t.hadError = true;
        this.addError(s, c);
        this.report(s, { ok: false, code: c.code, detail: c.detail });
      }
    } else if (!t.hadError) this.report(s, { ok: true, apiKeySource: s.apiKeySource });
    this.renderActivity(s);
    const work = services.work;
    if (t.edited.size && s.conv.workId && work) {
      try {
        const list = await work.changes(s.conv.workId);
        if (list.length) {
          this.addItem(s, {
            id: newId('ch'),
            type: 'changes',
            workId: s.conv.workId,
            files: list.length,
            plus: list.reduce((n, f) => n + (f.plus || 0), 0),
            minus: list.reduce((n, f) => n + (f.minus || 0), 0),
            paths: list.map((f) => f.path),
            stats: list.map((f) => ({ path: f.path, plus: f.plus || 0, minus: f.minus || 0 })),
            at: nowIso(),
          });
        }
      } catch (e) {
        this.addNotice(s, `작업 사본의 변경을 읽지 못했습니다: ${(e as Error).message}`);
      }
    }
    if (s.interrupted) this.addNotice(s, '응답을 중지했습니다');
    this.endTurn(s);
  }

  private endTurn(s: Session): void {
    s.running = false;
    s.turn = null;
    s.interrupted = false;
    for (const p of s.pendings.splice(0)) p.resolve(false);
    this.flushEmits(s);
    this.emitState(s);
    void this.saveNow(s);
    this.armIdle(s);
    for (const w of s.waiters.splice(0)) w();
  }

  // ---------------------------------------------------------------- 내부: 권한·사용자 확인

  private async preToolHook(guard: GuardContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const d = preToolUse(guard, String(input.tool_name ?? ''), (input.tool_input ?? {}) as Record<string, unknown>);
    if (d.decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } };
    if (d.decision === 'ask') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.reason } };
    return { continue: true };
  }

  private async canUseTool(
    s: Session,
    guard: GuardContext,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: any[] } | { behavior: 'deny'; message: string }> {
    const allow = () => ({ behavior: 'allow' as const, updatedInput: input });
    const deny = (message: string) => ({ behavior: 'deny' as const, message });
    if (name === 'ExitPlanMode') {
      if (s.conv.readOnly) return deny(MSG_READONLY);
      if (s.conv.mode === 'edit') return allow();
      const plan = typeof input.plan === 'string' && input.plan.trim() ? input.plan : await this.readPlanFile(guard.claudeDir, s.turn?.startedAt ?? Date.now());
      const ok = await this.ask(
        s,
        {
          kind: 'plan',
          title: s.conv.kind === 'new' ? '계획 확정' : '수정 진행',
          detail: (plan || `${s.ai}가 계획을 마쳤습니다. 작업 사본에서 수정을 진행할까요?`).slice(0, 20000),
        },
        signal,
      );
      if (!ok) return deny('사용자가 아직 수정 진행을 승인하지 않았습니다. 계획 모드를 유지하고, 필요하면 수정안을 다듬거나 사용자에게 물어보세요.');
      this.switchMode(s, 'edit', 'plan', false);
      const q = s.q;
      setTimeout(() => void q?.setPermissionMode('acceptEdits').catch(() => undefined), 0);
      return { ...allow(), updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
    }
    if (SHELL_TOOLS.has(name)) {
      const pre = preToolUse(guard, name, input);
      if (pre.decision === 'deny') return deny(pre.reason);
      const ok = await this.ask(s, { kind: 'command', title: `${s.ai}가 명령을 실행하려고 합니다`, detail: String(input.command ?? '') }, signal);
      return ok ? allow() : deny('사용자가 명령 실행을 거부했습니다. 같은 명령을 다시 요청하지 말고, 명령 없이 진행하거나 사용자가 직접 실행하도록 안내해 주세요.');
    }
    const d = permissionDefault(guard, name, input);
    return d.allow ? allow() : deny(d.reason);
  }

  private askSelect(s: Session, q: DbSelectAsk): Promise<boolean> {
    const env = q.env as Env;
    const envName = ENV_LABEL[env] ?? env;
    const detail =
      env === 'prod'
        ? `${s.ai}가 운영 DB ${q.dbName}를 조회하려고 합니다(최대 ${q.maxRows}행${q.mask ? ', 개인정보 가림' : ''}). 운영 조회는 항상 확인합니다. 실행할까요?`
        : `${s.ai}가 ${envName} DB ${q.dbName}를 조회하려고 합니다(최대 ${q.maxRows}행${q.mask ? ', 개인정보 가림' : ''}). 실행할까요?`;
    return this.ask(s, { kind: 'prod-select', title: `${envName} DB 조회`, detail, sql: q.sql, db: q.dbName, env, maxRows: q.maxRows, mask: q.mask });
  }

  private ask(s: Session, req: Omit<PendingRequest, 'requestId'>, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const entry: PendingEntry = {
        req: { ...req, requestId: newId('r') },
        resolve: (v) => {
          if (done) return;
          done = true;
          const i = s.pendings.indexOf(entry);
          if (i >= 0) s.pendings.splice(i, 1);
          this.emitState(s);
          resolve(v);
        },
      };
      s.pendings.push(entry);
      this.emitState(s);
      if (signal) {
        if (signal.aborted) entry.resolve(false);
        else signal.addEventListener('abort', () => entry.resolve(false), { once: true });
      }
    });
  }

  private switchMode(s: Session, mode: ChatMode, via: 'user' | 'plan', apply: boolean): void {
    s.conv.mode = mode;
    this.addItem(s, { id: newId('m'), type: 'mode', mode, at: nowIso(), via });
    if (apply && s.q) void s.q.setPermissionMode(mode === 'edit' ? 'acceptEdits' : 'plan').catch(() => undefined);
    this.emitState(s);
    this.scheduleSave(s);
  }

  /** ExitPlanMode 입력에 계획이 없으면 Claude Code 계획 파일(~/.claude/plans/*.md 중 이번 턴에 쓴 것)을 읽는다 */
  private async readPlanFile(claudeDir: string, since: number): Promise<string> {
    const dir = path.join(claudeDir, 'plans');
    try {
      const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md'));
      let best: { f: string; t: number } | null = null;
      for (const n of names) {
        const f = path.join(dir, n);
        const st = await fsp.stat(f);
        if (st.mtimeMs >= since - 60000 && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs };
      }
      if (!best) return '';
      return (await fsp.readFile(best.f, 'utf8')).slice(0, 20000);
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- 내부: 쿼리 카드 갱신

  private async onCard(card: QueryCard): Promise<void> {
    if (!card?.conversationId || !validId(card.conversationId)) return;
    const s = this.sessions.get(card.conversationId) ?? (await this.load(card.conversationId).catch(() => null));
    if (!s) return;
    const id = `q-${card.id}`;
    const it = s.conv.items.find((x) => x.id === id);
    if (!it || it.type !== 'query') return;
    this.updateItem(s, { ...it, card }, true);
    this.scheduleSave(s);
  }

  // ---------------------------------------------------------------- 내부: 항목·상태 보내기와 저장

  private addItem(s: Session, item: ChatItem): void {
    this.flushEmits(s);
    s.conv.items.push(item);
    s.conv.updatedAt = nowIso();
    emit({ type: 'claude.item', conversationId: s.conv.id, item });
    this.scheduleSave(s);
  }

  private updateItem(s: Session, item: ChatItem, immediate: boolean): void {
    const i = s.conv.items.findIndex((x) => x.id === item.id);
    if (i < 0) {
      this.addItem(s, item);
      return;
    }
    s.conv.items[i] = item;
    s.dirty.add(item.id);
    if (immediate) this.flushEmits(s);
    else if (!s.emitTimer) {
      s.emitTimer = setTimeout(() => this.flushEmits(s), EMIT_MS);
      s.emitTimer.unref?.();
    }
    this.scheduleSave(s);
  }

  private flushEmits(s: Session): void {
    if (s.emitTimer) clearTimeout(s.emitTimer);
    s.emitTimer = null;
    if (!s.dirty.size) return;
    const ids = [...s.dirty];
    s.dirty.clear();
    for (const id of ids) {
      const item = s.conv.items.find((x) => x.id === id);
      if (item) emit({ type: 'claude.item', conversationId: s.conv.id, item });
    }
  }

  private addNotice(s: Session, text: string, msg?: string, vars?: Record<string, string | number>): void {
    this.addItem(s, { id: newId('n'), type: 'notice', text, at: nowIso(), ...(msg ? { msg } : {}), ...(vars ? { vars } : {}) });
  }

  private addError(s: Session, c: Classified): void {
    this.addItem(s, { id: newId('e'), type: 'error', code: c.code, message: c.message, at: nowIso() });
  }

  private emitState(s: Session): void {
    emit({
      type: 'claude.state',
      conversationId: s.conv.id,
      running: s.running,
      mode: s.conv.mode,
      workId: s.conv.workId,
      pending: s.pendings[0]?.req ?? null,
      ...(s.conv.model !== undefined ? { model: s.conv.model } : {}),
      ...(s.conv.activeModel ? { activeModel: s.conv.activeModel } : {}),
    });
  }

  private scheduleSave(s: Session): void {
    if (s.saveTimer) return;
    s.saveTimer = setTimeout(() => void this.saveNow(s), SAVE_MS);
    s.saveTimer.unref?.();
  }

  private async saveNow(s: Session): Promise<void> {
    if (s.saveTimer) clearTimeout(s.saveTimer);
    s.saveTimer = null;
    if (!this.sessions.has(s.conv.id)) return;
    try {
      await saveConv(s.conv);
    } catch {
      // 디스크 오류: 다음 저장 때 다시
    }
  }

  /** 시험용 */
  _session(id: string): { running: boolean; pendings: PendingRequest[]; hasQuery: boolean } | null {
    const s = this.sessions.get(id);
    return s ? { running: s.running, pendings: s.pendings.map((p) => p.req), hasQuery: !!s.q } : null;
  }

  /** 시험용: 메모리에서만 지운다 (앱 다시 시작 흉내) */
  /** 시험용: 메모리의 대화를 잊는다 (저장을 마친 뒤 — 다음에 파일에서 다시 읽음) */
  async _forget(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      this.closeQuery(s);
      await this.saveNow(s);
    }
    this.sessions.delete(id);
  }
}
