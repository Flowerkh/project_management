// 영향 범위 (SCR-10 ②): 바뀐 파일·줄로 분석 결과에서 화면·테이블을 계산한다.
//   테이블: 바뀐 줄이 부르는 매퍼 SQL id(insertOrderHist → TB_ORDER_HIST C), 바뀐 매퍼 SQL, 동사+명사 이름(insertOrderHist → ORDER_HIST)
//   화면: 바뀐 파일을 쓰는 화면 중 흐름에 바뀐 메서드가 있는 화면 → 없으면 영향 테이블을 같은 방식(CRUD)으로 쓰는 화면 → 없으면 파일을 쓰는 화면
// 다시 분석한 뒤에는 영향 화면의 테이블·CRUD를 전후로 비교해 '바뀐 연결'을 요약한다 (진행 기록 '다시 분석').
import type { AnalysisResult, Crud, ScreenResult } from '../../../engine/types';
import type { FileChange } from '../../../shared/desktop-api';
import type { Model } from '../../model';

export interface Impact {
  screens: ScreenResult[];
  tables: { name: string; crud: Crud[] }[];
}

const VERBS: [RegExp, Crud][] = [
  [/^(insert|add|create|regist|register|save|write)(?=[A-Z_])/, 'C'],
  [/^(update|modify|change|edit)(?=[A-Z_])/, 'U'],
  [/^(delete|remove|del)(?=[A-Z_])/, 'D'],
  [/^(select|get|find|read|search|count|load|list)(?=[A-Z_])/, 'R'],
];
const CRUD_ORDER: Crud[] = ['C', 'R', 'U', 'D'];

