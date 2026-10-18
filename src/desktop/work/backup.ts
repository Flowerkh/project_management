// 적용 전·후 파일 보관: <프로젝트 데이터>/backups/<작업 이력 ID>/{before,after}/<상대 경로> + meta.json
// 되돌리기(before로 복원)·변경 보기(before↔after)·되돌리기 불가 판단(after ≠ 지금 원본)에 쓴다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileChange } from '../../shared/desktop-api';
import { resolveInside } from '../fsutil';
import { projectDir, readJson, writeJson } from '../store';

export interface BackupFile {
  path: string;
  status: FileChange['status'];
  /** 적용 전 파일이 있었음 (새 파일이면 false) */
  before: boolean;
  /** 적용 후 파일이 있음 (지운 파일이면 false) */
  after: boolean;
  plus: number;
  minus: number;
}

export interface BackupMeta {
  v: 1;
  id: string;
  at: string;
  files: BackupFile[];
}

export function backupDir(root: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('기록 ID가 올바르지 않습니다');
  return path.join(projectDir(root), 'backups', id);
}

export async function writeBackup(root: string, id: string, items: (BackupFile & { beforeBuf: Buffer | null; afterBuf: Buffer | null })[]): Promise<void> {
  const dir = backupDir(root, id);
  for (const it of items) {
    if (it.beforeBuf) {
      const p = resolveInside(path.join(dir, 'before'), it.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, it.beforeBuf);
    }
    if (it.afterBuf) {
      const p = resolveInside(path.join(dir, 'after'), it.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, it.afterBuf);
    }
  }
  const meta: BackupMeta = {
    v: 1,
    id,
    at: new Date().toISOString(),
    files: items.map(({ path: p, status, before, after, plus, minus }) => ({ path: p, status, before, after, plus, minus })),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
}

export async function readBackupMeta(root: string, id: string): Promise<BackupMeta | null> {
  return readJson<BackupMeta | null>(path.join(backupDir(root, id), 'meta.json'), null);
}

export async function readBackup(root: string, id: string, side: 'before' | 'after', rel: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(resolveInside(path.join(backupDir(root, id), side), rel));
  } catch {
    return null;
  }
}
