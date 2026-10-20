// 화면·테이블·메뉴·배치 상세 머리의 [{AI}에게 묻기] (데스크톱 앱에서만 보임). 새 대화의 AI(기본 AI, 꺼져 있으면 켜진 AI)에게 묻는다.
import { AI_LABEL } from '../../shared/desktop-api';
import { Icon } from '../icons';
import type { Target } from '../model';
import { chatProvider, noneEnabled, providerBlocked, setupPage } from './ai/providers';
import { buildChatContext } from './claude/context';
import { useDeskApp } from './ctx';

export function AskClaude(props: { target: Target }) {
  const app = useDeskApp();
  if (!app) return null;
  const none = noneEnabled(app);
  const p = chatProvider(app);
  const onClick = () => {
    // 켠 AI가 없으면 기본 AI의 연결 설정, 새 대화의 AI가 꺼졌거나 설치되지 않았으면 그 AI의 연결 설정부터
    if (none) {
      app.openSettings(setupPage(app));
      return;
    }
    if (providerBlocked(app, p)) {
      app.openModal(p);
      return;
    }
    app.openChat({ context: buildChatContext(app.model, props.target) });
  };
  return (
    <button type="button" class="btn" onClick={onClick} style={{ flex: 'none' }} title={none ? '설정에서 AI 연동을 켠 뒤 쓸 수 있습니다' : `${AI_LABEL[p]}에게 이 항목을 맥락으로 붙여 묻습니다`}>
      <Icon name="chat" size={16} color="var(--ink2)" />
      {none ? 'AI에게 묻기' : `${AI_LABEL[p]}에게 묻기`}
    </button>
  );
}
