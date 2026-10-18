import 'package:flutter/material.dart';
import '../api/task_api.dart';
import 'task_form_screen.dart';

class TaskListScreen extends StatefulWidget {
  const TaskListScreen({super.key});

  @override
  State<TaskListScreen> createState() => _TaskListScreenState();
}

class _TaskListScreenState extends State<TaskListScreen> {
  final api = TaskApi();
  List<dynamic> tasks = [];

  @override
  void initState() {
    super.initState();
    api.fetchTasks().then((t) => setState(() => tasks = t));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('작업 목록')),
      body: ListView(children: [for (final t in tasks) ListTile(title: Text(t['title']), onTap: () => Navigator.pushNamed(context, '/detail'))]),
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const TaskFormScreen())),
        child: const Icon(Icons.add),
      ),
    );
  }
}
