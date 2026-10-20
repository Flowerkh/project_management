// ChatGPT 엔진을 실제 Codex(app-server)로 시험 — PA_REAL_CODEX=<codex 실행 파일>일 때만 (없으면 건너뜀)
// 모델 서버는 가짜 OpenAI Responses API(127.0.0.1)라 실제 OpenAI·ChatGPT 계정·네트워크를 쓰지 않는다 (API 키 방식 + 시험 주소).
// CODEX_HOME은 임시 폴더 (PC의 Codex 로그인·설정을 건드리지 않음).
//   예: PA_REAL_CODEX=$(command -v codex) npx tsx --test test/desktop-openai-real.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChatItem, DesktopEvent } from '../src/shared/desktop-api';
import { claudeModule, register } from '../src/desktop/claude/index';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { createCodexEngine } from '../src/desktop/openai/index';
import { services } from '../src/desktop/services';
import { FAKE_OPENAI_KEY, type FakeOpenAI, startFakeOpenAI } from './fake-ai/fake-openai.mjs';
import { fakeQuery } from './fake-claude/fake-query';
import { fakeDb, fakeWork } from './fake-claude/services';

const REAL = process.env.PA_REAL_CODEX;
const skip = !REAL ? 'PA_REAL_CODEX가 없어 건너뜀' : false;
const here = path.dirname(fileURLToPath(import.meta.url));
const OSI = 'src/main/java/egov/OrderServiceImpl.java';
const savedEnv = { ...process.env };
let tmp: string;
let project: string;
let fake: FakeOpenAI;
let events: DesktopEvent[] = [];
let unsink: (() => void) | null = null;

function items(id: string): ChatItem[] {
  const m = new Map<string, ChatItem>();
  for (const e of events) if (e.type === 'claude.item' && e.conversationId === id) m.set(e.item.id, e.item);
  return [...m.values()];
}
function lastState(id: string) {
  return events.filter((e) => e.type === 'claude.state' && e.conversationId === id).pop() as Extract<DesktopEvent, { type: 'claude.state' }> | undefined;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 30000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const idle = (id: string) => waitFor(() => lastState(id) && !lastState(id)!.running && !claudeModule().manager._session(id)?.running, 60000, 'turn end');
const respReqs = () => fake.requests.filter((r) => r.path.endsWith('/responses'));
const lastAssistant = (id: string) => (items(id).filter((i) => i.type === 'assistant').pop() as { text: string } | undefined)?.text;

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-codex-real-'));
  project = path.join(tmp, 'shop');
  fs.mkdirSync(path.join(project, path.dirname(OSI)), { recursive: true });
  fs.writeFileSync(path.join(project, OSI), 'package egov;\n\npublic class OrderServiceImpl {\n    void updateStat() {\n        insertOrderHist();\n    }\n}\n');
  // 사용자 Codex 설정에 MCP 서버가 있어도 앱 대화에서는 꺼져야 한다
  const home = path.join(tmp, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), `[mcp_servers.leaky]\ncommand = "node"\nargs = [${JSON.stringify(path.join(here, 'fake-ai', 'fake-mcp.mjs'))}]\n`);
  process.env.CODEX_HOME = home;
  process.env.PA_CODEX_CLI = REAL;
  process.env.PA_CLAUDE_NO_DISCOVERY = '1';
  setHost(testHost(path.join(tmp, 'data')));
  services.work = fakeWork(path.join(tmp, 'work'));
  services.db = fakeDb();
  fake = await startFakeOpenAI({ delayMs: 3 });
  register({
    queryFn: fakeQuery(() => undefined).queryFn,
    idleMs: 60000,
    interruptGraceMs: 5000,
    engines: () => ({ openai: createCodexEngine({ baseUrl: `${fake.url}/v1`, providerExtra: { request_max_retries: 0, stream_max_retries: 0 }, commandTimeoutMs: 20000, probeTimeoutMs: 30000 }) }),
  });
  unsink = addEventSink((e) => events.push(e));
  await call('openai.config.set', { enabled: true, authMode: 'apikey', apiKey: FAKE_OPENAI_KEY, model: 'gpt-fake-1' });
});

beforeEach(() => {
  if (skip) return;
  fake.state.handler = null;
  fake.state.gate = null;
  fake.setScenario({ turns: [], default: [{ say: 'OK' }] });
});

