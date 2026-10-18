// SCR-11 새 프로젝트의 글 읽기: Claude 답변에서 요구사항·계획 찾기, 계획 항목 진행 표시, 참고 결과 요약.
// 화면(NewProject.tsx)과 시험(test/claude-ui.test.ts)이 함께 쓴다.
import type { AnalysisResult } from '../../../engine/types';
import { summaryText } from './context';
import { listItemsOf, sectionsOf } from './markdown';

export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s;
}

/** 참고 결과의 기술 구성 한 줄 (Java · JSP · Oracle · MyBatis) */
export function techLine(r: AnalysisResult): string {
  const langs = r.languages.filter((l) => l.name !== 'Other' && l.ratio >= 0.05).slice(0, 3).map((l) => l.name);
  const db = r.databases[0];
  const parts: string[] = [...langs];
  if (db) parts.push(db.type, ...db.access.slice(0, 1).map((a) => a.replace(/\s*\(.*\)$/, '').replace(/ 매퍼$/, '')));
  return [...new Set(parts)].join(' · ');
}

/** 참고 결과 요약: 시스템 요약 + 폴더 구조·이름 규칙 예 (Claude가 '같은 구조로' 만들 때 씀) */
export function referenceText(r: AnalysisResult, root?: string): string {
  const byLayer = new Map<string, string[]>();
  for (const f of r.files) {
    if (f.excluded) continue;
    const arr = byLayer.get(f.layer) ?? [];
    if (arr.length < 4) arr.push(f.path);
    byLayer.set(f.layer, arr);
  }
  const layers = ['CONFIG', 'VIEW', 'SCRIPT', 'CONTROLLER', 'SERVICE', 'DAO', 'MAPPER', 'MODEL', 'DDL', 'MENU_DATA'];
  const files = layers.filter((l) => byLayer.has(l)).map((l) => `- ${l}: ${byLayer.get(l)!.join(', ')}`);
  const common = r.tables.filter((t) => t.common).slice(0, 10).map((t) => `${t.name}${t.comment ? `(${t.comment})` : ''}`);
  const names = r.tables.slice(0, 12).map((t) => t.name);
  return [
    summaryText(r),
    root ? `원본 폴더(읽기만): ${root}` : '',
    files.length ? `폴더 구조 예:\n${files.join('\n')}` : '',
    names.length ? `테이블 이름 예: ${names.join(', ')}` : '',
    common.length ? `공통 테이블: ${common.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface PlanItem {
  title: string;
  sub: string;
}

export interface Plan {
  reqs: string[];
  items: PlanItem[];
  total?: number;
}

const REQ_T = /요구/;
const PLAN_T = /계획|구성|만들 것|생성 목록/;

export function splitPlanItem(s: string): PlanItem {
  const b = s.match(/^\*\*([^*]+)\*\*\s*[—–\-:：·]?\s*(.*)$/);
  if (b) return { title: b[1].trim(), sub: b[2].replace(/\*\*/g, '').trim() };
  const clean = s.replace(/\*\*/g, '');
  const m = clean.match(/^(.+?)\s+[—–-]\s+(.+)$/) ?? clean.match(/^(.+?)[:：]\s+(.+)$/);
  return m ? { title: m[1].trim(), sub: m[2].trim() } : { title: clean.trim(), sub: '' };
}

export function parsePlan(text: string): Plan | null {
  const secs = sectionsOf(text);
  const req = secs.find((s) => REQ_T.test(s.title));
  const plan = secs.find((s) => PLAN_T.test(s.title) && !REQ_T.test(s.title));
  if (!req && !plan) return null;
  const reqs = req ? listItemsOf(req.body).map((x) => x.replace(/\*\*/g, '')) : [];
  const items = plan ? listItemsOf(plan.body).map(splitPlanItem) : [];
  if (!reqs.length && !items.length) return null;
  const tm = text.match(/파일\s*([\d,]+)\s*개/);
  return { reqs, items, total: tm ? Number(tm[1].replace(/,/g, '')) : undefined };
}

/** 계획·요구사항 부분을 뺀 답변 (그 부분은 왼쪽 카드에 보임) */
export function stripPlan(text: string): string {
  const secs = sectionsOf(text);
  if (!secs.some((s) => REQ_T.test(s.title) || PLAN_T.test(s.title))) return text;
  return secs
    .filter((s) => !s.title || !(REQ_T.test(s.title) || PLAN_T.test(s.title)))
    .map((s) => (s.title ? `### ${s.title}\n${s.body.join('\n')}` : s.body.join('\n')))
    .join('\n')
    .trim();
}

export type Cat = 'config' | 'table' | 'source' | 'view' | 'data' | 'check' | null;

const CAT_RULES: [Exclude<Cat, null>, RegExp][] = [
  ['config', /기본\s*구성|설정|환경|pom|gradle/i],
  ['table', /테이블|DDL|스키마/i],
  ['source', /소스|VO|Mapper|Service|Controller|클래스|자바/i],
  ['view', /화면|JSP|페이지|뷰/i],
  ['data', /메뉴|코드\s*데이터|데이터|초기/i],
  ['check', /컴파일|빌드|테스트|확인/i],
];

export function itemCat(p: PlanItem): Cat {
  for (const [c, re] of CAT_RULES) if (re.test(p.title)) return c;
  for (const [c, re] of CAT_RULES) if (re.test(p.sub)) return c;
  return null;
}

export function fileCat(path: string): Cat {
  const n = baseName(path).toLowerCase();
  if (/\.(jsp|jspf|html?|vue|css)$/.test(n)) return 'view';
  if (/\.sql$/.test(n)) return /(data|menu|code|insert|init)/.test(n) ? 'data' : 'table';
  if (/^(pom\.xml|build\.gradle|settings\.gradle|web\.xml)$/.test(n) || /^context[-\w]*\.xml$/.test(n) || /\.(properties|ya?ml)$/.test(n)) return 'config';
  if (/\.(java|js|ts|kt|xml|tsx|jsx)$/.test(n)) return 'source';
  return null;
}

export type ItemState = 'done' | 'run' | 'wait';

export function planStates(plan: Plan, created: string[], generating: boolean, finished: boolean): { state: ItemState; right?: string }[] {
  const counts = new Map<Cat, number>();
  for (const f of created) {
    const c = fileCat(f);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const cats = plan.items.map(itemCat);
  const cnt = cats.map((c) => (c && c !== 'check' ? counts.get(c) ?? 0 : 0));
  let runGiven = false;
  return plan.items.map((it, i) => {
    if (finished) return { state: 'done' };
    const need = Number(it.title.match(/(\d+)\s*개/)?.[1] ?? 0);
    const later = cnt.slice(i + 1).some((n) => n > 0);
    const done = later || (need > 0 && cats[i] !== 'table' && cnt[i] >= need);
    if (done) return { state: 'done' };
    if (generating && !runGiven) {
      runGiven = true;
      return { state: 'run', right: need && cats[i] !== 'table' ? `${cnt[i]} / ${need}` : undefined };
    }
    return { state: 'wait' };
  });
}
