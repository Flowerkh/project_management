// 상단 [AI 대화 ●] 버튼: 점 색으로 연결 상태 (RULE: 사용 가능 초록 · 인증 필요 주황 · 오프라인 회색 · 꺼짐·설치 안 됨 빈 고리)
// Ctrl+J로 대화 열기·닫기 (RULE 키보드 단축키)
import { useEffect, useRef } from 'preact/hooks';
import type { ClaudeStatus } from '../../../shared/desktop-api';
import { AI_LABEL, AI_PROVIDERS } from '../../../shared/desktop-api';
import { Icon } from '../../icons';
import { chatProvider, noneEnabled, providerStatus, shownState } from '../ai/providers';
import type { DeskApp } from '../ctx';
import './claude.css';

export const STATE_LABEL: Record<ClaudeStatus['state'], string> = {
  on: '사용 가능',
  login: '인증 필요',
  offline: '오프라인',
  off: '꺼짐',
  missing: '설치 안 됨',
};

const STATE_HELP: Record<ClaudeStatus['state'], string> = {
  on: '연결·인증이 확인됨',
  login: '로그인이나 API 키·클라우드 인증을 확인해 주세요',
  offline: '인터넷에 연결되어 있지 않습니다. 분석 기능은 그대로 쓸 수 있습니다',
  off: '연동이 꺼져 있습니다. 누르면 그 AI의 연결 설정',
  missing: '실행 파일을 찾지 못했습니다. 누르면 그 AI의 연결 설정',
};

/** 연결 상태 점. 꺼짐·설치 안 됨은 빈 고리라 색이 아니라 모양으로도 구분된다 */
export function StatusDot(props: { state: ClaudeStatus['state'] | undefined; size?: number }) {
  const s = props.size ?? 8;
  const st = props.state ?? 'off';
  const cls = st === 'off' || st === 'missing' ? 'off' : st;
  return <span class={`cl-dot ${cls}`} style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true" />;
}

/**
 * 상단 [AI 대화 ●]: 새 대화의 AI(기본 AI, 꺼져 있으면 켜진 AI) 연결 상태를 점으로. 켠 AI가 없으면 빈 고리.
 * 툴팁에 AI별 상태를 모두 보인다.
 */
export function AiButton(props: { app: DeskApp; pressed: boolean; onClick: () => void; disabled?: boolean }) {
  const { app } = props;
  const none = noneEnabled(app);
  const p = chatProvider(app);
  const st = none ? 'off' : shownState(app, p);
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

  const label = none ? '켠 AI 없음' : st ? `${AI_LABEL[p]} ${STATE_LABEL[st]}` : `${AI_LABEL[p]} 확인 중`;
  const lines = [
    none ? '켠 AI가 없습니다. 누르면 AI 연결 설정' : `새 대화: ${AI_LABEL[p]} · ${st ? STATE_HELP[st].replace(/Claude/g, AI_LABEL[p]) : '연결 상태를 확인하는 중입니다'}`,
    ...AI_PROVIDERS.map((x) => {
      const s = shownState(app, x);
      return `${AI_LABEL[x]}: ${s ? STATE_LABEL[s] : '확인 중'}`;
    }),
  ];
  const msg = !none ? providerStatus(app, p)?.message : undefined;
  if (msg && st !== 'on') lines.push(msg);
  return (
    <button
      type="button"
      class={`btn cp-claude-btn${props.pressed ? ' pressed' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={`AI 대화 (${label})`}
      aria-pressed={props.pressed}
      aria-keyshortcuts="Control+J"
      title={`${lines.join('\n')}\n대화 열기·닫기: Ctrl+J`}
    >
      <Icon name="chat" size={16} color="var(--ink2)" />
      <span class="btn-t">AI 대화</span>
      <StatusDot state={st} />
    </button>
  );
}
