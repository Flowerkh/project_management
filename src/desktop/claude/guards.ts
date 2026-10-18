// Claude가 쓰는 도구 막기·허용 (PreToolUse 훅과 canUseTool이 함께 쓰는 규칙)
// - 접속 정보 파일(isSecretFile)은 읽기·검색·수정 모두 거부
// - 파일 수정은 수정 허용 모드에서 작업 폴더(cwd) 안만. 계획 모드·원본 없는 대화는 거부 (Claude Code 계획 파일은 예외)
// - 작업 폴더 밖 파일은 읽지 않음 (원본 폴더에는 가리지 않은 접속 정보가 있으므로). Claude Code 자기 폴더의 계획·도구 결과 파일은 예외
// - 셸 명령은 허용 목록(앞부분 일치)에 있는 것만, 실행할 때마다 사용자 확인 (훅이 'ask'를 돌려 사용자 설정의 허용 규칙도 건너뜀)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMode } from '../../shared/desktop-api';
import { isSecretFile } from '../../shared/secrets';

export interface GuardContext {
  cwd: string;
  mode(): ChatMode;
  /** 원본 폴더 없이 연 대화 (ZIP·결과 파일): 수정·명령 불가 */
  readOnly: boolean;
  shellAllow: string[];
  /** Claude Code 설정 폴더 (~/.claude): plans/·projects/ 아래는 Claude Code가 스스로 쓰는 파일 */
  claudeDir: string;
  platform?: NodeJS.Platform;
}

export type GuardDecision = { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string } | { decision: 'none' };

export const MSG_SECRET_READ = '접속 정보 파일은 읽을 수 없습니다';
export const MSG_SECRET_WRITE = '접속 정보 파일은 고칠 수 없습니다';
export const MSG_PLAN_MODE = '계획 모드에서는 파일을 고칠 수 없습니다. 원인과 수정안을 먼저 설명하고, 고치려면 ExitPlanMode로 사용자 승인을 받으세요';
export const MSG_READONLY = '원본 폴더 없이 연 프로젝트라 파일을 만들거나 고칠 수 없습니다. 수정안만 설명해 주세요';
export const MSG_OUTSIDE_WRITE = '작업 폴더 밖의 파일은 고칠 수 없습니다';
export const MSG_OUTSIDE_READ = '작업 폴더 밖의 파일은 읽을 수 없습니다 (원본 폴더도 읽지 않습니다)';
export const MSG_NO_SHELL = '셸 명령은 허용되지 않았습니다 (설정의 허용 목록이 비어 있음). 명령 없이 진행하거나, 필요한 명령을 사용자에게 안내해 주세요';

