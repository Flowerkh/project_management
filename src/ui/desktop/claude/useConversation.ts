// Claude 대화 하나의 상태: 불러오기·시작·보내기와 메인 프로세스 이벤트(claude.item·claude.state·db.card·work.progress) 반영.
// SCR-09 대화 패널과 SCR-11 새 프로젝트가 함께 쓴다.
import { useCallback, useRef, useState } from 'preact/hooks';
import type { ChatItem, ChatMode, ClaudeStartOptions, Conversation } from '../../../shared/desktop-api';
import { DeskError, errText, useDeskEvent } from '../bridge';
import type { DeskApp } from '../ctx';
import { claudeErrCode, nowIso } from './util';

export interface WorkProgress {
  root: string;
  done: number;
  total: number;
  message?: string;
}

/** [수정 진행]·[계획 확정]으로 바뀐 모드 항목 (메인이 via를 안 채워도 '수정 진행함'으로 보이게). 앱을 쓰는 동안 기억 */
const approvedByConv = new Map<string, Set<string>>();
const awaitingPlanMode = new Set<string>();

export function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) {
    const n = items.slice();
    n[i] = item;
    return n;
  }
  if (item.type === 'user') {
    // 화면이 먼저 그린 내 질문(local:)을 메인이 보낸 항목으로 바꾼다
    const j = items.findIndex((x) => x.type === 'user' && x.id.startsWith('local:') && x.text.trim() === item.text.trim());
    if (j >= 0) {
      const n = items.slice();
      n[j] = item;
      return n;
    }
  }
  return [...items, item];
}

function mergeFetched(local: Conversation, fetched: Conversation): Conversation {
  let items = fetched.items;
  for (const it of local.items) {
    if (!it.id.startsWith('local:')) continue;
    if (it.type === 'user' && items.some((x) => x.type === 'user' && x.text.trim() === it.text.trim())) continue;
    items = [...items, it];
  }
  return { ...fetched, items };
}

export interface ConvApi {
  conv: Conversation | null;
  progress: WorkProgress | null;
  starting: boolean;
  loading: boolean;
  error: string | null;
  setError(e: string | null): void;
  approved: Set<string>;
  load(id: string): Promise<Conversation | null>;
  start(root: string | null, opts?: ClaudeStartOptions): Promise<Conversation | null>;
  send(text: string, target?: Conversation): Promise<boolean>;
  setMode(mode: ChatMode): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, allow: boolean): Promise<void>;
  clear(): void;
  refetch(): Promise<void>;
  /** 다음에 오는 수정 허용 전환을 [계획 확정]·[수정 진행]으로 바뀐 것으로 표시 */
  markPlanApproval(): void;
}

