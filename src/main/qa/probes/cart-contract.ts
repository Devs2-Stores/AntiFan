/**
 * Cart page contract probe. A cart that renders but cannot be changed or checked out is the defect
 * that a read-only look at the DOM never sees: quantity buttons wired to nothing, a checkout link
 * whose target was built from an object (`/[object Object]`).
 *
 * Default run is passive: it reads `/cart.js`, finds the quantity, remove and checkout controls and
 * reads (never clicks) the checkout target. Only `exerciseCart: true` clicks the + and − controls of
 * the first cart line, watches for the cart request and the quantity change, and puts the cart back
 * line by line. The remove control is clicked only with `allowRemove: true` as well, and every line
 * the click took out of the cart is added back afterwards. A control that cannot be matched to the
 * line is never clicked. An empty cart is never filled: nothing can be exercised, which is said so.
 */
import type { ProbeDeps, ProbeFinding, ProbeResult } from './probe-deps';

export interface CartContractOptions {
  /** Click + and − on the first line and read /cart.js back; the quantity is restored. */
  exerciseCart?: boolean;
  /** With exerciseCart: also click the remove control of the first line, then add the line back. */
  allowRemove?: boolean;
}

export interface CartControlCounts {
  plus: number;
  minus: number;
  remove: number;
  quantityInput: number;
  checkout: number;
}

export interface CartCheckoutTarget {
  selector: string;
  /** Where the target was read from: href, formaction, form-action, form-default, data-href or script. */
  kind: string;
  target: string | null;
  /** null when the target is built by script and cannot be read without clicking. */
  valid: boolean | null;
}

export interface CartExerciseStep {
  control: 'plus' | 'minus' | 'remove';
  clicked: boolean;
  requestMade: boolean;
  navigated: boolean;
  requests: string[];
  quantityBefore: number | null;
  quantityAfter: number | null;
  skipped?: string;
  error?: string;
}

export interface CartContractData {
  itemCount: number;
  exercised: boolean;
  controls: CartControlCounts;
  checkoutTargets: CartCheckoutTarget[];
  steps: CartExerciseStep[];
  /** How the cart was put back after an exercise: not-needed, direct (/cart/change.js, /cart/add.js) or failed. */
  restored: 'not-needed' | 'direct' | 'failed' | null;
}

interface CartLine {
  key: string;
  variantId: number | string | null;
  quantity: number;
  properties: Record<string, unknown> | null;
}

interface CartSnapshot {
  itemCount: number;
  items: CartLine[];
}

interface TaggedControl {
  tag: string;
  label: string;
  /** Key of the cart line the control's own markup points at; null or absent when it names none. */
  lineKey?: string | null;
}

interface CartStateResult {
  ok: boolean;
  error?: string;
  isCartPage?: boolean;
  cart?: CartSnapshot;
  controls?: { plus: TaggedControl[]; minus: TaggedControl[]; remove: TaggedControl[]; quantityInput: number; checkout: CartCheckoutTarget[] };
}

interface CartObserveResult {
  hookAlive: boolean;
  calls: Array<{ via: string; method: string; url: string }>;
  cart: CartSnapshot | null;
}

interface CartRestoreResult {
  ok: boolean;
  error?: string;
}

const CTL_ATTR = 'data-antifan-cart-ctl';
const POLL_MS = 300;
const POLL_ROUNDS = 6;

/** Page-side helpers: plain ES2017, spliced into an async IIFE that runs in the storefront page and in jsdom. */
const CART_PAGE_HELPERS = String.raw`
var norm = function (s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd').replace(/\u0110/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
};
var describe = function (el) {
  var s = el.tagName.toLowerCase();
  if (el.id) return s + '#' + el.id;
  var c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  return c.length ? s + '.' + c.join('.') : s;
};
var hidden = function (el) {
  for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur.hidden) return true;
    var cs = getComputedStyle(cur);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  }
  return false;
};
var readCart = async function () {
  var hook = window.__antifanCartHook;
  var f = hook && hook.origFetch ? hook.origFetch : window.fetch.bind(window);
  var res = await f('/cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error('/cart.js answered HTTP ' + res.status);
  var c = await res.json();
  var items = Array.isArray(c.items) ? c.items : [];
  var lines = items.map(function (i) {
    var variantId = i.variant_id != null ? i.variant_id : i.id != null ? i.id : null;
    return { key: String(i.key != null ? i.key : variantId), variantId: variantId, quantity: Number(i.quantity) || 0, properties: i.properties || null };
  });
  var count = typeof c.item_count === 'number' ? c.item_count : lines.reduce(function (n, l) { return n + l.quantity; }, 0);
  return { itemCount: count, items: lines };
};
`;

