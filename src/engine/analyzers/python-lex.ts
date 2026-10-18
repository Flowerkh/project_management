// 파이썬 소스 훑기: 문자열·주석을 지운 뼈대(skel)와 문자열 목록, def/class 블록 구조.
// 뼈대는 원문과 길이·줄바꿈 위치가 같아서 offset·줄 번호를 그대로 쓴다.

export interface PyStr {
  /** 따옴표(접두어 포함) 시작 위치 */
  start: number;
  /** 닫는 따옴표 다음 위치 */
  end: number;
  value: string;
  /** r·b·f·u 접두어 (소문자) */
  prefix: string;
  triple: boolean;
}

export interface PyScan {
  skel: string;
  strings: PyStr[];
}

/** 주석은 공백으로, 문자열 안쪽은 공백으로 지운 뼈대 + 문자열 값 목록 */
export function scanPy(src: string): PyScan {
  const n = src.length;
  const out: string[] = new Array(n);
  const strings: PyStr[] = [];
  let i = 0;
  const blankRange = (a: number, b: number) => {
    for (let k = a; k < b; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blankRange(i, j);
      i = j;
      continue;
    }
    // 접두어 + 따옴표
    let pre = '';
    let q = i;
    if (/[rRbBuUfF]/.test(c) && (i === 0 || !/[\w]/.test(src[i - 1]))) {
      let k = i;
      while (k < n && k - i < 2 && /[rRbBuUfF]/.test(src[k])) k++;
      if (src[k] === '"' || src[k] === "'") {
        pre = src.slice(i, k).toLowerCase();
        q = k;
      }
    }
    const qc = src[q];
    if ((qc === '"' || qc === "'") && (q === i || pre)) {
      const triple = src.startsWith(qc.repeat(3), q);
      const raw = pre.includes('r');
      const delim = triple ? qc.repeat(3) : qc;
      let j = q + delim.length;
      let val = '';
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\' && !raw) {
          const nx = src[j + 1] ?? '';
          val += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === '\n' ? '' : nx;
          j += 2;
          continue;
        }
        if (ch === '\\' && raw) {
          val += ch + (src[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (src.startsWith(delim, j)) {
          j += delim.length;
          closed = true;
          break;
        }
        if (!triple && ch === '\n') break; // 닫히지 않은 한 줄 문자열
        val += ch;
        j++;
      }
      const end = closed ? j : j;
      // 뼈대: 접두어·따옴표는 남기고 안쪽만 지움
      for (let k = i; k < q + delim.length && k < n; k++) out[k] = src[k];
      blankRange(q + delim.length, Math.max(q + delim.length, end - (closed ? delim.length : 0)));
      if (closed) for (let k = end - delim.length; k < end; k++) out[k] = src[k];
      strings.push({ start: i, end, value: val, prefix: pre, triple });
      i = end;
      continue;
    }
    out[i] = c;
    i++;
  }
  for (let k = 0; k < n; k++) if (out[k] === undefined) out[k] = src[k];
  return { skel: out.join(''), strings };
}

/** offset에서 시작하는(공백 건너뛴) 문자열 리터럴 */
export function strAt(scan: PyScan, pos: number): PyStr | undefined {
  let p = pos;
  while (p < scan.skel.length && /\s/.test(scan.skel[p])) p++;
  return findStr(scan, p);
}

export function findStr(scan: PyScan, start: number): PyStr | undefined {
  let lo = 0;
  let hi = scan.strings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = scan.strings[mid];
    if (s.start === start) return s;
    if (s.start < start) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** [a, b) 범위 안의 문자열들 */
export function stringsIn(scan: PyScan, a: number, b: number): PyStr[] {
  let lo = 0;
  let hi = scan.strings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scan.strings[mid].start < a) lo = mid + 1;
    else hi = mid;
  }
  const out: PyStr[] = [];
  for (let k = lo; k < scan.strings.length && scan.strings[k].start < b; k++) out.push(scan.strings[k]);
  return out;
}

/** 여는 괄호 위치 → 짝 닫는 괄호 위치 (뼈대 기준) */
export function matchParen(skel: string, open: number): number {
  const o = skel[open];
  const c = o === '(' ? ')' : o === '[' ? ']' : o === '{' ? '}' : '';
  if (!c) return -1;
  let depth = 0;
  for (let i = open; i < skel.length; i++) {
    const ch = skel[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return ch === c ? i : -1;
    }
  }
  return -1;
}

