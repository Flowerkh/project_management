// 왼쪽 카테고리 트리 (DB 테이블 / 메뉴 / 화면 / 배치). 펼친 노드만 행으로 만든다.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Crud } from '../../engine/types';
import { Icon, Spinner } from '../icons';
import type { Model, Target } from '../model';
import { crudList, menuScreens } from '../model';
import { CrudMini, Tag } from './common';

export interface Row {
  key: string;
  depth: number;
  label: string;
  sub?: string;
  subMono?: boolean;
  line2?: string;
  icon: string;
  iconColor?: string;
  cat?: boolean;
  count?: number | string;
  tags?: ComponentChildren;
  expandable: boolean;
  expanded: boolean;
  target?: Target;
  file?: { id: string; line?: number };
  parentKey?: string;
}

const MAX_CHILDREN = 200;

function highlight(text: string, q: string): ComponentChildren {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark class="hit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function targetKey(t: Target): string {
  switch (t.kind) {
    case 'table':
      return `t:${t.id}`;
    case 'screen':
      return `s:${t.id}`;
    case 'menu':
      return `m:${t.id}`;
    case 'batch':
      return `b:${t.id}`;
    default:
      return '';
  }
}

/** 대상 노드까지 펼쳐야 할 키들 */
export function ancestorsOf(model: Model, t: Target): string[] {
  switch (t.kind) {
    case 'table':
      return ['cat:table'];
    case 'screen': {
      const s = model.screenById.get(t.id);
      return s ? ['cat:screen', `sg:${s.group || '(기타)'}`] : ['cat:screen'];
    }
    case 'menu': {
      const out = ['cat:menu'];
      let m = model.menuById.get(t.id);
      const chain: string[] = [];
      let guard = 0;
      while (m?.parent && guard++ < 20) {
        chain.unshift(`m:${m.parent}`);
        m = model.menuById.get(m.parent);
      }
      return out.concat(chain);
    }
    case 'batch': {
      const b = model.batchById.get(t.id);
      return b ? ['cat:batch', `bg:${b.group || '배치'}`] : ['cat:batch'];
    }
    default:
      return [];
  }
}

function fileRows(model: Model, keyBase: string, fileIds: string[], depth: number, out: Row[], parentKey: string) {
  const seen = new Set<string>();
  for (const fid of fileIds) {
    if (seen.has(fid)) continue;
    seen.add(fid);
    const f = model.fileById.get(fid);
    if (!f) continue;
    out.push({ key: `${keyBase}:${fid}`, depth, label: f.name, icon: 'file', expandable: false, expanded: false, file: { id: fid }, parentKey });
    if (seen.size >= MAX_CHILDREN) break;
  }
}

function tableRows(model: Model, keyBase: string, tables: { table: string; crud: Crud[] }[], depth: number, out: Row[], parentKey: string) {
  for (const t of tables.slice(0, MAX_CHILDREN)) {
    const tr = model.tableByKey.get(t.table.toUpperCase());
    out.push({
      key: `${keyBase}:${t.table}`, depth, label: t.table, sub: tr?.comment, icon: 'table', expandable: false, expanded: false,
      tags: <CrudMini crud={t.crud} />, target: tr ? { kind: 'table', id: tr.id } : undefined, parentKey,
    });
  }
}

