// 잠깐 띄우는 Codex (모델 목록·계정·연결 확인): 띄우고 → 일 → 끔
import type { CliTarget } from '../claude/cli';
import type { LaunchPlan } from './launch';
import { AppServer } from './rpc';

export async function withCodex<T>(target: CliTarget, plan: LaunchPlan, appVersion: string, cwd: string, fn: (s: AppServer) => Promise<T>, onNotification?: (method: string, params: Record<string, any>) => void): Promise<T> {
  const s = await AppServer.start({
    target,
    args: plan.args,
    env: plan.env,
    cwd,
    appVersion,
    onNotification,
    // 확인용 대화는 도구가 없다 — 오는 요청은 모두 거절
    onRequest: async (method) => {
      throw new Error(`연결 확인 중에는 지원하지 않는 요청입니다: ${method}`);
    },
  });
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

export interface CodexAccount {
  type?: string;
  email?: string | null;
  planType?: string | null;
}

export async function readAccount(s: AppServer): Promise<{ account: CodexAccount | null; requiresOpenaiAuth: boolean }> {
  const r = await s.request<{ account?: CodexAccount | null; requiresOpenaiAuth?: boolean }>('account/read', { refreshToken: false }, 20000);
  return { account: r?.account ?? null, requiresOpenaiAuth: !!r?.requiresOpenaiAuth };
}
