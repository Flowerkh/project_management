// JSP·HTML 화면: 제목, include 조각, script, 화면이 부르는 URL
import type { Analyzer, Ctx } from '../context';
import type { FileInfo, ViewFact } from '../types';
import { baseName, makeLineIndex } from '../files';
import { cleanUrl, findByTail, resolveWebPath, stripCComments, stripMarkupComments, webRoot } from './jutil';
import { dedupeUrls, jsUrls, markupUrls } from './urls';

interface TitleCands {
  title?: { text: string; line: number };
  heading?: { text: string; line: number };
  comment?: { text: string; line: number };
  /** <spring:message code>가 섞인 제목 원문 (메시지 파일에서 풀어 finish에서 확정) */
  titleRaw?: { raw: string; line: number };
  headingRaw?: { raw: string; line: number };
}

const MSG_TAG = /<(?:spring:message|fmt:message)\s+[^>]*?(?:code|key)\s*=\s*["']([^"']+)["']/i;
const MSG_TAG_G = /<(?:spring|fmt):message\b[^>]*?\b(?:code|key)\s*=\s*["']([^"']+)["'][^>]*>(?:\s*<\/(?:spring|fmt):message>)?/gi;

/** <c:set var="x" value="…"/>, <c:set var="x">…</c:set> → 변수 값 (eGov: ${pageTitle}) */
function jspVars(src: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of src.matchAll(/<c:set\b([^>]*?)(\/>|>([\s\S]*?)<\/c:set>)/gi)) {
    const name = /\bvar\s*=\s*["'](\w+)["']/.exec(m[1])?.[1];
    if (!name || vars.has(name)) continue;
    const value = /\bvalue\s*=\s*"([^"]*)"|\bvalue\s*=\s*'([^']*)'/.exec(m[1]);
    const v = value ? value[1] ?? value[2] : m[3];
    if (v !== undefined && v.length <= 300) vars.set(name, v);
  }
  return vars;
}

/** message*.properties → 키·값 (한국어 파일 우선) */
function messages(ctx: Ctx): Map<string, string> {
  const files = ctx.facts.files.filter((f) => !f.excluded && f.lang === 'Properties' && /(^|\/)(message|messages|label|labels)[\w-]*\.properties$/i.test(f.path));
  files.sort((a, b) => Number(/_ko/i.test(b.name)) - Number(/_ko/i.test(a.name)));
  const map = new Map<string, string>();
  for (const f of files.reverse()) {
    const text = ctx.facts.texts.get(f.id) ?? '';
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
      if (!m) continue;
      map.set(m[1].trim(), m[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).trim());
    }
  }
  return map;
}

const states = new WeakMap<Ctx, Map<string, TitleCands>>();
function titles(ctx: Ctx): Map<string, TitleCands> {
  let s = states.get(ctx);
  if (!s) {
    s = new Map();
    states.set(ctx, s);
  }
  return s;
}

const JAVA_WEB = /(^|\/)(src\/main\/webapp|WebContent|WebRoot|src\/main\/resources\/(templates|static|public)|WEB-INF)\//;
const FRAGMENT_DIRS = /(^|\/)(inc|incs|include|includes|layout|layouts|common|tiles|decorators?|fragments?|partials?|frames?|template|tpl|cmm\/include)\//i;
const FRAGMENT_NAMES = /^(header|footer|top|left|right|menu|lnb|gnb|snb|sidebar|side|navi|nav|navbar|head|bottom|quick|quickmenu|taglib|taglibs|layout|default|base|script|scripts|css|meta|title|location|breadcrumb|paging|pagination)([_-]?(inc|include|jsp|top|bottom|menu))?\.(jsp|jspf|html|htm)$/i;

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\$\{[^}]*\}|<%=[^%]*%>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .replace(/^[\s▒░▓█■□◆◇●○★☆▶◀▷◁►◄※]+|[\s▒░▓█■□◆◇●○★☆▶◀▷◁►◄※]+$/g, '') // 장식 기호
    .trim();
}

function cutSiteName(t: string): string {
  const parts = t.split(/\s+[|:·>-]{1,2}\s+|\s*::\s*/).map((x) => x.trim()).filter(Boolean);
  return parts[0] ?? t;
}

/** c:url·spring:url 감싸기를 값으로 바꿔 둔다 (속성 안 겹따옴표 문제 회피) */
function unwrapUrlTags(s: string): string {
  return s
    .replace(/<(c|spring):url\s+value\s*=\s*"([^"]*)"\s*\/>/gi, (_, __, v) => v)
    .replace(/<(c|spring):url\s+value\s*=\s*'([^']*)'\s*\/>/gi, (_, __, v) => v)
    .replace(/<(c|spring):url\s+value\s*=\s*["']([^"']*)["']\s*>[\s\S]*?<\/\1:url>/gi, (_, __, v) => v);
}

