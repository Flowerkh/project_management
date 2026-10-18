// Claude 답변용 작은 Markdown 표시기 (문단·목록·제목·인용·표·코드 블록·**굵게**·`코드`·링크).
// HTML을 직접 넣지 않고 Preact 요소로만 만든다. 파일:줄은 소스 뷰어로, 테이블·화면 URL은 상세 화면으로 잇는다.
import type { ComponentChildren, VNode } from 'preact';
import type { FileInfo } from '../../../engine/types';
import { Icon } from '../../icons';
import type { Model, Target } from '../../model';

export interface LinkEnv {
  model: Model | null;
  /** 프로젝트 기준 상대 경로로 소스 뷰어 열기 (없으면 알림) */
  openFile(path: string, line?: number): void;
  nav(t: Target): void;
  openExternal(url: string): void;
}

// ------------------------------------------------------------------ 이름 → 분석 결과 항목

const nameIndex = new WeakMap<Model, Map<string, FileInfo[]>>();

function filesByName(model: Model): Map<string, FileInfo[]> {
  let m = nameIndex.get(model);
  if (!m) {
    m = new Map();
    for (const f of model.r.files) {
      const k = f.name.toLowerCase();
      const arr = m.get(k);
      if (arr) arr.push(f);
      else m.set(k, [f]);
    }
    nameIndex.set(model, m);
  }
  return m;
}