const INSTALL_HOOK_SOURCE = String.raw`(function () {
  var hook = window.__antifanCartHook;
  if (hook) { hook.calls.length = 0; return true; }
  hook = window.__antifanCartHook = { calls: [], origFetch: typeof window.fetch === 'function' ? window.fetch.bind(window) : null };
  var mutation = function (method, url) {
    try {
      var path = new URL(String(url), location.href).pathname;
      if (!/\/cart(\/|\.js|\.json|$)/.test(path)) return false;
      return String(method || 'GET').toUpperCase() !== 'GET' || /\/cart\/(change|update|add|clear)/.test(path);
    } catch (e) { return false; }
  };
  if (hook.origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || 'GET';
      if (mutation(method, url)) hook.calls.push({ via: 'fetch', method: String(method).toUpperCase(), url: String(url) });
      return hook.origFetch(input, init);
    };
  }
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__antifanCart = { method: method, url: url }; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var info = this.__antifanCart;
    if (info && mutation(info.method, info.url)) hook.calls.push({ via: 'xhr', method: String(info.method).toUpperCase(), url: String(info.url) });
    return send.apply(this, arguments);
  };
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var action = (form && form.getAttribute && form.getAttribute('action')) || location.pathname;
    var method = (form && form.method) || 'POST';
    if (mutation(method, action)) hook.calls.push({ via: 'form', method: String(method).toUpperCase(), url: String(action) });
  }, true);
  return true;
})()`;

