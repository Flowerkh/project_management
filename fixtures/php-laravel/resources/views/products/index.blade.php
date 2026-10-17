@extends('layouts.app')
@section('title', '상품 목록')
@section('content')
<a href="{{ route('admin.products.create') }}">등록</a>
@foreach ($products as $p)
<form method="POST" action="{{ route('admin.products.destroy', $p) }}">@csrf @method('DELETE')<button>삭제</button></form>
@endforeach
@endsection
