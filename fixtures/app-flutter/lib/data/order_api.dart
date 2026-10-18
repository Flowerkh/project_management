import 'api_client.dart';
import '../models/order.dart';

class OrderApi {
  final _dio = ApiClient.dio;

  Future<List<Order>> fetchOrders() async {
    final res = await _dio.get('/orders');
    return (res.data as List).map((e) => Order.fromJson(e)).toList();
  }

  Future<Order> getOrder(String id) async {
    final res = await _dio.get('/orders/$id');
    return Order.fromJson(res.data);
  }

  Future<void> cancel(String id) => _dio.delete('/orders/$id');

  Future<void> create(List<Map<String, Object?>> items) async {
    await _dio.post('/orders', data: {'items': items});
  }
}
