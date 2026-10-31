import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runCartContract } from '../../src/main/qa/probes/cart-contract';
import type { ProbeDeps } from '../../src/main/qa/probes/probe-deps';
import { loadJsdom, makeDomDeps, STOREFRONT_ORIGIN } from './pdp-probe-harness';

interface CartLineFixture {
  variant_id: number;
  key: string;
  quantity: number;
  title: string;
  properties: Record<string, unknown> | null;
}
interface CartBackend {
  handle(method: string, url: string, body?: string): { status: number; json: unknown };
  snapshot(): unknown;
  requests: string[];
  items: CartLineFixture[];
}
interface CartFixtures {
  LINE: CartLineFixture;
  createCartBackend(items?: CartLineFixture[]): CartBackend;
  cartPageHtml(variant: 'good' | 'broken' | 'empty', quantity?: number): string;
}

const fixtures = createRequire(__filename)(path.resolve(process.cwd(), 'test/fixtures/probes/cart-fixtures.cjs')) as CartFixtures;

/** A page in jsdom with fetch answered by the in-memory cart endpoint. */
function openHtml(html: string, items: CartLineFixture[], tweak?: (backend: CartBackend) => void, pathname = '/cart') {
  const backend = fixtures.createCartBackend(items);
  tweak?.(backend);
  const JSDOM = loadJsdom();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `${STOREFRONT_ORIGIN}${pathname}`,
    beforeParse(window: { fetch: unknown }) {
      window.fetch = (input: unknown, init?: { method?: string; body?: string }) => {
        const reply = backend.handle(String(init?.method ?? 'GET').toUpperCase(), String(input), init?.body);
        return Promise.resolve({ ok: reply.status < 400, status: reply.status, json: async () => reply.json, text: async () => JSON.stringify(reply.json) });
      };
    },
  });
  return { backend, ...makeDomDeps(dom) };
}

/** The cart page in jsdom with fetch answered by the in-memory cart endpoint. */
function openCart(variant: 'good' | 'broken' | 'empty', items?: CartLineFixture[], tweak?: (backend: CartBackend) => void) {
  return openHtml(fixtures.cartPageHtml(variant, items?.[0]?.quantity), items ?? (variant === 'empty' ? [] : [fixtures.LINE]), tweak);
}

const mutationRequests = (backend: CartBackend): string[] => backend.requests.filter((r) => r !== 'GET /cart.js');

describe('runCartContract passive run', () => {
  it('lists the controls of a working cart, reads the checkout target and clicks nothing', async () => {
    const { deps, clicks, backend } = openCart('good');

    const result = await runCartContract(deps);

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.data.controls, { plus: 1, minus: 1, remove: 1, quantityInput: 1, checkout: 1 });
    assert.strictEqual(result.data.exercised, false);
    assert.strictEqual(result.data.checkoutTargets[0]?.valid, true);
    assert.deepStrictEqual(clicks, [], 'a passive run never clicks');
    assert.deepStrictEqual(mutationRequests(backend), []);
  });

  it('flags a checkout link built from an object as critical', async () => {
    const { deps, clicks } = openCart('broken');

    const result = await runCartContract(deps);

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, false);
    const finding = result.findings.find((f) => f.ruleId === 'checkout-target-invalid');
    assert.ok(finding, JSON.stringify(result.findings));
    assert.strictEqual(finding.severity, 'critical');
    assert.strictEqual(result.data.checkoutTargets[0]?.target, '/[object Object]');
    assert.deepStrictEqual(clicks, []);
  });

  it('reports an empty cart as not exercised and never adds an item', async () => {
    const { deps, clicks, backend } = openCart('empty');

    const result = await runCartContract(deps, { exerciseCart: true, allowRemove: true });

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.passed, null);
    assert.deepStrictEqual(result.findings.map((f) => [f.ruleId, f.severity]), [['QA_EMPTY_CART_NOT_EXERCISED', 'info']]);
    assert.deepStrictEqual(clicks, []);
    assert.deepStrictEqual(mutationRequests(backend), []);
    assert.strictEqual(backend.items.length, 0);
  });
});

