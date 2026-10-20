// 작업 이력 (SCR-12): 코드 적용·커밋·되돌리기, 쿼리 실행, 운영 조회, Claude의 개발·QA SELECT(CSV에만).
// <프로젝트 데이터>/history.jsonl 에 추가만 한다. 갱신(진행 기록·커밋 결과·되돌림 표시)도 줄을 덧붙이고 읽을 때 합친다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AI_LABEL, ENV_LABEL, type FileChange, type HistoryEntry, type HistoryKind, type RevertResult } from '../shared/desktop-api';
import { resolveInside } from './fsutil';
import { host } from './host';
import { DesktopError, emit, handle } from './ipc';
import { checkRoot } from './project';
import { type HistoryService, need, type NewHistoryEntry, services } from './services';
import { appendJsonl, newId, nowIso, projectDir, readJsonl, withLock } from './store';
import { canCommit, detectVcs } from './vcs/index';
import { readBackup, readBackupMeta, writeBackup } from './work/backup';
import { commitAndPush, commitMessage } from './work/commit';
import { buildHunks } from './work/diff';
import { decodeBytes, sha1 } from './work/encoding';
import { safeTarget } from './work/paths';

type Step = NonNullable<HistoryEntry['steps']>[number];
type Line = { t: 'add'; e: HistoryEntry } | { t: 'set'; id: string; p: Record<string, unknown>; at: string } | { t: 'step'; id: string; s: Step };

function file(root: string): string {
  return path.join(projectDir(root), 'history.jsonl');
}

function checkEntryId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new DesktopError('기록 ID가 올바르지 않습니다', 'invalid');
  return id;
}

interface Loaded {
  size: number;
  mtime: number;
  entries: Map<string, HistoryEntry>;
}

// 읽은 결과를 파일 크기·시각으로 기억한다 (SELECT 기록이 많아도 빠르게). 덧붙인 줄은 기억한 것에 바로 합친다
const cache = new Map<string, Loaded>();

function applyLine(entries: Map<string, HistoryEntry>, l: Line): void {
  if (l.t === 'add' && l.e?.id) entries.set(l.e.id, { ...l.e });
  else if (l.t === 'set') {
    const e = entries.get(l.id);
    if (!e) return;
    for (const [k, v] of Object.entries(l.p ?? {})) {
      if (k === 'id') continue;
      if (v === null) delete (e as unknown as Record<string, unknown>)[k];
      else (e as unknown as Record<string, unknown>)[k] = v;
    }
  } else if (l.t === 'step') {
    const e = entries.get(l.id);
    if (e && l.s) e.steps = [...(e.steps ?? []), l.s];
  }
}

async function readAll(root: string): Promise<Loaded> {
  const f = file(root);
  const st = await fsp.stat(f).catch(() => null);
  if (!st) return { size: 0, mtime: 0, entries: new Map() };
  const c = cache.get(f);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c;
  const entries = new Map<string, HistoryEntry>();
  for (const l of await readJsonl<Line>(f)) applyLine(entries, l);
  const v = { size: st.size, mtime: st.mtimeMs, entries };
  cache.set(f, v);
  return v;
}