/** 'OrderServiceImpl.java' · 'egov/shop/OrderServiceImpl.java' · 전체 상대 경로 → 분석 결과의 파일 (이름이 겹치면 못 찾음) */
export function resolveFile(model: Model | null, ref: string): FileInfo | null {
  if (!model) return null;
  const p = ref.replace(/\\/g, '/').replace(/^\.?\//, '');
  const exact = model.fileByPath.get(p);
  if (exact) return exact;
  if (p.includes('/')) {
    const hits = model.r.files.filter((f) => f.path === p || f.path.endsWith(`/${p}`));
    return hits.length >= 1 ? hits[0] : null;
  }
  const list = filesByName(model).get(p.toLowerCase());
  return list && list.length === 1 ? list[0] : null;
}

export type Resolved =
  | { kind: 'screen' | 'table' | 'menu' | 'batch'; id: string; label: string }
  | { kind: 'file'; path: string; line?: number; label: string }
  | { kind: 'none'; label: string };

/** 영향 범위 같은 이름 하나를 화면·테이블·메뉴·배치·파일로 */
export function resolveName(model: Model | null, raw: string): Resolved {
  const label = raw.replace(/[`*"'“”‘’]/g, '').trim();
  if (!model || !label) return { kind: 'none', label };
  const bare = label.replace(/\s*(화면|테이블|메뉴|배치|팝업)$/, '').trim() || label;
  const t = model.tableByKey.get(bare.toUpperCase());
  if (t && /^[A-Za-z0-9_$#.]+$/.test(bare)) return { kind: 'table', id: t.id, label: t.name };
  const s = model.r.screens.find((x) => x.name === bare) ?? model.r.screens.find((x) => x.urls.includes(bare));
  if (s) return { kind: 'screen', id: s.id, label: s.name };
  const m = model.r.menus.find((x) => x.name === bare);
  if (m) return { kind: 'menu', id: m.id, label: m.name };
  const b = model.r.batches.find((x) => x.name === bare);
  if (b) return { kind: 'batch', id: b.id, label: b.name };
  const fm = bare.match(/^(.+?)(?::(\d+))?$/);
  const f = fm ? resolveFile(model, fm[1]) : null;
  if (f) return { kind: 'file', path: f.path, line: fm?.[2] ? Number(fm[2]) : undefined, label };
  return { kind: 'none', label };
}

export function openResolved(env: LinkEnv, r: Resolved): void {
  if (r.kind === 'file') env.openFile(r.path, r.line);
  else if (r.kind !== 'none') env.nav({ kind: r.kind, id: r.id } as Target);
}

const KIND_ICON: Record<Resolved['kind'], string> = { screen: 'screen', table: 'table', menu: 'menu', batch: 'clock', file: 'file', none: 'info' };

export function LinkChip(props: { env: LinkEnv; r: Resolved }) {
  const { r } = props;
  const mono = r.kind === 'table' || r.kind === 'file';
  if (r.kind === 'none')
    return (
      <span class="cp-linkchip plain">
        <span>{r.label}</span>
      </span>
    );
  return (
    <button type="button" class={`cp-linkchip${mono ? ' mono' : ''}`} onClick={() => openResolved(props.env, r)} title={r.kind === 'file' ? r.path : undefined}>
      <Icon name={KIND_ICON[r.kind]} size={13} color="var(--icon)" sw={1.7} />
      <span>{r.label}</span>
    </button>
  );
}

// ------------------------------------------------------------------ 글 안의 링크

const EXT = 'java|jsp|jspf|xml|js|mjs|cjs|ts|tsx|jsx|vue|sql|properties|ya?ml|json|html?|css|scss|kt|kts|py|go|php|sh|bat|cmd|ps1|cs|gradle|md|txt|ftl|vm';
const FILE_RE = new RegExp(`(?<![\\w/.\\-])((?:[\\w.\\-]+/)*[\\w\\-][\\w.\\-]*\\.(?:${EXT}))(?::(\\d+)(?:[-~]\\d+)?)?(?![\\w])`, 'g');
const FILE_FULL = new RegExp(`^((?:[\\w.\\-]+/)*[\\w\\-][\\w.\\-]*\\.(?:${EXT}))(?::(\\d+)(?:[-~]\\d+)?)?$`);
const TABLE_RE = /(?<![\w$#])([A-Z][A-Z0-9_$#]{2,})(?![\w$#])/g;
const URL_PATH_RE = /^\/[\w\-/.]+\.(?:do|action|jsp|html?)$/;

function isTableToken(model: Model, tok: string): boolean {
  return (tok.includes('_') || tok.length >= 4) && model.tableByKey.has(tok);
}

function FileRef(props: { env: LinkEnv; text: string; path: string; line?: number }) {
  return (
    <button type="button" class="cp-ref" title={`${props.path}${props.line ? `:${props.line}` : ''} 소스 보기`} onClick={() => props.env.openFile(props.path, props.line)}>
      {props.text}
    </button>
  );
}

function TableRef(props: { env: LinkEnv; text: string; id: string }) {
  return (
    <button type="button" class="cp-tlink" title="테이블 상세" onClick={() => props.env.nav({ kind: 'table', id: props.id })}>
      {props.text}
    </button>
  );
}

function linkify(text: string, env: LinkEnv, key: string): ComponentChildren[] {
  const model = env.model;
  if (!model || !text) return [text];
  const hits: { s: number; e: number; node: VNode }[] = [];
  FILE_RE.lastIndex = 0;
  for (let m = FILE_RE.exec(text); m; m = FILE_RE.exec(text)) {
    const f = resolveFile(model, m[1]);
    if (!f) continue;
    hits.push({ s: m.index, e: m.index + m[0].length, node: <FileRef key={`${key}f${m.index}`} env={env} text={m[0]} path={f.path} line={m[2] ? Number(m[2]) : undefined} /> });
  }
  TABLE_RE.lastIndex = 0;
  for (let m = TABLE_RE.exec(text); m; m = TABLE_RE.exec(text)) {
    if (!isTableToken(model, m[1])) continue;
    const s = m.index;
    const e = s + m[1].length;
    if (hits.some((h) => s < h.e && e > h.s)) continue;
    const t = model.tableByKey.get(m[1])!;
    hits.push({ s, e, node: <TableRef key={`${key}t${s}`} env={env} text={m[1]} id={t.id} /> });
  }
  if (!hits.length) return [text];
  hits.sort((a, b) => a.s - b.s);
  const out: ComponentChildren[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.s < pos) continue;
    if (h.s > pos) out.push(text.slice(pos, h.s));
    out.push(h.node);
    pos = h.e;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function codeSpan(code: string, env: LinkEnv, key: string): VNode {
  const model = env.model;
  const c = code.trim();
  if (model) {
    const fm = c.match(FILE_FULL);
    if (fm) {
      const f = resolveFile(model, fm[1]);
      if (f) return <FileRef key={key} env={env} text={c} path={f.path} line={fm[2] ? Number(fm[2]) : undefined} />;
    }
    const up = c.toUpperCase();
    if (/^[A-Za-z][A-Za-z0-9_$#]{2,}$/.test(c) && c === up && model.tableByKey.has(up)) return <TableRef key={key} env={env} text={c} id={model.tableByKey.get(up)!.id} />;
    if (URL_PATH_RE.test(c)) {
      const s = model.r.screens.find((x) => x.urls.includes(c));
      if (s)
        return (
          <button key={key} type="button" class="cp-tlink" title={s.name} onClick={() => env.nav({ kind: 'screen', id: s.id })}>
            {c}
          </button>
        );
    }
  }
  return (
    <code key={key} class="cp-ident">
      {code}
    </code>
  );
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*][\s\S]*?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])/g;

export function renderInline(text: string, env: LinkEnv, key = 'i'): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let pos = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > pos) out.push(...linkify(text.slice(pos, m.index), env, `${key}-${n++}`));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) out.push(codeSpan(m[2], env, k));
    else if (m[3] !== undefined) out.push(<b key={k}>{renderInline(m[3], env, k)}</b>);
    else if (m[4] !== undefined) {
      const url = m[5];
      const ok = /^https?:\/\//i.test(url);
      out.push(
        ok ? (
          <a key={k} class="ext" href="#" title={url} onClick={(e) => { e.preventDefault(); env.openExternal(url); }}>
            {m[4]}
          </a>
        ) : (
          <span key={k}>{renderInline(m[4], env, k)}</span>
        ),
      );
    } else if (m[6] !== undefined) out.push(<em key={k}>{renderInline(m[6], env, k)}</em>);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push(...linkify(text.slice(pos), env, `${key}-${n++}`));
  return out;
}

/** 줄바꿈은 그대로 줄바꿈으로 (채팅 글 방식) */
function inlineLines(lines: string[], env: LinkEnv, key: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push(<br key={`${key}br${i}`} />);
    out.push(...renderInline(l, env, `${key}l${i}`));
  });
  return out;
}

// ------------------------------------------------------------------ 블록

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][]; heads: string[][] }
  | { t: 'quote'; inner: Block[] }
  | { t: 'hr' }
  | { t: 'table'; head: string[]; rows: string[][]; align: ('' | 'left' | 'center' | 'right')[] }
  | { t: 'impact'; tokens: string[] };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.\-]*)\s*$/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMPACT = /^\s*(?:\*\*)?영향\s*범위(?:\*\*)?\s*[:：]\s*(.*)$/;

const indentOf = (s: string) => (s.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function splitTokens(s: string): string[] {
  return s
    .split(/\s*[,，、]\s*|\s+\/\s+/)
    .map((x) => x.replace(/^[-*•]\s*/, '').replace(/[.。]$/, '').trim())
    .filter(Boolean);
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEAD.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || (line.includes('|') && next !== undefined && TSEP.test(next));
}

export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`{3,}' : '~{3,}'}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const head = line.match(HEAD);
    if (head) {
      out.push({ t: 'h', level: head[1].length, text: head[2] });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    const imp = line.match(IMPACT);
    if (imp) {
      const tokens = splitTokens(imp[1]);
      i++;
      if (!tokens.length) {
        while (i < lines.length && LIST.test(lines[i])) tokens.push(...splitTokens(lines[i++].match(LIST)![3]));
      }
      if (tokens.length) {
        out.push({ t: 'impact', tokens });
        continue;
      }
      out.push({ t: 'p', lines: [line] });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TSEP.test(lines[i + 1])) {
      const head2 = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '') as '' | 'left' | 'center' | 'right');
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push({ t: 'table', head: head2, rows, align });
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)![1]);
      out.push({ t: 'quote', inner: parseBlocks(inner) });
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      const base = indentOf(li[1]);
      const ordered = /\d/.test(li[2]);
      const start = ordered ? Number.parseInt(li[2], 10) || 1 : 1;
      const heads: string[][] = [];
      const subs: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST);
        if (m && indentOf(m[1]) <= base + 1 && /\d/.test(m[2]) === ordered) {
          heads.push([m[3]]);
          subs.push([]);
          i++;
          continue;
        }
        if (!l.trim()) {
          // 빈 줄 뒤에 같은 목록이 이어지면 계속
          const nx = lines[i + 1];
          const nm = nx?.match(LIST);
          if (nm && indentOf(nm[1]) <= base + 1 && /\d/.test(nm[2]) === ordered) {
            i++;
            continue;
          }
          if (nx !== undefined && indentOf(nx) > base + 1 && nx.trim()) {
            subs[subs.length - 1].push('');
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base + 1 || (m && indentOf(m[1]) > base + 1)) {
          subs[subs.length - 1].push(l.replace(new RegExp(`^\\s{0,${base + 4}}`), ''));
          i++;
          continue;
        }
        if (m) break;
        // 들여쓰지 않은 이어지는 줄 (게으른 줄바꿈)
        if (startsBlock(l, lines[i + 1])) break;
        heads[heads.length - 1].push(l.trim());
        i++;
      }
      out.push({ t: 'list', ordered, start, heads, items: subs.map((s) => parseBlocks(s)) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1])) && !IMPACT.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push({ t: 'p', lines: para });
  }
  return out;
}

