// Claude Code CLI 찾기·버전 확인.
// 찾는 순서: 설정의 cliPath → PA_CLAUDE_CLI(시험용) → Windows: %USERPROFILE%\.local\bin\claude.exe(네이티브 설치),
//   PATH의 claude(.exe/.cmd/.ps1 — `where claude`와 같은 순서), %APPDATA%\npm\claude.cmd → Linux·mac(개발용): PATH의 claude,
//   ~/.local/bin/claude, ~/.claude/local/claude.
// npm으로 설치한 claude.cmd·claude.ps1(셸 스크립트)은 그대로 실행할 수 없으므로(Node는 .cmd를 셸 없이 띄우지 않음)
// 안에 적힌 node_modules/@anthropic-ai/claude-code/cli.js를 찾아 node로 실행한다.
// SDK(0.3.302)는 경로가 .js/.mjs로 끝나면 executable(node)로, 아니면 경로를 바로 실행한다 (sdk.mjs QZe 함수).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 지원하는 가장 낮은 CLI 버전. SDK 0.3.302는 실행 시 CLI 버전을 검사하지 않는다(문서에 버전이 적힌 기능은
 * verbatimPrompts 2.1.248, pluginDelivery 2.1.261 — 이 앱은 쓰지 않음). 앱이 쓰는 플래그(--setting-sources,
 * --strict-mcp-config, --include-partial-messages, --permission-prompt-tool=stdio, --tools, --no-session-persistence,
 * --settings)와 initialize 요청의 appendSystemPrompt·hooks·sdkMcpServers는 2.1.42 CLI에서 확인했다.
 */
export const MIN_CLI_VERSION = '2.1.0';

export type CliSource = 'config' | 'env' | 'native' | 'path' | 'npm' | 'local';

export interface CliTarget {
  /** 사용자에게 보여 줄 경로 (claude.exe, claude.cmd …) */
  display: string;
  /** SDK pathToClaudeCodeExecutable: 네이티브 실행 파일 또는 cli.js */
  exec: string;
  /** cli.js면 node로 실행 (node 경로 또는 'node') */
  node?: string;
  source: CliSource;
}

export interface CliFound {
  ok: true;
  target: CliTarget;
  version: string;
}

export interface CliMissing {
  ok: false;
  /** notfound 없음 / old 버전이 낮음 / broken 실행 실패 */
  reason: 'notfound' | 'old' | 'broken';
  message: string;
  target?: CliTarget;
  version?: string;
}

export type CliResult = CliFound | CliMissing;

