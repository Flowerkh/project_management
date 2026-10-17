// 브라우저(Edge·Chrome) 구현: 폴더 선택은 <input webkitdirectory>, 끌어다 놓기는 webkitGetAsEntry.
// 파일 내용은 필요할 때만 읽는다(read()).
import type { FolderFile, LoadedFolder, Platform } from './types';
import { readZip } from './zip';

function fileToFolderFile(file: File, path: string): FolderFile {
  return {
    path,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

/** webkitRelativePath = "root/a/b.txt" → { root, path: "a/b.txt" } */
function splitRoot(rel: string): { root: string; path: string } {
  const p = rel.replace(/\\/g, '/');
  const i = p.indexOf('/');
  return i < 0 ? { root: '', path: p } : { root: p.slice(0, i), path: p.slice(i + 1) };
}

function pickWithInput(setup: (input: HTMLInputElement) => void): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    setup(input);
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    let settled = false;
    const done = (v: FileList | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => done(input.files && input.files.length ? input.files : null));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

export function folderFromFileList(list: FileList | File[]): LoadedFolder | null {
  const arr = Array.from(list);
  if (!arr.length) return null;
  let root = '';
  const files: FolderFile[] = [];
  for (const f of arr) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const s = splitRoot(rel);
    if (!root) root = s.root;
    files.push(fileToFolderFile(f, s.path || f.name));
  }
  return { name: root || arr[0].name, files };
}

// ------------------------------------------------------------------ 끌어다 놓기

type AnyEntry = FileSystemEntry & { isFile: boolean; isDirectory: boolean };

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const reader = dir.createReader();
    const out: FileSystemEntry[] = [];
    const step = () =>
      reader.readEntries(
        (batch) => {
          if (!batch.length) resolve(out);
          else {
            out.push(...batch);
            step();
          }
        },
        () => resolve(out),
      );
    step();
  });
}

function entryFile(e: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => e.file((f) => resolve(f), () => resolve(null)));
}

async function walk(entry: AnyEntry, prefix: string, out: FolderFile[], counter: { skipped: number }): Promise<void> {
  if (entry.isFile) {
    const f = await entryFile(entry as unknown as FileSystemFileEntry);
    if (f) out.push(fileToFolderFile(f, prefix + entry.name));
    else counter.skipped++;
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry as unknown as FileSystemDirectoryEntry);
    for (const c of children) await walk(c as AnyEntry, `${prefix}${entry.name}/`, out, counter);
  }
}

export async function folderFromDrop(dt: DataTransfer): Promise<LoadedFolder | null> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean) as AnyEntry[];
  // 폴더 하나
  if (entries.length === 1 && entries[0].isDirectory) {
    const out: FolderFile[] = [];
    const counter = { skipped: 0 };
    const dir = entries[0];
    const children = await readAllEntries(dir as unknown as FileSystemDirectoryEntry);
    for (const c of children) await walk(c as AnyEntry, '', out, counter);
    return { name: dir.name, files: out, skipped: counter.skipped };
  }
  // ZIP 하나
  const files = Array.from(dt.files ?? []);
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) return readZip(files[0]);
  // 여러 항목: 가상의 최상위 폴더로 묶음
  if (entries.length > 1) {
    const out: FolderFile[] = [];
    const counter = { skipped: 0 };
    for (const e of entries) await walk(e, '', out, counter);
    return out.length ? { name: '불러온 항목', files: out, skipped: counter.skipped } : null;
  }
  return null;
}

export const browserPlatform: Platform = {
  kind: 'browser',
  async pickFolder() {
    const list = await pickWithInput((input) => {
      input.multiple = true;
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.setAttribute('webkitdirectory', '');
    });
    return list ? folderFromFileList(list) : null;
  },
  fromDrop: folderFromDrop,
  async saveFile(name, text) {
    const blob = new Blob([text], { type: name.endsWith('.json') ? 'application/json' : 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
  async openTextFile(accept) {
    const list = await pickWithInput((input) => {
      input.accept = accept;
    });
    if (!list) return null;
    const f = list[0];
    return { name: f.name, text: await f.text() };
  },
};

/** ZIP 파일 하나를 폴더처럼 열기 (폴더 선택 창에서 ZIP을 고를 때) */
export async function pickZip(): Promise<LoadedFolder | null> {
  const list = await pickWithInput((input) => {
    input.accept = '.zip';
  });
  if (!list) return null;
  return readZip(list[0]);
}
