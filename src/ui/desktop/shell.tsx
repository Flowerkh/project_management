// 데스크톱 기능을 앱 틀(app.tsx)에 끼우는 곳: 상단 [이력]·[Claude] 버튼, Claude 대화 패널, 변경 검토·작업 이력 본문, POP-03·POP-04.
// 브라우저(HTML) 빌드에서는 getDesk()가 null이라 아무것도 그리지 않는다.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { AnalysisResult } from '../../engine/types';
import type { ClaudeConfig, ClaudeStatus } from '../../shared/desktop-api';
import { Icon } from '../icons';
import type { Model, Target } from '../model';
import { errText, getDesk, useDeskEvent } from './bridge';
import { ClaudeButton } from './claude/ClaudeButton';
import { ClaudeDialog } from './claude/ClaudeDialog';
import { ClaudePanel } from './claude/ClaudePanel';
import type { ChatRequest, DeskApp, ReanalyzeResult } from './ctx';

export { DeskCtx } from './ctx';
import { ProjectDialog } from './ProjectDialog';
import { ChangesView } from './work/ChangesView';
import { HistoryView } from './work/HistoryView';
import './desktop.css';

export interface ShellInput {
  root: string | null;
  projectName: string;
  model: Model | null;
  result: AnalysisResult | null;
  target: Target;
  /** 결과 화면일 때만 이력·변경 검토를 연다 */
  hasResult: boolean;
  nav(t: Target): void;
  openFile(fileId: string, line?: number): void;
  toast(msg: string): void;
  reanalyze(): Promise<ReanalyzeResult>;
  /** 화면 미리보기(?mock&desk)용 처음 상태 */
  initialModal?: 'claude' | 'project';
  initialChat?: boolean;
}

export interface Shell {
  app: DeskApp;
  headerButtons: ComponentChildren;
  /** 상단 프로젝트 이름 → POP-04 */
  onProjectChip?: () => void;
  panel: ComponentChildren;
  modals: ComponentChildren;
  /** 변경 검토·작업 이력 본문 (해당 없으면 null) */
  renderTarget(t: Target): ComponentChildren | null;
}

export function useDesktopShell(input: ShellInput): Shell | null {
  const desk = useMemo(() => getDesk(), []);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [config, setConfig] = useState<ClaudeConfig | null>(null);
  const [chat, setChat] = useState<ChatRequest | null>(input.initialChat ? { nonce: 1 } : null);
  const [modal, setModal] = useState<'claude' | 'project' | null>(input.initialModal ?? null);
  const [historyTick, setHistoryTick] = useState(0);

  const refreshClaude = useCallback(
    async (recheck = false) => {
      if (!desk) return;
      try {
        const [st, cf] = await Promise.all([desk.invoke('claude.status', recheck), desk.invoke('claude.config.get')]);
        setClaude(st);
        setConfig(cf);
      } catch (e) {
        setClaude({ state: 'off', checkedAt: new Date().toISOString(), message: errText(e) });
      }
    },
    [desk],
  );

  useEffect(() => {
    refreshClaude(false);
  }, [refreshClaude]);

  useDeskEvent(desk, (ev) => {
    if (ev.type === 'claude.status') setClaude(ev.status);
    else if (ev.type === 'history.added') setHistoryTick((n) => n + 1);
  });

  const { root, projectName, model, result, target, nav, openFile, toast, reanalyze, hasResult } = input;

  const app: DeskApp | null = useMemo(() => {
    if (!desk) return null;
    return {
      desk,
      root,
      projectName,
      model,
      result,
      target,
      claude,
      claudeConfig: config,
      refreshClaude,
      chat,
      openChat: (req) => setChat({ ...(req ?? {}), nonce: Date.now() + Math.random() }),
      closeChat: () => setChat(null),
      openChanges: (workId, conversationId) => nav({ kind: 'changes', workId, conversationId }),
      openHistory: (entryId) => nav({ kind: 'history', id: entryId }),
      openSummary: () => nav({ kind: 'summary' }),
      openModal: (k) => setModal(k),
      reanalyze,
      openSource: (relPath, line) => {
        const f = model?.fileByPath.get(relPath.replace(/\\/g, '/').replace(/^\.?\//, ''));
        if (!f) return false;
        openFile(f.id, line);
        return true;
      },
      nav,
      toast,
      historyTick,
    };
  }, [desk, root, projectName, model, result, target, claude, config, refreshClaude, chat, nav, openFile, toast, reanalyze, historyTick]);

  if (!desk || !app) return null;

  const onClaude = () => {
    if (chat) {
      setChat(null);
      return;
    }
    // 연동을 켜지 않았거나 CLI가 없으면 Claude 연결(POP-03)부터
    if (!config?.enabled || claude?.state === 'off' || claude?.state === 'missing') setModal('claude');
    else app.openChat();
  };

  const headerButtons = (
    <>
      <button
        type="button"
        class={`btn${target.kind === 'history' ? ' pressed' : ''}`}
        disabled={!hasResult || !root}
        title={!root ? '폴더로 연 프로젝트에서 쓸 수 있습니다' : '작업 이력'}
        onClick={() => (target.kind === 'history' ? nav({ kind: 'summary' }) : nav({ kind: 'history' }))}
      >
        <Icon name="clock" size={16} color="var(--ink2)" />
        이력
      </button>
      <ClaudeButton status={claude} pressed={!!chat} onClick={onClaude} />
    </>
  );

  const panel = chat ? <ClaudePanel onClose={() => setChat(null)} /> : null;

  const modals = (
    <>
      {modal === 'claude' && <ClaudeDialog onClose={() => { setModal(null); refreshClaude(false); }} />}
      {modal === 'project' && <ProjectDialog onClose={() => setModal(null)} />}
    </>
  );

  return {
    app,
    headerButtons,
    onProjectChip: root ? () => setModal('project') : undefined,
    panel,
    modals,
    renderTarget(t) {
      if (t.kind === 'changes') return <ChangesView workId={t.workId} conversationId={t.conversationId} />;
      if (t.kind === 'history') return <HistoryView entryId={t.id} />;
      return null;
    },
  };
}