/** Reads /cart.js, finds the controls and tags the quantity and remove ones so a click can address them. */
export function buildCartStateScript(): string {
  return `(async () => {
${CART_PAGE_HELPERS}
var CTL = ${JSON.stringify(CTL_ATTR)};
try {
  var onCartRoute = /(^|\\/)cart\\/?$/.test(location.pathname);
  var cart = await readCart();
  var scope = document.querySelector('main, #MainContent, [role="main"]') || document.body;
  Array.prototype.forEach.call(document.querySelectorAll('[' + CTL + ']'), function (n) { n.removeAttribute(CTL); });
  // A control is classified from signals of its own: its text, name, data attributes, class, id and the
  // first word of its aria-label. The title and the rest of the label are left out because themes append
  // the product title ("Decrease quantity for Plus Size Dress"), which would vote for another kind.
  var tokens = function (el) {
    var label = norm(el.getAttribute('aria-label') || '').split(/[^a-z0-9]+/).filter(Boolean).slice(0, 1).join(' ');
    var bits = [label, el.getAttribute('name'), el.getAttribute('data-action'), el.getAttribute('data-qty-change'), typeof el.className === 'string' ? el.className : '', el.id];
    ['cart-plus', 'cart-minus', 'cart-remove'].forEach(function (a) { if (el.hasAttribute('data-' + a)) bits.push(a.replace('cart-', '')); });
    return norm(bits.filter(Boolean).join(' ')).split(/[^a-z0-9]+/).filter(Boolean);
  };
  var has = function (toks, words) { return words.some(function (w) { return toks.indexOf(w) !== -1; }); };
  var isCheckout = function (el) {
    var text = norm(el.textContent || el.value || '');
    var toks = tokens(el);
    return el.getAttribute('name') === 'checkout' || has(toks, ['checkout']) || /^(checkout|thanh toan|dat hang|mua hang|tien hanh dat hang)/.test(text) || (el.tagName === 'A' && /checkout/.test(el.getAttribute('href') || ''));
  };
  var clearsWholeCart = function (el) {
    var text = norm((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '').split(/\\s+/).slice(0, 3).join(' '));
    return has(tokens(el), ['clear', 'empty', 'all', 'clearall']) || /(^| )(clear|empty)( |$)|remove all|delete all|xoa tat ca|xoa het|lam trong gio/.test(text);
  };
  var kindsOf = function (el) {
    var raw = (el.textContent || el.value || '').trim();
    var toks = tokens(el);
    var kinds = [];
    if (['+', '\\uff0b'].indexOf(raw) !== -1 || has(toks, ['plus', 'increase', 'increment', 'tang'])) kinds.push('plus');
    if (['-', '\\u2212', '\\u2013', '\\u2014'].indexOf(raw) !== -1 || has(toks, ['minus', 'decrease', 'decrement', 'giam'])) kinds.push('minus');
    if (['\\u00d7', '\\u2715', '\\u2716', '\\u2717', 'x'].indexOf(raw.toLowerCase()) !== -1 || has(toks, ['remove', 'delete', 'xoa']) || /quantity=0/.test(el.getAttribute('href') || '')) kinds.push('remove');
    return kinds;
  };
  // The cart line a control belongs to, read from a line key or a 1-based line index on the control or
  // one of its ancestors; null when the markup does not say.
  var lineKeyOf = function (el) {
    var keys = cart.items.map(function (i) { return i.key; });
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++, cur = cur.parentElement) {
      var attrs = cur.attributes;
      for (var a = 0; a < attrs.length; a++) {
        var name = attrs[a].name;
        var value = String(attrs[a].value || '');
        if (name === CTL) continue;
        for (var k = 0; k < keys.length; k++) {
          if (keys[k].length >= 6 && (value === keys[k] || value.indexOf(keys[k]) !== -1)) return keys[k];
        }
        var index = 0;
        if ((name === 'data-line' || name === 'data-index') && /^[0-9]+$/.test(value)) index = Number(value);
        else if (name === 'href') { var m = /[?&]line=([0-9]+)/.exec(value); if (m) index = Number(m[1]); }
        if (index >= 1 && index <= keys.length) return keys[index - 1];
      }
      if (cur === scope) break;
    }
    return null;
  };
  var found = { plus: [], minus: [], remove: [] };
  Array.prototype.forEach.call(scope.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], [data-cart-plus], [data-cart-minus], [data-cart-remove]'), function (el) {
    if (hidden(el) || el.closest('header, footer, nav') || isCheckout(el) || clearsWholeCart(el)) return;
    var kinds = kindsOf(el);
    if (kinds.length === 1) found[kinds[0]].push(el);
  });
  var tagged = {};
  ['plus', 'minus', 'remove'].forEach(function (kind) {
    tagged[kind] = found[kind].map(function (el, i) {
      var tag = kind + '-' + i;
      el.setAttribute(CTL, tag);
      return { tag: tag, label: describe(el), lineKey: lineKeyOf(el) };
    });
  });
  var quantityInput = Array.prototype.filter.call(scope.querySelectorAll('input[name^="updates"], input[name="quantity"], input[data-quantity-input], input[type="number"], input[class*="qty"], input[class*="quantity"]'), function (el) {
    return el.type !== 'hidden' && !hidden(el);
  }).length;
  var targets = [];
  var seen = [];
  Array.prototype.forEach.call(document.querySelectorAll('[name="checkout"], [data-checkout], a, button, input[type="submit"], [role="button"]'), function (el) {
    if (hidden(el) || el.closest('header, footer, nav') || !isCheckout(el) || seen.indexOf(el) !== -1) return;
    seen.push(el);
    var kind = 'script';
    var raw = null;
    if (el.tagName === 'A') { kind = 'href'; raw = el.getAttribute('href'); if (raw == null) raw = ''; }
    else if (el.getAttribute('formaction') != null) { kind = 'formaction'; raw = el.getAttribute('formaction'); }
    else {
      var form = el.form || el.closest('form');
      if (form) {
        var action = form.getAttribute('action');
        if (action == null) { kind = 'form-default'; raw = null; } else { kind = 'form-action'; raw = action; }
      } else {
        var dataHref = el.getAttribute('data-href') || el.getAttribute('data-url');
        if (dataHref != null) { kind = 'data-href'; raw = dataHref; }
      }
    }
    var valid = null;
    if (kind === 'form-default') valid = true;
    else if (raw !== null) {
      var t = String(raw).trim();
      valid = !(t === '' || t === '#' || /\\[object object\\]|undefined|(^|[\\/=?&])null($|[\\/=?&])/i.test(t));
    }
    targets.push({ selector: describe(el), kind: kind, target: raw, valid: valid });
  });
  return { ok: true, isCartPage: onCartRoute, cart: cart, controls: { plus: tagged.plus, minus: tagged.minus, remove: tagged.remove, quantityInput: quantityInput, checkout: targets } };
} catch (err) {
  return { ok: false, error: String(err && err.message || err) };
}
})()`;
}

