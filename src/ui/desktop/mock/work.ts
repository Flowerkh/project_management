// 미리보기: 작업 사본·변경·형상관리·작업 이력 (fork V가 채움)
import type { MockHandler, MockKit } from './index';

export function workMocks(_kit: MockKit): Record<string, MockHandler> {
  return {
    'history.list': () => [],
  };
}
