// 작업 이력: 추가만 하는 기록(JSONL)·갱신 합치기·목록·CSV 내보내기
//   npx tsx --test test/desktop-history.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { DesktopEvent } from '../src/shared/desktop-api';
import { historyCsv, register as historyRegister } from '../src/desktop/history';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { register as projectRegister } from '../src/desktop/project';
import { services } from '../src/desktop/services';
import { projectDir } from '../src/desktop/store';

let tmp = '';
let root = '';
const events: DesktopEvent[] = [];

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-v-hist-'));
  root = path.join(tmp, 'shop-admin');
  fs.mkdirSync(root, { recursive: true });
  setHost(testHost(path.join(tmp, 'data'), { save: path.join(tmp, 'out.csv') }));
  projectRegister();
  historyRegister();
  addEventSink((ev) => events.push(ev));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('기록은 추가만: 갱신·진행 기록은 줄을 덧붙이고 읽을 때 합친다', async () => {
  const h = services.history!;
  const a = await h.add(root, { kind: 'apply', title: '주문 이력 중복 저장 수정', status: '적용됨', files: [{ path: 'a.java', status: 'modified', plus: 1, minus: 1 }], conversationId: 'c1', error: 'x', at: '2026-10-17T02:02:00.000Z' });
  assert.match(a.id, /^h/);
  assert.equal(a.at, '2026-10-17T02:02:00.000Z');
  assert.ok(events.some((e) => e.type === 'history.added' && e.entry.id === a.id));
  const fixed = await h.add(root, { id: 'hfixed1', kind: 'query', title: '중복 삭제', status: '실행됨', sql: 'DELETE FROM T', db: { env: 'dev', name: 'shop_dev', account: 'shop_app' }, affected: 1284, expected: 1284, ms: 800, at: '2026-10-17T02:04:00.000Z' });
  assert.equal(fixed.id, 'hfixed1', '미리 정한 ID');
  const dup = await h.add(root, { id: 'hfixed1', kind: 'query', title: 'dup', status: '실행됨' });
  assert.notEqual(dup.id, 'hfixed1', '같은 ID는 새로');

  const u = await h.update(root, a.id, { status: '커밋됨', commit: '7d2e1f0', error: undefined });
  assert.equal(u?.status, '커밋됨');
  assert.equal(u?.commit, '7d2e1f0');
  assert.equal(u?.error, undefined, 'undefined로 갱신하면 지움');
  assert.ok(events.some((e) => e.type === 'history.updated' && e.entry.id === a.id));
  const s1 = await h.addStep(root, a.id, { label: '커밋', detail: '7d2e1f0 · "fix"', ok: true });
  const s2 = await h.addStep(root, a.id, { label: '다시 분석', detail: '4초 · 바뀐 연결 없음', ok: true });
  assert.equal(s1?.steps?.length, 1);
  assert.deepEqual(s2?.steps?.map((s) => s.label), ['커밋', '다시 분석']);
  assert.equal(await h.update(root, 'nope', { status: '실패' }), null);
  assert.equal(await h.addStep(root, 'nope', { label: 'x', ok: true }), null);

  // 파일에는 추가한 줄만 있다
  const lines = fs.readFileSync(path.join(projectDir(root), 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.t), ['add', 'add', 'add', 'set', 'step', 'step']);
  // 다른 곳(다른 창·프로세스)에서 덧붙인 줄도 읽는다
  fs.appendFileSync(path.join(projectDir(root), 'history.jsonl'), `${JSON.stringify({ t: 'set', id: a.id, p: { pushed: true, status: '푸시됨' }, at: new Date().toISOString() })}\n{깨진 줄\n`);
  const got = await h.get(root, a.id);
  assert.equal(got?.status, '푸시됨');
  assert.equal(got?.pushed, true);
  assert.equal(got?.steps?.length, 2);

  // 목록은 최근 것부터, 개발·QA SELECT는 화면 목록에서 빼고 CSV에만
  await h.add(root, { kind: 'select', title: '개발 DB 조회', status: '조회', sql: 'SELECT 1 FROM DUAL', db: { env: 'dev', name: 'shop_dev', account: 'shop_read' }, affected: 1, at: '2026-10-17T02:05:00.000Z' });
  await h.add(root, { kind: 'prod-select', title: '운영 DB 중복 이력 건수 확인', status: '조회', sql: 'SELECT COUNT(*) FROM TB_ORDER_HIST', db: { env: 'prod', name: 'shop_prd', account: 'shop_read' }, affected: 1, maskedColumns: ['USER_NM'], at: '2026-10-17T01:52:00.000Z' });
  const all = await h.list(root);
  assert.equal(all.length, 5);
  const shown = await call('history.list', root);
  assert.equal(shown.length, 4);
  assert.ok(!shown.some((e) => e.kind === 'select'));
  const times = shown.map((e) => e.at);
  assert.deepEqual([...times].sort().reverse(), times, '최근 순');
});

