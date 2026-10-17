// 화면 개발용 예시 결과 (?mock=1). 화면설계서의 shop-admin과 같은 구성:
// 전자정부 표준프레임워크(Spring MVC) · JSP · MyBatis · Oracle, 테이블 27 · 메뉴 18 · 화면 42 · 배치 6
import type {
  AnalysisResult, BatchResult, Crud, DdlColumn, Evidence, FileInfo, FlowStep, Layer, MenuResult, ScreenResult, SqlFact, TableResult,
} from '../engine/types';

interface ScreenSpec {
  name: string;
  url: string;
  kind?: 'page' | 'popup';
  tables: [string, string][]; // [테이블, CRUD 문자열]
  menu?: string; // 메뉴 키
  role: string;
}

interface Module {
  key: string; // order
  label: string; // 주문
  pkg: string; // egov/shop/order
  screens: ScreenSpec[];
}

const MODULES: Module[] = [
  {
    key: 'common', label: '공통', pkg: 'egov/shop/cmm',
    screens: [
      { name: '대시보드', url: '/main.do', tables: [['TB_ORDER', 'R'], ['TB_USER', 'R'], ['TB_SETTLE', 'R']], role: '오늘 주문·가입·정산 현황을 한 화면에 모아 보여 줍니다.' },
      { name: '로그인', url: '/login.do', tables: [['TB_ADMIN', 'R'], ['TB_LOGIN_LOG', 'C']], role: '관리자 계정으로 로그인하고 접속 기록을 남깁니다.' },
      { name: '공통코드 선택', url: '/common/codePop.do', kind: 'popup', tables: [['TB_CODE', 'R']], role: '코드 그룹별 공통코드를 골라 부모 화면에 넘깁니다.' },
      { name: '우편번호 찾기', url: '/common/zipPop.do', kind: 'popup', tables: [], role: '우편번호를 검색해 주소를 채웁니다.' },
      { name: '파일 업로드', url: '/common/filePop.do', kind: 'popup', tables: [['TB_FILE', 'CR']], role: '첨부 파일을 올리고 파일 번호를 돌려줍니다.' },
    ],
  },
  {
    key: 'user', label: '회원', pkg: 'egov/shop/user',
    screens: [
      { name: '회원목록', url: '/user/list.do', menu: 'M0110', tables: [['TB_USER', 'R'], ['TB_USER_GRADE', 'R']], role: '회원을 이름·등급·가입일로 검색해 목록으로 보여 줍니다.' },
      { name: '회원상세', url: '/user/detail.do', tables: [['TB_USER', 'RU'], ['TB_USER_GRADE', 'R'], ['TB_ORDER', 'R']], role: '회원 1명의 정보와 최근 주문을 보여 주고 상태를 수정합니다.' },
      { name: '회원등록', url: '/user/form.do', tables: [['TB_USER', 'C'], ['TB_CODE', 'R']], role: '관리자가 회원을 직접 등록합니다.' },
      { name: '휴면회원', url: '/user/dormant.do', menu: 'M0120', tables: [['TB_USER_DORMANT', 'RD'], ['TB_USER', 'U']], role: '휴면 전환된 회원을 조회하고 복구합니다.' },
      { name: '회원 주문이력', url: '/user/orderPop.do', kind: 'popup', tables: [['TB_ORDER', 'R'], ['TB_ORDER_ITEM', 'R']], role: '회원의 주문 이력을 팝업으로 보여 줍니다.' },
      { name: '회원등급', url: '/user/grade.do', menu: 'M0130', tables: [['TB_USER_GRADE', 'CRUD']], role: '회원 등급과 할인율을 관리합니다.' },
    ],
  },
  {
    key: 'product', label: '상품', pkg: 'egov/shop/product',
    screens: [
      { name: '상품목록', url: '/product/list.do', menu: 'M0210', tables: [['TB_GOODS', 'R'], ['TB_GOODS_CTGRY', 'R'], ['TB_BRAND', 'R']], role: '상품을 분류·브랜드·판매 상태로 검색합니다.' },
      { name: '상품상세', url: '/product/detail.do', tables: [['TB_GOODS', 'R'], ['TB_GOODS_OPT', 'R'], ['TB_GOODS_IMG', 'R'], ['TB_STOCK', 'R']], role: '상품 1개의 옵션·이미지·재고를 보여 줍니다.' },
      { name: '상품등록', url: '/product/form.do', tables: [['TB_GOODS', 'C'], ['TB_GOODS_OPT', 'C'], ['TB_GOODS_IMG', 'C'], ['TB_FILE', 'C']], role: '새 상품과 옵션·이미지를 등록합니다.' },
      { name: '상품수정', url: '/product/edit.do', tables: [['TB_GOODS', 'RU'], ['TB_GOODS_OPT', 'CUD']], role: '상품 정보와 옵션을 수정합니다.' },
      { name: '카테고리', url: '/product/category.do', menu: 'M0220', tables: [['TB_GOODS_CTGRY', 'CRUD']], role: '상품 분류를 계층으로 관리합니다.' },
      { name: '재고현황', url: '/product/stock.do', menu: 'M0230', tables: [['TB_STOCK', 'RU'], ['TB_GOODS', 'R']], role: '상품별 재고를 조회하고 조정합니다.' },
      { name: '옵션관리', url: '/product/option.do', tables: [['TB_GOODS_OPT', 'CRUD']], role: '상품 옵션을 일괄 관리합니다.' },
      { name: '상품 이미지', url: '/product/imagePop.do', kind: 'popup', tables: [['TB_GOODS_IMG', 'RD'], ['TB_FILE', 'R']], role: '상품 이미지를 미리 보고 삭제합니다.' },
      { name: '브랜드', url: '/product/brand.do', menu: 'M0240', tables: [['TB_BRAND', 'CRUD']], role: '브랜드를 등록·수정합니다.' },
    ],
  },
  {
    key: 'order', label: '주문', pkg: 'egov/shop/order',
    screens: [
      { name: '주문목록', url: '/order/list.do', menu: 'M0310', tables: [['TB_ORDER', 'R'], ['TB_ORDER_ITEM', 'R'], ['TB_USER', 'R'], ['TB_CODE', 'R']], role: '주문을 기간·상태·주문자로 검색해 목록으로 보여 줍니다.' },
      { name: '주문상세', url: '/order/detail.do', menu: 'M0320', tables: [['TB_ORDER', 'RU'], ['TB_ORDER_ITEM', 'R'], ['TB_ORDER_PAY', 'R'], ['TB_ORDER_DLVY', 'RU'], ['TB_ORDER_HIST', 'C'], ['TB_USER', 'R'], ['TB_CODE', 'R']], role: '주문 1건의 주문자·상품·결제·배송 정보를 조회하고, 주문 상태와 배송 정보를 수정하는 화면입니다. 상태를 바꿀 때마다 주문 이력을 남깁니다.' },
      { name: '주문등록', url: '/order/form.do', tables: [['TB_ORDER', 'C'], ['TB_ORDER_ITEM', 'C'], ['TB_ORDER_PAY', 'C'], ['TB_GOODS', 'R']], role: '전화 주문 등을 관리자가 직접 등록합니다.' },
      { name: '반품·교환', url: '/order/claim.do', menu: 'M0330', tables: [['TB_ORDER_CLAIM', 'CRU'], ['TB_ORDER', 'RU'], ['TB_ORDER_HIST', 'C']], role: '반품·교환 요청을 조회하고 처리 상태를 바꿉니다.' },
      { name: '배송현황', url: '/order/dlvy.do', tables: [['TB_ORDER_DLVY', 'RU'], ['TB_ORDER', 'R']], role: '배송 상태와 송장 번호를 관리합니다.' },
      { name: '주문 이력', url: '/order/histPop.do', kind: 'popup', tables: [['TB_ORDER_HIST', 'R']], role: '주문 상태 변경 이력을 팝업으로 보여 줍니다.' },
      { name: '반품 등록', url: '/order/claimPop.do', kind: 'popup', tables: [['TB_ORDER_CLAIM', 'C']], role: '반품·교환 요청을 등록합니다.' },
      { name: '결제내역', url: '/order/pay.do', tables: [['TB_ORDER_PAY', 'R'], ['TB_ORDER', 'R']], role: '결제 수단별 결제 내역을 조회합니다.' },
      { name: '취소목록', url: '/order/cancel.do', tables: [['TB_ORDER', 'RU'], ['TB_ORDER_PAY', 'U'], ['TB_ORDER_HIST', 'C']], role: '취소 요청 주문을 조회하고 환불 처리합니다.' },
      { name: '송장 일괄등록', url: '/order/invoice.do', tables: [['TB_ORDER_DLVY', 'U'], ['TB_FILE', 'C']], role: '엑셀로 송장 번호를 한 번에 등록합니다.' },
      { name: '쿠폰 사용내역', url: '/order/couponUse.do', tables: [['TB_COUPON_ISSUE', 'R'], ['TB_ORDER', 'R']], role: '주문에 쓴 쿠폰을 조회합니다.' },
    ],
  },
  {
    key: 'settle', label: '정산', pkg: 'egov/shop/settle',
    screens: [
      { name: '정산현황', url: '/settle/status.do', menu: 'M0410', tables: [['TB_SETTLE', 'R'], ['TB_ORDER', 'R']], role: '일자별 정산 현황을 보여 줍니다.' },
      { name: '정산내역', url: '/settle/list.do', menu: 'M0420', tables: [['TB_SETTLE', 'RU'], ['TB_SETTLE_ITEM', 'R'], ['TB_ORDER', 'R']], role: '판매자별 정산 내역을 조회하고 지급 상태를 바꿉니다.' },
      { name: '판매자 정산', url: '/settle/seller.do', tables: [['TB_SETTLE_ITEM', 'R'], ['TB_ADMIN', 'R']], role: '판매자 한 명의 정산 상세를 보여 줍니다.' },
      { name: '매출 통계', url: '/settle/sales.do', tables: [['TB_SALES_MONTHLY', 'R']], role: '월별 매출 추이를 보여 줍니다.' },
      { name: '정산 엑셀', url: '/settle/excel.do', tables: [['TB_SETTLE', 'R'], ['TB_SETTLE_ITEM', 'R']], role: '정산 내역을 엑셀로 내려받습니다.' },
    ],
  },
  {
    key: 'system', label: '시스템', pkg: 'egov/shop/sys',
    screens: [
      { name: '메뉴관리', url: '/system/menu.do', menu: 'M0510', tables: [['TB_MENU', 'CRUD'], ['TB_AUTH', 'R']], role: '관리자 메뉴와 정렬 순서를 관리합니다.' },
      { name: '권한관리', url: '/system/auth.do', tables: [['TB_AUTH', 'CRUD'], ['TB_MENU', 'R']], role: '권한 그룹과 메뉴 권한을 지정합니다.' },
      { name: '관리자목록', url: '/system/admin.do', tables: [['TB_ADMIN', 'CRUD'], ['TB_AUTH', 'R']], role: '관리자 계정을 관리합니다.' },
      { name: '공통코드관리', url: '/system/code.do', tables: [['TB_CODE', 'CRUD'], ['TB_CODE_GRP', 'CRUD']], role: '공통코드와 코드 그룹을 관리합니다.' },
      { name: '접속로그', url: '/system/log.do', tables: [['TB_LOGIN_LOG', 'R']], role: '관리자 접속 기록을 조회합니다.' },
      { name: '쿠폰관리', url: '/system/coupon.do', tables: [['TB_COUPON', 'CRUD'], ['TB_COUPON_ISSUE', 'R']], role: '쿠폰을 발급하고 사용 현황을 봅니다.' },
    ],
  },
];

