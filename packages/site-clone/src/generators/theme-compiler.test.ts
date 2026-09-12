import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeCompiler } from './theme-compiler.js';
import type { ComponentContractIR } from '../models/clone-ir.js';

describe('ThemeCompiler - Haravan Flat Architecture & Canonical Contract (Audit Phase 05)', () => {
  const compiler = new ThemeCompiler();

  it('1. Compiles Haravan flat directory structure in default legacy-html mode', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-legacy-'));

    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Store</title></head>
        <body>
          <header class="site-header" id="main_hdr">
            <div class="logo"><img src="logo.png" alt="Logo"></div>
          </header>
          <section id="hero_sec" class="slide">
            <div class="s-content">
              <div class="s-content__item"><img src="slide1.jpg" alt="Slide 1"></div>
              <div class="s-content__item"><img src="slide2.jpg" alt="Slide 2"></div>
            </div>
          </section>
          <section id="prod_sec" class="block-category">
            <h2>Sản Phẩm Mới</h2>
          </section>
          <footer class="site-footer" id="main_ftr">
            <p>Copyright 2026</p>
          </footer>
        </body>
      </html>
    `;

    try {
      const result = compiler.compileTheme(tempDir, sampleHtml, { settingsMode: 'legacy-html' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.targetContract.settingsMode, 'legacy-html');

      // 1a. Verify layout/theme.liquid
      const layoutFile = path.join(tempDir, 'layout', 'theme.liquid');
      assert.ok(fs.existsSync(layoutFile), 'layout/theme.liquid must exist');
      const layoutContent = fs.readFileSync(layoutFile, 'utf-8');
      assert.ok(layoutContent.includes('content_for_layout'));
      assert.ok(layoutContent.includes('content_for_header'));
      assert.ok(layoutContent.includes("{% include 'header' %}"), 'theme.liquid must include header snippet');
      assert.ok(layoutContent.includes("{% include 'footer' %}"), 'theme.liquid must include footer snippet');

      // 1b. Verify flat templates/index.liquid (never index.json)
      const indexLiquidFile = path.join(tempDir, 'templates', 'index.liquid');
      assert.ok(fs.existsSync(indexLiquidFile), 'templates/index.liquid must exist');
      const indexJsonFile = path.join(tempDir, 'templates', 'index.json');
      assert.strictEqual(fs.existsSync(indexJsonFile), false, 'templates/index.json must NOT exist');

      const indexLiquidContent = fs.readFileSync(indexLiquidFile, 'utf-8');
      assert.ok(indexLiquidContent.includes('{% include'), 'index.liquid must compose with {% include %}');

      // 1c. Verify snippets/*.liquid exists and sections/ does NOT exist
      const sectionsDir = path.join(tempDir, 'sections');
      assert.strictEqual(fs.existsSync(sectionsDir), false, 'sections/ directory must NOT exist on Haravan');

      const snippetsDir = path.join(tempDir, 'snippets');
      assert.ok(fs.existsSync(snippetsDir), 'snippets/ directory must exist');
      const snippetFiles = fs.readdirSync(snippetsDir);
      assert.ok(snippetFiles.includes('header.liquid'), 'header.liquid snippet must exist');
      assert.ok(snippetFiles.includes('footer.liquid'), 'footer.liquid snippet must exist');

      // 1d. Verify legacy settings mode: config/settings.html + settings_data.json; NO settings_schema.json
      const settingsHtmlFile = path.join(tempDir, 'config', 'settings.html');
      assert.ok(fs.existsSync(settingsHtmlFile), 'config/settings.html must exist in legacy-html mode');
      const settingsSchemaFile = path.join(tempDir, 'config', 'settings_schema.json');
      assert.strictEqual(fs.existsSync(settingsSchemaFile), false, 'config/settings_schema.json must NOT exist in legacy-html mode');

      const settingsHtmlContent = fs.readFileSync(settingsHtmlFile, 'utf-8');
      assert.ok(!settingsHtmlContent.includes('{%'), 'config/settings.html must be pure HTML without {% tags');
      assert.ok(!settingsHtmlContent.includes('{{'), 'config/settings.html must be pure HTML without {{ tags');
      assert.ok(settingsHtmlContent.includes('<table>'), 'settings.html must format rows in tables');

      const settingsDataFile = path.join(tempDir, 'config', 'settings_data.json');
      assert.ok(fs.existsSync(settingsDataFile), 'config/settings_data.json must exist');
      const settingsData = JSON.parse(fs.readFileSync(settingsDataFile, 'utf-8'));
      assert.ok(settingsData.current, 'settings_data.json must have current object');

      // 1e. Verify no forbidden constructs in any generated liquid file
      for (const sf of snippetFiles) {
        const content = fs.readFileSync(path.join(snippetsDir, sf), 'utf-8');
        assert.ok(!content.includes('{% schema %}'), `${sf} must not contain {% schema %}`);
        assert.ok(!content.includes('{% render'), `${sf} must not contain {% render %}`);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. Compiles Haravan flat directory structure in f1genz-schema mode', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-f1genz-'));

    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>F1GENZ Store</title></head>
        <body>
          <section id="banner" class="banner"><h2>Chào Mừng</h2></section>
        </body>
      </html>
    `;

    try {
      const result = compiler.compileTheme(tempDir, sampleHtml, { settingsMode: 'f1genz-schema' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.targetContract.settingsMode, 'f1genz-schema');

      // Verify schema file exists and is valid JSON
      const settingsSchemaFile = path.join(tempDir, 'config', 'settings_schema.json');
      assert.ok(fs.existsSync(settingsSchemaFile), 'config/settings_schema.json must exist in f1genz-schema mode');
      const settingsHtmlFile = path.join(tempDir, 'config', 'settings.html');
      assert.strictEqual(fs.existsSync(settingsHtmlFile), false, 'config/settings.html must NOT exist in f1genz-schema mode');

      const schemaJson = JSON.parse(fs.readFileSync(settingsSchemaFile, 'utf-8'));
      assert.ok(Array.isArray(schemaJson), 'settings_schema.json must be an array of groups');
      assert.ok(schemaJson.length > 0, 'settings_schema.json must have at least one group');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. Rejects dual settings mode and unknown settings mode (fails closed)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-reject-'));
    const sampleHtml = '<section id="test"><h2>Test</h2></section>';

    try {
      // Dual mode must fail closed
      assert.throws(
        () => compiler.compileTheme(tempDir, sampleHtml, { settingsMode: 'dual' }),
        /Haravan target contract violation.*dual/i
      );

      // Unknown mode must fail closed
      assert.throws(
        () => compiler.compileTheme(tempDir, sampleHtml, { settingsMode: 'unsupported_mode' }),
        /Haravan target contract violation/i
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. Detects and rejects unresolved snippet includes in generated Liquid', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-unresolved-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'layout'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'templates'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'layout', 'theme.liquid'), '{{ content_for_layout }}');
      // index.liquid includes non-existent snippet "ghost_component"
      fs.writeFileSync(
        path.join(tempDir, 'templates', 'index.liquid'),
        "{% include 'ghost_component' %}"
      );
      fs.writeFileSync(path.join(tempDir, 'config', 'settings.html'), '<p>Settings</p>');
      fs.writeFileSync(path.join(tempDir, 'config', 'settings_data.json'), '{}');

      assert.throws(
        () => compiler.validateStagingTheme(tempDir, { platform: 'haravan', settingsMode: 'legacy-html', topology: { layout: 'layout/theme.liquid', templates: ['templates/index.liquid'], snippetDir: 'snippets' }, emitLocales: false }),
        /unresolved snippet include "ghost_component"/
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('5. Ensures every settings ID read in Liquid is resolved in settings declaration and data defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-ids-'));

    const ir: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://test.vn', extractedAt: new Date().toISOString() },
      layout: { containerMaxWidth: 1200, containerPaddingPx: 16, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
      storefrontRuntime: { controllers: [] },
      themeSettings: [
        { id: 'custom_banner_heading', type: 'text', label: 'Custom Banner Heading', default: 'Default Heading' },
      ],
      sections: [
        {
          id: 'banner_sec',
          name: 'Banner',
          archetype: 'custom_section',
          layoutType: 'flow',
          settings: {},
          blocks: [],
          liquidTemplate: '<section><h1>{{ settings.custom_banner_heading }}</h1><p>{{ settings.unlisted_promo_text }}</p></section>',
        },
      ],
    };

    try {
      const result = compiler.compileTheme(tempDir, ir, { settingsMode: 'legacy-html' });
      assert.strictEqual(result.success, true);

      // Read settings.html and settings_data.json
      const settingsHtml = fs.readFileSync(path.join(tempDir, 'config', 'settings.html'), 'utf-8');
      const settingsData = JSON.parse(fs.readFileSync(path.join(tempDir, 'config', 'settings_data.json'), 'utf-8'));

      // Both custom_banner_heading and unlisted_promo_text must exist in settings.html
      assert.ok(settingsHtml.includes('name="custom_banner_heading"'), 'custom_banner_heading must be in settings.html');
      assert.ok(settingsHtml.includes('name="unlisted_promo_text"'), 'unlisted_promo_text must be in settings.html');

      // Both must exist in settings_data.json
      assert.ok('custom_banner_heading' in settingsData.current, 'custom_banner_heading must be in settings_data.json');
      assert.ok('unlisted_promo_text' in settingsData.current, 'unlisted_promo_text must be in settings_data.json');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('6. Escapes quotes in setting defaults in config/settings.html', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-escape-'));

    const ir: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://test.vn', extractedAt: new Date().toISOString() },
      layout: { containerMaxWidth: 1200, containerPaddingPx: 16, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
      storefrontRuntime: { controllers: [] },
      themeSettings: [
        { id: 'quote_setting', type: 'text', label: 'Quote Setting', default: 'Text with "double quotes" & <tags>' },
      ],
      sections: [],
    };

    try {
      compiler.compileTheme(tempDir, ir, { settingsMode: 'legacy-html' });
      const settingsHtml = fs.readFileSync(path.join(tempDir, 'config', 'settings.html'), 'utf-8');
      assert.ok(settingsHtml.includes('&quot;double quotes&quot;'), 'Quotes in value attribute must be escaped as &quot;');
      assert.ok(!settingsHtml.includes('value="Text with "double quotes"'), 'Raw quotes inside value attribute must not exist');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('7. Preserves controllers (carousel, modal) and injects declarative attributes into snippets', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-ctrls-'));

    const ir: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://test.vn', extractedAt: new Date().toISOString() },
      layout: { containerMaxWidth: 1200, containerPaddingPx: 16, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
      themeSettings: [],
      sections: [
        {
          id: 'slider_sec',
          name: 'Slider Section',
          archetype: 'hero_slider',
          layoutType: 'scroll_snap_carousel',
          className: 'hero-slider',
          liquidTemplate: '<section class="hero-slider"><div class="slider"><div class="item">Slide 1</div></div></section>',
          settings: {},
          blocks: [],
        },
        {
          id: 'modal_sec',
          name: 'Modal Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          className: 'modal-wrap',
          liquidTemplate: '<section class="modal-wrap"><button class="modal-btn">Open Dialog</button></section>',
          settings: {},
          blocks: [],
        },
      ],
      storefrontRuntime: {
        controllers: [
          {
            id: 'ctrl_slider',
            sectionId: 'slider_sec',
            roleId: 'slider_track',
            type: 'carousel',
            targetSelector: '.hero-slider .slider',
            triggerSelector: '.hero-slider .slider-nav',
            behavior: 'css_scroll_snap',
          },
          {
            id: 'ctrl_modal',
            sectionId: 'modal_sec',
            roleId: 'dialog_view',
            type: 'modal',
            targetSelector: '#promo-modal-popup',
            triggerSelector: '.modal-btn',
            behavior: 'dialog_native',
          },
        ],
      },
    };

    try {
      compiler.compileTheme(tempDir, ir);

      // Verify slider attributes in snippets/slider_sec.liquid
      const sliderSnippet = path.join(tempDir, 'snippets', 'slider_sec.liquid');
      assert.ok(fs.existsSync(sliderSnippet), 'slider_sec.liquid snippet must exist');
      const sliderContent = fs.readFileSync(sliderSnippet, 'utf-8');
      assert.ok(sliderContent.includes('data-antifan-slider'), 'Snippet must have data-antifan-slider');

      // Verify modal attributes in snippets/modal_sec.liquid
      const modalSnippet = path.join(tempDir, 'snippets', 'modal_sec.liquid');
      assert.ok(fs.existsSync(modalSnippet), 'modal_sec.liquid snippet must exist');
      const modalContent = fs.readFileSync(modalSnippet, 'utf-8');
      assert.ok(modalContent.includes('data-antifan-modal="#promo-modal-popup"'), 'Snippet must have data-antifan-modal');
      assert.ok(modalContent.includes('data-antifan-modal-dialog'), 'Snippet must have data-antifan-modal-dialog');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('8. Liquid dynamic binding engine binds collections, products, and articles with DotLiquid sanitization', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-bindings-'));

    const ir: ComponentContractIR = {
      version: '1.2.0',
      metadata: { sourceUrl: 'https://test.vn', extractedAt: new Date().toISOString() },
      layout: { containerMaxWidth: 1200, containerPaddingPx: 16, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'coll_sec',
          name: 'Featured Collection',
          archetype: 'product_grid',
          layoutType: 'grid',
          className: 'product-grid-section',
          liquidTemplate: '<section class="product-grid"><div class="product-card"><a href="/products/item-1"><img src="item1.jpg" alt="Item"><h3 class="product-title">Item 1</h3><span class="price">100.000₫</span></a></div></section>',
          settings: {},
          blocks: [],
        },
        {
          id: 'article_sec',
          name: 'Latest Article',
          archetype: 'rich_text',
          layoutType: 'column',
          className: 'blog-post-section',
          liquidTemplate: '<section class="blog-section"><article class="article-item"><h2 class="article-title">Tin Tức Haravan</h2><div class="article-content"><p>Nội dung</p></div></article></section>',
          settings: {},
          blocks: [],
        },
      ],
    };

    try {
      compiler.compileTheme(tempDir, ir);

      // Verify collection binding in snippet
      const collSnippet = path.join(tempDir, 'snippets', 'coll_sec.liquid');
      assert.ok(fs.existsSync(collSnippet));
      const collContent = fs.readFileSync(collSnippet, 'utf-8');
      assert.ok(collContent.includes('{% for product in collection.products %}'), 'Must bind collection loop');
      assert.ok(collContent.includes('{{ product.title }}'), 'Must bind product title');

      // Verify article binding in snippet
      const articleSnippet = path.join(tempDir, 'snippets', 'article_sec.liquid');
      assert.ok(fs.existsSync(articleSnippet));
      const articleContent = fs.readFileSync(articleSnippet, 'utf-8');
      assert.ok(articleContent.includes('{{ article.title }}'), 'Must bind article title');
      assert.ok(articleContent.includes('{{ article.content }}'), 'Must bind article content');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('9. Purges stale generated files when recompiling with different sections', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-purge-'));

    const htmlRun1 = '<section id="old_sec_a"><h2>Old A</h2></section><section id="old_sec_b"><h2>Old B</h2></section>';
    const htmlRun2 = '<section id="new_sec_x"><h2>New X</h2></section>';

    try {
      compiler.compileTheme(tempDir, htmlRun1);
      const snippetsRun1 = fs.readdirSync(path.join(tempDir, 'snippets'));
      assert.ok(snippetsRun1.includes('old_sec_a.liquid'));
      assert.ok(snippetsRun1.includes('old_sec_b.liquid'));

      compiler.compileTheme(tempDir, htmlRun2);
      const snippetsRun2 = fs.readdirSync(path.join(tempDir, 'snippets'));
      assert.ok(snippetsRun2.includes('new_sec_x.liquid'));
      assert.strictEqual(snippetsRun2.includes('old_sec_a.liquid'), false, 'Stale snippet old_sec_a must be purged');
      assert.strictEqual(snippetsRun2.includes('old_sec_b.liquid'), false, 'Stale snippet old_sec_b must be purged');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
