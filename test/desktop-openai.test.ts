// ChatGPT 연동 (openai/*) — 가짜 Codex(test/fake-ai/fake-codex.mjs)로 설정·연결 확인·대화(동적 도구)·이어 하기·오류
// 실제 Codex 프로토콜은 desktop-openai-real.test.ts (PA_REAL_CODEX가 있을 때)
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
import { fakeQuery } from './fake-claude/fake-query';
import { fakeDb, fakeWork } from './fake-claude/services';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-ai', 'fake-codex.mjs');
const OSI = 'src/main/java/egov/shop/order/service/impl/OrderServiceImpl.java';
const savedEnv = { ...process.env };
let tmp: string;
let project: string;
let logFile: string;
let events: DesktopEvent[] = [];
let unsink: () => void;
const fq = fakeQuery(() => undefined);

function items(id: string): ChatItem[] {
  const m = new Map<string, ChatItem>();
  for (const e of events) if (e.type === 'claude.item' && e.conversationId === id) m.set(e.item.id, e.item);
  return [...m.values()];
}
function lastState(id: string) {
  return events.filter((e) => e.type === 'claude.state' && e.conversationId === id).pop() as Extract<DesktopEvent, { type: 'claude.state' }> | undefined;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 10000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const idle = (id: string) => waitFor(() => lastState(id) && !lastState(id)!.running && !claudeModule().manager._session(id)?.running, 10000, 'turn end');
type Log = Record<string, any>;
const logs = (): Log[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastLog = (kind: string): Log | undefined => logs().filter((l) => l.kind === kind).pop();
const scenario = (s: unknown) => (process.env.PA_FAKE_CODEX_SCENARIO = JSON.stringify(s));
const ensureOn = (extra: Record<string, unknown> = {}) => call('openai.config.set', { enabled: true, authMode: 'chatgpt', ...extra });
const lastAssistant = (id: string) => (items(id).filter((i) => i.type === 'assistant').pop() as { text: string } | undefined)?.text;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-openai-'));
  project = path.join(tmp, 'shop-admin');
  fs.mkdirSync(path.join(project, path.dirname(OSI)), { recursive: true });
  fs.writeFileSync(path.join(project, OSI), 'package egov;\n\npublic class OrderServiceImpl {\n    void updateStat() {\n        insertOrderHist();\n    }\n}\n');
  fs.mkdirSync(path.join(project, 'src/main/resources'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/main/resources/globals.properties'), 'Globals.Password=****\n');
  setHost(testHost(path.join(tmp, 'data')));
  logFile = path.join(tmp, 'codex.log');
  process.env.PA_CODEX_CLI = FAKE;
  process.env.PA_FAKE_CODEX_STATE = path.join(tmp, 'codex-state');
  process.env.PA_FAKE_CODEX_LOG = logFile;
  process.env.PA_CLAUDE_NO_DISCOVERY = '1';
  services.work = fakeWork(path.join(tmp, 'work'));
  services.db = fakeDb();
  register({ queryFn: fq.queryFn, idleMs: 60000, interruptGraceMs: 2000, engines: () => ({ openai: createCodexEngine({ commandTimeoutMs: 20000, probeTimeoutMs: 10000 }) }) });
  unsink = addEventSink((e) => events.push(e));
});

beforeEach(() => {
  delete process.env.PA_FAKE_CODEX_FAIL;
  delete process.env.PA_FAKE_CODEX_AUTH;
  delete process.env.PA_FAKE_CODEX_MCP;
  scenario({ turns: [], default: [{ say: 'OK' }] });
});

after(async () => {
  await claudeModule().manager.closeAll();
  unsink();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('설정: 기본은 ChatGPT 계정 로그인 · API 키·Azure 비밀 값 · 켜기 조건', async () => {
  assert.deepEqual(await call('openai.config.get'), { enabled: false, authMode: 'chatgpt', hasApiKey: false });
  await assert.rejects(call('openai.config.set', { enabled: true, authMode: 'apikey' }), /OpenAI API 키를 넣어 주세요/);
  await assert.rejects(call('openai.config.set', { enabled: true, authMode: 'azure', azure: { endpoint: '', deployment: '' } }), /엔드포인트와 배포 이름/);
  await assert.rejects(call('openai.config.set', { enabled: false, authMode: 'azure', azure: { endpoint: 'http://x', deployment: 'd' } }), /https:\/\/리소스이름/);
  const c = await call('openai.config.set', { enabled: false, authMode: 'azure', apiKey: 'sk-test-key-1', azure: { endpoint: 'https://My-Res.openai.azure.com/openai/v1/', deployment: 'gpt-6-sol', key: 'azure-key-1' } });
  assert.deepEqual(c.azure, { endpoint: 'https://my-res.openai.azure.com', deployment: 'gpt-6-sol', hasKey: true });
  assert.equal(c.hasApiKey, true);
  const file = fs.readFileSync(path.join(tmp, 'data', 'openai.json'), 'utf8');
  assert.doesNotMatch(file, /sk-test-key-1|azure-key-1/);
  // 키를 비우면 지운다 (Azure 키)
  const c2 = await call('openai.config.set', { enabled: false, authMode: 'azure', azure: { endpoint: 'https://my-res.openai.azure.com', deployment: 'gpt-6-sol', key: '' } });
  assert.equal(c2.azure?.hasKey, false);
  await call('openai.config.set', { enabled: false, authMode: 'chatgpt' });
  await assert.rejects(call('claude.start', project, { provider: 'openai' }), /ChatGPT 연동이 꺼져 있습니다/);
});

test('설정: 저장이 실패하면 비밀 값도 그대로 · 숨은 Azure 칸은 저장을 막지 않음 · Azure를 비우면 Azure 키도 지움', async () => {
  const secrets = () => JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'secrets.json'), 'utf8'));
  await call('openai.config.set', { enabled: true, authMode: 'apikey', apiKey: 'sk-keep-key-1' });
  const k0 = secrets()['openai:apikey'];
  assert.ok(k0);
  await assert.rejects(call('openai.config.set', { enabled: true, authMode: 'apikey', apiKey: '' }), /OpenAI API 키를 넣어 주세요/);
  assert.equal(secrets()['openai:apikey'], k0, '켜 둔 채 지우려 하면 거절, 키는 그대로');
  await assert.rejects(call('openai.config.set', { enabled: true, authMode: 'apikey', apiKey: 'sk-new-key-2', proxy: 'proxy.local:8080' }), /프록시 주소/);
  assert.equal(secrets()['openai:apikey'], k0, '저장 실패면 새 키도 저장하지 않음');
  await assert.rejects(call('openai.config.set', { enabled: false, authMode: 'azure', azure: { endpoint: 'https://r.openai.azure.com', deployment: 'd', key: 'has space' } }), /Azure 키에 공백/);
  // ChatGPT 로그인 방식일 때 숨은 Azure 칸이 잘못돼도 저장 (그 칸은 예전 값, 저장한 Azure 키도 그대로)
  await call('openai.config.set', { enabled: false, authMode: 'azure', azure: { endpoint: 'https://res1.openai.azure.com', deployment: 'dep1', key: 'az-key-1' } });
  const c = await call('openai.config.set', { enabled: false, authMode: 'chatgpt', azure: { endpoint: 'myres.openai.azure.com', deployment: 'dep1' } });
  assert.deepEqual(c.azure, { endpoint: 'https://res1.openai.azure.com', deployment: 'dep1', hasKey: true });
  // Azure 엔드포인트·배포 이름을 비우면 저장한 Azure 키도 지운다 (보이지 않는 키를 남기지 않음)
  const c2 = await call('openai.config.set', { enabled: false, authMode: 'chatgpt', azure: { endpoint: '', deployment: '' } });
  assert.equal(c2.azure, undefined);
  assert.ok(!secrets()['openai:azure:key']);
  await call('openai.config.set', { enabled: false, authMode: 'chatgpt' });
});

test('연결 확인: Codex 버전·인증(계정 + 시험 요청), 로그인 안 됨', async () => {
  const st = await call('ai.status', 'openai', true);
  assert.equal(st.state, 'on', st.message);
  assert.equal(st.version, '0.163.0');
  assert.match(st.checks!.cli!.message!, /^0\.163\.0 · .*fake-codex\.mjs$/);
  assert.match(st.checks!.auth.message!, /^ChatGPT 계정 로그인 \(Codex\) · 시험 요청 \d+\.\d초$/);
  // 계정 이름은 상태 파일에 남기지 않는다
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'data', 'openai.json'), 'utf8'), /tester@example\.com/);
  const list = await call('ai.models', 'openai');
  assert.deepEqual(
    list.models.map((m) => m.value),
    ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.3-codex'],
  );
  assert.equal(list.defaultName, 'GPT-6.1-Sol');
  assert.deepEqual(list.account, { provider: 'chatgpt', email: 'tester@example.com', subscription: 'plus' });
  process.env.PA_FAKE_CODEX_AUTH = 'none';
  const bad = await call('ai.status', 'openai', true);
  assert.equal(bad.state, 'login');
  assert.equal(bad.code, 'auth');
  assert.match(bad.checks!.auth.message!, /ChatGPT 계정으로 로그인되어 있지 않습니다/);
  assert.match(bad.message!, /^ChatGPT 인증에 실패했습니다/);
});

