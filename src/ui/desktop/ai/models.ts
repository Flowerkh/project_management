// 모델 목록 (ai.models): AI마다 그 AI가 알려 준 쓸 수 있는 모델과 지금 계정.
//   Claude  PC의 Claude Code가 알려 준 목록      Gemini  Google이 알려 준 목록 (회사 Google Cloud는 알려진 모델)
//   ChatGPT PC의 Codex가 알려 준 목록 (Azure OpenAI는 배포 이름)
// 메인 프로세스가 기억하고, 화면도 AI별로 한 번 받은 것을 같이 쓴다. 어디서든 새로 받으면(설정의 [다시 확인] 등)
// 그 AI의 목록을 쓰는 곳이 모두 바뀐다. 저장은 하지 않는다(계정 이름은 화면에만).
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AiProvider, ClaudeModel, ClaudeModelList } from '../../../shared/desktop-api';
import { errText } from '../bridge';
import type { DeskApp } from '../ctx';

interface Slot {
  cache: ClaudeModelList | null;
  inflight: Promise<ClaudeModelList> | null;
  listeners: Set<(l: ClaudeModelList) => void>;
}

const slot = (): Slot => ({ cache: null, inflight: null, listeners: new Set() });
const slots: Record<AiProvider, Slot> = { claude: slot(), gemini: slot(), openai: slot() };

/** 그 AI의 연결 설정이 바뀜 → 다음에 다시 받음 */
export function invalidateModels(p: AiProvider): void {
  slots[p].cache = null;
}

/** 받아 둔 목록 (받지 않음) */
export function peekModels(p: AiProvider): ClaudeModelList | null {
  return slots[p].cache;
}

export interface ModelsApi {
  list: ClaudeModelList | null;
  loading: boolean;
  /** 그 AI에서 목록을 새로 받음 (메인 프로세스가 다시 물어봄) */
  refresh(): Promise<void>;
  /** 메인 프로세스가 기억한 목록을 다시 읽음 (연결 확인이 목록을 새로 받은 뒤) */
  reload(): Promise<void>;
}

export function useModels(app: DeskApp, provider: AiProvider, enabled = true): ModelsApi {
  const s = slots[provider];
  const [got, setGot] = useState<{ p: AiProvider; list: ClaudeModelList | null }>({ p: provider, list: s.cache });
  const [loading, setLoading] = useState(false);
  // 다른 AI로 바뀐 바로 뒤에는 그 AI의 받아 둔 목록
  const list = got.p === provider ? got.list : s.cache;

  useEffect(() => {
    const f = (l: ClaudeModelList) => setGot({ p: provider, list: l });
    s.listeners.add(f);
    return () => {
      s.listeners.delete(f);
    };
  }, [provider]);

  const load = useCallback(
    async (refresh: boolean, reread = false) => {
      if (!refresh && !reread && s.cache) {
        setGot({ p: provider, list: s.cache });
        return;
      }
      setLoading(true);
      const p = !refresh && !reread && s.inflight ? s.inflight : app.desk.invoke('ai.models', provider, refresh);
      s.inflight = p;
      try {
        const r = await p;
        if (!r.error) {
          s.cache = r;
          for (const f of s.listeners) f(r);
        }
        setGot({ p: provider, list: r });
      } catch (e) {
        setGot({ p: provider, list: { models: [], error: errText(e), at: new Date().toISOString() } });
      } finally {
        if (s.inflight === p) s.inflight = null;
        setLoading(false);
      }
    },
    [app.desk, provider],
  );

  useEffect(() => {
    if (enabled) void load(false);
  }, [enabled, load]);

  return { list, loading, refresh: () => load(true), reload: () => load(false, true) };
}

export interface ModelOption {
  value: string;
  label: string;
  title?: string;
}

/** '' (그 AI의 기본값)의 이름: Claude Code 기본값 · Gemini 기본값 · Codex 기본값 */
export function aiDefaultLabel(p: AiProvider, list: ClaudeModelList | null): string {
  const base = p === 'claude' ? 'Claude Code 기본값' : p === 'openai' ? 'Codex 기본값' : 'Gemini 기본값';
  return list?.defaultName ? `${base} (${list.defaultName})` : base;
}

