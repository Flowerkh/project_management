// 미리보기: DB 연결·연결 확인·메뉴 미리 보기·쿼리 카드 (POP-04 ⑤⑥, SCR-09 ⑧)
//  kit.state.dbList: 연결 목록 (base.ts의 project.get이 db로 돌려줌)
//  kit.state.cards:  쿼리 카드 (Map). 다른 미리보기가 대화에 넣은 카드는 QueryCardView가 'mock.db.registerCard'로 알려 준다
import type { DbConnection, DbConnectionInput, MenuDbSetting, MenuRow, ProjectSettings, QueryCard } from '../../../shared/desktop-api';
import type { MockHandler, MockKit } from './index';

const AT = '2026-10-17T09:12:00.000Z';

export const MOCK_DB_LIST: DbConnection[] = [
  {
    id: 'db-dev', env: 'dev', kind: 'oracle', name: 'shop_dev', host: 'db-dev.company.local', port: 1521, service: 'SHOPDEV', user: 'shop_app',
    hasPassword: true, lastTest: { ok: true, at: AT, message: '연결됨 · Oracle 19.3.0.0.0', version: 'Oracle 19.3.0.0.0' },
  },
  {
    id: 'db-qa', env: 'qa', kind: 'oracle', name: 'shop_qa', host: 'db-qa.company.local', port: 1521, service: 'SHOPQA', user: 'shop_app',
    hasPassword: true, lastTest: { ok: true, at: AT, message: '연결됨 · Oracle 19.3.0.0.0', version: 'Oracle 19.3.0.0.0' },
  },
  {
    id: 'db-prd', env: 'prod', kind: 'oracle', name: 'shop_prd', host: 'db-prd.company.local', port: 1521, service: 'SHOPPRD', user: 'shop_app',
    hasPassword: true, readUser: 'shop_read', hasReadPassword: true,
    lastTest: { ok: true, at: AT, message: '연결됨 · Oracle 19.3.0.0.0 · 조회 전용 계정 확인', version: 'Oracle 19.3.0.0.0' },
  },
];

/** SCR-09 ⑧ 설계 그림의 쿼리 카드 (개발 DB, 예상 1,284행) */
export const MOCK_QUERY_CARD: QueryCard = {
  id: 'Q-mock-1',
  root: 'C:\\work\\shop-admin',
  conversationId: 'c-1',
  env: 'dev',
  connectionId: 'db-dev',
  dbName: 'shop_dev',
  kind: 'delete',
  sql: 'DELETE FROM TB_ORDER_HIST H\n WHERE H.ROWID NOT IN (\n       SELECT MIN(ROWID)\n         FROM TB_ORDER_HIST\n        GROUP BY ORDER_NO, HIST_STAT_CD, REG_DT\n     )',
  description: '같은 주문·상태·시각으로 두 번 저장된 이력 중 두 번째 행부터 지움',
  estimate: 1284,
  irreversible: false,
  canExecute: true,
  status: 'pending',
  createdAt: '2026-10-17T01:44:00.000Z',
};

