// ChatGPT 연결 상태: Codex CLI 설치 → 인터넷 → 인증 (ChatGPT 계정 로그인 여부 + 짧은 시험 요청 1회)
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeCheck, ClaudeStatus } from '../../shared/desktop-api';
import { EngineError } from '../ai/engine';
import { EngineStatusBase, stateFor } from '../ai/status';
import { readProviderFile } from '../ai/store';
import type { CliResult } from '../claude/cli';
import { statusMessage } from '../claude/errors';
import { dataDir, nowIso } from '../store';
import { discoverCodex } from './cli';
import { getOpenAiProxy, getOpenAiStored, openAiAuthKey, type OpenAiStored } from './config';
import { launchPlan, type LaunchOptions, openAiAuthLabel } from './launch';
import { codexError } from './query';
import { readAccount, withCodex } from './session';

const CLI_CACHE_MS = 5 * 60 * 1000;

export interface CodexStatusDeps {
  appVersion(): string;
  launch?: LaunchOptions;
  /** 시험 요청 제한 시간 (기본 60초) */
  probeTimeoutMs?: number;
}

export class CodexStatus extends EngineStatusBase {
  private cli: { at: number; result: CliResult; cliPath?: string } | null = null;

  constructor(private deps: CodexStatusDeps) {
    super('openai');
  }

  /** 대화를 열 때 쓰는 Codex (5분 동안 기억, 실패했으면 다시 찾음) */
  async cliTarget(force = false): Promise<CliResult> {
    const cfg = await getOpenAiStored();
    const c = this.cli;
    if (!force && c && c.result.ok && c.cliPath === cfg.cliPath && Date.now() - c.at < CLI_CACHE_MS) return c.result;
    const result = await discoverCodex({ cliPath: cfg.cliPath });
    this.cli = { at: Date.now(), result, cliPath: cfg.cliPath };
    return result;
  }

  override invalidate(): void {
    super.invalidate();
    this.cli = null;
  }

  protected async isEnabled(): Promise<boolean> {
    return (await getOpenAiStored()).enabled;
  }

  async authKey(): Promise<string> {
    return openAiAuthKey(await getOpenAiStored());
  }

  protected async authLabel(): Promise<string> {
    return openAiAuthLabel(await getOpenAiStored());
  }

  private cliCheck(r: CliResult): ClaudeCheck {
    if (r.ok) return { ok: true, message: `${r.version} · ${r.target.display}`, };
    return { ok: false, message: r.message, code: 'missing' };
  }

  private base(cfg: OpenAiStored, cli: CliResult): ClaudeStatus {
    const st: ClaudeStatus = { state: 'on', checkedAt: nowIso(), authLabel: openAiAuthLabel(cfg) };
    if (cli.ok) {
      st.cliPath = cli.target.display;
      st.version = cli.version;
    } else if (cli.target) st.cliPath = cli.target.display;
    return st;
  }

  private async netUrl(cfg: OpenAiStored): Promise<string> {
    try {
      return (await launchPlan(cfg, this.deps.launch)).netUrl;
    } catch {
      return cfg.authMode === 'azure' && cfg.azure?.endpoint ? `${cfg.azure.endpoint}/` : cfg.authMode === 'apikey' ? 'https://api.openai.com/' : 'https://chatgpt.com/';
    }
  }

  protected async light(): Promise<ClaudeStatus> {
    const cfg = await getOpenAiStored();
    const f = await readProviderFile('openai');
    const cli = await this.cliTarget(true);
    const base = this.base(cfg, cli);
    const cliC = this.cliCheck(cli);
    if (!cli.ok) return this.set({ ...base, state: 'missing', code: 'missing', message: statusMessage('missing', cli.reason === 'notfound' ? undefined : cli.message, 'openai'), checks: { cli: cliC, network: { ok: null }, auth: { ok: null } } });
    if (!cfg.enabled) return this.set({ ...base, state: 'off', checks: f.status?.checks ? { ...f.status.checks, cli: cliC } : { cli: cliC, network: { ok: null }, auth: { ok: null } }, authMs: f.status?.authMs });
    const net = await this.netCheck(await this.netUrl(cfg), await getOpenAiProxy(cfg), 4000);
    const auth = await this.lastAuth();
    const authC: ClaudeCheck = auth ? { ok: auth.ok, message: auth.ok ? `마지막 확인 ${auth.at.slice(0, 16).replace('T', ' ')}` : auth.message, ms: auth.ms, code: auth.code } : { ok: null, message: '아직 확인하지 않았습니다' };
    const checks = { cli: cliC, network: net, auth: authC };
    if (net.ok === false) return this.set({ ...base, state: 'offline', code: 'offline', message: statusMessage('offline', net.message, 'openai'), checks, authMs: auth?.ms });
    if (auth && !auth.ok) {
      const code = auth.code ?? 'auth';
      return this.set({ ...base, state: stateFor(code), code, message: statusMessage(code, auth.message, 'openai'), checks, authMs: auth.ms });
    }
    return this.set({ ...base, state: 'on', checks, authMs: auth?.ms });
  }

