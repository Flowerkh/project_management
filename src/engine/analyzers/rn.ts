// React Native 분석기: package.json에 react-native가 있는 폴더의 JS·TS를 모듈 단위 CodeUnit으로 만들고,
// React Navigation(Stack·Tab·Drawer)·Expo Router 화면, 탭·드로어 메뉴, fetch·axios 호출, SQLite(expo-sqlite 등) SQL, WebView 주소를 찾는다.
// 화면 컴포넌트 함수가 views = [화면 파일 경로]를 가져 link가 화면 → 훅·API 모듈 → (서버 라우트) → 테이블을 따라간다.
import type { Analyzer, Ctx } from '../context';
import type { CodeUnit, FileInfo, MenuFact, MethodUnit, UrlRef } from '../types';
import { dirName, makeLineIndex, normalizePath } from '../files';
import { stripCComments } from './jutil';
import { addHttp, addSqlText, cleanLabel, closeOf, featureGroup, newMethod, screenNameOf, skipAngles, stateOf } from './applib';

interface Region {
  from: number;
  to: number;
}

interface JsFunc {
  name: string;
  pos: number;
  body: Region;
  method: MethodUnit;
}

interface JsModule {
  file: FileInfo;
  path: string;
  code: string;
  skel: string;
  lineOf: (o: number) => number;
  imports: Map<string, { spec: string; name: string }>;
  funcs: Map<string, JsFunc>;
  objects: Map<string, Map<string, JsFunc>>;
  exports: Map<string, string>;
  reexports: { name: string; spec: string; orig: string }[];
  starFrom: string[];
  defaultLocal?: string;
  consts: Map<string, string>;
  instances: Map<string, string>;
  navigators: Map<string, string>;
  unit: CodeUnit;
  root: string;
}

interface RnState {
  files: string[];
  packages: { file: string; dir: string; text: string }[];
  envs: { dir: string; vars: Map<string, string> }[];
  /** tsconfig·jsconfig paths: 폴더 → [별칭 접두어, 대상 접두어] */
  aliases: { dir: string; from: string; to: string }[];
}

const STATE = new WeakMap<object, RnState>();
const rnState = (ctx: Ctx) => stateOf(ctx.facts, STATE, (): RnState => ({ files: [], packages: [], envs: [], aliases: [] }));

/** JS 식의 끝: 같은 깊이의 , ; ) ] } 또는 이어지지 않는 줄바꿈 */
function exprEnd(s: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') {
      i = closeOf(s, i, to) + 1;
      continue;
    }
    if (c === '<' && /[\w$]/.test(s[i - 1] ?? '')) {
      // 제네릭 호출 f<A, B>(…)
      const j = skipAngles(s, i, to);
      if (j > i + 1 && s[j] === '(') {
        i = j;
        continue;
      }
    }
    if (c === ')' || c === ']' || c === '}' || c === ';' || c === ',') return i;
    if (c === '\n') {
      let p = i - 1;
      while (p >= from && (s[p] === ' ' || s[p] === '\t' || s[p] === '\r')) p--;
      let n = i + 1;
      while (n < to && /\s/.test(s[n])) n++;
      if (p < from || /[=+\-*/%&|.(:?<>!]/.test(s[p])) {
        i++;
        continue;
      }
      if (n < to && /^(\.|\?|&&|\|\||[+\-*/]|:|\)|=>)/.test(s.slice(n, n + 2))) {
        i = n;
        continue;
      }
      return i;
    }
    i++;
  }
  return to;
}

/** JS 문자열·템플릿 내용을 가린 구조용 텍스트 */
function jsSkeleton(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === '\\') j++;
        else if (code[j] === '\n' && c !== '`') break;
        j++;
      }
      out += c + code.slice(i + 1, j).replace(/[^\n]/g, '_') + (j < n ? code[j] : '');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** JS 문자열 식 → 값 ('a' + B + `c${d}`), 맨 앞 모르는 값은 기준 주소로 보고 버림 */
function jsStringExpr(code: string, from: number, to: number, resolve: (n: string) => string | undefined): string | undefined {
  let out = '';
  let known = false;
  let first = true;
  let i = from;
  while (i < to) {
    const c = code[i];
    if (/\s/.test(c) || c === '+' || c === '(' || c === ')') {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let raw = '';
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') {
          raw += code[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === '`' && code[j] === '$' && code[j + 1] === '{') {
          const e = code.indexOf('}', j);
          const ex = code.slice(j + 2, e < 0 ? j + 2 : e).trim();
          const v = /^[\w$.]+$/.test(ex) ? resolve(ex) : undefined;
          raw += v ?? (raw === '' && first ? '' : '{p}');
          if (v !== undefined) known = true;
          j = e < 0 ? j + 2 : e + 1;
          continue;
        }
        raw += code[j];
        j++;
      }
      out += raw;
      known = true;
      first = false;
      i = j + 1;
      continue;
    }
    const im = /^[A-Za-z_$][\w$.]*/.exec(code.slice(i, i + 200));
    if (im) {
      const v = resolve(im[0]);
      let j = i + im[0].length;
      if (code[j] === '(') j = closeOf(code, j, to) + 1;
      if (v !== undefined) {
        out += v;
        known = true;
      } else if (!first) out += '{p}';
      first = false;
      i = j;
      continue;
    }
    break;
  }
  return known ? out : undefined;
}

const EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.native.tsx', '.native.ts', '.native.js', '.android.tsx', '.android.ts', '.android.js'];

