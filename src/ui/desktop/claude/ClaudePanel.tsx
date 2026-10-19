// SCR-09 Claude 대화 패널: 머리글(제목·연결 상태·대화 기록·내보내기·새 대화·닫기), 맥락 칩, 대화, 입력·모드.
// 대화는 메인 프로세스(claude.*)가 실행하고 화면은 이벤트로 받은 항목을 그린다. 첫 질문을 보낼 때 대화를 시작한다(claude.start).
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatContext, ClaudeErrorCode, ConversationSummary } from '../../../shared/desktop-api';
import { ConfirmDialog } from '../../components/Dialogs';
import { ModalSizer } from '../../components/ModalSizer';
import { Icon, Spinner } from '../../icons';
import type { Target } from '../../model';
import { errText } from '../bridge';
import { type ChatRequest, type DeskApp, useDesk } from '../ctx';
import { msg } from '../messages';
import { StatusDot } from './ClaudeButton';
import { buildChatContext } from './context';
import { Avatar, ChatLog, claudeErrActions, ErrorBox } from './items';
import { type LinkEnv } from './markdown';
import { modelName, modelOptions, useModels } from './models';
import { useConversation } from './useConversation';
import { type Chip, chipKey, composeWithContext, convTitle, effectiveChips, hm } from './util';
import './claude.css';

/** 프로젝트마다 마지막으로 연 대화 (패널을 닫았다 열면 이어서) */
const lastConvByRoot = new Map<string, string>();

const CHIP_ICON: Record<Chip['kind'], string> = { screen: 'screen', table: 'table', menu: 'menu', batch: 'clock', file: 'file', flow: 'arrow_r', summary: 'layers' };

/** 패널 맨 위 배너로 보이는 오류 (MSG-23 사용 한도 · MSG-30 결제 문제: 화면설계서 표시 방식 '배너') */
const BANNER_CODES: ClaudeErrorCode[] = ['limit', 'billing'];

const STATE_TEXT: Record<string, string> = { on: 'Claude 연결됨', login: '인증 필요', offline: '오프라인', off: '꺼짐', missing: '설치 안 됨' };

/** 받침에 맞는 조사 (주문목록을 · 주문상세를) */
function eul(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? '을' : '를';
  return '을(를)';
}

function targetKey(t: Target): string {
  return t.kind === 'screen' || t.kind === 'table' || t.kind === 'menu' || t.kind === 'batch' ? `${t.kind}:${t.id}` : '';
}

function targetName(app: DeskApp, t: Target): string | null {
  const m = app.model;
  if (!m) return null;
  if (t.kind === 'screen') return m.screenById.get(t.id)?.name ?? null;
  if (t.kind === 'table') return m.tableById.get(t.id)?.name ?? null;
  if (t.kind === 'menu') return m.menuById.get(t.id)?.name ?? null;
  if (t.kind === 'batch') return m.batchById.get(t.id)?.name ?? null;
  return null;
}

/** 지금 연 항목의 맥락. 이미 칩이 있으면 항목 하나를 칩 하나로 합친다 ('파일 6' 같은 이름이 겹치지 않게) */
function chipsForTarget(app: DeskApp, t: Target, merge: boolean): Chip[] {
  const ctx = buildChatContext(app.model, t);
  if (!ctx) return [];
  const main = ctx.chips.filter((c) => c.kind !== 'summary');
  const summary = ctx.chips.filter((c) => c.kind === 'summary');
  if (!main.length) return summary;
  if (!merge) return ctx.chips;
  return [{ kind: main[0].kind, label: main[0].label, text: main.map((c) => c.text).join('\n\n') }];
}

function examplesFor(ctx: ChatContext | undefined): string[] {
  const k = ctx?.chips.find((c) => c.kind !== 'summary')?.kind;
  if (k === 'screen')
    return ['이 화면에서 저장할 때 오류가 나요. 원인을 찾아 주세요.', '이 화면이 쓰는 테이블과 호출 흐름을 설명해 주세요.', '검색 조건을 하나 더하려면 어디를 고쳐야 하나요?'];
  if (k === 'table') return ['이 테이블을 바꾸면 영향을 받는 화면·배치를 알려 주세요.', '이 테이블의 데이터가 어디서 쌓이는지 설명해 주세요.'];
  if (k === 'menu') return ['이 메뉴 아래 화면들이 하는 일을 정리해 주세요.', '이 메뉴의 화면들이 함께 쓰는 테이블을 알려 주세요.'];
  if (k === 'batch') return ['이 배치가 실패하면 어떤 데이터가 영향을 받나요?', '이 배치의 실행 흐름을 단계별로 설명해 주세요.'];
  return ['이 시스템의 주요 업무 흐름을 설명해 주세요.', '오래되어 손볼 곳이 많은 부분을 찾아 주세요.'];
}

