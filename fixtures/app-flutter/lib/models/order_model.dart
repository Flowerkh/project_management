import 'package:flutter/foundation.dart';
import '../data/order_api.dart';
import 'order.dart';

class OrderModel extends ChangeNotifier {
  final OrderApi _api = OrderApi();
  List<Order> orders = [];

  Future<void> load() async {
    orders = await _api.fetchOrders();
    notifyListeners();
  }
}
