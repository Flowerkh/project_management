// 실제 Claude Code CLI(/opt/claude-code/bin/claude)로 하는 짧은 확인 — 인증 없는 경로만.
// 이 개발 환경의 인증을 절대 쓰지 않도록:
//   - 환경 변수를 모두 비우고(PATH만) HOME·CLAUDE_CONFIG_DIR·TMPDIR을 임시 폴더로
//   - unshare -mn: 네트워크 없는 네임스페이스 + 마운트 네임스페이스에서 ~/.claude(잘 알려진 토큰 파일 위치)를 빈 tmpfs로 가림
//     (이 CLI는 HOME과 상관없이 /home/claude/.claude/remote/.oauth_token을 읽는다 — 가리지 않으면 실제 요청이 나감)
//   - 격리를 확인할 수 없으면 건너뜀
// 확인: SDK가 실제 CLI를 띄우고(initialize·훅·MCP 서버·플래그를 CLI가 받아들임) "Not logged in"을 인증 오류로 구분한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ChatItem, DesktopEvent } from '../src/shared/desktop-api';
import { setConfig } from '../src/desktop/claude/config';
import { claudeModule, register } from '../src/desktop/claude/index';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';

const REAL = '/opt/claude-code/bin/claude';
const HIDE = ['/home/claude/.claude', '/root/.claude'].filter((d) => fs.existsSync(d));
let tmp = '';
let skip: string | false = false;
const savedEnv = { ...process.env };
const events: DesktopEvent[] = [];

function isolationScript(inner: string): string {
  const mounts = HIDE.map((d) => `mount -t tmpfs none ${d} || exit 97`).join('; ');
  return `${mounts}${mounts ? '; ' : ''}${inner}`;
}

before(() => {
  if (process.platform !== 'linux' || !fs.existsSync(REAL)) {
    skip = '실제 CLI가 없음';
    return;
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-c1-real-'));
  // 격리 확인: 토큰 파일이 보이지 않고 네트워크 장치가 lo뿐(꺼짐)인지
  try {
    const out = execFileSync('unshare', ['-mn', 'sh', '-c', isolationScript('ls -A /home/claude/.claude 2>/dev/null | wc -l; cat /proc/net/dev | tail -n +3 | wc -l')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 10000 });
    const [visible, ifaces] = out.trim().split('\n').map((x) => Number(x.trim()));
    if (visible !== 0 || ifaces > 1) skip = `격리 확인 실패 (files=${visible}, ifaces=${ifaces})`;
  } catch (e) {
    skip = `unshare 사용 불가: ${(e as Error).message}`;
  }
  if (skip) return;
  const wrapper = path.join(tmp, 'claude-isolated');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec unshare -mn sh -c '${isolationScript(`exec ${REAL} "$@"`)}' claude-isolated "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  // 환경을 모두 비움 (CLAUDE*·ANTHROPIC*·프록시 변수 없음)
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, { PATH: '/usr/bin:/bin:/opt/node22/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TMPDIR: path.join(tmp, 't'), PA_CLAUDE_CLI: wrapper });
  fs.mkdirSync(process.env.TMPDIR!, { recursive: true });
  setHost(testHost(path.join(tmp, 'data'), { net: { ok: true, status: 404, ms: 1 } }));
  register({ authTimeoutMs: 60000 });
  addEventSink((e) => events.push(e));
});

after(async () => {
  if (tmp) {
    try {
      await claudeModule().manager.closeAll();
    } catch {
      // 등록 전
    }
  }
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  if (tmp) {
    // SDK는 닫은 뒤 2초 기다렸다가 CLI를 끝낸다. CLI가 끝나며 임시 HOME에 기록을 남기므로 그 뒤에 지운다
    await new Promise((r) => setTimeout(r, 3000));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('실제 CLI: 버전 확인 → 인증 시험 요청이 "인증 필요"로 구분됨 (인증·네트워크 없이)', { timeout: 90000 }, async (t) => {
  if (skip) return t.skip(skip);
  await setConfig({ enabled: true, authMode: 'login', shellAllow: [], aiSummary: false });
  const t0 = Date.now();
  const st = await call('claude.status', true);
  assert.ok(Date.now() - t0 < 60000);
  assert.match(st.version ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(st.checks?.cli.ok, true);
  assert.equal(st.state, 'login', JSON.stringify(st));
  assert.equal(st.code, 'auth');
  assert.match(st.checks?.auth.message ?? '', /Not logged in|login/i);
});

test('실제 CLI: 대화(스트리밍 입력·훅·projdb MCP·계획 모드·사용자 설정만)를 받아들이고 인증 오류 항목을 남김', { timeout: 90000 }, async (t) => {
  if (skip) return t.skip(skip);
  const conv = await call('claude.start', null, {});
  await call('claude.send', conv.id, '안녕');
  const t0 = Date.now();
  let err: Extract<ChatItem, { type: 'error' }> | undefined;
  while (!err && Date.now() - t0 < 60000) {
    for (const e of events) if (e.type === 'claude.item' && e.conversationId === conv.id && e.item.type === 'error') err = e.item;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(err, '오류 항목');
  assert.equal(err!.code, 'auth', err!.message);
  assert.match(err!.message, /Not logged in/);
  // CLI가 init을 보냈다 = 플래그·initialize를 받아들였다 (세션 ID 저장)
  const got = await call('claude.get', conv.id);
  assert.ok(got?.sessionId, 'sessionId from system/init');
});
