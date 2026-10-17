// 메뉴 찾기: 메뉴 데이터 SQL(INSERT) → 메뉴 설정 파일(xml·json) → 사이드바·LNB 화면 코드
// (DB 메뉴 테이블 직접 읽기는 3단계. URL 추정은 link.ts가 메뉴가 하나도 없을 때 만든다)
import type { Analyzer, Ctx } from '../context';
import type { DdlTable, FileInfo, MenuFact } from '../types';
import { baseName, makeLineIndex } from '../files';
import { parseInsert } from '../ddl';
import { splitStatements } from '../sql';
import { cleanUrl, stripMarkupComments } from './jutil';

interface State {
  sqlFiles: string[];
}
const states = new WeakMap<Ctx, State>();
function st(ctx: Ctx): State {
  let s = states.get(ctx);
  if (!s) {
    s = { sqlFiles: [] };
    states.set(ctx, s);
  }
  return s;
}

type Role = 'id' | 'parent' | 'name' | 'url' | 'order';

/** 컬럼 이름으로 역할 추측 */
export function guessColumns(cols: string[]): Partial<Record<Role, number>> {
  const up = cols.map((c) => c.toUpperCase());
  const find = (re: RegExp, except: number[] = []) => up.findIndex((c, i) => re.test(c) && !except.includes(i));
  const out: Partial<Record<Role, number>> = {};
  const parent = find(/^(UPPER|UP|UPR|PARENT|PRNT|PRENT|HIGH|HIGHER|HGH|SUPER|TOP|P|PAR)_?(MENU_?)?(ID|NO|SN|CD|SEQ|CODE|KEY)$|^(PARENT|UPPER)_?(MENU)?$|^PID$|^PARENTID$|^UPPERMENUID$/);
  if (parent >= 0) out.parent = parent;
  const id = find(/^(MENU_?(ID|NO|SN|CD|SEQ|CODE|KEY|IDX))$|^(ID|IDX|MENUID|MENUNO)$/, [parent]);
  if (id >= 0) out.id = id;
  let name = find(/^(MENU_?(NM|NAME|TITLE|LABEL|NM_KO|NM_KOR|NAME_KO|KOR_NM))$|^(NM|NAME|TITLE|LABEL)$/);
  if (name < 0) name = find(/(_NM|NAME|_TITLE)$/, [id, parent]);
  if (name >= 0) out.name = name;
  const url = find(/(URL|LINK|PATH|HREF|PROGRM_FILE_NM|PGM_URL|PAGE)$/);
  if (url >= 0) out.url = url;
  const order = find(/(ORDR|ORDER|SORT|SORT_?NO|SEQ|ORD|DSPLY_?ORDR|OUTPT_?ORDR)$/, [id, parent]);
  if (order >= 0) out.order = order;
  return out;
}

