// Claude 작업 내역(ChatItem 'activity'): 한 번의 답변(턴)에서 쓴 도구를 묶어 한 줄 요약
//   "작업 3건 파일 2개 읽음 · insertOrderHist 검색 3곳" / "작업 3건 파일 2개 수정 · mvn -q compile 성공"
import path from 'node:path';
import { ENV_LABEL, type Env } from '../../shared/desktop-api';
import { absPath, isInside } from './guards';

export type ActKind = 'read' | 'search' | 'edit' | 'command' | 'db' | 'other';

export interface ActEntry {
  toolUseId: string;
  tool: string;
  kind: ActKind;
  label: string;
  file?: string;
  line?: number;
  /** 검색어·명령·파일 등 요약에 쓰는 대상 */
  target?: string;
  hits?: number;
  created?: boolean;
  ok?: boolean;
  /** 앱 규칙으로 막힘 */
  blocked?: boolean;
  /** 하위 작업(서브에이전트) 안에서 씀 */
  sub?: boolean;
  /** db 조회 행 수 */
  rows?: number;
  env?: Env;
  /** 작업 사본 밖(Claude Code 계획 파일 등) → 변경 카드에 넣지 않음 */
  internal?: boolean;
}

function short(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** cwd 기준 상대 경로 ('/' 구분). 밖이면 null */
export function relPath(cwd: string, p: string, platform: NodeJS.Platform = process.platform): string | null {
  const pp = platform === 'win32' ? path.win32 : path.posix;
  const abs = absPath(p, cwd, platform);
  if (!isInside(cwd, abs, platform)) return null;
  const r = pp.relative(pp.resolve(cwd), abs);
  return r.split(pp.sep).join('/');
}

export interface DescribeCtx {
  cwd: string;
  platform?: NodeJS.Platform;
  isPlanFile(p: string): boolean;
}

/** tool_use 하나 → 작업 내역 한 줄 (null: 보이지 않는 도구) */
export function describeTool(ctx: DescribeCtx, toolUseId: string, name: string, input: Record<string, unknown>): ActEntry | null {
  const platform = ctx.platform ?? process.platform;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const base = { toolUseId, tool: name };
  const fileOf = (v: unknown) => {
    const p = str(v);
    if (!p) return { rel: '', abs: '' };
    const abs = absPath(p, ctx.cwd, platform);
    return { rel: relPath(ctx.cwd, abs, platform) ?? abs, abs };
  };
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const f = fileOf(input.file_path ?? input.notebook_path);
      const line = typeof input.offset === 'number' && input.offset > 1 ? Math.floor(input.offset) : undefined;
      if (ctx.isPlanFile(f.abs)) return { ...base, kind: 'other', label: '계획 확인', internal: true };
      return { ...base, kind: 'read', label: `${f.rel}${line ? `:${line}` : ''} 읽음`, file: f.rel, line, target: f.rel };
    }
    case 'Grep': {
      const pat = str(input.pattern);
      const where = str(input.path) ? relPath(ctx.cwd, str(input.path), platform) : '';
      return { ...base, kind: 'search', label: `'${short(pat, 40)}' 검색${where ? ` · ${where}` : ''}`, target: pat };
    }
    case 'Glob': {
      const pat = str(input.pattern);
      return { ...base, kind: 'search', label: `${short(pat, 40)} 파일 찾기`, target: pat };
    }
    case 'LS': {
      const f = fileOf(input.path);
      return { ...base, kind: 'search', label: `${f.rel || '.'} 목록 보기`, target: f.rel };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const f = fileOf(input.file_path ?? input.notebook_path);
      if (ctx.isPlanFile(f.abs)) return { ...base, kind: 'other', label: '계획 작성', internal: true };
      return { ...base, kind: 'edit', label: `${f.rel} ${name === 'Write' ? '작성' : '수정'}`, file: f.rel, target: f.rel };
    }
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(input.command);
      return { ...base, kind: 'command', label: `${short(cmd, 60)} 실행`, target: cmd };
    }
    case 'mcp__projdb__db_select': {
      const env = (['dev', 'qa', 'prod'] as const).find((e) => e === input.env);
      return { ...base, kind: 'db', label: `SELECT · ${env ? ENV_LABEL[env] : '개발'} DB`, target: str(input.sql), env };
    }
    case 'mcp__projdb__db_propose_change':
      return { ...base, kind: 'db', label: `변경 쿼리 제안${str(input.description) ? ` · ${short(str(input.description), 40)}` : ''}`, target: str(input.sql) };
    case 'mcp__projdb__db_list':
      return { ...base, kind: 'db', label: 'DB 연결 목록 확인' };
    case 'Agent':
    case 'Task':
      return { ...base, kind: 'other', label: `하위 작업: ${short(str(input.description) || str(input.subagent_type) || '조사', 40)}` };
    case 'TodoWrite':
    case 'ExitPlanMode':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return null;
    default:
      return { ...base, kind: 'other', label: name };
  }
}