export function buildRows(model: Model, expanded: Set<string>, sel: Target): Row[] {
  const out: Row[] = [];
  const r = model.r;
  const isOpen = (k: string) => expanded.has(k);
  const selKey = targetKey(sel);

  // ---- DB 테이블
  const catT = 'cat:table';
  out.push({ key: catT, depth: 0, label: 'DB 테이블', icon: 'folder', cat: true, count: r.tables.length, expandable: true, expanded: isOpen(catT) });
  if (isOpen(catT)) {
    const tables = [...r.tables].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of tables) {
      const k = `t:${t.id}`;
      out.push({
        key: k, depth: 1, label: t.name, sub: t.comment, icon: 'folder', expandable: true, expanded: isOpen(k), target: { kind: 'table', id: t.id },
        line2: selKey === k && t.role ? `역할: ${t.role}` : undefined, parentKey: catT,
        tags: (
          <>
            {t.common && <Tag>공통</Tag>}
            {t.unlinked && !t.common && <Tag tone="err">미연결</Tag>}
          </>
        ),
      });
      if (isOpen(k)) {
        const fk = `${k}:files`;
        out.push({ key: fk, depth: 2, label: '관련 파일', icon: 'folder', count: t.files.length, expandable: t.files.length > 0, expanded: isOpen(fk), parentKey: k });
        if (isOpen(fk)) fileRows(model, `${k}:f`, t.files, 3, out, fk);
        const uk = `${k}:used`;
        out.push({ key: uk, depth: 2, label: '사용 화면·배치', icon: 'folder', count: t.usedBy.length, expandable: t.usedBy.length > 0, expanded: isOpen(uk), parentKey: k });
        if (isOpen(uk)) {
          for (const u of t.usedBy.slice(0, MAX_CHILDREN)) {
            if (u.kind === 'screen') {
              const s = model.screenById.get(u.id);
              if (s) out.push({ key: `${uk}:${u.id}`, depth: 3, label: s.name, icon: 'screen', expandable: false, expanded: false, tags: <CrudMini crud={u.crud} />, target: { kind: 'screen', id: s.id }, parentKey: uk });
            } else {
              const b = model.batchById.get(u.id);
              if (b) out.push({ key: `${uk}:${u.id}`, depth: 3, label: b.name, icon: 'clock', expandable: false, expanded: false, tags: <><Tag>배치</Tag><CrudMini crud={u.crud} /></>, target: { kind: 'batch', id: b.id }, parentKey: uk });
            }
          }
        }
      }
    }
  }

  // ---- 메뉴
  const catM = 'cat:menu';
  out.push({ key: catM, depth: 0, label: '메뉴', icon: 'folder', cat: true, count: r.menus.length, expandable: true, expanded: isOpen(catM) });
  if (isOpen(catM)) {
    const walk = (ms: typeof model.rootMenus, depth: number, parentKey: string) => {
      for (const m of ms) {
        const k = `m:${m.id}`;
        const kids = model.menuChildren.get(m.id) ?? [];
        const screens = menuScreens(model, m.id);
        const leaf = kids.length === 0;
        const one = leaf && screens.length === 1 ? screens[0] : undefined;
        const expandable = !leaf || screens.length > 0;
        out.push({
          key: k, depth, label: m.name, sub: leaf ? m.url : undefined, subMono: true, icon: 'folder', count: leaf ? undefined : kids.length,
          expandable, expanded: isOpen(k), target: { kind: 'menu', id: m.id }, parentKey,
          line2: selKey === k ? `${m.estimated ? '추정 메뉴 · ' : ''}화면 ${screens.length}개` : undefined,
          tags: m.estimated ? <Tag tone="warn">추정</Tag> : undefined,
        });
        if (!isOpen(k)) continue;
        if (!leaf) walk(kids, depth + 1, k);
        else if (one) {
          const fk = `${k}:files`;
          out.push({ key: fk, depth: depth + 1, label: '관련 파일', icon: 'folder', count: one.files.length, expandable: one.files.length > 0, expanded: isOpen(fk), parentKey: k });
          if (isOpen(fk)) fileRows(model, `${k}:f`, one.files.map((f) => f.file), depth + 2, out, fk);
          const tk = `${k}:tables`;
          out.push({ key: tk, depth: depth + 1, label: '사용 테이블', icon: 'folder', count: one.tables.length, expandable: one.tables.length > 0, expanded: isOpen(tk), parentKey: k });
          if (isOpen(tk)) tableRows(model, `${k}:t`, one.tables, depth + 2, out, tk);
        } else {
          for (const s of screens.slice(0, MAX_CHILDREN)) out.push({ key: `${k}:s:${s.id}`, depth: depth + 1, label: s.name, sub: s.url, subMono: true, icon: 'screen', expandable: false, expanded: false, target: { kind: 'screen', id: s.id }, parentKey: k });
        }
      }
    };
    walk(model.rootMenus, 1, catM);
  }

  // ---- 화면
  const catS = 'cat:screen';
  out.push({ key: catS, depth: 0, label: '화면', icon: 'folder', cat: true, count: r.screens.length, expandable: true, expanded: isOpen(catS) });
  if (isOpen(catS)) {
    for (const g of model.screenGroups) {
      const gk = `sg:${g.group}`;
      out.push({ key: gk, depth: 1, label: g.label || g.group, sub: g.label ? g.group : undefined, subMono: true, icon: 'folder', count: g.screens.length, expandable: true, expanded: isOpen(gk), parentKey: catS });
      if (!isOpen(gk)) continue;
      for (const s of g.screens) {
        const k = `s:${s.id}`;
        out.push({
          key: k, depth: 2, label: s.name, sub: s.url, subMono: true, icon: 'folder', expandable: true, expanded: isOpen(k), target: { kind: 'screen', id: s.id },
          line2: selKey === k && s.role ? `역할: ${s.role}` : undefined, parentKey: gk,
          tags: s.kind === 'popup' ? <Tag>팝업</Tag> : s.kind === 'api' ? <Tag>API</Tag> : undefined,
        });
        if (!isOpen(k)) continue;
        const fk = `${k}:files`;
        out.push({ key: fk, depth: 3, label: '관련 파일', icon: 'folder', count: s.files.length, expandable: s.files.length > 0, expanded: isOpen(fk), parentKey: k });
        if (isOpen(fk)) fileRows(model, `${k}:f`, s.files.map((f) => f.file), 4, out, fk);
        const tk = `${k}:tables`;
        out.push({ key: tk, depth: 3, label: '사용 테이블', icon: 'folder', count: s.tables.length, expandable: s.tables.length > 0, expanded: isOpen(tk), parentKey: k });
        if (isOpen(tk)) tableRows(model, `${k}:t`, s.tables, 4, out, tk);
      }
    }
  }

  // ---- 배치
  const catB = 'cat:batch';
  out.push({ key: catB, depth: 0, label: '배치', icon: 'folder', cat: true, count: r.batches.length, expandable: true, expanded: isOpen(catB) });
  if (isOpen(catB)) {
    for (const g of model.batchGroups) {
      const gk = `bg:${g.group}`;
      out.push({ key: gk, depth: 1, label: g.group, icon: 'folder', count: g.screens.length, expandable: true, expanded: isOpen(gk), parentKey: catB });
      if (!isOpen(gk)) continue;
      for (const b of g.screens) {
        const k = `b:${b.id}`;
        out.push({
          key: k, depth: 2, label: b.name, sub: b.schedule?.text, icon: 'folder', expandable: true, expanded: isOpen(k), target: { kind: 'batch', id: b.id },
          line2: selKey === k && b.role ? `역할: ${b.role}` : undefined, parentKey: gk,
          tags: !b.schedule ? <Tag tone="err">주기 없음</Tag> : undefined,
        });
        if (!isOpen(k)) continue;
        const fk = `${k}:files`;
        out.push({ key: fk, depth: 3, label: '관련 파일', icon: 'folder', count: b.files.length, expandable: b.files.length > 0, expanded: isOpen(fk), parentKey: k });
        if (isOpen(fk)) fileRows(model, `${k}:f`, b.files, 4, out, fk);
        const tk = `${k}:tables`;
        out.push({ key: tk, depth: 3, label: '사용 테이블', icon: 'folder', count: b.tables.length, expandable: b.tables.length > 0, expanded: isOpen(tk), parentKey: k });
        if (isOpen(tk)) tableRows(model, `${k}:t`, b.tables, 4, out, tk);
      }
    }
  }
  return out;
}

