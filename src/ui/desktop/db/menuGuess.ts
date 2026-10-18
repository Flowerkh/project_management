// 메뉴 테이블 추천 (순수 함수): 분석 결과의 테이블 DDL·SQL에서 이름에 MENU가 들어간 테이블과 컬럼을 찾고,
// 컬럼 이름으로 ID·상위 ID·이름·URL·순서를 짐작한다 (전자정부 표준프레임워크 COMTNMENUINFO 등).
import type { AnalysisResult } from '../../../engine/types';
import type { MenuDbSetting } from '../../../shared/desktop-api';

const IDENT = /^[A-Za-z0-9_$#.]+$/;

export interface MenuTableGuess {
  table: string;
  columns: string[];
}

/** 분석 결과에서 이름에 MENU가 들어간 테이블과 컬럼 (DDL 컬럼 + SQL에 나온 컬럼) */
export function menuTables(r: AnalysisResult | null | undefined): MenuTableGuess[] {
  if (!r) return [];
  const m = new Map<string, string[]>();
  const add = (t: string, cols: string[]) => {
    const key = t.toUpperCase();
    const cur = m.get(key) ?? [];
    for (const c of cols) if (c && IDENT.test(c) && !cur.includes(c.toUpperCase())) cur.push(c.toUpperCase());
    m.set(key, cur);
  };
  for (const t of r.tables ?? []) if (/MENU/i.test(t.name)) add(t.name, (t.columns ?? []).map((c) => c.name));
  for (const q of r.sql ?? []) {
    const targets = (q.tables ?? []).map((t) => t.name).filter((n) => /MENU/i.test(n));
    if (!targets.length) continue;
    const ins = q.text.match(/INSERT\s+INTO\s+([\w.$#]+)\s*\(([^)]*)\)/i);
    if (ins && /MENU/i.test(ins[1])) add(ins[1].split('.').pop() ?? ins[1], ins[2].split(',').map((s) => s.trim().replace(/["`]/g, '')));
    const sel = q.text.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([\w.$#]+)/i);
    if (sel && /MENU/i.test(sel[2])) {
      const cols = sel[1].split(',').map((s) => s.trim().split(/\s+/)[0].split('.').pop() ?? '').filter((s) => IDENT.test(s));
      add(sel[2].split('.').pop() ?? sel[2], cols);
    }
    for (const t of targets) if (!m.has(t.toUpperCase())) add(t, []);
  }
  return [...m.entries()]
    .map(([table, columns]) => ({ table, columns }))
    .sort((a, b) => b.columns.length - a.columns.length || a.table.length - b.table.length)
    .slice(0, 6);
}

/** 컬럼 이름으로 ID·상위 ID·이름·URL·순서 짐작 */
export function guessColumns(cols: string[]): Pick<MenuDbSetting, 'idCol' | 'parentCol' | 'nameCol' | 'urlCol' | 'orderCol'> {
  const used = new Set<string>();
  const pick = (re: RegExp, not?: RegExp) => {
    const c = cols.find((x) => !used.has(x) && re.test(x) && !(not && not.test(x)));
    if (c) used.add(c);
    return c ?? '';
  };
  const parentCol = pick(/(UPPER|PARENT|PRNT|PRT_|^UP_|_UP_|HIGH|HGH|UPR)/i);
  const idCol = pick(/^(MENU_?)?(ID|NO|CD|SN|SEQ|KEY)$/i) || pick(/(_ID|_NO|_CD|_SN)$/i, /(UPPER|PARENT|PRNT|REG|UPD|USER|PROGRM|PROG)/i);
  const notImg = /(IMAGE|IMG|ICON|THUMB)/i;
  const urlCol = pick(/(URL|URI)/i, notImg) || pick(/LINK/i, notImg) || pick(/(PROGRM|PROGRAM|PGM)/i, notImg) || pick(/PATH/i, notImg);
  const nameCol = pick(/^(MENU_?)?(NM|NAME|TITLE)$/i) || pick(/(_NM|_NAME|TITLE)$/i, notImg);
  const orderCol = pick(/(ORDR|ORDER|SORT|_ORD$|^ORD|SEQ|SN$)/i);
  return { idCol, parentCol, nameCol, urlCol, orderCol };
}

