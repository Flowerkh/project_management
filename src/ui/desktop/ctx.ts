// 데스크톱 기능 화면들이 함께 쓰는 앱 상태와 동작. 데스크톱 앱(또는 ?mock&desk 미리보기)에서만 있다.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { AnalysisResult } from '../../engine/types';
import type { AiProvider, AiSettings, ChatContext, ClaudeConfig, ClaudeStatus, GeminiConfig, OpenAiConfig } from '../../shared/desktop-api';
import type { SettingsPageId } from '../components/Dialogs';
import type { Model, Target } from '../model';
import type { Desk } from './bridge';

/** AI 대화 패널을 여는 요청 */
export interface ChatRequest {
  /** 새 대화에 붙일 맥락 (화면·테이블·메뉴·배치 상세의 [AI에게 묻기]) */
  context?: ChatContext;
  /** 기존 대화 열기 */
  conversationId?: string;
  /** 입력창에 미리 넣을 문구 (예: MSG-40 [Claude에게 요청]) */
  text?: string;
  /** 바로 보낼지 (text와 함께) */
  send?: boolean;
  /** 같은 요청을 다시 눌러도 패널이 반응하게 */
  nonce: number;
}

export interface ReanalyzeResult {
  ok: boolean;
  ms: number;
  before: AnalysisResult | null;
  after: AnalysisResult | null;
  error?: string;
}

export interface DeskApp {
  desk: Desk;
  /** 프로젝트 폴더 절대 경로. 데스크톱에서 폴더로 연 경우만 (ZIP·결과 파일은 null) */
  root: string | null;
  projectName: string;
  model: Model | null;
  result: AnalysisResult | null;
  target: Target;
  /** Claude 연결 상태 (ai.status.claude와 같음) */
  claude: ClaudeStatus | null;
  claudeConfig: ClaudeConfig | null;
  /** 상태 다시 읽기. recheck면 CLI·인증을 다시 확인 */
  refreshClaude(recheck?: boolean): Promise<void>;
  /** AI 공통 설정·AI별 연결 상태·Gemini·ChatGPT 설정 (비밀 값 없음) */
  ai: {
    settings: AiSettings | null;
    status: Partial<Record<AiProvider, ClaudeStatus | null>>;
    gemini: GeminiConfig | null;
    openai: OpenAiConfig | null;
  };
  /** 그 AI(없으면 모두)의 설정·상태 다시 읽기. recheck면 연결 확인까지 */
  refreshAi(provider?: AiProvider, recheck?: boolean): Promise<void>;
  /** 설정 창을 그 페이지로 연다 (AI 공통·Claude·Gemini·ChatGPT) */
  openSettings(page: SettingsPageId): void;
  chat: ChatRequest | null;
  openChat(req?: Omit<ChatRequest, 'nonce'>): void;
  closeChat(): void;
  /** 본문을 변경 검토(SCR-10)로 */
  openChanges(workId: string, conversationId?: string): void;
  /** 본문을 작업 이력(SCR-12)으로 */
  openHistory(entryId?: string): void;
  /** 결과 요약으로 돌아가기 */
  openSummary(): void;
  /** POP-03 AI 연결(그 AI의 설정 페이지) / POP-04 프로젝트 연결 */
  openModal(kind: AiProvider | 'project'): void;
  /** 적용·되돌리기 뒤 다시 분석 (확인 창 없이). 끝나면 전후 결과와 걸린 시간 */
  reanalyze(): Promise<ReanalyzeResult>;
  /** 프로젝트 기준 상대 경로로 소스 뷰어 열기. 분석 결과에 없는 파일이면 false */
  openSource(relPath: string, line?: number): boolean;
  /** 분석 결과 화면 이동 */
  nav(t: Target): void;
  toast(msg: string): void;
  /** 이력 수가 바뀌면 올라가는 번호 (헤더 [이력] 등 다시 읽기용) */
  historyTick: number;
}

export const DeskCtx = createContext<DeskApp | null>(null);

export function useDeskApp(): DeskApp | null {
  return useContext(DeskCtx);
}

/** 데스크톱 화면 안에서만 쓰는 훅 (없으면 오류) */
export function useDesk(): DeskApp {
  const v = useContext(DeskCtx);
  if (!v) throw new Error('DeskCtx 없음');
  return v;
}
