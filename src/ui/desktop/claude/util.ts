// Claude 화면이 함께 쓰는 작은 도구: 시각 표시, 대화 제목, 맥락 칩 비교, 대화 중 맥락 변경 문구.
import type { ChatContext, ChatItem, ClaudeErrorCode, Conversation } from '../../../shared/desktop-api';
import { msg } from '../messages';

export type Chip = ChatContext['chips'][number];

const p2 = (n: number) => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 오늘이면 10:41, 아니면 10-16 10:41 (RULE 표기 규칙) */
export function hm(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return sameDay(d, new Date()) ? t : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${t}`;
}

/** 2026-10-17 10:24 */
export function ymdhm(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const DEFAULT_TITLES = new Set(['새 대화', '새 프로젝트']);

/** 첫 질문을 줄여 대화 제목으로 (메인 프로세스가 제목을 따로 정했으면 그것을 씀) */
export function convTitle(conv: Conversation | null, fallback = '새 대화'): string {
  if (!conv) return fallback;
  const ctxTitle = conv.context?.title;
  // 메인이 첫 질문으로 제목을 정하기 전('새 대화')에는 첫 질문을 줄여 보여 준다
  if (conv.title && conv.title !== ctxTitle && !DEFAULT_TITLES.has(conv.title)) return conv.title;
  const first = conv.items.find((i) => i.type === 'user') as Extract<ChatItem, { type: 'user' }> | undefined;
  if (first) return shorten(splitContextBlock(first.text).text, 34);
  return (conv.title && !DEFAULT_TITLES.has(conv.title) ? conv.title : '') || ctxTitle || conv.title || fallback;
}

export function shorten(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function chipKey(c: Pick<Chip, 'kind' | 'label'>): string {
  return `${c.kind}:${c.label}`;
}

// ------------------------------------------------------------------ 대화 중 맥락 변경
// 대화를 시작한 뒤 [+]로 더하거나 칩을 뺀 맥락은 다음 질문 끝에 붙여 보낸다 (Claude가 읽는 표시).
// 화면은 이 부분을 말풍선에서 떼어 작은 칩으로 보여 준다.

const ADD_RE = /<맥락-추가 이름="([^"]*)" 종류="(\w+)">\n?([\s\S]*?)\n?<\/맥락-추가>/g;
const DEL_RE = /<맥락-빼기 이름="([^"]*)" 종류="(\w+)"\s*\/>/g;
const KINDS = new Set(['screen', 'table', 'menu', 'batch', 'file', 'flow', 'summary']);

const attr = (s: string) => s.replace(/"/g, '＂').replace(/[<>]/g, ' ');

export function composeWithContext(text: string, added: Chip[], removed: Chip[]): string {
  if (!added.length && !removed.length) return text;
  const parts = [text.trimEnd(), ''];
  for (const c of added) parts.push(`<맥락-추가 이름="${attr(c.label)}" 종류="${c.kind}">\n${c.text}\n</맥락-추가>`);
  for (const c of removed) parts.push(`<맥락-빼기 이름="${attr(c.label)}" 종류="${c.kind}"/>`);
  return parts.join('\n');
}

export function splitContextBlock(full: string): { text: string; added: Chip[]; removed: { kind: Chip['kind']; label: string }[] } {
  const added: Chip[] = [];
  const removed: { kind: Chip['kind']; label: string }[] = [];
  let text = full.replace(ADD_RE, (_m, label: string, kind: string, body: string) => {
    if (KINDS.has(kind)) added.push({ kind: kind as Chip['kind'], label, text: body });
    return '';
  });
  text = text.replace(DEL_RE, (_m, label: string, kind: string) => {
    if (KINDS.has(kind)) removed.push({ kind: kind as Chip['kind'], label });
    return '';
  });
  return { text: added.length || removed.length ? text.trimEnd() : full, added, removed };
}

/** 대화 맥락 = 시작할 때 붙인 칩 + 이후 질문에서 더하고 뺀 칩 */
export function effectiveChips(conv: Conversation): Chip[] {
  let chips = [...(conv.context?.chips ?? [])];
  for (const it of conv.items) {
    if (it.type !== 'user') continue;
    const b = splitContextBlock(it.text);
    if (!b.added.length && !b.removed.length) continue;
    const gone = new Set(b.removed.map(chipKey));
    chips = chips.filter((c) => !gone.has(chipKey(c)));
    for (const a of b.added) if (!chips.some((c) => chipKey(c) === chipKey(a))) chips.push(a);
  }
  return chips;
}

// ------------------------------------------------------------------ 오류 코드 → 메시지

export const ERR_MSG: Record<ClaudeErrorCode, string | null> = {
  auth: 'MSG-21',
  offline: 'MSG-22',
  limit: 'MSG-23',
  billing: 'MSG-30',
  missing: 'MSG-20',
  other: null,
};

const CODES = new Set<ClaudeErrorCode>(['auth', 'limit', 'billing', 'offline', 'missing', 'other']);

/** 채널 오류(DeskError.code)가 Claude 오류 코드면 그 코드 */
export function claudeErrCode(code: string | undefined): ClaudeErrorCode | null {
  return code && CODES.has(code as ClaudeErrorCode) && code !== 'other' ? (code as ClaudeErrorCode) : null;
}

export function errMsgText(code: ClaudeErrorCode, fallback: string): string {
  const id = ERR_MSG[code];
  return id ? msg(id) : fallback;
}

/** 운영 조회 확인(MSG-42)의 최대 행 수: 요청 설명에 있으면 그 값, 없으면 운영 기본값 */
export function maxRowsOf(detail: string | undefined, fallback: number): number {
  const m = detail?.match(/최대\s*([\d,]+)\s*행/);
  return m ? Number(m[1].replace(/,/g, '')) : fallback;
}

/** SELECT 문의 첫 테이블 이름 (작업 내역 한 줄 표시용) */
export function firstTable(sql: string): string {
  const m = sql.replace(/\s+/g, ' ').match(/\bfrom\s+([A-Za-z0-9_$#."]+)/i);
  if (!m) return '';
  const t = m[1].replace(/"/g, '');
  return t.includes('.') ? t.slice(t.lastIndexOf('.') + 1) : t;
}
