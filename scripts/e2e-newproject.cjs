// 새 프로젝트(SCR-11) 통합 점검: 메인 [새 프로젝트] → 빈 폴더 → 요구사항 → 계획 → [계획 확정] → 생성 → 분석
//   node scripts/build-desktop.mjs --dev --out <scratch>/app
//   xvfb-run -a node scripts/e2e-newproject.cjs <scratch>/app <scratch>/e2e-new
// Claude는 가짜 CLI(test/fake-claude)로 흉내 낸다 (실제 Claude·계정을 쓰지 않음).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');
const { _electron: electron } = require(path.join(ROOT, 'desktop/node_modules/playwright-core'));

const appDir = path.resolve(process.argv[2] || path.join(ROOT, 'desktop'));
const work = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'e2e-new'));
const shots = path.join(work, 'shots');
const folder = path.join(work, 'cs-inquiry');
const ud = path.join(work, 'userdata');
const home = path.join(work, 'home');
const bin = path.join(work, 'bin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN = [
  '### 요구사항',
  '- 고객 문의 목록·상세·답변 등록',
  '- 답변하면 문의 상태를 답변 완료로 바꿈',
  '### 계획',
  '- **기본 구성** — pom.xml',
  '- **테이블 1개** — TB_INQUIRY (DDL)',
  '- **소스 3개** — InquiryController·InquiryService·InquiryMapper.xml',
  '- **화면 2개** — 문의 목록·문의 상세 JSP',
].join('\n');

const JAVA_CTRL = `package egov.cs.inquiry.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import egov.cs.inquiry.service.InquiryService;

@Controller
public class InquiryController {
    private InquiryService inquiryService;

    @RequestMapping("/inquiry/list.do")
    public String list() throws Exception {
        inquiryService.selectInquiryList();
        return "inquiry/list";
    }

    @RequestMapping("/inquiry/detail.do")
    public String detail() throws Exception {
        inquiryService.selectInquiry();
        return "inquiry/detail";
    }
}
`;
const JAVA_SVC = `package egov.cs.inquiry.service;

import org.springframework.stereotype.Service;
import org.mybatis.spring.SqlSessionTemplate;

@Service
public class InquiryService {
    private SqlSessionTemplate sqlSession;

    public Object selectInquiryList() { return sqlSession.selectList("inquiry.selectInquiryList"); }
    public Object selectInquiry() { return sqlSession.selectOne("inquiry.selectInquiry"); }
}
`;
const MAPPER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="inquiry">
  <select id="selectInquiryList" resultType="map">SELECT INQ_ID, TITLE, STAT_CD FROM TB_INQUIRY ORDER BY INQ_ID DESC</select>
  <select id="selectInquiry" resultType="map">SELECT * FROM TB_INQUIRY WHERE INQ_ID = #{inqId}</select>
