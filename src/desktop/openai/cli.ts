// Codex CLI 찾기·버전 확인 (ChatGPT 연동은 PC의 Codex를 `codex app-server`로 띄워 쓴다 — Codex는 수정하지 않음)
// 찾는 순서: 설정의 cliPath → PA_CODEX_CLI(시험용) → PATH의 codex(.exe/.cmd/.ps1) → Windows: %APPDATA%\npm\codex.cmd,
//   %USERPROFILE%\.local\bin\codex.exe / Linux·mac(개발용): ~/.local/bin/codex.
// npm으로 설치한 codex.cmd(셸 스크립트)는 안에 적힌 node_modules/@openai/codex/bin/codex.js를 node로 실행한다.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { type CliMissing, type CliResult, type CliSource, type CliTarget, cleanEnvForCli, compareVersions, parseVersion, resolveTarget, runVersion, searchPath } from '../claude/cli';

/**
 * 지원하는 가장 낮은 Codex 버전. 앱이 쓰는 것: app-server의 실험 API(동적 도구 dynamicTools·baseInstructions),
 * 기능 끄기(features.shell_tool·unified_exec·view_image 등), 공급자 인증 명령(model_providers.*.auth).
 * 실제 Codex로 시험(test/desktop-openai-real.test.ts): 0.150.0·0.163.0 통과. 0.146.0은 view_image(경로로 이미지 읽기)를
 * 끌 수 없어 작업 폴더 밖 이미지를 AI에 보낼 수 있으므로 지원하지 않는다.
 */
export const MIN_CODEX_VERSION = '0.150.0';

export interface CodexDiscoverOptions {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  runVersion?: (t: CliTarget, env: NodeJS.ProcessEnv) => Promise<string>;
  timeoutMs?: number;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function codexCandidates(opts: CodexDiscoverOptions = {}): { path: string; source: CliSource }[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const out: { path: string; source: CliSource }[] = [];
  const add = (p: string | undefined, source: CliSource) => {
    if (p && !out.some((x) => x.path === p)) out.push({ path: p, source });
  };
  if (opts.cliPath) add(opts.cliPath, 'config');
  // 시험: PA_CODEX_CLI만 쓴다. 시험 모드(PA_E2E)에서는 PC의 codex를 찾지 않는다 (실제 계정·로그인이 끼어들지 않게)
  if (env.PA_CODEX_CLI) {
    add(env.PA_CODEX_CLI, 'env');
    return out;
  }
  if (env.PA_E2E === '1' || env.PA_CODEX_NO_DISCOVERY === '1') return out;
  for (const p of searchPath(env, platform, 'codex')) add(p, 'path');
  if (platform === 'win32') {
    if (env.APPDATA) add(path.join(env.APPDATA, 'npm', 'codex.cmd'), 'npm');
    add(path.join(env.USERPROFILE || home, '.local', 'bin', 'codex.exe'), 'native');
  } else {
    add(path.join(home, '.local', 'bin', 'codex'), 'local');
  }
  return out;
}

export async function checkCodex(p: string, source: CliSource, opts: CodexDiscoverOptions = {}): Promise<CliResult> {
  const platform = opts.platform ?? process.platform;
  const target = resolveTarget(p, source, platform, 'codex');
  if (!target) {
    if (isFile(p)) return { ok: false, reason: 'broken', message: `Codex 실행 파일을 해석하지 못했습니다: ${p}` };
    return { ok: false, reason: 'notfound', message: `파일이 없습니다: ${p}` };
  }
  const env = cleanEnvForCli(opts.env ?? process.env);
  let out: string;
  try {
    out = await (opts.runVersion ?? ((t, e) => runVersion(t, e, opts.timeoutMs)))(target, env);
  } catch (e) {
    return { ok: false, reason: 'broken', target, message: `Codex를 실행하지 못했습니다 (${target.display}): ${(e as Error).message}` };
  }
  const version = parseVersion(out);
  if (!version) return { ok: false, reason: 'broken', target, message: `Codex 버전을 읽지 못했습니다 (${target.display}): ${out.trim().slice(0, 120)}` };
  if (compareVersions(version, MIN_CODEX_VERSION) < 0)
    return { ok: false, reason: 'old', target, version, message: `Codex ${version}은 너무 오래된 버전입니다. ${MIN_CODEX_VERSION} 이상으로 업데이트해 주세요 (npm install -g @openai/codex@latest).` };
  return { ok: true, target, version };
}

export async function discoverCodex(opts: CodexDiscoverOptions = {}): Promise<CliResult> {
  let firstProblem: CliMissing | null = null;
  for (const c of codexCandidates(opts)) {
    if (!isFile(c.path)) {
      if ((c.source === 'config' || c.source === 'env') && !firstProblem) firstProblem = { ok: false, reason: 'notfound', message: `지정한 Codex 경로에 파일이 없습니다: ${c.path}` };
      continue;
    }
    const r = await checkCodex(c.path, c.source, opts);
    if (r.ok) return r;
    if (c.source === 'config' || c.source === 'env') return r;
    if (!firstProblem || firstProblem.reason === 'notfound') firstProblem = r;
  }
  return firstProblem ?? { ok: false, reason: 'notfound', message: 'PC에서 Codex CLI를 찾지 못했습니다. 설치(npm install -g @openai/codex)한 뒤 다시 확인하거나 [경로 지정]으로 직접 지정해 주세요.' };
}
