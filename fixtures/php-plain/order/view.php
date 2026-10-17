<?php
include '../inc/db.php';
include '../lib/functions.php';
$id = intval($_GET['id']);
$order = mysqli_fetch_assoc(mysqli_query($conn, "SELECT * FROM orders WHERE id = $id"));
$items = mysqli_query($conn, "SELECT * FROM order_items WHERE order_id = $id");
$customer = get_customer_name($conn, $order['customer_id']);
include '../inc/header.php';
?>
<h2>주문 상세</h2>
<form method="post" action="save.php">
  <input type="hidden" name="id" value="<?= $id ?>">
  <select name="status"><option>DONE</option></select>
  <button type="submit">저장</button>
</form>
<?php
echo "<a href='list.php'>목록</a>";
include '../inc/footer.php';
