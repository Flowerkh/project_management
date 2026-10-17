// 소스 뷰어(SCR-08): 줄 번호, 근거 줄 강조, 테이블 이름 강조, 파일 안 검색.
// 큰 파일도 보이는 줄만 그린다(가상 스크롤).
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FileInfo } from '../../engine/types';
import { copyText, LAYER_LABEL } from '../format';
import { Icon, Spinner } from '../icons';
import type { Model } from '../model';
import { crudList } from '../model';
import { CrudMini, Tag } from './common';

const LH = 20;
const BIG_BYTES = 1024 * 1024;
const BIG_LINES = 2000;

export interface ViewerReq {
  fileId: string;
  line?: number;
  query?: string;
}

const SQL_KW = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'UNION', 'ALL', 'AS', 'IN', 'NOT', 'NULL', 'IS', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'PRIMARY', 'KEY', 'CONSTRAINT', 'COMMENT', 'WITH', 'LIMIT', 'COMMIT']);
const JAVA_KW = new Set(['package', 'import', 'public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'return', 'new', 'if', 'else', 'for', 'while', 'try', 'catch', 'throws', 'throw', 'static', 'final', 'void', 'this', 'null', 'true', 'false', 'function', 'var', 'let', 'const', 'func', 'type', 'struct', 'go', 'defer', 'namespace', 'use', 'echo', 'foreach']);

type Seg = { t: string; c?: string };

function syntaxSegments(line: string, lang: FileInfo['lang'], inBlock: boolean): { segs: Seg[]; endsInBlock: boolean } {
  const segs: Seg[] = [];
  let i = 0;
  let block = inBlock;
  const n = line.length;
  const isMarkup = lang === 'XML' || lang === 'JSP' || lang === 'HTML' || lang === 'Template' || lang === 'Vue';
  const blockEnd = isMarkup ? '-->' : '*/';
  let buf = '';
  const flush = (c?: string) => {
    if (buf) segs.push({ t: buf, c });
    buf = '';
  };
  while (i < n) {
    if (block) {
      const e = line.indexOf(blockEnd, i);
      const end = e < 0 ? n : e + blockEnd.length;
      segs.push({ t: line.slice(i, end), c: 'cm' });
      i = end;
      if (e >= 0) block = false;
      continue;
    }
    const ch = line[i];
    const rest = line.slice(i);
    if (isMarkup && rest.startsWith('<!--')) {
      flush();
      block = true;
      continue;
    }
    if (!isMarkup || lang === 'JSP') {
      if (rest.startsWith('/*')) {
        flush();
        const e = line.indexOf('*/', i + 2);
        if (e < 0) {
          segs.push({ t: rest, c: 'cm' });
          block = !isMarkup;
          break;
        }
        segs.push({ t: line.slice(i, e + 2), c: 'cm' });
        i = e + 2;
        continue;
      }
      if (rest.startsWith('//') && lang !== 'SQL' && !/:\/\/$/.test(line.slice(Math.max(0, i - 6), i + 2))) {
        flush();
        segs.push({ t: rest, c: 'cm' });
        break;
      }
      if (rest.startsWith('--') && lang === 'SQL') {
        flush();
        segs.push({ t: rest, c: 'cm' });
        break;
      }
      if ((ch === '#' && (lang === 'Shell' || lang === 'Properties' || lang === 'YAML' || lang === 'Python')) || (lang === 'Batch' && /^\s*rem\b/i.test(rest) && !buf.trim())) {
        flush();
        segs.push({ t: rest, c: 'cm' });
        break;
      }
    }
    if (ch === '"' || ch === "'" || (ch === '`' && lang !== 'SQL')) {
      flush();
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      segs.push({ t: line.slice(i, Math.min(n, j + 1)), c: 'st' });
      i = j + 1;
      continue;
    }
    if (isMarkup && ch === '<' && /^<\/?[A-Za-z][\w:.-]*/.test(rest)) {
      flush();
      const m = /^<\/?[A-Za-z][\w:.-]*/.exec(rest)!;
      segs.push({ t: m[0], c: 'tg' });
      i += m[0].length;
      continue;
    }
    const wm = /[A-Za-z_@]/.test(ch) ? /^@?[A-Za-z_][\w]*/.exec(rest) : null;
    if (wm) {
      const w = wm[0];
      const isKw = SQL_KW.has(w) || (lang !== 'SQL' && lang !== 'XML' && JAVA_KW.has(w)) || (w.startsWith('@') && (lang === 'Java' || lang === 'Kotlin'));
      if (isKw) {
        flush();
        segs.push({ t: w, c: 'kw' });
      } else buf += w;
      i += w.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return { segs, endsInBlock: block };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 근거 줄부터 강조할 끝 줄 (매퍼 statement는 닫는 태그까지) */
function rangeEnd(lines: string[], start: number): number {
  const l = lines[start - 1] ?? '';
  const m = /<(select|insert|update|delete|sql|statement|procedure)\b/i.exec(l);
  if (m) {
    const close = new RegExp(`</${m[1]}\\s*>`, 'i');
    for (let k = start; k < Math.min(lines.length, start + 120); k++) if (close.test(lines[k - 1])) return k;
  }
  return start;
}

export function SourceViewer(props: {
  model: Model;
  req: ViewerReq;
  loadText: (fileId: string) => Promise<string | null>;
  onClose: () => void;
  onTable: (id: string) => void;
  onScreen: (id: string) => void;
  onBatch: (id: string) => void;
  onConnectFolder?: () => void;
}) {
  const { model, req } = props;
  const f = model.fileById.get(req.fileId);
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState(req.query ?? '');
  const [mi, setMi] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setText(undefined);
    setShowAll(false);
    props.loadText(req.fileId).then(
      (t) => alive && setText(t),
      () => alive && setText(null),
    );
    return () => {
      alive = false;
    };
  }, [req.fileId]);

  useEffect(() => setQ(req.query ?? ''), [req.fileId, req.query]);

  const allLines = useMemo(() => (text ? text.split(/\r?\n/) : []), [text]);
  const big = !!f && f.size > BIG_BYTES && allLines.length > BIG_LINES && !showAll;
  const lines = big ? allLines.slice(0, BIG_LINES) : allLines;

  // 줄별 블록 주석 상태
  const blockState = useMemo(() => {
    const out: boolean[] = new Array(lines.length);
    let b = false;
    for (let i = 0; i < lines.length; i++) {
      out[i] = b;
      if (lines[i].length > 4000) continue;
      b = syntaxSegments(lines[i], f?.lang ?? 'Other', b).endsInBlock;
    }
    return out;
  }, [lines, f?.lang]);

  const tableRe = useMemo(() => {
    const names = model.tableNames.slice(0, 600);
    if (!names.length) return null;
    return new RegExp(`(?<![A-Za-z0-9_$#])(${names.map(escapeRe).join('|')})(?![A-Za-z0-9_$#])`, 'gi');
  }, [model]);

  const matches = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return [] as number[];
    const out: number[] = [];
    lines.forEach((l, i) => {
      if (l.toLowerCase().includes(ql)) out.push(i + 1);
    });
    return out;
  }, [lines, q]);

  const hlStart = req.line ?? 0;
  const hlEnd = useMemo(() => (hlStart ? rangeEnd(lines, hlStart) : 0), [lines, hlStart]);

  const scrollToLine = (ln: number, smooth = false) => {
    const el = box.current;
    if (!el) return;
    const top = Math.max(0, (ln - 1) * LH - el.clientHeight / 3);
    el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    if (text && hlStart) requestAnimationFrame(() => scrollToLine(hlStart));
    else if (box.current) box.current.scrollTop = 0;
  }, [text, req.fileId, hlStart]);

  useEffect(() => {
    setMi(0);
    if (matches.length && !hlStart) scrollToLine(matches[0]);
  }, [matches]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [text]);

  const go = (d: number) => {
    if (!matches.length) return;
    const n = (mi + d + matches.length) % matches.length;
    setMi(n);
    scrollToLine(matches[n], true);
  };

  const usage = model.fileUsage.get(req.fileId);
  const ql = q.trim().toLowerCase();
  const curMatch = matches[mi];
  const sqlHere = model.r.sql.find((s) => s.file === req.fileId && s.line === hlStart);

  const renderText = (line: string, idx: number): ComponentChildren => {
    if (line.length > 4000) return line.slice(0, 4000) + ' …';
    const { segs } = syntaxSegments(line, f?.lang ?? 'Other', blockState[idx] ?? false);
    const out: ComponentChildren[] = [];
    let key = 0;
    for (const s of segs) {
      // 검색어·테이블 이름으로 더 쪼갬
      const parts: { t: string; c?: string; table?: string }[] = [];
      if (tableRe && s.c !== 'cm') {
        let last = 0;
        tableRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = tableRe.exec(s.t))) {
          if (m.index > last) parts.push({ t: s.t.slice(last, m.index), c: s.c });
          parts.push({ t: m[0], c: 'tb', table: m[0] });
          last = m.index + m[0].length;
        }
        if (last < s.t.length) parts.push({ t: s.t.slice(last), c: s.c });
      } else parts.push({ t: s.t, c: s.c });
      for (const p of parts) {
        if (ql && p.t.toLowerCase().includes(ql)) {
          const low = p.t.toLowerCase();
          let pos = 0;
          let k: number;
          while ((k = low.indexOf(ql, pos)) >= 0) {
            if (k > pos) out.push(<span key={key++} class={p.c}>{p.t.slice(pos, k)}</span>);
            out.push(<span key={key++} class={`q ${p.c ?? ''}`}>{p.t.slice(k, k + ql.length)}</span>);
            pos = k + ql.length;
          }
          if (pos < p.t.length) out.push(<span key={key++} class={p.c}>{p.t.slice(pos)}</span>);
        } else if (p.table) {
          const t = model.tableByKey.get(p.table.toUpperCase());
          out.push(
            <span key={key++} class="tb" title={t?.comment ? `${t.name} ${t.comment}` : p.table} onClick={() => t && props.onTable(t.id)}>
              {p.t}
            </span>,
          );
        } else out.push(p.c ? <span key={key++} class={p.c}>{p.t}</span> : p.t);
      }
    }
    return out;
  };

  const first = Math.max(0, Math.floor(scrollTop / LH) - 20);
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / LH) + 20);

  return (
    <>
      <div class="viewer-scrim" onClick={props.onClose} />
      <section class="viewer" role="dialog" aria-label="소스 뷰어">
        <div class="viewer-head">
          <div class="t">
            <Icon name="code" size={18} color="var(--icon)" />
            <span class="fn">{f?.name ?? req.fileId}</span>
            {f && <Tag mono>{f.lang}</Tag>}
            {f && f.encoding !== 'binary' && <Tag tone={f.encoding === 'euc-kr' ? 'warn' : 'neutral'}>{f.encoding.toUpperCase()}</Tag>}
            {text && <Tag>{allLines.length.toLocaleString('ko-KR')}줄</Tag>}
            {f && <Tag tone="acc">{LAYER_LABEL[f.layer]}</Tag>}
            <span style={{ marginLeft: 'auto' }} class="row">
              <button type="button" class="btn sm" onClick={() => f && copyText(f.path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                {copied ? '복사됨' : '경로 복사'}
              </button>
              <button type="button" class="icon-btn" onClick={props.onClose} aria-label="닫기" title="닫기 (Esc)">
                <Icon name="close" size={16} />
              </button>
            </span>
          </div>
          <div class="path ellipsis" title={f?.path}>{f?.path}</div>
        </div>
        {text !== null && (
          <div class="viewer-tools">
            <label class="search" style={{ flex: 1, height: '32px' }}>
              <Icon name="search" size={15} color="var(--icon)" />
              <input
                value={q}
                placeholder="파일 안에서 찾기"
                onInput={(e) => setQ((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') go(e.shiftKey ? -1 : 1);
                  if (e.key === 'Escape') {
                    if (q) setQ('');
                    else props.onClose();
                    e.stopPropagation();
                  }
                }}
              />
              {q && <span class="muted" style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>{matches.length ? `${mi + 1} / ${matches.length}` : '0건'}</span>}
            </label>
            <button type="button" class="icon-btn" onClick={() => go(-1)} disabled={!matches.length} aria-label="이전">
              <Icon name="arrow_up" size={15} />
            </button>
            <button type="button" class="icon-btn" onClick={() => go(1)} disabled={!matches.length} aria-label="다음">
              <Icon name="arrow_down" size={15} />
            </button>
          </div>
        )}
        {text && hlStart > 0 && (
          <div class="viewer-banner">
            <Icon name="info" size={15} />
            근거 위치 {hlStart === hlEnd ? `${hlStart}줄` : `${hlStart}–${hlEnd}줄`}
            {sqlHere?.stmtId && <span class="mono" style={{ fontSize: '12px' }}>· {sqlHere.stmtId}</span>}
          </div>
        )}
        {big && (
          <div class="banner warn" style={{ borderRadius: 0 }}>
            <Icon name="warn" size={15} />
            <span class="grow">파일이 커서 앞부분 {BIG_LINES.toLocaleString('ko-KR')}줄만 표시합니다.</span>
            <button type="button" class="btn sm" onClick={() => setShowAll(true)}>전체 보기</button>
          </div>
        )}
        {text === undefined && (
          <div class="viewer-empty">
            <Spinner size={20} />
            파일을 읽는 중
          </div>
        )}
        {text === null && (
          <div class="viewer-empty">
            <Icon name="folder" size={28} color="var(--faint)" />
            <div>
              받은 결과 파일에는 소스 코드가 없습니다.
              <br />
              원본 폴더를 연결하면 코드를 볼 수 있습니다.
            </div>
            {props.onConnectFolder && (
              <button type="button" class="btn" onClick={props.onConnectFolder}>
                <Icon name="link" size={15} />
                원본 폴더 연결
              </button>
            )}
          </div>
        )}
        {text != null && (
          <div class="code" ref={box} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} tabIndex={0}>
            <div class="lines" style={{ height: `${lines.length * LH}px` }}>
              {lines.slice(first, last).map((l, k) => {
                const n = first + k + 1;
                const hl = hlStart > 0 && n >= hlStart && n <= hlEnd;
                return (
                  <div key={n} class={`cl${hl ? ' hl' : ''}${curMatch === n ? ' cur' : ''}`} style={{ top: `${(n - 1) * LH}px` }}>
                    <span class="no">{n}</span>
                    <span class="tx">{renderText(l, n - 1)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {usage && (usage.screens.size > 0 || usage.tables.size > 0 || usage.batches.size > 0) && (
          <div class="viewer-foot">
            <div class="row" style={{ gap: '6px' }}>
              <b style={{ fontSize: '13px' }}>이 파일을 쓰는 곳</b>
              <span class="muted" style={{ fontSize: '12px' }}>
                {usage.screens.size ? `화면 ${usage.screens.size}` : ''}
                {usage.batches.size ? `${usage.screens.size ? ' · ' : ''}배치 ${usage.batches.size}` : ''}
                {usage.tables.size ? ` · 테이블 ${usage.tables.size}` : ''}
              </span>
            </div>
            {(usage.screens.size > 0 || usage.batches.size > 0) && (
              <div class="chips">
                {[...usage.screens].slice(0, 8).map((sid) => {
                  const s = model.screenById.get(sid);
                  return s ? (
                    <button type="button" class="chip click" style={{ height: '26px' }} key={sid} onClick={() => props.onScreen(sid)}>
                      {s.name}
                    </button>
                  ) : null;
                })}
                {[...usage.batches].slice(0, 4).map((bid) => {
                  const b = model.batchById.get(bid);
                  return b ? (
                    <button type="button" class="chip click" style={{ height: '26px' }} key={bid} onClick={() => props.onBatch(bid)}>
                      <Tag>배치</Tag>
                      {b.name}
                    </button>
                  ) : null;
                })}
                {usage.screens.size > 8 && <span class="muted" style={{ fontSize: '12px', alignSelf: 'center' }}>외 {usage.screens.size - 8}개</span>}
              </div>
            )}
            {usage.tables.size > 0 && (
              <div class="chips">
                {[...usage.tables.entries()].slice(0, 12).map(([k, set]) => {
                  const t = model.tableByKey.get(k);
                  return (
                    <button type="button" class="chip click" style={{ height: '26px' }} key={k} onClick={() => t && props.onTable(t.id)}>
                      <span class="mono">{t?.name ?? k}</span>
                      {set.size > 0 && <CrudMini crud={crudList(set)} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
