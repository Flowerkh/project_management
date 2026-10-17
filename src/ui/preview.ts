// 불러오기 확인(SCR-02)에 쓰는 계산: 파일 요약, 폴더 미리보기, 감지된 주요 파일
import { compileExclude, decode, DEFAULT_EXCLUDE_DIRS, excludeReason, langOf } from '../engine/files';
import type { Lang } from '../engine/types';
import type { FolderFile, LoadedFolder } from '../platform/types';

export interface RunOpts {
  exclude: string[];
  maxFileBytes: number;
}

export interface Summary {
  total: number;
  totalBytes: number;
  analyzable: number;
  analyzableBytes: number;
  excluded: number;
  reasons: [string, number][];
  langs: [Lang, number][];
}

export function summarize(folder: LoadedFolder, opts: RunOpts): Summary {
  const ex = compileExclude(opts.exclude);
  let totalBytes = 0;
  let analyzable = 0;
  let analyzableBytes = 0;
  const reasons = new Map<string, number>();
  const langs = new Map<Lang, number>();
  for (const f of folder.files) {
    totalBytes += f.size;
    const r = excludeReason(f.path, f.size, opts.maxFileBytes, ex);
    if (r) {
      // 폴더 규칙은 폴더 이름으로 묶는다
      const k = r.startsWith('제외 규칙') ? r.replace(/^제외 규칙 \((.*)\)$/, '$1') : r;
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
      continue;
    }
    analyzable++;
    analyzableBytes += f.size;
    const l = langOf(f.path);
    langs.set(l, (langs.get(l) ?? 0) + 1);
  }
  return {
    total: folder.files.length,
    totalBytes,
    analyzable,
    analyzableBytes,
    excluded: folder.files.length - analyzable,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    langs: [...langs.entries()].filter(([l]) => l !== 'Other').sort((a, b) => b[1] - a[1]),
  };
}

interface Node {
  name: string;
  path: string;
  files: number;
  direct: FolderFile[];
  kids: Map<string, Node>;
}

export interface PreviewRow {
  path: string;
  label: string;
  total: number;
  analyzable: number;
  defaultExcluded: boolean;
  /** 폴더가 아니라 '파일 N개' 묶음 */
  filesGroup: boolean;
  /** 사용자가 해제할 때 넣을 제외 패턴 */
  pattern: string;
}

export function previewRows(folder: LoadedFolder, opts: RunOpts): PreviewRow[] {
  const root: Node = { name: '', path: '', files: 0, direct: [], kids: new Map() };
  for (const f of folder.files) {
    const segs = f.path.split('/');
    let n = root;
    n.files++;
    for (let i = 0; i < segs.length - 1; i++) {
      let k = n.kids.get(segs[i]);
      if (!k) {
        k = { name: segs[i], path: n.path ? `${n.path}/${segs[i]}` : segs[i], files: 0, direct: [], kids: new Map() };
        n.kids.set(segs[i], k);
      }
      k.files++;
      n = k;
    }
    n.direct.push(f);
  }
  const ex = compileExclude(opts.exclude);
  const isDefaultEx = (path: string) => path.split('/').some((s) => DEFAULT_EXCLUDE_DIRS.includes(s));
  const analyzableIn = (prefix: string) => {
    let n = 0;
    for (const f of folder.files) {
      if (prefix && !f.path.startsWith(`${prefix}/`)) continue;
      if (!excludeReason(f.path, f.size, opts.maxFileBytes, ex)) n++;
    }
    return n;
  };
  type Item = { node?: Node; filesOf?: Node };
  let items: Item[] = [...root.kids.values()].map((node) => ({ node }));
  if (root.direct.length) items.push({ filesOf: root });
  // 가장 큰 폴더를 한 단계씩 펼친다 (행 12개 이하)
  for (let pass = 0; pass < 4; pass++) {
    const cands = items
      .filter((it) => it.node && !isDefaultEx(it.node.path) && it.node.kids.size >= 1 && it.node.kids.size <= 6)
      .sort((a, b) => b.node!.files - a.node!.files);
    const c = cands[0];
    if (!c) break;
    const extra = c.node!.kids.size + (c.node!.direct.length ? 1 : 0) - 1;
    if (items.length + extra > 12) break;
    const idx = items.indexOf(c);
    const repl: Item[] = [...c.node!.kids.values()].map((node) => ({ node }));
    if (c.node!.direct.length) repl.push({ filesOf: c.node });
    items.splice(idx, 1, ...repl);
  }
  const rows: PreviewRow[] = items.map((it) => {
    if (it.node) {
      const d = isDefaultEx(it.node.path);
      return {
        path: it.node.path, label: it.node.path, total: it.node.files, analyzable: d ? 0 : analyzableIn(it.node.path), defaultExcluded: d, filesGroup: false,
        pattern: `${it.node.path}/**`,
      };
    }
    const n = it.filesOf!;
    const first = n.direct[0].path.split('/').pop() ?? '';
    const label = `${n.path ? `${n.path}/` : ''}${first}${n.direct.length > 1 ? ` 외 ${n.direct.length - 1}개 파일` : ''}`;
    let ok = 0;
    for (const f of n.direct) if (!excludeReason(f.path, f.size, opts.maxFileBytes, ex)) ok++;
    return { path: n.path, label, total: n.direct.length, analyzable: ok, defaultExcluded: false, filesGroup: true, pattern: '' };
  });
  return rows.sort((a, b) => Number(a.defaultExcluded) - Number(b.defaultExcluded) || Number(a.filesGroup) - Number(b.filesGroup) || b.total - a.total);
}

