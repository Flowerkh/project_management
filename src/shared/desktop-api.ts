// 데스크톱(Electron) 메인 프로세스와 화면 사이의 약속.
// 화면은 window.__ELECTRON__.invoke(channel, ...args) 로 부르고, 메인은 'desktop:event' 로 이벤트를 보낸다.
// 브라우저(HTML) 빌드에는 이 기능이 없다: Claude 연동·형상관리·작업 이력·DB 연결은 데스크톱 앱 전용.

// ------------------------------------------------------------------ 공통

export type Env = 'dev' | 'qa' | 'prod';
export const ENV_LABEL: Record<Env, string> = { dev: '개발', qa: 'QA', prod: '운영' };
export type DbKind = 'oracle' | 'mysql' | 'mariadb';

export interface AppInfo {
  version: string;
  platform: string;          // win32 / linux / darwin
  userData: string;
}

/** 프로젝트 = 분석한 폴더 (PC의 절대 경로) */
export interface ProjectSettings {
  root: string;
  name: string;
  /** 변경 적용 확인 창의 기본값 */
  applyDefaults: { commit: boolean; push: boolean };
  /** DB 연결 (비밀번호는 화면에 보내지 않음) */
  db: DbConnection[];
  dbRules: Record<Env, EnvRule>;
  /** 개인정보 가림 컬럼 패턴 (*_TEL 등). '*_NM:이름·성명' 처럼 주석 조건이 붙은 항목 포함 */
  maskPatterns: string[];
  /** 메뉴를 DB에서 읽기 */
  menuDb?: MenuDbSetting;
}

export interface EnvRule {
  /** Claude의 SELECT: 바로 실행 / 매번 확인 (운영은 항상 confirm, 끌 수 없음) */
  selectMode: 'auto' | 'confirm';
  maxRows: number;
  timeoutSec: number;
  /** SELECT 외 쿼리: 확인 창 / DB 이름 입력 확인 */
  changeMode: 'confirm' | 'typeName';
  mask: boolean;
}

export const DEFAULT_RULES: Record<Env, EnvRule> = {
  dev: { selectMode: 'auto', maxRows: 200, timeoutSec: 30, changeMode: 'confirm', mask: false },
  qa: { selectMode: 'auto', maxRows: 200, timeoutSec: 30, changeMode: 'confirm', mask: false },
  prod: { selectMode: 'confirm', maxRows: 100, timeoutSec: 10, changeMode: 'typeName', mask: true },
};

/** 개인정보 가림 대상 기본값 (2026-10-17 답변: 이름·전화번호·이메일·주소·주민등록번호·생년월일·계좌번호·카드번호).
 *  '*_NM:이름·성명' = 컬럼명이 *_NM이고 주석에 이름·성명이 있을 때만. 값이 전화번호·이메일·주민등록번호·카드번호 모양이면 컬럼명과 상관없이 가림 */
export const DEFAULT_MASK = ['*_NM:이름·성명', '*_TEL', '*_HP', '*_EMAIL', '*_ADDR', '*_RRN', '*_BIRTH', '*_ACCT', '*_CARD'];

// ------------------------------------------------------------------ DB

export interface DbConnection {
  id: string;
  env: Env;
  kind: DbKind;
  /** 화면에 보이는 DB 이름 (shop_dev) */
  name: string;
  host: string;
  port: number;
  /** Oracle 서비스 이름(또는 SID) */
  service?: string;
  /** (Oracle) service가 SID임. '('로 시작하는 service는 연결 설명자 그대로 */
  sid?: boolean;
  /** MySQL·MariaDB 데이터베이스 */
  database?: string;
  user: string;
  hasPassword: boolean;
  /** 조회 전용 계정 (선택, 권장): Claude 조회와 메뉴 읽기에 씀 */
  readUser?: string;
  hasReadPassword?: boolean;
  /** Oracle 11g 이하: Thick 모드 (Oracle Client 19 이상 필요) */
  thick?: boolean;
  lastTest?: { ok: boolean; at: string; message?: string; version?: string };
}

