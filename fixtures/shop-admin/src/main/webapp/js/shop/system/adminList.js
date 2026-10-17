/* 관리자 계정 */
$(function () {
  $("#btn_updateAdminAuth").on("click", function () {
    $.ajax({
      url: contextPath + "/system/updateAdminAuth.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
