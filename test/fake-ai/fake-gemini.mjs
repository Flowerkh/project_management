// 가짜 Gemini API 서버 — 시험·E2E용 (실제 Google·네트워크·계정을 쓰지 않음, 127.0.0.1에서만)
// =====================================================================================================
// 실제 Gemini REST처럼 답한다:
//   GET  /v1beta/models                                   모델 목록 (x-goog-api-key 확인)
//   POST /v1beta/models/{모델}:countTokens                 { totalTokens }
//   POST /v1beta/models/{모델}:streamGenerateContent?alt=sse   SSE 'data: {GenerateContentResponse}'
//   Vertex: /v1/projects/{p}/locations/{l}/publishers/google/models/{모델}:… (Authorization: Bearer 토큰 확인)
// 실제 Gemini 3·4처럼 도구 호출(functionCall) 부분에 thoughtSignature를 붙여 보내고, 다음 요청의 기록에
// 그 서명이 그대로 돌아오지 않으면 400으로 거절한다 (앱이 서명을 지키는지 시험).
//
// 시나리오 (E2E: PA_FAKE_GEMINI_SCENARIO 파일 또는 JSON, 단위 시험: start({scenario}) 또는 server.handler)
//   { "turns": [{ "match": "정규식", "steps": [응답…] }], "default": [응답…] }
//   마지막 사용자 글(맥락 포함)에 match가 맞는 첫 턴을 고르고, 그 질문 뒤 모델 응답 수로 몇 번째 응답인지 정한다 (서버는 상태 없음).
//   응답: { "say": "글", "calls": [{ "name": "grep", "args": {…} }], "finish": "STOP", "chunks": 3,
//          "error": { "status": 503, "message": "…", "statusText": "UNAVAILABLE", "times": 1 } }
//   글 안의 {{RESULT}}는 바로 앞 도구 결과(output·error 앞부분)로 바뀐다.
import fs from 'node:fs';
import http from 'node:http';

export const FAKE_GEMINI_KEY = 'fake-gemini-key-0123456789';
export const FAKE_VERTEX_TOKEN = 'fake-vertex-token-0123456789abcdef';

const MODELS = [
  { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-2.0-flash-001', displayName: 'Gemini 2.0 Flash 001', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-2', displayName: 'Gemini Embedding 2', supportedGenerationMethods: ['embedContent'] },
  { name: 'models/gemma-4-27b-it', displayName: 'Gemma 4 27B', supportedGenerationMethods: ['generateContent'] },
];

const DEFAULT_SCENARIO = { turns: [], default: [{ say: 'OK' }] };

function sig(model, n) {
  return Buffer.from(`sig:${model}:${n}`).toString('base64');
}

function errorBody(status, statusText, message, extra = {}) {
  return { error: { code: status, message, status: statusText, ...extra } };
}

/** 마지막 사용자 글과 그 뒤 모델 응답 수, 바로 앞 도구 결과 */
export function position(contents) {
  let lastUser = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role === 'user' && (c.parts ?? []).some((p) => typeof p.text === 'string' && p.text.trim())) {
      lastUser = i;
      break;
    }
  }
  const text = lastUser >= 0 ? contents[lastUser].parts.map((p) => p.text ?? '').join('\n') : '';
  const after = lastUser >= 0 ? contents.slice(lastUser + 1) : [];
  const step = after.filter((c) => c.role === 'model').length;
  const last = contents[contents.length - 1];
  const results = (last?.parts ?? []).filter((p) => p.functionResponse).map((p) => p.functionResponse);
  return { text, step, results };
}

/** 서명 확인: 기록의 모델 응답 중 도구 호출이 있는 것은 첫 functionCall 부분에 우리가 준 서명이 있어야 함 */
function checkSignatures(contents) {
  for (const c of contents) {
    if (c.role !== 'model') continue;
    const calls = (c.parts ?? []).filter((p) => p.functionCall);
    if (!calls.length) continue;
    const s = calls[0].thoughtSignature;
    if (typeof s !== 'string' || !Buffer.from(s, 'base64').toString().startsWith('sig:'))
      return 'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:' + (calls[0].functionCall?.name ?? '') + '` , position 1.';
  }
  return null;
}

function stepsFor(scenario, text) {
  for (const t of scenario.turns ?? []) {
    try {
      if (!t.match || new RegExp(t.match, 'i').test(text)) return t.steps ?? [];
    } catch {
      // 잘못된 정규식은 건너뜀
    }
  }
  return scenario.default ?? DEFAULT_SCENARIO.default;
}

function fill(s, results) {
  if (typeof s !== 'string') return s;
  const r = results[0];
  const v = r ? String(r.response?.output ?? r.response?.error ?? '') : '';
  return s.replace(/\{\{RESULT\}\}/g, v.slice(0, 400));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(obj));
}

function loadScenario(s) {
  if (!s) return DEFAULT_SCENARIO;
  if (typeof s === 'object') return s;
  const txt = String(s).trim();
  if (txt.startsWith('{')) return JSON.parse(txt);
  return JSON.parse(fs.readFileSync(txt, 'utf8'));
}

/**
 * @param {{ port?: number, apiKey?: string, token?: string, scenario?: object|string, delayMs?: number }} [opts]
 */
