// Gemini REST 연결 (SDK 없이): generateContent 스트리밍(SSE)·모델 목록·토큰 세기.
//   API 키      https://generativelanguage.googleapis.com/v1beta/models/{모델}:streamGenerateContent?alt=sse  (x-goog-api-key)
//   Vertex AI   https://{지역}-aiplatform.googleapis.com/v1/projects/{프로젝트}/locations/{지역}/publishers/google/models/{모델}:…
//               (global은 aiplatform.googleapis.com, 토큰은 PC의 `gcloud auth print-access-token`)
// 요청은 host().fetch(Electron 네트워크: PC 프록시·PAC·Windows 인증서 저장소)로 보낸다.
// 필드 이름 확인: @google/genai 2.30.0 genai.d.ts (Part.thoughtSignature, FunctionCall.id, FunctionResponse.id/response,
//   ThinkingConfig.includeThoughts, FunctionCallingConfig.mode)
import { spawn } from 'node:child_process';
import type { ClaudeErrorCode } from '../../shared/desktop-api';
import { EngineError } from '../ai/engine';
import { host } from '../host';
import type { GeminiStored } from './config';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  [k: string]: unknown;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GenerateChunk {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string; finishMessage?: string }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

export type FetchFn = (url: string, init: RequestInit & { proxy?: string }) => Promise<Response>;

export interface GeminiClientOptions {
  /** 시험용: 가짜 서버 주소 (https://… 대신) */
  baseUrl?: string;
  /** 시험용: Vertex 토큰 */
  tokenFn?: () => Promise<string>;
  fetch?: FetchFn;
}

/** HTTP 오류 → 오류 종류 */
export class GeminiHttpError extends EngineError {
  constructor(
    message: string,
    code: ClaudeErrorCode,
    public http: number,
    public retryAfterMs?: number,
    public daily?: boolean,
  ) {
    super(message, code);
  }
}

const GCLOUD_TTL = 45 * 60 * 1000;
let gcloudCache: { token: string; at: number } | null = null;

