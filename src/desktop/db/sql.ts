// SQL 분석 (순수 함수, DB 없이 시험):
//  - lex: 주석·문자열을 걷어 내고 토큰으로 나눔 (Oracle·MySQL 문법 차이 반영)
//  - splitStatements / stmtKind: 문장 수와 종류 (쿼리 카드 종류·되돌릴 수 없는 문장)
//  - checkReadOnly: Claude의 조회 도구가 바로 실행해도 되는 'SELECT 하나'인지
//  - countPlan: SELECT 외 쿼리의 예상 영향 행 수를 세는 COUNT(*) 쿼리
//  - selectShape: SELECT 결과 열이 어느 테이블의 어느 컬럼에서 왔는지 (개인정보 가림)
// 판정이 애매하면 안전한 쪽(실행하지 않음·가림)으로 간다. 실제 쓰기 차단은 읽기 전용 세션·조회 전용 계정이 한 번 더 한다.

export type Dialect = 'oracle' | 'mysql';
export type StmtKind = 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'ddl' | 'call' | 'other';

/** w 단어(식별자·키워드), q 따옴표 식별자, s 문자열 리터럴, n 숫자, p 괄호·쉼표·마침표·세미콜론, o 그 밖의 연산자 */
export interface Tok {
  t: 'w' | 'q' | 's' | 'n' | 'p' | 'o';
  /** 원문 (q는 따옴표를 벗긴 이름) */
  v: string;
  /** 비교용 대문자 (q는 v 그대로) */
  u: string;
  /** 원문 위치 [i, e) */
  i: number;
  e: number;
}

export interface Lexed {
  toks: Tok[];
  error?: string;
  /** MySQL 실행 주석 (slash-star-bang …): 주석처럼 보이지만 서버가 실행한다 */
  execComment: boolean;
}

const MAX_SQL = 200_000;

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '　' || c === '﻿';
}

function isWordStart(c: string): boolean {
  return /[A-Za-z_À-￿]/.test(c);
}

function isWordChar(c: string, d: Dialect): boolean {
  return /[A-Za-z0-9_$À-￿]/.test(c) || (d === 'oracle' && c === '#');
}

/** '…' 문자열 끝 다음 위치. 닫히지 않으면 -1 */
function readString(s: string, start: number, d: Dialect, quote = "'"): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (d === 'mysql' && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (s[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

/** Oracle q'[…]' 문자열: start는 따옴표 위치 */
function readQQuote(s: string, start: number): number {
  const open = s[start + 1];
  if (!open) return -1;
  const close = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open;
  for (let i = start + 2; i < s.length - 1; i++) {
    if (s[i] === close && s[i + 1] === "'") return i + 2;
  }
  return -1;
}

export function lex(sql: string, d: Dialect): Lexed {
  const toks: Tok[] = [];
  let execComment = false;
  if (sql.length > MAX_SQL) return { toks, error: `SQL이 너무 깁니다 (${MAX_SQL.toLocaleString('ko-KR')}자 넘음)`, execComment };
  const n = sql.length;
  let i = 0;
  const push = (t: Tok['t'], v: string, u: string, s: number, e: number) => toks.push({ t, v, u, i: s, e });
  while (i < n) {
    const c = sql[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    // 한 줄 주석: Oracle은 --, MySQL은 '-- ' (뒤에 공백)와 #
    if (c === '-' && sql[i + 1] === '-' && (d === 'oracle' || i + 2 >= n || isSpace(sql[i + 2]))) {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === '#' && d === 'mysql') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) return { toks, error: '닫히지 않은 주석이 있습니다', execComment };
      if (d === 'mysql' && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) execComment = true;
      i = j + 2;
      continue;
    }
    if (c === "'") {
      const j = readString(sql, i, d);
      if (j < 0) return { toks, error: '닫히지 않은 따옴표가 있습니다', execComment };
      push('s', sql.slice(i, j), '', i, j);
      i = j;
      continue;
    }
    if (c === '"' || (c === '`' && d === 'mysql')) {
      // 따옴표 식별자 (MySQL 기본 모드에서 "…"는 문자열이지만 판정에는 이름처럼 다뤄도 된다)
      const j = readString(sql, i, c === '"' && d === 'mysql' ? 'mysql' : 'oracle', c);
      if (j < 0) return { toks, error: '닫히지 않은 따옴표가 있습니다', execComment };
      const inner = sql.slice(i + 1, j - 1).split(c + c).join(c);
      push('q', inner, inner, i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(sql[j])) j++;
      } else {
        while (j < n && /[0-9]/.test(sql[j])) j++;
        if (sql[j] === '.' && sql[j + 1] !== '.') {
          j++;
          while (j < n && /[0-9]/.test(sql[j])) j++;
        }
        if ((sql[j] === 'e' || sql[j] === 'E') && /[0-9+-]/.test(sql[j + 1] ?? '')) {
          j += 2;
          while (j < n && /[0-9]/.test(sql[j])) j++;
        }
      }
      push('n', sql.slice(i, j), sql.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (isWordStart(c) || (d === 'mysql' && c === '$')) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j], d)) j++;
      const w = sql.slice(i, j);
      const U = w.toUpperCase();
      // 접두어가 붙은 문자열: N'…', X'…', B'…', Oracle q'[…]', MySQL _utf8mb4'…'
      if (sql[j] === "'") {
        let k = -1;
        if (d === 'oracle' && (U === 'Q' || U === 'NQ')) k = readQQuote(sql, j);
        else if (U === 'N' || U === 'X' || U === 'B' || (d === 'mysql' && w.startsWith('_'))) k = readString(sql, j, d);
        if (k > 0) {
          push('s', sql.slice(i, k), '', i, k);
          i = k;
          continue;
        }
        if (U === 'Q' || U === 'NQ') return { toks, error: '닫히지 않은 따옴표가 있습니다', execComment };
      }
      push('w', w, U, i, j);
      i = j;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === ';' || c === '.') {
      push('p', c, c, i, i + 1);
      i++;
      continue;
    }
    const three = sql.slice(i, i + 3);
    if (three === '<=>' || three === '->>') {
      push('o', three, three, i, i + 3);
      i += 3;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if ([':=', '=>', '<=', '>=', '<>', '!=', '^=', '||', '&&', '->', '<<', '>>', '::', '~='].includes(two)) {
      push('o', two, two, i, i + 2);
      i += 2;
      continue;
    }
    push('o', c, c, i, i + 1);
    i++;
  }
  return { toks, execComment };
}

