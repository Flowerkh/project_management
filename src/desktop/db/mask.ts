// 개인정보 가림 (순수 함수, DB 없이 시험)
//  - 가림 대상 패턴: '*_TEL' (컬럼 이름), '*_NM:이름·성명' (컬럼 이름 + 주석에 이름·성명 중 하나)
//  - 결과 열 이름이 아니라 원본 컬럼 기준: 별칭·함수·*·서브쿼리·WITH·UNION을 따라 원본 테이블의 컬럼을 찾는다 (sql.ts의 selectShape)
//  - 값이 전화번호·이메일·주민등록번호·카드번호 모양이면 컬럼 이름과 상관없이 가린다
// 원본을 알 수 없으면(테이블 정보를 못 읽음) 가리는 쪽으로 판단한다.
import { nameKey, type QueryShape, type SelItem, type Src } from './sql';

export const MASK = '****';

export interface MaskRule {
  raw: string;
  re: RegExp;
  /** 주석 조건 (비면 이름만 봄) */
  words: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMaskPatterns(patterns: string[]): MaskRule[] {
  const out: MaskRule[] = [];
  for (const raw of patterns) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const at = s.indexOf(':');
    const glob = (at < 0 ? s : s.slice(0, at)).trim();
    if (!glob) continue;
    const words = at < 0 ? [] : s.slice(at + 1).split(/[·,|/、\s]+/).map((w) => w.trim()).filter(Boolean);
    const re = new RegExp(`^${glob.split('*').map((p) => escapeRe(p)).join('.*')}$`, 'i');
    out.push({ raw: s, re, words });
  }
  return out;
}

/** comment: null 주석 없음, undefined 알 수 없음(→ 주석 조건이 있어도 가림) */
export function ruleMatches(r: MaskRule, column: string, comment: string | null | undefined): boolean {
  if (!r.re.test(column)) return false;
  if (!r.words.length) return true;
  if (comment === undefined) return true;
  const c = comment ?? '';
  return r.words.some((w) => c.includes(w));
}

export function columnMasked(rules: MaskRule[], column: string, comment: string | null | undefined): boolean {
  return rules.some((r) => ruleMatches(r, column, comment));
}

// ------------------------------------------------------------------ 값 모양

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_IN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** 휴대전화: 010-1234-5678, 01012345678, +82 10-1234-5678 */
const MOBILE = /^(?:\+?82[- .]?1|01)[016789][- .]?\d{3,4}[- .]?\d{4}$/;
/** 일반 전화: 구분자가 있어야 (02-123-4567, (031) 123-4567) */
const LANDLINE = /^(?:0(?:2|[3-6][1-5]|70|50\d?)[- .)]\s?|\(0\d{1,2}\)\s?)\d{3,4}[- .]\d{4}$/;
const PHONE_IN = /(?<![\d-])(?:\+?82[- .]?1[016789]|01[016789]|0(?:2|[3-6][1-5]|70))[- .]\d{3,4}[- .]\d{4}(?![\d-])/g;
/** 주민등록번호·외국인등록번호: 생년월일 + 성별 숫자 */
const RRN = /^\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-8]\d{6}$/;
const RRN_IN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-8]\d{6}(?!\d)/g;
/** 카드번호: 13~19자리 (4자리씩 구분하거나 붙여 씀) + Luhn */
const CARD = /^(?:\d{4}([- ])\d{4}\1\d{4}\1\d{1,7}|\d{4}([- ])\d{6}\2\d{5}|\d{13,19})$/;
const CARD_IN = /(?<![\d-])(?:\d{4}([- ])\d{4}\1\d{4}\1\d{1,4}|\d{4}-\d{6}-\d{5})(?![\d-])/g;

export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function isCard(s: string): boolean {
  if (!CARD.test(s)) return false;
  const digits = s.replace(/[- ]/g, '');
  return luhn(digits);
}

