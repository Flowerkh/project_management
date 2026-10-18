CREATE TABLE blog_category (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(50), PRIMARY KEY (id)) COMMENT='게시판 분류';
CREATE TABLE blog_post (id INT NOT NULL AUTO_INCREMENT, category_id INT, title VARCHAR(200) COMMENT '제목', body TEXT, published TINYINT(1), created_at DATETIME, PRIMARY KEY (id)) COMMENT='게시글';
CREATE TABLE tb_comment (id INT NOT NULL AUTO_INCREMENT, post_id INT, body TEXT, created_at DATETIME, PRIMARY KEY (id)) COMMENT='댓글';
CREATE TABLE shop_product (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(100), price INT, active TINYINT(1), PRIMARY KEY (id)) COMMENT='상품';
CREATE TABLE tb_order (id INT NOT NULL AUTO_INCREMENT, product_id INT, qty INT, status VARCHAR(20), created_at DATETIME, PRIMARY KEY (id)) COMMENT='주문';
CREATE TABLE tb_settle_daily (settle_date DATE NOT NULL, amount BIGINT, PRIMARY KEY (settle_date)) COMMENT='일별 정산';
