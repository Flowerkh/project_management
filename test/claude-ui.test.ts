// Claude 화면(C2)의 순수 함수 시험: 맥락 변경 문구, 대화 제목·시각, Markdown 블록 나누기, 파일·테이블·화면 이름 찾기,
// 새 프로젝트 계획 읽기와 진행 표시, 대화 항목 갱신.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatItem, Conversation } from '../src/shared/desktop-api';
import { buildChatContext } from '../src/ui/desktop/claude/context';
import { listItemsOf, parseBlocks, resolveFile, resolveName, sectionsOf } from '../src/ui/desktop/claude/markdown';
import { fileCat, parsePlan, planStates, stripPlan } from '../src/ui/desktop/claude/plan';
import { upsertItem } from '../src/ui/desktop/claude/useConversation';
import { composeWithContext, convTitle, effectiveChips, firstTable, hm, maxRowsOf, splitContextBlock } from '../src/ui/desktop/claude/util';
import { makeMock } from '../src/ui/mock';
import { buildModel } from '../src/ui/model';

const model = buildModel(makeMock().result);

function conv(items: ChatItem[], extra: Partial<Conversation> = {}): Conversation {
  return { id: 'c1', root: 'C:\\work\\shop-admin', kind: 'issue', title: '', createdAt: '2026-10-17T01:37:00Z', updatedAt: '2026-10-17T01:44:00Z', mode: 'plan', items, running: false, ...extra };
}

test('대화 중 맥락 변경: 질문 끝에 붙였다가 말풍선에서는 떼어 낸다', () => {
  const add = { kind: 'screen' as const, label: '주문목록', text: '화면: 주문목록\nURL: /order/list.do' };
  const del = { kind: 'flow' as const, label: '호출 흐름', text: '' };
  const full = composeWithContext('이 화면도 같이 봐 주세요.', [add], [del]);
  assert.match(full, /<맥락-추가 이름="주문목록" 종류="screen">/);
  const back = splitContextBlock(full);
  assert.equal(back.text, '이 화면도 같이 봐 주세요.');
  assert.deepEqual(back.added, [add]);
  assert.deepEqual(back.removed, [{ kind: 'flow', label: '호출 흐름' }]);
  // 맥락 변경이 없으면 글 그대로
  assert.equal(composeWithContext('그대로', [], []), '그대로');
  assert.deepEqual(splitContextBlock('그대로').added, []);
  // 따옴표가 든 이름도 깨지지 않음
  const q = splitContextBlock(composeWithContext('x', [{ kind: 'table', label: 'A"B', text: 't' }], []));
  assert.equal(q.added[0].label, 'A＂B');
});

test('대화 맥락 = 시작 칩 + 이후 질문에서 더하고 뺀 칩', () => {
  const ctx = buildChatContext(model, { kind: 'screen', id: 'S022' })!;
  assert.deepEqual(
    ctx.chips.map((c) => c.label),
    ['주문상세', '파일 6', '테이블 7', '호출 흐름', '시스템 요약'],
  );
  const c = conv(
    [
      { id: 'u1', type: 'user', text: '원인을 찾아 주세요', at: '2026-10-17T01:37:00Z' },
      { id: 'u2', type: 'user', text: composeWithContext('이것도', [{ kind: 'screen', label: '주문목록', text: '...' }], [ctx.chips[3]]), at: '2026-10-17T01:40:00Z' },
    ],
    { context: ctx },
  );
  assert.deepEqual(
    effectiveChips(c).map((x) => x.label),
    ['주문상세', '파일 6', '테이블 7', '시스템 요약', '주문목록'],
  );
});

test('대화 제목: 메인이 정한 제목 우선, 아니면 첫 질문을 줄임', () => {
  const items: ChatItem[] = [{ id: 'u1', type: 'user', text: '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓여요. 원인을 찾아 주세요.', at: '2026-10-17T01:37:00Z' }];
  assert.equal(convTitle(conv(items, { title: '주문 이력 중복 저장', context: { title: '주문상세', chips: [] } })), '주문 이력 중복 저장');
  const t = convTitle(conv(items, { title: '주문상세', context: { title: '주문상세', chips: [] } }));
  assert.ok(t.startsWith('주문 상태를 바꾸면') && t.endsWith('…') && t.length <= 34, t);
  assert.equal(convTitle(null), '새 대화');
});

test('시각 표시: 오늘은 시각만, 다른 날은 월-일 시각', () => {
  const d = new Date();
  d.setHours(10, 41, 0, 0);
  assert.equal(hm(d.toISOString()), '10:41');
  const old = new Date(2026, 9, 16, 23, 50);
  if (old.toDateString() !== new Date().toDateString()) assert.equal(hm(old.toISOString()), '10-16 23:50');
  assert.equal(hm('잘못된 값'), '');
});

