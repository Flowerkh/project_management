@extends('layouts.app')
@section('title', '대시보드')
@section('content')
<h1>오늘 주문 {{ $todayOrders }}건</h1>
@endsection
