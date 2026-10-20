// 데스크톱 기능을 앱 틀(app.tsx)에 끼우는 곳: 상단 [이력]·[AI 대화] 버튼, AI 대화 패널, 변경 검토·작업 이력 본문,
// 설정 창의 AI 연결 페이지(AI 공통·Claude·Gemini·ChatGPT, POP-03), POP-04.
// 브라우저(HTML) 빌드에서는 getDesk()가 null이라 아무것도 그리지 않는다.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { AnalysisResult } from '../../engine/types';
import type { AiProvider, AiSettings, ClaudeConfig, ClaudeStatus, GeminiConfig, OpenAiConfig } from '../../shared/desktop-api';
import { Icon } from '../icons';
import type { Model, Target } from '../model';
import { aiCommonSettingsPage } from './ai/AiCommonSettings';
import { geminiSettingsPage } from './ai/GeminiSettings';
import { openAiSettingsPage } from './ai/OpenAiSettings';
import { chatProvider, noneEnabled, setupPage, shownState } from './ai/providers';
import { errText, getDesk, useDeskEvent } from './bridge';
import { AiButton } from './claude/ClaudeButton';
import type { SettingsPage, SettingsPageId } from '../components/Dialogs';
import { ClaudePanel } from './claude/ClaudePanel';
import { claudeSettingsPage } from './claude/ClaudeSettings';
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
  /** 설정 창을 그 페이지로 연다 (AI 연결은 설정 창의 페이지들) */
  openSettings(page: SettingsPageId): void;
  /** 화면 미리보기(?mock&desk)용 처음 상태 */
  initialModal?: 'project';
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
  /** 설정 창 왼쪽 칸에 더할 페이지 (AI 공통·Claude·Gemini·ChatGPT) */
  settingsPages: SettingsPage[];
}

export function useDesktopShell(input: ShellInput): Shell | null {
  const desk = useMemo(() => getDesk(), []);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [config, setConfig] = useState<ClaudeConfig | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [gemini, setGemini] = useState<GeminiConfig | null>(null);
  const [openai, setOpenai] = useState<OpenAiConfig | null>(null);
  const [geminiSt, setGeminiSt] = useState<ClaudeStatus | null>(null);
  const [openaiSt, setOpenaiSt] = useState<ClaudeStatus | null>(null);
  const [chat, setChat] = useState<ChatRequest | null>(input.initialChat ? { nonce: 1 } : null);
  const [modal, setModal] = useState<'project' | null>(input.initialModal ?? null);
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

  const refreshAi = useCallback(
    async (p?: AiProvider, recheck = false) => {
      if (!desk) return;
      const off = (e: unknown): ClaudeStatus => ({ state: 'off', checkedAt: new Date().toISOString(), message: errText(e) });
      const jobs: Promise<unknown>[] = [];
      if (!p) jobs.push(desk.invoke('ai.settings.get').then(setAiSettings, () => undefined));
      if (!p || p === 'claude') jobs.push(refreshClaude(recheck));
      if (!p || p === 'gemini')
        jobs.push(
          Promise.all([desk.invoke('ai.status', 'gemini', recheck), desk.invoke('gemini.config.get')]).then(
            ([st, cf]) => {
              setGeminiSt(st);
              setGemini(cf);
            },
            (e) => setGeminiSt(off(e)),
          ),
        );
      if (!p || p === 'openai')
        jobs.push(
          Promise.all([desk.invoke('ai.status', 'openai', recheck), desk.invoke('openai.config.get')]).then(
            ([st, cf]) => {
              setOpenaiSt(st);
              setOpenai(cf);
            },
            (e) => setOpenaiSt(off(e)),
          ),
        );
      await Promise.all(jobs);
    },
    [desk, refreshClaude],
  );

  useEffect(() => {
    void refreshAi();
  }, [refreshAi]);

  useDeskEvent(desk, (ev) => {
    if (ev.type === 'claude.status') setClaude(ev.status);
    else if (ev.type === 'ai.status') (ev.provider === 'gemini' ? setGeminiSt : ev.provider === 'openai' ? setOpenaiSt : setClaude)(ev.status);
    else if (ev.type === 'history.added') setHistoryTick((n) => n + 1);
  });

  const { root, projectName, model, result, target, nav, openFile, toast, reanalyze, hasResult, openSettings } = input;

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
      ai: { settings: aiSettings, status: { claude, gemini: geminiSt, openai: openaiSt }, gemini, openai },
      refreshAi,
      openSettings,
      chat,
      openChat: (req) => setChat({ ...(req ?? {}), nonce: Date.now() + Math.random() }),
      closeChat: () => setChat(null),
      openChanges: (workId, conversationId) => nav({ kind: 'changes', workId, conversationId }),
      openHistory: (entryId) => nav({ kind: 'history', id: entryId }),
      openSummary: () => nav({ kind: 'summary' }),
      openModal: (k) => (k === 'project' ? setModal(k) : openSettings(k)),
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
  }, [desk, root, projectName, model, result, target, claude, config, refreshClaude, aiSettings, gemini, openai, geminiSt, openaiSt, refreshAi, chat, nav, openFile, toast, reanalyze, historyTick, openSettings]);

  if (!desk || !app) return null;

  const onAi = () => {
    if (chat) {
      setChat(null);
      return;
    }
    // 켠 AI가 없으면 기본 AI의 연결 설정, 새 대화의 AI가 꺼졌거나 설치되지 않았으면 그 AI의 설정부터
    if (noneEnabled(app)) {
      openSettings(setupPage(app));
      return;
    }
    const p = chatProvider(app);
    const st = shownState(app, p);
    if (st === 'off' || st === 'missing') openSettings(p);
    else app.openChat();
  };

  const headerButtons = (
    <>
      <button
        type="button"
        class={`btn${target.kind === 'history' ? ' pressed' : ''}`}
        disabled={!hasResult || !root}
        aria-label="이력"
        title={!root ? '폴더로 연 프로젝트에서 쓸 수 있습니다' : '작업 이력'}
        onClick={() => (target.kind === 'history' ? nav({ kind: 'summary' }) : nav({ kind: 'history' }))}
      >
        <Icon name="clock" size={16} color="var(--ink2)" />
        <span class="btn-t">이력</span>
      </button>
      <AiButton app={app} pressed={!!chat} onClick={onAi} />
    </>
  );

  const panel = chat ? <ClaudePanel onClose={() => setChat(null)} /> : null;

  const modals = (
    <>
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
    settingsPages: [aiCommonSettingsPage(app), claudeSettingsPage(app), geminiSettingsPage(app), openAiSettingsPage(app)],
  };
}
