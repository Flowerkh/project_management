// 설정 > AI 연결 > Claude (POP-03): 연동 켜기·끄기(MSG-14 동의) · 인증 방식(지금 계정·계정 바꾸기) · 연결 확인(CLI·인터넷·인증) ·
// 모델 · 보내는 정보 · AI 요약. 기본 권한·셸 명령 허용 목록은 AI 공통(모든 AI가 함께 씀)에서 정한다.
// 앱은 로그인 토큰·비밀번호를 읽거나 저장하지 않는다. 로그인·계정 바꾸기는 [터미널에서 로그인]으로 연 Claude Code 화면(/login)에서 한다.
// 계정 이름(이메일·조직·구독)은 Claude Code가 알려 준 것을 화면에만 보여 주고 저장하지 않는다.
// API 키는 저장할 때만 보내고 화면에 다시 보여 주지 않는다(메인 프로세스가 Windows 사용자 계정 기준(DPAPI)으로 암호화해 보관).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuthMode, ClaudeConfig, ClaudeConfigInput, ClaudeStatus } from '../../../shared/desktop-api';
import type { SettingsPage, SettingsPageHandle, SettingsPageId } from '../../components/Dialogs';
import { Icon, Spinner } from '../../icons';
import { aiDefaultLabel, invalidateModels, useModels } from '../ai/models';
import { accountLines, CheckHead, type CheckState, InlineMsg, ModelSection, Note, OkChip, OnOffCard, ProxyRow, Radio } from '../ai/parts';
import { AiBadge, shownState } from '../ai/providers';
import { errText } from '../bridge';
import { type DeskApp, useDesk } from '../ctx';
import { msg } from '../messages';
import { STATE_LABEL, StatusDot } from './ClaudeButton';
import { nowIso } from './util';
import './claude.css';

type Provider = 'bedrock' | 'vertex' | 'foundry';

/** 회사 클라우드 설정 (비밀 값이 아닌 것만. 인증은 PC의 AWS·gcloud·Azure 로그인을 그대로 씀) */
const CLOUD: Record<Provider, { label: string; flag: string; fields: { key: string; label: string; placeholder: string; required?: boolean }[] }> = {
  bedrock: {
    label: 'Amazon Bedrock',
    flag: 'CLAUDE_CODE_USE_BEDROCK',
    fields: [
      { key: 'AWS_REGION', label: '리전', placeholder: '예: ap-northeast-2 (비우면 프로필 설정)' },
      { key: 'AWS_PROFILE', label: 'AWS 프로필', placeholder: '비우면 default' },
    ],
  },
  vertex: {
    label: 'Google Cloud',
    flag: 'CLAUDE_CODE_USE_VERTEX',
    fields: [
      { key: 'ANTHROPIC_VERTEX_PROJECT_ID', label: '프로젝트 ID', placeholder: '예: my-gcp-project', required: true },
      { key: 'CLOUD_ML_REGION', label: '리전', placeholder: '예: global, us-east5' },
    ],
  },
  foundry: {
    label: 'Microsoft Foundry',
    flag: 'CLAUDE_CODE_USE_FOUNDRY',
    fields: [{ key: 'ANTHROPIC_FOUNDRY_RESOURCE', label: '리소스 이름', placeholder: '예: my-foundry-resource', required: true }],
  },
};

/** 저장할 값 (셸 허용 목록은 AI 공통에서 따로 저장하므로 보내지 않음) */
function toInput(c: ClaudeConfig): ClaudeConfigInput {
  const { hasApiKey: _h, shellAllow: _s, ...rest } = c;
  return rest;
}

