// 항목 상세: 화면(SCR-05) · 테이블(SCR-06) · 메뉴(SCR-07) · 배치(SCR-13)
import { AskClaude } from '../desktop/AskClaude';
import { useMemo, useState } from 'preact/hooks';
import type { Crud, FlowStep, Layer } from '../../engine/types';
import { BatchLink, Card, ConfTag, Crumb, CrudCells, CrudMini, EvidenceLine, FileCell, FileChip, MenuLink, ScreenLink, TableLink, Tag } from '../components/common';
import { useNav } from '../ctx';
import { CRUD_ORDER, FLOW_LABEL, fmtNum, LAYER_LABEL } from '../format';
import { Icon } from '../icons';
import { crudList, groupLabel, menuDepthLabel, menuPath, menuScreens, SOURCE_LABEL, tableOf } from '../model';

// ------------------------------------------------------------------ 공통 조각

function TablesCard(props: { tables: { table: string; crud: Crud[] }[]; title?: string; sub?: string; hideCommonToggle?: boolean }) {
  const { model } = useNav();
  const [hideCommon, setHideCommon] = useState(false);
  const rows = props.tables.filter((t) => !hideCommon || !tableOf(model, t.table)?.common);
  return (
    <Card
      title={props.title ?? '사용 테이블'}
      count={props.tables.length}
      sub={props.sub}
      right={
        props.hideCommonToggle !== false && props.tables.some((t) => tableOf(model, t.table)?.common) ? (
          <label class="row" style={{ gap: '6px', fontSize: '12.5px', color: 'var(--ink2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={hideCommon} onChange={() => setHideCommon(!hideCommon)} style={{ accentColor: 'var(--acc)' }} />
            공통 테이블 숨기기
          </label>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div class="empty-note">사용하는 테이블이 없습니다.</div>
      ) : (
        <div class={`tbl-wrap${rows.length > 12 ? ' scroll' : ''}`}>
          <table class="tbl">
            <thead>
              <tr>
                <th>테이블</th>
                <th>설명</th>
                {CRUD_ORDER.map((c) => (
                  <th class="c" key={c} style={{ width: '34px' }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const tr = tableOf(model, t.table);
                return (
                  <tr key={t.table}>
                    <td>
                      <span class="row" style={{ gap: '6px' }}>
                        <TableLink name={t.table} />
                        {tr?.common && <Tag>공통</Tag>}
                      </span>
                    </td>
                    <td class="ellipsis muted" style={{ fontSize: '12.5px' }}>{tr?.comment ?? ''}</td>
                    <CrudCells crud={t.crud} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Flow(props: { steps: FlowStep[] }) {
  const { openFile, model, nav } = useNav();
  if (!props.steps.length) return <div class="empty-note">호출 흐름을 찾지 못했습니다.</div>;
  return (
    <div class="flow">
      {props.steps.map((s, i) => {
        const last = i === props.steps.length - 1;
        const lines = s.symbol.split('\n');
        return (
          <div key={i} class="row" style={{ gap: 0, alignItems: 'stretch', flex: 'none' }}>
            <div class={`flow-box${s.layer === 'TABLE' ? ' end' : ''}`}>
              <span class="k">{FLOW_LABEL[s.layer] ?? s.layer}</span>
              <span class="v">
                {s.layer === 'TABLE'
                  ? lines.map((l, k) => {
                      const [name, ...rest] = l.split(' ');
                      const t = tableOf(model, name);
                      const crud = rest.join('').replace(/[^CRUD]/g, '').split('') as Crud[];
                      return (
                        <div key={k} class="row" style={{ gap: '5px' }}>
                          {t ? (
                            <button type="button" class="lnk mono" style={{ fontSize: '12px' }} onClick={() => nav({ kind: 'table', id: t.id })}>
                              {name}
                            </button>
                          ) : (
                            name
                          )}
                          {crud.length > 0 && <CrudMini crud={crud} />}
                        </div>
                      );
                    })
                  : lines.map((l, k) =>
                      s.file && k === 0 ? (
                        <div key={k}>
                          <button type="button" class="lnk mono" style={{ fontSize: '12px', fontWeight: 500 }} onClick={() => openFile(s.file!, s.line)}>
                            {l}
                          </button>
                        </div>
                      ) : (
                        <div key={k}>{l}</div>
                      ),
                    )}
              </span>
            </div>
            {!last && (
              <span class="flow-arrow">
                <Icon name="arrow_r" size={16} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoleCard(props: { role: string; confidence: string; evidenceCount?: number; children?: preact.ComponentChildren; sub?: string }) {
  return (
    <section class="card">
      <div class="card-title">
        <h3>역할</h3>
        <ConfTag c={props.confidence as '높음'} />
        {props.sub && <span class="sub">{props.sub}</span>}
        {props.evidenceCount !== undefined && <span class="right muted" style={{ fontSize: '12.5px' }}>근거 {props.evidenceCount}건</span>}
      </div>
      <div class="role-text">{props.role || '역할을 정하지 못했습니다.'}</div>
      {props.children}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = { page: '화면', popup: '팝업', api: 'API' };

// ------------------------------------------------------------------ 화면 상세

export function ScreenDetail(props: { id: string }) {
  const { model, nav, openFile } = useNav();
  const s = model.screenById.get(props.id);
  const [layer, setLayer] = useState<string>('전체');
  const [callIdx, setCallIdx] = useState(0);
  if (!s) return <div class="page"><div class="empty-note">화면을 찾을 수 없습니다.</div></div>;
  const view = s.view ? model.fileById.get(s.view) : undefined;
  const group = model.screenGroups.find((g) => g.group === (s.group || '(기타)'));
  const layers = ['전체', ...Array.from(new Set(s.files.map((f) => f.layer)))];
  const files = s.files.filter((f) => layer === '전체' || f.layer === layer);
  const path = menuPath(model, s.menu);
  const call = s.calls[callIdx];
  return (
    <div class="page">
      <Crumb
        items={[
          { label: '화면' },
          { label: `${group?.label ? `${group.label} ` : ''}${s.group}`, onClick: undefined },
          { label: s.name },
        ]}
      />
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">
            <Icon name="screen" size={22} color="var(--icon)" />
            {s.name}
            <Tag tone="acc">{KIND_LABEL[s.kind] ?? s.kind}</Tag>
            {view && <Tag>{view.lang}</Tag>}
            {s.notInMenu && <Tag tone="warn">메뉴 없음</Tag>}
          </h1>
          <div class="meta" style={{ marginTop: '8px' }}>
            {s.url && (
              <span>
                URL <b class="mono">{s.url}</b>
                {s.urls.length > 1 && <span class="muted"> 외 {s.urls.length - 1}개</span>}
              </span>
            )}
            {path.length > 0 && (
              <span class="row" style={{ gap: '4px' }}>
                소속 메뉴
                {path.map((m, i) => (
                  <span key={m.id} class="row" style={{ gap: '4px' }}>
                    {i > 0 && <span class="faint">›</span>}
                    <MenuLink id={m.id} />
                  </span>
                ))}
              </span>
            )}
            {view && (
              <span>
                화면 파일{' '}
                <button type="button" class="lnk mono" onClick={() => openFile(view.id)}>
                  {view.path.length > 60 ? `…${view.path.slice(-58)}` : view.path}
                </button>
              </span>
            )}
          </div>
        </div>
        <AskClaude target={{ kind: 'screen', id: props.id }} />
      </div>
      <RoleCard role={s.role} confidence={s.confidence} evidenceCount={s.evidence.length}>
        <EvidenceLine items={s.evidence} />
      </RoleCard>
      <div class="grid2 wide-left">
        <Card
          title="관련 파일"
          count={s.files.length}
          right={
            layers.length > 2 ? (
              <div class="seg">
                {layers.map((l) => (
                  <button type="button" key={l} class={layer === l ? 'on' : ''} onClick={() => setLayer(l)}>
                    {l === '전체' ? '전체' : LAYER_LABEL[l as Layer] ?? l}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          <div class={`tbl-wrap${files.length > 12 ? ' scroll' : ''}`}>
            <table class="tbl">
              <thead>
                <tr>
                  <th style={{ width: '96px' }}>계층</th>
                  <th>파일</th>
                  <th>주요 내용</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f, i) => (
                  <tr key={`${f.file}-${i}`}>
                    <td>
                      <Tag>{LAYER_LABEL[f.layer] ?? f.layer}</Tag>
                    </td>
                    <td>
                      <FileCell file={model.fileById.get(f.file)} line={s.flow.find((x) => x.file === f.file)?.line} />
                    </td>
                    <td class="muted" style={{ fontSize: '12.5px', whiteSpace: 'normal' }}>{f.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <TablesCard tables={s.tables} />
      </div>
      <Card
        title="호출 흐름"
        sub="화면에서 테이블까지"
        right={
          s.calls.length > 1 ? (
            <label class="row" style={{ gap: '6px', fontSize: '12.5px' }}>
              요청
              <select class="inp mono" style={{ height: '30px', maxWidth: '320px' }} value={callIdx} onChange={(e) => setCallIdx(Number((e.target as HTMLSelectElement).value))}>
                {s.calls.map((c, i) => (
                  <option key={i} value={i}>
                    {c.url}
                  </option>
                ))}
              </select>
              <span class="muted">{s.calls.length}개 중</span>
            </label>
          ) : undefined
        }
      >
        <Flow steps={s.flow} />
        {call && (
          <div class="row" style={{ marginTop: '12px', flexWrap: 'wrap', fontSize: '12.5px' }}>
            <Tag>{call.kind}</Tag>
            <span class="mono">{call.url}</span>
            {call.handler && <span class="muted">→ {call.handler}</span>}
            {call.tables.map((t) => (
              <span key={t.table} class="row" style={{ gap: '4px' }}>
                <TableLink name={t.table} />
                <CrudMini crud={t.crud} />
              </span>
            ))}
            {!call.handler && <Tag tone="warn">처리 코드 못 찾음</Tag>}
          </div>
        )}
      </Card>
      {s.menu === undefined && s.notInMenu && (
        <div class="muted" style={{ fontSize: '12px' }}>
          메뉴에 연결되지 않은 화면입니다. 팝업·상세 화면이거나 메뉴 데이터가 DB에만 있을 수 있습니다.{' '}
          <button type="button" class="lnk" onClick={() => nav({ kind: 'summary' })}>요약으로</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 테이블 상세

export function TableDetail(props: { id: string }) {
  const { model, nav, openFile } = useNav();
  const t = model.tableById.get(props.id);
  const sqls = useMemo(() => (t ? model.sqlByTable.get(t.name.toUpperCase()) ?? [] : []), [t, model]);
  if (!t) return <div class="page"><div class="empty-note">테이블을 찾을 수 없습니다.</div></div>;
  const ddlFile = t.ddl ? model.fileById.get(t.ddl.file) : undefined;
  const db = model.r.databases[0]?.type;
  // 파일별 SQL 수
  const perFile = new Map<string, Map<string, number>>();
  for (const q of sqls) {
    const m = perFile.get(q.file) ?? new Map<string, number>();
    m.set(q.kind.toUpperCase(), (m.get(q.kind.toUpperCase()) ?? 0) + 1);
    perFile.set(q.file, m);
  }
  const fileNote = (fid: string) => {
    const f = model.fileById.get(fid);
    const m = perFile.get(fid);
    const counts = m ? [...m.entries()].map(([k, n]) => `${k} ${n}`).join(' · ') : '';
    return [f ? LAYER_LABEL[f.layer] : '', counts].filter(Boolean).join(' ');
  };
  return (
    <div class="page">
      <Crumb items={[{ label: 'DB 테이블' }, { label: t.name }]} />
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">
            <Icon name="table" size={22} color="var(--icon)" />
            <span class="mono" style={{ fontWeight: 700 }}>{t.name}</span>
            {t.comment && <span style={{ fontWeight: 600 }}>{t.comment}</span>}
            <Tag tone="acc">테이블</Tag>
            {db && <Tag>{db}</Tag>}
            {t.common && <Tag>공통</Tag>}
            {t.unlinked && <Tag tone="err">미연결</Tag>}
            {t.fromSqlOnly && <Tag tone="warn">DDL 없음</Tag>}
          </h1>
          <div class="meta" style={{ marginTop: '8px' }}>
            {ddlFile ? (
              <span>
                DDL{' '}
                <button type="button" class="lnk mono" onClick={() => openFile(ddlFile.id, t.ddl!.line)}>
                  {ddlFile.path}
                </button>
              </span>
            ) : (
              <span>DDL 없음 (SQL에서만 보임)</span>
            )}
            <span>컬럼 {t.columns.length}개</span>
            <span>SQL {sqls.length}개에서 사용</span>
            <span>함께 쓰는 테이블 {t.joinsWith.length}개</span>
          </div>
        </div>
        <AskClaude target={{ kind: 'table', id: props.id }} />
      </div>
      <RoleCard role={t.role} confidence={t.roleConfidence}>
        {t.ddl && <EvidenceLine items={[{ ...t.ddl, text: t.comment ? `DDL COMMENT '${t.comment}'` : 'CREATE TABLE' }]} />}
      </RoleCard>
      <div class="grid2">
        <Card title="컬럼" count={t.columns.length} right={t.columns.length ? <Tag tone="ok">DDL 기준</Tag> : undefined}>
          {t.columns.length === 0 ? (
            <div class="empty-note">DDL이 없어 컬럼을 알 수 없습니다.</div>
          ) : (
            <div class={`tbl-wrap${t.columns.length > 14 ? ' scroll' : ''}`}>
              <table class="tbl">
                <thead>
                  <tr>
                    <th>컬럼</th>
                    <th>타입</th>
                    <th class="c" style={{ width: '48px' }}>키</th>
                    <th>설명</th>
                  </tr>
                </thead>
                <tbody>
                  {t.columns.map((c) => (
                    <tr key={c.name}>
                      <td class="mono" style={{ fontSize: '12.5px', fontWeight: 500 }}>{c.name}</td>
                      <td class="mono muted" style={{ fontSize: '12px' }}>{c.type ?? ''}</td>
                      <td class="c">{c.pk ? <Tag tone="acc">PK</Tag> : c.nullable === false ? <span class="faint" style={{ fontSize: '11px' }}>NN</span> : ''}</td>
                      <td class="ellipsis" style={{ fontSize: '12.5px' }} title={c.comment}>{c.comment ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="사용 화면·배치" count={t.usedBy.length} sub="바꾸면 영향 받는 화면과 배치">
          {t.usedBy.length === 0 ? (
            <div class="empty-note">연결된 화면·배치가 없습니다. 외부 연동에서 쓰거나 사용하지 않는 테이블일 수 있습니다.</div>
          ) : (
            <div class={`tbl-wrap${t.usedBy.length > 12 ? ' scroll' : ''}`}>
              <table class="tbl">
                <thead>
                  <tr>
                    <th>화면·배치</th>
                    <th>URL · 실행 파일</th>
                    {CRUD_ORDER.map((c) => (
                      <th class="c" key={c} style={{ width: '34px' }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.usedBy.map((u) => {
                    if (u.kind === 'screen') {
                      const s = model.screenById.get(u.id);
                      return (
                        <tr key={u.id}>
                          <td>
                            <ScreenLink id={u.id} />
                            {s?.kind === 'popup' && <span class="muted" style={{ fontSize: '12px' }}> (팝업)</span>}
                          </td>
                          <td class="mono ellipsis" style={{ fontSize: '12px' }}>{s?.url ?? ''}</td>
                          <CrudCells crud={u.crud} />
                        </tr>
                      );
                    }
                    const b = model.batchById.get(u.id);
                    return (
                      <tr key={u.id}>
                        <td>
                          <span class="row" style={{ gap: '6px' }}>
                            <BatchLink id={u.id} />
                            <Tag>배치</Tag>
                          </span>
                        </td>
                        <td class="mono ellipsis" style={{ fontSize: '12px' }}>{b ? model.fileById.get(b.entry)?.name : ''}</td>
                        <CrudCells crud={u.crud} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <div class="grid2">
        <Card title="관련 파일" count={t.files.length}>
          <div class="chips">
            {t.files.map((fid) => (
              <FileChip key={fid} fileId={fid} note={fileNote(fid)} line={sqls.find((q) => q.file === fid)?.line ?? (t.ddl?.file === fid ? t.ddl.line : undefined)} />
            ))}
            {t.files.length === 0 && <span class="muted">없음</span>}
          </div>
        </Card>
        <Card title="함께 쓰는 테이블" count={t.joinsWith.length} sub="같은 SQL에서 JOIN">
          <div class="chips">
            {t.joinsWith.map((n) => {
              const o = tableOf(model, n);
              return (
                <button type="button" class="chip click" key={n} onClick={() => o && nav({ kind: 'table', id: o.id })}>
                  <span class="mono" style={{ color: 'var(--acc-d)', fontWeight: 600 }}>{o?.name ?? n}</span>
                  {o?.comment && <span class="muted">{o.comment}</span>}
                </button>
              );
            })}
            {t.joinsWith.length === 0 && <span class="muted">없음</span>}
          </div>
        </Card>
      </div>
      {sqls.length > 0 && (
        <Card title="이 테이블을 쓰는 SQL" count={sqls.length}>
          <div class={`tbl-wrap${sqls.length > 10 ? ' scroll' : ''}`}>
            <table class="tbl">
              <thead>
                <tr>
                  <th>파일 · 문장 ID</th>
                  <th style={{ width: '90px' }}>종류</th>
                  {CRUD_ORDER.map((c) => (
                    <th class="c" key={c} style={{ width: '34px' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sqls.slice(0, 200).map((q) => {
                  const f = model.fileById.get(q.file);
                  const crud = crudList(q.tables.filter((x) => x.name.toUpperCase() === t.name.toUpperCase()).map((x) => x.crud));
                  return (
                    <tr key={q.id} class="click" onClick={() => openFile(q.file, q.line, t.name)}>
                      <td>
                        <div class="two">
                          <span class="a">{q.stmtId ?? `${f?.name}:${q.line}`}</span>
                          <span class="b">{f?.name}:{q.line}{q.dynamic ? ' · 동적 SQL' : ''}</span>
                        </div>
                      </td>
                      <td>
                        <Tag mono>{q.kind.toUpperCase()}</Tag>
                      </td>
                      <CrudCells crud={crud} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 메뉴 상세

const LAYER_ORDER: Layer[] = ['VIEW', 'SCRIPT', 'CONTROLLER', 'SERVICE', 'DAO', 'MAPPER', 'MODEL', 'ROUTE', 'OTHER'];

export function MenuDetail(props: { id: string }) {
  const { model, nav, openFile } = useNav();
  const m = model.menuById.get(props.id);
  const [showFiles, setShowFiles] = useState(false);
  if (!m) return <div class="page"><div class="empty-note">메뉴를 찾을 수 없습니다.</div></div>;
  const path = menuPath(model, m.id);
  const kids = model.menuChildren.get(m.id) ?? [];
  const screens = menuScreens(model, m.id);
  const fileSet = new Map<string, Layer>();
  for (const s of screens) for (const f of s.files) fileSet.set(f.file, f.layer);
  const byLayer = new Map<Layer, number>();
  for (const l of fileSet.values()) byLayer.set(l, (byLayer.get(l) ?? 0) + 1);
  const maxLayer = Math.max(1, ...byLayer.values());
  const tables = m.tables.length ? m.tables : aggregate(screens.map((s) => s.tables));
  const topTables = [...tables].sort((a, b) => b.crud.length - a.crud.length).slice(0, 2).map((t) => t.table);
  const writes = tables.some((t) => t.crud.some((c) => c !== 'R'));
  const role = kids.length
    ? `하위 메뉴 ${kids.length}개(${kids.slice(0, 4).map((k) => k.name).join('·')}${kids.length > 4 ? ' 등' : ''})와 화면 ${screens.length}개로 이루어진 메뉴입니다.${topTables.length ? ` ${topTables.join('·')}를 주로 ${writes ? '조회·수정' : '조회'}합니다.` : ''}`
    : screens.length
      ? `${screens.map((s) => s.name).slice(0, 3).join('·')} 화면으로 들어가는 메뉴입니다.${topTables.length ? ` ${topTables.join('·')}를 ${writes ? '조회·수정' : '조회'}합니다.` : ''}`
      : '연결된 화면을 찾지 못한 메뉴입니다. 메뉴 URL과 같은 화면이 없거나 외부 링크일 수 있습니다.';
  const src = m.evidence ? model.fileById.get(m.evidence.file) : undefined;
  return (
    <div class="page">
      <Crumb items={[{ label: '메뉴' }, ...path.map((p, i) => ({ label: p.name, onClick: i < path.length - 1 ? () => nav({ kind: 'menu', id: p.id }) : undefined }))]} />
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">
            <Icon name="menu" size={22} color="var(--icon)" />
            {m.name}
            <Tag tone="acc">{menuDepthLabel(m.depth)}</Tag>
            {m.estimated && <Tag tone="warn">추정</Tag>}
          </h1>
          <div class="meta" style={{ marginTop: '8px' }}>
            <span class="chip" style={{ height: '26px', background: 'var(--ok-bg)', borderColor: 'transparent', color: 'var(--ok)' }}>
              <Icon name="db" size={13} color="var(--ok)" />
              메뉴 출처 {SOURCE_LABEL[m.source]}
              {src && (
                <button type="button" class="lnk mono" style={{ color: 'var(--ok)' }} onClick={() => openFile(src.id, m.evidence!.line)}>
                  {src.name}:{m.evidence!.line}
                </button>
              )}
            </span>
            {m.url && <span>URL <b class="mono">{m.url}</b></span>}
            <span>하위 메뉴 {kids.length}개</span>
            <span>연결 화면 {screens.length}개</span>
            <span>관련 파일 {fileSet.size}개</span>
            <span>사용 테이블 {tables.length}개</span>
          </div>
        </div>
        <AskClaude target={{ kind: 'menu', id: props.id }} />
      </div>
      <RoleCard role={role} confidence={m.estimated ? '낮음' : '보통'} sub={kids.length ? `하위 메뉴 ${kids.length}개의 역할을 묶어 생성` : undefined} />
      <Card title={kids.length ? '하위 메뉴 · 연결 화면' : '연결 화면'} count={kids.length || screens.length} sub="메뉴 화면에서 여는 팝업·하위 화면 포함">
        {kids.length === 0 && screens.length === 0 ? (
          <div class="empty-note">연결된 화면이 없습니다.</div>
        ) : (
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>{kids.length ? '하위 메뉴' : '화면'}</th>
                  <th>{kids.length ? '연결 화면' : '역할'}</th>
                  <th style={{ width: '24%' }}>대표 URL</th>
                  <th class="r" style={{ width: '60px' }}>파일</th>
                  <th class="r" style={{ width: '64px' }}>테이블</th>
                </tr>
              </thead>
              <tbody>
                {kids.length
                  ? kids.map((k) => {
                      const ks = menuScreens(model, k.id);
                      const files = new Set(ks.flatMap((s) => s.files.map((f) => f.file)));
                      const tb = new Set(ks.flatMap((s) => s.tables.map((t) => t.table)));
                      return (
                        <tr key={k.id}>
                          <td><MenuLink id={k.id} /></td>
                          <td class="ellipsis">{ks.map((s) => s.name).join(', ') || <span class="faint">—</span>}</td>
                          <td class="mono ellipsis" style={{ fontSize: '12px' }}>{k.url ?? ks[0]?.url ?? ''}</td>
                          <td class="r">{files.size}</td>
                          <td class="r">{tb.size}</td>
                        </tr>
                      );
                    })
                  : screens.map((s) => (
                      <tr key={s.id}>
                        <td><ScreenLink id={s.id} /></td>
                        <td class="ellipsis muted" style={{ fontSize: '12.5px' }}>{s.role}</td>
                        <td class="mono ellipsis" style={{ fontSize: '12px' }}>{s.url ?? ''}</td>
                        <td class="r">{s.files.length}</td>
                        <td class="r">{s.tables.length}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div class="grid2">
        <TablesCard tables={tables} title="사용 테이블 합계" sub="연결 화면 전체 · 중복 제외" />
        <Card title="관련 파일 요약" count={fileSet.size} sub="계층별 · 중복 제외">
          {fileSet.size === 0 ? (
            <div class="empty-note">관련 파일이 없습니다.</div>
          ) : (
            <>
              <div class="bars">
                {LAYER_ORDER.filter((l) => byLayer.has(l)).map((l) => (
                  <div class="b" key={l}>
                    <span>{LAYER_LABEL[l]}</span>
                    <div class="bar">
                      <i style={{ width: `${(byLayer.get(l)! / maxLayer) * 100}%` }} />
                    </div>
                    <span class="v">{byLayer.get(l)}</span>
                  </div>
                ))}
              </div>
              <button type="button" class="btn sm" style={{ marginTop: '12px' }} onClick={() => setShowFiles(!showFiles)}>
                <Icon name={showFiles ? 'chev_up' : 'chev_down'} size={14} />
                {showFiles ? '목록 접기' : '목록 펼치기'}
              </button>
              {showFiles && (
                <div class="chips" style={{ marginTop: '10px' }}>
                  {[...fileSet.keys()].map((fid) => (
                    <FileChip key={fid} fileId={fid} />
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function aggregate(lists: { table: string; crud: Crud[] }[][]): { table: string; crud: Crud[] }[] {
  const m = new Map<string, Set<Crud>>();
  for (const l of lists) for (const t of l) {
    const s = m.get(t.table) ?? new Set<Crud>();
    t.crud.forEach((c) => s.add(c));
    m.set(t.table, s);
  }
  return [...m.entries()].map(([table, s]) => ({ table, crud: crudList(s) }));
}

// ------------------------------------------------------------------ 배치 상세

const BATCH_KIND: Record<string, string> = {
  shell: '셸 스크립트',
  batch: 'Windows 배치',
  powershell: 'PowerShell',
  python: 'Python 스크립트',
  node: 'Node.js 스크립트',
  'spring-scheduled': 'Spring @Scheduled',
  quartz: 'Quartz',
  'spring-batch': 'Spring Batch',
};

export function BatchDetail(props: { id: string }) {
  const { model, openFile } = useNav();
  const b = model.batchById.get(props.id);
  if (!b) return <div class="page"><div class="empty-note">배치를 찾을 수 없습니다.</div></div>;
  const entry = model.fileById.get(b.entry);
  const ev = b.schedule?.evidence;
  const evFile = ev ? model.fileById.get(ev.file) : undefined;
  return (
    <div class="page">
      <Crumb items={[{ label: '배치' }, { label: b.group }, { label: b.name }]} />
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">
            <Icon name="terminal" size={22} color="var(--icon)" />
            {b.name}
            <Tag tone="acc">배치</Tag>
            <Tag>{BATCH_KIND[b.kind] ?? b.kind}</Tag>
            {!b.schedule && <Tag tone="err">주기 없음</Tag>}
          </h1>
          <div class="meta" style={{ marginTop: '8px' }}>
            {entry && (
              <span>
                실행 파일{' '}
                <button type="button" class="lnk mono" onClick={() => openFile(entry.id)}>
                  {entry.path}
                </button>
              </span>
            )}
            <span>
              실행 주기 <b>{b.schedule?.text ?? '찾지 못함'}</b>
            </span>
            <span>사용 테이블 {b.tables.length}개</span>
            <span>관련 파일 {b.files.length}개</span>
          </div>
        </div>
        {entry && (
          <button type="button" class="btn" onClick={() => openFile(entry.id)}>
            <Icon name="code" size={15} />
            소스 보기
          </button>
        )}
        <AskClaude target={{ kind: 'batch', id: props.id }} />
      </div>
      {!b.schedule && (
        <div class="banner warn">
          <Icon name="info" size={15} />
          이 배치를 실행하는 스케줄 설정을 찾지 못했습니다. 서버의 crontab이나 작업 스케줄러에서 내보낸 파일을 지정하면 실행 주기를 붙입니다.
        </div>
      )}
      <RoleCard role={b.role} confidence={b.confidence} />
      <div class="grid2">
        <Card title="실행 정보">
          <table class="tbl">
            <tbody>
              <tr>
                <td class="muted" style={{ width: '96px' }}>실행 주기</td>
                <td>
                  {b.schedule ? (
                    <span class="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
                      <b>{b.schedule.text}</b>
                      {b.schedule.expr !== b.schedule.text && <span class="mono muted" style={{ fontSize: '12px' }}>{b.schedule.expr}</span>}
                    </span>
                  ) : (
                    <span class="faint">찾지 못함</span>
                  )}
                </td>
              </tr>
              {ev && (
                <tr>
                  <td class="muted">근거</td>
                  <td>
                    <button type="button" class="lnk mono" onClick={() => openFile(ev.file, ev.line)}>
                      {evFile?.name ?? ev.file}:{ev.line}
                    </button>
                    {ev.text && <span class="mono muted" style={{ fontSize: '12px' }}> {ev.text}</span>}
                  </td>
                </tr>
              )}
              <tr>
                <td class="muted">실행 방식</td>
                <td>{BATCH_KIND[b.kind] ?? b.kind}</td>
              </tr>
              <tr>
                <td class="muted">로그</td>
                <td class="mono" style={{ fontSize: '12.5px' }}>{b.logs.length ? b.logs.join(', ') : <span class="faint">없음</span>}</td>
              </tr>
            </tbody>
          </table>
        </Card>
        <TablesCard tables={b.tables} sub="SQL 기준" hideCommonToggle={false} />
      </div>
      <Card title="실행 흐름" sub="스케줄에서 테이블까지">
        <Flow steps={b.flow} />
      </Card>
      <Card title="관련 파일" count={b.files.length}>
        <div class="chips">
          {b.files.map((fid) => (
            <FileChip key={fid} fileId={fid} note={model.fileById.get(fid) ? LAYER_LABEL[model.fileById.get(fid)!.layer] : undefined} />
          ))}
        </div>
      </Card>
    </div>
  );
}

export { fmtNum, groupLabel };
