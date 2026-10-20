// 화면 점검 (v0.5): 상단 버전 · 프로젝트 이름 → 분석했던 프로젝트 목록 · 연결 아이콘 → 프로젝트 연결 ·
// 모델 목록(Claude Code)·기본 모델·대화 중 바꾸기 · 답변 표 좌우 스크롤 · 크게 보기 · 프로젝트를 따라가는 대화 · 대화 지우기·모두 지우기
// (v0.5.1) 설정 > Claude 연결: 지금 계정 · 다른 계정으로 바꾸기([다시 확인]) · 대화창 톱니 · [저장] · 연동 끄기/켜기 ·
//          대화창 너비(왼쪽 가장자리)·크게 보기 양옆 크기 조절
// (v0.6) 상단 [AI 대화] · 설정 > AI 연결(AI 공통·Claude·Gemini·ChatGPT) · 입력란 아래 AI·모델 고르기
//        (Gemini·ChatGPT 대화와 AI 바꾸기는 scripts/e2e-ai.cjs)
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
    // 2. 켠 AI가 없으면 [AI 대화] → 설정 > AI 연결 > Claude: 지금 계정 · 모델 목록 → 기본 모델 Fake Opus → 연동 켜기
    out.headerBtn = await win.$eval('header button[aria-keyshortcuts="Control+J"]', (b) => b.textContent);
    await win.click('header button:has-text("AI 대화")');
    const dlg = win.locator('[role="dialog"][aria-label="설정"]');
    await dlg.waitFor();
    out.firstTab = await win.$eval('.set-tab[aria-selected="true"] .l', (e) => e.textContent);
    out.navGroup = await win.$$eval('.set-nav .set-group, .set-nav .set-tab .l', (es) => es.map((e) => e.textContent));
    await win.waitForFunction(() => document.querySelectorAll('#cp-claude-model option').length >= 4, null, { timeout: 30000 });
    out.modelOptions = await win.$$eval('#cp-claude-model option', (os) => os.map((o) => o.textContent));
    await win.waitForFunction(() => document.querySelector('.cp-auth-box .em')?.textContent === 'tester@example.com', null, { timeout: 30000 });
    out.account = await win.$eval('.cp-auth-box .lb', (e) => e.textContent);
    await win.selectOption('#cp-claude-model', 'fake-opus');
    await shot('settings-claude-off');
    await win.waitForSelector('#set-page-claude button:has-text("연동 켜기"):not([disabled])', { timeout: 60000 });
    await win.click('#set-page-claude button:has-text("연동 켜기")');
    await dlg.waitFor({ state: 'detached', timeout: 20000 });
    // 3. 대화: 입력창 아래 AI·모델 = Claude · Fake Opus, 표가 있는 답
    await win.click('header button:has-text("AI 대화")');
    await win.waitForSelector('.cp-model-chip');
    await win.waitForFunction(() => document.querySelector('.cp-model-chip .nm')?.textContent === 'Fake Opus', null, { timeout: 20000 });
    out.chipBadge = await win.$eval('.cp-model-chip .ai-badge', (e) => e.textContent);
    await win.fill('textarea.cp-ta', 'KCP 결제 연동을 정리해 주세요');
    await win.press('textarea.cp-ta', 'Enter');
    await win.waitForSelector('.cp-md .tblw table', { timeout: 30000 });
    await win.waitForFunction(() => !document.querySelector('.cp-stop'), null, { timeout: 30000 });
    await sleep(400);
    out.table = await win.$eval('.cp-md .tblw', (w) => ({ scroll: w.scrollWidth > w.clientWidth, cellW: Math.min(...[...w.querySelectorAll('td')].map((td) => td.getBoundingClientRect().width)) }));
    out.argvModel = fs.readFileSync(env.PA_FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.ev === 'start' && !x.argv.includes('--max-turns=1')).map((x) => x.argv.find((a) => a.startsWith('--model=')) ?? '');
    await shot('chat-table');
    // 4. 모델 바꾸기 (입력란 아래 AI·모델 고르기) → 안내. 다른 AI는 꺼져 있어 [설정에서 켜기]
    await win.click('.cp-model-chip');
    await win.waitForSelector('.ai-pick');
    out.pickModels = await win.$$eval('.ai-pick-m', (bs) => bs.map((b) => [b.querySelector('b')?.textContent, b.getAttribute('aria-checked')]));
    out.pickOthers = await win.$$eval('.ai-pick-ai', (bs) => bs.map((b) => b.textContent));
    await shot('chat-ai-picker');
    await win.click('.ai-pick-m:has-text("Fake Haiku")');
    await win.waitForSelector('.ai-pick', { state: 'detached' });
    await win.waitForSelector('text=모델을 Fake Haiku(으)로 바꿨습니다', { timeout: 10000 });
    out.chipAfter = await win.$eval('.cp-model-chip .nm', (e) => e.textContent);
    await shot('chat-model-switched');
    // 5. 크게 보기
    await win.click('button[aria-label="크게 보기"]');
    await sleep(400);
    out.expanded = await win.$eval('.cp-panel', (p) => { const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), fixed: getComputedStyle(p).position }; });
    await shot('chat-expanded');
    // 크게 보기 위에서 연 확인 창은 그 위에 보인다
    await win.click('button[aria-label="이 대화 지우기"]');
    await win.waitForSelector('.scrim .modal');
    out.confirmOnTop = await win.evaluate(() => {
      const m = document.querySelector('.scrim .modal');
      const r = m.getBoundingClientRect();
      return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.scrim .modal');
    });
    await win.click('.scrim .modal-foot button:has-text("취소")');
    await win.waitForSelector('.scrim', { state: 'detached' });
    await win.keyboard.press('Escape');
    await sleep(300);
    out.collapsed = await win.$eval('.cp-panel', (p) => getComputedStyle(p).position);

    // 5-1. 옆 대화창 너비: 왼쪽 가장자리를 끌면 넓어지고 기억 · 크게 보기는 양옆 가장자리로 너비 조절 · 두 번 누르면 원래대로
    const panelW = () => win.$eval('.cp-panel', (p) => Math.round(p.getBoundingClientRect().width));
    const w0 = await panelW();
    const rz = await win.locator('.cp-rz').boundingBox();
    await win.mouse.move(rz.x + rz.width / 2, rz.y + 300);
    await win.mouse.down();
    await win.mouse.move(rz.x + rz.width / 2 - 150, rz.y + 300, { steps: 6 });
    await win.mouse.up();
    const w1 = await panelW();
    const saved = await win.evaluate(() => localStorage.getItem('pa.chatWidth'));
    await shot('chat-wider');
    await win.click('button[aria-label="크게 보기"]');
    await sleep(300);
    const e0 = await panelW();
    const side = await win.locator('.cp-panel .rz-w').boundingBox();
    await win.mouse.move(side.x + side.width / 2, side.y + 200);
    await win.mouse.down();
    await win.mouse.move(side.x + side.width / 2 - 40, side.y + 200, { steps: 4 });
    await win.mouse.up();
    const e1 = await panelW();
    await win.keyboard.press('Escape');
    await sleep(300);
    const wBack = await panelW();
    await win.locator('.cp-rz').dblclick();
    await sleep(200);
    out.resize = { w0, w1, saved, popup: [e0, e1], wBack, wReset: await panelW(), savedAfterReset: await win.evaluate(() => localStorage.getItem('pa.chatWidth')) };

    // 5-2. 대화창 톱니 → 설정 > Claude (Esc는 설정 창만 닫음)
    await win.click('button[aria-label="Claude 연결 설정"]');
    await dlg.waitFor();
    out.gearTab = await win.$eval('.set-tab[aria-selected="true"] .l', (e) => e.textContent);
    await win.waitForFunction(() => document.querySelector('.cp-auth-box .em')?.textContent === 'tester@example.com', null, { timeout: 30000 });
    await shot('settings-from-gear');
    await win.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached', timeout: 5000 });
    out.panelAfterEsc = !!(await win.$('.cp-panel'));

    // 5-3. 다른 계정으로 바꾸기: (터미널 /login 대신) 가짜 CLI 계정을 바꾸고 [설정] → Claude → [다시 확인]
    fs.mkdirSync(env.PA_FAKE_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.PA_FAKE_STATE_DIR, 'account.json'), JSON.stringify({ email: 'other@example.com', organization: 'Other Org', subscriptionType: 'pro', apiProvider: 'firstParty' }));
    await win.click('header button[aria-label="설정"]');
    await dlg.waitFor();
    out.settingsFirstTab = await win.$eval('.set-tab[aria-selected="true"] .l', (e) => e.textContent);
    await win.click('#set-tab-claude');
    await win.click('#set-page-claude .cp-sec-h button:has-text("다시 확인")');
    await win.waitForFunction(() => document.querySelector('.cp-auth-box .em')?.textContent === 'other@example.com', null, { timeout: 30000 });
    out.switched = await win.$eval('.cp-auth-box .lb', (e) => e.textContent);
    await shot('settings-account-switched');
    // 기본 모델을 바꾸고 아래 [저장] → 닫힘 → 다시 열면 그대로
    await win.selectOption('#cp-claude-model', 'fake-haiku');
    await win.click('.set-dlg .modal-foot button.primary');
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    await win.click('header button[aria-label="설정"]');
    await win.click('#set-tab-claude');
    await win.waitForFunction(() => document.querySelectorAll('#cp-claude-model option').length >= 4, null, { timeout: 30000 });
    out.savedModel = await win.$eval('#cp-claude-model', (e) => e.value);
    // 모델 목록 줄을 눌러도 기본 모델이 바뀐다 (기본 표시)
    await win.click('#set-page-claude .ai-mrow:has-text("Fake Opus")');
    out.rowPick = [await win.$eval('#cp-claude-model', (e) => e.value), await win.$eval('#set-page-claude .ai-mrow.def b', (e) => e.textContent)];
    await win.selectOption('#cp-claude-model', 'fake-opus');
    await win.click('.set-dlg .modal-foot button.primary');
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    // 다음 메시지는 새 로그인으로 (쉬던 CLI는 [다시 확인] 때 닫힘 → resume으로 이어 감)
    const nStart = fs.readFileSync(env.PA_FAKE_LOG, 'utf8').split('\n').filter(Boolean).length;
    await win.fill('textarea.cp-ta', '계정 바꾼 뒤 질문');
    await win.press('textarea.cp-ta', 'Enter');
    await win.waitForFunction(() => [...document.querySelectorAll('.cp-user')].some((m) => m.textContent.includes('계정 바꾼 뒤 질문')), null, { timeout: 30000 });
    await win.waitForFunction(() => !document.querySelector('.cp-stop') && document.querySelector('.cp-body')?.textContent.includes('네, 확인했습니다'), null, { timeout: 30000 });
    await sleep(500);
    const after = fs.readFileSync(env.PA_FAKE_LOG, 'utf8').split('\n').filter(Boolean).slice(nStart).map((l) => JSON.parse(l));
    out.chatStart = after.filter((x) => x.ev === 'start' && !x.argv.includes('--max-turns=1') && x.argv.some((a) => a.startsWith('--resume'))).map((x) => x.account);

    // 5-4. 연동 끄기 → [AI 대화]는 다시 설정 > Claude → 연동 켜기
    await win.click('header button[aria-label="설정"]');
    await win.click('#set-tab-claude');
    await win.waitForSelector('#set-page-claude button:has-text("연동 끄기")');
    await win.click('#set-page-claude button:has-text("연동 끄기")');
    await dlg.waitFor({ state: 'detached', timeout: 20000 });
    out.offToast = await win.locator('.toast').innerText().catch(() => '');
    out.panelAfterOff = !!(await win.$('.cp-panel'));
    if (out.panelAfterOff) await win.click('button[aria-label="닫기"][title="닫기 (Esc)"]');
    await win.click('header button:has-text("AI 대화")');
    await dlg.waitFor();
    out.offTab = await win.$eval('.set-tab[aria-selected="true"] .l', (e) => e.textContent);
    await shot('settings-claude-turn-on-again');
    await win.waitForSelector('#set-page-claude button:has-text("연동 켜기"):not([disabled])', { timeout: 60000 });
    await win.click('#set-page-claude button:has-text("연동 켜기")');
    await dlg.waitFor({ state: 'detached', timeout: 20000 });
    await win.click('header button:has-text("AI 대화")');
    await win.waitForSelector('textarea.cp-ta');
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
    out.modelBack = await win.$eval('.cp-model-chip .nm', (s) => s.textContent);
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
    assert.equal(out.firstTab, 'Claude', '켠 AI가 없을 때 [AI 대화] → 설정의 기본 AI(Claude) 연결');
    assert.match(out.headerBtn, /AI 대화/);
    assert.deepEqual(out.navGroup, ['분석', 'AI 연결', 'AI 공통', 'Claude', 'Gemini', 'ChatGPT'], '설정 왼쪽 칸: AI 연결 묶음');
    assert.equal(out.chipBadge, 'C');
    assert.deepEqual(out.pickModels.map((m) => m[0]), ['Claude Code 기본값', 'Fake Opus', 'Fake Haiku']);
    assert.deepEqual(out.pickModels.filter((m) => m[1] === 'true').map((m) => m[0]), ['Fake Opus'], '고른 모델에 표시');
    assert.ok(out.pickOthers.length === 2 && out.pickOthers.every((t) => /꺼짐.*설정에서 켜기/.test(t)), `다른 AI: ${out.pickOthers}`);
    assert.equal(out.chipAfter, 'Fake Haiku');
    assert.deepEqual(out.rowPick, ['fake-opus', 'Fake Opus'], '모델 목록 줄로 기본 모델');
    assert.match(out.account, /tester@example\.com/);
    assert.match(out.account, /Fake Org · Max 구독/);
    assert.ok(out.resize.w1 >= out.resize.w0 + 140 && Number(out.resize.saved) === out.resize.w1, `대화창 너비: ${JSON.stringify(out.resize)}`);
    assert.ok(Math.abs(out.resize.popup[1] - out.resize.popup[0] - 80) <= 3, `크게 보기 양옆: ${JSON.stringify(out.resize)}`);
    assert.equal(out.resize.wBack, out.resize.w1, '크게 보기에서 돌아와도 고른 너비');
    assert.ok(out.resize.wReset === out.resize.w0 && out.resize.savedAfterReset === null, '두 번 누르면 원래 너비');
    assert.equal(out.gearTab, 'Claude');
    assert.ok(out.panelAfterEsc, 'Esc는 설정 창만 닫음');
    assert.match(out.settingsFirstTab, /분석/);
    assert.match(out.switched, /other@example\.com/);
    assert.match(out.switched, /Other Org · Pro 구독/);
    assert.equal(out.savedModel, 'fake-haiku', '설정 [저장]');
    assert.deepEqual(out.chatStart, ['other@example.com'], '[다시 확인] 뒤 다음 메시지는 새 로그인으로 이어 감');
    assert.match(out.offToast, /연동을 껐습니다/);
    assert.equal(out.offTab, 'Claude');
    assert.ok(out.confirmOnTop, '크게 보기 위의 확인 창');
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
