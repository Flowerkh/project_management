// 규칙 기반 역할 설명: 테이블·컬럼 이름, DDL 주석, 화면 제목, CRUD를 조합한다.
import type { Confidence, Crud } from './types';

/** 국내 업무 시스템에서 흔한 약어·영단어 → 한글 */
export const WORDS: Record<string, string> = {
  ORDER: '주문', ORD: '주문', ODR: '주문', ITEM: '상품', ITM: '항목', GOODS: '상품', GDS: '상품', PRODUCT: '상품', PRD: '상품', PROD: '상품',
  USER: '사용자', USR: '사용자', MEMBER: '회원', MBR: '회원', MBER: '회원', MEM: '회원', CUST: '고객', CUSTOMER: '고객', CLIENT: '고객',
  EMP: '사원', EMPL: '사원', EMPLYR: '사용자', DEPT: '부서', ORGNZT: '조직', ORG: '조직', TEAM: '팀', POSITION: '직위',
  CODE: '코드', CD: '코드', CMMN: '공통', COMMON: '공통', CMN: '공통', COM: '공통', DETAIL: '상세', DTL: '상세', DETAILCODE: '상세 코드',
  HIST: '이력', HISTORY: '이력', HST: '이력', LOG: '로그', LOGS: '로그', FILE: '파일', FILES: '파일', ATCH: '첨부', ATTACH: '첨부', ATTACHMENT: '첨부',
  BOARD: '게시판', BBS: '게시판', NOTICE: '공지', NTCE: '공지', POST: '게시글', ARTICLE: '게시글', NTT: '게시물', CMT: '댓글', REPLY: '답글', ANSWER: '답변',
  MENU: '메뉴', AUTH: '권한', AUTHOR: '권한', ROLE: '역할', ROLES: '역할', GROUP: '그룹', GRP: '그룹', PERMISSION: '권한', PERM: '권한',
  PAY: '결제', PAYMENT: '결제', PYMNT: '결제', SETTLE: '정산', STL: '정산', SETL: '정산', CALC: '정산', DLVY: '배송', DELIVERY: '배송', DLV: '배송', SHIP: '배송', SHIPPING: '배송',
  CART: '장바구니', BASKET: '장바구니', STOCK: '재고', STK: '재고', INVENTORY: '재고', INVEN: '재고', WAREHOUSE: '창고', WH: '창고',
  COUPON: '쿠폰', CPN: '쿠폰', POINT: '포인트', PNT: '포인트', MILEAGE: '마일리지', CLAIM: '클레임', RETURN: '반품', RTN: '반품', RTRN: '반품',
  EXCHANGE: '교환', EXCH: '교환', REFUND: '환불', RFND: '환불', CANCEL: '취소', CNCL: '취소', SELLER: '판매자', SLR: '판매자', VENDOR: '업체', VNDR: '업체', PARTNER: '협력사',
  CATEGORY: '카테고리', CTGRY: '카테고리', CATE: '카테고리', CAT: '카테고리', BANNER: '배너', EVENT: '이벤트', EVT: '이벤트', PROMOTION: '프로모션', PROMO: '프로모션',
  REVIEW: '리뷰', RVW: '리뷰', QNA: '문의', INQUIRY: '문의', INQ: '문의', INQRY: '문의', FAQ: 'FAQ', CS: '고객상담',
  SALES: '매출', SALE: '판매', SLS: '매출', STAT: '통계', STATS: '통계', STTS: '통계', STATISTICS: '통계', DAILY: '일별', DAY: '일별', MONTHLY: '월별', MONTH: '월별', MON: '월별', WEEKLY: '주별', YEAR: '연도', YEARLY: '연별',
  CONFIG: '설정', CONF: '설정', SETTING: '설정', SETTINGS: '설정', ENV: '환경', SYS: '시스템', SYSTEM: '시스템', PROP: '속성', PROPERTY: '속성',
  LOGIN: '로그인', LGN: '로그인', ACCESS: '접속', CONN: '접속', SESSION: '세션', TOKEN: '토큰', PWD: '비밀번호', PASSWORD: '비밀번호',
  ADDR: '주소', ADDRESS: '주소', ZIP: '우편번호', DORMANT: '휴면', DRMNCY: '휴면', WITHDRAW: '탈퇴', SECSN: '탈퇴', MAIL: '메일', EMAIL: '이메일', SMS: '문자', MSG: '메시지', MESSAGE: '메시지',
  PUSH: '푸시', ALARM: '알림', NOTI: '알림', NOTIFICATION: '알림', SCHDUL: '일정', SCHEDULE: '일정', CALENDAR: '일정', APPROVAL: '결재', SANCTN: '결재', APRV: '결재', ELCTSN: '전자결재',
  TEMP: '임시', TMP: '임시', BAK: '백업', BACKUP: '백업', MAP: '매핑', MAPNG: '매핑', MAPPING: '매핑', REL: '관계', RELATION: '관계', LINK: '연계', INFO: '정보', INF: '정보',
  MST: '기본', MASTER: '기본', MSTR: '기본', SUB: '하위', SEQ: '순번', SN: '일련번호', NO: '번호', NUM: '번호', ID: 'ID', NM: '이름', NAME: '이름', TYPE: '유형', TY: '유형', SE: '구분', GB: '구분', STS: '상태', STAT_CD: '상태', STATUS: '상태',
  PROGRM: '프로그램', PROGRAM: '프로그램', PGM: '프로그램', BATCH: '배치', JOB: '작업', QUEUE: '대기열', TASK: '작업', RESULT: '결과', RSLT: '결과', REQ: '요청', REQUEST: '요청', RES: '응답',
  PRICE: '가격', PRC: '가격', AMT: '금액', AMOUNT: '금액', QTY: '수량', CNT: '건수', COUNT: '건수', DT: '일자', DATE: '일자', DTTM: '일시', TM: '시각',
  OPTION: '옵션', OPT: '옵션', IMG: '이미지', IMAGE: '이미지', CONTENT: '콘텐츠', CNTNTS: '콘텐츠', PAGE: '페이지', SITE: '사이트', SHOP: '상점', MALL: '쇼핑몰', STORE: '매장', BRAND: '브랜드',
  ACCOUNT: '계정', ACCT: '계좌', BANK: '은행', CARD: '카드', INVOICE: '청구서', BILL: '청구', TAX: '세금', CONTRACT: '계약', CNTRCT: '계약', ESTIMATE: '견적', QUOTE: '견적',
  SAMPLE: '시료', SMPL: '시료', SPECIMEN: '검체', ANALYSIS: '분석', ANLS: '분석', ANLY: '분석', EXPERIMENT: '실험', EXPR: '실험', SEQUENCING: '시퀀싱', REPORT: '보고서', RPT: '보고서', PROJECT: '과제', PRJ: '과제', PJT: '과제',
  STUDENT: '학생', COURSE: '과정', LECTURE: '강의', SCORE: '성적', PATIENT: '환자', DOCTOR: '의사', VISIT: '방문', RESERVATION: '예약', RSRV: '예약', BOOKING: '예약',
  INPUT: '입력', OUTPUT: '출력', IN: '입고', OUT: '출고', RCV: '입고', RECEIPT: '입고', RELEASE: '출고', DIST: '배분', PURCHASE: '구매', PURCHS: '구매', PO: '발주',
};

