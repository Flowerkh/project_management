import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { AnalysisResult } from '../../engine/types';
import { fmtNum, langColor } from '../format';
import { Icon, Logo } from '../icons';
import type { RecentItem } from '../recent';
import { Tag } from './common';
import { ConfTag } from './common';

declare const __APP_VERSION__: string | undefined;
/** 화면에 보이는 버전: 0.5.0 → v0.5, 0.5.1 → v0.5.1 */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? `v${__APP_VERSION__.replace(/\.0$/, '')}` : '';

export type HeaderPopover = 'lang' | 'db' | 'proj';

export function Header(props: {
  result: AnalysisResult | null;
  projectName?: string;
  running: boolean;
  canRun: boolean;
  popover: HeaderPopover | null;
  setPopover: (p: HeaderPopover | null) => void;
  onOpenFolder: () => void;
  onRun: () => void;
  onStop: () => void;
  onSettings: () => void;
  onHome: () => void;
  onOpenFile: (fileId: string, line?: number) => void;
  /** 데스크톱 앱: [이력]·[Claude] 버튼 (Run과 설정 사이) */
  extras?: ComponentChildren;
  /** 데스크톱 앱: 프로젝트 이름 옆 연결 아이콘 → 프로젝트 연결(POP-04) */
  onProjectChip?: () => void;
  /** 프로젝트 이름을 누르면 펼치는 최근 분석한 프로젝트 (고르면 그 결과를 연다) */
  recent?: RecentItem[];
  /** 지금 연 프로젝트의 폴더 (목록에서 표시) */
  currentRoot?: string;
  onOpenRecent?: (key: string) => void;
  /** 목록을 펼칠 때 (최신 목록 다시 읽기) */
  onProjectMenu?: () => void;
}) {
  const r = props.result;
  const langs = r ? r.languages.filter((l) => l.name !== 'Other').slice(0, 3) : [];
  const db = r?.databases[0];
  const dbLabel = db ? `${db.type}${r!.databases.length > 1 ? ` +${r!.databases.length - 1}` : ''}${db.access[0] ? ` · ${db.access[0].replace(/\s*\(.*\)$/, '').replace(/ 매퍼$/, '')}` : ''}` : r ? '감지 안 됨' : '—';
  const wrap = useRef<HTMLDivElement>(null);
  const projWrap = useRef<HTMLDivElement>(null);

  // 바깥을 누르면 팝오버 닫기
  useEffect(() => {
    if (!props.popover) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || projWrap.current?.contains(t)) return;
      props.setPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [props.popover]);

  return (
    <header class="hdr">
      <button type="button" class="brand" style={{ border: 'none', background: 'none', padding: 0 }} onClick={props.onHome} title="처음 화면으로">
        <Logo />
        <span class="brand-name">프로젝트 분석 시스템</span>
        {APP_VERSION && <span class="brand-ver">{APP_VERSION}</span>}
      </button>
      {props.projectName && (
        <div ref={projWrap} class="proj-wrap">
          {props.onOpenRecent ? (
            <button
              type="button"
              class={`proj-chip click${props.popover === 'proj' ? ' on' : ''}`}
              title={`${props.projectName} · 누르면 분석했던 프로젝트로 바꿀 수 있습니다`}
              aria-haspopup="dialog"
              aria-expanded={props.popover === 'proj'}
              onClick={() => {
                if (props.popover !== 'proj') props.onProjectMenu?.();
                props.setPopover(props.popover === 'proj' ? null : 'proj');
              }}
            >
              <Icon name="folder" size={14} color="var(--icon)" />
              <span class="ellipsis">{props.projectName}</span>
              <Icon name="chev_down" size={13} color="var(--muted)" />
            </button>
          ) : (
            <span class="proj-chip" title={props.projectName}>
              <Icon name="folder" size={14} color="var(--icon)" />
              <span class="ellipsis">{props.projectName}</span>
            </span>
          )}
          {props.onProjectChip && (
            <button type="button" class="proj-link" aria-label="프로젝트 연결" title="프로젝트 연결 (형상관리·DB)" onClick={props.onProjectChip}>
              <Icon name="link" size={16} color="var(--ink2)" />
            </button>
          )}
          {props.popover === 'proj' && (
            <ProjectPopover
              recent={props.recent ?? []}
              projectName={props.projectName}
              currentRoot={props.currentRoot}
              running={props.running}
              onPick={(k) => {
                props.setPopover(null);
                props.onOpenRecent?.(k);
              }}
              onOpenFolder={() => {
                props.setPopover(null);
                props.onOpenFolder();
              }}
              onClose={() => props.setPopover(null)}
            />
          )}
        </div>
      )}
      <span class="hdr-sep" />
      <div ref={wrap} class="row hdr-infos" style={{ gap: '4px' }}>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            class={`hdr-info${props.popover === 'lang' ? ' on' : ''}`}
            disabled={!r}
            onClick={() => props.setPopover(props.popover === 'lang' ? null : 'lang')}
            aria-haspopup="dialog"
            aria-expanded={props.popover === 'lang'}
          >
            <span class="lbl">사용 언어</span>
            <span class="val">
              {langs.length ? (
                langs.map((l, i) => (
                  <span key={l.name} class="row" style={{ gap: '4px' }}>
                    {i > 0 && <span class="dotsep">·</span>}
                    {l.name} <span class="pct">{Math.round(l.ratio * 100)}%</span>
                  </span>
                ))
              ) : (
                <span class="faint">—</span>
              )}
              {r && <Icon name="chev_down" size={13} color="var(--muted)" />}
            </span>
          </button>
          {props.popover === 'lang' && r && <LangPopover r={r} />}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            class={`hdr-info${props.popover === 'db' ? ' on' : ''}`}
            disabled={!r}
            onClick={() => props.setPopover(props.popover === 'db' ? null : 'db')}
            aria-haspopup="dialog"
            aria-expanded={props.popover === 'db'}
          >
            <span class="lbl">사용 DB</span>
            <span class="val">
              <span class={r ? '' : 'faint'}>{dbLabel}</span>
              {r && <Icon name="chev_down" size={13} color="var(--muted)" />}
            </span>
          </button>
          {props.popover === 'db' && r && <DbPopover r={r} onOpenFile={(f, l) => { props.setPopover(null); props.onOpenFile(f, l); }} />}
        </div>
      </div>
      <div class="hdr-right">
        <button type="button" class="btn" onClick={props.onOpenFolder} disabled={props.running} aria-label="폴더 열기" title="폴더 열기">
          <Icon name="folder_plus" size={16} />
          <span class="btn-t">폴더 열기</span>
        </button>
        {props.running ? (
          <button type="button" class="btn danger" onClick={props.onStop}>
            <Icon name="stop" size={14} filled color="var(--err)" />
            중지
          </button>
        ) : (
          <button type="button" class="btn primary" onClick={props.onRun} disabled={!props.canRun} title={props.canRun ? '분석 실행' : '먼저 폴더를 불러오세요'}>
            <Icon name="play" size={14} filled color="#FFFFFF" />
            Run
          </button>
        )}
        {props.extras}
        <button type="button" class="btn" onClick={props.onSettings} disabled={props.running} aria-label="설정" title="설정 (분석 · AI 연결)">
          <Icon name="gear" size={16} />
          <span class="btn-t">설정</span>
        </button>
      </div>
    </header>
  );
}

