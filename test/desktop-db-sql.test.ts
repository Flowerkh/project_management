// DB 모듈의 순수 함수 시험: SQL 판정·예상 행 수 쿼리·원본 컬럼 찾기·개인정보 가림 (DB 없이)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMasks, decideMasks, looksPersonal, luhn, maskByShape, parseMaskPatterns, ruleMatches, sourcesForResult,
  type MetaLookup, type TableInfo,
} from '../src/desktop/db/mask';
import { checkReadOnly, classify, countPlan, isSafeIdent, lex, mainTable, selectShape, shapeTables, splitStatements } from '../src/desktop/db/sql';
import { guessColumns, menuTables } from '../src/ui/desktop/db/menuGuess';
import type { AnalysisResult } from '../src/engine/types';

const ro = (sql: string, d: 'oracle' | 'mysql' = 'oracle') => checkReadOnly(sql, d);

describe('lex: 주석·문자열', () => {
  it('주석과 문자열 안의 세미콜론·키워드는 무시한다', () => {
    const sql = "SELECT 'a;b -- c' AS x, /* ; UPDATE */ q'[it's; ok]' FROM dual -- ; DELETE\n";
    const sp = splitStatements(sql, 'oracle');
    assert.equal(sp.stmts.length, 1);
    assert.equal(ro(sql).ok, true);
  });
  it('MySQL 역슬래시 이스케이프와 # 주석', () => {
    const sql = "SELECT 'it\\'s; fine' AS a # ; DROP TABLE x\nFROM t";
    assert.equal(splitStatements(sql, 'mysql').stmts.length, 1);
    assert.equal(ro(sql, 'mysql').ok, true);
    // Oracle에서는 역슬래시가 이스케이프가 아니다
    assert.equal(lex("SELECT 'a\\' FROM dual", 'oracle').error, undefined);
  });
  it('MySQL -- 는 뒤에 공백이 있어야 주석', () => {
    const t = lex('SELECT 1--1', 'mysql').toks.map((x) => x.v);
    assert.deepEqual(t, ['SELECT', '1', '-', '-', '1']);
    assert.deepEqual(lex('SELECT 1 -- x', 'mysql').toks.map((x) => x.v), ['SELECT', '1']);
  });
  it('닫히지 않은 따옴표·주석은 거부', () => {
    assert.equal(ro("SELECT 'abc FROM t").ok, false);
    assert.equal(ro('SELECT 1 /* x').ok, false);
  });
  it('MySQL 실행 주석은 거부', () => {
    const r = ro('SELECT 1 /*!50000 , SLEEP(1) */', 'mysql');
    assert.equal(r.ok, false);
  });
  it('따옴표 식별자', () => {
    const t = lex('SELECT "Cust Nm", `x``y` FROM t', 'mysql').toks.filter((x) => x.t === 'q').map((x) => x.v);
    assert.deepEqual(t, ['Cust Nm', 'x`y']);
  });
});

