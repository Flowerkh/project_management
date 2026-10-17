/* 공통코드 관리 */
$(function () {
  $("#btn_mergeCodeDetail").on("click", function () {
    $.ajax({
      url: contextPath + "/system/mergeCodeDetail.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
