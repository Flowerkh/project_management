// Go 분석기: Gin·Echo·Fiber·chi·gorilla/mux·net/http 라우트, 핸들러·서비스·저장소 호출,
// database/sql·sqlx 문자열 SQL, GORM 체인, html/template 화면
import type { Analyzer, Ctx } from '../context';
import type { CodeUnit, Crud, FileInfo, MethodUnit, TableRef, UrlRef, ViewFact } from '../types';
import { baseName, dirName, makeLineIndex } from '../files';
import { compactSql, isSqlLike, parseSql } from '../sql';
import { extractRefs, extractTitle, normalizeRef } from './web-refs';

// ------------------------------------------------------------------ 토큰
type GK = 'id' | 'str' | 'num' | 'op' | 'char';
interface GT {
  k: GK;
  v: string;
  p: number;
  raw?: boolean;
}

const GO_OPS = ['<<=', '>>=', '&^=', '...', '&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^'];

function lexGo(src: string): GT[] {
  const out: GT[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < n && src[j] !== '"' && src[j] !== '\n'; j++) {
        if (src[j] === '\\') {
          const nx = src[j + 1];
          v += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx ?? '';
          j++;
        } else v += src[j];
      }
      out.push({ k: 'str', v, p: i });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      const e = j < 0 ? n : j;
      out.push({ k: 'str', v: src.slice(i + 1, e), p: i, raw: true });
      i = e + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'" && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out.push({ k: 'char', v: src.slice(i + 1, j), p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w\u0080-￿]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), p: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|[0-9_]*\.?[0-9_]+([eE][+-]?\d+)?i?)/.exec(src.slice(i, i + 40));
      const len = m && m[0].length ? m[0].length : 1;
      out.push({ k: 'num', v: src.slice(i, i + len), p: i });
      i += len;
      continue;
    }
    let op = '';
    for (const o of GO_OPS) {
      if (src.startsWith(o, i)) {
        op = o;
        break;
      }
    }
    if (!op) op = c;
    out.push({ k: 'op', v: op, p: i });
    i += op.length;
  }
  return out;
}

function closeOf(t: GT[], i: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  if (!pairs[t[i]?.v]) return i;
  let d = 0;
  for (let j = i; j < t.length; j++) {
    const v = t[j].k === 'op' ? t[j].v : '';
    if (v === '(' || v === '[' || v === '{') d++;
    else if (v === ')' || v === ']' || v === '}') {
      d--;
      if (!d) return j;
    }
  }
  return t.length - 1;
}

function argsOf(t: GT[], open: number): [number, number][] {
  const close = closeOf(t, open);
  const out: [number, number][] = [];
  let s = open + 1;
  let d = 0;
  for (let j = open + 1; j < close; j++) {
    const v = t[j].k === 'op' ? t[j].v : '';
    if (v === '(' || v === '[' || v === '{') d++;
    else if (v === ')' || v === ']' || v === '}') d--;
    else if (v === ',' && !d) {
      out.push([s, j]);
      s = j + 1;
    }
  }
  if (s < close) out.push([s, close]);
  return out;
}

/** 문자열 리터럴(+ 연결) 값 */
function strArg(t: GT[], [a, b]: [number, number]): string | null {
  let s = '';
  let any = false;
  for (let j = a; j < b; j++) {
    if (t[j].k === 'str') {
      s += t[j].v;
      any = true;
    } else if (t[j].v === '+') continue;
    else if (t[j].v === '(' || t[j].v === ')') continue;
    else s += '${v}';
  }
  return any ? s : null;
}

// ------------------------------------------------------------------ 상태

interface PendingRoute {
  method: string;
  path: string;
  line: number;
  file: string;
  handler: { name: string; pkg?: string; recv?: string; via?: string; dir: string } | null;
  inline?: MethodUnit;
  dir: string; // 등록한 파일의 패키지 폴더
}

interface GormOp {
  method: MethodUnit;
  type?: string;
  table?: string;
  crud: Crud[];
  joins: string[];
  file: string;
  line: number;
  desc: string;
}

interface StructDef {
  name: string;
  dir: string;
  file: string;
  line: number;
  fields: Record<string, string>;
  tags: boolean;
}

interface GoState {
  modules: { dir: string; path: string }[];
  routes: PendingRoute[];
  gorm: GormOp[];
  structs: Map<string, StructDef[]>; // 이름 → 정의
  tableNames: Map<string, string>; // 타입 이름 → TableName() 값
  units: Map<string, CodeUnit>; // file|type → 유닛
  consts: Map<string, string>; // dir|이름 → SQL id
  constRefs: { method: MethodUnit; dir: string; names: Set<string> }[];
  templates: Map<string, { view: ViewFact; file: FileInfo; defines: string[]; uses: string[] }>;
  goDirs: string[]; // go.mod 폴더
  routerParams: { fn: string; dir: string; recv?: string; idx: number; param: string; routes: PendingRoute[] }[];
  routerArgs: { fn: string; via?: string; idx: number; prefix: string }[];
}

const states = new WeakMap<Ctx, GoState>();

function state(ctx: Ctx): GoState {
  let st = states.get(ctx);
  if (st) return st;
  const modules: GoState['modules'] = [];
  for (const f of ctx.facts.files) {
    if (f.name !== 'go.mod') continue;
    const m = /^\s*module\s+(\S+)/m.exec(ctx.facts.texts.get(f.id) ?? '');
    modules.push({ dir: dirName(f.path), path: m ? m[1] : '' });
  }
  st = {
    modules, routes: [], gorm: [], structs: new Map(), tableNames: new Map(), units: new Map(), consts: new Map(), constRefs: [],
    templates: new Map(), goDirs: modules.map((m) => m.dir), routerParams: [], routerArgs: [],
  };
  states.set(ctx, st);
  return st;
}

function inGoProject(st: GoState, path: string): boolean {
  return st.goDirs.some((d) => d === '' || path.startsWith(`${d}/`));
}

