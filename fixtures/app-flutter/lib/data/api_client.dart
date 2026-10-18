import 'package:dio/dio.dart';

class ApiClient {
  static const baseUrl = 'https://api.example.com/api';
  static final Dio dio = Dio(BaseOptions(baseUrl: baseUrl, connectTimeout: const Duration(seconds: 5)));
}
