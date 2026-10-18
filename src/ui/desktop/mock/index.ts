// 화면 미리보기용 가짜 데스크톱 기능 (?mock&desk). Electron 없이 브라우저에서 데스크톱 화면을 그려 보고 스크린샷을 찍는다.
// 각 기능 모듈이 자기 채널의 가짜 응답을 mock/<기능>.ts에 둔다.
import type { DesktopEvent } from '../../../shared/desktop-api';
import { baseMocks } from './base';
import { claudeMocks } from './claude';
import { dbMocks } from './db';
import { workMocks } from './work';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockHandler = (...args: any[]) => unknown;

export interface MockKit {
  /** 화면으로 이벤트 보내기 */
  emit(ev: DesktopEvent): void;
  /** 모듈끼리 나눠 쓰는 가짜 상태 */
  state: Record<string, unknown>;
  /** 가짜 프로젝트 폴더 */
  root: string;
  sleep(ms: number): Promise<void>;
}

export const MOCK_ROOT = 'C:\\work\\shop-admin';

export function installDeskMock(): void {
  const listeners = new Set<(ev: unknown) => void>();
  const kit: MockKit = {
    emit: (ev) => {
      for (const l of listeners) l(ev);
    },
    state: {},
    root: MOCK_ROOT,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const handlers: Record<string, MockHandler> = { ...baseMocks(kit), ...workMocks(kit), ...dbMocks(kit), ...claudeMocks(kit) };
  (window as unknown as { __DESK_MOCK__: unknown }).__DESK_MOCK__ = {
    async invoke(channel: string, args: unknown[]) {
      const h = handlers[channel];
      if (!h) return { ok: false, error: { message: `미리보기에 없는 기능입니다 (${channel})`, code: 'unavailable' } };
      try {
        return { ok: true, value: await h(...args) };
      } catch (e) {
        const err = e as Error & { code?: string };
        return { ok: false, error: { message: err.message, code: err.code ?? 'error' } };
      }
    },
    onEvent(fn: (ev: unknown) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