describe('runCartContract exercise run', () => {
  it('clicks + then −, sees each request and quantity change, and leaves the cart as it found it', async () => {
    const { deps, clicks, backend } = openCart('good');

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(clicks, ['[data-antifan-cart-ctl="plus-0"]', '[data-antifan-cart-ctl="minus-0"]']);
    assert.deepStrictEqual(result.data.steps.map((s) => [s.control, s.requestMade, s.quantityBefore, s.quantityAfter]), [['plus', true, 2, 3], ['minus', true, 3, 2]]);
    assert.deepStrictEqual(mutationRequests(backend), ['POST /cart/change.js', 'POST /cart/change.js']);
    assert.strictEqual(backend.items[0]?.quantity, 2);
    assert.strictEqual(result.data.restored, 'not-needed');
  });

  it('flags every control that sends no request and does not touch the cart', async () => {
    const { deps, backend } = openCart('broken');

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.strictEqual(result.passed, false);
    const noRequest = result.findings.filter((f) => f.ruleId === 'cart-control-no-request');
    assert.strictEqual(noRequest.length, 2, JSON.stringify(result.findings));
    assert.ok(noRequest.every((f) => f.severity === 'critical'));
    assert.deepStrictEqual(mutationRequests(backend), []);
    assert.strictEqual(backend.items[0]?.quantity, 2);
  });

  it('walks a quantity-1 line up and back down, ending where it began', async () => {
    const { deps, clicks, backend } = openCart('good', [{ ...fixtures.LINE, quantity: 1 }]);

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.deepStrictEqual(clicks, ['[data-antifan-cart-ctl="plus-0"]', '[data-antifan-cart-ctl="minus-0"]']);
    assert.deepStrictEqual(result.data.steps.map((s) => [s.control, s.quantityBefore, s.quantityAfter]), [['plus', 1, 2], ['minus', 2, 1]]);
    assert.strictEqual(backend.items[0]?.quantity, 1);
    assert.strictEqual(result.data.restored, 'not-needed');
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
  });

  it('does not click − when + was refused at quantity 1: − would remove the line', async () => {
    // A stock limit: the cart endpoint answers + with the unchanged cart.
    const { deps, clicks, backend } = openCart('good', [{ ...fixtures.LINE, quantity: 1 }], (b) => {
      const real = b.handle.bind(b);
      b.handle = (method, url, body) => {
        const isIncrease = method === 'POST' && url.includes('/cart/change.js') && Number(JSON.parse(body ?? '{}').quantity) > 1;
        return isIncrease ? { status: 200, json: b.snapshot() } : real(method, url, body);
      };
    });

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.deepStrictEqual(clicks, ['[data-antifan-cart-ctl="plus-0"]']);
    assert.ok(result.findings.some((f) => f.ruleId === 'cart-minus-not-exercised' && f.severity === 'info'), JSON.stringify(result.findings));
    assert.ok(result.findings.some((f) => f.ruleId === 'cart-control-quantity-mismatch' && f.severity === 'warning'), JSON.stringify(result.findings));
    assert.strictEqual(backend.items[0]?.quantity, 1);
    assert.strictEqual(result.passed, true);
  });

  it('never clicks the remove control without allowRemove', async () => {
    const { deps, clicks, backend } = openCart('good');

    await runCartContract(deps, { exerciseCart: true });

    assert.ok(!clicks.some((c) => c.includes('remove')), clicks.join(','));
    assert.strictEqual(backend.items.length, 1);
  });

  it('clicks remove with allowRemove and adds the removed line back', async () => {
    const { deps, clicks, backend } = openCart('good');

    const result = await runCartContract(deps, { exerciseCart: true, allowRemove: true });

    assert.ok(clicks.includes('[data-antifan-cart-ctl="remove-0"]'));
    const remove = result.data.steps.find((s) => s.control === 'remove');
    assert.ok(remove?.requestMade, JSON.stringify(result.data.steps));
    assert.deepStrictEqual(mutationRequests(backend).slice(-1), ['POST /cart/add.js']);
    assert.strictEqual(backend.items.length, 1);
    assert.strictEqual(backend.items[0]?.variant_id, fixtures.LINE.variant_id);
    assert.strictEqual(backend.items[0]?.quantity, fixtures.LINE.quantity);
    assert.strictEqual(result.data.restored, 'direct');
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
  });
});