export function useConversation(app: DeskApp): ConvApi {
  const [conv, setConvState] = useState<Conversation | null>(null);
  const ref = useRef<Conversation | null>(null);
  const [progress, setProgress] = useState<WorkProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvedTick, setApprovedTick] = useState(0);
  const startRoot = useRef<string | null>(null);
  const seq = useRef(0);

  const setConv = useCallback((f: Conversation | null | ((p: Conversation | null) => Conversation | null)) => {
    setConvState((p) => {
      const n = typeof f === 'function' ? f(p) : f;
      ref.current = n;
      return n;
    });
  }, []);

  const refetchId = useCallback(
    async (id: string) => {
      try {
        const c = await app.desk.invoke('claude.get', id);
        if (c) setConv((p) => (p && p.id === id ? mergeFetched(p, c) : p));
      } catch {
        /* 이벤트로 받은 상태를 그대로 쓴다 */
      }
    },
    [app.desk],
  );

  const localError = (code: ReturnType<typeof claudeErrCode>, message: string) => {
    if (!code) return false;
    setConv((p) => (p ? { ...p, running: false, items: [...p.items, { id: `local:e${Date.now()}`, type: 'error', code, message, at: nowIso() }] } : p));
    return true;
  };

  useDeskEvent(app.desk, (ev) => {
    const c = ref.current;
    if (ev.type === 'claude.item') {
      if (!c || ev.conversationId !== c.id) return;
      const item = ev.item;
      if (item.type === 'mode' && item.mode === 'edit' && awaitingPlanMode.has(c.id)) {
        awaitingPlanMode.delete(c.id);
        const set = approvedByConv.get(c.id) ?? new Set<string>();
        set.add(item.id);
        approvedByConv.set(c.id, set);
        setApprovedTick((n) => n + 1);
      }
      setConv((p) => (p && p.id === ev.conversationId ? { ...p, items: upsertItem(p.items, item), updatedAt: item.at || p.updatedAt } : p));
    } else if (ev.type === 'claude.state') {
      if (!c || ev.conversationId !== c.id) return;
      const wasRunning = c.running;
      setConv((p) =>
        p && p.id === ev.conversationId
          ? { ...p, running: ev.running, mode: ev.mode, workId: ev.workId ?? p.workId, pending: 'pending' in ev ? ev.pending ?? undefined : p.pending }
          : p,
      );
      if (wasRunning && !ev.running) {
        setProgress(null);
        refetchId(ev.conversationId);
      }
    } else if (ev.type === 'db.card') {
      if (!c) return;
      if (!c.items.some((i) => i.type === 'query' && i.card.id === ev.card.id)) return;
      setConv((p) => (p ? { ...p, items: p.items.map((i) => (i.type === 'query' && i.card.id === ev.card.id ? { ...i, card: ev.card } : i)) } : p));
    } else if (ev.type === 'work.progress') {
      const root = c?.root ?? startRoot.current;
      if (!root || ev.root !== root) return;
      if (ev.total > 0 && ev.done >= ev.total) setProgress(null);
      else setProgress({ root: ev.root, done: ev.done, total: ev.total, message: ev.message });
    }
  });

  const load = useCallback(
    async (id: string) => {
      const my = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const c = await app.desk.invoke('claude.get', id);
        if (my !== seq.current) return null;
        if (!c) {
          setError('대화를 찾지 못했습니다. 지워졌거나 다른 PC에서 만든 대화일 수 있습니다.');
          return null;
        }
        setConv(c);
        return c;
      } catch (e) {
        if (my === seq.current) setError(errText(e));
        return null;
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [app.desk],
  );

  const start = useCallback(
    async (root: string | null, opts?: ClaudeStartOptions) => {
      const my = ++seq.current;
      setStarting(true);
      setError(null);
      startRoot.current = root;
      try {
        const c = await app.desk.invoke('claude.start', root, opts);
        if (my !== seq.current) return null;
        setConv(c);
        return c;
      } catch (e) {
        if (my === seq.current) {
          const code = claudeErrCode(e instanceof DeskError ? e.code : undefined);
          setError(code ? `${errText(e)}` : `대화를 시작하지 못했습니다. ${errText(e)}`);
        }
        return null;
      } finally {
        if (my === seq.current) {
          setStarting(false);
          setProgress(null);
        }
      }
    },
    [app.desk],
  );

  const send = useCallback(
    async (text: string, target?: Conversation) => {
      const c = target ?? ref.current;
      if (!c) return false;
      const local: ChatItem = { id: `local:${Date.now()}`, type: 'user', text, at: nowIso() };
      setConv((p) => (p && p.id === c.id ? { ...p, running: true, items: [...p.items, local] } : p));
      setError(null);
      try {
        await app.desk.invoke('claude.send', c.id, text);
        return true;
      } catch (e) {
        const code = claudeErrCode(e instanceof DeskError ? e.code : undefined);
        if (!localError(code, errText(e))) {
          setConv((p) => (p && p.id === c.id ? { ...p, running: false, items: p.items.filter((i) => i.id !== local.id) } : p));
          setError(`보내지 못했습니다. ${errText(e)}`);
        }
        return false;
      }
    },
    [app.desk],
  );

  const setMode = useCallback(
    async (mode: ChatMode) => {
      const c = ref.current;
      if (!c || c.mode === mode) return;
      const prev = c.mode;
      setConv((p) => (p && p.id === c.id ? { ...p, mode } : p));
      try {
        await app.desk.invoke('claude.setMode', c.id, mode);
      } catch (e) {
        setConv((p) => (p && p.id === c.id ? { ...p, mode: prev } : p));
        setError(`모드를 바꾸지 못했습니다. ${errText(e)}`);
      }
    },
    [app.desk],
  );

  const interrupt = useCallback(async () => {
    const c = ref.current;
    if (!c) return;
    try {
      await app.desk.invoke('claude.interrupt', c.id);
    } catch (e) {
      setError(`중지하지 못했습니다. ${errText(e)}`);
    }
  }, [app.desk]);

  const respond = useCallback(
    async (requestId: string, allow: boolean) => {
      const c = ref.current;
      if (!c) return;
      const pending = c.pending;
      if (pending?.kind === 'plan' && allow) awaitingPlanMode.add(c.id);
      setConv((p) => (p && p.id === c.id ? { ...p, pending: undefined, running: allow ? true : p.running } : p));
      try {
        await app.desk.invoke('claude.respond', c.id, requestId, allow);
      } catch (e) {
        awaitingPlanMode.delete(c.id);
        setConv((p) => (p && p.id === c.id ? { ...p, pending } : p));
        setError(`요청에 답하지 못했습니다. ${errText(e)}`);
      }
    },
    [app.desk],
  );

  const clear = useCallback(() => {
    ++seq.current;
    setConv(null);
    setProgress(null);
    setError(null);
    setLoading(false);
    setStarting(false);
    startRoot.current = null;
  }, []);

  const refetch = useCallback(async () => {
    const c = ref.current;
    if (c) await refetchId(c.id);
  }, [refetchId]);

  const markPlanApproval = useCallback(() => {
    const c = ref.current;
    if (c) awaitingPlanMode.add(c.id);
  }, []);

  void approvedTick;
  const approved = (conv && approvedByConv.get(conv.id)) || EMPTY;

  return { conv, progress, starting, loading, error, setError, approved, load, start, send, setMode, interrupt, respond, clear, refetch, markPlanApproval };
}

const EMPTY = new Set<string>();
