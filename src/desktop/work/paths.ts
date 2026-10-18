// 원본 폴더에 쓸 때 경로 확인: 프로젝트 폴더 안이어야 하고, 심볼릭 링크로 밖을 가리키면 안 된다.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../fsutil';

export function safeTarget(root: string, rel: string): string {
  const abs = resolveInside(root, rel);
  const realRoot = fs.realpathSync(root);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error(`프로젝트 폴더 밖을 가리키는 경로라 쓸 수 없습니다: ${rel}`);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(abs);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) throw new Error(`심볼릭 링크 파일은 쓸 수 없습니다: ${rel}`);
  return abs;
}
