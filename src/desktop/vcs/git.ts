// Git: PC에 설치된 git 명령으로 감지·커밋·푸시. 로그인은 PC 설정(Git Credential Manager 등)을 그대로 쓴다.
import type { VcsInfo } from '../../shared/desktop-api';
import { findTool, hostLabel, reasonOf, run, type RunResult, stripCredentials, ToolError, urlUser, withTempFiles } from './exec';
import type { CommitFile, VcsAdapter } from './types';

/** 터미널에서 계정을 묻지 않게 (묻는 대신 실패) */
const ENV = { GIT_TERMINAL_PROMPT: '0' };
/** 연결 확인처럼 사용자가 기다리지 않는 확인: 로그인 창도 띄우지 않음 */
const QUIET_ENV = { ...ENV, GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };

async function git(root: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string>; input?: string | Buffer } = {}): Promise<RunResult> {
  const exe = await findTool('git');
  if (!exe) throw new ToolError('missing', 'PC에서 git 명령을 찾지 못했습니다');
  return run(exe, ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], { cwd: root, timeoutMs: opts.timeoutMs ?? 30000, env: { ...ENV, ...opts.env }, input: opts.input });
}

async function gitOut(root: string, args: string[], opts?: Parameters<typeof git>[2]): Promise<string | null> {
  const r = await git(root, args, opts);
  return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
}

/** 저장소 최상위 기준 → 프로젝트 폴더 기준 경로 */
function toRootRel(repoRel: string, prefix: string): string | null {
  if (!prefix) return repoRel;
  return repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : null;
}

/** git status --porcelain=v1 -z 해석: 경로(저장소 기준) → XY */
export function parsePorcelainZ(out: string): Map<string, string> {
  const m = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    m.set(e.slice(3).replace(/\/$/, ''), xy);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // 이름 바꾸기: 다음 칸은 원래 이름
  }
  return m;
}

/** 경로가 많으면 명령줄 길이를 넘지 않게 파일로 넘긴다 (git 2.25+) */
async function withPathspec<T>(paths: string[], fn: (args: string[]) => Promise<T>): Promise<T> {
  if (paths.join(' ').length < 7000) return fn(['--', ...paths]);
  return withTempFiles({ 'paths.txt': `${paths.join('\0')}\0` }, (f) => fn([`--pathspec-from-file=${f['paths.txt']}`, '--pathspec-file-nul']));
}

async function prefixOf(root: string): Promise<string> {
  return (await gitOut(root, ['rev-parse', '--show-prefix'])) ?? '';
}

function helperLabel(h: string): string {
  const s = h.trim();
  if (/manager|git-credential-manager|gcm/i.test(s)) return 'Git Credential Manager';
  if (/wincred/i.test(s)) return 'Windows 자격 증명';
  if (/osxkeychain/i.test(s)) return 'macOS 키체인';
  if (/libsecret|gnome-keyring/i.test(s)) return '시스템 키링';
  if (/^store\b/.test(s)) return 'git credential store';
  if (/^cache\b/.test(s)) return 'git credential cache';
  return s.split(/\s+/)[0].replace(/^!/, '');
}

async function remoteOf(root: string, branch?: string): Promise<{ name: string; url: string } | null> {
  const names = ((await gitOut(root, ['remote'])) ?? '').split(/\r?\n/).filter(Boolean);
  if (!names.length) return null;
  const tracked = branch ? await gitOut(root, ['config', '--get', `branch.${branch}.remote`]) : null;
  const name = tracked && names.includes(tracked) ? tracked : names.includes('origin') ? 'origin' : names[0];
  const url = (await gitOut(root, ['config', '--get', `remote.${name}.url`])) ?? '';
  return { name, url };
}

async function status(root: string): Promise<Map<string, string>> {
  const [r, prefix] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 60000 }),
    prefixOf(root),
  ]);
  if (r.code !== 0) throw new ToolError('failed', reasonOf(r));
  const out = new Map<string, string>();
  for (const [p, xy] of parsePorcelainZ(r.stdout)) {
    const rel = toRootRel(p, prefix);
    if (rel) out.set(rel, xy);
  }
  return out;
}

