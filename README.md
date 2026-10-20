# 프로젝트 분석 시스템 (project_management)

프로젝트 폴더를 불러와 **[Run]** 을 누르면 어떤 시스템인지와 **DB 테이블·메뉴·화면·배치**의 관계를 정리해 보여 주는 분석 도구입니다.
Windows 데스크톱 앱(Electron)과 파일 하나짜리 HTML로 동작하고, 분석은 인터넷 없이 PC 안에서 끝납니다.

- 현재 버전: **v0.6.0** (프로토타입) · 버전별 변경은 [CHANGELOG.md](CHANGELOG.md)
  - 분석 엔진·결과 화면 (Java·JSP·MyBatis, PHP, Go, Python, Android·React Native·Flutter, 셸·배치)
  - 데스크톱 앱: AI 연동 — Claude(PC의 Claude Code)·Gemini(Gemini API·회사 Google Cloud)·ChatGPT(PC의 Codex CLI) 중에서 골라
    대화형 이슈 처리·수정·새 프로젝트, 모델 선택, 대화 중 다른 AI로 새 대화(이전 대화를 맥락으로), 설정 > AI 연결에서 계정·연동 관리.
    형상관리(Git·SVN)·작업 이력, DB 연결(조회 도구·쿼리 확인 실행·메뉴 DB 읽기)
- 다음: Excel·HTML 보고서 내보내기, JavaScript(Express·NestJS·React·Vue) 화면 추출, AI 요약

## 분석 대상

| 구분 | 지원 |
| --- | --- |
| 웹·서버 | Java·JSP·Spring MVC(전자정부 표준프레임워크)·MyBatis·iBatis, PHP(Laravel·CodeIgniter·순수 PHP), Go(Gin·Echo·net/http), Python(Django·Flask·FastAPI) |
| 앱 | Android(Java·Kotlin), React Native, Flutter, 하이브리드 WebView — 앱 화면의 API 호출을 서버 라우트와 이어 사용 테이블까지 |
| 배치 | 셸·배치·PowerShell·Python 스크립트, crontab, Windows 작업 스케줄러(XML), Spring @Scheduled |
| DB | Oracle, MySQL, MariaDB (DDL·매퍼·코드 안 SQL) |

## 구조

```
src/engine/    분석 엔진 (브라우저 Web Worker·Electron·Node 어디서나 같은 코드)
  analyzers/   언어·프레임워크별 분석기 (java, jsp, mybatis, php, go, python, kotlin, android, rn, flutter, batch …)
  link.ts      화면 → URL → 컨트롤러 → 서비스 → SQL → 테이블 연결, 메뉴·배치 연결
src/ui/        화면 (Preact)
  desktop/     데스크톱 전용 화면: AI 대화(ai/ AI 연결 설정·AI·모델 고르기), 변경 검토, 작업 이력, 프로젝트 연결(형상관리·DB)
src/desktop/   Electron 메인 프로세스
  claude/      대화 관리(모든 AI 공통: 권한 확인·작업 사본·DB 도구·대화 저장)와 Claude(Agent SDK) 연동
  ai/          AI 공통(기본 AI·셸 허용 목록), 앱 도구(파일·검색·명령·DB) — Gemini·ChatGPT가 같이 씀
  gemini/      Gemini API(REST) 직접 연결     openai/  Codex CLI(app-server) 연결
  work/ vcs/ db/  작업 사본·Git·SVN, DB 드라이버
src/shared/    화면 ↔ 메인 프로세스 계약(desktop-api.ts), 접속 정보 가리기
src/platform/  폴더·ZIP 읽기 (브라우저 / Electron)
desktop/       Electron 패키징 설정 (electron-builder)
fixtures/      검증용 예제 프로젝트 (gen_*.py로 생성)
test/          엔진·데스크톱 모듈 시험
docs/          사용방법
```

## 실행 (Windows, 소스에서)

Node.js 22 LTS를 설치한 뒤 PowerShell(또는 cmd)에서:

```
git clone https://github.com/Flowerkh/project_management.git
cd project_management
npm start
```

- `npm start` 하나로 패키지 설치 → 빌드 → 실행까지 합니다. 설치는 처음이거나 패키지 목록(package-lock.json)이 바뀌었을 때만 하고, 처음에는 몇 분 걸립니다.
- 저장소 폴더와 `desktop` 폴더 어디서 실행해도 됩니다. 새 코드를 받을 때는 `git pull` 뒤 `npm start`.
- 앱을 켜 둔 채 `npm start`를 하면 열린 앱이 새 버전으로 다시 시작할지 묻습니다. `npx electron .`은 다시 빌드하지 않으므로 받은 소스가 더 새로우면 경고만 띄웁니다.
- 실행 파일(zip) 만들기: `npm run package` → `release\ProjectAnalyzer-<버전>-win.zip` (몇 분 걸림. 압축을 풀고 `ProjectAnalyzer.exe`)
- 브라우저용 HTML 한 파일: `node scripts/build.mjs` → `dist\web\project-analyzer.html` (AI·형상관리·DB 기능은 데스크톱 앱에서만)
- `node scripts\…` 명령은 저장소 폴더에서 실행합니다. `desktop` 폴더 안에서는 스크립트를 찾지 못합니다.
- `git pull`이 package-lock.json의 로컬 변경 때문에 멈추면: `git restore package-lock.json desktop/package-lock.json` 뒤 다시 `git pull`

