// SCR-12 작업 이력 (fork V가 채움). 지금은 자리만 잡는다.
export function HistoryView(props: { entryId?: string }) {
  return (
    <div class="page">
      <h1 class="page-title">작업 이력</h1>
      <div class="empty-note">준비 중입니다.{props.entryId ? ` (${props.entryId})` : ''}</div>
    </div>
  );
}
