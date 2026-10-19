// 변경 검토·작업 이력이 함께 쓰는 조각: 대화상자 틀, 배너(MSG), 시각 표시, 대화에서 이유 꺼내기, 적용 뒤 다시 분석 기록.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ChatItem, Conversation, HistoryEntry, HistoryKind, HistoryStatus } from '../../../shared/desktop-api';
import { ModalSizer } from '../../components/ModalSizer';
import { Icon } from '../../icons';
import { errText } from '../bridge';
import type { DeskApp } from '../ctx';
import { type Impact, linkSummary, sameRoot } from './impact';

// ------------------------------------------------------------------ 대화상자

export function WvDialog(props: { title: string; icon?: string; iconColor?: string; wide?: boolean; onClose: () => void; children: ComponentChildren; foot?: ComponentChildren; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener('keydown', k, true);
    // 처음 포커스: 입력칸 → 주 버튼
    const el = ref.current?.querySelector<HTMLElement>('input[type="text"], .modal-foot .btn.primary, .modal-foot .btn.danger, .modal-foot .btn');
    el?.focus();
    return () => document.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} class={`modal wv-modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.label ?? props.title}>
        <div class="modal-head">
          {props.icon && <Icon name={props.icon} size={18} color={props.iconColor ?? 'var(--acc)'} />}
          <h2>{props.title}</h2>
          <button type="button" class="icon-btn" style={{ marginLeft: 'auto' }} onClick={props.onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
        {props.foot && <div class="modal-foot">{props.foot}</div>}
        <ModalSizer id={props.wide ? 'wv:wide' : `wv:${props.title}`} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 배너

export function Banner(props: { kind: 'err' | 'warn' | 'info' | 'ok'; children: ComponentChildren; actions?: ComponentChildren; onClose?: () => void }) {
  const icon = props.kind === 'ok' ? 'check' : props.kind === 'info' ? 'info' : 'warn';
  return (
    <div class={`wv-banner ${props.kind}`} role={props.kind === 'err' ? 'alert' : 'status'}>
      <span class="ic"><Icon name={icon} size={15} /></span>
      <span class="txt">{props.children}</span>
      {(props.actions || props.onClose) && (
        <span class="acts">
          {props.actions}
          {props.onClose && (
            <button type="button" class="icon-btn" aria-label="닫기" onClick={props.onClose} style={{ width: '26px', height: '26px' }}>
              <Icon name="close" size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 시각

const p2 = (n: number) => String(n).padStart(2, '0');

export function isToday(iso: string, now = new Date()): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** 좁은 목록: 오늘은 10:41, 아니면 10-16 23:50 (RULE 표기 규칙) */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return isToday(iso) ? hm : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
}

export function fullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// ------------------------------------------------------------------ 작업 이력 표시

export const KIND_LABEL: Record<HistoryKind, string> = {
  apply: '코드 적용',
  revert: '되돌리기',
  commit: '커밋',
  query: '쿼리 실행',
  'prod-select': '운영 조회',
  select: '조회',
};

export const KIND_ICON: Record<HistoryKind, string> = { apply: 'branch', revert: 'undo', commit: 'git', query: 'db', 'prod-select': 'eye', select: 'db' };

const STATUS_TONE: Record<HistoryStatus, string> = { 적용됨: 'acc', 커밋됨: 'ok', 푸시됨: 'ok', 되돌림: 'neutral', 실행됨: 'ok', 롤백됨: 'warn', 실패: 'err', 조회: 'neutral' };

/** 상태 태그 (RULE: 푸시했으면 '커밋됨'과 함께 '푸시함') */
export function StatusTag(props: { e: HistoryEntry; small?: boolean }) {
  const e = props.e;
  const label = e.status === '푸시됨' ? '커밋됨' : e.status;
  return (
    <>
      <span class={`tag ${STATUS_TONE[e.status] ?? 'neutral'}`}>{label}</span>
      {e.status === '푸시됨' && !props.small && <span class="tag ok">푸시함</span>}
      {e.error && e.status !== '실패' && <span class="tag err" title={e.error}>{/푸시/.test(e.steps?.filter((s) => !s.ok).pop()?.label ?? '') ? '푸시 실패' : '커밋 실패'}</span>}
    </>
  );
}

export function vcsLabel(kind?: string): string {
  return kind === 'git' ? 'Git' : kind === 'svn' ? 'SVN' : '형상관리 없음';
}

// ------------------------------------------------------------------ 대화에서 이유·명령 꺼내기

function stripMd(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

type Assistant = Extract<ChatItem, { type: 'assistant' }>;

/** 이 작업 사본의 변경을 설명한 Claude 답변들: 변경 카드 바로 앞(없으면 뒤) 답변부터 */
function explaining(conv: Conversation | null, workId?: string): string[] {
  const items = conv?.items ?? [];
  let card = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'changes' && (!workId || it.workId === workId)) {
      card = i;
      break;
    }
  }
  const texts = (from: number, to: number) => items.slice(from, to).filter((i): i is Assistant => i.type === 'assistant').map((i) => i.text);
  if (card < 0) return texts(0, items.length).reverse();
  const before = texts(0, card).reverse();
  return before.length ? [...before, ...texts(card, items.length)] : texts(card, items.length);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 변경 이유: 변경을 설명한 Claude 답변의 첫 문단 (길면 첫 문장) */
export function reasonOf(conv: Conversation | null, workId?: string): string | null {
  for (const t of explaining(conv, workId)) {
    const paras = t.split(/\n\s*\n/).map((p) => stripMd(p).replace(/^변경 이유\s*[:：]\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!paras.length) continue;
    let s = paras[0];
    if (s.length > 90) s = /^(.+?(?:다|요|음|함|됨)\.)(\s|$)/.exec(s)?.[1] ?? s;
    return s.length > 200 ? `${s.slice(0, 198)}…` : s;
  }
  return null;
}

/** 파일별 변경 설명: 'OrderServiceImpl.java: 이유' 꼴의 줄, 없으면 Claude 작업 내역의 수정 설명 */
export function fileReason(conv: Conversation | null, path: string, workId?: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const head = new RegExp(`^${escRe(name)}(?::\\d+)?\\s*(\\([^)]*\\))?\\s*[:：—–-]\\s*(.{6,})$`);
  for (const t of explaining(conv, workId)) {
    for (const raw of t.split('\n')) {
      const m = head.exec(stripMd(raw));
      if (m) return m[2].length > 240 ? `${m[2].slice(0, 238)}…` : m[2];
    }
  }
  const labels: string[] = [];
  for (const it of conv?.items ?? []) {
    if (it.type !== 'activity') continue;
    for (const a of it.items) {
      if (a.kind === 'edit' && a.file && (a.file === path || a.file.endsWith(`/${path}`) || path.endsWith(`/${a.file}`)) && a.label && a.label !== name && !labels.includes(a.label)) labels.push(a.label);
    }
  }
  return labels.length ? labels.slice(-3).join(' · ') : null;
}

/** 검증: Claude가 실행한 명령 (작업 내역) */
export function commandsOf(conv: Conversation | null): string[] {
  const out: string[] = [];
  for (const it of conv?.items ?? []) {
    if (it.type !== 'activity') continue;
    for (const a of it.items) if (a.kind === 'command' && a.label && !out.includes(a.label)) out.push(a.label);
  }
  return out.slice(-2);
}

// ------------------------------------------------------------------ 적용·되돌리기 뒤 다시 분석

/** 다시 분석하고 결과를 진행 기록에 남긴다 ('다시 분석 4초 · 바뀐 연결 없음'). 다른 프로젝트를 보고 있으면 하지 않음 */
export async function reanalyzeAndRecord(app: DeskApp, root: string, historyId: string, impact: Impact | null): Promise<void> {
  if (!sameRoot(app.root, root)) return;
  try {
    const r = await app.reanalyze();
    const sec = Math.max(1, Math.round(r.ms / 1000));
    const detail = r.ok ? `${sec}초 · ${linkSummary(r.before, r.after, impact)}` : `${sec}초 · ${r.error ?? '다시 분석하지 못했습니다'}`;
    await app.desk.invoke('history.step', root, historyId, { label: '다시 분석', detail, ok: r.ok });
  } catch (e) {
    await app.desk.invoke('history.step', root, historyId, { label: '다시 분석', detail: errText(e), ok: false }).catch(() => undefined);
  }
}

/** '…\ProjectAnalyzer\work\shop-admin-c1' (뒤 세 단계만) */
export function shortPath(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 3 ? p : `…${sep}${parts.slice(-3).join(sep)}`;
}