/** 저장할 때만 비밀번호를 같이 보낸다 (비우면 기존 값 유지) */
export interface DbConnectionInput extends Omit<DbConnection, 'hasPassword' | 'hasReadPassword' | 'lastTest'> {
  password?: string;
  readPassword?: string;
}

export interface DbTestResult {
  ok: boolean;
  message: string;
  version?: string;
  /** MySQL·MariaDB 구분 결과 */
  detectedKind?: DbKind;
  ms: number;
}

export interface MenuDbSetting {
  enabled: boolean;
  connectionId: string;
  table: string;
  idCol: string;
  parentCol: string;
  nameCol: string;
  urlCol: string;
  orderCol?: string;
  where?: string;
}

export interface MenuRow {
  key: string;
  parentKey?: string;
  name: string;
  url?: string;
  order?: number;
}

export interface MenuReadResult {
  /** 메뉴 DB 읽기를 켰는지 (끄면 rows는 빔) */
  enabled: boolean;
  table?: string;
  connectionName?: string;
  rows: MenuRow[];
  /** 켰는데 읽지 못함 → MSG-43 */
  error?: string;
  ms?: number;
}

export interface QueryResult {
  columns: { name: string; masked?: boolean }[];
  rows: (string | number | null)[][];
  /** 돌려준 행 수 */
  rowCount: number;
  /** 행 수 제한에 걸림 */
  truncated: boolean;
  ms: number;
  maskedColumns: string[];
}

export interface ExecResult {
  ok: boolean;
  affected: number;
  expected?: number;
  rolledBack?: boolean;
  ms: number;
  error?: string;
  historyId?: string;
}

/** Claude가 제안한 SELECT 외 쿼리 (쿼리 카드) */
export interface QueryCard {
  id: string;
  root: string;
  conversationId?: string;
  env: Env;
  connectionId: string;
  dbName: string;
  kind: 'insert' | 'update' | 'delete' | 'merge' | 'ddl' | 'call' | 'other';
  sql: string;
  description?: string;
  /** 예상 영향 행 수 (COUNT로 계산, 못 하면 없음) */
  estimate?: number;
  /** 예상 행 수를 못 구한 이유 (없으면 실행 즉시 확정되므로 되돌릴 수 없는 쿼리처럼 한 번 더 확인) */
  estimateNote?: string;
  /** DDL·프로시저 등 롤백할 수 없는 문장 */
  irreversible: boolean;
  revertSql?: string;
  /** 실행 계정이 조회 전용뿐이면 SQL 복사만 가능 (MSG-39) */
  canExecute: boolean;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rolledback' | 'rejected';
  result?: ExecResult;
  createdAt: string;
}

// ------------------------------------------------------------------ 형상관리·작업 사본

export interface VcsInfo {
  kind: 'git' | 'svn' | 'none';
  /** git·svn 명령을 PC에서 찾음 */
  toolFound: boolean;
  repoRoot?: string;
  branch?: string;
  /** 커밋 해시(짧게) 또는 SVN 리비전 */
  head?: string;
  remote?: string;
  /** '사내 GitLab' 같은 표시용 이름 */
  hostLabel?: string;
  /** 원본의 커밋 안 된 변경 수 */
  dirty?: number;
  error?: string;
}

/** POP-04 ③ 연결 확인 */
export interface VcsCheck {
  /** 원격 저장소 연결 (git ls-remote / svn info URL). 형상관리 없으면 없음 */
  remote?: { ok: boolean; message: string };
  /** 작업 사본을 만들 앱 작업 폴더의 여유 공간 */
  space: { ok: boolean; freeBytes: number; path: string };
  /** PC에 저장된 로그인 안내 (예: 'Git Credential Manager') — 계정 정보 자체는 읽지 않음 */
  login?: string;
}

/** Claude가 고치는 프로젝트 사본: 원본의 현재 상태를 앱 작업 폴더에 복사 */
export interface WorkCopy {
  id: string;
  root: string;
  path: string;
  createdAt: string;
  conversationId?: string;
  fileCount: number;
  /** 만들 때 원본의 형상관리 상태 (화면 표시: 'develop 9c1e2ab 기준') */
  base?: { kind: VcsInfo['kind']; branch?: string; head?: string; dirty?: number };
  /** 값을 가린 접속 정보 파일 수 (Claude가 비밀 값을 보지 못함) */
  redacted?: number;
  /** (work.list) 아직 적용하지 않은 변경 파일 수 */
  changed?: number;
}