export const gitAdapter: VcsAdapter = {
  kind: 'git',
  label: 'Git',
  marker: '.git',
  canCommit: true,
  canPush: true,

  async detect(root) {
    const exe = await findTool('git');
    if (!exe) return { kind: 'git', toolFound: false, error: 'PC에서 git 명령을 찾지 못했습니다. Git for Windows를 설치하면 커밋·푸시를 할 수 있습니다' };
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return { kind: 'git', toolFound: true, error: reasonOf(top) };
    const [branch, head] = await Promise.all([gitOut(root, ['symbolic-ref', '--short', '-q', 'HEAD']), gitOut(root, ['rev-parse', '--short', 'HEAD'])]);
    const [remote, st] = await Promise.all([remoteOf(root, branch ?? undefined), status(root).catch(() => null)]);
    const url = remote?.url ? stripCredentials(remote.url) : undefined;
    const info: VcsInfo = {
      kind: 'git',
      toolFound: true,
      repoRoot: top.stdout.trim(),
      branch: branch ?? (head ? 'HEAD' : undefined),
      head: head ?? undefined,
      remote: url,
      hostLabel: hostLabel(url, 'git'),
      dirty: st?.size,
    };
    return info;
  },

  async check(root, info) {
    const branch = info.branch && info.branch !== 'HEAD' ? info.branch : undefined;
    const remote = await remoteOf(root, branch);
    let login: string | undefined;
    if (remote?.url) {
      if (/^(ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(remote.url)) login = 'SSH 키';
      else if (/^https?:/i.test(remote.url)) {
        const clean = stripCredentials(remote.url);
        const helpers = ((await gitOut(root, ['config', '--get-urlmatch', 'credential.helper', clean])) ?? (await gitOut(root, ['config', '--get-all', 'credential.helper'])) ?? '')
          .split(/\r?\n/)
          .filter(Boolean);
        const user = urlUser(remote.url) ?? (await gitOut(root, ['config', '--get-urlmatch', 'credential.username', clean])) ?? undefined;
        const h = helpers.length ? helperLabel(helpers[helpers.length - 1]) : 'PC에 저장된 Git 로그인';
        login = user ? `${h} 로그인 ${user}` : h;
      }
    }
    if (!remote) return { remote: { ok: false, message: '원격 저장소(origin)가 설정되어 있지 않습니다. 적용과 커밋은 그대로 할 수 있습니다' }, login };
    const r = await git(root, ['ls-remote', remote.name, 'HEAD'], { timeoutMs: 20000, env: QUIET_ENV });
    if (r.code === 0) return { remote: { ok: true, message: '원격 저장소 연결됨' }, login };
    return { remote: { ok: false, message: reasonOf(r) }, login };
  },

  status,

  async commit(root, files: CommitFile[], message) {
    if (!files.length) throw new Error('커밋할 파일이 없습니다');
    const paths = files.map((f) => f.path);
    // 추적 중인 파일 (지운 파일 중 git이 모르는 것은 커밋할 것이 없음)
    const tracked = new Set(
      ((await withPathspec(paths, (ps) => gitOut(root, ['--literal-pathspecs', 'ls-files', '-z', ...ps]))) ?? '').split('\0').filter(Boolean),
    );
    // .gitignore에 걸린 새 파일은 커밋하지 않는다 (사용자의 무시 규칙을 따름)
    const untracked = paths.filter((p) => !tracked.has(p));
    const ignoredOut = untracked.length ? await git(root, ['check-ignore', '-z', '--stdin'], { input: `${untracked.join('\0')}\0` }) : null;
    const ignored = new Set(ignoredOut?.code === 0 ? ignoredOut.stdout.split('\0').filter(Boolean) : []);
    const use = files.filter((f) => (f.status === 'deleted' ? tracked.has(f.path) : !ignored.has(f.path))).map((f) => f.path);
    if (!use.length) throw new Error('커밋할 변경이 없습니다 (모두 git이 추적하지 않거나 무시하는 파일)');
    const add = await withPathspec(use, (ps) => git(root, ['--literal-pathspecs', 'add', '-A', ...ps], { timeoutMs: 120000 }));
    if (add.code !== 0) throw new Error(reasonOf(add));
    const commit = await withTempFiles({ 'msg.txt': message }, (f) =>
      withPathspec(use, (ps) => git(root, ['--literal-pathspecs', 'commit', '-F', f['msg.txt'], '--cleanup=whitespace', ...ps], { timeoutMs: 120000 })),
    );
    if (commit.code !== 0) throw new Error(reasonOf(commit));
    const hash = (await gitOut(root, ['rev-parse', '--short', 'HEAD'])) ?? '';
    const skipped = paths.length - use.length;
    return { hash, note: skipped ? `git이 무시·추적하지 않는 파일 ${skipped}개는 커밋하지 않음` : undefined };
  },

  async push(root) {
    const branch = await gitOut(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (!branch) throw new Error('브랜치가 아닌 커밋(분리된 HEAD)에 있어 푸시할 수 없습니다');
    const remote = await gitOut(root, ['config', '--get', `branch.${branch}.remote`]);
    const merge = await gitOut(root, ['config', '--get', `branch.${branch}.merge`]);
    if (!remote || !merge) throw new Error(`현재 브랜치(${branch})에 연결된 원격 브랜치가 없습니다. 한 번 직접 푸시해 연결한 뒤 다시 시도해 주세요`);
    const r = await git(root, ['push', '--porcelain', remote, `HEAD:${merge}`], { timeoutMs: 180000 });
    if (r.code !== 0) throw new Error(reasonOf(r));
    return `${remote} ${merge.replace(/^refs\/heads\//, '')}`;
  },
};