// ------------------------------------------------------------------ 감지된 주요 파일

const KEY_RULES: { re: RegExp; desc: string; read?: boolean }[] = [
  { re: /(^|\/)pom\.xml$/i, desc: 'Maven 빌드 설정', read: true },
  { re: /(^|\/)build\.gradle(\.kts)?$/i, desc: 'Gradle 빌드 설정', read: true },
  { re: /(^|\/)web\.xml$/i, desc: '웹 애플리케이션 설정', read: true },
  { re: /(^|\/)globals\.properties$/i, desc: 'DB 접속 설정 포함', read: true },
  { re: /context-datasource\.xml$/i, desc: '데이터소스 설정', read: true },
  { re: /(^|\/)application(-\w+)?\.(properties|ya?ml)$/i, desc: '애플리케이션 설정', read: true },
  { re: /(^|\/)composer\.json$/i, desc: 'PHP 의존성 (Composer)', read: true },
  { re: /(^|\/)go\.mod$/i, desc: 'Go 모듈', read: true },
  { re: /(^|\/)package\.json$/i, desc: 'Node.js 패키지', read: true },
  { re: /(^|\/)\.env(\.example)?$/i, desc: '환경 변수 (DB 접속 정보 가능)', read: true },
  { re: /(^|\/)AndroidManifest\.xml$/i, desc: 'Android 앱 선언' },
  { re: /(^|\/)pubspec\.yaml$/i, desc: 'Flutter 앱 설정' },
  { re: /(^|\/)(crontab|[^/]*\.cron)$/i, desc: '배치 실행 주기 (crontab)' },
  { re: /menu[^/]*\.(sql|xml|json)$/i, desc: '메뉴 데이터' },
  { re: /(^|\/)routes\/(web|api)\.php$/i, desc: 'Laravel 라우트' },
  { re: /(^|\/)artisan$/i, desc: 'Laravel 프로젝트' },
];

const HINTS: [RegExp, string][] = [
  [/egovframework\.rte|egovframework/i, 'egovframework.rte 의존성'],
  [/spring-webmvc|spring-boot-starter-web/i, 'Spring MVC'],
  [/mybatis/i, 'MyBatis'],
  [/ibatis/i, 'iBatis'],
  [/ojdbc|jdbc:oracle/i, 'Oracle'],
  [/mariadb/i, 'MariaDB'],
  [/mysql/i, 'MySQL'],
  [/DispatcherServlet/, 'DispatcherServlet'],
  [/laravel\/framework/i, 'Laravel'],
  [/codeigniter/i, 'CodeIgniter'],
  [/gin-gonic\/gin/i, 'Gin'],
  [/labstack\/echo/i, 'Echo'],
  [/gorm\.io/i, 'GORM'],
  [/"react-native"/i, 'React Native'],
  [/"react"/i, 'React'],
  [/"vue"/i, 'Vue'],
  [/"express"/i, 'Express'],
];

export interface KeyFile {
  path: string;
  desc: string;
}

export async function keyFiles(folder: LoadedFolder): Promise<KeyFile[]> {
  const out: KeyFile[] = [];
  const seen = new Set<string>();
  const cands = folder.files
    .filter((f) => !f.path.split('/').some((s) => DEFAULT_EXCLUDE_DIRS.includes(s)))
    .map((f) => ({ f, rule: KEY_RULES.find((r) => r.re.test(f.path)) }))
    .filter((x) => x.rule)
    .sort((a, b) => a.f.path.split('/').length - b.f.path.split('/').length);
  for (const { f, rule } of cands) {
    if (out.length >= 6) break;
    const key = `${rule!.desc}|${f.path.split('/').pop()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let desc = rule!.desc;
    if (rule!.read && f.size < 512 * 1024) {
      try {
        const text = decode(await f.read()).text;
        const hits = HINTS.filter(([re]) => re.test(text)).map(([, h]) => h);
        if (hits.length) desc += ` · ${[...new Set(hits)].slice(0, 3).join(' · ')}`;
      } catch {
        /* 읽기 실패는 무시 */
      }
    }
    out.push({ path: f.path, desc });
  }
  return out;
}

/** 하위 프로젝트 수 (빌드 파일이 있는 서로 다른 폴더) */
export function subProjectCount(folder: LoadedFolder): number {
  const roots = new Set<string>();
  for (const f of folder.files) {
    if (f.path.split('/').some((s) => DEFAULT_EXCLUDE_DIRS.includes(s))) continue;
    if (/(^|\/)(pom\.xml|build\.gradle(\.kts)?|composer\.json|go\.mod|pubspec\.yaml|AndroidManifest\.xml)$/i.test(f.path)) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      // 같은 프로젝트 안의 하위 모듈(app/src/main/AndroidManifest.xml 등)은 최상위 폴더로 묶음
      roots.add(dir.split('/')[0] ?? '');
    }
  }
  return roots.size;
}
