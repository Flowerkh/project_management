import 'package:flutter/material.dart';
import '../api/task_api.dart';

class TaskDetailScreen extends StatelessWidget {
  const TaskDetailScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final id = ModalRoute.of(context)!.settings.arguments as int;
    return Scaffold(
      appBar: AppBar(title: const Text('작업 상세')),
      body: FutureBuilder(future: TaskApi().getTask(id), builder: (c, s) => Text('${s.data}')),
      floatingActionButton: FloatingActionButton(onPressed: () => TaskApi().complete(id), child: const Icon(Icons.check)),
    );
  }
}
