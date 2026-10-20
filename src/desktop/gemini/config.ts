// Gemini 연결 설정: <dataDir>/gemini.json (비밀 값 없음) + 비밀 값은 store.setSecret (Windows DPAPI)
//   gemini:apikey   Google AI Studio API 키
//   gemini:proxy    계정이 들어 있는 프록시 주소
// 회사 Google Cloud(Vertex AI)는 PC의 gcloud 로그인으로 토큰을 받는다 (앱은 계정 정보를 저장하지 않음).
import type { GeminiAuthMode, GeminiConfig, GeminiConfigInput } from '../../shared/desktop-api';
import { checkProxy, keyAfter, proxyValue, type ProxyFields, readProviderFile, saveKey, saveProxy, updateProviderFile } from '../ai/store';
import { cleanModel } from '../claude/config';
import { DesktopError } from '../ipc';
import { getSecret, hasSecret, nowIso, shortHash } from '../store';

export const KEY_GEMINI_API = 'gemini:apikey';

export interface GeminiStored extends ProxyFields {
  enabled: boolean;
  consentAt?: string;
  authMode: GeminiAuthMode;
  vertex?: { project: string; location: string };
  model?: string;
}

export const DEFAULT_GEMINI: GeminiStored = { enabled: false, authMode: 'apikey' };

function normalize(c: Partial<GeminiStored> | undefined): GeminiStored {
  const s = { ...DEFAULT_GEMINI, ...(c ?? {}) } as GeminiStored;
  s.enabled = !!s.enabled;
  if (s.authMode !== 'apikey' && s.authMode !== 'vertex') s.authMode = 'apikey';
  if (s.vertex && (typeof s.vertex.project !== 'string' || typeof s.vertex.location !== 'string')) s.vertex = undefined;
  return s;
}

export async function getGeminiStored(): Promise<GeminiStored> {
  return normalize((await readProviderFile<GeminiStored>('gemini')).config);
}

function toPublic(s: GeminiStored, hasApiKey: boolean): GeminiConfig {
  const out: GeminiConfig = { enabled: s.enabled, authMode: s.authMode, hasApiKey };
  if (s.consentAt) out.consentAt = s.consentAt;
  if (s.vertex) out.vertex = { ...s.vertex };
  if (s.model) out.model = s.model;
  if (s.proxy) out.proxy = s.proxy;
  return out;
}

export async function getGeminiConfig(): Promise<GeminiConfig> {
  return toPublic(await getGeminiStored(), await hasSecret(KEY_GEMINI_API));
}

export async function getGeminiApiKey(): Promise<string | null> {
  return getSecret(KEY_GEMINI_API);
}

export async function getGeminiProxy(s: GeminiStored): Promise<string | undefined> {
  return proxyValue('gemini', s);
}

/** Google Cloud 프로젝트 ID (소문자·숫자·하이픈 6~30자) · 지역 (us-central1, global …) */
function cleanVertex(v: unknown): { project: string; location: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const project = String((v as { project?: unknown }).project ?? '').trim();
  const location = String((v as { location?: unknown }).location ?? '').trim().toLowerCase() || 'global';
  if (!project && location === 'global') return undefined;
  if (project && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) && !/^[a-z0-9.:-]{3,100}$/.test(project)) throw new DesktopError('Google Cloud 프로젝트 ID가 올바르지 않습니다 (영문 소문자·숫자·하이픈)', 'invalid');
  if (!/^[a-z0-9-]{2,40}$/.test(location)) throw new DesktopError('지역이 올바르지 않습니다 (예: global, us-central1, asia-northeast3)', 'invalid');
  return { project, location };
}

export interface GeminiSetResult {
  config: GeminiConfig;
  enabledNow: boolean;
  disabledNow: boolean;
  /** 인증·프록시·기본 모델이 바뀜 → 연결 확인·열린 대화를 새로 */
  authChanged: boolean;
}

export async function setGeminiConfig(input: GeminiConfigInput): Promise<GeminiSetResult> {
  if (!input || typeof input !== 'object') throw new DesktopError('설정 값이 올바르지 않습니다', 'invalid');
  const before = await getGeminiStored();
  const beforeKey = await geminiAuthKey(before);
  const next = normalize({ ...before, enabled: !!input.enabled, authMode: input.authMode });
  next.model = cleanModel(input.model);
  // 회사 Google Cloud 칸은 그 방식을 고른 때만 확인한다 (다른 방식일 때 잘못 적힌 칸이 저장을 막지 않게 — 그때는 예전 값을 둠)
  if (next.authMode === 'vertex') next.vertex = cleanVertex(input.vertex);
  else {
    try {
      next.vertex = cleanVertex(input.vertex);
    } catch {
      next.vertex = before.vertex;
    }
  }
  if (next.authMode === 'vertex' && next.enabled && !next.vertex?.project) throw new DesktopError('회사 Google Cloud로 연결하려면 프로젝트 ID를 넣어 주세요', 'invalid');
  // 모든 값을 확인한 뒤에 비밀 값을 쓴다 (저장이 실패했는데 키만 지워지거나 바뀌지 않게)
  checkProxy(before, input.proxy);
  if (next.authMode === 'apikey' && next.enabled && !(await keyAfter(KEY_GEMINI_API, input.apiKey))) throw new DesktopError('Gemini API 키를 넣어 주세요', 'invalid');
  await saveKey(KEY_GEMINI_API, input.apiKey);
  Object.assign(next, { proxy: undefined, proxySecret: undefined }, await saveProxy('gemini', before, input.proxy));
  const enabledNow = next.enabled && !before.enabled;
  const disabledNow = !next.enabled && before.enabled;
  // 켤 때마다 동의 시각을 새로 (MSG-14를 보고 [연동 켜기]를 누른 때)
  if (enabledNow) next.consentAt = nowIso();
  await updateProviderFile<GeminiStored>('gemini', (f) => {
    f.config = next;
  });
  return { config: toPublic(next, await hasSecret(KEY_GEMINI_API)), enabledNow, disabledNow, authChanged: (await geminiAuthKey(next)) !== beforeKey };
}

/** 인증에 영향을 주는 설정의 지문 (비밀 값은 해시로만) */
export async function geminiAuthKey(s: GeminiStored): Promise<string> {
  const parts: unknown[] = [s.authMode, s.model ?? ''];
  if (s.authMode === 'apikey') parts.push(shortHash((await getGeminiApiKey()) ?? '', 12));
  else parts.push(s.vertex?.project ?? '', s.vertex?.location ?? '');
  parts.push(shortHash((await getGeminiProxy(s)) ?? '', 8));
  return shortHash(JSON.stringify(parts), 16);
}
