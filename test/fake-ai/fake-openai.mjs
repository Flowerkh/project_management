// 가짜 OpenAI Responses API 서버 — 시험용 (실제 OpenAI·네트워크·계정을 쓰지 않음, 127.0.0.1에서만)
// =====================================================================================================
// 실제 Codex(app-server)를 이 서버에 붙여(사용자 정의 model provider, base_url=http://127.0.0.1:…/v1) 앱의 ChatGPT 엔진을
// 실제 Codex 프로토콜로 시험한다. 가짜 Codex(fake-codex.mjs)도 같은 시나리오 형식을 쓴다.
//   POST /v1/responses   SSE: response.created → output_item.added → output_text.delta… → output_item.done → response.completed
//   GET  /v1/models      { data: [{ id }] }
// 시나리오: { "turns": [{ "match": "정규식", "steps": [응답…] }], "default": [응답…] }
//   응답: { "say": "글", "calls": [{ "name": "grep", "args": {…} }], "error": { "status": 429, "message": "…", "times": 1 } }
//   마지막 사용자 글에 match가 맞는 첫 턴을 고르고, 그 뒤 도구 호출 수로 몇 번째 응답인지 정한다 (서버는 상태 없음).
import fs from 'node:fs';
import http from 'node:http';

export const FAKE_OPENAI_KEY = 'sk-fake-openai-0123456789';

const DEFAULT_SCENARIO = { turns: [], default: [{ say: 'OK' }] };

function loadScenario(s) {
  if (!s) return DEFAULT_SCENARIO;
  if (typeof s === 'object') return s;
  const t = String(s).trim();
  return JSON.parse(t.startsWith('{') ? t : fs.readFileSync(t, 'utf8'));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
}

/** Codex가 넣는 환경·지시 메시지는 사용자 글이 아니다 */
function isRealUser(item) {
  if (item?.type !== 'message' || item.role !== 'user') return false;
  const t = textOf(item.content).trim();
  return !!t && !/^<(environment_context|user_instructions|permissions|turn_aborted|subagent)/.test(t) && !t.startsWith('# AGENTS.md');
}

/** 마지막 사용자 글, 그 뒤 도구 호출 수, 바로 앞 도구 결과들 */
export function position(input) {
  const items = Array.isArray(input) ? input : [];
  let last = -1;
  for (let i = items.length - 1; i >= 0; i--)
    if (isRealUser(items[i])) {
      last = i;
      break;
    }
  const after = last >= 0 ? items.slice(last + 1) : [];
  const step = after.filter((x) => x.type === 'function_call').length;
  const outputs = [];
  for (let i = items.length - 1; i >= 0 && items[i].type === 'function_call_output'; i--) outputs.unshift(items[i]);
  return { text: last >= 0 ? textOf(items[last].content) : '', step, results: outputs.map((o) => (typeof o.output === 'string' ? o.output : textOf(o.output))) };
}

function stepsFor(scenario, text) {
  for (const t of scenario.turns ?? []) {
    try {
      if (!t.match || new RegExp(t.match, 'i').test(text)) return t.steps ?? [];
    } catch {
      // 잘못된 정규식
    }
  }
  return scenario.default ?? DEFAULT_SCENARIO.default;
}

