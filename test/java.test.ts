// shop-admin 예제(전자정부 스타일 Spring MVC + JSP + MyBatis + Oracle)로 Java 분석기 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { analyze } from '../src/engine/index';
import type { AnalysisResult, SourceFile } from '../src/engine/types';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'shop-admin');

function load(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const rec = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else out.push({ path: `shop-admin/${relative(root, p).split(sep).join('/')}`, size: st.size, bytes: new Uint8Array(readFileSync(p)) });
    }
  };
  rec(root);
  return out;
}

let result: AnalysisResult;
const screen = (url: string) => result.screens.find((s) => s.urls.includes(url))!;
const tables = (url: string) => Object.fromEntries(screen(url).tables.map((t) => [t.table, t.crud.join('')]));

test('shop-admin 분석', async () => {
  if (!existsSync(ROOT)) execFileSync('python3', [join(import.meta.dirname, '..', 'fixtures', 'gen_shop_admin.py'), ROOT]);
  result = await analyze(load(ROOT), { projectName: 'shop-admin' });
  assert.ok(result.project.title.includes('전자정부'));
  assert.equal(result.databases[0]?.type, 'Oracle');
});

test('테이블: DDL 27개 + DB 링크 테이블', () => {
  const ddl = result.tables.filter((t) => !t.fromSqlOnly);
  assert.equal(ddl.length, 27);
  assert.ok(ddl.every((t) => t.comment && t.columns.length > 0));
  assert.ok(result.tables.find((t) => t.name === 'WMS_STOCK')?.fromSqlOnly);
  assert.ok(result.tables.find((t) => t.name === 'TB_COUPON')?.unlinked);
});

test('화면 25개, ajax 처리 URL은 화면에 합쳐짐', () => {
  const pages = result.screens.filter((s) => s.kind !== 'api');
  assert.equal(pages.length, 25);
  assert.equal(result.screens.filter((s) => s.kind === 'api').length, 0);
  assert.equal(screen('/order/orderDetail.do').name, '주문 상세');
});

test('주문 상세: 화면→컨트롤러→서비스→DAO→매퍼→테이블 CRUD', () => {
  assert.deepEqual(tables('/order/orderDetail.do'), {
    TB_GOODS: 'R', TB_ORDER: 'RU', TB_ORDER_DLVY: 'RU', TB_ORDER_HIST: 'C', TB_ORDER_ITEM: 'R', TB_PAY: 'R',
  });
  const s = screen('/order/orderDetail.do');
  assert.deepEqual(s.flow.slice(0, 4).map((x) => x.layer), ['VIEW', 'SCRIPT', 'CONTROLLER', 'SERVICE']);
  assert.ok(s.calls.some((c) => c.url === '/order/updateOrderStat.do' && c.kind === 'ajax'));
});

test('매퍼 인터페이스(@Mapper) 방식·폼 저장·팝업·동적 테이블', () => {
  assert.deepEqual(tables('/member/memberList.do'), { TB_USER: 'R', TB_USER_GRADE: 'R' });
  assert.deepEqual(tables('/goods/goodsRegist.do'), { TB_GOODS: 'C', TB_GOODS_OPTION: 'C', TB_STOCK: 'C' });
  assert.equal(screen('/order/orderHistPopup.do').kind, 'popup');
  assert.equal(screen('/system/dynamicReport.do').confidence, '낮음');
  assert.ok(result.issues.some((i) => i.kind === 'estimated-sql'));
  assert.deepEqual(tables('/login.do'), { TB_ADMIN: 'R', TB_LOGIN_LOG: 'C' });
});

test('메뉴 23개(메뉴 데이터 SQL), 화면 연결, 메뉴에 없는 화면', () => {
  assert.equal(result.menus.length, 23);
  assert.ok(result.menus.every((m) => m.source === 'data-file'));
  const top = result.menus.filter((m) => !m.parent);
  assert.deepEqual(top.map((m) => m.name), ['회원관리', '상품관리', '주문관리', '정산관리', '시스템관리']);
  assert.equal(result.menus.filter((m) => m.screens.length).length, 18);
  const nim = result.screens.filter((s) => s.notInMenu).map((s) => s.url).sort();
  assert.deepEqual(nim, ['/goods/goodsDetail.do', '/login.do', '/main.do', '/member/memberDetail.do', '/order/orderDetail.do', '/settle/settleDetail.do']);
});

test('배치 6개와 실행 주기', () => {
  const by = Object.fromEntries(result.batches.map((b) => [b.name, b.schedule?.text ?? null]));
  assert.deepEqual(by, {
    '일 정산': '매일 02:00', '휴면 회원 전환': '매일 04:30', '로그 정리': '매주 일 05:00', '재고 동기화': null, '월 매출 집계': '매월 1일 01:00', '주문 자동 확정': '매일 03:00',
  });
  const settle = result.batches.find((b) => b.name === '일 정산')!;
  assert.deepEqual(Object.fromEntries(settle.tables.map((t) => [t.table, t.crud.join('')])), { TB_GOODS: 'R', TB_ORDER: 'R', TB_ORDER_ITEM: 'R', TB_SETTLE: 'C', TB_SETTLE_ITEM: 'C' });
  const job = result.batches.find((b) => b.name === '주문 자동 확정')!;
  assert.equal(job.kind, 'spring-scheduled');
  assert.deepEqual(Object.fromEntries(job.tables.map((t) => [t.table, t.crud.join('')])), { TB_ORDER: 'U', TB_ORDER_HIST: 'C' });
});

test('EUC-KR 화면 읽기', () => {
  assert.equal(screen('/goods/stockList.do').name, '재고 현황');
  assert.equal(screen('/system/loginLogList.do').name, '접속 로그');
  assert.equal(result.issues.find((i) => i.kind === 'encoding')?.items.length, 2);
});
