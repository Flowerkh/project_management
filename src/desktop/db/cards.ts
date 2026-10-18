// 쿼리 카드: Claude가 제안한 SELECT 외 쿼리. Claude는 실행하지 못하고, 사용자가 화면에서 확인([실행])한 뒤에만 실행한다.
//  - 제안: 문장 하나, 종류(INSERT·UPDATE·DELETE·MERGE·DDL·CALL·그 밖), 예상 영향 행 수(읽기 전용 COUNT), 실행 계정 여부(MSG-39)
//  - 실행: 운영(또는 'DB 이름 입력'으로 정한 환경)은 DB 이름을 정확히 입력해야(MSG-33). DML은 트랜잭션 안에서 실행해
//          영향 행 수가 예상과 다르면 롤백(MSG-34). 예상이 없거나 DDL·CALL이면 실행 즉시 확정(화면이 MSG-41로 미리 알림)
//  - 작업 이력: kind 'query' (실행됨·롤백됨·실패, SQL, 예상/실제 행 수, 걸린 시간, 대상 DB·계정, 되돌리는 SQL)
// 카드는 projectDir(root)/cards/<id>.json 에 둔다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ENV_LABEL, type ExecResult, type QueryCard } from '../../shared/desktop-api';
import { msg } from '../../ui/desktop/messages';
import { DesktopError, emit } from '../ipc';
import { services, type DbProposeRequest } from '../services';
import { dataDir, newId, nowIso, projectDir, readJson, withLock, writeJson } from '../store';
import { canWrite, getConn, listStored, readTarget, targetFor, type StoredConn } from './conns';
import { describeError, scrub, withSession } from './drivers';
import { availableText, dialectOf, ruleOf, secretsOf, settingsOf } from './query';
import { checkReadOnly, classify, countPlan, isIrreversible, mainTable, type Dialect } from './sql';

/** 실행 시간 제한 (변경 쿼리는 조회보다 길게) */
export const EXEC_TIMEOUT_SEC = 300;

type StoredCard = QueryCard & { revertOf?: string };

export const KIND_LABEL: Record<QueryCard['kind'], string> = {
  insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', merge: 'MERGE', ddl: 'DDL', call: '프로시저 호출', other: 'SELECT 외',
};

const listeners = new Set<(c: QueryCard) => void>();
const cardRoot = new Map<string, string>();
const running = new Set<string>();

export function onCard(fn: (c: QueryCard) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publicCard(c: StoredCard): QueryCard {
  const { revertOf: _r, ...rest } = c;
  void _r;
  return rest;
}

function publish(c: StoredCard): void {
  const pub = publicCard(c);
  emit({ type: 'db.card', card: pub });
  for (const fn of listeners) {
    try {
      fn(pub);
    } catch {
      // 듣는 쪽 오류는 무시
    }
  }
}

function cardFile(root: string, id: string): string {
  return path.join(projectDir(root), 'cards', `${id}.json`);
}

async function save(c: StoredCard): Promise<void> {
  await withLock(`card:${c.id}`, () => writeJson(cardFile(c.root, c.id), c));
  cardRoot.set(c.id, c.root);
}

async function findCard(id: string): Promise<StoredCard | null> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  let c: StoredCard | null = null;
  const root = cardRoot.get(id);
  if (root) c = await readJson<StoredCard | null>(cardFile(root, id), null);
  if (!c) {
    const base = path.join(dataDir(), 'projects');
    for (const d of await fsp.readdir(base).catch(() => [] as string[])) {
      c = await readJson<StoredCard | null>(path.join(base, d, 'cards', `${id}.json`), null);
      if (c) break;
    }
  }
  if (!c) return null;
  cardRoot.set(c.id, c.root);
  // 실행 중에 앱이 꺼진 카드
  if (c.status === 'running' && !running.has(c.id)) {
    c.status = 'failed';
    c.result = { ok: false, affected: 0, ms: 0, error: '실행 중에 앱이 종료되어 결과를 알 수 없습니다. 작업 이력과 DB를 확인해 주세요' };
    await save(c);
  }
  return c;
}

