/* 재고 현황 */
$(function () {
  $("#btn_updateStock").on("click", function () {
    $.ajax({
      url: contextPath + "/goods/updateStock.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