after(async () => {
  if (skip) return;
  await claudeModule().manager.closeAll();
  unsink?.();
  await fake.close();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('실제 Codex: 연결 확인(버전·시험 요청)·모델 목록', { skip }, async () => {
  const st = await call('ai.status', 'openai', true);
  assert.equal(st.state, 'on', `${st.message} / ${JSON.stringify(st.checks)}`);
  assert.match(st.version!, /^\d+\.\d+\.\d+$/);
  assert.match(st.checks!.auth.message!, /^OpenAI API 키 \(앱에 저장\) · 시험 요청/);
  const probe = respReqs().pop()!;
  assert.ok(probe.keyOk);
  const list = await call('ai.models', 'openai', true);
  assert.ok(list.models.length > 0, JSON.stringify(list));
});

test('실제 Codex: 앱 도구만 보이고(자체 도구·MCP 끔), 동적 도구로 검색·읽기, 앱 지시가 들어감', { skip }, async () => {
  fake.setScenario({
    turns: [
      {
        match: '원인',
        steps: [
          { say: '찾아보겠습니다.', calls: [{ name: 'grep', args: { pattern: 'insertOrderHist' } }] },
          { calls: [{ name: 'read_file', args: { path: OSI } }] },
          { say: '원인: {{RESULT}}' },
        ],
      },
    ],
  });
  const n0 = respReqs().length;
  const conv = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', conv.id, '이력이 두 번 쌓이는 원인을 찾아 주세요');
  await idle(conv.id);
  const its = items(conv.id);
  assert.ok(!its.some((i) => i.type === 'error'), JSON.stringify(its.filter((i) => i.type === 'error')));
  const act = its.find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.equal(act.summary, '작업 2건 파일 1개 읽음 · insertOrderHist 검색 1곳');
  assert.match(lastAssistant(conv.id)!, /^원인: {6}1\tpackage egov;/);
  const reqs = respReqs().slice(n0);
  assert.equal(reqs.length, 3);
  const tools = (reqs[0].body.tools ?? []).map((t: { name?: string; type?: string }) => t.name ?? t.type);
  // Codex가 늘 붙이는 request_user_input(질문)·update_plan(할 일 표시, 0.150) 말고는 앱 도구뿐 (셸·apply_patch·MCP 없음)
  assert.deepEqual(
    tools.filter((t: string) => t !== 'request_user_input' && t !== 'update_plan').sort(),
    ['db_list', 'db_propose_change', 'db_select', 'edit_file', 'exit_plan_mode', 'glob', 'grep', 'list_dir', 'read_file', 'run_command', 'write_file'],
  );
  // 앱 지시: 0.163은 developer 메시지, 0.150은 instructions 칸으로 보낸다
  const text = JSON.stringify([reqs[0].body.instructions ?? '', reqs[0].body.input]);
  assert.match(text, /너는 사용자의 소스 코드 폴더/);
  assert.match(text, /프로젝트 분석 시스템 안에서 일하는 규칙/);
  assert.ok(reqs.every((r) => r.keyOk));
  assert.equal(reqs[0].body.model, 'gpt-fake-1');
  assert.equal((await call('claude.get', conv.id))!.activeModel, 'gpt-fake-1');
  // 이어서
  await call('claude.send', conv.id, '고마워요');
  await idle(conv.id);
  assert.equal(lastAssistant(conv.id), 'OK');
  // 앱을 다시 켠 것처럼 → thread/resume (새 Codex 프로세스) → 기록이 이어짐
  const before = respReqs().pop()!.body.input.length;
  await claudeModule().manager._forget(conv.id);
  await call('claude.send', conv.id, '하나 더');
  await idle(conv.id);
  assert.ok(respReqs().pop()!.body.input.length > before);
  assert.ok(!items(conv.id).some((i) => i.type === 'notice' && /찾지 못해/.test(i.text)));
});

test('실제 Codex: 계획 → [수정 진행] → 수정 → 변경 카드', { skip }, async () => {
  fake.setScenario({
    turns: [
      {
        match: '고쳐',
        steps: [
          { calls: [{ name: 'edit_file', args: { path: OSI, old_string: '        insertOrderHist();\n', new_string: '' } }] },
          { say: '계획입니다.', calls: [{ name: 'exit_plan_mode', args: { plan: '## 수정 계획\n- 호출 삭제' } }] },
          { calls: [{ name: 'edit_file', args: { path: OSI, old_string: '        insertOrderHist();\n', new_string: '' } }] },
          { say: '고쳤습니다.' },
        ],
      },
    ],
  });
  const conv = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', conv.id, '고쳐 주세요');
  const st = await waitFor(() => lastState(conv.id)?.pending, 60000, 'plan pending');
  assert.equal(st.kind, 'plan');
  await call('claude.respond', conv.id, st.requestId, true);
  await idle(conv.id);
  const its = items(conv.id);
  assert.ok(its.some((i) => i.type === 'changes'), JSON.stringify(its.map((i) => i.type)));
  const act = its.filter((i) => i.type === 'activity').pop() as Extract<ChatItem, { type: 'activity' }>;
  assert.deepEqual(
    act.items.map((x) => x.label),
    [`${OSI} 수정 · 막힘`, `${OSI} 수정`],
  );
});

test('실제 Codex: [중지]와 오류(인증·한도)', { skip }, async () => {
  fake.setScenario({
    turns: [
      { match: '긴', steps: [{ say: '긴 답변입니다. '.repeat(40), chunks: 80, delayMs: 50 }] },
      { match: '인증', steps: [{ error: { status: 401, message: 'Incorrect API key provided', code: 'invalid_api_key' } }] },
      { match: '한도', steps: [{ error: { status: 429, message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }] },
    ],
  });
  const conv = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', conv.id, '긴 답변');
  await waitFor(() => items(conv.id).some((i) => i.type === 'assistant'), 30000, 'streaming');
  await call('claude.interrupt', conv.id);
  await idle(conv.id);
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && i.text === '응답을 중지했습니다'));
  assert.ok(!items(conv.id).some((i) => i.type === 'error'));
  await call('claude.send', conv.id, '인증 시험');
  await idle(conv.id);
  let err = items(conv.id).filter((i) => i.type === 'error').pop() as Extract<ChatItem, { type: 'error' }>;
  assert.equal(err.code, 'auth', err.message);
  await call('claude.send', conv.id, '한도 시험');
  await idle(conv.id);
  err = items(conv.id).filter((i) => i.type === 'error').pop() as Extract<ChatItem, { type: 'error' }>;
  assert.equal(err.code, 'limit', err.message);
});
