<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="form" uri="http://www.springframework.org/tags/form" %>
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>공통코드 관리 | 쇼핑몰 관리자</title>
<%@ include file="/WEB-INF/jsp/shop/inc/head.jsp" %>
<script type="text/javascript" src="<c:url value='/js/shop/system/codeList.js'/>"></script>
</head>
<body>
<jsp:include page="/WEB-INF/jsp/shop/inc/menu.jsp" />
<div class="content">
  <h2 class="title">공통코드 관리</h2>
  <form id="searchForm" name="searchForm" action="<c:url value='/system/codeList.do'/>" method="post">
    <input type="text" name="searchKeyword"/> <button type="submit">검색</button>
  </form>
</div>
<%@ include file="/WEB-INF/jsp/shop/inc/footer.jsp" %>
</body>
</html>
