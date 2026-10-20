// 미리보기: Claude 연동 (?mock&desk). 실제 Claude를 부르지 않고, 화면설계서 SCR-09·SCR-11 이야기를 시간차를 두고 흉내 낸다.
// URL 인자
//   &chat                 진행된 대화(주문 이력 중복 저장)가 열린 패널
//   &cerr=auth|offline|limit|billing   보내면 그 오류로 멈춤 (열린 대화 끝에도 오류 표시)
//   &cstate=off|login|missing|offline  Claude 연결 상태 (상단 점·POP-03·패널 배너)
//   &phase=new [&nstep=plan|gen|done] [&nfolder=dirty]   SCR-11 새 프로젝트
import type {
  AiProvider, AiSettings, ChatContext, ChatItem, ChatMode, ClaudeConfig, ClaudeConfigInput, ClaudeErrorCode, ClaudeModelList, ClaudeStartOptions, ClaudeStatus, Conversation,
  ConversationSummary, PendingRequest, QueryCard,
} from '../../../shared/desktop-api';
import { AI_LABEL } from '../../../shared/desktop-api';
import { makeMock } from '../../mock';
import { buildModel } from '../../model';
import { buildChatContext } from '../claude/context';
import { MOCK_DEFAULT_AI, MOCK_GEMINI_MODELS, MOCK_OPENAI_MODELS } from './ai';
import type { MockHandler, MockKit } from './index';

const P = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const CSTATE = P.get('cstate');
const CERR = P.get('cerr') as ClaudeErrorCode | null;
const NSTEP = P.get('nstep');
const NFOLDER = P.get('nfolder');

const CLI = 'C:\\Users\\hong\\.local\\bin\\claude.exe';
const VERSION = '2.1.301';
/** 미리보기용 모델 목록 (실제 목록은 PC의 Claude Code가 알려 줌) */
const MOCK_MODELS: { value: string; name: string; description: string; resolved?: string }[] = [
  { value: 'default', name: 'Default (recommended)', description: 'Sonnet · 일상 작업에 알맞은 모델', resolved: 'claude-sonnet' },
  { value: 'opus', name: 'Opus', description: '어려운 문제에 알맞은 큰 모델', resolved: 'claude-opus' },
  { value: 'sonnet', name: 'Sonnet', description: '일상 작업에 알맞은 모델', resolved: 'claude-sonnet' },
  { value: 'haiku', name: 'Haiku', description: '빠르고 가벼운 모델', resolved: 'claude-haiku' },
];
const NEW_FOLDER = 'D:\\work\\inquiry-admin';

const IMPL = 'src/main/java/egovframework/egov/shop/order/service/impl/OrderServiceImpl.java';
const CLAIM = 'src/main/java/egovframework/egov/shop/order/service/impl/OrderClaimServiceImpl.java';
const CTRL = 'src/main/java/egovframework/egov/shop/order/web/OrderController.java';
const MAPPER = 'src/main/resources/egovframework/mapper/order/OrderMapper.xml';

const clone = <T>(v: T): T => structuredClone(v);

/** 변경 카드의 파일별 줄 수 (화면설계서: OrderServiceImpl −1, OrderClaimServiceImpl +1) */
const CHANGE_STATS = [
  { path: IMPL, plus: 0, minus: 1 },
  { path: CLAIM, plus: 1, minus: 0 },
];

/** 오늘 h:m (화면설계서 시각과 맞춤) */
function at(h: number, m: number, s = 0): string {
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.toISOString();
}

const ERR_TEXT: Record<ClaudeErrorCode, string> = {
  auth: 'Claude Code에 로그인되어 있지 않습니다 (401 authentication_error)',
  offline: 'api.anthropic.com에 연결할 수 없습니다 (ENOTFOUND)',
  limit: '사용 한도에 도달했습니다. 10월 18일 15:00에 다시 쓸 수 있습니다 (rate_limit_error)',
  billing: 'Credit balance is too low to access the Anthropic API (billing_error)',
  missing: 'claude 실행 파일을 찾지 못했습니다',
  other: '알 수 없는 오류',
};

const ANSWER1 = [
  '원인은 이력 저장이 두 번 호출되기 때문입니다. `updateStat()` 메서드가 이력을 저장한 뒤(`OrderServiceImpl.java:88`) 이어서 부르는 `updateDlvyInfo()`에서 한 번 더 저장합니다(`OrderServiceImpl.java:131`). 이렇게 쌓인 중복 이력은 1,284건입니다.',
  '',
  '수정안: `updateDlvyInfo()`의 이력 저장을 지우고, 이 메서드를 따로 부르는 반품·교환 등록 `insertClaim()`에서 이력을 저장합니다.',
  '',
  '영향 범위: 주문상세, 반품·교환, TB_ORDER_HIST',
].join('\n');

const ANSWER2 = '쌓인 중복 이력 1,284건은 아래 쿼리로 지웁니다. 확인한 뒤 [실행]을 눌러 주세요.';

