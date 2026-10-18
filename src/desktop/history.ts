// 작업 이력 (fork V가 채움)
import { handle } from './ipc';

export function register(): void {
  handle('history.list', () => []);
}
