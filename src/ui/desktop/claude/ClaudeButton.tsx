// 상단 [Claude ●] 버튼: 점 색으로 연결 상태 (RULE: 사용 가능 초록 · 인증 필요 주황 · 오프라인 회색 · 꺼짐·설치 안 됨 빈 고리)
// Ctrl+J로 대화 열기·닫기 (RULE 키보드 단축키)
import { useEffect, useRef } from 'preact/hooks';
import type { ClaudeStatus } from '../../../shared/desktop-api';
import { Icon } from '../../icons';
import './claude.css';

export const STATE_LABEL: Record<ClaudeStatus['state'], string> = {
  on: '사용 가능',
  login: '인증 필요',
  offline: '오프라인',
  off: '꺼짐',
  missing: '설치 안 됨',
};

const STATE_HELP: Record<ClaudeStatus['state'], string> = {
  on: 'CLI 설치·인증·인터넷이 모두 확인됨',
  login: 'Claude Code 로그인이나 API 키·클라우드 인증을 확인해 주세요',
  offline: '인터넷에 연결되어 있지 않습니다. 분석 기능은 그대로 쓸 수 있습니다',
  off: '연동이 꺼져 있습니다. 누르면 Claude 연결',
  missing: 'Claude CLI를 찾지 못했습니다. 누르면 Claude 연결',
};

/** 연결 상태 점. 꺼짐·설치 안 됨은 빈 고리라 색이 아니라 모양으로도 구분된다 */
export function StatusDot(props: { state: ClaudeStatus['state'] | undefined; size?: number }) {
  const s = props.size ?? 8;
  const st = props.state ?? 'off';
  const cls = st === 'off' || st === 'missing' ? 'off' : st;
  return <span class={`cl-dot ${cls}`} style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true" />;
}

export function ClaudeButton(props: { status: ClaudeStatus | null; pressed: boolean; onClick: () => void; disabled?: boolean }) {
  const st = props.status?.state;
  const click = useRef(props.onClick);
  click.current = props.onClick;
  const disabled = useRef(props.disabled);
  disabled.current = props.disabled;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        if (!disabled.current) click.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const label = st ? STATE_LABEL[st] : '확인 중';
  const parts = [`Claude: ${label}`, st ? STATE_HELP[st] : '연결 상태를 확인하는 중입니다'];
  if (props.status?.version) parts.push(`CLI ${props.status.version}`);
  if (props.status?.message && st !== 'on') parts.push(props.status.message);
  return (
    <button
      type="button"
      class={`btn cp-claude-btn${props.pressed ? ' pressed' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={`Claude 대화 (${label})`}
      aria-pressed={props.pressed}
      aria-keyshortcuts="Control+J"
      title={`${parts.join(' · ')}\n대화 열기·닫기: Ctrl+J`}
    >
      <Icon name="chat" size={16} color="var(--ink2)" />
      Claude
      <StatusDot state={st} />
    </button>
  );
}
