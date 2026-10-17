// DB 종류별로 나뉜 매퍼(…/oracle/…, …_mysql.xml)가 함께 있으면, 감지된 DB 것만 남긴다.
// 전자정부 공통컴포넌트처럼 같은 SQL이 DB마다 8벌씩 있는 프로젝트에서 중복을 없앤다.
import type { Facts } from './types';
import { databases } from './summary';

const VENDORS: Record<string, string[]> = {
  oracle: ['Oracle'],
  mysql: ['MySQL', 'MySQL 계열'],
  maria: ['MariaDB', 'MySQL 계열'],
  mariadb: ['MariaDB', 'MySQL 계열'],
  postgres: ['PostgreSQL'],
  postgresql: ['PostgreSQL'],
  tibero: ['Tibero'],
  mssql: ['MSSQL'],
  sqlserver: ['MSSQL'],
  hsql: ['HSQLDB·H2(내장)'],
  hsqldb: ['HSQLDB·H2(내장)'],
  h2: ['HSQLDB·H2(내장)'],
  altibase: ['Altibase'],
  cubrid: ['CUBRID'],
  goldilocks: ['Goldilocks'],
  db2: ['DB2'],
};

function vendorOfPath(path: string): string | null {
  const p = path.toLowerCase();
  for (const seg of p.split('/')) if (VENDORS[seg]) return seg;
  const m = /_(oracle|mysql|maria|mariadb|postgres|postgresql|tibero|mssql|sqlserver|hsql|hsqldb|h2|altibase|cubrid|goldilocks|db2)\.(xml|sql)$/.exec(p);
  return m ? m[1] : null;
}

/** 남긴 DB 이름 (없으면 null) */
export function pruneVendorMappers(facts: Facts): { kept: string; dropped: number } | null {
  const fileVendor = new Map<string, string>();
  for (const f of facts.files) {
    if (f.excluded) continue;
    if (f.layer !== 'MAPPER' && f.layer !== 'DDL' && f.lang !== 'SQL') continue;
    const v = vendorOfPath(f.path);
    if (v) fileVendor.set(f.id, v);
  }
  const vendors = new Set(fileVendor.values());
  if (vendors.size < 2) return null;
  const dbs = databases(facts).map((d) => d.type);
  let keep: string | null = null;
  for (const db of dbs) {
    const hit = [...vendors].find((v) => VENDORS[v]?.includes(db));
    if (hit) {
      keep = hit;
      break;
    }
  }
  if (!keep) return null;
  const sameDb = (v: string) => VENDORS[v]?.some((n) => VENDORS[keep!]?.includes(n));
  const before = facts.sql.length;
  facts.sql = facts.sql.filter((s) => {
    const v = fileVendor.get(s.file);
    return !v || v === keep || sameDb(v);
  });
  facts.ddl = facts.ddl.filter((t) => {
    const v = fileVendor.get(t.evidence.file);
    return !v || v === keep || sameDb(v);
  });
  return { kept: keep, dropped: before - facts.sql.length };
}
