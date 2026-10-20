// AI 연결 점검 (v0.6): Gemini·ChatGPT 연동 켜기 → 기본 AI 바꾸기 → Gemini 대화(도구·모델 바꾸기) →
// ChatGPT 로그인 필요 → 로그인 뒤 연동 켜기 → 다른 AI로 새 대화(이전 대화 맥락) → 대화 기록의 AI 표시 → 연동 끄기 배너
//   node scripts/build-desktop.mjs --dev --out <scratch>/app
//   xvfb-run -a node scripts/e2e-ai.cjs <scratch>/app <scratch>/e2e-ai
// 실제 Google·OpenAI·Anthropic·계정을 쓰지 않는다: Gemini는 이 PC(127.0.0.1)의 가짜 서버(test/fake-ai/fake-gemini.mjs),
// ChatGPT는 가짜 Codex CLI(test/fake-ai/fake-codex.mjs), Claude는 가짜 CLI(test/fake-claude). 환경 변수는 새로 만들어 넘긴다.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { _electron: electron } = require(path.join(ROOT, 'desktop/node_modules/playwright-core'));
const appDir = path.resolve(process.argv[2] || path.join(ROOT, 'desktop'));
const work = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'e2e-ai'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = path.join(work, 'shots');
const codexState = path.join(work, 'codex-state');
const codexLog = path.join(work, 'codex.jsonl');

function prepare() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  const dir = path.join(work, 'shop-admin');
  fs.cpSync(path.join(ROOT, 'fixtures/shop-admin'), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(work, 'claude.json'), JSON.stringify({ probe: [{ say: 'OK' }], default: [{ say: '네, 확인했습니다.' }] }));
  // 가짜 Codex: 처음에는 로그인 안 됨 (account/read → null)
  fs.mkdirSync(codexState, { recursive: true });
  fs.writeFileSync(
    path.join(work, 'codex.json'),
    JSON.stringify({ turns: [{ match: '이어서', steps: [{ say: 'ChatGPT 답: 이전 대화를 이어 받아 정리했습니다.' }] }], default: [{ say: 'OK' }] }),
  );
  return dir;
}

