// HTML·템플릿·인라인 스크립트에서 화면이 부르는 URL과 제목을 뽑는 공통 도구 (PHP·Go 분석기용)
import type { UrlRef } from '../types';
import { normalizePath } from '../files';

export interface RawRef {
  url: string;
  kind: UrlRef['kind'];
  method?: string;
  offset: number;
}

const SKIP_URL = /^(#|javascript:|mailto:|tel:|data:|about:)/i;

/** 문자열 리터럴 끝에서 이어지는 JS 문자열 연결(+ expr + 'lit')을 읽어 하나로 */
function readJsConcat(text: string, start: number, first: string): { url: string; end: number } {
  let url = first;
  let i = start;
  const n = text.length;
  for (let guard = 0; guard < 12; guard++) {
    let j = i;
    while (j < n && /\s/.test(text[j])) j++;
    if (text[j] !== '+') break;
    j++;
    while (j < n && /\s/.test(text[j])) j++;
    const q = text[j];
    if (q === '"' || q === "'" || q === '`') {
      const end = findQuoteEnd(text, j);
      if (end < 0) break;
      url += text.slice(j + 1, end).replace(/\$\{[^}]*\}/g, '{x}');
      i = end + 1;
      continue;
    }
    // 식 하나 건너뛰기: 식별자·멤버·호출·대괄호
    const k = skipExpr(text, j);
    if (k < 0) break;
    if (!url.endsWith('{x}')) url += '{x}';
    i = k;
  }
  return { url, end: i };
}

function matchBracket(text: string, k: number): number {
  const open = text[k];
  const close = open === '(' ? ')' : ']';
  let d = 0;
  for (let i = k; i < text.length && i < k + 800; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const e = findQuoteEnd(text, i);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    if (c === open) d++;
    else if (c === close) {
      d--;
      if (!d) return i;
    }
  }
  return -1;
}

/** 식별자·멤버 접근·호출·대괄호로 된 식 하나의 끝 위치 */
function skipExpr(text: string, j: number): number {
  const id = /^[\w$]+/.exec(text.slice(j, j + 100));
  if (!id) return -1;
  let k = j + id[0].length;
  for (let guard = 0; guard < 12; guard++) {
    if (text[k] === '.') {
      const m2 = /^\.[\w$]+/.exec(text.slice(k, k + 100));
      if (!m2) break;
      k += m2[0].length;
      continue;
    }
    if (text[k] === '(' || text[k] === '[') {
      const close = matchBracket(text, k);
      if (close < 0) return -1;
      k = close + 1;
      continue;
    }
    break;
  }
  return k;
}

function findQuoteEnd(text: string, open: number): number {
  const q = text[open];
  for (let i = open + 1; i < text.length && i < open + 2000; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === q) return i;
    if (text[i] === '\n' && q !== '`') return -1;
  }
  return -1;
}

/** text 위치 i(따옴표 시작)에서 JS 문자열 + 연결을 읽음. end는 연결식 끝 다음 위치 */
function jsStringAt(text: string, i: number): { url: string; end: number } | null {
  const q = text[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const end = findQuoteEnd(text, i);
  if (end < 0) return null;
  const lit = text.slice(i + 1, end).replace(/\$\{[^}]*\}/g, '{x}');
  return readJsConcat(text, end + 1, lit);
}

/** 문자열 앞의 "식별자 +" (contextPath + '/x') 는 건너뛰고 첫 문자열을 찾는다 */
function firstJsString(text: string, from: number): { url: string; end: number } | null {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  // ctx + "/x", base_url + '/x'
  const pre = /^([\w$.]+(\(\))?)\s*\+\s*/.exec(text.slice(i, i + 120));
  if (pre) i += pre[0].length;
  return jsStringAt(text, i);
}

/**
 * HTML(템플릿 표현식은 {x}로 바뀐 텍스트)에서 URL 참조 추출.
 * offset은 원문과 같은 위치이므로 줄 번호 계산에 그대로 쓴다.
 */
