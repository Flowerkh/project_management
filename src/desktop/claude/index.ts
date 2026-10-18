// Claude 연동 (fork C가 채움): CLI 찾기·연결 확인·설정·대화(Agent SDK)·DB 조회 도구
import { handle } from '../ipc';

export function register(): void {
  // 임시: 연동 꺼짐 상태만 알려 준다
  handle('claude.status', () => ({ state: 'off', checkedAt: new Date().toISOString(), message: '아직 준비되지 않았습니다' }));
  handle('claude.config.get', () => ({ enabled: false, authMode: 'login', hasApiKey: false, shellAllow: [], aiSummary: false }));
  handle('claude.list', () => []);
}
