// SCR-01 ⑩ 새 프로젝트 시작 카드 (데스크톱 앱). 켠 AI가 없거나 새 대화의 AI가 꺼졌으면 그 AI의 연결 설정(POP-03)부터 연다.
import type { ClaudeStatus } from '../../shared/desktop-api';
import { AI_LABEL } from '../../shared/desktop-api';
import { Icon } from '../icons';
import { chatProvider, noneEnabled, providerBlocked, setupPage, shownState } from './ai/providers';
import { StatusDot } from './claude/ClaudeButton';
import { useDeskApp } from './ctx';

const LABEL: Record<ClaudeStatus['state'], string> = {
  on: '사용 가능',
  login: '인증 필요',
  offline: '오프라인',
  off: '연동 꺼짐',
  missing: '설치 안 됨',
};

export function NewProjectCard(props: { onStart: () => void; disabled?: boolean }) {
  const app = useDeskApp();
  if (!app) return null;
  const none = noneEnabled(app);
  const p = chatProvider(app);
  const st = none ? 'off' : (shownState(app, p) ?? 'off');
  const click = () => {
    if (none) app.openSettings(setupPage(app));
    else if (providerBlocked(app, p)) app.openModal(p);
    else props.onStart();
  };
  return (
    <section class="card np-card">
      <span class="np-ic"><Icon name="sparkle" size={18} color="var(--acc)" /></span>
      <h3>새 프로젝트 시작</h3>
      <p>요구사항을 말하면 AI가 계획을 세우고 빈 폴더에 프로젝트를 만듭니다. 분석한 프로젝트의 구조를 참고할 수 있습니다.</p>
      <div class="row" style={{ gap: '10px', marginTop: 'auto' }}>
        <button type="button" class="btn" onClick={click} disabled={props.disabled}>
          <Icon name="plus" size={15} />
          새 프로젝트
        </button>
        <span class="row muted" style={{ gap: '6px', fontSize: '12.5px' }}>
          <StatusDot state={st} />
          {none ? '켠 AI 없음' : `${AI_LABEL[p]} ${LABEL[st]}`}
        </span>
      </div>
    </section>
  );
}
