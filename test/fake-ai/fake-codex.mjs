#!/usr/bin/env node
// 가짜 Codex CLI — 시험·E2E용 (실제 OpenAI·ChatGPT 계정·네트워크를 쓰지 않음)
// =====================================================================================================
// `codex --version`과 `codex [-c 키=값 …] app-server`(표준 입출력 JSONL)를 흉내 낸다. 알림·요청 모양은 실제
// codex-cli 0.163.0에서 받은 것과 같게 (thread/started, turn/started, item/started·completed, item/agentMessage/delta,
// item/tool/call 요청, error, turn/completed).
//
// 쓰는 법 (앱): PA_CODEX_CLI=/…/test/fake-ai/fake-codex.mjs (앱은 .mjs를 node로 실행)
// 환경 변수
//   PA_FAKE_CODEX_SCENARIO  시나리오 파일 경로 또는 JSON (fake-openai.mjs와 같은 형식, 아래)
//   PA_FAKE_CODEX_AUTH      chatgpt(기본) | none | apikey — account/read 결과. <상태 폴더>/account.json이 있으면 그것
//   PA_FAKE_CODEX_STATE     스레드 기록 폴더 (기본 <임시 폴더>/pa-fake-codex) — thread/resume으로 이어 감
//   PA_FAKE_CODEX_LOG       JSONL 기록 (인수·thread/start·turn/start 요약). 비밀 값은 남기지 않는다 (키는 있는지만)
//   PA_FAKE_CODEX_MCP       config/read에 보일 사용자 MCP 서버 이름 (쉼표)
//   PA_FAKE_CODEX_FAIL      auth | limit | billing | offline — 모든 턴을 그 오류로
//   PA_FAKE_CODEX_VERSION   --version (기본 0.163.0)
// 시나리오: { "turns": [{ "match": "정규식", "steps": [단계…] }], "default": [단계…] }
//   단계: { "say": "글", "calls": [{ "name": "grep", "args": {…} }], "delayMs": 5, "chunks": 3,
//          "error": { "status": 401|429|503, "message": "…" }, "crash": true(프로세스가 끝남) }
//   도구 호출이 있는 단계는 결과를 받은 뒤 다음 단계로, 도구 호출이 없는 단계에서 턴이 끝난다. {{RESULT}} = 앞 도구 결과
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log(`codex-cli ${process.env.PA_FAKE_CODEX_VERSION || '0.163.0'}`);
  process.exit(0);
}
if (argv.includes('login')) {
  console.log('(fake) codex login');
  process.exit(0);
}
if (!argv.includes('app-server')) {
  console.error('fake codex: app-server만 지원합니다');
  process.exit(2);
}

const stateDir = process.env.PA_FAKE_CODEX_STATE || path.join(os.tmpdir(), 'pa-fake-codex');
fs.mkdirSync(path.join(stateDir, 'threads'), { recursive: true });
const logFile = process.env.PA_FAKE_CODEX_LOG;
const log = (o) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...o })}\n`);
};
const overrides = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '-c' && argv[i + 1]) overrides.push(argv[++i]);
log({ kind: 'start', overrides, env: { openaiKey: !!process.env.PROJECT_ANALYZER_OPENAI_KEY, azureKey: !!process.env.PROJECT_ANALYZER_AZURE_KEY, https_proxy: process.env.HTTPS_PROXY ? 'set' : '', paVars: Object.keys(process.env).filter((k) => /^PA_/.test(k) && !/^PA_FAKE_/.test(k)) } });

function loadScenario() {
  const s = process.env.PA_FAKE_CODEX_SCENARIO;
  if (!s) return { turns: [], default: [{ say: 'OK' }] };
  const t = s.trim();
  return JSON.parse(t.startsWith('{') ? t : fs.readFileSync(t, 'utf8'));
}

function account() {
  const f = path.join(stateDir, 'account.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const mode = process.env.PA_FAKE_CODEX_AUTH || 'chatgpt';
  if (mode === 'none') return { account: null, requiresOpenaiAuth: true };
  if (mode === 'apikey') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
  return { account: { type: 'chatgpt', email: 'tester@example.com', planType: 'plus' }, requiresOpenaiAuth: true };
}

const MODELS = [
  { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Fast frontier model', hidden: false, isDefault: true },
  { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Most capable model', hidden: false, isDefault: false },
  { id: 'gpt-5.3-codex', model: 'gpt-5.3-codex', displayName: 'GPT-5.3-Codex', description: 'Coding model', hidden: false, isDefault: false },
  { id: 'gpt-internal', model: 'gpt-internal', displayName: 'Hidden', description: '', hidden: true, isDefault: false },
];

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(16)}${(++seq).toString(16).padStart(4, '0')}`;
const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => write({ method, params });
let reqId = 1000;
const waiting = new Map();
/** 앱에 요청 (item/tool/call 등) → 답 */
function ask(method, params) {
  const id = ++reqId;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const threads = new Map();
const threadFile = (id) => path.join(stateDir, 'threads', `${id}.json`);
function saveThread(t) {
  if (!t.ephemeral) fs.writeFileSync(threadFile(t.id), JSON.stringify(t));
}

let running = null; // { threadId, turnId, abort }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorInfo(status) {
  if (status === 401) return { httpConnectionFailed: { httpStatusCode: 401 } };
  if (status === 429) return 'usageLimitExceeded';
  if (status === 402) return { httpConnectionFailed: { httpStatusCode: 402 } };
  if (status === 0) return { httpConnectionFailed: { httpStatusCode: null } };
  if (status >= 500) return 'serverOverloaded';
  return 'other';
}

