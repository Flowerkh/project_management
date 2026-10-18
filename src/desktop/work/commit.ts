// 적용·되돌리기·다시 시도에서 함께 쓰는 커밋·푸시: 지정한 파일만 커밋하고 결과를 작업 이력 진행 기록에 남긴다.
// 실패해도 파일은 적용된 그대로 두고 MSG-25 문구를 기록에 남긴다 (작업 이력에서 [다시 시도]).
import type { ApplyResult, HistoryEntry } from '../../shared/desktop-api';
import { msg } from '../../ui/desktop/messages';
import { need } from '../services';
import { canCommit, type CommitFile, detectVcs } from '../vcs/index';

export const CLAUDE_MARK = 'Claude가 작성한 변경';

/** 커밋 메시지: 첫 줄 '제목 (Claude가 작성한 변경)', 다음 줄부터 변경 이유 */
export function commitMessage(title: string, reason?: string): { subject: string; full: string } {
  const t = title.replace(/\s+/g, ' ').trim() || '코드 수정';
  const subject = t.includes(CLAUDE_MARK) ? t : `${t} (${CLAUDE_MARK})`;
  const body = (reason ?? '').trim();
  return { subject, full: body && body !== t ? `${subject}\n\n${body}\n` : `${subject}\n` };
}

export interface CommitOutcome {
  commit?: ApplyResult['commit'];
  push?: ApplyResult['push'];
  entry: HistoryEntry | null;
}

/**
 * 기록 항목(entryId)의 파일을 커밋하고(want.commit) 푸시한다(want.push, Git만).
 * pushOnly: 이미 커밋했고 푸시만 다시 할 때. retry: 진행 기록에 '(다시 시도)' 표시
 */
export async function commitAndPush(
  root: string,
  entryId: string,
  files: CommitFile[],
  want: { commit: boolean; push: boolean },
  message: { subject: string; full: string },
  opts: { pushOnly?: boolean; retry?: boolean } = {},
): Promise<CommitOutcome> {
  const history = need('history');
  const { adapter, info } = await detectVcs(root, true);
  const out: CommitOutcome = { entry: await history.get(root, entryId) };
  if (adapter.kind === 'none') return out;
  const tool = adapter.label;
  const again = opts.retry ? ' (다시 시도)' : '';
  const fail = async (what: '커밋' | '푸시', reason: string) => {
    await history.addStep(root, entryId, { label: `${what}${again}`, detail: reason, ok: false });
    out.entry = await history.update(root, entryId, { error: msg('MSG-25', { 도구: tool, '커밋/푸시': what, 사유: reason }) });
  };
  if (!opts.pushOnly && want.commit) {
    if (!canCommit(adapter, info)) {
      const reason = info.error ?? `${tool} 명령을 찾지 못했습니다`;
      out.commit = { ok: false, error: reason };
      await fail('커밋', reason);
      return out;
    }
    try {
      const r = await adapter.commit(root, files, message.full);
      out.commit = { ok: true, hash: r.hash };
      await history.addStep(root, entryId, { label: `커밋${again}`, detail: `${r.hash} · "${message.subject}"${r.note ? ` · ${r.note}` : ''}`, ok: true });
      out.entry = await history.update(root, entryId, { status: '커밋됨', commit: r.hash, message: message.subject, branch: info.branch, error: undefined });
    } catch (e) {
      const reason = (e as Error).message || String(e);
      out.commit = { ok: false, error: reason };
      await fail('커밋', reason);
      return out;
    }
  }
  if (want.push && adapter.canPush) {
    if (!canCommit(adapter, info)) {
      const reason = info.error ?? `${tool} 명령을 찾지 못했습니다`;
      out.push = { ok: false, error: reason };
      await fail('푸시', reason);
      return out;
    }
    try {
      const where = await adapter.push(root);
      out.push = { ok: true };
      await history.addStep(root, entryId, { label: `푸시${again}`, detail: `${where} · 원격 저장소에 올림`, ok: true });
      out.entry = await history.update(root, entryId, { status: '푸시됨', pushed: true, error: undefined });
    } catch (e) {
      const reason = (e as Error).message || String(e);
      out.push = { ok: false, error: reason };
      await fail('푸시', reason);
    }
  }
  return out;
}