/** 검색: 이름·경로가 맞는 항목만 (카테고리별 최대 100개) */
export function searchRows(model: Model, q: string): Row[] {
  const out: Row[] = [];
  const ql = q.toLowerCase();
  const hit = (...xs: (string | undefined)[]) => xs.some((x) => x && x.toLowerCase().includes(ql));
  const LIMIT = 100;

  const tables = model.r.tables.filter((t) => hit(t.name, t.comment));
  out.push({ key: 'q:table', depth: 0, label: 'DB 테이블', icon: 'folder', cat: true, count: tables.length, expandable: false, expanded: true });
  for (const t of tables.slice(0, LIMIT)) out.push({ key: `t:${t.id}`, depth: 1, label: t.name, sub: t.comment, icon: 'table', expandable: false, expanded: false, target: { kind: 'table', id: t.id } });

  const menus = model.r.menus.filter((m) => hit(m.name, m.url));
  out.push({ key: 'q:menu', depth: 0, label: '메뉴', icon: 'folder', cat: true, count: menus.length, expandable: false, expanded: true });
  for (const m of menus.slice(0, LIMIT)) out.push({ key: `m:${m.id}`, depth: 1, label: m.name, sub: m.url, subMono: true, icon: 'menu', expandable: false, expanded: false, target: { kind: 'menu', id: m.id } });

  const screens = model.r.screens.filter((s) => hit(s.name, s.url, ...s.urls, s.view ? model.fileById.get(s.view)?.path : undefined));
  out.push({ key: 'q:screen', depth: 0, label: '화면', icon: 'folder', cat: true, count: screens.length, expandable: false, expanded: true });
  for (const s of screens.slice(0, LIMIT)) out.push({ key: `s:${s.id}`, depth: 1, label: s.name, sub: s.url, subMono: true, icon: 'screen', expandable: false, expanded: false, target: { kind: 'screen', id: s.id } });

  const batches = model.r.batches.filter((b) => hit(b.name, model.fileById.get(b.entry)?.path, b.schedule?.text));
  out.push({ key: 'q:batch', depth: 0, label: '배치', icon: 'folder', cat: true, count: batches.length, expandable: false, expanded: true });
  for (const b of batches.slice(0, LIMIT)) out.push({ key: `b:${b.id}`, depth: 1, label: b.name, sub: b.schedule?.text, icon: 'clock', expandable: false, expanded: false, target: { kind: 'batch', id: b.id } });

  const files = model.r.files.filter((f) => !f.excluded && hit(f.path));
  out.push({ key: 'q:file', depth: 0, label: '파일', icon: 'folder', cat: true, count: files.length, expandable: false, expanded: true });
  for (const f of files.slice(0, LIMIT)) out.push({ key: `f:${f.id}`, depth: 1, label: f.name, sub: f.path.slice(0, Math.max(0, f.path.length - f.name.length - 1)), subMono: true, icon: 'file', expandable: false, expanded: false, file: { id: f.id } });
  return out;
}

