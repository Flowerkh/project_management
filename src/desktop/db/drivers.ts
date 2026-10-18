// DB 드라이버: Oracle은 node-oracledb Thin 모드(12.1 이상, Oracle Client 설치 없이), 11g는 Thick 모드(Oracle Client 19 이상),
// MySQL·MariaDB는 MariaDB Connector 하나로. 드라이버는 처음 쓸 때 읽는다 (데스크톱 앱은 desktop/node_modules, 번들 밖).
// 연결은 작업 하나마다 열고 닫는다 (조회 세션의 읽기 전용·시간 제한 설정이 다른 작업에 남지 않게).
import type { DbKind } from '../../shared/desktop-api';
import type { Cell, ResultColInfo, TableInfo } from './mask';
import { nameKey, type Dialect, type TableRef } from './sql';

export interface ConnTarget {
  kind: DbKind;
  host: string;
  port: number;
  /** Oracle 서비스 이름 또는 SID (sid=true). '('로 시작하면 연결 설명자 그대로 */
  service?: string;
  sid?: boolean;
  /** MySQL·MariaDB 데이터베이스 */
  database?: string;
  user: string;
  password: string;
  thick?: boolean;
}

export type DbErrorKind = 'connect' | 'auth' | 'timeout' | 'readonly' | 'sql' | 'driver';

export class DbError extends Error {
  kind: DbErrorKind;
  code?: string;
  constructor(message: string, kind: DbErrorKind, code?: string) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

export interface QueryOut {
  columns: ResultColInfo[];
  rows: Cell[][];
  truncated: boolean;
}

export interface Session {
  /** 실제 서버 종류 (MySQL·MariaDB는 버전 문자열로 구분) */
  kind: DbKind;
  dialect: Dialect;
  /** 표시용 버전 (Oracle 19.3.0.0.0 / MariaDB 10.11.14 / MySQL 8.0.36) */
  version: string;
  /** 읽기 전용 트랜잭션 시작 + 시간 제한 */
  beginReadOnly(timeoutSec: number): Promise<void>;
  /** 변경 트랜잭션 시작 + 시간 제한 */
  beginWrite(timeoutSec: number): Promise<void>;
  /** 최대 limit행까지 읽는다. 더 있으면 truncated (나머지는 읽지 않음) */
  select(sql: string, limit: number, timeoutSec: number): Promise<QueryOut>;
  /** 작은 조회 (메타데이터·COUNT) */
  rows(sql: string, binds?: (string | number)[], timeoutSec?: number): Promise<Cell[][]>;
  /** DML·DDL 실행 → 영향 행 수 */
  exec(sql: string, timeoutSec: number, autoCommit: boolean): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** 테이블 컬럼·주석. 못 읽은 테이블은 null. 키: tableKey() */
  tableInfo(tables: TableRef[], timeoutSec: number): Promise<Map<string, TableInfo | null>>;
  close(): Promise<void>;
  /** 강제로 끊기 (시간 초과·남은 결과 버리기) */
  destroy(): void;
}

export const CONNECT_TIMEOUT_SEC = 10;
const MAX_CELL = 2000;

export function tableKey(t: { schema?: string; name: string }): string {
  return `${nameKey(t.schema ?? '')}.${nameKey(t.name)}`;
}

// ------------------------------------------------------------------ 값 변환

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function fmtDateCell(d: Date): string {
  if (Number.isNaN(d.getTime())) return String(d);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.getMilliseconds() ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/** 숫자 문자열: 정밀도를 잃지 않으면 숫자로 */
export function numCell(s: string): string | number {
  const t = s.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(E[-+]?\d+)?$/i.test(t)) return s;
  const digits = t.replace(/^[-+]/, '').replace(/E.*$/i, '').replace('.', '').replace(/^0+/, '');
  if (digits.length > 15) return t;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (typeof v === 'string') return v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return fmtDateCell(v);
  if (v instanceof Uint8Array) return `(이진 데이터 ${v.length.toLocaleString('ko-KR')}바이트)`;
  try {
    const s = JSON.stringify(v);
    return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
  } catch {
    return String(v);
  }
}

// ------------------------------------------------------------------ 오류

/** 오류 문구에서 주소·계정·비밀번호·IP를 가린다 (Claude에 보내는 문구) */
export function scrub(msg: string, secrets: (string | undefined)[]): string {
  let out = msg;
  for (const s of secrets) {
    if (!s || s.length < 2) continue;
    out = out.split(s).join('****');
  }
  out = out.replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '****');
  out = out.replace(/\(CONNECTION_ID=[^)]*\)/g, '').replace(/'[^'@\s]*'@'[^'\s]*'/g, "'****'@'****'");
  return out.replace(/\s+/g, ' ').trim();
}