function shortRoot(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 3 ? p : `…${sep}${parts.slice(-3).join(sep)}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? '오늘' : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 프로젝트 이름을 누르면: 최근 분석한 프로젝트 (고르면 저장된 결과를 열고, 폴더가 있으면 다시 연결) */
function ProjectPopover(props: { recent: RecentItem[]; projectName: string; currentRoot?: string; running: boolean; onPick: (key: string) => void; onOpenFolder: () => void; onClose: () => void }) {
  const isCur = (r: RecentItem) => (r.root ? !!props.currentRoot && r.root === props.currentRoot : r.name === props.projectName);
  return (
    <div class="popover proj-pop" role="dialog" aria-label="분석했던 프로젝트">
      <div class="pop-title">
        <b>분석했던 프로젝트</b>
        <span class="muted" style={{ marginLeft: 'auto', fontSize: '12px' }}>
          최근 {props.recent.length}개
        </span>
      </div>
      <div class="proj-list">
        {!props.recent.length && <div class="proj-empty">아직 저장된 분석 결과가 없습니다.</div>}
        {props.recent.map((r) => {
          const cur = isCur(r);
          return (
            <button
              type="button"
              key={r.key}
              class={`proj-item${cur ? ' cur' : ''}`}
              disabled={props.running}
              title={props.running ? '분석 중에는 바꿀 수 없습니다' : r.root ?? r.name}
              onClick={() => (cur ? props.onClose() : props.onPick(r.key))}
            >
              <span class="ic">{cur ? <Icon name="check" size={14} color="var(--acc)" sw={2.2} /> : <Icon name="folder" size={14} color="var(--icon)" />}</span>
              <span class="b">
                <span class="nm">{r.name}</span>
                <span class="sub">
                  {when(r.analyzedAt)} · 파일 {fmtNum(r.analyzedFiles)}개{r.root ? <span class="path"> · {shortRoot(r.root)}</span> : ' · 결과 파일'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div class="proj-foot">
        <button type="button" class="btn sm" onClick={props.onOpenFolder} disabled={props.running}>
          <Icon name="folder_plus" size={14} />
          다른 폴더 열기
        </button>
      </div>
    </div>
  );
}

function LangPopover(props: { r: AnalysisResult }) {
  const r = props.r;
  const totalLines = r.languages.reduce((a, l) => a + l.lines, 0);
  const shown = r.languages.filter((l) => l.ratio >= 0.01 && l.name !== 'Other').slice(0, 8);
  const rest = r.languages.filter((l) => !shown.includes(l));
  const restRow = rest.length ? { name: '기타', files: rest.reduce((a, l) => a + l.files, 0), lines: rest.reduce((a, l) => a + l.lines, 0), ratio: rest.reduce((a, l) => a + l.ratio, 0) } : null;
  return (
    <div class="popover" role="dialog" aria-label="언어 구성" style={{ width: '300px' }}>
      <div class="pop-title">
        <b>언어 구성</b>
        <span class="muted" style={{ marginLeft: 'auto', fontSize: '12px' }}>분석 파일 {fmtNum(r.stats.analyzedFiles)}개 · {fmtNum(totalLines)}줄</span>
      </div>
      <div class="lang-bar" style={{ marginBottom: '10px' }}>
        {shown.map((l) => <i key={l.name} style={{ flex: `${Math.max(l.ratio, 0.004)} 0 0`, background: langColor(l.name) }} />)}
        {restRow && <i style={{ flex: `${Math.max(restRow.ratio, 0.004)} 0 0`, background: '#9AA5B1' }} />}
      </div>
      <table class="tbl" style={{ tableLayout: 'auto' }}>
        <thead>
          <tr>
            <th>언어</th>
            <th class="r">파일</th>
            <th class="r">줄 수</th>
            <th class="r">비율</th>
          </tr>
        </thead>
        <tbody>
          {[...shown, ...(restRow ? [restRow] : [])].map((l) => (
            <tr key={l.name}>
              <td>
                <span class="row" style={{ gap: '7px' }}>
                  <i style={{ width: '9px', height: '9px', borderRadius: '2px', background: l.name === '기타' ? '#9AA5B1' : langColor(l.name), display: 'inline-block' }} />
                  {l.name}
                </span>
              </td>
              <td class="r">{fmtNum(l.files)}</td>
              <td class="r">{fmtNum(l.lines)}</td>
              <td class="r" style={{ fontWeight: 600 }}>{Math.round(l.ratio * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="muted" style={{ fontSize: '11.5px', marginTop: '8px' }}>비율은 줄 수 기준 · 제외한 파일 {fmtNum(r.stats.excludedFiles)}개는 빠짐</div>
    </div>
  );
}

function DbPopover(props: { r: AnalysisResult; onOpenFile: (fileId: string, line?: number) => void }) {
  const r = props.r;
  const files = new Map(r.files.map((f) => [f.id, f]));
  return (
    <div class="popover" role="dialog" aria-label="사용 DB 상세" style={{ width: '420px' }}>
      {!r.databases.length && (
        <div class="muted" style={{ fontSize: '13px', lineHeight: 1.6 }}>
          DB를 찾지 못했습니다. 접속 설정 파일(properties·xml·yml·.env)과 드라이버 의존성을 확인했습니다.
        </div>
      )}
      {r.databases.map((d, i) => (
        <div key={d.type} style={{ marginTop: i ? '14px' : 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div class="pop-title" style={{ marginBottom: 0 }}>
            <span class="brand-logo" style={{ width: '28px', height: '28px', background: 'var(--acc-bg)', color: 'var(--acc)' }}>
              <Icon name="db" size={16} color="var(--acc)" />
            </span>
            <b style={{ fontSize: '16px' }}>{d.type}</b>
            <ConfTag c={d.confidence} />
          </div>
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <b style={{ fontSize: '12.5px' }}>판별 근거</b>
            <span class="muted" style={{ fontSize: '12px' }}>{d.evidence.length}건</span>
          </div>
          {d.evidence.slice(0, 5).map((e, k) => {
            const f = files.get(e.file);
            return (
              <button type="button" key={k} class="evi-item" onClick={() => props.onOpenFile(e.file, e.line)}>
                <Icon name="file" size={14} color="var(--icon)" />
                <span class="grow">
                  <span class="a">{f?.name ?? e.file}:{e.line}</span>
                  {e.text && <span class="b" style={{ display: 'block' }}>{e.text}</span>}
                </span>
                <Icon name="chev_right" size={14} color="var(--faint)" />
              </button>
            );
          })}
          {d.access.length > 0 && (
            <>
              <b style={{ fontSize: '12.5px', marginTop: '4px' }}>데이터 접근 방식</b>
              <div class="chips">
                {d.access.map((a) => (
                  <span class="chip" key={a} style={{ height: '28px' }}>
                    {a.replace(/\s*\(추정\)$/, '')}
                    {/\(추정\)$/.test(a) && <Tag tone="warn">추정</Tag>}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
