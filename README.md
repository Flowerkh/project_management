# 프로젝트 분석 시스템 (project_management)

프로젝트 폴더를 불러와 **[Run]** 을 누르면 어떤 시스템인지와 **DB 테이블·메뉴·화면·배치**의 관계를 정리해 보여 주는 분석 도구입니다.
Windows 데스크톱 앱(Electron)과 파일 하나짜리 HTML로 동작하고, 분석은 인터넷 없이 PC 안에서 끝납니다.

- 현재 버전: **v0.5** (프로토타입) · 버전별 변경은 [CHANGELOG.md](CHANGELOG.md)
  - 분석 엔진·결과 화면 (Java·JSP·MyBatis, PHP, Go, Python, Android·React Native·Flutter, 셸·배치)
  - 데스크톱 앱: Claude 연동(대화형 이슈 처리·수정·새 프로젝트, 모델 선택), 형상관리(Git·SVN)·작업 이력, DB 연결(조회 도구·쿼리 확인 실행·메뉴 DB 읽기)
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
  desktop/     데스크톱 전용 화면: Claude 대화, 변경 검토, 작업 이력, 프로젝트 연결(형상관리·DB)
src/desktop/   Electron 메인 프로세스 (Claude Agent SDK 연동, 작업 사본·Git·SVN, DB 드라이버)
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
- 브라우저용 HTML 한 파일: `node scripts/build.mjs` → `dist\web\project-analyzer.html` (Claude·형상관리·DB 기능은 데스크톱 앱에서만)
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

화면 미리보기: `dist/web/project-analyzer.html?mock=1` (데스크톱 기능 미리보기는 `?mock=1&desk`).

통합 점검(리눅스, xvfb): `node scripts/build-desktop.mjs --dev --out /tmp/pa/app` 뒤
`xvfb-run -a node scripts/e2e-desktop.cjs /tmp/pa/app /tmp/pa/e2e` (분석 → Claude(가짜 CLI) → DB(MariaDB) → 변경 적용·커밋·푸시 → 쿼리 실행 → 되돌리기),
`scripts/e2e-newproject.cjs` (새 프로젝트), `scripts/e2e-ui.cjs` (버전 표시·프로젝트 목록·모델 선택·표·크게 보기·대화 지우기).

## 버전

`package.json`과 `desktop/package.json`의 version을 같이 올리고(`npm version <버전> --no-git-tag-version`을 두 폴더에서 — package-lock.json도 함께 바뀜),
[CHANGELOG.md](CHANGELOG.md)에 바뀐 내용을 적습니다. 앱 상단에 `v0.5`처럼 보입니다(끝자리가 0이면 생략).

## 원칙

- 소스는 PC 밖으로 나가지 않습니다. Claude 연동을 켤 때만, 동의한 범위(질문·붙인 분석 결과·Claude가 읽은 소스 일부·가린 조회 결과)가 Claude로 전송됩니다.
- DB 접속 정보(주소·계정·비밀번호)는 화면·소스 보기·Claude에 보이지 않게 가립니다.
- Claude가 고친 코드와 SELECT가 아닌 쿼리는 사용자가 확인([적용]·[실행])한 뒤에만 원본과 DB에 반영됩니다. 운영 DB 조회는 항상 확인합니다.
- 앱은 Claude Code를 수정하지 않고 Claude 계정 정보를 읽거나 저장하지 않습니다(로그인은 Claude Code 자체 화면에서).

개인 사용 목적의 프로토타입입니다.
