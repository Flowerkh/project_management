// Claude 연동 — 실제 Agent SDK(query)를 가짜 CLI(test/fake-claude/fake-claude.mjs)와 함께 돌려
// initialize·훅(hook_callback)·권한 요청(can_use_tool)·앱 안 MCP 서버(mcp_message)·set_permission_mode·interrupt가
// 실제 SDK 런타임에서 이어지는지 확인한다. 실제 Claude CLI·네트워크·계정은 쓰지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChatItem, DesktopEvent } from '../src/shared/desktop-api';
import { claudeModule, register } from '../src/desktop/claude/index';
import { setConfig } from '../src/desktop/claude/config';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { services } from '../src/desktop/services';
import { fakeDb, fakeWork } from './fake-claude/services';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-claude', 'fake-claude.mjs');
const FIXTURE = path.join(here, '..', 'fixtures', 'shop-admin');

let tmp: string;
let events: DesktopEvent[] = [];
let unsink: () => void;
const savedEnv = { ...process.env };

function items(id: string): ChatItem[] {
  const byId = new Map<string, ChatItem>();
  for (const e of events) if (e.type === 'claude.item' && e.conversationId === id) byId.set(e.item.id, e.item);
  return [...byId.values()];
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 20000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function lastState(id: string) {
  const s = events.filter((e) => e.type === 'claude.state' && e.conversationId === id);
  return s[s.length - 1] as Extract<DesktopEvent, { type: 'claude.state' }> | undefined;
}

function logLines(file: string): Record<string, any>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-c1-sdk-'));
  setHost(testHost(path.join(tmp, 'data')));
  // 이 환경의 실제 claude·인증은 쓰지 않는다: CLI는 가짜만
  process.env.PA_CLAUDE_CLI = FAKE;
  process.env.PA_CLAUDE_NO_DISCOVERY = '1';
  process.env.PA_FAKE_STATE_DIR = path.join(tmp, 'fake-state');
  process.env.PA_FAKE_DELAY = '1';
  delete process.env.PA_FAKE_AUTH;
  services.work = fakeWork(path.join(tmp, 'work'));
  services.db = fakeDb();
  register({ idleMs: 60000, interruptGraceMs: 3000 });
  unsink = addEventSink((e) => events.push(e));
  await setConfig({ enabled: true, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false });
});