/** 옆에 붙은 대화창 너비 (이 PC에 기억) */
const WIDTH_KEY = 'pa.chatWidth';
const MIN_W = 380;
/** 대화창을 넓혀도 분석 결과 쪽에 남길 너비 */
const KEEP_MAIN = 420;

function loadWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_W ? v : null;
  } catch {
    return null;
  }
}

function storeWidth(w: number | null): void {
  try {
    if (w) localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    else localStorage.removeItem(WIDTH_KEY);
  } catch {
    // 저장소를 못 쓰면 이번에만
  }
}

const clampWidth = (w: number) => Math.round(Math.max(MIN_W, Math.min(window.innerWidth - KEEP_MAIN, w)));

export function ClaudePanel(props: { onClose: () => void }) {
  const app = useDesk();
  const cv = useConversation(app);
  const conv = cv.conv;
  const rootKey = app.root ?? '';
  const [draft, setDraft] = useState<ChatContext | undefined>(undefined);
  const [added, setAdded] = useState<Chip[]>([]);
  const [removed, setRemoved] = useState<Chip[]>([]);
  const [input, setInput] = useState('');
  const [histOpen, setHistOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  /** 첫 질문을 보내 대화를 시작하는 동안 먼저 보여 줄 질문 */
  const [startingText, setStartingText] = useState<string | null>(null);
  const [dismissedErr, setDismissedErr] = useState<string | null>(null);
  /** 첫 질문을 보내기 전에 고른 모델 (undefined = Claude 연결의 기본 모델) */
  const [draftModel, setDraftModel] = useState<string | undefined>(undefined);
  /** 크게 보기 (패널을 가운데 큰 창으로) */
  const [expanded, setExpanded] = useState(false);
  /** 옆에 붙었을 때 너비 (null = 기본: 창 너비의 40%) */
  const [width, setWidth] = useState<number | null>(loadWidth);
  const panelRef = useRef<HTMLElement>(null);
  /** 지우기 확인: 대화 하나 / 이 프로젝트 대화 모두 */
  const [confirmDel, setConfirmDel] = useState<{ kind: 'one'; id: string; title: string; running: boolean } | { kind: 'all' } | null>(null);
  /** 대화 기록 목록을 다시 읽게 */
  const [histTick, setHistTick] = useState(0);
  const baseTarget = useRef<string>(targetKey(app.target));
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const histBtn = useRef<HTMLButtonElement>(null);
  const atBottom = useRef(true);
  const forceBottom = useRef(true);

  const env: LinkEnv = useMemo(
    () => ({
      model: app.model,
      openFile: (path, line) => {
        if (!app.openSource(path, line)) app.toast(`분석 결과에 없는 파일입니다: ${path}`);
      },
      nav: app.nav,
      openExternal: (url) => {
        app.desk.invoke('app.openExternal', url).catch((e) => app.toast(errText(e)));
      },
    }),
    [app.model, app.openSource, app.nav, app.desk],
  );

  const focusInput = () => setTimeout(() => taRef.current?.focus(), 0);

  const resetChips = () => {
    setAdded([]);
    setRemoved([]);
    setDismissed(null);
    baseTarget.current = targetKey(app.target);
  };

  const newDraft = (ctx?: ChatContext) => {
    cv.clear();
    setDraftModel(undefined);
    setDraft(ctx ?? buildChatContext(app.model, app.target));
    resetChips();
    forceBottom.current = true;
  };

  const remember = (id: string) => lastConvByRoot.set(rootKey, id);

  const openConv = async (id: string) => {
    setDraft(undefined);
    resetChips();
    forceBottom.current = true;
    const c = await cv.load(id);
    if (c) remember(c.id);
    return c;
  };

  /** 첫 질문: 대화를 만들고(작업 사본 준비는 work.progress로 보임) 보낸다 */
  const sendNew = async (text: string, ctx: ChatContext | undefined) => {
    setStartingText(text);
    const opts = { ...(ctx && ctx.chips.length ? { context: ctx } : {}), ...(draftModel !== undefined ? { model: draftModel } : {}) };
    const c = await cv.start(app.root, Object.keys(opts).length ? opts : undefined);
    setStartingText(null);
    if (!c) return false;
    remember(c.id);
    setDraft(undefined);
    return cv.send(text, c);
  };

  const blocked = app.claude?.state === 'off' || app.claude?.state === 'missing';
  const models = useModels(app, !blocked);
  const running = !!conv?.running;
  const busy = cv.starting || cv.loading;

  const doSend = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    if (running) {
      app.toast('응답이 끝난 뒤에 보낼 수 있습니다. 멈추려면 [중지]를 누르세요.');
      return;
    }
    if (blocked) {
      app.openModal('claude');
      return;
    }
    setInput('');
    resizeTa('');
    atBottom.current = true;
    forceBottom.current = true;
    let ok: boolean;
    if (!conv) ok = await sendNew(text, draft);
    else {
      ok = await cv.send(composeWithContext(text, added, removed));
      if (ok) {
        setAdded([]);
        setRemoved([]);
      }
    }
    if (!ok) setInput((cur) => cur || text);
  };

  // 패널을 여는 요청 ([Claude에게 묻기]·대화 열기·상단 버튼)
  const handle = async (req: ChatRequest) => {
    setHistOpen(false);
    if (req.conversationId) {
      const c = await openConv(req.conversationId);
      if (req.text) {
        if (req.send && c) await cv.send(req.text, c);
        else setInput(req.text);
      }
      focusInput();
      return;
    }
    if (req.context || req.text) {
      const ctx = req.context ?? buildChatContext(app.model, app.target);
      newDraft(ctx);
      if (req.text && req.send) {
        atBottom.current = true;
        if (!(await sendNew(req.text, ctx))) setInput(req.text);
      } else if (req.text) setInput(req.text);
      focusInput();
      return;
    }
    // 상단 [Claude]: 이 프로젝트에서 마지막으로 연 대화, 없으면 오늘 대화를 이어서. 그것도 없으면 새 대화
    const last = lastConvByRoot.get(rootKey);
    if (last) {
      if (await openConv(last)) return focusInput();
      // 지워진 대화면 잊고 새로
      lastConvByRoot.delete(rootKey);
      cv.setError(null);
    }
    if (app.root) {
      try {
        const list = (await app.desk.invoke('claude.list', app.root)).filter((x) => x.kind === 'issue').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const recent = list[0];
        if (recent && Date.now() - Date.parse(recent.updatedAt) < 12 * 3600 * 1000 && (await openConv(recent.id))) return focusInput();
      } catch {
        /* 대화 기록을 못 읽으면 새 대화 */
      }
    }
    newDraft();
    focusInput();
  };

  useEffect(() => {
    if (app.chat) handle(app.chat);
  }, [app.chat?.nonce]);

  // 다른 프로젝트로 바뀌면 그 프로젝트의 대화로 (그 프로젝트에서 마지막으로 연 대화 → 오늘 대화 → 새 대화)
  const shownRoot = useRef(rootKey);
  useEffect(() => {
    if (shownRoot.current === rootKey) return;
    shownRoot.current = rootKey;
    setInput('');
    resizeTa('');
    void handle({ nonce: Date.now() });
  }, [rootKey]);

  const deleteConv = async (id: string) => {
    try {
      await app.desk.invoke('claude.delete', id);
      if (lastConvByRoot.get(rootKey) === id) lastConvByRoot.delete(rootKey);
      if (conv?.id === id) {
        setInput('');
        resizeTa('');
        newDraft();
      }
      setHistTick((n) => n + 1);
      app.toast('대화를 지웠습니다.');
    } catch (e) {
      app.toast(`대화를 지우지 못했습니다. ${errText(e)}`);
    }
  };

  const clearAll = async () => {
    if (!app.root) return;
    try {
      const n = await app.desk.invoke('claude.clear', app.root);
      lastConvByRoot.delete(rootKey);
      setInput('');
      resizeTa('');
      newDraft();
      setHistTick((k) => k + 1);
      app.toast(n ? `이 프로젝트의 대화 ${n}개를 지웠습니다.` : '지울 대화가 없습니다.');
    } catch (e) {
      app.toast(`대화를 지우지 못했습니다. ${errText(e)}`);
    }
  };

  // 칩: 시작한 대화는 보낸 맥락 + 다음 질문과 함께 보낼 변경, 시작 전에는 초안
  const baseChips = conv ? effectiveChips(conv) : draft?.chips ?? [];
  const removedKeys = new Set(removed.map(chipKey));
  const addedKeys = new Set(added.map(chipKey));
  const chips = [...baseChips.filter((c) => !removedKeys.has(chipKey(c))), ...added.filter((c) => !baseChips.some((b) => chipKey(b) === chipKey(c)))];

  const removeChip = (c: Chip) => {
    if (!conv) {
      setDraft((d) => (d ? { ...d, chips: d.chips.filter((x) => chipKey(x) !== chipKey(c)) } : d));
      return;
    }
    if (addedKeys.has(chipKey(c))) setAdded((a) => a.filter((x) => chipKey(x) !== chipKey(c)));
    else setRemoved((r) => [...r, c]);
  };

  const addChips = (list: Chip[]) => {
    const fresh = list.filter((c) => !chips.some((x) => chipKey(x) === chipKey(c)));
    if (!fresh.length) {
      app.toast('이미 맥락에 있습니다.');
      return;
    }
    if (!conv) {
      setDraft((d) => ({ title: d?.title ?? fresh[0].label, chips: [...(d?.chips ?? []), ...fresh] }));
    } else {
      const back = fresh.filter((c) => removedKeys.has(chipKey(c)));
      if (back.length) setRemoved((r) => r.filter((x) => !back.some((b) => chipKey(b) === chipKey(x))));
      const extra = fresh.filter((c) => !removedKeys.has(chipKey(c)));
      if (extra.length) setAdded((a) => [...a, ...extra]);
    }
  };

  const addCurrent = () => {
    const t = app.target;
    const list = chipsForTarget(app, t, chips.length > 0);
    if (!list.length) {
      app.toast('트리에서 화면·테이블·메뉴·배치를 연 뒤 [+]를 누르세요.');
      return;
    }
    addChips(list);
    setDismissed(targetKey(t));
  };

  // 다른 항목을 열면 [맥락에 추가] 제안
  const tKey = targetKey(app.target);
  const tName = targetName(app, app.target);
  const suggest = !!tKey && !!tName && tKey !== baseTarget.current && tKey !== dismissed && !chips.some((c) => c.label === tName) && !cv.loading;

  // 아래에 붙어 있을 때만 따라 내려간다 (위로 올려 읽는 중이면 그대로)
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom.current) setShowJump(false);
  };
  const lastItem = conv?.items[conv.items.length - 1];
  const contentSig = `${conv?.id}|${conv?.items.length}|${lastItem && 'text' in lastItem ? lastItem.text.length : ''}|${conv?.pending?.requestId}|${conv?.running}|${cv.progress?.done}|${busy}|${startingText}`;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (forceBottom.current || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      if (conv) forceBottom.current = false;
      setShowJump(false);
    } else setShowJump(true);
  }, [contentSig]);

  const resizeTa = (v?: string) => {
    const el = taRef.current;
    if (!el) return;
    if (v === '') {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      doSend(input);
    }
  };

  const onPanelKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    // 열린 창(쿼리 실행 확인·설정 등)이 있으면 그 창이 Esc를 받는다
    if ((e.target as HTMLElement | null)?.closest?.('.scrim, [aria-modal="true"]') || document.querySelector('.scrim')) return;
    e.stopPropagation();
    if (histOpen) setHistOpen(false);
    else if (expanded) setExpanded(false);
    else props.onClose();
  };

  // 크게 보기는 창처럼: 초점이 패널 밖(확인 창을 닫은 뒤 등)이어도 Esc로 옆에 붙인다. 열린 창이 있으면 그 창이 먼저
  useEffect(() => {
    if (!expanded) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || document.querySelector('.scrim')) return;
      setExpanded(false);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [expanded]);

  // 왼쪽 가장자리를 끌어 너비 조절 (끄는 동안은 CSS 변수만 바꾸고, 놓을 때 기억)
  const startResize = (e: PointerEvent) => {
    const el = panelRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('rz-drag-x');
    let w = r.width;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      w = clampWidth(r.right - ev.clientX);
      el.style.setProperty('--cp-w', `${w}px`);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('rz-drag-x');
      // 누르기만 했으면 그대로 (기본 너비는 창 크기를 따라가게 둔다)
      if (!moved) return;
      setWidth(w);
      storeWidth(w);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const resetWidth = () => {
    panelRef.current?.style.removeProperty('--cp-w');
    setWidth(null);
    storeWidth(null);
  };
  const onResizeKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = panelRef.current?.getBoundingClientRect().width ?? width ?? 560;
    const w = clampWidth(cur + (e.key === 'ArrowLeft' ? 32 : -32));
    setWidth(w);
    storeWidth(w);
  };

  const exportConv = async () => {
    if (!conv) return;
    try {
      const p = await app.desk.invoke('claude.export', conv.id);
      if (p) app.toast(`대화를 저장했습니다: ${p}`);
    } catch (e) {
      app.toast(`대화를 저장하지 못했습니다. ${errText(e)}`);
    }
  };

  const st = app.claude?.state;
  const lastIt = conv?.items[conv.items.length - 1];
  const bannerErr = lastIt && lastIt.type === 'error' && BANNER_CODES.includes(lastIt.code) && lastIt.id !== dismissedErr ? lastIt : null;
  const mode = conv?.mode ?? 'plan';
  const canEdit = !!app.root && (!conv || conv.root !== null);
  const title = conv ? convTitle(conv) : draft?.title ? `${draft.title} · 새 대화` : '새 대화';
  const effModel = (conv ? conv.model : draftModel) ?? app.claudeConfig?.model ?? '';
  const effInfo = effModel ? models.list?.models.find((m) => m.value === effModel) : null;
  const modelTitle = [
    `모델: ${modelName(models.list, effModel)}`,
    effModel ? effInfo?.description : models.list?.defaultDescription,
    conv?.activeModel ? `지금 쓰는 모델: ${conv.activeModel}` : '',
    `바꾸면 ${running ? '다음 응답' : '다음 질문'}부터 적용됩니다`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
    <aside
      ref={panelRef}
      class={`chat-panel cp-panel${expanded ? ' expanded' : ''}`}
      aria-label="Claude 대화"
      onKeyDown={onPanelKey}
      style={!expanded && width ? { '--cp-w': `${width}px` } : undefined}
    >
      {!expanded && (
        <div
          class="cp-rz"
          role="separator"
          aria-orientation="vertical"
          aria-label="대화창 너비"
          aria-valuemin={MIN_W}
          aria-valuenow={width ?? undefined}
          tabIndex={0}
          title="끌어서 너비 조절 · 두 번 누르면 원래 너비"
          onPointerDown={startResize}
          onDblClick={resetWidth}
          onKeyDown={onResizeKey}
        />
      )}
      <div class="cp-head">
        <Avatar size={28} />
        <div class="cp-head-t">
          <span class="cp-title" title={title}>
            {title}
          </span>
          <span class="cp-sub">
            <StatusDot state={st} />
            <span>{st ? STATE_TEXT[st] : '연결 확인 중'}</span>
            <span class="cp-sep">·</span>
            <span class="cp-proj">{app.projectName || '프로젝트'}</span>
            <span class="cp-sep">·</span>
            <span>{conv ? `${hm(conv.createdAt)} 시작` : '시작 전'}</span>
          </span>
        </div>
        <div class="cp-head-btns">
          <button
            type="button"
            class={`cp-ibtn${expanded ? ' on' : ''}`}
            aria-label={expanded ? '옆에 붙여 보기' : '크게 보기'}
            title={expanded ? '옆에 붙여 보기 (Esc)' : '크게 보기 (가운데 큰 창)'}
            aria-pressed={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? 'shrink' : 'expand'} size={16} color="var(--ink2)" />
          </button>
          <button
            type="button"
            class="cp-ibtn"
            aria-label="이 대화 지우기"
            title="이 대화 지우기"
            disabled={!conv}
            onClick={() => conv && setConfirmDel({ kind: 'one', id: conv.id, title: convTitle(conv), running: conv.running })}
          >
            <Icon name="trash" size={16} color="var(--ink2)" />
          </button>
          <button ref={histBtn} type="button" class={`cp-ibtn${histOpen ? ' on' : ''}`} aria-label="대화 기록" title="대화 기록" aria-expanded={histOpen} onClick={() => setHistOpen((v) => !v)}>
            <Icon name="clock" size={17} color="var(--ink2)" />
          </button>
          <button type="button" class="cp-ibtn" aria-label="대화 내보내기" title="대화 내보내기 (Markdown)" disabled={!conv || !conv.items.length} onClick={exportConv}>
            <Icon name="download" size={17} color="var(--ink2)" />
          </button>
          <button
            type="button"
            class="cp-ibtn"
            aria-label="새 대화"
            title="새 대화"
            onClick={() => {
              setHistOpen(false);
              setInput('');
              newDraft();
              focusInput();
            }}
          >
            <Icon name="plus" size={17} color="var(--ink2)" />
          </button>
          <button
            type="button"
            class="cp-ibtn"
            aria-label="Claude 연결 설정"
            title="Claude 연결 설정 (계정 바꾸기·기본 모델·연동 끄기)"
            onClick={() => {
              setHistOpen(false);
              app.openModal('claude');
            }}
          >
            <Icon name="gear" size={17} color="var(--ink2)" />
          </button>
          <button type="button" class="cp-ibtn" aria-label="닫기" title="닫기 (Esc)" onClick={props.onClose}>
            <Icon name="close" size={18} color="var(--ink2)" />
          </button>
        </div>
        {histOpen && (
          <HistoryPop
            app={app}
            currentId={conv?.id}
            anchor={histBtn}
            tick={histTick}
            onDelete={(c) => setConfirmDel({ kind: 'one', id: c.id, title: c.title || '제목 없는 대화', running: c.id === conv?.id && !!conv?.running })}
            onClearAll={() => setConfirmDel({ kind: 'all' })}
            onClose={() => setHistOpen(false)}
            onPick={(id) => {
              setHistOpen(false);
              if (id !== conv?.id) openConv(id).then(() => focusInput());
            }}
          />
        )}
      </div>

      <div class="cp-ctx" role="group" aria-label="맥락">
        <span class="cp-ctx-label">맥락</span>
        {chips.map((c, i) => {
          const pending = !!conv && addedKeys.has(chipKey(c));
          const main = i === 0 && c.kind !== 'summary' && c.kind !== 'file' && c.kind !== 'flow';
          return (
            <span key={chipKey(c)} class={`cp-chip${main ? ' is-main' : ''}${pending ? ' is-pending' : ''}`} title={pending ? `${c.label} · 다음 질문과 함께 보냅니다` : c.text.slice(0, 400)}>
              <Icon name={CHIP_ICON[c.kind]} size={13} color="var(--icon)" sw={1.7} />
              <span class="t">{c.label}</span>
              <button type="button" class="cp-chip-x" aria-label={`${c.label} 빼기`} onClick={() => removeChip(c)}>
                <Icon name="close" size={11} sw={2} />
              </button>
            </span>
          );
        })}
        {!chips.length && <span class="cp-ctx-empty">붙인 맥락 없음</span>}
        <button type="button" class="cp-chip-add" aria-label="맥락 추가" title="트리에서 연 항목을 맥락에 더하기" onClick={addCurrent}>
          <Icon name="plus" size={13} color="var(--ink2)" sw={2} />
        </button>
      </div>
      {suggest && (
        <div class="cp-suggest">
          <Icon name="info" size={14} color="var(--acc-d)" />
          <span class="grow cp-muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={tName ?? ''}>
            <b class="nm">{tName}</b>
            {tName ? eul(tName) : ''} 열었습니다
          </span>
          <button type="button" class="btn sm" onClick={addCurrent}>
            <Icon name="plus" size={13} />
            {tName} 맥락에 추가
          </button>
          <button type="button" class="icon-btn" aria-label="제안 닫기" onClick={() => setDismissed(tKey)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {st && st !== 'on' && <StatusBanner app={app} />}
      {bannerErr && (
        <div class="cp-top-banner">
          <ErrorBox
            indent={false}
            text={msg(bannerErr.code === 'limit' ? 'MSG-23' : 'MSG-30')}
            detail={bannerErr.message}
            actions={claudeErrActions(app, bannerErr.code, bannerErr.message)}
            onClose={() => setDismissedErr(bannerErr.id)}
          />
        </div>
      )}

      <div class="cp-body" ref={bodyRef} onScroll={onScroll} role="region" aria-label="대화 내용">
        {!app.root && (
          <ErrorBox
            tone="info"
            indent={false}
            text="원본 폴더 없이 연 결과라 Claude는 분석 결과만 보고 답합니다. 소스 수정([수정 진행]·수정 허용)은 폴더로 연 프로젝트에서만 할 수 있습니다."
          />
        )}
        {cv.loading && (
          <div class="cp-loading">
            <Spinner size={14} />
            대화를 불러오는 중
          </div>
        )}
        {!cv.loading && !conv && !cv.starting && (
          <div class="cp-intro">
            <div class="cp-msg">
              <Avatar size={24} />
              <div class="cp-msg-body">
                <p style={{ margin: 0 }}>
                  {draft?.title ? `「${draft.title}」에 대해 물어보세요.` : '무엇을 도와드릴까요?'} 위 맥락을 함께 보냅니다. 처음에는 계획 모드라 파일을 바꾸지 않고 원인과 수정안만 찾습니다.
                </p>
              </div>
            </div>
            <div class="q">
              {examplesFor(draft).map((e) => (
                <button
                  type="button"
                  key={e}
                  onClick={() => {
                    setInput(e);
                    focusInput();
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {conv && (
          <ChatLog
            conv={conv}
            app={app}
            env={env}
            actions={{ respond: cv.respond }}
            canEdit={canEdit}
            approvedModes={cv.approved}
            filesClickable
            bannerCodes={BANNER_CODES}
          />
        )}
        {cv.starting && startingText && (
          <div class="cp-user">
            <div class="cp-bubble local">{startingText}</div>
          </div>
        )}
        {(cv.starting || cv.progress) && <WorkProgressLine progress={cv.progress} starting={cv.starting} />}
        {cv.error && <ErrorBox indent={false} text={cv.error} actions={[{ label: '닫기', run: () => cv.setError(null) }]} />}
        {showJump && (
          <button
            type="button"
            class="cp-jump"
            onClick={() => {
              const el = bodyRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              atBottom.current = true;
              setShowJump(false);
            }}
          >
            <Icon name="arrow_down" size={13} />
            최근 내용 보기
          </button>
        )}
      </div>

      <div class="cp-input-wrap">
        <div class="cp-input">
          <textarea
            ref={taRef}
            class="cp-ta"
            rows={1}
            aria-label="Claude에게 보낼 내용"
            placeholder={blocked ? 'Claude 연결을 켠 뒤 쓸 수 있습니다' : '질문하거나 작업을 요청하세요 (Enter 보내기 · Shift+Enter 줄바꿈)'}
            value={input}
            disabled={blocked}
            onInput={(e) => {
              setInput((e.target as HTMLTextAreaElement).value);
              resizeTa();
            }}
            onKeyDown={onKeyDown}
          />
          <div class="cp-input-bar">
            <div class="cp-seg" role="group" aria-label="모드">
              <button type="button" class={mode === 'plan' ? 'on' : ''} aria-pressed={mode === 'plan'} onClick={() => conv && cv.setMode('plan')} title="파일을 읽고 수정안만 냅니다">
                계획 모드
              </button>
              <button
                type="button"
                class={mode === 'edit' ? 'on' : ''}
                aria-pressed={mode === 'edit'}
                disabled={!conv || !canEdit}
                onClick={() => cv.setMode('edit')}
                title={!canEdit ? '폴더로 연 프로젝트에서만 수정할 수 있습니다' : !conv ? '첫 질문을 보낸 뒤 바꿀 수 있습니다' : '작업 사본에서만 고칩니다'}
              >
                수정 허용
              </button>
            </div>
            <span class="hint">{mode === 'edit' ? '작업 사본만 수정' : '읽기·수정안만'}</span>
            <select
              class="cp-model"
              aria-label="모델"
              value={effModel}
              disabled={blocked}
              title={modelTitle}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (conv) void cv.setModel(v);
                else setDraftModel(v);
              }}
            >
              {modelOptions(models.list, effModel, '기본 모델').map((o) => (
                <option key={o.value} value={o.value} title={o.title}>
                  {o.label}
                </option>
              ))}
            </select>
            <span class="grow" />
            <span class="cnt" title={chips.map((c) => c.label).join(', ')}>
              맥락 {chips.length}개
            </span>
            {running ? (
              <button type="button" class="btn danger cp-stop" onClick={() => cv.interrupt()}>
                <Icon name="stop" size={12} filled color="var(--err)" />
                중지
              </button>
            ) : (
              <button type="button" class="cp-send" aria-label="보내기" disabled={!input.trim() || busy || blocked} onClick={() => doSend(input)}>
                {busy ? <Spinner size={15} color="#8A95A3" /> : <Icon name="send" size={16} color={!input.trim() || blocked ? '#8A95A3' : '#FFFFFF'} sw={1.9} />}
              </button>
            )}
          </div>
        </div>
        <div class="cp-note">
          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
          <span>질문·붙인 분석 결과·읽은 소스 일부·조회 결과(개인정보 가림)가 Claude로 전송됨 · 접속 정보는 읽지 않음</span>
        </div>
      </div>
      {expanded && <ModalSizer id="chat-popup" center minWidth={560} sides />}
    </aside>
    {expanded && <div class="cp-backdrop" onMouseDown={() => setExpanded(false)} />}
    {confirmDel &&
      createPortal(
        <ConfirmDialog
          title={confirmDel.kind === 'all' ? '이 프로젝트 대화 모두 지우기' : '대화 지우기'}
          message={
            confirmDel.kind === 'all'
              ? `${app.projectName || '이 프로젝트'}의 Claude 대화를 모두 지울까요? 되돌릴 수 없습니다. 작업 사본과 작업 이력은 그대로 남습니다.`
              : `「${confirmDel.title}」 대화를 지울까요? 되돌릴 수 없습니다.${confirmDel.running ? ' 응답 중인 대화는 멈춥니다.' : ''} 작업 사본과 작업 이력은 그대로 남습니다.`
          }
          ok="지우기"
          danger
          onClose={() => {
            setConfirmDel(null);
            focusInput();
          }}
          onOk={() => {
            const c = confirmDel;
            setConfirmDel(null);
            if (c.kind === 'all') void clearAll();
            else void deleteConv(c.id);
          }}
        />,
        document.body,
      )}
    </>
  );
}

function WorkProgressLine(props: { progress: { done: number; total: number; message?: string } | null; starting: boolean }) {
  const p = props.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div class="cp-progress" role="status">
      <span class="row">
        <Spinner size={13} />
        {p ? `작업 사본을 만드는 중 · 파일 ${p.done.toLocaleString('ko-KR')} / ${p.total.toLocaleString('ko-KR')}` : '대화를 준비하는 중'}
        {p?.message && <span class="cp-muted" style={{ marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>{p.message}</span>}
      </span>
      {p && (
        <div class="cp-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {!p && props.starting && <span class="cp-muted" style={{ fontSize: '12px' }}>원본 폴더를 복사한 작업 사본에서 Claude가 읽고 고칩니다. 원본은 [적용]하기 전까지 그대로입니다.</span>}
    </div>
  );
}

/** Claude 연결이 '사용 가능'이 아닐 때 패널 맨 위 배너 */
function StatusBanner(props: { app: DeskApp }) {
  const { app } = props;
  const s = app.claude;
  if (!s || s.state === 'on') return null;
  const billing = s.code === 'billing' || /결제|billing|credit|payment/i.test(s.message ?? '');
  if (s.code === 'limit')
    return (
      <div class="cp-top-banner">
        <ErrorBox text={msg('MSG-23')} detail={s.message} indent={false} actions={claudeErrActions(app, 'limit', s.message ?? '')} />
      </div>
    );
  if (s.state === 'off')
    return (
      <div class="cp-top-banner">
        <ErrorBox tone="info" indent={false} text="Claude 연동이 꺼져 있습니다. Claude 연결에서 켠 뒤 대화할 수 있습니다." actions={[{ label: 'Claude 연결', primary: true, run: () => app.openModal('claude') }]} />
      </div>
    );
  const code = s.state === 'login' ? (billing ? 'billing' : 'auth') : s.state === 'offline' ? 'offline' : 'missing';
  const id = code === 'auth' ? 'MSG-21' : code === 'billing' ? 'MSG-30' : code === 'offline' ? 'MSG-22' : 'MSG-20';
  return (
    <div class="cp-top-banner">
      <ErrorBox tone={code === 'offline' ? 'info' : 'err'} indent={false} text={msg(id)} detail={s.message} actions={claudeErrActions(app, code, s.message ?? '')} />
    </div>
  );
}

function HistoryPop(props: {
  app: DeskApp;
  currentId?: string;
  anchor: { current: HTMLButtonElement | null };
  tick: number;
  onPick: (id: string) => void;
  onDelete: (c: ConversationSummary) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const { app } = props;
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!app.root) {
      setList([]);
      return;
    }
    app.desk.invoke('claude.list', app.root).then(
      (l) => setList([...l].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      (e) => setErr(errText(e)),
    );
  }, [props.tick]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 지우기 확인 창을 누르는 동안은 닫지 않는다
      if (box.current?.contains(t) || props.anchor.current?.contains(t) || (t as Element).closest?.('.scrim')) return;
      props.onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  return (
    <div class="cp-pop" ref={box} role="dialog" aria-label="대화 기록">
      <div class="cp-pop-h">
        <Icon name="clock" size={15} color="var(--icon)" />
        <b>대화 기록</b>
        <span class="cp-muted" style={{ fontSize: '12px', marginLeft: 'auto' }}>
          {app.projectName}
        </span>
      </div>
      <div class="cp-pop-list">
        {err && <div class="cp-pop-empty" style={{ color: 'var(--err)' }}>대화 기록을 읽지 못했습니다. {err}</div>}
        {!err && !list && (
          <div class="cp-pop-empty">
            <Spinner size={14} /> 불러오는 중
          </div>
        )}
        {list && !list.length && <div class="cp-pop-empty">{app.root ? '이 프로젝트의 대화가 아직 없습니다.' : '폴더로 연 프로젝트에서 대화를 저장합니다.'}</div>}
        {list?.map((c) => (
          <div key={c.id} class={`cp-pop-row${c.id === props.currentId ? ' cur' : ''}`}>
            <button type="button" class="cp-pop-item" onClick={() => props.onPick(c.id)}>
              <span class="t">
                <span title={c.title}>{c.title || '제목 없는 대화'}</span>
                {c.kind === 'new' && <span class="tag acc">새 프로젝트</span>}
                {c.mode === 'edit' && <span class="tag neutral">수정 허용</span>}
              </span>
              <span class="m">
                {ymdOrHm(c.updatedAt)} · 항목 {c.items}개
              </span>
            </button>
            <button type="button" class="cp-pop-del" aria-label={`${c.title || '제목 없는 대화'} 지우기`} title="이 대화 지우기" onClick={() => props.onDelete(c)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
      {!!list?.length && (
        <div class="cp-pop-f">
          <span class="cp-muted">이 프로젝트 대화 {list.length}개</span>
          <button type="button" class="cp-linkbtn danger" onClick={props.onClearAll}>
            모두 지우기
          </button>
        </div>
      )}
    </div>
  );
}

/** 오늘이면 시각, 아니면 날짜와 시각 */
function ymdOrHm(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm(iso)}`;
}
