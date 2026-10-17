// 분석 엔진 공통 타입.
// 흐름: SourceFile[] → (분석기들이 Facts를 채움) → link() → AnalysisResult
// 분석기(analyzers/*)는 Facts만 채우고, 화면·테이블·메뉴·배치 결과는 link.ts가 만든다.

export type Lang =
  | 'Java' | 'JSP' | 'JavaScript' | 'TypeScript' | 'Vue' | 'PHP' | 'Go' | 'Python' | 'Kotlin' | 'Dart'
  | 'SQL' | 'XML' | 'HTML' | 'CSS' | 'Shell' | 'Batch' | 'PowerShell' | 'Properties' | 'YAML' | 'JSON'
  | 'Groovy' | 'C#' | 'Swift' | 'Template' | 'Other';

/** 파일이 맡는 계층. 화면 상세의 '계층' 열과 호출 흐름에 쓴다. */
export type Layer =
  | 'VIEW'        // JSP·PHP 화면·템플릿·HTML
  | 'SCRIPT'      // 화면이 쓰는 JS
  | 'CONTROLLER'  // URL을 받는 코드 (Spring Controller, Laravel/CI Controller, Go handler)
  | 'SERVICE'
  | 'DAO'
  | 'MAPPER'      // MyBatis·iBatis 매퍼 XML 또는 매퍼 인터페이스
  | 'MODEL'       // Entity·VO·Eloquent 모델·Go struct
  | 'ROUTE'       // 라우트 정의 파일 (web.php, routes.go 등)
  | 'CONFIG'
  | 'DDL'
  | 'MENU_DATA'
  | 'BATCH'
  | 'TEST'
  | 'STYLE'
  | 'OTHER';

export type Crud = 'C' | 'R' | 'U' | 'D';
export type Confidence = '높음' | '보통' | '낮음';

/** 플랫폼(브라우저·Electron·Node)이 엔진에 넘기는 파일 1개 */
export interface SourceFile {
  /** 불러온 폴더 기준 상대 경로, 구분자는 '/' */
  path: string;
  size: number;
  /** 원본 바이트. text가 없으면 엔진이 인코딩을 감지해 디코딩한다 */
  bytes?: Uint8Array;
  /** 이미 디코딩된 텍스트(테스트용) */
  text?: string;
}

/** 근거 위치: 파일 ID + 줄(1부터) */
export interface Evidence {
  file: string;
  line: number;
  text?: string;
}

export interface FileInfo {
  id: string;            // F0001
  path: string;
  name: string;          // 파일 이름
  lang: Lang;
  layer: Layer;
  lines: number;
  size: number;
  encoding: 'utf-8' | 'euc-kr' | 'utf-16' | 'binary';
  /** 하위 프로젝트 ID (P1 …). 하위 프로젝트가 하나면 생략 */
  project?: string;
  /** 분석 대상에서 빠진 이유 (제외 규칙·바이너리·크기 초과) */
  excluded?: string;
}

// ------------------------------------------------------------------ Facts (분석기 출력)

export interface TableRef {
  name: string;          // 대문자 정규화, 스키마 접두어 제거 (SHOP.TB_ORDER → TB_ORDER)
  crud: Crud;
  /** 문자열 조합·동적 SQL 등으로 확정하지 못함 */
  estimated?: boolean;
}

export interface SqlFact {
  id: string;            // Q0001
  file: string;          // 파일 ID
  line: number;
  origin: 'mybatis' | 'ibatis' | 'annotation' | 'string' | 'orm' | 'script' | 'other';
  /** MyBatis namespace / iBatis sqlMap namespace */
  namespace?: string;
  /** 매퍼 statement id (select id="…") */
  stmtId?: string;
  kind: 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'call' | 'ddl' | 'other';
  tables: TableRef[];
  /** 매퍼 동적 태그(if·choose·foreach 등)가 있음 */
  dynamic?: boolean;
  /** 공백을 정리한 SQL (최대 4,000자) */
  text: string;
}

export interface DdlColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  pk?: boolean;
  comment?: string;
}

export interface DdlTable {
  name: string;
  comment?: string;
  columns: DdlColumn[];
  evidence: Evidence;
}

/** 클래스(Java·PHP) 또는 Go 파일/타입 단위 코드 */
export interface CodeUnit {
  id: string;            // U0001
  file: string;          // 파일 ID
  name: string;          // 클래스 이름 (Go는 타입 이름 또는 파일 이름)
  fqn?: string;          // 패키지 포함 이름 (MyBatis 매퍼 인터페이스 매칭용)
  kind: 'controller' | 'service' | 'dao' | 'mapper' | 'repository' | 'model' | 'job' | 'other';
  line: number;
  /** @Service("orderService") 처럼 등록 이름 */
  beanName?: string;
  extendsOrImplements: string[];
  /** 필드 이름 → 타입 (의존성 주입 추적용) */
  fields: Record<string, string>;
  methods: MethodUnit[];
  /** ORM 모델이 쓰는 테이블 (JPA @Table, Eloquent $table, GORM TableName) */
  table?: string;
  /** 클래스 수준 URL 접두어 (Spring 클래스 @RequestMapping, Gin Group 등) */
  routePrefix?: string[];
}

