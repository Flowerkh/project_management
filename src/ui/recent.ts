// 최근 프로젝트: 분석 결과를 IndexedDB에 저장해 다시 분석하지 않고 연다.
// 저장소를 쓸 수 없는 환경(사생활 보호 창 등)에서는 조용히 건너뛴다.
import type { AnalysisResult } from '../engine/types';

const DB = 'project-analyzer';
const STORE = 'recent';
const KEEP = 8;

export interface RecentItem {
  key: string;
  name: string;
  analyzedAt: string;
  analyzedFiles: number;
  savedAt: number;
  /** 데스크톱 앱: 분석한 폴더의 절대 경로 (다시 열 때 원본 폴더를 자동으로 연결) */
  root?: string;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      const req = fn(s);
      t.oncomplete = () => resolve(req ? (req.result as T) : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function listRecent(): Promise<RecentItem[]> {
  const db = await open();
  if (!db) return [];
  const all = (await tx<RecentItem[]>(db, 'readonly', (s) => s.getAll())) ?? [];
  db.close();
  return all
    .map(({ key, name, analyzedAt, analyzedFiles, savedAt, root }) => ({ key, name, analyzedAt, analyzedFiles, savedAt, ...(root ? { root } : {}) }))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, KEEP);
}

export async function saveRecent(result: AnalysisResult, root?: string): Promise<void> {
  const db = await open();
  if (!db) return;
  // 데스크톱에서 폴더로 연 프로젝트는 경로로 구분 (이름이 같은 다른 폴더)
  const key = root ? `${result.project.name}|${root}` : result.project.name;
  await tx(db, 'readwrite', (s) =>
    s.put({ key, name: result.project.name, analyzedAt: result.project.analyzedAt, analyzedFiles: result.stats.analyzedFiles, savedAt: Date.now(), result, ...(root ? { root } : {}) }),
  );
  // 오래된 항목 정리
  const all = (await tx<{ key: string; savedAt: number }[]>(db, 'readonly', (s) => s.getAll())) ?? [];
  const old = all.sort((a, b) => b.savedAt - a.savedAt).slice(KEEP);
  if (old.length) await tx(db, 'readwrite', (s) => {
    for (const o of old) s.delete(o.key);
  });
  db.close();
}

export async function loadRecent(key: string): Promise<AnalysisResult | null> {
  const db = await open();
  if (!db) return null;
  const v = await tx<{ result: AnalysisResult }>(db, 'readonly', (s) => s.get(key));
  db.close();
  return v?.result ?? null;
}

export async function removeRecent(key: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.delete(key));
  db.close();
}
