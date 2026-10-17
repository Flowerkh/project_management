// 화면(렌더러)에 폴더 읽기·저장 기능만 노출한다. Node 기능은 넘기지 않는다.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('__ELECTRON__', {
  kind: 'electron',
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  walk: (root) => ipcRenderer.invoke('walk', root),
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  readFile: (root, rel) => ipcRenderer.invoke('read-file', root, rel),
  readFiles: (root, rels) => ipcRenderer.invoke('read-files', root, rels),
  saveFile: (name, text) => ipcRenderer.invoke('save-file', name, text),
  openTextFile: (exts) => ipcRenderer.invoke('open-text-file', exts),
});
