// 화면 점검 (v0.5): 상단 버전 · 프로젝트 이름 → 분석했던 프로젝트 목록 · 연결 아이콘 → 프로젝트 연결 ·
// 모델 목록(Claude Code)·기본 모델·대화 중 바꾸기 · 답변 표 좌우 스크롤 · 크게 보기 · 프로젝트를 따라가는 대화 · 대화 지우기·모두 지우기
//   node scripts/build-desktop.mjs --dev --out <scratch>/app
//   xvfb-run -a node scripts/e2e-ui.cjs <scratch>/app <scratch>/e2e-ui
// Claude는 가짜 CLI(test/fake-claude)로 흉내 낸다 (실제 Claude·계정을 쓰지 않음).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { _electron: electron } = require(path.join(ROOT, 'desktop/node_modules/playwright-core'));
const appDir = path.resolve(process.argv[2] || path.join(ROOT, 'desktop'));
const work = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'e2e-ui'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = path.join(work, 'shots');

function prepare() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const name of ['shop-admin', 'billing-admin']) {
    const dir = path.join(work, name);
    fs.cpSync(path.join(ROOT, 'fixtures/shop-admin'), dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  }
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const table = [
    '확인한 내용을 표로 정리했습니다.',
    '',
    '| 구분 | 근거 | 위치 |',
    '|---|---|---|',
    '| 사용 라이브러리 | `com.kcp:jPpcliE,com.kcp:Connection,KCP,kcp.kcpcert` | pom.xml:436-452 |',
    '| 문자 인코딩 | KCP 화면 주소(/com/kcp/order.do)와 결제 결과 수신 주소(/com/kcp/result.do)가 EUC-KR로 고정되어 있어 UTF-8 페이지에서 부르면 글자가 깨질 수 있습니다 | src/main/webapp/WEB-INF/web.xml:71-78, kcppay_order.jsp:148 |',
    '| 결제 모듈 | KCP 표준결제창(PayPlus) 연동, 승인 결과는 서버에서 다시 확인 | OrderController.java:120 |',
  ].join('\n');
  fs.writeFileSync(path.join(work, 'scenario.json'), JSON.stringify({ probe: [{ say: 'OK' }], turns: [{ steps: [{ say: table }] }], default: [{ say: '네, 확인했습니다.' }] }));
}

