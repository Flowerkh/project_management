// Kotlin 분석기: 클래스·object·인터페이스·최상위 함수·생성자 주입 프로퍼티·애노테이션을 CodeUnit으로.
// Android MVVM(Activity·Fragment → ViewModel → Repository → Room DAO·Retrofit API)과 Spring Kotlin 일부(라우트·JPA)를 다룬다.
// analyze: 파일 구조와 CodeUnit(필드·메서드 골격). 호출 해석은 모든 파일을 본 뒤 resolveKotlinCalls()에서 (android 분석기 finish가 부름).
import type { Analyzer, Ctx } from '../context';
import type { CallRef, CodeUnit, MethodUnit, Route } from '../types';
import { baseName, makeLineIndex } from '../files';
import { blankStrings, snake, stripCComments } from './jutil';
import { closeOf, newMethod, skipAngles, splitArgs, stateOf, unescapeStr } from './applib';

// ------------------------------------------------------------------ 구조

export interface KtAnn {
  name: string;
  /** 괄호 안 원문 (문자열 그대로) */
  args: string;
  start: number;
}

export interface KtParam {
  name: string;
  type: string;
  prop: boolean;
}

export interface Region {
  from: number;
  to: number;
}

export interface KtFun {
  name: string;
  namePos: number;
  anns: KtAnn[];
  mods: string;
  params: KtParam[];
  ret: string;
  receiver?: string;
  body?: Region;
  method?: MethodUnit;
}

export interface KtProp {
  name: string;
  namePos: number;
  type?: string;
  anns: KtAnn[];
  mods: string;
  init?: Region;
  delegate?: Region;
  getter?: Region;
  method?: MethodUnit;
}

export interface KtClass {
  kw: 'class' | 'interface' | 'object';
  mods: string;
  name: string;
  namePos: number;
  anns: KtAnn[];
  params: KtParam[];
  supers: { name: string; typeArgs: string[]; args?: Region }[];
  funs: KtFun[];
  props: KtProp[];
  classes: KtClass[];
  inits: Region[];
  /** enum 항목: 이름과 인자 위치 */
  entries: { name: string; pos: number; args?: Region }[];
  body?: Region;
  companion?: KtClass;
  unit?: CodeUnit;
}

export interface KtFile {
  fileId: string;
  path: string;
  code: string;
  skel: string;
  pkg: string;
  imports: Map<string, string>;
  classes: KtClass[];
  funs: KtFun[];
  props: KtProp[];
  inits: Region[];
  fileUnit?: CodeUnit;
  lineOf: (o: number) => number;
}

interface Block {
  funs: KtFun[];
  props: KtProp[];
  classes: KtClass[];
  inits: Region[];
  entries?: KtClass['entries'];
}

/** 호출 해석 대기 영역: 메서드 몸체·프로퍼티 초기화식 */
export interface KtRegion {
  kf: KtFile;
  cls?: KtClass;
  unit: CodeUnit;
  m: MethodUnit;
  regions: Region[];
  params: Map<string, string>;
  /** 프로퍼티 초기화식으로 만든 메서드 (비면 지움) */
  pseudo?: boolean;
  fn?: KtFun;
  prop?: KtProp;
}

export interface KtState {
  files: Map<string, KtFile>;
  regions: KtRegion[];
  /** 상수 이름(Name, Owner.Name) → 값들 */
  consts: Map<string, { value: string; file: string }[]>;
  classOfUnit: Map<CodeUnit, { kf: KtFile; cls?: KtClass }>;
  resolved: boolean;
}

const STATE = new WeakMap<object, KtState>();
export function ktState(ctx: Ctx): KtState {
  return stateOf(ctx.facts, STATE, () => ({ files: new Map(), regions: [], consts: new Map(), classOfUnit: new Map(), resolved: false }));
}

// ------------------------------------------------------------------ 파서

