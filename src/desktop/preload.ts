// 화면(렌더러)에 폴더 읽기·저장과 데스크톱 기능 호출만 노출한다. Node 기능은 넘기지 않는다.
// esbuild로 desktop/preload.cjs (CommonJS)로 묶는다: sandbox 창의 preload는 CommonJS여야 한다.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('__ELECTRON__', {
  kind: 'electron',
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  walk: (root: string) => ipcRenderer.invoke('walk', root),
  pathOf: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  readFile: (root: string, rel: string) => ipcRenderer.invoke('read-file', root, rel),
  readFiles: (root: string, rels: string[]) => ipcRenderer.invoke('read-files', root, rels),
  saveFile: (name: string, text: string) => ipcRenderer.invoke('save-file', name, text),
  openTextFile: (exts: string[]) => ipcRenderer.invoke('open-text-file', exts),
  // 3단계: 데스크톱 기능 (src/shared/desktop-api.ts의 채널)
  invoke: (channel: string, args: unknown[]) => ipcRenderer.invoke('desktop:invoke', channel, args),
  onEvent: (fn: (ev: unknown) => void) => {
    const h = (_e: unknown, ev: unknown) => fn(ev);
    ipcRenderer.on('desktop:event', h);
    return () => {
      ipcRenderer.removeListener('desktop:event', h);
    };
  },
});
