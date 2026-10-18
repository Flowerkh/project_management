// Claude 연결 상태 (상단 Claude 버튼의 점, POP-03 연결 확인)
//   on 사용 가능 / login 인증 필요 / offline 인터넷 안 됨 / off 연동 꺼짐 / missing CLI 없음
// - 앱 시작(처음 status 호출): CLI 찾기·버전 → 짧은 인터넷 확인 → 저장해 둔 마지막 인증 결과 (Claude에 요청하지 않음)
// - [다시 확인](recheck): CLI → 인터넷 → 인증(짧은 시험 요청 1회, 시간 측정). 결과는 claude.json에 저장
// - 대화 중 인증·네트워크 오류가 나면 상태를 바꾸고, 성공하면 다시 on으로
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeCheck, ClaudeErrorCode, ClaudeStatus } from '../../shared/desktop-api';
import { host } from '../host';
import { emit } from '../ipc';
import { dataDir, nowIso } from '../store';
import { type CliResult, discoverCli } from './cli';
import { type AuthCache, authKey, getCloudEnv, getProxy, getStored, loadStatusCache, saveStatusCache, type StoredConfig } from './config';
import { buildCliEnv, netCheckUrl, PROVIDER_LABEL } from './env';
import { classifyError, cleanDetail, statusMessage } from './errors';
import type { QueryFn, SDKMessage } from './sdk';

export interface StatusDeps {
  queryFn: QueryFn;
  /** 인증 시험 요청 제한 시간 (기본 60초) */
  authTimeoutMs?: number;
}

const CLI_CACHE_MS = 5 * 60 * 1000;

export function defaultAuthLabel(cfg: StoredConfig): string {
  if (cfg.authMode === 'apikey') return 'API 키 (앱에 저장)';
  if (cfg.authMode === 'cloud') return `회사 클라우드 (${cfg.cloud ? PROVIDER_LABEL[cfg.cloud.provider] : '설정 필요'})`;
  return 'Claude Code 로그인';
}

/** system/init의 apiKeySource → 지금 쓰는 인증 */
export function authLabelFrom(cfg: StoredConfig, apiKeySource: string | undefined): string {
  if (cfg.authMode === 'cloud') return defaultAuthLabel(cfg);
  switch (apiKeySource) {
    case 'ANTHROPIC_API_KEY':
      return cfg.authMode === 'apikey' ? 'API 키 (앱에 저장)' : 'API 키 환경 변수 (ANTHROPIC_API_KEY)';
    case 'apiKeyHelper':
      return 'API 키 도우미 (apiKeyHelper)';
    case '/login managed key':
      return 'Claude Code 로그인 (Console)';
    default:
      return cfg.authMode === 'apikey' ? 'API 키 (앱에 저장)' : 'Claude Code 로그인';
  }
}

function stateFor(code: ClaudeErrorCode): ClaudeStatus['state'] {
  if (code === 'offline') return 'offline';
  if (code === 'missing') return 'missing';
  if (code === 'auth' || code === 'billing') return 'login';
  return 'on';
}

export class StatusManager {
  private current: ClaudeStatus | null = null;
  private cli: { at: number; result: CliResult; cliPath?: string } | null = null;
  private inflight: Promise<ClaudeStatus> | null = null;
  private inflightFull: Promise<ClaudeStatus> | null = null;

  constructor(private deps: StatusDeps) {}

  /** 대화를 열 때 쓰는 CLI (5분 동안 기억, 실패했으면 다시 찾음) */
  async cliTarget(force = false): Promise<CliResult> {
    const cfg = await getStored();
    const c = this.cli;
    if (!force && c && c.result.ok && c.cliPath === cfg.cliPath && Date.now() - c.at < CLI_CACHE_MS) return c.result;
    const result = await discoverCli({ cliPath: cfg.cliPath });
    this.cli = { at: Date.now(), result, cliPath: cfg.cliPath };
    return result;
  }

  /** 설정이 바뀜 → 다음 status는 새로 확인 */
  invalidate(): void {
    this.current = null;
    this.cli = null;
  }

  async get(recheck = false): Promise<ClaudeStatus> {
    if (recheck) {
      if (!this.inflightFull) this.inflightFull = this.full().finally(() => (this.inflightFull = null));
      return this.inflightFull;
    }
    const cfg = await getStored();
    if (this.current) return cfg.enabled ? this.current : this.asOff(this.current);
    if (!this.inflight) this.inflight = this.light().finally(() => (this.inflight = null));
    const st = await this.inflight;
    return cfg.enabled ? st : this.asOff(st);
  }

