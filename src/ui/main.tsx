import { render } from 'preact';
import type { LoadedFolder } from '../platform/types';
import { App, type Initial } from './app';
import { installDeskMock, MOCK_ROOT } from './desktop/mock/index';
import { makeMock } from './mock';
import type { Target } from './model';
import { newRunState } from './screens/Running';
import './styles.css';

function mockFolder(): LoadedFolder {
  const { result, texts } = makeMock();
  const enc = new TextEncoder();
  const files = result.files.map((f) => {
    const bytes = enc.encode(texts.get(f.id) ?? '');
    return { path: f.path, size: bytes.length, read: async () => bytes };
  });
  // 제외 규칙에 걸리는 폴더 예시
  for (let i = 0; i < 40; i++) files.push({ path: `node_modules/lib${i}/index.js`, size: 1200, read: async () => new Uint8Array() });
  for (let i = 0; i < 12; i++) files.push({ path: `target/classes/C${i}.class`, size: 3000, read: async () => new Uint8Array() });
  files.push({ path: '.git/HEAD', size: 20, read: async () => new Uint8Array() });
  return { name: 'shop-admin', files };
}

function initialFromUrl(): Initial {
  const p = new URLSearchParams(location.search);
  if (!p.has('mock')) return {};
  const mock = makeMock();
  const init: Initial = { mock };
  const view = p.get('view');
  if (view) {
    const [kind, id] = view.split(':');
    if (kind === 'table' || kind === 'screen' || kind === 'menu' || kind === 'batch') init.target = { kind, id } as Target;
    if (kind === 'changes') init.target = { kind: 'changes', workId: id || 'W1' };
    if (kind === 'history') init.target = { kind: 'history', ...(id ? { id } : {}) };
  }
  // 데스크톱 기능 미리보기: ?mock&desk[&chat][&dmodal=claude|project]
  if (p.has('desk')) {
    installDeskMock();
    init.folder = { ...mockFolder(), root: MOCK_ROOT };
    if (p.has('chat')) init.chat = true;
    const dm = p.get('dmodal');
    if (dm === 'claude' || dm === 'project') init.deskModal = dm;
    // &noroot: ZIP·결과 파일로 연 것처럼 원본 폴더 경로 없음 (Claude [수정 진행] 불가)
    if (p.has('noroot')) init.folder = mockFolder();
    // &phase=new: SCR-11 새 프로젝트 (나머지 인자는 mock/claude.ts)
    if (p.get('phase') === 'new') {
      init.phase = 'new';
      init.folder = undefined;
    }
  }
  const v = p.get('viewer');
  if (v) {
    const [fileId, line, query] = v.split(':');
    init.viewer = { fileId, line: line ? Number(line) : undefined, query: query || undefined };
  }
  const pop = p.get('pop');
  if (pop === 'lang' || pop === 'db') init.popover = pop;
  const phase = p.get('phase');
  if (phase === 'home') init.phase = 'home';
  if (phase === 'confirm') {
    init.phase = 'confirm';
    init.folder = mockFolder();
  }
  if (phase === 'running') {
    init.phase = 'running';
    init.folder = mockFolder();
    const rs = newRunState();
    const now = Date.now();
    rs.startedAt = now - 5200;
    rs.current = 3;
    rs.steps = rs.steps.map((s, i) =>
      i < 2 ? { ...s, status: 'done', ms: [800, 1200][i], detail: ['688개 읽음 · 인코딩 확인 필요 2건', 'Java·JSP·JavaScript · Oracle · MyBatis'][i] } : i === 2 ? { ...s, status: 'run', startedAt: now - 3000, pct: 0.62, detail: '426 / 688' } : s,
    );
    rs.log = [
      { t: now - 4000, kind: '감지', msg: 'pom.xml → 전자정부 표준프레임워크 3.10 · Spring MVC · MyBatis' },
      { t: now - 3500, kind: '감지', msg: 'globals.properties:4 → Oracle (jdbc:oracle:thin)', warn: false },
      { t: now - 3000, kind: '추출', msg: 'db/schema/order.sql → 테이블 6개' },
      { t: now - 2500, kind: '추출', msg: 'OrderMapper.xml → SQL 34개 (TB_ORDER, TB_ORDER_ITEM, TB_USER 외 4)' },
      { t: now - 2000, kind: '추출', msg: 'deploy/crontab → settle_daily.sh (매일 02:00) 외 2개' },
      { t: now - 1500, kind: '추출', msg: 'legacy/StatUtil.java 인코딩을 EUC-KR로 추정', warn: true },
      { t: now - 1000, kind: '추출', msg: 'WEB-INF/jsp/order/detail.jsp → 화면 「주문상세」' },
    ];
    init.runState = rs;
  }
  if (p.get('modal') === 'settings') init.modal = 'settings';
  return init;
}

const root = document.getElementById('app');
if (root) render(<App init={initialFromUrl()} />, root);