/** [수정 진행] 전에 보여 줄 수정 계획 (ExitPlanMode) */
const FIX_PLAN = [
  '1. `OrderServiceImpl.java:131` `updateDlvyInfo()`에서 `insertOrderHist` 호출을 지웁니다.',
  '2. `OrderClaimServiceImpl.java` `insertClaim()`에 이력 저장을 넣습니다.',
  '3. `mvn -q compile`로 컴파일을 확인합니다.',
].join('\n');

const SELECT_SQL = 'SELECT ORDER_NO, HIST_STAT_CD, COUNT(*) AS CNT\n  FROM TB_ORDER_HIST\n GROUP BY ORDER_NO, HIST_STAT_CD, REG_DT\nHAVING COUNT(*) > 1';

function queryCard(convId: string, root: string, createdAt: string): QueryCard {
  return {
    id: `Q-${convId}`,
    root,
    conversationId: convId,
    env: 'dev',
    connectionId: 'db-dev',
    dbName: 'shop_dev',
    kind: 'delete',
    sql: 'DELETE FROM TB_ORDER_HIST H\n WHERE H.ROWID NOT IN (\n       SELECT MIN(ROWID)\n         FROM TB_ORDER_HIST\n        GROUP BY ORDER_NO, HIST_STAT_CD, REG_DT\n     )',
    description: '같은 주문·상태·시각으로 두 번 저장된 이력 중 두 번째 행부터 지움',
    estimate: 1284,
    irreversible: false,
    canExecute: true,
    status: 'pending',
    createdAt,
  };
}

// ------------------------------------------------------------------ 새 프로젝트 이야기 (SCR-11)

const NP_REQ = 'shop-admin과 같은 구조로 고객 문의 관리 화면을 만들어 주세요. 목록·상세·답변 등록이 필요해요.';
const NP_INTRO = '요구사항을 정리하고 계획을 세웠습니다. 기본 구성부터 테이블·소스·화면·메뉴 데이터까지 파일 17개를 만듭니다. 왼쪽 계획을 확인하고 확정해 주세요.';
/** Claude가 ExitPlanMode로 내는 계획 (메인은 PendingRequest.detail로 보냄) */
const NP_PLAN = [
  '파일 17개를 만듭니다.',
  '',
  '## 요구사항',
  '- 고객 문의 목록·상세 조회와 답변 등록 (메뉴: 고객관리 › 문의관리)',
  '- 문의 유형은 공통코드(TB_CODE)로 관리',
  "- 답변을 등록하면 문의 상태를 '답변 완료'로 변경",
  '',
  '## 계획',
  '1. **기본 구성 4개** — pom.xml · web.xml · context-*.xml (접속 정보는 비워 둠)',
  '2. **테이블 2개 · DDL** — TB_INQUIRY, TB_INQUIRY_ANS',
  '3. **소스 8개** — VO · Mapper · Service · Controller · 스크립트',
  '4. **화면 3개** — 문의목록 · 문의상세 · 답변 등록',
  '5. **메뉴·코드 데이터** — menu_data.sql · TB_MENU 2건, 문의 유형 공통코드',
  '6. **컴파일 확인** — mvn -q compile · 실행할 때 확인',
].join('\n');

const J = 'src/main/java/egovframework/inquiry';
/** 만들 파일 묶음 (활동 항목 하나 = 한 줄) */
const NP_FILES: { summary: string; files: string[] }[] = [
  { summary: 'pom.xml 외 3개', files: ['pom.xml', 'src/main/webapp/WEB-INF/web.xml', 'src/main/resources/egovframework/spring/context-common.xml', 'src/main/resources/egovframework/spring/context-mapper.xml'] },
  { summary: 'db/schema/inquiry.sql', files: ['db/schema/inquiry.sql'] },
  {
    summary: 'InquiryVO.java 외 7개',
    files: [
      `${J}/service/InquiryVO.java`, `${J}/service/InquiryService.java`, `${J}/service/impl/InquiryServiceImpl.java`, `${J}/service/impl/InquiryDAO.java`,
      'src/main/resources/egovframework/mapper/inquiry/InquiryMapper.xml', `${J}/web/InquiryController.java`, 'src/main/webapp/js/inquiry/list.js', 'src/main/webapp/js/inquiry/answer.js',
    ],
  },
  { summary: 'WEB-INF/jsp/inquiry/list.jsp', files: ['src/main/webapp/WEB-INF/jsp/inquiry/list.jsp'] },
  { summary: 'WEB-INF/jsp/inquiry/detail.jsp', files: ['src/main/webapp/WEB-INF/jsp/inquiry/detail.jsp'] },
  { summary: 'WEB-INF/jsp/inquiry/answerForm.jsp', files: ['src/main/webapp/WEB-INF/jsp/inquiry/answerForm.jsp'] },
  { summary: 'db/data/menu_data.sql', files: ['db/data/menu_data.sql'] },
];
const NP_DONE = '파일 17개를 만들었습니다. `mvn -q compile`도 통과했습니다. 접속 정보(globals.properties)는 비워 두었으니 분석한 뒤 프로젝트 연결에서 DB를 지정해 주세요.';

