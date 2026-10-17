#!/usr/bin/env python3
"""shop-admin 예제 프로젝트 생성 (전자정부 표준프레임워크 스타일: Spring MVC + JSP + MyBatis + Oracle)
정답(ground truth)은 fixtures/shop-admin.expected.json 에 함께 쓴다.
사용: python3 fixtures/gen_shop_admin.py fixtures/shop-admin
"""
import json
import os
import shutil
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'fixtures/shop-admin'
PKG = 'egovframework.shop'
expected = {'tables': [], 'screens': [], 'menus': [], 'batches': []}


def w(path, text, enc='utf-8'):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding=enc, newline='\n') as f:
        f.write(text.lstrip('\n'))


def camel(s):
    return ''.join(x.capitalize() for x in s.split('_'))


def lc(s):
    c = camel(s)
    return c[0].lower() + c[1:]


# ------------------------------------------------------------------ 테이블
TABLES = {
    # name: (comment, [(col, type, comment, pk)])
    'TB_USER': ('회원 기본정보', [('USER_ID', 'VARCHAR2(20)', '회원 ID', True), ('USER_NM', 'VARCHAR2(50)', '회원명', False), ('USER_HP', 'VARCHAR2(20)', '휴대폰', False), ('USER_EMAIL', 'VARCHAR2(100)', '이메일', False), ('GRADE_CD', 'VARCHAR2(10)', '등급 코드', False), ('JOIN_DT', 'DATE', '가입일', False), ('LAST_LOGIN_DT', 'DATE', '최종 로그인', False), ('STAT_CD', 'VARCHAR2(10)', '상태', False)]),
    'TB_USER_DORMANT': ('휴면 회원', [('USER_ID', 'VARCHAR2(20)', '회원 ID', True), ('DORMANT_DT', 'DATE', '휴면 전환일', False), ('USER_NM', 'VARCHAR2(50)', '회원명', False)]),
    'TB_USER_GRADE': ('회원 등급', [('GRADE_CD', 'VARCHAR2(10)', '등급 코드', True), ('GRADE_NM', 'VARCHAR2(50)', '등급명', False), ('DC_RATE', 'NUMBER(5,2)', '할인율', False)]),
    'TB_USER_ADDR': ('회원 배송지', [('ADDR_SN', 'NUMBER(10)', '배송지 번호', True), ('USER_ID', 'VARCHAR2(20)', '회원 ID', False), ('ZIP', 'VARCHAR2(10)', '우편번호', False), ('ADDR', 'VARCHAR2(200)', '주소', False)]),
    'TB_GOODS': ('상품 기본정보', [('GOODS_NO', 'NUMBER(10)', '상품 번호', True), ('GOODS_NM', 'VARCHAR2(200)', '상품명', False), ('CATE_CD', 'VARCHAR2(10)', '카테고리', False), ('SELLER_ID', 'VARCHAR2(20)', '판매자', False), ('PRICE', 'NUMBER(12)', '가격', False), ('SALE_STAT_CD', 'VARCHAR2(10)', '판매 상태', False), ('REG_DT', 'DATE', '등록일', False)]),
    'TB_GOODS_OPTION': ('상품 옵션', [('OPT_SN', 'NUMBER(10)', '옵션 번호', True), ('GOODS_NO', 'NUMBER(10)', '상품 번호', False), ('OPT_NM', 'VARCHAR2(100)', '옵션명', False), ('ADD_PRICE', 'NUMBER(12)', '추가 금액', False)]),
    'TB_GOODS_IMG': ('상품 이미지', [('IMG_SN', 'NUMBER(10)', '이미지 번호', True), ('GOODS_NO', 'NUMBER(10)', '상품 번호', False), ('FILE_ID', 'VARCHAR2(20)', '파일 ID', False)]),
    'TB_CATEGORY': ('상품 카테고리', [('CATE_CD', 'VARCHAR2(10)', '카테고리 코드', True), ('UPPER_CATE_CD', 'VARCHAR2(10)', '상위 카테고리', False), ('CATE_NM', 'VARCHAR2(100)', '카테고리명', False)]),
    'TB_STOCK': ('상품 재고', [('GOODS_NO', 'NUMBER(10)', '상품 번호', True), ('OPT_SN', 'NUMBER(10)', '옵션 번호', True), ('STOCK_QTY', 'NUMBER(10)', '재고 수량', False)]),
    'TB_ORDER': ('주문 기본정보', [('ORDER_NO', 'VARCHAR2(20)', '주문 번호', True), ('USER_ID', 'VARCHAR2(20)', '회원 ID', False), ('ORDER_DT', 'DATE', '주문일', False), ('ORDER_STAT_CD', 'VARCHAR2(10)', '주문 상태', False), ('TOT_AMT', 'NUMBER(12)', '총 금액', False), ('PAY_STAT_CD', 'VARCHAR2(10)', '결제 상태', False)]),
    'TB_ORDER_ITEM': ('주문 상품', [('ORDER_NO', 'VARCHAR2(20)', '주문 번호', True), ('ITEM_SN', 'NUMBER(5)', '순번', True), ('GOODS_NO', 'NUMBER(10)', '상품 번호', False), ('QTY', 'NUMBER(5)', '수량', False), ('PRICE', 'NUMBER(12)', '가격', False)]),
    'TB_ORDER_DLVY': ('주문 배송', [('ORDER_NO', 'VARCHAR2(20)', '주문 번호', True), ('DLVY_STAT_CD', 'VARCHAR2(10)', '배송 상태', False), ('INVOICE_NO', 'VARCHAR2(30)', '송장 번호', False), ('DLVY_DT', 'DATE', '배송일', False)]),
    'TB_ORDER_HIST': ('주문 상태 이력', [('HIST_SN', 'NUMBER(12)', '이력 번호', True), ('ORDER_NO', 'VARCHAR2(20)', '주문 번호', False), ('ORDER_STAT_CD', 'VARCHAR2(10)', '변경 상태', False), ('REG_DT', 'DATE', '등록일', False)]),
    'TB_ORDER_CLAIM': ('주문 클레임(반품·교환)', [('CLAIM_NO', 'VARCHAR2(20)', '클레임 번호', True), ('ORDER_NO', 'VARCHAR2(20)', '주문 번호', False), ('CLAIM_TY_CD', 'VARCHAR2(10)', '클레임 유형', False), ('CLAIM_STAT_CD', 'VARCHAR2(10)', '클레임 상태', False)]),
    'TB_PAY': ('결제', [('PAY_NO', 'VARCHAR2(20)', '결제 번호', True), ('ORDER_NO', 'VARCHAR2(20)', '주문 번호', False), ('PAY_AMT', 'NUMBER(12)', '결제 금액', False), ('PAY_MTHD_CD', 'VARCHAR2(10)', '결제 수단', False)]),
    'TB_SETTLE': ('판매자 정산', [('SETTLE_NO', 'VARCHAR2(20)', '정산 번호', True), ('SELLER_ID', 'VARCHAR2(20)', '판매자', False), ('SETTLE_DT', 'DATE', '정산일', False), ('SETTLE_AMT', 'NUMBER(14)', '정산 금액', False), ('SETTLE_STAT_CD', 'VARCHAR2(10)', '정산 상태', False)]),
    'TB_SETTLE_ITEM': ('정산 상세', [('SETTLE_NO', 'VARCHAR2(20)', '정산 번호', True), ('ORDER_NO', 'VARCHAR2(20)', '주문 번호', True), ('AMT', 'NUMBER(12)', '금액', False)]),
    'TB_SELLER': ('판매자', [('SELLER_ID', 'VARCHAR2(20)', '판매자 ID', True), ('SELLER_NM', 'VARCHAR2(100)', '판매자명', False), ('BIZ_NO', 'VARCHAR2(20)', '사업자번호', False)]),
    'TB_SALES_MONTHLY': ('월 매출 집계', [('YM', 'VARCHAR2(6)', '연월', True), ('SELLER_ID', 'VARCHAR2(20)', '판매자', True), ('SALES_AMT', 'NUMBER(14)', '매출액', False)]),
    'TB_MENU': ('관리자 메뉴', [('MENU_ID', 'VARCHAR2(10)', '메뉴 ID', True), ('UPPER_MENU_ID', 'VARCHAR2(10)', '상위 메뉴 ID', False), ('MENU_NM', 'VARCHAR2(100)', '메뉴명', False), ('MENU_URL', 'VARCHAR2(200)', '메뉴 URL', False), ('MENU_ORDR', 'NUMBER(3)', '순서', False)]),
    'TB_CODE': ('공통 코드', [('CODE_ID', 'VARCHAR2(10)', '코드 ID', True), ('CODE_NM', 'VARCHAR2(100)', '코드명', False)]),
    'TB_CODE_DETAIL': ('공통 상세 코드', [('CODE_ID', 'VARCHAR2(10)', '코드 ID', True), ('CODE', 'VARCHAR2(10)', '코드', True), ('CODE_NM', 'VARCHAR2(100)', '코드명', False), ('SORT_ORDR', 'NUMBER(3)', '정렬', False)]),
    'TB_ADMIN': ('관리자 계정', [('ADMIN_ID', 'VARCHAR2(20)', '관리자 ID', True), ('ADMIN_NM', 'VARCHAR2(50)', '관리자명', False), ('AUTH_CD', 'VARCHAR2(10)', '권한', False), ('PWD', 'VARCHAR2(200)', '비밀번호', False)]),
    'TB_AUTH': ('권한', [('AUTH_CD', 'VARCHAR2(10)', '권한 코드', True), ('AUTH_NM', 'VARCHAR2(50)', '권한명', False)]),
    'TB_LOGIN_LOG': ('로그인 로그', [('LOG_SN', 'NUMBER(12)', '로그 번호', True), ('ADMIN_ID', 'VARCHAR2(20)', '관리자 ID', False), ('LOGIN_DT', 'DATE', '로그인 일시', False), ('IP', 'VARCHAR2(50)', '접속 IP', False)]),
    'TB_FILE': ('첨부 파일', [('FILE_ID', 'VARCHAR2(20)', '파일 ID', True), ('FILE_NM', 'VARCHAR2(200)', '파일명', False), ('FILE_PATH', 'VARCHAR2(500)', '저장 경로', False)]),
    'TB_COUPON': ('쿠폰', [('CPN_NO', 'VARCHAR2(20)', '쿠폰 번호', True), ('CPN_NM', 'VARCHAR2(100)', '쿠폰명', False), ('DC_AMT', 'NUMBER(12)', '할인 금액', False)]),
}


