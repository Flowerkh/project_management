// 설정 > AI 연결 > ChatGPT: 연동 켜기·끄기(MSG-14 동의) · 인증 방식(ChatGPT 계정 로그인 / OpenAI API 키 / 회사 클라우드 Azure OpenAI) ·
// 연결 확인(Codex·인터넷·인증) · Codex 경로 · 사내 프록시 · 모델 · 요금·데이터.
// PC에 설치된 Codex CLI로 대화한다(Codex는 고치지 않음). 로그인·계정 바꾸기는 [터미널에서 로그인]으로 연 Codex 자체 화면(브라우저)에서 한다.
// 앱은 로그인 토큰을 읽거나 저장하지 않고, 계정 이름(이메일·구독)은 Codex가 알려 준 것을 화면에만 보여 준다.
// API 키·Azure 키는 저장할 때만 보내고 화면에 다시 보여 주지 않는다(DPAPI로 암호화해 보관, Codex를 실행할 때 환경 변수로만 넘김).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClaudeStatus, OpenAiAuthMode, OpenAiConfig, OpenAiConfigInput } from '../../../shared/desktop-api';
import type { SettingsPage, SettingsPageHandle } from '../../components/Dialogs';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { STATE_LABEL, StatusDot } from '../claude/ClaudeButton';
import { nowIso } from '../claude/util';
import { type DeskApp, useDesk } from '../ctx';
import { aiDefaultLabel, invalidateModels, useModels } from './models';
import { accountLines, CheckHead, type CheckState, checkOf, FeeBox, InlineMsg, ModelSection, Note, OkChip, OnOffCard, ProxyRow, Radio, SecretField, TextField } from './parts';
import { AiBadge, providerMsg, shownState } from './providers';
import '../claude/claude.css';

/** 설정 창 왼쪽 칸의 [ChatGPT] */
export function openAiSettingsPage(app: DeskApp): SettingsPage {
  const on = !!app.ai.openai?.enabled;
  const st = shownState(app, 'openai');
  return {
    id: 'openai',
    label: 'ChatGPT',
    group: 'AI 연결',
    icon: <AiBadge provider="openai" size={20} />,
    hint: (
      <>
        <StatusDot state={st} size={7} />
        {on ? `켜짐 · ${st ? STATE_LABEL[st] : '확인 중'}` : st === 'missing' ? 'Codex 없음' : '꺼짐'}
      </>
    ),
    render: ({ handle, done }) => <OpenAiSettings handle={handle} onDone={done} />,
  };
}

/** Azure 엔드포인트를 메인과 같게 다듬음 (끝의 / · /openai… 떼고 소문자) */
function cleanEndpoint(v: string): string {
  return v.trim().replace(/\/+$/, '').replace(/\/openai(\/.*)?$/i, '').toLowerCase();
}

function authPrint(c: { authMode: OpenAiAuthMode; endpoint: string; deployment: string; proxy: string }): string {
  return JSON.stringify([c.authMode, cleanEndpoint(c.endpoint), c.deployment.trim(), c.proxy.trim()]);
}

