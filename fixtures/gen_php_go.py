#!/usr/bin/env python3
"""PHP·Go 예제 프로젝트 생성 (정답이 알려진 작은 프로젝트들)
사용: python3 fixtures/gen_php_go.py [fixtures]
만드는 것: php-laravel, php-ci3, php-plain, go-gin, go-nethttp
"""
import os
import shutil
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else 'fixtures'


def w(root, path, text, enc='utf-8'):
    p = os.path.join(BASE, root, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding=enc, newline='\n') as f:
        f.write(text.lstrip('\n'))


def reset(root):
    p = os.path.join(BASE, root)
    if os.path.exists(p):
        shutil.rmtree(p)


# ------------------------------------------------------------------ Laravel
def laravel():
    R = 'php-laravel'
    reset(R)
    w(R, 'artisan', '#!/usr/bin/env php\n<?php\nrequire __DIR__."/vendor/autoload.php";\n')
    w(R, 'composer.json', '{\n  "name": "acme/shop",\n  "require": {\n    "php": "^8.1",\n    "laravel/framework": "^10.0"\n  }\n}\n')
    w(R, '.env', 'APP_NAME=Shop\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_DATABASE=shop\n')
    w(R, 'public/index.php', '<?php\nrequire __DIR__."/../vendor/autoload.php";\n$app = require_once __DIR__."/../bootstrap/app.php";\n')
    w(R, 'routes/web.php', '''
<?php

use App\\Http\\Controllers\\DashboardController;
use App\\Http\\Controllers\\OrderController;
use App\\Http\\Controllers\\ProductController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/', [DashboardController::class, 'index'])->name('dashboard');

Route::prefix('admin')->name('admin.')->middleware('auth')->group(function () {
    Route::resource('orders', OrderController::class)->only(['index', 'show', 'update']);
    Route::get('/products', [ProductController::class, 'index'])->name('products.index');
    Route::get('/products/create', [ProductController::class, 'create'])->name('products.create');
    Route::post('/products', [ProductController::class, 'store'])->name('products.store');
    Route::delete('/products/{product}', [ProductController::class, 'destroy'])->name('products.destroy');
});

Route::view('/about', 'pages.about')->name('about');

Route::get('/health', function () {
    return response()->json(['ok' => true]);
});
''')
    w(R, 'routes/api.php', '''
<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('/orders/{order}/items', [App\\Http\\Controllers\\Api\\OrderItemController::class, 'index']);
Route::post('/orders/{order}/status', 'App\\Http\\Controllers\\Api\\OrderStatusController@update');
''')
    w(R, 'app/Http/Controllers/Controller.php', '<?php\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Routing\\Controller as BaseController;\n\nclass Controller extends BaseController\n{\n}\n')
    w(R, 'app/Http/Controllers/DashboardController.php', '''
<?php

namespace App\\Http\\Controllers;

use Illuminate\\Support\\Facades\\DB;

class DashboardController extends Controller
{
    public function index()
    {
        $todayOrders = DB::table('orders')->whereDate('created_at', today())->count();
        return view('dashboard', compact('todayOrders'));
    }
}
''')
    w(R, 'app/Http/Controllers/OrderController.php', '''
<?php

namespace App\\Http\\Controllers;

use App\\Models\\Order;
use App\\Models\\OrderHistory;
use App\\Services\\OrderService;
use Illuminate\\Http\\Request;

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
''')
    w(R, 'app/Http/Controllers/ProductController.php', '''
<?php

namespace App\\Http\\Controllers;

use App\\Models\\Category;
use App\\Models\\Product;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\DB;

class ProductController extends Controller
{
    public function index()
    {
        $products = Product::where('active', 1)->orderBy('name')->get();
        $categories = DB::select('SELECT c.id, c.name FROM categories c ORDER BY c.name');
        return view('products.index', compact('products', 'categories'));
    }

    public function create()
    {
        return view('products.create', ['categories' => Category::all()]);
    }

    public function store(Request $request)
    {
        Product::create($request->all());
        return redirect()->route('admin.products.index');
    }

    public function destroy(Product $product)
    {
        $product->delete();
        return back();
    }
}
''')
    w(R, 'app/Http/Controllers/Api/OrderItemController.php', '''
<?php

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\Order;
use App\\Models\\OrderItem;

class OrderItemController extends Controller
{
    public function index(Order $order)
    {
        return response()->json(OrderItem::where('order_id', $order->id)->get());
    }
}
''')
    w(R, 'app/Http/Controllers/Api/OrderStatusController.php', '''
<?php

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\Order;
use Illuminate\\Http\\Request;

class OrderStatusController extends Controller
{
    public function update(Request $request, $order)
    {
        Order::where('id', $order)->update(['status' => $request->status]);
        return response()->json(['ok' => true]);
    }
}
''')
    w(R, 'app/Services/OrderService.php', '''
<?php

namespace App\\Services;

use App\\Models\\Order;
use Illuminate\\Support\\Facades\\DB;

class OrderService
{
    public function notify(Order $order): void
    {
        DB::table('notifications')->insert(['order_id' => $order->id, 'type' => 'status']);
    }
}
''')
    for cls, table, extra in [
        ('Order', "protected $table = 'orders';", "    public function items()\n    {\n        return $this->hasMany(OrderItem::class);\n    }\n\n    public function user()\n    {\n        return $this->belongsTo(User::class);\n    }\n"),
        ('OrderItem', '', ''),
        ('OrderHistory', "protected $table = 'order_histories';", ''),
        ('Product', "protected $table = 'products';", ''),
        ('Category', '', ''),
        ('User', '', ''),
    ]:
        base = 'Authenticatable' if cls == 'User' else 'Model'
        use = 'Illuminate\\Foundation\\Auth\\User as Authenticatable' if cls == 'User' else 'Illuminate\\Database\\Eloquent\\Model'
        w(R, f'app/Models/{cls}.php', f'<?php\n\nnamespace App\\Models;\n\nuse {use};\n\nclass {cls} extends {base}\n{{\n    {table}\n\n{extra}}}\n')
    w(R, 'resources/views/layouts/app.blade.php', '''
<!DOCTYPE html>
<html lang="ko">
<head><title>@yield('title') - 쇼핑몰 관리자</title></head>
<body>
@include('partials.nav')
<main>@yield('content')</main>
</body>
</html>
''')
    w(R, 'resources/views/partials/nav.blade.php', '''
<nav>
  <a href="{{ route('dashboard') }}">대시보드</a>
  <a href="{{ route('admin.orders.index') }}">주문</a>
  <a href="{{ route('admin.products.index') }}">상품</a>
</nav>
''')
    w(R, 'resources/views/dashboard.blade.php', '''
@extends('layouts.app')
@section('title', '대시보드')
@section('content')
<h1>오늘 주문 {{ $todayOrders }}건</h1>
@endsection
''')
    w(R, 'resources/views/orders/index.blade.php', '''
@extends('layouts.app')
@section('title', '주문 목록')
@section('content')
<table>
@foreach ($orders as $order)
  <tr><td><a href="{{ route('admin.orders.show', $order) }}">{{ $order->id }}</a></td></tr>
@endforeach
</table>
@endsection
''')
    w(R, 'resources/views/orders/show.blade.php', '''
@extends('layouts.app')
@section('title', '주문 상세')
@section('content')
<form method="POST" action="{{ route('admin.orders.update', $order) }}">
  @csrf
  @method('PUT')
  <select name="status"></select>
  <button>저장</button>
</form>
<script>
  fetch(`/api/orders/${orderId}/items`).then(r => r.json());
</script>
@endsection
''')
    w(R, 'resources/views/products/index.blade.php', '''
@extends('layouts.app')
@section('title', '상품 목록')
@section('content')
<a href="{{ route('admin.products.create') }}">등록</a>
@foreach ($products as $p)
<form method="POST" action="{{ route('admin.products.destroy', $p) }}">@csrf @method('DELETE')<button>삭제</button></form>
@endforeach
@endsection
''')
    w(R, 'resources/views/products/create.blade.php', '''
@extends('layouts.app')
@section('title', '상품 등록')
@section('content')
<form method="POST" action="{{ route('admin.products.store') }}">@csrf<button>저장</button></form>
@endsection
''')
    w(R, 'resources/views/pages/about.blade.php', '@extends(\'layouts.app\')\n@section(\'title\', \'소개\')\n@section(\'content\')<p>소개</p>@endsection\n')
    for i, (table, cols, cmt) in enumerate([
        ('orders', ["$table->id();", "$table->foreignId('user_id')->comment('회원');", "$table->string('status', 20)->comment('주문 상태');", "$table->timestamps();"], '주문'),
        ('order_items', ["$table->id();", "$table->foreignId('order_id');", "$table->foreignId('product_id');", "$table->integer('qty');"], '주문 상품'),
        ('order_histories', ["$table->id();", "$table->foreignId('order_id');", "$table->string('status');", "$table->timestamps();"], '주문 상태 이력'),
        ('products', ["$table->id();", "$table->string('name')->comment('상품명');", "$table->boolean('active')->default(true);", "$table->decimal('price', 10, 2);"], '상품'),
        ('categories', ["$table->id();", "$table->string('name');"], '카테고리'),
        ('notifications', ["$table->id();", "$table->foreignId('order_id');", "$table->string('type');"], '알림'),
    ], 1):
        body = '\n            '.join(cols + [f"$table->comment('{cmt}');"])
        w(R, f'database/migrations/2024_01_01_00000{i}_create_{table}_table.php', f'''
<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{{
    public function up(): void
    {{
        Schema::create('{table}', function (Blueprint $table) {{
            {body}
        }});
    }}
}};
''')