// ------------------------------------------------------------------ 문장 나누기·종류

export interface Stmt {
  toks: Tok[];
  /** 원문에서 이 문장 (끝의 세미콜론 제외) */
  text: string;
}

export interface Split {
  stmts: Stmt[];
  error?: string;
  execComment: boolean;
}

const PLSQL_UNITS = new Set(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE', 'LIBRARY', 'JAVA', 'EVENT']);

/** SQL*Plus 줄 끝 '/' 같은 실행 표시 줄을 지운다 */
function stripRunLines(sql: string): string {
  return sql.replace(/(^|\n)[ \t]*\/[ \t]*(?=\r?\n|$)/g, '$1');
}

/** PL/SQL 블록·프로시저 정의처럼 안에 세미콜론이 있어도 한 문장인 것 */
function isBlock(toks: Tok[]): boolean {
  const w = (k: number) => (toks[k]?.t === 'w' ? toks[k].u : '');
  if (w(0) === 'BEGIN' || w(0) === 'DECLARE') return true;
  if (w(0) !== 'CREATE') return false;
  for (let k = 1; k < Math.min(toks.length, 8); k++) {
    const u = w(k);
    if (PLSQL_UNITS.has(u)) return true;
    if (u === 'TABLE' || u === 'VIEW' || u === 'INDEX' || u === 'SEQUENCE' || u === 'SYNONYM' || u === 'USER') return false;
  }
  return false;
}

export function splitStatements(sql: string, d: Dialect): Split {
  const src = stripRunLines(sql);
  const lx = lex(src, d);
  if (lx.error) return { stmts: [], error: lx.error, execComment: lx.execComment };
  const out: Stmt[] = [];
  const make = (ts: Tok[]): void => {
    if (!ts.length) return;
    out.push({ toks: ts, text: src.slice(ts[0].i, ts[ts.length - 1].e) });
  };
  if (isBlock(lx.toks)) {
    // PL/SQL 블록은 끝의 'END;'까지 한 문장 (세미콜론을 떼면 Oracle이 거부한다)
    make(lx.toks);
    return { stmts: out, execComment: lx.execComment };
  }
  let cur: Tok[] = [];
  for (const t of lx.toks) {
    if (t.t === 'p' && t.v === ';') {
      make(cur);
      cur = [];
    } else cur.push(t);
  }
  make(cur);
  return { stmts: out, execComment: lx.execComment };
}

/** 짝이 맞는 닫는 괄호 위치 (없으면 끝) */
export function matchParen(toks: Tok[], open: number, end = toks.length): number {
  let depth = 0;
  for (let k = open; k < end; k++) {
    const t = toks[k];
    if (t.t !== 'p') continue;
    if (t.v === '(') depth++;
    else if (t.v === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return end - 1;
}

const DDL_WORDS = new Set([
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE', 'ANALYZE', 'AUDIT', 'NOAUDIT', 'PURGE',
  'FLASHBACK', 'OPTIMIZE', 'REPAIR', 'ASSOCIATE', 'DISASSOCIATE',
]);
const MAIN_AFTER_WITH = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'VALUES', 'TABLE']);

/** WITH … 뒤의 본문 키워드 (깊이 0에서 처음 나오는 SELECT·INSERT 등) */
function afterWith(toks: Tok[], start: number): string {
  if (toks[start + 1]?.t === 'w' && (toks[start + 1].u === 'FUNCTION' || toks[start + 1].u === 'PROCEDURE')) return 'PLSQL';
  let depth = 0;
  for (let k = start + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'p' && t.v === '(') depth++;
    else if (t.t === 'p' && t.v === ')') depth--;
    else if (depth === 0 && t.t === 'w' && MAIN_AFTER_WITH.has(t.u)) return t.u;
  }
  return 'SELECT';
}

export function stmtKind(toks: Tok[]): StmtKind {
  let k = 0;
  while (toks[k]?.t === 'p' && toks[k].v === '(') k++;
  const t = toks[k];
  if (!t || t.t !== 'w') return 'other';
  let u = t.u;
  if (u === 'WITH') u = afterWith(toks, k);
  switch (u) {
    case 'SELECT':
      return 'select';
    case 'INSERT':
      return 'insert';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    case 'MERGE':
    case 'REPLACE':
      return 'merge';
    case 'CALL':
    case 'EXEC':
    case 'EXECUTE':
    case 'BEGIN':
    case 'DECLARE':
    case 'PLSQL':
      return 'call';
    default:
      return DDL_WORDS.has(u) ? 'ddl' : 'other';
  }
}

export interface Classified {
  /** 빈 문장을 뺀 문장 수 */
  count: number;
  /** 첫 문장의 종류 */
  kind: StmtKind;
  /** 첫 문장 원문 (끝 세미콜론 제외) */
  text: string;
  error?: string;
  execComment: boolean;
}

export function classify(sql: string, d: Dialect): Classified {
  const sp = splitStatements(sql, d);
  const first = sp.stmts[0];
  return {
    count: sp.stmts.length,
    kind: first ? stmtKind(first.toks) : 'other',
    text: first?.text ?? '',
    error: sp.error,
    execComment: sp.execComment,
  };
}

/** 롤백할 수 없는 문장 (DDL·프로시저 호출·그 밖) */
export function isIrreversible(kind: StmtKind): boolean {
  return kind === 'ddl' || kind === 'call' || kind === 'other';
}

// ------------------------------------------------------------------ 읽기 전용 판정 (Claude 조회 도구)

