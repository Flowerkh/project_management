// PHP 분석기: Laravel · CodeIgniter 3/4 · 순수 PHP 페이지
// 클래스·메서드·라우트·화면(Blade/PHP 뷰)·SQL(문자열·쿼리 빌더·Eloquent)을 Facts로 남긴다.
import type { Analyzer, Ctx } from '../context';
import type { CallRef, CodeUnit, Crud, DdlColumn, FileInfo, MethodUnit, Route, TableRef, UrlRef, ViewFact } from '../types';
import { baseName, dirName, makeLineIndex, normalizePath } from '../files';
import { compactSql, isSqlLike, parseSql } from '../sql';
import { argClass, argString, lexPhp, matchClose, splitArgs, simpleName, type PT } from './php-lex';
import { extractRefs, extractScripts, extractTitle, normalizeRef } from './web-refs';

type Framework = 'laravel' | 'ci3' | 'ci4' | 'plain';

interface RouteDef {
  file: string;
  line: number;
  methods: string[];
  path: string;
  name?: string;
  ctrl?: string; // 컨트롤러 클래스 (FQN 또는 단순 이름)
  action?: string;
  api: boolean;
  /** 클로저·Route::view 처럼 라우트 파일 안에서 끝나는 경우 */
  inline?: MethodUnit;
  root: string;
  fw: Framework;
}

interface ModelOp {
  method: MethodUnit;
  model: string; // 클래스 단순 이름 또는 필드 이름(필드면 field=true)
  field?: boolean;
  cls?: string; // 호출한 클래스 이름 (필드 타입 찾기용)
  ops: string[]; // 체인 메서드 이름들
  joins: string[];
  relations: string[];
  created?: boolean; // new Model 로 만든 인스턴스
  file: string;
  line: number;
  instance?: boolean;
}

interface ClassInfo {
  unit: CodeUnit;
  ext?: string; // extends (단순 이름)
  fw: Framework;
  root: string;
  relations: Map<string, string>; // 관계 메서드 → 대상 모델
  tableLiteral?: string;
  isModelBase?: boolean;
  visibility: Map<MethodUnit, string>;
  params: Map<MethodUnit, number>;
  ci3Seg?: string; // CI3 컨트롤러 URL 조각 (admin/order)
  ci4?: boolean;
}

interface PendingRef {
  view: ViewFact;
  url: UrlRef;
  name?: string; // route('name')
  action?: { ctrl: string; method: string }; // action('Ctrl@m')
}

interface PhpState {
  roots: { laravel: string[]; ci3: string[]; ci4: string[] };
  indexDirs: Set<string>;
  routes: RouteDef[];
  ci3Routes: { root: string; from: string; to: string; methods: string[]; file: string; line: number }[];
  ci4Auto: Set<string>;
  modelOps: ModelOp[];
  classes: Map<string, ClassInfo[]>; // 단순 이름(소문자) → 클래스
  pendingRefs: PendingRef[];
  includes: Map<string, string[]>; // 파일 ID → include한 경로들
  pageUnits: Map<string, { unit: CodeUnit; method: MethodUnit; view?: ViewFact }>; // 순수 PHP 파일 ID
  viewFacts: Map<string, { view: ViewFact; fw: Framework; root: string; name: string }>;
  viewLoads: { method: MethodUnit; views: string[] }[];
  routeUnits: Map<string, CodeUnit>; // 라우트 파일 ID → 클로저용 유닛
}

const states = new WeakMap<Ctx, PhpState>();