export const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function P(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** 도구 입력의 경로를 절대 경로로 (Windows: /c/Users/… Git Bash 표기도) */
export function absPath(p: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  let s = String(p ?? '').trim();
  const pp = P(platform);
  if (platform === 'win32') {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:\\${m[2]}`;
    s = s.replace(/\//g, '\\');
  }
  if (s.startsWith('~')) s = pp.join(os.homedir(), s.slice(1));
  return pp.resolve(cwd, s);
}

export function isInside(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const pp = P(platform);
  const rel = pp.relative(pp.resolve(base), pp.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !pp.isAbsolute(rel));
}

/** 실제 경로(심볼릭 링크를 따라감)까지 base 안인지 (있는 파일만, 같은 OS에서만) */
function insideReal(base: string, target: string, platform: NodeJS.Platform): boolean {
  if (!isInside(base, target, platform)) return false;
  if (platform !== process.platform) return true;
  try {
    const realBase = fs.realpathSync(base);
    let t = target;
    // 아직 없는 파일이면 있는 부모까지 올라가 확인
    for (let i = 0; i < 64 && !fs.existsSync(t); i++) {
      const up = path.dirname(t);
      if (up === t) break;
      t = up;
    }
    return isInside(realBase, fs.realpathSync(t), platform);
  } catch {
    return true;
  }
}

export function isPlanFile(p: string, ctx: GuardContext): boolean {
  const platform = ctx.platform ?? process.platform;
  const pp = P(platform);
  const dir = pp.join(ctx.claudeDir, 'plans');
  return isInside(dir, p, platform) && /\.md$/i.test(p);
}

/** Claude Code가 스스로 남기는 파일 (계획, 너무 긴 도구 결과를 저장한 파일) — 읽기만 허용 */
function isClaudeOwnRead(p: string, ctx: GuardContext): boolean {
  const platform = ctx.platform ?? process.platform;
  const pp = P(platform);
  const name = pp.basename(p).toLowerCase();
  if (name === '.credentials.json' || name === '.claude.json' || name.endsWith('.oauth_token')) return false;
  if (isInside(pp.join(ctx.claudeDir, 'plans'), p, platform)) return true;
  if (isInside(pp.join(ctx.claudeDir, 'projects'), p, platform)) return true;
  // 백그라운드 작업 출력 등 (임시 폴더의 claude-… 폴더)
  const tmp = os.tmpdir();
  if (platform === process.platform && isInside(tmp, p, platform) && /[\\/]claude[^\\/]*[\\/]/i.test(p.slice(tmp.length))) return true;
  return false;
}

/** 도구 입력에서 다루는 경로 */
export function toolPaths(toolName: string, input: Record<string, unknown>, cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const out: string[] = [];
  const add = (v: unknown) => {
    const x = s(v);
    if (x) out.push(absPath(x, cwd, platform));
  };
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      add(input.file_path ?? input.path);
      break;
    case 'NotebookEdit':
    case 'NotebookRead':
      add(input.notebook_path ?? input.file_path);
      break;
    case 'Grep':
    case 'Glob':
    case 'LS':
      if (s(input.path)) add(input.path);
      else out.push(P(platform).resolve(cwd));
      break;
    default:
      break;
  }
  return out;
}

/** 셸 명령이 허용 목록에 맞는지: 명령을 &&·||·;·|·&로 나눈 모든 부분이 허용 항목으로 시작해야 한다 */
export function matchShellAllow(command: string, allow: string[], cwd: string, platform: NodeJS.Platform = process.platform): { ok: true } | { ok: false; reason: string } {
  const cmd = String(command ?? '').trim();
  if (!cmd) return { ok: false, reason: '빈 명령입니다' };
  if (!allow.length) return { ok: false, reason: MSG_NO_SHELL };
  if (/`|\$\(|<\(|>\(/.test(cmd)) return { ok: false, reason: '명령 치환($(…)·`…`)이 들어 있는 명령은 실행할 수 없습니다' };
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  const entries = allow.map(norm).filter(Boolean);
  // 출력 리디렉션은 작업 폴더 안 파일만
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\s*("?)([^\s"&|;]+)\1/g)) {
    const t = m[2];
    if (/^&\d$/.test(t) || /^\/dev\/null$/i.test(t) || /^nul$/i.test(t)) continue;
    if (!isInside(cwd, absPath(t, cwd, platform), platform)) return { ok: false, reason: `작업 폴더 밖으로 출력을 쓸 수 없습니다: ${t}` };
  }
  // 리디렉션(2>&1, > out.txt)은 떼고 명령 부분만 비교
  const stripped = cmd.replace(/\s*(?:\d|&)?>>?\s*(?:&\d+|"[^"]*"|[^\s&|;]+)?/g, ' ');
  const parts = stripped.split(/&&|\|\||[;&|\n]/).map(norm).filter(Boolean);
  if (!parts.length) return { ok: false, reason: '빈 명령입니다' };
  for (const part of parts) {
    // cd <작업 폴더 안> 은 허용 (Claude가 자주 붙임)
    const cd = /^cd(?:\s+\/d)?\s+("?)([^"]+)\1$/i.exec(part);
    if (cd) {
      if (isInside(cwd, absPath(cd[2], cwd, platform), platform)) continue;
      return { ok: false, reason: `작업 폴더 밖으로 이동할 수 없습니다: ${cd[2]}` };
    }
    const ok = entries.some((e) => part === e || part.startsWith(`${e} `));
    if (!ok) return { ok: false, reason: `허용 목록에 없는 명령입니다: ${part.length > 80 ? `${part.slice(0, 79)}…` : part}` };
  }
  return { ok: true };
}

/** PreToolUse 훅: 모든 도구 호출 전에 (사용자 설정의 허용 규칙보다 먼저) */
export function preToolUse(ctx: GuardContext, toolName: string, input: Record<string, unknown>): GuardDecision {
  const platform = ctx.platform ?? process.platform;
  const cwd = ctx.cwd;
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return { decision: 'deny', reason: '이 앱에서는 인터넷 검색·웹 페이지 읽기를 쓰지 않습니다' };
  if (toolName === 'AskUserQuestion') return { decision: 'deny', reason: '질문이 있으면 답변 글로 물어보세요 (이 앱은 선택 질문 창을 띄우지 않습니다)' };
  if (toolName === 'EnterPlanMode') return { decision: 'deny', reason: '모드는 사용자가 앱에서 바꿉니다' };
  if (toolName === 'EnterWorktree' || toolName === 'ExitWorktree') return { decision: 'deny', reason: '이 앱의 작업 사본에서만 작업합니다' };

  if (WRITE_TOOLS.has(toolName)) {
    const paths = toolPaths(toolName, input, cwd, platform);
    if (!paths.length) return { decision: 'deny', reason: '고칠 파일 경로가 없습니다' };
    for (const p of paths) {
      if (isPlanFile(p, ctx)) continue; // Claude Code 계획 파일 (계획 모드에서 쓰는 유일한 파일)
      if (isSecretFile(p)) return { decision: 'deny', reason: MSG_SECRET_WRITE };
      if (ctx.readOnly) return { decision: 'deny', reason: MSG_READONLY };
      if (ctx.mode() !== 'edit') return { decision: 'deny', reason: MSG_PLAN_MODE };
      if (!insideReal(cwd, p, platform)) return { decision: 'deny', reason: MSG_OUTSIDE_WRITE };
    }
    return { decision: 'none' };
  }

  if (READ_TOOLS.has(toolName)) {
    for (const p of toolPaths(toolName, input, cwd, platform)) {
      if (isSecretFile(p)) return { decision: 'deny', reason: MSG_SECRET_READ };
      if (!insideReal(cwd, p, platform) && !isClaudeOwnRead(p, ctx)) return { decision: 'deny', reason: MSG_OUTSIDE_READ };
    }
    // Grep의 glob이 접속 정보 파일 이름을 직접 가리키면 거부
    const g = typeof input.glob === 'string' ? input.glob : '';
    if (g && isSecretFile(g.replace(/^.*[\\/]/, ''))) return { decision: 'deny', reason: MSG_SECRET_READ };
    return { decision: 'none' };
  }

  if (SHELL_TOOLS.has(toolName)) {
    if (ctx.readOnly) return { decision: 'deny', reason: '원본 폴더 없이 연 프로젝트에서는 명령을 실행할 수 없습니다' };
    if (input.run_in_background === true) return { decision: 'deny', reason: '백그라운드 명령은 실행할 수 없습니다. 끝날 때까지 기다리는 명령으로 실행해 주세요' };
    const m = matchShellAllow(String(input.command ?? ''), ctx.shellAllow, cwd, platform);
    if (!m.ok) return { decision: 'deny', reason: m.reason };
    // 사용자 설정에 허용 규칙이 있어도 매번 사용자에게 묻게 한다 (MSG-24)
    return { decision: 'ask', reason: '허용 목록의 명령도 실행할 때마다 사용자가 확인합니다' };
  }

  if (toolName.startsWith('mcp__')) {
    if (toolName.startsWith('mcp__projdb__')) return { decision: 'none' };
    return { decision: 'deny', reason: '이 앱에서 제공하지 않는 MCP 도구입니다' };
  }
  return { decision: 'none' };
}

/** canUseTool의 기본 판단 (사용자에게 묻는 ExitPlanMode·셸 명령은 manager가 처리) */
export function permissionDefault(ctx: GuardContext, toolName: string, input: Record<string, unknown>): { allow: true } | { allow: false; reason: string } {
  const pre = preToolUse(ctx, toolName, input);
  if (pre.decision === 'deny') return { allow: false, reason: pre.reason };
  if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) return { allow: true };
  if (toolName.startsWith('mcp__projdb__')) return { allow: true };
  if (toolName === 'TodoWrite' || toolName === 'Agent' || toolName === 'Task') return { allow: true };
  return { allow: false, reason: `이 앱에서는 ${toolName} 도구를 쓸 수 없습니다` };
}

