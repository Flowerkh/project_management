#!/usr/bin/env node
// 가짜 Claude Code CLI — 시험·E2E용 (실제 Claude·네트워크·계정을 쓰지 않음)
// =====================================================================================================
// Claude Agent SDK가 띄우는 CLI 쪽 프로토콜(stream-json + 제어 요청)을 흉내 낸다.
//   - `--version` → "2.1.302 (Claude Code)" (PA_FAKE_VERSION으로 바꿈)
//   - initialize / set_permission_mode / interrupt / 그 밖의 제어 요청에 응답
//   - 사용자 메시지마다 system/init → 시나리오 단계들 → result
//   - 도구: PreToolUse 훅(hook_callback) → 권한 확인(can_use_tool, --permission-prompt-tool=stdio) → 실행 → tool_result
//     Read·Grep·Glob·LS·Edit·MultiEdit·Write는 작업 폴더(cwd)의 실제 파일로 실행. Bash·PowerShell은 절대 실행하지 않고
//     시나리오의 result(없으면 "(fake) 명령")를 돌려준다. ExitPlanMode는 권한 요청(=앱의 [수정 진행])을 거친다.
//   - MCP: {mcp:"db_select", input:{…}} → mcp_message(initialize·tools/list·tools/call)로 앱 안의 projdb 서버를 부른다
//
// 쓰는 법 (앱):  PA_CLAUDE_CLI=/…/test/fake-claude/fake-claude.mjs   (또는 Claude 설정의 cliPath)
//   앱은 .mjs 경로를 node로 실행한다(PATH에 node 필요). 리눅스에서 실행 파일 경로로 시험하려면 같은 폴더의 `claude`(sh).
//   Electron E2E: env에 PA_E2E=1, PA_CLAUDE_CLI, PA_FAKE_SCENARIO, PA_FAKE_STATE_DIR, 그리고 PA_FAKE_NET=ok|fail
//   (main.ts의 인터넷 확인을 흉내 — PA_E2E일 때만). CLAUDE*·ANTHROPIC*·프록시 변수는 넘기지 말 것.
//   예: scratchpad의 electron-issue.cjs 처럼 claude.config.set({enabled:true}) → claude.start(root) → claude.send →
//       claude.state의 pending(kind 'plan') → claude.respond(…, true) → 'changes' 항목
//
// 환경 변수 (앱은 PA_FAKE_*를 CLI에 그대로 넘긴다)
//   PA_FAKE_SCENARIO     시나리오 JSON 파일 경로 또는 JSON 문자열 (아래 형식)
//   PA_FAKE_AUTH         fail|limit|billing|offline|overloaded → 모든 요청을 그 오류로 (연결 확인 시험)
//   PA_FAKE_LOG          JSONL 기록 파일 (인자·환경 요약·제어 요청·권한 결정). 비밀 값은 남기지 않는다
//   PA_FAKE_STATE_DIR    세션 상태 폴더 (기본 <임시 폴더>/pa-fake-claude) — resume으로 다시 띄워도 다음 턴을 이어 감
//   PA_FAKE_STRICT_RESUME=1  모르는 --resume 세션이면 실제 CLI처럼 "No conversation found…"로 끝남
//   PA_FAKE_DELAY        글자 스트리밍 간격 ms (기본 8)
//   PA_FAKE_VERSION      --version 결과 (기본 2.1.302)
//   PA_FAKE_MODELS       initialize의 모델 목록 JSON (기본: default→fake-sonnet, fake-opus, fake-haiku)
//                        --model·set_model로 고른 모델이 system/init·assistant의 model로 나간다 (별칭은 resolvedModel로)
//
// 시나리오 형식
//   {
//     "probe":   [단계…],                 연결 확인 요청(--no-session-persistence --max-turns=1)에 쓰는 단계 (기본 [{"say":"OK"}])
//     "turns":   [{ "match": "정규식"?, "steps": [단계…] }, …],   사용자 메시지마다 아직 안 쓴 첫 턴 중 match가 맞는 것
//     "default": [단계…]                   맞는 턴이 없을 때 (기본 [{"say":"OK"}])
//   }
//   단계:
//     {"say": "글"}                                   답변 (스트리밍 + 완성 메시지)
//     {"tool": "Read", "input": {"file_path": "src/…/A.java"}}     경로는 cwd 기준 상대 경로도 됨 (절대 경로로 바꿔 보냄)
//     {"tool": "Grep", "input": {"pattern": "insertOrderHist"}}   {"tool": "Glob", "input": {"pattern": "**/*.xml"}}
//     {"tool": "Edit", "input": {"file_path", "old_string", "new_string", "replace_all"?}}   실제로 고침
//     {"tool": "Write", "input": {"file_path", "content"}}
//     {"tool": "Bash", "input": {"command": "mvn -q compile"}, "result": {"stdout": "BUILD SUCCESS", "exitCode": 0}}
//     {"tool": "ExitPlanMode", "input": {"plan": "## 계획…"}, "onDeny": "거부됐을 때 할 말"}   거부되면 그 턴의 남은 단계는 건너뜀
//     {"mcp": "db_select", "input": {"sql": "SELECT …", "env": "dev"}}   {"mcp": "db_propose_change", "input": {…}}  {"mcp": "db_list"}
//     {"error": "auth"|"limit"|"billing"|"offline"|"overloaded"|"other", "text"?: "문구"}   API 오류로 턴을 끝냄
//     {"sleep": 2000}                                  기다림 ([중지] 시험)
//     {"exit": 1, "stderr": "…"}                       프로세스 비정상 종료
//   예: test/fake-claude/scenarios/shop-admin.json
// =====================================================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const VERSION = process.env.PA_FAKE_VERSION || '2.1.302';
const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ 인자

