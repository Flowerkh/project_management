// POP-04 왼쪽: 형상관리 · 연결 확인 · 적용 기본값 (fork V가 채움)
import type { ProjectSectionProps } from '../ProjectDialog';

export function ProjectVcsSection(props: ProjectSectionProps) {
  const d = props.draft.applyDefaults;
  return (
    <section class="pc-sec">
      <h3>형상관리</h3>
      <div class="muted">준비 중입니다.</div>
      <h3>적용 기본값</h3>
      <label class="ck">
        <input type="checkbox" checked={d.commit} onChange={(e) => props.patch({ applyDefaults: { commit: (e.target as HTMLInputElement).checked, push: d.push && (e.target as HTMLInputElement).checked } })} />
        적용 후 커밋
      </label>
      <label class="ck">
        <input type="checkbox" checked={d.push} disabled={!d.commit} onChange={(e) => props.patch({ applyDefaults: { commit: d.commit, push: (e.target as HTMLInputElement).checked } })} />
        커밋 후 푸시
      </label>
    </section>
  );
}
