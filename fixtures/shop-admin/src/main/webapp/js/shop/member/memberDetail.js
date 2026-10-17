/* 회원 상세 */
$(function () {
  $("#btn_updateMemberGrade").on("click", function () {
    $.ajax({
      url: contextPath + "/member/updateMemberGrade.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
