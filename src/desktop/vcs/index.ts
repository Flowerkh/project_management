// 형상관리 연결: Git·SVN·없음을 같은 규격(types.ts VcsAdapter)으로. 새 도구는 규격을 구현해 adapters에 더한다.
// 채널: vcs.detect (POP-04 형상관리), vcs.check (POP-04 연결 확인)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VcsCheck, VcsInfo } from '../../shared/desktop-api';
import { msg } from '../../ui/desktop/messages';
import { handle } from '../ipc';
import { checkRoot } from '../project';
import { rootKey, workDir } from '../store';
import { ToolError } from './exec';
import { gitAdapter } from './git';
import { noneAdapter } from './none';
import { svnAdapter } from './svn';
import type { VcsAdapter, VcsKind } from './types';

export type { CommitFile, VcsAdapter, VcsKind } from './types';
export { isDirtyPath } from './types';

export const adapters: Record<VcsKind, VcsAdapter> = { git: gitAdapter, svn: svnAdapter, none: noneAdapter };

/** 프로젝트 폴더에서 위로 올라가며 가장 가까운 .git·.svn 표식 (같은 폴더에 둘 다 있으면 Git) */
export function findMarker(root: string): VcsKind {
  let dir = path.resolve(root);
  for (let i = 0; i < 64; i++) {
    for (const a of [gitAdapter, svnAdapter]) {
      if (a.marker && fs.existsSync(path.join(dir, a.marker))) return a.kind;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'none';
}

const cache = new Map<string, { at: number; p: Promise<VcsInfo> }>();

/** 형상관리 감지 (3초 동안 같은 결과를 다시 씀, fresh면 새로) */
export async function detectVcs(root: string, fresh = false): Promise<{ adapter: VcsAdapter; info: VcsInfo }> {
  const kind = findMarker(root);
  const adapter = adapters[kind];
  const key = `${kind}:${rootKey(root)}`;
  let c = cache.get(key);
  if (fresh || !c || Date.now() - c.at > 3000) {
    const p = adapter.detect(root).catch((e: unknown): VcsInfo => ({
      kind,
      toolFound: !(e instanceof ToolError && e.kind === 'missing'),
      error: e instanceof Error ? e.message : String(e),
    }));
    c = { at: Date.now(), p };
    cache.set(key, c);
  }
  return { adapter, info: await c.p };
}

/** 커밋할 수 있는 상태인지 (도구가 있고 저장소를 읽을 수 있음) */
export function canCommit(adapter: VcsAdapter, info: VcsInfo): boolean {
  return adapter.canCommit && info.toolFound && !info.error;
}

async function freeSpace(p: string): Promise<VcsCheck['space']> {
  try {
    const st = await fsp.statfs(p);
    const free = Number(st.bavail) * Number(st.bsize);
    return { ok: free >= 1024 * 1024 * 1024, freeBytes: free, path: p };
  } catch {
    return { ok: true, freeBytes: 0, path: p };
  }
}

/** POP-04 [연결 확인]: 원격 저장소 연결(최대 20초)과 작업 사본 공간 */
export async function checkVcs(root: string): Promise<VcsCheck> {
  const { adapter, info } = await detectVcs(root, true);
  const space = await freeSpace(workDir());
  if (info.kind === 'none') return { space };
  if (!info.toolFound || info.error) return { space, remote: { ok: false, message: info.error ?? `${adapter.label} 명령을 찾지 못했습니다` } };
  try {
    const r = await adapter.check(root, info);
    let remote = r.remote;
    if (remote && !remote.ok && !/설정되어 있지 않습니다/.test(remote.message)) {
      remote = { ok: false, message: `${msg('MSG-35', { 도구: adapter.label })} (사유: ${remote.message})` };
    }
    return { space, remote, login: r.login };
  } catch (e) {
    return { space, remote: { ok: false, message: `${msg('MSG-35', { 도구: adapter.label })} (사유: ${(e as Error).message})` } };
  }
}

export function register(): void {
  handle('vcs.detect', async (root) => (await detectVcs(checkRoot(root), true)).info);
  handle('vcs.check', (root) => checkVcs(checkRoot(root)));
}