export interface DiscoverOptions {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** --version 실행 (시험에서 바꿔 끼움) */
  runVersion?: (t: CliTarget, env: NodeJS.ProcessEnv) => Promise<string>;
  timeoutMs?: number;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** "2.1.302 (Claude Code)" → "2.1.302" */
export function parseVersion(out: string): string | null {
  const m = /(?:^|\s|v)(\d+\.\d+\.\d+)(?:[-+][\w.]+)?/.exec(String(out ?? '').trim());
  return m ? m[1] : null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * npm 실행 스크립트(claude.cmd·claude.ps1·sh)에서 실제 대상(cli.js 또는 실행 파일)을 찾는다.
 * cmd: "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"  ps1·sh: "$basedir/node_modules/@anthropic-ai/claude-code/cli.js"
 */
export function parseShim(text: string, name = 'claude'): { rel: string; nodeNextToShim: boolean } | null {
  const cands: string[] = [];
  for (const m of text.matchAll(/"%~?dp0%?\\([^"%]+)"/gi)) cands.push(m[1]);
  for (const m of text.matchAll(/"\$basedir[\\/]([^"$]+)"/g)) cands.push(m[1]);
  const target = cands.find((c) => !/^node(\.exe)?$/i.test(c) && !/^node\$exe$/i.test(c) && c.toLowerCase().includes(name));
  if (!target) return null;
  return { rel: target.replace(/\\/g, '/'), nodeNextToShim: /%~?dp0%?\\node\.exe|\$basedir[\\/]node\$exe/i.test(text) };
}

/** 실행 스크립트·심볼릭 링크·cli.js를 실제 실행 대상으로 (name: 스크립트 안에서 찾을 패키지 이름 — claude·codex) */
export function resolveTarget(p: string, source: CliSource, platform: NodeJS.Platform = process.platform, name = 'claude'): CliTarget | null {
  if (!isFile(p)) return null;
  const lower = p.toLowerCase();
  if (/\.(c?js|mjs)$/.test(lower)) return { display: p, exec: p, node: 'node', source };
  const isShimExt = /\.(cmd|bat|ps1)$/.test(lower);
  if (!isShimExt) {
    // 리눅스 npm 설치: bin/claude → ../lib/node_modules/@anthropic-ai/claude-code/cli.js (심볼릭 링크)
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      // 그대로
    }
    if (/\.(c?js|mjs)$/i.test(real)) return { display: p, exec: real, node: 'node', source };
    if (platform === 'win32' && !lower.endsWith('.exe')) {
      // 확장자 없는 npm sh 스크립트 (Git Bash용) → 같은 폴더의 claude.cmd가 따로 있으므로 건너뜀
      const head = readHead(p);
      if (head.startsWith('#!')) return shimTarget(p, head, source, platform, name);
    }
    if (platform !== 'win32') {
      const head = readHead(p);
      if (head.startsWith('#!') && /basedir/.test(head) && /node_modules/.test(head)) return shimTarget(p, head, source, platform, name) ?? { display: p, exec: real, source };
    }
    return { display: p, exec: real, source };
  }
  return shimTarget(p, readHead(p, 16384), source, platform, name);
}

function readHead(p: string, n = 4096): string {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(n);
      const len = fs.readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, len).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function shimTarget(shim: string, text: string, source: CliSource, platform: NodeJS.Platform, name: string): CliTarget | null {
  const s = parseShim(text, name);
  if (!s) return null;
  const dir = path.dirname(shim);
  const target = path.resolve(dir, ...s.rel.split('/'));
  if (!isFile(target)) return null;
  if (/\.(c?js|mjs)$/i.test(target)) {
    const nodeExe = path.join(dir, platform === 'win32' ? 'node.exe' : 'node');
    return { display: shim, exec: target, node: s.nodeNextToShim && isFile(nodeExe) ? nodeExe : 'node', source };
  }
  return { display: shim, exec: target, source };
}

/** PATH에서 claude(또는 name) 찾기 (Windows `where claude`와 같은 순서: PATH 폴더마다 PATHEXT 확장자) */
export function searchPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, name = 'claude'): string[] {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = pathVar.split(sep).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const out: string[] = [];
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.ps1', '.bat'] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, `${name}${e}`);
      if (isFile(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** 찾아볼 후보 (실행해 보지 않음) */
export function candidates(opts: DiscoverOptions = {}): { path: string; source: CliSource }[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const out: { path: string; source: CliSource }[] = [];
  const add = (p: string | undefined, source: CliSource) => {
    if (p && !out.some((x) => x.path === p)) out.push({ path: p, source });
  };
  if (opts.cliPath) add(opts.cliPath, 'config');
  // PA_CLAUDE_CLI(시험용)를 주면 그것만 쓴다. 시험 모드(PA_E2E)에서도 PC의 claude를 찾지 않는다
  // (개발 환경의 실제 CLI·인증이 시험에 끼어들지 않게)
  if (env.PA_CLAUDE_CLI) {
    add(env.PA_CLAUDE_CLI, 'env');
    return out;
  }
  if (env.PA_E2E === '1' || env.PA_CLAUDE_NO_DISCOVERY === '1') return out;
  if (platform === 'win32') {
    const profile = env.USERPROFILE || home;
    add(path.join(profile, '.local', 'bin', 'claude.exe'), 'native');
    for (const p of searchPath(env, platform)) add(p, 'path');
    if (env.APPDATA) add(path.join(env.APPDATA, 'npm', 'claude.cmd'), 'npm');
  } else {
    for (const p of searchPath(env, platform)) add(p, 'path');
    add(path.join(home, '.local', 'bin', 'claude'), 'local');
    add(path.join(home, '.claude', 'local', 'claude'), 'local');
  }
  return out;
}

/** `<cli> --version` (15초, 창 없이) */
export function runVersion(t: CliTarget, env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<string> {
  const cmd = t.node ?? t.exec;
  const args = t.node ? [t.exec, '--version'] : ['--version'];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, env, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const why = e.killed ? '응답 없음(시간 초과)' : e.code === 'ENOENT' ? (t.node ? 'Node.js(node)를 찾지 못함' : '실행 파일 없음') : String(stderr || e.message).trim();
        reject(new Error(why));
        return;
      }
      resolve(String(stdout || stderr));
    });
  });
}