export interface Route {
  method: string;        // GET·POST·… 또는 '*'
  path: string;          // 정규화된 URL 경로 (/order/list.do, /api/orders/{id})
  /** 화면을 돌려주지 않는 API (@ResponseBody·@RestController·JSON 응답) */
  api?: boolean;
  line: number;
}

export interface CallRef {
  /** 호출 대상: 필드·변수 이름 또는 타입 이름 (orderService, this.orderDAO, OrderModel) */
  via: string;
  method: string;
  line: number;
}

export interface MethodUnit {
  name: string;
  line: number;
  endLine?: number;
  routes: Route[];
  calls: CallRef[];
  /** 이 메서드가 직접 가진 SQL (문자열 SQL·애노테이션 SQL·ORM 호출) */
  sql: string[];
  /** 문자열로 부르는 매퍼 statement (selectList("order.selectOrderList")) */
  statements: string[];
  /** 돌려주는 화면 이름 (Spring view name, Laravel view('a.b'), CI load->view) */
  views: string[];
  /** 리다이렉트 URL */
  redirects?: string[];
  /** @Scheduled(cron) 등 실행 주기 */
  schedule?: string;
}

/** 화면 파일 (JSP·PHP 페이지·템플릿·HTML) */
export interface ViewFact {
  file: string;
  kind: 'jsp' | 'php' | 'template' | 'html' | 'vue' | 'react' | 'other';
  title?: string;
  titleLine?: number;
  /** 화면이 부르는 URL (form action·ajax·링크·location 이동) */
  urls: UrlRef[];
  /** include한 조각 파일 경로 (불러온 폴더 기준으로 해석된 경로) */
  includes: string[];
  /** script src로 붙인 JS 경로 */
  scripts: string[];
  /** 다른 화면에 include되는 조각(헤더·푸터·메뉴)으로 보임 */
  fragment?: boolean;
  /** 이 파일을 URL로 바로 여는 경우의 URL (순수 PHP·정적 HTML) */
  directUrl?: string;
}

export interface UrlRef {
  url: string;           // 정규화된 경로 (컨텍스트 경로·호스트·쿼리 제거)
  method?: string;
  kind: 'form' | 'ajax' | 'link' | 'location' | 'popup' | 'fetch';
  file: string;
  line: number;
}

export type MenuSource = 'db' | 'data-file' | 'config' | 'code' | 'url-guess';

export interface MenuFact {
  key: string;           // 원본의 메뉴 ID (없으면 경로로 만든 키)
  parentKey?: string;
  name: string;
  url?: string;
  order?: number;
  source: MenuSource;
  evidence: Evidence;
}

export interface BatchFact {
  key: string;
  name: string;
  kind: 'shell' | 'batch' | 'powershell' | 'python' | 'node' | 'spring-scheduled' | 'quartz' | 'spring-batch';
  /** 실행 파일 ID (스크립트 또는 Java 클래스 파일) */
  entry: string;
  /** Java 배치일 때 클래스·메서드 */
  unit?: string;
  method?: string;
  /** 스크립트 주석 등에서 찾은 이름 */
  title?: string;
  schedule?: { expr: string; text: string; evidence: Evidence };
  /** 실행 흐름에서 부르는 것: SQL 파일·다른 스크립트·프로그램 */
  calls: { kind: 'sql-file' | 'script' | 'program' | 'class'; target: string; line: number; file?: string }[];
  /** 스크립트 안 SQL (heredoc 등) */
  sql: string[];
  logs: string[];
}

export interface ScheduleFact {
  /** crontab 한 줄 / 작업 스케줄러 항목 */
  expr: string;
  command: string;
  evidence: Evidence;
}

export interface Facts {
  files: FileInfo[];
  /** 파일 ID → 텍스트 (분석 대상만) */
  texts: Map<string, string>;
  sql: SqlFact[];
  ddl: DdlTable[];
  units: CodeUnit[];
  views: ViewFact[];
  menus: MenuFact[];
  batches: BatchFact[];
  schedules: ScheduleFact[];
  /** 기술 감지 결과(스택 이름 → 근거) */
  tech: TechHit[];
  /** 분석기가 남기는 메모 (확인 필요 후보) */
  notes: Issue[];
  /** 뷰 이름 해석 규칙 (Spring prefix/suffix, Tiles 등) */
  viewResolvers: ViewResolver[];
}

export interface ViewResolver {
  prefix: string;
  suffix: string;
  /** Tiles 등 정의 이름 → 화면 파일 경로 */
  definitions?: Record<string, string>;
  evidence?: Evidence;
}

export interface TechHit {
  layer: '화면' | '컨트롤러' | '서비스' | '데이터 접근' | 'DB' | '설정' | '빌드' | '배치' | '앱' | '기타';
  name: string;          // 'Spring MVC', 'MyBatis', 'Oracle', 'Laravel' …
  evidence: Evidence[];
  weight: number;        // 근거 강도 합
}

