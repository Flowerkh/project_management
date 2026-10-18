// DB 연결·조회·쿼리 카드·메뉴 읽기 (fork D가 채움)
import { handle } from '../ipc';

export function register(): void {
  handle('db.list', () => []);
  handle('db.readMenu', () => ({ enabled: false, rows: [] }));
}