export interface DiffLine {
  t: ' ' | '+' | '-';
  s: string;
  /** 원본 줄 번호 / 작업 사본 줄 번호 */
  o?: number;
  n?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  /** 바뀐 곳을 감싼 함수·메서드 이름(예: 'updateDlvyInfo()') 또는 매퍼 SQL id */
  fn?: string;
}

export interface FileChange {
  /** 프로젝트 폴더 기준 상대 경로 ('/' 구분) */
  path: string;
  status: 'modified' | 'added' | 'deleted';
  plus: number;
  minus: number;
  binary?: boolean;
  hunks: DiffHunk[];
  /** 작업 사본을 만든 뒤 원본 파일이 바뀜 → 그대로 적용 불가 (MSG-31) */
  conflict?: boolean;
  /** 적용할 수 없는 파일과 이유 (접속 정보 파일, 가린 값을 고친 줄 등) */
  blocked?: string;
  /** 작업 사본을 만들 때 원본에 이미 커밋 안 된 변경이 있던 파일 (커밋하면 그 변경도 함께 들어감) */
  dirtyBase?: boolean;
  /** 원본 인코딩이 UTF-8이 아님 (작업 사본은 UTF-8, 적용할 때 원래 인코딩으로 저장) */
  encoding?: 'EUC-KR' | 'UTF-16';
  /** 작업 사본에서 비밀 값을 가린 파일 (적용할 때 가린 값은 원본 값으로 되돌림) */
  redacted?: boolean;
}

export interface ApplyRequest {
  files: string[];
  commit: boolean;
  push: boolean;
  message?: string;
  title: string;
  conversationId?: string;
}

export interface ApplyResult {
  ok: boolean;
  historyId?: string;
  conflicts?: string[];
  applied: string[];
  commit?: { ok: boolean; hash?: string; error?: string };
  push?: { ok: boolean; error?: string };
}

// ------------------------------------------------------------------ 작업 이력

/** apply 코드 적용 / revert 되돌리기 / query SELECT 외 쿼리 실행 / prod-select 운영 조회(목록에 보임) / select 개발·QA 조회(CSV에만) / commit 나중에 다시 시도한 커밋·푸시 */
export type HistoryKind = 'apply' | 'revert' | 'query' | 'prod-select' | 'select' | 'commit';
export type HistoryStatus = '적용됨' | '커밋됨' | '푸시됨' | '되돌림' | '실행됨' | '롤백됨' | '실패' | '조회';

export interface HistoryEntry {
  id: string;
  at: string;
  kind: HistoryKind;
  title: string;
  status: HistoryStatus;
  files?: { path: string; status: FileChange['status']; plus: number; minus: number }[];
  commit?: string;
  branch?: string;
  pushed?: boolean;
  db?: { env: Env; name: string; account: string };
  sql?: string;
  affected?: number;
  expected?: number;
  ms?: number;
  maskedColumns?: string[];
  error?: string;
  conversationId?: string;
  /** 이 항목이 나중에 되돌려짐 */
  revertedBy?: string;
  /** 이 항목이 되돌린 원래 항목 */
  revertOf?: string;
  revertSql?: string;
  /** 진행 기록 (적용 → 커밋 → 푸시 → 다시 분석 …) */
  steps?: { at: string; label: string; detail?: string; ok: boolean }[];
  /** (코드) 적용할 때의 형상관리 도구 */
  vcs?: VcsInfo['kind'];
  /** (코드) 변경을 만든 작업 사본 */
  workId?: string;
  workPath?: string;
  /** (코드) 커밋 메시지 첫 줄 */
  message?: string;
  /** (코드) 확인 창에서 고른 커밋·푸시 (실패하면 [다시 시도]가 이대로 다시 함) */
  want?: { commit: boolean; push: boolean };
}

