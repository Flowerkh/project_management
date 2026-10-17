// Go 분석기: Gin·Echo·Fiber·chi·gorilla/mux·net/http 라우트, 핸들러 → 서비스 → 저장소 호출,
// database/sql·sqlx 문자열 SQL(상수 포함), GORM 체인, html/template 화면.
// 2단계로 돈다: 파일마다 선언·호출·라우트를 모으고(analyze), 끝에서(finish) 타입을 풀어 잇는다.
// 풀린 호출은 via 에 대상 유닛의 fqn(go:<파일ID>#<타입>)을 넣어 연결 단계가 이름 추측 없이 따라가게 한다.
import type { Analyzer, Ctx } from '../context';
import type { CodeUnit, Crud, FileInfo, MethodUnit, SqlFact, TableRef, UrlRef, ViewFact } from '../types';
import { baseName, dirName, makeLineIndex } from '../files';
import { compactSql, isSqlLike, parseSql } from '../sql';
import { pluralLast, singularLast, snakeCase } from './inflect';
import { extractRefs, extractTitle, normalizeRef } from './web-refs';

// ------------------------------------------------------------------ 토큰

type GK = 'id' | 'str' | 'num' | 'op' | 'char';
interface GT {
  k: GK;
  v: string;
  p: number;
}

const GO_OPS = ['<<=', '>>=', '&^=', '...', '&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^'];

export function lexGo(src: string): GT[] {
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
      out.push({ k: 'str', v: src.slice(i + 1, e), p: i });
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
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9_]*\.?[0-9_]+([eE][+-]?\d+)?i?)/.exec(src.slice(i, i + 40));
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

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

function closeOf(t: GT[], i: number): number {
  if (t[i]?.k !== 'op' || !OPEN.has(t[i].v)) return i;
  let d = 0;
  for (let j = i; j < t.length; j++) {
    if (t[j].k !== 'op') continue;
    if (OPEN.has(t[j].v)) d++;
    else if (CLOSE.has(t[j].v)) {
      d--;
      if (!d) return j;
    }
  }
  return t.length - 1;
}

/** 범위 [a,b) 를 최상위 콤마로 나누기 */
function splitRange(t: GT[], a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  let s = a;
  let d = 0;
  for (let j = a; j < b; j++) {
    if (t[j].k !== 'op') continue;
    if (OPEN.has(t[j].v)) d++;
    else if (CLOSE.has(t[j].v)) d--;
    else if (t[j].v === ',' && !d) {
      out.push([s, j]);
      s = j + 1;
    }
  }
  if (s < b) out.push([s, b]);
  return out;
}

/** 괄호 안 인자 범위들 [시작, 끝) */
const argsOf = (t: GT[], open: number): [number, number][] => splitRange(t, open + 1, closeOf(t, open));

/** 문자열 리터럴(+ 연결) 값. 문자열이 하나도 없으면 null */
function strArg(t: GT[], [a, b]: [number, number]): string | null {
  let s = '';
  let any = false;
  for (let j = a; j < b; j++) {
    if (t[j].k === 'str') {
      s += t[j].v;
      any = true;
    } else if (t[j].v === '+' || t[j].v === '(' || t[j].v === ')') continue;
    else if (!s.endsWith('${v}')) s += '${v}';
  }
  return any ? s : null;
}

const isLit = (t: GT[], [a, b]: [number, number]) => b - a === 1 && t[a].k === 'str';

// ------------------------------------------------------------------ 타입·식

interface TRef {
  dir: string;
  name: string;
  ext?: boolean;
  /** 외부 타입의 import 경로 (gorm.io/gorm 등) */
  path?: string;
}
const EXT: TRef = { dir: '', name: '?', ext: true };

interface CallDesc {
  recv: Expr;
  name: string;
  line: number;
  /** 인자 중 문자열 리터럴 (화면 이름을 넘기는 render 도우미용) */
  strArgs?: (string | null)[];
  /** GORM 체인 후보의 첫 호출: 풀리지 않으면 이름 추측도 하지 않음 */
  gorm?: boolean;
  /** for _, f := range 슬라이스 { f(…) }: 슬라이스(dir|이름)에 담긴 함수들을 부름 */
  slice?: string;
}

type Expr =
  | { k: 'type'; t: TRef | null }
  | { k: 'pkg'; dir: string }
  | { k: 'pvar'; dir: string; name: string }
  | { k: 'call'; c: CallDesc }
  | { k: 'sel'; base: Expr; name: string };

const UNKNOWN: Expr = { k: 'type', t: null };

const BUILTIN_TYPES = new Set(['string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'bool', 'byte', 'rune',
  'float32', 'float64', 'complex64', 'complex128', 'error', 'any', 'comparable']);
const BUILTIN_FNS = new Set(['len', 'cap', 'append', 'make', 'new', 'panic', 'recover', 'print', 'println', 'copy', 'delete', 'close', 'complex', 'real', 'imag', 'min', 'max', 'clear',
  ...BUILTIN_TYPES, 'func', 'if', 'for', 'switch', 'return', 'go', 'defer', 'select', 'range', 'case', 'else', 'struct', 'interface', 'map', 'chan', 'type', 'var', 'const']);

interface FileCtx {
  f: FileInfo;
  st: GoState;
  dir: string;
  pkg: string;
  imports: Map<string, string>;
  lineOf: (p: number) => number;
  usesGorm: boolean;
  usesSql: string | null;
}

interface FnDecl {
  name: string;
  recv?: string;
  recvVar?: string;
  fc: FileCtx;
  method: MethodUnit;
  result: TRef | null;
  calls: CallDesc[];
  params: { name: string; t: TRef | null }[];
  viewParams: { idx: number; prefix: string; suffix: string }[];
  retRouter?: RouterObj;
  inlineOf?: FnDecl;
  unit?: CodeUnit;
  usedIds: Set<string>;
  usedQual: Set<string>;
}

interface StructDef {
  name: string;
  dir: string;
  file: FileInfo;
  line: number;
  fields: Map<string, TRef | null>;
  embedded: TRef[];
  tagged: boolean;
}

interface IfaceDef {
  name: string;
  dir: string;
  methods: Set<string>;
  embeds: TRef[];
}

interface RouterObj {
  parent?: RouterObj;
  prefix: string;
  fw: string;
  param?: { decl: FnDecl; idx: number };
  owner?: FnDecl;
  mounts: { router: RouterObj; prefix: string }[];
}

interface RouteReg {
  router: RouterObj;
  method: string;
  path: string;
  handler?: CallDesc;
  /** 감싼 호출 mw(x)·팩토리 listOrders(svc) 의 바깥 함수 (안쪽이 안 풀릴 때) */
  factory?: CallDesc;
  inline?: FnDecl;
}

interface GormOp {
  decl: FnDecl;
  recv: Expr;
  model?: Expr;
  table?: string;
  crud: Crud[];
  joins: string[];
  preloads: string[];
  line: number;
  desc: string;
}

interface Tmpl {
  view: ViewFact;
  file: FileInfo;
  defines: string[];
  uses: string[];
  /** define 블록 밖에 내용이 거의 없음 */
  onlyDefines: boolean;
}

interface GoState {
  modules: { dir: string; path: string }[];
  rootName: string;
  goDirs: Set<string>;
  usesGorm: boolean;
  decls: FnDecl[];
  structs: Map<string, StructDef>;
  ifaces: Map<string, IfaceDef>;
  aliases: Map<string, TRef>;
  tableNames: Map<string, string>;
  pkgVars: Map<string, Expr>;
  pkgRouters: Map<string, RouterObj>;
  pkgTmpl: Map<string, string[]>;
  consts: Map<string, string[]>;
  routes: RouteReg[];
  routerArgs: { call: CallDesc; idx: number; router: RouterObj }[];
  mountSites: { call: CallDesc; router: RouterObj; prefix: string }[];
  gorm: GormOp[];
  migrate: Expr[];
  templates: Map<string, Tmpl>;
  httpRoot: RouterObj;
  fieldRouters: Map<string, RouterObj>;
  importDirs: Map<string, string | null>;
  sqlFiles: Set<FileInfo>;
  /** 프로젝트가 쓰는 SQL 라이브러리 (sqlx·pgx·database/sql) */
  sqlLibs: Set<string>;
  /** 라이브러리를 모르는 파일(상수만 있는 파일 등)의 SQL 위치 */
  looseSql: { file: string; line: number }[];
  /** 폴더 → package 이름 */
  dirPkg: Map<string, string>;
  /** 패키지 수준 문자열 상수 (dir|이름 → 값) */
  strConsts: Map<string, string>;
  /** 함수 슬라이스 (dir|이름 → append 로 담은 함수들) */
  fnSlices: Map<string, CallDesc[]>;
  /** TableName() 이 상수를 돌려줄 때 (dir|타입 → dir|상수) */
  tableNameRefs: Map<string, string>;
  /** GORM 이름 규칙: 단수 테이블, 접두어 (null = 설정값이라 모름) */
  gormSingular: boolean;
  gormPrefix: string | null | undefined;
}

const states = new WeakMap<Ctx, GoState>();

function state(ctx: Ctx): GoState {
  let st = states.get(ctx);
  if (st) return st;
  const modules: GoState['modules'] = [];
  let usesGorm = false;
  const goDirs = new Set<string>();
  const dirPkg = new Map<string, string>();
  for (const f of ctx.facts.files) {
    if (f.lang === 'Go' && !f.excluded) {
      const d = dirName(f.path);
      goDirs.add(d);
      if (!dirPkg.has(d) && f.layer !== 'TEST') {
        const pm = /^\s*package\s+(\w+)/m.exec(ctx.facts.texts.get(f.id)?.slice(0, 4000) ?? '');
        if (pm && !pm[1].endsWith('_test')) dirPkg.set(d, pm[1]);
      }
    }
    if (f.name !== 'go.mod' || f.excluded) continue;
    const text = ctx.facts.texts.get(f.id) ?? '';
    const m = /^\s*module\s+(\S+)/m.exec(text);
    modules.push({ dir: dirName(f.path), path: m ? m[1].replace(/^"|"$/g, '') : '' });
    if (/gorm\.io\/gorm|jinzhu\/gorm/.test(text)) usesGorm = true;
  }
  // 바깥 모듈이 안쪽 모듈 경로를 가로채지 않게 긴 경로부터
  modules.sort((a, b) => b.path.length - a.path.length);
  st = {
    modules, rootName: ctx.facts.files[0]?.path.split('/')[0] ?? '', goDirs, usesGorm, decls: [], structs: new Map(), ifaces: new Map(), aliases: new Map(),
    tableNames: new Map(), pkgVars: new Map(), pkgRouters: new Map(), pkgTmpl: new Map(), consts: new Map(), routes: [], routerArgs: [], mountSites: [], gorm: [], migrate: [],
    templates: new Map(), httpRoot: { prefix: '', fw: 'http', mounts: [] }, fieldRouters: new Map(), importDirs: new Map(), sqlFiles: new Set(), sqlLibs: new Set(), looseSql: [], dirPkg, strConsts: new Map(), fnSlices: new Map(), tableNameRefs: new Map(), gormSingular: false, gormPrefix: undefined,
  };
  states.set(ctx, st);
  return st;
}