function menuFromSqlFiles(ctx: Ctx): MenuFact[] {
  const out: MenuFact[] = [];
  const ddl = new Map<string, DdlTable>(ctx.facts.ddl.map((t) => [t.name.toUpperCase(), t] as const));
  // eGov: COMTNPROGRMLIST(PROGRM_FILE_NM → URL)
  const progUrl = new Map<string, string>();
  const rowsByTable = new Map<string, { file: FileInfo; line: number; cols: string[]; row: string[] }[]>();
  for (const id of st(ctx).sqlFiles) {
    const f = ctx.byId.get(id);
    const text = ctx.facts.texts.get(id);
    if (!f || !text) continue;
    const lineOf = makeLineIndex(text);
    for (const { sql, offset } of splitStatements(text)) {
      if (!/^\s*INSERT\b/i.test(sql.replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)+/, ''))) continue;
      const ins = parseInsert(sql);
      if (!ins) continue;
      const T = ins.table.toUpperCase();
      if (!/MENU|PROGRM|PROGRAM/.test(T)) continue;
      const cols = ins.columns.length ? ins.columns : ddl.get(T)?.columns.map((c) => c.name) ?? [];
      if (!cols.length) continue;
      for (const row of ins.rows) {
        if (!rowsByTable.has(T)) rowsByTable.set(T, []);
        rowsByTable.get(T)!.push({ file: f, line: lineOf(offset), cols, row });
      }
    }
  }
  for (const [T, rows] of rowsByTable) {
    if (!/PROGRM|PROGRAM/.test(T) || /MENU/.test(T)) continue;
    for (const r of rows) {
      const up = r.cols.map((c) => c.toUpperCase());
      const k = up.indexOf('PROGRM_FILE_NM');
      const u = up.indexOf('URL');
      if (k >= 0 && u >= 0 && r.row[k]) progUrl.set(r.row[k], r.row[u]);
    }
  }
  for (const [T, rows] of rowsByTable) {
    if (!/MENU/.test(T)) continue;
    // 메뉴 생성 내역(권한별 매핑) 같은 표는 제외: 이름 열이 없으면 메뉴 표가 아님
    const roles = guessColumns(rows[0].cols);
    if (roles.name === undefined || roles.id === undefined) continue;
    for (const r of rows) {
      const get = (role: Role) => (roles[role] !== undefined ? r.row[roles[role]!] : undefined);
      const id = get('id');
      const name = get('name');
      if (!id || !name) continue;
      let url = get('url');
      if (url && progUrl.has(url)) url = progUrl.get(url);
      if (url && (url === 'dir' || url === '-' || /^(null|none)$/i.test(url))) url = undefined;
      const parent = get('parent');
      const order = Number(get('order'));
      out.push({
        key: `${T}:${id}`,
        ...(parent && parent !== id && parent !== '0' && parent !== '-1' ? { parentKey: `${T}:${parent}` } : {}),
        name,
        ...(url ? { url: cleanUrl(url) ?? url } : {}),
        ...(Number.isFinite(order) && get('order') !== undefined && get('order') !== '' ? { order } : {}),
        source: 'data-file',
        evidence: { file: r.file.id, line: r.line },
      });
    }
  }
  // 루트(0번) 메뉴: eGov는 MENU_NO=0 '최상위' 노드가 있어 그 아래가 1단계 → 이름이 '루트'류면 뺌
  return out.filter((m) => !/^(root|루트|최상위|top|menu)$/i.test(m.name) || out.every((x) => x.parentKey !== m.key));
}

// ------------------------------------------------------------------ 설정 파일 (menu*.xml, menu*.json)

interface Node {
  name?: string;
  url?: string;
  children: Node[];
  line: number;
}

function menuFromJson(text: string): Node[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const nameKeys = ['name', 'title', 'label', 'text', 'menuNm', 'menuName', 'menu_nm', 'menuNmKo', 'nm'];
  const urlKeys = ['url', 'link', 'path', 'href', 'menuUrl', 'menu_url', 'to', 'route'];
  const childKeys = ['children', 'child', 'sub', 'subMenu', 'submenu', 'subMenus', 'items', 'menus', 'nodes'];
  const walk = (v: unknown): Node[] => {
    if (Array.isArray(v)) return v.flatMap(walk);
    if (!v || typeof v !== 'object') return [];
    const o = v as Record<string, unknown>;
    const name = nameKeys.map((k) => o[k]).find((x) => typeof x === 'string') as string | undefined;
    const url = urlKeys.map((k) => o[k]).find((x) => typeof x === 'string') as string | undefined;
    const kids = childKeys.map((k) => o[k]).find((x) => Array.isArray(x) || (x && typeof x === 'object'));
    if (!name) {
      // 감싼 객체 { menus: [...] }
      return kids ? walk(kids) : Object.values(o).flatMap((x) => (Array.isArray(x) ? walk(x) : []));
    }
    return [{ name, url, children: kids ? walk(kids) : [], line: 1 }];
  };
  return walk(data);
}

