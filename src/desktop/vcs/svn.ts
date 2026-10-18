// SVN: PC에 설치된 svn 명령(TortoiseSVN 명령줄 도구 등)으로 감지·커밋. 커밋이 곧 서버 반영이라 푸시는 없다.
// 모든 명령에 --non-interactive: 저장된 인증만 쓰고 묻지 않는다 (인증서 신뢰도 자동으로 하지 않음).
import type { VcsInfo } from '../../shared/desktop-api';
import { findTool, hostLabel, reasonOf, run, type RunResult, stripCredentials, ToolError, withTempFiles } from './exec';
import type { CommitFile, VcsAdapter } from './types';

async function svn(root: string, sub: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const exe = await findTool('svn');
  if (!exe) throw new ToolError('missing', 'PC에서 svn 명령을 찾지 못했습니다');
  return run(exe, [sub, '--non-interactive', ...args], { cwd: root, timeoutMs: opts.timeoutMs ?? 30000, env: { SVN_EDITOR: '' } });
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1]) : undefined;
}

/** 경로에 '@'가 있으면 SVN이 리비전 표시로 읽으므로 끝에 '@'를 붙인다 */
function target(p: string): string {
  return p.includes('@') ? `${p}@` : p;
}

/** ^/shop/branches/feature-x/src → 'feature-x', ^/trunk → 'trunk' */
export function svnBranch(rel?: string): string | undefined {
  if (!rel) return undefined;
  const s = rel.replace(/^\^\/?/, '');
  const m = /(?:^|\/)(trunk)(?:\/|$)/.exec(s) ?? /(?:^|\/)(?:branches|tags)\/([^/]+)/.exec(s);
  if (m) return m[1];
  return s || '/';
}

/** svn status --xml → 경로 → 상태 (normal·ignored·external 제외) */
export function parseSvnStatus(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<entry\s+path="([^"]*)"\s*>\s*<wc-status\s+([^>]*)>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const p = unescapeXml(m[1]).replace(/\\/g, '/').replace(/^\.\//, '');
    const attrs = m[2];
    const item = /\bitem="([^"]*)"/.exec(attrs)?.[1] ?? 'normal';
    const props = /\bprops="([^"]*)"/.exec(attrs)?.[1] ?? 'none';
    if (item === 'normal' || item === 'ignored' || item === 'external' || item === 'none') {
      if (props === 'modified' || props === 'conflicted') out.set(p, `props-${props}`);
      continue;
    }
    out.set(p, item);
  }
  return out;
}

async function status(root: string): Promise<Map<string, string>> {
  const r = await svn(root, 'status', ['--xml'], { timeoutMs: 60000 });
  if (r.code !== 0) throw new ToolError('failed', reasonOf(r));
  return parseSvnStatus(r.stdout);
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) out.push(p.slice(0, i));
  return out;
}

export const svnAdapter: VcsAdapter = {
  kind: 'svn',
  label: 'SVN',
  marker: '.svn',
  canCommit: true,
  canPush: false,

  async detect(root) {
    const exe = await findTool('svn');
    if (!exe) {
      return { kind: 'svn', toolFound: false, error: 'PC에서 svn 명령을 찾지 못했습니다. TortoiseSVN을 설치할 때 command line client tools를 선택하면 커밋할 수 있습니다' };
    }
    const r = await svn(root, 'info', ['--xml']);
    if (r.code !== 0) return { kind: 'svn', toolFound: true, error: reasonOf(r) };
    const xml = r.stdout;
    const url = tag(xml, 'url');
    const rev = /<entry[^>]*\brevision="(\d+)"/.exec(xml)?.[1];
    const st = await status(root).catch(() => null);
    const remote = url ? stripCredentials(url) : undefined;
    const info: VcsInfo = {
      kind: 'svn',
      toolFound: true,
      repoRoot: tag(xml, 'wcroot-abspath'),
      branch: svnBranch(tag(xml, 'relative-url')),
      head: rev ? `r${rev}` : undefined,
      remote,
      hostLabel: hostLabel(remote, 'svn'),
      dirty: st?.size,
    };
    return info;
  },

  async check(root) {
    const login = 'PC에 저장된 SVN 로그인';
    const r = await svn(root, 'info', ['--xml', '-r', 'HEAD', '.'], { timeoutMs: 20000 });
    if (r.code === 0) return { remote: { ok: true, message: '원격 저장소 연결됨' }, login };
    return { remote: { ok: false, message: reasonOf(r) }, login };
  },

  status,

  async commit(root, files: CommitFile[], message) {
    if (!files.length) throw new Error('커밋할 파일이 없습니다');
    const before = await status(root);
    const unversioned = (p: string) => before.get(p) === 'unversioned' || ancestors(p).some((a) => before.get(a) === 'unversioned');
    // 새 파일: 상위 폴더까지 추가 (--parents). 지운 파일: SVN에 지움 표시
    const toAdd = files.filter((f) => f.status !== 'deleted' && unversioned(f.path)).map((f) => f.path);
    const toDel = files.filter((f) => f.status === 'deleted' && before.get(f.path) === 'missing').map((f) => f.path);
    if (toAdd.length) {
      const r = await svn(root, 'add', ['--parents', '--force', '--', ...toAdd.map(target)]);
      if (r.code !== 0) throw new Error(reasonOf(r));
    }
    if (toDel.length) {
      const r = await svn(root, 'delete', ['--force', '--', ...toDel.map(target)]);
      if (r.code !== 0) throw new Error(reasonOf(r));
    }
    const after = await status(root);
    const paths = files.map((f) => f.path).filter((p) => after.has(p));
    if (!paths.length) throw new Error('커밋할 변경이 없습니다');
    // 새로 추가된 상위 폴더도 함께 커밋해야 한다 (폴더만, --depth empty)
    const dirs = new Set<string>();
    for (const p of paths) for (const a of ancestors(p)) if (after.get(a) === 'added') dirs.add(a);
    const targets = [...dirs].sort().concat(paths).map(target);
    const r = await withTempFiles({ 'msg.txt': message }, async (f) => {
      if (targets.join(' ').length < 7000) return svn(root, 'commit', ['--depth', 'empty', '--encoding', 'UTF-8', '-F', f['msg.txt'], '--', ...targets], { timeoutMs: 180000 });
      return withTempFiles({ 'targets.txt': targets.join('\n') }, (t) =>
        svn(root, 'commit', ['--depth', 'empty', '--encoding', 'UTF-8', '-F', f['msg.txt'], '--targets', t['targets.txt']], { timeoutMs: 180000 }),
      );
    });
    if (r.code !== 0) throw new Error(reasonOf(r));
    const last = r.stdout.trim().split(/\r?\n/).pop() ?? '';
    let rev = /(\d+)\D*$/.exec(last)?.[1];
    if (!rev) {
      const info = await svn(root, 'info', ['--xml', '--', target(paths[0])]);
      rev = /<commit\s+revision="(\d+)"/.exec(info.stdout)?.[1];
    }
    return { hash: rev ? `r${rev}` : '' };
  },

  async push() {
    throw new Error('SVN은 커밋할 때 서버에 바로 반영됩니다');
  },
};
