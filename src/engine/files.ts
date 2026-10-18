// 파일 수집: 제외 규칙, 바이너리 판별, 인코딩 감지(UTF-8 / EUC-KR), 언어·계층 1차 판별
import type { FileInfo, Lang, Layer, SourceFile } from './types';

/** 기본 제외 폴더 (경로 조각 단위로 비교) */
export const DEFAULT_EXCLUDE_DIRS = [
  '.git', '.svn', '.hg', '.idea', '.vscode', '.settings', '.gradle', '.mvn', '.next', '.nuxt', '.cache',
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj',
  '__pycache__', '.venv', 'venv', 'coverage', 'logs', 'tmp', '.dart_tool', 'Pods',
  // iOS·macOS 앱은 분석 범위 밖 (Flutter·React Native 프로젝트의 ios/·macos/ 폴더 포함)
  'ios', 'macos',
];

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svgz', 'tif', 'tiff', 'psd', 'ai',
  'zip', 'jar', 'war', 'ear', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz', 'tar',
  'class', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'pyc', 'pyo', 'apk', 'aab', 'ipa', 'dex',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'odt',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'avi', 'mov', 'wav', 'flv', 'swf',
  'keystore', 'jks', 'p12', 'pfx', 'der', 'db', 'sqlite', 'mdb', 'dat', 'bin', 'iml', 'lock',
]);

const LANG_BY_EXT: Record<string, Lang> = {
  java: 'Java', jsp: 'JSP', jspf: 'JSP', tag: 'JSP', jspx: 'JSP',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', vue: 'Vue',
  php: 'PHP', phtml: 'PHP', inc: 'PHP',
  go: 'Go', py: 'Python', kt: 'Kotlin', kts: 'Kotlin', dart: 'Dart',
  sql: 'SQL', ddl: 'SQL', pls: 'SQL', pkb: 'SQL', pks: 'SQL', prc: 'SQL',
  xml: 'XML', xsd: 'XML', html: 'HTML', htm: 'HTML', xhtml: 'HTML',
  css: 'CSS', scss: 'CSS', less: 'CSS', sass: 'CSS',
  sh: 'Shell', bash: 'Shell', ksh: 'Shell', csh: 'Shell', zsh: 'Shell',
  bat: 'Batch', cmd: 'Batch', ps1: 'PowerShell', psm1: 'PowerShell',
  properties: 'Properties', yml: 'YAML', yaml: 'YAML', json: 'JSON',
  groovy: 'Groovy', gradle: 'Groovy', cs: 'C#', swift: 'Swift',
  tpl: 'Template', tmpl: 'Template', gohtml: 'Template', twig: 'Template', ftl: 'Template', vm: 'Template',
  mustache: 'Template', hbs: 'Template', ejs: 'Template', njk: 'Template', jinja: 'Template', jinja2: 'Template',
};

/** 분석에 쓰지 않는 문서·기타 확장자 (통계에서 '기타') */
const DOC_EXT = new Set(['md', 'txt', 'csv', 'log', 'svg', 'map', 'gitignore', 'gitattributes', 'editorconfig', 'license']);

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name.endsWith('.blade.php')) return 'blade.php';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1) : '';
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

/** 'a/b/../c' 같은 경로 정리 */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function langOf(path: string): Lang {
  const name = baseName(path).toLowerCase();
  if (name === 'crontab' || name.endsWith('.crontab') || name.endsWith('.cron') || /^crontab[._-]/.test(name)) return 'Shell';
  const ext = extOf(path);
  if (ext === 'blade.php') return 'PHP';
  return LANG_BY_EXT[ext] ?? 'Other';
}

/** 사용자 제외 패턴: 'a/b/**', '*.min.js', 'docs' 등 간단한 glob */
export function compileExclude(patterns: string[]): (path: string) => boolean {
  const regs = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
      // 슬래시가 없으면 경로 조각·파일 이름 어디서나
      return p.includes('/') ? new RegExp(`^${esc}(/.*)?$`) : new RegExp(`(^|/)${esc}(/.*)?$`);
    });
  return (path) => regs.some((r) => r.test(path));
}

