// ZIP을 폴더처럼 읽기. 중앙 디렉터리만 먼저 읽고, 파일 내용은 read() 할 때 푼다.
// 압축 방식: 저장(0)·deflate(8). 이름이 UTF-8이 아니면 CP949(EUC-KR)로 해석한다.
import type { FolderFile, LoadedFolder } from './types';

const utf8 = new TextDecoder('utf-8', { fatal: true });
let cp949: TextDecoder | null = null;
try {
  cp949 = new TextDecoder('euc-kr');
} catch {
  cp949 = null;
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    return cp949 ? cp949.decode(bytes) : new TextDecoder().decode(bytes);
  }
}

async function slice(file: Blob, start: number, end: number): Promise<DataView> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error('이 브라우저는 ZIP 압축 풀기를 지원하지 않습니다.');
  const stream = new Blob([data]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CdEntry {
  name: string;
  method: number;
  flags: number;
  csize: number;
  usize: number;
  offset: number;
}

export async function readZip(file: File): Promise<LoadedFolder> {
  const size = file.size;
  const tailLen = Math.min(size, 65536 + 22);
  const tail = await slice(file, size - tailLen, size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 파일을 열 수 없습니다. 파일이 손상되었을 수 있습니다.');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  // ZIP64
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
      const z64off = Number(tail.getBigUint64(loc + 8, true));
      const z = await slice(file, z64off, z64off + 56);
      if (z.getUint32(0, true) === 0x06064b50) {
        count = Number(z.getBigUint64(32, true));
        cdSize = Number(z.getBigUint64(40, true));
        cdOffset = Number(z.getBigUint64(48, true));
      }
    }
  }
  const cd = await slice(file, cdOffset, cdOffset + cdSize);
  const entries: CdEntry[] = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.byteLength; k++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let usize = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true);
    const xlen = cd.getUint16(p + 30, true);
    const clen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen);
    const name = decodeName(nameBytes, (flags & 0x800) !== 0).replace(/\\/g, '/');
    // ZIP64 extra
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) {
          usize = Number(cd.getBigUint64(q, true));
          q += 8;
        }
        if (csize === 0xffffffff) {
          csize = Number(cd.getBigUint64(q, true));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(cd.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    p = xend + clen;
    if (name.endsWith('/')) continue;
    entries.push({ name, method, flags, csize, usize, offset });
  }

  // 공통 최상위 폴더
  let root = '';
  const firsts = new Set(entries.map((e) => (e.name.includes('/') ? e.name.slice(0, e.name.indexOf('/')) : '')));
  if (firsts.size === 1 && !firsts.has('')) root = [...firsts][0];
  const strip = root ? root.length + 1 : 0;
  let skipped = 0;
  const files: FolderFile[] = [];
  for (const e of entries) {
    if (e.flags & 1 || (e.method !== 0 && e.method !== 8)) {
      skipped++;
      continue;
    }
    files.push({
      path: e.name.slice(strip),
      size: e.usize,
      read: async () => {
        const h = await slice(file, e.offset, e.offset + 30);
        if (h.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP 항목 머리글이 잘못되었습니다.');
        const start = e.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
        const data = new Uint8Array(await file.slice(start, start + e.csize).arrayBuffer());
        return e.method === 0 ? data : inflateRaw(data);
      },
    });
  }
  return { name: root || file.name.replace(/\.zip$/i, ''), files, skipped };
}
