// 프로젝트 분석 시스템 데스크톱 앱 (Electron 메인 프로세스)
// 화면은 app/index.html (웹 빌드와 같은 코드). 여기서는 폴더 읽기·저장과 데스크톱 기능(Claude·형상관리·작업 이력·DB)을 처리한다.
// esbuild로 desktop/main.mjs 하나로 묶는다 (scripts/build-desktop.mjs).
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEAVY_DIRS, isEmptyDir, MAX_ENTRIES, resolveInside } from './fsutil';
import { host, setHost } from './host';
import { addEventSink, dispatchEnvelope, handle, shutdownAll } from './ipc';
import { registerAll } from './modules';

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 폴더 읽기 (분석용)

interface WalkResult {
  root: string;
  name: string;
  /** '폴더이름/상대경로' */
  files: { path: string; size: number }[];
  truncated: boolean;
}

/** 폴더를 돌며 {path, size} 목록. path는 '폴더이름/상대경로'. 무거운 폴더는 크기를 재지 않는다 */
async function walk(root: string): Promise<WalkResult> {
  const name = path.basename(root);
  const files: { path: string; size: number }[] = [];
  async function rec(dir: string, rel: string, countOnly: boolean): Promise<void> {
    if (files.length >= MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_ENTRIES) return;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await rec(abs, r, countOnly || HEAVY_DIRS.has(e.name));
      } else if (e.isFile()) {
        let size = 0;
        if (!countOnly) {
          try {
            size = (await fsp.stat(abs)).size;
          } catch {
            size = 0;
          }
        }
        files.push({ path: `${name}/${r}`, size });
      }
    }
  }
  await rec(root, '', false);
  return { root, name, files, truncated: files.length >= MAX_ENTRIES };
}

/** '폴더이름/…' 형식의 rel을 root 아래 절대 경로로 */
function resolveWalkPath(root: string, rel: string): string {
  return resolveInside(root, rel.split('/').slice(1).join('/'));
}

// ------------------------------------------------------------------ 창

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: '프로젝트 분석 시스템',
    backgroundColor: '#F4F6F8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(path.join(here, 'app', 'index.html'));
  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r' && input.shift) win.webContents.reloadIgnoringCache();
  });
}

function focusedWindow(sender?: Electron.WebContents): BrowserWindow | undefined {
  return (sender && BrowserWindow.fromWebContents(sender)) || mainWindow || BrowserWindow.getAllWindows()[0];
}

// ------------------------------------------------------------------ 분석용 IPC (2단계부터 있던 것)

ipcMain.handle('pick-folder', async (e) => {
  const win = focusedWindow(e.sender);
  const r = win
    ? await dialog.showOpenDialog(win, { title: '분석할 프로젝트 폴더 선택', properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ title: '분석할 프로젝트 폴더 선택', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return walk(r.filePaths[0]);
});

ipcMain.handle('walk', async (_e, root: string) => {
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) return null;
  return walk(root);
});

ipcMain.handle('read-file', async (_e, root: string, rel: string) => {
  const buf = await fsp.readFile(resolveWalkPath(root, rel));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

ipcMain.handle('read-files', async (_e, root: string, rels: string[]) => {
  const out: (Uint8Array | null)[] = [];
  for (const rel of rels) {
    try {
      const buf = await fsp.readFile(resolveWalkPath(root, rel));
      out.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } catch {
      out.push(null);
    }
  }
  return out;
});

ipcMain.handle('save-file', async (e, defaultName: string, text: string) => {
  const win = focusedWindow(e.sender);
  const ext = path.extname(defaultName).slice(1) || 'json';
  const opts = { defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return false;
  await fsp.writeFile(r.filePath, text, 'utf8');
  return r.filePath;
});

ipcMain.handle('open-text-file', async (e, exts: string[]) => {
  const win = focusedWindow(e.sender);
  const opts = { properties: ['openFile' as const], filters: [{ name: '파일', extensions: exts && exts.length ? exts : ['json'] }] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), text: await fsp.readFile(p, 'utf8') };
});

// ------------------------------------------------------------------ 데스크톱 기능 IPC (3단계)

ipcMain.handle('desktop:invoke', (_e, channel: string, args: unknown[]) => dispatchEnvelope(String(channel), Array.isArray(args) ? args : []));

function setupHost(): void {
  setHost({
    dataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    platform: process.platform,
    async openPath(p) {
      // 폴더만 연다 (파일을 열면 실행될 수 있으므로)
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isDirectory()) return '폴더를 찾을 수 없습니다';
      return shell.openPath(p);
    },
    async openExternal(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('웹 주소만 열 수 있습니다');
      await shell.openExternal(url);
    },
    async saveFile(defaultName, content, filters) {
      const win = focusedWindow();
      const ext = path.extname(defaultName).slice(1) || 'txt';
      const opts = { defaultPath: defaultName, filters: filters ?? [{ name: ext.toUpperCase(), extensions: [ext] }] };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return false;
      await fsp.writeFile(r.filePath, content);
      return r.filePath;
    },
    async pickFolder(title) {
      const win = focusedWindow();
      const opts = { title: title ?? '폴더 선택', properties: ['openDirectory' as const, 'createDirectory' as const] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    async pickFile(title, filters) {
      const win = focusedWindow();
      const opts = { title: title ?? '파일 선택', properties: ['openFile' as const], filters };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    encrypt(text) {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(text);
      // Linux 시험 환경(키링 없음)에서만: PA_E2E=1이면 표시만 바꿔 저장 (Windows는 항상 DPAPI 사용)
      if (process.env.PA_E2E === '1') return Buffer.from(`e2e:${text}`, 'utf8');
      return null;
    },
    decrypt(data) {
      if (process.env.PA_E2E === '1' && data.subarray(0, 4).toString('utf8') === 'e2e:') return data.subarray(4).toString('utf8');
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(data);
      } catch {
        return null;
      }
    },
  });
}

function registerAppChannels(): void {
  handle('app.info', () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData') }));
  handle('app.openPath', (p) => host().openPath(String(p)));
  handle('app.openExternal', (url) => host().openExternal(String(url)));
  handle('app.pickFolder', async (title) => {
    const p = await host().pickFolder(title);
    if (!p) return null;
    return { path: p, empty: await isEmptyDir(p) };
  });
}

// ------------------------------------------------------------------ 시작·종료

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    setupHost();
    registerAppChannels();
    registerAll();
    addEventSink((ev) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('desktop:event', ev);
      }
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    shutdownAll().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
