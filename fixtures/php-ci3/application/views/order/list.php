<h2>주문 목록</h2>
<table>
<?php foreach ($orders as $o): ?>
  <tr><td><a href="<?= site_url('order/detail/'.$o->id) ?>"><?= $o->id ?></a></td></tr>
<?php endforeach; ?>
</table>