function sortDesc(list: HistoryEntry[]): HistoryEntry[] {
  return list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** 한 줄 덧붙이고 기억한 목록에도 합친다. undefined인 값은 null로 남겨 '지움'으로 합친다 */
async function append(root: string, line: Line): Promise<Map<string, HistoryEntry>> {
  const f = file(root);
  const before = await readAll(root);
  const clean = JSON.parse(JSON.stringify(line, (_k, v) => (v === undefined ? null : v))) as Line;
  await appendJsonl(f, clean);
  const st = await fsp.stat(f).catch(() => null);
  const c = cache.get(f);
  if (st && c === before) {
    applyLine(c.entries, clean);
    c.size = st.size;
    c.mtime = st.mtimeMs;
    return c.entries;
  }
  return (await readAll(root)).entries;
}

export const historyService: HistoryService = {
  async list(root) {
    const { entries } = await readAll(root);
    return sortDesc([...entries.values()].map((e) => ({ ...e })));
  },
  async get(root, id) {
    const { entries } = await readAll(root);
    const e = entries.get(id);
    return e ? { ...e } : null;
  },
  async add(root, e: NewHistoryEntry) {
    return withLock(file(root), async () => {
      const { entries } = await readAll(root);
      let id = e.id && /^[A-Za-z0-9_-]{1,64}$/.test(e.id) ? e.id : newId('h');
      while (entries.has(id)) id = newId('h');
      const entry = JSON.parse(JSON.stringify({ ...e, id, at: e.at ?? nowIso() })) as HistoryEntry;
      await append(root, { t: 'add', e: entry });
      emit({ type: 'history.added', root, entry });
      return { ...entry };
    });
  },
  async update(root, id, patch) {
    return withLock(file(root), async () => {
      const { entries } = await readAll(root);
      if (!entries.has(id)) return null;
      const p: Record<string, unknown> = { ...patch };
      delete p.id;
      const e = (await append(root, { t: 'set', id, p, at: nowIso() })).get(id) ?? null;
      if (e) emit({ type: 'history.updated', root, entry: { ...e } });
      return e ? { ...e } : null;
    });
  },
  async addStep(root, id, step) {
    return withLock(file(root), async () => {
      const { entries } = await readAll(root);
      if (!entries.has(id)) return null;
      const s: Step = { at: nowIso(), label: String(step.label).slice(0, 40), ...(step.detail ? { detail: String(step.detail).slice(0, 500) } : {}), ok: !!step.ok };
      const e = (await append(root, { t: 'step', id, s })).get(id) ?? null;
      if (e) emit({ type: 'history.updated', root, entry: { ...e } });
      return e ? { ...e } : null;
    });
  },
};

// ------------------------------------------------------------------ 변경 보기 (적용 전 ↔ 적용 후)

function changeFrom(rel: string, status: FileChange['status'], before: Buffer | null, after: Buffer | null): FileChange {
  const b = before ? decodeBytes(before, rel) : null;
  const a = after ? decodeBytes(after, rel) : null;
  if (b?.enc === 'binary' || a?.enc === 'binary') return { path: rel, status, plus: 0, minus: 0, hunks: [], binary: true };
  const h = buildHunks(b?.text ?? '', a?.text ?? '');
  const enc = (b ?? a)?.enc;
  return {
    path: rel,
    status,
    plus: h.plus,
    minus: h.minus,
    hunks: h.hunks,
    ...(enc === 'euckr' ? { encoding: 'EUC-KR' as const } : enc === 'utf16le' || enc === 'utf16be' ? { encoding: 'UTF-16' as const } : {}),
  };
}

async function diffOf(root: string, id: string): Promise<FileChange[]> {
  const meta = await readBackupMeta(root, id);
  if (!meta) return [];
  const out: FileChange[] = [];
  for (const f of meta.files) {
    const before = f.before ? await readBackup(root, id, 'before', f.path) : null;
    const after = f.after ? await readBackup(root, id, 'after', f.path) : null;
    out.push(changeFrom(f.path, f.status, before, after));
  }
  return out;
}

async function readOrig(root: string, rel: string): Promise<Buffer | null> {
  try {
    const p = resolveInside(root, rel);
    const st = await fsp.lstat(p);
    return st.isFile() ? await fsp.readFile(p) : null;
  } catch {
    return null;
  }
}

/** 적용한 뒤(또는 되돌린 뒤) 같은 파일이 다시 바뀌었는지: 지금 원본 ≠ 'after' 보관본 */
async function driftOf(root: string, id: string): Promise<{ path: string; status: FileChange['status']; after: Buffer | null; now: Buffer | null; same: boolean }[]> {
  const meta = await readBackupMeta(root, id);
  if (!meta) return [];
  const out = [];
  for (const f of meta.files) {
    const after = f.after ? await readBackup(root, id, 'after', f.path) : null;
    const now = await readOrig(root, f.path);
    const same = after === null ? now === null : now !== null && sha1(after) === sha1(now);
    out.push({ path: f.path, status: f.status, after, now, same });
  }
  return out;
}

// ------------------------------------------------------------------ 되돌리기

async function revert(root: string, id: string, opts: { commit: boolean }): Promise<RevertResult> {
  return withLock(`revert:${root}`, async () => {
    const e = await historyService.get(root, id);
    if (!e) return { ok: false, error: '기록을 찾을 수 없습니다' };
    if (e.kind !== 'apply') return { ok: false, error: '코드 적용 기록만 되돌릴 수 있습니다' };
    if (e.revertedBy) return { ok: false, error: '이미 되돌린 변경입니다' };
    const meta = await readBackupMeta(root, id);
    if (!meta) return { ok: false, error: '적용 전 내용이 보관되어 있지 않아 되돌릴 수 없습니다' };
    // 적용한 뒤 같은 파일이 또 바뀌었으면 자동으로 되돌리지 않는다 (MSG-40)
    const drift = await driftOf(root, id);
    const blocked = drift.filter((d) => !d.same).map((d) => d.path);
    if (blocked.length) return { ok: false, blocked };

    const revId = newId('h');
    const items: Parameters<typeof writeBackup>[2] = [];
    for (const f of meta.files) {
      const before = f.before ? await readBackup(root, id, 'before', f.path) : null;
      if (f.before && !before) return { ok: false, error: `보관한 적용 전 파일이 없습니다: ${f.path}` };
      const now = await readOrig(root, f.path);
      const status: FileChange['status'] = f.status === 'added' ? 'deleted' : f.status === 'deleted' ? 'added' : 'modified';
      items.push({ path: f.path, status, before: !!now, after: !!before, plus: f.minus, minus: f.plus, beforeBuf: now, afterBuf: before });
    }
    await writeBackup(root, revId, items);
    const done: typeof items = [];
    try {
      for (const it of items) {
        const abs = safeTarget(root, it.path);
        if (it.afterBuf) {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, it.afterBuf);
        } else await fsp.rm(abs, { force: true });
        done.push(it);
      }
    } catch (err) {
      for (const it of done.reverse()) {
        const abs = resolveInside(root, it.path);
        if (it.beforeBuf) await fsp.writeFile(abs, it.beforeBuf).catch(() => undefined);
        else await fsp.rm(abs, { force: true }).catch(() => undefined);
      }
      return { ok: false, error: `원본 폴더에 쓰지 못해 되돌리기를 취소했습니다: ${(err as Error).message}` };
    }

    const { adapter, info } = await detectVcs(root, true);
    const wantCommit = !!opts?.commit && adapter.kind !== 'none';
    const when = fmtShort(e.at);
    await historyService.add(root, {
      id: revId,
      kind: 'revert',
      // 되돌린 변경을 만든 AI (기록 화면의 'Gemini 대화…'와 다시 시도한 커밋 기록에 씀)
      ...(e.ai ? { ai: e.ai } : {}),
      title: e.title,
      status: '되돌림',
      files: items.map((it) => ({ path: it.path, status: it.status, plus: it.plus, minus: it.minus })),
      ...(info.branch ? { branch: info.branch } : {}),
      vcs: info.kind,
      revertOf: id,
      ...(e.conversationId ? { conversationId: e.conversationId } : {}),
      ...(e.workId ? { workId: e.workId, workPath: e.workPath } : {}),
      want: { commit: wantCommit, push: false },
      steps: [{ at: nowIso(), label: '되돌리기', detail: `파일 ${items.length}개 · ${when}에 적용한 변경을 적용 전 내용으로 되돌림`, ok: true }],
    });
    await historyService.update(root, id, { revertedBy: revId });
    if (wantCommit) {
      await commitAndPush(
        root,
        revId,
        items.map((it) => ({ path: it.path, status: it.status })),
        { commit: true, push: false },
        { subject: `되돌림: ${e.title}`, full: `되돌림: ${e.title}\n\n작업 이력에서 ${when}에 적용한 변경(${e.commit ?? '커밋 안 함'})을 되돌림\n` },
      );
      // 되돌림은 커밋해도 상태 '되돌림'을 유지한다 (커밋 해시는 기록에)
      await historyService.update(root, revId, { status: '되돌림' });
    }
    return { ok: true, historyId: revId };
  });
}