function firstLine(s: string): string {
  return s.split('\n')[0].replace(/\s*\(CONNECTION_ID=[^)]*\)/, '').trim();
}

/** 드라이버 오류 → 분류와 한국어 문구 (화면용, 드라이버 코드 포함) */
export function describeError(e: unknown, timeoutSec?: number): DbError {
  if (e instanceof DbError) return e;
  const err = e as { message?: string; code?: string; errno?: number; errorNum?: number; sqlMessage?: string };
  const raw = String(err?.sqlMessage || err?.message || e);
  const msg = firstLine(raw);
  const code = String(err?.code ?? '');
  const has = (re: RegExp) => re.test(code) || re.test(raw);
  const tag = (c: string) => (c ? ` (${c})` : '');
  const oraCode = (raw.match(/\b(ORA|NJS|DPI)-\d{3,5}\b/) ?? [])[0] ?? '';
  if (has(/ORA-01017|ER_ACCESS_DENIED_ERROR|ER_DBACCESS_DENIED|Access denied for user/)) {
    if (has(/ER_DBACCESS_DENIED/)) return new DbError(`이 계정으로 데이터베이스에 들어갈 권한이 없습니다${tag(code)}`, 'auth', code);
    return new DbError(`계정 또는 비밀번호가 맞지 않습니다${tag(oraCode || code)}`, 'auth', oraCode || code);
  }
  if (has(/ORA-28000/)) return new DbError('계정이 잠겼습니다 (ORA-28000)', 'auth', 'ORA-28000');
  if (has(/ORA-28001/)) return new DbError('비밀번호가 만료되었습니다 (ORA-28001)', 'auth', 'ORA-28001');
  if (has(/ORA-12514|NJS-518/)) return new DbError(`서비스 이름을 찾을 수 없습니다${tag(oraCode)}`, 'connect', oraCode);
  if (has(/ORA-12505|NJS-519/)) return new DbError(`SID를 찾을 수 없습니다${tag(oraCode)}`, 'connect', oraCode);
  if (has(/NJS-138/)) {
    return new DbError("Thin 모드로 연결할 수 없는 Oracle 버전입니다(11g 이하). 연결 설정에서 'Oracle 11g 이하 (Thick 모드)'를 켜 주세요 (NJS-138)", 'driver', 'NJS-138');
  }
  if (has(/NJS-116/)) {
    return new DbError("이 계정의 비밀번호 방식은 Thin 모드에서 쓸 수 없습니다. 연결 설정에서 'Thick 모드'를 켜거나 DBA에게 비밀번호 재설정을 요청해 주세요 (NJS-116)", 'driver', 'NJS-116');
  }
  if (has(/DPI-1047|DPI-1072|NJS-045/)) {
    return new DbError(`Oracle 11g 연결(Thick 모드)에는 PC에 Oracle Client 19 이상(Instant Client)이 필요합니다. 설치한 뒤 PATH에 넣고 앱을 다시 시작해 주세요${tag(oraCode)}`, 'driver', oraCode);
  }
  if (has(/NJS-089|NJS-077/)) return new DbError(`Thick 모드는 앱을 다시 시작한 뒤 처음 연결할 때만 켤 수 있습니다${tag(oraCode)}`, 'driver', oraCode);
  if (has(/ECONNREFUSED|NJS-503|ORA-12541/)) return new DbError(`서버가 연결을 받지 않습니다. 주소와 포트를 확인해 주세요${tag(oraCode || 'ECONNREFUSED')}`, 'connect', oraCode || 'ECONNREFUSED');
  if (has(/ENOTFOUND|EAI_AGAIN|NJS-530|ORA-12545/)) return new DbError(`서버 주소를 찾을 수 없습니다${tag(oraCode || code)}`, 'connect', oraCode || code);
  if (has(/NJS-510|ETIMEDOUT|ER_CONNECTION_TIMEOUT|ORA-12170|Connection timeout|connect timed out/i)) {
    return new DbError(`연결 시간(${CONNECT_TIMEOUT_SEC}초)이 지났습니다. 사내망 연결과 방화벽을 확인해 주세요${tag(oraCode || code)}`, 'connect', oraCode || code);
  }
  if (has(/NJS-500|NJS-501|NJS-521|ECONNRESET|EPIPE|ER_SOCKET_UNEXPECTED_CLOSE|PROTOCOL_CONNECTION_LOST|ER_CONNECTION_ALREADY_CLOSED/)) {
    return new DbError(`DB 서버와의 연결이 끊겼습니다${tag(oraCode || code)}`, 'connect', oraCode || code);
  }
  if (has(/ER_BAD_DB_ERROR|Unknown database/)) return new DbError(`데이터베이스를 찾을 수 없습니다${tag(code)}`, 'connect', code);
  if (has(/ER_STATEMENT_TIMEOUT|ER_QUERY_TIMEOUT|max_statement_time|maximum statement execution time|NJS-123|DPI-1067|ORA-01013|ER_CMD_NOT_EXECUTED_DESTROYED/)) {
    return new DbError(`시간 제한${timeoutSec ? `(${timeoutSec}초)` : ''}을 넘어 실행을 멈췄습니다${tag(oraCode || code)}`, 'timeout', oraCode || code);
  }
  if (has(/ORA-01456|ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION|READ ONLY transaction/)) {
    return new DbError(`읽기 전용 세션이라 데이터를 바꿀 수 없습니다${tag(oraCode || code)}`, 'readonly', oraCode || code);
  }
  return new DbError(msg.length > 300 ? `${msg.slice(0, 300)}…` : msg, 'sql', oraCode || code);
}

