// git·svn 실행: 셸 없이 execFile, 창 숨김, 시간 제한, 로그인 묻기 끔 → 앱이 멈추지 않게 한다.
// 계정·토큰은 다루지 않는다: PC에 저장된 로그인(Git Credential Manager, SVN 저장된 인증)을 도구가 알아서 쓴다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';

export interface RunOpts {
  cwd: string;
  /** 기본 30초 */
  timeoutMs?: number;
  env?: Record<string, string>;
  /** 표준 입력 (없으면 바로 닫는다) */
  input?: string | Buffer;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 실행 파일이 없음 / 시간 초과 / 실패 */
export class ToolError extends Error {
  kind: 'missing' | 'timeout' | 'failed';
  constructor(kind: ToolError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 도구 출력: UTF-8이 아니면 CP949 (한국어 Windows 콘솔 메시지) */
export function decodeOutput(buf: Buffer | string | undefined): string {
  if (buf === undefined) return '';
  if (typeof buf === 'string') return buf;
  try {
    return utf8.decode(buf);
  } catch {
    return iconv.decode(buf, 'cp949');
  }
}

// 부모 프로세스에 남아 있을 수 있는 저장소 지정 변수는 지운다 (cwd 기준으로 찾게)
const DROP_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  return { ...env, ...extra };
}

export function run(exe: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        exe,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? 30000,
          windowsHide: true,
          env: childEnv(opts.env),
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'buffer',
        },
        (err, stdout, stderr) => {
          const out = decodeOutput(stdout as Buffer);
          const errText = decodeOutput(stderr as Buffer);
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string };
            if (e.code === 'ENOENT') {
              reject(new ToolError('missing', `${path.basename(exe)} 명령을 찾지 못했습니다`));
              return;
            }
            if (e.killed || e.signal === 'SIGTERM') {
              resolve({ code: -1, stdout: out, stderr: errText, timedOut: true });
              return;
            }
            resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: out, stderr: errText || e.message, timedOut: false });
            return;
          }
          resolve({ code: 0, stdout: out, stderr: errText, timedOut: false });
        },
      );
    } catch (e) {
      reject(new ToolError('failed', (e as Error).message));
      return;
    }
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** 실패한 실행의 사유 한 줄 (화면 MSG-25·35의 {사유}) */
export function reasonOf(r: RunResult, fallback = '알 수 없는 오류'): string {
  if (r.timedOut) return '응답이 없어 시간 제한으로 멈췄습니다';
  const lines = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((s) => s.replace(/^(error|fatal|svn: E\d+|svn): */i, '').trim())
    .filter((s) => s && !/^(hint|warning):/i.test(s) && !/^\(use "git/.test(s));
  const first = lines.find((s) => /fatal|error|rejected|denied|failed|could not|unable|not |없|실패|못/i.test(s)) ?? lines[0];
  const text = (first ?? fallback).slice(0, 300);
  return text || fallback;
}

// ------------------------------------------------------------------ 실행 파일 찾기

const found = new Map<string, { exe: string | null; at: number }>();

function candidates(name: 'git' | 'svn'): string[] {
  if (process.platform !== 'win32') return [];
  const pf = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  if (name === 'git') {
    return [...pf.map((p) => path.join(p, 'Git', 'cmd', 'git.exe')), path.join(local, 'Programs', 'Git', 'cmd', 'git.exe')];
  }
  return pf.flatMap((p) => [
    path.join(p, 'TortoiseSVN', 'bin', 'svn.exe'),
    path.join(p, 'SlikSvn', 'bin', 'svn.exe'),
    path.join(p, 'Subversion', 'bin', 'svn.exe'),
    path.join(p, 'VisualSVN', 'bin', 'svn.exe'),
    path.join(p, 'CollabNet', 'Subversion Client', 'svn.exe'),
  ]);
}

/** PATH에서 찾고, 없으면 Windows의 흔한 설치 위치를 본다. 못 찾으면 null (30초 동안 기억) */
export async function findTool(name: 'git' | 'svn'): Promise<string | null> {
  const c = found.get(name);
  if (c && (c.exe || Date.now() - c.at < 30000)) return c.exe;
  let exe: string | null = null;
  for (const cand of [name, ...candidates(name)]) {
    if (cand !== name && !fs.existsSync(cand)) continue;
    try {
      const r = await run(cand, ['--version'], { cwd: os.tmpdir(), timeoutMs: 15000 });
      if (r.code === 0) {
        exe = cand;
        break;
      }
    } catch {
      // 다음 후보
    }
  }
  found.set(name, { exe, at: Date.now() });
  return exe;
}

// ------------------------------------------------------------------ 임시 파일 (커밋 메시지·경로 목록)

export async function withTempFiles<T>(files: Record<string, string | Buffer>, fn: (paths: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pa-vcs-'));
  try {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) {
      const p = path.join(dir, k);
      await fsp.writeFile(p, v);
      out[k] = p;
    }
    return await fn(out);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ 원격 주소

/** https://user:token@host/... → https://host/... (계정·토큰을 화면·기록에 남기지 않는다) */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, '$1');
}

/** 주소 안의 계정 이름 (토큰처럼 보이면 버림). 비밀번호는 읽지 않는다 */
export function urlUser(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^:@/\s]+)(?::[^@/\s]*)?@/i.exec(url);
  const u = m?.[1];
  if (!u) return undefined;
  if (/^(gh[pousr]_|glpat-|github_pat_)|^[0-9a-f]{32,}$|^[A-Za-z0-9_-]{30,}$/.test(u)) return undefined;
  if (/^(oauth2|x-access-token|x-token-auth|gitlab-ci-token|token|git)$/i.test(u)) return undefined;
  return decodeURIComponent(u);
}

/** 표시용 저장소 이름: GitHub·GitLab, 사내 서버면 '사내 GitLab' 등 */
export function hostLabel(url: string | undefined, kind: 'git' | 'svn'): string | undefined {
  if (!url) return undefined;
  if (/^file:/i.test(url) || /^([a-zA-Z]:)?[\\/]/.test(url) || /^\.\.?[\\/]/.test(url)) return '로컬 저장소';
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/:\s]+)/i.exec(url) ?? /^(?:[^@\s/]+@)?([^:/\s]+):/.exec(url);
  const host = (m?.[1] ?? '').toLowerCase();
  if (!host) return undefined;
  if (host === 'github.com' || host === 'ssh.github.com') return 'GitHub';
  if (host === 'gitlab.com') return 'GitLab';
  if (host === 'bitbucket.org') return 'Bitbucket';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com') || host === 'ssh.dev.azure.com') return 'Azure DevOps';
  if (/codecommit/.test(host)) return 'AWS CodeCommit';
  if (/gitlab/.test(host)) return '사내 GitLab';
  if (/github/.test(host)) return '사내 GitHub';
  if (/bitbucket|stash/.test(host)) return '사내 Bitbucket';
  if (/gitea|gogs/.test(host)) return '사내 Gitea';
  return kind === 'svn' ? '사내 SVN' : '사내 Git 서버';
}

/** 화면 표시용: 주소의 앞부분(https://)을 뗀다 */
export function displayUrl(url: string): string {
  return url.replace(/^(https?|git|ssh|svn|svn\+ssh):\/\//i, '');
}
