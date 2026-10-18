// 앱 분석기(Android·React Native·Flutter) 공용 도구: 화면 이름, 기능 폴더 그룹, API 경로 정리, 로컬 DB SQL 사실
import type { Ctx } from '../context';
import type { Crud, DdlColumn, Facts, MethodUnit, SqlFact } from '../types';
import { compactSql, isSqlLike, parseSql, tableKey } from '../sql';
import { parseCreateTable } from '../ddl';
import { nameFromPath } from '../roles';

/** 화면 클래스·컴포넌트 이름 → 기본 화면 이름 (OrderListFragment → 주문 목록, HomeScreen → Home) */
export function screenNameOf(id: string): string {
  let base = id.replace(/^_+/, '').replace(/State$/, '');
  for (let i = 0; i < 2; i++) {
    const s = base.replace(/(BottomSheetDialogFragment|DialogFragment|BottomSheet|Activity|Fragment|Dialog|Screen|Page|Widget|Route|Container|View)$/, '');
    if (!s || s === base) break;
    base = s;
  }
  const ko = nameFromPath(base).trim();
  if (/[가-힣]/.test(ko) && !/[A-Za-z]/.test(ko)) return ko;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim() || id;
}

/** 경로 조각 중 기능 이름이 아닌 것 (그룹 이름에서 건너뜀). SOFT는 다른 이름이 없을 때만 씀 */
const GENERIC_DIRS = new Set([
  'src', 'main', 'java', 'kotlin', 'lib', 'app', 'ui', 'view', 'views', 'screen', 'screens', 'page', 'pages', 'presentation',
  'widget', 'widgets', 'component', 'components', 'compose', 'layout', 'res',
]);
const SOFT_DIRS = new Set(['feature', 'features', 'fragment', 'fragments', 'activity', 'activities', 'scene', 'scenes', 'container', 'containers', 'modules', 'module', 'routes', 'tabs']);

/** 앱 화면 트리 그룹: 화면 파일의 기능 폴더 (ui/order/OrderFragment.kt → order). root는 하위 프로젝트 폴더 */
export function featureGroup(path: string, root = ''): string {
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const dirs = rel.split('/').slice(0, -1).filter((d) => !/^\(.*\)$/.test(d));
  for (const skipSoft of [true, false]) {
    for (let i = dirs.length - 1; i >= 0; i--) {
      const d = dirs[i].toLowerCase();
      if (!GENERIC_DIRS.has(d) && !(skipSoft && SOFT_DIRS.has(d))) return dirs[i];
    }
  }
  return dirs[dirs.length - 1] ?? '/';
}

/** 클라이언트 코드의 URL → 서버 라우트와 맞출 경로 (호스트·쿼리 제거, 식 → {p}) */
export function apiPath(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, '{p}');
  s = s.replace(/\{[^}]*\}/g, (m) => (m === '{p}' ? m : '{p}'));
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  // 맨 앞의 모르는 값({p}/orders)은 기준 주소로 보고 뺌
  s = s.replace(/^(\/\{p\})+(?=\/)/, '');
  if (s.length > 1) s = s.replace(/\/$/, '');
  if (s === '/' || /^\/(\{p\})?$/.test(s)) return null;
  if (!/^[\w./{}~:%@,+-]+$/.test(s)) return null;
  if (/\.(js|css|png|jpe?g|gif|ico|svg|woff2?|ttf|html?)$/i.test(s)) return null;
  return s;
}

