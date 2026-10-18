// 변경 비교 (SCR-10 ④, SCR-12 [변경 보기]): 파일마다 머리글(이름·함수·줄 범위·+/−·포함)과 줄 번호가 붙은 비교.
// 왼쪽 번호 원본, 오른쪽 번호 작업 사본. 지운 줄은 빨강, 더한 줄은 초록.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { DiffHunk, FileChange } from '../../../shared/desktop-api';
import { Icon } from '../../icons';

// ------------------------------------------------------------------ 경로 표시

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

const SRC_ROOTS = ['src/main/java/egovframework/', 'src/main/java/', 'src/main/kotlin/', 'src/main/resources/', 'src/main/webapp/', 'src/test/java/', 'app/src/main/java/'];

/** 폴더 표시: 흔한 소스 뿌리(src/main/java/egovframework/ 등)는 뗀다 */
export function dirShort(p: string): string {
  const i = p.lastIndexOf('/');
  let d = i > 0 ? p.slice(0, i) : '';
  for (const r of SRC_ROOTS) {
    if (`${d}/`.startsWith(r) && d.length > r.length - 1) {
      d = d.slice(r.length);
      break;
    }
  }
  return d || '/';
}

export function Delta(props: { plus: number; minus: number }) {
  return (
    <span class="wv-delta">
      {props.plus > 0 && <span class="p">+{props.plus}</span>}
      {props.minus > 0 && <span class="m">−{props.minus}</span>}
      {!props.plus && !props.minus && <span class="muted" style={{ fontWeight: 500 }}>0</span>}
    </span>
  );
}

// ------------------------------------------------------------------ 간단한 강조 (키워드·문자열·주석·태그)

const C_KW = new Set(
  (
    'public private protected static final abstract class interface extends implements import package void int long boolean char byte short double float ' +
    'new return if else for while do switch case default break continue throw throws try catch finally this super null true false instanceof synchronized ' +
    'var let const function async await yield typeof delete in of export from as enum struct type func go defer chan map range select package ' +
    'def elif lambda None True False pass with yield raise except is not and or echo namespace use fn val fun override when object companion data sealed'
  ).split(' '),
);
const SQL_KW = new Set(
  (
    'SELECT FROM WHERE INSERT INTO UPDATE SET DELETE VALUES AND OR NOT IN IS NULL JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS GROUP BY ORDER HAVING UNION ALL ' +
    'DISTINCT CASE WHEN THEN ELSE END MERGE USING MATCHED CREATE TABLE ALTER DROP INDEX VIEW COMMIT ROLLBACK EXISTS LIKE BETWEEN ASC DESC LIMIT OFFSET ' +
    'NVL COUNT MIN MAX SUM AVG ROWID ROWNUM SYSDATE PRIMARY KEY FOREIGN REFERENCES DEFAULT CONSTRAINT WITH TRUNCATE GRANT PROCEDURE BEGIN DECLARE'
  ).split(' '),
);

function langOf(path: string): 'c' | 'sql' | 'xml' | 'conf' | 'plain' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (/^(java|kt|kts|js|mjs|cjs|jsx|ts|tsx|go|php|cs|groovy|gradle|dart|swift|py|scala|c|cpp|h|vue)$/.test(ext)) return 'c';
  if (/^(sql|ddl|pls|pkb|pks|prc)$/.test(ext)) return 'sql';
  if (/^(xml|jsp|jspf|html|htm|xhtml|tag|tld|vm|ftl)$/.test(ext)) return 'xml';
  if (/^(properties|yml|yaml|ini|conf|cfg|toml|sh|bat|cmd|env)$/.test(ext)) return 'conf';
  return 'plain';
}

const C_TOKEN = /(\/\/.*$|#.*$|\/\*.*?(?:\*\/|$)|^\s*\*.*$|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?|\b[A-Za-z_$][\w$]*\b)/g;
const SQL_TOKEN = /(--.*$|\/\*.*?(?:\*\/|$)|'(?:[^']|'')*'?|\b[A-Za-z_][\w$]*\b)/g;
const XML_TOKEN = /(<!--.*?(?:-->|$)|<\/?[\w:.-]+|\/?>|"[^"]*"?|'[^']*'?|\b[A-Z][A-Z_]{2,}\b|#\{[^}]*\}|\$\{[^}]*\})/g;

