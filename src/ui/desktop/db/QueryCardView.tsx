// SCR-09 ⑧ 변경 쿼리 카드: Claude가 제안한 SELECT 외 쿼리. 사용자가 [실행] → 확인 창 → 실행(DML은 행 수가 다르면 롤백)
//  확인 창: MSG-32(대상 DB·예상 행 수), 운영(또는 'DB 이름 입력' 환경)은 MSG-33 + DB 이름 입력, DDL·프로시저·예상 행 수 없음은 MSG-41
//  실행 계정이 없으면 [SQL 복사]만 (MSG-39). 롤백되면 MSG-34. 대화(SCR-09)·작업 이력(SCR-12)에서 함께 쓴다.
import { useEffect, useState } from 'preact/hooks';
import { ENV_LABEL, type QueryCard } from '../../../shared/desktop-api';
import { copyText } from '../../format';
import { Icon, Spinner } from '../../icons';
import { type Desk, errText, useDeskEvent } from '../bridge';
import { useDesk } from '../ctx';
import { msg } from '../messages';
import { DbModal, EnvTag, fmtN, fmtSec, QUERY_KIND_LABEL } from './ui';

const RANK: Record<QueryCard['status'], number> = { pending: 0, running: 1, failed: 2, done: 3, rolledback: 3, rejected: 3 };

const STATUS: Record<QueryCard['status'], { label: string; tone: string }> = {
  pending: { label: '실행 전', tone: 'warn' },
  running: { label: '실행 중', tone: 'acc' },
  done: { label: '실행됨', tone: 'ok' },
  rolledback: { label: '롤백됨', tone: 'err' },
  failed: { label: '실패', tone: 'err' },
  rejected: { label: '거부됨', tone: 'neutral' },
};

/** 화면 미리보기(?mock&desk): 다른 미리보기가 대화에 넣은 카드를 가짜 메인 프로세스에 알린다 */
function mockRegister(desk: Desk, card: QueryCard): void {
  const raw = desk as unknown as { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> };
  raw.invoke('mock.db.registerCard', card).catch(() => undefined);
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** 실행 확인 창 (MSG-32 · MSG-33 · MSG-41) */
function ExecConfirm(props: { card: QueryCard; typeName: boolean; onClose: () => void; onRun: (typed?: string) => Promise<string | null> }) {
  const c = props.card;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kind = QUERY_KIND_LABEL[c.kind];
  const noEstimate = c.estimate === undefined;
  const instant = c.irreversible || noEstimate;
  const prod = c.env === 'prod';
  const match = typed.trim() === c.dbName;
  const vars = { 환경: ENV_LABEL[c.env], DB: c.dbName, 종류: kind, n: c.estimate ?? 0 };
  let main: string;
  if (instant) main = msg('MSG-41', vars);
  else if (prod) main = msg('MSG-33', vars);
  else main = msg('MSG-32', vars);
  const title = prod ? '운영 DB 변경' : instant ? '되돌릴 수 없는 쿼리' : '쿼리 실행 확인';
  const danger = prod || instant || props.typeName;

  const run = async () => {
    if (props.typeName && !match) return;
    setBusy(true);
    setErr(null);
    const e = await props.onRun(props.typeName ? typed.trim() : undefined);
    if (e) {
      setErr(e);
      setBusy(false);
    }
  };

  return (
    <DbModal
      title={title}
      icon={danger ? 'warn' : 'db'}
      iconColor={danger ? 'var(--err)' : 'var(--acc)'}
      cls="db-confirm"
      onClose={() => !busy && props.onClose()}
      foot={
        <>
          {err && <span class="err-text" style={{ marginRight: 'auto', maxWidth: '300px' }}>{err}</span>}
          <button type="button" class="btn" onClick={props.onClose} disabled={busy} data-autofocus={props.typeName ? undefined : true}>
            취소
          </button>
          <button type="button" class={`btn ${danger ? 'danger' : 'primary'}`} onClick={run} disabled={busy || (props.typeName && !match)}>
            {busy ? <Spinner size={13} color={danger ? 'var(--err)' : '#fff'} /> : <Icon name="play" size={12} filled color={danger ? 'var(--err)' : '#fff'} />}
            실행
          </button>
        </>
      }
    >
      <div class={`db-facts${prod ? ' prod' : ''}`}>
        <div>
          <span class="db-fk">대상 DB</span>
          <span class="db-fv mono">
            <EnvTag env={c.env} />
            {c.dbName}
          </span>
        </div>
        <div>
          <span class="db-fk">예상 영향 행 수</span>
          <span class={`db-fv${noEstimate ? ' small' : ''}`}>{noEstimate ? '알 수 없음' : `${fmtN(c.estimate!)}행`}</span>
        </div>
        <div>
          <span class="db-fk">종류</span>
          <span class="db-fv small">{kind}</span>
        </div>
      </div>
      <pre class="db-sqlbox">{c.sql}</pre>
      <div class="db-msgtext">{main}</div>
      {prod && !instant && <div class="db-subtext">트랜잭션 안에서 실행해 행 수가 다르면 롤백합니다.</div>}
      {noEstimate && c.estimateNote && !c.irreversible && <div class="db-subtext">예상 행 수를 구하지 못한 이유: {c.estimateNote}</div>}
      {instant && !c.revertSql && <div class="db-subtext">AI가 되돌리는 SQL을 주지 않았습니다. 필요하면 실행 전에 대화에서 요청해 주세요.</div>}
      {props.typeName && (
        <div class="db-typed">
          <label for="db-typed-name">{instant || !prod ? '계속하려면 DB 이름을 입력해 주세요.' : 'DB 이름'}</label>
          <input
            id="db-typed-name"
            class={`inp${match ? ' db-match' : ''}`}
            value={typed}
            placeholder={c.dbName}
            autocomplete="off"
            spellcheck={false}
            data-autofocus
            onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.isComposing && match) {
                e.preventDefault();
                run();
              }
            }}
          />
          <span class="db-hint">
            <b class="mono">{c.dbName}</b>를 똑같이 입력하면 [실행]이 켜집니다.
          </span>
        </div>
      )}
    </DbModal>
  );
}