# ------------------------------------------------------------------ CodeIgniter 3
def ci3():
    R = 'php-ci3'
    reset(R)
    w(R, 'index.php', "<?php\ndefine('ENVIRONMENT', 'production');\n$system_path = 'system';\nrequire_once BASEPATH.'core/CodeIgniter.php';\n")
    w(R, 'system/core/CodeIgniter.php', "<?php\nclass CI_Controller { public function __construct() {} }\n$x = \"SELECT * FROM information_schema.tables\";\n")
    w(R, 'application/config/database.php', "<?php\n$db['default'] = array('hostname' => 'localhost', 'database' => 'shop');\n$db['default']['dbdriver'] = 'mysqli';\n")
    w(R, 'application/config/routes.php', "<?php\n$route['default_controller'] = 'dashboard';\n$route['orders/(:num)'] = 'order/detail/$1';\n$route['404_override'] = '';\n")
    w(R, 'application/controllers/Dashboard.php', '''
<?php
class Dashboard extends CI_Controller
{
    public function index()
    {
        $data['count'] = $this->db->count_all('orders');
        $this->load->view('templates/header');
        $this->load->view('dashboard', $data);
        $this->load->view('templates/footer');
    }
}
''')
    w(R, 'application/controllers/Order.php', '''
<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class Order extends CI_Controller
{
    public function __construct()
    {
        parent::__construct();
        $this->load->model('order_model');
    }

    public function index()
    {
        $data['orders'] = $this->order_model->get_list();
        $this->load->view('templates/header');
        $this->load->view('order/list', $data);
        $this->load->view('templates/footer');
    }

    public function detail($id)
    {
        $data['order'] = $this->order_model->get($id);
        $this->load->model('Member_model', 'member');
        $data['member'] = $this->member->get_member($data['order']->member_id);
        $this->load->view('templates/header');
        $this->load->view('order/detail', $data);
        $this->load->view('templates/footer');
    }

    public function update_status()
    {
        $id = $this->input->post('id');
        $this->order_model->update_status($id, $this->input->post('status'));
        $this->order_model->add_history($id);
        redirect('order/detail/' . $id);
    }

    private function _check() {}
}
''')
    w(R, 'application/models/Order_model.php', '''
<?php
class Order_model extends CI_Model
{
    public function get_list()
    {
        $this->db->select('o.*, m.name');
        $this->db->from('orders o');
        $this->db->join('members m', 'm.id = o.member_id');
        return $this->db->get()->result();
    }

    public function get($id)
    {
        return $this->db->get_where('orders', array('id' => $id))->row();
    }

    public function update_status($id, $status)
    {
        $this->db->where('id', $id);
        $this->db->update('orders', array('status' => $status));
    }

    public function add_history($id)
    {
        $this->db->insert('order_history', array('order_id' => $id));
    }
}
''')
    w(R, 'application/models/Member_model.php', '''
<?php
class Member_model extends CI_Model
{
    public function get_member($id)
    {
        return $this->db->query("SELECT * FROM members WHERE id = ?", array($id))->row();
    }
}
''')
    w(R, 'application/views/templates/header.php', '<html><head><title>쇼핑몰 관리</title></head><body>\n<a href="<?= site_url(\'order\') ?>">주문</a>\n')
    w(R, 'application/views/templates/footer.php', '</body></html>\n')
    w(R, 'application/views/dashboard.php', '<h2>대시보드</h2>\n<p><?= $count ?></p>\n')
    w(R, 'application/views/order/list.php', '''
<h2>주문 목록</h2>
<table>
<?php foreach ($orders as $o): ?>
  <tr><td><a href="<?= site_url('order/detail/'.$o->id) ?>"><?= $o->id ?></a></td></tr>
<?php endforeach; ?>
</table>
''')
    w(R, 'application/views/order/detail.php', '''
<h2>주문 상세</h2>
<?= form_open('order/update_status') ?>
  <input type="hidden" name="id" value="<?= $order->id ?>">
  <button>상태 변경</button>
</form>
''')
    w(R, 'database/schema.sql', '''
CREATE TABLE members (
  id INT NOT NULL AUTO_INCREMENT COMMENT '회원 번호',
  name VARCHAR(50) NOT NULL COMMENT '이름',
  PRIMARY KEY (id)
) ENGINE=InnoDB COMMENT='회원';

CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT COMMENT '주문 번호',
  member_id INT NOT NULL COMMENT '회원 번호',
  status VARCHAR(20) COMMENT '상태',
  PRIMARY KEY (id)
) ENGINE=InnoDB COMMENT='주문';

CREATE TABLE order_history (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  PRIMARY KEY (id)
) COMMENT='주문 이력';
''')


