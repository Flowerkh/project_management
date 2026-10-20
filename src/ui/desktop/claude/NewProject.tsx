// SCR-11 새 프로젝트: 요구사항 → 계획 확정 → 생성 → 분석.
// 고른 빈 폴더에서 AI(기본 AI 또는 고른 AI)가 계획 모드로 요구사항·계획을 정리하고, 본인이 [계획 확정]을 눌러야 파일을 만든다(작업 사본 없음).
// 생성이 끝나면 props.onOpenFolder(폴더)로 앱이 그 폴더를 열어 분석한다. 진행 중에 화면을 떠나도 돌아오면 이어서 본다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AnalysisResult } from '../../../engine/types';
import { AI_LABEL, AI_PROVIDERS, type AiProvider, type ChatItem } from '../../../shared/desktop-api';
import { ConfirmDialog } from '../../components/Dialogs';
import { Icon, Spinner } from '../../icons';
import { listRecent, loadRecent } from '../../recent';
import { AiBadge, chatProvider, providerBlocked, providerEnabled } from '../ai/providers';
import { errText } from '../bridge';
import { useDesk } from '../ctx';
import { msg } from '../messages';
import { Avatar, ChatLog, ErrorBox } from './items';
import type { LinkEnv } from './markdown';
import { baseName, type ItemState, type Plan, parsePlan, planStates, referenceText, stripPlan, techLine } from './plan';
import { useConversation } from './useConversation';
import { hm, ymdhm } from './util';
import './claude.css';

const RESUME_KEY = 'pa.newProject';

interface Resume {
  folder: string;
  conversationId: string;
  refName?: string;
  refAt?: string;
  tech?: string;
  /** 확정한 계획 글 (Claude가 ExitPlanMode로 낸 계획은 확정 뒤 대화에 남지 않아 여기 보관) */
  planText?: string;
}

function readResume(): Resume | null {
  try {
    const v = localStorage.getItem(RESUME_KEY);
    const r = v ? (JSON.parse(v) as Resume) : null;
    return r && typeof r.folder === 'string' && typeof r.conversationId === 'string' ? r : null;
  } catch {
    return null;
  }
}

function writeResume(r: Resume | null) {
  try {
    if (r) localStorage.setItem(RESUME_KEY, JSON.stringify(r));
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    /* 저장소를 쓸 수 없으면 이어 보기만 안 됨 */
  }
}

interface RefOption {
  key: string;
  name: string;
  analyzedAt: string;
  result?: AnalysisResult;
  root?: string;
}

