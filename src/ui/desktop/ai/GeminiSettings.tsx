// 설정 > AI 연결 > Gemini: 연동 켜기·끄기(MSG-14 동의) · 인증 방식(Gemini API 키 / 회사 Google Cloud) · 연결 확인(인터넷·인증·모델) ·
// 사내 프록시 · 모델 · 요금·데이터.
// 앱이 Gemini API에 바로 연결한다(PC에 설치할 것 없음). API 키는 저장할 때만 보내고 화면에 다시 보여 주지 않는다
// (메인 프로세스가 Windows 사용자 계정 기준(DPAPI)으로 암호화해 보관). 회사 Google Cloud는 PC의 gcloud 로그인을 그대로 쓴다.
// [연동 켜기]: 지금 값으로 저장(끈 채) → 연결 확인 → 되면 켬.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClaudeStatus, GeminiAuthMode, GeminiConfig, GeminiConfigInput } from '../../../shared/desktop-api';
import type { SettingsPage, SettingsPageHandle } from '../../components/Dialogs';
import { Spinner } from '../../icons';
import { errText } from '../bridge';
import { STATE_LABEL, StatusDot } from '../claude/ClaudeButton';
import { nowIso } from '../claude/util';
import { type DeskApp, useDesk } from '../ctx';
import { aiDefaultLabel, invalidateModels, useModels } from './models';
import { CheckHead, type CheckState, checkOf, FeeBox, InlineMsg, ModelSection, Note, OkChip, OnOffCard, ProxyRow, Radio, SecretField, TextField, WarnBox } from './parts';
import { AiBadge, providerMsg, shownState } from './providers';
import '../claude/claude.css';

/** 설정 창 왼쪽 칸의 [Gemini] */
export function geminiSettingsPage(app: DeskApp): SettingsPage {
  const on = !!app.ai.gemini?.enabled;
  const st = shownState(app, 'gemini');
  return {
    id: 'gemini',
    label: 'Gemini',
    group: 'AI 연결',
    icon: <AiBadge provider="gemini" size={20} />,
    hint: (
      <>
        <StatusDot state={st} size={7} />
        {on ? `켜짐 · ${st ? STATE_LABEL[st] : '확인 중'}` : '꺼짐'}
      </>
    ),
    render: ({ handle, done }) => <GeminiSettings handle={handle} onDone={done} />,
  };
}

/** 인증에 영향을 주는 값 (저장할 변경이 있는지 견줌) */
function authPrint(c: { authMode: GeminiAuthMode; vertex?: { project: string; location: string }; proxy?: string }): string {
  return JSON.stringify([c.authMode, c.authMode === 'vertex' ? [c.vertex?.project ?? '', c.vertex?.location || 'global'] : null, c.proxy || '']);
}

