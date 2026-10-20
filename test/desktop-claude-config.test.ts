// Claude 설정·비밀 값·CLI 환경 변수·연결 상태 (config.ts, env.ts, status.ts) — testHost(base64 "암호화"), 네트워크 없음
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DesktopEvent } from '../src/shared/desktop-api';
import { getApiKey, getCloudEnv, getStored, SECRET_PLACEHOLDER } from '../src/desktop/claude/config';
import { buildCliEnv, delEnv, netCheckUrl, setEnv } from '../src/desktop/claude/env';
import { claudeModule, register } from '../src/desktop/claude/index';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { services } from '../src/desktop/services';
import { assistant, fakeQuery, init, result } from './fake-claude/fake-query';
import { fakeWork } from './fake-claude/services';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-claude', 'fake-claude.mjs');
const savedEnv = { ...process.env };
let tmp: string;
let dataDir: string;
let net: { ok: boolean; status?: number; ms: number; error?: string } = { ok: true, status: 404, ms: 3 };
const netCalls: { url: string; proxy?: string }[] = [];
let probe: 'ok' | 'auth' | 'billing' | 'hang' = 'ok';
const events: DesktopEvent[] = [];
const fq = fakeQuery(async (t) => {
  t.emit(init({ apiKeySource: t.options.env?.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none' }));
  if (probe === 'auth') {
    t.emit(assistant('e', [{ type: 'text', text: 'Not logged in · Please run /login' }], { error: 'authentication_failed' }));
    t.emit(result({ is_error: true, result: 'Not logged in · Please run /login' }));
  } else if (probe === 'billing') {
    t.emit(result({ is_error: true, result: 'Credit balance is too low' }));
  } else if (probe === 'hang') {
    await t.waitInterrupt(5000);
  } else {
    t.emit(assistant('m', [{ type: 'text', text: 'OK' }]));
    t.emit(result({ result: 'OK' }));
  }
});

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-c1-cfg-'));
  dataDir = path.join(tmp, 'data');
  setHost(
    testHost(dataDir, {
      net: (url, o) => {
        netCalls.push({ url, proxy: o?.proxy });
        return net;
      },
    }),
  );
  process.env.PA_CLAUDE_CLI = FAKE;
  process.env.PA_CLAUDE_NO_DISCOVERY = '1';
  services.work = fakeWork(path.join(tmp, 'work'));
  register({ queryFn: fq.queryFn, idleMs: 80, authTimeoutMs: 400 });
  addEventSink((e) => events.push(e));
});
after(async () => {
  await claudeModule().manager.closeAll();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function secretsFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
  } catch {
    return {};
  }
}

test('기본값과 저장: claude.json에는 비밀 값이 없다, API 키는 undefined면 유지·빈 문자열이면 삭제', async () => {
  const c0 = await call('claude.config.get');
  assert.deepEqual(c0, { enabled: false, authMode: 'login', hasApiKey: false, shellAllow: [], aiSummary: false });
  const c1 = await call('claude.config.set', { enabled: false, authMode: 'apikey', apiKey: 'sk-ant-api03-SECRET', shellAllow: ['mvn -q compile', ' mvn -q compile ', '', 'gradle test'], aiSummary: true, model: ' claude-sonnet-5 ' });
  assert.equal(c1.hasApiKey, true);
  assert.deepEqual(c1.shellAllow, ['mvn -q compile', 'gradle test']);
  assert.equal(c1.model, 'claude-sonnet-5');
  assert.equal((c1 as unknown as Record<string, unknown>).apiKey, undefined);
  const raw = fs.readFileSync(path.join(dataDir, 'claude.json'), 'utf8');
  assert.doesNotMatch(raw, /SECRET/);
  assert.ok(secretsFile()['claude:apikey']);
  assert.equal(await getApiKey(), 'sk-ant-api03-SECRET');
  // undefined → 그대로
  const c2 = await call('claude.config.set', { ...c1, apiKey: undefined });
  assert.equal(c2.hasApiKey, true);
  // '' → 지움
  const c3 = await call('claude.config.set', { ...c1, apiKey: '' });
  assert.equal(c3.hasApiKey, false);
  assert.equal(secretsFile()['claude:apikey'], undefined);
  await assert.rejects(call('claude.config.set', { ...c1, apiKey: 'sk ant' }), /공백/);
});

test('처음 켤 때 동의 시각(consentAt)을 남기고, 다시 켜도 처음 시각을 유지', async () => {
  const off = await call('claude.config.set', { enabled: false, authMode: 'login', shellAllow: [], aiSummary: false });
  assert.equal(off.consentAt, undefined);
  const on = await call('claude.config.set', { enabled: true, authMode: 'login', shellAllow: [], aiSummary: false, consentAt: '2000-01-01T00:00:00Z' });
  assert.ok(on.consentAt && on.consentAt !== '2000-01-01T00:00:00Z');
  await call('claude.config.set', { enabled: false, authMode: 'login', shellAllow: [], aiSummary: false });
  const again = await call('claude.config.set', { enabled: true, authMode: 'login', shellAllow: [], aiSummary: false });
  assert.equal(again.consentAt, on.consentAt);
});

test('회사 클라우드: 비밀 환경 변수는 비밀 값으로 (화면에는 ********), 프록시 계정도 가림', async () => {
  const c = await call('claude.config.set', {
    enabled: true,
    authMode: 'cloud',
    shellAllow: [],
    aiSummary: false,
    cloud: { provider: 'bedrock', env: { AWS_REGION: 'ap-northeast-2', AWS_ACCESS_KEY_ID: 'AKIA123', AWS_SECRET_ACCESS_KEY: 'wJalr/SECRET', 'bad name': 'x', PATH: '/evil', AWS_SESSION_TOKEN: '' } },
    proxy: 'http://hong:pa55w0rd@proxy.corp:8080',
  });
  assert.deepEqual(c.cloud, { provider: 'bedrock', env: { AWS_REGION: 'ap-northeast-2', AWS_ACCESS_KEY_ID: 'AKIA123', AWS_SECRET_ACCESS_KEY: SECRET_PLACEHOLDER } });
  assert.equal(c.proxy, 'http://****@proxy.corp:8080');
  const raw = fs.readFileSync(path.join(dataDir, 'claude.json'), 'utf8');
  assert.doesNotMatch(raw, /wJalr|pa55w0rd/);
  // 가린 값을 그대로 다시 보내면 유지
  const c2 = await call('claude.config.set', { ...c, cloud: c.cloud });
  assert.equal(c2.cloud!.env.AWS_SECRET_ACCESS_KEY, SECRET_PLACEHOLDER);
  assert.equal(c2.proxy, 'http://****@proxy.corp:8080');
  const stored = await getStored();
  assert.deepEqual(await getCloudEnv(stored), { AWS_REGION: 'ap-northeast-2', AWS_ACCESS_KEY_ID: 'AKIA123', AWS_SECRET_ACCESS_KEY: 'wJalr/SECRET' });
  const env = await buildCliEnv(stored, { base: { PATH: '/bin', CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_API_KEY: 'user-key', https_proxy: 'http://old:1' }, platform: 'linux' });
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'wJalr/SECRET');
  assert.equal(env.HTTPS_PROXY, 'http://hong:pa55w0rd@proxy.corp:8080');
  assert.equal(env.https_proxy, 'http://hong:pa55w0rd@proxy.corp:8080');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  // 비밀 값 지우기
  const c3 = await call('claude.config.set', { ...c2, cloud: { provider: 'bedrock', env: { AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: '' } }, proxy: 'http://proxy.corp:8080' });
  assert.deepEqual(c3.cloud!.env, { AWS_REGION: 'us-east-1' });
  assert.equal(c3.proxy, 'http://proxy.corp:8080');
  assert.deepEqual(Object.keys(secretsFile()).filter((k) => k.startsWith('claude:')), []);
  await assert.rejects(call('claude.config.set', { ...c3, proxy: 'proxy.corp:8080' }), /http:\/\//);
  await call('claude.config.set', { enabled: true, authMode: 'login', shellAllow: [], aiSummary: false });
});

test('CLI 환경: 로그인 방식은 앱 환경 그대로(인증 변수도 건드리지 않음), API 키 방식은 키 우선, Windows는 대소문자 무시', async () => {
  const base = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_USE_BEDROCK: '1', PA_E2E: '1', HOME: '/h' };
  const login = await buildCliEnv({ enabled: true, authMode: 'login', shellAllow: [], aiSummary: false }, { base, platform: 'linux', appVersion: '1.2.3' });
  assert.deepEqual(login, { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_USE_BEDROCK: '1', HOME: '/h', CLAUDE_AGENT_SDK_CLIENT_APP: 'project-analyzer/1.2.3' });
  await call('claude.config.set', { enabled: true, authMode: 'apikey', apiKey: 'sk-ant-x', shellAllow: [], aiSummary: false });
  const key = await buildCliEnv(await getStored(), { base, platform: 'linux' });
  assert.equal(key.ANTHROPIC_API_KEY, 'sk-ant-x');
  assert.equal(key.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(key.CLAUDE_CODE_USE_BEDROCK, undefined);
  const w: Record<string, string | undefined> = { Https_Proxy: 'a', anthropic_api_key: 'b' };
  setEnv(w, 'ANTHROPIC_API_KEY', 'c', 'win32');
  delEnv(w, 'HTTPS_PROXY', 'win32');
  assert.deepEqual(w, { ANTHROPIC_API_KEY: 'c' });
  const p: Record<string, string | undefined> = { https_proxy: 'a' };
  delEnv(p, 'HTTPS_PROXY', 'linux');
  assert.deepEqual(p, { https_proxy: 'a' });
  await call('claude.config.set', { enabled: true, authMode: 'login', apiKey: '', shellAllow: [], aiSummary: false });
});

test('인터넷 확인 주소: Anthropic / Bedrock 리전 / Vertex global·us·지역 / Foundry 리소스', () => {
  const cfg = (provider: 'bedrock' | 'vertex' | 'foundry') => ({ enabled: true, authMode: 'cloud' as const, shellAllow: [], aiSummary: false, cloud: { provider, env: {}, secretKeys: [] } });
  assert.equal(netCheckUrl({ enabled: true, authMode: 'login', shellAllow: [], aiSummary: false }, {}), 'https://api.anthropic.com/');
  assert.equal(netCheckUrl(cfg('bedrock'), { AWS_REGION: 'ap-northeast-2' }, {}), 'https://bedrock-runtime.ap-northeast-2.amazonaws.com/');
  assert.equal(netCheckUrl(cfg('bedrock'), {}, {}), 'https://bedrock-runtime.us-east-1.amazonaws.com/');
  assert.equal(netCheckUrl(cfg('bedrock'), { ANTHROPIC_BEDROCK_BASE_URL: 'https://gw.corp/bedrock' }, {}), 'https://gw.corp/bedrock');
  assert.equal(netCheckUrl(cfg('vertex'), { CLOUD_ML_REGION: 'global' }, {}), 'https://aiplatform.googleapis.com/');
  assert.equal(netCheckUrl(cfg('vertex'), { CLOUD_ML_REGION: 'eu' }, {}), 'https://aiplatform.eu.rep.googleapis.com/');
  assert.equal(netCheckUrl(cfg('vertex'), { CLOUD_ML_REGION: 'us-east5' }, {}), 'https://us-east5-aiplatform.googleapis.com/');
  assert.equal(netCheckUrl(cfg('foundry'), { ANTHROPIC_FOUNDRY_RESOURCE: 'my-res' }, {}), 'https://my-res.services.ai.azure.com/');
  assert.equal(netCheckUrl(cfg('foundry'), {}, {}), null);
});

test('연결 상태: 꺼짐(off) → [다시 확인]은 꺼져 있어도 CLI·인터넷·인증을 확인 → 켜면 on', async () => {
  await call('claude.config.set', { enabled: false, authMode: 'login', shellAllow: [], aiSummary: false });
  claudeModule().status.invalidate();
  const off = await call('claude.status');
  assert.equal(off.state, 'off');
  assert.equal(off.version, '2.1.302');
  const n0 = fq.calls.options.length;
  const full = await call('claude.status', true);
  assert.equal(full.state, 'on');
  assert.equal(full.checks!.cli!.ok, true);
  assert.equal(full.checks!.network.ok, true);
  assert.equal(full.checks!.auth.ok, true);
  assert.equal(typeof full.authMs, 'number');
  assert.equal(fq.calls.options.length, n0 + 1, '인증 시험 요청 1회');
  const o = fq.calls.options.at(-1)!;
  assert.deepEqual(o.tools, []);
  assert.equal(o.maxTurns, 1);
  assert.equal(o.persistSession, false);
  assert.deepEqual(o.settingSources, ['user']);
  assert.match(netCalls.at(-1)!.url, /api\.anthropic\.com/);
  // 꺼진 상태에서 보통 조회는 off (마지막 확인 결과는 들고 있음)
  const off2 = await call('claude.status');
  assert.equal(off2.state, 'off');
  assert.equal(off2.checks!.auth.ok, true);
  // 켜면 (10분 안에 확인했으므로 다시 묻지 않음)
  const n1 = fq.calls.options.length;
  await call('claude.config.set', { enabled: true, authMode: 'login', shellAllow: [], aiSummary: false });
  const on = await call('claude.status');
  assert.equal(on.state, 'on');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fq.calls.options.length, n1);
});

