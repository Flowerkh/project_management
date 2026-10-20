// POP-04 오른쪽: ⑤ DB 연결 · ⑥ 환경별 규칙 · 가림 대상 · 메뉴 테이블
//  - DB 연결은 추가·수정·삭제할 때 바로 저장한다(비밀번호는 Windows 사용자 계정으로 암호화). [연결 확인]은 모든 연결을 확인
//  - 환경별 규칙·가림 대상·메뉴 테이블은 초안을 고치고 POP-04 [저장]이 project.set으로 저장한다
//  - 운영: 조회는 항상 확인(끌 수 없음), 변경은 DB 이름 입력. 가림은 기본 켬
import { useEffect, useRef, useState } from 'preact/hooks';
import { ENV_LABEL, type DbConnection, type DbTestResult, type Env, type EnvRule } from '../../../shared/desktop-api';
import { fmtDate } from '../../format';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { useDesk } from '../ctx';
import { msg } from '../messages';
import type { ProjectSectionProps } from '../ProjectDialog';
import { ConnDialog } from './ConnDialog';
import { MenuDbGroup, menuProblem } from './MenuDbGroup';
import { DB_KIND_LABEL, EnvTag, Toggle } from './ui';

const ENVS: Env[] = ['dev', 'qa', 'prod'];
const ENV_ORDER: Record<Env, number> = { dev: 0, qa: 1, prod: 2 };
const PATTERN = /^[A-Za-z0-9_$#*]+(:[^:]+)?$/;

const SELECT_LABEL: Record<EnvRule['selectMode'], string> = { auto: '바로 실행', confirm: '매번 확인' };
const CHANGE_LABEL: Record<EnvRule['changeMode'], string> = { confirm: '확인 후 실행', typeName: 'DB 이름 입력 후 실행' };

function sortConns(list: DbConnection[]): DbConnection[] {
  return [...list].sort((a, b) => ENV_ORDER[a.env] - ENV_ORDER[b.env] || a.name.localeCompare(b.name));
}

/** 숫자 칸: 입력 중에는 그대로 두고, 벗어날 때(또는 Enter) 범위에 맞춰 반영 */
function NumInput(props: { value: number; min: number; max: number; label: string; cls?: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    const n = Math.round(Number(text));
    const v = Number.isFinite(n) && text.trim() !== '' ? Math.min(props.max, Math.max(props.min, n)) : props.value;
    setText(String(v));
    if (v !== props.value) props.onCommit(v);
  };
  return (
    <input
      class={`db-ghost num ${props.cls ?? ''}`}
      style={{ width: `calc(${Math.max(1, text.length)}ch + 8px)` }}
      inputMode="numeric"
      aria-label={props.label}
      title={`${props.label} (${props.min.toLocaleString('ko-KR')}~${props.max.toLocaleString('ko-KR')})`}
      value={text}
      onInput={(e) => setText((e.target as HTMLInputElement).value.replace(/[^0-9]/g, '').slice(0, 5))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function StatIcon(props: { c: DbConnection; testing: boolean }) {
  const t = props.c.lastTest;
  if (props.testing) return <Spinner size={15} />;
  if (!t)
    return (
      <span class="db-stat none" title="연결 확인 전">
        <span class="sr-only">연결 확인 전</span>
      </span>
    );
  const when = fmtDate(t.at);
  return t.ok ? (
    <span class="db-stat ok" title={`연결됨 · ${t.version ?? ''} · ${when}`}>
      <Icon name="check" size={10} color="var(--ok)" sw={2.6} />
      <span class="sr-only">연결됨</span>
    </span>
  ) : (
    <span class="db-stat err" title={`연결 실패 · ${when}`}>
      <Icon name="close" size={9} color="var(--err)" sw={2.8} />
      <span class="sr-only">연결 실패</span>
    </span>
  );
}

export function ProjectDbSection(props: ProjectSectionProps) {
  const app = useDesk();
  const { root, draft, patch } = props;
  const [list, setList] = useState<DbConnection[]>(() => sortConns(draft.db ?? []));
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<DbConnection | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newPat, setNewPat] = useState('');
  const [patErr, setPatErr] = useState<string | null>(null);
  const [menuErr, setMenuErr] = useState<string | null>(null);

  // [저장] 전에 메뉴 테이블 설정 확인 (한 번 등록하고 최신 상태를 본다)
  const latest = useRef({ draft, list });
  latest.current = { draft, list };
  useEffect(() => {
    props.onBeforeSave(() => {
      const p = menuProblem(latest.current.draft.menuDb, latest.current.list);
      setMenuErr(p);
      return !p;
    });
  }, []);

  const refresh = async () => {
    try {
      const l = sortConns(await app.desk.invoke('db.list', root));
      setList(l);
      patch({ db: l });
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  };

  const testOne = async (id: string): Promise<DbTestResult | null> => {
    setTesting((s) => new Set(s).add(id));
    try {
      return await app.desk.invoke('db.test', root, id);
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setTesting((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const testAll = async () => {
    setError(null);
    await Promise.all(list.map((c) => testOne(c.id)));
    await refresh();
  };

  const retest = async (id: string) => {
    await testOne(id);
    await refresh();
  };

  const setRule = (env: Env, change: Partial<EnvRule>) => {
    patch({ dbRules: { ...draft.dbRules, [env]: { ...draft.dbRules[env], ...change } } });
  };

  const addPattern = () => {
    const p = newPat.trim().replace(/\s*:\s*/, ':');
    if (!p) {
      setAdding(false);
      return;
    }
    if (!PATTERN.test(p)) {
      setPatErr('예) *_TEL, CUST_*, *_NM:이름·성명 처럼 컬럼 이름 패턴(필요하면 :주석 단어)을 넣어 주세요');
      return;
    }
    if (!draft.maskPatterns.some((x) => x.toUpperCase() === p.toUpperCase())) patch({ maskPatterns: [...draft.maskPatterns, p] });
    setNewPat('');
    setPatErr(null);
    setAdding(false);
  };

  const missingEnv = ENVS.find((e) => !list.some((c) => c.env === e)) ?? 'dev';

  return (
    <>
      <section class="db-sec" aria-label="DB 연결">
        <div class="db-sec-head">
          <h3>DB 연결</h3>
          <div class="acts">
            <button type="button" class="btn sm" onClick={() => setEditing('new')}>
              <Icon name="plus" size={13} />
              DB 추가
            </button>
            <button type="button" class="btn sm" onClick={testAll} disabled={!list.length || testing.size > 0}>
              {testing.size ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}
              연결 확인
            </button>
          </div>
        </div>
        {list.length ? (
          <div class="db-list">
            {list.map((c) => {
              const failed = c.lastTest && !c.lastTest.ok && !testing.has(c.id);
              const noPw = (c.user && !c.hasPassword) || (c.readUser && !c.hasReadPassword);
              return (
                <div
                  key={c.id}
                  class="db-row"
                  role="button"
                  tabIndex={0}
                  aria-label={`${ENV_LABEL[c.env]} ${c.name} 연결 수정`}
                  onClick={() => setEditing(c)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setEditing(c);
                    }
                  }}
                >
                  <div class="l1">
                    <span class="env">
                      <EnvTag env={c.env} />
                    </span>
                    <span class="nm">{c.name}</span>
                    <span class="kd">
                      {DB_KIND_LABEL[c.kind]}
                      {c.thick ? ' · Thick' : ''}
                    </span>
                    <span class="sp" />
                    <span class="edit" aria-hidden="true">
                      <Icon name="sliders" size={12} />
                      수정
                    </span>
                    <StatIcon c={c} testing={testing.has(c.id)} />
                  </div>
                  <div class="l2">
                    <span class="v host" title={c.host}>{c.host}</span>
                    <span class="dot">·</span>
                    {c.user ? (
                      <>
                        <span class="k">계정</span>
                        <span class="v">{c.user}</span>
                      </>
                    ) : (
                      <span class="k">계정 없음 (SQL 복사만)</span>
                    )}
                    {c.readUser && (
                      <>
                        <span class="k">조회 전용</span>
                        <span class="v">{c.readUser}</span>
                      </>
                    )}
                    {noPw && <span class="warnk">· 비밀번호 없음</span>}
                  </div>
                  {failed && (
                    <div class="l3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Icon name="warn" size={13} color="var(--err)" />
                      <span>
                        {msg('MSG-36', { DB: c.name })} <span class="detail">{c.lastTest?.message}</span>
                      </span>
                      <button type="button" class="btn sm" onClick={() => retest(c.id)}>
                        연결 확인
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div class="db-empty">
            등록한 DB가 없습니다. [DB 추가]로 개발·QA·운영 DB를 등록하면 AI가 SELECT로 조회하고, SELECT 외 쿼리는 확인한 뒤 실행할 수 있습니다.
          </div>
        )}
        {error && <div class="err-text">{error}</div>}
        <span class="db-note">
          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
          AI 조회는 읽기 전용 세션 · 조회 전용 계정을 넣으면 그 계정으로(권장)
        </span>
      </section>
      <div class="db-sep" />
      <section class="db-sec" aria-label="환경별 규칙">
        <div class="db-sec-head">
          <h3>환경별 규칙</h3>
        </div>
        <table class="db-rules">
          <colgroup>
            <col style={{ width: '52px' }} />
            <col />
            <col style={{ width: '144px' }} />
            <col style={{ width: '96px' }} />
          </colgroup>
          <thead>
            <tr>
              <th>환경</th>
              <th title="AI 조회(SELECT): AI(Claude·Gemini·ChatGPT)가 이 환경의 DB를 SELECT로 조회하는 방식(바로 실행·매번 확인), 한 번에 가져올 최대 행 수, 시간 제한(초)">AI 조회(SELECT)</th>
              <th title="SELECT 외 쿼리: INSERT·UPDATE·DELETE 같은 쿼리는 AI가 실행하지 못하고 쿼리 카드로 올립니다. [실행]을 누를 때 확인하는 방식(확인 후 실행·DB 이름 입력 후 실행)">SELECT 외 쿼리</th>
              <th class="c" title="개인정보 가림: 켜면 조회 결과에서 아래 '가림 대상' 컬럼의 값을 ****로 가린 뒤 AI에 보냅니다">개인정보 가림</th>
            </tr>
          </thead>
          <tbody>
            {ENVS.map((env) => {
              const r = draft.dbRules[env];
              const prod = env === 'prod';
              return (
                <tr key={env}>
                  <td>
                    <EnvTag env={env} />
                  </td>
                  <td>
                    <div class="q">
                      {prod ? (
                        <span class="locked" title="운영 DB 조회는 항상 확인합니다 (끌 수 없음, MSG-42)">
                          <Icon name="lock" size={13} color="var(--err)" sw={2} />
                          항상 확인
                        </span>
                      ) : (
                        <select
                          class="db-ghost"
                          aria-label={`${ENV_LABEL[env]} AI 조회 방식`}
                          value={r.selectMode}
                          onChange={(e) => setRule(env, { selectMode: (e.target as HTMLSelectElement).value as EnvRule['selectMode'] })}
                        >
                          <option value="auto">{SELECT_LABEL.auto}</option>
                          <option value="confirm">{SELECT_LABEL.confirm}</option>
                        </select>
                      )}
                      <span class="sep">·</span>
                      <NumInput value={r.maxRows} min={1} max={5000} label={`${ENV_LABEL[env]} 최대 행 수`} onCommit={(n) => setRule(env, { maxRows: n })} />
                      <span class="u">행</span>
                      <span class="sep">·</span>
                      <NumInput value={r.timeoutSec} min={1} max={600} cls="n3" label={`${ENV_LABEL[env]} 시간 제한(초)`} onCommit={(n) => setRule(env, { timeoutSec: n })} />
                      <span class="u">초</span>
                    </div>
                  </td>
                  <td style={{ paddingRight: '4px' }}>
                    {prod ? (
                      <span title="운영 DB 변경은 DB 이름을 입력해야 실행합니다 (MSG-33)">DB 이름 입력 후 실행</span>
                    ) : (
                      <select
                        class="db-ghost"
                        aria-label={`${ENV_LABEL[env]} SELECT 외 쿼리 확인 방식`}
                        value={r.changeMode}
                        onChange={(e) => setRule(env, { changeMode: (e.target as HTMLSelectElement).value as EnvRule['changeMode'] })}
                      >
                        <option value="confirm">{CHANGE_LABEL.confirm}</option>
                        <option value="typeName">{CHANGE_LABEL.typeName}</option>
                      </select>
                    )}
                  </td>
                  <td class="c">
                    <Toggle on={r.mask} onChange={(v) => setRule(env, { mask: v })} label={`${ENV_LABEL[env]} 개인정보 가림`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div class="db-field">
          <span class="lbl">가림 대상</span>
          <div class="body">
            <div class="db-chips">
              {draft.maskPatterns.map((p) => {
                const at = p.indexOf(':');
                const pat = at < 0 ? p : p.slice(0, at);
                const words = at < 0 ? '' : p.slice(at + 1);
                return (
                  <span key={p} class="db-chip" title={words ? `${pat} 컬럼 중 주석에 ${words.split(/[·,]/).join('·')}이(가) 있는 것` : `${pat} 컬럼`}>
                    <span class="p">{pat}</span>
                    {words && <span class="w">{words}</span>}
                    <button type="button" aria-label={`${p} 빼기`} onClick={() => patch({ maskPatterns: draft.maskPatterns.filter((x) => x !== p) })}>
                      <Icon name="close" size={12} sw={2} />
                    </button>
                  </span>
                );
              })}
              {adding ? (
                <input
                  class="db-chip-input"
                  aria-label="가림 대상 추가"
                  placeholder="*_TEL 또는 *_NM:이름·성명"
                  value={newPat}
                  ref={(el) => el?.focus()}
                  onInput={(e) => {
                    setNewPat((e.target as HTMLInputElement).value);
                    setPatErr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.isComposing) {
                      e.preventDefault();
                      addPattern();
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setAdding(false);
                      setNewPat('');
                      setPatErr(null);
                    }
                  }}
                  onBlur={() => {
                    if (!newPat.trim()) setAdding(false);
                  }}
                />
              ) : (
                <button type="button" class="db-chip-add" onClick={() => setAdding(true)}>
                  <Icon name="plus" size={13} sw={2} />
                  추가
                </button>
              )}
              {patErr && <span class="db-chip-err">{patErr}</span>}
            </div>
          </div>
        </div>
        <span class="db-note">
          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
          운영 조회 확인은 끌 수 없음 · 문장 하나인 SELECT만 바로 실행 · 기본 조회 대상은 개발
        </span>
      </section>
      <div class="db-sep" />
      <MenuDbGroup
        root={root}
        value={draft.menuDb}
        conns={list}
        error={menuErr}
        onChange={(m) => {
          patch({ menuDb: m });
          setMenuErr(null);
        }}
      />
      {editing && (
        <ConnDialog
          root={root}
          conn={editing === 'new' ? null : editing}
          envHint={missingEnv}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            app.toast('DB 연결을 저장했습니다.');
          }}
          onRemoved={async () => {
            setEditing(null);
            await refresh();
            app.toast('DB 연결을 지웠습니다.');
          }}
        />
      )}
    </>
  );
}