export type ReadOnlyCheck = { ok: true; sql: string; toks: Tok[] } | { ok: false; reason: string };

/** 조회에서 부르면 바깥으로 나가거나 상태를 바꾸는 함수 */
const BLOCKED_FUNCS = new Set([
  'LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'SETVAL', 'NEXTVAL', 'SYS_EXEC', 'SYS_EVAL', 'SYS_GET',
  'HTTPURITYPE', 'LO_IMPORT', 'LO_EXPORT', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'MASTER_GTID_WAIT',
]);
/** 패키지 접두어 (Oracle): 네트워크·파일·작업 실행 */
const BLOCKED_PKG = /^(UTL_|DBMS_(?!LOB$|RANDOM$|UTILITY$)|OWA_|HTP$|HTF$|SYS$)/;

export function checkReadOnly(sql: string, d: Dialect): ReadOnlyCheck {
  const sp = splitStatements(sql, d);
  if (sp.error) return { ok: false, reason: `SQL을 해석할 수 없습니다: ${sp.error}` };
  if (sp.execComment) return { ok: false, reason: '실행되는 주석(/*! … */)은 쓸 수 없습니다' };
  if (sp.stmts.length === 0) return { ok: false, reason: '실행할 SQL이 없습니다' };
  if (sp.stmts.length > 1) return { ok: false, reason: `문장 하나만 실행할 수 있습니다 (세미콜론으로 나뉜 문장 ${sp.stmts.length}개)` };
  const st = sp.stmts[0];
  const kind = stmtKind(st.toks);
  if (kind !== 'select') {
    return { ok: false, reason: 'SELECT 문(또는 WITH … SELECT)만 바로 실행합니다. 데이터나 구조를 바꾸는 쿼리는 실행하지 않고 쿼리 카드로 제안해 주세요' };
  }
  const ts = st.toks;
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    const next = ts[k + 1];
    const nextU = next?.t === 'w' ? next.u : '';
    if (t.t === 'o' && t.v === '@') {
      // MySQL·MariaDB 시스템 변수 읽기(@@version)는 괜찮다. 사용자 변수(@x)·Oracle DB 링크(t@link)는 안 됨
      if (d === 'mysql' && next?.t === 'o' && next.v === '@' && ts[k + 2]?.t === 'w' && ts[k + 2].i === next.e) {
        k += 2;
        continue;
      }
      return { ok: false, reason: 'DB 링크(@)나 변수는 쓸 수 없습니다' };
    }
    if (t.t === 'o' && t.v === ':=') return { ok: false, reason: '변수에 값을 넣는 조회는 쓸 수 없습니다' };
    if (t.t !== 'w') continue;
    switch (t.u) {
      case 'INTO':
        return { ok: false, reason: 'SELECT … INTO(변수·파일로 내보내기)는 쓸 수 없습니다' };
      case 'FOR':
        if (nextU === 'UPDATE' || nextU === 'SHARE') return { ok: false, reason: `FOR ${nextU}(행 잠금)는 조회에서 쓸 수 없습니다` };
        break;
      case 'LOCK':
        if (nextU === 'IN') return { ok: false, reason: 'LOCK IN SHARE MODE(행 잠금)는 조회에서 쓸 수 없습니다' };
        break;
      case 'NEXTVAL':
        return { ok: false, reason: '시퀀스 NEXTVAL은 값을 바꾸므로 조회에서 쓸 수 없습니다' };
      case 'NEXT':
        if (nextU === 'VALUE') return { ok: false, reason: '시퀀스 NEXT VALUE는 값을 바꾸므로 조회에서 쓸 수 없습니다' };
        break;
      case 'PROCEDURE':
        return { ok: false, reason: 'PROCEDURE 절은 쓸 수 없습니다' };
      default:
        break;
    }
    const isCall = next?.t === 'p' && (next.v === '(' || next.v === '.');
    if (isCall && (BLOCKED_FUNCS.has(t.u) || BLOCKED_PKG.test(t.u))) {
      return { ok: false, reason: `${t.v}${next.v === '.' ? '.…' : '()'}는 조회 도구에서 부를 수 없습니다` };
    }
  }
  return { ok: true, sql: st.text, toks: ts };
}

// ------------------------------------------------------------------ 이름 도우미

/** 비교용 이름 (대문자) */
export function nameKey(s: string): string {
  return s.toUpperCase();
}

function identOf(t: Tok): string {
  return t.t === 'q' ? t.v : t.u;
}

function isIdent(t: Tok | undefined): t is Tok {
  return !!t && (t.t === 'w' || t.t === 'q');
}

export interface TableRef {
  schema?: string;
  /** 따옴표 없으면 대문자, 따옴표 이름은 그대로 */
  name: string;
}

/** 문장 맨 앞의 대상 테이블 (UPDATE t / DELETE FROM t / INSERT INTO t / MERGE INTO t / DDL … TABLE t) */
export function mainTable(sql: string, d: Dialect): TableRef | null {
  const sp = splitStatements(sql, d);
  const ts = sp.stmts[0]?.toks;
  if (!ts) return null;
  const readName = (k: number): TableRef | null => {
    if (!isIdent(ts[k])) return null;
    if (ts[k + 1]?.v === '.' && isIdent(ts[k + 2])) return { schema: identOf(ts[k]), name: identOf(ts[k + 2]) };
    return { name: identOf(ts[k]) };
  };
  const kind = stmtKind(ts);
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    if (t.t !== 'w') continue;
    if ((kind === 'insert' || kind === 'merge') && t.u === 'INTO') return readName(k + 1);
    if (kind === 'merge' && t.u === 'REPLACE' && k === 0) {
      const j = ts[1]?.u === 'INTO' ? 2 : 1;
      return readName(j);
    }
    if (kind === 'update' && t.u === 'UPDATE') {
      let j = k + 1;
      while (ts[j]?.t === 'w' && (ts[j].u === 'LOW_PRIORITY' || ts[j].u === 'IGNORE')) j++;
      return readName(j);
    }
    if (kind === 'delete' && (t.u === 'FROM' || (t.u === 'DELETE' && ts[k + 1]?.u !== 'FROM'))) {
      let j = k + 1;
      while (ts[j]?.t === 'w' && (ts[j].u === 'LOW_PRIORITY' || ts[j].u === 'QUICK' || ts[j].u === 'IGNORE')) j++;
      return readName(j);
    }
    if (kind === 'ddl' && (t.u === 'TABLE' || t.u === 'VIEW' || t.u === 'INDEX' || t.u === 'SEQUENCE')) {
      let j = k + 1;
      if (ts[j]?.u === 'IF') j += ts[j + 1]?.u === 'NOT' ? 3 : 2;
      return readName(j);
    }
    if (kind === 'select' && t.u === 'FROM') return readName(k + 1);
  }
  return null;
}

