// DB 모듈을 실제 MariaDB로 시험: 연결 저장·확인, Claude 조회(행 수·시간 제한·읽기 전용·가림), 쿼리 카드(확정·롤백·운영 DB 이름·실행 계정), 메뉴 읽기.
// 이 PC의 MariaDB(/usr/bin/mariadb)를 root 소켓으로 준비한다. 서버가 없으면 'service mariadb start'를 시도하고, 그래도 없으면 건너뛴다.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DbConnection, DbConnectionInput, DesktopEvent, HistoryEntry, QueryCard } from '../src/shared/desktop-api';
import { cardFromHistory } from '../src/desktop/db/cards';
import { dbService, register as registerDb } from '../src/desktop/db/index';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { register as registerProject } from '../src/desktop/project';
import { services, type HistoryService, type NewHistoryEntry } from '../src/desktop/services';
import { projectId } from '../src/desktop/store';
import { msg } from '../src/ui/desktop/messages';

const SOCK = '/run/mysqld/mysqld.sock';
const DB = 'pa_dtest';
const MAIN_PW = 'main-pw!1';
const READ_PW = 'read-pw!2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rootConn: any = null;
let available = false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-db-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-proj-'));
const events: DesktopEvent[] = [];
const history: HistoryEntry[] = [];

const fakeHistory: HistoryService = {
  async list() {
    return [...history].reverse();
  },
  async get(_root, id) {
    return history.find((h) => h.id === id) ?? null;
  },
  async add(_root, e: NewHistoryEntry) {
    const entry = { ...e, id: `h${history.length + 1}`, at: e.at ?? new Date().toISOString() } as HistoryEntry;
    history.push(entry);
    return entry;
  },
  async update(_root, id, patch) {
    const h = history.find((x) => x.id === id);
    if (!h) return null;
    Object.assign(h, patch);
    return h;
  },
  async addStep() {
    return null;
  },
};

async function maria() {
  return import('mariadb');
}

async function q(sql: string, values?: unknown[]): Promise<unknown> {
  return rootConn.query(sql, values);
}

async function count(where: string): Promise<number> {
  const r = (await q(`SELECT COUNT(*) n FROM ${DB}.TB_ORDER_HIST WHERE ${where}`)) as { n: bigint | number }[];
  return Number(r[0].n);
}

const base: DbConnectionInput = {
  id: '',
  env: 'dev',
  kind: 'mariadb',
  name: 'pa_dev',
  host: '127.0.0.1',
  port: 3306,
  database: DB,
  user: 'pa_main',
  password: MAIN_PW,
  readUser: 'pa_read',
  readPassword: READ_PW,
};

let dev: DbConnection;

