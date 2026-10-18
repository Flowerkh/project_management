// SCR-09 ⑧ 변경 쿼리 카드 (fork D가 채움): SQL·대상 DB·예상 행 수, [SQL 복사] [실행] → 확인 창(MSG-32·33·41·39)
import type { QueryCard } from '../../../shared/desktop-api';

export function QueryCardView(props: { card: QueryCard }) {
  const c = props.card;
  return (
    <div class="qcard">
      <div class="row">
        <b>변경 쿼리</b>
        <span class="muted">{c.kind.toUpperCase()} · {c.dbName}</span>
      </div>
      <pre class="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{c.sql}</pre>
    </div>
  );
}
