'use strict';
// Cart pages and an in-memory cart endpoint for the cart contract probe. The same pages run in jsdom
// (fetch stubbed onto the backend) and in Electron over a local HTTP server
// (test/e2e/cart-contract-fixtures-probe.cjs).
//
// variants:
//   good    working + / − / remove buttons wired to /cart/change.js, checkout is a form button posting to /cart
//   broken  the same markup with dead buttons and a checkout link built from an object (href="/[object Object]")
//   empty   a cart page with nothing in it

const LINE = { variant_id: 111, key: '111:fixture', quantity: 2, title: 'Áo thun cổ tròn', properties: null };

function createCartBackend(initialItems = [LINE]) {
  const items = initialItems.map((item) => ({ ...item }));
  const requests = [];
  const snapshot = () => ({
    item_count: items.reduce((n, item) => n + item.quantity, 0),
    items: items.map((item) => ({ ...item, id: item.variant_id })),
  });
  const handle = (method, url, body) => {
    const pathname = new URL(url, 'http://fixture.local').pathname;
    requests.push(`${method} ${pathname}`);
    if (pathname === '/cart.js' && method === 'GET') return { status: 200, json: snapshot() };
    if (pathname === '/cart/change.js' && method === 'POST') {
      const input = JSON.parse(body || '{}');
      const index = input.line ? input.line - 1 : items.findIndex((item) => item.key === String(input.id) || String(item.variant_id) === String(input.id));
      if (index < 0 || index >= items.length) return { status: 404, json: { message: 'Cart line not found' } };
      if (input.quantity <= 0) items.splice(index, 1);
      else items[index].quantity = input.quantity;
      return { status: 200, json: snapshot() };
    }
    if (pathname === '/cart/add.js' && method === 'POST') {
      const input = JSON.parse(body || '{}');
      const existing = items.find((item) => String(item.variant_id) === String(input.id));
      if (existing) existing.quantity += input.quantity;
      else items.push({ variant_id: Number(input.id), key: `${input.id}:fixture`, quantity: input.quantity, title: 'Áo thun cổ tròn', properties: input.properties || null });
      return { status: 200, json: {} };
    }
    return { status: 404, json: null };
  };
  return { handle, snapshot, requests, items };
}

const WIRED_SCRIPT = `<script>
(function () {
  var KEY = ${JSON.stringify(LINE.key)};
  var input = document.querySelector('.qty-input');
  async function change(quantity) {
    var res = await fetch('/cart/change.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: KEY, quantity: quantity }) });
    var cart = await res.json();
    input.value = cart.items[0] ? cart.items[0].quantity : 0;
  }
  document.addEventListener('click', function (e) {
    var button = e.target.closest('button');
    if (!button) return;
    var current = Number(input.value);
    if (button.classList.contains('qty-plus')) change(current + 1);
    else if (button.classList.contains('qty-minus')) change(current - 1);
    else if (button.classList.contains('cart-remove')) change(0);
  });
})();
</script>`;

function lineMarkup(quantity) {
  return `<div class="cart-item"><a href="/products/ao-thun">Áo thun cổ tròn</a>
  <button type="button" class="qty-minus" aria-label="Giảm số lượng">−</button>
  <input type="number" name="updates[]" value="${quantity}" class="qty-input" aria-label="Số lượng">
  <button type="button" class="qty-plus" aria-label="Tăng số lượng">+</button>
  <button type="button" class="cart-remove" aria-label="Xóa sản phẩm">Xóa</button>
</div>`;
}

function cartPageHtml(variant, quantity = LINE.quantity) {
  const head = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Giỏ hàng</title></head><body><header><a href="/">Cửa hàng</a></header>';
  if (variant === 'empty') {
    return `${head}<main id="MainContent"><h1>Giỏ hàng</h1><p>Giỏ hàng của bạn đang trống.</p></main></body></html>`;
  }
  if (variant === 'good') {
    return `${head}<main id="MainContent"><h1>Giỏ hàng</h1><form action="/cart" method="post" id="cart-form">${lineMarkup(quantity)}
<button type="submit" name="checkout" class="checkout">Thanh toán</button></form></main>${WIRED_SCRIPT}</body></html>`;
  }
  if (variant === 'broken') {
    return `${head}<main id="MainContent"><h1>Giỏ hàng</h1><form action="/cart" method="post" id="cart-form">${lineMarkup(quantity)}
<a class="checkout" href="/[object Object]">Thanh toán</a></form></main></body></html>`;
  }
  throw new Error(`Unknown cart fixture variant ${variant}`);
}

module.exports = { LINE, createCartBackend, cartPageHtml };
