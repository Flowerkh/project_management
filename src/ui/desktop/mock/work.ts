// 미리보기: 작업 사본·변경·형상관리·작업 이력 (화면설계서 SCR-10·SCR-12·POP-04와 같은 예시)
//   ?mock=1&desk&view=changes:W1   변경 검토 (OrderServiceImpl −1, OrderClaimServiceImpl +1)
//   ?mock=1&desk&view=history[:id] 작업 이력 (오늘 11:04 쿼리 실행 … 어제 15:30 되돌리기)
import type {
  ApplyRequest, ApplyResult, FileChange, HistoryEntry, QueryCard, VcsCheck, VcsInfo, WorkCopy,
} from '../../../shared/desktop-api';
import type { MockHandler, MockKit } from './index';

const WORK_DIR = 'C:\\Users\\hong\\AppData\\Roaming\\ProjectAnalyzer\\work';
const IMPL = 'src/main/java/egovframework/egov/shop/order/service/impl';
const COMMIT_ERR = "fatal: unable to access 'https://gitlab.company.local/shop/shop-admin.git/': The requested URL returned error: 403";

function at(dayOffset: number, h: number, m: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function changesW1(): FileChange[] {
  return [
    {
      path: `${IMPL}/OrderServiceImpl.java`,
      status: 'modified',
      plus: 0,
      minus: 1,
      hunks: [
        {
          oldStart: 126,
          newStart: 126,
          fn: 'updateDlvyInfo()',
          lines: [
            { t: ' ', s: '    public void updateDlvyInfo(OrderVO vo) throws Exception {', o: 126, n: 126 },
            { t: ' ', s: '        orderMapper.updateOrderDlvy(vo);', o: 127, n: 127 },
            { t: ' ', s: '        if ("DLVY".equals(vo.getOrderStat())) {', o: 128, n: 128 },
            { t: ' ', s: '            orderMapper.updateDlvyStat(vo);', o: 129, n: 129 },
            { t: ' ', s: '        }', o: 130, n: 130 },
            { t: '-', s: '        orderMapper.insertOrderHist(vo);', o: 131 },
            { t: ' ', s: '    }', o: 132, n: 131 },
          ],
        },
      ],
    },
    {
      path: `${IMPL}/OrderClaimServiceImpl.java`,
      status: 'modified',
      plus: 1,
      minus: 0,
      hunks: [
        {
          oldStart: 52,
          newStart: 52,
          fn: 'insertClaim()',
          lines: [
            { t: ' ', s: '    public void insertClaim(OrderClaimVO claimVO) throws Exception {', o: 52, n: 52 },
            { t: ' ', s: '        orderClaimMapper.insertClaim(claimVO);', o: 53, n: 53 },
            { t: ' ', s: '        OrderVO orderVO = orderMapper.selectOrder(claimVO.getOrderNo());', o: 54, n: 54 },
            { t: ' ', s: '        orderService.updateDlvyInfo(orderVO);', o: 55, n: 55 },
            { t: '+', s: '        orderMapper.insertOrderHist(orderVO);', n: 56 },
            { t: ' ', s: '    }', o: 56, n: 57 },
          ],
        },
      ],
    },
  ];
}

const DELETE_SQL = 'DELETE FROM TB_ORDER_HIST H\n WHERE H.ROWID NOT IN (\n       SELECT MIN(ROWID)\n         FROM TB_ORDER_HIST\n        GROUP BY ORDER_NO, ORDER_STAT, REG_DT)';

function historyInit(): HistoryEntry[] {
  return [
    {
      id: 'hm-1104',
      at: at(0, 11, 4),
      kind: 'query',
      title: '주문 이력 중복 1,284건 삭제',
      status: '실행됨',
      sql: DELETE_SQL,
      db: { env: 'dev', name: 'shop_dev', account: 'shop_app' },
      expected: 1284,
      affected: 1284,
      ms: 800,
      conversationId: 'c-1',
      revertSql: 'INSERT INTO TB_ORDER_HIST\nSELECT * FROM TB_ORDER_HIST_BAK_1017\n WHERE ROWID NOT IN (SELECT ROWID FROM TB_ORDER_HIST)',
      steps: [
        { at: at(0, 11, 4), label: '실행', detail: '1,284행 · 예상과 같음', ok: true },
        { at: at(0, 11, 4), label: '확정', detail: '0.8초 · 커밋함', ok: true },
      ],
    },
    {
      id: 'hm-1102',
      at: at(0, 11, 2),
      kind: 'apply',
      title: '주문 이력 중복 저장 수정',
      status: '커밋됨',
      files: [
        { path: `${IMPL}/OrderServiceImpl.java`, status: 'modified', plus: 0, minus: 1 },
        { path: `${IMPL}/OrderClaimServiceImpl.java`, status: 'modified', plus: 1, minus: 0 },
      ],
      commit: '7d2e1f0',
      branch: 'develop',
      pushed: false,
      vcs: 'git',
      workId: 'W0',
      workPath: `${WORK_DIR}\\shop-admin-c1`,
      message: 'fix: 주문 상태 변경 시 이력 중복 저장 수정 (Claude가 작성한 변경)',
      want: { commit: true, push: false },
      conversationId: 'c-1',
      steps: [
        { at: at(0, 11, 2), label: '적용', detail: "파일 2개 · 확인 창에서 '적용 후 커밋'을 고름 · 푸시는 하지 않음", ok: true },
        { at: at(0, 11, 2), label: '커밋', detail: '7d2e1f0 · "fix: 주문 상태 변경 시 이력 중복 저장 수정 (Claude가 작성한 변경)"', ok: true },
        { at: at(0, 11, 3), label: '다시 분석', detail: '4초 · 주문상세·반품·교환의 TB_ORDER_HIST 사용(C)은 그대로 · 바뀐 연결 없음', ok: true },
      ],
    },
    {
      id: 'hm-1052',
      at: at(0, 10, 52),
      kind: 'prod-select',
      title: '운영 DB 중복 이력 건수 확인',
      status: '조회',
      sql: 'SELECT COUNT(*) AS DUP_CNT\n  FROM (SELECT ORDER_NO, ORDER_STAT, REG_DT, COUNT(*) CNT\n          FROM TB_ORDER_HIST\n         GROUP BY ORDER_NO, ORDER_STAT, REG_DT\n        HAVING COUNT(*) > 1)',
      db: { env: 'prod', name: 'shop_prd', account: 'shop_read' },
      affected: 1,
      ms: 320,
      maskedColumns: [],
      conversationId: 'c-1',
    },
    {
      id: 'hm-1740',
      at: at(-1, 17, 40),
      kind: 'apply',
      title: '반품 사유 공통코드 화면 추가',
      status: '적용됨',
      files: [
        { path: 'src/main/java/egovframework/egov/shop/order/web/ClaimCodeController.java', status: 'added', plus: 48, minus: 0 },
        { path: 'src/main/webapp/WEB-INF/jsp/order/claimCode.jsp', status: 'added', plus: 62, minus: 0 },
        { path: 'src/main/resources/egovframework/mapper/order/OrderMapper.xml', status: 'modified', plus: 14, minus: 0 },
      ],
      branch: 'develop',
      vcs: 'git',
      workId: 'W-old2',
      workPath: `${WORK_DIR}\\shop-admin-b7`,
      want: { commit: false, push: false },
      steps: [
        { at: at(-1, 17, 40), label: '적용', detail: '파일 3개 · 커밋하지 않음', ok: true },
        { at: at(-1, 17, 41), label: '다시 분석', detail: '5초 · 화면 42→43개', ok: true },
      ],
    },
    {
      id: 'hm-1612',
      at: at(-1, 16, 12),
      kind: 'query',
      title: '배송 완료 주문 상태 일괄 변경',
      status: '롤백됨',
      sql: "UPDATE TB_ORDER\n   SET ORDER_STAT = 'DC'\n WHERE ORDER_STAT = 'DL'\n   AND DLVY_END_DT < SYSDATE - 7",
      db: { env: 'qa', name: 'shop_qa', account: 'shop_app' },
      expected: 12,
      affected: 15,
      ms: 400,
      steps: [
        { at: at(-1, 16, 12), label: '실행', detail: '15행 · 예상 12행과 다름', ok: false },
        { at: at(-1, 16, 12), label: '롤백', detail: '데이터는 바뀌지 않음', ok: true },
      ],
    },
    {
      id: 'hm-1530',
      at: at(-1, 15, 30),
      kind: 'revert',
      title: '상품 목록 정렬 오류 수정',
      status: '되돌림',
      files: [{ path: 'src/main/resources/egovframework/mapper/product/ProductMapper.xml', status: 'modified', plus: 1, minus: 1 }],
      branch: 'develop',
      vcs: 'git',
      revertOf: 'hm-old-1120',
      steps: [{ at: at(-1, 15, 30), label: '되돌리기', detail: `파일 1개 · ${(() => { const d = new Date(at(-1, 11, 20)); const p = (x: number) => String(x).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })()}에 적용한 변경을 적용 전 내용으로 되돌림`, ok: true }],
    },
  ];
}

/** 상태 미리보기: &wv=conflict(MSG-31) · states(새 파일·EUC-KR·적용 불가·원래 변경) · commitfail(MSG-25) · revertblocked(MSG-40) · empty */
const WV = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('wv') : null;

function variant(list: FileChange[]): FileChange[] {
  if (WV === 'empty') return [];
  if (WV === 'conflict') list[0].conflict = true;
  if (WV === 'states') {
    list[1].dirtyBase = true;
    list.push(
      {
        path: 'src/main/webapp/WEB-INF/jsp/order/claimList.jsp',
        status: 'modified',
        plus: 1,
        minus: 1,
        encoding: 'EUC-KR',
        hunks: [
          {
            oldStart: 40,
            newStart: 40,
            lines: [
              { t: ' ', s: '<tr>', o: 40, n: 40 },
              { t: '-', s: '  <th>처리 상태</th>', o: 41 },
              { t: '+', s: '  <th>처리 상태(반품·교환)</th>', n: 41 },
              { t: ' ', s: '</tr>', o: 42, n: 42 },
            ],
          },
        ],
      },
      {
        path: 'src/main/java/egovframework/egov/shop/order/service/impl/OrderHistUtil.java',
        status: 'added',
        plus: 6,
        minus: 0,
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            fn: 'OrderHistUtil',
            lines: [
              { t: '+', s: 'package egovframework.egov.shop.order.service.impl;', n: 1 },
              { t: '+', s: '', n: 2 },
              { t: '+', s: 'final class OrderHistUtil {', n: 3 },
              { t: '+', s: '    /** 이력을 한 번만 남기는지 확인 */', n: 4 },
              { t: '+', s: '    static boolean once(String stat) { return stat != null; }', n: 5 },
              { t: '+', s: '}', n: 6 },
            ],
          },
        ],
      },
      {
        path: 'src/main/resources/egovframework/egovProps/globals.properties',
        status: 'modified',
        plus: 1,
        minus: 1,
        redacted: true,
        blocked: '접속 정보 파일이라 적용할 수 없습니다 (작업 사본은 값을 가린 파일입니다)',
        hunks: [
          {
            oldStart: 4,
            newStart: 4,
            lines: [
              { t: ' ', s: 'Globals.Url = jdbc:oracle:thin:@****', o: 4, n: 4 },
              { t: '-', s: 'Globals.UserName = ****', o: 5 },
              { t: '+', s: 'Globals.UserName = shop_app2', n: 5 },
              { t: ' ', s: 'Globals.Password = ****', o: 6, n: 6 },
            ],
          },
        ],
      },
    );
  }
  return list;
}

