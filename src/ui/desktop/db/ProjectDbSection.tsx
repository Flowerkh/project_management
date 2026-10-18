// POP-04 오른쪽: DB 연결 · 환경별 규칙 · 가림 대상 · 메뉴 테이블 (fork D가 채움)
import type { ProjectSectionProps } from '../ProjectDialog';

export function ProjectDbSection(props: ProjectSectionProps) {
  return (
    <section class="pc-sec">
      <h3>DB 연결</h3>
      <div class="muted">준비 중입니다. 연결 {props.draft.db.length}개</div>
    </section>
  );
}
