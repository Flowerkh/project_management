// Android 분석기: AndroidManifest·strings·layout·navigation·menu XML과 build.gradle을 읽고,
// Java·Kotlin 코드에서 Activity·Fragment·Compose 화면, Retrofit API, Room DAO·엔티티, SQLiteOpenHelper SQL,
// OkHttp·Volley·HttpURLConnection 호출, WebView 주소를 찾아 화면(ViewFact kind 'app')·메뉴·SQL·httpCalls로 남긴다.
// 화면 클래스의 진입 메서드(onCreate·onViewCreated·@Composable 함수)는 views = [화면 파일 경로]를 가져
// link가 진입 메서드 → ViewModel → Repository → DAO·API → (서버 라우트) → 테이블을 따라간다.
import type { Analyzer, Ctx } from '../context';
import type { CodeUnit, FileInfo, MenuFact, MethodUnit, UrlRef, ViewFact } from '../types';
import { baseName, makeLineIndex } from '../files';
import { blankStrings, stripCComments } from './jutil';
import {
  addDdlTable, addHttp, addSqlText, addTableOp, cleanLabel, closeOf, featureGroup, joinBase, lineStarts, newMethod, screenNameOf, snakeLower, stateOf,
} from './applib';
import { annArg, ktState, literalsIn, resolveKotlinCalls, simpleType, stringExpr } from './kotlin';
import type { KtClass, KtFile, KtFun, KtRegion, Region } from './kotlin';

// ------------------------------------------------------------------ XML

interface XmlEl {
  tag: string;
  attrs: Record<string, string>;
  line: number;
  children: XmlEl[];
}

export function parseXml(text: string): XmlEl {
  const src = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const lineOf = makeLineIndex(src);
  const root: XmlEl = { tag: '#root', attrs: {}, line: 1, children: [] };
  const stack: XmlEl[] = [root];
  const re = /<(\/)?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [, close, tag, rawAttrs, self] = m;
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = (a[2] ?? a[3] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const el: XmlEl = { tag, attrs, line: lineOf(m.index), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!self) stack.push(el);
  }
  return root;
}

function at(el: XmlEl, ...names: string[]): string | undefined {
  for (const n of names) if (el.attrs[n] !== undefined) return el.attrs[n];
  return undefined;
}

function walkXml(el: XmlEl, fn: (e: XmlEl, parent: XmlEl) => void): void {
  for (const c of el.children) {
    fn(c, el);
    walkXml(c, fn);
  }
}