const BOOL_FLAGS = new Set(['verbose', 'strict-mcp-config', 'include-partial-messages', 'continue', 'no-session-persistence', 'include-hook-events', 'allow-dangerously-skip-permissions', 'fork-session', 'await-initialize', 'debug', 'print']);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0) {
    args[a.slice(2, eq)] = a.slice(eq + 1);
  } else {
    const name = a.slice(2);
    if (!BOOL_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[name] = argv[++i];
    else args[name] = true;
  }
}
const list = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const allowedTools = new Set(list(args.allowedTools));
const disallowedTools = new Set(list(args.disallowedTools));
const partial = !!args['include-partial-messages'];
const stdioPermissions = args['permission-prompt-tool'] === 'stdio';
const isProbe = !!args['no-session-persistence'] && args['max-turns'] === '1';
let mode = typeof args['permission-mode'] === 'string' ? args['permission-mode'] : 'default';
const prePlanMode = 'default';
const DEFAULT_MODELS = [
  { value: 'default', resolvedModel: 'fake-sonnet', displayName: 'Default (recommended)', description: 'Fake Sonnet · 시험용 기본 모델' },
  { value: 'fake-opus', displayName: 'Fake Opus', description: '시험용 큰 모델' },
  { value: 'fake-haiku', displayName: 'Fake Haiku', description: '시험용 빠른 모델' },
];
let MODELS = DEFAULT_MODELS;
try {
  if (process.env.PA_FAKE_MODELS) MODELS = JSON.parse(process.env.PA_FAKE_MODELS);
} catch {
  // 기본 목록
}
/** 고른 모델 (별칭이면 실제 이름으로) */
let model = 'default';
const resolveModel = (m) => {
  const v = m || 'default';
  return MODELS.find((x) => x.value === v)?.resolvedModel ?? (v === 'default' ? 'fake-sonnet' : v);
};
if (typeof args.model === 'string' && args.model) model = args.model;
const cwd = process.cwd();
const delay = Number(process.env.PA_FAKE_DELAY ?? 8) || 0;
const BASE_TOOLS = ['Task', 'Bash', 'Glob', 'Grep', 'LS', 'ExitPlanMode', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite', 'WebFetch', 'WebSearch'];
const toolsArg = args.tools;
let builtinTools = toolsArg === undefined || toolsArg === true || toolsArg === 'default' ? BASE_TOOLS : list(toolsArg);
builtinTools = builtinTools.filter((t) => !disallowedTools.has(t));

// ------------------------------------------------------------------ 기록

const logFile = process.env.PA_FAKE_LOG;
function log(ev) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...ev })}\n`);
  } catch {
    // 무시
  }
}

function envSummary() {
  const e = process.env;
  const keys = Object.keys(e);
  const has = (k) => (e[k] ? '<set>' : undefined);
  return {
    ANTHROPIC_API_KEY: has('ANTHROPIC_API_KEY'),
    ANTHROPIC_API_KEY_SHA1: e.ANTHROPIC_API_KEY ? crypto.createHash('sha1').update(e.ANTHROPIC_API_KEY).digest('hex').slice(0, 8) : undefined,
    ANTHROPIC_AUTH_TOKEN: has('ANTHROPIC_AUTH_TOKEN'),
    CLAUDE_CODE_USE_BEDROCK: e.CLAUDE_CODE_USE_BEDROCK,
    CLAUDE_CODE_USE_VERTEX: e.CLAUDE_CODE_USE_VERTEX,
    CLAUDE_CODE_USE_FOUNDRY: e.CLAUDE_CODE_USE_FOUNDRY,
    AWS_REGION: e.AWS_REGION,
    AWS_SECRET_ACCESS_KEY: has('AWS_SECRET_ACCESS_KEY'),
    HTTPS_PROXY: e.HTTPS_PROXY ? e.HTTPS_PROXY.replace(/\/\/[^@/]*@/, '//****@') : undefined,
    HTTP_PROXY: e.HTTP_PROXY ? e.HTTP_PROXY.replace(/\/\/[^@/]*@/, '//****@') : undefined,
    CLAUDE_CODE_ENTRYPOINT: e.CLAUDE_CODE_ENTRYPOINT,
    CLAUDE_AGENT_SDK_CLIENT_APP: e.CLAUDE_AGENT_SDK_CLIENT_APP,
    PA_KEYS: keys.filter((k) => k.toUpperCase().startsWith('PA_')),
    CLAUDECODE: e.CLAUDECODE,
  };
}

log({ ev: 'start', argv, cwd, env: envSummary() });

// ------------------------------------------------------------------ 출력·제어 요청

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
const rid = () => crypto.randomBytes(6).toString('hex');
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = new Map();
let reqSeq = 0;
function request(subtype, payload) {
  const id = `fake-${++reqSeq}-${rid()}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, subtype });
    out({ type: 'control_request', request_id: id, request: { subtype, ...payload } });
  });
}

