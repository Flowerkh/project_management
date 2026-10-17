/* 메뉴 관리 */
$(function () {
  $("#btn_insertMenu").on("click", function () {
    $.ajax({
      url: contextPath + "/system/insertMenu.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
  $("#btn_deleteMenu").on("click", function () {
    $.ajax({
      url: contextPath + "/system/deleteMenu.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
