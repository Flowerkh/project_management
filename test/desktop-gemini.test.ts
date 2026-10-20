// Gemini 연동 (gemini/*) — 가짜 Gemini 서버(127.0.0.1)로 설정·연결 확인·대화(도구 순환)·서명 유지·이어 하기·오류
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { ChatItem, DesktopEvent } from '../src/shared/desktop-api';
import { claudeModule, register } from '../src/desktop/claude/index';
import { createGeminiEngine } from '../src/desktop/gemini/index';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { services } from '../src/desktop/services';
import { FAKE_GEMINI_KEY, FAKE_VERTEX_TOKEN, type FakeGemini, startFakeGemini } from './fake-ai/fake-gemini.mjs';
import { fakeQuery } from './fake-claude/fake-query';
import { fakeDb, fakeWork } from './fake-claude/services';

const OSI = 'src/main/java/egov/shop/order/service/impl/OrderServiceImpl.java';
const savedEnv = { ...process.env };
let tmp: string;
let project: string;
let fake: FakeGemini;
let events: DesktopEvent[] = [];
let unsink: () => void;
const fq = fakeQuery(() => undefined);
const db = fakeDb();

function items(id: string): ChatItem[] {
  const m = new Map<string, ChatItem>();
  for (const e of events) if (e.type === 'claude.item' && e.conversationId === id) m.set(e.item.id, e.item);
  return [...m.values()];
}
function lastState(id: string) {
  return events.filter((e) => e.type === 'claude.state' && e.conversationId === id).pop() as Extract<DesktopEvent, { type: 'claude.state' }> | undefined;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 8000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const idle = (id: string) => waitFor(() => lastState(id) && !lastState(id)!.running && !claudeModule().manager._session(id)?.running, 8000, 'turn end');
/** 연동 켬 (앞 시험과 상관없이 혼자 돌려도 되게) */
const ensureOn = () => call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: FAKE_GEMINI_KEY });
const streamReqs = () => fake.requests.filter((r) => r.path.endsWith(':streamGenerateContent'));
/** 요청 기록에서 마지막 도구 결과들 */
function lastResults(): Record<string, string> {
  const r = streamReqs().pop()!;
  const last = r.body.contents[r.body.contents.length - 1];
  const out: Record<string, string> = {};
  for (const p of last.parts) if (p.functionResponse) out[p.functionResponse.name] = String(p.functionResponse.response.output ?? `ERROR: ${p.functionResponse.response.error}`);
  return out;
}
/** 이번 대화의 모든 요청에서 도구 결과 (이름 → 결과들) */
function allResults(fromReq: number): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const reqs = streamReqs().slice(fromReq);
  const last = reqs[reqs.length - 1];
  if (!last) return out;
  for (const c of last.body.contents) for (const p of c.parts ?? []) if (p.functionResponse) out.push({ name: p.functionResponse.name, text: String(p.functionResponse.response.output ?? `ERROR: ${p.functionResponse.response.error}`) });
  return out;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-gemini-'));
  project = path.join(tmp, 'shop-admin');
  fs.mkdirSync(path.join(project, path.dirname(OSI)), { recursive: true });
  fs.writeFileSync(path.join(project, OSI), 'package egov;\n\npublic class OrderServiceImpl {\n    void updateStat() {\n        insertOrderHist();\n    }\n}\n');
  fs.mkdirSync(path.join(project, 'src/main/resources'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/main/resources/globals.properties'), 'Globals.Password=****\n');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside secret');
  setHost(testHost(path.join(tmp, 'data'), { save: path.join(tmp, 'export.md') }));
  process.env.PA_CLAUDE_NO_DISCOVERY = '1';
  services.work = fakeWork(path.join(tmp, 'work'));
  services.db = db;
  fake = await startFakeGemini({ delayMs: 2 });
  register({
    queryFn: fq.queryFn,
    idleMs: 60000,
    interruptGraceMs: 500,
    engines: () => ({ gemini: createGeminiEngine({ baseUrl: fake.url, retryDelays: [10, 10, 10], tokenFn: async () => FAKE_VERTEX_TOKEN, commandTimeoutMs: 20000 }) }),
  });
  unsink = addEventSink((e) => events.push(e));
});