function resolveRef(ctx: Ctx, f: FileInfo, ref: string, root: string | null): string | null {
  const raw = ref.replace(/\$\{[^}]*\}|<%=[^%]*%>/g, '').replace(/^(https?:)?\/\/[^/]+/i, '');
  if (!raw || /^(https?:|javascript:|data:)/i.test(ref)) return null;
  const p = resolveWebPath(f.path, raw, root);
  if (ctx.byPath.has(p)) return p;
  const hit = findByTail(ctx, raw.replace(/^\/+/, ''));
  return hit ? hit.path : p;
}

export const jspAnalyzer: Analyzer = {
  name: 'jsp',
  order: 30,
  accepts(f) {
    if (f.layer === 'TEST') return false;
    if (f.lang === 'JSP') return true;
    if (f.lang === 'HTML' && JAVA_WEB.test(f.path)) return true;
    return false;
  },
  analyze(f, text, ctx) {
    const lineOf = makeLineIndex(text);
    const src0 = stripMarkupComments(text);
    // c:url 풀기는 같은 줄 안에서만 길이가 줄어 줄 번호는 따로 센다
    const src = unwrapUrlTags(src0);
    const lineSrc = makeLineIndex(src);
    const root = webRoot(f.path);
    const isThyme = /\bxmlns:th=|\bth:(text|each|if|href|action|replace|insert)=/.test(text);
    const view: ViewFact = {
      file: f.id,
      kind: f.lang === 'JSP' ? 'jsp' : isThyme ? 'template' : 'html',
      urls: [],
      includes: [],
      scripts: [],
    };
    // 제목 후보 (${변수}는 같은 파일의 <c:set> 값으로, 메시지 태그는 finish에서 풂)
    const vars = jspVars(src0);
    const sub = (s: string) => {
      let r = s.replace(/<c:out\s+value\s*=\s*"([^"]*)"[^>]*\/>/gi, '$1');
      for (let k = 0; k < 2 && /\$\{\s*\w+\s*\}/.test(r); k++) r = r.replace(/\$\{\s*(\w+)\s*\}/g, (all, n: string) => vars.get(n) ?? all);
      return r;
    };
    const tc: TitleCands = {};
    const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src0);
    if (tm) {
      const raw = sub(tm[1]);
      const t = cutSiteName(textOf(raw));
      if (t && t.length <= 60) tc.title = { text: t, line: lineOf(tm.index) };
      if (MSG_TAG.test(raw)) tc.titleRaw = { raw, line: lineOf(tm.index) };
    }
    const hm = /<(h[1-4])\b[^>]*class\s*=\s*["'][^"']*\b(title|tit|page[-_]?title|sub[-_]?title|h_title|cont_tit|con_title)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(src0)
      ?? /<(h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(src0);
    if (hm) {
      const raw = sub(hm[3] ?? hm[2]);
      const t = textOf(raw);
      if (t && t.length <= 60) tc.heading = { text: t, line: lineOf(hm.index) };
      if (MSG_TAG.test(raw)) tc.headingRaw = { raw, line: lineOf(hm.index) };
    }
    const cm = /<%--([\s\S]*?)--%>/.exec(text.slice(0, 3000));
    if (cm) {
      const d = /(?:Description|설명|화면명|화면\s*이름|Title|desc)\s*[:：]\s*([^\n\r]+)/i.exec(cm[1]);
      if (d) {
        const t = d[1].replace(/\*+\/?$/, '').trim();
        if (t && t.length <= 60) tc.comment = { text: t, line: lineOf(cm.index) };
      }
    }
    titles(ctx).set(f.id, tc);
    // include
    const incRe = /<%@\s*include\s+file\s*=\s*["']([^"']+)["']|<jsp:include\s+page\s*=\s*["']([^"']+)["']|<c:import\s+url\s*=\s*["']([^"']+)["']|\bth:(?:replace|insert|include)\s*=\s*["']~?\{?\s*([\w/.-]+)\s*(?:::|["'}])/g;
    let m: RegExpExecArray | null;
    const extraUrls: { url: string; index: number }[] = [];
    while ((m = incRe.exec(src0))) {
      let ref = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      if (!ref) continue;
      if (m[4]) {
        // Thymeleaf: templates 기준 이름
        const troot = /^(.*\/src\/main\/resources\/templates)\//.exec(f.path)?.[1];
        const p = `${troot ?? ''}/${ref}${/\.html?$/.test(ref) ? '' : '.html'}`.replace(/^\/+/, '');
        if (!view.includes.includes(p)) view.includes.push(p);
        continue;
      }
      if (/\.(do|action)(\?|$)/.test(ref)) {
        extraUrls.push({ url: ref, index: m.index });
        continue;
      }
      if (/\$\{/.test(ref) && !/contextPath|ctx/.test(ref)) continue;
      const p = resolveRef(ctx, f, ref, root);
      if (p && !view.includes.includes(p)) view.includes.push(p);
    }
    // script src
    const scRe = /<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;
    while ((m = scRe.exec(src))) {
      const ref = m[2] ?? m[3] ?? '';
      if (/^(https?:)?\/\//i.test(ref)) continue;
      const p = resolveRef(ctx, f, ref, root);
      if (!p) continue;
      const target = ctx.byPath.get(p);
      if (!target || target.excluded) continue;
      if (!view.scripts.includes(p)) view.scripts.push(p);
    }
    // URL: 마크업 속성 + 인라인 스크립트(주석 제거)
    const scriptText = src.replace(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (all, body: string) => all.replace(body, stripCComments(body)));
    const found = dedupeUrls([...markupUrls(src), ...jsUrls(scriptText)]);
    for (const u of found) {
      view.urls.push({ url: u.url, kind: u.kind, file: f.id, line: lineSrc(u.index), ...(u.method ? { method: u.method } : {}) });
    }
    for (const x of extraUrls) {
      const u = cleanUrl(x.url);
      if (u && !view.urls.some((y) => y.url === u)) view.urls.push({ url: u, kind: 'ajax', file: f.id, line: lineOf(x.index) });
    }
    // 조각·직접 URL
    const name = baseName(f.path);
    if (/\.(jspf|tag|tagx)$/i.test(name) || /\/WEB-INF\/tags\//.test(f.path) || FRAGMENT_DIRS.test(f.path) || FRAGMENT_NAMES.test(name)) view.fragment = true;
    if (root && !f.path.includes('/WEB-INF/') && !/src\/main\/resources\/templates\//.test(f.path)) {
      view.directUrl = `/${f.path.slice(root.length + 1)}`;
    }
    ctx.facts.views.push(view);
    f.layer = 'VIEW';
  },
  finish(ctx) {
    const views = ctx.facts.views.filter((v) => {
      const f = ctx.byId.get(v.file);
      return f && (f.lang === 'JSP' || f.lang === 'HTML');
    });
    // 다른 화면이 include 하는 파일은 조각
    const included = new Set<string>();
    for (const v of ctx.facts.views) for (const p of v.includes) included.add(p);
    for (const v of views) {
      const f = ctx.byId.get(v.file);
      if (f && included.has(f.path)) v.fragment = true;
    }
    // 제목 고르기: 여러 화면에 똑같이 붙은 <title>은 사이트 이름으로 보고 버림
    const tmap = titles(ctx);
    // 메시지 코드로 된 제목 풀기
    if ([...tmap.values()].some((c) => c.titleRaw || c.headingRaw)) {
      const msg = messages(ctx);
      const resolve = (raw: string) => textOf(raw.replace(MSG_TAG_G, (all, code: string) => msg.get(code) ?? /\btext\s*=\s*["']([^"']*)["']/i.exec(all)?.[1] ?? ''));
      for (const c of tmap.values()) {
        if (c.titleRaw) {
          const t = cutSiteName(resolve(c.titleRaw.raw));
          if (t && t.length <= 60) c.title = { text: t, line: c.titleRaw.line };
        }
        if (c.headingRaw) {
          const t = resolve(c.headingRaw.raw);
          if (t && t.length <= 60) c.heading = { text: t, line: c.headingRaw.line };
        }
      }
    }
    const count = new Map<string, number>();
    for (const v of views) {
      const t = tmap.get(v.file)?.title?.text;
      if (t) count.set(t, (count.get(t) ?? 0) + 1);
    }
    const pages = views.filter((v) => !v.fragment).length;
    for (const v of views) {
      const c = tmap.get(v.file);
      if (!c) continue;
      const titleOk = c.title && ((count.get(c.title.text) ?? 0) <= Math.max(2, pages * 0.1));
      const pick = titleOk ? c.title : c.heading ?? c.comment ?? (c.title && pages <= 2 ? c.title : undefined);
      if (pick) {
        v.title = pick.text;
        v.titleLine = pick.line;
      }
    }
  },
};
