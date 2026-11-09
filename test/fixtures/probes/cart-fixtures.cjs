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

// Real S2 Melody House /cart (theme 1001523070, search.css before the remove-button fix; evidence in
// E:/Work/scratch/leader/261104-melody-and-antifan-qa/fixture-cart-remove-misplaced/). At >= 768px .mh-cart-item__product is a
// 5-column grid, .__details and .__bottom are display:contents, and .__remove is the last flex child of .__top, so the trash
// button lands at the right end of column 2, between the title column and the price column, ~400px from the row edge.
const MELODY_CART_CSS = `
:root{--mh-color-surface:#fff;--mh-color-surface-alt:#f6f3ee;--mh-color-line:#e3ddd2;--mh-color-line-strong:#c9c0b0;--mh-color-primary:#1d2a38;--mh-color-secondary:#b3541e;--mh-color-muted:#6b7280;--mh-color-price:#b3541e;--mh-color-error:#b42318;--mh-radius-card:12px;--mh-radius-sm:6px;--mh-font-2xs:11px;--mh-font-xs:12px;--mh-font-sm:14px;--mh-font-base:16px;--mh-font-heading:Arial,sans-serif;--mh-font-body:Arial,sans-serif;--mh-lh-snug:1.3;--mh-tracking-eyebrow:.08em;--mh-dur-fast:.15s;--mh-dur-base:.3s;--mh-ease-out:ease-out}
*{box-sizing:border-box}body{margin:0;font:16px/1.4 Arial,sans-serif;color:var(--mh-color-primary)}
cart-items,quantity-selector{display:block}quantity-selector.mh-cart-item__qty{display:inline-flex}
.mh-cart-items{max-width:787px;margin:2rem auto}
.mh-cart-items[data-scope="page"] .mh-cart-items__head{display:none}
.mh-cart-items__col--qty{text-align:center}.mh-cart-items__col--total{text-align:right}
.mh-cart-items[data-scope="page"] .mh-cart-items__list{display:flex;flex-direction:column;gap:.875rem;margin:0;padding:0;list-style:none}
.mh-cart-items[data-scope="page"] .mh-cart-item{display:block;padding:1rem;background-color:var(--mh-color-surface-alt);border:1px solid var(--mh-color-line);border-radius:var(--mh-radius-card)}
.mh-cart-items[data-scope="page"] .mh-cart-item__product{display:flex;align-items:flex-start;gap:.875rem;width:100%}
.mh-cart-items[data-scope="page"] .mh-cart-item__media{display:flex;align-items:center;justify-content:center;width:5.5rem;height:4.125rem;flex-shrink:0;padding:.25rem;overflow:hidden;background-color:var(--mh-color-surface);border:1px solid var(--mh-color-line);border-radius:var(--mh-radius-sm)}
.mh-cart-item__image{width:100%;height:100%;object-fit:contain;padding:.125rem}
.mh-cart-items[data-scope="page"] .mh-cart-item__details{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:.5rem}
.mh-cart-items[data-scope="page"] .mh-cart-item__top{display:flex;align-items:flex-start;justify-content:space-between;gap:.625rem;min-width:0}
.mh-cart-items[data-scope="page"] .mh-cart-item__titles{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:.2rem}
.mh-cart-item__vendor{display:block;font-size:var(--mh-font-2xs);font-weight:700;letter-spacing:var(--mh-tracking-eyebrow);text-transform:uppercase;color:var(--mh-color-secondary)}
.mh-cart-item__title{display:block;font-family:var(--mh-font-heading);font-size:var(--mh-font-base);font-weight:700;line-height:var(--mh-lh-snug);color:var(--mh-color-primary);text-decoration:none}
.mh-cart-item__variant,.mh-cart-item__sku{margin:0;font-size:var(--mh-font-xs);color:var(--mh-color-muted)}
.mh-cart-item__remove{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;border:0;background:transparent;color:var(--mh-color-muted);cursor:pointer;flex-shrink:0}
.mh-cart-item__price-inline{display:flex;align-items:baseline;flex-wrap:wrap;gap:.375rem}
.mh-price__current{font-size:var(--mh-font-sm);font-weight:700;color:var(--mh-color-price)}
.mh-cart-items[data-scope="page"] .mh-cart-item__bottom{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-top:.25rem}
.mh-cart-item__qty{display:inline-flex;align-items:center;height:2.375rem;border:1px solid var(--mh-color-line-strong);border-radius:var(--mh-radius-sm);background-color:var(--mh-color-surface)}
.mh-cart-item__qty-btn{display:inline-flex;align-items:center;justify-content:center;width:2.25rem;height:100%;border:0;background:transparent;color:var(--mh-color-primary);cursor:pointer}
.mh-cart-item__qty-input{width:2.5rem;height:100%;border:0;border-inline:1px solid var(--mh-color-line);background:transparent;text-align:center;font-family:var(--mh-font-body);font-size:var(--mh-font-xs);font-weight:700;color:var(--mh-color-primary);-moz-appearance:textfield}
.mh-cart-item__line-total{font-size:var(--mh-font-base);font-weight:700;color:var(--mh-color-price);text-align:right}
@media (min-width:768px){
.mh-cart-items[data-scope="page"] .mh-cart-items__head{display:grid;grid-template-columns:5.75rem minmax(0,1.8fr) minmax(6.5rem,.75fr) 7.5rem minmax(6.5rem,.8fr);gap:1rem;align-items:center;padding:0 1.25rem .75rem;margin-bottom:.75rem;border-bottom:1px solid var(--mh-color-line);font-size:var(--mh-font-2xs);font-weight:700;letter-spacing:var(--mh-tracking-eyebrow);text-transform:uppercase;color:var(--mh-color-muted)}
.mh-cart-items[data-scope="page"] .mh-cart-items__col--product{grid-column:1 / 3}
.mh-cart-items[data-scope="page"] .mh-cart-item{padding:1.25rem}
.mh-cart-items[data-scope="page"] .mh-cart-item__product{display:grid;grid-template-columns:5.75rem minmax(0,1.8fr) minmax(6.5rem,.75fr) 7.5rem minmax(6.5rem,.8fr);gap:1rem;align-items:center}
.mh-cart-items[data-scope="page"] .mh-cart-item__media{width:5.75rem;height:4.3125rem}
.mh-cart-items[data-scope="page"] .mh-cart-item__details,.mh-cart-items[data-scope="page"] .mh-cart-item__bottom{display:contents}
.mh-cart-items[data-scope="page"] .mh-cart-item__qty{justify-self:center;justify-content:center}
.mh-cart-items[data-scope="page"] .mh-cart-item__line-total{justify-self:end;text-align:right}}`;
// The fix shape: the trash button is pinned to the top-right corner of the row (outside the content columns) on desktop.
const MELODY_REMOVE_CORNER_CSS = '.mh-cart-items[data-scope="page"] .mh-cart-item{position:relative}@media (min-width:768px){.mh-cart-items[data-scope="page"] .mh-cart-item__remove{position:absolute;top:.5rem;right:.5rem}}';

