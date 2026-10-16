import type { ProbeDeps, ProbeFinding, ProbeResult } from './probe-deps';
import { PDP_PAGE_HELPERS_SOURCE } from './pdp-page-helpers';

export interface PdpContractData {
  missing: string[];
  present: string[];
  hasSizeOption: boolean;
}

interface PdpContractPageResult {
  ok: boolean;
  isPdp: boolean;
  productKnown: boolean;
  present: string[];
  missing: string[];
  hasSizeOption: boolean;
  variantSelectorMissingFor: string[];
}

const MISSING_SEVERITY: Record<string, ProbeFinding['severity']> = {
  'size-guide': 'critical',
  'variant-selector': 'critical',
  'add-to-cart': 'critical',
  price: 'critical',
  quantity: 'warning',
  'buy-now': 'warning',
  'compare-at': 'warning',
  availability: 'warning',
  breadcrumb: 'warning',
  sku: 'info',
  related: 'info',
};

const MISSING_LABEL: Record<string, string> = {
  'size-guide': 'size guide opener (the product has a size option)',
  'variant-selector': 'variant selector for every product option',
  quantity: 'quantity input',
  'add-to-cart': 'add-to-cart button',
  'buy-now': 'buy-now button',
  price: 'price',
  'compare-at': 'compare-at price (the product is on sale)',
  sku: 'SKU',
  availability: 'availability / stock status',
  breadcrumb: 'breadcrumb',
  related: 'related products block',
};

