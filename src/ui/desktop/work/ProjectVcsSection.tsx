// POP-04 왼쪽: 형상관리(자동 감지) · 연결 확인(MSG-35) · 적용 기본값(MSG-08의 기본값)
// 로그인은 PC에 저장된 Git·SVN 로그인을 그대로 쓰고, 앱은 계정·토큰을 읽거나 저장하지 않는다.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { VcsCheck, VcsInfo } from '../../../shared/desktop-api';
import { fmtBytes } from '../../format';
import { Icon, Spinner } from '../../icons';
import { errText } from '../bridge';
import { useDesk } from '../ctx';
import type { ProjectSectionProps } from '../ProjectDialog';
import './work.css';

/** 여유 공간: 10GB 넘으면 정수 GB (화면설계서 '여유 12GB') */
function freeText(b: number): string {
  const gb = b / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)}GB` : fmtBytes(b);
}

function displayUrl(u: string): string {
  return u.replace(/^(https?|git|ssh|svn|svn\+ssh):\/\//i, '');
}

function OkLine(props: { tone?: 'ok' | 'err' | 'warn' | 'mu'; children: ComponentChildren }) {
  const tone = props.tone ?? 'ok';
  return (
    <span class={`wv-okline${tone === 'ok' ? '' : ` ${tone}`}`}>
      {tone !== 'mu' && (
        <span class="c">
          <Icon name={tone === 'ok' ? 'check' : 'warn'} size={11} color={tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--err)'} sw={2.6} />
        </span>
      )}
      <span>{props.children}</span>
    </span>
  );
}

export function ProjectVcsSection(props: ProjectSectionProps) {
  const app = useDesk();
  const [info, setInfo] = useState<VcsInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [check, setCheck] = useState<VcsCheck | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const d = props.draft.applyDefaults;

  useEffect(() => {
    let live = true;
    app.desk.invoke('vcs.detect', props.root).then(
      (v) => live && setInfo(v),
      (e) => live && setInfoErr(errText(e)),
    );
    // 미리보기(?mock)에서는 연결 확인 결과도 보여 준다 (실제 앱은 [연결 확인]을 눌러야 원격에 접속)
    if (app.desk.mock) runCheck();
    return () => {
      live = false;
    };
  }, [props.root]);

  const runCheck = async () => {
    setChecking(true);
    setCheckErr(null);
    try {
      setCheck(await app.desk.invoke('vcs.check', props.root));
    } catch (e) {
      setCheckErr(errText(e));
    } finally {
      setChecking(false);
    }
  };

  const kind = info?.kind;
  const label = kind === 'git' ? 'Git' : kind === 'svn' ? 'SVN' : '없음';
  const usable = !!info && info.kind !== 'none' && info.toolFound && !info.error;
  const setDefaults = (commit: boolean, push: boolean) => props.patch({ applyDefaults: { commit, push: commit && push } });

  return (
    <>
      <section class="pc-sec" aria-label="형상관리">
        <h3>
          형상관리
          <span class="right muted" style={{ fontSize: '12px', fontWeight: 400 }}>도구는 연동 모듈로 추가</span>
        </h3>
        {!info ? (
          infoErr ? <div class="err-text">{infoErr}</div> : <div class="wv-loading" style={{ padding: '4px 0' }}><Spinner size={13} /> 형상관리 확인 중</div>
        ) : (
          <div class="wv-vcs">
            <div class={`wv-detect${kind === 'none' ? ' none' : !usable ? ' warn' : ''}`}>
              <Icon name={kind === 'none' ? 'folder' : 'git'} size={16} color={kind === 'none' ? 'var(--icon)' : 'var(--acc-d)'} />
              <span class="nm">{label}</span>
              {kind !== 'none' && <span class={`tag ${usable ? 'ok' : 'warn'}`}>{usable ? '자동 감지' : info.toolFound ? '확인 필요' : '명령 없음'}</span>}
              <span class="d" title={info.repoRoot}>
                {kind === 'none' ? '.git·.svn 폴더가 없습니다 · 적용만 합니다' : `${info.hostLabel ? `${info.hostLabel} · ` : ''}${kind === 'git' ? '.git' : '.svn'} 폴더`}
              </span>
              <span class="r">{kind === 'svn' ? 'Git은 .git으로 감지' : 'SVN은 .svn으로 감지'}</span>
            </div>
            {kind !== 'none' && (
              <>
                {!usable && <div class="err-text" style={{ color: 'var(--warn)', lineHeight: 1.5 }}>{info.error ?? `${label} 명령을 찾지 못했습니다`} 적용은 그대로 할 수 있습니다.</div>}
                <div class="wv-field">
                  <span class="k">원격 저장소</span>
                  <span class="wv-tin" title={info.remote}>
                    <span class="v">{info.remote ? displayUrl(info.remote) : '없음'}</span>
                  </span>
                </div>
                <div class="wv-field">
                  <span class="k">{kind === 'svn' ? '현재 위치' : '현재 브랜치'}</span>
                  <span class="wv-tin">
                    <span class="v">{info.branch ?? '—'}</span>
                    {info.head && <span class="r">{info.head}</span>}
                  </span>
                </div>
                <div class="wv-field">
                  <span class="k">로그인</span>
                  <span class="wv-tin sans">
                    <Icon name="lock" size={14} color="var(--icon)" />
                    <span class="v">PC에 저장된 {label} 로그인 사용 · 앱은 계정을 저장하지 않음</span>
                  </span>
                </div>
                {!!info.dirty && (
                  <span class="wv-hint">
                    <Icon name="info" size={13} color="var(--muted)" />
                    원본 폴더에 커밋 안 된 변경 {info.dirty}개 · 커밋할 때 섞지 않음
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </section>

      <section class="pc-sec" aria-label="연결 확인">
        <h3>
          연결 확인
          <span class="right">
            <button type="button" class="btn sm" onClick={runCheck} disabled={checking}>
              {checking ? <Spinner size={13} /> : <Icon name="refresh" size={14} color="var(--ink2)" />}
              연결 확인
            </button>
          </span>
        </h3>
        <div class="wv-check" aria-live="polite">
          {checkErr ? (
            <OkLine tone="err">{checkErr}</OkLine>
          ) : !check ? (
            <OkLine tone="mu">{checking ? '원격 저장소와 작업 공간을 확인하는 중 (최대 20초)' : '원격 저장소 연결과 작업 사본을 만들 공간을 확인합니다'}</OkLine>
          ) : (
            <>
              {check.remote ? (
                check.remote.ok ? (
                  <OkLine>원격 저장소 연결됨{check.login ? ` · ${check.login}` : ''}</OkLine>
                ) : (
                  <OkLine tone={/설정되어 있지 않습니다/.test(check.remote.message) ? 'warn' : 'err'}>{check.remote.message}</OkLine>
                )
              ) : (
                <OkLine tone="mu">형상관리가 없어 원격 저장소는 확인하지 않습니다</OkLine>
              )}
              <span title={check.space.path}>
                {check.space.ok ? (
                  <OkLine>작업 사본 위치 사용 가능{check.space.freeBytes ? ` · 여유 ${freeText(check.space.freeBytes)}` : ''}</OkLine>
                ) : (
                  <OkLine tone="warn">작업 사본 위치의 여유 공간이 적습니다 · 여유 {freeText(check.space.freeBytes)}</OkLine>
                )}
              </span>
            </>
          )}
        </div>
      </section>

      <div class="wv-sep" />

      <section class="pc-sec" aria-label="적용 기본값">
        <h3>적용 기본값</h3>
        <label class="ck">
          <input type="checkbox" checked={d.commit} disabled={kind === 'none'} onChange={(e) => setDefaults((e.target as HTMLInputElement).checked, d.push)} />
          <span>
            적용 후 커밋
            <span class="help">Git은 현재 브랜치에 커밋 · SVN은 서버에 바로 커밋됨</span>
          </span>
        </label>
        <label class="ck" style={!d.commit || kind === 'svn' || kind === 'none' ? { opacity: 0.6 } : undefined}>
          <input type="checkbox" checked={d.commit && d.push} disabled={!d.commit || kind === 'svn' || kind === 'none'} onChange={(e) => setDefaults(d.commit, (e.target as HTMLInputElement).checked)} />
          <span>
            커밋 후 푸시
            <span class="help">Git만 · 원격 저장소로 올림</span>
          </span>
        </label>
        <span class="wv-hint">
          <Icon name="info" size={13} color="var(--muted)" />
          {kind === 'none' ? '형상관리가 없어 커밋하지 않습니다 · 적용 전 파일은 작업 이력에 보관' : '변경 적용 확인 창(MSG-08)의 기본값 · 적용할 때마다 바꿀 수 있음'}
        </span>
      </section>
    </>
  );
}