# ------------------------------------------------------------------ 순수 PHP
def plain():
    R = 'php-plain'
    reset(R)
    w(R, 'inc/db.php', "<?php\n$conn = mysqli_connect('localhost', 'app', '****', 'shop');\nmysqli_set_charset($conn, 'utf8mb4');\n")
    w(R, 'inc/header.php', '<html><head><meta charset="utf-8"><title>주문 관리</title></head><body>\n<ul class="menu"><li><a href="/order/list.php">주문 목록</a></li></ul>\n')
    w(R, 'inc/footer.php', '</body></html>\n')
    w(R, 'lib/functions.php', '''
<?php
function get_customer_name($conn, $id)
{
    $r = mysqli_query($conn, "SELECT name FROM customers WHERE id = " . intval($id));
    $row = mysqli_fetch_assoc($r);
    return $row['name'];
}
''')
    w(R, 'index.php', '''
<?php include 'inc/db.php'; include 'inc/header.php'; ?>
<h1>관리자 메인</h1>
<p>오늘 주문: <span id="cnt"></span></p>
<a href="order/list.php">주문 목록</a>
<script>
$.get('ajax/order_count.php', function (d) { $('#cnt').text(d.count); });
</script>
<?php include 'inc/footer.php'; ?>
''')
    w(R, 'order/list.php', '''
<?php
include '../inc/db.php';
$status = $_GET['status'] ?? '';
$sql = "SELECT o.id, o.status, c.name FROM orders o JOIN customers c ON o.customer_id = c.id";
if ($status) {
    $sql .= " WHERE o.status = '" . mysqli_real_escape_string($conn, $status) . "'";
}
$res = mysqli_query($conn, $sql);
include '../inc/header.php';
?>
<h2>주문 목록</h2>
<table>
<?php while ($row = mysqli_fetch_assoc($res)) { ?>
  <tr><td><a href="view.php?id=<?= $row['id'] ?>"><?= $row['id'] ?></a></td><td><?= $row['name'] ?></td></tr>
<?php } ?>
</table>
<?php include '../inc/footer.php'; ?>
''', enc='euc-kr')
    w(R, 'order/view.php', '''
<?php
include '../inc/db.php';
include '../lib/functions.php';
$id = intval($_GET['id']);
$order = mysqli_fetch_assoc(mysqli_query($conn, "SELECT * FROM orders WHERE id = $id"));
$items = mysqli_query($conn, "SELECT * FROM order_items WHERE order_id = $id");
$customer = get_customer_name($conn, $order['customer_id']);
include '../inc/header.php';
?>
<h2>주문 상세</h2>
<form method="post" action="save.php">
  <input type="hidden" name="id" value="<?= $id ?>">
  <select name="status"><option>DONE</option></select>
  <button type="submit">저장</button>
</form>
<?php
echo "<a href='list.php'>목록</a>";
include '../inc/footer.php';
''')
    w(R, 'order/save.php', '''
<?php
include '../inc/db.php';
$id = intval($_POST['id']);
$status = mysqli_real_escape_string($conn, $_POST['status']);
mysqli_query($conn, "UPDATE orders SET status = '$status' WHERE id = $id");
mysqli_query($conn, "INSERT INTO order_logs (order_id, status, created_at) VALUES ($id, '$status', NOW())");
header('Location: view.php?id=' . $id);
''')
    w(R, 'ajax/order_count.php', '''
<?php
include '../inc/db.php';
$r = mysqli_query($conn, "SELECT COUNT(*) AS cnt FROM orders WHERE DATE(created_at) = CURDATE()");
header('Content-Type: application/json');
echo json_encode(['count' => mysqli_fetch_assoc($r)['cnt']]);
''')
    w(R, 'schema.sql', '''
CREATE TABLE customers (
  id INT NOT NULL AUTO_INCREMENT COMMENT '고객 번호',
  name VARCHAR(50) COMMENT '고객명',
  PRIMARY KEY (id)
) COMMENT='고객';
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT,
  customer_id INT,
  status VARCHAR(20),
  created_at DATETIME,
  PRIMARY KEY (id)
) COMMENT='주문';
CREATE TABLE order_items (id INT NOT NULL, order_id INT, PRIMARY KEY (id)) COMMENT='주문 상품';
CREATE TABLE order_logs (id INT NOT NULL AUTO_INCREMENT, order_id INT, status VARCHAR(20), created_at DATETIME, PRIMARY KEY (id)) COMMENT='주문 처리 로그';
''')