// ------------------------------------------------------------------ 예상 영향 행 수 (쿼리 카드)

export interface CountPlan {
  /** 이 SELECT COUNT(*)의 결과가 예상 영향 행 수 */
  countSql?: string;
  /** 세지 않아도 아는 행 수 (INSERT … VALUES) */
  fixed?: number;
  /** MySQL UPDATE·DELETE … LIMIT n: 예상은 min(COUNT, n) */
  limit?: number;
  /** 못 세는 이유 */
  note?: string;
}

const FROM_END = new Set(['WHERE', 'ORDER', 'LIMIT', 'RETURNING', 'RETURN', 'LOG']);

function depthZeroIndex(ts: Tok[], from: number, to: number, pred: (t: Tok) => boolean): number {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const t = ts[k];
    if (t.t === 'p' && t.v === '(') depth++;
    else if (t.t === 'p' && t.v === ')') depth--;
    else if (depth === 0 && pred(t)) return k;
  }
  return -1;
}

function sliceText(text: string, ts: Tok[], from: number, to: number, base: number): string {
  if (from >= to) return '';
  return text.slice(ts[from].i - base, ts[to - 1].e - base);
}

function hasMultiTable(ts: Tok[], from: number, to: number): boolean {
  return (
    depthZeroIndex(ts, from, to, (t) => (t.t === 'p' && t.v === ',') || (t.t === 'w' && (t.u === 'JOIN' || t.u === 'USING' || t.u === 'STRAIGHT_JOIN'))) >= 0
  );
}

function limitOf(ts: Tok[], from: number, to: number): number | undefined | null {
  const k = depthZeroIndex(ts, from, to, (t) => t.t === 'w' && t.u === 'LIMIT');
  if (k < 0) return undefined;
  const n = ts[k + 1];
  if (n?.t === 'n' && /^\d+$/.test(n.v) && k + 2 >= to) return Number(n.v);
  return null;
}

export function countPlan(sql: string, d: Dialect): CountPlan {
  const sp = splitStatements(sql, d);
  if (sp.error) return { note: sp.error };
  if (sp.stmts.length !== 1) return { note: '문장이 하나가 아닙니다' };
  const st = sp.stmts[0];
  const ts = st.toks;
  const base = ts[0].i;
  const text = st.text;
  const kind = stmtKind(ts);
  const first = ts[0]?.u;
  if (first === 'WITH') return { note: 'WITH로 시작하는 변경 쿼리는 행 수를 미리 세지 않습니다' };
  const end = ts.length;
  const w = (k: number) => (ts[k]?.t === 'w' ? ts[k].u : '');

  if (kind === 'update') {
    let k = 1;
    while (w(k) === 'LOW_PRIORITY' || w(k) === 'IGNORE') {
      if (w(k) === 'IGNORE') return { note: 'UPDATE IGNORE는 바뀔 행 수를 미리 알 수 없습니다' };
      k++;
    }
    if (ts[k]?.v === '(') return { note: '인라인 뷰를 바꾸는 UPDATE는 행 수를 미리 세지 않습니다' };
    const set = depthZeroIndex(ts, k, end, (t) => t.t === 'w' && t.u === 'SET');
    if (set < 0) return { note: 'SET 절을 찾지 못했습니다' };
    if (hasMultiTable(ts, k, set)) return { note: '여러 테이블을 바꾸는 UPDATE는 행 수를 미리 세지 않습니다' };
    const target = sliceText(text, ts, k, set, base);
    return finishWhere(ts, set + 1, end, target, text, base, d);
  }

  if (kind === 'delete') {
    let k = 1;
    while (w(k) === 'LOW_PRIORITY' || w(k) === 'QUICK' || w(k) === 'IGNORE') {
      if (w(k) === 'IGNORE') return { note: 'DELETE IGNORE는 지울 행 수를 미리 알 수 없습니다' };
      k++;
    }
    if (w(k) === 'FROM') k++;
    else if (d === 'mysql' && depthZeroIndex(ts, k, end, (t) => t.t === 'w' && t.u === 'FROM') >= 0) {
      return { note: '여러 테이블에서 지우는 DELETE는 행 수를 미리 세지 않습니다' };
    }
    if (ts[k]?.v === '(') return { note: '인라인 뷰에서 지우는 DELETE는 행 수를 미리 세지 않습니다' };
    const stop = depthZeroIndex(ts, k, end, (t) => t.t === 'w' && FROM_END.has(t.u));
    const tEnd = stop < 0 ? end : stop;
    if (hasMultiTable(ts, k, tEnd)) return { note: '여러 테이블에서 지우는 DELETE는 행 수를 미리 세지 않습니다' };
    const target = sliceText(text, ts, k, tEnd, base);
    if (!target) return { note: '대상 테이블을 찾지 못했습니다' };
    return finishWhere(ts, tEnd, end, target, text, base, d);
  }

  if (kind === 'insert') {
    let k = 1;
    while (['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE'].includes(w(k))) {
      if (w(k) === 'IGNORE') return { note: 'INSERT IGNORE는 들어갈 행 수를 미리 알 수 없습니다' };
      k++;
    }
    if (w(k) === 'ALL' || w(k) === 'FIRST') return { note: '여러 테이블에 넣는 INSERT는 행 수를 미리 세지 않습니다' };
    if (depthZeroIndex(ts, k, end, (t) => t.t === 'w' && t.u === 'DUPLICATE') >= 0) {
      return { note: 'ON DUPLICATE KEY UPDATE는 바뀔 행 수를 미리 알 수 없습니다' };
    }
    if (depthZeroIndex(ts, k, end, (t) => t.t === 'w' && (t.u === 'RETURNING' || t.u === 'RETURN' || t.u === 'LOG')) >= 0) {
      return { note: 'RETURNING·LOG ERRORS가 있는 INSERT는 행 수를 미리 세지 않습니다' };
    }
    const vals = depthZeroIndex(ts, k, end, (t) => t.t === 'w' && (t.u === 'VALUES' || t.u === 'VALUE'));
    if (vals >= 0) {
      let tuples = 0;
      let depth = 0;
      for (let j = vals + 1; j < end; j++) {
        const t = ts[j];
        if (t.t === 'p' && t.v === '(') {
          if (depth === 0) tuples++;
          depth++;
        } else if (t.t === 'p' && t.v === ')') depth--;
        else if (depth === 0 && t.t === 'w' && t.u === 'AS') break;
      }
      return tuples > 0 ? { fixed: tuples } : { note: 'VALUES를 해석하지 못했습니다' };
    }
    const sel = depthZeroIndex(ts, k, end, (t) => t.t === 'w' && (t.u === 'SELECT' || t.u === 'WITH'));
    if (sel >= 0) return { countSql: `SELECT COUNT(*) FROM (${sliceText(text, ts, sel, end, base)}) pa_cnt` };
    // 괄호로 감싼 SELECT: INSERT INTO t (a, b) (SELECT …)
    for (let j = k; j < end; j++) {
      if (ts[j].t !== 'p' || ts[j].v !== '(') continue;
      const close = matchParen(ts, j, end);
      if (ts[j + 1]?.t === 'w' && (ts[j + 1].u === 'SELECT' || ts[j + 1].u === 'WITH')) {
        return { countSql: `SELECT COUNT(*) FROM (${sliceText(text, ts, j + 1, close, base)}) pa_cnt` };
      }
      j = close;
    }
    if (depthZeroIndex(ts, k, end, (t) => t.t === 'w' && t.u === 'SET') >= 0) return { fixed: 1 };
    if (depthZeroIndex(ts, k, end, (t) => t.t === 'w' && t.u === 'DEFAULT') >= 0) return { fixed: 1 };
    return { note: 'INSERT 형식을 해석하지 못했습니다' };
  }

  if (kind === 'merge') return { note: first === 'REPLACE' ? 'REPLACE는 바뀔 행 수를 미리 알 수 없습니다' : 'MERGE는 바뀔 행 수를 미리 세지 않습니다' };
  return {};
}

