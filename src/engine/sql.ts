// SQL에서 테이블과 CRUD를 뽑는다. 정확한 파서 대신 토큰 단위 규칙으로 처리해
// Oracle·MySQL·MariaDB 문법과 MyBatis·iBatis 자리표시자가 섞여도 멈추지 않게 한다.
import type { Crud, SqlFact, TableRef } from './types';

export type SqlKind = SqlFact['kind'];

const CLAUSE_STOP = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'INTERSECT', 'MINUS', 'EXCEPT', 'CONNECT', 'START', 'LIMIT',
  'OFFSET', 'FETCH', 'FOR', 'ON', 'USING', 'SET', 'VALUES', 'VALUE', 'SELECT', 'INTO', 'WHEN', 'THEN', 'RETURNING',
  'WINDOW', 'QUALIFY', 'PIVOT', 'UNPIVOT', 'MODEL', 'PARTITION', 'SAMPLE', 'WITH', 'LEFT', 'RIGHT', 'INNER',
  'OUTER', 'FULL', 'CROSS', 'JOIN', 'NATURAL', 'STRAIGHT_JOIN', 'LOCK', 'PROCEDURE', 'AS', 'USE', 'FORCE', 'IGNORE',
]);

const NOT_TABLE = new Set([
  'DUAL', 'SELECT', 'TABLE', 'LATERAL', 'UNNEST', 'THE', 'ONLY', 'WHERE', 'SET', 'VALUES', 'DEFAULT', 'NULL',
  'SYSDATE', 'SYSTIMESTAMP', 'NOW', 'CURRENT_TIMESTAMP', 'XMLTABLE', 'JSON_TABLE', 'GENERATE_SERIES',
]);

interface Tok {
  t: string;        // 원문
  u: string;        // 대문자
  kind: 'word' | 'punct' | 'param' | 'dyn';
}