export interface PyArg {
  start: number;
  end: number;
  /** 키워드 인자 이름 (name=…) */
  key?: string;
  /** 값 시작 위치 (키워드면 = 다음) */
  valueStart: number;
  text: string;
}

/** 여는 괄호 위치에서 최상위 인자 나누기 */
export function splitArgs(skel: string, open: number): PyArg[] {
  const close = matchParen(skel, open);
  if (close < 0) return [];
  const out: PyArg[] = [];
  let depth = 0;
  let s = open + 1;
  const push = (e: number) => {
    const raw = skel.slice(s, e);
    if (!raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    const start = s + lead;
    const text = skel.slice(start, e).trim();
    const km = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(text);
    out.push({ start, end: e, ...(km ? { key: km[1] } : {}), valueStart: km ? start + km[0].length : start, text });
  };
  for (let i = open + 1; i < close; i++) {
    const ch = skel[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      push(i);
      s = i + 1;
    }
  }
  push(close);
  return out;
}

/** 인자 값이 문자열(이웃한 리터럴 이어 붙이기 포함)이면 그 값 */
export function argString(scan: PyScan, a: PyArg | undefined): string | undefined {
  if (!a) return undefined;
  let p = a.valueStart;
  const skel = scan.skel;
  while (p < a.end && /[\s(]/.test(skel[p])) p++;
  let s = findStr(scan, p);
  if (!s) return undefined;
  let v = s.value;
  for (;;) {
    let k = s.end;
    while (k < a.end && /[\s)+]/.test(skel[k])) k++;
    if (k >= a.end) break;
    const nx = findStr(scan, k);
    if (!nx) return /^[\s)]*$/.test(skel.slice(s.end, a.end)) ? v : undefined;
    v += nx.value;
    s = nx;
  }
  return v;
}

/** 리스트·튜플 인자 안의 문자열들 (methods=['GET','POST']) */
export function argStrings(scan: PyScan, a: PyArg | undefined): string[] {
  if (!a) return [];
  return stringsIn(scan, a.valueStart, a.end).map((s) => s.value);
}

/** 값 표현식(뼈대) */
export function argExpr(skel: string, a: PyArg | undefined): string {
  if (!a) return '';
  return skel.slice(a.valueStart, a.end).trim();
}

// ------------------------------------------------------------------ 블록 구조

export interface PyDef {
  kind: 'def' | 'class';
  name: string;
  line: number;
  /** def/class 키워드 위치 */
  start: number;
  /** 머리(:) 다음 위치 = 본문 시작 */
  bodyStart: number;
  /** 본문 끝 (다음 같은·바깥 들여쓰기 줄 시작) */
  end: number;
  endLine: number;
  indent: number;
  isAsync: boolean;
  /** 데코레이터 식 범위 (@ 다음부터) */
  decorators: { start: number; end: number; line: number; text: string }[];
  /** def 인자 괄호 / class 베이스 괄호 위치 (없으면 -1) */
  paren: number;
  parent?: PyDef;
  children: PyDef[];
}

interface LineInfo {
  start: number;
  end: number;
  indent: number;
  blank: boolean;
  /** 논리 줄의 시작인가 (괄호 안·\ 이어짐이 아님) */
  logical: boolean;
}

function lineInfos(skel: string): LineInfo[] {
  const out: LineInfo[] = [];
  let depth = 0;
  let cont = false;
  let pos = 0;
  while (pos <= skel.length) {
    let e = skel.indexOf('\n', pos);
    if (e < 0) e = skel.length;
    const text = skel.slice(pos, e);
    let indent = 0;
    for (const ch of text) {
      if (ch === ' ') indent++;
      else if (ch === '\t') indent = indent + 8 - (indent % 8);
      else if (ch === '\r' || ch === '\f') continue;
      else break;
    }
    const blank = text.trim() === '';
    out.push({ start: pos, end: e, indent, blank, logical: !blank && depth === 0 && !cont });
    for (const ch of text) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
    cont = /\\\s*$/.test(text);
    if (e >= skel.length) break;
    pos = e + 1;
  }
  return out;
}

