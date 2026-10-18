import 'package:flutter/material.dart';
import '../api/task_api.dart';

class TaskFormScreen extends StatelessWidget {
  const TaskFormScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('작업 등록')),
      body: ElevatedButton(onPressed: () => TaskApi().create('new'), child: const Text('저장')),
    );
  }
}