# ------------------------------------------------------------------ Go + Gin + GORM
def go_gin():
    R = 'go-gin'
    reset(R)
    w(R, 'go.mod', '''
module example.com/shop-api

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	gorm.io/driver/mysql v1.5.2
	gorm.io/gorm v1.25.5
)
''')
    w(R, 'main.go', '''
package main

import (
	"example.com/shop-api/handler"
	"example.com/shop-api/repository"
	"example.com/shop-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func main() {
	db, _ := gorm.Open(mysql.Open("app:pass@tcp(db:3306)/shop"), &gorm.Config{})
	repo := repository.NewOrderRepository(db)
	svc := service.NewOrderService(repo)
	h := handler.NewOrderHandler(svc)

	r := gin.Default()
	r.LoadHTMLGlob("templates/**/*")
	r.GET("/", handler.Home)

	api := r.Group("/api")
	{
		v1 := api.Group("/v1")
		v1.GET("/orders", h.ListOrders)
		v1.GET("/orders/:id", h.GetOrder)
		v1.POST("/orders", h.CreateOrder)
		v1.DELETE("/orders/:id", h.DeleteOrder)
		v1.GET("/stats", func(c *gin.Context) {
			var n int64
			db.Table("tb_order").Count(&n)
			c.JSON(200, gin.H{"count": n})
		})
	}
	admin := r.Group("/admin")
	admin.GET("/orders", h.OrderPage)
	r.Run(":8080")
}
''')
    w(R, 'handler/order.go', '''
package handler

import (
	"net/http"
	"strconv"

	"example.com/shop-api/model"
	"example.com/shop-api/service"
	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	svc *service.OrderService
}

func NewOrderHandler(s *service.OrderService) *OrderHandler {
	return &OrderHandler{svc: s}
}

// ListOrders 주문 목록 API
func (h *OrderHandler) ListOrders(c *gin.Context) {
	orders, _ := h.svc.List()
	c.JSON(http.StatusOK, orders)
}

func (h *OrderHandler) GetOrder(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	o, _ := h.svc.Get(uint(id))
	c.JSON(http.StatusOK, o)
}

func (h *OrderHandler) CreateOrder(c *gin.Context) {
	var o model.Order
	_ = c.ShouldBindJSON(&o)
	_ = h.svc.Create(&o)
	c.JSON(http.StatusCreated, o)
}

func (h *OrderHandler) DeleteOrder(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	_ = h.svc.Delete(uint(id))
	c.Status(http.StatusNoContent)
}

// OrderPage 주문 관리 화면
func (h *OrderHandler) OrderPage(c *gin.Context) {
	orders, _ := h.svc.List()
	c.HTML(http.StatusOK, "orders/list.html", gin.H{"orders": orders})
}
''')
    w(R, 'handler/home.go', '''
package handler

import "github.com/gin-gonic/gin"

func Home(c *gin.Context) {
	c.HTML(200, "home.html", nil)
}
''')
    w(R, 'service/order.go', '''
package service

import (
	"example.com/shop-api/model"
	"example.com/shop-api/repository"
)

type OrderService struct {
	repo *repository.OrderRepository
}

func NewOrderService(r *repository.OrderRepository) *OrderService {
	return &OrderService{repo: r}
}

func (s *OrderService) List() ([]model.Order, error) { return s.repo.FindAll() }

func (s *OrderService) Get(id uint) (*model.Order, error) { return s.repo.FindByID(id) }

func (s *OrderService) Create(o *model.Order) error { return s.repo.Create(o) }

func (s *OrderService) Delete(id uint) error { return s.repo.Delete(id) }
''')
    w(R, 'repository/order.go', '''
package repository

import (
	"example.com/shop-api/model"
	"gorm.io/gorm"
)

type OrderRepository struct {
	db *gorm.DB
}

func NewOrderRepository(db *gorm.DB) *OrderRepository { return &OrderRepository{db: db} }

func (r *OrderRepository) FindAll() ([]model.Order, error) {
	var orders []model.Order
	err := r.db.Preload("Items").Order("id desc").Find(&orders).Error
	return orders, err
}

func (r *OrderRepository) FindByID(id uint) (*model.Order, error) {
	var o model.Order
	err := r.db.First(&o, id).Error
	return &o, err
}

func (r *OrderRepository) Create(o *model.Order) error {
	return r.db.Create(o).Error
}

func (r *OrderRepository) Delete(id uint) error {
	if err := r.db.Where("order_id = ?", id).Delete(&model.OrderItem{}).Error; err != nil {
		return err
	}
	return r.db.Delete(&model.Order{}, id).Error
}

func (r *OrderRepository) StatusCounts() ([]map[string]any, error) {
	var out []map[string]any
	err := r.db.Raw("SELECT status, COUNT(*) AS cnt FROM tb_order GROUP BY status").Scan(&out).Error
	return out, err
}
''')
    w(R, 'model/order.go', '''
package model

import "time"

type Order struct {
	ID        uint `gorm:"primaryKey"`
	Status    string
	Items     []OrderItem
	CreatedAt time.Time
}

func (Order) TableName() string { return "tb_order" }

type OrderItem struct {
	ID      uint
	OrderID uint
	Qty     int
}
''')
    w(R, 'templates/orders/list.html', '''
<!DOCTYPE html>
<html><head><title>주문 목록</title></head>
<body>
{{template "nav.html" .}}
<table id="orders"></table>
<script>
fetch('/api/v1/orders').then(r => r.json()).then(render);
function del(id) { fetch('/api/v1/orders/' + id, { method: 'DELETE' }); }
</script>
</body></html>
''')
    w(R, 'templates/home.html', '<html><head><title>홈</title></head><body>{{template "nav.html" .}}<a href="/admin/orders">주문 관리</a></body></html>\n')
    w(R, 'templates/nav.html', '{{define "nav.html"}}<nav><a href="/">홈</a> <a href="/admin/orders">주문</a></nav>{{end}}\n')
    w(R, 'schema.sql', '''
CREATE TABLE tb_order (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '주문 번호',
  status VARCHAR(20) COMMENT '상태',
  created_at DATETIME,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='주문';

CREATE TABLE order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL COMMENT '주문 번호',
  qty INT,
  PRIMARY KEY (id)
) COMMENT='주문 상품';
''')


