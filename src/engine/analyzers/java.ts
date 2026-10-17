// Java: 클래스·필드·메서드, Spring 라우트·뷰 이름, 호출 관계, DAO statement, 문자열 SQL, JPA, 스케줄
// 뷰 리졸버 설정(XML·properties·Java config·Tiles)도 여기서 읽는다.
import type { Analyzer, Ctx } from '../context';
import type { CodeUnit, MethodUnit, Route, ViewResolver } from '../types';
import { makeLineIndex } from '../files';
import { compactSql, isSqlLike, parseSql } from '../sql';
import { blank, blankStrings, lowerFirst, matchClose, snake, stringLiterals, stripCComments, unescapeJava } from './jutil';

// ------------------------------------------------------------------ 작은 도구

interface Ann {
  name: string;   // 단순 이름 (RequestMapping)
  args: string;   // 괄호 안 원문 (문자열 포함)
  start: number;
  end: number;
}

/** 괄호·중괄호·문자열 밖의 콤마로 나누기 */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\') {
        cur += s[++i] ?? '';
        continue;
      }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 애노테이션 인자에서 key(없으면 위치 인자)의 식 */
function annArg(args: string, key: string | null): string | undefined {
  const parts = splitArgs(args);
  for (const p of parts) {
    const m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(p);
    if (m && !/^["{]/.test(p)) {
      if (key && m[1] === key) return m[2].trim();
    } else if (key === null || key === 'value') {
      return p;
    }
  }
  return undefined;
}

/** 식에서 문자열 값들 ("a", {"a","b"}, CONST, "a" + CONST) */
function strValues(expr: string | undefined, consts: Map<string, string>): string[] {
  if (!expr) return [];
  const e = expr.trim();
  if (e.startsWith('{')) return splitArgs(e.slice(1, e.lastIndexOf('}'))).flatMap((x) => strValues(x, consts));
  const v = constExpr(e, consts);
  return v === undefined ? [] : [v];
}

/** "a" + CONST + "b" 같은 상수 식 계산 (모르면 undefined) */
function constExpr(expr: string, consts: Map<string, string>): string | undefined {
  const parts = expr.split(/\s*\+\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  let out = '';
  for (const raw of parts) {
    const p = raw.trim();
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(p);
    if (lit) {
      out += unescapeJava(lit[1]);
      continue;
    }
    const name = p.replace(/^(?:[\w$]+\.)*([\w$]+)$/, '$1');
    if (consts.has(name)) {
      out += consts.get(name);
      continue;
    }
    return undefined;
  }
  return out;
}

/** 머리 부분(skel 기준)에서 애노테이션 찾기 */
function annotationsIn(code: string, skel: string, from: number, to: number): Ann[] {
  const out: Ann[] = [];
  const re = /@\s*([A-Za-z_$][\w$.]*)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skel)) && m.index < to) {
    if (m[1] === 'interface') continue;
    let end = m.index + m[0].length;
    let args = '';
    let k = end;
    while (k < to && /\s/.test(skel[k])) k++;
    if (skel[k] === '(') {
      const close = matchClose(skel, k);
      args = code.slice(k + 1, close);
      end = close + 1;
    }
    const name = m[1].slice(m[1].lastIndexOf('.') + 1);
    out.push({ name, args, start: m.index, end });
    re.lastIndex = end;
  }
  return out;
}

/** 원문에서 [from,to) 안의 마지막 /** … *\/ 첫 줄 */
function docBefore(text: string, from: number, to: number): string | undefined {
  const seg = text.slice(Math.max(0, from), to);
  let m: RegExpExecArray | null;
  let last: string | undefined;
  const re = /\/\*\*([\s\S]*?)\*\//g;
  while ((m = re.exec(seg))) last = m[1];
  if (last === undefined) {
    // 바로 위 // 한 줄 주석
    const lines = seg.split('\n').map((l) => l.trim()).filter(Boolean);
    const l = lines[lines.length - 1];
    if (l && l.startsWith('//')) return l.replace(/^\/\/+\s*/, '').trim() || undefined;
    return undefined;
  }
  const line = last
    .split('\n')
    .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
    .find((l) => l && !l.startsWith('@') && !/^<\/?p>$/i.test(l));
  return line ? line.replace(/<[^>]+>/g, '').trim() : undefined;
}

const JDK_TYPES = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Math', 'Arrays', 'Collections', 'Objects', 'List', 'Map', 'Set', 'System',
  'StringUtils', 'ObjectUtils', 'CollectionUtils', 'EgovStringUtil', 'EgovDateUtil', 'LocalDate', 'LocalDateTime', 'Optional', 'Stream',
  'Collectors', 'Thread', 'UUID', 'BigDecimal', 'Date', 'Calendar', 'URLEncoder', 'URLDecoder', 'Base64', 'Pattern', 'Files', 'Paths',
  'LoggerFactory', 'Logger', 'LOGGER', 'LOG', 'log', 'logger', 'ResponseEntity', 'HttpStatus', 'MediaType', 'JSONObject', 'JSONArray',
  'ObjectMapper', 'Gson', 'BeanUtils', 'Assert', 'DateFormat', 'SimpleDateFormat', 'NumberUtils', 'ArrayUtils', 'IOUtils', 'FileUtils',
  'EgovProperties', 'EgovFileScrty', 'Character', 'Byte', 'Short', 'Class', 'Enum', 'Exception', 'RuntimeException', 'HttpServletRequest',
]);

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized', 'super', 'this', 'throw', 'else', 'try', 'do', 'assert', 'case']);