function menuFromXml(text: string): Node[] {
  const src = text.replace(/<!--[\s\S]*?-->/g, ' ');
  const lineOf = makeLineIndex(src);
  const root: Node = { children: [], line: 1 };
  const stack: Node[] = [root];
  const re = /<(\/)?([A-Za-z][\w:-]*)\b([^>]*?)(\/)?>/g;
  let m: RegExpExecArray | null;
  const attr = (a: string, names: string[]) => {
    for (const n of names) {
      const x = new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(a);
      if (x) return x[2] ?? x[3];
    }
    return undefined;
  };
  while ((m = re.exec(src))) {
    const [, close, tag, attrs, self] = m;
    if (close) {
      if (stack.length > 1 && /menu|item|node|li/i.test(tag)) stack.pop();
      continue;
    }
    if (!/menu|item|node/i.test(tag)) continue;
    const name = attr(attrs, ['name', 'title', 'label', 'text', 'menuNm', 'menu_nm', 'nm']);
    const url = attr(attrs, ['url', 'link', 'path', 'href', 'menuUrl', 'action']);
    let node: Node = { name, url, children: [], line: lineOf(m.index) };
    if (!name) {
      // <menu><name>…</name><url>…</url> 형태
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
      const n2 = /^\s*<(name|title|label)>([^<]*)<\/\1>/i.exec(tail) ?? /<(name|title|label)>([^<]*)<\/\1>/i.exec(tail.split(/<(?:menu|item|node)\b/i)[0]);
      const u2 = /<(url|link|path|href)>([^<]*)<\/\1>/i.exec(tail.split(/<(?:menu|item|node)\b/i)[0]);
      node = { name: n2?.[2]?.trim(), url: u2?.[2]?.trim(), children: [], line: lineOf(m.index) };
    }
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  // 이름 없는 감싸기 노드는 펼침
  const flat = (ns: Node[]): Node[] => ns.flatMap((n) => (n.name ? [{ ...n, children: flat(n.children) }] : flat(n.children)));
  return flat(root.children);
}

// ------------------------------------------------------------------ 화면 코드 (ul/li/a 중첩)

function menuFromMarkup(text: string): Node[] {
  const src = stripMarkupComments(text)
    .replace(/<(c|spring):url\s+value\s*=\s*["']([^"']*)["']\s*\/>/gi, (_, __, v) => v);
  const lineOf = makeLineIndex(src);
  const root: Node = { children: [], line: 1 };
  const stack: { node: Node; tag: string; gotLabel: boolean }[] = [{ node: root, tag: 'root', gotLabel: true }];
  const re = /<(\/)?(ul|ol|li|a)\b([^>]*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  let inAnchor: { node: Node; href?: string; text: string } | null = null;
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) {
      const t = m[4].replace(/\$\{[^}]*\}|<%[\s\S]*?%>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (inAnchor) inAnchor.text += ` ${t}`;
      else {
        const top = stack[stack.length - 1];
        if (top.tag === 'li' && !top.gotLabel) {
          top.node.name = t;
          top.gotLabel = true;
        }
      }
      continue;
    }
    const close = !!m[1];
    const tag = m[2].toLowerCase();
    if (tag === 'a') {
      if (!close) {
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[3]);
        const onclick = /\bonclick\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[3]);
        let raw = href ? href[2] ?? href[3] : undefined;
        if (raw && /^(#|javascript)/i.test(raw) && onclick) {
          const s = /['"](\/[^'"]+|[^'"]+\.(?:do|action|php))['"]/.exec(onclick[2] ?? onclick[3] ?? '');
          raw = s?.[1];
        }
        const top = stack[stack.length - 1];
        inAnchor = { node: top.node, href: raw, text: '' };
      } else if (inAnchor) {
        const top = stack[stack.length - 1];
        const label = inAnchor.text.trim();
        if (top.tag === 'li') {
          if (!top.gotLabel && label) {
            top.node.name = label;
            top.gotLabel = true;
          }
          if (!top.node.url && inAnchor.href) top.node.url = cleanUrl(inAnchor.href) ?? undefined;
        }
        inAnchor = null;
      }
      continue;
    }
    if (tag === 'li') {
      if (!close) {
        const node: Node = { children: [], line: lineOf(m.index) };
        // 가장 가까운 li 의 자식으로 (없으면 루트)
        const parentLi = [...stack].reverse().find((x) => x.tag === 'li' || x.tag === 'root')!;
        parentLi.node.children.push(node);
        stack.push({ node, tag: 'li', gotLabel: false });
      } else {
        while (stack.length > 1 && stack[stack.length - 1].tag !== 'li') stack.pop();
        if (stack.length > 1) stack.pop();
      }
      continue;
    }
    // ul/ol: 열면 li 라벨 확정
    if (!close) {
      const top = stack[stack.length - 1];
      if (top.tag === 'li') top.gotLabel = true;
      stack.push({ node: top.node, tag, gotLabel: true });
    } else {
      while (stack.length > 1 && stack[stack.length - 1].tag !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
    }
  }
  const clean = (ns: Node[]): Node[] => ns.filter((n) => n.name || n.children.length).map((n) => ({ ...n, children: clean(n.children) }));
  return clean(root.children);
}

