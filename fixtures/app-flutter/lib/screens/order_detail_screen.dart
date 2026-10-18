import 'package:flutter/material.dart';
import '../data/order_api.dart';
import '../models/order.dart';

class OrderDetailScreen extends StatefulWidget {
  final String id;
  const OrderDetailScreen({super.key, required this.id});

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  final _api = OrderApi();
  Order? _order;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final o = await _api.getOrder(widget.id);
    setState(() => _order = o);
  }

  Future<void> _cancel() async {
    await _api.cancel(widget.id);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('주문 상세')),
      body: TextButton(onPressed: _cancel, child: Text(_order?.status ?? '')),
    );
  }
}
