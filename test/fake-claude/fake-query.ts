// 시험용 가짜 SDK query(): 스트리밍 입력의 사용자 메시지마다 handler를 불러 SDK 메시지를 흘려보낸다.
// handler는 실제 CLI처럼 훅(PreToolUse)·canUseTool·projdb 도구를 부를 수 있다.
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../../src/desktop/claude/sdk';
import type { DbToolHandlers } from '../../src/desktop/claude/tools';

type Msg = Record<string, unknown>;

class Chan<T> {
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
  next(): Promise<IteratorResult<T>> {
    if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
}

export interface TurnApi {
  n: number;
  text: string;
  options: Options;
  emit(m: Msg): void;
  /** CLI처럼 PreToolUse 훅을 부른다 → 훅 결과 */
  hook(tool: string, input: Record<string, unknown>, toolUseId?: string): Promise<Record<string, any>>;
  canUseTool(tool: string, input: Record<string, unknown>, toolUseId?: string): Promise<Record<string, any>>;
  db(): DbToolHandlers;
  interrupted(): boolean;
  waitInterrupt(ms?: number): Promise<boolean>;
}

export interface FakeCalls {
  options: Options[];
  setMode: string[];
  interrupts: number;
  closed: number;
  turns: string[];
}

export function fakeQuery(handler: (t: TurnApi) => Promise<void> | void): { queryFn: QueryFn; calls: FakeCalls } {
  const calls: FakeCalls = { options: [], setMode: [], interrupts: 0, closed: 0, turns: [] };
  let turnNo = 0;
  const queryFn: QueryFn = ({ prompt, options = {} }) => {
    calls.options.push(options);
    const out = new Chan<SDKMessage>();
    let interrupted = false;
    let wake: (() => void) | null = null;
    const ac = new AbortController();
    void (async () => {
      const it = typeof prompt === 'string' ? [{ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as SDKUserMessage] : prompt;
      try {
        for await (const u of it as AsyncIterable<SDKUserMessage>) {
          const content = u.message.content;
          const text = typeof content === 'string' ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n');
          calls.turns.push(text);
          interrupted = false;
          const api: TurnApi = {
            n: ++turnNo,
            text,
            options,
            emit: (m) => out.push(m as unknown as SDKMessage),
            async hook(tool, input, toolUseId = `toolu_${Math.random().toString(36).slice(2)}`) {
              const m = options.hooks?.PreToolUse?.[0];
              if (!m) return {};
              return (await m.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: toolUseId, session_id: 's', transcript_path: '', cwd: options.cwd ?? '' } as never, toolUseId, { signal: ac.signal })) as Record<string, any>;
            },
            async canUseTool(tool, input, toolUseId = `toolu_${Math.random().toString(36).slice(2)}`) {
              if (!options.canUseTool) throw new Error('canUseTool 없음');
              return (await options.canUseTool(tool, input, { signal: ac.signal, toolUseID: toolUseId, requestId: 'r1' } as never)) as Record<string, any>;
            },
            db() {
              const s = options.mcpServers?.projdb as unknown as { __handlers: DbToolHandlers };
              return s.__handlers;
            },
            interrupted: () => interrupted,
            waitInterrupt(ms = 5000) {
              if (interrupted) return Promise.resolve(true);
              return new Promise((r) => {
                const t = setTimeout(() => r(false), ms);
                wake = () => {
                  clearTimeout(t);
                  r(true);
                };
              });
            },
          };
          await handler(api);
        }
      } catch (e) {
        out.push({ type: '__throw', error: e } as unknown as SDKMessage);
      }
      out.end();
    })();
    const q = {
      async next() {
        const r = await out.next();
        if (!r.done && (r.value as unknown as Msg).type === '__throw') throw (r.value as unknown as { error: Error }).error;
        return r;
      },
      async return() {
        out.end();
        return { value: undefined, done: true };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt() {
        calls.interrupts++;
        interrupted = true;
        ac.abort();
        wake?.();
        return undefined;
      },
      async setPermissionMode(m: string) {
        calls.setMode.push(m);
      },
      close() {
        calls.closed++;
        ac.abort();
        out.end();
      },
    };
    return q as unknown as Query;
  };
  return { queryFn, calls };
}

// ------------------------------------------------------------------ 실제 CLI와 같은 모양의 메시지

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
export const SESSION = '11111111-2222-4333-8444-555555555555';

export function init(extra: Msg = {}): Msg {
  return { type: 'system', subtype: 'init', session_id: SESSION, cwd: '/x', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], mcp_servers: [{ name: 'projdb', status: 'connected' }], model: 'claude-test', permissionMode: 'plan', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.302', output_style: 'default', skills: [], plugins: [], uuid: uid(), ...extra };
}

export function stream(event: Msg, parent: string | null = null): Msg {
  return { type: 'stream_event', event, parent_tool_use_id: parent, session_id: SESSION, uuid: uid() };
}

/** 글을 조각으로 흘린 뒤 완성 메시지까지 (실제 CLI --include-partial-messages 순서) */
export function textMessage(msgId: string, text: string, chunk = 4): Msg[] {
  const out: Msg[] = [stream({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, usage: {} } }), stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })];
  for (let i = 0; i < text.length; i += chunk) out.push(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } }));
  out.push(stream({ type: 'content_block_stop', index: 0 }));
  out.push(assistant(msgId, [{ type: 'text', text }]));
  out.push(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }));
  out.push(stream({ type: 'message_stop' }));
  return out;
}

export function assistant(msgId: string, content: Msg[], extra: Msg = {}): Msg {
  return { type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason: null, usage: {} }, parent_tool_use_id: null, session_id: SESSION, uuid: uid(), ...extra };
}

export function toolUse(id: string, name: string, input: Record<string, unknown>): Msg {
  return { type: 'tool_use', id, name, input };
}

export function toolResult(id: string, content: string, opts: { isError?: boolean; structured?: unknown } = {}): Msg {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(opts.isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: uid(),
    ...(opts.structured !== undefined ? { tool_use_result: opts.structured } : {}),
  };
}

export function result(extra: Msg = {}): Msg {
  return { type: 'result', subtype: 'success', is_error: false, duration_ms: 100, duration_api_ms: 80, num_turns: 1, result: '', stop_reason: 'end_turn', total_cost_usd: 0.01, usage: {}, modelUsage: {}, permission_denials: [], session_id: SESSION, uuid: uid(), ...extra };
}