test('대화: 동적 도구(검색·읽기)·스트리밍·Codex 자체 도구 끔·앱 지시', async () => {
  await ensureOn();
  scenario({
    turns: [
      {
        match: '원인',
        steps: [
          { say: '찾아보겠습니다.', calls: [{ name: 'grep', args: { pattern: 'insertOrderHist' } }] },
          { calls: [{ name: 'read_file', args: { path: OSI } }] },
          { say: `\`${OSI}:5\`에서 insertOrderHist를 직접 부릅니다.` },
        ],
      },
    ],
  });
  fs.rmSync(logFile, { force: true });
  const conv = await call('claude.start', project, { provider: 'openai', context: { title: '주문상세', chips: [{ kind: 'screen', label: '주문상세', text: '화면 /order/detail.do' }] } });
  assert.equal(conv.provider, 'openai');
  await call('claude.send', conv.id, '이력이 두 번 쌓이는 원인을 찾아 주세요');
  await idle(conv.id);
  const its = items(conv.id);
  assert.deepEqual(
    its.map((i) => i.type),
    ['user', 'assistant', 'activity', 'assistant'],
  );
  const act = its.find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.equal(act.summary, '작업 2건 파일 1개 읽음 · insertOrderHist 검색 1곳');
  assert.match(lastAssistant(conv.id)!, /insertOrderHist를 직접 부릅니다/);
  // 실행 인수: Codex 자체 도구·웹 검색·AGENTS.md 끔 (설정 파일은 고치지 않고 -c로만)
  const start = lastLog('start')!;
  for (const f of ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'goals', 'hooks', 'memories']) assert.ok(start.overrides.includes(`features.${f}=false`), f);
  assert.ok(start.overrides.includes('web_search="disabled"'));
  assert.ok(start.overrides.includes('project_doc_max_bytes=0'));
  assert.ok(!start.overrides.some((o: string) => /model_provider/.test(o)));
  assert.deepEqual(start.env.paVars, []);
  const th = lastLog('thread/start')!;
  assert.deepEqual(th.dynamicTools, ['list_dir', 'glob', 'grep', 'read_file', 'db_list', 'db_select', 'db_propose_change', 'edit_file', 'write_file', 'exit_plan_mode', 'run_command']);
  assert.equal(th.approvalPolicy, 'untrusted');
  assert.equal(th.sandbox, 'read-only');
  assert.equal(th.ephemeral, false);
  assert.match(th.baseInstructions, /^너는 사용자의 소스 코드 폴더/);
  assert.match(th.baseInstructions, /셸 명령은 쓸 수 없다/);
  const turn = lastLog('turn/start')!;
  assert.match(turn.text, /^\[맥락\] 주문상세\n## 화면: 주문상세\n화면 \/order\/detail\.do\n\[질문\]\n이력이 두 번/);
  const got = await call('claude.get', conv.id);
  assert.match(got!.sessionId!, /-fake-/);
  assert.equal(got!.activeModel, 'gpt-6.1-sol');
  // 도구 결과
  const tools = logs().filter((l) => l.kind === 'tool');
  assert.deepEqual(
    tools.map((t) => [t.name, t.ok]),
    [
      ['grep', true],
      ['read_file', true],
    ],
  );
  assert.match(tools[1].result, /^ {5}1\tpackage egov;/);
  // 이어서: 같은 스레드에 질문만 (맥락은 다시 붙이지 않음)
  await call('claude.send', conv.id, '고마워요');
  await idle(conv.id);
  assert.equal(lastLog('turn/start')!.text, '고마워요');
  assert.equal(logs().filter((l) => l.kind === 'thread/start').length, 1);
});