function fmtShort(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ 커밋·푸시 다시 시도 (MSG-25)

async function retry(root: string, id: string): Promise<HistoryEntry | null> {
  const e = await historyService.get(root, id);
  if (!e || (e.kind !== 'apply' && e.kind !== 'revert')) return null;
  const want = e.want ?? { commit: true, push: false };
  const files = (e.files ?? []).map((f) => ({ path: f.path, status: f.status }));
  if (!files.length) return e;
  const { adapter, info } = await detectVcs(root, true);
  if (adapter.kind === 'none' || !canCommit(adapter, info)) {
    const reason = info.error ?? (adapter.kind === 'none' ? '형상관리가 없는 폴더입니다' : `${adapter.label} 명령을 찾지 못했습니다`);
    await historyService.addStep(root, id, { label: '다시 시도', detail: reason, ok: false });
    return historyService.get(root, id);
  }
  const pushOnly = !!e.commit;
  // 이미 커밋했고 푸시는 원하지 않았거나 이미 푸시함 → 다시 할 것이 없음
  if (pushOnly && (!want.push || e.pushed)) return e;
  const subject = e.kind === 'revert' ? `되돌림: ${e.title}` : commitMessage(e.title, undefined, AI_LABEL[e.ai ?? 'claude']).subject;
  const out = await commitAndPush(root, id, files, { commit: !pushOnly, push: want.push }, { subject, full: `${subject}\n` }, { pushOnly, retry: true });
  const after = out.entry ?? (await historyService.get(root, id));
  if (e.kind === 'revert' && after?.status !== '되돌림') await historyService.update(root, id, { status: '되돌림' });
  // 다시 시도한 커밋·푸시도 기록으로 남긴다 (목록에서는 코드로 분류)
  const ok = (out.commit?.ok ?? true) && (out.push?.ok ?? true);
  await historyService.add(root, {
    kind: 'commit',
    ...(e.ai ? { ai: e.ai } : {}),
    title: e.title,
    status: ok ? (out.push?.ok ? '푸시됨' : '커밋됨') : '실패',
    files: e.files,
    ...(after?.commit ? { commit: after.commit } : {}),
    ...(info.branch ? { branch: info.branch } : {}),
    vcs: info.kind,
    ...(e.conversationId ? { conversationId: e.conversationId } : {}),
    ...(ok ? {} : { error: out.push?.error ?? out.commit?.error }),
    steps: [{ at: nowIso(), label: pushOnly ? '푸시 다시 시도' : '커밋 다시 시도', detail: `${fmtShort(e.at)}에 적용한 변경${ok ? '' : ` · ${out.push?.error ?? out.commit?.error ?? ''}`}`, ok }],
  });
  return historyService.get(root, id);
}

// ------------------------------------------------------------------ CSV 내보내기

const KIND_LABEL: Record<HistoryKind, string> = {
  apply: '코드 적용',
  revert: '되돌리기',
  query: '쿼리 실행',
  'prod-select': '운영 조회',
  select: '조회(개발·QA)',
  commit: '커밋',
};

function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  // Excel 수식으로 읽히지 않게
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function historyCsv(entries: HistoryEntry[]): string {
  const head = ['시각', '종류', '제목', '상태', '대상(파일·DB)', '커밋', 'SQL', '예상/실제 행', '가린 컬럼', '대화'];
  const rows = entries.map((e) => {
    const target = e.db ? `${ENV_LABEL[e.db.env] ?? e.db.env} ${e.db.name}${e.db.account ? ` (${e.db.account})` : ''}` : (e.files ?? []).map((f) => f.path).join('; ');
    const rowsText = e.expected !== undefined ? `${e.expected} / ${e.affected ?? ''}` : e.affected !== undefined ? String(e.affected) : '';
    const commit = e.commit ? `${e.commit}${e.pushed ? ' (푸시)' : ''}` : '';
    return [localTime(e.at), KIND_LABEL[e.kind] ?? e.kind, e.title, e.error && e.status !== '실패' ? `${e.status} (커밋·푸시 실패)` : e.status, target, commit, e.sql ?? '', rowsText, (e.maskedColumns ?? []).join(', '), e.conversationId ?? ''];
  });
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

async function exportCsv(root: string): Promise<string | false> {
  const entries = await historyService.list(root);
  const name = (await services.project?.get(root).catch(() => null))?.name ?? path.basename(root);
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_');
  return host().saveFile(`${safe}_작업이력_${ymd}.csv`, Buffer.from(historyCsv(entries), 'utf8'), [{ name: 'CSV (Excel)', extensions: ['csv'] }]);
}

// ------------------------------------------------------------------ 등록

export function register(): void {
  services.history = historyService;
  handle('history.list', async (root) => (await historyService.list(checkRoot(root))).filter((e) => e.kind !== 'select'));
  handle('history.revert', (root, entryId, opts) => revert(checkRoot(root), checkEntryId(entryId), { commit: !!opts?.commit }));
  handle('history.exportCsv', (root) => exportCsv(checkRoot(root)));
  handle('history.diff', (root, entryId) => diffOf(checkRoot(root), checkEntryId(entryId)));
  handle('history.drift', async (root, entryId) => {
    const r = checkRoot(root);
    return (await driftOf(r, checkEntryId(entryId))).filter((d) => !d.same).map((d) => {
      const c = changeFrom(d.path, d.now === null ? 'deleted' : d.after === null ? 'added' : 'modified', d.after, d.now);
      return c;
    });
  });
  handle('history.step', async (root, entryId, step) => {
    if (!step || typeof step.label !== 'string' || !step.label.trim()) throw new DesktopError('진행 기록이 올바르지 않습니다', 'invalid');
    return need('history').addStep(checkRoot(root), checkEntryId(entryId), { label: step.label.trim(), detail: typeof step.detail === 'string' ? step.detail : undefined, ok: !!step.ok });
  });
  handle('history.retry', (root, entryId) => retry(checkRoot(root), checkEntryId(entryId)));
}
