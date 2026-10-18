// SCR-01 ⑩ 새 프로젝트 시작 카드 (데스크톱 앱). 연동이 꺼져 있으면 Claude 연결(POP-03)부터 연다.
import type { ClaudeStatus } from '../../shared/desktop-api';
import { Icon } from '../icons';
import { StatusDot } from './claude/ClaudeButton';
import { useDeskApp } from './ctx';

const LABEL: Record<ClaudeStatus['state'], string> = {
  on: 'Claude 사용 가능',
  login: 'Claude 인증 필요',
  offline: '오프라인',
  off: 'Claude 연동 꺼짐',
  missing: 'Claude CLI 없음',
};

export function NewProjectCard(props: { onStart: () => void; disabled?: boolean }) {
  const app = useDeskApp();
  if (!app) return null;
  const st = app.claudeConfig?.enabled ? (app.claude?.state ?? 'off') : 'off';
  const click = () => {
    if (!app.claudeConfig?.enabled || st === 'off' || st === 'missing') app.openModal('claude');
    else props.onStart();
  };
  return (
    <section class="card np-card">
      <span class="np-ic"><Icon name="sparkle" size={18} color="var(--acc)" /></span>
      <h3>새 프로젝트 시작</h3>
      <p>요구사항을 말하면 Claude가 계획을 세우고 빈 폴더에 프로젝트를 만듭니다. 분석한 프로젝트의 구조를 참고할 수 있습니다.</p>
      <div class="row" style={{ gap: '10px', marginTop: 'auto' }}>
        <button type="button" class="btn" onClick={click} disabled={props.disabled}>
          <Icon name="plus" size={15} />
          새 프로젝트
        </button>
        <span class="row muted" style={{ gap: '6px', fontSize: '12.5px' }}>
          <StatusDot state={st} />
          {LABEL[st]}
        </span>
      </div>
    </section>
  );
}
