// Flutter 분석기: pubspec.yaml에 flutter가 있는 폴더의 Dart 코드를 클래스 단위 CodeUnit으로 만들고,
// GoRouter·MaterialApp routes·Navigator.push 대상 위젯을 화면으로, AppBar 제목(ARB 다국어 포함)을 화면 이름으로,
// BottomNavigationBar·NavigationBar·Drawer를 메뉴로, dio·http·retrofit 호출을 httpCalls로, sqflite·drift·floor를 SQL로 남긴다.
// 화면 위젯의 build(StatefulWidget은 State.build)가 views = [화면 파일 경로]를 가져 link가 위젯 → 상태관리 → 리포지토리 → API·DB를 따라간다.
import type { Analyzer, Ctx } from '../context';
import type { CallRef, CodeUnit, FileInfo, MenuFact, MethodUnit, UrlRef } from '../types';
import { dirName, makeLineIndex, normalizePath } from '../files';
import {
  addDdlTable, addHttp, addSqlText, addTableOp, cleanLabel, closeOf, featureGroup, joinBase, newMethod, screenNameOf, skipAngles, snakeLower, splitArgs, stateOf,
} from './applib';
import { dropHostAndroid } from './rn';

interface Region {
  from: number;
  to: number;
}

interface DAnn {
  name: string;
  args: string;
  pos: number;
}

interface DParam {
  name: string;
  type: string;
  thisField: boolean;
}

interface DMember {
  kind: 'method' | 'getter' | 'ctor' | 'field';
  name: string;
  pos: number;
  type: string;
  params: DParam[];
  body?: Region;
  anns: DAnn[];
  isStatic: boolean;
  method?: MethodUnit;
}

interface DClass {
  name: string;
  pos: number;
  kw: string;
  mods: string;
  ext?: string;
  extArgs: string[];
  others: string[];
  anns: DAnn[];
  body: Region;
  members: DMember[];
  unit?: CodeUnit;
  file: DFile;
}

interface DFile {
  file: FileInfo;
  path: string;
  code: string;
  skel: string;
  lineOf: (o: number) => number;
  imports: string[];
  classes: DClass[];
  top: DMember[];
  unit?: CodeUnit;
  root: FRoot;
}

interface FRoot {
  dir: string;
  pkg: string;
  file: string;
  text: string;
}

interface FlState {
  dart: string[];
  roots: FRoot[];
  arb: { path: string; text: string; file: string }[];
}

const STATE = new WeakMap<object, FlState>();
const flState = (ctx: Ctx) => stateOf(ctx.facts, STATE, (): FlState => ({ dart: [], roots: [], arb: [] }));

// ------------------------------------------------------------------ 어휘

/** 주석을 가린 원문과, 문자열 내용까지 가린 구조용 텍스트 */
function dartLex(text: string): { code: string; skel: string } {
  let code = '';
  let skel = '';
  let i = 0;
  const n = text.length;
  const blankKeep = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      const b = blankKeep(text.slice(i, end));
      code += b;
      skel += b;
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j++;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      const b = blankKeep(text.slice(i, j + 1));
      code += b;
      skel += b;
      i = j + 1;
      continue;
    }
    const raw = (c === 'r' || c === 'R') && (d === "'" || d === '"') && !/[\w$]/.test(text[i - 1] ?? '');
    const q0 = raw ? i + 1 : i;
    const qc = text[q0];
    if (qc === "'" || qc === '"') {
      const triple = text.startsWith(qc.repeat(3), q0);
      const quote = triple ? qc.repeat(3) : qc;
      let j = q0 + quote.length;
      let depth = 0;
      while (j < n) {
        if (!raw && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (!raw && text[j] === '$' && text[j + 1] === '{') {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') depth--;
          j++;
          continue;
        }
        if (text.startsWith(quote, j)) break;
        if (!triple && text[j] === '\n') break;
        j++;
      }
      const end = Math.min(n, j + quote.length);
      const lit = text.slice(i, end);
      code += lit;
      const inner = text.slice(q0 + quote.length, j);
      skel += text.slice(i, q0 + quote.length) + inner.replace(/[^\n]/g, '_') + text.slice(j, end);
      i = end;
      continue;
    }
    code += c;
    skel += c;
    i++;
  }
  return { code, skel };
}

