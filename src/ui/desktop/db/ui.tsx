// DB 화면 공통: 환경 태그, 켜기/끄기, 위에 겹쳐 뜨는 창(Esc는 맨 위 창만 닫음), 표시 문구
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { ENV_LABEL, type DbKind, type Env, type QueryCard } from '../../../shared/desktop-api';
import { ModalSizer } from '../../components/ModalSizer';
import { Icon } from '../../icons';
import './db.css';

export const DB_KIND_LABEL: Record<DbKind, string> = { oracle: 'Oracle', mysql: 'MySQL', mariadb: 'MariaDB' };

export const QUERY_KIND_LABEL: Record<QueryCard['kind'], string> = {
  insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', merge: 'MERGE', ddl: 'DDL', call: '프로시저 호출', other: 'SELECT 외',
};

export function EnvTag(props: { env: Env }) {
  return <span class={`db-envtag ${props.env}`}>{ENV_LABEL[props.env]}</span>;
}

export function Toggle(props: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      title={props.label}
      class={`db-toggle${props.on ? ' on' : ''}`}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

export function fmtN(n: number): string {
  return n.toLocaleString('ko-KR');
}

export function fmtSec(ms: number): string {
  if (ms < 10_000) return `${(Math.max(ms, 100) / 1000).toFixed(1)}초`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  return `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초`;
}

// ------------------------------------------------------------------ 겹친 창의 Esc
// POP-04·Claude 패널 위에 띄운 창에서 Esc를 누르면 맨 위 창만 닫고, 아래 창(POP-04 등)의 Esc 처리로 넘기지 않는다.

const escStack: { fn: () => void }[] = [];
let escInstalled = false;

function onEscKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !escStack.length) return;
  e.stopPropagation();
  e.preventDefault();
  escStack[escStack.length - 1].fn();
}

export function useEscLayer(fn: () => void, active = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const layer = { fn: () => ref.current() };
    escStack.push(layer);
    if (!escInstalled && typeof window !== 'undefined') {
      window.addEventListener('keydown', onEscKey, true);
      escInstalled = true;
    }
    return () => {
      const i = escStack.lastIndexOf(layer);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [active]);
}

/** 화면 맨 위(body)에 띄우는 창. 본문 칸·패널 안에서 열어도 화면 전체를 덮는다 */
export function DbModal(props: {
  title: ComponentChildren;
  icon?: string;
  iconColor?: string;
  onClose: () => void;
  children: ComponentChildren;
  foot?: ComponentChildren;
  cls?: string;
  label?: string;
}) {
  useEscLayer(props.onClose);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 첫 입력칸(없으면 첫 단추)에 포커스
    const el = box.current?.querySelector<HTMLElement>('[data-autofocus], input:not([disabled]):not([type=checkbox]):not([type=radio]), .modal-foot button:not([disabled])');
    el?.focus();
  }, []);
  const node = (
    <div class="scrim db-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={box} class={`modal ${props.cls ?? ''}`} role="dialog" aria-modal="true" aria-label={props.label ?? (typeof props.title === 'string' ? props.title : undefined)}>
        <div class="modal-head">
          {props.icon && (
            <span class="pc-ic">
              <Icon name={props.icon} size={17} color={props.iconColor ?? 'var(--acc)'} />
            </span>
          )}
          <h2 class="grow" style={{ minWidth: 0 }}>{props.title}</h2>
          <button type="button" class="icon-btn" onClick={props.onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
        {props.foot && <div class="modal-foot">{props.foot}</div>}
        {props.cls && props.cls !== 'sm' && <ModalSizer id={`db:${props.cls}`} />}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