/** import 경로 → 프로젝트 안 폴더 */
function dirOfImport(st: GoState, imp: string): string | null {
  for (const m of st.modules) {
    if (m.path && (imp === m.path || imp.startsWith(`${m.path}/`))) {
      const rest = imp.slice(m.path.length).replace(/^\//, '');
      return [m.dir, rest].filter(Boolean).join('/');
    }
  }
  return null;
}

function snakePlural(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  const parts = s.split('_');
  const w = parts[parts.length - 1];
  parts[parts.length - 1] = /(s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
  return parts.join('_');
}

/** 타입 식에서 기본 이름: *pkg.Order, []model.Item, map[string]T → Order/Item/T */
function baseType(t: GT[], a: number, b: number): string | null {
  let last: string | null = null;
  for (let j = a; j < b; j++) {
    if (t[j].k === 'id' && !['map', 'chan', 'func', 'interface', 'struct', 'string', 'int', 'int64', 'uint', 'bool', 'byte', 'error', 'any', 'float64'].includes(t[j].v)) last = t[j].v;
    if (t[j].k === 'id' && t[j].v === 'map') {
      // map[K]V → V
      const close = closeOf(t, j + 1);
      j = close;
    }
  }
  return last;
}

const ROUTER_CTOR = /^(Default|New|NewRouter|NewServeMux)$/;
const ROUTER_PKG = new Set(['gin', 'echo', 'fiber', 'chi', 'mux', 'http', 'httprouter']);
const VERBS: Record<string, string> = {
  GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', OPTIONS: 'OPTIONS', HEAD: 'HEAD', Any: '*',
  Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Options: 'OPTIONS', Head: 'HEAD', All: '*',
};
const ROUTER_TYPES = /^(Engine|RouterGroup|IRouter|IRoutes|Echo|Group|App|Router|ServeMux|Mux)$/;

const GORM_READ = new Set(['Find', 'First', 'Last', 'Take', 'Scan', 'Count', 'Pluck', 'Row', 'Rows', 'FindInBatches', 'FirstOrInit']);
const GORM_WRITE: Record<string, Crud[]> = {
  Create: ['C'], CreateInBatches: ['C'], FirstOrCreate: ['R', 'C'], Save: ['U'], Update: ['U'], Updates: ['U'], UpdateColumn: ['U'], UpdateColumns: ['U'], Delete: ['D'],
};
const GORM_CHAIN = new Set(['Model', 'Table', 'Where', 'Or', 'Not', 'Select', 'Omit', 'Joins', 'Preload', 'Order', 'Limit', 'Offset', 'Group', 'Having', 'Distinct', 'Scopes', 'Unscoped', 'Clauses', 'WithContext', 'Session', 'Debug', 'InnerJoins', 'Attrs', 'Assign']);

// ------------------------------------------------------------------ 파일 분석

interface FnInfo {
  name: string;
  recv?: string;
  recvVar?: string;
  at: number;
  paramsOpen: number;
  bodyOpen: number;
  bodyClose: number;
}

function parseFuncs(t: GT[]): FnInfo[] {
  const out: FnInfo[] = [];
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.k === 'op' && (x.v === '{' || x.v === '(' || x.v === '[')) depth++;
    else if (x.k === 'op' && (x.v === '}' || x.v === ')' || x.v === ']')) depth--;
    if (depth !== 0 || x.k !== 'id' || x.v !== 'func') continue;
    let j = i + 1;
    let recv: string | undefined;
    let recvVar: string | undefined;
    if (t[j]?.v === '(') {
      const close = closeOf(t, j);
      const ids = t.slice(j + 1, close).filter((y) => y.k === 'id');
      if (ids.length >= 2) {
        recvVar = ids[0].v;
        recv = ids[1].v;
      } else if (ids.length === 1) recv = ids[0].v;
      j = close + 1;
    }
    if (t[j]?.k !== 'id') continue;
    const name = t[j].v;
    j++;
    if (t[j]?.v === '[') j = closeOf(t, j) + 1; // 타입 매개변수
    if (t[j]?.v !== '(') continue;
    const paramsOpen = j;
    let k = closeOf(t, j) + 1;
    // 반환 타입: ( … ) 또는 토큰들 → { 까지
    while (k < t.length && t[k].v !== '{') {
      if (t[k].v === '(') k = closeOf(t, k);
      k++;
    }
    if (k >= t.length) break;
    const close = closeOf(t, k);
    out.push({ name, ...(recv ? { recv } : {}), ...(recvVar ? { recvVar } : {}), at: i, paramsOpen, bodyOpen: k, bodyClose: close });
    i = close;
    depth = 0;
  }
  return out;
}

function parseImports(t: GT[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (alias: string | null, path: string) => {
    const segs = path.split('/');
    let name = segs[segs.length - 1];
    if (/^v\d+$/.test(name) && segs.length > 1) name = segs[segs.length - 2];
    name = name.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/-/g, '');
    if (alias === '_' || alias === '.') return;
    out.set(alias ?? name, path);
  };
  for (let i = 0; i < t.length; i++) {
    if (t[i].k !== 'id' || t[i].v !== 'import') continue;
    if (t[i + 1]?.v === '(') {
      const close = closeOf(t, i + 1);
      for (let j = i + 2; j < close; j++) {
        if (t[j].k === 'str') add(t[j - 1]?.k === 'id' || t[j - 1]?.v === '_' || t[j - 1]?.v === '.' ? t[j - 1].v : null, t[j].v);
      }
      i = close;
    } else if (t[i + 1]?.k === 'str') add(null, t[i + 1].v);
    else if (t[i + 2]?.k === 'str') add(t[i + 1].v, t[i + 2].v);
  }
  return out;
}

function parseStructs(t: GT[], f: FileInfo, dir: string, lineOf: (p: number) => number, st: GoState): void {
  for (let i = 0; i < t.length - 3; i++) {
    if (t[i].k !== 'id' || t[i].v !== 'type') continue;
    const decl = (start: number) => {
      if (t[start]?.k !== 'id') return start;
      const name = t[start].v;
      let j = start + 1;
      if (t[j]?.v === '[') j = closeOf(t, j) + 1;
      if (t[j]?.v !== 'struct' || t[j + 1]?.v !== '{') return j;
      const close = closeOf(t, j + 1);
      const fields: Record<string, string> = {};
      let tags = false;
      // 줄 단위가 아니라 토큰 단위: 이름들 타입 [태그]
      let k = j + 2;
      while (k < close) {
        const lineStart = k;
        // 한 필드 선언 끝: 다음 필드 시작은 줄바꿈이지만 토큰엔 없음 → 태그(str) 또는 다음 이름 앞에서 끊기
        const names: string[] = [];
        while (t[k]?.k === 'id' && t[k + 1]?.v === ',') {
          names.push(t[k].v);
          k += 2;
        }
        if (t[k]?.k === 'id') {
          // name Type 또는 내장 Type
          const nameTok = t[k];
          const nextTok = t[k + 1];
          const typeStart = nextTok && (nextTok.k === 'id' || nextTok.v === '*' || nextTok.v === '[' || nextTok.v === '.') && nextTok.v !== '.' ? k + 1 : k;
          let e = typeStart;
          // 타입 끝: 같은 줄의 태그 또는 다음 필드
          const lineOfTok = lineOf(t[typeStart].p);
          while (e < close && lineOf(t[e].p) === lineOfTok && t[e].k !== 'str') {
            if (t[e].v === '{' || t[e].v === '[' || t[e].v === '(') e = closeOf(t, e);
            e++;
          }
          const ty = baseType(t, typeStart, e);
          if (typeStart === k) {
            if (ty) fields[ty] = ty; // 내장(embedded)
          } else {
            names.push(nameTok.v);
            const tyText = t.slice(typeStart, e).map((x) => x.v).join('');
            for (const nm of names) fields[nm] = /gorm\.DB/.test(tyText) ? 'gorm.DB' : ty ?? '';
          }
          if (t[e]?.k === 'str') {
            if (/gorm:|db:/.test(t[e].v)) tags = true;
            e++;
          }
          k = e;
        } else k++;
        if (k === lineStart) k++;
      }
      const def: StructDef = { name, dir, file: f.id, line: lineOf(t[start].p), fields, tags };
      st.structs.set(name, [...(st.structs.get(name) ?? []), def]);
      return close;
    };
    if (t[i + 1]?.v === '(') {
      const close = closeOf(t, i + 1);
      let j = i + 2;
      while (j < close) {
        const e = decl(j);
        j = Math.max(e + 1, j + 1);
      }
      i = close;
    } else i = decl(i + 1);
  }
}

