// Gemini 연동: 앱이 Gemini API(또는 회사 Google Cloud의 Vertex AI)에 바로 연결한다 (PC에 설치할 것 없음).
//   config.ts  설정·비밀 값        client.ts  REST(스트리밍·모델 목록·토큰 세기)   models.ts  모델 목록
//   status.ts  연결 상태           query.ts   대화(도구 순환)·기록
//   앱 도구 정의는 ../ai/tools.ts, 파일·명령 도구 실행은 ../ai/fstools.ts (ChatGPT와 같이 씀)
import path from 'node:path';
import type { GeminiConfigInput } from '../../shared/desktop-api';
import type { AiEngine, EngineHost } from '../ai/engine';
import { handle } from '../ipc';
import { dataDir, hasSecret } from '../store';
import { GeminiClient, type GeminiClientOptions } from './client';
import { geminiAuthKey, getGeminiApiKey, getGeminiConfig, getGeminiProxy, getGeminiStored, KEY_GEMINI_API, setGeminiConfig } from './config';
import { GeminiModels, pickDefaultModel } from './models';
import { forgetGeminiSession, GeminiQuery } from './query';
import { GeminiStatus } from './status';

export interface GeminiEngineOptions extends GeminiClientOptions {
  maxSteps?: number;
  retryDelays?: number[];
  commandTimeoutMs?: number;
  maxHistoryChars?: number;
}

export interface GeminiEngine extends AiEngine {
  status: GeminiStatus;
  models: GeminiModels;
  registerChannels(h: EngineHost): void;
}

export function createGeminiEngine(o: GeminiEngineOptions = {}): GeminiEngine {
  const sessionsDir = () => path.join(dataDir(), 'ai-sessions', 'gemini');
  const makeClient = async (): Promise<GeminiClient> => {
    const cfg = await getGeminiStored();
    return new GeminiClient(cfg, cfg.authMode === 'apikey' ? await getGeminiApiKey() : null, await getGeminiProxy(cfg), o);
  };
  const models = new GeminiModels({
    client: async () => {
      const cfg = await getGeminiStored();
      return { client: await makeClient(), cfg, key: await geminiAuthKey({ ...cfg, model: undefined }) };
    },
  });
  /** 이 대화에 모델을 고르지 않았을 때: 설정의 기본 모델 → 목록에서 고름 */
  const defaultModel = async () => pickDefaultModel(await getGeminiStored(), models.cached()?.models ?? null);
  const status = new GeminiStatus({
    client: makeClient,
    models,
    defaultModel,
    proxy: async () => getGeminiProxy(await getGeminiStored()),
    hasKey: () => hasSecret(KEY_GEMINI_API),
  });

  return {
    provider: 'gemini',
    status,
    models,
    enabled: async () => (await getGeminiStored()).enabled,
    defaultModel: async () => (await getGeminiStored()).model,
    open: (opts) =>
      GeminiQuery.open(opts, {
        client: makeClient,
        defaultModel,
        sessionsDir: sessionsDir(),
        maxSteps: o.maxSteps,
        retryDelays: o.retryDelays,
        commandTimeoutMs: o.commandTimeoutMs,
        maxHistoryChars: o.maxHistoryChars,
      }),
    forget: (id) => forgetGeminiSession(sessionsDir(), id),
    registerChannels(h: EngineHost) {
      handle('gemini.config.get', () => getGeminiConfig());
      handle('gemini.config.set', async (input: GeminiConfigInput) => {
        const r = await setGeminiConfig(input);
        if (r.authChanged || r.enabledNow || r.disabledNow) status.invalidate();
        if (r.authChanged) models.invalidate();
        if (r.disabledNow) await h.closeAll();
        else if (r.authChanged) h.closeIdle();
        if (r.enabledNow || r.disabledNow || r.authChanged) void status.get(false).catch(() => undefined);
        return r.config;
      });
    },
  };
}
