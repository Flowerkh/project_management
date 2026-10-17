<?php
include '../inc/db.php';
$id = intval($_POST['id']);
$status = mysqli_real_escape_string($conn, $_POST['status']);
mysqli_query($conn, "UPDATE orders SET status = '$status' WHERE id = $id");
mysqli_query($conn, "INSERT INTO order_logs (order_id, status, created_at) VALUES ($id, '$status', NOW())");
header('Location: view.php?id=' . $id);
