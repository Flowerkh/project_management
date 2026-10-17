CREATE TABLE customers (
  id INT NOT NULL AUTO_INCREMENT COMMENT '고객 번호',
  name VARCHAR(50) COMMENT '고객명',
  PRIMARY KEY (id)
) COMMENT='고객';
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT,
  customer_id INT,
  status VARCHAR(20),
  created_at DATETIME,
  PRIMARY KEY (id)
) COMMENT='주문';
CREATE TABLE order_items (id INT NOT NULL, order_id INT, PRIMARY KEY (id)) COMMENT='주문 상품';
CREATE TABLE order_logs (id INT NOT NULL AUTO_INCREMENT, order_id INT, status VARCHAR(20), created_at DATETIME, PRIMARY KEY (id)) COMMENT='주문 처리 로그';
