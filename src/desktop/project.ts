// 프로젝트 연결 설정 (POP-04): 적용 기본값, DB 환경별 규칙, 개인정보 가림 대상, 메뉴 DB 읽기.
// DB 연결 목록은 db 모듈이 따로 보관하고, get()이 합쳐서 돌려준다.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MASK, DEFAULT_RULES, type Env, type EnvRule, type ProjectSettings } from '../shared/desktop-api';
import { handle } from './ipc';
import { services, type ProjectService } from './services';
import { projectDir, readJson, withLock, writeJson } from './store';

type Stored = Omit<ProjectSettings, 'db'>;

const ENVS: Env[] = ['dev', 'qa', 'prod'];

function file(root: string): string {
  return path.join(projectDir(root), 'project.json');
}

function clampRule(env: Env, r: Partial<EnvRule> | undefined): EnvRule {
  const d = DEFAULT_RULES[env];
  const n = (v: unknown, lo: number, hi: number, dv: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : dv;
  };
  const rule: EnvRule = {
    selectMode: r?.selectMode === 'auto' || r?.selectMode === 'confirm' ? r.selectMode : d.selectMode,
    maxRows: n(r?.maxRows, 1, 5000, d.maxRows),
    timeoutSec: n(r?.timeoutSec, 1, 600, d.timeoutSec),
    changeMode: r?.changeMode === 'confirm' || r?.changeMode === 'typeName' ? r.changeMode : d.changeMode,
    mask: typeof r?.mask === 'boolean' ? r.mask : d.mask,
  };
  // 운영 조회 확인과 운영 변경의 DB 이름 입력은 끌 수 없다 (기획서 8.6)
  if (env === 'prod') {
    rule.selectMode = 'confirm';
    rule.changeMode = 'typeName';
  }
  return rule;
}

function normalize(root: string, name: string | undefined, s: Partial<Stored>): Stored {
  const rules = {} as Record<Env, EnvRule>;
  for (const e of ENVS) rules[e] = clampRule(e, s.dbRules?.[e]);
  return {
    root,
    name: (s.name || name || path.basename(path.resolve(root))).slice(0, 120),
    applyDefaults: { commit: !!s.applyDefaults?.commit, push: !!s.applyDefaults?.commit && !!s.applyDefaults?.push },
    dbRules: rules,
    maskPatterns: Array.isArray(s.maskPatterns) ? s.maskPatterns.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : [...DEFAULT_MASK],
    menuDb: s.menuDb && typeof s.menuDb === 'object' ? { ...s.menuDb, enabled: !!s.menuDb.enabled } : undefined,
  };
}

export const projectService: ProjectService = {
  async get(root, name) {
    const stored = await readJson<Partial<Stored>>(file(root), {});
    const s = normalize(root, name, stored);
    const db = services.db ? await services.db.list(root).catch(() => []) : [];
    return { ...s, db };
  },
  async set(root, patch) {
    return withLock(file(root), async () => {
      const cur = await readJson<Partial<Stored>>(file(root), {});
      const next = normalize(root, undefined, { ...cur, ...patch, root });
      await writeJson(file(root), next);
      const db = services.db ? await services.db.list(root).catch(() => []) : [];
      return { ...next, db };
    });
  },
};

export function register(): void {
  services.project = projectService;
  handle('project.get', (root, name) => projectService.get(checkRoot(root), name));
  handle('project.set', (root, patch) => projectService.set(checkRoot(root), patch ?? {}));
}

/** 화면이 보낸 프로젝트 경로 확인: 있는 폴더의 절대 경로여야 한다 */
export function checkRoot(root: unknown): string {
  if (typeof root !== 'string' || !root || !path.isAbsolute(root)) throw new Error('프로젝트 폴더 경로가 올바르지 않습니다');
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(root);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new Error(`프로젝트 폴더를 찾을 수 없습니다: ${root}`);
  return path.resolve(root);
}
