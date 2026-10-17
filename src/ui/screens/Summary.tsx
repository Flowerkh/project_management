// SCR-04 분석 결과 요약
import { useState } from 'preact/hooks';
import type { AnalysisResult, Issue } from '../../engine/types';
import { ConfTag, EvidenceLine, Tag } from '../components/common';
import { useNav } from '../ctx';
import { fmtDate, fmtDuration, fmtNum } from '../format';
import { Icon } from '../icons';
import type { Target } from '../model';

const TYPE_LABEL: Record<string, string> = { 웹: '웹 애플리케이션' };

function issueTarget(model: ReturnType<typeof useNav>['model'], ref: string): { label: string; target?: Target; file?: string } {
  if (model.tableById.has(ref)) return { label: model.tableById.get(ref)!.name, target: { kind: 'table', id: ref } };
  if (model.screenById.has(ref)) return { label: model.screenById.get(ref)!.name, target: { kind: 'screen', id: ref } };
  if (model.batchById.has(ref)) return { label: model.batchById.get(ref)!.name, target: { kind: 'batch', id: ref } };
  if (model.menuById.has(ref)) return { label: model.menuById.get(ref)!.name, target: { kind: 'menu', id: ref } };
  if (model.fileById.has(ref)) return { label: model.fileById.get(ref)!.path, file: ref };
  const q = model.r.sql.find((s) => s.id === ref);
  if (q) return { label: `${model.fileById.get(q.file)?.name ?? q.file}${q.stmtId ? ` · ${q.stmtId}` : `:${q.line}`}`, file: q.file };
  const t = model.tableByKey.get(ref.toUpperCase());
  if (t) return { label: t.name, target: { kind: 'table', id: t.id } };
  return { label: ref };
}

function IssueRow(props: { issue: Issue }) {
  const { model, nav, openFile } = useNav();
  const [open, setOpen] = useState(false);
  const it = props.issue;
  const first = it.items[0];
  const firstLabel = first ? first.note ?? issueTarget(model, first.ref).label : '';
  return (
    <div>
      <button type="button" class="issue" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="ic-wrap">
          <Icon name="warn" size={16} color="var(--warn)" />
        </span>
        <span class="grow">
          <div class="t">{it.title}</div>
          <div class="d ellipsis">{it.detail ?? (first ? `${firstLabel}${it.items.length > 1 ? ` 외 ${it.items.length - 1}개` : ''}` : '')}</div>
        </span>
        <span class="n">{fmtNum(it.items.length)}</span>
        <Icon name={open ? 'chev_down' : 'chev_right'} size={16} color="var(--faint)" />
      </button>
      {open && (
        <div class="issue-items">
          {it.items.slice(0, 30).map((x, i) => {
            const t = issueTarget(model, x.ref);
            const label = t.label !== x.ref ? t.label : x.note ?? x.ref;
            return (
              <div key={i} class="row" style={{ fontSize: '12.5px' }}>
                {t.target || t.file ? (
                  <button type="button" class="lnk" onClick={() => (t.target ? nav(t.target) : openFile(t.file!))}>
                    {label}
                  </button>
                ) : (
                  <span>{label}</span>
                )}
                {x.note && x.note !== label && <span class="muted ellipsis">{x.note}</span>}
              </div>
            );
          })}
          {it.items.length > 30 && <span class="muted" style={{ fontSize: '12px' }}>외 {it.items.length - 30}개</span>}
        </div>
      )}
    </div>
  );
}