test('앱 시작(가벼운 확인)은 Claude에 요청하지 않고 저장한 인증 결과를 쓴다 / 인터넷 실패 → offline / CLI 없음 → missing', async () => {
  probe = 'auth';
  const bad = await call('claude.status', true);
  assert.equal(bad.state, 'login');
  assert.equal(bad.code, 'auth');
  assert.match(bad.message!, /Claude 인증에 실패했습니다/);
  assert.match(bad.checks!.auth.message!, /Not logged in/);
  probe = 'ok';
  // 앱 다시 시작 흉내: 메모리 상태를 버림 → 요청 없이 저장 결과
  claudeModule().status.invalidate();
  const n0 = fq.calls.options.length;
  const light = await call('claude.status');
  assert.equal(light.state, 'login');
  assert.equal(fq.calls.options.length, n0, '앱 시작 때는 시험 요청을 하지 않음');
  // 인터넷 안 됨
  net = { ok: false, ms: 4000, error: 'net::ERR_INTERNET_DISCONNECTED' };
  claudeModule().status.invalidate();
  const offline = await call('claude.status');
  assert.equal(offline.state, 'offline');
  assert.match(offline.checks!.network.message!, /ERR_INTERNET_DISCONNECTED/);
  const offlineFull = await call('claude.status', true);
  assert.equal(offlineFull.state, 'offline');
  assert.equal(offlineFull.checks!.auth.ok, null);
  net = { ok: true, status: 404, ms: 3 };
  // 결제 문제
  probe = 'billing';
  const billing = await call('claude.status', true);
  assert.equal(billing.state, 'login');
  assert.equal(billing.code, 'billing');
  assert.match(billing.message!, /결제 문제/);
  // 응답 없음 (시간 초과)
  probe = 'hang';
  const hang = await call('claude.status', true);
  assert.equal(hang.state, 'offline');
  assert.match(hang.checks!.auth.message!, /응답하지 않았습니다/);
  probe = 'ok';
  assert.equal((await call('claude.status', true)).state, 'on');
  // CLI 없음
  process.env.PA_CLAUDE_CLI = path.join(tmp, 'nope', 'claude');
  claudeModule().status.invalidate();
  const missing = await call('claude.status');
  assert.equal(missing.state, 'missing');
  assert.equal(missing.code, 'missing');
  assert.match(missing.message!, /Claude CLI를 찾지 못했습니다|파일이 없습니다/);
  process.env.PA_CLAUDE_CLI = FAKE;
  claudeModule().status.invalidate();
  assert.equal((await call('claude.status')).state, 'on');
  assert.ok(events.some((e) => e.type === 'claude.status' && e.status.state === 'missing'));
});