export interface RevertResult {
  ok: boolean;
  historyId?: string;
  /** 그 뒤로 같은 파일이 또 바뀌어 자동으로 못 되돌림 (MSG-40) */
  blocked?: string[];
  error?: string;
}

// ------------------------------------------------------------------ Claude

export type AuthMode = 'login' | 'apikey' | 'cloud';

export interface ClaudeConfig {
  /** 연동 켬 (처음 켤 때 전송 범위 동의, MSG-14) */
  enabled: boolean;
  consentAt?: string;
  authMode: AuthMode;
  hasApiKey: boolean;
  cloud?: { provider: 'bedrock' | 'vertex' | 'foundry'; env: Record<string, string> };
  /** 직접 지정한 claude 실행 파일 경로 (비우면 자동 탐색) */
  cliPath?: string;
  model?: string;
  /** 회사 프록시 (HTTPS_PROXY) */
  proxy?: string;
  /** Claude가 실행할 수 있는 셸 명령 (앞부분 일치, 실행할 때마다 확인 MSG-24). 비면 셸 명령 금지 */
  shellAllow: string[];
  /** AI 요약 (F-10): 결과 요약·역할 문장을 Claude로 다듬기. 기본 끔 */
  aiSummary: boolean;
}

export interface ClaudeConfigInput extends Omit<ClaudeConfig, 'hasApiKey'> {
  /** 저장할 때만. 빈 문자열이면 지움 */
  apiKey?: string;
}

export interface ClaudeStatus {
  /** on 사용 가능 / login 인증 필요 / offline 인터넷 안 됨 / off 꺼짐 / missing CLI 없음 */
  state: 'on' | 'login' | 'offline' | 'off' | 'missing';
  cliPath?: string;
  version?: string;
  /** 지금 쓰는 인증 (Claude Code 로그인 / API 키 환경 변수 / 회사 클라우드 …) */
  authLabel?: string;
  checkedAt: string;
  message?: string;
  /** (POP-03 연결 확인) 인증 시험 요청에 걸린 시간(ms). 연동이 꺼져 있어도 recheck면 확인해 채움 */
  authMs?: number;
  /** 문제의 종류 (state가 login·offline·missing일 때. 결제 문제 MSG-30·사용 한도 MSG-23 구분용) */
  code?: ClaudeErrorCode;
  /** (POP-03 ② 연결 확인) 항목별 결과: CLI 설치 → 인터넷 → 인증. ok null = 확인하지 않음(앞 단계 실패·건너뜀) */
  checks?: { cli: ClaudeCheck; network: ClaudeCheck; auth: ClaudeCheck };
}

export interface ClaudeCheck {
  ok: boolean | null;
  /** 확인 내용·실패 원인 (예: '2.1.302 · C:\…\claude.exe', 'api.anthropic.com 연결됨 (120ms)') */
  message?: string;
  ms?: number;
  code?: ClaudeErrorCode;
}

export type ChatMode = 'plan' | 'edit';
export type ClaudeErrorCode = 'auth' | 'limit' | 'billing' | 'offline' | 'missing' | 'other';

/** 대화 시작 때 붙이는 맥락 (선택한 화면·테이블·메뉴·배치·파일과 시스템 요약) */
export interface ChatContext {
  title: string;
  chips: { kind: 'screen' | 'table' | 'menu' | 'batch' | 'file' | 'flow' | 'summary'; label: string; text: string }[];
}

export type ChatItem =
  | { id: string; type: 'user'; text: string; at: string }
  | { id: string; type: 'assistant'; text: string; streaming?: boolean; at: string }
  | {
      id: string;
      type: 'activity';
      summary: string;
      items: { kind: 'read' | 'search' | 'edit' | 'command' | 'db' | 'other'; label: string; file?: string; line?: number }[];
      at: string;
    }
  /** stats: 그때의 파일별 줄 수 (있으면 변경 카드의 파일 칩에 +a −b 표시) */
  | { id: string; type: 'changes'; workId: string; files: number; plus: number; minus: number; paths: string[]; at: string; stats?: { path: string; plus: number; minus: number }[] }
  | { id: string; type: 'query'; card: QueryCard; at: string }
  | { id: string; type: 'select'; env: Env; db: string; sql: string; rows: number; maskedColumns: string[]; ms: number; at: string }
  /** via: plan [수정 진행]·[계획 확정]으로 바뀜(화면에 '수정 진행함' 표시) / user 입력창의 모드 단추 */
  | { id: string; type: 'mode'; mode: ChatMode; at: string; via?: 'plan' | 'user' }
  /** msg: 메시지 정의 번호(예: DB 연결 실패 'MSG-36')와 vars 값. 있으면 화면이 그 문구·버튼으로 보여 줌 */
  | { id: string; type: 'notice'; text: string; at: string; msg?: string; vars?: Record<string, string | number> }
  | { id: string; type: 'error'; code: ClaudeErrorCode; message: string; at: string };