const Caret = () => <span class="cp-caret" aria-hidden="true" />;

function renderBlocks(blocks: Block[], env: LinkEnv, key: string, caret: boolean): VNode[] {
  return blocks.map((b, bi) => {
    const k = `${key}.${bi}`;
    const last = caret && bi === blocks.length - 1;
    switch (b.t) {
      case 'p':
        return (
          <p key={k}>
            {inlineLines(b.lines, env, k)}
            {last && <Caret />}
          </p>
        );
      case 'h':
        return (
          <div key={k} class={`h h${Math.min(b.level, 3)}`}>
            {renderInline(b.text, env, k)}
            {last && <Caret />}
          </div>
        );
      case 'code':
        return (
          <pre key={k}>
            {b.lang && <span class="lang">{b.lang}</span>}
            {b.text}
            {last && <Caret />}
          </pre>
        );
      case 'hr':
        return <hr key={k} />;
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.inner, env, k, last)}</blockquote>;
      case 'table':
        return (
          <div key={k} class="tblw">
            <table>
              <thead>
                <tr>
                  {b.head.map((h, i) => (
                    <th key={i} style={b.align[i] ? { textAlign: b.align[i] } : undefined}>
                      {renderInline(h, env, `${k}h${i}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, ci) => (
                      <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci] } : undefined}>
                        {renderInline(r[ci] ?? '', env, `${k}r${ri}c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {last && <Caret />}
          </div>
        );
      case 'impact':
        return (
          <div key={k} class="cp-impact">
            <span class="k">영향 범위</span>
            {b.tokens.map((t, i) => (
              <LinkChip key={i} env={env} r={resolveName(env.model, t)} />
            ))}
            {last && <Caret />}
          </div>
        );
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag key={k} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.heads.map((h, i) => {
              const lastItem = last && i === b.heads.length - 1;
              const sub = b.items[i];
              return (
                <li key={i}>
                  {inlineLines(h, env, `${k}li${i}`)}
                  {sub.length > 0 && renderBlocks(sub, env, `${k}s${i}`, lastItem)}
                  {lastItem && !sub.length && <Caret />}
                </li>
              );
            })}
          </Tag>
        );
      }
    }
  });
}

