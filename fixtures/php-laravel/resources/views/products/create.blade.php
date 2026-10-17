@extends('layouts.app')
@section('title', '상품 등록')
@section('content')
<form method="POST" action="{{ route('admin.products.store') }}">@csrf<button>저장</button></form>
@endsection
