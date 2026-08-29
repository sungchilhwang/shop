const COOKIE = 'shop_session';
const CATEGORIES = new Set(['잡화', '뷰티', '신발', '식품']);

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function parseCookie(request, name) {
  const value = request.headers.get('Cookie') || '';
  const part = value.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

async function sessionFor(request, env) {
  let id = parseCookie(request, COOKIE);
  let fresh = false;
  if (!id || !/^[a-f0-9-]{20,80}$/i.test(id)) {
    id = crypto.randomUUID();
    fresh = true;
    await env.DB.prepare('INSERT OR IGNORE INTO guest_sessions (id) VALUES (?)').bind(id).run();
  } else {
    const exists = await env.DB.prepare('SELECT id FROM guest_sessions WHERE id = ?').bind(id).first();
    if (!exists) {
      await env.DB.prepare('INSERT INTO guest_sessions (id) VALUES (?)').bind(id).run();
      fresh = true;
    }
  }
  return { id, cookie: fresh ? `${COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}; Max-Age=31536000` : null };
}

function validId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validQty(value) {
  const qty = Number(value);
  return Number.isInteger(qty) && qty >= 1 && qty <= 99 ? qty : null;
}

function withCookie(response, cookie) {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
}

async function products(request, env) {
  const category = new URL(request.url).searchParams.get('category');
  if (category && !CATEGORIES.has(category)) return error('분류가 올바르지 않습니다.');
  const query = category
    ? env.DB.prepare('SELECT id, name, price, description, category, image_url AS imageUrl FROM products WHERE category = ? ORDER BY id').bind(category)
    : env.DB.prepare('SELECT id, name, price, description, category, image_url AS imageUrl FROM products ORDER BY id');
  const { results } = await query.all();
  return json({ products: results });
}

async function product(id, env) {
  const row = await env.DB.prepare('SELECT id, name, price, description, category, image_url AS imageUrl FROM products WHERE id = ?').bind(id).first();
  return row ? json({ product: row }) : error('상품을 찾을 수 없습니다.', 404);
}

async function cart(request, env) {
  const session = await sessionFor(request, env);
  const rows = await env.DB.prepare(`
    SELECT c.id, c.product_id AS productId, c.qty, p.name, p.price, p.description,
           p.category, p.image_url AS imageUrl, (c.qty * p.price) AS subtotal
    FROM cart_items c JOIN products p ON p.id = c.product_id
    WHERE c.session_id = ? ORDER BY c.id
  `).bind(session.id).all();
  const items = rows.results || [];
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  return withCookie(json({ items, total }), session.cookie);
}

async function addCart(request, env) {
  const body = await request.json().catch(() => null);
  const productId = validId(body?.productId);
  const qty = validQty(body?.qty);
  if (!productId || !qty) return error('상품과 수량을 확인해 주세요.');
  const found = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first();
  if (!found) return error('상품을 찾을 수 없습니다.', 404);
  const session = await sessionFor(request, env);
  const current = await env.DB.prepare('SELECT id, qty FROM cart_items WHERE session_id = ? AND product_id = ?').bind(session.id, productId).first();
  const nextQty = current ? current.qty + qty : qty;
  if (nextQty > 99) return error('상품 수량은 99개 이하로 담을 수 있습니다.');
  const statement = current
    ? env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').bind(nextQty, current.id)
    : env.DB.prepare('INSERT INTO cart_items (session_id, product_id, qty) VALUES (?, ?, ?)').bind(session.id, productId, qty);
  await statement.run();
  return withCookie(json({ ok: true }), session.cookie);
}

async function updateCart(request, env, itemId) {
  const qty = validQty((await request.json().catch(() => null))?.qty);
  const id = validId(itemId);
  if (!id || !qty) return error('항목과 수량을 확인해 주세요.');
  const session = await sessionFor(request, env);
  const result = await env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ? AND session_id = ?').bind(qty, id, session.id).run();
  return result.meta.changes ? withCookie(json({ ok: true }), session.cookie) : error('장바구니 항목을 찾을 수 없습니다.', 404);
}

async function deleteCart(request, env, itemId) {
  const id = validId(itemId);
  if (!id) return error('항목을 확인해 주세요.');
  const session = await sessionFor(request, env);
  const result = await env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND session_id = ?').bind(id, session.id).run();
  return result.meta.changes ? withCookie(json({ ok: true }), session.cookie) : error('장바구니 항목을 찾을 수 없습니다.', 404);
}

async function createOrder(request, env) {
  const session = await sessionFor(request, env);
  const { results: items } = await env.DB.prepare(`
    SELECT c.product_id AS productId, c.qty, p.price, p.name, p.image_url AS imageUrl
    FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.session_id = ? ORDER BY c.id
  `).bind(session.id).all();
  if (!items?.length) return error('장바구니가 비어 있습니다.');
  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const statements = [env.DB.prepare('INSERT INTO orders (session_id, total, status) VALUES (?, ?, \'pending\')').bind(session.id, total)];
  const orderResult = (await env.DB.batch(statements))[0];
  const orderId = orderResult.meta.last_row_id;
  const itemStatements = items.map((item) => env.DB.prepare('INSERT INTO order_items (order_id, product_id, qty, price) VALUES (?, ?, ?, ?)').bind(orderId, item.productId, item.qty, item.price));
  itemStatements.push(env.DB.prepare('DELETE FROM cart_items WHERE session_id = ?').bind(session.id));
  await env.DB.batch(itemStatements);
  return withCookie(json({ orderId }, 201), session.cookie);
}

async function getOrder(request, env, orderId) {
  const id = validId(orderId);
  if (!id) return error('주문을 찾을 수 없습니다.', 404);
  const session = await sessionFor(request, env);
  const order = await env.DB.prepare('SELECT id, total, status, created_at AS createdAt FROM orders WHERE id = ? AND session_id = ?').bind(id, session.id).first();
  if (!order) return error('주문을 찾을 수 없습니다.', 404);
  const { results: items } = await env.DB.prepare(`
    SELECT oi.product_id AS productId, oi.qty, oi.price, p.name, p.image_url AS imageUrl
    FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id
  `).bind(id).all();
  return withCookie(json({ order: { ...order, items } }), session.cookie);
}

async function api(request, env, pathname) {
  if (pathname === '/api/products' && request.method === 'GET') return products(request, env);
  const productMatch = pathname.match(/^\/api\/products\/(\d+)$/);
  if (productMatch && request.method === 'GET') return product(validId(productMatch[1]), env);
  if (pathname === '/api/cart' && request.method === 'GET') return cart(request, env);
  if (pathname === '/api/cart/items' && request.method === 'POST') return addCart(request, env);
  const itemMatch = pathname.match(/^\/api\/cart\/items\/(\d+)$/);
  if (itemMatch && request.method === 'PATCH') return updateCart(request, env, itemMatch[1]);
  if (itemMatch && request.method === 'DELETE') return deleteCart(request, env, itemMatch[1]);
  if (pathname === '/api/orders' && request.method === 'POST') return createOrder(request, env);
  const orderMatch = pathname.match(/^\/api\/orders\/(\d+)$/);
  if (orderMatch && request.method === 'GET') return getOrder(request, env, orderMatch[1]);
  return error('요청을 찾을 수 없습니다.', 404);
}

function pageFor(pathname) {
  if (pathname === '/') return '/index.html';
  if (pathname === '/cart') return '/cart';
  if (/^\/products\/\d+$/.test(pathname)) return '/detail';
  if (/^\/orders\/\d+$/.test(pathname)) return '/order';
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : url.pathname;
    let response;
    if (pathname.startsWith('/api/')) response = await api(request, env, pathname);
    else {
      const page = pageFor(pathname);
      response = page ? await env.ASSETS.fetch(new Request(new URL(page, request.url), request)) : await env.ASSETS.fetch(request);
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    return new Response(response.body, { status: response.status, headers });
  },
};

export { validId, validQty };
