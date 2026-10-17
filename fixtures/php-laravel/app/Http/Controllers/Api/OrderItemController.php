<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Order;
use App\Models\OrderItem;

class OrderItemController extends Controller
{
    public function index(Order $order)
    {
        return response()->json(OrderItem::where('order_id', $order->id)->get());
    }
}
