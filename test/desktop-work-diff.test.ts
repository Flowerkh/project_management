// 변경 비교·인코딩·값 가림 되돌리기 (단위 시험)
//   npx tsx --test test/desktop-work-diff.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import { redactSecrets } from '../src/shared/secrets';
import { buildHunks, enclosingFn, fnOfLine, mergeRedacted } from '../src/desktop/work/diff';
import { copyText, decodeBytes, encForNewFile, encodeBack, toCopyBytes } from '../src/desktop/work/encoding';
import { stripCredentials, hostLabel, urlUser } from '../src/desktop/vcs/exec';
import { parsePorcelainZ } from '../src/desktop/vcs/git';
import { parseSvnStatus, svnBranch } from '../src/desktop/vcs/svn';
import { isDirtyPath } from '../src/desktop/vcs/types';
import { commitMessage } from '../src/desktop/work/commit';

test('함수 이름 찾기: Java·JS·PHP·Go·Python·MyBatis', () => {
  assert.equal(fnOfLine('    public void updateDlvyInfo(OrderVO vo) throws Exception {'), 'updateDlvyInfo()');
  assert.equal(fnOfLine('    @Override'), undefined);
  assert.equal(fnOfLine('    private List<Map<String, Object>> selectList(Map<String, Object> p) {'), 'selectList()');
  assert.equal(fnOfLine('        orderMapper.insertOrderHist(vo);'), undefined, '호출문');
  assert.equal(fnOfLine('        if ("DLVY".equals(vo.getOrderStat())) {'), undefined, '조건문');
  assert.equal(fnOfLine('        OrderVO orderVO = orderMapper.selectOrder(no);'), undefined, '대입');
  assert.equal(fnOfLine('        return orderDAO.selectOrder(vo);'), undefined);
  assert.equal(fnOfLine('    } catch (Exception e) {'), undefined);
  assert.equal(fnOfLine('function fn_save() {'), 'fn_save()');
  assert.equal(fnOfLine('const load = async (id) => {'), 'load()');
  assert.equal(fnOfLine('    public function store(Request $request)'), 'store()');
  assert.equal(fnOfLine('func (h *Handler) List(c *gin.Context) {'), 'List()');
  assert.equal(fnOfLine('def get_orders(request):'), 'get_orders()');
  assert.equal(fnOfLine('  <insert id="insertOrderHist" parameterType="orderVO">'), 'insertOrderHist');
  assert.equal(fnOfLine('CREATE OR REPLACE PROCEDURE SP_SETTLE_DAILY (p_dt IN VARCHAR2)'), 'SP_SETTLE_DAILY()');
  const lines = ['class A {', '  void a() {', '    x();', '  }', '}'];
  assert.equal(enclosingFn(lines, 2), 'a()');
  assert.equal(enclosingFn(lines, 0), undefined);
});

test('묶음: 앞뒤 3줄, 양쪽 줄 번호, CRLF 무시, 새 파일·지운 파일', () => {
  const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\r\n') + '\r\n';
  const neu = old.replace('line10\r\n', '').replace('line15', 'line15 changed');
  const h = buildHunks(old, neu.replace(/\r\n/g, '\n'));
  assert.equal(h.plus, 1);
  assert.equal(h.minus, 2);
  assert.equal(h.hunks.length, 1);
  const ln = h.hunks[0].lines;
  assert.deepEqual(ln[0], { t: ' ', s: 'line7', o: 7, n: 7 });
  assert.deepEqual(ln.find((l) => l.t === '-'), { t: '-', s: 'line10', o: 10 });
  assert.deepEqual(ln.find((l) => l.t === '+'), { t: '+', s: 'line15 changed', n: 14 });
  const added = buildHunks('', 'a\nb\n');
  assert.deepEqual(added.hunks[0].lines, [{ t: '+', s: 'a', n: 1 }, { t: '+', s: 'b', n: 2 }]);
  assert.equal(added.hunks[0].oldStart, 1);
  const removed = buildHunks('a\nb\n', '');
  assert.equal(removed.minus, 2);
  assert.deepEqual(removed.hunks[0].lines[1], { t: '-', s: 'b', o: 2 });
  assert.deepEqual(buildHunks('same\n', 'same\n').hunks, []);
});