  protected async full(): Promise<ClaudeStatus> {
    const cfg = await getOpenAiStored();
    const cli = await this.cliTarget(true);
    const base = this.base(cfg, cli);
    const cliC = this.cliCheck(cli);
    if (!cli.ok) return this.set({ ...base, state: 'missing', code: 'missing', message: statusMessage('missing', cli.reason === 'notfound' ? undefined : cli.message, 'openai'), checks: { cli: cliC, network: { ok: null }, auth: { ok: null } } }, true);
    const net = await this.netCheck(await this.netUrl(cfg), await getOpenAiProxy(cfg), 8000);
    if (net.ok === false) return this.set({ ...base, state: 'offline', code: 'offline', message: statusMessage('offline', net.message, 'openai'), checks: { cli: cliC, network: net, auth: { ok: null, message: '인터넷 연결 뒤 확인합니다' } } }, true);
    const probe = await this.probe(cfg, cli);
    const authC: ClaudeCheck = probe.ok ? { ok: true, message: `${openAiAuthLabel(cfg)} · 시험 요청 ${(probe.ms / 1000).toFixed(1)}초`, ms: probe.ms } : { ok: false, message: probe.detail, ms: probe.ms, code: probe.code };
    if (probe.ok || probe.code === 'auth' || probe.code === 'billing') await this.saveAuth(probe.ok ? { ok: true, label: openAiAuthLabel(cfg), ms: probe.ms } : { ok: false, code: probe.code, message: probe.detail, ms: probe.ms });
    const checks = { cli: cliC, network: net, auth: authC };
    if (probe.ok) return this.set({ ...base, state: 'on', checks, authMs: probe.ms }, true);
    const code = probe.code ?? 'other';
    const state = code === 'limit' ? 'on' : code === 'other' ? 'login' : stateFor(code);
    return this.set({ ...base, state, code, message: statusMessage(code, probe.detail, 'openai'), checks, authMs: probe.ms }, true);
  }

  /** 시험 요청: 계정 확인 → 도구 없는 짧은 대화 1번 (기록을 남기지 않음) */
  private async probe(cfg: OpenAiStored, cli: CliResult & { ok: true }): Promise<{ ok: true; ms: number } | { ok: false; code: ClaudeStatus['code'] & string; detail: string; ms: number }> {
    const t0 = Date.now();
    const timeoutMs = this.deps.probeTimeoutMs ?? 60000;
    try {
      const plan = await launchPlan(cfg, this.deps.launch);
      const cwd = path.join(dataDir(), 'codex-check');
      fs.mkdirSync(cwd, { recursive: true });
      let resolveTurn!: (t: { status?: string; error?: unknown }) => void;
      const turnDone = new Promise<{ status?: string; error?: unknown }>((r) => (resolveTurn = r));
      return await withCodex(
        cli.target,
        plan,
        this.deps.appVersion(),
        cwd,
        async (s) => {
          if (cfg.authMode === 'chatgpt') {
            const a = await readAccount(s);
            if (a.account?.type !== 'chatgpt') return { ok: false as const, code: 'auth' as const, detail: 'Codex에 ChatGPT 계정으로 로그인되어 있지 않습니다. [터미널에서 로그인]으로 로그인해 주세요', ms: Date.now() - t0 };
          }
          const th = await s.request<{ thread: { id: string } }>(
            'thread/start',
            { cwd, approvalPolicy: 'untrusted', sandbox: 'read-only', ephemeral: true, baseInstructions: 'You are a connectivity check. Reply with the single word OK.', ...(plan.fixedModel || cfg.model ? { model: plan.fixedModel || cfg.model } : {}) },
            30000,
          );
          await s.request('turn/start', { threadId: th.thread.id, input: [{ type: 'text', text: 'Reply with the single word OK.', text_elements: [] }] }, 30000);
          const t = await Promise.race([turnDone, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
          const ms = Date.now() - t0;
          if (!t) return { ok: false as const, code: 'offline' as const, detail: `ChatGPT가 ${Math.round(timeoutMs / 1000)}초 동안 응답하지 않았습니다`, ms };
          if (t.status === 'completed') return { ok: true as const, ms };
          const e = codexError(t.error as never);
          return { ok: false as const, code: e.code, detail: e.detail, ms };
        },
        (method, p) => {
          if (method === 'turn/completed') resolveTurn(p.turn ?? {});
        },
      );
    } catch (e) {
      const code = e instanceof EngineError ? e.code : 'other';
      return { ok: false, code, detail: (e as Error)?.message ?? String(e), ms: Date.now() - t0 };
    }
  }
}