  private asOff(st: ClaudeStatus): ClaudeStatus {
    if (st.state === 'missing') return st;
    return { ...st, state: 'off', message: '연동이 꺼져 있습니다. Claude 연결에서 켤 수 있습니다.', code: undefined };
  }

  private set(st: ClaudeStatus, persist = false): ClaudeStatus {
    const prev = this.current;
    this.current = st;
    const changed = !prev || prev.state !== st.state || prev.message !== st.message || prev.code !== st.code || prev.authLabel !== st.authLabel || prev.version !== st.version;
    if (changed || persist) emit({ type: 'claude.status', status: st });
    if (persist) saveStatusCache(st).catch(() => undefined);
    return st;
  }

  private cliCheck(r: CliResult): ClaudeCheck {
    if (r.ok) return { ok: true, message: `${r.version} · ${r.target.display}` };
    return { ok: false, message: r.message, code: 'missing' };
  }

  private async netCheck(cfg: StoredConfig, timeoutMs: number): Promise<ClaudeCheck> {
    const h = host();
    const url = netCheckUrl(cfg, await getCloudEnv(cfg));
    if (!url) return { ok: null, message: '확인할 서버 주소를 몰라 건너뛰었습니다 (회사 클라우드 설정 확인)' };
    if (!h.netCheck) return { ok: null, message: '이 환경에서는 인터넷 확인을 건너뜁니다' };
    const r = await h.netCheck(url, { timeoutMs, proxy: await getProxy(cfg) });
    const hostName = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (r.ok) return { ok: true, message: `${hostName} 연결됨 (${r.ms}ms)`, ms: r.ms };
    // 인증서 오류 = 서버까지는 닿음 (회사 TLS 검사 프록시 등). Claude Code는 자기 인증서 저장소를 쓰므로 인증 확인에서 판단한다
    if (/ERR_CERT|ERR_SSL|CERT_|certificate|handshake/i.test(r.error ?? ''))
      return { ok: true, message: `${hostName}까지 연결됨 (이 앱의 인증서 확인은 실패: ${cleanDetail(r.error ?? '', 80)})`, ms: r.ms };
    return { ok: false, message: `${hostName}에 연결하지 못했습니다${r.error ? `: ${cleanDetail(r.error, 160)}` : ''}`, ms: r.ms, code: 'offline' };
  }

  /** 앱 시작 때의 가벼운 확인 (Claude에 요청하지 않음) */
  private async light(): Promise<ClaudeStatus> {
    const cfg = await getStored();
    const cache = await loadStatusCache();
    const cli = await this.cliTarget(true);
    const base: ClaudeStatus = { state: 'on', checkedAt: nowIso(), authLabel: cache.auth?.label ?? defaultAuthLabel(cfg) };
    if (cli.ok) {
      base.cliPath = cli.target.display;
      base.version = cli.version;
    } else if (cli.target) base.cliPath = cli.target.display;
    const cliC = this.cliCheck(cli);
    if (!cli.ok) return this.set({ ...base, state: 'missing', code: 'missing', message: statusMessage('missing', cli.reason === 'notfound' ? undefined : cli.message), checks: { cli: cliC, network: { ok: null }, auth: { ok: null } } });
    if (!cfg.enabled) return this.set({ ...base, state: 'off', message: '연동이 꺼져 있습니다. Claude 연결에서 켤 수 있습니다.', checks: cache.status?.checks ? { ...cache.status.checks, cli: cliC } : { cli: cliC, network: { ok: null }, auth: { ok: null } }, authMs: cache.status?.authMs });
    const net = await this.netCheck(cfg, 4000);
    const key = await authKey(cfg);
    const auth = cache.auth && cache.auth.key === key ? cache.auth : undefined;
    const authC: ClaudeCheck = auth ? { ok: auth.ok, message: auth.ok ? `마지막 확인 ${auth.at.slice(0, 16).replace('T', ' ')}` : auth.message, ms: auth.ms, code: auth.code } : { ok: null, message: '아직 확인하지 않았습니다' };
    const checks = { cli: cliC, network: net, auth: authC };
    if (net.ok === false) return this.set({ ...base, state: 'offline', code: 'offline', message: statusMessage('offline', net.message), checks, authMs: auth?.ms });
    if (auth && !auth.ok) {
      const code = auth.code ?? 'auth';
      return this.set({ ...base, state: stateFor(code), code, message: statusMessage(code, auth.message), checks, authMs: auth.ms });
    }
    return this.set({ ...base, state: 'on', checks, authMs: auth?.ms });
  }

