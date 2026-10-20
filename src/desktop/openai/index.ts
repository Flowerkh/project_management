// ChatGPT 연동: PC에 설치된 Codex CLI를 `codex app-server`로 띄워 쓴다 (Codex는 수정하지 않고, 로그인은 Codex 자체 화면에서)
//   cli.ts     Codex 찾기·버전       config.ts  설정·비밀 값          launch.ts  띄울 인수·환경 변수(자체 도구 끔·공급자)
//   rpc.ts     app-server 연결       query.ts   대화(스레드)·도구 호출  models.ts  모델 목록·계정
//   status.ts  연결 상태             session.ts 잠깐 띄우는 Codex
import { spawn } from 'node:child_process';
import type { OpenAiConfigInput } from '../../shared/desktop-api';
import { type AiEngine, EngineError, type EngineHost } from '../ai/engine';
import { host } from '../host';
import { DesktopError, handle } from '../ipc';
import { checkCodex } from './cli';
import { getOpenAiConfig, getOpenAiStored, setCodexPath, setOpenAiConfig } from './config';
import { launchPlan, type LaunchOptions } from './launch';
import { CodexModels } from './models';
import { CodexQuery } from './query';
import { CodexStatus } from './status';

export interface CodexEngineOptions extends LaunchOptions {
  commandTimeoutMs?: number;
  probeTimeoutMs?: number;
  /** 시험용: thread/start·resume 설정에 더할 값 */
  extraConfig?: Record<string, unknown>;
}

export interface CodexEngine extends AiEngine {
  status: CodexStatus;
  models: CodexModels;
  registerChannels(h: EngineHost): void;
}

export function createCodexEngine(o: CodexEngineOptions = {}): CodexEngine {
  const appVersion = () => host().appVersion;
  const status = new CodexStatus({ appVersion, launch: o, probeTimeoutMs: o.probeTimeoutMs });
  const models = new CodexModels({ cliTarget: () => status.cliTarget(), appVersion, launch: o });
  const launch = async () => {
    const cli = await status.cliTarget();
    if (!cli.ok) throw new EngineError(`Codex CLI 실행 실패: ${cli.message}`, 'missing');
    return { target: cli.target, plan: await launchPlan(await getOpenAiStored(), o) };
  };

  return {
    provider: 'openai',
    status,
    models,
    enabled: async () => (await getOpenAiStored()).enabled,
    defaultModel: async () => {
      const cfg = await getOpenAiStored();
      return cfg.authMode === 'azure' ? cfg.azure?.deployment : cfg.model;
    },
    open: (opts) => CodexQuery.open(opts, { launch, appVersion: appVersion(), commandTimeoutMs: o.commandTimeoutMs, extraConfig: o.extraConfig }),
    registerChannels(h: EngineHost) {
      handle('openai.config.get', () => getOpenAiConfig());
      handle('openai.config.set', async (input: OpenAiConfigInput) => {
        const r = await setOpenAiConfig(input);
        if (r.authChanged || r.enabledNow || r.disabledNow) status.invalidate();
        if (r.authChanged) models.invalidate();
        if (r.disabledNow) await h.closeAll();
        else if (r.authChanged) h.closeIdle();
        if (r.enabledNow || r.disabledNow || r.authChanged) void status.get(false).catch(() => undefined);
        return r.config;
      });
      handle('openai.openLogin', () => openLogin(status));
      handle('openai.pickCli', async () => {
        const h2 = host();
        const p = await h2.pickFile('Codex 실행 파일 선택', h2.platform === 'win32' ? [{ name: '실행 파일', extensions: ['exe', 'cmd', 'ps1', 'js'] }, { name: '모든 파일', extensions: ['*'] }] : undefined);
        if (!p) return null;
        const r = await checkCodex(p, 'config');
        if (!r.ok) throw new DesktopError(r.message, r.reason === 'old' ? 'cli-old' : 'cli-invalid');
        await setCodexPath(p);
        status.invalidate();
        models.invalidate();
        h.closeIdle();
        void status.get(false).catch(() => undefined);
        return p;
      });
    },
  };
}

/**
 * [터미널에서 로그인]: Windows에서 새 명령 창으로 `codex login`을 띄운다 (브라우저에서 ChatGPT 로그인).
 * 앱은 로그인 정보를 읽지 않는다. 다른 OS는 지원하지 않음(false).
 */
async function openLogin(status: CodexStatus): Promise<boolean> {
  const h = host();
  if (h.platform !== 'win32') return false;
  const cli = await status.cliTarget(true);
  if (!cli.ok) throw new DesktopError(cli.message, 'missing');
  // 로그인은 PC의 Codex 기본 공급자로 (API 키·Azure 설정은 넘기지 않음)
  const plan = await launchPlan({ ...(await getOpenAiStored()), authMode: 'chatgpt' });
  const q = (s: string) => `"${s.replace(/"/g, '')}"`;
  const inner = cli.target.node ? `${q(cli.target.node)} ${q(cli.target.exec)} login` : `${q(cli.target.exec)} login`;
  const line = `/c start "Codex 로그인" cmd /k "${inner}"`;
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: plan.env, cwd: h.dataDir });
      child.on('error', () => resolve(false));
      child.unref();
      setTimeout(() => resolve(true), 300);
    } catch {
      resolve(false);
    }
  });
}