export function Sidebar(props: {
  model: Model | null;
  running?: { counts?: Partial<Record<'table' | 'menu' | 'screen' | 'batch', number>>; active?: boolean };
  sel: Target;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onNav: (t: Target) => void;
  onFile: (id: string, line?: number) => void;
  searchRef: { current: HTMLInputElement | null };
  emptyText?: string;
}) {
  const { model, sel, expanded } = props;
  const [q, setQ] = useState('');
  const [focusKey, setFocusKey] = useState<string>('');
  const treeRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    if (!model) return [] as Row[];
    return q.trim() ? searchRows(model, q.trim()) : buildRows(model, expanded, sel);
  }, [model, expanded, sel, q]);

  const selKey = targetKey(sel);
  useEffect(() => {
    if (!selKey || !treeRef.current) return;
    const el = treeRef.current.querySelector(`[data-key="${CSS.escape(selKey)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selKey, rows.length]);

  const toggle = (k: string) => {
    const n = new Set(expanded);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    props.setExpanded(n);
  };

  const activate = (row: Row, fromKey = false) => {
    if (row.target) props.onNav(row.target);
    if (row.file) props.onFile(row.file.id, row.file.line);
    if (row.expandable && (!fromKey || !row.target)) {
      // 대상 항목은 처음 누르면 펼치고, 이미 선택된 항목을 다시 누르면 접는다
      if (!row.expanded || !row.target || targetKey(row.target) === selKey) toggle(row.key);
    }
    setFocusKey(row.key);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.key === focusKey);
    if (i < 0) i = Math.max(0, rows.findIndex((r) => r.key === selKey));
    const row = rows[i];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusKey(rows[Math.min(rows.length - 1, i + 1)].key);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusKey(rows[Math.max(0, i - 1)].key);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (row?.expandable && !row.expanded) toggle(row.key);
      else if (row?.expanded && rows[i + 1]) setFocusKey(rows[i + 1].key);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row?.expandable && row.expanded) toggle(row.key);
      else if (row?.parentKey) setFocusKey(row.parentKey);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (row) activate(row, true);
    }
  };

  useEffect(() => {
    if (!focusKey || !treeRef.current) return;
    const el = treeRef.current.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusKey]);

  const running = props.running;
  return (
    <aside class="side" aria-label="분석 결과 트리">
      <div class="side-search">
        <label class="search">
          <Icon name="search" size={16} color="var(--icon)" />
          <input
            ref={(el) => { props.searchRef.current = el; }}
            value={q}
            disabled={!model}
            placeholder="테이블·메뉴·화면·배치 검색"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('');
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                treeRef.current?.focus();
                if (rows[0]) setFocusKey(rows[1]?.key ?? rows[0].key);
              }
            }}
            aria-label="트리 검색"
          />
          {q ? (
            <button type="button" class="icon-btn" style={{ width: '22px', height: '22px' }} onClick={() => setQ('')} aria-label="검색어 지우기">
              <Icon name="close" size={12} />
            </button>
          ) : (
            <span class="kbd">Ctrl K</span>
          )}
        </label>
      </div>
      <div class="side-head">
        <span>{q ? `검색 결과` : '분석 결과'}</span>
        {model && !q && (
          <button type="button" class="icon-btn" style={{ width: '22px', height: '22px' }} title="모두 접기" onClick={() => props.setExpanded(new Set())}>
            <Icon name="chev_up_down" size={14} />
          </button>
        )}
      </div>
      {!model && !running && <div class="tree-empty">{props.emptyText ?? '[Run]을 누르면 분석 결과가 여기에 폴더 형태로 표시됩니다.'}</div>}
      {!model && running && (
        <div class="tree" style={{ paddingTop: '2px' }}>
          {(['table', 'menu', 'screen', 'batch'] as const).map((k) => (
            <div class="trow cat" key={k}>
              <span class="tw"><Icon name="chev_right" size={14} /></span>
              <span class="ti"><Icon name="folder" size={16} color="var(--acc)" /></span>
              <span class="tl"><span class="t1"><span class="nm">{{ table: 'DB 테이블', menu: '메뉴', screen: '화면', batch: '배치' }[k]}</span></span></span>
              <span class="tr">
                {running.counts?.[k] !== undefined ? <span class="count">{running.counts[k]}</span> : running.active ? <Spinner size={13} /> : null}
              </span>
            </div>
          ))}
          {running.active && [0, 1, 2, 3, 4].map((i) => <div class="skel" key={i} style={{ width: `${70 - i * 8}%` }} />)}
        </div>
      )}
      {model && (
        <div class="tree" ref={treeRef} tabIndex={0} role="tree" onKeyDown={onKey}>
          {rows.map((r) => {
            const isSel = !!selKey && r.key === selKey;
            return (
              <div
                key={r.key}
                data-key={r.key}
                class={`trow${r.cat ? ' cat' : ''}${isSel ? ' sel' : ''}${focusKey === r.key ? ' focus' : ''}`}
                style={{ paddingLeft: `${r.depth * 16}px` }}
                role="treeitem"
                aria-expanded={r.expandable ? r.expanded : undefined}
                aria-selected={isSel}
                onClick={() => activate(r)}
                title={r.sub ? `${r.label} ${r.sub}` : r.label}
              >
                <span
                  class="tw"
                  onClick={(e) => {
                    if (r.expandable) {
                      e.stopPropagation();
                      toggle(r.key);
                      setFocusKey(r.key);
                    }
                  }}
                >
                  {r.expandable && <Icon name={r.expanded ? 'chev_down' : 'chev_right'} size={14} />}
                </span>
                <span class="ti" style={r.iconColor ? { color: r.iconColor } : undefined}>
                  <Icon name={r.icon} size={r.cat ? 16 : 15} color={r.cat ? 'var(--acc)' : 'var(--icon)'} />
                </span>
                <span class="tl">
                  <span class="t1">
                    <span class="nm">{highlight(r.label, q.trim())}</span>
                    {r.sub && <span class={`sub${r.subMono ? ' mono' : ''}`}>{highlight(r.sub, q.trim())}</span>}
                  </span>
                  {r.line2 && <span class="t2">{r.line2}</span>}
                </span>
                <span class="tr">
                  {r.tags}
                  {r.count !== undefined && <span class="count">{r.count}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

export function crudOf(list: Crud[]): Crud[] {
  return crudList(list);
}
