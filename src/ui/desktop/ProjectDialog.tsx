// POP-04 프로젝트 연결: 왼쪽 형상관리(ProjectVcsSection), 오른쪽 DB(ProjectDbSection). [저장]은 형상관리 기본값·DB 규칙·가림 대상·메뉴 테이블을 저장.
// DB 연결 자체(주소·계정·비밀번호)는 DB 섹션에서 추가·수정할 때 바로 저장한다.
import { useEffect, useState } from 'preact/hooks';
import type { ProjectSettings } from '../../shared/desktop-api';
import { ModalSizer } from '../components/ModalSizer';
import { Icon, Spinner } from '../icons';
import { errText } from './bridge';
import { useDesk } from './ctx';
import { ProjectDbSection } from './db/ProjectDbSection';
import { ProjectVcsSection } from './work/ProjectVcsSection';

export interface ProjectSectionProps {
  root: string;
  draft: ProjectSettings;
  /** 초안 고치기 ([저장] 전까지 파일에 쓰지 않음. db 목록은 섹션이 바로 저장한 뒤 갱신용) */
  patch(p: Partial<ProjectSettings>): void;
  /** 저장 전 확인 (편집 중인 연결이 있으면 false로 막기 등) */
  onBeforeSave(fn: () => boolean | Promise<boolean>): void;
}

export function ProjectDialog(props: { onClose: () => void }) {
  const app = useDesk();
  const root = app.root;
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checks] = useState<(() => boolean | Promise<boolean>)[]>([]);

  useEffect(() => {
    if (!root) return;
    app.desk.invoke('project.get', root, app.projectName).then(setDraft, (e) => setError(errText(e)));
  }, [root]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [props.onClose]);

  const save = async () => {
    if (!root || !draft) return;
    for (const c of checks) if (!(await c())) return;
    setSaving(true);
    try {
      const { applyDefaults, dbRules, maskPatterns, menuDb } = draft;
      await app.desk.invoke('project.set', root, { applyDefaults, dbRules, maskPatterns, menuDb });
      app.toast('프로젝트 연결을 저장했습니다.');
      props.onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const sectionProps: ProjectSectionProps | null =
    root && draft
      ? {
          root,
          draft,
          patch: (p) => setDraft((d) => (d ? { ...d, ...p } : d)),
          onBeforeSave: (fn) => {
            if (!checks.includes(fn)) checks.push(fn);
          },
        }
      : null;

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal xl" role="dialog" aria-modal="true" aria-label="프로젝트 연결">
        <div class="modal-head">
          <span class="pc-ic"><Icon name="link" size={17} color="var(--acc)" /></span>
          <div class="grow">
            <div class="row" style={{ gap: '8px' }}>
              <h2>프로젝트 연결</h2>
              <span class="mono muted" style={{ fontSize: '13px' }}>{app.projectName}</span>
            </div>
            <div class="muted" style={{ fontSize: '12.5px', marginTop: '2px' }}>변경 적용과 DB 조회에 쓰는 형상관리·DB입니다. 이 PC의 이 프로젝트에만 저장합니다</div>
          </div>
          <button type="button" class="icon-btn" onClick={props.onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        {!root ? (
          <div class="modal-body">
            <div class="banner info">
              <Icon name="info" size={15} />
              <span>폴더로 연 프로젝트에서만 쓸 수 있습니다. 원본 폴더를 연결한 뒤 다시 열어 주세요.</span>
            </div>
          </div>
        ) : !draft ? (
          <div class="modal-body">{error ? <div class="banner err">{error}</div> : <div class="row muted"><Spinner size={14} /> 불러오는 중</div>}</div>
        ) : (
          <div class="pc-body">
            <div class="pc-col">{sectionProps && <ProjectVcsSection {...sectionProps} />}</div>
            <div class="pc-col right">{sectionProps && <ProjectDbSection {...sectionProps} />}</div>
          </div>
        )}
        <div class="modal-foot">
          <span class="row muted grow" style={{ fontSize: '12.5px', gap: '6px' }}>
            <Icon name="lock" size={14} />
            DB 비밀번호는 Windows 사용자 계정으로 암호화해 저장하고 Claude에는 넘기지 않습니다. Git·SVN은 PC에 저장된 로그인을 그대로 씁니다.
          </span>
          {error && draft && <span class="err-text">{error}</span>}
          <button type="button" class="btn" onClick={props.onClose}>취소</button>
          <button type="button" class="btn primary" onClick={save} disabled={!draft || saving}>
            {saving && <Spinner size={13} color="#fff" />}
            저장
          </button>
        </div>
        <ModalSizer id="project" minWidth={560} />
      </div>
    </div>
  );
}
