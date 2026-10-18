// POP-04 메뉴 테이블: 분석할 때 DB의 메뉴 테이블(예: TB_MENU)을 조회 전용 계정으로 SELECT해 메뉴로 쓴다 (기획서 6.5).
// 테이블·컬럼은 분석 결과(테이블 DDL·SQL)에서 추천하고 고칠 수 있다. [미리 보기]는 처음 20행.
import { useMemo, useState } from 'preact/hooks';
import type { DbConnection, MenuDbSetting, MenuRow } from '../../../shared/desktop-api';
import { ENV_LABEL } from '../../../shared/desktop-api';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { useDesk } from '../ctx';
import { guessColumns, menuTables, type MenuTableGuess } from './menuGuess';
import { Toggle } from './ui';

const EMPTY: MenuDbSetting = { enabled: false, connectionId: '', table: '', idCol: '', parentCol: '', nameCol: '', urlCol: '', orderCol: '', where: '' };
const IDENT = /^[A-Za-z0-9_$#.]+$/;

export function MenuDbGroup(props: {
  root: string;
  value: MenuDbSetting | undefined;
  conns: DbConnection[];
  onChange: (m: MenuDbSetting) => void;
  error?: string | null;
}) {
  const app = useDesk();
  const m: MenuDbSetting = { ...EMPTY, ...(props.value ?? {}) };
  const guesses = useMemo(() => menuTables(app.result), [app.result]);
  const [preview, setPreview] = useState<{ rows: MenuRow[]; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (p: Partial<MenuDbSetting>) => {
    props.onChange({ ...m, ...p });
    setPreview(null);
  };

  const enable = (on: boolean) => {
    if (!on) return set({ enabled: false });
    const g = guesses[0];
    const conn = m.connectionId && props.conns.some((c) => c.id === m.connectionId) ? m.connectionId : (props.conns.find((c) => c.env === 'dev') ?? props.conns[0])?.id ?? '';
    if (!m.table && g) set({ enabled: true, connectionId: conn, table: g.table, ...guessColumns(g.columns) });
    else set({ enabled: true, connectionId: conn });
  };

  const pickTable = (g: MenuTableGuess) => {
    const cols = guessColumns(g.columns);
    set({ table: g.table, ...cols });
  };

  const runPreview = async () => {
    setLoading(true);
    try {
      setPreview(await app.desk.invoke('db.previewMenu', props.root, { ...m, enabled: true }));
    } catch (e) {
      setPreview({ rows: [], error: errText(e) });
    } finally {
      setLoading(false);
    }
  };

  const col = guesses.find((g) => g.table === m.table.toUpperCase())?.columns ?? [];
  const listId = 'db-menu-cols';
  const input = (k: keyof MenuDbSetting, label: string, ph: string, opt = false) => (
    <label>
      {label}
      {opt && <span style={{ fontWeight: 400 }}> · 선택</span>}
      <input
        class={`inp mono${(m[k] as string) && !IDENT.test(m[k] as string) ? ' bad' : ''}`}
        list={listId}
        value={(m[k] as string) ?? ''}
        placeholder={ph}
        spellcheck={false}
        onInput={(e) => set({ [k]: (e.target as HTMLInputElement).value.trim() } as Partial<MenuDbSetting>)}
      />
    </label>
  );
  const ready = !!(m.connectionId && m.table && m.idCol && m.parentCol && m.nameCol && m.urlCol);

  return (
    <section class="db-sec" aria-label="메뉴 테이블">
      <div class="db-sec-head">
        <h3>메뉴 테이블</h3>
        <div class="acts">
          {m.enabled && (
            <button type="button" class="btn sm" onClick={runPreview} disabled={!ready || loading}>
              {loading ? <Spinner size={13} /> : <Icon name="eye" size={14} />}
              미리 보기
            </button>
          )}
          <label class="db-switch">
            <Toggle on={m.enabled} onChange={enable} label="분석할 때 DB의 메뉴 테이블 읽기" disabled={!props.conns.length && !m.enabled} />
            DB에서 읽기
          </label>
        </div>
      </div>
      <span class="db-note">
        <Icon name="info" size={12} color="var(--muted)" sw={1.9} />
        {props.conns.length ? '분석할 때 조회 전용 계정으로 메뉴 테이블을 읽어 메뉴로 씀 · 못 읽으면 소스의 메뉴로(MSG-43)' : '메뉴를 DB 테이블에 두는 시스템이면 DB 연결을 추가한 뒤 켜 주세요'}
      </span>
      {m.enabled && (
        <div class="db-menu">
          <>
            <div class="db-menu-row">
              <label class="w-conn">
                연결
                <select class="inp" value={props.conns.some((c) => c.id === m.connectionId) ? m.connectionId : ""} onChange={(e) => set({ connectionId: (e.target as HTMLSelectElement).value })}>
                  {!props.conns.some((c) => c.id === m.connectionId) && <option value="">연결 고르기</option>}
                  {props.conns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {ENV_LABEL[c.env]}
                    </option>
                  ))}
                </select>
              </label>
              {input('table', '테이블', 'TB_MENU')}
            </div>
            {guesses.length > 0 && (
              <div class="sug">
                <span>분석 결과에서 찾은 메뉴 테이블</span>
                {guesses.map((g) => (
                  <button key={g.table} type="button" onClick={() => pickTable(g)} title={g.columns.join(', ')}>
                    {g.table}
                  </button>
                ))}
              </div>
            )}
            <div class="db-menu-grid">
              {input('idCol', 'ID', 'MENU_ID')}
              {input('parentCol', '상위 ID', 'UPPER_MENU_ID')}
              {input('nameCol', '이름', 'MENU_NM')}
              {input('urlCol', 'URL', 'MENU_URL')}
              {input('orderCol', '순서', 'SORT_ORDR', true)}
            </div>
            <datalist id={listId}>
              {col.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <div class="db-menu-row">
              <label>
                <span>
                  조건 <span style={{ fontWeight: 400 }}>(선택 · WHERE 뒤에 붙음)</span>
                </span>
                <input class="inp mono" value={m.where ?? ''} placeholder="USE_YN = 'Y'" spellcheck={false} onInput={(e) => set({ where: (e.target as HTMLInputElement).value })} />
              </label>
            </div>
            {props.error && <div class="err-text">{props.error}</div>}
            {preview &&
              (preview.error ? (
                <div class="banner err" style={{ fontSize: '12.5px', padding: '8px 10px' }}>
                  <Icon name="warn" size={14} />
                  <span>메뉴 테이블을 읽지 못했습니다: {preview.error}</span>
                </div>
              ) : preview.rows.length ? (
                <div class="db-preview">
                  <table>
                    <colgroup>
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '24%' }} />
                      <col />
                      <col style={{ width: '44px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>상위 ID</th>
                        <th>이름</th>
                        <th>URL</th>
                        <th>순서</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.key}>
                          <td class="mono">{r.key}</td>
                          <td class="mono">{r.parentKey ?? '—'}</td>
                          <td>{r.name}</td>
                          <td class="mono" title={r.url}>{r.url ?? '—'}</td>
                          <td class="mono">{r.order ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div class="db-empty">조건에 맞는 메뉴가 없습니다.</div>
              ))}
          </>
        </div>
      )}
    </section>
  );
}

/** [저장] 전에 확인: 켰으면 연결·테이블·컬럼이 있어야 한다 */
export function menuProblem(m: MenuDbSetting | undefined, conns: DbConnection[]): string | null {
  if (!m || !m.enabled) return null;
  if (!m.connectionId || !conns.some((c) => c.id === m.connectionId)) return '메뉴를 읽을 DB 연결을 골라 주세요';
  for (const [label, v] of [['테이블', m.table], ['ID', m.idCol], ['상위 ID', m.parentCol], ['이름', m.nameCol], ['URL', m.urlCol]] as const) {
    if (!v) return `메뉴 테이블의 ${label}을(를) 넣어 주세요`;
    if (!IDENT.test(v)) return `메뉴 테이블의 ${label}에 쓸 수 없는 글자가 있습니다 (영문·숫자·_·$·#·.)`;
  }
  if (m.orderCol && !IDENT.test(m.orderCol)) return '메뉴 테이블의 순서 컬럼에 쓸 수 없는 글자가 있습니다';
  if (m.where && /;/.test(m.where)) return '조건에는 세미콜론(;)을 쓸 수 없습니다';
  return null;
}
