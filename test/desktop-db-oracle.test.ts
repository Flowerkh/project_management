// Oracle: 서버 없이 시험할 수 있는 것 (연결 문자열, Thin 모드 연결 실패가 빨리·알아듣게 끝나는지, 오류 문구).
// 실제 Oracle 12c 이상(Thin)·11g(Thick, Oracle Client 19 이상) 연결은 사용자 PC에서 확인한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describeError, numCell, openSession, oracleConnectString, scrub, toCell, type ConnTarget } from '../src/desktop/db/drivers';
import { register as registerDb } from '../src/desktop/db/index';
import { setHost, testHost } from '../src/desktop/host';
import { call } from '../src/desktop/ipc';

const ora = (over: Partial<ConnTarget> = {}): ConnTarget => ({
  kind: 'oracle', host: '127.0.0.1', port: 1, service: 'ORCLPDB1', user: 'shop_app', password: 'secret-pw', ...over,
});

describe('Oracle 연결 문자열', () => {
  it('서비스 이름·SID·연결 설명자', () => {
    assert.equal(
      oracleConnectString({ host: 'db-dev.company.local', port: 1521, service: 'SHOPDEV' }),
      '(DESCRIPTION=(CONNECT_TIMEOUT=10)(TRANSPORT_CONNECT_TIMEOUT=10)(RETRY_COUNT=0)(ADDRESS=(PROTOCOL=TCP)(HOST=db-dev.company.local)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=SHOPDEV)))',
    );
    assert.match(oracleConnectString({ host: 'h', port: 1522, service: 'ORCL', sid: true }, 3), /\(CONNECT_TIMEOUT=3\).*\(PORT=1522\)\)\(CONNECT_DATA=\(SID=ORCL\)\)\)$/);
    assert.match(oracleConnectString({ host: 'h', port: 0, service: 'svc' }), /\(PORT=1521\)/);
    const desc = '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=y)))';
    assert.equal(oracleConnectString({ host: '', port: 1521, service: desc }), desc);
  });
  it('빈 값·이상한 글자는 거부', () => {
    assert.throws(() => oracleConnectString({ host: '', port: 1521, service: 'x' }), /호스트/);
    assert.throws(() => oracleConnectString({ host: 'h', port: 1521, service: '' }), /서비스/);
    assert.throws(() => oracleConnectString({ host: 'h)(HOST=evil', port: 1521, service: 'x' }), /쓸 수 없는 글자/);
    assert.throws(() => oracleConnectString({ host: 'h', port: 1521, service: 'x)(y' }), /쓸 수 없는 글자/);
  });
});

