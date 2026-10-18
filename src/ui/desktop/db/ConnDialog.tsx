// DB 연결 추가·수정 창 (POP-04 ⑤ [DB 추가]·행 누르기): 환경·종류·이름·주소·계정(+조회 전용 계정)·Oracle 11g Thick
// [연결 확인]은 저장하지 않고 입력한 값으로 확인한다 (실패하면 MSG-36). 비밀번호는 다시 보여 주지 않는다(비우면 기존 값 유지).
import { useState } from 'preact/hooks';
import type { DbConnection, DbConnectionInput, DbKind, DbTestResult, Env } from '../../../shared/desktop-api';
import { ENV_LABEL } from '../../../shared/desktop-api';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { useDesk } from '../ctx';
import { msg } from '../messages';
import { DB_KIND_LABEL, DbModal } from './ui';

const DEFAULT_PORT: Record<DbKind, number> = { oracle: 1521, mysql: 3306, mariadb: 3306 };
const ENVS: Env[] = ['dev', 'qa', 'prod'];
const KINDS: DbKind[] = ['oracle', 'mysql', 'mariadb'];

interface Form {
  env: Env;
  kind: DbKind;
  name: string;
  host: string;
  port: string;
  service: string;
  sid: boolean;
  database: string;
  user: string;
  password: string;
  readUser: string;
  readPassword: string;
  thick: boolean;
}

function initial(c: DbConnection | null, envHint: Env): Form {
  return {
    env: c?.env ?? envHint,
    kind: c?.kind ?? 'oracle',
    name: c?.name ?? '',
    host: c?.host ?? '',
    port: String(c?.port ?? DEFAULT_PORT[c?.kind ?? 'oracle']),
    service: c?.service ?? '',
    sid: !!c?.sid,
    database: c?.database ?? '',
    user: c?.user ?? '',
    password: '',
    readUser: c?.readUser ?? '',
    readPassword: '',
    thick: !!c?.thick,
  };
}

