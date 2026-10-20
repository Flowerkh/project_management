// AI 공통 채널: 기본 AI·셸 허용 목록, AI별 연결 상태·모델 목록 (claude는 claude.status·claude.models와 같은 값)
import type { AiProvider, AiSettings, ClaudeModelList, ClaudeStatus } from '../../shared/desktop-api';
import { AI_LABEL } from '../../shared/desktop-api';
import type { ClaudeManager } from '../claude/manager';
import type { ModelCatalog } from '../claude/models';
import type { StatusManager } from '../claude/status';
import { DesktopError, handle } from '../ipc';
import type { EngineMap } from './engine';
import { getAiSettings, isProvider, setAiSettings } from './settings';

export interface AiChannelContext {
  manager: ClaudeManager;
  status: StatusManager;
  models: ModelCatalog;
  engines: EngineMap;
}

function need(p: unknown): AiProvider {
  if (!isProvider(p)) throw new DesktopError('AI 종류가 올바르지 않습니다', 'invalid');
  return p;
}

export function registerAiChannels(ctx: AiChannelContext): void {
  const engineOf = (p: Exclude<AiProvider, 'claude'>) => {
    const e = ctx.engines[p];
    if (!e) throw new DesktopError(`${AI_LABEL[p]} 연결을 이 앱에서 쓸 수 없습니다`, 'unavailable');
    return e;
  };

  handle('ai.settings.get', () => getAiSettings());
  handle('ai.settings.set', async (patch: Partial<AiSettings>) => {
    const before = await getAiSettings();
    const next = await setAiSettings(patch ?? {});
    // 셸 허용 목록이 바뀌면 쉬고 있는 대화는 다음 메시지 때 새 규칙으로 다시 연다
    if (JSON.stringify(before.shellAllow) !== JSON.stringify(next.shellAllow)) ctx.manager.closeIdle();
    return next;
  });

  handle('ai.status', async (provider, recheck): Promise<ClaudeStatus> => {
    const p = need(provider);
    // [다시 확인]: 다른 계정으로 로그인했을 수 있으니 쉬고 있는 연결은 닫는다 (다음 메시지에 새 로그인으로 다시 엶)
    if (recheck) ctx.manager.closeIdle(p);
    if (p === 'claude') return ctx.status.get(!!recheck);
    return engineOf(p).status.get(!!recheck);
  });

  handle('ai.models', async (provider, refresh): Promise<ClaudeModelList> => {
    const p = need(provider);
    if (p === 'claude') return ctx.models.list(!!refresh);
    return engineOf(p).models.list(!!refresh);
  });
}
