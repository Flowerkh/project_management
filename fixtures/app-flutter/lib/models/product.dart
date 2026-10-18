class Product {
  final int id;
  final String name;
  Product(this.id, this.name);
  factory Product.fromJson(Map<String, dynamic> j) => Product(j['id'], j['name']);
}
