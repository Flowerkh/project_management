<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Order;
use Illuminate\Http\Request;

class OrderStatusController extends Controller
{
    public function update(Request $request, $order)
    {
        Order::where('id', $order)->update(['status' => $request->status]);
        return response()->json(['ok' => true]);
    }
}