const STMT_METHODS = /\b(selectList|selectOne|selectMap|selectCursor|selectByPk|selectListWithPaging|select|insert|update|delete|list|listWithPaging|queryForList|queryForObject|queryForMap|queryForPaginatedList|queryWithRowHandler)\s*\(\s*([^,)]+)/g;

const MAPPING: Record<string, string> = {
  RequestMapping: '*', GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

function joinPath(prefix: string, p: string): string {
  const a = prefix.trim();
  const b = p.trim();
  let s = !a ? b : !b ? a : `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/{2,}/g, '/');
}

function simpleType(t: string): string {
  return t.replace(/<[\s\S]*$/, '').replace(/\[\]/g, '').replace(/\.\.\.$/, '').trim().split('.').pop() ?? t;
}

// ------------------------------------------------------------------ 클래스 해석

interface TypeDecl {
  kw: string;          // class | interface | enum | record
  name: string;
  kwPos: number;
  headerStart: number;
  bodyStart: number;   // '{'
  bodyEnd: number;     // '}'
  extendsTypes: string[];
  implementsTypes: string[];
  typeArgsOfExtends: string[]; // JpaRepository<Order, Long> → ['Order','Long']
}

function findTopTypes(skel: string): TypeDecl[] {
  const out: TypeDecl[] = [];
  let depth = 0;
  let lastStmtEnd = 0;
  for (let i = 0; i < skel.length; i++) {
    const c = skel[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) lastStmtEnd = i + 1;
    } else if (c === ';' && depth === 0) lastStmtEnd = i + 1;
    if (depth !== 0) continue;
    const m = /^(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(skel.slice(i, i + 200));
    if (!m || (i > 0 && /[\w$.@]/.test(skel[i - 1]))) continue;
    // 본문 { 찾기 (괄호 밖)
    let j = i + m[0].length;
    let paren = 0;
    let angle = 0;
    while (j < skel.length) {
      const ch = skel[j];
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '<') angle++;
      else if (ch === '>') angle--;
      else if (ch === '{' && paren === 0 && angle <= 0) break;
      else if (ch === ';' && paren === 0) break;
      j++;
    }
    if (skel[j] !== '{') continue;
    const header = skel.slice(i + m[0].length, j);
    const ext = /\bextends\s+([\s\S]+?)(?=\bimplements\b|$)/.exec(header)?.[1] ?? '';
    const imp = /\bimplements\s+([\s\S]+)$/.exec(header)?.[1] ?? '';
    const typeList = (s: string) => splitArgs(s.replace(/\s+/g, ' ')).map((x) => simpleType(x)).filter(Boolean);
    const typeArgs = /<([^>]*)>/.exec(ext)?.[1]?.split(',').map((x) => simpleType(x.trim())) ?? [];
    const end = matchClose(skel, j);
    out.push({
      kw: m[1], name: m[2], kwPos: i, headerStart: lastStmtEnd, bodyStart: j, bodyEnd: end,
      extendsTypes: typeList(ext), implementsTypes: typeList(imp), typeArgsOfExtends: typeArgs,
    });
    i = end;
    lastStmtEnd = end + 1;
  }
  return out;
}

interface Member {
  start: number;
  headerEnd: number;
  blockEnd: number | null;
}

function members(skel: string, decl: TypeDecl): Member[] {
  const out: Member[] = [];
  let seg = decl.bodyStart + 1;
  let paren = 0;
  let brace = 0;
  let inInit = false;
  for (let i = decl.bodyStart + 1; i < decl.bodyEnd; i++) {
    const c = skel[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '{' && paren === 0) {
      if (brace === 0 && !inInit) {
        // 필드 초기화( = { … } 또는 람다 )인지 확인
        let p2 = 0;
        let assign = false;
        for (let k = seg; k < i; k++) {
          const ch = skel[k];
          if (ch === '(') p2++;
          else if (ch === ')') p2--;
          else if (ch === '=' && p2 === 0 && !/[=!<>]/.test(skel[k - 1]) && skel[k + 1] !== '=') assign = true;
        }
        if (assign) {
          inInit = true;
          brace = 1;
          continue;
        }
        const close = matchClose(skel, i);
        out.push({ start: seg, headerEnd: i, blockEnd: close });
        i = close;
        seg = close + 1;
        continue;
      }
      brace++;
    } else if (c === '}' && paren === 0) {
      brace--;
      if (brace < 0) brace = 0;
    } else if (c === ';' && paren === 0 && brace === 0) {
      out.push({ start: seg, headerEnd: i, blockEnd: null });
      seg = i + 1;
      inInit = false;
    }
  }
  return out;
}

interface Param {
  type: string;
  name: string;
}

function parseParams(code: string): Param[] {
  const out: Param[] = [];
  for (const raw of splitArgs(code)) {
    let p = raw.replace(/@[\w.]+(\s*\([^)]*\))?/g, ' ').replace(/\bfinal\b/g, ' ').trim();
    p = p.replace(/\s+/g, ' ');
    const m = /^([\w$.<>\[\],?\s]+?)\s*(\.\.\.)?\s+([A-Za-z_$][\w$]*)$/.exec(p);
    if (m) out.push({ type: m[1].trim(), name: m[3] });
  }
  return out;
}

const MODIFIERS = /\b(public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed)\b/g;

function classifyKind(decl: TypeDecl, anns: Ann[], file: string): CodeUnit['kind'] {
  const has = (n: string) => anns.some((a) => a.name === n);
  const name = decl.name;
  const sup = [...decl.extendsTypes, ...decl.implementsTypes];
  if (has('Controller') || has('RestController') || /Controller$/.test(name) && (decl.kw === 'class')) return 'controller';
  if (decl.kw === 'interface' && sup.some((s) => /^(JpaRepository|CrudRepository|PagingAndSortingRepository|ListCrudRepository|ReactiveCrudRepository|JpaSpecificationExecutor|Repository)$/.test(s))) return 'repository';
  if (has('Mapper') || (decl.kw === 'interface' && /Mapper$/.test(name))) return 'mapper';
  if (has('Entity') || has('Table') && decl.kw === 'class') return 'model';
  if (sup.some((s) => /^(Job|QuartzJobBean|StatefulJob|InterruptableJob|Tasklet)$/.test(s))) return 'job';
  if (has('Service') || /(Service|ServiceImpl|Facade|Manager)$/.test(name)) return 'service';
  if (has('Repository') || /(DAO|Dao|DAOImpl|DaoImpl|Repository)$/.test(name)) return 'dao';
  if (/(VO|DTO|Dto|Vo|Entity|Domain|Default|Form|Param|Result)$/.test(name) || /\/(vo|dto|entity|domain|model)\//i.test(file)) return 'model';
  return 'other';
}

// ------------------------------------------------------------------ 뷰 리졸버 설정

function resolversFromXml(text: string, file: string, line: (o: number) => number): ViewResolver[] {
  const out: ViewResolver[] = [];
  const beanRe = /<bean\b([^>]*?)(\/>|>([\s\S]*?)<\/bean>)/g;
  let m: RegExpExecArray | null;
  while ((m = beanRe.exec(text))) {
    const attrs = m[1];
    if (!/class\s*=\s*"[^"]*(InternalResourceViewResolver|UrlBasedViewResolver|JstlView)/.test(attrs)) continue;
    const body = m[3] ?? '';
    const pre = /p:prefix\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? /<property\s+name\s*=\s*"prefix"\s+value\s*=\s*"([^"]*)"/.exec(body)?.[1];
    const suf = /p:suffix\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? /<property\s+name\s*=\s*"suffix"\s+value\s*=\s*"([^"]*)"/.exec(body)?.[1];
    if (pre !== undefined || suf !== undefined) out.push({ prefix: pre ?? '', suffix: suf ?? '', evidence: { file, line: line(m.index) } });
  }
  const mvc = /<mvc:jsp\b[^>]*?prefix\s*=\s*"([^"]*)"[^>]*?(suffix\s*=\s*"([^"]*)")?/g;
  while ((m = mvc.exec(text))) out.push({ prefix: m[1], suffix: m[3] ?? '.jsp', evidence: { file, line: line(m.index) } });
  // Tiles
  if (/<tiles-definitions\b/.test(text)) {
    const defs: Record<string, string> = {};
    const base: Record<string, { ext?: string; body?: string }> = {};
    const defRe = /<definition\b([^>]*?)(\/>|>([\s\S]*?)<\/definition>)/g;
    while ((m = defRe.exec(text))) {
      const name = /\bname\s*=\s*"([^"]*)"/.exec(m[1])?.[1];
      if (!name) continue;
      const ext = /\bextends\s*=\s*"([^"]*)"/.exec(m[1])?.[1];
      const inner = m[3] ?? '';
      const put = /<put-attribute\s+[^>]*name\s*=\s*"(body|content|contents|main|container|bodyContent)"[^>]*value\s*=\s*"([^"]*\.jsp)"/i.exec(inner)
        ?? /<put-attribute\s+[^>]*value\s*=\s*"([^"]*\.jsp)"[^>]*name\s*=\s*"(body|content|contents|main|container|bodyContent)"/i.exec(inner);
      const body = put ? (put[2]?.endsWith('.jsp') ? put[2] : put[1]) : undefined;
      base[name] = { ext, body };
    }
    for (const [name, d] of Object.entries(base)) {
      let body = d.body;
      let cur = d;
      let guard = 0;
      while (!body && cur.ext && base[cur.ext] && guard++ < 8) {
        cur = base[cur.ext];
        body = cur.body;
      }
      if (body) defs[name] = body;
    }
    if (Object.keys(defs).length) out.push({ prefix: '', suffix: '', definitions: defs, evidence: { file, line: 1 } });
  }
  return out;
}

function resolversFromProps(text: string, file: string): ViewResolver[] {
  const pre = /spring\.mvc\.view\.prefix\s*[=:]\s*([^\s#]+)/.exec(text)?.[1] ?? /\bview:\s*\n\s+prefix:\s*['"]?([^\s'"]+)/.exec(text)?.[1];
  const suf = /spring\.mvc\.view\.suffix\s*[=:]\s*([^\s#]+)/.exec(text)?.[1] ?? /\bview:\s*\n(?:\s+prefix:.*\n)?\s+suffix:\s*['"]?([^\s'"]+)/.exec(text)?.[1];
  if (pre === undefined && suf === undefined) return [];
  return [{ prefix: pre ?? '', suffix: suf ?? '', evidence: { file, line: 1 } }];
}

function resolversFromJava(code: string, file: string): ViewResolver[] {
  const out: ViewResolver[] = [];
  let m = /registry\s*\.\s*jsp\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"/.exec(code);
  if (m) out.push({ prefix: m[1], suffix: m[2], evidence: { file, line: 1 } });
  m = /new\s+InternalResourceViewResolver\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"/.exec(code);
  if (m) out.push({ prefix: m[1], suffix: m[2], evidence: { file, line: 1 } });
  const p = /\.setPrefix\s*\(\s*"([^"]*)"/.exec(code)?.[1];
  const s = /\.setSuffix\s*\(\s*"([^"]*)"/.exec(code)?.[1];
  if (p !== undefined || s !== undefined) out.push({ prefix: p ?? '', suffix: s ?? '', evidence: { file, line: 1 } });
  return out;
}

// ------------------------------------------------------------------ 분석기

export const javaAnalyzer: Analyzer = {
  name: 'java',
  order: 20,
  accepts(f, text) {
    if (f.layer === 'TEST') return false; // 테스트 코드는 화면·배치·테이블 연결에서 제외
    if (f.lang === 'Java') return true;
    if (f.lang === 'XML') return /ViewResolver|<tiles-definitions\b|<mvc:jsp\b|<mvc:view-controller\b/.test(text);
    if (f.lang === 'Properties' || f.lang === 'YAML') return /spring\.mvc\.view|\bview:\s*\n\s+(prefix|suffix):/.test(text);
    return false;
  },
  analyze(f, text, ctx) {
    if (f.lang !== 'Java') {
      const line = makeLineIndex(text);
      const clean = f.lang === 'XML' ? text.replace(/<!--[\s\S]*?-->/g, (x) => blank(x)) : text;
      const vr = f.lang === 'XML' ? resolversFromXml(clean, f.id, line) : resolversFromProps(text, f.id);
      ctx.facts.viewResolvers.push(...vr);
      if (f.lang === 'XML') {
        const vcs: { path: string; view: string; line: number }[] = [];
        for (const m of clean.matchAll(/<mvc:view-controller\b([^>]*)\/?>/g)) {
          const path = /\bpath\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
          const view = /\bview-name\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
          if (path && view) vcs.push({ path, view, line: line(m.index ?? 0) });
        }
        addViewControllers(ctx, f.id, vcs);
      }
      return;
    }
    analyzeJava(f.id, f.path, text, ctx);
  },
  finish(ctx) {
    finishJpa(ctx);
    if (!ctx.facts.viewResolvers.length && ctx.facts.files.some((f) => f.lang === 'JSP' && !f.excluded)) {
      ctx.facts.viewResolvers.push({ prefix: '/WEB-INF/jsp/', suffix: '.jsp' }, { prefix: '/WEB-INF/views/', suffix: '.jsp' });
    }
  },
};

function analyzeJava(fileId: string, path: string, text: string, ctx: Ctx): void {
  const code = stripCComments(text);
  const skel = blankStrings(code);
  const lineOf = makeLineIndex(text);
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1];
  const imports = new Map<string, string>();
  for (const m of code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) imports.set(m[1].split('.').pop()!, m[1]);
  ctx.facts.viewResolvers.push(...resolversFromJava(code, fileId));
  const vcs: { path: string; view: string; line: number }[] = [];
  for (const m of code.matchAll(/addViewController\s*\(\s*"([^"]+)"\s*\)\s*\.\s*setViewName\s*\(\s*"([^"]+)"/g)) vcs.push({ path: m[1], view: m[2], line: lineOf(m.index ?? 0) });
  addViewControllers(ctx, fileId, vcs);

  for (const decl of findTopTypes(skel)) {
    const anns = annotationsIn(code, skel, decl.headerStart, decl.kwPos);
    const kind = classifyKind(decl, anns, path);
    const annBy = (n: string) => anns.find((a) => a.name === n);
    const beanAnn = annBy('Service') ?? annBy('Repository') ?? annBy('Controller') ?? annBy('RestController') ?? annBy('Component') ?? annBy('Mapper');
    const consts = new Map<string, string>();
    const fields: Record<string, string> = {};
    const methods: MethodUnit[] = [];
    const ownMethodNames = new Set<string>();
    const classApi = !!annBy('RestController') || !!annBy('ResponseBody');
    const prefixes = annBy('RequestMapping') ? strValues(annArg(annBy('RequestMapping')!.args, 'value') ?? annArg(annBy('RequestMapping')!.args, 'path'), consts) : [];
    const mems = members(skel, decl);

    // 1차: 상수·필드
    for (const mem of mems) {
      const hSkel = skel.slice(mem.start, mem.headerEnd);
      if (mem.blockEnd !== null && !/=/.test(hSkel.replace(/\([^)]*\)/g, ''))) continue;
      const mAnns = annotationsIn(code, skel, mem.start, mem.headerEnd);
      let decl2 = code.slice(mem.start, mem.headerEnd);
      for (const a of [...mAnns].reverse()) decl2 = decl2.slice(0, a.start - mem.start) + ' '.repeat(a.end - a.start) + decl2.slice(a.end - mem.start);
      const eq = decl2.indexOf('=');
      const left = (eq >= 0 ? decl2.slice(0, eq) : decl2).replace(MODIFIERS, ' ').replace(/\s+/g, ' ').trim();
      const fm = /^([\w$.<>\[\],?\s]+?)\s+([A-Za-z_$][\w$]*)$/.exec(left);
      if (!fm || /\(/.test(left)) continue;
      const type = fm[1].trim();
      fields[fm[2]] = type;
      if (eq >= 0 && /\bstatic\b/.test(decl2) && /\bfinal\b/.test(decl2) && /String$/.test(type)) {
        const v = constExpr(decl2.slice(eq + 1).trim(), consts);
        if (v !== undefined) consts.set(fm[2], v);
      }
    }
    // 메서드 이름 먼저
    for (const mem of mems) {
      const sig = methodSig(code, skel, mem, decl.name);
      if (sig) ownMethodNames.add(sig.name);
    }
    // 2차: 메서드
    for (const mem of mems) {
      const sig = methodSig(code, skel, mem, decl.name);
      if (!sig) continue;
      const mAnns = annotationsIn(code, skel, mem.start, mem.headerEnd);
      if (sig.isCtor) {
        for (const p of parseParams(sig.params)) if (!fields[p.name]) fields[p.name] = p.type;
        continue;
      }
      const m: MethodUnit = {
        name: sig.name,
        line: lineOf(sig.namePos),
        ...(mem.blockEnd !== null ? { endLine: lineOf(mem.blockEnd) } : {}),
        routes: [],
        calls: [],
        sql: [],
        statements: [],
        views: [],
      };
      const doc = docBefore(text, mem.start, mem.headerEnd);
      if (doc) m.doc = doc;
      // 라우트
      for (const a of mAnns) {
        if (!(a.name in MAPPING)) continue;
        const paths = a.args ? strValues(annArg(a.args, 'value') ?? annArg(a.args, 'path'), consts) : [];
        let verbs = [MAPPING[a.name]];
        if (a.name === 'RequestMapping') {
          const mexpr = annArg(a.args, 'method');
          const vs = mexpr ? [...mexpr.matchAll(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map((x) => x[1]) : [];
          if (vs.length) verbs = vs;
        }
        const api = classApi || mAnns.some((x) => x.name === 'ResponseBody') || /^\s*(ResponseEntity|HttpEntity)\b/.test(sig.returnType) || /\bResponseEntity</.test(sig.returnType);
        const pfx = prefixes.length ? prefixes : [''];
        for (const pre of pfx) for (const p of paths.length ? paths : ['']) for (const v of verbs) {
          const r: Route = { method: v, path: joinPath(pre, p), line: lineOf(a.start), ...(api ? { api: true } : {}) };
          if (!m.routes.some((x) => x.method === r.method && x.path === r.path)) m.routes.push(r);
        }
      }
      // 스케줄
      const sch = mAnns.find((a) => a.name === 'Scheduled');
      if (sch) {
        const cron = strValues(annArg(sch.args, 'cron'), consts)[0];
        const fd = /fixedDelay(?:String)?\s*=\s*"?([\w${}.]+)"?/.exec(sch.args)?.[1];
        const fr = /fixedRate(?:String)?\s*=\s*"?([\w${}.]+)"?/.exec(sch.args)?.[1];
        m.schedule = cron ?? (fr ? `fixedRate=${fr}` : fd ? `fixedDelay=${fd}` : 'scheduled');
      }
      // SQL 애노테이션 (MyBatis 매퍼 인터페이스)
      for (const a of mAnns) {
        if (!/^(Select|Insert|Update|Delete)$/.test(a.name)) continue;
        const sql = strValues(annArg(a.args, 'value'), consts).join(' ');
        if (!sql.trim()) continue;
        const p = parseSql(sql);
        const s = ctx.addSql({ file: fileId, line: lineOf(a.start), origin: 'annotation', namespace: pkg ? `${pkg}.${decl.name}` : decl.name, stmtId: sig.name, kind: p.kind === 'other' ? (a.name.toLowerCase() as 'select') : p.kind, tables: p.tables, ...(p.dynamic ? { dynamic: true } : {}), text: compactSql(sql) });
        m.sql.push(s.id);
      }
      const q = mAnns.find((a) => a.name === 'Query');
      if (q && /nativeQuery\s*=\s*true/.test(q.args)) {
        const sql = strValues(annArg(q.args, 'value'), consts).join(' ');
        if (sql.trim()) {
          const p = parseSql(sql);
          m.sql.push(ctx.addSql({ file: fileId, line: lineOf(q.start), origin: 'annotation', kind: p.kind, tables: p.tables, text: compactSql(sql) }).id);
        }
      }
      if (mem.blockEnd !== null) analyzeBody(ctx, fileId, code, skel, mem.headerEnd + 1, mem.blockEnd, lineOf, m, fields, consts, ownMethodNames, decl.name, kind === 'controller');
      if (m.views.some((v) => /^(json|jsonView|ajaxJsonView|jsonview|MappingJackson2JsonView|excelView|downloadView|fileDownloadView)$/i.test(v))) {
        m.views = m.views.filter((v) => /\//.test(v) || !/View$/i.test(v));
        for (const r of m.routes) r.api = true;
      }
      methods.push(m);
    }

    const unit = ctx.addUnit({
      file: fileId,
      name: decl.name,
      ...(pkg ? { fqn: `${pkg}.${decl.name}` } : { fqn: decl.name }),
      kind,
      line: lineOf(decl.kwPos),
      ...(beanAnn ? { beanName: strValues(annArg(beanAnn.args, 'value'), consts)[0] || lowerFirst(decl.name) } : {}),
      extendsOrImplements: [...decl.extendsTypes, ...decl.implementsTypes],
      fields,
      methods,
      ...(prefixes.length ? { routePrefix: prefixes } : {}),
    });
    const cdoc = docBefore(text, decl.headerStart, decl.kwPos);
    if (cdoc) unit.doc = cdoc;
    if (kind === 'model') {
      const t = annBy('Table');
      const tn = t ? strValues(annArg(t.args, 'name'), consts)[0] : undefined;
      if (annBy('Entity') || t) unit.table = tn || snake(decl.name);
    }
    if (kind === 'repository' && decl.typeArgsOfExtends[0]) {
      const ent = decl.typeArgsOfExtends[0];
      unit.fields['__entity'] = imports.get(ent) ?? ent;
    }
    const layer = ({ controller: 'CONTROLLER', service: 'SERVICE', dao: 'DAO', repository: 'DAO', mapper: 'MAPPER', model: 'MODEL', job: 'BATCH', other: undefined } as const)[kind];
    const f = ctx.byId.get(fileId);
    if (f && layer && f.layer !== 'TEST') f.layer = layer;
    if (f && kind === 'other' && methods.some((x) => x.schedule) && f.layer !== 'TEST') f.layer = 'BATCH';
  }
}

interface Sig {
  name: string;
  namePos: number;
  returnType: string;
  params: string;
  isCtor: boolean;
}

function methodSig(code: string, skel: string, mem: Member, className: string): Sig | null {
  // 애노테이션을 가린 머리
  let h = skel.slice(mem.start, mem.headerEnd);
  const anns = annotationsIn(code, skel, mem.start, mem.headerEnd);
  for (const a of [...anns].reverse()) h = h.slice(0, a.start - mem.start) + ' '.repeat(a.end - a.start) + h.slice(a.end - mem.start);
  if (/\b(class|interface|enum|record)\s+[A-Za-z_$]/.test(h)) return null;
  // 맨 위 '(' 찾기 (= 앞에 있으면 필드)
  let paren = -1;
  for (let k = 0; k < h.length; k++) {
    const ch = h[k];
    if (ch === '=' && paren < 0) return null;
    if (ch === '(') {
      paren = k;
      break;
    }
  }
  if (paren < 0) return null;
  const before = h.slice(0, paren);
  const nm = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
  if (!nm) return null;
  const name = nm[1];
  if (KEYWORDS.has(name)) return null;
  const close = matchClose(h, paren);
  const after = h.slice(close + 1).trim();
  if (after && !/^throws\b/.test(after) && !/^default\b/.test(after)) return null;
  const ret = before.slice(0, nm.index).replace(MODIFIERS, ' ').replace(/^\s*<[^>]*>\s*/, '').replace(/\s+/g, ' ').trim();
  const isCtor = !ret && name === className;
  if (!ret && !isCtor) return null;
  const absParen = mem.start + paren;
  return { name, namePos: mem.start + nm.index, returnType: ret, params: code.slice(absParen + 1, mem.start + close), isCtor };
}

function analyzeBody(
  ctx: Ctx, fileId: string, code: string, skel: string, from: number, to: number, lineOf: (o: number) => number,
  m: MethodUnit, fields: Record<string, string>, consts: Map<string, string>, own: Set<string>, className: string, collectViews: boolean,
): void {
  const bodySkel = skel.slice(from, to);
  const bodyCode = code.slice(from, to);
  // 지역 변수 타입 (OrderService svc = …)
  const locals: Record<string, string> = {};
  for (const lm of bodySkel.matchAll(/(?:^|[;{}(\s])([A-Z][\w$]*(?:<[^;=()]*>)?)\s+([a-z_$][\w$]*)\s*(?==|;|:)/g)) locals[lm[2]] = lm[1];
  // 호출
  const seen = new Set<string>();
  for (const cm of bodySkel.matchAll(/(?<![\w$.])(this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = cm[2];
    const meth = cm[3];
    const viaField = fields[name] !== undefined;
    const viaLocal = !viaField && locals[name] !== undefined && !JDK_TYPES.has(simpleType(locals[name]));
    const viaType = /^[A-Z]/.test(name) && !JDK_TYPES.has(name) && !/^[A-Z0-9_]+$/.test(name);
    if (!viaField && !viaLocal && !viaType) continue;
    const via = viaLocal ? locals[name] : cm[1] ? `this.${name}` : name;
    const key = `${via}.${meth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    m.calls.push({ via: viaLocal ? simpleType(locals[name]) : via, method: meth, line: lineOf(from + (cm.index ?? 0)) });
  }
  // 같은 클래스 메서드 호출
  for (const cm of bodySkel.matchAll(/(?<![\w$.])([a-z_$][\w$]*)\s*\(/g)) {
    const name = cm[1];
    if (!own.has(name) || name === m.name || KEYWORDS.has(name)) continue;
    const key = `this.${className}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    m.calls.push({ via: `this.${className}`, method: name, line: lineOf(from + (cm.index ?? 0)) });
  }
  // statement 호출 (DAO): 첫 인자가 문자열·상수
  for (const sm of bodyCode.matchAll(STMT_METHODS)) {
    const v = constExpr(sm[2].trim(), consts);
    if (v && /^[\w$][\w$.-]*$/.test(v) && !m.statements.includes(v)) m.statements.push(v);
  }
  // 뷰 이름
  const addView = (v: string) => {
    if (/^(redirect|forward):/.test(v)) {
      const url = v.replace(/^(redirect|forward):/, '');
      (m.redirects ??= []).push(url);
    } else if (collectViews && v && !m.views.includes(v)) m.views.push(v);
  };
  for (const vm of bodyCode.matchAll(/\breturn\s+([^;]+);/g)) {
    const expr = vm[1].trim();
    const s = /^"[^"]*"$/.test(expr) || /^[A-Z_][A-Z0-9_]*$/.test(expr) || /^"[^"]*"\s*\+/.test(expr) ? constExpr(expr, consts) : undefined;
    if (s !== undefined) addView(s);
  }
  for (const vm of bodyCode.matchAll(/new\s+ModelAndView\s*\(\s*([^,)]+)/g)) {
    const s = constExpr(vm[1].trim(), consts);
    if (s !== undefined) addView(s);
  }
  for (const vm of bodyCode.matchAll(/\.setViewName\s*\(\s*([^)]+)\)/g)) {
    const s = constExpr(vm[1].trim(), consts);
    if (s !== undefined) addView(s);
  }
  // 문자열 SQL: 문장 단위로 리터럴을 이어 붙이고, append 연속은 합침
  const chunks: { start: number; end: number }[] = [];
  let depth = 0;
  let s0 = 0;
  for (let i = 0; i < bodySkel.length; i++) {
    const ch = bodySkel[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ';' || ch === '{' || ch === '}') && depth <= 0) {
      chunks.push({ start: s0, end: i });
      s0 = i + 1;
    }
  }
  chunks.push({ start: s0, end: bodySkel.length });
  let pending: { v: string; text: string; pos: number } | null = null;
  const flush = (p: { text: string; pos: number } | null) => {
    if (!p || !isSqlLike(p.text)) return;
    const parsed = parseSql(p.text);
    if (!parsed.tables.length && parsed.kind !== 'call') return;
    const s = ctx.addSql({ file: fileId, line: lineOf(from + p.pos), origin: 'string', kind: parsed.kind, tables: parsed.tables, ...(parsed.dynamic ? { dynamic: true } : {}), text: compactSql(p.text) });
    m.sql.push(s.id);
  };
  for (const c of chunks) {
    const lits = stringLiterals(bodyCode, c.start, c.end);
    const seg = bodySkel.slice(c.start, c.end);
    const ap = /([A-Za-z_$][\w$]*)\s*\.\s*append\s*\(/.exec(seg);
    const sbNew = /([A-Za-z_$][\w$]*)\s*=\s*new\s+(StringBuilder|StringBuffer)\s*\(/.exec(seg);
    if (!lits.length) {
      if (!ap) {
        flush(pending);
        pending = null;
      }
      continue;
    }
    const joined = lits.map((l) => l.value).join(' ');
    const v = ap?.[1] ?? sbNew?.[1];
    if (v) {
      if (pending && pending.v === v) pending.text += ` ${joined}`;
      else {
        flush(pending);
        pending = { v, text: joined, pos: lits[0].start };
      }
      continue;
    }
    flush(pending);
    pending = null;
    if (/[+=]/.test(seg) && /\+=/.test(seg)) {
      // sql += "…" 연속
      const vv = /([A-Za-z_$][\w$]*)\s*\+=/.exec(seg)?.[1] ?? '';
      pending = { v: `${vv}+=`, text: joined, pos: lits[0].start };
      continue;
    }
    flush({ text: joined, pos: lits[0].start });
  }
  flush(pending);
}

// ------------------------------------------------------------------ JPA 저장소: 상속 메서드와 이름 규칙

const JPA_BASE: [string, 'R' | 'C' | 'U' | 'D'][] = [
  ['findAll', 'R'], ['findById', 'R'], ['findAllById', 'R'], ['getById', 'R'], ['getReferenceById', 'R'], ['getOne', 'R'], ['existsById', 'R'],
  ['count', 'R'], ['findOne', 'R'], ['save', 'C'], ['saveAll', 'C'], ['saveAndFlush', 'C'], ['insert', 'C'], ['delete', 'D'], ['deleteById', 'D'],
  ['deleteAll', 'D'], ['deleteAllById', 'D'], ['deleteInBatch', 'D'], ['deleteAllInBatch', 'D'],
];

function crudByName(name: string): 'C' | 'R' | 'U' | 'D' {
  if (/^(save|insert|create|persist|add)/.test(name)) return 'C';
  if (/^(update|modify|merge)/.test(name)) return 'U';
  if (/^(delete|remove)/.test(name)) return 'D';
  return 'R';
}

function addViewControllers(ctx: Ctx, file: string, vcs: { path: string; view: string; line: number }[]): void {
  if (!vcs.length) return;
  ctx.addUnit({
    file,
    name: 'ViewController',
    kind: 'controller',
    line: vcs[0].line,
    extendsOrImplements: [],
    fields: {},
    methods: vcs.map((v) => ({
      name: `view:${v.path}`,
      line: v.line,
      routes: [{ method: 'GET', path: v.path, line: v.line }],
      calls: [],
      sql: [],
      statements: [],
      views: [v.view],
    })),
  });
}

function finishJpa(ctx: Ctx): void {
  const entities = new Map<string, string>();
  for (const u of ctx.facts.units) if (u.kind === 'model' && u.table) entities.set(u.name, u.table);
  // JPQL(FROM Owner o)의 엔티티 이름을 실제 테이블 이름으로
  if (entities.size) {
    const ddl = new Set(ctx.facts.ddl.map((t) => t.name.toUpperCase()));
    for (const s of ctx.facts.sql) {
      if (s.origin !== 'string' && s.origin !== 'annotation') continue;
      for (const t of s.tables) {
        const tb = entities.get(t.name);
        if (tb && !ddl.has(t.name.toUpperCase())) t.name = tb;
      }
    }
  }
  for (const u of ctx.facts.units) {
    if (u.kind !== 'repository') continue;
    const ent = u.fields['__entity'];
    delete u.fields['__entity'];
    if (!ent) continue;
    const table = entities.get(ent.split('.').pop()!) ?? snake(ent.split('.').pop()!);
    u.table = table;
    const add = (m: MethodUnit, crud: 'C' | 'R' | 'U' | 'D') => {
      const kind = crud === 'C' ? 'insert' : crud === 'U' ? 'update' : crud === 'D' ? 'delete' : 'select';
      const s = ctx.addSql({ file: u.file, line: m.line, origin: 'orm', kind, tables: [{ name: table, crud }], text: `${u.name}.${m.name}() → ${table}` });
      m.sql.push(s.id);
    };
    for (const m of u.methods) if (!m.sql.length) add(m, crudByName(m.name));
    for (const [name, crud] of JPA_BASE) {
      if (u.methods.some((m) => m.name === name)) continue;
      const m: MethodUnit = { name, line: u.line, routes: [], calls: [], sql: [], statements: [], views: [] };
      add(m, crud);
      if (crud === 'C') {
        // save는 수정도 함
        const s = ctx.facts.sql[ctx.facts.sql.length - 1];
        s.tables.push({ name: table, crud: 'U' });
      }
      u.methods.push(m);
    }
  }
}