export function GeminiSettings(props: { handle: { current: SettingsPageHandle | null }; onDone: (toast: string) => void }) {
  const app = useDesk();
  const [cfg, setCfg] = useState<GeminiConfig | null>(app.ai.gemini);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(app.ai.status.gemini ?? null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 고치는 중인 값 (저장 전)
  const [authMode, setAuthMode] = useState<GeminiAuthMode>(app.ai.gemini?.authMode ?? 'apikey');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [project, setProject] = useState(app.ai.gemini?.vertex?.project ?? '');
  const [location, setLocation] = useState(app.ai.gemini?.vertex?.location ?? 'global');
  const [proxy, setProxy] = useState(app.ai.gemini?.proxy ?? '');
  const [model, setModel] = useState(app.ai.gemini?.model ?? '');
  const [customModel, setCustomModel] = useState(false);
  const loaded = useRef(false);

  // 모델 목록은 키(또는 회사 Google Cloud 프로젝트)를 저장한 뒤에 받는다
  const ready = !!cfg && (cfg.authMode === 'apikey' ? cfg.hasApiKey : !!cfg.vertex?.project);
  const models = useModels(app, 'gemini', ready);

  const initFrom = (c: GeminiConfig) => {
    setAuthMode(c.authMode);
    setProject(c.vertex?.project ?? '');
    setLocation(c.vertex?.location ?? 'global');
    setProxy(c.proxy ?? '');
    setModel(c.model ?? '');
  };

  const recheck = async (): Promise<ClaudeStatus | null> => {
    setChecking(true);
    try {
      const s = await app.desk.invoke('ai.status', 'gemini', true);
      setStatus(s);
      return s;
    } catch (e) {
      setErr(`연결을 확인하지 못했습니다. ${errText(e)}`);
      return null;
    } finally {
      setChecking(false);
      void app.refreshAi('gemini');
    }
  };

  useEffect(() => {
    app.desk.invoke('gemini.config.get').then(
      (c) => {
        setCfg(c);
        if (!loaded.current) initFrom(c);
        loaded.current = true;
        // 켜져 있으면 열 때마다 다시 확인 (키·결제가 바뀌었을 수 있음)
        if (c.enabled) void recheck().then(() => models.reload());
      },
      (e) => setLoadErr(errText(e)),
    );
  }, []);

  const keyReady = authMode !== 'apikey' || (!clearKey && (!!apiKey.trim() || !!cfg?.hasApiKey));
  const vertexReady = authMode !== 'vertex' || !!project.trim();
  const enabled = !!cfg?.enabled;

  const buildInput = (patch: Partial<GeminiConfigInput>): GeminiConfigInput => {
    const input: GeminiConfigInput = {
      enabled: !!cfg?.enabled,
      authMode,
      ...(project.trim() || authMode === 'vertex' ? { vertex: { project: project.trim(), location: location.trim().toLowerCase() || 'global' } } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
      ...patch,
    };
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    else if (clearKey) input.apiKey = '';
    return input;
  };

  const savedPrint = cfg ? authPrint(cfg) : '';
  const authDirty = !!cfg && (authPrint({ authMode, vertex: { project: project.trim(), location: location.trim().toLowerCase() || 'global' }, proxy: proxy.trim() }) !== savedPrint || !!apiKey.trim() || clearKey);
  const dirty = authDirty || (!!cfg && (model.trim() || '') !== (cfg.model ?? ''));

  /** 저장. 못 하면 false */
  const commit = async (patch: Partial<GeminiConfigInput>): Promise<GeminiConfig | false> => {
    if (!cfg) return false;
    // 켜 둔 채 저장하면 인증이 갖춰져야 한다 (키를 지우려면 먼저 [연동 끄기])
    if ((patch.enabled ?? cfg.enabled) && (!keyReady || !vertexReady)) {
      setErr(!keyReady ? 'Gemini API 키를 넣어 주세요. 키를 지우려면 먼저 [연동 끄기]를 눌러 주세요.' : '회사 Google Cloud 프로젝트 ID를 넣어 주세요.');
      return false;
    }
    setSaving(true);
    setErr(null);
    try {
      const next = await app.desk.invoke('gemini.config.set', buildInput(patch));
      if (authDirty) invalidateModels('gemini');
      setCfg(next);
      // 메인이 다듬은 값(리전 소문자 등)으로 맞춘다 (다시 저장할 변경으로 보이지 않게)
      initFrom(next);
      setApiKey('');
      setClearKey(false);
      await app.refreshAi('gemini');
      return next;
    } catch (e) {
      setErr(`저장하지 못했습니다. ${errText(e)}`);
      // 메인에 저장된 그대로 다시 읽는다 (저장된 키가 있는지 등)
      void app.desk.invoke('gemini.config.get').then(setCfg, () => undefined);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** [다시 확인]: 고친 인증 값이 있으면 먼저 저장(켜고 끄기는 그대로) → 연결 확인 → 모델 목록 다시 읽기 */
  const recheckAll = async () => {
    if (authDirty && !(await commit({}))) return;
    await recheck();
    void models.reload();
  };

  const turnOn = async () => {
    if (!keyReady || !vertexReady) {
      setErr(!keyReady ? 'Gemini API 키를 넣어 주세요.' : '회사 Google Cloud 프로젝트 ID를 넣어 주세요.');
      return;
    }
    if (!(await commit({ enabled: false }))) return;
    const s = await recheck();
    void models.reload();
    if (!s || s.state !== 'on') {
      setErr('연결 확인에 실패해 연동을 켜지 않았습니다. 아래 연결 확인의 안내에 따라 해결한 뒤 다시 눌러 주세요.');
      return;
    }
    if (!(await commit({ enabled: true, consentAt: nowIso() }))) return;
    props.onDone('Gemini 연동을 켰습니다.');
  };

  const turnOff = async () => {
    if (!(await commit({ enabled: false }))) return;
    props.onDone('Gemini 연동을 껐습니다. 분석 기능은 그대로 쓸 수 있습니다.');
  };

  // 설정 창의 [저장]: 바뀐 것이 있을 때만. 켜 둔 채 인증을 바꾸면 저장한 뒤 다시 확인
  const live = useRef({ dirty, commit, authDirty });
  live.current = { dirty, commit, authDirty };
  useEffect(() => {
    props.handle.current = {
      dirty: () => live.current.dirty,
      save: async () => {
        const changedAuth = live.current.authDirty;
        const next = await live.current.commit({});
        if (next && next.enabled && changedAuth) void app.refreshAi('gemini', true);
        return next !== false;
      },
    };
    return () => {
      props.handle.current = null;
    };
  }, [props.handle]);

  // 연결 확인 칩
  const ck = status?.checks;
  const code = status?.code ?? ck?.auth.code ?? ck?.network.code;
  const net: CheckState = checkOf(ck?.network) ?? 'wait';
  const auth: CheckState = checkOf(ck?.auth) ?? 'wait';
  const mdl: CheckState = checkOf(ck?.model) ?? 'wait';
  const shown = !!ck && (ck.network.ok !== null || ck.auth.ok !== null);
  const usingProxy = !!(proxy.trim() || cfg?.proxy);
  const authMs = ck?.auth.ms ?? status?.authMs;
  const authVal = auth === 'ok' ? (authMs ? `시험 요청 ${(authMs / 1000).toFixed(1)}초` : '확인됨') : auth === 'fail' ? (code === 'billing' ? '결제·권한 확인 필요' : code === 'limit' ? '사용 한도' : '실패') : '확인 전';
  const n = models.list?.models.length ?? 0;
  const mdlVal = mdl === 'ok' ? (cfg?.authMode === 'vertex' ? (n ? `알려진 모델 ${n}개` : '알려진 모델') : n ? `${n}개 받음` : '받음') : mdl === 'fail' ? '받지 못함' : '확인 전';

  const st = status?.state;
  const failBox = (() => {
    if (checking || !status || !shown) return null;
    if (code === 'limit') return <InlineMsg text={providerMsg('MSG-23', 'gemini')} detail={status.message} buttons={[{ label: '다시 확인', run: recheckAll }]} />;
    if (st === 'missing') return <InlineMsg text={providerMsg('MSG-20', 'gemini')} detail={ck?.auth.message ?? status.message} buttons={[{ label: '다시 확인', primary: true, run: recheckAll }]} />;
    if (st === 'offline' || net === 'fail') return <InlineMsg info text={providerMsg('MSG-22', 'gemini')} detail={ck?.network.message ?? status.message} buttons={[{ label: '다시 확인', run: recheckAll }]} />;
    if (st === 'login' || auth === 'fail')
      return <InlineMsg text={providerMsg(code === 'billing' ? 'MSG-30' : 'MSG-21', 'gemini')} detail={ck?.auth.message ?? status.message} buttons={[{ label: '다시 확인', primary: true, run: recheckAll }]} />;
    return null;
  })();

  const whyNot = !cfg ? '설정을 불러오는 중입니다' : checking ? '연결을 확인하는 중입니다' : !keyReady ? 'API 키를 넣어 주세요' : !vertexReady ? '회사 Google Cloud 프로젝트 ID를 넣어 주세요' : '';

  return (
    <div class="cp-set">
      <div class="set-page-h">
        <h3>Gemini</h3>
        <span class="s">앱이 Google의 Gemini API에 바로 연결합니다. PC에 따로 설치할 것은 없습니다</span>
      </div>

      {!cfg ? (
        loadErr ? (
          <div class="banner err">설정을 불러오지 못했습니다. {loadErr}</div>
        ) : (
          <div class="row muted">
            <Spinner size={14} /> 불러오는 중
          </div>
        )
      ) : (
        <>
          <OnOffCard
            provider="gemini"
            enabled={enabled}
            consentAt={cfg.consentAt}
            offText={providerMsg('MSG-14', 'gemini')}
            onText={`보내는 정보는 AI 공통의 규칙과 같습니다. [연동 끄기]는 이 앱에서만 Gemini를 끄며 ${cfg.authMode === 'vertex' ? 'PC의 gcloud 로그인은' : '저장한 API 키는'} 그대로 둡니다.`}
            err={err}
            saving={saving}
            canEnable={!!cfg && !saving && !checking && keyReady && vertexReady}
            whyNot={whyNot}
            onOn={turnOn}
            onOff={turnOff}
          />

          <div class="cp-set-cols">
            <div class="cp-dlg-col">
              <section class="cp-sec" aria-label="인증 방식">
                <div class="cp-sec-h">
                  <h4>인증 방식</h4>
                </div>
                <div class="ai-auth">
                  <Radio name="gm-auth" on={authMode === 'apikey'} label="Gemini API 키" help="Google AI Studio에서 발급 · Windows 사용자 계정으로 암호화해 저장" onPick={() => setAuthMode('apikey')} />
                  {authMode === 'apikey' && (
                    <div class="cp-auth-sub">
                      <SecretField
                        id="gm-key"
                        label="API 키"
                        hasSaved={!!cfg.hasApiKey}
                        clear={clearKey}
                        value={apiKey}
                        placeholder="AIza…"
                        onInput={setApiKey}
                        onClear={(on) => {
                          setClearKey(on);
                          if (on) setApiKey('');
                        }}
                      />
                      <WarnBox>결제가 연결되지 않은 무료 키는 보낸 내용이 Google 서비스 개선에 쓰이고 사람이 검토할 수 있습니다. 회사 소스에는 결제를 연결한 키나 회사 Google Cloud를 쓰세요.</WarnBox>
                    </div>
                  )}
                  <Radio name="gm-auth" on={authMode === 'vertex'} label="회사 Google Cloud (Vertex AI)" help="프로젝트 ID·리전만 넣고, 인증은 PC의 gcloud 로그인을 그대로 씁니다" onPick={() => setAuthMode('vertex')} />
                  {authMode === 'vertex' && (
                    <div class="cp-auth-sub">
                      <TextField id="gm-project" label="프로젝트 ID" required value={project} placeholder="예: my-gcp-project" onInput={setProject} />
                      <TextField id="gm-location" label="리전" value={location} placeholder="global (예: us-central1, asia-northeast3)" onInput={setLocation} />
                      <Note flush>키·비밀 값은 넣지 않습니다. PC의 gcloud 로그인(gcloud auth login)으로 받은 토큰을 그대로 씁니다</Note>
                    </div>
                  )}
                  <Note icon="info" flush>
                    Google AI Pro·Ultra 구독 로그인으로는 연결할 수 없습니다. API 사용량은 Google Cloud 결제로 따로 청구됩니다.
                  </Note>
                </div>
              </section>
              <div class="cp-dlg-hsep" />

              <section class="cp-sec" aria-label="연결 확인">
                <CheckHead status={status} shown={shown} checking={checking} onRecheck={() => void recheckAll()} title="인터넷·인증(시험 요청 1회, 요금 없음)·모델 목록을 다시 확인합니다" />
                <div class="cp-okchips">
                  <OkChip label="인터넷" value={net === 'ok' ? (usingProxy ? '프록시 사용' : '연결됨') : net === 'fail' ? '연결 안 됨' : '확인 전'} state={net} running={checking} title={ck?.network.message} />
                  <OkChip label="인증" value={authVal} state={auth} running={checking} title={ck?.auth.message} />
                  <OkChip label="모델" value={mdlVal} state={mdl} running={checking} title={ck?.model?.message} />
                </div>
                {failBox}
                <ProxyRow id="gm-proxy" value={proxy} onInput={setProxy} />
              </section>
            </div>

            <div class="cp-dlg-vsep" />

            <div class="cp-dlg-col">
              <ModelSection
                provider="gemini"
                list={ready ? models.list : null}
                loading={models.loading}
                onRefresh={() => void models.refresh()}
                model={model}
                custom={customModel}
                setModel={setModel}
                setCustom={setCustomModel}
                defaultLabel={aiDefaultLabel('gemini', models.list)}
                refreshTitle="Google에서 모델 목록을 다시 받습니다"
                note={
                  !ready
                    ? 'API 키(또는 회사 Google Cloud 프로젝트)를 저장하면 쓸 수 있는 모델 목록을 받습니다. 새 대화에 쓰고, 대화 중에는 입력란 아래에서 바꿉니다.'
                    : cfg.authMode === 'vertex'
                      ? '회사 Google Cloud는 목록을 받지 않아 알려진 모델을 보여 줍니다. 목록에 없는 모델은 직접 입력합니다. 새 대화에 쓰고, 대화 중에는 입력란 아래에서 바꿉니다.'
                      : '목록은 Google이 알려 준 모델입니다. 새 대화에 쓰고, 대화 중에는 입력란 아래에서 바꿉니다.'
                }
              />
              <FeeBox
                title="요금·데이터"
                rows={[
                  { k: '요금', v: 'Google Cloud 결제 계정으로 쓴 만큼 청구' },
                  { k: '유료 키', v: '보낸 내용을 학습에 쓰지 않고, 정책 위반 감시용으로만 잠시 기록' },
                  { k: '무료 키', v: 'Google 서비스 개선에 쓰이고 사람이 검토할 수 있음', warn: true },
                  { k: '회사 Cloud', v: '회사 프로젝트로 청구 · Google Cloud 약관의 데이터 처리를 따름' },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
