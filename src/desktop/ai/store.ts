// Gemini·ChatGPT 연결 설정 파일: <dataDir>/gemini.json · openai.json (비밀 값 없음)
//   { config, status(마지막 연결 상태), auth(마지막 인증 확인 결과) }
// 비밀 값(API 키, 계정이 든 프록시 주소)은 store.setSecret (Windows DPAPI) — 키 이름 '<provider>:…'
import path from 'node:path';
import type { ClaudeErrorCode, ClaudeStatus } from '../../shared/desktop-api';
import { DesktopError } from '../ipc';
import { dataDir, getSecret, hasSecret, readJson, setSecret, withLock, writeJson } from '../store';
import type { EngineProvider } from './engine';

export const SECRET_PLACEHOLDER = '********';

/** 마지막 인증 확인 결과 (같은 인증 설정일 때만 다시 씀) */
export interface AuthCache {
  key: string;
  ok: boolean;
  code?: ClaudeErrorCode;
  label?: string;
  message?: string;
  ms?: number;
  at: string;
}

export interface ProviderFile<C> {
  config?: Partial<C>;
  status?: ClaudeStatus;
  auth?: AuthCache;
}

function file(p: EngineProvider): string {
  return path.join(dataDir(), `${p}.json`);
}

export async function readProviderFile<C>(p: EngineProvider): Promise<ProviderFile<C>> {
  return readJson<ProviderFile<C>>(file(p), {});
}

export async function updateProviderFile<C>(p: EngineProvider, fn: (f: ProviderFile<C>) => void): Promise<ProviderFile<C>> {
  return withLock(file(p), async () => {
    const f = await readProviderFile<C>(p);
    fn(f);
    await writeJson(file(p), f);
    return f;
  });
}

// ------------------------------------------------------------------ 프록시

export interface ProxyFields {
  /** 계정이 있으면 가린 주소 (원래 주소는 비밀 값) */
  proxy?: string;
  proxySecret?: boolean;
}

function hasUserInfo(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url);
}

export function maskProxy(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1****@');
}

/** 프록시 주소 확인만 (저장하지 않음). 저장 전에 모든 값을 먼저 확인해, 실패한 저장이 비밀 값만 바꾸지 않게 */
export function checkProxy(before: ProxyFields, raw: unknown): void {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || (before.proxySecret && before.proxy && v === before.proxy)) return;
  if (!/^https?:\/\/[^\s]+$/i.test(v)) throw new DesktopError('프록시 주소는 http://주소:포트 형식으로 넣어 주세요', 'invalid');
}

/** 화면에서 받은 프록시 주소를 저장할 값으로 (계정이 들어 있으면 비밀 값으로 따로) */
export async function saveProxy(p: EngineProvider, before: ProxyFields, raw: unknown): Promise<ProxyFields> {
  const key = `${p}:proxy`;
  checkProxy(before, raw);
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) {
    if (before.proxySecret) await setSecret(key, null);
    return {};
  }
  // 가린 주소를 그대로 보냄 → 기존 값 유지
  if (before.proxySecret && before.proxy && v === before.proxy) return { proxy: before.proxy, proxySecret: true };
  if (hasUserInfo(v)) {
    await setSecret(key, v);
    return { proxy: maskProxy(v), proxySecret: true };
  }
  if (before.proxySecret) await setSecret(key, null);
  return { proxy: v };
}

export async function proxyValue(p: EngineProvider, f: ProxyFields): Promise<string | undefined> {
  if (!f.proxy) return undefined;
  if (f.proxySecret) return (await getSecret(`${p}:proxy`)) ?? undefined;
  return f.proxy;
}

/** 비밀 값 입력 확인만 (저장하지 않음): keep 그대로 · clear 지움 · set 새 값. 공백·길이가 맞지 않으면 오류 */
export function checkKey(raw: unknown, what = 'API 키'): 'keep' | 'clear' | 'set' {
  if (typeof raw !== 'string') return 'keep';
  const k = raw.trim();
  if (k === SECRET_PLACEHOLDER) return 'keep';
  if (!k) return 'clear';
  if (/\s/.test(k)) throw new DesktopError(`${what}에 공백이 들어 있습니다`, 'invalid');
  if (k.length > 4000) throw new DesktopError(`${what}가 너무 깁니다`, 'invalid');
  return 'set';
}

/** 저장한 뒤에 그 비밀 값이 있을지 (저장하기 전에 확인) */
export async function keyAfter(key: string, raw: unknown, what?: string): Promise<boolean> {
  const op = checkKey(raw, what);
  return op === 'set' || (op === 'keep' && (await hasSecret(key)));
}

/** 비밀 값 저장: undefined → 그대로, '' → 지움. 공백이 들어 있으면 오류 */
export async function saveKey(key: string, raw: unknown, what = 'API 키'): Promise<void> {
  const op = checkKey(raw, what);
  if (op === 'keep') return;
  await setSecret(key, op === 'set' ? String(raw).trim() : null);
}