const TABLES: [string, string, boolean?][] = [
  ['TB_USER', '회원'], ['TB_USER_GRADE', '회원 등급'], ['TB_USER_DORMANT', '휴면 회원'], ['TB_ADMIN', '관리자'], ['TB_AUTH', '권한'],
  ['TB_MENU', '메뉴', true], ['TB_CODE', '공통코드', true], ['TB_CODE_GRP', '코드 그룹', true], ['TB_FILE', '첨부파일', true],
  ['TB_LOGIN_LOG', '접속 로그', true], ['TB_GOODS', '상품'], ['TB_GOODS_CTGRY', '상품 분류'], ['TB_GOODS_OPT', '상품 옵션'],
  ['TB_GOODS_IMG', '상품 이미지'], ['TB_BRAND', '브랜드'], ['TB_STOCK', '재고'], ['TB_ORDER', '주문'], ['TB_ORDER_ITEM', '주문 상품'],
  ['TB_ORDER_PAY', '결제'], ['TB_ORDER_DLVY', '배송'], ['TB_ORDER_HIST', '주문 이력'], ['TB_ORDER_CLAIM', '반품·교환'],
  ['TB_SETTLE', '정산'], ['TB_SETTLE_ITEM', '정산 상세'], ['TB_SALES_MONTHLY', '월 매출'], ['TB_COUPON', '쿠폰'], ['TB_COUPON_ISSUE', '쿠폰 발급'],
];