export function excludeReason(path: string, size: number, maxBytes: number, userExclude: (p: string) => boolean): string | undefined {
  const segs = path.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (DEFAULT_EXCLUDE_DIRS.includes(segs[i])) return `제외 규칙 (${segs[i]})`;
  }
  if (userExclude(path)) return '사용자 제외 규칙';
  const ext = extOf(path);
  if (BINARY_EXT.has(ext)) return '바이너리';
  const name = baseName(path).toLowerCase();
  if (/\.min\.(js|css)$/.test(name) || /-min\.js$/.test(name)) return '압축된 라이브러리';
  if (/^(jquery|bootstrap|angular|react|vue|lodash|moment|chart|d3|axios|popper|fontawesome|swiper|select2|datatables|ckeditor|tinymce|summernote|jstree|ax5|ibsheet|tui-grid|jqgrid)[.\-\d]/i.test(name) && ext === 'js') return '외부 라이브러리';
  if (size > maxBytes) return `크기 초과 (${Math.round(size / 1024)}KB)`;
  if (DOC_EXT.has(ext)) return '문서·기타';
  return undefined;
}

// ------------------------------------------------------------------ 인코딩

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');
let eucKr: TextDecoder | undefined;
try {
  eucKr = new TextDecoder('euc-kr');
} catch {
  eucKr = undefined;
}

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) zeros++;
  return zeros > 0 && !(bytes[0] === 0xff && bytes[1] === 0xfe) && !(bytes[0] === 0xfe && bytes[1] === 0xff);
}

export function decode(bytes: Uint8Array): { text: string; encoding: FileInfo['encoding'] } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: utf8Loose.decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16' };
  }
  try {
    return { text: utf8.decode(bytes), encoding: 'utf-8' };
  } catch {
    if (eucKr) return { text: eucKr.decode(bytes), encoding: 'euc-kr' };
    return { text: utf8Loose.decode(bytes), encoding: 'utf-8' };
  }
}

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith('\n')) n--;
  return n;
}

