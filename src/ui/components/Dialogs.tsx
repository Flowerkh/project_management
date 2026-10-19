import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_EXCLUDE_DIRS } from '../../engine/files';
import { Icon, Spinner } from '../icons';
import { ModalSizer } from './ModalSizer';

export interface Settings {
  exclude: string[];
  maxFileMB: number;
}

export const DEFAULT_SETTINGS: Settings = { exclude: [], maxFileMB: 2 };

function useEsc(onClose: () => void) {
  useEffect(() => {
    // 한글 입력 중(조합 중) Esc는 조합만 취소
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
}

export function Modal(props: { title: ComponentChildren; icon?: string; onClose: () => void; children: ComponentChildren; foot?: ComponentChildren; small?: boolean; sizeId?: string }) {
  useEsc(props.onClose);
  // 작은 확인 창은 크기 조절 없이
  const sizeId = props.small ? null : (props.sizeId ?? `modal:${typeof props.title === 'string' ? props.title : 'dialog'}`);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={`modal${props.small ? ' sm' : ''}`} role="dialog" aria-modal="true">
        <div class="modal-head">
          {props.icon && <Icon name={props.icon} size={18} color="var(--acc)" />}
          <h2>{props.title}</h2>
          <button type="button" class="icon-btn" style={{ marginLeft: 'auto' }} onClick={props.onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
        {props.foot && <div class="modal-foot">{props.foot}</div>}
        {sizeId && <ModalSizer id={sizeId} />}
      </div>
    </div>
  );
}

export type SettingsPageId = 'analysis' | 'claude';

/** 설정 창의 [저장]이 페이지마다 부르는 것 */
export interface SettingsPageHandle {
  /** 저장할 변경이 있음 */
  dirty(): boolean;
  /** 저장. 못 하면 false (까닭은 그 페이지에 보임) */
  save(): Promise<boolean>;
}

/** 설정 창 왼쪽 칸에 더하는 페이지 (데스크톱: Claude 연결) */
export interface SettingsPage {
  id: SettingsPageId;
  label: string;
  icon: ComponentChildren;
  /** 이름 아래 작은 글 (예: 켜짐 · 사용 가능) */
  hint?: ComponentChildren;
  /** handle: [저장]할 때 부를 것을 넣음 · done: 페이지가 스스로 저장을 마침(연동 켜기 등) → 나머지도 저장하고 창을 닫음 */
  render(api: { handle: { current: SettingsPageHandle | null }; done(toast: string): void }): ComponentChildren;
}

const ANALYSIS_PAGE = { id: 'analysis' as const, label: '분석', hint: '제외 폴더 · 파일 크기' };

/**
 * 설정: 분석 범위(제외 규칙·파일 크기). 데스크톱은 왼쪽 칸에서 Claude 연결 같은 페이지를 고른다.
 * 한 번 연 페이지는 다른 칸으로 옮겨도 고치던 값이 남고, [저장]은 바뀐 페이지를 모두 저장한다.
 */
export function SettingsModal(props: { value: Settings; onSave: (s: Settings, toast?: string) => void; onClose: () => void; hasResult: boolean; page?: SettingsPageId; pages?: SettingsPage[] }) {
  const [text, setText] = useState(props.value.exclude.join('\n'));
  const [mb, setMb] = useState(String(props.value.maxFileMB));
  const extra = props.pages ?? [];
  const [page, setPage] = useState<SettingsPageId>(props.page && extra.some((p) => p.id === props.page) ? props.page : 'analysis');
  // 처음 열 때 연결 확인 등을 하는 페이지는 고르기 전에는 그리지 않는다
  const [seen, setSeen] = useState<SettingsPageId[]>([page]);
  const handles = useRef<Partial<Record<SettingsPageId, { current: SettingsPageHandle | null }>>>({});
  const [busy, setBusy] = useState(false);
  useEsc(props.onClose);

  const analysis = (): Settings => {
    const exclude = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const n = Math.min(50, Math.max(0.1, Number(mb) || 2));
    return { exclude, maxFileMB: n };
  };

  const pick = (id: SettingsPageId) => {
    setPage(id);
    setSeen((v) => (v.includes(id) ? v : [...v, id]));
  };

  /** 바뀐 페이지를 모두 저장하고 닫는다 (skip: 이미 스스로 저장한 페이지) */
  const saveAll = async (toast?: string, skip?: SettingsPageId) => {
    setBusy(true);
    try {
      for (const p of extra) {
        if (p.id === skip) continue;
        const h = handles.current[p.id]?.current;
        if (h?.dirty() && !(await h.save())) {
          pick(p.id);
          return;
        }
      }
      props.onSave(analysis(), toast);
    } finally {
      setBusy(false);
    }
  };

  const analysisBody = (
    <>
      <div class="field">
        <label>분석 범위 · 기본 제외 폴더</label>
        <div class="chips">
          {DEFAULT_EXCLUDE_DIRS.slice(0, 18).map((d) => (
            <span key={d} class="tag neutral mono">{d}</span>
          ))}
          <span class="muted" style={{ fontSize: '12px' }}>외 {Math.max(0, DEFAULT_EXCLUDE_DIRS.length - 18)}개</span>
        </div>
        <div class="help">이미지·압축 파일·압축된 라이브러리(*.min.js)와 외부 라이브러리(jQuery 등)도 기본으로 뺍니다.</div>
      </div>
      <div class="field">
        <label for="ex">추가 제외 규칙</label>
        <textarea id="ex" class="inp" placeholder={'한 줄에 하나씩\n예) docs/**\n예) *.generated.java\n예) legacy'} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <div class="help">'/'가 들어간 규칙은 불러온 폴더 기준 경로, 없으면 어느 위치의 이름이든 맞습니다. ** 는 하위 폴더 전체입니다.</div>
      </div>
      <div class="field">
        <label for="mb">파일 하나 최대 크기 (MB)</label>
        <input id="mb" class="inp" style={{ width: '120px' }} type="number" min="0.1" max="50" step="0.5" value={mb} onInput={(e) => setMb((e.target as HTMLInputElement).value)} />
        <div class="help">이보다 큰 파일은 분석에서 뺍니다 (기본 2MB).</div>
      </div>
    </>
  );

  const runNote = props.hasResult && page === 'analysis' && <span class="muted" style={{ marginRight: 'auto', fontSize: '12.5px' }}>바뀐 설정은 다음 [Run]부터 적용됩니다.</span>;

  // 브라우저(HTML) 빌드: 분석 설정만
  if (!extra.length)
    return (
      <Modal
        title="설정"
        icon="gear"
        onClose={props.onClose}
        foot={
          <>
            {runNote}
            <button type="button" class="btn" onClick={props.onClose}>취소</button>
            <button type="button" class="btn primary" onClick={() => void saveAll()}>저장</button>
          </>
        }
      >
        {analysisBody}
      </Modal>
    );

  const all: { id: SettingsPageId; label: string; icon: ComponentChildren; hint?: ComponentChildren }[] = [{ ...ANALYSIS_PAGE, icon: <Icon name="sliders" size={17} color="var(--ink2)" /> }, ...extra];
  const onNavKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = all.findIndex((p) => p.id === page);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    pick(all[j].id);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')[j]?.focus();
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal set-dlg" role="dialog" aria-modal="true" aria-label="설정">
        <div class="modal-head">
          <Icon name="gear" size={18} color="var(--acc)" />
          <h2>설정</h2>
          <button type="button" class="icon-btn" style={{ marginLeft: 'auto' }} onClick={props.onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="set-body">
          <div class="set-nav" role="tablist" aria-orientation="vertical" aria-label="설정 항목" onKeyDown={onNavKey}>
            {all.map((p) => (
              <button
                type="button"
                key={p.id}
                id={`set-tab-${p.id}`}
                role="tab"
                aria-selected={page === p.id}
                aria-controls={`set-page-${p.id}`}
                tabIndex={page === p.id ? 0 : -1}
                class={`set-tab${page === p.id ? ' on' : ''}`}
                onClick={() => pick(p.id)}
              >
                <span class="ic">{p.icon}</span>
                <span class="tx">
                  <span class="l">{p.label}</span>
                  {p.hint && <span class="h">{p.hint}</span>}
                </span>
              </button>
            ))}
          </div>
          <div class="set-main">
            <section class="set-page" id="set-page-analysis" role="tabpanel" aria-labelledby="set-tab-analysis" aria-label="분석" hidden={page !== 'analysis'}>
              <div class="set-page-h">
                <h3>분석</h3>
                <span class="s">[Run]으로 분석할 때 뺄 파일과 크기 기준입니다</span>
              </div>
              {analysisBody}
            </section>
            {extra.map((p) => {
              if (!seen.includes(p.id)) return null;
              const handle = (handles.current[p.id] ??= { current: null });
              return (
                <section key={p.id} class="set-page" id={`set-page-${p.id}`} role="tabpanel" aria-labelledby={`set-tab-${p.id}`} aria-label={p.label} hidden={page !== p.id}>
                  {p.render({ handle, done: (toast) => void saveAll(toast, p.id) })}
                </section>
              );
            })}
          </div>
        </div>
        <div class="modal-foot">
          {runNote}
          <button type="button" class="btn" onClick={props.onClose}>취소</button>
          <button type="button" class="btn primary" onClick={() => void saveAll()} disabled={busy}>
            {busy && <Spinner size={13} color="#fff" />}
            저장
          </button>
        </div>
        <ModalSizer id="settings" minWidth={640} sides />
      </div>
    </div>
  );
}

export function ConfirmDialog(props: { title: string; message: ComponentChildren; ok: string; danger?: boolean; cancel?: string; onOk: () => void; onClose: () => void; extra?: { label: string; onClick: () => void } }) {
  return (
    <Modal
      title={props.title}
      small
      onClose={props.onClose}
      foot={
        <>
          <button type="button" class="btn" onClick={props.onClose}>{props.cancel ?? '취소'}</button>
          {props.extra && <button type="button" class="btn" onClick={props.extra.onClick}>{props.extra.label}</button>}
          <button type="button" class={`btn ${props.danger ? 'danger' : 'primary'}`} onClick={props.onOk}>{props.ok}</button>
        </>
      }
    >
      <div style={{ fontSize: '13.5px', lineHeight: 1.6 }}>{props.message}</div>
    </Modal>
  );
}
