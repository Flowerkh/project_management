// Electron(데스크톱) 구현: preload가 노출한 window.__ELECTRON__ 으로 폴더를 읽는다.
// 파일 내용은 필요할 때 메인 프로세스에서 읽어 온다(read()).
import { browserPlatform } from './browser';
import type { FolderFile, LoadedFolder, Platform } from './types';

interface WalkResult {
  root: string;
  name: string;
  /** '폴더이름/상대경로' */
  files: { path: string; size: number }[];
  truncated?: boolean;
}

export interface ElectronBridge {
  kind: 'electron';
  pickFolder(): Promise<WalkResult | null>;
  walk(root: string): Promise<WalkResult | null>;
  pathOf(file: File): string;
  readFile(root: string, rel: string): Promise<Uint8Array>;
  readFiles(root: string, rels: string[]): Promise<(Uint8Array | null)[]>;
  saveFile(name: string, text: string): Promise<string | false>;
  openTextFile(exts: string[]): Promise<{ name: string; text: string } | null>;
  /** 3단계 데스크톱 기능 (src/shared/desktop-api.ts). 결과는 봉투로 온다 */
  invoke?(channel: string, args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string; code: string; data?: unknown } }>;
  onEvent?(fn: (ev: unknown) => void): () => void;
}

declare global {
  interface Window {
    __ELECTRON__?: ElectronBridge;
  }
}

function toFolder(bridge: ElectronBridge, w: WalkResult): LoadedFolder {
  const files: FolderFile[] = w.files.map((f) => {
    const rel = f.path.slice(f.path.indexOf('/') + 1);
    return { path: rel, size: f.size, read: () => bridge.readFile(w.root, f.path) };
  });
  return { name: w.name, root: w.root, files };
}

/** 데스크톱 앱에서 폴더를 다시 읽는다 (적용 후 다시 분석, 최근 프로젝트 다시 열기) */
export async function walkFolder(root: string): Promise<LoadedFolder | null> {
  const bridge = typeof window !== 'undefined' ? window.__ELECTRON__ : undefined;
  if (!bridge) return null;
  const w = await bridge.walk(root);
  return w ? toFolder(bridge, w) : null;
}

export function createElectronPlatform(bridge: ElectronBridge): Platform {
  return {
    kind: 'electron',
    async pickFolder() {
      const w = await bridge.pickFolder();
      return w ? toFolder(bridge, w) : null;
    },
    async fromDrop(dt) {
      const items = [...(dt.files ?? [])];
      if (items.length === 1) {
        const p = bridge.pathOf(items[0]);
        if (p) {
          const w = await bridge.walk(p);
          if (w) return toFolder(bridge, w);
        }
      }
      // ZIP 등 폴더가 아닌 것은 브라우저 구현으로
      return browserPlatform.fromDrop(dt);
    },
    async saveFile(name, text) {
      await bridge.saveFile(name, text);
    },
    async openTextFile(accept) {
      const exts = accept
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.startsWith('.'))
        .map((x) => x.slice(1));
      return bridge.openTextFile(exts.length ? exts : ['json']);
    },
  };
}
