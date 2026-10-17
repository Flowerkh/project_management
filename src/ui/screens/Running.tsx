// SCR-03 분석 진행: 전체 진행률, 단계 1~6, 실시간 로그
import { useEffect, useState } from 'preact/hooks';
import { copyText, fmtClock, timeOfDay } from '../format';
import { Icon, Spinner } from '../icons';

export const STEP_NAMES = ['파일 수집', '기술 스택·DB 감지', '요소 추출', '연관관계 연결', '역할 생성', '결과 생성'];

export interface StepState {
  name: string;
  status: 'wait' | 'run' | 'done';
  detail?: string;
  startedAt?: number;
  ms?: number;
  pct?: number;
}

export interface LogLine {
  t: number;
  kind: string;
  msg: string;
  warn?: boolean;
}

export interface RunState {
  startedAt: number;
  steps: StepState[];
  log: LogLine[];
  current: number; // 1~6
}

export function newRunState(): RunState {
  const now = Date.now();
  return {
    startedAt: now,
    current: 1,
    steps: STEP_NAMES.map((name, i) => ({ name, status: i === 0 ? 'run' : 'wait', startedAt: i === 0 ? now : undefined })),
    log: [],
  };
}

export function overallPct(rs: RunState): number {
  const done = rs.steps.filter((s) => s.status === 'done').length;
  const cur = rs.steps.find((s) => s.status === 'run');
  const frac = cur?.pct ?? 0;
  return Math.min(100, Math.round(((done + frac) / rs.steps.length) * 100));
}

export function Running(props: { name: string; rs: RunState }) {
  const { rs } = props;
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const pct = overallPct(rs);
  const cur = rs.steps.find((s) => s.status === 'run');
  const curIdx = cur ? rs.steps.indexOf(cur) + 1 : rs.steps.length;
  const elapsed = now - rs.startedAt;
  const remain = pct > 3 ? Math.max(0, (elapsed / pct) * (100 - pct)) : null;
  const lines = [...rs.log].reverse().slice(0, 200);

  return (
    <div class="page">
      <div class="page-head" style={{ alignItems: 'center' }}>
        <h1 class="page-title" style={{ fontSize: '20px' }}>
          분석 중 <span class="mono" style={{ fontSize: '15px', fontWeight: 600, color: 'var(--ink2)' }}>{props.name}</span>
        </h1>
        <span class="row muted" style={{ marginLeft: 'auto', fontSize: '13px' }}>
          <Icon name="clock" size={15} />
          {fmtClock(elapsed)} 경과{remain !== null ? ` · 약 ${Math.max(1, Math.round(remain / 1000))}초 남음` : ''}
        </span>
      </div>
      <section class="card">
        <div class="row" style={{ alignItems: 'baseline', gap: '14px' }}>
          <span style={{ fontSize: '14px', fontWeight: 600 }}>전체 진행률</span>
          <span style={{ fontSize: '30px', fontWeight: 700 }}>{pct}%</span>
          <span class="muted" style={{ marginLeft: 'auto', fontSize: '13px' }}>
            {curIdx} / {rs.steps.length}단계 · {cur?.name ?? '마무리'}
          </span>
        </div>
        <div class="bar" style={{ height: '10px', marginTop: '10px' }}>
          <i style={{ width: `${pct}%`, transition: 'width .3s' }} />
        </div>
      </section>
      <section class="card">
        <div class="card-title">
          <h3>단계</h3>
          <span class="sub">기획서 6.1의 처리 흐름과 같음</span>
        </div>
        <div class="steps">
          {rs.steps.map((s, i) => (
            <div key={s.name} class={`step${s.status === 'done' ? ' done' : ''}${s.status === 'run' ? ' cur' : ''}`}>
              <span class="no">
                {s.status === 'done' ? <Icon name="check" size={13} color="var(--ok)" sw={2.4} /> : s.status === 'run' ? <Spinner size={14} /> : i + 1}
              </span>
              <div class="body">
                <div class="nm">
                  {i + 1}. {s.name}
                  {s.detail && <span class="dt">{s.detail}</span>}
                </div>
                {s.status === 'run' && s.pct !== undefined && (
                  <div class="bar" style={{ width: '60%', height: '6px' }}>
                    <i style={{ width: `${Math.round((s.pct ?? 0) * 100)}%` }} />
                  </div>
                )}
              </div>
              <span class="st">{s.status === 'done' ? (s.ms !== undefined ? `${(s.ms / 1000).toFixed(1)}초` : '완료') : s.status === 'run' ? '진행 중' : '대기'}</span>
            </div>
          ))}
        </div>
      </section>
      <section class="log">
        <div class="row">
          <b style={{ color: '#fff', fontSize: '14px' }}>실시간 로그</b>
          <span style={{ color: '#9aa5b1', fontSize: '12px' }}>최신순</span>
          <button
            type="button"
            class="btn sm"
            style={{ marginLeft: 'auto', background: 'transparent', color: '#fff', borderColor: '#5f6b7a' }}
            onClick={() => copyText(rs.log.map((l) => `${timeOfDay(l.t)} ${l.kind} ${l.msg}`).join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} color="#fff" />
            {copied ? '복사됨' : '로그 복사'}
          </button>
        </div>
        <div class="lines">
          {lines.length === 0 && <div style={{ color: '#9aa5b1' }}>준비 중…</div>}
          {lines.map((l, i) => (
            <div class="ln" key={`${l.t}-${i}`}>
              <span class="tm">{timeOfDay(l.t)}</span>
              <span class={`k${l.warn ? ' warn' : ''}`}>{l.kind}</span>
              <span class="m">{l.msg}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
