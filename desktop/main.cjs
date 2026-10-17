// 프로젝트 분석 시스템 데스크톱 앱 (Electron 메인 프로세스)
// 화면은 app/index.html (웹 빌드와 같은 코드), 폴더 읽기·저장만 여기서 처리한다.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

// 파일 목록만 세고 내용은 읽지 않는 무거운 폴더 (분석 엔진도 제외 규칙으로 뺀다)
const COUNT_ONLY = new Set(['.git', '.svn', '.hg', 'node_modules', 'bower_components', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', '.idea', 'vendor', '__pycache__', '.venv', 'venv']);
const MAX_ENTRIES = 300000;

/** 폴더를 돌며 {path, size} 목록. path는 '폴더이름/상대경로' */
async function walk(root) {
  const name = path.basename(root);
  const files = [];
  async function rec(dir, rel, countOnly) {
    if (files.length >= MAX_ENTRIES) return;
    let entries;
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
        await rec(abs, r, countOnly || COUNT_ONLY.has(e.name));
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

function resolveInside(root, rel) {
  // rel은 '폴더이름/…' 형식: 첫 조각(폴더 이름)을 떼고 root 아래로 제한
  const parts = rel.split('/').slice(1);
  const abs = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('폴더 밖 파일은 읽을 수 없습니다');
  return abs;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: '프로젝트 분석 시스템',
    backgroundColor: '#F4F6F8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r' && input.shift) win.webContents.reloadIgnoringCache();
  });
}

ipcMain.handle('pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: '분석할 프로젝트 폴더 선택', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return walk(r.filePaths[0]);
});

ipcMain.handle('walk', async (_e, root) => {
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) return null;
  return walk(root);
});

ipcMain.handle('read-file', async (_e, root, rel) => {
  const buf = await fsp.readFile(resolveInside(root, rel));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

ipcMain.handle('read-files', async (_e, root, rels) => {
  const out = [];
  for (const rel of rels) {
    try {
      const buf = await fsp.readFile(resolveInside(root, rel));
      out.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } catch {
      out.push(null);
    }
  }
  return out;
});

ipcMain.handle('save-file', async (e, defaultName, text) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ext = path.extname(defaultName).slice(1) || 'json';
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return false;
  await fsp.writeFile(r.filePath, text, 'utf8');
  return r.filePath;
});

ipcMain.handle('open-text-file', async (e, exts) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '파일', extensions: exts && exts.length ? exts : ['json'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), text: await fsp.readFile(p, 'utf8') };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
