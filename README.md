# 프로젝트 분석 시스템 (project_management)

프로젝트 폴더를 불러와 **[Run]** 을 누르면 어떤 시스템인지와 **DB 테이블·메뉴·화면·배치**의 관계를 정리해 보여 주는 분석 도구입니다.
Windows 데스크톱 앱(Electron)과 파일 하나짜리 HTML로 동작하고, 분석은 인터넷 없이 PC 안에서 끝납니다.

- 현재 버전: **v0.3** (프로토타입) — 분석 엔진·결과 화면, Python·앱 분석
- 진행 중(3단계 MVP): Claude 연동(대화형 이슈 처리·수정·새 프로젝트), 형상관리(Git·SVN)·작업 이력, DB 연결(조회 도구·쿼리 확인 실행·메뉴 DB 읽기)

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

## 개발

```bash
npm install
(cd desktop && npm install)

npx tsc --noEmit -p .              # 타입 검사
npx tsx --test test/*.test.ts      # 시험
node scripts/build.mjs             # dist/web/project-analyzer.html (오프라인 HTML 한 파일), dist/app
sh scripts/build-desktop.sh        # release/ProjectAnalyzer-<버전>-win.zip (Windows x64, 설치 없이 압축 풀어 실행)
npx tsx scripts/analyze.ts <폴더>  # 명령줄 분석 (결과 JSON)
```

화면 미리보기: `dist/web/project-analyzer.html?mock=1` (데스크톱 기능 미리보기는 `?mock=1&desk`).

## 원칙

- 소스는 PC 밖으로 나가지 않습니다. Claude 연동을 켤 때만, 동의한 범위(질문·붙인 분석 결과·Claude가 읽은 소스 일부·가린 조회 결과)가 Claude로 전송됩니다.
- DB 접속 정보(주소·계정·비밀번호)는 화면·소스 보기·Claude에 보이지 않게 가립니다.
- Claude가 고친 코드와 SELECT가 아닌 쿼리는 사용자가 확인([적용]·[실행])한 뒤에만 원본과 DB에 반영됩니다. 운영 DB 조회는 항상 확인합니다.
- 앱은 Claude Code를 수정하지 않고 Claude 계정 정보를 읽거나 저장하지 않습니다(로그인은 Claude Code 자체 화면에서).

개인 사용 목적의 프로토타입입니다.