/** Retrofit 규칙: '/'로 시작하면 호스트 기준, 아니면 기준 URL 경로 뒤에 붙임 */
export function joinBase(base: string | undefined, path: string): string {
  if (/^[a-z]+:\/\//i.test(path) || !base) return path;
  if (path.startsWith('/')) return path;
  const b = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return `${b.replace(/\/+$/, '')}/${path}`;
}

/** HTTP 호출 하나 기록 (같은 메서드·주소는 한 번) */
export function addHttp(m: MethodUnit, method: string, rawUrl: string, line: number): void {
  const url = apiPath(rawUrl);
  if (!url) return;
  const list = (m.httpCalls ??= []);
  const verb = method.toUpperCase();
  if (!list.some((h) => h.url === url && h.method === verb)) list.push({ method: verb, url, line });
}

/** 코드 안 SQL 문자열 → SqlFact (CREATE TABLE은 DDL로) */
export function addSqlText(ctx: Ctx, file: string, line: number, m: MethodUnit | null, sql: string, opts: { trusted?: boolean; origin?: SqlFact['origin'] } = {}): SqlFact | null {
  const text = sql.trim();
  if (!text) return null;
  if (/^\s*CREATE\s+(TEMP(ORARY)?\s+)?(VIRTUAL\s+)?TABLE\b/i.test(text)) {
    addDdlText(ctx, file, line, text);
    return null;
  }
  if (!opts.trusted && !isSqlLike(text)) return null;
  const p = parseSql(text);
  if (!p.tables.length && p.kind !== 'call') return null;
  const s = ctx.addSql({ file, line, origin: opts.origin ?? 'string', kind: p.kind, tables: p.tables, ...(p.dynamic ? { dynamic: true } : {}), text: compactSql(text) });
  if (m && !m.sql.includes(s.id)) m.sql.push(s.id);
  return s;
}

/** 테이블 이름만 아는 ORM·DB API 호출 (db.insert("orders", …), @Insert, select(todos)) */
export function addTableOp(ctx: Ctx, file: string, line: number, m: MethodUnit, kind: 'select' | 'insert' | 'update' | 'delete', table: string, label: string, extra: Crud[] = []): void {
  const crud: Crud = kind === 'insert' ? 'C' : kind === 'update' ? 'U' : kind === 'delete' ? 'D' : 'R';
  const name = table.trim();
  if (!/^[A-Za-z_][\w$.]*$/.test(name)) return;
  const exists = m.sql.map((id) => ctx.facts.sql.find((s) => s.id === id)).find((s) => s && s.origin === 'orm' && s.kind === kind && s.tables.some((t) => tableKey(t.name) === tableKey(name)));
  if (exists) return;
  const s = ctx.addSql({ file, line, origin: 'orm', kind, tables: [{ name, crud }, ...extra.map((c) => ({ name, crud: c }))], text: label });
  m.sql.push(s.id);
}

/** CREATE TABLE 문 → DDL 테이블 (같은 이름이 이미 있으면 건너뜀) */
export function addDdlText(ctx: Ctx, file: string, line: number, sql: string): void {
  const t = parseCreateTable(sql.replace(/\bIF\s+NOT\s+EXISTS\b/i, ''));
  if (!t) return;
  addDdlTable(ctx.facts, { ...t, evidence: { file, line } });
}

export function addDdlTable(facts: Facts, t: { name: string; comment?: string; columns: DdlColumn[]; evidence: { file: string; line: number } }): void {
  if (!/^[A-Za-z_][\w$]*$/.test(t.name)) return;
  if (facts.ddl.some((d) => tableKey(d.name) === tableKey(t.name))) return;
  facts.ddl.push({ name: t.name, ...(t.comment ? { comment: t.comment } : {}), columns: t.columns, evidence: t.evidence });
}

/** 빈 메서드 단위 */
export function newMethod(name: string, line: number, endLine?: number): MethodUnit {
  return { name, line, ...(endLine ? { endLine } : {}), routes: [], calls: [], sql: [], statements: [], views: [] };
}

/** camelCase·PascalCase → snake_case (소문자) */
export function snakeLower(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

/** 문자열 안 이스케이프 풀기 (Kotlin·Java·Dart·JS 공통 부분) */
export function unescapeStr(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '', f: '', '0': '' } as Record<string, string>)[c] ?? c;
  });
}

/** 앞뒤 공백·줄바꿈이 섞인 표시 문자열 정리 */
export function cleanLabel(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  return t || undefined;
}

/** 여러 분석기가 같은 사실 묶음을 공유하기 위한 상태 */
export function stateOf<T>(key: object, map: WeakMap<object, T>, init: () => T): T {
  let s = map.get(key);
  if (!s) {
    s = init();
    map.set(key, s);
  }
  return s;
}

/** 구조용 텍스트(문자열·주석을 가린 것)에서 여는 괄호 open에 맞는 닫는 위치. 못 찾으면 limit-1 */
export function closeOf(s: string, open: number, limit = s.length): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth <= 0) return i;
    }
  }
  return limit - 1;
}

/** '<' 위치에서 제네릭 꺾쇠 짝 다음 위치 (중간에 { ; = 가 나오면 꺾쇠가 아님 → open+1) */
export function skipAngles(s: string, open: number, limit = s.length): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const ch = s[i];
    if (ch === '<') depth++;
    else if (ch === '>' && s[i - 1] !== '-') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === '(' || ch === '[') i = closeOf(s, i, limit);
    else if (ch === '{' || ch === ';' || ch === '=' || ch === '\n') return open + 1;
  }
  return open + 1;
}

/** 쉼표로 나누기 (괄호·꺾쇠 안은 무시) — 구조용 텍스트 기준 위치 목록 */
export function splitArgs(s: string, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = from;
  let i = from;
  while (i < to) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      i = closeOf(s, i, to) + 1;
      continue;
    }
    if (ch === '<') {
      const j = skipAngles(s, i, to);
      if (j > i + 1) {
        i = j;
        continue;
      }
    }
    if (ch === ',') {
      out.push({ from: start, to: i });
      start = i + 1;
    }
    i++;
  }
  if (s.slice(start, to).trim()) out.push({ from: start, to });
  return out;
}

/** 줄 번호 → 그 줄 시작 위치 */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