export function QueryCardView(props: { card: QueryCard; where?: 'chat' | 'history' }) {
  const app = useDesk();
  const [card, setCard] = useState<QueryCard>(props.card);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [typeName, setTypeName] = useState(props.card.env === 'prod');
  const [err, setErr] = useState<string | null>(null);

  // 부모가 넘긴 카드가 새로 오면 따라간다 (뒤처진 상태로는 되돌리지 않음)
  useEffect(() => {
    setCard((cur) => (cur.id !== props.card.id || RANK[props.card.status] >= RANK[cur.status] ? props.card : cur));
  }, [props.card]);

  // 처음 그릴 때 최신 상태 (이미 실행한 카드 등)
  useEffect(() => {
    let off = false;
    app.desk
      .invoke('db.card.get', props.card.id)
      .then((c) => {
        if (off) return;
        if (c) setCard(c);
        else if (app.desk.mock) mockRegister(app.desk, props.card);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [props.card.id]);

  useDeskEvent(app.desk, (ev) => {
    if (ev.type === 'db.card' && ev.card.id === props.card.id) setCard(ev.card);
  });

  const c = card;
  const st = STATUS[c.status];
  const kind = QUERY_KIND_LABEL[c.kind];
  const canRun = c.canExecute && (c.status === 'pending' || c.status === 'failed');

  const copy = async () => {
    const ok = await copyText(c.sql);
    app.toast(ok ? 'SQL을 복사했습니다.' : 'SQL을 복사하지 못했습니다.');
  };

  const openConfirm = async () => {
    setErr(null);
    // 'DB 이름 입력'은 운영과, 규칙에서 그렇게 정한 환경
    let need = c.env === 'prod';
    if (!need && app.root) {
      try {
        const p = await app.desk.invoke('project.get', app.root);
        need = p.dbRules?.[c.env]?.changeMode === 'typeName';
      } catch {
        // 규칙을 못 읽으면 확인 창만
      }
    }
    setTypeName(need);
    setConfirm(true);
  };

  const run = async (typed?: string): Promise<string | null> => {
    try {
      const done = await app.desk.invoke('db.card.execute', c.id, typed);
      setCard(done);
      setConfirm(false);
      return null;
    } catch (e) {
      return errText(e);
    }
  };

  const reject = async () => {
    try {
      setCard(await app.desk.invoke('db.card.reject', c.id));
    } catch (e) {
      setErr(errText(e));
    }
  };

  const r = c.result;
  const tone = c.status === 'done' ? ' done' : c.status === 'rolledback' || c.status === 'failed' ? ' bad' : c.status === 'rejected' ? ' rejected' : '';
  const showOpenChat = !!c.conversationId && (props.where === 'history' || (props.where !== 'chat' && !app.chat));

  return (
    <div class={`db-qcard${tone}`} data-card={c.id}>
      <div class="db-qc-head">
        <Icon name="db" size={16} color={c.status === 'done' ? 'var(--ok)' : c.status === 'pending' ? 'var(--warn)' : 'var(--icon)'} />
        <span class="db-qc-title">변경 쿼리</span>
        <span class={`tag ${st.tone}`}>
          {c.status === 'running' && <Spinner size={11} />}
          {st.label}
        </span>
        <span class="db-qc-meta" title={`${kind} · ${ENV_LABEL[c.env]} ${c.dbName}${c.estimate !== undefined ? ` · 예상 ${fmtN(c.estimate)}행` : ''}`}>
          {kind} · {ENV_LABEL[c.env]}
          <span class="db-qc-dbname">
            {' '}
            <span class="mono">{c.dbName}</span>
          </span>
          {c.estimate !== undefined ? ` · ${fmtN(c.estimate)}행` : ''}
        </span>
        <span class="db-qc-sp" />
        <button type="button" class="btn sm" onClick={copy} title="SQL을 클립보드에 복사">
          <Icon name="copy" size={14} />
          SQL 복사
        </button>
        {canRun && (
          <button type="button" class="btn sm primary" onClick={openConfirm}>
            <Icon name="play" size={12} filled color="#fff" />
            {c.status === 'failed' ? '다시 실행' : '실행'}
          </button>
        )}
      </div>
      {open ? (
        <>
          <pre class="db-qc-pre">{c.sql}</pre>
          {c.description && (
            <div class="db-qc-sub">
              <b>설명</b> {c.description}
            </div>
          )}
          {c.revertSql && (
            <div class="db-qc-sub">
              <b>되돌리는 SQL</b> <span class="mono">{oneLine(c.revertSql)}</span>
            </div>
          )}
          <div class="db-qc-links">
            <button type="button" class="lnk" onClick={() => setOpen(false)}>
              SQL 접기
            </button>
            {c.status === 'pending' && (
              <button type="button" class="lnk muted" onClick={reject} title="이 쿼리를 실행하지 않음으로 표시">
                실행 안 함
              </button>
            )}
          </div>
        </>
      ) : (
        <div class="db-qc-sql">
          <span class="db-qc-s" title={c.sql}>{oneLine(c.sql)}</span>
          <button type="button" class="lnk" onClick={() => setOpen(true)}>
            SQL 보기
          </button>
        </div>
      )}
      {c.status === 'pending' && !c.canExecute && (
        <div class="db-qc-ro" role="note">
          <Icon name="warn" size={14} color="var(--err)" />
          <div>
            {msg('MSG-39', { DB: c.dbName, 종류: kind })}
            <div class="db-qc-acts">
              <button type="button" class="btn sm primary" onClick={() => app.openModal('project')}>
                프로젝트 연결 열기
              </button>
            </div>
          </div>
        </div>
      )}
      {(c.status === 'running' || (c.status === 'pending' && c.canExecute)) && (
        <div class="db-qc-note">
          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
          <span class="db-qc-txt">
            {c.irreversible
              ? `${kind}는 실행하면 바로 확정되어 롤백할 수 없음 · 확인 창에서 한 번 더 확인`
              : c.estimate === undefined
                ? `예상 행 수를 구하지 못해 실행하면 바로 확정됨${c.estimateNote ? ` (${c.estimateNote})` : ''}`
                : 'SELECT가 아니어서 확인 창에서 대상 DB·예상 행 수를 확인한 뒤 실행 · 행 수가 다르면 롤백'}
          </span>
        </div>
      )}
      {c.status === 'done' && r && (
        <div class="db-qc-result ok">
          <Icon name="check" size={14} color="var(--ok)" sw={2.4} />
          실행됨 · {fmtN(r.affected)}행 · {fmtSec(r.ms)}
          {r.historyId && (
            <button type="button" class="lnk" onClick={() => app.openHistory(r.historyId)}>
              작업 이력
            </button>
          )}
        </div>
      )}
      {c.status === 'rolledback' && r && (
        <div class="db-qc-banner" role="alert">
          <Icon name="undo" size={14} color="var(--err)" />
          <span>{msg('MSG-34', { 실제: r.affected, n: r.expected ?? c.estimate ?? 0 })}</span>
          {showOpenChat && (
            <button type="button" class="btn sm" onClick={() => app.openChat({ conversationId: c.conversationId })}>
              대화 열기
            </button>
          )}
        </div>
      )}
      {c.status === 'failed' && (
        <div class="db-qc-result err">
          <Icon name="warn" size={14} color="var(--err)" />
          <span class="flabel">실패</span>
          <span class="db-qc-em" title={r?.error}>{r?.error ?? '실행하지 못했습니다'}</span>
        </div>
      )}
      {c.status === 'rejected' && (
        <div class="db-qc-result muted">
          <Icon name="close" size={13} />
          실행하지 않기로 했습니다
        </div>
      )}
      {err && <div class="err-text">{err}</div>}
      {confirm && <ExecConfirm card={c} typeName={typeName} onClose={() => setConfirm(false)} onRun={run} />}
    </div>
  );
}
