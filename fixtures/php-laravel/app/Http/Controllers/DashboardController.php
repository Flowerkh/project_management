<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;

class DashboardController extends Controller
{
    public function index()
    {
        $todayOrders = DB::table('orders')->whereDate('created_at', today())->count();
        return view('dashboard', compact('todayOrders'));
    }
}
