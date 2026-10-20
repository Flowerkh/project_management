// 앱이 만든 파일·명령 도구 (ai/fstools.ts) — Gemini처럼 자기 도구가 없는 AI가 쓴다
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Aborted } from '../src/desktop/ai/agent-query';
import { globToRegExp, runFsTool } from '../src/desktop/ai/fstools';

let tmp: string;
let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal, platform: 'linux' as NodeJS.Platform });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-fstools-'));
  cwd = path.join(tmp, 'work');
  const w = (rel: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  };
  w('src/main/java/egov/OrderServiceImpl.java', 'package egov;\n\npublic class OrderServiceImpl {\n    void updateStat() {\n        insertOrderHist();\n    }\n}\n');
  w('src/main/resources/mapper/OrderMapper.xml', '<mapper>\n  <insert id="insertOrderHist">INSERT INTO ORDER_HIST</insert>\n</mapper>\n');
  w('src/main/resources/globals.properties', 'Globals.Password=****\ninsertOrderHist=secret-looking\n');
  w('node_modules/lib/index.js', 'insertOrderHist();\n');
  w('web/a.ts', 'export const a = 1;\n');
  w('web/b.js', 'export const b = 2;\n');
  w('crlf.txt', 'line1\r\nline2\r\nline3\r\n');
  w('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('하나\n둘\n', 'utf8')]));
  w('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
  w('empty.txt', '');
  w('long.txt', Array.from({ length: 2500 }, (_, i) => `줄 ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('glob 패턴 → 정규식', () => {
  const re = (g: string) => globToRegExp(g);
  assert.ok(re('**/*.java').test('src/main/java/A.java'));
  assert.ok(re('**/*.java').test('A.java'));
  assert.ok(!re('*.java').test('src/A.java'));
  assert.ok(re('src/**/Order*.xml').test('src/main/resources/mapper/OrderMapper.xml'));
  assert.ok(re('src/**/Order*.xml').test('src/OrderMapper.xml'));
  assert.ok(re('web/*.{js,ts}').test('web/a.ts') && re('web/*.{js,ts}').test('web/b.js'));
  assert.ok(!re('web/*.{js,ts}').test('web/c.tsx'));
  assert.ok(re('[!a]*.txt').test('bom.txt') && !re('[!a]*.txt').test('a.txt'));
  assert.ok(re('src/**').test('src/x/y.z'));
  assert.ok(re('a+b(1).txt').test('a+b(1).txt'));
  assert.ok(globToRegExp('*.JAVA', true).test('a.java'));
});

test('Glob: 이름만 주면 모든 폴더에서, 접속 정보 파일·node_modules 제외', async () => {
  const r = await runFsTool('Glob', { pattern: '*.java' }, ctx());
  assert.equal(r.isError, false);
  assert.match(r.text, /src\/main\/java\/egov\/OrderServiceImpl\.java/);
  assert.deepEqual((r.structured as { numFiles: number }).numFiles, 1);
  const p = await runFsTool('Glob', { pattern: '*.properties' }, ctx());
  assert.equal((p.structured as { numFiles: number }).numFiles, 0);
  assert.match(p.text, /No files found/);
  const js = await runFsTool('Glob', { pattern: '**/*.js' }, ctx());
  assert.doesNotMatch(js.text, /node_modules/);
  // path를 직접 주면 그 안은 찾는다
  const nm = await runFsTool('Glob', { pattern: '*.js', path: 'node_modules' }, ctx());
  assert.match(nm.text, /node_modules\/lib\/index\.js/);
});

test('Grep: 줄·파일 목록·대소문자·파일 거르기, 접속 정보 파일 제외', async () => {
  const r = await runFsTool('Grep', { pattern: 'insertOrderHist', output_mode: 'content' }, ctx());
  assert.equal(r.isError, false);
  assert.match(r.text, /^Found 2 matches in 2 files/);
  assert.match(r.text, /src\/main\/java\/egov\/OrderServiceImpl\.java:5:\s+insertOrderHist\(\);/);
  assert.doesNotMatch(r.text, /globals\.properties|node_modules/);
  assert.deepEqual(r.structured, { mode: 'content', numFiles: 2, numMatches: 2 });
  const f = await runFsTool('Grep', { pattern: 'INSERTORDERHIST', '-i': true, output_mode: 'files_with_matches', glob: '*.xml' }, ctx());
  assert.match(f.text, /Found 1 files\nsrc\/main\/resources\/mapper\/OrderMapper\.xml/);
  const none = await runFsTool('Grep', { pattern: 'Password' }, ctx());
  assert.match(none.text, /No matches found/);
  const bad = await runFsTool('Grep', { pattern: '(' }, ctx());
  assert.equal(bad.isError, true);
  assert.match(bad.text, /정규식이 올바르지 않습니다/);
});

test('Read: 줄 번호·나눠 읽기·글자 파일 아님·빈 파일·BOM', async () => {
  const r = await runFsTool('Read', { file_path: 'src/main/java/egov/OrderServiceImpl.java' }, ctx());
  assert.match(r.text, /^ {5}1\tpackage egov;\n/);
  assert.match(r.text, / {5}5\t {8}insertOrderHist\(\);/);
  const long = await runFsTool('Read', { file_path: 'long.txt' }, ctx());
  assert.match(long.text, /2000\t줄 2000\n…\(long\.txt은\(는\) 2500줄 — 2000줄까지 보여 줌\. 이어서 보려면 offset 2001\)$/);
  const part = await runFsTool('Read', { file_path: 'long.txt', offset: 2400, limit: 2 }, ctx());
  assert.equal(part.text.split('\n')[0], '  2400\t줄 2400');
  assert.match(part.text, /2401\t줄 2401\n…/);
  const img = await runFsTool('Read', { file_path: 'img.png' }, ctx());
  assert.equal(img.isError, true);
  assert.match((await runFsTool('Read', { file_path: 'empty.txt' }, ctx())).text, /빈 파일/);
  assert.match((await runFsTool('Read', { file_path: 'bom.txt' }, ctx())).text, /^ {5}1\t하나\n/);
  assert.equal((await runFsTool('Read', { file_path: 'nope.txt' }, ctx())).isError, true);
});

test('Edit: 한 곳만·여러 곳(replace_all)·CRLF·BOM 유지', async () => {
  const one = await runFsTool('Edit', { file_path: 'src/main/java/egov/OrderServiceImpl.java', old_string: '        insertOrderHist();\n', new_string: '' }, ctx());
  assert.equal(one.isError, false, one.text);
  assert.deepEqual(one.structured, { structuredPatch: [{ newStart: 5 }] });
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'src/main/java/egov/OrderServiceImpl.java'), 'utf8'), /insertOrderHist/);
  const missing = await runFsTool('Edit', { file_path: 'web/a.ts', old_string: 'nothing', new_string: 'x' }, ctx());
  assert.match(missing.text, /찾지 못했습니다/);
  fs.writeFileSync(path.join(cwd, 'dup.txt'), 'a\na\n');
  const dup = await runFsTool('Edit', { file_path: 'dup.txt', old_string: 'a', new_string: 'b' }, ctx());
  assert.match(dup.text, /2곳 있습니다/);
  const all = await runFsTool('Edit', { file_path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true }, ctx());
  assert.equal(all.isError, false);
  assert.equal(fs.readFileSync(path.join(cwd, 'dup.txt'), 'utf8'), 'b\nb\n');
  const crlf = await runFsTool('Edit', { file_path: 'crlf.txt', old_string: 'line1\nline2', new_string: 'one\ntwo' }, ctx());
  assert.equal(crlf.isError, false, crlf.text);
  assert.equal(fs.readFileSync(path.join(cwd, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\nline3\r\n');
  await runFsTool('Edit', { file_path: 'bom.txt', old_string: '둘', new_string: '셋' }, ctx());
  const bom = fs.readFileSync(path.join(cwd, 'bom.txt'));
  assert.deepEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bom.subarray(3).toString('utf8'), '하나\n셋\n');
});

test('Write: 만들기·다시 쓰기, 작업 폴더 밖 거부', async () => {
  const c = await runFsTool('Write', { file_path: 'new/dir/Hello.java', content: 'class Hello {}\n' }, ctx());
  assert.deepEqual(c.structured, { type: 'create', structuredPatch: [{ newStart: 1 }] });
  const u = await runFsTool('Write', { file_path: 'new/dir/Hello.java', content: 'class Hello { }\n' }, ctx());
  assert.deepEqual(u.structured, { type: 'update', structuredPatch: [{ newStart: 1 }] });
  const out = await runFsTool('Write', { file_path: '../outside.txt', content: 'x' }, ctx());
  assert.equal(out.isError, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'outside.txt'), 'utf8'), 'outside');
  assert.equal((await runFsTool('Read', { file_path: path.join(tmp, 'outside.txt') }, ctx())).isError, true);
});

test('LS: 폴더 먼저, 접속 정보 파일 표시', async () => {
  const r = await runFsTool('LS', { path: 'src/main/resources' }, ctx());
  assert.match(r.text, /^src\/main\/resources — 폴더 1개 · 파일 1개\nmapper\/\nglobals\.properties {2}\(접속 정보 파일 — 읽을 수 없음\)$/);
});

test('Bash: 종료 코드·출력, 실패, 중지하면 끝냄', { skip: process.platform === 'win32' }, async () => {
  const r = await runFsTool('Bash', { command: 'echo hello && echo 오류 1>&2' }, ctx());
  assert.equal(r.isError, false);
  assert.match(r.text, /^종료 코드 0 \(\d+\.\d초\)\nhello\n오류$/);
  const f = await runFsTool('Bash', { command: 'exit 3' }, ctx());
  assert.equal(f.isError, true);
  assert.match(f.text, /^종료 코드 3/);
  const big = await runFsTool('Bash', { command: `node -e "for (let i=0;i<20000;i++) console.log('line '+i)"` }, ctx());
  assert.match(big.text, /(바이트|글자) 생략/);
  assert.match(big.text, /line 19999$/);
  const ac = new AbortController();
  const t0 = Date.now();
  const p = runFsTool('Bash', { command: 'sleep 20' }, { ...ctx(), signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(p, (e) => e instanceof Aborted);
  assert.ok(Date.now() - t0 < 5000);
  const slow = await runFsTool('Bash', { command: 'sleep 5' }, { ...ctx(), commandTimeoutMs: 300 });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /끝나지 않아 멈췄습니다/);
});
