// POP-03 Claude 연결: 인증 방식 · 연결 확인(CLI·인터넷·인증) · 보내는 정보 · 기본 권한 · AI 요약 · 연동 켜기(MSG-14 동의).
// 앱은 Claude 계정 정보·로그인 토큰을 읽거나 저장하지 않는다. 로그인은 [터미널에서 로그인]으로 연 Claude Code 화면에서 한다.
// API 키는 저장할 때만 보내고 화면에 다시 보여 주지 않는다(메인 프로세스가 Windows 자격 증명으로 암호화해 보관).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuthMode, ClaudeConfig, ClaudeConfigInput, ClaudeStatus } from '../../../shared/desktop-api';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { useDesk } from '../ctx';
import { msg } from '../messages';
import { Avatar } from './items';
import { hm, nowIso, ymdhm } from './util';
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

const BAD_CMD = /[;&|<>`]|\$\(/;

function toInput(c: ClaudeConfig): ClaudeConfigInput {
  const { hasApiKey: _h, ...rest } = c;
  return rest;
}

type CheckState = 'ok' | 'fail' | 'wait';

/** Claude Code 로그인을 골랐는데 실제로는 다른 인증(API 키 환경 변수 등)을 쓰고 있으면 그 이름 */
function otherAuthLabel(s: ClaudeStatus | null): string | null {
  return s?.authLabel && !/로그인/.test(s.authLabel) ? s.authLabel : null;
}

function OkChip(props: { label: string; value: string; state: CheckState; running?: boolean }) {
  const cls = props.state === 'fail' ? ' fail' : props.state === 'wait' ? ' wait' : '';
  return (
    <span class={`cp-ok${cls}`}>
      <span class="c">
        {props.running ? (
          <Spinner size={11} />
        ) : props.state === 'ok' ? (
          <Icon name="check" size={11} color="var(--ok)" sw={2.6} />
        ) : props.state === 'fail' ? (
          <Icon name="close" size={10} color="var(--err)" sw={2.6} />
        ) : (
          <Icon name="clock" size={11} color="var(--faint)" sw={2.2} />
        )}
      </span>
      <b>{props.label}</b>
      {props.value}
    </span>
  );
}

function Radio(props: { on: boolean; label: string; help: string; onPick: () => void }) {
  return (
    <label class={`cp-radio${props.on ? ' on' : ''}`}>
      <input type="radio" name="cp-auth" checked={props.on} onChange={props.onPick} />
      <span class="o" />
      <span class="l">{props.label}</span>
      <span class="h">{props.help}</span>
    </label>
  );
}

export function ClaudeDialog(props: { onClose: () => void }) {
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
  const [shell, setShell] = useState<string[]>(app.claudeConfig?.shellAllow ?? []);
  const [aiSummary, setAiSummary] = useState(app.claudeConfig?.aiSummary ?? false);
  const [adding, setAdding] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const loaded = useRef(false);

  const initFrom = (c: ClaudeConfig) => {
    setAuthMode(c.authMode);
    setProvider(c.cloud?.provider ?? 'bedrock');
    setCloudEnv(c.cloud?.env ?? {});
    setProxy(c.proxy ?? '');
    setShell(c.shellAllow ?? []);
    setAiSummary(!!c.aiSummary);
  };

  const recheck = async () => {
    setChecking(true);
    try {
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

  useEffect(() => {
    app.desk.invoke('claude.config.get').then(
      (c) => {
        setCfg(c);
        if (!loaded.current) initFrom(c);
        loaded.current = true;
      },
      (e) => setLoadErr(errText(e)),
    );
    recheck();
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && props.onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [props.onClose]);

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
      shellAllow: shell,
      aiSummary,
      ...patch,
    };
    delete input.apiKey;
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    else if (clearKey) input.apiKey = '';
    return input;
  };

  const save = async (patch: Partial<ClaudeConfigInput>, done: (s: ClaudeStatus | null) => boolean) => {
    if (!cfg) return;
    setSaving(true);
    setErr(null);
    try {
      const next = await app.desk.invoke('claude.config.set', buildInput(patch));
      setCfg(next);
      setApiKey('');
      setClearKey(false);
      const s = patch.enabled === false ? null : await recheck();
      await app.refreshClaude(false);
      if (done(s)) props.onClose();
    } catch (e) {
      setErr(`저장하지 못했습니다. ${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const turnOn = () =>
    save({ enabled: true, consentAt: nowIso() }, (s) => {
      if (s && s.state !== 'on') {
        setErr('연동을 켰지만 연결 확인에 실패했습니다. 위의 안내에 따라 해결한 뒤 [다시 확인]을 눌러 주세요.');
        return false;
      }
      app.toast('Claude 연동을 켰습니다.');
      return true;
    });

  const saveOnly = () =>
    save({}, () => {
      app.toast('Claude 연결 설정을 저장했습니다.');
      return true;
    });

  const turnOff = () =>
    save({ enabled: false }, () => {
      app.toast('Claude 연동을 껐습니다. 분석 기능은 그대로 쓸 수 있습니다.');
      return true;
    });

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
      app.toast(ok ? '터미널에서 Claude Code 로그인을 마친 뒤 [다시 확인]을 눌러 주세요.' : '터미널을 열지 못했습니다.');
    } catch (e) {
      setErr(errText(e));
    }
  };

  const addCmd = () => {
    const v = (adding ?? '').trim().replace(/\s+/g, ' ');
    if (!v) {
      setAdding(null);
      setAddErr(null);
      return;
    }
    if (BAD_CMD.test(v)) {
      setAddErr('명령 하나만 넣어 주세요 (; | & > ` 같은 기호 없이).');
      return;
    }
    if (shell.includes(v)) {
      setAddErr('이미 있는 명령입니다.');
      return;
    }
    setShell((s) => [...s, v]);
    setAdding(null);
    setAddErr(null);
  };

  const loginTag = authMode !== 'login' ? null : auth === 'ok' && !otherAuthLabel(status) ? <span class="tag ok">로그인됨</span> : st === 'login' ? <span class="tag err">로그인 필요</span> : <span class="tag neutral">확인 전</span>;
  const otherAuth = authMode === 'login' ? otherAuthLabel(status) : null;

  const failBox = (() => {
    if (checking || !status) return null;
    if (limited)
      return <InlineMsg text={msg('MSG-23')} detail={status.message} buttons={[{ label: 'API 키로 바꾸기', run: () => setAuthMode('apikey') }, { label: '다시 확인', run: recheck }]} />;
    if (st === 'missing' || cli === 'fail')
      return (
        <InlineMsg
          text={msg('MSG-20')}
          detail={status.message}
          buttons={[
            { label: '경로 지정', run: pickCli },
            { label: '다시 확인', primary: true, run: recheck },
          ]}
        />
      );
    if (st === 'offline' || net === 'fail') return <InlineMsg info text={msg('MSG-22')} detail={status.message ?? ck?.network.message} buttons={[{ label: '다시 확인', run: recheck }]} />;
    if (st === 'login' || auth === 'fail')
      return billing ? (
        <InlineMsg text={msg('MSG-30')} detail={status.message} buttons={[{ label: '다시 확인', run: recheck }]} />
      ) : (
        <InlineMsg
          text={msg('MSG-21')}
          detail={status.message}
          buttons={[
            { label: '터미널에서 로그인', run: openLogin },
            { label: '다시 확인', primary: true, run: recheck },
          ]}
        />
      );
    return null;
  })();

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal cp-dlg" role="dialog" aria-modal="true" aria-label="Claude 연결">
        <div class="cp-dlg-head">
          <Avatar size={32} />
          <div class="grow" style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <h2>Claude 연결</h2>
            <span class="s">인터넷이 되는 PC에서만 씁니다. 분석 기능은 연결 없이도 모두 쓸 수 있습니다</span>
          </div>
          <button type="button" class="cp-ibtn" aria-label="닫기" onClick={props.onClose}>
            <Icon name="close" size={18} color="var(--ink2)" />
          </button>
        </div>

        {!cfg ? (
          <div class="modal-body">
            {loadErr ? (
              <div class="banner err">설정을 불러오지 못했습니다. {loadErr}</div>
            ) : (
              <div class="row muted">
                <Spinner size={14} /> 불러오는 중
              </div>
            )}
          </div>
        ) : (
          <div class="cp-dlg-body">
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
                        <span class="lb">이 PC의 Claude Code 로그인</span>
                        {loginTag}
                        <span class="grow" />
                        <button type="button" class="btn cp-b28" onClick={openLogin}>
                          <Icon name="terminal" size={13} color="var(--ink2)" />
                          터미널에서 로그인
                        </button>
                      </div>
                      <span class="cp-lock-note">
                        <span class="ic">
                          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
                        </span>
                        <span>
                          로그인은 Claude Code 자체 화면(브라우저)에서 합니다. 앱은 로그인 정보를 읽거나 저장하지 않습니다
                          {otherAuth && ` · 지금은 ${otherAuth}을(를) 씁니다(환경 변수가 로그인보다 우선)`}
                        </span>
                      </span>
                    </>
                  )}
                  <Radio on={authMode === 'apikey'} label="API 키" help="Console 발급 키, 회사 발급 키 가능 · Windows 자격 증명 관리자에 저장" onPick={() => setAuthMode('apikey')} />
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
                      <span class="cp-lock-note" style={{ marginLeft: 0 }}>
                        <span class="ic">
                          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
                        </span>
                        <span>저장한 키는 다시 보여 주지 않고 Claude를 실행할 때만 환경 변수로 넘깁니다(로그인보다 우선). 회사 발급 키의 요금은 키 소유자에게 청구됩니다</span>
                      </span>
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
                      <span class="cp-lock-note" style={{ marginLeft: 0 }}>
                        <span class="ic">
                          <Icon name="lock" size={12} color="var(--muted)" sw={1.9} />
                        </span>
                        <span>키·비밀 값은 넣지 않습니다. PC의 AWS 로그인(aws sso login)·gcloud 로그인·Azure 로그인(az login)을 그대로 씁니다</span>
                      </span>
                    </div>
                  )}
                </div>
              </section>
              <div class="cp-dlg-hsep" />

              {/* 2. 연결 확인 */}
              <section class="cp-sec" aria-label="연결 확인">
                <div class="cp-sec-h">
                  <h4>연결 확인</h4>
                  {status?.checkedAt && checked && !checking && <span class="at">{hm(status.checkedAt)} 확인</span>}
                  <button type="button" class="btn cp-b28" onClick={recheck} disabled={checking} style={{ fontSize: '12.5px' }}>
                    {checking ? <Spinner size={13} /> : <Icon name="refresh" size={14} color="var(--ink2)" />}
                    다시 확인
                  </button>
                </div>
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
                <div class="cp-field-row">
                  <label for="cp-proxy" title="HTTPS_PROXY">사내 프록시</label>
                  <input
                    id="cp-proxy"
                    class="inp mono"
                    placeholder="비우면 PC 설정 (예: http://proxy:8080)"
                    value={proxy}
                    spellcheck={false}
                    onInput={(e) => setProxy((e.target as HTMLInputElement).value)}
                  />
                </div>
              </section>
              <div class="cp-dlg-hsep" />

              {/* 5. AI 요약 */}
              <label class="cp-check">
                <input type="checkbox" checked={aiSummary} onChange={(e) => setAiSummary((e.target as HTMLInputElement).checked)} />
                <span>
                  <span class="l">AI 요약도 사용</span>
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

              {/* 4. 기본 권한 */}
              <section class="cp-sec" aria-label="기본 권한">
                <div class="cp-sec-h">
                  <h4>기본 권한</h4>
                </div>
                <div class="cp-perm">
                  <div class="cp-prow">
                    <span class="k">시작 모드</span>
                    <div class="v">
                      <span class="mode">
                        <Icon name="lock" size={13} color="var(--muted)" sw={1.9} />
                        계획 모드
                      </span>
                      <span>항상 계획 모드로 시작, 대화에서 수정 허용으로 바꿈</span>
                    </div>
                  </div>
                  <div class="cp-prow">
                    <span class="k">파일 수정</span>
                    <div class="v">작업 사본에서만 · 원본 반영은 변경 검토에서 [적용]할 때만 · 새 프로젝트는 빈 폴더에 바로 생성</div>
                  </div>
                  <div class="cp-prow">
                    <span class="k">쿼리</span>
                    <div class="v">SELECT만 바로 실행(운영은 항상 확인) · 그 외는 사용자가 확인한 뒤 실행 · DB 연결은 프로젝트 연결에서</div>
                  </div>
                  <div class="cp-prow top">
                    <span class="k">셸 명령</span>
                    <div class="v">
                      <span style={{ width: '100%' }}>{shell.length ? '허용 목록만 실행하고, 실행할 때마다 확인' : '허용 목록이 비어 있어 셸 명령을 실행하지 않음'}</span>
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {shell.map((c) => (
                          <span class="cp-rchip" key={c}>
                            {c}
                            <button type="button" aria-label={`${c} 빼기`} onClick={() => setShell((s) => s.filter((x) => x !== c))}>
                              <Icon name="close" size={12} sw={2} />
                            </button>
                          </span>
                        ))}
                        {adding === null ? (
                          <button type="button" class="cp-addchip" onClick={() => setAdding('')}>
                            <Icon name="plus" size={13} color="var(--ink2)" sw={2} />
                            추가
                          </button>
                        ) : (
                          <input
                            class="cp-addinp"
                            aria-label="허용할 명령"
                            placeholder="예: mvn -q test (Enter)"
                            value={adding}
                            ref={(el) => el && setTimeout(() => el.focus(), 0)}
                            onInput={(e) => {
                              setAdding((e.target as HTMLInputElement).value);
                              setAddErr(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.isComposing) {
                                e.preventDefault();
                                addCmd();
                              } else if (e.key === 'Escape') {
                                e.stopPropagation();
                                setAdding(null);
                                setAddErr(null);
                              }
                            }}
                            onBlur={() => !(adding ?? '').trim() && setAdding(null)}
                          />
                        )}
                      </span>
                      {addErr && <span class="err-text" style={{ width: '100%' }}>{addErr}</span>}
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        <div class="cp-dlg-foot">
          <span class="msg">
            <span class="ic">
              <Icon name="info" size={14} color="var(--acc-d)" sw={1.9} />
            </span>
            {err ? (
              <span style={{ color: 'var(--err)' }}>{err}</span>
            ) : enabled ? (
              <span>
                연동 켜짐{cfg?.consentAt ? ` · ${ymdhm(cfg.consentAt)} 동의` : ''}. 보내는 정보는 위와 같고, 접속 정보 파일은 읽지 않습니다.
              </span>
            ) : (
              <span>{msg('MSG-14')}</span>
            )}
          </span>
          {enabled && (
            <button type="button" class="btn danger" onClick={turnOff} disabled={saving}>
              연동 끄기
            </button>
          )}
          <button type="button" class="btn" onClick={props.onClose}>
            취소
          </button>
          {enabled ? (
            <button type="button" class="btn primary" onClick={saveOnly} disabled={saving || !cfg || !keyReady || !cloudReady} title={!keyReady ? 'API 키를 넣어 주세요' : !cloudReady ? '회사 클라우드 설정을 채워 주세요' : undefined}>
              {saving && <Spinner size={13} color="#fff" />}
              저장
            </button>
          ) : (
            <button type="button" class="btn primary" onClick={turnOn} disabled={!canEnable} title={whyNot || undefined}>
              {saving && <Spinner size={13} color="#fff" />}
              연동 켜기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function InlineMsg(props: { text: string; detail?: string; info?: boolean; buttons: { label: string; primary?: boolean; run: () => void }[] }) {
  return (
    <div class={`cp-inline-err${props.info ? ' info' : ''}`} role={props.info ? 'status' : 'alert'}>
      <span>{props.text}</span>
      {props.detail && props.detail !== props.text && <span style={{ fontSize: '12px', opacity: 0.85 }}>{props.detail}</span>}
      <div class="btns">
        {props.buttons.map((b) => (
          <button type="button" key={b.label} class={`btn sm${b.primary ? ' primary' : ''}`} onClick={b.run}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

