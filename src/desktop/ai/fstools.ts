// 앱이 만든 파일·명령 도구 (Gemini처럼 자기 도구가 없는 AI용). 이름·입력은 Claude 도구 모양:
//   LS {path} · Glob {pattern, path} · Grep {pattern, path, glob, -i, output_mode} · Read {file_path, offset, limit}
//   Edit {file_path, old_string, new_string, replace_all} · Write {file_path, content} · Bash {command}
// 막기 규칙(접속 정보 파일·작업 폴더 밖·계획 모드)은 실행 전에 대화 관리가 guards.ts로 확인한다.
// 여기서는 폴더를 훑는 도구(Glob·Grep·LS)가 찾은 파일 중 접속 정보 파일을 빼고, 크기·개수 한도를 지킨다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import { isSecretFile } from '../../shared/secrets';
import { cleanEnvForCli } from '../claude/cli';
import { absPath, isInside } from '../claude/guards';
import { looksBinary } from '../work/encoding';
import { Aborted, type ToolOutcome } from './agent-query';

export interface FsToolContext {
  cwd: string;
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  /** 명령 제한 시간 (기본 10분) */
  commandTimeoutMs?: number;
}

/** 폴더를 훑을 때 들어가지 않는 폴더 (직접 path로 주면 그 안은 봄) */
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.idea', '.gradle', 'target', 'build', 'dist', 'out', '__pycache__', '.venv', 'venv', 'vendor', '.next', '.nuxt', 'coverage', '.pa-backup']);
const MAX_WALK = 30000;
const MAX_READ_LINES = 2000;
const MAX_LINE = 2000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_GREP_FILE = 2 * 1024 * 1024;
const MAX_HITS = 300;
const MAX_GLOB = 200;
const MAX_LS = 500;
const MAX_OUT = 30000;

const ok = (text: string, structured?: unknown): ToolOutcome => ({ text, isError: false, ...(structured !== undefined ? { structured } : {}) });
const fail = (text: string): ToolOutcome => ({ text, isError: true });

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function relOf(cwd: string, abs: string, platform: NodeJS.Platform): string {
  const pp = platform === 'win32' ? path.win32 : path.posix;
  const r = pp.relative(pp.resolve(cwd), abs);
  return r ? r.split(pp.sep).join('/') : '.';
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new Aborted();
}

/** glob 패턴 → 정규식 (경로 구분자 '/'): ** · * · ? · [abc] · {a,b} */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; ) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        if (atStart && g[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const j = g.indexOf(']', i + 2);
      if (j > i) {
        let cls = g.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = j + 1;
        continue;
      }
    }
    if (c === '{') {
      depth++;
      re += '(?:';
      i++;
      continue;
    }
    if (c === '}' && depth) {
      depth--;
      re += ')';
      i++;
      continue;
    }
    if (c === ',' && depth) {
      re += '|';
      i++;
      continue;
    }
    re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    i++;
  }
  while (depth-- > 0) re += ')';
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

interface WalkEntry {
  rel: string;
  abs: string;
}

/** base 아래 파일 (심볼릭 링크는 따라가지 않음). rel은 cwd 기준 */
async function walkFiles(cwd: string, base: string, ctx: FsToolContext, onFile: (e: WalkEntry) => boolean | void): Promise<{ truncated: boolean }> {
  const platform = ctx.platform ?? process.platform;
  let seen = 0;
  const stack: string[] = [base];
  while (stack.length) {
    check(ctx.signal);
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // 이름순: 폴더 안의 파일을 먼저, 그다음 하위 폴더를 차례로
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) subdirs.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (++seen > MAX_WALK) return { truncated: true };
      if (onFile({ rel: relOf(cwd, abs, platform), abs }) === false) return { truncated: true };
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  return { truncated: false };
}