beforeEach(() => {
  fake.state.handler = null;
  fake.state.gate = null;
});

after(async () => {
  await claudeModule().manager.closeAll();
  unsink();
  await fake.close();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('설정: API 키는 비밀 값으로·켜기 조건·회사 Google Cloud 검사', async () => {
  const c0 = await call('gemini.config.get');
  assert.deepEqual(c0, { enabled: false, authMode: 'apikey', hasApiKey: false });
  await assert.rejects(call('gemini.config.set', { enabled: true, authMode: 'apikey' }), /API 키를 넣어 주세요/);
  await assert.rejects(call('gemini.config.set', { enabled: false, authMode: 'apikey', apiKey: 'has space' }), /공백/);
  await assert.rejects(call('gemini.config.set', { enabled: true, authMode: 'vertex', vertex: { project: '', location: 'us-central1' } }), /프로젝트 ID/);
  await assert.rejects(call('gemini.config.set', { enabled: false, authMode: 'vertex', vertex: { project: 'Bad Project!', location: 'us-central1' } }), /프로젝트 ID가 올바르지/);
  const c1 = await call('gemini.config.set', { enabled: false, authMode: 'apikey', apiKey: FAKE_GEMINI_KEY, proxy: 'http://user:pw@proxy.local:8080' });
  assert.equal(c1.hasApiKey, true);
  assert.equal(c1.proxy, 'http://****@proxy.local:8080');
  const file = fs.readFileSync(path.join(tmp, 'data', 'gemini.json'), 'utf8');
  assert.doesNotMatch(file, new RegExp(FAKE_GEMINI_KEY));
  assert.doesNotMatch(file, /user:pw/);
  const secrets = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'secrets.json'), 'utf8'));
  assert.ok(secrets['gemini:apikey'] && secrets['gemini:proxy']);
  // 가린 프록시를 그대로 보내면 유지, 비우면 지움
  assert.equal((await call('gemini.config.set', { enabled: false, authMode: 'apikey', proxy: 'http://****@proxy.local:8080' })).proxy, 'http://****@proxy.local:8080');
  assert.equal((await call('gemini.config.set', { enabled: false, authMode: 'apikey' })).proxy, undefined);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'secrets.json'), 'utf8'))['gemini:proxy']);
  // 꺼져 있으면 대화를 시작할 수 없다
  await assert.rejects(call('claude.start', project, { provider: 'gemini' }), /Gemini 연동이 꺼져 있습니다/);
});

test('설정: 저장이 실패하면 비밀 값도 그대로 · 다른 인증 방식의 잘못된 칸은 저장을 막지 않음', async () => {
  const secret = () => JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'secrets.json'), 'utf8'))['gemini:apikey'];
  await call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: FAKE_GEMINI_KEY });
  const s0 = secret();
  assert.ok(s0);
  // 켜 둔 채 키를 지우면 거절하고, 키는 그대로 둔다
  await assert.rejects(call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: '' }), /API 키를 넣어 주세요/);
  assert.equal(secret(), s0);
  assert.equal((await call('gemini.config.get')).hasApiKey, true);
  // 프록시 주소가 잘못돼 저장하지 못하면 새 키도 저장하지 않는다
  await assert.rejects(call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: 'other-key-123', proxy: 'proxy.local:8080' }), /프록시 주소/);
  assert.equal(secret(), s0);
  // API 키 방식일 때는 숨은 회사 Google Cloud 칸이 잘못돼도 저장된다 (그 칸은 예전 값)
  await call('gemini.config.set', { enabled: false, authMode: 'vertex', vertex: { project: 'my-gcp-project', location: 'us-central1' } });
  const c = await call('gemini.config.set', { enabled: true, authMode: 'apikey', vertex: { project: 'Bad Project!', location: 'us-central1' } });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.vertex, { project: 'my-gcp-project', location: 'us-central1' });
  await assert.rejects(call('gemini.config.set', { enabled: false, authMode: 'vertex', vertex: { project: 'Bad Project!', location: 'us-central1' } }), /프로젝트 ID가 올바르지/, '고른 방식의 칸은 확인');
  // 다음 시험을 위해 앞 시험이 끝난 상태로 (꺼짐, 키는 저장됨)
  await call('gemini.config.set', { enabled: false, authMode: 'apikey' });
});

