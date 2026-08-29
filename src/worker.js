import { compare, hash } from 'bcryptjs';

const COOKIE = 'shop_session';
const AUTH_COOKIE = 'shop_auth';
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


function authCookie(request, id, maxAge = 604800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return AUTH_COOKIE + '=' + encodeURIComponent(id) + '; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=' + maxAge;
}
async function currentUser(request, env) {
  const token = parseCookie(request, AUTH_COOKIE);
  if (!token || !/^[a-f0-9-]{20,80}$/i.test(token)) return null;
  return await env.DB.prepare("SELECT s.id AS sessionId, u.id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now')").bind(token).first();
}
async function mergeGuestCart(request, env, userId) {
  const guestId = parseCookie(request, COOKIE); if (!guestId) return;
  const { results } = await env.DB.prepare('SELECT product_id AS productId, qty FROM cart_items WHERE session_id = ?').bind(guestId).all();
  if (!results?.length) return;
  const statements = [];
  for (const item of results) {
    const existing = await env.DB.prepare('SELECT id, qty FROM cart_items WHERE user_id = ? AND product_id = ?').bind(userId, item.productId).first();
    const qty = Math.min(99, item.qty + (existing?.qty || 0));
    statements.push(existing ? env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').bind(qty, existing.id) : env.DB.prepare('INSERT INTO cart_items (user_id, product_id, qty) VALUES (?, ?, ?)').bind(userId, item.productId, qty));
  }
  statements.push(env.DB.prepare('DELETE FROM cart_items WHERE session_id = ?').bind(guestId)); await env.DB.batch(statements);
}
async function createAuthSession(request, env, userId) {
  const id = crypto.randomUUID(); const expires = new Date(Date.now() + 604800000).toISOString();
  await env.DB.prepare('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(id, userId, expires).run(); return authCookie(request, id);
}
function validEmail(value) { const email = typeof value === 'string' ? value.trim().toLowerCase() : ''; return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null; }
function validName(value) { const name = typeof value === 'string' ? value.trim() : ''; return name.length >= 1 && name.length <= 100 ? name : null; }
async function authMe(request, env) { const user = await currentUser(request, env); return user ? json({ user: { id: user.id, email: user.email, name: user.name } }) : error('로그인이 필요합니다.', 401); }
async function signup(request, env) {
  const body = await request.json().catch(() => null); const email = validEmail(body?.email); const password = typeof body?.password === 'string' ? body.password : ''; const name = validName(body?.name);
  if (!email || password.length < 8 || password.length > 128 || !name) return error('이메일, 8자 이상 비밀번호, 이름을 확인해 주세요.');
  const passwordHash = await hash(password, 12); let result;
  try { result = await env.DB.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').bind(email, passwordHash, name).run(); } catch (err) { if (String(err).includes('UNIQUE')) return error('이미 가입된 이메일입니다.', 409); throw err; }
  const cookie = await createAuthSession(request, env, result.meta.last_row_id); await mergeGuestCart(request, env, result.meta.last_row_id);
  return withCookie(json({ user: { id: result.meta.last_row_id, email, name } }, 201), cookie);
}
async function login(request, env) {
  const body = await request.json().catch(() => null); const email = validEmail(body?.email); const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) return error('이메일과 비밀번호를 확인해 주세요.');
  const user = await env.DB.prepare('SELECT id, email, name, password_hash AS passwordHash FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await compare(password, user.passwordHash))) return error('이메일 또는 비밀번호가 올바르지 않습니다.', 401);
  const cookie = await createAuthSession(request, env, user.id); await mergeGuestCart(request, env, user.id);
  return withCookie(json({ user: { id: user.id, email: user.email, name: user.name } }), cookie);
}
async function logout(request, env) { const token = parseCookie(request, AUTH_COOKIE); if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind(token).run(); return withCookie(json({ ok: true }), authCookie(request, '', 0)); }

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
    ? env.DB.prepare('SELECT p.id, p.name, p.price, p.description, c.name AS category, p.image_url AS imageUrl FROM products p JOIN categories c ON c.id = p.category_id WHERE c.name = ? ORDER BY p.id').bind(category)
    : env.DB.prepare('SELECT p.id, p.name, p.price, p.description, c.name AS category, p.image_url AS imageUrl FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.id');
  const { results } = await query.all();
  return json({ products: results });
}

async function product(id, env) {
  const row = await env.DB.prepare('SELECT p.id, p.name, p.price, p.description, c.name AS category, p.image_url AS imageUrl FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?').bind(id).first();
  return row ? json({ product: row }) : error('상품을 찾을 수 없습니다.', 404);
}

async function cart(request, env) { const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const rows = await env.DB.prepare('SELECT c.id, c.product_id AS productId, c.qty, p.name, p.price, p.description, cat.name AS category, p.image_url AS imageUrl, (c.qty * p.price) AS subtotal FROM cart_items c JOIN products p ON p.id = c.product_id JOIN categories cat ON cat.id = p.category_id WHERE c.user_id = ? ORDER BY c.id').bind(user.id).all(); const items = rows.results || []; return json({ items, total: items.reduce((sum, item) => sum + item.subtotal, 0) }); }

async function addCart(request, env) { const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const body = await request.json().catch(() => null); const productId = validId(body?.productId); const qty = validQty(body?.qty); if (!productId || !qty) return error('상품과 수량을 확인해 주세요.'); if (!(await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first())) return error('상품을 찾을 수 없습니다.', 404); const current = await env.DB.prepare('SELECT id, qty FROM cart_items WHERE user_id = ? AND product_id = ?').bind(user.id, productId).first(); const nextQty = current ? current.qty + qty : qty; if (nextQty > 99) return error('상품 수량은 99개 이하로 담을 수 있습니다.'); const statement = current ? env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ? AND user_id = ?').bind(nextQty, current.id, user.id) : env.DB.prepare('INSERT INTO cart_items (user_id, product_id, qty) VALUES (?, ?, ?)').bind(user.id, productId, qty); await statement.run(); return json({ ok: true }); }

async function updateCart(request, env, itemId) { const qty = validQty((await request.json().catch(() => null))?.qty); const id = validId(itemId); if (!id || !qty) return error('항목과 수량을 확인해 주세요.'); const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const result = await env.DB.prepare('UPDATE cart_items SET qty = ? WHERE id = ? AND user_id = ?').bind(qty, id, user.id).run(); return result.meta.changes ? json({ ok: true }) : error('장바구니 항목을 찾을 수 없습니다.', 404); }

async function deleteCart(request, env, itemId) { const id = validId(itemId); if (!id) return error('항목을 확인해 주세요.'); const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const result = await env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').bind(id, user.id).run(); return result.meta.changes ? json({ ok: true }) : error('장바구니 항목을 찾을 수 없습니다.', 404); }

async function createOrder(request, env) { const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const { results: items } = await env.DB.prepare('SELECT c.product_id AS productId, c.qty, p.price, p.name, p.image_url AS imageUrl FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.user_id = ? ORDER BY c.id').bind(user.id).all(); if (!items?.length) return error('장바구니가 비어 있습니다.'); const total = items.reduce((sum, item) => sum + item.qty * item.price, 0); const paymentOrderId = 'shop-' + user.id + '-' + crypto.randomUUID(); const orderResult = (await env.DB.batch([env.DB.prepare("INSERT INTO orders (user_id, total, status, payment_order_id) VALUES (?, ?, 'pending', ?)").bind(user.id, total, paymentOrderId)]))[0]; const orderId = orderResult.meta.last_row_id; const statements = items.map((item) => env.DB.prepare('INSERT INTO order_items (order_id, product_id, qty, price) VALUES (?, ?, ?, ?)').bind(orderId, item.productId, item.qty, item.price)); statements.push(env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id)); await env.DB.batch(statements); return json({ orderId, paymentOrderId, total }, 201); }

async function paymentConfig(request, env) { const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); if (!env.TOSS_CLIENT_KEY) return error('결제 설정이 준비되지 않았습니다.', 503); return json({ clientKey: env.TOSS_CLIENT_KEY }); }
async function confirmPayment(request, env) { const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const body = await request.json().catch(() => null); const paymentKey = typeof body?.paymentKey === 'string' && body.paymentKey.length <= 200 ? body.paymentKey : null; const paymentOrderId = typeof body?.orderId === 'string' && /^shop-\d+-[a-f0-9-]{36}$/.test(body.orderId) ? body.orderId : null; const amount = Number(body?.amount); if (!paymentKey || !paymentOrderId || !Number.isInteger(amount) || amount < 0) return error('결제 정보를 확인해 주세요.'); const order = await env.DB.prepare('SELECT id, total, status FROM orders WHERE payment_order_id = ? AND user_id = ?').bind(paymentOrderId, user.id).first(); if (!order) return error('주문을 찾을 수 없습니다.', 404); if (order.status === 'paid') return json({ ok: true, orderId: order.id, status: 'paid' }); if (order.status !== 'pending' || amount !== order.total) return error('결제 금액이 올바르지 않습니다.', 400); if (!env.TOSS_SECRET_KEY) return error('결제 설정이 준비되지 않았습니다.', 503); const auth = btoa(env.TOSS_SECRET_KEY + ':'); const toss = await fetch('https://api.tosspayments.com/v1/payments/confirm', { method: 'POST', headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentKey, orderId: paymentOrderId, amount }) }); const result = await toss.json().catch(() => ({})); if (!toss.ok) return error(result.message || '결제 승인에 실패했습니다.', toss.status >= 500 ? 502 : 400); await env.DB.prepare("UPDATE orders SET status = 'paid', payment_key = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'pending'").bind(paymentKey, order.id, user.id).run(); return json({ ok: true, orderId: order.id, status: 'paid' }); }
async function getOrder(request, env, orderId) { const id = validId(orderId); if (!id) return error('주문을 찾을 수 없습니다.', 404); const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const order = await env.DB.prepare('SELECT id, total, status, payment_order_id AS paymentOrderId, paid_at AS paidAt, created_at AS createdAt FROM orders WHERE id = ? AND user_id = ?').bind(id, user.id).first(); if (!order) return error('주문을 찾을 수 없습니다.', 404); const { results: items } = await env.DB.prepare('SELECT oi.product_id AS productId, oi.qty, oi.price, p.name, p.image_url AS imageUrl FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id').bind(id).all(); return json({ order: { ...order, items } }); }

