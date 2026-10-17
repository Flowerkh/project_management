/* 판매자 관리 */
$(function () {
  $("#btn_insertSeller").on("click", function () {
    $.ajax({
      url: contextPath + "/settle/insertSeller.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
