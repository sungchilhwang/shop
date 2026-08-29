PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('잡화', '뷰티', '신발', '식품')),
  image_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 99),
  UNIQUE(session_id, product_id),
  CHECK (user_id IS NOT NULL OR session_id IS NOT NULL),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (session_id) REFERENCES guest_sessions(id)
);

CREATE TABLE IF NOT EXISTS orders (
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

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 99),
  price INTEGER NOT NULL CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

INSERT OR REPLACE INTO products (id, name, price, description, category, image_url) VALUES
  (1, '미니멀 토트백', 89000, '각을 살린 검정 가죽 토트백', '잡화', '/products/bag.jpg'),
  (2, '클래식 손목시계', 145000, '흰 문자판에 검정 가죽 밴드', '잡화', '/products/watch.jpg'),
  (3, '시트러스 오드뚜왈렛', 78000, '상쾌한 시트러스 계열 향수', '뷰티', '/products/perfume.jpg'),
  (4, '매트 레드 립스틱', 32000, '발색이 선명한 매트 타입', '뷰티', '/products/lipstick.jpg'),
  (5, '러닝화 블루', 112000, '쿠션이 두꺼운 남성 러닝화', '신발', '/products/shoe.jpg'),
  (6, '러닝화 핑크', 112000, '같은 모델의 여성 러닝화', '신발', '/products/shoe2.jpg'),
  (7, '레드와인 피노타지', 42000, '남아프리카산 드라이 레드와인', '식품', '/products/wine.jpg'),
  (8, '이탈리아 파스타 면', 6500, '세몰리나 100% 숏 파스타 450g', '식품', '/products/pasta.jpg');