test('history.step 채널: 진행 기록 추가, 잘못된 값은 거절', async () => {
  const e = await services.history!.add(root, { kind: 'apply', title: '단계', status: '적용됨' });
  const r = await call('history.step', root, e.id, { label: '다시 분석', detail: '3초 · 바뀐 연결 없음', ok: true });
  assert.equal(r?.steps?.[0].label, '다시 분석');
  await assert.rejects(call('history.step', root, e.id, { label: '', ok: true }));
  await assert.rejects(call('history.step', root, '../x', { label: 'a', ok: true }), /기록 ID/);
  await assert.rejects(call('history.list', 'relative/path'), /프로젝트 폴더/);
  assert.deepEqual(await call('history.diff', root, e.id), [], '보관본 없는 기록');
});

test('CSV: UTF-8 BOM, Excel이 수식으로 읽지 않게, SELECT 포함', async () => {
  const csv = historyCsv([
    { id: '1', at: '2026-10-17T02:04:00.000Z', kind: 'query', title: '주문 이력 중복 1,284건 삭제', status: '실행됨', sql: 'DELETE FROM TB_ORDER_HIST H\n WHERE H.ROWID NOT IN (SELECT "A")', db: { env: 'dev', name: 'shop_dev', account: 'shop_app' }, expected: 1284, affected: 1284, conversationId: 'c1' },
    { id: '2', at: '2026-10-17T02:02:00.000Z', kind: 'apply', title: '=HYPERLINK("x")', status: '적용됨', error: 'Git 커밋에 실패했습니다', files: [{ path: 'a.java', status: 'modified', plus: 1, minus: 0 }, { path: 'b.java', status: 'added', plus: 3, minus: 0 }], commit: '7d2e1f0', pushed: true },
    { id: '3', at: '2026-10-17T02:01:00.000Z', kind: 'select', title: '개발 DB 조회', status: '조회', sql: '-- 주석\nSELECT 1', db: { env: 'qa', name: 'shop_qa', account: 'shop_read' }, affected: 3, maskedColumns: ['USER_NM', 'USER_TEL'] },
  ]);
  assert.ok(csv.startsWith('﻿시각,종류,제목,상태,대상(파일·DB),커밋,SQL,예상/실제 행,가린 컬럼,대화\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.match(lines[1], /^2026-10-17 \d\d:04:00,쿼리 실행,"주문 이력 중복 1,284건 삭제",실행됨,개발 shop_dev \(shop_app\),,"DELETE FROM TB_ORDER_HIST H\n WHERE H.ROWID NOT IN \(SELECT ""A""\)",1284 \/ 1284,,c1$/);
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")",적용됨 (커밋·푸시 실패),a.java; b.java,7d2e1f0 (푸시)`)), '수식 막기·파일 목록·푸시');
  assert.ok(csv.includes(`조회(개발·QA),개발 DB 조회,조회,QA shop_qa (shop_read),,"'-- 주석\nSELECT 1",3,"USER_NM, USER_TEL",`));

  // 채널: host의 저장 대화상자로 저장
  const saved = await call('history.exportCsv', root);
  assert.equal(saved, path.join(tmp, 'out.csv'));
  const text = fs.readFileSync(saved as string, 'utf8');
  assert.ok(text.startsWith('﻿시각,'));
  assert.ok(text.includes('조회(개발·QA)'), '화면 목록에 없는 개발·QA SELECT도 CSV에');
});
