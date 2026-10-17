/* 주문 상세 */
$(function () {
  $("#btn_updateOrderStat").on("click", function () {
    $.ajax({
      url: contextPath + "/order/updateOrderStat.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
  $("#btn_insertOrderHist").on("click", function () {
    $.ajax({
      url: contextPath + "/order/insertOrderHist.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
  $("#btn_updateDlvyStat").on("click", function () {
    $.ajax({
      url: contextPath + "/order/updateDlvyStat.do",
      type: "POST",
      data: $("#detailForm").serialize(),
      success: function () { alert("저장했습니다."); }
    });
  });
});
function fn_openHist() {
  window.open(contextPath + "/order/orderHistPopup.do?orderNo=" + $("#orderNo").val(), "hist", "width=600,height=500");
}
