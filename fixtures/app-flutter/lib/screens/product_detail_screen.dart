import 'package:flutter/material.dart';
import 'package:flutter_gen/gen_l10n/app_localizations.dart';
import '../db/cart_db.dart';

class ProductDetailScreen extends StatelessWidget {
  final int id;
  const ProductDetailScreen({super.key, required this.id});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(AppLocalizations.of(context)!.productDetail)),
      body: ElevatedButton(
        onPressed: () => CartDb.instance.add(id, 1),
        child: const Text('장바구니 담기'),
      ),
    );
  }
}
