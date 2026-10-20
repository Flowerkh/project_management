// Gemini·ChatGPT 연결 상태 (Claude의 claude/status.ts와 같은 규칙)
//   on 사용 가능 / login 인증 필요 / offline 인터넷 안 됨 / off 연동 꺼짐 / missing 실행 파일 없음(Codex·gcloud)
// - 처음 status: 가벼운 확인(인터넷 + 저장해 둔 마지막 인증 결과 — AI에 요청하지 않음)
// - [다시 확인](recheck): 엔진별 전체 확인 (인증·모델까지). 결과는 <provider>.json에 저장
// - 대화 중 인증·네트워크 오류가 나면 상태를 바꾸고, 성공하면 다시 on으로
import type { ClaudeCheck, ClaudeErrorCode, ClaudeStatus } from '../../shared/desktop-api';
import { cleanDetail, offMessage, statusMessage } from '../claude/errors';
import { host } from '../host';
import { emit } from '../ipc';
import { nowIso } from '../store';
import type { EngineProvider, EngineStatus, StatusReport } from './engine';
import { type AuthCache, readProviderFile, updateProviderFile } from './store';

export function stateFor(code: ClaudeErrorCode): ClaudeStatus['state'] {
  if (code === 'offline') return 'offline';
  if (code === 'missing') return 'missing';
  if (code === 'auth' || code === 'billing') return 'login';
  return 'on';
}

export abstract class EngineStatusBase implements EngineStatus {
  protected current: ClaudeStatus | null = null;
  private inflight: Promise<ClaudeStatus> | null = null;
  private inflightFull: Promise<ClaudeStatus> | null = null;

  constructor(protected provider: EngineProvider) {}

  protected abstract isEnabled(): Promise<boolean>;
  /** 앱 시작 때의 가벼운 확인 */
  protected abstract light(): Promise<ClaudeStatus>;
  /** [다시 확인] */
  protected abstract full(): Promise<ClaudeStatus>;
  /** 인증에 영향을 주는 설정의 지문 (마지막 인증 결과를 다시 쓸지) */
  abstract authKey(): Promise<string>;
  /** 지금 설정의 인증 이름 (API 키 · 회사 Google Cloud …) */
  protected abstract authLabel(): Promise<string>;

  async get(recheck = false): Promise<ClaudeStatus> {
    if (recheck) {
      if (!this.inflightFull) this.inflightFull = this.full().finally(() => (this.inflightFull = null));
      return this.inflightFull;
    }
    const enabled = await this.isEnabled();
    if (this.current) return enabled ? this.current : this.asOff(this.current);
    if (!this.inflight) this.inflight = this.light().finally(() => (this.inflight = null));
    const st = await this.inflight;
    return enabled ? st : this.asOff(st);
  }

  invalidate(): void {
    this.current = null;
  }

  protected asOff(st: ClaudeStatus): ClaudeStatus {
    if (st.state === 'missing') return st;
    return { ...st, state: 'off', message: offMessage(this.provider), code: undefined };
  }

  protected set(st: ClaudeStatus, persist = false): ClaudeStatus {
    const prev = this.current;
    this.current = st;
    const changed = !prev || prev.state !== st.state || prev.message !== st.message || prev.code !== st.code || prev.authLabel !== st.authLabel || prev.version !== st.version;
    if (changed || persist) emit({ type: 'ai.status', provider: this.provider, status: st });
    if (persist) void updateProviderFile(this.provider, (f) => (f.status = st)).catch(() => undefined);
    return st;
  }

  protected async lastAuth(): Promise<AuthCache | undefined> {
    const f = await readProviderFile(this.provider);
    const key = await this.authKey();
    return f.auth && f.auth.key === key ? f.auth : undefined;
  }

  protected async saveAuth(a: Omit<AuthCache, 'key' | 'at'>): Promise<void> {
    const auth: AuthCache = { ...a, key: await this.authKey(), at: nowIso() };
    await updateProviderFile(this.provider, (f) => (f.auth = auth)).catch(() => undefined);
  }

  /** 인터넷 확인: url에 HTTP 응답이 오면 연결됨 (상태 코드와 상관없이) */
  protected async netCheck(url: string, proxy: string | undefined, timeoutMs: number): Promise<ClaudeCheck> {
    const h = host();
    if (!h.netCheck) return { ok: null, message: '이 환경에서는 인터넷 확인을 건너뜁니다' };
    const r = await h.netCheck(url, { timeoutMs, proxy });
    const hostName = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (r.ok) return { ok: true, message: `${hostName} 연결됨 (${r.ms}ms)`, ms: r.ms };
    if (/ERR_CERT|ERR_SSL|CERT_|certificate|handshake/i.test(r.error ?? ''))
      return { ok: false, message: `${hostName} 인증서 확인 실패 (회사 보안 프로그램·프록시 확인): ${cleanDetail(r.error ?? '', 80)}`, ms: r.ms, code: 'offline' };
    return { ok: false, message: `${hostName}에 연결하지 못했습니다${r.error ? `: ${cleanDetail(r.error, 160)}` : ''}`, ms: r.ms, code: 'offline' };
  }

  /** 대화에서 알게 된 상태 (오류 → login·offline·missing, 성공 → on) */
  async report(r: StatusReport): Promise<void> {
    const enabled = await this.isEnabled();
    const cur = this.current ?? { state: 'on' as const, checkedAt: nowIso(), authLabel: await this.authLabel() };
    if (r.ok) {
      if (cur.state === 'on' && !cur.code) return;
      const next: ClaudeStatus = { ...cur, state: enabled ? 'on' : 'off', code: undefined, message: undefined, checkedAt: nowIso() };
      if (next.checks) next.checks = { ...next.checks, network: { ok: true, message: '대화 중 연결 확인됨' }, auth: { ok: true, message: `${cur.authLabel ?? ''} · 대화 중 확인됨`.replace(/^ · /, '') } };
      this.set(next);
      if (cur.state === 'login' || cur.code) await this.saveAuth({ ok: true, label: cur.authLabel });
      return;
    }
    if (r.code === 'other') return;
    const next: ClaudeStatus = { ...cur, state: stateFor(r.code), code: r.code, message: statusMessage(r.code, r.detail, this.provider), checkedAt: nowIso() };
    this.set(next);
    if (r.code === 'auth' || r.code === 'billing') await this.saveAuth({ ok: false, code: r.code, message: r.detail });
  }
}
