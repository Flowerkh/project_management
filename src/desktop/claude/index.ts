// Claude 연동: PC에 설치된 Claude Code CLI를 Claude Agent SDK로 실행 (CLI는 수정하지 않음)
//   cli.ts      CLI 찾기·버전          config.ts  설정·비밀 값        env.ts      CLI 환경 변수
//   status.ts   연결 상태·인증 확인     errors.ts  오류 구분           manager.ts  대화(SDK query)·항목 변환
//   guards.ts   도구 막기·허용          tools.ts   DB 도구(projdb)     prompt.ts   앱 규칙·맥락
import { spawn } from 'node:child_process';
import type { ChatMode, ClaudeConfigInput } from '../../shared/desktop-api';
import { host } from '../host';
import { DesktopError, handle, onShutdown } from '../ipc';
import { services } from '../services';
import { checkCandidate } from './cli';
import { authKey, getConfig, getStored, loadStatusCache, setCliPath, setConfig } from './config';
import { buildCliEnv } from './env';
import { ClaudeManager } from './manager';
import { ModelCatalog } from './models';
import { type QueryFn, sdkQuery } from './sdk';
import { StatusManager } from './status';

export interface ClaudeModuleOptions {
  queryFn?: QueryFn;
  idleMs?: number;
  authTimeoutMs?: number;
  interruptGraceMs?: number;
}

let current: { manager: ClaudeManager; status: StatusManager; models: ModelCatalog } | null = null;

/** 시험용: 지금 등록된 모듈 */
export function claudeModule(): { manager: ClaudeManager; status: StatusManager; models: ModelCatalog } {
  if (!current) throw new Error('claude 모듈이 등록되지 않았습니다');
  return current;
}

export function register(opts: ClaudeModuleOptions = {}): void {
  const queryFn = opts.queryFn ?? sdkQuery;
  const status = new StatusManager({ queryFn, authTimeoutMs: opts.authTimeoutMs });
  const models = new ModelCatalog({ queryFn, status });
  const manager = new ClaudeManager({ queryFn, status, idleMs: opts.idleMs, interruptGraceMs: opts.interruptGraceMs, models });
  if (current) void current.manager.closeAll();
  current = { manager, status, models };
  manager.ensureCardSubscription();

  services.claude = {
    send: (id, text) => manager.send(id, text, { wait: true }),
    setMode: (id, mode) => manager.setMode(id, mode),
  };

  handle('claude.status', (recheck) => {
    // [다시 확인]: 터미널에서 다른 계정으로 로그인했을 수 있으니 쉬고 있는 Claude 프로세스는 닫는다 (다음 메시지에 새 로그인으로 다시 엶)
    if (recheck) manager.closeIdle();
    return status.get(!!recheck);
  });
  handle('claude.config.get', () => getConfig());
  handle('claude.config.set', async (input: ClaudeConfigInput) => {
    const r = await setConfig(input);
    if (r.authChanged || r.enabledNow || r.disabledNow) status.invalidate();
    // 모델 목록은 CLI·인증 지문이 바뀌면 다음에 받을 때 새로 받는다 (기본 모델만 바꾼 것은 목록과 상관없음)
    if (r.disabledNow) await manager.closeAll();
    else if (r.authChanged) manager.closeIdle();
    if (r.enabledNow) {
      // 켤 때는 인증까지 확인 (10분 안에 같은 설정으로 [다시 확인]에 성공했으면 그 결과를 씀)
      const { auth } = await loadStatusCache();
      const key = await authKey(await getStored());
      const recent = !!auth && auth.ok && auth.key === key && Date.now() - Date.parse(auth.at) < 10 * 60 * 1000;
      void status.get(!recent).catch(() => undefined);
    } else if (r.disabledNow || r.authChanged) void status.get(false).catch(() => undefined);
    return r.config;
  });
  handle('claude.openLogin', () => openLogin(status));
  handle('claude.pickCli', async () => {
    const h = host();
    const p = await h.pickFile('Claude CLI 실행 파일 선택', h.platform === 'win32' ? [{ name: '실행 파일', extensions: ['exe', 'cmd', 'ps1', 'js'] }, { name: '모든 파일', extensions: ['*'] }] : undefined);
    if (!p) return null;
    const r = await checkCandidate(p, 'config');
    if (!r.ok) throw new DesktopError(r.message, r.reason === 'old' ? 'cli-old' : 'cli-invalid');
    await setCliPath(p);
    status.invalidate();
    models.invalidate();
    manager.closeIdle();
    void status.get(false).catch(() => undefined);
    return p;
  });

  handle('claude.list', (root) => manager.list(typeof root === 'string' && root ? root : null));
  handle('claude.get', (id) => manager.get(String(id)));
  handle('claude.start', (root, o) => manager.start(typeof root === 'string' && root ? root : null, o ?? {}));
  handle('claude.send', (id, text) => manager.send(String(id), String(text ?? '')));
  handle('claude.setMode', (id, mode: ChatMode) => manager.setMode(String(id), mode));
  handle('claude.models', (refresh) => models.list(!!refresh));
  handle('claude.setModel', (id, model) => manager.setModel(String(id), typeof model === 'string' ? model : ''));
  handle('claude.interrupt', (id) => manager.interrupt(String(id)));
  handle('claude.respond', (id, requestId, allow) => manager.respond(String(id), String(requestId), !!allow));
  handle('claude.delete', (id) => manager.delete(String(id)));
  handle('claude.clear', (root) => manager.clear(String(root ?? '')));
  handle('claude.export', (id) => manager.exportMarkdown(String(id)));

  onShutdown(() => manager.closeAll());
}

/**
 * [터미널에서 로그인]: Windows에서 새 명령 창으로 Claude Code를 띄운다. 사용자가 그 안에서 /login (브라우저 로그인).
 * 앱은 로그인 정보를 읽지 않는다. 다른 OS는 지원하지 않음(false).
 */
async function openLogin(status: StatusManager): Promise<boolean> {
  const h = host();
  if (h.platform !== 'win32') return false;
  const cli = await status.cliTarget(true);
  if (!cli.ok) throw new DesktopError(cli.message, 'missing');
  const cfg = await getStored();
  const env = await buildCliEnv(cfg, { appVersion: h.appVersion });
  const q = (s: string) => `"${s.replace(/"/g, '')}"`;
  // cmd /k ""C:\…\claude.exe"" — 바깥 따옴표 한 쌍을 cmd가 벗긴다 (cmd /? 의 따옴표 규칙)
  const inner = cli.target.node ? `${q(cli.target.node)} ${q(cli.target.exec)}` : q(cli.target.exec);
  const line = `/c start "Claude 로그인" cmd /k "${inner}"`;
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: env as NodeJS.ProcessEnv, cwd: h.dataDir });
      child.on('error', () => resolve(false));
      child.unref();
      setTimeout(() => resolve(true), 300);
    } catch {
      resolve(false);
    }
  });
}
