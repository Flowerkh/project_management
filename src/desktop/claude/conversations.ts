// Claude 대화 저장: projectDir(root)/conversations/<id>.json (원본 폴더 없이 연 대화는 <dataDir>/conversations/)
// 대화 내용 자체는 Claude Code가 PC에 남기고(sessionId로 이어서 대화), 앱은 화면에 보인 항목과 대화 ID를 보관한다.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChatContext, ChatItem, Conversation, ConversationSummary } from '../../shared/desktop-api';
import { ENV_LABEL } from '../../shared/desktop-api';
import { dataDir, projectDir, readJson, withLock, writeJson } from '../store';

export interface StoredConversation extends Conversation {
  /** Claude 작업 폴더 (작업 사본·새 프로젝트 폴더·빈 폴더) */
  cwd: string;
  /** 원본 폴더 없이 연 대화: 수정·명령 불가 */
  readOnly?: boolean;
  /** 첫 메시지에 [맥락]을 붙였음 */
  contextSent?: boolean;
  references?: { name: string; text: string }[];
}

const ID_RE = /^c[a-z0-9]{6,40}$/;

export function validId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function convDir(root: string | null): string {
  return root ? path.join(projectDir(root), 'conversations') : path.join(dataDir(), 'conversations');
}

const fileById = new Map<string, string>();

export function convFile(c: { id: string; root: string | null }): string {
  return path.join(convDir(c.root), `${c.id}.json`);
}

export async function saveConv(c: StoredConversation): Promise<void> {
  const f = convFile(c);
  fileById.set(c.id, f);
  const data: StoredConversation = { ...c, running: false, pending: undefined };
  await withLock(f, () => writeJson(f, data));
}

/** id로 찾기: 기억해 둔 위치 → 원본 없는 대화 폴더 → 프로젝트 폴더들 */
export async function findConvFile(id: string): Promise<string | null> {
  if (!validId(id)) return null;
  const known = fileById.get(id);
  if (known && fs.existsSync(known)) return known;
  const direct = path.join(dataDir(), 'conversations', `${id}.json`);
  if (fs.existsSync(direct)) return direct;
  const projects = path.join(dataDir(), 'projects');
  let names: string[] = [];
  try {
    names = await fsp.readdir(projects);
  } catch {
    names = [];
  }
  for (const n of names) {
    const f = path.join(projects, n, 'conversations', `${id}.json`);
    if (fs.existsSync(f)) {
      fileById.set(id, f);
      return f;
    }
  }
  return null;
}

export async function loadConv(id: string): Promise<StoredConversation | null> {
  const f = await findConvFile(id);
  if (!f) return null;
  const c = await readJson<StoredConversation | null>(f, null);
  if (!c || c.id !== id) return null;
  c.running = false;
  delete c.pending;
  if (!Array.isArray(c.items)) c.items = [];
  return c;
}

export async function deleteConvFile(id: string): Promise<void> {
  const f = await findConvFile(id);
  fileById.delete(id);
  if (f) await fsp.rm(f, { force: true });
}