function melodyCartItemsHtml(quantity) {
  const trash = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M5 4l.5 9h5L11 4" fill="none" stroke="currentColor"/></svg>';
  const step = (name, d) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" data-icon="${name}"><path d="${d}" fill="none" stroke="currentColor"/></svg>`;
  return `<cart-items data-scope="page" class="mh-cart-items cart-items-component">
  <form novalidate role="list" class="mh-cart-items__form" id="cart-template__data-form" method="post" action="/cart">
    <div aria-hidden="true" class="mh-cart-items__head cart-template__data-head">
      <span class="mh-cart-items__col mh-cart-items__col--product">SẢN PHẨM</span>
      <span class="mh-cart-items__col mh-cart-items__col--price">ĐƠN GIÁ</span>
      <span class="mh-cart-items__col mh-cart-items__col--qty">SỐ LƯỢNG</span>
      <span class="mh-cart-items__col mh-cart-items__col--total">THÀNH TIỀN</span>
    </div>
    <div class="mh-cart-items__list">
      <article role="listitem" data-line="1" data-line-item="1" data-product-id="1" data-var-id="111" class="mh-cart-item">
        <div class="mh-cart-item__product">
          <a title="Micro Thanh Nhạc Shure SM58-LC" href="/products/shure-sm58" class="mh-cart-item__media">
            <img decoding="async" height="90" width="120" alt="Micro Thanh Nhạc Shure SM58-LC" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" class="mh-cart-item__image">
          </a>
          <div class="mh-cart-item__details">
            <div class="mh-cart-item__top">
              <div class="mh-cart-item__titles">
                <span class="mh-cart-item__vendor">SHURE</span>
                <a href="/products/shure-sm58" class="mh-cart-item__title">Micro Thanh Nhạc Shure SM58-LC</a>
                <p class="mh-cart-item__variant">Tiêu chuẩn</p>
                <span class="mh-cart-item__sku">Mã SKU: SHU-SM58LC-01</span>
              </div>
              <button aria-label="Xóa Micro Thanh Nhạc Shure SM58-LC" data-line="1" data-variant-id="111" data-action="remove-cart-item" class="mh-cart-item__remove" type="button">${trash}</button>
            </div>
            <div class="mh-cart-item__price-inline"><span class="mh-price__current">2.950.000₫</span></div>
            <div class="mh-cart-item__bottom">
              <quantity-selector class="mh-cart-item__qty quantity-selector">
                <button aria-label="SỐ LƯỢNG -" data-quantity="minus" name="minus" class="mh-cart-item__qty-btn" type="button">${step('minus', 'M2 6h8')}</button>
                <input data-var-id="111" data-variant-id="111" aria-label="SỐ LƯỢNG Micro Thanh Nhạc Shure SM58-LC" max="99" min="1" value="${quantity}" name="updates[]" type="number" class="mh-cart-item__qty-input">
                <button aria-label="SỐ LƯỢNG +" data-quantity="plus" name="plus" class="mh-cart-item__qty-btn" type="button">${step('plus', 'M2 6h8M6 2v8')}</button>
              </quantity-selector>
              <div data-cart-drawer-item-total="2.950.000₫" class="mh-cart-item__line-total"><span class="mh-price__current">2.950.000₫</span></div>
            </div>
          </div>
        </div>
      </article>
    </div>
    <button type="submit" name="checkout" class="checkout">Thanh toán</button>
  </form>
</cart-items>`;
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
  if (variant === 'contents' || variant === 'contents-crushed') {
    // S2 Melody House shape: .mh-cart-item__details is display:contents so its children join the row grid.
    // 'contents': five real tracks, every child gets one. 'contents-crushed': the row grid is 5rem + 20px, so the
    // only box generated for the details subtree is a 20px wide column (a real layout defect).
    const crushed = variant === 'contents-crushed';
    const rowColumns = crushed ? '5rem 20px' : '5.5rem minmax(0, 1fr) 8rem 8rem 3rem';
    const css = `<style>
      .mh-cart-items__head { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) 8rem 8rem 3rem; max-width: 756px; }
      .mh-cart-item { display: grid; grid-template-columns: ${rowColumns}; gap: 1rem; align-items: center; width: 100%; max-width: 756px; }
      .mh-cart-item__media { width: 5rem; height: 5rem; display: block; background: #eee; }
      .mh-cart-item__details { display: contents; overflow: hidden; }
      .mh-cart-item__body { display: block; min-width: 0; }
      .mh-cart-item__actions { display: contents; }
      .mh-cart-item__vendor { display: block; font-size: 12px; }
      .mh-cart-item__title { display: block; }
      .mh-cart-item__qty { display: inline-flex; border: 1px solid #ccc; max-width: 100%; }
      .mh-cart-item__qty-btn, .mh-cart-item__qty-input { width: 28px; height: 28px; padding: 0; }
      .mh-cart-item__remove { width: 28px; height: 28px; padding: 0; }
    </style>`;
    const colHead = `<div aria-hidden="true" class="mh-cart-items__head cart-template__data-head">
            <span class="mh-cart-items__col">SẢN PHẨM</span><span class="mh-cart-items__col">ĐƠN GIÁ</span><span class="mh-cart-items__col">SỐ LƯỢNG</span><span class="mh-cart-items__col">THÀNH TIỀN</span>
          </div>`;
    const qty = `<div class="mh-cart-item__qty quantity-selector">
                  <button type="button" data-quantity="minus" class="mh-cart-item__qty-btn" aria-label="Giảm">-</button>
                  <input name="updates[]" type="number" class="mh-cart-item__qty-input" value="${quantity}" aria-label="Số lượng">
                  <button type="button" data-quantity="plus" class="mh-cart-item__qty-btn" aria-label="Tăng">+</button>
                </div>`;
    const inner = crushed
      ? `<div class="mh-cart-item__body">
                <span class="mh-cart-item__vendor">SHURE</span>
                <a class="mh-cart-item__title" href="/products/shure-sm58">Micro Thanh Nhạc Shure SM58-LC</a>
                <span class="mh-cart-item__price">2,950,000₫</span>${qty}
                <button type="button" data-action="remove-cart-item" class="mh-cart-item__remove" aria-label="Xóa">×</button>
              </div>`
      : `<div class="mh-cart-item__titles">
                <span class="mh-cart-item__vendor">SHURE</span>
                <a class="mh-cart-item__title" href="/products/shure-sm58">Micro Thanh Nhạc Shure SM58-LC</a>
              </div>
              <div class="mh-cart-item__actions">
                <span class="mh-cart-item__price">2,950,000₫</span>${qty}
                <button type="button" data-action="remove-cart-item" class="mh-cart-item__remove" aria-label="Xóa">×</button>
              </div>`;
    return `${head}${css}<main id="MainContent">
      <div class="mh-cart-items cart-items-component">
        <form action="/cart" method="post" class="mh-cart-items__form">
          ${colHead}
          <div class="mh-cart-items__list">
            <article data-line="1" data-line-item="1" class="mh-cart-item">
              <a class="mh-cart-item__media" href="/products/shure-sm58"></a>
              <div class="mh-cart-item__details">${inner}</div>
            </article>
          </div>
          <button type="submit" name="checkout" class="checkout">Thanh toán</button>
        </form>
      </div>
    </main></body></html>`;
  }
  if (variant === 'melody-remove-misplaced' || variant === 'melody-remove-corner') {
    const melodyHead = head.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
    return `${melodyHead}<style>${MELODY_CART_CSS}${variant === 'melody-remove-corner' ? MELODY_REMOVE_CORNER_CSS : ''}</style><main id="MainContent">${melodyCartItemsHtml(quantity)}</main></body></html>`;
  }
  throw new Error(`Unknown cart fixture variant ${variant}`);
}
module.exports = { LINE, createCartBackend, cartPageHtml, MELODY_CART_CSS, MELODY_REMOVE_CORNER_CSS, melodyCartItemsHtml };
