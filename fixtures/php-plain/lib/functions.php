<?php
function get_customer_name($conn, $id)
{
    $r = mysqli_query($conn, "SELECT name FROM customers WHERE id = " . intval($id));
    $row = mysqli_fetch_assoc($r);
    return $row['name'];
}
