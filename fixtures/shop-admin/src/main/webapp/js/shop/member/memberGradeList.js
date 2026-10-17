/* 회원 등급 관리 */
$(function () {
  $("#btn_updateGrade").on("click", function () {
    $.ajax({
      url: contextPath + "/member/updateGrade.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
