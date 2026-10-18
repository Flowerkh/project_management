// 상단 [Claude ●] 버튼: 점 색으로 연결 상태 (사용 가능 / 인증 필요 / 오프라인 / 꺼짐·설치 안 됨)
import type { ClaudeStatus } from '../../../shared/desktop-api';
import { Icon } from '../../icons';

export const STATE_LABEL: Record<ClaudeStatus['state'], string> = {
  on: '사용 가능',
  login: '인증 필요',
  offline: '오프라인',
  off: '꺼짐',
  missing: '설치 안 됨',
};

export function StatusDot(props: { state: ClaudeStatus['state'] | undefined; size?: number }) {
  const s = props.size ?? 8;
  const st = props.state ?? 'off';
  if (st === 'off' || st === 'missing') return <span class="cl-dot off" style={{ width: `${s}px`, height: `${s}px` }} />;
  return <span class={`cl-dot ${st}`} style={{ width: `${s}px`, height: `${s}px` }} />;
}

export function ClaudeButton(props: { status: ClaudeStatus | null; pressed: boolean; onClick: () => void; disabled?: boolean }) {
  const st = props.status?.state;
  return (
    <button
      type="button"
      class={`btn${props.pressed ? ' pressed' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={`Claude 대화 (${STATE_LABEL[st ?? 'off']})`}
      title={`Claude: ${STATE_LABEL[st ?? 'off']}${props.status?.message ? ` · ${props.status.message}` : ''}`}
    >
      <Icon name="chat" size={16} color="var(--ink2)" />
      Claude
      <StatusDot state={st} />
    </button>
  );
}
