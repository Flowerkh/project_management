// POP-03 Claude 연결 (fork C가 채움). 지금은 자리만 잡는다.
import { Modal } from '../../components/Dialogs';

export function ClaudeDialog(props: { onClose: () => void }) {
  return (
    <Modal title="Claude 연결" icon="sparkle" onClose={props.onClose} foot={<button type="button" class="btn" onClick={props.onClose}>닫기</button>}>
      <div class="muted">준비 중입니다.</div>
    </Modal>
  );
}
