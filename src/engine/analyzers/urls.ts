// 화면 코드(JSP·HTML·JS)에서 서버로 가는 URL 찾기
import type { UrlRef } from '../types';
import { cleanUrl } from './jutil';

export interface FoundUrl {
  url: string;
  kind: UrlRef['kind'];
  method?: string;
  index: number;
}

const CONTEXT_VARS = /^(contextPath|ctx|ctxPath|ctxpath|_ctx|CONTEXT_PATH|CTX|contextRoot|context|baseUrl|BASE_URL|baseURL|rootPath|ROOT|gContextPath|g_contextPath|contextpath|webRoot|path|serverUrl|apiBase|API_BASE|apiUrl|API_URL|host)$/;

/** 괄호·따옴표 밖에서 식 끝(, ) } ;)까지 */
function readExpr(s: string, start: number): string {
  let depth = 0;
  let q: string | null = null;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      q = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if ((c === ',' || c === ';' || c === '\n') && depth === 0) break;
  }
  return s.slice(start, i);
}

/** "a" + ctx + "b" 같은 식 → URL (컨텍스트 변수는 버리고, 중간 변수는 {p}) */
export function evalUrlExpr(expr: string): string | null {
  const parts: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) {
      cur += c;
      if (c === '\\') {
        cur += expr[++i] ?? '';
        continue;
      }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === '+' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  let out = '';
  let hasLit = false;
  parts.forEach((p, i) => {
    const lit = /^(['"`])([\s\S]*)\1$/.exec(p);
    if (lit) {
      hasLit = true;
      let v = lit[2];
      if (lit[1] === '`') v = v.replace(/\$\{\s*([\w.]+)\s*\}/g, (_, n: string) => (CONTEXT_VARS.test(n.split('.').pop() ?? '') ? '' : '{p}'));
      out += v;
      return;
    }
    const name = p.replace(/^\(+|\)+$/g, '').trim();
    if (i === 0 && (CONTEXT_VARS.test(name.split('.').pop() ?? '') || /contextPath|ctx|baseUrl|BASE_URL|root/i.test(name))) return;
    if (i === 0 && parts.length > 1) return; // 앞 변수는 대개 기준 경로
    out += '{p}';
  });
  if (!hasLit) return null;
  return cleanUrl(out);
}

/** JS 코드(또는 JSP 안 스크립트)에서 URL */
export function jsUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  const add = (expr: string, kind: UrlRef['kind'], index: number, method?: string) => {
    const u = evalUrlExpr(expr);
    if (u) out.push({ url: u, kind, index, ...(method ? { method } : {}) });
  };
  const run = (re: RegExp, kind: UrlRef['kind'], methodOf?: (m: RegExpExecArray) => string | undefined) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + m[0].length;
      add(readExpr(text, start), kind, m.index, methodOf?.(m));
    }
  };
  // $.ajax({ url: … , type: 'POST' })
  const ajaxRe = /\burl\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = ajaxRe.exec(text))) {
    const start = m.index + m[0].length;
    const expr = readExpr(text, start);
    const around = text.slice(Math.max(0, m.index - 300), Math.min(text.length, start + 300));
    const method = /\b(?:type|method)\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i.exec(around)?.[1]?.toUpperCase();
    add(expr, 'ajax', m.index, method);
  }
  run(/\$\.(post|get|getJSON|ajax)\s*\(\s*(?=['"`]|[\w$.]+\s*\+)/g, 'ajax', (x) => (x[1] === 'post' ? 'POST' : x[1] === 'ajax' ? undefined : 'GET'));
  run(/\.load\s*\(\s*(?=['"`]|[\w$.]+\s*\+)/g, 'ajax');
  run(/\bfetch\s*\(\s*/g, 'fetch');
  run(/\baxios(?:\.(get|post|put|delete|patch))?\s*\(\s*(?=['"`]|[\w$.]+\s*\+)/g, 'ajax', (x) => x[1]?.toUpperCase());
  run(/\blocation\.href\s*=\s*/g, 'location');
  run(/\blocation\s*=\s*(?=['"`])/g, 'location');
  run(/\blocation\.(?:replace|assign)\s*\(\s*/g, 'location');
  run(/\bwindow\.open\s*\(\s*/g, 'popup');
  run(/\.action\s*=\s*/g, 'form', () => 'POST');
  run(/\.attr\s*\(\s*['"]action['"]\s*,\s*/g, 'form', () => 'POST');
  // fn_xxx('/a.do') 처럼 URL 같은 문자열 인자
  const callRe = /\b[\w$.]+\s*\(\s*(['"])((?:\/[\w\-./{}$]*|[\w\-./]*\.(?:do|action))(?:\?[^'"]*)?)\1/g;
  while ((m = callRe.exec(text))) {
    const u = cleanUrl(m[2]);
    if (u && (/\.(do|action)$/.test(u) || u.split('/').length > 2)) out.push({ url: u, kind: 'link', index: m.index });
  }
  // 그 밖에 .do / .action 으로 끝나는 문자열
  const anyRe = /(['"])([\w\-./{}$]*\.(?:do|action))(?:\?[^'"]*)?\1/g;
  while ((m = anyRe.exec(text))) {
    const u = cleanUrl(m[2]);
    if (u) out.push({ url: u, kind: 'link', index: m.index });
  }
  return out;
}

/** JSP·HTML 마크업 속성에서 URL */
export function markupUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  const attrRe = /<(form(?::form)?|a|iframe|frame|area|jsp:forward)\b([^>]*?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(text))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const name = tag.startsWith('form') ? 'action' : tag === 'a' || tag === 'area' ? 'href' : tag === 'jsp:forward' ? 'page' : 'src';
    const am = new RegExp(`\\b(?:th:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    if (!am) continue;
    let raw = am[2] ?? am[3] ?? '';
    const thyme = /^@\{([^}]*)\}/.exec(raw);
    if (thyme) raw = thyme[1].replace(/\([^)]*\)/g, '');
    if (/^javascript:/i.test(raw)) continue;
    const u = cleanUrl(raw);
    if (!u) continue;
    const kind: UrlRef['kind'] = tag.startsWith('form') ? 'form' : tag === 'iframe' || tag === 'frame' ? 'ajax' : 'link';
    const method = tag.startsWith('form') ? (/\bmethod\s*=\s*["']?(get|post|put|delete)/i.exec(attrs)?.[1]?.toUpperCase() ?? 'GET') : undefined;
    out.push({ url: u, kind, index: m.index, ...(method ? { method } : {}) });
  }
  // <c:url var="x" value="/a.do"/> 처럼 변수로 쓰는 URL
  const cvar = /<(?:c|spring):url\s+[^>]*?value\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = cvar.exec(text))) {
    const u = cleanUrl(m[1]);
    if (u) out.push({ url: u, kind: 'link', index: m.index });
  }
  // Thymeleaf th:action / th:href
  const th = /\bth:(?:action|href)\s*=\s*["']@\{([^}]*)\}/g;
  while ((m = th.exec(text))) {
    const u = cleanUrl(m[1].replace(/\([^)]*\)/g, ''));
    if (u) out.push({ url: u, kind: /action/.test(m[0]) ? 'form' : 'link', index: m.index });
  }
  return out;
}

/** 같은 URL·종류는 한 번만 (앞쪽 위치 유지) */
export function dedupeUrls(list: FoundUrl[]): FoundUrl[] {
  const seen = new Map<string, FoundUrl>();
  for (const u of list.sort((a, b) => a.index - b.index)) {
    const k = `${u.kind}|${u.url}`;
    const prev = seen.get(k);
    if (!prev) seen.set(k, u);
    else if (!prev.method && u.method) prev.method = u.method;
  }
  // link 로 잡힌 것과 같은 URL이 ajax·form 으로도 있으면 link는 버림
  const strong = new Set([...seen.values()].filter((u) => u.kind !== 'link').map((u) => u.url));
  return [...seen.values()].filter((u) => u.kind !== 'link' || !strong.has(u.url));
}
