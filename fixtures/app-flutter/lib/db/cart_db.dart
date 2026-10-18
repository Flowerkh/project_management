import 'package:sqflite/sqflite.dart';

class CartDb {
  CartDb._();
  static final CartDb instance = CartDb._();
  static const table = 'cart_items';
  Database? _db;

  Future<Database> get database async {
    _db ??= await openDatabase('cart.db', version: 1, onCreate: (db, version) async {
      await db.execute('CREATE TABLE cart_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, qty INTEGER NOT NULL)');
    });
    return _db!;
  }

  Future<void> add(int productId, int qty) async {
    final db = await database;
    await db.insert(table, {'product_id': productId, 'qty': qty});
  }

  Future<List<Map<String, Object?>>> items() async {
    final db = await database;
    return db.query(table, orderBy: 'id');
  }

  Future<void> clear() async {
    final db = await database;
    await db.delete(table);
  }
}