function resolveSpec(ctx: Ctx, fromPath: string, spec: string, root: string, aliases: RnState['aliases'] = []): string | undefined {
  let base: string[] = [];
  const al = aliases.filter((a) => (a.dir === root || root.startsWith(`${a.dir}/`) || a.dir === '') && spec.startsWith(a.from)).sort((a, b) => b.from.length - a.from.length)[0];
  if (al) base = [normalizePath(`${al.dir}/${al.to}${spec.slice(al.from.length)}`)];
  else if (spec.startsWith('.')) base = [normalizePath(`${dirName(fromPath)}/${spec}`)];
  else if (/^[@~]\//.test(spec)) base = [`${root}/src/${spec.slice(2)}`, `${root}/${spec.slice(2)}`];
  else if (/^(src|app|screens|components|api|services)\//.test(spec)) base = [`${root}/${spec}`];
  else return undefined;
  for (const b of base) {
    if (ctx.byPath.has(b) && /\.(tsx?|jsx?|mjs)$/.test(b)) return b;
    for (const e of EXT) if (ctx.byPath.has(`${b}${e}`)) return `${b}${e}`;
    for (const e of EXT) if (ctx.byPath.has(`${b}/index${e}`)) return `${b}/index${e}`;
  }
  return undefined;
}

// ------------------------------------------------------------------ 모듈 파서

function parseModule(ctx: Ctx, f: FileInfo, text: string, root: string): JsModule {
  const code = stripCComments(text);
  const skel = jsSkeleton(code);
  const lineOf = makeLineIndex(text);
  const name = f.name.replace(/\.(tsx?|jsx?|mjs)$/, '').replace(/\.(native|android)$/, '');
  const modName = name === 'index' || name === '_layout' ? `${dirName(f.path).split('/').pop()}/${name}` : name;
  const unit = ctx.addUnit({ file: f.id, name: modName, fqn: f.path.replace(/\.(tsx?|jsx?|mjs)$/, ''), kind: 'other', line: 1, extendsOrImplements: [], fields: {}, methods: [] });
  const mod: JsModule = {
    file: f, path: f.path, code, skel, lineOf, imports: new Map(), funcs: new Map(), objects: new Map(), exports: new Map(), reexports: [], starFrom: [],
    consts: new Map(), instances: new Map(), navigators: new Map(), unit, root,
  };
  // import
  for (const m of code.matchAll(/^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1];
    const spec = m[2];
    const def = /^([A-Za-z_$][\w$]*)/.exec(clause);
    if (def && def[1] !== 'type') mod.imports.set(def[1], { spec, name: 'default' });
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) mod.imports.set(ns[1], { spec, name: '*' });
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (named) for (const part of named[1].split(',')) {
      const pm = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (pm) mod.imports.set(pm[2] ?? pm[1], { spec, name: pm[1] });
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]*)\}|([\w$]+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[2]) mod.imports.set(m[2], { spec: m[3], name: 'default' });
    else for (const part of (m[1] ?? '').split(',')) {
      const pm = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part);
      if (pm) mod.imports.set(pm[2] ?? pm[1], { spec: m[3], name: pm[1] });
    }
  }
  // 재내보내기
  for (const m of code.matchAll(/^\s*export\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    for (const part of m[1].split(',')) {
      const pm = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (pm) mod.reexports.push({ name: pm[2] ?? pm[1], spec: m[2], orig: pm[1] });
    }
  }
  for (const m of code.matchAll(/^\s*export\s+\*\s+from\s*['"]([^'"]+)['"]/gm)) mod.starFrom.push(m[1]);
  for (const m of code.matchAll(/^\s*export\s+\{([^}]*)\}\s*;?\s*$/gm)) {
    for (const part of m[1].split(',')) {
      const pm = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (pm) {
        if ((pm[2] ?? '') === 'default') mod.defaultLocal = pm[1];
        else mod.exports.set(pm[2] ?? pm[1], pm[1]);
      }
    }
  }
  const dm = /^\s*export\s+default\s+(?:React\.memo\(|memo\(|connect\([^)]*\)\()?\s*([A-Za-z_$][\w$]*)\s*\)?\s*;?\s*$/m.exec(code);
  if (dm && !/^(function|class|async)$/.test(dm[1])) mod.defaultLocal = dm[1];
  const me = /\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/.exec(code);
  if (me) mod.defaultLocal = me[1];

  // 최상위 선언
  const addFunc = (fname: string, pos: number, body: Region, obj?: string) => {
    const mname = obj && obj !== '__default' ? `${obj}.${fname}` : fname;
    const m = newMethod(mname, lineOf(pos), lineOf(body.to));
    unit.methods.push(m);
    const fn: JsFunc = { name: mname, pos, body, method: m };
    if (obj) {
      const o = mod.objects.get(obj) ?? new Map<string, JsFunc>();
      o.set(fname, fn);
      mod.objects.set(obj, o);
    } else mod.funcs.set(fname, fn);
    return fn;
  };
  const bodyAfter = (i: number): Region | null => {
    // i: 화살표 => 뒤 또는 { 위치
    let k = i;
    while (/\s/.test(skel[k] ?? '')) k++;
    if (skel[k] === '{') return { from: k + 1, to: closeOf(skel, k) };
    return { from: k, to: exprEnd(skel, k, skel.length) };
  };
  const parseObject = (open: number, obj: string) => {
    const close = closeOf(skel, open);
    let i = open + 1;
    while (i < close) {
      const c = skel[i];
      if (c === '(' || c === '[' || c === '{') {
        i = closeOf(skel, i, close) + 1;
        continue;
      }
      const km = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:(\()|:\s*(?:async\s*)?(?:function\s*\*?\s*\w*\s*\(|(\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>))/.exec(skel.slice(i, Math.min(close, i + 300)));
      if (km && (i === open + 1 || /[,{\s]/.test(skel[i - 1]))) {
        const key = km[1];
        let p = i + km[0].length;
        if (km[2]) {
          // key(args) { … }
          const pc = closeOf(skel, p - 1, close);
          let k = pc + 1;
          while (/[\s:]/.test(skel[k] ?? '') || /[\w<>[\]|]/.test(skel[k] ?? '')) {
            if (skel[k] === '{') break;
            k++;
          }
          if (skel[k] === '{') {
            const e = closeOf(skel, k, close);
            addFunc(key, i, { from: k + 1, to: e }, obj);
            i = e + 1;
            continue;
          }
        } else {
          if (/function\s*\*?\s*\w*\s*\($/.test(km[0])) {
            const pc = closeOf(skel, p - 1, close);
            p = pc + 1;
          }
          const b = bodyAfter(p);
          if (b) {
            addFunc(key, i, b, obj);
            i = Math.max(b.to + 1, i + 1);
            continue;
          }
        }
      }
      i++;
    }
  };
  let i = 0;
  const n = skel.length;
  while (i < n) {
    const c = skel[i];
    if (c === '(' || c === '[' || c === '{') {
      i = closeOf(skel, i) + 1;
      continue;
    }
    if (!/[A-Za-z_$]/.test(c) || (i > 0 && /[\w$.]/.test(skel[i - 1]))) {
      i++;
      continue;
    }
    const head = skel.slice(i, i + 400);
    let m = /^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(<[^>(]*>)?\s*\(/.exec(head);
    if (m) {
      const open = i + m[0].length - 1;
      const pc = closeOf(skel, open);
      let k = pc + 1;
      // 반환 타입 표기
      while (k < n && skel[k] !== '{' && skel[k] !== ';' && skel[k] !== '\n' && k < pc + 200) k++;
      if (skel[k] === '{') {
        const e = closeOf(skel, k);
        const fname = m[4] ?? 'default';
        addFunc(fname, i, { from: k + 1, to: e });
        if (m[1] && m[2]) mod.defaultLocal = fname;
        else if (m[1]) mod.exports.set(fname, fname);
        i = e + 1;
        continue;
      }
    }
    m = /^(export\s+)?(default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^{]*\{/.exec(head);
    if (m) {
      const open = i + m[0].length - 1;
      const close = closeOf(skel, open);
      // 클래스 메서드: name(args) { … } / name = (args) => …
      const cls = m[3];
      const before = new Set(mod.funcs.values());
      let k = open + 1;
      while (k < close) {
        const ch = skel[k];
        if (ch === '{' || ch === '(' || ch === '[') {
          k = closeOf(skel, k, close) + 1;
          continue;
        }
        const mm = /^\s*(?:static\s+|async\s+|public\s+|private\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:(\()|=\s*(?:async\s*)?(\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>)/.exec(skel.slice(k, Math.min(close, k + 300)));
        if (mm && /[\s;{}]/.test(skel[k - 1] ?? ' ') && !/^(if|for|while|switch|return|constructor)$/.test(mm[1])) {
          if (mm[2]) {
            const pc = closeOf(skel, k + mm[0].length - 1, close);
            let q = pc + 1;
            while (q < close && skel[q] !== '{' && skel[q] !== ';' && q < pc + 120) q++;
            if (skel[q] === '{') {
              const e = closeOf(skel, q, close);
              addFunc(mm[1], k, { from: q + 1, to: e });
              k = e + 1;
              continue;
            }
          } else {
            const b = bodyAfter(k + mm[0].length);
            if (b) {
              addFunc(mm[1], k, b);
              k = Math.max(b.to + 1, k + 1);
              continue;
            }
          }
        }
        k++;
      }
      if (m[1] && m[2]) mod.defaultLocal = cls;
      else if (m[1]) mod.exports.set(cls, cls);
      // 클래스 컴포넌트의 진입: render (없으면 첫 메서드)
      const own = [...mod.funcs.values()].filter((x) => !before.has(x) && x.body.from > open && x.body.to <= close);
      const entry = own.find((x) => x.name === 'render') ?? own[0];
      if (entry) mod.funcs.set(cls, entry);
      i = close + 1;
      continue;
    }
    m = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=\s*/.exec(head);
    if (m) {
      const vname = m[2];
      if (m[1]) mod.exports.set(vname, vname);
      let k = i + m[0].length;
      const rest = skel.slice(k, k + 300);
      const wrap = /^(?:React\.)?(?:memo|forwardRef|observer|withNavigation)\s*(?:<[^>]*>)?\s*\(\s*/.exec(rest);
      if (wrap) k += wrap[0].length;
      const rest2 = skel.slice(k, k + 300);
      const arrow = /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=>/.exec(rest2) ?? /^(async\s*)?(\((?:[^()]|\([^()]*\))*\))\s*(?::\s*[^=]+?)?\s*=>/.exec(rest2);
      const fnExpr = /^(async\s+)?function\s*\*?\s*[\w$]*\s*\(/.exec(rest2);
      if (arrow) {
        const b = bodyAfter(k + arrow[0].length);
        if (b) {
          addFunc(vname, i, b);
          i = Math.max(b.to + 1, i + 1);
          continue;
        }
      } else if (fnExpr) {
        const pc = closeOf(skel, k + fnExpr[0].length - 1);
        let q = pc + 1;
        while (q < n && skel[q] !== '{' && q < pc + 120) q++;
        if (skel[q] === '{') {
          const e = closeOf(skel, q);
          addFunc(vname, i, { from: q + 1, to: e });
          i = e + 1;
          continue;
        }
      } else if (rest2.startsWith('{')) {
        parseObject(k, vname);
        i = closeOf(skel, k) + 1;
        continue;
      } else {
        const end = exprEnd(skel, k, n);
        const init = code.slice(k, end);
        if (/^\s*axios\s*\.\s*create\s*\(/.test(init)) {
          const bu = /baseURL\s*:\s*([^,}\n]+)/.exec(init);
          mod.instances.set(vname, bu ? bu[1].trim() : '');
        } else if (/^\s*create(\w*)Navigator\s*(?:<[^>]*>)?\s*\(/.test(init)) {
          mod.navigators.set(vname, /^\s*create(\w*)Navigator/.exec(init)![1]);
        } else if (/^\s*['"`]/.test(init)) {
          const v = jsStringExpr(code, k, end, (x) => mod.consts.get(x));
          if (v !== undefined && !v.includes('{p}')) mod.consts.set(vname, v);
        } else if (/=>|\bfunction\b/.test(init) && /^\s*[\w$.]+\s*(?:<[\s\S]*?>)?\s*\(/.test(init)) {
          // createQuery({ fetcher: () => client.get(…) }) 같은 감싼 함수: 초기화식 전체를 함수로
          addFunc(vname, i, { from: k, to: end });
        }
        i = Math.max(end, i + 1);
        continue;
      }
    }
    m = /^export\s+default\s+\{/.exec(head);
    if (m) {
      const open = i + m[0].length - 1;
      parseObject(open, '__default');
      mod.defaultLocal = '__default';
      i = closeOf(skel, open) + 1;
      continue;
    }
    m = /^export\s+default\s+(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(head);
    if (m) {
      const b = bodyAfter(i + m[0].length);
      if (b) {
        addFunc('default', i, b);
        mod.defaultLocal = 'default';
        i = Math.max(b.to + 1, i + 1);
        continue;
      }
    }
    const w = /^[A-Za-z_$][\w$]*/.exec(head)?.[0] ?? '';
    i += Math.max(1, w.length);
  }
  return mod;
}

// ------------------------------------------------------------------ 분석기

export const rnAnalyzer: Analyzer = {
  name: 'react-native',
  order: 36,
  accepts(f, text) {
    if (f.layer === 'TEST') return false;
    if (f.name === 'package.json') return /"(react-native|expo)"\s*:/.test(text);
    if (/^(tsconfig|jsconfig)(\.\w+)?\.json$/.test(f.name)) return /"paths"\s*:/.test(text);
    if (/^\.env(\.|$)/.test(f.name)) return true;
    return (f.lang === 'JavaScript' || f.lang === 'TypeScript') && !/\.d\.ts$/.test(f.name) && !/(^|\/)(android|ios|web-build|\.expo)\//.test(f.path);
  },
  analyze(f, text, ctx) {
    const st = rnState(ctx);
    if (f.name === 'package.json') {
      st.packages.push({ file: f.id, dir: f.path.slice(0, -'/package.json'.length), text });
      return;
    }
    if (/^(tsconfig|jsconfig)/.test(f.name)) {
      // "paths": { "@/*": ["./app/*"] }
      const dir = f.path.slice(0, -f.name.length - 1);
      const base = /"baseUrl"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? '.';
      const pm = /"paths"\s*:\s*\{([\s\S]*?)\}/.exec(text);
      if (pm) for (const m of pm[1].matchAll(/"([^"]+)"\s*:\s*\[\s*"([^"]+)"/g)) {
        const from = m[1].replace(/\*$/, '');
        const to = normalizePath(`${base}/${m[2].replace(/\*$/, '')}`) + (m[2].endsWith('/*') ? '/' : '');
        if (from) st.aliases.push({ dir, from, to });
      }
      return;
    }
    if (/^\.env/.test(f.name)) {
      const vars = new Map<string, string>();
      for (const m of text.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'\n#]*)["']?/gm)) vars.set(m[1], m[2].trim());
      st.envs.push({ dir: f.path.slice(0, -f.name.length - 1), vars });
      return;
    }
    if (text.length > 800_000) return;
    st.files.push(f.id);
  },
  finish(ctx) {
    finishRn(ctx);
  },
};

interface NavScreen {
  name: string;
  comp?: string;
  title?: string;
  label?: string;
  pos: number;
  hidden?: boolean;
}

interface NavComp {
  mod: JsModule;
  func?: string;
  type: string;
  screens: NavScreen[];
}

function finishRn(ctx: Ctx): void {
  const st = rnState(ctx);
  const roots = st.packages.filter((p) => /"react-native"\s*:/.test(p.text) || /"expo"\s*:/.test(p.text)).map((p) => ({ ...p, router: /"expo-router"\s*:/.test(p.text) }));
  if (!roots.length) return;
  roots.sort((a, b) => b.dir.length - a.dir.length);
  const rootOf = (path: string) => roots.find((r) => r.dir === '' || path.startsWith(`${r.dir}/`));

  // 기술
  for (const r of roots) {
    const lineOf = makeLineIndex(r.text);
    const hit = (re: RegExp, layer: '앱' | '데이터 접근' | 'DB', name: string, w: number) => {
      const m = re.exec(r.text);
      if (m) ctx.hit(layer, name, r.file, lineOf(m.index), w);
    };
    hit(/"@react-navigation\/[\w-]+"\s*:/, '앱', 'React Navigation', 2);
    hit(/"expo-router"\s*:/, '앱', 'Expo Router', 2);
    hit(/"expo"\s*:/, '앱', 'Expo', 1);
    hit(/"axios"\s*:/, '앱', 'axios', 1);
    const lib = /"(expo-sqlite|react-native-sqlite-storage|react-native-sqlite-2|@op-engineering\/op-sqlite|react-native-quick-sqlite)"\s*:/.exec(r.text);
    if (lib) ctx.hit('데이터 접근', lib[1], r.file, lineOf(lib.index), 2);
    hit(/"(expo-sqlite|react-native-sqlite-storage|react-native-sqlite-2|@op-engineering\/op-sqlite|react-native-quick-sqlite)"\s*:/, 'DB', 'SQLite', 2);
    hit(/"@nozbe\/watermelondb"\s*:/, '데이터 접근', 'WatermelonDB', 2);
    hit(/"react-native-webview"\s*:/, '앱', 'WebView', 1);
    if (/"react-native"\s*:/.test(r.text) || /"expo"\s*:/.test(r.text)) ctx.hit('앱', 'React Native', r.file, 1, 1);
  }

  dropHostAndroid(ctx, roots.map((r) => r.dir));

  // 모듈
  const mods = new Map<string, JsModule>();
  for (const id of st.files) {
    const f = ctx.byId.get(id);
    const text = ctx.facts.texts.get(id);
    if (!f || text === undefined) continue;
    const root = rootOf(f.path);
    if (!root) continue;
    mods.set(f.path, parseModule(ctx, f, text, root.dir));
  }
  if (!mods.size) return;
  // script 분석기가 남긴 조각 화면 사실은 지움 (RN 파일은 이 분석기가 화면·호출을 만든다)
  const rnFiles = new Set([...mods.values()].map((m) => m.file.id));
  for (let k = ctx.facts.views.length - 1; k >= 0; k--) {
    const v = ctx.facts.views[k];
    if (rnFiles.has(v.file) && v.fragment && v.kind === 'other') ctx.facts.views.splice(k, 1);
  }

  const modOf = (from: JsModule, spec: string) => {
    const p = resolveSpec(ctx, from.path, spec, from.root, st.aliases);
    return p ? mods.get(p) : undefined;
  };
  type Target = { mod: JsModule; local: string };
  /** 가져온 이름 → 실제 정의 모듈·지역 이름 (index 재내보내기 따라감) */
  const resolveExport = (mod: JsModule, name: string, depth = 0): Target | undefined => {
    if (depth > 4) return undefined;
    if (name === 'default') {
      if (mod.defaultLocal) {
        const imp = mod.imports.get(mod.defaultLocal);
        if (imp && !mod.funcs.has(mod.defaultLocal)) {
          const t = modOf(mod, imp.spec);
          return t ? resolveExport(t, imp.name, depth + 1) : undefined;
        }
        return { mod, local: mod.defaultLocal };
      }
      // export { FeedScreen as default } from './feed-screen'
      const re = mod.reexports.find((r) => r.name === 'default');
      const t = re ? modOf(mod, re.spec) : undefined;
      return t && re ? resolveExport(t, re.orig, depth + 1) : undefined;
    }
    const local = mod.exports.get(name);
    if (local) {
      const imp = mod.imports.get(local);
      if (imp && !mod.funcs.has(local) && !mod.objects.has(local)) {
        const t = modOf(mod, imp.spec);
        return t ? resolveExport(t, imp.name, depth + 1) : undefined;
      }
      return { mod, local };
    }
    for (const r of mod.reexports) {
      if (r.name !== name) continue;
      const t = modOf(mod, r.spec);
      if (t) return resolveExport(t, r.orig, depth + 1);
    }
    for (const s of mod.starFrom) {
      const t = modOf(mod, s);
      const hit = t ? resolveExport(t, name, depth + 1) : undefined;
      if (hit) return hit;
    }
    if (mod.funcs.has(name) || mod.objects.has(name) || mod.instances.has(name) || mod.consts.has(name)) return { mod, local: name };
    return undefined;
  };
  const bindingOf = (mod: JsModule, local: string): Target | undefined => {
    if (mod.funcs.has(local) || mod.objects.has(local) || mod.instances.has(local) || mod.consts.has(local) || mod.navigators.has(local)) return { mod, local };
    const imp = mod.imports.get(local);
    if (!imp) return undefined;
    const t = modOf(mod, imp.spec);
    if (!t) return undefined;
    if (imp.name === '*') return { mod: t, local: '*' };
    return resolveExport(t, imp.name);
  };
  const envFor = (mod: JsModule) => st.envs.filter((e) => mod.path.startsWith(`${e.dir}/`) || e.dir === '').sort((a, b) => b.dir.length - a.dir.length);
  const resolverOf = (mod: JsModule) => (name: string): string | undefined => {
    const env = /^(?:Config|process\.env|Constants\.expoConfig\.extra|env)\.(\w+)$/.exec(name);
    if (env) for (const e of envFor(mod)) if (e.vars.has(env[1])) return e.vars.get(env[1]);
    const [head, ...rest] = name.split('.');
    const b = bindingOf(mod, head);
    if (!b) return undefined;
    if (!rest.length) return b.mod.consts.get(b.local);
    if (b.local === '*') return b.mod.consts.get(rest[0]);
    return undefined;
  };

  // ---------------------------------------------------------------- 함수 몸체: 호출·HTTP·SQL·웹뷰
  const webviews = new Map<string, UrlRef[]>();
  for (const mod of mods.values()) {
    const resolve = resolverOf(mod);
    const all: JsFunc[] = [...mod.funcs.values(), ...[...mod.objects.values()].flatMap((o) => [...o.values()])];
    const funcNames = new Set(mod.funcs.keys());
    for (const fn of new Set(all)) {
      const { body, method: m } = fn;
      const seg = mod.skel.slice(body.from, body.to);
      const seen = new Set<string>();
      const call = (via: string, method: string, pos: number) => {
        const key = `${via}#${method}`;
        if (seen.has(key) || (via === mod.unit.fqn && method === m.name)) return;
        seen.add(key);
        m.calls.push({ via, method, line: mod.lineOf(pos) });
      };
      const http = (verb: string, base: string, urlExprFrom: number, urlExprTo: number, pos: number) => {
        const u = jsStringExpr(mod.code, urlExprFrom, urlExprTo, resolve);
        if (u === undefined) return;
        const full = base && !/^[a-z]+:\/\//i.test(u) ? `${base.replace(/\/+$/, '')}/${u.replace(/^\/+/, '')}` : u;
        addHttp(m, verb, full, mod.lineOf(pos));
      };
      const firstArg = (open: number): Region => {
        const close = closeOf(mod.skel, open);
        let depth = 0;
        for (let k = open + 1; k < close; k++) {
          const ch = mod.skel[k];
          if (ch === '(' || ch === '[' || ch === '{') depth++;
          else if (ch === ')' || ch === ']' || ch === '}') depth--;
          else if (ch === ',' && depth === 0) return { from: open + 1, to: k };
        }
        return { from: open + 1, to: close };
      };
      for (const cm of seg.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*(?:<[^<>()]*>)?\s*\(/g)) {
        const a = cm[1];
        const b = cm[2];
        const pos = body.from + (cm.index ?? 0);
        const open = pos + cm[0].length - 1;
        if (/^(if|for|while|switch|return|catch|function|typeof|await|new|super|import|require)$/.test(a)) continue;
        // fetch / axios
        if (!b && a === 'fetch') {
          const arg = firstArg(open);
          const close = closeOf(mod.skel, open);
          const opts = mod.code.slice(arg.to, close);
          const verb = /method\s*:\s*['"`](\w+)['"`]/.exec(opts)?.[1] ?? 'GET';
          http(verb, '', arg.from, arg.to, pos);
          continue;
        }
        const inst = a === 'axios' ? undefined : bindingOf(mod, a);
        if (a === 'axios' || (inst && inst.local !== '*' && inst.mod.instances.has(inst.local))) {
          const t = a === 'axios' ? undefined : bindingOf(mod, a);
          const raw = t ? t.mod.instances.get(t.local) ?? '' : '';
          const base = raw ? jsStringExpr(raw, 0, raw.length, resolverOf(t!.mod)) ?? '' : '';
          const verb = (b ?? '').toLowerCase();
          if (b && /^(get|post|put|delete|patch|head)$/.test(verb)) {
            const arg = firstArg(open);
            http(verb, base, arg.from, arg.to, pos);
            continue;
          }
          if (!b || verb === 'request') {
            const close = closeOf(mod.skel, open);
            const conf = mod.code.slice(open + 1, close);
            const um = /\burl\s*:\s*/.exec(conf);
            if (um) {
              const from = open + 1 + um.index + um[0].length;
              const end = from + (/[,}\n]/.exec(mod.code.slice(from, close))?.index ?? close - from);
              const verb2 = /method\s*:\s*['"`](\w+)['"`]/.exec(conf)?.[1] ?? 'GET';
              http(verb2, base, from, end, pos);
            } else if (!b) {
              const arg = firstArg(open);
              http('GET', base, arg.from, arg.to, pos);
            }
            continue;
          }
          continue;
        }
        if (a === 'this' && b) {
          if (mod.funcs.has(b)) call(mod.unit.fqn!, b, pos);
          continue;
        }
        const t = bindingOf(mod, a);
        if (!t) continue;
        if (!b) {
          if (t.mod === mod && funcNames.has(t.local)) call(mod.unit.fqn!, t.local, pos);
          else if (t.mod !== mod && t.mod.funcs.has(t.local)) call(t.mod.unit.fqn!, t.mod.funcs.get(t.local)!.name, pos);
          continue;
        }
        if (t.local === '*') {
          const r = resolveExport(t.mod, b);
          if (r?.mod.funcs.has(r.local)) call(r.mod.unit.fqn!, r.mod.funcs.get(r.local)!.name, pos);
          continue;
        }
        const obj = t.mod.objects.get(t.local);
        if (obj?.has(b)) call(t.mod.unit.fqn!, obj.get(b)!.name, pos);
      }
      // JSX 컴포넌트 사용 <OrderItem …/>, 함수 참조(onPress={submit}, queryFn: getOrders)
      for (const jm of seg.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) {
        const t = bindingOf(mod, jm[1]);
        if (t && t.mod.funcs.has(t.local)) call(t.mod.unit.fqn!, t.mod.funcs.get(t.local)!.name, body.from + (jm.index ?? 0));
      }
      for (const rm of seg.matchAll(/(?<![\w$.<])([A-Za-z_$][\w$]*)(?=\s*[,)}\]]|\s*$)/gm)) {
        const t = bindingOf(mod, rm[1]);
        if (!t || !t.mod.funcs.has(t.local)) continue;
        if (t.mod === mod && rm[1] === fn.name) continue;
        call(t.mod.unit.fqn!, t.mod.funcs.get(t.local)!.name, body.from + (rm.index ?? 0));
      }
      // SQL 문자열 (executeSql·runAsync·getAllAsync·execAsync 등): 리터럴이 SQL처럼 보이면
      for (const sm of seg.matchAll(/(['"`])/g)) {
        const at0 = body.from + (sm.index ?? 0);
        const lit = mod.code.slice(at0, at0 + 40);
        if (!/^['"`]\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|WITH|REPLACE)\b/i.test(lit)) continue;
        const close = argEnd(mod.skel, findLiteralEnd(mod.code, at0) + 1, body.to);
        const sql = jsStringExpr(mod.code, at0, close, resolve);
        if (sql) addSqlText(ctx, mod.file.id, mod.lineOf(at0), m, sql.replace(/\{p\}/g, '?'));
      }
      // WebView source={{ uri: '…' }}
      for (const wm of mod.code.slice(body.from, body.to).matchAll(/<WebView[\s\S]{0,300}?\buri\s*:\s*/g)) {
        const from = body.from + (wm.index ?? 0) + wm[0].length;
        const end = from + (/[,}\n]/.exec(mod.code.slice(from, from + 300))?.index ?? 0);
        const u = jsStringExpr(mod.code, from, end, resolve);
        if (!u) continue;
        const list = webviews.get(mod.file.id) ?? [];
        if (!list.some((x) => x.url === u)) list.push({ url: u, kind: 'webview', file: mod.file.id, line: mod.lineOf(from) });
        webviews.set(mod.file.id, list);
      }
    }
  }

  // ---------------------------------------------------------------- 내비게이터·화면
  const navComps: NavComp[] = [];
  for (const mod of mods.values()) {
    for (const m of mod.skel.matchAll(/<([A-Za-z_$][\w$]*)\.Navigator\b/g)) {
      const nav = m[1];
      const b = bindingOf(mod, nav);
      const type = b ? b.mod.navigators.get(b.local) ?? '' : /tab/i.test(nav) ? 'BottomTab' : /drawer/i.test(nav) ? 'Drawer' : 'Stack';
      const pos = m.index ?? 0;
      const func = [...mod.funcs.values()].find((f) => f.body.from <= pos && pos <= f.body.to);
      const screens: NavScreen[] = [];
      const re = new RegExp(`<${nav}\\.Screen\\b`, 'g');
      for (const sm of mod.skel.matchAll(re)) {
        const at0 = sm.index ?? 0;
        if (func && (at0 < func.body.from || at0 > func.body.to)) continue;
        const end = jsxTagEnd(mod.skel, at0 + sm[0].length);
        const tag = mod.code.slice(at0, end + 1);
        const name = /\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*['"`]([^'"`]+)['"`]\s*\})/.exec(tag);
        const comp = /\bcomponent\s*=\s*\{\s*([\w$.]+)\s*\}/.exec(tag)?.[1] ?? /\bgetComponent\s*=\s*\{\s*\(\)\s*=>\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(tag)?.[1];
        let child: string | undefined;
        if (!comp && !/\/>\s*$/.test(tag)) {
          const close = mod.code.indexOf(`</${nav}.Screen>`, end);
          const inner = mod.code.slice(end, close < 0 ? end + 400 : close);
          child = /<([A-Z][\w$]*)/.exec(inner)?.[1];
        }
        const opt = (k: string) => new RegExp(`\\b${k}\\s*:\\s*(['"\`])([^'"\`]+)\\1`).exec(tag)?.[2];
        screens.push({
          name: name ? name[1] ?? name[2] ?? name[3] : comp ?? child ?? `screen${screens.length + 1}`,
          ...(comp ?? child ? { comp: comp ?? child } : {}),
          ...(opt('title') ?? opt('headerTitle') ? { title: opt('title') ?? opt('headerTitle') } : {}),
          ...(opt('tabBarLabel') ?? opt('drawerLabel') ? { label: opt('tabBarLabel') ?? opt('drawerLabel') } : {}),
          ...(/href\s*:\s*null/.test(tag) ? { hidden: true } : {}),
          pos: at0,
        });
      }
      navComps.push({ mod, ...(func ? { func: func.name } : {}), type, screens });
    }
    // 정적 API: createBottomTabNavigator({ screens: { Home: HomeScreen, Orders: { screen: OrdersScreen, options: { title: '주문' } } } })
    for (const m of mod.skel.matchAll(/\bcreate(\w*)Navigator\s*(?:<[^>]*>)?\s*\(\s*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(mod.skel, open);
      const conf = mod.code.slice(open, close);
      const sm = /\bscreens\s*:\s*\{/.exec(conf);
      if (!sm) continue;
      const so = open + sm.index + sm[0].length - 1;
      const sc = closeOf(mod.skel, so);
      const screens: NavScreen[] = [];
      let k = so + 1;
      while (k < sc) {
        const em = /^\s*([A-Za-z_$][\w$]*)\s*:\s*/.exec(mod.skel.slice(k, k + 200));
        if (!em) {
          k++;
          continue;
        }
        const vfrom = k + em[0].length;
        let vto = vfrom;
        if (mod.skel[vfrom] === '{') vto = closeOf(mod.skel, vfrom) + 1;
        else vto = vfrom + (/[,}]/.exec(mod.skel.slice(vfrom, sc))?.index ?? sc - vfrom);
        const val = mod.code.slice(vfrom, vto);
        const comp = /^\s*([A-Z][\w$]*)/.exec(val)?.[1] ?? /\bscreen\s*:\s*([A-Z][\w$]*)/.exec(val)?.[1];
        const title = /\btitle\s*:\s*(['"`])([^'"`]+)\1/.exec(val)?.[2];
        const label = /\b(?:tabBarLabel|drawerLabel)\s*:\s*(['"`])([^'"`]+)\1/.exec(val)?.[2];
        screens.push({ name: em[1], ...(comp ? { comp } : {}), ...(title ? { title } : {}), ...(label ? { label } : {}), pos: k });
        k = vto + 1;
      }
      const assigned = /(?:const|let|var)\s+([\w$]+)\s*=\s*$/.exec(mod.skel.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0))?.[1];
      navComps.push({ mod, ...(assigned ? { func: assigned } : {}), type: m[1], screens });
    }
  }

  interface Screen {
    mod: JsModule;
    fn: JsFunc;
    name: string;
    title?: { value: string; file: string; line: number };
    url?: string;
  }
  const screens = new Map<string, Screen>(); // 파일 ID → 화면
  const navOfComp = (mod: JsModule, comp: string): NavComp | undefined => {
    const t = bindingOf(mod, comp);
    if (!t) return undefined;
    return navComps.find((n) => n.mod === t.mod && n.func === t.local);
  };
  const compTarget = (mod: JsModule, comp: string): { mod: JsModule; fn: JsFunc } | undefined => {
    const t = bindingOf(mod, comp.split('.')[0]);
    if (!t) {
      // getComponent require('./screens/X')
      const tm = /^[./]/.test(comp) ? modOf(mod, comp) : undefined;
      const d = tm ? resolveExport(tm, 'default') : undefined;
      return d && d.mod.funcs.has(d.local) ? { mod: d.mod, fn: d.mod.funcs.get(d.local)! } : undefined;
    }
    const fn = t.mod.funcs.get(t.local);
    return fn ? { mod: t.mod, fn } : undefined;
  };
  const titleInFile = (mod: JsModule): Screen['title'] => {
    const m = /\bsetOptions\s*\(\s*\{[^}]*?\b(?:title|headerTitle)\s*:\s*(['"`])([^'"`$]+)\1/.exec(mod.code)
      ?? /<(?:Stack\.Screen|Tabs\.Screen)\b[^>]*?\boptions\s*=\s*\{\{[^}]*?\btitle\s*:\s*(['"`])([^'"`$]+)\1/.exec(mod.code)
      ?? /<(?:Appbar\.Content|Header|AppHeader|ScreenHeader|TopBar)\b[^>]*?\btitle\s*=\s*(?:\{\s*)?(['"])([^'"]+)\1/.exec(mod.code);
    return m ? { value: m[2], file: mod.file.id, line: mod.lineOf(m.index ?? 0) } : undefined;
  };
  const addScreen = (mod: JsModule, fn: JsFunc, routeName: string, title?: string, titleAt?: { file: string; line: number }, url?: string) => {
    if (screens.has(mod.file.id)) {
      const s = screens.get(mod.file.id)!;
      if (!s.title && title && titleAt) s.title = { value: title, ...titleAt };
      return;
    }
    const t = title && titleAt ? { value: title, ...titleAt } : titleInFile(mod);
    screens.set(mod.file.id, { mod, fn, name: routeName, ...(t ? { title: t } : {}), ...(url ? { url } : {}) });
  };
  for (const nc of navComps) {
    for (const s of nc.screens) {
      if (!s.comp || navOfComp(nc.mod, s.comp)) continue;
      const tg = compTarget(nc.mod, s.comp);
      if (!tg) continue;
      const title = s.title ?? s.label;
      addScreen(tg.mod, tg.fn, s.name, title, title ? { file: nc.mod.file.id, line: nc.mod.lineOf(s.pos) } : undefined);
    }
  }

  // Expo Router: app/ 폴더 파일 = 화면
  const menus: MenuFact[] = [];
  const routeFileOf = new Map<string, string>(); // 라우트 파일 ID → 화면 컴포넌트 파일 ID
  for (const r of roots.filter((x) => x.router)) {
    const appDirs = [`${r.dir}/app`, `${r.dir}/src/app`].map((d) => d.replace(/^\//, ''));
    for (const mod of mods.values()) {
      const appDir = appDirs.find((d) => mod.path.startsWith(`${d}/`));
      if (!appDir) continue;
      const rel = mod.path.slice(appDir.length + 1).replace(/\.(tsx?|jsx?)$/, '');
      if (rel.split('/').some((x) => x.startsWith('_') || x.startsWith('+'))) continue;
      // 라우트 파일이 다른 파일의 컴포넌트를 내보내면(export { X as default } from …) 그 파일이 화면
      const d = resolveExport(mod, 'default');
      const fn = d ? d.mod.funcs.get(d.local) : undefined;
      if (!fn || !d) continue;
      const route = `/${rel.split('/').filter((x) => !/^\(.*\)$/.test(x)).map((x) => x.replace(/^\[\.\.\.(\w+)\]$/, '*').replace(/^\[(\w+)\]$/, '{$1}')).filter((x) => x !== 'index').join('/')}`;
      routeFileOf.set(mod.file.id, d.mod.file.id);
      const last = rel.split('/').filter((x) => !/^\(.*\)$/.test(x)).pop() ?? 'index';
      // 동적 경로([id])·index 파일은 컴포넌트 이름으로
      addScreen(d.mod, fn, /^\[|^index$/.test(last) && fn.name !== 'default' ? fn.name : last, undefined, undefined, route);
    }
    // (tabs)/_layout.tsx 의 <Tabs.Screen name="orders" options={{ title: '주문' }} />
    for (const mod of mods.values()) {
      if (!appDirs.some((d) => mod.path.startsWith(`${d}/`)) || !/\/_layout\.(tsx?|jsx?)$/.test(mod.path) || !/<Tabs\b|<Drawer\b/.test(mod.code)) continue;
      const dir = dirName(mod.path);
      let order = 0;
      for (const m of mod.code.matchAll(/<(Tabs|Drawer)\.Screen\b/g)) {
        const at0 = m.index ?? 0;
        const tag = mod.code.slice(at0, jsxTagEnd(mod.skel, at0 + m[0].length) + 1);
        if (/href\s*:\s*null/.test(tag)) continue;
        const name = /\bname\s*=\s*["']([^"']+)["']/.exec(tag)?.[1];
        if (!name) continue;
        const title = /\b(?:title|tabBarLabel|drawerLabel)\s*:\s*(['"`])([^'"`]+)\1/.exec(tag)?.[2];
        const target = [...EXT.map((e) => `${dir}/${name}${e}`), ...EXT.map((e) => `${dir}/${name}/index${e}`)].map((p) => mods.get(p)).find(Boolean);
        const sc = target ? screens.get(routeFileOf.get(target.file.id) ?? target.file.id) : undefined;
        if (sc && title && !sc.title) sc.title = { value: title, file: mod.file.id, line: mod.lineOf(at0) };
        menus.push({ key: `rn:${mod.file.id}:${name}`, name: title ?? sc?.title?.value ?? screenNameOf(name), order: order++, source: 'code', evidence: { file: mod.file.id, line: mod.lineOf(at0) }, ...(sc?.url ? { url: sc.url } : {}), ...(sc ? { view: sc.mod.file.id } : {}) });
      }
    }
  }

  // ---------------------------------------------------------------- 메뉴: Tab·Drawer 내비게이터
  const firstScreenOf = (nc: NavComp, depth = 0): Screen | undefined => {
    for (const s of nc.screens) {
      if (!s.comp || depth > 3) continue;
      const inner = navOfComp(nc.mod, s.comp);
      if (inner) return firstScreenOf(inner, depth + 1);
      const tg = compTarget(nc.mod, s.comp);
      if (tg) return screens.get(tg.mod.file.id);
    }
    return undefined;
  };
  const emitNav = (nc: NavComp, parentKey: string | undefined, depth: number) => {
    nc.screens.forEach((s, i) => {
      if (s.hidden || depth > 3) return;
      const key = `rn:${nc.mod.file.id}:${s.pos}`;
      const inner = s.comp ? navOfComp(nc.mod, s.comp) : undefined;
      const tg = !inner && s.comp ? compTarget(nc.mod, s.comp) : undefined;
      const sc = inner ? firstScreenOf(inner) : tg ? screens.get(tg.mod.file.id) : undefined;
      const name = cleanLabel(s.label ?? s.title) ?? cleanLabel(sc?.title?.value) ?? screenNameOf(s.name);
      menus.push({ key, ...(parentKey ? { parentKey } : {}), name, order: i, source: 'code', evidence: { file: nc.mod.file.id, line: nc.mod.lineOf(s.pos) }, ...(sc ? { view: sc.mod.file.id } : {}) });
      if (inner) {
        // 탭 안 스택: 첫 화면은 탭 자신, 나머지는 하위 메뉴 (탭·드로어는 전부)
        const rest: NavComp = /Tab|Drawer/i.test(inner.type) ? inner : { ...inner, screens: inner.screens.slice(1) };
        emitNav(rest, key, depth + 1);
      }
    });
  };
  // 탭·드로어 안에 든 탭·드로어는 그 부모 아래에서만
  const inTabDrawer = new Set<NavComp>();
  for (const nc of navComps) {
    if (!/Tab|Drawer/i.test(nc.type)) continue;
    for (const s of nc.screens) {
      const inner = s.comp ? navOfComp(nc.mod, s.comp) : undefined;
      if (inner) inTabDrawer.add(inner);
    }
  }
  for (const nc of navComps) {
    if (!/Tab|Drawer/i.test(nc.type) || inTabDrawer.has(nc)) continue;
    emitNav(nc, undefined, 0);
  }
  ctx.facts.menus.push(...menus);

  // ---------------------------------------------------------------- 화면 사실
  for (const sc of screens.values()) {
    const { mod, fn } = sc;
    mod.unit.kind = 'controller';
    mod.file.layer = 'VIEW';
    if (!fn.method.views.includes(mod.path)) fn.method.views.push(mod.path);
    // 같은 파일의 다른 함수(이벤트 처리 등)는 진입 함수에서 부르는 것으로
    for (const other of mod.funcs.values()) {
      if (other === fn || other.method === fn.method) continue;
      if (!fn.method.calls.some((c) => c.method === other.name)) fn.method.calls.push({ via: mod.unit.fqn!, method: other.name, line: other.method.line });
    }
    const label = cleanLabel(sc.title?.value);
    const root = rootOf(mod.path)?.dir ?? '';
    ctx.facts.views.push({
      file: mod.file.id,
      kind: 'app',
      platform: 'React Native',
      group: featureGroup(mod.path, root),
      title: label ?? screenNameOf(sc.name),
      ...(label && sc.title ? { titleLine: sc.title.line, titleFile: sc.title.file } : {}),
      urls: webviews.get(mod.file.id) ?? [],
      includes: [],
      scripts: [],
      ...(sc.url ? { directUrl: sc.url } : {}),
    });
  }
  // 데이터 접근 모듈
  for (const mod of mods.values()) {
    if (screens.has(mod.file.id) || mod.unit.kind !== 'other') continue;
    if (mod.unit.methods.some((m) => m.httpCalls?.length || m.sql.length)) {
      mod.unit.kind = 'dao';
      if (mod.file.layer === 'SCRIPT' || mod.file.layer === 'OTHER') mod.file.layer = 'DAO';
    } else if (/^use[A-Z]|(Service|Store|Slice|Context|Provider|Repository|Api)$/.test(mod.unit.name.split('/').pop() ?? '')) {
      mod.unit.kind = 'service';
    }
  }
}

/** JSX 여는 태그의 끝 ('>' 또는 '/>') 위치 — 구조용 텍스트 기준, 중괄호 안은 건너뜀 */
function jsxTagEnd(skel: string, from: number): number {
  let depth = 0;
  for (let i = from; i < skel.length; i++) {
    const c = skel[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && skel[i - 1] !== '=') return i;
  }
  return skel.length - 1;
}

/** 인자 식의 끝: 같은 깊이의 , ) ; 또는 줄바꿈(뒤에 + 가 없으면) */
function argEnd(skel: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = skel[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return i;
    else if (c === '\n' && depth === 0) {
      const next = skel.slice(i + 1).match(/^\s*(\S)/)?.[1];
      const prev = skel.slice(from, i).trimEnd().slice(-1);
      if (next !== '+' && prev !== '+') return i;
    }
  }
  return to;
}

function findLiteralEnd(code: string, at0: number): number {
  const q = code[at0];
  let j = at0 + 1;
  while (j < code.length && code[j] !== q) {
    if (code[j] === '\\') j++;
    else if (q === '`' && code[j] === '$' && code[j + 1] === '{') {
      const e = code.indexOf('}', j);
      j = e < 0 ? j + 2 : e;
    } else if (code[j] === '\n' && q !== '`') break;
    j++;
  }
  return j;
}

/** React Native·Flutter 프로젝트 안의 android/ 호스트 폴더만 근거인 'Android' 기술은 뺀다 */
export function dropHostAndroid(ctx: Ctx, roots: string[]): void {
  const hosts = roots.map((d) => (d ? `${d}/android/` : 'android/'));
  const inHost = (fileId: string) => {
    const p = ctx.byId.get(fileId)?.path ?? '';
    return hosts.some((h) => p.startsWith(h));
  };
  for (let k = ctx.facts.tech.length - 1; k >= 0; k--) {
    const t = ctx.facts.tech[k];
    if (t.layer !== '앱' && t.layer !== '빌드') continue;
    if (!/^(Android|Gradle)$/.test(t.name)) continue;
    if (t.evidence.length && t.evidence.every((e) => inHost(e.file))) ctx.facts.tech.splice(k, 1);
  }
}