test('연결 확인: 인터넷·인증(토큰 세기)·모델 목록, 잘못된 키', async () => {
  const st = await call('ai.status', 'gemini', true);
  assert.equal(st.state, 'on', st.message);
  assert.equal(st.checks?.cli, undefined);
  assert.equal(st.checks?.network.ok, true);
  assert.equal(st.checks?.auth.ok, true);
  assert.match(st.checks!.auth.message!, /^Gemini API 키 \(앱에 저장\) · 시험 요청 \d+\.\d초$/);
  assert.equal(st.checks?.model?.ok, true);
  assert.match(st.checks!.model!.message!, /^4개 받음$/);
  assert.ok(fake.requests.some((r) => r.path === '/v1beta/models/gemini-4-argon:countTokens' && r.apiKeyOk));
  // 꺼져 있으면 일반 상태는 off
  assert.equal((await call('ai.status', 'gemini')).state, 'off');
  const list = await call('ai.models', 'gemini');
  assert.deepEqual(
    list.models.map((m) => m.value),
    ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.0-flash-001'],
  );
  assert.equal(list.defaultName, 'Gemini 4 Argon');
  assert.deepEqual(list.models[1], { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: '빠르고 저렴' });
  // 잘못된 키 → 인증 필요
  await call('gemini.config.set', { enabled: false, authMode: 'apikey', apiKey: 'wrong-key-123' });
  const bad = await call('ai.status', 'gemini', true);
  assert.equal(bad.state, 'login');
  assert.equal(bad.code, 'auth');
  assert.equal(bad.checks?.auth.ok, false);
  assert.match(bad.message!, /^Gemini 인증에 실패했습니다/);
  assert.ok(events.some((e) => e.type === 'ai.status' && e.provider === 'gemini' && e.status.state === 'login'));
  await call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: FAKE_GEMINI_KEY });
  assert.equal((await call('ai.status', 'gemini', true)).state, 'on');
});

