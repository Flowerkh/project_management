// ChatGPT 연결 설정: <dataDir>/openai.json (비밀 값 없음) + 비밀 값은 store.setSecret (Windows DPAPI)
//   openai:apikey      OpenAI API 키 (Codex에 환경 변수로만 넘김 — PC의 Codex 로그인 정보는 건드리지 않음)
//   openai:azure:key   Azure OpenAI 키 (없으면 PC의 Azure 로그인(az) 토큰)
//   openai:proxy       계정이 들어 있는 프록시 주소
// ChatGPT 계정 로그인은 PC의 Codex 로그인(~/.codex)을 그대로 쓴다. 앱은 로그인 정보를 읽거나 저장하지 않는다.
import path from 'node:path';
import type { OpenAiAuthMode, OpenAiConfig, OpenAiConfigInput } from '../../shared/desktop-api';
import { checkKey, checkProxy, keyAfter, proxyValue, type ProxyFields, readProviderFile, saveKey, saveProxy, updateProviderFile } from '../ai/store';
import { cleanModel } from '../claude/config';
import { DesktopError } from '../ipc';
import { getSecret, hasSecret, nowIso, shortHash } from '../store';

export const KEY_OPENAI_API = 'openai:apikey';
export const KEY_AZURE = 'openai:azure:key';

export interface OpenAiStored extends ProxyFields {
  enabled: boolean;
  consentAt?: string;
  authMode: OpenAiAuthMode;
  azure?: { endpoint: string; deployment: string };
  cliPath?: string;
  model?: string;
}

export const DEFAULT_OPENAI: OpenAiStored = { enabled: false, authMode: 'chatgpt' };

function normalize(c: Partial<OpenAiStored> | undefined): OpenAiStored {
  const s = { ...DEFAULT_OPENAI, ...(c ?? {}) } as OpenAiStored;
  s.enabled = !!s.enabled;
  if (s.authMode !== 'chatgpt' && s.authMode !== 'apikey' && s.authMode !== 'azure') s.authMode = 'chatgpt';
  if (s.azure && (typeof s.azure.endpoint !== 'string' || typeof s.azure.deployment !== 'string')) s.azure = undefined;
  return s;
}

export async function getOpenAiStored(): Promise<OpenAiStored> {
  return normalize((await readProviderFile<OpenAiStored>('openai')).config);
}

async function toPublic(s: OpenAiStored): Promise<OpenAiConfig> {
  const out: OpenAiConfig = { enabled: s.enabled, authMode: s.authMode, hasApiKey: await hasSecret(KEY_OPENAI_API) };
  if (s.consentAt) out.consentAt = s.consentAt;
  if (s.azure) out.azure = { ...s.azure, hasKey: await hasSecret(KEY_AZURE) };
  if (s.cliPath) out.cliPath = s.cliPath;
  if (s.model) out.model = s.model;
  if (s.proxy) out.proxy = s.proxy;
  return out;
}

export async function getOpenAiConfig(): Promise<OpenAiConfig> {
  return toPublic(await getOpenAiStored());
}

export async function getOpenAiKey(): Promise<string | null> {
  return getSecret(KEY_OPENAI_API);
}

export async function getAzureKey(): Promise<string | null> {
  return getSecret(KEY_AZURE);
}

export async function getOpenAiProxy(s: OpenAiStored): Promise<string | undefined> {
  return proxyValue('openai', s);
}

/** https://{리소스}.openai.azure.com (뒤의 /openai/… 는 떼어 냄) · 배포 이름 */
function cleanAzure(v: unknown): { endpoint: string; deployment: string; key?: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const raw = String((v as { endpoint?: unknown }).endpoint ?? '').trim();
  const deployment = String((v as { deployment?: unknown }).deployment ?? '').trim();
  const key = (v as { key?: unknown }).key;
  if (!raw && !deployment) return typeof key === 'string' ? { endpoint: '', deployment: '', key } : undefined;
  let endpoint = raw.replace(/\/+$/, '').replace(/\/openai(\/.*)?$/i, '');
  if (endpoint && !/^https:\/\/[^\s/]+$/i.test(endpoint)) throw new DesktopError('Azure OpenAI 엔드포인트는 https://리소스이름.openai.azure.com 형식으로 넣어 주세요', 'invalid');
  if (deployment && !/^[A-Za-z0-9._-]{1,64}$/.test(deployment)) throw new DesktopError('배포 이름이 올바르지 않습니다 (영문·숫자·. _ -)', 'invalid');
  endpoint = endpoint.toLowerCase();
  return { endpoint, deployment, ...(typeof key === 'string' ? { key } : {}) };
}