function unitFor(ctx: Ctx, st: GoState, f: FileInfo, key: string, name: string, kind: CodeUnit['kind'], line: number): CodeUnit {
  const k = `${f.id}|${key}`;
  let u = st.units.get(k);
  if (!u) {
    u = ctx.addUnit({ file: f.id, name, kind, line, extendsOrImplements: [], fields: {}, methods: [] });
    st.units.set(k, u);
  }
  return u;
}

function kindOf(name: string, layer: FileInfo['layer']): CodeUnit['kind'] {
  if (/(Handler|Controller|Api|API|Endpoint|Resource)s?$/.test(name)) return 'controller';
  if (/(Service|Svc|Usecase|UseCase|Logic|Biz)$/.test(name)) return 'service';
  if (/(Repository|Repo|Store|Dao|DAO|Storage|Mapper|Querier|Queries)$/.test(name)) return 'dao';
  switch (layer) {
    case 'CONTROLLER':
      return 'controller';
    case 'SERVICE':
      return 'service';
    case 'DAO':
      return 'dao';
    case 'MODEL':
      return 'model';
    default:
      return 'other';
  }
}

interface FnCtx {
  f: FileInfo;
  ctx: Ctx;
  st: GoState;
  lineOf: (p: number) => number;
  imports: Map<string, string>;
  pkg: string;
  dir: string;
  unit: CodeUnit;
  method: MethodUnit;
  recv?: string;
  recvVar?: string;
  structFields: Record<string, string>;
  gormFile: boolean;
  pkgRouters: Map<string, string>; // 패키지 수준 라우터 변수 → 접두어
  fnName: string;
}

const BUILTINS = new Set(['len', 'cap', 'append', 'make', 'new', 'panic', 'recover', 'print', 'println', 'copy', 'delete', 'close', 'complex', 'real', 'imag', 'min', 'max', 'clear',
  'string', 'int', 'int64', 'int32', 'uint', 'uint64', 'float64', 'float32', 'byte', 'rune', 'bool', 'error', 'any', 'func', 'if', 'for', 'switch', 'return', 'go', 'defer', 'select', 'range']);