test('대화: 글 스트리밍·검색·읽기 도구·작업 내역·서명을 지켜 이어서 대화', async () => {
  await ensureOn();
  fake.setScenario({
    turns: [
      {
        match: '원인',
        steps: [
          { say: '코드를 찾아보겠습니다.', calls: [{ name: 'grep', args: { pattern: 'insertOrderHist' } }] },
          { calls: [{ name: 'read_file', args: { path: OSI } }] },
          { say: `이력이 두 번 저장됩니다. \`${OSI}:5\`에서 insertOrderHist를 직접 부릅니다.` },
        ],
      },
    ],
    default: [{ say: '네, 알겠습니다.' }],
  });
  const n0 = streamReqs().length;
  const conv = await call('claude.start', project, { provider: 'gemini', context: { title: '주문상세', chips: [{ kind: 'screen', label: '주문상세', text: '화면 /order/detail.do' }] } });
  assert.equal(conv.provider, 'gemini');
  await call('claude.send', conv.id, '주문 이력이 두 번 쌓이는 원인을 찾아 주세요');
  await idle(conv.id);
  const its = items(conv.id);
  assert.deepEqual(
    its.map((i) => i.type),
    ['user', 'assistant', 'activity', 'assistant'],
  );
  const act = its.find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.equal(act.summary, '작업 2건 파일 1개 읽음 · insertOrderHist 검색 1곳');
  assert.deepEqual(
    act.items.map((x) => [x.kind, x.label]),
    [
      ['search', "'insertOrderHist' 검색 1곳"],
      ['read', `${OSI} 읽음`],
    ],
  );
  assert.equal((its[1] as { text: string }).text, '코드를 찾아보겠습니다.');
  assert.match((its[3] as { text: string }).text, /이력이 두 번 저장됩니다/);
  // 스트리밍: 같은 답변 항목이 여러 번 갱신되고, 끝나면 streaming이 꺼짐
  const ups = events.filter((e) => e.type === 'claude.item' && e.item.id === its[3].id);
  assert.ok(ups.length >= 2);
  assert.ok(!(its[3] as { streaming?: boolean }).streaming);
  // 3번 불렀고, 서명이 지켜져 서버가 거절하지 않음
  const reqs = streamReqs().slice(n0);
  assert.equal(reqs.length, 3);
  const first = reqs[0].body;
  assert.match(first.systemInstruction.parts[0].text, /^너는 사용자의 소스 코드 폴더/);
  assert.match(first.systemInstruction.parts[0].text, /exit_plan_mode 도구로/);
  assert.match(first.contents[0].parts[0].text, /^\[맥락\] 주문상세\n## 화면: 주문상세\n화면 \/order\/detail\.do\n\[질문\]\n주문 이력이/);
  const names = first.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
  assert.deepEqual(names, ['list_dir', 'glob', 'grep', 'read_file', 'db_list', 'db_select', 'db_propose_change', 'edit_file', 'write_file', 'exit_plan_mode']);
  const model1 = reqs[1].body.contents[1];
  assert.equal(model1.role, 'model');
  assert.ok(model1.parts.find((p: { functionCall?: unknown; thoughtSignature?: string }) => p.functionCall)?.thoughtSignature);
  assert.match(reqs[2].body.contents[4].parts[0].functionResponse.response.output, /^ {5}1\tpackage egov;/);
  // 대화 ID·실제 모델·기록 파일
  const got = await call('claude.get', conv.id);
  assert.match(got!.sessionId!, /^gs[a-z0-9]+$/);
  assert.equal(got!.activeModel, 'gemini-4-argon');
  const hist = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'ai-sessions', 'gemini', `${got!.sessionId}.json`), 'utf8'));
  assert.equal(hist.contents.length, 6);
  // 이어서: 기록을 함께 보낸다 (맥락은 다시 붙이지 않음)
  await call('claude.send', conv.id, '고마워요');
  await idle(conv.id);
  const r4 = streamReqs().pop()!.body;
  assert.equal(r4.contents.length, 7);
  assert.deepEqual(r4.contents[6], { role: 'user', parts: [{ text: '고마워요' }] });
  // 앱을 다시 켠 것처럼 메모리에서 잊어도 파일에서 이어 간다
  await claudeModule().manager._forget(conv.id);
  await call('claude.send', conv.id, '하나 더');
  await idle(conv.id);
  assert.equal(streamReqs().pop()!.body.contents.length, 9);
  assert.ok(!items(conv.id).some((i) => i.type === 'error'));
});