(async () => {
  prepare();
  const env = {
    PATH: `${path.join(work, 'bin')}:/usr/bin:/bin`,
    HOME: path.join(work, 'home'),
    DISPLAY: process.env.DISPLAY || '',
    XAUTHORITY: process.env.XAUTHORITY || '',
    LANG: 'ko_KR.UTF-8',
    PA_E2E: '1',
    PA_FAKE_NET: 'ok',
    PA_CLAUDE_CLI: path.join(ROOT, 'test/fake-claude/fake-claude.mjs'),
    PA_FAKE_STATE_DIR: path.join(work, 'fake-state'),
    PA_FAKE_SCENARIO: path.join(work, 'scenario.json'),
    PA_FAKE_LOG: path.join(work, 'fake.jsonl'),
    PA_FAKE_DELAY: '1',
  };
  const app = await electron.launch({ executablePath: require(path.join(ROOT, 'desktop/node_modules/electron')), args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(work, 'ud')}`], cwd: appDir, env });
  const pick = (dir) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, dir);
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1426, height: 883 });
  let n = 0;
  const shot = async (name) => win.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) });
  const analyze = async (dir, first) => {
    await pick(dir);
    if (first) await win.click('button:has-text("폴더 선택")');
    else await win.click('header button:has-text("폴더 열기")');
    await win.waitForSelector('text=불러오기 확인', { timeout: 30000 });
    await win.click('button:has-text("분석 시작")');
    await win.waitForSelector('text=분석 결과 요약', { timeout: 120000 });
    await sleep(500);
  };
  const A = path.join(work, 'shop-admin');
  const B = path.join(work, 'billing-admin');
  const out = {};
  try {
    await analyze(A, true);
    out.version = await win.locator('.brand-ver').innerText();
    await shot('header');
    // 2. Claude 연결: 모델 목록 → 기본 모델 Fake Opus → 연동 켜기
    await win.click('header button:has-text("Claude")');
    const dlg = win.locator('[role="dialog"][aria-label="Claude 연결"]');
    await dlg.waitFor();
    await win.waitForFunction(() => document.querySelectorAll('#cp-model option').length >= 4, null, { timeout: 30000 });
    out.modelOptions = await win.$$eval('#cp-model option', (os) => os.map((o) => o.textContent));
    await win.selectOption('#cp-model', 'fake-opus');
    await shot('pop03-model');
    await win.waitForSelector('button:has-text("연동 켜기"):not([disabled])', { timeout: 60000 });
    await win.click('button:has-text("연동 켜기")');
    await dlg.waitFor({ state: 'detached', timeout: 20000 });
    // 3. 대화: 입력창 아래 모델 = Fake Opus, 표가 있는 답
    await win.click('header button:has-text("Claude")');
    await win.waitForSelector('select.cp-model');
    await win.waitForFunction(() => document.querySelector('select.cp-model')?.selectedOptions[0]?.textContent === 'Fake Opus', null, { timeout: 20000 });
    await win.fill('textarea.cp-ta', 'KCP 결제 연동을 정리해 주세요');
    await win.press('textarea.cp-ta', 'Enter');
    await win.waitForSelector('.cp-md .tblw table', { timeout: 30000 });
    await win.waitForFunction(() => !document.querySelector('.cp-stop'), null, { timeout: 30000 });
    await sleep(400);
    out.table = await win.$eval('.cp-md .tblw', (w) => ({ scroll: w.scrollWidth > w.clientWidth, cellW: Math.min(...[...w.querySelectorAll('td')].map((td) => td.getBoundingClientRect().width)) }));
    out.argvModel = fs.readFileSync(env.PA_FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.ev === 'start' && !x.argv.includes('--max-turns=1')).map((x) => x.argv.find((a) => a.startsWith('--model=')) ?? '');
    await shot('chat-table');
    // 4. 모델 바꾸기 → 안내
    await win.selectOption('select.cp-model', 'fake-haiku');
    await win.waitForSelector('text=모델을 Fake Haiku(으)로 바꿨습니다', { timeout: 10000 });
    await shot('chat-model-switched');
    // 5. 크게 보기
    await win.click('button[aria-label="크게 보기"]');
    await sleep(400);
    out.expanded = await win.$eval('.cp-panel', (p) => { const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), fixed: getComputedStyle(p).position }; });
    await shot('chat-expanded');
    await win.keyboard.press('Escape');
    await sleep(300);
    out.collapsed = await win.$eval('.cp-panel', (p) => getComputedStyle(p).position);
    // 6. 다른 프로젝트 분석 → 패널이 그 프로젝트(새 대화)로
    await analyze(B, false);
    await sleep(600);
    out.afterSwitch = await win.$eval('.cp-title', (e) => e.textContent);
    await shot('project-b-panel');
    // 7. 프로젝트 이름 → 목록에서 A 고르기 → 패널은 A의 대화
    await win.click('button.proj-chip');
    await win.waitForSelector('.proj-pop');
    out.projList = await win.$$eval('.proj-item .nm', (e) => e.map((x) => x.textContent));
    await shot('project-popover');
    await win.click('.proj-item:has-text("shop-admin")');
    await win.waitForFunction(() => document.querySelector('.proj-chip .ellipsis')?.textContent === 'shop-admin', null, { timeout: 30000 });
    await win.waitForFunction(() => /KCP/.test(document.querySelector('.cp-title')?.textContent ?? ''), null, { timeout: 15000 });
    out.backToA = await win.$eval('.cp-title', (e) => e.textContent);
    out.modelBack = await win.$eval('select.cp-model', (s) => s.selectedOptions[0]?.textContent);
    await shot('project-a-back');
    // 8. 연결 아이콘 → 프로젝트 연결
    await win.click('button.proj-link');
    await win.waitForSelector('[role="dialog"][aria-label="프로젝트 연결"]');
    await shot('pop04-from-link');
    await win.keyboard.press('Escape');
    await sleep(300);
    // 9. 지금 대화 지우기 → 확인 → 새 대화
    await win.click('button[aria-label="이 대화 지우기"]');
    await win.waitForSelector('[role="dialog"]:has-text("대화 지우기")');
    await shot('delete-confirm');
    await win.click('.scrim .modal-foot button.danger');
    await win.waitForFunction(() => document.querySelector('.cp-title')?.textContent?.includes('새 대화'), null, { timeout: 10000 });
    // 10. 대화 기록 → 모두 지우기
    await win.fill('textarea.cp-ta', '하나 더');
    await win.press('textarea.cp-ta', 'Enter');
    await win.waitForFunction(() => !document.querySelector('.cp-stop') && document.querySelectorAll('.cp-msg').length > 0, null, { timeout: 30000 });
    await win.click('button[aria-label="대화 기록"]');
    await win.waitForSelector('.cp-pop-row');
    out.histRows = await win.$$eval('.cp-pop-row', (r) => r.length);
    await shot('history');
    await win.click('.cp-pop-f button:has-text("모두 지우기")');
    await win.waitForSelector('.scrim .modal:has-text("모두 지우기")');
    await shot('clear-confirm');
    await win.click('.scrim .modal-foot button.danger');
    await win.waitForSelector('.scrim', { state: 'detached' });
    await sleep(500);
    if (!(await win.$('.cp-pop'))) await win.click('button[aria-label="대화 기록"]');
    await win.waitForSelector('.cp-pop-empty', { timeout: 10000 });
    out.afterClear = await win.$eval('.cp-pop-empty', (e) => e.textContent);
    await shot('cleared');
  } catch (e) {
    await shot('FAIL').catch(() => {});
    console.error('E2E 실패:', e.message);
    console.log(JSON.stringify({ ...out, errors }, null, 1));
    await app.close().catch(() => {});
    process.exit(1);
  }
  console.log(JSON.stringify({ ...out, errors }, null, 1));
  await app.close();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  try {
    assert.equal(out.version, `v${pkg.version.replace(/\.0$/, '')}`);
    assert.ok(out.modelOptions.includes('Fake Opus') && out.modelOptions.includes('Fake Haiku'), '모델 목록');
    assert.ok(out.modelOptions[0].startsWith('Claude Code 기본값'));
    assert.ok(out.table.scroll && out.table.cellW >= 60, '표는 좌우 스크롤, 칸이 한 자 폭으로 줄지 않음');
    assert.ok(out.argvModel.some((a) => a.includes('fake-opus')), '기본 모델로 시작 (--model)');
    assert.equal(out.expanded.fixed, 'fixed');
    assert.ok(out.expanded.w >= 900, '크게 보기 폭');
    assert.equal(out.collapsed, 'relative');
    assert.match(out.afterSwitch, /billing-admin · 새 대화/);
    assert.deepEqual([...out.projList].sort(), ['billing-admin', 'shop-admin']);
    assert.match(out.backToA, /KCP/);
    assert.equal(out.modelBack, 'Fake Haiku', '대화에서 고른 모델을 기억');
    assert.match(out.afterClear, /대화가 아직 없습니다/);
    assert.deepEqual(errors, []);
  } catch (e) {
    console.error('E2E 확인 실패:', e.message);
    process.exit(2);
  }
  console.log('E2E OK');
})();
