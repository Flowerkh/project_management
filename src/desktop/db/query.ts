// Claude의 SELECT 조회 도구, 연결 확인, 메뉴 테이블 읽기
//  - 조회: SELECT 하나만, 읽기 전용 세션(조회 전용 계정이 있으면 그 계정), 환경별 행 수·시간 제한, 운영은 항상 사용자 확인
//  - 개인정보 가림: 원본 컬럼(주석 포함) 기준 + 값 모양
//  - Claude에 보내는 문구에는 주소·계정·비밀번호를 넣지 않는다
import {
  DEFAULT_MASK, DEFAULT_RULES, ENV_LABEL, type DbConnectionInput, type DbKind, type DbTestResult, type Env, type EnvRule, type MenuDbSetting,
  type MenuReadResult, type MenuRow, type ProjectSettings, type QueryResult,
} from '../../shared/desktop-api';
import { msg } from '../../ui/desktop/messages';
import { DesktopError } from '../ipc';
import { services, type DbSelectAsk, type DbSelectOutcome, type DbSelectRequest } from '../services';
import { nowIso } from '../store';
import {
  connChanged, fingerprint, getConn, listStored, normalizeInput, readTarget, rememberTest, sameTarget, setLastTest, targetFor, type Account, type StoredConn,
} from './conns';
import { DbError, describeError, scrub, tableKey, withSession, type ConnTarget, type QueryOut, type Session } from './drivers';
import { applyMasks, decideMasks, parseMaskPatterns, sourcesForResult, type MetaLookup, type TableInfo } from './mask';
import { checkReadOnly, isSafeIdent, mainTable, nameKey, selectShape, shapeTables, type Dialect, type TableRef } from './sql';

export function dialectOf(kind: DbKind): Dialect {
  return kind === 'oracle' ? 'oracle' : 'mysql';
}

export type ProjectDbSettings = Pick<ProjectSettings, 'dbRules' | 'maskPatterns' | 'menuDb'>;

export async function settingsOf(root: string): Promise<ProjectDbSettings> {
  const p = services.project;
  if (!p) return { dbRules: structuredClone(DEFAULT_RULES), maskPatterns: [...DEFAULT_MASK] };
  const s = await p.get(root);
  return { dbRules: s.dbRules, maskPatterns: s.maskPatterns, menuDb: s.menuDb };
}

export function ruleOf(st: ProjectDbSettings, env: Env): EnvRule {
  const r = { ...DEFAULT_RULES[env], ...(st.dbRules?.[env] ?? {}) };
  if (env === 'prod') {
    r.selectMode = 'confirm';
    r.changeMode = 'typeName';
  }
  return r;
}

/** Claude에 알려 줄 연결 목록 (환경·이름만) */
export function availableText(list: StoredConn[]): string {
  if (!list.length) return '이 프로젝트에 연결된 DB가 없습니다. 프로젝트 연결(POP-04)에서 DB를 추가해야 조회할 수 있습니다';
  return `연결된 DB: ${list.map((c) => `${ENV_LABEL[c.env]}(${c.env}) ${c.name}`).join(', ')}. 다른 환경을 조회하려면 env를 지정해 주세요`;
}

/** 오류 문구에서 비밀 값 가리기 */
export function secretsOf(c: StoredConn, t?: ConnTarget | null): string[] {
  return [c.host, c.user, c.readUser, t?.user, t?.password].filter((x): x is string => !!x);
}

/** Claude에 보내는 오류 문구 (연결 실패는 MSG-36) */
export function claudeError(err: DbError, c: StoredConn, t?: ConnTarget | null): string {
  const detail = scrub(err.message, secretsOf(c, t));
  if (err.kind === 'connect' || err.kind === 'auth' || err.kind === 'driver') return `${msg('MSG-36', { DB: c.name })} (${detail})`;
  return detail;
}

// ------------------------------------------------------------------ 테이블 정보 캐시

const META_TTL = 10 * 60_000;
const metaCache = new Map<string, { at: number; info: TableInfo | null }>();

