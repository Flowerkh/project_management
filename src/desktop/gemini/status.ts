// Gemini 연결 상태: 인터넷 → 인증(토큰 세기 시험 요청 1회, 비용 없음) → 모델 목록
import type { ClaudeCheck, ClaudeStatus } from '../../shared/desktop-api';
import { EngineError } from '../ai/engine';
import { EngineStatusBase, stateFor } from '../ai/status';
import { readProviderFile } from '../ai/store';
import { statusMessage } from '../claude/errors';
import { nowIso } from '../store';
import type { GeminiClient } from './client';
import { geminiAuthKey, type GeminiStored, getGeminiStored } from './config';
import type { GeminiModels } from './models';

export function geminiAuthLabel(cfg: GeminiStored): string {
  if (cfg.authMode === 'vertex') return `회사 Google Cloud${cfg.vertex?.project ? ` (${cfg.vertex.project} · ${cfg.vertex.location || 'global'})` : ''}`;
  return 'Gemini API 키 (앱에 저장)';
}

export interface GeminiStatusDeps {
  client(): Promise<GeminiClient>;
  models: GeminiModels;
  defaultModel(): Promise<string>;
  proxy(): Promise<string | undefined>;
  hasKey(): Promise<boolean>;
}

export class GeminiStatus extends EngineStatusBase {
  constructor(private deps: GeminiStatusDeps) {
    super('gemini');
  }

  protected async isEnabled(): Promise<boolean> {
    return (await getGeminiStored()).enabled;
  }

  async authKey(): Promise<string> {
    return geminiAuthKey(await getGeminiStored());
  }

  protected async authLabel(): Promise<string> {
    return geminiAuthLabel(await getGeminiStored());
  }

  /** 인증 설정이 비었는지 (API 키 없음 · 프로젝트 없음) */
  private async missingAuth(cfg: GeminiStored): Promise<string | null> {
    if (cfg.authMode === 'apikey' && !(await this.deps.hasKey())) return 'API 키를 넣어 주세요';
    if (cfg.authMode === 'vertex' && !cfg.vertex?.project) return '회사 Google Cloud 프로젝트 ID를 넣어 주세요';
    return null;
  }

  protected async light(): Promise<ClaudeStatus> {
    const cfg = await getGeminiStored();
    const f = await readProviderFile('gemini');
    const base: ClaudeStatus = { state: 'on', checkedAt: nowIso(), authLabel: geminiAuthLabel(cfg) };
    const prevModel = f.status?.checks?.model;
    if (!cfg.enabled) return this.set({ ...base, state: 'off', checks: f.status?.checks ?? { network: { ok: null }, auth: { ok: null } }, authMs: f.status?.authMs });
    const client = await this.deps.client();
    const net = await this.netCheck(client.netUrl(), await this.deps.proxy(), 4000);
    const auth = await this.lastAuth();
    const authC: ClaudeCheck = auth ? { ok: auth.ok, message: auth.ok ? `마지막 확인 ${auth.at.slice(0, 16).replace('T', ' ')}` : auth.message, ms: auth.ms, code: auth.code } : { ok: null, message: '아직 확인하지 않았습니다' };
    const checks = { network: net, auth: authC, ...(prevModel ? { model: prevModel } : {}) };
    if (net.ok === false) return this.set({ ...base, state: 'offline', code: 'offline', message: statusMessage('offline', net.message, 'gemini'), checks, authMs: auth?.ms });
    if (auth && !auth.ok) {
      const code = auth.code ?? 'auth';
      return this.set({ ...base, state: stateFor(code), code, message: statusMessage(code, auth.message, 'gemini'), checks, authMs: auth.ms });
    }
    return this.set({ ...base, state: 'on', checks, authMs: auth?.ms });
  }

  protected async full(): Promise<ClaudeStatus> {
    const cfg = await getGeminiStored();
    const base: ClaudeStatus = { state: 'on', checkedAt: nowIso(), authLabel: geminiAuthLabel(cfg) };
    const missing = await this.missingAuth(cfg);
    if (missing)
      return this.set({ ...base, state: 'login', code: 'auth', message: statusMessage('auth', missing, 'gemini'), checks: { network: { ok: null }, auth: { ok: false, message: missing, code: 'auth' }, model: { ok: null } } }, true);
    const client = await this.deps.client();
    const net = await this.netCheck(client.netUrl(), await this.deps.proxy(), 8000);
    if (net.ok === false)
      return this.set({ ...base, state: 'offline', code: 'offline', message: statusMessage('offline', net.message, 'gemini'), checks: { network: net, auth: { ok: null, message: '인터넷 연결 뒤 확인합니다' }, model: { ok: null } } }, true);
    // 인증: 기본 모델로 토큰 세기 (글을 만들지 않아 요금이 없음) — 인증·모델 이름을 함께 확인
    const model = await this.deps.defaultModel();
    const t0 = Date.now();
    let authC: ClaudeCheck;
    try {
      await client.countTokens(model, AbortSignal.timeout(30000));
      const ms = Date.now() - t0;
      authC = { ok: true, message: `${geminiAuthLabel(cfg)} · 시험 요청 ${(ms / 1000).toFixed(1)}초`, ms };
      await this.saveAuth({ ok: true, label: geminiAuthLabel(cfg), ms });
    } catch (e) {
      const ms = Date.now() - t0;
      const code = e instanceof EngineError ? e.code : /timeout|aborted/i.test((e as Error)?.name ?? '') ? 'offline' : 'other';
      const detail = e instanceof Error ? (e.name === 'TimeoutError' ? 'Gemini가 30초 동안 응답하지 않았습니다' : e.message) : String(e);
      authC = { ok: false, message: detail, ms, code };
      if (code === 'auth' || code === 'billing') await this.saveAuth({ ok: false, code, message: detail, ms });
    }
    // 모델 목록
    const list = await this.deps.models.list(true);
    const modelC: ClaudeCheck = list.error
      ? { ok: client.vertex ? true : null, message: list.error }
      : { ok: true, message: client.vertex ? `알려진 모델 ${list.models.length}개 (회사 Google Cloud는 목록을 받지 않음)` : `${list.models.length}개 받음` };
    const checks = { network: net, auth: authC, model: modelC };
    if (authC.ok) return this.set({ ...base, state: 'on', checks, authMs: authC.ms }, true);
    const code = authC.code ?? 'other';
    const state = code === 'limit' ? 'on' : code === 'other' ? 'login' : stateFor(code);
    return this.set({ ...base, state, code, message: statusMessage(code, authC.message, 'gemini'), checks, authMs: authC.ms }, true);
  }
}