export async function startFakeGemini(opts = {}) {
  const state = {
    apiKey: opts.apiKey ?? FAKE_GEMINI_KEY,
    token: opts.token ?? FAKE_VERTEX_TOKEN,
    scenario: loadScenario(opts.scenario),
    delayMs: opts.delayMs ?? 5,
    /** 받은 요청 (키·토큰은 남기지 않음) */
    requests: [],
    /** 단위 시험: (요청 본문, 정보) → 응답 단계 또는 null(시나리오) */
    handler: null,
    /** 오류 횟수 세기 (error.times) */
    errorCounts: new Map(),
    /** 응답 사이에 멈추는 약속 (중지 시험) */
    gate: null,
  };
  let sigN = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, errorBody(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.'));
    }
    const vertex = url.pathname.startsWith('/v1/projects/');
    state.requests.push({ method: req.method, path: url.pathname, vertex, body, apiKeyOk: req.headers['x-goog-api-key'] === state.apiKey, bearerOk: req.headers.authorization === `Bearer ${state.token}` });

    // 인증
    if (vertex) {
      if (req.headers.authorization !== `Bearer ${state.token}`)
        return sendJson(res, 401, errorBody(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.'));
    } else if (req.headers['x-goog-api-key'] !== state.apiKey) {
      return sendJson(
        res,
        400,
        errorBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', {
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
        }),
      );
    }

    if (req.method === 'GET' && /\/v1beta\/models$/.test(url.pathname)) return sendJson(res, 200, { models: MODELS });
    const m = /\/models\/([^/:]+):(countTokens|streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, errorBody(404, 'NOT_FOUND', `Not found: ${url.pathname}`));
    const model = decodeURIComponent(m[1]);
    if (!MODELS.some((x) => x.name === `models/${model}`)) return sendJson(res, 404, errorBody(404, 'NOT_FOUND', `models/${model} is not found for API version v1beta, or is not supported for generateContent.`));
    if (m[2] === 'countTokens') return sendJson(res, 200, { totalTokens: 1 });

    const contents = Array.isArray(body.contents) ? body.contents : [];
    const bad = checkSignatures(contents);
    if (bad) return sendJson(res, 400, errorBody(400, 'INVALID_ARGUMENT', bad));
    const pos = position(contents);
    let step = state.handler ? state.handler(body, { model, vertex, ...pos }) : null;
    if (!step) {
      const steps = stepsFor(state.scenario, pos.text);
      step = steps[Math.min(pos.step, steps.length - 1)] ?? { say: 'OK' };
    }
    if (state.gate) await state.gate;
    if (step.error) {
      const key = `${pos.text}|${pos.step}|${step.error.status}`;
      const n = (state.errorCounts.get(key) ?? 0) + 1;
      state.errorCounts.set(key, n);
      if (!step.error.times || n <= step.error.times) {
        const e = step.error;
        return sendJson(res, e.status, errorBody(e.status, e.statusText ?? 'UNAVAILABLE', e.message ?? 'The model is overloaded. Please try again later.', e.details ? { details: e.details } : {}));
      }
    }
    if (step.blocked) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ promptFeedback: { blockReason: step.blocked } })}\r\n\r\n`);
      return;
    }

    // SSE: 글을 몇 조각으로 나눠 보내고, 도구 호출은 마지막 조각에 (첫 호출에 서명)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const text = fill(step.say ?? '', pos.results);
    const n = Math.max(1, Math.min(step.chunks ?? 3, text.length || 1));
    const size = Math.ceil(text.length / n) || 1;
    const pieces = [];
    for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    const calls = (step.calls ?? []).map((c, i) => ({
      functionCall: { name: c.name, args: Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) => [k, fill(v, pos.results)])) },
      ...(i === 0 ? { thoughtSignature: sig(model, ++sigN) } : {}),
    }));
    const finish = step.finish ?? 'STOP';
    const frames = pieces.map((p) => ({ candidates: [{ content: { role: 'model', parts: [{ text: p }] }, index: 0 }], modelVersion: model }));
    if (calls.length) frames.push({ candidates: [{ content: { role: 'model', parts: calls }, index: 0 }], modelVersion: model });
    // 글만 있는 답의 마지막에 빈 글 + 서명 (실제 Gemini처럼)
    if (!calls.length) frames.push({ candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: sig(model, ++sigN) }] }, finishReason: finish, index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, modelVersion: model });
    else frames[frames.length - 1].candidates[0].finishReason = finish;
    let closed = false;
    res.on('close', () => (closed = true));
    for (const f of frames) {
      if (closed) return;
      res.write(`data: ${JSON.stringify(f)}\r\n\r\n`);
      if (step.cut) {
        res.destroy();
        return;
      }
      await new Promise((r) => setTimeout(r, step.delayMs ?? state.delayMs));
    }
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
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// 따로 띄우기 (E2E): node test/fake-ai/fake-gemini.mjs [포트]  → 첫 줄에 주소를 찍는다
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fake-gemini.mjs')) {
  const port = Number(process.argv[2] || 0);
  const s = await startFakeGemini({ port, scenario: process.env.PA_FAKE_GEMINI_SCENARIO });
  console.log(s.url);
}
