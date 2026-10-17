// 결과(AnalysisResult)를 화면에서 쓰기 좋게 색인한다.
import type {
  AnalysisResult, BatchResult, Crud, FileInfo, MenuResult, ScreenResult, SqlFact, TableResult,
} from '../engine/types';

export type Target =
  | { kind: 'summary' }
  | { kind: 'table'; id: string }
  | { kind: 'screen'; id: string }
  | { kind: 'menu'; id: string }
  | { kind: 'batch'; id: string };

export interface FileUsage {
  screens: Set<string>;
  batches: Set<string>;
  tables: Map<string, Set<Crud>>;
}

export interface Model {
  r: AnalysisResult;
  fileById: Map<string, FileInfo>;
  fileByPath: Map<string, FileInfo>;
  tableById: Map<string, TableResult>;
  tableByKey: Map<string, TableResult>;
  screenById: Map<string, ScreenResult>;
  menuById: Map<string, MenuResult>;
  batchById: Map<string, BatchResult>;
  menuChildren: Map<string, MenuResult[]>;
  rootMenus: MenuResult[];
  screenGroups: { group: string; label: string; screens: ScreenResult[] }[];
  batchGroups: { group: string; screens: BatchResult[] }[];
  sqlByTable: Map<string, SqlFact[]>;
  fileUsage: Map<string, FileUsage>;
  /** 소스 뷰어에서 강조할 테이블 이름 (대문자 키 → 테이블) */
  tableNames: string[];
}

const GROUP_WORDS: Record<string, string> = {
  order: '주문', orders: '주문', ord: '주문', user: '회원', users: '회원', member: '회원', mbr: '회원', cust: '고객', customer: '고객',
  product: '상품', products: '상품', goods: '상품', item: '상품', items: '상품', settle: '정산', settlement: '정산', calc: '정산',
  system: '시스템', sys: '시스템', admin: '관리자', common: '공통', cmm: '공통', com: '공통', board: '게시판', bbs: '게시판',
  notice: '공지', main: '메인', login: '로그인', auth: '권한', code: '코드', menu: '메뉴', stat: '통계', stats: '통계',
  statistics: '통계', dlvy: '배송', delivery: '배송', ship: '배송', pay: '결제', payment: '결제', coupon: '쿠폰', cpn: '쿠폰',
  cart: '장바구니', event: '이벤트', banner: '배너', faq: 'FAQ', qna: '문의', inquiry: '문의', api: 'API', mypage: '마이페이지',
  dept: '부서', emp: '직원', hr: '인사', approval: '결재', file: '파일', attach: '첨부', log: '로그', report: '보고서',
  stock: '재고', inventory: '재고', claim: '클레임', review: '리뷰', point: '포인트', category: '분류', config: '설정',
};