test('작업 내역 한 줄: SELECT의 첫 테이블, 운영 조회 최대 행 수', () => {
  assert.equal(firstTable('SELECT ORDER_NO, COUNT(*)\n  FROM SHOP.TB_ORDER_HIST H GROUP BY ORDER_NO'), 'TB_ORDER_HIST');
  assert.equal(firstTable('select 1 from dual'), 'dual');
  assert.equal(firstTable('WITH x AS (SELECT 1)'), '');
  assert.equal(maxRowsOf('최대 1,000행 · 개인정보 가림', 100), 1000);
  assert.equal(maxRowsOf(undefined, 100), 100);
});

test('대화 항목 갱신: 같은 id는 바꾸고, 내 질문(local:)은 메인 항목으로 바꾼다', () => {
  const a: ChatItem = { id: 'm1', type: 'assistant', text: '원인은', streaming: true, at: 't' };
  let items: ChatItem[] = [{ id: 'local:1', type: 'user', text: '질문', at: 't' }, a];
  items = upsertItem(items, { ...a, text: '원인은 이력 저장이', streaming: false });
  assert.equal(items.length, 2);
  assert.equal((items[1] as Extract<ChatItem, { type: 'assistant' }>).text, '원인은 이력 저장이');
  items = upsertItem(items, { id: 'u1', type: 'user', text: '질문 ', at: 't2' });
  assert.equal(items[0].id, 'u1');
  items = upsertItem(items, { id: 'x', type: 'notice', text: '중지했습니다', at: 't3' });
  assert.equal(items.length, 3);
});

test('Markdown 블록: 문단·목록(중첩)·코드·표·영향 범위', () => {
  const md = [
    '원인은 두 번 저장하기 때문입니다.',
    '이어서 한 번 더 저장합니다.',
    '',
    '- 첫째',
    '  - 안쪽',
    '- 둘째',
    '',
    '1. 하나',
    '2. 둘',
    '',
    '```sql',
    'SELECT 1',
    '```',
    '',
    '| 파일 | 줄 |',
    '|---|--:|',
    '| A.java | 88 |',
    '',
    '영향 범위: 주문상세, 반품·교환, TB_ORDER_HIST',
    '',
    '```java',
    'void a() {',
  ].join('\n');
  const b = parseBlocks(md.split('\n'));
  assert.deepEqual(
    b.map((x) => x.t),
    ['p', 'list', 'list', 'code', 'table', 'impact', 'code'],
  );
  const p = b[0] as { t: 'p'; lines: string[] };
  assert.equal(p.lines.length, 2);
  const ul = b[1] as { t: 'list'; ordered: boolean; heads: string[][]; items: { t: string }[][] };
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.heads, [['첫째'], ['둘째']]);
  assert.equal(ul.items[0][0].t, 'list');
  assert.equal((b[2] as { ordered: boolean }).ordered, true);
  assert.equal((b[3] as { lang: string; text: string }).text, 'SELECT 1');
  const tbl = b[4] as { head: string[]; rows: string[][]; align: string[] };
  assert.deepEqual(tbl.head, ['파일', '줄']);
  assert.deepEqual(tbl.rows, [['A.java', '88']]);
  assert.equal(tbl.align[1], 'right');
  // '반품·교환'은 가운뎃점이 이름 안에 있어 나누지 않는다
  assert.deepEqual((b[5] as { tokens: string[] }).tokens, ['주문상세', '반품·교환', 'TB_ORDER_HIST']);
  // 스트리밍 중 닫히지 않은 코드 블록도 코드로
  assert.equal((b[6] as { text: string }).text, 'void a() {');
  // 목록 형식의 영향 범위
  const b2 = parseBlocks(['영향 범위:', '- 주문상세', '- TB_ORDER'].join('\n').split('\n'));
  assert.deepEqual((b2[0] as { tokens: string[] }).tokens, ['주문상세', 'TB_ORDER']);
});

