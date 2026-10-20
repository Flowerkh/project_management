// 작업 사본·변경 비교·적용 (SCR-10).
// 작업 사본 = 원본 폴더의 지금 상태를 앱 작업 폴더에 복사한 것 (Git·SVN·없음 모두 같은 방식, Git worktree는 쓰지 않음).
//   <작업 폴더>/<프로젝트>-<ID>/   사본 (.git·.svn·무거운 폴더·20MB 넘는 파일·심볼릭 링크 제외)
//   <작업 폴더>/<ID>.json          사본 기록(manifest): 파일별 원본 해시·크기·인코딩, 사본 해시, 값 가림, 커밋 안 된 변경 여부
// Claude는 사본에서만 고치고, 사용자가 [적용]을 눌러야 원본 폴더에 반영된다. 적용 전·후 파일은 작업 이력에 보관(되돌리기).
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ApplyRequest, ApplyResult, FileChange, WorkCopy } from '../../shared/desktop-api';
import { AI_LABEL } from '../../shared/desktop-api';
import { convProvider } from '../claude/conversations';
import { isRedactable, isSecretFile, redactSecrets } from '../../shared/secrets';
import { resolveInside, walkDir } from '../fsutil';
import { DesktopError, emit, handle } from '../ipc';
import { checkRoot } from '../project';
import { need, services, type WorkService } from '../services';
import { newId, nowIso, readJson, rootKey, withLock, workDir, writeJson } from '../store';
import { canCommit, detectVcs, isDirtyPath } from '../vcs/index';
import { writeBackup } from './backup';
import { commitAndPush, commitMessage } from './commit';
import { buildHunks, mergeRedacted } from './diff';
import { copyText, decodeBytes, type Enc, encForNewFile, encodeBack, looksBinary, sha1, toCopyBytes } from './encoding';
import { safeTarget } from './paths';

export const MAX_COPY_BYTES = 20 * 1024 * 1024;
const MASK = '****';
const KEY_FILE = /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|\.(pem|key|p12|pfx|jks|keystore)$/i;
const DAY = 24 * 60 * 60 * 1000;

/** 사본에 넣지 않고 변경으로도 보지 않는 것: 프로젝트의 Claude 설정(.claude)·MCP 설정 */
function skipRel(rel: string): boolean {
  return rel === '.mcp.json' || rel === '.claude' || rel.startsWith('.claude/');
}

// ------------------------------------------------------------------ 사본 기록 (manifest)

interface ManifestFile {
  /** 원본 sha1·크기·인코딩 (사본을 만들거나 다시 맞춘 때) */
  h: string;
  s: number;
  e: Enc;
  /** 사본에 쓴 바이트 sha1·크기·수정 시각 */
  wh: string;
  ws: number;
  wm: number;
  /** 사본에서 비밀 값을 가림 */
  r?: 1;
  /** 접속 정보 파일 (isSecretFile) */
  x?: 1;
  /** 그때 원본에 커밋 안 된 변경이 있었음 */
  d?: 1;
}

interface Manifest {
  v: 1;
  id: string;
  root: string;
  path: string;
  name: string;
  createdAt: string;
  conversationId?: string;
  base?: WorkCopy['base'];
  files: Record<string, ManifestFile>;
  skipped?: { big: number; secret: number; error: number };
  applied?: number;
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new DesktopError('작업 사본 ID가 올바르지 않습니다', 'invalid');
  return id;
}

function manifestPath(id: string): string {
  return path.join(workDir(), `${checkId(id)}.json`);
}

async function loadOrNull(id: string): Promise<Manifest | null> {
  const m = await readJson<Manifest | null>(manifestPath(id), null);
  return m && m.v === 1 && m.files ? m : null;
}

async function load(id: string): Promise<Manifest> {
  const m = await loadOrNull(id);
  if (!m) throw new DesktopError('작업 사본을 찾을 수 없습니다. 지워졌거나 다른 PC에서 만든 사본입니다', 'notfound');
  return m;
}

async function save(m: Manifest): Promise<void> {
  await writeJson(manifestPath(m.id), m);
}

