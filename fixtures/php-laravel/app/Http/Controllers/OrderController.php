<?php

namespace App\Http\Controllers;

use App\Models\Order;
use App\Models\OrderHistory;
use App\Services\OrderService;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    public function __construct(private OrderService $orderService)
    {
    }

    /** 주문 목록 */
    public function index(Request $request)
    {
        $orders = Order::with('user')->latest()->paginate(20);
        return view('orders.index', compact('orders'));
    }

    public function show(Order $order)
    {
        $order->load('items');
        return view('orders.show', compact('order'));
    }

    public function update(Request $request, Order $order)
    {
        $order->update(['status' => $request->input('status')]);
        OrderHistory::create(['order_id' => $order->id, 'status' => $order->status]);
        $this->orderService->notify($order);
        return redirect()->route('admin.orders.show', $order);
    }
}