export async function listConvs(root: string | null): Promise<ConversationSummary[]> {
  const dir = convDir(root);
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ConversationSummary[] = [];
  for (const n of names) {
    const c = await readJson<StoredConversation | null>(path.join(dir, n), null);
    if (!c || !validId(c.id)) continue;
    fileById.set(c.id, path.join(dir, n));
    out.push({ id: c.id, kind: c.kind, title: c.title, updatedAt: c.updatedAt, mode: c.mode, items: Array.isArray(c.items) ? c.items.length : 0 });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

/** 화면에 보내는 모양 (작업 폴더 등 내부 값 제외) */
export function publicConv(c: StoredConversation, live?: { running: boolean; pending?: Conversation['pending'] }): Conversation {
  const out: Conversation = {
    id: c.id,
    root: c.root,
    kind: c.kind,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    mode: c.mode,
    items: c.items,
    running: live?.running ?? false,
  };
  if (c.model !== undefined) out.model = c.model;
  if (c.activeModel) out.activeModel = c.activeModel;
  if (c.sessionId) out.sessionId = c.sessionId;
  if (c.workId) out.workId = c.workId;
  if (c.context) out.context = c.context;
  if (live?.pending) out.pending = live.pending;
  return out;
}

// ------------------------------------------------------------------ Markdown 내보내기 (F-21)

function hm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function quote(s: string): string {
  return s
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function fence(s: string, lang = ''): string {
  const ticks = /```/.test(s) ? '````' : '```';
  return `${ticks}${lang}\n${s}\n${ticks}`;
}

function contextLines(ctx: ChatContext | undefined): string[] {
  if (!ctx?.chips?.length) return [];
  return [`- 맥락: ${ctx.chips.map((c) => c.label).join(', ')}`];
}

export function toMarkdown(c: Conversation, projectLabel?: string): string {
  const out: string[] = [];
  out.push(`# ${c.title || 'Claude 대화'}`);
  out.push('');
  out.push(`- 프로젝트: ${projectLabel ?? (c.root ? c.root : '원본 폴더 없음 (분석 결과 파일)')}`);
  out.push(`- 종류: ${c.kind === 'new' ? '새 프로젝트' : '이슈 처리'} · 시작 ${hm(c.createdAt)} · 마지막 ${hm(c.updatedAt)}`);
  out.push(...contextLines(c.context));
  out.push('');
  for (const it of c.items) out.push(...itemMarkdown(it), '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function itemMarkdown(it: ChatItem): string[] {
  switch (it.type) {
    case 'user':
      return [`## 질문 · ${hm(it.at)}`, '', it.text];
    case 'assistant':
      return [`## Claude · ${hm(it.at)}`, '', it.text];
    case 'activity':
      return [quote(`작업 내역: ${it.summary}`), ...it.items.map((x) => `> - ${x.label}`)];
    case 'changes':
      return [quote(`작업 사본 변경: 파일 ${it.files}개 (+${it.plus} −${it.minus})`), ...it.paths.map((p) => `> - ${p}`)];
    case 'select':
      return [quote(`DB 조회: ${ENV_LABEL[it.env]} ${it.db} · ${it.rows}행 · ${it.ms}ms${it.maskedColumns.length ? ` · 가린 컬럼 ${it.maskedColumns.join(', ')}` : ''}`), '', fence(it.sql, 'sql')];
    case 'query':
      return [
        quote(`변경 쿼리 (${ENV_LABEL[it.card.env]} ${it.card.dbName} · ${it.card.kind.toUpperCase()} · ${queryStatus(it.card.status)})${it.card.description ? `: ${it.card.description}` : ''}`),
        '',
        fence(it.card.sql, 'sql'),
        ...(it.card.revertSql ? ['', '되돌리는 SQL:', '', fence(it.card.revertSql, 'sql')] : []),
      ];
    case 'mode':
      return [quote(it.mode === 'edit' ? '수정 허용으로 바꿈 (작업 사본만 수정)' : '계획 모드로 바꿈')];
    case 'notice':
      return [quote(it.text)];
    case 'error':
      return [quote(`오류: ${it.message}`)];
    default:
      return [];
  }
}

function queryStatus(s: string): string {
  return ({ pending: '실행 전', running: '실행 중', done: '실행함', failed: '실패', rolledback: '롤백됨', rejected: '거부함' } as Record<string, string>)[s] ?? s;
}

/** 저장할 파일 이름 (Windows에서 못 쓰는 글자 제거) */
export function exportFileName(c: Conversation): string {
  const base = (c.title || 'Claude 대화').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Claude 대화';
  const d = new Date(c.createdAt);
  const stamp = Number.isNaN(d.getTime()) ? '' : `-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${base}${stamp}.md`;
}