// ------------------------------------------------------------------

export function claudeMocks(kit: MockKit): Record<string, MockHandler> {
  let state = CSTATE;
  const cfg: ClaudeConfig = {
    enabled: CSTATE !== 'off',
    consentAt: CSTATE !== 'off' ? at(9, 12) : undefined,
    authMode: 'login',
    hasApiKey: false,
    shellAllow: ['mvn -q compile', 'mvn -q test'],
    aiSummary: false,
  };
  const convs = new Map<string, Conversation>();
  const tokens = new Map<string, number>();
  const waiting = new Map<string, (allow: boolean) => void>();
  let seq = 10;
  let ctxCache: ChatContext | undefined;

  const storyContext = (): ChatContext | undefined => {
    if (!ctxCache) {
      try {
        ctxCache = buildChatContext(buildModel(makeMock().result), { kind: 'screen', id: 'S022' });
      } catch {
        ctxCache = undefined;
      }
    }
    return ctxCache;
  };

  // 메인(C1)과 같은 모양: 항목별 결과(checks)와 문제 종류(code)
  const status = (recheck = false): ClaudeStatus => {
    const checkedAt = new Date().toISOString();
    const skip = { ok: null };
    const cliOk = { ok: true, message: `${VERSION} · ${cfg.cliPath || CLI}` };
    if (state === 'missing') {
      const m = 'PATH와 기본 설치 위치에서 claude.exe를 찾지 못했습니다';
      return { state: 'missing', code: 'missing', checkedAt, message: m, checks: { cli: { ok: false, message: m, code: 'missing' }, network: skip, auth: skip } };
    }
    const base = { cliPath: cfg.cliPath || CLI, version: VERSION, checkedAt };
    if (state === 'offline')
      return { state: 'offline', code: 'offline', ...base, message: ERR_TEXT.offline, checks: { cli: cliOk, network: { ok: false, message: ERR_TEXT.offline, code: 'offline' }, auth: skip } };
    const net = { ok: true, message: 'api.anthropic.com 연결됨 (120ms)', ms: 120 };
    if (state === 'login')
      return { state: 'login', code: 'auth', ...base, authLabel: 'Claude Code 로그인', message: 'Claude Code에 로그인되어 있지 않습니다', checks: { cli: cliOk, network: net, auth: { ok: false, code: 'auth', message: '401 authentication_error' } } };
    const authLabel = cfg.authMode === 'apikey' ? 'API 키' : cfg.authMode === 'cloud' ? '회사 클라우드' : 'Claude Code 로그인';
    const authOk = { ok: true, ms: 1400, message: '시험 요청 성공' };
    if (!cfg.enabled) return { state: 'off', ...base, authLabel, ...(recheck ? { authMs: 1400, checks: { cli: cliOk, network: net, auth: authOk } } : {}) };
    return { state: 'on', ...base, authLabel, authMs: 1400, checks: { cli: cliOk, network: net, auth: authOk } };
  };

  // ---------------------------------------------------------------- 대화 기록 미리 채우기
  const add = (c: Conversation) => convs.set(c.id, c);

  const storyItems = (convId: string): ChatItem[] => [
    { id: 'u1', type: 'user', text: '주문 상태를 바꾸면 주문 이력이 두 번씩 쌓여요. 원인을 찾아 주세요.', at: at(10, 37) },
    {
      id: 'a1',
      type: 'activity',
      summary: '파일 2개 읽음 · insertOrderHist 검색 3곳',
      items: [
        { kind: 'read', label: '읽음', file: CTRL },
        { kind: 'read', label: '읽음', file: IMPL, line: 80 },
        { kind: 'search', label: 'insertOrderHist 검색 · 3곳' },
      ],
      at: at(10, 38),
    },
    { id: 's1', type: 'select', env: 'dev', db: 'shop_dev', sql: SELECT_SQL, rows: 1284, maskedColumns: [], ms: 412, at: at(10, 38, 30) },
    { id: 'm1', type: 'assistant', text: ANSWER1, at: at(10, 39) },
    { id: 'mode1', type: 'mode', mode: 'edit', via: 'plan', at: at(10, 41) },
    {
      id: 'a2',
      type: 'activity',
      summary: '파일 2개 수정 · mvn -q compile 성공',
      items: [
        { kind: 'edit', label: '이력 저장 지움', file: IMPL, line: 131 },
        { kind: 'edit', label: '이력 저장 추가', file: CLAIM, line: 57 },
        { kind: 'command', label: 'mvn -q compile 성공' },
      ],
      at: at(10, 42),
    },
    { id: 'ch1', type: 'changes', workId: 'W1', files: 2, plus: 1, minus: 1, paths: [IMPL, CLAIM], stats: CHANGE_STATS, at: at(10, 43) },
    { id: 'm2', type: 'assistant', text: ANSWER2, at: at(10, 43, 30) },
    { id: 'q1', type: 'query', card: queryCard(convId, kit.root, at(10, 44)), at: at(10, 44) },
  ];

  add({
    id: 'c-1',
    ...(MOCK_DEFAULT_AI !== 'claude' ? { provider: MOCK_DEFAULT_AI } : {}),
    root: kit.root,
    kind: 'issue',
    title: '주문 이력 중복 저장',
    createdAt: at(10, 37),
    updatedAt: at(10, 44),
    mode: 'edit',
    workId: 'W1',
    context: storyContext(),
    items: [
      ...storyItems('c-1'),
      ...(CERR
        ? ([
            { id: 'u2', type: 'user', text: '반품·교환 화면에서도 이력이 한 번만 쌓이는지 확인해 주세요.', at: at(10, 52) },
            { id: 'e1', type: 'error', code: CERR, message: ERR_TEXT[CERR], at: at(10, 52, 20) },
          ] as ChatItem[])
        : []),
    ],
    running: false,
  });
  add({
    id: 'c-0',
    root: kit.root,
    kind: 'issue',
    title: '결제 취소 때 재고가 원복되지 않음',
    createdAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
    updatedAt: new Date(Date.now() - 25 * 3600e3).toISOString(),
    mode: 'plan',
    items: [
      { id: 'x1', type: 'user', text: '결제를 취소해도 재고가 돌아오지 않아요.', at: new Date(Date.now() - 26 * 3600e3).toISOString() },
      { id: 'x2', type: 'assistant', text: '`OrderServiceImpl.java`의 취소 처리에서 `TB_STOCK`을 다시 늘리는 부분이 빠져 있습니다. 취소목록 화면의 환불 처리 뒤에 재고 원복을 넣으면 됩니다.', at: new Date(Date.now() - 25.5 * 3600e3).toISOString() },
    ],
    running: false,
  });

  // 새 프로젝트 미리 채우기 (&nstep): 화면이 이어 볼 수 있게 표시를 남긴다
  if (P.get('phase') === 'new') {
    try {
      if (NSTEP)
        localStorage.setItem(
          'pa.newProject',
          JSON.stringify({ folder: NEW_FOLDER, conversationId: 'np-1', refName: 'shop-admin', refAt: at(23, 50), tech: 'Java · 전자정부 3.10 · JSP · MyBatis · Oracle', ...(NSTEP !== 'plan' ? { planText: NP_PLAN } : {}) }),
        );
      else localStorage.removeItem('pa.newProject');
    } catch {
      /* 저장소 없음 */
    }
    if (NSTEP) {
      const items: ChatItem[] = [
        { id: 'n-u1', type: 'user', text: NP_REQ, at: at(10, 24) },
        { id: 'n-a1', type: 'activity', summary: '참고 결과 shop-admin 구조 확인', items: [{ kind: 'read', label: '참고 결과 요약 읽음' }, { kind: 'read', label: 'OrderController.java 구조 확인' }], at: at(10, 25) },
        { id: 'n-m1', type: 'assistant', text: NP_INTRO, at: at(10, 27) },
      ];
      let running = false;
      let pending: PendingRequest | undefined;
      let mode: ChatMode = 'plan';
      if (NSTEP === 'plan') {
        pending = { requestId: 'np-plan', kind: 'plan', title: '계획 확정', detail: NP_PLAN };
        running = true;
      } else {
        mode = 'edit';
        items.push({ id: 'n-mode', type: 'mode', mode: 'edit', via: 'plan', at: at(10, 31) });
        const upto = NSTEP === 'done' ? NP_FILES.length : 5;
        NP_FILES.slice(0, upto).forEach((g, i) =>
          items.push({ id: `n-g${i}`, type: 'activity', summary: g.summary, items: g.files.map((f) => ({ kind: 'edit', label: '생성', file: f })), at: at(10, 32 + i * 2) }),
        );
        if (NSTEP === 'done') {
          items.push({ id: 'n-cmp', type: 'activity', summary: 'mvn -q compile 성공', items: [{ kind: 'command', label: 'mvn -q compile 성공' }], at: at(10, 47) });
          items.push({ id: 'n-done', type: 'assistant', text: NP_DONE, at: at(10, 48) });
        } else {
          items.push({ id: `n-g5`, type: 'activity', summary: NP_FILES[5].summary, items: [], at: at(10, 43) });
          running = true;
        }
      }
      add({ id: 'np-1', root: NEW_FOLDER, kind: 'new', title: '고객 문의 관리 (inquiry-admin)', createdAt: at(10, 24), updatedAt: at(10, 43), mode, items, running, pending });
    }
  }

  // ---------------------------------------------------------------- 이벤트 도우미
  const emitItem = (c: Conversation, item: ChatItem) => {
    const i = c.items.findIndex((x) => x.id === item.id);
    if (i >= 0) c.items[i] = item;
    else c.items.push(item);
    c.updatedAt = item.at;
    kit.emit({ type: 'claude.item', conversationId: c.id, item: clone(item) });
  };
  const emitState = (c: Conversation) =>
    kit.emit({
      type: 'claude.state',
      conversationId: c.id,
      running: c.running,
      mode: c.mode,
      workId: c.workId,
      pending: c.pending ?? null,
      ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.activeModel ? { activeModel: c.activeModel } : {}),
    });
  const now = () => new Date().toISOString();
  const nid = (p: string) => `${p}${++seq}`;

  const runToken = (c: Conversation) => {
    const t = (tokens.get(c.id) ?? 0) + 1;
    tokens.set(c.id, t);
    return () => tokens.get(c.id) === t;
  };

  const stream = async (c: Conversation, text: string, alive: () => boolean) => {
    const id = nid('m');
    const t = now();
    const step = 7;
    for (let i = step; i < text.length && alive(); i += step) {
      emitItem(c, { id, type: 'assistant', text: text.slice(0, i), streaming: true, at: t });
      await kit.sleep(28);
    }
    emitItem(c, { id, type: 'assistant', text, at: t });
  };

  const ask = (c: Conversation, p: PendingRequest) =>
    new Promise<boolean>((resolve) => {
      c.pending = p;
      emitState(c);
      waiting.set(p.requestId, resolve);
    });

  const finish = (c: Conversation) => {
    c.running = false;
    c.pending = undefined;
    emitState(c);
  };

  const failWith = async (c: Conversation, code: ClaudeErrorCode, alive: () => boolean) => {
    await kit.sleep(700);
    if (!alive()) return;
    emitItem(c, { id: nid('e'), type: 'error', code, message: ERR_TEXT[code], at: now() });
    finish(c);
  };

  // ---------------------------------------------------------------- SCR-09 이야기
  const afterPlan = async (c: Conversation, alive: () => boolean) => {
    const mode: ChatItem = { id: nid('mode'), type: 'mode', mode: 'edit', via: 'plan', at: now() };
    c.mode = 'edit';
    emitItem(c, mode);
    emitState(c);
    await kit.sleep(600);
    if (!alive()) return;
    const aid = nid('a');
    const t = now();
    const edits: Extract<ChatItem, { type: 'activity' }>['items'] = [{ kind: 'edit', label: '이력 저장 지움', file: IMPL, line: 131 }];
    emitItem(c, { id: aid, type: 'activity', summary: '파일 1개 수정', items: [...edits], at: t });
    await kit.sleep(700);
    if (!alive()) return;
    edits.push({ kind: 'edit', label: '이력 저장 추가', file: CLAIM, line: 57 });
    emitItem(c, { id: aid, type: 'activity', summary: '파일 2개 수정', items: [...edits], at: t });
    await kit.sleep(400);
    if (!alive()) return;
    const ok = await ask(c, { requestId: nid('r'), kind: 'command', title: 'mvn -q compile', detail: 'mvn -q compile' });
    if (!alive()) return;
    c.pending = undefined;
    emitState(c);
    if (ok) {
      await kit.sleep(900);
      edits.push({ kind: 'command', label: 'mvn -q compile 성공' });
      emitItem(c, { id: aid, type: 'activity', summary: '파일 2개 수정 · mvn -q compile 성공', items: [...edits], at: t });
    } else {
      edits.push({ kind: 'command', label: 'mvn -q compile 거부함' });
      emitItem(c, { id: aid, type: 'activity', summary: '파일 2개 수정 · 컴파일 확인 안 함', items: [...edits], at: t });
    }
    await kit.sleep(500);
    if (!alive()) return;
    emitItem(c, { id: nid('ch'), type: 'changes', workId: c.workId ?? 'W1', files: 2, plus: 1, minus: 1, paths: [IMPL, CLAIM], stats: CHANGE_STATS, at: now() });
    await kit.sleep(400);
    await stream(c, ANSWER2, alive);
    if (!alive()) return;
    await kit.sleep(300);
    emitItem(c, { id: nid('q'), type: 'query', card: queryCard(c.id, c.root ?? kit.root, now()), at: now() });
    finish(c);
  };

  const issueStory = async (c: Conversation, alive: () => boolean) => {
    await kit.sleep(500);
    if (!alive()) return;
    const aid = nid('a');
    const t = now();
    const rows: Extract<ChatItem, { type: 'activity' }>['items'] = [{ kind: 'read', label: '읽음', file: CTRL }];
    emitItem(c, { id: aid, type: 'activity', summary: '파일 1개 읽음', items: [...rows], at: t });
    await kit.sleep(600);
    if (!alive()) return;
    rows.push({ kind: 'read', label: '읽음', file: IMPL, line: 80 });
    emitItem(c, { id: aid, type: 'activity', summary: '파일 2개 읽음', items: [...rows], at: t });
    await kit.sleep(600);
    if (!alive()) return;
    rows.push({ kind: 'search', label: 'insertOrderHist 검색 · 3곳' });
    emitItem(c, { id: aid, type: 'activity', summary: '파일 2개 읽음 · insertOrderHist 검색 3곳', items: [...rows], at: t });
    await kit.sleep(700);
    if (!alive()) return;
    emitItem(c, { id: nid('s'), type: 'select', env: 'dev', db: 'shop_dev', sql: SELECT_SQL, rows: 1284, maskedColumns: [], ms: 412, at: now() });
    await kit.sleep(400);
    await stream(c, ANSWER1, alive);
    if (!alive()) return;
    if (!c.root) return finish(c);
    const allow = await ask(c, { requestId: nid('r'), kind: 'plan', title: '수정 진행', detail: FIX_PLAN });
    if (!alive()) return;
    c.pending = undefined;
    if (allow) await afterPlan(c, alive);
    else {
      emitState(c);
      await stream(c, '알겠습니다. 파일은 고치지 않았습니다. 다른 방법이 필요하면 말씀해 주세요.', alive);
      finish(c);
    }
  };

  const followUp = async (c: Conversation, text: string, alive: () => boolean) => {
    await kit.sleep(450);
    if (!alive()) return;
    if (/운영/.test(text)) {
      const ok = await ask(c, {
        requestId: nid('r'),
        kind: 'prod-select',
        title: '운영 DB 조회',
        db: 'shop_prod',
        env: 'prod',
        maxRows: 100,
        mask: true,
        detail: 'Claude가 운영 DB shop_prod를 조회하려고 합니다(최대 100행, 개인정보 가림). 운영 조회는 항상 확인합니다. 실행할까요?',
        sql: "SELECT ORDER_NO, ORDER_STAT, ORDERER_NM, ORDERER_TEL\n  FROM TB_ORDER\n WHERE ORDER_DT >= TRUNC(SYSDATE) - 1\n   AND ORDER_STAT = '40'",
      });
      if (!alive()) return;
      c.pending = undefined;
      emitState(c);
      if (ok) {
        await kit.sleep(500);
        emitItem(c, { id: nid('s'), type: 'select', env: 'prod', db: 'shop_prod', sql: "SELECT ORDER_NO, ORDER_STAT, ORDERER_NM, ORDERER_TEL FROM TB_ORDER WHERE ORDER_STAT = '40'", rows: 37, maskedColumns: ['ORDERER_NM', 'ORDERER_TEL'], ms: 820, at: now() });
        await stream(c, '운영 DB에서 어제부터 배송 완료(40)로 바뀐 주문은 37건입니다. 이 중 이력이 두 번 쌓인 주문은 없습니다.', alive);
      } else await stream(c, '운영 DB 조회를 거부하셔서 개발 DB 결과만으로 답했습니다.', alive);
      return finish(c);
    }
    emitItem(c, { id: nid('a'), type: 'activity', summary: '파일 1개 읽음', items: [{ kind: 'read', label: '읽음', file: MAPPER }], at: now() });
    await kit.sleep(500);
    await stream(
      c,
      '확인했습니다. `OrderServiceImpl.java:131`의 `updateDlvyInfo()`는 이제 이력을 남기지 않고, 반품·교환 등록(`insertClaim()`)에서만 `TB_ORDER_HIST`에 저장합니다.\n\n- 주문상세에서 상태를 바꾸면 이력이 한 번만 쌓입니다.\n- 남은 중복 이력은 위 쿼리 카드로 지울 수 있습니다.',
      alive,
    );
    finish(c);
  };

  // ---------------------------------------------------------------- SCR-11 이야기
  const generate = async (c: Conversation, alive: () => boolean, from = 0) => {
    for (let g = from; g < NP_FILES.length; g++) {
      const grp = NP_FILES[g];
      const id = g === 5 && c.items.some((x) => x.id === 'n-g5') ? 'n-g5' : nid('g');
      const t = now();
      emitItem(c, { id, type: 'activity', summary: grp.summary, items: [], at: t });
      await kit.sleep(grp.files.length > 1 ? 900 : 1500);
      if (!alive()) return;
      emitItem(c, { id, type: 'activity', summary: grp.summary, items: grp.files.map((f) => ({ kind: 'edit', label: '생성', file: f })), at: t });
      await kit.sleep(300);
      if (!alive()) return;
    }
    const ok = await ask(c, { requestId: nid('r'), kind: 'command', title: 'mvn -q compile', detail: 'mvn -q compile' });
    if (!alive()) return;
    c.pending = undefined;
    emitState(c);
    await kit.sleep(900);
    emitItem(c, { id: nid('a'), type: 'activity', summary: ok ? 'mvn -q compile 성공' : '컴파일 확인 안 함', items: [{ kind: 'command', label: ok ? 'mvn -q compile 성공' : 'mvn -q compile 거부함' }], at: now() });
    await stream(c, ok ? NP_DONE : NP_DONE.replace(' `mvn -q compile`도 통과했습니다.', ''), alive);
    finish(c);
  };

  const confirmNew = async (c: Conversation, alive: () => boolean) => {
    c.mode = 'edit';
    emitItem(c, { id: nid('mode'), type: 'mode', mode: 'edit', via: 'plan', at: now() });
    emitState(c);
    await kit.sleep(500);
    if (alive()) await generate(c, alive);
  };

  const newStory = async (c: Conversation, text: string, alive: () => boolean) => {
    const confirmed = c.mode === 'edit';
    await kit.sleep(500);
    if (!alive()) return;
    if (confirmed) {
      if (/이어서/.test(text)) {
        const doneGroups = NP_FILES.findIndex((g) => !c.items.some((x) => x.type === 'activity' && x.items.some((r) => r.file === g.files[0])));
        return generate(c, alive, doneGroups < 0 ? NP_FILES.length : doneGroups);
      }
      if (/계획대로|생성을 시작/.test(text)) return generate(c, alive);
      await stream(c, '알겠습니다. 말씀하신 내용은 생성이 끝난 뒤 반영하겠습니다.', alive);
      return finish(c);
    }
    emitItem(c, { id: nid('a'), type: 'activity', summary: '참고 결과 shop-admin 구조 확인', items: [{ kind: 'read', label: '참고 결과 요약 읽음' }, { kind: 'read', label: 'OrderController.java 구조 확인' }], at: now() });
    await kit.sleep(700);
    await stream(c, NP_INTRO, alive);
    if (!alive()) return;
    const ok = await ask(c, { requestId: nid('r'), kind: 'plan', title: '계획 확정', detail: NP_PLAN });
    if (!alive()) return;
    c.pending = undefined;
    if (ok) await confirmNew(c, alive);
    else {
      emitState(c);
      await stream(c, '알겠습니다. 바꿀 점을 알려 주시면 계획을 다시 세우겠습니다.', alive);
      finish(c);
    }
  };

  let resumedGen = false;

  // ---------------------------------------------------------------- 채널
  return {
    'app.pickFolder': (() => {
      let first = true;
      return () => {
        if (NFOLDER === 'dirty' && first) {
          first = false;
          return { path: 'D:\\work\\old-admin', empty: false };
        }
        return { path: NEW_FOLDER, empty: true };
      };
    })(),
    'claude.status': (recheck?: boolean) => status(!!recheck),
    'claude.config.get': () => clone(cfg),
    'claude.config.set': (input: ClaudeConfigInput) => {
      const { apiKey, ...rest } = input;
      Object.assign(cfg, rest);
      if (apiKey !== undefined) cfg.hasApiKey = !!apiKey;
      if (!cfg.enabled) cfg.consentAt = rest.consentAt;
      kit.emit({ type: 'claude.status', status: status() });
      return clone(cfg);
    },
    'claude.openLogin': () => {
      if (state === 'login')
        setTimeout(() => {
          state = null;
          kit.emit({ type: 'claude.status', status: status() });
        }, 1500);
      return true;
    },
    'claude.pickCli': () => {
      if (state === 'missing') state = null;
      return CLI;
    },
    'claude.list': (root: string): ConversationSummary[] =>
      [...convs.values()]
        .filter((c) => c.root === root)
        .map((c) => ({ id: c.id, ...(c.provider ? { provider: c.provider } : {}), kind: c.kind, title: c.title, updatedAt: c.updatedAt, mode: c.mode, items: c.items.length })),
    'claude.get': (id: string) => {
      const c = convs.get(id);
      if (!c) return null;
      // 생성 중이던 새 프로젝트를 다시 열면 이어서 흉내 낸다
      if (id === 'np-1' && NSTEP === 'gen' && !resumedGen) {
        resumedGen = true;
        const alive = runToken(c);
        setTimeout(() => generate(c, alive, 5), 2500);
      }
      return clone(c);
    },
    'claude.start': async (root: string | null, opts?: ClaudeStartOptions) => {
      const id = `c-${++seq}`;
      const nowS = now();
      const provider: AiProvider = opts?.provider ?? (kit.state.aiSettings as AiSettings | undefined)?.defaultProvider ?? 'claude';
      // 다른 AI로 새 대화: 이전 대화의 질문·답변 글을 맥락 칩으로 (메인과 같은 모양)
      let context = opts?.context;
      const from = opts?.carryFrom ? convs.get(opts.carryFrom) : undefined;
      if (from) {
        const fromAi = AI_LABEL[from.provider ?? 'claude'];
        const text = from.items
          .map((it) => (it.type === 'user' ? `[사용자] ${it.text}` : it.type === 'assistant' ? `[${fromAi}] ${it.text}` : ''))
          .filter(Boolean)
          .join('\n\n');
        const chips = (context ?? from.context)?.chips.filter((c) => c.kind !== 'conversation') ?? [];
        if (text) chips.push({ kind: 'conversation', label: `이전 대화 (${fromAi})`, text });
        context = chips.length ? { title: context?.title ?? from.title, chips } : undefined;
      }
      const c: Conversation = {
        id,
        ...(provider !== 'claude' ? { provider } : {}),
        root,
        kind: opts?.newProject ? 'new' : 'issue',
        title: opts?.newProject ? '새 프로젝트' : context?.title ?? '새 대화',
        createdAt: nowS,
        updatedAt: nowS,
        mode: 'plan',
        context,
        ...(opts?.model !== undefined ? { model: opts.model } : {}),
        items: [],
        running: false,
        ...(root && !opts?.newProject ? { workId: 'W1' } : {}),
      };
      if (root && !opts?.newProject) {
        // 작업 사본 만들기 흉내 (688개)
        for (let d = 0; d <= 688; d += 86) {
          kit.emit({ type: 'work.progress', root, done: d, total: 688, message: d < 688 ? 'src/main/java …' : undefined });
          await kit.sleep(90);
        }
        kit.emit({ type: 'work.progress', root, done: 688, total: 688 });
      }
      add(c);
      return clone(c);
    },
    'claude.send': (id: string, text: string) => {
      const c = convs.get(id);
      if (!c) throw Object.assign(new Error('대화를 찾지 못했습니다'), { code: 'not-found' });
      const alive = runToken(c);
      emitItem(c, { id: nid('u'), type: 'user', text, at: now() });
      c.running = true;
      emitState(c);
      const code = CERR ?? (state === 'login' ? 'auth' : state === 'offline' ? 'offline' : null);
      if (code) {
        failWith(c, code, alive);
        return undefined;
      }
      if (c.kind === 'new') newStory(c, text, alive);
      else if (!c.items.some((x) => x.type === 'assistant') && /이력|중복|두 번/.test(text)) issueStory(c, alive);
      else followUp(c, text, alive);
      return undefined;
    },
    'claude.models': (): ClaudeModelList => ({
      models: MOCK_MODELS.filter((m) => m.value !== 'default').map((m) => ({ value: m.value, name: m.name, description: m.description, ...(m.resolved ? { resolved: m.resolved } : {}) })),
      defaultName: 'Default (recommended)',
      defaultDescription: 'Sonnet · 일상 작업에 알맞은 모델',
      // 미리보기용 가상 계정 (실제 계정 아님)
      ...(CSTATE === 'missing' ? {} : { account: { email: 'dev.kim@example.com', organization: '예시 회사', subscription: 'max', provider: 'firstParty' } }),
      at: now(),
    }),
    'claude.setModel': (id: string, model: string) => {
      const c = convs.get(id);
      if (!c) return;
      const before = c.model ?? cfg.model ?? '';
      c.model = model;
      if (before !== model) {
        const others = c.provider === 'gemini' ? MOCK_GEMINI_MODELS : c.provider === 'openai' ? MOCK_OPENAI_MODELS : null;
        c.activeModel = others ? model || others[0].value : (MOCK_MODELS.find((m) => m.value === (model || 'default'))?.resolved ?? model);
        const name = others
          ? (others.find((m) => m.value === model)?.name ?? (model || `${AI_LABEL[c.provider ?? 'claude']} 기본 모델`))
          : model
            ? (MOCK_MODELS.find((m) => m.value === model)?.name ?? model)
            : 'Claude Code 기본값';
        emitItem(c, { id: nid('n'), type: 'notice', text: `모델을 ${name}(으)로 바꿨습니다${c.running ? ' · 다음 응답부터 적용됩니다' : ''}`, at: now() });
      }
      emitState(c);
    },
    'claude.setMode': (id: string, mode: ChatMode) => {
      const c = convs.get(id);
      if (!c || c.mode === mode) return;
      c.mode = mode;
      emitItem(c, { id: nid('mode'), type: 'mode', mode, via: 'user', at: now() });
      emitState(c);
    },
    'claude.interrupt': (id: string) => {
      const c = convs.get(id);
      if (!c) return;
      runToken(c);
      for (const it of c.items) if (it.type === 'assistant' && it.streaming) emitItem(c, { ...it, streaming: false });
      if (c.pending) waiting.delete(c.pending.requestId);
      emitItem(c, { id: nid('n'), type: 'notice', text: '중지했습니다. 지금까지 한 작업은 그대로 남습니다.', at: now() });
      finish(c);
    },
    'claude.respond': (id: string, requestId: string, allow: boolean) => {
      const c = convs.get(id);
      if (!c) return;
      const w = waiting.get(requestId);
      if (w) {
        waiting.delete(requestId);
        w(allow);
        return;
      }
      // 미리 채운 대화의 확인 요청 (기다리는 흉내가 없을 때)
      const p = c.pending;
      c.pending = undefined;
      const alive = runToken(c);
      if (p?.kind === 'plan' && allow) {
        c.running = true;
        if (c.kind === 'new') confirmNew(c, alive);
        else afterPlan(c, alive);
      } else finish(c);
    },
    'claude.delete': (id: string) => {
      convs.delete(id);
    },
    'claude.clear': (root: string) => {
      let n = 0;
      for (const [id, c] of convs) {
        if (c.root !== root) continue;
        convs.delete(id);
        n++;
      }
      return n;
    },
    'claude.export': (id: string) => {
      const c = convs.get(id);
      return c ? `C:\\Users\\hong\\Documents\\Claude 대화\\${c.title}.md` : false;
    },
  };
}
