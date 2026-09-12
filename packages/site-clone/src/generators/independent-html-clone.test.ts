import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IndependentHtmlCloneGenerator } from './independent-html-clone-generator.js';
import type { ComponentContractIR } from '../models/clone-ir.js';

/**
 * Independent oracle for the zero-remote-hotlink invariant.
 *
 * A single `src=`/`href=` pattern cannot see the contexts that actually hotlink: `srcset` and
 * `imagesrcset` carry comma-separated candidate lists, `poster`/`formaction`/`data-src` are
 * separate attributes, and CSS reaches the network through `url()` and `@import`. Each value is
 * therefore split into candidate URLs and tested on its own.
 */
const remoteResourceUrls = (html: string): string[] => {
  const remote = (url: string): boolean => /^(?:https?:)?\/\//i.test(url.trim());
  const found: string[] = [];

  const attrPattern = /\b(src|href|action|poster|formaction|data-src|data-srcset|srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(attrPattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    const candidates = /srcset$/.test(name) ? value.split(',') : [value];
    for (const candidate of candidates) {
      const url = candidate.trim().split(/\s+/)[0] ?? '';
      if (remote(url)) found.push(`${name}=${url}`);
    }
  }

  for (const match of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (remote(url)) found.push(`url(${url})`);
  }

  for (const match of html.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const url = (match[1] ?? match[2] ?? '').trim();
    if (remote(url)) found.push(`@import ${url}`);
  }

  return found;
};

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
        <a href="/product/${i + 1}"><img src="https://example.com/banner.jpg" srcset="https://example.com/banner.jpg 1x, https://example.com/banner.jpg 2x" class="lazy"></a>
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

    // Zero Remote Hotlinks Invariant: every sub-resource attribute the fixture carries
    // (including the srcset candidate list) must have been rewritten to a local target.
    assert.deepStrictEqual(
      remoteResourceUrls(html),
      [],
      'Standalone bundle must contain zero remote resource hotlinks'
    );
    // ...and the localized candidate list must have survived as an attribute: an empty hotlink scan
    // also passes when the generator deletes the attribute instead of rewriting it.
    const localizedSrcset = html.match(/srcset="([^"]+)"/);
    assert.ok(localizedSrcset, 'the fixture srcset must survive localization as a srcset attribute');
    assert.match(localizedSrcset[1]!, /1x/, 'the localized srcset must keep its candidate list');
    assert.match(localizedSrcset[1]!, /2x/);
    assert.doesNotMatch(localizedSrcset[1]!, /example\.com/, 'no candidate may keep its remote host');
    // Verify manifest was produced
    const manifestPath = path.join(outDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.strictEqual(manifest.representativeData.productCount, 12);
  });

  it('detects remote resources hidden in srcset, poster and CSS url() contexts', () => {
    const html = [
      '<img srcset="https://cdn.example/a.jpg 1x, /assets/b.jpg 2x">',
      '<img imagesrcset="//cdn.example/c.jpg 1x">',
      '<video poster="https://cdn.example/p.jpg"></video>',
      '<form action="https://cdn.example/submit"></form>',
      '<div style="background:url(\'https://cdn.example/bg.png\')"></div>',
      '<style>@import "https://cdn.example/s.css";</style>',
      '<img src="/assets/local.jpg" srcset="/assets/local.jpg 1x">',
    ].join('\n');
    assert.deepStrictEqual(remoteResourceUrls(html), [
      'srcset=https://cdn.example/a.jpg',
      'imagesrcset=//cdn.example/c.jpg',
      'poster=https://cdn.example/p.jpg',
      'action=https://cdn.example/submit',
      'url(https://cdn.example/bg.png)',
      '@import https://cdn.example/s.css',
    ]);
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

  it('defaults to full source cardinality and emits header/main/footer in semantic body order', async () => {
    const cards = Array.from({ length: 20 }, (_, i) => `<div class="product-item col-3"><h3>Product ${i + 1}</h3></div>`).join('');
    const ir: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://example.com', extractedAt: new Date().toISOString() },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        { id: 'site_header', name: 'Header', archetype: 'header', layoutType: 'column', settings: {}, blocks: [], rawHtml: '<header class="site-header">H</header>' },
        { id: 'grid_section', name: 'Grid', archetype: 'product_grid', layoutType: 'grid', settings: {}, blocks: [], rawHtml: `<section class="product-grid-wrap">${cards}</section>` },
        { id: 'site_footer', name: 'Footer', archetype: 'footer', layoutType: 'column', settings: {}, blocks: [], rawHtml: '<div class="site-footer w-100">F</div>' }
      ],
      components: [],
      normalizedData: {
        products: Array.from({ length: 20 }, (_, i) => ({
          id: `prod_${i + 1}`, title: `Product ${i + 1}`, handle: `product-${i + 1}`, vendor: 'Test Vendor', price: (i + 1) * 1000, url: `/products/product-${i + 1}`
        })),
        articles: []
      },
      assets: { stylesheets: [], javascripts: [], images: [], fonts: [], totalBytes: 0 }
    };

    const generator = new IndependentHtmlCloneGenerator();
    const outDir = path.join(tempDir, 'html_clone_defaults');
    const res = await generator.generateCloneBundle(ir, { outputDir: outDir, skipDownload: true });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.productCount, 20, 'Uncapped run must report every source product');
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf-8');
    assert.strictEqual((html.match(/class="product-item/g) || []).length, 20, 'Uncapped run must retain every source card');

    const headerAt = html.indexOf('<header class="site-header">');
    const mainAt = html.indexOf('<main>');
    const footerAt = html.indexOf('<div class="site-footer w-100">');
    assert.ok(headerAt > -1 && mainAt > -1 && footerAt > -1, 'Header, main and footer must all be present');
    assert.ok(headerAt < mainAt && mainAt < footerAt, 'Body order must be header -> main -> footer');
    const mainHtml = html.slice(mainAt, html.indexOf('</main>') + 7);
    assert.ok(!mainHtml.includes('site-footer'), 'Footer must not be nested inside main');
  });

  it('emits source head styles after linked stylesheets so page-specific CSS keeps cascade priority', async () => {
    const themePath = path.join(tempDir, 'theme-head-styles.css');
    fs.writeFileSync(themePath, '.theme{}');

    const ir: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://example.com', extractedAt: new Date().toISOString() },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        { id: 'hero', name: 'Hero', archetype: 'custom_section', layoutType: 'flow', settings: {}, blocks: [], rawHtml: '<section class="hero">H</section>' }
      ],
      normalizedData: { products: [], articles: [] },
      assets: {
        stylesheets: [{ type: 'css', sourceUrl: 'https://example.com/assets/theme-head-styles.css', filename: 'theme-head-styles.css', localPath: themePath, byteCount: 9 }],
        javascripts: [],
        images: [],
        fonts: [],
        totalBytes: 9
      },
      headStyles: [
        '<style id="flatsome-main-inline-css">.logo{max-height:40px}</style>',
        '<style id="custom-css">:root{--brand:#005baa}</style>'
      ]
    };

    const generator = new IndependentHtmlCloneGenerator();
    const outDir = path.join(tempDir, 'head_styles_out');
    const res = await generator.generateCloneBundle(ir, { outputDir: outDir, skipDownload: true });

    assert.strictEqual(res.success, true);
    const html = fs.readFileSync(res.entryHtmlPath, 'utf-8');
    const linkAt = html.indexOf('theme-head-styles.css');
    const firstStyleAt = html.indexOf('flatsome-main-inline-css');
    const secondStyleAt = html.indexOf('custom-css');
    assert.ok(linkAt > -1, 'linked stylesheet must survive into the bundle head');
    assert.ok(firstStyleAt > linkAt, 'inline head styles must follow linked stylesheets');
    assert.ok(secondStyleAt > firstStyleAt, 'inline head styles must keep their source order');
    assert.ok(html.includes(':root{--brand:#005baa}'), 'inline head CSS content must be preserved verbatim');
  });
});
