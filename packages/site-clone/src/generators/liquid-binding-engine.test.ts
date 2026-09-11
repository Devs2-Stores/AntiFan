import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { LiquidBindingEngine } from './liquid-binding-engine.js';

describe('LiquidBindingEngine', () => {
  const engine = new LiquidBindingEngine();

  describe('bindProductSection', () => {
    it('binds product detail HTML to Liquid objects (title, prices, image, description, vendor, form)', () => {
      const inputHtml = `
<div class="product-detail">
  <div class="product-gallery">
    <img src="https://example.com/assets/pro-1.jpg" alt="Original Title" class="product-image">
  </div>
  <div class="product-info">
    <h1 class="product-title">Áo Polo Nam Thể Thao</h1>
    <span class="product-vendor">Antifan Brand</span>
    <span class="product-sku">AP-001-BLK</span>
    <div class="product-prices">
      <span class="current-price">299.000₫</span>
      <del class="compare-price">399.000₫</del>
    </div>
    <div class="product-description">
      <p>Chất liệu cotton thoáng mát, thấm hút mồ hôi tốt.</p>
    </div>
    <form action="/cart/add" method="post" class="product-form">
      <select name="id">
        <option value="1">Đen / M</option>
        <option value="2">Đen / L</option>
      </select>
      <input type="number" name="quantity" value="1">
      <button type="submit" class="btn-add-to-cart">Thêm vào giỏ hàng</button>
    </form>
  </div>
</div>
      `.trim();

      const bound = engine.bindProductSection(inputHtml);

      // Title
      assert.ok(bound.includes('{{ product.title }}'), 'Must bind product title');
      assert.ok(!bound.includes('Áo Polo Nam Thể Thao'), 'Must replace static title');

      // Prices
      assert.ok(bound.includes('{{ product.price | money }}'), 'Must bind current price');
      assert.ok(bound.includes('{{ product.compare_at_price | money }}'), 'Must bind compare at price');

      // Image
      assert.ok(bound.includes("{{ product.featured_image | img_url: 'master' }}"), 'Must bind featured image');
      assert.ok(bound.includes('alt="{{ product.title | escape }}"'), 'Must bind image alt');

      // Metadata
      assert.ok(bound.includes('{{ product.vendor }}'), 'Must bind vendor');
      assert.ok(bound.includes('{{ product.selected_or_first_available_variant.sku }}'), 'Must bind SKU');
      assert.ok(bound.includes('{{ product.content }}'), 'Must bind product description content');

      // Form & Variants
      assert.ok(bound.includes("{% form 'product', product %}"), 'Must inject form opening tag');
      assert.ok(bound.includes('{% endform %}'), 'Must inject form closing tag');
      assert.ok(bound.includes('{% for variant in product.variants %}'), 'Must inject variant loop');
      assert.ok(bound.includes('{{ variant.id }}'), 'Must bind variant id');
    });

    it('injects form wrapper and variant selector when form tag is absent in product detail', () => {
      const inputHtml = `
<div class="product-detail">
  <h1 class="product-title">Giày Sneaker Chạy Bộ</h1>
  <span class="pro-price">1.250.000₫</span>
  <button class="btn-add-to-cart">Mua ngay</button>
</div>
      `.trim();

      const bound = engine.bindProductSection(inputHtml);

      assert.ok(bound.includes("{% form 'product', product %}"), 'Must inject form tag');
      assert.ok(bound.includes('{% endform %}'), 'Must inject endform tag');
      assert.ok(bound.includes('name="id"'), 'Must inject variant selector with name="id"');
      assert.ok(bound.includes('{% for variant in product.variants %}'), 'Must inject variant loop');
    });

    it('binds product card HTML with isCard: true', () => {
      const cardHtml = `
<div class="product-card">
  <div class="card-thumb">
    <a href="/products/ao-khoac-du" class="product-link">
      <img src="thumb.jpg" alt="Áo khoác dù" class="product-img">
    </a>
  </div>
  <div class="card-body">
    <h3 class="product-title">
      <a href="/products/ao-khoac-du">Áo khoác dù chống nước</a>
    </h3>
    <div class="card-price">
      <span class="current-price">450.000₫</span>
      <del class="compare-price">600.000₫</del>
    </div>
    <button class="btn-add-to-cart">Thêm nhanh</button>
  </div>
</div>
      `.trim();

      const bound = engine.bindProductSection(cardHtml, { isCard: true });

      // Link and Title
      assert.ok(bound.includes('href="{{ product.url }}"'), 'Must bind product url to links');
      assert.ok(bound.includes('{{ product.title }}'), 'Must bind title inside card');
      assert.ok(!bound.includes('Áo khoác dù chống nước'), 'Must replace static card title');

      // Image
      assert.ok(bound.includes("src=\"{{ product.featured_image | img_url: 'master' }}\""), 'Must bind image src');
      assert.ok(bound.includes('alt="{{ product.title | escape }}"'), 'Must bind image alt');

      // Prices
      assert.ok(bound.includes('{{ product.price | money }}'), 'Must bind card current price');
      assert.ok(bound.includes('{{ product.compare_at_price | money }}'), 'Must bind card compare price');

      // Quick add form on card
      assert.ok(bound.includes("{% form 'product', product %}"), 'Must wrap quick add button in form');
      assert.ok(bound.includes('{{ product.selected_or_first_available_variant.id }}'), 'Must inject hidden variant id for card');
    });
    it('scopes form replacement strictly to forms with purchase indicators and leaves search/newsletter forms uncorrupted', () => {
      const htmlWithMultipleForms = `
<div class="product-page">
  <form action="/search" method="get" class="search-form">
    <input type="search" name="q" placeholder="Tìm sản phẩm..." />
    <button type="submit">Tìm kiếm</button>
  </form>
  <div class="product-detail">
    <h1 class="product-title">Giày Sneaker</h1>
    <form action="/cart/add" method="post" class="product-form" data-cart="true">
      <select name="id"><option value="101">Size 41</option></select>
      <button type="submit" class="btn-add-to-cart">Mua hàng</button>
    </form>
  </div>
  <form action="/contact#newsletter" method="post" class="newsletter-form">
    <input type="email" name="contact[email]" placeholder="Nhập email..." />
    <button type="submit">Đăng ký</button>
  </form>
</div>
      `.trim();

      const bound = engine.bindProductSection(htmlWithMultipleForms);

      // Search form must NOT be corrupted into product form
      assert.ok(bound.includes('<form action="/search" method="get" class="search-form">'), 'Search form opening tag must remain untouched');
      assert.ok(bound.includes('</form>'), 'Non-purchase forms must retain closing tag');

      // Newsletter form must NOT be corrupted into product form
      assert.ok(bound.includes('<form action="/contact#newsletter" method="post" class="newsletter-form">'), 'Newsletter form opening tag must remain untouched');

      // Only the product form with purchase indicators must be converted
      assert.ok(bound.includes("{% form 'product', product %}"), 'Product form must be converted to Liquid form');
      assert.ok(bound.includes('{% endform %}'), 'Product form must have endform');
    });
  });

  describe('bindCollectionSection', () => {
    it('binds product grid to collection loop with default collection.products', () => {
      const sectionHtml = `
<section class="collection-section">
  <div class="container">
    <h2 class="collection-title">Sản Phẩm Bán Chạy</h2>
    <p class="collection-description">Danh sách sản phẩm được yêu thích nhất tháng qua.</p>
    <div class="product-grid">
      <div class="product-card">
        <a href="/products/p-1" class="product-link">
          <img src="p1.jpg" alt="P1">
          <h3 class="product-title">Sản phẩm 1</h3>
          <span class="price-current">100.000₫</span>
        </a>
      </div>
      <div class="product-card">
        <a href="/products/p-2" class="product-link">
          <img src="p2.jpg" alt="P2">
          <h3 class="product-title">Sản phẩm 2</h3>
          <span class="price-current">200.000₫</span>
        </a>
      </div>
    </div>
  </div>
</section>
      `.trim();

      const bound = engine.bindCollectionSection(sectionHtml);

      assert.ok(bound.includes('{{ collection.title }}'), 'Must bind collection title');
      assert.ok(bound.includes('{{ collection.description }}'), 'Must bind collection description');
      assert.ok(bound.includes('{% for product in collection.products %}'), 'Must inject collection.products loop');
      assert.ok(bound.includes('{% endfor %}'), 'Must close for-loop');
      assert.ok(bound.includes('{{ product.title }}'), 'Must bind card template within loop');
      assert.ok(bound.includes('{{ product.price | money }}'), 'Must bind card price within loop');
      assert.ok(!bound.includes('Sản phẩm 2'), 'Must collapse static repeated siblings');
    });

    it('binds product grid using custom collectionHandle', () => {
      const sectionHtml = `
<div class="featured-collection">
  <h2 class="collection-title">Flash Sale Hôm Nay</h2>
  <div class="product-grid">
    <div class="product-card">
      <a href="/products/deal-1"><img src="d1.jpg"><span class="product-title">Deal 1</span><span class="current-price">50.000₫</span></a>
    </div>
    <div class="product-card">
      <a href="/products/deal-2"><img src="d2.jpg"><span class="product-title">Deal 2</span><span class="current-price">80.000₫</span></a>
    </div>
  </div>
</div>
      `.trim();

      const bound = engine.bindCollectionSection(sectionHtml, 'flash-sale');

      assert.ok(bound.includes("{{ collections['flash-sale'].title }}"), 'Must bind custom collection title');
      assert.ok(bound.includes("{% for product in collections['flash-sale'].products %}"), 'Must bind custom collection handle loop');
      assert.ok(bound.includes('{% endfor %}'), 'Must close for-loop');
    });
  });

  describe('bindArticleSection', () => {
    it('binds blog article HTML to Liquid article object (title, content, author, published_at, image)', () => {
      const articleHtml = `
<article class="article-detail">
  <header class="article-header">
    <h1 class="article-title">Bí quyết phối đồ phong cách vintage năm 2026</h1>
    <div class="article-meta">
      <span class="author">Tác giả: Minh Trang</span>
      <time class="published-at" datetime="2026-09-12">12/09/2026</time>
    </div>
  </header>
  <div class="featured-image">
    <img src="vintage-cover.jpg" alt="Vintage Style" class="article-image">
  </div>
  <div class="article-excerpt">
    <p>Khám phá cách phối đồ vintage cổ điển nhưng không lỗi mốt.</p>
  </div>
  <div class="article-content">
    <p>Nội dung chi tiết bài viết với nhiều mẹo hữu ích...</p>
    <p>Phần 2 của bài viết.</p>
  </div>
</article>
      `.trim();

      const bound = engine.bindArticleSection(articleHtml);

      // Title
      assert.ok(bound.includes('{{ article.title }}'), 'Must bind article title');
      assert.ok(!bound.includes('Bí quyết phối đồ phong cách vintage'), 'Must replace static article title');

      // Content
      assert.ok(bound.includes('{{ article.content }}'), 'Must bind article content');
      assert.ok(!bound.includes('Nội dung chi tiết bài viết với nhiều mẹo hữu ích'), 'Must replace static content');

      // Author
      assert.ok(bound.includes('{{ article.author }}'), 'Must bind article author');

      // Published At
      assert.ok(bound.includes("{{ article.published_at | date: '%d/%m/%Y' }}"), 'Must bind published_at date');
      assert.ok(bound.includes("datetime=\"{{ article.published_at | date: '%Y-%m-%d' }}\""), 'Must bind datetime attribute on time tag');

      // Image & Excerpt
      assert.ok(bound.includes("{{ article.image | img_url: 'master' }}"), 'Must bind article image');
      assert.ok(bound.includes('{{ article.excerpt }}'), 'Must bind article excerpt');
    });
    it('preserves HTML tags and capture groups in title and content replacers without literal $1 or $3 leakage', () => {
      const articleHtml = `
<div class="blog-post">
  <h1 class="article-title" data-heading="main">Tiêu đề bài viết chuyên sâu</h1>
  <div class="article-content" data-reading-time="5">
    <p>Nội dung đoạn 1.</p>
    <p>Nội dung đoạn 2.</p>
  </div>
</div>
      `.trim();

      const bound = engine.bindArticleSection(articleHtml);
      assert.ok(!bound.includes('$1'), 'Must not leak literal $1');
      assert.ok(!bound.includes('$3'), 'Must not leak literal $3');
      assert.ok(bound.includes('<h1 class="article-title" data-heading="main">{{ article.title }}</h1>'), 'Must preserve h1 tags and attributes');
      assert.ok(bound.includes('<div class="article-content" data-reading-time="5">{{ article.content }}</div>'), 'Must preserve content div tags and attributes');
    });
  });

  describe('sanitizeDotLiquid', () => {
    it('sanitizes string slice filter into truncate to prevent DotLiquid LINQ dump (HS20)', () => {
      const raw = '<span>{{ customer.name | slice: 0, 1 }}</span>';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('slice: 0, 1'), 'Must remove slice filter');
      assert.ok(sanitized.includes("truncate: 1, ''"), 'Must replace with truncate');
    });

    it('sanitizes != empty and == empty to != blank and == blank against DotLiquid type mismatch', () => {
      const raw = '{% if product.variants != empty and product.id == empty %}{% endif %}';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('!= empty'), 'Must replace != empty');
      assert.ok(!sanitized.includes('== empty'), 'Must replace == empty');
      assert.ok(sanitized.includes('!= blank'), 'Must use != blank');
      assert.ok(sanitized.includes('== blank'), 'Must use == blank');
    });

    it('sanitizes drop/metafield .size > 0 checks', () => {
      const raw = '{% if product_recommend.size > 0 %}<div>...</div>{% endif %}';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('.size > 0'), 'Must not use .size > 0');
      assert.ok(sanitized.includes('product_recommend != blank'), 'Must convert to != blank');
    });

    it('sanitizes unsupported Ruby methods in for loops (.each, .reverse)', () => {
      const raw = `
{% for item in collection.products.each %}
  <span>{{ item.title }}</span>
{% endfor %}
{% for item in collection.products.reverse %}
  <span>{{ item.title }}</span>
{% endfor %}
      `.trim();
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('products.each'), 'Must strip .each');
      assert.ok(sanitized.includes('for item in collection.products'), 'Must use plain loop');
      assert.ok(!sanitized.includes('products.reverse'), 'Must replace .reverse');
      assert.ok(sanitized.includes('for item in collection.products reversed'), 'Must use reversed keyword');
    });

    it('sanitizes Ruby type conversion methods (.to_i, .to_s, .to_f, .length)', () => {
      const raw = '{{ settings.max_items.to_i }} {{ item.count.to_s }} {{ price.to_f }} {{ items.length }}';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('.to_i'), 'Must replace .to_i');
      assert.ok(sanitized.includes('plus: 0'), 'Must convert to plus: 0');
      assert.ok(!sanitized.includes('.to_s'), 'Must replace .to_s');
      assert.ok(sanitized.includes("append: ''"), 'Must convert to append');
      assert.ok(!sanitized.includes('.to_f'), 'Must replace .to_f');
      assert.ok(sanitized.includes('plus: 0.0'), 'Must convert to plus: 0.0');
      assert.ok(!sanitized.includes('.length'), 'Must replace .length');
      assert.ok(sanitized.includes('size'), 'Must convert to size');
    });

    it('sanitizes logical operators inside liquid tags (&&, ||, ===, !==, null)', () => {
      const raw = '{% if a === 1 && b !== null || c === 2 %}<span>OK</span>{% endif %}';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('&&'), 'Must replace && with and');
      assert.ok(sanitized.includes(' and '), 'Must use and');
      assert.ok(!sanitized.includes('||'), 'Must replace || with or');
      assert.ok(sanitized.includes(' or '), 'Must use or');
      assert.ok(!sanitized.includes('==='), 'Must replace === with ==');
      assert.ok(!sanitized.includes('!=='), 'Must replace !== with !=');
      assert.ok(!sanitized.includes('null'), 'Must replace null with nil');
    });

    it('sanitizes Ruby symbol lookups and unquoted filter arguments', () => {
      const raw = "{{ product[:title] }} {{ product.featured_image | img_url: master }} {{ article.published_at | date: %d/%m/%Y }}";
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('[:title]'), 'Must replace [:title]');
      assert.ok(sanitized.includes("['title']"), 'Must convert to string bracket lookup');
      assert.ok(sanitized.includes("img_url: 'master'"), 'Must quote master filter argument');
      assert.ok(sanitized.includes("date: '%d/%m/%Y'"), 'Must quote date filter format');
    });

    it('sanitizes raw article.image.src | img_url to prevent broken image URLs (HS21)', () => {
      const raw = '<img src="{{ article.image.src | img_url: master }}">';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(!sanitized.includes('article.image.src'), 'Must replace raw article.image.src pipe');
      assert.ok(sanitized.includes("article.image | img_url: 'master'"), 'Must convert to safe article.image filter');
    });
    it('constrains Ruby type casting within single tag boundaries without crossing HTML or multiple tags', () => {
      const raw = '{{ settings.max_items.to_i }} <p>Check file.to_i and script.to_s here</p> {% if item.count.to_s != blank %}<span>{{ items.length }}</span>{% endif %}';
      const sanitized = engine.sanitizeDotLiquid(raw);
      assert.ok(sanitized.includes('{{ settings.max_items | plus: 0 }}'), 'Must sanitize .to_i inside {{ }}');
      assert.ok(sanitized.includes('<p>Check file.to_i and script.to_s here</p>'), 'Must NOT touch .to_i or .to_s outside Liquid tags');
      assert.ok(sanitized.includes("{% if item.count | append: '' != blank %}"), 'Must sanitize .to_s inside {% %}');
      assert.ok(sanitized.includes('{{ items | size }}'), 'Must sanitize .length inside {{ }}');
    });
  });
});
