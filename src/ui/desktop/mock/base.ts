// 미리보기: 프로젝트 연결 설정·앱 정보
import { DEFAULT_MASK, DEFAULT_RULES, type ProjectSettings } from '../../../shared/desktop-api';
import type { MockHandler, MockKit } from './index';

export function baseMocks(kit: MockKit): Record<string, MockHandler> {
  const get = (): ProjectSettings => {
    const saved = kit.state.project as Partial<ProjectSettings> | undefined;
    return {
      root: kit.root,
      name: 'shop-admin',
      applyDefaults: { commit: false, push: false },
      dbRules: structuredClone(DEFAULT_RULES),
      maskPatterns: [...DEFAULT_MASK],
      ...saved,
      db: (kit.state.dbList as ProjectSettings['db']) ?? [],
    };
  };
  return {
    'app.info': () => ({ version: '0.3.0-mock', platform: 'win32', userData: 'C:\\Users\\hong\\AppData\\Roaming\\ProjectAnalyzer' }),
    'app.openPath': () => '',
    'app.openExternal': () => undefined,
    'app.pickFolder': () => ({ path: 'C:\\work\\cs-inquiry', empty: true }),
    'project.get': () => get(),
    'project.set': (_root: string, patch: Partial<ProjectSettings>) => {
      kit.state.project = { ...(kit.state.project as object), ...patch };
      return get();
    },
  };
}
