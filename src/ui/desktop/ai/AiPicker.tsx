// 대화창 입력란 아래 [AI·모델] 고르기와 [다른 AI로 새 대화] 확인 창.
//   이 대화 · {AI}: 같은 AI 안에서 모델을 바꾸면 대화가 이어진다(다음 응답부터).
//   다른 AI로 새 대화: AI를 바꾸면 새 대화로 시작한다. 시작 전(초안)이면 바로 바꾼다.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { AI_LABEL, AI_PROVIDERS, type AiProvider } from '../../../shared/desktop-api';
import { Modal } from '../../components/Dialogs';
import { Icon, Spinner } from '../../icons';
import { STATE_LABEL } from '../claude/ClaudeButton';
import type { DeskApp } from '../ctx';
import { connDefault, modelName, peekModels, type PickRow, pickedName, pickRows, useModels } from './models';
import { AiBadge, providerEnabled, shownState } from './providers';

export interface AiPickerProps {
  app: DeskApp;
  provider: AiProvider;
  /** 대화를 시작했는지 (아니면 다른 AI를 고르면 바로 바꿈) */
  started: boolean;
  rows: PickRow[];
  picked: string;
  loading: boolean;
  /** 모델 목록을 받지 못한 까닭 */
  error?: string;
  /** 이 AI가 꺼졌거나 설치되지 않음 (모델은 못 바꾸고 다른 AI만 고름) */
  blocked: boolean;
  anchor: { current: HTMLElement | null };
  onModel(v: string): void;
  onSwitch(p: AiProvider): void;
  onClose(): void;
}

const ITEM_SEL = '[role="menuitemradio"]:not([disabled]), [role="menuitem"]:not([disabled])';

export function AiPicker(props: AiPickerProps) {
  const { app, provider } = props;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const label = AI_LABEL[provider];
  const def = app.ai.settings?.defaultProvider ?? 'claude';

  // 고르기 버튼 바로 위에, 입력 영역 밖으로 나가지 않게
  useLayoutEffect(() => {
    const a = props.anchor.current;
    const b = box.current;
    const wrap = b?.offsetParent as HTMLElement | null;
    if (!a || !b || !wrap) return;
    const ar = a.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(wr.width - b.offsetWidth - 8, ar.left - wr.left - 40)), bottom: Math.max(0, wr.bottom - ar.top + 8) });
  }, []);

  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])') ?? box.current?.querySelector<HTMLElement>(ITEM_SEL);
    el?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || props.anchor.current?.contains(t)) return;
      props.onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
      props.anchor.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      props.onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>(ITEM_SEL) ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[j].focus();
  };

  const others = AI_PROVIDERS.filter((p) => p !== provider);

  return (
    <div class="ai-pick" ref={box} role="menu" aria-label="AI·모델 고르기" onKeyDown={onKey} style={pos ? { left: `${pos.left}px`, bottom: `${pos.bottom}px` } : { visibility: 'hidden' }}>
      <div role="group" aria-label={`${props.started ? '이 대화' : '새 대화'} · ${label}`}>
        <div class="ai-pick-h" aria-hidden="true">
          {props.started ? '이 대화' : '새 대화'} · {label}
        </div>
        {props.rows.map((r) => {
          const on = r.value === props.picked;
          const desc = [r.description, r.isDefault ? '기본' : ''].filter(Boolean).join(' · ');
          return (
            <button
              type="button"
              key={r.value || '__default__'}
              role="menuitemradio"
              aria-checked={on}
              class={`ai-pick-m${on ? ' on' : ''}`}
              disabled={props.blocked}
              title={r.value || undefined}
              onClick={() => {
                props.onClose();
                if (!on) props.onModel(r.value);
                props.anchor.current?.focus();
              }}
            >
              <span class="ck">{on && <Icon name="check" size={15} color="var(--acc)" sw={2.4} />}</span>
              <span class="t">
                <b>{r.name}</b>
                {desc && <span>{desc}</span>}
              </span>
            </button>
          );
        })}
        {props.loading && !props.rows.length && (
          <div class="ai-pick-note">
            <Spinner size={13} /> 모델 목록을 받는 중
          </div>
        )}
        {props.blocked && <div class="ai-pick-note">{label} 연동이 꺼져 있거나 설치되지 않아 모델을 바꿀 수 없습니다.</div>}
        {!props.blocked && props.error && <div class="ai-pick-note">{props.error}</div>}
      </div>
      <div class="ai-pick-sep" role="separator" />
      <div role="group" aria-label={props.started ? '다른 AI로 새 대화' : '다른 AI로 바꾸기'}>
        <div class="ai-pick-h" aria-hidden="true">
          {props.started ? '다른 AI로 새 대화' : '다른 AI로 바꾸기'}
        </div>
        {others.map((p) => {
          const on = providerEnabled(app, p);
          const st = shownState(app, p);
          const usable = on && st !== 'missing' && st !== 'off';
          const list = peekModels(p);
          const conn = connDefault(app, p);
          // 기본 모델 이름: 연결 설정에 고른 모델 → (받아 둔 목록이 있으면) 그 AI의 기본 모델. 모르면 AI 이름만
          const mname = !usable ? '' : conn ? modelName(list, conn) : p !== 'claude' && list ? pickedName(p, list, '', undefined) : '';
          const sub = !on ? '꺼짐' : st === 'missing' ? '설치 안 됨' : ['켜짐', p === def ? '기본 AI' : '', st && st !== 'on' ? STATE_LABEL[st] : ''].filter(Boolean).join(' · ');
          return (
            <button
              type="button"
              key={p}
              role="menuitem"
              class={`ai-pick-ai${usable ? '' : ' off'}`}
              onClick={() => {
                props.onClose();
                if (usable) props.onSwitch(p);
                else app.openSettings(p);
              }}
            >
              <AiBadge provider={p} size={20} />
              <span class="t">
                <b>
                  {AI_LABEL[p]}
                  {mname ? ` · ${mname}` : ''}
                </b>
                <span>{sub}</span>
              </span>
              <span class="go">{usable ? (props.started ? '새 대화 →' : '바꾸기 →') : '설정에서 켜기'}</span>
            </button>
          );
        })}
      </div>
      <div class="ai-pick-f">모델은 다음 응답부터 바뀌고 대화는 이어집니다. 다른 AI는 새 대화로 시작합니다.</div>
    </div>
  );
}

