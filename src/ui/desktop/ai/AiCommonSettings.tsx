// 설정 > AI 연결 > AI 공통: 새 대화의 기본 AI · AI별 차이 · 모든 AI에 같은 권한(셸 명령 허용 목록 포함).
// 기본 AI는 켠 AI 중에서만 고른다. 셸 허용 목록은 Claude·Gemini·ChatGPT가 함께 쓴다(실행할 때마다 확인 MSG-24).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AiProvider, AiSettings } from '../../../shared/desktop-api';
import { AI_LABEL, AI_PROVIDERS } from '../../../shared/desktop-api';
import type { SettingsPage, SettingsPageHandle, SettingsPageId } from '../../components/Dialogs';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { type DeskApp, useDesk } from '../ctx';
import { connDefault, modelName, peekModels, pickedName, useModels } from './models';
import { planName } from './parts';
import { AiBadge, chatProvider, providerEnabled } from './providers';
import '../claude/claude.css';

const BAD_CMD = /[;&|<>`]|\$\(/;

/** 설정 창 왼쪽 칸의 [AI 공통] */
export function aiCommonSettingsPage(app: DeskApp): SettingsPage {
  const def = app.ai.settings?.defaultProvider ?? 'claude';
  return {
    id: 'ai',
    label: 'AI 공통',
    group: 'AI 연결',
    icon: <Icon name="sparkle" size={17} color="var(--ink2)" />,
    hint: `기본 AI ${AI_LABEL[providerEnabled(app, def) ? def : chatProvider(app)]} · 공통 권한`,
    render: ({ handle, go }) => <AiCommonSettings handle={handle} go={go} />,
  };
}

/** 카드 둘째 줄: 인증 방식 · 구독 / 기본 모델 */
function cardLines(app: DeskApp, p: AiProvider): [string, string] {
  const list = peekModels(p);
  const plan = planName(list?.account?.subscription);
  let auth: string;
  if (p === 'claude') {
    const c = app.claudeConfig;
    auth = c?.authMode === 'apikey' ? 'API 키' : c?.authMode === 'cloud' ? `회사 클라우드${c.cloud ? ` (${c.cloud.provider === 'bedrock' ? 'Amazon Bedrock' : c.cloud.provider === 'vertex' ? 'Google Cloud' : 'Microsoft Foundry'})` : ''}` : 'Claude Code 로그인';
  } else if (p === 'gemini') auth = app.ai.gemini?.authMode === 'vertex' ? '회사 Google Cloud (Vertex AI)' : 'Gemini API 키';
  else {
    const m = app.ai.openai?.authMode;
    auth = m === 'apikey' ? 'OpenAI API 키' : m === 'azure' ? 'Azure OpenAI' : 'ChatGPT 계정 로그인';
  }
  const conn = connDefault(app, p);
  const model = p === 'claude' ? modelName(list, conn, 'Claude Code 기본값') : pickedName(p, list, conn ?? '', conn);
  return [plan && (p === 'claude' ? app.claudeConfig?.authMode === 'login' : p === 'openai' && app.ai.openai?.authMode === 'chatgpt') ? `${auth} · ${plan}` : auth, `기본 모델 ${model}`];
}

const DIFF: { k: string; v: [string, string | [string, string], string] | string }[] = [
  { k: '연결 방식', v: ['PC에 설치된 Claude Code', '앱이 Gemini API에 바로 연결 (설치할 것 없음)', 'PC에 설치된 Codex CLI'] },
  { k: '인증', v: ['Claude 구독 로그인 · API 키 · 회사 클라우드', 'API 키 · 회사 Google Cloud(Vertex AI)', 'ChatGPT 구독 로그인 · API 키 · Azure OpenAI'] },
  { k: '요금', v: ['구독 사용량 또는 API 사용량', 'API 사용량 (Google AI 구독과 별도)', '구독 사용량 또는 API 사용량'] },
  { k: '할 수 있는 일', v: '셋 모두 같음 — 질문 · 계획 → 수정 진행(작업 사본) · DB 조회 · 셸 명령(허용 목록)' },
  { k: '보낸 내용 처리', v: ['Claude 계정·조직의 데이터 설정을 따름', ['결제 연결된 키: 학습에 쓰지 않음', '무료 키: Google 서비스 개선에 쓰임'], 'ChatGPT 워크스페이스 또는 API 조직의 데이터 설정을 따름'] },
];

export function AiCommonSettings(props: { handle: { current: SettingsPageHandle | null }; go(id: SettingsPageId): void }) {
  const app = useDesk();
  const [saved, setSaved] = useState<AiSettings | null>(app.ai.settings);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [def, setDef] = useState<AiProvider>(app.ai.settings?.defaultProvider ?? 'claude');
  const [shell, setShell] = useState<string[]>(app.ai.settings?.shellAllow ?? []);
  const [adding, setAdding] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);
  // 카드의 구독·기본 모델 이름 (켠 AI만, 받아 둔 것이 있으면 그대로)
  useModels(app, 'claude', providerEnabled(app, 'claude'));
  useModels(app, 'gemini', providerEnabled(app, 'gemini'));
  useModels(app, 'openai', providerEnabled(app, 'openai'));

  useEffect(() => {
    app.desk.invoke('ai.settings.get').then(
      (s) => {
        setSaved(s);
        if (!loaded.current) {
          setDef(s.defaultProvider);
          setShell(s.shellAllow);
        }
        loaded.current = true;
      },
      (e) => setLoadErr(errText(e)),
    );
  }, []);

  const dirty = !!saved && (def !== saved.defaultProvider || JSON.stringify(shell) !== JSON.stringify(saved.shellAllow));
  const commit = async (): Promise<boolean> => {
    if (!saved) return false;
    setSaving(true);
    setErr(null);
    try {
      const next = await app.desk.invoke('ai.settings.set', { defaultProvider: def, shellAllow: shell });
      setSaved(next);
      await app.refreshAi();
      return true;
    } catch (e) {
      setErr(`저장하지 못했습니다. ${errText(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const live = useRef({ dirty, commit });
  live.current = { dirty, commit };
  useEffect(() => {
    props.handle.current = { dirty: () => live.current.dirty, save: () => live.current.commit() };
    return () => {
      props.handle.current = null;
    };
  }, [props.handle]);

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

  const fallback = !providerEnabled(app, def) ? AI_PROVIDERS.find((p) => providerEnabled(app, p)) : undefined;

  return (
    <div class="cp-set">
      <div class="set-page-h">
        <h3>AI 공통</h3>
        <span class="s">새 대화에 쓸 AI를 고르고, 모든 AI에 똑같이 적용할 권한을 정합니다</span>
      </div>
      {loadErr && <div class="banner err">설정을 불러오지 못했습니다. {loadErr}</div>}
      {err && (
        <div class="banner err" role="alert">
          {err}
        </div>
      )}

      <section class="cp-sec" aria-label="새 대화의 기본 AI">
        <div class="cp-sec-h">
          <h4>새 대화의 기본 AI</h4>
          {saving && <Spinner size={13} />}
        </div>
        <div class="ai-cards" role="radiogroup" aria-label="새 대화의 기본 AI">
          {AI_PROVIDERS.map((p) => {
            const on = providerEnabled(app, p);
            const picked = def === p;
            const [l1, l2] = on ? cardLines(app, p) : ['', ''];
            return (
              <label key={p} class={`ai-card${picked ? ' on' : ''}${on ? '' : ' off'}`}>
                <span class="h">
                  <input type="radio" name="default-ai" checked={picked} disabled={!on} onChange={() => setDef(p)} aria-describedby={`ai-card-${p}`} />
                  <AiBadge provider={p} size={22} />
                  <b>{AI_LABEL[p]}</b>
                  {on ? <span class="tag ok">켜짐</span> : <span class="tag neutral">꺼짐</span>}
                </span>
                <span class="d" id={`ai-card-${p}`}>
                  {on ? (
                    <>
                      {l1}
                      <br />
                      {l2}
                    </>
                  ) : (
                    <>
                      켜면 고를 수 있습니다
                      <br />
                      <button type="button" class="cp-linkbtn" onClick={(e) => (e.preventDefault(), props.go(p))}>
                        {AI_LABEL[p]} 켜기 →
                      </button>
                    </>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {fallback && (
          <div class="banner warn" role="status">
            기본 AI인 {AI_LABEL[def]}가 꺼져 있어 새 대화는 {AI_LABEL[fallback]}로 시작합니다.
          </div>
        )}
        <p class="ai-info">
          <Icon name="info" size={13} color="var(--muted)" sw={1.9} />
          <span>대화창 입력란 아래에서도 AI를 고를 수 있습니다. 같은 AI 안에서 모델을 바꾸면 대화가 이어지고, 다른 AI로 바꾸면 새 대화로 시작합니다.</span>
        </p>
      </section>

      <section class="cp-sec" aria-label="AI별 차이">
        <div class="cp-sec-h">
          <h4>AI별 차이</h4>
        </div>
        <div class="ai-diff">
          <table>
            <thead>
              <tr>
                <th scope="col" class="k">
                  항목
                </th>
                {AI_PROVIDERS.map((p) => (
                  <th scope="col" key={p}>
                    {AI_LABEL[p]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DIFF.map((r) => (
                <tr key={r.k}>
                  <th scope="row" class="k">
                    {r.k}
                  </th>
                  {typeof r.v === 'string' ? (
                    <td colSpan={3}>{r.v}</td>
                  ) : (
                    r.v.map((c, i) => (
                      <td key={i}>
                        {Array.isArray(c) ? (
                          <>
                            {c[0]}
                            <br />
                            <b class="warn">{c[1]}</b>
                          </>
                        ) : (
                          c
                        )}
                      </td>
                    ))
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="cp-sec" aria-label="모든 AI에 같은 권한">
        <div class="cp-sec-h">
          <h4>모든 AI에 같은 권한</h4>
        </div>
        <div class="cp-perm ai-perm">
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
              <span>{shell.length ? '허용 목록만, 실행할 때마다 확인' : '허용 목록이 비어 있어 셸 명령을 실행하지 않음'}</span>
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
          <div class="cp-prow">
            <span class="k">보내지 않음</span>
            <div class="v">접속 정보 파일 · API 키·DB 계정·Git·SVN 로그인 정보 · 프로젝트 밖의 파일</div>
          </div>
        </div>
      </section>
    </div>
  );
}
