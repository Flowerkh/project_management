// Gemini 대화 하나: 앱이 도구를 돌리는 순환 (질문 → Gemini 답·도구 호출 → 도구 실행 → 결과를 돌려줌 → … → 답)
// 대화 기록은 앱이 보관한다: <dataDir>/ai-sessions/gemini/<세션 ID>.json (Gemini API는 대화를 기억하지 않음)
// 모델 응답 부분(part)은 받은 그대로 기록에 남긴다 — thoughtSignature가 붙은 부분을 다음 요청에 그대로 돌려줘야 한다.
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Aborted, AgentQueryBase, newToolId, throwIfAborted, type ToolOutcome } from '../ai/agent-query';
import { EngineError, type EngineOpenOptions } from '../ai/engine';
import { FS_TOOLS, runFsTool } from '../ai/fstools';
import { writeJson } from '../store';
import { type GeminiClient, type GeminiContent, GeminiHttpError, type GeminiPart } from './client';
import { geminiTools, toClaudeTool } from '../ai/tools';

export interface GeminiQueryDeps {
  client(): Promise<GeminiClient>;
  /** 이 대화에 모델을 고르지 않았을 때 쓸 모델 */
  defaultModel(): Promise<string>;
  /** 대화 기록 폴더 */
  sessionsDir: string;
  /** 한 번의 질문에서 Gemini를 부르는 최대 횟수 (도구를 쓰는 단계 수) */
  maxSteps?: number;
  /** 다시 시도 간격 (시험은 짧게) */
  retryDelays?: number[];
  /** 기록 크기 한도 (글자). 넘으면 오래된 도구 결과부터 줄인다 */
  maxHistoryChars?: number;
  commandTimeoutMs?: number;
}

interface SessionFile {
  v: 1;
  model?: string;
  updatedAt: string;
  contents: GeminiContent[];
}

const SAFETY = /SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|IMAGE_SAFETY|LANGUAGE/;
const BAD_CALL = /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS/;
const OLD_RESULT = '(대화가 길어 오래된 도구 결과는 생략했습니다. 필요하면 다시 읽어 주세요)';

export function sessionIdOk(id: string): boolean {
  return /^gs[a-z0-9]{8,40}$/.test(id);
}

