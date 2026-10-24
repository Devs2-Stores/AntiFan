/**
 * Page-side helper source shared by the PDP probe scripts. It is spliced into
 * an async IIFE that runs inside the storefront page (and inside jsdom in
 * tests), so it is plain ES2017 with no TypeScript and no template literals.
 */
export const PDP_PAGE_HELPERS_SOURCE = String.raw`
function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd').replace(/\s+/g, ' ').trim();
}
function escapeRe(s) { return s.replace(/[.*+?^$|()\[\]{}\\\/-]/g, '\\$&'); }
function imageKey(u) {
  if (!u) return null;
  var s = String(u);
  if (s.indexOf('data:') === 0) return null;
  s = s.split('#')[0].split('?')[0];
  var seg = s.split('/').pop();
  try { seg = decodeURIComponent(seg); } catch (e) {}
  seg = seg.toLowerCase().replace(/\.(jpe?g|png|webp|gif|avif|svg)$/, '');
  var prev;
  do {
    prev = seg;
    seg = seg.replace(/(_(pico|icon|thumb|small|compact|medium|large|grande|master|original|crop_[a-z]+|\d+x\d*|x\d+)|@\dx)$/, '');
  } while (seg !== prev);
  return seg || null;
}
function isSizeOptionName(name) {
  var n = norm(name);
  return /^(size|kich thuoc|kich co)\b/.test(n) || /\bsize\b/.test(n) || n === 'co' || /^co (so|giay|ao|quan|nhan|vong|tay)\b/.test(n);
}
function isColourOptionName(name) {
  return /(^|\b)(mau|mau sac|color|colour)(\b|$)/.test(norm(name));
}
function variantImageUrl(v) {
  var f = v && v.featured_image;
  if (!f) return null;
  if (typeof f === 'string') return f;
  return f.src || f.url || null;
}
function normalizeProduct(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.variants)) return null;
  var variants = p.variants;
  var rawOptions = Array.isArray(p.options) ? p.options : [];
  var options = rawOptions.map(function (o, i) {
    var name = typeof o === 'string' ? o : (o && o.name) || ('Option ' + (i + 1));
    var values = [];
    if (o && typeof o === 'object' && Array.isArray(o.values)) values = o.values.slice();
    if (!values.length) {
      variants.forEach(function (v) {
        var val = variantOptionValue(v, i);
        if (val != null && values.indexOf(val) < 0) values.push(val);
      });
    }
    return { name: String(name), values: values.map(String) };
  });
  if (options.length === 1 && norm(options[0].name) === 'title' && options[0].values.length === 1 && norm(options[0].values[0]) === 'default title') options = [];
  return {
    handle: p.handle || null,
    options: options,
    variants: variants.map(function (v) {
      var img = variantImageUrl(v);
      return {
        id: v.id,
        sku: v.sku || '',
        available: v.available !== false,
        price: Number(v.price) || 0,
        compareAt: Number(v.compare_at_price) || 0,
        imageUrl: img,
        imageKey: imageKey(img),
        options: options.map(function (o, i) { var val = variantOptionValue(v, i); return val == null ? null : String(val); })
      };
    })
  };
}
function variantOptionValue(v, i) {
  if (Array.isArray(v.options) && v.options[i] != null) return v.options[i];
  var k = 'option' + (i + 1);
  return v[k] != null ? v[k] : null;
}
function currentHandle() {
  var m = location.pathname.match(/\/products\/([^\/?#]+)/);
  // Sapo serves a product at its bare alias ("/giay-derby-nam") and marks the page og:type=product.
  if (!m && document.querySelector('meta[property="og:type"][content="product"]')) m = location.pathname.match(/^\/([^\/?#]+)\/?$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}
async function loadProduct(hint) {
  var handle = hint || currentHandle();
  var raw = null;
  if (handle && typeof fetch === 'function') {
    try {
      var res = await fetch('/products/' + encodeURIComponent(handle) + '.js', { credentials: 'same-origin' });
      if (res && res.ok) raw = await res.json();
    } catch (e) {}
  }
  if (!raw) {
    var el = document.querySelector('script[type="application/json"][data-product-json], script[type="application/json"][id*="ProductJson"], script[type="application/json"][data-product]');
    if (el && el.textContent) {
      try { var parsed = JSON.parse(el.textContent); raw = Array.isArray(parsed) ? parsed[0] : parsed; } catch (e) {}
    }
  }
  if (!raw && window.meta && window.meta.product) raw = window.meta.product;
  if (!raw && window.product) raw = window.product;
  return normalizeProduct(raw);
}
function labelsFor(el) {
  var out = [];
  if (el.id) {
    Array.prototype.forEach.call(document.querySelectorAll('label[for]'), function (l) { if (l.getAttribute('for') === el.id) out.push(l); });
  }
  var wrap = el.closest ? el.closest('label') : null;
  if (wrap && out.indexOf(wrap) < 0) out.push(wrap);
  return out;
}
function valueTexts(el) {
  var out = [];
  ['data-value', 'data-option-value', 'data-name', 'value', 'title', 'aria-label', 'data-title', 'data-color', 'data-variant-title'].forEach(function (a) {
    var v = el.getAttribute && el.getAttribute(a);
    if (v) out.push(v);
  });
  labelsFor(el).forEach(function (l) {
    out.push(l.textContent);
    ['data-value', 'title', 'aria-label'].forEach(function (a) { var v = l.getAttribute(a); if (v) out.push(v); });
  });
  out.push(el.textContent);
  var img = el.querySelector ? el.querySelector('img[alt]') : null;
  if (img) out.push(img.getAttribute('alt'));
  return out.map(norm).filter(Boolean);
}
function isUnsafeControl(el) {
  var tag = el.tagName;
  if (tag === 'BUTTON' && String(el.type || '').toLowerCase() === 'submit') return true;
  if (tag === 'INPUT' && /^(submit|image)$/i.test(el.type || '')) return true;
  if (tag === 'A') {
    var href = el.getAttribute('href');
    if (href && href.charAt(0) !== '#' && href.indexOf('javascript:') !== 0) return true;
  }
  var t = norm((el.textContent || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '') + ' ' + (el.getAttribute('data-action') || ''));
  return /(add to cart|add-to-cart|addtocart|them vao gio|mua ngay|buy now|buy-now|buynow|checkout|thanh toan|dat hang)/.test(t);
}
var CONTROL_SELECTOR = 'input[type=radio],input[type=checkbox],button,[role=radio],[data-value],[data-option-value]';
function candidateControls(container) {
  var list = Array.prototype.slice.call(container.querySelectorAll(CONTROL_SELECTOR));
  return list.filter(function (el) { return !isUnsafeControl(el); });
}
function matchesOptionAttrs(el, opt, idx) {
  var pos = String(idx + 1);
  var nName = norm(opt.name);
  var n = el.getAttribute('data-option-name');
  if (n != null && norm(n) === nName) return true;
  var p = el.getAttribute('data-option-position');
  if (p != null && String(p) === pos) return true;
  var i = el.getAttribute('data-option-index');
  if (i != null && String(i) === String(idx)) return true;
  return false;
}
function nameMatchesOption(attr, opt, idx) {
  var n = norm(attr);
  if (!n) return false;
  var re = new RegExp('(^|[^a-z0-9])' + escapeRe(norm(opt.name)) + '([^a-z0-9]|$)');
  if (re.test(n)) return true;
  return new RegExp('option[^a-z0-9]*0*' + (idx + 1) + '([^0-9]|$)').test(n);
}
function labelledContainerText(c) {
  var head = c.querySelector('legend,label,[class*=title],[class*=label],[class*=name],[class*=header],h3,h4,h5');
  if (!head) return '';
  return norm(head.textContent).split(':')[0].trim();
}
function findOptionControls(opt, idx) {
  var selects = Array.prototype.filter.call(document.querySelectorAll('select'), function (s) {
    if (s.getAttribute('name') === 'id' || s.getAttribute('name') === 'quantity') return false;
    if (matchesOptionAttrs(s, opt, idx)) return true;
    var holder = s.closest('[data-option-name],[data-option-position],[data-option-index]');
    if (holder && matchesOptionAttrs(holder, opt, idx)) return true;
    var attrs = [s.getAttribute('name'), s.id, s.getAttribute('aria-label'), s.getAttribute('data-option-name')];
    if (attrs.some(function (a) { return a && nameMatchesOption(a, opt, idx); })) return true;
    return labelsFor(s).some(function (l) { return norm(l.textContent).split(':')[0].trim() === norm(opt.name); });
  });
  var attrHits = Array.prototype.filter.call(document.querySelectorAll('[data-option-name],[data-option-position],[data-option-index]'), function (el) {
    return el.tagName !== 'SELECT' && matchesOptionAttrs(el, opt, idx);
  });
  if (attrHits.length) {
    var items = [];
    attrHits.forEach(function (el) {
      var inner = candidateControls(el);
      if (inner.length) inner.forEach(function (c) { if (items.indexOf(c) < 0) items.push(c); });
      else if (el.matches(CONTROL_SELECTOR) && !isUnsafeControl(el) && items.indexOf(el) < 0) items.push(el);
    });
    if (items.length) return { kind: 'items', items: items };
  }
  var radios = Array.prototype.filter.call(document.querySelectorAll('input[type=radio]'), function (r) {
    return nameMatchesOption(r.getAttribute('name'), opt, idx);
  });
  if (radios.length) return { kind: 'items', items: radios };
  if (selects.length) return { kind: 'select', el: selects[0] };
  var containers = Array.prototype.filter.call(document.querySelectorAll('fieldset,.selector-wrapper,.swatch,.product-option,[class*=option-group],[class*=variant-option],[class*=variant-picker]'), function (c) {
    return labelledContainerText(c) === norm(opt.name);
  });
  for (var k = 0; k < containers.length; k++) {
    var found = candidateControls(containers[k]);
    if (found.length) return { kind: 'items', items: found };
  }
  return null;
}
function isSelectedControl(el) {
  if (el.tagName === 'LABEL' && el.control) el = el.control;
  if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) return !!el.checked;
  var cls = /(^|[\s_-])(active|selected|checked|is-active|is-selected)([\s_-]|$)/;
  var holders = [el, el.parentElement, el.closest ? el.closest('label') : null];
  for (var i = 0; i < holders.length; i++) {
    var h = holders[i];
    if (!h) continue;
    if (['aria-checked', 'aria-pressed', 'aria-selected', 'aria-current'].some(function (a) { return h.getAttribute(a) === 'true'; })) return true;
    if (cls.test(h.getAttribute('class') || '')) return true;
  }
  return false;
}
function linksElsewhere(img) {
  var a = img.closest ? img.closest('a[href]') : null;
  if (!a) return false;
  var u;
  try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return false; }
  if (u.origin !== location.origin) return false;
  if (/\.(jpe?g|png|webp|gif|avif|svg)$/i.test(u.pathname)) return false;
  return u.pathname.replace(/\/$/, '') !== location.pathname.replace(/\/$/, '');
}
function galleryImageSrc(img) {
  if (img.closest && img.closest('[class*="thumb"],[data-thumbnail]')) return null;
  if (linksElsewhere(img)) return null;
  var src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-large') || img.getAttribute('data-zoom');
  if (!src && img.getAttribute('data-srcset')) src = img.getAttribute('data-srcset').split(',')[0].trim().split(' ')[0];
  if (src && src.indexOf('data:') === 0) src = img.getAttribute('data-src') || '';
  return src || null;
}
function galleryCandidate(img, laidOut) {
  if (!galleryImageSrc(img)) return false;
  if (!laidOut) return true;
  var r = img.getBoundingClientRect();
  return r.width >= 150 && r.height >= 150;
}
function productGalleryRoot() {
  var anchor = document.querySelector('form[action*="/cart/add"]') || document.querySelector('select[name="id"], input[name="id"], [name="variantId"]');
  var el = anchor ? anchor.parentElement : null;
  // Share icons and badges sit next to the variant picker; the gallery is the first
  // gallery-sized image met on the way up. Without layout (jsdom) any image counts.
  var laidOut = document.body ? document.body.getBoundingClientRect().width > 0 : false;
  while (el && el !== document.body && el !== document.documentElement) {
    var imgs = el.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) if (galleryCandidate(imgs[i], laidOut)) return el;
    el = el.parentElement;
  }
  return null;
}
function largestImageIn(root) {
  var best = [];
  var max = 0;
  var imgs = root.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    var src = galleryImageSrc(imgs[i]);
    if (!src) continue;
    var r = imgs[i].getBoundingClientRect();
    var area = r.width * r.height;
    if (area <= 0) continue;
    best.push({ src: src, area: area });
    if (area > max) max = area;
  }
  for (var k = 0; k < best.length; k++) if (best[k].area >= max * 0.6) return best[k].src;
  return null;
}
function findGalleryImage() {
  var activeSelectors = [
    '.swiper-slide-active img', '.slick-current img', '.slick-active img', '.flickity-slider .is-selected img',
    '.splide__slide.is-active img', '.glide__slide--active img', '.owl-item.active img',
    '[data-gallery] .is-active img', '.product-gallery .active img', '.product-gallery .is-active img', '[aria-current="true"] img'
  ];
  var mainSelectors = [
    '[data-product-featured-image]', '#ProductPhotoImg', '.product-image-main img', '.product__main-photos img',
    '.featured-image img', '.product-single__photo img', '#product-featured-image', '[data-gallery] img', '.product-gallery img', '.product__media img'
  ];
  var all = activeSelectors.concat(mainSelectors);
  // A carousel of related products also carries .slick-current / .swiper-slide-active,
  // so the gallery is looked up inside the block that holds the add-to-cart form first.
  var root = productGalleryRoot();
  var scopes = root ? [root, document] : [document];
  for (var s = 0; s < scopes.length; s++) {
    for (var i = 0; i < all.length; i++) {
      var imgs = scopes[s].querySelectorAll(all[i]);
      for (var j = 0; j < imgs.length; j++) {
        var src = galleryImageSrc(imgs[j]);
        if (src) return src;
      }
    }
    if (scopes[s] === root) {
      var largest = largestImageIn(root);
      if (largest) return largest;
    }
  }
  return null;
}
function readUrlVariant() {
  try { return new URLSearchParams(location.search).get('variant'); } catch (e) { return null; }
}
function readFormVariantId() {
  var el = document.querySelector('form[action*="/cart/add"] [name="id"], [name="id"]');
  if (!el) return null;
  if (el.tagName === 'SELECT') return el.value || null;
  if (el.type === 'radio') { var c = document.querySelector('input[name="id"]:checked'); return c ? c.value : null; }
  return el.value || null;
}
`;
