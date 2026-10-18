// DB 연결 보관: projectDir(root)/db.json (주소·계정, 비밀번호 제외) + 비밀번호는 비밀 값 'db:<프로젝트ID>:<연결ID>:pw' / ':readpw'.
// 화면에는 비밀번호 대신 hasPassword만, Claude에는 연결 ID·환경·이름만 보낸다.
import crypto from 'node:crypto';
import path from 'node:path';
import type { DbConnection, DbConnectionInput, DbKind, Env } from '../../shared/desktop-api';
import { DesktopError } from '../ipc';
import { deleteSecrets, getSecret, hasSecret, newId, projectDir, projectId, readJson, setSecret, withLock, writeJson } from '../store';
import type { ConnTarget } from './drivers';

export type StoredConn = Omit<DbConnection, 'hasPassword' | 'hasReadPassword'>;

interface DbFile {
  version: 1;
  connections: StoredConn[];
}

const ENVS: Env[] = ['dev', 'qa', 'prod'];
const KINDS: DbKind[] = ['oracle', 'mysql', 'mariadb'];
export const DEFAULT_PORT: Record<DbKind, number> = { oracle: 1521, mysql: 3306, mariadb: 3306 };

function file(root: string): string {
  return path.join(projectDir(root), 'db.json');
}

export function secretKey(root: string, id: string, which: 'pw' | 'readpw'): string {
  return `db:${projectId(root)}:${id}:${which}`;
}

/** 연결이 바뀌면 (테이블 정보 캐시 비우기 등) */
export const connChanged = new Set<(root: string, id: string) => void>();

function changed(root: string, id: string): void {
  for (const fn of connChanged) {
    try {
      fn(root, id);
    } catch {
      // 무시
    }
  }
}

export async function listStored(root: string): Promise<StoredConn[]> {
  const f = await readJson<Partial<DbFile>>(file(root), {});
  return Array.isArray(f.connections) ? f.connections.filter((c) => c && typeof c.id === 'string') : [];
}

async function writeAll(root: string, list: StoredConn[]): Promise<void> {
  await writeJson(file(root), { version: 1, connections: list } satisfies DbFile);
}

export async function withFlags(root: string, c: StoredConn): Promise<DbConnection> {
  return {
    ...c,
    hasPassword: !!c.user && (await hasSecret(secretKey(root, c.id, 'pw'))),
    hasReadPassword: !!c.readUser && (await hasSecret(secretKey(root, c.id, 'readpw'))),
  };
}

export async function listConns(root: string): Promise<DbConnection[]> {
  const list = await listStored(root);
  return Promise.all(list.map((c) => withFlags(root, c)));
}

export async function getConn(root: string, id: string): Promise<StoredConn | null> {
  return (await listStored(root)).find((c) => c.id === id) ?? null;
}

/** 연결 설명자에서 호스트 이름 (화면 표시용) */
function hostOfDescriptor(s: string): string {
  return (s.match(/\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i) ?? [])[1] ?? '';
}