export function extractRefs(text: string): RawRef[] {
  const out: RawRef[] = [];
  const add = (url: string, kind: RawRef['kind'], offset: number, method?: string) => {
    if (!url || SKIP_URL.test(url.trim())) return;
    const m = method ?? (kind === 'link' || kind === 'location' || kind === 'popup' ? 'GET' : undefined);
    out.push({ url: url.trim(), kind, offset, ...(m ? { method: m.toUpperCase() } : {}) });
  };
  let m: RegExpExecArray | null;
  // <form action method>
  const formRe = /<form\b[^>]*>/gi;
  while ((m = formRe.exec(text))) {
    const tag = m[0];
    const a = /\baction\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
    if (!a) continue;
    const meth = /\bmethod\s*=\s*(["'])(\w+)\1/i.exec(tag)?.[2] ?? 'GET';
    // 블레이드 @method('PUT') / _method 숨은 필드
    const after = text.slice(m.index + tag.length, m.index + tag.length + 600);
    const spoof = /@method\(\s*['"](\w+)['"]\s*\)|name=["']_method["'][^>]*value=["'](\w+)["']/i.exec(after);
    add(a[2], 'form', m.index, spoof ? spoof[1] ?? spoof[2] : meth);
  }
  // <a href>, <iframe src>, <area href>
  const hrefRe = /<(a|area)\b[^>]*?\bhref\s*=\s*(["'])([\s\S]*?)\2/gi;
  while ((m = hrefRe.exec(text))) add(m[3], 'link', m.index);
  const frameRe = /<(iframe|frame)\b[^>]*?\bsrc\s*=\s*(["'])([\s\S]*?)\2/gi;
  while ((m = frameRe.exec(text))) add(m[3], 'link', m.index);
  // location.href = '…' / location.replace('…') / window.location = '…'
  const locRe = /\b(?:window\.|document\.|top\.|parent\.|self\.)?location(?:\.href)?\s*=\s*/g;
  while ((m = locRe.exec(text))) {
    const s = firstJsString(text, m.index + m[0].length);
    if (s) add(s.url, 'location', m.index);
  }
  const locCall = /\blocation\.(?:replace|assign)\(\s*/g;
  while ((m = locCall.exec(text))) {
    const s = firstJsString(text, m.index + m[0].length);
    if (s) add(s.url, 'location', m.index);
  }
  // window.open('…')
  const openRe = /\bwindow\.open\(\s*/g;
  while ((m = openRe.exec(text))) {
    const s = firstJsString(text, m.index + m[0].length);
    if (s) add(s.url, 'popup', m.index);
  }
  // $.ajax({ url: '…', type: 'POST' })
  const ajaxRe = /\$\.ajax\(\s*\{/g;
  while ((m = ajaxRe.exec(text))) {
    const body = text.slice(m.index, m.index + 1500);
    const u = /\burl\s*:\s*/.exec(body);
    if (!u) continue;
    const s = firstJsString(text, m.index + u.index + u[0].length);
    if (!s) continue;
    const t = /\b(?:type|method)\s*:\s*["'](\w+)["']/i.exec(body)?.[1];
    add(s.url, 'ajax', m.index, t ?? 'GET');
  }
  // $.get/$.post/$.getJSON/.load('…')
  const jqRe = /\$\.(get|post|getJSON)\(\s*|\.load\(\s*/g;
  while ((m = jqRe.exec(text))) {
    const s = firstJsString(text, m.index + m[0].length);
    if (s) add(s.url, 'ajax', m.index, m[1] === 'post' ? 'POST' : 'GET');
  }
  // fetch('…', { method })
  const fetchRe = /\bfetch\(\s*/g;
  while ((m = fetchRe.exec(text))) {
    const s = firstJsString(text, m.index + m[0].length);
    if (!s) continue;
    const opt = text.slice(s.end, s.end + 300);
    const meth = /^\s*,\s*\{[^}]*?\bmethod\s*:\s*["'](\w+)["']/.exec(opt)?.[1];
    add(s.url, 'fetch', m.index, meth ?? 'GET');
  }
  // axios.get/post/put/delete('…'), axios({ url })
  const axRe = /\baxios\.(get|post|put|patch|delete)\(\s*/g;
  while ((m = axRe.exec(text))) {
    const s = firstJsString(text, m.index + m[0].length);
    if (s) add(s.url, 'ajax', m.index, m[1]);
  }
  const axObj = /\baxios\(\s*\{/g;
  while ((m = axObj.exec(text))) {
    const body = text.slice(m.index, m.index + 800);
    const u = /\burl\s*:\s*/.exec(body);
    if (!u) continue;
    const s = firstJsString(text, m.index + u.index + u[0].length);
    const t = /\bmethod\s*:\s*["'](\w+)["']/i.exec(body)?.[1];
    if (s) add(s.url, 'ajax', m.index, t ?? 'GET');
  }
  // onclick 등 속성 안 함수 호출: fn_link('…do'), goPage('/x.php')
  const fnRe = /\b(?:fn_\w+|go\w*|move\w*|link\w*|open\w*Pop\w*|popup\w*)\(\s*(["'])(\/[^"'\s]+?\.(?:php|do|html?|jsp))\1/gi;
  while ((m = fnRe.exec(text))) add(m[2], /pop/i.test(m[0]) ? 'popup' : 'location', m.index);
  return out;
}

/**
 * URL 정규화: 쿼리·해시 제거, 상대 경로를 baseDir(화면 URL의 폴더) 기준으로 해석,
 * 표현식이 들어간 경로 조각은 {x}. 외부 주소·자원 파일은 null.
 */
export function normalizeRef(raw: string, baseDir: string): string | null {
  let u = raw.trim();
  if (!u || SKIP_URL.test(u)) return null;
  u = u.replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}|<\?(?:php|=)?[\s\S]*?\?>|\$\{[^}]*\}|<%[\s\S]*?%>/g, '{x}');
  if (/^(https?:)?\/\//i.test(u)) return null;
  u = u.replace(/[?#].*$/, '');
  if (!u || u === '{x}') return null;
  if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip|xlsx?|hwp|docx?|mp4)$/i.test(u)) return null;
  if (!u.startsWith('/') && !u.startsWith('{x}')) u = `${baseDir.replace(/\/$/, '')}/${u}`;
  if (u.startsWith('{x}/')) u = u.slice(3);
  const segs = normalizePath(u)
    .split('/')
    .map((s) => (s.includes('{') || s.includes('}') ? '{x}' : s));
  const out = `/${segs.join('/')}`.replace(/\/\{x\}$/, (x) => x);
  return out === '/' ? '/' : out;
}

/** 제목: <title>, @section('title', …), 첫 h1~h3 */
export function extractTitle(text: string): { title: string; offset: number } | null {
  const clean = (s: string) =>
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{x\}|\{\{[\s\S]*?\}\}|<\?[\s\S]*?\?>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .replace(/\s*[|\-–:]\s*$/, '')
      .trim();
  const sec = /@section\(\s*['"]title['"]\s*,\s*['"]([^'"]+)['"]\s*\)/.exec(text);
  if (sec && clean(sec[1])) return { title: clean(sec[1]), offset: sec.index };
  const secBlock = /@section\(\s*['"]title['"]\s*\)([\s\S]{0,200}?)@(endsection|stop|show)/.exec(text);
  if (secBlock && clean(secBlock[1])) return { title: clean(secBlock[1]), offset: secBlock.index };
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (t) {
    const v = clean(t[1]).split(/\s+[|:\-–]\s+/)[0];
    if (v && /[\p{L}]/u.test(v)) return { title: v, offset: t.index };
  }
  const h = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(text);
  if (h) {
    const v = clean(h[2]);
    if (v && v.length <= 60 && /[\p{L}]/u.test(v)) return { title: v, offset: h.index };
  }
  return null;
}

/** <script src> 경로 (상대 경로는 baseDir 기준) */
export function extractScripts(text: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[2]);
  return out;
}
