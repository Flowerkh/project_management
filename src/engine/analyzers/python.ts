// 파이썬 분석기: Django(urls.py·함수 뷰·클래스 뷰·DRF·ORM·템플릿), Flask(Blueprint·SQLAlchemy·Jinja2),
// FastAPI(APIRouter·SQLModel), DB 드라이버를 쓰는 배치 스크립트.
// 2단계로 돈다: 파일마다 import·클래스·함수·호출·ORM·SQL 을 모으고(analyze),
// 끝에서(finish) 모듈·심볼을 풀어 라우트·모델 테이블·호출 대상·템플릿 URL 을 잇는다.
// 풀린 호출은 via 에 대상 유닛의 fqn(py:<모듈>[.<클래스>])을 넣어 연결 단계가 이름 추측 없이 따라가게 한다.
import type { Analyzer, Ctx } from '../context';
import type { BatchFact, CodeUnit, Crud, FileInfo, MethodUnit, SqlFact, TableRef, UrlRef, ViewFact } from '../types';
import { baseName, dirName, makeLineIndex } from '../files';
import { cronText } from '../link';
import { compactSql, isSqlLike, parseSql } from '../sql';
import { tidyTitle } from './batch';
import { snakeCase } from './inflect';
import { menuAnalyzer } from './menu';
import {
  argExpr, argString, argStrings, docstringAt, findStr, matchParen, moduleRanges, ownRanges, parseBlocks, scanPy, splitArgs, stringsIn,
} from './python-lex';
import type { PyArg, PyBlocks, PyDef, PyScan, PyStr } from './python-lex';
import { extractRefs, extractScripts, extractTitle, normalizeRef } from './web-refs';

// ------------------------------------------------------------------ 모으는 구조

type Ranges = [number, number][];

interface PyImport {
  module: string;
  name?: string;
  level: number;
  line: number;
  /** import a.b.c (별칭 없음): 지역 이름은 a */
  plain?: boolean;
}

interface PyAttr {
  /** 값 식(뼈대, 문자열 안은 공백) */
  expr: string;
  pos: number;
  end: number;
  line: number;
  /** 값이 문자열 리터럴이면 그 값 */
  str?: string;
  ann?: string;
}

interface VarInfo {
  cls?: string;
  constructed?: boolean;
  /** 쿼리셋·쿼리 (여러 건) */
  qs?: boolean;
  /** form.save(commit=False) 로 받은 객체 */
  formVar?: string;
  instance?: boolean;
  firstPos?: boolean;
}

interface OrmRaw {
  model: string;
  crud: Crud[];
  line: number;
  desc: string;
  joins: string[];
  /** Model.<manager>.filter() 의 매니저 이름 */
  mgr?: string;
  /** self.queryset / self.model (클래스 뷰의 모델) */
  self?: boolean;
  /** SQLAlchemy Core Table 변수 후보 */
  table?: boolean;
}

interface VarOp {
  v: string;
  op: 'save' | 'delete' | 'add' | 'merge' | 'update';
  line: number;
}

interface RedirRaw {
  kind: 'name' | 'path' | 'endpoint';
  value: string;
}

interface RawCall {
  chain: string;
  line: number;
}

interface DecoRaw {
  chain: string;
  args: PyArg[];
  line: number;
}

interface TplUse {
  name?: string;
  expr?: string;
  line: number;
}

interface PyFunc {
  mod: PyMod;
  def?: PyDef;
  name: string;
  cls?: PyClass;
  outer?: PyFunc;
  method: MethodUnit;
  ranges: Ranges;
  calls: RawCall[];
  orm: OrmRaw[];
  varOps: VarOp[];
  vars: Map<string, VarInfo>;
  params: Map<string, string>;
  tpls: TplUse[];
  redirs: RedirRaw[];
  constRefs: Set<string>;
  decos: DecoRaw[];
  hasSuper: boolean;
  children: PyFunc[];
  targets: Set<PyFunc>;
}

interface PyClass {
  mod: PyMod;
  def: PyDef;
  name: string;
  bases: string[];
  kw: Map<string, string>;
  attrs: Map<string, PyAttr>;
  meta: Map<string, PyAttr>;
  methods: Map<string, PyFunc>;
  decos: DecoRaw[];
  fields: Map<string, string>;
  doc?: string;
  synth: MethodUnit[];
  sqlConsts: Map<string, string>;
}

interface FwObj {
  mod: PyMod;
  v: string;
  kind: 'flask' | 'bp' | 'fastapi' | 'router' | 'api';
  /** Blueprint 이름 (엔드포인트 접두어) */
  name: string;
  prefix?: string;
  prefixExpr?: string;
  /** flask-restful Api(app_or_bp) 의 대상 */
  target?: string;
  line: number;
}

interface FwInclude {
  mod: PyMod;
  parent: string;
  child: string;
  prefix?: string;
  prefixExpr?: string;
  line: number;
}

interface UrlRule {
  mod: PyMod;
  recv: string;
  rule?: string;
  urls?: string[];
  endpoint?: string;
  view: PyArg;
  methods: string[];
  line: number;
  resource?: boolean;
}

interface DrfReg {
  prefix: string;
  viewset: string;
  basename?: string;
  line: number;
}

interface PyMod {
  f: FileInfo;
  text: string;
  scan: PyScan;
  blocks: PyBlocks;
  lineOf: (o: number) => number;
  /** 논리 줄 시작 위치 */
  logical: Set<number>;
  dotted: string;
  /** 상대 import 기준 패키지 */
  pkg: string;
  imports: Map<string, PyImport>;
  stars: PyImport[];
  consts: Map<string, PyAttr>;
  classes: Map<string, PyClass>;
  funcs: Map<string, PyFunc>;
  all: PyFunc[];
  modFn: PyFunc;
  doc?: string;
  hasMain: boolean;
  driver?: string;
  web: boolean;
  runsApp: boolean;
  fw: Map<string, FwObj>;
  fwIncludes: FwInclude[];
  urlRules: UrlRule[];
  drf: Map<string, DrfReg[]>;
  /** DefaultRouter(trailing_slash=False) */
  drfNoSlash: Set<string>;
  urlpatterns: boolean;
  rootUrlconf?: string;
  appName?: string;
  saTables: Map<string, string>;
  sqlConsts: Map<string, string>;
  logs: string[];
  synth: MethodUnit[];
  sqlIds: string[];
  importedBy: number;
}

interface TplRec {
  f: FileInfo;
  text: string;
  view: ViewFact;
  marks: { ref: UrlRef; name: string; kind: 'dj' | 'ep' }[];
  rels: { ref: UrlRef; raw: string }[];
  incs: string[];
}

interface PyState {
  mods: PyMod[];
  tplCands: { f: FileInfo; text: string }[];
}

const states = new WeakMap<Ctx, PyState>();
function state(ctx: Ctx): PyState {
  let s = states.get(ctx);
  if (!s) {
    s = { mods: [], tplCands: [] };
    states.set(ctx, s);
  }
  return s;
}

// ------------------------------------------------------------------ 공통 도구

const lastSeg = (d: string) => d.slice(d.lastIndexOf('.') + 1);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

function dottedOf(path: string): string {
  return path.replace(/\.py$/i, '').split('/').join('.').replace(/\.__init__$/, '');
}

/** 논리 문장 끝 (괄호 안 줄바꿈·\ 이어짐 포함) */
function stmtEnd(skel: string, p: number): number {
  let depth = 0;
  for (let i = p; i < skel.length; i++) {
    const c = skel[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth > 0) depth--;
    } else if (c === '\n' && depth === 0) {
      let k = i - 1;
      while (k >= p && (skel[k] === ' ' || skel[k] === '\t' || skel[k] === '\r')) k--;
      if (skel[k] !== '\\') return i;
    }
  }
  return skel.length;
}

/** 식별자·멤버·호출·첨자로 된 식 하나의 끝 */
function skipExpr(skel: string, k: number): number {
  if (skel[k] === '(' || skel[k] === '[') {
    const c = matchParen(skel, k);
    return c < 0 ? -1 : c + 1;
  }
  const m = /^[A-Za-z_]\w*/.exec(skel.slice(k, k + 200));
  if (!m) return -1;
  let i = k + m[0].length;
  for (let g = 0; g < 30; g++) {
    if (skel[i] === '.') {
      const m2 = /^\.[A-Za-z_]\w*/.exec(skel.slice(i, i + 200));
      if (!m2) break;
      i += m2[0].length;
      continue;
    }
    if (skel[i] === '(' || skel[i] === '[') {
      const c = matchParen(skel, i);
      if (c < 0) return -1;
      i = c + 1;
      continue;
    }
    break;
  }
  return i;
}

