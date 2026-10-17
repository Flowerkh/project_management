// PHP 토큰 분리기: HTML 구간, 문자열(보간은 ${v}로), 변수, 식별자(네임스페이스 포함), 연산자
export type PK = 'str' | 'var' | 'id' | 'num' | 'op' | 'html';

export interface PT {
  k: PK;
  v: string;
  p: number; // 시작 위치
  e: number; // 끝 위치(다음 문자)
  interp?: boolean; // 보간이 있는 문자열
}

const OPS = [
  '<<=', '>>=', '**=', '...', '<=>', '===', '!==', '??=', '?->',
  '->', '=>', '::', '++', '--', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '==', '!=', '<>', '<=', '>=', '&&', '||', '??', '<<', '>>', '**',
];

const ID_START = /[A-Za-z_\x80-￿\\]/;
const ID_CHAR = /[\w\x80-￿\\]/;

function findOpenTag(src: string, from: number): number {
  let i = from;
  for (;;) {
    const j = src.indexOf('<?', i);
    if (j < 0) return -1;
    if (src.startsWith('<?xml', j)) {
      i = j + 2;
      continue;
    }
    return j;
  }
}

function readSingle(src: string, i: number): [string, number] {
  let v = '';
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) {
      v += src[j + 1];
      j++;
      continue;
    }
    if (c === "'") return [v, j + 1];
    v += c;
  }
  return [v, j];
}

/** 보간 처리: $var, $var->p, $var['k'], {$…}, ${…} → ${v} */
function interpolate(body: string): { v: string; interp: boolean } {
  let out = '';
  let interp = false;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '\\') {
      const nx = body[j + 1];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', $: '$', '`': '`' };
      if (nx !== undefined && map[nx] !== undefined) {
        out += map[nx];
        j++;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '{' && body[j + 1] === '$') {
      let d = 0;
      let k = j;
      for (; k < body.length; k++) {
        if (body[k] === '{') d++;
        else if (body[k] === '}') {
          d--;
          if (!d) break;
        }
      }
      out += '${v}';
      interp = true;
      j = k;
      continue;
    }
    if (c === '$' && body[j + 1] === '{') {
      const k = body.indexOf('}', j);
      out += '${v}';
      interp = true;
      j = k < 0 ? body.length : k;
      continue;
    }
    if (c === '$' && /[A-Za-z_\x80-￿]/.test(body[j + 1] ?? '')) {
      let k = j + 1;
      while (k < body.length && /[\w\x80-￿]/.test(body[k])) k++;
      // ->prop 또는 [key] 하나
      if (body[k] === '-' && body[k + 1] === '>' && /[A-Za-z_]/.test(body[k + 2] ?? '')) {
        k += 2;
        while (k < body.length && /\w/.test(body[k])) k++;
      } else if (body[k] === '[') {
        const e = body.indexOf(']', k);
        if (e > 0 && e - k < 60) k = e + 1;
      }
      out += '${v}';
      interp = true;
      j = k - 1;
      continue;
    }
    out += c;
  }
  return { v: out, interp };
}

function readDouble(src: string, i: number, q: string): [string, number, boolean] {
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === q) break;
  }
  const { v, interp } = interpolate(src.slice(i + 1, j));
  return [v, j + 1, interp];
}

function readHeredoc(src: string, i: number): [string, number, boolean] | null {
  const m = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 80));
  if (!m) return null;
  const id = m[2];
  const nowdoc = m[1] === "'";
  const bodyStart = i + m[0].length;
  const re = new RegExp(`^[ \\t]*${id}\\b`, 'm');
  const rest = src.slice(bodyStart);
  const end = re.exec(rest);
  if (!end) return [rest, src.length, false];
  const body = rest.slice(0, end.index).replace(/\r?\n$/, '');
  const after = bodyStart + end.index + end[0].length;
  if (nowdoc) return [body, after, false];
  const { v, interp } = interpolate(body);
  return [v, after, interp];
}