function clean(s: unknown, max = 200): string {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

/** 입력 확인과 정리 (저장·연결 확인 공통) */
export function normalizeInput(input: DbConnectionInput): Omit<StoredConn, 'id' | 'lastTest'> {
  if (!input || typeof input !== 'object') throw new DesktopError('연결 정보가 올바르지 않습니다', 'invalid');
  const env = ENVS.includes(input.env) ? input.env : null;
  if (!env) throw new DesktopError('환경(개발·QA·운영)을 골라 주세요', 'invalid');
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new DesktopError('DB 종류를 골라 주세요', 'invalid');
  const name = clean(input.name, 60);
  if (!name) throw new DesktopError('DB 이름을 넣어 주세요', 'invalid');
  const service = clean(input.service, 2000);
  let host = clean(input.host, 255);
  if (kind === 'oracle' && service.startsWith('(') && !host) host = hostOfDescriptor(service);
  if (!host) throw new DesktopError('호스트를 넣어 주세요', 'invalid');
  if (/[\s()=;]/.test(host)) throw new DesktopError('호스트에 쓸 수 없는 글자가 있습니다', 'invalid');
  const portNum = Math.round(Number(input.port));
  const port = Number.isFinite(portNum) && portNum > 0 && portNum < 65536 ? portNum : DEFAULT_PORT[kind];
  const database = clean(input.database, 128);
  if (kind === 'oracle' && !service) throw new DesktopError('서비스 이름(또는 SID)을 넣어 주세요', 'invalid');
  if (kind !== 'oracle' && !database) throw new DesktopError('데이터베이스 이름을 넣어 주세요', 'invalid');
  const user = clean(input.user, 128);
  const readUser = clean(input.readUser, 128);
  if (!user && !readUser) throw new DesktopError('계정 또는 조회 전용 계정을 넣어 주세요', 'invalid');
  return {
    env,
    kind,
    name,
    host,
    port,
    ...(kind === 'oracle' ? { service, ...(input.sid ? { sid: true } : {}), ...(input.thick ? { thick: true } : {}) } : { database }),
    user,
    ...(readUser ? { readUser } : {}),
  };
}

// 연결 확인 결과를 [저장] 때 함께 남기기 위한 짧은 기억 (입력 지문 → 결과)
const recentTests = new Map<string, { at: number; lastTest: NonNullable<DbConnection['lastTest']> }>();

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function fingerprint(root: string, input: DbConnectionInput): string {
  let n: unknown;
  try {
    n = normalizeInput(input);
  } catch {
    n = input;
  }
  return sha(JSON.stringify([root, input.id ?? '', n, input.password ? sha(input.password) : '', input.readPassword ? sha(input.readPassword) : '']));
}

export function rememberTest(fp: string, lastTest: NonNullable<DbConnection['lastTest']>): void {
  recentTests.set(fp, { at: Date.now(), lastTest });
  for (const [k, v] of recentTests) if (Date.now() - v.at > 30 * 60_000) recentTests.delete(k);
}

const SAME_FIELDS: (keyof StoredConn)[] = ['kind', 'host', 'port', 'service', 'sid', 'database', 'user', 'readUser', 'thick'];

/** 접속에 쓰는 값이 같은지 (이름·환경은 보지 않음) */
export function sameTarget(a: Partial<StoredConn>, b: Partial<StoredConn>): boolean {
  return SAME_FIELDS.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

export async function saveConn(root: string, input: DbConnectionInput): Promise<DbConnection> {
  const n = normalizeInput(input);
  const fp = fingerprint(root, input);
  const saved = await withLock(file(root), async () => {
    const list = await listStored(root);
    const idx = input.id ? list.findIndex((c) => c.id === input.id) : -1;
    const prev = idx >= 0 ? list[idx] : null;
    const id = prev?.id ?? newId('c');
    const unchanged = !!prev && sameTarget(prev, n) && !input.password && !input.readPassword;
    const tested = recentTests.get(fp)?.lastTest;
    const next: StoredConn = { id, ...n, ...(tested ? { lastTest: tested } : unchanged && prev?.lastTest ? { lastTest: prev.lastTest } : {}) };
    // 비밀번호: 넣었을 때만 바꾸고, 계정을 지우면 비밀번호도 지운다
    if (input.password && n.user) await setSecret(secretKey(root, id, 'pw'), input.password);
    if (!n.user) await setSecret(secretKey(root, id, 'pw'), null);
    if (input.readPassword && n.readUser) await setSecret(secretKey(root, id, 'readpw'), input.readPassword);
    if (!n.readUser) await setSecret(secretKey(root, id, 'readpw'), null);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    await writeAll(root, list);
    return next;
  });
  changed(root, saved.id);
  return withFlags(root, saved);
}

export async function removeConn(root: string, id: string): Promise<void> {
  await withLock(file(root), async () => {
    const list = await listStored(root);
    const next = list.filter((c) => c.id !== id);
    if (next.length !== list.length) await writeAll(root, next);
  });
  await deleteSecrets(`db:${projectId(root)}:${id}:`);
  changed(root, id);
}

export async function setLastTest(root: string, id: string, lastTest: NonNullable<DbConnection['lastTest']>, detected?: DbKind): Promise<void> {
  await withLock(file(root), async () => {
    const list = await listStored(root);
    const c = list.find((x) => x.id === id);
    if (!c) return;
    c.lastTest = lastTest;
    // MySQL·MariaDB는 실제 서버에 맞춘다 (시간 제한 변수가 다르다)
    if (detected && c.kind !== 'oracle' && detected !== 'oracle') c.kind = detected;
    await writeAll(root, list);
  });
}

export type Account = 'main' | 'read';

/** 실제 접속 정보 (비밀번호 포함, 메인 프로세스 안에서만). 계정·비밀번호가 없으면 null */
export async function targetFor(root: string, c: StoredConn, account: Account, override?: { password?: string; readPassword?: string }): Promise<ConnTarget | null> {
  const user = account === 'read' ? c.readUser : c.user;
  if (!user) return null;
  const given = account === 'read' ? override?.readPassword : override?.password;
  const pw = given || (c.id ? await getSecret(secretKey(root, c.id, account === 'read' ? 'readpw' : 'pw')) : null);
  if (!pw) return null;
  return {
    kind: c.kind,
    host: c.host,
    port: c.port,
    service: c.service,
    sid: c.sid,
    database: c.database,
    user,
    password: pw,
    thick: c.thick,
  };
}

/** 조회에 쓸 계정: 조회 전용 계정(비밀번호까지 있으면), 없으면 계정 */
export async function readTarget(root: string, c: StoredConn): Promise<{ target: ConnTarget; account: Account } | null> {
  const r = await targetFor(root, c, 'read');
  if (r) return { target: r, account: 'read' };
  const m = await targetFor(root, c, 'main');
  return m ? { target: m, account: 'main' } : null;
}

/** 변경 쿼리를 실행할 수 있는지: 계정과 비밀번호가 있음 */
export async function canWrite(root: string, c: StoredConn): Promise<boolean> {
  return !!c.user && (await hasSecret(secretKey(root, c.id, 'pw')));
}
