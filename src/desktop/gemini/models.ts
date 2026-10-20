// Gemini 모델 목록: API 키 연결은 Google이 알려 준 목록(models.list)에서 글을 만드는 모델만,
// 회사 Google Cloud(Vertex AI)는 목록 API 대신 알려진 모델(직접 입력도 가능). 설정이 같으면 기억해 둔다.
import type { ClaudeModel, ClaudeModelList } from '../../shared/desktop-api';
import { nowIso } from '../store';
import type { GeminiClient, RawGeminiModel } from './client';
import type { GeminiStored } from './config';

/** 연결 설정에 기본 모델이 없을 때 (2026-10 기준 가장 최신 정식 모델) */
export const DEFAULT_GEMINI_MODEL = 'gemini-4-argon';

/** Vertex AI처럼 목록을 받지 못할 때 보여 줄 모델 (2026-10 Gemini API 모델 문서 기준) */
export const KNOWN_GEMINI_MODELS = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

/** 대화에 쓰지 않는 모델 (음성·실시간·이미지·임베딩·로봇 등) */
const NOT_CHAT = /(tts|live|audio|image|imagen|embedding|robotics|transcribe|translate|omni|nano-banana|computer-use|veo|lyria|aqa|learnlm|deep-research|antigravity|native)/i;

/** gemini-3.8-flash → [3, 8] */
function version(id: string): number[] {
  const m = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

/** 성능 순 (같은 버전에서): pro·argon 같은 큰 모델 → flash → flash-lite */
function tier(id: string): number {
  if (/flash-lite/.test(id)) return 2;
  if (/flash/.test(id)) return 1;
  return 0;
}

export function prettyGeminiName(id: string): string {
  const parts = id.replace(/^gemini-/, '').split('-');
  const out: string[] = ['Gemini'];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'lite' && out[out.length - 1] === 'Flash') out[out.length - 1] = 'Flash-Lite';
    else if (p === 'preview') out.push('(미리 보기)');
    else out.push(/^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1));
  }
  return out.join(' ');
}

function describe(id: string): string {
  const d = tier(id) === 2 ? '가장 가벼움' : tier(id) === 1 ? '빠르고 저렴' : '가장 성능 높음';
  return /preview|exp/.test(id) ? `${d} · 미리 보기` : d;
}

export function sortGemini(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const pa = /preview|exp/.test(a) ? 1 : 0;
    const pb = /preview|exp/.test(b) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const [a1, a2] = version(a);
    const [b1, b2] = version(b);
    if (a1 !== b1) return b1 - a1;
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (a2 !== b2) return b2 - a2;
    return a < b ? -1 : 1;
  });
}

/** 고정 판의 기본 이름 (gemini-2.0-flash-001 → gemini-2.0-flash). 고정 판이 아니면 null */
function pinnedBase(id: string): string | null {
  const m = /^(.*?)-(?:preview-)?(?:\d{3}|\d{2}-\d{4}|\d{2}-\d{2})$/.exec(id);
  return m ? m[1] : null;
}

/** API 목록 → 화면 목록 (대화에 쓰는 gemini-* 모델만) */
export function toGeminiModels(raw: RawGeminiModel[]): ClaudeModel[] {
  const byId = new Map<string, RawGeminiModel>();
  for (const m of raw) {
    const id = String(m.name ?? '').replace(/^models\//, '');
    if (!/^gemini-\d/.test(id) || NOT_CHAT.test(id)) continue;
    if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) continue;
    byId.set(id, m);
  }
  // 날짜·번호가 붙은 고정 판(…-001, …-preview-09-2025)은 같은 모델의 기본 이름이 있으면 뺀다
  const ids = [...byId.keys()].filter((id) => {
    const base = pinnedBase(id);
    return !base || !byId.has(base);
  });
  return sortGemini(ids).map((id) => {
    const m = byId.get(id)!;
    return { value: id, name: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : prettyGeminiName(id), description: describe(id) };
  });
}

export function knownGeminiModels(): ClaudeModel[] {
  return KNOWN_GEMINI_MODELS.map((id) => ({ value: id, name: prettyGeminiName(id), description: describe(id) }));
}

/** 기본 모델: 설정 → (목록이 있으면) 목록의 DEFAULT 또는 첫 정식 모델 → DEFAULT */
export function pickDefaultModel(cfg: GeminiStored, list: ClaudeModel[] | null): string {
  if (cfg.model) return cfg.model;
  if (!list?.length || list.some((m) => m.value === DEFAULT_GEMINI_MODEL)) return DEFAULT_GEMINI_MODEL;
  return (list.find((m) => !/preview|exp/.test(m.value)) ?? list[0]).value;
}

export class GeminiModels {
  private cache: { key: string; list: ClaudeModelList } | null = null;
  private inflight: { key: string; p: Promise<ClaudeModelList> } | null = null;

  constructor(private deps: { client(): Promise<{ client: GeminiClient; cfg: GeminiStored; key: string }> }) {}

  invalidate(): void {
    this.cache = null;
  }

  cached(): ClaudeModelList | null {
    return this.cache?.list ?? null;
  }

  label(value: string | undefined): string {
    const list = this.cache?.list;
    if (!value) return list?.defaultName ? `Gemini 기본 모델 (${list.defaultName})` : 'Gemini 기본 모델';
    return list?.models.find((m) => m.value === value)?.name ?? prettyGeminiName(value);
  }

  async list(refresh = false): Promise<ClaudeModelList> {
    const { client, cfg, key } = await this.deps.client();
    // 기본 모델은 목록과 상관없으므로 지문에서 뺀다 (key는 인증 지문)
    if (!refresh && this.cache?.key === key) return this.withDefault(this.cache.list, cfg);
    if (this.inflight?.key === key) return this.withDefault(await this.inflight.p, cfg);
    const p = this.fetch(client).then((list) => {
      if (!list.error) this.cache = { key, list };
      return list;
    });
    this.inflight = { key, p };
    try {
      return this.withDefault(await p, cfg);
    } finally {
      if (this.inflight?.p === p) this.inflight = null;
    }
  }

  private withDefault(list: ClaudeModelList, cfg: GeminiStored): ClaudeModelList {
    const def = pickDefaultModel({ ...cfg, model: undefined }, list.models);
    const name = list.models.find((m) => m.value === def)?.name ?? prettyGeminiName(def);
    return { ...list, defaultName: name, defaultDescription: `연결 설정에서 기본 모델을 고르지 않으면 ${name}` };
  }

  private async fetch(client: GeminiClient): Promise<ClaudeModelList> {
    if (client.vertex) return { models: knownGeminiModels(), at: nowIso() };
    try {
      const models = toGeminiModels(await client.listModels(AbortSignal.timeout(20000)));
      if (!models.length) return { models: knownGeminiModels(), error: 'Google이 알려 준 목록에 대화용 Gemini 모델이 없어 알려진 모델을 보여 줍니다', at: nowIso() };
      return { models, at: nowIso() };
    } catch (e) {
      return { models: knownGeminiModels(), error: `모델 목록을 받지 못했습니다: ${(e as Error)?.message ?? String(e)}`, at: nowIso() };
    }
  }
}