describe('runCartContract with scripted deps', () => {
  const never = async (): Promise<never> => {
    throw new Error('unexpected call');
  };

  it('reports an unreadable cart as unmeasured', async () => {
    const deps: ProbeDeps = { evalJs: async () => { throw new Error('execution context destroyed'); }, click: never, hover: never, wait: async () => undefined };

    const result = await runCartContract(deps);

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.passed, null);
    assert.match(result.error ?? '', /execution context destroyed/);
  });

  it('reports a page that is not the cart as unmeasured', async () => {
    const deps: ProbeDeps = {
      evalJs: async () => ({ ok: true, isCartPage: false, cart: { itemCount: 3, items: [] }, controls: { plus: [], minus: [], remove: [], quantityInput: 0, checkout: [] } }),
      click: never,
      hover: never,
      wait: async () => undefined,
    };

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.error, 'current page is not the cart page');
  });

  it('turns an undeliverable click into a warning, not a request-less verdict', async () => {
    const state = {
      ok: true,
      isCartPage: true,
      cart: { itemCount: 2, items: [{ key: 'k', variantId: 1, quantity: 2, properties: null }] },
      controls: { plus: [{ tag: 'plus-0', label: 'button.plus' }], minus: [], remove: [{ tag: 'remove-0', label: 'button.rm' }], quantityInput: 1, checkout: [{ selector: 'button.checkout', kind: 'form-action', target: '/cart', valid: true }] },
    };
    const deps: ProbeDeps = {
      evalJs: async (script) => (script.includes('/cart.js') && script.includes('isCartPage') ? state : true),
      click: async () => ({ ok: false, error: 'TARGET_OBSCURED' }),
      hover: never,
      wait: async () => undefined,
    };

    const result = await runCartContract(deps, { exerciseCart: true });

    const finding = result.findings.find((f) => f.ruleId === 'cart-control-click-failed');
    assert.ok(finding, JSON.stringify(result.findings));
    assert.strictEqual(finding.severity, 'warning');
    assert.ok(!result.findings.some((f) => f.ruleId === 'cart-control-no-request'));
    assert.strictEqual(result.passed, true);
  });

  it('reports missing controls on a cart that has items', async () => {
    const deps: ProbeDeps = {
      evalJs: async () => ({ ok: true, isCartPage: true, cart: { itemCount: 1, items: [] }, controls: { plus: [], minus: [], remove: [], quantityInput: 0, checkout: [] } }),
      click: never,
      hover: never,
      wait: async () => undefined,
    };

    const result = await runCartContract(deps);

    assert.deepStrictEqual(result.findings.map((f) => f.ruleId).sort(), ['cart-checkout-missing', 'cart-quantity-control-missing', 'cart-remove-control-missing']);
    assert.strictEqual(result.passed, false);
  });
});

const LINE_A: CartLineFixture = { variant_id: 111, key: '111:aaaaaa', quantity: 2, title: 'Áo A', properties: null };
const LINE_B: CartLineFixture = { variant_id: 222, key: '222:bbbbbb', quantity: 1, title: 'Áo B', properties: null };

const CART_HEAD = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Giỏ hàng</title></head><body>';
const CHECKOUT = '<button type="submit" name="checkout" class="checkout">Thanh toán</button>';

/** Rows address their cart line by data-key; one click handler changes that line through /cart/change.js. */
const KEYED_SCRIPT = `<script>
document.addEventListener('click', async function (e) {
  var button = e.target.closest('button');
  var row = button && button.closest('[data-key]');
  if (!row) return;
  var key = row.getAttribute('data-key');
  var cart = await (await fetch('/cart.js')).json();
  var item = cart.items.filter(function (i) { return i.key === key; })[0];
  if (!item) return;
  var quantity = button.classList.contains('qty-plus') ? item.quantity + 1 : button.classList.contains('qty-minus') ? item.quantity - 1 : 0;
  await fetch('/cart/change.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, quantity: quantity }) });
});
</script>`;

function keyedRow(line: CartLineFixture): string {
  return `<div class="cart-row" data-key="${line.key}"><a href="/products/${line.variant_id}">${line.title}</a>
  <button type="button" class="qty-minus" aria-label="Giảm số lượng">−</button>
  <button type="button" class="qty-plus" aria-label="Tăng số lượng">+</button>
  <button type="button" class="cart-remove" aria-label="Xóa sản phẩm">Xóa</button></div>`;
}

function keyedCartPage(rows: string): string {
  return `${CART_HEAD}<main id="MainContent"><form action="/cart" method="post">${rows}${CHECKOUT}</form></main>${KEYED_SCRIPT}</body></html>`;
}

