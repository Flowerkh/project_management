// 모델 목록 (claude.models): PC의 Claude Code가 알려 준 쓸 수 있는 모델과 지금 계정. 메인 프로세스가 기억하고,
// 화면도 한 번 받은 것을 같이 쓴다. 어디서든 새로 받으면(설정의 [다시 확인] 등) 목록을 쓰는 곳이 모두 바뀐다. 저장은 하지 않는다.
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ClaudeModelList } from '../../../shared/desktop-api';
import { errText } from '../bridge';
import type { DeskApp } from '../ctx';

let cache: ClaudeModelList | null = null;
let inflight: Promise<ClaudeModelList> | null = null;
const listeners = new Set<(l: ClaudeModelList) => void>();

/** Claude 연결 설정이 바뀜 → 다음에 다시 받음 */
export function invalidateModels(): void {
  cache = null;
}

export function useModels(app: DeskApp, enabled = true): { list: ClaudeModelList | null; loading: boolean; refresh(): Promise<void> } {
  const [list, setList] = useState<ClaudeModelList | null>(cache);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!refresh && cache) {
        setList(cache);
        return;
      }
      setLoading(true);
      const p = !refresh && inflight ? inflight : app.desk.invoke('claude.models', refresh);
      inflight = p;
      try {
        const r = await p;
        if (!r.error) {
          cache = r;
          for (const f of listeners) f(r);
        }
        setList(r);
      } catch (e) {
        setList({ models: [], error: errText(e), at: new Date().toISOString() });
      } finally {
        if (inflight === p) inflight = null;
        setLoading(false);
      }
    },
    [app.desk],
  );

  useEffect(() => {
    if (enabled) void load(false);
  }, [enabled, load]);

  return { list, loading, refresh: () => load(true) };
}

export interface ModelOption {
  value: string;
  label: string;
  title?: string;
}

/** 고를 수 있는 모델: 기본값 → Claude Code 목록 → (목록에 없는) 지금 값 */
export function modelOptions(list: ClaudeModelList | null, current: string | undefined, defaultLabel: string): ModelOption[] {
  const out: ModelOption[] = [{ value: '', label: defaultLabel, title: list?.defaultDescription ?? 'PC의 Claude Code 설정을 따름' }];
  for (const m of list?.models ?? []) out.push({ value: m.value, label: m.name, title: [m.description, m.resolved && m.resolved !== m.value ? m.resolved : ''].filter(Boolean).join(' · ') || m.value });
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: current, title: '직접 입력한 모델' });
  return out;
}

/** 모델 값의 보이는 이름 */
export function modelName(list: ClaudeModelList | null, value: string | undefined, defaultLabel = '기본 모델'): string {
  if (!value) return defaultLabel;
  return list?.models.find((m) => m.value === value)?.name ?? value;
}