  /** [다시 확인]: CLI → 인터넷 → 인증 시험 요청 */
  private async full(): Promise<ClaudeStatus> {
    const cfg = await getStored();
    const cli = await this.cliTarget(true);
    const base: ClaudeStatus = { state: 'on', checkedAt: nowIso(), authLabel: defaultAuthLabel(cfg) };
    if (cli.ok) {
      base.cliPath = cli.target.display;
      base.version = cli.version;
    } else if (cli.target) base.cliPath = cli.target.display;
    const cliC = this.cliCheck(cli);
    if (!cli.ok) return this.set({ ...base, state: 'missing', code: 'missing', message: statusMessage('missing', cli.reason === 'notfound' ? undefined : cli.message), checks: { cli: cliC, network: { ok: null }, auth: { ok: null } } }, true);
    const net = await this.netCheck(cfg, 8000);
    if (net.ok === false) return this.set({ ...base, state: 'offline', code: 'offline', message: statusMessage('offline', net.message), checks: { cli: cliC, network: net, auth: { ok: null, message: '인터넷 연결 뒤 확인합니다' } } }, true);
    const probe = await this.authProbe(cfg, cli);
    const key = await authKey(cfg);
    const auth: AuthCache = { key, ok: probe.ok, code: probe.code, label: probe.label, message: probe.detail, ms: probe.ms, at: nowIso() };
    await saveStatusCache(undefined, auth);
    base.authLabel = probe.label ?? base.authLabel;
    const authC: ClaudeCheck = probe.ok ? { ok: true, message: `${base.authLabel} · 응답 ${probe.ms}ms`, ms: probe.ms } : { ok: false, message: probe.detail, ms: probe.ms, code: probe.code };
    const checks = { cli: cliC, network: net, auth: authC };
    if (probe.ok) return this.set({ ...base, state: 'on', checks, authMs: probe.ms }, true);
    const code = probe.code ?? 'other';
    // 사용 한도는 인증은 된 것 (잠시 뒤 다시) / 그 밖의 알 수 없는 실패는 쓸 수 없는 상태로
    const state = code === 'limit' ? 'on' : code === 'other' ? 'login' : stateFor(code);
    return this.set({ ...base, state, code, message: statusMessage(code, probe.detail), checks, authMs: probe.ms }, true);
  }