function finishWhere(ts: Tok[], from: number, end: number, target: string, text: string, base: number, d: Dialect): CountPlan {
  const where = depthZeroIndex(ts, from, end, (t) => t.t === 'w' && t.u === 'WHERE');
  if (depthZeroIndex(ts, from, end, (t) => t.t === 'w' && (t.u === 'RETURNING' || t.u === 'RETURN' || t.u === 'LOG')) >= 0) {
    return { note: 'RETURNING·LOG ERRORS가 있는 문장은 행 수를 미리 세지 않습니다' };
  }
  let limit: number | undefined;
  if (d === 'mysql') {
    const l = limitOf(ts, from, end);
    if (l === null) return { note: 'LIMIT 형식을 해석하지 못했습니다' };
    limit = l;
  }
  if (where < 0) return { countSql: `SELECT COUNT(*) FROM ${target}`, ...(limit !== undefined ? { limit } : {}) };
  const stop = depthZeroIndex(ts, where + 1, end, (t) => t.t === 'w' && (t.u === 'ORDER' || t.u === 'LIMIT'));
  const cond = sliceText(text, ts, where + 1, stop < 0 ? end : stop, base);
  if (!cond) return { note: 'WHERE 조건을 해석하지 못했습니다' };
  return { countSql: `SELECT COUNT(*) FROM ${target} WHERE ${cond}`, ...(limit !== undefined ? { limit } : {}) };
}

// ------------------------------------------------------------------ SELECT 결과 열의 원본 컬럼

export interface ColRef {
  /** 테이블 별칭·이름 (없으면 FROM의 테이블 중 하나) */
  q?: string;
  name: string;
}

export interface SelItem {
  /** * 또는 별칭.* */
  star?: { q?: string };
  alias?: string;
  /** 결과 열 이름 추정 (별칭, 컬럼 이름, 식 원문) */
  name: string;
  refs: ColRef[];
  /** 식 안의 스칼라 서브쿼리 */
  subs: QueryShape[];
}

export type Src =
  | { kind: 'table'; schema?: string; name: string; alias?: string }
  | { kind: 'derived'; alias?: string; shape: QueryShape }
  | { kind: 'opaque'; alias?: string };

export interface Branch {
  items: SelItem[];
  from: Src[];
}

export interface QueryShape {
  /** WITH 이름 → 본문 (열 이름 목록이 있으면 cols) */
  ctes: Map<string, { shape: QueryShape; cols?: string[] }>;
  branches: Branch[];
}