describe('runCartContract page and control selection', () => {
  it('does not take a product page for the cart page because it posts to /cart/add', async () => {
    const html = `${CART_HEAD}<main><form action="/cart/add" method="post"><button type="button" class="qty-plus">+</button><button type="submit">Thêm vào giỏ</button></form></main></body></html>`;
    const { deps, clicks } = openHtml(html, [LINE_A], undefined, '/products/ao-a');

    const result = await runCartContract(deps, { exerciseCart: true, allowRemove: true });

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.error, 'current page is not the cart page');
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(clicks, []);
  });

  it('classifies a control from its own signals, not from the product title in its label', async () => {
    const html = keyedCartPage(`<div class="cart-row" data-key="${LINE_A.key}">
      <button type="button" class="qty-minus" aria-label="Decrease quantity for Plus Size Dress" title="Increase plus tang">−</button>
      <button type="button" class="qty-plus" aria-label="Increase quantity for Minus Giam Dress">+</button>
      <button type="button" class="cart-remove" aria-label="Remove Plus Size Dress">Remove</button></div>`);
    const { deps } = openHtml(html, [LINE_A]);

    const result = await runCartContract(deps);

    assert.deepStrictEqual([result.data.controls.plus, result.data.controls.minus, result.data.controls.remove], [1, 1, 1], JSON.stringify(result.data.controls));
  });

  it('leaves out a control whose own signals name two kinds', async () => {
    const html = keyedCartPage(`<div class="cart-row" data-key="${LINE_A.key}"><button type="button" class="qty-minus" aria-label="Increase quantity">?</button></div>`);
    const { deps } = openHtml(html, [LINE_A]);

    const result = await runCartContract(deps);

    assert.deepStrictEqual([result.data.controls.plus, result.data.controls.minus], [0, 0]);
  });

  it('does not count a button that clears the whole cart as a remove control', async () => {
    const html = keyedCartPage(`<button type="button" class="cart-remove-all">Xóa tất cả</button>${keyedRow(LINE_A)}`);
    const { deps } = openHtml(html, [LINE_A]);

    const result = await runCartContract(deps);

    assert.strictEqual(result.data.controls.remove, 1);
  });
});

describe('runCartContract on a cart with several lines', () => {
  it('exercises the first cart line through its own controls even when the page lists another line first', async () => {
    const html = keyedCartPage(keyedRow(LINE_B) + keyedRow(LINE_A));
    const { deps, backend } = openHtml(html, [LINE_A, LINE_B]);

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.deepStrictEqual(result.data.steps.map((s) => [s.control, s.quantityBefore, s.quantityAfter]), [['plus', 2, 3], ['minus', 3, 2]], JSON.stringify(result.findings));
    assert.strictEqual(backend.items.find((i) => i.variant_id === 111)?.quantity, 2);
    assert.strictEqual(backend.items.find((i) => i.variant_id === 222)?.quantity, 1, 'the line listed first on the page was not touched');
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
  });

  it('removes only the first cart line with allowRemove and adds that line back, keeping the others', async () => {
    const html = keyedCartPage(keyedRow(LINE_B) + keyedRow(LINE_A));
    const { deps, backend } = openHtml(html, [LINE_A, LINE_B]);

    const result = await runCartContract(deps, { exerciseCart: true, allowRemove: true });

    const remove = result.data.steps.find((s) => s.control === 'remove');
    assert.ok(remove?.requestMade, JSON.stringify(result.data.steps));
    assert.strictEqual(backend.items.length, 2);
    assert.strictEqual(backend.items.find((i) => i.variant_id === 111)?.quantity, 2);
    assert.strictEqual(backend.items.find((i) => i.variant_id === 222)?.quantity, 1);
    assert.strictEqual(result.data.restored, 'direct');
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
  });

  it('clicks nothing when the controls cannot be matched to a cart line', async () => {
    // Three + and three − buttons for two lines (the third pair belongs to a recommendations block) and no line marker.
    const row = (quantity: number) => `<div class="cart-row"><button type="button" class="qty-minus" aria-label="Giảm">−</button><input type="number" name="updates[]" value="${quantity}"><button type="button" class="qty-plus" aria-label="Tăng">+</button></div>`;
    const html = `${CART_HEAD}<main id="MainContent"><form action="/cart" method="post">${row(2)}${row(1)}${CHECKOUT}</form><section><button type="button" class="qty-minus">−</button><button type="button" class="qty-plus">+</button></section></main></body></html>`;
    const { deps, clicks, backend } = openHtml(html, [LINE_A, LINE_B]);

    const result = await runCartContract(deps, { exerciseCart: true });

    assert.ok(result.findings.some((f) => f.ruleId === 'cart-control-line-unknown' && f.severity === 'info'), JSON.stringify(result.findings));
    assert.deepStrictEqual(clicks, []);
    assert.deepStrictEqual(mutationRequests(backend), []);
  });

  it('fails the run when a removed line cannot be added back', async () => {
    const html = keyedCartPage(keyedRow(LINE_A));
    const { deps } = openHtml(html, [LINE_A], (b) => {
      const real = b.handle.bind(b);
      b.handle = (method, url, body) => (url.includes('/cart/add.js') ? { status: 500, json: null } : real(method, url, body));
    });

    const result = await runCartContract(deps, { exerciseCart: true, allowRemove: true });

    const failed = result.findings.find((f) => f.ruleId === 'cart-restore-failed');
    assert.ok(failed, JSON.stringify(result.findings));
    assert.strictEqual(failed.severity, 'critical');
    assert.strictEqual(result.data.restored, 'failed');
    assert.strictEqual(result.passed, false);
  });
});
