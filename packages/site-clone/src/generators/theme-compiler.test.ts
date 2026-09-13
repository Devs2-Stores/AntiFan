import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeCompiler } from './theme-compiler.js';
import {
  type ComponentContractIR,
  createDefaultComponentContractIR,
} from '../models/clone-ir.js';

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

  it('10. Preserves already-wrapped asset_url in srcset and src without double-wrapping or quote corruption', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-srcset-'));
    const html = '<section id="srcset_sec"><img src="{{ \'logo.png\' | asset_url }}" srcset="{{ \'hero.png\' | asset_url }} 1x, {{ \'hero@2x.png\' | asset_url }} 2x"></section>';

    try {
      compiler.compileTheme(tempDir, html);
      const snippetPath = path.join(tempDir, 'snippets', 'srcset_sec.liquid');
      assert.ok(fs.existsSync(snippetPath));
      const content = fs.readFileSync(snippetPath, 'utf-8');
      assert.ok(!content.includes("{{ '{{"), 'Must not double-wrap asset_url');
      assert.ok(content.includes('srcset="{{ \'hero.png\' | asset_url }} 1x, {{ \'hero@2x.png\' | asset_url }} 2x"'), 'Must keep single-quoted filenames inside double-quoted srcset');
      assert.ok(content.includes('src="{{ \'logo.png\' | asset_url }}"'), 'Must keep single-quoted filename inside double-quoted src');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('11. Safely preserves existing merchant-owned settings in config/settings_data.json on recompile', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-merchant-settings-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings_data.json'),
      JSON.stringify({
        current: {
          merchant_custom_announcement: 'Sale 50% Off Today',
          merchant_theme_color: '#ff5500',
        },
      }),
      'utf-8'
    );

    const html = '<section id="sec_welcome"><h2>Welcome</h2></section>';

    try {
      compiler.compileTheme(tempDir, html);
      const dataPath = path.join(tempDir, 'config', 'settings_data.json');
      assert.ok(fs.existsSync(dataPath));
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      assert.strictEqual(
        data.current.merchant_custom_announcement,
        'Sale 50% Off Today',
        'Merchant announcement setting must be preserved'
      );
      assert.strictEqual(
        data.current.merchant_theme_color,
        '#ff5500',
        'Merchant theme color setting must be preserved'
      );
      assert.ok(
        'sec_welcome_enabled' in data.current,
        'Compiler generated setting should also be present'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('12. Preserves authentic rawHtml when liquidTemplate carries synthetic section.blocks loop', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-rawhtml-blocks-'));
    const ir: ComponentContractIR = {
      ...createDefaultComponentContractIR('https://example.com'),
      sections: [
        {
          id: 'sec_authentic_banner',
          name: 'Authentic Banner',
          archetype: 'custom_section',
          layoutType: 'flow',
          heading: 'Authentic Banner',
          className: 'authentic-banner-class',
          rawHtml: '<div class="authentic-banner-class"><div class="hero-inner"><h1>Hero Authentic</h1></div></div>',
          liquidTemplate: '<div class="authentic-banner-class">{% for block in section.blocks %}<div class="slide">{{ block.settings.title }}</div>{% endfor %}</div>',
          blockDefinitions: [],
          settings: {},
          blocks: [],
        },
      ],
    };

    try {
      compiler.compileThemeFromIR(tempDir, ir);
      const snippetPath = path.join(tempDir, 'snippets', 'sec_authentic_banner.liquid');
      assert.ok(fs.existsSync(snippetPath));
      const content = fs.readFileSync(snippetPath, 'utf-8');
      assert.ok(
        content.includes('Hero Authentic'),
        'Must preserve authentic rawHtml content in snippet'
      );
      assert.ok(
        !content.includes('{% for block in section.blocks %}'),
        'Must not emit synthetic section.blocks loop in Haravan flat snippet'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('13. Prevents duplicate id attribute injection in modal controller', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-modal-id-'));
    const html = `
      <section id="sec_modal_test">
        <button class="modal-btn" data-target="#modal-dialog-1">Open Modal</button>
        <div class="modal" id="modal-dialog-1">
          <div class="modal-content"><p>Content</p></div>
        </div>
      </section>
    `;

    try {
      compiler.compileTheme(tempDir, html);
      const snippetPath = path.join(tempDir, 'snippets', 'sec_modal_test.liquid');
      assert.ok(fs.existsSync(snippetPath));
      const content = fs.readFileSync(snippetPath, 'utf-8');
      const idMatches = content.match(/id=["']modal-dialog-1["']/gi);
      assert.strictEqual(idMatches?.length, 1, 'Modal dialog should have exactly one id attribute');
      assert.ok(content.includes('data-antifan-modal-dialog'), 'Must have modal dialog attribute');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('14. Uses defined IR layout breakpoint instead of invented 991px in custom CSS and responsive media queries', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-breakpoint-'));
    const ir: ComponentContractIR = {
      ...createDefaultComponentContractIR('https://example.com'),
      layout: {
        containerMaxWidth: 1280,
        containerPaddingPx: 16,
        gridGapPx: 20,
        breakpoints: {
          mobileMax: 768,
          tabletMin: 769,
          tabletMax: 1024,
          desktopMin: 1025,
        },
      },
      sections: [
        {
          id: 'sec_test',
          name: 'Test Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          rawHtml: '<div class="test">Test</div>',
          liquidTemplate: '<div class="test">Test</div>',
          blockDefinitions: [],
          settings: {},
          blocks: [],
        },
      ],
    };

    try {
      compiler.compileThemeFromIR(tempDir, ir);
      const customCssPath = path.join(tempDir, 'assets', 'custom.css');
      assert.ok(fs.existsSync(customCssPath));
      const customCss = fs.readFileSync(customCssPath, 'utf-8');
      assert.ok(
        !customCss.includes('@media (max-width: 991px)'),
        'Must not invent arbitrary 991px media queries in custom.css'
      );
      assert.ok(
        !customCss.includes('.mobile-only { display: block; }'),
        'Must not emit global hiding/display toggles in custom.css'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('15. Preserves user-owned snippets not in compiler manifest and fails on overwrite conflict without waiver', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-user-preservation-'));
    const snippetsDir = path.join(tempDir, 'snippets');
    fs.mkdirSync(snippetsDir, { recursive: true });
    const userSnippetPath = path.join(snippetsDir, 'user_custom_widget.liquid');
    fs.writeFileSync(userSnippetPath, '<div>My Custom User Widget</div>', 'utf-8');

    const html1 = '<section id="sec_standard"><h2>Standard Section</h2></section>';

    try {
      // Run 1: Compile theme with unrelated section
      compiler.compileTheme(tempDir, html1);
      assert.ok(fs.existsSync(userSnippetPath), 'User-owned snippet must be preserved');
      assert.strictEqual(
        fs.readFileSync(userSnippetPath, 'utf-8'),
        '<div>My Custom User Widget</div>',
        'User-owned snippet content must not be modified'
      );

      // Run 2: Compile with section ID that conflicts with user-owned snippet without waiver -> must throw
      const conflictingHtml = '<section id="user_custom_widget"><h2>Conflict Section</h2></section>';
      assert.throws(
        () => {
          compiler.compileTheme(tempDir, conflictingHtml);
        },
        /overwrite conflict on user-owned file/i,
        'Compiler must fail closed on overwrite conflict with user-owned file'
      );

      // Run 3: Conflicting compilation without waiver always fails closed
      assert.throws(
        () => {
          compiler.compileTheme(tempDir, conflictingHtml);
        },
        /overwrite conflict on user-owned file/i,
        'Compilation must refuse to overwrite unmanaged file unconditionally'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('16. Migrates merchant asset settings in settings_data.json when assets are renamed per manifest assetMap', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-asset-rename-migration-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings_data.json'),
      JSON.stringify({
        current: {
          site_logo: 'logo-original.png',
          hero_bg: 'assets/hero-raw.jpg',
          promo_banner: 'banner-promo.png',
          ambiguous_asset: 'shared-icon.png',
        },
      }),
      'utf-8'
    );

    const ir: ComponentContractIR = {
      ...createDefaultComponentContractIR('https://example.com'),
      assets: {
        stylesheets: [],
        javascripts: [],
        fonts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/images/logo-original.png',
            filename: 'logo-original-desktop.png',
            localPath: '',
            originalFilename: 'logo-original.png',
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/images/hero-raw.jpg',
            filename: 'hero-raw-w1920.jpg',
            localPath: '',
            originalFilename: 'hero-raw.jpg',
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/images/shared-icon.png',
            filename: 'shared-icon-desktop.png',
            localPath: '',
            originalFilename: 'shared-icon.png',
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/mobile/images/shared-icon.png',
            filename: 'shared-icon-mobile.png',
            localPath: '',
            originalFilename: 'shared-icon.png',
          },
        ],
        totalBytes: 1000,
        assetMap: {
          'logo-original.png': 'logo-original-desktop.png',
          'hero-raw.jpg': 'hero-raw-w1920.jpg',
        },
      } as unknown as ComponentContractIR['assets'],
      sections: [
        {
          id: 'sec_home',
          name: 'Home Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          rawHtml: '<div>Home</div>',
          liquidTemplate: '<div>Home</div>',
          blockDefinitions: [],
          settings: {},
          blocks: [],
        },
      ],
    };

    try {
      compiler.compileThemeFromIR(tempDir, ir);
      const dataPath = path.join(tempDir, 'config', 'settings_data.json');
      assert.ok(fs.existsSync(dataPath));
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      assert.strictEqual(
        data.current.site_logo,
        'logo-original-desktop.png',
        'Merchant logo asset reference must be migrated to renamed asset filename'
      );
      assert.strictEqual(
        data.current.hero_bg,
        'assets/hero-raw-w1920.jpg',
        'Merchant asset path reference must be migrated to renamed asset path'
      );
      assert.strictEqual(
        data.current.promo_banner,
        'banner-promo.png',
        'Unrenamed merchant asset reference must stay untouched'
      );
      assert.strictEqual(
        data.current.ambiguous_asset,
        'shared-icon.png',
        'Ambiguous asset reference shared across multiple targets must be refused and preserved as-is'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('17. Preserves full dual-surface DOM (header, body sections, footer) when options.mobileHtml is provided, keying layout primarily on source viewport breakpoint with data-device support', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-dual-surface-'));
    const ir: ComponentContractIR = {
      ...createDefaultComponentContractIR('https://example.com'),
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 16,
        breakpoints: {
          mobileMax: 768,
          tabletMin: 769,
          tabletMax: 1024,
          desktopMin: 1025,
        },
      },
      sections: [
        {
          id: 'site_header',
          name: 'Desktop Header',
          archetype: 'header',
          layoutType: 'flow',
          rawHtml: '<header class="desktop-header">Desktop Nav</header>',
          liquidTemplate: '<header class="desktop-header">Desktop Nav</header>',
          settings: {},
          blocks: [],
        },
        {
          id: 'featured_products',
          name: 'Featured Products',
          archetype: 'custom_section',
          layoutType: 'flow',
          rawHtml: '<div id="featured_products" class="products">Desktop Products</div>',
          liquidTemplate: '<div id="featured_products" class="products">Desktop Products</div>',
          settings: {},
          blocks: [],
        },
        {
          id: 'site_footer',
          name: 'Desktop Footer',
          archetype: 'footer',
          layoutType: 'flow',
          rawHtml: '<footer class="desktop-footer">Desktop Footer</footer>',
          liquidTemplate: '<footer class="desktop-footer">Desktop Footer</footer>',
          settings: {},
          blocks: [],
        },
      ],
    };

    const mobileHtml = `
<!DOCTYPE html>
<html lang="vi">
<head><title>Mobile Site</title></head>
<body data-device="mobile">
  <header class="site-header">
    <div class="mobile-nav">Mobile Nav</div>
  </header>
  <div class="category-navigation__block">
    <div class="drawer">Mobile Drawer</div>
  </div>
  <div id="mobile_promo" class="section banner-block">
    <h1>Mobile Promo</h1>
  </div>
  <div id="featured_products" class="section mobile-products-block">
    <h2>Mobile Products</h2>
  </div>
  <footer class="site-footer">
    <div class="mobile-footer">Mobile Footer</div>
  </footer>
</body>
</html>
`.trim();

    try {
      const compiler = new ThemeCompiler();
      const result = compiler.compileThemeFromIR(tempDir, ir, { mobileHtml });
      assert.strictEqual(result.success, true);

      // 1. Header snippet preserves both surfaces
      const headerPath = path.join(tempDir, 'snippets', 'header.liquid');
      assert.ok(fs.existsSync(headerPath));
      const headerContent = fs.readFileSync(headerPath, 'utf-8');
      assert.ok(headerContent.includes('theme-surface-desktop'), 'Header must contain desktop surface wrapper');
      assert.ok(headerContent.includes('Desktop Nav'), 'Header must contain desktop nav markup');
      assert.ok(headerContent.includes('theme-surface-mobile'), 'Header must contain mobile surface wrapper');
      assert.ok(headerContent.includes('Mobile Nav'), 'Header must contain mobile nav markup');
      assert.ok(headerContent.includes('Mobile Drawer'), 'Header must preserve mobile navigation drawer');

      // 2. Footer snippet preserves both surfaces
      const footerPath = path.join(tempDir, 'snippets', 'footer.liquid');
      assert.ok(fs.existsSync(footerPath));
      const footerContent = fs.readFileSync(footerPath, 'utf-8');
      assert.ok(footerContent.includes('theme-surface-desktop'), 'Footer must contain desktop surface wrapper');
      assert.ok(footerContent.includes('Desktop Footer'), 'Footer must contain desktop footer markup');
      assert.ok(footerContent.includes('theme-surface-mobile'), 'Footer must contain mobile surface wrapper');
      assert.ok(footerContent.includes('Mobile Footer'), 'Footer must contain mobile footer markup');

      // 3. templates/index.liquid composes both surfaces
      const indexPath = path.join(tempDir, 'templates', 'index.liquid');
      assert.ok(fs.existsSync(indexPath));
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      assert.ok(indexContent.includes('<div class="theme-surface-desktop">'), 'Index must wrap desktop sections');
      assert.ok(indexContent.includes("{% include 'featured_products' %}"), 'Index must include desktop featured_products');
      assert.ok(indexContent.includes('<div class="theme-surface-mobile">'), 'Index must wrap mobile sections');

      // 4. Mobile body sections emitted preserving source IDs (scoped by container .theme-surface-mobile)
      const mobileSnippets = fs.readdirSync(path.join(tempDir, 'snippets')).filter(f => f.startsWith('mobile_'));
      assert.ok(mobileSnippets.length >= 2, 'Must emit mobile section snippets for body sections');

      // Check source ID preserved in mobile section snippet for CSS/JS selector stability
      let foundPreservedId = false;
      for (const mFile of mobileSnippets) {
        const mContent = fs.readFileSync(path.join(tempDir, 'snippets', mFile), 'utf-8');
        if (mContent.includes('id="featured_products"')) {
          foundPreservedId = true;
        }
      }
      assert.ok(foundPreservedId, 'Source ID featured_products must be preserved intact inside container rather than broken by renaming');

      // 5. custom.css uses viewport media query as primary switch, with data-device as extra signal
      const customCssPath = path.join(tempDir, 'assets', 'custom.css');
      assert.ok(fs.existsSync(customCssPath));
      const customCssContent = fs.readFileSync(customCssPath, 'utf-8');
      assert.ok(
        customCssContent.includes('@media (max-width: 768px)'),
        'CSS must use source mobileMax viewport media query as primary switch'
      );
      assert.ok(
        customCssContent.includes('.theme-surface-desktop {\n    display: none !important;'),
        'CSS must hide desktop surface on mobile viewport'
      );
      assert.ok(
        customCssContent.includes('.theme-surface-mobile {\n    display: block !important;'),
        'CSS must show mobile surface on mobile viewport'
      );
      assert.ok(
        customCssContent.includes('body[data-device="mobile"] .theme-surface-desktop'),
        'CSS must also support body[data-device="mobile"] as extra explicit signal'
      );

      // 6. theme.js includes dual-surface ID & inert subtree synchronizer
      const themeJsPath = path.join(tempDir, 'assets', 'theme.js');
      assert.ok(fs.existsSync(themeJsPath));
      const themeJsContent = fs.readFileSync(themeJsPath, 'utf-8');
      assert.ok(
        themeJsContent.includes('syncDualSurfaceActiveIDs'),
        'theme.js must include dual-surface active ID synchronizer'
      );
      assert.ok(
        themeJsContent.includes('data-inert-id'),
        'theme.js must demote inactive surface IDs to data-inert-id'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('18. Auto-derives mobile surface from sibling mobile/index.html clone artifact without explicit mobileHtml flag in production compileTheme call', () => {
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-clone-artifact-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-clone-theme-out-'));

    try {
      // Set up documented AntiFan clone directory structure:
      // <cloneDir>/index.html
      // <cloneDir>/assets/
      // <cloneDir>/mobile/index.html
      const assetsDir = path.join(cloneDir, 'assets');
      const mobileDir = path.join(cloneDir, 'mobile');
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.mkdirSync(mobileDir, { recursive: true });

      const desktopHtml = `
<!DOCTYPE html>
<html lang="vi">
<head><title>Desktop Store</title></head>
<body>
  <header class="site-header"><h1>Desktop Brand</h1></header>
  <main>
    <section id="hero_promo"><h2>Desktop Promo</h2></section>
  </main>
  <footer class="site-footer"><p>Desktop Footer</p></footer>
</body>
</html>
`.trim();

      const mobileHtml = `
<!DOCTYPE html>
<html lang="vi">
<head><title>Mobile Store</title></head>
<body data-device="mobile">
  <header class="site-header"><h1>Mobile Brand</h1></header>
  <main>
    <section id="mobile_deals"><h2>Mobile Deals</h2></section>
  </main>
  <footer class="site-footer"><p>Mobile Footer</p></footer>
</body>
</html>
`.trim();

      fs.writeFileSync(path.join(cloneDir, 'index.html'), desktopHtml, 'utf-8');
      fs.writeFileSync(path.join(mobileDir, 'index.html'), mobileHtml, 'utf-8');

      const compiler = new ThemeCompiler();
      // Production call exactly matching scripts/compile-haravan-theme.mjs:
      // compileTheme(outDir, rawHtml, { settingsMode, assetsDir }) without mobileHtml flag
      const result = compiler.compileTheme(outDir, desktopHtml, {
        settingsMode: 'legacy-html',
        assetsDir,
        inputPath: path.join(cloneDir, 'index.html'),
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.sectionCount >= 1);

      // 1. Verify header snippet auto-derived mobile surface from sibling artifact
      const headerPath = path.join(outDir, 'snippets', 'header.liquid');
      assert.ok(fs.existsSync(headerPath), 'Header snippet must exist');
      const headerContent = fs.readFileSync(headerPath, 'utf-8');
      assert.ok(headerContent.includes('theme-surface-desktop'), 'Header must contain desktop surface');
      assert.ok(headerContent.includes('Desktop Brand'), 'Header must contain desktop markup');
      assert.ok(headerContent.includes('theme-surface-mobile'), 'Header must auto-include mobile surface');
      assert.ok(headerContent.includes('Mobile Brand'), 'Header must contain mobile markup');

      // 2. Verify footer snippet auto-derived mobile surface from sibling artifact
      const footerPath = path.join(outDir, 'snippets', 'footer.liquid');
      assert.ok(fs.existsSync(footerPath), 'Footer snippet must exist');
      const footerContent = fs.readFileSync(footerPath, 'utf-8');
      assert.ok(footerContent.includes('theme-surface-desktop'), 'Footer must contain desktop surface');
      assert.ok(footerContent.includes('Desktop Footer'), 'Footer must contain desktop markup');
      assert.ok(footerContent.includes('theme-surface-mobile'), 'Footer must auto-include mobile surface');
      assert.ok(footerContent.includes('Mobile Footer'), 'Footer must contain mobile markup');

      // 3. Verify templates/index.liquid composes both surfaces
      const indexPath = path.join(outDir, 'templates', 'index.liquid');
      assert.ok(fs.existsSync(indexPath), 'templates/index.liquid must exist');
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      assert.ok(indexContent.includes('theme-surface-desktop'), 'Index must include desktop container');
      assert.ok(indexContent.includes('theme-surface-mobile'), 'Index must include mobile container');

      // 4. Verify theme.js has dual-surface synchronizer
      const themeJsPath = path.join(outDir, 'assets', 'theme.js');
      assert.ok(fs.existsSync(themeJsPath), 'assets/theme.js must exist');
      const themeJsContent = fs.readFileSync(themeJsPath, 'utf-8');
      assert.ok(
        themeJsContent.includes('syncDualSurfaceActiveIDs'),
        'theme.js must include dual-surface synchronizer'
      );
    } finally {
      fs.rmSync(cloneDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