const ORDER_COLUMNS: DdlColumn[] = [
  { name: 'ORDER_NO', type: 'VARCHAR2(20)', pk: true, nullable: false, comment: '주문번호' },
  { name: 'USER_ID', type: 'VARCHAR2(20)', nullable: false, comment: '회원 ID (TB_USER)' },
  { name: 'ORDER_STAT', type: 'CHAR(2)', nullable: false, comment: '주문 상태(ORD_STAT)' },
  { name: 'TOTAL_AMT', type: 'NUMBER(12)', comment: '총 주문 금액' },
  { name: 'PAY_AMT', type: 'NUMBER(12)', comment: '결제 금액' },
  { name: 'DLVY_FEE', type: 'NUMBER(8)', comment: '배송비' },
  { name: 'ORDER_DT', type: 'DATE', nullable: false, comment: '주문일시' },
  { name: 'REG_ID', type: 'VARCHAR2(20)', comment: '등록자' },
  { name: 'UPD_DT', type: 'DATE', comment: '수정일시' },
];

function genericColumns(table: string, comment: string): DdlColumn[] {
  const base = table.replace(/^TB_/, '');
  return [
    { name: `${base.split('_')[0]}_NO`, type: 'VARCHAR2(20)', pk: true, nullable: false, comment: `${comment} 번호` },
    { name: `${base.split('_').pop()}_NM`, type: 'VARCHAR2(100)', comment: `${comment} 이름` },
    { name: 'USE_YN', type: 'CHAR(1)', comment: '사용 여부' },
    { name: 'REG_ID', type: 'VARCHAR2(20)', comment: '등록자' },
    { name: 'REG_DT', type: 'DATE', comment: '등록일시' },
    { name: 'UPD_DT', type: 'DATE', comment: '수정일시' },
  ];
}

const pad = (n: number, w = 4) => String(n).padStart(w, '0');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface MockBundle {
  result: AnalysisResult;
  texts: Map<string, string>; // 파일 ID → 내용
}

