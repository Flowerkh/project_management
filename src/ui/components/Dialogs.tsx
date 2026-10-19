import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_EXCLUDE_DIRS } from '../../engine/files';
import { Icon } from '../icons';
import { ModalSizer } from './ModalSizer';

export interface Settings {
  exclude: string[];
  maxFileMB: number;
}

export const DEFAULT_SETTINGS: Settings = { exclude: [], maxFileMB: 2 };

function useEsc(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
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

export function SettingsModal(props: { value: Settings; onSave: (s: Settings) => void; onClose: () => void; hasResult: boolean }) {
  const [text, setText] = useState(props.value.exclude.join('\n'));
  const [mb, setMb] = useState(String(props.value.maxFileMB));
  const save = () => {
    const exclude = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const n = Math.min(50, Math.max(0.1, Number(mb) || 2));
    props.onSave({ exclude, maxFileMB: n });
  };
  return (
    <Modal
      title="설정"
      icon="gear"
      onClose={props.onClose}
      foot={
        <>
          {props.hasResult && <span class="muted" style={{ marginRight: 'auto', fontSize: '12.5px' }}>바뀐 설정은 다음 [Run]부터 적용됩니다.</span>}
          <button type="button" class="btn" onClick={props.onClose}>취소</button>
          <button type="button" class="btn primary" onClick={save}>저장</button>
        </>
      }
    >
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
    </Modal>
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
