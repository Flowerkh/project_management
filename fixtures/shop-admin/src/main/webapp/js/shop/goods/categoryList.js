/* 카테고리 관리 */
$(function () {
  $("#btn_insertCategory").on("click", function () {
    $.ajax({
      url: contextPath + "/goods/insertCategory.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
  $("#btn_deleteCategory").on("click", function () {
    $.ajax({
      url: contextPath + "/goods/deleteCategory.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