/** 정해진 시간 안에 끝나지 않으면 onTimeout을 부르고 시간 초과 오류 */
async function within<T>(p: Promise<T>, ms: number, onTimeout: () => void, timeoutSec: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        // 무시
      }
      reject(new DbError(`시간 제한(${timeoutSec}초)을 넘어 실행을 멈췄습니다`, 'timeout', 'TIMEOUT'));
    }, ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ Oracle

/* eslint-disable @typescript-eslint/no-explicit-any */
type OraMod = any;
let oraMod: OraMod | null = null;
let thickState: 'none' | 'ok' | Error = 'none';
let usedThin = false;
let thickHint: (() => Promise<boolean>) | null = null;

/** 저장된 연결 중 Thick 모드(11g)가 있는지 알려 주는 함수. Thick 모드는 첫 Oracle 연결 전에만 켤 수 있어서,
 *  있으면 처음부터 Thick 모드로 시작한다 (Thick 모드도 12c 이상에 연결된다) */
export function setThickHint(fn: () => Promise<boolean>): void {
  thickHint = fn;
}

async function loadOracle(thick: boolean): Promise<OraMod> {
  if (!oraMod) {
    let m: any;
    try {
      m = await import('oracledb');
    } catch (e) {
      throw new DbError(`Oracle 드라이버(oracledb)를 읽지 못했습니다: ${firstLine(String((e as Error)?.message ?? e))}`, 'driver', 'NO_DRIVER');
    }
    oraMod = m.default ?? m;
  }
  const ora = oraMod;
  let wantThick = thick;
  if (!wantThick && thickState === 'none' && !usedThin && thickHint) wantThick = await thickHint().catch(() => false);
  if (wantThick && thickState === 'none') {
    if (usedThin) throw new DbError('이미 Thin 모드로 연결했습니다. Oracle 11g(Thick 모드)로 연결하려면 앱을 다시 시작해 주세요', 'driver', 'THIN_USED');
    try {
      const libDir = process.env.PA_ORACLE_CLIENT_DIR;
      ora.initOracleClient(libDir ? { libDir } : undefined);
      thickState = 'ok';
    } catch (e) {
      thickState = e as Error;
    }
  }
  if (thick && thickState instanceof Error) throw describeError(thickState);
  if (thickState !== 'ok') usedThin = true;
  return ora;
}