after(async () => {
  await claudeModule().manager.closeAll();
  unsink();
  process.env = savedEnv;
  if (!process.env.PA_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

test('연결 확인: 가짜 CLI로 SDK 시험 요청 → on, 인증 실패 → login', { timeout: 60000 }, async () => {
  const st = await call('claude.status', true);
  assert.equal(st.state, 'on', JSON.stringify(st));
  assert.equal(st.version, '2.1.302');
  assert.equal(st.checks?.cli.ok, true);
  assert.equal(st.checks?.auth.ok, true);
  assert.ok(typeof st.authMs === 'number');
  assert.equal(st.authLabel, 'Claude Code 로그인');

  process.env.PA_FAKE_AUTH = 'fail';
  const bad = await call('claude.status', true);
  delete process.env.PA_FAKE_AUTH;
  assert.equal(bad.state, 'login');
  assert.equal(bad.code, 'auth');
  assert.match(bad.checks?.auth.message ?? '', /Not logged in/);
  // 저장한 결과는 앱을 다시 시작해도(캐시 없이 가볍게 확인) 남는다
  claudeModule().status.invalidate();
  const light = await call('claude.status');
  assert.equal(light.state, 'login');
  const good = await call('claude.status', true);
  assert.equal(good.state, 'on');
});

test('대화: 읽기·검색·접속 정보 거부·DB 조회 → 계획 승인([수정 진행]) → 작업 사본 수정 → 변경 카드 → 쿼리 카드', { timeout: 90000 }, async () => {
  const log = path.join(tmp, 'fake1.jsonl');
  process.env.PA_FAKE_LOG = log;
  process.env.PA_FAKE_SCENARIO = path.join(here, 'fake-claude', 'scenarios', 'shop-admin.json');
  const conv = await call('claude.start', FIXTURE, { context: { title: '주문상세', chips: [{ kind: 'screen', label: '주문상세', text: '주문 상세 화면 /order/detail.do' }, { kind: 'summary', label: '시스템 요약', text: '쇼핑몰 관리자 (전자정부 프레임워크)' }] } });
  assert.equal(conv.mode, 'plan');
  assert.ok(conv.workId);
  const work = await services.work!.get(conv.workId!);
  const target = path.join(work!.path, 'src/main/java/egovframework/shop/order/service/impl/OrderServiceImpl.java');
  const before = fs.readFileSync(target, 'utf8');

  await call('claude.send', conv.id, '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓여요. 원인을 찾아 주세요.');
  // ExitPlanMode → 계획 승인 요청
  const st = await waitFor(() => {
    const s = lastState(conv.id);
    return s?.pending?.kind === 'plan' ? s : undefined;
  }, 30000, 'plan pending');
  assert.match(st.pending!.detail, /수정 계획/);
  assert.equal(st.pending!.title, '수정 진행');
  // 아직 계획 모드: 파일은 그대로
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  await call('claude.respond', conv.id, st.pending!.requestId, true);
  await waitFor(() => !lastState(conv.id)?.running && items(conv.id).some((i) => i.type === 'changes'), 30000, 'turn end with changes');

  const its = items(conv.id);
  const kinds = its.map((i) => i.type);
  assert.deepEqual(kinds.filter((k) => k === 'user').length, 1);
  const act = its.find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.ok(act, 'activity');
  assert.match(act.summary, /^작업 \d+건 /);
  assert.match(act.summary, /파일 1개 읽음/);
  assert.match(act.summary, /insertOrderHist 검색 \d+곳/);
  assert.match(act.summary, /파일 1개 수정/);
  assert.ok(act.items.some((x) => x.kind === 'read' && x.file === 'src/main/java/egovframework/shop/order/service/impl/OrderServiceImpl.java'));
  // 접속 정보 파일은 훅이 막았다
  assert.ok(act.items.some((x) => x.kind === 'read' && /globals\.properties/.test(x.label) && /막힘/.test(x.label)), JSON.stringify(act.items));
  const edit = act.items.find((x) => x.kind === 'edit');
  assert.equal(edit?.line, 47);
  const sel = its.find((i) => i.type === 'select') as Extract<ChatItem, { type: 'select' }>;
  assert.equal(sel.env, 'dev');
  assert.equal(sel.db, 'shop_dev');
  assert.equal(sel.rows, 2);
  const mode = its.find((i) => i.type === 'mode') as Extract<ChatItem, { type: 'mode' }>;
  assert.equal(mode.mode, 'edit');
  assert.equal(mode.via, 'plan');
  const ch = its.find((i) => i.type === 'changes') as Extract<ChatItem, { type: 'changes' }>;
  assert.equal(ch.workId, conv.workId);
  assert.equal(ch.files, 1);
  assert.equal(ch.plus, 1);
  assert.deepEqual(ch.paths, ['src/main/java/egovframework/shop/order/service/impl/OrderServiceImpl.java']);
  const answers = its.filter((i) => i.type === 'assistant') as Extract<ChatItem, { type: 'assistant' }>[];
  assert.ok(answers.some((a) => /OrderServiceImpl\.java:47/.test(a.text)));
  assert.ok(answers.every((a) => !a.streaming));
  // 작업 사본은 고쳐졌고 원본은 그대로
  assert.match(fs.readFileSync(target, 'utf8'), /중복 저장 방지/);
  assert.doesNotMatch(fs.readFileSync(path.join(FIXTURE, 'src/main/java/egovframework/shop/order/service/impl/OrderServiceImpl.java'), 'utf8'), /중복 저장 방지/);

  // CLI에 넘긴 옵션 (가짜 CLI 기록)
  const L = logLines(log);
  const start = L.find((x) => x.ev === 'start')!;
  const argv: string[] = start.argv;
  assert.ok(argv.includes('--permission-mode=plan'), argv.join(' '));
  assert.ok(argv.includes('--setting-sources=user'));
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.ok(argv.includes('--include-partial-messages'));
  assert.ok(argv.includes('--permission-prompt-tool=stdio'));
  assert.ok(argv.some((a) => a.startsWith('--disallowedTools=') && a.includes('WebFetch') && a.includes('WebSearch') && !a.includes('Bash')));
  assert.ok(argv.includes('--allowedTools=Grep,Glob,mcp__projdb__db_list,mcp__projdb__db_select,mcp__projdb__db_propose_change'), argv.join(' '));
  assert.ok(argv[argv.indexOf('--settings') + 1]?.includes('Read(**/globals.properties)'), 'Read 거부 규칙');
  assert.equal(start.cwd, work!.path);
  assert.equal(start.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.deepEqual(start.env.PA_KEYS.filter((k: string) => !k.startsWith('PA_FAKE_')), []);
  const init = L.find((x) => x.ev === 'initialize')!;
  assert.deepEqual(init.sdkMcpServers, ['projdb']);
  assert.equal(init.hooks.PreToolUse.length, 1);
  assert.match(init.appendSystemPrompt, /한국어로 답한다/);
  assert.match(init.appendSystemPrompt, /db_propose_change/);
  assert.match(init.appendSystemPrompt, /쇼핑몰 관리자/);
  assert.match(init.appendSystemPrompt, /`mvn -q compile`/);
  const user = L.find((x) => x.ev === 'user')!;
  assert.match(user.text, /^\[맥락\] 주문상세/);
  assert.match(user.text, /## 화면: 주문상세/);
  assert.match(user.text, /\[질문\]\n주문 상태를 바꾸면/);
  assert.ok(!/시스템 요약/.test(user.text.split('[질문]')[0].replace('[맥락] 주문상세', '')), 'summary goes to system prompt');
  assert.ok(L.some((x) => x.ev === 'permission' && x.tool === 'ExitPlanMode' && x.behavior === 'allow' && x.updatedPermissions?.[0]?.mode === 'acceptEdits'));
  assert.ok(L.some((x) => x.ev === 'hook' && x.tool === 'Read' && x.decision === 'deny'));
  assert.ok(L.some((x) => x.ev === 'mcp-tools' && x.tools.includes('db_select') && x.tools.includes('db_propose_change')));
  assert.ok(L.some((x) => x.ev === 'mode' && x.mode === 'acceptEdits'), 'setPermissionMode(acceptEdits)');

  // 두 번째 턴: 쿼리 카드 (SELECT 외 쿼리는 실행하지 않음) + 카드 갱신
  await call('claude.send', conv.id, '쌓인 중복 이력도 지워 주세요');
  const q = await waitFor(() => items(conv.id).find((i) => i.type === 'query') as Extract<ChatItem, { type: 'query' }> | undefined, 30000, 'query card');
  assert.equal(q.card.kind, 'delete');
  assert.equal(q.card.status, 'pending');
  await waitFor(() => !lastState(conv.id)?.running, 20000, 'turn 2 end');
  const db = services.db as ReturnType<typeof fakeDb>;
  db.emitCard({ ...db.cards[0], status: 'done', result: { ok: true, affected: 1284, ms: 30 } });
  await waitFor(() => (items(conv.id).find((i) => i.id === q.id) as Extract<ChatItem, { type: 'query' }>).card.status === 'done', 5000, 'card update');
  const saved = await call('claude.get', conv.id);
  assert.equal(saved?.mode, 'edit');
  assert.equal((saved?.items.find((i) => i.id === q.id) as Extract<ChatItem, { type: 'query' }>).card.status, 'done');
  assert.ok(saved?.sessionId);
  delete process.env.PA_FAKE_LOG;
});

test('계획 거부 → 계획 모드 유지, 파일 그대로', { timeout: 60000 }, async () => {
  process.env.PA_FAKE_SCENARIO = path.join(here, 'fake-claude', 'scenarios', 'shop-admin.json');
  const conv = await call('claude.start', FIXTURE, {});
  const work = await services.work!.get(conv.workId!);
  const target = path.join(work!.path, 'src/main/java/egovframework/shop/order/service/impl/OrderServiceImpl.java');
  const before = fs.readFileSync(target, 'utf8');
  await call('claude.send', conv.id, '원인을 찾아 주세요');
  const st = await waitFor(() => (lastState(conv.id)?.pending?.kind === 'plan' ? lastState(conv.id) : undefined), 30000, 'plan pending');
  await call('claude.respond', conv.id, st!.pending!.requestId, false);
  await waitFor(() => !lastState(conv.id)?.running, 20000, 'turn end');
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  const its = items(conv.id);
  assert.ok(!its.some((i) => i.type === 'mode'));
  assert.ok(!its.some((i) => i.type === 'changes'));
  assert.ok(its.some((i) => i.type === 'assistant' && /계획 모드를 유지/.test(i.text)));
  assert.equal(lastState(conv.id)?.mode, 'plan');
});

test('셸 명령: 허용 목록 → 사용자 확인(MSG-24) 허용/거부, 목록 밖은 훅이 거부 / 운영 조회 확인(MSG-42)', { timeout: 60000 }, async () => {
  const log = path.join(tmp, 'fake-shell.jsonl');
  process.env.PA_FAKE_LOG = log;
  process.env.PA_FAKE_SCENARIO = JSON.stringify({
    turns: [
      {
        steps: [
          { tool: 'Bash', input: { command: 'mvn -q compile' }, result: { stdout: 'BUILD SUCCESS', exitCode: 0 } },
          { tool: 'Bash', input: { command: 'mvn -q compile && type C:\\secret.txt' } },
          { tool: 'Bash', input: { command: 'rm -rf /' } },
          { mcp: 'db_select', input: { sql: 'SELECT ORDER_NO, CUST_NM FROM TB_ORDER WHERE ROWNUM < 5', env: 'prod' } },
          { say: '끝' },
        ],
      },
    ],
  });
  const conv = await call('claude.start', FIXTURE, {});
  await call('claude.send', conv.id, '컴파일해 보고 운영 데이터도 봐 주세요');
  const p1 = await waitFor(() => (lastState(conv.id)?.pending?.kind === 'command' ? lastState(conv.id)!.pending : undefined), 30000, 'command pending');
  assert.equal(p1!.detail, 'mvn -q compile');
  await call('claude.respond', conv.id, p1!.requestId, true);
  const p2 = await waitFor(() => (lastState(conv.id)?.pending?.kind === 'prod-select' ? lastState(conv.id)!.pending : undefined), 30000, 'prod-select pending');
  assert.equal(p2!.db, 'shop_prd');
  assert.equal(p2!.env, 'prod');
  assert.equal(p2!.maxRows, 100);
  assert.match(p2!.detail, /Claude가 운영 DB shop_prd를 조회하려고 합니다\(최대 100행, 개인정보 가림\)/);
  assert.match(p2!.sql!, /CUST_NM/);
  await call('claude.respond', conv.id, p2!.requestId, false);
  await waitFor(() => !lastState(conv.id)?.running, 20000, 'turn end');
  const act = items(conv.id).find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  const cmds = act.items.filter((x) => x.kind === 'command');
  assert.equal(cmds.length, 3);
  assert.match(cmds[0].label, /mvn -q compile 성공/);
  assert.match(cmds[1].label, /막힘/);
  assert.match(cmds[2].label, /막힘/);
  assert.ok(!items(conv.id).some((i) => i.type === 'select'), '거부한 운영 조회는 결과 없음');
  const L = logLines(log);
  const hookDecisions = L.filter((x) => x.ev === 'hook' && x.tool === 'Bash').map((x) => x.decision);
  assert.deepEqual(hookDecisions, ['ask', 'deny', 'deny']);
  assert.ok(L.some((x) => x.ev === 'permission' && x.tool === 'Bash' && x.behavior === 'allow'));
  delete process.env.PA_FAKE_LOG;
});

test('셸 허용 목록이 비면 Bash를 아예 빼고, [중지]하면 기다리던 요청은 거부', { timeout: 60000 }, async () => {
  await setConfig({ enabled: true, authMode: 'login', shellAllow: [], aiSummary: false });
  const log = path.join(tmp, 'fake-int.jsonl');
  process.env.PA_FAKE_LOG = log;
  process.env.PA_FAKE_SCENARIO = JSON.stringify({ turns: [{ steps: [{ tool: 'Bash', input: { command: 'mvn -q compile' } }, { say: '오래 걸리는 작업을 합니다' }, { sleep: 20000 }, { say: '끝' }] }] });
  const conv = await call('claude.start', FIXTURE, {});
  await call('claude.send', conv.id, '시험');
  await waitFor(() => items(conv.id).some((i) => i.type === 'assistant' && /오래 걸리는/.test(i.text)), 30000, 'streaming answer');
  await call('claude.interrupt', conv.id);
  await waitFor(() => !lastState(conv.id)?.running, 10000, 'interrupted');
  const its = items(conv.id);
  assert.ok(its.some((i) => i.type === 'notice' && /중지/.test(i.text)));
  assert.ok(!its.some((i) => i.type === 'error'), JSON.stringify(its.filter((i) => i.type === 'error')));
  const act = its.find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.match(act.items[0].label, /실패|막힘/);
  const L = logLines(log);
  const argv: string[] = L.find((x) => x.ev === 'start')!.argv;
  assert.ok(argv.some((a) => a.startsWith('--disallowedTools=') && a.includes('Bash')));
  assert.ok(L.some((x) => x.ev === 'control' && x.subtype === 'interrupt'));
  await setConfig({ enabled: true, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false });
  delete process.env.PA_FAKE_LOG;
});

test('쉬었다가(프로세스를 닫음) 다시 보내면 resume으로 이어 감 / 모르는 세션이면 새로 시작', { timeout: 60000 }, async () => {
  const log = path.join(tmp, 'fake-resume.jsonl');
  process.env.PA_FAKE_LOG = log;
  process.env.PA_FAKE_SCENARIO = JSON.stringify({ turns: [{ steps: [{ say: '첫 답' }] }, { steps: [{ say: '둘째 답' }] }] });
  const conv = await call('claude.start', FIXTURE, {});
  await call('claude.send', conv.id, '하나');
  await waitFor(() => !lastState(conv.id)?.running && items(conv.id).some((i) => i.type === 'assistant'), 20000, 'turn 1');
  const sid = (await call('claude.get', conv.id))!.sessionId!;
  assert.ok(sid);
  // 앱을 다시 시작한 것처럼 메모리에서 지운다
  claudeModule().manager._forget(conv.id);
  await call('claude.send', conv.id, '둘');
  await waitFor(() => items(conv.id).some((i) => i.type === 'assistant' && i.text === '둘째 답') && !lastState(conv.id)?.running, 20000, 'turn 2');
  const starts = logLines(log).filter((x) => x.ev === 'start');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].argv.includes(`--resume=${sid}`), starts[1].argv.join(' '));

  // 세션 기록이 없어진 경우 (실제 CLI: "No conversation found with session ID")
  claudeModule().manager._forget(conv.id);
  fs.rmSync(process.env.PA_FAKE_STATE_DIR!, { recursive: true, force: true });
  process.env.PA_FAKE_STRICT_RESUME = '1';
  process.env.PA_FAKE_SCENARIO = JSON.stringify({ default: [{ say: '새 세션 답' }] });
  await call('claude.send', conv.id, '셋');
  await waitFor(() => items(conv.id).some((i) => i.type === 'assistant' && i.text === '새 세션 답') && !lastState(conv.id)?.running, 20000, 'fallback');
  assert.ok(items(conv.id).some((i) => i.type === 'notice' && /이전 Claude 대화 기록을 찾지 못해/.test(i.text)));
  assert.ok(!items(conv.id).some((i) => i.type === 'error'));
  const after = (await call('claude.get', conv.id))!.sessionId;
  assert.ok(after && after !== sid);
  delete process.env.PA_FAKE_STRICT_RESUME;
  delete process.env.PA_FAKE_LOG;
});

test('API 오류 분류: 인증·한도·결제·오프라인 → error 항목과 연결 상태', { timeout: 60000 }, async () => {
  for (const [kind, code, state] of [
    ['limit', 'limit', 'on'],
    ['billing', 'billing', 'login'],
    ['offline', 'offline', 'offline'],
    ['auth', 'auth', 'login'],
  ] as const) {
    process.env.PA_FAKE_SCENARIO = JSON.stringify({ default: [{ error: kind }] });
    const conv = await call('claude.start', FIXTURE, {});
    const n0 = events.filter((e) => e.type === 'claude.status').length;
    await call('claude.send', conv.id, '질문');
    const err = await waitFor(() => items(conv.id).find((i) => i.type === 'error') as Extract<ChatItem, { type: 'error' }> | undefined, 20000, `error ${kind}`);
    assert.equal(err.code, code, `${kind}: ${err.message}`);
    await waitFor(() => !lastState(conv.id)?.running, 10000, 'turn end');
    if (state !== 'on') {
      const st = await waitFor(() => events.slice(n0).filter((e) => e.type === 'claude.status').pop() as Extract<DesktopEvent, { type: 'claude.status' }> | undefined, 5000, 'status event');
      assert.equal(st.status.state, state, kind);
    }
  }
  // 다시 성공하면 on
  process.env.PA_FAKE_SCENARIO = JSON.stringify({ default: [{ say: '됩니다' }] });
  const conv = await call('claude.start', FIXTURE, {});
  await call('claude.send', conv.id, '질문');
  await waitFor(() => !lastState(conv.id)?.running && items(conv.id).some((i) => i.type === 'assistant'), 20000, 'ok');
  await waitFor(() => events.filter((e) => e.type === 'claude.status').pop()?.type === 'claude.status' && (events.filter((e) => e.type === 'claude.status').pop() as Extract<DesktopEvent, { type: 'claude.status' }>).status.state === 'on', 5000, 'status on');
});