function lowerBound(lines: PyBlocks['lines'], pos: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Stmt {
  p: number;
  end: number;
  text: string;
}

/** 범위 안 논리 문장들 */
function stmts(mod: PyMod, ranges: Ranges): Stmt[] {
  const out: Stmt[] = [];
  const lines = mod.blocks.lines;
  const skel = mod.scan.skel;
  for (const [a, b] of ranges) {
    for (let i = lowerBound(lines, a); i < lines.length && lines[i].start < b; i++) {
      const L = lines[i];
      if (!L.logical) continue;
      let p = L.start;
      while (p < b && (skel[p] === ' ' || skel[p] === '\t')) p++;
      if (p >= b) continue;
      const end = Math.min(stmtEnd(skel, p), b);
      out.push({ p, end, text: skel.slice(p, end) });
    }
  }
  return out;
}

const ASSIGN = /^([A-Za-z_]\w*(?:[ \t]*\.[ \t]*[A-Za-z_]\w*)*)[ \t]*(?::[ \t]*([^=\n]+?))?[ \t]*(=|\+=)(?!=)[ \t]*/;

/** [a, b) 식이 문자열 리터럴로만 되어 있으면 이어 붙인 값 (f-string 의 {…} 가 있으면 없음) */
function strValue(mod: PyMod, a: number, b: number): string | undefined {
  const skel = mod.scan.skel;
  const strs = stringsIn(mod.scan, a, b);
  if (!strs.length) return undefined;
  let p = a;
  let v = '';
  for (const s of strs) {
    if (s.start >= b) break;
    if (!/^[\s()+\\]*$/.test(skel.slice(p, s.start))) return undefined;
    if (s.prefix.includes('f') && /\{[^{]/.test(s.value)) return undefined;
    v += s.value;
    p = s.end;
  }
  if (!/^[\s()+\\,]*$/.test(skel.slice(p, b))) return undefined;
  return v;
}

function attrFrom(mod: PyMod, m: RegExpExecArray, s: Stmt): PyAttr {
  const pos = s.p + m[0].length;
  return { expr: mod.scan.skel.slice(pos, s.end).trim(), pos, end: s.end, line: mod.lineOf(s.p), str: strValue(mod, pos, s.end), ...(m[2] ? { ann: m[2].trim() } : {}) };
}

function annType(ann: string): string | undefined {
  const t = ann
    .trim()
    .replace(/^Annotated\[\s*([^,\]]+)[\s\S]*$/, '$1')
    .replace(/^Optional\[\s*([\w.]+)\s*\]$/, '$1')
    .replace(/\s*\|\s*None$/, '')
    .replace(/^None\s*\|\s*/, '')
    .trim();
  return /^[A-Za-z_][\w.]*$/.test(t) && !/^(str|int|float|bool|bytes|dict|list|tuple|set|Any|None|object)$/.test(t) ? t : undefined;
}

// ------------------------------------------------------------------ 1단계: 파일 하나

function newFunc(mod: PyMod, name: string, def: PyDef | undefined, ranges: Ranges): PyFunc {
  return {
    mod, def, name, ranges,
    method: { name, line: def ? def.line : 1, ...(def ? { endLine: def.endLine } : {}), routes: [], calls: [], sql: [], statements: [], views: [] },
    calls: [], orm: [], varOps: [], vars: new Map(), params: new Map(), tpls: [], redirs: [], constRefs: new Set(), decos: [], hasSuper: false,
    children: [], targets: new Set(),
  };
}

function parseImports(mod: PyMod): void {
  const skel = mod.scan.skel;
  const re = /^[ \t]*(?:from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+|import[ \t]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skel))) {
    if (!mod.logical.has(m.index)) continue;
    const start = m.index + m[0].length;
    const end = stmtEnd(skel, m.index);
    const body = skel.slice(start, end).replace(/[()\\]/g, ' ');
    const line = mod.lineOf(m.index);
    if (m[1] !== undefined) {
      const level = m[1].length;
      const module = m[2];
      for (const part of body.split(',')) {
        const t = part.trim();
        if (!t) continue;
        if (t === '*') {
          mod.stars.push({ module, level, line });
          continue;
        }
        const mm = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(t);
        if (mm) mod.imports.set(mm[2] ?? mm[1], { module, name: mm[1], level, line });
      }
    } else {
      for (const part of body.split(',')) {
        const mm = /^\s*([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
        if (!mm) continue;
        if (mm[2]) mod.imports.set(mm[2], { module: mm[1], level: 0, line });
        else {
          const first = mm[1].split('.')[0];
          if (!mod.imports.has(first)) mod.imports.set(first, { module: first, level: 0, line, plain: true });
        }
      }
    }
    re.lastIndex = Math.max(re.lastIndex, end);
  }
}

function parseDecos(mod: PyMod, d: PyDef): DecoRaw[] {
  const out: DecoRaw[] = [];
  for (const x of d.decorators) {
    const m = /^\s*([A-Za-z_][\w.]*)\s*(\()?/.exec(x.text);
    if (!m) continue;
    const args = m[2] ? splitArgs(mod.scan.skel, x.start + m[0].length - 1) : [];
    out.push({ chain: m[1].replace(/\s+/g, ''), args, line: x.line });
  }
  return out;
}

function parseParams(mod: PyMod, fn: PyFunc): void {
  const d = fn.def;
  if (!d || d.paren < 0) return;
  for (const a of splitArgs(mod.scan.skel, d.paren)) {
    const m = /^\**([A-Za-z_]\w*)\s*(?::\s*([\s\S]+?))?\s*(?:=[\s\S]*)?$/.exec(a.text);
    if (!m || !m[2]) continue;
    let t = annType(m[2]);
    if (!t && /^["']/.test(m[2].trim())) {
      const colon = mod.scan.skel.indexOf(':', a.start);
      const s = colon >= 0 ? argString(mod.scan, { ...a, valueStart: colon + 1 }) : undefined;
      if (s) t = annType(s);
    }
    if (t) fn.params.set(m[1], t);
  }
}

/** 그룹 문자열의 값 (f-string 의 {식} → ${v}) */
function strText(s: PyStr): string {
  if (!s.prefix.includes('f')) return s.value;
  return s.value
    .replace(/\{\{/g, '\u0001')
    .replace(/\}\}/g, '\u0002')
    .replace(/\{[^{}]*\}/g, '${v}')
    .replace(/\u0001/g, '{')
    .replace(/\u0002/g, '}');
}

/** 이웃한 리터럴·+ 연결을 하나로 (중간 식은 ${v}) */
function joinStr(mod: PyMod, s0: PyStr): { text: string; parts: PyStr[] } {
  const skel = mod.scan.skel;
  const parts = [s0];
  let text = strText(s0);
  let end = s0.end;
  const skipWs = (k0: number): number => {
    let k = k0;
    while (k < skel.length) {
      const c = skel[k];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\\') k++;
      else if (c === '\n') {
        if (mod.logical.has(k + 1)) return skel.length;
        k++;
      } else break;
    }
    return k;
  };
  for (let g = 0; g < 80; g++) {
    let k = skipWs(end);
    if (k >= skel.length) break;
    let plus = false;
    if (skel[k] === '+' && skel[k + 1] !== '=') {
      plus = true;
      k = skipWs(k + 1);
      if (k >= skel.length) break;
    }
    const nx = findStr(mod.scan, k);
    if (nx) {
      parts.push(nx);
      text += strText(nx);
      end = nx.end;
      continue;
    }
    if (plus) {
      const e = skipExpr(skel, k);
      if (e < 0) break;
      if (!text.endsWith('${v}')) text += '${v}';
      end = e;
      continue;
    }
    if (skel.startsWith('.format', k)) text = text.replace(/\{[^{}]*\}/g, '${v}');
    break;
  }
  return { text, parts };
}

/** 문자열이 NAME = "…" 의 값이면 NAME */
function assignedName(mod: PyMod, pos: number): string | undefined {
  const lines = mod.blocks.lines;
  let i = lowerBound(lines, pos + 1) - 1;
  while (i >= 0 && !lines[i].logical) i--;
  if (i < 0) return undefined;
  const head = mod.scan.skel.slice(lines[i].start, pos);
  return /^\s*([A-Za-z_]\w*)\s*(?::\s*[^=\n]+)?=\s*[(\s\\]*$/.exec(head)?.[1];
}

const DRIVER_NAME: [RegExp, string][] = [
  [/^(cx_Oracle|oracledb)\b/, 'cx_Oracle'],
  [/^pymysql\b/, 'PyMySQL'],
  [/^MySQLdb\b/, 'mysqlclient'],
  [/^mysql\.connector\b|^mysql$/, 'MySQL Connector'],
  [/^(psycopg2?|psycopg)\b/, 'psycopg'],
  [/^asyncpg\b/, 'asyncpg'],
  [/^aiomysql\b/, 'aiomysql'],
  [/^pyodbc\b/, 'pyodbc'],
  [/^pymssql\b/, 'pymssql'],
  [/^sqlite3\b/, 'sqlite3'],
  [/^(ibm_db|jaydebeapi|mariadb)\b/, 'DB-API'],
  [/^(sqlalchemy|sqlmodel|flask_sqlalchemy)\b/, 'SQLAlchemy'],
];

function sqlPrep(t: string): string {
  return t.replace(/%\(\w+\)[sdf]/g, '${v}').replace(/%[sdf]/g, '${v}');
}

/** 범위 안 SQL 문자열 → SqlFact. consts 가 있으면 NAME = "SQL" 은 상수로 등록 */
function sqlStrings(mod: PyMod, ranges: Ranges, fn: PyFunc | undefined, ctx: Ctx, consts?: Map<string, string>): void {
  const used = new Set<number>();
  for (const [a, b] of ranges) {
    for (const s of stringsIn(mod.scan, a, b)) {
      if (used.has(s.start) || s.prefix.includes('b')) continue;
      const g = joinStr(mod, s);
      for (const p of g.parts) used.add(p.start);
      const sql = sqlPrep(g.text);
      if (sql.length < 12 || !isSqlLike(sql)) continue;
      const parsed = parseSql(sql);
      if (!parsed.tables.length) continue;
      const fact = ctx.addSql({
        file: mod.f.id, line: mod.lineOf(s.start), origin: 'string', kind: parsed.kind, tables: parsed.tables,
        ...(parsed.dynamic ? { dynamic: true } : {}), text: compactSql(sql),
      });
      mod.sqlIds.push(fact.id);
      const name = consts ? assignedName(mod, s.start) : undefined;
      if (name && consts) consts.set(name, fact.id);
      else if (fn) fn.method.sql.push(fact.id);
      const lib = mod.web && [...mod.imports.values()].some((i) => /^django\b/.test(i.module)) ? 'Django connection' : mod.driver && mod.driver !== 'SQLAlchemy' ? mod.driver : mod.driver === 'SQLAlchemy' ? null : 'DB-API';
      if (lib) ctx.hit('데이터 접근', `SQL 직접 작성(${lib})`, mod.f.id, fact.line, 1);
      else ctx.hit('데이터 접근', 'SQLAlchemy', mod.f.id, fact.line, 1);
    }
  }
}

function parseClassBody(mod: PyMod, c: PyClass, ctx: Ctx): void {
  const skel = mod.scan.skel;
  const d = c.def;
  if (d.paren >= 0) {
    for (const a of splitArgs(skel, d.paren)) {
      if (a.key) c.kw.set(a.key, argExpr(skel, a));
      else if (!a.text.startsWith('*')) c.bases.push(a.text.replace(/\s+/g, ''));
    }
  }
  c.decos = parseDecos(mod, d);
  c.doc = docstringAt(mod.scan, d.bodyStart);
  for (const s of stmts(mod, ownRanges(d))) {
    const m = ASSIGN.exec(s.text);
    if (m && !m[1].includes('.') && m[3] === '=') {
      c.attrs.set(m[1], attrFrom(mod, m, s));
      continue;
    }
    const an = /^([A-Za-z_]\w*)\s*:\s*([^=\n]+?)\s*$/.exec(s.text.trim());
    if (an) c.attrs.set(an[1], { expr: '', pos: s.p, end: s.end, line: mod.lineOf(s.p), ann: an[2] });
  }
  const meta = d.children.find((x) => x.kind === 'class' && x.name === 'Meta');
  if (meta) {
    for (const s of stmts(mod, ownRanges(meta))) {
      const m = ASSIGN.exec(s.text);
      if (m && !m[1].includes('.')) c.meta.set(m[1], attrFrom(mod, m, s));
    }
  }
  for (const [k, a] of c.attrs) {
    const t = a.ann ? annType(a.ann) : undefined;
    if (t) c.fields.set(k, t);
    else {
      const cm = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(/.exec(a.expr);
      if (cm) c.fields.set(k, cm[1]);
    }
  }
  sqlStrings(mod, ownRanges(d), undefined, ctx, c.sqlConsts);
}

const SINGLE = /\.\s*(?:get|first|last|latest|earliest|get_or_404|first_or_404|one|one_or_none|scalar|scalar_one|get_or_create|create|update_or_create)\s*\(/;
const SA_SINGLE = /\.\s*(?:first|one|one_or_none|scalar_one|scalar_one_or_none|scalar|get|first_or_404|get_or_404|one_or_404)\s*\(/;
const MODEL_CHAIN = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)/;

/** 대입 오른쪽 식 → 변수 정보 (모델 인스턴스·쿼리셋·폼) */
function varInfo(mod: PyMod, fn: PyFunc, a: number, b: number): VarInfo | undefined {
  const skel = mod.scan.skel;
  let s = a;
  while (s < b && /\s/.test(skel[s])) s++;
  const aw = /^await\s+/.exec(skel.slice(s, s + 12));
  if (aw) s += aw[0].length;
  const rhs = skel.slice(s, b).trim();
  let m: RegExpExecArray | null;
  if ((m = /^([a-z_]\w*)\s*\.\s*save\s*\(/.exec(rhs))) return { formVar: m[1] };
  if ((m = /^get_object_or_404\s*\(\s*((?:[A-Za-z_]\w*\.)*[A-Z]\w*)/.exec(rhs))) return { cls: m[1], constructed: false };
  if ((m = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\.\s*(?:objects|query|_default_manager)\b/.exec(rhs))) return SINGLE.test(rhs) ? { cls: m[1], constructed: false } : { cls: m[1], qs: true };
  if (/^self\s*\.\s*(?:queryset|get_queryset\s*\(\s*\)|model\s*\.\s*objects)/.test(rhs)) return SINGLE.test(rhs) ? { cls: '@model', constructed: false } : { cls: '@model', qs: true };
  if (/^self\s*\.\s*get_object\s*\(/.test(rhs)) return { cls: '@model', constructed: false };
  if ((m = /^[\w.]*?\.\s*(?:get|get_one|get_or_404|one_or_404)\s*\(\s*((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*,/.exec(rhs))) return { cls: m[1], constructed: false };
  if ((m = /(?:\.\s*query|(?<![\w.])select)\s*\(\s*((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*[,)]/.exec(rhs))) return SA_SINGLE.test(rhs) ? { cls: m[1], constructed: false } : { cls: m[1], qs: true };
  if ((m = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\.\s*(?:model_validate|from_orm|parse_obj|model_construct|construct|from_\w+|new|build|make)\s*\(/.exec(rhs))) return { cls: m[1], constructed: true };
  if ((m = /^self\s*\.\s*(serializer_class|get_serializer|form_class|get_form)\s*\(/.exec(rhs))) {
    const args = splitArgs(skel, s + m[0].length - 1);
    return { cls: m[1].includes('serializer') ? '@serializer' : '@form', constructed: true, instance: args.some((x) => x.key === 'instance'), firstPos: args.some((x) => !x.key && !x.text.startsWith('*')) };
  }
  if ((m = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(/.exec(rhs))) {
    const args = splitArgs(skel, s + m[0].length - 1);
    return { cls: m[1], constructed: true, instance: args.some((x) => x.key === 'instance'), firstPos: args.length > 0 && !args[0].key && !args[0].text.startsWith('*') };
  }
  if ((m = /^([a-z_]\w*)$/.exec(rhs))) {
    const o = fn.vars.get(m[1]);
    if (o) return { ...o };
  }
  return undefined;
}

function varStmt(mod: PyMod, fn: PyFunc, s: Stmt): void {
  const m = ASSIGN.exec(s.text);
  if (m) {
    const target = m[1].replace(/\s+/g, '');
    const rhsPos = s.p + m[0].length;
    if (target.startsWith('self.') && fn.cls) {
      const field = target.slice(5);
      if (field.includes('.')) return;
      const rhs = mod.scan.skel.slice(rhsPos, s.end).trim();
      const cm = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(/.exec(rhs);
      if (cm) fn.cls.fields.set(field, cm[1]);
      else if (/^[a-z_]\w*$/.test(rhs) && fn.params.has(rhs)) fn.cls.fields.set(field, fn.params.get(rhs)!);
      return;
    }
    if (target.includes('.') || m[3] !== '=') return;
    const info = varInfo(mod, fn, rhsPos, s.end);
    if (info) fn.vars.set(target, info);
    else if (m[2]) {
      const t = annType(m[2]);
      if (t) fn.vars.set(target, { cls: t, constructed: false });
    }
    return;
  }
  const fm = /^(?:async\s+)?for\s+([a-z_]\w*)\s+in\s+/.exec(s.text);
  if (fm) {
    const rhs = s.text.slice(fm[0].length);
    const mm = /((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\.\s*(?:objects|query)\b/.exec(rhs) ?? /(?:\.\s*query|(?<![\w.])select)\s*\(\s*((?:[A-Za-z_]\w*\.)*[A-Z]\w*)/.exec(rhs);
    if (mm) fn.vars.set(fm[1], { cls: mm[1], constructed: false });
    else if (/^self\s*\.\s*(?:queryset|get_queryset)/.test(rhs)) fn.vars.set(fm[1], { cls: '@model', constructed: false });
  }
}

function readChain(skel: string, p: number): { names: string[]; joins: string[]; end: number } {
  const names: string[] = [];
  const joins: string[] = [];
  let i = p;
  for (let g = 0; g < 40; g++) {
    let k = i;
    while (k < skel.length && /[\s\\]/.test(skel[k])) k++;
    if (skel[k] !== '.') break;
    k++;
    while (k < skel.length && (skel[k] === ' ' || skel[k] === '\t')) k++;
    const nm = /^[A-Za-z_]\w*/.exec(skel.slice(k, k + 64));
    if (!nm) break;
    names.push(nm[0]);
    k += nm[0].length;
    let j = k;
    while (skel[j] === ' ' || skel[j] === '\t') j++;
    if (skel[j] === '(' || skel[j] === '[') {
      const c = matchParen(skel, j);
      if (c < 0) break;
      if (skel[j] === '(' && /^(join|outerjoin|select_from|join_from)$/.test(nm[0])) {
        const first = splitArgs(skel, j).find((x) => !x.key);
        const e = first ? /^((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)/.exec(first.text) : null;
        if (e) joins.push(e[1]);
      }
      i = c + 1;
    } else i = k;
  }
  return { names, joins, end: i };
}

function chainCrud(names: string[]): Crud[] {
  const s = new Set<Crud>();
  for (const n of names) {
    if (n === 'create' || n === 'bulk_create') s.add('C');
    else if (n === 'get_or_create') {
      s.add('R');
      s.add('C');
    } else if (n === 'update_or_create') {
      s.add('C');
      s.add('U');
    } else if (n === 'update' || n === 'bulk_update') s.add('U');
    else if (n === 'delete') s.add('D');
  }
  if (!s.size) s.add('R');
  return (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => s.has(c));
}

const chainDesc = (head: string, names: string[]) => `${head}${names.length ? `.${names.slice(0, 6).join('().')}()` : ''}`;

const KW = new Set(['if', 'elif', 'while', 'for', 'return', 'yield', 'and', 'or', 'not', 'in', 'is', 'lambda', 'assert', 'del', 'raise', 'except', 'with', 'as', 'await', 'async', 'def', 'class', 'import', 'from', 'global', 'nonlocal', 'print', 'else', 'try', 'finally', 'pass', 'case', 'match']);
const VIEW_FNS = new Set(['render', 'render_to_response', 'TemplateResponse', 'SimpleTemplateResponse', 'render_template']);
const REDIRECT_FNS = new Set(['redirect', 'HttpResponseRedirect', 'HttpResponsePermanentRedirect', 'RedirectResponse']);
const TPL_EXT = /\.(html?|jinja2?|j2|txt|xml)$/i;

function tplCall(mod: PyMod, fn: PyFunc, open: number, line: number): void {
  const args = splitArgs(mod.scan.skel, open);
  const kwT = args.find((x) => x.key === 'template_name' || x.key === 'name' || x.key === 'template');
  let name = kwT ? argString(mod.scan, kwT) : undefined;
  if (name === undefined) {
    for (const x of args.filter((y) => !y.key).slice(0, 3)) {
      const s = argString(mod.scan, x);
      if (s !== undefined) {
        if (TPL_EXT.test(s) || s.includes('/')) {
          name = s;
          break;
        }
        continue;
      }
      const t = x.text.trim();
      if (/^self\.\w*template\w*$/.test(t)) {
        fn.tpls.push({ expr: t, line });
        return;
      }
    }
  }
  if (name) fn.tpls.push({ name, line });
}

function redirCall(mod: PyMod, fn: PyFunc, open: number): void {
  const skel = mod.scan.skel;
  const args = splitArgs(skel, open);
  const first = args.find((x) => !x.key || x.key === 'url' || x.key === 'to');
  if (!first) {
    fn.redirs.push({ kind: 'path', value: '?' });
    return;
  }
  const s = argString(mod.scan, first);
  if (s !== undefined) {
    fn.redirs.push(s.startsWith('/') || /^https?:/.test(s) || s.includes('/') ? { kind: 'path', value: s } : { kind: 'name', value: s });
    return;
  }
  const seg = skel.slice(first.valueStart, first.end);
  const im = /(?<!\w)(url_for|reverse|reverse_lazy)\s*\(/.exec(seg);
  if (im) {
    const ia = splitArgs(skel, first.valueStart + im.index + im[0].length - 1);
    const v = argString(mod.scan, ia.find((x) => !x.key) ?? ia.find((x) => x.key === 'viewname' || x.key === 'endpoint' || x.key === 'name'));
    if (v) {
      fn.redirs.push({ kind: im[1] === 'url_for' ? 'endpoint' : 'name', value: v });
      return;
    }
  }
  fn.redirs.push({ kind: 'path', value: '?' });
}

/** 첫 위치 인자의 모델 식 */
function firstModelArg(args: PyArg[]): string | undefined {
  const a = args.find((x) => !x.key);
  if (!a) return undefined;
  const t = a.text.replace(/^\[\s*/, '');
  return MODEL_CHAIN.exec(t)?.[1];
}

function scanCode(mod: PyMod, fn: PyFunc, a: number, b: number): void {
  const skel = mod.scan.skel;
  const seg = skel.slice(a, b);
  const lineAt = (i: number) => mod.lineOf(a + i);
  let m: RegExpExecArray | null;
  const callRe = /(?<![\w.])([A-Za-z_]\w*(?:[ \t]*\.[ \t]*[A-Za-z_]\w*)*)[ \t]*\(/g;
  while ((m = callRe.exec(seg))) {
    const chain = m[1].replace(/\s+/g, '');
    const parts = chain.split('.');
    if (parts.length === 1 && KW.has(parts[0])) continue;
    const last = parts[parts.length - 1];
    const open = a + m.index + m[0].length - 1;
    const line = lineAt(m.index);
    if (parts[0] !== 'super') fn.calls.push({ chain, line });
    if (VIEW_FNS.has(last)) {
      tplCall(mod, fn, open, line);
      continue;
    }
    if (REDIRECT_FNS.has(last)) {
      redirCall(mod, fn, open);
      continue;
    }
    if (parts.length === 1) {
      if (last === 'get_object_or_404' || last === 'get_list_or_404') {
        const args = splitArgs(skel, open);
        const first = args.find((x) => !x.key);
        if (first && !/\.\s*objects\b/.test(first.text)) {
          const model = MODEL_CHAIN.exec(first.text)?.[1];
          if (model) fn.orm.push({ model, crud: ['R'], line, desc: `${last}(${model})`, joins: [] });
        }
      } else if (last === 'select' || last === 'insert' || last === 'update' || last === 'delete') {
        const args = splitArgs(skel, open);
        const close = matchParen(skel, open);
        const ch = close > 0 ? readChain(skel, close + 1) : { names: [], joins: [], end: open };
        // select(func.count()).select_from(Model): 모델은 select_from·join 쪽
        const m0 = firstModelArg(args);
        const model = m0 ?? (last === 'select' ? ch.joins.shift() : undefined);
        if (!model) continue;
        const crud: Crud = last === 'select' ? 'R' : last === 'insert' ? 'C' : last === 'update' ? 'U' : 'D';
        fn.orm.push({ model, crud: [crud], line, desc: `${last}(${m0 ?? '…'})${ch.names.length ? `.${ch.names.slice(0, 4).join('().')}()` : ''}`, joins: ch.joins, table: true });
      }
      continue;
    }
    if (parts[parts.length - 2] === '__table__' && /^(insert|update|delete|select)$/.test(last)) {
      const model = parts.slice(0, -2).join('.');
      const crud: Crud = last === 'select' ? 'R' : last === 'insert' ? 'C' : last === 'update' ? 'U' : 'D';
      fn.orm.push({ model, crud: [crud], line, desc: `${chain}()`, joins: [] });
      continue;
    }
    const recvVar = parts.length === 2 && /^[a-z_]\w*$/.test(parts[0]) && parts[0] !== 'self' && parts[0] !== 'cls' ? parts[0] : undefined;
    switch (last) {
      case 'query': {
        if (/^[A-Z]/.test(parts[parts.length - 2])) break;
        const args = splitArgs(skel, open);
        const model = firstModelArg(args);
        if (!model) break;
        const close = matchParen(skel, open);
        const ch = readChain(skel, close + 1);
        fn.orm.push({ model, crud: chainCrud(ch.names), line, desc: chainDesc(`session.query(${model})`, ch.names), joins: ch.joins });
        break;
      }
      case 'get':
      case 'get_one':
      case 'get_or_404':
      case 'one_or_404': {
        const args = splitArgs(skel, open);
        if (args.length < 2 || args[0].key) break;
        const model = MODEL_CHAIN.exec(args[0].text)?.[1];
        if (model && model === args[0].text.trim()) fn.orm.push({ model, crud: ['R'], line, desc: `${last}(${model})`, joins: [] });
        break;
      }
      case 'add': {
        const args = splitArgs(skel, open);
        if (args.length !== 1 || args[0].key) break;
        const t = args[0].text.trim();
        const cm = /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(/.exec(t);
        if (cm) fn.orm.push({ model: cm[1], crud: ['C'], line, desc: `session.add(${cm[1]}(…))`, joins: [] });
        else if (/^[a-z_]\w*$/.test(t)) fn.varOps.push({ v: t, op: 'add', line });
        break;
      }
      case 'add_all':
      case 'bulk_save_objects': {
        const args = splitArgs(skel, open);
        const first = args.find((x) => !x.key);
        if (!first) break;
        const seen = new Set<string>();
        for (const cm of first.text.matchAll(/(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(/g)) {
          if (seen.has(cm[1])) continue;
          seen.add(cm[1]);
          fn.orm.push({ model: cm[1], crud: ['C'], line, desc: `session.${last}([${cm[1]}(…)])`, joins: [] });
        }
        break;
      }
      case 'bulk_insert_mappings':
      case 'bulk_update_mappings': {
        const model = firstModelArg(splitArgs(skel, open));
        if (model) fn.orm.push({ model, crud: [last === 'bulk_insert_mappings' ? 'C' : 'U'], line, desc: `session.${last}(${model})`, joins: [] });
        break;
      }
      case 'select_from': {
        const model = firstModelArg(splitArgs(skel, open));
        if (model) fn.orm.push({ model, crud: ['R'], line, desc: `select_from(${model})`, joins: [], table: true });
        break;
      }
      case 'delete': {
        const args = splitArgs(skel, open);
        if (!args.length && recvVar) fn.varOps.push({ v: recvVar, op: 'delete', line });
        else if (args.length === 1 && /^[a-z_]\w*$/.test(args[0].text.trim())) fn.varOps.push({ v: args[0].text.trim(), op: 'delete', line });
        if (recvVar && !args.length) fn.orm.push({ model: recvVar, crud: ['D'], line, desc: `${recvVar}.delete()`, joins: [], table: true });
        break;
      }
      case 'merge': {
        const args = splitArgs(skel, open);
        if (args.length >= 1 && /^[a-z_]\w*$/.test(args[0].text.trim())) fn.varOps.push({ v: args[0].text.trim(), op: 'merge', line });
        break;
      }
      case 'save': {
        if (!recvVar) break;
        const args = splitArgs(skel, open);
        if (args.some((x) => x.key === 'commit' && /False/.test(x.text))) break;
        fn.varOps.push({ v: recvVar, op: 'save', line });
        break;
      }
      case 'update': {
        if (!recvVar) break;
        fn.varOps.push({ v: recvVar, op: 'update', line });
        fn.orm.push({ model: recvVar, crud: ['U'], line, desc: `${recvVar}.update()`, joins: [], table: true });
        break;
      }
      case 'insert':
      case 'select': {
        if (!recvVar) break;
        fn.orm.push({ model: recvVar, crud: [last === 'insert' ? 'C' : 'R'], line, desc: `${recvVar}.${last}()`, joins: [], table: true });
        break;
      }
      default:
        break;
    }
  }
  // Django: Model.objects…
  const objRe = /(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Z]\w*)[ \t]*\.[ \t]*(objects|_default_manager)\b/g;
  while ((m = objRe.exec(seg))) {
    const model = m[1];
    const ch = readChain(skel, a + m.index + m[0].length);
    fn.orm.push({ model, crud: chainCrud(ch.names), line: lineAt(m.index), desc: chainDesc(`${model}.${m[2]}`, ch.names), joins: [] });
  }
  // Django: Model.<매니저>.filter() …
  const mgrRe = /(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Z]\w*)[ \t]*\.[ \t]*([a-z_]\w*)[ \t]*\.[ \t]*(all|filter|exclude|get|create|count|first|last|order_by|annotate|values|values_list|get_or_create|update_or_create|bulk_create|update|delete|select_related|prefetch_related|exists|aggregate|distinct|latest|earliest|in_bulk|only|defer)[ \t]*\(/g;
  while ((m = mgrRe.exec(seg))) {
    if (/^(objects|query|_default_manager|c|columns|__table__|session|metadata)$/.test(m[2])) continue;
    let p0 = a + m.index + m[0].lastIndexOf(m[3]);
    while (p0 > a && skel[p0 - 1] !== '.') p0--;
    const ch = readChain(skel, p0 - 1);
    fn.orm.push({ model: m[1], mgr: m[2], crud: chainCrud(ch.names), line: lineAt(m.index), desc: chainDesc(`${m[1]}.${m[2]}`, ch.names), joins: [] });
  }
  // SQLAlchemy: Model.query…
  const qRe = /(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Z]\w*)[ \t]*\.[ \t]*query\b(?![ \t]*\()/g;
  while ((m = qRe.exec(seg))) {
    const ch = readChain(skel, a + m.index + m[0].length);
    fn.orm.push({ model: m[1], crud: chainCrud(ch.names), line: lineAt(m.index), desc: chainDesc(`${m[1]}.query`, ch.names), joins: ch.joins });
  }
  // 클래스 뷰: self.queryset / self.model.objects / self.get_queryset()
  const selfRe = /(?<![\w.])self[ \t]*\.[ \t]*(queryset|model[ \t]*\.[ \t]*objects|get_queryset[ \t]*\([ \t]*\))/g;
  while ((m = selfRe.exec(seg))) {
    const ch = readChain(skel, a + m.index + m[0].length);
    fn.orm.push({ model: '@model', self: true, crud: chainCrud(ch.names), line: lineAt(m.index), desc: chainDesc(`self.${m[1].replace(/\s+/g, '')}`, ch.names), joins: [] });
  }
  // super().x()
  const supRe = /(?<![\w.])super[ \t]*\([^()]*\)[ \t]*\.[ \t]*([A-Za-z_]\w*)[ \t]*\(/g;
  while ((m = supRe.exec(seg))) {
    fn.hasSuper = true;
    fn.calls.push({ chain: `super.${m[1]}`, line: lineAt(m.index) });
  }
  // SQL 상수 참조 (SELECT_ORDERS, queries.ORDER_SQL, self.SQL)
  const constRe = /(?<![\w.])((?:[A-Za-z_]\w*\.)*(?:[A-Z][A-Z0-9_]{2,}|[A-Za-z_]*(?:sql|SQL|Sql|query|QUERY|Query)\w*))\b(?![ \t]*\()/g;
  while ((m = constRe.exec(seg))) fn.constRefs.add(m[1]);
}

function processBody(mod: PyMod, fn: PyFunc, ctx: Ctx): void {
  sqlStrings(mod, fn.ranges, fn, ctx, fn === mod.modFn ? mod.sqlConsts : undefined);
  for (const s of stmts(mod, fn.ranges)) varStmt(mod, fn, s);
  for (const [a, b] of fn.ranges) scanCode(mod, fn, a, b);
}

/** Flask·Blueprint·FastAPI·APIRouter 객체, 등록, add_url_rule, DRF 라우터, Core Table, 로그 */
function fwScan(mod: PyMod): void {
  const skel = mod.scan.skel;
  const scan = mod.scan;
  let m: RegExpExecArray | null;
  const objRe = /(?<![\w.])([A-Za-z_]\w*)[ \t]*(?::[ \t]*[\w.]+[ \t]*)?=[ \t]*(?:[A-Za-z_]\w*\.)*(Flask|Blueprint|FastAPI|APIRouter|Api)[ \t]*\(/g;
  while ((m = objRe.exec(skel))) {
    const args = splitArgs(skel, m.index + m[0].length - 1);
    const kw = (k: string) => args.find((a) => a.key === k);
    const kind: FwObj['kind'] = m[2] === 'Flask' ? 'flask' : m[2] === 'Blueprint' ? 'bp' : m[2] === 'FastAPI' ? 'fastapi' : m[2] === 'APIRouter' ? 'router' : 'api';
    const pa = kind === 'bp' ? kw('url_prefix') : kind === 'router' || kind === 'api' ? kw('prefix') : undefined;
    const obj: FwObj = { mod, v: m[1], kind, name: (kind === 'bp' ? argString(scan, args.find((a) => !a.key) ?? kw('name')) : undefined) ?? m[1], line: mod.lineOf(m.index) };
    if (pa) {
      const ps = argString(scan, pa);
      if (ps !== undefined) obj.prefix = ps;
      else obj.prefixExpr = argExpr(skel, pa).replace(/\s+/g, '');
    }
    if (kind === 'api') {
      const t = args.find((a) => !a.key) ?? kw('app');
      if (t) obj.target = argExpr(skel, t).replace(/\s+/g, '');
    }
    if (!mod.fw.has(m[1])) mod.fw.set(m[1], obj);
  }
  const incRe = /(?<![\w.])([A-Za-z_][\w.]*?)[ \t]*\.[ \t]*(register_blueprint|include_router)[ \t]*\(/g;
  while ((m = incRe.exec(skel))) {
    const args = splitArgs(skel, m.index + m[0].length - 1);
    const child = args.find((a) => !a.key) ?? args.find((a) => a.key === 'blueprint' || a.key === 'router');
    if (!child) continue;
    const pa = args.find((a) => a.key === (m![2] === 'register_blueprint' ? 'url_prefix' : 'prefix'));
    const inc: FwInclude = { mod, parent: m[1].replace(/\s+/g, ''), child: argExpr(skel, child).replace(/\s+/g, ''), line: mod.lineOf(m.index) };
    if (pa) {
      const ps = argString(scan, pa);
      if (ps !== undefined) inc.prefix = ps;
      else inc.prefixExpr = argExpr(skel, pa).replace(/\s+/g, '');
    }
    mod.fwIncludes.push(inc);
  }
  const ruleRe = /(?<![\w.])([A-Za-z_][\w.]*?)[ \t]*\.[ \t]*add_url_rule[ \t]*\(/g;
  while ((m = ruleRe.exec(skel))) {
    const args = splitArgs(skel, m.index + m[0].length - 1);
    const pos = args.filter((a) => !a.key);
    const kw = (k: string) => args.find((a) => a.key === k);
    const rule = argString(scan, kw('rule') ?? pos[0]);
    const vf = kw('view_func') ?? pos[2];
    if (rule === undefined || !vf) continue;
    const ep = argString(scan, kw('endpoint') ?? pos[1]);
    mod.urlRules.push({ mod, recv: m[1], rule, ...(ep ? { endpoint: ep } : {}), view: vf, methods: argStrings(scan, kw('methods')).map((x) => x.toUpperCase()), line: mod.lineOf(m.index) });
  }
  const resRe = /(?<![\w.])([A-Za-z_][\w.]*?)[ \t]*\.[ \t]*add_resource[ \t]*\(/g;
  while ((m = resRe.exec(skel))) {
    const args = splitArgs(skel, m.index + m[0].length - 1);
    const pos = args.filter((a) => !a.key);
    if (pos.length < 2) continue;
    const urls = pos.slice(1).map((a) => argString(scan, a)).filter((x): x is string => x !== undefined);
    if (!urls.length) continue;
    const ep = argString(scan, args.find((a) => a.key === 'endpoint'));
    mod.urlRules.push({ mod, recv: m[1], urls, ...(ep ? { endpoint: ep } : {}), view: pos[0], methods: [], line: mod.lineOf(m.index), resource: true });
  }
  const rtRe = /(?<![\w.])([A-Za-z_]\w*)[ \t]*=[ \t]*(?:[A-Za-z_]\w*\.)*(DefaultRouter|SimpleRouter|ExtendedDefaultRouter|ExtendedSimpleRouter|NestedSimpleRouter|NestedDefaultRouter|OptionalSlashRouter)[ \t]*\(/g;
  while ((m = rtRe.exec(skel))) {
    mod.drf.set(m[1], []);
    const ts = splitArgs(skel, m.index + m[0].length - 1).find((a) => a.key === 'trailing_slash');
    if (ts && /False|''|""/.test(ts.text)) mod.drfNoSlash.add(m[1]);
  }
  if (mod.drf.size) {
    const regRe = /(?<![\w.])([A-Za-z_]\w*)[ \t]*\.[ \t]*register[ \t]*\(/g;
    while ((m = regRe.exec(skel))) {
      const list = mod.drf.get(m[1]);
      if (!list) continue;
      const args = splitArgs(skel, m.index + m[0].length - 1);
      const pos = args.filter((a) => !a.key);
      const kw = (k: string) => args.find((a) => a.key === k);
      const prefix = argString(scan, kw('prefix') ?? pos[0]);
      const vs = kw('viewset') ?? pos[1];
      if (prefix === undefined || !vs) continue;
      const bn = argString(scan, kw('basename') ?? kw('base_name') ?? pos[2]);
      list.push({ prefix, viewset: argExpr(skel, vs).replace(/\s+/g, ''), ...(bn ? { basename: bn } : {}), line: mod.lineOf(m.index) });
    }
  }
  const tblRe = /(?<![\w.])([A-Za-z_]\w*)[ \t]*=[ \t]*(?:[A-Za-z_]\w*\.)*Table[ \t]*\(/g;
  while ((m = tblRe.exec(skel))) {
    const args = splitArgs(skel, m.index + m[0].length - 1);
    const name = argString(scan, args[0]);
    if (name) mod.saTables.set(m[1], name);
  }
  // 로그 파일
  const logRe = /(?:(?<![\w.])(?:filename|log_file|logfile|LOG_FILE|LOG_PATH|log_path)[ \t]*=[ \t]*|(?:FileHandler|RotatingFileHandler|TimedRotatingFileHandler|WatchedFileHandler)[ \t]*\([ \t]*)/g;
  while ((m = logRe.exec(skel))) {
    const s = findStr(scan, m.index + m[0].length);
    if (s && /\.log$|\/logs?\//i.test(s.value) && !mod.logs.includes(s.value)) mod.logs.push(s.value);
  }
}

function analyzeModule(f: FileInfo, text: string, ctx: Ctx, st: PyState): void {
  const scan = scanPy(text);
  const skel = scan.skel;
  const blocks = parseBlocks(skel);
  const dotted = dottedOf(f.path);
  const isInit = /(^|\/)__init__\.py$/i.test(f.path);
  const logical = new Set<number>();
  for (const l of blocks.lines) if (l.logical) logical.add(l.start);
  const mod: PyMod = {
    f, text, scan, blocks, lineOf: makeLineIndex(text), logical, dotted, pkg: isInit ? dotted : dotted.split('.').slice(0, -1).join('.'),
    imports: new Map(), stars: [], consts: new Map(), classes: new Map(), funcs: new Map(), all: [], modFn: undefined as unknown as PyFunc,
    hasMain: false, web: false, runsApp: false, fw: new Map(), fwIncludes: [], urlRules: [], drf: new Map(), drfNoSlash: new Set(), urlpatterns: false,
    saTables: new Map(), sqlConsts: new Map(), logs: [], synth: [], sqlIds: [], importedBy: 0,
  };
  mod.modFn = newFunc(mod, '<module>', undefined, moduleRanges(blocks, skel.length));
  parseImports(mod);
  mod.doc = docstringAt(scan, 0);
  const mods = [...mod.imports.values()].map((i) => i.module).concat(mod.stars.map((s) => s.module));
  mod.web = mods.some((x) => /^(django|flask|fastapi|starlette|jinja2|rest_framework|quart)\b/.test(x));
  for (const x of mods) {
    const d = DRIVER_NAME.find(([re]) => re.test(x));
    if (d && (!mod.driver || mod.driver === 'SQLAlchemy')) mod.driver = d[1];
  }

  // 구조: 최상위 클래스, 함수(메서드·중첩 함수 포함)
  const fnOf = new Map<PyDef, PyFunc>();
  const clsOf = new Map<PyDef, PyClass>();
  for (const d of blocks.all) {
    if (d.kind === 'class') {
      if (d.parent) continue;
      const c: PyClass = { mod, def: d, name: d.name, bases: [], kw: new Map(), attrs: new Map(), meta: new Map(), methods: new Map(), decos: [], fields: new Map(), synth: [], sqlConsts: new Map() };
      clsOf.set(d, c);
      if (!mod.classes.has(d.name)) mod.classes.set(d.name, c);
      continue;
    }
    const p = d.parent;
    let cls: PyClass | undefined;
    let outer: PyFunc | undefined;
    if (p?.kind === 'class') {
      cls = clsOf.get(p);
      if (!cls) continue;
    } else if (p?.kind === 'def') {
      outer = fnOf.get(p);
      if (!outer) continue;
    }
    const fn = newFunc(mod, d.name, d, ownRanges(d));
    fn.cls = cls;
    fn.outer = outer;
    fn.decos = parseDecos(mod, d);
    const doc = docstringAt(scan, d.bodyStart);
    if (doc) fn.method.doc = doc;
    parseParams(mod, fn);
    fnOf.set(d, fn);
    mod.all.push(fn);
    if (cls) {
      if (!cls.methods.has(d.name)) cls.methods.set(d.name, fn);
    } else if (outer) outer.children.push(fn);
    else if (!mod.funcs.has(d.name)) mod.funcs.set(d.name, fn);
  }
  // 모듈 수준 대입
  for (const s of stmts(mod, mod.modFn.ranges)) {
    const m = ASSIGN.exec(s.text);
    if (m && !m[1].includes('.') && m[3] === '=') mod.consts.set(m[1], attrFrom(mod, m, s));
  }
  mod.rootUrlconf = mod.consts.get('ROOT_URLCONF')?.str;
  mod.appName = mod.consts.get('app_name')?.str;
  for (const c of clsOf.values()) parseClassBody(mod, c, ctx);
  fwScan(mod);
  processBody(mod, mod.modFn, ctx);
  for (const fn of mod.all) processBody(mod, fn, ctx);
  mod.hasMain = /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(text);
  mod.urlpatterns = /(?<![\w.])urlpatterns\b/.test(skel);
  mod.runsApp = /(?<![\w.])(?:app|application|server)[ \t]*\.[ \t]*run[ \t]*\(|(?<![\w.])uvicorn[ \t]*\.[ \t]*run[ \t]*\(|\.run_server[ \t]*\(|(?<![\w.])execute_from_command_line[ \t]*\(/.test(skel);
  st.mods.push(mod);
}

// ------------------------------------------------------------------ 템플릿 (Django·Jinja2)

const blank = (s: string) => s.replace(/[^\n]/g, ' ');
const keepNl = (s: string) => s.replace(/[^\n]/g, '');
const DJ_URL = /\{%-?\s*url\s+(["'])([^"']+)\1([^%]*?)-?%\}/g;
const DJ_URL_BARE = /\{%-?\s*url\s+([\w:.-]+)(\s[^%]*?)?-?%\}/g;
const URL_FOR = /\{\{-?\s*(?:request\s*\.\s*)?url_for\(\s*(["'])([^"']+)\1([^}]*?)\)\s*(?:\|[^}]*)?-?\}\}/g;
const FRAG_NAME = /^(_.*|base(_\w+)?|layout(_\w+)?|macros?|header|footer|nav|navbar|sidebar|menu|pagination|messages|form_?errors?)\.(html?|jinja2?|j2|txt)$/i;
const FRAG_DIR = /\/(partials?|includes?|inc|components|macros|layouts?|shared|snippets|fragments|widgets|emails?|mail|email_templates)\//i;

function staticUrl(rest: string): string {
  const fm = /filename\s*=\s*["']([^"']+)["']/.exec(rest);
  return fm ? `/static/${fm[1]}` : '/static/';
}

function cleanTitle(s: string): string {
  return s
    // 번역 문자열: {% trans "글 목록" %}, {{ _('글 목록') }}
    .replace(/\{%-?\s*(?:trans|translate)\s+(["'])([^"']*)\1[^%]*%\}|\{\{-?\s*(?:_|gettext)\(\s*(["'])([^"']*)\3\s*\)\s*-?\}\}/g, (_a, _q, t1: string | undefined, _q2, t2: string | undefined) => ` ${t1 ?? t2 ?? ''} `)
    .replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|\-–:·]+|[\s|\-–:·]+$/g, '')
    .trim();
}

function analyzeTemplate(f: FileInfo, text: string, ctx: Ctx): TplRec {
  let src = text
    .replace(/\{#[\s\S]*?#\}/g, blank)
    .replace(/\{%-?\s*comment\b[^%]*%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, blank);
  const incs: string[] = [];
  for (const m of src.matchAll(/\{%-?\s*(?:extends|include|import|from)\s+(["'])([^"']+)\1/g)) if (!incs.includes(m[2])) incs.push(m[2]);
  const lineOf0 = makeLineIndex(src);
  let title: { title: string; line: number } | null = null;
  const bt = /\{%-?\s*block\s+(?:title|head_title|page_title|pagetitle|title_block|browser_title)\s*-?%\}([\s\S]{0,300}?)\{%-?\s*endblock/.exec(src);
  if (bt) {
    const t = cleanTitle(bt[1]);
    if (t && /[\p{L}]/u.test(t)) title = { title: t, line: lineOf0(bt.index) };
  }
  const marker = (kind: 'dj' | 'ep', name: string, all: string) => `/__route__/${kind}/${encodeURIComponent(name)}${keepNl(all)}`;
  src = src
    .replace(DJ_URL, (all, _q, name: string, rest: string) => (/\bas\s+\w+\s*$/.test(rest) ? blank(all) : marker('dj', name, all)))
    .replace(DJ_URL_BARE, (all, name: string, rest: string | undefined) => (/\bas\s+\w+\s*$/.test(rest ?? '') ? blank(all) : marker('dj', name, all)))
    .replace(URL_FOR, (all, _q, ep: string, rest: string) => (ep === 'static' ? `${staticUrl(rest)}${keepNl(all)}` : marker('ep', ep, all)))
    .replace(/\{%-?\s*static\s+(["'])([^"']+)\1\s*-?%\}/g, (all, _q, p: string) => `/static/${p}${keepNl(all)}`)
    .replace(/\{%[\s\S]*?%\}/g, blank);
  const lineOf = makeLineIndex(src);
  const view: ViewFact = { file: f.id, kind: 'template', urls: [], includes: [], scripts: [] };
  if (!title) {
    const t = extractTitle(src);
    if (t && !/^\{x\}/.test(t.title)) title = { title: t.title, line: lineOf(t.offset) };
  }
  if (title) {
    view.title = title.title;
    view.titleLine = title.line;
  }
  const rec: TplRec = { f, text, view, marks: [], rels: [], incs };
  for (const r of extractRefs(src)) {
    const raw = r.url.trim();
    const ref: UrlRef = { url: raw, kind: r.kind, file: f.id, line: lineOf(r.offset), ...(r.method ? { method: r.method } : {}) };
    const mk = /^\/__route__\/(dj|ep)\/([^/?#\s]+)/.exec(raw);
    if (mk) {
      view.urls.push(ref);
      rec.marks.push({ ref, name: decodeURIComponent(mk[2]), kind: mk[1] as 'dj' | 'ep' });
      continue;
    }
    if (/^(\.\/?|\?.*)$/.test(raw) || (!/^[a-z][\w+.-]*:|^\/|^\{/i.test(raw) && !/^#/.test(raw))) {
      if (/\.(css|js|png|jpe?g|gif|svg|ico|pdf)$/i.test(raw.replace(/[?#].*$/, ''))) continue;
      view.urls.push(ref);
      rec.rels.push({ ref, raw: /^(\.\/?|\?.*)$/.test(raw) ? './' : raw.replace(/[?#].*$/, '') });
      continue;
    }
    const n = normalizeRef(raw, '/');
    if (!n) continue;
    ref.url = n;
    view.urls.push(ref);
  }
  // action 없는 POST 폼은 지금 주소로 보냄
  for (const m of src.matchAll(/<form\b([^>]*)>/gi)) {
    if (/\baction\s*=/i.test(m[1]) || !/\bmethod\s*=\s*["']?post/i.test(m[1])) continue;
    const ref: UrlRef = { url: './', kind: 'form', method: 'POST', file: f.id, line: lineOf(m.index ?? 0) };
    view.urls.push(ref);
    rec.rels.push({ ref, raw: './' });
  }
  view.scripts = extractScripts(src).filter((s) => !/^(https?:)?\/\//i.test(s) && !s.includes('{'));
  ctx.facts.views.push(view);
  f.layer = 'VIEW';
  return rec;
}

// ------------------------------------------------------------------ 2단계: 잇기

type Sym =
  | { k: 'mod'; mod: PyMod }
  | { k: 'cls'; cls: PyClass }
  | { k: 'fn'; fn: PyFunc }
  | { k: 'var'; mod: PyMod; name: string; a: PyAttr }
  | { k: 'cattr'; cls: PyClass; name: string; a: PyAttr }
  | { k: 'inst'; cls: PyClass }
  | { k: 'ext'; path: string };

interface ModelInfo {
  orm: 'dj' | 'sa' | 'sqlmodel';
  table: string;
  abstract: boolean;
}

interface AsView {
  kw: Map<string, { expr: string; str?: string }>;
  /** DRF as_view({'get': 'list'}) */
  actions: Map<string, string>;
  endpoint?: string;
}

type ViewRef = { kind: 'fn'; fn: PyFunc } | { kind: 'cls'; cls: PyClass; asView: AsView } | { kind: 'ext'; path: string; asView: AsView };

interface DjInclude {
  module?: string;
  expr?: string;
  router?: string;
  inline?: DjPat[];
  namespace?: string;
  appName?: string;
}

interface DjPat {
  mod: PyMod;
  line: number;
  regex: boolean;
  route: string;
  view?: { a: number; b: number };
  include?: DjInclude;
  router?: string;
  name?: string;
}

const DJ_GENERIC: Record<string, { crud: Crud[]; suffix?: string }> = {
  ListView: { crud: ['R'], suffix: '_list' },
  DetailView: { crud: ['R'], suffix: '_detail' },
  CreateView: { crud: ['C'], suffix: '_form' },
  UpdateView: { crud: ['R', 'U'], suffix: '_form' },
  DeleteView: { crud: ['R', 'D'], suffix: '_confirm_delete' },
  ArchiveIndexView: { crud: ['R'], suffix: '_archive' },
  YearArchiveView: { crud: ['R'], suffix: '_archive_year' },
  MonthArchiveView: { crud: ['R'], suffix: '_archive_month' },
  DayArchiveView: { crud: ['R'], suffix: '_archive_day' },
  TodayArchiveView: { crud: ['R'], suffix: '_archive_day' },
  DateDetailView: { crud: ['R'], suffix: '_detail' },
  TemplateView: { crud: [] },
  FormView: { crud: [] },
  RedirectView: { crud: [] },
};

const DJ_AUTH_TEMPLATES: Record<string, string> = {
  LoginView: 'registration/login.html',
  LogoutView: 'registration/logged_out.html',
  PasswordChangeView: 'registration/password_change_form.html',
  PasswordChangeDoneView: 'registration/password_change_done.html',
  PasswordResetView: 'registration/password_reset_form.html',
  PasswordResetDoneView: 'registration/password_reset_done.html',
  PasswordResetConfirmView: 'registration/password_reset_confirm.html',
  PasswordResetCompleteView: 'registration/password_reset_complete.html',
};

/** DRF 제네릭 API 뷰: HTTP 메서드 → 액션 */
const DRF_GENERIC: Record<string, [string, string][]> = {
  ListAPIView: [['GET', 'list']],
  CreateAPIView: [['POST', 'create']],
  RetrieveAPIView: [['GET', 'retrieve']],
  UpdateAPIView: [['PUT', 'update'], ['PATCH', 'partial_update']],
  DestroyAPIView: [['DELETE', 'destroy']],
  ListCreateAPIView: [['GET', 'list'], ['POST', 'create']],
  RetrieveUpdateAPIView: [['GET', 'retrieve'], ['PUT', 'update'], ['PATCH', 'partial_update']],
  RetrieveDestroyAPIView: [['GET', 'retrieve'], ['DELETE', 'destroy']],
  RetrieveUpdateDestroyAPIView: [['GET', 'retrieve'], ['PUT', 'update'], ['PATCH', 'partial_update'], ['DELETE', 'destroy']],
};

const VS_ACTIONS: Record<string, { method: string; detail: boolean; crud: Crud[] }> = {
  list: { method: 'GET', detail: false, crud: ['R'] },
  create: { method: 'POST', detail: false, crud: ['C'] },
  retrieve: { method: 'GET', detail: true, crud: ['R'] },
  update: { method: 'PUT', detail: true, crud: ['R', 'U'] },
  partial_update: { method: 'PATCH', detail: true, crud: ['R', 'U'] },
  destroy: { method: 'DELETE', detail: true, crud: ['R', 'D'] },
};
const VS_MIXINS: Record<string, string[]> = {
  CreateModelMixin: ['create'],
  ListModelMixin: ['list'],
  RetrieveModelMixin: ['retrieve'],
  UpdateModelMixin: ['update', 'partial_update'],
  DestroyModelMixin: ['destroy'],
};
const HTTP_HANDLERS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const ROUTE_DECOS = new Set(['route', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'api_route']);
const BATCH_DIR = /(^|\/)(batch|batches|job|jobs|cron|crons|crontab|scheduler|schedule|etl|daemon)\//i;

function djRoute(r: string, regex: boolean): string {
  if (!regex) return r.replace(/<(?:[a-z_]\w*:)?([A-Za-z_]\w*)>/g, '{$1}');
  const s = r.replace(/^\^/, '').replace(/\$$/, '');
  const groupEnd = (i: number): number => {
    let d = 0;
    for (let k = i; k < s.length; k++) {
      if (s[k] === '\\') {
        k++;
        continue;
      }
      if (s[k] === '[') {
        const c = s.indexOf(']', k + 1);
        if (c > 0) k = c;
        continue;
      }
      if (s[k] === '(') d++;
      else if (s[k] === ')' && --d === 0) return k;
    }
    return s.length - 1;
  };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (s.startsWith('(?P<', i)) {
      const nm = /^\(\?P<(\w+)>/.exec(s.slice(i));
      out += `{${nm ? nm[1] : 'x'}}`;
      i = groupEnd(i);
      if (s[i + 1] === '?') i++;
      continue;
    }
    if (s.startsWith('(?:', i)) {
      const e = groupEnd(i);
      const opt = s[e + 1] === '?' || s[e + 1] === '*';
      if (!opt) out += djRoute(s.slice(i + 3, e), true);
      i = opt ? e + 1 : e;
      continue;
    }
    if (c === '(') {
      out += '{x}';
      i = groupEnd(i);
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      const nx = s[i + 1];
      out += /[dwsDWS]/.test(nx) ? '{x}' : nx;
      i++;
      if (/[+*]/.test(s[i + 1] ?? '')) i++;
      continue;
    }
    if (c === '[') {
      const e = s.indexOf(']', i + 1);
      i = e < 0 ? s.length : e;
      out += '{x}';
      if (/[+*?]/.test(s[i + 1] ?? '')) i++;
      continue;
    }
    if (c === '?') {
      if (out.endsWith('/')) out = out.slice(0, -1);
      continue;
    }
    if (c === '+' || c === '*' || c === '$' || c === '^') continue;
    if (c === '.') {
      out += '{x}';
      continue;
    }
    out += c;
  }
  return out.replace(/(\{x\})+/g, '{x}');
}

function normPath(p: string): string {
  const s = `/${p}`.replace(/\/{2,}/g, '/');
  return s;
}

function flaskPath(p: string): string {
  return p.replace(/<(?:[^:<>]+:)?([^<>]+)>/g, '{$1}').replace(/\{(\w+):[^}]+\}/g, '{$1}');
}

function finishPy(ctx: Ctx, st: PyState): void {
  const mods = st.mods;
  // ---- 모듈 색인
  const byDotted = new Map<string, PyMod>();
  const byLast = new Map<string, PyMod[]>();
  for (const m of mods) {
    byDotted.set(m.dotted, m);
    push(byLast, lastSeg(m.dotted), m);
  }
  const commonSegs = (a: string, b: string) => {
    const x = a.split('.');
    const y = b.split('.');
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  function findModule(d: string, from?: PyMod): PyMod | undefined {
    if (!d) return undefined;
    const exact = byDotted.get(d);
    if (exact) return exact;
    const cands = (byLast.get(lastSeg(d)) ?? []).filter((m) => m.dotted.endsWith(`.${d}`));
    if (cands.length <= 1) return cands[0];
    return [...cands].sort((a, b) => (from ? commonSegs(b.dotted, from.dotted) - commonSegs(a.dotted, from.dotted) : 0) || a.dotted.length - b.dotted.length)[0];
  }
  function relTarget(mod: PyMod, imp: { module: string; level: number }): string {
    const parts = mod.pkg ? mod.pkg.split('.') : [];
    const base = parts.slice(0, Math.max(0, parts.length - (imp.level - 1))).join('.');
    return [base, imp.module].filter(Boolean).join('.');
  }

  // ---- 심볼 풀기
  function resolveImport(mod: PyMod, imp: PyImport, depth: number): Sym | undefined {
    if (depth > 12) return undefined;
    const rel = imp.level > 0;
    const target = rel ? relTarget(mod, imp) : imp.module;
    const find = (d: string) => (rel ? byDotted.get(d) : findModule(d, mod));
    if (imp.name) {
      const M = find(target);
      if (M && M !== mod) {
        const s = memberOf(M, imp.name, depth + 1);
        if (s) return s;
      }
      const sub = find(target ? `${target}.${imp.name}` : imp.name);
      if (sub && sub !== mod) return { k: 'mod', mod: sub };
      return { k: 'ext', path: `${target}.${imp.name}` };
    }
    const M = find(target);
    return M && M !== mod ? { k: 'mod', mod: M } : { k: 'ext', path: target };
  }
  function memberOf(M: PyMod, name: string, depth: number): Sym | undefined {
    if (depth > 12) return undefined;
    const c = M.classes.get(name);
    if (c) return { k: 'cls', cls: c };
    const f = M.funcs.get(name);
    if (f) return { k: 'fn', fn: f };
    const a = M.consts.get(name);
    const imp = M.imports.get(name);
    if (a && (!imp || a.line > imp.line)) return { k: 'var', mod: M, name, a };
    if (imp) return resolveImport(M, imp, depth + 1);
    const sub = byDotted.get(`${M.dotted}.${name}`);
    if (sub) return { k: 'mod', mod: sub };
    for (const s of M.stars) {
      const t = s.level > 0 ? byDotted.get(relTarget(M, s)) : findModule(s.module, M);
      if (t && t !== M) {
        const r = memberOf(t, name, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  }
  function valueOf(s: { k: 'var'; mod: PyMod; a: PyAttr } | { k: 'cattr'; cls: PyClass; a: PyAttr }, depth: number): Sym | undefined {
    if (depth > 12) return undefined;
    const mod = s.k === 'var' ? s.mod : s.cls.mod;
    const expr = s.a.expr;
    let m = /^([A-Za-z_][\w.]*)\s*\(/.exec(expr);
    if (m) {
      const callee = resolveChain(mod, m[1], depth + 1);
      if (callee?.k === 'cls') return { k: 'inst', cls: callee.cls };
      if (callee?.k === 'ext') return { k: 'ext', path: `${callee.path}()` };
      return undefined;
    }
    // 타입 별칭: CurrentUser = Annotated[User, Depends(…)]
    m = /^(?:typing\.)?(?:Annotated|Optional)\s*\[\s*([A-Za-z_][\w.]*)/.exec(expr);
    if (m) return resolveChain(mod, m[1], depth + 1);
    m = /^([A-Za-z_][\w.]*)$/.exec(expr);
    if (m) return resolveChain(mod, m[1], depth + 1);
    return undefined;
  }
  function attrOf(s: Sym, name: string, depth: number): Sym | undefined {
    if (depth > 12) return undefined;
    switch (s.k) {
      case 'mod':
        return memberOf(s.mod, name, depth + 1);
      case 'cls':
      case 'inst': {
        const f = methodOf(s.cls, name);
        if (f) return { k: 'fn', fn: f };
        const a = classAttr(s.cls, name);
        return a ? { k: 'cattr', cls: a.cls, name, a: a.a } : undefined;
      }
      case 'var':
      case 'cattr': {
        const v = valueOf(s, depth + 1);
        return v ? attrOf(v, name, depth + 1) : undefined;
      }
      case 'ext':
        return { k: 'ext', path: `${s.path}.${name}` };
      default:
        return undefined;
    }
  }
  function resolveChain(mod: PyMod, chain: string, depth = 0): Sym | undefined {
    if (depth > 12 || !chain) return undefined;
    const parts = chain.split('.');
    let s = memberOf(mod, parts[0], depth);
    let i = 1;
    const imp = mod.imports.get(parts[0]);
    if (imp?.plain && parts.length > 1) {
      for (let k = parts.length - 1; k >= 1; k--) {
        const M = findModule(parts.slice(0, k + 1).join('.'), mod);
        if (M) {
          s = { k: 'mod', mod: M };
          i = k + 1;
          break;
        }
      }
    }
    for (; s && i < parts.length; i++) s = attrOf(s, parts[i], depth + 1);
    return s;
  }
  /** var·cattr 는 값으로 따라감 */
  function deref(s: Sym | undefined, depth = 0): Sym | undefined {
    let x = s;
    for (let g = 0; g < 4 && x && (x.k === 'var' || x.k === 'cattr'); g++) {
      const v = valueOf(x, depth + 1);
      if (!v) return x;
      x = v;
    }
    return x;
  }
  function classOfExpr(mod: PyMod, expr: string): PyClass | undefined {
    const s = deref(resolveChain(mod, expr));
    return s?.k === 'cls' ? s.cls : s?.k === 'inst' ? s.cls : undefined;
  }
  const baseCache = new Map<PyClass, (Sym | undefined)[]>();
  function baseSyms(c: PyClass): (Sym | undefined)[] {
    let b = baseCache.get(c);
    if (!b) {
      baseCache.set(c, []);
      b = c.bases.map((x) => deref(resolveChain(c.mod, x)));
      baseCache.set(c, b);
    }
    return b;
  }
  function projectBases(c: PyClass): PyClass[] {
    return baseSyms(c).flatMap((s) => (s?.k === 'cls' && s.cls !== c ? [s.cls] : []));
  }
  function methodOf(c: PyClass, name: string, depth = 0): PyFunc | undefined {
    const own = c.methods.get(name);
    if (own || depth > 8) return own;
    for (const b of projectBases(c)) {
      const r = methodOf(b, name, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  function classAttr(c: PyClass, name: string, depth = 0): { cls: PyClass; a: PyAttr } | undefined {
    const own = c.attrs.get(name);
    if (own) return { cls: c, a: own };
    if (depth > 8) return undefined;
    for (const b of projectBases(c)) {
      const r = classAttr(b, name, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  const ancCache = new Map<PyClass, string[]>();
  /** 조상 이름들 (가까운 순): 프로젝트 클래스 이름, 외부 클래스는 끝 이름과 전체 경로 */
  function ancestors(c: PyClass, depth = 0): string[] {
    const hit = ancCache.get(c);
    if (hit) return hit;
    ancCache.set(c, []);
    const out: string[] = [];
    const add = (x: string) => {
      if (!out.includes(x)) out.push(x);
    };
    c.bases.forEach((raw, i) => {
      const s = baseSyms(c)[i];
      if (s?.k === 'cls' && s.cls !== c) {
        add(s.cls.name);
        if (depth < 10) for (const x of ancestors(s.cls, depth + 1)) add(x);
      } else if (s?.k === 'ext') {
        add(lastSeg(s.path));
        add(s.path);
      } else add(lastSeg(raw));
    });
    ancCache.set(c, out);
    return out;
  }
  const allMethods = (c: PyClass): PyFunc[] => {
    const out = new Map<string, PyFunc>();
    const walk = (x: PyClass, depth: number) => {
      for (const [n, f] of x.methods) if (!out.has(n)) out.set(n, f);
      if (depth < 8) for (const b of projectBases(x)) walk(b, depth + 1);
    };
    walk(c, 0);
    return [...out.values()];
  };
  function evalStr(mod: PyMod, expr: string): string | undefined {
    const s = resolveChain(mod, expr);
    if (s?.k === 'var' || s?.k === 'cattr') return s.a.str;
    return undefined;
  }

  // ---- 모델
  const modelCache = new Map<PyClass, ModelInfo | null>();
  // DDL 에 대소문자만 다른 같은 이름이 있으면 DDL 이름으로 (notice → NOTICE)
  const ddlNames = new Map(ctx.facts.ddl.map((d) => [d.name.toUpperCase(), d.name] as const));
  const reconcile = (t: string) => ddlNames.get(t.toUpperCase()) ?? t;
  function appLabel(mod: PyMod): string {
    const parts = mod.dotted.split('.');
    const i = parts.lastIndexOf('models');
    if (i > 0) return parts[i - 1];
    return parts[parts.length - 2] ?? parts[0];
  }
  function lowerTableName(c: PyClass): boolean {
    for (const b of [c, ...projectBases(c)]) {
      const f = b.methods.get('__tablename__');
      if (f && /\.lower\(\)/.test(c.mod.scan.skel.slice(f.def?.bodyStart ?? 0, f.def?.end ?? 0))) return true;
    }
    return false;
  }
  function modelOf(c: PyClass, depth = 0): ModelInfo | null {
    if (modelCache.has(c)) return modelCache.get(c)!;
    modelCache.set(c, null);
    if (depth > 10) return null;
    let orm = null as ModelInfo['orm'] | null;
    let parent = null as ModelInfo | null;
    let rootBase = false;
    const syms = baseSyms(c);
    for (let i = 0; i < syms.length && !orm; i++) {
      const s = syms[i];
      const raw = c.bases[i];
      if (s?.k === 'cls' && s.cls !== c) {
        const pm = modelOf(s.cls, depth + 1);
        if (pm) {
          orm = pm.orm;
          parent = pm;
        }
        continue;
      }
      const path = s?.k === 'ext' ? s.path : raw;
      if (/(^|\.)django\.[\w.]*\.(Model|AbstractUser|AbstractBaseUser|PermissionsMixin)$|(^|\.)models\.Model$/.test(path)) orm = 'dj';
      else if (/SQLAlchemy\(\)\.Model$|(^|\.)db\.Model$/.test(path)) orm = 'sa';
      else if (/(declarative_base|automap_base|generate_base)\(\)$|\.(DeclarativeBase|DeclarativeBaseNoMeta|MappedAsDataclass)$/.test(path)) {
        orm = 'sa';
        rootBase = /\.(DeclarativeBase|DeclarativeBaseNoMeta|MappedAsDataclass)$/.test(path);
      } else if (/(^|\.)SQLModel$/.test(path)) orm = 'sqlmodel';
    }
    if (!orm && c.attrs.get('__tablename__')?.str) orm = 'sa';
    if (!orm) return null;
    const p = parent;
    let abstract = false;
    let table = '';
    if (orm === 'dj') {
      abstract = /^True$/.test(c.meta.get('abstract')?.expr ?? '');
      const proxy = /^True$/.test(c.meta.get('proxy')?.expr ?? '');
      const dbt = c.meta.get('db_table')?.str;
      if (dbt) table = dbt;
      else if (proxy && p && !p.abstract) table = p.table;
      else table = `${c.meta.get('app_label')?.str ?? appLabel(c.mod)}_${c.name.toLowerCase()}`;
    } else if (orm === 'sa') {
      abstract = /^True$/.test(c.attrs.get('__abstract__')?.expr ?? '');
      const tn = c.attrs.get('__tablename__')?.str;
      const tbl = c.attrs.get('__table__');
      if (tn) table = tn;
      else if (tbl && /Table\s*\(/.test(tbl.expr)) table = stringsIn(c.mod.scan, tbl.pos, tbl.end)[0]?.value ?? '';
      else if (rootBase) abstract = true;
      else if (p && !p.abstract && p.table) table = p.table;
      else table = lowerTableName(c) ? c.name.toLowerCase() : snakeCase(c.name);
    } else {
      abstract = !/^True$/.test(c.kw.get('table') ?? '');
      table = c.attrs.get('__tablename__')?.str ?? c.name.toLowerCase();
    }
    if (!table) abstract = true;
    const info: ModelInfo = { orm, table: reconcile(table), abstract };
    modelCache.set(c, info);
    return info;
  }
  /** 식 → 모델 클래스 (Model.id 처럼 속성이 붙어도 앞쪽 클래스) */
  function modelClass(mod: PyMod, expr: string): PyClass | undefined {
    const parts = expr.split('.');
    for (let k = parts.length; k >= 1; k--) {
      const s = deref(resolveChain(mod, parts.slice(0, k).join('.')));
      if (s?.k === 'cls') return modelOf(s.cls) ? s.cls : undefined;
      if (s && k < parts.length) return undefined;
    }
    return undefined;
  }
  function metaModel(c: PyClass, depth = 0): PyClass | undefined {
    const e = c.meta.get('model')?.expr;
    if (e) return modelClass(c.mod, e);
    if (depth > 6) return undefined;
    for (const b of projectBases(c)) {
      const r = metaModel(b, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  /** 클래스 뷰가 다루는 모델: model > queryset > serializer_class·form_class 의 Meta.model */
  function viewModel(c: PyClass, av?: AsView): PyClass | undefined {
    const fromExpr = (mod: PyMod, expr: string): PyClass | undefined => {
      const m = MODEL_CHAIN.exec(expr.replace(/\s+/g, ''));
      if (!m) return undefined;
      const head = m[1].split('.');
      for (let k = head.length; k >= 1; k--) {
        const mc = modelClass(mod, head.slice(0, k).join('.'));
        if (mc) return mc;
      }
      return undefined;
    };
    const avm = av?.kw.get('model')?.expr ?? av?.kw.get('queryset')?.expr;
    if (avm) {
      const r = fromExpr(c.mod, avm);
      if (r) return r;
    }
    for (const key of ['model', 'queryset']) {
      const a = classAttr(c, key);
      if (a) {
        const r = fromExpr(a.cls.mod, a.a.expr);
        if (r) return r;
      }
    }
    for (const key of ['serializer_class', 'form_class']) {
      const a = classAttr(c, key);
      if (!a) continue;
      const sc = classOfExpr(a.cls.mod, a.a.expr);
      const r = sc ? metaModel(sc) : undefined;
      if (r) return r;
    }
    return undefined;
  }
  const fqnOfCls = (c: PyClass) => `py:${c.mod.dotted}.${c.name}`;
  const fqnOfFn = (f: PyFunc) => (f.cls ? fqnOfCls(f.cls) : `py:${f.mod.dotted}`);
  const ormName = (o: ModelInfo['orm']) => (o === 'dj' ? 'Django ORM' : o === 'sqlmodel' ? 'SQLModel' : 'SQLAlchemy');
  function addOrmSql(mod: PyMod, line: number, tables: TableRef[], desc: string, orm: ModelInfo['orm'] | null): SqlFact | undefined {
    const seen = new Set<string>();
    const list = tables.filter((t) => t.name && !seen.has(`${t.name}:${t.crud}`) && seen.add(`${t.name}:${t.crud}`));
    if (!list.length) return undefined;
    const crud = new Set(list.map((t) => t.crud));
    const kind = crud.has('C') ? 'insert' : crud.has('U') ? 'update' : crud.has('D') ? 'delete' : 'select';
    const s = ctx.addSql({ file: mod.f.id, line, origin: 'orm', kind, tables: list, text: `${desc} (${ormName(orm ?? 'sa')})` });
    mod.sqlIds.push(s.id);
    ctx.hit('데이터 접근', ormName(orm ?? 'sa'), mod.f.id, line, 1);
    return s;
  }

  // ---- 템플릿: 웹 모듈이 있는 폴더 아래 templates/ 의 HTML
  const webDirs = [...new Set(mods.filter((m) => m.web).map((m) => dirName(m.f.path)))];
  const viewFiles = new Set(ctx.facts.views.map((v) => v.file));
  const tpls: TplRec[] = [];
  for (const c of st.tplCands) {
    if (viewFiles.has(c.f.id)) continue;
    if (!webDirs.some((d) => d === '' || c.f.path.startsWith(`${d}/`))) continue;
    tpls.push(analyzeTemplate(c.f, c.text, ctx));
  }
  const tplByBase = new Map<string, TplRec[]>();
  for (const t of tpls) push(tplByBase, t.f.name, t);
  const pathSegsCommon = (a: string, b: string) => {
    const x = a.split('/');
    const y = b.split('/');
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  function findTemplate(name: string, fromPath: string): TplRec | undefined {
    const n = name.replace(/^\/+/, '');
    const pool = tplByBase.get(baseName(n)) ?? [];
    let cands = pool.filter((t) => t.f.path.endsWith(`/templates/${n}`) || t.f.path === `templates/${n}`);
    if (!cands.length) cands = pool.filter((t) => t.f.path.endsWith(`/${n}`) || t.f.path === n);
    if (cands.length <= 1) return cands[0];
    return [...cands].sort((x, y) => pathSegsCommon(y.f.path, fromPath) - pathSegsCommon(x.f.path, fromPath) || x.f.path.length - y.f.path.length)[0];
  }
  const tplPath = (name: string, fromPath: string) => findTemplate(name, fromPath)?.f.path ?? name;

  // ---- 함수가 돌려주는 화면
  const allFns: PyFunc[] = [];
  for (const m of mods) allFns.push(m.modFn, ...m.all);
  for (const fn of allFns) {
    for (const t of fn.tpls) {
      let name = t.name;
      if (!name && t.expr && fn.cls) name = classAttr(fn.cls, t.expr.replace(/^self\./, ''))?.a.str;
      if (!name) continue;
      const v = tplPath(name, fn.mod.f.path);
      if (!fn.method.views.includes(v)) fn.method.views.push(v);
    }
  }

  // ---- 라우트 등록 도구
  const routedMods = new Set<PyMod>();
  const routedClasses = new Set<PyClass>();
  const routed: { mu: MethodUnit; mod: PyMod }[] = [];
  function addRoute(mu: MethodUnit, method: string, path: string, line: number, api: boolean, mod: PyMod, cls: PyClass | undefined, fw: string): string {
    const p = normPath(path);
    if (!mu.routes.some((r) => r.method === method && r.path === p)) {
      mu.routes.push({ method, path: p, ...(api ? { api: true } : {}), line });
      routed.push({ mu, mod });
    }
    routedMods.add(mod);
    if (cls) routedClasses.add(cls);
    ctx.hit('컨트롤러', fw, mod.f.id, line, 1);
    return p;
  }
  const fnApi = (fn: PyFunc) => !fn.method.views.length && !fn.redirs.length;

  /** 클래스 합성 메서드 (없으면 만듦) */
  function synthOf(c: PyClass, name: string, init: () => Partial<MethodUnit>): MethodUnit {
    let mu = c.synth.find((x) => x.name === name);
    if (!mu) {
      mu = { name, line: c.def.line, endLine: c.def.endLine, routes: [], calls: [], sql: [], statements: [], views: [], ...init() };
      c.synth.push(mu);
    }
    return mu;
  }
  function genericSql(c: PyClass, crud: Crud[], label: string, av?: AsView): string[] {
    if (!crud.length) return [];
    const mc = viewModel(c, av);
    const mi = mc ? modelOf(mc) : null;
    if (!mc || !mi || mi.abstract) return [];
    const s = addOrmSql(c.mod, c.def.line, crud.map((x) => ({ name: mi.table, crud: x })), `${c.name} ${label} → ${mc.name}`, mi.orm);
    return s ? [s.id] : [];
  }
  function hookCalls(c: PyClass, hooks: string[]): MethodUnit['calls'] {
    const out: MethodUnit['calls'] = [];
    for (const h of hooks) {
      const f = methodOf(c, h);
      if (f) out.push({ via: fqnOfFn(f), method: f.method.name, line: f.method.line });
    }
    return out;
  }
  const HOOKS: Record<string, string[]> = {
    list: ['get_queryset', 'filter_queryset', 'paginate_queryset', 'get_serializer_class'],
    retrieve: ['get_queryset', 'get_object', 'get_serializer_class'],
    create: ['perform_create', 'get_serializer_class'],
    update: ['get_queryset', 'get_object', 'perform_update', 'get_serializer_class'],
    partial_update: ['get_queryset', 'get_object', 'perform_update', 'get_serializer_class'],
    destroy: ['get_queryset', 'get_object', 'perform_destroy'],
  };
  /** DRF 액션 메서드: 직접 정의했으면 그것, 아니면 제네릭 동작을 담은 합성 메서드 */
  function actionMethod(c: PyClass, action: string, handlerName?: string): { mu: MethodUnit; fn?: PyFunc } {
    const real = methodOf(c, handlerName ?? action) ?? (handlerName ? methodOf(c, action) : undefined);
    const spec = VS_ACTIONS[action];
    if (real) {
      if (real.hasSuper && spec && !real.method.sql.length) real.method.sql.push(...genericSql(c, spec.crud, action));
      return { mu: real.method, fn: real };
    }
    const mu = synthOf(c, handlerName ?? action, () => ({ calls: hookCalls(c, HOOKS[action] ?? []), sql: spec ? genericSql(c, spec.crud, action) : [] }));
    return { mu };
  }
  function viewsetActions(c: PyClass): string[] {
    const anc = ancestors(c);
    const acts = new Set<string>();
    if (anc.includes('ModelViewSet')) Object.keys(VS_ACTIONS).forEach((a) => acts.add(a));
    if (anc.includes('ReadOnlyModelViewSet')) ['list', 'retrieve'].forEach((a) => acts.add(a));
    for (const [mx, list] of Object.entries(VS_MIXINS)) if (anc.includes(mx)) list.forEach((a) => acts.add(a));
    for (const a of Object.keys(VS_ACTIONS)) if (methodOf(c, a)) acts.add(a);
    return Object.keys(VS_ACTIONS).filter((a) => acts.has(a));
  }
  const isViewSet = (c: PyClass) => ancestors(c).some((x) => /ViewSet$|ViewSetMixin$/.test(x));
  const isDrfClass = (c: PyClass) => ancestors(c).some((x) => /rest_framework|APIView$|ViewSet$|ViewSetMixin$/.test(x));

  /** 클래스 뷰 하나를 경로에 붙이기 */
  function classRoutes(c: PyClass, path: string, av: AsView | undefined, fw: string, methodsFilter?: string[], restful = false): void {
    const anc = ancestors(c);
    const drf = isDrfClass(c) || restful;
    if (av?.actions.size) {
      for (const [http, action] of av.actions) {
        const { mu } = actionMethod(c, action);
        addRoute(mu, http, path, mu.line, true, c.mod, c, fw);
      }
      return;
    }
    const drfGen = anc.find((x) => DRF_GENERIC[x]);
    if (drfGen) {
      for (const [http, action] of DRF_GENERIC[drfGen]) {
        const { mu } = actionMethod(c, action, http.toLowerCase());
        addRoute(mu, http, path, mu.line, true, c.mod, c, fw);
      }
      return;
    }
    const djGen = anc.find((x) => DJ_GENERIC[x]);
    const handlers = HTTP_HANDLERS.map((h) => methodOf(c, h)).filter((f): f is PyFunc => !!f);
    if (djGen && (djGen !== 'TemplateView' || !handlers.length)) {
      const spec = DJ_GENERIC[djGen];
      if (djGen === 'RedirectView' && !handlers.length) return;
      const mu = synthOf(c, 'as_view', () => ({
        calls: allMethods(c)
          .filter((f) => !/^__/.test(f.name))
          .map((f) => ({ via: fqnOfFn(f), method: f.method.name, line: f.method.line })),
        sql: genericSql(c, spec.crud, djGen, av),
      }));
      let tpl = av?.kw.get('template_name')?.str ?? classAttr(c, 'template_name')?.a.str;
      if (!tpl && spec.suffix) {
        const mc = viewModel(c, av);
        const mi = mc ? modelOf(mc) : null;
        if (mc && mi?.orm === 'dj') tpl = `${mc.meta.get('app_label')?.str ?? appLabel(mc.mod)}/${mc.name.toLowerCase()}${classAttr(c, 'template_name_suffix')?.a.str ?? spec.suffix}.html`;
      }
      if (tpl) {
        const v = tplPath(tpl, c.mod.f.path);
        if (!mu.views.includes(v)) mu.views.push(v);
      }
      addRoute(mu, '*', path, mu.line, !mu.views.length, c.mod, c, fw);
      return;
    }
    if (handlers.length) {
      for (const h of handlers) {
        const http = h.name.toUpperCase();
        if (methodsFilter?.length && !methodsFilter.includes(http)) continue;
        addRoute(h.method, http, path, h.method.line, drf || fnApi(h), c.mod, c, fw);
      }
      return;
    }
    // 처리 메서드를 모르는 클래스: 메서드 전체를 부르는 as_view
    const mu = synthOf(c, 'as_view', () => ({
      calls: allMethods(c)
        .filter((f) => !/^__/.test(f.name))
        .map((f) => ({ via: fqnOfFn(f), method: f.method.name, line: f.method.line })),
    }));
    addRoute(mu, '*', path, mu.line, true, c.mod, c, fw);
  }

  // ---- Flask·FastAPI 객체와 접두어
  function fwObjOf(mod: PyMod, chain: string): FwObj | undefined {
    if (!chain.includes('.')) {
      const local = mod.fw.get(chain);
      if (local) return local;
    }
    const s = resolveChain(mod, chain);
    if (s?.k === 'var') return s.mod.fw.get(s.name);
    return undefined;
  }
  const includesOf = new Map<FwObj, { inc: FwInclude; parent?: FwObj }[]>();
  for (const m of mods) {
    for (const inc of m.fwIncludes) {
      const child = fwObjOf(m, inc.child);
      if (!child) continue;
      push(includesOf, child, { inc, parent: fwObjOf(m, inc.parent) });
    }
  }
  const prefixMemo = new Map<FwObj, string>();
  function fwPrefix(obj: FwObj, depth = 0): string {
    const hit = prefixMemo.get(obj);
    if (hit !== undefined) return hit;
    prefixMemo.set(obj, '');
    const own = obj.prefix ?? (obj.prefixExpr ? evalStr(obj.mod, obj.prefixExpr) ?? '' : '');
    let out = own;
    if (obj.kind === 'api' && obj.target) {
      const t = fwObjOf(obj.mod, obj.target);
      if (t && t !== obj && depth < 8) out = fwPrefix(t, depth + 1) + own;
    }
    const first = includesOf.get(obj)?.[0];
    if (first && depth < 8) {
      const incP = first.inc.prefix ?? (first.inc.prefixExpr ? evalStr(first.inc.mod, first.inc.prefixExpr) ?? '' : '');
      const pp = first.parent && first.parent !== obj ? fwPrefix(first.parent, depth + 1) : '';
      const hasInc = first.inc.prefix !== undefined || first.inc.prefixExpr !== undefined;
      out = obj.kind === 'bp' ? pp + (hasInc ? incP : own) : pp + incP + own;
    }
    prefixMemo.set(obj, out);
    return out;
  }
  function bpName(obj: FwObj, depth = 0): string {
    const first = includesOf.get(obj)?.[0];
    if (first?.parent && first.parent.kind === 'bp' && first.parent !== obj && depth < 6) return `${bpName(first.parent, depth + 1)}.${obj.name}`;
    return obj.name;
  }
  const endpoints = new Map<string, string>();
  const faNames = new Map<string, string>();
  const named = new Map<string, string>();
  const setFirst = (m: Map<string, string>, k: string, v: string) => {
    if (!m.has(k)) m.set(k, v);
  };

  // ---- 데코레이터 라우트 (Flask·FastAPI·restx 류)
  for (const m of mods) {
    const flaskMod = [...m.imports.values()].some((i) => /^(flask|quart)\b/.test(i.module));
    const faMod = [...m.imports.values()].some((i) => /^(fastapi|starlette)\b/.test(i.module));
    const owners: { fn?: PyFunc; cls?: PyClass; decos: DecoRaw[] }[] = [
      ...m.all.filter((f) => f.decos.length).map((f) => ({ fn: f, decos: f.decos })),
      ...[...m.classes.values()].filter((c) => c.decos.length).map((c) => ({ cls: c, decos: c.decos })),
    ];
    for (const o of owners) {
      for (const d of o.decos) {
        const parts = d.chain.split('.');
        if (parts.length < 2) continue;
        const meth = parts[parts.length - 1];
        if (!ROUTE_DECOS.has(meth)) continue;
        const pa = d.args.find((a) => !a.key) ?? d.args.find((a) => a.key === 'rule' || a.key === 'path');
        const p = argString(m.scan, pa);
        if (p === undefined) continue;
        const obj = fwObjOf(m, parts.slice(0, -1).join('.'));
        const kind = obj ? (obj.kind === 'fastapi' || obj.kind === 'router' ? 'fa' : 'flask') : faMod && !flaskMod ? 'fa' : flaskMod ? 'flask' : null;
        if (!kind) continue;
        const prefix = obj ? fwPrefix(obj) : '';
        const path = flaskPath(prefix + p);
        const mk = d.args.find((a) => a.key === 'methods');
        const methods = meth === 'route' || meth === 'api_route' ? (mk ? argStrings(m.scan, mk).map((x) => x.toUpperCase()) : ['GET']) : [meth.toUpperCase()];
        if (o.cls) {
          classRoutes(o.cls, path, undefined, kind === 'fa' ? 'FastAPI' : 'Flask', undefined, true);
          continue;
        }
        const fn = o.fn!;
        const api = kind === 'fa' ? !fn.method.views.length : fnApi(fn);
        let full = '';
        for (const mm of methods) full = addRoute(fn.method, mm, path, d.line, api, m, fn.cls, kind === 'fa' ? 'FastAPI' : 'Flask');
        const ep = argString(m.scan, d.args.find((a) => a.key === (kind === 'fa' ? 'name' : 'endpoint'))) ?? fn.name;
        if (kind === 'fa') setFirst(faNames, ep, full);
        else setFirst(endpoints, obj?.kind === 'bp' ? `${bpName(obj)}.${ep}` : ep, full);
      }
    }
  }

  // ---- 뷰 식 풀기 (Django urls·add_url_rule)
  function viewOfArg(mod: PyMod, a0: number, a1: number, depth = 0): ViewRef | undefined {
    const skel = mod.scan.skel;
    let s = a0;
    while (s < a1 && /\s/.test(skel[s])) s++;
    const text = skel.slice(s, a1).trim();
    const str = strValue(mod, s, a1);
    if (str !== undefined) {
      const i = str.lastIndexOf('.');
      if (i < 0) return undefined;
      const M = findModule(str.slice(0, i), mod);
      const f = M?.funcs.get(str.slice(i + 1));
      return f ? { kind: 'fn', fn: f } : undefined;
    }
    const av = /^([A-Za-z_][\w.]*?)\s*\.\s*as_view\s*\(/.exec(text);
    if (av) {
      const args = splitArgs(skel, s + av[0].length - 1);
      const info: AsView = { kw: new Map(), actions: new Map() };
      for (const a of args) {
        if (a.key) info.kw.set(a.key, { expr: argExpr(skel, a), str: argString(mod.scan, a) });
        else if (skel[a.valueStart] === '{') {
          const strs = stringsIn(mod.scan, a.valueStart, a.end);
          for (let i = 0; i + 1 < strs.length; i += 2) info.actions.set(strs[i].value.toUpperCase(), strs[i + 1].value);
        } else {
          const ep = argString(mod.scan, a);
          if (ep) info.endpoint = ep;
        }
      }
      const sym = deref(resolveChain(mod, av[1].replace(/\s+/g, '')));
      if (sym?.k === 'cls') return { kind: 'cls', cls: sym.cls, asView: info };
      return { kind: 'ext', path: sym?.k === 'ext' ? sym.path : av[1], asView: info };
    }
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(text);
    if (call && depth < 3) {
      const args = splitArgs(skel, s + call[0].length - 1);
      const first = args.find((a) => !a.key);
      return first ? viewOfArg(mod, first.valueStart, first.end, depth + 1) : undefined;
    }
    const nm = /^([A-Za-z_][\w.]*)$/.exec(text);
    if (nm) {
      const sym = deref(resolveChain(mod, nm[1]));
      if (sym?.k === 'fn') return { kind: 'fn', fn: sym.fn };
      if (sym?.k === 'cls') return { kind: 'cls', cls: sym.cls, asView: { kw: new Map(), actions: new Map() } };
    }
    return undefined;
  }
  function djFnMethods(fn: PyFunc): { methods: string[]; drf: boolean } {
    for (const d of fn.decos) {
      const n = lastSeg(d.chain);
      if (n === 'require_POST') return { methods: ['POST'], drf: false };
      if (n === 'require_GET' || n === 'require_safe') return { methods: ['GET'], drf: false };
      if (n === 'require_http_methods' || n === 'api_view') {
        const list = d.args.length ? argStrings(fn.mod.scan, d.args.find((a) => !a.key) ?? d.args[0]).map((x) => x.toUpperCase()) : [];
        return { methods: list.length ? list : n === 'api_view' ? ['GET'] : ['*'], drf: n === 'api_view' };
      }
    }
    return { methods: ['*'], drf: false };
  }
  function registerDjView(v: ViewRef, path: string, pat: DjPat): void {
    if (v.kind === 'fn') {
      const { methods, drf } = djFnMethods(v.fn);
      for (const mm of methods) addRoute(v.fn.method, mm, path, v.fn.method.line, drf || fnApi(v.fn), v.fn.mod, v.fn.cls, drf ? 'Django REST framework' : 'Django');
      return;
    }
    if (v.kind === 'cls') {
      classRoutes(v.cls, path, v.asView, isDrfClass(v.cls) ? 'Django REST framework' : 'Django');
      return;
    }
    const cname = lastSeg(v.path.replace(/\(\)$/, ''));
    if (cname === 'RedirectView') return;
    const tpl = v.asView.kw.get('template_name')?.str ?? DJ_AUTH_TEMPLATES[cname];
    const mu: MethodUnit = { name: cname, line: pat.line, routes: [], calls: [], sql: [], statements: [], views: tpl ? [tplPath(tpl, pat.mod.f.path)] : [] };
    pat.mod.synth.push(mu);
    addRoute(mu, '*', path, pat.line, !tpl, pat.mod, undefined, 'Django');
  }

  // ---- Django urls.py
  const patCache = new Map<PyMod, DjPat[]>();
  function collectPatterns(mod: PyMod, a: number, b: number, out: DjPat[], depth = 0): void {
    if (depth > 6) return;
    const skel = mod.scan.skel;
    let i = a;
    while (i < b) {
      const c = skel[i];
      if (/[\s+,*\\]/.test(c)) {
        i++;
        continue;
      }
      if (c === '[' || c === '(') {
        const close = matchParen(skel, i);
        if (close < 0 || close > b) return;
        for (const el of splitArgs(skel, i)) element(mod, el.valueStart, el.end, out, depth + 1);
        i = close + 1;
        continue;
      }
      const e = skipExpr(skel, i);
      if (e <= i) {
        i++;
        continue;
      }
      element(mod, i, e, out, depth + 1);
      i = e;
    }
  }
  function element(mod: PyMod, a: number, b: number, out: DjPat[], depth: number): void {
    const skel = mod.scan.skel;
    let s = a;
    while (s < b && /[\s*]/.test(skel[s])) s++;
    const text = skel.slice(s, b).trim();
    let m: RegExpExecArray | null;
    if ((m = /^(?:[A-Za-z_]\w*\.)?(path|re_path|url)\s*\(/.exec(text))) {
      out.push(parsePat(mod, s + m[0].length - 1, m[1] !== 'path'));
      return;
    }
    if ((m = /^(?:[A-Za-z_]\w*\.)?(i18n_patterns|format_suffix_patterns|patterns)\s*\(/.exec(text))) {
      const open = s + m[0].length - 1;
      collectPatterns(mod, open + 1, matchParen(skel, open), out, depth + 1);
      return;
    }
    if ((m = /^([A-Za-z_]\w*)\s*\.\s*urls$/.exec(text))) {
      out.push({ mod, line: mod.lineOf(s), regex: false, route: '', router: m[1] });
      return;
    }
    if ((m = /^([A-Za-z_][\w.]*)$/.exec(text)) && m[1] !== 'urlpatterns') {
      const sym = resolveChain(mod, m[1]);
      if (sym?.k === 'var' && depth < 6) collectPatterns(sym.mod, sym.a.pos, sym.a.end, out, depth + 1);
      return;
    }
    if (text.startsWith('[') || text.startsWith('(')) collectPatterns(mod, s, b, out, depth + 1);
  }
  function parsePat(mod: PyMod, open: number, regex: boolean): DjPat {
    const skel = mod.scan.skel;
    const args = splitArgs(skel, open);
    const pos = args.filter((a) => !a.key);
    const kw = (k: string) => args.find((a) => a.key === k);
    const pat: DjPat = { mod, line: mod.lineOf(open), regex, route: argString(mod.scan, kw('route') ?? kw('regex') ?? pos[0]) ?? '' };
    const nm = argString(mod.scan, kw('name') ?? pos[3]);
    if (nm) pat.name = nm;
    const v = kw('view') ?? pos[1];
    if (!v) return pat;
    let s = v.valueStart;
    while (s < v.end && /\s/.test(skel[s])) s++;
    const vtext = skel.slice(s, v.end).trim();
    const inc = /^(?:[A-Za-z_]\w*\.)?include\s*\(/.exec(vtext);
    if (inc) pat.include = parseInclude(mod, s + inc[0].length - 1);
    else if (vtext.startsWith('[')) {
      pat.include = { inline: [] };
      collectPatterns(mod, s, v.end, pat.include.inline!);
    } else pat.view = { a: v.valueStart, b: v.end };
    return pat;
  }
  function parseInclude(mod: PyMod, open: number): DjInclude {
    const skel = mod.scan.skel;
    const args = splitArgs(skel, open);
    const pos = args.filter((a) => !a.key);
    const inc: DjInclude = {};
    const ns = argString(mod.scan, args.find((a) => a.key === 'namespace'));
    if (ns) inc.namespace = ns;
    const an = argString(mod.scan, args.find((a) => a.key === 'app_name'));
    if (an) inc.appName = an;
    const first = pos[0];
    if (!first) return inc;
    let s = first.valueStart;
    while (s < first.end && /\s/.test(skel[s])) s++;
    const str = strValue(mod, s, first.end);
    if (str !== undefined) {
      inc.module = str;
      return inc;
    }
    if (skel[s] === '(') {
      const parts = splitArgs(skel, s);
      if (parts[1]) {
        const a2 = argString(mod.scan, parts[1]);
        if (a2) inc.appName = a2;
      }
      if (parts[0]) {
        const s0 = strValue(mod, parts[0].valueStart, parts[0].end);
        const t0 = parts[0].text.trim();
        if (s0 !== undefined) inc.module = s0;
        else if (t0.startsWith('[')) {
          inc.inline = [];
          collectPatterns(mod, parts[0].valueStart, parts[0].end, inc.inline);
        } else {
          const rm = /^([A-Za-z_]\w*)\s*\.\s*urls$/.exec(t0);
          if (rm) inc.router = rm[1];
          else inc.expr = t0.replace(/\s+/g, '');
        }
      }
      return inc;
    }
    if (skel[s] === '[') {
      inc.inline = [];
      collectPatterns(mod, s, first.end, inc.inline);
      return inc;
    }
    const text = skel.slice(s, first.end).trim();
    const rm = /^([A-Za-z_]\w*)\s*\.\s*urls$/.exec(text);
    if (rm) inc.router = rm[1];
    else inc.expr = text.replace(/\s+/g, '');
    return inc;
  }
  function urlPatternsOf(mod: PyMod): DjPat[] {
    const hit = patCache.get(mod);
    if (hit) return hit;
    const out: DjPat[] = [];
    patCache.set(mod, out);
    const skel = mod.scan.skel;
    const re = /(?<![\w.])urlpatterns[ \t]*(\+=|=(?!=)|\.[ \t]*(?:append|extend|insert)[ \t]*\()/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(skel))) {
      const p = m.index + m[0].length;
      if (m[1].startsWith('.')) {
        const args = splitArgs(skel, p - 1);
        args.forEach((a, i) => {
          if (/insert/.test(m![1]) && i === 0) return;
          element(mod, a.valueStart, a.end, out, 1);
        });
      } else collectPatterns(mod, p, stmtEnd(skel, p), out);
    }
    return out;
  }
  function routerMod(mod: PyMod, name: string): { mod: PyMod; regs: DrfReg[]; slash: string } | undefined {
    const own = mod.drf.get(name);
    if (own) return { mod, regs: own, slash: mod.drfNoSlash.has(name) ? '' : '/' };
    const s = resolveChain(mod, name);
    if (s?.k === 'var') {
      const r = s.mod.drf.get(s.name);
      if (r) return { mod: s.mod, regs: r, slash: s.mod.drfNoSlash.has(s.name) ? '' : '/' };
    }
    return undefined;
  }
  const usedRouters = new Set<DrfReg[]>();
  function registerRouter(mod: PyMod, name: string, base: string, ns: string[]): void {
    const r = routerMod(mod, name);
    if (!r) return;
    usedRouters.add(r.regs);
    for (const reg of r.regs) {
      const c = classOfExpr(r.mod, reg.viewset);
      if (!c) continue;
      const lookup = classAttr(c, 'lookup_url_kwarg')?.a.str ?? classAttr(c, 'lookup_field')?.a.str ?? 'pk';
      const prefix = `${base}${reg.prefix.replace(/^\^/, '').replace(/\/?\$?$/, '')}`;
      const listPath = `/${prefix}${r.slash}`;
      const detailPath = `/${prefix}/{${lookup}}${r.slash}`;
      const basename = reg.basename ?? viewModel(c)?.name.toLowerCase() ?? c.name.toLowerCase();
      const fw = 'Django REST framework';
      for (const act of viewsetActions(c)) {
        const spec = VS_ACTIONS[act];
        const { mu } = actionMethod(c, act);
        const p = addRoute(mu, spec.method, spec.detail ? detailPath : listPath, mu.line, true, c.mod, c, fw);
        setFirst(named, [...ns, `${basename}-${spec.detail ? 'detail' : 'list'}`].join(':'), p);
      }
      for (const fn of allMethods(c)) {
        const d = fn.decos.find((x) => /^(action|detail_route|list_route)$/.test(lastSeg(x.chain)));
        if (!d) continue;
        const detailArg = d.args.find((a) => a.key === 'detail');
        const detail = lastSeg(d.chain) === 'detail_route' || (detailArg ? /True/.test(detailArg.text) : false);
        const urlPath = argString(fn.mod.scan, d.args.find((a) => a.key === 'url_path')) ?? fn.name;
        const methods = argStrings(fn.mod.scan, d.args.find((a) => a.key === 'methods')).map((x) => x.toUpperCase());
        const base = (detail ? detailPath : listPath).replace(/\/?$/, '/');
        for (const mm of methods.length ? methods : ['GET']) addRoute(fn.method, mm, `${base}${urlPath}${r.slash}`, fn.method.line, true, c.mod, c, fw);
      }
    }
  }
  function walk(pats: DjPat[], prefix: string, ns: string[], seen: Set<PyMod>, depth: number): void {
    if (depth > 10) return;
    for (const p of pats) {
      const full = prefix + djRoute(p.route, p.regex);
      if (p.router !== undefined) {
        registerRouter(p.mod, p.router, full, ns);
        continue;
      }
      if (p.include) {
        const inc = p.include;
        const nsName = inc.namespace ?? inc.appName;
        if (inc.router) {
          registerRouter(p.mod, inc.router, full, nsName ? [...ns, nsName] : ns);
          continue;
        }
        if (inc.inline) {
          walk(inc.inline, full, nsName ? [...ns, nsName] : ns, seen, depth + 1);
          continue;
        }
        let target: PyMod | undefined;
        if (inc.module) target = findModule(inc.module, p.mod);
        else if (inc.expr) {
          const sym = resolveChain(p.mod, inc.expr);
          if (sym?.k === 'mod') target = sym.mod;
          else if (sym?.k === 'var') {
            const list: DjPat[] = [];
            collectPatterns(sym.mod, sym.a.pos, sym.a.end, list);
            walk(list, full, nsName ? [...ns, nsName] : ns, seen, depth + 1);
            continue;
          }
        }
        if (!target || seen.has(target)) continue;
        const n2 = nsName ?? target.appName;
        walk(urlPatternsOf(target), full, n2 ? [...ns, n2] : ns, new Set([...seen, target]), depth + 1);
        continue;
      }
      if (!p.view) continue;
      const path = `/${full}`;
      const v = viewOfArg(p.mod, p.view.a, p.view.b);
      if (v) registerDjView(v, path, p);
      if (p.name && (v || !p.view)) setFirst(named, [...ns, p.name].join(':'), normPath(path));
    }
  }
  const urlMods = mods.filter((m) => m.urlpatterns);
  if (urlMods.length) {
    const roots = new Set<PyMod>();
    for (const m of mods) {
      if (!m.rootUrlconf) continue;
      const r = findModule(m.rootUrlconf, m);
      if (r) roots.add(r);
    }
    if (!roots.size) {
      const included = new Set<PyMod>();
      const scanInc = (pats: DjPat[], depth: number) => {
        if (depth > 8) return;
        for (const p of pats) {
          const inc = p.include;
          if (!inc) continue;
          if (inc.inline) scanInc(inc.inline, depth + 1);
          const t = inc.module ? findModule(inc.module, p.mod) : inc.expr ? deref(resolveChain(p.mod, inc.expr)) : undefined;
          if (t && 'k' in t && t.k === 'mod') included.add(t.mod);
          else if (t && !('k' in t)) included.add(t);
        }
      };
      for (const m of urlMods) scanInc(urlPatternsOf(m), 0);
      for (const m of urlMods) if (!included.has(m)) roots.add(m);
    }
    for (const r of roots) walk(urlPatternsOf(r), '', [], new Set([r]), 0);
  }
  // 어디에도 붙지 않은 DRF 라우터는 루트에
  for (const m of mods) for (const [name, regs] of m.drf) if (regs.length && !usedRouters.has(regs) && m.urlpatterns) registerRouter(m, name, '', []);

  // ---- add_url_rule·add_resource
  for (const m of mods) {
    for (const r of m.urlRules) {
      const obj = fwObjOf(m, r.recv);
      const prefix = obj ? fwPrefix(obj) : '';
      const v = viewOfArg(m, r.view.valueStart, r.view.end);
      if (!v) continue;
      const fwName = obj?.kind === 'fastapi' || obj?.kind === 'router' ? 'FastAPI' : 'Flask';
      for (const u of r.urls ?? [r.rule ?? '']) {
        const path = flaskPath(prefix + u);
        let full = normPath(path);
        if (v.kind === 'fn') {
          for (const mm of r.methods.length ? r.methods : ['GET']) full = addRoute(v.fn.method, mm, path, r.line, r.resource || fnApi(v.fn), v.fn.mod, v.fn.cls, fwName);
        } else if (v.kind === 'cls') classRoutes(v.cls, path, v.asView, fwName, r.methods, !!r.resource);
        const ep = r.endpoint ?? (v.kind === 'cls' ? v.asView.endpoint ?? (r.resource ? v.cls.name.toLowerCase() : undefined) : v.kind === 'fn' ? v.fn.name : undefined);
        const bp = obj?.kind === 'bp' ? obj : obj?.kind === 'api' && obj.target ? fwObjOf(m, obj.target) : undefined;
        if (ep) setFirst(endpoints, bp?.kind === 'bp' ? `${bpName(bp)}.${ep}` : ep, full);
      }
    }
  }

  // ---- ORM 호출 → SQL
  const selfModel = (fn: PyFunc) => (fn.cls ? viewModel(fn.cls) : undefined);
  for (const fn of allFns) {
    for (const op of fn.orm) {
      let cls: PyClass | undefined;
      let table: string | undefined;
      if (op.self) cls = selfModel(fn);
      else if (op.table) {
        const s = resolveChain(fn.mod, op.model);
        if (s?.k === 'var' && s.mod.saTables.has(s.name)) table = reconcile(s.mod.saTables.get(s.name)!);
        if (!table) cls = /^[A-Z]|\.[A-Z]/.test(op.model) ? modelClass(fn.mod, op.model) : undefined;
      } else cls = modelClass(fn.mod, op.model);
      if (op.mgr && cls) {
        const a = classAttr(cls, op.mgr);
        if (!a || !/Manager\s*\(|as_manager\s*\(|from_queryset\s*\(/.test(a.a.expr)) continue;
      }
      const mi = cls ? modelOf(cls) : null;
      if (!table) {
        if (!mi || mi.abstract) continue;
        table = mi.table;
      }
      const tables: TableRef[] = op.crud.map((c) => ({ name: table!, crud: c }));
      for (const j of op.joins) {
        const jc = modelClass(fn.mod, j);
        const ji = jc ? modelOf(jc) : null;
        if (ji && !ji.abstract) tables.push({ name: ji.table, crud: 'R' });
        else {
          const js = resolveChain(fn.mod, j);
          const jt = js?.k === 'var' && js.mod.saTables.has(js.name) ? reconcile(js.mod.saTables.get(js.name)!) : undefined;
          if (jt) tables.push({ name: jt, crud: 'R' });
        }
      }
      const s = addOrmSql(fn.mod, op.line, tables, op.desc, mi?.orm ?? 'sa');
      if (s) fn.method.sql.push(s.id);
    }
    // 인스턴스 save/delete, session.add/delete, 쿼리셋 update
    for (const op of fn.varOps) {
      const v = fn.vars.get(op.v);
      const pt = fn.params.get(op.v);
      let model: PyClass | undefined;
      let constructed = false;
      const specialCls = (x: string): PyClass | undefined => {
        if (!fn.cls) return undefined;
        if (x === '@model') return selfModel(fn);
        const key = x === '@serializer' ? 'serializer_class' : 'form_class';
        const a = classAttr(fn.cls, key);
        return a ? classOfExpr(a.cls.mod, a.a.expr) : undefined;
      };
      const isSerializer = (c: PyClass) => ancestors(c).some((x) => /Serializer$/.test(x));
      if (v?.formVar) {
        const fv = fn.vars.get(v.formVar);
        const fc = fv?.cls ? (fv.cls.startsWith('@') ? specialCls(fv.cls) : classOfExpr(fn.mod, fv.cls)) : undefined;
        model = fc ? metaModel(fc) : undefined;
        constructed = !(fv && fc && (fv.instance || (isSerializer(fc) && fv.firstPos)));
      } else if (v?.cls) {
        const c0 = v.cls.startsWith('@') ? specialCls(v.cls) : classOfExpr(fn.mod, v.cls);
        if (c0 && modelOf(c0)) {
          model = c0;
          constructed = !!v.constructed;
          if (v.cls === '@model') constructed = false;
        } else if (c0 && op.op === 'save') {
          model = metaModel(c0);
          constructed = !(v.instance || (isSerializer(c0) && v.firstPos));
        }
      } else if (pt) {
        const c0 = classOfExpr(fn.mod, pt);
        if (c0 && modelOf(c0)) model = c0;
      }
      if (!model) continue;
      const mi = modelOf(model);
      if (!mi || mi.abstract) continue;
      let crud: Crud;
      if (op.op === 'save' || op.op === 'add') crud = constructed ? 'C' : 'U';
      else if (op.op === 'delete') crud = 'D';
      else if (op.op === 'merge') crud = 'U';
      else {
        if (!v?.qs) continue;
        crud = 'U';
      }
      const s = addOrmSql(fn.mod, op.line, [{ name: mi.table, crud }], `${op.v}.${op.op}() → ${model.name}`, mi.orm);
      if (s) fn.method.sql.push(s.id);
    }
  }

  // ---- SQL 상수 참조
  for (const fn of allFns) {
    for (const ref of fn.constRefs) {
      const parts = ref.split('.');
      let id: string | undefined;
      if ((parts[0] === 'self' || parts[0] === 'cls') && parts.length === 2 && fn.cls) {
        const a = classAttr(fn.cls, parts[1]);
        id = a?.cls.sqlConsts.get(parts[1]);
      } else if (parts.length === 1 && fn.mod.sqlConsts.has(ref)) id = fn.mod.sqlConsts.get(ref);
      else {
        const s = resolveChain(fn.mod, ref);
        if (s?.k === 'var') id = s.mod.sqlConsts.get(s.name);
        else if (s?.k === 'cattr') id = s.cls.sqlConsts.get(s.name);
      }
      if (id && !fn.method.sql.includes(id)) fn.method.sql.push(id);
    }
  }

  // ---- 호출 → 대상 유닛 fqn
  function fieldClass(c: PyClass, name: string): PyClass | undefined {
    for (const b of [c, ...projectBases(c)]) {
      const t = b.fields.get(name);
      if (t) {
        const r = classOfExpr(b.mod, t);
        if (r) return r;
      }
    }
    return undefined;
  }
  function resolveCall(fn: PyFunc, chain: string): PyFunc | undefined {
    const parts = chain.split('.');
    if (parts[0] === 'super') {
      if (!fn.cls) return undefined;
      for (const b of projectBases(fn.cls)) {
        const r = methodOf(b, parts[1]);
        if (r) return r;
      }
      return undefined;
    }
    if (parts[0] === 'self' || parts[0] === 'cls') {
      if (!fn.cls) return undefined;
      if (parts.length === 2) return methodOf(fn.cls, parts[1]);
      if (parts.length === 3) {
        const t = fieldClass(fn.cls, parts[1]);
        return t ? methodOf(t, parts[2]) : undefined;
      }
      return undefined;
    }
    if (parts.length === 1) {
      const local = fn.children.find((x) => x.name === parts[0]) ?? fn.outer?.children.find((x) => x.name === parts[0]);
      if (local) return local;
    }
    const v = fn.vars.get(parts[0]);
    const pt = fn.params.get(parts[0]);
    if (parts.length === 2 && (v?.cls || pt)) {
      const typ = v?.cls ?? pt!;
      const c = typ.startsWith('@') ? undefined : classOfExpr(fn.mod, typ);
      return c ? methodOf(c, parts[1]) : undefined;
    }
    if (v) return undefined;
    const s = resolveChain(fn.mod, chain);
    return s?.k === 'fn' ? s.fn : undefined;
  }
  for (const fn of allFns) {
    const seen = new Set<PyFunc>();
    for (const c of fn.calls) {
      const t = resolveCall(fn, c.chain);
      if (!t || t === fn || seen.has(t)) continue;
      seen.add(t);
      fn.targets.add(t);
      fn.method.calls.push({ via: fqnOfFn(t), method: t.method.name, line: c.line });
    }
  }

  // ---- 리다이렉트 주소
  const djNamed = (name: string): string | undefined => {
    const hit = named.get(name);
    if (hit) return hit;
    const tail = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    const c = [...named.keys()].filter((k) => k === tail || k.endsWith(`:${tail}`));
    return c.length === 1 ? named.get(c[0]) : undefined;
  };
  const epPath = (name: string, fromPath: string): string | undefined => {
    if (endpoints.has(name)) return endpoints.get(name);
    const tail = name.startsWith('.') ? name : `.${name}`;
    let c = [...endpoints.keys()].filter((k) => k.endsWith(tail));
    if (c.length > 1) {
      // 같은 Blueprint 폴더(템플릿·모듈 경로가 가까운 것)
      const score = (k: string) => {
        const bp = k.slice(0, k.length - tail.length).split('.').pop() ?? '';
        return fromPath.split('/').includes(bp) ? 1 : 0;
      };
      const best = Math.max(...c.map(score));
      c = c.filter((k) => score(k) === best);
    }
    if (c.length >= 1 && (c.length === 1 || name.startsWith('.'))) return endpoints.get(c[0]);
    return faNames.get(name.replace(/^\./, ''));
  };
  for (const fn of allFns) {
    if (!fn.redirs.length) continue;
    fn.method.redirects = fn.redirs.map((r) => (r.kind === 'path' ? r.value : (r.kind === 'name' ? djNamed(r.value) : epPath(r.value, fn.mod.f.path)) ?? r.value));
  }

  // ---- 템플릿: 이름 붙은 URL·상대 URL·include·조각
  const rendered = new Map<string, Set<string>>(); // 템플릿 경로 → 렌더링 라우트 경로
  for (const { mu } of routed) {
    for (const v of mu.views) {
      if (!rendered.has(v)) rendered.set(v, new Set());
      for (const r of mu.routes) if (r.method === '*' || r.method === 'GET') rendered.get(v)!.add(r.path);
    }
  }
  const included = new Set<string>();
  for (const t of tpls) {
    for (const mk of t.marks) mk.ref.url = (mk.kind === 'dj' ? djNamed(mk.name) : epPath(mk.name, t.f.path)) ?? '';
    const own = [...(rendered.get(t.f.path) ?? [])];
    for (const r of t.rels) {
      if (own.length !== 1) {
        r.ref.url = '';
        continue;
      }
      if (r.raw === './') r.ref.url = own[0];
      else {
        const base = own[0].replace(/[^/]*$/, '');
        const joined = `${base}${r.raw}`.split('/');
        const out: string[] = [];
        for (const seg of joined) {
          if (seg === '..') out.pop();
          else if (seg !== '.') out.push(seg);
        }
        r.ref.url = out.join('/') || '/';
      }
    }
    t.view.urls = t.view.urls.filter((u) => u.url);
    for (const inc of t.incs) {
      const r = findTemplate(inc, t.f.path);
      if (!r || r === t) continue;
      if (!t.view.includes.includes(r.f.path)) t.view.includes.push(r.f.path);
      included.add(r.f.path);
    }
  }
  // 제목에 공통으로 붙은 사이트 이름(Flasky - Login, 글 목록 | 사내 포털) 떼기
  const SEP = /\s+[|\-–·:]\s+/;
  const titled = tpls.filter((t) => t.view.title && SEP.test(t.view.title));
  const partCount = new Map<string, number>();
  for (const t of titled) {
    const parts = t.view.title!.split(SEP);
    for (const p of new Set([parts[0], parts[parts.length - 1]])) partCount.set(p, (partCount.get(p) ?? 0) + 1);
  }
  const common = (p: string) => (partCount.get(p) ?? 0) >= Math.max(3, Math.ceil(tpls.length * 0.3));
  for (const t of titled) {
    let parts = t.view.title!.split(SEP);
    if (parts.length >= 2 && common(parts[0])) parts = parts.slice(1);
    if (parts.length >= 2 && common(parts[parts.length - 1])) parts = parts.slice(0, -1);
    t.view.title = parts.join(' - ');
  }
  // 제목이 사이트 이름뿐이면(Flasky - {{ user.name }}) 첫 화면 말고는 제목 없음으로 (URL 로 이름을 지음)
  for (const t of tpls) {
    if (!t.view.title || !common(t.view.title) || rendered.get(t.f.path)?.has('/')) continue;
    delete t.view.title;
    delete t.view.titleLine;
  }
  for (const t of tpls) {
    if (included.has(t.f.path) || FRAG_NAME.test(t.f.name) || FRAG_DIR.test(`/${t.f.path}`)) t.view.fragment = true;
    // 매크로만 담은 파일
    if (/\{%-?\s*macro\b/.test(t.text)) {
      const rest = t.text
        .replace(/\{#[\s\S]*?#\}/g, '')
        .replace(/\{%-?\s*macro\b[\s\S]*?\{%-?\s*endmacro\s*-?%\}/g, '')
        .replace(/\{%[\s\S]*?%\}/g, '');
      if (!/<[a-z]/i.test(rest)) t.view.fragment = true;
    }
  }
  // 사이드바·메뉴 템플릿: {% url %}·url_for 를 풀어 메뉴 분석기에 다시 넘김
  for (const t of tpls) {
    if (!/\{%-?\s*url\b|url_for\(/.test(t.text) || !menuAnalyzer.accepts(t.f, t.text)) continue;
    const resolved = t.text
      .replace(/\{#[\s\S]*?#\}/g, blank)
      .replace(DJ_URL, (all, _q, name: string) => `${djNamed(name) ?? '#'}${keepNl(all)}`)
      .replace(DJ_URL_BARE, (all, name: string) => `${djNamed(name) ?? '#'}${keepNl(all)}`)
      .replace(URL_FOR, (all, _q, ep: string) => `${ep === 'static' ? '#' : epPath(ep, t.f.path) ?? '#'}${keepNl(all)}`)
      .replace(/\{%[\s\S]*?%\}/g, blank);
    const keep = ctx.facts.menus.filter((x) => x.evidence.file !== t.f.id);
    ctx.facts.menus.length = 0;
    ctx.facts.menus.push(...keep);
    menuAnalyzer.analyze(t.f, resolved, ctx);
  }

  // ---- 유닛
  const isViewClass = (c: PyClass) => ancestors(c).some((x) => /(View|ViewSet|APIView|Resource|MethodView)$/.test(x));
  for (const m of mods) {
    const fns = m.all.filter((f) => !f.cls);
    const methods = [...fns.map((f) => f.method), ...m.synth];
    if (methods.length) {
      const segs = m.dotted.split('.');
      const last = segs[segs.length - 1].toLowerCase();
      let kind: CodeUnit['kind'] = 'other';
      if (routedMods.has(m) && fns.some((f) => f.method.routes.length) || m.synth.some((x) => x.routes.length)) kind = 'controller';
      else if (/^(views?|api|apis|routes?|routers?|endpoints?|controllers?|handlers?|resources?)$/.test(last) && m.web) kind = 'controller';
      else if (/services?$/.test(last)) kind = 'service';
      else if (/^(crud|repository|repositories|repo|repos|dao|daos|db|queries|query|store|storage|models?|mapper)$/.test(last) || /_(dao|repo|repository|crud|queries|mapper)$/.test(last) || fns.some((f) => f.method.sql.length)) kind = 'dao';
      ctx.addUnit({
        file: m.f.id, name: segs.slice(-2).join('.'), fqn: `py:${m.dotted}`, kind, line: 1, extendsOrImplements: [], fields: {}, methods,
        ...(m.doc ? { doc: m.doc } : {}),
      });
    }
    for (const c of m.classes.values()) {
      const mi = modelOf(c);
      let kind: CodeUnit['kind'] = 'other';
      if (mi && !mi.abstract) kind = 'model';
      else if (routedClasses.has(c) || isViewClass(c)) kind = 'controller';
      else if (/(Service|Manager|UseCase|Usecase|Logic)$/.test(c.name)) kind = 'service';
      else if (/(Repository|Repo|Dao|DAO|Store|Crud|CRUD|Mapper|Queries)$/.test(c.name) || [...c.methods.values()].some((f) => f.method.sql.length)) kind = 'dao';
      const fields: Record<string, string> = {};
      for (const [k, t] of c.fields) {
        const fc = classOfExpr(c.mod, t);
        fields[k] = fc ? fqnOfCls(fc) : t;
      }
      ctx.addUnit({
        file: m.f.id, name: c.name, fqn: fqnOfCls(c), kind, line: c.def.line, extendsOrImplements: c.bases.map((b) => lastSeg(b)), fields,
        methods: [...m.all.filter((f) => f.cls === c).map((f) => f.method), ...c.synth],
        ...(mi && !mi.abstract ? { table: mi.table } : {}),
        ...(c.doc ? { doc: c.doc } : {}),
      });
      if (mi && !mi.abstract && m.f.layer === 'OTHER') m.f.layer = 'MODEL';
    }
  }

  // ---- import 된 횟수 (라이브러리 모듈 판단)
  for (const m of mods) {
    const seen = new Set<PyMod>();
    for (const imp of [...m.imports.values(), ...m.stars]) {
      const s = resolveImport(m, imp, 0);
      const t = s?.k === 'mod' ? s.mod : s?.k === 'cls' ? s.cls.mod : s?.k === 'fn' ? s.fn.mod : s?.k === 'var' ? s.mod : undefined;
      if (imp.name) {
        const rel = imp.level > 0;
        const target = rel ? relTarget(m, imp) : imp.module;
        const M = rel ? byDotted.get(target) : findModule(target, m);
        if (M && M !== m) seen.add(M);
      }
      if (t && t !== m) seen.add(t);
    }
    for (const t of seen) t.importedBy++;
  }

  // ---- 배치: DB 를 쓰는 실행 스크립트
  const reachSql = (start: PyFunc[]): string[] => {
    const out = new Set<string>();
    const seen = new Set<PyFunc>();
    const stack = start.map((f) => ({ f, d: 0 }));
    while (stack.length) {
      const { f, d } = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const id of f.method.sql) out.add(id);
      if (d < 6) for (const t of f.targets) stack.push({ f: t, d: d + 1 });
    }
    return [...out];
  };
  const docTitle = (doc?: string) => {
    if (!doc) return undefined;
    const head = doc.split(/\s*[:：]\s+|\s+[-–]\s+/)[0].replace(/[.。]+$/, '').trim();
    return head ? tidyTitle(head) : undefined;
  };
  const pyBatches = new Map<string, BatchFact>();
  for (const b of ctx.facts.batches) if (b.kind === 'python') pyBatches.set(b.entry, b);
  const drop = new Set<BatchFact>();
  for (const m of mods) {
    const existing = pyBatches.get(m.f.id);
    const routedHere = routedMods.has(m) || [...m.classes.values()].some((c) => routedClasses.has(c));
    const special = /(^|\/)(manage|wsgi|asgi|setup|conftest|settings|config|__init__|__main__)\.py$/i.test(m.f.path) || /(^|\/)settings\//.test(m.f.path);
    const mgmt = /\/management\/commands\/[^/]+\.py$/.test(m.f.path) && m.classes.has('Command');
    const sqlIds = reachSql(mgmt ? [...m.classes.get('Command')!.methods.values()] : [m.modFn, ...m.all]);
    const entry = !routedHere && !m.runsApp && !special && (mgmt || m.hasMain || (BATCH_DIR.test(m.f.path) && m.importedBy === 0));
    if (!entry || (!m.driver && !sqlIds.length)) {
      if (existing && (special || (!m.hasMain && m.importedBy > 0) || routedHere)) drop.add(existing);
      continue;
    }
    let schedule: BatchFact['schedule'];
    const cmd = mgmt ? baseName(m.f.path).replace(/\.py$/, '') : '';
    if (mgmt) {
      const s = ctx.facts.schedules.find((x) => new RegExp(`manage\\.py\\s+${cmd}\\b`).test(x.command));
      if (s) schedule = { expr: s.expr, text: cronText(s.expr), evidence: s.evidence };
      if (!schedule && !sqlIds.length) continue;
    }
    const title = (mgmt ? m.classes.get('Command')!.attrs.get('help')?.str : undefined) ?? docTitle(m.doc);
    const b: BatchFact = existing ?? { key: m.f.path, name: '', kind: 'python', entry: m.f.id, calls: [], sql: [], logs: [] };
    if (title) b.title = tidyTitle(title);
    b.name = b.title ?? (cmd || baseName(m.f.path).replace(/\.py$/, ''));
    for (const id of sqlIds) if (!b.sql.includes(id)) b.sql.push(id);
    for (const l of m.logs) if (!b.logs.includes(l)) b.logs.push(l);
    if (schedule && !b.schedule) b.schedule = schedule;
    if (!existing) ctx.facts.batches.push(b);
    if (m.f.layer !== 'TEST') m.f.layer = 'BATCH';
  }
  if (drop.size) {
    const keep = ctx.facts.batches.filter((b) => !drop.has(b));
    ctx.facts.batches.length = 0;
    ctx.facts.batches.push(...keep);
  }

  // ---- 파일 계층
  for (const m of mods) {
    const f = m.f;
    if (f.layer === 'BATCH' || f.layer === 'TEST') continue;
    if (/(^|\/)settings(\/|\.py$)|(^|\/)(config|conf)\.py$/.test(f.path)) f.layer = 'CONFIG';
    else if (m.urlpatterns && /urls\.py$/.test(f.name)) f.layer = 'ROUTE';
    else if (routedMods.has(m)) f.layer = 'CONTROLLER';
    else if (f.layer === 'OTHER' && [...m.classes.values()].some((c) => modelOf(c) && !modelOf(c)!.abstract)) f.layer = 'MODEL';
    else if (f.layer === 'OTHER' && /services?\.py$|\/services?\//.test(f.path)) f.layer = 'SERVICE';
    else if (f.layer === 'OTHER' && m.sqlIds.length) f.layer = 'DAO';
  }
  if (tpls.length) {
    const dj = mods.some((m) => m.web && [...m.imports.values()].some((i) => /^django\b/.test(i.module)));
    for (const t of tpls) ctx.hit('화면', dj ? 'Django 템플릿' : 'Jinja2', t.f.id, 1, 1);
  }
}

// ------------------------------------------------------------------ 분석기

const SKIP_PY = /(^|\/)(migrations|alembic|site-packages|dist-packages|__pypackages__)\/|(^|\/)(setup|conftest|noxfile|fabfile)\.py$|(^|\/)test_[^/]*\.py$|_tests?\.py$/i;

export const pythonAnalyzer: Analyzer = {
  name: 'python',
  order: 27,
  accepts(f) {
    if (f.layer === 'TEST') return false;
    if (f.lang === 'Python') return !SKIP_PY.test(f.path);
    return (f.lang === 'HTML' || f.lang === 'Template') && /(^|\/)templates\//i.test(f.path) && !/(^|\/)(src\/main|WEB-INF|WebContent|node_modules)\//.test(f.path);
  },
  analyze(f, text, ctx) {
    const st = state(ctx);
    if (f.lang === 'Python') {
      if (text.length > 1_500_000) return;
      analyzeModule(f, text, ctx, st);
      return;
    }
    st.tplCands.push({ f, text });
  },
  finish(ctx) {
    const st = states.get(ctx);
    if (st && st.mods.length) finishPy(ctx, st);
  },
};
