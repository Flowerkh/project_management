/* 반품·교환 */
$(function () {
  $("#btn_insertClaim").on("click", function () {
    $.ajax({
      url: contextPath + "/order/insertClaim.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
  $("#btn_updateClaimStat").on("click", function () {
    $.ajax({
      url: contextPath + "/order/updateClaimStat.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
