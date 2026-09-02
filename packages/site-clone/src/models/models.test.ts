import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AssetHarvester } from './asset-harvester.js';
import { ResponsiveScanner } from './responsive-scanner.js';
import { EcommerceDataModeler } from './ecommerce-data-modeler.js';

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
});