/** 값 전체가 개인정보 모양인지 */
export function looksPersonal(s: string): boolean {
  const v = s.trim();
  if (v.length < 5 || v.length > 254) return false;
  if (EMAIL.test(v)) return true;
  if (v.length < 9) return false;
  return MOBILE.test(v) || LANDLINE.test(v) || RRN.test(v) || isCard(v);
}

/** 값 모양으로 가린 결과. 바뀌지 않았으면 null */
export function maskByShape(v: string): string | null {
  if (looksPersonal(v)) return MASK;
  if (v.length < 6) return null;
  let out = v.replace(EMAIL_IN, MASK).replace(RRN_IN, MASK).replace(PHONE_IN, MASK);
  out = out.replace(CARD_IN, (m) => (luhn(m.replace(/[- ]/g, '')) ? MASK : m));
  return out === v ? null : out;
}

// ------------------------------------------------------------------ 결과 열 → 원본 컬럼

export interface ColumnInfo {
  name: string;
  comment?: string | null;
}

export interface TableInfo {
  schema?: string;
  name: string;
  columns: ColumnInfo[];
}

/** 테이블 정보 (못 읽었으면 null) */
export type MetaLookup = (t: { schema?: string; name: string }) => TableInfo | null;

export interface SrcCol {
  table: string;
  column: string;
  comment?: string | null;
  /** 테이블 정보를 읽어 주석을 앎 */
  known: boolean;
}

export interface OutCol {
  name: string;
  sources: SrcCol[];
  /** 테이블 정보를 몰라 몇 열로 펼쳐질지 모르는 * */
  placeholder?: { table: string };
}

interface Entry {
  kind: 'table' | 'derived' | 'opaque';
  alias?: string;
  table?: string;
  meta?: TableInfo | null;
  cols?: OutCol[];
}

interface Ctx {
  lookup: MetaLookup;
  ctes: Map<string, { shape: QueryShape; cols?: string[] }>;
  resolving: Set<string>;
  depth: number;
}

function findCol(meta: TableInfo, name: string): ColumnInfo | undefined {
  const k = nameKey(name);
  return meta.columns.find((c) => nameKey(c.name) === k);
}

function entryName(en: Entry): string {
  return en.table ?? en.alias ?? '?';
}

export function resolveShape(shape: QueryShape, lookup: MetaLookup): OutCol[] {
  return resolveQuery(shape, { lookup, ctes: new Map(), resolving: new Set(), depth: 0 }, []);
}

function resolveQuery(q: QueryShape, ctx: Ctx, outer: Entry[][]): OutCol[] {
  if (ctx.depth > 16) return [];
  const inner: Ctx = { ...ctx, ctes: new Map([...ctx.ctes, ...q.ctes]), depth: ctx.depth + 1 };
  let result: OutCol[] | null = null;
  for (const b of q.branches) {
    const cols = resolveBranch(b.items, b.from, inner, outer);
    if (!result) result = cols.map((c) => ({ ...c, sources: [...c.sources] }));
    else {
      for (let i = 0; i < Math.max(result.length, cols.length); i++) {
        if (!result[i]) result[i] = { ...cols[i], sources: [...cols[i].sources] };
        else if (cols[i]) {
          result[i].sources.push(...cols[i].sources);
          if (cols[i].placeholder && !result[i].placeholder) result[i].placeholder = cols[i].placeholder;
        }
      }
    }
  }
  return result ?? [];
}

