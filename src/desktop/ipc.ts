// 채널 등록·호출과 이벤트 보내기. electron에 의존하지 않는다 (main.ts가 ipcMain에 연결).
import type { Args, Channel, DesktopEvent, Ret } from '../shared/desktop-api';

/** 화면에 그대로 보여 줄 수 있는 오류. code로 화면이 분기한다 (예: 'conflict', 'auth', 'readonly') */
export class DesktopError extends Error {
  code: string;
  data?: unknown;
  constructor(message: string, code = 'error', data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type Handler<C extends Channel> = (...args: Args<C>) => Ret<C> | Promise<Ret<C>>;

const handlers = new Map<string, (...args: unknown[]) => unknown>();

export function handle<C extends Channel>(channel: C, fn: Handler<C>): void {
  handlers.set(channel, fn as (...args: unknown[]) => unknown);
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel);
}

/** 등록한 처리기를 부른다. 테스트에서도 이것으로 채널을 시험한다 */
export async function call<C extends Channel>(channel: C, ...args: Args<C>): Promise<Ret<C>> {
  return (await dispatch(channel, args)) as Ret<C>;
}

export async function dispatch(channel: string, args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new DesktopError(`이 기능은 아직 준비되지 않았습니다 (${channel})`, 'unavailable');
  return fn(...(Array.isArray(args) ? args : []));
}

/** ipcMain 결과 봉투: Electron은 오류 객체의 code 등을 잃으므로 감싸서 보낸다 */
export type Envelope = { ok: true; value: unknown } | { ok: false; error: { message: string; code: string; data?: unknown } };

export async function dispatchEnvelope(channel: string, args: unknown[]): Promise<Envelope> {
  try {
    return { ok: true, value: await dispatch(channel, args) };
  } catch (e) {
    const err = e as Partial<DesktopError> & Error;
    return { ok: false, error: { message: err?.message || String(e), code: typeof err?.code === 'string' ? err.code : 'error', data: err?.data } };
  }
}

// ------------------------------------------------------------------ 이벤트

type Sink = (ev: DesktopEvent) => void;
const sinks = new Set<Sink>();

/** main.ts가 창으로 보내는 sink를 단다. 테스트는 이벤트를 모으는 sink를 단다 */
export function addEventSink(fn: Sink): () => void {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

export function emit(ev: DesktopEvent): void {
  for (const s of sinks) {
    try {
      s(ev);
    } catch {
      // 창이 닫히는 중 등
    }
  }
}

// ------------------------------------------------------------------ 종료 정리

const shutdowns: (() => unknown)[] = [];

/** 앱을 끝낼 때 부를 정리 작업 (Claude 프로세스 끄기, DB 연결 닫기 등) */
export function onShutdown(fn: () => unknown): void {
  shutdowns.push(fn);
}

export async function shutdownAll(timeoutMs = 3000): Promise<void> {
  const all = shutdowns.splice(0).map(async (fn) => {
    try {
      await fn();
    } catch {
      // 무시
    }
  });
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, timeoutMs))]);
}
