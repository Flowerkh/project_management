// 화면·테이블·메뉴·배치 상세 머리의 [Claude에게 묻기] (데스크톱 앱에서만 보임)
import { Icon } from '../icons';
import type { Target } from '../model';
import { buildChatContext } from './claude/context';
import { useDeskApp } from './ctx';

export function AskClaude(props: { target: Target }) {
  const app = useDeskApp();
  if (!app) return null;
  const onClick = () => {
    const st = app.claude?.state;
    // 연동이 꺼졌거나 CLI가 없으면 Claude 연결(POP-03)부터
    if (!app.claudeConfig?.enabled || st === 'off' || st === 'missing') {
      app.openModal('claude');
      return;
    }
    app.openChat({ context: buildChatContext(app.model, props.target) });
  };
  return (
    <button type="button" class="btn" onClick={onClick} style={{ flex: 'none' }}>
      <Icon name="chat" size={16} color="var(--ink2)" />
      Claude에게 묻기
    </button>
  );
}
