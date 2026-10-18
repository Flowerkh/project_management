import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shop_flutter/router.dart';
import 'package:shop_flutter/data/api_client.dart';
import 'package:shop_flutter/data/product_repository.dart';
import 'package:shop_flutter/models/order_model.dart';

void main() {
  runApp(
    MultiProvider(
      providers: [
        Provider(create: (_) => ProductRepository(ApiClient.dio)),
        ChangeNotifierProvider(create: (_) => OrderModel()),
      ],
      child: const ShopApp(),
    ),
  );
}

class ShopApp extends StatelessWidget {
  const ShopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(title: '쇼핑', routerConfig: router);
  }
}
