CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO categories (id, name) VALUES
  (1, '잡화'),
  (2, '뷰티'),
  (3, '신발'),
  (4, '식품');

CREATE TABLE products_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  description TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  image_url TEXT NOT NULL
);

INSERT INTO products_new (id, name, price, description, category_id, image_url)
SELECT p.id, p.name, p.price, p.description, c.id, p.image_url
FROM products p JOIN categories c ON c.name = p.category;

CREATE TABLE cart_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  product_id INTEGER NOT NULL REFERENCES products_new(id),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 99),
  UNIQUE(session_id, product_id),
  CHECK (user_id IS NOT NULL OR session_id IS NOT NULL),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (session_id) REFERENCES guest_sessions(id)
);
INSERT INTO cart_items_new (id, user_id, session_id, product_id, qty)
SELECT id, user_id, session_id, product_id, qty FROM cart_items;

CREATE TABLE orders_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (user_id IS NOT NULL OR session_id IS NOT NULL),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (session_id) REFERENCES guest_sessions(id)
);
INSERT INTO orders_new (id, user_id, session_id, total, status, created_at)
SELECT id, user_id, session_id, total, status, created_at FROM orders;

CREATE TABLE order_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders_new(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products_new(id),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 99),
  price INTEGER NOT NULL CHECK (price >= 0)
);
INSERT INTO order_items_new (id, order_id, product_id, qty, price)
SELECT id, order_id, product_id, qty, price FROM order_items;

DROP TABLE order_items;
DROP TABLE orders;
DROP TABLE cart_items;
DROP TABLE products;

ALTER TABLE products_new RENAME TO products;
ALTER TABLE cart_items_new RENAME TO cart_items;
ALTER TABLE orders_new RENAME TO orders;
ALTER TABLE order_items_new RENAME TO order_items;

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_user_product
  ON cart_items(user_id, product_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
