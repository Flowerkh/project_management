// Claude 오류 구분: SDK 메시지의 error 값, 결과 오류 문구, 프로세스 종료 문구, 네트워크 errno → ClaudeErrorCode
//   auth 인증(MSG-21) · limit 사용 한도(MSG-23) · billing 결제·권한(MSG-30) · offline 인터넷(MSG-22) · missing CLI 실행 불가(MSG-20) · other
// 문구 출처: Claude Code 문서 Error reference (https://code.claude.com/docs/en/errors), SDK의 SDKAssistantMessageError·
// SDKStartupFailureReason·USAGE_LIMIT_ERROR_PREFIXES (sdk.d.ts 0.3.302).
import { AI_LABEL, type AiProvider, type ClaudeErrorCode } from '../../shared/desktop-api';

export interface ClassifyInput {
  /** 이미 구분한 종류 (Gemini·ChatGPT 엔진이 HTTP 상태·오류 정보로 정한 것). 있으면 문구 규칙보다 먼저 */
  code?: ClaudeErrorCode;
  /** 문구에 쓰는 AI (없으면 claude) */
  provider?: AiProvider;
  /** SDKAssistantMessage.error (authentication_failed, rate_limit …) */
  assistantError?: string;
  /** SDKResultError.startup_failure_reason */
  startupReason?: string;
  /** 오류 문구 (결과 문구·errors·예외 메시지·stderr 끝부분) */
  text?: string;
  /** Node errno (ENOTFOUND …) */
  errno?: string;
  /** HTTP 상태 (api_error_status) */
  status?: number | null;
}

export interface Classified {
  code: ClaudeErrorCode;
  /** 짧은 한국어 설명 + 원문 (화면의 error 항목 message) */
  message: string;
  /** 원문 (비밀 값 가림, 500자 이내) */
  detail: string;
}

const ASSISTANT_ERROR: Record<string, ClaudeErrorCode> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'billing',
  account_on_hold: 'billing',
  rate_limit: 'limit',
  overloaded: 'other',
  invalid_request: 'other',
  model_not_found: 'other',
  server_error: 'other',
  max_output_tokens: 'other',
  unknown: 'other',
};

const STARTUP_REASON: Record<string, ClaudeErrorCode> = {
  org_pin_api_key_conflict: 'auth',
  provider_not_allowed: 'auth',
  org_pin_mismatch: 'auth',
  gateway_signin_required: 'auth',
  gateway_access_denied: 'auth',
  org_config_refused: 'auth',
  org_verify_failed: 'offline',
  remote_settings_required_unavailable: 'offline',
  org_config_required_unavailable: 'offline',
  shell_tool_missing: 'missing',
  cli_version_too_old: 'missing',
};

const NET_ERRNO = /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNABORTED|EPIPE|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|UND_ERR_CONNECT_TIMEOUT)\b/;

const BUSY_RE = /overloaded|\b529\b|\b503\b|at capacity|temporarily limiting requests|temporary capacity issue|high load|server is busy|model is overloaded/i;

