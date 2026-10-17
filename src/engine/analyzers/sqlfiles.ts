// .sql 파일: DDL(테이블·컬럼·주석)과 스크립트 SQL 문장
import type { Analyzer } from '../context';
import { parseDdlFile } from '../ddl';
import { makeLineIndex } from '../files';
import { compactSql, parseSql, splitStatements } from '../sql';

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
    for (const { sql, offset } of splitStatements(text)) {
      const p = parseSql(sql);
      if (p.kind === 'ddl' || p.kind === 'other') continue;
      if (p.kind === 'insert') {
        inserts++;
        if (p.tables.some((t) => /MENU/i.test(t.name))) menuInserts++;
      } else dml++;
      // 데이터 INSERT가 수백 줄인 파일은 문장마다 남기지 않는다(테이블만 하나로)
      if (p.kind === 'insert' && inserts > 40) continue;
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
    if (tables.length) f.layer = 'DDL';
    else if (menuInserts > 0 && menuInserts >= inserts / 2) f.layer = 'MENU_DATA';
    else if (dml > 0 || inserts > 0) f.layer = /batch|job|cron/i.test(f.path) ? 'BATCH' : 'OTHER';
  },
};