/** Oracle 연결 문자열: 서비스 이름·SID·연결 설명자. 시간 제한을 설명자에 넣는다 (Thin·Thick 모두) */
export function oracleConnectString(t: Pick<ConnTarget, 'host' | 'port' | 'service' | 'sid'>, timeoutSec = CONNECT_TIMEOUT_SEC): string {
  const svc = (t.service ?? '').trim();
  if (svc.startsWith('(')) return svc;
  const host = t.host.trim();
  if (!host) throw new DbError('호스트를 넣어 주세요', 'connect', 'NO_HOST');
  if (!svc) throw new DbError('서비스 이름(또는 SID)을 넣어 주세요', 'connect', 'NO_SERVICE');
  if (/[()=]/.test(host) || /[()=\s]/.test(svc)) throw new DbError('호스트·서비스 이름에 쓸 수 없는 글자가 있습니다', 'connect', 'BAD_NAME');
  const port = Number(t.port) || 1521;
  const data = t.sid ? `(SID=${svc})` : `(SERVICE_NAME=${svc})`;
  return `(DESCRIPTION=(CONNECT_TIMEOUT=${timeoutSec})(TRANSPORT_CONNECT_TIMEOUT=${timeoutSec})(RETRY_COUNT=0)(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=${data}))`;
}

async function openOracle(t: ConnTarget, connectTimeoutSec: number): Promise<Session> {
  const ora = await loadOracle(!!t.thick);
  let conn: any;
  try {
    const p = ora.getConnection({ user: t.user, password: t.password, connectString: oracleConnectString(t, connectTimeoutSec) }) as Promise<any>;
    conn = await within(p, (connectTimeoutSec + 5) * 1000, () => lateClose(p), connectTimeoutSec);
  } catch (e) {
    throw describeError(e);
  }
  const numHandler = (m: any) => {
    if (m.dbType === ora.DB_TYPE_NUMBER) return { type: ora.STRING, converter: (v: string | null) => (v === null ? null : numCell(v)) };
    if (m.dbType === ora.DB_TYPE_CLOB || m.dbType === ora.DB_TYPE_NCLOB) return { type: ora.STRING };
    if (m.dbType === ora.DB_TYPE_BLOB) return { type: ora.BUFFER };
    if (ora.DB_TYPE_JSON && m.dbType === ora.DB_TYPE_JSON) return undefined;
    return undefined;
  };
  const setTimeoutMs = (sec: number) => {
    try {
      conn.callTimeout = Math.max(1, sec) * 1000;
    } catch {
      // 무시
    }
  };
  const guard = <T>(p: Promise<T>, sec: number): Promise<T> =>
    within(p, (sec + 3) * 1000, () => conn.break?.().catch?.(() => undefined), sec).catch((e) => {
      throw describeError(e, sec);
    });
  const ver = String(conn.oracleServerVersionString ?? '');
  const s: Session = {
    kind: 'oracle',
    dialect: 'oracle',
    version: ver ? `Oracle ${ver}` : 'Oracle',
    async beginReadOnly(sec) {
      setTimeoutMs(sec);
      await guard(conn.execute('SET TRANSACTION READ ONLY'), sec);
    },
    async beginWrite(sec) {
      setTimeoutMs(sec);
    },
    async select(sql, limit, sec) {
      setTimeoutMs(sec);
      const run = async (): Promise<QueryOut> => {
        const r = await conn.execute(sql, [], {
          resultSet: true,
          outFormat: ora.OUT_FORMAT_ARRAY,
          fetchArraySize: Math.min(limit + 1, 500),
          fetchTypeHandler: numHandler,
        });
        const rs = r.resultSet;
        const columns: ResultColInfo[] = (r.metaData ?? rs?.metaData ?? []).map((m: any) => ({ name: String(m.name) }));
        let rows: unknown[][] = [];
        try {
          rows = rs ? await rs.getRows(limit + 1) : (r.rows ?? []);
        } finally {
          await rs?.close().catch(() => undefined);
        }
        const truncated = rows.length > limit;
        return { columns, rows: rows.slice(0, limit).map((row) => row.map(toCell)), truncated };
      };
      return guard(run(), sec);
    },
    async rows(sql, binds = [], sec = 30) {
      setTimeoutMs(sec);
      const r = await guard<any>(conn.execute(sql, binds, { outFormat: ora.OUT_FORMAT_ARRAY, maxRows: 20000, fetchTypeHandler: numHandler }), sec);
      return (r.rows ?? []).map((row: unknown[]) => row.map(toCell));
    },
    async exec(sql, sec, autoCommit) {
      setTimeoutMs(sec);
      const r = await guard<any>(conn.execute(sql, [], { autoCommit }), sec);
      return Number(r.rowsAffected ?? 0);
    },
    async commit() {
      await conn.commit();
    },
    async rollback() {
      await conn.rollback();
    },
    async tableInfo(tables, sec) {
      return oracleTableInfo(s, tables, sec);
    },
    async close() {
      try {
        await conn.close();
      } catch {
        // 이미 끊김
      }
    },
    destroy() {
      try {
        conn.close().catch?.(() => undefined);
      } catch {
        // 무시
      }
    },
  };
  return s;
}

