// Claude 연동 설정: <dataDir>/claude.json (비밀 값 없음) + 비밀 값은 store.setSecret (Windows DPAPI)
//   claude:apikey           API 키
//   claude:cloud:<변수 이름>  회사 클라우드 환경 변수 중 비밀 값 (AWS_SECRET_ACCESS_KEY, AWS_BEARER_TOKEN_BEDROCK …)
//   claude:proxy            계정이 들어 있는 프록시 주소 (http://id:pw@proxy:8080)
// 화면에는 비밀 값 대신 hasApiKey·'********'만 보낸다.
import path from 'node:path';
import type { AuthMode, ClaudeConfig, ClaudeConfigInput, ClaudeStatus } from '../../shared/desktop-api';
import { DesktopError } from '../ipc';
import { dataDir, getSecret, hasSecret, nowIso, readJson, setSecret, shortHash, withLock, writeJson } from '../store';

export const SECRET_PLACEHOLDER = '********';
const KEY_API = 'claude:apikey';
const KEY_PROXY = 'claude:proxy';
const cloudKey = (name: string) => `claude:cloud:${name}`;

export type CloudProvider = NonNullable<ClaudeConfig['cloud']>['provider'];

export interface StoredConfig {
  enabled: boolean;
  consentAt?: string;
  authMode: AuthMode;
  cloud?: { provider: CloudProvider; env: Record<string, string>; secretKeys: string[] };
  cliPath?: string;
  model?: string;
  /** 계정이 있으면 가린 주소 (원래 주소는 비밀 값) */
  proxy?: string;
  proxySecret?: boolean;
  shellAllow: string[];
  aiSummary: boolean;
}

/** 마지막 인증 확인 결과 (같은 인증 설정일 때만 다시 씀) */
export interface AuthCache {
  key: string;
  ok: boolean;
  code?: ClaudeStatus['code'];
  label?: string;
  message?: string;
  ms?: number;
  at: string;
}

interface ClaudeFile {
  config?: Partial<StoredConfig>;
  status?: ClaudeStatus;
  auth?: AuthCache;
}

export const DEFAULT_CONFIG: StoredConfig = { enabled: false, authMode: 'login', shellAllow: [], aiSummary: false };

function file(): string {
  return path.join(dataDir(), 'claude.json');
}

async function readFile(): Promise<ClaudeFile> {
  return readJson<ClaudeFile>(file(), {});
}

async function update(fn: (f: ClaudeFile) => void): Promise<ClaudeFile> {
  return withLock(file(), async () => {
    const f = await readFile();
    fn(f);
    await writeJson(file(), f);
    return f;
  });
}

function normalizeStored(c: Partial<StoredConfig> | undefined): StoredConfig {
  const s = { ...DEFAULT_CONFIG, ...(c ?? {}) } as StoredConfig;
  s.enabled = !!s.enabled;
  if (s.authMode !== 'login' && s.authMode !== 'apikey' && s.authMode !== 'cloud') s.authMode = 'login';
  s.shellAllow = Array.isArray(s.shellAllow) ? s.shellAllow.filter((x) => typeof x === 'string' && x.trim()) : [];
  s.aiSummary = !!s.aiSummary;
  if (s.cloud && (!s.cloud.env || typeof s.cloud.env !== 'object')) s.cloud = { ...s.cloud, env: {}, secretKeys: [] };
  if (s.cloud && !Array.isArray(s.cloud.secretKeys)) s.cloud.secretKeys = [];
  return s;
}

export async function getStored(): Promise<StoredConfig> {
  return normalizeStored((await readFile()).config);
}

/** 화면에 보내는 설정 (비밀 값 없음) */
export async function getConfig(): Promise<ClaudeConfig> {
  const s = await getStored();
  return toPublic(s, await hasSecret(KEY_API));
}

function toPublic(s: StoredConfig, hasApiKey: boolean): ClaudeConfig {
  const out: ClaudeConfig = { enabled: s.enabled, authMode: s.authMode, hasApiKey, shellAllow: [...s.shellAllow], aiSummary: s.aiSummary };
  if (s.consentAt) out.consentAt = s.consentAt;
  if (s.cloud) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.cloud.env)) env[k] = s.cloud.secretKeys.includes(k) ? SECRET_PLACEHOLDER : v;
    out.cloud = { provider: s.cloud.provider, env };
  }
  if (s.cliPath) out.cliPath = s.cliPath;
  if (s.model) out.model = s.model;
  if (s.proxy) out.proxy = s.proxy;
  return out;
}