export function lexPhp(src: string): PT[] {
  const out: PT[] = [];
  const n = src.length;
  let i = 0;
  let inPhp = false;
  while (i < n) {
    if (!inPhp) {
      const j = findOpenTag(src, i);
      if (j < 0) {
        out.push({ k: 'html', v: src.slice(i), p: i, e: n });
        break;
      }
      if (j > i) out.push({ k: 'html', v: src.slice(i, j), p: i, e: j });
      if (src.startsWith('<?php', j)) i = j + 5;
      else if (src.startsWith('<?=', j)) {
        i = j + 3;
        out.push({ k: 'id', v: 'echo', p: j, e: i });
      } else i = j + 2;
      inPhp = true;
      continue;
    }
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '?' && src[i + 1] === '>') {
      out.push({ k: 'op', v: ';', p: i, e: i + 2 });
      i += 2;
      if (src[i] === '\n') i++;
      inPhp = false;
      continue;
    }
    if ((c === '/' && src[i + 1] === '/') || (c === '#' && src[i + 1] !== '[')) {
      let j = i;
      while (j < n && src[j] !== '\n' && !(src[j] === '?' && src[j + 1] === '>')) j++;
      i = j;
      continue;
    }
    if (c === '#' && src[i + 1] === '[') {
      let d = 0;
      let j = i + 1;
      for (; j < n; j++) {
        const ch = src[j];
        if (ch === '[') d++;
        else if (ch === ']') {
          d--;
          if (!d) break;
        } else if (ch === "'") j = readSingle(src, j)[1] - 1;
        else if (ch === '"') j = readDouble(src, j, '"')[1] - 1;
      }
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "'") {
      const [v, j] = readSingle(src, i);
      out.push({ k: 'str', v, p: i, e: j });
      i = j;
      continue;
    }
    if (c === '"' || c === '`') {
      const [v, j, interp] = readDouble(src, i, c);
      out.push({ k: 'str', v, p: i, e: j, ...(interp ? { interp } : {}) });
      i = j;
      continue;
    }
    if (c === '<' && src.startsWith('<<<', i)) {
      const h = readHeredoc(src, i);
      if (h) {
        out.push({ k: 'str', v: h[0], p: i, e: h[1], ...(h[2] ? { interp: true } : {}) });
        i = h[1];
        continue;
      }
    }
    if (c === '$' && /[A-Za-z_\x80-￿]/.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[\w\x80-￿]/.test(src[j])) j++;
      out.push({ k: 'var', v: src.slice(i + 1, j), p: i, e: j });
      i = j;
      continue;
    }
    if (ID_START.test(c) && !(c === '\\' && !/[A-Za-z_]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && ID_CHAR.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), p: i, e: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-f_]+|0b[01_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(src.slice(i, i + 40));
      const len = m ? m[0].length : 1;
      out.push({ k: 'num', v: src.slice(i, i + len), p: i, e: i + len });
      i += len;
      continue;
    }
    let op = '';
    for (const o of OPS) {
      if (src.startsWith(o, i)) {
        op = o;
        break;
      }
    }
    if (!op) op = c;
    out.push({ k: 'op', v: op, p: i, e: i + op.length });
    i += op.length;
  }
  return out;
}

/** 여는 괄호 위치에서 짝 닫는 괄호 위치 (없으면 끝) */
export function matchClose(t: PT[], i: number): number {
  const open = t[i]?.v;
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  if (!open || !pairs[open]) return i;
  let d = 0;
  for (let j = i; j < t.length; j++) {
    const v = t[j].k === 'op' ? t[j].v : '';
    if (v === '(' || v === '[' || v === '{') d++;
    else if (v === ')' || v === ']' || v === '}') {
      d--;
      if (d === 0) return j;
    }
  }
  return t.length - 1;
}

/** (a, b, c) 인자 범위: 여는 괄호 위치 → [시작, 끝) 목록 */
export function splitArgs(t: PT[], open: number): [number, number][] {
  const close = matchClose(t, open);
  const out: [number, number][] = [];
  let start = open + 1;
  let d = 0;
  for (let j = open + 1; j < close; j++) {
    const v = t[j].k === 'op' ? t[j].v : '';
    if (v === '(' || v === '[' || v === '{') d++;
    else if (v === ')' || v === ']' || v === '}') d--;
    else if (v === ',' && d === 0) {
      out.push([start, j]);
      start = j + 1;
    }
  }
  if (start < close) out.push([start, close]);
  return out;
}

/** 인자 하나가 문자열 리터럴(연결 포함)이면 값 */
export function argString(t: PT[], [a, b]: [number, number]): string | null {
  if (a >= b) return null;
  let s = '';
  let any = false;
  for (let j = a; j < b; j++) {
    const x = t[j];
    if (x.k === 'str') {
      s += x.v;
      any = true;
    } else if (x.k === 'op' && x.v === '.') continue;
    else s += '${v}';
  }
  return any ? s : null;
}

/** X::class 인자면 X */
export function argClass(t: PT[], [a, b]: [number, number]): string | null {
  if (b - a === 3 && t[a].k === 'id' && t[a + 1].v === '::' && t[a + 2].v === 'class') return t[a].v;
  return null;
}

export function simpleName(n: string): string {
  return n.slice(n.lastIndexOf('\\') + 1);
}