function state(ctx: Ctx): PhpState {
  let st = states.get(ctx);
  if (st) return st;
  const paths = ctx.facts.files.map((f) => f.path);
  const has = new Set(paths);
  const laravel = new Set<string>();
  const ci3 = new Set<string>();
  const ci4 = new Set<string>();
  const indexDirs = new Set<string>();
  for (const f of ctx.facts.files) {
    const p = f.path;
    const d = dirName(p);
    if (f.name === 'artisan' || (f.name === 'composer.json' && /laravel\/framework/.test(ctx.facts.texts.get(f.id) ?? ''))) laravel.add(d);
    let m = /^(.*?)(?:^|\/)application\/(controllers|config\/routes\.php)/.exec(p);
    if (m && !/\/vendor\//.test(p)) ci3.add(m[1].replace(/\/$/, ''));
    m = /^(.*?)(?:^|\/)app\/(Config\/Routes\.php|Controllers\/)/.exec(p);
    if (m && !/\/vendor\//.test(p)) {
      const root = m[1].replace(/\/$/, '');
      // Laravel 의 app/Http/Controllers 와 구분: app/Controllers 는 CI4
      if (!laravel.has(root)) ci4.add(root);
    }
    if (/^index\.(php|html?)$/i.test(f.name) && !f.excluded) indexDirs.add(d);
  }
  for (const r of laravel) ci4.delete(r);
  void has;
  st = {
    roots: { laravel: [...laravel], ci3: [...ci3], ci4: [...ci4] },
    indexDirs,
    routes: [],
    ci3Routes: [],
    ci4Auto: new Set(),
    modelOps: [],
    classes: new Map(),
    pendingRefs: [],
    includes: new Map(),
    pageUnits: new Map(),
    viewFacts: new Map(),
    viewLoads: [],
    routeUnits: new Map(),
  };
  states.set(ctx, st);
  return st;
}

function under(root: string, path: string): string | null {
  if (root === '') return path;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

function classify(st: PhpState, path: string): { fw: Framework; root: string; rel: string } {
  for (const root of st.roots.laravel) {
    const rel = under(root, path);
    if (rel !== null) return { fw: 'laravel', root, rel };
  }
  for (const root of st.roots.ci4) {
    const rel = under(root, path);
    if (rel !== null && /^(app|system|public|writable|tests)\//.test(rel)) return { fw: 'ci4', root, rel };
  }
  for (const root of st.roots.ci3) {
    const rel = under(root, path);
    if (rel !== null && /^(application|system)\//.test(rel)) return { fw: 'ci3', root, rel };
  }
  return { fw: 'plain', root: '', rel: path };
}

// ------------------------------------------------------------------ 이름 규칙

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function plural(word: string): string {
  const w = word;
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(child)$/.test(w)) return `${w}ren`;
  if (/^(person)$/.test(w)) return 'people';
  return `${w}s`;
}

export function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

function eloquentTable(cls: string): string {
  const s = snake(cls);
  const parts = s.split('_');
  parts[parts.length - 1] = plural(parts[parts.length - 1]);
  return parts.join('_');
}

function joinUrl(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split('/')).filter((s) => s && s !== '');
  return `/${segs.join('/')}`;
}

/** 'orders o' / 'orders as o' / 'db.orders' → orders */
function tableArg(s: string): string {
  const t = s.trim().split(/\s+/)[0].replace(/[`"]/g, '');
  return t.slice(t.lastIndexOf('.') + 1);
}

// ------------------------------------------------------------------ 체인 연산 → CRUD

const OP_CRUD: Record<string, Crud[]> = {
  create: ['C'], forcecreate: ['C'], insert: ['C'], insertgetid: ['C'], insertorignore: ['C'], insertusing: ['C'], insertbatch: ['C'],
  createmany: ['C'], savemany: ['C'], firstorcreate: ['R', 'C'], updateorcreate: ['C', 'U'], updateorinsert: ['C', 'U'], upsert: ['C', 'U'],
  replace: ['C', 'U'], update: ['U'], updatebatch: ['U'], increment: ['U'], decrement: ['U'], incrementeach: ['U'], decrementeach: ['U'],
  touch: ['U'], restore: ['U'], push: ['U'], save: ['U'], delete: ['D'], forcedelete: ['D'], destroy: ['D'], truncate: ['D'], purgedeleted: ['D'],
  emptytable: ['D'],
};

function opsCrud(ops: string[], created?: boolean): Crud[] {
  const set = new Set<Crud>();
  for (const o of ops) {
    const c = OP_CRUD[o.toLowerCase()];
    if (c) {
      for (const x of c) set.add(o.toLowerCase() === 'save' && created ? 'C' : x);
    }
  }
  if (!set.size) set.add('R');
  return (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => set.has(c));
}

const FACADES = new Set([
  'route', 'schema', 'cache', 'log', 'auth', 'session', 'request', 'response', 'redirect', 'validator', 'storage', 'mail', 'event', 'hash', 'str', 'arr',
  'carbon', 'config', 'app', 'url', 'gate', 'http', 'queue', 'artisan', 'lang', 'cookie', 'file', 'crypt', 'password', 'notification', 'bus', 'broadcast',
  'blade', 'date', 'inertia', 'debugbar', 'excel', 'pdf', 'image', 'datatables', 'self', 'static', 'parent', 'collection', 'json', 'exception', 'closure',
]);

// ------------------------------------------------------------------ 메서드 본문 분석

interface BodyCtx {
  f: FileInfo;
  ctx: Ctx;
  st: PhpState;
  lineOf: (p: number) => number;
  method: MethodUnit;
  cls?: { name: string; fields: Record<string, string> };
  fw: Framework;
}

function newMethod(name: string, line: number): MethodUnit {
  return { name, line, routes: [], calls: [], sql: [], statements: [], views: [] };
}

function addSqlText(bc: BodyCtx, text: string, pos: number): void {
  if (!isSqlLike(text)) return;
  const p = parseSql(text);
  if (!p.tables.length) return;
  if (bc.fw === 'plain') bc.ctx.hit('데이터 접근', 'SQL 직접 작성(mysqli·PDO)', bc.f.id, bc.lineOf(pos), 1);
  const s = bc.ctx.addSql({
    file: bc.f.id, line: bc.lineOf(pos), origin: 'string', kind: p.kind, tables: p.tables,
    ...(p.dynamic ? { dynamic: true } : {}), text: compactSql(text),
  });
  bc.method.sql.push(s.id);
}

function addBuilderSql(bc: BodyCtx, refs: TableRef[], pos: number, desc: string): void {
  bc.ctx.hit('데이터 접근', bc.fw === 'ci3' || bc.fw === 'ci4' ? 'CodeIgniter 쿼리 빌더' : 'Laravel 쿼리 빌더', bc.f.id, bc.lineOf(pos), 1);
  const seen = new Set<string>();
  const tables = refs.filter((r) => r.name && !seen.has(`${r.name}:${r.crud}`) && seen.add(`${r.name}:${r.crud}`));
  if (!tables.length) return;
  const crud = new Set(tables.map((t) => t.crud));
  const kind = crud.has('C') ? 'insert' : crud.has('U') ? 'update' : crud.has('D') ? 'delete' : 'select';
  const s = bc.ctx.addSql({ file: bc.f.id, line: bc.lineOf(pos), origin: 'orm', kind, tables, text: desc });
  bc.method.sql.push(s.id);
}

/** 문자열 연결(. 연산) 읽기: 시작 위치의 str 토큰부터 */
function readConcat(t: PT[], j: number, end: number): { text: string; next: number } {
  let text = t[j].v;
  let k = j + 1;
  while (k < end && t[k].k === 'op' && t[k].v === '.') {
    k++;
    if (k >= end) break;
    if (t[k].k === 'str') {
      text += t[k].v;
      k++;
      continue;
    }
    text += '${v}';
    k = skipOperand(t, k, end);
  }
  return { text, next: k };
}

/** 피연산자 하나 건너뛰기: $var->a->b(...)[...], func(...), CONST, (expr) */
function skipOperand(t: PT[], k: number, end: number): number {
  const x = t[k];
  if (!x) return k + 1;
  if (x.k === 'op' && (x.v === '(' || x.v === '[')) return matchClose(t, k) + 1;
  if (x.k === 'var' || x.k === 'id' || x.k === 'num') {
    k++;
    for (let g = 0; g < 20 && k < end; g++) {
      const y = t[k];
      if (y.k === 'op' && (y.v === '->' || y.v === '?->' || y.v === '::') && t[k + 1]) {
        k += 2;
        continue;
      }
      if (y.k === 'op' && (y.v === '(' || y.v === '[')) {
        k = matchClose(t, k) + 1;
        continue;
      }
      break;
    }
    return k;
  }
  return k + 1;
}

/** 체인 읽기: open = 첫 호출의 '(' 위치. ->m(args) 반복 */
function readChain(t: PT[], open: number, end: number): { calls: { name: string; open: number }[]; next: number } {
  const calls: { name: string; open: number }[] = [];
  let k = matchClose(t, open) + 1;
  while (k + 2 < end && t[k].k === 'op' && (t[k].v === '->' || t[k].v === '?->') && t[k + 1].k === 'id') {
    if (t[k + 2].v === '(') {
      calls.push({ name: t[k + 1].v, open: k + 2 });
      k = matchClose(t, k + 2) + 1;
    } else {
      k += 2; // 속성 접근
    }
  }
  return { calls, next: k };
}

function relationArgs(t: PT[], open: number): string[] {
  const out: string[] = [];
  for (const r of splitArgs(t, open)) {
    for (let j = r[0]; j < r[1]; j++) {
      if (t[j].k === 'str' && !(t[j + 1]?.v === '=>' && false)) out.push(t[j].v.split('.')[0].split(':')[0]);
    }
  }
  return out;
}

const LOAD_VIEW_NOT = new Set(['->', '::', 'function', '?->']);

function analyzeBody(t: PT[], a: number, b: number, bc: BodyCtx, params: Record<string, string> = {}): void {
  const locals: Record<string, string> = { ...params };
  const builders: Record<string, string> = {}; // $builder = $db->table('x')
  const created = new Set<string>();
  const sqlVars = new Map<string, { text: string; pos: number }>();
  const flushVar = (name: string) => {
    const v = sqlVars.get(name);
    if (v) addSqlText(bc, v.text, v.pos);
    sqlVars.delete(name);
  };
  const consumed = new Set<number>();
  const clsName = bc.cls?.name;

  // 지역 변수 타입 1차
  for (let i = a; i < b - 3; i++) {
    if (t[i].k !== 'var' || t[i + 1].v !== '=') continue;
    const v = t[i].v;
    const x = t[i + 2];
    if (x.v === 'new' && t[i + 3]?.k === 'id') {
      locals[v] = simpleName(t[i + 3].v);
      created.add(v);
    } else if (x.k === 'id' && t[i + 3]?.v === '::' && t[i + 4]?.k === 'id' && /^[A-Z]/.test(simpleName(x.v)) && !FACADES.has(simpleName(x.v).toLowerCase())) {
      locals[v] = simpleName(x.v);
      if (/^(create|forceCreate|make|firstOrNew|firstOrCreate|updateOrCreate)$/.test(t[i + 4].v)) created.add(v);
    } else if (x.k === 'id' && (x.v === 'model' || x.v === 'app' || x.v === 'resolve') && t[i + 3]?.v === '(') {
      const r = splitArgs(t, i + 3)[0];
      const c = r ? argClass(t, r) ?? argString(t, r) : null;
      if (c) locals[v] = simpleName(c);
    } else if (x.k === 'var' && x.v === 'this' && t[i + 3]?.v === '->' && t[i + 4]?.v === 'db' && t[i + 5]?.v === '->' && t[i + 6]?.v === 'table' && t[i + 7]?.v === '(') {
      const s = argString(t, splitArgs(t, i + 7)[0] ?? [0, 0]);
      if (s) builders[v] = tableArg(s);
    } else if (x.k === 'var' && t[i + 3]?.v === '->' && t[i + 4]?.v === 'table' && t[i + 5]?.v === '(') {
      const s = argString(t, splitArgs(t, i + 5)[0] ?? [0, 0]);
      if (s) builders[v] = tableArg(s);
    } else if (x.k === 'id' && simpleName(x.v) === 'DB' && t[i + 3]?.v === '::' && t[i + 4]?.v === 'table' && t[i + 5]?.v === '(') {
      const s = argString(t, splitArgs(t, i + 5)[0] ?? [0, 0]);
      if (s) builders[v] = tableArg(s);
    }
  }

  for (let i = a; i < b; i++) {
    const x = t[i];
    if (consumed.has(i)) continue;
    // ---------------- $this->…
    if (x.k === 'var' && x.v === 'this' && t[i + 1]?.v === '->' && t[i + 2]?.k === 'id') {
      const p1 = t[i + 2].v;
      // $this->load->view/model
      if (p1 === 'load' && t[i + 3]?.v === '->' && t[i + 4]?.k === 'id' && t[i + 5]?.v === '(') {
        const what = t[i + 4].v;
        const args = splitArgs(t, i + 5);
        const s0 = args[0] ? argString(t, args[0]) : null;
        if (what === 'view' && s0) {
          bc.method.views.push(s0);
        } else if (what === 'model' && s0 && bc.cls) {
          const alias = (args[1] ? argString(t, args[1]) : null) ?? baseName(s0);
          const clsN = baseName(s0);
          bc.cls.fields[alias] = clsN.charAt(0).toUpperCase() + clsN.slice(1);
          bc.cls.fields[alias.toLowerCase()] = bc.cls.fields[alias];
        }
        i = matchClose(t, i + 5);
        continue;
      }
      // $this->db->… (CodeIgniter 쿼리 빌더)
      if (p1 === 'db' && t[i + 3]?.v === '->' && t[i + 4]?.k === 'id' && t[i + 5]?.v === '(') {
        i = ciDbChain(t, i + 4, b, bc) - 1;
        continue;
      }
      // $this->field->m(
      if (t[i + 3]?.v === '->' && t[i + 4]?.k === 'id' && t[i + 5]?.v === '(') {
        const m = t[i + 4].v;
        const call: CallRef = { via: p1, method: m, line: bc.lineOf(x.p) };
        bc.method.calls.push(call);
        const ch = readChain(t, i + 5, b);
        bc.st.modelOps.push({
          method: bc.method, model: p1, field: true, cls: clsName, ops: [m, ...ch.calls.map((c) => c.name)],
          joins: [], relations: [], file: bc.f.id, line: bc.lineOf(x.p), instance: true,
        });
        i = i + 4;
        continue;
      }
      // $this->m(
      if (t[i + 3]?.v === '(') {
        if (clsName) bc.method.calls.push({ via: `this.${clsName}`, method: p1, line: bc.lineOf(x.p) });
        // CI4: $this->include('x') / $this->extend('x') 는 뷰에서만
        i = i + 2;
        continue;
      }
      continue;
    }
    // ---------------- $var->…
    if (x.k === 'var' && x.v !== 'this' && (t[i + 1]?.v === '->' || t[i + 1]?.v === '?->') && t[i + 2]?.k === 'id' && t[i + 3]?.v === '(') {
      const v = x.v;
      const m = t[i + 2].v;
      if (builders[v]) {
        const ch = readChain(t, i + 3, b);
        const ops = [m, ...ch.calls.map((c) => c.name)];
        const crud = opsCrud(ops);
        addBuilderSql(bc, crud.map((c) => ({ name: builders[v], crud: c })), x.p, `$${v}->${ops.join('()->')}()`);
        i = ch.next - 1;
        continue;
      }
      const type = locals[v];
      if (type) {
        bc.method.calls.push({ via: type, method: m, line: bc.lineOf(x.p) });
        const ch = readChain(t, i + 3, b);
        const relations = m === 'load' || m === 'loadMissing' ? relationArgs(t, i + 3) : [];
        bc.st.modelOps.push({
          method: bc.method, model: type, cls: clsName, ops: [m, ...ch.calls.map((c) => c.name)], joins: [], relations,
          created: created.has(v), file: bc.f.id, line: bc.lineOf(x.p), instance: true,
        });
        // $order->items()->create(...) : 관계 생성
        if (ch.calls.length && /^(create|createMany|save|saveMany|insert|update|delete)$/.test(ch.calls[ch.calls.length - 1].name)) {
          bc.st.modelOps.push({
            method: bc.method, model: type, cls: clsName, ops: [ch.calls[ch.calls.length - 1].name], joins: [], relations: [m],
            file: bc.f.id, line: bc.lineOf(x.p), instance: true,
          });
        }
        i = i + 2;
        continue;
      }
      continue;
    }
    // ---------------- Class::m(
    if (x.k === 'id' && t[i + 1]?.v === '::' && t[i + 2]?.k === 'id' && t[i + 3]?.v === '(') {
      const c = simpleName(x.v);
      const m = t[i + 2].v;
      const lc = c.toLowerCase();
      if (lc === 'self' || lc === 'static' || lc === 'parent') {
        if (clsName) bc.method.calls.push({ via: `this.${clsName}`, method: m, line: bc.lineOf(x.p) });
        i += 2;
        continue;
      }
      if (c === 'DB') {
        const args = splitArgs(t, i + 3);
        if (m === 'table' && args[0]) {
          const s = argString(t, args[0]);
          const ch = readChain(t, i + 3, b);
          if (s) {
            const ops = ch.calls.map((q) => q.name);
            const refs: TableRef[] = opsCrud(ops).map((cr) => ({ name: tableArg(s), crud: cr }));
            for (const q of ch.calls) {
              if (/^(join|leftJoin|rightJoin|crossJoin|joinSub)$/.test(q.name)) {
                const js = splitArgs(t, q.open)[0];
                const jt = js ? argString(t, js) : null;
                if (jt) refs.push({ name: tableArg(jt), crud: 'R' });
              }
            }
            addBuilderSql(bc, refs, x.p, `DB::table('${s}')->${ops.join('()->')}()`);
          }
          i = ch.next - 1;
          continue;
        }
        if (/^(select|selectOne|insert|update|delete|statement|unprepared|affectingStatement|scalar|cursor|raw)$/.test(m) && args[0]) {
          const s = argString(t, args[0]);
          if (s) {
            addSqlText(bc, s, t[args[0][0]].p);
            for (let j = args[0][0]; j < args[0][1]; j++) consumed.add(j);
          }
          i = i + 3;
          continue;
        }
        continue;
      }
      if (c === 'View' && m === 'make') {
        const s = argString(t, splitArgs(t, i + 3)[0] ?? [0, 0]);
        if (s) bc.method.views.push(s);
        continue;
      }
      if (FACADES.has(lc)) continue;
      bc.method.calls.push({ via: c, method: m, line: bc.lineOf(x.p) });
      if (/^[A-Z]/.test(c)) {
        const ch = readChain(t, i + 3, b);
        const ops = [m, ...ch.calls.map((q) => q.name)];
        const joins: string[] = [];
        const relations: string[] = [];
        for (const q of [{ name: m, open: i + 3 }, ...ch.calls]) {
          if (/^(join|leftJoin|rightJoin|crossJoin)$/.test(q.name)) {
            const js = splitArgs(t, q.open)[0];
            const jt = js ? argString(t, js) : null;
            if (jt) joins.push(tableArg(jt));
          }
          if (/^(with|load|withCount|has|whereHas|doesntHave|whereDoesntHave)$/.test(q.name)) relations.push(...relationArgs(t, q.open));
        }
        bc.st.modelOps.push({ method: bc.method, model: c, cls: clsName, ops, joins, relations, file: bc.f.id, line: bc.lineOf(x.p) });
      }
      i += 2;
      continue;
    }
    // ---------------- view('a.b') / response()->view()
    if (x.k === 'id' && x.v === 'view' && t[i + 1]?.v === '(' && !LOAD_VIEW_NOT.has(t[i - 1]?.v ?? '') ) {
      const s = argString(t, splitArgs(t, i + 1)[0] ?? [0, 0]);
      if (s) bc.method.views.push(s);
      continue;
    }
    if (x.k === 'id' && x.v === 'view' && t[i + 1]?.v === '(' && t[i - 1]?.v === '->' && t[i - 2]?.v === ')') {
      const s = argString(t, splitArgs(t, i + 1)[0] ?? [0, 0]);
      if (s) bc.method.views.push(s);
      continue;
    }
    // ---------------- include/require
    if (x.k === 'id' && /^(include|include_once|require|require_once)$/i.test(x.v)) {
      let j = i + 1;
      let s = '';
      let dirBase = false;
      const stop = Math.min(b, i + 30);
      for (; j < stop && t[j].v !== ';'; j++) {
        if (t[j].k === 'str') s += t[j].v;
        else if (t[j].k === 'id' && /^__DIR__$/.test(t[j].v)) dirBase = true;
        else if (t[j].k === 'id' && t[j].v === 'dirname' && t[j + 2]?.v === '__FILE__') dirBase = true;
        else if (t[j].k === 'var' || (t[j].k === 'id' && /^[A-Z_]+$/.test(t[j].v) && t[j].v !== '__DIR__')) s += '${v}';
      }
      if (s && !s.includes('${v}')) {
        const base = dirName(bc.f.path);
        const p = normalizePath(s.startsWith('/') && !dirBase ? s.slice(1) : `${base}/${s}`);
        const list = bc.st.includes.get(bc.f.id) ?? [];
        list.push(p);
        bc.st.includes.set(bc.f.id, list);
      }
      i = j;
      continue;
    }
    // ---------------- header('Location: …')
    if (x.k === 'id' && x.v === 'header' && t[i + 1]?.v === '(' && t[i + 2]?.k === 'str' && /^\s*location\s*:/i.test(t[i + 2].v)) {
      const url = t[i + 2].v.replace(/^\s*location\s*:\s*/i, '');
      (bc.method.redirects ??= []).push(url);
      continue;
    }
    // ---------------- 문자열 SQL
    if (x.k === 'str') {
      const { text, next } = readConcat(t, i, b);
      const prev = t[i - 1];
      const prev2 = t[i - 2];
      if (prev?.v === '=' && prev2?.k === 'var') {
        flushVar(prev2.v);
        if (isSqlLike(text)) sqlVars.set(prev2.v, { text, pos: x.p });
      } else if (prev?.v === '.=' && prev2?.k === 'var' && sqlVars.has(prev2.v)) {
        sqlVars.get(prev2.v)!.text += text;
      } else if (isSqlLike(text)) {
        addSqlText(bc, text, x.p);
      }
      // 문자열 안 HTML의 링크(순수 PHP 의 echo "<a href=…>")는 뷰 분석에서
      i = next - 1;
      continue;
    }
  }
  for (const k of [...sqlVars.keys()]) flushVar(k);
}

/** $this->db->m(…)->m2(…) 체인 (CI3/CI4) → SQL 사실. start = 첫 메서드 이름 토큰 */
function ciDbChain(t: PT[], start: number, end: number, bc: BodyCtx): number {
  const calls: { name: string; open: number }[] = [{ name: t[start].v, open: start + 1 }];
  const ch = readChain(t, start + 1, end);
  calls.push(...ch.calls);
  const refs: TableRef[] = [];
  let base: string | null = null;
  let rawSql = false;
  for (const c of calls) {
    const args = splitArgs(t, c.open);
    const s0 = args[0] ? argString(t, args[0]) : null;
    const n = c.name.toLowerCase();
    if (n === 'query' && s0) {
      addSqlText(bc, s0, t[args[0][0]].p);
      rawSql = true;
      continue;
    }
    if (n === 'table' && s0) {
      base = tableArg(s0);
      continue;
    }
    if (n === 'from' && s0) {
      for (const part of s0.split(',')) refs.push({ name: tableArg(part), crud: 'R' });
      continue;
    }
    if (/^(join|leftjoin|rightjoin)$/.test(n) && s0) {
      refs.push({ name: tableArg(s0), crud: 'R' });
      continue;
    }
    const crud = /^(get|get_where|getwhere|count_all|count_all_results|countallresults|countall|getresult|getresultarray|getrow|getrowarray|getfirstrow)$/.test(n)
      ? 'R'
      : /^(insert|insert_batch|insertbatch|set_insert_batch|replace)$/.test(n)
        ? 'C'
        : /^(update|update_batch|updatebatch)$/.test(n)
          ? 'U'
          : /^(delete|empty_table|emptytable|truncate)$/.test(n)
            ? 'D'
            : null;
    if (!crud) continue;
    if (s0) refs.push({ name: tableArg(s0), crud });
    else if (base) refs.push({ name: base, crud });
  }
  if (base && !refs.some((r) => r.name === base)) refs.push({ name: base, crud: 'R' });
  if (refs.length && !rawSql) addBuilderSql(bc, refs, t[start].p, `$this->db->${calls.map((c) => c.name).join('()->')}()`);
  else if (refs.length) addBuilderSql(bc, refs, t[start].p, `$this->db->${calls.map((c) => c.name).join('()->')}()`);
  return ch.next;
}

// ------------------------------------------------------------------ 클래스 구조

interface ParsedClass {
  name: string;
  ext?: string;
  impl: string[];
  open: number;
  close: number;
  line: number;
  kind: 'class' | 'interface' | 'trait' | 'enum';
}

function parseClasses(t: PT[]): ParsedClass[] {
  const out: ParsedClass[] = [];
  for (let i = 0; i < t.length - 1; i++) {
    const x = t[i];
    if (x.k !== 'id' || !/^(class|interface|trait|enum)$/i.test(x.v)) continue;
    if (t[i - 1]?.v === '::' || t[i - 1]?.v === 'new' || t[i - 1]?.v === '->') continue;
    if (t[i + 1]?.k !== 'id') continue;
    const name = t[i + 1].v;
    let j = i + 2;
    let ext: string | undefined;
    const impl: string[] = [];
    while (j < t.length && t[j].v !== '{') {
      if (t[j].v === 'extends' && t[j + 1]?.k === 'id') ext = simpleName(t[j + 1].v);
      if (t[j].v === 'implements') {
        let k = j + 1;
        while (t[k] && t[k].v !== '{') {
          if (t[k].k === 'id') impl.push(simpleName(t[k].v));
          k++;
        }
      }
      j++;
    }
    if (j >= t.length) break;
    const close = matchClose(t, j);
    out.push({ name, ext, impl, open: j, close, line: 0, kind: x.v.toLowerCase() as ParsedClass['kind'] });
    i = close;
  }
  return out;
}

interface ParsedFn {
  name: string;
  at: number; // 'function' 토큰
  paramsOpen: number;
  bodyOpen: number; // -1 이면 본문 없음
  bodyClose: number;
  visibility: string;
  isStatic: boolean;
}

function parseFunctions(t: PT[], a: number, b: number, topOnly: boolean): ParsedFn[] {
  const out: ParsedFn[] = [];
  let depth = 0;
  for (let i = a; i < b; i++) {
    const x = t[i];
    if (x.k === 'op' && (x.v === '{' || x.v === '(' || x.v === '[')) depth++;
    else if (x.k === 'op' && (x.v === '}' || x.v === ')' || x.v === ']')) depth--;
    if (x.k !== 'id' || x.v.toLowerCase() !== 'function') continue;
    if (topOnly && depth !== 0) continue;
    let j = i + 1;
    if (t[j]?.v === '&') j++;
    if (t[j]?.k !== 'id' || t[j + 1]?.v !== '(') continue; // 익명 함수
    const name = t[j].v;
    const paramsOpen = j + 1;
    const paramsClose = matchClose(t, paramsOpen);
    let k = paramsClose + 1;
    while (k < b && t[k].v !== '{' && t[k].v !== ';') k++;
    let vis = 'public';
    let isStatic = false;
    for (let q = i - 1; q >= Math.max(a, i - 4); q--) {
      const v = t[q].v.toLowerCase();
      if (v === 'private' || v === 'protected' || v === 'public') vis = v;
      else if (v === 'static') isStatic = true;
      else if (v !== 'abstract' && v !== 'final') break;
    }
    if (t[k]?.v === '{') {
      const close = matchClose(t, k);
      out.push({ name, at: i, paramsOpen, bodyOpen: k, bodyClose: close, visibility: vis, isStatic });
      i = close;
    } else {
      out.push({ name, at: i, paramsOpen, bodyOpen: -1, bodyClose: k, visibility: vis, isStatic });
      i = k;
    }
  }
  return out;
}

/** 매개변수: 타입이 붙은 변수와 생성자 승격 필드 */
function parseParams(t: PT[], open: number): { types: Record<string, string>; promoted: Record<string, string>; count: number } {
  const types: Record<string, string> = {};
  const promoted: Record<string, string> = {};
  const args = splitArgs(t, open);
  for (const [a, b] of args) {
    let type: string | null = null;
    let prom = false;
    for (let j = a; j < b; j++) {
      const x = t[j];
      if (x.k === 'id' && /^(public|private|protected|readonly)$/i.test(x.v)) prom = true;
      else if (x.k === 'id' && !/^(null|array|string|int|float|bool|mixed|callable|iterable|object|self|static|true|false|void)$/i.test(x.v)) type = simpleName(x.v);
      else if (x.k === 'var') {
        if (type) types[x.v] = type;
        if (prom && type) promoted[x.v] = type;
        break;
      }
    }
  }
  return { types, promoted, count: args.length };
}

/** 클래스 속성: 타입 있는 속성, 문서 주석 없음, $table 값 */
function parseProps(t: PT[], cls: ParsedClass, fns: ParsedFn[]): { fields: Record<string, string>; table?: string } {
  const fields: Record<string, string> = {};
  let table: string | undefined;
  const inFn = (i: number) => fns.some((f) => f.bodyOpen >= 0 && i > f.bodyOpen && i < f.bodyClose);
  for (let i = cls.open + 1; i < cls.close; i++) {
    if (inFn(i)) continue;
    const x = t[i];
    if (x.k !== 'var') continue;
    // 앞쪽: 접근자 [타입]
    const prev = t[i - 1];
    const prev2 = t[i - 2];
    if (prev?.k === 'id' && !/^(public|private|protected|var|static|readonly)$/i.test(prev.v) && /^(public|private|protected|var|static|readonly|\?)$/i.test(prev2?.v ?? '')) {
      fields[x.v] = simpleName(prev.v);
    }
    if ((x.v === 'table') && t[i + 1]?.v === '=' && t[i + 2]?.k === 'str') table = t[i + 2].v;
  }
  return { fields, table };
}

function relationsOf(t: PT[], fn: ParsedFn): string | null {
  if (fn.bodyOpen < 0) return null;
  for (let i = fn.bodyOpen; i < fn.bodyClose - 4; i++) {
    if (t[i].k === 'var' && t[i].v === 'this' && t[i + 1].v === '->' && /^(hasMany|hasOne|belongsTo|belongsToMany|morphMany|morphOne|hasManyThrough|hasOneThrough|morphToMany)$/.test(t[i + 2].v) && t[i + 3].v === '(') {
      const arg = splitArgs(t, i + 3)[0];
      if (!arg) return null;
      return argClass(t, arg) ?? (argString(t, arg) ? simpleName(argString(t, arg)!) : null);
    }
  }
  return null;
}

// ------------------------------------------------------------------ 라우트 파일 (Laravel)

interface LaravelGroup {
  prefix: string;
  name: string;
  ctrl?: string;
  ns?: string;
}

function parseLaravelRoutes(t: PT[], a: number, b: number, g: LaravelGroup, f: FileInfo, ctx: Ctx, st: PhpState, lineOf: (p: number) => number, api: boolean, root: string): void {
  for (let i = a; i < b; i++) {
    const x = t[i];
    const isRoute = x.k === 'id' && simpleName(x.v) === 'Route' && t[i + 1]?.v === '::';
    const isRouter = x.k === 'var' && x.v === 'router' && t[i + 1]?.v === '->';
    if (!isRoute && !isRouter) continue;
    if (t[i + 2]?.k !== 'id' || t[i + 3]?.v !== '(') continue;
    const first = { name: t[i + 2].v, open: i + 3 };
    const ch = readChain(t, i + 3, b);
    const calls = [first, ...ch.calls];
    const groupCall = calls.find((c) => c.name === 'group');
    const sub: LaravelGroup = { ...g };
    let routeName = '';
    for (const c of calls) {
      const args = splitArgs(t, c.open);
      const s0 = args[0] ? argString(t, args[0]) : null;
      if (c.name === 'prefix' && s0) sub.prefix = joinUrl(sub.prefix, s0);
      else if ((c.name === 'name' || c.name === 'as') && s0) routeName = s0;
      else if (c.name === 'controller' && args[0]) sub.ctrl = argClass(t, args[0]) ?? s0 ?? sub.ctrl;
      else if (c.name === 'namespace' && s0) sub.ns = s0;
    }
    if (groupCall) {
      if (routeName) sub.name = g.name + routeName;
      const args = splitArgs(t, groupCall.open);
      // Route::group(['prefix' => …, 'as' => …], function () {…})
      for (const r of args) {
        if (t[r[0]]?.v === '[') {
          const arr = t.slice(r[0], r[1]);
          for (let k = 0; k < arr.length - 2; k++) {
            if (arr[k].k === 'str' && arr[k + 1].v === '=>' && arr[k + 2].k === 'str') {
              if (arr[k].v === 'prefix') sub.prefix = joinUrl(sub.prefix, arr[k + 2].v);
              if (arr[k].v === 'as') sub.name = sub.name + arr[k + 2].v;
              if (arr[k].v === 'namespace') sub.ns = arr[k + 2].v;
            }
          }
        }
        // 클로저 본문
        for (let k = r[0]; k < r[1]; k++) {
          if (t[k].v === 'function' || t[k].v === 'fn') {
            let o = k;
            while (o < r[1] && t[o].v !== '{') o++;
            if (o < r[1]) {
              const close = matchClose(t, o);
              parseLaravelRoutes(t, o + 1, close, sub, f, ctx, st, lineOf, api, root);
            }
            break;
          }
        }
        // Route::group(base_path('routes/x.php')) 같은 외부 파일 포함은 건너뜀
      }
      i = ch.next - 1;
      continue;
    }
    const verb = first.name.toLowerCase();
    const args = splitArgs(t, first.open);
    const line = lineOf(x.p);
    const addRoute = (methods: string[], uri: string, actionRange: [number, number] | undefined, name?: string) => {
      const path = joinUrl(g.prefix, uri);
      const def: RouteDef = { file: f.id, line, methods, path, api, root, fw: 'laravel', ...(name ? { name } : {}) };
      if (actionRange) {
        const [p, q] = actionRange;
        const cls = argClass(t, actionRange);
        const str = argString(t, actionRange);
        if (t[p].v === '[') {
          // [Ctrl::class, 'm']
          const inner = splitArgs(t, p);
          const c = inner[0] ? argClass(t, inner[0]) ?? argString(t, inner[0]) : null;
          const m = inner[1] ? argString(t, inner[1]) : null;
          if (c) def.ctrl = c;
          if (m) def.action = m;
        } else if (cls) {
          def.ctrl = cls;
          def.action = '__invoke';
        } else if (str && str.includes('@')) {
          const [c, m] = str.split('@');
          def.ctrl = g.ns ? `${g.ns}\\${c}` : c;
          def.action = m;
        } else if (str && g.ctrl) {
          def.ctrl = g.ctrl;
          def.action = str;
        } else {
          // 클로저
          for (let k = p; k < q; k++) {
            if (t[k].v === 'function' || t[k].v === 'fn') {
              const m = newMethod(`closure@${line}`, line);
              m.routes.push({ method: methods[0] ?? '*', path, line, ...(api ? { api: true } : {}) });
              let o = k;
              while (o < q && t[o].v !== '{' && t[o].v !== '=>') o++;
              const bc: BodyCtx = { f, ctx, st, lineOf, method: m, fw: 'laravel' };
              if (t[o]?.v === '{') analyzeBody(t, o + 1, matchClose(t, o), bc);
              else analyzeBody(t, o + 1, q, bc);
              routeUnit(ctx, st, f).methods.push(m);
              def.inline = m;
              break;
            }
          }
        }
      }
      st.routes.push(def);
    };
    for (const c of ch.calls) {
      if (c.name === 'name') {
        const s0 = argString(t, splitArgs(t, c.open)[0] ?? [0, 0]);
        if (s0) routeName = s0;
      }
    }
    const fullName = routeName ? g.name + routeName : undefined;
    if (['get', 'post', 'put', 'patch', 'delete', 'options', 'any'].includes(verb)) {
      const uri = args[0] ? argString(t, args[0]) : null;
      if (uri !== null) addRoute([verb === 'any' ? '*' : verb.toUpperCase()], uri, args[1], fullName);
    } else if (verb === 'match') {
      const ms: string[] = [];
      if (args[0]) for (let k = args[0][0]; k < args[0][1]; k++) if (t[k].k === 'str') ms.push(t[k].v.toUpperCase());
      const uri = args[1] ? argString(t, args[1]) : null;
      if (uri !== null) addRoute(ms.length ? ms : ['*'], uri, args[2], fullName);
    } else if (verb === 'view') {
      const uri = args[0] ? argString(t, args[0]) : null;
      const vn = args[1] ? argString(t, args[1]) : null;
      if (uri !== null && vn) {
        const m = newMethod(`view@${line}`, line);
        const path = joinUrl(g.prefix, uri);
        m.routes.push({ method: 'GET', path, line });
        m.views.push(vn);
        routeUnit(ctx, st, f).methods.push(m);
        st.routes.push({ file: f.id, line, methods: ['GET'], path, api, root, fw: 'laravel', inline: m, ...(fullName ? { name: fullName } : {}) });
      }
    } else if (verb === 'resource' || verb === 'apiresource') {
      const res = args[0] ? argString(t, args[0]) : null;
      const ctrl = args[1] ? argClass(t, args[1]) ?? argString(t, args[1]) : null;
      if (res && ctrl) {
        let only: string[] | null = null;
        let except: string[] = [];
        for (const c of ch.calls) {
          const list: string[] = [];
          const r = splitArgs(t, c.open)[0];
          if (r) for (let k = r[0]; k < r[1]; k++) if (t[k].k === 'str') list.push(t[k].v);
          if (c.name === 'only') only = list;
          if (c.name === 'except') except = list;
        }
        const segs = res.split('.');
        let base = '';
        segs.forEach((s, idx) => {
          base = joinUrl(base, s);
          if (idx < segs.length - 1) base = joinUrl(base, `{${singular(s)}}`);
        });
        const last = segs[segs.length - 1];
        const param = `{${singular(last.replace(/-/g, '_'))}}`;
        const actions: [string, string[], string][] = [
          ['index', ['GET'], ''], ['create', ['GET'], '/create'], ['store', ['POST'], ''], ['show', ['GET'], `/${param}`],
          ['edit', ['GET'], `/${param}/edit`], ['update', ['PUT', 'PATCH'], `/${param}`], ['destroy', ['DELETE'], `/${param}`],
        ];
        for (const [act, ms, suffix] of actions) {
          if (verb === 'apiresource' && (act === 'create' || act === 'edit')) continue;
          if (only && !only.includes(act)) continue;
          if (except.includes(act)) continue;
          const path = joinUrl(g.prefix, base, suffix);
          const ctrlName = g.ns && !ctrl.includes('\\') && !argClass(t, args[1]!) ? `${g.ns}\\${ctrl}` : ctrl;
          st.routes.push({ file: f.id, line, methods: ms, path, api, root, fw: 'laravel', ctrl: ctrlName, action: act, name: `${g.name}${res}.${act}` });
        }
      }
    }
    i = ch.next - 1;
  }
}

function routeUnit(ctx: Ctx, st: PhpState, f: FileInfo): CodeUnit {
  let u = st.routeUnits.get(f.id);
  if (!u) {
    u = ctx.addUnit({ file: f.id, name: `routes:${baseName(f.path)}`, kind: 'controller', line: 1, extendsOrImplements: [], fields: {}, methods: [] });
    st.routeUnits.set(f.id, u);
  }
  return u;
}

// ------------------------------------------------------------------ CodeIgniter 라우트

function parseCi3Routes(text: string, f: FileInfo, st: PhpState, root: string, lineOf: (p: number) => number): void {
  const re = /\$route\[\s*(['"])(.*?)\1\s*\](?:\[\s*(['"])(\w+)\3\s*\])?\s*=\s*(['"])(.*?)\5\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = m[2];
    const verb = m[4];
    const to = m[6];
    if (from === 'translate_uri_dashes') continue;
    st.ci3Routes.push({ root, from, to, methods: verb ? [verb.toUpperCase()] : ['*'], file: f.id, line: lineOf(m.index) });
  }
}

function parseCi4Routes(t: PT[], a: number, b: number, prefix: string, ns: string, f: FileInfo, st: PhpState, root: string, lineOf: (p: number) => number): void {
  for (let i = a; i < b; i++) {
    const x = t[i];
    if (x.k !== 'var' || x.v !== 'routes' || t[i + 1]?.v !== '->' || t[i + 2]?.k !== 'id' || t[i + 3]?.v !== '(') continue;
    const verb = t[i + 2].v.toLowerCase();
    const args = splitArgs(t, i + 3);
    const close = matchClose(t, i + 3);
    if (verb === 'setautoroute') {
      if (t[args[0]?.[0] ?? 0]?.v?.toLowerCase() === 'true') st.ci4Auto.add(root);
      i = close;
      continue;
    }
    if (verb === 'group') {
      const p = args[0] ? argString(t, args[0]) ?? '' : '';
      let subNs = ns;
      for (const r of args.slice(1)) {
        if (t[r[0]]?.v === '[') {
          for (let k = r[0]; k < r[1] - 2; k++) if (t[k].k === 'str' && t[k].v === 'namespace' && t[k + 1].v === '=>' && t[k + 2].k === 'str') subNs = t[k + 2].v;
        }
        for (let k = r[0]; k < r[1]; k++) {
          if (t[k].v === 'function' || t[k].v === 'fn') {
            let o = k;
            while (o < r[1] && t[o].v !== '{') o++;
            if (o < r[1]) parseCi4Routes(t, o + 1, matchClose(t, o), joinUrl(prefix, p), subNs, f, st, root, lineOf);
            break;
          }
        }
      }
      i = close;
      continue;
    }
    const map: Record<string, string[]> = { get: ['GET'], post: ['POST'], put: ['PUT'], patch: ['PATCH'], delete: ['DELETE'], add: ['*'], options: ['OPTIONS'], cli: [] };
    if (map[verb] && map[verb].length) {
      const uri = args[0] ? argString(t, args[0]) : null;
      const handler = args[1] ? argString(t, args[1]) : null;
      if (uri !== null && handler) {
        const [ctrl, rest] = handler.replace(/^\\/, '').split('::');
        const action = (rest ?? 'index').split('/')[0];
        const path = joinUrl(prefix, uri.replace(/\(:\w+\)/g, '{p}'));
        const c = ctrl.includes('\\') ? ctrl : `${ns}\\${ctrl}`;
        st.routes.push({ file: f.id, line: lineOf(x.p), methods: map[verb], path, api: false, root, fw: 'ci4', ctrl: c, action });
      }
    } else if (verb === 'match') {
      const ms: string[] = [];
      if (args[0]) for (let k = args[0][0]; k < args[0][1]; k++) if (t[k].k === 'str') ms.push(t[k].v.toUpperCase());
      const uri = args[1] ? argString(t, args[1]) : null;
      const handler = args[2] ? argString(t, args[2]) : null;
      if (uri !== null && handler) {
        const [ctrl, rest] = handler.replace(/^\\/, '').split('::');
        const c = ctrl.includes('\\') ? ctrl : `${ns}\\${ctrl}`;
        st.routes.push({ file: f.id, line: lineOf(x.p), methods: ms, path: joinUrl(prefix, uri), api: false, root, fw: 'ci4', ctrl: c, action: (rest ?? 'index').split('/')[0] });
      }
    } else if (verb === 'resource' || verb === 'presenter') {
      const res = args[0] ? argString(t, args[0]) : null;
      if (res) {
        let ctrl = res.charAt(0).toUpperCase() + res.slice(1);
        if (args[1]) for (let k = args[1][0]; k < args[1][1] - 2; k++) if (t[k].k === 'str' && t[k].v === 'controller' && t[k + 2]?.k === 'str') ctrl = t[k + 2].v;
        const base = joinUrl(prefix, res);
        const acts: [string, string[], string][] = verb === 'resource'
          ? [['index', ['GET'], ''], ['new', ['GET'], '/new'], ['create', ['POST'], ''], ['show', ['GET'], '/{p}'], ['edit', ['GET'], '/{p}/edit'], ['update', ['PUT', 'PATCH'], '/{p}'], ['delete', ['DELETE'], '/{p}']]
          : [['index', ['GET'], ''], ['show', ['GET'], '/show/{p}'], ['new', ['GET'], '/new'], ['create', ['POST'], '/create'], ['edit', ['GET'], '/edit/{p}'], ['update', ['POST'], '/update/{p}'], ['remove', ['GET'], '/remove/{p}'], ['delete', ['POST'], '/delete/{p}']];
        for (const [act, ms, suffix] of acts) st.routes.push({ file: f.id, line: lineOf(x.p), methods: ms, path: `${base}${suffix}`, api: verb === 'resource', root, fw: 'ci4', ctrl: ctrl.includes('\\') ? ctrl : `${ns}\\${ctrl}`, action: act });
      }
    }
    i = close;
  }
}

// ------------------------------------------------------------------ 마이그레이션 → DDL

const BLUEPRINT_TYPES: Record<string, string> = {
  id: 'BIGINT', bigincrements: 'BIGINT', increments: 'INT', string: 'VARCHAR', char: 'CHAR', text: 'TEXT', mediumtext: 'MEDIUMTEXT', longtext: 'LONGTEXT',
  integer: 'INT', biginteger: 'BIGINT', tinyinteger: 'TINYINT', smallinteger: 'SMALLINT', unsignedbiginteger: 'BIGINT UNSIGNED', unsignedinteger: 'INT UNSIGNED',
  decimal: 'DECIMAL', float: 'FLOAT', double: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', datetime: 'DATETIME', timestamp: 'TIMESTAMP', time: 'TIME',
  json: 'JSON', jsonb: 'JSON', enum: 'ENUM', foreignid: 'BIGINT UNSIGNED', uuid: 'CHAR(36)', ulid: 'CHAR(26)', binary: 'BLOB', year: 'YEAR', ipaddress: 'VARCHAR(45)',
  foreignidfor: 'BIGINT UNSIGNED', morphs: 'BIGINT', unsignedtinyinteger: 'TINYINT UNSIGNED', unsignedsmallinteger: 'SMALLINT UNSIGNED', mediuminteger: 'MEDIUMINT',
};

function parseMigration(t: PT[], f: FileInfo, ctx: Ctx, lineOf: (p: number) => number): void {
  for (let i = 0; i < t.length - 4; i++) {
    if (!(t[i].k === 'id' && simpleName(t[i].v) === 'Schema' && t[i + 1].v === '::' && t[i + 2].v === 'create' && t[i + 3].v === '(')) continue;
    const args = splitArgs(t, i + 3);
    const name = args[0] ? argString(t, args[0]) : null;
    if (!name || !args[1]) continue;
    let o = args[1][0];
    while (o < args[1][1] && t[o].v !== '{') o++;
    if (o >= args[1][1]) continue;
    const close = matchClose(t, o);
    const columns: DdlColumn[] = [];
    let comment: string | undefined;
    for (let k = o + 1; k < close; k++) {
      if (!(t[k].k === 'var' && t[k + 1]?.v === '->' && t[k + 2]?.k === 'id' && t[k + 3]?.v === '(')) continue;
      const fn = t[k + 2].v;
      const fargs = splitArgs(t, k + 3);
      const col = fargs[0] ? argString(t, fargs[0]) : null;
      const ch = readChain(t, k + 3, close);
      const mods = ch.calls.map((c) => c.name);
      const lf = fn.toLowerCase();
      if (lf === 'comment' && col) comment = col;
      else if (lf === 'timestamps' || lf === 'timestampstz' || lf === 'nullabletimestamps') {
        columns.push({ name: 'created_at', type: 'TIMESTAMP', nullable: true }, { name: 'updated_at', type: 'TIMESTAMP', nullable: true });
      } else if (lf === 'softdeletes') columns.push({ name: 'deleted_at', type: 'TIMESTAMP', nullable: true });
      else if (lf === 'remembertoken') columns.push({ name: 'remember_token', type: 'VARCHAR(100)', nullable: true });
      else if (lf === 'id' && !col) columns.push({ name: 'id', type: 'BIGINT UNSIGNED', pk: true, nullable: false });
      else if (BLUEPRINT_TYPES[lf] && col) {
        let type = BLUEPRINT_TYPES[lf];
        const len = fargs[1] && t[fargs[1][0]]?.k === 'num' ? t[fargs[1][0]].v : null;
        if (type === 'VARCHAR') type = `VARCHAR(${len ?? 255})`;
        if (type === 'DECIMAL' && len) type = `DECIMAL(${len}${fargs[2] && t[fargs[2][0]]?.k === 'num' ? `,${t[fargs[2][0]].v}` : ''})`;
        const c: DdlColumn = { name: col, type, nullable: mods.includes('nullable') };
        if (lf === 'bigincrements' || lf === 'increments' || mods.includes('primary')) {
          c.pk = true;
          c.nullable = false;
        }
        const cm = ch.calls.find((q) => q.name === 'comment');
        if (cm) {
          const s = argString(t, splitArgs(t, cm.open)[0] ?? [0, 0]);
          if (s) c.comment = s;
        }
        columns.push(c);
      }
      k = ch.next - 1;
    }
    ctx.facts.ddl.push({ name, columns, ...(comment ? { comment } : {}), evidence: { file: f.id, line: lineOf(t[i].p) } });
    f.layer = 'DDL';
    i = close;
  }
}

// ------------------------------------------------------------------ 화면(뷰) 분석

/** PHP 블록·Blade 표현식을 같은 길이의 공백으로 바꾸고 URL 함수 호출은 경로로 바꿈 */
function flattenView(text: string, refs: { url: string; name?: string; action?: string; offset: number; len: number }[]): string {
  let s = text;
  const put = (start: number, len: number, value: string) => {
    const v = value.length <= len ? value + ' '.repeat(len - value.length) : value.slice(0, len);
    s = s.slice(0, start) + v + s.slice(start + len);
  };
  // 1) 경로를 만드는 함수: route('n'), url('/x'), site_url('x'), base_url('x'), action('C@m'), asset('x')
  const fnRe = /(\{\{\s*|<\?(?:php\s+echo\s+|=\s*))?\b(route|url|site_url|base_url|action|asset|secure_url|url_to|anchor|form_open)\s*\(\s*(['"])([^'"]*)\3([^)]*)\)\s*(?:;?\s*\?>|\s*\}\})?/g;
  let m: RegExpExecArray | null;
  const matches: RegExpExecArray[] = [];
  while ((m = fnRe.exec(text))) matches.push(m);
  for (const mm of matches) {
    const fn = mm[2];
    const arg = mm[4];
    const rest = mm[5] ?? '';
    const start = mm.index;
    const len = mm[0].length;
    if (fn === 'route') {
      const idx = refs.length;
      refs.push({ url: '', name: arg, offset: start, len });
      put(start, len, `/__r/${idx}`);
    } else if (fn === 'action') {
      const idx = refs.length;
      refs.push({ url: '', action: arg, offset: start, len });
      put(start, len, `/__r/${idx}`);
    } else if (fn === 'asset') {
      put(start, len, `/${arg.replace(/^\//, '')}`);
    } else if (fn === 'anchor' || fn === 'form_open') {
      // CI 헬퍼는 태그를 만든다: <a href> / <form action>
      const tail = /^\s*\.\s*\$/.test(rest) || /^\s*\./.test(rest) ? '/{x}' : '';
      const url = `/${arg.replace(/^\//, '')}${tail}`;
      const tag = fn === 'anchor' ? `<a href="${url}">` : `<form action="${url}" method="post">`;
      put(start, len, tag);
    } else {
      const tail = /^\s*\.\s*/.test(rest) ? '/{x}' : '';
      put(start, len, `/${arg.replace(/^\//, '')}${tail}`.replace(/\/\/+/g, '/'));
    }
  }
  // 2) 남은 표현식 → {x} (줄바꿈은 유지)
  s = s.replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}|<\?(?:php|=)?[\s\S]*?(?:\?>|$)/g, (x) => {
    const filler = x.replace(/[^\n]/g, ' ');
    return x.length >= 3 && !/\n/.test(x.slice(0, 3)) ? `{x}${filler.slice(3)}` : filler;
  });
  return s;
}

function viewIncludes(text: string, fw: Framework, root: string, f: FileInfo): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  if (fw === 'laravel') {
    const re = /@(include|includeIf|includeWhen|includeFirst|extends|component|each)\s*\(\s*(?:[^,'"]*,\s*)?['"]([\w.\-/:]+)['"]/g;
    while ((m = re.exec(text))) out.push(`${root ? `${root}/` : ''}resources/views/${m[2].replace(/\./g, '/')}.blade.php`);
    const comp = /<x-([\w.\-]+)/g;
    while ((m = comp.exec(text))) out.push(`${root ? `${root}/` : ''}resources/views/components/${m[1].replace(/\./g, '/')}.blade.php`);
  } else if (fw === 'ci3' || fw === 'ci4') {
    const base = fw === 'ci3' ? 'application/views' : 'app/Views';
    const re = /\$this->(?:load->view|include|extend)\(\s*['"]([\w./\-]+)['"]/g;
    while ((m = re.exec(text))) out.push(`${root ? `${root}/` : ''}${base}/${m[1].replace(/\.php$/, '')}.php`);
  }
  // include 'x.php' (순수 PHP 및 뷰 안 include)
  const inc = /\b(?:include|include_once|require|require_once)\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.(?:php|inc|html?))['"]/g;
  while ((m = inc.exec(text))) {
    const p = m[1];
    out.push(normalizePath(p.startsWith('/') ? p.slice(1) : `${dirName(f.path)}/${p}`));
  }
  return out;
}

function urlBaseDir(st: PhpState, path: string): { url: string; root: string } {
  // 가장 얕은 index.php 폴더를 웹 루트로
  const segs = path.split('/');
  let root = segs[0] ?? '';
  for (let k = 1; k < segs.length; k++) {
    const d = segs.slice(0, k).join('/');
    if (st.indexDirs.has(d)) {
      root = d;
      break;
    }
  }
  const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return { url: `/${rel}`, root };
}

function makeView(f: FileInfo, text: string, fw: Framework, root: string, ctx: Ctx, st: PhpState, kind: ViewFact['kind'], baseDir: string, directUrl?: string): ViewFact {
  const lineOf = makeLineIndex(text);
  const pend: { url: string; name?: string; action?: string; offset: number; len: number }[] = [];
  const flat = flattenView(text, pend);
  const view: ViewFact = { file: f.id, kind, urls: [], includes: viewIncludes(text, fw, root, f), scripts: [] };
  const title = extractTitle(text) ?? extractTitle(flat);
  if (title) {
    view.title = title.title;
    view.titleLine = lineOf(title.offset);
  }
  for (const r of extractRefs(flat)) {
    const idx = /^\/__r\/(\d+)/.exec(r.url);
    if (idx) {
      const p = pend[Number(idx[1])];
      const u: UrlRef = { url: '', kind: r.kind, file: f.id, line: lineOf(r.offset), ...(r.method ? { method: r.method } : {}) };
      view.urls.push(u);
      st.pendingRefs.push({ view, url: u, ...(p?.name ? { name: p.name } : {}), ...(p?.action ? { action: { ctrl: p.action.split('@')[0], method: p.action.split('@')[1] ?? '__invoke' } } : {}) });
      continue;
    }
    const n = normalizeRef(r.url, baseDir);
    if (!n) continue;
    view.urls.push({ url: n, kind: r.kind, file: f.id, line: lineOf(r.offset), ...(r.method ? { method: r.method } : {}) });
  }
  for (const s of extractScripts(flat)) {
    if (/^(https?:)?\/\//.test(s) || /\{x\}/.test(s)) continue;
    const p = s.startsWith('/') ? s.slice(1) : normalizePath(`${dirName(f.path)}/${s}`);
    view.scripts.push(p);
  }
  if (directUrl) view.directUrl = directUrl;
  if (!f.name.endsWith('.blade.php')) ctx.hit('화면', fw === 'plain' ? 'PHP 페이지' : 'PHP 템플릿', f.id, 1, 0.5);
  const p = f.path.toLowerCase();
  if (/\/(layouts?|partials?|includes?|inc|components|templates?|elements|common|shared)\//.test(p) || /\/_[^/]+$/.test(p) || /^(header|footer|sidebar|nav|navbar|menu|head|top|bottom|layout|base|master)(\.blade)?\.php$/.test(f.name.toLowerCase())) {
    view.fragment = true;
  }
  ctx.facts.views.push(view);
  return view;
}

// ------------------------------------------------------------------ 파일 분석

function analyzeClassFile(f: FileInfo, t: PT[], ctx: Ctx, st: PhpState, fw: Framework, root: string, rel: string, lineOf: (p: number) => number): boolean {
  const classes = parseClasses(t);
  if (!classes.length) return false;
  let ns = '';
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i].k === 'id' && t[i].v === 'namespace' && t[i + 1].k === 'id') {
      ns = t[i + 1].v;
      break;
    }
  }
  for (const c of classes) {
    if (c.kind === 'interface' || c.kind === 'enum') {
      ctx.addUnit({ file: f.id, name: c.name, fqn: ns ? `${ns}\\${c.name}` : c.name, kind: 'other', line: lineOf(t[c.open].p), extendsOrImplements: c.impl, fields: {}, methods: [] });
      continue;
    }
    const fns = parseFunctions(t, c.open + 1, c.close, true);
    const props = parseProps(t, c, fns);
    const lp = rel.toLowerCase();
    let kind: CodeUnit['kind'] = 'other';
    const n = c.name;
    if (/controller/i.test(n) || /(^|\/)(http\/controllers|controllers)\//.test(lp)) kind = 'controller';
    else if (fw === 'ci3' && /^application\/models\//.test(lp)) kind = 'dao';
    else if (/(^|\/)models?\//.test(lp) || /^(Model|Authenticatable|Pivot|User)$/.test(c.ext ?? '')) kind = 'model';
    else if (/service$/i.test(n) || /(^|\/)services?\//.test(lp)) kind = 'service';
    else if (/(repository|repo)$/i.test(n) || /(^|\/)repositor(y|ies)\//.test(lp)) kind = 'repository';
    else if (/(dao|mapper)$/i.test(n)) kind = 'dao';
    const fields = { ...props.fields };
    const unit = ctx.addUnit({
      file: f.id, name: c.name, fqn: ns ? `${ns}\\${c.name}` : c.name, kind, line: lineOf(t[c.open].p),
      extendsOrImplements: [c.ext, ...c.impl].filter(Boolean) as string[], fields, methods: [],
    });
    const info: ClassInfo = { unit, ext: c.ext, fw, root, relations: new Map(), visibility: new Map(), params: new Map(), ...(props.table ? { tableLiteral: props.table } : {}) };
    if (fw === 'ci3' && /^application\/controllers\//.test(rel)) info.ci3Seg = rel.replace(/^application\/controllers\//, '').replace(/\.php$/, '').toLowerCase();
    if (fw === 'ci4' && /^app\/controllers\//i.test(rel)) info.ci4 = true;
    const key = c.name.toLowerCase();
    st.classes.set(key, [...(st.classes.get(key) ?? []), info]);
    // CI3: 클래스 어디서든 load->model 로 붙인 별칭을 먼저 모은다
    for (let i = c.open; i < c.close - 8; i++) {
      if (t[i].k === 'var' && t[i].v === 'this' && t[i + 2]?.v === 'load' && t[i + 4]?.v === 'model' && t[i + 5]?.v === '(') {
        const args = splitArgs(t, i + 5);
        const s0 = args[0] ? argString(t, args[0]) : null;
        if (!s0) continue;
        const alias = (args[1] ? argString(t, args[1]) : null) ?? baseName(s0);
        const cn = baseName(s0);
        fields[alias] = cn.charAt(0).toUpperCase() + cn.slice(1);
      }
    }
    for (const fn of fns) {
      const m = newMethod(fn.name, lineOf(t[fn.at].p));
      const pp = parseParams(t, fn.paramsOpen);
      Object.assign(fields, pp.promoted);
      info.visibility.set(m, fn.visibility);
      info.params.set(m, pp.count);
      if (fn.bodyOpen >= 0) {
        m.endLine = lineOf(t[fn.bodyClose].p);
        // 생성자: $this->x = $param / new X() / model(X::class)
        if (fn.name === '__construct') {
          for (let i = fn.bodyOpen; i < fn.bodyClose - 4; i++) {
            if (!(t[i].k === 'var' && t[i].v === 'this' && t[i + 1].v === '->' && t[i + 2].k === 'id' && t[i + 3].v === '=')) continue;
            const y = t[i + 4];
            if (y.k === 'var' && pp.types[y.v]) fields[t[i + 2].v] = pp.types[y.v];
            else if (y.v === 'new' && t[i + 5]?.k === 'id') fields[t[i + 2].v] = simpleName(t[i + 5].v);
            else if ((y.v === 'model' || y.v === 'app') && t[i + 5]?.v === '(') {
              const r = splitArgs(t, i + 5)[0];
              const cn = r ? argClass(t, r) ?? argString(t, r) : null;
              if (cn) fields[t[i + 2].v] = simpleName(cn);
            }
          }
        }
        // Laravel 암묵적 모델 바인딩: show(Order $order) → orders 조회
        if (fw === 'laravel' && kind === 'controller') {
          for (const ty of Object.values(pp.types)) {
            if (/^[A-Z]/.test(ty) && !/Request$|^Response$/.test(ty)) {
              st.modelOps.push({ method: m, model: ty, cls: c.name, ops: ['find'], joins: [], relations: [], file: f.id, line: m.line });
            }
          }
        }
        const bc: BodyCtx = { f, ctx, st, lineOf, method: m, cls: { name: c.name, fields }, fw };
        analyzeBody(t, fn.bodyOpen + 1, fn.bodyClose, bc, pp.types);
        const rel2 = relationsOf(t, fn);
        if (rel2) info.relations.set(fn.name, rel2);
      }
      unit.methods.push(m);
      if (m.views.length) st.viewLoads.push({ method: m, views: m.views });
    }
  }
  return true;
}

function analyzePlain(f: FileInfo, text: string, t: PT[], ctx: Ctx, st: PhpState, lineOf: (p: number) => number): void {
  // 함수 정의 → 유닛, 나머지(최상위 코드) → 페이지
  const classes = parseClasses(t);
  if (classes.length) analyzeClassFile(f, t, ctx, st, 'plain', '', f.path, lineOf);
  const inClass = (i: number) => classes.some((c) => i >= c.open && i <= c.close);
  const fns = parseFunctions(t, 0, t.length, true).filter((fn) => !inClass(fn.at));
  const hasHtml = t.some((x) => x.k === 'html' && /<\s*(html|body|div|table|form|a|p|ul|h\d|span|input|button|script|section|header|main)\b/i.test(x.v))
    || t.some((x) => x.k === 'str' && /<\s*(div|table|form|a|tr|td|li|p|h\d)\b/i.test(x.v));
  const outputsJson = /\bjson_encode\s*\(|application\/json/.test(text);
  const fnUnitName = baseName(f.path).replace(/\.\w+$/, '');
  if (fns.length) {
    const unit = ctx.addUnit({ file: f.id, name: fnUnitName, kind: 'other', line: 1, extendsOrImplements: [], fields: {}, methods: [] });
    for (const fn of fns) {
      if (fn.bodyOpen < 0) continue;
      const m = newMethod(fn.name, lineOf(t[fn.at].p));
      m.endLine = lineOf(t[fn.bodyClose].p);
      const pp = parseParams(t, fn.paramsOpen);
      analyzeBody(t, fn.bodyOpen + 1, fn.bodyClose, { f, ctx, st, lineOf, method: m, fw: 'plain' }, pp.types);
      collectFreeCalls(t, fn.bodyOpen + 1, fn.bodyClose, m, lineOf);
      unit.methods.push(m);
    }
    if (unit.methods.some((m) => m.sql.length)) unit.kind = 'dao';
  }
  // 최상위 코드 범위: 함수·클래스 밖
  const page = newMethod('page', 1);
  const skip = (i: number) => inClass(i) || fns.some((fn) => i >= fn.at && i <= fn.bodyClose);
  let topCode = false;
  // 최상위 코드를 연속 구간으로 나눠 분석
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && end > start) analyzeBody(t, start, end, { f, ctx, st, lineOf, method: page, fw: 'plain' });
    if (start >= 0 && end > start) collectFreeCalls(t, start, end, page, lineOf);
    start = -1;
  };
  for (let i = 0; i < t.length; i++) {
    if (skip(i) || t[i].k === 'html') {
      flush(i);
      continue;
    }
    if (t[i].k !== 'op' || t[i].v !== ';') topCode = true;
    if (start < 0) start = i;
  }
  flush(t.length);
  const libOnly = !hasHtml && (classes.length > 0 || fns.length > 0) && !page.sql.length && !/\$_(GET|POST|REQUEST)\b/.test(text);
  if (libOnly || (!topCode && !hasHtml)) return;
  const { url, root } = urlBaseDir(st, f.path);
  void root;
  const unit = ctx.addUnit({ file: f.id, name: `page:${f.path}`, kind: 'controller', line: 1, extendsOrImplements: [], fields: {}, methods: [page] });
  page.routes.push({ method: '*', path: url, line: 1, ...(hasHtml ? {} : { api: true }) });
  let view: ViewFact | undefined;
  if (hasHtml) {
    page.views.push(f.path);
    const baseDir = url.slice(0, url.lastIndexOf('/')) || '/';
    view = makeView(f, text, 'plain', '', ctx, st, 'php', baseDir, url);
    // echo "<a href='…'>" 처럼 PHP 문자열 안 HTML
    for (const x of t) {
      if (x.k !== 'str' || !/(href|action|location|\$\.ajax|\$\.(get|post)|fetch\(|window\.open)/i.test(x.v)) continue;
      for (const r of extractRefs(x.v.replace(/\$\{v\}/g, '{x}'))) {
        const n = normalizeRef(r.url, baseDir);
        if (n) view.urls.push({ url: n, kind: r.kind, file: f.id, line: lineOf(x.p), ...(r.method ? { method: r.method } : {}) });
      }
    }
  } else if (!outputsJson && !page.redirects?.length && !page.sql.length) {
    // 출력도 SQL도 없는 설정·연결 파일은 페이지가 아님
    unit.methods = [];
  }
  st.pageUnits.set(f.id, { unit, method: page, ...(view ? { view } : {}) });
  f.layer = hasHtml ? 'VIEW' : 'CONTROLLER';
}

/** 함수 호출(자유 함수): foo( → via '' (링크에서 이름으로 찾음) */
function collectFreeCalls(t: PT[], a: number, b: number, m: MethodUnit, lineOf: (p: number) => number): void {
  const BUILTIN = /^(echo|print|isset|empty|unset|array|list|count|strlen|substr|str_\w+|preg_\w+|in_array|array_\w+|json_\w+|htmlspecialchars|date|time|mktime|strtotime|intval|floatval|trim|explode|implode|sprintf|printf|number_format|header|exit|die|session_\w+|mysqli_\w+|mysql_\w+|oci_\w+|pg_\w+|sqlsrv_\w+|is_\w+|define|defined|require\w*|include\w*|function|fn|return|if|elseif|else|foreach|for|while|switch|case|new|isset|addslashes|stripslashes|urlencode|urldecode|nl2br|strip_tags|ucfirst|lcfirst|strtolower|strtoupper|round|floor|ceil|max|min|abs|rand|mt_rand|md5|sha1|base64_\w+|file_\w+|fopen|fclose|fwrite|fread|mkdir|move_uploaded_file|setcookie|ob_\w+|var_dump|print_r|error_log|class_exists|method_exists|function_exists|call_user_func\w*|compact|extract|range|uniqid|password_\w+|filter_\w+|iconv|mb_\w+|ctype_\w+|checkdate|date_\w+)$/i;
  for (let i = a; i < b - 1; i++) {
    const x = t[i];
    if (x.k !== 'id' || t[i + 1].v !== '(') continue;
    const prev = t[i - 1]?.v;
    if (prev === '->' || prev === '::' || prev === 'function' || prev === 'new' || prev === '?->') continue;
    if (BUILTIN.test(x.v)) continue;
    m.calls.push({ via: '', method: x.v, line: lineOf(x.p) });
  }
}

export const phpAnalyzer: Analyzer = {
  name: 'php',
  order: 25,
  accepts: (f) => f.lang === 'PHP',
  analyze(f, text, ctx) {
    const st = state(ctx);
    const { fw, root, rel } = classify(st, f.path);
    // 프레임워크 코어·부트스트랩·테스트는 건너뜀
    if (fw === 'ci3' && /^system\//.test(rel)) return;
    if (fw === 'ci4' && /^(system|writable|tests)\//.test(rel)) return;
    if (fw === 'laravel' && (/^(bootstrap|config|storage|tests|lang|resources\/lang)\//.test(rel) || /^public\/index\.php$/.test(rel) || rel === 'server.php')) return;
    if (fw === 'ci4' && /^public\/index\.php$/.test(rel)) return;
    const lineOf = makeLineIndex(text);
    const isBlade = f.name.endsWith('.blade.php');
    // 화면: Laravel·CI 뷰
    if (fw === 'laravel' && /^resources\/views\//.test(rel)) {
      const name = rel.replace(/^resources\/views\//, '').replace(/\.blade\.php$|\.php$/, '').replace(/\//g, '.');
      const view = makeView(f, text, 'laravel', root, ctx, st, 'php', '/');
      st.viewFacts.set(f.id, { view, fw, root, name });
      f.layer = 'VIEW';
      return;
    }
    if ((fw === 'ci3' && /^application\/views\//.test(rel)) || (fw === 'ci4' && /^app\/views\//i.test(rel))) {
      const name = rel.replace(/^(application\/views|app\/Views)\//i, '').replace(/\.php$/, '');
      const view = makeView(f, text, fw, root, ctx, st, 'php', '/');
      st.viewFacts.set(f.id, { view, fw, root, name });
      f.layer = 'VIEW';
      return;
    }
    if (isBlade) {
      const view = makeView(f, text, 'laravel', root, ctx, st, 'php', '/');
      st.viewFacts.set(f.id, { view, fw: 'laravel', root, name: rel });
      f.layer = 'VIEW';
      return;
    }
    const t = lexPhp(text);
    // 라우트 파일
    if (fw === 'laravel' && /^routes\/[\w\-/]+\.php$/.test(rel)) {
      const api = /^routes\/api\.php$/.test(rel);
      parseLaravelRoutes(t, 0, t.length, { prefix: api ? '/api' : '', name: '' }, f, ctx, st, lineOf, api, root);
      f.layer = 'ROUTE';
      return;
    }
    if (fw === 'ci3' && /^application\/config\/routes\.php$/.test(rel)) {
      parseCi3Routes(text, f, st, root, lineOf);
      f.layer = 'ROUTE';
      return;
    }
    if (fw === 'ci4' && /^app\/config\/routes\.php$/i.test(rel)) {
      parseCi4Routes(t, 0, t.length, '', 'App\\Controllers', f, st, root, lineOf);
      f.layer = 'ROUTE';
      return;
    }
    if (fw === 'ci3' && /^application\/config\//.test(rel)) return;
    if (fw === 'ci4' && /^app\/config\//i.test(rel)) return;
    if (fw === 'laravel' && /^database\/migrations\//.test(rel)) {
      parseMigration(t, f, ctx, lineOf);
      return;
    }
    if (fw === 'laravel' && /^database\//.test(rel)) return;
    if (fw !== 'plain') {
      analyzeClassFile(f, t, ctx, st, fw, root, rel, lineOf);
      return;
    }
    analyzePlain(f, text, t, ctx, st, lineOf);
  },
  finish(ctx) {
    const st = states.get(ctx);
    if (!st) return;
    finishPhp(ctx, st);
  },
};

// ------------------------------------------------------------------ 마무리: 라우트 연결·모델 연산·뷰 조각

function findClass(st: PhpState, name: string): ClassInfo | undefined {
  const s = simpleName(name).toLowerCase();
  const list = st.classes.get(s) ?? [];
  if (list.length <= 1) return list[0];
  const fq = name.replace(/^\\/, '').toLowerCase();
  return list.find((c) => (c.unit.fqn ?? '').toLowerCase() === fq) ?? list[0];
}

function isModel(st: PhpState, info: ClassInfo, depth = 0): boolean {
  if (info.unit.kind === 'model') return true;
  if (!info.ext || depth > 5) return false;
  if (/^(Model|Authenticatable|Pivot)$/.test(info.ext)) return true;
  const parent = findClass(st, info.ext);
  return parent ? isModel(st, parent, depth + 1) : false;
}

function modelTable(st: PhpState, info: ClassInfo): string {
  if (info.tableLiteral) return info.tableLiteral;
  return info.fw === 'ci4' ? snake(info.unit.name) : eloquentTable(info.unit.name);
}

function finishPhp(ctx: Ctx, st: PhpState): void {
  // 모델 유닛: kind·table 확정
  for (const list of st.classes.values()) {
    for (const info of list) {
      if (info.fw === 'ci3') continue;
      if (isModel(st, info) && info.unit.kind !== 'controller') {
        info.unit.kind = 'model';
        info.unit.table = modelTable(st, info);
        const f = ctx.byId.get(info.unit.file);
        if (f) f.layer = 'MODEL';
      }
    }
  }
  // 라우트 → 컨트롤러 메서드
  const named = new Map<string, RouteDef>();
  const byAction = new Map<string, RouteDef>();
  const attach = (def: RouteDef) => {
    if (def.inline) return;
    if (!def.ctrl || !def.action) return;
    const info = findClass(st, def.ctrl);
    if (!info) return;
    let m = info.unit.methods.find((x) => x.name === def.action) ?? info.unit.methods.find((x) => x.name.toLowerCase() === def.action!.toLowerCase());
    if (!m) {
      m = newMethod(def.action, info.unit.line);
      info.unit.methods.push(m);
    }
    for (const meth of def.methods.length ? def.methods : ['*']) {
      if (!m.routes.some((r) => r.path === def.path && r.method === meth)) m.routes.push({ method: meth, path: def.path, line: m.line, ...(def.api ? { api: true } : {}) });
    }
    byAction.set(`${simpleName(def.ctrl).toLowerCase()}@${def.action.toLowerCase()}`, def);
  };
  for (const def of st.routes) {
    attach(def);
    if (def.name) named.set(def.name, def);
  }
  // 라우트 파일에서 만든 메서드(클로저·Route::view)에도 api 표시
  // CI3 기본 라우트: /{controller}/{method}
  for (const list of st.classes.values()) {
    for (const info of list) {
      if (info.ci3Seg !== undefined || (info.ci4 && st.ci4Auto.has(info.root))) {
        const seg = info.ci3Seg ?? info.unit.name.toLowerCase();
        for (const m of info.unit.methods) {
          const vis = info.visibility.get(m) ?? 'public';
          if (vis !== 'public' || m.name.startsWith('_')) continue;
          const name = m.name.toLowerCase();
          const add = (p: string) => {
            if (!m.routes.some((r) => r.path === p)) m.routes.push({ method: '*', path: p, line: m.line });
          };
          if (name === 'index') add(`/${seg}`);
          add(`/${seg}/${name}`);
          if ((info.params.get(m) ?? 0) > 0) add(`/${seg}/${name}/{p}`);
        }
      }
    }
  }
  for (const r of st.ci3Routes) {
    if (r.from === 'default_controller') {
      const info = findClass(st, r.to.split('/').pop() ?? r.to);
      const m = info?.unit.methods.find((x) => x.name === 'index');
      if (m && !m.routes.some((x) => x.path === '/')) m.routes.push({ method: '*', path: '/', line: m.line });
      continue;
    }
    if (r.from === '404_override') continue;
    const segs = r.to.split('/').filter(Boolean);
    // 컨트롤러는 하위 폴더일 수 있음: 가장 긴 일치
    let found: { info: ClassInfo; method: string } | null = null;
    for (let k = segs.length - 1; k >= 1 && !found; k--) {
      const seg = segs.slice(0, k).join('/').toLowerCase();
      for (const list of st.classes.values()) {
        for (const info of list) if (info.ci3Seg === seg) found = { info, method: segs[k] && !segs[k].startsWith('$') ? segs[k] : 'index' };
      }
    }
    if (!found && segs.length === 1) {
      for (const list of st.classes.values()) for (const info of list) if (info.ci3Seg === segs[0].toLowerCase()) found = { info, method: 'index' };
    }
    if (!found) continue;
    const m = found.info.unit.methods.find((x) => x.name.toLowerCase() === found!.method.toLowerCase());
    if (!m) continue;
    const path = `/${r.from.replace(/\(:(num|any|alpha|alphanum|segment)\)|\([^)]*\)/g, '{p}').replace(/^\//, '')}`;
    for (const meth of r.methods) if (!m.routes.some((x) => x.path === path)) m.routes.push({ method: meth, path, line: m.line });
  }

  // 모델 연산 → ORM SQL
  for (const op of st.modelOps) {
    let modelName = op.model;
    if (op.field) {
      const owner = op.cls ? findClass(st, op.cls) : undefined;
      const t = owner?.unit.fields[op.model] ?? owner?.unit.fields[op.model.toLowerCase()];
      if (!t) continue;
      modelName = t;
    }
    const info = findClass(st, modelName);
    if (!info || info.unit.kind !== 'model') continue;
    // 모델 클래스가 직접 정의한 메서드면 일반 호출(링크가 따라감)
    if (info.unit.methods.some((m) => m.name === op.ops[0]) && !op.relations.length) continue;
    const table = info.unit.table ?? modelTable(st, info);
    let tables: TableRef[] = [];
    if (op.relations.length && op.ops.length === 1 && /^(create|createMany|save|saveMany|insert|update|delete)$/.test(op.ops[0]) && op.instance && op.relations.length === 1) {
      // $order->items()->create()
      const target = info.relations.get(op.relations[0]);
      const ti = target ? findClass(st, target) : undefined;
      if (!ti) continue;
      tables = opsCrud(op.ops).map((c) => ({ name: modelTable(st, ti), crud: c }));
    } else {
      // 인스턴스의 모델 메서드가 아닌 속성 접근 체인(get 등)은 읽기, 쓰기 연산은 그대로
      const writes = op.ops.filter((o) => OP_CRUD[o.toLowerCase()]);
      if (op.instance && !writes.length && !/^(load|loadMissing|refresh|fresh|get|first|find|findAll|where|paginate)$/i.test(op.ops[0])) continue;
      tables = opsCrud(op.ops, op.created).map((c) => ({ name: table, crud: c }));
      for (const j of op.joins) tables.push({ name: j, crud: 'R' });
      for (const r of op.relations) {
        const target = info.relations.get(r);
        const ti = target ? findClass(st, target) : undefined;
        if (ti) tables.push({ name: modelTable(st, ti), crud: 'R' });
      }
    }
    if (!tables.length) continue;
    const crud = new Set(tables.map((x) => x.crud));
    const kind = crud.has('C') ? 'insert' : crud.has('U') ? 'update' : crud.has('D') ? 'delete' : 'select';
    const s = ctx.addSql({ file: op.file, line: op.line, origin: 'orm', kind, tables, text: `${info.unit.name}${op.instance ? '->' : '::'}${op.ops.join('()->')}() (${info.fw === 'ci4' ? 'CodeIgniter Model' : 'Eloquent'})` });
    ctx.hit('데이터 접근', info.fw === 'ci4' ? 'CodeIgniter Model' : 'Eloquent', op.file, op.line, 1);
    op.method.sql.push(s.id);
  }

  // 이름 붙은 라우트·action() 참조 해석
  for (const p of st.pendingRefs) {
    let path: string | null = null;
    if (p.name) path = named.get(p.name)?.path ?? null;
    else if (p.action) path = byAction.get(`${simpleName(p.action.ctrl).toLowerCase()}@${p.action.method.toLowerCase()}`)?.path ?? null;
    if (path) p.url.url = path;
  }
  for (const v of ctx.facts.views) v.urls = v.urls.filter((u) => u.url);

  // include 대상 → 조각
  const includedPaths = new Set<string>();
  for (const v of ctx.facts.views) for (const inc of v.includes) includedPaths.add(inc);
  for (const list of st.includes.values()) for (const p of list) includedPaths.add(p);
  const loadCount = new Map<string, number>();
  for (const l of st.viewLoads) for (const v of new Set(l.views)) loadCount.set(v, (loadCount.get(v) ?? 0) + (l.views.length > 1 ? 1 : 0));
  for (const [fid, x] of st.viewFacts) {
    const f = ctx.byId.get(fid);
    if (!f) continue;
    if (includedPaths.has(f.path)) x.view.fragment = true;
    if ((x.fw === 'ci3' || x.fw === 'ci4') && (loadCount.get(x.name) ?? 0) >= 3) x.view.fragment = true;
  }
  // 함께 로드되는 CI 뷰 중 조각은 메서드의 대표 화면에서 뺀다
  for (const l of st.viewLoads) {
    if (l.views.length < 2) continue;
    const keep = l.views.filter((vn) => {
      for (const x of st.viewFacts.values()) if (x.name === vn) return !x.view.fragment;
      return true;
    });
    if (keep.length) l.method.views = keep;
  }
  // 순수 PHP: include되는 파일은 페이지가 아님
  for (const [fid, pu] of st.pageUnits) {
    const f = ctx.byId.get(fid);
    if (!f) continue;
    if (includedPaths.has(f.path)) {
      pu.method.routes = [];
      if (pu.view) pu.view.fragment = true;
    }
  }
}