connChanged.add((root, id) => {
  for (const k of metaCache.keys()) if (k.startsWith(`${root}|${id}|`)) metaCache.delete(k);
});

export function clearMetaCache(): void {
  metaCache.clear();
}

async function tableInfos(s: Session, prefix: string, tables: TableRef[], sec: number): Promise<Map<string, TableInfo | null>> {
  const out = new Map<string, TableInfo | null>();
  const miss: TableRef[] = [];
  for (const t of tables) {
    const c = metaCache.get(prefix + tableKey(t));
    if (c && Date.now() - c.at < META_TTL) out.set(tableKey(t), c.info);
    else miss.push(t);
  }
  if (miss.length) {
    try {
      const got = await s.tableInfo(miss, sec);
      for (const t of miss) {
        const info = got.get(tableKey(t)) ?? null;
        out.set(tableKey(t), info);
        metaCache.set(prefix + tableKey(t), { at: Date.now(), info });
      }
    } catch {
      // 못 읽으면 모르는 채로 (가리는 쪽으로 판단). 캐시하지 않는다
      for (const t of miss) out.set(tableKey(t), null);
    }
  }
  return out;
}

function lookupOf(infos: Map<string, TableInfo | null>): MetaLookup {
  return (t) => {
    const k = tableKey(t);
    if (infos.has(k) && infos.get(k)) return infos.get(k) ?? null;
    const nk = nameKey(t.name);
    for (const v of infos.values()) {
      if (v && nameKey(v.name) === nk && (!t.schema || nameKey(v.schema ?? '') === nameKey(t.schema))) return v;
    }
    return null;
  };
}

// ------------------------------------------------------------------ 조회 실행 (가림 포함)

export interface SelectRun {
  result: QueryResult;
  account: Account;
  user: string;
}

/** 읽기 전용 세션에서 SELECT 하나 (확인·규칙 판단은 부르는 쪽) */
export async function runSelect(root: string, c: StoredConn, sql: string, maxRows: number, rule: EnvRule, patterns: string[]): Promise<SelectRun> {
  const acct = await readTarget(root, c);
  if (!acct) throw new DesktopError(`${c.name} 연결에 계정 비밀번호가 저장되어 있지 않습니다. 프로젝트 연결에서 계정을 확인해 주세요`, 'nopassword');
  const d = dialectOf(c.kind);
  const shape = rule.mask ? selectShape(sql, d) : null;
  const tables = shape ? shapeTables(shape) : [];
  const prefix = `${root}|${c.id}|${acct.account}|`;
  const t0 = Date.now();
  const { out, infos } = await withSession(acct.target, async (s) => {
    await s.beginReadOnly(rule.timeoutSec);
    let infos = new Map<string, TableInfo | null>();
    let out: QueryOut;
    if (s.dialect === 'mysql') {
      // 넘는 행이 있으면 연결을 끊어 멈추므로 테이블 정보를 먼저 읽는다
      if (rule.mask && tables.length) infos = await tableInfos(s, prefix, tables, rule.timeoutSec);
      out = await s.select(sql, maxRows, rule.timeoutSec);
    } else {
      out = await s.select(sql, maxRows, rule.timeoutSec);
      if (rule.mask && tables.length) infos = await tableInfos(s, prefix, tables, rule.timeoutSec);
    }
    if (!out.truncated || s.dialect === 'oracle') await s.rollback().catch(() => undefined);
    return { out, infos };
  });
  let rows = out.rows;
  let masked = out.columns.map(() => false);
  if (rule.mask) {
    const rules = parseMaskPatterns(patterns);
    const lookup = lookupOf(infos);
    const srcs = sourcesForResult(shape, out.columns, lookup, [...infos.values()].filter((x): x is TableInfo => !!x));
    const m = applyMasks(rows, decideMasks(srcs, rules));
    rows = m.rows;
    masked = m.masked;
  }
  const result: QueryResult = {
    columns: out.columns.map((col, i) => ({ name: col.name, ...(masked[i] ? { masked: true } : {}) })),
    rows,
    rowCount: rows.length,
    truncated: out.truncated,
    ms: Date.now() - t0,
    maskedColumns: out.columns.filter((_, i) => masked[i]).map((col) => col.name),
  };
  return { result, account: acct.account, user: acct.target.user };
}