function newSessionId(): string {
  return `gs${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 글만 있는 이웃 부분은 합친다 (서명·도구 호출이 붙은 부분은 그대로) */
export function mergeParts(parts: GeminiPart[]): GeminiPart[] {
  const out: GeminiPart[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object' || !Object.keys(p).length) continue;
    const plain = Object.keys(p).length === 1 && typeof p.text === 'string';
    if (plain && !p.text) continue;
    const prev = out[out.length - 1];
    if (plain && prev && Object.keys(prev).length === 1 && typeof prev.text === 'string') prev.text += p.text;
    else out.push(plain ? { text: p.text } : { ...p });
  }
  return out;
}

function retryable(e: unknown): { ok: boolean; waitMs?: number } {
  if (e instanceof GeminiHttpError) {
    if ([500, 502, 503, 504].includes(e.http)) return { ok: true };
    if (e.code === 'limit' && !e.daily && (e.retryAfterMs ?? 0) <= 20000) return { ok: true, waitMs: e.retryAfterMs };
    return { ok: false };
  }
  if (e instanceof EngineError) return { ok: false };
  const err = e as NodeJS.ErrnoException & { cause?: { code?: string } };
  const text = `${err?.message ?? ''} ${err?.code ?? ''} ${err?.cause?.code ?? ''}`;
  return { ok: /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|socket hang up|UND_ERR/i.test(text) };
}

export class GeminiQuery extends AgentQueryBase {
  private history: GeminiContent[] = [];
  private sessionId = '';
  private resumeMissing = false;

  private constructor(
    o: EngineOpenOptions,
    private deps: GeminiQueryDeps,
  ) {
    super(o);
  }

  static async open(o: EngineOpenOptions, deps: GeminiQueryDeps): Promise<GeminiQuery> {
    const q = new GeminiQuery(o, deps);
    await q.load();
    q.start();
    return q;
  }

  private file(id = this.sessionId): string {
    return path.join(this.deps.sessionsDir, `${id}.json`);
  }

  private async load(): Promise<void> {
    const id = this.o.resume;
    if (!id) {
      this.sessionId = newSessionId();
      return;
    }
    this.sessionId = id;
    try {
      if (!sessionIdOk(id)) throw new Error('bad id');
      const f = JSON.parse(await fsp.readFile(this.file(id), 'utf8')) as SessionFile;
      if (!Array.isArray(f.contents)) throw new Error('bad file');
      this.history = f.contents.filter((c) => c && (c.role === 'user' || c.role === 'model') && Array.isArray(c.parts));
    } catch {
      this.resumeMissing = true;
    }
  }

  private async save(model: string): Promise<void> {
    const data: SessionFile = { v: 1, model, updatedAt: new Date().toISOString(), contents: this.history };
    await writeJson(this.file(), data).catch(() => undefined);
  }

  /** 이전 턴이 중지·오류로 끝나 짝이 맞지 않으면 맞춘다 (도구 호출에 결과가 없음 · 사용자 글로 끝남) */
  private fixDangling(): void {
    const last = this.history[this.history.length - 1];
    if (!last) return;
    if (last.role === 'user') {
      this.history.push({ role: 'model', parts: [{ text: '(이전 요청에는 답하지 못했습니다)' }] });
      return;
    }
    const calls = last.parts.filter((p) => p.functionCall);
    if (calls.length)
      this.history.push({
        role: 'user',
        parts: calls.map((c) => ({ functionResponse: { ...(c.functionCall!.id ? { id: c.functionCall!.id } : {}), name: c.functionCall!.name ?? '', response: { error: '사용자가 중지해 실행하지 않았습니다' } } })),
      });
  }

  /** 기록이 너무 크면 오래된 도구 결과부터 줄인다 */
  private trim(): void {
    const max = this.deps.maxHistoryChars ?? 2_500_000;
    let size = JSON.stringify(this.history).length;
    if (size <= max) return;
    for (const c of this.history.slice(0, -2)) {
      for (const p of c.parts) {
        const r = p.functionResponse;
        if (!r) continue;
        const before = JSON.stringify(r.response).length;
        if (before <= OLD_RESULT.length + 20) continue;
        r.response = { output: OLD_RESULT };
        size -= before - JSON.stringify(r.response).length;
        if (size <= max) return;
      }
    }
  }

  private body(): Record<string, unknown> {
    this.trim();
    return {
      systemInstruction: { parts: [{ text: this.o.instructions }] },
      contents: this.history,
      tools: [{ functionDeclarations: geminiTools({ readOnly: this.o.readOnly, shell: this.o.shellAllow.length > 0 }) }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { thinkingConfig: { includeThoughts: false } },
    };
  }

  protected async runTurn(text: string, signal: AbortSignal): Promise<void> {
    if (this.resumeMissing) {
      // 대화 관리가 맥락을 붙여 새 세션으로 다시 보낸다
      this.emitNoSession(this.sessionId);
      return;
    }
    const model = this.model || (await this.deps.defaultModel());
    const client = await this.deps.client();
    this.emitInit(this.sessionId, model);
    this.fixDangling();
    this.history.push({ role: 'user', parts: [{ text }] });
    await this.save(model);
    const maxSteps = this.deps.maxSteps ?? 60;
    let finalText = '';
    try {
      for (let step = 0; ; step++) {
        throwIfAborted(signal);
        if (step >= maxSteps) {
          const note = `(한 번의 질문에서 도구를 ${maxSteps}번 넘게 써서 여기서 멈췄습니다. 이어서 하려면 '계속'이라고 보내 주세요.)`;
          const id = this.newMessageId();
          this.emitAssistant(id, [{ type: 'text', text: note }]);
          this.history.push({ role: 'model', parts: [{ text: note }] });
          finalText = note;
          break;
        }
        const r = await this.generate(client, model, signal);
        this.history.push({ role: 'model', parts: r.parts });
        await this.save(model);
        if (!r.calls.length) {
          finalText = r.text;
          break;
        }
        const responses: GeminiPart[] = [];
        for (const c of r.calls) {
          let out: ToolOutcome;
          if (!c.claude) {
            out = { text: `이 앱에 없는 도구입니다: ${c.name}`, isError: true };
            this.emitToolResult(c.toolUseId, out);
          } else out = await this.runTool(c.toolUseId, c.claude.name, c.claude.input, signal);
          responses.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: out.isError ? { error: out.text } : { output: out.text } } });
        }
        this.history.push({ role: 'user', parts: responses });
        await this.save(model);
      }
    } finally {
      await this.save(model);
    }
    this.emitSuccess(finalText);
  }

  protected override async execTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    if (FS_TOOLS.has(name)) return runFsTool(name, input, { cwd: this.o.cwd, signal, commandTimeoutMs: this.deps.commandTimeoutMs });
    return super.execTool(name, input, signal);
  }

  /** Gemini 한 번 부르기: 글은 흘려 보내고, 끝나면 전체 글과 도구 호출을 assistant 메시지로 */
  private async generate(
    client: GeminiClient,
    model: string,
    signal: AbortSignal,
  ): Promise<{ parts: GeminiPart[]; text: string; calls: { id?: string; name: string; toolUseId: string; claude: { name: string; input: Record<string, unknown> } | null }[] }> {
    const delays = this.deps.retryDelays ?? [2000, 5000, 10000];
    let badCallRetried = false;
    for (let attempt = 0; ; attempt++) {
      const msgId = this.newMessageId();
      let received = false;
      let began = false;
      try {
        const raw: GeminiPart[] = [];
        let text = '';
        let finish = '';
        let finishMessage = '';
        for await (const chunk of client.stream(model, this.body(), signal)) {
          if (chunk.error) throw new EngineError(`Gemini 오류: ${chunk.error.message ?? chunk.error.status ?? ''}`, 'other');
          if (chunk.promptFeedback?.blockReason) throw new EngineError(`Gemini가 요청을 거절했습니다 (${chunk.promptFeedback.blockReason}${chunk.promptFeedback.blockReasonMessage ? `: ${chunk.promptFeedback.blockReasonMessage}` : ''})`, 'other');
          const cand = chunk.candidates?.[0];
          for (const p of cand?.content?.parts ?? []) {
            if (!p || typeof p !== 'object') continue;
            received = true;
            raw.push(p);
            if (typeof p.text === 'string' && p.text && !p.thought) {
              if (!began) {
                this.beginMessage(msgId);
                began = true;
              }
              this.textDelta(msgId, 0, p.text);
              text += p.text;
            }
          }
          if (cand?.finishReason) finish = cand.finishReason;
          if (cand?.finishMessage) finishMessage = cand.finishMessage;
        }
        throwIfAborted(signal);
        const parts = mergeParts(raw);
        const callParts = parts.filter((p) => p.functionCall?.name);
        if (!callParts.length && !text.trim()) {
          if (BAD_CALL.test(finish) && !badCallRetried) {
            badCallRetried = true;
            continue;
          }
          if (BAD_CALL.test(finish)) throw new EngineError(`Gemini가 도구 호출을 잘못 만들었습니다 (${finish}). 다시 시도해 주세요`, 'other');
          if (SAFETY.test(finish)) throw new EngineError(`Gemini가 안전 정책으로 답변을 멈췄습니다 (${finish}${finishMessage ? `: ${finishMessage}` : ''})`, 'other');
          if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') throw new EngineError(`Gemini가 답변 없이 끝났습니다 (${finish}${finishMessage ? `: ${finishMessage}` : ''})`, 'other');
        }
        if (finish === 'MAX_TOKENS' && !callParts.length) {
          const note = "\n\n(답변이 길어 중간에 끊겼습니다. 이어서 보려면 '계속'이라고 보내 주세요.)";
          if (!began) {
            this.beginMessage(msgId);
            began = true;
          }
          this.textDelta(msgId, 0, note);
          text += note;
        }
        if (!text.trim() && !callParts.length) {
          text = '(Gemini가 빈 답변을 보냈습니다. 질문을 바꿔 다시 보내 주세요.)';
          this.beginMessage(msgId);
          began = true;
          this.textDelta(msgId, 0, text);
        }
        if (began) this.endMessage(msgId);
        const calls = callParts.map((p) => {
          const fc = p.functionCall!;
          const name = String(fc.name);
          return { ...(fc.id ? { id: fc.id } : {}), name, toolUseId: fc.id ? `toolu_${fc.id}` : newToolId(), claude: toClaudeTool(name, fc.args) };
        });
        this.emitAssistant(msgId, [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...calls.map((c) => ({ type: 'tool_use' as const, id: c.toolUseId, name: c.claude?.name ?? c.name, input: c.claude?.input ?? {} })),
        ]);
        // 기록에는 받은 부분 그대로 (빈 응답이면 자리 채움)
        return { parts: parts.length ? parts : [{ text: text || '(빈 응답)' }], text, calls };
      } catch (e) {
        if (signal.aborted || e instanceof Aborted) throw new Aborted();
        if (began) this.endMessage(msgId);
        const r = retryable(e);
        // 글을 이미 흘려 보냈으면 다시 시도하지 않는다 (같은 글이 두 번 보임)
        if (received || !r.ok || attempt >= delays.length) throw e;
        this.emitRetry(attempt + 2, delays.length + 1);
        await sleep(Math.max(r.waitMs ?? 0, delays[attempt]), signal);
      }
    }
  }

  protected override async dispose(): Promise<void> {
    // 기록 파일은 대화를 지울 때(forget) 지운다
  }
}

export async function forgetGeminiSession(dir: string, sessionId: string): Promise<void> {
  if (!sessionIdOk(sessionId)) return;
  await fsp.rm(path.join(dir, `${sessionId}.json`), { force: true });
}
