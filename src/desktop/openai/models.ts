// ChatGPT 모델 목록·지금 계정: PC의 Codex를 잠깐 띄워 model/list·account/read (요금 없음)
// Azure OpenAI는 배포 이름이 곧 모델. 설정·CLI가 같으면 기억해 둔다. 계정 이름은 화면에만 보여 주고 저장하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeAccount, ClaudeModel, ClaudeModelList } from '../../shared/desktop-api';
import type { EngineModels } from '../ai/engine';
import type { CliResult } from '../claude/cli';
import { dataDir, nowIso } from '../store';
import { getOpenAiStored, openAiAuthKey, type OpenAiStored } from './config';
import { type LaunchPlan, launchPlan, type LaunchOptions } from './launch';
import { type CodexAccount, readAccount, withCodex } from './session';

interface RawCodexModel {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

export function toCodexModels(raw: unknown): { models: ClaudeModel[]; defaultName?: string; defaultValue?: string } {
  const models: ClaudeModel[] = [];
  let defaultName: string | undefined;
  let defaultValue: string | undefined;
  for (const m of Array.isArray(raw) ? (raw as RawCodexModel[]) : []) {
    const value = String(m?.model ?? m?.id ?? '').trim();
    if (!value || m.hidden || models.some((x) => x.value === value)) continue;
    const name = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : value;
    const description = typeof m.description === 'string' && m.description.trim() ? m.description.trim().slice(0, 160) : undefined;
    models.push({ value, name, ...(description ? { description } : {}) });
    if (m.isDefault) {
      defaultName = name;
      defaultValue = value;
    }
  }
  return { models, ...(defaultName ? { defaultName, defaultValue } : {}) };
}

export function toCodexAccount(a: CodexAccount | null, cfg: OpenAiStored): ClaudeAccount | undefined {
  if (cfg.authMode === 'apikey') return { provider: 'OpenAI API 키' };
  if (cfg.authMode === 'azure') return { provider: 'Azure OpenAI', ...(cfg.azure?.endpoint ? { organization: cfg.azure.endpoint.replace(/^https:\/\//, '') } : {}) };
  if (!a || a.type !== 'chatgpt') return undefined;
  const out: ClaudeAccount = { provider: 'chatgpt' };
  if (a.email) out.email = String(a.email).slice(0, 200);
  if (a.planType) out.subscription = String(a.planType).slice(0, 40);
  return out;
}

export interface CodexModelsDeps {
  cliTarget(): Promise<CliResult>;
  appVersion(): string;
  launch?: LaunchOptions;
  timeoutMs?: number;
}

export class CodexModels implements EngineModels {
  private cache: { key: string; list: ClaudeModelList } | null = null;
  private inflight: { key: string; p: Promise<ClaudeModelList> } | null = null;

  constructor(private deps: CodexModelsDeps) {}

  invalidate(): void {
    this.cache = null;
  }

  cached(): ClaudeModelList | null {
    return this.cache?.list ?? null;
  }

  label(value: string | undefined): string {
    const list = this.cache?.list;
    if (!value) return list?.defaultName ? `Codex 기본값 (${list.defaultName})` : 'Codex 기본값';
    return list?.models.find((m) => m.value === value)?.name ?? value;
  }

  async list(refresh = false): Promise<ClaudeModelList> {
    const cfg = await getOpenAiStored();
    const cli = await this.deps.cliTarget();
    if (!cli.ok) return { models: [], error: cli.message, at: nowIso() };
    const key = `${cli.target.exec}|${cli.version}|${await openAiAuthKey({ ...cfg, model: undefined })}`;
    if (!refresh && this.cache?.key === key) return this.cache.list;
    if (this.inflight?.key === key) return this.inflight.p;
    const p = this.fetch(cfg, cli).then((list) => {
      if (!list.error) this.cache = { key, list };
      return list;
    });
    this.inflight = { key, p };
    try {
      return await p;
    } finally {
      if (this.inflight?.p === p) this.inflight = null;
    }
  }

  private async fetch(cfg: OpenAiStored, cli: CliResult & { ok: true }): Promise<ClaudeModelList> {
    if (cfg.authMode === 'azure') {
      const d = cfg.azure?.deployment;
      const account = toCodexAccount(null, cfg);
      return d ? { models: [{ value: d, name: d, description: 'Azure OpenAI 배포' }], defaultName: d, ...(account ? { account } : {}), at: nowIso() } : { models: [], error: 'Azure OpenAI 배포 이름을 넣어 주세요', at: nowIso() };
    }
    let plan: LaunchPlan;
    try {
      plan = await launchPlan(cfg, this.deps.launch);
    } catch (e) {
      return { models: [], error: (e as Error).message, at: nowIso() };
    }
    const cwd = path.join(dataDir(), 'codex-check');
    fs.mkdirSync(cwd, { recursive: true });
    try {
      return await withCodex(cli.target, plan, this.deps.appVersion(), cwd, async (s) => {
        const acct = await readAccount(s).catch(() => null);
        const r = await s.request<{ data?: unknown[] }>('model/list', { limit: 100, includeHidden: false }, this.deps.timeoutMs ?? 30000);
        const list = toCodexModels(r?.data);
        const account = toCodexAccount(acct?.account ?? null, cfg);
        const out: ClaudeModelList = {
          models: list.models,
          ...(list.defaultName ? { defaultName: list.defaultName, defaultDescription: `Codex 설정의 기본 모델 (${list.defaultValue})` } : {}),
          ...(account ? { account } : {}),
          at: nowIso(),
        };
        if (!list.models.length) out.error = '이 Codex는 모델 목록을 알려 주지 않습니다. 모델 이름을 직접 입력할 수 있습니다.';
        return out;
      });
    } catch (e) {
      return { models: [], error: `모델 목록을 받지 못했습니다: ${(e as Error)?.message ?? String(e)}`, at: nowIso() };
    }
  }
}
