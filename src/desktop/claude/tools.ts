// Claude가 DB를 다루는 도구 (Agent SDK 사용자 정의 도구 = 앱 안의 MCP 서버 'projdb')
//   db_list            연결된 DB (환경·이름·종류만. 주소·계정·비밀번호는 주지 않음)
//   db_select          SELECT 하나 실행 (DbService가 SQL 판정·읽기 전용 세션·행 수·시간 제한·개인정보 가림. 운영은 사용자 확인)
//   db_propose_change  SELECT 외 쿼리 → 쿼리 카드 (실행은 사용자가 화면에서 확인한 뒤)
import { z } from 'zod';
import { ENV_LABEL, type DbConnection, type Env, type QueryCard, type QueryResult } from '../../shared/desktop-api';
import { services, type DbSelectAsk } from '../services';
import type { createSdkMcpServer as CreateServer, tool as ToolFn } from './sdk';

export const DB_TOOL_NAMES = ['mcp__projdb__db_list', 'mcp__projdb__db_select', 'mcp__projdb__db_propose_change'];

export interface ToolText {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface DbToolContext {
  root: string | null;
  conversationId: string;
  /** 운영(또는 '매번 확인') 조회를 사용자에게 묻는다 */
  ask(q: DbSelectAsk): Promise<boolean>;
  onSelect(info: { env: Env; db: string; sql: string; rows: number; maskedColumns: string[]; ms: number }): void;
  onProposal(card: QueryCard): void;
  onNotice(n: { text: string; msg?: string; vars?: Record<string, string | number> }): void;
}

export interface DbToolHandlers {
  db_list(args: Record<string, never>): Promise<ToolText>;
  db_select(args: { sql: string; env?: Env; max_rows?: number }): Promise<ToolText>;
  db_propose_change(args: { sql: string; env?: Env; description: string; revert_sql?: string }): Promise<ToolText>;
}

const text = (t: string, isError = false): ToolText => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const KIND_LABEL: Record<string, string> = { oracle: 'Oracle', mysql: 'MySQL', mariadb: 'MariaDB' };
const MAX_TEXT = 60000;

function cell(v: string | number | null): string {
  if (v === null || v === undefined) return 'NULL';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎');
}

export function formatResult(env: Env, dbName: string, r: QueryResult): string {
  const head = [
    `환경: ${ENV_LABEL[env]}(${env}) · DB: ${dbName} · ${r.rowCount}행${r.truncated ? ' (행 수 제한으로 일부만)' : ''} · ${r.ms}ms`,
    r.maskedColumns.length ? `개인정보 가림 컬럼(값이 ****): ${r.maskedColumns.join(', ')}` : '',
  ].filter(Boolean);
  if (!r.columns.length) return head.join('\n');
  const lines = [`| ${r.columns.map((c) => cell(c.name)).join(' | ')} |`, `| ${r.columns.map(() => '---').join(' | ')} |`];
  let size = lines.join('\n').length;
  let shown = 0;
  for (const row of r.rows) {
    const l = `| ${row.map(cell).join(' | ')} |`;
    if (size + l.length > MAX_TEXT) break;
    lines.push(l);
    size += l.length + 1;
    shown++;
  }
  if (shown < r.rows.length) lines.push(`(글자 수 제한으로 ${r.rows.length - shown}행 생략)`);
  return [...head, '', ...lines].join('\n');
}

export function makeDbHandlers(ctx: DbToolContext): DbToolHandlers {
  const noRoot = '원본 폴더 없이 연 프로젝트(ZIP·결과 파일)라 DB 연결이 없습니다. 필요한 조회 SQL을 사용자에게 안내해 주세요.';
  const noDb = 'DB 기능이 아직 준비되지 않았습니다. 필요한 SQL을 답변에 적어 사용자에게 안내해 주세요.';
  return {
    async db_list() {
      if (!ctx.root) return text(noRoot);
      const db = services.db;
      if (!db) return text(noDb);
      let list: DbConnection[];
      try {
        list = await db.list(ctx.root);
      } catch (e) {
        return text(`DB 연결 목록을 읽지 못했습니다: ${(e as Error).message}`, true);
      }
      if (!list.length) return text('연결된 DB가 없습니다. 사용자에게 프로젝트 연결(상단 프로젝트 이름)에서 개발 DB를 등록해 달라고 안내해 주세요.');
      const rows = list.map((c) => {
        const extra = [KIND_LABEL[c.kind] ?? c.kind, c.readUser ? '조회 전용 계정 있음' : '', c.hasPassword ? '' : '변경 쿼리 실행 계정 없음(SQL 복사만)', c.lastTest ? (c.lastTest.ok ? '연결 확인됨' : '최근 연결 실패') : '']
          .filter(Boolean)
          .join(' · ');
        return `- ${ENV_LABEL[c.env]}(${c.env}): ${c.name} · ${extra}`;
      });
      return text(`연결된 DB (기본 조회 대상은 개발):\n${rows.join('\n')}`);
    },

    async db_select(args) {
      if (!ctx.root) return text(noRoot);
      const db = services.db;
      if (!db) return text(noDb);
      const sql = String(args.sql ?? '').trim();
      if (!sql) return text('sql이 비어 있습니다.', true);
      try {
        const out = await db.select(
          { root: ctx.root, env: args.env, sql, maxRows: typeof args.max_rows === 'number' ? args.max_rows : undefined, conversationId: ctx.conversationId },
          (q) => ctx.ask(q),
        );
        switch (out.status) {
          case 'ok': {
            const r = out.result!;
            const env = out.env ?? args.env ?? 'dev';
            const dbName = out.dbName ?? '';
            ctx.onSelect({ env, db: dbName, sql, rows: r.rowCount, maskedColumns: r.maskedColumns ?? [], ms: r.ms });
            return text(formatResult(env, dbName, r));
          }
          case 'denied':
            return text('사용자가 이 조회를 거부했습니다. 같은 조회를 다시 요청하지 말고, 조회 없이 설명하거나 사용자에게 다른 방법을 물어보세요.');
          case 'rejected':
            return text(`실행하지 않았습니다: ${out.message ?? 'SELECT 문 하나만 조회할 수 있습니다'}. 데이터를 바꾸는 쿼리는 db_propose_change로 제안해 주세요.`, true);
          case 'none':
            return text(out.message ?? '조회할 DB 연결이 없습니다. 사용자에게 프로젝트 연결에서 DB를 등록해 달라고 안내해 주세요.');
          case 'error':
          default: {
            const name = out.dbName ?? '';
            if (/connect|연결|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ORA-12|ORA-01017|Access denied|timeout/i.test(out.message ?? ''))
              ctx.onNotice({ text: `DB ${name}에 연결하지 못했습니다.`, msg: 'MSG-36', vars: { DB: name } });
            return text(`조회하지 못했습니다: ${out.message ?? '알 수 없는 오류'}`, true);
          }
        }
      } catch (e) {
        return text(`조회하지 못했습니다: ${(e as Error).message}`, true);
      }
    },

    async db_propose_change(args) {
      if (!ctx.root) return text(noRoot);
      const db = services.db;
      if (!db) return text(noDb);
      const sql = String(args.sql ?? '').trim();
      if (!sql) return text('sql이 비어 있습니다.', true);
      try {
        const card = await db.propose({
          root: ctx.root,
          env: args.env,
          sql,
          description: args.description ? String(args.description).slice(0, 2000) : undefined,
          revertSql: args.revert_sql ? String(args.revert_sql) : undefined,
          conversationId: ctx.conversationId,
        });
        ctx.onProposal(card);
        const est = typeof card.estimate === 'number' ? `예상 영향 ${card.estimate}행` : card.estimateNote ? `예상 행 수 미확인(${card.estimateNote})` : '예상 행 수 미확인';
        const how = card.canExecute ? '사용자가 쿼리 카드에서 확인한 뒤 실행합니다' : '이 연결은 조회 전용 계정뿐이라 사용자가 SQL을 복사해 직접 실행합니다';
        return text(`쿼리 카드를 만들었습니다 (${ENV_LABEL[card.env]} DB ${card.dbName}, ${card.kind.toUpperCase()}, ${est}). 아직 실행하지 않았고 ${how}. 실행 결과를 기다리지 말고 답변을 마무리하세요.`);
      } catch (e) {
        return text(`쿼리 카드를 만들지 못했습니다: ${(e as Error).message}`, true);
      }
    },
  };
}

const envSchema = z.enum(['dev', 'qa', 'prod']);

/** SDK MCP 서버로 묶는다. 시험용으로 손잡이를 __handlers에 숨겨 둔다 */
export function createDbServer(createServer: typeof CreateServer, toolFn: typeof ToolFn, h: DbToolHandlers): ReturnType<typeof CreateServer> {
  const tools = [
    toolFn('db_list', '이 프로젝트에 연결된 DB 목록(환경·DB 이름·종류)을 본다. 접속 주소·계정은 주지 않는다.', {}, async () => h.db_list({})),
    toolFn(
      'db_select',
      'SELECT 문 하나를 실행해 결과를 본다. 기본은 개발(dev) DB. QA(qa)·운영(prod)은 사용자가 그 환경을 말했을 때만 env로 지정한다. 운영 조회는 사용자가 매번 확인하고, 개인정보 컬럼은 가려진다. SELECT가 아닌 쿼리는 실행되지 않는다.',
      {
        sql: z.string().describe('실행할 SELECT 문 하나 (세미콜론 없이)'),
        env: envSchema.optional().describe('dev(기본)·qa·prod'),
        max_rows: z.number().int().positive().max(5000).optional().describe('최대 행 수 (환경 규칙의 한도를 넘지 않음)'),
      },
      async (args) => h.db_select(args as { sql: string; env?: Env; max_rows?: number }),
    ),
    toolFn(
      'db_propose_change',
      'INSERT·UPDATE·DELETE·MERGE·DDL·프로시저 호출 등 SELECT가 아닌 쿼리를 제안한다. 실행하지 않고 사용자 화면에 쿼리 카드로 보여 주며, 사용자가 확인한 뒤 실행한다.',
      {
        sql: z.string().describe('제안할 SQL 문 하나'),
        env: envSchema.optional().describe('대상 환경 dev(기본)·qa·prod'),
        description: z.string().describe('이 쿼리가 하는 일과 이유 (한국어 한두 문장)'),
        revert_sql: z.string().optional().describe('되돌리는 SQL (가능하면)'),
      },
      async (args) => h.db_propose_change(args as { sql: string; env?: Env; description: string; revert_sql?: string }),
    ),
  ];
  const server = createServer({ name: 'projdb', version: '1.0.0', tools });
  Object.defineProperty(server, '__handlers', { value: h, enumerable: false });
  return server;
}
