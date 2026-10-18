// 시험용 가짜 WorkService·DbService (claude 모듈 시험에서 services에 넣는다)
import { diffLines } from 'diff';
import fs from 'node:fs';
import path from 'node:path';
import type { DbConnection, FileChange, QueryCard, WorkCopy } from '../../src/shared/desktop-api';
import type { DbSelectAsk, DbService, DbSelectOutcome, WorkService } from '../../src/desktop/services';

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

export function fakeWork(workRoot: string): WorkService & { copies: Map<string, WorkCopy>; changeCalls: number } {
  const copies = new Map<string, WorkCopy>();
  let n = 0;
  const svc = {
    copies,
    changeCalls: 0,
    async create(root: string, opts?: { conversationId?: string }): Promise<WorkCopy> {
      const id = `w${++n}`;
      const p = path.join(workRoot, `${path.basename(root)}-${id}`);
      fs.cpSync(root, p, { recursive: true });
      const w: WorkCopy = { id, root, path: p, createdAt: new Date().toISOString(), conversationId: opts?.conversationId, fileCount: walk(p).length, redacted: 1 };
      copies.set(id, w);
      return w;
    },
    async get(id: string) {
      return copies.get(id) ?? null;
    },
    async changes(id: string): Promise<FileChange[]> {
      svc.changeCalls++;
      const w = copies.get(id);
      if (!w) return [];
      const out: FileChange[] = [];
      for (const rel of walk(w.path)) {
        const a = path.join(w.root, rel);
        const b = path.join(w.path, rel);
        const ta = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null;
        const tb = fs.readFileSync(b, 'utf8');
        if (ta === tb) continue;
        let plus = 0;
        let minus = 0;
        for (const part of diffLines(ta ?? '', tb)) {
          if (part.added) plus += part.count ?? 0;
          if (part.removed) minus += part.count ?? 0;
        }
        out.push({ path: rel, status: ta === null ? 'added' : 'modified', plus, minus, hunks: [] });
      }
      return out;
    },
  };
  return svc;
}

export function fakeDb(): DbService & { cards: QueryCard[]; asks: DbSelectAsk[]; emitCard(c: QueryCard): void; selects: string[] } {
  const listeners = new Set<(c: QueryCard) => void>();
  const conns: DbConnection[] = [
    { id: 'd1', env: 'dev', kind: 'oracle', name: 'shop_dev', host: '10.1.2.3', port: 1521, service: 'ORCL', user: 'shop_app', hasPassword: true, readUser: 'shop_ro', hasReadPassword: true },
    { id: 'd3', env: 'prod', kind: 'oracle', name: 'shop_prd', host: '10.9.9.9', port: 1521, service: 'PRD', user: 'shop_app', hasPassword: true },
  ];
  const svc = {
    cards: [] as QueryCard[],
    asks: [] as DbSelectAsk[],
    selects: [] as string[],
    async list() {
      return conns;
    },
    async select(req: { env?: 'dev' | 'qa' | 'prod'; sql: string }, ask: (q: DbSelectAsk) => Promise<boolean>): Promise<DbSelectOutcome> {
      svc.selects.push(req.sql);
      const env = req.env ?? 'dev';
      if (!/^\s*select\b/i.test(req.sql)) return { status: 'rejected', message: 'SELECT 문 하나만 실행할 수 있습니다' };
      const dbName = env === 'prod' ? 'shop_prd' : 'shop_dev';
      if (env === 'prod') {
        const q = { env, dbName, sql: req.sql, maxRows: 100, mask: true } as DbSelectAsk;
        svc.asks.push(q);
        if (!(await ask(q))) return { status: 'denied', env, dbName };
      }
      return {
        status: 'ok',
        env,
        dbName,
        connectionId: env === 'prod' ? 'd3' : 'd1',
        result: {
          columns: [{ name: 'ORDER_NO' }, { name: 'CNT' }, ...(env === 'prod' ? [{ name: 'CUST_NM', masked: true }] : [])],
          rows: env === 'prod' ? [[1001, 2, '****']] : [[1001, 2], [1002, 3]],
          rowCount: env === 'prod' ? 1 : 2,
          truncated: false,
          ms: 12,
          maskedColumns: env === 'prod' ? ['CUST_NM'] : [],
        },
      };
    },
    async propose(req: { root: string; env?: 'dev' | 'qa' | 'prod'; sql: string; description?: string; revertSql?: string; conversationId?: string }): Promise<QueryCard> {
      const card: QueryCard = {
        id: `qc${svc.cards.length + 1}`,
        root: req.root,
        conversationId: req.conversationId,
        env: req.env ?? 'dev',
        connectionId: 'd1',
        dbName: 'shop_dev',
        kind: /^\s*delete/i.test(req.sql) ? 'delete' : 'other',
        sql: req.sql,
        description: req.description,
        estimate: 1284,
        irreversible: false,
        revertSql: req.revertSql,
        canExecute: true,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      svc.cards.push(card);
      return card;
    },
    onCard(fn: (c: QueryCard) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emitCard(c: QueryCard) {
      for (const l of listeners) l(c);
    },
  };
  return svc;
}