test('[경로 지정]: 고른 파일을 --version으로 확인하고 저장 (잘못된 파일은 오류)', async () => {
  const good = path.join(tmp, 'pick', 'claude');
  fs.mkdirSync(path.dirname(good), { recursive: true });
  fs.writeFileSync(good, '#!/bin/sh\necho "2.1.200 (Claude Code)"\n');
  fs.chmodSync(good, 0o755);
  const old = path.join(tmp, 'pick', 'old');
  fs.writeFileSync(old, '#!/bin/sh\necho "2.0.5 (Claude Code)"\n');
  fs.chmodSync(old, 0o755);
  setHost(testHost(dataDir, { file: good }));
  assert.equal(await call('claude.pickCli'), good);
  assert.equal((await call('claude.config.get')).cliPath, good);
  setHost(testHost(dataDir, { file: old }));
  await assert.rejects(call('claude.pickCli'), (e: Error & { code?: string }) => e.code === 'cli-old');
  setHost(testHost(dataDir, { file: null }));
  assert.equal(await call('claude.pickCli'), null);
  assert.equal(await call('claude.openLogin'), process.platform === 'win32');
  setHost(testHost(dataDir, { net: () => net }));
  await call('claude.config.set', { enabled: true, authMode: 'login', shellAllow: [], aiSummary: false });
});

test('쉬면(idle) Claude 프로세스를 닫고, 다음 메시지는 resume으로 다시 연다', async () => {
  const conv = await call('claude.start', path.join(here, '..', 'fixtures', 'shop-admin'), {});
  await call('claude.send', conv.id, '하나');
  await new Promise((r) => setTimeout(r, 60));
  const closed0 = fq.calls.closed;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(fq.calls.closed > closed0, 'idle close');
  assert.equal(claudeModule().manager._session(conv.id)!.hasQuery, false);
  await call('claude.send', conv.id, '둘');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fq.calls.options.at(-1)!.resume, '11111111-2222-4333-8444-555555555555');
});