export interface ToolResultInfo {
  isError: boolean;
  text: string;
  /** SDKUserMessage.tool_use_result (도구별 구조화 결과) */
  structured?: unknown;
}

const BLOCK_HINT = /읽을 수 없습니다|고칠 수 없습니다|허용되지 않았습니다|허용 목록에 없는|실행할 수 없습니다|쓰지 않습니다|사용자가 .*거부|denied|not allowed/i;

/** 도구 결과로 줄을 보완 (검색 건수, 수정한 줄, 명령 성공 여부) */
export function applyResult(e: ActEntry, r: ToolResultInfo): void {
  const s = (r.structured && typeof r.structured === 'object' ? r.structured : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  e.ok = !r.isError;
  if (r.isError) {
    e.blocked = BLOCK_HINT.test(r.text);
    if (!/ · (막힘|실패)$/.test(e.label)) e.label += e.blocked ? ' · 막힘' : ' · 실패';
    return;
  }
  if (e.tool === 'Grep') {
    let hits = num(s.numMatches) ?? (s.mode === 'content' ? num(s.numLines) : undefined) ?? num(s.numFiles);
    if (hits === undefined) {
      const m = /Found (\d+) (files?|matches|lines?)/i.exec(r.text);
      if (m) hits = Number(m[1]);
      else if (/^No (files|matches) found/i.test(r.text.trim())) hits = 0;
      else hits = r.text.split('\n').filter((l) => l.trim()).length;
    }
    e.hits = hits;
    e.label = `${e.label.replace(/ \d+곳$/, '')} ${hits}곳`;
  } else if (e.tool === 'Glob') {
    const n = num(s.numFiles) ?? (Array.isArray(s.filenames) ? s.filenames.length : r.text.split('\n').filter((l) => l.trim() && !/^No files/i.test(l)).length);
    e.hits = n;
    e.label = `${e.label} ${n}개`;
  } else if (e.kind === 'edit') {
    const patch = Array.isArray(s.structuredPatch) ? (s.structuredPatch as { newStart?: number }[]) : [];
    if (typeof patch[0]?.newStart === 'number') e.line = patch[0].newStart;
    if (e.tool === 'Write') {
      e.created = s.type === 'create' || /created|새로 만듦|File created/i.test(r.text);
      e.label = e.label.replace(/ 작성$/, e.created ? ' 생성' : ' 수정');
    }
  } else if (e.kind === 'command') {
    e.label = `${e.label.replace(/ 실행$/, '')} 성공`;
  }
}

/** 요약 문장 */
export function summarize(entries: ActEntry[]): string {
  const visible = entries;
  const parts: string[] = [];
  const reads = new Set(visible.filter((e) => e.kind === 'read' && e.file && e.ok !== false).map((e) => e.file));
  if (reads.size) parts.push(`파일 ${reads.size}개 읽음`);
  const searches = visible.filter((e) => e.kind === 'search');
  if (searches.length === 1) {
    const s0 = searches[0];
    parts.push(`${short(s0.target || '', 30)} ${s0.tool === 'Glob' ? '찾기' : '검색'}${typeof s0.hits === 'number' ? ` ${s0.hits}${s0.tool === 'Glob' ? '개' : '곳'}` : ''}`.trim());
  } else if (searches.length > 1) parts.push(`검색 ${searches.length}번`);
  const edits = visible.filter((e) => e.kind === 'edit' && e.ok !== false);
  const created = new Set(edits.filter((e) => e.created).map((e) => e.file));
  const modified = new Set(edits.filter((e) => !e.created && e.file && !created.has(e.file)).map((e) => e.file));
  if (modified.size) parts.push(`파일 ${modified.size}개 수정`);
  if (created.size) parts.push(`파일 ${created.size}개 생성`);
  const cmds = visible.filter((e) => e.kind === 'command');
  if (cmds.length === 1) {
    const c = cmds[0];
    parts.push(`${short(c.target || '', 30)} ${c.blocked ? '막힘' : c.ok === false ? '실패' : c.ok ? '성공' : '실행'}`);
  } else if (cmds.length > 1) parts.push(`명령 ${cmds.length}개 실행`);
  const selects = visible.filter((e) => e.tool === 'mcp__projdb__db_select');
  if (selects.length) parts.push(`DB 조회 ${selects.length}번`);
  const proposals = visible.filter((e) => e.tool === 'mcp__projdb__db_propose_change');
  if (proposals.length) parts.push(`쿼리 제안 ${proposals.length}건`);
  const blocked = visible.filter((e) => e.blocked && e.kind !== 'command');
  if (blocked.length) parts.push(`막힘 ${blocked.length}건`);
  const others = visible.filter((e) => e.kind === 'other');
  if (others.length && !parts.length) parts.push(others.map((e) => e.label).slice(0, 2).join(' · '));
  else if (others.length) parts.push(`기타 ${others.length}건`);
  return `작업 ${visible.length}건${parts.length ? ` ${parts.join(' · ')}` : ''}`;
}