/** 후보 하나 확인: 실행 대상 찾기 → --version → 최소 버전 */
export async function checkCandidate(p: string, source: CliSource, opts: DiscoverOptions = {}): Promise<CliResult> {
  const platform = opts.platform ?? process.platform;
  const target = resolveTarget(p, source, platform);
  if (!target) {
    if (isFile(p)) return { ok: false, reason: 'broken', message: `Claude CLI 실행 파일을 해석하지 못했습니다: ${p}` };
    return { ok: false, reason: 'notfound', message: `파일이 없습니다: ${p}` };
  }
  const env = cleanEnvForCli(opts.env ?? process.env);
  let out: string;
  try {
    out = await (opts.runVersion ?? ((t, e) => runVersion(t, e, opts.timeoutMs)))(target, env);
  } catch (e) {
    return { ok: false, reason: 'broken', target, message: `Claude CLI를 실행하지 못했습니다 (${target.display}): ${(e as Error).message}` };
  }
  const version = parseVersion(out);
  if (!version) return { ok: false, reason: 'broken', target, message: `Claude CLI 버전을 읽지 못했습니다 (${target.display}): ${out.trim().slice(0, 120)}` };
  if (compareVersions(version, MIN_CLI_VERSION) < 0)
    return { ok: false, reason: 'old', target, version, message: `Claude CLI ${version}은 너무 오래된 버전입니다. ${MIN_CLI_VERSION} 이상으로 업데이트해 주세요 (claude update).` };
  return { ok: true, target, version };
}

/** 후보를 차례로 확인. 직접 지정한 경로(설정·PA_CLAUDE_CLI)가 있으면 그 결과를 그대로 쓴다 */
export async function discoverCli(opts: DiscoverOptions = {}): Promise<CliResult> {
  const list = candidates(opts);
  let firstProblem: CliMissing | null = null;
  for (const c of list) {
    if (!isFile(c.path)) {
      if ((c.source === 'config' || c.source === 'env') && !firstProblem)
        firstProblem = { ok: false, reason: 'notfound', message: `지정한 Claude CLI 경로에 파일이 없습니다: ${c.path}` };
      continue;
    }
    const r = await checkCandidate(c.path, c.source, opts);
    if (r.ok) return r;
    // 직접 지정한 파일이 있는데 실패하면 다른 것을 몰래 쓰지 않는다
    if (c.source === 'config' || c.source === 'env') return r;
    if (!firstProblem || firstProblem.reason === 'notfound') firstProblem = r;
  }
  return firstProblem ?? { ok: false, reason: 'notfound', message: 'PC에서 Claude CLI를 찾지 못했습니다. 설치한 뒤 다시 확인하거나 [경로 지정]으로 직접 지정해 주세요.' };
}

/** CLI에 넘기지 않는 앱 내부 변수 */
export function cleanEnvForCli(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const u = k.toUpperCase();
    // PA_FAKE_*: 시험용 가짜 CLI(test/fake-claude) 설정 — 실제 CLI에는 의미 없는 값
    if (u.startsWith('PA_') && !u.startsWith('PA_FAKE_')) continue;
    // 다른 Claude Code 안에서 앱을 띄운 경우의 표시 (중첩 실행으로 오해하지 않게)
    if (u === 'CLAUDECODE' || u === 'CLAUDE_CODE_ENTRYPOINT') continue;
    out[k] = v;
  }
  return out;
}