export interface OpenAiSetResult {
  config: OpenAiConfig;
  enabledNow: boolean;
  disabledNow: boolean;
  /** 인증·CLI·프록시·기본 모델이 바뀜 → 연결 확인·열린 대화를 새로 */
  authChanged: boolean;
}

export async function setOpenAiConfig(input: OpenAiConfigInput): Promise<OpenAiSetResult> {
  if (!input || typeof input !== 'object') throw new DesktopError('설정 값이 올바르지 않습니다', 'invalid');
  const before = await getOpenAiStored();
  const beforeKey = await openAiAuthKey(before);
  const next = normalize({ ...before, enabled: !!input.enabled, authMode: input.authMode });
  next.model = cleanModel(input.model);
  next.cliPath = typeof input.cliPath === 'string' && input.cliPath.trim() ? path.resolve(input.cliPath.trim()) : undefined;
  // Azure 칸은 그 방식을 고른 때만 확인한다 (다른 방식일 때 잘못 적힌 칸이 저장을 막지 않게 — 그때는 예전 값을 둠)
  let az: ReturnType<typeof cleanAzure>;
  if (next.authMode === 'azure') az = cleanAzure(input.azure);
  else {
    try {
      az = cleanAzure(input.azure);
    } catch {
      az = before.azure ? { ...before.azure } : undefined;
    }
  }
  next.azure = az && (az.endpoint || az.deployment) ? { endpoint: az.endpoint, deployment: az.deployment } : undefined;
  if (next.enabled && next.authMode === 'azure' && (!next.azure?.endpoint || !next.azure.deployment)) throw new DesktopError('Azure OpenAI로 연결하려면 엔드포인트와 배포 이름을 넣어 주세요', 'invalid');
  // 모든 값을 확인한 뒤에 비밀 값을 쓴다 (저장이 실패했는데 키만 지워지거나 바뀌지 않게)
  const azureKey = az && typeof az.key === 'string' ? az.key : undefined;
  checkKey(azureKey, 'Azure 키');
  checkProxy(before, input.proxy);
  if (next.enabled && next.authMode === 'apikey' && !(await keyAfter(KEY_OPENAI_API, input.apiKey))) throw new DesktopError('OpenAI API 키를 넣어 주세요', 'invalid');
  await saveKey(KEY_OPENAI_API, input.apiKey);
  // Azure 설정(엔드포인트·배포 이름)을 비우면 저장한 Azure 키도 지운다 (보이지 않는 키를 남기지 않음)
  if (!next.azure) {
    if (before.azure || azureKey !== undefined) await saveKey(KEY_AZURE, '');
  } else await saveKey(KEY_AZURE, azureKey, 'Azure 키');
  Object.assign(next, { proxy: undefined, proxySecret: undefined }, await saveProxy('openai', before, input.proxy));
  const enabledNow = next.enabled && !before.enabled;
  const disabledNow = !next.enabled && before.enabled;
  // 켤 때마다 동의 시각을 새로 (MSG-14를 보고 [연동 켜기]를 누른 때)
  if (enabledNow) next.consentAt = nowIso();
  await updateProviderFile<OpenAiStored>('openai', (f) => {
    f.config = next;
  });
  return { config: await toPublic(next), enabledNow, disabledNow, authChanged: (await openAiAuthKey(next)) !== beforeKey };
}

/** CLI 경로만 바꾼다 ([경로 지정]) */
export async function setCodexPath(p: string | undefined): Promise<void> {
  await updateProviderFile<OpenAiStored>('openai', (f) => {
    const c = normalize(f.config);
    c.cliPath = p;
    f.config = c;
  });
}

/** 인증에 영향을 주는 설정의 지문 (비밀 값은 해시로만) */
export async function openAiAuthKey(s: OpenAiStored): Promise<string> {
  const parts: unknown[] = [s.authMode, s.cliPath ?? '', s.model ?? ''];
  if (s.authMode === 'apikey') parts.push(shortHash((await getOpenAiKey()) ?? '', 12));
  if (s.authMode === 'azure') parts.push(s.azure?.endpoint ?? '', s.azure?.deployment ?? '', shortHash((await getAzureKey()) ?? '', 12));
  parts.push(shortHash((await getOpenAiProxy(s)) ?? '', 8));
  return shortHash(JSON.stringify(parts), 16);
}
