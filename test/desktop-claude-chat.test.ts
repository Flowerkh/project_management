// Claude 대화 관리 (manager.ts) — 가짜 query()가 실제 CLI와 같은 모양의 SDK 메시지를 흘려보낸다.
// 항목 변환·계획→수정·셸 명령 확인·운영 조회 확인·쿼리 카드·변경 카드·오류 구분·저장/이어 하기·내보내기·옵션
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChatItem, DesktopEvent } from '../src/shared/desktop-api';
import { setConfig } from '../src/desktop/claude/config';
import { claudeModule, register } from '../src/desktop/claude/index';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { services } from '../src/desktop/services';
import { assistant, fakeQuery, init, result, SESSION, stream, textMessage, toolResult, toolUse, type TurnApi } from './fake-claude/fake-query';
import { fakeDb, fakeWork } from './fake-claude/services';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-claude', 'fake-claude.mjs');
const savedEnv = { ...process.env };
let tmp: string;
let project: string;
let events: DesktopEvent[] = [];
let unsink: () => void;
let handler: (t: TurnApi) => Promise<void> | void = () => undefined;
const fq = fakeQuery((t) => handler(t));

const OSI = 'src/main/java/egov/shop/order/service/impl/OrderServiceImpl.java';

function items(id: string): ChatItem[] {
  const m = new Map<string, ChatItem>();
  for (const e of events) if (e.type === 'claude.item' && e.conversationId === id) m.set(e.item.id, e.item);
  return [...m.values()];
}
function itemEvents(id: string, itemId: string): ChatItem[] {
  return events.filter((e) => e.type === 'claude.item' && e.conversationId === id && e.item.id === itemId).map((e) => (e as Extract<DesktopEvent, { type: 'claude.item' }>).item);
}
function lastState(id: string) {
  return events.filter((e) => e.type === 'claude.state' && e.conversationId === id).pop() as Extract<DesktopEvent, { type: 'claude.state' }> | undefined;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const idle = (id: string) => waitFor(() => lastState(id) && !lastState(id)!.running && !claudeModule().manager._session(id)?.running, 5000, 'turn end');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-c1-chat-'));
  project = path.join(tmp, 'shop-admin');
  fs.mkdirSync(path.join(project, path.dirname(OSI)), { recursive: true });
  fs.writeFileSync(path.join(project, OSI), 'package egov;\n\npublic class OrderServiceImpl {\n    void updateStat() {\n        insertOrderHist();\n    }\n}\n');
  fs.mkdirSync(path.join(project, 'src/main/resources'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/main/resources/globals.properties'), 'Globals.Password=****\n');
  setHost(testHost(path.join(tmp, 'data'), { save: path.join(tmp, 'export.md') }));
  process.env.PA_CLAUDE_CLI = FAKE;
  process.env.PA_CLAUDE_NO_DISCOVERY = '1';
  services.work = fakeWork(path.join(tmp, 'work'));
  services.db = fakeDb();
  register({ queryFn: fq.queryFn, idleMs: 60000, interruptGraceMs: 500 });
  unsink = addEventSink((e) => events.push(e));
  await setConfig({ enabled: true, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false });
});

beforeEach(() => {
  handler = () => undefined;
});

after(async () => {
  await claudeModule().manager.closeAll();
  unsink();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('스트리밍 답변·작업 내역 묶음·제목·저장', async () => {
  handler = async (t) => {
    const cwd = t.options.cwd!;
    t.emit(init());
    for (const m of textMessage('msg_1', '먼저 코드를 확인하겠습니다.')) t.emit(m);
    t.emit(assistant('msg_2', [toolUse('tu_read', 'Read', { file_path: path.join(cwd, OSI), offset: 4 })]));
    t.emit(assistant('msg_2', [toolUse('tu_grep', 'Grep', { pattern: 'insertOrderHist', path: cwd })]));
    t.emit(toolResult('tu_read', '     4\t    void updateStat() {', { structured: { type: 'text', file: { filePath: path.join(cwd, OSI), numLines: 3 } } }));
    t.emit(toolResult('tu_grep', 'Found 3 files', { structured: { mode: 'files_with_matches', numFiles: 3, filenames: [] } }));
    // 하위 작업(서브에이전트)의 글은 보이지 않고 도구만 작업 내역에
    t.emit(assistant('msg_sub', [{ type: 'text', text: '하위 작업 글' }, toolUse('tu_sub', 'Glob', { pattern: '**/*.xml' })], { parent_tool_use_id: 'tu_agent' }));
    for (const m of textMessage('msg_3', `원인은 \`${OSI}:5\`의 insertOrderHist 중복 호출입니다.`)) t.emit(m);
    t.emit(result({ result: '원인은…' }));
  };
  const conv = await call('claude.start', project, { context: { title: '주문상세', chips: [{ kind: 'screen', label: '주문상세', text: '화면 설명' }] } });
  assert.equal(conv.title, '새 대화');
  await call('claude.send', conv.id, '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓이는 문제가 있어요. 원인을 찾아 주세요.');
  await idle(conv.id);
  const its = items(conv.id);
  assert.deepEqual(its.map((i) => i.type), ['user', 'assistant', 'activity', 'assistant']);
  const [u, a1, act, a2] = its as [Extract<ChatItem, { type: 'user' }>, Extract<ChatItem, { type: 'assistant' }>, Extract<ChatItem, { type: 'activity' }>, Extract<ChatItem, { type: 'assistant' }>];
  assert.equal(u.text, '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓이는 문제가 있어요. 원인을 찾아 주세요.');
  assert.equal(a1.text, '먼저 코드를 확인하겠습니다.');
  assert.equal(a1.streaming, undefined);
  // 스트리밍 중에는 같은 id로 streaming:true가 먼저 왔다
  const a1Events = itemEvents(conv.id, a1.id) as Extract<ChatItem, { type: 'assistant' }>[];
  assert.ok(a1Events.length >= 2);
  assert.equal(a1Events[0].streaming, true);
  assert.ok(a1Events[0].text.length < a1.text.length);
  assert.match(a2.text, /OrderServiceImpl\.java:5/);
  assert.equal(act.summary, '작업 3건 파일 1개 읽음 · 검색 2번');
  assert.deepEqual(act.items[0], { kind: 'read', label: `${OSI}:4 읽음`, file: OSI, line: 4 });
  assert.equal(act.items[1].label, "'insertOrderHist' 검색 3곳");
  assert.match(act.items[2].label, /\*\*\/\*\.xml 파일 찾기/);
  // 첫 메시지에 [맥락]이 붙어 CLI로 갔다
  assert.match(fq.calls.turns.at(-1)!, /^\[맥락\] 주문상세\n## 화면: 주문상세\n화면 설명\n\[질문\]\n주문 상태를/);
  // 제목: 첫 질문 30자
  const got = await call('claude.get', conv.id);
  assert.equal(got!.title, '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓이는 문제…');
  assert.equal([...got!.title].length, 30);
  assert.equal(got!.sessionId, SESSION);
  assert.equal(got!.running, false);
  // 파일에 저장됨 → 목록
  const list = await call('claude.list', project);
  assert.equal(list[0].id, conv.id);
  assert.equal(list[0].items, 4);
  // 두 번째 메시지에는 맥락을 다시 붙이지 않는다
  handler = (t) => {
    t.emit(init());
    t.emit(assistant('m9', [{ type: 'text', text: '네' }]));
    t.emit(result());
  };
  await call('claude.send', conv.id, '고마워요');
  await idle(conv.id);
  assert.equal(fq.calls.turns.at(-1), '고마워요');
});

test('SDK 옵션: CLI 경로·작업 사본·계획 모드·사용자 설정만·도구 제한·앱 규칙·환경 변수', async () => {
  handler = (t) => {
    t.emit(init());
    t.emit(result());
  };
  process.env.PA_SOMETHING = 'x';
  const conv = await call('claude.start', project, { context: { title: 't', chips: [{ kind: 'summary', label: '시스템 요약', text: '전자정부 쇼핑몰 관리자' }] } });
  await call('claude.send', conv.id, '질문');
  await idle(conv.id);
  const o = fq.calls.options.at(-1)!;
  assert.equal(o.pathToClaudeCodeExecutable, FAKE);
  assert.equal(o.executable, 'node');
  const w = await services.work!.get(conv.workId!);
  assert.equal(o.cwd, w!.path);
  assert.equal(o.permissionMode, 'plan');
  assert.deepEqual(o.settingSources, ['user']);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.includePartialMessages, true);
  assert.ok(o.disallowedTools!.includes('WebFetch') && o.disallowedTools!.includes('WebSearch'));
  assert.ok(!o.disallowedTools!.includes('Bash'), '허용 목록이 있으면 Bash는 남김');
  assert.deepEqual(o.allowedTools, ['Grep', 'Glob', 'mcp__projdb__db_list', 'mcp__projdb__db_select', 'mcp__projdb__db_propose_change']);
  assert.ok(o.mcpServers?.projdb);
  assert.equal(o.resume, undefined);
  const sp = o.systemPrompt as { type: string; preset: string; append: string };
  assert.equal(sp.type, 'preset');
  assert.equal(sp.preset, 'claude_code');
  assert.match(sp.append, /한국어로 답한다/);
  assert.match(sp.append, /작업 사본/);
  assert.match(sp.append, /db_select/);
  assert.match(sp.append, /db_propose_change/);
  assert.match(sp.append, /묻지 않는다/);
  assert.match(sp.append, /# 시스템 요약 \(shop-admin\)\n전자정부 쇼핑몰 관리자/);
  assert.equal(o.env!.PA_SOMETHING, undefined);
  assert.equal(o.env!.PA_CLAUDE_CLI, undefined);
  assert.match(o.env!.CLAUDE_AGENT_SDK_CLIENT_APP!, /^project-analyzer\//);
  assert.ok(((o.settings as { permissions: { deny: string[] } }).permissions.deny).includes('Read(**/.env)'));
  delete process.env.PA_SOMETHING;
  // 허용 목록이 비면 셸 도구를 뺀다, API 키 방식이면 키를 환경 변수로
  await setConfig({ enabled: true, authMode: 'apikey', apiKey: 'sk-ant-test-123', shellAllow: [], aiSummary: false });
  const c2 = await call('claude.start', project, {});
  await call('claude.send', c2.id, '질문');
  await idle(c2.id);
  const o2 = fq.calls.options.at(-1)!;
  assert.ok(o2.disallowedTools!.includes('Bash') && o2.disallowedTools!.includes('PowerShell'));
  assert.equal(o2.env!.ANTHROPIC_API_KEY, 'sk-ant-test-123');
  assert.doesNotMatch((o2.systemPrompt as { append: string }).append, /`mvn/);
  await setConfig({ enabled: true, authMode: 'login', apiKey: '', shellAllow: ['mvn -q compile'], aiSummary: false });
});

test('계획 모드: 수정은 훅이 거부 → ExitPlanMode 승인([수정 진행]) → 수정 허용·작업 사본 수정 → 변경 카드', async () => {
  let hookPlan: Record<string, any> = {};
  let perm: Record<string, any> = {};
  let hookEdit: Record<string, any> = {};
  handler = async (t) => {
    const cwd = t.options.cwd!;
    const file = path.join(cwd, OSI);
    t.emit(init());
    t.emit(assistant('m1', [toolUse('tu_e0', 'Edit', { file_path: file, old_string: 'a', new_string: 'b' })]));
    hookPlan = await t.hook('Edit', { file_path: file, old_string: 'a', new_string: 'b' });
    t.emit(toolResult('tu_e0', hookPlan.hookSpecificOutput?.permissionDecisionReason ?? '', { isError: true }));
    t.emit(assistant('m2', [toolUse('tu_plan', 'ExitPlanMode', {})]));
    perm = await t.canUseTool('ExitPlanMode', { plan: '## 계획\n1. 중복 저장 제거' });
    t.emit(toolResult('tu_plan', 'User has approved your plan.'));
    t.emit(assistant('m3', [toolUse('tu_e1', 'Edit', { file_path: file, old_string: '        insertOrderHist();\n', new_string: '' })]));
    hookEdit = await t.hook('Edit', { file_path: file });
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('        insertOrderHist();\n', ''));
    t.emit(toolResult('tu_e1', 'The file has been updated.', { structured: { filePath: file, structuredPatch: [{ oldStart: 4, oldLines: 3, newStart: 4, newLines: 2, lines: [] }] } }));
    t.emit(assistant('m4', [{ type: 'text', text: '고쳤습니다.' }]));
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  const sent = call('claude.send', conv.id, '고쳐 주세요');
  await sent;
  const pending = await waitFor(() => (lastState(conv.id)?.pending?.kind === 'plan' ? lastState(conv.id)!.pending : undefined), 5000, 'plan pending');
  assert.equal(pending!.title, '수정 진행');
  assert.equal(pending!.detail, '## 계획\n1. 중복 저장 제거');
  const conv1 = await call('claude.get', conv.id);
  assert.equal(conv1!.pending?.requestId, pending!.requestId);
  assert.equal(conv1!.running, true);
  await call('claude.respond', conv.id, pending!.requestId, true);
  await idle(conv.id);
  assert.equal(hookPlan.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookPlan.hookSpecificOutput.permissionDecisionReason, /계획 모드에서는 파일을 고칠 수 없습니다/);
  assert.equal(perm.behavior, 'allow');
  assert.deepEqual(perm.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.deepEqual(hookEdit, { continue: true });
  await waitFor(() => fq.calls.setMode.includes('acceptEdits'), 2000, 'setPermissionMode');
  const its = items(conv.id);
  const mode = its.find((i) => i.type === 'mode') as Extract<ChatItem, { type: 'mode' }>;
  assert.equal(mode.mode, 'edit');
  assert.equal(mode.via, 'plan');
  const ch = its.find((i) => i.type === 'changes') as Extract<ChatItem, { type: 'changes' }>;
  assert.deepEqual({ files: ch.files, plus: ch.plus, minus: ch.minus, paths: ch.paths, workId: ch.workId }, { files: 1, plus: 0, minus: 1, paths: [OSI], workId: conv.workId });
  assert.deepEqual(ch.stats, [{ path: OSI, plus: 0, minus: 1 }]);
  const act = its.find((i) => i.type === 'activity') as Extract<ChatItem, { type: 'activity' }>;
  assert.equal(act.summary, '작업 2건 파일 1개 수정 · 막힘 1건');
  assert.equal(act.items[1].line, 4);
  assert.equal(lastState(conv.id)!.mode, 'edit');
  // 다음에 열 때는 수정 허용 모드로
  await claudeModule().manager._forget(conv.id);
  handler = (t) => {
    t.emit(init());
    t.emit(result());
  };
  await call('claude.send', conv.id, '하나 더');
  await idle(conv.id);
  assert.equal(fq.calls.options.at(-1)!.permissionMode, 'acceptEdits');
  assert.equal(fq.calls.options.at(-1)!.resume, SESSION);
  // 계획으로 되돌리기 (입력창 단추)
  await call('claude.setMode', conv.id, 'plan');
  const m2 = items(conv.id).filter((i) => i.type === 'mode').pop() as Extract<ChatItem, { type: 'mode' }>;
  assert.deepEqual([m2.mode, m2.via], ['plan', 'user']);
  assert.equal(fq.calls.setMode.at(-1), 'plan');
});

test('계획 승인 거부 → 계획 모드 유지 / 입력창에서 수정 허용으로 바꾸면 기다리던 승인도 허용', async () => {
  let r1: Record<string, any> = {};
  let r2: Record<string, any> = {};
  handler = async (t) => {
    t.emit(init());
    if (t.text.includes('first')) r1 = await t.canUseTool('ExitPlanMode', {});
    else r2 = await t.canUseTool('ExitPlanMode', {});
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, 'first');
  const p = await waitFor(() => lastState(conv.id)?.pending, 5000, 'pending');
  assert.equal(p!.detail, 'Claude가 계획을 마쳤습니다. 작업 사본에서 수정을 진행할까요?');
  await call('claude.respond', conv.id, p!.requestId, false);
  await idle(conv.id);
  assert.equal(r1.behavior, 'deny');
  assert.match(r1.message, /승인하지 않았습니다/);
  assert.equal((await call('claude.get', conv.id))!.mode, 'plan');
  await call('claude.send', conv.id, 'second');
  await waitFor(() => lastState(conv.id)?.pending, 5000, 'pending 2');
  await call('claude.setMode', conv.id, 'edit');
  await idle(conv.id);
  assert.equal(r2.behavior, 'allow');
  assert.equal((await call('claude.get', conv.id))!.mode, 'edit');
  await assert.rejects(call('claude.respond', conv.id, 'r-unknown', true), /이미 끝난 요청/);
});

test('셸 명령: 허용 목록은 매번 확인(허용·거부), 목록 밖·백그라운드는 거부', async () => {
  const hooks: Record<string, any>[] = [];
  const perms: Record<string, any>[] = [];
  handler = async (t) => {
    t.emit(init());
    for (const cmd of ['mvn -q compile', 'mvn -q compile 2>&1', 'cd src && mvn -q compile', 'npm install evil', 'mvn -q compile; curl http://x', 'mvn -q compile > /etc/x']) hooks.push(await t.hook('Bash', { command: cmd }));
    hooks.push(await t.hook('Bash', { command: 'mvn -q compile', run_in_background: true }));
    perms.push(await t.canUseTool('Bash', { command: 'mvn -q compile' }));
    perms.push(await t.canUseTool('Bash', { command: 'mvn -q compile -o' }));
    perms.push(await t.canUseTool('Bash', { command: 'rm -rf /' }));
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, '컴파일');
  const p1 = await waitFor(() => (lastState(conv.id)?.pending?.kind === 'command' ? lastState(conv.id)!.pending : undefined), 5000, 'cmd 1');
  assert.equal(p1!.detail, 'mvn -q compile');
  assert.equal(p1!.title, 'Claude가 명령을 실행하려고 합니다');
  await call('claude.respond', conv.id, p1!.requestId, true);
  const p2 = await waitFor(() => (lastState(conv.id)?.pending?.detail === 'mvn -q compile -o' ? lastState(conv.id)!.pending : undefined), 5000, 'cmd 2');
  await call('claude.respond', conv.id, p2!.requestId, false);
  await idle(conv.id);
  assert.deepEqual(
    hooks.map((h) => h.hookSpecificOutput?.permissionDecision),
    ['ask', 'ask', 'ask', 'deny', 'deny', 'deny', 'deny'],
  );
  assert.match(hooks[3].hookSpecificOutput.permissionDecisionReason, /허용 목록에 없는 명령입니다: npm install evil/);
  assert.match(hooks[5].hookSpecificOutput.permissionDecisionReason, /작업 폴더 밖으로 출력/);
  assert.match(hooks[6].hookSpecificOutput.permissionDecisionReason, /백그라운드/);
  assert.deepEqual(perms.map((p) => p.behavior), ['allow', 'deny', 'deny']);
  assert.match(perms[1].message, /거부했습니다/);
});

test('접속 정보 파일·작업 폴더 밖·원본 폴더는 읽지 않음', async () => {
  const out: Record<string, any>[] = [];
  handler = async (t) => {
    const cwd = t.options.cwd!;
    t.emit(init());
    out.push(await t.hook('Read', { file_path: path.join(cwd, 'src/main/resources/globals.properties') }));
    out.push(await t.hook('Read', { file_path: path.join(project, OSI) }));
    out.push(await t.hook('Grep', { pattern: 'x', path: project }));
    out.push(await t.hook('Grep', { pattern: 'password', glob: '.env' }));
    out.push(await t.hook('Read', { file_path: path.join(cwd, OSI) }));
    out.push(await t.hook('Glob', { pattern: '**/*.properties' }));
    out.push(await t.hook('WebFetch', { url: 'https://example.com' }));
    out.push(await t.hook('mcp__other__x', {}));
    out.push(await t.hook('mcp__projdb__db_select', { sql: 'select 1' }));
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, '읽기');
  await idle(conv.id);
  const d = out.map((h) => h.hookSpecificOutput?.permissionDecision ?? 'none');
  assert.deepEqual(d, ['deny', 'deny', 'deny', 'deny', 'none', 'none', 'deny', 'deny', 'none']);
  assert.equal(out[0].hookSpecificOutput.permissionDecisionReason, '접속 정보 파일은 읽을 수 없습니다');
  assert.match(out[1].hookSpecificOutput.permissionDecisionReason, /작업 폴더 밖/);
});

test('DB 도구: 개발 조회 → select 항목, 운영 조회는 확인(MSG-42) 허용·거부, 변경 쿼리 → 쿼리 카드와 갱신', async () => {
  const texts: string[] = [];
  handler = async (t) => {
    t.emit(init());
    const db = t.db();
    texts.push((await db.db_list({})).content[0].text);
    texts.push((await db.db_select({ sql: 'SELECT ORDER_NO, COUNT(*) CNT FROM TB_ORDER_HIST GROUP BY ORDER_NO' })).content[0].text);
    texts.push((await db.db_select({ sql: 'SELECT ORDER_NO, CUST_NM FROM TB_ORDER', env: 'prod' })).content[0].text);
    texts.push((await db.db_select({ sql: 'SELECT 1 FROM DUAL', env: 'prod' })).content[0].text);
    texts.push((await db.db_select({ sql: 'DELETE FROM TB_ORDER' })).content[0].text);
    texts.push((await db.db_propose_change({ sql: 'DELETE FROM TB_ORDER_HIST WHERE 1=1', description: '중복 이력 정리', revert_sql: 'INSERT …' })).content[0].text);
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, 'DB 봐 주세요');
  const p1 = await waitFor(() => (lastState(conv.id)?.pending?.kind === 'prod-select' ? lastState(conv.id)!.pending : undefined), 5000, 'prod 1');
  assert.deepEqual({ title: p1!.title, db: p1!.db, env: p1!.env, maxRows: p1!.maxRows, mask: p1!.mask }, { title: '운영 DB 조회', db: 'shop_prd', env: 'prod', maxRows: 100, mask: true });
  assert.equal(p1!.detail, 'Claude가 운영 DB shop_prd를 조회하려고 합니다(최대 100행, 개인정보 가림). 운영 조회는 항상 확인합니다. 실행할까요?');
  assert.equal(p1!.sql, 'SELECT ORDER_NO, CUST_NM FROM TB_ORDER');
  await call('claude.respond', conv.id, p1!.requestId, true);
  const p2 = await waitFor(() => (lastState(conv.id)?.pending?.sql === 'SELECT 1 FROM DUAL' ? lastState(conv.id)!.pending : undefined), 5000, 'prod 2');
  await call('claude.respond', conv.id, p2!.requestId, false);
  await idle(conv.id);
  // DB 목록에는 주소·계정을 보내지 않는다
  assert.match(texts[0], /개발\(dev\): shop_dev · Oracle · 조회 전용 계정 있음/);
  assert.doesNotMatch(texts[0], /10\.1\.2\.3|shop_app|shop_ro|1521/);
  assert.match(texts[1], /\| ORDER_NO \| CNT \|\n\| --- \| --- \|\n\| 1001 \| 2 \|/);
  assert.match(texts[2], /개인정보 가림 컬럼\(값이 \*\*\*\*\): CUST_NM/);
  assert.match(texts[3], /거부했습니다/);
  assert.match(texts[4], /db_propose_change/);
  assert.match(texts[5], /쿼리 카드를 만들었습니다 \(개발 DB shop_dev, DELETE, 예상 영향 1284행\)/);
  const its = items(conv.id);
  const sels = its.filter((i) => i.type === 'select') as Extract<ChatItem, { type: 'select' }>[];
  assert.equal(sels.length, 2);
  assert.deepEqual({ env: sels[0].env, db: sels[0].db, rows: sels[0].rows, ms: sels[0].ms }, { env: 'dev', db: 'shop_dev', rows: 2, ms: 12 });
  assert.deepEqual(sels[1].maskedColumns, ['CUST_NM']);
  const q = its.find((i) => i.type === 'query') as Extract<ChatItem, { type: 'query' }>;
  assert.equal(q.card.status, 'pending');
  assert.equal(q.card.conversationId, conv.id);
  const db = services.db as ReturnType<typeof fakeDb>;
  db.emitCard({ ...q.card, status: 'rolledback', result: { ok: false, affected: 10, expected: 1284, rolledBack: true, ms: 5 } });
  await waitFor(() => (items(conv.id).find((i) => i.id === q.id) as Extract<ChatItem, { type: 'query' }>).card.status === 'rolledback', 2000, 'card update');
});

test('오류 구분: 결과 오류·assistant 오류·프로세스 종료 → error 항목, 연결 상태 갱신', async () => {
  const cases: { emit: (t: TurnApi) => void; code: string; state?: string }[] = [
    { emit: (t) => t.emit(result({ is_error: true, result: 'Credit balance is too low' })), code: 'billing', state: 'login' },
    { emit: (t) => (t.emit(assistant('e1', [{ type: 'text', text: "You've hit your session limit · resets 3pm" }], { error: 'rate_limit' })), t.emit(result({ is_error: true, result: "You've hit your session limit · resets 3pm" }))), code: 'limit' },
    { emit: (t) => t.emit(result({ subtype: 'error_during_execution', is_error: true, errors: ['API Error: Connection error. (ECONNREFUSED)'] })), code: 'offline', state: 'offline' },
    {
      emit: () => {
        throw new Error('Claude Code process exited with code 1\nInvalid API key · Please run /login');
      },
      code: 'auth',
      state: 'login',
    },
  ];
  for (const c of cases) {
    handler = (t) => {
      t.emit(init());
      c.emit(t);
    };
    const conv = await call('claude.start', project, {});
    const n0 = events.length;
    await call('claude.send', conv.id, '질문');
    await idle(conv.id);
    const errs = items(conv.id).filter((i) => i.type === 'error') as Extract<ChatItem, { type: 'error' }>[];
    assert.equal(errs.length, 1, JSON.stringify(errs));
    assert.equal(errs[0].code, c.code, errs[0].message);
    if (c.state) {
      const st = await waitFor(() => events.slice(n0).filter((e) => e.type === 'claude.status').pop() as Extract<DesktopEvent, { type: 'claude.status' }> | undefined, 2000, 'status');
      assert.equal(st.status.state, c.state);
      assert.equal(st.status.code, c.code);
    }
  }
  // 프로세스가 죽은 뒤 다음 메시지는 새로 연다 (resume)
  handler = (t) => {
    t.emit(init());
    t.emit(result());
  };
  const n = fq.calls.options.length;
  const conv = (await call('claude.list', project))[0];
  await call('claude.send', conv.id, '다시');
  await idle(conv.id);
  assert.equal(fq.calls.options.length, n + 1);
  assert.equal(fq.calls.options.at(-1)!.resume, SESSION);
});

test('[중지]: interrupt → 기다리던 확인 요청은 거부, 결과 뒤 "중지" 안내 (오류 아님)', async () => {
  let perm: Record<string, any> = {};
  handler = async (t) => {
    t.emit(init());
    t.emit(stream({ type: 'message_start', message: { id: 'mx' } }));
    t.emit(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '작업 중' } }));
    perm = await t.canUseTool('Bash', { command: 'mvn -q compile' });
    await t.waitInterrupt(3000);
    t.emit(result({ subtype: 'error_during_execution', is_error: true, errors: ['[Request interrupted by user]'] }));
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, '컴파일해 주세요');
  await waitFor(() => lastState(conv.id)?.pending, 5000, 'pending');
  await call('claude.interrupt', conv.id);
  await idle(conv.id);
  assert.equal(perm.behavior, 'deny');
  assert.equal(fq.calls.interrupts > 0, true);
  const its = items(conv.id);
  assert.ok(its.some((i) => i.type === 'notice' && i.text === '응답을 중지했습니다'));
  assert.ok(!its.some((i) => i.type === 'error'));
  const a = its.find((i) => i.type === 'assistant') as Extract<ChatItem, { type: 'assistant' }>;
  assert.equal(a.text, '작업 중');
  assert.equal(a.streaming, undefined);
  assert.equal(lastState(conv.id)!.pending, null);
});

test('응답 중 보내기는 busy, 쉬면(idle) 프로세스를 닫고 다음에 resume', async () => {
  let release: () => void = () => undefined;
  handler = async (t) => {
    t.emit(init());
    await new Promise<void>((r) => (release = r));
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, '하나');
  await assert.rejects(call('claude.send', conv.id, '둘'), (e: Error & { code?: string }) => e.code === 'busy');
  // 화면 밖(작업 이력 등)에서 보내면 끝날 때까지 기다렸다가 보냄
  const later = services.claude!.send(conv.id, '셋');
  release();
  await later;
  await waitFor(() => fq.calls.turns.at(-1) === '셋', 2000, 'queued send');
  release();
  await idle(conv.id);
});

test('대화 시작 조건: 새 프로젝트는 빈 폴더만(not-empty), 원본 없는 대화는 수정 불가, 연동 꺼짐, 작업 사본 기능 없음', async () => {
  await assert.rejects(call('claude.start', project, { newProject: true }), (e: Error & { code?: string }) => e.code === 'not-empty' && /비어 있지 않습니다/.test(e.message));
  const empty = path.join(tmp, 'new-proj');
  fs.mkdirSync(empty);
  const np = await call('claude.start', empty, { newProject: true, references: [{ name: 'shop-admin', text: '구조 요약' }] });
  assert.equal(np.kind, 'new');
  assert.equal(np.workId, undefined);
  handler = (t) => {
    t.emit(init());
    t.emit(result());
  };
  await call('claude.send', np.id, '고객 문의 화면을 만들어 주세요');
  await idle(np.id);
  assert.equal(fq.calls.options.at(-1)!.cwd, path.resolve(empty));
  assert.match((fq.calls.options.at(-1)!.systemPrompt as { append: string }).append, /빈 폴더/);
  assert.match(fq.calls.turns.at(-1)!, /\[참고\][\s\S]*## shop-admin\n구조 요약/);
  const ro = await call('claude.start', null, {});
  assert.equal(ro.root, null);
  await assert.rejects(call('claude.setMode', ro.id, 'edit'), (e: Error & { code?: string }) => e.code === 'readonly');
  await call('claude.send', ro.id, '설명해 주세요');
  await idle(ro.id);
  const o = fq.calls.options.at(-1)!;
  assert.ok(o.disallowedTools!.includes('Bash'));
  assert.match((o.systemPrompt as { append: string }).append, /원본 소스 없이/);
  assert.match(o.cwd!, /claude-empty/);
  const listNull = await call('claude.list', '' as unknown as string);
  assert.ok(listNull.some((x) => x.id === ro.id));
  const w = services.work;
  services.work = undefined;
  await assert.rejects(call('claude.start', project, {}), (e: Error & { code?: string }) => e.code === 'unavailable');
  services.work = w;
  await setConfig({ enabled: false, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false });
  await assert.rejects(call('claude.start', project, {}), (e: Error & { code?: string }) => e.code === 'off');
  await setConfig({ enabled: true, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false });
});

test('내보내기(Markdown)·삭제', async () => {
  handler = async (t) => {
    t.emit(init());
    t.emit(assistant('m1', [toolUse('tu1', 'Read', { file_path: path.join(t.options.cwd!, OSI) })]));
    t.emit(toolResult('tu1', 'x'));
    // 실제 CLI 순서: tool_use 메시지 → PreToolUse 훅 → MCP 호출
    t.emit(assistant('m1b', [toolUse('tu2', 'mcp__projdb__db_select', { sql: 'SELECT 1 FROM DUAL' })]));
    await t.hook('mcp__projdb__db_select', { sql: 'SELECT 1 FROM DUAL' }, 'tu2');
    const r = await t.db().db_select({ sql: 'SELECT 1 FROM DUAL' });
    t.emit(toolResult('tu2', r.content[0].text));
    t.emit(assistant('m2', [{ type: 'text', text: '**원인**은 이것입니다.' }]));
    t.emit(result());
  };
  const conv = await call('claude.start', project, {});
  await call('claude.send', conv.id, '원인?');
  await idle(conv.id);
  const p = await call('claude.export', conv.id);
  assert.equal(p, path.join(tmp, 'export.md'));
  const md = fs.readFileSync(p as string, 'utf8');
  assert.match(md, /^# 원인\?\n/);
  assert.match(md, /- 프로젝트: .*shop-admin/);
  assert.match(md, /## 질문 · \d{4}-\d\d-\d\d \d\d:\d\d\n\n원인\?/);
  assert.match(md, /## Claude · .*\n\n\*\*원인\*\*은 이것입니다\./);
  assert.match(md, /> 작업 내역: 작업 2건 파일 1개 읽음 · DB 조회 1번/);
  assert.match(md, /> DB 조회: 개발 shop_dev · 2행 · 12ms/);
  assert.match(md, /```sql\nSELECT 1 FROM DUAL\n```/);
  await call('claude.delete', conv.id);
  assert.equal(await call('claude.get', conv.id), null);
  assert.ok(!(await call('claude.list', project)).some((x) => x.id === conv.id));
  assert.equal(await call('claude.get', '../../etc/passwd'), null);
});

test('모델: 목록(Claude Code initialize), 대화별 모델·기본 모델, 대화 중 바꾸기(setModel)와 안내, 실제 모델 표시', async () => {
  // 목록: default는 '기본값' 칸의 이름으로, 나머지는 고를 수 있는 모델로
  const list = await call('claude.models');
  assert.equal(list.error, undefined);
  assert.equal(list.defaultName, 'Default (recommended)');
  assert.deepEqual(list.models.map((m) => m.value), ['test-opus', 'test-haiku']);
  assert.equal(list.models[0].name, 'Test Opus');
  const opened = fq.calls.options.length;
  assert.deepEqual(await call('claude.models'), list, '두 번째는 기억한 목록');
  assert.equal(fq.calls.options.length, opened, '다시 띄우지 않음');

  handler = (t) => {
    t.emit(init({ model: t.model() }));
    t.emit(result());
  };
  // 대화에서 고른 모델로 연다
  const c1 = await call('claude.start', project, { model: 'test-opus' });
  assert.equal(c1.model, 'test-opus');
  await call('claude.send', c1.id, '하나');
  await idle(c1.id);
  assert.equal(fq.calls.options.at(-1)!.model, 'test-opus');
  await waitFor(() => lastState(c1.id)?.activeModel === 'test-opus', 2000, 'activeModel');
  assert.equal((await call('claude.get', c1.id))!.activeModel, 'test-opus');

  // 열린 대화에서 바꾸면 setModel로 알리고 안내를 남긴다. 다음 응답은 새 모델
  await call('claude.setModel', c1.id, 'test-haiku');
  assert.deepEqual(fq.calls.setModel.slice(-1), ['test-haiku']);
  assert.ok(items(c1.id).some((i) => i.type === 'notice' && /모델을 Test Haiku\(으\)로 바꿨습니다/.test(i.text)));
  assert.equal(lastState(c1.id)!.model, 'test-haiku');
  await call('claude.send', c1.id, '둘');
  await idle(c1.id);
  await waitFor(() => lastState(c1.id)?.activeModel === 'test-haiku', 2000, 'activeModel after setModel');
  // '' = Claude Code 기본값 (setModel(undefined))
  await call('claude.setModel', c1.id, '');
  assert.deepEqual(fq.calls.setModel.slice(-1), [undefined]);
  assert.ok(items(c1.id).some((i) => i.type === 'notice' && /Claude Code 기본값 \(Default \(recommended\)\)/.test(i.text)));
  // 같은 모델로 다시 고르면 아무 일 없음
  const nNotice = items(c1.id).filter((i) => i.type === 'notice').length;
  await call('claude.setModel', c1.id, '');
  assert.equal(items(c1.id).filter((i) => i.type === 'notice').length, nNotice);

  // 고르지 않은 대화는 Claude 연결의 기본 모델을 따른다
  await setConfig({ enabled: true, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false, model: 'test-opus' });
  const c2 = await call('claude.start', project, {});
  assert.equal(c2.model, undefined);
  await call('claude.send', c2.id, '셋');
  await idle(c2.id);
  assert.equal(fq.calls.options.at(-1)!.model, 'test-opus');
  // 닫혀 있는 대화의 모델을 바꾸면 다음에 열 때 그 모델로 (resume)
  await claudeModule().manager.closeAll();
  await call('claude.setModel', c2.id, 'test-haiku');
  await call('claude.send', c2.id, '넷');
  await idle(c2.id);
  const o = fq.calls.options.at(-1)!;
  assert.equal(o.model, 'test-haiku');
  assert.equal(o.resume, SESSION);
  // 쓸 수 없는 글자
  await assert.rejects(call('claude.setModel', c2.id, 'bad model;rm'), (e: Error & { code?: string }) => e.code === 'invalid');
  await assert.rejects(setConfig({ enabled: true, authMode: 'login', shellAllow: [], aiSummary: false, model: 'a b' }), /모델 이름/);
  await setConfig({ enabled: true, authMode: 'login', shellAllow: ['mvn -q compile'], aiSummary: false });
});

test('프로젝트 대화 모두 지우기 (claude.clear)', async () => {
  handler = (t) => {
    t.emit(init());
    t.emit(result());
  };
  const a = await call('claude.start', project, {});
  await call('claude.send', a.id, '하나');
  await idle(a.id);
  const b = await call('claude.start', project, {});
  const before = (await call('claude.list', project)).length;
  assert.ok(before >= 2);
  const n = await call('claude.clear', project);
  assert.equal(n, before);
  assert.deepEqual(await call('claude.list', project), []);
  assert.equal(await call('claude.get', a.id), null);
  assert.equal(await call('claude.get', b.id), null);
  await assert.rejects(call('claude.clear', path.join(tmp, 'no-such-folder')));
});