function pickConn(list: StoredConn[], req: { env?: QueryCard['env']; connectionId?: string }): StoredConn | undefined {
  if (req.connectionId) return list.find((c) => c.id === req.connectionId);
  return list.find((c) => c.env === (req.env ?? 'dev'));
}

/** 예상 영향 행 수: 같은 실행 계정(없으면 조회 계정)의 읽기 전용 세션에서 COUNT(*) */
async function estimateOf(root: string, c: StoredConn, sql: string, d: Dialect): Promise<{ estimate?: number; note?: string }> {
  const plan = countPlan(sql, d);
  if (plan.note) return { note: plan.note };
  if (plan.fixed !== undefined) return { estimate: plan.fixed };
  if (!plan.countSql) return { note: '예상 행 수를 셀 수 없는 문장입니다' };
  const chk = checkReadOnly(plan.countSql, d);
  if (!chk.ok) return { note: `예상 행 수를 세지 못했습니다: ${chk.reason}` };
  const t = (await targetFor(root, c, 'main')) ?? (await readTarget(root, c))?.target ?? null;
  if (!t) return { note: '비밀번호가 저장되어 있지 않아 예상 행 수를 세지 못했습니다' };
  const rule = ruleOf(await settingsOf(root), c.env);
  const sec = Math.max(30, rule.timeoutSec);
  try {
    const n = await withSession(t, async (s) => {
      await s.beginReadOnly(sec);
      const r = await s.rows(chk.sql, [], sec);
      await s.rollback().catch(() => undefined);
      return Number(r[0]?.[0]);
    });
    if (!Number.isFinite(n)) return { note: '예상 행 수를 세지 못했습니다' };
    return { estimate: plan.limit !== undefined ? Math.min(n, plan.limit) : n };
  } catch (e) {
    return { note: `예상 행 수를 세지 못했습니다: ${scrub(describeError(e, sec).message, secretsOf(c, t))}` };
  }
}

/** DbService.propose: SELECT 외 쿼리 → 쿼리 카드 (실행하지 않음) */
export async function propose(req: DbProposeRequest, extra: { revertOf?: string } = {}): Promise<QueryCard> {
  const root = req.root;
  const list = await listStored(root);
  const c = pickConn(list, req);
  if (!c) {
    const what = req.connectionId ? '지정한 DB 연결을 찾을 수 없습니다.' : `${ENV_LABEL[req.env ?? 'dev']} DB 연결이 없습니다.`;
    throw new DesktopError(`${what} ${availableText(list)}`, 'none');
  }
  const d = dialectOf(c.kind);
  const cls = classify(String(req.sql ?? ''), d);
  if (cls.error) throw new DesktopError(`SQL을 해석할 수 없습니다: ${cls.error}`, 'invalid');
  if (cls.count === 0) throw new DesktopError('실행할 SQL이 없습니다', 'invalid');
  if (cls.count > 1) throw new DesktopError(`쿼리 카드에는 문장을 하나씩 넣어 주세요 (지금 ${cls.count}개)`, 'invalid');
  if (cls.kind === 'select') throw new DesktopError('SELECT는 쿼리 카드가 아니라 조회 도구로 실행합니다', 'invalid');
  const irreversible = isIrreversible(cls.kind);
  const card: StoredCard = {
    id: newId('q'),
    root,
    ...(req.conversationId ? { conversationId: req.conversationId } : {}),
    env: c.env,
    connectionId: c.id,
    dbName: c.name,
    kind: cls.kind,
    sql: cls.text,
    ...(req.description ? { description: String(req.description).slice(0, 2000) } : {}),
    irreversible,
    ...(req.revertSql ? { revertSql: String(req.revertSql).slice(0, 100_000) } : {}),
    canExecute: await canWrite(root, c),
    status: 'pending',
    createdAt: nowIso(),
    ...(extra.revertOf ? { revertOf: extra.revertOf } : {}),
  };
  if (irreversible) card.estimateNote = cls.kind === 'ddl' ? 'DDL은 행 수를 세지 않습니다' : '프로시저·그 밖의 문장은 행 수를 미리 알 수 없습니다';
  else {
    const est = await estimateOf(root, c, card.sql, d);
    if (est.estimate !== undefined) card.estimate = est.estimate;
    else card.estimateNote = est.note ?? '예상 행 수를 세지 못했습니다';
  }
  await save(card);
  publish(card);
  return publicCard(card);
}