/** 시간 초과 뒤 늦게 열린 연결은 바로 닫는다 */
function lateClose(p: Promise<any>): void {
  p.then(
    (c) => {
      try {
        const r = c?.end?.() ?? c?.close?.();
        r?.catch?.(() => undefined);
      } catch {
        // 무시
      }
    },
    () => undefined,
  );
}

async function oracleTableInfo(s: Session, tables: TableRef[], sec: number): Promise<Map<string, TableInfo | null>> {
  const out = new Map<string, TableInfo | null>();
  if (!tables.length) return out;
  const names = [...new Set(tables.map((t) => t.name))].slice(0, 200);
  const cur = String((await s.rows("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL", [], sec))[0]?.[0] ?? '');
  // 동의어 (조회 전용 계정은 동의어로 다른 스키마의 테이블을 보는 경우가 많다)
  const syn = new Map<string, { owner: string; table: string }>();
  {
    const binds = names.map((_, i) => `:${i + 2}`).join(', ');
    const rows = await s.rows(
      `SELECT OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME FROM ALL_SYNONYMS WHERE OWNER IN (:1, 'PUBLIC') AND SYNONYM_NAME IN (${binds}) AND DB_LINK IS NULL`,
      [cur, ...names],
      sec,
    ).catch(() => [] as Cell[][]);
    // 개인 동의어가 공용보다 먼저
    rows.sort((a, b) => (a[0] === 'PUBLIC' ? 1 : 0) - (b[0] === 'PUBLIC' ? 1 : 0));
    for (const r of rows) {
      const k = String(r[1]);
      if (!syn.has(k)) syn.set(k, { owner: String(r[2]), table: String(r[3]) });
    }
  }
  const want = new Set(names);
  for (const v of syn.values()) want.add(v.table);
  const list = [...want].slice(0, 300);
  const binds = list.map((_, i) => `:${i + 1}`).join(', ');
  const rows = await s.rows(
    `SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, m.COMMENTS FROM ALL_TAB_COLUMNS c
       LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.TABLE_NAME IN (${binds}) ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID`,
    list,
    sec,
  );
  const byOwner = new Map<string, Map<string, TableInfo>>();
  for (const r of rows) {
    const owner = String(r[0]);
    const table = String(r[1]);
    const m = byOwner.get(table) ?? new Map<string, TableInfo>();
    byOwner.set(table, m);
    const ti = m.get(owner) ?? { schema: owner, name: table, columns: [] };
    m.set(owner, ti);
    ti.columns.push({ name: String(r[2]), comment: r[3] === null ? null : String(r[3]) });
  }
  for (const t of tables) {
    const owners = byOwner.get(t.name);
    let info: TableInfo | null = null;
    if (t.schema) info = owners?.get(t.schema) ?? null;
    else if (owners?.get(cur)) info = owners.get(cur) ?? null;
    else if (syn.has(t.name)) {
      const sy = syn.get(t.name)!;
      info = byOwner.get(sy.table)?.get(sy.owner) ?? null;
    } else if (owners && owners.size) {
      // 어느 스키마인지 모름: 모두 합쳐 주석 조건을 넓게 본다
      const merged: TableInfo = { name: t.name, columns: [] };
      for (const ti of owners.values()) {
        for (const c of ti.columns) {
          const ex = merged.columns.find((x) => x.name === c.name);
          if (!ex) merged.columns.push({ ...c });
          else if (c.comment) ex.comment = `${ex.comment ?? ''} ${c.comment}`.trim();
        }
      }
      info = merged;
    }
    out.set(tableKey(t), info);
  }
  return out;
}

// ------------------------------------------------------------------ MySQL·MariaDB

let mariaMod: any | null = null;

async function loadMaria(): Promise<any> {
  if (mariaMod) return mariaMod;
  let m: any;
  try {
    m = await import('mariadb');
  } catch (e) {
    throw new DbError(`MySQL·MariaDB 드라이버(mariadb)를 읽지 못했습니다: ${firstLine(String((e as Error)?.message ?? e))}`, 'driver', 'NO_DRIVER');
  }
  mariaMod = m.createConnection ? m : (m.default ?? m);
  return mariaMod;
}