before(async () => {
  const m = await maria();
  const connect = () => m.createConnection({ socketPath: SOCK, user: 'root', connectTimeout: 3000 });
  try {
    rootConn = await connect();
  } catch {
    try {
      execSync('service mariadb start', { stdio: 'ignore', timeout: 30000 });
      rootConn = await connect();
    } catch {
      rootConn = null;
    }
  }
  if (!rootConn) return;
  available = true;
  await q(`DROP DATABASE IF EXISTS ${DB}`);
  await q(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4`);
  await q(`CREATE TABLE ${DB}.TB_CUST (CUST_ID INT PRIMARY KEY, CUST_NM VARCHAR(50) COMMENT '고객 이름', CUST_TEL VARCHAR(20) COMMENT '연락처',
    EMAIL VARCHAR(100), MEMO VARCHAR(200) COMMENT '메모', GRADE_NM VARCHAR(20) COMMENT '등급명')`);
  await q(`INSERT INTO ${DB}.TB_CUST VALUES (1,'홍길동','010-1234-5678','hong@example.com','연락은 02-123-4567로','VIP'),
    (2,'김철수','010-2222-3333','kim@example.com','없음','일반'), (3,'이영희',NULL,'lee@ex.co.kr',NULL,'일반')`);
  await q(`CREATE TABLE ${DB}.TB_ORDER_HIST (HIST_ID INT AUTO_INCREMENT PRIMARY KEY, ORDER_NO VARCHAR(20), STAT CHAR(2), REG_DT DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const vals = Array.from({ length: 50 }, (_, i) => `('O${String(i + 1).padStart(4, '0')}', '${i < 30 ? '10' : '20'}')`).join(',');
  await q(`INSERT INTO ${DB}.TB_ORDER_HIST (ORDER_NO, STAT) VALUES ${vals}`);
  await q(`CREATE TABLE ${DB}.TB_MENU (MENU_ID VARCHAR(10) PRIMARY KEY, UPPER_MENU_ID VARCHAR(10), MENU_NM VARCHAR(50), MENU_URL VARCHAR(100), SORT_ORDR INT, USE_YN CHAR(1))`);
  await q(`INSERT INTO ${DB}.TB_MENU VALUES ('M0100', NULL, '회원관리', NULL, 1, 'Y'), ('M0110', 'M0100', '회원목록', '/user/list.do', 1, 'Y'),
    ('M0120', 'M0100', '휴면회원', '/user/dormant.do', 2, 'Y'), ('M0300', NULL, '주문관리', NULL, 3, 'Y'), ('M0310', 'M0300', '주문목록', '/order/list.do', 1, 'Y'),
    ('M0999', 'M0300', '안 쓰는 메뉴', '/old.do', 9, 'N')`);
  await q(`CREATE FUNCTION ${DB}.pa_write() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO TB_ORDER_HIST (ORDER_NO, STAT) VALUES ('FN', '99'); RETURN 1; END`);
  for (const host of ['localhost', '%']) {
    await q(`DROP USER IF EXISTS 'pa_main'@'${host}'`);
    await q(`DROP USER IF EXISTS 'pa_read'@'${host}'`);
    await q(`CREATE USER 'pa_main'@'${host}' IDENTIFIED BY '${MAIN_PW}'`);
    await q(`GRANT ALL ON ${DB}.* TO 'pa_main'@'${host}'`);
    await q(`CREATE USER 'pa_read'@'${host}' IDENTIFIED BY '${READ_PW}'`);
    await q(`GRANT SELECT ON ${DB}.* TO 'pa_read'@'${host}'`);
  }
  setHost(testHost(tmp));
  registerProject();
  services.history = fakeHistory;
  registerDb();
  addEventSink((ev) => events.push(ev));
});

after(async () => {
  if (rootConn) {
    await q(`DROP DATABASE IF EXISTS ${DB}`).catch(() => undefined);
    for (const host of ['localhost', '%']) {
      await q(`DROP USER IF EXISTS 'pa_main'@'${host}'`).catch(() => undefined);
      await q(`DROP USER IF EXISTS 'pa_read'@'${host}'`).catch(() => undefined);
    }
    await rootConn.end().catch(() => undefined);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

const noAsk = async () => {
  throw new Error('물어보면 안 됨');
};

async function setRule(env: 'dev' | 'qa' | 'prod', patch: Record<string, unknown>) {
  const cur = await call('project.get', root);
  await call('project.set', root, { dbRules: { ...cur.dbRules, [env]: { ...cur.dbRules[env], ...patch } } });
}

describe('MariaDB: 연결 저장·확인', () => {
  it('저장하면 비밀번호는 비밀 값에만, 화면에는 hasPassword만', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    dev = await call('db.save', root, base);
    assert.ok(dev.id);
    assert.equal(dev.hasPassword, true);
    assert.equal(dev.hasReadPassword, true);
    assert.equal((dev as unknown as Record<string, unknown>).password, undefined);
    const dbJson = fs.readFileSync(path.join(tmp, 'projects', projectId(root), 'db.json'), 'utf8');
    assert.ok(!dbJson.includes(MAIN_PW) && !dbJson.includes(READ_PW));
    const secrets = JSON.parse(fs.readFileSync(path.join(tmp, 'secrets.json'), 'utf8')) as Record<string, string>;
    assert.ok(secrets[`db:${projectId(root)}:${dev.id}:pw`]);
    assert.ok(secrets[`db:${projectId(root)}:${dev.id}:readpw`]);
    // 비밀번호를 비우고 저장하면 그대로 둔다
    const again = await call('db.save', root, { ...base, id: dev.id, password: '', readPassword: undefined, name: 'pa_dev' });
    assert.equal(again.hasPassword, true);
    assert.equal(again.hasReadPassword, true);
    const listed = await call('db.list', root);
    assert.equal(listed.length, 1);
    // 프로젝트 설정에도 함께 나온다
    assert.equal((await call('project.get', root)).db.length, 1);
  });

  it('연결 확인: 두 계정 모두, 버전·종류, 결과를 연결에 남김', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const r = await call('db.test', root, dev.id);
    assert.equal(r.ok, true, r.message);
    assert.match(r.version ?? '', /^MariaDB 10\./);
    assert.equal(r.detectedKind, 'mariadb');
    assert.match(r.message, /조회 전용 계정 확인/);
    const listed = (await call('db.list', root))[0];
    assert.equal(listed.lastTest?.ok, true);
  });

  it('연결 확인: 비밀번호가 틀림 / 연결 거부는 빠르게 실패', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const bad = await call('db.test', root, { ...base, password: 'nope', readUser: '', readPassword: '' });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /계정 또는 비밀번호가 맞지 않습니다/);
    const t0 = Date.now();
    const refused = await call('db.test', root, { ...base, port: 1 });
    assert.equal(refused.ok, false);
    assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
    assert.match(refused.message, /연결을 받지 않습니다/);
    // 연결 확인한 입력 그대로 저장하면 결과도 남는다
    const tested = await call('db.test', root, { ...base, name: 'pa_dev2', id: '' });
    assert.equal(tested.ok, true);
    const saved = await call('db.save', root, { ...base, name: 'pa_dev2', id: '' });
    assert.equal(saved.lastTest?.ok, true);
    await call('db.remove', root, saved.id);
  });
});

describe('MariaDB: Claude 조회', () => {
  it('행 수 제한·잘림 표시 (LIMIT이 더 커도 넘는 행은 읽지 않음)', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    await setRule('dev', { maxRows: 10, timeoutSec: 30, mask: false });
    const a = await dbService.select({ root, sql: 'SELECT * FROM TB_ORDER_HIST ORDER BY HIST_ID' }, noAsk);
    assert.equal(a.status, 'ok', a.message);
    assert.equal(a.env, 'dev');
    assert.equal(a.result?.rowCount, 10);
    assert.equal(a.result?.truncated, true);
    assert.deepEqual(a.result?.columns.map((c) => c.name), ['HIST_ID', 'ORDER_NO', 'STAT', 'REG_DT']);
    assert.match(String(a.result?.rows[0][3]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const b = await dbService.select({ root, sql: 'SELECT HIST_ID FROM TB_ORDER_HIST WHERE HIST_ID <= 5;' }, noAsk);
    assert.equal(b.result?.rowCount, 5);
    assert.equal(b.result?.truncated, false);
    const c = await dbService.select({ root, sql: 'SELECT a.HIST_ID FROM TB_ORDER_HIST a, TB_ORDER_HIST b LIMIT 100000' }, noAsk);
    assert.equal(c.result?.rowCount, 10);
    assert.equal(c.result?.truncated, true);
    const d = await dbService.select({ root, sql: 'SELECT HIST_ID FROM TB_ORDER_HIST', maxRows: 3 }, noAsk);
    assert.equal(d.result?.rowCount, 3);
    // 개발·QA 조회는 'select' 기록
    assert.ok(history.some((h) => h.kind === 'select' && h.status === '조회' && h.db?.account === 'pa_read'));
  });

  it('시간 제한: SELECT SLEEP(5)은 1초에 멈춘다', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    await setRule('dev', { timeoutSec: 1 });
    const t0 = Date.now();
    const r = await dbService.select({ root, sql: 'SELECT SLEEP(5)' }, noAsk);
    assert.equal(r.status, 'error');
    assert.match(r.message ?? '', /시간 제한/);
    assert.ok(Date.now() - t0 < 4500, `${Date.now() - t0}ms`);
    await setRule('dev', { timeoutSec: 30 });
  });

  it('SELECT 하나가 아니면 실행하지 않음', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    for (const sql of ["UPDATE TB_ORDER_HIST SET STAT = '99'", 'SELECT * FROM TB_ORDER_HIST FOR UPDATE', 'SELECT 1; DELETE FROM TB_ORDER_HIST', 'DROP TABLE TB_MENU']) {
      const r = await dbService.select({ root, sql }, noAsk);
      assert.equal(r.status, 'rejected', sql);
    }
    assert.equal(await count('1=1'), 50);
  });

  it('읽기 전용 세션: 쓰는 함수도 막힌다 (조회 전용 계정 없이 계정만 있을 때)', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const only = await call('db.save', root, { ...base, env: 'qa', name: 'pa_qa', readUser: '', readPassword: '' });
    const r = await dbService.select({ root, env: 'qa', sql: 'SELECT pa_write()' }, noAsk);
    assert.equal(r.status, 'error');
    assert.match(r.message ?? '', /읽기 전용/);
    assert.equal(await count("STAT = '99'"), 0);
    // 조회 전용 계정은 함수 실행 권한도 없다
    const r2 = await dbService.select({ root, sql: 'SELECT pa_write()' }, noAsk);
    assert.equal(r2.status, 'error');
    assert.equal(await count("STAT = '99'"), 0);
    await call('db.remove', root, only.id);
  });

  it('개인정보 가림: 원본 컬럼(별칭·함수·*)과 주석, 값 모양', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    await setRule('dev', { mask: true, maxRows: 200 });
    const r = await dbService.select(
      { root, sql: 'SELECT c.CUST_NM AS a, UPPER(c.CUST_TEL) t, c.GRADE_NM, c.MEMO, c.EMAIL, c.CUST_ID FROM TB_CUST c ORDER BY c.CUST_ID' },
      noAsk,
    );
    assert.equal(r.status, 'ok', r.message);
    const res = r.result!;
    assert.deepEqual(res.maskedColumns.sort(), ['EMAIL', 'MEMO', 'a', 't'].sort());
    assert.deepEqual(res.rows[0], ['****', '****', 'VIP', '연락은 ****로', '****', 1]);
    assert.deepEqual(res.rows[2], ['****', null, '일반', null, '****', 3]);
    assert.equal(res.rows[1][3], '없음');
    assert.match(r.message ?? '', /개인정보 컬럼 4개/);
    const star = await dbService.select({ root, sql: 'SELECT * FROM TB_CUST WHERE CUST_ID = 2' }, noAsk);
    const cols = star.result!.columns;
    assert.deepEqual(cols.filter((c) => c.masked).map((c) => c.name).sort(), ['CUST_NM', 'CUST_TEL', 'EMAIL'].sort());
    // 인라인 뷰·UNION도 원본 기준
    const inl = await dbService.select({ root, sql: 'SELECT x.n FROM (SELECT CUST_NM n FROM TB_CUST) x UNION SELECT GRADE_NM FROM TB_CUST' }, noAsk);
    assert.deepEqual(inl.result?.maskedColumns, ['n']);
    await setRule('dev', { mask: false });
    const plain = await dbService.select({ root, sql: 'SELECT CUST_NM FROM TB_CUST WHERE CUST_ID = 1' }, noAsk);
    assert.deepEqual(plain.result?.rows, [['홍길동']]);
  });

  it('운영 조회는 항상 묻고, 거부하면 실행하지 않음. 연결이 없으면 있는 환경을 알려 줌', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const none = await dbService.select({ root, env: 'prod', sql: 'SELECT 1' }, noAsk);
    assert.equal(none.status, 'none');
    assert.match(none.message ?? '', /개발\(dev\) pa_dev/);
    const prod = await call('db.save', root, { ...base, env: 'prod', name: 'pa_prd' });
    const asked: unknown[] = [];
    const denied = await dbService.select({ root, env: 'prod', sql: 'SELECT CUST_TEL FROM TB_CUST' }, async (a) => {
      asked.push(a);
      return false;
    });
    assert.equal(denied.status, 'denied');
    assert.deepEqual(asked, [{ env: 'prod', dbName: 'pa_prd', sql: 'SELECT CUST_TEL FROM TB_CUST', maxRows: 100, mask: true }]);
    const n = history.length;
    const ok = await dbService.select({ root, connectionId: prod.id, sql: 'SELECT CUST_TEL FROM TB_CUST' }, async () => true);
    assert.equal(ok.status, 'ok');
    assert.deepEqual(ok.result?.maskedColumns, ['CUST_TEL']);
    const h = history[n];
    assert.equal(h.kind, 'prod-select');
    assert.equal(h.status, '조회');
    assert.equal(h.affected, 3);
    assert.deepEqual(h.maskedColumns, ['CUST_TEL']);
    assert.equal(ok.historyId, h.id);
    await call('db.remove', root, prod.id);
  });

  it('연결 실패는 MSG-36 문구, 주소·계정은 Claude에 보내지 않음', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const broken = await call('db.save', root, { ...base, env: 'qa', name: 'pa_broken', port: 1 });
    const r = await dbService.select({ root, env: 'qa', sql: 'SELECT 1' }, noAsk);
    assert.equal(r.status, 'error');
    assert.ok((r.message ?? '').startsWith(msg('MSG-36', { DB: 'pa_broken' })), r.message);
    assert.ok(!/127\.0\.0\.1|pa_read|pa_main|read-pw|main-pw/.test(r.message ?? ''), r.message);
    await call('db.remove', root, broken.id);
  });
});