/**
 * Claude Code의 권한 거부 규칙 (Read 규칙은 Grep·Glob 검색에도 적용됨 — 훅이 놓치는 디렉터리 검색 결과에서 접속 정보 파일을 뺀다).
 * isSecretFile과 같은 이름들 (.env.example 같은 예시 파일은 규칙에 넣지 않음).
 */
export function secretDenyRules(): string[] {
  const names: string[] = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.dev', '.env.prod', '.env.qa', '.env.stage', '.env.staging', '.env.development.local', '.env.production.local', '.env.test.local'];
  for (const b of ['globals', 'jdbc', 'db', 'database', 'datasource', 'dbconfig', 'db-config', 'db_config', 'dbinfo', 'connection'])
    for (const e of ['properties', 'conf', 'ini', 'cfg']) names.push(`${b}.${e}`);
  for (const b of ['wp-config', 'dbconn', 'db_conn', 'dbconnect', 'db_connect', 'dbinfo', 'db_info']) names.push(`${b}.php`);
  for (const b of ['credentials', 'secret', 'secrets']) for (const e of ['json', 'yaml', 'yml', 'properties', 'xml', 'ini', 'toml']) names.push(`${b}.${e}`);
  names.push('id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub', 'id_ecdsa', 'id_ecdsa.pub', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore');
  return names.map((n) => `Read(**/${n})`);
}