/** 테이블 접두어 (뜻 없음) */
const TABLE_PREFIX = /^(TB|TBL|T|TN|TC|TH|TM|TT|TS|M|MT|BT)_/i;

/** 전자정부 공통 테이블 접두어 */
const EGOV_PREFIX: Record<string, string> = { COMTN: '', COMTC: '', COMTH: '이력', COMTS: '통계' };

/** 단어가 붙어 있는 이름(COMTNMENUINFO) 쪼개기: 사전 단어 최장 일치 */
function splitGlued(s: string): string[] {
  const keys = Object.keys(WORDS).filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let i = 0;
  const u = s.toUpperCase();
  while (i < u.length) {
    const k = keys.find((w) => u.startsWith(w, i));
    if (k) {
      out.push(k);
      i += k.length;
    } else {
      // 사전에 없는 부분은 다음 사전 단어 전까지 묶음
      let j = i + 1;
      while (j < u.length && !keys.some((w) => w.length >= 3 && u.startsWith(w, j))) j++;
      out.push(u.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** 식별자 → 단어들 (snake, camel, 붙은 대문자) */
export function tokens(id: string): string[] {
  const s = id.replace(/[^A-Za-z0-9_]/g, '_');
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split('_')
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const u = p.toUpperCase();
    if (WORDS[u] !== undefined || u.length <= 4) out.push(u);
    else out.push(...splitGlued(u));
  }
  return out;
}

export function translate(id: string): { text: string; known: number; total: number } {
  let base = id.replace(TABLE_PREFIX, '');
  let pre = '';
  const eg = /^(COMT[NCHS])(.*)$/i.exec(base);
  if (eg) {
    pre = EGOV_PREFIX[eg[1].toUpperCase()] ?? '';
    base = eg[2];
  }
  const toks = tokens(base);
  let known = 0;
  const words: string[] = [];
  for (const t of toks) {
    const w = WORDS[t];
    if (w !== undefined) {
      known++;
      if (w && words[words.length - 1] !== w) words.push(w);
    } else if (/^\d+$/.test(t)) words.push(t);
    else words.push(t.toLowerCase());
  }
  if (pre) words.push(pre);
  return { text: words.join(' '), known, total: toks.length };
}

export function tableRole(name: string, comment?: string): { role: string; confidence: Confidence } {
  if (comment && comment.trim()) return { role: comment.trim(), confidence: '높음' };
  const t = translate(name);
  if (t.total && t.known === t.total) return { role: `${t.text} 정보`.replace(/ 정보 정보$/, ' 정보'), confidence: '보통' };
  if (t.known > 0) return { role: `${t.text} [추정]`, confidence: '낮음' };
  return { role: '용도 미상', confidence: '낮음' };
}

const CRUD_WORD: Record<Crud, string> = { C: '등록', R: '조회', U: '수정', D: '삭제' };

export function crudWords(cruds: Crud[]): string {
  return (['R', 'C', 'U', 'D'] as Crud[]).filter((c) => cruds.includes(c)).map((c) => CRUD_WORD[c]).join('·');
}

/** 테이블 역할에서 짧은 이름 (정보·[추정] 떼기) */
export function shortTableName(role: string, name: string): string {
  const r = role.replace(/\s*\[추정\]$/, '').replace(/\s*(기본\s*)?정보$/, '').trim();
  if (!r || r === '용도 미상' || r.length > 16) return name;
  return r;
}

/** 화면 역할 한 줄: 주 테이블의 동작을 묶어 설명 */
export function screenRole(
  title: string,
  kind: 'page' | 'popup' | 'api',
  tables: { name: string; short: string; crud: Crud[] }[],
): string {
  if (!tables.length) return kind === 'api' ? `${title} (사용 테이블 없음)` : `${title} 화면 (DB 사용 없음)`;
  const parts: string[] = [];
  const reads = tables.filter((t) => t.crud.includes('R')).map((t) => t.short);
  const writes: string[] = [];
  for (const t of tables) {
    const w = t.crud.filter((c) => c !== 'R');
    if (w.length) writes.push(`${t.short} ${crudWords(w)}`);
  }
  const uniq = (a: string[]) => [...new Set(a)];
  if (reads.length) parts.push(`${uniq(reads).slice(0, 3).join('·')}${reads.length > 3 ? ' 등' : ''} 조회`);
  if (writes.length) parts.push(uniq(writes).slice(0, 3).join(', ') + (writes.length > 3 ? ' 등' : ''));
  return parts.join(', ');
}

export function batchRole(title: string | undefined, tables: { short: string; crud: Crud[] }[]): string {
  const reads = tables.filter((t) => t.crud.includes('R')).map((t) => t.short);
  const writes = tables.filter((t) => t.crud.some((c) => c !== 'R')).map((t) => `${t.short} ${crudWords(t.crud.filter((c) => c !== 'R'))}`);
  const body = [reads.length ? `${[...new Set(reads)].slice(0, 3).join('·')} 조회` : '', writes.length ? [...new Set(writes)].slice(0, 3).join(', ') : '']
    .filter(Boolean)
    .join(' → ');
  if (title && body) return `${title}: ${body}`;
  return title || body || '실행 내용 미상';
}

/** 파일·URL 이름으로 화면 이름 만들기 (order_list → 주문 목록) */
export function nameFromPath(path: string): string {
  const base = path.replace(/\.[a-z.]+$/i, '').split('/').filter(Boolean);
  const last = base[base.length - 1] ?? path;
  const extra: Record<string, string> = {
    LIST: '목록', LST: '목록', VIEW: '보기', DETAIL: '상세', DTL: '상세', FORM: '등록', REGIST: '등록', REG: '등록', INSERT: '등록', WRITE: '작성', EDIT: '수정', MODIFY: '수정', UPDT: '수정', UPDATE: '수정',
    DELETE: '삭제', MAIN: '메인', INDEX: '메인', POPUP: '팝업', POP: '팝업', SEARCH: '검색', EXCEL: '엑셀', PRINT: '인쇄', LOGIN: '로그인', CREATE: '등록', SHOW: '보기', MANAGE: '관리', MNG: '관리', MGMT: '관리',
  };
  const toks = tokens(last);
  const words = toks.map((t) => extra[t] ?? WORDS[t] ?? t.toLowerCase());
  const dedup = words.filter((w, i) => w && w !== words[i - 1]);
  if (dedup.every((w) => /^[a-z0-9]+$/.test(w)) && base.length > 1) {
    const parent = tokens(base[base.length - 2]).map((t) => WORDS[t] ?? t.toLowerCase());
    return [...parent, ...dedup].join(' ');
  }
  return dedup.join(' ');
}

// ------------------------------------------------------------------ 업무 성격 추정

const DOMAINS: { name: string; words: string[] }[] = [
  { name: '쇼핑몰', words: ['주문', '상품', '결제', '배송', '장바구니', '쿠폰', '반품', '교환', '정산', '판매자', '카테고리', '리뷰'] },
  { name: '그룹웨어', words: ['결재', '전자결재', '게시판', '일정', '메일', '근태', '공지', '조직', '부서'] },
  { name: '인사·급여', words: ['사원', '급여', '인사', '근태', '부서', '직위'] },
  { name: '물류·재고', words: ['재고', '입고', '출고', '창고', '발주', '구매', '배분'] },
  { name: '연구·분석 의뢰', words: ['시료', '검체', '분석', '실험', '시퀀싱', '의뢰', '보고서', '과제'] },
  { name: '교육·학사', words: ['학생', '과정', '강의', '성적'] },
  { name: '예약·병원', words: ['환자', '의사', '예약', '방문'] },
  { name: '콘텐츠·게시판', words: ['게시판', '게시글', '게시물', '콘텐츠', '댓글', '배너', '공지'] },
];

export function guessDomain(texts: string[]): string | null {
  const joined = texts.join(' ');
  let best: { name: string; score: number } | null = null;
  for (const d of DOMAINS) {
    const score = d.words.reduce((s, w) => s + (joined.split(w).length - 1), 0);
    if (score > 2 && (!best || score > best.score)) best = { name: d.name, score };
  }
  return best?.name ?? null;
}
