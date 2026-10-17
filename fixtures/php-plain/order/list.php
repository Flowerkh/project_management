<?php
include '../inc/db.php';
$status = $_GET['status'] ?? '';
$sql = "SELECT o.id, o.status, c.name FROM orders o JOIN customers c ON o.customer_id = c.id";
if ($status) {
    $sql .= " WHERE o.status = '" . mysqli_real_escape_string($conn, $status) . "'";
}
$res = mysqli_query($conn, $sql);
include '../inc/header.php';
?>
<h2>주문 목록</h2>
<table>
<?php while ($row = mysqli_fetch_assoc($res)) { ?>
  <tr><td><a href="view.php?id=<?= $row['id'] ?>"><?= $row['id'] ?></a></td><td><?= $row['name'] ?></td></tr>
<?php } ?>
</table>
<?php include '../inc/footer.php'; ?>