/** 주석·문자열·자리표시자를 정리한 SQL */
export function cleanSql(raw: string): { text: string; dynamicTable: boolean } {
  let s = raw;
  let dynamicTable = false;
  // CDATA·XML 엔티티
  s = s.replace(/<!\[CDATA\[/g, ' ').replace(/\]\]>/g, ' ');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  // 주석
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/--[^\n]*/g, ' ');
  // 문자열 리터럴 (작은따옴표, '' 이스케이프)
  s = s.replace(/'(?:[^']|'')*'/g, "''");
  // ${...} 동적 이름: FROM/INTO/UPDATE/JOIN 바로 뒤면 동적 테이블
  if (/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+\$\{/i.test(s) || /\b(FROM|JOIN|INTO|UPDATE)\s+\$[A-Za-z_]/i.test(s)) dynamicTable = true;
  s = s.replace(/[#$]\{[^}]*\}/g, ' :p ');
  // iBatis #prop# / $prop$
  s = s.replace(/#[A-Za-z_][\w.\[\]:]*#/g, ' :p ').replace(/\$[A-Za-z_][\w.\[\]]*\$/g, ' :p ');
  s = s.replace(/\s+/g, ' ').trim();
  return { text: s, dynamicTable };
}

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(:p)\b|([A-Za-z_À-￿][\w$#À-￿]*)|(\d+(?:\.\d+)?)|(<=|>=|<>|!=|\|\||[(),.;=<>*+\-/@%:?])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) {
      const t = m[1] ?? m[2] ?? m[3] ?? '';
      out.push({ t, u: t.toUpperCase(), kind: 'word' });
    } else if (m[4]) out.push({ t: ':p', u: ':P', kind: 'param' });
    else if (m[5]) out.push({ t: m[5], u: m[5].toUpperCase(), kind: 'word' });
    else if (m[6]) out.push({ t: m[6], u: m[6], kind: 'punct' });
    else if (m[7]) out.push({ t: m[7], u: m[7], kind: 'punct' });
  }
  return out;
}

/** 이름 하나 읽기: schema.table, table@dblink. 끝 위치와 이름 반환 */
function readName(toks: Tok[], i: number): { name: string; end: number } | null {
  const a = toks[i];
  if (!a || a.kind !== 'word') return null;
  let name = a.t;
  let j = i + 1;
  while (toks[j]?.t === '.' && toks[j + 1]?.kind === 'word') {
    name = toks[j + 1].t; // 스키마 접두어 버림
    j += 2;
  }
  if (toks[j]?.t === '@' && toks[j + 1]?.kind === 'word') j += 2; // DB 링크
  return { name, end: j };
}

function isTableName(name: string): boolean {
  const u = name.toUpperCase();
  if (NOT_TABLE.has(u) || CLAUSE_STOP.has(u)) return false;
  if (/^\d/.test(name)) return false;
  return /^[A-Za-z_À-￿][\w$#À-￿]*$/.test(name);
}

/** 별칭 건너뛰기: [AS] alias */
function skipAlias(toks: Tok[], j: number): number {
  if (toks[j]?.u === 'AS') j++;
  const t = toks[j];
  if (t && t.kind === 'word' && !CLAUSE_STOP.has(t.u) && !['PARTITION', 'SUBPARTITION', 'TABLESAMPLE'].includes(t.u)) j++;
  return j;
}

export interface SqlParse {
  kind: SqlKind;
  tables: TableRef[];
  dynamic: boolean;
}

export function sqlKind(clean: string): SqlKind {
  const m = /^\s*\(?\s*([A-Za-z]+)/.exec(clean);
  const w = (m?.[1] ?? '').toUpperCase();
  if (w === 'SELECT' || w === 'WITH') {
    // WITH … INSERT/UPDATE/DELETE (PostgreSQL·MySQL 8) 는 드묾: 본문 첫 DML로 판단
    if (w === 'WITH') {
      const dm = /\)\s*(INSERT|UPDATE|DELETE|MERGE|SELECT)\b/i.exec(clean);
      if (dm) return dm[1].toLowerCase() as SqlKind;
    }
    return 'select';
  }
  if (w === 'INSERT' || w === 'REPLACE') return 'insert';
  if (w === 'UPDATE') return 'update';
  if (w === 'DELETE' || w === 'TRUNCATE') return w === 'TRUNCATE' ? 'ddl' : 'delete';
  if (w === 'MERGE' || w === 'UPSERT') return 'merge';
  if (w === 'CALL' || w === 'EXEC' || w === 'EXECUTE' || w === 'BEGIN' || w === 'DECLARE') return 'call';
  if (['CREATE', 'ALTER', 'DROP', 'COMMENT', 'GRANT', 'REVOKE', 'RENAME'].includes(w)) return 'ddl';
  return 'other';
}

/** SQL 한 문장에서 테이블·CRUD 추출 */
export function parseSql(raw: string): SqlParse {
  const { text, dynamicTable } = cleanSql(raw);
  const kind = sqlKind(text);
  const toks = tokenize(text);
  const found = new Map<string, Set<Crud>>();
  const cte = new Set<string>();
  const add = (name: string, crud: Crud) => {
    if (!isTableName(name) || cte.has(name.toUpperCase())) return;
    const key = name;
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(crud);
  };

  // WITH 이름 AS ( … ) 의 CTE 이름 수집
  for (let i = 0; i < toks.length; i++) {
    if ((toks[i].u === 'WITH' || toks[i].t === ',') && toks[i + 1]?.kind === 'word' && toks[i + 2]?.u === 'AS' && toks[i + 3]?.t === '(') {
      cte.add(toks[i + 1].u);
    }
    if ((toks[i].u === 'WITH' || toks[i].t === ',') && toks[i + 1]?.kind === 'word' && toks[i + 2]?.t === '(') {
      // WITH name (col, …) AS (
      let j = i + 3;
      let depth = 1;
      while (j < toks.length && depth) {
        if (toks[j].t === '(') depth++;
        else if (toks[j].t === ')') depth--;
        j++;
      }
      if (toks[j]?.u === 'AS') cte.add(toks[i + 1].u);
    }
  }

  // MERGE 대상의 CRUD는 WHEN 절에 따라
  const mergeCrud: Crud[] = [];
  if (kind === 'merge') {
    if (/\bWHEN\s+MATCHED\b[\s\S]*?\bUPDATE\b/i.test(text)) mergeCrud.push('U');
    if (/\bWHEN\s+NOT\s+MATCHED\b[\s\S]*?\bINSERT\b/i.test(text)) mergeCrud.push('C');
    if (/\bDELETE\s+WHERE\b/i.test(text) || /\bTHEN\s+DELETE\b/i.test(text)) mergeCrud.push('D');
    if (!mergeCrud.length) mergeCrud.push('U', 'C');
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'word') continue;
    const u = t.u;
    // FROM 목록 (콤마 조인 포함)
    if (u === 'FROM') {
      const prev = toks[i - 1]?.u;
      const isDeleteFrom = prev === 'DELETE' || (toks[i - 2]?.u === 'DELETE' && toks[i - 1]?.kind === 'word' && kind === 'delete');
      let j = i + 1;
      for (;;) {
        if (toks[j]?.t === '(') break; // 서브쿼리는 안쪽 FROM이 따로 처리
        const r = readName(toks, j);
        if (!r) break;
        add(r.name, isDeleteFrom && prev === 'DELETE' ? 'D' : 'R');
        j = skipAlias(toks, r.end);
        if (toks[j]?.t === ',') {
          j++;
          continue;
        }
        break;
      }
      continue;
    }
    if (u === 'JOIN' || u === 'STRAIGHT_JOIN' || (u === 'APPLY' && (toks[i - 1]?.u === 'CROSS' || toks[i - 1]?.u === 'OUTER'))) {
      if (toks[i + 1]?.t === '(') continue;
      const r = readName(toks, i + 1);
      if (r) add(r.name, kind === 'update' && isUpdateTarget(toks, i) ? 'U' : 'R');
      continue;
    }
    if (u === 'INTO') {
      const prev = toks[i - 1]?.u;
      // SELECT … INTO 변수 (PL/SQL) 는 제외: INSERT/MERGE/ALL 뒤 또는 INTO 다음 이름 뒤에 ( 또는 VALUES/SELECT
      if (prev === 'INSERT' || prev === 'IGNORE' || prev === 'ALL' || prev === 'FIRST' || prev === 'REPLACE' || prev === 'MERGE' || prev === 'DELAYED' || prev === 'LOW_PRIORITY' || prev === 'HIGH_PRIORITY' || isInsertAllInto(toks, i)) {
        const r = readName(toks, i + 1);
        if (r) {
          if (prev === 'MERGE') mergeCrud.forEach((c) => add(r.name, c));
          else add(r.name, 'C');
        }
      }
      continue;
    }
    if ((u === 'INSERT' || u === 'REPLACE') && toks[i + 1]?.kind === 'word' && !['INTO', 'IGNORE', 'ALL', 'FIRST', 'DELAYED', 'LOW_PRIORITY', 'HIGH_PRIORITY', 'OVERWRITE'].includes(toks[i + 1].u)) {
      // MySQL: INSERT tbl VALUES …
      const r = readName(toks, i + 1);
      if (r && (toks[r.end]?.t === '(' || ['VALUES', 'VALUE', 'SET', 'SELECT'].includes(toks[r.end]?.u ?? ''))) add(r.name, 'C');
      continue;
    }
    if (u === 'UPDATE' && (i === 0 || toks[i - 1]?.t === '(' || toks[i - 1]?.t === ';' || toks[i - 1]?.u === 'THEN' || toks[i - 1]?.t === ')')) {
      if (toks[i - 1]?.u === 'THEN') continue; // MERGE … THEN UPDATE SET
      let j = i + 1;
      while (['LOW_PRIORITY', 'IGNORE', 'ONLY'].includes(toks[j]?.u ?? '')) j++;
      const r = readName(toks, j);
      if (r) add(r.name, 'U');
      // UPDATE a, b SET … (MySQL 다중 테이블)
      let k = r ? skipAlias(toks, r.end) : j;
      while (toks[k]?.t === ',') {
        const r2 = readName(toks, k + 1);
        if (!r2) break;
        add(r2.name, 'U');
        k = skipAlias(toks, r2.end);
      }
      continue;
    }
    if (u === 'DELETE' && toks[i - 1]?.u !== 'THEN' && toks[i + 1]?.u !== 'WHERE') {
      // DELETE [FROM] t  /  DELETE t1 FROM t1 JOIN …
      let j = i + 1;
      while (['LOW_PRIORITY', 'QUICK', 'IGNORE'].includes(toks[j]?.u ?? '')) j++;
      if (toks[j]?.u === 'FROM') {
        const r = readName(toks, j + 1);
        if (r) add(r.name, 'D');
      } else {
        const r = readName(toks, j);
        if (r) add(r.name, 'D');
      }
      continue;
    }
    if (u === 'MERGE' && toks[i + 1]?.u === 'INTO') continue; // INTO에서 처리
    if (u === 'USING' && kind === 'merge') {
      if (toks[i + 1]?.t === '(') continue;
      const r = readName(toks, i + 1);
      if (r) add(r.name, 'R');
      continue;
    }
    if (u === 'TRUNCATE' && toks[i + 1]?.u === 'TABLE') {
      const r = readName(toks, i + 2);
      if (r) add(r.name, 'D');
      continue;
    }
  }

  const tables: TableRef[] = [];
  const order: Crud[] = ['C', 'R', 'U', 'D'];
  for (const [name, set] of found) {
    for (const c of order) if (set.has(c)) tables.push({ name, crud: c, ...(dynamicTable ? { estimated: true } : {}) });
  }
  return { kind, tables, dynamic: dynamicTable };
}

function isUpdateTarget(toks: Tok[], joinIdx: number): boolean {
  // UPDATE a JOIN b ON … SET : 조인된 테이블도 수정 대상이 될 수 있으나 보통 조회용 → 조회로 둠
  void toks;
  void joinIdx;
  return false;
}

function isInsertAllInto(toks: Tok[], i: number): boolean {
  // INSERT ALL INTO a … INTO b … SELECT : 두 번째 INTO 앞은 ')' 또는 이름
  for (let k = i - 1; k >= 0 && k > i - 400; k--) {
    if (toks[k].u === 'INSERT' && (toks[k + 1]?.u === 'ALL' || toks[k + 1]?.u === 'FIRST')) return true;
    if (toks[k].u === 'SELECT' || toks[k].t === ';') return false;
  }
  return false;
}

/** 코드 안 문자열이 SQL처럼 보이는지 */
export function isSqlLike(s: string): boolean {
  const t = s.replace(/^[\s(]+/, '').slice(0, 400).toUpperCase();
  if (/^(SELECT|WITH)\b[\s\S]*\bFROM\b/.test(t)) return true;
  if (/^SELECT\b/.test(t) && t.length > 20) return /\bFROM\b/.test(s.toUpperCase());
  if (/^INSERT\s+(IGNORE\s+)?INTO\b/.test(t) || /^REPLACE\s+INTO\b/.test(t)) return true;
  if (/^UPDATE\s+[\w."`]+\s+(\w+\s+)?SET\b/.test(t)) return true;
  if (/^DELETE\s+FROM\b/.test(t) || /^DELETE\s+[\w."`]+\s+WHERE\b/.test(t)) return true;
  if (/^MERGE\s+INTO\b/.test(t)) return true;
  if (/^(CALL|EXEC)\s+\w/.test(t) && t.length < 200) return true;
  return false;
}

/** 공백 정리 + 길이 제한 */
export function compactSql(raw: string, max = 4000): string {
  const s = raw.replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

/** .sql 파일을 문장 단위로 자르기 (; 또는 줄 하나에 있는 / 기준, 문자열·주석 안은 무시) */
export function splitStatements(text: string): { sql: string; offset: number }[] {
  const out: { sql: string; offset: number }[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  let inPlsql = false;
  const push = (end: number) => {
    const sql = text.slice(start, end);
    if (sql.trim()) {
      const lead = sql.length - sql.trimStart().length;
      out.push({ sql: sql.trim(), offset: start + lead });
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") break;
        else i++;
      }
      i++;
      continue;
    }
    // PL/SQL 블록 시작 (CREATE OR REPLACE PROCEDURE/FUNCTION/TRIGGER/PACKAGE, BEGIN, DECLARE) 은 / 줄까지
    if (!inPlsql && (i === start || /\s/.test(text[i - 1] ?? ' '))) {
      const head = text.slice(i, i + 60).toUpperCase();
      if (/^(CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE)|BEGIN\b|DECLARE\b)/.test(head) && text.slice(start, i).trim() === '') inPlsql = true;
    }
    if (c === ';' && !inPlsql) {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    if (c === '/' && (i === 0 || text[i - 1] === '\n') && /^\/[ \t]*(\r?\n|$)/.test(text.slice(i, i + 3))) {
      push(i);
      start = i + 1;
      inPlsql = false;
      i++;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

/** CRUD 집합 합치기 (C R U D 순) */
export function mergeCrud(...lists: Crud[][]): Crud[] {
  const s = new Set<Crud>();
  for (const l of lists) for (const c of l) s.add(c);
  return (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => s.has(c));
}

/** 테이블 비교용 키 */
export function tableKey(name: string): string {
  return name.replace(/^["`[]|["`\]]$/g, '').toUpperCase();
}