export function Summary(props: { r: AnalysisResult; onSave: () => void; saved: boolean; onExpandCat: (cat: 'table' | 'menu' | 'screen' | 'batch') => void; onLangs: () => void }) {
  const { r } = props;
  const { model, openFile } = useNav();
  const common = r.tables.filter((t) => t.common).length;
  const unlinkedT = r.tables.filter((t) => t.unlinked).length;
  const roots = r.menus.filter((m) => !m.parent).length;
  const menuLinked = r.screens.filter((s) => s.menu).length;
  const notInMenu = r.screens.filter((s) => s.notInMenu).length;
  const withSched = r.batches.filter((b) => b.schedule).length;
  const topLangs = r.languages.slice(0, 2).map((l) => `${l.name} ${fmtNum(l.files)}`).join(' · ');

  return (
    <div class="page">
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">분석 결과 요약</h1>
          <div class="page-sub">
            {r.project.name} · {fmtDate(r.project.analyzedAt)} 분석 · 소요 {fmtDuration(r.project.durationMs)}
          </div>
        </div>
        <button type="button" class="btn" onClick={props.onSave}>
          <Icon name="json" size={15} />
          결과 파일 저장
          {props.saved && <Icon name="check" size={14} color="var(--ok)" />}
        </button>
      </div>

      <section class="card">
        <div class="row" style={{ flexWrap: 'wrap', gap: '6px' }}>
          {r.project.types.map((t) => (
            <Tag key={t} tone="acc" lg>
              {TYPE_LABEL[t] ?? t}
            </Tag>
          ))}
          <ConfTag c={r.project.confidence} />
          <span class="muted" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>시스템 유형</span>
        </div>
        <h2 style={{ margin: '10px 0 6px', fontSize: '19px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {r.project.title || r.project.name}
          {r.project.domainEstimated && <Tag tone="warn">업무 성격 추정</Tag>}
        </h2>
        <div class="role-text">{r.project.summary}</div>
        <div class="muted" style={{ fontSize: '12px', marginTop: '4px' }}>규칙 기반 요약 · AI 요약 꺼짐</div>
        {r.project.evidence.length > 0 && (
          <div class="row" style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--line2)', alignItems: 'flex-start' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', paddingTop: '6px' }}>판별 근거</span>
            <div class="chips">
              {r.project.evidence
                .filter((e, i, arr) => arr.findIndex((x) => x.file === e.file && (x.text ?? '') === (e.text ?? '')) === i)
                .slice(0, 6)
                .map((e, i) => {
                const f = model.fileById.get(e.file);
                return (
                  <button type="button" class="chip click" key={i} onClick={() => openFile(e.file, e.line)} title={f?.path}>
                    <Icon name="file" size={14} color="var(--icon)" />
                    <span class="mono">{f?.name ?? e.file}{e.text ? '' : `:${e.line}`}</span>
                    {e.text && <span class="muted ellipsis" style={{ maxWidth: '220px' }}>{e.text}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {r.project.subProjects.length > 1 && (
          <div class="row" style={{ marginTop: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>하위 프로젝트</span>
            {r.project.subProjects.map((p) => (
              <span class="chip" key={p.id}>
                <span class="mono">{p.root || p.name}</span>
                <span class="muted">{p.types.join('·')}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <div class="grid5">
        <button type="button" class="stat" onClick={() => props.onExpandCat('table')}>
          <span class="lbl">DB 테이블</span>
          <span class="num">{fmtNum(r.tables.length)}</span>
          <span class="sub">공통 {common} · 미연결 {unlinkedT}</span>
        </button>
        <button type="button" class="stat" onClick={() => props.onExpandCat('menu')}>
          <span class="lbl">메뉴</span>
          <span class="num">{fmtNum(r.menus.length)}</span>
          <span class="sub">대메뉴 {roots} · 하위 {r.menus.length - roots}</span>
        </button>
        <button type="button" class="stat" onClick={() => props.onExpandCat('screen')}>
          <span class="lbl">화면</span>
          <span class="num">{fmtNum(r.screens.length)}</span>
          <span class="sub">메뉴 연결 {menuLinked} · 미연결 {notInMenu}</span>
        </button>
        <button type="button" class="stat" onClick={() => props.onExpandCat('batch')}>
          <span class="lbl">배치</span>
          <span class="num">{fmtNum(r.batches.length)}</span>
          <span class="sub">주기 확인 {withSched} · 미연결 {r.batches.length - withSched}</span>
        </button>
        <button type="button" class="stat" onClick={props.onLangs}>
          <span class="lbl">분석 파일</span>
          <span class="num">{fmtNum(r.stats.analyzedFiles)}</span>
          <span class="sub">{topLangs || '—'}{r.languages.length > 2 ? ' 외' : ''}</span>
        </button>
      </div>

      <div class="grid2">
        <section class="card">
          <div class="card-title">
            <h3>기술 구성</h3>
            <span class="sub">계층별 사용 기술</span>
          </div>
          {r.tech.length ? (
            <div class="tbl-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th style={{ width: '96px' }}>계층</th>
                    <th>사용 기술</th>
                    <th class="r" style={{ width: '80px' }}>파일</th>
                  </tr>
                </thead>
                <tbody>
                  {r.tech.map((t, i) => (
                    <tr key={i}>
                      <td>{t.layer}</td>
                      <td style={{ whiteSpace: 'normal' }}>{t.items}</td>
                      <td class="r">{fmtNum(t.files)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div class="empty-note">기술 스택을 판별하지 못했습니다.</div>
          )}
          {r.databases.length > 0 && <EvidenceLine prefix="DB 근거: " items={r.databases[0].evidence} max={2} />}
        </section>
        <section class="card">
          <div class="card-title">
            <h3>확인 필요</h3>
            <span class="cnt">{r.issues.length}</span>
          </div>
          <div class="col" style={{ gap: '8px' }}>
            {r.issues.length === 0 && <div class="empty-note">확인이 필요한 항목이 없습니다.</div>}
            {r.issues.map((it, i) => (
              <IssueRow key={i} issue={it} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