(async () => {
  const project = prepare();
  const { startFakeGemini, FAKE_GEMINI_KEY } = await import(path.join(ROOT, 'test/fake-ai/fake-gemini.mjs'));
  const gem = await startFakeGemini({
    scenario: {
      turns: [
        { match: '모델 바꾼 뒤', steps: [{ say: 'Flash 답: 확인했습니다.' }] },
        { match: '주문 이력', steps: [{ calls: [{ name: 'grep', args: { pattern: 'insertOrderHist' } }] }, { say: 'Gemini 답: 이력이 두 곳에서 저장됩니다.' }] },
      ],
      default: [{ say: 'OK' }],
    },
  });
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
    PA_FAKE_SCENARIO: path.join(work, 'claude.json'),
    PA_FAKE_LOG: path.join(work, 'claude.jsonl'),
    PA_FAKE_DELAY: '1',
    PA_GEMINI_BASE_URL: gem.url,
    PA_CODEX_CLI: path.join(ROOT, 'test/fake-ai/fake-codex.mjs'),
    PA_FAKE_CODEX_SCENARIO: path.join(work, 'codex.json'),
    PA_FAKE_CODEX_STATE: codexState,
    PA_FAKE_CODEX_LOG: codexLog,
    PA_FAKE_CODEX_AUTH: 'none',
  };
  const ud = path.join(work, 'ud');
  const app = await electron.launch({ executablePath: require(path.join(ROOT, 'desktop/node_modules/electron')), args: [appDir, '--no-sandbox', `--user-data-dir=${ud}`], cwd: appDir, env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1426, height: 883 });
  let n = 0;
  const shot = async (name) => win.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) });
  const dlg = win.locator('[role="dialog"][aria-label="설정"]');
  const tabLabel = () => win.$eval('.set-tab[aria-selected="true"] .l', (e) => e.textContent);
  const codexEvents = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const waitAnswer = async (text) => {
    await win.waitForFunction((t) => !document.querySelector('.cp-stop') && (document.querySelector('.cp-body')?.textContent ?? '').includes(t), text, { timeout: 60000 });
    await sleep(300);
  };
  const out = {};
  try {
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, project);
    await win.click('button:has-text("폴더 선택")');
    await win.waitForSelector('text=불러오기 확인', { timeout: 30000 });
    await win.click('button:has-text("분석 시작")');
    await win.waitForSelector('text=분석 결과 요약', { timeout: 120000 });
    await sleep(500);

    // 1. 켠 AI가 없음 → [AI 대화] → 기본 AI(Claude)의 연결 → 왼쪽 칸에서 Gemini
    await win.click('header button:has-text("AI 대화")');
    await dlg.waitFor();
    out.firstTab = await tabLabel();
    await win.click('#set-tab-gemini');
    await win.waitForSelector('#set-page-gemini #gm-key');
    out.geminiOffText = await win.$eval('#set-page-gemini .cp-onoff .d', (e) => e.textContent);
    out.geminiWhyNot = await win.$eval('#set-page-gemini .cp-onoff button.primary', (b) => [b.disabled, b.title]);
    await shot('gemini-off');
    // 2. API 키 → [연동 켜기] (저장 → 연결 확인(토큰 세기) → 켬)
    await win.fill('#gm-key', FAKE_GEMINI_KEY);
    await win.click('#set-page-gemini button:has-text("연동 켜기")');
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    out.geminiOnToast = await win.locator('.toast').innerText().catch(() => '');
    out.geminiReq = gem.requests.map((r) => `${r.method} ${r.path.replace(/^.*\/models/, '/models')} ${r.apiKeyOk ? 'key' : 'nokey'}`);

    // 2-1. 켜 둔 채 API 키 [지우기] → [저장]은 거절 (키는 그대로, 창은 열린 채)
    await win.click('header button[aria-label="설정"]');
    await dlg.waitFor();
    await win.click('#set-tab-gemini');
    await win.click('#set-page-gemini .cp-field-row button:has-text("지우기")');
    await win.click('.set-dlg .modal-foot button.primary');
    await win.waitForSelector('#set-page-gemini .cp-onoff .e', { timeout: 10000 });
    out.clearKeyBlocked = { err: await win.$eval('#set-page-gemini .cp-onoff .e', (e) => e.textContent), open: await dlg.isVisible() };
    await win.click('#set-page-gemini .cp-field-row button:has-text("되돌리기")');

    // 3. 설정 > AI 공통: 기본 AI를 Gemini로 → [저장]
    await win.click('#set-tab-ai');
    await win.waitForSelector('#set-page-ai .ai-card');
    out.cards = await win.$$eval('#set-page-ai .ai-card', (cs) => cs.map((c) => [c.querySelector('.h b')?.textContent, c.querySelector('.tag')?.textContent, c.querySelector('input')?.disabled]));
    out.navHints = await win.$$eval('.set-nav .set-tab .h', (hs) => hs.map((h) => h.textContent));
    await win.check('#set-page-ai .ai-card:has-text("Gemini") input[name="default-ai"]');
    await shot('ai-common-gemini');
    await win.click('.set-dlg .modal-foot button.primary');
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    await sleep(300);
    out.headerTitle = await win.$eval('header button[aria-keyshortcuts="Control+J"]', (b) => b.title);

    // 4. [AI 대화] → Gemini 새 대화: 배지·모델·보내는 곳 → 질문 (도구 grep → 답)
    await win.click('header button:has-text("AI 대화")');
    await win.waitForSelector('aside[aria-label="AI 대화"] .cp-model-chip');
    await win.waitForFunction(() => document.querySelector('.cp-model-chip .nm')?.textContent === 'Gemini 4 Argon', null, { timeout: 20000 });
    out.geminiPanel = await win.evaluate(() => ({
      badge: document.querySelector('.cp-head .ai-badge')?.textContent,
      status: document.querySelector('.cp-sub')?.textContent,
      note: document.querySelector('.cp-note')?.textContent,
      box: document.querySelector('textarea.cp-ta')?.getAttribute('aria-label'),
    }));
    await win.fill('textarea.cp-ta', '주문 이력이 두 번 쌓이는 원인을 찾아 주세요');
    await win.press('textarea.cp-ta', 'Enter');
    await waitAnswer('Gemini 답: 이력이 두 곳에서 저장됩니다.');
    out.geminiAnswer = await win.evaluate(() => ({
      avatar: [...document.querySelectorAll('.cp-msg .ai-badge')].map((b) => b.textContent),
      tools: [...document.querySelectorAll('.cp-tl')].map((t) => t.textContent),
    }));
    const gen = gem.requests.filter((r) => /streamGenerateContent/.test(r.path));
    out.geminiGen = { n: gen.length, model: gen[0]?.path.match(/models\/([^:]+)/)?.[1], tools: (gen[0]?.body.tools?.[0]?.functionDeclarations ?? []).map((f) => f.name), system: /계획 모드/.test(JSON.stringify(gen[0]?.body.systemInstruction ?? '')) };
    await shot('gemini-chat');

    // 5. 입력란 아래 AI·모델 → Gemini 3.8 Flash (대화는 이어짐) → 다음 질문은 그 모델로
    await win.click('.cp-model-chip');
    await win.waitForSelector('.ai-pick');
    out.geminiPick = await win.$$eval('.ai-pick-m', (bs) => bs.map((b) => `${b.querySelector('b')?.textContent}${b.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`));
    out.otherAis = await win.$$eval('.ai-pick-ai', (bs) => bs.map((b) => b.textContent));
    await shot('gemini-picker');
    await win.click('.ai-pick-m:has-text("Gemini 3.8 Flash")');
    await win.waitForSelector('text=모델을 Gemini 3.8 Flash(으)로 바꿨습니다', { timeout: 10000 });
    await win.fill('textarea.cp-ta', '모델 바꾼 뒤 질문입니다');
    await win.press('textarea.cp-ta', 'Enter');
    await waitAnswer('Flash 답: 확인했습니다.');
    const gen2 = gem.requests.filter((r) => /streamGenerateContent/.test(r.path));
    out.flashModel = gen2[gen2.length - 1]?.path.match(/models\/([^:]+)/)?.[1];
    // 같은 대화가 이어짐: 보낸 기록에 사용자 질문 글 2개 (도구 결과는 따로)
    out.flashHistory = (gen2[gen2.length - 1]?.body.contents ?? []).filter((c) => c.role === 'user' && (c.parts ?? []).some((p) => typeof p.text === 'string' && p.text.trim())).length;

    // 6. 설정 > ChatGPT: Codex 확인 → [연동 켜기] → 로그인 안 됨이라 켜지지 않음 (MSG-21 · 터미널에서 로그인)
    await win.click('header button[aria-label="설정"]');
    await dlg.waitFor();
    await win.click('#set-tab-openai');
    await win.waitForSelector('#set-page-openai .cp-ok:has-text("Codex")');
    await win.waitForFunction(() => /0\.163\.0/.test(document.querySelector('#set-page-openai .cp-okchips')?.textContent ?? ''), null, { timeout: 30000 });
    out.codexChip = await win.$eval('#set-page-openai .cp-okchips', (e) => e.textContent);
    await win.click('#set-page-openai button:has-text("연동 켜기")');
    await win.waitForSelector('#set-page-openai .cp-onoff .e', { timeout: 60000 });
    out.openaiFail = await win.evaluate(() => ({
      err: document.querySelector('#set-page-openai .cp-onoff .e')?.textContent,
      box: document.querySelector('#set-page-openai .cp-inline-err')?.textContent,
      tag: document.querySelector('#set-page-openai .cp-auth-box .tag')?.textContent,
      enabled: !!document.querySelector('#set-page-openai .cp-onoff.on'),
    }));
    await shot('openai-login-needed');
    // (터미널의 codex login 대신) 가짜 Codex 계정을 ChatGPT 로그인으로 바꾸고 [다시 확인] → 계정 표시 → 연동 켜기
    fs.writeFileSync(path.join(codexState, 'account.json'), JSON.stringify({ account: { type: 'chatgpt', email: 'tester@example.com', planType: 'plus' }, requiresOpenaiAuth: true }));
    await win.click('#set-page-openai .cp-sec-h button:has-text("다시 확인")');
    await win.waitForFunction(() => document.querySelector('#set-page-openai .cp-auth-box .em')?.textContent === 'tester@example.com', null, { timeout: 60000 });
    await win.waitForSelector('#set-page-openai .cp-ok:not(.fail):not(.wait):has-text("인증")', { timeout: 60000 });
    out.openaiAccount = await win.$eval('#set-page-openai .cp-auth-box .lb', (e) => e.textContent);
    out.openaiModels = await win.$$eval('#set-page-openai .ai-mrow b', (bs) => bs.map((b) => b.textContent));
    await shot('openai-logged-in');
    await win.click('#set-page-openai button:has-text("연동 켜기")');
    await dlg.waitFor({ state: 'detached', timeout: 60000 });
    out.openaiOnToast = await win.locator('.toast').innerText().catch(() => '');

    // 7. Gemini 대화에서 다른 AI(ChatGPT)로 새 대화: 확인 창 → 이전 대화 맥락 → 질문
    await win.click('.cp-model-chip');
    await win.waitForSelector('.ai-pick-ai:has-text("ChatGPT")');
    out.chatgptRow = await win.$eval('.ai-pick-ai:has-text("ChatGPT")', (b) => b.textContent);
    await win.click('.ai-pick-ai:has-text("ChatGPT")');
    await win.waitForSelector('.scrim .modal:has-text("ChatGPT로 새 대화 시작")');
    out.switchDlg = await win.evaluate(() => ({
      text: document.querySelector('.scrim .ai-sw-p')?.textContent,
      carry: document.querySelector('.scrim .ai-sw-carry input')?.checked,
      models: [...document.querySelectorAll('#ai-sw-model option')].map((o) => o.textContent),
    }));
    await shot('switch-dialog');
    await win.click('.scrim .modal-foot button:has-text("새 대화로 시작")');
    await win.waitForSelector('.scrim', { state: 'detached' });
    await win.waitForSelector('.cp-chip:has-text("이전 대화 (Gemini)")');
    out.switched = await win.evaluate(() => ({
      badge: document.querySelector('.cp-head .ai-badge')?.textContent,
      title: document.querySelector('.cp-title')?.textContent,
      chip: document.querySelector('.cp-model-chip .nm')?.textContent,
      note: document.querySelector('.cp-note')?.textContent,
    }));
    await win.fill('textarea.cp-ta', '이어서 정리해 주세요');
    await win.press('textarea.cp-ta', 'Enter');
    await waitAnswer('ChatGPT 답: 이전 대화를 이어 받아 정리했습니다.');
    const turns = codexEvents().filter((e) => e.kind === 'turn/start');
    const chatTurn = turns.find((t) => /이어서 정리해 주세요/.test(t.text));
    out.codexTurn = chatTurn ? { carried: /## 이전 대화: 이전 대화 \(Gemini\)/.test(chatTurn.text) && /\[Gemini\] Gemini 답: 이력이 두 곳에서 저장됩니다\./.test(chatTurn.text) && /\[사용자\] 주문 이력이 두 번/.test(chatTurn.text) } : null;
    const th = codexEvents().filter((e) => e.kind === 'thread/start' && !e.ephemeral);
    out.codexThread = th.length ? { tools: th[th.length - 1].dynamicTools, approval: th[th.length - 1].approvalPolicy, sandbox: th[th.length - 1].sandbox } : null;
    await shot('chatgpt-chat');

    // 8. 대화 기록: AI 배지 · Gemini 대화를 다시 열면 그 AI·모델
    await win.click('button[aria-label="대화 기록"]');
    await win.waitForSelector('.cp-pop-row');
    out.history = await win.$$eval('.cp-pop-row', (rs) => rs.map((r) => `${r.querySelector('.ai-badge')?.textContent} ${r.querySelector('.ttl')?.textContent}`));
    await shot('history');
    await win.click('.cp-pop-row:has(.ai-badge:text-is("G")) .cp-pop-item');
    await win.waitForFunction(() => document.querySelector('.cp-head .ai-badge')?.textContent === 'G', null, { timeout: 10000 });
    out.reopened = await win.$eval('.cp-model-chip .nm', (e) => e.textContent);

    // 8-1. 새 대화 초안에서 고른 모델은 그 AI에 묶임: 기본 AI를 ChatGPT로 바꿔도 초안은 Gemini · 고른 모델
    await win.click('button[aria-label="새 대화"]');
    await win.waitForFunction(() => document.querySelector('.cp-head .ai-badge')?.textContent === 'G', null, { timeout: 10000 });
    await win.click('.cp-model-chip');
    await win.click('.ai-pick-m:has-text("Gemini 3.5 Flash-Lite")');
    await win.click('header button[aria-label="설정"]');
    await dlg.waitFor();
    await win.click('#set-tab-ai');
    await win.check('#set-page-ai .ai-card:has-text("ChatGPT") input[name="default-ai"]');
    await win.click('.set-dlg .modal-foot button.primary');
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    await sleep(300);
    out.pinnedDraft = await win.evaluate(() => [document.querySelector('.cp-head .ai-badge')?.textContent, document.querySelector('.cp-model-chip .nm')?.textContent]);

    // 9. Gemini 연동 끄기 → 그 대화는 배너(켜기 · ChatGPT로 새 대화), 입력 막힘
    await win.click('header button[aria-label="설정"]');
    await dlg.waitFor();
    await win.click('#set-tab-gemini');
    await win.click('#set-page-gemini button:has-text("연동 끄기")');
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    await win.waitForSelector('.cp-top-banner:has-text("Gemini 연동이 꺼져 있습니다")', { timeout: 10000 });
    out.offBanner = await win.$$eval('.cp-top-banner button', (bs) => bs.map((b) => b.textContent));
    out.offInput = await win.$eval('textarea.cp-ta', (t) => t.disabled);
    await shot('gemini-off-banner');
    out.headerAfterOff = await win.$eval('header button[aria-keyshortcuts="Control+J"]', (b) => b.title.split('\n')[0]);
  } catch (e) {
    await shot('FAIL').catch(() => {});
    console.error('E2E 실패:', e.message);
    console.log(JSON.stringify({ ...out, errors }, null, 1));
    await app.close().catch(() => {});
    await gem.close?.();
    process.exit(1);
  }
  await app.close();
  await gem.close?.();
  // 비밀 값은 설정 파일에 그대로 남지 않음
  const dataDir = fs.readdirSync(ud).includes('data') ? path.join(ud, 'data') : ud;
  const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? find(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const plain = find(ud).filter((f) => /\.(json|jsonl)$/.test(f) && fs.readFileSync(f, 'utf8').includes(FAKE_GEMINI_KEY));
  out.keyInPlainFiles = plain.map((f) => path.relative(ud, f));
  // 계정 이름(이메일)은 화면에만 보이고 저장하지 않음
  out.emailInFiles = find(ud).filter((f) => { try { return fs.statSync(f).size < 5e6 && fs.readFileSync(f, 'utf8').includes('tester@example.com'); } catch { return false; } }).map((f) => path.relative(ud, f));
  out.codexEnvLeak = codexEvents().filter((e) => e.kind === 'start').some((e) => (e.env?.paVars ?? []).length > 0);
  console.log(JSON.stringify({ ...out, dataDir: path.relative(work, dataDir), errors }, null, 1));
  try {
    assert.equal(out.firstTab, 'Claude', '켠 AI가 없으면 기본 AI(Claude)의 연결부터');
    assert.match(out.geminiOffText, /Google\(Gemini API 또는 회사 Google Cloud\)로 전송/, 'MSG-14 (Gemini)');
    assert.deepEqual(out.geminiWhyNot, [true, 'API 키를 넣어 주세요']);
    assert.equal(out.geminiOnToast, 'Gemini 연동을 켰습니다.');
    assert.ok(out.geminiReq.some((r) => /countTokens key$/.test(r)), `토큰 세기로 인증 확인: ${out.geminiReq}`);
    assert.ok(out.geminiReq.every((r) => /key$/.test(r)), '모든 요청에 API 키');
    assert.deepEqual(out.cards.map((c) => c[0]), ['Claude', 'Gemini', 'ChatGPT']);
    assert.deepEqual(out.cards[1], ['Gemini', '켜짐', false]);
    assert.deepEqual(out.cards[0], ['Claude', '꺼짐', true], '꺼진 AI는 기본으로 고를 수 없음');
    assert.match(out.headerTitle, /^새 대화: Gemini/);
    assert.equal(out.geminiPanel.badge, 'G');
    assert.match(out.geminiPanel.status, /Gemini 연결됨/);
    assert.match(out.geminiPanel.note, /Google로 전송됨/);
    assert.equal(out.geminiPanel.box, 'Gemini에게 보낼 내용');
    assert.ok(out.geminiAnswer.avatar.length && out.geminiAnswer.avatar.every((a) => a === 'G'), 'Gemini 답의 얼굴');
    assert.ok(out.geminiAnswer.tools.some((t) => /insertOrderHist|검색/.test(t)), `도구 작업 내역: ${out.geminiAnswer.tools}`);
    assert.equal(out.geminiGen.model, 'gemini-4-argon');
    assert.ok(out.geminiGen.tools.includes('grep') && out.geminiGen.tools.includes('read_file') && out.geminiGen.tools.includes('exit_plan_mode'), `앱 도구: ${out.geminiGen.tools}`);
    assert.ok(out.geminiGen.system, '계획 모드 안내');
    // Google이 알려 준 목록 (음성·임베딩·Gemma는 빼고, 기본 이름이 없는 고정 판은 남김)
    assert.deepEqual(out.geminiPick, ['Gemini 4 Argon ✓', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash-Lite', 'Gemini 2.0 Flash 001']);
    assert.ok(out.otherAis.some((t) => /Claude.*꺼짐.*설정에서 켜기/.test(t)) && out.otherAis.some((t) => /ChatGPT.*설정에서 켜기/.test(t)), `다른 AI: ${out.otherAis}`);
    assert.equal(out.flashModel, 'gemini-3.8-flash', '바꾼 모델로 다음 요청');
    assert.equal(out.flashHistory, 2, '같은 대화가 이어짐 (질문 2개)');
    assert.match(out.codexChip, /Codex0\.163\.0/);
    assert.match(out.openaiFail.err, /연동을 켜지 않았습니다/);
    assert.match(out.openaiFail.box, /ChatGPT 인증에 실패했습니다.*터미널에서 로그인/);
    assert.equal(out.openaiFail.enabled, false);
    assert.match(out.openaiAccount, /tester@example\.com.*Plus 구독.*로그인됨/);
    assert.deepEqual(out.openaiModels, ['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-5.3-Codex']);
    assert.equal(out.openaiOnToast, 'ChatGPT 연동을 켰습니다.');
    assert.match(out.chatgptRow, /ChatGPT · GPT-6\.1-Sol.*켜짐.*새 대화 →/);
    assert.match(out.switchDlg.text, /Gemini와 나눈 대화는 대화 기록에 그대로 남습니다/);
    assert.equal(out.switchDlg.carry, true);
    assert.equal(out.switchDlg.models[0], 'GPT-6.1-Sol (ChatGPT 기본 모델)');
    assert.equal(out.switched.badge, 'O');
    assert.match(out.switched.title, /새 대화/);
    assert.equal(out.switched.chip, 'GPT-6.1-Sol');
    assert.match(out.switched.note, /OpenAI로 전송됨/);
    assert.deepEqual(out.codexTurn, { carried: true }, '첫 질문에 이전 대화(질문·답변 글)를 맥락으로');
    assert.ok(out.codexThread && out.codexThread.tools.includes('grep') && out.codexThread.approval === 'untrusted' && out.codexThread.sandbox === 'read-only', `Codex 스레드: ${JSON.stringify(out.codexThread)}`);
    assert.equal(out.history.length, 2);
    assert.deepEqual(out.history.map((h) => h[0]).sort(), ['G', 'O']);
    assert.equal(out.reopened, 'Gemini 3.8 Flash', '다시 연 대화는 그 AI·고른 모델');
    assert.match(out.clearKeyBlocked.err, /Gemini API 키를 넣어 주세요/);
    assert.equal(out.clearKeyBlocked.open, true, '저장하지 못하면 창은 열린 채');
    assert.deepEqual(out.pinnedDraft, ['G', 'Gemini 3.5 Flash-Lite'], '초안에서 고른 모델은 그 AI에 묶임');
    assert.deepEqual(out.offBanner, ['Gemini 연결', 'ChatGPT로 새 대화']);
    assert.equal(out.offInput, true);
    assert.match(out.headerAfterOff, /^새 대화: ChatGPT/, '기본 AI가 꺼지면 켜진 AI로');
    assert.deepEqual(out.keyInPlainFiles, [], 'API 키는 설정 파일에 그대로 남지 않음');
    assert.deepEqual(out.emailInFiles, [], '계정 이메일은 저장하지 않음');
    assert.equal(out.codexEnvLeak, false, 'Codex에 앱의 PA_ 환경 변수를 넘기지 않음');
    assert.deepEqual(errors, []);
  } catch (e) {
    console.error('E2E 확인 실패:', e.message);
    process.exit(2);
  }
  console.log('E2E OK');
})();