# ------------------------------------------------------------------ Go net/http + database/sql
def go_nethttp():
    R = 'go-nethttp'
    reset(R)
    w(R, 'go.mod', 'module example.com/board\n\ngo 1.22\n\nrequire github.com/go-sql-driver/mysql v1.7.1\n')
    w(R, 'main.go', '''
package main

import (
	"database/sql"
	"html/template"
	"log"
	"net/http"

	_ "github.com/go-sql-driver/mysql"
)

var (
	db   *sql.DB
	tmpl = template.Must(template.ParseGlob("templates/*.gohtml"))
)

func main() {
	var err error
	db, err = sql.Open("mysql", "app:pass@tcp(db:3306)/board")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/posts", listPosts)
	mux.HandleFunc("/posts/view", viewPost)
	mux.HandleFunc("POST /posts/save", savePost)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	log.Fatal(http.ListenAndServe(":8080", mux))
}
''')
    w(R, 'queries.go', '''
package main

const queryListPosts = `
SELECT p.id, p.title, u.name
  FROM posts p
  JOIN users u ON p.user_id = u.id
 ORDER BY p.id DESC`
''')
    w(R, 'handlers.go', '''
package main

import "net/http"

// listPosts 게시글 목록
func listPosts(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(queryListPosts)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	tmpl.ExecuteTemplate(w, "list.gohtml", rows)
}

func viewPost(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	row := db.QueryRow("SELECT id, title, body FROM posts WHERE id = ?", id)
	comments, _ := db.Query(`SELECT c.id, c.body FROM comments c WHERE c.post_id = ?`, id)
	_ = comments
	tmpl.ExecuteTemplate(w, "view.gohtml", row)
}

func savePost(w http.ResponseWriter, r *http.Request) {
	res, _ := db.Exec("INSERT INTO posts (title, body, user_id) VALUES (?, ?, ?)", r.FormValue("title"), r.FormValue("body"), 1)
	_ = res
	db.Exec(`UPDATE boards SET post_count = post_count + 1 WHERE id = ?`, r.FormValue("board"))
	http.Redirect(w, r, "/posts", http.StatusSeeOther)
}
''')
    w(R, 'templates/header.gohtml', '{{define "header"}}<html><head><title>{{.Title}}</title></head><body>{{end}}\n')
    w(R, 'templates/list.gohtml', '''
{{template "header" .}}
<h1>게시글 목록</h1>
<ul>{{range .}}<li><a href="/posts/view?id={{.ID}}">{{.Title}}</a></li>{{end}}</ul>
</body></html>
''')
    w(R, 'templates/view.gohtml', '''
{{template "header" .}}
<h1>게시글 보기</h1>
<form method="post" action="/posts/save">
  <input name="title"><textarea name="body"></textarea>
  <button>저장</button>
</form>
</body></html>
''')
    w(R, 'schema.sql', '''
CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(50), PRIMARY KEY (id)) COMMENT='사용자';
CREATE TABLE boards (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(50), post_count INT DEFAULT 0, PRIMARY KEY (id)) COMMENT='게시판';
CREATE TABLE posts (id INT NOT NULL AUTO_INCREMENT, user_id INT, title VARCHAR(200), body TEXT, PRIMARY KEY (id)) COMMENT='게시글';
CREATE TABLE comments (id INT NOT NULL AUTO_INCREMENT, post_id INT, body TEXT, PRIMARY KEY (id)) COMMENT='댓글';
''')