function decodeText(buf: Buffer): string {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

// ------------------------------------------------------------------ 도구

async function toolLs(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const abs = absPath(str(input.path) || '.', ctx.cwd, platform);
  let ents: fs.Dirent[];
  try {
    ents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return fail(`폴더를 읽지 못했습니다: ${relOf(ctx.cwd, abs, platform)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  const dirs = ents.filter((e) => e.isDirectory()).map((e) => `${e.name}/`).sort();
  const files = ents
    .filter((e) => e.isFile())
    .map((e) => (isSecretFile(e.name) ? `${e.name}  (접속 정보 파일 — 읽을 수 없음)` : e.name))
    .sort();
  const all = [...dirs, ...files];
  const shown = all.slice(0, MAX_LS);
  const where = relOf(ctx.cwd, abs, platform);
  const head = `${where === '.' ? '작업 폴더' : where} — 폴더 ${dirs.length}개 · 파일 ${files.length}개`;
  return ok([head, ...shown, ...(all.length > shown.length ? [`…(${all.length - shown.length}개 더 있음)`] : [])].join('\n'));
}

async function toolGlob(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const pattern = str(input.pattern).trim();
  if (!pattern) return fail('pattern이 비어 있습니다');
  const base = absPath(str(input.path) || '.', ctx.cwd, platform);
  const baseRel = relOf(ctx.cwd, base, platform);
  // 'Order*.java'처럼 '/'가 없으면 어느 폴더에서든 파일 이름으로 맞춘다
  const byName = !pattern.includes('/');
  const re = globToRegExp(pattern, platform === 'win32');
  const hits: { rel: string; abs: string; t: number }[] = [];
  const { truncated } = await walkFiles(ctx.cwd, base, ctx, (e) => {
    if (isSecretFile(e.rel)) return;
    const sub = baseRel === '.' ? e.rel : e.rel.slice(baseRel.length + 1);
    if (!re.test(byName ? path.posix.basename(sub) : sub)) return;
    hits.push({ ...e, t: 0 });
  });
  for (const h of hits) h.t = (await fsp.stat(h.abs).catch(() => null))?.mtimeMs ?? 0;
  hits.sort((a, b) => b.t - a.t || (a.rel < b.rel ? -1 : 1));
  const shown = hits.slice(0, MAX_GLOB).map((h) => h.rel);
  if (!hits.length) return ok('No files found', { numFiles: 0, filenames: [] });
  const more = hits.length > shown.length ? [`…(${hits.length - shown.length}개 더 있음 — 패턴을 좁혀 주세요)`] : [];
  return ok([...shown, ...more, ...(truncated ? ['(파일이 너무 많아 일부 폴더만 찾았습니다)'] : [])].join('\n'), { numFiles: hits.length, filenames: shown });
}

async function toolGrep(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const pattern = str(input.pattern);
  if (!pattern) return fail('pattern이 비어 있습니다');
  let re: RegExp;
  try {
    re = new RegExp(pattern, input['-i'] ? 'i' : '');
  } catch (e) {
    return fail(`정규식이 올바르지 않습니다: ${(e as Error).message}`);
  }
  const filesOnly = input.output_mode === 'files_with_matches';
  const target = absPath(str(input.path) || '.', ctx.cwd, platform);
  const g = str(input.glob).trim();
  const gre = g ? globToRegExp(g, platform === 'win32') : null;
  const gByName = !!g && !g.includes('/');
  const lines: string[] = [];
  const files: string[] = [];
  let matches = 0;
  let stopped = false;
  const searchFile = async (abs: string, rel: string) => {
    if (isSecretFile(rel)) return;
    if (gre && !gre.test(gByName ? path.posix.basename(rel) : rel)) return;
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || st.size > MAX_GREP_FILE) return;
    const buf = await fsp.readFile(abs).catch(() => null);
    if (!buf || looksBinary(buf)) return;
    const text = decodeText(buf);
    if (!re.test(text)) return;
    files.push(rel);
    if (filesOnly) return;
    const ls = text.split(/\r?\n/);
    for (let i = 0; i < ls.length; i++) {
      if (!re.test(ls[i])) continue;
      matches++;
      if (lines.length < MAX_HITS) {
        const l = ls[i].length > 300 ? `${ls[i].slice(0, 299)}…` : ls[i];
        lines.push(`${rel}:${i + 1}: ${l}`);
      } else stopped = true;
    }
  };
  const st = await fsp.stat(target).catch(() => null);
  if (!st) return fail(`경로가 없습니다: ${relOf(ctx.cwd, target, platform)}`);
  let truncated = false;
  if (st.isFile()) await searchFile(target, relOf(ctx.cwd, target, platform));
  else {
    const list: WalkEntry[] = [];
    truncated = (await walkFiles(ctx.cwd, target, ctx, (e) => void list.push(e))).truncated;
    for (const e of list) {
      check(ctx.signal);
      await searchFile(e.abs, e.rel);
      if (files.length >= MAX_HITS * 4) {
        stopped = true;
        break;
      }
    }
  }
  if (!files.length) return ok('No matches found', { mode: filesOnly ? 'files_with_matches' : 'content', numFiles: 0, numMatches: 0 });
  const tail = [...(stopped ? ['…(결과가 많아 일부만 보여 줍니다 — 검색어나 경로를 좁혀 주세요)'] : []), ...(truncated ? ['(파일이 너무 많아 일부 폴더만 찾았습니다)'] : [])];
  if (filesOnly) return ok([`Found ${files.length} files`, ...files.slice(0, MAX_HITS), ...tail].join('\n'), { mode: 'files_with_matches', numFiles: files.length });
  return ok([`Found ${matches} matches in ${files.length} files`, ...lines, ...tail].join('\n'), { mode: 'content', numFiles: files.length, numMatches: matches });
}

async function toolRead(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const p = str(input.file_path);
  if (!p) return fail('file_path가 비어 있습니다');
  const abs = absPath(p, ctx.cwd, platform);
  const rel = relOf(ctx.cwd, abs, platform);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return fail(`파일이 없습니다: ${rel}`);
  if (st.isDirectory()) return fail(`${rel}은(는) 폴더입니다. 목록은 list_dir로 보세요`);
  const buf = await fsp.readFile(abs);
  if (looksBinary(buf)) return fail(`${rel}은(는) 글자 파일이 아닙니다 (${st.size}바이트)`);
  const all = decodeText(buf).split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  if (!all.length) return ok(`(빈 파일: ${rel})`);
  const offset = typeof input.offset === 'number' && input.offset > 1 ? Math.floor(input.offset) : 1;
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(Math.floor(input.limit), MAX_READ_LINES) : MAX_READ_LINES;
  if (offset > all.length) return fail(`${rel}은(는) ${all.length}줄입니다 (offset ${offset})`);
  const out: string[] = [];
  let size = 0;
  let last = offset - 1;
  for (let i = offset - 1; i < Math.min(all.length, offset - 1 + limit); i++) {
    const l = all[i].length > MAX_LINE ? `${all[i].slice(0, MAX_LINE)}…(줄이 길어 잘림)` : all[i];
    const line = `${String(i + 1).padStart(6)}\t${l}`;
    if (size + line.length > MAX_READ_BYTES) break;
    out.push(line);
    size += line.length + 1;
    last = i + 1;
  }
  if (last < all.length) out.push(`…(${rel}은(는) ${all.length}줄 — ${last}줄까지 보여 줌. 이어서 보려면 offset ${last + 1})`);
  return ok(out.join('\n'));
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function snippet(text: string, line: number, count: number): string {
  const ls = text.split(/\r?\n/);
  const from = Math.max(1, line - 2);
  const to = Math.min(ls.length, line + count + 2);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(6)}\t${ls[i - 1] ?? ''}`);
  return out.join('\n');
}

async function toolEdit(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const p = str(input.file_path);
  if (!p) return fail('file_path가 비어 있습니다');
  const abs = absPath(p, ctx.cwd, platform);
  const rel = relOf(ctx.cwd, abs, platform);
  let oldS = typeof input.old_string === 'string' ? input.old_string : '';
  let newS = typeof input.new_string === 'string' ? input.new_string : '';
  if (!oldS) return fail('old_string이 비어 있습니다. 새 파일은 write_file로 만드세요');
  if (oldS === newS) return fail('old_string과 new_string이 같습니다');
  const buf = await fsp.readFile(abs).catch(() => null);
  if (!buf) return fail(`파일이 없습니다: ${rel} (새 파일은 write_file로 만드세요)`);
  if (looksBinary(buf)) return fail(`${rel}은(는) 글자 파일이 아니라 고칠 수 없습니다`);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = decodeText(buf);
  // 줄바꿈이 CRLF인 파일: 모델이 LF로 보낸 글을 CRLF로 맞춘다
  if (!text.includes(oldS) && text.includes('\r\n') && oldS.includes('\n')) {
    oldS = oldS.replace(/\r?\n/g, '\r\n');
    newS = newS.replace(/\r?\n/g, '\r\n');
  }
  let count = 0;
  for (let i = text.indexOf(oldS); i >= 0; i = text.indexOf(oldS, i + oldS.length)) count++;
  if (!count) return fail(`${rel}에서 old_string을 찾지 못했습니다. 파일을 다시 읽고 들여쓰기·공백까지 똑같이 넣어 주세요`);
  if (count > 1 && input.replace_all !== true) return fail(`old_string이 ${rel}에 ${count}곳 있습니다. 앞뒤 줄을 더 넣어 한 곳만 맞게 하거나 replace_all을 쓰세요`);
  const first = text.indexOf(oldS);
  const next = input.replace_all === true ? text.split(oldS).join(newS) : text.slice(0, first) + newS + text.slice(first + oldS.length);
  await fsp.writeFile(abs, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(next, 'utf8')]) : Buffer.from(next, 'utf8'));
  const line = lineOf(next, first);
  const newLines = newS.split('\n').length;
  return ok(`${rel}을(를) 고쳤습니다 (${count}곳). 바뀐 부분:\n${snippet(next, line, Math.min(newLines, 30))}`, { structuredPatch: [{ newStart: line }] });
}