// ------------------------------------------------------------------ 시나리오·세션 상태

let scenario = null;
function loadScenario() {
  if (scenario) return scenario;
  const src = process.env.PA_FAKE_SCENARIO;
  scenario = {};
  if (src) {
    try {
      const text = src.trim().startsWith('{') ? src : fs.readFileSync(src, 'utf8');
      scenario = JSON.parse(text);
    } catch (e) {
      process.stderr.write(`fake-claude: 시나리오를 읽지 못했습니다: ${e.message}\n`);
    }
  }
  return scenario;
}

const stateDir = process.env.PA_FAKE_STATE_DIR || path.join(os.tmpdir(), 'pa-fake-claude');
let sessionId = null;
let state = { used: [], turns: 0 };
const resumeId = typeof args.resume === 'string' ? args.resume : null;

function stateFile(id) {
  return path.join(stateDir, `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);
}
function saveState() {
  if (!sessionId || isProbe) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
  } catch {
    // 무시
  }
}

if (resumeId) {
  const f = stateFile(resumeId);
  if (fs.existsSync(f)) {
    try {
      state = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      state = { used: [], turns: 0 };
    }
    sessionId = resumeId;
  } else if (process.env.PA_FAKE_STRICT_RESUME === '1') {
    log({ ev: 'resume-missing', resumeId });
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    process.exit(1);
  } else sessionId = resumeId;
}
if (!sessionId) sessionId = uuid();

function pickSteps(text) {
  const sc = loadScenario();
  if (isProbe) return sc.probe ?? [{ say: 'OK' }];
  const turns = Array.isArray(sc.turns) ? sc.turns : [];
  for (let i = 0; i < turns.length; i++) {
    if (state.used.includes(i)) continue;
    const t = turns[i] ?? {};
    let ok = true;
    if (t.match) {
      try {
        ok = new RegExp(t.match, 'i').test(text);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      state.used.push(i);
      return Array.isArray(t.steps) ? t.steps : [];
    }
  }
  return sc.default ?? [{ say: 'OK' }];
}

// ------------------------------------------------------------------ 입력 처리

let hooks = {};
let mcpServers = [];
let interrupted = false;
let wakeSleep = null;
const queue = [];
let busy = false;
let stdinEnded = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_response') {
    const r = msg.response ?? {};
    const p = pending.get(r.request_id);
    if (!p) return;
    pending.delete(r.request_id);
    if (r.subtype === 'error') p.reject(new Error(r.error || 'control error'));
    else p.resolve(r.response ?? {});
    return;
  }
  if (msg.type === 'control_request') {
    handleControl(msg);
    return;
  }
  if (msg.type === 'user') {
    queue.push(msg);
    void pump();
  }
});
rl.on('close', () => {
  stdinEnded = true;
  if (!busy) finish();
});

function finish() {
  log({ ev: 'exit' });
  process.exit(0);
}

function reply(id, response) {
  out({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
}

function handleControl(msg) {
  const req = msg.request ?? {};
  log({ ev: 'control', subtype: req.subtype, mode: req.mode });
  switch (req.subtype) {
    case 'initialize':
      hooks = req.hooks ?? {};
      mcpServers = Array.isArray(req.sdkMcpServers) ? req.sdkMcpServers : [];
      log({ ev: 'initialize', hooks: Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.map((m) => ({ matcher: m.matcher ?? null, n: m.hookCallbackIds?.length ?? 0 }))])), sdkMcpServers: mcpServers, appendSystemPrompt: req.appendSystemPrompt ?? null, systemPrompt: req.systemPrompt ?? null });
      reply(msg.request_id, {
        commands: [],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: MODELS,
        account: {},
        pid: process.pid,
        pending_permission_requests: [],
        pending_user_dialog_requests: [],
      });
      return;
    case 'set_permission_mode':
      mode = req.mode;
      log({ ev: 'mode', mode });
      reply(msg.request_id, {});
      return;
    case 'set_model':
      model = typeof req.model === 'string' && req.model ? req.model : 'default';
      log({ ev: 'set_model', model: req.model ?? null });
      reply(msg.request_id, {});
      return;
    case 'interrupt':
      interrupted = true;
      // 기다리는 권한 요청은 취소 (SDK가 canUseTool의 signal을 abort)
      for (const [id, p] of pending) {
        if (p.subtype === 'can_use_tool' || p.subtype === 'hook_callback') {
          out({ type: 'control_cancel_request', request_id: id });
          pending.delete(id);
          p.resolve({ behavior: 'deny', message: 'interrupted' });
        }
      }
      wakeSleep?.();
      reply(msg.request_id, {});
      return;
    default:
      reply(msg.request_id, {});
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) await runTurn(queue.shift());
  } finally {
    busy = false;
  }
  if (stdinEnded) finish();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ------------------------------------------------------------------ 한 턴

class StopTurn extends Error {}
let lastText = '';
let numTurns = 0;

function zeroUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function emitInit() {
  out({
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: sessionId,
    tools: [...builtinTools, ...mcpServers.flatMap((s) => ['db_list', 'db_select', 'db_propose_change'].map((t) => `mcp__${s}__${t}`))],
    mcp_servers: mcpServers.map((name) => ({ name, status: 'connected', source: 'sdk' })),
    model: resolveModel(model),
    permissionMode: mode,
    slash_commands: [],
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none',
    claude_code_version: VERSION,
    output_style: 'default',
    agents: [],
    skills: [],
    plugins: [],
    capabilities: ['interrupt_receipt_v1'],
    uuid: uuid(),
  });
}

function emitResult(extra = {}) {
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: numTurns,
    result: lastText,
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0,
    usage: zeroUsage(),
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    ...extra,
  });
}

async function runTurn(msg) {
  const text = textOf(msg.message?.content);
  log({ ev: 'user', text: text.slice(0, 4000) });
  interrupted = false;
  lastText = '';
  numTurns++;
  state.turns = (state.turns ?? 0) + 1;
  emitInit();
  const auth = process.env.PA_FAKE_AUTH;
  const steps = auth ? [{ error: auth === 'fail' ? 'auth' : auth }] : pickSteps(text);
  saveState();
  try {
    for (const step of steps) {
      if (interrupted) throw new StopTurn();
      await runStep(step ?? {});
    }
    if (interrupted) throw new StopTurn();
    emitResult();
  } catch (e) {
    if (e instanceof StopTurn) {
      if (interrupted) emitResult({ subtype: 'error_during_execution', is_error: true, errors: ['[Request interrupted by user]'], result: undefined });
      return;
    }
    process.stderr.write(`fake-claude: ${e?.stack ?? e}\n`);
    emitResult({ subtype: 'error_during_execution', is_error: true, errors: [String(e?.message ?? e)], result: undefined });
  }
}

async function interruptibleSleep(ms) {
  if (ms <= 0) return;
  await new Promise((r) => {
    const t = setTimeout(r, ms);
    wakeSleep = () => {
      clearTimeout(t);
      r();
    };
  });
  wakeSleep = null;
}

async function runStep(step) {
  if (typeof step.say === 'string') return say(step.say);
  if (typeof step.tool === 'string') return runTool(step.tool, step.input ?? {}, step);
  if (typeof step.mcp === 'string') return runTool(`mcp__${mcpServers[0] ?? 'projdb'}__${step.mcp}`, step.input ?? {}, step);
  if (typeof step.error === 'string') {
    apiError(step.error, step.text);
    throw new StopTurn();
  }
  if (typeof step.sleep === 'number') return interruptibleSleep(step.sleep);
  if (typeof step.exit === 'number') {
    if (step.stderr) process.stderr.write(`${step.stderr}\n`);
    log({ ev: 'crash', code: step.exit });
    process.exit(step.exit);
  }
}

function streamEvent(event) {
  out({ type: 'stream_event', event, parent_tool_use_id: null, session_id: sessionId, uuid: uuid() });
}

async function say(text) {
  const id = `msg_${rid()}`;
  if (partial) {
    streamEvent({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: resolveModel(model), content: [], stop_reason: null, usage: zeroUsage() } });
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 6) {
      if (interrupted) break;
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chars.slice(i, i + 6).join('') } });
      if (delay) await interruptibleSleep(delay);
    }
    streamEvent({ type: 'content_block_stop', index: 0 });
  }
  if (interrupted) throw new StopTurn();
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: resolveModel(model), content: [{ type: 'text', text }], stop_reason: null, usage: zeroUsage() }, parent_tool_use_id: null, session_id: sessionId, uuid: uuid() });
  if (partial) {
    streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    streamEvent({ type: 'message_stop' });
  }
  lastText = text;
}

function apiError(kind, custom) {
  const map = {
    auth: ['authentication_failed', 'Not logged in · Please run /login'],
    fail: ['authentication_failed', 'Not logged in · Please run /login'],
    limit: ['rate_limit', "You've hit your session limit · resets 3pm (Asia/Seoul)"],
    billing: ['billing_error', 'Credit balance is too low'],
    offline: ['unknown', 'API Error: Unable to connect to API (ECONNREFUSED)'],
    overloaded: ['overloaded', 'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.'],
    other: ['unknown', 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'],
  };
  const [code, text0] = map[kind] ?? map.other;
  const text = custom || text0;
  if (kind === 'offline') {
    for (let a = 1; a <= 2; a++)
      out({ type: 'system', subtype: 'api_retry', attempt: a, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown', session_id: sessionId, uuid: uuid() });
  }
  out({
    type: 'assistant',
    message: { id: uuid(), type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], stop_reason: 'stop_sequence', usage: zeroUsage() },
    parent_tool_use_id: null,
    error: code,
    session_id: sessionId,
    uuid: uuid(),
  });
  lastText = text;
  emitResult({ is_error: true, result: text, terminal_reason: 'api_error' });
  log({ ev: 'api-error', kind });
}

// ------------------------------------------------------------------ 도구

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const WRITERS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function abs(p) {
  if (typeof p !== 'string' || !p) return p;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}
function inside(base, p) {
  const r = path.relative(path.resolve(base), path.resolve(p));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
function targetOf(name, input) {
  if (name === 'Grep' || name === 'Glob' || name === 'LS') return input.path ? abs(input.path) : cwd;
  return abs(input.file_path ?? input.notebook_path ?? '');
}

function normalizeInput(name, input) {
  const x = { ...input };
  for (const k of ['file_path', 'notebook_path']) if (typeof x[k] === 'string') x[k] = abs(x[k]);
  if ((name === 'Grep' || name === 'Glob' || name === 'LS') && typeof x.path === 'string') x.path = abs(x.path);
  return x;
}

function needsPermission(name, input) {
  if (mode === 'bypassPermissions') return false;
  if (allowedTools.has(name) && !WRITERS.has(name) && name !== 'Bash' && name !== 'PowerShell') {
    if (READ_ONLY.has(name)) return !inside(cwd, targetOf(name, input));
    return false;
  }
  if (READ_ONLY.has(name)) return !inside(cwd, targetOf(name, input));
  if (WRITERS.has(name)) return !(mode === 'acceptEdits' && inside(cwd, targetOf(name, input)));
  if (name === 'TodoWrite') return false;
  return true;
}

async function preToolHooks(name, input, toolUseId) {
  let ask = false;
  for (const m of hooks.PreToolUse ?? []) {
    if (m.matcher) {
      let re;
      try {
        re = new RegExp(`^(?:${m.matcher})$`);
      } catch {
        continue;
      }
      if (!re.test(name)) continue;
    }
    for (const cb of m.hookCallbackIds ?? []) {
      const r = await request('hook_callback', {
        callback_id: cb,
        input: { session_id: sessionId, transcript_path: '', cwd, permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: toolUseId },
        tool_use_id: toolUseId,
      });
      const d = r?.hookSpecificOutput?.permissionDecision;
      log({ ev: 'hook', tool: name, decision: d ?? (r?.decision === 'block' ? 'block' : 'none') });
      if (r?.decision === 'block' || d === 'deny') return { deny: true, reason: r?.hookSpecificOutput?.permissionDecisionReason || r?.reason || 'Blocked by hook' };
      if (d === 'ask') ask = true;
    }
  }
  return { deny: false, ask };
}

function toolResult(id, content, isError, structured) {
  out({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
    ...(structured !== undefined ? { tool_use_result: structured } : {}),
  });
}

async function runTool(name, rawInput, step) {
  const id = `toolu_${rid()}`;
  const input = normalizeInput(name, rawInput);
  const msgId = `msg_${rid()}`;
  if (partial) {
    streamEvent({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: resolveModel(model), content: [], stop_reason: null, usage: zeroUsage() } });
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    streamEvent({ type: 'content_block_stop', index: 0 });
  }
  out({ type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model: resolveModel(model), content: [{ type: 'tool_use', id, name, input }], stop_reason: null, usage: zeroUsage() }, parent_tool_use_id: null, session_id: sessionId, uuid: uuid() });
  if (partial) {
    streamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
    streamEvent({ type: 'message_stop' });
  }

  const isMcp = name.startsWith('mcp__');
  if ((!isMcp && !builtinTools.includes(name)) || disallowedTools.has(name)) {
    log({ ev: 'tool', tool: name, decision: 'unavailable' });
    toolResult(id, `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`, true);
    return;
  }

  const hook = await preToolHooks(name, input, id);
  if (interrupted) throw new StopTurn();
  if (hook.deny) {
    log({ ev: 'tool', tool: name, decision: 'hook-deny', reason: hook.reason });
    toolResult(id, `PreToolUse:${name} hook error: ${hook.reason}`, true);
    return;
  }
  let finalInput = input;
  if (hook.ask || needsPermission(name, input)) {
    if (!stdioPermissions) {
      log({ ev: 'tool', tool: name, decision: 'no-prompt-deny' });
      toolResult(id, `Claude requested permissions to use ${name}, but you haven't granted it yet.`, true);
      return;
    }
    const r = await request('can_use_tool', { tool_name: name, input, tool_use_id: id, permission_suggestions: [], ...(hook.ask ? { decision_reason: { type: 'hook' } } : {}) });
    log({ ev: 'permission', tool: name, behavior: r?.behavior, message: r?.message, updatedPermissions: r?.updatedPermissions });
    if (interrupted) throw new StopTurn();
    if (r?.behavior !== 'allow') {
      toolResult(id, r?.message || `Permission to use ${name} has been denied.`, true);
      if (name === 'ExitPlanMode') {
        await say(step?.onDeny || '알겠습니다. 계획 모드를 유지하겠습니다. 수정안을 더 다듬을 부분이 있으면 말씀해 주세요.');
        // 남은 단계(수정)는 하지 않는다
        emitResult();
        throw new StopTurn();
      }
      return;
    }
    if (r.updatedInput && typeof r.updatedInput === 'object') finalInput = r.updatedInput;
    for (const u of r.updatedPermissions ?? []) if (u?.type === 'setMode' && u.mode) mode = u.mode;
  } else log({ ev: 'tool', tool: name, decision: 'auto' });

  let res;
  try {
    res = await execTool(name, finalInput, step);
  } catch (e) {
    res = { content: `<tool_use_error>${e.message}</tool_use_error>`, isError: true };
  }
  toolResult(id, res.content, !!res.isError, res.structured);
}

