/**
 * Runner: Compile Haravan Theme from Spec HTML / Clone IR
 * Complies with Haravan Canonical Base Contract (Audit Phase 05)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function parseArgs(args) {
  const parsed = {
    input: path.join(rootDir, 'specs', 'roahtrip-html-spec', 'index.html'),
    settingsMode: 'legacy-html',
    output: path.join(rootDir, 'build', 'haravan-theme'),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' || arg === '-i') {
      parsed.input = path.resolve(rootDir, args[++i]);
    } else if (arg.startsWith('--input=')) {
      parsed.input = path.resolve(rootDir, arg.slice('--input='.length));
    } else if (arg === '--settings-mode' || arg === '-m') {
      parsed.settingsMode = args[++i];
    } else if (arg.startsWith('--settings-mode=')) {
      parsed.settingsMode = arg.slice('--settings-mode='.length);
    } else if (arg === '--output' || arg === '-o') {
      parsed.output = path.resolve(rootDir, args[++i]);
    } else if (arg.startsWith('--output=')) {
      parsed.output = path.resolve(rootDir, arg.slice('--output='.length));
    } else if (arg === '--mobile' || arg === '-b') {
      parsed.mobile = path.resolve(rootDir, args[++i]);
    } else if (arg.startsWith('--mobile=')) {
      parsed.mobile = path.resolve(rootDir, arg.slice('--mobile='.length));
    } else if (arg === '--code-approvals') {
      parsed.codeApprovals = JSON.parse(fs.readFileSync(path.resolve(rootDir, args[++i]), 'utf8'));
      if (!Array.isArray(parsed.codeApprovals)) throw new Error('--code-approvals must contain an array');
    } else if (arg.startsWith('--code-approvals=')) {
      parsed.codeApprovals = JSON.parse(fs.readFileSync(path.resolve(rootDir, arg.slice('--code-approvals='.length)), 'utf8'));
      if (!Array.isArray(parsed.codeApprovals)) throw new Error('--code-approvals must contain an array');
    } else if (arg === '--clean' || arg === '--force' || arg === '-f') {
      parsed.force = true;
    }
  }

  return parsed;
}

const ROUTE_DEFINITIONS = [
  { id: '02', name: 'Danh mục hãng', rel: 'brands/index.html', template: 'page.brands.liquid', mobileRel: 'brands/mobile/index.html' },
  { id: '03', name: 'Nhóm không lọc', rel: 'category/cam-bien/index.html', template: 'collection.no-filter.liquid', mobileRel: 'category/cam-bien/mobile/index.html' },
  { id: '04', name: 'Nhóm có lọc', rel: 'category/contactor/index.html', template: 'collection.liquid', mobileRel: 'category/contactor/mobile/index.html' },
  { id: '05', name: 'Nhóm theo Brand', rel: 'brands/ecovacs/index.html', template: 'collection.brand.liquid', mobileRel: 'brands/ecovacs/mobile/index.html' },
  { id: '06', name: 'Giỏ hàng', rel: 'cart/index.html', template: 'cart.liquid', mobileRel: 'cart/mobile/index.html' },
  { id: '07', name: 'Chi tiết sản phẩm', rel: 'product/index.html', template: 'product.liquid', mobileRel: 'product/mobile/index.html' },
  { id: '08', name: 'Báo giá nhanh', rel: 'bao-gia/index.html', template: 'page.quote.liquid', mobileRel: 'bao-gia/mobile/index.html' },
  { id: '09', name: 'Tài liệu kỹ thuật', rel: 'tai-lieu-ky-thuat/index.html', template: 'page.documents.liquid', mobileRel: 'tai-lieu-ky-thuat/mobile/index.html' },
  { id: '10', name: 'Tin tức', rel: 'tin-tuc/index.html', template: 'blog.liquid', mobileRel: 'tin-tuc/mobile/index.html' },
  { id: '11', name: 'Chi tiết tin tức', rel: 'article/index.html', template: 'article.liquid', mobileRel: 'article/mobile/index.html' },
  { id: '12', name: 'Giới thiệu', rel: 'gioi-thieu/index.html', template: 'page.about.liquid', mobileRel: 'gioi-thieu/mobile/index.html' },
  { id: '13', name: 'Lịch sử phát triển', rel: 'lich-su-phat-trien/index.html', template: 'page.timeline.liquid', mobileRel: 'lich-su-phat-trien/mobile/index.html' },
  { id: '14', name: 'Tuyển dụng & JD', rel: 'tuyen-dung/index.html', template: 'page.careers.liquid', mobileRel: 'tuyen-dung/mobile/index.html' },
  { id: '15', name: 'Liên hệ', rel: 'lien-he/index.html', template: 'page.contact.liquid', mobileRel: 'lien-he/mobile/index.html' }
];

function cleanReferenceDomains(html) {
  if (!html) return '';
  let res = html;
  // Replace share URLs and image hotlinks
  res = res.replace(/https?:\/\/hoplongtech\.com\/tin-tuc\/[^\s'"&)]*/gi, '{{ canonical_url }}');
  res = res.replace(/https?:\/\/img\.hoplongtech\.com\/hoplong\/news\/[^\s'"&)]*/gi, "{{ article.image | img_url: 'master' }}");
  res = res.replace(/https?:\/\/img\.hoplongtech\.com\/hoplong\/danh-muc\/anh-danh-muc\/([^"'\s)]+)/gi, "{{ '$1' | asset_url }}");
  res = res.replace(/href=["']https?:\/\/(?:img\.hoplongtech\.com|sudospaces\.com|hoplongtech\.com|hoplong\.com)\/[^"']*\.pdf["']/gi, 'href="#" onclick="alert(\'Tài liệu đang được đồng bộ lên hệ thống.\'); return false;"');
  res = res.replace(/https?:\/\/(?:img\.hoplongtech\.com|sudospaces\.com|hoplongtech\.com|hoplong\.com)\/[^"'\s)]*\.pdf/gi, '#');

  // Replace internal navigation links
  res = res.replace(/https?:\/\/hoplong\.com\/gioi-thieu-hop-long\/?/gi, '/pages/about');
  res = res.replace(/https?:\/\/hoplong\.com\/gioi-thieu-ve-hop-long\/?/gi, '/pages/about');
  res = res.replace(/https?:\/\/hoplong\.com\/lich-su-phat-trien\/?/gi, '/pages/timeline');
  res = res.replace(/https?:\/\/hoplong\.com\/tuyen-dung\/?/gi, '/pages/careers');
  res = res.replace(/https?:\/\/hoplongtech\.com\/lien-he\/?/gi, '/pages/contact');
  res = res.replace(/https?:\/\/hoplongtech\.com\/tin-tuc\/?/gi, '/blogs/news');
  res = res.replace(/https?:\/\/hoplongtech\.com\/cart\/?/gi, '/cart');
  res = res.replace(/https?:\/\/hoplongtech\.com\/bao-gia\/?/gi, '/pages/quote');
  res = res.replace(/https?:\/\/hoplongtech\.com\/tai-lieu-ky-thuat\/?/gi, '/pages/documents');
  res = res.replace(/https?:\/\/hoplongtech\.com\/brands\/?/gi, '/pages/brands');
  res = res.replace(/https?:\/\/hoplongtech\.com\/?(?=["'\s>])/gi, '/');

  // Relative legacy routes (no domain) — nav links, breadcrumbs, view-all
  res = res.replace(/href=["']\/tin-tuc\/([a-z0-9-]+)\.html["']/gi, 'href="/blogs/news/$1"');
  res = res.replace(/href=["']\/tin-tuc\/([a-z0-9-]+)\/?["']/gi, 'href="/blogs/news/tagged/$1"');
  res = res.replace(/href=["']\/tin-tuc\/?["']/gi, 'href="/blogs/news"');
  res = res.replace(/href=["']\/gioi-thieu(?:-ve-hop-long|-hop-long)?\/?["']/gi, 'href="/pages/about"');
  res = res.replace(/href=["']\/lich-su-phat-trien\/?["']/gi, 'href="/pages/timeline"');
  res = res.replace(/href=["']\/tuyen-dung\/?["']/gi, 'href="/pages/careers"');
  res = res.replace(/href=["']\/lien-he\/?["']/gi, 'href="/pages/contact"');
  res = res.replace(/href=["']\/bao-gia\/?["']/gi, 'href="/pages/quote"');
  res = res.replace(/href=["']\/tai-lieu-ky-thuat\/?["']/gi, 'href="/pages/documents"');
  res = res.replace(/href=["']\/brands\/?["']/gi, 'href="/pages/brands"');

  // Subdomains
  res = res.replace(/https?:\/\/(?:gigapack|conveyor|palletizing)\.hoplong\.com\/[^\s"']*/gi, '#');

  // Emails & brandings
  res = res.replace(/mailto:info@hoplong\.com/gi, "mailto:{{ settings.email | default: 'info@phukienmaymoc.com' }}");
  res = res.replace(/\binfo@hoplong\.com\b/gi, "{{ settings.email | default: 'info@phukienmaymoc.com' }}");
  res = res.replace(/Chat với Hoplong/gi, 'Chat với hỗ trợ');
  res = res.replace(/hoplongtech\.com(?=\s+All rights reserved)/gi, '{{ shop.name }}');
  res = res.replace(/Copyright © \d+(?:&nbsp;|\s)*<a\b[^>]*>[^<]*<\/a>[^<]*/gi, 'Copyright © {{ "now" | date: "%Y" }} <a href="/">{{ shop.name }}</a> All rights reserved.');
  res = res.replace(/<a href="\/">hoplongtech\.com<\/a>/gi, '<a href="/">{{ shop.name }}</a>');
  res = res.replace(/class=["']bottom-navigation__item\s+[^"']*["']/gi, 'class="bottom-navigation__item"');
  return res;
}

function rewriteLiquidAssets(html) {
  if (!html) return '';
  let res = html.replace(/(?:src|data-src|data-image|href)=["']([^"']+)["']/gi, (match, url) => {
    if (url.startsWith('{{') || url.startsWith('{%') || url.startsWith('data:') || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) {
      return match;
    }
    const cleanUrl = url.split('?')[0].split('#')[0];
    const filename = cleanUrl.split('/').pop();
    if (filename && /\.(png|jpe?g|webp|gif|svg|ico|css|js|ttf|woff2?|eot)$/i.test(filename)) {
      const attr = match.split('=')[0];
      return `${attr}="{{ '${filename}' | asset_url }}"`;
    }
    return match;
  });
  res = res.replace(/this\.src\s*=\s*(?:&quot;|["'])([^"']+?)(?:&quot;|["'])/gi, (match, url) => {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const filename = cleanUrl.split('/').pop();
    if (filename && /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(filename)) {
      return `this.src=&quot;{{ '${filename}' | asset_url }}&quot;`;
    }
    return match;
  });
  return res;
}
function extractMainContent(html) {
  if (!html) return '';
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    let content = mainMatch[1];
    content = content.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '');
    content = content.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');
    content = content.replace(/<div\b[^>]*\bclass="[^"]*bottom-navigation[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    return content.trim();
  }
  let content = html;
  content = content.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '');
  content = content.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');
  content = content.replace(/<div\b[^>]*\bclass="[^"]*(?:site-header|header)[^"]*"[^>]*>[\s\S]*?<\/div>\s*(?=<div|<section)/gi, '');
  content = content.replace(/<div\b[^>]*\bclass="[^"]*(?:site-footer|footer)[^"]*"[^>]*>[\s\S]*?<\/div>\s*$/gi, '');
  content = content.replace(/<div\b[^>]*\bclass="[^"]*bottom-navigation[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  content = content.replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '');
  return content.trim();
}

function replaceTagBalanced(html, startPattern, replacement) {
  const match = html.match(startPattern);
  if (!match) return html;
  const tagMatch = match[0].match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch) return html;
  const tag = tagMatch[1].toLowerCase();
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;
  const startIdx = match.index;
  let depth = 0;
  let idx = startIdx;
  const len = html.length;
  let endIdx = -1;
  while (idx < len) {
    const nextOpen = html.indexOf(openNeedle, idx);
    const nextClose = html.indexOf(closeNeedle, idx);
    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      depth++;
      idx = nextOpen + openNeedle.length;
    } else if (nextClose !== -1) {
      depth--;
      idx = nextClose + closeNeedle.length;
      if (depth === 0) {
        endIdx = html.indexOf('>', idx);
        if (endIdx === -1) return html;
        endIdx += 1;
        break;
      }
    } else {
      break;
    }
  }
  if (endIdx === -1) return html;
  return html.slice(0, startIdx) + replacement + html.slice(endIdx);
}

function applyPageSpecificTransforms(templateName, html, fullDocHtml) {
  let transformed = html;
  const doc = fullDocHtml || html;

  if (templateName === 'cart.liquid') {
    // 1. TUYET DOI BO DONG HIEN THI THUE GTGT (VAT) & Chuan Haravan Cart API & Container Invariant
    return `<div class="cart-page">
  <div class="container">
    <div class="cart-wrapper py-5">
      <div class="cart-header mb-4">
        <h1 class="cart-title">Giỏ hàng của bạn</h1>
      </div>
      {% if cart.item_count > 0 %}
        <form action="/cart" method="post" novalidate class="cart-form">
          <div class="cart-table-wrap table-responsive">
            <table class="cart-table table w-100">
              <thead>
                <tr>
                  <th>Sản phẩm</th>
                  <th>Đơn giá</th>
                  <th>Số lượng</th>
                  <th>Thành tiền</th>
                  <th>Xóa</th>
                </tr>
              </thead>
              <tbody>
                {% for item in cart.items %}
                  <tr class="cart-item">
                    <td class="cart-item-product flex-align-center">
                      <a href="{{ item.url }}" class="cart-item-image mr-3">
                        <img src="{{ item.image | img_url: 'medium' }}" alt="{{ item.title | escape }}" width="80" height="80" class="img-fluid">
                      </a>
                      <div class="cart-item-info">
                        <a href="{{ item.url }}" class="cart-item-title font-weight-bold">{{ item.product.title }}</a>
                        {% unless item.variant.title contains 'Default' %}
                          <p class="cart-item-variant text-muted small mb-0">{{ item.variant.title }}</p>
                        {% endunless %}
                      </div>
                    </td>
                    <td class="cart-item-price">{{ item.price | money }}</td>
                    <td class="cart-item-quantity">
                      <input type="number" name="updates[]" id="updates_{{ item.id }}" value="{{ item.quantity }}" min="0" class="form-control text-center" style="max-width: 80px;">
                    </td>
                    <td class="cart-item-total font-weight-bold">{{ item.line_price | money }}</td>
                    <td class="cart-item-remove">
                      <a href="/cart/change?line={{ forloop.index }}&quantity=0" class="cart-remove text-danger" aria-label="Xóa sản phẩm">✕</a>
                    </td>
                  </tr>
                {% endfor %}
              </tbody>
            </table>
          </div>
          <div class="cart-summary row mt-4 justify-content-end">
            <div class="col-md-5">
              <div class="cart-summary-box p-3 border rounded bg-light">
                <div class="d-flex justify-content-between mb-2">
                  <span>Tổng số lượng:</span>
                  <span class="font-weight-bold">{{ cart.item_count }}</span>
                </div>
                <div class="d-flex justify-content-between mb-3">
                  <span class="h5 mb-0">Tổng tiền:</span>
                  <span class="h5 mb-0 text-primary font-weight-bold">{{ cart.total_price | money }}</span>
                </div>
                <div class="cart-buttons d-flex flex-column gap-2">
                  <a href="/checkout" class="btn btn-primary btn-block py-2 text-white text-center font-weight-bold" style="background-color: {{ settings.color_primary | default: '#005baa' }}; border-radius: 4px; border: none;">Tiến hành thanh toán</a>
                  <a href="/" class="btn btn-outline-secondary btn-block text-center mt-2">Tiếp tục mua hàng</a>
                </div>
              </div>
            </div>
          </div>
        </form>
      {% else %}
        <div class="cart-empty text-center py-5 border rounded bg-light">
          <p class="h5 text-muted mb-3">Giỏ hàng của bạn đang trống.</p>
          <a href="/" class="btn btn-primary px-4 py-2 text-white" style="background-color: {{ settings.color_primary | default: '#005baa' }}; border-radius: 4px; border: none;">Quay lại mua sắm</a>
        </div>
      {% endif %}
    </div>
  </div>
</div>`;
  } else if (templateName === 'product.liquid') {
    // Strip all hardcoded reference payment URLs, product IDs, and onclicks
    transformed = transformed.replace(/\s+data-payment_url=["'][^"']*["']/gi, '');
    transformed = transformed.replace(/\s+data-product_id=["'][^"']*["']/gi, ' data-product_id="{{ product.id }}"');
    transformed = transformed.replace(/onclick=["']addToCart\([^"']*\)["']/gi, '');

    // Bind Product Title
    transformed = transformed.replace(
      /(<h1\b[^>]*class=["'][^"']*content-title[^"']*["'][^>]*>)([\s\S]*?)(<\/h1>)/gi,
      '$1{{ product.title }}$3'
    );

    // Bind Product Price
    transformed = transformed.replace(
      /(<div\b[^>]*class=["'][^"']*content-price[^"']*["'][^>]*>)([\s\S]*?)(<\/div>)/gi,
      `<div class="content-price flex-center-between">
        <div class="price-group">
          <span class="price text-danger font-weight-bold" style="font-size: 1.5rem;">{{ product.price | money }}</span>
          {% if product.compare_at_price > product.price %}
            <del class="compare-price text-muted ml-2" style="font-size: 1.1rem;">{{ product.compare_at_price | money }}</del>
          {% endif %}
        </div>
      </div>`
    );

    // Bind Product SKU
    transformed = transformed.replace(
      /<p\b[^>]*class=["'][^"']*content-meta__sku[^"']*["'][^>]*>[\s\S]*?<\/p>/gi,
      `<p class="content-meta__sku">Mã sản phẩm: {{ product.selected_or_first_available_variant.sku | default: product.variants.first.sku | default: 'Đang cập nhật' }}</p>`
    );

    // Bind Product Vendor
    transformed = transformed.replace(
      /<a\b[^>]*class=["'][^"']*content-meta__brand[^"']*["'][^>]*>[\s\S]*?<\/a>/gi,
      `{% if product.vendor != blank %}<a href="{{ product.vendor | url_for_vendor }}" class="content-meta__brand" aria-label="{{ product.vendor | escape }}">{{ product.vendor }}</a>{% endif %}`
    );

    // Bind Main Product Gallery Images
    const sliderProductRegex = /<div\b[^>]*id=["']slider-product["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/i;
    const dynamicSliderProduct = `<div class="banner w-100" id="slider-product" data-autoplay="0" data-nav="1" data-dot="1">
  {% if product.images.size > 0 %}
    {% for image in product.images %}
      <div class="product-gallery__item">
        <img src="{{ image | img_url: 'master' }}" alt="{{ product.title | escape }}" width="438" height="438" class="img-fluid">
      </div>
    {% endfor %}
  {% else %}
    <div class="product-gallery__item">
      <img src="{{ product.featured_image | img_url: 'master' }}" alt="{{ product.title | escape }}" width="438" height="438" class="img-fluid">
    </div>
  {% endif %}
</div>`;
    transformed = transformed.replace(sliderProductRegex, dynamicSliderProduct);

    // Replace Add to Cart & Buy Now container with Haravan Product Form
    const buttonBlockRegex = /<div\b[^>]*class=["'][^"']*content-button[^"']*["'][^>]*>[\s\S]*?<\/div>/i;
    const haravanProductForm = `<div class="content-button my-4">
  {% form 'product', product, class: 'product-form' %}
    <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">
    <div class="product-form__actions d-flex flex-wrap align-items-center gap-3">
      <div class="quantity-selector mr-3 d-flex align-items-center">
        <label for="Quantity" class="mr-2 mb-0 font-weight-bold">Số lượng:</label>
        <input type="number" id="Quantity" name="quantity" value="1" min="1" class="form-control text-center" style="max-width: 80px;" aria-label="Số lượng">
      </div>
      <button type="submit" name="add" class="button btn-add-to-cart primary-btn px-4 py-2 text-white font-weight-bold" id="AddToCart" style="cursor: pointer; background-color: {{ settings.color_primary | default: '#005baa' }}; border-radius: 4px; border: none;">
        <span>Thêm vào giỏ hàng</span>
      </button>
      <button type="submit" name="checkout" class="button btn-buy-now secondary-btn px-4 py-2 text-white font-weight-bold ml-2" id="BuyNow" style="cursor: pointer; background-color: {{ settings.color_secondary | default: '#ff6600' }}; border-radius: 4px; border: none;">
        <span>Mua ngay</span>
      </button>
    </div>
  {% endform %}
</div>`;
    transformed = transformed.replace(buttonBlockRegex, haravanProductForm);

    // Remove hardcoded rating block & inject #f1genz-reviews
    transformed = transformed.replace(/<div\b[^>]*class=["'][^"']*product-visual-rating[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
    if (!transformed.includes('f1genz-reviews')) {
      transformed += '\n<div id="f1genz-reviews" class="f1genz-reviews container my-4"></div>\n';
    }

    // Bind series-related table to collection loop
    const relatedBlockRegex = /<div\b[^>]*class=["'][^"']*series-related\b[\s\S]*?(?=<div\b[^>]*id=["']content-tab["'])/i;
    const dynamicRelatedTable = `<div class="series-related w-100 my-4">
  <div class="series-related__header">
    <p>Sản phẩm cùng series</p>
  </div>
  {% assign rel_col = product.collections.first %}
  {% if rel_col and rel_col.products.size > 1 %}
    <div class="series-related__list table-responsive" id="product-list">
      <table class="table w-100">
        <thead>
          <tr>
            <th class="infor">Sản phẩm</th>
            <th class="price">Giá bán</th>
            <th class="action">Chi tiết</th>
          </tr>
        </thead>
        <tbody>
          {% for rel in rel_col.products limit: 6 %}
            {% unless rel.id == product.id %}
              <tr>
                <td class="infor flex-center-left">
                  <a href="{{ rel.url }}" class="d-flex align-items-center">
                    <img src="{{ rel.featured_image | img_url: 'thumb' }}" alt="{{ rel.title | escape }}" width="50" height="50" class="mr-2 rounded">
                    <span>{{ rel.title }}</span>
                  </a>
                </td>
                <td class="price font-weight-bold text-danger">{{ rel.price | money }}</td>
                <td class="action">
                  <a href="{{ rel.url }}" class="btn btn-sm btn-outline-primary">Xem</a>
                </td>
              </tr>
            {% endunless %}
          {% endfor %}
        </tbody>
      </table>
    </div>
  {% else %}
    <p class="text-muted p-3">Đang cập nhật sản phẩm cùng series.</p>
  {% endif %}
</div>`;
    transformed = transformed.replace(relatedBlockRegex, dynamicRelatedTable);

    // Clean mailto & contact text
    transformed = transformed.replace(/mailto:info@hoplong\.com/gi, "mailto:{{ settings.email | default: 'info@phukienmaymoc.com' }}");
    transformed = transformed.replace(/\binfo@hoplong\.com\b/gi, "{{ settings.email | default: 'info@phukienmaymoc.com' }}");
    transformed = transformed.replace(/Chat với Hoplong/gi, "Chat với hỗ trợ");
  } else if (templateName === 'article.liquid') {
    // 3. TUYET DOI LOAI BO ICON VA BO DEM MAT XEM (BO MAT XEM)
    transformed = transformed.replace(/<span\b[^>]*\bclass="[^"]*(?:view-count|views|mat-xem|luot-xem|meta-view)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
    transformed = transformed.replace(/<div\b[^>]*\bclass="[^"]*(?:view-count|views|mat-xem|luot-xem|meta-view)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    transformed = transformed.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>\s*[\d,.]+\s*(?:lượt xem|mắt xem|views)?/gi, '');
    transformed = transformed.replace(/[\d,.]+\s*(?:lượt xem|mắt xem)/gi, '');

    // Clean share URLs
    transformed = transformed.replace(/https:\/\/facebook\.com\/share\.php\?u=[^&'"]*(&amp;t=[^'"]*)?/gi, "https://facebook.com/share.php?u={{ canonical_url | url_encode }}&amp;t={{ article.title | url_encode }}");
    transformed = transformed.replace(/https?:\/\/(?:www\.)?linkedin\.com\/shareArticle\?[^'"]*/gi, "https://www.linkedin.com/shareArticle?mini=true&amp;url={{ canonical_url | url_encode }}&amp;title={{ article.title | url_encode }}&amp;source={{ shop.url | url_encode }}");
    transformed = transformed.replace(/https:\/\/twitter\.com\/intent\/tweet\?[^'"]*/gi, "https://twitter.com/intent/tweet?text={{ article.title | url_encode }}&amp;url={{ canonical_url | url_encode }}");
    transformed = transformed.replace(/https:\/\/pinterest\.com\/pin\/create\/button\/\?[^'"]*/gi, "https://pinterest.com/pin/create/button/?url={{ canonical_url | url_encode }}&amp;media={{ article.image | img_url: 'master' | url_encode }}&amp;description={{ article.title | url_encode }}");
    transformed = transformed.replace(/https:\/\/wa\.me\/\?text=[^'"]*/gi, "https://wa.me/?text={{ canonical_url | url_encode }}");
    transformed = transformed.replace(/mailto:\?subject=[^'"]*/gi, "mailto:?subject={{ article.title | url_encode }}&amp;body={{ canonical_url | url_encode }}");
    // Bind Article Title
    transformed = transformed.replace(
      /(<h1\b[^>]*class=["'][^"']*(?:title|article-title|blog-title|post-title|single-name)[^"']*["'][^>]*>)([\s\S]*?)(<\/h1>)/gi,
      '$1{{ article.title }}$3'
    );
    transformed = replaceTagBalanced(
      transformed,
      /<div\b[^>]*class=["'][^"']*(?:single-content|article-content|content-detail|post-content)[^"']*["'][^>]*>/i,
      '<div class="single-content ck-content">\n  {{ article.content }}\n</div>'
    );
  } else if (templateName === 'blog.liquid') {
    // Detect legacy blog base path from source DOM before any block replacement (generic, no hardcoded path)
    const legacyArticleLinks = transformed.match(/href=["']\/([a-z0-9-]+)\/([a-z0-9-]+)\.html["']/gi) || [];
    const baseCounts = {};
    for (const link of legacyArticleLinks) {
      const base = link.match(/href=["']\/([a-z0-9-]+)\//i)[1];
      baseCounts[base] = (baseCounts[base] || 0) + 1;
    }
    const legacyBlogBase = Object.keys(baseCounts).sort((a, b) => baseCounts[b] - baseCounts[a])[0];

    // Dynamic featured hero article
    const dynamicHero = `<article class="top-item w-100">
  {% assign featured_article = blog.articles.first %}
  {% if featured_article %}
    <div class="top-item__thumbnail">
      <a href="{{ featured_article.url }}" aria-label="{{ featured_article.title | escape }}">
        <div class="">
          <img loading="eager" src="{{ featured_article.image | img_url: 'grande' }}" alt="{{ featured_article.title | escape }}" width="320" height="784">
        </div>
      </a>
      {% if featured_article.tags.size > 0 %}
        <p class="category"><a href="{% if blog.url == blank %}/blogs/news{% else %}{{ blog.url }}{% endif %}/tagged/{{ featured_article.tags.first | handleize }}" aria-label="{{ featured_article.tags.first | escape }}">{{ featured_article.tags.first }}</a></p>
      {% endif %}
    </div>
    <div class="top-item__content">
      <h3 class="name"><a href="{{ featured_article.url }}" aria-label="{{ featured_article.title | escape }}">{{ featured_article.title }}</a></h3>
      <p class="meta flex-inline-center-left">
        <span class="meta-date">{{ featured_article.published_at | date: '%d/%m/%Y' }}</span>
        {% if featured_article.author != blank %}
          <span class="meta-auth"><span class="meta-auth__name" aria-label="{{ featured_article.author | escape }}">{{ featured_article.author }}</span></span>
        {% endif %}
      </p>
      <p class="description">{{ featured_article.excerpt | default: featured_article.content | strip_html | truncatewords: 40 }}</p>
    </div>
  {% endif %}
</article>`;
    transformed = replaceTagBalanced(transformed, /<article\b[^>]*class=["'][^"']*top-item[^"']*["'][^>]*>/i, dynamicHero);

    // Dynamic blog category/tag list
    const dynamicCategories = `<ul class="category-lists">
  {% for tag in blog.all_tags %}
    <li class="category-lists__item">
      <p class="w-100 flex-center-between">
        <span class="name"><a href="{% if blog.url == blank %}/blogs/news{% else %}{{ blog.url }}{% endif %}/tagged/{{ tag | handleize }}" aria-label="{{ tag | escape }}">{{ tag }}</a></span>
      </p>
    </li>
  {% endfor %}
</ul>`;
    transformed = replaceTagBalanced(transformed, /<ul\b[^>]*class=["'][^"']*category-lists[^"']*["'][^>]*>/i, dynamicCategories);

    // Dynamic featured sidebar articles
    const dynamicTopLists = `<div class="top-lists">
  {% for article in blog.articles limit: 3 %}
    <div class="top-lists__item flex-left">
      <div class="thumbnail">
        <a href="{{ article.url }}" aria-label="{{ article.title | escape }}">
          <div class="">
            <img loading="lazy" src="{{ article.image | img_url: 'compact' }}" alt="{{ article.title | escape }}" width="98" height="98">
          </div>
        </a>
      </div>
      <div class="content">
        <h3 class="content-name"><a href="{{ article.url }}" aria-label="{{ article.title | escape }}">{{ article.title }}</a></h3>
        <p class="meta flex-inline-center-left">
          <span class="meta-date">{{ article.published_at | date: '%d/%m/%Y' }}</span>
          {% if article.author != blank %}
            <span class="meta-auth"><span class="meta-auth__name" aria-label="{{ article.author | escape }}">{{ article.author }}</span></span>
          {% endif %}
        </p>
      </div>
    </div>
  {% endfor %}
</div>`;
    transformed = replaceTagBalanced(transformed, /<div\b[^>]*class=["'][^"']*top-lists[^"']*["'][^>]*>/i, dynamicTopLists);

    // Replace static articles in #blog-list with dynamic loop using replaceTagBalanced
    const dynamicBlogList = `<div class="list flex-left" id="blog-list">
  {% for article in blog.articles %}
    <article class="article-item">
      <div class="article-item__thumbnail">
        <a href="{{ article.url }}" aria-label="{{ article.title | escape }}">
          <div class="">
            <img loading="lazy" src="{{ article.image | img_url: 'medium' }}" alt="{{ article.title | escape }}" width="248" height="143">
          </div>
        </a>
      </div>
      <div class="article-item__content">
        <h3 class="name"><a href="{{ article.url }}" aria-label="{{ article.title | escape }}">{{ article.title }}</a></h3>
        <p class="meta flex-inline-center-left">
          <span class="date">{{ article.published_at | date: '%d/%m/%Y' }}</span>
          {% if article.author != blank %}
            <span class="author ml-2">Tác giả: {{ article.author }}</span>
          {% endif %}
        </p>
        {% if article.excerpt != blank %}
          <p class="excerpt">{{ article.excerpt | strip_html | truncatewords: 25 }}</p>
        {% endif %}
      </div>
    </article>
  {% else %}
    <div class="col-12 text-center py-5">
      <p class="text-muted">Chưa có bài viết nào trong chuyên mục này.</p>
    </div>
  {% endfor %}
</div>`;
    transformed = replaceTagBalanced(transformed, /<div\b[^>]*id=["']blog-list["'][^>]*>/i, dynamicBlogList);

    // Rewrite legacy blog routes detected earlier from the source DOM (generic, no hardcoded path)
    if (legacyBlogBase) {
      const baseEsc = legacyBlogBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      transformed = transformed.replace(new RegExp(`href=["']/${baseEsc}/([a-z0-9-]+)\\.html["']`, 'gi'), 'href="{{ article.url | default: \'/blogs/news\' }}"');
      transformed = transformed.replace(new RegExp(`href=["']/${baseEsc}/([a-z0-9-]+)["']`, 'gi'), 'href="{{ blog.url | default: \'/blogs/news\' }}/tagged/$1"');
      transformed = transformed.replace(new RegExp(`href=["']/${baseEsc}["']`, 'gi'), 'href="{{ blog.url | default: \'/blogs/news\' }}"');
    }

    // Wrap with paginate blog.articles by 12
    // Replace pagination with dynamic paginate block (Single Paginate Invariant)
    const dynamicBlogPagination = `{% if paginate.pages > 1 %}<div class="w-100 pagination-wrap text-center py-4">{{ paginate | default_pagination }}</div>{% endif %}`;
    if (/<div\b[^>]*class=["'][^"']*pagination-wrap[^"']*["'][^>]*>/i.test(transformed)) {
      transformed = replaceTagBalanced(transformed, /<div\b[^>]*class=["'][^"']*pagination-wrap[^"']*["'][^>]*>/i, dynamicBlogPagination);
    }
  } else if (templateName === 'page.quote.liquid') {
    // 4. Bang ke dong cho phep them/xoa toi da 10 dong gui ve webhook Google Sheet
    transformed = transformed.replace(/(<form\b[^>]*\baction=)["'][^"']*["']/gi, '$1"{{ settings.google_sheet_quote_url | default: \'#\' }}"');
    if (!transformed.includes('settings.google_sheet_quote_url')) {
      transformed = transformed.replace(/<form\b([^>]*)>/i, '<form$1 action="{{ settings.google_sheet_quote_url | default: \'#\' }}" method="POST">');
    }
  } else if (templateName === 'page.careers.liquid') {
    // 5. Clean careers form - no raw WP CF7 or domain-locked reCAPTCHA
    transformed = transformed.replace(/<div\b[^>]*\bclass="[^"]*wpcf7[^"]*"[^>]*>[\s\S]*?<\/form>\s*<\/div>/gi, '');
    transformed = transformed.replace(/<div\b[^>]*\bid="form-tuyen-dung"[^>]*>[\s\S]*?<\/form>\s*<\/div>/gi, '');

    const cleanCareersForm = `<div class="careers-application-form my-5">
  <div class="container">
    <div class="row justify-content-center">
      <div class="col-md-8 col-12">
        <div class="card p-4 shadow-sm border-0 bg-white rounded">
          <h3 class="card-title text-center mb-4 font-weight-bold">Nộp hồ sơ ứng tuyển trực tuyến</h3>
          <form action="{{ settings.google_sheet_careers_url | default: '#' }}" method="POST" enctype="multipart/form-data" class="careers-form">
            <div class="form-group mb-3">
              <label for="applicant-name" class="form-label font-weight-bold">Họ và tên <span class="text-danger">*</span></label>
              <input type="text" id="applicant-name" name="name" class="form-control" required placeholder="Nhập họ và tên">
            </div>
            <div class="row">
              <div class="col-md-6 col-12 form-group mb-3">
                <label for="applicant-email" class="form-label font-weight-bold">Email <span class="text-danger">*</span></label>
                <input type="email" id="applicant-email" name="email" class="form-control" required placeholder="email@example.com">
              </div>
              <div class="col-md-6 col-12 form-group mb-3">
                <label for="applicant-phone" class="form-label font-weight-bold">Số điện thoại <span class="text-danger">*</span></label>
                <input type="tel" id="applicant-phone" name="phone" class="form-control" required placeholder="0987654321">
              </div>
            </div>
            <div class="form-group mb-3">
              <label for="applicant-position" class="form-label font-weight-bold">Vị trí ứng tuyển <span class="text-danger">*</span></label>
              <input type="text" id="applicant-position" name="position" class="form-control" required placeholder="Ví dụ: Kỹ sư tự động hóa">
            </div>
            <div class="form-group mb-3">
              <label for="applicant-cv" class="form-label font-weight-bold">Đính kèm CV (PDF, DOC, DOCX) <span class="text-danger">*</span></label>
              <input type="file" id="applicant-cv" name="cv_file" class="form-control" accept=".pdf,.doc,.docx" required>
            </div>
            <div class="form-group mb-4">
              <label for="applicant-note" class="form-label font-weight-bold">Ghi chú thêm</label>
              <textarea id="applicant-note" name="note" class="form-control" rows="3" placeholder="Thông tin bổ sung (nếu có)"></textarea>
            </div>
            <button type="submit" class="btn btn-primary btn-block w-100 py-2 text-white font-weight-bold" style="background-color: {{ settings.color_primary | default: '#005baa' }}; border: none; border-radius: 4px;">Gửi hồ sơ ứng tuyển</button>
          </form>
        </div>
      </div>
    </div>
  </div>
</div>`;
    transformed += `\n${cleanCareersForm}\n`;
  } else if (templateName === 'page.contact.liquid') {
    // 6. Form lien he chuan {% form 'contact' %}
    if (!transformed.includes("{% form 'contact' %}")) {
      transformed = transformed.replace(/<form\b[^>]*>([\s\S]*?)<\/form>/i, "{% form 'contact' %}\n$1\n{% endform %}");
    }
  } else if (templateName === 'collection.liquid' || templateName === 'collection.no-filter.liquid' || templateName === 'collection.brand.liquid') {
    if (templateName === 'collection.no-filter.liquid') {
      transformed = transformed.replace(/(<aside\b|<div\b[^>]*\bclass="[^"]*(?:col-left|sidebar|filter-sidebar)[^"]*")/gi, '$1 style="display: none !important;"');
    }

    // Dynamic Collection Title & Description
    transformed = transformed.replace(
      /<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>[\s\S]*?<\/h1>/i,
      `<h1 class="title">{{ collection.title | default: 'Danh mục sản phẩm' }}</h1>\n{% if collection.description != blank %}<div class="collection-description mb-3">{{ collection.description }}</div>{% endif %}`
    );

    // Replace static product grid and pagination cleanly using tag-balanced replacement
    const dynamicGrid = `<div class="grid-list flex w-100" id="product-list">
  {% for product in collection.products %}
    <div class="product-list__item">
      <div class="thumbnail">
        <a href="{{ product.url }}" title="{{ product.title | escape }}" aria-label="{{ product.title | escape }}">
          <div class="thumbnail-item">
            <img loading="lazy" src="{{ product.featured_image | img_url: 'medium' }}" alt="{{ product.title | escape }}" width="172" height="155">
          </div>
        </a>
      </div>
      <div class="content">
        <h3 class="text-bold"><a href="{{ product.url }}">{{ product.title }}</a></h3>
        <p class="price">{{ product.price | money }}</p>
        {% if product.compare_at_price > product.price %}
          <del class="compare-price">{{ product.compare_at_price | money }}</del>
        {% endif %}
        <div class="item-actions mt-2">
          <a href="{{ product.url }}" class="button btn-add-card" aria-label="Xem chi tiết">
            <span>Chi tiết</span>
          </a>
        </div>
      </div>
    </div>
  {% else %}
    <div class="col-12 text-center py-5">
      <p class="text-muted">Không có sản phẩm nào trong danh mục này.</p>
    </div>
  {% endfor %}
</div>`;

    const dynamicPagination = `<div class="w-100 pagination-wrap text-center py-4">
  {% if paginate.pages > 1 %}
    <div class="pagination-numbers flex-center-between w-100">
      {{ paginate | default_pagination }}
    </div>
  {% endif %}
</div>`;

    if (/<div\b[^>]*\bclass=["'][^"']*grid-list[^"']*["'][^>]*>/i.test(transformed)) {
      transformed = replaceTagBalanced(transformed, /<div\b[^>]*\bclass=["'][^"']*grid-list[^"']*["'][^>]*>/i, dynamicGrid);
    }
    if (/<div\b[^>]*\bclass=["'][^"']*pagination-wrap[^"']*["'][^>]*>/i.test(transformed)) {
      transformed = replaceTagBalanced(transformed, /<div\b[^>]*\bclass=["'][^"']*pagination-wrap[^"']*["'][^>]*>/i, dynamicPagination);
    } else if (transformed.includes('id="product-list"')) {
      // For templates without static pagination, append dynamic pagination cleanly
      transformed = transformed.replace(dynamicGrid, dynamicGrid + '\n' + dynamicPagination);
    }
  }
  return transformed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('[Haravan Compiler] Starting compilation with configuration:');
  console.log(`  - Input Path:    ${args.input}`);
  console.log(`  - Settings Mode: ${args.settingsMode}`);
  console.log(`  - Output Dir:    ${args.output}`);

  // Verify input exists before compiling
  if (!fs.existsSync(args.input)) {
    console.error(`[Haravan Compiler Error] Input does not exist: "${args.input}"`);
    console.error('Please specify a valid HTML or clone directory using --input <path>');
    process.exit(1);
  }

  // Validate settingsMode early
  if (args.settingsMode !== 'legacy-html' && args.settingsMode !== 'f1genz-schema') {
    console.error(`[Haravan Compiler Error] Unsupported settings mode: "${args.settingsMode}".`);
    console.error('Haravan supports only "legacy-html" or "f1genz-schema". Dual mode is strictly unsupported.');
    process.exit(1);
  }

  const isDirectory = fs.statSync(args.input).isDirectory();
  const cloneDir = isDirectory ? args.input : path.dirname(args.input);
  const indexHtmlPath = isDirectory ? path.join(args.input, 'index.html') : args.input;

  if (!fs.existsSync(indexHtmlPath)) {
    console.error(`[Haravan Compiler Error] Main index.html does not exist at: "${indexHtmlPath}"`);
    process.exit(1);
  }

  const rawHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

  // Load ThemeCompiler
  let ThemeCompiler;
  try {
    const mod = await import('../packages/site-clone/dist/index.js');
    ThemeCompiler = mod.ThemeCompiler;
  } catch {
    try {
      const mod = await import('../packages/site-clone/dist/generators/theme-compiler.js');
      ThemeCompiler = mod.ThemeCompiler;
    } catch {
      try {
        const mod = await import('../packages/site-clone/src/generators/theme-compiler.ts');
        ThemeCompiler = mod.ThemeCompiler;
      } catch {
        ThemeCompiler = undefined;
      }
    }
  }

  if (!ThemeCompiler) {
    console.error('[Haravan Compiler Error] Unable to resolve ThemeCompiler module.');
    process.exit(1);
  }

  const autoMobilePath = path.join(path.dirname(indexHtmlPath), 'mobile', 'index.html');
  const mobilePath = args.mobile || (fs.existsSync(autoMobilePath) ? autoMobilePath : undefined);
  let mobileHtml;
  if (mobilePath && fs.existsSync(mobilePath)) {
    mobileHtml = fs.readFileSync(mobilePath, 'utf-8');
    console.log(`  - Mobile Input:     ${mobilePath}`);
  }

  const outputDir = args.output;
  // Drop the alias once captured: everything below writes into the temp stage, so any
  // surviving `args.output` reference would silently mutate the live destination before
  // promotion. Removing it makes such a reference throw instead of passing unnoticed.
  delete args.output;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runner-stage-'));
  const existingSettings = path.join(outputDir, 'config', 'settings_data.json');
  if (fs.existsSync(existingSettings)) {
    fs.mkdirSync(path.join(stage, 'config'));
    fs.copyFileSync(existingSettings, path.join(stage, 'config', 'settings_data.json'));
  }
  try {
  const compiler = new ThemeCompiler();
  const assetsDir = path.join(cloneDir, 'assets');
  const result = compiler.compileTheme(stage, rawHtml, {
    settingsMode: args.settingsMode,
    assetsDir: fs.existsSync(assetsDir) ? assetsDir : undefined,
    inputPath: indexHtmlPath,
    mobileHtml,
    force: args.force,
    codeApprovals: args.codeApprovals,
  });

  const emittedTemplates = ['templates/index.liquid'];

  // If multi-page directory provided, compile remaining 14 templates
  if (isDirectory) {
    console.log('\n[Haravan Compiler] Compiling multi-page routes from matrix:');
    const templatesDir = path.join(stage, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });

    for (const route of ROUTE_DEFINITIONS) {
      const routeHtmlPath = path.join(cloneDir, route.rel);
      if (!fs.existsSync(routeHtmlPath)) {
        console.warn(`  ! Route ${route.id} (${route.name}) not found at: ${route.rel}`);
        continue;
      }

      const dHtml = fs.readFileSync(routeHtmlPath, 'utf-8');
      const mRouteHtmlPath = path.join(cloneDir, route.mobileRel);
      let mHtml = '';
      if (fs.existsSync(mRouteHtmlPath)) {
        mHtml = fs.readFileSync(mRouteHtmlPath, 'utf-8');
      }

      // Dynamically extract page-specific head assets (stylesheets & inline styles) via Core ThemeCompiler
      const headAssets = compiler.extractRouteHeadAssets(dHtml, mHtml);

      let dMain = extractMainContent(dHtml);
      dMain = applyPageSpecificTransforms(route.template, dMain, dHtml);
      dMain = rewriteLiquidAssets(dMain);

      let mMain = '';
      if (mHtml) {
        mMain = extractMainContent(mHtml);
        mMain = applyPageSpecificTransforms(route.template, mMain, mHtml);
        mMain = rewriteLiquidAssets(mMain);
      }

      let bodyContent = `<div class="desktop-only">\n${dMain}\n</div>`;
      if (mMain) {
        bodyContent += `\n\n<div class="mobile-only">\n${mMain}\n</div>`;
      }

      // Single Paginate Invariant (DotLiquid): Wrap combined dual-surface body once per template
      if (route.template === 'collection.liquid' || route.template === 'collection.no-filter.liquid' || route.template === 'collection.brand.liquid') {
        bodyContent = `{% paginate collection.products by 24 %}\n${bodyContent}\n{% endpaginate %}`;
      } else if (route.template === 'blog.liquid') {
        bodyContent = `{% paginate blog.articles by 12 %}\n${bodyContent}\n{% endpaginate %}`;
      }

      const liquidParts = [];
      if (headAssets && headAssets.liquidAssetTags) {
        liquidParts.push(headAssets.liquidAssetTags);
      }
      liquidParts.push(bodyContent);

      const targetFile = path.join(templatesDir, route.template);
      fs.writeFileSync(targetFile, liquidParts.join('\n\n') + '\n', 'utf-8');
      result.filesWritten.push(targetFile);
      emittedTemplates.push(`templates/${route.template}`);
      const assetCount = headAssets ? headAssets.sharedStylesheets.length + headAssets.desktopStylesheets.length + headAssets.mobileStylesheets.length : 0;
      console.log(`  ✓ Emitted template: templates/${route.template} (${route.name}) [${assetCount} dynamic stylesheets]`);
    }

    // Harvest and consolidate all assets across all sub-routes into theme assets/
    console.log('\n[Haravan Compiler] Consolidating all multi-route assets:');
    const targetAssetsDir = path.join(stage, 'assets');
    fs.mkdirSync(targetAssetsDir, { recursive: true });

    function copyAssetsFromDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name === 'assets') {
            const subAssets = path.join(dir, entry.name);
            for (const f of fs.readdirSync(subAssets)) {
              const src = path.join(subAssets, f);
              const dst = path.join(targetAssetsDir, f);
              if (/\.(?:css|m?js)$/i.test(f)) compiler.assertCodeOwnership(fs.readFileSync(src, 'utf8'), src, { codeApprovals: args.codeApprovals });
              if (fs.existsSync(dst)) {
                const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
                if (hash(src) !== hash(dst)) throw new Error(`Conflicting asset basename: ${f}`);
              }
              if (!fs.existsSync(dst)) {
                fs.copyFileSync(src, dst);
                if (!result.filesWritten.includes(dst)) {
                  result.filesWritten.push(dst);
                }
              }
            }
          } else if (entry.name !== 'node_modules') {
            copyAssetsFromDir(path.join(dir, entry.name));
          }
        }
      }
    }
    copyAssetsFromDir(cloneDir);
  }

  // Comprehensive Reference Domain & Hotlink Sanitization across all Liquid files
  function cleanReferenceDomainsInDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        cleanReferenceDomainsInDir(full);
      } else if (ent.name.endsWith('.liquid')) {
        let content = fs.readFileSync(full, 'utf-8');
        const cleaned = cleanReferenceDomains(content);
        if (cleaned !== content) {
          fs.writeFileSync(full, cleaned, 'utf-8');
        }
      }
    }
  }
  cleanReferenceDomainsInDir(path.join(stage, 'layout'));
  cleanReferenceDomainsInDir(path.join(stage, 'snippets'));
  cleanReferenceDomainsInDir(path.join(stage, 'templates'));

  // Register Google Sheet & Drive Settings in settings_schema.json & settings_data.json
  const schemaPath = path.join(stage, 'config', 'settings_schema.json');
  if (fs.existsSync(schemaPath)) {
    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const info = schema.find(g => g.name === 'theme_info');
      if (info) {
        info.theme_name = 'Phụ kiện máy móc';
        info.theme_author = 'AntiFan Theme Engineering';
      }
      let group = schema.find(g => g.name === 'Google Sheets & Integrations' || g.name === 'Integrations');
      if (!group) {
        group = {
          name: 'Google Sheets & Integrations',
          settings: []
        };
        schema.push(group);
      }
      const declaredIds = new Set((group.settings || []).map(s => s.id));
      const requiredSettings = [
        { type: 'text', id: 'google_sheet_quote_url', label: 'Google Sheet Webhook Báo giá', default: '' },
        { type: 'text', id: 'google_drive_quote_url', label: 'Google Drive Upload Báo giá', default: '' },
        { type: 'text', id: 'google_sheet_careers_url', label: 'Google Sheet Webhook Tuyển dụng', default: '' },
        { type: 'text', id: 'google_drive_careers_url', label: 'Google Drive Upload Tuyển dụng', default: '' }
      ];
      for (const req of requiredSettings) {
        if (!declaredIds.has(req.id)) {
          group.settings.push(req);
        }
      }
      let legacyGroup = schema.find(g => g.name === 'Legacy Compatibility');
      if (!legacyGroup) {
        legacyGroup = { name: 'Legacy Compatibility', settings: [] };
        schema.push(legacyGroup);
      }
      const existingLegacyIds = new Set(legacyGroup.settings.map(s => s.id));
      const legacySettings = [
        { type: 'text', id: 'home_collections_limit', label: 'Home Collections Limit', default: '8' },
        { type: 'checkbox', id: 'footers2_letter_check', label: 'Footer Newsletter Check', default: false },
        { type: 'text', id: 'footers2_letter_title', label: 'Footer Newsletter Title', default: '' },
        { type: 'textarea', id: 'footers2_letter_content', label: 'Footer Newsletter Content', default: '' },
        { type: 'text', id: 'shop_mailChimp', label: 'MailChimp Action URL', default: '' },
        { type: 'text', id: 'page_store_label', label: 'Store Label', default: '' },
        { type: 'checkbox', id: 'shop_mobar_check', label: 'Mobile Bar Check', default: false },
        { type: 'checkbox', id: 'use_preorder_new', label: 'Use Preorder', default: false },
        { type: 'checkbox', id: 'shop_coupon_check', label: 'Coupon Check', default: false },
        { type: 'text', id: 'header_r_phone', label: 'Header Right Phone', default: '' },
        { type: 'checkbox', id: 'home_fsale_all_day', label: 'Flash Sale All Day', default: false },
        { type: 'checkbox', id: 'home_fsale_slider', label: 'Flash Sale Slider', default: false },
        { type: 'checkbox', id: 'shop_animate_check', label: 'Shop Animate Check', default: false }
      ];
      for (const s of legacySettings) {
        if (!existingLegacyIds.has(s.id)) {
          legacyGroup.settings.push(s);
        }
      }
      for (const grp of schema) {
        if (Array.isArray(grp.settings)) {
          for (const st of grp.settings) {
            if (st.default === 'info@hoplong.com') {
              st.default = 'info@phukienmaymoc.com';
            }
          }
        }
      }
      fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[Haravan Compiler Warning] Could not update settings_schema.json:', err.message);
    }
  }

  const dataPath = path.join(stage, 'config', 'settings_data.json');
  const isCustomerCustomizeDir = outputDir.replace(/\\/g, '/').toLowerCase().includes('customizes/');
  if (fs.existsSync(dataPath) && !isCustomerCustomizeDir) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      const current = data.current || data;
      if (current.email === 'info@hoplong.com') {
        current.email = 'info@phukienmaymoc.com';
      }
      if (current.theme_title === '1 tin nhắn mới' || current.theme_title === 'Hoplongtech.com') {
        current.theme_title = 'Phụ kiện máy móc';
      }
      if (data.presets?.default) {
        if (data.presets.default.email === 'info@hoplong.com') {
          data.presets.default.email = 'info@phukienmaymoc.com';
        }
        if (data.presets.default.theme_title === '1 tin nhắn mới' || data.presets.default.theme_title === 'Hoplongtech.com') {
          data.presets.default.theme_title = 'Phụ kiện máy móc';
        }
      }
      current.google_sheet_quote_url = current.google_sheet_quote_url || '';
      current.google_drive_quote_url = current.google_drive_quote_url || '';
      current.google_sheet_careers_url = current.google_sheet_careers_url || '';
      current.google_drive_careers_url = current.google_drive_careers_url || '';
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[Haravan Compiler Warning] Could not update settings_data.json:', err.message);
    }
  }

  // Assertions Guard: Ensure all emitted templates contain their required dynamic bindings
  const assertions = [
    { file: 'templates/cart.liquid', check: c => c.includes('cart.items') && !c.includes('cart-page container'), msg: 'cart.items loop or container invariant violation' },
    { file: 'templates/product.liquid', check: c => c.includes('product.title') && c.includes('f1genz-reviews') && c.includes('series-related__header') && c.includes('Sản phẩm cùng series'), msg: 'missing product.title, f1genz-reviews, or series-related__header' },
    { file: 'templates/page.quote.liquid', check: c => c.includes('settings.google_sheet_quote_url'), msg: 'missing settings.google_sheet_quote_url' },
    { file: 'templates/page.careers.liquid', check: c => c.includes('settings.google_sheet_careers_url'), msg: 'missing settings.google_sheet_careers_url' },
    { file: 'templates/page.contact.liquid', check: c => c.includes("{% form 'contact' %}"), msg: 'missing {% form \'contact\' %}' },
    { file: 'templates/blog.liquid', check: c => c.includes('for article in blog.articles'), msg: 'missing for article in blog.articles loop' },
    { file: 'templates/collection.liquid', check: c => c.includes('for product in collection.products'), msg: 'missing for product in collection.products loop' }
  ];

  for (const { file, check, msg } of assertions) {
    const fullPath = path.join(stage, file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (!check(content)) {
        throw new Error(`[Haravan Compiler Assertion Failure] ${file}: ${msg}`);
      }
    }
  }

  // Update compiler ownership manifest while preserving generatedFiles
  const manifestPath = path.join(stage, 'config', '.antifan-theme-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      let existingManifest = {};
      try {
        existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {}
      const relFiles = result.filesWritten.map(f => path.relative(stage, f).replace(/\\/g, '/'));
      const allGenerated = Array.from(new Set([
        ...(existingManifest.generatedFiles || []),
        ...(existingManifest.files || []),
        ...relFiles
      ])).sort();
      const manifest = {
        ...existingManifest,
        compiler: 'antifan-theme-compiler',
        version: '1.0.0',
        compiledAt: new Date().toISOString(),
        targetPlatform: 'haravan',
        settingsMode: args.settingsMode,
        emittedTemplates,
        generatedFiles: allGenerated,
        files: allGenerated
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    } catch {}
  }

  compiler.promoteStagedTheme(stage, outputDir, { settingsMode: args.settingsMode, force: args.force });
  console.log('\n[Haravan Compiler] Theme compilation completed successfully!');
  console.log(`  - Target Platform:  haravan`);
  console.log(`  - Settings Mode:    ${args.settingsMode}`);
  console.log(`  - Emitted Templates: ${emittedTemplates.length}`);
  console.log(`  - Total Files:      ${result.filesWritten.length}`);
  console.log('\n[Emitted Templates List]:');
  for (const t of emittedTemplates) {
    console.log(`  + ${t}`);
  }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
main().catch(err => {
  console.error('[Haravan Compiler Fatal Error]:', err.message || err);
  process.exit(1);
});