const SET_OPS = new Set(['UNION', 'INTERSECT', 'MINUS', 'EXCEPT']);
const SELECT_MODS = new Set([
  'DISTINCT', 'ALL', 'UNIQUE', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT', 'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT', 'SQL_CACHE', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS',
]);
const LIST_END = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'FETCH', 'OFFSET', 'FOR', 'WINDOW', 'LOCK', 'PROCEDURE', 'CONNECT', 'START']);
const FROM_STOP = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'FETCH', 'OFFSET', 'FOR', 'WINDOW', 'CONNECT', 'START', 'MODEL', 'INTO', 'LOCK',
  'QUALIFY', 'PROCEDURE', ...SET_OPS,
]);
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'APPLY']);
const NOT_ALIAS = new Set([
  ...FROM_STOP, ...JOIN_WORDS, 'ON', 'USING', 'AS', 'PARTITION', 'SUBPARTITION', 'SAMPLE', 'PIVOT', 'UNPIVOT', 'USE', 'FORCE', 'IGNORE',
  'LATERAL', 'VERSIONS', 'WITH', 'SEED', 'BLOCK', 'END', 'NULL', 'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'BETWEEN', 'THEN', 'ELSE',
  'WHEN', 'CASE', 'ESCAPE', 'DISTINCT', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'TRUE', 'FALSE', 'COLLATE', 'ASC', 'DESC',
]);
/** 식 안에서 컬럼이 아닌 단어 */
const EXPR_WORDS = new Set([
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'AS', 'DISTINCT', 'ALL',
  'ANY', 'SOME', 'EXISTS', 'ESCAPE', 'INTERVAL', 'DATE', 'TIME', 'TIMESTAMP', 'FROM', 'FOR', 'BY', 'ORDER', 'ASC', 'DESC', 'NULLS',
  'FIRST', 'LAST', 'LEADING', 'TRAILING', 'BOTH', 'USING', 'COLLATE', 'BINARY', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
  'REGEXP', 'RLIKE', 'DIV', 'MOD', 'XOR', 'SEPARATOR', 'PRIOR', 'CONNECT_BY_ROOT', 'UNKNOWN', 'WITH', 'ZONE', 'LOCAL', 'AT', 'ROWS',
  'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'PARTITION', 'SIMILAR', 'TO', 'MEMBER', 'OF', 'SIGNED',
  'UNSIGNED', 'CHAR', 'VARCHAR', 'VARCHAR2', 'NUMBER', 'INTEGER', 'INT', 'DECIMAL', 'TRUE', 'FALSE', 'DEFAULT', 'ON', 'EMPTY', 'ERROR',
  'ABSENT', 'FORMAT', 'JSON', 'PASSING', 'RETURNING', 'COLUMNS', 'PATH', 'ORDINALITY', 'NESTED', 'TRIM', 'SUBSTRING', 'OVERLAPS',
]);
/** 의사 컬럼·상수 */
const PSEUDO = new Set([
  'ROWNUM', 'ROWID', 'LEVEL', 'SYSDATE', 'SYSTIMESTAMP', 'USER', 'UID', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'LOCALTIMESTAMP',
  'LOCALTIME', 'CURRENT_TIME', 'CURRENT_USER', 'SESSION_USER', 'DUAL', 'CONNECT_BY_ISLEAF', 'CONNECT_BY_ISCYCLE', 'ORA_ROWSCN',
]);
/** 값을 그대로 내보내지 않는 함수 (안의 컬럼은 가림 판단에서 뺀다) */
const COUNT_LIKE = new Set(['COUNT', 'OVER', 'KEEP', 'GROUP']);

/** 결과 열 판단에 쓰는 SELECT 모양. 해석하지 못하면 null */
export function selectShape(sql: string, d: Dialect): QueryShape | null {
  const sp = splitStatements(sql, d);
  if (sp.error || sp.stmts.length !== 1) return null;
  const ts = sp.stmts[0].toks;
  try {
    return parseQuery(ts, 0, ts.length, sp.stmts[0].text, ts[0].i);
  } catch {
    return null;
  }
}

function parseQuery(ts: Tok[], s: number, e: number, text: string, base: number): QueryShape {
  const ctes = new Map<string, { shape: QueryShape; cols?: string[] }>();
  let k = s;
  if (ts[k]?.t === 'w' && ts[k].u === 'WITH') {
    k++;
    if (ts[k]?.t === 'w' && ts[k].u === 'RECURSIVE') k++;
    while (k < e && isIdent(ts[k])) {
      const name = nameKey(identOf(ts[k]));
      k++;
      let cols: string[] | undefined;
      if (ts[k]?.v === '(') {
        const close = matchParen(ts, k, e);
        cols = ts.slice(k + 1, close).filter(isIdent).map((t) => nameKey(identOf(t)));
        k = close + 1;
      }
      if (ts[k]?.u === 'AS') k++;
      while (ts[k]?.t === 'w' && (ts[k].u === 'NOT' || ts[k].u === 'MATERIALIZED')) k++;
      if (ts[k]?.v !== '(') break;
      const close = matchParen(ts, k, e);
      ctes.set(name, { shape: parseQuery(ts, k + 1, close, text, base), cols });
      k = close + 1;
      // Oracle SEARCH … / CYCLE … 절 건너뛰기
      while (k < e && !(ts[k].t === 'p' && ts[k].v === ',') && !(ts[k].t === 'w' && MAIN_AFTER_WITH.has(ts[k].u)) && ts[k].v !== '(') {
        k++;
      }
      if (ts[k]?.v === ',') {
        k++;
        continue;
      }
      break;
    }
  }
  const branches: Branch[] = [];
  // 집합 연산(UNION 등)으로 나뉜 가지
  let start = k;
  let depth = 0;
  const pieces: [number, number][] = [];
  for (let j = k; j < e; j++) {
    const t = ts[j];
    if (t.t === 'p' && t.v === '(') depth++;
    else if (t.t === 'p' && t.v === ')') depth--;
    else if (depth === 0 && t.t === 'w' && SET_OPS.has(t.u)) {
      pieces.push([start, j]);
      start = j + 1;
      while (ts[start]?.t === 'w' && (ts[start].u === 'ALL' || ts[start].u === 'DISTINCT')) start++;
    }
  }
  pieces.push([start, e]);
  for (const [a, b] of pieces) {
    if (ts[a]?.v === '(') {
      const close = matchParen(ts, a, b);
      const inner = parseQuery(ts, a + 1, close, text, base);
      for (const [nm, c] of inner.ctes) ctes.set(nm, c);
      branches.push(...inner.branches);
    } else if (ts[a]?.t === 'w' && ts[a].u === 'SELECT') {
      branches.push(parseSelect(ts, a, b, text, base));
    } else if (ts[a]?.t === 'w' && ts[a].u === 'WITH') {
      const inner = parseQuery(ts, a, b, text, base);
      for (const [nm, c] of inner.ctes) ctes.set(nm, c);
      branches.push(...inner.branches);
    }
  }
  return { ctes, branches };
}