function titleOf(env: Env, sql: string, d: Dialect, dbName: string): string {
  const shape = selectShape(sql, d);
  const tables = shape ? shapeTables(shape).map((t) => t.name) : [];
  const main = tables.length ? tables : [mainTable(sql, d)?.name].filter((x): x is string => !!x);
  const label = main.length ? `${main.slice(0, 3).join(', ')}${main.length > 3 ? ` 외 ${main.length - 3}개` : ''}` : dbName;
  return `${env === 'prod' ? '운영' : ENV_LABEL[env]} 조회 · ${label}`;
}

/** DbService.select: Claude의 조회 도구 */
export async function selectForClaude(req: DbSelectRequest, ask: (q: DbSelectAsk) => Promise<boolean>): Promise<DbSelectOutcome> {
  const root = req.root;
  const list = await listStored(root);
  let c: StoredConn | undefined;
  if (req.connectionId) {
    c = list.find((x) => x.id === req.connectionId);
    if (!c) return { status: 'none', message: `지정한 DB 연결을 찾을 수 없습니다. ${availableText(list)}` };
  } else {
    // 기본 조회 대상은 개발. QA·운영은 지정했을 때만
    const env: Env = req.env ?? 'dev';
    c = list.find((x) => x.env === env);
    if (!c) return { status: 'none', env, message: `${ENV_LABEL[env]} DB 연결이 없습니다. ${availableText(list)}` };
  }
  const base = { env: c.env, dbName: c.name, connectionId: c.id };
  const d = dialectOf(c.kind);
  const chk = checkReadOnly(String(req.sql ?? ''), d);
  if (!chk.ok) return { status: 'rejected', ...base, message: chk.reason };
  const st = await settingsOf(root);
  const rule = ruleOf(st, c.env);
  const maxRows = Math.max(1, Math.min(rule.maxRows, Math.round(Number(req.maxRows) || rule.maxRows)));
  if (c.env === 'prod' || rule.selectMode === 'confirm') {
    let ok = false;
    try {
      ok = await ask({ env: c.env, dbName: c.name, sql: chk.sql, maxRows, mask: rule.mask });
    } catch {
      ok = false;
    }
    if (!ok) return { status: 'denied', ...base, message: '사용자가 이 조회를 실행하지 않기로 했습니다' };
  }
  const t0 = Date.now();
  let run: SelectRun | undefined;
  let err: DbError | undefined;
  let target: ConnTarget | null = null;
  try {
    run = await runSelect(root, c, chk.sql, maxRows, rule, st.maskPatterns);
  } catch (e) {
    err = e instanceof DesktopError ? new DbError(e.message, 'auth', e.code) : describeError(e, rule.timeoutSec);
    target = (await readTarget(root, c).catch(() => null))?.target ?? null;
  }
  const ms = Date.now() - t0;
  let historyId: string | undefined;
  try {
    const h = services.history;
    if (h) {
      const entry = await h.add(root, {
        kind: c.env === 'prod' ? 'prod-select' : 'select',
        title: titleOf(c.env, chk.sql, d, c.name),
        status: err ? '실패' : '조회',
        db: { env: c.env, name: c.name, account: run?.user ?? target?.user ?? c.readUser ?? c.user },
        sql: chk.sql,
        ...(run ? { affected: run.result.rowCount, maskedColumns: run.result.maskedColumns } : {}),
        ms,
        ...(err ? { error: err.message } : {}),
        ...(req.conversationId ? { conversationId: req.conversationId } : {}),
      });
      historyId = entry?.id;
    }
  } catch {
    // 이력을 못 남겨도 조회 결과는 돌려준다
  }
  if (err || !run) return { status: 'error', ...base, message: claudeError(err!, c, target), ...(historyId ? { historyId } : {}) };
  const r = run.result;
  const message =
    `${ENV_LABEL[c.env]} DB ${c.name} · ${r.rowCount.toLocaleString('ko-KR')}행${r.truncated ? `(최대 ${maxRows.toLocaleString('ko-KR')}행까지만)` : ''}` +
    (r.maskedColumns.length ? ` · ${msg('MSG-37', { n: r.maskedColumns.length })}` : '');
  return { status: 'ok', ...base, result: r, message, ...(historyId ? { historyId } : {}) };
}