export interface PyBlocks {
  top: PyDef[];
  all: PyDef[];
  lines: { start: number; indent: number; logical: boolean; blank: boolean }[];
}

/** def·class 블록 트리 */
export function parseBlocks(skel: string): PyBlocks {
  const lines = lineInfos(skel);
  const top: PyDef[] = [];
  const all: PyDef[] = [];
  const stack: PyDef[] = [];
  let pendingDeco: PyDef['decorators'] = [];
  const closeUntil = (indent: number, at: number, lineIdx: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const d = stack.pop()!;
      d.end = at;
      let k = lineIdx - 1;
      while (k > 0 && lines[k].blank) k--;
      d.endLine = Math.max(d.line, k + 1);
    }
  };
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    if (!L.logical) continue;
    const text = skel.slice(L.start, L.end);
    closeUntil(L.indent, L.start, li);
    const body = text.trimStart();
    const at = L.start + (text.length - body.length);
    if (body.startsWith('@')) {
      // 데코레이터: 괄호가 닫힐 때까지 여러 줄
      let e = L.end;
      const p = skel.indexOf('(', at);
      if (p >= 0 && p < L.end) {
        const c = matchParen(skel, p);
        if (c > 0) e = Math.max(e, c + 1);
      }
      pendingDeco.push({ start: at + 1, end: e, line: li + 1, text: skel.slice(at + 1, e) });
      continue;
    }
    const dm = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(body);
    const cm = dm ? null : /^class\s+([A-Za-z_]\w*)\s*([(:])/.exec(body);
    if (dm || cm) {
      const paren = dm ? at + dm[0].length - 1 : cm![2] === '(' ? at + cm![0].length - 1 : -1;
      let hdr = paren >= 0 ? matchParen(skel, paren) : at;
      if (hdr < 0) hdr = at;
      // 머리 끝 ':' (반환 주석 -> X 포함)
      let colon = skel.indexOf(':', hdr);
      while (colon >= 0) {
        const between = skel.slice(hdr, colon);
        if (!/[([{]/.test(between)) break;
        colon = skel.indexOf(':', colon + 1);
      }
      const d: PyDef = {
        kind: dm ? 'def' : 'class',
        name: dm ? dm[2] : cm![1],
        line: li + 1,
        start: at,
        bodyStart: colon >= 0 ? colon + 1 : L.end,
        end: skel.length,
        endLine: lines.length,
        indent: L.indent,
        isAsync: !!dm?.[1],
        decorators: pendingDeco,
        paren,
        children: [],
      };
      pendingDeco = [];
      const parent = stack[stack.length - 1];
      if (parent) {
        d.parent = parent;
        parent.children.push(d);
      } else top.push(d);
      all.push(d);
      stack.push(d);
      continue;
    }
    pendingDeco = [];
  }
  closeUntil(-1, skel.length, lines.length);
  return { top, all, lines: lines.map((l) => ({ start: l.start, indent: l.indent, logical: l.logical, blank: l.blank })) };
}

/** 블록 본문에서 자식 블록(중첩 def/class)을 뺀 범위들 */
export function ownRanges(d: PyDef): [number, number][] {
  const out: [number, number][] = [];
  let p = d.bodyStart;
  for (const c of d.children) {
    const s = c.decorators.length ? c.decorators[0].start - 1 : c.start;
    if (s > p) out.push([p, s]);
    p = Math.max(p, c.end);
  }
  if (d.end > p) out.push([p, d.end]);
  return out;
}

/** 모듈 최상위 범위들 (def/class 본문 제외) */
export function moduleRanges(blocks: PyBlocks, len: number): [number, number][] {
  const out: [number, number][] = [];
  let p = 0;
  for (const d of blocks.top) {
    const s = d.decorators.length ? d.decorators[0].start - 1 : d.start;
    if (s > p) out.push([p, s]);
    p = Math.max(p, d.end);
  }
  if (len > p) out.push([p, len]);
  return out;
}

/** 모듈·함수의 docstring 첫 줄 */
export function docstringAt(scan: PyScan, bodyStart: number): string | undefined {
  let p = bodyStart;
  while (p < scan.skel.length && /\s/.test(scan.skel[p])) p++;
  const s = findStr(scan, p);
  if (!s) return undefined;
  return s.value.trim().split('\n')[0]?.trim() || undefined;
}
