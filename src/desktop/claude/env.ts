// Claude Code 프로세스에 넘길 환경 변수.
// - Claude Code 로그인(기본): 앱 환경 그대로. Claude 계정 정보·토큰을 읽거나 넣지 않고, 인증 방식을 막지 않는다.
// - API 키: 앱에 저장한 키를 ANTHROPIC_API_KEY로 (사용자가 고른 방식이 쓰이도록 더 우선하는 ANTHROPIC_AUTH_TOKEN·클라우드 스위치는 뺀다)
// - 회사 클라우드: 공급자 스위치 + 사용자가 넣은 환경 변수.
//   Claude Code 문서의 변수 이름 (2026-10 확인):
//     Amazon Bedrock  https://code.claude.com/docs/en/amazon-bedrock
//       CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION(없으면 AWS_DEFAULT_REGION → 프로필 → us-east-1), AWS_PROFILE,
//       AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, AWS_BEARER_TOKEN_BEDROCK(Bedrock API 키),
//       ANTHROPIC_BEDROCK_BASE_URL, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL·_SONNET_MODEL·_HAIKU_MODEL
//     Google Cloud (Vertex AI / Agent Platform)  https://code.claude.com/docs/en/google-vertex-ai
//       CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION(global·us·eu·us-east5 …), ANTHROPIC_VERTEX_PROJECT_ID,
//       ANTHROPIC_VERTEX_BASE_URL, GOOGLE_APPLICATION_CREDENTIALS, VERTEX_REGION_CLAUDE_*
//     Microsoft Foundry  https://code.claude.com/docs/en/microsoft-foundry
//       CLAUDE_CODE_USE_FOUNDRY=1, ANTHROPIC_FOUNDRY_RESOURCE(리소스 이름) 또는 ANTHROPIC_FOUNDRY_BASE_URL
//       (https://{resource}.services.ai.azure.com/anthropic), ANTHROPIC_FOUNDRY_API_KEY 또는 ANTHROPIC_FOUNDRY_AUTH_TOKEN
//       (없으면 Entra ID 기본 자격 증명 체인: az login)
// - 회사 프록시: https://code.claude.com/docs/en/network-config — https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY 순으로
//   처음 있는 값을 쓴다 → 네 가지를 모두 같은 값으로 맞춘다 (Windows는 대소문자 구분이 없어 하나로).
// - 앱 내부 변수(PA_*)는 넘기지 않는다.
import os from 'node:os';
import path from 'node:path';
import { cleanEnvForCli } from './cli';
import { type CloudProvider, getApiKey, getCloudEnv, getProxy, type StoredConfig } from './config';

export type CliEnv = Record<string, string | undefined>;

const PROVIDER_SWITCH: Record<CloudProvider, string> = {
  bedrock: 'CLAUDE_CODE_USE_BEDROCK',
  vertex: 'CLAUDE_CODE_USE_VERTEX',
  foundry: 'CLAUDE_CODE_USE_FOUNDRY',
};
const ALL_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE'];

export const PROVIDER_LABEL: Record<CloudProvider, string> = { bedrock: 'Amazon Bedrock', vertex: 'Google Cloud', foundry: 'Microsoft Foundry' };

/** 같은 이름(Windows는 대소문자 무시)의 변수를 모두 지운다 */
export function delEnv(env: CliEnv, name: string, platform: NodeJS.Platform = process.platform): void {
  const u = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k === name || (platform === 'win32' && k.toUpperCase() === u)) delete env[k];
  }
}

export function setEnv(env: CliEnv, name: string, value: string, platform: NodeJS.Platform = process.platform): void {
  delEnv(env, name, platform);
  env[name] = value;
}

export interface BuildEnvOptions {
  base?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  appVersion?: string;
}

export async function buildCliEnv(cfg: StoredConfig, opts: BuildEnvOptions = {}): Promise<CliEnv> {
  const platform = opts.platform ?? process.platform;
  const env: CliEnv = { ...cleanEnvForCli(opts.base ?? process.env) };

  if (cfg.authMode === 'apikey') {
    const key = await getApiKey();
    if (key) {
      setEnv(env, 'ANTHROPIC_API_KEY', key, platform);
      delEnv(env, 'ANTHROPIC_AUTH_TOKEN', platform);
      for (const s of ALL_SWITCHES) delEnv(env, s, platform);
    }
  } else if (cfg.authMode === 'cloud' && cfg.cloud) {
    for (const s of ALL_SWITCHES) delEnv(env, s, platform);
    setEnv(env, PROVIDER_SWITCH[cfg.cloud.provider], '1', platform);
    for (const [k, v] of Object.entries(await getCloudEnv(cfg))) setEnv(env, k, v, platform);
  }

  const proxy = await getProxy(cfg);
  if (proxy) {
    for (const n of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delEnv(env, n, platform);
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    if (platform !== 'win32') {
      env.https_proxy = proxy;
      env.http_proxy = proxy;
    }
  }
  // 요청 User-Agent에 앱 이름 (SDK 문서의 CLAUDE_AGENT_SDK_CLIENT_APP)
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `project-analyzer/${opts.appVersion ?? '0'}`;
  return env;
}

/** Claude Code 설정 폴더 (계획 파일 ~/.claude/plans 확인용 — 안의 파일은 읽지 않는다) */
export function claudeConfigDir(env: CliEnv): string {
  const v = env.CLAUDE_CONFIG_DIR ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'CLAUDE_CONFIG_DIR')?.[1];
  return v ? path.resolve(v) : path.join(os.homedir(), '.claude');
}

/** 연결 확인 주소: 인증 방식에 맞는 서버 (모르면 null = 건너뜀) */
export function netCheckUrl(cfg: StoredConfig, cloudEnv: Record<string, string>, base: NodeJS.ProcessEnv = process.env): string | null {
  if (cfg.authMode !== 'cloud' || !cfg.cloud) return 'https://api.anthropic.com/';
  const get = (k: string) => cloudEnv[k] || base[k] || '';
  const url = (u: string) => (/^https?:\/\//i.test(u) ? u : null);
  if (cfg.cloud.provider === 'bedrock') {
    const custom = url(get('ANTHROPIC_BEDROCK_BASE_URL'));
    if (custom) return custom;
    const region = (get('AWS_REGION') || get('AWS_DEFAULT_REGION') || 'us-east-1').trim();
    return /^[a-z0-9-]+$/i.test(region) ? `https://bedrock-runtime.${region}.amazonaws.com/` : 'https://bedrock-runtime.us-east-1.amazonaws.com/';
  }
  if (cfg.cloud.provider === 'vertex') {
    const custom = url(get('ANTHROPIC_VERTEX_BASE_URL'));
    if (custom) return custom;
    const region = (get('CLOUD_ML_REGION') || 'us-east5').trim().toLowerCase();
    if (region === 'global') return 'https://aiplatform.googleapis.com/';
    if (region === 'us' || region === 'eu') return `https://aiplatform.${region}.rep.googleapis.com/`;
    return /^[a-z0-9-]+$/.test(region) ? `https://${region}-aiplatform.googleapis.com/` : 'https://aiplatform.googleapis.com/';
  }
  const custom = url(get('ANTHROPIC_FOUNDRY_BASE_URL'));
  if (custom) return custom;
  const res = get('ANTHROPIC_FOUNDRY_RESOURCE').trim();
  return /^[a-z0-9-]+$/i.test(res) ? `https://${res}.services.ai.azure.com/` : null;
}
