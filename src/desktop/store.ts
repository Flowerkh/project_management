// 앱 데이터 저장: host().dataDir 아래 JSON·JSONL 파일과 암호화한 비밀 값.
//   projects/<프로젝트ID>/project.json   프로젝트 연결 설정
//   projects/<프로젝트ID>/db.json        DB 연결 (비밀번호 제외)
//   projects/<프로젝트ID>/history.jsonl  작업 이력 (추가만)
//   projects/<프로젝트ID>/conversations/ Claude 대화
//   work/<작업 사본 ID>/                  작업 사본
//   secrets.json                         암호화한 비밀 값 (API 키, DB 비밀번호)
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { host } from './host';

export function dataDir(): string {
  return host().dataDir;
}

/** 경로 비교용 키: 절대 경로, 구분자 통일, Windows는 대소문자 무시 */
export function rootKey(root: string): string {
  let p = path.resolve(root).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || /^[A-Za-z]:/.test(p)) p = p.toLowerCase();
  return p.replace(/\\/g, '/');
}

function slug(s: string): string {
  return (
    s
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

export function shortHash(s: string, n = 10): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
}

/** 프로젝트 ID: 폴더이름-경로해시 */
export function projectId(root: string): string {
  return `${slug(path.basename(path.resolve(root)))}-${shortHash(rootKey(root))}`;
}

export function projectDir(root: string): string {
  const d = path.join(dataDir(), 'projects', projectId(root));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function workDir(): string {
  const d = path.join(dataDir(), 'work');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 새 ID: 시간순으로 정렬되는 짧은 문자열 */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return `${prefix}${t}${r}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ------------------------------------------------------------------ 잠금 (같은 파일 쓰기를 차례로)

const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

// ------------------------------------------------------------------ JSON

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 임시 파일에 쓰고 이름을 바꿔, 쓰다가 꺼져도 파일이 깨지지 않게 한다 */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  await renameRetry(tmp, file);
}

async function renameRetry(from: string, to: string): Promise<void> {
  // Windows에서 백신·인덱서가 파일을 잠깐 잡고 있으면 EPERM이 날 수 있다
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 6 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await fsp.rm(from, { force: true }).catch(() => undefined);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

/** 한 줄에 JSON 하나씩 추가 (작업 이력처럼 추가만 하는 기록) */
export async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      // 깨진 줄은 건너뜀 (쓰다가 꺼진 마지막 줄 등)
    }
  }
  return out;
}

// ------------------------------------------------------------------ 비밀 값 (API 키, DB 비밀번호)
// Windows는 DPAPI(사용자 계정 기준 암호화)로 암호화해 secrets.json에 둔다. 화면·Claude에는 보내지 않는다.

type SecretFile = Record<string, string>;

function secretsPath(): string {
  return path.join(dataDir(), 'secrets.json');
}

export async function setSecret(key: string, value: string | null): Promise<void> {
  await withLock('secrets', async () => {
    const all = await readJson<SecretFile>(secretsPath(), {});
    if (value === null || value === '') delete all[key];
    else {
      const enc = host().encrypt(value);
      if (!enc) throw new Error('이 PC에서 비밀 값을 암호화할 수 없어 저장하지 않았습니다');
      all[key] = enc.toString('base64');
    }
    await writeJson(secretsPath(), all);
  });
}

export async function getSecret(key: string): Promise<string | null> {
  const all = await readJson<SecretFile>(secretsPath(), {});
  const v = all[key];
  if (!v) return null;
  try {
    return host().decrypt(Buffer.from(v, 'base64'));
  } catch {
    return null;
  }
}

export async function hasSecret(key: string): Promise<boolean> {
  const all = await readJson<SecretFile>(secretsPath(), {});
  return !!all[key];
}

/** 접두어로 시작하는 비밀 값을 모두 지운다 (DB 연결 삭제 등) */
export async function deleteSecrets(prefix: string): Promise<void> {
  await withLock('secrets', async () => {
    const all = await readJson<SecretFile>(secretsPath(), {});
    let changed = false;
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) {
        delete all[k];
        changed = true;
      }
    }
    if (changed) await writeJson(secretsPath(), all);
  });
}