test('계획 모드 → [수정 진행] → 파일 수정 → 변경 카드', async () => {
  await ensureOn();
  fake.setScenario({
    turns: [
      {
        match: '고쳐',
        steps: [
          { calls: [{ name: 'edit_file', args: { path: OSI, old_string: '        insertOrderHist();\n', new_string: '' } }] },
          { say: '계획을 드립니다.', calls: [{ name: 'exit_plan_mode', args: { plan: '## 수정 계획\n- `OrderServiceImpl.updateStat()`의 insertOrderHist 호출을 지웁니다' } }] },
          { calls: [{ name: 'edit_file', args: { path: OSI, old_string: '        insertOrderHist();\n', new_string: '' } }] },
          { say: '고쳤습니다. {{RESULT}}' },
        ],
      },
    ],
  });
  const conv = await call('claude.start', project, { provider: 'gemini' });
  await call('claude.send', conv.id, '중복 저장을 고쳐 주세요');
  const st = await waitFor(() => lastState(conv.id)?.pending, 8000, 'plan pending');
  assert.equal(st.kind, 'plan');
  assert.equal(st.title, '수정 진행');
  assert.match(st.detail, /^## 수정 계획/);
  // 계획 모드에서 고치려던 것은 막혔다
  assert.match(lastResults().edit_file, /^ERROR: 계획 모드에서는 파일을 고칠 수 없습니다/);
  await call('claude.respond', conv.id, st.requestId, true);
  await idle(conv.id);
  const its = items(conv.id);
  const mode = its.find((i) => i.type === 'mode') as Extract<ChatItem, { type: 'mode' }>;
  assert.deepEqual([mode.mode, mode.via], ['edit', 'plan']);
  const act = its.filter((i) => i.type === 'activity').pop() as Extract<ChatItem, { type: 'activity' }>;
  assert.deepEqual(
    act.items.map((x) => x.label),
    [`${OSI} 수정 · 막힘`, `${OSI} 수정`],
  );
  assert.equal(act.items[1].line, 5);
  const ch = its.find((i) => i.type === 'changes') as Extract<ChatItem, { type: 'changes' }>;
  assert.deepEqual(ch.paths, [OSI]);
  assert.equal(ch.minus, 1);
  const w = services.work as ReturnType<typeof fakeWork>;
  const copy = w.copies.get(ch.workId)!;
  assert.doesNotMatch(fs.readFileSync(path.join(copy.path, OSI), 'utf8'), /insertOrderHist/);
  assert.doesNotMatch(fs.readFileSync(path.join(project, OSI), 'utf8'), /^$/); // 원본은 그대로
  assert.match(fs.readFileSync(path.join(project, OSI), 'utf8'), /insertOrderHist/);
  assert.equal((await call('claude.get', conv.id))!.mode, 'edit');
});

test('막기 규칙: 접속 정보 파일·작업 폴더 밖, 셸 명령은 허용 목록 + 매번 확인', async () => {
  await ensureOn();
  await call('ai.settings.set', { shellAllow: ['echo'] });
  fake.setScenario({
    turns: [
      {
        match: '설정 파일',
        steps: [
          { calls: [{ name: 'read_file', args: { path: 'src/main/resources/globals.properties' } }] },
          { calls: [{ name: 'grep', args: { pattern: 'Password' } }] },
          { calls: [{ name: 'read_file', args: { path: '../../outside.txt' } }] },
          { calls: [{ name: 'run_command', args: { command: 'echo hello' } }] },
          { calls: [{ name: 'run_command', args: { command: 'rm -rf build' } }] },
          { calls: [{ name: 'unknown_tool', args: {} }] },
          { say: '확인했습니다.' },
        ],
      },
    ],
  });
  const n0 = streamReqs().length;
  const conv = await call('claude.start', project, { provider: 'gemini' });
  await call('claude.send', conv.id, '설정 파일을 보여 주세요');
  const st = await waitFor(() => lastState(conv.id)?.pending, 8000, 'command pending');
  assert.deepEqual([st.kind, st.title, st.detail], ['command', 'Gemini가 명령을 실행하려고 합니다', 'echo hello']);
  await call('claude.respond', conv.id, st.requestId, true);
  await idle(conv.id);
  const res = allResults(n0);
  assert.deepEqual(
    res.map((r) => r.name),
    ['read_file', 'grep', 'read_file', 'run_command', 'run_command', 'unknown_tool'],
  );
  assert.equal(res[0].text, 'ERROR: 접속 정보 파일은 읽을 수 없습니다');
  assert.equal(res[1].text, 'No matches found');
  assert.match(res[2].text, /^ERROR: 작업 폴더 밖의 파일은 읽을 수 없습니다/);
  assert.match(res[3].text, /^종료 코드 0 \(\d+\.\d초\)\nhello$/);
  assert.match(res[4].text, /^ERROR: 허용 목록에 없는 명령입니다: rm -rf build/);
  assert.equal(res[5].text, 'ERROR: 이 앱에 없는 도구입니다: unknown_tool');
  // 셸 도구를 알려 주고 규칙에 허용 목록을 적는다
  const body = streamReqs()[n0].body;
  assert.ok(body.tools[0].functionDeclarations.some((d: { name: string }) => d.name === 'run_command'));
  assert.match(body.systemInstruction.parts[0].text, /셸 명령은 run_command 도구로, 다음으로 시작하는 것만 쓸 수 있고, 실행할 때마다 사용자가 확인한다: `echo`/);
  const act = items(conv.id).find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.match(act.summary, /echo hello 성공|명령 2개 실행/);
  await call('ai.settings.set', { shellAllow: [] });
});

test('DB: 개발 조회는 바로, 운영 조회는 확인 · 변경 쿼리는 쿼리 카드', async () => {
  await ensureOn();
  fake.setScenario({
    turns: [
      {
        match: 'DB',
        steps: [
          { calls: [{ name: 'db_select', args: { sql: 'SELECT ORDER_NO, COUNT(*) CNT FROM ORDER_HIST GROUP BY ORDER_NO' } }] },
          { calls: [{ name: 'db_select', args: { sql: 'SELECT * FROM ORDER_HIST', env: 'prod' } }] },
          { calls: [{ name: 'db_propose_change', args: { sql: 'DELETE FROM ORDER_HIST WHERE DUP = 1', description: '중복 이력 지우기', revert_sql: 'INSERT …' } }] },
          { say: '정리했습니다.' },
        ],
      },
    ],
  });
  const n0 = streamReqs().length;
  const conv = await call('claude.start', project, { provider: 'gemini' });
  await call('claude.send', conv.id, 'DB에서 중복을 확인해 주세요');
  const st = await waitFor(() => lastState(conv.id)?.pending, 8000, 'prod select pending');
  assert.equal(st.kind, 'prod-select');
  assert.match(st.detail, /^Gemini가 운영 DB shop_prd를 조회하려고 합니다/);
  await call('claude.respond', conv.id, st.requestId, false);
  await idle(conv.id);
  const res = allResults(n0);
  assert.match(res[0].text, /^환경: 개발\(dev\) · DB: shop_dev · 2행/);
  assert.match(res[1].text, /^사용자가 이 조회를 거부했습니다/);
  assert.match(res[2].text, /^쿼리 카드를 만들었습니다/);
  const its = items(conv.id);
  assert.ok(its.some((i) => i.type === 'select'));
  const q = its.find((i) => i.type === 'query') as Extract<ChatItem, { type: 'query' }>;
  assert.equal(q.card.description, '중복 이력 지우기');
});

test('오류: 서버 혼잡은 다시 시도, 사용 한도·인증 실패는 오류 항목과 상태', async () => {
  await ensureOn();
  fake.setScenario({
    turns: [
      { match: '혼잡', steps: [{ error: { status: 503, statusText: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.', times: 2 }, say: '이제 됩니다.' }] },
      {
        match: '한도',
        steps: [
          {
            error: {
              status: 429,
              statusText: 'RESOURCE_EXHAUSTED',
              message: 'You exceeded your current quota, please check your plan and billing details.',
              details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '40s' }],
            },
          },
        ],
      },
      { match: '안전', steps: [{ blocked: 'SAFETY' }] },
    ],
  });
  const conv = await call('claude.start', project, { provider: 'gemini' });
  await call('claude.send', conv.id, '혼잡 시험');
  await idle(conv.id);
  let its = items(conv.id);
  assert.ok(its.some((i) => i.type === 'notice' && i.text === 'Gemini 서버 응답이 늦어 다시 시도하는 중입니다 (2/4)'));
  assert.equal((its.filter((i) => i.type === 'assistant').pop() as { text: string }).text, '이제 됩니다.');
  await call('claude.send', conv.id, '한도 시험');
  await idle(conv.id);
  its = items(conv.id);
  const err = its.filter((i) => i.type === 'error').pop() as Extract<ChatItem, { type: 'error' }>;
  assert.equal(err.code, 'limit');
  assert.match(err.message, /^사용 한도: HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota/);
  const st = await call('ai.status', 'gemini');
  assert.equal(st.code, 'limit');
  assert.match(st.message!, /^Gemini 사용 한도에 도달했습니다/);
  await call('claude.send', conv.id, '안전 시험');
  await idle(conv.id);
  const e2 = items(conv.id).filter((i) => i.type === 'error').pop() as Extract<ChatItem, { type: 'error' }>;
  assert.match(e2.message, /^오류: Gemini가 요청을 거절했습니다 \(SAFETY\)/);
  // 오류 뒤에도 이어서 대화된다 (기록의 짝을 맞춤)
  await call('claude.send', conv.id, '다시 해 볼게요');
  await idle(conv.id);
  assert.equal((items(conv.id).filter((i) => i.type === 'assistant').pop() as { text: string }).text, 'OK');
  const c = streamReqs().pop()!.body.contents;
  for (let i = 1; i < c.length; i++) assert.notEqual(c[i].role, c[i - 1].role, `기록 ${i}번의 역할이 앞과 같음`);
  // 잘못된 키 → 인증 오류 → 상태 login
  await call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: 'wrong-key-456' });
  await call('claude.send', conv.id, '인증 시험');
  await idle(conv.id);
  const e3 = items(conv.id).filter((i) => i.type === 'error').pop() as Extract<ChatItem, { type: 'error' }>;
  assert.equal(e3.code, 'auth');
  assert.equal((await call('ai.status', 'gemini')).state, 'login');
  await call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: FAKE_GEMINI_KEY });
  await call('claude.send', conv.id, '되돌림');
  await idle(conv.id);
  assert.equal((await call('ai.status', 'gemini')).state, 'on');
});