function toFacts(nodes: Node[], f: FileInfo, source: MenuFact['source'], prefix: string): MenuFact[] {
  const out: MenuFact[] = [];
  const walk = (ns: Node[], parent: string | undefined, path: string) => {
    ns.forEach((n, i) => {
      const key = `${prefix}${path}${i + 1}`;
      if (n.name) {
        out.push({
          key,
          ...(parent ? { parentKey: parent } : {}),
          name: n.name.slice(0, 80),
          ...(n.url ? { url: cleanUrl(n.url) ?? n.url } : {}),
          order: i + 1,
          source,
          evidence: { file: f.id, line: n.line },
        });
      }
      walk(n.children, n.name ? key : parent, `${path}${i + 1}.`);
    });
  };
  walk(nodes, undefined, '');
  return out;
}

const MENU_FILE = /(^|[_\-./])(menu|menus|lnb|gnb|snb|sidebar|side|leftmenu|left|nav|navi|navbar|navigation|topmenu|aside)([_\-.]|$)/i;

export const menuAnalyzer: Analyzer = {
  name: 'menu',
  order: 60,
  accepts(f, text) {
    if (f.layer === 'TEST') return false;
    if (f.lang === 'SQL') return /INSERT\s+INTO\s+[\w."`]*(MENU|PROGRM)/i.test(text);
    const name = baseName(f.path).toLowerCase();
    if ((f.lang === 'XML' || f.lang === 'JSON') && /menu/.test(name)) return true;
    if ((f.lang === 'JSP' || f.lang === 'HTML' || f.lang === 'Template' || (f.lang === 'PHP' && f.layer === 'VIEW')) && MENU_FILE.test(name.replace(/\.(jsp|jspf|html?|php|tpl|blade\.php)$/, ''))) return /<li\b/i.test(text) && /<a\b/i.test(text);
    return false;
  },
  analyze(f, text, ctx) {
    if (f.lang === 'SQL') {
      st(ctx).sqlFiles.push(f.id);
      return;
    }
    if (f.lang === 'JSON') {
      ctx.facts.menus.push(...toFacts(menuFromJson(text), f, 'config', `${f.id}:`));
      f.layer = 'MENU_DATA';
      return;
    }
    if (f.lang === 'XML') {
      const facts = toFacts(menuFromXml(text), f, 'config', `${f.id}:`);
      if (facts.length >= 2) {
        ctx.facts.menus.push(...facts);
        f.layer = 'MENU_DATA';
      }
      return;
    }
    const facts = toFacts(menuFromMarkup(text), f, 'code', `${f.id}:`);
    if (facts.filter((x) => x.url).length >= 2) ctx.facts.menus.push(...facts);
  },
  finish(ctx) {
    const fromSql = menuFromSqlFiles(ctx);
    ctx.facts.menus.push(...fromSql);
    for (const id of new Set(fromSql.map((m) => m.evidence.file))) {
      const f = ctx.byId.get(id);
      if (f && f.layer !== 'DDL') f.layer = 'MENU_DATA';
    }
  },
};