export function ConnDialog(props: {
  root: string;
  conn: DbConnection | null;
  /** 새 연결의 기본 환경 (아직 없는 환경) */
  envHint?: Env;
  onClose: () => void;
  onSaved: (c: DbConnection, test?: DbTestResult) => void;
  onRemoved: (id: string) => void;
}) {
  const app = useDesk();
  const c = props.conn;
  const [f, setF] = useState<Form>(() => initial(c, props.envHint ?? 'dev'));
  const [test, setTest] = useState<DbTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [askRemove, setAskRemove] = useState(false);

  const set = (p: Partial<Form>) => {
    setF((o) => {
      const n = { ...o, ...p };
      // 종류를 바꾸면 기본 포트도 바꾼다 (직접 바꾼 포트는 그대로)
      if (p.kind && p.kind !== o.kind && (o.port === '' || Number(o.port) === DEFAULT_PORT[o.kind])) n.port = String(DEFAULT_PORT[p.kind]);
      return n;
    });
    setTest(null);
    setErr(null);
  };

  const oracle = f.kind === 'oracle';
  const input = (): DbConnectionInput => ({
    id: c?.id ?? '',
    env: f.env,
    kind: f.kind,
    name: f.name.trim(),
    host: f.host.trim(),
    port: Number(f.port) || DEFAULT_PORT[f.kind],
    ...(oracle ? { service: f.service.trim(), sid: f.sid, thick: f.thick } : { database: f.database.trim() }),
    user: f.user.trim(),
    readUser: f.readUser.trim(),
    ...(f.password ? { password: f.password } : {}),
    ...(f.readPassword ? { readPassword: f.readPassword } : {}),
  });

  const missing = !f.name.trim() ? '이름' : !f.host.trim() && !(oracle && f.service.trim().startsWith('(')) ? '호스트' : oracle && !f.service.trim() ? '서비스 이름' : !oracle && !f.database.trim() ? '데이터베이스' : !f.user.trim() && !f.readUser.trim() ? '계정' : null;

  const runTest = async () => {
    setTesting(true);
    setErr(null);
    setTest(null);
    try {
      setTest(await app.desk.invoke('db.test', props.root, input()));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (missing) {
      setErr(`${missing}을(를) 넣어 주세요`);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const saved = await app.desk.invoke('db.save', props.root, input());
      props.onSaved(saved, test ?? undefined);
    } catch (e) {
      setErr(errText(e));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!c) return;
    try {
      await app.desk.invoke('db.remove', props.root, c.id);
      props.onRemoved(c.id);
    } catch (e) {
      setAskRemove(false);
      setErr(errText(e));
    }
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      save();
    }
  };

  const field = (label: string, body: preact.ComponentChildren, opt?: string) => (
    <div class="db-form-row">
      <span class="lbl">
        {label}
        {opt && <span class="opt">{opt}</span>}
      </span>
      <div class="body">{body}</div>
    </div>
  );
  const text = (k: keyof Form, ph: string, cls = 'mono', extra: Record<string, unknown> = {}) => (
    <input
      class={`inp ${cls}`}
      value={f[k] as string}
      placeholder={ph}
      spellcheck={false}
      autocomplete="off"
      onInput={(e) => set({ [k]: (e.target as HTMLInputElement).value } as Partial<Form>)}
      onKeyDown={onEnter}
      {...extra}
    />
  );
  const pw = (k: 'password' | 'readPassword', has: boolean | undefined, disabled: boolean, label: string) => (
    <input
      class="inp"
      type="password"
      value={f[k]}
      aria-label={label}
      placeholder={has ? '저장됨 (바꿀 때만 입력)' : disabled ? '계정을 먼저 넣어 주세요' : '비밀번호'}
      autocomplete="new-password"
      disabled={disabled}
      onInput={(e) => set({ [k]: (e.target as HTMLInputElement).value } as Partial<Form>)}
      onKeyDown={onEnter}
    />
  );

  return (
    <>
      <DbModal
        title={c ? <>DB 연결 수정 <span class="mono muted" style={{ fontSize: '13px', fontWeight: 500 }}>{c.name}</span></> : 'DB 연결 추가'}
        label={c ? 'DB 연결 수정' : 'DB 연결 추가'}
        icon="db"
        cls="db-dlg"
        onClose={props.onClose}
        foot={
          <>
            {c && (
              <button type="button" class="btn danger left" onClick={() => setAskRemove(true)}>
                삭제
              </button>
            )}
            {err && <span class="err-text" style={{ marginRight: 'auto', maxWidth: '240px' }}>{err}</span>}
            <button type="button" class="btn" onClick={runTest} disabled={testing || !!missing}>
              {testing ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}
              연결 확인
            </button>
            <button type="button" class="btn" onClick={props.onClose}>
              취소
            </button>
            <button type="button" class="btn primary" onClick={save} disabled={saving}>
              {saving && <Spinner size={13} color="#fff" />}
              저장
            </button>
          </>
        }
      >
        {field(
          '환경',
          <div class="db-seg" role="radiogroup" aria-label="환경">
            {ENVS.map((e) => (
              <button key={e} type="button" role="radio" aria-checked={f.env === e} class={f.env === e ? 'on' : ''} onClick={() => set({ env: e })}>
                {ENV_LABEL[e]}
              </button>
            ))}
          </div>,
        )}
        {field(
          '종류',
          <div class="db-seg" role="radiogroup" aria-label="DB 종류">
            {KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={f.kind === k} class={f.kind === k ? 'on' : ''} onClick={() => set({ kind: k })}>
                {DB_KIND_LABEL[k]}
              </button>
            ))}
          </div>,
        )}
        {field('이름', text('name', '예) shop_dev', 'mono', { 'data-autofocus': true, maxLength: 60 }))}
        <div class="db-help" style={{ marginTop: '-6px' }}>화면과 Claude에 보이는 이름입니다. 운영 DB 변경을 실행할 때 이 이름을 입력합니다.</div>
        {field(
          '호스트',
          <>
            {text('host', 'db-dev.company.local')}
            <span class="mini">포트</span>
            <input class="inp mono port" inputMode="numeric" value={f.port} aria-label="포트" onInput={(e) => set({ port: (e.target as HTMLInputElement).value.replace(/[^0-9]/g, '').slice(0, 5) })} onKeyDown={onEnter} />
          </>,
        )}
        {oracle
          ? field(
              f.sid ? 'SID' : '서비스 이름',
              <>
                {text('service', f.sid ? '예) ORCL' : '예) SHOPDEV (연결 설명자도 가능)')}
                <label class="db-radio">
                  <input type="radio" name="db-svc" checked={!f.sid} onChange={() => set({ sid: false })} />
                  서비스 이름
                </label>
                <label class="db-radio">
                  <input type="radio" name="db-svc" checked={f.sid} onChange={() => set({ sid: true })} />
                  SID
                </label>
              </>,
            )
          : field('데이터베이스', text('database', '예) shop'))}
        {field(
          '계정',
          <>
            {text('user', '예) shop_app', 'mono', { 'aria-label': '계정' })}
            {pw('password', c?.hasPassword && !!c.user && c.user === f.user.trim(), !f.user.trim(), '계정 비밀번호')}
          </>,
        )}
        {field(
          '조회 전용 계정',
          <>
            {text('readUser', '예) shop_read', 'mono', { 'aria-label': '조회 전용 계정' })}
            {pw('readPassword', c?.hasReadPassword && !!c.readUser && c.readUser === f.readUser.trim(), !f.readUser.trim(), '조회 전용 계정 비밀번호')}
          </>,
          '권장 · 선택',
        )}
        <div class="db-help">
          계정은 SELECT 외 쿼리 실행에 씁니다. 조회 전용 계정을 넣으면 Claude 조회와 메뉴 읽기는 그 계정으로 합니다. 조회 전용 계정만 넣으면 SELECT 외 쿼리는
          [SQL 복사]만 할 수 있습니다.
        </div>
        {oracle && (
          <label class="ck" style={{ paddingLeft: '102px', fontWeight: 600 }}>
            <input type="checkbox" checked={f.thick} onChange={(e) => set({ thick: (e.target as HTMLInputElement).checked })} />
            <span>
              Oracle 11g 이하 (Thick 모드)
              <span class="help">PC에 Oracle Client 19 이상(Instant Client)이 있어야 합니다. 12c 이상은 끄고 쓰세요(설치 필요 없음).</span>
            </span>
          </label>
        )}
        {testing && (
          <div class="db-test run" role="status">
            <Spinner size={14} /> 연결 확인 중 · 최대 10초
          </div>
        )}
        {test && (
          <div class={`db-test ${test.ok ? 'ok' : 'err'}`} role="status">
            <Icon name={test.ok ? 'check' : 'warn'} size={14} sw={2.2} />
            <span>
              {test.ok ? test.message : msg('MSG-36', { DB: f.name.trim() || '(이름 없음)' })}
              {!test.ok && <span class="detail">{test.message}</span>}
            </span>
          </div>
        )}
      </DbModal>
      {askRemove && c && (
        <DbModal
          title="DB 연결 삭제"
          icon="warn"
          iconColor="var(--err)"
          cls="sm"
          onClose={() => setAskRemove(false)}
          foot={
            <>
              <button type="button" class="btn" onClick={() => setAskRemove(false)}>
                취소
              </button>
              <button type="button" class="btn danger" onClick={remove}>
                삭제
              </button>
            </>
          }
        >
          <div style={{ fontSize: '13.5px', lineHeight: 1.6 }}>
            DB 연결 <b class="mono">{c.name}</b>({ENV_LABEL[c.env]})을 지웁니다. 저장한 비밀번호도 함께 지웁니다. 지울까요?
          </div>
        </DbModal>
      )}
    </>
  );
}