export function groupLabel(group: string, menuName?: string): string {
  const w = group.replace(/^\//, '').split('/')[0].toLowerCase();
  if (menuName) return menuName.replace(/\s*(관리|메뉴)$/, '') || menuName;
  return GROUP_WORDS[w] ?? '';
}

export function buildModel(r: AnalysisResult): Model {
  const fileById = new Map(r.files.map((f) => [f.id, f]));
  const fileByPath = new Map(r.files.map((f) => [f.path, f]));
  const tableById = new Map(r.tables.map((t) => [t.id, t]));
  const tableByKey = new Map(r.tables.map((t) => [t.name.toUpperCase(), t]));
  const screenById = new Map(r.screens.map((s) => [s.id, s]));
  const menuById = new Map(r.menus.map((m) => [m.id, m]));
  const batchById = new Map(r.batches.map((b) => [b.id, b]));

  const menuChildren = new Map<string, MenuResult[]>();
  const rootMenus: MenuResult[] = [];
  for (const m of r.menus) {
    if (m.parent && menuById.has(m.parent)) {
      const arr = menuChildren.get(m.parent) ?? [];
      arr.push(m);
      menuChildren.set(m.parent, arr);
    } else rootMenus.push(m);
  }
  const byOrder = (a: MenuResult, b: MenuResult) => (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name, 'ko');
  rootMenus.sort(byOrder);
  for (const arr of menuChildren.values()) arr.sort(byOrder);

  // 화면 그룹: 그룹 안 화면이 속한 최상위 메뉴 이름을 라벨로
  const rootOf = (id?: string): MenuResult | undefined => {
    let m = id ? menuById.get(id) : undefined;
    let guard = 0;
    while (m?.parent && menuById.has(m.parent) && guard++ < 20) m = menuById.get(m.parent);
    return m;
  };
  const groups = new Map<string, ScreenResult[]>();
  for (const s of r.screens) {
    const g = s.group || '(기타)';
    const arr = groups.get(g) ?? [];
    arr.push(s);
    groups.set(g, arr);
  }
  const screenGroups = [...groups.entries()]
    .map(([group, screens]) => {
      const votes = new Map<string, number>();
      for (const s of screens) {
        const root = rootOf(s.menu);
        if (root) votes.set(root.name, (votes.get(root.name) ?? 0) + 1);
      }
      const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      screens.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'page' ? -1 : 1) || (a.url ?? a.name).localeCompare(b.url ?? b.name));
      return { group, label: groupLabel(group, top), screens };
    })
    .sort((a, b) => a.group.localeCompare(b.group));

  const bg = new Map<string, BatchResult[]>();
  for (const b of r.batches) {
    const arr = bg.get(b.group || '배치') ?? [];
    arr.push(b);
    bg.set(b.group || '배치', arr);
  }
  const batchGroups = [...bg.entries()].map(([group, screens]) => ({ group, screens })).sort((a, b) => a.group.localeCompare(b.group));

  const sqlByTable = new Map<string, SqlFact[]>();
  for (const q of r.sql) {
    for (const t of q.tables) {
      const k = t.name.toUpperCase();
      const arr = sqlByTable.get(k) ?? [];
      if (!arr.includes(q)) arr.push(q);
      sqlByTable.set(k, arr);
    }
  }

  const fileUsage = new Map<string, FileUsage>();
  const use = (fid: string) => {
    let u = fileUsage.get(fid);
    if (!u) {
      u = { screens: new Set(), batches: new Set(), tables: new Map() };
      fileUsage.set(fid, u);
    }
    return u;
  };
  for (const s of r.screens) for (const f of s.files) use(f.file).screens.add(s.id);
  for (const b of r.batches) for (const f of b.files) use(f).batches.add(b.id);
  for (const q of r.sql) {
    const u = use(q.file);
    for (const t of q.tables) {
      const k = t.name.toUpperCase();
      const set = u.tables.get(k) ?? new Set<Crud>();
      set.add(t.crud);
      u.tables.set(k, set);
    }
  }
  for (const t of r.tables) if (t.ddl) {
    const u = use(t.ddl.file);
    if (!u.tables.has(t.name.toUpperCase())) u.tables.set(t.name.toUpperCase(), new Set());
  }

  const tableNames = r.tables.map((t) => t.name).filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);

  return {
    r, fileById, fileByPath, tableById, tableByKey, screenById, menuById, batchById, menuChildren, rootMenus,
    screenGroups, batchGroups, sqlByTable, fileUsage, tableNames,
  };
}

export function tableOf(m: Model, name: string): TableResult | undefined {
  return m.tableByKey.get(name.toUpperCase());
}

/** 메뉴 경로 (상위 › 하위) */
export function menuPath(m: Model, id?: string): MenuResult[] {
  const out: MenuResult[] = [];
  let cur = id ? m.menuById.get(id) : undefined;
  let guard = 0;
  while (cur && guard++ < 20) {
    out.unshift(cur);
    cur = cur.parent ? m.menuById.get(cur.parent) : undefined;
  }
  return out;
}

/** 메뉴와 하위 메뉴 전체의 화면 */
export function menuScreens(m: Model, id: string): ScreenResult[] {
  const out = new Map<string, ScreenResult>();
  const walk = (mid: string, depth: number) => {
    if (depth > 20) return;
    const menu = m.menuById.get(mid);
    if (!menu) return;
    for (const sid of menu.screens) {
      const s = m.screenById.get(sid);
      if (s) out.set(s.id, s);
    }
    for (const c of m.menuChildren.get(mid) ?? []) walk(c.id, depth + 1);
  };
  walk(id, 0);
  return [...out.values()];
}

export function crudList(set: Iterable<Crud>): Crud[] {
  const s = new Set(set);
  return (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => s.has(c));
}

export function menuDepthLabel(depth: number): string {
  return depth <= 1 ? '대메뉴' : depth === 2 ? '중메뉴' : '하위 메뉴';
}

export const SOURCE_LABEL: Record<MenuResult['source'], string> = {
  db: 'DB 메뉴 테이블',
  'data-file': '메뉴 데이터 파일',
  config: '메뉴 설정 파일',
  code: '화면 코드(사이드바)',
  'url-guess': 'URL 추정',
};