/** import 경로 → 프로젝트 안 폴더 (없으면 null = 외부 패키지) */
function dirOfImport(st: GoState, imp: string): string | null {
  const hit = st.importDirs.get(imp);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  for (const m of st.modules) {
    if (m.path && (imp === m.path || imp.startsWith(`${m.path}/`))) {
      const rest = imp.slice(m.path.length).replace(/^\//, '');
      out = [m.dir, rest].filter(Boolean).join('/');
      break;
    }
  }
  if (out === null && !st.modules.some((m) => m.path)) {
    // go.mod 없는 GOPATH 프로젝트: import 경로 꼬리와 폴더 꼬리 맞추기
    const segs = imp.split('/');
    let bestLen = 0;
    for (const d of st.goDirs) {
      const ds = d.split('/');
      let k = 0;
      while (k < ds.length && k < segs.length && ds[ds.length - 1 - k] === segs[segs.length - 1 - k]) k++;
      const ok = k >= 2 || (k === 1 && segs[segs.length - 2] === st.rootName);
      if (ok && k > bestLen) {
        out = d;
        bestLen = k;
      }
    }
  }
  st.importDirs.set(imp, out);
  return out;
}

/** 타입 식 a..b → 기본 이름 (*pkg.T, []T, map[K]V → V) */
function parseType(t: GT[], a: number, b: number, fc: FileCtx): TRef | null {
  let i = a;
  while (i < b) {
    const v = t[i].v;
    if (t[i].k === 'op' && (v === '*' || v === '&' || v === '...' || v === '<-')) {
      i++;
      continue;
    }
    if (t[i].k === 'op' && v === '[') {
      i = closeOf(t, i) + 1;
      continue;
    }
    if (v === 'map' && t[i + 1]?.v === '[') {
      i = closeOf(t, i + 1) + 1;
      continue;
    }
    if (v === 'chan') {
      i++;
      continue;
    }
    break;
  }
  if (i >= b || t[i].k !== 'id') return null;
  const n0 = t[i].v;
  if (n0 === 'func' || n0 === 'interface' || n0 === 'struct') return null;
  if (t[i + 1]?.v === '.' && t[i + 2]?.k === 'id' && i + 2 < b) {
    const name = t[i + 2].v;
    const path = fc.imports.get(n0);
    if (path === undefined) return { dir: '', name: `${n0}.${name}`, ext: true };
    const dir = dirOfImport(fc.st, path);
    return dir === null ? { dir: '', name: `${n0}.${name}`, ext: true, path } : { dir, name };
  }
  if (BUILTIN_TYPES.has(n0)) return null;
  return { dir: fc.dir, name: n0 };
}

const keyOf = (r: TRef) => `${r.dir}|${r.name}`;

function snakePlural(name: string): string {
  return pluralLast(snakeCase(name));
}

/** snake 이름의 마지막 낱말을 단수로 (order_items → order_item, categories → category) */
const singularWord = (name: string): string => singularLast(name);

function joinPath(prefix: string, p: string): string {
  if (!p) return prefix || '/';
  const s = `${prefix.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
  return s.length > 1 ? s.replace(/\/$/, '') : s;
}

/** Go 라우트 경로 정리: {id:[0-9]+} → {id}, *path → {path}, {$} 제거 */
function cleanPath(p: string): string {
  return p
    .replace(/\{\$\}/g, '')
    .replace(/\{(\w+)(?::[^{}]*(?:\{[^}]*\}[^{}]*)*|\.\.\.)\}/g, '{$1}')
    .replace(/\/\*(\w+)/g, '/{$1}')
    .replace(/\/\*$/, '/{x}')
    .replace(/:(\w+)\?/g, ':$1');
}

// ------------------------------------------------------------------ 프레임워크

function frameworkOf(path: string): string {
  if (/gin-gonic\/gin$/.test(path)) return 'gin';
  if (/labstack\/echo(\/v\d+)?$/.test(path)) return 'echo';
  if (/gofiber\/fiber(\/v\d+)?$/.test(path)) return 'fiber';
  if (/go-chi\/chi(\/v\d+)?$/.test(path)) return 'chi';
  if (/gorilla\/mux$/.test(path)) return 'mux';
  if (path === 'net/http') return 'http';
  if (/julienschmidt\/httprouter$/.test(path)) return 'httprouter';
  return '';
}
const ROUTER_CTORS: Record<string, string[]> = {
  gin: ['Default', 'New'], echo: ['New'], fiber: ['New'], chi: ['NewRouter', 'NewMux'], mux: ['NewRouter'], http: ['NewServeMux'], httprouter: ['New'],
};
const ROUTER_TYPES: Record<string, string[]> = {
  gin: ['Engine', 'RouterGroup', 'IRouter', 'IRoutes'], echo: ['Echo', 'Group'], fiber: ['App', 'Router', 'Group'], chi: ['Router', 'Mux'], mux: ['Router'], http: ['ServeMux'],
  httprouter: ['Router'],
};
/** 라우터 타입이면 프레임워크 이름 */
function routerTypeFw(r: TRef | null): string | null {
  if (!r?.ext) return null;
  const fw = frameworkOf(r.path ?? '');
  const name = r.name.split('.').pop() ?? '';
  if (fw && ROUTER_TYPES[fw]?.includes(name)) return fw;
  return null;
}

const VERBS: Record<string, string> = {
  GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', OPTIONS: 'OPTIONS', HEAD: 'HEAD', Any: '*',
  Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Options: 'OPTIONS', Head: 'HEAD', All: '*',
};
const ROUTER_SKIP = new Set(['Static', 'StaticFS', 'StaticFile', 'StaticFileFS', 'Use', 'LoadHTMLGlob', 'LoadHTMLFiles', 'SetHTMLTemplate', 'Run', 'RunTLS', 'Listen', 'ListenTLS', 'Start', 'StartTLS',
  'NotFound', 'MethodNotAllowed', 'NoRoute', 'NoMethod', 'ServeHTTP', 'ServeFiles', 'File', 'Pre', 'Shutdown', 'Routes', 'Walk', 'Name', 'Delims', 'SetFuncMap']);
const ROUTER_DERIVE = new Set(['Subrouter', 'With', 'Use', 'Methods', 'Host', 'Schemes', 'Headers']);

const GORM_READ = new Set(['Find', 'First', 'Last', 'Take', 'Scan', 'Count', 'Pluck', 'Row', 'Rows', 'FindInBatches', 'FirstOrInit']);
const GORM_WRITE: Record<string, Crud[]> = {
  Create: ['C'], CreateInBatches: ['C'], FirstOrCreate: ['R', 'C'], Save: ['U'], Update: ['U'], Updates: ['U'], UpdateColumn: ['U'], UpdateColumns: ['U'], Delete: ['D'],
};
const GORM_CHAIN = new Set(['Model', 'Table', 'Where', 'Or', 'Not', 'Select', 'Omit', 'Joins', 'InnerJoins', 'Preload', 'Order', 'Limit', 'Offset', 'Group', 'Having', 'Distinct',
  'Scopes', 'Unscoped', 'Clauses', 'WithContext', 'Session', 'Debug', 'Attrs', 'Assign', 'Raw', 'Exec']);
const GORM_ONLY = new Set(['Model', 'Table', 'Preload', 'Joins', 'InnerJoins', 'Scopes', 'Unscoped', 'Omit', 'Clauses', 'FirstOrCreate', 'FirstOrInit', 'Updates', 'UpdateColumn', 'UpdateColumns',
  'CreateInBatches', 'FindInBatches', 'Pluck']);
const isGormName = (m: string) => GORM_CHAIN.has(m) || GORM_READ.has(m) || !!GORM_WRITE[m];
const DBISH = /(^|_)(db|tx|gdb|orm|conn|database|engine|session|gorm)$|db$/i;

// ------------------------------------------------------------------ 1단계: 파일 읽기

/** import 이름: 별칭 > 프로젝트 패키지면 그 폴더의 package 이름 > 경로 끝 (…/v2 는 그 앞) */
function parseImports(t: GT[], st: GoState): Map<string, string> {
  const out = new Map<string, string>();
  const add = (alias: string | null, path: string) => {
    if (alias === '_' || alias === '.') return;
    if (alias) {
      out.set(alias, path);
      return;
    }
    const dir = dirOfImport(st, path);
    const own = dir !== null ? st.dirPkg.get(dir) : undefined;
    if (own) {
      out.set(own, path);
      return;
    }
    const segs = path.split('/');
    let name = segs[segs.length - 1];
    if (/^v\d+$/.test(name) && segs.length > 1) name = segs[segs.length - 2];
    name = name.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/[-.]/g, '');
    out.set(name, path);
  };
  for (let i = 0; i < t.length; i++) {
    if (t[i].k !== 'id') continue;
    if (t[i].v === 'func' || t[i].v === 'type' || t[i].v === 'var' || t[i].v === 'const') break;
    if (t[i].v !== 'import') continue;
    if (t[i + 1]?.v === '(') {
      const close = closeOf(t, i + 1);
      for (let j = i + 2; j < close; j++) {
        if (t[j].k !== 'str') continue;
        const prev = t[j - 1];
        add(j - 1 > i + 1 && (prev.k === 'id' || prev.v === '_' || prev.v === '.') ? prev.v : null, t[j].v);
      }
      i = close;
    } else if (t[i + 1]?.k === 'str') add(null, t[i + 1].v);
    else if (t[i + 2]?.k === 'str') add(t[i + 1].v, t[i + 2].v);
  }
  return out;
}

/** 선언 줄 단위로 끊기: 같은 줄 토큰 [a,b) 목록 (중첩 괄호는 한 줄로 본다) */
function lines(t: GT[], a: number, b: number, fc: FileCtx): [number, number][] {
  const out: [number, number][] = [];
  let k = a;
  while (k < b) {
    const s = k;
    const ln = fc.lineOf(t[k].p);
    while (k < b && (k === s || fc.lineOf(t[k].p) === ln) && t[k].v !== ';') {
      if (t[k].k === 'op' && OPEN.has(t[k].v)) k = closeOf(t, k);
      k++;
    }
    if (k > s) out.push([s, Math.min(k, b)]);
    if (t[k]?.v === ';') k++;
  }
  return out;
}

/** type 선언 하나. 반환: 마지막 토큰 위치 */
function parseTypeDecl(t: GT[], start: number, fc: FileCtx): number {
  const st = fc.st;
  if (t[start]?.k !== 'id') return start;
  const name = t[start].v;
  let j = start + 1;
  if (t[j]?.v === '[' && t[j + 1]?.k === 'id' && t[j + 2]?.v !== ']') j = closeOf(t, j) + 1; // 타입 매개변수
  if (t[j]?.v === '=') j++;
  const key = `${fc.dir}|${name}`;
  if (t[j]?.v === 'struct' && t[j + 1]?.v === '{') {
    const close = closeOf(t, j + 1);
    const def: StructDef = { name, dir: fc.dir, file: fc.f, line: fc.lineOf(t[start].p), fields: new Map(), embedded: [], tagged: false };
    for (const [a, b0] of lines(t, j + 2, close, fc)) {
      let b = b0;
      while (b > a && t[b - 1].k === 'str') {
        if (/\b(gorm|db|sql)\s*:/.test(t[b - 1].v)) def.tagged = true;
        b--;
      }
      if (b <= a) continue;
      const first = t[a];
      if (first.k === 'op' && first.v === '*') {
        const r = parseType(t, a, b, fc);
        if (r) {
          def.embedded.push(r);
          def.fields.set(r.name.split('.').pop()!, r);
        }
        continue;
      }
      if (first.k !== 'id') continue;
      if (b - a === 1 || (t[a + 1]?.v === '.' && b - a === 3)) {
        const r = parseType(t, a, b, fc);
        if (r) {
          def.embedded.push(r);
          def.fields.set(r.name.split('.').pop()!, r);
        }
        continue;
      }
      const names: string[] = [first.v];
      let k = a + 1;
      while (t[k]?.v === ',' && t[k + 1]?.k === 'id') {
        names.push(t[k + 1].v);
        k += 2;
      }
      const r = parseType(t, k, b, fc);
      for (const n of names) def.fields.set(n, r);
    }
    st.structs.set(key, def);
    return close;
  }
  if (t[j]?.v === 'interface' && t[j + 1]?.v === '{') {
    const close = closeOf(t, j + 1);
    const def: IfaceDef = { name, dir: fc.dir, methods: new Set(), embeds: [] };
    for (const [a, b] of lines(t, j + 2, close, fc)) {
      if (t[a].k === 'id' && t[a + 1]?.v === '(') def.methods.add(t[a].v);
      else if (t[a].k === 'id') {
        const r = parseType(t, a, b, fc);
        if (r && !r.ext) def.embeds.push(r);
      }
    }
    st.ifaces.set(key, def);
    return close;
  }
  // type X Y (정의 타입·별칭): 메서드·필드는 원래 타입에서
  let e = j;
  const ln = fc.lineOf(t[start].p);
  while (e < t.length && fc.lineOf(t[e].p) === ln) {
    if (t[e].k === 'op' && OPEN.has(t[e].v)) e = closeOf(t, e);
    e++;
  }
  const r = parseType(t, j, e, fc);
  if (r && !r.ext && r.name !== name) st.aliases.set(key, r);
  return e - 1;
}

/** 이름 체인 a.b.c → Expr */
function chainExpr(names: string[], bc: BodyCtx | null, fc: FileCtx): Expr {
  if (!names.length) return { k: 'pkg', dir: fc.dir };
  const root = names[0];
  let e: Expr;
  if (bc?.locals.has(root)) e = bc.locals.get(root)!;
  else if (bc && root === bc.decl.recvVar && bc.decl.recv) e = { k: 'type', t: { dir: fc.dir, name: bc.decl.recv } };
  else if (fc.imports.has(root)) {
    const path = fc.imports.get(root)!;
    const dir = dirOfImport(fc.st, path);
    e = dir === null ? { k: 'type', t: { dir: '', name: root, ext: true, path } } : { k: 'pkg', dir };
  } else e = { k: 'pvar', dir: fc.dir, name: root };
  for (const n of names.slice(1)) {
    if (e.k === 'pkg') e = { k: 'pvar', dir: e.dir, name: n };
    else if (e.k === 'type' && e.t?.ext && !e.t.name.includes('.')) e = { k: 'type', t: { ...e.t, name: `${e.t.name}.${n}` } };
    else e = { k: 'sel', base: e, name: n };
  }
  return e;
}

/** 값 식(:= 오른쪽 등) → Expr. 끝 위치 b 전까지 */
function exprAt(t: GT[], a: number, b: number, bc: BodyCtx | null, fc: FileCtx): Expr {
  let q = a;
  if (q >= b) return UNKNOWN;
  if (t[q].v === '&' || t[q].v === '*') q++;
  const x = t[q];
  if (!x) return UNKNOWN;
  if ((x.v === 'new' || x.v === 'make') && t[q + 1]?.v === '(') {
    const a0 = argsOf(t, q + 1)[0];
    return { k: 'type', t: a0 ? parseType(t, a0[0], a0[1], fc) : null };
  }
  if (x.v === '[' && x.k === 'op') {
    // []T{…} / []*pkg.T{}
    let e = closeOf(t, q) + 1;
    while (e < b && t[e].v !== '{' && t[e].v !== '(' && fc.lineOf(t[e].p) === fc.lineOf(x.p)) e++;
    return { k: 'type', t: t[e]?.v === '{' ? parseType(t, q, e, fc) : null };
  }
  if (x.k !== 'id') return UNKNOWN;
  const names: string[] = [x.v];
  let j = q + 1;
  while (t[j]?.v === '.' && t[j + 1]?.k === 'id') {
    names.push(t[j + 1].v);
    j += 2;
  }
  // 복합 리터럴 T{…} / pkg.T{…} / 제네릭 T[X]{…}
  if (t[j]?.v === '{' && /^[A-Z]/.test(names[names.length - 1]) || (t[j]?.v === '{' && names.length === 1 && !bc?.locals.has(names[0]))) return { k: 'type', t: parseType(t, q, j, fc) };
  if (t[j]?.v === '[' && t[closeOf(t, j) + 1]?.v === '{') return { k: 'type', t: parseType(t, q, j, fc) };
  // 타입 단언 x.(T)
  if (t[j]?.v === '.' && t[j + 1]?.v === '(') return { k: 'type', t: parseType(t, j + 2, closeOf(t, j + 1), fc) };
  if (t[j]?.v !== '(') return chainExpr(names, bc, fc);
  if (names.length === 1 && BUILTIN_FNS.has(names[0])) return UNKNOWN;
  let e: Expr = { k: 'call', c: { recv: chainExpr(names.slice(0, -1), bc, fc), name: names[names.length - 1], line: fc.lineOf(x.p) } };
  // 이어지는 체인 a.B().C().d, 끝의 타입 단언 .(T)
  let k = closeOf(t, j) + 1;
  while (k < b && t[k]?.v === '.' && (t[k + 1]?.k === 'id' || t[k + 1]?.v === '(')) {
    if (t[k + 1].v === '(') return { k: 'type', t: parseType(t, k + 2, closeOf(t, k + 1), fc) };
    if (t[k + 2]?.v === '(') {
      e = { k: 'call', c: { recv: e, name: t[k + 1].v, line: fc.lineOf(t[k + 1].p) } };
      k = closeOf(t, k + 2) + 1;
    } else {
      e = { k: 'sel', base: e, name: t[k + 1].v };
      k += 2;
    }
  }
  return e;
}

function fnDoc(textLines: string[], line: number, name: string): string | undefined {
  const out: string[] = [];
  for (let i = line - 2; i >= 0 && out.length < 12; i--) {
    const s = textLines[i].trim();
    if (!s.startsWith('//')) break;
    if (/^\/\/(go:|\s*nolint)/.test(s)) continue;
    out.unshift(s.replace(/^\/\/\s?/, ''));
  }
  if (!out.length) return undefined;
  const summary = out.find((l) => /^@Summary\s+/i.test(l));
  if (summary) return summary.replace(/^@Summary\s+/i, '').trim() || undefined;
  const first = out.find((l) => !/^@\w+/.test(l) && l.trim());
  if (!first) return undefined;
  const s = first.replace(new RegExp(`^${name}\\b\\s*(:|-|—)?\\s*`), '').trim();
  const cut = s.split(/(?<=[.。])\s/)[0].replace(/[.。]$/, '').trim();
  return cut && cut.length <= 80 ? cut : undefined;
}

interface BodyCtx {
  fc: FileCtx;
  decl: FnDecl;
  locals: Map<string, Expr>;
  routers: Map<string, RouterObj>;
  tmpl: Map<string, string[]>;
  /** range 로 꺼낸 함수 변수 → 슬라이스(dir|이름) */
  rangeVars?: Map<string, string>;
}

function analyzeGoFile(f: FileInfo, text: string, ctx: Ctx, st: GoState): void {
  const t = lexGo(text);
  const lineOf = makeLineIndex(text);
  const dir = dirName(f.path);
  let pkg = 'main';
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i].v === 'package' && t[i + 1].k === 'id') {
      pkg = t[i + 1].v;
      break;
    }
  }
  const imports = parseImports(t, st);
  const paths = [...imports.values()];
  const fc: FileCtx = {
    f, st, dir, pkg, imports, lineOf,
    usesGorm: paths.some((p) => /gorm\.io\/gorm|jinzhu\/gorm/.test(p)),
    usesSql: paths.includes('github.com/jmoiron/sqlx') ? 'sqlx' : paths.some((p) => /jackc\/pgx/.test(p)) ? 'pgx' : paths.includes('database/sql') ? 'database/sql' : null,
  };
  if (fc.usesGorm) st.usesGorm = true;
  if (fc.usesSql) st.sqlLibs.add(fc.usesSql);
  const textLines = text.split('\n');
  if (fc.usesGorm) gormNaming(t, st);

  // 최상위 선언
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.k === 'op') {
      if (OPEN.has(x.v)) depth++;
      else if (CLOSE.has(x.v)) depth--;
      continue;
    }
    if (depth !== 0 || x.k !== 'id') continue;
    if (x.v === 'type') {
      if (t[i + 1]?.v === '(') {
        const close = closeOf(t, i + 1);
        let j = i + 2;
        while (j < close) j = Math.max(parseTypeDecl(t, j, fc) + 1, j + 1);
        i = close;
      } else i = parseTypeDecl(t, i + 1, fc);
      continue;
    }
    if (x.v === 'const' || x.v === 'var') {
      const grouped = t[i + 1]?.v === '(';
      let specs: [number, number][];
      if (grouped) {
        const end = closeOf(t, i + 1);
        specs = lines(t, i + 2, end, fc);
        i = end;
      } else {
        // 한 줄 선언: 줄 끝까지 (괄호는 건너뛰고, 연산자로 끝나면 다음 줄까지)
        let e = i + 1;
        const ln = lineOf(t[i].p);
        while (e < t.length && (lineOf(t[e].p) === ln || ['=', '+', ','].includes(t[e - 1].v))) {
          if (t[e].k === 'op' && OPEN.has(t[e].v)) e = closeOf(t, e);
          e++;
        }
        specs = [[i + 1, e]];
        i = e - 1;
      }
      for (const [a, b] of specs) topSpec(t, a, b, x.v === 'const', fc, ctx);
      continue;
    }
    if (x.v === 'func') {
      i = parseFunc(t, i, fc, ctx, textLines);
      depth = 0;
    }
  }
}

/** db.SingularTable(true) · NamingStrategy{SingularTable: true, TablePrefix: "t_"} · DefaultTableNameHandler 의 접두어 */
function gormNaming(t: GT[], st: GoState): void {
  for (let i = 0; i < t.length - 3; i++) {
    const x = t[i];
    if (x.k !== 'id') continue;
    if (x.v === 'SingularTable' && ((t[i + 1]?.v === '(' && t[i + 2]?.v === 'true') || (t[i + 1]?.v === ':' && t[i + 2]?.v === 'true'))) st.gormSingular = true;
    else if (x.v === 'TablePrefix' && t[i + 1]?.v === ':') {
      if (t[i + 2]?.k === 'str' && t[i + 3]?.v !== '+') st.gormPrefix = t[i + 2].v;
      else st.gormPrefix = null;
    } else if (x.v === 'DefaultTableNameHandler' && t[i + 1]?.v === '=') {
      // return "blog_" + defaultTableName / return setting.X.TablePrefix + defaultTableName
      for (let k = i + 2; k < Math.min(t.length, i + 60); k++) {
        if (t[k].v !== 'return') continue;
        st.gormPrefix = t[k + 1]?.k === 'str' && t[k + 2]?.v === '+' ? t[k + 1].v : null;
        break;
      }
    }
  }
}

/** 패키지 수준 const/var 한 줄: SQL 상수, 라우터·템플릿·전역 변수 */
function topSpec(t: GT[], a: number, b: number, isConst: boolean, fc: FileCtx, ctx: Ctx): void {
  const st = fc.st;
  if (t[a]?.k !== 'id') return;
  const names: string[] = [t[a].v];
  let k = a + 1;
  while (t[k]?.v === ',' && t[k + 1]?.k === 'id') {
    names.push(t[k + 1].v);
    k += 2;
  }
  let eq = k;
  while (eq < b && t[eq].v !== '=') eq++;
  const typed = eq > k ? parseType(t, k, eq, fc) : null;
  if (eq >= b) {
    // var x T
    if (!isConst && typed) for (const n of names) {
      st.pkgVars.set(`${fc.dir}|${n}`, { k: 'type', t: typed });
      const fw = routerTypeFw(typed);
      if (fw) st.pkgRouters.set(`${fc.dir}|${n}`, { prefix: '', fw, mounts: [] });
    }
    return;
  }
  const vals = splitRange(t, eq + 1, b);
  names.forEach((n, idx) => {
    const r = vals[idx];
    if (!r) return;
    if (t[r[0]].k === 'str') {
      const s = strArg(t, r);
      if (s !== null && !s.includes('${v}')) st.strConsts.set(`${fc.dir}|${n}`, s);
      const ids = s ? addSqlText(ctx, fc, s, t[r[0]].p, null) : [];
      if (ids.length) st.consts.set(`${fc.dir}|${n}`, ids);
      return;
    }
    if (isConst) return;
    const ro = routerCtor(t, r[0], fc);
    if (ro) {
      st.pkgRouters.set(`${fc.dir}|${n}`, ro);
      return;
    }
    const files = parseFilesIn(t, r[0], r[1]);
    if (files) st.pkgTmpl.set(`${fc.dir}|${n}`, files);
    st.pkgVars.set(`${fc.dir}|${n}`, typed ? { k: 'type', t: typed } : exprAt(t, r[0], r[1], null, fc));
    // 패키지 수준 문자열 SQL (맵·슬라이스 안)
    for (let q = r[0]; q < r[1]; q++) if (t[q].k === 'str' && t[q].v.length > 15) addSqlText(ctx, fc, t[q].v, t[q].p, null);
  });
}

/** gin.Default() / echo.New() / chi.NewRouter() / http.NewServeMux() … */
function routerCtor(t: GT[], q: number, fc: FileCtx): RouterObj | null {
  if (t[q]?.k === 'id' && t[q + 1]?.v === '.' && t[q + 2]?.k === 'id' && t[q + 3]?.v === '(') {
    const fw = frameworkOf(fc.imports.get(t[q].v) ?? '');
    if (fw && ROUTER_CTORS[fw].includes(t[q + 2].v)) return { prefix: '', fw, mounts: [] };
  }
  return null;
}

/** template.ParseFiles("a", "b") 인자 (ParseGlob·ParseFS 는 빈 목록) */
function parseFilesIn(t: GT[], a: number, b: number): string[] | null {
  for (let i = a; i < b; i++) {
    if (t[i].k === 'id' && (t[i].v === 'ParseFiles' || t[i].v === 'ParseGlob' || t[i].v === 'ParseFS') && t[i + 1]?.v === '(') {
      if (t[i].v !== 'ParseFiles') return [];
      const out: string[] = [];
      for (const ar of argsOf(t, i + 1)) {
        const s = strArg(t, ar);
        if (s && !s.includes('*') && !s.includes('${v}')) out.push(s);
      }
      return out;
    }
  }
  return null;
}

const SQL_LIB_NAME: Record<string, string> = { sqlx: 'sqlx', pgx: 'pgx', 'database/sql': 'SQL 직접 작성(database/sql)' };

function addSqlText(ctx: Ctx, fc: FileCtx, text: string, p: number, decl: FnDecl | null): string[] {
  if (text.length < 12) return [];
  // sqlc 생성 코드: "-- name: ListAuthors :many\nSELECT …" 처럼 앞에 주석
  const body = text.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '');
  const s0 = body.replace(/%[-+# 0-9.*]*[sdvqfxXtT]/g, '${v}').replace(/\$\d+\b/g, '?');
  if (!isSqlLike(s0)) return [];
  const parsed = parseSql(s0);
  if (!parsed.tables.length) return [];
  const s: SqlFact = ctx.addSql({ file: fc.f.id, line: fc.lineOf(p), origin: 'string', kind: parsed.kind, tables: parsed.tables, ...(parsed.dynamic ? { dynamic: true } : {}), text: compactSql(s0) });
  if (decl) decl.method.sql.push(s.id);
  fc.st.sqlFiles.add(fc.f);
  if (fc.usesSql) ctx.hit('데이터 접근', SQL_LIB_NAME[fc.usesSql], fc.f.id, s.line, 1);
  else if (!fc.usesGorm) fc.st.looseSql.push({ file: fc.f.id, line: s.line });
  return [s.id];
}

function paramList(t: GT[], open: number, fc: FileCtx): { name: string; t: TRef | null }[] {
  const out: { name: string; t: TRef | null }[] = [];
  const pending: string[] = [];
  for (const [a, b] of argsOf(t, open)) {
    if (b - a === 1 && t[a].k === 'id') {
      pending.push(t[a].v);
      continue;
    }
    if (t[a].k === 'id' && b - a > 1 && t[a + 1].v !== '.') {
      const ty = parseType(t, a + 1, b, fc);
      for (const p of pending) out.push({ name: p, t: ty });
      pending.length = 0;
      out.push({ name: t[a].v, t: ty });
    } else {
      for (const p of pending) out.push({ name: '_', t: BUILTIN_TYPES.has(p) ? null : { dir: fc.dir, name: p } });
      pending.length = 0;
      out.push({ name: '_', t: parseType(t, a, b, fc) });
    }
  }
  // 끝에 남은 이름들은 이름 없는 매개변수의 타입
  for (const p of pending) out.push({ name: '_', t: BUILTIN_TYPES.has(p) ? null : { dir: fc.dir, name: p } });
  return out;
}

/** func 선언 하나 (위치 i = 'func'). 반환: 본문 닫는 괄호 위치 */
function parseFunc(t: GT[], i: number, fc: FileCtx, ctx: Ctx, textLines: string[]): number {
  let j = i + 1;
  let recv: string | undefined;
  let recvVar: string | undefined;
  if (t[j]?.v === '(') {
    const close = closeOf(t, j);
    const ids: string[] = [];
    for (let k = j + 1; k < close; k++) {
      if (t[k].v === '[') break;
      if (t[k].k === 'id') ids.push(t[k].v);
    }
    if (ids.length >= 2) {
      recvVar = ids[0];
      recv = ids[ids.length - 1];
    } else if (ids.length === 1) recv = ids[0];
    j = close + 1;
  }
  if (t[j]?.k !== 'id') return j;
  const name = t[j].v;
  j++;
  if (t[j]?.v === '[') j = closeOf(t, j) + 1;
  if (t[j]?.v !== '(') return j;
  const paramsOpen = j;
  const line = fc.lineOf(t[i].p);
  // 반환 타입 → 본문 {
  let k = closeOf(t, j) + 1;
  const resStart = k;
  while (k < t.length && t[k].v !== '{') {
    if ((t[k].v === 'interface' || t[k].v === 'struct') && t[k + 1]?.v === '{') k = closeOf(t, k + 1);
    else if (t[k].k === 'op' && (t[k].v === '(' || t[k].v === '[')) k = closeOf(t, k);
    else if (t[k].k === 'id' && ['func', 'type', 'var', 'const'].includes(t[k].v) && fc.lineOf(t[k].p) > line) return k - 1;
    k++;
  }
  if (k >= t.length) return k;
  const bodyOpen = k;
  const bodyClose = closeOf(t, k);
  let result: TRef | null = null;
  if (resStart < bodyOpen) {
    if (t[resStart].v === '(') {
      const rs = argsOf(t, resStart);
      if (rs[0]) {
        const [a, b] = rs[0];
        // 이름 붙은 결과 (x T, err error)
        const named = b - a >= 2 && t[a].k === 'id' && t[a + 1].v !== '.' && (t[a + 1].k === 'id' || t[a + 1].v === '*' || t[a + 1].v === '[');
        result = named ? parseType(t, a + 1, b, fc) : parseType(t, a, b, fc);
      }
    } else result = parseType(t, resStart, bodyOpen, fc);
  }
  const m: MethodUnit = { name, line, endLine: fc.lineOf(t[bodyClose].p), routes: [], calls: [], sql: [], statements: [], views: [] };
  const doc = fnDoc(textLines, line, name);
  if (doc) m.doc = doc;
  const decl: FnDecl = {
    name, ...(recv ? { recv } : {}), ...(recvVar ? { recvVar } : {}), fc, method: m, result, calls: [], params: paramList(t, paramsOpen, fc), viewParams: [],
    usedIds: new Set(), usedQual: new Set(),
  };
  // TableName() string { return "x" } / return tableConst / return pkg.Const
  if (name === 'TableName' && recv) {
    for (let q = bodyOpen; q < bodyClose; q++) {
      if (t[q].v !== 'return') continue;
      const key = `${fc.dir}|${recv}`;
      if (t[q + 1]?.k === 'str' && t[q + 2]?.v !== '+') fc.st.tableNames.set(key, t[q + 1].v);
      else if (t[q + 1]?.k === 'id' && t[q + 2]?.v === '.' && t[q + 3]?.k === 'id' && fc.imports.has(t[q + 1].v)) {
        const d = dirOfImport(fc.st, fc.imports.get(t[q + 1].v)!);
        if (d !== null) fc.st.tableNameRefs.set(key, `${d}|${t[q + 3].v}`);
      } else if (t[q + 1]?.k === 'id' && t[q + 2]?.v !== '.' && t[q + 2]?.v !== '(') fc.st.tableNameRefs.set(key, `${fc.dir}|${t[q + 1].v}`);
      break;
    }
  }
  const bc: BodyCtx = { fc, decl, locals: new Map(), routers: new Map(), tmpl: new Map() };
  decl.params.forEach((p, idx) => {
    if (p.name === '_') return;
    bc.locals.set(p.name, { k: 'type', t: p.t });
    const fw = routerTypeFw(p.t);
    if (fw) bc.routers.set(p.name, { prefix: '', fw, param: { decl, idx }, mounts: [] });
  });
  fc.st.decls.push(decl);
  analyzeBody(t, bodyOpen + 1, bodyClose, bc, ctx);
  return bodyClose;
}

// ------------------------------------------------------------------ 함수 본문

function analyzeBody(t: GT[], a: number, b: number, bc: BodyCtx, ctx: Ctx): void {
  const { fc, decl } = bc;
  const st = fc.st;
  const consumed = new Set<number>();
  const usesGorm = fc.usesGorm || st.usesGorm;

  /** 대입 오른쪽 식의 끝 (같은 줄, 연산자로 끝나면 이어짐) */
  const stmtEnd = (q: number, end: number): number => {
    const ln = fc.lineOf(t[q]?.p ?? 0);
    let e = q;
    while (e < end && (fc.lineOf(t[e].p) === ln || ['(', ',', '.', '{', '+'].includes(t[e - 1]?.v ?? ''))) {
      if (t[e].k === 'op' && OPEN.has(t[e].v)) e = closeOf(t, e);
      e++;
    }
    return Math.min(e, end);
  };

  function routerOf(names: string[]): RouterObj | null {
    if (names.length === 1) {
      const r = bc.routers.get(names[0]);
      if (r) return r;
      if (fc.imports.get(names[0]) === 'net/http') return st.httpRoot;
      return st.pkgRouters.get(`${fc.dir}|${names[0]}`) ?? null;
    }
    if (names.length === 2 && fc.imports.has(names[0])) {
      const dir = dirOfImport(st, fc.imports.get(names[0])!);
      if (dir !== null) return st.pkgRouters.get(`${dir}|${names[1]}`) ?? null;
    }
    return null;
  }

  function implicitRouter(names: string[]): RouterObj {
    const key = names.join('.');
    if (names.length === 1) {
      let r = bc.routers.get(key);
      if (!r) {
        r = { prefix: '', fw: '', mounts: [] };
        bc.routers.set(key, r);
      }
      return r;
    }
    const k2 = `${fc.dir}|${decl.recv ?? ''}|${key}`;
    let r = st.fieldRouters.get(k2);
    if (!r) {
      r = { prefix: '', fw: '', mounts: [] };
      st.fieldRouters.set(k2, r);
    }
    return r;
  }

  /** 라우터에서 이어지는 식 → 새 라우터 (등록 없이). g := r.Group("/x") / r.PathPrefix("/x").Subrouter() */
  function routerChain(q: number, e: number): RouterObj | null {
    if (t[q]?.k !== 'id') return null;
    const names: string[] = [t[q].v];
    let j = q + 1;
    while (t[j]?.v === '.' && t[j + 1]?.k === 'id' && t[j + 2]?.v !== '(') {
      names.push(t[j + 1].v);
      j += 2;
    }
    if (t[j]?.v !== '.' || t[j + 1]?.k !== 'id' || t[j + 2]?.v !== '(') return null;
    let cur = routerOf(names);
    if (!cur) {
      // 모르는 받는 쪽: Group("/x") 꼴이면 라우터로 본다
      if (t[j + 1].v !== 'Group' && t[j + 1].v !== 'PathPrefix') return null;
      const a0 = argsOf(t, j + 2)[0];
      const s = a0 ? strArg(t, a0) : null;
      if (s === null || (s && !s.startsWith('/'))) return null;
      cur = implicitRouter(names);
    }
    let steps = 0;
    while (j < e && t[j]?.v === '.' && t[j + 1]?.k === 'id' && t[j + 2]?.v === '(') {
      const m = t[j + 1].v;
      const args = argsOf(t, j + 2);
      if (m === 'Group' || m === 'PathPrefix' || (m === 'Route' && args.length === 1)) {
        if (args[0] && t[args[0][0]].v === 'func') return null;
        const s = args[0] ? strArg(t, args[0]) : '';
        if (s === null) return null;
        cur = { parent: cur, prefix: cleanPath(s), fw: cur.fw, mounts: [] };
      } else if (!ROUTER_DERIVE.has(m)) return null;
      steps++;
      j = closeOf(t, j + 2) + 1;
    }
    return steps ? cur : null;
  }

  function assign(names: string[], q: number, end: number): void {
    const v = names[0];
    if (v === '_' || q >= end) return;
    const e = stmtEnd(q, end);
    if (t[q]?.v === 'append' && t[q + 1]?.v === '(' && names.length === 1) {
      // routers = append(routers, registerX): 함수 슬라이스
      const key = `${fc.dir}|${v}`;
      for (const [p0, p1] of argsOf(t, q + 1).slice(1)) {
        let ok = true;
        for (let k = p0; k < p1; k++) if (t[k].k !== 'id' && t[k].v !== '.') ok = false;
        if (!ok) continue;
        const names2: string[] = [];
        for (let k = p0; k < p1; k++) if (t[k].k === 'id') names2.push(t[k].v);
        const d: CallDesc = names2.length === 1 ? { recv: { k: 'pkg', dir: fc.dir }, name: names2[0], line: 0 } : { recv: chainExpr(names2.slice(0, -1), bc, fc), name: names2[names2.length - 1], line: 0 };
        if (!st.fnSlices.has(key)) st.fnSlices.set(key, []);
        st.fnSlices.get(key)!.push(d);
      }
      return;
    }
    const ro = routerCtor(t, q, fc);
    if (ro) {
      ro.owner = decl;
      bc.routers.set(v, ro);
      return;
    }
    const derived = routerChain(q, e);
    if (derived) {
      bc.routers.set(v, derived);
      return;
    }
    const files = parseFilesIn(t, q, e);
    if (files) {
      bc.tmpl.set(v, files);
      return;
    }
    const prev = bc.locals.get(v);
    if (prev && prev.k === 'type' && prev.t) return; // 이미 타입을 앎
    const ex = exprAt(t, q, e, bc, fc);
    if (names.length > 1 && ex.k !== 'call') return;
    if (ex === UNKNOWN && prev) return;
    bc.locals.set(v, ex);
  }

  // 1) 지역 변수·라우터·템플릿 변수 (앞에서부터)
  for (let i = a; i < b; i++) {
    const x = t[i];
    if (x.k !== 'id') continue;
    if (x.v === 'func' && t[i + 1]?.v === '(') {
      // 클로저 매개변수 func(tx *gorm.DB) / func(r chi.Router)
      for (const p of paramList(t, i + 1, fc)) if (p.name !== '_' && !bc.locals.has(p.name)) bc.locals.set(p.name, { k: 'type', t: p.t });
      continue;
    }
    if (x.v === 'var' && t[i + 1]?.v === '(') {
      const close = closeOf(t, i + 1);
      for (const [la, lb] of lines(t, i + 2, close, fc)) {
        if (t[la].k !== 'id') continue;
        const names: string[] = [t[la].v];
        let k = la + 1;
        while (t[k]?.v === ',' && t[k + 1]?.k === 'id') {
          names.push(t[k + 1].v);
          k += 2;
        }
        let e = k;
        while (e < lb && t[e].v !== '=') e++;
        const ty = parseType(t, k, e, fc);
        if (ty) for (const n of names) bc.locals.set(n, { k: 'type', t: ty });
        if (t[e]?.v === '=' && e < lb) assign(names, e + 1, lb);
      }
      i = close;
      continue;
    }
    if (x.v === 'var' && t[i + 1]?.k === 'id') {
      const names: string[] = [t[i + 1].v];
      let k = i + 2;
      while (t[k]?.v === ',' && t[k + 1]?.k === 'id') {
        names.push(t[k + 1].v);
        k += 2;
      }
      let e = k;
      const ln = fc.lineOf(x.p);
      while (e < b && t[e].v !== '=' && fc.lineOf(t[e].p) === ln) e++;
      const ty = parseType(t, k, e, fc);
      if (ty) for (const n of names) bc.locals.set(n, { k: 'type', t: ty });
      if (t[e]?.v === '=') assign(names, e + 1, b);
      continue;
    }
    if (t[i - 1]?.v === '.' || t[i - 1]?.v === ',') continue;
    const names: string[] = [x.v];
    let k = i + 1;
    while (t[k]?.v === ',' && t[k + 1]?.k === 'id') {
      names.push(t[k + 1].v);
      k += 2;
    }
    if (t[k]?.v === ':=' || t[k]?.v === '=') {
      if (t[k + 1]?.v === 'range') {
        // for _, f := range routers / range pkg.Routers
        const q = k + 2;
        if (names.length === 2 && t[q]?.k === 'id') {
          let key: string | null = null;
          if (t[q + 1]?.v === '.' && t[q + 2]?.k === 'id' && fc.imports.has(t[q].v)) {
            const d = dirOfImport(st, fc.imports.get(t[q].v)!);
            if (d !== null) key = `${d}|${t[q + 2].v}`;
          } else if (t[q + 1]?.v !== '.') key = `${fc.dir}|${t[q].v}`;
          if (key) {
            if (!bc.rangeVars) bc.rangeVars = new Map();
            bc.rangeVars.set(names[1], key);
          }
        }
        continue;
      }
      assign(names, k + 1, b);
    }
  }

  // 2) 훑기: 호출·문자열
  scan(a, b);

  function scan(s: number, e: number): void {
    for (let i = s; i < e; i++) {
      const x = t[i];
      if (consumed.has(i)) continue;
      if (x.k === 'id' && x.v === 'return' && t[i + 1]?.k === 'id' && bc.routers.has(t[i + 1].v) && t[i + 2]?.v !== '.') {
        decl.retRouter = bc.routers.get(t[i + 1].v);
        continue;
      }
      if (x.k === 'id' && t[i - 1]?.v !== '.') {
        const names: string[] = [x.v];
        let j = i + 1;
        while (t[j]?.v === '.' && t[j + 1]?.k === 'id') {
          names.push(t[j + 1].v);
          j += 2;
        }
        if (t[j]?.v === ':=' && names.length === 1) {
          // 클로저 안에서 다시 만든 라우터 그룹은 지금 범위 기준으로 다시 계산
          const d = routerChain(j + 1, stmtEnd(j + 1, e));
          if (d) bc.routers.set(names[0], d);
          continue;
        }
        if (t[j]?.k === 'op' && t[j].v === '(') {
          const skip = handleCall(i, j, names);
          if (skip > i) i = skip;
          continue;
        }
        if (names.length === 1) decl.usedIds.add(x.v);
        else if (fc.imports.has(names[0])) {
          const dir = dirOfImport(st, fc.imports.get(names[0])!);
          if (dir !== null) decl.usedQual.add(`${dir}|${names[1]}`);
        }
        continue;
      }
      if (x.k === 'str') {
        let text = x.v;
        let k = i + 1;
        while (t[k]?.v === '+' && t[k + 1]?.k === 'str') {
          text += t[k + 1].v;
          consumed.add(k + 1);
          k += 2;
        }
        addSqlText(ctx, fc, text, x.p, decl);
      }
    }
  }

  function makeDesc(recvNames: string[], m: string, line: number, args: [number, number][]): CallDesc {
    const desc: CallDesc = { recv: chainExpr(recvNames, bc, fc), name: m, line };
    if (!recvNames.length && bc.rangeVars?.has(m)) desc.slice = bc.rangeVars.get(m);
    if (args.some((r) => isLit(t, r))) desc.strArgs = args.map((r) => (isLit(t, r) ? t[r[0]].v : null));
    return desc;
  }

  /** 호출 처리. 반환: 건너뛸 마지막 위치 (안쪽도 훑어야 하면 start) */
  function handleCall(start: number, open: number, names: string[]): number {
    const m = names[names.length - 1];
    const recvNames = names.slice(0, -1);
    const close = closeOf(t, open);
    const args = argsOf(t, open);
    const line = fc.lineOf(t[start].p);
    if (!recvNames.length && BUILTIN_FNS.has(m)) return start;

    // ---------------- 라우터 등록
    if (recvNames.length) {
      let router = routerOf(recvNames);
      if (!router && looksLikeRoute(m, args)) router = implicitRouter(recvNames);
      if (router) {
        const done = routerCall(router, m, open, close, line);
        if (done >= 0) return done;
        if (ROUTER_DERIVE.has(m) || m === 'Group' || m === 'PathPrefix') {
          // r.With(mw).Get(…) / r.Group("/x").GET(…): 이어지는 등록은 파생 라우터에
          let cur = router;
          if (m === 'Group' || m === 'PathPrefix') {
            const s = args[0] ? strArg(t, args[0]) : '';
            if (s !== null) cur = { parent: router, prefix: cleanPath(s), fw: router.fw, mounts: [] };
          }
          let k = close + 1;
          while (t[k]?.v === '.' && t[k + 1]?.k === 'id' && t[k + 2]?.v === '(') {
            const nm = t[k + 1].v;
            const c2 = closeOf(t, k + 2);
            if (nm === 'Group' || nm === 'PathPrefix') {
              const a2 = argsOf(t, k + 2)[0];
              const s2 = a2 ? strArg(t, a2) : '';
              if (s2 !== null) cur = { parent: cur, prefix: cleanPath(s2), fw: cur.fw, mounts: [] };
              k = c2 + 1;
              continue;
            }
            const d2 = routerCall(cur, nm, k + 2, c2, fc.lineOf(t[k + 1].p));
            if (d2 < 0 && !ROUTER_DERIVE.has(nm)) break;
            k = Math.max(c2, d2) + 1;
          }
          return k - 1;
        }
        // 라우터 자체의 다른 메서드: 프로젝트 코드 호출이 아님
        if (router.fw) return start;
      }
    }

    const desc = makeDesc(recvNames, m, line, args);
    // 라우터를 다른 함수에 넘김: setupRoutes(api), h.Register(v1), users.Register(v1.Group("/users"))
    args.forEach(([p0, p1], idx) => {
      if (p1 - p0 === 1 && t[p0].k === 'id' && bc.routers.has(t[p0].v)) st.routerArgs.push({ call: desc, idx, router: bc.routers.get(t[p0].v)! });
      else if (p1 - p0 > 3 && t[p0].k === 'id' && t[p1 - 1].v === ')') {
        const d = routerChain(p0, p1);
        if (d) st.routerArgs.push({ call: desc, idx, router: d });
      }
    });

    viewCall(m, recvNames, args);

    // ---------------- GORM 체인
    if (recvNames.length && usesGorm && isGormName(m)) {
      const recvName = recvNames[recvNames.length - 1];
      if (DBISH.test(recvName) || GORM_ONLY.has(m) || gormTyped(desc.recv)) {
        gormChain(start, open, m, desc.recv, recvName);
        desc.gorm = true;
        decl.calls.push(desc);
        return start;
      }
    }
    if (m === 'AutoMigrate' && usesGorm) for (const ar of args) st.migrate.push(exprAt(t, ar[0], ar[1], bc, fc));

    // ---------------- 일반 호출 + 이어지는 체인 a.B().C()
    decl.calls.push(desc);
    let k = close + 1;
    let prev: CallDesc = desc;
    while (t[k]?.v === '.' && t[k + 1]?.k === 'id' && t[k + 2]?.v === '(') {
      const nm = t[k + 1].v;
      if (usesGorm && GORM_ONLY.has(nm)) {
        gormChain(k + 1, k + 2, nm, { k: 'call', c: prev }, m);
        break;
      }
      const c: CallDesc = { recv: { k: 'call', c: prev }, name: nm, line: fc.lineOf(t[k + 1].p) };
      decl.calls.push(c);
      viewCall(nm, [], argsOf(t, k + 2));
      prev = c;
      k = closeOf(t, k + 2) + 1;
    }
    return start;
  }

  function gormTyped(e: Expr): boolean {
    if (e.k === 'type') return !!e.t?.ext && /gorm/.test(e.t.path ?? '');
    if (e.k === 'sel' && e.base.k === 'type' && e.base.t && !e.base.t.ext) {
      const ft = st.structs.get(keyOf(e.base.t))?.fields.get(e.name);
      return !!ft?.ext && /gorm/.test(ft.path ?? '');
    }
    return false;
  }

  function looksLikeRoute(m: string, args: [number, number][]): boolean {
    if (!VERBS[m] && m !== 'HandleFunc' && m !== 'Handle' && m !== 'HandlerFunc') return false;
    if (args.length < 2 || !isLit(t, args[0])) return false;
    const s = t[args[0][0]].v;
    if (!(s.startsWith('/') || /^[A-Z]+\s+\//.test(s))) return false;
    const ht = t[args[args.length - 1][0]];
    return (ht.k === 'id' && !['nil', 'true', 'false'].includes(ht.v)) || ht.v === '&';
  }

  /** 라우터 메서드 호출. 처리했으면 건너뛸 위치, 아니면 -1 */
  function routerCall(router: RouterObj, m: string, open: number, close: number, line: number): number {
    const args = argsOf(t, open);
    const reg = (method: string, raw: string, h: [number, number] | undefined) => {
      if (!h) return;
      let path = raw.trim();
      let meth = method;
      const pm = /^([A-Z]+)\s+(\S+)$/.exec(path);
      if (pm) {
        meth = pm[1];
        path = pm[2];
      }
      path = cleanPath(path.replace(/^[^/{]+(?=\/)/, ''));
      // 핸들러 자리에 서브 라우터를 넘기면 마운트
      const sub = subRouterIn(h);
      if (sub) {
        sub.mounts.push({ router, prefix: path.replace(/\/$/, '') });
        return;
      }
      if (/FileServer|StripPrefix|Static/.test(t.slice(h[0], h[1]).map((x) => x.v).join(''))) return;
      const r: RouteReg = { router, method: meth, path: path || '/' };
      const hd = handlerOf(h, line);
      if (hd === 'inline') {
        const d = inlineFn(h);
        if (!d) return;
        r.inline = d;
      } else if (hd) {
        r.handler = hd.desc;
        if (hd.factory) r.factory = hd.factory;
      } else return;
      st.routes.push(r);
    };
    if (VERBS[m] && args.length >= 2) {
      const p = strArg(t, args[0]);
      if (p !== null) reg(VERBS[m], p, router.fw === 'echo' ? args[1] : args[args.length - 1]);
      return close;
    }
    if ((m === 'Handle' || m === 'Add' || m === 'Method' || m === 'MethodFunc') && args.length >= 3 && isLit(t, args[0]) && /^[A-Za-z]+$/.test(t[args[0][0]].v)) {
      const p = strArg(t, args[1]);
      if (p !== null) reg(t[args[0][0]].v.toUpperCase(), p, args[router.fw === 'echo' ? 2 : args.length - 1]);
      return close;
    }
    if ((m === 'HandleFunc' || m === 'Handle' || m === 'HandlerFunc') && args.length >= 2) {
      const p = strArg(t, args[0]);
      if (p === null) return close;
      let meth = '*';
      // gorilla: .Methods("GET")
      let k = close + 1;
      while (t[k]?.v === '.' && t[k + 1]?.k === 'id' && t[k + 2]?.v === '(') {
        if (t[k + 1].v === 'Methods') {
          const ma = argsOf(t, k + 2)[0];
          const s = ma ? strArg(t, ma) : null;
          if (s) meth = s.toUpperCase();
          else if (ma && t[ma[0] + 1]?.v === '.' && /^Method[A-Z][a-z]+$/.test(t[ma[0] + 2]?.v ?? '')) meth = t[ma[0] + 2].v.slice(6).toUpperCase();
        }
        k = closeOf(t, k + 2) + 1;
      }
      reg(meth, p, args[1]);
      return k - 1;
    }
    if ((m === 'Route' || m === 'Group') && args.length >= 1) {
      // chi·fiber: r.Route("/p", func(r chi.Router) {…}) / chi: r.Group(func(r chi.Router) {…})
      const fnArg = args.find(([p0]) => t[p0].v === 'func');
      if (!fnArg) return -1;
      const p = t[args[0][0]].k === 'str' ? strArg(t, args[0]) : '';
      if (p === null) return -1;
      const pOpen = fnArg[0] + 1;
      let o = closeOf(t, pOpen) + 1;
      while (o < fnArg[1] && t[o].v !== '{') o++;
      if (o >= fnArg[1]) return -1;
      const sub: RouterObj = { parent: router, prefix: cleanPath(p), fw: router.fw, mounts: [] };
      const saved = new Map(bc.routers);
      for (const pp of paramList(t, pOpen, fc)) if (pp.name !== '_') bc.routers.set(pp.name, sub);
      scan(o + 1, closeOf(t, o));
      bc.routers.clear();
      for (const [kk, vv] of saved) bc.routers.set(kk, vv);
      return close;
    }
    if (m === 'Mount' && args.length >= 2) {
      const p = strArg(t, args[0]);
      if (p === null) return close;
      const h = args[1];
      const sub = subRouterIn(h);
      if (sub) sub.mounts.push({ router, prefix: cleanPath(p) });
      else {
        // Mount("/admin", adminRouter()) / Mount("/x", h.Routes())
        const names: string[] = [];
        let q = h[0];
        while (q < h[1] && (t[q].k === 'id' || t[q].v === '.')) {
          if (t[q].k === 'id') names.push(t[q].v);
          q++;
        }
        if (names.length && t[q]?.v === '(') st.mountSites.push({ call: makeDesc(names.slice(0, -1), names[names.length - 1], line, []), router, prefix: cleanPath(p) });
      }
      return close;
    }
    if (ROUTER_SKIP.has(m)) return close;
    return -1;
  }

  function subRouterIn([h0, h1]: [number, number]): RouterObj | null {
    if (t[h0]?.v === 'func') return null;
    for (let q = h0; q < h1; q++) {
      if (t[q].k === 'id' && t[q - 1]?.v !== '.' && t[q + 1]?.v !== '.' && t[q + 1]?.v !== '(' && bc.routers.has(t[q].v)) return bc.routers.get(t[q].v)!;
    }
    return null;
  }

  /** 이름 체인 [s,e) 를 호출 설명으로 */
  function descOfNames(s: number, e: number, line: number): CallDesc | null {
    const names: string[] = [];
    for (let j = s; j < e && (t[j].k === 'id' || t[j].v === '.'); j++) if (t[j].k === 'id') names.push(t[j].v);
    if (!names.length) return null;
    if (names.length === 1) return { recv: { k: 'pkg', dir: fc.dir }, name: names[0], line };
    return { recv: chainExpr(names.slice(0, -1), bc, fc), name: names[names.length - 1], line };
  }

  /** 핸들러 인자 → 호출 설명 (h.List, handler.Home, http.HandlerFunc(x), mw(h.List), h.List(), listOrders(svc), &Handler{}) */
  function handlerOf([a0, b0]: [number, number], line: number): { desc: CallDesc; factory?: CallDesc } | 'inline' | null {
    let s = a0;
    let e = b0;
    let factory: CallDesc | undefined;
    for (let guard = 0; guard < 5; guard++) {
      if (t[s]?.v === 'func') return 'inline';
      let j = s;
      while (j < e && (t[j].k === 'id' || t[j].v === '.')) j++;
      if (t[j]?.v === '(' && closeOf(t, j) === e - 1 && j > s) {
        // 감싼 호출의 안쪽 인자 중 핸들러처럼 보이는 것 (함수 리터럴·선택자·지역 변수가 아닌 함수 이름)
        const refLike = ([p0, p1]: [number, number]) => {
          if (t[p0].v === 'func' || t[p0].v === '&') return true;
          for (let q = p0; q < p1; q++) if (t[q].k !== 'id' && t[q].v !== '.') return false;
          if (p1 - p0 === 1) return !bc.locals.has(t[p0].v) && !['nil', 'true', 'false'].includes(t[p0].v) && !bc.routers.has(t[p0].v);
          return true;
        };
        const cand = [...argsOf(t, j)].reverse().find(refLike);
        // 인자 없는 호출 h.List() · 지역 값만 받는 팩토리 listOrders(svc): 바깥 함수가 핸들러
        if (!cand) break;
        factory = descOfNames(s, j, line) ?? undefined;
        [s, e] = cand;
        continue;
      }
      break;
    }
    if (t[s]?.v === 'func') return 'inline';
    if (t[s]?.v === '&') s++;
    const names: string[] = [];
    let j = s;
    while (j < e && (t[j].k === 'id' || t[j].v === '.')) {
      if (t[j].k === 'id') names.push(t[j].v);
      j++;
    }
    if (!names.length) return null;
    const wrap = (desc: CallDesc) => ({ desc, ...(factory ? { factory } : {}) });
    if (t[j]?.v === '{') {
      // &Handler{…} → ServeHTTP
      const ty = parseType(t, s, j, fc);
      return ty ? wrap({ recv: { k: 'type', t: ty }, name: 'ServeHTTP', line }) : null;
    }
    if (names.length === 1) {
      const lv = bc.locals.get(names[0]);
      if (lv && lv.k !== 'pvar') return wrap({ recv: lv, name: 'ServeHTTP', line });
    }
    const d = descOfNames(s, j, line);
    return d ? wrap(d) : null;
  }

  /** 인라인 핸들러 func(c *gin.Context) {…} → 별도 메서드 */
  function inlineFn([h0, h1]: [number, number]): FnDecl | undefined {
    if (t[h0]?.v !== 'func' || t[h0 + 1]?.v !== '(') return undefined;
    let o = closeOf(t, h0 + 1) + 1;
    while (o < h1 && t[o].v !== '{') {
      if (t[o].k === 'op' && (t[o].v === '(' || t[o].v === '[')) o = closeOf(t, o);
      o++;
    }
    if (o >= h1) return undefined;
    const close = closeOf(t, o);
    const line = fc.lineOf(t[h0].p);
    const im: MethodUnit = { name: `func@${line}`, line, endLine: fc.lineOf(t[close].p), routes: [], calls: [], sql: [], statements: [], views: [] };
    const d: FnDecl = {
      name: im.name, ...(decl.recv ? { recv: decl.recv } : {}), ...(decl.recvVar ? { recvVar: decl.recvVar } : {}), fc, method: im, result: null, calls: [],
      params: paramList(t, h0 + 1, fc), viewParams: [], inlineOf: decl.inlineOf ?? decl, usedIds: new Set(), usedQual: new Set(),
    };
    const sub: BodyCtx = { fc, decl: d, locals: new Map(bc.locals), routers: new Map(bc.routers), tmpl: new Map(bc.tmpl) };
    for (const p of d.params) if (p.name !== '_') sub.locals.set(p.name, { k: 'type', t: p.t });
    st.decls.push(d);
    analyzeBody(t, o + 1, close, sub, ctx);
    for (let q = h0; q < h1; q++) consumed.add(q);
    return d;
  }

  function viewCall(m: string, recvNames: string[], args: [number, number][]): void {
    let idx = -1;
    if ((m === 'HTML' || m === 'ExecuteTemplate') && args.length >= 2) idx = 1;
    else if (m === 'Render' && args.length >= 1) idx = args.length >= 3 || (args[1] && isLit(t, args[1]) && !isLit(t, args[0])) ? 1 : 0;
    const exec = m === 'Execute' && recvNames.length === 1;
    if (idx < 0 && !exec) return;
    if (exec) {
      const files = bc.tmpl.get(recvNames[0]) ?? st.pkgTmpl.get(`${fc.dir}|${recvNames[0]}`);
      if (files?.length) decl.method.views.push(files[files.length - 1]);
    }
    if (idx >= 0) {
      const ar = args[idx];
      const s = strArg(t, ar);
      if (s !== null && !s.includes('${v}')) decl.method.views.push(s);
      else {
        // render(w, name, data) 도우미: 매개변수 name 을 화면 이름으로 넘김
        const toks = t.slice(ar[0], ar[1]);
        const pi = decl.params.findIndex((p) => p.name !== '_' && toks.some((x) => x.k === 'id' && x.v === p.name));
        if (pi >= 0) {
          const at = toks.findIndex((x) => x.k === 'id' && x.v === decl.params[pi].name);
          let prefix = '';
          let suffix = '';
          for (let q = 0; q < at; q++) if (toks[q].k === 'str') prefix += toks[q].v;
          for (let q = at + 1; q < toks.length; q++) if (toks[q].k === 'str') suffix += toks[q].v;
          if (!decl.viewParams.some((v) => v.idx === pi)) decl.viewParams.push({ idx: pi, prefix, suffix });
          return;
        }
      }
    }
    if (!decl.viewParams.length) {
      // templateCache[page].ExecuteTemplate(w, "base", …): 이름이 page·name·tmpl 인 매개변수가 화면 이름
      const pi = decl.params.findIndex((p) => /^(page|name|tmpl|tpl|template|view|file|filename|tmplname|templatename|pagename|viewname)$/i.test(p.name));
      if (pi >= 0) decl.viewParams.push({ idx: pi, prefix: '', suffix: '' });
    }
  }

  function gormChain(start: number, firstOpen: number, firstName: string, recv: Expr, recvName: string): void {
    const calls: { name: string; open: number }[] = [{ name: firstName, open: firstOpen }];
    let k = closeOf(t, firstOpen) + 1;
    while (t[k]?.v === '.' && t[k + 1]?.k === 'id' && t[k + 2]?.v === '(') {
      calls.push({ name: t[k + 1].v, open: k + 2 });
      k = closeOf(t, k + 2) + 1;
    }
    let table: string | undefined;
    let model: Expr | undefined;
    const crud = new Set<Crud>();
    const joins: string[] = [];
    const preloads: string[] = [];
    let raw = false;
    let unknownTable = false;
    const modelOf = (ar: [number, number] | undefined): Expr | undefined => {
      if (!ar) return undefined;
      const x = t[ar[0]];
      if (x.k === 'str' || x.k === 'num' || x.v === 'nil') return undefined;
      const e = exprAt(t, ar[0], ar[1], bc, fc);
      return e === UNKNOWN ? undefined : e;
    };
    for (const c of calls) {
      const args = argsOf(t, c.open);
      if (c.name === 'Table') {
        const s = args[0] ? strArg(t, args[0]) : null;
        if (s && !s.startsWith('${v}')) table = s.trim().split(/\s+/)[0].replace(/[`"]/g, '');
        else if (args[0]) {
          // Table(data.TableName()) → data 의 모델, 그 밖의 식은 테이블을 모름
          const [a0, b0] = args[0];
          if (b0 - a0 >= 5 && t[b0 - 3]?.v === 'TableName' && t[b0 - 4]?.v === '.' && t[b0 - 2]?.v === '(' && t[b0 - 1]?.v === ')') model = modelOf([a0, b0 - 4]) ?? model;
          else unknownTable = true;
        }
      } else if (c.name === 'Model') {
        model = modelOf(args[0]) ?? model;
        unknownTable = false;
      }
      else if (c.name === 'Joins' || c.name === 'InnerJoins') {
        const s = args[0] ? strArg(t, args[0]) : null;
        const jm = s ? /\bJOIN\s+[`"]?(\w+)/i.exec(s) : null;
        if (jm) joins.push(jm[1]);
        else if (s && /^\w+$/.test(s)) preloads.push(s);
      } else if (c.name === 'Preload') {
        const s = args[0] ? strArg(t, args[0]) : null;
        if (s && /^[\w.]+$/.test(s)) preloads.push(s.split('.')[0]);
      } else if (c.name === 'Raw' || c.name === 'Exec') raw = true;
      else if (GORM_READ.has(c.name)) {
        crud.add('R');
        if (!model && !unknownTable && !['Count', 'Pluck', 'Row', 'Rows'].includes(c.name)) model = modelOf(args[0]);
      } else if (GORM_WRITE[c.name]) {
        for (const x of GORM_WRITE[c.name]) crud.add(x);
        if (!model && !unknownTable) model = modelOf(args[0]);
      }
    }
    if (raw || !crud.size || (!table && !model)) return;
    st.gorm.push({
      decl, recv, ...(model ? { model } : {}), ...(table ? { table } : {}), crud: (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => crud.has(c)), joins, preloads,
      line: fc.lineOf(t[start].p), desc: `${recvName}.${calls.map((c) => `${c.name}()`).join('.')} (GORM)`,
    });
  }
}

// ------------------------------------------------------------------ 템플릿 화면

const JAVA_WEB = /(^|\/)(src\/main\/webapp|WebContent|WebRoot|src\/main\/resources\/(templates|static|public)|WEB-INF)\//;
const FRAGMENT_NAME = /^(_|header|footer|nav|navbar|menu|sidebar|layout|base|head|partials?)/i;

function analyzeTemplate(f: FileInfo, text: string, ctx: Ctx, st: GoState): void {
  const lineOf = makeLineIndex(text);
  const defines = [...text.matchAll(/\{\{-?\s*define\s+"([^"]+)"/g)].map((m) => m[1]);
  const uses = [...text.matchAll(/\{\{-?\s*(?:template|block)\s+"([^"]+)"/g)].map((m) => m[1]);
  const flat = text.replace(/\{\{[\s\S]*?\}\}/g, (x) => (x.length >= 3 && !/\n/.test(x.slice(0, 3)) ? `{x}${x.slice(3).replace(/[^\n]/g, ' ')}` : x.replace(/[^\n]/g, ' ')));
  const view: ViewFact = { file: f.id, kind: 'template', urls: [], includes: [], scripts: [] };
  const title = extractTitle(flat);
  if (title && !/^\{x\}/.test(title.title)) {
    view.title = title.title;
    view.titleLine = lineOf(title.offset);
  }
  for (const r of extractRefs(flat)) {
    const n = normalizeRef(r.url, '/');
    if (!n) continue;
    const u: UrlRef = { url: n, kind: r.kind, file: f.id, line: lineOf(r.offset), ...(r.method ? { method: r.method } : {}) };
    view.urls.push(u);
  }
  if (FRAGMENT_NAME.test(f.name) || /\/(partials?|layouts?|includes?|components|shared)\//i.test(f.path)) view.fragment = true;
  const outside = text.replace(/\{\{-?\s*define[\s\S]*?\{\{-?\s*end\s*-?\}\}/g, '').trim();
  ctx.facts.views.push(view);
  st.templates.set(f.id, { view, file: f, defines, uses, onlyDefines: defines.length > 0 && outside.length < 20 });
  f.layer = 'VIEW';
  ctx.hit('화면', 'Go 템플릿', f.id, 1, 0.5);
}

// ------------------------------------------------------------------ 2단계: 잇기

function finishGo(ctx: Ctx, st: GoState): void {
  // ---- 메서드 색인
  const methods = new Map<string, FnDecl[]>(); // dir|Type|name
  const pkgFns = new Map<string, FnDecl[]>(); // dir|name
  const typeMethods = new Map<string, Set<string>>(); // dir|Type → 메서드 이름들
  const push = <V>(m: Map<string, V[]>, k: string, v: V) => {
    const x = m.get(k);
    if (x) x.push(v);
    else m.set(k, [v]);
  };
  for (const d of st.decls) {
    if (d.inlineOf) continue;
    if (d.recv) {
      push(methods, `${d.fc.dir}|${d.recv}|${d.name}`, d);
      const k = `${d.fc.dir}|${d.recv}`;
      if (!typeMethods.has(k)) typeMethods.set(k, new Set());
      typeMethods.get(k)!.add(d.name);
    } else push(pkgFns, `${d.fc.dir}|${d.name}`, d);
  }

  // ---- 인터페이스 구현체 (메서드 집합 포함 관계)
  const implCache = new Map<string, TRef[]>();
  const ifaceMethods = (key: string, depth = 0): Set<string> => {
    const def = st.ifaces.get(key);
    const out = new Set<string>(def?.methods ?? []);
    if (def && depth < 4) for (const e of def.embeds) for (const m of ifaceMethods(keyOf(e), depth + 1)) out.add(m);
    return out;
  };
  const isMock = (key: string) => {
    const [dir, name] = key.split('|');
    return /(^|\/)(mocks?|fakes?|testdata|testutil)(\/|$)/i.test(dir) || /^(mock|fake|stub)/i.test(name) || /Mock$/.test(name);
  };
  function implementors(key: string): TRef[] {
    const hit = implCache.get(key);
    if (hit) return hit;
    const need = ifaceMethods(key);
    let out: TRef[] = [];
    if (need.size) {
      for (const [tk, ms] of typeMethods) {
        if (isMock(tk)) continue;
        let ok = true;
        for (const n of need) {
          if (!ms.has(n)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          const [dir, name] = tk.split('|');
          out.push({ dir, name });
        }
      }
      // 인터페이스와 같은 패키지의 구현체가 있으면 그것만 (Go 관례), 없으면 흔한 메서드 집합일 때 이름이 닮은 것만
      const idir = key.split('|')[0];
      const same = out.filter((r) => r.dir === idir);
      if (same.length) out = same;
      else if (out.length > 3) {
        const iname = key.split('|')[1].toLowerCase().replace(/^i(?=[a-z])/, '');
        out = out.filter((r) => r.name.toLowerCase().includes(iname) || iname.includes(r.name.toLowerCase()));
      }
    }
    implCache.set(key, out);
    return out;
  }

  // ---- 타입 풀기
  const typeMemo = new Map<Expr, TRef | null>();
  const visiting = new Set<Expr>();
  function typeOf(e: Expr): TRef | null {
    if (e.k === 'type') return e.t;
    if (e.k === 'pkg') return null;
    if (typeMemo.has(e)) return typeMemo.get(e)!;
    if (visiting.has(e) || visiting.size > 60) return null;
    visiting.add(e);
    let r: TRef | null = null;
    if (e.k === 'pvar') {
      const x = st.pkgVars.get(`${e.dir}|${e.name}`);
      r = x ? typeOf(x) : null;
    } else if (e.k === 'sel') {
      const b = typeOf(e.base);
      r = b ? (b.ext ? EXT : fieldType(b, e.name, 0)) : null;
    } else {
      const rt = e.c.recv.k === 'pkg' ? null : typeOf(e.c.recv);
      if (rt?.ext) r = /gorm/.test(rt.path ?? '') ? rt : EXT;
      else {
        for (const d of callTargets(e.c)) {
          if (d.result) {
            r = d.result;
            break;
          }
        }
      }
    }
    visiting.delete(e);
    typeMemo.set(e, r);
    return r;
  }
  function resolveAlias(r: TRef): TRef {
    let cur = r;
    for (let i = 0; i < 4 && !cur.ext; i++) {
      const x = st.aliases.get(keyOf(cur));
      if (!x) break;
      cur = x;
    }
    return cur;
  }
  function fieldType(ty0: TRef, name: string, depth: number): TRef | null {
    const sd = st.structs.get(keyOf(resolveAlias(ty0)));
    if (!sd) return null;
    if (sd.fields.has(name)) return sd.fields.get(name) ?? null;
    if (depth < 3) for (const e of sd.embedded) {
      if (e.ext) continue;
      const r = fieldType(e, name, depth + 1);
      if (r) return r;
    }
    return null;
  }
  function methodsOf(ty0: TRef, name: string, depth: number): FnDecl[] {
    if (ty0.ext) return [];
    const key = keyOf(resolveAlias(ty0));
    const direct = methods.get(`${key}|${name}`);
    if (direct) return direct;
    if (depth > 3) return [];
    const sd = st.structs.get(key);
    if (sd) for (const e of sd.embedded) {
      const r = methodsOf(e, name, depth + 1);
      if (r.length) return r;
    }
    if (st.ifaces.has(key)) {
      const out: FnDecl[] = [];
      for (const impl of implementors(key)) out.push(...methodsOf(impl, name, depth + 1));
      return out;
    }
    return [];
  }
  const callMemo = new Map<CallDesc, FnDecl[]>();
  function callTargets(c: CallDesc): FnDecl[] {
    const hit = callMemo.get(c);
    if (hit) return hit;
    callMemo.set(c, []);
    let out: FnDecl[] = [];
    if (c.recv.k === 'pkg') out = pkgFns.get(`${c.recv.dir}|${c.name}`) ?? [];
    else if (c.recv.k === 'pvar' && !st.pkgVars.has(`${c.recv.dir}|${c.recv.name}`)) {
      // 패키지 변수가 아니면 같은 패키지의 타입 이름(T.Method 함수값)일 수도
      out = methods.get(`${c.recv.dir}|${c.recv.name}|${c.name}`) ?? [];
    } else {
      const ty = typeOf(c.recv);
      if (ty && !ty.ext) out = methodsOf(ty, c.name, 0);
    }
    callMemo.set(c, out);
    return out;
  }
  const isExternal = (c: CallDesc) => c.recv.k !== 'pkg' && !!typeOf(c.recv)?.ext;

  // ---- 유닛 만들기 (파일 × 받는 타입)
  const routeHandlers = new Set<FnDecl>();
  for (const r of st.routes) {
    if (r.inline) routeHandlers.add(r.inline);
    if (r.handler) for (const d of callTargets(r.handler)) routeHandlers.add(d);
    if (r.handler && r.factory && !callTargets(r.handler).length) for (const d of callTargets(r.factory)) routeHandlers.add(d);
  }
  const unitOf = new Map<string, CodeUnit>();
  for (const d of st.decls) {
    const owner = d.inlineOf ?? d;
    const recv = owner.recv;
    const k = `${owner.fc.f.id}#${recv ?? ''}`;
    let u = unitOf.get(k);
    if (!u) {
      const sd = recv ? st.structs.get(`${owner.fc.dir}|${recv}`) : undefined;
      const fields: Record<string, string> = {};
      if (sd) for (const [n, ty] of sd.fields) fields[n] = ty ? ty.name : '';
      u = ctx.addUnit({
        file: owner.fc.f.id, name: recv ?? owner.fc.pkg, fqn: `go:${owner.fc.f.id}#${recv ?? ''}`, kind: kindOf(recv ?? '', owner.fc.f.layer),
        line: sd && sd.file === owner.fc.f ? sd.line : owner.method.line, extendsOrImplements: [], fields, methods: [],
      });
      unitOf.set(k, u);
    }
    u.methods.push(d.method);
    d.unit = u;
  }
  for (const d of routeHandlers) if (d.unit && d.unit.kind === 'other') d.unit.kind = 'controller';

  // ---- 호출 → CallRef (풀린 것은 대상 유닛 fqn)
  for (const d of st.decls) {
    for (const c of d.calls) {
      const targets = callTargets(c);
      if (!targets.length) {
        if (!c.gorm && !isExternal(c) && c.recv.k !== 'pkg' && c.name.length >= 5) d.method.calls.push({ via: '', method: c.name, line: c.line });
        continue;
      }
      for (const tg of targets) {
        if (!tg.unit) continue;
        const via = `${tg.unit === d.unit ? 'this.' : ''}${tg.unit.fqn}`;
        if (!d.method.calls.some((x) => x.via === via && x.method === tg.name)) d.method.calls.push({ via, method: tg.name, line: c.line });
        // 화면 이름을 넘기는 render 도우미
        if (tg.viewParams.length && c.strArgs) {
          for (const vp of tg.viewParams) {
            const s = c.strArgs[vp.idx];
            if (s) d.method.views.push(`${vp.prefix}${s}${vp.suffix}`);
          }
        }
      }
    }
  }

  // ---- 템플릿 이름 → 파일 ({{define "x"}} 또는 파일 이름), 조각 판정
  const tmpls = [...st.templates.values()];
  const defIndex = new Map<string, Tmpl | null>();
  for (const x of tmpls) for (const dn of x.defines) defIndex.set(dn, defIndex.has(dn) && defIndex.get(dn) !== x ? null : x);
  const byName = (v: string): Tmpl | undefined => {
    const n = v.replace(/^\.?\//, '');
    return tmpls.find((x) => x.file.path === n || x.file.path.endsWith(`/${n}`)) ?? tmpls.find((x) => /\.\w+$/.test(n) ? false : x.file.path.replace(/\.\w+$/, '').endsWith(`/${n}`));
  };
  const rendered = new Set<Tmpl>();
  for (const d of st.decls) {
    const out: string[] = [];
    for (const v of d.method.views) {
      const x = byName(v) ?? defIndex.get(v) ?? undefined;
      if (x && !d.viewParams.length) rendered.add(x);
      const name = x && !byName(v) ? x.file.path : v.replace(/^\.?\//, '');
      if (!out.includes(name)) out.push(name);
    }
    d.method.views = out;
  }
  const included = new Set<Tmpl>();
  for (const x of tmpls) {
    for (const u of x.uses) {
      const target = defIndex.get(u) ?? tmpls.find((y) => y.file.name === u || y.file.name === baseName(u));
      if (!target || target === x) continue;
      if (!x.view.includes.includes(target.file.path)) x.view.includes.push(target.file.path);
      included.add(target);
    }
  }
  for (const x of tmpls) {
    if (rendered.has(x)) delete x.view.fragment;
    else if (included.has(x) || x.onlyDefines) x.view.fragment = true;
  }

  // ---- 라우터 접두어
  const prefixMemo = new Map<RouterObj, string[]>();
  function prefixesOf(r: RouterObj, depth = 0): string[] {
    const hit = prefixMemo.get(r);
    if (hit) return hit;
    if (depth > 8) return [''];
    prefixMemo.set(r, ['']);
    let base: string[];
    if (r.parent) base = prefixesOf(r.parent, depth + 1);
    else if (r.mounts.length) base = r.mounts.flatMap((m) => prefixesOf(m.router, depth + 1).map((p) => joinPath(p, m.prefix)));
    else if (r.param) base = paramPrefixes(r.param.decl, r.param.idx, depth);
    else if (r.owner && st.mountSites.length) {
      const sites = st.mountSites.filter((s) => callTargets(s.call).some((d) => d.retRouter === r));
      base = sites.length ? sites.flatMap((s) => prefixesOf(s.router, depth + 1).map((p) => joinPath(p, s.prefix))) : [''];
    } else base = [''];
    const out = [...new Set(base.map((b) => (r.prefix ? joinPath(b, r.prefix) : b)))];
    prefixMemo.set(r, out);
    return out;
  }
  const sliceMemo = new Map<string, FnDecl[]>();
  const sliceTargets = (key: string): FnDecl[] => {
    let v = sliceMemo.get(key);
    if (!v) {
      v = (st.fnSlices.get(key) ?? []).flatMap((d) => callTargets(d));
      sliceMemo.set(key, v);
    }
    return v;
  };
  function paramPrefixes(decl: FnDecl, idx: number, depth: number): string[] {
    const sites = st.routerArgs.filter((x) => x.idx === idx && (callTargets(x.call).includes(decl) || (!!x.call.slice && sliceTargets(x.call.slice).includes(decl))));
    if (sites.length) return [...new Set(sites.flatMap((s) => prefixesOf(s.router, depth + 1)))];
    // 함수값으로 넘겨 나중에 부르는 경우 f(v1): 풀리지 않은 호출 중 같은 자리의 라우터
    const loose = st.routerArgs.filter((x) => x.idx === idx && !callTargets(x.call).length);
    const ps = [...new Set(loose.flatMap((s) => prefixesOf(s.router, depth + 1)))];
    return ps.length === 1 ? ps : [''];
  }

  // ---- 라우트 → 핸들러 메서드
  for (const r of st.routes) {
    let targets: FnDecl[] = r.inline ? [r.inline] : r.handler ? callTargets(r.handler) : [];
    if (!targets.length && r.factory) targets = callTargets(r.factory);
    for (const prefix of targets.length ? prefixesOf(r.router) : []) {
      const path = joinPath(prefix, r.path);
      for (const d of targets) {
        if (d.method.routes.some((x) => x.path === path && x.method === r.method)) continue;
        d.method.routes.push({ method: r.method, path, line: d.method.line, ...(d.method.views.length ? {} : { api: true }) });
      }
    }
  }

  // ---- SQL 상수 참조
  for (const d of st.decls) {
    for (const n of d.usedIds) for (const id of st.consts.get(`${d.fc.dir}|${n}`) ?? []) if (!d.method.sql.includes(id)) d.method.sql.push(id);
    for (const q of d.usedQual) for (const id of st.consts.get(q) ?? []) if (!d.method.sql.includes(id)) d.method.sql.push(id);
  }

  for (const [k, ref] of st.tableNameRefs) {
    const v = st.strConsts.get(ref);
    if (v && !st.tableNames.has(k)) st.tableNames.set(k, v);
  }

  // ---- GORM → SQL
  // 테이블 이름: TableName() > 이름 규칙(단수·접두어). DDL 에 없으면 접두어·단복수만 다른 DDL 테이블이 하나뿐일 때 그것
  const ddlNames = ctx.facts.ddl.map((d) => d.name);
  const ddlLower = new Map(ddlNames.map((n) => [n.toLowerCase(), n] as const));
  const reconcile = (name: string): string => {
    if (!ddlLower.size || ddlLower.has(name.toLowerCase())) return ddlLower.get(name.toLowerCase()) ?? name;
    const forms = new Set([name, singularWord(name), `${name}s`, snakePlural(name)].map((x) => x.toLowerCase()));
    const cands = [...ddlLower.keys()].filter((d) => forms.has(d) || [...forms].some((f) => d.endsWith(`_${f}`)));
    return cands.length === 1 ? ddlLower.get(cands[0])! : name;
  };
  const tableOfType = (ty: TRef): string => {
    const own = st.tableNames.get(keyOf(ty));
    if (own) return reconcile(own);
    const snake = snakePlural(ty.name);
    const base = st.gormSingular ? singularWord(snake) : snake;
    return reconcile(`${st.gormPrefix ?? ''}${base}`);
  };
  const modelTypes = new Map<string, TRef>();
  for (const k of st.tableNames.keys()) {
    const [dir, name] = k.split('|');
    modelTypes.set(k, { dir, name });
  }
  for (const e of st.migrate) {
    const ty = typeOf(e);
    if (ty && !ty.ext) modelTypes.set(keyOf(ty), ty);
  }
  for (const op of st.gorm) {
    const rt = typeOf(op.recv);
    if (rt && !rt.ext) continue; // 프로젝트 타입의 메서드 (GORM 아님)
    if (rt?.ext && rt !== EXT && !/gorm/.test(rt.path ?? '')) continue;
    const mt = op.model ? typeOf(op.model) : null;
    const model = mt && !mt.ext && st.structs.has(keyOf(resolveAlias(mt))) ? resolveAlias(mt) : null;
    const table = op.table ?? (model ? tableOfType(model) : undefined);
    if (!table) continue;
    if (model) modelTypes.set(keyOf(model), model);
    const tables: TableRef[] = op.crud.map((c) => ({ name: table, crud: c }));
    for (const j of op.joins) tables.push({ name: j, crud: 'R' });
    if (model) {
      for (const p of op.preloads) {
        const ft = fieldType(model, p, 0);
        if (ft && !ft.ext && st.structs.has(keyOf(ft))) {
          modelTypes.set(keyOf(ft), ft);
          const tn = tableOfType(ft);
          if (!tables.some((x) => x.name === tn)) tables.push({ name: tn, crud: 'R' });
        }
      }
    }
    const crud = new Set(op.crud);
    const kind = crud.has('C') ? 'insert' : crud.has('U') ? 'update' : crud.has('D') ? 'delete' : 'select';
    const s = ctx.addSql({ file: op.decl.fc.f.id, line: op.line, origin: 'orm', kind, tables, text: op.desc });
    op.decl.method.sql.push(s.id);
    st.sqlFiles.add(op.decl.fc.f);
    ctx.hit('데이터 접근', 'GORM', op.decl.fc.f.id, op.line, 1);
  }

  // ---- 라이브러리를 모르는 파일의 SQL: 프로젝트가 쓰는 라이브러리로
  const lib = st.sqlLibs.has('sqlx') ? 'sqlx' : st.sqlLibs.has('pgx') ? 'pgx' : st.sqlLibs.has('database/sql') || !st.usesGorm ? 'database/sql' : null;
  if (lib) for (const x of st.looseSql) ctx.hit('데이터 접근', SQL_LIB_NAME[lib], x.file, x.line, 1);

  // ---- SQL 이 있는 기타 파일(라우트 핸들러 없음)은 데이터 접근 계층
  const handlerFiles = new Set([...routeHandlers].map((d) => d.fc.f));
  for (const f of st.sqlFiles) if (f.layer === 'OTHER' && !handlerFiles.has(f)) f.layer = 'DAO';

  // ---- 모델 유닛
  for (const [k, ty] of modelTypes) {
    const sd = st.structs.get(k);
    const table = tableOfType(ty);
    let found = false;
    for (const [uk, u] of unitOf) {
      if (!uk.endsWith(`#${ty.name}`) || dirName(ctx.byId.get(u.file)?.path ?? '') !== ty.dir) continue;
      u.kind = 'model';
      u.table = table;
      found = true;
    }
    if (!found && sd) {
      const fields: Record<string, string> = {};
      for (const [n, ft] of sd.fields) fields[n] = ft ? ft.name : '';
      ctx.addUnit({ file: sd.file.id, name: ty.name, fqn: `go:${sd.file.id}#${ty.name}`, kind: 'model', line: sd.line, extendsOrImplements: [], fields, methods: [], table });
    }
    if (sd && sd.file.layer === 'OTHER') sd.file.layer = 'MODEL';
  }
}

function kindOf(name: string, layer: FileInfo['layer']): CodeUnit['kind'] {
  if (/(Handler|Controller|Api|API|Endpoint|Resource)s?$/.test(name)) return 'controller';
  if (/(Service|Svc|Usecase|UseCase|Logic|Biz|Manager)$/.test(name)) return 'service';
  if (/(Repository|Repo|Store|Dao|DAO|Storage|Mapper|Querier|Queries|Model)$/.test(name)) return 'dao';
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

export const goAnalyzer: Analyzer = {
  name: 'go',
  order: 26,
  accepts: (f) => f.lang === 'Go' || f.lang === 'HTML' || f.lang === 'Template',
  analyze(f, text, ctx) {
    const st = state(ctx);
    if (f.lang === 'Go') {
      if (f.layer === 'TEST' || /\.pb(\.gw)?\.go$|_mock\.go$|^mock_/.test(f.name)) return;
      analyzeGoFile(f, text, ctx, st);
      return;
    }
    // 템플릿: Go 프로젝트(go.mod 폴더 아래)의 templates·views 폴더 또는 .tmpl/.gohtml
    if (!st.goDirs.size) return;
    if (st.modules.length && !st.modules.some((m) => m.dir === '' || f.path.startsWith(`${m.dir}/`))) return;
    if (JAVA_WEB.test(f.path) || /(^|\/)(static|public|assets|dist)\//i.test(f.path)) return;
    if (!(/\.(tmpl|gohtml|tpl)$/i.test(f.name) || /(^|\/)(templates?|views|html)\//i.test(f.path))) return;
    analyzeTemplate(f, text, ctx, st);
  },
  finish(ctx) {
    const st = states.get(ctx);
    if (st && (st.decls.length || st.templates.size)) finishGo(ctx, st);
  },
};