def ddl():
    out = ['-- shop-admin DDL (Oracle)\n']
    for t, (cmt, cols) in TABLES.items():
        out.append(f'CREATE TABLE {t} (')
        lines = [f'    {c} {ty}{" NOT NULL" if pk else ""}' for c, ty, _, pk in cols]
        pks = [c for c, _, _, pk in cols if pk]
        lines.append(f'    CONSTRAINT PK_{t} PRIMARY KEY ({", ".join(pks)})')
        out.append(',\n'.join(lines))
        out.append(');\n')
        out.append(f"COMMENT ON TABLE {t} IS '{cmt}';")
        for c, _, cc, _ in cols:
            out.append(f"COMMENT ON COLUMN {t}.{c} IS '{cc}';")
        out.append('')
        expected['tables'].append({'name': t, 'comment': cmt, 'columns': len(cols)})
    w('db/ddl/shop_ddl.sql', '\n'.join(out))


# ------------------------------------------------------------------ 모듈 정의
# 각 화면: (key, title, kind, sql statements [(id, sql)]) ; kind: list/detail/regist/popup/stats
MODULES = [
    {
        'mod': 'member', 'menu': '회원관리', 'ent': 'Member', 'style': 'mapper',
        'screens': [
            ('memberList', '회원 목록', 'list', [('selectMemberList', 'SELECT U.USER_ID, U.USER_NM, U.GRADE_CD, G.GRADE_NM FROM TB_USER U LEFT JOIN TB_USER_GRADE G ON U.GRADE_CD = G.GRADE_CD WHERE U.STAT_CD = #{statCd} ORDER BY U.JOIN_DT DESC')]),
            ('memberDetail', '회원 상세', 'detail', [('selectMember', 'SELECT * FROM TB_USER WHERE USER_ID = #{userId}'), ('selectMemberAddrList', 'SELECT * FROM TB_USER_ADDR WHERE USER_ID = #{userId}'), ('updateMemberGrade', 'UPDATE TB_USER SET GRADE_CD = #{gradeCd} WHERE USER_ID = #{userId}')]),
            ('memberGradeList', '회원 등급 관리', 'list', [('selectGradeList', 'SELECT GRADE_CD, GRADE_NM, DC_RATE FROM TB_USER_GRADE'), ('updateGrade', 'UPDATE TB_USER_GRADE SET DC_RATE = #{dcRate} WHERE GRADE_CD = #{gradeCd}')]),
            ('dormantList', '휴면 회원 목록', 'list', [('selectDormantList', 'SELECT D.USER_ID, D.USER_NM, D.DORMANT_DT FROM TB_USER_DORMANT D ORDER BY D.DORMANT_DT DESC')]),
        ],
    },
    {
        'mod': 'goods', 'menu': '상품관리', 'ent': 'Goods', 'style': 'dao',
        'screens': [
            ('goodsList', '상품 목록', 'list', [('selectGoodsList', 'SELECT G.GOODS_NO, G.GOODS_NM, C.CATE_NM, S.STOCK_QTY FROM TB_GOODS G JOIN TB_CATEGORY C ON G.CATE_CD = C.CATE_CD LEFT JOIN TB_STOCK S ON G.GOODS_NO = S.GOODS_NO <if test="cateCd != null">WHERE G.CATE_CD = #{cateCd}</if>')]),
            ('goodsDetail', '상품 상세', 'detail', [('selectGoods', 'SELECT * FROM TB_GOODS WHERE GOODS_NO = #{goodsNo}'), ('selectGoodsOptionList', 'SELECT * FROM TB_GOODS_OPTION WHERE GOODS_NO = #{goodsNo}'), ('selectGoodsImgList', 'SELECT I.*, F.FILE_NM FROM TB_GOODS_IMG I JOIN TB_FILE F ON I.FILE_ID = F.FILE_ID WHERE I.GOODS_NO = #{goodsNo}')]),
            ('goodsRegist', '상품 등록', 'regist', [('insertGoods', 'INSERT INTO TB_GOODS (GOODS_NO, GOODS_NM, CATE_CD, PRICE, REG_DT) VALUES (SEQ_GOODS.NEXTVAL, #{goodsNm}, #{cateCd}, #{price}, SYSDATE)'), ('insertGoodsOption', 'INSERT INTO TB_GOODS_OPTION (OPT_SN, GOODS_NO, OPT_NM, ADD_PRICE) VALUES (#{optSn}, #{goodsNo}, #{optNm}, #{addPrice})'), ('insertStock', 'INSERT INTO TB_STOCK (GOODS_NO, OPT_SN, STOCK_QTY) VALUES (#{goodsNo}, #{optSn}, 0)')]),
            ('categoryList', '카테고리 관리', 'list', [('selectCategoryList', 'SELECT CATE_CD, UPPER_CATE_CD, CATE_NM FROM TB_CATEGORY START WITH UPPER_CATE_CD IS NULL CONNECT BY PRIOR CATE_CD = UPPER_CATE_CD'), ('insertCategory', 'INSERT INTO TB_CATEGORY (CATE_CD, UPPER_CATE_CD, CATE_NM) VALUES (#{cateCd}, #{upperCateCd}, #{cateNm})'), ('deleteCategory', 'DELETE FROM TB_CATEGORY WHERE CATE_CD = #{cateCd}')]),
            ('stockList', '재고 현황', 'list', [('selectStockList', 'SELECT S.GOODS_NO, G.GOODS_NM, S.STOCK_QTY FROM TB_STOCK S, TB_GOODS G WHERE S.GOODS_NO = G.GOODS_NO'), ('updateStock', 'UPDATE TB_STOCK SET STOCK_QTY = #{stockQty} WHERE GOODS_NO = #{goodsNo} AND OPT_SN = #{optSn}')]),
        ],
    },
    {
        'mod': 'order', 'menu': '주문관리', 'ent': 'Order', 'style': 'dao',
        'screens': [
            ('orderList', '주문 목록', 'list', [('selectOrderList', 'SELECT O.ORDER_NO, O.ORDER_DT, O.ORDER_STAT_CD, U.USER_NM, O.TOT_AMT FROM TB_ORDER O JOIN TB_USER U ON O.USER_ID = U.USER_ID WHERE O.ORDER_DT BETWEEN #{fromDt} AND #{toDt} AND ROWNUM &lt;= 1000')]),
            ('orderDetail', '주문 상세', 'detail', [('selectOrder', 'SELECT * FROM TB_ORDER WHERE ORDER_NO = #{orderNo}'), ('selectOrderItemList', 'SELECT I.*, G.GOODS_NM FROM TB_ORDER_ITEM I JOIN TB_GOODS G ON I.GOODS_NO = G.GOODS_NO WHERE I.ORDER_NO = #{orderNo}'), ('selectOrderDlvy', 'SELECT * FROM TB_ORDER_DLVY WHERE ORDER_NO = #{orderNo}'), ('selectPay', 'SELECT * FROM TB_PAY WHERE ORDER_NO = #{orderNo}'), ('updateOrderStat', 'UPDATE TB_ORDER SET ORDER_STAT_CD = #{orderStatCd} WHERE ORDER_NO = #{orderNo}'), ('insertOrderHist', 'INSERT INTO TB_ORDER_HIST (HIST_SN, ORDER_NO, ORDER_STAT_CD, REG_DT) VALUES (SEQ_ORDER_HIST.NEXTVAL, #{orderNo}, #{orderStatCd}, SYSDATE)'), ('updateDlvyStat', 'UPDATE TB_ORDER_DLVY SET DLVY_STAT_CD = #{dlvyStatCd}, INVOICE_NO = #{invoiceNo} WHERE ORDER_NO = #{orderNo}')]),
            ('dlvyList', '배송 현황', 'list', [('selectDlvyList', 'SELECT D.ORDER_NO, D.DLVY_STAT_CD, D.INVOICE_NO, O.USER_ID FROM TB_ORDER_DLVY D JOIN TB_ORDER O ON D.ORDER_NO = O.ORDER_NO')]),
            ('claimList', '반품·교환', 'list', [('selectClaimList', 'SELECT C.CLAIM_NO, C.ORDER_NO, C.CLAIM_TY_CD, C.CLAIM_STAT_CD FROM TB_ORDER_CLAIM C'), ('insertClaim', 'INSERT INTO TB_ORDER_CLAIM (CLAIM_NO, ORDER_NO, CLAIM_TY_CD, CLAIM_STAT_CD) VALUES (#{claimNo}, #{orderNo}, #{claimTyCd}, \'REQ\')'), ('updateClaimStat', 'UPDATE TB_ORDER_CLAIM SET CLAIM_STAT_CD = #{claimStatCd} WHERE CLAIM_NO = #{claimNo}')]),
            ('orderHistPopup', '주문 이력', 'popup', [('selectOrderHistList', 'SELECT HIST_SN, ORDER_STAT_CD, REG_DT FROM TB_ORDER_HIST WHERE ORDER_NO = #{orderNo} ORDER BY HIST_SN DESC')]),
        ],
    },
    {
        'mod': 'settle', 'menu': '정산관리', 'ent': 'Settle', 'style': 'dao',
        'screens': [
            ('settleList', '정산 목록', 'list', [('selectSettleList', 'SELECT S.SETTLE_NO, S.SETTLE_DT, S.SETTLE_AMT, SL.SELLER_NM FROM TB_SETTLE S JOIN TB_SELLER SL ON S.SELLER_ID = SL.SELLER_ID')]),
            ('settleDetail', '정산 상세', 'detail', [('selectSettle', 'SELECT * FROM TB_SETTLE WHERE SETTLE_NO = #{settleNo}'), ('selectSettleItemList', 'SELECT I.*, O.ORDER_DT FROM TB_SETTLE_ITEM I JOIN TB_ORDER O ON I.ORDER_NO = O.ORDER_NO WHERE I.SETTLE_NO = #{settleNo}'), ('updateSettleStat', 'UPDATE TB_SETTLE SET SETTLE_STAT_CD = #{settleStatCd} WHERE SETTLE_NO = #{settleNo}')]),
            ('sellerList', '판매자 관리', 'list', [('selectSellerList', 'SELECT SELLER_ID, SELLER_NM, BIZ_NO FROM TB_SELLER'), ('insertSeller', 'INSERT INTO TB_SELLER (SELLER_ID, SELLER_NM, BIZ_NO) VALUES (#{sellerId}, #{sellerNm}, #{bizNo})')]),
            ('salesStats', '월 매출 통계', 'list', [('selectSalesMonthly', 'SELECT YM, SELLER_ID, SALES_AMT FROM TB_SALES_MONTHLY WHERE YM = #{ym}')]),
        ],
    },
    {
        'mod': 'system', 'menu': '시스템관리', 'ent': 'Sys', 'style': 'dao',
        'screens': [
            ('menuList', '메뉴 관리', 'list', [('selectMenuList', 'SELECT MENU_ID, UPPER_MENU_ID, MENU_NM, MENU_URL FROM TB_MENU ORDER BY MENU_ORDR'), ('insertMenu', 'INSERT INTO TB_MENU (MENU_ID, UPPER_MENU_ID, MENU_NM, MENU_URL, MENU_ORDR) VALUES (#{menuId}, #{upperMenuId}, #{menuNm}, #{menuUrl}, #{menuOrdr})'), ('deleteMenu', 'DELETE FROM TB_MENU WHERE MENU_ID = #{menuId}')]),
            ('codeList', '공통코드 관리', 'list', [('selectCodeList', 'SELECT C.CODE_ID, C.CODE_NM, D.CODE, D.CODE_NM FROM TB_CODE C JOIN TB_CODE_DETAIL D ON C.CODE_ID = D.CODE_ID'), ('mergeCodeDetail', 'MERGE INTO TB_CODE_DETAIL T USING (SELECT #{codeId} CODE_ID, #{code} CODE FROM DUAL) S ON (T.CODE_ID = S.CODE_ID AND T.CODE = S.CODE) WHEN MATCHED THEN UPDATE SET T.CODE_NM = #{codeNm} WHEN NOT MATCHED THEN INSERT (CODE_ID, CODE, CODE_NM) VALUES (S.CODE_ID, S.CODE, #{codeNm})')]),
            ('adminList', '관리자 계정', 'list', [('selectAdminList', 'SELECT A.ADMIN_ID, A.ADMIN_NM, H.AUTH_NM FROM TB_ADMIN A JOIN TB_AUTH H ON A.AUTH_CD = H.AUTH_CD'), ('updateAdminAuth', 'UPDATE TB_ADMIN SET AUTH_CD = #{authCd} WHERE ADMIN_ID = #{adminId}')]),
            ('loginLogList', '접속 로그', 'list', [('selectLoginLogList', 'SELECT LOG_SN, ADMIN_ID, LOGIN_DT, IP FROM TB_LOGIN_LOG WHERE LOGIN_DT &gt;= #{fromDt} ORDER BY LOG_SN DESC')]),
            ('dynamicReport', '동적 조회', 'list', [('selectDynamic', 'SELECT * FROM ${tableName} WHERE 1=1')]),
        ],
    },
]


