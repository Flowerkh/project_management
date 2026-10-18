// 폴더 돌기·경로 확인 (메인 프로세스 공용)
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 파일 목록만 세고 내용은 읽지 않는 무거운 폴더 (분석 엔진도 제외 규칙으로 뺀다) */
export const HEAVY_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'bower_components', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', '.idea', 'vendor',
  '__pycache__', '.venv', 'venv', '.dart_tool', '.next', '.nuxt', 'Pods', '.pub-cache',
]);
export const MAX_ENTRIES = 300000;

export interface WalkEntry {
  /** root 기준 상대 경로 ('/' 구분) */
  rel: string;
  size: number;
  mtimeMs: number;
  /** HEAVY_DIRS 안의 파일 (크기를 재지 않음) */
  heavy: boolean;
}

/**
 * 폴더를 돈다. 심볼릭 링크는 따라가지 않는다.
 * skipHeavy면 HEAVY_DIRS는 아예 들어가지 않는다 (작업 사본 만들 때).
 */
export async function walkDir(root: string, opts: { skipHeavy?: boolean; stat?: boolean; max?: number } = {}): Promise<{ files: WalkEntry[]; truncated: boolean }> {
  const files: WalkEntry[] = [];
  const max = opts.max ?? MAX_ENTRIES;
  async function rec(dir: string, rel: string, heavy: boolean): Promise<void> {
    if (files.length >= max) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= max) return;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        const h = heavy || HEAVY_DIRS.has(e.name);
        if (h && opts.skipHeavy) continue;
        await rec(abs, r, h);
      } else if (e.isFile()) {
        let size = 0;
        let mtimeMs = 0;
        if (!heavy && opts.stat !== false) {
          try {
            const st = await fsp.stat(abs);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            // 읽을 수 없는 파일
          }
        }
        files.push({ rel: r, size, mtimeMs, heavy });
      }
    }
  }
  await rec(root, '', false);
  return { files, truncated: files.length >= max };
}

/** rel(‘/’ 구분 상대 경로)을 root 아래 절대 경로로. root 밖이면 오류 */
export function resolveInside(root: string, rel: string): string {
  const parts = rel.split(/[\\/]+/).filter((x) => x && x !== '.');
  const abs = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('폴더 밖 파일은 다룰 수 없습니다');
  return abs;
}

/** 절대 경로 → root 기준 상대 경로('/' 구분). root 밖이면 null */
export function relInside(root: string, abs: string): string | null {
  const r = path.relative(path.resolve(root), path.resolve(abs));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return r === '' ? '' : null;
  return r.split(path.sep).join('/');
}

export async function isEmptyDir(p: string): Promise<boolean> {
  try {
    const list = await fsp.readdir(p);
    return list.filter((n) => n !== '.DS_Store' && n !== 'Thumbs.db' && n !== 'desktop.ini').length === 0;
  } catch {
    return false;
  }
}
