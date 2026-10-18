// SCR-11 새 프로젝트 (fork C가 채움). 지금은 자리만 잡는다.
export function NewProjectView(props: { onCancel: () => void; onOpenFolder: (root: string) => void }) {
  return (
    <div class="page">
      <h1 class="page-title">새 프로젝트</h1>
      <div class="empty-note">준비 중입니다.</div>
      <div>
        <button type="button" class="btn" onClick={props.onCancel}>돌아가기</button>
      </div>
    </div>
  );
}