def java_header(pkg):
    return f'package {pkg};\n\n'


def gen_module(m):
    mod, ent, style = m['mod'], m['ent'], m['style']
    pkg = f'{PKG}.{mod}'
    svc_if = f'{ent}Service'
    svc_impl = f'{ent}ServiceImpl'
    dao = f'{ent}DAO' if style == 'dao' else f'{ent}Mapper'
    bean_dao = lc(dao)
    ns = bean_dao if style == 'dao' else f'{pkg}.service.impl.{dao}'
    # VO
    w(f'src/main/java/egovframework/shop/{mod}/service/{ent}VO.java', java_header(f'{pkg}.service') + f'public class {ent}VO extends egovframework.shop.cmm.ComDefaultVO {{\n    private static final long serialVersionUID = 1L;\n    private String searchKeyword;\n}}\n')
    # 서비스 인터페이스·구현·DAO 메서드
    methods = []
    for key, title, kind, stmts in m['screens']:
        for sid, _ in stmts:
            methods.append(sid)
    iface = java_header(f'{pkg}.service') + 'import java.util.List;\nimport egovframework.rte.psl.dataaccess.util.EgovMap;\n\n' + f'public interface {svc_if} {{\n'
    for sid in methods:
        iface += f'    Object {sid}({ent}VO vo) throws Exception;\n'
    iface += '}\n'
    w(f'src/main/java/egovframework/shop/{mod}/service/{svc_if}.java', iface)
    impl = java_header(f'{pkg}.service.impl') + 'import javax.annotation.Resource;\nimport org.springframework.stereotype.Service;\nimport egovframework.rte.fdl.cmmn.EgovAbstractServiceImpl;\n' + f'import {pkg}.service.{svc_if};\nimport {pkg}.service.{ent}VO;\n\n'
    impl += f'@Service("{lc(svc_if)}")\npublic class {svc_impl} extends EgovAbstractServiceImpl implements {svc_if} {{\n\n    @Resource(name = "{bean_dao}")\n    private {dao} {bean_dao};\n\n'
    for sid in methods:
        impl += f'    @Override\n    public Object {sid}({ent}VO vo) throws Exception {{\n        return {bean_dao}.{sid}(vo);\n    }}\n\n'
    impl += '}\n'
    w(f'src/main/java/egovframework/shop/{mod}/service/impl/{svc_impl}.java', impl)
    if style == 'dao':
        d = java_header(f'{pkg}.service.impl') + 'import java.util.List;\nimport org.springframework.stereotype.Repository;\nimport egovframework.rte.psl.dataaccess.EgovAbstractMapper;\n' + f'import {pkg}.service.{ent}VO;\n\n'
        d += f'@Repository("{bean_dao}")\npublic class {dao} extends EgovAbstractMapper {{\n\n'
        for sid in methods:
            verb = 'selectList' if sid.startswith('select') and sid.endswith('List') else 'selectOne' if sid.startswith('select') else 'insert' if sid.startswith('insert') else 'update' if sid.startswith(('update', 'merge')) else 'delete'
            d += f'    public Object {sid}({ent}VO vo) throws Exception {{\n        return {verb}("{bean_dao}.{sid}", vo);\n    }}\n\n'
        d += '}\n'
    else:
        d = java_header(f'{pkg}.service.impl') + 'import java.util.List;\nimport egovframework.rte.psl.dataaccess.mapper.Mapper;\n' + f'import {pkg}.service.{ent}VO;\n\n'
        d += f'@Mapper("{bean_dao}")\npublic interface {dao} {{\n'
        for sid in methods:
            d += f'    Object {sid}({ent}VO vo) throws Exception;\n'
        d += '}\n'
    w(f'src/main/java/egovframework/shop/{mod}/service/impl/{dao}.java', d)
    # 매퍼 XML
    x = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n'
    x += f'<mapper namespace="{ns}">\n\n'
    for key, title, kind, stmts in m['screens']:
        for sid, sql in stmts:
            tag = 'select' if sid.startswith('select') else 'insert' if sid.startswith('insert') else 'update' if sid.startswith(('update', 'merge')) else 'delete'
            x += f'    <!-- {title} -->\n    <{tag} id="{sid}" parameterType="{ent}VO"{" resultType=\"egovMap\"" if tag == "select" else ""}>\n        <![CDATA[\n        {sql}\n        ]]>\n    </{tag}>\n\n'
    x += '</mapper>\n'
    w(f'src/main/resources/egovframework/mapper/shop/{mod}/{ent}_SQL.xml', x)
    # 컨트롤러
    c = java_header(f'{pkg}.web') + 'import javax.annotation.Resource;\nimport org.springframework.stereotype.Controller;\nimport org.springframework.ui.ModelMap;\nimport org.springframework.web.bind.annotation.*;\n' + f'import {pkg}.service.{svc_if};\nimport {pkg}.service.{ent}VO;\n\n'
    c += f'@Controller\n@RequestMapping("/{mod}")\npublic class {ent}Controller {{\n\n    @Resource(name = "{lc(svc_if)}")\n    private {svc_if} {lc(svc_if)};\n\n'
    for key, title, kind, stmts in m['screens']:
        reads = [s for s, _ in stmts if s.startswith('select')]
        writes = [s for s, _ in stmts if not s.startswith('select')]
        c += f'    /** {title} 화면 */\n    @RequestMapping("/{key}.do")\n    public String {key}(@ModelAttribute("searchVO") {ent}VO vo, ModelMap model) throws Exception {{\n'
        for s in reads:
            c += f'        model.addAttribute("{s}", {lc(svc_if)}.{s}(vo));\n'
        c += f'        return "shop/{mod}/{key}";\n    }}\n\n'
        if writes:
            if kind == 'regist':
                c += f'    /** {title} 저장 */\n    @RequestMapping(value = "/{key}Save.do", method = RequestMethod.POST)\n    public String {key}Save(@ModelAttribute {ent}VO vo) throws Exception {{\n'
                for s in writes:
                    c += f'        {lc(svc_if)}.{s}(vo);\n'
                c += f'        return "redirect:/{mod}/{m["screens"][0][0]}.do";\n    }}\n\n'
            else:
                for s in writes:
                    c += f'    /** {title}: {s} (ajax) */\n    @RequestMapping(value = "/{s}.do", method = RequestMethod.POST)\n    @ResponseBody\n    public java.util.Map<String, Object> {s}({ent}VO vo) throws Exception {{\n        {lc(svc_if)}.{s}(vo);\n'
                    if s == 'updateOrderStat':
                        c += f'        {lc(svc_if)}.insertOrderHist(vo);\n'
                    c += '        return java.util.Collections.singletonMap("result", "OK");\n    }\n\n'
    c += '}\n'
    w(f'src/main/java/egovframework/shop/{mod}/web/{ent}Controller.java', c)
    # JSP·JS
    for key, title, kind, stmts in m['screens']:
        writes = [s for s, _ in stmts if not s.startswith('select')]
        jsp = '<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>\n<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>\n<%@ taglib prefix="form" uri="http://www.springframework.org/tags/form" %>\n<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">\n'
        jsp += f'<title>{title} | 쇼핑몰 관리자</title>\n'
        if kind != 'popup':
            jsp += '<%@ include file="/WEB-INF/jsp/shop/inc/head.jsp" %>\n'
        jsp += f'<script type="text/javascript" src="<c:url value=\'/js/shop/{mod}/{key}.js\'/>"></script>\n</head>\n<body>\n'
        if kind != 'popup':
            jsp += '<jsp:include page="/WEB-INF/jsp/shop/inc/menu.jsp" />\n'
        jsp += f'<div class="content">\n  <h2 class="title">{title}</h2>\n'
        if kind == 'list':
            first_detail = next((s for s in m['screens'] if s[2] == 'detail'), None)
            jsp += f'  <form id="searchForm" name="searchForm" action="<c:url value=\'/{mod}/{key}.do\'/>" method="post">\n    <input type="text" name="searchKeyword"/> <button type="submit">검색</button>\n  </form>\n'
            if first_detail:
                jsp += f'  <a href="<c:url value=\'/{mod}/{first_detail[0]}.do\'/>?id=${{row.id}}">상세</a>\n'
        if kind == 'regist':
            jsp += f'  <form:form commandName="vo" action="${{pageContext.request.contextPath}}/{mod}/{key}Save.do" method="post">\n    <button type="submit">저장</button>\n  </form:form>\n'
        if key == 'orderDetail':
            jsp += f'  <button type="button" onclick="fn_openHist()">이력</button>\n'
        jsp += '</div>\n'
        if kind != 'popup':
            jsp += '<%@ include file="/WEB-INF/jsp/shop/inc/footer.jsp" %>\n'
        jsp += '</body>\n</html>\n'
        enc = 'euc-kr' if key in ('loginLogList', 'stockList') else 'utf-8'
        if enc == 'euc-kr':
            jsp = jsp.replace('charset=UTF-8', 'charset=EUC-KR').replace('pageEncoding="UTF-8"', 'pageEncoding="EUC-KR"').replace('<meta charset="UTF-8">', '<meta charset="EUC-KR">')
        w(f'src/main/webapp/WEB-INF/jsp/shop/{mod}/{key}.jsp', jsp, enc)
        js = f'/* {title} */\n$(function () {{\n'
        for s in writes:
            if kind == 'regist':
                continue
            js += f'  $("#btn_{s}").on("click", function () {{\n    $.ajax({{\n      url: contextPath + "/{mod}/{s}.do",\n      type: "POST",\n      data: $("#detailForm").serialize(),\n      success: function () {{ alert("저장했습니다."); }}\n    }});\n  }});\n'
        js += '});\n'
        if key == 'orderDetail':
            js += 'function fn_openHist() {\n  window.open(contextPath + "/order/orderHistPopup.do?orderNo=" + $("#orderNo").val(), "hist", "width=600,height=500");\n}\n'
        w(f'src/main/webapp/js/shop/{mod}/{key}.js', js)
        tables = {}
        for sid, sql in stmts:
            pass
        expected['screens'].append({'url': f'/{mod}/{key}.do', 'title': title, 'kind': kind})


