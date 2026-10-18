// Claude CLI 찾기·버전 확인 (cli.ts) — 임시 폴더와 가짜 실행 파일(sh)로. 이 PC의 실제 claude는 찾지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { candidates, checkCandidate, cleanEnvForCli, compareVersions, discoverCli, MIN_CLI_VERSION, parseShim, parseVersion, resolveTarget, searchPath } from '../src/desktop/claude/cli';

let tmp: string;

function exe(p: string, body: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

// npm cmd-shim이 만드는 claude.cmd / claude.ps1 (npm 10)
const CMD_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r
`;
const PS1_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  & "node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args
  $ret=$LASTEXITCODE
}
exit $ret
`;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-c1-cli-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('버전 읽기·비교', () => {
  assert.equal(parseVersion('2.1.302 (Claude Code)\n'), '2.1.302');
  assert.equal(parseVersion('1.0.88 (Claude Code)'), '1.0.88');
  assert.equal(parseVersion('claude v2.1.0-beta.1'), '2.1.0');
  assert.equal(parseVersion('Claude Code'), null);
  assert.ok(compareVersions('2.1.302', MIN_CLI_VERSION) > 0);
  assert.ok(compareVersions('2.0.99', '2.1.0') < 0);
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0);
});

test('npm 실행 스크립트(claude.cmd·claude.ps1)에서 cli.js 찾기', () => {
  assert.deepEqual(parseShim(CMD_SHIM), { rel: 'node_modules/@anthropic-ai/claude-code/cli.js', nodeNextToShim: true });
  assert.deepEqual(parseShim(PS1_SHIM), { rel: 'node_modules/@anthropic-ai/claude-code/cli.js', nodeNextToShim: true });
  assert.equal(parseShim('@echo off\r\necho hello'), null);
  // 네이티브 실행 파일을 가리키는 스크립트 (claude.exe)
  assert.deepEqual(parseShim('"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'), { rel: 'node_modules/@anthropic-ai/claude-code/bin/claude.exe', nodeNextToShim: false });
});

test('Windows npm 설치 모양: claude.cmd → node + cli.js (옆에 node.exe가 있으면 그것)', () => {
  const dir = path.join(tmp, 'win-npm');
  fs.mkdirSync(path.join(dir, 'node_modules/@anthropic-ai/claude-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js'), '// cli');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), CMD_SHIM);
  fs.writeFileSync(path.join(dir, 'claude.ps1'), PS1_SHIM);
  const t = resolveTarget(path.join(dir, 'claude.cmd'), 'npm', 'win32')!;
  assert.equal(t.exec, path.join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js'));
  assert.equal(t.node, 'node');
  assert.equal(t.display, path.join(dir, 'claude.cmd'));
  assert.equal(resolveTarget(path.join(dir, 'claude.ps1'), 'path', 'win32')!.exec, t.exec);
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  assert.equal(resolveTarget(path.join(dir, 'claude.cmd'), 'npm', 'win32')!.node, path.join(dir, 'node.exe'));
  // cli.js가 없으면 대상 없음
  fs.writeFileSync(path.join(tmp, 'broken.cmd'), CMD_SHIM);
  assert.equal(resolveTarget(path.join(tmp, 'broken.cmd'), 'path', 'win32'), null);
});

test('찾는 순서: 설정 → PA_CLAUDE_CLI → (Windows) 네이티브 설치 → PATH → %APPDATA%\\npm', () => {
  const env = { USERPROFILE: 'C:\\Users\\hong', APPDATA: 'C:\\Users\\hong\\AppData\\Roaming', PATH: '' };
  const c = candidates({ cliPath: 'D:\\tools\\claude.exe', env, platform: 'win32', home: 'C:\\Users\\hong' });
  assert.deepEqual(
    c.map((x) => x.source),
    ['config', 'native', 'npm'],
  );
  assert.equal(c[1].path, path.join('C:\\Users\\hong', '.local', 'bin', 'claude.exe'));
  assert.equal(c[2].path, path.join('C:\\Users\\hong\\AppData\\Roaming', 'npm', 'claude.cmd'));
  assert.deepEqual(candidates({ cliPath: 'D:\\c.exe', env: { ...env, PA_CLAUDE_CLI: 'E:\\fake.mjs' }, platform: 'win32' }).map((x) => x.source), ['config', 'env']);
  // 리눅스(개발용): PATH → ~/.local/bin → ~/.claude/local
  const l = candidates({ env: { PATH: '' }, platform: 'linux', home: '/home/u' });
  assert.deepEqual(l.map((x) => x.path), ['/home/u/.local/bin/claude', '/home/u/.claude/local/claude']);
  // PA_CLAUDE_CLI를 주면 그것만, 시험 모드(PA_E2E)에서는 지정한 것만
  assert.deepEqual(candidates({ env: { PA_CLAUDE_CLI: '/x/fake', PATH: '' }, platform: 'linux', home: '/home/u' }).map((x) => x.source), ['env']);
  assert.deepEqual(candidates({ cliPath: '/c/claude', env: { PA_E2E: '1', PATH: '' }, platform: 'linux', home: '/home/u' }).map((x) => x.source), ['config']);
});