</mapper>
`;

function prepare() {
  for (const d of [shots, folder, ud, home, bin, path.join(work, 'fake-state')]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [shots, folder, home, bin]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const scenario = {
    probe: [{ say: 'OK' }],
    turns: [
      {
        steps: [
          { say: `요구사항과 계획을 정리했습니다.\n\n${PLAN}` },
          { tool: 'ExitPlanMode', input: { plan: PLAN } },
          { tool: 'Write', input: { file_path: 'pom.xml', content: '<project><modelVersion>4.0.0</modelVersion><groupId>egov.cs</groupId><artifactId>cs-inquiry</artifactId><dependencies><dependency><groupId>org.egovframe.rte</groupId><artifactId>org.egovframe.rte.fdl.cmmn</artifactId></dependency><dependency><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId></dependency><dependency><groupId>org.mybatis</groupId><artifactId>mybatis</artifactId></dependency></dependencies></project>\n' } },
          { tool: 'Write', input: { file_path: 'db/ddl.sql', content: "CREATE TABLE TB_INQUIRY (\n  INQ_ID NUMBER PRIMARY KEY,\n  TITLE VARCHAR2(200),\n  STAT_CD VARCHAR2(10)\n);\nCOMMENT ON TABLE TB_INQUIRY IS '고객 문의';\n" } },
          { tool: 'Write', input: { file_path: 'src/main/java/egov/cs/inquiry/web/InquiryController.java', content: JAVA_CTRL } },
          { tool: 'Write', input: { file_path: 'src/main/java/egov/cs/inquiry/service/InquiryService.java', content: JAVA_SVC } },
          { tool: 'Write', input: { file_path: 'src/main/resources/mapper/InquiryMapper.xml', content: MAPPER } },
          { tool: 'Write', input: { file_path: 'src/main/webapp/WEB-INF/jsp/inquiry/list.jsp', content: '<%@ page contentType="text/html; charset=UTF-8" %>\n<html><head><title>문의 목록</title></head><body><a href="/inquiry/detail.do">상세</a></body></html>\n' } },
          { tool: 'Write', input: { file_path: 'src/main/webapp/WEB-INF/jsp/inquiry/detail.jsp', content: '<%@ page contentType="text/html; charset=UTF-8" %>\n<html><head><title>문의 상세</title></head><body></body></html>\n' } },
          { say: '계획한 파일 7개를 만들었습니다.' },
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
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    DISPLAY: process.env.DISPLAY || '',
    XAUTHORITY: process.env.XAUTHORITY || '',
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
  }, folder);
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  let n = 0;
  const shot = async (name) => {
    n += 1;
    await win.screenshot({ path: path.join(shots, `${String(n).padStart(2, '0')}-${name}.png`) });
  };
  try {
    await win.waitForSelector('button:has-text("새 프로젝트")', { timeout: 15000 });
    await shot('home');
    await win.click('button:has-text("새 프로젝트")');
    // 연동이 꺼져 있으면 설정 > Claude 연결(POP-03)부터
    await win.waitForSelector('[role="dialog"][aria-label="설정"] #set-page-claude', { timeout: 10000 });
    await win.waitForSelector('#set-page-claude button:has-text("연동 켜기"):not([disabled])', { timeout: 60000 });
    await win.click('#set-page-claude button:has-text("연동 켜기")');
    await win.waitForSelector('[role="dialog"][aria-label="설정"]', { state: 'detached', timeout: 15000 });
    await win.click('button:has-text("새 프로젝트")');
    await win.waitForSelector('[aria-label="진행 단계"]', { timeout: 10000 });
    await win.click('[aria-label="프로젝트 정보"] button:has-text("폴더 선택")');
    await sleep(500);
    await shot('folder');
    const box = 'textarea[aria-label="만들 프로젝트 설명"]';
    await win.fill(box, '고객 문의 관리 화면을 만들어 주세요. 목록·상세·답변 등록이 필요합니다.');
    await win.press(box, 'Enter');
    await win.waitForSelector('button:has-text("계획 확정"):not([disabled])', { timeout: 60000 });
    await sleep(400);
    await shot('plan');
    await win.click('button:has-text("계획 확정")');
    await win.waitForSelector('button:has-text("분석 시작"), button:has-text("지금 분석")', { timeout: 60000 });
    await sleep(400);
    await shot('generated');
    await win.locator('button:has-text("분석 시작"), button:has-text("지금 분석")').first().click();
    await win.waitForSelector('text=불러오기 확인, text=분석 결과 요약', { timeout: 60000 }).catch(() => {});
    await win.waitForSelector('text=분석 결과 요약', { timeout: 120000 });
    await sleep(600);
    await shot('analyzed');
    const cats = await win.evaluate(() => [...document.querySelectorAll('.trow.cat')].map((r) => r.innerText.replace(/\s+/g, ' ')));
    const files = fs.readdirSync(folder, { recursive: true }).filter((f) => fs.statSync(path.join(folder, f)).isFile());
    console.log(JSON.stringify({ tree: cats, files: files.length, errors }, null, 1));
    const ok = files.length >= 7 && cats.some((c) => /화면 2/.test(c)) && cats.some((c) => /DB 테이블 1/.test(c)) && !errors.length;
    console.log(ok ? 'E2E OK' : 'E2E 확인 필요');
    await app.close();
    process.exit(ok ? 0 : 2);
  } catch (e) {
    await shot('FAIL').catch(() => {});
    console.error('E2E 실패:', e.message, errors);
    await app.close().catch(() => {});
    process.exit(1);
  }
}

main();