/** 회사 클라우드 환경 변수 중 비밀 값으로 보관할 것 */
export function isSecretEnvName(name: string): boolean {
  if (/^GOOGLE_APPLICATION_CREDENTIALS$/i.test(name)) return false;
  return /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_KEY|PRIVATE_KEY|AUTH_KEY)/i.test(name);
}

/** 사용자가 넣을 수 없는 변수 (앱·CLI 실행을 깨뜨림) */
const BLOCKED_ENV = /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|ELECTRON_\w+|PA_\w+|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i;

function cleanEnvName(k: string): string | null {
  const name = String(k ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(name)) return null;
  if (BLOCKED_ENV.test(name)) return null;
  return name;
}

function hasUserInfo(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url);
}

export function maskProxy(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1****@');
}

function cleanShellAllow(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list) {
    const s = String(x ?? '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 200 || /[\r\n]/.test(String(x))) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * 모델 값: 별칭(sonnet)·모델 이름(claude-…)·[1m] 같은 붙임·회사 클라우드 모델 ID(ARN 등)까지.
 * 비우면 undefined (Claude Code 기본값). 쓸 수 없는 글자가 있으면 오류
 */
export function cleanModel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > 200 || !/^[A-Za-z0-9._:/@[\]+-]+$/.test(s)) throw new DesktopError('모델 이름이 올바르지 않습니다 (영문·숫자·. - _ : / @ [ ] 만)', 'invalid');
  return s;
}

export interface SetResult {
  config: ClaudeConfig;
  /** 처음 켬 (또는 다시 켬) */
  enabledNow: boolean;
  disabledNow: boolean;
  /** 인증·CLI·프록시·모델이 바뀜 → 연결 확인·Claude 프로세스를 새로 */
  authChanged: boolean;
}

export async function setConfig(input: ClaudeConfigInput): Promise<SetResult> {
  if (!input || typeof input !== 'object') throw new DesktopError('설정 값이 올바르지 않습니다', 'invalid');
  const before = await getStored();
  const beforeKey = await authKey(before);
  const next: StoredConfig = normalizeStored({
    ...before,
    enabled: !!input.enabled,
    authMode: input.authMode,
    shellAllow: cleanShellAllow(input.shellAllow),
    aiSummary: !!input.aiSummary,
  });
  next.model = cleanModel(input.model);
  next.cliPath = typeof input.cliPath === 'string' && input.cliPath.trim() ? path.resolve(input.cliPath.trim()) : undefined;

  // API 키: undefined → 그대로, '' → 지움
  if (typeof input.apiKey === 'string') {
    const k = input.apiKey.trim();
    if (k && /[\s\r\n]/.test(k)) throw new DesktopError('API 키에 공백이 들어 있습니다', 'invalid');
    await setSecret(KEY_API, k || null);
  }

  // 회사 클라우드
  if (input.cloud && typeof input.cloud === 'object') {
    const provider = input.cloud.provider;
    if (provider !== 'bedrock' && provider !== 'vertex' && provider !== 'foundry') throw new DesktopError('회사 클라우드 종류가 올바르지 않습니다', 'invalid');
    const prevSecrets = new Set(before.cloud?.secretKeys ?? []);
    const env: Record<string, string> = {};
    const secretKeys: string[] = [];
    for (const [rawK, rawV] of Object.entries(input.cloud.env ?? {})) {
      const k = cleanEnvName(rawK);
      if (!k) continue;
      const v = String(rawV ?? '');
      if (isSecretEnvName(k)) {
        if (v === SECRET_PLACEHOLDER) {
          if (!prevSecrets.has(k)) continue; // 없는 값을 가린 표시로 보냄
        } else if (!v.trim()) {
          await setSecret(cloudKey(k), null);
          continue;
        } else {
          await setSecret(cloudKey(k), v.trim());
        }
        env[k] = '';
        secretKeys.push(k);
      } else {
        if (!v.trim()) continue;
        env[k] = v.trim().slice(0, 2000);
      }
    }
    // 빠진 비밀 값은 지운다
    for (const k of prevSecrets) if (!secretKeys.includes(k)) await setSecret(cloudKey(k), null);
    next.cloud = { provider, env, secretKeys };
  } else {
    for (const k of before.cloud?.secretKeys ?? []) await setSecret(cloudKey(k), null);
    next.cloud = undefined;
  }

  // 프록시 (계정이 들어 있으면 비밀 값으로)
  const proxyIn = typeof input.proxy === 'string' ? input.proxy.trim() : '';
  if (!proxyIn) {
    if (before.proxySecret) await setSecret(KEY_PROXY, null);
    next.proxy = undefined;
    next.proxySecret = undefined;
  } else if (before.proxySecret && before.proxy && proxyIn === before.proxy) {
    // 가린 주소를 그대로 보냄 → 기존 값 유지
  } else {
    if (!/^https?:\/\/[^\s]+$/i.test(proxyIn)) throw new DesktopError('프록시 주소는 http://주소:포트 형식으로 넣어 주세요', 'invalid');
    if (hasUserInfo(proxyIn)) {
      await setSecret(KEY_PROXY, proxyIn);
      next.proxy = maskProxy(proxyIn);
      next.proxySecret = true;
    } else {
      if (before.proxySecret) await setSecret(KEY_PROXY, null);
      next.proxy = proxyIn;
      next.proxySecret = undefined;
    }
  }

  // 동의 시각: 처음 켤 때 (화면이 MSG-14를 보여 준 뒤 켬)
  const enabledNow = next.enabled && !before.enabled;
  const disabledNow = !next.enabled && before.enabled;
  if (enabledNow && !next.consentAt) next.consentAt = nowIso();

  await update((f) => {
    f.config = next;
  });
  const afterKey = await authKey(next);
  return { config: toPublic(next, await hasSecret(KEY_API)), enabledNow, disabledNow, authChanged: afterKey !== beforeKey };
}

