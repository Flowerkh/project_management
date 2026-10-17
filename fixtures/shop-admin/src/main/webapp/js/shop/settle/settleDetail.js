/* 정산 상세 */
$(function () {
  $("#btn_updateSettleStat").on("click", function () {
    $.ajax({
      url: contextPath + "/settle/updateSettleStat.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