/** Reads what the page sent to the cart endpoints since the hook was installed or last reset, and the cart itself. */
export function buildCartObserveScript(): string {
  return `(async () => {
${CART_PAGE_HELPERS}
var hook = window.__antifanCartHook;
if (!hook) return { hookAlive: false, calls: [], cart: null };
var cart = null;
try { cart = await readCart(); } catch (err) { cart = null; }
return { hookAlive: true, calls: hook.calls.slice(0, 20), cart: cart };
})()`;
}

/** Puts a line back to its original quantity (or adds a removed line again) without touching any theme control. */
export function buildCartRestoreScript(mode: 'quantity' | 'readd', line: { key: string; variantId: number | string | null; quantity: number; properties: Record<string, unknown> | null }): string {
  return `(async () => {
${CART_PAGE_HELPERS}
var line = ${JSON.stringify(line)};
var mode = ${JSON.stringify(mode)};
try {
  var hook = window.__antifanCartHook;
  var f = hook && hook.origFetch ? hook.origFetch : window.fetch.bind(window);
  var url = mode === 'quantity' ? '/cart/change.js' : '/cart/add.js';
  var body = mode === 'quantity' ? { id: line.key, quantity: line.quantity } : { id: line.variantId, quantity: line.quantity, properties: line.properties || undefined };
  var res = await f(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  return res.ok ? { ok: true } : { ok: false, error: url + ' answered HTTP ' + res.status };
} catch (err) {
  return { ok: false, error: String(err && err.message || err) };
}
})()`;
}

