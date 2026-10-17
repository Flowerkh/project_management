<h2>주문 상세</h2>
<?= form_open('order/update_status') ?>
  <input type="hidden" name="id" value="<?= $order->id ?>">
  <button>상태 변경</button>
</form>
