import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AssetHarvester } from './asset-harvester.js';
import { ResponsiveScanner } from './responsive-scanner.js';
import { EcommerceDataModeler } from './ecommerce-data-modeler.js';
import { CloneIRBuilder } from './clone-ir-builder.js';
import { StateSynthesizer } from './state-synthesizer.js';
describe('Cognitive Models - Asset, Responsive & E-commerce Data', () => {
  it('1. AssetHarvester categorizes stylesheets, scripts, images, and font subsets', () => {
    const harvester = new AssetHarvester();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-assets-test-'));

    const html = `
      <link rel="stylesheet" href="https://example.com/assets/app.css?v=123">
      <script src="https://example.com/assets/vendor.js"></script>
      <img src="https://example.com/images/hero.png" alt="Hero Banner">
    `;

    try {
      const manifest = harvester.harvestFromHtml(html, tempDir);
      assert.strictEqual(manifest.stylesheets.length, 1);
      assert.strictEqual(manifest.stylesheets[0].filename, 'app.css');
      assert.strictEqual(manifest.javascripts.length, 1);
      assert.strictEqual(manifest.javascripts[0].filename, 'vendor.js');
      assert.strictEqual(manifest.images.length, 1);
      assert.strictEqual(manifest.images[0].filename, 'hero.png');
      assert.ok(manifest.fonts.length >= 3, 'Must include Vietnamese font subsets');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1b. AssetHarvester extracts srcset, picture sources, and background-images with deduplication', () => {
    const harvester = new AssetHarvester();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-assets-srcset-test-'));

    const html = `
      <picture>
        <source srcset="https://example.com/images/hero-desktop.webp 1440w, https://example.com/images/hero-mobile.webp 480w">
        <img data-src="https://example.com/images/hero-fallback.jpg" src="https://example.com/images/hero-desktop.webp" alt="Responsive Hero">
      </picture>
      <div style="background-image: url('https://example.com/images/pattern.png');">Pattern</div>
    `;

    try {
      const manifest = harvester.harvestFromHtml(html, tempDir);
      const imgUrls = manifest.images.map(img => img.sourceUrl);
      assert.ok(imgUrls.includes('https://example.com/images/hero-desktop.webp'), 'Must harvest desktop webp');
      assert.ok(imgUrls.includes('https://example.com/images/hero-mobile.webp'), 'Must harvest mobile webp');
      assert.ok(imgUrls.includes('https://example.com/images/hero-fallback.jpg'), 'Must harvest data-src');
      assert.ok(imgUrls.includes('https://example.com/images/pattern.png'), 'Must harvest background image');
      // Assert deduplication: hero-desktop.webp appeared in both srcset and src
      const desktopOccurrences = imgUrls.filter(u => u === 'https://example.com/images/hero-desktop.webp').length;
      assert.strictEqual(desktopOccurrences, 1, 'Duplicate URLs must be deduplicated');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. ResponsiveScanner provides accurate dimensions for all 3 viewports', () => {
    const scanner = new ResponsiveScanner();
    const desktop = scanner.getViewport('desktop');
    const tablet = scanner.getViewport('tablet');
    const mobile = scanner.getViewport('mobile');

    assert.strictEqual(desktop.width, 1440);
    assert.strictEqual(desktop.height, 900);
    assert.strictEqual(desktop.isMobile, false);

    assert.strictEqual(tablet.width, 768);
    assert.strictEqual(tablet.height, 1024);
    assert.strictEqual(tablet.isMobile, true);

    assert.strictEqual(mobile.width, 390);
    assert.strictEqual(mobile.height, 844);
    assert.strictEqual(mobile.isMobile, true);
    assert.strictEqual(mobile.hasTouch, true);
  });

  it('2b. ResponsiveScanner infers layout constraints and generates responsive CSS', () => {
    const scanner = new ResponsiveScanner();
    const productGridConstraint = scanner.inferLayoutConstraints('product_grid', 4);
    assert.strictEqual(productGridConstraint.desktop.columns, 4);
    assert.strictEqual(productGridConstraint.tablet.columns, 2);
    assert.strictEqual(productGridConstraint.mobile.columns, 1);
    assert.strictEqual(productGridConstraint.desktop.gapPx, 24);
    assert.strictEqual(productGridConstraint.mobile.gapPx, 12);

    const css = scanner.generateResponsiveCss(productGridConstraint, '.product-grid');
    assert.ok(css.includes('@media (min-width: 1025px)'));
    assert.ok(css.includes('grid-template-columns: repeat(4, 1fr)'));
    assert.ok(css.includes('@media (max-width: 767px)'));
    assert.ok(css.includes('gap: 12px;'));
  });

  it('3. EcommerceDataModeler extracts products, pricing, and category tree', () => {
    const modeler = new EcommerceDataModeler();
    const html = `
      <div class="category-list">
        <div class="item">
          <a href="/cat-1"><img src="cat1.png"><span>Biến Tần</span></a>
        </div>
      </div>
      <div class="products">
        <div class="product-item">
          <a href="/prod-1"><img src="prod1.png"></a>
          <h3 class="title">Contactor Schneider LC1D</h3>
          <span class="price">450.000₫</span>
        </div>
      </div>
    `;

    const data = modeler.extractStorefrontData(html);
    assert.strictEqual(data.categories.length, 1);
    assert.strictEqual(data.categories[0].title, 'Biến Tần');
    assert.strictEqual(data.products.length, 1);
    assert.strictEqual(data.products[0].title, 'Contactor Schneider LC1D');
    assert.strictEqual(data.products[0].price, 450000);
  });

  it('3b. EcommerceDataModeler parses complex price ranges, discounts, currencies, and shorthands', () => {
    // Shorthand "k" and "tr"
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('150k'), 150000);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('250K'), 250000);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('1.5tr'), 1500000);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('2 triệu'), 2000000);

    // Prefix and period stripping
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('Từ 990.000₫ / tháng'), 990000);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('Giá chỉ: $1,299.99'), 1300);

    // Structured price range with currency
    const range = EcommerceDataModeler.parseStructuredPrice('1.299.000₫ - 1.599.000₫ (-20%)');
    assert.strictEqual(range.price, 1299000);
    assert.strictEqual(range.compareAtPrice, 1599000);
    assert.strictEqual(range.currency, 'VND');

    const rangeK = EcommerceDataModeler.parseStructuredPrice('100k ~ 200k');
    assert.strictEqual(rangeK.price, 100000);
    assert.strictEqual(rangeK.compareAtPrice, 200000);
  });

  it('3c. EcommerceDataModeler extracts deep 3-level taxonomy hierarchy', () => {
    const modeler = new EcommerceDataModeler();
    const html = `
      <nav class="main-navigation">
        <ul class="nav-list">
          <li class="nav-item">
            <a href="/dien">Thiết bị đóng cắt</a>
            <ul class="sub-nav">
              <li>
                <a href="/aptomat">Aptomat MCB</a>
                <ul class="sub-sub-nav">
                  <li><a href="/mcb-1p">MCB 1 Pha</a></li>
                  <li><a href="/mcb-2p">MCB 2 Pha</a></li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </nav>
    `;

    const data = modeler.extractStorefrontData(html);
    assert.strictEqual(data.categories.length, 1);
    assert.strictEqual(data.categories[0].title, 'Thiết bị đóng cắt');
    assert.ok(data.categories[0].children, 'L1 must have children');
    assert.strictEqual(data.categories[0].children?.length, 1);
    assert.strictEqual(data.categories[0].children?.[0].title, 'Aptomat MCB');
    assert.ok(data.categories[0].children?.[0].children, 'L2 must have children');
    assert.strictEqual(data.categories[0].children?.[0].children?.length, 2);
    assert.strictEqual(data.categories[0].children?.[0].children?.[0].title, 'MCB 1 Pha');
    assert.strictEqual(data.categories[0].children?.[0].children?.[1].title, 'MCB 2 Pha');
  });

  it('4. CloneIRBuilder populates first-class assets, responsive, and controller ownership', () => {
    const builder = new CloneIRBuilder();
    const html = `
      <header class="site-header">
        <ul class="category-navigation__list">
          <li class="menu-item-has-children"><a href="/dien">Thiết bị điện</a></li>
        </ul>
      </header>
      <div class="slider s-content hero-slider">
        <div class="item">Slide 1</div>
      </div>
      <div class="product-card">
        <img src="https://example.com/p1.jpg" alt="Item" />
        <h3 class="title">Product A</h3>
        <span class="price">120.000₫</span>
      </div>
    `;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-builder-test-'));
    try {
      const ir = builder.buildFromHtml(html, 'https://example.com/store', tempDir);
      assert.strictEqual(ir.version, '1.1.0');
      assert.ok(ir.assets, 'Assets manifest must be populated');
      assert.ok(ir.assets.totalBytes >= 0);
      assert.ok(ir.responsive, 'Responsive config must be populated');
      assert.strictEqual(ir.responsive.desktop.width, 1440);
      assert.strictEqual(ir.responsive.tablet.width, 768);
      assert.strictEqual(ir.responsive.mobile.width, 390);

      assert.ok(ir.normalizedData?.products?.length === 1);
      assert.strictEqual(ir.normalizedData.products[0].price, 120000);

      assert.ok(ir.storefrontRuntime.controllers.length >= 1);
      for (const ctrl of ir.storefrontRuntime.controllers) {
        assert.ok(ctrl.id, 'Controller must have an ID');
        assert.ok(ctrl.sectionId, 'Controller must have a sectionId');
        assert.ok(ctrl.roleId, 'Controller must have a roleId');
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('5. Structured price parser accurately parses ranges, thousands separators, and decimals', () => {
    // Price ranges
    const r1 = EcommerceDataModeler.parseStructuredPrice('1.299.000 - 1.599.000đ');
    assert.strictEqual(r1.price, 1299000);
    assert.strictEqual(r1.compareAtPrice, 1599000);

    const r2 = EcommerceDataModeler.parseStructuredPrice('1.000.000đ ~ 2.000.000đ');
    assert.strictEqual(r2.price, 1000000);
    assert.strictEqual(r2.compareAtPrice, 2000000);

    const r3 = EcommerceDataModeler.parseStructuredPrice('500.000 đến 800.000 VND');
    assert.strictEqual(r3.price, 500000);
    assert.strictEqual(r3.compareAtPrice, 800000);

    // Formats & separators
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('1,299,000 ₫'), 1299000);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('450.000₫'), 450000);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('$49.99'), 50);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice('Liên hệ'), 0);
    assert.strictEqual(EcommerceDataModeler.parseSinglePrice(''), 0);
  });

  it('6. Hybrid confidence scoring achieves 100% precision on labeled corpus (10 positive vs 10 negative)', () => {
    const modeler = new EcommerceDataModeler();

    // Labeled Corpus: 10 Positive Products + 10 Negative Elements
    const corpusHtml = `
      <!-- 1-3. NEGATIVE: Navigation & Menu Links -->
      <header class="site-header">
        <nav class="main-navigation">
          <ul>
            <li><a href="/about"><img src="icon1.png" />About Us</a></li>
            <li><a href="/contact"><img src="icon2.png" />Contact</a></li>
            <li><a href="/policy"><img src="icon3.png" />Privacy Policy</a></li>
          </ul>
        </nav>
      </header>

      <!-- 4-6. NEGATIVE: Blog / News Article Grid -->
      <div class="news-section blog-grid">
        <article class="news-item">
          <a href="/blogs/news-1"><img src="news1.jpg" alt="News 1" /></a>
          <h3>Khai trương chi nhánh mới tại Đà Nẵng</h3>
          <p>Tin tức công ty</p>
        </article>
        <article class="news-item">
          <a href="/blogs/news-2"><img src="news2.jpg" alt="News 2" /></a>
          <h3>Hướng dẫn bảo dưỡng biến tần</h3>
          <p>Kỹ thuật vận hành</p>
        </article>
        <article class="news-item">
          <a href="/blogs/news-3"><img src="news3.jpg" alt="News 3" /></a>
          <h3>Xu hướng tự động hóa 2026</h3>
          <p>Báo cáo thị trường</p>
        </article>
      </div>

      <!-- 7-8. NEGATIVE: Brand / Partner Logos -->
      <div class="brand-partner-carousel">
        <div class="brand-item">
          <img src="schneider.png" alt="Schneider Electric" />
        </div>
        <div class="brand-item">
          <img src="mitsubishi.png" alt="Mitsubishi Electric" />
        </div>
      </div>

      <!-- 9-10. NEGATIVE: Footer Columns -->
      <footer class="site-footer">
        <div class="footer-col">
          <a href="/terms"><img src="f1.png" />Terms of Service</a>
        </div>
        <div class="footer-col">
          <a href="/faq"><img src="f2.png" />Frequently Asked Questions</a>
        </div>
      </footer>

      <!-- 1-4. POSITIVE: Standard Product Archetypes -->
      <div class="catalog-grid">
        <div class="product-item">
          <a href="/products/contactor"><img src="p1.jpg" alt="Contactor" /></a>
          <h3 class="product-title">Contactor LC1D</h3>
          <span class="price">320.000₫</span>
        </div>
        <div class="product-card">
          <a href="/products/relay"><img src="p2.jpg" alt="Relay" /></a>
          <h3 class="product-title">Thermal Relay LR9D</h3>
          <span class="price">480.000₫</span>
        </div>
        <div class="card-product">
          <a href="/products/inverter"><img src="p3.jpg" alt="Inverter" /></a>
          <h3 class="product-title">Biến Tần ATV310</h3>
          <span class="price-current">3.450.000₫</span>
          <span class="price-old">3.900.000₫</span>
        </div>
        <div class="item-product">
          <a href="/products/mcb"><img src="p4.jpg" alt="MCB" /></a>
          <h3 class="product-title">Aptomat MCB Acti9</h3>
          <span class="price">195.000₫</span>
        </div>
      </div>

      <!-- 5-7. POSITIVE: Obfuscated Classes with DOM Symmetry (css-card-xxx, 3 siblings) -->
      <div class="dynamic-layout-container">
        <div class="css-card-a91b">
          <a href="/prod/sensor-a"><img src="sensor1.png" alt="Sensor A" /></a>
          <div class="name">Cảm Biến Quang E3Z</div>
          <div class="amount">650.000₫</div>
        </div>
        <div class="css-card-a91b">
          <a href="/prod/sensor-b"><img src="sensor2.png" alt="Sensor B" /></a>
          <div class="name">Cảm Biến Tiệm Cận E2E</div>
          <div class="amount">420.000₫</div>
        </div>
        <div class="css-card-a91b">
          <a href="/prod/sensor-c"><img src="sensor3.png" alt="Sensor C" /></a>
          <div class="name">Bộ Điều Khiển Nhiệt Độ E5CC</div>
          <div class="amount">1.250.000₫</div>
        </div>
      </div>

      <!-- 8. POSITIVE: Schema.org Microdata -->
      <div class="custom-showcase">
        <div class="special-item" itemscope itemtype="https://schema.org/Product">
          <a href="/item/motor"><img src="motor.jpg" alt="Servo Motor" /></a>
          <h2 itemprop="name">Động Cơ Servo Delta A2</h2>
          <span class="price">8.900.000 - 9.500.000₫</span>
        </div>
      </div>

      <!-- 9-11. POSITIVE: Product Link Pattern Anchors with Repetition (>= 3 same-tag siblings) -->
      <div class="flash-sale-wrapper">
        <div class="col-sale">
          <a href="/san-pham/plc-mitsubishi"><img src="plc.jpg" alt="PLC" /></a>
          <h4>PLC Mitsubishi FX5U</h4>
          <span class="cost">5.800.000₫</span>
        </div>
        <div class="col-sale">
          <a href="/san-pham/hmi-kinco"><img src="hmi.jpg" alt="HMI" /></a>
          <h4>Màn Hình HMI Kinco 7 inch</h4>
          <span class="cost">2.600.000₫</span>
        </div>
        <div class="col-sale">
          <a href="/san-pham/inverter-fuji"><img src="fuji.jpg" alt="Inverter Fuji" /></a>
          <h4>Biến Tần Fuji Frenic</h4>
          <span class="cost">4.150.000₫</span>
        </div>
      </div>
    `;

    const bundle = modeler.extractStorefrontData(corpusHtml);

    // Precision & Recall Assertions
    assert.strictEqual(bundle.products.length, 11, `Must extract exactly 11 positive products (actual: ${bundle.products.length})`);

    const titles = bundle.products.map(p => p.title);
    // Verify zero negative false positives
    assert.ok(!titles.some(t => t === 'About Us' || t === 'Contact' || t === 'Privacy Policy'), 'No navigation links');
    assert.ok(!titles.some(t => t.includes('Khai trương') || t.includes('bảo dưỡng') || t.includes('Xu hướng')), 'No news articles');
    assert.ok(!titles.some(t => t.includes('Schneider') || t.includes('Mitsubishi Electric')), 'No brand logos');
    assert.ok(!titles.some(t => t.includes('Terms') || t.includes('FAQ')), 'No footer links');

    // Verify positive elements extracted correctly
    assert.ok(titles.some(t => t.includes('Contactor LC1D')), 'Extracts standard product 1');
    assert.ok(titles.some(t => t.includes('Thermal Relay LR9D')), 'Extracts standard product 2');
    assert.ok(titles.some(t => t.includes('Biến Tần ATV310')), 'Extracts standard product 3 with compare-at price');
    assert.ok(titles.some(t => t.includes('Cảm Biến Quang E3Z')), 'Extracts obfuscated product 1');
    assert.ok(titles.some(t => t.includes('Cảm Biến Tiệm Cận E2E')), 'Extracts obfuscated product 2');
    assert.ok(titles.some(t => t.includes('Động Cơ Servo Delta A2')), 'Extracts microdata product');
    assert.ok(titles.some(t => t.includes('PLC Mitsubishi FX5U')), 'Extracts product url product 1');
    assert.ok(titles.some(t => t.includes('Màn Hình HMI Kinco 7 inch')), 'Extracts product url product 2');
    assert.ok(titles.some(t => t.includes('Biến Tần Fuji Frenic')), 'Extracts product url product 3');
    // Verify compare-at price on ATV310
    const atv = bundle.products.find(p => p.title.includes('ATV310'));
    assert.strictEqual(atv?.price, 3450000);
    assert.strictEqual(atv?.compareAtPrice, 3900000);
  });

  it('7. StateSynthesizer infers semantic state transitions and generates declarative runtime', () => {
    const synthesizer = new StateSynthesizer();
    const transitions = synthesizer.inferStateTransitions([
      {
        id: 'c_dropdown_1',
        sectionId: 'header_sec',
        type: 'dropdown',
        targetSelector: '.sub-menu',
        triggerSelector: '.menu-item',
        behavior: 'hover_intent'
      },
      {
        id: 'c_modal_1',
        sectionId: 'video_sec',
        type: 'modal',
        targetSelector: '#video-modal',
        triggerSelector: '.open-video-btn',
        behavior: 'dialog_native'
      },
      {
        id: 'c_carousel_1',
        sectionId: 'slider_sec',
        type: 'carousel',
        targetSelector: '.slide-track',
        triggerSelector: '.next-btn',
        behavior: 'css_scroll_snap'
      }
    ]);

    assert.strictEqual(transitions.length, 3);
    assert.strictEqual(transitions[0].triggerEvent, 'mouseover');
    assert.strictEqual(transitions[0].effectType, 'class_toggle');
    assert.strictEqual(transitions[0].ariaDelta?.attribute, 'aria-expanded');
    assert.ok(transitions[0].lifecycle && transitions[0].lifecycle.length > 0);
    assert.strictEqual(transitions[0].lifecycle[0].from, 'closed');
    assert.strictEqual(transitions[0].lifecycle[0].to, 'open');

    assert.strictEqual(transitions[1].triggerEvent, 'click');
    assert.strictEqual(transitions[1].effectType, 'visibility_toggle');
    assert.strictEqual(transitions[1].ariaDelta?.attribute, 'aria-hidden');
    assert.ok(transitions[1].lifecycle && transitions[1].lifecycle.length >= 2);
    assert.strictEqual(transitions[1].lifecycle[0].from, 'closed');
    assert.strictEqual(transitions[1].lifecycle[0].to, 'opening');
    assert.strictEqual(transitions[1].lifecycle[1].from, 'open');
    assert.strictEqual(transitions[1].lifecycle[1].to, 'closing');
    assert.strictEqual(transitions[2].triggerEvent, 'click');
    assert.strictEqual(transitions[2].effectType, 'css_scroll_snap');

    const runtimeJs = synthesizer.generateDeclarativeRuntime();
    assert.ok(runtimeJs.includes('window.__antifan_rt'), 'Must define runtime guard');
    assert.ok(runtimeJs.includes('[data-antifan-toggle]'), 'Must support toggle');
    assert.ok(runtimeJs.includes('[data-antifan-modal]'), 'Must support modal');
  });

  it('8. ResponsiveScanner infers CSS breakpoint column shifts and IR contains relational constraints', () => {
    const scanner = new ResponsiveScanner();
    const sampleCss = `
      .product-grid { display: grid; grid-template-columns: repeat(4, 1fr); }
      @media (max-width: 1024px) { .product-grid { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 767px) { .product-grid { grid-template-columns: repeat(1, 1fr); } }
    `;
    const constraints = scanner.inferConstraintsFromCssRules(sampleCss, 'product_grid');
    assert.strictEqual(constraints.desktop.columns, 4);
    assert.strictEqual(constraints.tablet.columns, 2);
    assert.strictEqual(constraints.mobile.columns, 1);

    const builder = new CloneIRBuilder();
    const ir = builder.buildFromHtml('<div class="product-item">Product 1</div>');
    assert.ok(ir.layout.relations && ir.layout.relations.length > 0, 'Layout relations must be present in IR');
    assert.strictEqual(ir.layout.relations.find(r => r.viewport === 'desktop')?.value, 4);
    assert.strictEqual(ir.layout.relations.find(r => r.viewport === 'mobile')?.value, 1);
  });
});