export function OpenAiSettings(props: { handle: { current: SettingsPageHandle | null }; onDone: (toast: string) => void }) {
  const app = useDesk();
  const [cfg, setCfg] = useState<OpenAiConfig | null>(app.ai.openai);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(app.ai.status.openai ?? null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 고치는 중인 값 (저장 전)
  const [authMode, setAuthMode] = useState<OpenAiAuthMode>(app.ai.openai?.authMode ?? 'chatgpt');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [endpoint, setEndpoint] = useState(app.ai.openai?.azure?.endpoint ?? '');
  const [deployment, setDeployment] = useState(app.ai.openai?.azure?.deployment ?? '');
  const [azureKey, setAzureKey] = useState('');
  const [clearAzureKey, setClearAzureKey] = useState(false);
  const [proxy, setProxy] = useState(app.ai.openai?.proxy ?? '');
  const [model, setModel] = useState(app.ai.openai?.model ?? '');
  const [customModel, setCustomModel] = useState(false);
  const loaded = useRef(false);

  // 모델 목록·지금 계정은 Codex를 찾은 뒤에 (Codex를 잠깐 띄워 물어봄, 요금 없음)
  const cliOk = status?.checks?.cli?.ok === true || (!!status?.version && status.state !== 'missing');
  const models = useModels(app, 'openai', !!cfg && cliOk);

  const initFrom = (c: OpenAiConfig) => {
    setAuthMode(c.authMode);
    setEndpoint(c.azure?.endpoint ?? '');
    setDeployment(c.azure?.deployment ?? '');
    setProxy(c.proxy ?? '');
    setModel(c.model ?? '');
  };

  const recheck = async (): Promise<ClaudeStatus | null> => {
    setChecking(true);
    try {
      const s = await app.desk.invoke('ai.status', 'openai', true);
      setStatus(s);
      return s;
    } catch (e) {
      setErr(`연결을 확인하지 못했습니다. ${errText(e)}`);
      return null;
    } finally {
      setChecking(false);
      void app.refreshAi('openai');
    }
  };

  useEffect(() => {
    app.desk.invoke('openai.config.get').then(
      (c) => {
        setCfg(c);
        if (!loaded.current) initFrom(c);
        loaded.current = true;
        // 켜져 있으면 열 때마다 다시 확인 (터미널에서 다른 계정으로 로그인했을 수 있음)
        if (c.enabled) {
          void recheck();
          void models.refresh();
        } else void app.desk.invoke('ai.status', 'openai', false).then(setStatus, () => undefined);
      },
      (e) => setLoadErr(errText(e)),
    );
  }, []);

  const keyReady = authMode !== 'apikey' || (!clearKey && (!!apiKey.trim() || !!cfg?.hasApiKey));
  const azureReady = authMode !== 'azure' || (!!cleanEndpoint(endpoint) && !!deployment.trim());
  const enabled = !!cfg?.enabled;

  const buildInput = (patch: Partial<OpenAiConfigInput>): OpenAiConfigInput => {
    const ep = cleanEndpoint(endpoint);
    const dp = deployment.trim();
    const input: OpenAiConfigInput = {
      enabled: !!cfg?.enabled,
      authMode,
      ...(cfg?.cliPath ? { cliPath: cfg.cliPath } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
      ...(ep || dp || azureKey.trim() || clearAzureKey ? { azure: { endpoint: ep, deployment: dp, ...(azureKey.trim() ? { key: azureKey.trim() } : clearAzureKey ? { key: '' } : {}) } } : {}),
      ...patch,
    };
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    else if (clearKey) input.apiKey = '';
    return input;
  };

  const savedPrint = cfg ? authPrint({ authMode: cfg.authMode, endpoint: cfg.azure?.endpoint ?? '', deployment: cfg.azure?.deployment ?? '', proxy: cfg.proxy ?? '' }) : '';
  const authDirty = !!cfg && (authPrint({ authMode, endpoint, deployment, proxy }) !== savedPrint || !!apiKey.trim() || clearKey || !!azureKey.trim() || clearAzureKey);
  const dirty = authDirty || (!!cfg && (model.trim() || '') !== (cfg.model ?? ''));

  const commit = async (patch: Partial<OpenAiConfigInput>): Promise<OpenAiConfig | false> => {
    if (!cfg) return false;
    // 켜 둔 채 저장하면 인증이 갖춰져야 한다 (키를 지우려면 먼저 [연동 끄기])
    if ((patch.enabled ?? cfg.enabled) && (!keyReady || !azureReady)) {
      setErr(!keyReady ? 'OpenAI API 키를 넣어 주세요. 키를 지우려면 먼저 [연동 끄기]를 눌러 주세요.' : 'Azure OpenAI 엔드포인트와 배포 이름을 넣어 주세요.');
      return false;
    }
    setSaving(true);
    setErr(null);
    try {
      const next = await app.desk.invoke('openai.config.set', buildInput(patch));
      if (authDirty) invalidateModels('openai');
      setCfg(next);
      initFrom(next);
      setApiKey('');
      setClearKey(false);
      setAzureKey('');
      setClearAzureKey(false);
      await app.refreshAi('openai');
      return next;
    } catch (e) {
      setErr(`저장하지 못했습니다. ${errText(e)}`);
      // 메인에 저장된 그대로 다시 읽는다 (저장된 키가 있는지 등)
      void app.desk.invoke('openai.config.get').then(setCfg, () => undefined);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** [다시 확인]: 고친 인증 값이 있으면 먼저 저장 → 연결 확인 + 모델 목록·지금 계정 다시 받기 */
  const recheckAll = async () => {
    if (authDirty && !(await commit({}))) return;
    await Promise.all([recheck(), models.refresh()]);
  };

  const turnOn = async () => {
    if (!keyReady || !azureReady) {
      setErr(!keyReady ? 'OpenAI API 키를 넣어 주세요.' : 'Azure OpenAI 엔드포인트와 배포 이름을 넣어 주세요.');
      return;
    }
    if (!(await commit({ enabled: false }))) return;
    const [s] = await Promise.all([recheck(), models.refresh()]);
    if (!s || s.state !== 'on') {
      setErr('연결 확인에 실패해 연동을 켜지 않았습니다. 아래 연결 확인의 안내에 따라 해결한 뒤 다시 눌러 주세요.');
      return;
    }
    if (!(await commit({ enabled: true, consentAt: nowIso() }))) return;
    props.onDone('ChatGPT 연동을 켰습니다.');
  };

  const turnOff = async () => {
    if (!(await commit({ enabled: false }))) return;
    props.onDone('ChatGPT 연동을 껐습니다. 분석 기능은 그대로 쓸 수 있습니다.');
  };

  const live = useRef({ dirty, commit, authDirty });
  live.current = { dirty, commit, authDirty };
  useEffect(() => {
    props.handle.current = {
      dirty: () => live.current.dirty,
      save: async () => {
        const changedAuth = live.current.authDirty;
        const next = await live.current.commit({});
        if (next && next.enabled && changedAuth) void app.refreshAi('openai', true);
        return next !== false;
      },
    };
    return () => {
      props.handle.current = null;
    };
  }, [props.handle]);

  const pickCli = async () => {
    try {
      const p = await app.desk.invoke('openai.pickCli');
      if (!p) return;
      const c = await app.desk.invoke('openai.config.get');
      setCfg(c);
      invalidateModels('openai');
      await recheck();
      void models.refresh();
    } catch (e) {
      setErr(`경로를 지정하지 못했습니다. ${errText(e)}`);
    }
  };

  const openLogin = async () => {
    try {
      const ok = await app.desk.invoke('openai.openLogin');
      app.toast(ok ? '열린 창에서 브라우저 로그인을 마친 뒤 [다시 확인]을 눌러 주세요.' : '이 PC에서는 터미널을 열 수 없습니다. 터미널에서 codex login으로 로그인한 뒤 [다시 확인]을 눌러 주세요.');
    } catch (e) {
      setErr(errText(e));
    }
  };

  // 연결 확인 칩
  const st = status?.state;
  const ck = status?.checks;
  const code = status?.code ?? ck?.auth.code ?? ck?.network.code;
  const cli: CheckState = checkOf(ck?.cli) ?? (st === 'missing' ? 'fail' : status?.version ? 'ok' : 'wait');
  const net: CheckState = checkOf(ck?.network) ?? 'wait';
  const auth: CheckState = checkOf(ck?.auth) ?? 'wait';
  const shown = !!status && (!!ck || st !== 'off');
  const usingProxy = !!(proxy.trim() || cfg?.proxy);
  const authMs = ck?.auth.ms ?? status?.authMs;
  const authVal = auth === 'ok' ? (authMs ? `시험 요청 ${(authMs / 1000).toFixed(1)}초` : '확인됨') : auth === 'fail' ? (code === 'billing' ? '결제·권한 확인 필요' : code === 'limit' ? '사용 한도' : '실패') : '확인 전';

  const acct = authMode === 'chatgpt' && cfg?.authMode === 'chatgpt' ? accountLines(models.list?.account) : null;
  const loggedIn = !!acct || (cfg?.authMode === 'chatgpt' && auth === 'ok');
  const loginTag = loggedIn ? <span class="tag ok">로그인됨</span> : code === 'auth' && cfg?.authMode === 'chatgpt' ? <span class="tag err">로그인 필요</span> : <span class="tag neutral">확인 전</span>;

  const failBox = (() => {
    if (checking || !status) return null;
    if (st === 'missing' || cli === 'fail')
      return (
        <InlineMsg
          text={providerMsg('MSG-20', 'openai')}
          detail={ck?.cli?.message ?? status.message}
          buttons={[
            { label: '경로 지정', run: pickCli },
            { label: '다시 확인', primary: true, run: recheckAll },
          ]}
        />
      );
    if (code === 'limit')
      return <InlineMsg text={providerMsg('MSG-23', 'openai')} detail={status.message} buttons={[...(authMode !== 'apikey' ? [{ label: 'API 키로 바꾸기', run: () => setAuthMode('apikey') }] : []), { label: '다시 확인', run: recheckAll }]} />;
    if (st === 'offline' || net === 'fail') return <InlineMsg info text={providerMsg('MSG-22', 'openai')} detail={ck?.network.message ?? status.message} buttons={[{ label: '다시 확인', run: recheckAll }]} />;
    if (st === 'login' || auth === 'fail')
      return code === 'billing' ? (
        <InlineMsg text={providerMsg('MSG-30', 'openai')} detail={ck?.auth.message ?? status.message} buttons={[{ label: '다시 확인', run: recheckAll }]} />
      ) : (
        <InlineMsg
          text={providerMsg('MSG-21', 'openai')}
          detail={ck?.auth.message ?? status.message}
          buttons={[...(authMode === 'chatgpt' ? [{ label: '터미널에서 로그인', run: openLogin }] : []), { label: '다시 확인', primary: true, run: recheckAll }]}
        />
      );
    return null;
  })();

  const whyNot = !cfg ? '설정을 불러오는 중입니다' : checking ? '연결을 확인하는 중입니다' : cli === 'fail' ? 'Codex CLI를 찾아야 켤 수 있습니다' : !keyReady ? 'API 키를 넣어 주세요' : !azureReady ? 'Azure OpenAI 엔드포인트와 배포 이름을 넣어 주세요' : '';

  return (
    <div class="cp-set">
      <div class="set-page-h">
        <h3>ChatGPT</h3>
        <span class="s">PC에 설치된 Codex(OpenAI)로 대화합니다. 분석 기능은 연결 없이도 모두 쓸 수 있습니다</span>
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
            provider="openai"
            enabled={enabled}
            consentAt={cfg.consentAt}
            offText={providerMsg('MSG-14', 'openai')}
            onText="보내는 정보는 AI 공통의 규칙과 같습니다. [연동 끄기]는 이 앱에서만 ChatGPT를 끄며 PC의 Codex 로그인은 그대로 둡니다."
            err={err}
            saving={saving}
            canEnable={!!cfg && !saving && !checking && cli !== 'fail' && keyReady && azureReady}
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
                  <Radio name="oa-auth" on={authMode === 'chatgpt'} label="ChatGPT 계정 로그인" help="ChatGPT 구독에 포함된 사용량 안에서 · PC의 Codex로 로그인" onPick={() => setAuthMode('chatgpt')} />
                  {authMode === 'chatgpt' && (
                    <>
                      <div class="cp-auth-box">
                        <Icon name="user" size={14} color="var(--icon)" />
                        <span class="lb">
                          <span class="em ellipsis" title={acct?.main}>
                            {acct ? acct.main : '이 PC의 Codex 로그인'}
                          </span>
                          <span class="sub">
                            {acct?.sub && (
                              <span class="ellipsis" title={acct.sub}>
                                {acct.sub}
                              </span>
                            )}
                            {loginTag}
                            {!acct && models.loading && <span>계정 확인 중</span>}
                          </span>
                        </span>
                        <span class="grow" />
                        <button type="button" class="btn cp-b28" onClick={openLogin} disabled={cli === 'fail'}>
                          <Icon name="terminal" size={13} color="var(--ink2)" />
                          터미널에서 로그인
                        </button>
                      </div>
                      <Note icon="refresh" class="cp-switch">
                        <b>다른 계정으로 바꾸기</b> [터미널에서 로그인] → 브라우저에서 바꿀 계정으로 로그인 → 여기서 [다시 확인]. 로그아웃은 열린 창에 <code>codex logout</code>
                      </Note>
                      <Note>로그인은 Codex 자체 화면(브라우저)에서 합니다. 앱은 로그인 정보를 저장하지 않고 계정 이름만 받아 보여 줍니다</Note>
                    </>
                  )}
                  <Radio name="oa-auth" on={authMode === 'apikey'} label="OpenAI API 키" help="OpenAI Platform에서 발급 · 쓴 만큼 과금(ChatGPT 구독과 별도)" onPick={() => setAuthMode('apikey')} />
                  {authMode === 'apikey' && (
                    <div class="cp-auth-sub">
                      <SecretField
                        id="oa-key"
                        label="API 키"
                        hasSaved={!!cfg.hasApiKey}
                        clear={clearKey}
                        value={apiKey}
                        placeholder="sk-…"
                        onInput={setApiKey}
                        onClear={(on) => {
                          setClearKey(on);
                          if (on) setApiKey('');
                        }}
                      />
                      <Note flush>저장한 키는 다시 보여 주지 않고 Codex를 실행할 때만 환경 변수로 넘깁니다. PC의 Codex 로그인 정보는 건드리지 않습니다</Note>
                    </div>
                  )}
                  <Radio name="oa-auth" on={authMode === 'azure'} label="회사 클라우드 (Azure OpenAI)" help="엔드포인트·배포 이름만 넣고, 인증은 PC의 Azure 로그인을 그대로 씁니다" onPick={() => setAuthMode('azure')} />
                  {authMode === 'azure' && (
                    <div class="cp-auth-sub">
                      <TextField id="oa-endpoint" label="엔드포인트" required value={endpoint} placeholder="https://리소스이름.openai.azure.com" onInput={setEndpoint} />
                      <TextField id="oa-deploy" label="배포 이름" required value={deployment} placeholder="예: gpt-6-1-sol" onInput={setDeployment} />
                      <SecretField
                        id="oa-azkey"
                        label="키 (선택)"
                        hasSaved={!!cfg.azure?.hasKey}
                        clear={clearAzureKey}
                        value={azureKey}
                        placeholder="비우면 PC의 Azure 로그인(az login)"
                        onInput={setAzureKey}
                        onClear={(on) => {
                          setClearAzureKey(on);
                          if (on) setAzureKey('');
                        }}
                      />
                      <Note flush>키를 넣지 않으면 PC의 Azure 로그인(az login)으로 받은 토큰을 씁니다. 넣은 키는 Windows 사용자 계정으로 암호화해 저장합니다</Note>
                    </div>
                  )}
                </div>
              </section>
              <div class="cp-dlg-hsep" />

              <section class="cp-sec" aria-label="연결 확인">
                <CheckHead status={status} shown={shown} checking={checking} onRecheck={() => void recheckAll()} title="Codex·인터넷·인증(짧은 시험 요청 1회)과 지금 계정을 다시 확인합니다" />
                <div class="cp-okchips">
                  <OkChip label="Codex" value={cli === 'ok' ? (status?.version ?? '') : cli === 'fail' ? '찾지 못함' : '확인 전'} state={cli} running={checking} title={ck?.cli?.message} />
                  <OkChip label="인터넷" value={net === 'ok' ? (usingProxy ? '프록시 사용' : '연결됨') : net === 'fail' ? '연결 안 됨' : '확인 전'} state={net} running={checking} title={ck?.network.message} />
                  <OkChip label="인증" value={authVal} state={auth} running={checking} title={ck?.auth.message} />
                </div>
                <div class="cp-cli">
                  {status?.cliPath || cfg.cliPath ? <span class="p">{status?.cliPath || cfg.cliPath}</span> : <span class="p auto">codex 실행 파일을 자동으로 찾음</span>}
                  <button type="button" class="cp-linkbtn" onClick={pickCli}>
                    경로 지정
                  </button>
                </div>
                {failBox}
                <ProxyRow id="oa-proxy" value={proxy} onInput={setProxy} />
              </section>
            </div>

            <div class="cp-dlg-vsep" />

            <div class="cp-dlg-col">
              <ModelSection
                provider="openai"
                list={authMode === 'azure' ? null : models.list}
                loading={models.loading}
                onRefresh={() => void models.refresh()}
                model={model}
                custom={customModel}
                setModel={setModel}
                setCustom={setCustomModel}
                defaultLabel={aiDefaultLabel('openai', models.list)}
                fixed={authMode === 'azure' ? deployment.trim() || '배포 이름을 넣어 주세요' : undefined}
                refreshTitle="PC의 Codex에서 모델 목록을 다시 받습니다"
                note={
                  authMode === 'azure'
                    ? 'Azure OpenAI는 배포 이름이 곧 모델입니다. 다른 모델을 쓰려면 Azure에서 배포를 만든 뒤 배포 이름을 바꿉니다.'
                    : '목록은 PC의 Codex가 알려 준 모델입니다. 새 대화에 쓰고, 대화 중에는 입력란 아래에서 바꿉니다.'
                }
              />
              <FeeBox
                title="요금·데이터"
                rows={[
                  { k: '계정 로그인', v: '구독 사용량 한도 안에서 · ChatGPT 워크스페이스의 권한·보관 설정을 따름' },
                  { k: 'API 키', v: 'OpenAI Platform 표준 요금 · API 조직의 보관·데이터 공유 설정을 따름' },
                  { k: 'Azure', v: '회사 Azure 구독으로 청구 · 회사 Azure 리소스의 데이터 설정을 따름' },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
