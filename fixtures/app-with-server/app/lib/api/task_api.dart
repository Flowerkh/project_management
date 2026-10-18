import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';

class TaskApi {
  Future<List<dynamic>> fetchTasks() async {
    final res = await http.get(Uri.parse('$kBaseUrl/tasks'));
    return jsonDecode(res.body);
  }

  Future<Map<String, dynamic>> getTask(int id) async {
    final res = await http.get(Uri.parse('$kBaseUrl/tasks/$id'));
    return jsonDecode(res.body);
  }

  Future<void> create(String title) async {
    final uri = Uri.parse('$kBaseUrl/tasks');
    await http.post(uri, body: jsonEncode({'title': title}));
  }

  Future<void> complete(int id) async {
    await http.put(Uri.parse('$kBaseUrl/tasks/$id/complete'));
  }
}
