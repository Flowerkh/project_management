// DDL(CREATE TABLE, COMMENT ON)과 INSERT 데이터 해석. Oracle·MySQL·MariaDB 문법.
import type { DdlColumn, DdlTable } from './types';
import { makeLineIndex } from './files';
import { splitStatements } from './sql';

/** 괄호·따옴표 밖의 콤마로 나누기 */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") {
          cur += s[++i];
        } else q = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function unquote(name: string): string {
  return name.trim().replace(/^["`[]/, '').replace(/["`\]]$/, '');
}

/** schema.table → table */
function lastName(qualified: string): string {
  const parts = qualified.split('.').map(unquote);
  return parts[parts.length - 1];
}

function sqlString(lit: string): string {
  const m = /^'((?:[^']|'')*)'$/s.exec(lit.trim());
  return m ? m[1].replace(/''/g, "'") : lit.trim();
}

/** 문장 앞 주석 제거 (본문 안 문자열은 유지) */
function stripLeadingComments(s: string): string {
  let t = s;
  for (;;) {
    const before = t;
    t = t.replace(/^\s*--[^\n]*\n?/, '').replace(/^\s*\/\*[\s\S]*?\*\//, '');
    if (t === before) return t.trim();
  }
}

/** 주석을 지우되 문자열 안은 그대로 */
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") break;
        else j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? s.length : e;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? s.length : e + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CONSTRAINT_START = /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|KEY|INDEX|FOREIGN\s+KEY|CHECK|FULLTEXT|SPATIAL)\b/i;

export function parseCreateTable(stmt: string): Omit<DdlTable, 'evidence'> | null {
  const s = stripComments(stmt);
  const m = /^\s*CREATE\s+(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|MEMORY\s+|CACHED\s+|TEMP\s+|TEXT\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w$#."`[\]]+)\s*\(/i.exec(s);
  if (!m) return null;
  const name = lastName(m[1]);
  // 본문 괄호 짝 찾기
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const bodyStart = i + 1;
  let q: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = s.slice(bodyStart, i);
  const tail = s.slice(i + 1);
  const columns: DdlColumn[] = [];
  const pk: string[] = [];
  for (const item of splitTopLevel(body)) {
    if (CONSTRAINT_START.test(item)) {
      const pm = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(item);
      if (pm) pk.push(...pm[1].split(',').map((x) => unquote(x.replace(/\s+(ASC|DESC)$/i, ''))));
      continue;
    }
    const cm = /^([\w$#"`[\]가-힣]+)\s+([A-Za-z][\w ]*?(?:\([^)]*\))?)(?=\s|$|,)/.exec(item);
    if (!cm) continue;
    const col: DdlColumn = { name: unquote(cm[1]), type: cm[2].trim().replace(/\s+/g, ' ').toUpperCase() };
    if (/\bNOT\s+NULL\b/i.test(item)) col.nullable = false;
    else col.nullable = true;
    if (/\bPRIMARY\s+KEY\b/i.test(item)) {
      col.pk = true;
      col.nullable = false;
    }
    const com = /\bCOMMENT\s+'((?:[^']|'')*)'/i.exec(item);
    if (com) col.comment = com[1].replace(/''/g, "'");
    columns.push(col);
  }
  for (const c of columns) if (pk.some((p) => p.toUpperCase() === c.name.toUpperCase())) {
    c.pk = true;
    c.nullable = false;
  }
  const tm = /\bCOMMENT\s*=?\s*'((?:[^']|'')*)'/i.exec(tail);
  return { name, columns, ...(tm ? { comment: tm[1].replace(/''/g, "'") } : {}) };
}

/** 파일 하나의 DDL 해석 (CREATE TABLE + COMMENT ON + ALTER … PRIMARY KEY) */
export function parseDdlFile(fileId: string, text: string): DdlTable[] {
  if (!/\bCREATE\s+(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|MEMORY\s+|CACHED\s+|TEMP\s+|TEXT\s+)?TABLE\b/i.test(text) && !/\bCOMMENT\s+ON\b/i.test(text)) return [];
  const lineOf = makeLineIndex(text);
  const tables = new Map<string, DdlTable>();
  const comments: { table: string; column?: string; text: string }[] = [];
  const pks: { table: string; cols: string[] }[] = [];
  for (const { sql, offset } of splitStatements(text)) {
    const body = stripLeadingComments(sql);
    if (/^CREATE\s/i.test(body)) {
      const t = parseCreateTable(body);
      if (t) {
        const lead = sql.indexOf(body.slice(0, 20));
        tables.set(t.name.toUpperCase(), { ...t, evidence: { file: fileId, line: lineOf(offset + Math.max(0, lead)) } });
      }
      continue;
    }
    const ct = /^COMMENT\s+ON\s+TABLE\s+([\w$#."`]+)\s+IS\s+('(?:[^']|'')*')/i.exec(body);
    if (ct) {
      comments.push({ table: lastName(ct[1]), text: sqlString(ct[2]) });
      continue;
    }
    const cc = /^COMMENT\s+ON\s+COLUMN\s+([\w$#."`]+)\s+IS\s+('(?:[^']|'')*')/i.exec(body);
    if (cc) {
      const parts = cc[1].split('.').map(unquote);
      if (parts.length >= 2) comments.push({ table: parts[parts.length - 2], column: parts[parts.length - 1], text: sqlString(cc[2]) });
      continue;
    }
    const ap = /^ALTER\s+TABLE\s+([\w$#."`]+)\s+ADD\s+(?:CONSTRAINT\s+[\w$#"`]+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(body);
    if (ap) pks.push({ table: lastName(ap[1]), cols: ap[2].split(',').map((x) => unquote(x.trim())) });
  }
  for (const c of comments) {
    const t = tables.get(c.table.toUpperCase());
    if (!t) continue;
    if (!c.column) t.comment = c.text;
    else {
      const col = t.columns.find((x) => x.name.toUpperCase() === c.column!.toUpperCase());
      if (col) col.comment = c.text;
    }
  }
  for (const p of pks) {
    const t = tables.get(p.table.toUpperCase());
    if (!t) continue;
    for (const col of t.columns) if (p.cols.some((x) => x.toUpperCase() === col.name.toUpperCase())) {
      col.pk = true;
      col.nullable = false;
    }
  }
  return [...tables.values()];
}

/** INSERT 문 값 해석 (VALUES 여러 줄 지원). 값은 문자열 리터럴이면 내용, 아니면 원문 */
export function parseInsert(stmt: string): { table: string; columns: string[]; rows: string[][] } | null {
  const s = stripComments(stmt).trim();
  const m = /^INSERT\s+(?:IGNORE\s+)?INTO\s+([\w$#."`]+)\s*(\(([^)]*)\))?\s*VALUES\s*/i.exec(s);
  if (!m) return null;
  const table = lastName(m[1]);
  const columns = m[3] ? m[3].split(',').map((x) => unquote(x.trim())) : [];
  const rest = s.slice(m.index + m[0].length);
  const rows: string[][] = [];
  for (const group of splitTopLevel(rest)) {
    const g = group.trim().replace(/;$/, '');
    if (!g.startsWith('(')) continue;
    const inner = g.slice(1, g.lastIndexOf(')'));
    rows.push(splitTopLevel(inner).map((v) => {
      const t = v.trim();
      if (/^N?'/.test(t)) return sqlString(t.replace(/^N/, ''));
      if (/^NULL$/i.test(t)) return '';
      return t;
    }));
  }
  return { table, columns, rows };
}
