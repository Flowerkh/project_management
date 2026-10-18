// 미리보기: Claude 연동 (fork C가 채움)
import type { MockHandler, MockKit } from './index';

export function claudeMocks(_kit: MockKit): Record<string, MockHandler> {
  return {
    'claude.status': () => ({ state: 'on', version: '2.1.302', cliPath: 'C:\\Users\\hong\\.local\\bin\\claude.exe', authLabel: 'Claude Code 로그인', checkedAt: new Date().toISOString() }),
    'claude.config.get': () => ({ enabled: true, authMode: 'login', hasApiKey: false, shellAllow: ['mvn -q compile'], aiSummary: false }),
    'claude.list': () => [],
  };
}
