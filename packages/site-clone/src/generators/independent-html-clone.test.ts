import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IndependentHtmlCloneGenerator } from './independent-html-clone-generator.js';
import type { ComponentContractIR } from '../models/clone-ir.js';

describe('IndependentHtmlCloneGenerator - Standalone Bundle & Cardinality Bounds', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-html-clone-test-'));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('generates independent HTML bundle, bounds product cards to maxProducts (12), and prunes excess cards', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const assetsSourceDir = path.join(tempDir, 'assets_src');
    fs.mkdirSync(assetsSourceDir, { recursive: true });
    const localBannerPath = path.join(assetsSourceDir, 'banner.jpg');
    fs.writeFileSync(localBannerPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    // Generate 20 product cards inside product_grid rawHtml
    const productCards = Array.from({ length: 20 }, (_, i) => `
      <div class="product-item col-3" data-id="${i + 1}">
        <a href="/product/${i + 1}"><img src="https://example.com/banner.jpg" class="lazy"></a>
        <h3>Product ${i + 1}</h3>
        <span class="price">${(i + 1) * 10000} VND</span>
      </div>
    `).join('\n');

    const mockIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: {
        sourceUrl: 'https://example.com',
        extractedAt: new Date().toISOString(),
        engineVersion: '1.0.0-recon'
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'grid_section',
          name: 'Featured Products',
          archetype: 'product_grid',
          layoutType: 'grid',
          settings: {},
          blocks: [],
          rawHtml: `<section class="product-grid-wrap"><div class="row">${productCards}</div></section>`,
          liquidTemplate: '<div>Fallback Grid</div>'
        }
      ],
      components: [],
      normalizedData: {
        products: Array.from({ length: 15 }, (_, i) => ({
          id: `prod_${i + 1}`,
          title: `Product ${i + 1}`,
          handle: `product-${i + 1}`,
          vendor: 'Test Vendor',
          price: (i + 1) * 10000,
          url: `/products/product-${i + 1}`
        })),
        articles: []
      },
      assets: {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/banner.jpg',
            filename: 'banner.jpg',
            localPath: localBannerPath,
            byteCount: 4
          }
        ],
        fonts: [],
        totalBytes: 4
      }
    };

    const outDir = path.join(tempDir, 'html_clone_bundle');
    const res = await generator.generateCloneBundle(mockIR, {
      outputDir: outDir,
      maxProducts: 12,
      skipDownload: true
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.filesWritten.length > 0, true);

    const indexHtmlPath = path.join(outDir, 'index.html');
    assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist');
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');

    // Verify bounded card count: must not exceed maxProducts (12)
    const matches = html.match(/class="product-item/g);
    assert.ok(matches, 'Must have product items');
    assert.strictEqual(matches.length, 12, 'Must bound product cards to exactly 12');

    // Verify Zero Remote Hotlinks Invariant across all resource attributes and CSS url/@import
    const remoteResourcePattern = /(?:src|href|action)\s*=\s*["']https?:\/\/[^"']+["']|url\(\s*["']?https?:\/\/[^"')]+["']?\s*\)|@import\s+["']https?:\/\/[^"']+["']/gi;
    const remoteMatches = html.match(remoteResourcePattern);
    assert.strictEqual(remoteMatches, null, 'Standalone bundle must contain zero remote resource hotlinks');
    // Verify manifest was produced
    const manifestPath = path.join(outDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.strictEqual(manifest.representativeData.productCount, 12);
  });

  it('bounds article cards in blog/news sections to maxArticles (6) and prunes excess cards', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const outDir = path.join(tempDir, 'html_clone_articles');

    // Generate 15 article cards inside custom_section news rawHtml
    const articleCards = Array.from({ length: 15 }, (_, i) => `
      <div class="news-item col-4" data-post="${i + 1}">
        <a href="/news/${i + 1}"><h4>Article Title ${i + 1}</h4></a>
        <p class="summary">Summary of article ${i + 1}...</p>
      </div>
    `).join('\n');

    const mockIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: {
        sourceUrl: 'https://example.com',
        extractedAt: new Date().toISOString()
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'news_section',
          name: 'Tin tức & Blog bài viết',
          archetype: 'custom_section',
          layoutType: 'grid',
          settings: {},
          blocks: [],
          rawHtml: `<section class="news-wrap"><div class="container">${articleCards}</div></section>`,
          liquidTemplate: '<div>Fallback News</div>'
        }
      ],
      components: [],
      normalizedData: {
        products: [],
        articles: Array.from({ length: 10 }, (_, i) => ({
          id: `article_${i + 1}`,
          title: `Article Title ${i + 1}`,
          handle: `article-${i + 1}`,
          summary: `Summary of article ${i + 1}...`,
          publishedAt: new Date().toISOString(),
          url: `/news/${i + 1}`
        }))
      }
    };

    const res = await generator.generateCloneBundle(mockIR, {
      outputDir: outDir,
      maxArticles: 6,
      skipDownload: true
    });

    assert.strictEqual(res.success, true);
    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf-8');
    const matches = indexHtml.match(/class="news-item/g);
    assert.ok(matches, 'Must contain news items');
    assert.strictEqual(matches.length, 6, 'Must bound article cards to exactly 6');

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf-8'));
    assert.strictEqual(manifest.representativeData.articleCount, 6);
  });
  it('fails closed and preserves prior directory state when asset localization audit fails', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const outDir = path.join(tempDir, 'html_clone_fail_closed');
    fs.mkdirSync(outDir, { recursive: true });
    const canaryPath = path.join(outDir, 'prior_canary.txt');
    fs.writeFileSync(canaryPath, 'prior-html-clone-state', 'utf-8');

    const mockIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: {
        sourceUrl: 'https://example.com',
        extractedAt: new Date().toISOString()
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'test_sec',
          name: 'Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          settings: {},
          blocks: [],
          rawHtml: '<div><img src="https://example.com/missing.png"></div>',
          liquidTemplate: '<div>Fallback</div>'
        }
      ],
      components: [],
      assets: {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/missing.png',
            filename: 'missing.png',
            localPath: path.join(tempDir, 'non_existent_missing.png')
          }
        ],
        fonts: [],
        totalBytes: 0
      }
    };

    await assert.rejects(
      async () => {
        await generator.generateCloneBundle(mockIR, {
          outputDir: outDir,
          skipDownload: true
        });
      },
      /IndependentHtmlCloneGenerator Asset Audit Failed/
    );

    // Assert atomic guarantee: prior directory state must be preserved
    assert.ok(fs.existsSync(canaryPath), 'Canary file must remain completely intact');
    assert.strictEqual(fs.readFileSync(canaryPath, 'utf-8'), 'prior-html-clone-state');
  });

  it('enforces multi-section global cardinality bounds across multiple product sections', async () => {
    const cardsA = Array.from({ length: 8 }, (_, i) => `<div class="product-list__item"><div class="inner">Product A-${i + 1}</div></div>`).join('');
    const cardsB = Array.from({ length: 8 }, (_, i) => `<div class="product-list__item"><div class="inner">Product B-${i + 1}</div></div>`).join('');

    const bannerPath = path.join(tempDir, 'test-assets', 'banner.jpg');
    fs.mkdirSync(path.dirname(bannerPath), { recursive: true });
    fs.writeFileSync(bannerPath, 'fake');

    const multiSectionIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://example.com', extractedAt: new Date().toISOString() },
      layout: { containerMaxWidth: 1200, containerPaddingPx: 15, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'grid_section_a',
          name: 'Section A',
          archetype: 'product_grid',
          layoutType: 'grid',
          settings: {},
          blocks: [],
          rawHtml: `<section class="sec-a"><div class="product-list">${cardsA}</div></section>`
        },
        {
          id: 'grid_section_b',
          name: 'Section B',
          archetype: 'product_grid',
          layoutType: 'grid',
          settings: {},
          blocks: [],
          rawHtml: `<section class="sec-b"><div class="product-list">${cardsB}</div></section>`
        }
      ],
      normalizedData: { products: [], articles: [] },
      assets: { stylesheets: [], javascripts: [], images: [{ type: 'image', sourceUrl: 'https://example.com/banner.jpg', filename: 'banner.jpg', localPath: bannerPath, byteCount: 4 }], fonts: [], totalBytes: 4 }
    };

    const generator = new IndependentHtmlCloneGenerator();
    const targetDir = path.join(tempDir, 'multi-section-out');
    const res = await generator.generateCloneBundle(multiSectionIR, { outputDir: targetDir, maxProducts: 10 });

    assert.strictEqual(res.success, true);
    const generatedHtml = fs.readFileSync(res.entryHtmlPath, 'utf-8');
    const renderedCards = generatedHtml.match(/class=["'][^"']*product-list__item[^"']*["']/g) || [];
    assert.strictEqual(renderedCards.length, 10, 'Total rendered product cards across all sections must be exactly 10');
  });
});