function snake(s: string): string {
  return s.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function tableBase(name: string): string {
  return name.toUpperCase().replace(/^(TB_|TBL_|T_|TN_|TH_|TC_)/, '');
}

export function computeImpact(model: Model | null, changes: FileChange[]): Impact | null {
  if (!model) return null;
  const called = new Set<string>();
  const fns = new Set<string>();
  for (const c of changes) {
    for (const h of c.hunks) {
      if (h.fn) fns.add(h.fn.replace(/\(\)$/, ''));
      for (const l of h.lines) {
        if (l.t === ' ') continue;
        for (const m of l.s.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
        for (const m of l.s.matchAll(/["'][\w.]*?\.?([A-Za-z_]\w+)["']/g)) called.add(m[1]); // selectList("order.selectOrder")
      }
    }
  }
  const tables = new Map<string, Set<Crud>>();
  const add = (name: string, crud?: Crud) => {
    const k = name.toUpperCase();
    const s = tables.get(k) ?? new Set<Crud>();
    if (crud) s.add(crud);
    tables.set(k, s);
  };
  // 1) 부르는 매퍼 SQL id · 바뀐 매퍼 SQL(묶음의 함수 이름이 SQL id)
  for (const q of model.r.sql) {
    if (q.stmtId && (called.has(q.stmtId) || fns.has(q.stmtId))) for (const t of q.tables) add(t.name, t.crud);
  }
  // 2) 동사+명사 이름 → 같은 이름의 테이블 (eGov·MyBatis 관례)
  const byBase = new Map(model.r.tables.map((t) => [tableBase(t.name), t.name]));
  for (const n of called) {
    for (const [re, crud] of VERBS) {
      const m = re.exec(n);
      if (!m) continue;
      const t = byBase.get(snake(n.slice(m[0].length)));
      if (t) add(t, crud);
    }
  }
  // 3) 바뀐 DDL
  for (const c of changes) {
    const f = model.fileByPath.get(c.path);
    if (!f) continue;
    for (const t of model.r.tables) {
      if (t.ddl?.file !== f.id) continue;
      if (c.hunks.some((h) => h.lines.some((l) => l.t !== ' ' && l.s.toUpperCase().includes(t.name.toUpperCase())))) add(t.name);
    }
  }
  const screens = new Map<string, ScreenResult>();
  for (const c of changes) {
    const f = model.fileByPath.get(c.path);
    if (!f) continue;
    const cands = [...(model.fileUsage.get(f.id)?.screens ?? [])].map((id) => model.screenById.get(id)).filter((s): s is ScreenResult => !!s);
    const names = [...fns];
    let use = cands.filter(
      (s) => s.flow.some((st) => st.file === f.id && names.some((n) => st.symbol.includes(`${n}(`) || st.symbol.endsWith(`.${n}`))) || s.calls.some((cl) => !!cl.handler && names.some((n) => cl.handler!.includes(`${n}(`))),
    );
    if (!use.length && tables.size) {
      use = cands.filter((s) =>
        s.tables.some((t) => {
          const want = tables.get(t.table.toUpperCase());
          return !!want && (!want.size || t.crud.some((x) => want.has(x)));
        }),
      );
    }
    if (!use.length) use = cands;
    for (const s of use) screens.set(s.id, s);
  }
  const named = (k: string) => model.tableByKey.get(k)?.name ?? k;
  const idx = new Map(model.r.screens.map((s, i) => [s.id, i]));
  const order = (s: ScreenResult) => idx.get(s.id) ?? 1e9;
  return {
    screens: [...screens.values()].sort((a, b) => order(a) - order(b)),
    tables: [...tables.entries()].map(([k, s]) => ({ name: named(k), crud: CRUD_ORDER.filter((x) => s.has(x)) })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function screenKey(s: ScreenResult): string {
  return `${s.kind}:${s.url ?? s.name}`;
}

/** 다시 분석 전후로 영향 화면의 테이블 연결이 바뀌었는지 한 줄로 */
export function linkSummary(before: AnalysisResult | null, after: AnalysisResult | null, impact: Impact | null): string {
  if (!after) return '다시 분석하지 못함';
  if (!before) return '분석 결과를 새로 만듦';
  const bMap = new Map(before.screens.map((s) => [screenKey(s), s]));
  const aMap = new Map(after.screens.map((s) => [screenKey(s), s]));
  const diffs: string[] = [];
  for (const s of impact?.screens ?? []) {
    const k = screenKey(s);
    const b = bMap.get(k);
    const a = aMap.get(k);
    if (b && !a) {
      diffs.push(`${b.name} 화면을 찾지 못함`);
      continue;
    }
    if (!b || !a) continue;
    const bt = new Map(b.tables.map((t) => [t.table.toUpperCase(), new Set(t.crud)]));
    const at = new Map(a.tables.map((t) => [t.table.toUpperCase(), new Set(t.crud)]));
    for (const t of new Set([...bt.keys(), ...at.keys()])) {
      const x = bt.get(t) ?? new Set<Crud>();
      const y = at.get(t) ?? new Set<Crud>();
      const plus = CRUD_ORDER.filter((c) => y.has(c) && !x.has(c));
      const minus = CRUD_ORDER.filter((c) => x.has(c) && !y.has(c));
      if (plus.length) diffs.push(`${a.name}에 ${t} ${plus.join('')} 추가`);
      if (minus.length) diffs.push(`${a.name}에서 ${t} ${minus.join('')} 빠짐`);
    }
  }
  if (before.screens.length !== after.screens.length) diffs.push(`화면 ${before.screens.length}→${after.screens.length}개`);
  if (before.tables.length !== after.tables.length) diffs.push(`테이블 ${before.tables.length}→${after.tables.length}개`);
  if (diffs.length) return diffs.length > 3 ? `${diffs.slice(0, 3).join(' · ')} 외 ${diffs.length - 3}건` : diffs.join(' · ');
  if (impact?.screens.length && impact.tables.length) {
    const names = impact.screens.slice(0, 3).map((s) => s.name).join('·');
    const tabs = impact.tables.slice(0, 2).map((t) => `${t.name} 사용${t.crud.length ? `(${t.crud.join('')})` : ''}`).join('·');
    return `${names}${impact.screens.length > 3 ? ` 외 ${impact.screens.length - 3}개` : ''}의 ${tabs}은 그대로 · 바뀐 연결 없음`;
  }
  return '바뀐 연결 없음';
}

/** 경로 비교 (Windows는 대소문자 무시) */
export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const x = n(a);
  const y = n(b);
  return /^[A-Za-z]:/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}
