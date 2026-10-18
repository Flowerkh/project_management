import 'package:go_router/go_router.dart';
import 'screens/main_shell.dart';
import 'screens/product_detail_screen.dart';
import 'screens/order_list_screen.dart';
import 'screens/order_detail_screen.dart';

final router = GoRouter(
  initialLocation: '/home',
  routes: [
    GoRoute(path: '/home', builder: (context, state) => const MainShell()),
    GoRoute(
      path: '/products/:id',
      builder: (context, state) => ProductDetailScreen(id: int.parse(state.pathParameters['id']!)),
    ),
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrderListScreen(),
      routes: [
        GoRoute(
          path: ':id',
          builder: (context, state) => OrderDetailScreen(id: state.pathParameters['id']!),
        ),
      ],
    ),
  ],
);