사용법은 [docs/사용방법.txt](docs/사용방법.txt).

## 개발

```bash
npm install
(cd desktop && npm install)

npx tsc --noEmit -p .              # 타입 검사
npx tsx --test test/*.test.ts      # 시험
npm start                          # 설치 확인 → 빌드 → 데스크톱 앱 실행 (npm start -- --dev: 코드를 줄이지 않고 빌드)
npm run package                    # release/ProjectAnalyzer-<버전>-win.zip (Windows x64, 설치 없이 압축 풀어 실행)
node scripts/build.mjs             # dist/web/project-analyzer.html (오프라인 HTML 한 파일), dist/app
npx tsx scripts/analyze.ts <폴더>  # 명령줄 분석 (결과 JSON)
```

화면 미리보기: `dist/web/project-analyzer.html?mock=1` (데스크톱 기능 미리보기는 `?mock=1&desk`, AI 연결 설정은 `&dmodal=ai|claude|gemini|openai`,
기본 AI·상태는 `&ai=gemini|openai&gstate=on&ostate=login` 등 — `src/ui/desktop/mock/ai.ts`).

통합 점검(리눅스, xvfb): `node scripts/build-desktop.mjs --dev --out /tmp/pa/app` 뒤
`xvfb-run -a node scripts/e2e-desktop.cjs /tmp/pa/app /tmp/pa/e2e` (분석 → Claude(가짜 CLI) → DB(MariaDB) → 변경 적용·커밋·푸시 → 쿼리 실행 → 되돌리기),
`scripts/e2e-newproject.cjs` (새 프로젝트), `scripts/e2e-ui.cjs` (버전 표시·프로젝트 목록·모델 선택·표·크게 보기·대화 지우기·
설정 > Claude(계정 바꾸기·연동 끄기)·대화창 너비), `scripts/e2e-ai.cjs` (Gemini(가짜 서버)·ChatGPT(가짜 Codex) 연동 켜기·기본 AI·
모델 바꾸기·로그인 필요·다른 AI로 새 대화·연동 끄기). 실제 Codex와의 호환은 격리된 시험으로:
`PA_REAL_CODEX=<codex 경로> npx tsx --test test/desktop-openai-real.test.ts` (가짜 OpenAI 서버, 실제 계정·키를 쓰지 않음).

## 버전

`package.json`과 `desktop/package.json`의 version을 같이 올리고(`npm version <버전> --no-git-tag-version`을 두 폴더에서 — package-lock.json도 함께 바뀜),
[CHANGELOG.md](CHANGELOG.md)에 바뀐 내용을 적습니다. 앱 상단에 `v0.6.1`처럼 보입니다(끝자리가 0이면 생략해 `v0.6`).

## 원칙

- 소스는 PC 밖으로 나가지 않습니다. AI 연동을 켤 때만, 동의한 범위(질문·붙인 분석 결과·AI가 읽은 소스 일부·가린 조회 결과)가
  그 AI(Anthropic·Google·OpenAI 또는 고른 회사 클라우드)로 전송됩니다.
- DB 접속 정보(주소·계정·비밀번호)는 화면·소스 보기·AI에 보이지 않게 가립니다. 접속 정보 파일과 프로젝트 밖의 파일은 AI에 보내지 않습니다.
- AI가 고친 코드와 SELECT가 아닌 쿼리는 사용자가 확인([적용]·[실행])한 뒤에만 원본과 DB에 반영됩니다. 운영 DB 조회는 항상 확인합니다.
  셸 명령은 허용 목록에 있는 것만, 실행할 때마다 확인합니다. 세 AI 모두 같은 규칙입니다(Codex의 자체 도구는 끄고 앱 도구만 씀).
- 앱은 Claude Code·Codex를 수정하지 않고 로그인 정보(토큰)를 읽거나 저장하지 않습니다(로그인은 각 CLI 자체 화면에서).
  계정 이름(이메일·조직·구독)은 CLI가 알려 준 것을 화면에만 보여 주고 저장하지 않습니다. API 키는 Windows 사용자 계정으로 암호화해 저장합니다.

개인 사용 목적의 프로토타입입니다.