test('[중지]: 응답 중에 멈추고, 다음 질문은 이어서', async () => {
  await ensureOn();
  let release!: () => void;
  fake.setScenario({ turns: [{ match: '멈춤', steps: [{ calls: [{ name: 'list_dir', args: {} }] }, { say: '목록을 봤습니다.' }] }] });
  const conv = await call('claude.start', project, { provider: 'gemini' });
  fake.state.handler = (_b, info) => {
    if (info.step === 1) fake.state.gate = new Promise<void>((r) => (release = r));
    return null;
  };
  await call('claude.send', conv.id, '멈춤 시험');
  await waitFor(() => !!fake.state.gate, 8000, 'gate');
  await call('claude.interrupt', conv.id);
  await idle(conv.id);
  release();
  fake.state.handler = null;
  fake.state.gate = null;
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && i.text === '응답을 중지했습니다'));
  assert.ok(!items(conv.id).some((i) => i.type === 'error'));
  await call('claude.send', conv.id, '다음 질문');
  await idle(conv.id);
  assert.equal((items(conv.id).filter((i) => i.type === 'assistant').pop() as { text: string }).text, 'OK');
});

test('기록 파일이 없으면 맥락을 붙여 새로 이어 감 · 대화를 지우면 기록도 지움', async () => {
  await ensureOn();
  const conv = await call('claude.start', project, { provider: 'gemini', context: { title: '주문', chips: [{ kind: 'table', label: 'ORDER_HIST', text: '컬럼: ORDER_NO' }] } });
  await call('claude.send', conv.id, '첫 질문');
  await idle(conv.id);
  const sid = (await call('claude.get', conv.id))!.sessionId!;
  const f = path.join(tmp, 'data', 'ai-sessions', 'gemini', `${sid}.json`);
  assert.ok(fs.existsSync(f));
  fs.rmSync(f);
  await claudeModule().manager._forget(conv.id);
  await call('claude.send', conv.id, '두 번째 질문');
  await idle(conv.id);
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && i.text === '이전 Gemini 대화 기록을 찾지 못해 새로 이어서 진행합니다 (앞의 대화 내용은 Gemini가 기억하지 못합니다)'));
  const body = streamReqs().pop()!.body;
  assert.equal(body.contents.length, 1);
  assert.match(body.contents[0].parts[0].text, /^\[맥락\] 주문\n## 테이블: ORDER_HIST\n컬럼: ORDER_NO\n\[질문\]\n두 번째 질문$/);
  const sid2 = (await call('claude.get', conv.id))!.sessionId!;
  assert.notEqual(sid2, sid);
  await call('claude.delete', conv.id);
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'ai-sessions', 'gemini', `${sid2}.json`)));
});