export function highlight(code: string, path: string): ComponentChildren {
  const lang = langOf(path);
  if (lang === 'plain' || code.length > 600) return code;
  if (lang === 'conf') {
    const m = /^(\s*[#;!].*)$/.exec(code);
    return m ? <span class="cm">{code}</span> : code;
  }
  const re = lang === 'c' ? C_TOKEN : lang === 'sql' ? SQL_TOKEN : XML_TOKEN;
  const out: ComponentChildren[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const t = m[0];
    if (!t) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(code.slice(last, m.index));
    last = m.index + t.length;
    let cls = '';
    if (lang === 'c') {
      if (/^(\/\/|\/\*|#|\s*\*)/.test(t) && !(t.startsWith('#') && path.endsWith('.java'))) cls = 'cm';
      else if (/^["'`]/.test(t)) cls = 'str';
      else if (C_KW.has(t)) cls = 'k';
    } else if (lang === 'sql') {
      if (/^(--|\/\*)/.test(t)) cls = 'cm';
      else if (t.startsWith("'")) cls = 'str';
      else if (SQL_KW.has(t.toUpperCase())) cls = 'k';
    } else {
      if (t.startsWith('<!--')) cls = 'cm';
      else if (/^(<|\/?>)/.test(t)) cls = 'tg';
      else if (/^["']/.test(t)) cls = 'str';
      else if (SQL_KW.has(t)) cls = 'k';
    }
    out.push(cls ? <span class={cls}>{t}</span> : t);
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

// ------------------------------------------------------------------ 묶음 머리 문구

/** 'updateDlvyInfo() · develop 126–132줄' */
export function hunkLabel(h: DiffHunk, base?: string): string {
  const olds = h.lines.filter((l) => l.o !== undefined).map((l) => l.o!);
  const news = h.lines.filter((l) => l.n !== undefined).map((l) => l.n!);
  const range = olds.length ? `${Math.min(...olds)}–${Math.max(...olds)}줄` : news.length ? `${Math.min(...news)}–${Math.max(...news)}줄(새 줄)` : '';
  return [h.fn, [base, range].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

function statusTags(c: FileChange): ComponentChildren[] {
  const t: ComponentChildren[] = [];
  if (c.status === 'added') t.push(<span key="a" class="tag ok">새 파일</span>);
  if (c.status === 'deleted') t.push(<span key="d" class="tag err">삭제</span>);
  if (c.encoding) t.push(<span key="e" class="tag neutral" title={`원본은 ${c.encoding}. 적용할 때 ${c.encoding}로 저장합니다`}>{c.encoding}</span>);
  if (c.redacted) t.push(<span key="r" class="tag neutral" title="작업 사본에서 비밀 값을 가린 파일. 적용할 때 가린 값은 원본 값으로 되돌립니다">값 가림</span>);
  if (c.dirtyBase) t.push(<span key="b" class="tag warn" title="작업 사본을 만들 때 원본에 커밋 안 된 변경이 있던 파일. 커밋하면 그 변경도 함께 들어갑니다">원래 변경 있음</span>);
  if (c.conflict) t.push(<span key="c" class="tag warn" title="작업 사본을 만든 뒤 원본 파일이 바뀌었습니다">원본 바뀜</span>);
  if (c.blocked) t.push(<span key="x" class="tag err">적용 불가</span>);
  return t;
}

export { statusTags };

// ------------------------------------------------------------------ 파일 하나

const PAGE = 300;

export function DiffFile(props: {
  change: FileChange;
  id?: string;
  /** 원본 기준 표시 (예: 'develop') */
  base?: string;
  /** 적용에 포함 (없으면 포함 표시 없음: 읽기 전용) */
  included?: boolean;
  onToggle?: () => void;
  /** 변경 설명 (Claude가 남긴 이유) */
  reason?: ComponentChildren;
  /** 머리글 오른쪽에 더 붙일 것 */
  extra?: ComponentChildren;
}) {
  const c = props.change;
  const [limit, setLimit] = useState(PAGE);
  const first = c.hunks[0];
  const chip = c.status === 'added' ? `새 파일${first?.fn ? ` · ${first.fn}` : ''}` : c.status === 'deleted' ? '지운 파일' : first ? hunkLabel(first, props.base) : '';
  const total = c.hunks.reduce((n, h) => n + h.lines.length, 0);
  let shown = 0;
  const readOnly = props.included === undefined;
  return (
    <div class={`wv-fb${!readOnly && !props.included ? ' off' : ''}`} id={props.id}>
      <div class="wv-fb-head">
        <Icon name="file" size={15} color="var(--icon)" sw={1.7} />
        <span class="nm" title={c.path}>{baseName(c.path)}</span>
        {chip && <span class="wv-hchip" title={chip}>{chip}</span>}
        <span class="sp" />
        {statusTags(c).filter((_, i) => i < 3)}
        {props.extra}
        <Delta plus={c.plus} minus={c.minus} />
        {!readOnly &&
          (c.blocked ? (
            <span class="tag err">제외</span>
          ) : (
            <button
              type="button"
              class={`tag ${props.included ? 'acc' : 'neutral'}`}
              style={{ border: 'none', cursor: 'pointer' }}
              aria-pressed={props.included}
              title={props.included ? '누르면 적용에서 뺍니다' : '누르면 적용에 넣습니다'}
              onClick={props.onToggle}
            >
              {props.included ? '포함' : '제외'}
            </button>
          ))}
      </div>
      {props.reason && (
        <div class="wv-why">
          <span class="ic"><Icon name="sparkle" size={14} color="var(--ink2)" /></span>
          <span>{props.reason}</span>
        </div>
      )}
      {c.blocked && (
        <div class="wv-fb-note err">
          <span class="ic"><Icon name="lock" size={14} /></span>
          <span>{c.blocked}</span>
        </div>
      )}
      {c.conflict && (
        <div class="wv-fb-note warn">
          <span class="ic"><Icon name="warn" size={14} /></span>
          <span>작업 사본을 만든 뒤 원본 파일이 바뀌었습니다. 아래는 지금 원본과 작업 사본의 차이입니다.</span>
        </div>
      )}
      {c.binary ? (
        <div class="wv-fb-note info" style={{ borderBottom: 'none', borderRadius: '0 0 7px 7px' }}>
          <span class="ic"><Icon name="info" size={14} /></span>
          <span>바이너리 파일이라 비교를 표시하지 않습니다.</span>
        </div>
      ) : !c.hunks.length ? (
        <div class="wv-fb-note info" style={{ borderBottom: 'none', borderRadius: '0 0 7px 7px' }}>
          <span class="ic"><Icon name="info" size={14} /></span>
          <span>{c.plus || c.minus ? `변경이 커서 비교를 줄였습니다 (+${c.plus} −${c.minus}).` : '줄 내용은 같고 줄바꿈·인코딩만 바뀌었습니다.'}</span>
        </div>
      ) : (
        <div class="wv-code" role="table" aria-label={`${baseName(c.path)} 변경 비교`}>
          {c.hunks.map((h, hi) => {
            if (shown >= limit) return null;
            const rows = h.lines.slice(0, Math.max(0, limit - shown));
            shown += rows.length;
            return (
              <div key={hi}>
                {hi > 0 && <div class="gap">⋯ {hunkLabel(h, props.base)}</div>}
                {rows.map((l, i) => (
                  <div key={i} class={`ln${l.t === '-' ? ' del' : l.t === '+' ? ' add' : ''}`} role="row">
                    <span class="g">{l.o ?? ''}</span>
                    <span class="g">{l.n ?? ''}</span>
                    <span class="s">{l.t === '-' ? '−' : l.t === '+' ? '+' : ''}</span>
                    <span class="tx">{highlight(l.s, c.path)}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {total > limit && (
            <div class="more">
              <button type="button" class="btn sm" onClick={() => setLimit((n) => n + PAGE * 4)}>
                {(total - limit).toLocaleString('ko-KR')}줄 더 보기
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 읽기 전용 비교 목록 (작업 이력 [변경 보기]·[차이 보기]) */
export function DiffList(props: { changes: FileChange[]; base?: string; focus?: string; empty?: ComponentChildren }) {
  if (!props.changes.length) return <div class="empty-note">{props.empty ?? '비교할 변경이 없습니다.'}</div>;
  return (
    <div class="wv-blocks">
      {props.changes.map((c) => (
        <DiffFile key={c.path} change={c} base={props.base} id={props.focus === c.path ? 'wv-focus' : undefined} />
      ))}
    </div>
  );
}
