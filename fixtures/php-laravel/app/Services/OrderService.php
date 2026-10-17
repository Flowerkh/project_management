<?php

namespace App\Services;

use App\Models\Order;
use Illuminate\Support\Facades\DB;

class OrderService
{
    public function notify(Order $order): void
    {
        DB::table('notifications')->insert(['order_id' => $order->id, 'type' => 'status']);
    }
}