function emptyData(itemCount = 0): CartContractData {
  return { itemCount, exercised: false, controls: { plus: 0, minus: 0, remove: 0, quantityInput: 0, checkout: 0 }, checkoutTargets: [], steps: [], restored: null };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function quantityOf(cart: CartSnapshot | null | undefined, key: string, index: number): number | null {
  if (!cart) return null;
  const byKey = cart.items.find((line) => line.key === key);
  if (byKey) return byKey.quantity;
  return cart.items[index]?.quantity ?? null;
}

async function readState(deps: ProbeDeps): Promise<CartStateResult> {
  try {
    return (await deps.evalJs(buildCartStateScript())) as CartStateResult;
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

interface ClickOutcome {
  step: CartExerciseStep;
  cartAfter: CartSnapshot | null;
}

/** Click one tagged control and wait for the cart request it should send and the quantity it should change. */
async function clickAndObserve(
  deps: ProbeDeps,
  control: CartExerciseStep['control'],
  tag: string,
  key: string,
  lineIndex: number,
  before: CartSnapshot
): Promise<ClickOutcome> {
  const quantityBefore = quantityOf(before, key, lineIndex);
  const step: CartExerciseStep = { control, clicked: false, requestMade: false, navigated: false, requests: [], quantityBefore, quantityAfter: null };
  await deps.evalJs(INSTALL_HOOK_SOURCE);
  const click = await deps.click(`[${CTL_ATTR}="${tag}"]`);
  if (!click.ok) {
    step.error = click.error ?? `click on the ${control} control was not delivered`;
    return { step, cartAfter: null };
  }
  step.clicked = true;
  let observed: CartObserveResult | null = null;
  for (let round = 0; round < POLL_ROUNDS; round++) {
    await deps.wait(POLL_MS);
    try {
      observed = (await deps.evalJs(buildCartObserveScript())) as CartObserveResult | null;
    } catch {
      // An evaluation that lands while the document is being replaced throws: the page navigated.
      observed = null;
    }
    if (!observed || observed.hookAlive !== true) {
      // The document was replaced: a form post or a link to /cart/change navigated the page.
      step.navigated = true;
      break;
    }
    const changed = observed.cart !== null && quantityOf(observed.cart, key, lineIndex) !== quantityBefore;
    if (observed.calls.length > 0 && (changed || round >= 2)) break;
  }
  if (step.navigated) {
    const after = await readState(deps);
    step.requestMade = true;
    step.quantityAfter = after.ok ? quantityOf(after.cart, key, lineIndex) : null;
    return { step, cartAfter: after.ok && after.cart ? after.cart : null };
  }
  step.requests = (observed?.calls ?? []).map((call) => `${call.via} ${call.method} ${call.url}`);
  step.requestMade = step.requests.length > 0;
  step.quantityAfter = quantityOf(observed?.cart, key, lineIndex);
  return { step, cartAfter: observed?.cart ?? null };
}

function stepFindings(step: CartExerciseStep, label: string): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  if (!step.clicked) {
    out.push({
      ruleId: 'cart-control-click-failed',
      severity: 'warning',
      selector: label,
      message: `The cart ${step.control} control ${label} could not be clicked: ${step.error ?? 'click was not delivered'}`,
    });
    return out;
  }
  if (!step.requestMade) {
    out.push({
      ruleId: 'cart-control-no-request',
      severity: 'critical',
      selector: label,
      message: `Clicking the cart ${step.control} control ${label} sent no request to the cart (no /cart/change, /cart/update, form post or navigation)`,
      measured: { quantityBefore: step.quantityBefore, quantityAfter: step.quantityAfter },
    });
    return out;
  }
  if (step.control === 'remove') return out;
  const delta = step.control === 'plus' ? 1 : -1;
  if (step.quantityBefore !== null && step.quantityAfter !== null && step.quantityAfter !== step.quantityBefore + delta) {
    out.push({
      ruleId: 'cart-control-quantity-mismatch',
      severity: 'warning',
      selector: label,
      message: `The cart ${step.control} control ${label} sent a request but the quantity went from ${step.quantityBefore} to ${step.quantityAfter} (expected ${step.quantityBefore + delta}); a stock limit can explain this`,
      measured: { quantityBefore: step.quantityBefore, quantityAfter: step.quantityAfter, expected: step.quantityBefore + delta },
    });
  }
  return out;
}

export async function runCartContract(deps: ProbeDeps, opts: CartContractOptions = {}): Promise<ProbeResult<CartContractData>> {
  const state = await readState(deps);
  if (!state || state.ok !== true || !state.cart || !state.controls) {
    return { measured: false, passed: null, findings: [], data: emptyData(), error: state?.error ? `cart state could not be read: ${state.error}` : 'cart contract script returned no result' };
  }
  const { cart, controls } = state;
  if (state.isCartPage !== true) {
    return { measured: false, passed: null, findings: [], data: emptyData(cart.itemCount), error: 'current page is not the cart page' };
  }
  if (cart.itemCount === 0) {
    return {
      measured: false,
      passed: null,
      findings: [{
        ruleId: 'QA_EMPTY_CART_NOT_EXERCISED',
        severity: 'info',
        message: 'The cart is empty, so its quantity, remove and checkout controls were not exercised. The probe never adds items: put a product in the cart and run it again.',
      }],
      data: emptyData(0),
    };
  }

  const findings: ProbeFinding[] = [];
  const data: CartContractData = {
    itemCount: cart.itemCount,
    exercised: false,
    controls: {
      plus: controls.plus.length,
      minus: controls.minus.length,
      remove: controls.remove.length,
      quantityInput: controls.quantityInput,
      checkout: controls.checkout.length,
    },
    checkoutTargets: controls.checkout,
    steps: [],
    restored: null,
  };

  if (controls.plus.length + controls.minus.length === 0 && controls.quantityInput === 0) {
    findings.push({ ruleId: 'cart-quantity-control-missing', severity: 'warning', message: 'The cart page has items but no quantity control (no + / − button and no quantity input)' });
  }
  if (controls.remove.length === 0) {
    findings.push({ ruleId: 'cart-remove-control-missing', severity: 'warning', message: 'The cart page has items but no remove control' });
  }
  if (controls.checkout.length === 0) {
    findings.push({ ruleId: 'cart-checkout-missing', severity: 'critical', message: 'The cart page has items but no checkout button or link' });
  }
  for (const target of controls.checkout) {
    if (target.valid === false) {
      findings.push({
        ruleId: 'checkout-target-invalid',
        severity: 'critical',
        selector: target.selector,
        message: `The checkout control ${target.selector} points at ${JSON.stringify(target.target ?? '')} (${target.kind}), which is not a usable checkout target`,
        measured: { kind: target.kind, target: target.target },
      });
    }
  }

  if (opts.exerciseCart === true) {
    data.exercised = true;
    await exerciseCart(deps, cart, opts.allowRemove === true, data, findings);
  }

  return {
    measured: true,
    passed: !findings.some((f) => f.severity === 'critical'),
    findings,
    data,
  };
}

type RestoreOutcome = 'not-needed' | 'direct' | 'failed';

const RESTORE_RANK: Record<RestoreOutcome, number> = { 'not-needed': 0, direct: 1, failed: 2 };

function worseRestore(a: RestoreOutcome | null, b: RestoreOutcome | null): RestoreOutcome | null {
  if (!a) return b;
  if (!b) return a;
  return RESTORE_RANK[b] > RESTORE_RANK[a] ? b : a;
}

/**
 * The control that acts on one cart line. A control that names its line (a line key or index in its
 * own markup) is used for that line only. Without any such marker the controls are taken in cart
 * order when there is one per line, or as the only control of a one-line cart; any other layout cannot
 * be matched, and clicking a guessed control could change a different line.
 */
function pickControl(controls: TaggedControl[], cart: CartSnapshot, line: CartLine, lineIndex: number): TaggedControl | null {
  const named = controls.find((c) => c.lineKey === line.key);
  if (named) return named;
  if (controls.some((c) => typeof c.lineKey === 'string')) return null;
  if (cart.items.length === 1) return controls[0] ?? null;
  if (controls.length === cart.items.length) return controls[lineIndex] ?? null;
  return null;
}

function lineUnknownFinding(kind: CartExerciseStep['control']): ProbeFinding {
  return {
    ruleId: 'cart-control-line-unknown',
    severity: 'info',
    message: `The ${kind} controls on the page could not be matched to the first cart line, so none was clicked`,
  };
}

/** Click + then − on the first line, put the cart back, and (with allowRemove) exercise the remove control. */
async function exerciseCart(deps: ProbeDeps, cart: CartSnapshot, allowRemove: boolean, data: CartContractData, findings: ProbeFinding[]): Promise<void> {
  const first = cart.items[0];
  if (!first) return;
  try {
    for (const kind of ['plus', 'minus'] as const) {
      const fresh = await readState(deps);
      if (!fresh.ok || !fresh.cart || !fresh.controls) {
        findings.push({ ruleId: 'cart-control-click-failed', severity: 'warning', message: `The cart could not be re-read before the ${kind} click: ${fresh.error ?? 'no result'}` });
        break;
      }
      const control = pickControl(fresh.controls[kind], fresh.cart, first, 0);
      if (!control) {
        if (fresh.controls[kind].length > 0) findings.push(lineUnknownFinding(kind));
        continue;
      }
      const quantity = quantityOf(fresh.cart, first.key, 0);
      if (kind === 'minus' && (quantity === null || quantity < 2)) {
        // At quantity 1 the − control removes the line: that is the remove control's click, not this one's.
        data.steps.push({ control: kind, clicked: false, requestMade: false, navigated: false, requests: [], quantityBefore: quantity, quantityAfter: null, skipped: 'quantity-1' });
        findings.push({ ruleId: 'cart-minus-not-exercised', severity: 'info', selector: control.label, message: 'The − control was not clicked: the line is at quantity 1 and − would remove it' });
        continue;
      }
      const outcome = await clickAndObserve(deps, kind, control.tag, first.key, 0, fresh.cart);
      data.steps.push(outcome.step);
      findings.push(...stepFindings(outcome.step, control.label));
    }
    data.restored = await restoreCart(deps, cart, findings);
    if (allowRemove) data.restored = worseRestore(data.restored, await exerciseRemove(deps, data, findings));
  } catch (err) {
    findings.push({ ruleId: 'cart-exercise-aborted', severity: 'warning', message: `The cart exercise stopped: ${errorText(err)}` });
    data.restored = await restoreCart(deps, cart, findings).catch(() => 'failed' as const);
  }
}

/**
 * Put every line of the baseline cart back: a line whose quantity moved is set back, a line that went
 * missing (a remove control, or a button that clears the whole cart) is added again.
 */
async function restoreCart(deps: ProbeDeps, baseline: CartSnapshot, findings: ProbeFinding[]): Promise<RestoreOutcome> {
  const now = await readState(deps);
  if (!now.ok || !now.cart) {
    findings.push({
      ruleId: 'cart-restore-failed',
      severity: 'critical',
      message: `The cart could not be re-read to check that it was put back: ${now.error ?? 'no result'}. Compare it with the cart you had by hand.`,
    });
    return 'failed';
  }
  const failures: string[] = [];
  let changed = false;
  for (const line of baseline.items) {
    const current = now.cart.items.find((l) => l.key === line.key);
    if (current && current.quantity === line.quantity) continue;
    changed = true;
    let restored: CartRestoreResult | null;
    try {
      restored = (await deps.evalJs(buildCartRestoreScript(current ? 'quantity' : 'readd', line))) as CartRestoreResult | null;
    } catch (err) {
      restored = { ok: false, error: errorText(err) };
    }
    if (restored?.ok !== true) failures.push(`variant ${String(line.variantId)} (quantity ${line.quantity}): ${restored?.error ?? 'restore request failed'}`);
  }
  if (failures.length > 0) {
    findings.push({
      ruleId: 'cart-restore-failed',
      severity: 'critical',
      message: `The cart was not put back as the probe found it: ${failures.join('; ')}. Put it back by hand.`,
    });
    return 'failed';
  }
  return changed ? 'direct' : 'not-needed';
}

async function exerciseRemove(deps: ProbeDeps, data: CartContractData, findings: ProbeFinding[]): Promise<RestoreOutcome | null> {
  const fresh = await readState(deps);
  if (!fresh.ok || !fresh.cart || !fresh.controls || fresh.cart.items.length === 0) return null;
  const line = fresh.cart.items[0];
  if (!line) return null;
  const control = pickControl(fresh.controls.remove, fresh.cart, line, 0);
  if (!control) {
    if (fresh.controls.remove.length > 0) findings.push(lineUnknownFinding('remove'));
    return null;
  }
  const linesBefore = fresh.cart.items.length;
  const outcome = await clickAndObserve(deps, 'remove', control.tag, line.key, 0, fresh.cart);
  data.steps.push(outcome.step);
  findings.push(...stepFindings(outcome.step, control.label));
  const after = outcome.cartAfter ?? (await readState(deps)).cart ?? null;
  const stillThere = after ? after.items.some((l) => l.key === line.key) : true;
  if (outcome.step.requestMade && stillThere && after && after.items.length >= linesBefore) {
    findings.push({
      ruleId: 'cart-control-quantity-mismatch',
      severity: 'warning',
      selector: control.label,
      message: `The cart remove control ${control.label} sent a request but the line is still in the cart`,
    });
  }
  return restoreCart(deps, fresh.cart, findings);
}