/** 1부터 시작하는 줄 번호 (offset 위치) */
export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 여러 offset의 줄 번호를 한 번에 (정렬 필요 없음) */
export function makeLineIndex(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ------------------------------------------------------------------ 계층 1차 판별 (분석기가 내용 보고 고침)

export function guessLayer(path: string, lang: Lang): Layer {
  const p = path.toLowerCase();
  const name = baseName(p);
  if (/(^|\/)(test|tests|__tests__|spec|testcase)(\/|$)/.test(p) || /(test|tests|spec)\.(java|kt|php|js|ts|py)$/.test(name) || name.endsWith('_test.go')) return 'TEST';
  switch (lang) {
    case 'Java':
    case 'Kotlin':
      if (/controller\.(java|kt)$/.test(name) || /(^|\/)(web|controller|controllers|action)\//.test(p) && /(controller|action)\.(java|kt)$/.test(name)) return 'CONTROLLER';
      if (/(serviceimpl|service)\.(java|kt)$/.test(name)) return 'SERVICE';
      if (/(dao|daoimpl|repository)\.(java|kt)$/.test(name)) return 'DAO';
      if (/mapper\.(java|kt)$/.test(name)) return 'MAPPER';
      if (/(vo|dto|entity|domain|model|default)\.(java|kt)$/.test(name) || /\/(vo|dto|entity|domain|model)\//.test(p)) return 'MODEL';
      if (/(job|scheduler|batch|tasklet)\.(java|kt)$/.test(name)) return 'BATCH';
      return 'OTHER';
    case 'JSP':
    case 'HTML':
    case 'Template':
    case 'Vue':
      return 'VIEW';
    case 'JavaScript':
    case 'TypeScript':
      if (/(^|\/)(routes?|router)\//.test(p) && /\.(js|ts)$/.test(name) && !/\/(static|public|webapp|resources)\//.test(p)) return 'ROUTE';
      if (/(^|\/)(pages|views|screens)\//.test(p) && /\.(jsx|tsx)$/.test(name)) return 'VIEW';
      return 'SCRIPT';
    case 'PHP':
      if (name.endsWith('.blade.php') || /(^|\/)(views|templates|resources\/views)\//.test(p)) return 'VIEW';
      if (/(^|\/)routes\//.test(p) || /\/config\/routes\.php$/.test(p)) return 'ROUTE';
      if (/(^|\/)(controllers|http\/controllers)\//.test(p) || /controller\.php$/.test(name)) return 'CONTROLLER';
      if (/(^|\/)(models|model)\//.test(p) || /model\.php$/.test(name)) return 'MODEL';
      if (/(^|\/)(services|service)\//.test(p)) return 'SERVICE';
      if (/(^|\/)(config|database)\//.test(p)) return 'CONFIG';
      return 'VIEW';
    case 'Go':
      if (/(^|\/)(router|routes|routers)(\/|\.go$)/.test(p) || /routes?\.go$/.test(name)) return 'ROUTE';
      if (/(^|\/)(handler|handlers|controller|controllers|api|apis)\//.test(p) || /(handler|controller)s?\.go$/.test(name)) return 'CONTROLLER';
      if (/(^|\/)(service|services|usecase|usecases|logic)\//.test(p) || /service\.go$/.test(name)) return 'SERVICE';
      if (/(^|\/)(repo|repos|repository|repositories|dao|store|storage|db|query)\//.test(p) || /(repo|repository|dao|store)\.go$/.test(name)) return 'DAO';
      if (/(^|\/)(model|models|entity|entities|domain)\//.test(p)) return 'MODEL';
      return 'OTHER';
    case 'SQL':
      return 'DDL';
    case 'XML':
      if (/mapper|sqlmap|_sql[^/]*\.xml$|sql_[^/]*\.xml$/.test(p)) return 'MAPPER';
      if (/menu[^/]*\.xml$/.test(name)) return 'MENU_DATA';
      return 'CONFIG';
    case 'Shell':
    case 'Batch':
    case 'PowerShell':
      return 'BATCH';
    case 'Properties':
    case 'YAML':
    case 'JSON':
    case 'Groovy':
      if (lang === 'JSON' && /menu[^/]*\.json$/.test(name)) return 'MENU_DATA';
      return 'CONFIG';
    case 'CSS':
      return 'STYLE';
    case 'Python':
      if (/(^|\/)(views|controllers|api|routers?)\b/.test(p) || /views\.py$/.test(name)) return 'CONTROLLER';
      if (/models?\.py$/.test(name)) return 'MODEL';
      if (/urls\.py$/.test(name)) return 'ROUTE';
      return 'OTHER';
    default:
      return 'OTHER';
  }
}

export interface Collected {
  files: FileInfo[];
  texts: Map<string, string>;
}

/** 입력 파일을 FileInfo로 바꾸고 분석 대상 텍스트를 디코딩 */
export function collect(
  input: SourceFile[],
  opts: { exclude?: string[]; maxFileBytes?: number },
  onEach?: (i: number) => void,
): Collected {
  const userExclude = compileExclude(opts.exclude ?? []);
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const files: FileInfo[] = [];
  const texts = new Map<string, string>();
  const sorted = [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let seq = 0;
  sorted.forEach((sf, i) => {
    onEach?.(i);
    const path = normalizePath(sf.path);
    const id = `F${String(++seq).padStart(4, '0')}`;
    const lang = langOf(path);
    const info: FileInfo = {
      id, path, name: baseName(path), lang, layer: guessLayer(path, lang),
      lines: 0, size: sf.size, encoding: 'utf-8',
    };
    const reason = excludeReason(path, sf.size, maxBytes, userExclude);
    if (reason) {
      info.excluded = reason;
      if (reason === '바이너리') info.encoding = 'binary';
      files.push(info);
      return;
    }
    let text = sf.text;
    if (text === undefined) {
      const bytes = sf.bytes ?? new Uint8Array();
      if (looksBinary(bytes)) {
        info.excluded = '바이너리';
        info.encoding = 'binary';
        files.push(info);
        return;
      }
      const d = decode(bytes);
      text = d.text;
      info.encoding = d.encoding;
    }
    info.lines = countLines(text);
    texts.set(id, text);
    files.push(info);
  });
  return { files, texts };
}

/** 프로젝트 이름 추정: 공통 최상위 폴더 */
export function commonRoot(paths: string[]): string {
  if (!paths.length) return '';
  const first = paths[0].split('/');
  let n = first.length - 1;
  for (const p of paths) {
    const s = p.split('/');
    let k = 0;
    while (k < n && k < s.length - 1 && s[k] === first[k]) k++;
    n = k;
    if (!n) break;
  }
  return first.slice(0, n).join('/');
}
