<?php

use Illuminate\Support\Facades\Route;

Route::get('/orders/{order}/items', [App\Http\Controllers\Api\OrderItemController::class, 'index']);
Route::post('/orders/{order}/status', 'App\Http\Controllers\Api\OrderStatusController@update');
