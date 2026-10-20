// AI 공통 설정: <dataDir>/ai.json — 새 대화의 기본 AI, 모든 AI가 실행할 수 있는 셸 명령(허용 목록).
// 셸 허용 목록은 v0.5까지 Claude 연결(claude.json)에 있었다 → ai.json에 없으면 그 값을 처음 한 번 옮겨 쓴다.
import path from 'node:path';
import { AI_PROVIDERS, type AiProvider, type AiSettings } from '../../shared/desktop-api';
import { DesktopError } from '../ipc';
import { dataDir, readJson, withLock, writeJson } from '../store';

interface AiFile {
  settings?: Partial<AiSettings>;
}

interface LegacyClaudeFile {
  config?: { shellAllow?: unknown };
}

export const DEFAULT_AI: AiSettings = { defaultProvider: 'claude', shellAllow: [] };

function file(): string {
  return path.join(dataDir(), 'ai.json');
}

export function isProvider(v: unknown): v is AiProvider {
  return typeof v === 'string' && (AI_PROVIDERS as string[]).includes(v);
}

/** 셸 허용 목록 다듬기: 공백 하나로, 줄바꿈·200자 넘는 항목·중복 제외, 50개까지 */
export function cleanShellAllow(list: unknown): string[] {
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

function normalize(s: Partial<AiSettings> | undefined, legacyShell: string[] | undefined): AiSettings {
  return {
    defaultProvider: isProvider(s?.defaultProvider) ? s!.defaultProvider : DEFAULT_AI.defaultProvider,
    shellAllow: Array.isArray(s?.shellAllow) ? cleanShellAllow(s!.shellAllow) : (legacyShell ?? []),
  };
}

async function legacyShellAllow(): Promise<string[] | undefined> {
  const c = await readJson<LegacyClaudeFile>(path.join(dataDir(), 'claude.json'), {});
  return Array.isArray(c.config?.shellAllow) ? cleanShellAllow(c.config!.shellAllow) : undefined;
}

export async function getAiSettings(): Promise<AiSettings> {
  const f = await readJson<AiFile>(file(), {});
  return normalize(f.settings, Array.isArray(f.settings?.shellAllow) ? undefined : await legacyShellAllow());
}

export async function setAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  if (!patch || typeof patch !== 'object') throw new DesktopError('설정 값이 올바르지 않습니다', 'invalid');
  if (patch.defaultProvider !== undefined && !isProvider(patch.defaultProvider)) throw new DesktopError('AI 종류가 올바르지 않습니다', 'invalid');
  return withLock(file(), async () => {
    const f = await readJson<AiFile>(file(), {});
    const cur = normalize(f.settings, Array.isArray(f.settings?.shellAllow) ? undefined : await legacyShellAllow());
    const next: AiSettings = {
      defaultProvider: patch.defaultProvider ?? cur.defaultProvider,
      shellAllow: patch.shellAllow !== undefined ? cleanShellAllow(patch.shellAllow) : cur.shellAllow,
    };
    await writeJson(file(), { ...f, settings: next });
    return next;
  });
}