describe('checkReadOnly: SELECT 하나만', () => {
  it('SELECT·WITH … SELECT·괄호 SELECT·UNION은 통과', () => {
    for (const s of [
      'SELECT * FROM TB_ORDER WHERE ORDER_NO = :1',
      'select count(*) from tb_order;',
      'WITH a AS (SELECT 1 x FROM dual) SELECT x FROM a',
      '(SELECT 1 FROM dual) UNION ALL (SELECT 2 FROM dual)',
      'SELECT a FROM t1 MINUS SELECT a FROM t2',
      "SELECT * FROM t WHERE memo LIKE '%FOR UPDATE%'",
      'SELECT /*+ INDEX(t IX_1) */ * FROM t',
      'SELECT * FROM t\n/\n',
    ]) {
      const r = ro(s);
      assert.equal(r.ok, true, `${s} → ${!r.ok ? r.reason : ''}`);
    }
    assert.equal(ro('SELECT SLEEP(5)', 'mysql').ok, true);
  });
  it('문장이 둘 이상이면 거부', () => {
    const r = ro('SELECT 1 FROM dual; DELETE FROM t');
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /문장 하나/);
    assert.equal(ro('SELECT 1; SELECT 2', 'mysql').ok, false);
  });
  it('SELECT가 아닌 문장은 거부', () => {
    for (const s of ['UPDATE t SET a = 1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a=1',
      'CREATE TABLE x (a int)', 'TRUNCATE TABLE t', 'BEGIN delete_all; END;', 'CALL p()', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'SET autocommit=0', 'LOCK TABLE t IN EXCLUSIVE MODE',
      'WITH a AS (SELECT 1 FROM dual) DELETE FROM t WHERE x IN (SELECT * FROM a)', 'WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual']) {
      assert.equal(ro(s, s.startsWith('SHOW') || s.startsWith('SET') ? 'mysql' : 'oracle').ok, false, s);
    }
  });
  it('FOR UPDATE·SELECT INTO·OUTFILE·LOCK IN SHARE MODE·FOR SHARE는 거부', () => {
    assert.equal(ro('SELECT * FROM t WHERE a = 1 FOR UPDATE').ok, false);
    assert.equal(ro('SELECT * FROM t FOR UPDATE OF a NOWAIT').ok, false);
    assert.equal(ro('SELECT a INTO v FROM t').ok, false);
    assert.equal(ro("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'mysql').ok, false);
    assert.equal(ro("SELECT * FROM t INTO DUMPFILE '/tmp/x'", 'mysql').ok, false);
    assert.equal(ro('SELECT * FROM t LOCK IN SHARE MODE', 'mysql').ok, false);
    assert.equal(ro('SELECT * FROM t FOR SHARE', 'mysql').ok, false);
  });
  it('DB 링크·시퀀스 NEXTVAL·변수·외부 패키지는 거부', () => {
    assert.equal(ro('SELECT * FROM TB_ORDER@PRD_LINK').ok, false);
    assert.equal(ro('SELECT SEQ_ORDER.NEXTVAL FROM dual').ok, false);
    assert.equal(ro('SELECT NEXTVAL(seq1)', 'mysql').ok, false);
    assert.equal(ro('SELECT NEXT VALUE FOR seq1', 'mysql').ok, false);
    assert.equal(ro('SELECT @x := 1', 'mysql').ok, false);
    assert.equal(ro('SELECT @x', 'mysql').ok, false);
    assert.equal(ro('SELECT @@version, @@session.sql_mode', 'mysql').ok, true);
    assert.equal(ro('SELECT @@version FROM dual').ok, false);
    assert.equal(ro("SELECT UTL_HTTP.REQUEST('http://x') FROM dual").ok, false);
    assert.equal(ro("SELECT DBMS_PIPE.RECEIVE_MESSAGE('a', 10) FROM dual").ok, false);
    assert.equal(ro("SELECT LOAD_FILE('/etc/passwd')", 'mysql').ok, false);
    assert.equal(ro('SELECT DBMS_LOB.SUBSTR(c, 10, 1) FROM t').ok, true);
    // 문자열 안의 @는 괜찮다
    assert.equal(ro("SELECT * FROM t WHERE email = 'a@b.com'").ok, true);
  });
});

describe('classify: 쿼리 카드 종류', () => {
  const k = (s: string, d: 'oracle' | 'mysql' = 'oracle') => classify(s, d).kind;
  it('종류', () => {
    assert.equal(k('INSERT INTO t VALUES (1)'), 'insert');
    assert.equal(k('update t set a=1'), 'update');
    assert.equal(k('DELETE TB_ORDER_HIST H WHERE H.ROWID NOT IN (SELECT MIN(ROWID) FROM TB_ORDER_HIST GROUP BY ORDER_NO)'), 'delete');
    assert.equal(k('MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.a = s.a'), 'merge');
    assert.equal(k('REPLACE INTO t VALUES (1)', 'mysql'), 'merge');
    assert.equal(k('ALTER TABLE t ADD c NUMBER'), 'ddl');
    assert.equal(k('COMMENT ON COLUMN t.c IS \'x\''), 'ddl');
    assert.equal(k('CALL p(1)'), 'call');
    assert.equal(k('BEGIN p(1); p(2); END;'), 'call');
    assert.equal(k('LOCK TABLE t IN EXCLUSIVE MODE'), 'other');
    assert.equal(k('WITH x AS (SELECT 1 a) UPDATE t JOIN x ON t.a = x.a SET t.b = 1', 'mysql'), 'update');
  });
  it('PL/SQL 블록은 세미콜론이 있어도 한 문장', () => {
    assert.equal(classify('BEGIN\n  UPDATE t SET a = 1;\n  COMMIT;\nEND;\n/', 'oracle').count, 1);
    assert.equal(classify('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;', 'oracle').count, 1);
    assert.equal(classify('UPDATE t SET a = 1; UPDATE t SET b = 2;', 'oracle').count, 2);
  });
  it('대상 테이블', () => {
    assert.deepEqual(mainTable('DELETE FROM TB_ORDER_HIST H WHERE 1=1', 'oracle'), { name: 'TB_ORDER_HIST' });
    assert.deepEqual(mainTable('update shop.tb_x set a = 1', 'mysql'), { schema: 'SHOP', name: 'TB_X' });
    assert.deepEqual(mainTable('INSERT INTO TB_A (a) VALUES (1)', 'oracle'), { name: 'TB_A' });
    assert.deepEqual(mainTable('CREATE TABLE IF NOT EXISTS tb_new (a int)', 'mysql'), { name: 'TB_NEW' });
  });
});

describe('countPlan: 예상 영향 행 수', () => {
  it('UPDATE … WHERE', () => {
    const p = countPlan("UPDATE TB_ORDER o SET o.STAT = '20', o.UPD_DT = (SELECT SYSDATE FROM dual WHERE 1=1) WHERE o.STAT = '10' AND o.ORDER_DT < SYSDATE - 30", 'oracle');
    assert.equal(p.countSql, "SELECT COUNT(*) FROM TB_ORDER o WHERE o.STAT = '10' AND o.ORDER_DT < SYSDATE - 30");
  });
  it('WHERE 없는 UPDATE·DELETE', () => {
    assert.equal(countPlan('UPDATE t SET a = 1', 'oracle').countSql, 'SELECT COUNT(*) FROM t');
    assert.equal(countPlan('DELETE FROM t', 'mysql').countSql, 'SELECT COUNT(*) FROM t');
  });
  it('DELETE (Oracle FROM 생략, 별칭, 서브쿼리)', () => {
    const p = countPlan('DELETE TB_ORDER_HIST H WHERE H.ROWID NOT IN (SELECT MIN(ROWID) FROM TB_ORDER_HIST GROUP BY ORDER_NO, STAT)', 'oracle');
    assert.equal(p.countSql, 'SELECT COUNT(*) FROM TB_ORDER_HIST H WHERE H.ROWID NOT IN (SELECT MIN(ROWID) FROM TB_ORDER_HIST GROUP BY ORDER_NO, STAT)');
  });
  it('MySQL ORDER BY … LIMIT', () => {
    const p = countPlan('DELETE FROM tb_log WHERE reg_dt < NOW() - INTERVAL 30 DAY ORDER BY reg_dt LIMIT 1000', 'mysql');
    assert.equal(p.countSql, 'SELECT COUNT(*) FROM tb_log WHERE reg_dt < NOW() - INTERVAL 30 DAY');
    assert.equal(p.limit, 1000);
  });
  it('여러 테이블·IGNORE·RETURNING은 못 셈', () => {
    assert.ok(countPlan('UPDATE a JOIN b ON a.id = b.id SET a.x = b.x', 'mysql').note);
    assert.ok(countPlan('DELETE a FROM a JOIN b ON a.id = b.id', 'mysql').note);
    assert.ok(countPlan('UPDATE IGNORE t SET a = 1', 'mysql').note);
    assert.ok(countPlan('INSERT IGNORE INTO t VALUES (1)', 'mysql').note);
    assert.ok(countPlan('UPDATE t SET a = 1 RETURNING a INTO :x', 'oracle').note);
    assert.ok(countPlan('INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2', 'mysql').note);
    assert.ok(countPlan('MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1', 'oracle').note);
  });
  it('INSERT VALUES 행 수·INSERT … SELECT', () => {
    assert.equal(countPlan("INSERT INTO t (a, b) VALUES (1, 'x')", 'oracle').fixed, 1);
    assert.equal(countPlan("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'), (3, '(z)')", 'mysql').fixed, 3);
    assert.equal(countPlan("INSERT INTO t SET a = 1, b = 'x'", 'mysql').fixed, 1);
    assert.equal(countPlan('INSERT INTO t (a) SELECT x FROM s WHERE y > 1', 'oracle').countSql, 'SELECT COUNT(*) FROM (SELECT x FROM s WHERE y > 1) pa_cnt');
    assert.equal(countPlan('INSERT INTO t (a) (SELECT x FROM s)', 'oracle').countSql, 'SELECT COUNT(*) FROM (SELECT x FROM s) pa_cnt');
  });
  it('DDL·CALL은 계획 없음', () => {
    assert.deepEqual(countPlan('DROP TABLE t', 'oracle'), {});
    assert.deepEqual(countPlan('CALL p()', 'mysql'), {});
  });
});

describe('selectShape: 결과 열의 원본 컬럼', () => {
  const meta: Record<string, TableInfo> = {
    TB_CUST: { name: 'TB_CUST', columns: [{ name: 'CUST_ID' }, { name: 'CUST_NM', comment: '고객 이름' }, { name: 'CUST_TEL', comment: '전화번호' }, { name: 'MEMO' }] },
    TB_GOODS: { name: 'TB_GOODS', columns: [{ name: 'GOODS_ID' }, { name: 'GOODS_NM', comment: '상품명' }, { name: 'PRICE' }] },
    TB_ORDER: { name: 'TB_ORDER', columns: [{ name: 'ORDER_NO' }, { name: 'CUST_ID' }, { name: 'GOODS_ID' }, { name: 'RCVR_NM', comment: '받는 사람 성명' }] },
  };
  const lookup: MetaLookup = (t) => meta[t.name.toUpperCase()] ?? null;
  const tables = Object.values(meta);
  const rules = parseMaskPatterns(['*_NM:이름·성명', '*_TEL', '*_EMAIL']);
  const masks = (sql: string, cols: string[], d: 'oracle' | 'mysql' = 'oracle', look = lookup) =>
    decideMasks(sourcesForResult(selectShape(sql, d), cols.map((name) => ({ name })), look, tables), rules);

  it('별칭·함수·식은 원본 컬럼으로', () => {
    assert.deepEqual(
      masks('SELECT c.CUST_NM AS a, UPPER(c.CUST_TEL) t, c.CUST_ID, SUBSTR(c.CUST_NM, 1, 1) || \'*\' AS initial FROM TB_CUST c', ['A', 'T', 'CUST_ID', 'INITIAL']),
      [true, true, false, true],
    );
  });
  it('주석 조건: *_NM은 주석에 이름·성명이 있을 때만', () => {
    assert.deepEqual(masks('SELECT g.GOODS_NM, o.RCVR_NM FROM TB_GOODS g, TB_ORDER o WHERE g.GOODS_ID = o.GOODS_ID', ['GOODS_NM', 'RCVR_NM']), [false, true]);
  });
  it('* 와 별칭.* 은 테이블 컬럼 순서대로', () => {
    assert.deepEqual(masks('SELECT * FROM TB_CUST', ['CUST_ID', 'CUST_NM', 'CUST_TEL', 'MEMO']), [false, true, true, false]);
    assert.deepEqual(
      masks('SELECT o.ORDER_NO, c.* FROM TB_ORDER o JOIN TB_CUST c ON c.CUST_ID = o.CUST_ID', ['ORDER_NO', 'CUST_ID', 'CUST_NM', 'CUST_TEL', 'MEMO']),
      [false, false, true, true, false],
    );
  });
  it('별칭 없는 컬럼은 FROM의 테이블에서 찾는다', () => {
    assert.deepEqual(masks('SELECT CUST_NM, GOODS_NM FROM TB_CUST JOIN TB_GOODS ON 1=1', ['CUST_NM', 'GOODS_NM']), [true, false]);
  });
  it('COUNT 안의 컬럼은 값이 나오지 않으므로 가리지 않음, MAX는 가림', () => {
    assert.deepEqual(masks('SELECT COUNT(CUST_TEL) cnt, MAX(CUST_TEL) mx FROM TB_CUST', ['CNT', 'MX']), [false, true]);
  });
  it('인라인 뷰·WITH·UNION·스칼라 서브쿼리', () => {
    assert.deepEqual(masks('SELECT x.n, x.id FROM (SELECT CUST_NM n, CUST_ID id FROM TB_CUST) x', ['N', 'ID']), [true, false]);
    assert.deepEqual(masks('WITH a AS (SELECT CUST_TEL AS phone, CUST_ID FROM TB_CUST) SELECT phone, cust_id FROM a', ['PHONE', 'CUST_ID']), [true, false]);
    assert.deepEqual(masks('WITH a (p, i) AS (SELECT CUST_TEL, CUST_ID FROM TB_CUST) SELECT * FROM a', ['P', 'I']), [true, false]);
    assert.deepEqual(masks('SELECT GOODS_NM nm FROM TB_GOODS UNION ALL SELECT CUST_NM FROM TB_CUST', ['NM']), [true]);
    assert.deepEqual(
      masks('SELECT o.ORDER_NO, (SELECT c.CUST_NM FROM TB_CUST c WHERE c.CUST_ID = o.CUST_ID) buyer FROM TB_ORDER o', ['ORDER_NO', 'BUYER']),
      [false, true],
    );
  });
  it('CASE·결합·주석이 섞여도', () => {
    const sql = `SELECT /* 이름 */ CASE WHEN c.CUST_ID > 0 THEN c.CUST_NM ELSE '-' END AS who, -- 전화
      c.CUST_ID || '-' || c.CUST_TEL "Contact" FROM TB_CUST c`;
    assert.deepEqual(masks(sql, ['WHO', 'Contact']), [true, true]);
  });
  it('테이블 정보를 모르면 이름으로 보고 주석 조건은 가리는 쪽', () => {
    const none: MetaLookup = () => null;
    assert.deepEqual(masks('SELECT * FROM TB_X', ['A_NM', 'A_TEL', 'NOTE'], 'oracle', none), [true, true, false]);
    assert.deepEqual(masks('SELECT p.GOODS_NM FROM TB_P p', ['GOODS_NM'], 'oracle', none), [true]);
  });
  it('MySQL 결과 정보의 원본 컬럼도 쓴다', () => {
    const src = sourcesForResult(null, [{ name: 'x', orgTable: 'TB_CUST', orgName: 'CUST_TEL' }], lookup, tables);
    assert.deepEqual(decideMasks(src, rules), [true]);
  });
  it('참조 테이블 목록', () => {
    const shape = selectShape('WITH a AS (SELECT * FROM shop.TB_CUST) SELECT * FROM a JOIN TB_ORDER o ON 1=1 WHERE EXISTS (SELECT 1 FROM TB_Z)', 'oracle');
    assert.ok(shape);
    assert.deepEqual(shapeTables(shape!).map((t) => `${t.schema ?? ''}.${t.name}`), ['SHOP.TB_CUST', '.TB_ORDER']);
  });
});

describe('가림 패턴·값 모양', () => {
  it('패턴', () => {
    const [nm, tel] = parseMaskPatterns(['*_NM:이름·성명', '*_TEL']);
    assert.equal(ruleMatches(nm, 'CUST_NM', '고객 이름'), true);
    assert.equal(ruleMatches(nm, 'cust_nm', '성명'), true);
    assert.equal(ruleMatches(nm, 'GOODS_NM', '상품명'), false);
    assert.equal(ruleMatches(nm, 'GOODS_NM', null), false);
    assert.equal(ruleMatches(nm, 'GOODS_NM', undefined), true);
    assert.equal(ruleMatches(tel, 'HOME_TEL', null), true);
    assert.equal(ruleMatches(tel, 'TEL_NO', null), false);
  });
  it('값 모양', () => {
    for (const v of ['010-1234-5678', '01012345678', '+82 10-1234-5678', '02-123-4567', '(031) 123-4567', 'hong.gd@company.co.kr', '900101-1234567', '4111-1111-1111-1111', '4111111111111111']) {
      assert.equal(looksPersonal(v), true, v);
    }
    for (const v of ['ORD-2026-0001', '20261018123456', '1012345678', '1234-5678', '2026-10-18', 'abc@def', '4111111111111112']) {
      assert.equal(looksPersonal(v), false, v);
    }
    assert.equal(luhn('4111111111111111'), true);
    assert.equal(maskByShape('연락처 010-9876-5432로 회신, 메일 a.b@x.com'), '연락처 ****로 회신, 메일 ****');
    assert.equal(maskByShape('주문 ORD-2026-0001 배송 완료'), null);
  });
  it('applyMasks', () => {
    const r = applyMasks([['홍길동', '010-1111-2222', 'ok', 4111111111111111], [null, '', 'x@y.kr', 12]], [true, false, false, false]);
    assert.deepEqual(r.rows, [['****', '****', 'ok', '****'], [null, '', '****', 12]]);
    assert.deepEqual(r.masked, [true, true, true, true]);
  });
  it('메뉴 테이블 이름 확인', () => {
    assert.equal(isSafeIdent('TB_MENU'), true);
    assert.equal(isSafeIdent('shop.TB_MENU'), true);
    assert.equal(isSafeIdent('TB_MENU; DROP'), false);
    assert.equal(isSafeIdent('a..b'), false);
    assert.equal(isSafeIdent(''), false);
  });
});

describe('메뉴 테이블 추천', () => {
  it('컬럼 짐작: 일반형·전자정부(COMTNMENUINFO)', () => {
    assert.deepEqual(guessColumns(['MENU_ID', 'UPPER_MENU_ID', 'MENU_NM', 'MENU_URL', 'SORT_ORDR', 'USE_YN']), {
      idCol: 'MENU_ID', parentCol: 'UPPER_MENU_ID', nameCol: 'MENU_NM', urlCol: 'MENU_URL', orderCol: 'SORT_ORDR',
    });
    assert.deepEqual(guessColumns(['MENU_NO', 'MENU_ORDR', 'MENU_NM', 'UPPER_MENU_NO', 'MENU_DC', 'RELATE_IMAGE_PATH', 'RELATE_IMAGE_NM', 'PROGRM_FILE_NM']), {
      idCol: 'MENU_NO', parentCol: 'UPPER_MENU_NO', nameCol: 'MENU_NM', urlCol: 'PROGRM_FILE_NM', orderCol: 'MENU_ORDR',
    });
    assert.deepEqual(guessColumns(['ID', 'PARENT_ID', 'NAME', 'LINK', 'SEQ']), { idCol: 'ID', parentCol: 'PARENT_ID', nameCol: 'NAME', urlCol: 'LINK', orderCol: 'SEQ' });
  });
  it('분석 결과의 DDL과 SQL 컬럼', () => {
    const r = {
      tables: [{ name: 'TB_MENU', columns: [{ name: 'MENU_ID' }, { name: 'MENU_NM' }] }, { name: 'TB_ORDER', columns: [{ name: 'ORDER_NO' }] }],
      sql: [
        { text: "INSERT INTO TB_MENU (MENU_ID, UPPER_MENU_ID, MENU_NM, MENU_URL) VALUES ('a', NULL, 'b', NULL)", tables: [{ name: 'TB_MENU', crud: 'C' }] },
        { text: 'SELECT m.MENU_ID, m.SORT_ORDR AS o FROM TB_MENU m', tables: [{ name: 'TB_MENU', crud: 'R' }] },
        { text: 'SELECT * FROM TB_ADMIN_MENU', tables: [{ name: 'TB_ADMIN_MENU', crud: 'R' }] },
      ],
    } as unknown as AnalysisResult;
    assert.deepEqual(menuTables(r), [
      { table: 'TB_MENU', columns: ['MENU_ID', 'MENU_NM', 'UPPER_MENU_ID', 'MENU_URL', 'SORT_ORDR'] },
      { table: 'TB_ADMIN_MENU', columns: [] },
    ]);
  });
});
