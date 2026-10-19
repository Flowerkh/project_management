// 쓸 수 있는 모델 목록: PC의 Claude Code를 잠깐 띄워 initialize 응답의 모델 목록을 받는다 (사용자 메시지를 보내지 않아 API 요청 없음).
// CLI·인증 설정이 같으면 기억해 두고, 설정이 바뀌거나 [새로고침]이면 다시 받는다.
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeAccount, ClaudeModel, ClaudeModelList } from '../../shared/desktop-api';
import { host } from '../host';
import { dataDir, nowIso } from '../store';
import { authKey, getStored } from './config';
import { buildCliEnv } from './env';
import { InputQueue, type Query, type QueryFn } from './sdk';
import type { StatusManager } from './status';

interface RawModel {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
}

/** CLI 목록 → 화면 목록. 'default'는 'Claude Code 기본값' 칸의 이름·설명으로 쓴다 */
export function toModelList(raw: unknown): Omit<ClaudeModelList, 'at'> {
  const models: ClaudeModel[] = [];
  let defaultName: string | undefined;
  let defaultDescription: string | undefined;
  for (const m of Array.isArray(raw) ? (raw as RawModel[]) : []) {
    const value = typeof m?.value === 'string' ? m.value.trim() : '';
    if (!value) continue;
    const name = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : value;
    const description = typeof m.description === 'string' && m.description.trim() ? m.description.trim() : undefined;
    if (value === 'default') {
      defaultName = name;
      defaultDescription = description;
      continue;
    }
    if (models.some((x) => x.value === value)) continue;
    models.push({ value, name, ...(typeof m.resolvedModel === 'string' && m.resolvedModel ? { resolved: m.resolvedModel } : {}), ...(description ? { description } : {}) });
  }
  return { models, ...(defaultName ? { defaultName } : {}), ...(defaultDescription ? { defaultDescription } : {}) };
}

/** SDK accountInfo → 화면에 보일 것만 (토큰·키 출처는 빼고) */
export function toAccount(raw: unknown): ClaudeAccount | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
  const a: ClaudeAccount = {};
  const email = str(r.email);
  const organization = str(r.organization);
  const subscription = str(r.subscriptionType);
  const provider = str(r.apiProvider);
  if (email) a.email = email;
  if (organization) a.organization = organization;
  if (subscription) a.subscription = subscription;
  if (provider) a.provider = provider;
  return Object.keys(a).length ? a : undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Claude Code가 ${Math.round(ms / 1000)}초 동안 응답하지 않았습니다`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class ModelCatalog {
  private cache: { key: string; list: ClaudeModelList } | null = null;
  private inflight: { key: string; p: Promise<ClaudeModelList> } | null = null;

  constructor(private deps: { queryFn: QueryFn; status: StatusManager; timeoutMs?: number }) {}

  /** CLI를 바꿈 → 다음에 다시 받음 (list는 CLI·인증 지문이 다르면 알아서 다시 받는다) */
  invalidate(): void {
    this.cache = null;
  }

  /** 기억한 목록 (없으면 null). 대화 안내 문구에 이름을 쓸 때 */
  cached(): ClaudeModelList | null {
    return this.cache?.list ?? null;
  }

  /** 모델 값의 보이는 이름 ('' = Claude Code 기본값) */
  label(value: string | undefined): string {
    const list = this.cache?.list;
    if (!value) return list?.defaultName ? `Claude Code 기본값 (${list.defaultName})` : 'Claude Code 기본값';
    return list?.models.find((m) => m.value === value)?.name ?? value;
  }

  async list(refresh = false): Promise<ClaudeModelList> {
    const cfg = await getStored();
    const cli = await this.deps.status.cliTarget();
    if (!cli.ok) return { models: [], error: cli.message, at: nowIso() };
    // 기본 모델은 목록에 영향이 없으므로 빼고 지문을 만든다
    const key = `${cli.target.exec}|${cli.version ?? ''}|${await authKey({ ...cfg, model: undefined })}`;
    if (!refresh && this.cache?.key === key) return this.cache.list;
    if (this.inflight?.key === key) return this.inflight.p;
    const p = this.fetch(cfg, cli.target).then(
      (list) => {
        if (!list.error) this.cache = { key, list };
        return list;
      },
      (e) => ({ models: [], error: (e as Error)?.message ?? String(e), at: nowIso() }),
    );
    this.inflight = { key, p };
    try {
      return await p;
    } finally {
      if (this.inflight?.p === p) this.inflight = null;
    }
  }

  private async fetch(cfg: Awaited<ReturnType<typeof getStored>>, target: { exec: string; node?: string }): Promise<ClaudeModelList> {
    const cwd = path.join(dataDir(), 'claude-check');
    fs.mkdirSync(cwd, { recursive: true });
    const env = await buildCliEnv(cfg, { appVersion: host().appVersion });
    const input = new InputQueue();
    let stderr = '';
    let q: Query | null = null;
    try {
      q = this.deps.queryFn({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: target.exec,
          ...(target.node ? { executable: target.node as 'node' } : {}),
          cwd,
          env,
          tools: [],
          settingSources: ['user'],
          strictMcpConfig: true,
          persistSession: false,
          stderr: (s: string) => {
            stderr = (stderr + s).slice(-2000);
          },
        },
      });
      const raw = await withTimeout(q.supportedModels(), this.deps.timeoutMs ?? 30000);
      const list = toModelList(raw);
      // 같은 initialize 응답에 들어 있는 계정 (다른 계정으로 바꿨는지 보여 주려고)
      const account = toAccount(await withTimeout(q.accountInfo(), 5000).catch(() => null));
      const withAccount = account ? { ...list, account } : list;
      if (!list.models.length && !list.defaultName) return { ...withAccount, error: '이 Claude Code는 모델 목록을 알려 주지 않습니다. 모델 이름을 직접 입력할 수 있습니다.', at: nowIso() };
      return { ...withAccount, at: nowIso() };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      return { models: [], error: `모델 목록을 받지 못했습니다: ${msg}${stderr.trim() ? ` (${stderr.trim().split('\n').pop()})` : ''}`, at: nowIso() };
    } finally {
      input.end();
      try {
        q?.close();
      } catch {
        // 이미 끝남
      }
    }
  }
}