/** 사용자 결정이 필요한 요청 (셸 명령 MSG-24, 운영 DB 조회 MSG-42) */
export interface PendingRequest {
  requestId: string;
  /** command 셸 명령(MSG-24) / prod-select 운영 DB 조회(MSG-42) / plan 계획 모드에서 Claude가 수정을 시작하려 함 ([수정 진행]) */
  kind: 'command' | 'prod-select' | 'plan';
  title: string;
  /** command: 실행할 명령 그대로 / prod-select: MSG-42 문구(값을 채움) / plan: Claude가 낸 계획(Markdown) */
  detail: string;
  sql?: string;
  db?: string;
  /** (prod-select) 조회 대상 환경·최대 행 수·개인정보 가림 (운영 외에 '매번 확인'으로 설정한 개발·QA도 같은 요청) */
  env?: Env;
  maxRows?: number;
  mask?: boolean;
}

export interface Conversation {
  id: string;
  /** 프로젝트 폴더. ZIP·결과 파일로 연 프로젝트는 null (소스 없이 분석 결과로만 대화) */
  root: string | null;
  /** issue 이슈 처리(작업 사본에서) / new 새 프로젝트(고른 빈 폴더에서) */
  kind: 'issue' | 'new';
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: ChatMode;
  sessionId?: string;
  workId?: string;
  context?: ChatContext;
  items: ChatItem[];
  running: boolean;
  pending?: PendingRequest;
}

export interface ConversationSummary {
  id: string;
  kind: Conversation['kind'];
  title: string;
  updatedAt: string;
  mode: ChatMode;
  items: number;
}

// ------------------------------------------------------------------ 채널 (invoke)

export interface ClaudeStartOptions {
  context?: ChatContext;
  /** 새 프로젝트: root는 고른 빈 폴더, 작업 사본 없이 그 폴더에서 계획 → 생성 */
  newProject?: boolean;
  /** 참고할 분석 결과 요약 (새 프로젝트, '같은 구조로') */
  references?: { name: string; text: string }[];
}

export interface DesktopApi {
  'app.info'(): AppInfo;
  /** 폴더를 탐색기로 연다 (폴더만, 실행 파일은 열지 않음). 실패하면 오류 문구 */
  'app.openPath'(p: string): string;
  'app.openExternal'(url: string): void;
  /** 빈 폴더 고르기 (새 프로젝트). 고른 폴더와 비어 있는지 */
  'app.pickFolder'(title?: string): { path: string; empty: boolean } | null;
  'project.get'(root: string, name?: string): ProjectSettings;
  'project.set'(root: string, patch: Partial<Omit<ProjectSettings, 'root' | 'db'>>): ProjectSettings;

  'vcs.detect'(root: string): VcsInfo;
  /** 원격 연결·작업 공간 확인 (POP-04 [연결 확인]) */
  'vcs.check'(root: string): VcsCheck;

  'work.create'(root: string, conversationId?: string): WorkCopy;
  'work.get'(workId: string): WorkCopy | null;
  /** 이 프로젝트의 작업 사본들 (최근 것부터) */
  'work.list'(root: string): WorkCopy[];
  'work.changes'(workId: string): FileChange[];
  'work.discard'(workId: string, files?: string[]): FileChange[];
  'work.apply'(workId: string, req: ApplyRequest): ApplyResult;
  /** 원본이 바뀐 파일을 작업 사본에 새 원본으로 다시 복사 (MSG-31 [다시 맞추기]). 다시 복사한 파일 */
  'work.refresh'(workId: string, files: string[]): string[];