/** 저장된 설정의 CLI 경로만 바꾼다 ([경로 지정]) */
export async function setCliPath(p: string | undefined): Promise<void> {
  await update((f) => {
    const c = normalizeStored(f.config);
    c.cliPath = p;
    f.config = c;
  });
}

export async function getApiKey(): Promise<string | null> {
  return getSecret(KEY_API);
}

export async function getProxy(s: StoredConfig): Promise<string | undefined> {
  if (!s.proxy) return undefined;
  if (s.proxySecret) return (await getSecret(KEY_PROXY)) ?? undefined;
  return s.proxy;
}

/** 회사 클라우드 환경 변수 (비밀 값 포함) */
export async function getCloudEnv(s: StoredConfig): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!s.cloud) return out;
  for (const [k, v] of Object.entries(s.cloud.env)) {
    if (s.cloud.secretKeys.includes(k)) {
      const sv = await getSecret(cloudKey(k));
      if (sv) out[k] = sv;
    } else if (v) out[k] = v;
  }
  return out;
}

/** 인증에 영향을 주는 설정의 지문 (비밀 값은 해시로만) */
export async function authKey(s: StoredConfig): Promise<string> {
  const parts: unknown[] = [s.authMode, s.cliPath ?? '', s.model ?? ''];
  if (s.authMode === 'apikey') parts.push(shortHash((await getApiKey()) ?? '', 12));
  if (s.authMode === 'cloud') parts.push(s.cloud?.provider ?? '', s.cloud?.env ?? {}, shortHash(JSON.stringify(await getCloudEnv(s)), 12));
  parts.push(shortHash((await getProxy(s)) ?? '', 8));
  return shortHash(JSON.stringify(parts), 16);
}

export async function loadStatusCache(): Promise<{ status?: ClaudeStatus; auth?: AuthCache }> {
  const f = await readFile();
  return { status: f.status, auth: f.auth };
}

export async function saveStatusCache(status: ClaudeStatus | undefined, auth?: AuthCache | null): Promise<void> {
  await update((f) => {
    if (status) f.status = status;
    if (auth === null) delete f.auth;
    else if (auth) f.auth = auth;
  });
}
