// SCR-01 메인(초기): 폴더 끌어다 놓기·선택, ZIP, 결과 파일 열기, 최근 프로젝트
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { fmtNum, fmtShortDate } from '../format';
import { Icon } from '../icons';
import type { RecentItem } from '../recent';

const SUPPORTED = [
  'Java · JSP · Spring (전자정부) · MyBatis',
  'PHP · Laravel · CodeIgniter',
  'Go · Gin · Echo',
  'Python · Django · Flask · FastAPI',
  'Android · React Native · Flutter',
  '셸 · 배치 · PowerShell 스크립트',
  'Oracle · MySQL · MariaDB',
];

export function Home(props: {
  recent: RecentItem[];
  error?: string | null;
  loading?: string | null;
  onPickFolder: () => void;
  onPickZip: () => void;
  onDrop: (dt: DataTransfer) => void;
  onOpenResult: () => void;
  onOpenRecent: (key: string) => void;
  onRemoveRecent: (key: string) => void;
  /** 데스크톱 앱: 오른쪽 카드 자리에 '새 프로젝트 시작' (없으면 이 프로토타입 안내) */
  side?: ComponentChildren;
}) {
  const [over, setOver] = useState(false);
  return (
    <div class="home">
      <div
        class={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer) props.onDrop(e.dataTransfer);
        }}
      >
        <span class="big-ic">
          <Icon name="upload" size={28} color="var(--acc)" sw={2} />
        </span>
        <h2>분석할 프로젝트 폴더를 끌어다 놓으세요</h2>
        <p>폴더를 통째로 불러와 [Run]을 누르면 DB 테이블·메뉴·화면·배치의 관계를 정리합니다.</p>
        <div class="acts">
          <button type="button" class="btn primary lg" onClick={props.onPickFolder} disabled={!!props.loading}>
            <Icon name="folder_plus" size={17} color="#FFFFFF" />
            폴더 선택
          </button>
          <button type="button" class="btn lg" onClick={props.onPickZip} disabled={!!props.loading}>
            <Icon name="zip" size={17} />
            ZIP 열기
          </button>
          <button type="button" class="btn lg" onClick={props.onOpenResult} disabled={!!props.loading}>
            <Icon name="json" size={17} />
            결과 파일 열기
          </button>
        </div>
        <span class="notice" style={{ marginTop: '12px' }}>
          <Icon name="shield" size={15} color="var(--ok)" />
          분석은 인터넷 없이 이 PC 안에서 끝납니다. 소스는 밖으로 나가지 않습니다.
        </span>
        {props.loading && (
          <div class="banner info" style={{ marginTop: '6px' }}>
            <Icon name="spinner" size={15} class="spin" />
            {props.loading}
          </div>
        )}
        {props.error && (
          <div class="banner err" style={{ marginTop: '6px' }} role="alert">
            <Icon name="warn" size={15} />
            {props.error}
          </div>
        )}
      </div>

      <div class="home-row">
        <section class="card">
          <div class="card-title">
            <h3>최근 프로젝트</h3>
            <span class="sub" style={{ marginLeft: 'auto' }}>자동 저장된 결과</span>
          </div>
          {props.recent.length === 0 && <div class="muted" style={{ fontSize: '13px', padding: '6px 2px' }}>아직 분석한 프로젝트가 없습니다.</div>}
          {props.recent.map((r) => (
            <div class="recent-item" key={r.key} onClick={() => props.onOpenRecent(r.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && props.onOpenRecent(r.key)}>
              <Icon name="folder" size={16} color="var(--icon)" />
              <span class="nm ellipsis">{r.name}</span>
              <span class="dt">{fmtShortDate(r.analyzedAt)} · {fmtNum(r.analyzedFiles)}개</span>
              <button
                type="button"
                class="icon-btn"
                style={{ width: '24px', height: '24px' }}
                title="목록에서 지우기"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRemoveRecent(r.key);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </section>
        {props.side ?? (
        <section class="card">
          <div class="card-title">
            <h3>이 프로토타입에서 하는 일</h3>
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.75, color: 'var(--ink2)' }}>
            <li>폴더·ZIP 불러오기와 제외 규칙 적용, 하위 프로젝트(앱·서버) 감지</li>
            <li>사용 언어·DB·시스템 유형 판별</li>
            <li>DB 테이블·메뉴·화면·배치 트리와 상세 (앱 화면은 API로 서버 테이블까지)</li>
            <li>소스 보기(근거 줄·테이블 강조), 결과 파일 저장</li>
          </ul>
          <div class="muted" style={{ fontSize: '12px', marginTop: '8px' }}>Claude 연동·형상관리·DB 조회는 데스크톱 앱에서 씁니다. 내보내기(Excel)는 다음 단계에서 붙습니다.</div>
        </section>
        )}
      </div>

      <div class="sup">
        <span class="lbl">1차 지원 기술</span>
        <div class="chips">
          {SUPPORTED.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
