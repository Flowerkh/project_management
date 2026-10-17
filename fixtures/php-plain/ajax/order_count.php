<?php
include '../inc/db.php';
$r = mysqli_query($conn, "SELECT COUNT(*) AS cnt FROM orders WHERE DATE(created_at) = CURDATE()");
header('Content-Type: application/json');
echo json_encode(['count' => mysqli_fetch_assoc($r)['cnt']]);