test('계획 모드 → [수정 진행] → 파일 수정 → 변경 카드 · 막기 규칙', async () => {
  await ensureOn();
  scenario({
    turns: [
      {
        match: '고쳐',
        steps: [
          { calls: [{ name: 'read_file', args: { path: 'src/main/resources/globals.properties' } }] },
          { calls: [{ name: 'edit_file', args: { path: OSI, old_string: '        insertOrderHist();\n', new_string: '' } }] },
          { calls: [{ name: 'run_command', args: { command: 'mvn -q compile' } }] },
          { say: '계획입니다.', calls: [{ name: 'exit_plan_mode', args: { plan: '## 수정 계획\n- 서비스의 insertOrderHist 호출 삭제' } }] },
          { calls: [{ name: 'edit_file', args: { path: OSI, old_string: '        insertOrderHist();\n', new_string: '' } }] },
          { say: '고쳤습니다.' },
        ],
      },
    ],
  });
  const conv = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', conv.id, '중복 저장을 고쳐 주세요');
  const st = await waitFor(() => lastState(conv.id)?.pending, 10000, 'plan pending');
  assert.equal(st.kind, 'plan');
  assert.match(st.detail, /^## 수정 계획/);
  await call('claude.respond', conv.id, st.requestId, true);
  await idle(conv.id);
  const tools = logs().filter((l) => l.kind === 'tool').slice(-5);
  assert.deepEqual(
    tools.map((t) => [t.name, t.ok]),
    [
      ['read_file', false],
      ['edit_file', false],
      ['run_command', false],
      ['exit_plan_mode', true],
      ['edit_file', true],
    ],
  );
  assert.equal(tools[0].result, '접속 정보 파일은 읽을 수 없습니다');
  assert.match(tools[1].result, /^계획 모드에서는 파일을 고칠 수 없습니다/);
  assert.match(tools[2].result, /^셸 명령은 허용되지 않았습니다/);
  const its = items(conv.id);
  const ch = its.find((i) => i.type === 'changes') as Extract<ChatItem, { type: 'changes' }>;
  assert.deepEqual(ch.paths, [OSI]);
  const mode = its.find((i) => i.type === 'mode') as Extract<ChatItem, { type: 'mode' }>;
  assert.deepEqual([mode.mode, mode.via], ['edit', 'plan']);
});

test('사용자 Codex 설정의 MCP 서버는 끈다 · 원본 없는 대화는 수정 도구가 없다', async () => {
  await ensureOn();
  process.env.PA_FAKE_CODEX_MCP = 'filesystem,github';
  const conv = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', conv.id, '안녕');
  await idle(conv.id);
  assert.deepEqual(lastLog('thread/start')!.config, { mcp_servers: { filesystem: { enabled: false }, github: { enabled: false } } });
  delete process.env.PA_FAKE_CODEX_MCP;
  const ro = await call('claude.start', null, { provider: 'openai' });
  await call('claude.send', ro.id, '안녕');
  await idle(ro.id);
  assert.deepEqual(lastLog('thread/start')!.dynamicTools, ['list_dir', 'glob', 'grep', 'read_file', 'db_list', 'db_select', 'db_propose_change']);
});

test('이어 하기: 앱을 다시 켜면 thread/resume · 스레드가 없으면 맥락을 붙여 새로', async () => {
  await ensureOn();
  const conv = await call('claude.start', project, { provider: 'openai', context: { title: '주문', chips: [{ kind: 'table', label: 'ORDER_HIST', text: '컬럼: ORDER_NO' }] } });
  await call('claude.send', conv.id, '첫 질문');
  await idle(conv.id);
  const sid = (await call('claude.get', conv.id))!.sessionId!;
  await claudeModule().manager._forget(conv.id);
  await call('claude.send', conv.id, '두 번째');
  await idle(conv.id);
  const rs = lastLog('thread/resume')!;
  assert.equal(rs.threadId, sid);
  assert.equal(rs.history, 2);
  assert.equal(lastLog('turn/start')!.text, '두 번째');
  // 스레드 기록이 없어짐 → 새 스레드에 맥락을 붙여
  fs.rmSync(path.join(tmp, 'codex-state', 'threads', `${sid}.json`));
  await claudeModule().manager._forget(conv.id);
  await call('claude.send', conv.id, '세 번째');
  await idle(conv.id);
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && i.text === '이전 ChatGPT 대화 기록을 찾지 못해 새로 이어서 진행합니다 (앞의 대화 내용은 ChatGPT가 기억하지 못합니다)'));
  assert.match(lastLog('turn/start')!.text, /^\[맥락\] 주문\n## 테이블: ORDER_HIST\n컬럼: ORDER_NO\n\[질문\]\n세 번째$/);
  assert.notEqual((await call('claude.get', conv.id))!.sessionId, sid);
});