test('PATH 찾기 (where claude 와 같은 순서: 폴더마다 .exe → .cmd → .ps1)', () => {
  const a = path.join(tmp, 'pa');
  const b = path.join(tmp, 'pb');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'claude.cmd'), '');
  fs.writeFileSync(path.join(b, 'claude.exe'), '');
  fs.writeFileSync(path.join(a, 'claude.ps1'), '');
  assert.deepEqual(searchPath({ PATH: `${a};${b}` }, 'win32'), [path.join(a, 'claude.cmd'), path.join(a, 'claude.ps1'), path.join(b, 'claude.exe')]);
  exe(path.join(b, 'claude'), 'echo hi');
  assert.deepEqual(searchPath({ PATH: `${a}:${b}` }, 'linux'), [path.join(b, 'claude')]);
});

test('찾기·버전 확인: PATH의 가짜 CLI, 너무 오래된 버전은 missing, 실행 실패', async () => {
  const home = path.join(tmp, 'home1');
  const bin = path.join(tmp, 'bin1');
  exe(path.join(bin, 'claude'), 'echo "2.1.302 (Claude Code)"');
  const r = await discoverCli({ env: { PATH: bin }, platform: 'linux', home });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.version, '2.1.302');
    assert.equal(r.target.source, 'path');
    assert.equal(r.target.exec, path.join(bin, 'claude'));
    assert.equal(r.target.node, undefined);
  }
  // 너무 오래된 버전
  const old = exe(path.join(tmp, 'old', 'claude'), 'echo "1.0.88 (Claude Code)"');
  const o = await discoverCli({ cliPath: old, env: { PATH: bin }, platform: 'linux', home });
  assert.equal(o.ok, false);
  if (!o.ok) {
    assert.equal(o.reason, 'old');
    assert.equal(o.version, '1.0.88');
    assert.match(o.message, /너무 오래된 버전입니다\. 2\.1\.0 이상/);
  }
  // 직접 지정한 파일이 망가졌으면 다른 것을 몰래 쓰지 않는다
  const bad = exe(path.join(tmp, 'bad', 'claude'), 'echo "segfault" >&2; exit 3');
  const b = await discoverCli({ cliPath: bad, env: { PATH: bin }, platform: 'linux', home });
  assert.equal(b.ok, false);
  if (!b.ok) {
    assert.equal(b.reason, 'broken');
    assert.match(b.message, /segfault/);
  }
  // 직접 지정한 경로에 파일이 없으면 자동으로 찾은 것을 쓴다
  const n = await discoverCli({ cliPath: path.join(tmp, 'nope', 'claude.exe'), env: { PATH: bin }, platform: 'linux', home });
  assert.equal(n.ok, true);
  // 아무것도 없음
  const none = await discoverCli({ env: { PATH: path.join(tmp, 'empty') }, platform: 'linux', home });
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.reason, 'notfound');
    assert.match(none.message, /찾지 못했습니다/);
  }
  // 버전이 아닌 출력
  const weird = exe(path.join(tmp, 'weird', 'claude'), 'echo "hello"');
  const w = await checkCandidate(weird, 'config', { platform: 'linux' });
  assert.equal(w.ok, false);
  if (!w.ok) assert.equal(w.reason, 'broken');
});

test('~/.local/bin·~/.claude/local, 리눅스 npm 설치(심볼릭 링크 → cli.js는 node로)', async () => {
  const home = path.join(tmp, 'home2');
  exe(path.join(home, '.claude', 'local', 'claude'), 'echo "2.1.100 (Claude Code)"');
  const r = await discoverCli({ env: { PATH: '' }, platform: 'linux', home });
  assert.ok(r.ok && r.target.source === 'local' && r.version === '2.1.100');
  const pkg = path.join(tmp, 'lib/node_modules/@anthropic-ai/claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), "console.log('2.1.42 (Claude Code)')\n");
  const binDir = path.join(tmp, 'npmbin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(binDir, 'claude'));
  const t = resolveTarget(path.join(binDir, 'claude'), 'path', 'linux')!;
  assert.equal(t.exec, path.join(pkg, 'cli.js'));
  assert.equal(t.node, 'node');
  const v = await checkCandidate(path.join(binDir, 'claude'), 'path', { platform: 'linux' });
  assert.ok(v.ok && v.version === '2.1.42', JSON.stringify(v));
});

test('CLI에 넘기는 환경: 앱 내부 변수(PA_*)와 중첩 표시는 빼고 나머지는 그대로', () => {
  const e = cleanEnvForCli({ PATH: '/bin', PA_E2E: '1', PA_CLAUDE_CLI: '/x', PA_FAKE_SCENARIO: 's.json', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'k', HOME: '/h' });
  assert.deepEqual(e, { PATH: '/bin', PA_FAKE_SCENARIO: 's.json', ANTHROPIC_API_KEY: 'k', HOME: '/h' });
});