function scopeOf(from: Src[], ctx: Ctx): Entry[] {
  return from.map((src): Entry => {
    if (src.kind === 'table') {
      const nk = nameKey(src.name);
      const cte = !src.schema ? ctx.ctes.get(nk) : undefined;
      if (cte) {
        if (ctx.resolving.has(nk)) return { kind: 'opaque', alias: src.alias ?? nk, table: nk };
        ctx.resolving.add(nk);
        let cols = resolveQuery(cte.shape, ctx, []);
        ctx.resolving.delete(nk);
        if (cte.cols) cols = cols.map((c, i) => ({ ...c, name: cte.cols?.[i] ?? c.name }));
        return { kind: 'derived', alias: src.alias ?? nk, table: nk, cols };
      }
      let meta: TableInfo | null = null;
      try {
        meta = ctx.lookup({ schema: src.schema, name: src.name });
      } catch {
        meta = null;
      }
      return { kind: 'table', alias: src.alias, table: nk, meta };
    }
    if (src.kind === 'derived') return { kind: 'derived', alias: src.alias, cols: resolveQuery(src.shape, ctx, []) };
    return { kind: 'opaque', alias: src.alias };
  });
}

function matchQ(en: Entry, q: string): boolean {
  return en.alias === q || (!en.alias && en.table === q) || (!!en.table && en.table === q);
}

function expand(en: Entry): OutCol[] {
  if (en.kind === 'table' && en.meta) {
    return en.meta.columns.map((c) => ({ name: nameKey(c.name), sources: [{ table: en.table ?? '?', column: c.name, comment: c.comment ?? null, known: true }] }));
  }
  if (en.kind === 'derived' && en.cols) return en.cols.map((c) => ({ ...c, sources: [...c.sources] }));
  return [{ name: '*', sources: [], placeholder: { table: entryName(en) } }];
}

function fromEntry(en: Entry, name: string): SrcCol[] {
  if (en.kind === 'table') {
    if (!en.meta) return [{ table: entryName(en), column: name, known: false }];
    const c = findCol(en.meta, name);
    return [{ table: entryName(en), column: c?.name ?? name, comment: c?.comment ?? null, known: true }];
  }
  if (en.kind === 'derived' && en.cols) {
    const c = en.cols.find((x) => x.name === name);
    if (c) return c.sources;
    const ph = en.cols.find((x) => x.placeholder);
    return ph ? [{ table: ph.placeholder?.table ?? entryName(en), column: name, known: false }] : [];
  }
  return [{ table: entryName(en), column: name, known: false }];
}

function resolveRef(q: string | undefined, name: string, scopes: Entry[][]): SrcCol[] {
  for (const sc of scopes) {
    if (q) {
      const en = sc.find((e) => e.alias === q) ?? sc.find((e) => matchQ(e, q));
      if (en) return fromEntry(en, name);
      continue;
    }
    const hits: SrcCol[] = [];
    const unknown: Entry[] = [];
    for (const en of sc) {
      if (en.kind === 'table' && en.meta) {
        const c = findCol(en.meta, name);
        if (c) hits.push({ table: entryName(en), column: c.name, comment: c.comment ?? null, known: true });
      } else if (en.kind === 'derived' && en.cols) {
        const c = en.cols.find((x) => x.name === name);
        if (c) hits.push(...c.sources);
        else if (en.cols.some((x) => x.placeholder)) unknown.push(en);
      } else unknown.push(en);
    }
    if (hits.length) return hits;
    if (unknown.length) return unknown.flatMap((en) => fromEntry(en, name));
  }
  return [];
}

function resolveBranch(items: SelItem[], from: Src[], ctx: Ctx, outer: Entry[][]): OutCol[] {
  const scope = scopeOf(from, ctx);
  const scopes = [scope, ...outer];
  const out: OutCol[] = [];
  for (const it of items) {
    if (it.star) {
      const q = it.star.q;
      const entries = q ? scope.filter((e) => matchQ(e, q)) : scope;
      if (!entries.length) out.push({ name: '*', sources: [], placeholder: { table: q ?? '?' } });
      for (const en of entries) out.push(...expand(en));
      continue;
    }
    const sources: SrcCol[] = [];
    for (const r of it.refs) sources.push(...resolveRef(r.q, r.name, scopes));
    for (const sub of it.subs) {
      const sc = resolveQuery(sub, ctx, scopes);
      if (sc[0]) sources.push(...sc[0].sources);
    }
    out.push({ name: it.name, sources });
  }
  return out;
}