export function workMocks(kit: MockKit): Record<string, MockHandler> {
  const st = kit.state as {
    w1Changes?: FileChange[];
    history?: HistoryEntry[];
    works?: Record<string, WorkCopy>;
  };
  st.w1Changes ??= variant(changesW1());
  st.history ??= historyInit();
  st.works ??= {
    W1: {
      id: 'W1',
      root: kit.root,
      path: `${WORK_DIR}\\shop-admin-c1`,
      createdAt: at(0, 10, 42),
      conversationId: 'c-1',
      fileCount: 688,
      base: { kind: 'git', branch: 'develop', head: '9c1e2ab', dirty: 0 },
      redacted: 2,
    },
  };
  const history = () => st.history!;
  const vcs: VcsInfo = {
    kind: 'git',
    toolFound: true,
    repoRoot: kit.root,
    branch: 'develop',
    head: '9c1e2ab',
    remote: 'https://gitlab.company.local/shop/shop-admin.git',
    hostLabel: '사내 GitLab',
    dirty: 0,
  };
  const emitUpdate = (e: HistoryEntry) => kit.emit({ type: 'history.updated', root: kit.root, entry: e });
  const find = (id: string) => history().find((e) => e.id === id) ?? null;

  return {
    'vcs.detect': () => vcs,
    'vcs.check': async (): Promise<VcsCheck> => {
      await kit.sleep(300);
      return {
        remote: { ok: true, message: '원격 저장소 연결됨' },
        login: 'Git Credential Manager 로그인 hong.gd',
        space: { ok: true, freeBytes: 12.4 * 1024 ** 3, path: WORK_DIR },
      };
    },
    'work.get': (id: string) => st.works![id] ?? null,
    'work.list': () => Object.values(st.works!).map((w) => ({ ...w, changed: w.id === 'W1' ? st.w1Changes!.length : 0 })),
    'work.create': async (root: string, conversationId?: string) => {
      await kit.sleep(400);
      const id = `W${Object.keys(st.works!).length + 1}`;
      const w: WorkCopy = { id, root, path: `${WORK_DIR}\\shop-admin-${id.toLowerCase()}`, createdAt: new Date().toISOString(), conversationId, fileCount: 688, base: { kind: 'git', branch: 'develop', head: '9c1e2ab', dirty: 0 } };
      st.works![id] = w;
      return w;
    },
    'work.changes': (id: string) => (id === 'W1' ? st.w1Changes! : []),
    'work.discard': (id: string, files?: string[]) => {
      if (id === 'W1') st.w1Changes = files ? st.w1Changes!.filter((c) => !files.includes(c.path)) : [];
      return id === 'W1' ? st.w1Changes! : [];
    },
    'work.refresh': (_id: string, files: string[]) => files,
    'work.apply': async (id: string, req: ApplyRequest): Promise<ApplyResult> => {
      await kit.sleep(500);
      const sel = (id === 'W1' ? st.w1Changes! : []).filter((c) => req.files.includes(c.path));
      const conflicts = sel.filter((c) => c.conflict).map((c) => c.path);
      if (conflicts.length) return { ok: false, conflicts, applied: [] };
      if (id === 'W1') st.w1Changes = st.w1Changes!.filter((c) => !req.files.includes(c.path));
      const fail = WV === 'commitfail' && req.commit;
      const now = new Date().toISOString();
      const entry: HistoryEntry = {
        id: `hm-${Date.now()}`,
        at: now,
        kind: 'apply',
        title: req.title,
        status: req.commit ? (req.push ? '푸시됨' : '커밋됨') : '적용됨',
        files: sel.map((c) => ({ path: c.path, status: c.status, plus: c.plus, minus: c.minus })),
        branch: 'develop',
        vcs: 'git',
        workId: id,
        workPath: st.works![id]?.path,
        conversationId: req.conversationId,
        want: { commit: req.commit, push: req.push },
        ...(req.commit && !fail ? { commit: '7d2e1f0', message: `${req.title} (Claude가 작성한 변경)`, pushed: req.push } : {}),
        ...(fail ? { status: '적용됨' as const, error: `Git 커밋에 실패했습니다: ${COMMIT_ERR}. 파일은 적용된 상태로 남아 있습니다. PC의 Git·SVN 로그인과 원격 상태를 확인한 뒤 작업 이력에서 다시 시도해 주세요.` } : {}),
        steps: [
          { at: now, label: '적용', detail: `파일 ${sel.length}개 · ${req.commit ? (req.push ? "확인 창에서 '적용 후 커밋'·'커밋 후 푸시'를 고름" : "확인 창에서 '적용 후 커밋'을 고름 · 푸시는 하지 않음") : '커밋하지 않음'}`, ok: true },
          ...(fail ? [{ at: now, label: '커밋', detail: COMMIT_ERR, ok: false }] : []),
          ...(req.commit && !fail ? [{ at: now, label: '커밋', detail: `7d2e1f0 · "${req.title} (Claude가 작성한 변경)"`, ok: true }] : []),
          ...(req.push && !fail ? [{ at: now, label: '푸시', detail: 'origin develop · 원격 저장소에 올림', ok: true }] : []),
        ],
      };
      history().unshift(entry);
      kit.emit({ type: 'history.added', root: kit.root, entry });
      if (fail) return { ok: true, historyId: entry.id, applied: sel.map((c) => c.path), commit: { ok: false, error: COMMIT_ERR } };
      return { ok: true, historyId: entry.id, applied: sel.map((c) => c.path), ...(req.commit ? { commit: { ok: true, hash: '7d2e1f0' } } : {}), ...(req.push ? { push: { ok: true } } : {}) };
    },
    'history.list': () => history().filter((e) => e.kind !== 'select'),
    'history.diff': (_root: string, id: string) => (id === 'hm-1102' || find(id)?.workId === 'W1' ? changesW1() : []),
    'history.drift': (): FileChange[] => [
      {
        path: `${IMPL}/OrderServiceImpl.java`,
        status: 'modified',
        plus: 2,
        minus: 0,
        hunks: [
          {
            oldStart: 128,
            newStart: 128,
            fn: 'updateDlvyInfo()',
            lines: [
              { t: ' ', s: '        if ("DLVY".equals(vo.getOrderStat())) {', o: 128, n: 128 },
              { t: ' ', s: '            orderMapper.updateDlvyStat(vo);', o: 129, n: 129 },
              { t: '+', s: '            // 배송 완료 알림 (적용 뒤 다른 작업으로 추가됨)', n: 130 },
              { t: '+', s: '            notifyService.sendDlvyDone(vo);', n: 131 },
              { t: ' ', s: '        }', o: 130, n: 132 },
            ],
          },
        ],
      },
    ],
    'history.step': (_root: string, id: string, step: { label: string; detail?: string; ok: boolean }) => {
      const e = find(id);
      if (!e) return null;
      e.steps = [...(e.steps ?? []), { at: new Date().toISOString(), ...step }];
      emitUpdate(e);
      return e;
    },
    'history.retry': (_root: string, id: string) => {
      const e = find(id);
      if (!e) return null;
      e.status = '커밋됨';
      e.commit = e.commit ?? '7d2e1f0';
      delete e.error;
      emitUpdate(e);
      return e;
    },
    'history.revert': async (_root: string, id: string) => {
      await kit.sleep(300);
      const e = find(id);
      if (!e) return { ok: false, error: '기록을 찾을 수 없습니다' };
      if (WV === 'revertblocked') return { ok: false, blocked: (e.files ?? []).slice(0, 1).map((f) => f.path) };
      const now = new Date().toISOString();
      const rv: HistoryEntry = {
        id: `hm-r${Date.now()}`,
        at: now,
        kind: 'revert',
        title: e.title,
        status: '되돌림',
        files: (e.files ?? []).map((f) => ({ ...f, plus: f.minus, minus: f.plus })),
        branch: e.branch,
        vcs: e.vcs,
        revertOf: e.id,
        conversationId: e.conversationId,
        steps: [{ at: now, label: '되돌리기', detail: `파일 ${e.files?.length ?? 0}개 · 적용 전 내용으로 되돌림`, ok: true }],
      };
      e.revertedBy = rv.id;
      history().unshift(rv);
      kit.emit({ type: 'history.added', root: kit.root, entry: rv });
      return { ok: true, historyId: rv.id };
    },
    'history.exportCsv': () => 'C:\\Users\\hong\\Documents\\shop-admin_작업이력.csv',
    'db.card.fromHistory': (_root: string, id: string): QueryCard => {
      const e = find(id);
      return {
        id: `qc-${id}`,
        root: kit.root,
        conversationId: e?.conversationId,
        env: e?.db?.env ?? 'dev',
        connectionId: 'db-dev',
        dbName: e?.db?.name ?? 'shop_dev',
        kind: 'insert',
        sql: e?.revertSql ?? '',
        description: `'${e?.title ?? ''}'를 되돌리는 SQL`,
        estimate: 1284,
        irreversible: false,
        canExecute: true,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
    },
  };
}
