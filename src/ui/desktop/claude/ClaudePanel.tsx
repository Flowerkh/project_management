// SCR-09 Claude 대화 패널 (fork C가 채움). 지금은 자리만 잡는다.
import { Icon } from '../../icons';
import { useDesk } from '../ctx';

export function ClaudePanel(props: { onClose: () => void }) {
  const app = useDesk();
  return (
    <aside class="chat-panel" aria-label="Claude 대화">
      <div class="chat-head">
        <span class="cl-logo"><Icon name="sparkle" size={16} color="#fff" /></span>
        <div class="grow">
          <div class="chat-title">Claude 대화</div>
          <div class="chat-sub">{app.projectName || '프로젝트'}</div>
        </div>
        <button type="button" class="icon-btn" onClick={props.onClose} aria-label="닫기">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div class="chat-body">
        <div class="empty-note">Claude 대화는 준비 중입니다.</div>
      </div>
    </aside>
  );
}
