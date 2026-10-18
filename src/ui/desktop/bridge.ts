// 화면 → 데스크톱 메인 프로세스 호출. 브라우저(HTML) 빌드에서는 getDesk()가 null이고 데스크톱 기능을 그리지 않는다.
// 화면 미리보기(?mock&desk)에서는 가짜 구현(mock/index.ts)을 쓴다.
import { useEffect, useRef } from 'preact/hooks';
import type { Args, Channel, DesktopEvent, Ret } from '../../shared/desktop-api';

export class DeskError extends Error {
  code: string;
  data?: unknown;
  constructor(message: string, code = 'error', data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface Desk {
  /** mock이면 true (화면 미리보기) */
  mock: boolean;
  invoke<C extends Channel>(channel: C, ...args: Args<C>): Promise<Ret<C>>;
  /** 메인 프로세스 이벤트 구독. 해제 함수를 돌려준다 */
  on(fn: (ev: DesktopEvent) => void): () => void;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: { message: string; code: string; data?: unknown } };

export interface RawBridge {
  invoke(channel: string, args: unknown[]): Promise<Envelope>;
  onEvent(fn: (ev: unknown) => void): () => void;
}

export function deskFromBridge(b: RawBridge, mock = false): Desk {
  return {
    mock,
    async invoke(channel, ...args) {
      const r = await b.invoke(channel, args as unknown[]);
      if (!r || typeof r !== 'object') throw new DeskError('응답이 올바르지 않습니다');
      if (!r.ok) throw new DeskError(r.error?.message || '오류', r.error?.code || 'error', r.error?.data);
      return r.value as never;
    },
    on(fn) {
      return b.onEvent((ev) => fn(ev as DesktopEvent));
    },
  };
}

let cached: Desk | null | undefined;

declare const __DESK_FEATURES__: boolean | undefined;

/** 데스크톱 기능을 쓸 수 있으면 Desk, 아니면 null */
export function getDesk(): Desk | null {
  if (cached !== undefined) return cached;
  if (typeof __DESK_FEATURES__ !== 'undefined' && !__DESK_FEATURES__) {
    cached = null;
    return cached;
  }
  const w = typeof window !== 'undefined' ? (window as unknown as { __ELECTRON__?: Partial<RawBridge>; __DESK_MOCK__?: RawBridge }) : undefined;
  if (w?.__DESK_MOCK__) cached = deskFromBridge(w.__DESK_MOCK__, true);
  else if (w?.__ELECTRON__?.invoke && w.__ELECTRON__.onEvent) cached = deskFromBridge(w.__ELECTRON__ as RawBridge);
  else cached = null;
  return cached;
}

/** 이벤트 구독 훅. fn은 매 렌더 바뀌어도 된다 */
export function useDeskEvent(desk: Desk | null, fn: (ev: DesktopEvent) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!desk) return;
    return desk.on((ev) => ref.current(ev));
  }, [desk]);
}

/** 오류 문구 꺼내기 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
