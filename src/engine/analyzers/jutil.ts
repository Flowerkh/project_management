// Java·JSP·스크립트 분석기 공용 도구 (주석·문자열 가리기, 경로 해석, URL 정리)
import type { Ctx } from '../context';
import type { FileInfo } from '../types';
import { dirName, normalizePath } from '../files';

/** 같은 길이로 바꾸기 (줄바꿈은 유지해 줄 번호가 그대로) */
export function blank(s: string, ch = ' '): string {
  return s.replace(/[^\n]/g, ch);
}

/** Java·JS 계열 주석을 공백으로 (문자열 안은 그대로) */
export function stripCComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' && src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      const end = e < 0 ? n : e + 3;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 문자열·문자 리터럴 내용을 가린 구조용 텍스트 (따옴표는 남김) */
export function blankStrings(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' && code.startsWith('"""', i)) {
      const e = code.indexOf('"""', i + 3);
      const end = e < 0 ? n : e + 3;
      const inner = code.slice(i + 3, e < 0 ? n : e);
      out += `"""${blank(inner, '_')}${e < 0 ? '' : '"""'}`;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') {
        if (code[j] === '\\') j++;
        j++;
      }
      out += c + blank(code.slice(i + 1, j), '_') + (j < n ? code[j] : '');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 자바 문자열 리터럴 값 (이스케이프 처리) */
export function unescapeJava(s: string): string {
  return s.replace(/\\(["'\\nrtbf])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '' } as Record<string, string>)[c] ?? c);
}

/** 문자열 리터럴 목록: 위치와 값 */
export function stringLiterals(code: string, from = 0, to = code.length): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  let i = from;
  while (i < to) {
    const c = code[i];
    if (c === '"' && code.startsWith('"""', i)) {
      const e = code.indexOf('"""', i + 3);
      const end = e < 0 ? to : e + 3;
      out.push({ start: i, end, value: code.slice(i + 3, Math.max(i + 3, end - 3)).replace(/^[ \t]*\n/, '') });
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < to && code[j] !== '"' && code[j] !== '\n') {
        if (code[j] === '\\') j++;
        j++;
      }
      out.push({ start: i, end: j + 1, value: unescapeJava(code.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // 문자 리터럴 건너뛰기
      let j = i + 1;
      while (j < to && code[j] !== "'" && code[j] !== '\n') {
        if (code[j] === '\\') j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** 괄호 짝 찾기: open 위치의 '(' '{' '[' 에 맞는 닫는 위치 (구조용 텍스트 기준) */
export function matchClose(skel: string, open: number): number {
  const o = skel[open];
  const c = o === '(' ? ')' : o === '{' ? '}' : ']';
  let depth = 0;
  for (let i = open; i < skel.length; i++) {
    const ch = skel[i];
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return skel.length - 1;
}

/** HTML·JSP 주석을 공백으로 */
export function stripMarkupComments(src: string): string {
  return src
    .replace(/<%--[\s\S]*?--%>/g, (m) => blank(m))
    .replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
}

/** 웹 루트(src/main/webapp, WebContent, webapp …) 찾기 */
export function webRoot(path: string): string | null {
  const i = path.indexOf('/WEB-INF/');
  if (i >= 0) return path.slice(0, i);
  const m = /^(.*?\/(?:src\/main\/webapp|WebContent|WebRoot|webapp|web|public_html|src\/main\/resources\/static|src\/main\/resources\/public|static))(?:\/|$)/.exec(path);
  return m ? m[1] : null;
}

/** 프로젝트 안 경로로 해석: '/'로 시작하면 웹 루트 기준, 아니면 현재 파일 기준 */
export function resolveWebPath(fromPath: string, ref: string, root: string | null): string {
  const clean = ref.replace(/\\/g, '/').replace(/[?#].*$/, '');
  if (clean.startsWith('/')) return normalizePath(`${root ?? dirName(fromPath)}${clean}`);
  return normalizePath(`${dirName(fromPath)}/${clean}`);
}

/** 경로 꼬리로 파일 찾기 (배포 경로 /app/batch/x.sh → 저장소의 batch/x.sh) */
export function findByTail(ctx: Ctx, ref: string): FileInfo | undefined {
  const p = ref.replace(/\\/g, '/').replace(/^["']|["']$/g, '').replace(/^[A-Za-z]:/, '').replace(/^\.\//, '');
  const segs = p.split('/').filter((s) => s && s !== '.');
  for (let k = 0; k < segs.length; k++) {
    const tail = segs.slice(k).join('/');
    const exact = ctx.byPath.get(tail);
    if (exact) return exact;
    const hits = ctx.facts.files.filter((f) => !f.excluded && (f.path === tail || f.path.endsWith(`/${tail}`)));
    if (hits.length) return hits.sort((a, b) => a.path.length - b.path.length)[0];
  }
  return undefined;
}

/** 화면이 부르는 URL 정리: 컨텍스트 경로·c:url·EL·쿼리 제거. URL이 아니면 null */
export function cleanUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // <c:url value='/x.do'/> 감싸기
  const cu = /<c:url\s+value\s*=\s*["']([^"']*)["']/i.exec(s);
  if (cu) s = cu[1];
  s = s.replace(/<c:out\s+value\s*=\s*["']\$\{[^}]*\}["']\s*\/?>/gi, '');
  s = s.replace(/\$\{\s*(pageContext\.request\.contextPath|pageContext\.servletContext\.contextPath|ctx|contextPath|context|ctxPath|ctxpath|root|CONTEXT_PATH|cPath|path|webRoot)\s*\}/g, '');
  s = s.replace(/<%=\s*request\.getContextPath\(\)\s*%>/g, '');
  s = s.replace(/^(https?:)?\/\/[^/]+/i, (m) => (m.startsWith('//') || /localhost|127\.0\.0\.1|\$\{/.test(m) ? '' : m));
  if (/^(https?:|mailto:|tel:|javascript:|data:|#)/i.test(s)) return null;
  s = s.replace(/[?#].*$/, '');
  // 남은 EL·JSP 식·{{ }} → 경로 조각 하나
  s = s.replace(/\$\{[^}]*\}|<%=[^%]*%>|\{\{[^}]*\}\}|<\?=?[^?]*\?>/g, '{p}');
  s = s.replace(/'\s*\+\s*[^+]+\s*\+\s*'/g, '{p}');
  s = s.trim();
  if (!s || s === '{p}' || s === '/') return null;
  if (/\s/.test(s)) return null;
  if (!/^[\w./{}~:%@-]+$/.test(s)) return null;
  if (/^\{p\}$/.test(s)) return null;
  // 정적 파일은 화면이 부르는 처리 URL이 아님
  if (/\.(js|css|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|map|pdf|xlsx?|docx?|hwp|zip|txt|json|xml|mp4|mp3)$/i.test(s)) return null;
  return s;
}

export function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

export function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toUpperCase();
}