// ------------------------------------------------------------------ Result (화면에 보여 주는 결과, JSON으로 저장)

export type SystemType = '웹' | '웹 프론트엔드' | 'API 서버' | '모바일 앱' | '배치' | '데스크톱 앱' | '라이브러리';

export interface AnalysisResult {
  version: 1;
  project: {
    name: string;
    analyzedAt: string;   // ISO
    durationMs: number;
    types: SystemType[];
    /** 한 줄 정의 (예: 전자정부 표준프레임워크(Spring MVC) 기반 쇼핑몰 관리자 웹) */
    title: string;
    summary: string;
    /** 업무 성격 추정 여부 */
    domainEstimated: boolean;
    confidence: Confidence;
    evidence: Evidence[];
    subProjects: { id: string; name: string; root: string; types: SystemType[] }[];
  };
  stats: {
    totalFiles: number;
    analyzedFiles: number;
    excludedFiles: number;
    totalBytes: number;
    analyzedBytes: number;
  };
  languages: { name: Lang; files: number; lines: number; ratio: number }[];
  databases: { type: string; access: string[]; evidence: Evidence[]; confidence: Confidence }[];
  tech: { layer: string; items: string; files: number }[];
  files: FileInfo[];
  tables: TableResult[];
  screens: ScreenResult[];
  menus: MenuResult[];
  batches: BatchResult[];
  sql: SqlFact[];
  issues: Issue[];
}

export interface TableResult {
  id: string;             // T001
  name: string;
  comment?: string;
  role: string;
  roleConfidence: Confidence;
  columns: DdlColumn[];
  ddl?: Evidence;
  /** 코드·로그·첨부처럼 여러 업무가 함께 쓰는 테이블 */
  common: boolean;
  /** DDL은 없고 SQL에서만 보임 */
  fromSqlOnly: boolean;
  /** 이 테이블을 다루는 파일 (매퍼·DAO·엔티티·DDL) */
  files: string[];
  usedBy: { kind: 'screen' | 'batch'; id: string; crud: Crud[] }[];
  joinsWith: string[];
  /** 화면·배치와 연결되지 않음 */
  unlinked: boolean;
  estimated: boolean;
}

export interface FlowStep {
  layer: Layer | 'TABLE' | 'SCHEDULE';
  file?: string;          // 파일 ID
  symbol: string;         // detail.jsp / OrderController.updateStat() / TB_ORDER
  line?: number;
}

export interface ScreenResult {
  id: string;             // S001
  kind: 'page' | 'popup' | 'api';
  name: string;
  url?: string;
  urls: string[];
  /** 트리 그룹: URL 첫 경로(/order) 또는 폴더 */
  group: string;
  menu?: string;          // 메뉴 ID
  view?: string;          // 화면 파일 ID
  files: { file: string; layer: Layer; note?: string }[];
  tables: { table: string; crud: Crud[] }[];
  /** 대표 호출 흐름 */
  flow: FlowStep[];
  /** 화면이 부르는 URL과 처리 메서드 */
  calls: { url: string; kind: UrlRef['kind']; handler?: string; tables: { table: string; crud: Crud[] }[] }[];
  role: string;
  confidence: Confidence;
  evidence: Evidence[];
  /** 메뉴에 없는 화면 */
  notInMenu: boolean;
  project?: string;
}

export interface MenuResult {
  id: string;             // M001
  name: string;
  parent?: string;
  url?: string;
  order?: number;
  depth: number;
  screens: string[];      // 화면 ID
  source: MenuSource;
  evidence?: Evidence;
  estimated: boolean;
  /** 하위 화면이 쓰는 테이블 합계 */
  tables: { table: string; crud: Crud[] }[];
}

export interface BatchResult {
  id: string;             // B001
  name: string;
  kind: BatchFact['kind'];
  group: string;          // 트리 그룹: 실행 파일 폴더(batch) 또는 'Spring 스케줄러'
  entry: string;          // 파일 ID
  schedule?: { expr: string; text: string; evidence: Evidence };
  flow: FlowStep[];
  tables: { table: string; crud: Crud[] }[];
  files: string[];
  logs: string[];
  role: string;
  confidence: Confidence;
}

export interface Issue {
  kind:
    | 'unlinked-table' | 'screen-not-in-menu' | 'estimated-sql' | 'encoding' | 'unreadable'
    | 'no-schedule' | 'menu-mismatch' | 'unresolved-url' | 'other';
  title: string;
  detail?: string;
  items: { ref: string; note?: string }[];
}

export interface Progress {
  step: number;           // 1~6
  stepName: string;
  done: number;
  total: number;
  message?: string;
}

export interface AnalyzeOptions {
  projectName?: string;
  /** 추가 제외 경로 패턴 (glob 일부: **, *) */
  exclude?: string[];
  /** 파일 하나 최대 크기 (기본 2MB). 넘으면 앞부분만 읽지 않고 제외 */
  maxFileBytes?: number;
  onProgress?: (p: Progress) => void;
}
