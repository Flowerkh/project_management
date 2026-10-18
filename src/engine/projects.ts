// 하위 프로젝트: 한 폴더에 앱·서버처럼 프로젝트가 여럿 있으면 루트(빌드·매니페스트 파일 위치)를 찾아
// 파일(FileInfo.project)과 결과(project.subProjects)에 표시한다. 루트가 하나뿐이면 아무것도 하지 않는다.
import type { AnalysisResult, Facts, FileInfo, SystemType } from './types';
import type { Linked } from './link';

type Kind = 'android' | 'gradle' | 'maven' | 'flutter' | 'dart' | 'rn' | 'node' | 'go' | 'php' | 'python';

const FAMILY: Record<Kind, string> = {
  android: 'jvm', gradle: 'jvm', maven: 'jvm', flutter: 'dart', dart: 'dart', rn: 'js', node: 'js', go: 'go', php: 'php', python: 'python',
};

export interface SubRoot {
  id: string;
  dir: string;
  name: string;
  kinds: Kind[];
}

function markerOf(f: FileInfo, text: string): { dir: string; kind: Kind } | null {
  const n = f.name;
  const dir = f.path.slice(0, Math.max(0, f.path.length - n.length - 1));
  if (n === 'AndroidManifest.xml') return { dir: dir.replace(/\/src\/main$/, ''), kind: 'android' };
  if (/^build\.gradle(\.kts)?$/.test(n)) return { dir, kind: /com\.android\.(application|library)|id\s*\(?\s*["']com\.android\./.test(text) ? 'android' : 'gradle' };
  if (/^settings\.gradle(\.kts)?$/.test(n)) return { dir, kind: 'gradle' };
  if (n === 'pom.xml') return { dir, kind: 'maven' };
  if (n === 'pubspec.yaml') return { dir, kind: /\bflutter\s*:/.test(text) ? 'flutter' : 'dart' };
  if (n === 'package.json') {
    if (/"(react-native|expo)"\s*:/.test(text)) return { dir, kind: 'rn' };
    if (/"(express|@nestjs\/core|koa|fastify|next|nuxt|react|vue|@angular\/core|svelte)"\s*:/.test(text)) return { dir, kind: 'node' };
    return null;
  }
  if (n === 'go.mod') return { dir, kind: 'go' };
  if (n === 'composer.json') return { dir, kind: 'php' };
  if (/^(requirements(-\w+)?\.txt|pyproject\.toml|setup\.py|Pipfile|manage\.py)$/.test(n)) return { dir, kind: 'python' };
  return null;
}

const inside = (dir: string, path: string) => dir === '' || path === dir || path.startsWith(`${dir}/`);

/** 루트를 찾아 파일에 하위 프로젝트 ID를 붙인다 (루트가 둘 이상일 때만) */
export function assignSubProjects(facts: Facts): SubRoot[] {
  const cands: { dir: string; kind: Kind }[] = [];
  for (const f of facts.files) {
    if (f.excluded || f.layer === 'TEST') continue;
    const m = markerOf(f, facts.texts.get(f.id) ?? '');
    if (m && !cands.some((c) => c.dir === m.dir && c.kind === m.kind)) cands.push(m);
  }
  if (cands.length < 2) return [];
  cands.sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir));
  const roots: { dir: string; kinds: Kind[] }[] = [];
  for (const c of cands) {
    const parent = roots.filter((r) => inside(r.dir, c.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!parent) {
      roots.push({ dir: c.dir, kinds: [c.kind] });
      continue;
    }
    if (parent.dir === c.dir) {
      if (!parent.kinds.includes(c.kind)) parent.kinds.push(c.kind);
      continue;
    }
    const main = parent.kinds[0];
    const host = FAMILY[c.kind] === 'jvm' && parent.kinds.some((k) => k === 'flutter' || k === 'rn');
    if (host || FAMILY[c.kind] === FAMILY[main]) {
      if (!parent.kinds.includes(c.kind)) parent.kinds.push(c.kind);
      continue;
    }
    roots.push({ dir: c.dir, kinds: [c.kind] });
  }
  if (roots.length < 2) return [];
  roots.sort((a, b) => a.dir.localeCompare(b.dir));
  const out: SubRoot[] = roots.map((r, i) => ({ id: `P${i + 1}`, dir: r.dir, name: r.dir.split('/').pop() || '최상위', kinds: r.kinds }));
  const byDepth = [...out].sort((a, b) => b.dir.length - a.dir.length);
  for (const f of facts.files) {
    const r = byDepth.find((x) => inside(x.dir, f.path));
    if (r) f.project = r.id;
  }
  return out;
}

/** 하위 프로젝트별 시스템 유형 */
export function subProjectList(roots: SubRoot[], facts: Facts, linked: Linked): AnalysisResult['project']['subProjects'] {
  const projOf = new Map(facts.files.map((f) => [f.id, f.project] as const));
  return roots.map((r) => {
    const types: SystemType[] = [];
    const mine = linked.screens.filter((s) => s.project === r.id);
    const app = mine.some((s) => s.platform) || r.kinds.some((k) => k === 'android' || k === 'flutter' || k === 'rn');
    const pages = mine.filter((s) => s.kind !== 'api' && !s.platform).length;
    const apis = mine.filter((s) => s.kind === 'api').length;
    if (app) types.push('모바일 앱');
    if (pages) types.push('웹');
    if (apis && !pages) types.push('API 서버');
    if (linked.batches.some((b) => projOf.get(b.entry) === r.id)) types.push('배치');
    if (!types.length) types.push('라이브러리');
    return { id: r.id, name: r.name, root: r.dir, types };
  });
}
