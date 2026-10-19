// 앱 상태와 흐름: 메인 → 불러오기 확인 → 분석 진행 → 결과(요약·상세·소스 보기)
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { compileExclude, decode, excludeReason } from '../engine/files';
import { analyze } from '../engine/index';
import type { AnalysisResult, Progress, SourceFile } from '../engine/types';
import { pickZip } from '../platform/browser';
import { walkFolder } from '../platform/electron';
import { getPlatform } from '../platform/index';
import type { FolderFile, LoadedFolder } from '../platform/types';
import type { MenuRow } from '../shared/desktop-api';
import { redactSecrets } from '../shared/secrets';
import { ConfirmDialog, DEFAULT_SETTINGS, type Settings, SettingsModal } from './components/Dialogs';
import { Header, type HeaderPopover } from './components/Header';
import { ancestorsOf, Sidebar } from './components/Sidebar';
import { SourceViewer, type ViewerReq } from './components/SourceViewer';
import { NavCtx, type Nav } from './ctx';
import { fmtBytes, fmtDate, fmtDuration, fmtNum, safeStorage, saveStorage } from './format';
import { Icon, Spinner } from './icons';
import type { MockBundle } from './mock';
import { buildModel, type Target } from './model';
import { listRecent, loadRecent, type RecentItem, removeRecent, saveRecent } from './recent';
import { Confirm } from './screens/Confirm';
import { BatchDetail, MenuDetail, ScreenDetail, TableDetail } from './screens/Details';
import { Home } from './screens/Home';
import { newRunState, overallPct, Running, type RunState, STEP_NAMES } from './screens/Running';
import { Summary } from './screens/Summary';
import { getDesk } from './desktop/bridge';
import { NewProjectView } from './desktop/claude/NewProject';
import { NewProjectCard } from './desktop/NewProjectCard';
import type { ReanalyzeResult } from './desktop/ctx';
import { msg } from './desktop/messages';
import { DeskCtx, useDesktopShell } from './desktop/shell';

type Phase = 'home' | 'confirm' | 'running' | 'result' | 'new';
type ModalKind = null | 'settings' | 'stop' | 'rerun' | 'needFolder';

const STEP_KIND = ['수집', '감지', '추출', '연결', '역할', '결과'];

function createWorker(): Worker | null {
  try {
    const src = (window as unknown as { __WORKER_SRC__?: string }).__WORKER_SRC__;
    if (typeof src === 'string' && src.length) {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      return new Worker(url);
    }
    return new Worker('worker.js');
  } catch {
    return null;
  }
}