  'history.list'(root: string): HistoryEntry[];
  'history.revert'(root: string, entryId: string, opts: { commit: boolean }): RevertResult;
  'history.exportCsv'(root: string): string | false;
  'history.diff'(root: string, entryId: string): FileChange[];
  /** 적용한 뒤 바뀐 내용 (적용 직후 → 지금 원본). MSG-40 [차이 보기] */
  'history.drift'(root: string, entryId: string): FileChange[];
  /** 진행 기록 추가 (화면이 다시 분석한 결과 등) */
  'history.step'(root: string, entryId: string, step: { label: string; detail?: string; ok: boolean }): HistoryEntry | null;
  /** 실패한 커밋·푸시 다시 시도 (MSG-25) */
  'history.retry'(root: string, entryId: string): HistoryEntry | null;

  'claude.status'(recheck?: boolean): ClaudeStatus;
  'claude.config.get'(): ClaudeConfig;
  'claude.config.set'(c: ClaudeConfigInput): ClaudeConfig;
  'claude.openLogin'(): boolean;
  'claude.list'(root: string): ConversationSummary[];
  'claude.get'(conversationId: string): Conversation | null;
  'claude.start'(root: string | null, opts?: ClaudeStartOptions): Conversation;
  'claude.send'(conversationId: string, text: string): void;
  'claude.setMode'(conversationId: string, mode: ChatMode): void;
  'claude.interrupt'(conversationId: string): void;
  'claude.respond'(conversationId: string, requestId: string, allow: boolean): void;
  'claude.delete'(conversationId: string): void;
  /** 대화 내용을 Markdown 파일로 저장 (F-21). 저장한 경로, 취소하면 false */
  'claude.export'(conversationId: string): string | false;
  /** claude 실행 파일 직접 지정 ([경로 지정]). 고른 경로, 취소하면 null */
  'claude.pickCli'(): string | null;

  'db.list'(root: string): DbConnection[];
  'db.save'(root: string, conn: DbConnectionInput): DbConnection;
  'db.remove'(root: string, id: string): void;
  'db.test'(root: string, idOrInput: string | DbConnectionInput): DbTestResult;
  /** 분석 전에 메뉴 테이블 읽기 (설정에서 켰을 때만 읽음) */
  'db.readMenu'(root: string): MenuReadResult;
  'db.previewMenu'(root: string, setting: MenuDbSetting): { rows: MenuRow[]; error?: string };
  'db.card.get'(cardId: string): QueryCard | null;
  /** 쿼리 카드 실행 (사용자 확인 뒤). 운영은 typedName이 DB 이름과 같아야 함 */
  'db.card.execute'(cardId: string, typedName?: string): QueryCard;
  'db.card.reject'(cardId: string): QueryCard;
  /** 작업 이력의 쿼리에서 되돌리는 SQL로 새 쿼리 카드 (실행은 같은 확인 절차) */
  'db.card.fromHistory'(root: string, entryId: string): QueryCard;
}

export type Channel = keyof DesktopApi;
export type Args<C extends Channel> = Parameters<DesktopApi[C]>;
export type Ret<C extends Channel> = Awaited<ReturnType<DesktopApi[C]>>;

// ------------------------------------------------------------------ 이벤트 (메인 → 화면)

export type DesktopEvent =
  | { type: 'claude.item'; conversationId: string; item: ChatItem }
  | { type: 'claude.state'; conversationId: string; running: boolean; mode: ChatMode; workId?: string; pending?: PendingRequest | null }
  | { type: 'claude.status'; status: ClaudeStatus }
  | { type: 'work.progress'; root: string; done: number; total: number; message?: string }
  | { type: 'history.added'; root: string; entry: HistoryEntry }
  /** 기록 갱신 (커밋·푸시 결과, 진행 기록 추가, 되돌림 표시) */
  | { type: 'history.updated'; root: string; entry: HistoryEntry }
  | { type: 'db.card'; card: QueryCard };