def gen_common():
    w('pom.xml', '''
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>egovframework.shop</groupId>
  <artifactId>shop-admin</artifactId>
  <packaging>war</packaging>
  <version>1.0.0</version>
  <properties>
    <egovframework.rte.version>3.10.0</egovframework.rte.version>
  </properties>
  <dependencies>
    <dependency><groupId>egovframework.rte</groupId><artifactId>egovframework.rte.ptl.mvc</artifactId><version>${egovframework.rte.version}</version></dependency>
    <dependency><groupId>egovframework.rte</groupId><artifactId>egovframework.rte.psl.dataaccess</artifactId><version>${egovframework.rte.version}</version></dependency>
    <dependency><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId><version>4.3.25.RELEASE</version></dependency>
    <dependency><groupId>org.mybatis</groupId><artifactId>mybatis-spring</artifactId><version>1.3.2</version></dependency>
    <dependency><groupId>com.oracle.database.jdbc</groupId><artifactId>ojdbc8</artifactId><version>19.3.0.0</version></dependency>
    <dependency><groupId>javax.servlet</groupId><artifactId>jstl</artifactId><version>1.2</version></dependency>
  </dependencies>
</project>
''')
    w('src/main/resources/egovframework/egovProps/globals.properties', '''
# DB 설정
Globals.DbType = oracle
Globals.DriverClassName = oracle.jdbc.driver.OracleDriver
Globals.Url = jdbc:oracle:thin:@db.example.local:1521:SHOP
Globals.UserName = shop_app
Globals.Password = ********
''')
    w('src/main/resources/egovframework/spring/context-datasource.xml', '''
<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <bean id="dataSource" class="org.apache.commons.dbcp2.BasicDataSource" destroy-method="close">
        <property name="driverClassName" value="${Globals.DriverClassName}"/>
        <property name="url" value="${Globals.Url}"/>
    </bean>
</beans>
''')
    w('src/main/resources/egovframework/spring/context-mapper.xml', '''
<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <bean id="sqlSession" class="org.mybatis.spring.SqlSessionFactoryBean">
        <property name="dataSource" ref="dataSource" />
        <property name="mapperLocations" value="classpath:/egovframework/mapper/shop/**/*_SQL.xml" />
    </bean>
    <bean class="egovframework.rte.psl.dataaccess.mapper.MapperConfigurer">
        <property name="basePackage" value="egovframework.shop" />
    </bean>
</beans>
''')
    w('src/main/webapp/WEB-INF/config/egovframework/springmvc/dispatcher-servlet.xml', '''
<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <context:component-scan base-package="egovframework"/>
    <bean class="org.springframework.web.servlet.view.UrlBasedViewResolver" p:order="1"
          p:viewClass="org.springframework.web.servlet.view.JstlView"
          p:prefix="/WEB-INF/jsp/" p:suffix=".jsp"/>
</beans>
''')
    w('src/main/webapp/WEB-INF/web.xml', '''
<?xml version="1.0" encoding="UTF-8"?>
<web-app>
  <servlet>
    <servlet-name>action</servlet-name>
    <servlet-class>org.springframework.web.servlet.DispatcherServlet</servlet-class>
  </servlet>
  <servlet-mapping>
    <servlet-name>action</servlet-name>
    <url-pattern>*.do</url-pattern>
  </servlet-mapping>
</web-app>
''')
    w('src/main/java/egovframework/shop/cmm/ComDefaultVO.java', java_header(f'{PKG}.cmm') + 'public class ComDefaultVO implements java.io.Serializable {\n    private int pageIndex = 1;\n}\n')
    w('src/main/webapp/WEB-INF/jsp/shop/inc/head.jsp', '<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>\n<link rel="stylesheet" href="/css/shop/admin.css"/>\n<script src="/js/jquery-3.6.0.min.js"></script>\n<script src="/js/shop/common.js"></script>\n')
    w('src/main/webapp/WEB-INF/jsp/shop/inc/footer.jsp', '<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>\n<div class="footer">© shop-admin</div>\n')
    # 사이드 메뉴 (모든 화면에 include)
    menu = '<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>\n<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>\n<ul class="lnb">\n'
    for m in MODULES:
        menu += f'  <li>{m["menu"]}\n    <ul>\n'
        for key, title, kind, _ in m['screens']:
            if kind in ('list',) or key in ('goodsRegist',):
                menu += f'      <li><a href="<c:url value=\'/{m["mod"]}/{key}.do\'/>">{title}</a></li>\n'
        menu += '    </ul>\n  </li>\n'
    menu += '</ul>\n'
    w('src/main/webapp/WEB-INF/jsp/shop/inc/menu.jsp', menu)
    w('src/main/webapp/js/shop/common.js', 'var contextPath = "";\nfunction fn_egov_link(url) {\n  location.href = contextPath + url;\n}\n')
    w('src/main/webapp/js/jquery-3.6.0.min.js', '/*! jQuery v3.6.0 */!function(e,t){"use strict";}(this);\n')
    w('src/main/webapp/images/logo.png', 'PNG')
    w('src/main/webapp/css/shop/admin.css', 'body { font-family: "Malgun Gothic"; }\n')
    # 로그인·메인 (메뉴에 없는 화면)
    w('src/main/java/egovframework/shop/main/web/MainController.java', java_header(f'{PKG}.main.web') + '''import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

@Controller
public class MainController {

    @RequestMapping("/main.do")
    public String main() {
        return "shop/main";
    }

    @RequestMapping("/login.do")
    public String login() {
        return "shop/login";
    }
}
''')
    w('src/main/webapp/WEB-INF/jsp/shop/main.jsp', '<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>\n<html><head><title>관리자 메인</title></head><body>\n<jsp:include page="/WEB-INF/jsp/shop/inc/menu.jsp" />\n<h2>대시보드</h2>\n</body></html>\n')
    w('src/main/webapp/WEB-INF/jsp/shop/login.jsp', '<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>\n<html><head><title>관리자 로그인</title></head><body>\n<form action="/loginAction.do" method="post"><input name="adminId"/><input type="password" name="pwd"/></form>\n</body></html>\n')
    w('src/main/java/egovframework/shop/main/web/LoginController.java', java_header(f'{PKG}.main.web') + '''import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import egovframework.shop.main.service.LoginService;

@Controller
public class LoginController {

    @Resource(name = "loginService")
    private LoginService loginService;

    @RequestMapping("/loginAction.do")
    public String loginAction(String adminId) throws Exception {
        loginService.login(adminId);
        return "redirect:/main.do";
    }
}
''')
    w('src/main/java/egovframework/shop/main/service/LoginService.java', java_header(f'{PKG}.main.service') + 'public interface LoginService {\n    void login(String adminId) throws Exception;\n}\n')
    w('src/main/java/egovframework/shop/main/service/impl/LoginServiceImpl.java', java_header(f'{PKG}.main.service.impl') + '''import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.shop.main.service.LoginService;

@Service("loginService")
public class LoginServiceImpl implements LoginService {

    @Resource(name = "loginDAO")
    private LoginDAO loginDAO;

    public void login(String adminId) throws Exception {
        loginDAO.selectAdmin(adminId);
        loginDAO.insertLoginLog(adminId);
    }
}
''')
    w('src/main/java/egovframework/shop/main/service/impl/LoginDAO.java', java_header(f'{PKG}.main.service.impl') + '''import org.springframework.stereotype.Repository;
import egovframework.rte.psl.dataaccess.EgovAbstractMapper;

@Repository("loginDAO")
public class LoginDAO extends EgovAbstractMapper {
    public Object selectAdmin(String adminId) {
        return selectOne("loginDAO.selectAdmin", adminId);
    }
    public int insertLoginLog(String adminId) {
        return insert("loginDAO.insertLoginLog", adminId);
    }
}
''')
    w('src/main/resources/egovframework/mapper/shop/main/Login_SQL.xml', '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="loginDAO">
    <select id="selectAdmin" resultType="egovMap">
        SELECT ADMIN_ID, ADMIN_NM, AUTH_CD FROM TB_ADMIN WHERE ADMIN_ID = #{adminId}
    </select>
    <insert id="insertLoginLog">
        INSERT INTO TB_LOGIN_LOG (LOG_SN, ADMIN_ID, LOGIN_DT, IP)
        VALUES (SEQ_LOGIN_LOG.NEXTVAL, #{adminId}, SYSDATE, #{ip})
    </insert>
</mapper>
''')


def gen_menu_data():
    out = ['-- 관리자 메뉴 데이터']
    seq = 0
    for i, m in enumerate(MODULES, 1):
        pid = f'M{i:02d}00'
        out.append(f"INSERT INTO TB_MENU (MENU_ID, UPPER_MENU_ID, MENU_NM, MENU_URL, MENU_ORDR) VALUES ('{pid}', NULL, '{m['menu']}', NULL, {i});")
        expected['menus'].append({'id': pid, 'name': m['menu'], 'parent': None})
        j = 0
        for key, title, kind, _ in m['screens']:
            if kind == 'popup' or kind == 'detail':
                continue
            j += 1
            mid = f'M{i:02d}{j:02d}'
            out.append(f"INSERT INTO TB_MENU (MENU_ID, UPPER_MENU_ID, MENU_NM, MENU_URL, MENU_ORDR) VALUES ('{mid}', '{pid}', '{title}', '/{m['mod']}/{key}.do', {j});")
            expected['menus'].append({'id': mid, 'name': title, 'parent': pid, 'url': f"/{m['mod']}/{key}.do"})
    w('db/menu_data.sql', '\n'.join(out) + '\n')


def gen_batch():
    w('deploy/crontab', '''
# shop-admin 배치 스케줄
0 2 * * * /app/batch/settle_daily.sh >> /app/logs/settle.log 2>&1
30 4 * * * /app/batch/dormant_member.sh
0 5 * * 0 /app/batch/clean_logs.sh
''')
    w('batch/settle_daily.sh', '''
#!/bin/sh
# 일 정산 배치: 전날 결제 완료 주문을 판매자별로 정산
. /app/batch/common/env.sh
LOG=/app/logs/settle_$(date +%Y%m%d).log
sqlplus -s $DB_USER/$DB_PASS@SHOP @/app/batch/sql/settle_daily.sql >> $LOG
''')
    w('batch/sql/settle_daily.sql', '''
-- 전날 주문 정산
INSERT INTO TB_SETTLE (SETTLE_NO, SELLER_ID, SETTLE_DT, SETTLE_AMT, SETTLE_STAT_CD)
SELECT 'S' || TO_CHAR(SYSDATE, 'YYYYMMDD') || G.SELLER_ID, G.SELLER_ID, TRUNC(SYSDATE), SUM(I.PRICE * I.QTY), 'READY'
  FROM TB_ORDER O
  JOIN TB_ORDER_ITEM I ON O.ORDER_NO = I.ORDER_NO
  JOIN TB_GOODS G ON I.GOODS_NO = G.GOODS_NO
 WHERE O.ORDER_DT >= TRUNC(SYSDATE) - 1 AND O.ORDER_DT < TRUNC(SYSDATE)
 GROUP BY G.SELLER_ID;

INSERT INTO TB_SETTLE_ITEM (SETTLE_NO, ORDER_NO, AMT)
SELECT 'S' || TO_CHAR(SYSDATE, 'YYYYMMDD') || G.SELLER_ID, O.ORDER_NO, I.PRICE * I.QTY
  FROM TB_ORDER O JOIN TB_ORDER_ITEM I ON O.ORDER_NO = I.ORDER_NO JOIN TB_GOODS G ON I.GOODS_NO = G.GOODS_NO
 WHERE O.ORDER_DT >= TRUNC(SYSDATE) - 1;
COMMIT;
EXIT;
''')
    w('batch/common/env.sh', '#!/bin/sh\n# DB 접속 환경\nexport DB_USER=shop_batch\nexport DB_PASS=********\n')
    w('batch/dormant_member.sh', '''
#!/bin/bash
# 휴면 회원 전환: 1년 이상 로그인하지 않은 회원
sqlplus -s $DB_USER/$DB_PASS@SHOP <<EOF
INSERT INTO TB_USER_DORMANT (USER_ID, DORMANT_DT, USER_NM)
SELECT USER_ID, SYSDATE, USER_NM FROM TB_USER WHERE LAST_LOGIN_DT < ADD_MONTHS(SYSDATE, -12);
UPDATE TB_USER SET STAT_CD = 'DORMANT' WHERE LAST_LOGIN_DT < ADD_MONTHS(SYSDATE, -12);
COMMIT;
EOF
''')
    w('batch/clean_logs.sh', '#!/bin/sh\n# 로그 정리: 30일 지난 로그 삭제\nfind /app/logs -name "*.log" -mtime +30 -delete\n')
    w('batch/sync_stock.sh', '''
#!/bin/sh
# 재고 동기화: 외부 창고 재고를 반영
sqlplus -s $DB_USER/$DB_PASS@SHOP <<EOF
UPDATE TB_STOCK S SET STOCK_QTY = (SELECT QTY FROM WMS_STOCK@WMS W WHERE W.GOODS_NO = S.GOODS_NO);
COMMIT;
EOF
''')
    w('batch/stats_monthly.bat', '''
@echo off
REM 월 매출 집계: 매월 1일 01:00 (작업 스케줄러)
sqlplus -s %DB_USER%/%DB_PASS%@SHOP @batch\\sql\\stats_monthly.sql
''')
    w('batch/sql/stats_monthly.sql', '''
INSERT INTO TB_SALES_MONTHLY (YM, SELLER_ID, SALES_AMT)
SELECT TO_CHAR(ADD_MONTHS(SYSDATE, -1), 'YYYYMM'), G.SELLER_ID, SUM(I.PRICE * I.QTY)
  FROM TB_ORDER O JOIN TB_ORDER_ITEM I ON O.ORDER_NO = I.ORDER_NO JOIN TB_GOODS G ON I.GOODS_NO = G.GOODS_NO
 GROUP BY G.SELLER_ID;
COMMIT;
EXIT;
''')
    w('deploy/task_stats_monthly.xml', '''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>월 매출 집계</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2024-01-01T01:00:00</StartBoundary>
      <ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth></ScheduleByMonth>
    </CalendarTrigger>
  </Triggers>
  <Actions><Exec><Command>D:\\shop\\batch\\stats_monthly.bat</Command></Exec></Actions>
</Task>
''')
    w('src/main/java/egovframework/shop/order/batch/OrderAutoConfirmJob.java', java_header(f'{PKG}.order.batch') + '''import javax.annotation.Resource;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import egovframework.shop.order.service.OrderService;

/** 주문 자동 확정: 배송 완료 후 7일 지난 주문을 구매 확정 */
@Component
public class OrderAutoConfirmJob {

    @Resource(name = "orderService")
    private OrderService orderService;

    @Scheduled(cron = "0 0 3 * * *")
    public void autoConfirm() throws Exception {
        orderService.updateOrderStat(null);
        orderService.insertOrderHist(null);
    }
}
''')
    expected['batches'] = [
        {'name': '일 정산', 'schedule': '매일 02:00'},
        {'name': '휴면 회원 전환', 'schedule': '매일 04:30'},
        {'name': '로그 정리', 'schedule': '매주 일 05:00'},
        {'name': '재고 동기화', 'schedule': None},
        {'name': '월 매출 집계', 'schedule': '매월 1일 01:00'},
        {'name': '주문 자동 확정', 'schedule': '매일 03:00'},
    ]


if __name__ == '__main__':
    if os.path.exists(ROOT):
        shutil.rmtree(ROOT)
    ddl()
    gen_common()
    for m in MODULES:
        gen_module(m)
    gen_menu_data()
    gen_batch()
    with open(ROOT.rstrip('/') + '.expected.json', 'w', encoding='utf-8') as f:
        json.dump(expected, f, ensure_ascii=False, indent=1)
    n = sum(len(fs) for _, _, fs in os.walk(ROOT))
    print(f'{ROOT}: {n} files, tables {len(expected["tables"])}, screens {len(expected["screens"])}, menus {len(expected["menus"])}, batches {len(expected["batches"])}')
