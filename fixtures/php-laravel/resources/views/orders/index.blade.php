@extends('layouts.app')
@section('title', '주문 목록')
@section('content')
<table>
@foreach ($orders as $order)
  <tr><td><a href="{{ route('admin.orders.show', $order) }}">{{ $order->id }}</a></td></tr>
@endforeach
</table>
@endsection
