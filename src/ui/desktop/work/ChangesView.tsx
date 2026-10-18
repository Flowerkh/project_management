// SCR-10 변경 검토: Claude가 작업 사본에서 고친 파일을 보고, 포함할 파일을 골라 원본 폴더에 [적용].
// [적용] → 확인(MSG-08: 적용 후 커밋·커밋 후 푸시) → 적용 → 다시 분석 → 작업 이력(SCR-12). 그사이 원본이 바뀌었으면 멈춤(MSG-31)
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Conversation, FileChange, ProjectSettings, VcsInfo, WorkCopy } from '../../../shared/desktop-api';
import { ConfirmDialog } from '../../components/Dialogs';
import { Icon, Spinner } from '../../icons';
import { errText, useDeskEvent } from '../bridge';
import { useDesk } from '../ctx';
import { msg } from '../messages';
import { baseName, Delta, DiffFile, dirShort } from './DiffView';
import { computeImpact, type Impact, sameRoot } from './impact';
import { Banner, commandsOf, fileReason, fullTime, reanalyzeAndRecord, reasonOf, shortPath, vcsLabel, WvDialog } from './shared';
import './work.css';

interface Loaded {
  work: WorkCopy;
  changes: FileChange[];
  vcs: VcsInfo | null;
  settings: ProjectSettings | null;
  conv: Conversation | null;
}

type BannerState =
  | { kind: 'conflict'; files: string[] }
  | { kind: 'commit'; historyId: string; text: string }
  | { kind: 'err'; text: string };

/** 적용 결과 (다시 분석하는 동안 화면이 바뀌었다 돌아와도 남게) */
const outcomes = new Map<string, { historyId: string; banner?: BannerState }>();

