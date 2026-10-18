// 형상관리 도구 규격. Git·SVN·없음이 같은 규격을 구현하고, 새 도구도 이것만 구현해 adapters에 더한다 (기획서 8.6).
//   감지(detect) · 연결 확인(check) · 변경 상태(status) · 커밋(commit) · 푸시(push)
// 작업 사본은 도구와 상관없이 앱 작업 폴더의 복사본이고(work/), 되돌리기는 적용 전 백업으로 한다(history.ts).
import type { VcsInfo } from '../../shared/desktop-api';

export type VcsKind = VcsInfo['kind'];

export interface CommitFile {
  /** 프로젝트 폴더 기준 상대 경로 ('/' 구분) */
  path: string;
  status: 'modified' | 'added' | 'deleted';
}

export interface CommitResult {
  /** 짧은 커밋 해시 또는 'r123' */
  hash: string;
  /** 커밋에서 뺀 파일 등 알릴 내용 */
  note?: string;
}

export interface VcsAdapter {
  readonly kind: VcsKind;
  /** 화면 표시 이름 (Git·SVN·없음) */
  readonly label: string;
  /** 표식 폴더 (.git·.svn) */
  readonly marker?: string;
  readonly canCommit: boolean;
  readonly canPush: boolean;
  /** 저장소 위치·브랜치·원격·커밋 안 된 변경 수 */
  detect(root: string): Promise<VcsInfo>;
  /** 원격 저장소 연결 확인과 로그인 안내 (계정 정보는 읽지 않음) */
  check(root: string, info: VcsInfo): Promise<{ remote?: { ok: boolean; message: string }; login?: string }>;
  /** 커밋 안 된 변경이 있는 경로 (프로젝트 폴더 기준) → 상태 */
  status(root: string): Promise<Map<string, string>>;
  /** 지정한 파일만 커밋 (다른 커밋 안 된 변경은 섞지 않음). 실패하면 사유를 담은 오류 */
  commit(root: string, files: CommitFile[], message: string): Promise<CommitResult>;
  /** 원격 저장소로 올림. 올린 곳 표시 ('origin develop') */
  push(root: string): Promise<string>;
}

/** status 결과에서 이 파일이 커밋 안 된 변경인지 (상위 폴더가 통째로 새 폴더인 경우 포함) */
export function isDirtyPath(status: Map<string, string>, rel: string): boolean {
  if (status.has(rel)) return true;
  let p = rel;
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/')) {
    p = p.slice(0, i);
    const s = status.get(p) ?? status.get(`${p}/`);
    if (s && /^(\?\?|A |unversioned|added)/.test(s)) return true;
  }
  return false;
}