/** Page-side script: resolves the product, checks every PDP contract element and returns plain JSON. */
export function buildPdpContractScript(): string {
  return `(async () => {
${PDP_PAGE_HELPERS_SOURCE}
var scope = document.querySelector('main, #MainContent, [role="main"]') || document.body;
var scopeTextCache = null;
function scopeText() { if (scopeTextCache === null) scopeTextCache = norm(scope.textContent || ''); return scopeTextCache; }
function digitText(el) { return /\\d/.test((el.textContent || '') + ' ' + (el.getAttribute('content') || '') + ' ' + (el.getAttribute('data-price') || '')); }
function anyMatch(selector, predicate) {
  var els = scope.querySelectorAll(selector);
  for (var i = 0; i < els.length; i++) if (predicate(els[i])) return true;
  return false;
}
function interactiveText(el) {
  return norm([el.textContent, el.value, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
}
var INTERACTIVE = 'button,input[type=submit],a,[role=button]';
var form = document.querySelector('form[action*="/cart/add"]');
var isPdp = !!currentHandle() || !!document.querySelector('meta[property="og:type"][content="product"]') || !!form;
var product = isPdp ? await loadProduct(null) : null;
var present = [];
var missing = [];
var variantSelectorMissingFor = [];
function mark(key, found, required) {
  if (found) present.push(key);
  else if (required) missing.push(key);
}
if (!isPdp) return { ok: true, isPdp: false, productKnown: false, present: present, missing: missing, hasSizeOption: false, variantSelectorMissingFor: [] };

var options = product ? product.options : null;
var optionNames = options ? options.map(function (o) { return o.name; }) : [];
if (!options) {
  Array.prototype.forEach.call(document.querySelectorAll('[data-option-name]'), function (el) { optionNames.push(el.getAttribute('data-option-name')); });
  Array.prototype.forEach.call(document.querySelectorAll('.selector-wrapper label, fieldset legend, [class*=option-name]'), function (el) { optionNames.push((el.textContent || '').split(':')[0]); });
}
var hasSizeOption = optionNames.some(isSizeOptionName);

mark('add-to-cart',
  !!(form && form.querySelector('[name="add"],[data-add-to-cart],.add-to-cart,#add-to-cart,[data-role="add-to-cart"]')) ||
    anyMatch(INTERACTIVE, function (el) { return /(them vao gio|add to cart|add-to-cart)/.test(interactiveText(el)); }),
  true);
mark('buy-now',
  !!scope.querySelector('[data-buy-now],.buy-now,.btn-buy-now,#buy-now,[data-role="buy-now"],.shopify-payment-button') ||
    anyMatch(INTERACTIVE, function (el) { return /(mua ngay|buy it now|buy now|mua lien)/.test(interactiveText(el)); }),
  true);
mark('quantity', !!scope.querySelector('input[name="quantity"],[data-quantity-input],.quantity input,input[type=number][name*="qty"],[data-role="quantity"]'), true);
mark('price', anyMatch('[data-price],[data-product-price],.price,.product-price,.product__price,[itemprop="price"],.price-current,#ProductPrice,[data-role="price"]', digitText), true);

var formId = readFormVariantId();
var selectedVariant = null;
if (product) {
  selectedVariant = product.variants.filter(function (v) { return String(v.id) === String(formId); })[0] || product.variants[0] || null;
}
var onSale = !!(selectedVariant && selectedVariant.compareAt > selectedVariant.price);
var compareFound = anyMatch('.compare-at-price,.price-compare,.product-price-compare,[data-compare-price],[data-compare-at-price],.price--compare,.was-price,[data-role="compare-at"],.price del,.price s,del.price', digitText);
mark('compare-at', compareFound, onSale);

var skuExpected = !!(product && product.variants.some(function (v) { return v.sku; }));
var skuFound = anyMatch('[data-sku],.sku,.product-sku,#sku,[itemprop="sku"],[data-role="sku"]', function (el) { return norm(el.textContent || el.getAttribute('content') || '').length > 0; }) ||
  /(^|\\s)(sku|ma san pham|ma sp|ma hang)\\s*:/.test(scopeText());
mark('sku', skuFound, skuExpected);

mark('availability',
  !!scope.querySelector('[data-availability],.availability,.product-availability,.stock-status,.inventory,[itemprop="availability"],[data-role="availability"]') ||
    /(tinh trang|con hang|het hang|in stock|out of stock|sold out)/.test(scopeText()),
  true);
mark('breadcrumb', !!document.querySelector('nav[aria-label*="readcrumb" i],.breadcrumb,.breadcrumbs,[class*="breadcrumb"],[itemtype*="BreadcrumbList"],[data-breadcrumb]'), true);

var relatedFound = anyMatch('[class*="related"],[data-related],[id*="related"],[class*="recommend"],[data-section-type*="related"]', function (el) { return !!el.querySelector('a[href*="/products/"]'); });
if (!relatedFound) {
  relatedFound = Array.prototype.some.call(document.querySelectorAll('h2,h3,h4,.section-title'), function (h) {
    if (!/(san pham (lien quan|tuong tu|cung loai|khac)|related products|you may also like|co the ban (cung )?thich)/.test(norm(h.textContent || ''))) return false;
    var block = h.closest('section') || h.parentElement;
    return !!(block && block.querySelector('a[href*="/products/"]'));
  });
}
mark('related', relatedFound, true);

var SIZE_GUIDE_RE = /(size[ -]?(guide|chart)|sizeguide|bang (size|kich (thuoc|co))|huong dan (chon )?(size|kich|co)|bang quy doi)/;
var sizeGuideFound = anyMatch(INTERACTIVE + ',summary,[data-size-guide],[data-role*="size-guide"],[aria-controls]', function (el) {
  var bits = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('href'), el.getAttribute('aria-controls'), el.getAttribute('data-role'), el.getAttribute('data-size-guide') != null ? 'size-guide' : '', el.getAttribute('class'), el.id];
  return SIZE_GUIDE_RE.test(norm(bits.filter(Boolean).join(' ')));
});
mark('size-guide', sizeGuideFound, hasSizeOption);

if (options) {
  if (options.length > 0) {
    var wholeVariantSelect = !!scope.querySelector('select[name="id"],[data-variant-select]');
    options.forEach(function (opt, idx) {
      if (!findOptionControls(opt, idx) && !wholeVariantSelect) variantSelectorMissingFor.push(opt.name);
    });
    mark('variant-selector', variantSelectorMissingFor.length === 0, true);
  }
} else {
  mark('variant-selector', !!scope.querySelector('select:not([name="id"]):not([name="quantity"]),select[name="id"],input[type=radio],[data-option-name],[data-option-position]'), false);
}
return { ok: true, isPdp: true, productKnown: !!product, present: present, missing: missing, hasSizeOption: hasSizeOption, variantSelectorMissingFor: variantSelectorMissingFor };
})()`;
}

function emptyData(): PdpContractData {
  return { missing: [], present: [], hasSizeOption: false };
}

export async function runPdpContract(deps: ProbeDeps): Promise<ProbeResult<PdpContractData>> {
  let page: PdpContractPageResult;
  try {
    page = (await deps.evalJs(buildPdpContractScript())) as PdpContractPageResult;
  } catch (err) {
    return { measured: false, passed: null, findings: [], data: emptyData(), error: err instanceof Error ? err.message : String(err) };
  }
  if (!page || page.ok !== true) {
    return { measured: false, passed: null, findings: [], data: emptyData(), error: 'PDP contract script returned no result' };
  }
  if (!page.isPdp) {
    return { measured: false, passed: null, findings: [], data: emptyData(), error: 'current page is not a product page' };
  }
  const findings: ProbeFinding[] = page.missing.map((key) => ({
    ruleId: `pdp-contract-missing-${key}`,
    severity: MISSING_SEVERITY[key] ?? 'warning',
    message: `Product page is missing the ${MISSING_LABEL[key] ?? key}`,
    measured: key === 'variant-selector' ? { options: page.variantSelectorMissingFor } : undefined,
  }));
  return {
    measured: true,
    passed: !findings.some((f) => f.severity === 'critical'),
    findings,
    data: { missing: page.missing, present: page.present, hasSizeOption: page.hasSizeOption },
  };
}
