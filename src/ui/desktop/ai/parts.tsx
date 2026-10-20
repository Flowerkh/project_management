// 설정 > AI 연결 페이지(Claude·Gemini·ChatGPT)가 함께 쓰는 조각: 연동 켜기·끄기 카드, 인증 방식 고르기, 연결 확인 칩,
// 키 입력, 사내 프록시, 모델(기본 모델 고르기·목록), 요금·데이터 상자, 안내 글.
import type { ComponentChildren } from 'preact';
import type { AiProvider, ClaudeAccount, ClaudeCheck, ClaudeModelList, ClaudeStatus } from '../../../shared/desktop-api';
import { AI_LABEL } from '../../../shared/desktop-api';
import { Icon, Spinner } from '../../icons';
import { hm, ymdhm } from '../claude/util';
import { listDefault, modelOptions } from './models';
import { AiBadge } from './providers';

export type CheckState = 'ok' | 'fail' | 'wait';

/** 항목별 확인 결과 → 칩 상태 (없으면 null) */
export function checkOf(c: ClaudeCheck | undefined): CheckState | null {
  return c ? (c.ok === true ? 'ok' : c.ok === false ? 'fail' : 'wait') : null;
}

export function OkChip(props: { label: string; value: string; state: CheckState; running?: boolean; title?: string }) {
  const cls = props.state === 'fail' ? ' fail' : props.state === 'wait' ? ' wait' : '';
  return (
    <span class={`cp-ok${cls}`} title={props.title}>
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

export function Radio(props: { on: boolean; label: string; help: string; onPick: () => void; name?: string }) {
  return (
    <label class={`cp-radio${props.on ? ' on' : ''}`}>
      <input type="radio" name={props.name ?? 'cp-auth'} checked={props.on} onChange={props.onPick} />
      <span class="o" />
      <span class="l">{props.label}</span>
      <span class="h">{props.help}</span>
    </label>
  );
}

export function InlineMsg(props: { text: string; detail?: string; info?: boolean; buttons: { label: string; primary?: boolean; run: () => void }[] }) {
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

/** 작은 안내 줄 (자물쇠·정보·새로고침 아이콘) */
export function Note(props: { icon?: 'lock' | 'info' | 'refresh'; children: ComponentChildren; flush?: boolean; class?: string }) {
  return (
    <span class={`cp-lock-note${props.class ? ` ${props.class}` : ''}`} style={props.flush ? { marginLeft: 0 } : undefined}>
      <span class="ic">
        <Icon name={props.icon ?? 'lock'} size={12} color="var(--muted)" sw={1.9} />
      </span>
      <span>{props.children}</span>
    </span>
  );
}

const PLAN: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free', plus: 'Plus', business: 'Business', edu: 'Edu', go: 'Go' };

/** 구독 이름 (max → Max 구독) */
export function planName(sub: string | undefined): string {
  return sub ? `${PLAN[sub.toLowerCase()] ?? sub} 구독` : '';
}

/** 지금 계정 표시: 첫 줄(이메일) · 둘째 줄(조직 · 구독) */
export function accountLines(a: ClaudeAccount | undefined): { main: string; sub: string } | null {
  if (!a || (!a.email && !a.organization)) return null;
  return { main: a.email ?? a.organization!, sub: [a.email ? a.organization : '', planName(a.subscription)].filter(Boolean).join(' · ') };
}

/** 연동 켜기·끄기 카드 */
export function OnOffCard(props: {
  provider: AiProvider;
  enabled: boolean;
  consentAt?: string;
  /** 꺼져 있을 때 글 (MSG-14) */
  offText: string;
  /** 켜져 있을 때 글 */
  onText: string;
  err: string | null;
  saving: boolean;
  canEnable: boolean;
  whyNot: string;
  onOn(): void;
  onOff(): void;
}) {
  const label = AI_LABEL[props.provider];
  return (
    <div class={`cp-onoff${props.enabled ? ' on' : ''}`} role="group" aria-label={`${label} 연동`}>
      <AiBadge provider={props.provider} size={30} />
      <div class="t">
        <div class="h">
          <b>{label} 연동</b>
          {props.enabled ? <span class="tag ok">켜짐</span> : <span class="tag neutral">꺼짐</span>}
          {props.enabled && props.consentAt && <span class="at">{ymdhm(props.consentAt)} 동의</span>}
        </div>
        <div class="d">{props.enabled ? props.onText : props.offText}</div>
        {props.err && (
          <div class="e" role="alert">
            {props.err}
          </div>
        )}
      </div>
      {props.enabled ? (
        <button type="button" class="btn danger" onClick={props.onOff} disabled={props.saving}>
          {props.saving && <Spinner size={13} />}
          연동 끄기
        </button>
      ) : (
        <button type="button" class="btn primary" onClick={props.onOn} disabled={!props.canEnable} title={props.whyNot || undefined}>
          {props.saving && <Spinner size={13} color="#fff" />}
          연동 켜기
        </button>
      )}
    </div>
  );
}

/** 연결 확인 머리: 마지막 확인 시각 · [다시 확인] */
export function CheckHead(props: { status: ClaudeStatus | null; shown: boolean; checking: boolean; onRecheck(): void; title?: string }) {
  return (
    <div class="cp-sec-h">
      <h4>연결 확인</h4>
      {props.status?.checkedAt && props.shown && !props.checking && <span class="at">{hm(props.status.checkedAt)} 확인</span>}
      <button type="button" class="btn cp-b28" onClick={props.onRecheck} disabled={props.checking} style={{ fontSize: '12.5px' }} title={props.title}>
        {props.checking ? <Spinner size={13} /> : <Icon name="refresh" size={14} color="var(--ink2)" />}
        다시 확인
      </button>
    </div>
  );
}

export function ProxyRow(props: { id: string; value: string; onInput(v: string): void }) {
  return (
    <div class="cp-field-row">
      <label for={props.id} title="HTTPS_PROXY">
        사내 프록시
      </label>
      <input id={props.id} class="inp mono" placeholder="비우면 PC 설정 (예: http://proxy:8080)" value={props.value} spellcheck={false} onInput={(e) => props.onInput((e.target as HTMLInputElement).value)} />
    </div>
  );
}

/** 비밀 값 입력 (저장한 값은 다시 보여 주지 않음 · [지우기]는 저장할 때 지움) */
export function SecretField(props: { id: string; label: string; required?: boolean; hasSaved: boolean; clear: boolean; value: string; placeholder: string; onInput(v: string): void; onClear(on: boolean): void }) {
  return (
    <div class="cp-field-row">
      <label for={props.id}>
        {props.label}
        {props.required && <span style={{ color: 'var(--err)' }}> *</span>}
      </label>
      <input
        id={props.id}
        class="inp mono"
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder={props.clear ? '저장할 때 지웁니다' : props.hasSaved ? '저장됨 · 바꾸려면 새 키 입력' : props.placeholder}
        value={props.value}
        disabled={props.clear}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
      />
      {props.hasSaved &&
        (props.clear ? (
          <button type="button" class="cp-linkbtn" onClick={() => props.onClear(false)}>
            되돌리기
          </button>
        ) : (
          <button type="button" class="cp-linkbtn danger" onClick={() => props.onClear(true)}>
            지우기
          </button>
        ))}
    </div>
  );
}

export function TextField(props: { id: string; label: string; required?: boolean; value: string; placeholder: string; onInput(v: string): void; title?: string }) {
  return (
    <div class="cp-field-row">
      <label for={props.id} title={props.title}>
        {props.label}
        {props.required && <span style={{ color: 'var(--err)' }}> *</span>}
      </label>
      <input id={props.id} class="inp mono" placeholder={props.placeholder} value={props.value} spellcheck={false} onInput={(e) => props.onInput((e.target as HTMLInputElement).value)} />
    </div>
  );
}

/** 모델: 기본 모델 고르기(직접 입력 가능) + 그 AI가 알려 준 목록 (줄을 누르면 기본 모델로) */
export function ModelSection(props: {
  provider: AiProvider;
  list: ClaudeModelList | null;
  loading: boolean;
  onRefresh(): void;
  model: string;
  custom: boolean;
  setModel(v: string): void;
  setCustom(on: boolean): void;
  defaultLabel: string;
  note: ComponentChildren;
  /** 목록 대신 보일 글 (Azure OpenAI: 배포 이름이 곧 모델) */
  fixed?: string;
  refreshTitle?: string;
}) {
  const { list, model } = props;
  const own = listDefault(list);
  // 연결 설정에 기본 모델이 없으면 그 AI의 기본값(목록 안의 기본 모델)에 '기본'
  const defVal = model || own?.value || '';
  const id = `cp-${props.provider}-model`;
  return (
    <section class="cp-sec" aria-label="모델">
      <div class="cp-sec-h">
        <h4>모델</h4>
        {!props.fixed && (
          <button type="button" class="btn cp-b28" onClick={props.onRefresh} disabled={props.loading} style={{ fontSize: '12.5px' }} title={props.refreshTitle}>
            {props.loading ? <Spinner size={13} /> : <Icon name="refresh" size={14} color="var(--ink2)" />}
            목록 새로고침
          </button>
        )}
      </div>
      {props.fixed ? (
        <div class="cp-field-row">
          <span class="k">기본 모델</span>
          <span class="ai-fixed">{props.fixed}</span>
        </div>
      ) : (
        <>
          <div class="cp-field-row">
            <label for={id}>기본 모델</label>
            <select
              id={id}
              class="inp"
              value={props.custom ? '__custom__' : model}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === '__custom__') props.setCustom(true);
                else {
                  props.setCustom(false);
                  props.setModel(v);
                }
              }}
            >
              {modelOptions(list, model, props.defaultLabel).map((o) => (
                <option key={o.value} value={o.value} title={o.title}>
                  {o.label}
                </option>
              ))}
              <option value="__custom__">직접 입력…</option>
            </select>
          </div>
          {props.custom && (
            <div class="cp-field-row">
              <label for={`${id}-custom`}>모델 이름</label>
              <input id={`${id}-custom`} class="inp mono" placeholder="예: 회사에서 쓰는 모델 ID" value={model} spellcheck={false} onInput={(e) => props.setModel((e.target as HTMLInputElement).value)} />
            </div>
          )}
        </>
      )}
      {!!list?.models.length && !props.fixed && (
        <ul class="ai-mlist" aria-label={`${AI_LABEL[props.provider]} 모델 목록`}>
          {list.models.map((m) => {
            const def = !props.custom && m.value === defVal;
            return (
              <li key={m.value}>
                <button
                  type="button"
                  class={`ai-mrow${def ? ' def' : ''}`}
                  aria-pressed={def}
                  title={`${m.value} · 누르면 기본 모델로`}
                  onClick={() => {
                    props.setCustom(false);
                    // 그 AI의 기본 모델은 '기본값'으로 둔다 (AI 쪽 기본이 바뀌면 따라감)
                    props.setModel(own && m.value === own.value ? '' : m.value);
                  }}
                >
                  <span class="t">
                    <b>{m.name}</b>
                    {m.description && <span>{m.description}</span>}
                  </span>
                  {def && <span class="tag acc">기본</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Note icon="info" flush>
        {props.note}
        {list?.error ? ` · ${list.error}` : ''}
      </Note>
    </section>
  );
}

/** 요금·데이터 (또는 보내는 정보) 상자: 항목 · 내용 */
export function FeeBox(props: { title: string; rows: { k: string; v: ComponentChildren; warn?: boolean }[] }) {
  return (
    <section class="ai-fee" aria-label={props.title}>
      <h4>{props.title}</h4>
      <dl>
        {props.rows.map((r) => (
          <div key={r.k} class={r.warn ? 'warn' : undefined}>
            <dt>{r.k}</dt>
            <dd>{r.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 경고 상자 (무료 키 등) */
export function WarnBox(props: { children: ComponentChildren }) {
  return (
    <div class="ai-warn" role="note">
      <Icon name="warn" size={14} color="var(--warn)" />
      <span>{props.children}</span>
    </div>
  );
}

/** 저장할 때 견줄 값: 키 순서·빈 값 차이 무시 */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
