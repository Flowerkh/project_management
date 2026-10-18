import 'package:flutter/material.dart';
import 'screens/task_list_screen.dart';
import 'screens/task_detail_screen.dart';

void main() => runApp(const FieldApp());

class FieldApp extends StatelessWidget {
  const FieldApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      routes: {
        '/': (context) => const TaskListScreen(),
        '/detail': (context) => const TaskDetailScreen(),
      },
    );
  }
}
