// Claude에게 주는 앱 규칙(시스템 프롬프트 뒤에 붙임)과 첫 메시지의 [맥락] 묶음
import type { ChatContext } from '../../shared/desktop-api';

export interface PromptInput {
  kind: 'issue' | 'new';
  /** 원본 폴더 없이 연 대화 (ZIP·결과 파일) */
  readOnly: boolean;
  shellAllow: string[];
  /** 맥락 칩 중 시스템 요약 */
  summary?: string;
  projectName?: string;
}

const MAX_CHIP = 8000;
const MAX_CONTEXT = 40000;

function clip(s: string, n: number): string {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}\n…(이하 생략)` : t;
}

export function buildSystemAppend(p: PromptInput): string {
  const L: string[] = [];
  L.push('# 프로젝트 분석 시스템 안에서 일하는 규칙');
  L.push('- 항상 한국어로 답한다. 코드·명령·파일 이름은 그대로 쓴다.');
  if (p.kind === 'new') {
    L.push('- 지금 작업 폴더는 사용자가 새 프로젝트를 만들려고 고른 빈 폴더다. 먼저 요구사항을 짧게 정리하고, 기본 구성·테이블·소스·화면 목록으로 계획을 세운다.');
    L.push('- 계획 모드에서는 파일을 만들지 않는다. 계획이 정리되면 ExitPlanMode로 계획을 제시해 사용자의 확정([계획 확정])을 받은 뒤에 만든다.');
    L.push('- 다른 프로젝트를 참고하라는 요청은 [참고] 묶음의 분석 요약만 보고 따른다. 다른 폴더의 파일을 찾아 읽지 않는다.');
  } else if (p.readOnly) {
    L.push('- 이 대화는 원본 소스 없이 분석 결과(맥락 묶음)만 보고 하는 대화다. 파일을 만들거나 고칠 수 없고 명령도 실행할 수 없다. 원인과 수정안을 설명만 한다.');
  } else {
    L.push('- 지금 작업 폴더는 사용자 프로젝트의 복사본(작업 사본)이다. 고친 내용은 사용자가 앱의 변경 검토 화면에서 확인하고 [적용]을 눌러야 원본에 반영된다. 원본 폴더를 찾거나 읽으려 하지 않는다.');
    L.push('- 계획 모드에서는 파일을 고치지 않고 원인·수정안·영향 범위를 설명한다. 고칠 준비가 되면 ExitPlanMode로 수정 계획을 제시해 사용자 승인([수정 진행])을 받는다. 승인 뒤에는 작업 사본 안의 파일만 고친다.');
  }
  L.push('- 원인과 수정안을 말할 때는 근거 위치를 `파일 경로:줄 번호`로 붙인다 (예: `src/main/java/egov/shop/order/service/impl/OrderServiceImpl.java:88`). 경로는 작업 폴더 기준 상대 경로로 쓴다.');
  L.push('- 접속 정보 파일(globals.properties, jdbc.properties, .env 등)은 읽을 수 없고, 설정 파일 안의 비밀번호·계정·주소는 ****로 가려져 있다. 가려진 값을 추측하거나 되살리지 않는다.');
  L.push('- DB는 projdb 도구로만 다룬다. 셸이나 코드로 DB에 직접 접속하지 않는다.');
  L.push('  - SELECT 문 하나는 db_select로 조회한다. 기본은 개발 DB이고, QA·운영은 사용자가 그 환경을 말했을 때만 env(qa·prod)로 지정한다. 운영 조회는 사용자가 매번 확인하며, 개인정보 컬럼은 가려져서 온다.');
  L.push('  - INSERT·UPDATE·DELETE·MERGE·DDL·프로시저 호출 등 SELECT가 아닌 쿼리는 실행하지 않고 db_propose_change로 제안한다. 무엇을 하는지(description)와, 되돌릴 수 있으면 되돌리는 SQL(revert_sql)을 함께 준다. 실행은 사용자가 쿼리 카드에서 확인한 뒤 한다.');
  L.push('  - DB 주소·계정·비밀번호나 API 키를 사용자에게 묻지 않는다. 연결이 없으면 프로젝트 연결 화면에서 등록해 달라고 안내한다.');
  if (p.shellAllow.length && !p.readOnly) {
    L.push(`- 셸 명령은 다음으로 시작하는 것만 쓸 수 있고, 실행할 때마다 사용자가 확인한다: ${p.shellAllow.map((s) => `\`${s}\``).join(', ')}. 그 밖의 명령은 쓰지 않는다.`);
  } else {
    L.push('- 셸 명령은 쓸 수 없다. 빌드·시험이 필요하면 사용자가 실행할 명령을 알려 준다.');
  }
  L.push('- 인터넷 검색·웹 페이지 읽기는 쓰지 않는다. 질문이 있으면 선택 창 대신 답변 글로 묻는다.');
  if (p.summary?.trim()) {
    L.push('');
    L.push(`# 시스템 요약${p.projectName ? ` (${p.projectName})` : ''}`);
    L.push(clip(p.summary, MAX_CHIP));
  }
  return L.join('\n');
}

const CHIP_LABEL: Record<ChatContext['chips'][number]['kind'], string> = {
  screen: '화면',
  table: '테이블',
  menu: '메뉴',
  batch: '배치',
  file: '파일',
  flow: '호출 흐름',
  summary: '시스템 요약',
};

/** 첫 메시지: [맥락] 묶음 + 질문. 화면에는 질문만 보인다 */
export function buildFirstMessage(text: string, context?: ChatContext, references?: { name: string; text: string }[]): string {
  const chips = (context?.chips ?? []).filter((c) => c.kind !== 'summary' && (c.text || c.label));
  const refs = (references ?? []).filter((r) => r.text?.trim());
  if (!chips.length && !refs.length) return text;
  const out: string[] = [];
  let used = 0;
  if (chips.length) {
    out.push(`[맥락]${context?.title ? ` ${context.title}` : ''}`);
    for (const c of chips) {
      const body = clip(c.text || '', Math.max(500, Math.min(MAX_CHIP, MAX_CONTEXT - used)));
      used += body.length;
      out.push(`## ${CHIP_LABEL[c.kind] ?? c.kind}: ${c.label}`);
      if (body) out.push(body);
      if (used >= MAX_CONTEXT) break;
    }
  }
  if (refs.length) {
    out.push('[참고] 같은 구조로 만들 때 따를 분석 결과 요약 (읽기만 함)');
    for (const r of refs) {
      out.push(`## ${r.name}`);
      out.push(clip(r.text, MAX_CHIP));
    }
  }
  out.push('[질문]');
  out.push(text);
  return out.join('\n');
}

/** 대화 제목: 첫 질문을 짧게 (30자 이내) */
export function shortTitle(text: string): string {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';
  const t = line.replace(/\s+/g, ' ').trim();
  if (!t) return '새 대화';
  return t.length > 30 ? `${t.slice(0, 29)}…` : t;
}
