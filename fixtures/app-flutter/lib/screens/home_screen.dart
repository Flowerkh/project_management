import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../data/product_repository.dart';
import '../models/product.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<List<Product>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<ProductRepository>().fetchProducts();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('홈')),
      body: FutureBuilder<List<Product>>(
        future: _future,
        builder: (context, snap) => ListView(
          children: [
            for (final p in snap.data ?? <Product>[])
              ListTile(title: Text(p.name), onTap: () => context.push('/products/${p.id}')),
          ],
        ),
      ),
    );
  }
}
