import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../models/order_model.dart';

class OrderListScreen extends StatelessWidget {
  const OrderListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final model = context.watch<OrderModel>();
    return Scaffold(
      appBar: AppBar(title: const Text('주문 내역')),
      body: RefreshIndicator(
        onRefresh: () => context.read<OrderModel>().load(),
        child: ListView(
          children: model.orders.map((o) => ListTile(title: Text(o.status), onTap: () => context.go('/orders/${o.id}'))).toList(),
        ),
      ),
    );
  }
}