  /** 시험 요청 1회: 도구 없이, 최대 1턴, 짧은 시스템 프롬프트, 대화 기록을 남기지 않음 */
  async authProbe(cfg: StoredConfig, cli: CliResult & { ok: true }): Promise<{ ok: boolean; code?: ClaudeErrorCode; detail?: string; label?: string; ms: number }> {
    const cwd = path.join(dataDir(), 'claude-check');
    fs.mkdirSync(cwd, { recursive: true });
    const env = await buildCliEnv(cfg, { appVersion: host().appVersion });
    const t0 = Date.now();
    let stderr = '';
    let label: string | undefined;
    let q: ReturnType<QueryFn> | null = null;
    const timeoutMs = this.deps.authTimeoutMs ?? 60000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        q?.close();
      } catch {
        // 무시
      }
    }, timeoutMs);
    try {
      q = this.deps.queryFn({
        prompt: 'Reply with the single word OK.',
        options: {
          pathToClaudeCodeExecutable: cli.target.exec,
          ...(cli.target.node ? { executable: cli.target.node as 'node' } : {}),
          cwd,
          env,
          maxTurns: 1,
          tools: [],
          settingSources: ['user'],
          strictMcpConfig: true,
          persistSession: false,
          systemPrompt: 'You are a connectivity check. Reply with the single word OK.',
          ...(cfg.model ? { model: cfg.model } : {}),
          stderr: (s: string) => {
            stderr = (stderr + s).slice(-4000);
          },
        },
      });
      let connRetries = 0;
      for await (const m of q as AsyncIterable<SDKMessage>) {
        const msg = m as Record<string, any>;
        if (msg.type === 'system' && msg.subtype === 'init') label = authLabelFrom(cfg, msg.apiKeySource);
        else if (msg.type === 'system' && msg.subtype === 'api_retry') {
          if (msg.error_status === null || msg.error_status === undefined) connRetries++;
          // 연결 오류가 거듭되면 오래 기다리지 않는다 (CLI는 10번까지 다시 시도)
          if (connRetries >= 2) {
            q.close();
            return { ok: false, code: 'offline', detail: '서버에 연결하지 못했습니다 (Connection error)', label, ms: Date.now() - t0 };
          }
          if (msg.error_status === 401) {
            q.close();
            return { ok: false, code: 'auth', detail: 'API Error: 401', label, ms: Date.now() - t0 };
          }
        } else if (msg.type === 'assistant' && msg.error) {
          const text = textOf(msg.message?.content);
          const c = classifyError({ assistantError: msg.error, text });
          q.close();
          return { ok: false, code: c.code, detail: c.detail || msg.error, label, ms: Date.now() - t0 };
        } else if (msg.type === 'result') {
          const ms = Date.now() - t0;
          if (!msg.is_error && msg.subtype === 'success') return { ok: true, label, ms };
          const text = msg.subtype === 'success' ? String(msg.result ?? '') : (msg.errors ?? []).join('; ');
          const c = classifyError({ text, startupReason: msg.startup_failure_reason, status: msg.api_error_status });
          return { ok: false, code: c.code, detail: c.detail, label, ms };
        }
      }
      if (timedOut) return { ok: false, code: 'offline', detail: `Claude가 ${Math.round(timeoutMs / 1000)}초 동안 응답하지 않았습니다`, label, ms: Date.now() - t0 };
      const c = classifyError({ text: stderr || 'Claude CLI가 결과 없이 끝났습니다' });
      return { ok: false, code: c.code, detail: c.detail, label, ms: Date.now() - t0 };
    } catch (e) {
      if (timedOut) return { ok: false, code: 'offline', detail: `Claude가 ${Math.round(timeoutMs / 1000)}초 동안 응답하지 않았습니다`, label, ms: Date.now() - t0 };
      const err = e as NodeJS.ErrnoException;
      const c = classifyError({ text: `${err?.message ?? String(e)}\n${stderr}`, errno: err?.code });
      return { ok: false, code: c.code, detail: c.detail, label, ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
      try {
        q?.close();
      } catch {
        // 무시
      }
    }
  }

  /** 대화에서 알게 된 상태 (오류 → login·offline·missing, 성공 → on) */
  async report(r: { ok: true; apiKeySource?: string } | { ok: false; code: ClaudeErrorCode; detail?: string }): Promise<void> {
    const cfg = await getStored();
    const cur = this.current ?? { state: 'on' as const, checkedAt: nowIso(), authLabel: defaultAuthLabel(cfg) };
    if (r.ok) {
      const label = r.apiKeySource !== undefined ? authLabelFrom(cfg, r.apiKeySource) : cur.authLabel;
      if (cur.state === 'on' && !cur.code && cur.authLabel === label) return;
      const next: ClaudeStatus = { ...cur, state: cfg.enabled ? 'on' : 'off', code: undefined, message: undefined, authLabel: label, checkedAt: nowIso() };
      if (next.checks) next.checks = { ...next.checks, network: { ok: true, message: '대화 중 연결 확인됨' }, auth: { ok: true, message: `${label} · 대화 중 확인됨` } };
      this.set(next);
      if (cur.state === 'login' || cur.code) await saveStatusCache(next, { key: await authKey(cfg), ok: true, label, at: nowIso() });
      return;
    }
    const state = stateFor(r.code);
    if (r.code === 'other') return;
    const next: ClaudeStatus = { ...cur, state, code: r.code, message: statusMessage(r.code, r.detail), checkedAt: nowIso() };
    this.set(next);
    if (r.code === 'auth' || r.code === 'billing') await saveStatusCache(next, { key: await authKey(cfg), ok: false, code: r.code, message: r.detail, at: nowIso() });
  }

  /** system/init에서 본 CLI 버전·인증 */
  noteInit(cfg: StoredConfig, init: { apiKeySource?: string; claude_code_version?: string }): void {
    if (!this.current) return;
    const label = authLabelFrom(cfg, init.apiKeySource);
    if (label !== this.current.authLabel || (init.claude_code_version && init.claude_code_version !== this.current.version))
      this.set({ ...this.current, authLabel: label, version: init.claude_code_version ?? this.current.version });
  }
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}
