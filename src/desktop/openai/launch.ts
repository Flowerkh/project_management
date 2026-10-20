// `codex app-server`를 띄울 인수·환경 변수. 사용자의 Codex 설정 파일(~/.codex/config.toml)은 고치지 않고
// 실행할 때 덮어쓰기(-c key=value)로만 바꾼다.
//   - Codex 자체 도구(셸·이미지·하위 에이전트·앱·플러그인·브라우저·목표·기억·훅 등)를 끄고, 앱 도구(동적 도구)로만 일하게 한다
//     → 파일 읽기·수정·명령·DB가 Gemini·Claude와 같은 막기 규칙(guards.ts)을 거친다 (codex-cli 0.163.0에서 요청의 tools 확인)
//   - 웹 검색 끔, 프로젝트의 AGENTS.md 읽지 않음
//   - API 키: 앱이 정한 공급자(pa_openai, Responses API)와 환경 변수 PROJECT_ANALYZER_OPENAI_KEY — PC의 Codex 로그인은 그대로
//   - Azure OpenAI: 공급자 pa_azure (https://{리소스}.openai.azure.com/openai/v1). 키가 없으면 PC의 Azure 로그인으로
//     토큰을 받는 명령(az account get-access-token)을 공급자 인증 명령(auth.command)으로 준다
import { EngineError } from '../ai/engine';
import { cleanEnvForCli } from '../claude/cli';
import { getAzureKey, getOpenAiKey, getOpenAiProxy, type OpenAiStored } from './config';

/** 끄는 Codex 기능 (experimentalFeature/list 이름 — 없는 이름은 Codex가 무시) */
export const CODEX_FEATURES_OFF = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'sleep_tool',
  'multi_agent',
  'apps',
  'plugins',
  'tool_suggest',
  'in_app_browser',
  'browser_use',
  'computer_use',
  'image_generation',
  'goals',
  'hooks',
  'skill_search',
  'memories',
  'workspace_dependencies',
  'realtime_conversation',
];

export const ENV_OPENAI_KEY = 'PROJECT_ANALYZER_OPENAI_KEY';
export const ENV_AZURE_KEY = 'PROJECT_ANALYZER_AZURE_KEY';
const AZURE_SCOPE = 'https://cognitiveservices.azure.com';

/** -c 값 (TOML): 글자·참거짓·숫자·배열·인라인 표 */
export function toToml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(toToml).join(', ')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${toToml(x)}`)
      .join(', ')}}`;
  throw new Error(`TOML로 바꿀 수 없는 값: ${String(v)}`);
}

export interface LaunchPlan {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** 공급자가 정한 모델 (Azure: 배포 이름) — 있으면 대화의 모델 대신 */
  fixedModel?: string;
  /** 연결 확인 주소 */
  netUrl: string;
  authLabel: string;
}

export interface LaunchOptions {
  /** 시험용: 가짜 OpenAI(Responses API) 서버 주소 (…/v1까지). API 키·Azure 방식에서 실제 주소 대신 */
  baseUrl?: string;
  /** 시험용: 앱이 정한 공급자(pa_openai·pa_azure)에 더할 값 (다시 시도 횟수 등) */
  providerExtra?: Record<string, unknown>;
  platform?: NodeJS.Platform;
}

function testBaseUrl(o: LaunchOptions): string | undefined {
  if (o.baseUrl) return o.baseUrl.replace(/\/+$/, '');
  if (process.env.PA_E2E === '1' && process.env.PA_FAKE_OPENAI_URL) return process.env.PA_FAKE_OPENAI_URL.replace(/\/+$/, '');
  return undefined;
}

export function openAiAuthLabel(cfg: OpenAiStored): string {
  if (cfg.authMode === 'apikey') return 'OpenAI API 키 (앱에 저장)';
  if (cfg.authMode === 'azure') return `Azure OpenAI${cfg.azure?.endpoint ? ` (${cfg.azure.endpoint.replace(/^https:\/\//, '')})` : ''}`;
  return 'ChatGPT 계정 로그인 (Codex)';
}

export async function launchPlan(cfg: OpenAiStored, o: LaunchOptions = {}): Promise<LaunchPlan> {
  const platform = o.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = cleanEnvForCli(process.env);
  // 앱 안에서 다른 Codex를 띄운 경우의 표시는 넘기지 않는다
  delete env.CODEX_THREAD_ID;
  const over: [string, unknown][] = [];
  for (const f of CODEX_FEATURES_OFF) over.push([`features.${f}`, false]);
  over.push(['web_search', 'disabled'], ['project_doc_max_bytes', 0]);
  let fixedModel: string | undefined;
  let netUrl = 'https://chatgpt.com/';
  const base = testBaseUrl(o);
  if (cfg.authMode === 'apikey') {
    const key = await getOpenAiKey();
    if (!key) throw new EngineError('OpenAI API 키가 없습니다 (설정 > AI 연결 > ChatGPT)', 'auth');
    env[ENV_OPENAI_KEY] = key;
    over.push(['model_provider', 'pa_openai'], ['model_providers.pa_openai', { name: 'OpenAI API', base_url: base ?? 'https://api.openai.com/v1', env_key: ENV_OPENAI_KEY, wire_api: 'responses', ...(o.providerExtra ?? {}) }]);
    netUrl = base ? `${base}/` : 'https://api.openai.com/';
  } else if (cfg.authMode === 'azure') {
    const az = cfg.azure;
    if (!az?.endpoint || !az.deployment) throw new EngineError('Azure OpenAI 엔드포인트와 배포 이름을 넣어 주세요 (설정 > AI 연결 > ChatGPT)', 'auth');
    const provider: Record<string, unknown> = { name: 'Azure OpenAI', base_url: base ?? `${az.endpoint}/openai/v1`, wire_api: 'responses' };
    const key = await getAzureKey();
    if (key) {
      env[ENV_AZURE_KEY] = key;
      provider.env_key = ENV_AZURE_KEY;
    } else {
      // PC의 Azure 로그인 (az login) — Windows의 az는 az.cmd라 cmd로 실행
      const azArgs = ['account', 'get-access-token', '--resource', AZURE_SCOPE, '--query', 'accessToken', '-o', 'tsv'];
      provider.auth = platform === 'win32' ? { command: 'cmd.exe', args: ['/d', '/c', 'az', ...azArgs], timeout_ms: 30000, refresh_interval_ms: 600000 } : { command: 'az', args: azArgs, timeout_ms: 30000, refresh_interval_ms: 600000 };
    }
    over.push(['model_provider', 'pa_azure'], ['model_providers.pa_azure', { ...provider, ...(o.providerExtra ?? {}) }]);
    fixedModel = az.deployment;
    netUrl = base ? `${base}/` : `${az.endpoint}/`;
  }
  const proxy = await getOpenAiProxy(cfg);
  if (proxy) {
    for (const k of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(k)) delete env[k];
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    if (platform !== 'win32') {
      env.https_proxy = proxy;
      env.http_proxy = proxy;
    }
  }
  return { args: over.flatMap(([k, v]) => ['-c', `${k}=${toToml(v)}`]), env, ...(fixedModel ? { fixedModel } : {}), netUrl, authLabel: openAiAuthLabel(cfg) };
}