# ------------------------------------------------------------------ Go chi + sqlx (패키지별 도메인, 인터페이스, Mount)
def go_chi():
    R = 'go-chi'
    reset(R)
    w(R, 'go.mod', '''
module example.com/member-admin

go 1.22

require (
	github.com/go-chi/chi/v5 v5.0.12
	github.com/go-sql-driver/mysql v1.7.1
	github.com/jmoiron/sqlx v1.3.5
)
''')
    w(R, 'cmd/server/main.go', '''
package main

import (
	"html/template"
	"log"
	"net/http"

	"example.com/member-admin/internal/api"
	"example.com/member-admin/internal/member"
	"example.com/member-admin/internal/order"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	_ "github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
)

func main() {
	db := sqlx.MustConnect("mysql", "app:pass@tcp(db:3306)/members")
	tmpl := template.Must(template.ParseGlob("web/templates/*.html"))

	memberSvc := member.NewService(member.NewMySQLRepository(db))
	h := member.NewHandler(memberSvc, tmpl)
	orderSvc := order.NewService(order.NewRepository(db))

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Get("/", h.Home)
	r.Route("/members", func(r chi.Router) {
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Route("/{id:[0-9]+}", func(r chi.Router) {
			r.Get("/", h.Detail)
			r.Put("/", h.Update)
		})
	})
	r.Mount("/admin", adminRouter(h))
	api.Register(r, orderSvc)
	log.Fatal(http.ListenAndServe(":8080", r))
}

func adminRouter(h *member.Handler) http.Handler {
	r := chi.NewRouter()
	r.Get("/members/stats", h.Stats)
	return r
}
''')
    w(R, 'internal/member/model.go', '''
package member

type Member struct {
	ID    int64  `db:"id"`
	Name  string `db:"name"`
	Email string `db:"email"`
}
''')
    w(R, 'internal/member/service.go', '''
package member

import "context"

// Service 회원 업무
type Service interface {
	List(ctx context.Context) ([]Member, error)
	Get(ctx context.Context, id int64) (*Member, error)
	Save(ctx context.Context, m *Member) error
	Stats(ctx context.Context) (int, error)
}

type service struct {
	repo Repository
}

func NewService(r Repository) Service { return &service{repo: r} }

func (s *service) List(ctx context.Context) ([]Member, error) { return s.repo.FindAll(ctx) }

func (s *service) Get(ctx context.Context, id int64) (*Member, error) { return s.repo.FindByID(ctx, id) }

func (s *service) Save(ctx context.Context, m *Member) error {
	if m.ID == 0 {
		return s.repo.Insert(ctx, m)
	}
	if err := s.repo.Update(ctx, m); err != nil {
		return err
	}
	return s.repo.WriteLog(ctx, m.ID, "update")
}

func (s *service) Stats(ctx context.Context) (int, error) { return s.repo.Count(ctx) }
''')
    w(R, 'internal/member/repository.go', '''
package member

import (
	"context"

	"github.com/jmoiron/sqlx"
)

type Repository interface {
	FindAll(ctx context.Context) ([]Member, error)
	FindByID(ctx context.Context, id int64) (*Member, error)
	Insert(ctx context.Context, m *Member) error
	Update(ctx context.Context, m *Member) error
	WriteLog(ctx context.Context, id int64, action string) error
	Count(ctx context.Context) (int, error)
}

type mysqlRepository struct {
	db *sqlx.DB
}

func NewMySQLRepository(db *sqlx.DB) Repository { return &mysqlRepository{db: db} }

func (r *mysqlRepository) FindAll(ctx context.Context) ([]Member, error) {
	var out []Member
	err := r.db.SelectContext(ctx, &out, queryListMembers)
	return out, err
}

func (r *mysqlRepository) FindByID(ctx context.Context, id int64) (*Member, error) {
	var m Member
	err := r.db.GetContext(ctx, &m, "SELECT id, name, email FROM members WHERE id = ?", id)
	return &m, err
}

func (r *mysqlRepository) Insert(ctx context.Context, m *Member) error {
	_, err := r.db.NamedExecContext(ctx, "INSERT INTO members (name, email) VALUES (:name, :email)", m)
	return err
}

func (r *mysqlRepository) Update(ctx context.Context, m *Member) error {
	_, err := r.db.ExecContext(ctx, `UPDATE members SET name = ?, email = ? WHERE id = ?`, m.Name, m.Email, m.ID)
	return err
}

func (r *mysqlRepository) WriteLog(ctx context.Context, id int64, action string) error {
	_, err := r.db.ExecContext(ctx, "INSERT INTO member_logs (member_id, action) VALUES (?, ?)", id, action)
	return err
}

func (r *mysqlRepository) Count(ctx context.Context) (int, error) {
	var n int
	err := r.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM members")
	return n, err
}
''')
    w(R, 'internal/member/fake.go', '''
package member

import "context"

// 개발용 가짜 저장소 (구현체 후보에서 빠져야 함)
type fakeRepository struct{}

func (fakeRepository) FindAll(ctx context.Context) ([]Member, error)            { return nil, nil }
func (fakeRepository) FindByID(ctx context.Context, id int64) (*Member, error)  { return nil, nil }
func (fakeRepository) Insert(ctx context.Context, m *Member) error              { return nil }
func (fakeRepository) Update(ctx context.Context, m *Member) error              { return nil }
func (fakeRepository) WriteLog(ctx context.Context, id int64, a string) error   { return nil }
func (fakeRepository) Count(ctx context.Context) (int, error)                   { return 0, nil }
''')
    w(R, 'internal/member/queries.go', '''
package member

const queryListMembers = `SELECT m.id, m.name, m.email, g.name AS grade
  FROM members m
  LEFT JOIN member_grades g ON g.id = m.grade_id
 ORDER BY m.id DESC`
''')
    w(R, 'internal/member/handler.go', '''
package member

import (
	"html/template"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	svc  Service
	tmpl *template.Template
}

func NewHandler(svc Service, tmpl *template.Template) *Handler { return &Handler{svc: svc, tmpl: tmpl} }

func (h *Handler) render(w http.ResponseWriter, name string, data any) {
	if err := h.tmpl.ExecuteTemplate(w, name+".html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// Home 첫 화면
func (h *Handler) Home(w http.ResponseWriter, r *http.Request) {
	h.render(w, "home", nil)
}

// List 회원 목록
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	members, _ := h.svc.List(r.Context())
	h.render(w, "member_list", members)
}

func (h *Handler) Detail(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	m, _ := h.svc.Get(r.Context(), id)
	h.render(w, "member_detail", m)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	m := &Member{Name: r.FormValue("name"), Email: r.FormValue("email")}
	_ = h.svc.Save(r.Context(), m)
	http.Redirect(w, r, "/members", http.StatusSeeOther)
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	_ = h.svc.Save(r.Context(), &Member{ID: id, Name: r.FormValue("name")})
	w.WriteHeader(http.StatusNoContent)
}

// Stats 관리자 회원 통계
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	n, _ := h.svc.Stats(r.Context())
	w.Write([]byte(strconv.Itoa(n)))
}
''')
    w(R, 'internal/order/order.go', '''
package order

import "github.com/jmoiron/sqlx"

// Service 주문 업무 (회원 패키지와 같은 이름의 타입: 섞이면 안 됨)
type Service interface {
	List() ([]Order, error)
}

type Order struct {
	ID     int64
	Status string
}

type Repository struct {
	db *sqlx.DB
}

func NewRepository(db *sqlx.DB) *Repository { return &Repository{db: db} }

func (r *Repository) Find() ([]Order, error) {
	var out []Order
	err := r.db.Select(&out, "SELECT id, status FROM orders ORDER BY id DESC")
	return out, err
}

type service struct {
	repo *Repository
}

func NewService(r *Repository) Service { return &service{repo: r} }

func (s *service) List() ([]Order, error) { return s.repo.Find() }
''')
    w(R, 'internal/api/routes.go', '''
package api

import (
	"encoding/json"
	"net/http"

	"example.com/member-admin/internal/order"
	"github.com/go-chi/chi/v5"
)

// Register API 라우트
func Register(r chi.Router, svc order.Service) {
	r.Route("/api", func(r chi.Router) {
		r.Get("/orders", listOrders(svc))
	})
}

func listOrders(svc order.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orders, _ := svc.List()
		json.NewEncoder(w).Encode(orders)
	}
}
''')
    w(R, 'web/templates/nav.html', '{{define "nav"}}<nav><a href="/">홈</a> <a href="/members">회원</a></nav>{{end}}\n')
    w(R, 'web/templates/home.html', '''
<html><head><title>회원 관리</title></head>
<body>{{template "nav" .}}<a href="/members">회원 목록</a></body></html>
''')
    w(R, 'web/templates/member_list.html', '''
<html><head><title>회원 목록</title></head>
<body>{{template "nav" .}}
<ul>{{range .}}<li><a href="/members/{{.ID}}">{{.Name}}</a></li>{{end}}</ul>
<form method="post" action="/members"><input name="name"><input name="email"><button>등록</button></form>
</body></html>
''')
    w(R, 'web/templates/member_detail.html', '''
<html><head><title>회원 상세</title></head>
<body>{{template "nav" .}}
<input id="name" value="{{.Name}}">
<script>
function save(id) {
  fetch('/members/' + id, { method: 'PUT', body: new FormData() });
}
</script>
</body></html>
''')
    w(R, 'schema.sql', '''
CREATE TABLE member_grades (id INT NOT NULL, name VARCHAR(20), PRIMARY KEY (id)) COMMENT='회원 등급';
CREATE TABLE members (id BIGINT NOT NULL AUTO_INCREMENT, grade_id INT, name VARCHAR(50), email VARCHAR(100), PRIMARY KEY (id)) COMMENT='회원';
CREATE TABLE member_logs (id BIGINT NOT NULL AUTO_INCREMENT, member_id BIGINT, action VARCHAR(20), PRIMARY KEY (id)) COMMENT='회원 변경 이력';
CREATE TABLE orders (id BIGINT NOT NULL AUTO_INCREMENT, status VARCHAR(20), PRIMARY KEY (id)) COMMENT='주문';
''')


if __name__ == '__main__':
    os.makedirs(BASE, exist_ok=True)
    laravel()
    ci3()
    plain()
    go_gin()
    go_nethttp()
    go_chi()
    print('generated: php-laravel, php-ci3, php-plain, go-gin, go-nethttp, go-chi')