function addSql(fc: FnCtx, text: string, p: number): string | null {
  const s0 = text.replace(/%[-+# 0-9.*]*[sdvqfxXtT]/g, '${v}');
  if (!isSqlLike(s0)) return null;
  const parsed = parseSql(s0);
  if (!parsed.tables.length) return null;
  const s = fc.ctx.addSql({ file: fc.f.id, line: fc.lineOf(p), origin: 'string', kind: parsed.kind, tables: parsed.tables, ...(parsed.dynamic ? { dynamic: true } : {}), text: compactSql(s0) });
  fc.method.sql.push(s.id);
  return s.id;
}

/** 함수 본문 분석. a..b 는 본문 토큰 범위 */
function analyzeFn(t: GT[], a: number, b: number, fc: FnCtx, params: Record<string, string>, routerVars: Map<string, string>): void {
  const locals: Record<string, string> = { ...params };
  const tmplVars = new Map<string, string[]>();
  const used = new Set<string>();
  const consumed = new Set<number>();
  // 지역 변수 타입·라우터 변수
  for (let i = a; i < b - 2; i++) {
    const x = t[i];
    if (x.k === 'id' && x.v === 'var' && t[i + 1]?.k === 'id') {
      let e = i + 2;
      while (e < b && t[e].v !== '=' && lineOfTok(fc, t[e]) === lineOfTok(fc, t[i])) e++;
      const ty = baseType(t, i + 2, e);
      if (ty) locals[t[i + 1].v] = ty;
      continue;
    }
    if (x.k === 'id' && (t[i + 1]?.v === ':=' || (t[i + 1]?.v === '=' && t[i - 1]?.v !== '.'))) {
      const v = x.v;
      const r = i + 2;
      // x := &T{ / T{ / new(T)
      let q = r;
      if (t[q]?.v === '&') q++;
      if (t[q]?.k === 'id' && t[q + 1]?.v === '.' && t[q + 2]?.k === 'id' && t[q + 3]?.v === '{') locals[v] = t[q + 2].v;
      else if (t[q]?.k === 'id' && t[q + 1]?.v === '{' && /^[A-Z]/.test(t[q].v)) locals[v] = t[q].v;
      else if (t[q]?.v === 'new' && t[q + 1]?.v === '(') locals[v] = baseType(t, q + 2, closeOf(t, q + 1)) ?? locals[v];
      else if (t[q]?.v === 'make' && t[q + 1]?.v === '(') {
        const ar = argsOf(t, q + 1)[0];
        if (ar) locals[v] = baseType(t, ar[0], ar[1]) ?? locals[v];
      }
      // x := pkg.NewThing(...) → Thing
      else if (t[q]?.k === 'id' && t[q + 1]?.v === '.' && t[q + 2]?.k === 'id' && /^New[A-Z]/.test(t[q + 2].v) && t[q + 3]?.v === '(') {
        if (ROUTER_PKG.has(t[q].v) && ROUTER_CTOR.test(t[q + 2].v)) routerVars.set(v, '');
        else locals[v] = t[q + 2].v.replace(/^New/, '');
      } else if (t[q]?.k === 'id' && t[q + 1]?.v === '.' && t[q + 2]?.k === 'id' && t[q + 3]?.v === '(' && ROUTER_PKG.has(t[q].v) && ROUTER_CTOR.test(t[q + 2].v)) {
        routerVars.set(v, '');
      } else if (t[q]?.k === 'id' && /^New[A-Z]/.test(t[q].v) && t[q + 1]?.v === '(') {
        locals[v] = t[q].v.replace(/^New/, '');
      }
      // g := r.Group("/p") / r.PathPrefix("/p").Subrouter()
      if (t[q]?.k === 'id' && routerVars.has(t[q].v) && t[q + 1]?.v === '.' && (t[q + 2]?.v === 'Group' || t[q + 2]?.v === 'PathPrefix') && t[q + 3]?.v === '(') {
        const ar = argsOf(t, q + 3)[0];
        const p = ar ? strArg(t, ar) : null;
        if (p !== null) routerVars.set(v, joinPath(routerVars.get(t[q].v) ?? '', p));
      }
      // tmpl := template.Must(template.ParseFiles("a", "b"))
      if (t[q]?.v === 'template' || (t[q]?.k === 'id' && t[q + 2]?.v === 'ParseFiles')) {
        const files = parseFilesIn(t, q, Math.min(b, q + 40));
        if (files.length) tmplVars.set(v, files);
      }
    }
  }

  for (let i = a; i < b; i++) {
    const x = t[i];
    if (consumed.has(i)) continue;
    // 인라인 함수(func(c *gin.Context) {…})는 등록 지점에서 처리. 그 밖의 클로저 본문은 같은 메서드로 본다.
    // ---------------- 선택자 체인 / 호출
    if (x.k === 'id' && t[i - 1]?.v !== '.') {
      // 체인 이름들 a.b.c
      const names: string[] = [x.v];
      let j = i + 1;
      while (t[j]?.v === '.' && t[j + 1]?.k === 'id') {
        names.push(t[j + 1].v);
        j += 2;
      }
      if (t[j]?.v === '(') {
        const handled = handleCall(t, i, j, names, b, fc, locals, routerVars, tmplVars, consumed);
        if (handled > i) {
          i = handled;
          continue;
        }
        continue;
      }
      // 상수 참조 (패키지 수준 SQL 상수 후보)
      if (names.length === 1 && /^[A-Za-z_]\w*$/.test(x.v)) used.add(x.v);
      continue;
    }
    // ---------------- 문자열 SQL
    if (x.k === 'str') {
      let text = x.v;
      let k = i + 1;
      while (t[k]?.v === '+' && t[k + 1]?.k === 'str') {
        text += t[k + 1].v;
        consumed.add(k + 1);
        k += 2;
      }
      addSql(fc, text, x.p);
      continue;
    }
  }
  fc.st.constRefs.push({ method: fc.method, dir: fc.dir, names: used });
}

function lineOfTok(fc: FnCtx, x: GT): number {
  return fc.lineOf(x.p);
}

function joinPath(prefix: string, p: string): string {
  const s = `${prefix.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
  return s.length > 1 ? s.replace(/\/$/, '') : s;
}

function parseFilesIn(t: GT[], a: number, b: number): string[] {
  for (let i = a; i < b; i++) {
    if (t[i].k === 'id' && (t[i].v === 'ParseFiles' || t[i].v === 'ParseGlob') && t[i + 1]?.v === '(') {
      const out: string[] = [];
      for (const ar of argsOf(t, i + 1)) {
        const s = strArg(t, ar);
        if (s && !s.includes('*')) out.push(s);
      }
      return out;
    }
  }
  return [];
}

/** 호출 처리. 반환: 건너뛸 마지막 토큰 위치(처리 안 했으면 start) */
function handleCall(
  t: GT[], start: number, open: number, names: string[], end: number, fc: FnCtx,
  locals: Record<string, string>, routerVars: Map<string, string>, tmplVars: Map<string, string[]>, consumed: Set<number>,
): number {
  const m = names[names.length - 1];
  const recvExpr = names.slice(0, -1);
  const line = fc.lineOf(t[start].p);
  const args = argsOf(t, open);
  const close = closeOf(t, open);
  const root = names[0];

  // ---------------- 라우터 등록
  const routerPrefix = (): string | null => {
    if (!recvExpr.length) return null;
    const r0 = recvExpr.join('.');
    if (routerVars.has(r0)) return routerVars.get(r0)!;
    if (recvExpr.length === 1 && fc.pkgRouters.has(r0)) return fc.pkgRouters.get(r0)!;
    if (recvExpr.length === 1 && r0 === 'http') return '';
    // s.router.GET: 구조체 필드 타입이 라우터
    if (recvExpr.length === 2 && recvExpr[0] === fc.recvVar) {
      const ft = fc.structFields[recvExpr[1]] ?? '';
      if (ROUTER_TYPES.test(ft)) return '';
    }
    return null;
  };
  const pfx = routerPrefix();
  if (pfx !== null) {
    const addRoute = (method: string, rawPath: string, handlerRange: [number, number] | undefined) => {
      let path = rawPath;
      let meth = method;
      const pm = /^([A-Z]+)\s+(\S+)$/.exec(rawPath.trim());
      if (pm) {
        meth = pm[1];
        path = pm[2];
      }
      path = path.replace(/^[^/]*(?=\/)/, '');
      const full = joinPath(pfx, path || '/');
      const pr: PendingRoute = { method: meth, path: full || '/', line, file: fc.f.id, handler: null, dir: fc.dir };
      if (handlerRange) {
        const h = resolveHandler(t, handlerRange, fc, locals);
        if (h === 'inline') {
          // func(c *gin.Context) { … } → 합성 메서드
          let o = handlerRange[0];
          while (o < handlerRange[1] && t[o].v !== '{') {
            if (t[o].v === '(') o = closeOf(t, o);
            o++;
          }
          const im: MethodUnit = { name: `func@${line}`, line, routes: [], calls: [], sql: [], statements: [], views: [] };
          if (o < handlerRange[1]) {
            const sub: FnCtx = { ...fc, method: im };
            const params = paramTypes(t, handlerRange[0] + 1, fc);
            analyzeFn(t, o + 1, closeOf(t, o), sub, params, new Map(routerVars));
            for (let k = handlerRange[0]; k < handlerRange[1]; k++) consumed.add(k);
          }
          fc.unit.methods.push(im);
          pr.inline = im;
        } else pr.handler = h;
      }
      fc.st.routes.push(pr);
      // 라우터 매개변수로 받은 경우: 접두어는 호출하는 쪽에서
      if (routerVars.get(`__param:${recvExpr.join('.')}`) !== undefined) {
        const rp = fc.st.routerParams.find((x) => x.fn === fc.fnName && x.dir === fc.dir && x.param === recvExpr.join('.'));
        if (rp) rp.routes.push(pr);
      }
    };
    if (VERBS[m] && args.length >= 1) {
      const p = strArg(t, args[0]);
      if (p !== null) addRoute(VERBS[m], p, args[args.length - 1] && args.length > 1 ? args[args.length - 1] : undefined);
      return close;
    }
    if ((m === 'Handle' || m === 'Add' || m === 'Method' || m === 'MethodFunc') && args.length >= 3 && t[args[0][0]].k === 'str') {
      const p = strArg(t, args[1]);
      if (p !== null) addRoute(t[args[0][0]].v.toUpperCase(), p, args[args.length - 1]);
      return close;
    }
    if ((m === 'HandleFunc' || m === 'Handle') && args.length >= 2) {
      const p = strArg(t, args[0]);
      if (p !== null) {
        // .Methods("GET")
        let meth = '*';
        if (t[close + 1]?.v === '.' && t[close + 2]?.v === 'Methods' && t[close + 3]?.v === '(') {
          const ma = argsOf(t, close + 3)[0];
          const s = ma ? strArg(t, ma) : null;
          if (s) meth = s.toUpperCase();
        }
        addRoute(meth, p, args[1]);
      }
      return close;
    }
    if ((m === 'Route' || m === 'Group') && args.length >= 1) {
      // chi: r.Route("/p", func(r chi.Router) {…}) / r.Group(func(r chi.Router) {…})
      const p = m === 'Route' ? strArg(t, args[0]) : '';
      const fnArg = args[args.length - 1];
      if (p !== null && t[fnArg[0]]?.v === 'func') {
        const pOpen = fnArg[0] + 1;
        const pname = t[pOpen + 1]?.k === 'id' ? t[pOpen + 1].v : null;
        let o = closeOf(t, pOpen) + 1;
        while (o < fnArg[1] && t[o].v !== '{') o++;
        if (pname && o < fnArg[1]) {
          const sub = new Map(routerVars);
          sub.set(pname, joinPath(pfx, p));
          const bodyClose = closeOf(t, o);
          analyzeFn(t, o + 1, bodyClose, fc, {}, sub);
          return close;
        }
      }
      if (m === 'Group' && p !== null) return close; // gin/echo Group(): 대입에서 처리
    }
    if (m === 'Static' || m === 'StaticFS' || m === 'StaticFile' || m === 'Use' || m === 'LoadHTMLGlob' || m === 'LoadHTMLFiles' || m === 'Run' || m === 'Listen' || m === 'Start' || m === 'Mount' || m === 'NotFound') return close;
  }

  // ---------------- 라우터를 다른 함수에 넘김: setupRoutes(api)
  for (let ai = 0; ai < args.length; ai++) {
    const [p0, p1] = args[ai];
    if (p1 - p0 === 1 && t[p0].k === 'id' && routerVars.has(t[p0].v) && !routerVars.has(`__param:${t[p0].v}`)) {
      fc.st.routerArgs.push({ fn: m, ...(recvExpr.length ? { via: recvExpr[recvExpr.length - 1] } : {}), idx: ai, prefix: routerVars.get(t[p0].v)! });
    } else if (p1 - p0 === 1 && t[p0].k === 'id' && routerVars.has(t[p0].v)) {
      fc.st.routerArgs.push({ fn: m, idx: ai, prefix: routerVars.get(t[p0].v)! });
    }
  }

  // ---------------- 화면: c.HTML / c.Render / ExecuteTemplate / tmpl.Execute
  if ((m === 'HTML' && args.length >= 2) || (m === 'Render' && args.length >= 1) || (m === 'ExecuteTemplate' && args.length >= 2)) {
    const idx = m === 'Render' && args.length === 2 ? 0 : 1;
    const s = args[idx] ? strArg(t, args[idx]) : null;
    if (s) fc.method.views.push(s);
  }
  if (m === 'Execute' && recvExpr.length === 1 && tmplVars.has(recvExpr[0])) fc.method.views.push(...tmplVars.get(recvExpr[0])!);

  // ---------------- GORM 체인
  if (fc.gormFile && recvExpr.length && (GORM_CHAIN.has(m) || GORM_READ.has(m) || GORM_WRITE[m] || m === 'Raw' || m === 'Exec')) {
    const last = recvExpr[recvExpr.length - 1];
    const dbish = /^(db|tx|gdb|gormdb|orm|database|conn|engine|dbconn|gorm|mysql|session)$/i.test(last) || (fc.structFields[last] ?? '') === 'gorm.DB' || (locals[last] ?? '') === 'DB';
    if (dbish) return gormChain(t, start, open, m, end, fc, locals, consumed);
  }

  // ---------------- 일반 호출 → CallRef
  if (recvExpr.length === 0) {
    if (!BUILTINS.has(m) && !/^[A-Z][a-z]*$/.test(m) && m !== 'func') fc.method.calls.push({ via: `this.${fc.pkg}`, method: m, line });
    if (!BUILTINS.has(m) && /^[A-Z]/.test(m)) fc.method.calls.push({ via: `this.${fc.pkg}`, method: m, line });
  } else if (recvExpr.length === 1) {
    if (root === fc.recvVar && fc.recv) fc.method.calls.push({ via: `this.${fc.recv}`, method: m, line });
    else if (fc.imports.has(root)) {
      const imp = fc.imports.get(root)!;
      const pkgName = imp.split('/').filter((s) => !/^v\d+$/.test(s)).pop() ?? root;
      if (dirOfImport(fc.st, imp) !== null) fc.method.calls.push({ via: pkgName, method: m, line });
    } else if (locals[root]) fc.method.calls.push({ via: locals[root], method: m, line });
    else if (fc.structFields[root]) fc.method.calls.push({ via: root, method: m, line });
    else fc.method.calls.push({ via: root, method: m, line });
  } else {
    // a.b.M → via b (필드)
    const via = recvExpr[recvExpr.length - 1];
    if (recvExpr[0] === fc.recvVar || fc.imports.has(recvExpr[0]) || locals[recvExpr[0]]) fc.method.calls.push({ via, method: m, line });
    else fc.method.calls.push({ via, method: m, line });
  }
  return start;
}

function paramTypes(t: GT[], open: number, fc: FnCtx): Record<string, string> {
  const out: Record<string, string> = {};
  void fc;
  const pending: string[] = [];
  for (const [a, b] of argsOf(t, open)) {
    const ids = t.slice(a, b);
    if (ids.length === 1 && ids[0].k === 'id') {
      pending.push(ids[0].v);
      continue;
    }
    if (ids[0]?.k === 'id' && ids.length > 1) {
      const ty = baseType(t, a + 1, b);
      if (ty) {
        out[ids[0].v] = ty;
        for (const p of pending) out[p] = ty;
      }
      pending.length = 0;
    }
  }
  return out;
}

type HandlerRef = PendingRoute['handler'];

function resolveHandler(t: GT[], [a, b]: [number, number], fc: FnCtx, locals: Record<string, string>): HandlerRef | 'inline' {
  if (t[a]?.v === 'func') return 'inline';
  // 감싼 호출: http.HandlerFunc(x), mw(h.List) → 안쪽 마지막 인자
  let s = a;
  let e = b;
  for (let guard = 0; guard < 4; guard++) {
    let j = s;
    while (j < e && (t[j].k === 'id' || t[j].v === '.')) j++;
    if (t[j]?.v === '(' && closeOf(t, j) === e - 1) {
      const inner = argsOf(t, j);
      if (!inner.length) break;
      [s, e] = inner[inner.length - 1];
      if (t[s]?.v === 'func') return 'inline';
      continue;
    }
    break;
  }
  const names: string[] = [];
  for (let j = s; j < e; j++) {
    if (t[j].k === 'id') names.push(t[j].v);
    else if (t[j].v !== '.' && t[j].v !== '&' && t[j].v !== '*') break;
  }
  if (!names.length) return null;
  const name = names[names.length - 1];
  if (names.length === 1) return { name, dir: fc.dir };
  const head = names[0];
  if (names.length === 2 && fc.imports.has(head)) {
    const dir = dirOfImport(fc.st, fc.imports.get(head)!) ?? '';
    return { name, pkg: head, dir };
  }
  const recvType = names.length === 2 ? locals[head] ?? (head === fc.recvVar ? fc.recv : undefined) : fc.structFields[names[names.length - 2]] ?? undefined;
  return { name, ...(recvType ? { recv: recvType } : {}), via: names[names.length - 2], dir: fc.dir };
}

function gormChain(t: GT[], start: number, firstOpen: number, firstName: string, end: number, fc: FnCtx, locals: Record<string, string>, consumed: Set<number>): number {
  const calls: { name: string; open: number }[] = [{ name: firstName, open: firstOpen }];
  let k = closeOf(t, firstOpen) + 1;
  while (k + 2 < end && t[k].v === '.' && t[k + 1].k === 'id' && t[k + 2].v === '(') {
    calls.push({ name: t[k + 1].v, open: k + 2 });
    k = closeOf(t, k + 2) + 1;
  }
  let table: string | undefined;
  let type: string | undefined;
  const crud = new Set<Crud>();
  const joins: string[] = [];
  let raw = false;
  const typeOfArg = (ar: [number, number] | undefined): string | undefined => {
    if (!ar) return undefined;
    let [a, b] = ar;
    if (t[a]?.v === '&') a++;
    if (t[a]?.k === 'id' && t[a + 1]?.v === '.' && t[a + 2]?.k === 'id' && t[a + 3]?.v === '{') return t[a + 2].v;
    if (t[a]?.k === 'id' && t[a + 1]?.v === '{') return t[a].v;
    if (t[a]?.v === '[' && t[a + 1]?.v === ']') return baseType(t, a + 2, b) ?? undefined;
    if (t[a]?.k === 'id' && b - a === 1) return locals[t[a].v];
    if (t[a]?.v === 'new' && t[a + 1]?.v === '(') return baseType(t, a + 2, closeOf(t, a + 1)) ?? undefined;
    return undefined;
  };
  for (const c of calls) {
    const args = argsOf(t, c.open);
    if (c.name === 'Table') {
      const s = args[0] ? strArg(t, args[0]) : null;
      if (s) table = s.trim().split(/\s+/)[0].replace(/[`"]/g, '');
    } else if (c.name === 'Model') {
      type = typeOfArg(args[0]) ?? type;
    } else if (c.name === 'Joins' || c.name === 'InnerJoins') {
      const s = args[0] ? strArg(t, args[0]) : null;
      const jm = s ? /\bJOIN\s+[`"]?(\w+)/i.exec(s) : null;
      if (jm) joins.push(jm[1]);
    } else if (c.name === 'Raw' || c.name === 'Exec') {
      raw = true;
      const s = args[0] ? strArg(t, args[0]) : null;
      if (s) {
        addSql(fc, s, t[args[0][0]].p);
        for (let j = args[0][0]; j < args[0][1]; j++) consumed.add(j);
      }
    } else if (GORM_READ.has(c.name)) {
      crud.add('R');
      if (!type && c.name !== 'Count' && c.name !== 'Pluck' && c.name !== 'Row' && c.name !== 'Rows') type = typeOfArg(args[0]);
    } else if (GORM_WRITE[c.name]) {
      for (const x of GORM_WRITE[c.name]) crud.add(x);
      if (!type) type = typeOfArg(args[0]);
    }
  }
  if (!raw && crud.size && (table || type)) {
    fc.st.gorm.push({
      method: fc.method, ...(type ? { type } : {}), ...(table ? { table } : {}), crud: (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => crud.has(c)), joins,
      file: fc.f.id, line: fc.lineOf(t[start].p), desc: `${t.slice(start, firstOpen).map((x) => x.v).join('')}…${calls.map((c) => c.name).join('().')}() (GORM)`,
    });
    fc.ctx.hit('데이터 접근', 'GORM', fc.f.id, fc.lineOf(t[start].p), 1);
  }
  return k - 1;
}

function analyzeGoFile(f: FileInfo, text: string, ctx: Ctx, st: GoState): void {
  const t = lexGo(text);
  const lineOf = makeLineIndex(text);
  const dir = dirName(f.path);
  let pkg = 'main';
  for (let i = 0; i < t.length - 1; i++) if (t[i].v === 'package' && t[i + 1].k === 'id') {
    pkg = t[i + 1].v;
    break;
  }
  const imports = parseImports(t);
  const gormFile = [...imports.values()].some((p) => /gorm\.io\/gorm|jinzhu\/gorm/.test(p));
  parseStructs(t, f, dir, lineOf, st);
  // 패키지 수준 SQL 상수·라우터 변수
  const pkgRouters = new Map<string, string>();
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.k === 'op' && (x.v === '{' || x.v === '(' || x.v === '[')) depth++;
    else if (x.k === 'op' && (x.v === '}' || x.v === ')' || x.v === ']')) depth--;
    if (x.k === 'id' && (x.v === 'const' || x.v === 'var') && depth === 0) {
      const grouped = t[i + 1]?.v === '(';
      const end = grouped ? closeOf(t, i + 1) : Math.min(t.length, i + 60);
      for (let j = grouped ? i + 2 : i + 1; j < end; j++) {
        if (t[j].k !== 'id' || t[j - 1]?.v === '.') continue;
        // name [Type] = value
        let e = j + 1;
        while (e < end && t[e].v !== '=' && t[e].k !== 'str' && lineOf(t[e].p) === lineOf(t[j].p)) e++;
        if (t[e]?.v !== '=') continue;
        const v0 = e + 1;
        if (t[v0]?.k === 'str') {
          let s = t[v0].v;
          let q = v0 + 1;
          while (t[q]?.v === '+' && t[q + 1]?.k === 'str') {
            s += t[q + 1].v;
            q += 2;
          }
          const s0 = s.replace(/%[-+# 0-9.*]*[sdvqfxXtT]/g, '${v}');
          if (isSqlLike(s0)) {
            const parsed = parseSql(s0);
            if (parsed.tables.length) {
              const sq = ctx.addSql({ file: f.id, line: lineOf(t[v0].p), origin: 'string', kind: parsed.kind, tables: parsed.tables, ...(parsed.dynamic ? { dynamic: true } : {}), text: compactSql(s0) });
              st.consts.set(`${dir}|${t[j].v}`, sq.id);
            }
          }
          j = q - 1;
          if (!grouped) break;
          continue;
        }
        // var r = gin.Default()
        if (t[v0]?.k === 'id' && ROUTER_PKG.has(t[v0].v) && t[v0 + 1]?.v === '.' && ROUTER_CTOR.test(t[v0 + 2]?.v ?? '')) pkgRouters.set(t[j].v, '');
        if (!grouped) break;
      }
      if (!grouped) continue;
      i = end;
      depth = 0;
      continue;
    }
  }
  // 함수
  const fns = parseFuncs(t);
  for (const fn of fns) {
    const recvStruct = fn.recv ? (st.structs.get(fn.recv) ?? []).find((s) => s.dir === dir) : undefined;
    const key = fn.recv ?? `<pkg>`;
    const name = fn.recv ?? pkg;
    const unit = unitFor(ctx, st, f, key, name, kindOf(fn.recv ?? '', f.layer), lineOf(t[fn.at].p));
    if (recvStruct) Object.assign(unit.fields, recvStruct.fields);
    const m: MethodUnit = { name: fn.name, line: lineOf(t[fn.at].p), endLine: lineOf(t[fn.bodyClose].p), routes: [], calls: [], sql: [], statements: [], views: [] };
    // TableName() string { return "x" }
    if (fn.name === 'TableName' && fn.recv) {
      for (let k = fn.bodyOpen; k < fn.bodyClose; k++) if (t[k].v === 'return' && t[k + 1]?.k === 'str') st.tableNames.set(fn.recv, t[k + 1].v);
    }
    const params = fn.paramsOpen ? paramTypesSimple(t, fn.paramsOpen) : {};
    const routerVars = new Map<string, string>();
    // 라우터 타입 매개변수: 접두어는 호출부에서 정해진다
    argsOf(t, fn.paramsOpen).forEach(([a, b], idx) => {
      const ids = t.slice(a, b);
      const typeText = ids.map((x) => x.v).join('');
      if (ids[0]?.k === 'id' && /(gin\.(Engine|RouterGroup|IRouter|IRoutes)|echo\.(Echo|Group)|fiber\.(App|Router)|chi\.(Router|Mux)|mux\.Router|http\.ServeMux)/.test(typeText)) {
        routerVars.set(ids[0].v, '');
        routerVars.set(`__param:${ids[0].v}`, '');
        st.routerParams.push({ fn: fn.name, dir, ...(fn.recv ? { recv: fn.recv } : {}), idx, param: ids[0].v, routes: [] });
      }
    });
    const fc: FnCtx = {
      f, ctx, st, lineOf, imports, pkg, dir, unit, method: m, ...(fn.recv ? { recv: fn.recv } : {}), ...(fn.recvVar ? { recvVar: fn.recvVar } : {}),
      structFields: recvStruct?.fields ?? {}, gormFile: gormFile || Object.values(recvStruct?.fields ?? {}).includes('gorm.DB'), pkgRouters, fnName: fn.name,
    };
    analyzeFn(t, fn.bodyOpen + 1, fn.bodyClose, fc, params, routerVars);
    unit.methods.push(m);
  }
  if ([...imports.values()].some((p) => /gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux/.test(p))) {
    // detect.ts 가 import 근거를 이미 남김
  }
}

function paramTypesSimple(t: GT[], open: number): Record<string, string> {
  const out: Record<string, string> = {};
  const pending: string[] = [];
  for (const [a, b] of argsOf(t, open)) {
    const ids = t.slice(a, b);
    if (ids.length === 1 && ids[0].k === 'id') {
      pending.push(ids[0].v);
      continue;
    }
    if (ids[0]?.k === 'id' && ids.length > 1) {
      const ty = baseType(t, a + 1, b);
      if (ty) {
        out[ids[0].v] = ty;
        for (const p of pending) out[p] = ty;
      }
      pending.length = 0;
    }
  }
  return out;
}

// ------------------------------------------------------------------ 템플릿 화면

function analyzeTemplate(f: FileInfo, text: string, ctx: Ctx, st: GoState): void {
  const lineOf = makeLineIndex(text);
  const defines = [...text.matchAll(/\{\{-?\s*define\s+"([^"]+)"/g)].map((m) => m[1]);
  const uses = [...text.matchAll(/\{\{-?\s*(?:template|block)\s+"([^"]+)"/g)].map((m) => m[1]);
  const flat = text.replace(/\{\{[\s\S]*?\}\}/g, (x) => (x.length >= 3 && !/\n/.test(x.slice(0, 3)) ? `{x}${x.slice(3).replace(/[^\n]/g, ' ')}` : x.replace(/[^\n]/g, ' ')));
  const view: ViewFact = { file: f.id, kind: 'template', urls: [], includes: [], scripts: [] };
  const title = extractTitle(flat);
  if (title) {
    view.title = title.title;
    view.titleLine = lineOf(title.offset);
  }
  for (const r of extractRefs(flat)) {
    const n = normalizeRef(r.url, '/');
    if (!n) continue;
    const u: UrlRef = { url: n, kind: r.kind, file: f.id, line: lineOf(r.offset), ...(r.method ? { method: r.method } : {}) };
    view.urls.push(u);
  }
  // 정의만 있는 파일(define 블록 밖에 내용이 거의 없음)은 조각
  const outside = text.replace(/\{\{-?\s*define[\s\S]*?\{\{-?\s*end\s*-?\}\}/g, '').trim();
  if (defines.length && outside.length < 20) view.fragment = true;
  if (/^(header|footer|nav|navbar|menu|sidebar|layout|base|head|partials?)\b/i.test(f.name) || /\/(partials?|layouts?|includes?|components)\//i.test(f.path)) view.fragment = true;
  ctx.facts.views.push(view);
  st.templates.set(f.id, { view, file: f, defines, uses });
  f.layer = 'VIEW';
  ctx.hit('화면', 'Go 템플릿', f.id, 1, 0.5);
}

// ------------------------------------------------------------------ 마무리

function finishGo(ctx: Ctx, st: GoState): void {
  const unitsByDir = new Map<string, CodeUnit[]>();
  for (const u of st.units.values()) {
    const f = ctx.byId.get(u.file);
    if (!f) continue;
    const d = dirName(f.path);
    unitsByDir.set(d, [...(unitsByDir.get(d) ?? []), u]);
  }
  // 수신 타입 유닛에 구조체 필드 채우기
  for (const [d, list] of unitsByDir) {
    for (const u of list) {
      const def = (st.structs.get(u.name) ?? []).find((s) => s.dir === d);
      if (def) for (const [k, v] of Object.entries(def.fields)) if (!u.fields[k]) u.fields[k] = v;
    }
  }
  // 라우터 매개변수 접두어: 호출부에서 넘긴 그룹
  for (const rp of st.routerParams) {
    const prefixes = st.routerArgs.filter((a) => a.fn === rp.fn && a.idx === rp.idx).map((a) => a.prefix);
    const uniq = [...new Set(prefixes)].filter((p) => p !== '');
    if (!uniq.length) continue;
    for (const r of rp.routes) {
      const orig = r.path;
      r.path = joinPath(uniq[0], orig);
      for (const extra of uniq.slice(1)) st.routes.push({ ...r, path: joinPath(extra, orig) });
    }
  }
  // 라우트 → 핸들러 메서드
  const allUnits = [...st.units.values()];
  for (const r of st.routes) {
    let target: MethodUnit | undefined;
    if (r.inline) target = r.inline;
    else if (r.handler) {
      const h = r.handler;
      const cands: { u: CodeUnit; m: MethodUnit }[] = [];
      for (const u of allUnits) {
        const f = ctx.byId.get(u.file);
        if (!f) continue;
        const d = dirName(f.path);
        for (const m of u.methods) {
          if (m.name !== h.name) continue;
          if (h.recv && u.name === h.recv) cands.push({ u, m });
          else if (!h.recv && h.pkg && d === h.dir && u.name !== h.recv) cands.push({ u, m });
          else if (!h.recv && !h.pkg && !h.via && d === h.dir) cands.push({ u, m });
        }
      }
      if (!cands.length) {
        // 타입을 모르면 메서드 이름이 하나뿐일 때만
        const byName: { u: CodeUnit; m: MethodUnit }[] = [];
        for (const u of allUnits) for (const m of u.methods) if (m.name === h.name) byName.push({ u, m });
        const ctrl = byName.filter((x) => x.u.kind === 'controller');
        if (byName.length === 1) cands.push(byName[0]);
        else if (ctrl.length === 1) cands.push(ctrl[0]);
      }
      target = cands[0]?.m;
    }
    if (!target) continue;
    if (!target.routes.some((x) => x.path === r.path && x.method === r.method)) {
      target.routes.push({ method: r.method, path: r.path, line: target.line, ...(target.views.length ? {} : { api: true }) });
    }
  }
  // 패키지 수준 SQL 상수 참조
  for (const ref of st.constRefs) {
    for (const n of ref.names) {
      const id = st.consts.get(`${ref.dir}|${n}`);
      if (id && !ref.method.sql.includes(id)) ref.method.sql.push(id);
    }
  }
  // GORM 연산 → SQL (모델 테이블)
  const tableOf = (type: string): string => st.tableNames.get(type) ?? snakePlural(type);
  for (const op of st.gorm) {
    const table = op.table ?? (op.type ? tableOf(op.type) : undefined);
    if (!table) continue;
    const tables: TableRef[] = op.crud.map((c) => ({ name: table, crud: c }));
    for (const j of op.joins) tables.push({ name: j, crud: 'R' });
    const crud = new Set(op.crud);
    const kind = crud.has('C') ? 'insert' : crud.has('U') ? 'update' : crud.has('D') ? 'delete' : 'select';
    const s = ctx.addSql({ file: op.file, line: op.line, origin: 'orm', kind, tables, text: op.desc });
    op.method.sql.push(s.id);
  }
  // 모델 구조체 → 유닛(kind model, table)
  const modelTypes = new Set<string>([...st.tableNames.keys(), ...st.gorm.map((g) => g.type).filter((x): x is string => !!x)]);
  for (const name of modelTypes) {
    for (const def of st.structs.get(name) ?? []) {
      const existing = allUnits.find((u) => u.name === name && ctx.byId.get(u.file)?.path && dirName(ctx.byId.get(u.file)!.path) === def.dir);
      if (existing) {
        existing.kind = 'model';
        existing.table = tableOf(name);
      } else {
        ctx.addUnit({ file: def.file, name, kind: 'model', line: def.line, extendsOrImplements: [], fields: def.fields, methods: [], table: tableOf(name) });
      }
      const f = ctx.byId.get(def.file);
      if (f && f.layer === 'OTHER') f.layer = 'MODEL';
    }
  }
  // 템플릿 include: {{template "x"}} → 정의한 파일 또는 같은 이름 파일
  const defIndex = new Map<string, FileInfo>();
  for (const x of st.templates.values()) {
    for (const d of x.defines) defIndex.set(d, x.file);
    defIndex.set(x.file.name, x.file);
  }
  for (const x of st.templates.values()) {
    for (const u of x.uses) {
      const target = defIndex.get(u) ?? defIndex.get(baseName(u));
      if (target && target.id !== x.file.id) {
        x.view.includes.push(target.path);
        const tv = st.templates.get(target.id);
        if (tv && tv.defines.length) tv.view.fragment = true;
      }
    }
  }
}

export const goAnalyzer: Analyzer = {
  name: 'go',
  order: 26,
  accepts: (f) => f.lang === 'Go' || f.lang === 'HTML' || f.lang === 'Template',
  analyze(f, text, ctx) {
    const st = state(ctx);
    if (f.lang === 'Go') {
      if (f.layer === 'TEST') return;
      analyzeGoFile(f, text, ctx, st);
      return;
    }
    // 템플릿: Go 프로젝트 안의 templates·views 폴더 또는 .tmpl/.gohtml
    if (!inGoProject(st, f.path)) return;
    if (!(/\.(tmpl|gohtml|tpl)$/i.test(f.name) || /(^|\/)(templates?|views|web|html)\//i.test(f.path))) return;
    analyzeTemplate(f, text, ctx, st);
  },
  finish(ctx) {
    const st = states.get(ctx);
    if (st) finishGo(ctx, st);
  },
};