async function toolWrite(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const p = str(input.file_path);
  if (!p) return fail('file_path가 비어 있습니다');
  if (typeof input.content !== 'string') return fail('content가 없습니다');
  const abs = absPath(p, ctx.cwd, platform);
  const rel = relOf(ctx.cwd, abs, platform);
  const st = await fsp.stat(abs).catch(() => null);
  if (st?.isDirectory()) return fail(`${rel}은(는) 폴더입니다`);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, input.content, 'utf8');
  const lines = input.content.split('\n').length;
  return ok(`${rel}을(를) ${st ? '다시 썼습니다' : '만들었습니다'} (${lines}줄)`, { type: st ? 'update' : 'create', structuredPatch: [{ newStart: 1 }] });
}

/** 명령 출력: UTF-8이 아니면 (Windows 한글) CP949로 */
function decodeOutput(buf: Buffer, platform: NodeJS.Platform): string {
  const s = buf.toString('utf8');
  if (platform === 'win32' && s.includes('�')) return iconv.decode(buf, 'cp949');
  return s;
}

function clipOutput(s: string): string {
  if (s.length <= MAX_OUT) return s;
  const head = s.slice(0, 8000);
  const tail = s.slice(s.length - (MAX_OUT - 8000));
  return `${head}\n…(출력 ${s.length - MAX_OUT}글자 생략)…\n${tail}`;
}

