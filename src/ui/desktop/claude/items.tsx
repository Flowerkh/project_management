// 대화 항목 그리기 (SCR-09·SCR-11 공통): 사용자 말풍선, Claude 답변, 작업 내역 묶음, 변경 카드, 쿼리 카드, 모드 전환, 알림·오류, 확인 요청.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { type ChatItem, type ClaudeErrorCode, type Conversation, DEFAULT_RULES, ENV_LABEL, type FileChange, type PendingRequest } from '../../../shared/desktop-api';
import { copyText, fmtNum } from '../../format';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import type { DeskApp } from '../ctx';
import { QueryCardView } from '../db/QueryCardView';
import { MSG, msg } from '../messages';
import { type LinkEnv, Markdown } from './markdown';
import { ERR_MSG, firstTable, hm, maxRowsOf, splitContextBlock } from './util';

type Item<T extends ChatItem['type']> = Extract<ChatItem, { type: T }>;
type Activity = Item<'activity'>;
type Select = Item<'select'>;

export function Avatar(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <span class="cp-avatar" style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true">
      <Icon name="sparkle" size={Math.round(s * 0.58)} color="#FFFFFF" sw={1.8} />
    </span>
  );
}

// ------------------------------------------------------------------ 말풍선·답변

const KIND_LABEL: Record<string, string> = { screen: '화면', table: '테이블', menu: '메뉴', batch: '배치', file: '파일', flow: '흐름', summary: '요약' };