// ------------------------------------------------------------------ 연결 확인

export async function testConnection(root: string, idOrInput: string | DbConnectionInput): Promise<DbTestResult> {
  let c: StoredConn;
  let override: { password?: string; readPassword?: string } | undefined;
  let saveId: string | undefined;
  let fp: string | undefined;
  if (typeof idOrInput === 'string') {
    const found = await getConn(root, idOrInput);
    if (!found) throw new DesktopError('DB 연결을 찾을 수 없습니다', 'notfound');
    c = found;
    saveId = found.id;
  } else {
    const n = normalizeInput(idOrInput);
    const prev = idOrInput.id ? await getConn(root, idOrInput.id) : null;
    c = { id: prev?.id ?? '', ...n };
    override = { password: idOrInput.password || undefined, readPassword: idOrInput.readPassword || undefined };
    fp = fingerprint(root, idOrInput);
    // 저장된 값 그대로 확인하면 결과를 그 연결에 남긴다
    if (prev && !override.password && !override.readPassword && sameTarget(prev, c)) {
      saveId = prev.id;
    }
  }
  const t0 = Date.now();
  const main = await targetFor(root, c, 'main', override);
  const read = await targetFor(root, c, 'read', override);
  const problems: string[] = [];
  let version: string | undefined;
  let detected: DbKind | undefined;
  let mainOk = false;
  if (c.user && !main) problems.push('계정 비밀번호를 넣어 주세요');
  if (c.readUser && !read) problems.push('조회 전용 계정 비밀번호를 넣어 주세요');
  let connectFailed = false;
  for (const [label, t] of [['계정', main], ['조회 전용 계정', read]] as const) {
    if (!t || connectFailed) continue;
    try {
      await withSession(t, async (s) => {
        version = s.version;
        detected = s.kind;
        await s.rows(s.dialect === 'oracle' ? 'SELECT 1 FROM DUAL' : 'SELECT 1', [], 10);
      });
      if (label === '계정') mainOk = true;
    } catch (e) {
      const err = describeError(e);
      problems.push(c.user && c.readUser ? `${label}(${t.user}): ${err.message}` : err.message);
      // 주소·포트 문제면 다른 계정도 같은 결과
      if (err.kind === 'connect' || err.kind === 'driver') connectFailed = true;
    }
  }
  void mainOk;
  const ok = problems.length === 0 && !!(main || read);
  const kindLabel = detected && c.kind !== 'oracle' && detected !== c.kind ? ` · 종류를 ${detected === 'mariadb' ? 'MariaDB' : 'MySQL'}로 바꿈` : '';
  const message = ok ? `연결됨 · ${version ?? ''}${read && main ? ' · 조회 전용 계정 확인' : ''}${kindLabel}` : problems.join(' / ') || '비밀번호를 넣어 주세요';
  const res: DbTestResult = { ok, message, ms: Date.now() - t0, ...(version ? { version } : {}), ...(detected ? { detectedKind: detected } : {}) };
  const lastTest = { ok, at: nowIso(), message, ...(version ? { version } : {}) };
  if (saveId) await setLastTest(root, saveId, lastTest, detected);
  if (fp) rememberTest(fp, lastTest);
  return res;
}

// ------------------------------------------------------------------ 메뉴 테이블