const MENU_ROWS: MenuRow[] = [
  { key: 'M0100', name: '회원관리', order: 1 },
  { key: 'M0110', parentKey: 'M0100', name: '회원목록', url: '/user/list.do', order: 1 },
  { key: 'M0120', parentKey: 'M0100', name: '휴면회원', url: '/user/dormant.do', order: 2 },
  { key: 'M0130', parentKey: 'M0100', name: '회원등급', url: '/user/grade.do', order: 3 },
  { key: 'M0200', name: '상품관리', order: 2 },
  { key: 'M0210', parentKey: 'M0200', name: '상품목록', url: '/product/list.do', order: 1 },
  { key: 'M0220', parentKey: 'M0200', name: '카테고리', url: '/product/category.do', order: 2 },
  { key: 'M0300', name: '주문관리', order: 3 },
  { key: 'M0310', parentKey: 'M0300', name: '주문목록', url: '/order/list.do', order: 1 },
  { key: 'M0320', parentKey: 'M0300', name: '주문상세', url: '/order/detail.do', order: 2 },
  { key: 'M0330', parentKey: 'M0300', name: '반품·교환', url: '/order/claim.do', order: 3 },
  { key: 'M0400', name: '정산관리', order: 4 },
  { key: 'M0410', parentKey: 'M0400', name: '정산현황', url: '/settle/status.do', order: 1 },
  { key: 'M0500', name: '시스템관리', order: 5 },
  { key: 'M0510', parentKey: 'M0500', name: '메뉴관리', url: '/system/menu.do', order: 1 },
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function dbMocks(kit: MockKit): Record<string, MockHandler> {
  if (!kit.state.dbList) kit.state.dbList = clone(MOCK_DB_LIST);
  const cards = (kit.state.cards as Map<string, QueryCard> | undefined) ?? new Map<string, QueryCard>();
  kit.state.cards = cards;
  if (!cards.has(MOCK_QUERY_CARD.id)) cards.set(MOCK_QUERY_CARD.id, { ...clone(MOCK_QUERY_CARD), root: kit.root });
  const list = () => kit.state.dbList as DbConnection[];
  const emitCard = (c: QueryCard) => kit.emit({ type: 'db.card', card: clone(c) });
  let seq = 1;

  const execute = async (id: string, typed?: string) => {
    const c = cards.get(id);
    if (!c) throw Object.assign(new Error('쿼리 카드를 찾을 수 없습니다'), { code: 'notfound' });
    if (c.status !== 'pending' && c.status !== 'failed') throw Object.assign(new Error('이미 실행했거나 거부한 쿼리입니다'), { code: 'state' });
    if (c.env === 'prod' && typed !== c.dbName) throw Object.assign(new Error('입력한 DB 이름이 맞지 않아 실행하지 않았습니다'), { code: 'typeName' });
    if (!c.canExecute) throw Object.assign(new Error(`${c.dbName} 연결은 조회 전용이라 실행할 수 없습니다`), { code: 'readonly' });
    c.status = 'running';
    delete c.result;
    emitCard(c);
    await kit.sleep(900);
    const affected = c.estimate ?? 1;
    c.status = 'done';
    c.result = { ok: true, affected, ...(c.estimate !== undefined ? { expected: c.estimate } : {}), ms: 812, historyId: `H-mock-${seq++}` };
    emitCard(c);
    return clone(c);
  };

  return {
    'db.list': () => clone(list()),
    'db.save': (_root: string, input: DbConnectionInput) => {
      const { password, readPassword, ...rest } = input;
      const prev = list().find((c) => c.id === input.id);
      const saved: DbConnection = {
        ...rest,
        id: prev?.id ?? `db-${Date.now().toString(36)}`,
        hasPassword: !!rest.user && (!!password || !!prev?.hasPassword),
        hasReadPassword: !!rest.readUser && (!!readPassword || !!prev?.hasReadPassword),
        ...(prev?.lastTest ? { lastTest: prev.lastTest } : {}),
      };
      kit.state.dbList = prev ? list().map((c) => (c.id === prev.id ? saved : c)) : [...list(), saved];
      return clone(saved);
    },
    'db.remove': (_root: string, id: string) => {
      kit.state.dbList = list().filter((c) => c.id !== id);
    },
    'db.test': async (_root: string, x: string | DbConnectionInput) => {
      await kit.sleep(700);
      const c = typeof x === 'string' ? list().find((d) => d.id === x) : x;
      const bad = !c || /bad|invalid|example/.test(c.host);
      const res = bad
        ? { ok: false, message: '서버 주소를 찾을 수 없습니다 (NJS-530)', ms: 702 }
        : { ok: true, message: `연결됨 · Oracle 19.3.0.0.0${c?.readUser ? ' · 조회 전용 계정 확인' : ''}`, version: 'Oracle 19.3.0.0.0', ms: 214 };
      if (typeof x === 'string' && c) {
        (c as DbConnection).lastTest = { ok: res.ok, at: new Date().toISOString(), message: res.message, ...(res.ok ? { version: 'Oracle 19.3.0.0.0' } : {}) };
      }
      return res;
    },
    'db.readMenu': () => {
      const p = kit.state.project as Partial<ProjectSettings> | undefined;
      const m = p?.menuDb;
      if (!m?.enabled) return { enabled: false, rows: [] };
      return { enabled: true, table: m.table, connectionName: list().find((c) => c.id === m.connectionId)?.name, rows: clone(MENU_ROWS), ms: 180 };
    },
    'db.previewMenu': async (_root: string, m: MenuDbSetting) => {
      await kit.sleep(400);
      if (!/MENU/i.test(m.table)) return { rows: [], error: `ORA-00942: 테이블 또는 뷰가 존재하지 않습니다 (${m.table})` };
      return { rows: clone(MENU_ROWS) };
    },
    'db.card.get': (id: string) => {
      const c = cards.get(id);
      return c ? clone(c) : null;
    },
    'db.card.execute': (id: string, typed?: string) => execute(id, typed),
    'db.card.reject': (id: string) => {
      const c = cards.get(id);
      if (!c) throw new Error('쿼리 카드를 찾을 수 없습니다');
      c.status = 'rejected';
      emitCard(c);
      return clone(c);
    },
    'db.card.fromHistory': (_root: string, entryId: string) => {
      const c: QueryCard = {
        ...clone(MOCK_QUERY_CARD),
        id: `Q-rev-${entryId}`,
        root: kit.root,
        kind: 'insert',
        sql: 'INSERT INTO TB_ORDER_HIST SELECT * FROM TB_ORDER_HIST_BAK20261017',
        description: '되돌리기: 주문 이력 중복 정리',
        estimate: 1284,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      cards.set(c.id, c);
      emitCard(c);
      return clone(c);
    },
    // 미리보기 전용: 대화 미리보기(claude.ts)가 만든 카드를 실행·거부할 수 있게 받아 둔다
    'mock.db.registerCard': (card: QueryCard) => {
      if (card?.id && !cards.has(card.id)) cards.set(card.id, clone(card));
      return true;
    },
  };
}
