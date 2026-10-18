// SCR-10 변경 검토 (fork V가 채움). 지금은 자리만 잡는다.
export function ChangesView(props: { workId: string; conversationId?: string }) {
  return (
    <div class="page">
      <h1 class="page-title">변경 검토</h1>
      <div class="empty-note">준비 중입니다. (작업 사본 {props.workId})</div>
    </div>
  );
}