export function NewProjectView(props: { onCancel: () => void; onOpenFolder: (root: string) => void }) {
  const app = useDesk();
  const cv = useConversation(app);
  const conv = cv.conv;
  const [folder, setFolder] = useState<{ path: string; empty: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefOption[] | null>(null);
  const [refKey, setRefKey] = useState('');
  const [refResult, setRefResult] = useState<AnalysisResult | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [input, setInput] = useState('');
  const [askStop, setAskStop] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [autoCancelled, setAutoCancelled] = useState(false);
  /** 확정한 계획 글 */
  const [savedPlan, setSavedPlan] = useState<string | null>(null);
  /** 시작 전에 고른 AI (시작한 뒤에는 그 대화의 AI) */
  const [pickAi, setPickAi] = useState<AiProvider>(() => chatProvider(app));
  const usableAis = AI_PROVIDERS.filter((p) => providerEnabled(app, p) && !providerBlocked(app, p));
  // 고른 AI를 끄면 켜진 AI로
  const pickEff = usableAis.includes(pickAi) ? pickAi : (usableAis[0] ?? pickAi);
  const provider: AiProvider = conv ? (conv.provider ?? 'claude') : pickEff;
  const ai = AI_LABEL[provider];
  const logRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const env: LinkEnv = useMemo(
    () => ({
      model: null,
      openFile: (path) => app.toast(`분석 전이라 아직 소스 뷰어로 볼 수 없습니다: ${path}`),
      nav: () => undefined,
      openExternal: (url) => {
        app.desk.invoke('app.openExternal', url).catch((e) => app.toast(errText(e)));
      },
    }),
    [app.desk],
  );

  // 진행 중이던 새 프로젝트가 있으면 이어서 본다
  useEffect(() => {
    const r = readResume();
    if (r) {
      setResume(r);
      if (r.planText) setSavedPlan(r.planText);
      setFolder({ path: r.folder, empty: true });
      cv.load(r.conversationId).then((c) => {
        if (!c) {
          writeResume(null);
          setResume(null);
          setFolder(null);
          cv.setError(null);
        }
      });
    }
    // 참고할 분석 결과: 지금 연 결과 + 최근 프로젝트
    listRecent()
      .catch(() => [])
      .then((list) => {
        const out: RefOption[] = [];
        const cur = app.result;
        if (cur) out.push({ key: 'current', name: cur.project.name, analyzedAt: cur.project.analyzedAt, result: cur, root: app.root ?? undefined });
        for (const it of list) {
          if (cur && it.name === cur.project.name && it.analyzedAt === cur.project.analyzedAt) continue;
          out.push({ key: it.key, name: it.name, analyzedAt: it.analyzedAt, root: it.root });
        }
        setRefs(out);
        if (!r && out.length) setRefKey(out[0].key);
      });
  }, []);

  // 고른 참고 결과 읽기
  const refOpt = refs?.find((x) => x.key === refKey) ?? null;
  useEffect(() => {
    setRefResult(null);
    if (!refOpt) return;
    if (refOpt.result) {
      setRefResult(refOpt.result);
      return;
    }
    let alive = true;
    loadRecent(refOpt.key).then((r) => alive && setRefResult(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [refKey, refs]);

  const pickFolder = async () => {
    setPicking(true);
    setPickErr(null);
    try {
      const r = await app.desk.invoke('app.pickFolder', '새 프로젝트를 만들 빈 폴더 선택');
      if (r) setFolder(r);
    } catch (e) {
      setPickErr(errText(e));
    } finally {
      setPicking(false);
    }
  };

  // ---------------------------------------------------------------- 대화에서 읽어 낸 상태
  const items: ChatItem[] = conv?.items ?? [];
  const modeIdx = items.findIndex((i) => i.type === 'mode' && i.mode === 'edit');
  const confirmed = !!conv && (conv.mode === 'edit' || modeIdx >= 0);
  const confirmedAt = modeIdx >= 0 ? items[modeIdx].at : undefined;
  const assistants = items.filter((i, idx) => i.type === 'assistant' && (modeIdx < 0 || idx < modeIdx)) as Extract<ChatItem, { type: 'assistant' }>[];
  // 계획 찾기: 확인을 기다리는 계획(ExitPlanMode) → 답변 글 → 확정할 때 보관한 글
  let planMsg: Extract<ChatItem, { type: 'assistant' }> | undefined;
  const pendingPlan = conv?.pending?.kind === 'plan' ? conv.pending.detail : '';
  let plan: Plan | null = pendingPlan ? parsePlan(pendingPlan) : null;
  const planFromPending = !!plan;
  let planText = plan ? pendingPlan : '';
  for (let k = assistants.length - 1; k >= 0 && !plan; k--) {
    const p = parsePlan(assistants[k].text);
    if (p) {
      plan = p;
      planMsg = assistants[k];
      planText = assistants[k].text;
    }
  }
  if (!plan && savedPlan) {
    plan = parsePlan(savedPlan);
    planText = plan ? savedPlan : '';
  }
  const created: string[] = [];
  const createdAt: number[] = [];
  items.forEach((it, idx) => {
    if (it.type !== 'activity' || (modeIdx >= 0 && idx < modeIdx)) return;
    for (const r of it.items)
      if (r.kind === 'edit' && r.file && !created.includes(r.file)) {
        created.push(r.file);
        createdAt.push(Date.parse(it.at));
      }
  });
  const last = items[items.length - 1];
  const running = !!conv?.running;
  const stoppedByError = !!conv && !running && last?.type === 'error';
  const turnEnded = confirmed && !running && !conv?.pending && created.length > 0 && !stoppedByError;
  const total = plan?.total;
  const complete = turnEnded && (!total || created.length >= total);
  const partial = turnEnded && !!total && created.length < total;
  const generating = confirmed && running;
  // 계획을 글에서 못 찾아도(제목 없이 답한 경우) Claude가 답을 마쳤으면 확정할 수 있게
  const lastAnswer = assistants[assistants.length - 1];
  const canConfirm = !confirmed && (!!plan || (!!lastAnswer && !running) || conv?.pending?.kind === 'plan');
  const states = plan ? planStates(plan, created, generating, complete) : [];

  // 계획대로 다 만들었으면 잠시 뒤 바로 분석 (spec: 생성 후 자동 실행)
  useEffect(() => {
    if (!complete || autoCancelled || !folder || !total) {
      setCountdown(null);
      return;
    }
    setCountdown(5);
    const t = setInterval(() => setCountdown((n) => (n === null ? null : n - 1)), 1000);
    return () => clearInterval(t);
  }, [complete, autoCancelled, folder?.path, total]);
  useEffect(() => {
    if (countdown === 0) analyzeNow();
  }, [countdown]);

  const analyzeNow = () => {
    if (!folder) return;
    writeResume(null);
    setCountdown(null);
    props.onOpenFolder(folder.path);
  };

  const refName = refResult?.project.name ?? resume?.refName;
  const tech = refResult ? techLine(refResult) : resume?.tech;

  const sendFirst = async (text: string) => {
    if (!folder) {
      app.toast('먼저 만들 빈 폴더를 골라 주세요.');
      return false;
    }
    if (!folder.empty) return false;
    const references = refResult ? [{ name: refResult.project.name, text: referenceText(refResult, refOpt?.root) }] : undefined;
    const c = await cv.start(folder.path, { newProject: true, references, provider });
    if (!c) return false;
    const r: Resume = { folder: folder.path, conversationId: c.id, refName: refResult?.project.name, refAt: refResult?.project.analyzedAt, tech: refResult ? techLine(refResult) : undefined };
    writeResume(r);
    setResume(r);
    return cv.send(text, c);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || cv.starting) return;
    if (running) {
      app.toast(`${ai}가 작업하는 중입니다. 멈추려면 [중지]를 누르세요.`);
      return;
    }
    setInput('');
    const ok = conv ? await cv.send(text) : await sendFirst(text);
    if (!ok) setInput((cur) => cur || text);
  };

  const confirmPlan = async () => {
    const c = cv.conv;
    if (!c) return;
    setAutoCancelled(false);
    // 확정한 계획을 보관 (생성 중에도 왼쪽 계획 카드에 진행 표시)
    const text = planText || (c.pending?.kind === 'plan' ? c.pending.detail : '');
    if (text) {
      setSavedPlan(text);
      const r = readResume();
      if (r && r.conversationId === c.id) writeResume({ ...r, planText: text });
    }
    if (c.pending?.kind === 'plan') {
      await cv.respond(c.pending.requestId, true);
      return;
    }
    cv.markPlanApproval();
    await cv.setMode('edit');
    await cv.send('계획대로 생성을 시작해 주세요. 고른 폴더에만 파일을 만들어 주세요.');
  };

  const continueRun = () => {
    if (cv.conv) cv.send('멈춘 곳부터 계획대로 이어서 진행해 주세요. 이미 만든 파일은 그대로 두세요.');
  };

  const restart = () => {
    writeResume(null);
    setResume(null);
    cv.clear();
    setFolder(null);
    setInput('');
    setAutoCancelled(false);
  };

  const started = !!conv;
  const folderName = folder ? baseName(folder.path) : '';
  const statusTag = !conv ? null : generating ? (
    <span class="tag acc">생성 중</span>
  ) : complete ? (
    <span class="tag ok">생성 완료</span>
  ) : stoppedByError || partial ? (
    <span class="tag warn">멈춤</span>
  ) : confirmed ? (
    <span class="tag neutral">생성 대기</span>
  ) : (
    <span class="tag neutral">계획 중</span>
  );

  const s1: ItemState = plan || confirmed ? 'done' : 'run';
  const s2: ItemState = confirmed ? 'done' : plan ? 'run' : 'wait';
  const s3: ItemState = complete ? 'done' : confirmed ? 'run' : 'wait';
  const s4: ItemState = complete ? 'run' : 'wait';
  const s3sub = confirmed ? (total ? `파일 ${created.length} / ${total}` : `파일 ${created.length}개`) : '확정 후 시작';
  const s4sub = complete ? (countdown !== null && countdown > 0 ? `${countdown}초 뒤 분석` : '분석 시작을 누르세요') : '생성 후 자동 실행';

  // 남은 시간: 지금까지 파일을 만든 빠르기로 어림 (파일 3개 이상 만든 뒤부터)
  let eta = '';
  if (generating && total && created.length >= 3 && created.length < total) {
    const first = confirmedAt ? Date.parse(confirmedAt) : createdAt[0];
    const lastAt = createdAt[createdAt.length - 1];
    const per = Number.isFinite(first) && Number.isFinite(lastAt) && lastAt > first ? (lastAt - first) / created.length : 0;
    if (per > 0) {
      const min = Math.round(((total - created.length) * per) / 60000);
      eta = min >= 1 ? ` · 약 ${min}분 남음` : ' · 1분 이내';
    }
  }

  // 진행 기록은 아래에 붙어 있을 때만 따라 내려간다
  const lastIt = items[items.length - 1];
  const sig = `${conv?.id}|${items.length}|${lastIt && 'text' in lastIt ? lastIt.text.length : ''}|${lastIt?.type === 'activity' ? lastIt.items.length : ''}|${conv?.pending?.requestId}|${complete}|${countdown !== null}`;
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [sig]);

  return (
    <div class="cp-np">
      <div class="cp-np-title">
        <h2>새 프로젝트</h2>
        {folder && <span class="fd" title={folder.path}>{folderName}</span>}
        {statusTag}
        <span class="at">
          {conv ? `${ymdhm(conv.createdAt)} 시작` : '빈 폴더를 고르고 만들 시스템을 설명해 주세요'}
        </span>
        {started && !running && (
          <button type="button" class="btn sm ghost" onClick={restart} title="이 진행을 닫고 처음부터 (만든 파일은 그대로 남음)">
            처음부터
          </button>
        )}
        <button type="button" class="btn sm" onClick={props.onCancel}>
          처음 화면으로
        </button>
      </div>

      <div class="cp-np-steps" role="list" aria-label="진행 단계">
        <HStep n={1} label="요구사항" state={s1} sub="대화로 정리" />
        <span class={`cp-hline${s1 === 'done' ? ' done' : ''}`} />
        <HStep n={2} label="계획 확정" state={s2} sub={confirmedAt ? `${hm(confirmedAt)} 확정` : plan ? '확정을 기다림' : '계획을 세운 뒤'} />
        <span class={`cp-hline${s2 === 'done' ? ' done' : ''}`} />
        <HStep n={3} label="생성" state={s3} sub={s3sub} />
        <span class={`cp-hline${s3 === 'done' ? ' done' : ''}`} />
        <HStep n={4} label="분석" state={s4} sub={s4sub} />
      </div>

      <div class="cp-np-cols">
        <div class="cp-np-left">
          {/* 프로젝트 정보 */}
          <section class="cp-np-card" aria-label="프로젝트 정보">
            <div class="cp-np-card-t">
              <h3>프로젝트 정보</h3>
            </div>
            <div class="cp-info-row">
              <span class="k">만들 폴더</span>
              <span class="v">
                {folder ? (
                  <>
                    <span class="mono">{folder.path}</span>
                    {folder.empty ? <span class="tag ok">빈 폴더</span> : <span class="tag err">비어 있지 않음</span>}
                    {!started && (
                      <button type="button" class="cp-linkbtn" onClick={pickFolder} disabled={picking}>
                        바꾸기
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" class="btn sm" onClick={pickFolder} disabled={picking}>
                    {picking ? <Spinner size={13} /> : <Icon name="folder" size={14} />}
                    폴더 선택
                  </button>
                )}
              </span>
            </div>
            {folder && !folder.empty && (
              <div class="cp-inline-err" style={{ margin: '4px 0' }} role="alert">
                <span>{msg('MSG-26')}</span>
                <div class="btns">
                  <button type="button" class="btn sm" onClick={pickFolder}>
                    다른 폴더 선택
                  </button>
                </div>
              </div>
            )}
            {pickErr && <div class="err-text">{pickErr}</div>}
            <div class="cp-info-row">
              <span class="k">참고 결과</span>
              <span class="v">
                {!started ? (
                  refs === null ? (
                    <span class="cp-muted">
                      <Spinner size={12} /> 불러오는 중
                    </span>
                  ) : refs.length ? (
                    <select class="inp" value={refKey} onChange={(e) => setRefKey((e.target as HTMLSelectElement).value)} aria-label="참고할 분석 결과">
                      <option value="">참고 안 함</option>
                      {refs.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name} · {ymdhm(r.analyzedAt).slice(0, 10)} 분석
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span class="cp-muted">최근 분석한 프로젝트가 없습니다</span>
                  )
                ) : refName ? (
                  <span class="mono">{refName}</span>
                ) : (
                  <span class="cp-muted">참고 안 함</span>
                )}
                {(refName && (refResult || resume?.refAt)) && (
                  <span class="cp-muted" style={{ fontSize: '12px', width: '100%' }}>
                    {ymdhm(refResult?.project.analyzedAt ?? resume?.refAt).slice(0, 10)} 분석 · 구조·이름 규칙·공통 테이블을 따름
                  </span>
                )}
              </span>
            </div>
            <div class="cp-info-row">
              <span class="k">AI</span>
              <span class="v">
                <AiBadge provider={provider} size={20} />
                {!started && usableAis.length > 1 ? (
                  <select class="inp" value={pickEff} onChange={(e) => setPickAi((e.target as HTMLSelectElement).value as AiProvider)} aria-label="새 프로젝트를 만들 AI">
                    {usableAis.map((p) => (
                      <option key={p} value={p}>
                        {AI_LABEL[p]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{ai}</span>
                )}
              </span>
            </div>
            <div class="cp-info-row">
              <span class="k">기술</span>
              <span class="v">{tech || <span class="cp-muted">대화로 정함</span>}</span>
            </div>
          </section>

          {/* 요구사항 */}
          <section class="cp-np-card" aria-label="요구사항">
            <div class="cp-np-card-t">
              <h3>
                <Icon name="sparkle" size={15} color="var(--ink2)" />
                요구사항
              </h3>
              <span class="right">{ai}가 대화에서 정리</span>
            </div>
            {plan?.reqs.length ? (
              <ul class="cp-req">
                {plan.reqs.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <div class="cp-req-empty">{started ? `${ai}가 요구사항을 정리하는 중입니다.` : `만들 시스템을 설명하면 ${ai}가 요구사항을 정리해 여기에 보여 줍니다.`}</div>
            )}
            {plan && !confirmed && <div class="cp-req-empty" style={{ marginTop: '6px', fontSize: '12px' }}>고칠 점은 오른쪽 입력창으로 말하면 계획을 다시 세웁니다.</div>}
          </section>

          {/* 계획 */}
          <section class="cp-np-card" aria-label="계획">
            <div class="cp-np-card-t">
              <h3>
                <Icon name="sparkle" size={15} color="var(--ink2)" />
                계획
              </h3>
              <span class="right">
                {confirmed ? (
                  <span class="tag neutral">확정{confirmedAt ? ` · ${hm(confirmedAt)}` : ''}</span>
                ) : canConfirm ? (
                  <button type="button" class="btn sm primary" onClick={confirmPlan} disabled={running && conv?.pending?.kind !== 'plan'}>
                    <Icon name="check" size={13} color="#FFFFFF" sw={2.4} />
                    계획 확정
                  </button>
                ) : null}
              </span>
            </div>
            {plan?.items.length ? (
              <div>
                {plan.items.map((it, i) => {
                  const s = states[i]?.state ?? (confirmed ? 'wait' : 'wait');
                  const pre = !confirmed;
                  return (
                    <div key={i} class={`cp-plan-item${!pre && s === 'wait' ? ' wait' : ''}`}>
                      <span class="ic">
                        {pre ? (
                          <Icon name="chev_right" size={15} color="var(--faint)" sw={2} />
                        ) : s === 'done' ? (
                          <Icon name="check" size={15} color="var(--ok)" sw={2.4} />
                        ) : s === 'run' ? (
                          <Spinner size={15} />
                        ) : (
                          <Icon name="clock" size={15} color="var(--faint)" sw={1.9} />
                        )}
                      </span>
                      <span class="tx">
                        <span class="t">{it.title}</span>
                        {it.sub && <span class="s">{it.sub}</span>}
                      </span>
                      {states[i]?.right && <span class="r">{states[i].right}</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div class="cp-req-empty">
                {lastAnswer && !plan
                  ? `${ai}가 제안한 계획은 오른쪽 진행 기록에 있습니다. 확인한 뒤 [계획 확정]을 누르면 파일을 만들기 시작합니다.`
                  : `${ai}가 계획 모드로 기본 구성·테이블·소스·화면 목록을 만듭니다. 확인한 뒤 [계획 확정]을 눌러야 파일을 만들기 시작합니다.`}
              </div>
            )}
          </section>
        </div>

        <div class="cp-np-right">
          <section class="cp-np-card cp-np-log" aria-label="진행 기록">
            <div class="cp-np-card-t">
              <h3>진행 기록</h3>
              <span class="sub">{ai}와 나눈 대화와 만든 파일</span>
            </div>
            <div
              class="cp-np-log-body"
              role="region"
              aria-label="진행 기록 내용"
              ref={logRef}
              onScroll={() => {
                const el = logRef.current;
                if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
            >
              {cv.loading && (
                <div class="cp-loading">
                  <Spinner size={14} />
                  진행 기록을 불러오는 중
                </div>
              )}
              {!conv && !cv.loading && (
                <div class="cp-msg">
                  <Avatar size={24} provider={provider} />
                  <div class="cp-msg-body cp-np-empty">
                    <span>이렇게 진행합니다.</span>
                    <ol>
                      <li>만들 빈 폴더를 고릅니다. 참고할 분석 결과를 고르면 그 구조·이름 규칙을 따릅니다.</li>
                      <li>만들 시스템을 아래에 적어 보내면 {ai}가 요구사항을 정리하고 계획을 세웁니다(파일은 만들지 않음).</li>
                      <li>계획을 확인하고 [계획 확정]을 누르면 고른 폴더에만 파일을 만듭니다.</li>
                      <li>생성이 끝나면 바로 분석해 결과 요약과 트리를 보여 줍니다.</li>
                    </ol>
                  </div>
                </div>
              )}
              {conv && (
                <ChatLog
                  conv={conv}
                  app={app}
                  env={env}
                  actions={{ respond: cv.respond, confirmPlan, continueRun }}
                  canEdit
                  approvedModes={cv.approved}
                  filesClickable={false}
                  folderName={folderName}
                  textOf={(it) => (it === planMsg ? stripPlan(it.text) || '요구사항과 계획을 왼쪽에 정리했습니다. 확인한 뒤 확정해 주세요.' : it.text)}
                  showPendingPlan={!planFromPending}
                />
              )}
              {generating && (
                <div class="cp-np-prog">
                  <span class="cp-bar">
                    <i style={{ width: `${total ? Math.min(100, Math.round((created.length / total) * 100)) : 30}%` }} />
                  </span>
                  <span class="t">
                    {total ? `파일 ${created.length} / ${total}` : `파일 ${created.length}개`}
                    {eta}
                  </span>
                </div>
              )}
              {(complete || partial) && (
                <div class="cp-np-finish" role="status">
                  <Icon name={complete ? 'check' : 'info'} size={16} color={complete ? 'var(--ok)' : 'var(--warn)'} sw={2.2} />
                  <span class="grow">
                    {complete
                      ? `파일 ${created.length}개를 만들었습니다.${countdown !== null && countdown > 0 ? ` ${countdown}초 뒤 분석을 시작합니다.` : ''}`
                      : `계획한 파일 ${total}개 중 ${created.length}개를 만들고 멈췄습니다.`}
                  </span>
                  {partial && (
                    <button type="button" class="btn sm" onClick={continueRun}>
                      이어서 진행
                    </button>
                  )}
                  {countdown !== null && countdown > 0 && (
                    <button type="button" class="btn sm" onClick={() => setAutoCancelled(true)}>
                      기다리기
                    </button>
                  )}
                  <button type="button" class="btn sm primary" onClick={analyzeNow}>
                    <Icon name="play" size={12} filled color="#FFFFFF" />
                    {countdown !== null && countdown > 0 ? '지금 분석' : '분석 시작'}
                  </button>
                </div>
              )}
              {(cv.starting || cv.progress) && (
                <div class="cp-loading">
                  <Spinner size={14} />
                  대화를 준비하는 중
                </div>
              )}
              {cv.error && <ErrorBox indent={false} text={cv.error} actions={[{ label: '닫기', run: () => cv.setError(null) }]} />}
            </div>
          </section>

          <div class="cp-np-input">
            <div class="box">
              <textarea
                class="cp-ta"
                rows={1}
                aria-label={started ? '추가 요청' : '만들 프로젝트 설명'}
                placeholder={started ? '추가 요청이나 바꿀 점을 입력하세요' : '만들 시스템을 설명해 주세요. 예: shop-admin과 같은 구조로 고객 문의 관리 화면을 만들어 주세요 (Enter 보내기)'}
                value={input}
                onInput={(e) => {
                  const el = e.target as HTMLTextAreaElement;
                  setInput(el.value);
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {running && (
                <button type="button" class="btn danger cp-stop" onClick={() => setAskStop(true)}>
                  <Icon name="stop" size={12} filled color="var(--err)" />
                  중지
                </button>
              )}
              <button
                type="button"
                class="cp-send"
                aria-label="보내기"
                disabled={!input.trim() || cv.starting || running || (!started && (!folder || !folder.empty))}
                title={!started && !folder ? '먼저 만들 빈 폴더를 골라 주세요' : undefined}
                onClick={send}
              >
                {cv.starting ? <Spinner size={15} color="#8A95A3" /> : <Icon name="send" size={16} color={!input.trim() || running ? '#8A95A3' : '#FFFFFF'} sw={1.9} />}
              </button>
            </div>
            <div class="cp-note">
              <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
              <span>만들 폴더에 바로 생성(작업 사본 없음) · 참고 프로젝트는 읽기만 · 셸 명령은 허용 목록만</span>
            </div>
          </div>
        </div>
      </div>

      {askStop && (
        <ConfirmDialog
          title="생성 중지"
          message={msg('MSG-29')}
          ok="중지"
          danger
          cancel="계속 진행"
          onOk={() => {
            setAskStop(false);
            cv.interrupt();
          }}
          onClose={() => setAskStop(false)}
        />
      )}
    </div>
  );
}

function HStep(props: { n: number; label: string; state: ItemState; sub: string }) {
  return (
    <div class={`cp-hstep ${props.state}`} role="listitem" aria-current={props.state === 'run' ? 'step' : undefined}>
      <span class="c">{props.state === 'done' ? <Icon name="check" size={15} color="var(--ok)" sw={2.4} /> : props.n}</span>
      <span class="tx">
        <span class="l">{props.label}</span>
        <span class="s">{props.sub}</span>
      </span>
    </div>
  );
}