test('인코딩: EUC-KR은 사본에 UTF-8, 되돌릴 때 CP949. 못 바꾸는 글자는 막음', () => {
  const text = '<%@ page pageEncoding="EUC-KR"%>\n<p>반품·교환 처리 뷁</p>\n';
  const buf = iconv.encode(text, 'cp949');
  const d = decodeBytes(buf, 'claim.jsp');
  assert.equal(d.enc, 'euckr');
  assert.equal(d.text, text);
  assert.equal(toCopyBytes(buf, d).toString('utf8'), text);
  assert.deepEqual(encodeBack(text, 'euckr').bytes, buf);
  const bad = encodeBack(`${text}이모지 😀\n`, 'euckr');
  assert.match(bad.error ?? '', /EUC-KR로 저장할 수 없는 글자 '😀'\(3번째 줄\)/);
  assert.equal(decodeBytes(Buffer.from('abc 가나', 'utf8')).enc, 'utf8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('가', 'utf8')]);
  assert.equal(decodeBytes(bom).enc, 'utf8bom');
  assert.deepEqual(encodeBack('가', 'utf8bom').bytes, bom);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('가나\r\n', 'utf16le')]);
  const d16 = decodeBytes(u16);
  assert.equal(d16.enc, 'utf16le');
  assert.equal(toCopyBytes(u16, d16).toString('utf8'), '가나\r\n');
  assert.deepEqual(encodeBack('가나\r\n', 'utf16le').bytes, u16);
  assert.equal(decodeBytes(Buffer.from([0x89, 0x50, 0, 1]), 'x.png').enc, 'binary');
  assert.equal(decodeBytes(Buffer.from([0xff, 0x00, 0x41]), 'x.txt').enc, 'binary');
  assert.equal(copyText(Buffer.from('가', 'utf8'), 'euckr'), '가');
  assert.equal(encForNewFile('<%@ page contentType="text/html; charset=euc-kr" %>'), 'euckr');
  assert.equal(encForNewFile('<?xml version="1.0" encoding="UTF-8"?>'), 'utf8');
});

test('값을 가린 파일: 바뀐 줄만 옮기고 가린 값은 원래 값으로', () => {
  const real = 'db.url=jdbc:oracle:thin:@prod-db:1521:SHOP\r\ndb.user=shop_app\r\ndb.password=Pa55!\r\npool.size=10\r\n';
  const red = redactSecrets(real, 'app.properties').text;
  assert.ok(red.includes('****') && !red.includes('Pa55!'));
  const copy = red.replace('pool.size=10', 'pool.size=20\r\npool.timeout=30');
  const merged = mergeRedacted(real, red, copy);
  assert.equal(merged, 'db.url=jdbc:oracle:thin:@prod-db:1521:SHOP\r\ndb.user=shop_app\r\ndb.password=Pa55!\r\npool.size=20\r\npool.timeout=30\r\n');
  // 줄 삭제도 옮긴다
  assert.equal(mergeRedacted(real, red, red.replace(/pool\.size=10\r\n/, '')), real.replace('pool.size=10\r\n', ''));
});

test('형상관리 도우미: 주소의 계정 지우기·표시 이름·상태 해석', () => {
  assert.equal(stripCredentials('https://hong:glpat-xyz@gitlab.company.local/a.git'), 'https://gitlab.company.local/a.git');
  assert.equal(stripCredentials('git@github.com:org/a.git'), 'git@github.com:org/a.git');
  assert.equal(stripCredentials('svn+ssh://hong@svn.corp/repo/trunk'), 'svn+ssh://svn.corp/repo/trunk');
  assert.equal(urlUser('https://hong.gd:secret@host/x.git'), 'hong.gd');
  assert.equal(urlUser('https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git'), undefined, '토큰은 이름으로 보이지 않음');
  assert.equal(urlUser('https://oauth2:tok@gitlab.com/x.git'), undefined);
  assert.equal(hostLabel('https://github.com/a/b.git', 'git'), 'GitHub');
  assert.equal(hostLabel('git@gitlab.com:a/b.git', 'git'), 'GitLab');
  assert.equal(hostLabel('https://gitlab.company.local/a.git', 'git'), '사내 GitLab');
  assert.equal(hostLabel('https://git.corp.kr/a.git', 'git'), '사내 Git 서버');
  assert.equal(hostLabel('https://svn.corp.kr/repo/trunk', 'svn'), '사내 SVN');
  assert.equal(hostLabel('C:\\repos\\a.git', 'git'), '로컬 저장소');
  const st = parsePorcelainZ(' M src/a.java\0?? docs/new.txt\0R  b.java\0old b.java\0');
  assert.deepEqual([...st.entries()], [['src/a.java', ' M'], ['docs/new.txt', '??'], ['b.java', 'R ']]);
  const svn = parseSvnStatus('<status><target path="."><entry path="src\\a.java"><wc-status props="none" item="modified" revision="2"></wc-status></entry><entry path="newdir"><wc-status item="unversioned" props="none"></wc-status></entry><entry path="p.xml"><wc-status item="normal" props="modified"></wc-status></entry><entry path="ign"><wc-status item="ignored" props="none"></wc-status></entry></target></status>');
  assert.deepEqual([...svn.entries()], [['src/a.java', 'modified'], ['newdir', 'unversioned'], ['p.xml', 'props-modified']]);
  assert.ok(isDirtyPath(svn, 'newdir/x/y.java'), '새 폴더 안 파일');
  assert.ok(!isDirtyPath(svn, 'src/b.java'));
  assert.equal(svnBranch('^/shop/branches/feature-x/src'), 'feature-x');
  assert.equal(svnBranch('^/trunk'), 'trunk');
  assert.deepEqual(commitMessage('주문 이력 중복 저장 수정', '이력이 두 번 저장됨'), {
    subject: '주문 이력 중복 저장 수정 (Claude가 작성한 변경)',
    full: '주문 이력 중복 저장 수정 (Claude가 작성한 변경)\n\n이력이 두 번 저장됨\n',
  });
});