async function mypage(request, env) { const user = await currentUser(request, env); if (!user) return error('로그인이 필요합니다.', 401); const { results: orders } = await env.DB.prepare('SELECT id, total, status, payment_order_id AS paymentOrderId, paid_at AS paidAt, created_at AS createdAt FROM orders WHERE user_id = ? ORDER BY id DESC').bind(user.id).all(); const detailed=[]; for (const order of orders || []) { const { results: items } = await env.DB.prepare('SELECT oi.product_id AS productId, oi.qty, oi.price, p.name, p.image_url AS imageUrl FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id').bind(order.id).all(); detailed.push({ ...order, items }); } return json({ user: { id: user.id, email: user.email, name: user.name }, orders: detailed }); }
async function api(request, env, pathname) { if (pathname === '/api/auth/me' && request.method === 'GET') return authMe(request, env); if (pathname === '/api/auth/signup' && request.method === 'POST') return signup(request, env); if (pathname === '/api/auth/login' && request.method === 'POST') return login(request, env); if (pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env); if (pathname === '/api/mypage' && request.method === 'GET') return mypage(request, env); if (pathname === '/api/payments/config' && request.method === 'GET') return paymentConfig(request, env); if (pathname === '/api/payments/confirm' && request.method === 'POST') return confirmPayment(request, env); if (pathname === '/api/products' && request.method === 'GET') return products(request, env); const productMatch = pathname.match(/^\/api\/products\/(\d+)$/); if (productMatch && request.method === 'GET') return product(validId(productMatch[1]), env); if (pathname === '/api/cart' && request.method === 'GET') return cart(request, env); if (pathname === '/api/cart/items' && request.method === 'POST') return addCart(request, env); const itemMatch = pathname.match(/^\/api\/cart\/items\/(\d+)$/); if (itemMatch && request.method === 'PATCH') return updateCart(request, env, itemMatch[1]); if (itemMatch && request.method === 'DELETE') return deleteCart(request, env, itemMatch[1]); if (pathname === '/api/orders' && request.method === 'POST') return createOrder(request, env); const orderMatch = pathname.match(/^\/api\/orders\/(\d+)$/); if (orderMatch && request.method === 'GET') return getOrder(request, env, orderMatch[1]); return error('요청을 찾을 수 없습니다.', 404); }

function pageFor(pathname) {
  if (pathname === '/') return '/index.html';
  if (pathname === '/cart') return '/cart';
  if (pathname === '/auth') return '/auth';
  if (pathname === '/mypage') return '/mypage';
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
    headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self' https://js.tosspayments.com; connect-src 'self' https://api.tosspayments.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (pathname === '/cart' || pathname === '/mypage' || pathname.startsWith('/orders') || pathname.startsWith('/api/auth') || pathname === '/api/mypage' || pathname.startsWith('/api/cart') || pathname.startsWith('/api/orders') || pathname.startsWith('/api/payments')) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  },
};

export { validId, validQty };