/** [다른 AI로 새 대화] 확인: 지금 대화를 맥락으로 붙일지 · 새 대화의 모델 */
export function SwitchDialog(props: { app: DeskApp; from: AiProvider; to: AiProvider; onClose(): void; onStart(o: { carry: boolean; model?: string }): void }) {
  const { app, to } = props;
  const models = useModels(app, to, true);
  const conn = connDefault(app, to);
  const [carry, setCarry] = useState(true);
  const [model, setModel] = useState('__conn__');
  const label = AI_LABEL[to];
  const fromLabel = AI_LABEL[props.from];
  const defName =
    to === 'claude' && !conn
      ? `Claude Code 기본값${models.list?.defaultName ? ` (${models.list.defaultName})` : ''}`
      : `${to === 'claude' ? modelName(models.list, conn) : pickedName(to, models.list, conn ?? '', conn)} (${label} 기본 모델)`;
  const rows = pickRows(to, models.list, conn, undefined).filter((r) => !r.isDefault);
  return (
    <Modal
      small
      title={
        <span class="ai-sw-t">
          <AiBadge provider={to} size={24} />
          {label}로 새 대화 시작
        </span>
      }
      onClose={props.onClose}
      foot={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            취소
          </button>
          <button type="button" class="btn primary" onClick={() => props.onStart({ carry, ...(model === '__conn__' ? {} : { model }) })}>
            새 대화로 시작
          </button>
        </>
      }
    >
      <div class="ai-sw">
      <p class="ai-sw-p">AI를 바꾸면 새 대화로 시작합니다. {fromLabel}와 나눈 대화는 대화 기록에 그대로 남습니다.</p>
      <label class="cp-check ai-sw-carry">
        <input type="checkbox" checked={carry} onChange={(e) => setCarry((e.target as HTMLInputElement).checked)} />
        <span>
          <span class="l">지금 대화를 맥락으로 붙이기</span>
          <span class="h">질문과 답변 글만 붙입니다. 작업 내역·조회 결과는 빼고, 새 대화 맥락에 「이전 대화 ({fromLabel})」 칩으로 보입니다</span>
        </span>
      </label>
      <div class="cp-field-row">
        <label for="ai-sw-model">모델</label>
        <select id="ai-sw-model" class="inp" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
          <option value="__conn__">{defName}</option>
          {rows.map((r) => (
            <option key={r.value || '__empty__'} value={r.value}>
              {r.name}
            </option>
          ))}
        </select>
        {models.loading && <Spinner size={13} />}
      </div>
      </div>
    </Modal>
  );
}