function toWorkCopy(m: Manifest, changed?: number): WorkCopy {
  const files = Object.values(m.files);
  return {
    id: m.id,
    root: m.root,
    path: m.path,
    createdAt: m.createdAt,
    ...(m.conversationId ? { conversationId: m.conversationId } : {}),
    fileCount: files.length,
    ...(m.base ? { base: m.base } : {}),
    redacted: files.filter((f) => f.r || f.x).length,
    ...(changed !== undefined ? { changed } : {}),
  };
}

function slug(s: string): string {
  return s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

function filesArg(files: unknown): string[] {
  if (!Array.isArray(files)) throw new DesktopError('파일 목록이 올바르지 않습니다', 'invalid');
  const out: string[] = [];
  for (const f of files) {
    if (typeof f !== 'string' || !f || f.length > 1000) throw new DesktopError('파일 경로가 올바르지 않습니다', 'invalid');
    const rel = f.replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) throw new DesktopError(`폴더 밖 파일은 다룰 수 없습니다: ${f}`, 'invalid');
    out.push(rel);
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ 파일 복사 (원본 → 사본)

async function copyOne(root: string, dest: string, rel: string, dirty: boolean): Promise<{ entry?: ManifestFile; skipped?: 'big' | 'secret' }> {
  const src = resolveInside(root, rel);
  const st = await fsp.lstat(src);
  if (!st.isFile()) return {};
  if (st.size > MAX_COPY_BYTES) return { skipped: 'big' };
  const buf = await fsp.readFile(src);
  const secret = isSecretFile(rel);
  const dec = decodeBytes(buf, rel);
  // 키 파일·바이너리 접속 정보는 사본에 넣지 않는다
  if (secret && (dec.enc === 'binary' || dec.enc === 'raw' || KEY_FILE.test(rel))) return { skipped: 'secret' };
  let text: string | undefined;
  if (dec.text !== null && dec.enc !== 'raw' && (secret || isRedactable(rel))) {
    const r = redactSecrets(dec.text, rel);
    if (r.count > 0) text = r.text;
  }
  const out = toCopyBytes(buf, dec, text);
  const target = resolveInside(dest, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, out);
  const wst = await fsp.stat(target);
  return {
    entry: {
      h: sha1(buf),
      s: buf.length,
      e: dec.enc,
      wh: sha1(out),
      ws: out.length,
      wm: wst.mtimeMs,
      ...(text !== undefined ? { r: 1 as const } : {}),
      ...(secret ? { x: 1 as const } : {}),
      ...(dirty ? { d: 1 as const } : {}),
    },
  };
}

async function dirtyStatus(root: string): Promise<Map<string, string>> {
  const { adapter, info } = await detectVcs(root);
  if (info.kind === 'none' || !canCommit(adapter, info)) return new Map();
  return adapter.status(root).catch(() => new Map());
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

async function create(rootIn: string, opts: { conversationId?: string } = {}): Promise<WorkCopy> {
  const root = checkRoot(rootIn);
  const { adapter, info } = await detectVcs(root, true);
  const dirty = info.kind !== 'none' && canCommit(adapter, info) ? await adapter.status(root).catch(() => new Map<string, string>()) : new Map<string, string>();
  let id = crypto.randomBytes(3).toString('hex');
  while (fs.existsSync(manifestPath(id))) id = crypto.randomBytes(4).toString('hex');
  const name = `${slug(path.basename(root))}-${id}`;
  const dest = path.join(workDir(), name);
  await fsp.mkdir(dest, { recursive: true });
  const m: Manifest = {
    v: 1,
    id,
    root,
    path: dest,
    name,
    createdAt: nowIso(),
    ...(typeof opts.conversationId === 'string' && opts.conversationId ? { conversationId: opts.conversationId } : {}),
    base: { kind: info.kind, ...(info.branch ? { branch: info.branch } : {}), ...(info.head ? { head: info.head } : {}), ...(info.dirty !== undefined ? { dirty: info.dirty } : {}) },
    files: {},
    skipped: { big: 0, secret: 0, error: 0 },
  };
  try {
    const walked = await walkDir(root, { skipHeavy: true });
    const list = walked.files.filter((f) => !skipRel(f.rel));
    const total = list.length;
    let done = 0;
    let last = 0;
    const fmt = (n: number) => n.toLocaleString('ko-KR');
    const progress = (force = false) => {
      const now = Date.now();
      if (!force && now - last < 120) return;
      last = now;
      emit({ type: 'work.progress', root, done, total, message: `작업 사본 만드는 중 · 파일 ${fmt(done)} / ${fmt(total)}` });
    };
    progress(true);
    await pool(list, 16, async (f) => {
      try {
        const r = await copyOne(root, dest, f.rel, isDirtyPath(dirty, f.rel));
        if (r.entry) m.files[f.rel] = r.entry;
        else if (r.skipped) m.skipped![r.skipped]++;
      } catch {
        m.skipped!.error++;
      }
      done++;
      progress();
    });
    await save(m);
    const n = Object.keys(m.files).length;
    const notes = [m.skipped!.big ? `20MB 넘는 파일 ${m.skipped!.big}개 제외` : '', walked.truncated ? '파일이 너무 많아 일부만 복사' : ''].filter(Boolean);
    emit({ type: 'work.progress', root, done: total, total, message: `작업 사본을 만들었습니다 · 파일 ${fmt(n)}개${notes.length ? ` · ${notes.join(' · ')}` : ''}` });
    return toWorkCopy(m, 0);
  } catch (e) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(manifestPath(id), { force: true }).catch(() => undefined);
    throw e;
  }
}

// ------------------------------------------------------------------ 변경 찾기

interface Raw {
  rel: string;
  status: FileChange['status'];
  buf?: Buffer;
}

interface Touched {
  rel: string;
  wh: string;
  wm: number;
}

/** 내용은 같고 수정 시각만 바뀐 파일을 사본 기록에 반영 (적용·버리기와 겹치지 않게 다시 읽어 고친다) */
async function saveTouched(id: string, touched: Touched[]): Promise<void> {
  if (!touched.length) return;
  await withLock(`work:${id}`, async () => {
    const m = await loadOrNull(id);
    if (!m) return;
    let n = 0;
    for (const t of touched) {
      const mf = m.files[t.rel];
      if (mf && mf.wh === t.wh && mf.wm !== t.wm) {
        mf.wm = t.wm;
        n++;
      }
    }
    if (n) await save(m);
  });
}

/** 사본을 사본 기록과 비교 (원본은 보지 않음): 더한·고친·지운 파일 */
async function scanCopy(m: Manifest): Promise<{ raw: Raw[]; touched: Touched[] }> {
  const out: Raw[] = [];
  const touched: Touched[] = [];
  if (!fs.existsSync(m.path)) return { raw: [], touched };
  const { files } = await walkDir(m.path, { skipHeavy: true });
  const seen = new Set<string>();
  for (const f of files) {
    if (skipRel(f.rel)) continue;
    seen.add(f.rel);
    const mf = m.files[f.rel];
    if (!mf) {
      out.push({ rel: f.rel, status: 'added' });
      continue;
    }
    // 크기·수정 시각이 사본을 쓸 때와 똑같으면 읽지 않는다 (다르면 내용 해시로 확인)
    if (f.size === mf.ws && f.mtimeMs === mf.wm) continue;
    const buf = await fsp.readFile(path.join(m.path, ...f.rel.split('/')));
    if (sha1(buf) === mf.wh) {
      // 시각만 바뀜 (같은 내용으로 저장): 다음부터 다시 읽지 않게 기록해 둔다
      mf.wm = f.mtimeMs;
      touched.push({ rel: f.rel, wh: mf.wh, wm: f.mtimeMs });
      continue;
    }
    out.push({ rel: f.rel, status: 'modified', buf });
  }
  for (const rel of Object.keys(m.files)) if (!seen.has(rel)) out.push({ rel, status: 'deleted' });
  return { raw: out, touched };
}

interface Analyzed {
  change: FileChange;
  orig: Buffer | null;
  copy: Buffer | null;
  /** 원본에 쓸 인코딩 */
  enc: Enc;
}

async function readIf(p: string): Promise<Buffer | null> {
  try {
    const st = await fsp.lstat(p);
    if (!st.isFile()) return null;
    return await fsp.readFile(p);
  } catch {
    return null;
  }
}

/** 원본(지금)과 사본을 비교해 화면에 보낼 변경 하나 */
async function analyze(m: Manifest, r: Raw): Promise<Analyzed> {
  const mf = m.files[r.rel];
  const orig = await readIf(resolveInside(m.root, r.rel));
  const copy = r.status === 'deleted' ? null : (r.buf ?? (await fsp.readFile(resolveInside(m.path, r.rel))));
  const conflict = r.status === 'added' ? orig !== null : orig === null || sha1(orig) !== mf.h;
  const newRaw = copy ? copyText(copy, 'utf8') : null;
  const enc: Enc = mf ? mf.e : copy && looksBinary(copy) ? 'binary' : encForNewFile(newRaw ?? '');
  const origDec = orig ? decodeBytes(orig, r.rel) : null;
  const binary = enc === 'binary' || (copy ? looksBinary(copy) : false) || origDec?.enc === 'binary';
  const change: FileChange = { path: r.rel, status: r.status, plus: 0, minus: 0, hunks: [] };
  // 접속 정보 파일은 사본이 값을 가린 파일이라 어떤 변경도 적용하지 않는다
  if (isSecretFile(r.rel) || mf?.x) change.blocked = '접속 정보 파일이라 적용할 수 없습니다 (작업 사본은 값을 가린 파일입니다)';
  if (binary) change.binary = true;
  else {
    let oldText = origDec?.text ?? '';
    if (mf?.r || mf?.x) oldText = redactSecrets(oldText, r.rel).text;
    const newText = copy ? (copyText(copy, enc) ?? '') : '';
    const h = buildHunks(oldText, newText);
    change.plus = h.plus;
    change.minus = h.minus;
    change.hunks = h.hunks;
    if (change.blocked || r.status === 'deleted') {
      // 그대로
    } else if (enc === 'raw') change.blocked = '인코딩을 알 수 없는 파일이라 적용할 수 없습니다';
    else if (mf?.r) {
      // 가린 값이 들어간 줄을 새로 쓰거나 고치면 원래 값을 알 수 없다
      const had = new Set(oldText.split('\n').map((s) => s.replace(/\r$/, '')));
      if (newText.split('\n').some((s) => s.includes(MASK) && !had.has(s.replace(/\r$/, '')))) {
        change.blocked = '가린 값(****)이 들어간 줄을 고쳐 적용할 수 없습니다. 이 줄은 원본에서 직접 고쳐 주세요';
      }
    }
    if (!change.blocked && r.status !== 'deleted' && enc === 'euckr') {
      const e = encodeBack(newText, 'euckr');
      if (e.error) change.blocked = e.error;
    }
  }
  if (conflict) change.conflict = true;
  if (mf?.d) change.dirtyBase = true;
  if (enc === 'euckr') change.encoding = 'EUC-KR';
  else if (enc === 'utf16le' || enc === 'utf16be') change.encoding = 'UTF-16';
  if (mf?.r) change.redacted = true;
  return { change, orig, copy, enc };
}

/** inLock: 이미 work:<id> 잠금 안에서 부를 때 (버리기 뒤) → 기록을 바로 저장 */
async function changesOf(m: Manifest, inLock = false): Promise<Analyzed[]> {
  const { raw, touched } = await scanCopy(m);
  if (touched.length) {
    if (inLock) await save(m).catch(() => undefined);
    else await saveTouched(m.id, touched).catch(() => undefined);
  }
  const out: Analyzed[] = [];
  await pool(raw, 8, async (r) => {
    try {
      out.push(await analyze(m, r));
    } catch (e) {
      out.push({ change: { path: r.rel, status: r.status, plus: 0, minus: 0, hunks: [], blocked: `파일을 읽지 못했습니다: ${(e as Error).message}` }, orig: null, copy: null, enc: 'binary' });
    }
  });
  return out.sort((a, b) => (a.change.path < b.change.path ? -1 : a.change.path > b.change.path ? 1 : 0));
}

async function changes(id: string): Promise<FileChange[]> {
  const m = await load(checkId(id));
  return (await changesOf(m)).map((a) => a.change);
}

// ------------------------------------------------------------------ 적용

function mustBytes(r: ReturnType<typeof encodeBack>, rel: string): Buffer {
  if (r.bytes) return r.bytes;
  throw new DesktopError(`${rel}: ${r.error}`, 'blocked');
}

/** 원본 폴더에 쓸 내용 (지운 파일이면 null) */
function afterBytes(m: Manifest, a: Analyzed): Buffer | null {
  const c = a.change;
  if (c.status === 'deleted') return null;
  const copy = a.copy!;
  if (c.binary) return copy;
  const mf = m.files[c.path];
  if (!mf) {
    if (a.enc === 'euckr') return mustBytes(encodeBack(copyText(copy, 'utf8') ?? '', 'euckr'), c.path);
    return copy;
  }
  const text = copyText(copy, mf.e) ?? '';
  if (mf.r) {
    // 가린 값 되돌리기: 사본의 줄 변경을 실제 원본에 옮긴다
    const real = decodeBytes(a.orig!, c.path).text ?? '';
    const merged = mergeRedacted(real, redactSecrets(real, c.path).text, text);
    return mustBytes(encodeBack(merged, mf.e), c.path);
  }
  if (mf.e === 'utf8') return copy;
  return mustBytes(encodeBack(text, mf.e), c.path);
}

async function writeOrig(abs: string, data: Buffer | null): Promise<void> {
  if (data) {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
  } else await fsp.rm(abs, { force: true });
}

function applyNote(req: ApplyRequest, kind: string, canPush: boolean): string {
  if (kind === 'none') return '형상관리 없음 · 원본 폴더에만 적용';
  if (!req.commit) return '커밋하지 않음';
  if (req.push && canPush) return "확인 창에서 '적용 후 커밋'·'커밋 후 푸시'를 고름";
  return kind === 'svn' ? "확인 창에서 '적용 후 커밋'을 고름 · SVN 서버에 바로 반영" : "확인 창에서 '적용 후 커밋'을 고름 · 푸시는 하지 않음";
}

async function apply(id: string, reqIn: ApplyRequest): Promise<ApplyResult> {
  checkId(id);
  if (!reqIn || typeof reqIn !== 'object') throw new DesktopError('적용 요청이 올바르지 않습니다', 'invalid');
  const req: ApplyRequest = {
    files: filesArg(reqIn.files),
    commit: !!reqIn.commit,
    push: !!reqIn.push && !!reqIn.commit,
    title: String(reqIn.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    ...(typeof reqIn.message === 'string' ? { message: reqIn.message.slice(0, 4000) } : {}),
    ...(typeof reqIn.conversationId === 'string' ? { conversationId: reqIn.conversationId } : {}),
  };
  return withLock(`work:${id}`, async () => {
    const m = await load(id);
    const root = checkRoot(m.root);
    const want = new Set(req.files);
    const { raw } = await scanCopy(m);
    const sel = raw.filter((r) => want.has(r.rel));
    if (!sel.length) throw new DesktopError('적용할 변경이 없습니다. 이미 적용했거나 버린 변경입니다', 'empty');
    const an: Analyzed[] = [];
    for (const r of sel) an.push(await analyze(m, r));
    const blocked = an.filter((a) => a.change.blocked);
    if (blocked.length) {
      throw new DesktopError(`적용할 수 없는 파일이 있습니다: ${blocked.map((b) => `${b.change.path} (${b.change.blocked})`).join(', ')}`, 'blocked', blocked.map((b) => b.change.path));
    }
    // 작업 사본을 만든 뒤 원본이 바뀐 파일이 있으면 멈춘다 (MSG-31)
    const conflicts = an.filter((a) => a.change.conflict).map((a) => a.change.path);
    if (conflicts.length) return { ok: false, conflicts, applied: [] };

    const plan = an.map((a) => ({ a, after: afterBytes(m, a) }));
    const historyId = newId('h');
    await writeBackup(
      root,
      historyId,
      plan.map(({ a, after }) => ({
        path: a.change.path,
        status: a.change.status,
        before: !!a.orig,
        after: !!after,
        plus: a.change.plus,
        minus: a.change.minus,
        beforeBuf: a.orig,
        afterBuf: after,
      })),
    );
    // 원본 폴더에 쓴다. 하나라도 실패하면 이미 쓴 파일을 적용 전으로 되돌리고 멈춘다
    const written: typeof plan = [];
    try {
      for (const p of plan) {
        await writeOrig(safeTarget(root, p.a.change.path), p.after);
        written.push(p);
      }
    } catch (e) {
      for (const p of written.reverse()) await writeOrig(resolveInside(root, p.a.change.path), p.a.orig).catch(() => undefined);
      throw new DesktopError(`원본 폴더에 쓰지 못해 적용을 취소했습니다 (다른 프로그램이 파일을 열고 있는지 확인해 주세요): ${(e as Error).message}`, 'write');
    }

    const { adapter, info } = await detectVcs(root, true);
    const vcsOn = adapter.kind !== 'none';
    const wantCommit = req.commit && vcsOn;
    const wantPush = wantCommit && req.push && adapter.canPush;
    // 변경을 만든 AI (커밋 표시 'Gemini가 작성한 변경'). 대화를 못 찾으면 예전처럼 Claude
    const convId = req.conversationId ?? m.conversationId;
    const provider = await convProvider(convId);
    const ai = AI_LABEL[provider ?? 'claude'];
    if (!req.title) req.title = `${ai}가 고친 코드`;
    await need('history').add(root, {
      id: historyId,
      kind: 'apply',
      ...(provider ? { ai: provider } : {}),
      title: req.title,
      status: '적용됨',
      files: an.map((a) => ({ path: a.change.path, status: a.change.status, plus: a.change.plus, minus: a.change.minus })),
      ...(info.branch ? { branch: info.branch } : {}),
      vcs: info.kind,
      workId: m.id,
      workPath: m.path,
      ...((req.conversationId ?? m.conversationId) ? { conversationId: req.conversationId ?? m.conversationId } : {}),
      want: { commit: wantCommit, push: wantPush },
      steps: [{ at: nowIso(), label: '적용', detail: `파일 ${an.length}개 · ${applyNote(req, info.kind, adapter.canPush)}`, ok: true }],
    });

    const result: ApplyResult = { ok: true, historyId, applied: an.map((a) => a.change.path) };
    if (wantCommit) {
      const out = await commitAndPush(
        root,
        historyId,
        an.map((a) => ({ path: a.change.path, status: a.change.status })),
        { commit: true, push: wantPush },
        commitMessage(req.title, req.message, ai),
      );
      if (out.commit) result.commit = out.commit;
      if (out.push) result.push = out.push;
    }
    // 사본 기록 갱신: 적용한 파일은 원본과 사본이 같아졌다
    const committed = !!result.commit?.ok;
    for (const { a, after } of plan) {
      const rel = a.change.path;
      if (!after) {
        delete m.files[rel];
        continue;
      }
      const prev = m.files[rel];
      const st = await fsp.stat(resolveInside(m.path, rel));
      m.files[rel] = {
        h: sha1(after),
        s: after.length,
        e: prev?.e ?? decodeBytes(after, rel).enc,
        wh: sha1(a.copy!),
        ws: a.copy!.length,
        wm: st.mtimeMs,
        ...(prev?.r ? { r: 1 as const } : {}),
        ...(prev?.x ? { x: 1 as const } : {}),
        ...(vcsOn && !committed ? { d: 1 as const } : {}),
      };
    }
    m.applied = (m.applied ?? 0) + 1;
    await save(m);
    return result;
  });
}

// ------------------------------------------------------------------ 버리기·다시 맞추기

/** 사본의 파일을 지금 원본으로 다시 복사 (원본에 없으면 사본에서도 지움) */
async function recopy(m: Manifest, rels: string[]): Promise<string[]> {
  const dirty = await dirtyStatus(m.root);
  const done: string[] = [];
  for (const rel of rels) {
    const copyAbs = resolveInside(m.path, rel);
    await fsp.rm(copyAbs, { force: true });
    delete m.files[rel];
    const exists = await fsp.lstat(resolveInside(m.root, rel)).then((s) => s.isFile(), () => false);
    if (exists) {
      const r = await copyOne(m.root, m.path, rel, isDirtyPath(dirty, rel));
      if (r.entry) m.files[rel] = r.entry;
    }
    done.push(rel);
  }
  await save(m);
  return done;
}

async function discard(id: string, files?: string[]): Promise<FileChange[]> {
  checkId(id);
  const only = files === undefined || files === null ? null : new Set(filesArg(files));
  return withLock(`work:${id}`, async () => {
    const m = await load(id);
    checkRoot(m.root);
    const { raw } = await scanCopy(m);
    await recopy(m, raw.filter((r) => !only || only.has(r.rel)).map((r) => r.rel));
    return (await changesOf(m, true)).map((a) => a.change);
  });
}

async function refresh(id: string, files: string[]): Promise<string[]> {
  checkId(id);
  const rels = filesArg(files);
  return withLock(`work:${id}`, async () => {
    const m = await load(id);
    checkRoot(m.root);
    return recopy(m, rels);
  });
}

// ------------------------------------------------------------------ 목록·정리

async function manifests(): Promise<Manifest[]> {
  const dir = workDir();
  const out: Manifest[] = [];
  for (const n of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (!n.endsWith('.json')) continue;
    const m = await readJson<Manifest | null>(path.join(dir, n), null);
    if (m && m.v === 1 && m.files && typeof m.root === 'string') out.push(m);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function list(root: string): Promise<WorkCopy[]> {
  const key = rootKey(root);
  const mine = (await manifests()).filter((m) => rootKey(m.root) === key);
  const out: WorkCopy[] = [];
  for (const [i, m] of mine.entries()) {
    const changed = i < 20 ? (await scanCopy(m).catch(() => ({ raw: [] as Raw[] }))).raw.length : undefined;
    out.push(toWorkCopy(m, changed));
  }
  return out;
}

/**
 * 시작할 때 정리: 30일 넘게 쓰지 않았고 적용하지 않은 변경이 없는 작업 사본을 지운다.
 * 변경이 남은 사본은 지우지 않고 기록만 남긴다. 기록(manifest) 없는 사본 폴더는 하루 지나면 지운다.
 */
export async function cleanupOld(now = Date.now(), maxDays = 30): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const dir = workDir();
  const ids = new Set<string>();
  for (const m of await manifests()) {
    ids.add(m.id);
    const mtime = (await fsp.stat(manifestPath(m.id)).catch(() => null))?.mtimeMs ?? 0;
    const last = Math.max(Date.parse(m.createdAt) || 0, mtime);
    if (now - last < maxDays * DAY) continue;
    const { raw } = await scanCopy(m).catch(() => ({ raw: [{ rel: '?', status: 'modified' as const }] }));
    if (raw.length) {
      kept.push(m.path);
      console.log(`[work] 적용하지 않은 변경 ${raw.length}개가 남아 오래된 작업 사본을 지우지 않음: ${m.path}`);
      continue;
    }
    await fsp.rm(m.path, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(manifestPath(m.id), { force: true }).catch(() => undefined);
    removed.push(m.path);
  }
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    if (!e.isDirectory()) continue;
    const id = e.name.slice(e.name.lastIndexOf('-') + 1);
    if (ids.has(id)) continue;
    const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
    if (st && now - st.mtimeMs > DAY) {
      await fsp.rm(path.join(dir, e.name), { recursive: true, force: true }).catch(() => undefined);
      removed.push(path.join(dir, e.name));
    }
  }
  if (removed.length) console.log(`[work] 오래된 작업 사본 ${removed.length}개를 지웠습니다`);
  return { removed, kept };
}

// ------------------------------------------------------------------ 등록

export const workService: WorkService & {
  list: typeof list;
  discard: typeof discard;
  apply: typeof apply;
  refresh: typeof refresh;
} = {
  create,
  async get(id) {
    const m = await loadOrNull(checkId(id));
    return m ? toWorkCopy(m) : null;
  },
  changes,
  list,
  discard,
  apply,
  refresh,
};

export function register(): void {
  services.work = workService;
  handle('work.create', (root, conversationId) => workService.create(root, { conversationId }));
  handle('work.get', (id) => workService.get(id));
  handle('work.list', (root) => list(checkRoot(root)));
  handle('work.changes', (id) => changes(id));
  handle('work.discard', (id, files) => discard(id, files));
  handle('work.apply', (id, req) => apply(id, req));
  handle('work.refresh', (id, files) => refresh(id, files));
  const t = setTimeout(() => {
    cleanupOld().catch((e) => console.log('[work] 정리 실패', e));
  }, 20000);
  t.unref?.();
}