export function makeMock(): MockBundle {
  const files: FileInfo[] = [];
  const texts = new Map<string, string>();
  const sql: SqlFact[] = [];
  let fseq = 0;
  let qseq = 0;
  const addFile = (path: string, layer: Layer, lang: FileInfo['lang'], text: string, encoding: FileInfo['encoding'] = 'utf-8'): FileInfo => {
    const f: FileInfo = {
      id: `F${pad(++fseq)}`, path, name: path.slice(path.lastIndexOf('/') + 1), lang, layer,
      lines: text.split('\n').length, size: new TextEncoder().encode(text).length, encoding,
    };
    files.push(f);
    texts.set(f.id, text);
    return f;
  };
  const lineOf = (text: string, needle: string) => {
    const i = text.indexOf(needle);
    return i < 0 ? 1 : text.slice(0, i).split('\n').length;
  };

  // ---- DDL
  const ddlFiles = new Map<string, FileInfo>();
  const ddlByModule: Record<string, string[]> = {
    user: ['TB_USER', 'TB_USER_GRADE', 'TB_USER_DORMANT'],
    common: ['TB_ADMIN', 'TB_AUTH', 'TB_MENU', 'TB_CODE', 'TB_CODE_GRP', 'TB_FILE', 'TB_LOGIN_LOG', 'TB_COUPON', 'TB_COUPON_ISSUE'],
    product: ['TB_GOODS', 'TB_GOODS_CTGRY', 'TB_GOODS_OPT', 'TB_GOODS_IMG', 'TB_BRAND', 'TB_STOCK'],
    order: ['TB_ORDER', 'TB_ORDER_ITEM', 'TB_ORDER_PAY', 'TB_ORDER_DLVY', 'TB_ORDER_HIST', 'TB_ORDER_CLAIM'],
    settle: ['TB_SETTLE', 'TB_SETTLE_ITEM', 'TB_SALES_MONTHLY'],
  };
  const columnsOf = new Map<string, DdlColumn[]>();
  const ddlLine = new Map<string, Evidence>();
  for (const [mod, names] of Object.entries(ddlByModule)) {
    let text = `-- ${mod} 스키마 (Oracle)\n\n`;
    for (const n of names) {
      const comment = TABLES.find((t) => t[0] === n)?.[1] ?? n;
      const cols = n === 'TB_ORDER' ? ORDER_COLUMNS : genericColumns(n, comment);
      columnsOf.set(n, cols);
      text += `CREATE TABLE ${n} (\n${cols.map((c) => `    ${c.name.padEnd(14)} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}`).join(',\n')},\n    CONSTRAINT PK_${n} PRIMARY KEY (${cols[0].name})\n);\n`;
      text += `COMMENT ON TABLE ${n} IS '${comment}';\n`;
      for (const c of cols) text += `COMMENT ON COLUMN ${n}.${c.name} IS '${c.comment}';\n`;
      text += '\n';
    }
    const f = addFile(`db/schema/${mod}.sql`, 'DDL', 'SQL', text);
    ddlFiles.set(mod, f);
    for (const n of names) ddlLine.set(n, { file: f.id, line: lineOf(text, `CREATE TABLE ${n} `) });
  }

  // ---- 메뉴 데이터
  const MENUS: [string, string | undefined, string, string | undefined, number][] = [
    ['M0100', undefined, '회원관리', undefined, 1], ['M0110', 'M0100', '회원목록', '/user/list.do', 1], ['M0120', 'M0100', '휴면회원', '/user/dormant.do', 2], ['M0130', 'M0100', '회원등급', '/user/grade.do', 3],
    ['M0200', undefined, '상품관리', undefined, 2], ['M0210', 'M0200', '상품목록', '/product/list.do', 1], ['M0220', 'M0200', '카테고리', '/product/category.do', 2], ['M0230', 'M0200', '재고현황', '/product/stock.do', 3], ['M0240', 'M0200', '브랜드', '/product/brand.do', 4],
    ['M0300', undefined, '주문관리', undefined, 3], ['M0310', 'M0300', '주문목록', '/order/list.do', 1], ['M0320', 'M0300', '주문상세', '/order/detail.do', 2], ['M0330', 'M0300', '반품·교환', '/order/claim.do', 3],
    ['M0400', undefined, '정산관리', undefined, 4], ['M0410', 'M0400', '정산현황', '/settle/status.do', 1], ['M0420', 'M0400', '정산내역', '/settle/list.do', 2],
    ['M0500', undefined, '시스템관리', undefined, 5], ['M0510', 'M0500', '메뉴관리', '/system/menu.do', 1],
  ];
  let menuText = '-- 관리자 메뉴 데이터\n';
  for (const [k, p, n, u, o] of MENUS) {
    menuText += `INSERT INTO TB_MENU (MENU_ID, UPPER_MENU_ID, MENU_NM, MENU_URL, SORT_ORDR, USE_YN) VALUES ('${k}', ${p ? `'${p}'` : 'NULL'}, '${n}', ${u ? `'${u}'` : 'NULL'}, ${o}, 'Y');\n`;
  }
  const menuFile = addFile('db/menu_data.sql', 'MENU_DATA', 'SQL', menuText);

  // ---- 모듈별 코드
  const screens: ScreenResult[] = [];
  let sseq = 0;
  const allTablesUse = new Map<string, Map<string, Set<Crud>>>(); // 테이블 → 화면/배치 ID → CRUD
  const tableFiles = new Map<string, Set<string>>();
  const noteTableFile = (t: string, fid: string) => {
    const s = tableFiles.get(t) ?? new Set();
    s.add(fid);
    tableFiles.set(t, s);
  };
  const joins = new Map<string, Set<string>>();

  for (const mod of MODULES) {
    const C = cap(mod.key);
    const ns = `${mod.key}Mapper`;
    // 매퍼 XML
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n<mapper namespace="${ns}">\n\n`;
    const stmtOf = new Map<string, { id: string; kind: SqlFact['kind']; tables: [string, Crud][] }[]>();
    mod.screens.forEach((s, i) => {
      const stmts: { id: string; kind: SqlFact['kind']; tables: [string, Crud][] }[] = [];
      const base = s.url.replace(/^.*\//, '').replace(/\.do$/, '').replace(/Pop$/, '');
      const reads = s.tables.filter(([, c]) => c.includes('R')).map(([t]) => t);
      if (reads.length) stmts.push({ id: `select${cap(base)}${i}`, kind: 'select', tables: reads.map((t) => [t, 'R'] as [string, Crud]) });
      for (const [t, c] of s.tables) {
        if (c.includes('C')) stmts.push({ id: `insert${cap(t.replace(/^TB_/, '').toLowerCase().replace(/_(\w)/g, (_, x) => x.toUpperCase()))}${i}`, kind: 'insert', tables: [[t, 'C']] });
        if (c.includes('U')) stmts.push({ id: `update${cap(t.replace(/^TB_/, '').toLowerCase().replace(/_(\w)/g, (_, x) => x.toUpperCase()))}${i}`, kind: 'update', tables: [[t, 'U']] });
        if (c.includes('D')) stmts.push({ id: `delete${cap(t.replace(/^TB_/, '').toLowerCase().replace(/_(\w)/g, (_, x) => x.toUpperCase()))}${i}`, kind: 'delete', tables: [[t, 'D']] });
      }
      stmtOf.set(s.url, stmts);
      for (const st of stmts) {
        const tag = st.kind === 'select' ? 'select' : st.kind;
        const [t0] = st.tables[0];
        let body = '';
        if (st.kind === 'select') {
          const [first, ...rest] = st.tables.map(([t]) => t);
          body = `    SELECT A.*\n      FROM ${first} A\n${rest.map((t, k) => `      LEFT JOIN ${t} J${k} ON J${k}.${t.replace(/^TB_/, '').split('_')[0]}_NO = A.${first.replace(/^TB_/, '').split('_')[0]}_NO`).join('\n')}${rest.length ? '\n' : ''}     WHERE 1 = 1\n    <if test="searchKeyword != null and searchKeyword != ''">\n       AND A.REG_ID LIKE '%' || #{searchKeyword} || '%'\n    </if>`;
          if (rest.length) {
            const set = joins.get(first) ?? new Set();
            rest.forEach((r) => set.add(r));
            joins.set(first, set);
          }
        } else if (st.kind === 'insert') body = `    INSERT INTO ${t0} (REG_ID, REG_DT)\n    VALUES (#{regId}, SYSDATE)`;
        else if (st.kind === 'update') body = `    UPDATE ${t0}\n       SET UPD_DT = SYSDATE\n     WHERE ${t0.replace(/^TB_/, '').split('_')[0]}_NO = #{${mod.key}No}`;
        else body = `    DELETE FROM ${t0}\n     WHERE ${t0.replace(/^TB_/, '').split('_')[0]}_NO = #{${mod.key}No}`;
        xml += `  <!-- ${s.name} -->\n  <${tag} id="${st.id}" parameterType="${mod.key}VO"${st.kind === 'select' ? ` resultType="${mod.key}VO"` : ''}>\n${body}\n  </${tag}>\n\n`;
      }
    });
    xml += '</mapper>\n';
    const mapper = addFile(`src/main/resources/egovframework/mapper/${mod.key}/${C}Mapper.xml`, 'MAPPER', 'XML', xml);
    for (const stmts of stmtOf.values()) for (const st of stmts) {
      const q: SqlFact = {
        id: `Q${pad(++qseq)}`, file: mapper.id, line: lineOf(xml, `id="${st.id}"`), origin: 'mybatis', namespace: ns, stmtId: st.id, kind: st.kind,
        tables: st.tables.map(([name, crud]) => ({ name, crud })), dynamic: st.kind === 'select',
        text: `${st.kind.toUpperCase()} … ${st.tables.map(([t]) => t).join(', ')}`,
      };
      sql.push(q);
      for (const [t] of st.tables) noteTableFile(t, mapper.id);
    }

    // 컨트롤러·서비스·DAO
    const ctrlText = [
      `package egovframework.${mod.pkg.replace(/\//g, '.')}.web;`, '', 'import org.springframework.stereotype.Controller;',
      'import org.springframework.web.bind.annotation.RequestMapping;', '', '@Controller', `public class ${C}Controller {`, '',
      `    @Resource(name = "${mod.key}Service")`, `    private ${C}Service ${mod.key}Service;`, '',
      ...mod.screens.flatMap((s) => {
        const m = s.url.replace(/^.*\//, '').replace(/\.do$/, '');
        return [
          `    /** ${s.name} */`, `    @RequestMapping("${s.url}")`, `    public String ${m}(@ModelAttribute("searchVO") ${C}VO vo, ModelMap model) throws Exception {`,
          `        model.addAttribute("result", ${mod.key}Service.${m}(vo));`, `        return "${mod.key}/${m}";`, '    }', '',
        ];
      }),
      '}', '',
    ].join('\n');
    const ctrl = addFile(`src/main/java/egovframework/${mod.pkg}/web/${C}Controller.java`, 'CONTROLLER', 'Java', ctrlText);
    const svc = addFile(`src/main/java/egovframework/${mod.pkg}/service/${C}Service.java`, 'SERVICE', 'Java',
      `package egovframework.${mod.pkg.replace(/\//g, '.')}.service;\n\npublic interface ${C}Service {\n${mod.screens.map((s) => `    Object ${s.url.replace(/^.*\//, '').replace(/\.do$/, '')}(${C}VO vo) throws Exception;`).join('\n')}\n}\n`);
    const implText = [
      `package egovframework.${mod.pkg.replace(/\//g, '.')}.service.impl;`, '', `@Service("${mod.key}Service")`,
      `public class ${C}ServiceImpl extends EgovAbstractServiceImpl implements ${C}Service {`, '', `    @Resource(name = "${mod.key}DAO")`, `    private ${C}DAO ${mod.key}DAO;`, '',
      ...mod.screens.flatMap((s) => {
        const m = s.url.replace(/^.*\//, '').replace(/\.do$/, '');
        const st = stmtOf.get(s.url) ?? [];
        return [`    @Override`, `    public Object ${m}(${C}VO vo) throws Exception {`, ...st.map((x) => `        ${mod.key}DAO.${x.id}(vo);`), '        return vo;', '    }', ''];
      }),
      '}', '',
    ].join('\n');
    const impl = addFile(`src/main/java/egovframework/${mod.pkg}/service/impl/${C}ServiceImpl.java`, 'SERVICE', 'Java', implText);
    const daoText = [
      `package egovframework.${mod.pkg.replace(/\//g, '.')}.service.impl;`, '', `@Repository("${mod.key}DAO")`, `public class ${C}DAO extends EgovAbstractMapper {`, '',
      ...[...stmtOf.values()].flat().flatMap((x) => [`    public Object ${x.id}(${C}VO vo) {`, `        return ${x.kind === 'select' ? 'selectList' : x.kind}("${ns}.${x.id}", vo);`, '    }', '']),
      '}', '',
    ].join('\n');
    const dao = addFile(`src/main/java/egovframework/${mod.pkg}/service/impl/${C}DAO.java`, 'DAO', 'Java', daoText);
    addFile(`src/main/java/egovframework/${mod.pkg}/service/${C}VO.java`, 'MODEL', 'Java', `package egovframework.${mod.pkg.replace(/\//g, '.')}.service;\n\npublic class ${C}VO extends ComDefaultVO {\n    private String ${mod.key}No;\n    private String regId;\n}\n`);

    // 화면
    mod.screens.forEach((s) => {
      const m = s.url.replace(/^.*\//, '').replace(/\.do$/, '');
      const jspText = [
        '<%@ page contentType="text/html; charset=utf-8" pageEncoding="utf-8"%>',
        '<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>', '<!DOCTYPE html>', '<html>', '<head>', `<title>${s.name}</title>`,
        `<script type="text/javascript" src="<c:url value='/js/${mod.key}/${m}.js'/>"></script>`, '</head>', '<body>',
        '<%@ include file="/WEB-INF/jsp/cmm/header.jsp" %>', `<h2 class="title">${s.name}</h2>`,
        `<form id="frm" name="frm" method="post" action="<c:url value='${s.url}'/>">`, '  <input type="hidden" name="pageIndex" value="1"/>', '</form>',
        '<%@ include file="/WEB-INF/jsp/cmm/footer.jsp" %>', '</body>', '</html>', '',
      ].join('\n');
      const jsp = addFile(`src/main/webapp/WEB-INF/jsp/${mod.key}/${m}.jsp`, 'VIEW', 'JSP', jspText, m === 'claim' ? 'euc-kr' : 'utf-8');
      const jsText = [`/* ${s.name} */`, `function fn_search() {`, `    document.frm.action = "${s.url}";`, '    document.frm.submit();', '}', '',
        `function fn_save() {`, '    $.ajax({', `        url: "${s.url.replace(/\.do$/, 'Save.do')}",`, '        type: "post",', '        data: $("#frm").serialize(),',
        '        success: function (res) { alert("저장했습니다."); fn_search(); }', '    });', '}', ''].join('\n');
      const js = addFile(`src/main/webapp/js/${mod.key}/${m}.js`, 'SCRIPT', 'JavaScript', jsText);
      const stmts = stmtOf.get(s.url) ?? [];
      const id = `S${pad(++sseq, 3)}`;
      const tables = s.tables.map(([t, c]) => ({ table: t, crud: (['C', 'R', 'U', 'D'] as Crud[]).filter((x) => c.includes(x)) }));
      const flow: FlowStep[] = [
        { layer: 'VIEW', file: jsp.id, symbol: `${m}.jsp`, line: lineOf(jspText, '<form') },
        { layer: 'SCRIPT', file: js.id, symbol: `${m}.js · fn_save()`, line: 6 },
        { layer: 'CONTROLLER', file: ctrl.id, symbol: `${C}Controller.${m}()`, line: lineOf(ctrlText, `"${s.url}"`) },
        { layer: 'SERVICE', file: impl.id, symbol: `${C}ServiceImpl.${m}()`, line: lineOf(implText, ` ${m}(`) },
        { layer: 'DAO', file: dao.id, symbol: `${C}DAO`, line: 5 },
        ...(stmts.length ? [{ layer: 'MAPPER' as const, file: mapper.id, symbol: stmts.map((x) => x.id).slice(0, 3).join('\n'), line: lineOf(xml, `id="${stmts[0].id}"`) }] : []),
        ...(tables.length ? [{ layer: 'TABLE' as const, symbol: tables.map((t) => `${t.table} ${t.crud.join('')}`).join('\n') }] : []),
      ];
      screens.push({
        id, kind: s.kind ?? 'page', name: s.name, url: s.url, urls: [s.url], group: mod.key === 'common' ? '/common' : `/${mod.key}`,
        menu: s.menu, view: jsp.id,
        files: [
          { file: jsp.id, layer: 'VIEW', note: '화면 마크업, 검색·저장 버튼' },
          { file: js.id, layer: 'SCRIPT', note: '검색·저장 요청' },
          { file: ctrl.id, layer: 'CONTROLLER', note: s.url },
          { file: impl.id, layer: 'SERVICE', note: `${m}()` },
          { file: dao.id, layer: 'DAO', note: `${stmts.length}개 호출` },
          ...(stmts.length ? [{ file: mapper.id, layer: 'MAPPER' as Layer, note: `${stmts[0].id}${stmts.length > 1 ? ` 외 ${stmts.length - 1}개 SQL` : ''}` }] : []),
        ],
        tables, flow,
        calls: [
          { url: s.url, kind: 'form', handler: `${C}Controller.${m}()`, tables: tables.filter((t) => t.crud.includes('R')).map((t) => ({ table: t.table, crud: ['R'] })) },
          ...(tables.some((t) => t.crud.some((c) => c !== 'R')) ? [{ url: s.url.replace(/\.do$/, 'Save.do'), kind: 'ajax' as const, handler: `${C}Controller.${m}Save()`, tables: tables.filter((t) => t.crud.some((c) => c !== 'R')).map((t) => ({ table: t.table, crud: t.crud.filter((c) => c !== 'R') })) }] : []),
        ],
        role: s.role, confidence: s.kind === 'popup' ? '보통' : '높음',
        evidence: [{ file: jsp.id, line: 6, text: `<title>${s.name}</title>` }, { file: ctrl.id, line: lineOf(ctrlText, `"${s.url}"`) }],
        notInMenu: !s.menu && !MENUS.some((mm) => mm[3] === s.url),
      });
      for (const t of tables) {
        const mp = allTablesUse.get(t.table) ?? new Map<string, Set<Crud>>();
        const set = mp.get(id) ?? new Set<Crud>();
        t.crud.forEach((c) => set.add(c));
        mp.set(id, set);
        allTablesUse.set(t.table, mp);
      }
    });
    for (const s of mod.screens) void s;
    for (const t of new Set(mod.screens.flatMap((s) => s.tables.map(([n]) => n)))) noteTableFile(t, dao.id);
  }

  // 화면의 메뉴 연결 (메뉴 URL과 같은 화면)
  for (const s of screens) if (!s.menu) {
    const m = MENUS.find((mm) => mm[3] === s.url);
    if (m) s.menu = m[0];
  }

  // ---- 배치
  const crontab = addFile('deploy/crontab', 'BATCH', 'Shell', [
    '# shop-admin 배치 (운영 서버 crontab -l 결과)', 'SHELL=/bin/bash', '0 2 * * * /app/batch/settle_daily.sh >> /app/logs/settle.log 2>&1',
    '30 4 * * * /app/batch/dormant_member.sh', '0 5 * * 0 /app/batch/clean_logs.sh', '',
  ].join('\n'));
  const env = addFile('batch/common/env.sh', 'BATCH', 'Shell', '#!/bin/bash\n# 공통 환경 변수\nexport ORACLE_SID=SHOP\nexport DB_USER=****\nexport DB_PASS=****\n');
  const settleSql = addFile('batch/sql/settle_daily.sql', 'BATCH', 'SQL', [
    '-- 일 정산: 전날 결제 완료 주문을 판매자별로 집계', 'INSERT INTO TB_SETTLE (SETTLE_NO, SETTLE_DT, SELLER_ID, SETTLE_AMT)', 'SELECT SEQ_SETTLE.NEXTVAL, TRUNC(SYSDATE - 1), O.SELLER_ID, SUM(I.ITEM_AMT)',
    '  FROM TB_ORDER O', '  JOIN TB_ORDER_ITEM I ON I.ORDER_NO = O.ORDER_NO', " WHERE O.ORDER_STAT = '30'", '   AND O.ORDER_DT >= TRUNC(SYSDATE - 1)', ' GROUP BY O.SELLER_ID;', '',
    'INSERT INTO TB_SETTLE_ITEM (SETTLE_NO, ORDER_NO, ITEM_AMT)', 'SELECT S.SETTLE_NO, I.ORDER_NO, I.ITEM_AMT', '  FROM TB_SETTLE S', '  JOIN TB_ORDER_ITEM I ON I.SELLER_ID = S.SELLER_ID', ' WHERE S.SETTLE_DT = TRUNC(SYSDATE - 1);', 'COMMIT;', '',
  ].join('\n'));
  const settleSh = addFile('batch/settle_daily.sh', 'BATCH', 'Shell', [
    '#!/bin/bash', '# 일 정산 배치', '. /app/batch/common/env.sh', 'LOG=/app/logs/settle_$(date +%Y%m%d).log', 'echo "start $(date)" >> $LOG',
    'sqlplus -s $DB_USER/$DB_PASS@$ORACLE_SID @/app/batch/sql/settle_daily.sql >> $LOG', 'echo "end $(date)" >> $LOG', '',
  ].join('\n'));
  const dormant = addFile('batch/dormant_member.sh', 'BATCH', 'Shell', '#!/bin/bash\n# 휴면 회원 전환\n. /app/batch/common/env.sh\nsqlplus -s $DB_USER/$DB_PASS@$ORACLE_SID <<EOF\nINSERT INTO TB_USER_DORMANT SELECT * FROM TB_USER WHERE LAST_LOGIN_DT < ADD_MONTHS(SYSDATE, -12);\nUPDATE TB_USER SET USER_STAT = \'90\' WHERE LAST_LOGIN_DT < ADD_MONTHS(SYSDATE, -12);\nCOMMIT;\nEOF\n');
  const monthly = addFile('batch/stats_monthly.bat', 'BATCH', 'Batch', '@echo off\nrem 월 매출 집계 (작업 스케줄러: 매월 1일 01:00)\nsqlplus -s %DB_USER%/%DB_PASS%@SHOP @sql\\stats_monthly.sql\n');
  const clean = addFile('batch/clean_logs.sh', 'BATCH', 'Shell', '#!/bin/bash\n# 로그 정리: 30일 지난 로그 삭제\nfind /app/logs -name "*.log" -mtime +30 -delete\n');
  const sync = addFile('batch/sync_stock.sh', 'BATCH', 'Shell', '#!/bin/bash\n# 재고 동기화\n. /app/batch/common/env.sh\nsqlplus -s $DB_USER/$DB_PASS@$ORACLE_SID <<EOF\nUPDATE TB_GOODS G SET STOCK_QTY = (SELECT SUM(QTY) FROM TB_STOCK S WHERE S.GOODS_NO = G.GOODS_NO);\nCOMMIT;\nEOF\n');
  const jobText = 'package egovframework.egov.shop.order.batch;\n\n@Component\npublic class OrderAutoConfirmJob {\n\n    @Resource(name = "orderDAO")\n    private OrderDAO orderDAO;\n\n    /** 배송 완료 7일 지난 주문 자동 구매 확정 */\n    @Scheduled(cron = "0 0 3 * * *")\n    public void run() {\n        orderDAO.updateAutoConfirm();\n        orderDAO.insertOrderHistBatch();\n    }\n}\n';
  const job = addFile('src/main/java/egovframework/egov/shop/order/batch/OrderAutoConfirmJob.java', 'BATCH', 'Java', jobText);

  const batches: BatchResult[] = [
    {
      id: 'B001', name: '일 정산', kind: 'shell', group: 'batch', entry: settleSh.id,
      schedule: { expr: '0 2 * * *', text: '매일 02:00', evidence: { file: crontab.id, line: 3, text: '0 2 * * * /app/batch/settle_daily.sh' } },
      flow: [
        { layer: 'SCHEDULE', file: crontab.id, symbol: 'deploy/crontab\n0 2 * * *', line: 3 },
        { layer: 'BATCH', file: settleSh.id, symbol: 'settle_daily.sh\nenv.sh 읽기 · sqlplus 호출', line: 6 },
        { layer: 'DDL', file: settleSql.id, symbol: 'settle_daily.sql\nINSERT 2 · SELECT 2', line: 2 },
        { layer: 'TABLE', symbol: 'TB_SETTLE C\nTB_SETTLE_ITEM C\nTB_ORDER R\nTB_ORDER_ITEM R' },
      ],
      tables: [{ table: 'TB_ORDER', crud: ['R'] }, { table: 'TB_ORDER_ITEM', crud: ['R'] }, { table: 'TB_SETTLE', crud: ['C'] }, { table: 'TB_SETTLE_ITEM', crud: ['C'] }],
      files: [crontab.id, settleSh.id, settleSql.id, env.id], logs: ['logs/settle_YYYYMMDD.log'],
      role: '전날 결제가 끝난 주문을 모아 판매자별 정산 내역(TB_SETTLE·TB_SETTLE_ITEM)을 만들고 날짜별 로그를 남깁니다.', confidence: '높음',
    },
    {
      id: 'B002', name: '휴면 회원 전환', kind: 'shell', group: 'batch', entry: dormant.id,
      schedule: { expr: '30 4 * * *', text: '매일 04:30', evidence: { file: crontab.id, line: 4 } },
      flow: [{ layer: 'SCHEDULE', file: crontab.id, symbol: 'deploy/crontab\n30 4 * * *', line: 4 }, { layer: 'BATCH', file: dormant.id, symbol: 'dormant_member.sh\nheredoc SQL 2', line: 4 }, { layer: 'TABLE', symbol: 'TB_USER_DORMANT C\nTB_USER R U' }],
      tables: [{ table: 'TB_USER', crud: ['R', 'U'] }, { table: 'TB_USER_DORMANT', crud: ['C'] }], files: [crontab.id, dormant.id, env.id], logs: [],
      role: '1년 넘게 로그인하지 않은 회원을 휴면 테이블로 옮기고 상태를 바꿉니다.', confidence: '높음',
    },
    {
      id: 'B003', name: '월 매출 집계', kind: 'batch', group: 'batch', entry: monthly.id,
      schedule: { expr: '매월 1일 01:00', text: '매월 1일 01:00', evidence: { file: monthly.id, line: 2 } },
      flow: [{ layer: 'SCHEDULE', file: monthly.id, symbol: '작업 스케줄러\n매월 1일 01:00', line: 2 }, { layer: 'BATCH', file: monthly.id, symbol: 'stats_monthly.bat\nsqlplus 호출', line: 3 }, { layer: 'TABLE', symbol: 'TB_SALES_MONTHLY C\nTB_ORDER R' }],
      tables: [{ table: 'TB_ORDER', crud: ['R'] }, { table: 'TB_SALES_MONTHLY', crud: ['C'] }], files: [monthly.id], logs: [],
      role: '지난달 주문을 월별 매출 테이블에 집계합니다.', confidence: '보통',
    },
    {
      id: 'B004', name: '로그 정리', kind: 'shell', group: 'batch', entry: clean.id,
      schedule: { expr: '0 5 * * 0', text: '매주 일 05:00', evidence: { file: crontab.id, line: 5 } },
      flow: [{ layer: 'SCHEDULE', file: crontab.id, symbol: 'deploy/crontab\n0 5 * * 0', line: 5 }, { layer: 'BATCH', file: clean.id, symbol: 'clean_logs.sh\nfind -delete', line: 3 }],
      tables: [], files: [crontab.id, clean.id], logs: ['/app/logs/*.log'], role: '30일 지난 로그 파일을 지웁니다. DB는 쓰지 않습니다.', confidence: '높음',
    },
    {
      id: 'B005', name: '재고 동기화', kind: 'shell', group: 'batch', entry: sync.id,
      flow: [{ layer: 'BATCH', file: sync.id, symbol: 'sync_stock.sh\nheredoc SQL 1', line: 4 }, { layer: 'TABLE', symbol: 'TB_GOODS U\nTB_STOCK R' }],
      tables: [{ table: 'TB_GOODS', crud: ['U'] }, { table: 'TB_STOCK', crud: ['R'] }], files: [sync.id, env.id], logs: [],
      role: '재고 테이블의 수량을 상품 테이블에 맞춥니다. 실행 주기를 찾지 못했습니다.', confidence: '보통',
    },
    {
      id: 'B006', name: '주문 자동 확정', kind: 'spring-scheduled', group: 'Spring 스케줄러', entry: job.id,
      schedule: { expr: '0 0 3 * * *', text: '매일 03:00', evidence: { file: job.id, line: 10 } },
      flow: [{ layer: 'SCHEDULE', file: job.id, symbol: '@Scheduled\n0 0 3 * * *', line: 10 }, { layer: 'BATCH', file: job.id, symbol: 'OrderAutoConfirmJob.run()', line: 11 }, { layer: 'TABLE', symbol: 'TB_ORDER R U\nTB_ORDER_HIST C' }],
      tables: [{ table: 'TB_ORDER', crud: ['R', 'U'] }, { table: 'TB_ORDER_HIST', crud: ['C'] }], files: [job.id], logs: [],
      role: '배송 완료 후 7일이 지난 주문을 구매 확정으로 바꾸고 이력을 남깁니다.', confidence: '높음',
    },
  ];
  for (const b of batches) for (const t of b.tables) {
    const mp = allTablesUse.get(t.table) ?? new Map<string, Set<Crud>>();
    mp.set(b.id, new Set(t.crud));
    allTablesUse.set(t.table, mp);
  }

  // ---- 테이블 결과
  const tables: TableResult[] = TABLES.map(([name, comment, common], i) => {
    const use = allTablesUse.get(name) ?? new Map<string, Set<Crud>>();
    const usedBy = [...use.entries()].map(([id, set]) => ({
      kind: (id.startsWith('B') ? 'batch' : 'screen') as 'screen' | 'batch', id, crud: (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => set.has(c)),
    }));
    const ddl = ddlLine.get(name);
    const filesOf = [...(tableFiles.get(name) ?? [])];
    if (ddl) filesOf.push(ddl.file);
    const unlinked = usedBy.length === 0;
    return {
      id: `T${pad(i + 1, 3)}`, name, comment, role: name === 'TB_ORDER' ? '주문 1건의 헤더 정보(주문번호, 주문자, 주문 상태, 결제 금액, 주문일시)를 저장합니다.' : `${comment} 정보를 저장합니다.`,
      roleConfidence: ddl ? '높음' : '보통', columns: columnsOf.get(name) ?? [], ddl, common: !!common, fromSqlOnly: !ddl, files: filesOf, usedBy,
      joinsWith: [...(joins.get(name) ?? [])], unlinked, estimated: false,
    };
  });
  // 미연결 예시
  for (const n of ['TB_COUPON']) {
    const t = tables.find((x) => x.name === n);
    if (t) {
      t.usedBy = t.usedBy.filter((u) => u.kind !== 'screen' || u.id === 'none');
      t.unlinked = true;
    }
  }

  // ---- 메뉴 결과
  const menus: MenuResult[] = MENUS.map(([key, parent, name, url, order]) => {
    const ms = screens.filter((s) => s.menu === key);
    const tmap = new Map<string, Set<Crud>>();
    const collect = (k: string) => {
      for (const s of screens.filter((x) => x.menu === k)) for (const t of s.tables) {
        const set = tmap.get(t.table) ?? new Set<Crud>();
        t.crud.forEach((c) => set.add(c));
        tmap.set(t.table, set);
      }
      for (const c of MENUS.filter((x) => x[1] === k)) collect(c[0]);
    };
    collect(key);
    return {
      id: key, name, parent, url, order, depth: parent ? 2 : 1, screens: ms.map((s) => s.id), source: 'data-file' as const,
      evidence: { file: menuFile.id, line: lineOf(menuText, `'${key}'`) }, estimated: false,
      tables: [...tmap.entries()].map(([table, set]) => ({ table, crud: (['C', 'R', 'U', 'D'] as Crud[]).filter((c) => set.has(c)) })),
    };
  });

  // ---- 기타 파일 (설정)
  const globals = addFile('src/main/resources/egovframework/egovProps/globals.properties', 'CONFIG', 'Properties',
    '# 운영 DB\nGlobals.DbType = oracle\nGlobals.oracle.DriverClassName=oracle.jdbc.driver.OracleDriver\nGlobals.oracle.Url=jdbc:oracle:thin:@•••:1521:•••\nGlobals.oracle.UserName=•••\nGlobals.oracle.Password=•••\n');
  const pom = addFile('pom.xml', 'CONFIG', 'XML', '<project>\n  <dependencies>\n    <dependency>\n      <groupId>egovframework.rte</groupId>\n      <artifactId>egovframework.rte.fdl.cmmn</artifactId>\n      <version>3.10.0</version>\n    </dependency>\n    <dependency>\n      <groupId>com.oracle</groupId>\n      <artifactId>ojdbc8</artifactId>\n    </dependency>\n  </dependencies>\n</project>\n');
  addFile('src/main/webapp/WEB-INF/web.xml', 'CONFIG', 'XML', '<web-app>\n  <servlet>\n    <servlet-name>action</servlet-name>\n    <servlet-class>org.springframework.web.servlet.DispatcherServlet</servlet-class>\n  </servlet>\n</web-app>\n');
  addFile('src/main/webapp/WEB-INF/jsp/cmm/header.jsp', 'VIEW', 'JSP', '<%@ page contentType="text/html; charset=utf-8"%>\n<div id="header">관리자</div>\n');
  addFile('src/main/webapp/WEB-INF/jsp/cmm/footer.jsp', 'VIEW', 'JSP', '<div id="footer">ⓒ shop-admin</div>\n');
  addFile('legacy/StatUtil.java', 'OTHER', 'Java', 'package legacy;\n\n// 통계 유틸 (EUC-KR)\npublic class StatUtil {\n}\n', 'euc-kr');

  const screenNotInMenu = screens.filter((s) => s.notInMenu);
  const result: AnalysisResult = {
    version: 1,
    project: {
      name: 'shop-admin', analyzedAt: '2026-10-16T14:50:00.000Z', durationMs: 12_300, types: ['웹', '배치'],
      title: '전자정부 표준프레임워크(Spring MVC) 기반 쇼핑몰 관리자 웹',
      summary: '회원·상품·주문·정산을 관리하는 관리자용 웹 시스템입니다. 화면 42개, 테이블 27개, 배치 6개이며 주문 관련 화면(11개)과 테이블(7개)의 비중이 가장 큽니다.',
      domainEstimated: true, confidence: '높음',
      evidence: [{ file: pom.id, line: 5, text: 'egovframework.rte 3.10' }, { file: globals.id, line: 4, text: 'jdbc:oracle:thin' }, { file: crontab.id, line: 3, text: 'crontab' }],
      subProjects: [],
    },
    stats: { totalFiles: 2960, analyzedFiles: 688, excludedFiles: 2272, totalBytes: 286_400_000, analyzedBytes: 18_300_000 },
    languages: [
      { name: 'Java', files: 412, lines: 52310, ratio: 0.58 }, { name: 'JSP', files: 96, lines: 15330, ratio: 0.17 },
      { name: 'JavaScript', files: 88, lines: 12620, ratio: 0.14 }, { name: 'XML', files: 64, lines: 6310, ratio: 0.07 },
      { name: 'SQL', files: 6, lines: 2700, ratio: 0.03 }, { name: 'Shell', files: 22, lines: 900, ratio: 0.01 },
    ],
    databases: [{ type: 'Oracle', access: ['MyBatis 매퍼', 'eGov DAO', 'JDBC 직접 (추정)'], confidence: '높음', evidence: [{ file: globals.id, line: 4, text: 'Globals.oracle.Url=jdbc:oracle:thin:@•••' }, { file: pom.id, line: 10, text: '<artifactId>ojdbc8</artifactId>' }] }],
    tech: [
      { layer: '화면', items: 'JSP · jQuery', files: 184 }, { layer: '컨트롤러', items: 'Spring MVC (@Controller)', files: 38 },
      { layer: '서비스', items: 'Spring (@Service)', files: 41 }, { layer: '데이터 접근', items: 'MyBatis 매퍼 XML · DAO', files: 78 },
      { layer: 'DB', items: 'Oracle', files: 6 }, { layer: '배치', items: '셸 스크립트 · crontab · @Scheduled', files: 9 },
      { layer: '설정', items: 'web.xml · context-*.xml · globals.properties', files: 23 },
    ],
    files, tables, screens, menus, batches, sql,
    issues: [
      { kind: 'unlinked-table', title: '화면에 연결되지 않은 테이블', detail: '배치·외부 연동에서 쓰거나 쓰지 않는 테이블일 수 있음', items: [{ ref: 'T026', note: 'TB_COUPON' }] },
      { kind: 'screen-not-in-menu', title: '메뉴에 없는 화면', detail: '팝업·상세 화면으로 추정', items: screenNotInMenu.slice(0, 6).map((s) => ({ ref: s.id, note: s.name })) },
      { kind: 'estimated-sql', title: '동적 SQL로 테이블을 추정한 쿼리', detail: 'OrderMapper.xml 외 2개 파일', items: sql.filter((q) => q.dynamic).slice(0, 4).map((q) => ({ ref: q.id, note: q.stmtId })) },
      { kind: 'encoding', title: '인코딩 확인이 필요한 파일', detail: 'EUC-KR로 추정', items: files.filter((f) => f.encoding === 'euc-kr').map((f) => ({ ref: f.id, note: f.path })) },
      { kind: 'no-schedule', title: '실행 주기를 찾지 못한 배치', detail: '서버 crontab·작업 스케줄러 내보내기 파일을 지정하세요', items: [{ ref: 'B005', note: '재고 동기화' }] },
    ],
  };
  return { result, texts };
}