function mariaVersion(raw: string): { kind: DbKind; label: string } {
  const isMaria = /mariadb/i.test(raw);
  const num = (raw.match(/^(?:5\.5\.5-)?(\d+\.\d+\.\d+)/) ?? [])[1] ?? raw;
  return { kind: isMaria ? 'mariadb' : 'mysql', label: `${isMaria ? 'MariaDB' : 'MySQL'} ${num}` };
}

async function openMaria(t: ConnTarget, connectTimeoutSec: number): Promise<Session> {
  const mdb = await loadMaria();
  if (!t.host.trim()) throw new DbError('호스트를 넣어 주세요', 'connect', 'NO_HOST');
  let conn: any;
  try {
    let pending: Promise<any> | null = null;
    conn = await within(
      (pending = mdb.createConnection({
        host: t.host.trim(),
        port: Number(t.port) || 3306,
        user: t.user,
        password: t.password,
        database: t.database?.trim() || undefined,
        connectTimeout: connectTimeoutSec * 1000,
        dateStrings: true,
        multipleStatements: false,
        permitLocalInfile: false,
        foundRows: true,
        checkDuplicate: false,
        // MySQL 8 기본 인증(caching_sha2_password)을 SSL 없이 쓰려면 서버 공개 키가 필요하다
        allowPublicKeyRetrieval: t.kind === 'mysql',
      }) as Promise<any>),
      (connectTimeoutSec + 5) * 1000,
      () => pending && lateClose(pending),
      connectTimeoutSec,
    );
  } catch (e) {
    throw describeError(e);
  }
  const q = (sql: string, values?: unknown[]) => conn.query({ sql, rowsAsArray: true }, values);
  // MySQL·MariaDB 구분은 SELECT VERSION()으로 (중계 서버가 있으면 접속 인사의 버전과 다를 수 있다)
  let rawVersion = String(conn.serverVersion?.() ?? conn.info?.serverVersion?.raw ?? '');
  try {
    const r = await within(q('SELECT VERSION()') as Promise<unknown[][]>, (connectTimeoutSec + 2) * 1000, () => conn.destroy(), connectTimeoutSec);
    if (r?.[0]?.[0]) rawVersion = String(r[0][0]);
  } catch (e) {
    try {
      conn.destroy();
    } catch {
      // 무시
    }
    throw describeError(e);
  }
  const ver = mariaVersion(rawVersion);
  const isMaria = ver.kind === 'mariadb';
  const setTime = async (sec: number, select: boolean) => {
    // MariaDB max_statement_time(초)은 모든 문장, MySQL max_execution_time(ms)은 SELECT만
    try {
      if (isMaria) await q(`SET SESSION max_statement_time = ${Math.max(1, sec)}`);
      else if (select) await q(`SET SESSION max_execution_time = ${Math.max(1, sec) * 1000}`);
    } catch {
      // 오래된 서버: 아래 시계로만 멈춘다
    }
  };
  const guard = <T>(p: Promise<T>, sec: number): Promise<T> =>
    within(p, (sec + 3) * 1000, () => conn.destroy(), sec).catch((e) => {
      throw describeError(e, sec);
    });
  const s: Session = {
    kind: ver.kind,
    dialect: 'mysql',
    version: ver.label,
    async beginReadOnly(sec) {
      await guard(
        (async () => {
          await q('SET SESSION TRANSACTION READ ONLY');
          await setTime(sec, true);
          await q('START TRANSACTION READ ONLY');
        })(),
        sec,
      );
    },
    async beginWrite(sec) {
      await guard(
        (async () => {
          await setTime(sec, false);
          await conn.beginTransaction();
        })(),
        sec,
      );
    },
    select(sql, limit, sec) {
      const run = new Promise<QueryOut>((resolve, reject) => {
        const rows: Cell[][] = [];
        let columns: ResultColInfo[] = [];
        let done = false;
        const stream = conn.queryStream({ sql, rowsAsArray: true });
        stream.on('fields', (meta: any[]) => {
          columns = (meta ?? []).map((m: any) => ({
            name: String(m.name?.() ?? ''),
            orgName: String(m.orgName?.() ?? '') || undefined,
            orgTable: String(m.orgTable?.() ?? '') || undefined,
            db: String(m.db?.() ?? '') || undefined,
          }));
        });
        stream.on('data', (row: unknown[]) => {
          if (done) return;
          if (rows.length >= limit) {
            // 넘는 행이 있음: 나머지는 읽지 않고 연결을 끊는다 (서버의 실행도 멈춤)
            done = true;
            try {
              stream.pause();
            } catch {
              // 무시
            }
            try {
              conn.destroy();
            } catch {
              // 무시
            }
            resolve({ columns, rows, truncated: true });
            return;
          }
          rows.push(row.map(toCell));
        });
        stream.on('error', (e: unknown) => {
          if (done) return;
          done = true;
          reject(e);
        });
        stream.on('end', () => {
          if (done) return;
          done = true;
          resolve({ columns, rows, truncated: false });
        });
      });
      return guard(run, sec);
    },
    async rows(sql, binds = [], sec = 30) {
      const r = await guard<any>(q(sql, binds), sec);
      return (Array.isArray(r) ? r : []).map((row: unknown[]) => row.map(toCell));
    },
    async exec(sql, sec, autoCommit) {
      void autoCommit;
      const r = await guard<any>(conn.query({ sql }), sec);
      const one = Array.isArray(r) ? r[r.length - 1] : r;
      return Number(one?.affectedRows ?? 0);
    },
    async commit() {
      await conn.commit();
    },
    async rollback() {
      await conn.rollback();
    },
    async tableInfo(tables, sec) {
      const out = new Map<string, TableInfo | null>();
      if (!tables.length) return out;
      const cur = String((await s.rows('SELECT DATABASE()', [], sec))[0]?.[0] ?? '');
      const bySchema = new Map<string, TableRef[]>();
      for (const t of tables) {
        const sc = t.schema ?? cur;
        const arr = bySchema.get(sc) ?? [];
        arr.push(t);
        bySchema.set(sc, arr);
      }
      const found = new Map<string, TableInfo>();
      for (const [schema, list] of bySchema) {
        const names = [...new Set(list.map((t) => nameKey(t.name)))].slice(0, 200);
        const rows = await s.rows(
          `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND UPPER(TABLE_NAME) IN (${names.map(() => '?').join(', ')}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [schema, ...names],
          sec,
        );
        for (const r of rows) {
          const k = `${nameKey(String(r[0]))}.${nameKey(String(r[1]))}`;
          const ti = found.get(k) ?? { schema: String(r[0]), name: String(r[1]), columns: [] };
          found.set(k, ti);
          ti.columns.push({ name: String(r[2]), comment: r[3] === null ? null : String(r[3]) });
        }
      }
      for (const t of tables) {
        const k = `${nameKey(t.schema ?? cur)}.${nameKey(t.name)}`;
        out.set(tableKey(t), found.get(k) ?? null);
      }
      return out;
    },
    async close() {
      try {
        await conn.end();
      } catch {
        try {
          conn.destroy();
        } catch {
          // 무시
        }
      }
    },
    destroy() {
      try {
        conn.destroy();
      } catch {
        // 무시
      }
    },
  };
  return s;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------ 열기

const open = new Set<Session>();

export async function openSession(t: ConnTarget, opts: { connectTimeoutSec?: number } = {}): Promise<Session> {
  const sec = opts.connectTimeoutSec ?? CONNECT_TIMEOUT_SEC;
  const s = t.kind === 'oracle' ? await openOracle(t, sec) : await openMaria(t, sec);
  open.add(s);
  const close = s.close.bind(s);
  const destroy = s.destroy.bind(s);
  s.close = async () => {
    open.delete(s);
    await close();
  };
  s.destroy = () => {
    open.delete(s);
    destroy();
  };
  return s;
}

/** 앱을 끝낼 때: 열린 연결을 모두 끊는다 */
export async function closeAll(): Promise<void> {
  const all = [...open];
  open.clear();
  await Promise.all(all.map((s) => Promise.race([s.close(), new Promise((r) => setTimeout(r, 1500))]).catch(() => s.destroy())));
}

/** 세션을 열어 fn을 실행하고 반드시 닫는다 */
export async function withSession<T>(t: ConnTarget, fn: (s: Session) => Promise<T>, opts: { connectTimeoutSec?: number } = {}): Promise<T> {
  const s = await openSession(t, opts);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}