function isWordStart(s: string, i: number): boolean {
  return /[A-Za-z_]/.test(s[i]) && (i === 0 || !/[\w$.`]/.test(s[i - 1]));
}

function wordAt(s: string, i: number): string {
  return /^[A-Za-z_]\w*/.exec(s.slice(i, i + 80))?.[0] ?? '';
}

function skipWs(s: string, i: number, nl = false): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || (nl && s[i] === '\n'))) i++;
  return i;
}

/** 식이 끝나는 위치 (Kotlin 줄바꿈 규칙: 연산자로 끝나거나 다음 줄이 . ?. ?: && || else 로 시작하면 이어짐) */
export function exprEnd(s: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') {
      i = closeOf(s, i, to) + 1;
      continue;
    }
    if (c === ')' || c === ']' || c === '}' || c === ';') return i;
    if (c === '\n') {
      let p = i - 1;
      while (p >= from && (s[p] === ' ' || s[p] === '\t' || s[p] === '\r')) p--;
      let n = i + 1;
      while (n < to && /\s/.test(s[n])) n++;
      if (p < from || /[=+\-*/%&|.,(:?]/.test(s[p])) {
        i++;
        continue;
      }
      if (n < to && (s[n] === '.' || s[n] === '?' || s.startsWith('&&', n) || s.startsWith('||', n) || /^(else|catch|finally)\b/.test(s.slice(n, n + 8)))) {
        i = n;
        continue;
      }
      return i;
    }
    i++;
  }
  return to;
}

function annotationsIn(code: string, skel: string, from: number, to: number): KtAnn[] {
  const out: KtAnn[] = [];
  const re = /@(?:[A-Za-z_]\w*:)?([A-Za-z_][\w.]*)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skel)) && m.index < to) {
    const name = m[1].slice(m[1].lastIndexOf('.') + 1);
    let end = m.index + m[0].length;
    let args = '';
    if (skel[end] === '(') {
      const e = closeOf(skel, end, to);
      args = code.slice(end + 1, e);
      end = e + 1;
      re.lastIndex = end;
    }
    out.push({ name, args, start: m.index });
  }
  return out;
}

function parseParams(code: string, skel: string, from: number, to: number): KtParam[] {
  const out: KtParam[] = [];
  for (const part of splitArgs(skel, from, to)) {
    let seg = skel.slice(part.from, part.to);
    // 애노테이션 지우기
    seg = seg.replace(/@(?:\w+:)?[\w.]+(\([^)]*\))?/g, ' ');
    const m = /^\s*(?:(?:vararg|noinline|crossinline|private|public|protected|internal|override|open|final|lateinit)\s+)*(val|var)?\s*([A-Za-z_]\w*)\s*:\s*([\s\S]+?)\s*(?:=[\s\S]*)?$/.exec(seg);
    if (!m) continue;
    out.push({ name: m[2], type: cleanType(m[3]), prop: !!m[1] });
  }
  return out;
}

/** 타입 표기 정리 (널 가능 표시·공백 제거, 제네릭은 남김) */
export function cleanType(t: string): string {
  return t.replace(/\s+/g, ' ').replace(/\?$/, '').replace(/^@\S+\s+/, '').trim();
}

/** 타입의 단순 이름 (List<Product> → List, com.x.Repo → Repo) */
export function simpleType(t: string): string {
  const g = t.replace(/<[\s\S]*$/, '').replace(/[?!]/g, '').trim();
  return g.slice(g.lastIndexOf('.') + 1);
}

function scanBlock(kf: KtFile, from: number, to: number, out: Block, isEnum = false): void {
  const s = kf.skel;
  let i = from;
  let declStart = from;
  // enum 항목: 본문 첫 ';' 앞까지
  if (isEnum && out.entries) {
    let j = from;
    let semi = -1;
    while (j < to) {
      const c = s[j];
      if (c === '(' || c === '{' || c === '[') {
        j = closeOf(s, j, to) + 1;
        continue;
      }
      if (c === ';') {
        semi = j;
        break;
      }
      if (isWordStart(s, j) && /^(fun|val|var|companion|override|private|abstract|init)$/.test(wordAt(s, j))) break;
      j++;
    }
    const end = semi >= 0 ? semi : j;
    for (const part of splitArgs(s, from, end)) {
      const em = /^\s*(?:@\w+\s*)*([A-Z_][\w]*)\s*(\()?/.exec(s.slice(part.from, part.to));
      if (!em) continue;
      const pos = part.from + s.slice(part.from, part.to).indexOf(em[1]);
      let args: Region | undefined;
      if (em[2]) {
        const open = part.from + em[0].length - 1;
        args = { from: open + 1, to: closeOf(s, open, part.to) };
      }
      out.entries.push({ name: em[1], pos, ...(args ? { args } : {}) });
    }
    i = semi >= 0 ? semi + 1 : from;
    declStart = i;
  }
  while (i < to) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') {
      const e = closeOf(s, i, to);
      if (c === '{' && /\binit\s*$/.test(s.slice(Math.max(from, i - 12), i))) out.inits.push({ from: i + 1, to: e });
      i = e + 1;
      declStart = i;
      continue;
    }
    if (c === ';' || c === '}') {
      i++;
      declStart = i;
      continue;
    }
    if (c === '@') {
      const m = /^@(?:[A-Za-z_]\w*:)?[A-Za-z_][\w.]*/.exec(s.slice(i, i + 200));
      if (m) {
        let j = i + m[0].length;
        if (s[j] === '(') j = closeOf(s, j, to) + 1;
        i = j;
        continue;
      }
      i++;
      continue;
    }
    if (!isWordStart(s, i)) {
      i++;
      continue;
    }
    const w = wordAt(s, i);
    if (w === 'package' || w === 'import' || w === 'typealias') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? to : e + 1;
      declStart = i;
      continue;
    }
    let kw = w;
    let kwPos = i;
    if (w === 'fun' && /^\s+interface\b/.test(s.slice(i + 3, i + 20))) {
      kw = 'interface';
      kwPos = s.indexOf('interface', i);
    }
    if (kw === 'class' || kw === 'interface' || kw === 'object') {
      const r = parseClass(kf, declStart, kwPos, kw, to);
      if (r) {
        const mods = s.slice(declStart, kwPos);
        if (kw === 'object' && /\bcompanion\b/.test(mods)) {
          // companion object: 바깥 클래스에 합침
          out.funs.push(...r.cls.funs);
          out.props.push(...r.cls.props);
          out.inits.push(...r.cls.inits);
          out.classes.push(...r.cls.classes);
        } else if (r.cls.name) out.classes.push(r.cls);
        i = r.end;
        declStart = i;
        continue;
      }
    } else if (kw === 'fun') {
      const r = parseFun(kf, declStart, kwPos, to);
      if (r) {
        out.funs.push(r.fn);
        i = r.end;
        declStart = i;
        continue;
      }
    } else if (kw === 'val' || kw === 'var') {
      const r = parseProp(kf, declStart, kwPos, to);
      if (r) {
        if (r.prop.name) out.props.push(r.prop);
        i = r.end;
        declStart = i;
        continue;
      }
    } else if (kw === 'constructor') {
      // 보조 생성자: 매개변수와 몸체 건너뜀
      let j = skipWs(s, i + kw.length);
      if (s[j] === '(') j = closeOf(s, j, to) + 1;
      j = skipWs(s, j);
      if (s[j] === ':') {
        const k = s.slice(j, to).search(/[({]/);
        j = k < 0 ? to : j + k;
        if (s[j] === '(') j = closeOf(s, j, to) + 1;
        j = skipWs(s, j);
      }
      if (s[j] === '{') {
        const e = closeOf(s, j, to);
        out.inits.push({ from: j + 1, to: e });
        j = e + 1;
      }
      i = j;
      declStart = i;
      continue;
    }
    i += Math.max(1, w.length);
  }
}

function readName(s: string, i: number): { name: string; pos: number; end: number } | null {
  const j = skipWs(s, i);
  if (s[j] === '`') {
    const e = s.indexOf('`', j + 1);
    if (e < 0) return null;
    return { name: s.slice(j + 1, e), pos: j, end: e + 1 };
  }
  const m = /^[A-Za-z_]\w*/.exec(s.slice(j, j + 120));
  return m ? { name: m[0], pos: j, end: j + m[0].length } : null;
}

function parseClass(kf: KtFile, declStart: number, kwPos: number, kw: 'class' | 'interface' | 'object', to: number): { cls: KtClass; end: number } | null {
  const s = kf.skel;
  let i = kwPos + kw.length;
  const mods = s.slice(declStart, kwPos);
  const nm = readName(s, i);
  let name = '';
  let namePos = kwPos;
  if (nm && !/^(constructor)$/.test(nm.name)) {
    name = nm.name;
    namePos = nm.pos;
    i = nm.end;
  } else if (kw === 'object' && /\bcompanion\b/.test(mods)) {
    name = '';
  } else if (kw === 'object') {
    // object : Foo {…} 식 — 여기서는 건너뜀
    return null;
  } else return null;
  if (name === 'object' || name === 'class') return null;
  const cls: KtClass = {
    kw, mods: mods.replace(/\s+/g, ' ').trim(), name, namePos, anns: annotationsIn(kf.code, s, declStart, kwPos), params: [], supers: [],
    funs: [], props: [], classes: [], inits: [], entries: [],
  };
  let j = skipWs(s, i);
  if (s[j] === '<') j = skipAngles(s, j, to);
  // 기본 생성자 앞 애노테이션·가시성·constructor
  const cm = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:private|protected|internal|public)\s+)?constructor\s*(?=\()/.exec(s.slice(j, j + 300));
  if (cm) j += cm[0].length;
  j = skipWs(s, j);
  if (s[j] === '(') {
    const e = closeOf(s, j, to);
    cls.params = parseParams(kf.code, s, j + 1, e);
    j = e + 1;
  }
  // 상위 타입
  let k = skipWs(s, j, true);
  if (s[k] === ':') {
    k++;
    let segStart = k;
    const pushSuper = (a: number, b: number) => {
      const seg = s.slice(a, b);
      const sm = /^\s*([A-Za-z_][\w.]*)\s*(<)?/.exec(seg);
      if (!sm) return;
      let typeArgs: string[] = [];
      let p = a + sm[0].length;
      if (sm[2]) {
        const open = p - 1;
        const close = skipAngles(s, open, b);
        typeArgs = splitArgs(s, open + 1, close - 1).map((r) => cleanType(s.slice(r.from, r.to)));
        p = close;
      }
      p = skipWs(s, p);
      let args: Region | undefined;
      if (s[p] === '(') args = { from: p + 1, to: closeOf(s, p, b + 1) };
      cls.supers.push({ name: sm[1].slice(sm[1].lastIndexOf('.') + 1), typeArgs, ...(args ? { args } : {}) });
    };
    while (k < to) {
      const ch = s[k];
      if (ch === '(' || ch === '[') {
        k = closeOf(s, k, to) + 1;
        continue;
      }
      if (ch === '<') {
        const n = skipAngles(s, k, to);
        if (n > k + 1) {
          k = n;
          continue;
        }
      }
      if (ch === '{' || ch === '}' || ch === ';') break;
      if (ch === ',') {
        pushSuper(segStart, k);
        segStart = k + 1;
      } else if (ch === '\n') {
        let p = k - 1;
        while (p > segStart && /[ \t\r]/.test(s[p])) p--;
        const n = skipWs(s, k, true);
        if (!/[,:(]/.test(s[p]) && s[n] !== ',' && s[n] !== '{' && !/^where\b/.test(s.slice(n, n + 6))) break;
      } else if (isWordStart(s, k) && wordAt(s, k) === 'where') {
        pushSuper(segStart, k);
        segStart = -1;
        const b = s.slice(k, to).search(/[{\n]/);
        k = b < 0 ? to : k + b;
        continue;
      } else if (isWordStart(s, k) && wordAt(s, k) === 'by') {
        // 위임: Foo by bar (식은 이름·호출 하나)
        pushSuper(segStart, k);
        segStart = -1;
        const dm = /^\s*[A-Za-z_][\w.]*/.exec(s.slice(k + 2, k + 200));
        k = k + 2 + (dm ? dm[0].length : 0);
        if (s[skipWs(s, k)] === '(') k = closeOf(s, skipWs(s, k), to) + 1;
        continue;
      }
      k++;
    }
    if (segStart >= 0) pushSuper(segStart, k);
    j = k;
  }
  k = skipWs(s, j, true);
  let end = j;
  if (s[k] === '{') {
    const e = closeOf(s, k, to);
    cls.body = { from: k + 1, to: e };
    const isEnum = /\benum\b/.test(cls.mods);
    scanBlock(kf, k + 1, e, cls, isEnum);
    end = e + 1;
  }
  return { cls, end };
}

function parseFun(kf: KtFile, declStart: number, kwPos: number, to: number): { fn: KtFun; end: number } | null {
  const s = kf.skel;
  let i = skipWs(s, kwPos + 3);
  if (s[i] === '<') i = skipAngles(s, i, to);
  // 수신 타입.이름 ( … )
  let j = i;
  let paren = -1;
  while (j < to) {
    const ch = s[j];
    if (ch === '<') {
      const n = skipAngles(s, j, to);
      if (n > j + 1) {
        j = n;
        continue;
      }
    }
    if (ch === '`') {
      const e = s.indexOf('`', j + 1);
      j = e < 0 ? to : e + 1;
      continue;
    }
    if (ch === '(') {
      paren = j;
      break;
    }
    if (ch === '{' || ch === '=' || ch === '\n' || ch === ';' || ch === '}') return null;
    j++;
  }
  if (paren < 0) return null;
  const head = s.slice(i, paren).trim();
  const dot = head.lastIndexOf('.');
  let name = (dot >= 0 ? head.slice(dot + 1) : head).trim().replace(/^`|`$/g, '');
  if (!name) return null;
  const nameOff = s.indexOf(name, i);
  const close = closeOf(s, paren, to);
  const fn: KtFun = {
    name, namePos: nameOff >= 0 ? nameOff : i, anns: annotationsIn(kf.code, s, declStart, kwPos), mods: s.slice(declStart, kwPos).replace(/@[\w.:]+(\([^)]*\))?/g, ' ').replace(/\s+/g, ' ').trim(),
    params: parseParams(kf.code, s, paren + 1, close), ret: '', ...(dot >= 0 ? { receiver: head.slice(0, dot).trim() } : {}),
  };
  let k = skipWs(s, close + 1);
  if (s[k] === ':') {
    let e = k + 1;
    while (e < to) {
      const ch = s[e];
      if (ch === '(' || ch === '[') {
        e = closeOf(s, ch === '(' ? e : e, to) + 1;
        continue;
      }
      if (ch === '<') {
        const n = skipAngles(s, e, to);
        if (n > e + 1) {
          e = n;
          continue;
        }
      }
      if (ch === '{' || ch === '}' || ch === ';' || ch === '\n' || (ch === '=' && s[e + 1] !== '=' && s[e - 1] !== '-')) break;
      if (isWordStart(s, e) && wordAt(s, e) === 'where') break;
      e++;
    }
    fn.ret = cleanType(s.slice(k + 1, e));
    k = e;
  }
  if (isWordStart(s, k) && wordAt(s, k) === 'where') {
    const b = s.slice(k, to).search(/[{=\n]/);
    k = b < 0 ? to : k + b;
  }
  k = skipWs(s, k);
  let end = k;
  if (s[k] === '{' || (s[k] === '\n' && s[skipWs(s, k, true)] === '{')) {
    const open = s[k] === '{' ? k : skipWs(s, k, true);
    const e = closeOf(s, open, to);
    fn.body = { from: open + 1, to: e };
    end = e + 1;
  } else if (s[k] === '=') {
    const e = exprEnd(s, k + 1, to);
    fn.body = { from: k + 1, to: e };
    end = e;
  }
  return { fn, end };
}

function parseProp(kf: KtFile, declStart: number, kwPos: number, to: number): { prop: KtProp; end: number } | null {
  const s = kf.skel;
  let i = skipWs(s, kwPos + 3);
  if (s[i] === '<') i = skipAngles(s, i, to);
  if (s[i] === '(') {
    // 구조 분해 val (a, b) = …
    const e = closeOf(s, i, to);
    const k = skipWs(s, e + 1);
    const end = s[k] === '=' ? exprEnd(s, k + 1, to) : e + 1;
    return { prop: { name: '', namePos: i, anns: [], mods: '' }, end };
  }
  // 수신 타입.이름
  const hm = /^([A-Za-z_][\w]*(?:<[^=\n]*?>)?\??\.)?([A-Za-z_]\w*)/.exec(s.slice(i, i + 200));
  if (!hm) return null;
  const name = hm[2];
  const namePos = i + hm[0].length - name.length;
  let j = i + hm[0].length;
  const prop: KtProp = { name, namePos, anns: annotationsIn(kf.code, s, declStart, kwPos), mods: s.slice(declStart, kwPos).replace(/@[\w.:]+(\([^)]*\))?/g, ' ').replace(/\s+/g, ' ').trim() };
  j = skipWs(s, j);
  if (s[j] === ':') {
    let e = j + 1;
    while (e < to) {
      const ch = s[e];
      if (ch === '(' || ch === '[') {
        e = closeOf(s, e, to) + 1;
        continue;
      }
      if (ch === '<') {
        const n = skipAngles(s, e, to);
        if (n > e + 1) {
          e = n;
          continue;
        }
      }
      if (ch === '=' || ch === '\n' || ch === ';' || ch === '{' || ch === '}') break;
      if (isWordStart(s, e) && wordAt(s, e) === 'by') break;
      e++;
    }
    prop.type = cleanType(s.slice(j + 1, e));
    j = e;
  }
  j = skipWs(s, j);
  let end = j;
  if (s[j] === '=' && s[j + 1] !== '=') {
    const e = exprEnd(s, j + 1, to);
    prop.init = { from: j + 1, to: e };
    end = e;
  } else if (isWordStart(s, j) && wordAt(s, j) === 'by') {
    const e = exprEnd(s, j + 2, to);
    prop.delegate = { from: j + 2, to: e };
    end = e;
  }
  // 게터·세터
  for (let g = 0; g < 2; g++) {
    const n = skipWs(s, end, true);
    const gm = /^(?:(?:private|protected|internal|public|override)\s+)?(get|set)\s*\(/.exec(s.slice(n, n + 40));
    if (!gm) break;
    const open = n + gm[0].length - 1;
    const close = closeOf(s, open, to);
    let k = skipWs(s, close + 1);
    if (s[k] === ':') {
      const b = s.slice(k, to).search(/[{=\n]/);
      k = b < 0 ? to : k + b;
    }
    if (s[k] === '=') {
      const e = exprEnd(s, k + 1, to);
      if (gm[1] === 'get') prop.getter = { from: k + 1, to: e };
      end = e;
    } else if (s[k] === '{') {
      const e = closeOf(s, k, to);
      if (gm[1] === 'get') prop.getter = { from: k + 1, to: e };
      end = e + 1;
    } else {
      end = close + 1;
    }
  }
  return { prop, end };
}

export function parseKotlin(fileId: string, path: string, text: string): KtFile {
  const code = stripCComments(text);
  const skel = blankStrings(code);
  const pkg = /^\s*package\s+([\w.`]+)/m.exec(code)?.[1]?.replace(/`/g, '') ?? '';
  const imports = new Map<string, string>();
  for (const m of code.matchAll(/^\s*import\s+([\w.`]+)(?:\s+as\s+(\w+))?/gm)) {
    const fq = m[1].replace(/`/g, '');
    if (fq.endsWith('.*')) continue;
    imports.set(m[2] ?? fq.slice(fq.lastIndexOf('.') + 1), fq);
  }
  const kf: KtFile = { fileId, path, code, skel, pkg, imports, classes: [], funs: [], props: [], inits: [], lineOf: makeLineIndex(text) };
  scanBlock(kf, 0, skel.length, kf);
  return kf;
}

// ------------------------------------------------------------------ 문자열 식

/** Kotlin·Java 문자열 리터럴 하나 (위치 i의 따옴표부터) → 값과 끝 위치. 템플릿은 resolve로 */
function readLiteral(code: string, i: number, resolve: (n: string) => string | undefined, templates = true): { value: string; end: number } | null {
  if (code.startsWith('"""', i)) {
    const e = code.indexOf('"""', i + 3);
    const raw = code.slice(i + 3, e < 0 ? code.length : e);
    return { value: templates ? templ(raw, resolve) : raw, end: e < 0 ? code.length : e + 3 };
  }
  if (code[i] !== '"') return null;
  let j = i + 1;
  let raw = '';
  while (j < code.length && code[j] !== '"' && code[j] !== '\n') {
    if (code[j] === '\\') {
      raw += code.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (templates && code[j] === '$' && code[j + 1] === '{') {
      const e = code.indexOf('}', j);
      raw += code.slice(j, e < 0 ? j + 2 : e + 1);
      j = e < 0 ? j + 2 : e + 1;
      continue;
    }
    raw += code[j];
    j++;
  }
  return { value: unescapeStr(templates ? templ(raw, resolve) : raw), end: j + 1 };
}

function templ(raw: string, resolve: (n: string) => string | undefined): string {
  return raw
    .replace(/\$\{\s*([A-Za-z_][\w.]*)\s*\}/g, (_, n: string) => resolve(n) ?? '{p}')
    .replace(/\$\{[^}]*\}/g, '{p}')
    .replace(/\$([A-Za-z_]\w*)/g, (_, n: string) => resolve(n) ?? '{p}');
}

/**
 * 문자열 식("a" + CONST + "b", "$BASE/x", """…""".trimIndent()) → 값.
 * 맨 앞의 모르는 변수는 기준 경로로 보고 버리고, 중간의 모르는 값은 {p}. 리터럴·상수가 하나도 없으면 undefined.
 */
export function stringExpr(code: string, from: number, to: number, resolve: (n: string) => string | undefined, templates = true): string | undefined {
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
    if (c === '"') {
      const lit = readLiteral(code, i, resolve, templates);
      if (!lit) break;
      out += lit.value;
      known = true;
      i = lit.end;
      first = false;
      // .trimIndent() .trimMargin() 등
      const tm = /^\s*\.\s*(trimIndent|trimMargin|trim)\s*\(\s*\)/.exec(code.slice(i, i + 40));
      if (tm) i += tm[0].length;
      continue;
    }
    const im = /^[A-Za-z_][\w.]*/.exec(code.slice(i, i + 200));
    if (im) {
      let j = i + im[0].length;
      const v = resolve(im[0]);
      // 함수 호출·인덱스 → 모르는 값
      const after = code.slice(j).match(/^\s*[([]/);
      if (after && v === undefined) {
        const open = j + after[0].length - 1;
        let depth = 0;
        let k = open;
        for (; k < to; k++) {
          if (code[k] === '(' || code[k] === '[') depth++;
          else if (code[k] === ')' || code[k] === ']') {
            depth--;
            if (depth === 0) break;
          }
        }
        j = k + 1;
      }
      if (v !== undefined) {
        out += v;
        known = true;
      } else if (!first) out += '{p}';
      first = false;
      i = j;
      continue;
    }
    // 그 밖의 식은 여기서 멈춤
    break;
  }
  return known ? out : undefined;
}

/** 원문 위치 i의 문자열 리터럴들 → 값 목록 (애노테이션 인자에서 경로 여러 개) */
export function literalsIn(code: string, from: number, to: number, resolve: (n: string) => string | undefined, templates = true): string[] {
  const out: string[] = [];
  let i = from;
  while (i < to) {
    if (code[i] === '"') {
      const lit = readLiteral(code, i, resolve, templates);
      if (!lit) break;
      out.push(lit.value);
      i = lit.end;
      continue;
    }
    i++;
  }
  return out;
}

/** 애노테이션 인자에서 이름 붙은 인자(name = …)나 첫 위치 인자의 원문 범위 */
export function annArg(args: string, name?: string): string | undefined {
  const parts: string[] = [];
  let depth = 0;
  let q = false;
  let cur = '';
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' && args[i - 1] !== '\\') q = !q;
    if (!q) {
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  if (name) {
    for (const p of parts) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*([\\s\\S]*)$`).exec(p);
      if (m) return m[1];
    }
    return undefined;
  }
  const pos = parts.find((p) => !/^\s*\w+\s*=/.test(p));
  return pos;
}

// ------------------------------------------------------------------ CodeUnit 만들기

const MAPPING: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: '*' };
const RETROFIT = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|HTTP)$/;

function joinPath(a: string, b: string): string {
  const x = `/${a}/${b}`.replace(/\/{2,}/g, '/');
  return x.length > 1 ? x.replace(/\/$/, '') : x;
}

function classify(cls: KtClass, kf: KtFile): CodeUnit['kind'] {
  const has = (n: string) => cls.anns.some((a) => a.name === n);
  const name = cls.name;
  const sup = cls.supers.map((x) => x.name);
  if (has('RestController') || has('Controller') || (/Controller$/.test(name) && cls.kw === 'class' && /\bspringframework\b/.test(kf.code))) return 'controller';
  if (cls.kw === 'interface' && sup.some((x) => /^(JpaRepository|CrudRepository|PagingAndSortingRepository|ListCrudRepository|CoroutineCrudRepository|ReactiveCrudRepository|JpaSpecificationExecutor|Repository)$/.test(x))) return 'repository';
  if (has('Mapper') || (cls.kw === 'interface' && /Mapper$/.test(name))) return 'mapper';
  if (has('Dao')) return 'dao';
  if (has('Entity') || has('Table')) return 'model';
  if (cls.funs.some((f) => f.anns.some((a) => RETROFIT.test(a.name)))) return 'dao';
  if (has('Service') || has('UseCase') || /(Service|ServiceImpl|UseCase|Interactor|Manager|Facade)$/.test(name)) return 'service';
  if (has('Repository') || /(Repository|RepositoryImpl|Dao|DAO|DataSource|Store|Api|ApiService|Client)$/.test(name)) return 'dao';
  if (/ViewModel$/.test(name) || sup.some((x) => /^(ViewModel|AndroidViewModel)$/.test(x))) return 'service';
  if (/\bdata\b/.test(cls.mods) || /(Dto|DTO|Vo|VO|Entity|Model|Request|Response)$/.test(name) || /\/(model|models|dto|entity|entities|domain)\//i.test(kf.path)) return 'model';
  return 'other';
}

function typeOfProp(p: KtProp, code: string): string {
  const declared = p.type && !/^(Lazy|ReadOnlyProperty|ReadWriteProperty)\b/.test(p.type) ? p.type : '';
  if (declared) return declared;
  const r = p.init ?? p.delegate;
  if (!r) return '';
  const t = code.slice(r.from, Math.min(r.to, r.from + 400));
  const cls = /\b([A-Z]\w*)\s*::\s*class\b/.exec(t);
  if (cls) return cls[1];
  const gen = /\b(?:viewModels|activityViewModels|navGraphViewModels|hiltViewModel|viewModel|koinViewModel|sharedViewModel|inject|get|lazy)\s*<\s*([A-Z][\w.]*)/.exec(t);
  if (gen) return gen[1];
  const ctor = /^\s*(?:lazy\s*(?:\([^)]*\))?\s*\{\s*)?([A-Z][\w]*)\s*(?:\(|\.\s*(?:getInstance|create|build|newInstance|get|of)\b)/.exec(t);
  if (ctor && !/^(Retrofit|OkHttpClient|Room|Gson|Moshi|Intent|Bundle|Handler|Executors|MutableLiveData|LiveData|MutableStateFlow|StateFlow|MutableSharedFlow|Channel|ArrayList|HashMap|Mutex|Json|Regex|Log)$/.test(ctor[1])) return ctor[1];
  return '';
}

function propRegions(p: KtProp): Region[] {
  return [p.init, p.delegate, p.getter].filter((x): x is Region => !!x);
}

function buildFileUnits(ctx: Ctx, kf: KtFile): void {
  const st = ktState(ctx);
  collectConsts(st, kf, kf.props, '');
  // 최상위 함수·프로퍼티 → 파일 단위 유닛 (HomeScreenKt)
  if (kf.funs.length || kf.props.some((p) => propRegions(p).length)) {
    const base = baseName(kf.path).replace(/\.kts?$/, '');
    const name = `${base.replace(/[^\w]/g, '_')}Kt`;
    const unit = ctx.addUnit({ file: kf.fileId, name, fqn: kf.pkg ? `${kf.pkg}.${name}` : name, kind: 'other', line: 1, extendsOrImplements: [], fields: {}, methods: [] });
    kf.fileUnit = unit;
    st.classOfUnit.set(unit, { kf });
    addMembers(ctx, kf, unit, undefined, kf.funs, kf.props, []);
  }
  const walk = (list: KtClass[], outer?: KtClass) => {
    for (const c of list) {
      buildClassUnit(ctx, kf, c, outer);
      walk(c.classes, c);
    }
  };
  walk(kf.classes);
}

function collectConsts(st: KtState, kf: KtFile, props: KtProp[], owner: string): void {
  for (const p of props) {
    if (!p.init) continue;
    const raw = kf.code.slice(p.init.from, p.init.to).trim();
    if (!/^("|""")/.test(raw) || raw.length > 2000) continue;
    const v = stringExpr(kf.code, p.init.from, p.init.to, () => undefined);
    if (v === undefined || v.includes('{p}')) continue;
    for (const key of owner ? [p.name, `${owner}.${p.name}`] : [p.name]) {
      const list = st.consts.get(key) ?? [];
      list.push({ value: v, file: kf.fileId });
      st.consts.set(key, list);
    }
  }
}

function buildClassUnit(ctx: Ctx, kf: KtFile, c: KtClass, outer?: KtClass): void {
  const st = ktState(ctx);
  if (!c.name) return;
  collectConsts(st, kf, c.props, c.name);
  const kind = classify(c, kf);
  const fqnName = outer ? `${outer.name}.${c.name}` : c.name;
  const fields: Record<string, string> = {};
  for (const p of c.params) fields[p.name] = p.type;
  for (const p of c.props) if (!(p.name in fields)) fields[p.name] = typeOfProp(p, kf.code);
  const unit = ctx.addUnit({
    file: kf.fileId,
    name: c.name,
    fqn: kf.pkg ? `${kf.pkg}.${fqnName}` : fqnName,
    kind,
    line: kf.lineOf(c.namePos),
    extendsOrImplements: c.supers.map((x) => x.name),
    fields,
    methods: [],
  });
  c.unit = unit;
  st.classOfUnit.set(unit, { kf, cls: c });
  const has = (n: string) => c.anns.find((a) => a.name === n);
  const bean = has('Service') ?? has('Repository') ?? has('Component') ?? has('RestController') ?? has('Controller');
  if (bean) unit.beanName = c.name[0].toLowerCase() + c.name.slice(1);
  // Spring 라우트 접두어
  const rm = has('RequestMapping');
  const resolveLocal = (n: string) => st.consts.get(n)?.[0]?.value;
  const pfxArg = rm ? annArg(rm.args, 'value') ?? annArg(rm.args, 'path') ?? annArg(rm.args) : undefined;
  const prefixes = pfxArg ? literalsIn(pfxArg, 0, pfxArg.length, resolveLocal) : [];
  if (prefixes.length) unit.routePrefix = prefixes;
  addMembers(ctx, kf, unit, c, c.funs, c.props, c.inits, prefixes, !!has('RestController'));
  // 테이블 (Room·JPA 엔티티)
  if (kind === 'model') {
    const ent = has('Entity');
    const tbl = has('Table');
    const room = /^\s*import\s+androidx\.room\./m.test(kf.code);
    const fromEnt = ent ? literalsIn(annArg(ent.args, 'tableName') ?? (room ? '' : annArg(ent.args, 'name') ?? ''), 0, 400, resolveLocal)[0] : undefined;
    const fromTbl = tbl ? literalsIn(annArg(tbl.args, 'name') ?? annArg(tbl.args) ?? '', 0, 400, resolveLocal)[0] : undefined;
    if (ent || tbl) unit.table = fromEnt || fromTbl || (room ? c.name : snake(c.name));
  }
  if (kind === 'repository') {
    const base = c.supers.find((x) => /Repository$|JpaSpecificationExecutor/.test(x.name) && x.typeArgs.length);
    if (base) unit.fields['__entity'] = kf.imports.get(simpleType(base.typeArgs[0])) ?? simpleType(base.typeArgs[0]);
  }
  const layer = ({ controller: 'CONTROLLER', service: 'SERVICE', dao: 'DAO', repository: 'DAO', mapper: 'MAPPER', model: 'MODEL', job: 'BATCH', other: undefined } as const)[kind];
  const f = ctx.byId.get(kf.fileId);
  if (f && layer && f.layer !== 'TEST') f.layer = layer;
}

function addMembers(ctx: Ctx, kf: KtFile, unit: CodeUnit, c: KtClass | undefined, funs: KtFun[], props: KtProp[], inits: Region[], prefixes: string[] = [], restClass = false): void {
  const st = ktState(ctx);
  const lineOf = kf.lineOf;
  const resolveLocal = (n: string) => st.consts.get(n)?.[0]?.value;
  for (const fn of funs) {
    const m = newMethod(fn.name, lineOf(fn.namePos), fn.body ? lineOf(fn.body.to) : undefined);
    fn.method = m;
    // Spring 라우트
    for (const a of fn.anns) {
      if (!(a.name in MAPPING)) continue;
      const pathArg = annArg(a.args, 'value') ?? annArg(a.args, 'path') ?? annArg(a.args);
      const paths = pathArg ? literalsIn(pathArg, 0, pathArg.length, resolveLocal) : [];
      let verbs = [MAPPING[a.name]];
      if (a.name === 'RequestMapping') {
        const vs = [...(annArg(a.args, 'method') ?? '').matchAll(/\b(GET|POST|PUT|DELETE|PATCH)\b/g)].map((x) => x[1]);
        if (vs.length) verbs = vs;
      }
      const api = restClass || fn.anns.some((x) => x.name === 'ResponseBody') || /^ResponseEntity\b/.test(fn.ret);
      for (const pre of prefixes.length ? prefixes : ['']) for (const p of paths.length ? paths : ['']) for (const v of verbs) {
        const r: Route = { method: v, path: joinPath(pre, p), line: lineOf(a.start), ...(api ? { api: true } : {}) };
        if (!m.routes.some((x) => x.method === r.method && x.path === r.path)) m.routes.push(r);
      }
    }
    if (m.routes.length && !restClass && fn.body && !m.routes.some((r) => r.api)) {
      // @Controller 화면 이름: return "order/list" 또는 = "order/list"
      const body = kf.code.slice(fn.body.from, fn.body.to);
      for (const vm of body.matchAll(/(?:\breturn\s+|^\s*)"([\w/.-]+)"/gm)) if (!vm[1].startsWith('redirect:') && !m.views.includes(vm[1])) m.views.push(vm[1]);
    }
    unit.methods.push(m);
    const params = new Map(fn.params.map((p) => [p.name, p.type] as const));
    st.regions.push({ kf, cls: c, unit, m, regions: fn.body ? [fn.body] : [], params, fn });
  }
  for (const p of props) {
    const regs = propRegions(p);
    if (!regs.length) continue;
    if (unit.methods.some((x) => x.name === p.name)) continue;
    const m = newMethod(p.name, lineOf(p.namePos));
    p.method = m;
    unit.methods.push(m);
    st.regions.push({ kf, cls: c, unit, m, regions: regs, params: new Map(), pseudo: true, prop: p });
  }
  if (inits.length) {
    const m = newMethod('init', lineOf(inits[0].from));
    unit.methods.push(m);
    st.regions.push({ kf, cls: c, unit, m, regions: inits, params: new Map() });
  }
}

export const kotlinAnalyzer: Analyzer = {
  name: 'kotlin',
  order: 21,
  accepts: (f) => f.lang === 'Kotlin' && f.layer !== 'TEST' && /\.kt$/.test(f.path),
  analyze(f, text, ctx) {
    if (text.length > 1_500_000) return;
    const kf = parseKotlin(f.id, f.path, text);
    ktState(ctx).files.set(f.id, kf);
    buildFileUnits(ctx, kf);
  },
};

// ------------------------------------------------------------------ 호출 해석 (모든 파일을 본 뒤)

const NOT_CALL = new Set([
  'if', 'when', 'for', 'while', 'catch', 'return', 'throw', 'super', 'this', 'try', 'do', 'else', 'is', 'in', 'as', 'object', 'fun', 'val', 'var',
  'listOf', 'mutableListOf', 'setOf', 'mutableSetOf', 'mapOf', 'mutableMapOf', 'arrayOf', 'emptyList', 'emptyMap', 'println', 'print', 'require', 'check',
  'let', 'run', 'apply', 'also', 'with', 'repeat', 'lazy', 'launch', 'async', 'withContext', 'runBlocking', 'remember', 'mutableStateOf', 'LaunchedEffect',
  'Text', 'Column', 'Row', 'Box', 'Spacer', 'Icon', 'Image', 'Button', 'Modifier', 'Surface', 'Card', 'Scaffold', 'LazyColumn', 'LazyRow', 'Intent', 'Bundle',
  'String', 'Int', 'Long', 'Double', 'Float', 'Boolean', 'Exception', 'IllegalStateException', 'IllegalArgumentException', 'RuntimeException', 'Pair', 'Triple',
]);

interface Resolver {
  unitFor(type: string, kf: KtFile): CodeUnit | undefined;
  funOf(unit: CodeUnit, name: string): KtFun | undefined;
  fieldType(unit: CodeUnit, name: string): string | undefined;
  hasMethod(unit: CodeUnit, name: string): CodeUnit | undefined;
  topFun(name: string, kf: KtFile): CodeUnit | undefined;
  via(unit: CodeUnit): string;
}

function makeResolver(ctx: Ctx): Resolver {
  const st = ktState(ctx);
  const bySimple = new Map<string, CodeUnit[]>();
  const implemented = new Set<string>();
  for (const u of ctx.facts.units) {
    const a = bySimple.get(u.name) ?? [];
    a.push(u);
    bySimple.set(u.name, a);
    for (const s of u.extendsOrImplements) implemented.add(s.replace(/<.*$/, '').split('.').pop()!);
  }
  const topFuns = new Map<string, CodeUnit[]>();
  for (const kf of st.files.values()) {
    if (!kf.fileUnit) continue;
    for (const fn of kf.funs) {
      if (fn.receiver) continue;
      const a = topFuns.get(fn.name) ?? [];
      if (!a.includes(kf.fileUnit)) a.push(kf.fileUnit);
      topFuns.set(fn.name, a);
    }
  }
  const pkgOf = (u: CodeUnit) => (u.fqn && u.fqn.includes('.') ? u.fqn.slice(0, u.fqn.lastIndexOf('.')) : '');
  const pick = (cands: CodeUnit[], kf: KtFile, simple: string): CodeUnit | undefined => {
    if (cands.length <= 1) return cands[0];
    const imp = kf.imports.get(simple);
    if (imp) {
      const hit = cands.find((u) => u.fqn === imp || (u.fqn ?? '').endsWith(`.${imp.split('.').pop()}`) && (u.fqn ?? '').startsWith(imp.slice(0, imp.lastIndexOf('.'))));
      if (hit) return hit;
    }
    const same = cands.filter((u) => pkgOf(u) === kf.pkg || pkgOf(u).startsWith(`${kf.pkg}.`) && pkgOf(u).endsWith(`.${simple}`));
    if (same.length) return same[0];
    // 같은 폴더 줄기(하위 프로젝트)를 우선
    const dir = kf.path.split('/').slice(0, 2).join('/');
    const near = cands.filter((u) => (ctx.byId.get(u.file)?.path ?? '').startsWith(dir));
    return (near.length ? near : cands)[0];
  };
  const r: Resolver = {
    unitFor(type, kf) {
      if (!type) return undefined;
      const simple = simpleType(type);
      if (!simple || !/^[A-Z]/.test(simple)) return undefined;
      // 제네릭 감싼 타입(Lazy<T>, Provider<T>)
      const inner = /^(Lazy|Provider|Optional)\s*<\s*([\w.]+)/.exec(type);
      if (inner) return r.unitFor(inner[2], kf);
      return pick(bySimple.get(simple) ?? [], kf, simple);
    },
    funOf(unit, name) {
      const c = st.classOfUnit.get(unit);
      if (!c) return undefined;
      const list = c.cls ? c.cls.funs : c.kf.funs;
      return list.find((f) => f.name === name);
    },
    fieldType(unit, name) {
      let u: CodeUnit | undefined = unit;
      for (let d = 0; u && d < 5; d++) {
        if (name in u.fields) return u.fields[name];
        const c = st.classOfUnit.get(u);
        const sup: string | undefined = u.extendsOrImplements[0];
        const next: CodeUnit | undefined = sup && c ? r.unitFor(sup, c.kf) : undefined;
        u = next === u ? undefined : next;
      }
      return undefined;
    },
    hasMethod(unit, name) {
      let u: CodeUnit | undefined = unit;
      for (let d = 0; u && d < 5; d++) {
        if (u.methods.some((m) => m.name === name)) return u;
        const c = st.classOfUnit.get(u);
        const next: CodeUnit | undefined = u.extendsOrImplements.map((s) => (c ? r.unitFor(s, c.kf) : undefined)).find((x) => x && x !== u);
        u = next;
      }
      return undefined;
    },
    topFun(name, kf) {
      const cands = topFuns.get(name);
      if (!cands?.length) return undefined;
      return pick(cands, kf, name);
    },
    via(unit) {
      if (implemented.has(unit.name)) return unit.name;
      return unit.fqn ?? unit.name;
    },
  };
  return r;
}

/** 지역 변수 타입: val x = Type(…) / val x: Type = … / val vm = hiltViewModel<T>() / by viewModels<T>() */
function localsOf(code: string, skel: string, from: number, to: number): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:val|var)\s+([a-z_]\w*)\s*(?::\s*([A-Za-z_][\w.]*)[^=\n]*)?(=|\bby\b)\s*([^\n;]*)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skel)) && m.index < to) {
    if (m[2]) {
      out.set(m[1], m[2]);
      continue;
    }
    const init = code.slice(m.index + m[0].length - m[4].length, m.index + m[0].length);
    const cls = /\b([A-Z]\w*)\s*::\s*class\b/.exec(init);
    const gen = /\b(?:hiltViewModel|viewModel|koinViewModel|viewModels|activityViewModels|inject|get)\s*<\s*([A-Z][\w.]*)/.exec(init);
    const ctor = /^\s*([A-Z]\w*)\s*\(/.exec(init);
    const t = gen?.[1] ?? cls?.[1] ?? ctor?.[1];
    if (t) out.set(m[1], t);
    else out.set(m[1], `?${init.trim().slice(0, 200)}`);
  }
  return out;
}

const CHAIN_RE = /(?<![\w$.)\]])((?:[A-Za-z_]\w*(?:\(\))?(?:\?|!!)?\s*\.\s*)+)([A-Za-z_]\w*)\s*(?:<[^<>()\n]*>)?\s*([({])/g;
const BARE_RE = /(?<![\w$.])([A-Za-z_]\w*)\s*(?:<[^<>()\n]*>)?\s*(\(|\{)/g;

/** Kotlin 메서드 몸체의 호출을 CodeUnit 호출로 (파일을 넘나드는 타입·상수 사용) */
export function resolveKotlinCalls(ctx: Ctx): void {
  const st = ktState(ctx);
  if (st.resolved) return;
  st.resolved = true;
  if (!st.regions.length) return;
  const R = makeResolver(ctx);

  // 1) 타입을 모르는 필드: 초기화식이 다른 유닛 메서드 호출이면 그 반환 타입 (db.productDao())
  for (const reg of st.regions) {
    if (!reg.pseudo || !reg.prop || !reg.cls) continue;
    const u = reg.unit;
    if (u.fields[reg.prop.name]) continue;
    const r0 = reg.regions[0];
    const t = reg.kf.skel.slice(r0.from, r0.to).trim();
    const cm = /^([a-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(\s*\)\s*$/.exec(t);
    if (!cm) continue;
    const ft = R.fieldType(u, cm[1]);
    const tu = ft ? R.unitFor(ft, reg.kf) : undefined;
    const fn = tu ? R.funOf(tu, cm[2]) : undefined;
    if (fn?.ret) u.fields[reg.prop.name] = fn.ret;
  }

  // 2) 호출
  for (const reg of st.regions) {
    const { kf, unit, m } = reg;
    const seen = new Set<string>(m.calls.map((c) => `${c.via}#${c.method}`));
    const add = (via: string, method: string, pos: number) => {
      const key = `${via}#${method}`;
      if (seen.has(key)) return;
      seen.add(key);
      const c: CallRef = { via, method, line: kf.lineOf(pos) };
      m.calls.push(c);
    };
    for (const rg of reg.regions) {
      const locals = localsOf(kf.code, kf.skel, rg.from, rg.to);
      const typeOfName = (n: string): { t?: string; known: boolean } => {
        if (reg.params.has(n)) return { t: reg.params.get(n), known: true };
        if (locals.has(n)) {
          const t = locals.get(n)!;
          if (!t.startsWith('?')) return { t, known: true };
          // val x = a.b() → b의 반환 타입
          const cm = /^([a-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(t.slice(1));
          if (cm) {
            const ft = R.fieldType(unit, cm[1]) ?? reg.params.get(cm[1]);
            const tu = ft ? R.unitFor(ft, kf) : undefined;
            const fn = tu ? R.funOf(tu, cm[2]) : undefined;
            if (fn?.ret) return { t: fn.ret, known: true };
          }
          return { known: true };
        }
        return { known: false };
      };
      // a.b.c( 꼴
      CHAIN_RE.lastIndex = rg.from;
      let cm: RegExpExecArray | null;
      while ((cm = CHAIN_RE.exec(kf.skel)) && cm.index < rg.to) {
        const segs = cm[1].split('.').map((x) => x.replace(/[?!\s]/g, '')).filter(Boolean);
        const method = cm[2];
        const pos = cm.index;
        let cur: CodeUnit | undefined;
        let i = 0;
        const s0 = segs[0];
        if (s0 === 'this') {
          cur = unit;
          i = 1;
        } else if (s0 === 'super' || s0 === 'it') continue;
        else {
          const lt = typeOfName(s0);
          if (lt.known) {
            cur = lt.t ? R.unitFor(lt.t, kf) : undefined;
            if (!cur) continue;
            i = 1;
          } else {
            const ft = R.fieldType(unit, s0);
            if (ft !== undefined) {
              const owner = R.hasMethod(unit, s0);
              if (owner) add(owner === unit ? `this.${unit.fqn ?? unit.name}` : R.via(owner), s0, pos);
              cur = ft ? R.unitFor(ft, kf) : undefined;
              if (!cur) {
                // 타입 모르는 필드.메서드( → link가 이름으로 추측
                if (segs.length === 1) add(s0, method, pos);
                continue;
              }
              i = 1;
            } else if (/^[A-Z]/.test(s0)) {
              cur = R.unitFor(s0, kf);
              if (!cur) continue;
              i = 1;
            } else if (s0.endsWith('()')) {
              const own = R.hasMethod(unit, s0.slice(0, -2));
              const fn = own ? R.funOf(own, s0.slice(0, -2)) : undefined;
              if (own) add(own === unit ? `this.${unit.fqn ?? unit.name}` : R.via(own), s0.slice(0, -2), pos);
              cur = fn?.ret ? R.unitFor(fn.ret, kf) : undefined;
              if (!cur) continue;
              i = 1;
            } else continue;
          }
        }
        let ok = true;
        for (; i < segs.length && cur; i++) {
          const seg = segs[i];
          if (seg.endsWith('()')) {
            const name = seg.slice(0, -2);
            const owner = R.hasMethod(cur, name);
            if (!owner) {
              ok = false;
              break;
            }
            add(R.via(owner), name, pos);
            const fn = R.funOf(owner, name);
            cur = fn?.ret ? R.unitFor(fn.ret, kf) : undefined;
            continue;
          }
          const owner = R.hasMethod(cur, seg);
          if (owner) add(R.via(owner), seg, pos);
          const ft = R.fieldType(cur, seg);
          cur = ft ? R.unitFor(ft, kf) : undefined;
        }
        if (!ok || !cur) continue;
        const owner = R.hasMethod(cur, method) ?? cur;
        add(owner === unit ? `this.${unit.fqn ?? unit.name}` : R.via(owner), method, pos);
      }
      // 호출 없이 쓰는 프로퍼티(viewModel.uiState)·함수 참조(viewModel::refresh, ::load)
      for (const pm of kf.skel.slice(rg.from, rg.to).matchAll(/(?<![\w$.)\]])([a-z_]\w*)\s*(?:\?|!!)?\s*(\.|::)\s*([A-Za-z_]\w*)\b(?!\s*[({.]|\s*::)/g)) {
        const pos = rg.from + (pm.index ?? 0);
        const recv = pm[1];
        const name = pm[3];
        const lt = typeOfName(recv);
        const t = lt.known ? lt.t : R.fieldType(unit, recv);
        const cu = t ? R.unitFor(t, kf) : undefined;
        const owner = cu ? R.hasMethod(cu, name) : undefined;
        if (owner) add(owner === unit ? `this.${unit.fqn ?? unit.name}` : R.via(owner), name, pos);
      }
      for (const rm of kf.skel.slice(rg.from, rg.to).matchAll(/(?<![\w$.])::\s*([a-z_]\w*)/g)) {
        const own = R.hasMethod(unit, rm[1]) ?? R.topFun(rm[1], kf);
        if (own) add(own === unit ? `this.${unit.fqn ?? unit.name}` : R.via(own), rm[1], rg.from + (rm.index ?? 0));
      }
      // name( 꼴: 자기 메서드·상위 클래스 메서드·최상위 함수·생성자(init)
      BARE_RE.lastIndex = rg.from;
      let bm: RegExpExecArray | null;
      while ((bm = BARE_RE.exec(kf.skel)) && bm.index < rg.to) {
        const name = bm[1];
        if (NOT_CALL.has(name)) continue;
        if (bm[2] === '{' && !/^[A-Z]/.test(name)) continue;
        const pos = bm.index;
        if (name === m.name && unit.methods.filter((x) => x.name === name).length <= 1) continue;
        const own = R.hasMethod(unit, name);
        if (own && R.funOf(own, name)) {
          add(own === unit ? `this.${unit.fqn ?? unit.name}` : R.via(own), name, pos);
          continue;
        }
        const top = R.topFun(name, kf);
        if (top) {
          add(top === unit ? `this.${unit.fqn ?? unit.name}` : top.fqn ?? top.name, name, pos);
          continue;
        }
        if (/^[A-Z]/.test(name)) {
          const cu = R.unitFor(name, kf);
          if (cu && cu !== unit && cu.methods.some((x) => x.name === 'init')) add(R.via(cu), 'init', pos);
          // 프레임워크가 부르는 재정의 메서드(PagingSource.load, Worker.doWork, Callback.onResponse …)
          const cc = cu && cu !== unit && cu.kind !== 'model' ? st.classOfUnit.get(cu)?.cls : undefined;
          if (cc) for (const fn of cc.funs) if (/\boverride\b/.test(fn.mods) && fn.body) add(R.via(cu!), fn.name, pos);
        }
      }
    }
  }
}

/** 상수 찾기: 같은 파일 → 전체 (값이 여럿이면 같은 파일 것) */
export function ktConst(ctx: Ctx, fileId: string, name: string): string | undefined {
  const st = ktState(ctx);
  const list = st.consts.get(name) ?? st.consts.get(name.split('.').slice(-2).join('.')) ?? st.consts.get(name.split('.').pop()!);
  if (!list?.length) return undefined;
  return (list.find((x) => x.file === fileId) ?? list[0]).value;
}
