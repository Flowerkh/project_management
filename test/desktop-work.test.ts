// 작업 사본·변경 비교·적용·커밋·푸시·되돌리기 (실제 git·svn으로)
//   npx tsx --test test/desktop-work.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import iconv from 'iconv-lite';
import type { DesktopEvent, FileChange, HistoryEntry } from '../src/shared/desktop-api';
import { register as historyRegister } from '../src/desktop/history';
import { setHost, testHost } from '../src/desktop/host';
import { addEventSink, call } from '../src/desktop/ipc';
import { register as projectRegister } from '../src/desktop/project';
import { services } from '../src/desktop/services';
import { workDir } from '../src/desktop/store';
import { register as vcsRegister } from '../src/desktop/vcs/index';
import { convProvider, saveConv } from '../src/desktop/claude/conversations';
import { commitMessage } from '../src/desktop/work/commit';
import { cleanupOld, register as workRegister } from '../src/desktop/work/index';

let tmp = '';
const events: DesktopEvent[] = [];

function sh(cmd: string, args: string[], cwd: string, input?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const ORDER_JAVA = `package egov;

public class OrderServiceImpl {
    // 주문 상태 변경
    public void updateDlvyInfo(OrderVO vo) throws Exception {
        orderMapper.updateOrderDlvy(vo);
        if ("DLVY".equals(vo.getOrderStat())) {
            orderMapper.updateDlvyStat(vo);
        }
        orderMapper.insertOrderHist(vo);
    }

    public OrderVO selectOrder(String orderNo) throws Exception {
        OrderVO vo = orderMapper.selectOrder(orderNo);
        vo.setItems(orderMapper.selectOrderItemList(orderNo));
        return vo;
    }

    public void insertClaim(OrderClaimVO claimVO) throws Exception {
        orderClaimMapper.insertClaim(claimVO);
        OrderVO orderVO = orderMapper.selectOrder(claimVO.getOrderNo());
        orderService.updateDlvyInfo(orderVO);
    }
}
`;

const JSP_TEXT = '<%@ page contentType="text/html; charset=euc-kr" pageEncoding="euc-kr"%>\n<h2>반품·교환 목록</h2>\n<p>처리 상태</p>\n';
const DB_JAVA = 'public class DbUtil {\n    private String dbPassword = "s3cret!";\n    public int timeout() {\n        return 30;\n    }\n}\n';
const GLOBALS = 'Globals.Url = jdbc:oracle:thin:@db.example.local:1521:SHOP\nGlobals.UserName = shop_app\nGlobals.Password = s3cret!\n';

/** 시험 프로젝트: UTF-8·EUC-KR·접속 정보·값 가림·바이너리·제외 대상 */
function makeProject(dir: string, opts: { big?: boolean } = {}): void {
  write(path.join(dir, 'src/main/java/egov/OrderServiceImpl.java'), ORDER_JAVA);
  write(path.join(dir, 'src/main/java/egov/Old.java'), 'public class Old {}\n');
  write(path.join(dir, 'src/main/java/egov/DbUtil.java'), DB_JAVA);
  write(path.join(dir, 'src/main/webapp/WEB-INF/jsp/order/claim.jsp'), iconv.encode(JSP_TEXT, 'cp949'));
  write(path.join(dir, 'src/main/resources/egovProps/globals.properties'), GLOBALS);
  write(path.join(dir, 'README.md'), '# 쇼핑몰 관리자\n');
  write(path.join(dir, 'static/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 1, 2, 3]));
  write(path.join(dir, 'node_modules/lib/index.js'), 'module.exports = 1;\n');
  write(path.join(dir, 'target/classes/A.class'), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0]));
  write(path.join(dir, '.claude/settings.json'), '{"hooks":{}}\n');
  write(path.join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
  write(path.join(dir, '.gitignore'), 'node_modules/\ntarget/\n*.log\n.claude/\n');
  if (opts.big) write(path.join(dir, 'logs/big.log'), Buffer.alloc(21 * 1024 * 1024, 0x61));
  fs.symlinkSync('README.md', path.join(dir, 'link.md'));
}

function gitRepo(dir: string, opts: { identity?: boolean } = {}): void {
  sh('git', ['init', '-q', '-b', 'main'], dir);
  if (opts.identity !== false) {
    sh('git', ['config', 'user.name', 'Hong Gildong'], dir);
    sh('git', ['config', 'user.email', 'hong@example.com'], dir);
  }
  sh('git', ['config', 'commit.gpgsign', 'false'], dir);
}

function gitCommitAll(dir: string, msg: string): void {
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.com', 'commit', '-q', '-m', msg], dir);
}

function newDir(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function byPath(list: FileChange[]): Map<string, FileChange> {
  return new Map(list.map((c) => [c.path, c]));
}

async function entry(root: string, id: string): Promise<HistoryEntry> {
  const e = await services.history!.get(root, id);
  assert.ok(e, `기록 ${id}`);
  return e;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-v-work-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
  setHost(testHost(path.join(tmp, 'data'), { save: path.join(tmp, 'export.csv') }));
  projectRegister();
  historyRegister();
  vcsRegister();
  workRegister();
  addEventSink((ev) => events.push(ev));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('git: 사본 만들기 → 변경 → 적용·커밋·푸시 → 되돌리기', async () => {
  const remote = newDir('a-remote.git');
  sh('git', ['init', '-q', '--bare', '-b', 'main'], remote);
  const root = newDir('shop-admin');
  makeProject(root, { big: true });
  gitRepo(root);
  gitCommitAll(root, 'init');
  sh('git', ['remote', 'add', 'origin', remote], root);
  sh('git', ['push', '-q', '-u', 'origin', 'main'], root);
  // 사본을 만들 때 원본에 이미 있던 커밋 안 된 변경: README(수정)·docs/notes.txt(새 파일, Claude가 건드리지 않음)
  fs.appendFileSync(path.join(root, 'README.md'), '작업 중인 메모\n');
  write(path.join(root, 'docs/notes.txt'), '커밋하지 않은 메모\n');

  events.length = 0;
  const wc = await call('work.create', root, 'conv-1');
  assert.equal(wc.conversationId, 'conv-1');
  assert.equal(wc.base?.kind, 'git');
  assert.equal(wc.base?.branch, 'main');
  assert.match(wc.base?.head ?? '', /^[0-9a-f]{7,}$/);
  assert.equal(wc.base?.dirty, 2);
  assert.ok(wc.path.startsWith(workDir()), '사본은 앱 작업 폴더에');
  assert.match(path.basename(wc.path), /^shop-admin-[0-9a-f]+$/);
  const prog = events.filter((e) => e.type === 'work.progress');
  assert.ok(prog.length >= 2, '진행 이벤트');
  assert.match((prog[prog.length - 1] as { message?: string }).message ?? '', /작업 사본을 만들었습니다/);
  // 제외: .git·무거운 폴더·20MB 넘는 파일·심볼릭 링크·.claude·.mcp.json
  for (const p of ['.git', 'node_modules', 'target', 'logs/big.log', 'link.md', '.claude', '.mcp.json']) assert.ok(!fs.existsSync(path.join(wc.path, p)), `${p} 제외`);
  assert.equal(fs.readFileSync(path.join(wc.path, 'src/main/java/egov/OrderServiceImpl.java'), 'utf8'), ORDER_JAVA);
  assert.deepEqual(fs.readFileSync(path.join(wc.path, 'static/logo.png')), fs.readFileSync(path.join(root, 'static/logo.png')));
  // EUC-KR → 사본은 UTF-8
  assert.equal(fs.readFileSync(path.join(wc.path, 'src/main/webapp/WEB-INF/jsp/order/claim.jsp'), 'utf8'), JSP_TEXT);
  // 접속 정보·코드의 비밀 값은 가림
  const g = fs.readFileSync(path.join(wc.path, 'src/main/resources/egovProps/globals.properties'), 'utf8');
  assert.ok(!g.includes('s3cret!') && !g.includes('shop_app') && g.includes('****'), g);
  const dbu = fs.readFileSync(path.join(wc.path, 'src/main/java/egov/DbUtil.java'), 'utf8');
  assert.ok(!dbu.includes('s3cret!') && dbu.includes('"****"'), dbu);
  assert.ok((wc.redacted ?? 0) >= 2);
  assert.equal((await call('work.get', wc.id))?.id, wc.id);
  assert.deepEqual((await call('work.list', root)).map((w) => w.id), [wc.id]);
  assert.deepEqual(await call('work.changes', wc.id), []);

  // Claude가 사본에서 고친 것
  const P = (rel: string) => path.join(wc.path, rel);
  fs.writeFileSync(
    P('src/main/java/egov/OrderServiceImpl.java'),
    ORDER_JAVA.replace('        orderMapper.insertOrderHist(vo);\n', '').replace('        orderService.updateDlvyInfo(orderVO);\n', '        orderService.updateDlvyInfo(orderVO);\n        orderMapper.insertOrderHist(orderVO);\n'),
  );
  fs.writeFileSync(P('src/main/webapp/WEB-INF/jsp/order/claim.jsp'), JSP_TEXT.replace('처리 상태', '처리 상태(반품·교환)'));
  fs.writeFileSync(P('src/main/java/egov/DbUtil.java'), dbu.replace('return 30;', 'return 60;'));
  fs.writeFileSync(P('src/main/resources/egovProps/globals.properties'), g.replace('Globals.DbType', 'X') + 'Globals.Extra = 1\n');
  write(P('src/main/java/egov/NewUtil.java'), 'public class NewUtil {\n    public static String hello() {\n        return "안녕";\n    }\n}\n');
  fs.rmSync(P('src/main/java/egov/Old.java'));
  fs.appendFileSync(P('README.md'), '## 변경 이력\n');
  write(P('target/classes/B.class'), Buffer.from([1, 0, 2])); // 빌드 결과는 변경으로 보지 않음
  write(P('.claude/settings.local.json'), '{}');

  const ch = byPath(await call('work.changes', wc.id));
  assert.deepEqual([...ch.keys()].sort(), [
    'README.md',
    'src/main/java/egov/DbUtil.java',
    'src/main/java/egov/NewUtil.java',
    'src/main/java/egov/Old.java',
    'src/main/java/egov/OrderServiceImpl.java',
    'src/main/resources/egovProps/globals.properties',
    'src/main/webapp/WEB-INF/jsp/order/claim.jsp',
  ]);
  const order = ch.get('src/main/java/egov/OrderServiceImpl.java')!;
  assert.equal(order.status, 'modified');
  assert.equal(order.plus, 1);
  assert.equal(order.minus, 1);
  assert.equal(order.hunks.length, 2);
  assert.equal(order.hunks[0].fn, 'updateDlvyInfo()');
  assert.equal(order.hunks[1].fn, 'insertClaim()');
  const del = order.hunks[0].lines.find((l) => l.t === '-')!;
  assert.deepEqual([del.o, del.n, del.s.trim()], [10, undefined, 'orderMapper.insertOrderHist(vo);']);
  const add = order.hunks[1].lines.find((l) => l.t === '+')!;
  const newLines = fs.readFileSync(P('src/main/java/egov/OrderServiceImpl.java'), 'utf8').split('\n');
  assert.equal(add.n, newLines.indexOf('        orderMapper.insertOrderHist(orderVO);') + 1);
  assert.equal(order.hunks[1].lines[0].o! - order.hunks[1].lines[0].n!, 1, '왼쪽 원본·오른쪽 사본 번호');
  assert.ok(!order.conflict && !order.blocked && !order.dirtyBase);
  assert.equal(ch.get('src/main/webapp/WEB-INF/jsp/order/claim.jsp')!.encoding, 'EUC-KR');
  assert.ok(ch.get('src/main/java/egov/DbUtil.java')!.redacted);
  assert.ok(!ch.get('src/main/java/egov/DbUtil.java')!.blocked, '가린 값이 없는 줄을 고침 → 적용 가능');
  assert.match(ch.get('src/main/resources/egovProps/globals.properties')!.blocked ?? '', /접속 정보/);
  assert.equal(ch.get('src/main/java/egov/NewUtil.java')!.status, 'added');
  assert.equal(ch.get('src/main/java/egov/NewUtil.java')!.plus, 5);
  assert.equal(ch.get('src/main/java/egov/Old.java')!.status, 'deleted');
  assert.ok(ch.get('README.md')!.dirtyBase, '원래 커밋 안 된 변경이 있던 파일');
  assert.equal((await call('work.list', root))[0].changed, 7);

  // 차단된 파일을 넣으면 적용하지 않는다
  await assert.rejects(call('work.apply', wc.id, { files: ['src/main/resources/egovProps/globals.properties'], commit: false, push: false, title: 'x' }), /접속 정보/);

  const files = [...ch.values()].filter((c) => !c.blocked).map((c) => c.path);
  const res = await call('work.apply', wc.id, { files, commit: true, push: true, title: '주문 이력 중복 저장 수정', message: '주문 상태를 바꿀 때 주문 이력이 두 번 저장됨', conversationId: 'conv-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.commit?.ok, true, JSON.stringify(res.commit));
  assert.equal(res.push?.ok, true, JSON.stringify(res.push));
  assert.equal(res.applied.length, 6);
  // 원본 폴더에 반영
  assert.equal(fs.readFileSync(path.join(root, 'src/main/java/egov/OrderServiceImpl.java'), 'utf8'), fs.readFileSync(P('src/main/java/egov/OrderServiceImpl.java'), 'utf8'));
  const jsp = fs.readFileSync(path.join(root, 'src/main/webapp/WEB-INF/jsp/order/claim.jsp'));
  assert.equal(iconv.decode(jsp, 'cp949'), JSP_TEXT.replace('처리 상태', '처리 상태(반품·교환)'));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(jsp), 'EUC-KR로 저장');
  assert.equal(fs.readFileSync(path.join(root, 'src/main/java/egov/DbUtil.java'), 'utf8'), DB_JAVA.replace('return 30;', 'return 60;'), '가린 값은 원래 값으로');
  assert.equal(fs.readFileSync(path.join(root, 'src/main/resources/egovProps/globals.properties'), 'utf8'), GLOBALS, '접속 정보 파일은 그대로');
  assert.ok(fs.existsSync(path.join(root, 'src/main/java/egov/NewUtil.java')));
  assert.ok(!fs.existsSync(path.join(root, 'src/main/java/egov/Old.java')));
  // 커밋: 적용한 파일만 (docs/notes.txt 같은 다른 변경은 섞지 않음)
  const names = sh('git', ['show', '--name-only', '--format=%s', 'HEAD'], root).trim().split('\n');
  assert.equal(names[0], '주문 이력 중복 저장 수정 (Claude가 작성한 변경)');
  assert.deepEqual(names.slice(1).filter(Boolean).sort(), [...files].sort());
  assert.match(sh('git', ['log', '-1', '--format=%B'], root), /주문 상태를 바꿀 때 주문 이력이 두 번 저장됨/);
  assert.match(sh('git', ['status', '--porcelain'], root), /\?\? docs\//);
  assert.equal(sh('git', ['log', '-1', '--format=%s'], remote).trim(), names[0], '원격 저장소에 올라감');
  // 작업 이력
  const e = await entry(root, res.historyId!);
  assert.equal(e.kind, 'apply');
  assert.equal(e.status, '푸시됨');
  assert.equal(e.pushed, true);
  assert.equal(e.commit, sh('git', ['rev-parse', '--short', 'HEAD'], root).trim());
  assert.equal(e.vcs, 'git');
  assert.equal(e.branch, 'main');
  assert.equal(e.workId, wc.id);
  assert.equal(e.conversationId, 'conv-1');
  assert.deepEqual(e.steps?.map((s) => [s.label, s.ok]), [['적용', true], ['커밋', true], ['푸시', true]]);
  assert.ok(events.some((ev) => ev.type === 'history.added' && ev.entry.id === e.id));
  // 적용한 파일은 더 이상 변경이 아님 (차단된 접속 정보 파일만 남음)
  assert.deepEqual((await call('work.changes', wc.id)).map((c) => c.path), ['src/main/resources/egovProps/globals.properties']);
  // 변경 보기 (적용 전 ↔ 후)
  const d = byPath(await call('history.diff', root, e.id));
  assert.equal(d.get('src/main/java/egov/OrderServiceImpl.java')!.minus, 1);
  assert.equal(d.get('src/main/webapp/WEB-INF/jsp/order/claim.jsp')!.encoding, 'EUC-KR');
  assert.ok(d.get('src/main/webapp/WEB-INF/jsp/order/claim.jsp')!.hunks[0].lines.some((l) => l.t === '+' && l.s.includes('처리 상태(반품·교환)')));

  // 되돌리기 (+ 커밋)
  const rv = await call('history.revert', root, e.id, { commit: true });
  assert.equal(rv.ok, true, JSON.stringify(rv));
  assert.equal(fs.readFileSync(path.join(root, 'src/main/java/egov/OrderServiceImpl.java'), 'utf8'), ORDER_JAVA);
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/main/webapp/WEB-INF/jsp/order/claim.jsp')), iconv.encode(JSP_TEXT, 'cp949'));
  assert.equal(fs.readFileSync(path.join(root, 'src/main/java/egov/DbUtil.java'), 'utf8'), DB_JAVA);
  assert.ok(!fs.existsSync(path.join(root, 'src/main/java/egov/NewUtil.java')), '새 파일은 지움');
  assert.ok(fs.existsSync(path.join(root, 'src/main/java/egov/Old.java')), '지운 파일은 되살림');
  const rve = await entry(root, rv.historyId!);
  assert.equal(rve.kind, 'revert');
  assert.equal(rve.status, '되돌림');
  assert.equal(rve.revertOf, e.id);
  assert.ok(rve.commit, '되돌린 내용 커밋');
  assert.match(sh('git', ['log', '-1', '--format=%s'], root), /^되돌림: 주문 이력 중복 저장 수정/);
  assert.equal((await entry(root, e.id)).revertedBy, rve.id);
  // 이미 되돌린 기록은 다시 되돌리지 않음
  assert.equal((await call('history.revert', root, e.id, { commit: false })).ok, false);
  // 목록: 최근 것부터
  const list = await call('history.list', root);
  assert.deepEqual(list.slice(0, 2).map((x) => x.kind), ['revert', 'apply']);
  // 커밋 안 된 다른 변경은 그대로
  assert.match(sh('git', ['status', '--porcelain'], root), /\?\? docs\//);
});

test('git: 원본이 바뀌면 멈춤(MSG-31) → 다시 맞추기, 변경 버리기', { timeout: 60000 }, async () => {
  const root = newDir('conflict');
  makeProject(root);
  gitRepo(root);
  gitCommitAll(root, 'init');
  const wc = await call('work.create', root);
  const rel = 'src/main/java/egov/OrderServiceImpl.java';
  fs.writeFileSync(path.join(wc.path, rel), ORDER_JAVA.replace('// 주문 상태 변경', '// 주문 상태·배송 정보 변경'));
  // 그사이 원본도 바뀜
  fs.writeFileSync(path.join(root, rel), `${ORDER_JAVA}// 다른 사람이 고침\n`);
  const ch = await call('work.changes', wc.id);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].conflict, true);
  const res = await call('work.apply', wc.id, { files: [rel], commit: false, push: false, title: 't' });
  assert.equal(res.ok, false);
  assert.deepEqual(res.conflicts, [rel]);
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), `${ORDER_JAVA}// 다른 사람이 고침\n`, '원본은 그대로');
  assert.equal(res.historyId, undefined);
  // 다시 맞추기: 사본을 새 원본으로
  assert.deepEqual(await call('work.refresh', wc.id, [rel]), [rel]);
  assert.deepEqual(await call('work.changes', wc.id), []);
  assert.equal(fs.readFileSync(path.join(wc.path, rel), 'utf8'), `${ORDER_JAVA}// 다른 사람이 고침\n`);
  // 새 원본 기준으로 다시 고치면 적용됨 (커밋 안 함)
  fs.appendFileSync(path.join(wc.path, rel), '// Claude가 다시 맞춤\n');
  const ok = await call('work.apply', wc.id, { files: [rel], commit: false, push: false, title: '다시 맞춤' });
  assert.equal(ok.ok, true);
  assert.equal((await entry(root, ok.historyId!)).status, '적용됨');
  assert.match(fs.readFileSync(path.join(root, rel), 'utf8'), /Claude가 다시 맞춤/);
  // 적용하고 커밋하지 않은 파일 → 다음 적용 때 '원래 있던 변경' 표시
  fs.appendFileSync(path.join(wc.path, rel), '// 한 번 더\n');
  assert.equal((await call('work.changes', wc.id))[0].dirtyBase, true);

  // 변경 버리기: 사본을 원본으로 되돌림 (새 파일은 지움). 내용은 같고 시각만 바뀐 파일도 섞어 둔다
  const old = path.join(wc.path, 'src/main/java/egov/Old.java');
  fs.writeFileSync(old, fs.readFileSync(old));
  write(path.join(wc.path, 'src/main/java/egov/Temp.java'), 'class Temp {}\n');
  fs.writeFileSync(path.join(wc.path, 'src/main/java/egov/DbUtil.java'), 'broken');
  assert.equal((await call('work.changes', wc.id)).length, 3);
  const left = await call('work.discard', wc.id, ['src/main/java/egov/Temp.java']);
  assert.deepEqual(left.map((c) => c.path).sort(), ['src/main/java/egov/DbUtil.java', rel]);
  assert.ok(!fs.existsSync(path.join(wc.path, 'src/main/java/egov/Temp.java')));
  assert.deepEqual(await call('work.discard', wc.id), []);
  assert.match(fs.readFileSync(path.join(wc.path, 'src/main/java/egov/DbUtil.java'), 'utf8'), /"\*\*\*\*"/, '버린 뒤에도 값은 가림');
  assert.equal(fs.readFileSync(path.join(wc.path, rel), 'utf8'), fs.readFileSync(path.join(root, rel), 'utf8'));
});

test('변경 읽기와 적용이 겹쳐도 적용한 파일이 다시 변경으로 보이지 않음', { timeout: 60000 }, async () => {
  const root = newDir('race');
  makeProject(root);
  gitRepo(root);
  gitCommitAll(root, 'init');
  const wc = await call('work.create', root);
  for (let i = 0; i < 3; i++) {
    const same = path.join(wc.path, 'README.md');
    fs.writeFileSync(same, fs.readFileSync(same)); // 내용은 같고 시각만 바뀜
    const rel = `src/main/java/egov/Race${i}.java`;
    write(path.join(wc.path, rel), `class Race${i} {}\n`);
    const [, res] = await Promise.all([call('work.changes', wc.id), call('work.apply', wc.id, { files: [rel], commit: false, push: false, title: `race ${i}` })]);
    assert.equal(res.ok, true);
    assert.deepEqual(await call('work.changes', wc.id), [], `회차 ${i}`);
  }
});

test('git: 적용한 뒤 같은 파일이 또 바뀌면 되돌리기 불가(MSG-40)', async () => {
  const root = newDir('blocked');
  makeProject(root);
  gitRepo(root);
  gitCommitAll(root, 'init');
  const wc = await call('work.create', root);
  const rel = 'README.md';
  fs.appendFileSync(path.join(wc.path, rel), '추가한 줄\n');
  const res = await call('work.apply', wc.id, { files: [rel], commit: false, push: false, title: 'README' });
  assert.equal(res.ok, true);
  fs.appendFileSync(path.join(root, rel), '그 뒤에 사용자가 고침\n');
  const rv = await call('history.revert', root, res.historyId!, { commit: false });
  assert.equal(rv.ok, false);
  assert.deepEqual(rv.blocked, [rel]);
  assert.match(fs.readFileSync(path.join(root, rel), 'utf8'), /그 뒤에 사용자가 고침/, '원본은 그대로');
  const drift = await call('history.drift', root, res.historyId!);
  assert.equal(drift.length, 1);
  assert.ok(drift[0].hunks[0].lines.some((l) => l.t === '+' && l.s === '그 뒤에 사용자가 고침'));
});

test('git: 커밋 실패(사용자 정보 없음) → 기록에 MSG-25 → 다시 시도', async () => {
  const root = newDir('nouser');
  makeProject(root);
  gitRepo(root, { identity: false });
  gitCommitAll(root, 'init');
  sh('git', ['config', 'user.useConfigOnly', 'true'], root);
  const wc = await call('work.create', root);
  fs.appendFileSync(path.join(wc.path, 'README.md'), '줄 추가\n');
  const res = await call('work.apply', wc.id, { files: ['README.md'], commit: true, push: false, title: 'README 보강' });
  assert.equal(res.ok, true);
  assert.equal(res.commit?.ok, false);
  assert.ok(res.commit?.error);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /줄 추가/, '파일은 적용된 채로');
  const e = await entry(root, res.historyId!);
  assert.equal(e.status, '적용됨');
  assert.match(e.error ?? '', /^Git 커밋에 실패했습니다: .+ 파일은 적용된 상태로 남아 있습니다/);
  assert.deepEqual(e.steps?.map((s) => [s.label, s.ok]), [['적용', true], ['커밋', false]]);
  assert.deepEqual(e.want, { commit: true, push: false });
  // 사용자 정보를 넣고 다시 시도
  sh('git', ['config', 'user.name', 'Hong Gildong'], root);
  sh('git', ['config', 'user.email', 'hong@example.com'], root);
  const after = await call('history.retry', root, e.id);
  assert.equal(after?.status, '커밋됨');
  assert.equal(after?.error, undefined);
  assert.equal(after?.commit, sh('git', ['rev-parse', '--short', 'HEAD'], root).trim());
  assert.deepEqual(after?.steps?.map((s) => [s.label, s.ok]), [['적용', true], ['커밋', false], ['커밋 (다시 시도)', true]]);
  assert.equal(sh('git', ['log', '-1', '--format=%s'], root).trim(), 'README 보강 (Claude가 작성한 변경)');
  assert.ok((await call('history.list', root)).some((x) => x.kind === 'commit' && x.status === '커밋됨'), '다시 시도한 커밋도 기록');
  // 푸시는 원하지 않았으므로 더 할 것이 없음
  assert.equal((await call('history.retry', root, e.id))?.status, '커밋됨');
});

test('다른 AI의 변경: 커밋 표시·기록에 그 AI (Gemini가 작성한 변경), 다시 시도도 같게', async () => {
  const root = newDir('gemini-change');
  makeProject(root);
  gitRepo(root, { identity: false });
  gitCommitAll(root, 'init');
  sh('git', ['config', 'user.useConfigOnly', 'true'], root);
  // Gemini 대화 (대화 저장 파일만 — 실제 Gemini는 부르지 않음)
  const convId = 'cgeminitest01';
  const now = new Date().toISOString();
  await saveConv({ id: convId, provider: 'gemini', root, kind: 'issue', title: '주문 이력', createdAt: now, updatedAt: now, mode: 'edit', items: [], running: false, cwd: root });
  assert.equal(await convProvider(convId), 'gemini');
  assert.equal(await convProvider('cnotfound01'), undefined, '없는 대화');
  assert.equal(await convProvider('../x'), undefined, '잘못된 ID');
  const wc = await call('work.create', root, convId);
  fs.appendFileSync(path.join(wc.path, 'README.md'), 'Gemini가 고친 줄\n');
  const res = await call('work.apply', wc.id, { files: ['README.md'], commit: true, push: false, title: '' });
  assert.equal(res.ok, true);
  assert.equal(res.commit?.ok, false, '사용자 정보가 없어 커밋 실패');
  const e = await entry(root, res.historyId!);
  assert.equal(e.ai, 'gemini', '기록에 변경을 만든 AI');
  assert.equal(e.title, 'Gemini가 고친 코드', '제목이 없으면 그 AI 이름으로');
  sh('git', ['config', 'user.name', 'Hong Gildong'], root);
  sh('git', ['config', 'user.email', 'hong@example.com'], root);
  const again = await call('history.retry', root, e.id);
  assert.equal(again?.status, '커밋됨');
  assert.equal(sh('git', ['log', '-1', '--format=%s'], root).trim(), 'Gemini가 고친 코드 (Gemini가 작성한 변경)');
  const commitEntry = (await call('history.list', root)).find((x) => x.kind === 'commit');
  assert.equal(commitEntry?.ai, 'gemini', '다시 시도한 커밋 기록에도');
  // 되돌린 기록에도 그 변경을 만든 AI
  const rv = await call('history.revert', root, e.id, { commit: false });
  assert.equal(rv.ok, true, JSON.stringify(rv));
  assert.equal((await entry(root, rv.historyId!)).ai, 'gemini');
  // 이미 표시가 있는 제목은 그대로, 모르는 AI는 예전처럼 Claude
  assert.equal(commitMessage('수정 (ChatGPT가 작성한 변경)', undefined, 'Gemini').subject, '수정 (ChatGPT가 작성한 변경)');
  assert.equal(commitMessage('수정', undefined, 'ChatGPT').subject, '수정 (ChatGPT가 작성한 변경)');
  assert.equal(commitMessage('수정').subject, '수정 (Claude가 작성한 변경)');
});

test('svn: 사본 → 적용 → 커밋(서버 반영), 새 폴더·지운 파일 포함', async () => {
  const repo = newDir('svn-repo');
  sh('svnadmin', ['create', repo], tmp);
  const url = `file://${repo}`;
  sh('svn', ['mkdir', '--non-interactive', '-m', 'trunk', `${url}/trunk`], tmp);
  const root = path.join(tmp, 'svn-wc');
  sh('svn', ['checkout', '-q', '--non-interactive', `${url}/trunk`, root], tmp);
  makeProject(root);
  fs.rmSync(path.join(root, 'link.md'));
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fs.rmSync(path.join(root, 'target'), { recursive: true });
  sh('svn', ['add', '-q', '--force', '.'], root);
  sh('svn', ['commit', '-q', '--non-interactive', '-m', 'init'], root);
  sh('svn', ['update', '-q', '--non-interactive'], root);
  // 커밋 안 된 변경: DbUtil(수정, Claude도 고침) · Old.java(수정, Claude는 안 고침)
  fs.appendFileSync(path.join(root, 'src/main/java/egov/DbUtil.java'), '// 작업 중\n');
  fs.appendFileSync(path.join(root, 'src/main/java/egov/Old.java'), '// 작업 중\n');

  const info = await call('vcs.detect', root);
  assert.equal(info.kind, 'svn');
  assert.equal(info.branch, 'trunk');
  assert.equal(info.head, 'r2');
  assert.equal(info.remote, `${url}/trunk`);
  assert.equal(info.hostLabel, '로컬 저장소');
  assert.equal(info.dirty, 2);

  const wc = await call('work.create', root);
  assert.equal(wc.base?.kind, 'svn');
  assert.ok(!fs.existsSync(path.join(wc.path, '.svn')));
  const P = (rel: string) => path.join(wc.path, rel);
  fs.writeFileSync(P('src/main/java/egov/OrderServiceImpl.java'), ORDER_JAVA.replace('orderMapper.insertOrderHist(vo);', 'orderMapper.insertOrderHist(vo); // 한 번만'));
  fs.writeFileSync(P('src/main/java/egov/DbUtil.java'), fs.readFileSync(P('src/main/java/egov/DbUtil.java'), 'utf8').replace('return 30;', 'return 45;'));
  write(P('src/main/java/egov/claim/ClaimUtil.java'), 'public class ClaimUtil {}\n');
  fs.rmSync(P('README.md'));
  const ch = byPath(await call('work.changes', wc.id));
  assert.deepEqual([...ch.keys()].sort(), ['README.md', 'src/main/java/egov/DbUtil.java', 'src/main/java/egov/OrderServiceImpl.java', 'src/main/java/egov/claim/ClaimUtil.java']);
  assert.equal(ch.get('src/main/java/egov/DbUtil.java')!.dirtyBase, true);
  assert.ok(!ch.get('src/main/java/egov/OrderServiceImpl.java')!.dirtyBase);

  const res = await call('work.apply', wc.id, { files: [...ch.keys()], commit: true, push: true, title: '반품 처리 보강' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.commit?.ok, true, JSON.stringify(res.commit));
  assert.equal(res.commit?.hash, 'r3');
  assert.equal(res.push, undefined, 'SVN은 푸시 없음 (커밋이 곧 서버 반영)');
  const logXml = sh('svn', ['log', '--xml', '-v', '-r', '3', '--non-interactive', url], tmp);
  assert.match(logXml, /반품 처리 보강 \(Claude가 작성한 변경\)/);
  for (const p of ['/trunk/src/main/java/egov/claim', '/trunk/src/main/java/egov/claim/ClaimUtil.java', '/trunk/README.md', '/trunk/src/main/java/egov/DbUtil.java', '/trunk/src/main/java/egov/OrderServiceImpl.java']) {
    assert.ok(logXml.includes(`>${p}</path>`), `${p} 커밋`);
  }
  assert.ok(!logXml.includes('Old.java'), '다른 커밋 안 된 변경은 섞지 않음');
  const st = sh('svn', ['status', '--non-interactive'], root);
  assert.match(st, /^M\s+src\/main\/java\/egov\/Old\.java$/m);
  assert.ok(!/DbUtil|ClaimUtil|README/.test(st), st);
  assert.equal(fs.readFileSync(path.join(root, 'src/main/java/egov/DbUtil.java'), 'utf8'), `${DB_JAVA.replace('return 30;', 'return 45;')}// 작업 중\n`, '가린 값은 원래 값, 작업 중이던 줄도 그대로');
  const e = await entry(root, res.historyId!);
  assert.equal(e.status, '커밋됨');
  assert.equal(e.commit, 'r3');
  assert.equal(e.vcs, 'svn');
  assert.equal(e.want?.push, false);
});

test('형상관리 없음: 적용만 하고, 오래된 사본은 변경이 없을 때만 정리', async () => {
  const root = newDir('plain');
  write(path.join(root, 'a.txt'), 'hello\n');
  write(path.join(root, 'sub/b.txt'), 'world\n');
  assert.equal((await call('vcs.detect', root)).kind, 'none');
  const wc = await call('work.create', root);
  assert.equal(wc.base?.kind, 'none');
  fs.writeFileSync(path.join(wc.path, 'a.txt'), 'hello, 안녕\n');
  const res = await call('work.apply', wc.id, { files: ['a.txt'], commit: true, push: true, title: '인사말' });
  assert.equal(res.ok, true);
  assert.equal(res.commit, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello, 안녕\n');
  const e = await entry(root, res.historyId!);
  assert.equal(e.vcs, 'none');
  assert.equal(e.status, '적용됨');
  assert.deepEqual(e.want, { commit: false, push: false });

  // 정리: 40일 전 사본 2개 (하나는 적용 안 한 변경이 남음)
  const old = await call('work.create', root);
  fs.writeFileSync(path.join(old.path, 'sub/b.txt'), 'changed\n');
  const now = Date.now();
  const past = new Date(now - 40 * 86400000);
  for (const w of [wc, old]) {
    const mf = path.join(workDir(), `${w.id}.json`);
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.createdAt = past.toISOString();
    fs.writeFileSync(mf, JSON.stringify(m));
    fs.utimesSync(mf, past, past);
  }
  const orphan = path.join(workDir(), 'orphan-zzzzzz');
  fs.mkdirSync(orphan);
  fs.utimesSync(orphan, past, past);
  const r = await cleanupOld(now);
  assert.ok(r.removed.includes(wc.path), '변경 없는 오래된 사본은 지움');
  assert.ok(r.removed.includes(orphan), '기록 없는 폴더는 지움');
  assert.deepEqual(r.kept, [old.path], '변경이 남은 사본은 남김');
  assert.ok(!fs.existsSync(wc.path));
  assert.ok(fs.existsSync(old.path));
  assert.equal(await call('work.get', wc.id), null);
  assert.equal((await call('work.changes', old.id)).length, 1);
});

test('vcs: 원격 주소의 계정·토큰을 지우고 연결 확인 (MSG-35)', async () => {
  const root = newDir('remote-check');
  write(path.join(root, 'a.txt'), 'a\n');
  gitRepo(root);
  gitCommitAll(root, 'init');
  sh('git', ['remote', 'add', 'origin', 'https://hong.gd:glpat-abcdefghij@gitlab.company.local/shop/shop-admin.git'], root);
  sh('git', ['config', 'credential.helper', 'manager'], root);
  const info = await call('vcs.detect', root);
  assert.equal(info.remote, 'https://gitlab.company.local/shop/shop-admin.git');
  assert.equal(info.hostLabel, '사내 GitLab');
  assert.equal(info.branch, 'main');
  assert.equal(info.toolFound, true);
  // 연결 안 되는 주소 → MSG-35 (빨리 실패하도록 닫힌 포트)
  sh('git', ['remote', 'set-url', 'origin', 'https://hong.gd@127.0.0.1:9/shop.git'], root);
  const bad = await call('vcs.check', root);
  assert.equal(bad.remote?.ok, false);
  assert.match(bad.remote?.message ?? '', /^Git 원격 저장소에 연결하지 못했습니다\. PC의 Git·SVN 로그인과 서버 주소를 확인해 주세요\. 적용은 그대로 할 수 있습니다\. \(사유: /);
  assert.equal(bad.login, 'Git Credential Manager 로그인 hong.gd');
  assert.ok(bad.space.freeBytes > 0);
  // 연결되는 원격 (로컬 bare)
  const remote = newDir('remote-check.git');
  sh('git', ['init', '-q', '--bare', '-b', 'main'], remote);
  sh('git', ['remote', 'set-url', 'origin', remote], root);
  sh('git', ['push', '-q', '-u', 'origin', 'main'], root);
  const ok = await call('vcs.check', root);
  assert.deepEqual(ok.remote, { ok: true, message: '원격 저장소 연결됨' });
  assert.equal((await call('vcs.detect', root)).hostLabel, '로컬 저장소');
  // 형상관리 없는 폴더: 원격 확인 없음, 공간만
  const plain = newDir('remote-plain');
  const none = await call('vcs.check', plain);
  assert.equal(none.remote, undefined);
  assert.equal(typeof none.space.ok, 'boolean');
});