describe('MariaDB: 쿼리 카드', () => {
  it('예상 행 수가 맞으면 확정, 작업 이력에 실행됨', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const seen: QueryCard[] = [];
    const off = dbService.onCard((c) => seen.push(c));
    const card = await dbService.propose({ root, sql: "UPDATE TB_ORDER_HIST SET STAT = '30' WHERE STAT = '10';", description: '접수 상태 정리', revertSql: "UPDATE TB_ORDER_HIST SET STAT = '10' WHERE STAT = '30'", conversationId: 'conv1' });
    assert.equal(card.kind, 'update');
    assert.equal(card.estimate, 30);
    assert.equal(card.canExecute, true);
    assert.equal(card.irreversible, false);
    assert.equal(card.status, 'pending');
    assert.equal(card.sql, "UPDATE TB_ORDER_HIST SET STAT = '30' WHERE STAT = '10'");
    assert.ok(events.some((e) => e.type === 'db.card' && e.card.id === card.id));
    const done = await call('db.card.execute', card.id);
    assert.equal(done.status, 'done', JSON.stringify(done.result));
    assert.equal(done.result?.affected, 30);
    assert.equal(done.result?.expected, 30);
    assert.equal(await count("STAT = '30'"), 30);
    const h = history.find((x) => x.id === done.result?.historyId);
    assert.equal(h?.kind, 'query');
    assert.equal(h?.status, '실행됨');
    assert.equal(h?.title, '접수 상태 정리');
    assert.deepEqual(h?.db, { env: 'dev', name: 'pa_dev', account: 'pa_main' });
    assert.equal(h?.revertSql, "UPDATE TB_ORDER_HIST SET STAT = '10' WHERE STAT = '30'");
    assert.deepEqual(seen.map((c) => c.status), ['pending', 'running', 'done']);
    off();
    assert.equal((await call('db.card.get', card.id))?.status, 'done');
    await assert.rejects(call('db.card.execute', card.id), /이미 실행/);

    // 되돌리는 SQL로 새 카드 → 실행하면 원래 기록에 되돌림 표시
    const rev = await cardFromHistory(root, h!.id);
    assert.equal(rev.sql, h!.revertSql);
    assert.equal(rev.estimate, 30);
    const revDone = await call('db.card.execute', rev.id);
    assert.equal(revDone.status, 'done');
    assert.equal(await count("STAT = '10'"), 30);
    const revEntry = history.find((x) => x.id === revDone.result?.historyId);
    assert.equal(revEntry?.revertOf, h!.id);
    assert.equal(h?.revertedBy, revEntry?.id);
  });

  it('영향 행 수가 예상과 다르면 롤백하고 데이터는 그대로', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const card = await dbService.propose({ root, sql: "UPDATE TB_ORDER_HIST SET STAT = '40' WHERE STAT = '20'" });
    assert.equal(card.estimate, 20);
    await q(`INSERT INTO ${DB}.TB_ORDER_HIST (ORDER_NO, STAT) VALUES ('X1', '20')`);
    const r = await call('db.card.execute', card.id);
    assert.equal(r.status, 'rolledback');
    assert.equal(r.result?.rolledBack, true);
    assert.equal(r.result?.affected, 21);
    assert.equal(r.result?.expected, 20);
    assert.equal(await count("STAT = '40'"), 0);
    assert.equal(await count("STAT = '20'"), 21);
    assert.equal(history.find((x) => x.id === r.result?.historyId)?.status, '롤백됨');
  });

  it('운영은 DB 이름을 정확히 입력해야 실행', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const prod = await call('db.save', root, { ...base, env: 'prod', name: 'pa_prd' });
    const card = await dbService.propose({ root, env: 'prod', sql: "DELETE FROM TB_ORDER_HIST WHERE ORDER_NO = 'X1'" });
    assert.equal(card.env, 'prod');
    assert.equal(card.estimate, 1);
    await assert.rejects(call('db.card.execute', card.id), (e: Error & { code?: string }) => e.code === 'typeName');
    await assert.rejects(call('db.card.execute', card.id, 'pa_prod'), (e: Error & { code?: string }) => e.code === 'typeName');
    assert.equal(await count("ORDER_NO = 'X1'"), 1);
    const r = await call('db.card.execute', card.id, 'pa_prd');
    assert.equal(r.status, 'done');
    assert.equal(await count("ORDER_NO = 'X1'"), 0);
    await call('db.remove', root, prod.id);
  });

  it('조회 전용 계정만 있으면 실행할 수 없음 (MSG-39)', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const ro = await call('db.save', root, { ...base, env: 'qa', name: 'pa_qa_ro', user: '', password: '' });
    assert.equal(ro.hasPassword, false);
    const card = await dbService.propose({ root, env: 'qa', sql: "DELETE FROM TB_ORDER_HIST WHERE STAT = '10'" });
    assert.equal(card.canExecute, false);
    assert.equal(card.estimate, 30);
    await assert.rejects(call('db.card.execute', card.id), (e: Error & { code?: string }) => e.code === 'readonly' && e.message.startsWith('pa_qa_ro 연결은 조회 전용이라 DELETE'));
    assert.equal(await count("STAT = '10'"), 30);
    await call('db.remove', root, ro.id);
  });

  it('INSERT VALUES 행 수, DDL은 되돌릴 수 없음·예상 없이 실행, 거부', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    const ins = await dbService.propose({ root, sql: "INSERT INTO TB_ORDER_HIST (ORDER_NO, STAT) VALUES ('N1', '50'), ('N2', '50')" });
    assert.equal(ins.estimate, 2);
    assert.equal((await call('db.card.execute', ins.id)).status, 'done');
    const ddl = await dbService.propose({ root, sql: 'CREATE TABLE TB_TMP (A INT)' });
    assert.equal(ddl.kind, 'ddl');
    assert.equal(ddl.irreversible, true);
    assert.equal(ddl.estimate, undefined);
    assert.ok(ddl.estimateNote);
    assert.equal((await call('db.card.execute', ddl.id)).status, 'done');
    const r = (await q(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'TB_TMP'`)) as { n: bigint }[];
    assert.equal(Number(r[0].n), 1);
    const bad = await dbService.propose({ root, sql: 'DELETE FROM TB_NOPE WHERE 1 = 1' });
    assert.equal(bad.estimate, undefined);
    assert.match(bad.estimateNote ?? '', /세지 못했습니다/);
    const rejected = await call('db.card.reject', bad.id);
    assert.equal(rejected.status, 'rejected');
    await assert.rejects(call('db.card.execute', bad.id), /거부/);
    await assert.rejects(dbService.propose({ root, sql: 'SELECT 1' }), /조회 도구/);
    await assert.rejects(dbService.propose({ root, sql: 'DELETE FROM a; DELETE FROM b' }), /하나씩/);
    // SQL 오류는 실패로 남고 데이터는 그대로
    const fail = await dbService.propose({ root, sql: "UPDATE TB_ORDER_HIST SET NOPE = 1 WHERE STAT = '50'" });
    const fr = await call('db.card.execute', fail.id);
    assert.equal(fr.status, 'failed');
    assert.match(fr.result?.error ?? '', /NOPE/);
    assert.equal(history.find((x) => x.id === fr.result?.historyId)?.status, '실패');
  });
});

describe('MariaDB: 메뉴 테이블', () => {
  it('설정을 켜면 조회 전용 계정으로 읽고, 미리 보기는 20행까지', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    assert.deepEqual(await call('db.readMenu', root), { enabled: false, rows: [] });
    const setting = { enabled: true, connectionId: dev.id, table: 'TB_MENU', idCol: 'MENU_ID', parentCol: 'UPPER_MENU_ID', nameCol: 'MENU_NM', urlCol: 'MENU_URL', orderCol: 'SORT_ORDR', where: "USE_YN = 'Y'" };
    const pv = await call('db.previewMenu', root, setting);
    assert.equal(pv.error, undefined);
    assert.equal(pv.rows.length, 5);
    await call('project.set', root, { menuDb: setting });
    const m = await call('db.readMenu', root);
    assert.equal(m.enabled, true);
    assert.equal(m.table, 'TB_MENU');
    assert.equal(m.connectionName, 'pa_dev');
    assert.equal(m.error, undefined);
    assert.deepEqual(m.rows.find((r) => r.key === 'M0110'), { key: 'M0110', parentKey: 'M0100', name: '회원목록', url: '/user/list.do', order: 1 });
    assert.deepEqual(m.rows.find((r) => r.key === 'M0100'), { key: 'M0100', name: '회원관리', order: 1 });
    assert.ok(!m.rows.some((r) => r.key === 'M0999'));
    const bad = await call('db.previewMenu', root, { ...setting, table: 'TB_MENU; DROP TABLE TB_MENU' });
    assert.match(bad.error ?? '', /테이블 이름/);
    const badWhere = await call('db.previewMenu', root, { ...setting, where: "1=1; DELETE FROM TB_MENU" });
    assert.match(badWhere.error ?? '', /조건/);
    const missing = await call('db.previewMenu', root, { ...setting, table: 'TB_NOPE' });
    assert.match(missing.error ?? '', /TB_NOPE/);
    await call('project.set', root, { menuDb: { ...setting, table: 'TB_NOPE' } });
    const failed = await call('db.readMenu', root);
    assert.equal(failed.enabled, true);
    assert.equal(failed.rows.length, 0);
    assert.ok(failed.error);
  });

  it('연결을 지우면 비밀번호도 지운다', async (t) => {
    if (!available) return t.skip('MariaDB 없음');
    await call('db.remove', root, dev.id);
    const secrets = JSON.parse(fs.readFileSync(path.join(tmp, 'secrets.json'), 'utf8')) as Record<string, string>;
    assert.ok(!Object.keys(secrets).some((k) => k.includes(dev.id)));
    assert.deepEqual(await call('db.list', root), []);
  });
});
