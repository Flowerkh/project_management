<?php include 'inc/db.php'; include 'inc/header.php'; ?>
<h1>관리자 메인</h1>
<p>오늘 주문: <span id="cnt"></span></p>
<a href="order/list.php">주문 목록</a>
<script>
$.get('ajax/order_count.php', function (d) { $('#cnt').text(d.count); });
</script>
<?php include 'inc/footer.php'; ?>
