// 사실(Facts)을 이어 화면·테이블·메뉴·배치 결과를 만든다.
// 화면 → (렌더링 메서드 + 화면이 부르는 URL) → 컨트롤러 → 서비스 → DAO → 매퍼 SQL → 테이블
import type {
  BatchResult, CodeUnit, Confidence, Crud, Evidence, Facts, FileInfo, FlowStep, Issue, Layer, MenuFact, MenuResult,
  MethodUnit, Route, ScreenResult, SqlFact, TableResult, ViewFact,
} from './types';
import { baseName, dirName } from './files';
import { mergeCrud, tableKey } from './sql';
import { batchRole, nameFromPath, screenRole, shortTableName, tableRole, translate } from './roles';

interface MRef {
  unit: CodeUnit;
  m: MethodUnit;
}

interface TableUse {
  name: string;
  crud: Set<Crud>;
  estimated: boolean;
}

interface Reach {
  tables: Map<string, TableUse>;
  steps: FlowStep[];
  files: Map<string, Layer>;
  sql: Set<string>;
}

const LAYER_OF_KIND: Record<CodeUnit['kind'], Layer> = {
  controller: 'CONTROLLER', service: 'SERVICE', dao: 'DAO', repository: 'DAO', mapper: 'MAPPER', model: 'MODEL', job: 'BATCH', other: 'OTHER',
};

function emptyReach(): Reach {
  return { tables: new Map(), steps: [], files: new Map(), sql: new Set() };
}

function addTables(r: Reach, sql: SqlFact): void {
  r.sql.add(sql.id);
  for (const t of sql.tables) {
    const k = tableKey(t.name);
    let u = r.tables.get(k);
    if (!u) {
      u = { name: t.name, crud: new Set(), estimated: !!t.estimated };
      r.tables.set(k, u);
    }
    u.crud.add(t.crud);
    if (!t.estimated) u.estimated = false;
  }
}

function mergeReach(into: Reach, from: Reach): void {
  for (const [k, v] of from.tables) {
    let u = into.tables.get(k);
    if (!u) {
      u = { name: v.name, crud: new Set(), estimated: v.estimated };
      into.tables.set(k, u);
    }
    v.crud.forEach((c) => u!.crud.add(c));
    if (!v.estimated) u.estimated = false;
  }
  for (const [f, l] of from.files) if (!into.files.has(f)) into.files.set(f, l);
  from.sql.forEach((s) => into.sql.add(s));
}

/** URL 정규화: 호스트·쿼리·해시 제거, 끝 / 제거, 소문자 */
export function normUrl(u: string): string {
  let s = u.trim();
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s.toLowerCase();
}

/** 라우트 경로 → 정규식 ({id}, :id, <id>, * 를 경로 조각 하나로) */
function routeRegex(path: string): RegExp | null {
  const p = normUrl(path);
  if (!/[{:<*]/.test(p)) return null;
  const esc = p
    .split('/')
    .map((seg) => {
      if (/^\{[^}]+\}$/.test(seg) || /^:[\w]+\??$/.test(seg) || /^<[^>]+>$/.test(seg) || seg === '*') return '[^/]+';
      if (seg === '**') return '.*';
      return seg.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\\?\*/g, '[^/]*').replace(/\{[^}]+\}/g, '[^/]+');
    })
    .join('/');
  return new RegExp(`^${esc}$`);
}

function confidenceOf(score: number): Confidence {
  return score >= 2 ? '높음' : score >= 1 ? '보통' : '낮음';
}

export interface Linked {
  tables: TableResult[];
  screens: ScreenResult[];
  menus: MenuResult[];
  batches: BatchResult[];
  issues: Issue[];
}