function killTree(pid: number | undefined, platform: NodeJS.Platform): void {
  if (!pid) return;
  try {
    if (platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // 이미 끝남
  }
}

async function toolBash(input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  const command = str(input.command).trim();
  if (!command) return fail('command가 비어 있습니다');
  const timeoutMs = ctx.commandTimeoutMs ?? 10 * 60 * 1000;
  return new Promise<ToolOutcome>((resolve, reject) => {
    // 출력: 앞 16KB와 마지막 64KB만 모은다 (빌드 로그가 아주 길 수 있음)
    const HEAD = 16 * 1024;
    const TAIL = 64 * 1024;
    let head = Buffer.alloc(0);
    const tail: Buffer[] = [];
    let tailLen = 0;
    let total = 0;
    let timedOut = false;
    const t0 = Date.now();
    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
      windowsHide: true,
      detached: platform !== 'win32',
      env: cleanEnvForCli(process.env) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const take = (chunk: Buffer) => {
      let d = chunk;
      total += d.length;
      if (head.length < HEAD) {
        const n = Math.min(HEAD - head.length, d.length);
        head = Buffer.concat([head, d.subarray(0, n)]);
        d = d.subarray(n);
      }
      if (!d.length) return;
      tail.push(d);
      tailLen += d.length;
      while (tail.length > 1 && tailLen - tail[0].length > TAIL) tailLen -= tail.shift()!.length;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, platform);
    }, timeoutMs);
    const onAbort = () => killTree(child.pid, platform);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve(fail(`명령을 실행하지 못했습니다: ${e.message}`));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (ctx.signal.aborted) {
        reject(new Aborted());
        return;
      }
      const skipped = total - head.length - tailLen;
      const body = skipped > 0 ? `${decodeOutput(head, platform)}\n…(출력 ${skipped}바이트 생략)…\n${decodeOutput(Buffer.concat(tail), platform)}` : decodeOutput(Buffer.concat([head, ...tail]), platform);
      const out = clipOutput(body.trimEnd());
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (timedOut) resolve(fail(`${Math.round(timeoutMs / 60000)}분 안에 끝나지 않아 멈췄습니다\n${out}`));
      else if (code === 0) resolve(ok(`종료 코드 0 (${secs}초)\n${out || '(출력 없음)'}`));
      else resolve(fail(`종료 코드 ${code ?? sig} (${secs}초)\n${out || '(출력 없음)'}`));
    });
  });
}

export const FS_TOOLS = new Set(['LS', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Bash']);

/** 파일·명령 도구 실행 (권한 확인을 마친 뒤) */
export async function runFsTool(name: string, input: Record<string, unknown>, ctx: FsToolContext): Promise<ToolOutcome> {
  const platform = ctx.platform ?? process.platform;
  // 막기 규칙은 대화 관리가 이미 확인했지만, 폴더를 바꿔 가는 실수를 한 번 더 막는다
  const target = str(input.file_path) || str(input.path);
  if (target && name !== 'Bash' && !isInside(ctx.cwd, absPath(target, ctx.cwd, platform), platform)) return fail('작업 폴더 밖은 다룰 수 없습니다');
  switch (name) {
    case 'LS':
      return toolLs(input, ctx);
    case 'Glob':
      return toolGlob(input, ctx);
    case 'Grep':
      return toolGrep(input, ctx);
    case 'Read':
      return toolRead(input, ctx);
    case 'Edit':
      return toolEdit(input, ctx);
    case 'Write':
      return toolWrite(input, ctx);
    case 'Bash':
      return toolBash(input, ctx);
    default:
      return fail(`이 앱에 없는 도구입니다: ${name}`);
  }
}
