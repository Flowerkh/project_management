import SQLite from 'react-native-sqlite-storage';

const db = SQLite.openDatabase({ name: 'cart.db', location: 'default' });
const TABLE = 'cart_items';

export function init() {
  db.transaction((tx) => {
    tx.executeSql('CREATE TABLE IF NOT EXISTS cart_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, qty INTEGER NOT NULL)');
  });
}

export function addItem(productId: number, qty: number) {
  db.transaction((tx) => {
    tx.executeSql('INSERT INTO cart_items (product_id, qty) VALUES (?, ?)', [productId, qty]);
  });
}

export function getItems(): Promise<unknown[]> {
  return new Promise((resolve) => {
    db.transaction((tx) => {
      tx.executeSql(`SELECT * FROM ${TABLE} ORDER BY id`, [], (_, rs) => resolve(rs.rows.raw()));
    });
  });
}

export function clear() {
  db.transaction((tx) => tx.executeSql('DELETE FROM cart_items'));
}