export function ChangesView(props: { workId: string; conversationId?: string }) {
  const app = useDesk();
  const desk = app.desk;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [rerun, setRerun] = useState(true);
  const [dialog, setDialog] = useState<'apply' | 'discard' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerState | null>(() => outcomes.get(props.workId)?.banner ?? null);
  const [dismissConflict, setDismissConflict] = useState(false);

  const load = useCallback(async () => {
    try {
      const work = await desk.invoke('work.get', props.workId);
      if (!work) {
        setError('notfound');
        return;
      }
      const convId = props.conversationId ?? work.conversationId;
      const [changes, vcs, settings, conv] = await Promise.all([
        desk.invoke('work.changes', props.workId),
        desk.invoke('vcs.detect', work.root).catch(() => null),
        desk.invoke('project.get', work.root).catch(() => null),
        convId ? desk.invoke('claude.get', convId).catch(() => null) : Promise.resolve(null),
      ]);
      setData({ work, changes, vcs, settings, conv });
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [desk, props.workId, props.conversationId]);

  useEffect(() => {
    setData(null);
    setError(null);
    setExcluded(new Set());
    setSel(null);
    setBanner(outcomes.get(props.workId)?.banner ?? null);
    load();
  }, [load]);

  // Claude가 사본을 더 고치면 다시 읽는다
  useDeskEvent(desk, (ev) => {
    if (ev.type === 'claude.item' && ev.item.type === 'changes' && ev.item.workId === props.workId) load();
    else if (ev.type === 'claude.state' && ev.workId === props.workId && !ev.running) load();
  });

  const convId = props.conversationId ?? data?.work.conversationId;
  const changes = data?.changes ?? [];
  const usable = changes.filter((c) => !c.blocked);
  const included = usable.filter((c) => !excluded.has(c.path));
  const conflicts = changes.filter((c) => c.conflict).map((c) => c.path);
  const impact: Impact | null = useMemo(() => computeImpact(app.model, changes), [app.model, data]);
  const reason = reasonOf(data?.conv ?? null, props.workId);
  const cmds = commandsOf(data?.conv ?? null);
  const base = data?.work.base;
  const baseRef = base?.kind === 'git' ? base.branch : base?.kind === 'svn' ? base.branch : undefined;
  const vcs = data?.vcs ?? null;
  const vcsKind = vcs?.kind ?? base?.kind ?? 'none';
  const projectName = data?.settings?.name || app.projectName || (data ? baseName(data.work.root.replace(/\\/g, '/')) : '');
  const outcome = outcomes.get(props.workId);

  const toggle = (path: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const focusFile = (path: string) => {
    setSel(path);
    const i = changes.findIndex((c) => c.path === path);
    document.getElementById(`wv-f-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const backToChat = () => app.openChat(convId ? { conversationId: convId } : undefined);

  // ------------------------------------------------------------------ 적용

  const doApply = async (opts: { commit: boolean; push: boolean; title: string }) => {
    if (!data) return;
    const files = included.map((c) => c.path);
    setBusy('적용하는 중');
    try {
      const r = await desk.invoke('work.apply', props.workId, {
        files,
        commit: opts.commit,
        push: opts.push,
        title: opts.title,
        ...(reason ? { message: reason } : {}),
        ...(convId ? { conversationId: convId } : {}),
      });
      setDialog(null);
      if (!r.ok) {
        setDismissConflict(false);
        setBanner({ kind: 'conflict', files: r.conflicts ?? [] });
        await load();
        return;
      }
      const appliedChanges = changes.filter((c) => r.applied.includes(c.path));
      const imp = computeImpact(app.model, appliedChanges);
      const tool = vcsLabel(vcsKind);
      const failed = r.commit && !r.commit.ok ? { what: '커밋', why: r.commit.error ?? '' } : r.push && !r.push.ok ? { what: '푸시', why: r.push.error ?? '' } : null;
      app.toast(`파일 ${r.applied.length}개를 원본 폴더에 적용했습니다.`);
      if (failed) {
        const b: BannerState = { kind: 'commit', historyId: r.historyId!, text: msg('MSG-25', { 도구: tool, '커밋/푸시': failed.what, 사유: failed.why }) };
        outcomes.set(props.workId, { historyId: r.historyId!, banner: b });
        setBanner(b);
      } else {
        outcomes.set(props.workId, { historyId: r.historyId! });
        setBanner(null);
        app.openHistory(r.historyId);
      }
      if (rerun && sameRoot(app.root, data.work.root)) void reanalyzeAndRecord(app, data.work.root, r.historyId!, imp);
      else await load();
    } catch (e) {
      setDialog(null);
      setBanner({ kind: 'err', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const retry = async (historyId: string) => {
    if (!data) return;
    setBusy('다시 시도하는 중');
    try {
      const e = await desk.invoke('history.retry', data.work.root, historyId);
      if (e?.error) {
        const b: BannerState = { kind: 'commit', historyId, text: e.error };
        outcomes.set(props.workId, { historyId, banner: b });
        setBanner(b);
      } else {
        outcomes.set(props.workId, { historyId });
        setBanner(null);
        app.toast(e?.status === '푸시됨' ? '커밋하고 푸시했습니다.' : '커밋했습니다.');
        app.openHistory(historyId);
      }
    } catch (err) {
      setBanner({ kind: 'err', text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  /** MSG-31 [다시 맞추기]: 사본을 새 원본으로 맞추고 Claude에게 다시 고쳐 달라고 요청 */
  const realign = async (files: string[]) => {
    setBusy('작업 사본을 맞추는 중');
    try {
      await desk.invoke('work.refresh', props.workId, files);
      setBanner(null);
      setDismissConflict(true);
      const list = files.map((f) => baseName(f)).join(', ');
      const text = `작업 사본을 만든 뒤 원본 파일이 바뀌어 다음 파일을 새 원본으로 다시 맞췄습니다: ${list}. 아까 고친 내용을 새 원본 기준으로 이 파일들에 다시 적용해 주세요.`;
      app.openChat(convId ? { conversationId: convId, text, send: true } : { text });
      app.toast('작업 사본을 새 원본으로 맞췄습니다. Claude에게 다시 맞춰 달라고 요청했습니다.');
      await load();
    } catch (e) {
      setBanner({ kind: 'err', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setDialog(null);
    setBusy('변경을 버리는 중');
    try {
      await desk.invoke('work.discard', props.workId);
      app.toast('작업 사본의 변경을 버렸습니다.');
      await load();
    } catch (e) {
      setBanner({ kind: 'err', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    if (!data) return;
    try {
      const r = await desk.invoke('app.openPath', data.work.path);
      if (r) app.toast(r);
    } catch (e) {
      app.toast(errText(e));
    }
  };

  // ------------------------------------------------------------------ 화면

  if (error === 'notfound') {
    return (
      <div class="wv-page">
        <Head title="변경 검토" onBack={backToChat} />
        <div class="wv-empty">
          <span class="big"><Icon name="folder" size={22} /></span>
          <b>작업 사본을 찾을 수 없습니다</b>
          <span>지워졌거나 오래되어 정리된 작업 사본입니다. 적용한 변경은 작업 이력에서 볼 수 있습니다.</span>
          <button type="button" class="btn" onClick={() => app.openHistory()}>
            <Icon name="clock" size={15} />
            작업 이력 보기
          </button>
        </div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div class="wv-page">
        <Head title="변경 검토" onBack={backToChat} />
        <Banner kind="err" actions={<button type="button" class="btn" onClick={() => load()}>다시 시도</button>}>
          변경을 불러오지 못했습니다. {error}
        </Banner>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="wv-page">
        <Head title="변경 검토" onBack={backToChat} />
        <div class="wv-loading"><Spinner size={14} /> 작업 사본의 변경을 불러오는 중</div>
      </div>
    );
  }

  const w = data.work;
  const sub = (
    <>
      {data.conv ? <span>Claude 대화 '{data.conv.title}'에서 만든 변경</span> : <span>Claude가 만든 변경</span>}
      <span class="dot">·</span>
      <span>작업 사본 <span class="mono">{baseName(w.path.replace(/\\/g, '/'))}</span></span>
      <span class="dot">·</span>
      <span>{fullTime(w.createdAt)}</span>
    </>
  );
  const applied = !!outcome && !changes.length;
  const showConflict = !dismissConflict && (banner?.kind === 'conflict' ? banner.files : conflicts).length > 0;
  const conflictFiles = banner?.kind === 'conflict' && banner.files.length ? banner.files : conflicts;
  const dirtyIncluded = included.filter((c) => c.dirtyBase).map((c) => c.path);
  const commitText = vcsKind === 'git' ? '커밋·푸시는 확인 창에서 고릅니다.' : vcsKind === 'svn' ? '커밋은 확인 창에서 고릅니다(서버에 바로 반영).' : '형상관리가 없어 원본 폴더에만 적용합니다.';

  return (
    <div class="wv-page">
      <Head title="변경 검토" tag={applied ? <span class="tag ok">적용함</span> : changes.length ? <span class="tag warn">적용 전</span> : undefined} sub={sub} onBack={backToChat} />

      {showConflict && (
        <Banner
          kind="warn"
          actions={
            <>
              <button type="button" class="btn" onClick={() => conflictFiles[0] && focusFile(conflictFiles[0])}>차이 보기</button>
              <button type="button" class="btn primary" disabled={!!busy} onClick={() => realign(conflictFiles)}>다시 맞추기</button>
            </>
          }
        >
          {msg('MSG-31', { n: conflictFiles.length })}
          <span class="mono" style={{ display: 'block', fontSize: '12px', marginTop: '2px' }}>{conflictFiles.map((f) => baseName(f)).join(', ')}</span>
        </Banner>
      )}
      {banner?.kind === 'commit' && (
        <Banner
          kind="err"
          actions={
            <>
              <button type="button" class="btn" onClick={() => app.openHistory(banner.historyId)}>작업 이력 보기</button>
              <button type="button" class="btn primary" disabled={!!busy} onClick={() => retry(banner.historyId)}>다시 시도</button>
            </>
          }
        >
          {banner.text}
        </Banner>
      )}
      {banner?.kind === 'err' && (
        <Banner kind="err" onClose={() => setBanner(null)}>
          {banner.text}
        </Banner>
      )}

      {!changes.length ? (
        <div class="wv-empty">
          <span class="big"><Icon name={applied ? 'check' : 'branch'} size={22} /></span>
          {applied ? (
            <>
              <b>적용을 마쳤습니다</b>
              <span>작업 사본에 남은 변경이 없습니다. 적용한 내용과 진행 기록은 작업 이력에서 볼 수 있습니다.</span>
              <span class="row">
                <button type="button" class="btn" onClick={backToChat}><Icon name="chat" size={15} />대화로 돌아가기</button>
                <button type="button" class="btn primary" onClick={() => app.openHistory(outcome!.historyId)}><Icon name="clock" size={15} color="#fff" />작업 이력 보기</button>
              </span>
            </>
          ) : (
            <>
              <b>작업 사본에 바뀐 파일이 없습니다</b>
              <span>Claude가 대화에서 [수정 진행]으로 고치면 여기에서 바뀐 줄을 보고 적용합니다. 원본 폴더는 적용하기 전까지 그대로입니다.</span>
              <button type="button" class="btn" onClick={backToChat}><Icon name="chat" size={15} />대화로 돌아가기</button>
            </>
          )}
        </div>
      ) : (
        <>
          <section class="card wv-sum" aria-label="변경 요약">
            <div class="it" style={{ flexGrow: 1 }}>
              <span class="lbl"><Icon name="sparkle" size={12} color="var(--muted)" />변경 이유</span>
              <span class="why" title={reason ?? undefined}>{reason ?? 'Claude 대화의 수정'}</span>
            </div>
            <div class="it" style={{ flexGrow: 1.3 }}>
              <span class="lbl">영향 범위</span>
              {impact && (impact.screens.length || impact.tables.length) ? (
                <>
                  <div class="wv-pchips">
                    {impact.screens.slice(0, 4).map((s) => (
                      <button key={s.id} type="button" class="wv-pchip" title={`${s.name} ${s.url ?? ''}`} onClick={() => app.nav({ kind: 'screen', id: s.id })}>{s.name}</button>
                    ))}
                    {impact.screens.length > 4 && <span class="wv-pchip more">화면 {impact.screens.length - 4}개 더</span>}
                    {impact.tables.slice(0, 3).map((t) => {
                      const tr = app.model?.tableByKey.get(t.name.toUpperCase());
                      return (
                        <button key={t.name} type="button" class="wv-pchip mono" title={tr?.comment ?? t.name} onClick={() => tr && app.nav({ kind: 'table', id: tr.id })}>{t.name}</button>
                      );
                    })}
                    {impact.tables.length > 3 && <span class="wv-pchip more">테이블 {impact.tables.length - 3}개 더</span>}
                  </div>
                  <span class="note">화면 {impact.screens.length} · 테이블 {impact.tables.length} · 분석 결과로 계산</span>
                </>
              ) : (
                <span class="note" style={{ fontSize: '12.5px' }}>{app.model ? '바뀐 파일을 쓰는 화면·테이블을 분석 결과에서 찾지 못했습니다' : '분석 결과가 없어 계산하지 못했습니다'}</span>
              )}
            </div>
            <div class="it" style={{ flexGrow: 1.1 }}>
              <span class="lbl">검증</span>
              {cmds.length ? (
                <>
                  {cmds.map((c) => (
                    <div key={c} class="cmd">
                      <span class={`tag ${/실패|오류|error|fail/i.test(c) ? 'err' : /성공|success|ok\b/i.test(c) ? 'ok' : 'neutral'}`}>
                        {/실패|오류|error|fail/i.test(c) ? '실패' : /성공|success|ok\b/i.test(c) ? '성공' : '실행함'}
                      </span>
                      <span class="mono" title={c}>{c.replace(/\s*\(?(성공|실패|success|failed?)[^)]*\)?\s*$/i, '')}</span>
                    </div>
                  ))}
                  <span class="note">작업 사본에서 실행 · 실행 전 확인함</span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: '13px', color: 'var(--ink2)' }}>실행한 명령 없음</span>
                  <span class="note">빌드·테스트는 Claude에게 요청해 작업 사본에서 실행할 수 있습니다</span>
                </>
              )}
            </div>
            <div class="it" style={{ flexGrow: 1 }}>
              <span class="lbl">적용 대상</span>
              <span class="tgt">
                <Icon name="git" size={14} color="var(--icon)" />
                <span class="ellipsis" title={w.root}>{projectName} · {vcsKind === 'none' ? '형상관리 없음' : `${vcsLabel(vcsKind)} ${vcs?.branch ?? base?.branch ?? ''}`}</span>
              </span>
              <span class="note">{vcsKind === 'none' ? '원본 폴더에 적용만 합니다 · 적용 전에는 원본 그대로' : vcsKind === 'svn' ? '커밋은 확인 창에서 선택(서버에 바로 반영) · 적용 전에는 원본 그대로' : '커밋·푸시는 확인 창에서 선택 · 적용 전에는 원본 그대로'}</span>
            </div>
          </section>

          <div class="wv-split">
            <section class="card wv-files" aria-label="변경 파일">
              <div class="wv-cardtitle">
                <h3>변경 파일 <span class="cnt">{changes.length}</span></h3>
                <span class="right">적용에 포함 {included.length} / {changes.length}</span>
              </div>
              <div class="wv-flist">
                {changes.map((c) => {
                  const on = !c.blocked && !excluded.has(c.path);
                  return (
                    <div
                      key={c.path}
                      class={`wv-fitem${sel === c.path ? ' sel' : ''}${on ? '' : ' off'}`}
                      role="button"
                      tabIndex={0}
                      title={c.path}
                      onClick={() => focusFile(c.path)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') focusFile(c.path);
                        if (e.key === ' ' && !c.blocked) {
                          e.preventDefault();
                          toggle(c.path);
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!!c.blocked}
                        aria-label={`${baseName(c.path)} 적용에 포함`}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(c.path)}
                      />
                      <span class="b">
                        <span class="r1">
                          <span class="nm">{baseName(c.path)}</span>
                          <Delta plus={c.plus} minus={c.minus} />
                        </span>
                        <span class="p">{dirShort(c.path)}</span>
                        {(c.status !== 'modified' || c.conflict || c.blocked || c.dirtyBase) && (
                          <span class="tags">
                            {c.status === 'added' && <span class="tag ok">새 파일</span>}
                            {c.status === 'deleted' && <span class="tag err">삭제</span>}
                            {c.conflict && <span class="tag warn">원본 바뀜</span>}
                            {c.dirtyBase && <span class="tag warn">원래 변경 있음</span>}
                            {c.blocked && <span class="tag err">적용 불가</span>}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div class="wv-wc">
                <span class="k">작업 사본</span>
                <span class="path" title={w.path}>{shortPath(w.path)}</span>
                <span class="note">
                  <Icon name="branch" size={12} color="var(--muted)" />
                  {base?.kind === 'none' || !base ? (
                    '만들 때 원본 상태 기준'
                  ) : (
                    <>
                      {base.branch ?? ''} <span class="mono">{base.head ?? ''}</span> 기준 · 만들 때 원본 상태
                    </>
                  )}
                </span>
                {!!w.redacted && <span class="note"><Icon name="lock" size={12} color="var(--muted)" />접속 정보 등 파일 {w.redacted}개는 값을 가림</span>}
                <button type="button" class="wv-link" onClick={openFolder}>탐색기에서 열기</button>
              </div>
            </section>

            <section class="card wv-diff" aria-label="변경 비교">
              <div class="wv-cardtitle" style={{ marginBottom: '10px' }}>
                <h3>변경 비교 <span class="sub">한 줄씩 보기</span></h3>
                <span class="wv-legend">
                  <span><i style={{ background: '#F8D9D5' }} />지운 줄</span>
                  <span><i style={{ background: '#CFEBD8' }} />더한 줄</span>
                  <span>왼쪽 번호 원본 · 오른쪽 번호 작업 사본</span>
                </span>
              </div>
              <div class="wv-blocks">
                {changes.map((c, i) => (
                  <DiffFile
                    key={c.path}
                    id={`wv-f-${i}`}
                    change={c}
                    base={baseRef}
                    included={!c.blocked && !excluded.has(c.path)}
                    onToggle={() => toggle(c.path)}
                    reason={fileReason(data.conv, c.path, props.workId) ?? undefined}
                  />
                ))}
              </div>
            </section>
          </div>

          <div class="wv-bar">
            <label class="ck">
              <input type="checkbox" checked={rerun} onChange={(e) => setRerun((e.target as HTMLInputElement).checked)} />
              적용 후 다시 분석
            </label>
            <span class="txt grow">
              포함한 파일 {included.length}개를 원본 폴더에 적용합니다. {commitText}
            </span>
            {busy && <span class="row muted" style={{ fontSize: '12.5px' }}><Spinner size={13} /> {busy}</span>}
            <button type="button" class="btn danger" disabled={!!busy} onClick={() => setDialog('discard')}>변경 버리기</button>
            <button type="button" class="btn primary" disabled={!!busy || !included.length} onClick={() => setDialog('apply')}>
              <Icon name="check" size={16} color="#fff" />
              적용
            </button>
          </div>
        </>
      )}

      {dialog === 'apply' && (
        <ApplyDialog
          n={included.length}
          vcs={vcs}
          defaults={data.settings?.applyDefaults ?? { commit: false, push: false }}
          dirtyFiles={dirtyIncluded}
          title={data.conv?.title ?? reason ?? 'Claude가 고친 코드'}
          busy={busy === '적용하는 중'}
          onApply={doApply}
          onClose={() => !busy && setDialog(null)}
        />
      )}
      {dialog === 'discard' && (
        <ConfirmDialog title="변경 버리기" message={msg('MSG-28', { n: changes.length })} ok="버리기" danger onOk={discard} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function Head(props: { title: string; tag?: ComponentChildren; sub?: ComponentChildren; onBack: () => void }) {
  return (
    <div class="wv-head">
      <div class="t">
        <div class="t1">
          <Icon name="branch" size={22} color="var(--icon)" sw={1.7} />
          <h1>{props.title}</h1>
          {props.tag}
        </div>
        {props.sub && <div class="sub">{props.sub}</div>}
      </div>
      <button type="button" class="btn" onClick={props.onBack}>
        <Icon name="chat" size={15} color="var(--ink2)" />
        대화로 돌아가기
      </button>
    </div>
  );
}

/** MSG-08 적용 확인: 적용 후 커밋 · 커밋 후 푸시 (SVN은 커밋만, 형상관리 없으면 선택 없음) */
function ApplyDialog(props: {
  n: number;
  vcs: VcsInfo | null;
  defaults: { commit: boolean; push: boolean };
  dirtyFiles: string[];
  title: string;
  busy: boolean;
  onApply: (o: { commit: boolean; push: boolean; title: string }) => void;
  onClose: () => void;
}) {
  const v = props.vcs;
  const kind = v?.kind ?? 'none';
  const usable = kind !== 'none' && !!v?.toolFound && !v?.error;
  const [commit, setCommit] = useState(usable && props.defaults.commit);
  const [push, setPush] = useState(usable && kind === 'git' && props.defaults.commit && props.defaults.push);
  const [title, setTitle] = useState(props.title.slice(0, 120));
  const go = () => props.onApply({ commit: usable && commit, push: usable && kind === 'git' && commit && push, title: title.trim() || props.title });
  const remote = v?.remote?.replace(/^(https?|ssh|git):\/\//, '');
  return (
    <WvDialog
      title="변경 적용"
      icon="check"
      onClose={props.onClose}
      foot={
        <>
          <button type="button" class="btn" onClick={props.onClose} disabled={props.busy}>취소</button>
          <button type="button" class="btn primary" onClick={go} disabled={props.busy || !props.n}>
            {props.busy && <Spinner size={13} color="#fff" />}
            적용
          </button>
        </>
      }
    >
      <div class="msg">{msg('MSG-08', { n: props.n })}</div>
      <div class="field">
        <label for="wv-apply-title">제목 <span class="muted" style={{ fontWeight: 400 }}>작업 이력과 커밋 메시지에 씁니다</span></label>
        <input
          id="wv-apply-title"
          type="text"
          class="inp"
          value={title}
          maxLength={120}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && !props.busy && go()}
        />
      </div>
      <div class="wv-opts">
        {kind === 'none' ? (
          <span class="tiny">형상관리(.git·.svn)가 없는 폴더라 원본 폴더에 적용만 합니다. 적용 전 파일은 작업 이력에 보관합니다.</span>
        ) : !usable ? (
          <span class="tiny" style={{ color: 'var(--warn)' }}>{v?.error ?? `${kind === 'git' ? 'git' : 'svn'} 명령을 찾지 못해 커밋할 수 없습니다.`} 적용은 그대로 됩니다.</span>
        ) : (
          <>
            <label class="ck">
              <input type="checkbox" checked={commit} onChange={(e) => setCommit((e.target as HTMLInputElement).checked)} />
              <span>
                {kind === 'svn' ? '적용 후 커밋' : '적용 후 커밋'}
                <span class="help">
                  {kind === 'svn' ? 'SVN은 커밋하면 서버에 바로 반영됩니다' : `현재 브랜치(${v?.branch ?? '?'})에 커밋 · 적용한 파일만 커밋하고 다른 변경은 섞지 않음`}
                </span>
              </span>
            </label>
            {kind === 'git' && (
              <label class={`ck${commit ? '' : ' dis'}`}>
                <input type="checkbox" checked={commit && push} disabled={!commit} onChange={(e) => setPush((e.target as HTMLInputElement).checked)} />
                <span>
                  커밋 후 푸시
                  <span class="help">원격 저장소{remote ? `(${remote})` : ''}로 올림 · PC에 저장된 Git 로그인 사용</span>
                </span>
              </label>
            )}
          </>
        )}
      </div>
      {usable && commit && props.dirtyFiles.length > 0 && (
        <Banner kind="warn">
          이 파일은 원래 있던 변경도 함께 커밋됩니다: <span class="mono" style={{ fontSize: '12px' }}>{props.dirtyFiles.map((f) => baseName(f)).join(', ')}</span>
        </Banner>
      )}
    </WvDialog>
  );
}
