import 'package:flutter/material.dart';
import '../db/cart_db.dart';
import '../data/order_api.dart';

class CartScreen extends StatelessWidget {
  const CartScreen({super.key});

  Future<void> _checkout() async {
    final items = await CartDb.instance.items();
    await OrderApi().create(items);
    await CartDb.instance.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('장바구니')),
      floatingActionButton: FloatingActionButton(onPressed: _checkout, child: const Icon(Icons.payment)),
    );
  }
}
