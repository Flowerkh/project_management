// 데스크톱 앱 확인: xvfb-run node e2e.cjs <폴더> [결과 png 폴더]
// 폴더 선택 창은 메인 프로세스에서 바꿔치기해 지정한 폴더를 돌려준다.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require('playwright-core');

(async () => {
  const folder = path.resolve(process.argv[2] || path.join(__dirname, '..', 'fixtures', 'shop-admin'));
  const out = path.resolve(process.argv[3] || path.join(__dirname, '..', 'dist', 'shots'));
  fs.mkdirSync(out, { recursive: true });
  // PA_APP_DIR: build-desktop.mjs --out 으로 만든 앱 폴더, PA_USER_DATA: 앱 데이터 폴더 (시험마다 따로)
  const appDir = process.env.PA_APP_DIR || __dirname;
  const userData = process.env.PA_USER_DATA || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pa-e2e-'));
  const app = await electron.launch({ executablePath: require('electron'), args: [appDir, '--no-sandbox', `--user-data-dir=${userData}`], cwd: appDir, env: { ...process.env, PA_E2E: '1' } });
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, folder);
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  console.log('title:', await win.title(), '| bridge:', await win.evaluate(() => window.__ELECTRON__ && window.__ELECTRON__.kind));
  await win.click('button:has-text("폴더 선택")');
  await win.waitForSelector('text=불러오기 확인', { timeout: 30000 });
  await win.screenshot({ path: path.join(out, 'electron-1-confirm.png') });
  const t0 = Date.now();
  await win.click('button:has-text("분석 시작")');
  await win.waitForSelector('text=분석 결과 요약', { timeout: 180000 });
  console.log(`analysis ${(Date.now() - t0) / 1000}s`);
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(out, 'electron-2-summary.png') });
  const cats = await win.evaluate(() => [...document.querySelectorAll('.trow.cat')].map((r) => r.innerText.replace(/\s+/g, ' ')));
  console.log('tree:', cats);
  console.log('errors:', errors.length ? errors : 'none');
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
