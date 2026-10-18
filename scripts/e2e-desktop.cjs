// 데스크톱 앱 통합 점검 (화면을 실제로 눌러 가며): 분석 → Claude 연결 → DB 연결 → Claude에게 묻기 → 계획 → 수정 진행
// → 변경 검토 → 적용·커밋·푸시 → 다시 분석 → 쿼리 카드 실행 → 작업 이력 → 되돌리기
//
//   node scripts/build-desktop.mjs --dev --out <scratch>/app
//   xvfb-run -a node scripts/e2e-desktop.cjs <scratch>/app <scratch>/e2e
//
// - Claude는 가짜 CLI(test/fake-claude)로 흉내 낸다. 실제 Claude·네트워크·계정을 쓰지 않는다 (환경 변수를 새로 만들어 넘김).
// - DB는 이 PC의 MariaDB(root 소켓 접속)에 시험용 DB·계정을 만들어 쓴다.
// - 프로젝트는 fixtures/shop-admin을 복사해 git 저장소로 만들고, 로컬 bare 저장소를 원격으로 둔다.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { _electron: electron } = require(path.join(ROOT, 'desktop/node_modules/playwright-core'));

const appDir = path.resolve(process.argv[2] || path.join(ROOT, 'desktop'));
const work = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'e2e'));
const shots = path.join(work, 'shots');
const proj = path.join(work, 'shop-admin');
const remote = path.join(work, 'remote.git');
const ud = path.join(work, 'userdata');
const home = path.join(work, 'home');
const bin = path.join(work, 'bin');
const REL = 'src/main/java/egovframework/shop/order/service/impl/OrderServiceImpl.java';
const DB = { name: 'pa_e2e_shop', app: 'pa_e2e_app', appPw: 'App#e2e1', read: 'pa_e2e_read', readPw: 'Read#e2e1' };

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function prepare() {
  for (const d of [shots, proj, remote, ud, home, bin, path.join(work, 'fake-state')]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [shots, home, bin]) fs.mkdirSync(d, { recursive: true });
  // PATH에는 node·git·svn만 (실제 claude가 있는 폴더는 넣지 않음)
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  // 프로젝트: git 저장소 + 로컬 원격
  fs.cpSync(path.join(ROOT, 'fixtures/shop-admin'), proj, { recursive: true });
  sh('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const g = (...a) => sh('git', ['-C', proj, ...a]);
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'E2E 사용자');
  g('config', 'user.email', 'e2e@example.invalid');
  g('add', '-A');
  g('commit', '-q', '-m', 'shop-admin 시작');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  // DB
  const sql = `
DROP DATABASE IF EXISTS ${DB.name};
CREATE DATABASE ${DB.name} CHARACTER SET utf8mb4;
USE ${DB.name};
CREATE TABLE TB_ORDER_HIST (
  HIST_SN INT PRIMARY KEY,
  ORDER_NO VARCHAR(20) NOT NULL COMMENT '주문번호',
  ORDER_STAT_CD VARCHAR(10) COMMENT '주문상태',
  CUST_NM VARCHAR(50) COMMENT '고객 성명',
  CUST_TEL VARCHAR(20) COMMENT '연락처',
  REG_DT DATETIME
) COMMENT='주문 이력';
INSERT INTO TB_ORDER_HIST VALUES
 (1,'O-1001','PAY','홍길동','010-1234-5678','2026-10-16 10:00:00'),
 (2,'O-1001','PAY','홍길동','010-1234-5678','2026-10-16 10:00:00'),
 (3,'O-1002','DLVY','김영희','010-2222-3333','2026-10-16 11:00:00'),
 (4,'O-1002','DLVY','김영희','010-2222-3333','2026-10-16 11:00:00'),
 (5,'O-1003','PAY','이철수','010-4444-5555','2026-10-16 12:00:00');
CREATE TABLE TB_MENU (MENU_ID VARCHAR(10) PRIMARY KEY, UPPER_MENU_ID VARCHAR(10), MENU_NM VARCHAR(50), MENU_URL VARCHAR(100), MENU_ORDR INT) COMMENT='메뉴';
INSERT INTO TB_MENU VALUES ('100', NULL, '주문관리', NULL, 1), ('101', '100', '주문 목록', '/order/orderList.do', 1), ('102', '100', '주문 상세', '/order/orderDetail.do', 2), ('103', '100', 'DB에만 있는 메뉴', '/order/onlyInDb.do', 3);
${['localhost', '127.0.0.1']
  .map(
    (h) => `DROP USER IF EXISTS '${DB.app}'@'${h}'; CREATE USER '${DB.app}'@'${h}' IDENTIFIED BY '${DB.appPw}'; GRANT ALL ON ${DB.name}.* TO '${DB.app}'@'${h}';
DROP USER IF EXISTS '${DB.read}'@'${h}'; CREATE USER '${DB.read}'@'${h}' IDENTIFIED BY '${DB.readPw}'; GRANT SELECT ON ${DB.name}.* TO '${DB.read}'@'${h}';`,
  )
  .join('\n')}
FLUSH PRIVILEGES;`;
  sh('mysql', ['-uroot'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
  // 가짜 Claude 시나리오 (MariaDB 문법)
  const scenario = {
    probe: [{ say: 'OK' }],
    turns: [
      {
        steps: [
          { say: '주문 상태를 바꿀 때 이력이 어디서 저장되는지 먼저 확인하겠습니다.' },
          { tool: 'Grep', input: { pattern: 'insertOrderHist', output_mode: 'files_with_matches' } },
          { tool: 'Read', input: { file_path: REL } },
          { tool: 'Read', input: { file_path: 'src/main/resources/egovframework/egovProps/globals.properties' } },
          { mcp: 'db_select', input: { sql: 'SELECT ORDER_NO, COUNT(*) AS CNT, MAX(CUST_NM) AS CUST_NM, MAX(CUST_TEL) AS CUST_TEL FROM TB_ORDER_HIST GROUP BY ORDER_NO HAVING COUNT(*) > 1', env: 'dev' } },
          { say: `원인은 이력 저장이 서비스와 컨트롤러 양쪽에서 호출되기 때문입니다. \`${REL}:47\`의 \`insertOrderHist()\`가 상태 변경 뒤 한 번 더 불립니다. TB_ORDER_HIST에 중복 2건이 쌓여 있습니다.` },
          { tool: 'ExitPlanMode', input: { plan: '## 수정 계획\n1. `OrderServiceImpl.insertOrderHist()`의 중복 저장을 막는다\n2. 영향 범위: 주문상세, TB_ORDER_HIST' } },
          { tool: 'Edit', input: { file_path: REL, old_string: '        return orderdao.insertOrderHist(vo);', new_string: '        // 주문 이력은 updateOrderStat()에서 한 번만 저장한다 (중복 저장 방지)\n        return orderdao.insertOrderHist(vo);' } },
          { say: '작업 사본의 `OrderServiceImpl.java`를 고쳤습니다. 변경 검토에서 확인한 뒤 [적용]을 눌러 주세요.' },
        ],
      },
      {
        match: '중복|지워|삭제',
        steps: [
          { mcp: 'db_propose_change', input: { sql: 'DELETE FROM TB_ORDER_HIST WHERE HIST_SN IN (2, 4)', env: 'dev', description: '두 번 쌓인 주문 이력 2건을 지웁니다.', revert_sql: "INSERT INTO TB_ORDER_HIST VALUES (2,'O-1001','PAY','홍길동','010-1234-5678','2026-10-16 10:00:00'), (4,'O-1002','DLVY','김영희','010-2222-3333','2026-10-16 11:00:00')" } },
          { say: '중복 이력을 지우는 쿼리를 카드로 올렸습니다. 대상 DB와 예상 행 수를 확인한 뒤 [실행]을 눌러 주세요.' },
        ],
      },
    ],
    default: [{ say: '네, 확인했습니다.' }],
  };
  fs.writeFileSync(path.join(work, 'scenario.json'), JSON.stringify(scenario, null, 1));
}

async function main() {
  fs.mkdirSync(work, { recursive: true });
  prepare();
  const before = fs.readFileSync(path.join(proj, REL), 'utf8');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    DISPLAY: process.env.DISPLAY || '',
    XAUTHORITY: process.env.XAUTHORITY || '',
    LANG: 'ko_KR.UTF-8',
    PA_E2E: '1',
    PA_FAKE_NET: 'ok',
    PA_CLAUDE_CLI: path.join(ROOT, 'test/fake-claude/fake-claude.mjs'),
    PA_FAKE_STATE_DIR: path.join(work, 'fake-state'),
    PA_FAKE_SCENARIO: path.join(work, 'scenario.json'),
    PA_FAKE_DELAY: '1',
  };
  const app = await electron.launch({ executablePath: require(path.join(ROOT, 'desktop/node_modules/electron')), args: [appDir, '--no-sandbox', `--user-data-dir=${ud}`], cwd: appDir, env });
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, proj);
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  let n = 0;
  const shot = async (name) => {
    n += 1;
    const p = path.join(shots, `${String(n).padStart(2, '0')}-${name}.png`);
    await win.screenshot({ path: p });
    log('shot', path.basename(p));
  };
  const step = async (name, fn) => {
    log('▶', name);
    try {
      await fn();
    } catch (e) {
      await shot(`FAIL-${name}`).catch(() => {});
      throw new Error(`${name}: ${e.message}`);
    }
  };

  await step('분석', async () => {
    await win.click('button:has-text("폴더 선택")');
    await win.waitForSelector('text=불러오기 확인', { timeout: 30000 });
    await win.click('button:has-text("분석 시작")');
    await win.waitForSelector('text=분석 결과 요약', { timeout: 120000 });
    await sleep(400);
    await shot('summary');
  });

  await step('Claude 연결(POP-03)', async () => {
    await win.click('header button:has-text("Claude")');
    await win.waitForSelector('[role="dialog"]:has-text("Claude 연결")', { timeout: 10000 });
    await win.waitForSelector('button:has-text("연동 켜기"):not([disabled])', { timeout: 60000 });
    await shot('pop03');
    await win.click('button:has-text("연동 켜기")');
    await win.waitForSelector('[role="dialog"]:has-text("Claude 연결")', { state: 'detached', timeout: 15000 });
  });

  await step('DB 연결(POP-04)', async () => {
    await win.click('button.proj-chip');
    await win.waitForSelector('[role="dialog"][aria-label="프로젝트 연결"]', { timeout: 10000 });
    await win.click('button:has-text("DB 추가")');
    const dlg = win.locator('[role="dialog"]:has-text("DB 연결 추가")').last();
    await dlg.waitFor({ timeout: 10000 });
    await dlg.locator('[aria-label="환경"] button:has-text("개발")').click();
    await dlg.locator('[aria-label="DB 종류"] button:has-text("MariaDB")').click();
    await dlg.locator('input[placeholder="예) shop_dev"]').fill('shop_dev');
    await dlg.locator('input[placeholder="db-dev.company.local"]').fill('127.0.0.1');
    await dlg.locator('input[aria-label="포트"]').fill('3306');
    await dlg.locator('input[placeholder="예) shop"]').fill(DB.name);
    await dlg.locator('input[aria-label="계정"]').fill(DB.app);
    await dlg.locator('input[aria-label="계정 비밀번호"]').fill(DB.appPw);
    await dlg.locator('input[aria-label="조회 전용 계정"]').fill(DB.read);
    await dlg.locator('input[aria-label="조회 전용 계정 비밀번호"]').fill(DB.readPw);
    await dlg.locator('button:has-text("연결 확인")').click();
    await dlg.locator('.db-test.ok').waitFor({ timeout: 20000 });
    await shot('pop04-conn');
    await dlg.locator('button:has-text("저장")').click();
    await dlg.waitFor({ state: 'detached', timeout: 10000 });
    await sleep(300);
    await shot('pop04');
    await win.locator('[role="dialog"][aria-label="프로젝트 연결"] button:has-text("저장")').last().click();
    await win.waitForSelector('[role="dialog"][aria-label="프로젝트 연결"]', { state: 'detached', timeout: 10000 });
  });

  await step('화면 상세 → Claude에게 묻기', async () => {
    await win.fill('input[aria-label="트리 검색"]', 'orderDetail');
    await sleep(300);
    await win.locator('.trow[data-key^="s:"]').first().click();
    await win.waitForSelector('.main-col h1.page-title', { timeout: 10000 });
    await win.click('button:has-text("Claude에게 묻기")');
    await win.waitForSelector('aside[aria-label="Claude 대화"]', { timeout: 10000 });
    await sleep(300);
    await shot('chat-open');
    await win.fill('textarea[aria-label="Claude에게 보낼 내용"]', '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓여요. 원인을 찾아 주세요.');
    await win.press('textarea[aria-label="Claude에게 보낼 내용"]', 'Enter');
    await win.waitForSelector('aside[aria-label="Claude 대화"] button:has-text("수정 진행")', { timeout: 90000 });
    await sleep(300);
    await shot('chat-plan');
    await win.click('aside[aria-label="Claude 대화"] button:has-text("수정 진행")');
    await win.waitForSelector('aside[aria-label="Claude 대화"] button:has-text("변경 검토")', { timeout: 60000 });
    await win.waitForSelector('aside[aria-label="Claude 대화"] button[aria-label="보내기"]', { timeout: 30000 });
    await sleep(400);
    await shot('chat-changes');
  });

  await step('변경 검토 → 적용·커밋·푸시', async () => {
    await win.click('aside[aria-label="Claude 대화"] button:has-text("변경 검토")');
    await win.waitForSelector('text=OrderServiceImpl.java', { timeout: 15000 });
    await sleep(400);
    await shot('scr10');
    await win.locator('.main-col button.btn.primary:has-text("적용")').last().click();
    const dlg = win.locator('[role="dialog"]:has-text("변경 적용")');
    await dlg.waitFor({ timeout: 10000 });
    const commit = dlg.locator('label:has-text("적용 후 커밋") input[type="checkbox"]');
    if (!(await commit.isChecked())) await commit.check();
    const push = dlg.locator('label:has-text("커밋 후 푸시") input[type="checkbox"]');
    if (!(await push.isChecked())) await push.check();
    await shot('apply-dialog');
    await dlg.locator('button.btn.primary:has-text("적용")').click();
    await win.waitForSelector('text=작업 이력', { timeout: 60000 });
    await win.waitForSelector('text=분석 결과 요약', { state: 'detached', timeout: 1000 }).catch(() => {});
    // 다시 분석이 끝날 때까지
    await win.waitForSelector('.sts:has-text("분석 완료")', { timeout: 120000 });
    await sleep(1200);
    await shot('scr12-after-apply');
  });

  await step('쿼리 카드 실행', async () => {
    const box = 'textarea[aria-label="Claude에게 보낼 내용"]';
    if (!(await win.locator(box).count())) await win.click('header button:has-text("Claude")');
    await win.waitForSelector(box, { timeout: 10000 });
    await win.fill(box, '쌓인 중복 이력도 지워 주세요');
    await win.press(box, 'Enter');
    await win.waitForSelector('aside[aria-label="Claude 대화"] button:has-text("실행"):not([disabled])', { timeout: 60000 });
    await sleep(400);
    await shot('chat-query');
    await win.locator('aside[aria-label="Claude 대화"] button:has-text("실행"):not([disabled])').last().click();
    const dlg = win.locator('[role="dialog"]:has-text("쿼리 실행 확인")');
    await dlg.waitFor({ timeout: 10000 });
    await shot('query-confirm');
    await dlg.locator('button:has-text("실행")').last().click();
    await win.waitForSelector('aside[aria-label="Claude 대화"] :text("실행됨")', { timeout: 30000 });
    await sleep(400);
    await shot('chat-query-done');
  });

  await step('메뉴 DB 읽기 → 다시 분석', async () => {
    const inv = (ch, ...args) => win.evaluate(([c, a]) => window.__ELECTRON__.invoke(c, a), [ch, args]);
    const conns = (await inv('db.list', proj)).value;
    const r = await inv('project.set', proj, { menuDb: { enabled: true, connectionId: conns[0].id, table: 'TB_MENU', idCol: 'MENU_ID', parentCol: 'UPPER_MENU_ID', nameCol: 'MENU_NM', urlCol: 'MENU_URL', orderCol: 'MENU_ORDR' } });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await win.click('header button:has-text("Run")');
    await win.click('[role="dialog"] button:has-text("다시 분석")');
    await win.waitForSelector('.sts:has-text("분석 완료")', { timeout: 120000 });
    await sleep(800);
    const menuCat = await win.locator('.trow.cat:has-text("메뉴")').first().innerText();
    if (!/\b4\b/.test(menuCat.replace(/\s+/g, ' '))) throw new Error(`DB 메뉴 수가 다름: ${menuCat}`);
    await win.click('header button:has-text("이력")').catch(() => {});
  });

  await step('작업 이력 → 되돌리기', async () => {
    await win.click('header button:has-text("이력")');
    await sleep(300);
    if (await win.locator('header button:has-text("이력").pressed').count() === 0) {
      // 이미 이력이 열려 있었다면 한 번 더 눌러 닫혔을 수 있음
      if (!(await win.locator('text=CSV 내보내기').count())) await win.click('header button:has-text("이력")');
    }
    await win.waitForSelector('text=CSV 내보내기', { timeout: 10000 });
    await win.locator('.main-col :text("코드 적용")').first().click().catch(() => {});
    await sleep(400);
    await shot('scr12');
    await win.locator('.main-col button.btn.danger:has-text("되돌리기")').first().click();
    const dlg = win.locator('[role="dialog"]:has-text("변경 되돌리기")');
    await dlg.waitFor({ timeout: 10000 });
    await dlg.locator('button:has-text("되돌리기")').last().click();
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    await win.waitForSelector('.sts:has-text("분석 완료")', { timeout: 120000 });
    await sleep(1500);
    await shot('scr12-reverted');
  });

  // 결과 확인
  const after = fs.readFileSync(path.join(proj, REL), 'utf8');
  const gitLog = sh('git', ['-C', proj, 'log', '--format=%s', '-5']).trim().split('\n');
  const remoteLog = sh('git', ['-C', remote, 'log', '--format=%s', '-3', 'main']).trim().split('\n');
  const rows = sh('mysql', ['-uroot', '-N', '-e', `SELECT GROUP_CONCAT(HIST_SN ORDER BY HIST_SN) FROM ${DB.name}.TB_ORDER_HIST`]).trim();
  const dataDir = ud;
  const projects = fs.readdirSync(path.join(dataDir, 'projects'));
  const hist = fs.readFileSync(path.join(dataDir, 'projects', projects[0], 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const secretsRaw = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8');
  const result = {
    restoredAfterRevert: after === before,
    gitLog,
    remoteLog,
    dbRows: rows,
    historyKinds: hist.filter((h) => h.t === 'add').map((h) => `${h.e.kind}:${h.e.status}`),
    passwordInPlainText: secretsRaw.includes(DB.appPw) || secretsRaw.includes(DB.readPw),
    errors,
  };
  console.log(JSON.stringify(result, null, 1));
  await app.close();
  const ok = result.restoredAfterRevert && rows === '1,3,5' && !result.passwordInPlainText && errors.length === 0;
  console.log(ok ? 'E2E OK' : 'E2E 확인 필요');
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error('E2E 실패:', e.message);
  process.exit(1);
});
