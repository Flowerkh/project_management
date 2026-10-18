// 형상관리 없음: 감지 결과만 돌려주고 커밋·푸시는 하지 않는다 (적용은 그대로 됨)
import type { VcsAdapter } from './types';

export const noneAdapter: VcsAdapter = {
  kind: 'none',
  label: '없음',
  canCommit: false,
  canPush: false,
  async detect() {
    return { kind: 'none', toolFound: true };
  },
  async check() {
    return {};
  },
  async status() {
    return new Map<string, string>();
  },
  async commit() {
    throw new Error('형상관리가 없는 폴더라 커밋할 수 없습니다');
  },
  async push() {
    throw new Error('형상관리가 없는 폴더라 푸시할 수 없습니다');
  },
};
