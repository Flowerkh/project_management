// SCR-02 불러오기 확인: 파일 요약, 폴더 미리보기(해제하면 분석에서 뺌), 감지된 주요 파일
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { LoadedFolder } from '../../platform/types';
import { Tag } from '../components/common';
import { fmtBytes, fmtNum } from '../format';
import { Icon, Spinner } from '../icons';
import type { KeyFile, RunOpts } from '../preview';
import { keyFiles, previewRows, subProjectCount, summarize } from '../preview';

export function Confirm(props: {
  folder: LoadedFolder;
  baseOpts: RunOpts;
  projectName: string;
  setProjectName: (s: string) => void;
  unchecked: Set<string>;
  setUnchecked: (s: Set<string>) => void;
  onStart: () => void;
  onOther: () => void;
  error?: string | null;
}) {
  const { folder, baseOpts, unchecked } = props;
  const opts: RunOpts = useMemo(() => ({ ...baseOpts, exclude: [...baseOpts.exclude, ...unchecked] }), [baseOpts, unchecked]);
  const sum = useMemo(() => summarize(folder, opts), [folder, opts]);
  const rows = useMemo(() => previewRows(folder, baseOpts), [folder, baseOpts]);
  const subs = useMemo(() => subProjectCount(folder), [folder]);
  const [keys, setKeys] = useState<KeyFile[] | null>(null);
  useEffect(() => {
    let alive = true;
    setKeys(null);
    keyFiles(folder).then((k) => alive && setKeys(k), () => alive && setKeys([]));
    return () => {
      alive = false;
    };
  }, [folder]);

  const toggle = (pattern: string) => {
    const n = new Set(unchecked);
    if (n.has(pattern)) n.delete(pattern);
    else n.add(pattern);
    props.setUnchecked(n);
  };
  const langLine = sum.langs.slice(0, 3).map(([l, n]) => `${l === 'JavaScript' ? 'JS' : l} ${fmtNum(n)}`).join(' · ') + (sum.langs.length > 3 ? ' 외' : '');
  const reasonLine = sum.reasons.slice(0, 1).map(([r, n]) => `${r} ${fmtNum(n)}`).join('') + (sum.reasons.length > 1 ? ` 외 ${sum.reasons.length - 1}개 규칙` : '');
  const tooMany = sum.analyzable > 20000;

  return (
    <div class="page">
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">불러오기 확인</h1>
          <div class="page-sub">분석을 시작하기 전에 대상 파일을 확인하세요</div>
        </div>
        <label class="row" style={{ gap: '8px', fontSize: '13px', fontWeight: 600 }}>
          프로젝트 이름
          <input class="inp mono" style={{ width: '220px' }} value={props.projectName} onInput={(e) => props.setProjectName((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      {tooMany && (
        <div class="banner warn" role="status">
          <Icon name="warn" size={15} />
          분석할 파일이 20,000개를 넘어 시간이 오래 걸릴 수 있습니다. 제외할 폴더가 있는지 확인해 주세요.
        </div>
      )}
      {props.error && (
        <div class="banner err" role="alert">
          <Icon name="warn" size={15} />
          {props.error}
        </div>
      )}
      <div class="grid5" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div class="stat">
          <span class="lbl">전체 파일</span>
          <span class="num">{fmtNum(sum.total)}개</span>
          <span class="sub">불러온 폴더 전체{folder.skipped ? ` · 읽지 못함 ${folder.skipped}` : ''}</span>
        </div>
        <div class="stat sel">
          <span class="lbl">분석 대상</span>
          <span class="num">{fmtNum(sum.analyzable)}개</span>
          <span class="sub">{langLine || '—'}</span>
        </div>
        <div class="stat">
          <span class="lbl">제외</span>
          <span class="num">{fmtNum(sum.excluded)}개</span>
          <span class="sub">{reasonLine || '—'}</span>
        </div>
        <div class="stat">
          <span class="lbl">분석 대상 용량</span>
          <span class="num">{fmtBytes(sum.analyzableBytes)}</span>
          <span class="sub">전체 {fmtBytes(sum.totalBytes)} 중</span>
        </div>
      </div>
      <div class="grid2">
        <section class="card">
          <div class="card-title">
            <h3>폴더 미리보기</h3>
            <span class="sub" style={{ marginLeft: 'auto' }}>체크를 해제하면 분석에서 빠집니다</span>
          </div>
          <div class="folder-list">
            <div class="folder-row root">
              <Icon name="folder" size={15} color="var(--icon)" />
              <span class="p">{folder.name}/</span>
              <span class="n">
                {fmtNum(sum.analyzable)} / {fmtNum(sum.total)}개
              </span>
            </div>
            {rows.map((r) => {
              const off = r.defaultExcluded || (!r.filesGroup && unchecked.has(r.pattern));
              return (
                <label class="folder-row" key={r.label} style={{ paddingLeft: '24px', cursor: r.defaultExcluded || r.filesGroup ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={!off} disabled={r.defaultExcluded || r.filesGroup} onChange={() => !r.filesGroup && toggle(r.pattern)} />
                  <Icon name={r.filesGroup ? 'file' : 'folder'} size={15} color="var(--icon)" />
                  <span class={`p ellipsis${off ? ' off' : ''}`} title={r.label}>{r.label}</span>
                  {r.defaultExcluded && <Tag>제외 규칙</Tag>}
                  <span class="n">{fmtNum(r.defaultExcluded ? r.total : r.analyzable)}개</span>
                </label>
              );
            })}
          </div>
          <div class="muted" style={{ fontSize: '12px', marginTop: '8px' }}>
            회색·취소선은 제외 규칙에 걸린 폴더입니다. 규칙은 설정에서 더할 수 있습니다.
          </div>
        </section>
        <section class="card">
          <div class="card-title">
            <h3>감지된 주요 파일</h3>
            <span class="sub" style={{ marginLeft: 'auto' }}>
              {subs > 1 ? `하위 프로젝트 ${subs}개 · ` : ''}
              파일 {keys ? keys.length : '…'}개
            </span>
          </div>
          {!keys && (
            <div class="row muted" style={{ fontSize: '13px', padding: '8px 2px' }}>
              <Spinner /> 빌드·설정 파일을 찾는 중
            </div>
          )}
          {keys && keys.length === 0 && <div class="muted" style={{ fontSize: '13px', padding: '6px 2px' }}>빌드·설정 파일을 찾지 못했습니다. 유형·DB 판별은 Run 이후 소스로 합니다.</div>}
          {keys?.map((k) => (
            <div class="keyfile" key={k.path}>
              <Icon name="file" size={15} color="var(--icon)" />
              <div class="grow">
                <div class="a ellipsis" title={k.path}>{k.path}</div>
                <div class="b">{k.desc}</div>
              </div>
            </div>
          ))}
          <div class="row muted" style={{ fontSize: '12px', marginTop: '10px' }}>
            <Icon name="info" size={14} />
            유형·DB 판별은 Run 이후 확정됩니다
          </div>
        </section>
      </div>
      <div class="footer-bar">
        <button type="button" class="btn lg" onClick={props.onOther}>
          다른 폴더 선택
        </button>
        <button type="button" class="btn primary lg" onClick={props.onStart} disabled={sum.analyzable === 0}>
          <Icon name="play" size={14} filled color="#FFFFFF" />
          분석 시작 (Run)
        </button>
      </div>
      {sum.analyzable === 0 && <div class="banner warn">분석할 소스 파일이 없습니다. 다른 폴더를 선택해 주세요.</div>}
    </div>
  );
}
