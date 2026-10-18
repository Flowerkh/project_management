// 미리보기: DB 연결·조회·쿼리 카드 (fork D가 채움)
import type { MockHandler, MockKit } from './index';

export function dbMocks(_kit: MockKit): Record<string, MockHandler> {
  return {
    'db.list': () => [],
    'db.readMenu': () => ({ enabled: false, rows: [] }),
  };
}