function fill(s, results) {
  if (typeof s !== 'string') return s;
  return s.replace(/\{\{RESULT\}\}/g, String(results[0] ?? '').slice(0, 400));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * @param {{ port?: number, apiKey?: string, scenario?: object|string, delayMs?: number }} [opts]
 */
export async function startFakeOpenAI(opts = {}) {
  const state = {
    apiKey: opts.apiKey ?? FAKE_OPENAI_KEY,
    scenario: loadScenario(opts.scenario),
    delayMs: opts.delayMs ?? 5,
    requests: [],
    handler: null,
    errorCounts: new Map(),
    gate: null,
  };
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw };
    }
    const auth = String(req.headers.authorization ?? '');
    state.requests.push({ method: req.method, path: url.pathname, body, keyOk: auth === `Bearer ${state.apiKey}`, headers: { 'api-version': url.searchParams.get('api-version') } });
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (auth !== `Bearer ${state.apiKey}`) return json(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
    if (req.method === 'GET' && /\/models$/.test(url.pathname)) return json(200, { object: 'list', data: [{ id: 'gpt-fake-1', object: 'model' }, { id: 'gpt-fake-mini', object: 'model' }] });
    if (!(req.method === 'POST' && /\/responses$/.test(url.pathname))) return json(404, { error: { message: `not found ${url.pathname}` } });

    const pos = position(body.input);
    let step = state.handler ? state.handler(body, pos) : null;
    if (!step) {
      const steps = stepsFor(state.scenario, pos.text);
      step = steps[Math.min(pos.step, steps.length - 1)] ?? { say: 'OK' };
    }
    if (state.gate) await state.gate;
    if (step.error) {
      const key = `${pos.text}|${pos.step}|${step.error.status}`;
      const c = (state.errorCounts.get(key) ?? 0) + 1;
      state.errorCounts.set(key, c);
      if (!step.error.times || c <= step.error.times) return json(step.error.status, { error: { message: step.error.message ?? 'error', type: step.error.type ?? 'server_error', code: step.error.code ?? null } });
    }
    const id = `resp_${++n}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let closed = false;
    res.on('close', () => (closed = true));
    let seq = 0;
    const send = async (type, data) => {
      if (closed) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      await new Promise((r) => setTimeout(r, step.delayMs ?? state.delayMs));
    };
    const model = body.model ?? 'gpt-fake-1';
    await send('response.created', { response: { id, object: 'response', status: 'in_progress', model, output: [] } });
    const output = [];
    let idx = 0;
    const text = fill(step.say ?? '', pos.results);
    if (text) {
      const mid = `msg_${n}`;
      await send('response.output_item.added', { output_index: idx, item: { id: mid, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      await send('response.content_part.added', { item_id: mid, output_index: idx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      const size = Math.ceil(text.length / Math.max(1, step.chunks ?? 3)) || 1;
      for (let i = 0; i < text.length; i += size) {
        await send('response.output_text.delta', { item_id: mid, output_index: idx, content_index: 0, delta: text.slice(i, i + size) });
        if (step.cut) {
          res.destroy();
          return;
        }
      }
      await send('response.output_text.done', { item_id: mid, output_index: idx, content_index: 0, text });
      const item = { id: mid, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      await send('response.content_part.done', { item_id: mid, output_index: idx, content_index: 0, part: item.content[0] });
      await send('response.output_item.done', { output_index: idx, item });
      output.push(item);
      idx++;
    }
    for (const c of step.calls ?? []) {
      const callId = `call_${n}_${idx}`;
      const args = JSON.stringify(Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) => [k, fill(v, pos.results)])));
      const item = { id: `fc_${n}_${idx}`, type: 'function_call', status: 'completed', call_id: callId, name: c.name, arguments: args };
      await send('response.output_item.added', { output_index: idx, item: { ...item, status: 'in_progress', arguments: '' } });
      await send('response.function_call_arguments.delta', { item_id: item.id, output_index: idx, delta: args });
      await send('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: args });
      await send('response.output_item.done', { output_index: idx, item });
      output.push(item);
      idx++;
    }
    await send('response.completed', {
      response: { id, object: 'response', status: 'completed', model, output, usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 25 } },
    });
    res.end();
  });
  await new Promise((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    get requests() {
      return state.requests;
    },
    setScenario(s) {
      state.scenario = loadScenario(s);
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

if (process.argv[1]?.endsWith('fake-openai.mjs')) {
  const s = await startFakeOpenAI({ port: Number(process.argv[2] || 0), scenario: process.env.PA_FAKE_OPENAI_SCENARIO });
  console.log(s.url);
}