function menuRow(r: (string | number | null)[], hasOrder: boolean): MenuRow | null {
  const key = r[0] === null || r[0] === undefined ? '' : String(r[0]).trim();
  if (!key) return null;
  const p = r[1] === null || r[1] === undefined ? '' : String(r[1]).trim();
  const url = r[3] === null || r[3] === undefined ? '' : String(r[3]).trim();
  const o = hasOrder && r[4] !== null && r[4] !== '' ? Number(r[4]) : NaN;
  return {
    key,
    ...(p && p !== key ? { parentKey: p } : {}),
    name: r[2] === null || r[2] === undefined ? '' : String(r[2]).trim(),
    ...(url ? { url } : {}),
    ...(Number.isFinite(o) ? { order: o } : {}),
  };
}

export function menuSql(m: MenuDbSetting): string {
  const cols = [m.idCol, m.parentCol, m.nameCol, m.urlCol, ...(m.orderCol ? [m.orderCol] : [])];
  const where = (m.where ?? '').trim().replace(/^where\s+/i, '');
  return `SELECT ${cols.join(', ')} FROM ${m.table}${where ? ` WHERE ${where}` : ''}${m.orderCol ? ` ORDER BY ${m.orderCol}` : ''}`;
}

async function loadMenu(root: string, m: MenuDbSetting, limit: number): Promise<{ rows: MenuRow[]; error?: string; connName?: string; ms: number }> {
  const t0 = Date.now();
  const c = m?.connectionId ? await getConn(root, m.connectionId) : null;
  if (!c) return { rows: [], error: '메뉴를 읽을 DB 연결을 찾을 수 없습니다', ms: 0 };
  const fields: [string, string | undefined][] = [['테이블', m.table], ['ID 컬럼', m.idCol], ['상위 ID 컬럼', m.parentCol], ['이름 컬럼', m.nameCol], ['URL 컬럼', m.urlCol]];
  if (m.orderCol) fields.push(['순서 컬럼', m.orderCol]);
  for (const [label, v] of fields) {
    if (!isSafeIdent(v)) return { rows: [], error: `${label} 이름이 올바르지 않습니다 (영문·숫자·_·$·#·. 만)`, connName: c.name, ms: 0 };
  }
  const chk = checkReadOnly(menuSql(m), dialectOf(c.kind));
  if (!chk.ok) return { rows: [], error: `조건(WHERE)을 쓸 수 없습니다: ${chk.reason}`, connName: c.name, ms: 0 };
  const acct = await readTarget(root, c);
  if (!acct) return { rows: [], error: '계정 비밀번호가 저장되어 있지 않습니다', connName: c.name, ms: 0 };
  try {
    const out = await withSession(acct.target, async (s) => {
      await s.beginReadOnly(30);
      const r = await s.select(chk.sql, limit, 30);
      if (!r.truncated) await s.rollback().catch(() => undefined);
      return r;
    });
    const rows = out.rows.map((r) => menuRow(r, !!m.orderCol)).filter((x): x is MenuRow => !!x);
    return { rows, connName: c.name, ms: Date.now() - t0 };
  } catch (e) {
    return { rows: [], error: describeError(e, 30).message, connName: c.name, ms: Date.now() - t0 };
  }
}

/** 분석 전에 메뉴 테이블 읽기 (설정에서 켰을 때만, 조회 전용 계정, SELECT만, 최대 5,000행) */
export async function readMenu(root: string): Promise<MenuReadResult> {
  const st = await settingsOf(root);
  const m = st.menuDb;
  if (!m || !m.enabled) return { enabled: false, rows: [] };
  const r = await loadMenu(root, m, 5000);
  return { enabled: true, table: m.table, ...(r.connName ? { connectionName: r.connName } : {}), rows: r.rows, ...(r.error ? { error: r.error } : {}), ms: r.ms };
}

/** 설정 화면 [미리 보기]: 처음 20행 */
export async function previewMenu(root: string, setting: MenuDbSetting): Promise<{ rows: MenuRow[]; error?: string }> {
  if (!setting || typeof setting !== 'object') throw new DesktopError('메뉴 테이블 설정이 올바르지 않습니다', 'invalid');
  const r = await loadMenu(root, setting, 20);
  return { rows: r.rows, ...(r.error ? { error: r.error } : {}) };
}
