// SCR-12 작업 이력: 코드 적용·커밋·되돌리기, 쿼리 실행, 운영 조회 기록. 기록은 추가만 되고 지울 수 없다.
// 종류·기간으로 거르고, 오른쪽 상세에서 [변경 보기]·진행 기록·[되돌리기](MSG-27, 불가 MSG-40)·[다시 시도](MSG-25)·[되돌리는 SQL 실행].
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { ENV_LABEL, type FileChange, type HistoryEntry, type QueryCard, type VcsInfo, type WorkCopy } from '../../../shared/desktop-api';
import { Icon, Spinner } from '../../icons';
import { errText, useDeskEvent } from '../bridge';
import { useDesk } from '../ctx';
import { QueryCardView } from '../db/QueryCardView';
import { msg } from '../messages';
import { baseName, Delta, DiffList, dirShort, highlight } from './DiffView';
import { sameRoot } from './impact';
import { Banner, clock, fullTime, isToday, KIND_ICON, KIND_LABEL, reanalyzeAndRecord, shortTime, StatusTag, vcsLabel, WvDialog } from './shared';
import './work.css';

type Filter = 'all' | 'code' | 'query' | 'prod';
type Period = 'today' | '7d' | 'all';

const GROUP: Record<HistoryEntry['kind'], Filter> = { apply: 'code', revert: 'code', commit: 'code', query: 'query', 'prod-select': 'prod', select: 'prod' };
const DAY = 86400000;

function inPeriod(e: HistoryEntry, p: Period): boolean {
  if (p === 'all') return true;
  if (p === 'today') return isToday(e.at);
  return Date.now() - new Date(e.at).getTime() <= 7 * DAY;
}