export function UserBubble(props: { item: Item<'user'> }) {
  const b = splitContextBlock(props.item.text);
  const local = props.item.id.startsWith('local:');
  return (
    <div class="cp-user">
      <div class={`cp-bubble${local ? ' local' : ''}`}>{b.text}</div>
      {(b.added.length > 0 || b.removed.length > 0) && (
        <div class="cp-bubble-ctx" title="이 질문과 함께 보낸 맥락 변경">
          {b.added.map((c, i) => (
            <span key={`a${i}`}>
              <Icon name="plus" size={11} color="var(--ok)" sw={2.2} />
              {c.label}
            </span>
          ))}
          {b.removed.map((c, i) => (
            <span key={`r${i}`} title={`${KIND_LABEL[c.kind] ?? ''} 맥락 뺌`}>
              <Icon name="close" size={11} color="var(--err)" sw={2.2} />
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AssistantMsg(props: { item: Item<'assistant'>; env: LinkEnv; text?: string; children?: ComponentChildren }) {
  const text = props.text ?? props.item.text;
  return (
    <div class="cp-msg">
      <Avatar size={24} />
      <div class="cp-msg-body">
        <Markdown text={text} env={props.env} caret={!!props.item.streaming} />
        {props.children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 작업 내역

const ROW_ICON: Record<string, string> = { read: 'file', search: 'search', edit: 'code', command: 'terminal', db: 'db', other: 'info' };
const ONE_VERB: Record<string, string> = { read: '읽음', search: '검색', edit: '수정', command: '명령', db: '조회', other: '작업' };

function baseName(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

function ActivityLine(props: { item: Activity; open: boolean; toggle: () => void; running: boolean; isNew: boolean; env: LinkEnv; filesClickable: boolean }) {
  const { item, isNew } = props;
  const n = item.items.length;
  const kinds = new Set(item.items.map((x) => x.kind));
  const allEdit = n > 0 && kinds.size === 1 && kinds.has('edit');
  const single = kinds.size === 1 ? [...kinds][0] : null;
  // 새 프로젝트: 파일 만들기 ('생성 pom.xml 외 3개', 만드는 중이면 '생성 중')
  const editLike = isNew && (allEdit || n === 0);
  const ic = editLike ? 'plus' : kinds.has('edit') ? 'code' : single ? ROW_ICON[single] : 'file';
  const verb = editLike ? (props.running ? '생성 중' : '생성') : n > 1 ? `작업 ${n}건` : single ? ONE_VERB[single] : '작업';
  // 한 줄짜리는 펼쳐도 같은 내용이면 펼치지 않는다
  const one = item.items[0];
  const more = n > 1 || (n === 1 && !(item.summary.includes(one.label) || (!!one.file && item.summary.includes(baseName(one.file)) && !one.line)));
  return (
    <>
      <button type="button" class={`cp-tl${more ? ' click' : ''}`} onClick={more ? props.toggle : undefined} aria-expanded={more ? props.open : undefined} disabled={!more}>
        {props.running ? <Spinner size={13} /> : <Icon name={ic} size={13} color="var(--icon)" />}
        <span class={`v${props.running ? ' run' : ''}`}>{verb}</span>
        <span class={`g${editLike ? ' mono' : ''}`} title={item.summary}>{item.summary}</span>
        {more && <Icon name={props.open ? 'chev_down' : 'chev_right'} size={13} color="var(--faint)" sw={2} />}
      </button>
      {props.open && more && (
        <div class="cp-tl-rows">
          {item.items.map((r, i) => (
            <div class="cp-tl-row" key={i}>
              <Icon name={r.kind === 'edit' && isNew ? 'plus' : ROW_ICON[r.kind] ?? 'info'} size={12} color="var(--icon)" />
              <span class="l">{r.label}</span>
              {r.file &&
                (props.filesClickable ? (
                  <button type="button" class="f" title={`${r.file}${r.line ? `:${r.line}` : ''} 소스 보기`} onClick={() => props.env.openFile(r.file!, r.line)}>
                    {baseName(r.file)}
                    {r.line ? `:${r.line}` : ''}
                  </button>
                ) : (
                  <span class="f off" title={r.file}>
                    {r.file}
                  </span>
                ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SelectLine(props: { item: Select; open: boolean; toggle: () => void }) {
  const it = props.item;
  const table = firstTable(it.sql);
  return (
    <>
      <button type="button" class="cp-tl click" onClick={props.toggle} aria-expanded={props.open} title={`${it.db} · ${fmtNum(it.ms)}ms`}>
        <Icon name="db" size={13} color="var(--icon)" />
        <span class="v">조회</span>
        <span class="g mono">{table || it.db}</span>
        <span class="x">
          SELECT · {ENV_LABEL[it.env]} DB · {fmtNum(it.rows)}행
        </span>
        <Icon name={props.open ? 'chev_down' : 'chev_right'} size={13} color="var(--faint)" sw={2} />
      </button>
      {it.maskedColumns.length > 0 && (
        <div class="cp-tl-note" title={it.maskedColumns.join(', ')}>
          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
          {msg('MSG-37', { n: it.maskedColumns.length })}
        </div>
      )}
      {props.open && <pre class="cp-tl-sql">{it.sql}</pre>}
    </>
  );
}

export function ToolGroup(props: { items: (Activity | Select)[]; runningId: string | null; isNew: boolean; env: LinkEnv; filesClickable: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(props.defaultOpen ? props.items.map((i) => i.id) : []));
  const toggle = (id: string) =>
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div class="cp-tools">
      {props.items.map((it) =>
        it.type === 'activity' ? (
          <ActivityLine
            key={it.id}
            item={it}
            open={open.has(it.id)}
            toggle={() => toggle(it.id)}
            running={props.runningId === it.id}
            isNew={props.isNew}
            env={props.env}
            filesClickable={props.filesClickable}
          />
        ) : (
          <SelectLine key={it.id} item={it} open={open.has(it.id)} toggle={() => toggle(it.id)} />
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 변경 카드

/** 마지막 변경 카드만 파일별 줄 수를 작업 사본에서 읽어 온다 (예전 카드는 그때 파일 이름만) */
const statCache = new Map<string, FileChange[]>();

export function ChangesCard(props: { item: Item<'changes'>; app: DeskApp; conversationId?: string; latest: boolean }) {
  const { item, app } = props;
  const key = `${item.workId}|${item.id}|${item.files}|${item.plus}|${item.minus}`;
  const [stats, setStats] = useState<FileChange[] | null>(() => statCache.get(key) ?? null);
  useEffect(() => {
    if (item.stats || !props.latest || statCache.has(key) || item.paths.length > 30) return;
    let alive = true;
    app.desk.invoke('work.changes', item.workId).then(
      (r) => {
        statCache.set(key, r);
        if (alive) setStats(r);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [key, props.latest]);
  const byPath = new Map<string, { plus: number; minus: number }>((item.stats ?? stats ?? []).map((c) => [c.path, c]));
  const open = () => app.openChanges(item.workId, props.conversationId);
  return (
    <div class="cp-change">
      <div class="cp-change-h">
        <Icon name="branch" size={16} color="var(--acc-d)" />
        <b>작업 사본 변경</b>
        <span class="n">파일 {fmtNum(item.files)}개</span>
        <Delta plus={item.plus} minus={item.minus} />
        <span class="grow" />
        <button type="button" class="btn primary cp-b30" onClick={open}>
          <Icon name="arrow_r" size={14} color="#FFFFFF" />
          변경 검토
        </button>
      </div>
      {item.paths.length > 0 && (
        <div class="cp-change-files">
          {item.paths.slice(0, 8).map((p) => {
            const st = byPath.get(p);
            return (
              <button type="button" key={p} class="cp-change-file" title={`${p} · 변경 검토에서 보기`} onClick={open}>
                <Icon name="file" size={13} color="var(--icon)" sw={1.7} />
                <span class="nm">{baseName(p)}</span>
                {st && <Delta plus={st.plus} minus={st.minus} />}
              </button>
            );
          })}
          {item.paths.length > 8 && <span class="cp-time">외 {item.paths.length - 8}개</span>}
        </div>
      )}
    </div>
  );
}

export function Delta(props: { plus: number; minus: number }) {
  return (
    <span class="cp-delta">
      {props.plus > 0 && <span class="p">+{fmtNum(props.plus)}</span>}
      {props.minus > 0 && <span class="m">−{fmtNum(props.minus)}</span>}
      {!props.plus && !props.minus && <span class="cp-muted">0</span>}
    </span>
  );
}

// ------------------------------------------------------------------ 오류·알림

export interface ErrAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export function claudeErrActions(app: DeskApp, code: ClaudeErrorCode, message: string): ErrAction[] {
  const recheck: ErrAction = {
    label: '다시 확인',
    primary: code === 'auth' || code === 'missing',
    run: () => {
      app.refreshClaude(true).then(() => app.toast('Claude 연결 상태를 다시 확인했습니다.'));
    },
  };
  if (code === 'auth')
    return [
      {
        label: '터미널에서 로그인',
        run: () => {
          app.desk.invoke('claude.openLogin').then(
            (ok) => app.toast(ok ? '터미널에서 Claude Code 로그인을 마친 뒤 [다시 확인]을 눌러 주세요.' : '터미널을 열지 못했습니다.'),
            (e) => app.toast(errText(e)),
          );
        },
      },
      recheck,
    ];
  if (code === 'offline' || code === 'billing') return [recheck];
  if (code === 'limit') return [{ label: '인증 방식 변경', run: () => app.openModal('claude') }];
  if (code === 'missing')
    return [
      {
        label: '경로 지정',
        run: () => {
          app.desk.invoke('claude.pickCli').then(
            (p) => {
              if (p) app.refreshClaude(true);
            },
            (e) => app.toast(errText(e)),
          );
        },
      },
      recheck,
    ];
  return [{ label: '오류 내용 복사', run: () => copyText(message).then((ok) => app.toast(ok ? '오류 내용을 복사했습니다.' : '복사하지 못했습니다.')) }];
}

export function ErrorBox(props: { tone?: 'err' | 'warn' | 'info'; text: string; detail?: string; actions?: ErrAction[]; indent?: boolean; onClose?: () => void }) {
  const tone = props.tone ?? 'err';
  return (
    <div class={`cp-err ${tone}`} style={props.indent === false ? { marginLeft: 0 } : undefined} role={tone === 'err' ? 'alert' : 'status'}>
      <div class="row1">
        <span class="ic">
          <Icon name={tone === 'info' ? 'info' : 'warn'} size={15} />
        </span>
        <span class="grow">{props.text}</span>
        {props.onClose && (
          <button type="button" class="x" aria-label="닫기" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {props.detail && props.detail !== props.text && <div class="detail">{props.detail}</div>}
      {props.actions && props.actions.length > 0 && (
        <div class="btns">
          {props.actions.map((a) => (
            <button type="button" key={a.label} class={`btn sm${a.primary ? ' primary' : ''}`} onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorItem(props: { item: Item<'error'>; app: DeskApp; extra?: ErrAction[] }) {
  const { item } = props;
  const id = ERR_MSG[item.code];
  const text = id ? msg(id) : item.message || 'Claude 요청이 실패했습니다.';
  const tone = MSG[id ?? '']?.kind === 'info' ? 'info' : 'err';
  return <ErrorBox tone={tone} text={text} detail={id ? item.message : undefined} actions={[...(props.extra ?? []), ...claudeErrActions(props.app, item.code, item.message)]} />;
}

const DB_FAIL = /DB\s*(\S+?)에 연결하지 못했습니다/;

function NoticeItem(props: { item: Item<'notice'>; app: DeskApp }) {
  const { item, app } = props;
  const msgId = item.msg ?? (DB_FAIL.test(item.text) ? 'MSG-36' : undefined);
  if (msgId && MSG[msgId]) {
    const def = MSG[msgId];
    const vars = item.vars ?? (msgId === 'MSG-36' ? { DB: item.text.match(DB_FAIL)?.[1] ?? '' } : {});
    const text = msg(msgId, vars);
    const actions: ErrAction[] = [];
    for (const b of def.buttons) {
      const label = b.replace(/^[*!]/, '');
      if (label === '연결 확인' || label === '프로젝트 연결 열기') actions.push({ label, primary: b.startsWith('*'), run: () => app.openModal('project') });
      else if (label === '인증 방식 변경') actions.push({ label, run: () => app.openModal('claude') });
      else if (label === '다시 확인') actions.push({ label, run: () => app.refreshClaude(true) });
    }
    return <ErrorBox tone={def.kind === 'err' ? 'err' : def.kind === 'warn' ? 'warn' : 'info'} text={text} detail={item.text !== text ? item.text : undefined} actions={actions} />;
  }
  return (
    <div class="cp-sys">
      <span title={item.text}>
        <Icon name="info" size={13} color="var(--muted)" sw={1.9} />
        {item.text}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ 모드 전환 · 확인 요청

function ModeLine(props: { item: Item<'mode'>; approved: boolean; isNew: boolean; folderName?: string }) {
  const { item } = props;
  const t = hm(item.at);
  if (props.isNew && item.mode === 'edit' && props.approved)
    return (
      <>
        <div class="cp-actions cp-ind">
          <span class="cp-done">
            <Icon name="check" size={14} color="var(--acc-d)" sw={2.4} />
            계획 확정함
          </span>
          <span class="cp-time">{t}</span>
        </div>
        <div class="cp-sys">
          <span>
            <Icon name="play" size={13} color="var(--muted)" sw={1.9} />
            생성 시작 · {props.folderName || '고른'} 폴더에서만 작업
          </span>
        </div>
      </>
    );
  const label = item.mode === 'edit' ? '수정 허용으로 전환' : '계획 모드로 전환';
  if (item.mode === 'edit' && props.approved)
    return (
      <div class="cp-actions cp-ind">
        <span class="cp-done">
          <Icon name="check" size={14} color="var(--acc-d)" sw={2.4} />
          수정 진행함
        </span>
        <span class="cp-time">
          {t} · {label}
        </span>
      </div>
    );
  return (
    <div class="cp-ind cp-time">
      {t} · {label}
    </div>
  );
}

function PendingView(props: { pending: PendingRequest; conv: Conversation; canEdit: boolean; actions: LogActions; folderName?: string; env: LinkEnv; showPlan: boolean }) {
  const { pending: p, actions } = props;
  const [sql, setSql] = useState(false);
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    Promise.resolve(actions.respond(p.requestId, allow)).finally(() => setBusy(false));
  };
  // Claude가 ExitPlanMode로 낸 계획 (답변 글에 없을 수 있어 확인 전에 보여 준다)
  const planBox =
    p.kind === 'plan' && props.showPlan && p.detail?.trim() ? (
      <div class="cp-plan-box">
        <div class="h">{props.conv.kind === 'new' ? '계획' : '수정 계획'}</div>
        <Markdown text={p.detail} env={props.env} />
      </div>
    ) : null;
  if (p.kind === 'plan') {
    if (props.conv.kind === 'new')
      return (
        <>
        {planBox}
        <div class="cp-actions cp-ind">
          <button type="button" class="btn primary cp-b30" disabled={busy} onClick={() => (actions.confirmPlan ? actions.confirmPlan() : answer(true))}>
            <Icon name="check" size={14} color="#FFFFFF" sw={2.4} />
            계획 확정
          </button>
          <span class="cp-time">확정하면 {props.folderName || '고른 폴더'}에 파일을 만듭니다</span>
        </div>
        </>
      );
    return (
      <>
      {planBox}
      <div class="cp-ind" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div class="cp-actions">
          <button
            type="button"
            class="btn primary cp-b30"
            disabled={busy || !props.canEdit}
            title={props.canEdit ? '수정 허용으로 바꿔 작업 사본에서 고칩니다' : '폴더로 연 프로젝트에서만 수정할 수 있습니다'}
            onClick={() => answer(true)}
          >
            <Icon name="code" size={14} color="#FFFFFF" />
            수정 진행
          </button>
          <button type="button" class="btn ghost cp-b30" disabled={busy} onClick={() => answer(false)}>
            수정하지 않음
          </button>
          <span class="cp-time">{props.canEdit ? '작업 사본에서만 고치고, 원본은 [적용]하기 전까지 그대로입니다' : '원본 폴더가 없어 수정할 수 없습니다'}</span>
        </div>
      </div>
      </>
    );
  }
  if (p.kind === 'command') {
    const cmd = p.detail || p.title;
    return (
      <div class="cp-ask" role="group" aria-label="명령 실행 확인">
        <div class="cp-ask-h">
          <span class="ic">
            <Icon name="terminal" size={15} color="var(--acc-d)" />
          </span>
          <span>{msg('MSG-24', { 명령: cmd })}</span>
        </div>
        <div class="cp-ask-cmd">{cmd}</div>
        <div class="cp-ask-btns">
          <button type="button" class="btn sm" disabled={busy} onClick={() => answer(false)}>
            거부
          </button>
          <button type="button" class="btn sm primary" disabled={busy} onClick={() => answer(true)}>
            <Icon name="play" size={12} filled color="#FFFFFF" />
            실행
          </button>
        </div>
      </div>
    );
  }
  // DB 조회 확인: 운영은 항상(MSG-42, 끌 수 없음), 개발·QA는 '매번 확인'으로 설정했을 때. 메인이 문구를 채워 보내면 그대로
  const prod = !p.env || p.env === 'prod';
  const n = p.maxRows ?? maxRowsOf(p.detail, DEFAULT_RULES.prod.maxRows);
  const text = p.detail && /조회하려고/.test(p.detail) ? p.detail : msg('MSG-42', { DB: p.db || p.title, n });
  return (
    <div class="cp-ask" role="group" aria-label={prod ? '운영 DB 조회 확인' : 'DB 조회 확인'} style={prod ? { borderColor: '#ebcb8b', background: '#fffbf2' } : undefined}>
      <div class="cp-ask-h">
        <span class="ic">
          <Icon name="db" size={15} color={prod ? 'var(--warn)' : 'var(--acc-d)'} />
        </span>
        <span>{text}</span>
      </div>
      {sql && p.sql && <pre class="cp-ask-sql">{p.sql}</pre>}
      <div class="cp-ask-btns">
        {p.sql && (
          <button type="button" class="btn sm" onClick={() => setSql((v) => !v)} aria-expanded={sql}>
            <Icon name="eye" size={13} />
            {sql ? 'SQL 접기' : 'SQL 보기'}
          </button>
        )}
        <button type="button" class="btn sm" disabled={busy} onClick={() => answer(false)}>
          거부
        </button>
        <button type="button" class="btn sm primary" disabled={busy} onClick={() => answer(true)}>
          <Icon name="play" size={12} filled color="#FFFFFF" />
          실행
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 대화 전체

export interface LogActions {
  respond(requestId: string, allow: boolean): void | Promise<void>;
  /** 새 프로젝트: [계획 확정] */
  confirmPlan?(): void;
  /** 새 프로젝트: 멈춘 뒤 [이어서 진행] */
  continueRun?(): void;
}

export interface ChatLogProps {
  conv: Conversation;
  app: DeskApp;
  env: LinkEnv;
  actions: LogActions;
  /** 수정 진행 가능 (원본 폴더 있음) */
  canEdit: boolean;
  /** [수정 진행]·[계획 확정]으로 바뀐 모드 항목 */
  approvedModes: Set<string>;
  filesClickable: boolean;
  folderName?: string;
  /** 답변 글 바꾸기 (새 프로젝트: 요구사항·계획 부분은 왼쪽 카드로) */
  textOf?(item: Item<'assistant'>): string;
  /** 답변 아래에 붙일 것 */
  afterAssistant?(item: Item<'assistant'>): ComponentChildren;
  /** 패널 맨 위 배너로 따로 보여 주는 오류(MSG-23·30 배너): 대화 안에는 한 줄 기록만 */
  bannerCodes?: ClaudeErrorCode[];
  /** 확인을 기다리는 계획(ExitPlanMode)의 글을 대화에 보일지 (새 프로젝트는 왼쪽 카드에 정리되면 숨김) */
  showPendingPlan?: boolean;
}

const STOP_TEXT: Partial<Record<ClaudeErrorCode, string>> = {
  limit: '사용 한도에 도달해 멈췄습니다',
  billing: '사용 권한·결제 문제로 멈췄습니다',
  auth: '인증에 실패해 멈췄습니다',
  offline: '인터넷 연결이 끊겨 멈췄습니다',
};

export function ChatLog(props: ChatLogProps) {
  const { conv, app, env } = props;
  const isNew = conv.kind === 'new';
  const out: ComponentChildren[] = [];
  const items = conv.items;
  const lastChanges = [...items].reverse().find((i) => i.type === 'changes')?.id;
  const last = items[items.length - 1];
  const runningId = conv.running && !conv.pending && last && last.type === 'activity' ? last.id : null;
  let group: (Activity | Select)[] = [];
  const flush = () => {
    if (!group.length) return;
    out.push(<ToolGroup key={`g-${group[0].id}`} items={group} runningId={runningId} isNew={isNew} env={env} filesClickable={props.filesClickable} />);
    group = [];
  };
  for (const it of items) {
    if (it.type === 'activity' || it.type === 'select') {
      group.push(it);
      continue;
    }
    flush();
    switch (it.type) {
      case 'user':
        out.push(<UserBubble key={it.id} item={it} />);
        break;
      case 'assistant': {
        const text = props.textOf ? props.textOf(it) : it.text;
        if (!text.trim() && !it.streaming && !props.afterAssistant) break;
        out.push(
          <AssistantMsg key={it.id} item={it} env={env} text={text}>
            {props.afterAssistant?.(it)}
          </AssistantMsg>,
        );
        break;
      }
      case 'changes':
        out.push(<ChangesCard key={it.id} item={it} app={app} conversationId={conv.id} latest={it.id === lastChanges} />);
        break;
      case 'query':
        out.push(
          <div key={it.id} class="cp-ind">
            <QueryCardView card={it.card} />
          </div>,
        );
        break;
      case 'mode':
        out.push(<ModeLine key={it.id} item={it} approved={it.via === 'plan' || props.approvedModes.has(it.id)} isNew={isNew} folderName={props.folderName} />);
        break;
      case 'notice':
        out.push(<NoticeItem key={it.id} item={it} app={app} />);
        break;
      case 'error': {
        const lastErr = it.id === last?.id;
        if (props.bannerCodes?.includes(it.code)) {
          out.push(
            <div key={it.id} class="cp-sys err" title={it.message}>
              <span>
                <Icon name="warn" size={13} color="var(--err)" sw={1.9} />
                {hm(it.at)} · {STOP_TEXT[it.code] ?? 'Claude 요청이 실패했습니다'}
              </span>
            </div>,
          );
          break;
        }
        const extra: ErrAction[] = isNew && lastErr && props.actions.continueRun && it.code !== 'missing' ? [{ label: '이어서 진행', primary: true, run: props.actions.continueRun }] : [];
        out.push(<ErrorItem key={it.id} item={it} app={app} extra={extra} />);
        break;
      }
    }
  }
  flush();
  if (conv.pending)
    out.push(
      <PendingView
        key={`p-${conv.pending.requestId}`}
        pending={conv.pending}
        conv={conv}
        canEdit={props.canEdit}
        actions={props.actions}
        folderName={props.folderName}
        env={env}
        showPlan={props.showPendingPlan !== false}
      />,
    );
  else if (conv.running && (!last || last.type === 'user' || last.type === 'mode' || last.type === 'changes' || last.type === 'query' || last.type === 'notice'))
    out.push(
      <div key="wait" class="cp-tools" style={{ borderLeftColor: 'transparent' }}>
        <div class="cp-tl">
          <Spinner size={13} />
          <span class="v run">{last?.type === 'user' ? '답변을 준비하는 중' : '작업하는 중'}</span>
        </div>
      </div>,
    );
  return <>{out}</>;
}