/** 고를 수 있는 모델: 기본값 → 그 AI의 목록 → (목록에 없는) 지금 값 */
export function modelOptions(list: ClaudeModelList | null, current: string | undefined, defaultLabel: string): ModelOption[] {
  const out: ModelOption[] = [{ value: '', label: defaultLabel, title: list?.defaultDescription ?? '그 AI의 기본 설정을 따름' }];
  for (const m of list?.models ?? []) out.push({ value: m.value, label: m.name, title: [m.description, m.resolved && m.resolved !== m.value ? m.resolved : ''].filter(Boolean).join(' · ') || m.value });
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: current, title: '직접 입력한 모델' });
  return out;
}

/** 모델 값의 보이는 이름 */
export function modelName(list: ClaudeModelList | null, value: string | undefined, defaultLabel = '기본 모델'): string {
  if (!value) return defaultLabel;
  return list?.models.find((m) => m.value === value)?.name ?? value;
}

/** 목록에서 '' (그 AI의 기본값)에 해당하는 모델 (Gemini·Codex는 목록 안에 있음, Claude는 없음) */
export function listDefault(list: ClaudeModelList | null): ClaudeModel | undefined {
  if (!list?.defaultName) return undefined;
  return list.models.find((m) => m.name === list.defaultName || m.value === list.defaultName);
}

export interface PickRow {
  /** 고르면 대화에 넣을 값 ('' = 그 AI의 기본값) */
  value: string;
  name: string;
  description?: string;
  /** 연결 설정의 기본 모델 (새 대화에 쓰는 모델) */
  isDefault: boolean;
}

const EMPTY_NAME: Record<AiProvider, string> = { claude: 'Claude Code 기본값', gemini: 'Gemini 기본 모델', openai: 'Codex 기본값' };

/** 연결 설정의 기본 모델 (Azure OpenAI는 배포 이름) */
export function connDefault(app: DeskApp, p: AiProvider): string | undefined {
  if (p === 'claude') return app.claudeConfig?.model || undefined;
  if (p === 'gemini') return app.ai.gemini?.model || undefined;
  const c = app.ai.openai;
  return (c?.authMode === 'azure' ? c.azure?.deployment : c?.model) || undefined;
}

/**
 * 대화창의 모델 고르기 줄: 그 AI의 목록. 연결 설정의 기본 모델에 '기본' 표시.
 * '' (그 AI의 기본값): Claude는 목록 밖이라 맨 위 줄, Gemini·Codex는 목록 안의 기본 모델 줄(목록을 못 받았으면 따로 한 줄).
 * Gemini의 ''는 연결 설정의 기본 모델과 같다.
 */
export function pickRows(p: AiProvider, list: ClaudeModelList | null, conn: string | undefined, current: string | undefined): PickRow[] {
  const rows: PickRow[] = [];
  const own = listDefault(list);
  const defVal = conn || (p === 'claude' ? '' : (own?.value ?? ''));
  if (p === 'claude' || (!own && !(p === 'gemini' && conn))) {
    const d = list?.defaultName ? `${list.defaultName}${list.defaultDescription && list.defaultDescription !== list.defaultName ? ` · ${list.defaultDescription}` : ''}` : list?.defaultDescription;
    rows.push({ value: '', name: EMPTY_NAME[p], ...(d ? { description: d } : {}), isDefault: defVal === '' });
  }
  for (const m of list?.models ?? []) rows.push({ value: m.value, name: m.name, ...(m.description ? { description: m.description } : {}), isDefault: defVal !== '' && m.value === defVal });
  for (const v of [conn, current])
    if (v && !rows.some((r) => r.value === v)) rows.push({ value: v, name: v, description: '직접 입력한 모델', isDefault: v === defVal });
  return rows;
}

/** 지금 쓰는 줄 (effective: 대화에 고른 값 → 없으면 연결 설정의 기본 모델 → '') */
export function pickedValue(p: AiProvider, rows: PickRow[], list: ClaudeModelList | null, effective: string, conn: string | undefined): string {
  if (effective) return effective;
  if (rows.some((r) => r.value === '')) return '';
  if (p === 'gemini' && conn) return conn;
  return listDefault(list)?.value ?? '';
}

/** 모델 값의 이름 (''는 그 AI의 기본 모델 이름) */
export function pickedName(p: AiProvider, list: ClaudeModelList | null, value: string, conn: string | undefined): string {
  if (value) return list?.models.find((m) => m.value === value)?.name ?? value;
  if (p === 'gemini' && conn) return list?.models.find((m) => m.value === conn)?.name ?? conn;
  const own = listDefault(list);
  if (p !== 'claude' && own) return own.name;
  return list?.defaultName && p !== 'claude' ? list.defaultName : EMPTY_NAME[p];
}
