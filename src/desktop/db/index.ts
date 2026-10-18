// DB 연결·조회·쿼리 카드·메뉴 읽기 (Oracle·MySQL·MariaDB)
//   conns.ts   연결 보관 (db.json + 암호화한 비밀번호)
//   drivers.ts 드라이버 (oracledb Thin/Thick, MariaDB Connector), 읽기 전용 세션·시간 제한·행 수 제한
//   sql.ts     SQL 판정 (SELECT 하나인지, 종류, 예상 행 수 쿼리, 결과 열의 원본 컬럼)
//   mask.ts    개인정보 가림
//   query.ts   Claude의 SELECT, 연결 확인, 메뉴 테이블 읽기
//   cards.ts   SELECT 외 쿼리 카드 (사용자가 확인한 뒤 실행, 행 수가 다르면 롤백)
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DbConnectionInput, MenuDbSetting } from '../../shared/desktop-api';
import { DesktopError, handle, onShutdown } from '../ipc';
import { checkRoot } from '../project';
import { services, type DbService } from '../services';
import { dataDir, readJson } from '../store';
import { cardFromHistory, executeCard, getCard, onCard, propose, rejectCard } from './cards';
import { listConns, removeConn, saveConn } from './conns';
import { closeAll, setThickHint } from './drivers';
import { previewMenu, readMenu, selectForClaude, testConnection } from './query';

export const dbService: DbService = {
  list: (root) => listConns(root),
  select: (req, ask) => selectForClaude(req, ask),
  propose: (req) => propose(req),
  onCard: (fn) => onCard(fn),
};

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new DesktopError(`${what}가 올바르지 않습니다`, 'invalid');
  return v;
}

export function register(): void {
  services.db = dbService;
  handle('db.list', (root) => listConns(checkRoot(root)));
  handle('db.save', (root, conn) => saveConn(checkRoot(root), conn as DbConnectionInput));
  handle('db.remove', (root, id) => removeConn(checkRoot(root), str(id, '연결 ID')));
  handle('db.test', (root, idOrInput) => testConnection(checkRoot(root), idOrInput as string | DbConnectionInput));
  handle('db.readMenu', (root) => readMenu(checkRoot(root)));
  handle('db.previewMenu', (root, setting) => previewMenu(checkRoot(root), setting as MenuDbSetting));
  handle('db.card.get', (id) => getCard(str(id, '카드 ID')));
  handle('db.card.execute', (id, typedName) => executeCard(str(id, '카드 ID'), typeof typedName === 'string' ? typedName : undefined));
  handle('db.card.reject', (id) => rejectCard(str(id, '카드 ID')));
  handle('db.card.fromHistory', (root, entryId) => cardFromHistory(checkRoot(root), str(entryId, '기록 ID')));
  onShutdown(() => closeAll());
  setThickHint(anyThickConnection);
}

/** 이 PC에 저장한 연결(모든 프로젝트) 중 Oracle Thick 모드가 있는지 */
async function anyThickConnection(): Promise<boolean> {
  const base = path.join(dataDir(), 'projects');
  for (const d of await fsp.readdir(base).catch(() => [] as string[])) {
    const f = await readJson<{ connections?: { kind?: string; thick?: boolean }[] }>(path.join(base, d, 'db.json'), {});
    if (f.connections?.some((c) => c.kind === 'oracle' && c.thick)) return true;
  }
  return false;
}
