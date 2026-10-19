import type { ComponentChildren } from 'preact';
import type { Confidence, Crud, Evidence, FileInfo } from '../../engine/types';
import { useNav } from '../ctx';
import { CONF_TONE, CRUD_ORDER } from '../format';
import { Icon } from '../icons';
import { tableOf } from '../model';

export function Tag(props: { tone?: string; children: ComponentChildren; mono?: boolean; lg?: boolean; title?: string }) {
  return (
    <span class={`tag ${props.tone ?? 'neutral'}${props.mono ? ' mono' : ''}${props.lg ? ' lg' : ''}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function ConfTag(props: { c: Confidence; prefix?: string }) {
  return <Tag tone={CONF_TONE[props.c]}>{`${props.prefix ?? '신뢰도'} ${props.c}`}</Tag>;
}

/** C R U D 네 칸 (표) */
export function CrudCells(props: { crud: Crud[] }) {
  return (
    <>
      {CRUD_ORDER.map((c) => (
        <td class="c" key={c}>
          {props.crud.includes(c) ? <span class={`crud ${c}`}>{c}</span> : <span class="crud off">–</span>}
        </td>
      ))}
    </>
  );
}

/** 작은 CRUD 배지 (트리·칩) */
export function CrudMini(props: { crud: Crud[] }) {
  return (
    <span class="crud-mini">
      {props.crud.map((c) => (
        <span key={c} class={`crud ${c}`}>
          {c}
        </span>
      ))}
    </span>
  );
}

export function Card(props: { title?: ComponentChildren; count?: number | string; sub?: ComponentChildren; right?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`card ${props.class ?? ''}`}>
      {(props.title || props.right) && (
        <div class="card-title">
          {props.title && <h3>{props.title}</h3>}
          {props.count !== undefined && <span class="cnt">{props.count}</span>}
          {props.sub && <span class="sub">{props.sub}</span>}
          {props.right && <div class="right">{props.right}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function TableLink(props: { name: string; mono?: boolean }) {
  const { model, nav } = useNav();
  const t = tableOf(model, props.name);
  if (!t) return <span class="mono" style={{ fontSize: '12.5px' }}>{props.name}</span>;
  return (
    <button type="button" class="lnk mono" onClick={() => nav({ kind: 'table', id: t.id })} title={t.comment ?? t.name}>
      {t.name}
    </button>
  );
}

export function ScreenLink(props: { id: string }) {
  const { model, nav } = useNav();
  const s = model.screenById.get(props.id);
  if (!s) return <span>{props.id}</span>;
  return (
    <button type="button" class="lnk" onClick={() => nav({ kind: 'screen', id: s.id })}>
      {s.name}
    </button>
  );
}

export function BatchLink(props: { id: string }) {
  const { model, nav } = useNav();
  const b = model.batchById.get(props.id);
  if (!b) return <span>{props.id}</span>;
  return (
    <button type="button" class="lnk" onClick={() => nav({ kind: 'batch', id: b.id })}>
      {b.name}
    </button>
  );
}

export function MenuLink(props: { id: string; label?: string }) {
  const { model, nav } = useNav();
  const m = model.menuById.get(props.id);
  if (!m) return <span>{props.label ?? props.id}</span>;
  return (
    <button type="button" class="lnk" onClick={() => nav({ kind: 'menu', id: m.id })}>
      {props.label ?? m.name}
    </button>
  );
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

/** 파일 이름 + 폴더 (두 줄) */
export function FileCell(props: { file?: FileInfo; line?: number }) {
  const { openFile } = useNav();
  const f = props.file;
  if (!f) return <span class="faint">—</span>;
  return (
    <button type="button" class="two" style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', width: '100%' }} onClick={() => openFile(f.id, props.line)} title={f.path}>
      <span class="a" style={{ color: 'var(--ink)' }}>{f.name}</span>
      <span class="b">{shortDir(dirOf(f.path))}</span>
    </button>
  );
}

/** 긴 폴더 경로는 뒤쪽만 */
export function shortDir(d: string): string {
  const parts = d.split('/');
  if (parts.length <= 4) return d;
  return parts.slice(-4).join('/');
}

export function FileChip(props: { fileId: string; line?: number; note?: ComponentChildren }) {
  const { model, openFile } = useNav();
  const f = model.fileById.get(props.fileId);
  if (!f) return null;
  return (
    <button type="button" class="chip click" onClick={() => openFile(f.id, props.line)} title={f.path}>
      <Icon name="file" size={14} color="var(--icon)" />
      <span class="mono">{f.name}</span>
      {props.note && <span class="muted" style={{ fontSize: '11.5px' }}>{props.note}</span>}
    </button>
  );
}

/** 근거 목록 → "파일:줄" 링크 */
export function EvidenceLine(props: { items: Evidence[]; prefix?: string; max?: number }) {
  const { model, openFile } = useNav();
  const items = props.items.slice(0, props.max ?? 4);
  if (!items.length) return null;
  return (
    <div class="evi">
      {props.prefix ?? '근거: '}
      {items.map((e, i) => {
        const f = model.fileById.get(e.file);
        return (
          <span key={i}>
            {i > 0 && ' · '}
            {e.text ? e.text.length > 48 ? <span title={e.text}>{`${e.text.slice(0, 48)}… `}</span> : `${e.text} ` : ''}
            <a href="#" onClick={(ev) => { ev.preventDefault(); openFile(e.file, e.line); }}>
              ({f?.name ?? e.file}:{e.line})
            </a>
          </span>
        );
      })}
      {props.items.length > items.length && ` 외 ${props.items.length - items.length}건`}
    </div>
  );
}

export function Empty(props: { children: ComponentChildren }) {
  return <div class="empty-note">{props.children}</div>;
}

export function Crumb(props: { items: { label: ComponentChildren; onClick?: () => void }[] }) {
  return (
    <nav class="crumb" aria-label="경로">
      {props.items.map((it, i) => (
        <span key={i} class="row" style={{ gap: '6px' }}>
          {i > 0 && <Icon name="chev_right" size={12} color="var(--faint)" />}
          {it.onClick ? (
            <a href="#" onClick={(e) => { e.preventDefault(); it.onClick!(); }}>{it.label}</a>
          ) : (
            <span class={i === props.items.length - 1 ? 'cur' : ''}>{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
