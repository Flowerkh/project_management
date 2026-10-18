// 메인 프로세스 모듈 사이의 약속. 각 모듈(register)이 자기 구현을 services에 넣고, 다른 모듈은 이것만 부른다.
//   project (project.ts)  프로젝트 연결 설정
//   history (history.ts)  작업 이력
//   work    (work/)       작업 사본·변경·적용
//   db      (db/)         DB 연결·조회·쿼리 카드
//   claude  (claude/)     Claude 대화
import type {
  ChatMode, DbConnection, Env, FileChange, HistoryEntry, ProjectSettings, QueryCard, QueryResult, WorkCopy,
} from '../shared/desktop-api';

export interface ProjectService {
  get(root: string, name?: string): Promise<ProjectSettings>;
  set(root: string, patch: Partial<Omit<ProjectSettings, 'root' | 'db'>>): Promise<ProjectSettings>;
}

/** id를 미리 정하면(적용 전 백업 폴더 이름 등) 그 id로 남긴다 */
export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'at'> & { at?: string; id?: string };

export interface HistoryService {
  /** 최근 것부터. 나중에 붙은 갱신(진행 기록·되돌림 표시)을 합쳐서 돌려준다 */
  list(root: string): Promise<HistoryEntry[]>;
  get(root: string, id: string): Promise<HistoryEntry | null>;
  /** 기록 추가 (history.added 이벤트) */
  add(root: string, e: NewHistoryEntry): Promise<HistoryEntry>;
  /** 기록은 추가만 한다: 갱신도 파일 끝에 덧붙이고 읽을 때 합친다 */
  update(root: string, id: string, patch: Partial<Omit<HistoryEntry, 'id'>>): Promise<HistoryEntry | null>;
  addStep(root: string, id: string, step: { label: string; detail?: string; ok: boolean }): Promise<HistoryEntry | null>;
}

export interface WorkService {
  /** 원본 폴더의 지금 상태로 작업 사본을 만든다 (진행은 work.progress 이벤트) */
  create(root: string, opts?: { conversationId?: string }): Promise<WorkCopy>;
  get(workId: string): Promise<WorkCopy | null>;
  /** 작업 사본과 원본(만들 때 상태)의 차이 */
  changes(workId: string): Promise<FileChange[]>;
}

export interface DbSelectRequest {
  root: string;
  /** 비우면 개발 DB만 (QA·운영은 지정했을 때만). 해당 환경 연결이 없으면 status 'none'과 있는 환경 목록 */
  env?: Env;
  connectionId?: string;
  sql: string;
  maxRows?: number;
  conversationId?: string;
}

export interface DbSelectAsk {
  env: Env;
  dbName: string;
  sql: string;
  maxRows: number;
  mask: boolean;
}

export interface DbSelectOutcome {
  /** ok 실행함 / denied 사용자가 거부 / rejected SELECT 하나가 아님 / error 실행 오류·연결 실패 / none 연결 없음 */
  status: 'ok' | 'denied' | 'rejected' | 'error' | 'none';
  env?: Env;
  dbName?: string;
  connectionId?: string;
  result?: QueryResult;
  message?: string;
  historyId?: string;
}

export interface DbProposeRequest {
  root: string;
  env?: Env;
  connectionId?: string;
  sql: string;
  description?: string;
  revertSql?: string;
  conversationId?: string;
}

export interface DbService {
  list(root: string): Promise<DbConnection[]>;
  /** Claude의 SELECT. 환경 규칙이 확인을 요구하면(운영은 항상) ask로 사용자 답을 기다린다 */
  select(req: DbSelectRequest, ask: (q: DbSelectAsk) => Promise<boolean>): Promise<DbSelectOutcome>;
  /** SELECT 외 쿼리 → 쿼리 카드 (실행은 사용자가 화면에서 확인한 뒤) */
  propose(req: DbProposeRequest): Promise<QueryCard>;
  /** 쿼리 카드가 바뀔 때 (실행·롤백·거부) */
  onCard(fn: (card: QueryCard) => void): () => void;
}

export interface ClaudeService {
  /** 화면 밖(작업 이력 등)에서 대화에 메시지를 보낼 때 */
  send(conversationId: string, text: string): Promise<void>;
  setMode(conversationId: string, mode: ChatMode): Promise<void>;
}

export const services: {
  project?: ProjectService;
  history?: HistoryService;
  work?: WorkService;
  db?: DbService;
  claude?: ClaudeService;
} = {};

export function need<K extends keyof typeof services>(k: K): NonNullable<(typeof services)[K]> {
  const s = services[k];
  if (!s) throw new Error(`${k} 모듈이 준비되지 않았습니다`);
  return s as NonNullable<(typeof services)[K]>;
}
