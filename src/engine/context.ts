// 분석기 공통 인터페이스와 실행 맥락
import type { CodeUnit, Facts, FileInfo, SqlFact } from './types';

export interface Ctx {
  facts: Facts;
  /** 경로 → 파일 */
  byPath: Map<string, FileInfo>;
  /** 파일 ID → 파일 */
  byId: Map<string, FileInfo>;
  nextSqlId(): string;
  nextUnitId(): string;
  addSql(f: Omit<SqlFact, 'id'>): SqlFact;
  addUnit(u: Omit<CodeUnit, 'id'>): CodeUnit;
  /** 기술 근거 추가 */
  hit(layer: Facts['tech'][number]['layer'], name: string, file: string, line: number, weight?: number): void;
}

export interface Analyzer {
  name: string;
  /** 분석 순서 (작을수록 먼저). DDL·매퍼 → 코드 → 화면 → 메뉴·배치 */
  order: number;
  accepts(f: FileInfo, text: string): boolean;
  analyze(f: FileInfo, text: string, ctx: Ctx): void;
  /** 모든 파일을 본 뒤 한 번 */
  finish?(ctx: Ctx): void;
}

export function createCtx(facts: Facts): Ctx {
  let q = 0;
  let u = 0;
  const byPath = new Map<string, FileInfo>();
  const byId = new Map<string, FileInfo>();
  for (const f of facts.files) {
    byPath.set(f.path, f);
    byId.set(f.id, f);
  }
  const ctx: Ctx = {
    facts,
    byPath,
    byId,
    nextSqlId: () => `Q${String(++q).padStart(4, '0')}`,
    nextUnitId: () => `U${String(++u).padStart(4, '0')}`,
    addSql(f) {
      const s: SqlFact = { id: ctx.nextSqlId(), ...f };
      facts.sql.push(s);
      return s;
    },
    addUnit(x) {
      const unit: CodeUnit = { id: ctx.nextUnitId(), ...x };
      facts.units.push(unit);
      return unit;
    },
    hit(layer, name, file, line, weight = 1) {
      let h = facts.tech.find((t) => t.name === name && t.layer === layer);
      if (!h) {
        h = { layer, name, evidence: [], weight: 0 };
        facts.tech.push(h);
      }
      h.weight += weight;
      if (h.evidence.length < 8 && !h.evidence.some((e) => e.file === file)) h.evidence.push({ file, line });
    },
  };
  return ctx;
}
