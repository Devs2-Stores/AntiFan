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
    if (pathname === '/products.json' && method === 'GET') {
      return { status: 200, json: { products: [{ id: 1, handle: 'ao-thun', variants: [{ id: LINE.variant_id, available: true }] }] } };
    }
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
  if (variant === 'crushed') {
    const css = `<style>
      .mh-cart-items__head { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; }
      .cart-template__data-head, .mh-cart-items__col { display: block; }
      .mh-cart-item { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: 1rem; width: 100%; max-width: 756px; }
      .mh-cart-item__product { display: flex; gap: 0.875rem; min-width: 0; }
      .mh-cart-item__media { width: 5rem; height: 5rem; flex-shrink: 0; display: block; background: #eee; }
      .mh-cart-item__details { flex: 1 1 auto; min-width: 0; }
      .mh-cart-item__top { display: flex; justify-content: space-between; align-items: flex-start; }
      .mh-cart-item__titles { flex: 1 1 auto; min-width: 0; }
      .mh-cart-item__vendor { display: block; font-size: 12px; }
      .mh-cart-item__title { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .mh-cart-item__remove { width: 28px; height: 28px; padding: 0; flex-shrink: 0; }
      .mh-cart-item__qty { display: inline-flex; overflow: hidden; max-width: 100%; border: 1px solid #ccc; }
      .mh-cart-item__qty-btn, .mh-cart-item__qty-input { min-width: 0; width: 28px; height: 28px; padding: 0; }
    </style>`;
    return `${head}${css}<main id="MainContent">
      <div class="mh-cart-items cart-items-component">
        <form action="/cart" method="post" class="mh-cart-items__form">
          <div aria-hidden="true" class="mh-cart-items__head cart-template__data-head">
            <span class="mh-cart-items__col mh-cart-items__col--product">SẢN PHẨM</span>
            <span class="mh-cart-items__col mh-cart-items__col--price">ĐƠN GIÁ</span>
            <span class="mh-cart-items__col mh-cart-items__col--qty">SỐ LƯỢNG</span>
            <span class="mh-cart-items__col mh-cart-items__col--total">THÀNH TIỀN</span>
          </div>
          <div class="mh-cart-items__list">
            <article data-line="1" data-line-item="1" class="mh-cart-item">
              <div class="mh-cart-item__product">
                <a class="mh-cart-item__media" href="/products/shure-sm58"></a>
                <div class="mh-cart-item__details">
                  <div class="mh-cart-item__top">
                    <div class="mh-cart-item__titles">
                      <span class="mh-cart-item__vendor">SHURE</span>
                      <a class="mh-cart-item__title" href="/products/shure-sm58">Micro Thanh Nhạc Shure SM58-LC</a>
                      <p class="mh-cart-item__variant">Tiêu chuẩn</p>
                      <span class="mh-cart-item__sku">Mã SKU: SHU-SM58LC-01</span>
                    </div>
                    <button type="button" data-action="remove-cart-item" class="mh-cart-item__remove" aria-label="Xóa">×</button>
                  </div>
                  <div class="mh-cart-item__price-inline">
                    <span class="mh-price__current">2,950,000₫</span>
                  </div>
                  <div class="mh-cart-item__bottom">
                    <div class="mh-cart-item__qty quantity-selector">
                      <button type="button" data-quantity="minus" class="mh-cart-item__qty-btn" aria-label="Giảm">-</button>
                      <input name="updates[]" type="number" class="mh-cart-item__qty-input" value="${quantity}" aria-label="Số lượng">
                      <button type="button" data-quantity="plus" class="mh-cart-item__qty-btn" aria-label="Tăng">+</button>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
          <button type="submit" name="checkout" class="checkout">Thanh toán</button>
        </form>
      </div>
    </main></body></html>`;
  }
  throw new Error(`Unknown cart fixture variant ${variant}`);
}
module.exports = { LINE, createCartBackend, cartPageHtml };