const idOf = (v: string | undefined) => (v ? v.replace(/^@\+?id\//, '').replace(/^@\+?[\w.]+:id\//, '') : undefined);
const resName = (v: string | undefined, kind: string) => {
  const m = v ? new RegExp(`^@${kind}/([\\w.]+)$`).exec(v) : null;
  return m ? m[1] : undefined;
};

// ------------------------------------------------------------------ 상태

interface Str {
  value: string;
  file: string;
  line: number;
}

interface NavDest {
  id: string;
  kind: string;
  name?: string;
  label?: string;
  layout?: string;
  actions: string[];
  line: number;
  file: string;
  children: NavDest[];
  start?: string;
  graphRef?: string;
}

interface MenuItemX {
  id: string;
  title?: string;
  line: number;
  children: MenuItemX[];
}

interface AndroidState {
  manifests: { file: string; path: string; dir: string; pkg?: string; appLabel?: string; appLine?: number; activities: { name: string; label?: string; launcher: boolean; line: number }[] }[];
  strings: Map<string, Str & { rank: number }>;
  layouts: Map<string, { file: string; path: string }[]>;
  layoutInfo: Map<string, { includes: string[]; navMenus: string[]; title?: { value: string; line: number }; navGraph?: string }>;
  navs: { file: string; path: string; name: string; root: NavDest }[];
  menus: Map<string, { file: string; path: string; items: MenuItemX[] }>;
  buildConfig: Map<string, string>;
  gradle: { file: string; dir: string; namespace?: string }[];
  javaFiles: Set<string>;
}

const STATE = new WeakMap<object, AndroidState>();
function aState(ctx: Ctx): AndroidState {
  return stateOf(ctx.facts, STATE, () => ({
    manifests: [], strings: new Map(), layouts: new Map(), layoutInfo: new Map(), navs: [], menus: new Map(), buildConfig: new Map(), gradle: [], javaFiles: new Set(),
  }));
}

const GRADLE_RULES: { re: RegExp; layer: '앱' | '데이터 접근' | 'DB'; name: string; weight: number }[] = [
  { re: /com\.android\.application|com\.android\.library|id\s*\(?\s*["']com\.android\./, layer: '앱', name: 'Android', weight: 3 },
  { re: /com\.squareup\.retrofit2/, layer: '앱', name: 'Retrofit', weight: 3 },
  { re: /com\.squareup\.okhttp3/, layer: '앱', name: 'OkHttp', weight: 2 },
  { re: /com\.android\.volley/, layer: '앱', name: 'Volley', weight: 2 },
  { re: /io\.ktor:ktor-client|ktor\.client/, layer: '앱', name: 'Ktor Client', weight: 2 },
  { re: /androidx\.compose|compose\s*(=\s*)?true/, layer: '앱', name: 'Jetpack Compose', weight: 2 },
  { re: /androidx\.navigation/, layer: '앱', name: 'Jetpack Navigation', weight: 2 },
  { re: /dagger[.:]hilt|hilt-android/, layer: '앱', name: 'Hilt', weight: 1 },
  { re: /androidx\.room/, layer: '데이터 접근', name: 'Room', weight: 3 },
  { re: /androidx\.room/, layer: 'DB', name: 'SQLite', weight: 2 },
];

function unescapeAndroid(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\\n/g, ' ').replace(/\\(['"@?])/g, '$1')
    .replace(/^"|"$/g, '')
    .trim();
}

// ------------------------------------------------------------------ 1차: 파일별

export const androidAnalyzer: Analyzer = {
  name: 'android',
  order: 22,
  accepts(f, text) {
    if (f.layer === 'TEST') return false;
    if (f.lang === 'XML') return f.name === 'AndroidManifest.xml' || /(^|\/)res\/(layout[^/]*|navigation|menu|values[^/]*)\/[^/]+\.xml$/.test(f.path);
    if (/^build\.gradle(\.kts)?$/.test(f.name) || f.name === 'libs.versions.toml') return true;
    if (f.lang === 'Java') return /^\s*import\s+(android|androidx|retrofit2|okhttp3|com\.android\.volley|com\.google\.android)\./m.test(text);
    return false;
  },
  analyze(f, text, ctx) {
    const st = aState(ctx);
    if (f.lang === 'Java') {
      st.javaFiles.add(f.id);
      return;
    }
    if (f.name === 'libs.versions.toml') {
      const lineOf = makeLineIndex(text);
      for (const r of GRADLE_RULES) {
        const m = r.re.exec(text);
        if (m && r.name !== 'Android') ctx.hit(r.layer, r.name, f.id, lineOf(m.index), r.weight);
      }
      f.layer = 'CONFIG';
      return;
    }
    if (/^build\.gradle(\.kts)?$/.test(f.name)) {
      const lineOf = makeLineIndex(text);
      for (const r of GRADLE_RULES) {
        const m = r.re.exec(text);
        if (m) ctx.hit(r.layer, r.name, f.id, lineOf(m.index), r.weight);
      }
      for (const m of text.matchAll(/buildConfigField\s*\(?\s*["']String["']\s*,\s*["'](\w+)["']\s*,\s*(?:'"([^"']*)"'|"\\"([^"\\]*)\\""|'([^']*)')/g)) {
        const v = m[2] ?? m[3] ?? m[4] ?? '';
        if (!st.buildConfig.has(m[1])) st.buildConfig.set(m[1], v);
      }
      const ns = /\bnamespace\s*=?\s*["']([\w.]+)["']/.exec(text)?.[1] ?? /\bapplicationId\s*=?\s*["']([\w.]+)["']/.exec(text)?.[1];
      st.gradle.push({ file: f.id, dir: f.path.slice(0, -f.name.length - 1), ...(ns ? { namespace: ns } : {}) });
      return;
    }
    const xml = parseXml(text);
    if (f.name === 'AndroidManifest.xml') {
      const man = xml.children.find((e) => e.tag === 'manifest');
      const app = man?.children.find((e) => e.tag === 'application');
      const dir = f.path.replace(/\/AndroidManifest\.xml$/, '').replace(/\/src\/main$/, '');
      const activities: AndroidState['manifests'][number]['activities'] = [];
      for (const a of app?.children ?? []) {
        if (a.tag !== 'activity' && a.tag !== 'activity-alias') continue;
        const name = at(a, 'android:name', 'android:targetActivity');
        if (!name) continue;
        let launcher = false;
        walkXml(a, (e) => {
          if (e.tag === 'category' && /LAUNCHER$/.test(at(e, 'android:name') ?? '')) launcher = true;
        });
        const label = at(a, 'android:label');
        activities.push({ name, ...(label ? { label } : {}), launcher, line: a.line });
      }
      const appLabel = app ? at(app, 'android:label') : undefined;
      st.manifests.push({ file: f.id, path: f.path, dir, ...(man?.attrs.package ? { pkg: man.attrs.package } : {}), ...(appLabel ? { appLabel, appLine: app!.line } : {}), activities });
      f.layer = 'CONFIG';
      return;
    }
    const folder = /\/res\/([^/]+)\/[^/]+$/.exec(f.path)?.[1] ?? '';
    const name = f.name.replace(/\.xml$/, '');
    if (folder.startsWith('values')) {
      const rank = folder === 'values-ko' || folder === 'values-ko-rKR' ? 0 : folder === 'values' ? 1 : 2;
      const lineOf = makeLineIndex(text);
      for (const m of text.matchAll(/<string\s+([^>]*?)>([\s\S]*?)<\/string>/g)) {
        const nm = /\bname\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
        if (!nm) continue;
        const prev = st.strings.get(nm);
        if (prev && prev.rank <= rank) continue;
        st.strings.set(nm, { value: unescapeAndroid(m[2]), file: f.id, line: lineOf(m.index ?? 0), rank });
      }
      f.layer = 'CONFIG';
      return;
    }
    if (folder.startsWith('layout')) {
      const list = st.layouts.get(name) ?? [];
      list.push({ file: f.id, path: f.path });
      st.layouts.set(name, list);
      const info: AndroidState['layoutInfo'] extends Map<string, infer V> ? V : never = { includes: [], navMenus: [] };
      walkXml(xml, (e) => {
        if (e.tag === 'include' || e.tag === 'merge') {
          const l = resName(at(e, 'layout'), 'layout');
          if (l && !info.includes.includes(l)) info.includes.push(l);
        }
        const menu = resName(at(e, 'app:menu'), 'menu');
        if (menu && /(BottomNavigationView|NavigationView|NavigationRailView|BottomAppBar)$/.test(e.tag)) info.navMenus.push(menu);
        const graph = resName(at(e, 'app:navGraph'), 'navigation');
        if (graph) info.navGraph = graph;
        if (!info.title) {
          const isBar = /(Toolbar|ActionBar|MaterialToolbar|CollapsingToolbarLayout)$/.test(e.tag);
          const t = isBar ? at(e, 'app:title', 'android:title') : /title/i.test(idOf(at(e, 'android:id')) ?? '') && /TextView$/.test(e.tag) ? at(e, 'android:text') : undefined;
          if (t) info.title = { value: t, line: e.line };
        }
      });
      st.layoutInfo.set(f.id, info);
      f.layer = 'VIEW';
      return;
    }
    if (folder === 'navigation') {
      const nav = xml.children.find((e) => e.tag === 'navigation');
      if (!nav) return;
      const toDest = (e: XmlEl): NavDest => {
        const d: NavDest = {
          id: idOf(at(e, 'android:id')) ?? '',
          kind: e.tag === 'navigation' ? 'graph' : e.tag === 'include' ? 'include' : e.tag.replace(/^.*\./, ''),
          ...(at(e, 'android:name') ? { name: at(e, 'android:name') } : {}),
          ...(at(e, 'android:label') ? { label: at(e, 'android:label') } : {}),
          ...(resName(at(e, 'tools:layout'), 'layout') ? { layout: resName(at(e, 'tools:layout'), 'layout') } : {}),
          actions: [],
          line: e.line,
          file: f.id,
          children: [],
          ...(idOf(at(e, 'app:startDestination')) ? { start: idOf(at(e, 'app:startDestination')) } : {}),
          ...(resName(at(e, 'app:graph'), 'navigation') ? { graphRef: resName(at(e, 'app:graph'), 'navigation') } : {}),
        };
        for (const c of e.children) {
          if (c.tag === 'action') {
            const to = idOf(at(c, 'app:destination'));
            if (to && !d.actions.includes(to)) d.actions.push(to);
          } else if (c.tag !== 'argument' && c.tag !== 'deepLink' && (e.tag === 'navigation')) d.children.push(toDest(c));
        }
        return d;
      };
      st.navs.push({ file: f.id, path: f.path, name, root: toDest(nav) });
      f.layer = 'MENU_DATA';
      return;
    }
    if (folder === 'menu') {
      const menu = xml.children.find((e) => e.tag === 'menu');
      if (!menu) return;
      const items = (e: XmlEl): MenuItemX[] => {
        const out: MenuItemX[] = [];
        for (const c of e.children) {
          if (c.tag === 'group') out.push(...items(c));
          else if (c.tag === 'item') {
            const sub = c.children.find((x) => x.tag === 'menu');
            out.push({ id: idOf(at(c, 'android:id')) ?? '', ...(at(c, 'android:title', 'app:title') ? { title: at(c, 'android:title', 'app:title') } : {}), line: c.line, children: sub ? items(sub) : [] });
          }
        }
        return out;
      };
      st.menus.set(name, { file: f.id, path: f.path, items: items(menu) });
    }
  },
  finish(ctx) {
    finishAndroid(ctx);
  },
};

// ------------------------------------------------------------------ 2차: 전체

interface JavaSrc {
  file: FileInfo;
  text: string;
  code: string;
  skel: string;
  starts: number[];
  lineOf: (o: number) => number;
  units: CodeUnit[];
}

const ACTIVITY_EXT = /^(Activity|AppCompatActivity|ComponentActivity|FragmentActivity|ListActivity|PreferenceActivity|DaggerAppCompatActivity|DaggerActivity|AppCompatPreferenceActivity|CordovaActivity|BridgeActivity|TabActivity|ExpandableListActivity)$/;
const FRAGMENT_EXT = /^(Fragment|DialogFragment|BottomSheetDialogFragment|AppCompatDialogFragment|PreferenceFragmentCompat|PreferenceFragment|ListFragment|DaggerFragment|DaggerDialogFragment|WebViewFragment)$/;
const NOT_SCREEN = /^(FlutterActivity|FlutterFragmentActivity|FlutterFragment|ReactActivity|ReactFragmentActivity|ReactFragment|NavHostFragment|SupportMapFragment|MapFragment)$/;

function finishAndroid(ctx: Ctx): void {
  const st = aState(ctx);
  const kt = ktState(ctx);
  if (!kt.files.size && !st.javaFiles.size && !st.manifests.length) return;
  resolveKotlinCalls(ctx);

  const units = ctx.facts.units;
  const unitsByName = new Map<string, CodeUnit[]>();
  const unitByFqn = new Map<string, CodeUnit>();
  for (const u of units) {
    const a = unitsByName.get(u.name) ?? [];
    a.push(u);
    unitsByName.set(u.name, a);
    if (u.fqn) unitByFqn.set(u.fqn, u);
  }

  // Java 원본 (Android 관련 파일만)
  const javaSrc = new Map<string, JavaSrc>();
  for (const id of st.javaFiles) {
    const file = ctx.byId.get(id);
    const text = ctx.facts.texts.get(id);
    if (!file || text === undefined) continue;
    const code = stripCComments(text);
    javaSrc.set(id, { file, text, code, skel: blankStrings(code), starts: lineStarts(text), lineOf: makeLineIndex(text), units: units.filter((u) => u.file === id) });
  }

  // ---------------------------------------------------------------- 상수
  const javaConsts = new Map<string, string>();
  for (const js of javaSrc.values()) {
    const owner = js.file.name.replace(/\.java$/, '');
    for (const m of js.code.matchAll(/\bstatic\s+final\s+String\s+(\w+)\s*=\s*([^;]+);/g)) {
      const v = stringExpr(m[2], 0, m[2].length, (n) => javaConsts.get(n), false);
      if (v === undefined || v.includes('{p}')) continue;
      if (!javaConsts.has(m[1])) javaConsts.set(m[1], v);
      javaConsts.set(`${owner}.${m[1]}`, v);
    }
  }
  const constOf = (fileId: string) => (name: string): string | undefined => {
    if (/^BuildConfig\./.test(name)) return st.buildConfig.get(name.slice('BuildConfig.'.length));
    const k = kt.consts.size ? kotlinConst(kt, fileId, name) : undefined;
    if (k !== undefined) return k;
    return javaConsts.get(name) ?? javaConsts.get(name.split('.').slice(-2).join('.')) ?? javaConsts.get(name.split('.').pop()!);
  };
  const str = (v: string | undefined): string | undefined => {
    if (!v) return undefined;
    const r = /^@string\/(\w+)$/.exec(v);
    if (r) return st.strings.get(r[1])?.value;
    if (/^@/.test(v)) return undefined;
    return v;
  };
  const strRef = (v: string | undefined): Str | undefined => {
    const r = v ? /^@string\/(\w+)$/.exec(v) : null;
    if (r) {
      const s = st.strings.get(r[1]);
      return s ? { value: s.value, file: s.file, line: s.line } : undefined;
    }
    return undefined;
  };

  // ---------------------------------------------------------------- 영역: Kotlin 메서드 + Java 메서드(줄 범위)
  interface Body {
    file: string;
    code: string;
    skel: string;
    from: number;
    to: number;
    m: MethodUnit;
    unit: CodeUnit;
    lineOf: (o: number) => number;
    java: boolean;
    reg?: KtRegion;
  }
  const bodies: Body[] = [];
  for (const reg of kt.regions) for (const r of reg.regions) bodies.push({ file: reg.kf.fileId, code: reg.kf.code, skel: reg.kf.skel, from: r.from, to: r.to, m: reg.m, unit: reg.unit, lineOf: reg.kf.lineOf, java: false, reg });
  for (const js of javaSrc.values()) {
    for (const u of js.units) {
      for (const m of u.methods) {
        if (!m.endLine) continue;
        const from = js.starts[m.line - 1] ?? 0;
        const to = js.starts[m.endLine] ?? js.code.length;
        bodies.push({ file: js.file.id, code: js.code, skel: js.skel, from, to, m, unit: u, lineOf: js.lineOf, java: true });
      }
    }
  }

  // ---------------------------------------------------------------- Retrofit 기준 URL
  const baseBySvc = new Map<string, string>();
  const bases: string[] = [];
  const scanBase = (fileId: string, code: string, java: boolean) => {
    for (const m of code.matchAll(/\.baseUrl\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = findClose(code, open);
      const v = stringExpr(code, open + 1, close, constOf(fileId), !java);
      if (v === undefined) continue;
      bases.push(v);
      const tail = code.slice(close, close + 600);
      const svc = /\.create\s*\(\s*([A-Z]\w*)\s*(?:::\s*class\.java|\.class)\s*\)|\.create\s*<\s*([A-Z]\w*)\s*>/.exec(tail);
      if (svc) baseBySvc.set(svc[1] ?? svc[2], v);
    }
  };
  for (const kf of kt.files.values()) if (kf.code.includes('baseUrl')) scanBase(kf.fileId, kf.code, false);
  for (const js of javaSrc.values()) if (js.code.includes('baseUrl')) scanBase(js.file.id, js.code, true);
  // 서비스 생성이 다른 곳에 있으면(retrofit.create(Api::class.java)) 기준 URL이 하나일 때 그것으로
  const uniqBases = [...new Set(bases)];
  const baseFor = (svc: string) => baseBySvc.get(svc) ?? (uniqBases.length === 1 ? uniqBases[0] : uniqBases[0]);

  // ---------------------------------------------------------------- Kotlin: Retrofit·Room·MyBatis 애노테이션
  const entityTable = new Map<string, string>();
  for (const u of units) if (u.kind === 'model' && u.table) entityTable.set(u.name, u.table);
  const tableOfType = (t: string) => {
    const simple = simpleType(t.replace(/^(List|MutableList|Collection|Set|Array|Iterable|Flow|LiveData|vararg)\s*<\s*/, '').replace(/>+$/, ''));
    return entityTable.get(simple);
  };
  for (const kf of kt.files.values()) {
    const resolve = constOf(kf.fileId);
    const each = (list: KtClass[]) => {
      for (const c of list) {
        each(c.classes);
        if (!c.unit) continue;
        const isDao = c.anns.some((a) => a.name === 'Dao');
        for (const fn of c.funs) {
          if (!fn.method) continue;
          for (const a of fn.anns) {
            const line = kf.lineOf(a.start);
            if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(a.name)) {
              const p = literalsIn(annArg(a.args, 'value') ?? annArg(a.args) ?? '', 0, 2000, resolve)[0];
              if (p !== undefined) addHttp(fn.method, a.name, joinBase(baseFor(c.name), p), line);
            } else if (a.name === 'HTTP') {
              const verb = literalsIn(annArg(a.args, 'method') ?? '', 0, 200, resolve)[0];
              const p = literalsIn(annArg(a.args, 'path') ?? '', 0, 2000, resolve)[0];
              if (verb && p !== undefined) addHttp(fn.method, verb, joinBase(baseFor(c.name), p), line);
            } else if (a.name === 'Query' && (isDao || /nativeQuery\s*=\s*true/.test(a.args) || /^\s*import\s+(androidx\.room|android\.arch\.persistence)/m.test(kf.code))) {
              const arg = annArg(a.args, 'value') ?? annArg(a.args) ?? '';
              const sql = stringExpr(arg, 0, arg.length, resolve);
              if (sql) addSqlText(ctx, kf.fileId, line, fn.method, sql, { trusted: true, origin: 'annotation' });
            } else if (/^(Select|Insert|Update|Delete)$/.test(a.name) && /"/.test(a.args)) {
              // MyBatis 애노테이션 SQL
              const arg = annArg(a.args, 'value') ?? annArg(a.args) ?? '';
              const sql = literalsIn(arg, 0, arg.length, resolve).join(' ');
              if (sql.trim()) addSqlText(ctx, kf.fileId, line, fn.method, sql, { trusted: true, origin: 'annotation' });
            } else if (isDao && /^(Insert|Update|Delete|Upsert)$/.test(a.name)) {
              const table = fn.params.map((p) => tableOfType(p.type)).find(Boolean);
              if (table) {
                const kind = a.name === 'Insert' || a.name === 'Upsert' ? 'insert' : a.name === 'Update' ? 'update' : 'delete';
                addTableOp(ctx, kf.fileId, line, fn.method, kind, table, `Room @${a.name} ${c.name}.${fn.name}() → ${table}`, a.name === 'Upsert' ? ['U'] : []);
              }
            }
          }
        }
        // Room 엔티티 → DDL (컬럼: 생성자 val·프로퍼티, @ColumnInfo(name), @PrimaryKey)
        if (c.unit.kind === 'model' && c.unit.table && c.anns.some((a) => a.name === 'Entity') && /^\s*import\s+androidx\.room\./m.test(kf.code)) {
          const cols: { name: string; type?: string; pk?: boolean; nullable?: boolean }[] = [];
          const pkFromEntity = literalsIn(annArg(c.anns.find((a) => a.name === 'Entity')!.args, 'primaryKeys') ?? '', 0, 400, resolve);
          const addCol = (name: string, type: string, anns: string) => {
            const cn = /@ColumnInfo\s*\([^)]*name\s*=\s*"([^"]+)"/.exec(anns)?.[1] ?? name;
            if (/@Ignore\b/.test(anns)) return;
            cols.push({ name: cn, type: type.replace(/\?$/, ''), ...(/@PrimaryKey\b/.test(anns) || pkFromEntity.includes(cn) ? { pk: true } : {}), nullable: /\?\s*$/.test(type) });
          };
          if (c.body || c.params.length) {
            // 생성자 매개변수는 원문에서 애노테이션 포함해 다시 읽음
            const open = kf.skel.indexOf('(', c.namePos);
            if (open > 0 && open < (c.body?.from ?? Infinity)) {
              const close = closeOf(kf.skel, open);
              for (const part of splitTop(kf.skel, open + 1, close)) {
                const raw = kf.code.slice(part.from, part.to);
                const pm = /(?:val|var)\s+(\w+)\s*:\s*([\w.<>?, ]+?)\s*(?:=|$)/.exec(raw);
                if (pm) addCol(pm[1], pm[2], raw);
              }
            }
            for (const p of c.props) {
              if (/\b(companion|private\s+val\s+_)\b/.test(p.mods)) continue;
              const anns = p.anns.map((a) => `@${a.name}(${a.args})`).join(' ');
              if (!cols.some((x) => x.name === p.name)) addCol(p.name, p.type ?? '', anns);
            }
          }
          addDdlTable(ctx.facts, { name: c.unit.table, columns: cols.map((x) => ({ name: x.name, ...(x.type ? { type: x.type } : {}), ...(x.pk ? { pk: true, nullable: false } : { nullable: x.nullable }) })), evidence: { file: kf.fileId, line: kf.lineOf(c.namePos) } });
        }
      }
    };
    each(kf.classes);
  }

  // ---------------------------------------------------------------- Java: Retrofit·Room 애노테이션
  for (const js of javaSrc.values()) {
    if (!/@(GET|POST|PUT|DELETE|PATCH|HTTP|Query|Insert|Update|Delete|Entity|Dao)\b/.test(js.code)) continue;
    const resolve = constOf(js.file.id);
    // @Entity(tableName = "memo") → 테이블
    for (const em of js.code.matchAll(/@Entity\s*(\(([^)]*)\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+)*class\s+(\w+)/g)) {
      const u = js.units.find((x) => x.name === em[3]);
      if (!u) continue;
      const tn = em[2] ? literalsIn(annArg(em[2], 'tableName') ?? '', 0, 400, resolve, false)[0] : undefined;
      u.kind = 'model';
      u.table = tn || em[3];
      entityTable.set(u.name, u.table);
      // 컬럼: 필드 선언
      const bodyOpen = js.skel.indexOf('{', (em.index ?? 0) + em[0].length);
      const bodyClose = bodyOpen > 0 ? closeOf(js.skel, bodyOpen) : -1;
      const cols: { name: string; type?: string; pk?: boolean; nullable?: boolean }[] = [];
      if (bodyOpen > 0) {
        const body = js.code.slice(bodyOpen + 1, bodyClose);
        for (const fm of body.matchAll(/((?:@\w+(?:\s*\([^)]*\))?\s*)*)(?:public|private|protected)?\s*(?!static)([\w<>.]+)\s+(\w+)\s*(?:=[^;]*)?;/g)) {
          if (/@Ignore\b/.test(fm[1]) || /\bstatic\b/.test(fm[0])) continue;
          const cn = /@ColumnInfo\s*\([^)]*name\s*=\s*"([^"]+)"/.exec(fm[1])?.[1] ?? fm[3];
          cols.push({ name: cn, type: fm[2], ...(/@PrimaryKey\b/.test(fm[1]) ? { pk: true } : {}) });
        }
      }
      addDdlTable(ctx.facts, { name: u.table, columns: cols.map((x) => ({ name: x.name, ...(x.type ? { type: x.type } : {}), ...(x.pk ? { pk: true, nullable: false } : {}) })), evidence: { file: js.file.id, line: js.lineOf(em.index ?? 0) } });
    }
  }
  for (const js of javaSrc.values()) {
    if (!/@(GET|POST|PUT|DELETE|PATCH|HTTP|Query|Insert|Update|Delete|Upsert)\b/.test(js.code)) continue;
    const resolve = constOf(js.file.id);
    const isDaoFile = /@Dao\b/.test(js.code);
    const re = /((?:@\w+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)+)(?:public\s+|abstract\s+|default\s+|static\s+|synchronized\s+)*([\w<>\[\],.?\s]+?)\s+(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:throws\s+[\w.,\s]+)?[;{]/g;
    for (const mm of js.code.matchAll(re)) {
      const annText = mm[1];
      const name = mm[3];
      const line = js.lineOf((mm.index ?? 0) + mm[0].indexOf(name, mm[1].length));
      const owner = js.units.find((u) => u.methods.some((x) => x.name === name));
      const m = owner?.methods.filter((x) => x.name === name).sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
      if (!owner || !m) continue;
      for (const am of annText.matchAll(/@(\w+)(?:\s*\(((?:[^()]|\([^()]*\))*)\))?/g)) {
        const an = am[1];
        const args = am[2] ?? '';
        if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(an)) {
          const p = literalsIn(annArg(args, 'value') ?? annArg(args) ?? '', 0, 2000, resolve, false)[0];
          if (p !== undefined) addHttp(m, an, joinBase(baseFor(owner.name), p), line);
        } else if (an === 'HTTP') {
          const verb = literalsIn(annArg(args, 'method') ?? '', 0, 200, resolve, false)[0];
          const p = literalsIn(annArg(args, 'path') ?? '', 0, 2000, resolve, false)[0];
          if (verb && p !== undefined) addHttp(m, verb, joinBase(baseFor(owner.name), p), line);
        } else if (an === 'Query' && isDaoFile && !m.sql.length) {
          const arg = annArg(args, 'value') ?? annArg(args) ?? '';
          const sql = stringExpr(arg, 0, arg.length, resolve, false);
          if (sql) addSqlText(ctx, js.file.id, line, m, sql, { trusted: true, origin: 'annotation' });
        } else if (isDaoFile && /^(Insert|Update|Delete|Upsert)$/.test(an) && !/"/.test(args)) {
          const ptype = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:final\s+)?([\w<>.\[\]]+)\s+\w+/.exec(mm[4])?.[1] ?? '';
          const table = tableOfType(ptype.replace(/\[\]$/, ''));
          if (table) addTableOp(ctx, js.file.id, line, m, an === 'Insert' || an === 'Upsert' ? 'insert' : an === 'Update' ? 'update' : 'delete', table, `Room @${an} ${owner.name}.${name}() → ${table}`);
        }
      }
      if (isDaoFile && owner.kind === 'other') owner.kind = 'dao';
    }
  }

  // ---------------------------------------------------------------- 몸체: SQLite·HTTP 클라이언트·문자열 SQL
  const webviewRefs = new Map<string, UrlRef[]>(); // 파일 ID → 웹뷰 주소
  for (const b of bodies) {
    const seg = b.skel.slice(b.from, b.to);
    if (!/[.(]/.test(seg)) continue;
    const resolve = constOf(b.file);
    const evalAt = (open: number): string | undefined => {
      const close = findClose(b.code, open);
      // 첫 인자만
      const parts = splitTop(b.skel, open + 1, close);
      const first = parts[0];
      return first ? stringExpr(b.code, first.from, first.to, resolve, !b.java) : undefined;
    };
    const argAt = (open: number, n: number): string | undefined => {
      const close = findClose(b.code, open);
      const parts = splitTop(b.skel, open + 1, close);
      const p = parts[n];
      return p ? stringExpr(b.code, p.from, p.to, resolve, !b.java) : undefined;
    };
    const lineAt = (o: number) => b.lineOf(o);
    // SQLiteDatabase API
    for (const m of seg.matchAll(/\b(\w+)(\s*\(\s*\))?\s*(?:\?|!!)?\s*\.\s*(rawQuery|execSQL|query|insert|insertOrThrow|insertWithOnConflict|replace|replaceOrThrow|update|updateWithOnConflict|delete|compileStatement)\s*\(/g)) {
      const recv = m[1];
      const op = m[3];
      const open = b.from + (m.index ?? 0) + m[0].length - 1;
      if (!/^(getWritableDatabase|getReadableDatabase|db|database|sqlDb|sqliteDb|mDb|mDatabase|writableDatabase|readableDatabase|it|this|wdb|rdb|sqLiteDatabase|sqliteDatabase)$/i.test(recv) && !/SQLiteDatabase/.test(b.code)) continue;
      const line = lineAt(open);
      if (op === 'rawQuery' || op === 'execSQL' || op === 'compileStatement') {
        const sql = evalAt(open);
        if (sql) addSqlText(ctx, b.file, line, b.m, sql, { trusted: /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|WITH)\b/i.test(sql) });
        continue;
      }
      const table = evalAt(open);
      if (!table || !/^[A-Za-z_][\w$]*$/.test(table)) continue;
      const kind = op === 'query' ? 'select' : op.startsWith('insert') || op.startsWith('replace') ? 'insert' : op.startsWith('update') ? 'update' : 'delete';
      addTableOp(ctx, b.file, line, b.m, kind, table, `SQLiteDatabase.${op}("${table}")`);
    }
    // 문자열 SQL (Kotlin만: Java는 java 분석기가 처리) — CREATE TABLE은 DDL로
    if (!b.java) {
      for (const lm of seg.matchAll(/"/g)) {
        const at0 = b.from + (lm.index ?? 0);
        if (b.code[at0 - 1] === '\\') continue;
        const lit = b.code.slice(at0, Math.min(b.to, at0 + 3000));
        if (!/^"(""|)\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|WITH|REPLACE)\b/i.test(lit)) continue;
        const end = statementEnd(b.skel, at0, b.to);
        const sql = stringExpr(b.code, at0, end, resolve);
        if (sql) addSqlText(ctx, b.file, lineAt(at0), b.m, sql);
      }
    } else {
      for (const lm of b.code.slice(b.from, b.to).matchAll(/execSQL\s*\(/g)) {
        const open = b.from + (lm.index ?? 0) + lm[0].length - 1;
        const sql = evalAt(open);
        if (sql && /^\s*CREATE\s+TABLE/i.test(sql)) addSqlText(ctx, b.file, lineAt(open), b.m, sql);
      }
    }
    // OkHttp: Request.Builder().url(x)…post(…)
    for (const m of seg.matchAll(/\.url\s*\(/g)) {
      const open = b.from + (m.index ?? 0) + m[0].length - 1;
      const before = b.skel.slice(Math.max(b.from, open - 300), open);
      if (!/Request\s*\.\s*Builder\s*\(\s*\)|Builder\s*\(\s*\)/.test(before)) continue;
      const url = evalAt(open);
      if (url === undefined) continue;
      const after = b.skel.slice(open, Math.min(b.to, open + 400));
      const verb = /\.\s*(post|put|delete|patch)\s*\(/i.exec(after.split(/\.build\s*\(/)[0])?.[1] ?? /\.method\s*\(\s*"(\w+)"/.exec(b.code.slice(open, open + 400))?.[1] ?? 'GET';
      addHttp(b.m, verb, url, lineAt(open));
    }
    // Volley
    for (const m of seg.matchAll(/\b(StringRequest|JsonObjectRequest|JsonArrayRequest|JsonRequest|GsonRequest)\s*(?:<[^>]*>)?\s*\(/g)) {
      const open = b.from + (m.index ?? 0) + m[0].length - 1;
      const first = b.code.slice(open + 1, open + 80);
      const vm = /^\s*(?:Request\s*\.\s*)?Method\s*\.\s*(GET|POST|PUT|DELETE|PATCH)\s*,/.exec(first);
      const url = vm ? argAt(open, 1) : evalAt(open);
      if (url !== undefined) addHttp(b.m, vm?.[1] ?? 'GET', url, lineAt(open));
    }
    // HttpURLConnection: URL("…").openConnection()
    for (const m of seg.matchAll(/\b(?:new\s+)?URL\s*\(/g)) {
      const open = b.from + (m.index ?? 0) + m[0].length - 1;
      const close = findClose(b.code, open);
      if (!/^\s*\)?\s*\.?\s*openConnection|^\)\s*;/.test(b.code.slice(close, close + 40)) && !/openConnection/.test(b.code.slice(close, close + 300))) continue;
      const url = evalAt(open);
      if (url === undefined) continue;
      const verb = /(?:requestMethod\s*=\s*|setRequestMethod\s*\(\s*)"(\w+)"/.exec(b.code.slice(open, Math.min(b.to, open + 600)))?.[1] ?? 'GET';
      addHttp(b.m, verb, url, lineAt(open));
    }
    // Ktor client.get("…")
    for (const m of seg.matchAll(/\b(\w*[cC]lient|http\w*)\s*\.\s*(get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(/g)) {
      const open = b.from + (m.index ?? 0) + m[0].length - 1;
      const url = evalAt(open);
      if (url !== undefined && /^(https?:|\/|\{)/.test(url)) addHttp(b.m, m[2], url, lineAt(open));
    }
    // WebView.loadUrl
    for (const m of seg.matchAll(/\.\s*loadUrl\s*\(/g)) {
      const open = b.from + (m.index ?? 0) + m[0].length - 1;
      const url = evalAt(open);
      if (!url || /^javascript:/i.test(url)) continue;
      const list = webviewRefs.get(b.file) ?? [];
      if (!list.some((x) => x.url === url)) list.push({ url, kind: 'webview', file: b.file, line: lineAt(open) });
      webviewRefs.set(b.file, list);
    }
  }

  // ---------------------------------------------------------------- 화면 클래스 (Activity·Fragment)
  const unitFor = (name: string): CodeUnit | undefined => {
    const fq = unitByFqn.get(name);
    if (fq) return fq;
    const list = unitsByName.get(name.slice(name.lastIndexOf('.') + 1));
    return list?.[0];
  };
  const screenKind = (u: CodeUnit, depth = 0): 'activity' | 'fragment' | null => {
    if (depth > 6) return null;
    for (const s0 of u.extendsOrImplements) {
      const s = s0.replace(/<.*$/, '').split('.').pop()!;
      if (NOT_SCREEN.test(s)) return null;
      const base = unitsByName.get(s)?.find((x) => x !== u);
      if (base) {
        const k = screenKind(base, depth + 1);
        if (k) return k;
        continue;
      }
      if (ACTIVITY_EXT.test(s)) return 'activity';
      if (FRAGMENT_EXT.test(s)) return 'fragment';
    }
    return null;
  };
  const isAbstract = (u: CodeUnit): boolean => {
    const c = kt.classOfUnit.get(u);
    if (c?.cls) return /\b(abstract|sealed)\b/.test(c.cls.mods) || c.cls.kw !== 'class';
    const js = javaSrc.get(u.file);
    return !!js && new RegExp(`\\babstract\\s+(?:\\w+\\s+)*class\\s+${u.name}\\b`).test(js.code);
  };

  // 매니페스트 액티비티 → 라벨
  const manifestAct = new Map<string, { label?: string; launcher: boolean; file: string; line: number; appLabel?: string; appLine?: number }>();
  for (const man of st.manifests) {
    const pkg = man.pkg ?? st.gradle.find((g) => g.dir === man.dir || man.dir.startsWith(`${g.dir}/`) || g.dir.startsWith(man.dir))?.namespace ?? '';
    for (const a of man.activities) {
      const fq = a.name.startsWith('.') ? `${pkg}${a.name}` : a.name.includes('.') ? a.name : `${pkg}.${a.name}`;
      manifestAct.set(fq, { ...(a.label ? { label: a.label } : {}), launcher: a.launcher, file: man.file, line: a.line, ...(man.appLabel ? { appLabel: man.appLabel, appLine: man.appLine } : {}) });
    }
  }
  const actInfo = (u: CodeUnit) => (u.fqn ? manifestAct.get(u.fqn) : undefined) ?? [...manifestAct.entries()].find(([k]) => k.endsWith(`.${u.name}`))?.[1];

  // 내비게이션 그래프 목적지
  const destById = new Map<string, NavDest>();
  const destsByClass = new Map<string, NavDest[]>();
  const allDests: NavDest[] = [];
  const indexDest = (d: NavDest) => {
    if (d.id && !destById.has(d.id)) destById.set(d.id, d);
    allDests.push(d);
    if (d.name) {
      const k = d.name.split('.').pop()!;
      const a = destsByClass.get(k) ?? [];
      a.push(d);
      destsByClass.set(k, a);
    }
    for (const c of d.children) indexDest(c);
  };
  for (const n of st.navs) indexDest(n.root);

  const layoutPaths = (names: string[]): string[] => {
    const out: string[] = [];
    for (const n of names) {
      const list = st.layouts.get(n);
      if (!list?.length) continue;
      const best = list.find((x) => /\/layout\/[^/]+$/.test(x.path)) ?? list[0];
      if (!out.includes(best.path)) out.push(best.path);
    }
    return out;
  };
  const layoutRefs = (code: string, from: number, to: number): string[] => {
    const seg = code.slice(from, to);
    const names: string[] = [];
    for (const m of seg.matchAll(/\bR\s*\.\s*layout\s*\.\s*(\w+)/g)) if (!names.includes(m[1])) names.push(m[1]);
    for (const m of seg.matchAll(/\b([A-Z]\w*)Binding\b/g)) {
      const n = snakeLower(m[1]);
      if (m[1] !== 'View' && m[1] !== 'Data' && st.layouts.has(n) && !names.includes(n)) names.push(n);
    }
    return names;
  };

  interface Screen {
    file: FileInfo;
    unit: CodeUnit;
    entry: MethodUnit;
    kind: 'activity' | 'fragment' | 'compose';
    title?: { value: string; file: string; line: number };
    includes: string[];
    url?: string;
    fn?: KtFun;
  }
  const screens: Screen[] = [];
  const screenByFile = new Map<string, Screen>();
  const unitRange = (u: CodeUnit): { code: string; from: number; to: number } | null => {
    const c = kt.classOfUnit.get(u);
    if (c?.cls?.body) return { code: c.kf.code, from: c.cls.namePos, to: c.cls.body.to };
    if (c && !c.cls) return { code: c.kf.code, from: 0, to: c.kf.code.length };
    const js = javaSrc.get(u.file);
    if (js) {
      const from = js.starts[u.line - 1] ?? 0;
      const last = Math.max(u.line, ...u.methods.map((m) => m.endLine ?? m.line));
      return { code: js.code, from, to: js.starts[last] ?? js.code.length };
    }
    return null;
  };
  const codeTitle = (code: string, from: number, to: number, fileId: string, lineOf: (o: number) => number): Screen['title'] => {
    const seg = code.slice(from, to);
    const pats = [
      /(?:TopAppBar|CenterAlignedTopAppBar|MediumTopAppBar|LargeTopAppBar|SmallTopAppBar)\s*\([\s\S]{0,120}?title\s*=\s*\{\s*Text\s*\(\s*(?:text\s*=\s*)?(?:stringResource\s*\(\s*(?:id\s*=\s*)?R\.string\.(\w+)\s*\)|"([^"$]+)")/,
      /(?:supportActionBar|actionBar|toolbar|binding\.toolbar|binding\.appBar\.toolbar)\s*(?:\?|!!)?\s*\.\s*(?:title\s*=|setTitle\s*\()\s*(?:getString\s*\(\s*R\.string\.(\w+)\s*\)|R\.string\.(\w+)|"([^"$]+)")/,
      /(?:^|[\s;{])(?:requireActivity\(\)\.|activity\??\.)?(?:title\s*=|setTitle\s*\()\s*(?:getString\s*\(\s*R\.string\.(\w+)\s*\)|R\.string\.(\w+)|"([^"$]+)")/m,
    ];
    for (const re of pats) {
      const m = re.exec(seg);
      if (!m) continue;
      const res = m.slice(1).find((x, i) => x !== undefined && (re === pats[0] ? i === 0 : i < 2));
      const lit = m.slice(1).find((x, i) => x !== undefined && !(re === pats[0] ? i === 0 : i < 2));
      if (res) {
        const s = st.strings.get(res);
        if (s) return { value: s.value, file: s.file, line: s.line };
      }
      if (lit) return { value: lit, file: fileId, line: lineOf(from + (m.index ?? 0)) };
    }
    return undefined;
  };
  const layoutTitle = (paths: string[]): Screen['title'] => {
    for (const p of paths) {
      const f = ctx.byPath.get(p);
      const info = f ? st.layoutInfo.get(f.id) : undefined;
      if (!f || !info?.title) continue;
      const ref = strRef(info.title.value);
      if (ref) return ref;
      if (!/^@/.test(info.title.value)) return { value: info.title.value, file: f.id, line: info.title.line };
    }
    return undefined;
  };

  for (const u of units) {
    const f = ctx.byId.get(u.file);
    if (!f || f.layer === 'TEST' || (f.lang !== 'Kotlin' && f.lang !== 'Java')) continue;
    const kind = screenKind(u);
    if (!kind || isAbstract(u) || screenByFile.has(u.file)) continue;
    const order = kind === 'activity' ? ['onCreate'] : ['onViewCreated', 'onCreateView', 'onCreate', 'onCreateDialog'];
    let entry = order.map((n) => u.methods.find((m) => m.name === n)).find(Boolean) ?? u.methods.find((m) => !m.routes.length) ?? undefined;
    if (!entry) {
      entry = newMethod(kind === 'activity' ? 'onCreate' : 'onCreateView', u.line);
      u.methods.push(entry);
    }
    const range = unitRange(u);
    const names = range ? layoutRefs(range.code, range.from, range.to) : [];
    const dests = destsByClass.get(u.name) ?? [];
    for (const d of dests) if (d.layout && !names.includes(d.layout)) names.push(d.layout);
    const includes = layoutPaths(names);
    let title: Screen['title'];
    for (const d of dests) {
      const ref = strRef(d.label);
      if (ref) title = ref;
      else if (d.label && !/^@/.test(d.label)) title = { value: d.label, file: d.file, line: d.line };
      if (title) break;
    }
    const act = kind === 'activity' ? actInfo(u) : undefined;
    if (!title && act?.label) {
      const ref = strRef(act.label);
      title = ref ?? (!/^@/.test(act.label) ? { value: act.label, file: act.file, line: act.line } : undefined);
    }
    if (!title && range) {
      const lineOf = kt.classOfUnit.get(u)?.kf.lineOf ?? javaSrc.get(u.file)?.lineOf ?? (() => u.line);
      title = codeTitle(range.code, range.from, range.to, u.file, lineOf);
    }
    if (!title) title = layoutTitle(includes);
    if (!title && act?.launcher && act.appLabel) {
      const ref = strRef(act.appLabel);
      title = ref ?? (!/^@/.test(act.appLabel) ? { value: act.appLabel, file: act.file, line: act.appLine ?? act.line } : undefined);
    }
    const sc: Screen = { file: f, unit: u, entry, kind, ...(title ? { title } : {}), includes };
    screens.push(sc);
    screenByFile.set(u.file, sc);
  }

  // ---------------------------------------------------------------- Compose 화면 (NavHost 목적지·…Screen 함수)
  const composeRoutes = new Map<string, string>(); // 함수 이름 → 경로
  const sealedRoute = (expr: string): string | undefined => {
    // Screen.Home.route / Home.route → object Home : Screen("home")
    const m = /([A-Z]\w*)\s*\.\s*route\b/.exec(expr);
    if (!m) return undefined;
    for (const kf of kt.files.values()) {
      const find = (list: KtClass[]): string | undefined => {
        for (const c of list) {
          if (c.name === m[1]) {
            const args = c.supers.find((s) => s.args)?.args;
            if (args) return literalsIn(kf.code, args.from, args.to, () => undefined)[0];
          }
          const r = find(c.classes);
          if (r) return r;
        }
        return undefined;
      };
      const r = find(kf.classes);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  for (const kf of kt.files.values()) {
    if (!/\bcomposable\s*[(<]/.test(kf.code)) continue;
    for (const m of kf.skel.matchAll(/\bcomposable\s*(?:<\s*([\w.]+)\s*>)?\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(kf.skel, open);
      const parts = splitTop(kf.skel, open + 1, close);
      let route: string | undefined;
      if (m[1]) route = snakeLower(m[1].split('.').pop()!);
      for (const p of parts) {
        const raw = kf.code.slice(p.from, p.to).trim();
        const named = /^(\w+)\s*=\s*([\s\S]*)$/.exec(raw);
        if (named && named[1] !== 'route') continue;
        const expr = named ? named[2] : raw;
        route = stringExpr(expr, 0, expr.length, constOf(kf.fileId)) ?? sealedRoute(expr) ?? route;
        break;
      }
      // 뒤따르는 람다 { … } 안 첫 화면 함수 호출
      let k = close + 1;
      while (/\s/.test(kf.skel[k] ?? '')) k++;
      let lambdaFrom = k;
      let lambdaTo = k;
      if (kf.skel[k] === '{') lambdaTo = closeOf(kf.skel, k);
      else {
        // content = { … } 인자
        const cp = parts.find((p) => /^\s*content\s*=/.test(kf.skel.slice(p.from, p.to)));
        if (cp) {
          lambdaFrom = cp.from;
          lambdaTo = cp.to;
        }
      }
      const body = kf.skel.slice(lambdaFrom, lambdaTo);
      for (const cm of body.matchAll(/(?<![\w.])([A-Z]\w*)\s*\(/g)) {
        const fnName = cm[1];
        if (/^(Text|Column|Row|Box|Surface|Scaffold|LaunchedEffect|DisposableEffect|CompositionLocalProvider)$/.test(fnName)) continue;
        if (![...kt.files.values()].some((x) => x.funs.some((fn) => fn.name === fnName && fn.anns.some((a) => a.name === 'Composable')))) continue;
        if (route && !composeRoutes.has(fnName)) composeRoutes.set(fnName, route);
        break;
      }
    }
  }
  for (const kf of kt.files.values()) {
    if (!kf.fileUnit || screenByFile.has(kf.fileId)) continue;
    const cands = kf.funs.filter((fn) => fn.method && !fn.receiver && fn.anns.some((a) => a.name === 'Composable') && !fn.anns.some((a) => a.name === 'Preview') && !/Preview$/.test(fn.name)
      && (composeRoutes.has(fn.name) || (/(Screen|Page)$/.test(fn.name) && !/\bprivate\b/.test(fn.mods))));
    if (!cands.length) continue;
    const fn = cands.find((x) => composeRoutes.has(x.name)) ?? cands[0];
    const f = ctx.byId.get(kf.fileId)!;
    const title = codeTitle(kf.code, 0, kf.code.length, kf.fileId, kf.lineOf);
    const route = cands.map((x) => composeRoutes.get(x.name)).find(Boolean);
    const sc: Screen = { file: f, unit: kf.fileUnit, entry: fn.method!, kind: 'compose', ...(title ? { title } : {}), includes: [], ...(route ? { url: `/${route.replace(/^\//, '')}` } : {}), fn };
    screens.push(sc);
    screenByFile.set(kf.fileId, sc);
  }

  // 로컬 DB 도우미(SQLiteOpenHelper·RoomDatabase)·HTTP 호출 클래스는 데이터 접근 계층으로
  for (const u of units) {
    const f = ctx.byId.get(u.file);
    if (!f || (f.lang !== 'Java' && f.lang !== 'Kotlin') || u.kind !== 'other' || screenByFile.has(u.file)) continue;
    if (u.extendsOrImplements.some((s) => /^(SQLiteOpenHelper|RoomDatabase)$/.test(s)) || u.methods.some((m) => m.httpCalls?.length)) {
      u.kind = 'dao';
      if (f.layer === 'OTHER') f.layer = 'DAO';
    }
  }

  // ---------------------------------------------------------------- 웹뷰 화면에 넘기는 주소 (intent.putExtra("url", "…"))
  for (const sc of screens) {
    const name = sc.unit.name;
    if (!webviewRefs.has(sc.file.id) && !/WebView|loadUrl/.test(ctx.facts.texts.get(sc.file.id) ?? '')) continue;
    const add = (fileId: string, code: string, at0: number, lineOf: (o: number) => number) => {
      const win = code.slice(Math.max(0, at0 - 500), at0 + 500);
      for (const pm of win.matchAll(/putExtra\s*\(\s*(?:"\w+"|[\w.]+)\s*,\s*("[^"]*"|[A-Z_][\w.]*)\s*\)/g)) {
        const v = stringExpr(pm[1], 0, pm[1].length, constOf(fileId));
        if (!v || !/^(https?:\/\/|\/)/.test(v)) continue;
        const list = webviewRefs.get(sc.file.id) ?? [];
        if (!list.some((x) => x.url === v)) list.push({ url: v, kind: 'webview', file: fileId, line: lineOf(Math.max(0, at0 - 500) + (pm.index ?? 0)) });
        webviewRefs.set(sc.file.id, list);
      }
    };
    const re = new RegExp(`\\b${name}\\s*(?:::\\s*class\\.java|\\.class)`, 'g');
    for (const kf of kt.files.values()) for (const m of kf.code.matchAll(re)) add(kf.fileId, kf.code, m.index ?? 0, kf.lineOf);
    for (const js of javaSrc.values()) for (const m of js.code.matchAll(re)) add(js.file.id, js.code, m.index ?? 0, js.lineOf);
  }

  // ---------------------------------------------------------------- 화면 사실 남기기
  const viewOfFile = new Map<string, ViewFact>();
  const projectRoot = (path: string) => {
    const man = st.manifests.filter((m) => path.startsWith(`${m.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
    return man?.dir ?? '';
  };
  for (const sc of screens) {
    const u = sc.unit;
    const f = sc.file;
    if (sc.kind !== 'compose') u.kind = 'controller';
    else if (u.kind === 'other') u.kind = 'controller';
    f.layer = 'VIEW';
    if (!sc.entry.views.includes(f.path)) sc.entry.views.push(f.path);
    // 진입 메서드 → 같은 클래스의 다른 메서드(생명주기·클릭 처리), 뷰모델 init
    if (sc.kind !== 'compose') {
      const self = `this.${u.fqn ?? u.name}`;
      for (const m of u.methods) {
        if (m === sc.entry || sc.entry.calls.some((c) => c.method === m.name && (c.via === self || c.via.startsWith('this')))) continue;
        sc.entry.calls.push({ via: self, method: m.name, line: m.line });
      }
    }
    const injected = [...Object.entries(u.fields), ...(sc.fn ? sc.fn.params.map((p) => [p.name, p.type] as [string, string]) : [])];
    for (const [, type] of injected) {
      const tu = type ? unitFor(simpleType(type)) : undefined;
      if (tu && tu !== u && tu.methods.some((m) => m.name === 'init') && !sc.entry.calls.some((c) => c.method === 'init' && c.via === (tu.fqn ?? tu.name))) {
        sc.entry.calls.push({ via: tu.fqn ?? tu.name, method: 'init', line: sc.entry.line });
      }
    }
    const name = sc.title?.value ? cleanLabel(sc.title.value) : undefined;
    const v: ViewFact = {
      file: f.id,
      kind: 'app',
      platform: 'Android',
      group: featureGroup(f.path, projectRoot(f.path)),
      title: name ?? screenNameOf(u.name === `${f.name.replace(/\.kt$/, '')}Kt` ? (sc.fn?.name ?? f.name.replace(/\.kt$/, '')) : u.name),
      ...(name && sc.title ? { titleLine: sc.title.line, titleFile: sc.title.file } : {}),
      urls: webviewRefs.get(f.id) ?? [],
      includes: sc.includes,
      scripts: [],
      ...(sc.url ? { directUrl: sc.url } : {}),
    };
    ctx.facts.views.push(v);
    viewOfFile.set(f.id, v);
  }
  // 레이아웃 XML: 중첩 include를 따라가도록 조각 화면 사실
  for (const [fid, info] of st.layoutInfo) {
    const incs = layoutPaths(info.includes);
    if (!incs.length) continue;
    ctx.facts.views.push({ file: fid, kind: 'app', platform: 'Android', fragment: true, urls: [], includes: incs, scripts: [] });
  }

  // ---------------------------------------------------------------- 메뉴
  const menus: MenuFact[] = [];
  const screenOfDest = (d: NavDest | undefined, depth = 0): Screen | undefined => {
    if (!d || depth > 4) return undefined;
    if (d.kind === 'graph') return screenOfDest(d.children.find((c) => c.id === d.start) ?? d.children[0], depth + 1);
    if (d.kind === 'include' && d.graphRef) {
      const g = st.navs.find((n) => n.name === d.graphRef);
      return g ? screenOfDest(g.root, depth + 1) : undefined;
    }
    if (!d.name) return undefined;
    const u = unitFor(d.name);
    return u ? screenByFile.get(u.file) : undefined;
  };
  const destLabel = (d: NavDest): string | undefined => cleanLabel(str(d.label)) ?? (() => {
    const s = screenOfDest(d);
    return s ? viewOfFile.get(s.file.id)?.title : undefined;
  })();
  // 코드로 메뉴 항목 → 화면 (when (item.itemId) { R.id.nav_home -> HomeFragment() })
  const codeMap = new Map<string, string>();
  const scanCodeMap = (code: string) => {
    for (const m of code.matchAll(/R\s*\.\s*id\s*\.\s*(\w+)\s*(?:->|:|\)\s*\{|\)\s*(?=[\w(]))/g)) {
      const from = (m.index ?? 0) + m[0].length;
      const rest = code.slice(from, from + 400);
      const stop = rest.search(/R\s*\.\s*id\s*\.\s*\w+\s*(?:->|:)/);
      const branch = stop >= 0 ? rest.slice(0, stop) : rest;
      const cm = /\b([A-Z]\w*(?:Fragment|Activity|Screen))\b\s*(?:\(|::\s*class|\.class|\.newInstance)/.exec(branch);
      if (cm && !codeMap.has(m[1])) codeMap.set(m[1], cm[1]);
    }
  };
  for (const kf of kt.files.values()) if (/R\s*\.\s*id\s*\./.test(kf.code)) scanCodeMap(kf.code);
  for (const js of javaSrc.values()) if (/R\s*\.\s*id\s*\./.test(js.code)) scanCodeMap(js.code);

  const used = new Set<NavDest>();
  const addChildren = (d: NavDest | undefined, parentKey: string, depth: number) => {
    if (!d || depth > 3) return;
    let order = 0;
    for (const to of d.actions) {
      const c = destById.get(to);
      if (!c || used.has(c)) continue;
      used.add(c);
      const sc = screenOfDest(c);
      const key = `nav:${c.file}:${c.id}`;
      menus.push({ key, parentKey, name: destLabel(c) ?? c.id, order: order++, source: 'config', evidence: { file: c.file, line: c.line }, ...(sc ? { view: sc.file.id } : {}) });
      addChildren(c, key, depth + 1);
    }
  };
  const navMenuNames = new Set<string>();
  for (const info of st.layoutInfo.values()) for (const n of info.navMenus) navMenuNames.add(n);
  for (const [name, mx] of st.menus) {
    const ids = flatItems(mx.items).map((x) => x.id);
    if (ids.filter((id) => destById.has(id)).length >= 2) navMenuNames.add(name);
    if (ids.filter((id) => codeMap.has(id)).length >= 2) navMenuNames.add(name);
  }
  const navMenuFiles = [...navMenuNames].map((n) => st.menus.get(n)).filter((x): x is NonNullable<typeof x> => !!x);
  // 하단 탭·드로어 메뉴의 목적지는 먼저 표시
  for (const mx of navMenuFiles) for (const it of flatItems(mx.items)) {
    const d = destById.get(it.id);
    if (d) used.add(d);
  }
  for (const mx of navMenuFiles) {
    const walk = (items: MenuItemX[], parentKey: string | undefined) => {
      items.forEach((it, i) => {
        const key = `menu:${mx.file}:${it.id || i}`;
        const d = destById.get(it.id);
        let sc = screenOfDest(d);
        if (!sc && codeMap.has(it.id)) {
          const u = unitFor(codeMap.get(it.id)!);
          sc = u ? screenByFile.get(u.file) : undefined;
        }
        const name = cleanLabel(str(it.title)) ?? (d ? destLabel(d) : undefined) ?? it.id;
        menus.push({ key, ...(parentKey ? { parentKey } : {}), name, order: i, source: 'config', evidence: { file: mx.file, line: it.line }, ...(sc ? { view: sc.file.id } : {}) });
        if (it.children.length) walk(it.children, key);
        else if (d) addChildren(d.kind === 'graph' ? d.children.find((c) => c.id === d.start) ?? d : d, key, 1);
      });
    };
    walk(mx.items, undefined);
  }
  if (!navMenuFiles.length) {
    // 메뉴 XML이 없으면 내비게이션 그래프 구조로 (시작 목적지 → 이동 가능한 화면)
    const included = new Set(allDests.filter((d) => d.graphRef).map((d) => d.graphRef!));
    for (const nav of st.navs) {
      if (included.has(nav.name) && st.navs.length > 1) continue;
      const topLevel = (g: NavDest, parentKey: string | undefined) => {
        const start = g.children.find((c) => c.id === g.start);
        const ordered = start ? [start, ...g.children.filter((c) => c !== start)] : g.children;
        let order = 0;
        for (const d of ordered) {
          if (used.has(d)) continue;
          used.add(d);
          const key = `nav:${d.file}:${d.id || order}`;
          if (d.kind === 'graph') {
            menus.push({ key, ...(parentKey ? { parentKey } : {}), name: cleanLabel(str(d.label)) ?? d.id, order: order++, source: 'config', evidence: { file: d.file, line: d.line } });
            topLevel(d, key);
            continue;
          }
          const sc = screenOfDest(d);
          menus.push({ key, ...(parentKey ? { parentKey } : {}), name: destLabel(d) ?? d.id, order: order++, source: 'config', evidence: { file: d.file, line: d.line }, ...(sc ? { view: sc.file.id } : {}) });
          addChildren(d, key, 1);
        }
      };
      topLevel(nav.root, undefined);
    }
  }
  // Compose 하단 탭 (NavigationBarItem·BottomNavigationItem)
  if (!menus.length) menus.push(...composeMenus(kt.files.values(), constOf, st, screens));
  ctx.facts.menus.push(...menus);

  // ---------------------------------------------------------------- 정리: 빈 프로퍼티 메서드와 그 호출 지우기
  const dropped = new Map<CodeUnit, Set<string>>();
  for (const reg of kt.regions) {
    if (!reg.pseudo) continue;
    const m = reg.m;
    if (m.calls.length || m.sql.length || m.httpCalls?.length || m.views.length) continue;
    const i = reg.unit.methods.indexOf(m);
    if (i >= 0) reg.unit.methods.splice(i, 1);
    const set = dropped.get(reg.unit) ?? new Set();
    set.add(m.name);
    dropped.set(reg.unit, set);
  }
  if (dropped.size) {
    const byVia = new Map<string, Set<string>>();
    for (const [u, names] of dropped) {
      for (const k of [u.fqn ?? u.name, u.name, `this.${u.fqn ?? u.name}`]) byVia.set(k, names);
    }
    for (const u of units) for (const m of u.methods) {
      if (!m.calls.length) continue;
      m.calls = m.calls.filter((c) => !(byVia.get(c.via)?.has(c.method) && !(unitFor(c.via.replace(/^this\./, ''))?.methods.some((x) => x.name === c.method))));
    }
  }

  // ---------------------------------------------------------------- 기술
  if (screens.length) {
    const ev = screens[0].file.id;
    ctx.hit('앱', 'Android', ev, 1, 2);
    if (screens.some((s) => s.kind === 'compose')) ctx.hit('앱', 'Jetpack Compose', screens.find((s) => s.kind === 'compose')!.file.id, 1, 1);
  }
  if (units.some((u) => u.methods.some((m) => m.httpCalls?.length))) {
    const u = units.find((x) => x.methods.some((m) => m.httpCalls?.length))!;
    if (!ctx.facts.tech.some((t) => t.name === 'Retrofit' || t.name === 'OkHttp' || t.name === 'Volley' || t.name === 'Ktor Client')) ctx.hit('앱', 'HTTP 클라이언트', u.file, 1, 1);
  }
  if (ctx.facts.sql.some((s) => /^SQLiteDatabase\./.test(s.text))) ctx.hit('DB', 'SQLite', ctx.facts.sql.find((s) => /^SQLiteDatabase\./.test(s.text))!.file, 1, 2);
}

function flatItems(items: MenuItemX[]): MenuItemX[] {
  return items.flatMap((i) => [i, ...flatItems(i.children)]);
}

function kotlinConst(kt: ReturnType<typeof ktState>, fileId: string, name: string): string | undefined {
  const tryKey = (k: string) => {
    const list = kt.consts.get(k);
    if (!list?.length) return undefined;
    return (list.find((x) => x.file === fileId) ?? list[0]).value;
  };
  return tryKey(name) ?? tryKey(name.split('.').slice(-2).join('.')) ?? tryKey(name.split('.').pop()!);
}

/** 원문(code) 기준 괄호 짝 (문자열 안 괄호는 건너뜀) */
function findClose(code: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (q) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (q === '"""' ? code.startsWith('"""', i) : c === q) {
        if (q === '"""') i += 2;
        q = null;
      }
      continue;
    }
    if (c === '"' && code.startsWith('"""', i)) {
      q = '"""';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** 구조용 텍스트에서 쉼표 단위 인자 위치 */
function splitTop(skel: string, from: number, to: number): Region[] {
  const out: Region[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = skel[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push({ from: start, to: i });
      start = i + 1;
    }
  }
  if (skel.slice(start, to).trim()) out.push({ from: start, to });
  return out;
}

/** 문자열 SQL 식의 끝 (문장 끝 ; 또는 닫는 괄호, 줄 끝에 + 가 없으면) */
function statementEnd(skel: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = skel[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return i;
    else if (c === '\n' && depth === 0) {
      let p = i - 1;
      while (p > from && /[ \t\r]/.test(skel[p])) p--;
      let n = i + 1;
      while (n < to && /\s/.test(skel[n])) n++;
      if (skel[p] === '+' || skel[n] === '+' || skel[n] === '.') continue;
      return i;
    }
  }
  return to;
}

/** Compose 하단 탭: NavigationBarItem(label = { Text("홈") }, onClick = { navController.navigate("home") }) */
function composeMenus(
  files: Iterable<KtFile>, constOf: (f: string) => (n: string) => string | undefined, st: AndroidState,
  screens: { file: FileInfo; url?: string; unit: CodeUnit; fn?: KtFun }[],
): MenuFact[] {
  const out: MenuFact[] = [];
  const byUrl = new Map(screens.filter((s) => s.url).map((s) => [s.url!.replace(/^\//, ''), s] as const));
  let order = 0;
  for (const kf of files) {
    if (!/(NavigationBarItem|BottomNavigationItem|NavigationRailItem|NavigationDrawerItem)\s*\(/.test(kf.code)) continue;
    for (const m of kf.skel.matchAll(/\b(NavigationBarItem|BottomNavigationItem|NavigationRailItem|NavigationDrawerItem)\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(kf.skel, open);
      const seg = kf.code.slice(open, close);
      const lab = /label\s*=\s*\{\s*Text\s*\(\s*(?:text\s*=\s*)?(?:stringResource\s*\(\s*(?:id\s*=\s*)?R\.string\.(\w+)\s*\)|"([^"$]+)")/.exec(seg);
      const name = lab ? (lab[1] ? st.strings.get(lab[1])?.value : lab[2]) : undefined;
      const nav = /navigate\s*\(\s*("[^"]*"|[\w.]+)/.exec(seg);
      let route = nav ? stringExpr(nav[1], 0, nav[1].length, constOf(kf.fileId)) : undefined;
      if (!route && nav) {
        const rm = /([A-Z]\w*)\s*\.\s*route/.exec(nav[1]);
        if (rm) route = rm[1].toLowerCase();
      }
      if (!name) continue;
      const sc = route ? byUrl.get(route.replace(/^\//, '')) : undefined;
      out.push({ key: `compose:${kf.fileId}:${order}`, name, ...(route ? { url: `/${route.replace(/^\//, '')}` } : {}), order: order++, source: 'code', evidence: { file: kf.fileId, line: kf.lineOf(m.index ?? 0) }, ...(sc ? { view: sc.file.id } : {}) });
    }
  }
  return out;
}

