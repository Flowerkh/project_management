// .sql 파일: DDL(테이블·컬럼·주석)과 스크립트 SQL 문장
// 데이터 INSERT … VALUES 는 문장마다 남기지 않고 (파일, 테이블)마다 한 건으로 묶는다(결과 크기 제한).
import type { Analyzer } from '../context';
import { parseDdlFile } from '../ddl';
import { makeLineIndex } from '../files';
import { compactSql, parseSql, splitStatements } from '../sql';

const MAX_STATEMENTS_PER_FILE = 300;

function isDataInsert(sql: string): boolean {
  return /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*INSERT\b[\s\S]*?\bVALUES\s*\(/i.test(sql) && !/\bSELECT\b/i.test(sql);
}

export const sqlFilesAnalyzer: Analyzer = {
  name: 'sqlfiles',
  order: 5,
  accepts: (f) => f.lang === 'SQL',
  analyze(f, text, ctx) {
    const tables = parseDdlFile(f.id, text);
    ctx.facts.ddl.push(...tables);
    const lineOf = makeLineIndex(text);
    let inserts = 0;
    let menuInserts = 0;
    let dml = 0;
    let kept = 0;
    const dataInserts = new Map<string, { name: string; line: number; count: number }>();
    for (const { sql, offset } of splitStatements(text)) {
      const p = parseSql(sql);
      if (p.kind === 'ddl' || p.kind === 'other') continue;
      if (p.kind === 'insert') {
        inserts++;
        if (p.tables.some((t) => /MENU/i.test(t.name))) menuInserts++;
        if (isDataInsert(sql)) {
          for (const t of p.tables.filter((x) => x.crud === 'C')) {
            const k = t.name.toUpperCase();
            const d = dataInserts.get(k);
            if (d) d.count++;
            else dataInserts.set(k, { name: t.name, line: lineOf(offset), count: 1 });
          }
          continue;
        }
      } else dml++;
      if (kept >= MAX_STATEMENTS_PER_FILE) continue;
      kept++;
      ctx.addSql({
        file: f.id,
        line: lineOf(offset),
        origin: 'script',
        kind: p.kind,
        tables: p.tables,
        ...(p.dynamic ? { dynamic: true } : {}),
        text: compactSql(sql, 1200),
      });
    }
    for (const d of dataInserts.values()) {
      ctx.addSql({
        file: f.id,
        line: d.line,
        origin: 'script',
        kind: 'insert',
        tables: [{ name: d.name, crud: 'C' }],
        text: `INSERT INTO ${d.name} … VALUES (데이터 ${d.count}건)`,
      });
    }
    if (tables.length) f.layer = 'DDL';
    else if (menuInserts > 0 && menuInserts >= inserts / 2) f.layer = 'MENU_DATA';
    else if (dml > 0 || inserts > 0) f.layer = /batch|job|cron/i.test(f.path) ? 'BATCH' : 'OTHER';
  },
};