function parseSelect(ts: Tok[], s: number, e: number, text: string, base: number): Branch {
  let k = s + 1;
  while (ts[k]?.t === 'w' && SELECT_MODS.has(ts[k].u)) k++;
  const listEnd = (() => {
    const j = depthZeroIndex(ts, k, e, (t) => t.t === 'w' && LIST_END.has(t.u));
    return j < 0 ? e : j;
  })();
  const items: SelItem[] = [];
  let a = k;
  let depth = 0;
  for (let j = k; j <= listEnd; j++) {
    const t = ts[j];
    if (j === listEnd || (depth === 0 && t.t === 'p' && t.v === ',')) {
      if (j > a) items.push(parseItem(ts, a, j, text, base));
      a = j + 1;
      continue;
    }
    if (t.t === 'p' && t.v === '(') depth++;
    else if (t.t === 'p' && t.v === ')') depth--;
  }
  let from: Src[] = [];
  if (ts[listEnd]?.t === 'w' && ts[listEnd].u === 'FROM') {
    const fs = listEnd + 1;
    const fe = (() => {
      const j = depthZeroIndex(ts, fs, e, (t) => t.t === 'w' && FROM_STOP.has(t.u));
      return j < 0 ? e : j;
    })();
    from = parseFrom(ts, fs, fe, text, base);
  }
  return { items, from };
}

function parseItem(ts: Tok[], s: number, e: number, text: string, base: number): SelItem {
  const n = e - s;
  if (n === 1 && ts[s].t === 'o' && ts[s].v === '*') return { star: {}, name: '*', refs: [], subs: [] };
  if (ts[e - 1].t === 'o' && ts[e - 1].v === '*' && ts[e - 2]?.v === '.' && isIdent(ts[e - 3])) {
    return { star: { q: nameKey(identOf(ts[e - 3])) }, name: '*', refs: [], subs: [] };
  }
  let alias: string | undefined;
  let exprEnd = e;
  const last = ts[e - 1];
  const prev = ts[e - 2];
  if (n >= 2 && prev?.t === 'w' && prev.u === 'AS' && (last.t === 'w' || last.t === 'q' || last.t === 's')) {
    alias = last.t === 's' ? last.v.slice(1, -1).replace(/''/g, "'") : identOf(last);
    exprEnd = e - 2;
  } else if (n >= 2 && isIdent(last) && !(last.t === 'w' && NOT_ALIAS.has(last.u)) && prev) {
    const prevOk =
      (prev.t === 'p' && prev.v === ')') ||
      prev.t === 'q' ||
      prev.t === 's' ||
      prev.t === 'n' ||
      (prev.t === 'w' && (!EXPR_WORDS.has(prev.u) || prev.u === 'END' || prev.u === 'NULL' || prev.u === 'TRUE' || prev.u === 'FALSE'));
    if (prevOk) {
      alias = identOf(last);
      exprEnd = e - 1;
    }
  }
  const refs: ColRef[] = [];
  const subs: QueryShape[] = [];
  collectRefs(ts, s, exprEnd, refs, subs, text, base);
  let name: string;
  if (alias) name = alias;
  else if (exprEnd - s === 1 && isIdent(ts[s])) name = identOf(ts[s]);
  else if (exprEnd - s >= 3 && isIdent(ts[exprEnd - 1]) && ts[exprEnd - 2].v === '.' && refs.length === 1 && !subs.length && exprEnd - s <= 5) {
    name = identOf(ts[exprEnd - 1]);
  } else name = text.slice(ts[s].i - base, ts[exprEnd - 1].e - base);
  return { alias: alias ? nameKey(alias) : undefined, name: nameKey(name), refs, subs };
}

function collectRefs(ts: Tok[], s: number, e: number, out: ColRef[], subs: QueryShape[], text: string, base: number): void {
  let k = s;
  while (k < e) {
    const t = ts[k];
    if (t.t === 'p' && t.v === '(') {
      const nx = ts[k + 1];
      if (nx?.t === 'w' && (nx.u === 'SELECT' || nx.u === 'WITH')) {
        const close = matchParen(ts, k, e);
        subs.push(parseQuery(ts, k + 1, close, text, base));
        k = close + 1;
        continue;
      }
      k++;
      continue;
    }
    if (isIdent(t)) {
      const parts: Tok[] = [t];
      let j = k;
      while (ts[j + 1]?.v === '.' && j + 2 < e && (isIdent(ts[j + 2]) || ts[j + 2].v === '*')) {
        parts.push(ts[j + 2]);
        j += 2;
      }
      const after = ts[j + 1];
      if (after?.t === 'p' && after.v === '(' && t.t === 'w') {
        // 함수: COUNT(…)·OVER(…) 안의 컬럼은 결과에 값으로 나오지 않는다
        if (parts.length === 1 && COUNT_LIKE.has(t.u)) {
          k = matchParen(ts, j + 1, e) + 1;
          continue;
        }
        k = j + 1;
        continue;
      }
      const lastP = parts[parts.length - 1];
      if (lastP.v === '*') {
        k = j + 1;
        continue;
      }
      if (parts.length === 1 && t.t === 'w' && (EXPR_WORDS.has(t.u) || PSEUDO.has(t.u))) {
        k++;
        continue;
      }
      out.push({ q: parts.length >= 2 ? nameKey(identOf(parts[parts.length - 2])) : undefined, name: nameKey(identOf(lastP)) });
      k = j + 1;
      continue;
    }
    k++;
  }
}