/** Dart 문자열 식 ('a' 'b' 인접 연결, +, $x, ${x}) → 값 */
function dartStringExpr(code: string, from: number, to: number, resolve: (n: string) => string | undefined): string | undefined {
  let out = '';
  let known = false;
  let first = true;
  let i = from;
  while (i < to) {
    const c = code[i];
    if (/\s/.test(c) || c === '+') {
      i++;
      continue;
    }
    const raw = (c === 'r' || c === 'R') && (code[i + 1] === "'" || code[i + 1] === '"');
    const q0 = raw ? i + 1 : i;
    const qc = code[q0];
    if (qc === "'" || qc === '"') {
      const triple = code.startsWith(qc.repeat(3), q0);
      const quote = triple ? qc.repeat(3) : qc;
      let j = q0 + quote.length;
      let val = '';
      while (j < code.length && !code.startsWith(quote, j)) {
        const ch = code[j];
        if (!raw && ch === '\\') {
          val += code[j + 1] === 'n' ? ' ' : code[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (!raw && ch === '$') {
          const br = code[j + 1] === '{';
          let name = '';
          let e = j + 1;
          if (br) {
            let depth = 1;
            e = j + 2;
            while (e < code.length && depth) {
              if (code[e] === '{') depth++;
              else if (code[e] === '}') depth--;
              e++;
            }
            name = code.slice(j + 2, e - 1).trim();
          } else {
            const m = /^[A-Za-z_]\w*/.exec(code.slice(j + 1, j + 80));
            name = m ? m[0] : '';
            e = j + 1 + name.length;
          }
          const v = /^[\w.]+$/.test(name) ? resolve(name) : undefined;
          if (v !== undefined) {
            val += v;
            known = true;
          } else val += val === '' && first ? '' : '{p}';
          j = e;
          continue;
        }
        if (!triple && ch === '\n') break;
        val += ch;
        j++;
      }
      out += val;
      known = true;
      first = false;
      i = j + quote.length;
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

// ------------------------------------------------------------------ 구조

function annotations(f: { code: string; skel: string }, from: number, to: number): { anns: DAnn[]; end: number } {
  const anns: DAnn[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(f.skel[i])) i++;
    if (f.skel[i] !== '@') break;
    const m = /^@([A-Za-z_$][\w$.]*)/.exec(f.skel.slice(i, i + 120));
    if (!m) break;
    let j = i + m[0].length;
    let args = '';
    if (f.skel[j] === '(') {
      const e = closeOf(f.skel, j, to);
      args = f.code.slice(j + 1, e);
      j = e + 1;
    }
    anns.push({ name: m[1].split('.').pop()!, args, pos: i });
    i = j;
  }
  return { anns, end: i };
}

function parseParams(skel: string, from: number, to: number): DParam[] {
  const out: DParam[] = [];
  for (const r of splitArgs(skel, from, to)) {
    let seg = skel.slice(r.from, r.to).replace(/[{}[\]]/g, ' ').replace(/@\w+(\([^)]*\))?/g, ' ').replace(/=[\s\S]*$/, '').trim();
    seg = seg.replace(/^(required|covariant|final|const)\s+/g, '').replace(/^(required|covariant|final|const)\s+/g, '');
    const tm = /^this\.(\w+)$/.exec(seg) ?? /^super\.(\w+)$/.exec(seg);
    if (tm) {
      out.push({ name: tm[1], type: '', thisField: seg.startsWith('this.') });
      continue;
    }
    const m = /^([\w$<>?,. ]+?)\s+([A-Za-z_$][\w$]*)$/.exec(seg) ?? /^([A-Za-z_$][\w$]*)$/.exec(seg);
    if (!m) continue;
    if (m.length === 3) out.push({ name: m[2], type: m[1].replace(/\?$/, '').trim(), thisField: false });
    else out.push({ name: m[1], type: '', thisField: false });
  }
  return out;
}

const MODS = /\b(static|final|late|const|var|external|covariant|abstract|factory|override)\b/g;

/** 클래스 몸체(또는 파일 최상위)의 멤버들 */
function parseMembers(f: DFile, from: number, to: number, className: string | null): { members: DMember[]; classes: DClass[] } {
  const s = f.skel;
  const members: DMember[] = [];
  const classes: DClass[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /[\s;]/.test(s[i])) i++;
    if (i >= to) break;
    const { anns, end: afterAnn } = annotations(f, i, to);
    const start = afterAnn;
    // 지시문
    const dir = /^(import|export|part|library)\b/.exec(s.slice(start, start + 10));
    if (dir) {
      const e = s.indexOf(';', start);
      i = e < 0 ? to : e + 1;
      continue;
    }
    const typedef = /^typedef\b/.exec(s.slice(start, start + 10));
    if (typedef) {
      const e = s.indexOf(';', start);
      i = e < 0 ? to : e + 1;
      continue;
    }
    // 클래스·믹스인·확장·enum (최상위에서만)
    const cm = className === null ? /^((?:(?:abstract|sealed|base|final|interface|mixin)\s+)*)(class|mixin|extension|enum)\b\s*([A-Za-z_$][\w$]*)?([^{;]*)\{/.exec(s.slice(start, start + 600)) : null;
    if (cm && !(cm[2] === 'mixin' && /^\s*class\b/.test(cm[4]))) {
      const open = start + cm[0].length - 1;
      const close = closeOf(s, open, to);
      const head = cm[4];
      const ext = /\bextends\s+([\w$.]+)\s*(<[^{]*?>)?(?=\s|$|with|implements|\{)/.exec(head) ?? /\bon\s+([\w$.]+)\s*(<[^{]*?>)?/.exec(head);
      const extArgs = ext?.[2] ? splitArgs(ext[2], 1, ext[2].length - 1).map((r) => ext[2]!.slice(r.from, r.to).trim()) : [];
      const others = [...(/\bwith\s+([^{]*?)(?=\bimplements\b|$)/.exec(head)?.[1] ?? '').split(','), ...(/\bimplements\s+([^{]*)/.exec(head)?.[1] ?? '').split(',')]
        .map((x) => x.trim().replace(/<.*$/, '')).filter(Boolean);
      const cls: DClass = {
        name: cm[3] ?? '', pos: start + cm[1].length + cm[2].length + 1, kw: cm[2], mods: cm[1], ...(ext ? { ext: ext[1].split('.').pop() } : {}), extArgs, others, anns,
        body: { from: open + 1, to: close }, members: [], file: f,
      };
      if (cls.kw !== 'enum' && cls.name) {
        const inner = parseMembers(f, open + 1, close, cls.name);
        cls.members = inner.members;
      }
      if (cls.name) classes.push(cls);
      i = close + 1;
      continue;
    }
    // 머리 → 멈춤 문자
    let j = start;
    let paren: Region | null = null;
    let stop = '';
    let afterColon = false;
    while (j < to) {
      const c = s[j];
      if (c === '(') {
        const e = closeOf(s, j, to);
        if (!paren && !afterColon) paren = { from: j, to: e };
        j = e + 1;
        continue;
      }
      if (c === '[') {
        j = closeOf(s, j, to) + 1;
        continue;
      }
      if (c === '<') {
        const e = skipAngles(s, j, to);
        if (e > j + 1) {
          j = e;
          continue;
        }
      }
      if (c === ':' && paren && !afterColon) afterColon = true;
      if (c === '{') {
        stop = '{';
        break;
      }
      if (c === ';') {
        stop = ';';
        break;
      }
      if (c === '}') {
        stop = '}';
        break;
      }
      if (c === '=' && s[j + 1] === '>') {
        stop = '=>';
        break;
      }
      if (c === '=' && s[j + 1] !== '=' && !afterColon) {
        stop = '=';
        break;
      }
      j++;
    }
    if (!stop || stop === '}') {
      i = j + 1;
      continue;
    }
    const head = s.slice(start, paren ? paren.from : j);
    const getter = /^(.*?)\bget\s+([A-Za-z_$][\w$]*)\s*(?:async\*?|sync\*)?\s*$/.exec(head);
    const isSetter = /\bset\s+[A-Za-z_$][\w$]*\s*$/.test(head) || /\boperator\b/.test(head);
    const nameM = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(<[^>]*>)?\s*$/.exec(head);
    let bodyR: Region | undefined;
    let next = j + 1;
    if (stop === '{') {
      const e = closeOf(s, j, to);
      bodyR = { from: j + 1, to: e };
      next = e + 1;
    } else if (stop === '=>' || stop === '=') {
      const e = stmtEnd(s, j + (stop === '=>' ? 2 : 1), to);
      bodyR = { from: j + (stop === '=>' ? 2 : 1), to: e };
      next = e + 1;
    }
    const isStatic = /\bstatic\b/.test(head);
    if (isSetter) {
      i = next;
      continue;
    }
    if (getter && !paren) {
      members.push({ kind: 'getter', name: getter[2], pos: start + head.lastIndexOf(getter[2]), type: getter[1].replace(MODS, ' ').trim(), params: [], ...(bodyR ? { body: bodyR } : {}), anns, isStatic });
      i = next;
      continue;
    }
    if (paren && nameM && stop !== '=') {
      const name = nameM[1];
      const ctor = className !== null && (name === className || name.startsWith(`${className}.`) || /\bfactory\b/.test(head));
      const params = parseParams(s, paren.from + 1, paren.to);
      const ret = head.slice(0, head.length - nameM[0].length).replace(MODS, ' ').replace(/\s+/g, ' ').trim();
      members.push({ kind: ctor ? 'ctor' : 'method', name: ctor ? 'init' : name, pos: start + head.lastIndexOf(name.split('.')[0]), type: ret, params, ...(bodyR ? { body: bodyR } : {}), anns, isStatic });
      i = next;
      continue;
    }
    // 필드·최상위 변수: [mods] [Type] name [= init]; 여러 개(a, b)는 첫 것만
    const decl = head.replace(MODS, ' ').replace(/\s+/g, ' ').trim();
    const fm = /^(?:([\w$<>?,.\s]+?)\s+)?([A-Za-z_$][\w$]*)$/.exec(decl.split(',')[0].trim());
    if (fm) {
      members.push({ kind: 'field', name: fm[2], pos: start + head.lastIndexOf(fm[2]), type: (fm[1] ?? '').replace(/\?$/, '').trim(), params: [], ...(bodyR && stop === '=' ? { body: bodyR } : {}), anns, isStatic });
    }
    i = next;
  }
  return { members, classes };
}

/** 식·문장 끝 (같은 깊이의 ;) */
function stmtEnd(s: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') {
      i = closeOf(s, i, to) + 1;
      continue;
    }
    if (c === ';' || c === '}' || c === ')' || c === ']') return i;
    i++;
  }
  return to;
}

// ------------------------------------------------------------------ 분석기

export const flutterAnalyzer: Analyzer = {
  name: 'flutter',
  order: 27,
  accepts(f, text) {
    if (f.layer === 'TEST') return false;
    if (f.name === 'pubspec.yaml') return /\bflutter\s*:/.test(text);
    if (/\.arb$/.test(f.name)) return true;
    return f.lang === 'Dart' && !/\.(g|freezed|gr|mocks|config)\.dart$/.test(f.name);
  },
  analyze(f, text, ctx) {
    const st = flState(ctx);
    if (f.name === 'pubspec.yaml') {
      const pkg = /^name\s*:\s*([\w-]+)/m.exec(text)?.[1] ?? '';
      st.roots.push({ dir: f.path.slice(0, -'/pubspec.yaml'.length), pkg, file: f.id, text });
      f.layer = 'CONFIG';
      return;
    }
    if (/\.arb$/.test(f.name)) {
      st.arb.push({ path: f.path, text, file: f.id });
      return;
    }
    if (text.length > 1_000_000) return;
    st.dart.push(f.id);
  },
  finish(ctx) {
    finishFlutter(ctx);
  },
};

const WIDGET_BASE = /^(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|StatelessHookWidget|GetView|GetWidget|GetResponsiveView|StatefulHookWidget|StatefulHookConsumerWidget)$/;
const STATE_BASE = /^(State|ConsumerState)$/;

function finishFlutter(ctx: Ctx): void {
  const st = flState(ctx);
  if (!st.roots.length) return;
  const roots = [...st.roots].sort((a, b) => b.dir.length - a.dir.length);
  const rootOf = (p: string) => roots.find((r) => p.startsWith(`${r.dir}/`));
  dropHostAndroid(ctx, roots.map((r) => r.dir));
  // 웹 빌드용 web/index.html 은 화면이 아님
  for (let k = ctx.facts.views.length - 1; k >= 0; k--) {
    const p = ctx.byId.get(ctx.facts.views[k].file)?.path ?? '';
    if (roots.some((r) => p.startsWith(`${r.dir}/web/`) || p.startsWith(`${r.dir}/windows/`) || p.startsWith(`${r.dir}/linux/`))) ctx.facts.views.splice(k, 1);
  }
  // 기술
  for (const r of roots) {
    const lineOf = makeLineIndex(r.text);
    const dep = (name: string) => new RegExp(`^\\s+${name}\\s*:`, 'm').exec(r.text);
    const hit = (pkgs: string[], layer: '앱' | '데이터 접근' | 'DB', name: string, w: number) => {
      for (const p of pkgs) {
        const m = dep(p);
        if (m) {
          ctx.hit(layer, name, r.file, lineOf(m.index), w);
          return;
        }
      }
    };
    hit(['go_router'], '앱', 'go_router', 2);
    hit(['get'], '앱', 'GetX', 2);
    hit(['auto_route'], '앱', 'auto_route', 2);
    hit(['dio'], '앱', 'dio', 2);
    hit(['http'], '앱', 'http', 1);
    hit(['retrofit'], '앱', 'retrofit(Dart)', 1);
    hit(['flutter_riverpod', 'riverpod', 'hooks_riverpod'], '앱', 'Riverpod', 1);
    hit(['provider'], '앱', 'Provider', 1);
    hit(['flutter_bloc', 'bloc'], '앱', 'Bloc', 1);
    hit(['webview_flutter', 'flutter_inappwebview'], '앱', 'WebView', 1);
    hit(['sqflite', 'sqflite_common_ffi'], '데이터 접근', 'sqflite', 3);
    hit(['drift', 'moor'], '데이터 접근', 'drift', 3);
    hit(['floor'], '데이터 접근', 'floor', 3);
    hit(['sqflite', 'sqflite_common_ffi', 'drift', 'moor', 'floor', 'sqlite3'], 'DB', 'SQLite', 2);
    hit(['hive', 'hive_flutter'], '데이터 접근', 'Hive', 1);
  }

  // ARB 다국어 문자열: 한국어 우선
  const l10n = new Map<string, { value: string; file: string; line: number; rank: number }>();
  for (const a of st.arb) {
    const rank = /_ko(_KR)?\.arb$/.test(a.path) ? 0 : /_en\.arb$|intl_messages\.arb$/.test(a.path) ? 1 : 2;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(a.text);
    } catch {
      continue;
    }
    const lineOf = makeLineIndex(a.text);
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('@') || typeof v !== 'string') continue;
      const prev = l10n.get(k);
      if (prev && prev.rank <= rank) continue;
      const pos = a.text.indexOf(`"${k}"`);
      l10n.set(k, { value: v, file: a.file, line: lineOf(Math.max(0, pos)), rank });
    }
  }

  // ---------------------------------------------------------------- 파일 구조
  const files = new Map<string, DFile>();
  for (const id of st.dart) {
    const f = ctx.byId.get(id);
    const text = ctx.facts.texts.get(id);
    if (!f || text === undefined) continue;
    const root = rootOf(f.path);
    if (!root) continue;
    const { code, skel } = dartLex(text);
    const df: DFile = { file: f, path: f.path, code, skel, lineOf: makeLineIndex(text), imports: [], classes: [], top: [], root };
    for (const m of code.matchAll(/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      let p: string | undefined;
      if (spec.startsWith('package:')) {
        const [pkg, ...rest] = spec.slice(8).split('/');
        const rr = st.roots.find((x) => x.pkg === pkg);
        if (rr) p = `${rr.dir}/lib/${rest.join('/')}`;
      } else if (!spec.startsWith('dart:')) p = normalizePath(`${dirName(f.path)}/${spec}`);
      if (p) df.imports.push(p);
    }
    const parsed = parseMembers(df, 0, skel.length, null);
    df.classes = parsed.classes;
    df.top = parsed.members;
    files.set(f.path, df);
  }
  if (!files.size) return;

  // ---------------------------------------------------------------- 유닛
  const classes: DClass[] = [];
  const classByName = new Map<string, DClass[]>();
  for (const df of files.values()) for (const c of df.classes) {
    classes.push(c);
    const a = classByName.get(c.name) ?? [];
    a.push(c);
    classByName.set(c.name, a);
  }
  const consts = new Map<string, string>();
  const resolveConst = (n: string): string | undefined => consts.get(n) ?? consts.get(n.split('.').slice(-2).join('.')) ?? consts.get(n.split('.').pop()!);
  // 상수: static const / 최상위 const·final 문자열
  for (const df of files.values()) {
    const scan = (list: DMember[], owner: string) => {
      for (const m of list) {
        if (m.kind !== 'field' || !m.body) continue;
        const raw = df.code.slice(m.body.from, m.body.to).trim();
        if (!/^r?['"]/.test(raw)) continue;
        const v = dartStringExpr(df.code, m.body.from, m.body.to, resolveConst);
        if (v === undefined || v.includes('{p}')) continue;
        if (!consts.has(m.name)) consts.set(m.name, v);
        if (owner) consts.set(`${owner}.${m.name}`, v);
      }
    };
    scan(df.top, '');
    for (const c of df.classes) scan(c.members, c.name);
  }
  const fqnOf = (df: DFile, name: string) => `${df.path.replace(/\.dart$/, '')}.${name}`;
  const kindOf = (c: DClass): CodeUnit['kind'] => {
    const n = c.name;
    if (c.ext === 'Table' || c.anns.some((a) => /^(Entity|entity|DataClassName)$/.test(a.name))) return 'model';
    if (c.anns.some((a) => /^(dao|RestApi)$/.test(a.name)) || /(Repository|RepositoryImpl|Dao|DAO|Api|ApiClient|ApiService|Client|DataSource|Database|Db|Storage)$/.test(n) || /^(_\$|GeneratedDatabase|DatabaseAccessor)/.test(c.ext ?? '')) return 'dao';
    if (/(Service|Bloc|Cubit|Controller|Notifier|ViewModel|Provider|Store|UseCase|Manager)$/.test(n) || /^(Bloc|Cubit|ChangeNotifier|StateNotifier|Notifier|AsyncNotifier|GetxController)$/.test(c.ext ?? '')) return 'service';
    if (/(Model|Dto|DTO|Entity|Vo)$/.test(n) || /\/(models?|entities|dto)\//.test(c.file.path)) return 'model';
    return 'other';
  };
  interface Reg {
    df: DFile;
    cls?: DClass;
    unit: CodeUnit;
    m: MethodUnit;
    body: Region;
    params: DParam[];
    pseudo: boolean;
  }
  const regs: Reg[] = [];
  const addMember = (df: DFile, unit: CodeUnit, cls: DClass | undefined, mem: DMember) => {
    if (mem.kind === 'field' && !mem.body) return;
    const existing = mem.kind === 'ctor' ? unit.methods.find((x) => x.name === 'init') : undefined;
    const m = existing ?? newMethod(mem.name, df.lineOf(mem.pos), mem.body ? df.lineOf(mem.body.to) : undefined);
    if (!existing) unit.methods.push(m);
    mem.method = m;
    if (mem.body) regs.push({ df, cls, unit, m, body: mem.body, params: mem.params, pseudo: mem.kind === 'field' });
  };
  for (const c of classes) {
    const df = c.file;
    const fields: Record<string, string> = {};
    for (const mem of c.members) if (mem.kind === 'field') fields[mem.name] = mem.type || inferType(df, mem);
    for (const mem of c.members) if (mem.kind === 'ctor') for (const p of mem.params) if (!(p.name in fields) && p.type) fields[p.name] = p.type;
    const unit = ctx.addUnit({ file: df.file.id, name: c.name, fqn: fqnOf(df, c.name), kind: kindOf(c), line: df.lineOf(c.pos), extendsOrImplements: [c.ext, ...c.others].filter((x): x is string => !!x), fields, methods: [] });
    c.unit = unit;
    for (const mem of c.members) addMember(df, unit, c, mem);
    const layer = ({ controller: 'CONTROLLER', service: 'SERVICE', dao: 'DAO', repository: 'DAO', mapper: 'MAPPER', model: 'MODEL', job: 'BATCH', other: undefined } as const)[unit.kind];
    if (layer && df.file.layer !== 'TEST') df.file.layer = layer;
  }
  for (const df of files.values()) {
    if (!df.top.some((m) => m.body)) continue;
    const name = `${df.file.name.replace(/\.dart$/, '')}`;
    const unit = ctx.addUnit({ file: df.file.id, name, fqn: fqnOf(df, '_top'), kind: 'other', line: 1, extendsOrImplements: [], fields: {}, methods: [] });
    df.unit = unit;
    for (const mem of df.top) addMember(df, unit, undefined, mem);
  }

  // ---------------------------------------------------------------- 해석 도구
  const unitByClass = (name: string, from: DFile): DClass | undefined => {
    const list = classByName.get(name.replace(/<.*$/, '').replace(/\?$/, '').split('.').pop() ?? '');
    if (!list?.length) return undefined;
    if (list.length === 1) return list[0];
    return list.find((c) => c.file === from) ?? list.find((c) => from.imports.includes(c.file.path)) ?? list[0];
  };
  const topFun = new Map<string, { df: DFile; mem: DMember }[]>();
  for (const df of files.values()) for (const m of df.top) {
    if (!m.method) continue;
    const a = topFun.get(m.name) ?? [];
    a.push({ df, mem: m });
    topFun.set(m.name, a);
  }
  const stateOfWidget = new Map<DClass, DClass>();
  const widgetOfState = new Map<DClass, DClass>();
  for (const c of classes) {
    if (c.ext && STATE_BASE.test(c.ext) && c.extArgs[0]) {
      const w = unitByClass(c.extArgs[0], c.file);
      if (w) {
        stateOfWidget.set(w, c);
        widgetOfState.set(c, w);
      }
    }
  }
  const isWidget = (c: DClass, depth = 0): boolean => {
    if (!c.ext || depth > 5) return false;
    if (WIDGET_BASE.test(c.ext)) return true;
    const base = unitByClass(c.ext, c.file);
    return !!base && base !== c && isWidget(base, depth + 1);
  };
  const fieldType = (c: DClass | undefined, name: string): string | undefined => {
    let cur = c;
    for (let d = 0; cur && d < 5; d++) {
      const t = cur.unit?.fields[name];
      if (t !== undefined) return t;
      cur = cur.ext ? unitByClass(cur.ext, cur.file) : undefined;
    }
    return undefined;
  };
  const methodOwner = (c: DClass | undefined, name: string): DClass | undefined => {
    let cur = c;
    for (let d = 0; cur && d < 5; d++) {
      if (cur.unit?.methods.some((m) => m.name === name)) return cur;
      cur = cur.ext ? unitByClass(cur.ext, cur.file) : undefined;
    }
    return undefined;
  };
  // 다른 클래스가 상속·구현하는 추상 클래스는 이름으로 불러 link가 구현체까지 따라가게
  const implemented = new Set<string>();
  for (const c of classes) for (const x of [c.ext, ...c.others]) if (x) implemented.add(x);
  const viaOf = (c: DClass) => (implemented.has(c.name) && /\babstract\b|\binterface\b|\bbase\b|\bsealed\b/.test(c.mods) ? c.name : c.unit!.fqn!);
  const memberRet = (c: DClass, name: string) => c.members.find((m) => m.name === name && (m.kind === 'method' || m.kind === 'getter'))?.type;

  // 리버팟 프로바이더: 이름 → 만드는 타입 / 최상위 변수
  const providerType = new Map<string, string>();
  for (const df of files.values()) for (const m of df.top) {
    if (m.kind !== 'field' || !m.body || !/Provider$/.test(m.name)) continue;
    const init = df.code.slice(m.body.from, m.body.to);
    const g = /^\s*(?:\w+\.)?(?:StateNotifierProvider|ChangeNotifierProvider|NotifierProvider|AsyncNotifierProvider|Provider|StateProvider|FutureProvider|StreamProvider)(?:\.\w+)*\s*<\s*([A-Z]\w*)/.exec(init);
    const ctor = /=>\s*([A-Z]\w*)\s*\(/.exec(init) ?? /return\s+([A-Z]\w*)\s*\(/.exec(init);
    const t = /^(StateNotifierProvider|ChangeNotifierProvider|NotifierProvider|AsyncNotifierProvider)/.test(init.trim()) ? g?.[1] ?? ctor?.[1] : ctor?.[1] ?? g?.[1];
    if (t) providerType.set(m.name, t);
  }
  // @riverpod class Orders / @riverpod Future<…> orders(…) → ordersProvider
  for (const c of classes) if (c.anns.some((a) => /^[rR]iverpod$/.test(a.name))) providerType.set(`${c.name[0].toLowerCase()}${c.name.slice(1)}Provider`, c.name);

  // ---------------------------------------------------------------- 호출
  for (const r of regs) {
    const { df, unit, m } = r;
    const self = r.cls;
    const seg = df.skel.slice(r.body.from, r.body.to);
    const seen = new Set(m.calls.map((c) => `${c.via}#${c.method}`));
    const add = (via: string, method: string, pos: number) => {
      const key = `${via}#${method}`;
      if (seen.has(key) || (via === unit.fqn && method === m.name)) return;
      seen.add(key);
      const c: CallRef = { via, method, line: df.lineOf(r.body.from + pos) };
      m.calls.push(c);
    };
    const callOn = (cls: DClass | undefined, method: string, pos: number) => {
      if (!cls?.unit) return;
      const owner = methodOwner(cls, method);
      if (owner) add(viaOf(owner), method, pos);
      else if (/^(Bloc|Cubit)$/.test(cls.ext ?? '') && cls.unit.methods.some((x) => x.name === 'init')) add(viaOf(cls), 'init', pos);
    };
    const locals = new Map<string, string>();
    for (const p of r.params) if (p.type) locals.set(p.name, p.type);
    for (const lm of seg.matchAll(/\b(?:final|var|late\s+final|late|const)\s+(?:([A-Z][\w$<>?,. ]*?)\s+)?([a-z_$][\w$]*)\s*=\s*([^;]{0,200})/g)) {
      const init = lm[3];
      const t = lm[1]?.trim()
        ?? /\b(?:read|watch|of|find|get|put|lazyPut|select)\s*<\s*([A-Z][\w$]*)/.exec(init)?.[1]
        ?? /^\s*(?:await\s+)?(?:Get\.put\s*\(\s*)?([A-Z][\w$]*)\s*\(/.exec(init)?.[1]
        ?? (/\bref\s*\.\s*(?:read|watch)\s*\(\s*(\w+)/.exec(init) ? providerType.get(/\bref\s*\.\s*(?:read|watch)\s*\(\s*(\w+)/.exec(init)![1]) : undefined);
      if (t) locals.set(lm[2], t);
    }
    const typeOfName = (n: string): string | undefined => locals.get(n) ?? (self ? fieldType(self, n) : undefined);
    // a.b.c( 꼴
    for (const cm of seg.matchAll(/(?<![\w$.)\]>])((?:[A-Za-z_$][\w$]*(?:\(\))?[?!]?\s*\.\s*)+)([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
      const segs = cm[1].split('.').map((x) => x.replace(/[?!\s]/g, '')).filter(Boolean);
      const method = cm[2];
      const pos = cm.index ?? 0;
      let cur: DClass | undefined;
      let i = 0;
      const s0 = segs[0];
      if (s0 === 'this') {
        cur = self;
        i = 1;
      } else if (s0 === 'widget' && self && widgetOfState.has(self)) {
        cur = widgetOfState.get(self);
        i = 1;
      } else if (s0 === 'super') continue;
      else {
        const t = typeOfName(s0);
        if (t !== undefined) {
          cur = t ? unitByClass(t, df) : undefined;
          if (self && fieldType(self, s0) !== undefined && methodOwner(self, s0)) add(viaOf(methodOwner(self, s0)!), s0, pos);
          if (!cur) continue;
          i = 1;
        } else if (/^[A-Z]/.test(s0)) {
          cur = unitByClass(s0, df);
          if (!cur) continue;
          i = 1;
        } else continue;
      }
      let ok = true;
      for (; i < segs.length && cur; i++) {
        const sg = segs[i].replace(/\(\)$/, '');
        const owner = methodOwner(cur, sg);
        if (owner) add(viaOf(owner), sg, pos);
        const t = fieldType(cur, sg) ?? (owner ? memberRet(owner, sg) : undefined);
        const next: DClass | undefined = t ? unitByClass(t.replace(/^Future<|^Stream<|>$/g, ''), df) : undefined;
        if (!next) {
          ok = false;
          break;
        }
        cur = next;
      }
      if (!ok || !cur) continue;
      callOn(cur, method, pos);
    }
    // context.read<T>().m(  Provider.of<T>(context).m(  Get.find<T>().m(  getIt<T>().m(
    for (const gm of seg.matchAll(/(?:\.\s*(?:read|watch|select|of|find|get)|\b(?:getIt|locator|sl|GetIt\.I|GetIt\.instance|Get\.find))\s*<\s*([A-Z][\w$]*)\s*>\s*\(([^()]|\([^()]*\))*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      callOn(unitByClass(gm[1], df), gm[3], gm.index ?? 0);
    }
    // ref.read(xProvider.notifier).m(  ref.watch(xProvider)
    for (const pm of seg.matchAll(/\bref\s*\.\s*(?:read|watch|listen)\s*\(\s*([a-z]\w*)(?:\.notifier|\.future)?\s*[),]/g)) {
      const prov = pm[1];
      const top = topFun.get(prov)?.[0];
      if (top?.mem.method && top.df.unit) add(top.df.unit.fqn!, prov, pm.index ?? 0);
      const t = providerType.get(prov);
      const tc = t ? unitByClass(t, df) : undefined;
      const after = /^\s*\)?\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(seg.slice((pm.index ?? 0) + pm[0].length - 1, (pm.index ?? 0) + pm[0].length + 60));
      if (tc && after) callOn(tc, after[1], pm.index ?? 0);
      else if (tc) {
        const b = tc.unit?.methods.find((x) => x.name === 'build') ?? tc.unit?.methods.find((x) => x.name === 'init');
        if (b) add(viaOf(tc), b.name, pm.index ?? 0);
      }
      // @riverpod 함수형: orders(OrdersRef ref)
      const fnName = prov.replace(/Provider$/, '');
      const tf = topFun.get(fnName)?.[0];
      if (tf?.df.unit) add(tf.df.unit.fqn!, fnName, pm.index ?? 0);
    }
    // T().m(  생성 후 바로 호출
    for (const nm of seg.matchAll(/(?<![\w$.])([A-Z][\w$]*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) callOn(unitByClass(nm[1], df), nm[2], nm.index ?? 0);
    // 이름( 꼴: 자기 메서드·최상위 함수·위젯 생성(→ build)
    for (const bm of seg.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
      const name = bm[1];
      const pos = bm.index ?? 0;
      if (/^(if|for|while|switch|catch|return|print|super|this|assert|setState|Text|Padding|Center|Column|Row|Container|SizedBox|Expanded|Icon|Scaffold|AppBar|ListView|ListTile|Card|Stack|Positioned|Align|EdgeInsets|BorderRadius|Color|TextStyle|Image|InkWell|GestureDetector|ElevatedButton|TextButton|IconButton|FloatingActionButton|CircularProgressIndicator|SafeArea|Builder|FutureBuilder|StreamBuilder|MaterialPageRoute|Uri|Duration|DateTime|Exception|List|Map|Set|Future|Stream)$/.test(name)) continue;
      if (self) {
        const own = methodOwner(self, name);
        if (own && own.unit!.methods.some((x) => x.name === name)) {
          add(viaOf(own), name, pos);
          continue;
        }
        const w = widgetOfState.get(self);
        if (w && methodOwner(w, name)) {
          add(viaOf(methodOwner(w, name)!), name, pos);
          continue;
        }
      }
      const top = topFun.get(name);
      if (top?.length) {
        const t = top.find((x) => x.df === df) ?? top.find((x) => df.imports.includes(x.df.path)) ?? top[0];
        if (t.df.unit) add(t.df.unit.fqn!, name, pos);
        continue;
      }
      if (/^[A-Z]/.test(name)) {
        const c = unitByClass(name, df);
        if (!c?.unit) continue;
        if (isWidget(c)) {
          const target = stateOfWidget.get(c) ?? c;
          const b = target.unit?.methods.find((x) => x.name === 'build');
          if (b) add(viaOf(target), 'build', pos);
          const init = target.unit?.methods.find((x) => x.name === 'initState');
          if (init) add(viaOf(target), 'initState', pos);
        } else if (c.unit.methods.some((x) => x.name === 'init')) add(viaOf(c), 'init', pos);
      }
    }
    // 함수 참조: Command0(_load), onPressed: _submit, onTap: widget.onTap
    if (self) for (const fm of seg.matchAll(/(?<![\w$.])(_?[A-Za-z]\w*)(?=\s*[,)\];])/g)) {
      const own = methodOwner(self, fm[1]);
      if (own && own.members.some((x) => x.name === fm[1] && x.kind === 'method')) add(viaOf(own), fm[1], fm.index ?? 0);
    }
  }

  // ---------------------------------------------------------------- HTTP · SQL · 웹뷰 · 애노테이션
  const bases: string[] = [];
  for (const df of files.values()) {
    for (const m of df.code.matchAll(/\bbaseUrl\s*[:=]\s*/g)) {
      const from = (m.index ?? 0) + m[0].length;
      const end = from + (/[,;)\n]/.exec(df.code.slice(from, from + 300))?.index ?? 0);
      const v = dartStringExpr(df.code, from, end, resolveConst);
      if (v && /^(https?:)?\/\//.test(v)) bases.push(v);
    }
  }
  const uniqBases = [...new Set(bases)];
  const dioBase = uniqBases.length >= 1 ? uniqBases[0] : '';
  const webviews = new Map<string, UrlRef[]>();
  const driftTables = new Map<string, string>();
  for (const c of classes) {
    if (c.ext !== 'Table') continue;
    const tn = c.members.find((m) => m.name === 'tableName' && m.kind === 'getter' && m.body);
    const name = tn ? dartStringExpr(c.file.code, tn.body!.from, tn.body!.to, resolveConst) : undefined;
    const table = name ?? snakeLower(c.name);
    driftTables.set(c.name[0].toLowerCase() + c.name.slice(1), table);
    const cols = c.members.filter((m) => m.kind === 'getter' && /Column$/.test(m.type)).map((m) => {
      const b = m.body ? c.file.code.slice(m.body.from, m.body.to) : '';
      const named = /\.named\s*\(\s*['"]([^'"]+)['"]/.exec(b)?.[1];
      return { name: named ?? snakeLower(m.name), type: m.type.replace(/Column$/, '').toUpperCase(), ...(/autoIncrement\(\)/.test(b) ? { pk: true, nullable: false } : { nullable: /\.nullable\(\)/.test(b) }) };
    });
    addDdlTable(ctx.facts, { name: table, columns: cols, evidence: { file: c.file.file.id, line: c.file.lineOf(c.pos) } });
    c.unit!.kind = 'model';
    c.unit!.table = table;
  }
  // floor 엔티티
  const floorEntity = new Map<string, string>();
  for (const c of classes) {
    const ent = c.anns.find((a) => /^(Entity|entity)$/.test(a.name));
    if (!ent || c.ext === 'Table') continue;
    const tn = /tableName\s*:\s*['"]([^'"]+)['"]/.exec(ent.args)?.[1] ?? c.name;
    floorEntity.set(c.name, tn);
    c.unit!.table = tn;
    c.unit!.kind = 'model';
  }
  for (const r of regs) {
    const { df, m } = r;
    const seg = df.skel.slice(r.body.from, r.body.to);
    const at = (o: number) => r.body.from + o;
    const exprAt = (open: number, n = 0): string | undefined => {
      const close = closeOf(df.skel, open);
      const parts = splitArgs(df.skel, open + 1, close);
      const p = parts[n];
      return p ? dartStringExpr(df.code, p.from, p.to, resolveConst) : undefined;
    };
    const uriExpr = (from: number, to: number): string | undefined => {
      const raw = df.code.slice(from, to).trim();
      const um = /^Uri\s*\.\s*(parse|https?|tryParse)\s*\(/.exec(raw);
      if (um) {
        const open = from + df.code.slice(from, to).indexOf('(');
        if (um[1] === 'https' || um[1] === 'http') return exprAt(open, 1);
        return exprAt(open, 0);
      }
      if (/^[a-z_]\w*$/.test(raw)) {
        // final uri = Uri.parse('…');
        const dm = new RegExp(`\\b${raw}\\s*=\\s*Uri\\s*\\.\\s*(parse|https?|tryParse)\\s*\\(`).exec(df.skel.slice(r.body.from, r.body.to));
        if (dm) {
          const open = r.body.from + (dm.index ?? 0) + dm[0].length - 1;
          return exprAt(open, dm[1] === 'https' || dm[1] === 'http' ? 1 : 0);
        }
      }
      return dartStringExpr(df.code, from, to, resolveConst);
    };
    // dio·http 호출
    for (const hm of seg.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|head|fetch|request|getUrl|postUrl|putUrl|deleteUrl|patchUrl|openUrl)\s*(?:<[^<>()]*>)?\s*\(/g)) {
      const recv = hm[1];
      let verb = hm[2];
      if (/Url$/.test(verb)) {
        // dart:io HttpClient.getUrl(Uri) / openUrl('GET', uri)
        const open0 = at((hm.index ?? 0) + hm[0].length - 1);
        const close0 = closeOf(df.skel, open0);
        const ps = splitArgs(df.skel, open0 + 1, close0);
        const uriPart = verb === 'openUrl' ? ps[1] : ps[0];
        const u = uriPart ? uriExpr(uriPart.from, uriPart.to) : undefined;
        const mv = verb === 'openUrl' ? /['"](\w+)['"]/.exec(df.code.slice(ps[0]?.from ?? 0, ps[0]?.to ?? 0))?.[1] : verb.replace(/Url$/, '');
        if (u !== undefined && mv) addHttp(m, mv.toUpperCase(), u, df.lineOf(open0));
        continue;
      }
      const open = at((hm.index ?? 0) + hm[0].length - 1);
      const t = r.cls ? fieldType(r.cls, recv) : undefined;
      const local = new RegExp(`\\b${recv}\\s*=\\s*(Dio|http\\.Client|Client)\\s*\\(`).test(seg);
      const isDio = /^Dio$/.test(t ?? '') || /^_?(dio|apiDio|client|apiClient|httpClient|api)$/i.test(recv) || (local && /Dio/.test(seg));
      const isHttp = recv === 'http' || /^(http\.)?Client$/.test(t ?? '') || (local && /Client/.test(seg));
      if (!isDio && !isHttp) continue;
      const close = closeOf(df.skel, open);
      const parts = splitArgs(df.skel, open + 1, close);
      if (!parts[0]) continue;
      // dart:io HttpClient.get(host, port, '/path')
      const hostForm = parts.length >= 3 && !/^\s*r?['"]/.test(df.code.slice(parts[0].from, parts[0].to)) && /^\s*r?['"]/.test(df.code.slice(parts[2].from, parts[2].to));
      const urlPart = hostForm ? parts[2] : parts[0];
      const url = isHttp && !hostForm ? uriExpr(urlPart.from, urlPart.to) : dartStringExpr(df.code, urlPart.from, urlPart.to, resolveConst);
      if (url === undefined) continue;
      let method = verb.toUpperCase();
      if (verb === 'request' || verb === 'fetch') method = /method\s*:\s*['"](\w+)['"]/.exec(df.code.slice(open, close))?.[1]?.toUpperCase() ?? 'GET';
      addHttp(m, method, isDio && dioBase && !/^https?:/.test(url) ? joinBase(dioBase.endsWith('/') ? dioBase : `${dioBase}/`, url.replace(/^\//, '')) : url, df.lineOf(open));
    }
    // sqflite: db.query('orders') / insert / update / delete
    for (const sm of seg.matchAll(/\b([A-Za-z_$][\w$]*)\s*[?!]?\s*\.\s*(query|insert|update|delete|rawQuery|rawInsert|rawUpdate|rawDelete|execute)\s*\(/g)) {
      const recv = sm[1];
      if (!/^(db|database|_db|_database|txn|batch|tx|dbClient|client)$/i.test(recv) && !/\bDatabase\b/.test(df.code)) continue;
      const open = at((sm.index ?? 0) + sm[0].length - 1);
      const op = sm[2];
      const first = exprAt(open, 0);
      if (!first) continue;
      if (/^raw|^execute$/.test(op)) {
        addSqlText(ctx, df.file.id, df.lineOf(open), m, first.replace(/\{p\}/g, '?'));
        continue;
      }
      if (!/^[A-Za-z_][\w$]*$/.test(first)) continue;
      addTableOp(ctx, df.file.id, df.lineOf(open), m, op === 'query' ? 'select' : (op as 'insert' | 'update' | 'delete'), first, `sqflite ${op}('${first}')`);
    }
    // 문자열 SQL (CREATE TABLE·SELECT …)
    for (const lm of seg.matchAll(/(?:^|[^\w$])r?(['"]{1,3})/g)) {
      const q = at((lm.index ?? 0) + lm[0].length - lm[1].length);
      const head = df.code.slice(q, q + 60);
      if (!/^['"]{1,3}\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|WITH|REPLACE)\b/i.test(head)) continue;
      const end = stmtArgEnd(df.skel, q, r.body.to);
      const sql = dartStringExpr(df.code, q, end, resolveConst);
      if (sql && !m.sql.some((id) => ctx.facts.sql.find((x) => x.id === id)?.line === df.lineOf(q))) addSqlText(ctx, df.file.id, df.lineOf(q), m, sql.replace(/\{p\}/g, '?'));
    }
    // drift: select(todos) into(todos).insert update(todos) delete(todos)
    for (const dm of seg.matchAll(/\b(select|into|update|delete|selectOnly)\s*\(\s*([a-z]\w*)\s*\)/g)) {
      const table = driftTables.get(dm[2]);
      if (!table) continue;
      const op = dm[1] === 'select' || dm[1] === 'selectOnly' ? 'select' : dm[1] === 'into' ? 'insert' : (dm[1] as 'update' | 'delete');
      addTableOp(ctx, df.file.id, df.lineOf(at(dm.index ?? 0)), m, op, table, `drift ${dm[1]}(${dm[2]})`);
    }
    // 웹뷰
    for (const wm of df.code.slice(r.body.from, r.body.to).matchAll(/(?:loadRequest\s*\(\s*Uri\s*\.\s*parse\s*\(|initialUrl\s*:\s*|WebUri\s*\(\s*|loadUrl\s*\(\s*(?:urlRequest\s*:\s*URLRequest\s*\(\s*url\s*:\s*WebUri\s*\()?)/g)) {
      const from = at((wm.index ?? 0) + wm[0].length);
      const end = from + (/[,)\n;]/.exec(df.code.slice(from, from + 300))?.index ?? 0);
      const u = dartStringExpr(df.code, from, end, resolveConst);
      if (!u) continue;
      const list = webviews.get(df.file.id) ?? [];
      if (!list.some((x) => x.url === u)) list.push({ url: u, kind: 'webview', file: df.file.id, line: df.lineOf(from) });
      webviews.set(df.file.id, list);
    }
  }
  // retrofit(dart)·chopper·floor 애노테이션 (몸체 없는 메서드 포함)
  for (const c of classes) {
    const api = c.anns.find((a) => a.name === 'RestApi' || a.name === 'ChopperApi');
    const base = api ? dartStringExpr(api.args, 0, api.args.length, resolveConst) ?? (/baseUrl\s*:\s*(['"][^'"]*['"])/.exec(api.args) ? dartStringExpr(/baseUrl\s*:\s*(['"][^'"]*['"])/.exec(api.args)![1], 0, 400, resolveConst) : undefined) : undefined;
    for (const mem of c.members) {
      if (!mem.method) continue;
      for (const a of mem.anns) {
        if (/^(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)$/.test(a.name)) {
          const p = /(?:path\s*:\s*)?(['"][^'"]*['"])/.exec(a.args)?.[1];
          const v = p ? dartStringExpr(p, 0, p.length, resolveConst) : '';
          if (v !== undefined) addHttp(mem.method, a.name.toUpperCase(), joinBase(base ?? dioBase, v), c.file.lineOf(a.pos));
        } else if (a.name === 'Query') {
          const sql = dartStringExpr(a.args, 0, a.args.length, resolveConst);
          if (sql) addSqlText(ctx, c.file.file.id, c.file.lineOf(a.pos), mem.method, sql, { trusted: true, origin: 'annotation' });
        } else if (/^(insert|update|delete|Insert|Update|Delete)$/.test(a.name)) {
          const table = mem.params.map((p) => floorEntity.get(p.type.replace(/^List<|>$/g, ''))).find(Boolean);
          if (table) addTableOp(ctx, c.file.file.id, c.file.lineOf(a.pos), mem.method, a.name.toLowerCase() as 'insert' | 'update' | 'delete', table, `floor @${a.name} ${c.name}.${mem.name}() → ${table}`);
        }
      }
    }
    if (c.anns.some((a) => a.name === 'dao') && c.unit) c.unit.kind = 'dao';
  }

  // ---------------------------------------------------------------- 라우트 → 화면
  interface Route0 {
    path?: string;
    widget: string;
    df: DFile;
    pos: number;
    parent?: Route0;
    children: Route0[];
    branch?: number;
  }
  const routes: Route0[] = [];
  const firstWidget = (df: DFile, from: number, to: number): string | undefined => {
    const seg = df.skel.slice(from, to);
    for (const m of seg.matchAll(/(?<![\w$.])(?:const\s+)?([A-Z][\w$]*)\s*(?:\.\w+)?\s*\(/g)) {
      const c = unitByClass(m[1], df);
      if (c && isWidget(c)) return m[1];
    }
    return undefined;
  };
  // GoRoute(path: '/orders', builder: …, routes: [ … ]) / GetPage(name:, page:)
  const parseGoRoutes = (df: DFile, from: number, to: number, parent: Route0 | undefined, branch?: number) => {
    const seg = df.skel.slice(from, to);
    const re = /\b(GoRoute|GetPage|AutoRoute|CustomRoute|StatefulShellBranch)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg))) {
      const open = from + m.index + m[0].length - 1;
      const close = closeOf(df.skel, open, to);
      const args = splitArgs(df.skel, open + 1, close);
      if (m[1] === 'StatefulShellBranch') {
        const idx = routes.filter((x) => x.branch !== undefined && !x.parent).length;
        const rr = args.find((a) => /^\s*routes\s*:/.test(df.skel.slice(a.from, a.to)));
        if (rr) parseGoRoutes(df, rr.from, rr.to, parent, branch ?? idx);
        re.lastIndex = close - from + 1;
        continue;
      }
      const argOf = (k: string) => args.find((a) => new RegExp(`^\\s*${k}\\s*:`).test(df.skel.slice(a.from, a.to)));
      const pa = argOf('path') ?? argOf('name');
      let path = pa ? dartStringExpr(df.code, pa.from + df.skel.slice(pa.from, pa.to).indexOf(':') + 1, pa.to, resolveConst) : undefined;
      const builder = argOf('builder') ?? argOf('pageBuilder') ?? argOf('page');
      let widget = builder ? firstWidget(df, builder.from, builder.to) : undefined;
      if (!widget && m[1] === 'AutoRoute' && builder) {
        const pr = /([A-Z]\w*)Route\.page/.exec(df.code.slice(builder.from, builder.to))?.[1];
        if (pr) widget = [`${pr}Screen`, `${pr}Page`, pr].find((n) => classByName.has(n));
      }
      if (path !== undefined && parent?.path && !path.startsWith('/')) path = `${parent.path.replace(/\/$/, '')}/${path}`;
      const route: Route0 = { ...(path !== undefined ? { path } : {}), widget: widget ?? '', df, pos: open, ...(parent ? { parent } : {}), children: [], ...(branch !== undefined ? { branch } : {}) };
      if (widget || path) routes.push(route);
      parent?.children.push(route);
      const sub = argOf('routes') ?? argOf('children');
      if (sub) parseGoRoutes(df, sub.from, sub.to, route, branch);
      re.lastIndex = close - from + 1;
    }
  };
  for (const df of files.values()) {
    if (/\b(GoRoute|GetPage|AutoRoute)\s*\(/.test(df.code)) {
      // 최상위 GoRoute만 (안쪽은 재귀로)
      const outer = /\b(GoRouter|routes\s*:|getPages\s*:|List<GetPage>|List<AutoRoute>|List<RouteBase>)/g;
      const seen = new Set<number>();
      for (const om of df.skel.matchAll(outer)) {
        const k = df.skel.indexOf('[', om.index ?? 0);
        if (k < 0 || seen.has(k)) continue;
        const close = closeOf(df.skel, k);
        if (routes.some((r) => r.df === df && r.pos > k && r.pos < close)) continue;
        seen.add(k);
        parseGoRoutes(df, k + 1, close, undefined);
      }
    }
    // MaterialApp(routes: {'/': (c) => HomeScreen(), …}) / home: HomeScreen()
    for (const mm of df.skel.matchAll(/\broutes\s*:\s*(?:<[^>]*>\s*)?\{/g)) {
      const open = (mm.index ?? 0) + mm[0].length - 1;
      const close = closeOf(df.skel, open);
      for (const ent of splitArgs(df.skel, open + 1, close)) {
        const key = /^\s*(['"])([^'"]*)\1\s*:/.exec(df.code.slice(ent.from, ent.to)) ?? /^\s*([A-Za-z_][\w.]*)\s*:/.exec(df.code.slice(ent.from, ent.to));
        if (!key) continue;
        const path = key.length === 3 ? key[2] : resolveConst(key[1]);
        const widget = firstWidget(df, ent.from + key[0].length, ent.to);
        if (widget) routes.push({ ...(path !== undefined ? { path } : {}), widget, df, pos: ent.from, children: [] });
      }
    }
    for (const hm of df.skel.matchAll(/\bhome\s*:\s*(?:const\s+)?([A-Z][\w$]*)\s*\(/g)) {
      const c = unitByClass(hm[1], df);
      if (c && isWidget(c)) routes.push({ widget: hm[1], df, pos: hm.index ?? 0, children: [] });
    }
    // Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen()))
    for (const pm of df.skel.matchAll(/\b(MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder|MaterialWithModalsPageRoute)\s*(?:<[^>]*>)?\s*\(/g)) {
      const open = (pm.index ?? 0) + pm[0].length - 1;
      const close = closeOf(df.skel, open);
      const widget = firstWidget(df, open + 1, close);
      if (widget) routes.push({ widget, df, pos: open, children: [] });
    }
  }
  const routeOfWidget = new Map<string, Route0>();
  for (const r of routes) if (r.widget && (!routeOfWidget.has(r.widget) || (!routeOfWidget.get(r.widget)!.path && r.path))) routeOfWidget.set(r.widget, r);

  // 하단 탭·드로어
  interface NavItem {
    label?: string;
    labelAt?: { file: string; line: number };
    pos: number;
    df: DFile;
    target?: string;
    url?: string;
  }
  const navBars: { df: DFile; cls?: DClass; items: NavItem[]; pos: number }[] = [];
  const labelOf = (df: DFile, from: number, to: number): { value: string; file: string; line: number } | undefined => {
    const seg = df.code.slice(from, to);
    const lit = /\b(?:label|text|tooltip)\s*:\s*(?:const\s+)?(?:Text\s*\(\s*)?(r?['"])([^'"$]+)\1/.exec(seg) ?? /\bTab\s*\(\s*text\s*:\s*(['"])([^'"$]+)\1/.exec(seg) ?? /\btitle\s*:\s*(?:const\s+)?Text\s*\(\s*(['"])([^'"$]+)\1/.exec(seg);
    if (lit) return { value: lit[2], file: df.file.id, line: df.lineOf(from + (lit.index ?? 0)) };
    const l = /(?:AppLocalizations\.of\s*\(\s*context\s*\)\s*[!?]?|S\.of\s*\(\s*context\s*\)|S\.current|context\.l10n|l10n|loc|t)\s*\.\s*(\w+)/.exec(seg);
    if (l && l10n.has(l[1])) {
      const v = l10n.get(l[1])!;
      return { value: v.value, file: v.file, line: v.line };
    }
    return undefined;
  };
  for (const df of files.values()) {
    for (const bm of df.skel.matchAll(/\b(BottomNavigationBar|NavigationBar|NavigationRail|CupertinoTabBar|TabBar|BottomNavyBar|SalomonBottomBar|GNav|CurvedNavigationBar)\s*\(/g)) {
      const open = (bm.index ?? 0) + bm[0].length - 1;
      const close = closeOf(df.skel, open);
      const argsR = splitArgs(df.skel, open + 1, close);
      const listArg = argsR.find((a) => /^\s*(items|destinations|tabs)\s*:/.test(df.skel.slice(a.from, a.to)));
      if (!listArg) continue;
      const lo = df.skel.indexOf('[', listArg.from);
      if (lo < 0 || lo > listArg.to) continue;
      const lc = closeOf(df.skel, lo);
      const items: NavItem[] = [];
      for (const it of splitArgs(df.skel, lo + 1, lc)) {
        const lab = labelOf(df, it.from, it.to);
        items.push({ ...(lab ? { label: lab.value, labelAt: { file: lab.file, line: lab.line } } : {}), pos: it.from, df });
      }
      const cls = df.classes.find((c) => c.body.from <= open && open <= c.body.to);
      // 탭 순서와 같은 화면 목록: _pages = [HomeScreen(), …] / IndexedStack(children: […]) / TabBarView(children: […])
      const scope = cls ? (stateOfWidget.get(cls) ? [cls, stateOfWidget.get(cls)!] : widgetOfState.get(cls) ? [cls, widgetOfState.get(cls)!] : [cls]) : [];
      const lists: string[][] = [];
      for (const sc of scope.length ? scope : [undefined]) {
        const from = sc ? sc.body.from : 0;
        const to = sc ? sc.body.to : df.skel.length;
        const text = df.skel.slice(from, to);
        for (const lm of text.matchAll(/(?:=\s*(?:const\s+)?(?:<\w+>\s*)?\[|\b(?:IndexedStack|TabBarView|PageView)\s*\([^)]*?children\s*:\s*(?:const\s+)?(?:<\w+>\s*)?\[)/g)) {
          const lo2 = from + (lm.index ?? 0) + lm[0].length - 1;
          const lc2 = closeOf(df.skel, lo2);
          const names = splitArgs(df.skel, lo2 + 1, lc2).map((p) => /^\s*(?:const\s+)?([A-Z][\w$]*)\s*\(/.exec(df.skel.slice(p.from, p.to))?.[1]).filter((x): x is string => !!x && !!unitByClass(x, df) && isWidget(unitByClass(x, df)!));
          if (names.length >= 2) lists.push(names);
        }
        // switch (index) { case 0: context.go('/home'); … } / [ '/a', '/b' ][i]
        const cases = [...text.matchAll(/case\s+(\d+)\s*:[\s\S]{0,120}?(?:\.go|\.push|\.goNamed|pushNamed|\.toNamed|Get\.to)\s*\(\s*(?:context\s*,\s*)?(['"]?)([^'")]+)\2/g)];
        if (cases.length >= 2) {
          for (const c of cases) {
            const idx = Number(c[1]);
            if (items[idx] && !items[idx].url) items[idx].url = c[2] ? c[3] : resolveConst(c[3]);
          }
        }
      }
      const pages = lists.find((l) => l.length === items.length) ?? lists[0];
      if (pages) items.forEach((it, i) => {
        if (pages[i]) it.target = pages[i];
      });
      navBars.push({ df, ...(cls ? { cls } : {}), items, pos: open });
    }
    // Drawer ListTile(title: Text('주문'), onTap: () => Navigator.pushNamed(context, '/orders'))
    for (const dm of df.skel.matchAll(/\bDrawer\s*\(/g)) {
      const open = (dm.index ?? 0) + dm[0].length - 1;
      const close = closeOf(df.skel, open);
      const items: NavItem[] = [];
      for (const tm of df.skel.slice(open, close).matchAll(/\b(ListTile|NavigationDrawerDestination|DrawerItem)\s*\(/g)) {
        const to = open + (tm.index ?? 0) + tm[0].length - 1;
        const tc = closeOf(df.skel, to);
        const lab = labelOf(df, to, tc);
        if (!lab) continue;
        const seg = df.code.slice(to, tc);
        const nav = /(?:\.go|\.push|\.goNamed|pushNamed|pushReplacementNamed|\.toNamed)\s*\(\s*(?:context\s*,\s*)?(['"])([^'"]+)\1/.exec(seg);
        const widget = firstWidget(df, to + 1, tc);
        items.push({ label: lab.value, labelAt: { file: lab.file, line: lab.line }, pos: to, df, ...(nav ? { url: nav[2] } : {}), ...(widget ? { target: widget } : {}) });
      }
      if (items.length) navBars.push({ df, items, pos: open });
    }
  }
  // StatefulShellRoute 가지 순서 = 탭 순서
  const branchRoots = routes.filter((r) => r.branch !== undefined && !r.parent).sort((a, b) => a.branch! - b.branch!);
  for (const nb of navBars) {
    if (nb.items.some((i) => i.target || i.url) || !branchRoots.length) continue;
    nb.items.forEach((it, i) => {
      const br = branchRoots.find((b) => b.branch === i);
      if (br) {
        if (br.path) it.url = br.path;
        if (br.widget) it.target = br.widget;
      }
    });
  }

  // ---------------------------------------------------------------- 화면
  interface Screen {
    cls: DClass;
    entryCls: DClass;
    title?: { value: string; file: string; line: number };
    url?: string;
  }
  const screens = new Map<string, Screen>(); // 파일 ID → 화면
  const isScreenName = (n: string) => /(Screen|Page|View)$/.test(n) && !/(Item|Tile|Card|Cell|Row|Widget|Dialog|Sheet|Button|Bar|ListView|PageView|ScrollView|WebView|TextView)$/.test(n);
  const titleIn = (c: DClass): Screen['title'] => {
    for (const cc of [c, stateOfWidget.get(c)].filter((x): x is DClass => !!x)) {
      const seg = cc.file.code.slice(cc.body.from, cc.body.to);
      const m = /\b(?:AppBar|SliverAppBar|CupertinoNavigationBar|CupertinoSliverNavigationBar)\s*\(([\s\S]{0,400})/.exec(seg);
      if (!m) continue;
      const inner = m[1];
      const from = cc.body.from + (m.index ?? 0);
      const lit = /\b(?:title|middle|largeTitle)\s*:\s*(?:const\s+)?Text\s*\(\s*(r?['"])([^'"$]+)\1/.exec(inner);
      if (lit) return { value: lit[2], file: cc.file.file.id, line: cc.file.lineOf(from + (lit.index ?? 0)) };
      const l = /\b(?:title|middle|largeTitle)\s*:\s*(?:const\s+)?Text\s*\(\s*(?:AppLocalizations\.of\s*\(\s*context\s*\)\s*[!?]?|S\.of\s*\(\s*context\s*\)|S\.current|context\.l10n|l10n|loc)\s*\.\s*(\w+)/.exec(inner);
      if (l && l10n.has(l[1])) {
        const v = l10n.get(l[1])!;
        return { value: v.value, file: v.file, line: v.line };
      }
    }
    return undefined;
  };
  const tabTargets = new Set(navBars.flatMap((n) => n.items.map((i) => i.target).filter((x): x is string => !!x)));
  for (const c of classes) {
    if (!isWidget(c) || !c.unit) continue;
    const route = routeOfWidget.get(c.name);
    const routePage = c.anns.some((a) => a.name === 'RoutePage');
    if (!route && !routePage && !tabTargets.has(c.name) && !isScreenName(c.name)) continue;
    if (!route && !routePage && !tabTargets.has(c.name)) {
      // 이름만 화면 같은 위젯: Scaffold가 있어야
      const cc = stateOfWidget.get(c) ?? c;
      if (!/\bScaffold\s*\(|\bCupertinoPageScaffold\s*\(/.test(cc.file.code.slice(cc.body.from, cc.body.to))) continue;
    }
    if (screens.has(c.file.file.id)) continue;
    const entryCls = stateOfWidget.get(c) ?? c;
    const t = titleIn(c);
    screens.set(c.file.file.id, { cls: c, entryCls, ...(t ? { title: t } : {}), ...(route?.path ? { url: route.path.startsWith('/') ? route.path : `/${route.path}` } : {}) });
  }

  // ---------------------------------------------------------------- 메뉴
  const menus: MenuFact[] = [];
  const screenOfWidget = (name: string | undefined, df: DFile) => {
    const c = name ? unitByClass(name, df) : undefined;
    return c ? screens.get(c.file.file.id) : undefined;
  };
  const screenOfUrl = (url: string | undefined) => {
    if (!url) return undefined;
    const r = routes.find((x) => x.path === url || (x.path && `/${x.path.replace(/^\//, '')}` === `/${url.replace(/^\//, '')}`));
    return r ? screenOfWidget(r.widget, r.df) : undefined;
  };
  let order = 0;
  for (const nb of navBars) {
    nb.items.forEach((it, i) => {
      const sc = screenOfWidget(it.target, it.df) ?? screenOfUrl(it.url);
      const name = cleanLabel(it.label) ?? cleanLabel(sc?.title?.value) ?? (sc ? screenNameOf(sc.cls.name) : undefined);
      if (!name) return;
      const key = `flutter:${nb.df.file.id}:${nb.pos}:${i}`;
      menus.push({ key, name, order: order++, source: 'code', evidence: { file: it.labelAt?.file ?? nb.df.file.id, line: it.labelAt?.line ?? nb.df.lineOf(it.pos) }, ...(it.url ? { url: it.url } : sc?.url ? { url: sc.url } : {}), ...(sc ? { view: sc.cls.file.file.id } : {}) });
      // 탭 경로의 하위 GoRoute → 하위 메뉴
      const route = sc ? routeOfWidget.get(sc.cls.name) : routes.find((x) => x.path === it.url);
      let k = 0;
      for (const child of route?.children ?? []) {
        const cs = screenOfWidget(child.widget, child.df);
        if (!cs) continue;
        menus.push({ key: `${key}/${k}`, parentKey: key, name: cleanLabel(cs.title?.value) ?? screenNameOf(cs.cls.name), order: k++, source: 'code', evidence: { file: child.df.file.id, line: child.df.lineOf(child.pos) }, ...(cs.url ? { url: cs.url } : {}), view: cs.cls.file.file.id });
      }
    });
  }
  ctx.facts.menus.push(...menus);

  // ---------------------------------------------------------------- 화면 사실
  for (const sc of screens.values()) {
    const { cls, entryCls } = sc;
    const f = cls.file.file;
    const units = [cls, entryCls].filter((x, i, a) => a.indexOf(x) === i);
    for (const u of units) if (u.unit && u.unit.kind !== 'dao') u.unit.kind = 'controller';
    f.layer = 'VIEW';
    let entry = entryCls.unit!.methods.find((m) => m.name === 'build');
    if (!entry) {
      entry = newMethod('build', cls.file.lineOf(cls.pos));
      entryCls.unit!.methods.push(entry);
    }
    if (!entry.views.includes(f.path)) entry.views.push(f.path);
    for (const u of units) for (const m of u.unit!.methods) {
      if (m === entry || entry.calls.some((c) => c.method === m.name && c.via === u.unit!.fqn)) continue;
      entry.calls.push({ via: u.unit!.fqn!, method: m.name, line: m.line });
    }
    // 화면 위젯이 받는 뷰모델·컨트롤러: 생성자(init)에서 데이터를 불러오는 경우
    for (const u of units) for (const t of Object.values(u.unit!.fields)) {
      const fc = t ? unitByClass(t, u.file) : undefined;
      if (!fc?.unit || fc === cls || fc === entryCls || screens.has(fc.file.file.id)) continue;
      if (fc.unit.methods.some((x) => x.name === 'init') && !entry.calls.some((c) => c.via === viaOf(fc) && c.method === 'init')) entry.calls.push({ via: viaOf(fc), method: 'init', line: entry.line });
    }
    const label = cleanLabel(sc.title?.value);
    ctx.facts.views.push({
      file: f.id,
      kind: 'app',
      platform: 'Flutter',
      group: featureGroup(f.path, `${cls.file.root.dir}/lib`),
      title: label ?? screenNameOf(cls.name),
      ...(label && sc.title ? { titleLine: sc.title.line, titleFile: sc.title.file } : {}),
      urls: webviews.get(f.id) ?? [],
      includes: [],
      scripts: [],
      ...(sc.url ? { directUrl: sc.url } : {}),
    });
  }

  // 화면 → 다른 화면 위젯 호출(탭 묶음 화면이 각 탭 화면을 품는 경우)은 끊음: 각 탭 화면이 따로 가짐
  const screenFqns = new Map<string, string>();
  for (const sc of screens.values()) for (const c of [sc.cls, sc.entryCls]) if (c.unit?.fqn) screenFqns.set(c.unit.fqn, sc.cls.file.file.id);
  for (const sc of screens.values()) {
    const own = sc.cls.file.file.id;
    for (const c of [sc.cls, sc.entryCls]) for (const m of c.unit?.methods ?? []) {
      m.calls = m.calls.filter((x) => (screenFqns.get(x.via) ?? own) === own);
    }
  }

  // 빈 필드 메서드(초기화식에 호출 없음) 정리
  for (const r of regs) {
    if (!r.pseudo) continue;
    const m = r.m;
    if (m.calls.length || m.sql.length || m.httpCalls?.length) continue;
    const i = r.unit.methods.indexOf(m);
    if (i >= 0 && !ctx.facts.units.some((u) => u.methods.some((x) => x.calls.some((c) => c.via === r.unit.fqn && c.method === m.name)))) r.unit.methods.splice(i, 1);
  }
  // HTTP·SQL을 가진 클래스는 데이터 접근
  for (const c of classes) {
    const u = c.unit;
    if (!u || u.kind !== 'other' || screens.has(c.file.file.id)) continue;
    if (u.methods.some((m) => m.httpCalls?.length || m.sql.length)) {
      u.kind = 'dao';
      if (c.file.file.layer === 'OTHER') c.file.file.layer = 'DAO';
    }
  }
  if (screens.size) ctx.hit('앱', 'Flutter', [...screens.values()][0].cls.file.file.id, 1, 1);
}

/** 필드 타입 추정: final _repo = OrderRepository(); final dio = Dio(BaseOptions(…)) */
function inferType(df: DFile, mem: DMember): string {
  if (!mem.body) return '';
  const init = df.code.slice(mem.body.from, Math.min(mem.body.to, mem.body.from + 300));
  const m = /^\s*(?:await\s+)?(?:const\s+)?(?:Get\.(?:put|find)\s*(?:<\s*([A-Z][\w$]*)\s*>)?\s*\(\s*)?([A-Z][\w$]*)\s*(?:\.\w+)?\s*[(<]/.exec(init);
  if (m) return m[1] ?? m[2];
  const g = /\b(?:read|watch|find|get|locator|getIt|sl)\s*<\s*([A-Z][\w$]*)/.exec(init);
  return g?.[1] ?? '';
}

/** 인자 식의 끝 (같은 깊이의 , ) ;) */
function stmtArgEnd(s: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return i;
  }
  return to;
}