test('다른 AI로 새 대화: 이전 대화의 질문·답변 글과 맥락을 붙인다', async () => {
  await ensureOn();
  const from = await call('claude.start', project, { provider: 'gemini', context: { title: '주문상세', chips: [{ kind: 'screen', label: '주문상세', text: '화면' }] } });
  await call('claude.send', from.id, '이전 질문입니다');
  await idle(from.id);
  const to = await call('claude.start', project, { provider: 'gemini', carryFrom: from.id, model: 'gemini-3.8-flash' });
  assert.equal(to.model, 'gemini-3.8-flash');
  assert.deepEqual(
    to.context!.chips.map((c) => [c.kind, c.label]),
    [
      ['screen', '주문상세'],
      ['conversation', '이전 대화 (Gemini)'],
    ],
  );
  assert.equal(to.context!.chips[1].text, '[사용자] 이전 질문입니다\n\n[Gemini] OK');
  await call('claude.send', to.id, '이어서 정리해 주세요');
  await idle(to.id);
  const req = streamReqs().pop()!;
  assert.match(req.path, /gemini-3\.8-flash:streamGenerateContent$/);
  assert.match(req.body.contents[0].parts[0].text, /## 이전 대화: 이전 대화 \(Gemini\)\n\[사용자\] 이전 질문입니다\n\n\[Gemini\] OK\n\[질문\]\n이어서 정리해 주세요$/);
  await assert.rejects(call('claude.start', project, { provider: 'gemini', carryFrom: 'cnotexist123' }), /이전 대화를 찾을 수 없습니다/);
  // 모델 바꾸기: 다음 응답부터
  await call('claude.setModel', to.id, 'gemini-3.5-flash-lite');
  assert.ok(items(to.id).some((i) => i.type === 'notice' && i.text === '모델을 Gemini 3.5 Flash-Lite(으)로 바꿨습니다'));
  await call('claude.send', to.id, '한 번 더');
  await idle(to.id);
  assert.match(streamReqs().pop()!.path, /gemini-3\.5-flash-lite:streamGenerateContent$/);
});

test('회사 Google Cloud (Vertex AI): gcloud 토큰·프로젝트 주소·알려진 모델', async () => {
  await call('gemini.config.set', { enabled: true, authMode: 'vertex', vertex: { project: 'my-proj-123', location: 'asia-northeast3' } });
  const st = await call('ai.status', 'gemini', true);
  assert.equal(st.state, 'on', st.message);
  assert.equal(st.authLabel, '회사 Google Cloud (my-proj-123 · asia-northeast3)');
  assert.match(st.checks!.model!.message!, /알려진 모델 3개/);
  const ct = fake.requests.filter((r) => r.path.endsWith(':countTokens')).pop()!;
  assert.equal(ct.path, '/v1/projects/my-proj-123/locations/asia-northeast3/publishers/google/models/gemini-4-argon:countTokens');
  assert.ok(ct.bearerOk);
  const conv = await call('claude.start', project, { provider: 'gemini' });
  await call('claude.send', conv.id, '안녕하세요');
  await idle(conv.id);
  const r = streamReqs().pop()!;
  assert.ok(r.vertex && r.bearerOk);
  assert.equal((items(conv.id).filter((i) => i.type === 'assistant').pop() as { text: string }).text, 'OK');
  await call('gemini.config.set', { enabled: true, authMode: 'apikey', apiKey: FAKE_GEMINI_KEY });
});

test('연동 끄기: 열린 Gemini 대화만 닫는다', async () => {
  await ensureOn();
  const conv = await call('claude.start', project, { provider: 'gemini' });
  await call('claude.send', conv.id, '안녕');
  await idle(conv.id);
  assert.ok(claudeModule().manager._session(conv.id)?.hasQuery);
  await call('gemini.config.set', { enabled: false, authMode: 'apikey' });
  assert.equal(claudeModule().manager._session(conv.id)?.hasQuery, false);
  await assert.rejects(call('claude.send', conv.id, '다시'), /Gemini 연동이 꺼져 있습니다. 설정 > AI 연결 > Gemini에서 켜 주세요/);
  await call('gemini.config.set', { enabled: true, authMode: 'apikey' });
});
