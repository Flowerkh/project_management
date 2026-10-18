import 'package:dio/dio.dart';
import '../models/product.dart';

class ProductRepository {
  final Dio _dio;
  ProductRepository(this._dio);

  Future<List<Product>> fetchProducts() async {
    final res = await _dio.get('/products');
    return (res.data as List).map((e) => Product.fromJson(e)).toList();
  }
}