const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', 'target', 'build', 'dist', '.idea', '.gradle']);
function walk(dir, outList = [], max = 20000) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return outList;
  }
  for (const e of ents) {
    if (outList.length >= max) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, outList, max);
    } else if (e.isFile()) outList.push(p);
  }
  return outList;
}

function globToRe(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') {
      re += pat[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pat[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

async function execTool(name, input, step) {
  if (step?.result) {
    const r = step.result;
    const code = r.exitCode ?? 0;
    const content = r.content ?? [r.stdout ?? '', r.stderr ?? ''].filter(Boolean).join('\n') ?? '';
    return { content: code ? `${content}\nExit code ${code}` : content || '(출력 없음)', isError: !!r.isError || code !== 0, structured: r.structured ?? { stdout: r.stdout ?? '', stderr: r.stderr ?? '', interrupted: false } };
  }
  switch (name) {
    case 'Read': {
      const f = input.file_path;
      if (!fs.existsSync(f)) return { content: `<tool_use_error>File does not exist. ${f}</tool_use_error>`, isError: true };
      const all = fs.readFileSync(f, 'utf8').split('\n');
      const start = Math.max(1, Number(input.offset) || 1);
      const limit = Number(input.limit) || 2000;
      const slice = all.slice(start - 1, start - 1 + limit);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n');
      return { content: numbered, structured: { type: 'text', file: { filePath: f, content: slice.join('\n'), numLines: slice.length, startLine: start, totalLines: all.length } } };
    }
    case 'Grep': {
      let re;
      try {
        re = new RegExp(input.pattern, input['-i'] ? 'i' : '');
      } catch (e) {
        return { content: `<tool_use_error>Invalid regex: ${e.message}</tool_use_error>`, isError: true };
      }
      const base = input.path || cwd;
      const files = fs.existsSync(base) && fs.statSync(base).isFile() ? [base] : walk(base);
      const globRe = input.glob ? globToRe(String(input.glob).includes('/') ? input.glob : `**/${input.glob}`) : null;
      const hits = [];
      const lines = [];
      for (const f of files) {
        const rel = path.relative(cwd, f).split(path.sep).join('/');
        if (globRe && !globRe.test(rel)) continue;
        let text;
        try {
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (!re.test(text)) continue;
        hits.push(f);
        text.split('\n').forEach((l, i) => {
          if (re.test(l)) lines.push(`${f}:${i + 1}:${l}`);
        });
      }
      if (input.output_mode === 'content') return { content: lines.join('\n') || 'No matches found', structured: { mode: 'content', numFiles: hits.length, filenames: hits, content: lines.join('\n'), numLines: lines.length } };
      return { content: hits.length ? `Found ${hits.length} file${hits.length === 1 ? '' : 's'}\n${hits.join('\n')}` : 'No files found', structured: { mode: 'files_with_matches', numFiles: hits.length, filenames: hits } };
    }
    case 'Glob': {
      const base = input.path || cwd;
      const re = globToRe(String(input.pattern || '**/*'));
      const files = walk(base).filter((f) => re.test(path.relative(base, f).split(path.sep).join('/')));
      return { content: files.length ? files.join('\n') : 'No files found', structured: { durationMs: 1, numFiles: files.length, filenames: files, truncated: false } };
    }
    case 'LS': {
      const base = input.path || cwd;
      const names = fs.readdirSync(base);
      return { content: names.map((n) => `- ${n}`).join('\n') };
    }
    case 'Write': {
      const f = input.file_path;
      const existed = fs.existsSync(f);
      const old = existed ? fs.readFileSync(f, 'utf8') : null;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(input.content ?? ''));
      return {
        content: existed ? `The file ${f} has been updated successfully.` : `File created successfully at: ${f}`,
        structured: { type: existed ? 'update' : 'create', filePath: f, content: String(input.content ?? ''), structuredPatch: [], originalFile: old },
      };
    }
    case 'Edit':
    case 'MultiEdit': {
      const f = input.file_path;
      if (!fs.existsSync(f)) return { content: `<tool_use_error>File does not exist. ${f}</tool_use_error>`, isError: true };
      const original = fs.readFileSync(f, 'utf8');
      let text = original;
      const edits = name === 'MultiEdit' ? input.edits ?? [] : [input];
      let firstLine = null;
      for (const e of edits) {
        const idx = text.indexOf(e.old_string);
        if (idx < 0) return { content: '<tool_use_error>String to replace not found in file.</tool_use_error>', isError: true };
        if (firstLine === null) firstLine = lineOf(text, idx);
        text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.slice(0, idx) + e.new_string + text.slice(idx + e.old_string.length);
      }
      fs.writeFileSync(f, text);
      const first = edits[0] ?? {};
      return {
        content: `The file ${f} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file.`,
        structured: {
          filePath: f,
          oldString: first.old_string,
          newString: first.new_string,
          originalFile: original,
          structuredPatch: [{ oldStart: firstLine ?? 1, oldLines: String(first.old_string ?? '').split('\n').length, newStart: firstLine ?? 1, newLines: String(first.new_string ?? '').split('\n').length, lines: [] }],
          userModified: false,
          replaceAll: !!first.replace_all,
        },
      };
    }
    case 'Bash':
    case 'PowerShell':
      // 가짜 CLI는 명령을 실행하지 않는다
      return { content: `(fake) ${input.command}`, structured: { stdout: `(fake) ${input.command}`, stderr: '', interrupted: false } };
    case 'ExitPlanMode':
      if (mode === 'plan') mode = prePlanMode;
      return { content: 'User has approved your plan. You can now start coding.', structured: { plan: input.plan ?? null, isAgent: false } };
    case 'TodoWrite':
      return { content: 'Todos have been modified successfully.' };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        const r = await mcpCall(server, tool, input);
        return { content: r.content ?? [{ type: 'text', text: JSON.stringify(r) }], isError: !!r.isError };
      }
      return { content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`, isError: true };
  }
}

// ------------------------------------------------------------------ MCP (앱 안의 SDK MCP 서버)

const mcpReady = new Set();
let mcpSeq = 0;
async function mcpSend(server, message) {
  const r = await request('mcp_message', { server_name: server, message });
  return r?.mcp_response ?? r;
}
async function mcpCall(server, tool, args0) {
  if (!mcpReady.has(server)) {
    await mcpSend(server, { jsonrpc: '2.0', id: `init-${++mcpSeq}`, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } } });
    await mcpSend(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await mcpSend(server, { jsonrpc: '2.0', id: `list-${++mcpSeq}`, method: 'tools/list', params: {} });
    log({ ev: 'mcp-tools', server, tools: (list?.result?.tools ?? []).map((t) => t.name) });
    mcpReady.add(server);
  }
  const resp = await mcpSend(server, { jsonrpc: '2.0', id: `call-${++mcpSeq}`, method: 'tools/call', params: { name: tool, arguments: args0 } });
  log({ ev: 'mcp-call', server, tool, isError: !!resp?.result?.isError, error: resp?.error?.message });
  if (resp?.error) return { content: [{ type: 'text', text: `MCP error: ${resp.error.message}` }], isError: true };
  return resp?.result ?? {};
}
