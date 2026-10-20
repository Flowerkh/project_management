// 여러 AI(Claude·Gemini·ChatGPT)를 화면에서 다룰 때 함께 쓰는 것: 글자 배지, 연결 상태·켜짐, 새 대화의 AI, AI별 문구.
import type { AiProvider, ClaudeStatus } from '../../../shared/desktop-api';
import { AI_LABEL, AI_PROVIDERS } from '../../../shared/desktop-api';
import type { DeskApp } from '../ctx';
import './ai.css';

export const BADGE: Record<AiProvider, { letter: string; bg: string; fg: string }> = {
  claude: { letter: 'C', bg: '#f8e7dd', fg: '#8f3b16' },
  gemini: { letter: 'G', bg: '#e3ebfd', fg: '#1d4ed8' },
  openai: { letter: 'O', bg: '#e2f2e9', fg: '#1c6e46' },
};

/** AI 글자 배지 (C · G · O) */
export function AiBadge(props: { provider: AiProvider; size?: number; title?: string }) {
  const s = props.size ?? 24;
  const b = BADGE[props.provider];
  return (
    <span
      class={`ai-badge ai-${props.provider}`}
      style={{ width: `${s}px`, height: `${s}px`, fontSize: `${Math.max(10, Math.round(s * 0.48))}px`, borderRadius: `${Math.round(s * 0.28)}px`, background: b.bg, color: b.fg }}
      aria-hidden={props.title ? undefined : 'true'}
      title={props.title}
    >
      {b.letter}
    </span>
  );
}

export function aiLabel(p: AiProvider | undefined): string {
  return AI_LABEL[p ?? 'claude'];
}

/** 연동을 켰는지 */
export function providerEnabled(app: DeskApp, p: AiProvider): boolean {
  if (p === 'claude') return !!app.claudeConfig?.enabled;
  if (p === 'gemini') return !!app.ai.gemini?.enabled;
  return !!app.ai.openai?.enabled;
}

export function providerStatus(app: DeskApp, p: AiProvider): ClaudeStatus | null {
  return app.ai.status[p] ?? null;
}

/** 화면에 보일 상태 (꺼져 있으면 off) */
export function shownState(app: DeskApp, p: AiProvider): ClaudeStatus['state'] | undefined {
  const st = providerStatus(app, p)?.state;
  if (st === 'missing') return st;
  if (!providerEnabled(app, p)) return 'off';
  return st;
}

/** 대화를 쓸 수 없는 상태 (꺼짐·설치 안 됨) */
export function providerBlocked(app: DeskApp, p: AiProvider): boolean {
  const st = shownState(app, p);
  return st === 'off' || st === 'missing';
}

/** 새 대화의 AI: 기본 AI가 켜져 있으면 그것, 아니면 켜진 첫 AI, 모두 꺼져 있으면 기본 AI */
export function chatProvider(app: DeskApp): AiProvider {
  const def = app.ai.settings?.defaultProvider ?? 'claude';
  if (providerEnabled(app, def)) return def;
  return AI_PROVIDERS.find((p) => providerEnabled(app, p)) ?? def;
}

/** 켜진 AI가 하나도 없음 */
export function noneEnabled(app: DeskApp): boolean {
  return !AI_PROVIDERS.some((p) => providerEnabled(app, p));
}

/** 켠 AI가 없을 때 처음 열 설정 페이지: 기본 AI의 연결 (왼쪽 칸에서 다른 AI도 고를 수 있음) */
export function setupPage(app: DeskApp): AiProvider {
  return app.ai.settings?.defaultProvider ?? 'claude';
}

/** 대화 내용을 보내는 곳 (대화창 아래 안내) */
export function sendTarget(app: DeskApp, p: AiProvider): string {
  if (p === 'claude') {
    const c = app.claudeConfig;
    if (c?.authMode === 'cloud' && c.cloud) return c.cloud.provider === 'bedrock' ? 'Amazon Bedrock' : c.cloud.provider === 'vertex' ? 'Google Cloud' : 'Microsoft Foundry';
    return 'Anthropic';
  }
  if (p === 'gemini') return app.ai.gemini?.authMode === 'vertex' ? '회사 Google Cloud' : 'Google';
  return app.ai.openai?.authMode === 'azure' ? '회사 Azure OpenAI' : 'OpenAI';
}

export { providerMsg } from './text';