/** 순서대로 검사한다 (앞의 규칙이 이긴다) */
const RULES: { code: ClaudeErrorCode; re: RegExp; note?: string }[] = [
  // CLI를 실행하지 못함
  { code: 'missing', re: /native binary not found|executable not found at|Claude Code executable|spawn \S+ ENOENT|is not recognized as an internal or external command|No such file or directory.*claude|Git Bash is missing|requires git-bash|shell tool/i },
  // 일시적인 혼잡 (사용 한도 아님)
  { code: 'other', re: BUSY_RE, note: 'busy' },
  // 결제·권한
  { code: 'billing', re: /credit balance is too low|billing|payment|out of usage credits|org is out of usage|add funds|seat type doesn't include|organization has been disabled|account (is )?(suspended|on hold|disabled)|usage allocation has been disabled|usage credits required|requires usage credits/i },
  // 사용 한도 (구독 한도·429)
  { code: 'limit', re: /you've hit your|you've reached your|you're out of extra usage|usage limit|spend limit|shared budget|rate[_ ]limit|\b429\b|too many requests|limit reached/i },
  // 인증
  {
    code: 'auth',
    re: /not logged in|please run \/login|run \/login|invalid api key|invalid x-api-key|login expired|oauth token (revoked|has expired)|oauth session expired|failed to authenticate|authentication[_ ](error|failed|required)|invalid authentication credentials|could not resolve authentication method|apikeyhelper|claude login not accepted|does not have access to claude|organization has disabled (api key authentication|claude subscription access)|\b401\b|\b403\b.*(auth|permission|forbidden)|aws credentials|aws authentication failed|could not load aws credentials|session token not found|google cloud (credentials|authentication)|could not load the default credentials|microsoft foundry authentication failed|azureadtokenprovider|chainedtokencredential|gateway refused the request/i,
  },
  // 네트워크
  {
    code: 'offline',
    re: /unable to connect|connection error|connection refused|can't reach the api server|no internet route|couldn't connect through your proxy|connection dropped|socket is closed|socket hang up|request timed out|timed out waiting|fetch failed|network (error|is unreachable)|getaddrinfo|dns|certificate|ssl|tls|self[- ]signed|unable to get local issuer/i,
  },
];

const KO: Record<ClaudeErrorCode, string> = {
  auth: '인증 실패',
  limit: '사용 한도',
  billing: '결제·권한 문제',
  offline: '연결 실패',
  missing: 'Claude CLI 실행 실패',
  other: '오류',
};

const MISSING_LABEL: Record<AiProvider, string> = { claude: 'Claude CLI 실행 실패', openai: 'Codex CLI 실행 실패', gemini: 'Gemini 연결 준비 실패' };

/** 오류 문구에서 비밀 값처럼 보이는 것을 가리고 줄인다 */
export function cleanDetail(text: string, max = 500): string {
  let s = String(text ?? '')
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-****')
    .replace(/\b(Bearer|token|key|secret|password)([=:\s]+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1$2****')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1****@')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

export function classifyError(input: ClassifyInput): Classified {
  const text = input.text ?? '';
  const detail = cleanDetail(text || input.assistantError || input.startupReason || input.errno || '');
  let code: ClaudeErrorCode | undefined;
  let note: string | undefined;

  // 0) 엔진이 이미 구분한 것 (혼잡 여부만 문구로 본다)
  if (input.code) {
    code = input.code;
    if (code === 'other' && text && BUSY_RE.test(text)) note = 'busy';
  }
  // 1) 텍스트 규칙이 가장 구체적이다 (예: rate_limit 오류여도 "Credit balance is too low"면 결제)
  for (const r of code ? [] : RULES) {
    if (text && r.re.test(text)) {
      code = r.code;
      note = r.note;
      break;
    }
  }
  if (!code && input.startupReason) code = STARTUP_REASON[input.startupReason] ?? 'other';
  if (!code && input.assistantError) code = ASSISTANT_ERROR[input.assistantError] ?? 'other';
  if (!code && input.errno) {
    if (input.errno === 'ENOENT' || input.errno === 'EACCES' || input.errno === 'EPERM') code = 'missing';
    else if (NET_ERRNO.test(input.errno)) code = 'offline';
  }
  if (!code && text && NET_ERRNO.test(text)) code = 'offline';
  if (!code && typeof input.status === 'number') {
    if (input.status === 401) code = 'auth';
    else if (input.status === 402) code = 'billing';
    else if (input.status === 429) code = 'limit';
  }
  if (!code) code = 'other';
  // 텍스트 없이 SDK 분류만 있을 때 (rate_limit 등)
  if (!text && input.assistantError === 'overloaded') note = 'busy';

  let label = code === 'missing' ? MISSING_LABEL[input.provider ?? 'claude'] : KO[code];
  if (code === 'other' && note === 'busy') label = '서버 혼잡 (잠시 후 다시 시도)';
  const message = detail ? `${label}: ${detail}` : label;
  return { code, message, detail };
}

const STATUS_TEXT: Record<AiProvider, Record<ClaudeErrorCode, string>> = {
  claude: {
    missing: 'PC에서 Claude CLI를 찾지 못했습니다. 설치한 뒤 다시 확인하거나 [경로 지정]으로 직접 지정해 주세요.',
    auth: 'Claude 인증에 실패했습니다. Claude Code에 로그인하거나 API 키·회사 클라우드 인증 정보를 확인한 뒤 다시 시도해 주세요.',
    offline: '인터넷에 연결되어 있지 않아 Claude를 쓸 수 없습니다. 분석·탐색 기능은 그대로 쓸 수 있습니다.',
    limit: 'Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 다른 인증 방식(API 키)으로 바꿔 주세요.',
    billing: 'Claude 사용 권한이나 결제 문제로 요청이 거절되었습니다. 로그인한 Claude 계정, API 키를 발급한 Console 계정 또는 회사 클라우드의 상태를 확인해 주세요.',
    other: 'Claude 연결을 확인하지 못했습니다.',
  },
  gemini: {
    missing: 'Gemini 연결에 필요한 프로그램을 찾지 못했습니다. 회사 Google Cloud로 연결하려면 PC에 Google Cloud CLI(gcloud)가 있어야 합니다.',
    auth: 'Gemini 인증에 실패했습니다. API 키 또는 회사 Google Cloud(gcloud 로그인·프로젝트·지역) 설정을 확인한 뒤 다시 시도해 주세요.',
    offline: '인터넷에 연결되어 있지 않아 Gemini를 쓸 수 없습니다. 분석·탐색 기능은 그대로 쓸 수 있습니다.',
    limit: 'Gemini 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 결제를 켠 API 키·회사 Google Cloud로 바꿔 주세요.',
    billing: 'Gemini 사용 권한이나 결제 문제로 요청이 거절되었습니다. API 키를 만든 Google AI Studio 프로젝트의 결제 또는 회사 Google Cloud 프로젝트의 Vertex AI 사용 설정을 확인해 주세요.',
    other: 'Gemini 연결을 확인하지 못했습니다.',
  },
  openai: {
    missing: 'PC에서 Codex CLI를 찾지 못했습니다. 설치(npm install -g @openai/codex)한 뒤 다시 확인하거나 [경로 지정]으로 직접 지정해 주세요.',
    auth: 'ChatGPT 인증에 실패했습니다. ChatGPT 계정으로 다시 로그인하거나 OpenAI API 키·Azure OpenAI 설정을 확인한 뒤 다시 시도해 주세요.',
    offline: '인터넷에 연결되어 있지 않아 ChatGPT를 쓸 수 없습니다. 분석·탐색 기능은 그대로 쓸 수 있습니다.',
    limit: 'ChatGPT 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 다른 인증 방식(API 키)으로 바꿔 주세요.',
    billing: 'ChatGPT 사용 권한이나 결제 문제로 요청이 거절되었습니다. 로그인한 ChatGPT 요금제, OpenAI API 결제 또는 Azure OpenAI 리소스 상태를 확인해 주세요.',
    other: 'ChatGPT 연결을 확인하지 못했습니다.',
  },
};

/** ClaudeStatus.message·POP-03에 쓰는 문구 (화면설계서 MSG-20·21·22·23·30) */
export function statusMessage(code: ClaudeErrorCode, detail?: string, provider: AiProvider = 'claude'): string {
  const base = STATUS_TEXT[provider] ?? STATUS_TEXT.claude;
  const d = detail ? cleanDetail(detail, 300) : '';
  return d ? `${base[code]} (${d})` : base[code];
}

/** 연동 꺼짐 문구 */
export function offMessage(provider: AiProvider = 'claude'): string {
  return `연동이 꺼져 있습니다. ${provider === 'claude' ? 'Claude 연결' : `설정 > AI 연결 > ${AI_LABEL[provider]}`}에서 켤 수 있습니다.`;
}
