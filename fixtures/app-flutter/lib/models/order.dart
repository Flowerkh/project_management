class Order {
  final int id;
  final String status;
  Order(this.id, this.status);
  factory Order.fromJson(Map<String, dynamic> j) => Order(j['id'], j['status']);
}
