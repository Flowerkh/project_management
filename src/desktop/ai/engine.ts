// Claude 말고 다른 AI(Gemini·ChatGPT)를 대화 관리(manager.ts)에 끼우는 약속.
// 엔진은 Claude Agent SDK query()와 같은 모양의 메시지를 흘려보낸다 → 대화 관리의 항목 변환·확인 창·저장을 그대로 쓴다.
//   system/init     { session_id, model }            턴마다 처음에
//   stream_event    message_start · content_block_start(text) · content_block_delta(text_delta) · message_stop
//   assistant       { message: { id, content: [text | tool_use(Claude 도구 이름·입력)] } }
//   user            { message: { content: [tool_result] }, tool_use_result: 도구별 구조화 결과 }
//   result          { subtype: success | error_during_execution, is_error, result, errors, pa_code }
//   system/api_retry { attempt, max_retries }
// 도구 이름·입력은 Claude 도구 모양(Read·Grep·Glob·LS·Edit·Write·Bash·ExitPlanMode·mcp__projdb__*)으로 바꿔 보낸다
// → 작업 내역 요약(activity.ts)과 권한 규칙(guards.ts)을 같이 쓴다.
import type { AiProvider, ChatMode, ClaudeErrorCode, ClaudeModelList, ClaudeStatus } from '../../shared/desktop-api';
import type { SDKUserMessage } from '../claude/sdk';
import type { DbToolHandlers } from '../claude/tools';

export type EngineProvider = Exclude<AiProvider, 'claude'>;

/** 대화 하나 동안 열어 두는 AI 연결 (Claude Agent SDK Query 중 대화 관리가 쓰는 부분) */
export interface RunningQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  /** 'plan' 계획 모드 / 'acceptEdits' 수정 허용 */
  setPermissionMode(mode: string): Promise<unknown>;
  setModel(model?: string): Promise<unknown>;
  close(): void;
}

export type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

export interface EngineOpenOptions {
  conversationId: string;
  /** 작업 폴더 (작업 사본·새 프로젝트 폴더·빈 폴더) */
  cwd: string;
  mode: ChatMode;
  /** 원본 폴더 없이 연 대화: 수정·명령 도구를 주지 않는다 */
  readOnly: boolean;
  kind: 'issue' | 'new';
  /** 이 대화의 모델 ('' 또는 없음 = 그 AI 연결의 기본 모델) */
  model?: string;
  /** 앱 규칙 (시스템 지시) */
  instructions: string;
  /** 비면 셸 명령 도구를 주지 않는다 */
  shellAllow: string[];
  /** 이어서 할 대화 ID (system/init의 session_id) */
  resume?: string;
  input: AsyncIterable<SDKUserMessage>;
  /** DB 도구 (앱 안에서 바로 실행. 운영 조회 확인은 손잡이 안에서) */
  db: DbToolHandlers;
  /** 도구를 쓰기 전에 (Claude 도구 이름·입력으로). 계획 승인·셸 명령 확인·막기 규칙은 대화 관리가 정한다 */
  canUseTool(name: string, input: Record<string, unknown>, o: { signal?: AbortSignal }): Promise<PermissionResult>;
  stderr?(s: string): void;
}

/** 대화에서 알게 된 연결 상태 */
export type StatusReport = { ok: true; apiKeySource?: string } | { ok: false; code: ClaudeErrorCode; detail?: string };

export interface EngineStatus {
  get(recheck?: boolean): Promise<ClaudeStatus>;
  invalidate(): void;
  report(r: StatusReport): Promise<void>;
}

export interface EngineModels {
  list(refresh?: boolean): Promise<ClaudeModelList>;
  /** 모델 값의 보이는 이름 ('' = 그 AI 연결의 기본 모델) */
  label(value: string | undefined): string;
  invalidate(): void;
}

/** 엔진 채널이 대화 관리에 부탁하는 것 (그 AI의 대화만) */
export interface EngineHost {
  /** 쉬고 있는 연결은 닫고, 응답 중인 것은 다음 메시지 때 새로 연다 */
  closeIdle(): void;
  /** 연동 끔: 그 AI의 대화를 모두 멈추고 닫는다 */
  closeAll(): Promise<void>;
}

export interface AiEngine {
  provider: EngineProvider;
  enabled(): Promise<boolean>;
  /** 연결 설정의 기본 모델 (없으면 엔진이 고름) */
  defaultModel(): Promise<string | undefined>;
  open(o: EngineOpenOptions): Promise<RunningQuery>;
  status: EngineStatus;
  models: EngineModels;
  /** 대화를 지울 때: 앱이 보관한 대화 기록도 지운다 */
  forget?(sessionId: string): Promise<void>;
  /** 엔진 설정 채널 등록 (gemini.config.* · openai.*) */
  registerChannels?(h: EngineHost): void;
  /** 앱 종료 (공유 프로세스 정리) */
  shutdown?(): Promise<void>;
}

export type EngineMap = Partial<Record<EngineProvider, AiEngine>>;

/** 엔진이 이미 구분한 오류 (연결을 열 때 등) */
export class EngineError extends Error {
  constructor(
    message: string,
    public code: ClaudeErrorCode,
  ) {
    super(message);
  }
}