describe('Oracle Thin 모드 연결 실패', () => {
  it('연결 거부는 바로, 알아듣게', async () => {
    const t0 = Date.now();
    await assert.rejects(openSession(ora()), (e: Error & { kind?: string; code?: string }) => {
      assert.equal(e.kind, 'connect');
      assert.equal(e.code, 'NJS-503');
      assert.match(e.message, /서버가 연결을 받지 않습니다/);
      return true;
    });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  });
  it('응답 없는 주소는 시간 제한에 끝남', async () => {
    const t0 = Date.now();
    await assert.rejects(openSession(ora({ host: '10.255.255.1', port: 1521 }), { connectTimeoutSec: 2 }), (e: Error & { kind?: string }) => {
      assert.equal(e.kind, 'connect');
      assert.match(e.message, /연결 시간/);
      return true;
    });
    const ms = Date.now() - t0;
    assert.ok(ms >= 1500 && ms < 6000, `${ms}ms`);
  });
  it('주소를 찾을 수 없음', async () => {
    await assert.rejects(openSession(ora({ host: 'no-such-host.invalid', port: 1521 })), /서버 주소를 찾을 수 없습니다/);
  });
  it('Oracle 리스너가 아닌 포트', async () => {
    // 이 PC의 MariaDB 포트(3306)가 열려 있으면 '연결이 끊겼습니다', 아니면 '연결을 받지 않습니다'
    await assert.rejects(openSession(ora({ port: 3306 })), /연결이 끊겼습니다|연결을 받지 않습니다/);
  });
  it('db.test 채널: Oracle 연결 실패 결과', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ora-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ora-root-'));
    setHost(testHost(tmp));
    registerDb();
    const r = await call('db.test', root, { id: '', env: 'dev', kind: 'oracle', name: 'shop_dev', host: '127.0.0.1', port: 1, service: 'SHOPDEV', user: 'shop_app', password: 'pw' });
    assert.equal(r.ok, false);
    assert.match(r.message, /연결을 받지 않습니다/);
    assert.ok(r.ms < 3000);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('오류 문구', () => {
  const k = (m: string, code?: string) => describeError(Object.assign(new Error(m), code ? { code } : {}));
  it('Oracle', () => {
    assert.equal(k('ORA-01017: invalid username/password; logon denied').kind, 'auth');
    assert.match(k('ORA-12514: TNS:listener does not currently know of service requested').message, /서비스 이름/);
    assert.match(k('ORA-12505: TNS:listener does not currently know of SID').message, /SID/);
    assert.match(k('NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode').message, /Thick 모드/);
    assert.match(k('DPI-1047: Cannot locate a 64-bit Oracle Client library').message, /Oracle Client 19 이상/);
    assert.equal(k('ORA-01013: user requested cancel of current operation').kind, 'timeout');
    assert.equal(k('NJS-123: call timeout of 1000 ms exceeded').kind, 'timeout');
    assert.equal(k('ORA-01456: may not perform insert/delete/update operation inside a READ ONLY transaction').kind, 'readonly');
    assert.equal(k('ORA-00942: table or view does not exist').kind, 'sql');
  });
  it('MySQL·MariaDB', () => {
    assert.equal(k("(conn:12, no: 1045, SQLState: 28000) Access denied for user 'a'@'localhost' (using password: YES)", 'ER_ACCESS_DENIED_ERROR').kind, 'auth');
    assert.equal(k('Query execution was interrupted (max_statement_time exceeded)', 'ER_STATEMENT_TIMEOUT').kind, 'timeout');
    assert.equal(k('Query execution was interrupted, maximum statement execution time exceeded', 'ER_QUERY_TIMEOUT').kind, 'timeout');
    assert.equal(k('Cannot execute statement in a READ ONLY transaction', 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION').kind, 'readonly');
    assert.match(k("Unknown database 'x'", 'ER_BAD_DB_ERROR').message, /데이터베이스를 찾을 수 없습니다/);
    assert.equal(k('connect ETIMEDOUT', 'ETIMEDOUT').kind, 'connect');
  });
  it('Claude에 보내는 문구에서 주소·계정·IP를 가림', () => {
    const s = scrub("NJS-503: connection to host db-prd.company.local port 1521 could not be established. (CONNECTION_ID=abc==) user shop_app from 10.1.2.3:1521 'shop_read'@'10.0.0.9'", ['db-prd.company.local', 'shop_app']);
    assert.ok(!/db-prd|shop_app|10\.1\.2\.3|10\.0\.0\.9|shop_read|CONNECTION_ID/.test(s), s);
  });
  it('값 변환', () => {
    assert.equal(numCell('123'), 123);
    assert.equal(numCell('-0.5'), -0.5);
    assert.equal(numCell('4111111111111111'), '4111111111111111');
    assert.equal(numCell('12345678901234567890'), '12345678901234567890');
    assert.equal(toCell(BigInt('9007199254740993')), '9007199254740993');
    assert.equal(toCell(new Date(2026, 9, 18, 9, 5, 7)), '2026-10-18 09:05:07');
    assert.equal(toCell(Buffer.from('abc')), '(이진 데이터 3바이트)');
    assert.equal(toCell({ a: 1 }), '{"a":1}');
  });
});