export function Markdown(props: { text: string; env: LinkEnv; caret?: boolean; class?: string }) {
  const blocks = parseBlocks(props.text.replace(/\r\n?/g, '\n').split('\n'));
  if (!blocks.length) return <div class={`cp-md ${props.class ?? ''}`}>{props.caret && <p><Caret /></p>}</div>;
  return <div class={`cp-md ${props.class ?? ''}`}>{renderBlocks(blocks, props.env, 'b', !!props.caret)}</div>;
}

/** 제목(#·**굵게**만 있는 줄·'요구사항:') 기준으로 글을 나눈다 (새 프로젝트의 요구사항·계획 찾기) */
export function sectionsOf(text: string): { title: string; body: string[] }[] {
  const out: { title: string; body: string[] }[] = [{ title: '', body: [] }];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = line.match(HEAD) ?? line.match(/^\s*\*\*([^*]+)\*\*\s*[:：]?\s*$/) ?? line.match(/^\s*((?:요구\s*사항|계획|구성|진행 계획|생성 계획)[^:：]{0,12})\s*[:：]\s*$/);
    if (h) out.push({ title: (h[2] ?? h[1]).replace(/[*:：]/g, '').trim(), body: [] });
    else out[out.length - 1].body.push(line);
  }
  return out;
}

/** 목록 줄만 뽑기 (번호·글머리 떼고) */
export function listItemsOf(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(LIST);
    if (m && indentOf(m[1]) <= 1) out.push(m[3].trim());
    else if (m && out.length) out[out.length - 1] += ` ${m[3].trim()}`;
  }
  return out;
}