// ------------------------------------------------------------------ 실제 결과 열에 맞추기

export interface ResultColInfo {
  name: string;
  /** MySQL·MariaDB 결과 정보: 원본 테이블·컬럼 (식이면 빈 값) */
  orgTable?: string;
  orgName?: string;
  db?: string;
}

/** 결과 열마다 원본 컬럼 후보 */
export function sourcesForResult(shape: QueryShape | null, cols: ResultColInfo[], lookup: MetaLookup, tables: TableInfo[]): SrcCol[][] {
  const out: SrcCol[][] = cols.map(() => []);
  const byName = (name: string): SrcCol[] => {
    const hits: SrcCol[] = [];
    for (const t of tables) {
      const c = findCol(t, name);
      if (c) hits.push({ table: nameKey(t.name), column: c.name, comment: c.comment ?? null, known: true });
    }
    return hits.length ? hits : [{ table: '?', column: name, known: false }];
  };
  let outs: OutCol[] | null = null;
  if (shape) {
    try {
      outs = resolveShape(shape, lookup);
    } catch {
      outs = null;
    }
  }
  if (outs && outs.length) {
    const ph = outs.filter((o) => o.placeholder);
    const fixed = outs.length - ph.length;
    if (!ph.length && outs.length === cols.length) {
      outs.forEach((o, i) => out[i].push(...o.sources));
    } else if (ph.length === 1 && cols.length >= fixed) {
      const span = cols.length - fixed;
      let i = 0;
      for (const o of outs) {
        if (o.placeholder) {
          for (let k = 0; k < span; k++, i++) out[i].push({ table: o.placeholder.table, column: cols[i].name, known: false });
        } else {
          out[i].push(...o.sources);
          i++;
        }
      }
    } else {
      // 열 수가 맞지 않음: 이름으로 맞춘다
      cols.forEach((c, i) => {
        const key = nameKey(c.name);
        const same = outs!.filter((o) => !o.placeholder && o.name === key);
        if (same.length) for (const o of same) out[i].push(...o.sources);
        else if (ph.length) for (const p of ph) out[i].push({ table: p.placeholder?.table ?? '?', column: c.name, known: false });
        else out[i].push(...byName(c.name));
      });
    }
  } else {
    cols.forEach((c, i) => out[i].push(...byName(c.name)));
  }
  // MySQL·MariaDB가 알려 준 원본 컬럼도 더한다
  cols.forEach((c, i) => {
    if (!c.orgName || !c.orgTable) return;
    let meta: TableInfo | null = null;
    try {
      meta = lookup({ schema: c.db || undefined, name: c.orgTable });
    } catch {
      meta = null;
    }
    const col = meta ? findCol(meta, c.orgName) : undefined;
    out[i].push({ table: nameKey(c.orgTable), column: c.orgName, comment: meta ? (col?.comment ?? null) : undefined, known: !!meta });
  });
  return out;
}

/** 결과 열마다 이름·주석 패턴으로 가릴지 */
export function decideMasks(sources: SrcCol[][], rules: MaskRule[]): boolean[] {
  return sources.map((srcs) => srcs.some((s) => columnMasked(rules, s.column, s.known ? (s.comment ?? null) : undefined)));
}

export type Cell = string | number | null;

/** 가림 적용: 패턴으로 정한 열은 값 전체, 그 밖의 열은 값 모양을 본다 */
export function applyMasks(rows: Cell[][], colMasked: boolean[]): { rows: Cell[][]; masked: boolean[] } {
  const masked = colMasked.slice();
  const out = rows.map((r) =>
    r.map((v, c) => {
      if (v === null || v === '') return v;
      if (colMasked[c]) return MASK;
      let s: string | null = null;
      if (typeof v === 'string') s = v;
      else if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1e12) s = String(v);
      if (s === null) return v;
      const m = maskByShape(s);
      if (m === null) return v;
      masked[c] = true;
      return m;
    }),
  );
  return { rows: out, masked };
}