function isResult(x: unknown): x is AnalysisResult {
  const r = x as AnalysisResult;
  return !!r && r.version === 1 && !!r.project && Array.isArray(r.files) && Array.isArray(r.tables) && Array.isArray(r.screens);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export interface Initial {
  mock?: MockBundle;
  phase?: Phase;
  target?: Target;
  viewer?: ViewerReq;
  popover?: HeaderPopover;
  folder?: LoadedFolder;
  runState?: RunState;
  modal?: ModalKind;
  /** 미리보기: 데스크톱 팝업(POP-03·POP-04)·Claude 패널 */
  deskModal?: 'claude' | 'project';
  chat?: boolean;
}

export function App(props: { init?: Initial }) {
  const init = props.init ?? {};
  const platform = getPlatform();
  const [phase, setPhase] = useState<Phase>(init.phase ?? (init.mock ? 'result' : 'home'));
  const [folder, setFolder] = useState<LoadedFolder | null>(init.folder ?? null);
  // 미리보기(?mock): 결과와 함께 넘긴 폴더가 있으면 그대로 쓴다
  const [projectName, setProjectName] = useState(init.folder?.name ?? init.mock?.result.project.name ?? '');
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AnalysisResult | null>(init.mock && init.phase !== 'confirm' && init.phase !== 'running' && init.phase !== 'home' ? init.mock.result : null);
  const model = useMemo(() => (result ? buildModel(result) : null), [result]);
  const [target, setTarget] = useState<Target>(init.target ?? { kind: 'summary' });
  const [viewer, setViewer] = useState<ViewerReq | null>(init.viewer ?? null);
  const [rs, setRs] = useState<RunState | null>(init.runState ?? null);
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...safeStorage<Partial<Settings>>('pa.settings', {}) }));
  const [popover, setPopover] = useState<HeaderPopover | null>(init.popover ?? null);
  const [modal, setModal] = useState<ModalKind>(init.modal ?? null);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>(['cat:screen']);
    if (init.mock) s.add('cat:menu');
    if (init.target && init.mock) for (const k of ancestorsOf(buildModel(init.mock.result), init.target)) s.add(k);
    return s;
  });
  const [saved, setSaved] = useState(false);
  /** 분석 중 알림 (DB 메뉴 읽기 실패 MSG-43 등) */
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  /** startRun이 끝나기를 기다리는 쪽 (다시 분석) */
  const runWaiter = useRef<((r: AnalysisResult | null, err?: string) => void) | null>(null);
  /** 다시 분석일 때 지금 본문·트리 펼침을 유지 */
  const keepView = useRef(false);
  const runId = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const textCache = useRef(new Map<string, string>());
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshRecent = useCallback(() => {
    listRecent().then(setRecent, () => setRecent([]));
  }, []);
  useEffect(() => {
    if (!init.mock) refreshRecent();
  }, []);

  // 단축키: Ctrl+K 검색, Esc 소스 뷰어 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === 'Escape' && viewer && !modal) setViewer(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewer, modal]);

  // 창을 닫을 때 분석 중이면 확인
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (phase === 'running') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [phase]);

  const nav = useCallback(
    (t: Target) => {
      setTarget(t);
      setViewer(null);
      setPopover(null);
      if (model && t.kind !== 'summary') {
        setExpanded((prev) => {
          const n = new Set(prev);
          for (const k of ancestorsOf(model, t)) n.add(k);
          return n;
        });
      }
      mainRef.current?.scrollTo({ top: 0 });
    },
    [model],
  );

  const openFile = useCallback((fileId: string, line?: number, query?: string) => {
    setPopover(null);
    setViewer({ fileId, line, query });
  }, []);

  // ------------------------------------------------------------------ 불러오기

  const loadFolder = (f: LoadedFolder | null) => {
    if (!f) return;
    if (!f.files.length) {
      setError('분석할 소스 파일이 없습니다. 다른 폴더를 선택해 주세요.');
      return;
    }
    textCache.current.clear();
    setFolder(f);
    setProjectName(f.name);
    setUnchecked(new Set());
    setResult(null);
    setTarget({ kind: 'summary' });
    setViewer(null);
    setError(null);
    setSaved(false);
    setPhase('confirm');
  };

  const guard = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setLoading(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setLoading(null);
    }
  };

  const pickFolder = () => guard('폴더를 읽는 중', async () => loadFolder(await platform.pickFolder()));
  const onPickZip = () => guard('ZIP을 여는 중', async () => loadFolder(await pickZip()));

  const openResultText = (name: string, text: string) => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!isResult(data)) {
      setError(`결과 파일을 열 수 없습니다. 이 프로그램에서 저장한 JSON 파일인지 확인해 주세요. (${name})`);
      return;
    }
    textCache.current.clear();
    setResult(data);
    setFolder(null);
    setProjectName(data.project.name);
    setTarget({ kind: 'summary' });
    setViewer(null);
    setSaved(true);
    setPhase('result');
  };

  const onDrop = (dt: DataTransfer) =>
    guard('불러오는 중', async () => {
      const files = Array.from(dt.files ?? []);
      if (files.length === 1 && /\.json$/i.test(files[0].name) && !(dt.items?.[0]?.webkitGetAsEntry?.()?.isDirectory)) {
        openResultText(files[0].name, await files[0].text());
        return;
      }
      const f = await platform.fromDrop(dt);
      if (!f) {
        setError('폴더 또는 ZIP 파일만 불러올 수 있습니다.');
        return;
      }
      loadFolder(f);
    });

  const openResult = () =>
    guard('결과 파일을 여는 중', async () => {
      const r = await platform.openTextFile('.json,application/json');
      if (r) openResultText(r.name, r.text);
    });

  const openRecent = (key: string) =>
    guard('저장된 결과를 여는 중', async () => {
      const r = await loadRecent(key);
      if (!r) {
        setError('저장된 결과를 열 수 없습니다.');
        return;
      }
      textCache.current.clear();
      setResult(r);
      // 데스크톱: 분석했던 폴더가 그대로 있으면 다시 연결 (소스 보기·Claude·다시 분석)
      const item = recent.find((x) => x.key === key);
      const again = item?.root ? await walkFolder(item.root).catch(() => null) : null;
      if (again) setFolder(again);
      else if (folder?.name !== r.project.name) setFolder(null);
      setProjectName(r.project.name);
      setTarget({ kind: 'summary' });
      setSaved(true);
      setPhase('result');
    });

  // ------------------------------------------------------------------ 분석 실행

  const applyProgress = (p: Progress) => {
    setRs((prev) => {
      if (!prev) return prev;
      const now = Date.now();
      const steps = prev.steps.map((s, i) => {
        const n = i + 1;
        if (n < p.step && s.status !== 'done') return { ...s, status: 'done' as const, ms: s.startedAt ? now - s.startedAt : undefined, pct: 1 };
        if (n === p.step) {
          return {
            ...s,
            name: p.stepName || s.name,
            status: 'run' as const,
            startedAt: s.startedAt ?? now,
            pct: p.total > 0 ? Math.min(1, p.done / p.total) : s.pct,
            detail: p.total > 1 ? `${fmtNum(p.done)} / ${fmtNum(p.total)}` : s.detail,
          };
        }
        return s;
      });
      let log = prev.log;
      if (p.message && log[log.length - 1]?.msg !== p.message) {
        log = [...log, { t: now, kind: STEP_KIND[p.step - 1] ?? '진행', msg: p.message, warn: /경고|EUC-KR|실패|못|오류/.test(p.message) }];
        if (log.length > 600) log = log.slice(-400);
      }
      return { ...prev, steps, log, current: p.step };
    });
  };

  const finish = (r: AnalysisResult, myRun: number) => {
    if (myRun !== runId.current) return;
    workerRef.current?.terminate();
    workerRef.current = null;
    setRs((prev) => (prev ? { ...prev, steps: prev.steps.map((s) => (s.status === 'done' ? s : { ...s, status: 'done' as const, ms: s.startedAt ? Date.now() - s.startedAt : 0 })) } : prev));
    setResult(r);
    if (!keepView.current) {
      setTarget({ kind: 'summary' });
      setExpanded(new Set(['cat:screen', ...(r.menus.length <= 40 ? ['cat:menu'] : [])]));
    }
    keepView.current = false;
    setSaved(false);
    setPhase('result');
    saveRecent(r, folder?.root ?? runFolder.current?.root).then(refreshRecent, () => undefined);
    runWaiter.current?.(r);
    runWaiter.current = null;
  };

  const fail = (msg: string, myRun: number) => {
    if (myRun !== runId.current) return;
    workerRef.current?.terminate();
    workerRef.current = null;
    setError(`분석 중 문제가 생겨 중단했습니다. ${msg}`);
    setPhase('confirm');
    keepView.current = false;
    runWaiter.current?.(null, msg);
    runWaiter.current = null;
  };

  const readAll = async (f: LoadedFolder, opts: { exclude: string[]; maxFileBytes: number }, myRun: number): Promise<SourceFile[] | null> => {
    const ex = compileExclude(opts.exclude);
    const list = f.files.map((ff) => ({ ff, skip: !!excludeReason(ff.path, ff.size, opts.maxFileBytes, ex) }));
    const total = list.filter((x) => !x.skip).length;
    const out: SourceFile[] = new Array(list.length);
    let done = 0;
    let lastPost = 0;
    let idx = 0;
    let failed = 0;
    const worker = async () => {
      while (idx < list.length) {
        const k = idx++;
        const { ff, skip } = list[k];
        if (runId.current !== myRun) return;
        if (skip) {
          out[k] = { path: ff.path, size: ff.size };
          continue;
        }
        try {
          out[k] = { path: ff.path, size: ff.size, bytes: await ff.read() };
        } catch {
          failed++;
          out[k] = { path: ff.path, size: ff.size, bytes: new Uint8Array() };
        }
        done++;
        const now = Date.now();
        if (now - lastPost > 120 || done === total) {
          lastPost = now;
          applyProgress({ step: 1, stepName: STEP_NAMES[0], done, total, message: done === total ? `${fmtNum(total)}개 읽음${failed ? ` · 읽지 못함 ${failed}` : ''}` : undefined });
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    if (runId.current !== myRun) return null;
    return out;
  };

  const runFolder = useRef<LoadedFolder | null>(null);

  const startRun = async (f: LoadedFolder | null = folder, name?: string): Promise<AnalysisResult | null> => {
    if (!f) {
      setModal('needFolder');
      return null;
    }
    const folder = f;
    runFolder.current = f;
    runWaiter.current?.(null, '새 분석을 시작했습니다');
    const done = new Promise<AnalysisResult | null>((resolve) => {
      runWaiter.current = (r) => resolve(r);
    });
    const myRun = ++runId.current;
    const opts = { exclude: [...settings.exclude, ...unchecked], maxFileBytes: Math.round(settings.maxFileMB * 1024 * 1024) };
    setError(null);
    setViewer(null);
    setPopover(null);
    setRunNotice(null);
    if (!keepView.current) setResult(null);
    setRs(newRunState());
    setPhase('running');
    const files = await readAll(folder, opts, myRun);
    if (!files) return done;
    // 데스크톱: 설정에서 켠 경우 메뉴 테이블을 DB에서 읽는다 (조회 계정, SELECT만). 실패하면 소스에서 찾은 메뉴로 (MSG-43)
    let dbMenus: { table: string; rows: MenuRow[] } | undefined;
    const desk = getDesk();
    if (desk && folder.root) {
      try {
        const m = await desk.invoke('db.readMenu', folder.root);
        if (m.enabled) {
          if (m.error || !m.rows.length) {
            const text = msg('MSG-43', { 테이블: m.table || '메뉴 테이블' });
            setRunNotice(text);
            applyProgress({ step: 1, stepName: STEP_NAMES[0], done: 1, total: 1, message: `경고: ${text}${m.error ? ` (${m.error})` : ''}` });
          } else {
            dbMenus = { table: m.table ?? '', rows: m.rows };
            applyProgress({ step: 1, stepName: STEP_NAMES[0], done: 1, total: 1, message: `DB 메뉴 테이블 ${m.table ?? ''}에서 메뉴 ${fmtNum(m.rows.length)}개 읽음` });
          }
        }
      } catch {
        // DB 모듈이 없거나 설정이 없음 → 소스만으로 분석
      }
    }
    if (runId.current !== myRun) return done;
    const engineOpts = { projectName: (name ?? projectName).trim() || folder.name, exclude: opts.exclude, maxFileBytes: opts.maxFileBytes, ...(dbMenus ? { dbMenus } : {}) };
    const w = createWorker();
    const runHere = async () => {
      // 작업자를 쓸 수 없으면 화면 스레드에서 실행 (느리지만 동작)
      try {
        const again = await readAll(folder, opts, myRun);
        if (!again) return;
        const r = await analyze(again, { ...engineOpts, onProgress: applyProgress });
        finish(r, myRun);
      } catch (e) {
        fail((e as Error)?.message ?? String(e), myRun);
      }
    };
    if (!w) {
      runHere();
      return done;
    }
    workerRef.current = w;
    let gotMessage = false;
    w.onmessage = (e: MessageEvent) => {
      gotMessage = true;
      const m = e.data as { type: string; p?: Progress; result?: AnalysisResult; message?: string };
      if (myRun !== runId.current) return;
      if (m.type === 'progress' && m.p) applyProgress(m.p);
      else if (m.type === 'result' && m.result) finish(m.result, myRun);
      else if (m.type === 'error') fail(m.message ?? '', myRun);
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      if (!gotMessage) {
        w.terminate();
        workerRef.current = null;
        runHere();
      } else fail(e.message || '작업자 오류', myRun);
    };
    const transfer = files.filter((f) => f.bytes && f.bytes.byteLength).map((f) => f.bytes!.buffer as ArrayBuffer);
    try {
      w.postMessage({ type: 'analyze', files, opts: engineOpts }, transfer);
    } catch {
      w.terminate();
      workerRef.current = null;
      runHere();
    }
    return done;
  };

  /** 적용·되돌리기 뒤 다시 분석: 폴더를 다시 읽고 확인 창 없이 분석, 지금 본문은 그대로 둔다 */
  const reanalyze = useCallback(async (): Promise<ReanalyzeResult> => {
    const t0 = Date.now();
    const before = result;
    const root = folder?.root;
    if (!root) return { ok: false, ms: 0, before, after: null, error: '원본 폴더가 없습니다' };
    const f = await walkFolder(root).catch(() => null);
    if (!f) return { ok: false, ms: Date.now() - t0, before, after: null, error: '프로젝트 폴더를 다시 읽지 못했습니다' };
    textCache.current.clear();
    setFolder(f);
    keepView.current = true;
    const after = await startRun(f);
    return { ok: !!after, ms: Date.now() - t0, before, after, error: after ? undefined : '다시 분석하지 못했습니다' };
  }, [folder, result, settings, unchecked, projectName]);

  /** 새 프로젝트 생성이 끝난 폴더를 열고 바로 분석 */
  const openFolderAndRun = (root: string) =>
    guard('폴더를 읽는 중', async () => {
      const f = await walkFolder(root);
      if (!f) {
        setError('폴더를 읽지 못했습니다.');
        return;
      }
      loadFolder(f);
      if (f.files.length) startRun(f, f.name);
    });

  const stopRun = () => {
    runId.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    keepView.current = false;
    runWaiter.current?.(null, '중지');
    runWaiter.current = null;
    setModal(null);
    setPhase(folder ? 'confirm' : 'home');
    showToast('분석을 중지했습니다.');
  };

  const onRun = () => {
    if (phase === 'running') return;
    if (!folder) {
      setModal('needFolder');
      return;
    }
    if (phase === 'result' && result) {
      setModal('rerun');
      return;
    }
    startRun();
  };

  const saveResult = async (r = result) => {
    if (!r) return;
    try {
      await platform.saveFile(`${r.project.name}_분석결과_${today()}.json`, JSON.stringify(r));
      setSaved(true);
      showToast('결과 파일을 저장했습니다.');
    } catch (e) {
      showToast(`저장하지 못했습니다. ${(e as Error)?.message ?? ''}`);
    }
  };

  // ------------------------------------------------------------------ 소스 읽기

  const folderIndex = useMemo(() => {
    const m = new Map<string, FolderFile>();
    for (const f of folder?.files ?? []) m.set(f.path, f);
    return m;
  }, [folder]);

  const loadText = useCallback(
    async (fileId: string): Promise<string | null> => {
      if (textCache.current.has(fileId)) return textCache.current.get(fileId)!;
      if (init.mock && result === init.mock.result) {
        const t = init.mock.texts.get(fileId);
        return t ?? null;
      }
      const info = model?.fileById.get(fileId);
      if (!info) return null;
      const ff = folderIndex.get(info.path);
      if (!ff) return null;
      const bytes = await ff.read();
      // DB 접속 정보(주소·계정·비밀번호)는 소스 뷰어에서도 가린다 (기획서 9장). 줄 수는 그대로
      const text = redactSecrets(decode(bytes).text, info.path).text;
      if (textCache.current.size > 60) textCache.current.clear();
      textCache.current.set(fileId, text);
      return text;
    },
    [model, folderIndex, result],
  );

  const connectFolder = () =>
    guard('폴더를 읽는 중', async () => {
      const f = await platform.pickFolder();
      if (!f) return;
      const paths = new Set(f.files.map((x) => x.path));
      const hit = result ? result.files.slice(0, 200).filter((x) => paths.has(x.path)).length : 0;
      if (result && hit === 0) {
        showToast('선택한 폴더에 이 결과의 파일이 없습니다. 원본 폴더를 골라 주세요.');
        return;
      }
      textCache.current.clear();
      setFolder(f);
      showToast('원본 폴더를 연결했습니다.');
    });

  // ------------------------------------------------------------------ 화면

  const shell = useDesktopShell({
    root: folder?.root ?? null,
    projectName,
    model,
    result,
    target,
    hasResult: phase === 'result' && !!result,
    nav,
    openFile,
    toast: showToast,
    reanalyze,
    initialModal: init.deskModal,
    initialChat: init.chat,
  });

  const navValue: Nav | null = model ? { model, nav, openFile, toast: showToast } : null;
  const running = phase === 'running';
  const pct = rs ? overallPct(rs) : 0;
  const curStep = rs?.steps.find((s) => s.status === 'run');

  let mainView: preact.ComponentChildren = null;
  if (phase === 'home')
    mainView = (
      <Home
        recent={recent}
        error={error}
        loading={loading}
        onPickFolder={pickFolder}
        onPickZip={onPickZip}
        onDrop={onDrop}
        onOpenResult={openResult}
        onOpenRecent={openRecent}
        onRemoveRecent={(k) => removeRecent(k).then(refreshRecent)}
        side={shell && <NewProjectCard onStart={() => setPhase('new')} disabled={!!loading} />}
      />
    );
  else if (phase === 'new' && shell) mainView = <NewProjectView onCancel={() => setPhase('home')} onOpenFolder={openFolderAndRun} />;
  else if (phase === 'confirm' && folder)
    mainView = (
      <Confirm
        folder={folder}
        baseOpts={{ exclude: settings.exclude, maxFileBytes: Math.round(settings.maxFileMB * 1024 * 1024) }}
        projectName={projectName}
        setProjectName={setProjectName}
        unchecked={unchecked}
        setUnchecked={setUnchecked}
        onStart={() => startRun()}
        onOther={pickFolder}
        error={error}
      />
    );
  else if (phase === 'running' && rs) mainView = <Running name={projectName} rs={rs} />;
  else if (phase === 'result' && model && result) {
    if (target.kind === 'summary')
      mainView = (
        <Summary
          r={result}
          onSave={() => saveResult()}
          saved={saved}
          onExpandCat={(c) => setExpanded((p) => new Set([...p, `cat:${c}`]))}
          onLangs={() => setPopover('lang')}
        />
      );
    else if (target.kind === 'screen') mainView = <ScreenDetail id={target.id} />;
    else if (target.kind === 'table') mainView = <TableDetail id={target.id} />;
    else if (target.kind === 'menu') mainView = <MenuDetail id={target.id} />;
    else if (target.kind === 'batch') mainView = <BatchDetail id={target.id} />;
    else if (shell) mainView = shell.renderTarget(target);
  }

  const body = (
    <div class="app">
      <Header
        result={phase === 'result' ? result : null}
        projectName={phase === 'home' ? undefined : projectName}
        running={running}
        canRun={!!folder}
        popover={popover}
        setPopover={setPopover}
        onOpenFolder={pickFolder}
        onRun={onRun}
        onStop={() => setModal('stop')}
        onSettings={() => setModal('settings')}
        extras={shell?.headerButtons}
        onProjectChip={phase === 'result' || phase === 'confirm' ? shell?.onProjectChip : undefined}
        recent={recent}
        currentRoot={folder?.root}
        onOpenRecent={openRecent}
        onProjectMenu={refreshRecent}
        onHome={() => {
          if (phase === 'running') return;
          if (phase === 'result') nav({ kind: 'summary' });
          else {
            setPhase('home');
            refreshRecent();
          }
        }}
        onOpenFile={openFile}
      />
      <Sidebar
        model={phase === 'result' ? model : null}
        running={running ? { active: true } : undefined}
        sel={target}
        expanded={expanded}
        setExpanded={setExpanded}
        onNav={nav}
        onFile={(id, line) => openFile(id, line)}
        searchRef={searchRef}
      />
      <main class={`main${shell?.panel ? ' with-panel' : ''}`}>
        <div class="main-col">
        <div class="main-scroll" ref={mainRef}>
          {phase === 'result' && result && (folder === null && !(init.mock && result === init.mock.result)) && (
            <div class="banner info" style={{ margin: '14px 24px 0', borderRadius: '8px' }}>
              <Icon name="info" size={15} />
              <span class="grow">저장된 결과입니다. 원본 폴더를 연결하면 소스를 볼 수 있고 [Run]으로 다시 분석할 수 있습니다.</span>
              <button type="button" class="btn sm" onClick={connectFolder}>
                <Icon name="link" size={14} />
                원본 폴더 연결
              </button>
            </div>
          )}
          {phase === 'result' && runNotice && (
            <div class="banner warn" style={{ margin: '14px 24px 0', borderRadius: '8px' }}>
              <Icon name="warn" size={15} />
              <span class="grow">{runNotice}</span>
              {shell && (
                <button type="button" class="btn sm" onClick={() => shell.app.openModal('project')}>
                  프로젝트 연결 열기
                </button>
              )}
              <button type="button" class="icon-btn" aria-label="닫기" onClick={() => setRunNotice(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {mainView}
        </div>
        {viewer && model && (
          <SourceViewer
            model={model}
            req={viewer}
            loadText={loadText}
            onClose={() => setViewer(null)}
            onTable={(id) => nav({ kind: 'table', id })}
            onScreen={(id) => nav({ kind: 'screen', id })}
            onBatch={(id) => nav({ kind: 'batch', id })}
            onConnectFolder={connectFolder}
          />
        )}
        </div>
        {shell?.panel}
      </main>
      <footer class="sts" role="status">
        {phase === 'home' && (
          <>
            <span class="dot idle" />
            준비됨 · 프로젝트 폴더를 불러오세요
          </>
        )}
        {phase === 'new' && (
          <>
            <span class="dot idle" />
            새 프로젝트 · 요구사항 → 계획 확정 → 생성 → 분석
          </>
        )}
        {phase === 'confirm' && folder && (
          <>
            <span class="dot" />
            불러오기 완료 · 파일 {fmtNum(folder.files.length)}개 · {fmtBytes(folder.files.reduce((a, f) => a + f.size, 0))}
          </>
        )}
        {phase === 'running' && rs && (
          <>
            <Spinner size={12} />
            분석 중 · {rs.current}/6단계 · {curStep?.name ?? ''} · {pct}%
          </>
        )}
        {phase === 'result' && result && (
          <>
            <span class="dot" />
            분석 완료 · 대상 파일 {fmtNum(result.stats.analyzedFiles)}개 · 소요 {fmtDuration(result.project.durationMs)}
            <span class="right">
              {saved ? (
                <span class="row" style={{ gap: '5px' }}>
                  <Icon name="check" size={13} color="var(--ok)" />
                  결과 파일 저장됨
                </span>
              ) : (
                <span class="row" style={{ gap: '5px' }}>
                  <Icon name="check" size={13} color="var(--ok)" />
                  자동 저장됨(최근 프로젝트)
                </span>
              )}
              <span class="vsep" />
              {fmtDate(result.project.analyzedAt)} 분석
            </span>
          </>
        )}
      </footer>

      {modal === 'settings' && (
        <SettingsModal
          value={settings}
          hasResult={!!result}
          onClose={() => setModal(null)}
          onSave={(s) => {
            setSettings(s);
            saveStorage('pa.settings', s);
            setModal(null);
            showToast('설정을 저장했습니다.');
          }}
        />
      )}
      {modal === 'stop' && (
        <ConfirmDialog
          title="분석 중지"
          message="분석을 중지할까요? 지금까지의 결과는 저장되지 않습니다."
          ok="중지"
          danger
          cancel="계속 분석"
          onOk={stopRun}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'rerun' && (
        <ConfirmDialog
          title="다시 분석"
          message="다시 분석하면 지금 결과가 새 결과로 바뀝니다. 계속할까요?"
          ok="다시 분석"
          extra={{ label: '결과 파일 저장 후 분석', onClick: () => { setModal(null); saveResult().then(() => startRun()); } }}
          onOk={() => { setModal(null); startRun(); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'needFolder' && (
        <ConfirmDialog
          title="원본 폴더 필요"
          message="다시 분석하려면 프로젝트 폴더가 있어야 합니다. 폴더를 선택해 주세요."
          ok="폴더 선택"
          onOk={() => { setModal(null); pickFolder(); }}
          onClose={() => setModal(null)}
        />
      )}
      {shell?.modals}
      {toast && <div class="toast" role="status">{toast}</div>}
      {phase !== 'home' && loading && (
        <div class="toast" role="status">
          <span class="row"><Spinner size={13} color="#fff" /> {loading}</span>
        </div>
      )}
      {phase === 'result' && error && (
        <div class="toast" role="alert" style={{ background: 'var(--err)' }} onClick={() => setError(null)}>{error}</div>
      )}
    </div>
  );

  const withDesk = shell ? <DeskCtx.Provider value={shell.app}>{body}</DeskCtx.Provider> : body;
  return navValue ? <NavCtx.Provider value={navValue}>{withDesk}</NavCtx.Provider> : withDesk;
}