export async function getCard(id: string): Promise<QueryCard | null> {
  const c = await findCard(id);
  return c ? publicCard(c) : null;
}

export async function rejectCard(id: string): Promise<QueryCard> {
  const c = await findCard(id);
  if (!c) throw new DesktopError('쿼리 카드를 찾을 수 없습니다', 'notfound');
  if (c.status !== 'pending' && c.status !== 'failed') throw new DesktopError('이미 실행했거나 거부한 쿼리입니다', 'state');
  c.status = 'rejected';
  await save(c);
  publish(c);
  return publicCard(c);
}

function titleOf(c: StoredCard, d: Dialect): string {
  if (c.description) {
    const one = c.description.split('\n')[0].trim();
    if (one) return one.length > 80 ? `${one.slice(0, 80)}…` : one;
  }
  const t = mainTable(c.sql, d);
  return `${KIND_LABEL[c.kind]}${t ? ` ${t.name}` : ''} · ${ENV_LABEL[c.env]} ${c.dbName}`;
}

/** 사용자가 확인 창에서 [실행]을 누른 뒤 */
export async function executeCard(id: string, typedName?: string): Promise<QueryCard> {
  const c = await findCard(id);
  if (!c) throw new DesktopError('쿼리 카드를 찾을 수 없습니다', 'notfound');
  if (running.has(c.id) || c.status === 'running') throw new DesktopError('이미 실행 중입니다', 'state');
  if (c.status !== 'pending' && c.status !== 'failed') throw new DesktopError('이미 실행했거나 거부한 쿼리입니다', 'state');
  const conn = await getConn(c.root, c.connectionId);
  if (!conn) throw new DesktopError('이 쿼리의 DB 연결을 찾을 수 없습니다. 프로젝트 연결을 확인해 주세요', 'none');
  const rule = ruleOf(await settingsOf(c.root), c.env);
  if ((c.env === 'prod' || rule.changeMode === 'typeName') && (typedName ?? '').trim() !== c.dbName) {
    throw new DesktopError('입력한 DB 이름이 맞지 않아 실행하지 않았습니다', 'typeName');
  }
  const t = await targetFor(c.root, conn, 'main');
  if (!t) {
    if (c.canExecute) {
      c.canExecute = false;
      await save(c);
      publish(c);
    }
    throw new DesktopError(msg('MSG-39', { DB: c.dbName, 종류: KIND_LABEL[c.kind] }), 'readonly');
  }
  running.add(c.id);
  try {
    c.status = 'running';
    delete c.result;
    await save(c);
    publish(c);
    const t0 = Date.now();
    const startedAt = nowIso();
    let res: ExecResult;
    try {
      res = await withSession(t, async (s) => {
        if (c.irreversible) {
          const affected = await s.exec(c.sql, EXEC_TIMEOUT_SEC, true);
          return { ok: true, affected, ms: 0 };
        }
        await s.beginWrite(EXEC_TIMEOUT_SEC);
        let affected: number;
        try {
          affected = await s.exec(c.sql, EXEC_TIMEOUT_SEC, false);
        } catch (e) {
          await s.rollback().catch(() => undefined);
          throw e;
        }
        if (c.estimate !== undefined && affected !== c.estimate) {
          await s.rollback();
          return { ok: false, affected, expected: c.estimate, rolledBack: true, ms: 0 };
        }
        await s.commit();
        return { ok: true, affected, ...(c.estimate !== undefined ? { expected: c.estimate } : {}), ms: 0 };
      });
    } catch (e) {
      const err = describeError(e, EXEC_TIMEOUT_SEC);
      res = {
        ok: false,
        affected: 0,
        ...(c.estimate !== undefined ? { expected: c.estimate } : {}),
        ms: 0,
        error: `${scrub(err.message, secretsOf(conn, t))}${c.irreversible ? '' : ' · 트랜잭션을 확정하지 않아 데이터는 바뀌지 않았습니다'}`,
      };
    }
    res.ms = Date.now() - t0;
    c.status = res.rolledBack ? 'rolledback' : res.ok ? 'done' : 'failed';
    // 작업 이력
    const h = services.history;
    if (h) {
      try {
        const n = (v: number) => v.toLocaleString('ko-KR');
        const entry = await h.add(c.root, {
          kind: 'query',
          title: titleOf(c, dialectOf(conn.kind)),
          status: res.rolledBack ? '롤백됨' : res.ok ? '실행됨' : '실패',
          db: { env: c.env, name: c.dbName, account: t.user },
          sql: c.sql,
          ...(c.estimate !== undefined ? { expected: c.estimate } : {}),
          affected: res.affected,
          ms: res.ms,
          ...(res.error ? { error: res.error } : {}),
          ...(c.revertSql ? { revertSql: c.revertSql } : {}),
          ...(c.conversationId ? { conversationId: c.conversationId } : {}),
          ...(c.revertOf ? { revertOf: c.revertOf } : {}),
          steps: [
            { at: startedAt, label: '실행', detail: c.estimate !== undefined ? `예상 ${n(c.estimate)}행` : (c.estimateNote ?? '예상 행 수 없음'), ok: true },
            res.rolledBack
              ? { at: nowIso(), label: '롤백', detail: `영향 ${n(res.affected)}행 ≠ 예상 ${n(c.estimate ?? 0)}행`, ok: false }
              : res.ok
                ? { at: nowIso(), label: c.irreversible ? '실행 완료' : '확정', detail: `영향 ${n(res.affected)}행`, ok: true }
                : { at: nowIso(), label: '실패', detail: res.error, ok: false },
          ],
        });
        res.historyId = entry?.id;
        if (c.revertOf && res.ok && entry?.id) await h.update(c.root, c.revertOf, { revertedBy: entry.id }).catch(() => null);
      } catch {
        // 이력을 못 남겨도 결과는 돌려준다
      }
    }
    c.result = res;
    await save(c);
    publish(c);
    return publicCard(c);
  } finally {
    running.delete(c.id);
  }
}