function failMode() {
  const f = process.env.PA_FAKE_CODEX_FAIL;
  if (f === 'auth') return { status: 401, message: 'unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again.' };
  if (f === 'limit') return { status: 429, message: "You've hit your usage limit. Upgrade to Pro or try again later." };
  if (f === 'billing') return { status: 429, message: 'Quota exceeded. Check your plan and billing details.' };
  if (f === 'offline') return { status: 0, message: 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)' };
  return null;
}

async function runTurn(t, turn, text) {
  const ctl = { aborted: false };
  running = { threadId: t.id, turnId: turn.id, ctl };
  const done = (status, error = null) => {
    if (running?.turnId === turn.id) running = null;
    notify('turn/completed', { threadId: t.id, turn: { ...turn, items: [], itemsView: 'summary', status, error, completedAt: Math.floor(Date.now() / 1000) } });
  };
  notify('turn/started', { threadId: t.id, turn });
  const uidMsg = uid('item');
  notify('item/started', { item: { type: 'userMessage', id: uidMsg, clientId: null, content: [{ type: 'text', text, text_elements: [] }] }, threadId: t.id, turnId: turn.id, startedAtMs: Date.now() });
  notify('item/completed', { item: { type: 'userMessage', id: uidMsg, clientId: null, content: [{ type: 'text', text, text_elements: [] }] }, threadId: t.id, turnId: turn.id, completedAtMs: Date.now() });
  t.history.push({ role: 'user', text });
  const fm = failMode();
  const sc = loadScenario();
  let steps = sc.default ?? [{ say: 'OK' }];
  for (const tr of sc.turns ?? []) {
    try {
      if (!tr.match || new RegExp(tr.match, 'i').test(text)) {
        steps = tr.steps ?? [];
        break;
      }
    } catch {
      // 잘못된 정규식
    }
  }
  if (fm) steps = [{ error: fm }];
  let lastResult = '';
  for (const step of steps) {
    if (ctl.aborted) return done('interrupted');
    if (step.crash) {
      process.stderr.write('fake codex: 갑자기 끝남\n');
      process.exit(3);
    }
    if (step.error) {
      const e = { message: step.error.message ?? `unexpected status ${step.error.status}`, codexErrorInfo: errorInfo(step.error.status), additionalDetails: null, misalignment: null };
      if (step.error.status >= 500 && step.error.times) {
        notify('error', { error: { ...e, message: 'Reconnecting... 1/5' }, willRetry: true, threadId: t.id, turnId: turn.id });
      } else {
        notify('error', { error: e, willRetry: false, threadId: t.id, turnId: turn.id });
        saveThread(t);
        return done('failed', e);
      }
    }
    const say = String(step.say ?? '').replace(/\{\{RESULT\}\}/g, lastResult.slice(0, 400));
    if (say) {
      const id = uid('msg_');
      notify('item/started', { item: { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null }, threadId: t.id, turnId: turn.id, startedAtMs: Date.now() });
      const n = Math.max(1, step.chunks ?? 3);
      const size = Math.ceil(say.length / n) || 1;
      for (let i = 0; i < say.length; i += size) {
        if (ctl.aborted) return done('interrupted');
        notify('item/agentMessage/delta', { threadId: t.id, turnId: turn.id, itemId: id, delta: say.slice(i, i + size) });
        await sleep(step.delayMs ?? 5);
      }
      notify('item/completed', { item: { type: 'agentMessage', id, text: say, phase: null, memoryCitation: null, delivery: null, questions: null }, threadId: t.id, turnId: turn.id, completedAtMs: Date.now() });
      t.history.push({ role: 'assistant', text: say });
    }
    if (!step.calls?.length) break;
    for (const c of step.calls) {
      if (ctl.aborted) return done('interrupted');
      const callId = uid('call_');
      if (!t.dynamicTools.includes(c.name)) {
        lastResult = `unsupported call: ${c.name}`;
        continue;
      }
      const item = { type: 'dynamicToolCall', id: callId, namespace: null, tool: c.name, arguments: c.args ?? {}, status: 'inProgress', contentItems: null, success: null, durationMs: null };
      notify('item/started', { item, threadId: t.id, turnId: turn.id, startedAtMs: Date.now() });
      const res = await ask('item/tool/call', { threadId: t.id, turnId: turn.id, callId, namespace: null, tool: c.name, arguments: c.args ?? {} });
      const ok = !res.error && res.result?.success !== false;
      lastResult = res.error ? 'dynamic tool request failed' : (res.result?.contentItems ?? []).map((x) => x.text ?? '').join('\n');
      notify('item/completed', { item: { ...item, status: res.error ? 'failed' : 'completed', contentItems: res.result?.contentItems ?? null, success: ok, durationMs: 1 }, threadId: t.id, turnId: turn.id, completedAtMs: Date.now() });
      t.history.push({ role: 'tool', name: c.name, text: lastResult });
      log({ kind: 'tool', name: c.name, ok, result: lastResult.slice(0, 300) });
    }
  }
  saveThread(t);
  if (ctl.aborted) return done('interrupted');
  done('completed');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      w(m);
    }
    return;
  }
  if (m.id === undefined) return; // 알림 (initialized)
  const reply = (result) => write({ id: m.id, result });
  const fail = (code, message) => write({ id: m.id, error: { code, message } });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      log({ kind: 'initialize', clientInfo: p.clientInfo, experimental: !!p.capabilities?.experimentalApi });
      return reply({ userAgent: `${p.clientInfo?.name ?? 'client'}/0.163.0`, codexHome: stateDir, platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform });
    case 'config/read': {
      const names = (process.env.PA_FAKE_CODEX_MCP || '').split(',').filter(Boolean);
      return reply({ config: { mcp_servers: Object.fromEntries(names.map((n) => [n, { command: 'node', args: [], enabled: true }])) }, origins: {}, layers: null });
    }
    case 'account/read':
      return reply(account());
    case 'model/list':
      return reply({ data: MODELS.filter((x) => p.includeHidden || !x.hidden), nextCursor: null });
    case 'thread/start': {
      const t = { id: `01${Date.now().toString(16)}-fake-${(++seq).toString(16)}`, model: p.model ?? 'gpt-6.1-sol', ephemeral: !!p.ephemeral, dynamicTools: (p.dynamicTools ?? []).map((d) => d.name), baseInstructions: p.baseInstructions ?? '', history: [] };
      threads.set(t.id, t);
      saveThread(t);
      log({ kind: 'thread/start', model: p.model ?? null, cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: p.sandbox, ephemeral: !!p.ephemeral, dynamicTools: t.dynamicTools, baseInstructions: String(p.baseInstructions ?? '').slice(0, 2000), config: p.config ?? null });
      reply({ thread: { id: t.id, turns: [] }, model: t.model, modelProvider: 'openai', cwd: p.cwd, approvalPolicy: p.approvalPolicy ?? 'untrusted', sandbox: { type: 'readOnly', networkAccess: false } });
      return notify('thread/started', { thread: { id: t.id } });
    }
    case 'thread/resume': {
      let t = threads.get(p.threadId);
      if (!t && fs.existsSync(threadFile(p.threadId))) t = JSON.parse(fs.readFileSync(threadFile(p.threadId), 'utf8'));
      if (!t) return fail(-32600, `no rollout found for thread id ${p.threadId}`);
      if (p.model) t.model = p.model;
      threads.set(t.id, t);
      log({ kind: 'thread/resume', threadId: t.id, model: p.model ?? null, config: p.config ?? null, history: t.history.length });
      return reply({ thread: { id: t.id, turns: [] }, model: t.model, modelProvider: 'openai' });
    }
    case 'turn/start': {
      const t = threads.get(p.threadId);
      if (!t) return fail(-32600, `thread not found: ${p.threadId}`);
      if (p.model) t.model = p.model;
      const text = (p.input ?? []).map((i) => i.text ?? '').join('\n');
      const turn = { id: uid('turn'), rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
      log({ kind: 'turn/start', threadId: t.id, model: p.model ?? null, text: text.slice(0, 4000), history: t.history.length });
      reply({ turn });
      void runTurn(t, turn, text);
      return;
    }
    case 'turn/interrupt': {
      if (running && running.turnId === p.turnId) running.ctl.aborted = true;
      log({ kind: 'turn/interrupt', turnId: p.turnId });
      return reply({});
    }
    default:
      return fail(-32601, `method not found: ${m.method}`);
  }
});