function parseFrom(ts: Tok[], s: number, e: number, text: string, base: number): Src[] {
  const out: Src[] = [];
  // 원본 항목 경계: 깊이 0의 쉼표·JOIN 계열 단어. ON/USING 조건은 건너뛴다
  let k = s;
  while (k < e) {
    // 항목 시작 전의 JOIN 계열 단어·쉼표 건너뛰기
    while (k < e && ((ts[k].t === 'p' && ts[k].v === ',') || (ts[k].t === 'w' && JOIN_WORDS.has(ts[k].u)))) k++;
    if (k >= e) break;
    const startItem = k;
    // 항목 끝: 깊이 0에서 ON·USING·쉼표·JOIN 계열 단어
    let depth = 0;
    let j = k;
    for (; j < e; j++) {
      const t = ts[j];
      if (t.t === 'p' && t.v === '(') depth++;
      else if (t.t === 'p' && t.v === ')') depth--;
      else if (depth === 0 && ((t.t === 'p' && t.v === ',') || (t.t === 'w' && (JOIN_WORDS.has(t.u) || t.u === 'ON' || t.u === 'USING')))) break;
    }
    parseSource(ts, startItem, j, out, text, base);
    k = j;
    // 조건 건너뛰기
    if (k < e && ts[k].t === 'w' && (ts[k].u === 'ON' || ts[k].u === 'USING')) {
      let d2 = 0;
      k++;
      for (; k < e; k++) {
        const t = ts[k];
        if (t.t === 'p' && t.v === '(') d2++;
        else if (t.t === 'p' && t.v === ')') d2--;
        else if (d2 === 0 && ((t.t === 'p' && t.v === ',') || (t.t === 'w' && JOIN_WORDS.has(t.u)))) break;
      }
    }
  }
  return out;
}

function readAlias(ts: Tok[], k: number, e: number): string | undefined {
  if (k >= e) return undefined;
  if (ts[k].t === 'w' && ts[k].u === 'AS' && isIdent(ts[k + 1])) return nameKey(identOf(ts[k + 1]));
  if (ts[k].t === 'q') return nameKey(ts[k].v);
  if (ts[k].t === 'w' && !NOT_ALIAS.has(ts[k].u)) return nameKey(ts[k].v);
  return undefined;
}

function parseSource(ts: Tok[], s: number, e: number, out: Src[], text: string, base: number): void {
  if (s >= e) return;
  let k = s;
  if (ts[k].t === 'w' && ts[k].u === 'LATERAL') k++;
  if (ts[k]?.v === '(') {
    const close = matchParen(ts, k, e);
    const nx = ts[k + 1];
    if (nx?.t === 'w' && (nx.u === 'SELECT' || nx.u === 'WITH')) {
      out.push({ kind: 'derived', alias: readAlias(ts, close + 1, e), shape: parseQuery(ts, k + 1, close, text, base) });
    } else {
      // 괄호로 묶은 조인
      out.push(...parseFrom(ts, k + 1, close, text, base));
    }
    return;
  }
  if (!isIdent(ts[k])) {
    out.push({ kind: 'opaque' });
    return;
  }
  // 테이블 함수: TABLE(…), JSON_TABLE(…), XMLTABLE(…), UNNEST(…)
  if (ts[k + 1]?.v === '(' && ts[k].t === 'w') {
    const close = matchParen(ts, k + 1, e);
    out.push({ kind: 'opaque', alias: readAlias(ts, close + 1, e) });
    return;
  }
  let schema: string | undefined;
  let name = identOf(ts[k]);
  k++;
  if (ts[k]?.v === '.' && isIdent(ts[k + 1])) {
    schema = name;
    name = identOf(ts[k + 1]);
    k += 2;
  }
  // 파티션·샘플·플래시백·인덱스 힌트 건너뛰기
  for (;;) {
    const t = ts[k];
    if (!t || k >= e) break;
    if (t.t === 'w' && (t.u === 'PARTITION' || t.u === 'SUBPARTITION') && ts[k + 1]?.v === '(') {
      k = matchParen(ts, k + 1, e) + 1;
      continue;
    }
    if (t.t === 'w' && t.u === 'SAMPLE') {
      k++;
      if (ts[k]?.u === 'BLOCK') k++;
      if (ts[k]?.v === '(') k = matchParen(ts, k, e) + 1;
      if (ts[k]?.u === 'SEED' && ts[k + 1]?.v === '(') k = matchParen(ts, k + 1, e) + 1;
      continue;
    }
    if (t.t === 'w' && t.u === 'AS' && ts[k + 1]?.u === 'OF') {
      // AS OF TIMESTAMP … / AS OF SCN …: 다음 별칭 후보까지 건너뛰기는 어렵다 → 끝까지
      k = e;
      break;
    }
    break;
  }
  const alias = readAlias(ts, k, e);
  out.push({ kind: 'table', schema, name, alias });
}

/** 모든 기본 테이블 (WITH 이름 제외) */
export function shapeTables(shape: QueryShape): TableRef[] {
  const seen = new Map<string, TableRef>();
  const cteNames = new Set<string>();
  const walk = (q: QueryShape): void => {
    for (const nm of q.ctes.keys()) cteNames.add(nm);
    for (const c of q.ctes.values()) walk(c.shape);
    for (const b of q.branches) {
      for (const it of b.items) for (const s of it.subs) walk(s);
      for (const src of b.from) {
        if (src.kind === 'derived') walk(src.shape);
        else if (src.kind === 'table') {
          if (!src.schema && cteNames.has(nameKey(src.name))) continue;
          const key = `${nameKey(src.schema ?? '')}.${nameKey(src.name)}`;
          if (!seen.has(key)) seen.set(key, { schema: src.schema, name: src.name });
        }
      }
    }
  };
  walk(shape);
  // WITH 이름이 나중에 정의된 경우도 빼기
  return [...seen.values()].filter((t) => t.schema || !cteNames.has(nameKey(t.name)));
}

/** 메뉴 테이블·컬럼 이름 확인 (설정 화면에서 넣은 값) */
export function isSafeIdent(s: string | undefined): boolean {
  return !!s && /^[A-Za-z0-9_$#.]+$/.test(s) && !/^\.|\.\.|\.$/.test(s) && s.length <= 128;
}