/** 저장할 변경이 있는지 견줄 값 (키 순서·빈 값 차이는 무시) */
function fingerprint(c: ClaudeConfigInput): string {
  const cloud = c.authMode === 'cloud' && c.cloud ? { provider: c.cloud.provider, env: Object.fromEntries(Object.entries(c.cloud.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) } : null;
  return JSON.stringify([c.authMode, cloud, c.proxy || '', !!c.aiSummary, c.model || '']);
}

/** 설정 창 왼쪽 칸의 [Claude] (데스크톱) */
export function claudeSettingsPage(app: DeskApp): SettingsPage {
  const on = !!app.claudeConfig?.enabled;
  const st = shownState(app, 'claude');
  return {
    id: 'claude',
    label: 'Claude',
    group: 'AI 연결',
    icon: <AiBadge provider="claude" size={20} />,
    hint: (
      <>
        <StatusDot state={st} size={7} />
        {on ? `켜짐 · ${st ? STATE_LABEL[st] : '확인 중'}` : st === 'missing' ? 'CLI 없음' : '꺼짐'}
      </>
    ),
    render: ({ handle, done, go }) => <ClaudeSettings handle={handle} onDone={done} go={go} />,
  };
}

/** Claude Code 로그인을 골랐는데 실제로는 다른 인증(API 키 환경 변수 등)을 쓰고 있으면 그 이름 */
function otherAuthLabel(s: ClaudeStatus | null): string | null {
  return s?.authLabel && !/로그인/.test(s.authLabel) ? s.authLabel : null;
}

export function ClaudeSettings(props: { handle: { current: SettingsPageHandle | null }; onDone: (toast: string) => void; go?: (id: SettingsPageId) => void }) {
  const app = useDesk();
  const [cfg, setCfg] = useState<ClaudeConfig | null>(app.claudeConfig);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(app.claude);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 고치는 중인 값 (저장 전)
  const [authMode, setAuthMode] = useState<AuthMode>(app.claudeConfig?.authMode ?? 'login');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [provider, setProvider] = useState<Provider>(app.claudeConfig?.cloud?.provider ?? 'bedrock');
  const [cloudEnv, setCloudEnv] = useState<Record<string, string>>(app.claudeConfig?.cloud?.env ?? {});
  const [proxy, setProxy] = useState(app.claudeConfig?.proxy ?? '');
  const [aiSummary, setAiSummary] = useState(app.claudeConfig?.aiSummary ?? false);
  const [model, setModel] = useState(app.claudeConfig?.model ?? '');
  /** 목록에 없는 모델 이름을 직접 입력하는 중 */
  const [customModel, setCustomModel] = useState(false);
  const loaded = useRef(false);
  const models = useModels(app, 'claude');

  const initFrom = (c: ClaudeConfig) => {
    setAuthMode(c.authMode);
    setProvider(c.cloud?.provider ?? 'bedrock');
    setCloudEnv(c.cloud?.env ?? {});
    setProxy(c.proxy ?? '');
    setAiSummary(!!c.aiSummary);
    setModel(c.model ?? '');
  };

  const recheck = async () => {
    setChecking(true);
    try {
      // 메인 프로세스는 이때 쉬고 있는 Claude 프로세스를 닫는다 (터미널에서 바꾼 로그인을 다음 메시지부터 씀)
      const s = await app.desk.invoke('claude.status', true);
      setStatus(s);
      return s;
    } catch (e) {
      setErr(`연결을 확인하지 못했습니다. ${errText(e)}`);
      return null;
    } finally {
      setChecking(false);
      app.refreshClaude(false);
    }
  };

  /** [다시 확인]: 연결 확인 + 모델 목록·지금 계정 다시 받기 */
  const recheckAll = () => {
    void models.refresh();
    return recheck();
  };

  useEffect(() => {
    app.desk.invoke('claude.config.get').then(
      (c) => {
        setCfg(c);
        if (!loaded.current) initFrom(c);
        loaded.current = true;
      },
      (e) => setLoadErr(errText(e)),
    );
    // 열 때마다: 터미널에서 다른 계정으로 로그인했을 수 있다
    void recheckAll();
  }, []);

  const st = status?.state;
  // 항목별 결과(checks)가 오면 그것을, 없으면 상태(state)로 짐작
  const ck = status?.checks;
  const of = (c: { ok: boolean | null } | undefined): CheckState | null => (c ? (c.ok === true ? 'ok' : c.ok === false ? 'fail' : 'wait') : null);
  const errCode = status?.code ?? ck?.auth.code ?? ck?.network.code;
  const billing = errCode === 'billing' || (st === 'login' && /결제|billing|credit|payment/i.test(status?.message ?? ''));
  const limited = errCode === 'limit';
  const checked = !!status && (!!ck || st !== 'off' || !!status.authMs || !!status.version);
  const cli: CheckState = of(ck?.cli) ?? (st === 'missing' ? 'fail' : status?.version ? 'ok' : 'wait');
  const net: CheckState = of(ck?.network) ?? (st === 'offline' ? 'fail' : st === 'on' || st === 'login' || (st === 'off' && status?.authMs) ? 'ok' : 'wait');
  const auth: CheckState = of(ck?.auth) ?? (st === 'login' ? 'fail' : st === 'on' || (st === 'off' && status?.authMs) ? 'ok' : 'wait');
  const authMs = ck?.auth.ms ?? status?.authMs;
  const usingProxy = !!(proxy.trim() || cfg?.proxy);
  const authVal = auth === 'ok' ? (authMs ? `시험 요청 ${(authMs / 1000).toFixed(1)}초` : '확인됨') : auth === 'fail' ? (billing ? '결제·권한 확인 필요' : limited ? '사용 한도' : '실패') : '확인 전';

  // 인증 방식별 준비
  const prov = CLOUD[provider];
  const keyReady = authMode !== 'apikey' || (!clearKey && (!!apiKey.trim() || !!cfg?.hasApiKey));
  const cloudReady = authMode !== 'cloud' || prov.fields.every((f) => !f.required || !!cloudEnv[f.key]?.trim());
  const failed = st === 'missing' || st === 'offline' || st === 'login' || cli === 'fail' || net === 'fail' || auth === 'fail';
  const enabled = !!cfg?.enabled;
  const canEnable = !!cfg && !saving && !checking && cli === 'ok' && !failed && keyReady && cloudReady;
  const whyNot = !cfg
    ? '설정을 불러오는 중입니다'
    : checking
      ? '연결을 확인하는 중입니다'
      : cli !== 'ok'
        ? 'Claude CLI를 확인해야 켤 수 있습니다'
        : failed
          ? '연결 확인에서 실패한 항목을 먼저 해결해 주세요'
          : !keyReady
            ? 'API 키를 넣어 주세요'
            : !cloudReady
              ? '회사 클라우드 설정을 채워 주세요'
              : '';

  const buildInput = (patch: Partial<ClaudeConfigInput>): ClaudeConfigInput => {
    const base = toInput(cfg!);
    const env: Record<string, string> = {};
    for (const f of prov.fields) {
      const v = cloudEnv[f.key]?.trim();
      if (v) env[f.key] = v;
    }
    env[prov.flag] = '1';
    const input: ClaudeConfigInput = {
      ...base,
      authMode,
      cloud: authMode === 'cloud' ? { provider, env } : base.cloud,
      proxy: proxy.trim() || undefined,
      aiSummary,
      model: model.trim() || undefined,
      ...patch,
    };
    delete input.apiKey;
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    else if (clearKey) input.apiKey = '';
    return input;
  };

  /** 저장 → 켜져 있으면 연결 확인 결과, 꺼져 있으면 null, 못 함 false */
  const commit = async (patch: Partial<ClaudeConfigInput>): Promise<ClaudeStatus | null | false> => {
    if (!cfg) return false;
    if (patch.enabled !== false && (!keyReady || !cloudReady)) {
      setErr(!keyReady ? 'API 키를 넣어 주세요.' : '회사 클라우드 설정을 채워 주세요.');
      return false;
    }
    setSaving(true);
    setErr(null);
    try {
      const next = await app.desk.invoke('claude.config.set', buildInput(patch));
      // 인증·CLI가 바뀌면 쓸 수 있는 모델·계정도 달라질 수 있다
      if (next.authMode !== cfg.authMode || next.cliPath !== cfg.cliPath || JSON.stringify(next.cloud) !== JSON.stringify(cfg.cloud) || !!apiKey.trim() || clearKey) invalidateModels('claude');
      setCfg(next);
      setApiKey('');
      setClearKey(false);
      const s = next.enabled ? await recheck() : null;
      await app.refreshClaude(false);
      return s;
    } catch (e) {
      setErr(`저장하지 못했습니다. ${errText(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const turnOn = async () => {
    const s = await commit({ enabled: true, consentAt: nowIso() });
    if (s === false) return;
    if (!s || s.state !== 'on') {
      setErr('연동을 켰지만 연결 확인에 실패했습니다. 아래 연결 확인의 안내에 따라 해결한 뒤 [다시 확인]을 눌러 주세요.');
      return;
    }
    props.onDone('Claude 연동을 켰습니다.');
  };

  const turnOff = async () => {
    if ((await commit({ enabled: false })) === false) return;
    props.onDone('Claude 연동을 껐습니다. 분석 기능은 그대로 쓸 수 있습니다.');
  };

  // 설정 창의 [저장]: 바뀐 것이 있을 때만 저장
  const dirty = !!cfg && (fingerprint(buildInput({})) !== fingerprint(toInput(cfg)) || !!apiKey.trim() || clearKey);
  const live = useRef({ dirty, commit });
  live.current = { dirty, commit };
  useEffect(() => {
    props.handle.current = { dirty: () => live.current.dirty, save: async () => (await live.current.commit({})) !== false };
    return () => {
      props.handle.current = null;
    };
  }, [props.handle]);

  const pickCli = async () => {
    try {
      const p = await app.desk.invoke('claude.pickCli');
      if (!p) return;
      if (cfg) {
        const next = await app.desk.invoke('claude.config.set', { ...toInput(cfg), cliPath: p });
        setCfg(next);
      }
      await recheck();
    } catch (e) {
      setErr(`경로를 지정하지 못했습니다. ${errText(e)}`);
    }
  };

  const openLogin = async () => {
    try {
      const ok = await app.desk.invoke('claude.openLogin');
      app.toast(ok ? '열린 터미널에서 /login으로 로그인한 뒤 [다시 확인]을 눌러 주세요.' : '터미널을 열지 못했습니다. 터미널에서 claude를 실행해 /login으로 로그인한 뒤 [다시 확인]을 눌러 주세요.');
    } catch (e) {
      setErr(errText(e));
    }
  };

  const loginTag = authMode !== 'login' ? null : auth === 'ok' && !otherAuthLabel(status) ? <span class="tag ok">로그인됨</span> : st === 'login' ? <span class="tag err">로그인 필요</span> : <span class="tag neutral">확인 전</span>;
  const otherAuth = authMode === 'login' ? otherAuthLabel(status) : null;

  const failBox = (() => {
    if (checking || !status) return null;
    if (limited)
      return <InlineMsg text={msg('MSG-23')} detail={status.message} buttons={[{ label: 'API 키로 바꾸기', run: () => setAuthMode('apikey') }, { label: '다시 확인', run: recheckAll }]} />;
    if (st === 'missing' || cli === 'fail')
      return (
        <InlineMsg
          text={msg('MSG-20')}
          detail={status.message}
          buttons={[
            { label: '경로 지정', run: pickCli },
            { label: '다시 확인', primary: true, run: recheckAll },
          ]}
        />
      );
    if (st === 'offline' || net === 'fail') return <InlineMsg info text={msg('MSG-22')} detail={status.message ?? ck?.network.message} buttons={[{ label: '다시 확인', run: recheckAll }]} />;
    if (st === 'login' || auth === 'fail')
      return billing ? (
        <InlineMsg text={msg('MSG-30')} detail={status.message} buttons={[{ label: '다시 확인', run: recheckAll }]} />
      ) : (
        <InlineMsg
          text={msg('MSG-21')}
          detail={status.message}
          buttons={[
            { label: '터미널에서 로그인', run: openLogin },
            { label: '다시 확인', primary: true, run: recheckAll },
          ]}
        />
      );
    return null;
  })();

  const acct = accountLines(models.list?.account);

  return (
    <div class="cp-set">
      <div class="set-page-h">
        <h3>Claude</h3>
        <span class="s">PC에 설치된 Claude Code로 대화합니다. 분석 기능은 연결 없이도 모두 쓸 수 있습니다</span>
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
          {/* 연동 켜기·끄기 */}
          <OnOffCard
            provider="claude"
            enabled={enabled}
            consentAt={cfg.consentAt}
            offText={msg('MSG-14')}
            onText="보내는 정보는 아래와 같고, 접속 정보 파일은 읽지 않습니다. [연동 끄기]는 이 앱에서만 Claude를 끄며 PC의 Claude Code 로그인은 그대로 둡니다."
            err={err}
            saving={saving}
            canEnable={canEnable}
            whyNot={whyNot}
            onOn={turnOn}
            onOff={turnOff}
          />

          <div class="cp-set-cols">
            <div class="cp-dlg-col">
              {/* 1. 인증 방식 */}
              <section class="cp-sec" aria-label="인증 방식">
                <div class="cp-sec-h">
                  <h4>인증 방식</h4>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  <Radio on={authMode === 'login'} label="Claude Code 로그인" help="Claude 구독(Pro·Max·Team·Enterprise) 또는 Console" onPick={() => setAuthMode('login')} />
                  {authMode === 'login' && (
                    <>
                      <div class="cp-auth-box">
                        <Icon name="user" size={14} color="var(--icon)" />
                        <span class="lb">
                          <span class="em ellipsis" title={acct?.main}>
                            {acct ? acct.main : '이 PC의 Claude Code 로그인'}
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
                        <button type="button" class="btn cp-b28" onClick={openLogin}>
                          <Icon name="terminal" size={13} color="var(--ink2)" />
                          터미널에서 로그인
                        </button>
                      </div>
                      <Note icon="refresh" class="cp-switch">
                        <b>다른 계정으로 바꾸기</b> [터미널에서 로그인] → 열린 창에 <code>/login</code> → 브라우저에서 로그인 → 여기서 [다시 확인]. 로그아웃은 <code>/logout</code>
                      </Note>
                      <Note>
                        로그인은 Claude Code 자체 화면(브라우저)에서 합니다. 앱은 로그인 정보를 저장하지 않고 계정 이름만 받아 보여 줍니다
                        {otherAuth && ` · 지금은 ${otherAuth}을(를) 씁니다(환경 변수가 로그인보다 우선)`}
                      </Note>
                    </>
                  )}
                  <Radio on={authMode === 'apikey'} label="API 키" help="Console 발급 키, 회사 발급 키 가능 · Windows 사용자 계정으로 암호화해 저장" onPick={() => setAuthMode('apikey')} />
                  {authMode === 'apikey' && (
                    <div class="cp-auth-sub">
                      <div class="cp-field-row">
                        <label for="cp-key">API 키</label>
                        <input
                          id="cp-key"
                          class="inp mono"
                          type="password"
                          autocomplete="off"
                          spellcheck={false}
                          placeholder={clearKey ? '저장할 때 지웁니다' : cfg.hasApiKey ? '저장됨 · 바꾸려면 새 키 입력' : 'sk-ant-api03-…'}
                          value={apiKey}
                          disabled={clearKey}
                          onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
                        />
                        {cfg.hasApiKey &&
                          (clearKey ? (
                            <button type="button" class="cp-linkbtn" onClick={() => setClearKey(false)}>
                              되돌리기
                            </button>
                          ) : (
                            <button type="button" class="cp-linkbtn danger" onClick={() => { setClearKey(true); setApiKey(''); }}>
                              지우기
                            </button>
                          ))}
                      </div>
                      <Note flush>저장한 키는 다시 보여 주지 않고 Claude를 실행할 때만 환경 변수로 넘깁니다(로그인보다 우선). 회사 발급 키의 요금은 키 소유자에게 청구됩니다</Note>
                    </div>
                  )}
                  <Radio on={authMode === 'cloud'} label="회사 클라우드" help="Amazon Bedrock · Google Cloud · Microsoft Foundry" onPick={() => setAuthMode('cloud')} />
                  {authMode === 'cloud' && (
                    <div class="cp-auth-sub">
                      <div class="cp-field-row">
                        <label for="cp-prov">클라우드</label>
                        <select id="cp-prov" class="inp" value={provider} onChange={(e) => setProvider((e.target as HTMLSelectElement).value as Provider)}>
                          {(Object.keys(CLOUD) as Provider[]).map((p) => (
                            <option key={p} value={p}>
                              {CLOUD[p].label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {prov.fields.map((f) => (
                        <div class="cp-field-row" key={f.key}>
                          <label for={`cp-${f.key}`} title={f.key}>
                            {f.label}
                            {f.required && <span style={{ color: 'var(--err)' }}> *</span>}
                          </label>
                          <input
                            id={`cp-${f.key}`}
                            class="inp mono"
                            placeholder={f.placeholder}
                            value={cloudEnv[f.key] ?? ''}
                            spellcheck={false}
                            onInput={(e) => setCloudEnv((v) => ({ ...v, [f.key]: (e.target as HTMLInputElement).value }))}
                          />
                        </div>
                      ))}
                      <Note flush>키·비밀 값은 넣지 않습니다. PC의 AWS 로그인(aws sso login)·gcloud 로그인·Azure 로그인(az login)을 그대로 씁니다</Note>
                    </div>
                  )}
                </div>
              </section>
              <div class="cp-dlg-hsep" />

              {/* 2. 연결 확인 */}
              <section class="cp-sec" aria-label="연결 확인">
                <CheckHead status={status} shown={checked} checking={checking} onRecheck={() => void recheckAll()} title="CLI·인터넷·인증과 지금 계정을 다시 확인합니다" />
                <div class="cp-okchips">
                  <OkChip label="CLI" value={cli === 'ok' ? status?.version ?? '' : cli === 'fail' ? '찾지 못함' : '확인 전'} state={cli} running={checking} />
                  <OkChip label="인터넷" value={net === 'ok' ? (usingProxy ? '프록시 사용' : '연결됨') : net === 'fail' ? '연결 안 됨' : '확인 전'} state={net} running={checking} />
                  <OkChip label="인증" value={authVal} state={auth} running={checking} />
                </div>
                <div class="cp-cli">
                  {status?.cliPath || cfg.cliPath ? <span class="p">{status?.cliPath || cfg.cliPath}</span> : <span class="p auto">claude 실행 파일을 자동으로 찾음</span>}
                  <button type="button" class="cp-linkbtn" onClick={pickCli}>
                    경로 지정
                  </button>
                </div>
                {failBox}
                <ProxyRow id="cp-proxy" value={proxy} onInput={setProxy} />
              </section>
              <div class="cp-dlg-hsep" />

              {/* 모델 */}
              <ModelSection
                provider="claude"
                list={models.list}
                loading={models.loading}
                onRefresh={() => void models.refresh()}
                model={model}
                custom={customModel}
                setModel={setModel}
                setCustom={setCustomModel}
                defaultLabel={aiDefaultLabel('claude', models.list)}
                refreshTitle="PC의 Claude Code에서 모델 목록을 다시 받습니다"
                note="목록은 이 PC의 Claude Code가 알려 준 모델입니다. 새 대화에 쓰고, 대화 중에는 입력란 아래에서 바꿉니다."
              />
              <div class="cp-dlg-hsep" />

              {/* 5. AI 요약 */}
              {/* AI 요약(F-10)은 아직 동작하지 않아 고를 수 없게 둔다 (다음 버전) */}
              <label class="cp-check" style={{ opacity: 0.6, cursor: 'default' }}>
                <input type="checkbox" checked={false} disabled onChange={() => setAiSummary(false)} />
                <span>
                  <span class="l">AI 요약도 사용 <span class="tag neutral" style={{ marginLeft: '4px' }}>다음 버전</span></span>
                  <span class="h">결과 요약·역할 문장을 Claude로 다듬음. 파일 경로·화면 제목·SQL 일부를 보냄(접속 정보는 가림)</span>
                </span>
              </label>
            </div>

            <div class="cp-dlg-vsep" />

            <div class="cp-dlg-col">
              {/* 3. 보내는 정보 */}
              <section class="cp-sec" aria-label="보내는 정보">
                <div class="cp-sec-h">
                  <h4>보내는 정보</h4>
                </div>
                <div class="cp-send-box">
                  <div>
                    <div class="t">보냄</div>
                    <ul>
                      {['질문과 대화 내용', '맥락으로 붙인 분석 결과', 'Claude가 읽은 소스 일부', 'SELECT 조회 결과 (개인정보 가림)'].map((t) => (
                        <li key={t}>
                          <span class="ic">
                            <Icon name="arrow_up" size={13} color="var(--acc)" sw={2} />
                          </span>
                          <span>{t}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div class="t">보내지 않음</div>
                    <ul>
                      {['접속 정보 파일 (globals.properties·.env 등)', 'API 키·DB 계정·Git·SVN 로그인 정보', '연 프로젝트·참고 프로젝트 밖의 파일', '맥락에 붙이지 않은 분석 결과'].map((t) => (
                        <li key={t}>
                          <span class="ic">
                            <Icon name="lock" size={13} color="var(--muted)" sw={2} />
                          </span>
                          <span>{t}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
              <div class="cp-dlg-hsep" />

              {/* 기본 권한은 AI 공통에서 (모든 AI가 같은 규칙) */}
              <section class="cp-sec" aria-label="기본 권한">
                <div class="cp-sec-h">
                  <h4>기본 권한</h4>
                </div>
                <div class="ai-pointer">
                  <Icon name="lock" size={14} color="var(--muted)" sw={1.9} />
                  <span>시작 모드·파일 수정·쿼리·셸 명령 허용 목록은 모든 AI에 같게 적용합니다.</span>
                  {props.go && (
                    <button type="button" class="cp-linkbtn" onClick={() => props.go?.('ai')}>
                      AI 공통에서 보기 →
                    </button>
                  )}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