/** PC의 gcloud 로그인으로 액세스 토큰 (앱은 계정 정보를 저장하지 않음, 45분 기억) */
export async function gcloudToken(force = false): Promise<string> {
  if (!force && gcloudCache && Date.now() - gcloudCache.at < GCLOUD_TTL) return gcloudCache.token;
  // E2E 시험(PA_E2E=1)에서만: gcloud 없이 정한 토큰
  if (process.env.PA_E2E === '1' && process.env.PA_FAKE_GCLOUD_TOKEN) return process.env.PA_FAKE_GCLOUD_TOKEN;
  const token = await new Promise<string>((resolve, reject) => {
    const win = process.platform === 'win32';
    // Windows의 gcloud는 gcloud.cmd라 셸로 실행 (인수는 고정 값)
    const child = spawn('gcloud', ['auth', 'print-access-token'], { shell: win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new EngineError(e.code === 'ENOENT' ? 'PC에서 gcloud(Google Cloud CLI)를 찾지 못했습니다' : `gcloud를 실행하지 못했습니다: ${e.message}`, e.code === 'ENOENT' ? 'missing' : 'auth'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const t = out.trim().split(/\s+/).pop() ?? '';
      if (code === 0 && t.length > 20) resolve(t);
      else if (/is not recognized|not found|No such file/i.test(err)) reject(new EngineError('PC에서 gcloud(Google Cloud CLI)를 찾지 못했습니다', 'missing'));
      else reject(new EngineError(`gcloud 로그인이 필요합니다 (명령 창에서 gcloud auth login): ${err.trim().split('\n').pop() ?? `종료 코드 ${code}`}`, 'auth'));
    });
  });
  gcloudCache = { token, at: Date.now() };
  return token;
}

export function clearGcloudToken(): void {
  gcloudCache = null;
}

function baseOverride(o: GeminiClientOptions): string | undefined {
  if (o.baseUrl) return o.baseUrl.replace(/\/+$/, '');
  if (process.env.PA_E2E === '1' && process.env.PA_GEMINI_BASE_URL) return process.env.PA_GEMINI_BASE_URL.replace(/\/+$/, '');
  return undefined;
}

export class GeminiClient {
  constructor(
    private cfg: GeminiStored,
    private apiKey: string | null,
    private proxy: string | undefined,
    private o: GeminiClientOptions = {},
  ) {}

  get vertex(): boolean {
    return this.cfg.authMode === 'vertex';
  }

  /** 연결 확인 주소 (인터넷 확인) */
  netUrl(): string {
    const over = baseOverride(this.o);
    if (over) return `${over}/`;
    if (!this.vertex) return 'https://generativelanguage.googleapis.com/';
    const loc = this.cfg.vertex?.location || 'global';
    return loc === 'global' ? 'https://aiplatform.googleapis.com/' : `https://${loc}-aiplatform.googleapis.com/`;
  }

  /** …/models 까지의 주소 */
  private modelsBase(): string {
    const over = baseOverride(this.o);
    if (!this.vertex) return `${over ?? 'https://generativelanguage.googleapis.com'}/v1beta/models`;
    const project = this.cfg.vertex?.project ?? '';
    if (!project) throw new EngineError('회사 Google Cloud 프로젝트 ID가 없습니다 (설정 > AI 연결 > Gemini)', 'auth');
    const loc = this.cfg.vertex?.location || 'global';
    const hostUrl = over ?? (loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`);
    return `${hostUrl}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/publishers/google/models`;
  }

  private async headers(force = false): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', 'x-goog-api-client': 'project-analyzer' };
    if (this.vertex) {
      const token = this.o.tokenFn ? await this.o.tokenFn() : await gcloudToken(force);
      h.Authorization = `Bearer ${token}`;
    } else {
      if (!this.apiKey) throw new EngineError('Gemini API 키가 없습니다 (설정 > AI 연결 > Gemini)', 'auth');
      h['x-goog-api-key'] = this.apiKey;
    }
    return h;
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    const f: FetchFn = this.o.fetch ?? host().fetch ?? ((u, i) => fetch(u, i));
    return f(url, { ...init, ...(this.proxy ? { proxy: this.proxy } : {}) });
  }

  /** 요청 (Vertex 토큰이 만료됐으면 한 번 새로 받아 다시) */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let res = await this.doFetch(url, { ...init, headers: await this.headers() });
    if (res.status === 401 && this.vertex && !this.o.tokenFn) {
      clearGcloudToken();
      res = await this.doFetch(url, { ...init, headers: await this.headers(true) });
    }
    if (!res.ok) throw await httpError(res);
    return res;
  }

  /** 답변 스트리밍: SSE의 data 하나씩 */
  async *stream(model: string, body: unknown, signal: AbortSignal): AsyncGenerator<GenerateChunk> {
    const res = await this.request(`${this.modelsBase()}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', body: JSON.stringify(body), signal });
    if (!res.body) throw new EngineError('Gemini가 빈 응답을 보냈습니다', 'other');
    yield* readSse(res.body, signal);
  }

  async countTokens(model: string, signal?: AbortSignal): Promise<number> {
    const res = await this.request(`${this.modelsBase()}/${encodeURIComponent(model)}:countTokens`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'OK' }] }] }),
      ...(signal ? { signal } : {}),
    });
    const j = (await res.json()) as { totalTokens?: number };
    return Number(j.totalTokens ?? 0);
  }

  /** 모델 목록 (API 키 연결만. Vertex는 목록 API 대신 알려진 모델) */
  async listModels(signal?: AbortSignal): Promise<RawGeminiModel[]> {
    if (this.vertex) return [];
    const out: RawGeminiModel[] = [];
    let page = '';
    for (let i = 0; i < 5; i++) {
      const res = await this.request(`${this.modelsBase()}?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { method: 'GET', ...(signal ? { signal } : {}) });
      const j = (await res.json()) as { models?: RawGeminiModel[]; nextPageToken?: string };
      out.push(...(j.models ?? []));
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  }
}

export interface RawGeminiModel {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
}

/** HTTP 오류 응답 → 오류 종류와 문구 */
export async function httpError(res: Response): Promise<GeminiHttpError> {
  let body: { error?: { code?: number; message?: string; status?: string; details?: Record<string, unknown>[] } } = {};
  let raw = '';
  try {
    raw = await res.text();
    body = JSON.parse(raw);
  } catch {
    // JSON이 아님 (프록시 오류 페이지 등)
  }
  const e = body.error ?? {};
  const status = e.status ?? '';
  const msg = (e.message ?? raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 400) || res.statusText;
  const details = Array.isArray(e.details) ? e.details : [];
  const reasons = details.map((d) => String(d.reason ?? '')).join(' ');
  const text = `HTTP ${res.status}${status ? ` ${status}` : ''}: ${msg}`;
  let code: ClaudeErrorCode = 'other';
  let retryAfterMs: number | undefined;
  let daily = false;
  if (res.status === 401 || /API_KEY_INVALID|API key not valid|API_KEY_.*EXPIRED|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|invalid authentication credentials/i.test(`${status} ${reasons} ${msg}`)) code = 'auth';
  else if (res.status === 429 || status === 'RESOURCE_EXHAUSTED') {
    code = 'limit';
    for (const d of details) {
      const delay = typeof d.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay) : null;
      if (delay) retryAfterMs = Math.ceil(Number(delay[1]) * 1000);
      const v = JSON.stringify(d.violations ?? '');
      if (/PerDay|per_day|daily/i.test(v)) daily = true;
    }
  } else if (res.status === 403 || status === 'PERMISSION_DENIED') code = /billing|BILLING|payment|has not been used in project|is disabled|SERVICE_DISABLED|CONSUMER_SUSPENDED/i.test(`${reasons} ${msg}`) ? 'billing' : 'auth';
  else if (res.status === 402) code = 'billing';
  else if (res.status === 407) code = 'offline';
  else if (res.status === 404) return new GeminiHttpError(`모델을 찾을 수 없습니다 — 설정의 모델 이름을 확인해 주세요 (${text})`, 'other', res.status);
  return new GeminiHttpError(text, code, res.status, retryAfterMs, daily);
}

/** SSE 본문 → data JSON들 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<GenerateChunk> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (value) buf += dec.decode(value, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const chunk = parseBlock(block);
        if (chunk) yield chunk;
      }
      if (done) break;
    }
    const last = parseBlock(buf + dec.decode());
    if (last) yield last;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function parseBlock(block: string): GenerateChunk | null {
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as GenerateChunk;
  } catch {
    throw new EngineError(`Gemini 응답을 읽지 못했습니다: ${data.slice(0, 200)}`, 'other');
  }
}