function sqlKind(sql?: string): string {
  const m = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(\w+)/.exec(sql ?? '');
  return (m?.[1] ?? 'SQL').toUpperCase();
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return '—';
  return ms < 1000 ? `${(ms / 1000).toFixed(1)}초` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초` : `${Math.round(ms / 60000)}분`;
}

const n = (v: number) => v.toLocaleString('ko-KR');

/** 목록 둘째 줄 */
function metaOf(e: HistoryEntry, all: Map<string, HistoryEntry>): string {
  if (e.kind === 'query') {
    const db = e.db ? `${ENV_LABEL[e.db.env]} ${e.db.name}` : '';
    if (e.status === '롤백됨' || (e.expected !== undefined && e.affected !== undefined && e.expected !== e.affected)) return `${sqlKind(e.sql)} · ${db} · 예상 ${n(e.expected ?? 0)}행, 실제 ${n(e.affected ?? 0)}행`;
    return [sqlKind(e.sql), db, e.affected !== undefined ? `${n(e.affected)}행` : '', e.ms !== undefined ? fmtMs(e.ms) : ''].filter(Boolean).join(' · ');
  }
  if (e.kind === 'prod-select' || e.kind === 'select') {
    const db = e.db ? `${ENV_LABEL[e.db.env]} ${e.db.name}` : '';
    return ['SELECT', db, e.affected !== undefined ? `${n(e.affected)}행` : '', e.kind === 'prod-select' ? '확인 후 실행' : ''].filter(Boolean).join(' · ');
  }
  const files = `파일 ${e.files?.length ?? 0}개`;
  if (e.kind === 'revert') {
    const orig = e.revertOf ? all.get(e.revertOf) : undefined;
    const when = orig ? shortTime(orig.at) : /(\d\d-\d\d \d\d:\d\d)에 적용/.exec(e.steps?.[0]?.detail ?? '')?.[1];
    return [files, when ? `${when}에 적용한 변경` : '', e.commit ? `커밋 ${e.commit}` : ''].filter(Boolean).join(' · ');
  }
  if (e.kind === 'commit') return [files, e.commit ? `${e.branch ?? ''} ${e.commit}`.trim() : '', '나중에 다시 시도'].filter(Boolean).join(' · ');
  if (e.vcs === 'none') return `${files} · 형상관리 없음`;
  if (!e.commit) return `${files} · ${e.error ? '커밋 실패' : '커밋 안 함'}`;
  return `${files} · ${e.branch ? `${e.branch} ` : ''}${e.commit} · ${e.pushed ? '푸시함' : '푸시 안 함'}`;
}

export function HistoryView(props: { entryId?: string }) {
  const app = useDesk();
  const desk = app.desk;
  const root = app.root;
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vcs, setVcs] = useState<VcsInfo | null>(null);
  const [pending, setPending] = useState<WorkCopy[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [period, setPeriod] = useState<Period>('7d');
  const [selId, setSelId] = useState<string | undefined>(props.entryId);
  const [convTitles, setConvTitles] = useState<Record<string, string | null>>({});
  const [exporting, setExporting] = useState(false);

  useEffect(() => setSelId(props.entryId), [props.entryId]);

  /** 기록 목록 (기록이 늘 때마다) */
  const loadList = useCallback(async () => {
    if (!root) return;
    try {
      setList(await desk.invoke('history.list', root));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [desk, root]);

  /** 형상관리·적용하지 않은 작업 사본 (처음과 적용·되돌리기 뒤에만: 작업 사본을 훑으므로) */
  const loadMeta = useCallback(async () => {
    if (!root) return;
    const [v, w] = await Promise.all([desk.invoke('vcs.detect', root).catch(() => null), desk.invoke('work.list', root).catch(() => [] as WorkCopy[])]);
    setVcs(v);
    setPending(w.filter((x) => (x.changed ?? 0) > 0).slice(0, 3));
  }, [desk, root]);

  const load = useCallback(async () => {
    await Promise.all([loadList(), loadMeta()]);
  }, [loadList, loadMeta]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadList();
  }, [loadList, app.historyTick]);

  useDeskEvent(desk, (ev) => {
    if ((ev.type === 'history.updated' || ev.type === 'history.added') && sameRoot(ev.root, root)) {
      setList((l) => {
        if (!l) return l;
        const i = l.findIndex((x) => x.id === ev.entry.id);
        if (ev.entry.kind === 'select') return l;
        if (i < 0) return [ev.entry, ...l];
        const next = l.slice();
        next[i] = ev.entry;
        return next;
      });
    }
  });

  const byId = useMemo(() => new Map((list ?? []).map((e) => [e.id, e])), [list]);
  const periodList = useMemo(() => (list ?? []).filter((e) => e.kind !== 'select' && inPeriod(e, period)), [list, period]);
  const counts = useMemo(() => {
    const c = { all: periodList.length, code: 0, query: 0, prod: 0 };
    for (const e of periodList) c[GROUP[e.kind]]++;
    return c;
  }, [periodList]);
  const shown = periodList.filter((e) => filter === 'all' || GROUP[e.kind] === filter);
  const sel = (selId && byId.get(selId)) || shown[0];

  // 선택한 기록의 대화 제목
  useEffect(() => {
    const id = sel?.conversationId;
    if (!id || id in convTitles) return;
    desk.invoke('claude.get', id).then(
      (c) => setConvTitles((t) => ({ ...t, [id]: c?.title ?? null })),
      () => setConvTitles((t) => ({ ...t, [id]: null })),
    );
  }, [sel?.conversationId]);

  const exportCsv = async () => {
    if (!root) return;
    setExporting(true);
    try {
      const p = await desk.invoke('history.exportCsv', root);
      if (p) app.toast(msg('MSG-44', { n: 1, 위치: p }));
    } catch {
      app.toast(msg('MSG-45'));
    } finally {
      setExporting(false);
    }
  };

  if (!root) {
    return (
      <div class="wv-page">
        <HistoryHead />
        <div class="wv-empty">
          <span class="big"><Icon name="clock" size={22} /></span>
          <b>폴더로 연 프로젝트에서 볼 수 있습니다</b>
          <span>작업 이력은 이 PC의 프로젝트 폴더마다 남습니다. ZIP이나 결과 파일로 연 프로젝트는 원본 폴더를 연결한 뒤 다시 열어 주세요.</span>
        </div>
      </div>
    );
  }

  const projectName = app.projectName || baseName(root.replace(/\\/g, '/'));
  const vcsText = vcs && vcs.kind !== 'none' ? (
    <>
      {vcsLabel(vcs.kind)} <span class="mono">{vcs.branch ?? ''}</span>
    </>
  ) : (
    '형상관리 없음'
  );

  return (
    <div class="wv-page">
      <HistoryHead
        sub={
          <>
            <Icon name="git" size={14} color="var(--icon)" />
            <span>{projectName}</span>
            <span class="dot">·</span>
            <span>{vcsText}</span>
            <span class="dot">·</span>
            <span>이 PC에 저장</span>
            <span class="dot">·</span>
            <span>기록은 추가만 가능</span>
          </>
        }
        right={
          <button type="button" class="btn" onClick={exportCsv} disabled={exporting || !list}>
            {exporting ? <Spinner size={14} /> : <Icon name="download" size={15} color="var(--ink2)" />}
            CSV 내보내기
          </button>
        }
      />

      {pending.map((w) => (
        <div key={w.id} class="wv-pending">
          <Icon name="branch" size={15} color="var(--acc-d)" />
          <span class="grow">
            적용하지 않은 변경이 있는 작업 사본 <span class="mono">{baseName(w.path.replace(/\\/g, '/'))}</span> · 파일 {w.changed}개 · {shortTime(w.createdAt)}에 만듦
          </span>
          <button type="button" class="btn" onClick={() => app.openChanges(w.id, w.conversationId)}>변경 검토</button>
        </div>
      ))}

      <div class="wv-filters" role="toolbar" aria-label="종류·기간">
        {(
          [
            ['all', '전체'],
            ['code', '코드'],
            ['query', '쿼리'],
            ['prod', '운영 조회'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" class={`wv-fchip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
            <span class="n">{counts[k]}</span>
          </button>
        ))}
        <span class="grow" />
        <span class="muted" style={{ fontSize: '12.5px' }}>기간</span>
        <div class="wv-seg" role="group" aria-label="기간">
          {(
            [
              ['today', '오늘'],
              ['7d', '7일'],
              ['all', '전체'],
            ] as [Period, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" class={period === k ? 'on' : ''} aria-pressed={period === k} onClick={() => setPeriod(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && !list ? (
        <Banner kind="err" actions={<button type="button" class="btn" onClick={load}>다시 시도</button>}>작업 이력을 불러오지 못했습니다. {error}</Banner>
      ) : !list ? (
        <div class="wv-loading"><Spinner size={14} /> 작업 이력을 불러오는 중</div>
      ) : !list.filter((e) => e.kind !== 'select').length ? (
        <div class="wv-empty">
          <span class="big"><Icon name="clock" size={22} /></span>
          <b>아직 기록이 없습니다</b>
          <span>Claude가 고친 코드를 적용하거나, 쿼리를 실행하거나, 운영 DB를 조회하면 여기에 남습니다.</span>
        </div>
      ) : (
        <div class="wv-hsplit">
          <section class="card wv-list" aria-label="기록 목록">
            <div class="wv-cardtitle">
              <h3>기록 <span class="cnt">{shown.length}</span></h3>
              <span class="right muted">최근 순</span>
            </div>
            {shown.length ? (
              <div class="wv-items" role="listbox" aria-label="기록">
                {shown.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={sel?.id === e.id}
                    class={`wv-item${sel?.id === e.id ? ' sel' : ''}`}
                    onClick={() => setSelId(e.id)}
                    onKeyDown={(ev) => {
                      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
                      ev.preventDefault();
                      const i = shown.findIndex((x) => x.id === e.id) + (ev.key === 'ArrowDown' ? 1 : -1);
                      const next = shown[Math.max(0, Math.min(shown.length - 1, i))];
                      setSelId(next.id);
                      (ev.currentTarget.parentElement?.children[shown.indexOf(next)] as HTMLElement | undefined)?.focus();
                    }}
                  >
                    <span class="r1">
                      <Icon name={KIND_ICON[e.kind]} size={14} color="var(--icon)" />
                      <span class="tm">{shortTime(e.at)}</span>
                      <span class="kd">{KIND_LABEL[e.kind]}</span>
                      <span class="sp" />
                      <StatusTag e={e} small />
                    </span>
                    <span class="ti" title={e.title}>{e.title}</span>
                    <span class="mt" title={metaOf(e, byId)}>{metaOf(e, byId)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div class="empty-note">이 기간에 해당하는 기록이 없습니다.</div>
            )}
          </section>
          {sel ? (
            <Detail key={sel.id} e={sel} byId={byId} convTitle={sel.conversationId ? convTitles[sel.conversationId] : undefined} vcs={vcs} projectName={projectName} onSelect={setSelId} reload={load} />
          ) : (
            <section class="card wv-detail"><div class="empty-note">왼쪽에서 기록을 고르면 자세한 내용을 봅니다.</div></section>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryHead(props: { sub?: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="wv-head">
      <div class="t">
        <div class="t1">
          <Icon name="clock" size={22} color="var(--icon)" sw={1.7} />
          <h1>작업 이력</h1>
        </div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      {props.right}
    </div>
  );
}

function Fact(props: { k: string; children: ComponentChildren; title?: string }) {
  return (
    <div class="wv-fact">
      <span class="k">{props.k}</span>
      <span class="v" title={props.title}>{props.children}</span>
    </div>
  );
}

function SqlBlock(props: { sql: string }) {
  const lines = props.sql.replace(/\r\n/g, '\n').split('\n');
  return (
    <div class="wv-sql" role="region" aria-label="SQL">
      {lines.map((l, i) => (
        <div key={i} class="ln">
          <span class="no">{i + 1}</span>
          <span class="tx">{highlight(l, 'q.sql')}</span>
        </div>
      ))}
    </div>
  );
}

function Detail(props: {
  e: HistoryEntry;
  byId: Map<string, HistoryEntry>;
  convTitle: string | null | undefined;
  vcs: VcsInfo | null;
  projectName: string;
  onSelect: (id: string) => void;
  reload: () => void;
}) {
  const app = useDesk();
  const desk = app.desk;
  const root = app.root!;
  const e = props.e;
  const [diff, setDiff] = useState<{ title: string; changes: FileChange[] | null; focus?: string; error?: string; base?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [card, setCard] = useState<QueryCard | null>(null);

  useDeskEvent(desk, (ev) => {
    if (ev.type === 'db.card' && card && ev.card.id === card.id) setCard(ev.card);
  });

  const code = e.kind === 'apply' || e.kind === 'revert' || e.kind === 'commit';
  const files = e.files ?? [];
  const plus = files.reduce((a, f) => a + f.plus, 0);
  const minus = files.reduce((a, f) => a + f.minus, 0);
  const reanalysis = [...(e.steps ?? [])].reverse().find((s) => s.label === '다시 분석');
  const revertedBy = e.revertedBy ? props.byId.get(e.revertedBy) : undefined;
  const revertOf = e.revertOf ? props.byId.get(e.revertOf) : undefined;
  const failedStep = e.error ? [...(e.steps ?? [])].reverse().find((s) => !s.ok && /커밋|푸시/.test(s.label)) : undefined;
  const verb = e.kind === 'apply' ? '적용' : e.kind === 'revert' ? '되돌림' : e.kind === 'commit' ? '커밋' : e.kind === 'query' ? '실행' : '조회';
  const what = code ? '변경' : e.kind === 'query' ? '쿼리' : '조회';

  const showDiff = async (focus?: string) => {
    setDiff({ title: e.kind === 'revert' ? '되돌린 변경' : '적용할 때의 변경', changes: null, focus });
    try {
      const changes = await desk.invoke('history.diff', root, e.id);
      setDiff({ title: e.kind === 'revert' ? '되돌린 변경' : '적용할 때의 변경', changes, focus });
    } catch (x) {
      setDiff({ title: '적용할 때의 변경', changes: [], error: errText(x) });
    }
  };

  const showDrift = async () => {
    setDiff({ title: '적용한 뒤 바뀐 내용', changes: null });
    try {
      setDiff({ title: '적용한 뒤 바뀐 내용', changes: await desk.invoke('history.drift', root, e.id), base: '적용 직후' });
    } catch (x) {
      setDiff({ title: '적용한 뒤 바뀐 내용', changes: [], error: errText(x) });
    }
  };

  useEffect(() => {
    if (diff?.changes && diff.focus) document.getElementById('wv-focus')?.scrollIntoView({ block: 'start' });
  }, [diff]);

  const revert = async (commit: boolean) => {
    setConfirm(false);
    setBusy('되돌리는 중');
    setErr(null);
    try {
      const r = await desk.invoke('history.revert', root, e.id, { commit });
      if (r.ok && r.historyId) {
        setBlocked(null);
        app.toast(`파일 ${files.length}개를 적용 전 내용으로 되돌렸습니다.`);
        // 본문 대상으로 고른다 (다시 분석하는 동안 화면이 바뀌었다 돌아와도 되돌림 기록이 선택되게)
        props.onSelect(r.historyId);
        app.openHistory(r.historyId);
        props.reload();
        void reanalyzeAndRecord(app, root, r.historyId, null);
      } else if (r.blocked?.length) setBlocked(r.blocked);
      else setErr(r.error ?? '되돌리지 못했습니다');
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy('다시 시도하는 중');
    setErr(null);
    try {
      const r = await desk.invoke('history.retry', root, e.id);
      if (r && !r.error) app.toast(r.status === '푸시됨' ? '커밋하고 푸시했습니다.' : '커밋했습니다.');
      props.reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(null);
    }
  };

  const askClaude = () => {
    const list = (blocked ?? []).map((f) => baseName(f)).join(', ');
    const text = `작업 이력의 '${e.title}' 변경(${fullTime(e.at)} 적용)을 되돌려 주세요. 적용한 뒤 같은 파일이 다시 바뀌어 자동으로 되돌릴 수 없었습니다. 그 뒤의 변경은 살리고 이 변경만 되돌려 주세요. 대상 파일: ${list}`;
    app.openChat(e.conversationId ? { conversationId: e.conversationId, text } : { text });
  };

  const revertSqlCard = async () => {
    setBusy('쿼리 카드를 만드는 중');
    setErr(null);
    try {
      setCard(await desk.invoke('db.card.fromHistory', root, e.id));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(null);
    }
  };

  const convLine = e.conversationId ? ` · Claude 대화${props.convTitle ? ` '${props.convTitle}'` : ''}에서 만든 ${what}` : '';
  const committed = !!e.commit;
  const vcsKind = e.vcs ?? props.vcs?.kind;

  return (
    <section class="card wv-detail" aria-label="기록 정보">
      <div class="wv-dhead">
        <div class="t">
          <div class="r1">
            <span class="tm">{shortTime(e.at)}</span>
            <span class="tag neutral">{KIND_LABEL[e.kind]}</span>
            <StatusTag e={e} />
          </div>
          <h3>{e.title}</h3>
          <span class="sub">{fullTime(e.at)} {verb}{convLine}</span>
        </div>
        {e.conversationId && (
          <button type="button" class="btn" onClick={() => app.openChat({ conversationId: e.conversationId })}>
            <Icon name="chat" size={14} color="var(--ink2)" />
            대화 열기
          </button>
        )}
      </div>

      {code ? (
        <div class="wv-facts">
          <Fact k={e.kind === 'revert' ? '되돌린 위치' : '적용 위치'}>
            <span class="mono">{props.projectName}</span>
            <span class="mu">{vcsKind === 'none' || !vcsKind ? '형상관리 없음' : `${vcsLabel(vcsKind)}${e.branch ? ` · ${e.branch}` : ''}`}</span>
          </Fact>
          <Fact k="커밋">
            {committed ? (
              <>
                <span class="mono">{e.commit}</span>
                <span class="mu">{vcsKind === 'svn' ? '서버에 반영됨' : e.pushed ? '푸시함' : '푸시 안 함'}</span>
              </>
            ) : e.error ? (
              <span style={{ color: 'var(--err)' }}>{failedStep?.label.startsWith('푸시') ? '푸시 실패' : '커밋 실패'}</span>
            ) : (
              <span class="mu">{vcsKind === 'none' ? '형상관리 없음' : '커밋 안 함'}</span>
            )}
          </Fact>
          <Fact k={e.kind === 'revert' ? '되돌린 파일' : '적용 파일'}>
            <b style={{ fontWeight: 700 }}>{files.length}개</b>
            <Delta plus={plus} minus={minus} />
          </Fact>
          {e.kind === 'revert' ? (
            <Fact k="원래 기록">
              {revertOf ? (
                <button type="button" class="wv-link sm" onClick={() => props.onSelect(revertOf.id)}>{shortTime(revertOf.at)} {revertOf.title}</button>
              ) : (
                <span class="mu">—</span>
              )}
            </Fact>
          ) : (
            <Fact k="작업 사본" title={e.workPath}>
              <span class="mono" style={{ color: 'var(--ink2)', fontSize: '12px' }}>{e.workPath ? baseName(e.workPath.replace(/\\/g, '/')) : '—'}</span>
            </Fact>
          )}
          <Fact k={e.kind === 'revert' ? '되돌리기 전 내용' : '적용 전 내용'}>
            {e.kind === 'commit' ? (
              <span class="mu">—</span>
            ) : revertedBy ? (
              <>
                되돌림<span class="mu">{shortTime(revertedBy.at)}</span>
              </>
            ) : (
              <>
                보관됨<span class="mu">{e.kind === 'apply' ? '되돌리기 가능' : '작업 이력에 보관'}</span>
              </>
            )}
          </Fact>
          <Fact k="다시 분석" title={reanalysis?.detail}>
            {reanalysis ? (
              <>
                {clock(reanalysis.at)}
                <span class="mu">{reanalysis.detail ? reanalysis.detail.split(' · ').filter((_, i, a) => i === 0 || i === a.length - 1).join(' · ') : ''}</span>
              </>
            ) : (
              <span class="mu">하지 않음</span>
            )}
          </Fact>
        </div>
      ) : (
        <div class="wv-facts">
          <Fact k="대상 DB">
            {e.db ? (
              <>
                <span class={`tag ${e.db.env === 'prod' ? 'err' : e.db.env === 'qa' ? 'acc' : 'neutral'}`}>{ENV_LABEL[e.db.env]}</span>
                <span class="mono">{e.db.name}</span>
              </>
            ) : (
              '—'
            )}
          </Fact>
          <Fact k="실행 계정">
            <span class="mono">{e.db?.account || '—'}</span>
          </Fact>
          {e.kind === 'query' ? (
            <Fact k="예상 / 실제 행">
              {e.expected !== undefined ? `${n(e.expected)}행` : '—'} / <b style={{ fontWeight: 600, color: e.expected !== undefined && e.affected !== undefined && e.expected !== e.affected ? 'var(--warn)' : undefined }}>{e.affected !== undefined ? `${n(e.affected)}행` : '—'}</b>
            </Fact>
          ) : (
            <Fact k="행 수">{e.affected !== undefined ? `${n(e.affected)}행` : '—'}</Fact>
          )}
          <Fact k="걸린 시간">{fmtMs(e.ms)}</Fact>
          {e.kind === 'query' ? (
            <Fact k="되돌리는 SQL">{e.revertSql ? '보관됨' : <span class="mu">없음</span>}</Fact>
          ) : (
            <Fact k="가린 컬럼" title={(e.maskedColumns ?? []).join(', ')}>
              {e.maskedColumns?.length ? <span class="mono">{e.maskedColumns.join(', ')}</span> : <span class="mu">없음</span>}
            </Fact>
          )}
          <Fact k="확인">{e.kind === 'prod-select' ? '운영 조회 확인 후 실행' : e.db?.env === 'prod' ? 'DB 이름 입력 후 실행' : '확인 창에서 실행'}</Fact>
        </div>
      )}

      {e.status === '롤백됨' && e.kind === 'query' && (
        <Banner kind="warn" actions={e.conversationId ? <button type="button" class="btn" onClick={() => app.openChat({ conversationId: e.conversationId })}>대화 열기</button> : undefined}>
          {msg('MSG-34', { 실제: n(e.affected ?? 0), n: n(e.expected ?? 0) })}
        </Banner>
      )}

      {code && files.length > 0 && (
        <div class="wv-sec">
          <span class="h">{e.kind === 'revert' ? '되돌린 파일' : '적용한 파일'}</span>
          <div class="wv-frows">
            {files.map((f) => (
              <div key={f.path} class="wv-frow" title={f.path}>
                <Icon name="file" size={14} color="var(--icon)" sw={1.7} />
                <span class="nm">{baseName(f.path)}</span>
                <span class="p">{dirShort(f.path)}</span>
                {f.status !== 'modified' && <span class={`tag ${f.status === 'added' ? 'ok' : 'err'}`} style={{ height: '18px', fontSize: '11px' }}>{f.status === 'added' ? '새 파일' : '삭제'}</span>}
                <Delta plus={f.plus} minus={f.minus} />
                {e.kind !== 'commit' && (
                  <button type="button" class="wv-link sm" onClick={() => showDiff(f.path)}>변경 보기</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {e.sql && (
        <div class="wv-sec">
          <span class="h">SQL</span>
          <SqlBlock sql={e.sql} />
        </div>
      )}

      {(e.steps?.length ?? 0) > 0 && (
        <div class="wv-tl">
          <span class="h">진행 기록</span>
          {e.steps!.map((s, i) => {
            const parts = s.ok && s.detail ? s.detail.split(' · ') : [];
            const who = s.ok && parts.length > 1 ? parts[0] : '';
            const note = s.ok ? (parts.length > 1 ? parts.slice(1).join(' · ') : s.detail ?? '') : s.detail ?? '';
            return (
              <div key={i} class="wv-step">
                <span class="rail">
                  <span class={`dot${s.ok ? '' : ' fail'}`}>
                    <Icon name={s.ok ? 'check' : 'close'} size={12} color={s.ok ? 'var(--ok)' : 'var(--err)'} sw={2.6} />
                  </span>
                  {i < e.steps!.length - 1 && <span class="line" />}
                </span>
                <span class="b">
                  <span class="r1">
                    <b>{s.label}{s.ok ? '' : ' 실패'}</b>
                    {who && <span class={`who${/^[0-9a-f]{6,}$|^r\d+$/.test(who) ? ' mono' : ''}`}>{who}</span>}
                    <span class="when">{shortTime(s.at)}</span>
                  </span>
                  {note && <span class={`note${s.ok ? '' : ' err'}`}>{note}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {e.error && code && !committed && failedStep && (
        <Banner kind="err" actions={<button type="button" class="btn primary" disabled={!!busy} onClick={retry}>다시 시도</button>}>{e.error}</Banner>
      )}
      {e.error && code && committed && e.want?.push && !e.pushed && (
        <Banner kind="err" actions={<button type="button" class="btn primary" disabled={!!busy} onClick={retry}>다시 시도</button>}>{e.error}</Banner>
      )}
      {blocked && (
        <Banner
          kind="err"
          actions={
            <>
              <button type="button" class="btn" onClick={showDrift}>차이 보기</button>
              <button type="button" class="btn primary" onClick={askClaude}>Claude에게 요청</button>
            </>
          }
        >
          {msg('MSG-40')}
          <span class="mono" style={{ display: 'block', fontSize: '12px', marginTop: '2px' }}>{blocked.map((f) => baseName(f)).join(', ')}</span>
        </Banner>
      )}
      {err && <Banner kind="err" onClose={() => setErr(null)}>{err}</Banner>}

      {e.kind === 'apply' && (
        <div class="wv-dbar">
          <span class="txt">
            <span class="ic"><Icon name="info" size={14} color="var(--acc-d)" /></span>
            {revertedBy ? (
              <span>
                {shortTime(revertedBy.at)}에 적용 전 내용으로 되돌렸습니다.{' '}
                <button type="button" class="wv-link sm" onClick={() => props.onSelect(revertedBy.id)}>되돌린 기록 보기</button>
              </span>
            ) : (
              <span>
                되돌리면 파일 {files.length}개를 적용 전 내용으로 되돌리고 다시 분석합니다.
                {committed ? ' 커밋한 변경이라 되돌린 내용을 커밋할지 확인 창에서 고릅니다.' : ''}
              </span>
            )}
          </span>
          {busy && <span class="row muted" style={{ fontSize: '12.5px' }}><Spinner size={13} /> {busy}</span>}
          {!revertedBy && (
            <button type="button" class="btn danger" disabled={!!busy} onClick={() => setConfirm(true)}>
              <Icon name="undo" size={14} color="var(--err)" />
              되돌리기
            </button>
          )}
        </div>
      )}
      {e.kind === 'query' && e.revertSql && (
        <div class="wv-dbar">
          <span class="txt">
            <span class="ic"><Icon name="info" size={14} color="var(--acc-d)" /></span>
            <span>Claude가 만든 되돌리는 SQL로 새 쿼리 카드를 만듭니다. 실행은 같은 확인 절차(MSG-32)를 거칩니다.</span>
          </span>
          {busy && <span class="row muted" style={{ fontSize: '12.5px' }}><Spinner size={13} /> {busy}</span>}
          <button type="button" class="btn" disabled={!!busy} onClick={revertSqlCard}>
            <Icon name="undo" size={14} color="var(--ink2)" />
            되돌리는 SQL 실행
          </button>
        </div>
      )}

      {confirm && <RevertDialog n={files.length} canCommit={committed && (vcsKind === 'git' || vcsKind === 'svn')} vcsKind={vcsKind} onOk={revert} onClose={() => setConfirm(false)} />}
      {diff && (
        <WvDialog title={diff.title} icon="code" wide onClose={() => setDiff(null)} label={`${e.title} ${diff.title}`}>
          <div class="muted" style={{ fontSize: '12.5px' }}>
            {e.title} · {fullTime(e.at)} · 읽기 전용{diff.base === '적용 직후' ? ' · 왼쪽 번호 적용 직후 · 오른쪽 번호 지금 원본' : ' · 왼쪽 번호 적용 전 · 오른쪽 번호 적용 후'}
          </div>
          {diff.error ? (
            <Banner kind="err">{diff.error}</Banner>
          ) : !diff.changes ? (
            <div class="wv-loading"><Spinner size={14} /> 불러오는 중</div>
          ) : (
            <DiffList changes={diff.changes} focus={diff.focus} base={diff.base} empty="보관한 적용 전·후 파일이 없어 비교할 수 없습니다." />
          )}
        </WvDialog>
      )}
      {card && (
        <WvDialog title="되돌리는 SQL 실행" icon="db" onClose={() => setCard(null)}>
          <QueryCardView card={card} />
        </WvDialog>
      )}
    </section>
  );
}

/** MSG-27 되돌리기 확인 (커밋한 변경이면 되돌린 내용 커밋 선택) */
function RevertDialog(props: { n: number; canCommit: boolean; vcsKind?: string; onOk: (commit: boolean) => void; onClose: () => void }) {
  const [commit, setCommit] = useState(props.canCommit);
  return (
    <WvDialog
      title="변경 되돌리기"
      icon="undo"
      iconColor="var(--err)"
      onClose={props.onClose}
      foot={
        <>
          <button type="button" class="btn" onClick={props.onClose}>취소</button>
          <button type="button" class="btn danger" onClick={() => props.onOk(props.canCommit && commit)}>되돌리기</button>
        </>
      }
    >
      <div class="msg">{msg('MSG-27', { n: props.n })}</div>
      {props.canCommit && (
        <div class="wv-opts">
          <label class="ck">
            <input type="checkbox" checked={commit} onChange={(ev) => setCommit((ev.target as HTMLInputElement).checked)} />
            <span>
              되돌린 내용 커밋
              <span class="help">{props.vcsKind === 'svn' ? 'SVN은 커밋하면 서버에 바로 반영됩니다' : '되돌린 파일만 현재 브랜치에 커밋 · 푸시는 하지 않음'}</span>
            </span>
          </label>
        </div>
      )}
    </WvDialog>
  );
}