/** 작업 이력의 쿼리에서 되돌리는 SQL로 새 쿼리 카드 (실행은 같은 확인 절차) */
export async function cardFromHistory(root: string, entryId: string): Promise<QueryCard> {
  const h = services.history;
  if (!h) throw new DesktopError('작업 이력을 읽을 수 없습니다', 'unavailable');
  const e = await h.get(root, entryId);
  if (!e) throw new DesktopError('작업 이력 기록을 찾을 수 없습니다', 'notfound');
  if (!e.revertSql) throw new DesktopError('이 기록에는 되돌리는 SQL이 없습니다', 'invalid');
  const list = await listStored(root);
  const conn = list.find((x) => x.env === e.db?.env && x.name === e.db?.name) ?? (e.db ? list.find((x) => x.env === e.db?.env) : undefined);
  if (!conn) throw new DesktopError(`이 쿼리를 실행한 DB 연결(${e.db ? `${ENV_LABEL[e.db.env]} ${e.db.name}` : '알 수 없음'})을 찾을 수 없습니다`, 'none');
  return propose(
    { root, connectionId: conn.id, sql: e.revertSql, description: `되돌리기: ${e.title}`, ...(e.conversationId ? { conversationId: e.conversationId } : {}) },
    { revertOf: e.id },
  );
}

/** 시험용: 기억한 카드 위치·실행 상태 비우기 */
export function resetCardsForTest(): void {
  cardRoot.clear();
  running.clear();
}
