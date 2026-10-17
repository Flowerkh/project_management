<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<ul class="lnb">
  <li>회원관리
    <ul>
      <li><a href="<c:url value='/member/memberList.do'/>">회원 목록</a></li>
      <li><a href="<c:url value='/member/memberGradeList.do'/>">회원 등급 관리</a></li>
      <li><a href="<c:url value='/member/dormantList.do'/>">휴면 회원 목록</a></li>
    </ul>
  </li>
  <li>상품관리
    <ul>
      <li><a href="<c:url value='/goods/goodsList.do'/>">상품 목록</a></li>
      <li><a href="<c:url value='/goods/goodsRegist.do'/>">상품 등록</a></li>
      <li><a href="<c:url value='/goods/categoryList.do'/>">카테고리 관리</a></li>
      <li><a href="<c:url value='/goods/stockList.do'/>">재고 현황</a></li>
    </ul>
  </li>
  <li>주문관리
    <ul>
      <li><a href="<c:url value='/order/orderList.do'/>">주문 목록</a></li>
      <li><a href="<c:url value='/order/dlvyList.do'/>">배송 현황</a></li>
      <li><a href="<c:url value='/order/claimList.do'/>">반품·교환</a></li>
    </ul>
  </li>
  <li>정산관리
    <ul>
      <li><a href="<c:url value='/settle/settleList.do'/>">정산 목록</a></li>
      <li><a href="<c:url value='/settle/sellerList.do'/>">판매자 관리</a></li>
      <li><a href="<c:url value='/settle/salesStats.do'/>">월 매출 통계</a></li>
    </ul>
  </li>
  <li>시스템관리
    <ul>
      <li><a href="<c:url value='/system/menuList.do'/>">메뉴 관리</a></li>
      <li><a href="<c:url value='/system/codeList.do'/>">공통코드 관리</a></li>
      <li><a href="<c:url value='/system/adminList.do'/>">관리자 계정</a></li>
      <li><a href="<c:url value='/system/loginLogList.do'/>">접속 로그</a></li>
      <li><a href="<c:url value='/system/dynamicReport.do'/>">동적 조회</a></li>
    </ul>
  </li>
</ul>