test('이름 찾기: 파일 이름(겹치지 않을 때)·상대 경로, 화면·테이블·메뉴', () => {
  const impl = resolveFile(model, 'OrderServiceImpl.java');
  assert.equal(impl?.path, 'src/main/java/egovframework/egov/shop/order/service/impl/OrderServiceImpl.java');
  // list.jsp는 여러 모듈에 있어 이름만으로는 못 정한다
  assert.equal(resolveFile(model, 'list.jsp'), null);
  assert.equal(resolveFile(model, 'order/list.jsp')?.path, 'src/main/webapp/WEB-INF/jsp/order/list.jsp');
  assert.equal(resolveFile(model, './src/main/webapp/WEB-INF/jsp/order/list.jsp')?.name, 'list.jsp');
  assert.equal(resolveFile(model, 'Nothing.java'), null);
  assert.equal(resolveFile(null, 'OrderServiceImpl.java'), null);
  assert.deepEqual(resolveName(model, '주문상세'), { kind: 'screen', id: 'S022', label: '주문상세' });
  assert.equal(resolveName(model, '`TB_ORDER_HIST`').kind, 'table');
  assert.equal(resolveName(model, '반품·교환 화면').kind, 'screen');
  assert.equal(resolveName(model, '주문관리').kind, 'menu');
  const f = resolveName(model, 'OrderServiceImpl.java:131');
  assert.equal(f.kind, 'file');
  assert.equal(f.kind === 'file' && f.line, 131);
  assert.equal(resolveName(model, '없는 화면').kind, 'none');
});

const PLAN = [
  '요구사항을 정리하고 계획을 세웠습니다. 기본 구성부터 테이블·소스·화면·메뉴 데이터까지 파일 17개를 만듭니다. 왼쪽 계획을 확인하고 확정해 주세요.',
  '',
  '## 요구사항',
  '- 고객 문의 목록·상세 조회와 답변 등록 (메뉴: 고객관리 › 문의관리)',
  '- 문의 유형은 공통코드(TB_CODE)로 관리',
  "- 답변을 등록하면 문의 상태를 '답변 완료'로 변경",
  '',
  '## 계획',
  '1. **기본 구성 4개** — pom.xml · web.xml · context-*.xml (접속 정보는 비워 둠)',
  '2. **테이블 2개 · DDL** — TB_INQUIRY, TB_INQUIRY_ANS',
  '3. **소스 8개** — VO · Mapper · Service · Controller · 스크립트',
  '4. **화면 3개** — 문의목록 · 문의상세 · 답변 등록',
  '5. **메뉴·코드 데이터** — menu_data.sql · TB_MENU 2건, 문의 유형 공통코드',
  '6. **컴파일 확인** — mvn -q compile · 실행할 때 확인',
].join('\n');

test('새 프로젝트: 답변에서 요구사항·계획·파일 수를 읽고, 기록에는 나머지만', () => {
  const p = parsePlan(PLAN)!;
  assert.equal(p.reqs.length, 3);
  assert.equal(p.total, 17);
  assert.deepEqual(p.items[0], { title: '기본 구성 4개', sub: 'pom.xml · web.xml · context-*.xml (접속 정보는 비워 둠)' });
  assert.equal(p.items.length, 6);
  assert.equal(stripPlan(PLAN).trim(), PLAN.split('\n')[0]);
  assert.equal(parsePlan('계획 없이 그냥 답합니다.'), null);
  // **굵게** 제목·'계획:' 줄도 제목으로 본다
  const s = sectionsOf('앞말\n**계획**\n- 하나 — 설명\n계획:\n- 둘');
  assert.deepEqual(s.map((x) => x.title), ['', '계획', '계획']);
  assert.deepEqual(listItemsOf(['1. 가', '   - 안', '2. 나']), ['가 안', '나']);
});

test('새 프로젝트: 만든 파일로 계획 항목 진행 표시', () => {
  const p = parsePlan(PLAN)!;
  const created = [
    'pom.xml', 'src/main/webapp/WEB-INF/web.xml', 'src/main/resources/egovframework/spring/context-common.xml', 'src/main/resources/egovframework/spring/context-mapper.xml',
    'db/schema/inquiry.sql',
    'a/InquiryVO.java', 'a/InquiryService.java', 'a/InquiryServiceImpl.java', 'a/InquiryDAO.java', 'm/InquiryMapper.xml', 'a/InquiryController.java', 'js/list.js', 'js/answer.js',
    'WEB-INF/jsp/inquiry/list.jsp', 'WEB-INF/jsp/inquiry/detail.jsp',
  ];
  const st = planStates(p, created, true, false);
  assert.deepEqual(
    st.map((x) => x.state),
    ['done', 'done', 'done', 'run', 'wait', 'wait'],
  );
  assert.equal(st[3].right, '2 / 3');
  assert.ok(planStates(p, created, false, true).every((x) => x.state === 'done'));
  assert.equal(fileCat('db/data/menu_data.sql'), 'data');
  assert.equal(fileCat('db/schema/inquiry.sql'), 'table');
  assert.equal(fileCat('src/main/resources/egovframework/spring/context-common.xml'), 'config');
  assert.equal(fileCat('InquiryMapper.xml'), 'source');
  assert.equal(fileCat('list.jsp'), 'view');
});