test('오류: 인증 만료·사용 한도·결제, Codex가 갑자기 끝나면 다음 메시지에 다시 띄움', async () => {
  await ensureOn();
  const cases: [string, string, RegExp][] = [
    ['auth', 'auth', /^인증 실패: unexpected status 401/],
    ['limit', 'limit', /^사용 한도: You've hit your usage limit/],
    ['billing', 'billing', /^결제·권한 문제: Quota exceeded/],
  ];
  for (const [fail, code, re] of cases) {
    process.env.PA_FAKE_CODEX_FAIL = fail;
    const conv = await call('claude.start', project, { provider: 'openai' });
    await call('claude.send', conv.id, '시험');
    await idle(conv.id);
    const err = items(conv.id).find((i) => i.type === 'error') as Extract<ChatItem, { type: 'error' }>;
    assert.equal(err?.code, code, fail);
    assert.match(err.message, re);
  }
  assert.equal((await call('ai.status', 'openai')).state, 'login');
  delete process.env.PA_FAKE_CODEX_FAIL;
  scenario({ turns: [{ match: '끝남', steps: [{ crash: true }] }] });
  const conv = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', conv.id, '끝남 시험');
  await idle(conv.id);
  const err = items(conv.id).filter((i) => i.type === 'error').pop() as Extract<ChatItem, { type: 'error' }>;
  assert.match(err.message, /Codex가 응답 도중 끝났습니다/);
  await waitFor(() => claudeModule().manager._session(conv.id)?.hasQuery === false, 5000, 'query closed');
  await call('claude.send', conv.id, '다시');
  await idle(conv.id);
  assert.equal(lastAssistant(conv.id), 'OK');
  assert.equal((await call('ai.status', 'openai')).state, 'on');
});

test('[중지] · 모델 바꾸기는 다음 턴부터', async () => {
  await ensureOn();
  scenario({ turns: [{ match: '긴', steps: [{ say: '아주 긴 답변입니다. '.repeat(30), chunks: 60, delayMs: 40 }] }] });
  const conv = await call('claude.start', project, { provider: 'openai', model: 'gpt-6-astra' });
  await call('claude.send', conv.id, '긴 답변 주세요');
  await waitFor(() => items(conv.id).some((i) => i.type === 'assistant'), 10000, 'streaming');
  await call('claude.interrupt', conv.id);
  await idle(conv.id);
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && i.text === '응답을 중지했습니다'));
  assert.ok(!items(conv.id).some((i) => i.type === 'error'));
  assert.ok(lastLog('turn/interrupt'));
  assert.equal(lastLog('thread/start')!.model, 'gpt-6-astra');
  await call('claude.setModel', conv.id, 'gpt-5.3-codex');
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && /^모델을 (GPT-5\.3-Codex|gpt-5\.3-codex)\(으\)로 바꿨습니다$/.test(i.text)));
  await call('claude.send', conv.id, '짧게');
  await idle(conv.id);
  assert.equal(lastLog('turn/start')!.model, 'gpt-5.3-codex');
  await call('claude.send', conv.id, '또');
  await idle(conv.id);
  assert.equal(lastLog('turn/start')!.model, null);
});

