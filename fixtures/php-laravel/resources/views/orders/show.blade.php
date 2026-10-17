@extends('layouts.app')
@section('title', '주문 상세')
@section('content')
<form method="POST" action="{{ route('admin.orders.update', $order) }}">
  @csrf
  @method('PUT')
  <select name="status"></select>
  <button>저장</button>
</form>
<script>
  fetch(`/api/orders/${orderId}/items`).then(r => r.json());
</script>
@endsection