export function link(facts: Facts): Linked {
  const fileById = new Map(facts.files.map((f) => [f.id, f] as const));
  const fileByPath = new Map(facts.files.map((f) => [f.path, f] as const));

  // ------------------------------------------------------------ 색인
  const unitsByName = new Map<string, CodeUnit[]>();
  const unitsByFqn = new Map<string, CodeUnit>();
  const unitsByBean = new Map<string, CodeUnit[]>();
  const implementors = new Map<string, CodeUnit[]>();
  const methodIndex = new Map<string, MRef[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  for (const u of facts.units) {
    push(unitsByName, u.name.toLowerCase(), u);
    if (u.fqn) unitsByFqn.set(u.fqn.toLowerCase(), u);
    if (u.beanName) push(unitsByBean, u.beanName.toLowerCase(), u);
    for (const sup of u.extendsOrImplements) push(implementors, simple(sup).toLowerCase(), u);
    if (u.kind !== 'controller') for (const m of u.methods) push(methodIndex, m.name.toLowerCase(), { unit: u, m });
  }
  const sqlById = new Map(facts.sql.map((s) => [s.id, s] as const));
  const sqlByFull = new Map<string, SqlFact[]>();
  const sqlByShort = new Map<string, SqlFact[]>();
  const sqlByFile = new Map<string, SqlFact[]>();
  for (const s of facts.sql) {
    push(sqlByFile, s.file, s);
    if (!s.stmtId) continue;
    if (s.namespace) push(sqlByFull, `${s.namespace}.${s.stmtId}`.toLowerCase(), s);
    push(sqlByShort, s.stmtId.toLowerCase(), s);
  }

  // ------------------------------------------------------------ 호출 따라가기
  function simple(t: string): string {
    const g = t.replace(/<.*$/, '').replace(/\[\]$/, '');
    return g.slice(g.lastIndexOf('.') + 1).replace(/^\\?.*\\/, '');
  }

  function targetsOf(unit: CodeUnit, via: string): CodeUnit[] {
    const v = via.replace(/^(this\.|\$this->|self::|static::|parent::)/, '').replace(/\(\)$/, '');
    const last = v.split(/\.|->|::/).filter(Boolean).pop() ?? v;
    const type = unit.fields[last] ?? unit.fields[v];
    const names = new Set<string>();
    if (type) names.add(simple(type).toLowerCase());
    names.add(simple(last).toLowerCase());
    const out = new Set<CodeUnit>();
    for (const n of names) {
      for (const u of unitsByName.get(n) ?? []) out.add(u);
      for (const u of implementors.get(n) ?? []) out.add(u);
      for (const u of unitsByBean.get(n) ?? []) out.add(u);
    }
    if (type) {
      const fq = unitsByFqn.get(type.toLowerCase());
      if (fq) out.add(fq);
    }
    // 인터페이스 타입이면 구현체도
    for (const u of [...out]) for (const impl of implementors.get(u.name.toLowerCase()) ?? []) out.add(impl);
    return [...out];
  }

  const memo = new Map<string, Reach>();
  function reach(unit: CodeUnit, m: MethodUnit, depth = 0, stack = new Set<string>()): Reach {
    const key = `${unit.id}#${m.name}#${m.line}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const r = emptyReach();
    if (stack.has(key) || depth > 8) return r;
    stack.add(key);
    r.files.set(unit.file, LAYER_OF_KIND[unit.kind]);
    r.steps.push({ layer: LAYER_OF_KIND[unit.kind], file: unit.file, symbol: `${unit.name}.${m.name}()`, line: m.line });
    let childSteps: FlowStep[] = [];
    for (const id of m.sql) {
      const s = sqlById.get(id);
      if (s) {
        addTables(r, s);
        if (!childSteps.length && s.tables.length) childSteps = sqlSteps(s);
      }
    }
    const stmtNames = [...m.statements];
    if (unit.kind === 'mapper') {
      if (unit.fqn) stmtNames.push(`${unit.fqn}.${m.name}`);
      stmtNames.push(`${unit.name}.${m.name}`);
    }
    for (const st of stmtNames) {
      const hits = sqlByFull.get(st.toLowerCase()) ?? sqlByShort.get(st.slice(st.lastIndexOf('.') + 1).toLowerCase()) ?? [];
      // 짧은 id로만 찾았고 후보가 여럿이면 namespace 꼬리로 거르기
      let chosen = hits;
      if (!sqlByFull.has(st.toLowerCase()) && hits.length > 1) {
        const ns = st.includes('.') ? st.slice(0, st.lastIndexOf('.')).toLowerCase() : '';
        const f = hits.filter((h) => (h.namespace ?? '').toLowerCase().endsWith(ns));
        if (f.length) chosen = f;
      }
      for (const s of chosen) {
        addTables(r, s);
        r.files.set(s.file, 'MAPPER');
        if (!childSteps.length) childSteps = sqlSteps(s);
      }
    }
    for (const c of m.calls) {
      // 분석기가 대상 유닛을 정확히 안 호출(via = 그 유닛의 fqn)은 이름 추측 없이 그 유닛만
      const exact = c.via ? unitsByFqn.get(c.via.replace(/^this\./, '').toLowerCase()) : undefined;
      let targets = exact ? [exact] : targetsOf(unit, c.via).filter((t) => t.id !== unit.id || c.via.startsWith('this'));
      let methods: MRef[] = [];
      for (const t of targets) for (const tm of t.methods) if (tm.name === c.method) methods.push({ unit: t, m: tm });
      if (!methods.length && !targets.length) {
        // 타입 정보가 없을 때: 메서드 이름이 하나뿐이면 그것으로
        const cand = (methodIndex.get(c.method.toLowerCase()) ?? []).filter((x) => x.unit.id !== unit.id);
        const units = new Set(cand.map((x) => x.unit.id));
        if (units.size === 1 && c.method.length >= 5) methods = cand;
      }
      if (unit.kind === 'controller' && !exact) methods = methods.filter((x) => x.unit.kind !== 'controller' || x.unit.id === unit.id);
      for (const x of methods) {
        const sub = reach(x.unit, x.m, depth + 1, stack);
        mergeReach(r, sub);
        if (!childSteps.length && sub.tables.size) childSteps = sub.steps;
      }
      targets = [];
    }
    if (childSteps.length) r.steps.push(...childSteps);
    stack.delete(key);
    memo.set(key, r);
    return r;
  }

  function sqlSteps(s: SqlFact): FlowStep[] {
    const f = fileById.get(s.file);
    const steps: FlowStep[] = [{ layer: s.origin === 'mybatis' || s.origin === 'ibatis' ? 'MAPPER' : f?.layer ?? 'OTHER', file: s.file, symbol: s.stmtId ? `${s.stmtId}` : `${f?.name ?? ''}:${s.line}`, line: s.line }];
    for (const t of s.tables.slice(0, 4)) {
      if (!steps.some((x) => x.layer === 'TABLE' && x.symbol === t.name)) steps.push({ layer: 'TABLE', symbol: t.name });
    }
    return steps;
  }

  // ------------------------------------------------------------ 라우트
  interface RouteRef extends MRef {
    route: Route;
    re: RegExp | null;
    norm: string;
  }
  const routes: RouteRef[] = [];
  for (const u of facts.units) {
    for (const m of u.methods) {
      for (const r of m.routes) routes.push({ unit: u, m, route: r, re: routeRegex(r.path), norm: normUrl(r.path) });
    }
  }
  const routeExact = new Map<string, RouteRef[]>();
  for (const r of routes) push(routeExact, r.norm, r);
  function matchRoutes(url: string, method?: string): RouteRef[] {
    const n = normUrl(url);
    let hits = routeExact.get(n) ?? [];
    if (!hits.length) hits = routes.filter((r) => r.re?.test(n));
    if (!hits.length && /\.(do|action|php|jsp)$/.test(n)) {
      const noExt = n.replace(/\.(do|action)$/, '');
      hits = routeExact.get(noExt) ?? [];
    }
    if (method && hits.length > 1) {
      const mm = hits.filter((h) => h.route.method === '*' || h.route.method.toUpperCase() === method.toUpperCase());
      if (mm.length) hits = mm;
    }
    return hits;
  }

  // ------------------------------------------------------------ 뷰 이름 → 화면 파일
  const viewByFile = new Map(facts.views.map((v) => [v.file, v] as const));
  const viewFiles = facts.views.map((v) => ({ v, path: fileById.get(v.file)?.path ?? '' }));
  const VIEW_EXT = ['.jsp', '.blade.php', '.php', '.html', '.htm', '.tmpl', '.gohtml', '.twig', '.tpl', '.ftl', '.vm', '.jspf'];
  const viewCache = new Map<string, ViewFact | null>();
  function resolveView(name: string): ViewFact | null {
    const key = name;
    if (viewCache.has(key)) return viewCache.get(key)!;
    let found: ViewFact | null = null;
    const clean = name.replace(/^redirect:|^forward:/, '').replace(/^\/+/, '');
    const cands: string[] = [];
    for (const vr of facts.viewResolvers) {
      if (vr.definitions?.[clean]) cands.push(vr.definitions[clean].replace(/^\/+/, ''));
      for (const [pat, target] of Object.entries(vr.definitions ?? {})) {
        if (!pat.includes('*')) continue;
        const re = new RegExp(`^${pat.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*?)')}$`);
        const mm = re.exec(clean);
        if (mm) cands.push(target.replace(/\{(\d+)\}/g, (_, n) => mm[Number(n)] ?? '').replace(/^\/+/, ''));
      }
      if (vr.prefix || vr.suffix) cands.push(`${vr.prefix}${clean}${vr.suffix}`.replace(/^\/+/, ''));
    }
    for (const c of cands) {
      const hit = viewFiles.filter((x) => x.path === c || x.path.endsWith(`/${c}`));
      if (hit.length) {
        found = hit.sort((a, b) => a.path.length - b.path.length)[0].v;
        break;
      }
    }
    if (!found) {
      const variants = [clean, clean.replace(/\./g, '/')];
      for (const vname of variants) {
        const hit = viewFiles.filter((x) => VIEW_EXT.some((e) => x.path.endsWith(`/${vname}${e}`) || x.path === `${vname}${e}`));
        if (hit.length) {
          found = hit.sort((a, b) => a.path.length - b.path.length)[0].v;
          break;
        }
        // 확장자까지 적힌 이름 (Go: "orders/list.html")
        const hit2 = viewFiles.filter((x) => x.path === vname || x.path.endsWith(`/${vname}`));
        if (hit2.length) {
          found = hit2.sort((a, b) => a.path.length - b.path.length)[0].v;
          break;
        }
      }
    }
    viewCache.set(key, found);
    return found;
  }

  // 메서드가 돌려주는 화면
  const renderers = new Map<string, MRef[]>(); // 화면 파일 ID → 렌더링 메서드
  for (const u of facts.units) {
    for (const m of u.methods) {
      for (const vn of m.views) {
        const v = resolveView(vn);
        if (v) push(renderers, v.file, { unit: u, m });
      }
    }
  }

  // include 횟수: 여러 화면에 붙는 조각(공통 레이아웃)은 URL을 화면에 붙이지 않는다
  const includeCount = new Map<string, number>();
  const viewByPath = new Map<string, ViewFact>();
  for (const v of facts.views) {
    const p = fileById.get(v.file)?.path;
    if (p) viewByPath.set(p, v);
  }
  for (const v of facts.views) for (const inc of [...v.includes, ...v.scripts]) includeCount.set(inc, (includeCount.get(inc) ?? 0) + 1);
  const viewCount = facts.views.filter((v) => !v.fragment).length;
  const commonLimit = Math.max(3, Math.ceil(viewCount * 0.2));

  function findByPath(p: string): FileInfo | undefined {
    return fileByPath.get(p) ?? [...fileByPath.values()].find((f) => f.path.endsWith(`/${p.replace(/^\/+/, '')}`));
  }

  // ------------------------------------------------------------ 화면
  const screens: ScreenResult[] = [];
  const screenOfRoute = new Map<RouteRef, ScreenResult>();
  const referencedRoutes = new Set<RouteRef>();
  const unresolvedUrls = new Map<string, { file: string; line: number }>();
  let sseq = 0;
  const nextScreenId = () => `S${String(++sseq).padStart(3, '0')}`;

  function tableList(r: Reach): ScreenResult['tables'] {
    return [...r.tables.values()]
      .map((t) => ({ table: t.name, crud: mergeCrud([...t.crud]) }))
      .sort((a, b) => a.table.localeCompare(b.table));
  }

  const pageViews = facts.views.filter((v) => !v.fragment);
  for (const v of pageViews) {
    const f = fileById.get(v.file);
    if (!f) continue;
    const rend = renderers.get(v.file) ?? [];
    const total = emptyReach();
    const files = new Map<string, { layer: Layer; note?: string }>();
    files.set(v.file, { layer: 'VIEW' });
    const evidence: Evidence[] = [];
    if (v.titleLine) evidence.push({ file: v.file, line: v.titleLine, text: v.title });
    const urls: string[] = [];
    let flow: FlowStep[] = [{ layer: 'VIEW', file: v.file, symbol: f.name }];
    let score = 0;
    for (const r of rend) {
      const rr = reach(r.unit, r.m);
      mergeReach(total, rr);
      for (const rt of r.m.routes) {
        if (!urls.includes(rt.path)) urls.push(rt.path);
        const ref = routes.find((x) => x.unit === r.unit && x.m === r.m && x.route === rt);
        if (ref) referencedRoutes.add(ref);
        evidence.push({ file: r.unit.file, line: rt.line });
      }
      if (flow.length === 1 && rr.steps.length) flow = [...flow, ...rr.steps];
      score = Math.max(score, 1);
    }
    if (v.directUrl && !urls.includes(v.directUrl)) urls.push(v.directUrl);

    // 화면이 부르는 URL (자기 것 + 전용 조각 + 전용 스크립트)
    const refs = [...v.urls];
    const scriptFiles: string[] = [];
    const visit = new Set<string>();
    const addFragment = (p: string, layer: Layer, depth: number) => {
      if (visit.has(p) || depth > 3) return;
      visit.add(p);
      const fi = findByPath(p);
      if (!fi) return;
      const shared = (includeCount.get(p) ?? 0) > commonLimit;
      if (!files.has(fi.id)) files.set(fi.id, { layer, note: shared ? '공통' : layer === 'SCRIPT' ? undefined : '포함' });
      if (layer === 'SCRIPT') scriptFiles.push(fi.id);
      if (shared) return;
      const fv = viewByFile.get(fi.id);
      if (fv) {
        refs.push(...fv.urls);
        for (const inc of fv.includes) addFragment(inc, 'VIEW', depth + 1);
        for (const sc of fv.scripts) addFragment(sc, 'SCRIPT', depth + 1);
      }
    };
    for (const inc of v.includes) addFragment(inc, 'VIEW', 0);
    for (const sc of v.scripts) addFragment(sc, 'SCRIPT', 0);
    if (scriptFiles.length && flow.length >= 1) {
      const sf = fileById.get(scriptFiles[0]);
      if (sf) flow.splice(1, 0, { layer: 'SCRIPT', file: sf.id, symbol: sf.name });
    }

    const calls: ScreenResult['calls'] = [];
    const seenCall = new Set<string>();
    const baseDir = (urls[0] ?? '').replace(/[^/]*$/, '');
    for (const u0 of refs) {
      // 상대 URL(detail.do, ./x.php)은 화면 URL의 폴더 기준
      const u = !u0.url.startsWith('/') && baseDir ? { ...u0, url: `${baseDir}${u0.url.replace(/^\.\//, '')}` } : u0;
      const n = normUrl(u.url);
      if (seenCall.has(n)) continue;
      seenCall.add(n);
      const hits = matchRoutes(u.url, u.method);
      if (!hits.length) {
        if (!/\.(js|css|png|jpg|gif|ico|svg|pdf|xlsx?|hwp|zip)$/i.test(n) && n !== '/' && !n.startsWith('/static') && !n.startsWith('/resources') && !n.startsWith('/images')) {
          if (!unresolvedUrls.has(n)) unresolvedUrls.set(n, { file: u.file, line: u.line });
        }
        continue;
      }
      const cr = emptyReach();
      for (const h of hits) {
        referencedRoutes.add(h);
        // 다른 화면을 렌더링하는 URL(링크 이동)은 이 화면의 테이블에 넣지 않는다
        const rendersOther = h.m.views.some((vn) => {
          const target = resolveView(vn);
          return target && target.file !== v.file;
        });
        if (rendersOther && (u.kind === 'link' || u.kind === 'location' || u.kind === 'popup')) continue;
        const rr = reach(h.unit, h.m);
        mergeReach(cr, rr);
        if (flow.length <= 2 && rr.steps.length) flow = [...flow, ...rr.steps];
      }
      mergeReach(total, cr);
      calls.push({
        url: u.url,
        kind: u.kind,
        handler: hits[0] ? `${hits[0].unit.name}.${hits[0].m.name}()` : undefined,
        tables: tableList(cr),
      });
      score = Math.max(score, 1);
    }
    for (const [fid, layer] of total.files) if (!files.has(fid)) files.set(fid, { layer });
    if (total.tables.size && score >= 1) score = 2;
    const estimated = [...total.tables.values()].some((t) => t.estimated) || [...total.sql].some((id) => sqlById.get(id)?.dynamic);
    const name = v.title?.trim() || nameFromPath(urls[0] ?? f.path).trim() || nameFromPath(f.path).trim() || f.name;
    const popup = /pop(up)?/i.test(f.name) || /pop(up)?/i.test(urls[0] ?? '');
    const scr: ScreenResult = {
      id: nextScreenId(),
      kind: popup ? 'popup' : 'page',
      name,
      url: urls[0],
      urls,
      group: groupOf(urls[0], f.path),
      view: v.file,
      files: [...files.entries()].map(([file, x]) => ({ file, layer: x.layer, ...(x.note ? { note: x.note } : {}) })),
      tables: tableList(total),
      flow: withTableSteps(flow, total),
      calls,
      role: '',
      confidence: estimated ? '낮음' : confidenceOf(score),
      evidence,
      notInMenu: false,
      ...(f.project ? { project: f.project } : {}),
    };
    screens.push(scr);
    for (const r of rend) for (const rt of r.m.routes) {
      const ref = routes.find((x) => x.unit === r.unit && x.m === r.m && x.route === rt);
      if (ref) screenOfRoute.set(ref, scr);
    }
  }

  // 화면과 연결되지 않은 라우트 → API 항목 (화면이 하나도 없는 API 서버는 전부)
  const seenRoute = new Set<string>();
  for (const r of routes) {
    if (referencedRoutes.has(r)) continue;
    // 리다이렉트만 하는 이동용 메서드(로그아웃 등)는 API 목록에서 뺌
    if (!r.route.api && !r.m.views.length && (r.m.redirects?.length ?? 0) > 0) continue;
    // 같은 메서드·같은 경로의 다른 HTTP 메서드(PUT/PATCH 등)가 이미 쓰였으면 건너뜀
    if (routes.some((o) => o !== r && o.m === r.m && o.norm === r.norm && referencedRoutes.has(o))) continue;
    const key = `${r.route.method} ${r.norm}`;
    if (seenRoute.has(key)) continue;
    seenRoute.add(key);
    const rr = reach(r.unit, r.m);
    const f = fileById.get(r.unit.file);
    screens.push({
      id: nextScreenId(),
      kind: 'api',
      name: `${r.route.method === '*' ? '' : `${r.route.method} `}${r.route.path}`,
      url: r.route.path,
      urls: [r.route.path],
      group: groupOf(r.route.path, f?.path ?? ''),
      files: [...rr.files.entries()].map(([file, layer]) => ({ file, layer })),
      tables: tableList(rr),
      flow: withTableSteps(rr.steps, rr),
      calls: [],
      role: '',
      confidence: rr.tables.size ? '보통' : '낮음',
      evidence: [{ file: r.unit.file, line: r.route.line }],
      notInMenu: false,
      ...(f?.project ? { project: f.project } : {}),
    });
  }

  function withTableSteps(flow: FlowStep[], r: Reach): FlowStep[] {
    const out = [...flow];
    if (!out.some((s) => s.layer === 'TABLE')) {
      for (const t of [...r.tables.values()].slice(0, 4)) out.push({ layer: 'TABLE', symbol: t.name });
    }
    return out;
  }

  function groupOf(url: string | undefined, path: string): string {
    if (url) {
      const seg = normUrl(url).split('/').filter(Boolean);
      if (seg.length > 1) return `/${seg[0]}`;
      if (seg.length === 1 && !/\./.test(seg[0])) return `/${seg[0]}`;
      // 루트 URL('/', '/index.php', '/help.html')은 '/' 그룹
      if (seg.length <= 1) return '/';
    }
    const d = dirName(path).split('/');
    return d[d.length - 1] || '/';
  }

  // ------------------------------------------------------------ 배치
  const batches: BatchResult[] = [];
  let bseq = 0;
  const usedSchedules = new Set<number>();
  const scriptFiles = new Map<string, FileInfo>();
  for (const f of facts.files) if (['Shell', 'Batch', 'PowerShell', 'Python', 'SQL'].includes(f.lang)) scriptFiles.set(f.id, f);

  function fileForTarget(target: string): FileInfo | undefined {
    const t = target.replace(/^["']|["']$/g, '').replace(/^\.\//, '').replace(/\\/g, '/');
    const exact = findByPath(t);
    if (exact) return exact;
    const b = baseName(t);
    const c = facts.files.filter((f) => f.name === b && !f.excluded);
    return c.length === 1 ? c[0] : c.sort((a, b2) => a.path.length - b2.path.length)[0];
  }

  for (const b of facts.batches) {
    const entry = fileById.get(b.entry);
    const r = emptyReach();
    r.files.set(b.entry, 'BATCH');
    const flow: FlowStep[] = [];
    let schedule = b.schedule;
    if (!schedule && entry) {
      const idx = facts.schedules.findIndex((s) => s.command.includes(entry.name) || s.command.includes(entry.path));
      if (idx >= 0) {
        const s = facts.schedules[idx];
        usedSchedules.add(idx);
        schedule = { expr: s.expr, text: cronText(s.expr), evidence: s.evidence };
      }
    }
    if (schedule) {
      flow.push({ layer: 'SCHEDULE', file: schedule.evidence.file, symbol: `${fileById.get(schedule.evidence.file)?.name ?? '스케줄'} ${schedule.expr}`, line: schedule.evidence.line });
      r.files.set(schedule.evidence.file, 'CONFIG');
    }
    if (entry) flow.push({ layer: 'BATCH', file: entry.id, symbol: b.unit ? `${b.unit}.${b.method ?? ''}()` : entry.name });
    for (const id of b.sql) {
      const s = sqlById.get(id);
      if (s) addTables(r, s);
    }
    for (const c of b.calls) {
      if (c.kind === 'sql-file' || c.kind === 'script') {
        const tf = c.file ? fileById.get(c.file) : fileForTarget(c.target);
        if (!tf) continue;
        r.files.set(tf.id, tf.lang === 'SQL' ? 'BATCH' : 'BATCH');
        flow.push({ layer: 'BATCH', file: tf.id, symbol: tf.name });
        for (const s of sqlByFile.get(tf.id) ?? []) addTables(r, s);
        const sub = facts.batches.find((x) => x.entry === tf.id && x !== b);
        if (sub) for (const id of sub.sql) {
          const s = sqlById.get(id);
          if (s) addTables(r, s);
        }
      } else {
        // 클래스·프로그램: Java 단위의 main/run/execute
        const cls = simple(c.target.replace(/\.class$|\.jar$/i, ''));
        const units = unitsByName.get(cls.toLowerCase()) ?? [];
        for (const u of units) {
          r.files.set(u.file, 'BATCH');
          const ms = u.methods.filter((m) => /^(main|run|execute|executeInternal|process|call)$/.test(m.name));
          for (const m of ms.length ? ms : u.methods) mergeReach(r, reach(u, m));
          flow.push({ layer: 'BATCH', file: u.file, symbol: u.name });
        }
      }
    }
    if (b.unit) {
      const units = (unitsByName.get(b.unit.toLowerCase()) ?? []).filter((u) => u.file === b.entry || true);
      for (const u of units) {
        const ms = u.methods.filter((m) => !b.method || m.name === b.method);
        for (const m of ms) {
          const rr = reach(u, m);
          mergeReach(r, rr);
          if (rr.steps.length > 1) flow.push(...rr.steps.slice(1));
        }
      }
    }
    for (const t of [...r.tables.values()].slice(0, 6)) if (!flow.some((x) => x.layer === 'TABLE' && x.symbol === t.name)) flow.push({ layer: 'TABLE', symbol: t.name });
    const group = b.kind === 'spring-scheduled' ? 'Spring 스케줄러' : b.kind === 'quartz' ? 'Quartz' : b.kind === 'spring-batch' ? 'Spring Batch' : (entry ? baseName(dirName(entry.path)) || '/' : '/');
    batches.push({
      id: `B${String(++bseq).padStart(3, '0')}`,
      name: b.title || nameFromPath(b.method ?? entry?.path ?? b.key),
      kind: b.kind,
      group,
      entry: b.entry,
      ...(schedule ? { schedule } : {}),
      flow,
      tables: tableList(r),
      files: [...r.files.keys()],
      logs: b.logs,
      role: '',
      confidence: schedule && r.tables.size ? '높음' : r.tables.size || schedule ? '보통' : '낮음',
    });
  }
  // 배치와 이어지지 않은 스케줄 줄 → 프로그램 실행 배치
  facts.schedules.forEach((s, i) => {
    if (usedSchedules.has(i)) return;
    if (batches.some((b) => b.schedule && b.schedule.evidence.file === s.evidence.file && b.schedule.evidence.line === s.evidence.line)) return;
    const prog = s.command.split(/\s+/).find((w) => /[\w/.-]+\.(sh|bat|cmd|ps1|py|jar|js)\b/.test(w)) ?? s.command.split(/\s+/)[0];
    const target = fileForTarget(prog);
    if (target && facts.batches.some((b) => b.entry === target.id)) return;
    batches.push({
      id: `B${String(++bseq).padStart(3, '0')}`,
      name: nameFromPath(prog),
      kind: 'shell',
      group: '스케줄만 있음',
      entry: target?.id ?? s.evidence.file,
      schedule: { expr: s.expr, text: cronText(s.expr), evidence: s.evidence },
      flow: [{ layer: 'SCHEDULE', file: s.evidence.file, symbol: s.expr, line: s.evidence.line }, { layer: 'BATCH', symbol: prog }],
      tables: [],
      files: [s.evidence.file],
      logs: [],
      role: '',
      confidence: '낮음',
    });
  });

  // ------------------------------------------------------------ 테이블
  const ddlByKey = new Map(facts.ddl.map((t) => [tableKey(t.name), t] as const));
  const tableUse = new Map<string, { name: string; files: Set<string>; estimatedOnly: boolean }>();
  for (const s of facts.sql) {
    for (const t of s.tables) {
      const k = tableKey(t.name);
      let u = tableUse.get(k);
      if (!u) {
        u = { name: ddlByKey.get(k)?.name ?? t.name, files: new Set(), estimatedOnly: true };
        tableUse.set(k, u);
      }
      u.files.add(s.file);
      if (!t.estimated) u.estimatedOnly = false;
    }
  }
  for (const u of facts.units) {
    if (u.table) {
      const k = tableKey(u.table);
      let x = tableUse.get(k);
      if (!x) {
        x = { name: ddlByKey.get(k)?.name ?? u.table, files: new Set(), estimatedOnly: false };
        tableUse.set(k, x);
      }
      x.files.add(u.file);
    }
  }
  const allKeys = new Set([...ddlByKey.keys(), ...tableUse.keys()]);
  // 함께 조회되는 테이블
  const joins = new Map<string, Map<string, number>>();
  for (const s of facts.sql) {
    if (s.kind !== 'select') continue;
    const ks = [...new Set(s.tables.map((t) => tableKey(t.name)))];
    if (ks.length < 2 || ks.length > 8) continue;
    for (const a of ks) for (const b of ks) if (a !== b) {
      if (!joins.has(a)) joins.set(a, new Map());
      joins.get(a)!.set(b, (joins.get(a)!.get(b) ?? 0) + 1);
    }
  }
  const usage = new Map<string, TableResult['usedBy']>();
  for (const sc of screens) for (const t of sc.tables) {
    const k = tableKey(t.table);
    if (!usage.has(k)) usage.set(k, []);
    usage.get(k)!.push({ kind: 'screen', id: sc.id, crud: t.crud });
  }
  for (const b of batches) for (const t of b.tables) {
    const k = tableKey(t.table);
    if (!usage.has(k)) usage.set(k, []);
    usage.get(k)!.push({ kind: 'batch', id: b.id, crud: t.crud });
  }
  const pageCount = screens.filter((s) => s.kind !== 'api').length || screens.length || 1;
  const tables: TableResult[] = [];
  let tseq = 0;
  for (const k of [...allKeys].sort()) {
    const d = ddlByKey.get(k);
    const u = tableUse.get(k);
    const name = d?.name ?? u?.name ?? k;
    const role = tableRole(name, d?.comment);
    const used = usage.get(k) ?? [];
    const files = new Set<string>(u?.files ?? []);
    if (d) files.add(d.evidence.file);
    const screensUsing = used.filter((x) => x.kind === 'screen').length;
    const common = /(^|_)(CODE|CD|CMMN|CMN|COMMON|LOG|LOGS|FILE|FILES|ATCH|ATTACH|ATTACHMENT|SEQ|SEQUENCE|PROPERTY|PROP|CONFIG)(_|$)/i.test(name)
      || /^COMT(C|N)(CMMN|CODE|.*CODE$|FILE|.*LOG$)/i.test(name)
      || (pageCount >= 15 && screensUsing >= 5 && screensUsing / pageCount > 0.4);
    tables.push({
      id: `T${String(++tseq).padStart(3, '0')}`,
      name,
      ...(d?.comment ? { comment: d.comment } : {}),
      role: role.role,
      roleConfidence: role.confidence,
      columns: d?.columns ?? [],
      ...(d ? { ddl: d.evidence } : {}),
      common,
      fromSqlOnly: !d,
      files: [...files],
      usedBy: used,
      joinsWith: [...(joins.get(k)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([x]) => ddlByKey.get(x)?.name ?? tableUse.get(x)?.name ?? x),
      unlinked: used.length === 0,
      estimated: !d && (u?.estimatedOnly ?? false),
    });
  }
  const tableByKey = new Map(tables.map((t) => [tableKey(t.name), t] as const));
  const shortName = (n: string) => {
    const t = tableByKey.get(tableKey(n));
    return t ? shortTableName(t.role, t.name) : n;
  };

  // ------------------------------------------------------------ 메뉴
  const menus = buildMenus(facts.menus, screens, matchRoutes, screenOfRoute);

  // 역할
  for (const s of screens) {
    if (!s.name || /^[a-z0-9 _-]+$/i.test(s.name)) {
      const m = menus.find((x) => x.screens.includes(s.id));
      if (m && s.kind !== 'api') s.name = m.name;
    }
    s.role = screenRole(s.name, s.kind, s.tables.map((t) => ({ name: t.table, short: shortName(t.table), crud: t.crud })));
  }
  for (const b of batches) b.role = batchRole(b.name, b.tables.map((t) => ({ short: shortName(t.table), crud: t.crud })));

  // ------------------------------------------------------------ 확인 필요
  const issues: Issue[] = [];
  const unlinked = tables.filter((t) => t.unlinked && !t.fromSqlOnly);
  if (unlinked.length) issues.push({ kind: 'unlinked-table', title: '화면·배치와 연결되지 않은 테이블', items: unlinked.map((t) => ({ ref: t.id })) });
  const realMenus = menus.some((m) => !m.estimated);
  if (realMenus) {
    const nim = screens.filter((s) => s.kind === 'page' && !menus.some((m) => m.screens.includes(s.id)));
    for (const s of nim) s.notInMenu = true;
    if (nim.length) issues.push({ kind: 'screen-not-in-menu', title: '메뉴에 없는 화면', detail: '팝업·인쇄·하위 화면이거나 메뉴 데이터가 없는 화면', items: nim.map((s) => ({ ref: s.id })) });
  }
  const est = facts.sql.filter((s) => s.dynamic || s.tables.some((t) => t.estimated));
  if (est.length) {
    const byFile = new Map<string, number>();
    for (const s of est) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
    issues.push({ kind: 'estimated-sql', title: '동적 SQL로 테이블을 추정한 쿼리', items: [...byFile.entries()].map(([f, n]) => ({ ref: f, note: `${n}건` })) });
  }
  const noSched = batches.filter((b) => !b.schedule);
  if (noSched.length) issues.push({ kind: 'no-schedule', title: '실행 주기를 찾지 못한 배치', detail: '서버 crontab·작업 스케줄러 내보내기 파일을 설정에서 지정하면 붙습니다', items: noSched.map((b) => ({ ref: b.id })) });
  if (unresolvedUrls.size) issues.push({ kind: 'unresolved-url', title: '처리 메서드를 찾지 못한 URL', items: [...unresolvedUrls.entries()].slice(0, 200).map(([u, e]) => ({ ref: e.file, note: `${u} (${e.line}줄)` })) });
  const euc = facts.files.filter((f) => f.encoding === 'euc-kr' && !f.excluded);
  if (euc.length) issues.push({ kind: 'encoding', title: '인코딩 확인이 필요한 파일', detail: 'EUC-KR(MS949)로 읽음', items: euc.map((f) => ({ ref: f.id })) });
  issues.push(...facts.notes);

  return { tables, screens, menus, batches, issues };
}

// ------------------------------------------------------------------ 메뉴 만들기

const SOURCE_RANK: Record<MenuFact['source'], number> = { db: 0, 'data-file': 1, config: 2, code: 3, 'url-guess': 4 };

function buildMenus(
  facts: MenuFact[],
  screens: ScreenResult[],
  matchRoutes: (url: string) => { route: Route }[],
  screenOfRoute: Map<any, ScreenResult>,
): MenuResult[] {
  const best = facts.reduce((m, f) => Math.min(m, SOURCE_RANK[f.source]), 99);
  let chosen = facts.filter((f) => SOURCE_RANK[f.source] === best);
  const out: MenuResult[] = [];
  let seq = 0;
  const id = () => `M${String(++seq).padStart(3, '0')}`;
  const byUrl = new Map<string, ScreenResult[]>();
  for (const s of screens) for (const u of s.urls) {
    const n = normUrl(u);
    if (!byUrl.has(n)) byUrl.set(n, []);
    byUrl.get(n)!.push(s);
  }
  if (chosen.length) {
    // 키 중복 제거 + 부모 연결
    const keyToId = new Map<string, string>();
    chosen = chosen.filter((f, i) => chosen.findIndex((x) => x.key === f.key) === i);
    for (const f of chosen) keyToId.set(f.key, id());
    for (const f of chosen) {
      const parent = f.parentKey && keyToId.has(f.parentKey) && f.parentKey !== f.key ? keyToId.get(f.parentKey) : undefined;
      const linked: string[] = [];
      if (f.url) {
        const n = normUrl(f.url);
        for (const s of byUrl.get(n) ?? []) if (!linked.includes(s.id)) linked.push(s.id);
        if (!linked.length) {
          for (const r of matchRoutes(f.url)) {
            const s = screenOfRoute.get(r);
            if (s && !linked.includes(s.id)) linked.push(s.id);
          }
        }
      }
      out.push({ id: keyToId.get(f.key)!, name: f.name, ...(parent ? { parent } : {}), ...(f.url ? { url: f.url } : {}), ...(f.order !== undefined ? { order: f.order } : {}), depth: 0, screens: linked, source: f.source, evidence: f.evidence, estimated: false, tables: [] });
    }
  } else {
    // URL 경로로 추정한 메뉴
    const groups = new Map<string, ScreenResult[]>();
    for (const s of screens) {
      if (s.kind !== 'page' || !s.url) continue; // 주소 없는 화면은 메뉴로 열 수 없음
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group)!.push(s);
    }
    for (const [g, list] of [...groups.entries()].sort()) {
      const gid = id();
      const label = translate(g.replace(/^\//, '')).text || g;
      out.push({ id: gid, name: label, url: g, depth: 0, screens: [], source: 'url-guess', estimated: true, tables: [] });
      const byItemUrl = new Map<string, MenuResult>();
      for (const s of list) {
        const n = normUrl(s.url!);
        const same = byItemUrl.get(n);
        if (same) {
          same.screens.push(s.id); // 같은 주소의 여러 화면(단계별 폼 등)은 메뉴 하나로
          continue;
        }
        const m: MenuResult = { id: id(), name: s.name, parent: gid, url: s.url, depth: 1, screens: [s.id], source: 'url-guess', estimated: true, tables: [] };
        byItemUrl.set(n, m);
        out.push(m);
      }
    }
  }
  // 깊이와 정렬
  const byId = new Map(out.map((m) => [m.id, m] as const));
  for (const m of out) {
    let d = 0;
    let p = m.parent;
    const seen = new Set<string>();
    while (p && byId.has(p) && !seen.has(p)) {
      seen.add(p);
      d++;
      p = byId.get(p)!.parent;
    }
    m.depth = d;
  }
  // 하위 화면 테이블 합계
  const screenById = new Map(screens.map((s) => [s.id, s] as const));
  const childrenOf = (mid: string) => out.filter((x) => x.parent === mid);
  const collect = (m: MenuResult, seen = new Set<string>()): Map<string, Set<Crud>> => {
    const acc = new Map<string, Set<Crud>>();
    if (seen.has(m.id)) return acc;
    seen.add(m.id);
    for (const sid of m.screens) for (const t of screenById.get(sid)?.tables ?? []) {
      if (!acc.has(t.table)) acc.set(t.table, new Set());
      t.crud.forEach((c) => acc.get(t.table)!.add(c));
    }
    for (const c of childrenOf(m.id)) for (const [t, cs] of collect(c, seen)) {
      if (!acc.has(t)) acc.set(t, new Set());
      cs.forEach((x) => acc.get(t)!.add(x));
    }
    return acc;
  };
  for (const m of out) m.tables = [...collect(m).entries()].map(([table, cs]) => ({ table, crud: mergeCrud([...cs]) })).sort((a, b) => a.table.localeCompare(b.table));
  for (const s of screens) {
    const m = out.filter((x) => x.screens.includes(s.id)).sort((a, b) => b.depth - a.depth)[0];
    if (m) s.menu = m.id;
  }
  return out;
}

/** cron 식 → 한국어 (분 시 일 월 요일 / Spring 6자리 초 포함) */
export function cronText(expr: string): string {
  const p = expr.trim().split(/\s+/);
  const f = p.length >= 6 ? p.slice(1, 6) : p.slice(0, 5); // Spring: 초 분 시 일 월 요일
  if (f.length < 5) return expr;
  const [mi, h, dom, mon, dow] = f;
  const hm = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : null;
  const days = ['일', '월', '화', '수', '목', '금', '토', '일'];
  const dowName = (d: string) => d.split(',').map((x) => (/^\d$/.test(x) ? days[Number(x)] : x.slice(0, 3))).join('·');
  if (hm && dom === '*' && mon === '*' && (dow === '*' || dow === '?')) return `매일 ${hm}`;
  if (hm && (dom === '*' || dom === '?') && mon === '*' && /^[\d,A-Za-z]+$/.test(dow)) return `매주 ${dowName(dow)} ${hm}`;
  if (hm && /^\d+$/.test(dom) && mon === '*') return `매월 ${dom}일 ${hm}`;
  if (/^\*\/(\d+)$/.test(mi) && h === '*') return `${mi.slice(2)}분마다`;
  if (/^\d+$/.test(mi) && /^\*\/(\d+)$/.test(h)) return `${h.slice(2)}시간마다 ${mi}분`;
  if (/^\d+$/.test(mi) && h === '*') return `매시 ${mi}분`;
  return expr;
}