test('API 키·Azure: 앱이 정한 공급자와 환경 변수 (PC의 Codex 로그인은 그대로)', async () => {
  await call('openai.config.set', { enabled: true, authMode: 'apikey', apiKey: 'sk-test-key-2' });
  const a = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', a.id, '안녕');
  await idle(a.id);
  let start = lastLog('start')!;
  assert.ok(start.overrides.includes('model_provider="pa_openai"'));
  assert.ok(start.overrides.includes('model_providers.pa_openai={name = "OpenAI API", base_url = "https://api.openai.com/v1", env_key = "PROJECT_ANALYZER_OPENAI_KEY", wire_api = "responses"}'));
  assert.equal(start.env.openaiKey, true);
  assert.ok(!JSON.stringify(start.overrides).includes('sk-test-key-2'));
  // Azure (키 없음 → PC의 Azure 로그인 토큰 명령)
  await call('openai.config.set', { enabled: true, authMode: 'azure', azure: { endpoint: 'https://my-res.openai.azure.com', deployment: 'gpt-6-sol' } });
  const z = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', z.id, '안녕');
  await idle(z.id);
  start = lastLog('start')!;
  assert.ok(start.overrides.includes('model_provider="pa_azure"'));
  const az = start.overrides.find((o: string) => o.startsWith('model_providers.pa_azure='))!;
  assert.match(az, /base_url = "https:\/\/my-res\.openai\.azure\.com\/openai\/v1"/);
  assert.match(az, /auth = \{command = "(cmd\.exe|az)", args = \[.*"account", "get-access-token", "--resource", "https:\/\/cognitiveservices\.azure\.com"/);
  assert.equal(lastLog('thread/start')!.model, 'gpt-6-sol');
  const models = await call('ai.models', 'openai', true);
  assert.deepEqual(models.models, [{ value: 'gpt-6-sol', name: 'gpt-6-sol', description: 'Azure OpenAI 배포' }]);
  await call('openai.config.set', { enabled: true, authMode: 'chatgpt' });
});

test('다른 AI로 새 대화: ChatGPT 대화를 이어 받아 Gemini 없이도 같은 AI로', async () => {
  await ensureOn();
  const from = await call('claude.start', project, { provider: 'openai' });
  await call('claude.send', from.id, '이전 질문');
  await idle(from.id);
  const to = await call('claude.start', project, { provider: 'openai', carryFrom: from.id });
  assert.equal(to.context!.chips[0].label, '이전 대화 (ChatGPT)');
  assert.equal(to.context!.chips[0].text, '[사용자] 이전 질문\n\n[ChatGPT] OK');
  await call('claude.send', to.id, '정리');
  await idle(to.id);
  assert.match(lastLog('turn/start')!.text, /^\[맥락\] .*\n## 이전 대화: 이전 대화 \(ChatGPT\)\n\[사용자\] 이전 질문\n\n\[ChatGPT\] OK\n\[질문\]\n정리$/);
});
