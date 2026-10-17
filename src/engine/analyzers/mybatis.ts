// MyBatis 매퍼 XML(<mapper namespace>)과 iBatis sqlMap(<sqlMap namespace>)
// 문장을 모아 두었다가 finish()에서 <include refid>를 파일을 넘나들며 풀고 SQL 사실로 남긴다.
import type { Analyzer, Ctx } from '../context';
import type { SqlFact } from '../types';
import { makeLineIndex } from '../files';
import { compactSql, parseSql } from '../sql';
import { blank } from './jutil';

interface RawStmt {
  file: string;
  line: number;
  tag: string;
  id: string;
  namespace?: string;
  body: string;
  ibatis: boolean;
}

interface State {
  stmts: RawStmt[];
  /** 'ns.id' 와 'id' (소문자) → 조각 본문 */
  fragments: Map<string, { ns?: string; body: string }[]>;
}

const states = new WeakMap<Ctx, State>();
function state(ctx: Ctx): State {
  let s = states.get(ctx);
  if (!s) {
    s = { stmts: [], fragments: new Map() };
    states.set(ctx, s);
  }
  return s;
}

const MYBATIS_DYN = ['if', 'choose', 'when', 'otherwise', 'foreach', 'where', 'set', 'trim', 'bind'];
const IBATIS_DYN = [
  'dynamic', 'isNotEmpty', 'isEmpty', 'isNotNull', 'isNull', 'isEqual', 'isNotEqual', 'isGreaterThan', 'isGreaterEqual',
  'isLessThan', 'isLessEqual', 'isPropertyAvailable', 'isNotPropertyAvailable', 'isParameterPresent', 'isNotParameterPresent', 'iterate',
];
const DYN_RE = new RegExp(`<\\/?(${[...MYBATIS_DYN, ...IBATIS_DYN].join('|')})\\b[^>]*>`, 'g');

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? m[2] ?? m[3] : undefined;
}

export function isMapperXml(text: string): boolean {
  return /<mapper\b[^>]*\bnamespace\s*=/.test(text) || /<sqlMap\b/.test(text) || /mybatis\.org\/dtd\/mybatis-3-mapper|ibatis\.apache\.org\/dtd\/sql-map-2/.test(text);
}

/** 동적 태그를 걷어 내고 prefix·prepend 같은 앞말은 살린다 */
function flatten(body: string): { text: string; dynamic: boolean } {
  let dynamic = false;
  let text = body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => ` ${c} `);
  text = text.replace(DYN_RE, (tag) => {
    dynamic = true;
    if (tag.startsWith('</')) return ' ';
    const name = /^<(\w+)/.exec(tag)?.[1] ?? '';
    if (name === 'bind') return ' ';
    if (name === 'where') return ' WHERE ';
    if (name === 'set') return ' SET ';
    const pre = attr(tag, 'prefix') ?? attr(tag, 'prepend') ?? '';
    const open = attr(tag, 'open') ?? '';
    return ` ${pre} ${open} `;
  });
  // foreach close · trim suffix 는 결과에 영향이 거의 없어 버린다. 남은 태그는 공백으로
  text = text.replace(/<\/?[A-Za-z][\w:-]*\b[^>]*>/g, ' ');
  return { text, dynamic };
}

export const mybatisAnalyzer: Analyzer = {
  name: 'mybatis',
  order: 10,
  accepts: (f, text) => f.lang === 'XML' && f.layer !== 'TEST' && isMapperXml(text),
  analyze(f, text, ctx) {
    const st = state(ctx);
    const src = text.replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
    const ibatis = /<sqlMap\b/.test(src);
    const root = (ibatis ? /<sqlMap\b([^>]*)>/ : /<mapper\b([^>]*)>/).exec(src);
    const namespace = root ? attr(root[1], 'namespace') : undefined;
    const lineOf = makeLineIndex(src);
    const re = /<(select|insert|update|delete|statement|procedure|sql)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(src))) {
      const tag = m[1];
      const id = attr(m[2], 'id');
      if (!id) continue;
      const body = m[4] ?? '';
      if (tag === 'sql') {
        const keys = [id.toLowerCase(), ...(namespace ? [`${namespace}.${id}`.toLowerCase()] : [])];
        for (const k of keys) {
          const list = st.fragments.get(k) ?? [];
          list.push({ ns: namespace, body });
          st.fragments.set(k, list);
        }
        continue;
      }
      st.stmts.push({ file: f.id, line: lineOf(m.index), tag, id, namespace, body, ibatis });
      count++;
    }
    f.layer = 'MAPPER';
    if (count) ctx.hit('데이터 접근', ibatis ? 'iBatis' : 'MyBatis', f.id, root ? lineOf(root.index) : 1, 0.5);
  },
  finish(ctx) {
    const st = state(ctx);
    const resolveIncludes = (body: string, ns: string | undefined, depth: number): string => {
      if (depth > 6) return body;
      return body.replace(/<include\s+refid\s*=\s*["']([^"']+)["'][^>]*?(\/>|>[\s\S]*?<\/include>)/g, (_, ref: string) => {
        const key = ref.toLowerCase();
        const cands = st.fragments.get(ns && !ref.includes('.') ? `${ns}.${ref}`.toLowerCase() : key) ?? st.fragments.get(key) ?? [];
        const frag = cands.find((c) => c.ns === ns) ?? cands[0];
        return frag ? ` ${resolveIncludes(frag.body, frag.ns ?? ns, depth + 1)} ` : ' ';
      });
    };
    for (const s of st.stmts) {
      // selectKey 는 따로: 키 생성 SELECT의 테이블은 조회로만
      const keyParts: string[] = [];
      let body = s.body.replace(/<selectKey\b[^>]*>([\s\S]*?)<\/selectKey>/g, (_, inner) => {
        keyParts.push(inner);
        return ' ';
      });
      body = resolveIncludes(body, s.namespace, 0);
      const flat = flatten(body);
      const p = parseSql(flat.text);
      const tagKind: SqlFact['kind'] =
        s.tag === 'select' ? 'select' : s.tag === 'insert' ? 'insert' : s.tag === 'update' ? 'update' : s.tag === 'delete' ? 'delete' : s.tag === 'procedure' ? 'call' : 'other';
      let kind: SqlFact['kind'] = p.kind !== 'other' ? p.kind : tagKind;
      if (/^\s*\{?\s*call\b/i.test(flat.text) || /^\s*BEGIN\b/i.test(flat.text)) kind = 'call';
      const tables = [...p.tables];
      for (const k of keyParts) {
        for (const t of parseSql(flatten(k).text).tables) {
          if (!tables.some((x) => x.name.toUpperCase() === t.name.toUpperCase() && x.crud === 'R')) tables.push({ ...t, crud: 'R' });
        }
      }
      const dynamicName = p.dynamic || (!tables.length && /\$\{|\$[A-Za-z_][\w.]*\$/.test(flat.text) && kind !== 'call');
      ctx.addSql({
        file: s.file,
        line: s.line,
        origin: s.ibatis ? 'ibatis' : 'mybatis',
        ...(s.namespace ? { namespace: s.namespace } : {}),
        stmtId: s.id,
        kind,
        tables: dynamicName ? tables.map((t) => ({ ...t, estimated: true })) : tables,
        ...(dynamicName ? { dynamic: true } : {}),
        ...(flat.dynamic ? { dynamicTags: true } : {}),
        text: compactSql(flat.text),
      });
    }
  },
};
