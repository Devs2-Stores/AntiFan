import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeCompiler } from './theme-compiler.js';

describe('ThemeCompiler - End-to-End Haravan OS 2.0 Theme Compilation', () => {
  const compiler = new ThemeCompiler();

  it('1. Compiles complete Haravan OS 2.0 directory structure with valid JSON and Liquid files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-theme-'));

    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Store</title></head>
        <body>
          <header class="site-header" id="main_hdr">
            <div class="logo"><img src="logo.png"></div>
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
      const result = compiler.compileTheme(tempDir, sampleHtml);
      assert.strictEqual(result.sectionCount, 4);

      // Verify layout/theme.liquid
      const layoutFile = path.join(tempDir, 'layout', 'theme.liquid');
      assert.ok(fs.existsSync(layoutFile), 'theme.liquid must exist');
      const layoutContent = fs.readFileSync(layoutFile, 'utf-8');
      assert.ok(layoutContent.includes('content_for_layout'));
      assert.ok(layoutContent.includes('content_for_header'));
      // Verify templates/index.json
      const indexFile = path.join(tempDir, 'templates', 'index.json');
      assert.ok(fs.existsSync(indexFile), 'index.json must exist');
      const indexJson = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      assert.ok(Array.isArray(indexJson.order), 'index.json must have order array');
      assert.ok(typeof indexJson.sections === 'object', 'index.json must have sections map');

      // Verify section blocks in index.json
      const heroSec = indexJson.sections['hero_sec'];
      assert.ok(heroSec, 'hero_sec must exist in index.json');
      assert.ok(heroSec.blocks, 'hero_sec must contain blocks in index.json');
      assert.ok(Array.isArray(heroSec.block_order), 'hero_sec must have block_order in index.json');
      assert.strictEqual(heroSec.block_order.length, 2);
      assert.strictEqual(heroSec.blocks['slide_1'].settings.image_url, 'slide1.jpg');
      // Verify sections and schema definitions
      const sectionFiles = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(sectionFiles.length >= 4, 'Must create all section files');

      for (const sFile of sectionFiles) {
        const sContent = fs.readFileSync(path.join(tempDir, 'sections', sFile), 'utf-8');
        const schemaMatch = sContent.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
        assert.ok(schemaMatch, `${sFile} must contain {% schema %}`);
        
        const schemaObj = JSON.parse(schemaMatch[1]);
        assert.ok(schemaObj.name, 'Schema must have name');
        assert.ok(Array.isArray(schemaObj.settings), 'Schema settings must be an array');
        assert.ok(Array.isArray(schemaObj.blocks), 'Schema blocks must be an array');

        // Verify each block definition in schema has settings as an ARRAY of definitions
        for (const blockDef of schemaObj.blocks) {
          assert.ok(blockDef.type, 'Block definition must have type');
          assert.ok(blockDef.name, 'Block definition must have name');
          assert.ok(Array.isArray(blockDef.settings), 'Block schema settings must be an array of definitions, not an object');
          for (const settingDef of blockDef.settings) {
            assert.ok(settingDef.type, 'Setting definition must have type');
            assert.ok(settingDef.id, 'Setting definition must have id');
            assert.ok(settingDef.label, 'Setting definition must have label');
          }
        }
      }

      // Verify config/settings_schema.json
      const schemaFile = path.join(tempDir, 'config', 'settings_schema.json');
      assert.ok(fs.existsSync(schemaFile), 'settings_schema.json must exist');
      const schemaJson = JSON.parse(fs.readFileSync(schemaFile, 'utf-8'));
      assert.ok(Array.isArray(schemaJson), 'settings_schema.json must be an array');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. Purges stale generated files when recompiling with different sections', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-purge-test-'));

    const htmlRun1 = `
      <section id="old_section_a" class="block-category"><h2>Old A</h2></section>
      <section id="old_section_b" class="block-category"><h2>Old B</h2></section>
    `;

    const htmlRun2 = `
      <section id="new_section_x" class="slide"><h2>New X</h2></section>
    `;

    try {
      compiler.compileTheme(tempDir, htmlRun1);
      const filesRun1 = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(filesRun1.includes('old_section_a.liquid'));
      assert.ok(filesRun1.includes('old_section_b.liquid'));

      compiler.compileTheme(tempDir, htmlRun2);
      const filesRun2 = fs.readdirSync(path.join(tempDir, 'sections'));

      assert.ok(!filesRun2.includes('old_section_a.liquid'), 'Must purge old_section_a');
      assert.ok(!filesRun2.includes('old_section_b.liquid'), 'Must purge old_section_b');
      assert.ok(filesRun2.includes('new_section_x.liquid'), 'Must contain new_section_x');
      assert.strictEqual(filesRun2.length, 1, 'Only newly compiled sections must exist');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. Preserves prior valid output when compilation fails mid-run (Atomic Rollback)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-atomic-test-'));

    const validHtml = `
      <section id="stable_section" class="block-category"><h2>Stable Section</h2></section>
    `;

    try {
      // Step 1: Successful initial compilation
      compiler.compileTheme(tempDir, validHtml);
      const initialSections = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(initialSections.includes('stable_section.liquid'));
      const initialIndexContent = fs.readFileSync(path.join(tempDir, 'templates', 'index.json'), 'utf-8');

      // Step 2: Second compilation with invalid input (null/empty string) throws
      assert.throws(() => {
        compiler.compileTheme(tempDir, null as unknown as string);
      }, /ThemeCompiler/);

      // Step 3: Assert prior destination files remain completely intact
      const afterSections = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(afterSections.includes('stable_section.liquid'), 'Prior stable section must be preserved');
      const afterIndexContent = fs.readFileSync(path.join(tempDir, 'templates', 'index.json'), 'utf-8');
      assert.strictEqual(afterIndexContent, initialIndexContent, 'templates/index.json must not be corrupted or wiped');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. Compiles directly from ComponentContractIR object with clean decoupling', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-ir-test-'));
    const ir = {
      version: '1.0.0' as const,
      metadata: {
        sourceUrl: 'https://decoupled-store.vn',
        extractedAt: new Date().toISOString()
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 20,
        gridGapPx: 16,
        breakpoints: {
          mobileMax: 767,
          tabletMin: 768,
          tabletMax: 1024,
          desktopMin: 1025
        }
      },
      themeSettings: [
        { id: 'color_primary', type: 'color' as const, label: 'Primary', default: '#112233' }
      ],
      sections: [
        {
          id: 'custom_banner',
          name: 'Custom Banner',
          archetype: 'hero_slider' as const,
          layoutType: 'scroll_snap_carousel' as const,
          heading: 'Khuyến mãi đặc biệt',
          className: 'banner-hero',
          settings: {},
          blocks: [
            {
              id: 'slide_1',
              type: 'slide',
              name: 'Slide 1',
              settings: { title: 'Mùa Hè Sôi Động' }
            }
          ]
        }
      ],
      storefrontRuntime: {
        controllers: []
      },
      normalizedData: {
        siteSettings: {
          title: 'Decoupled Store',
          hotline: '0988776655',
          email: 'contact@decoupled.vn'
        }
      }
    };

    try {
      const result = compiler.compileTheme(tempDir, ir);
      assert.strictEqual(result.sectionCount, 1);
      assert.ok(fs.existsSync(path.join(tempDir, 'sections', 'custom_banner.liquid')));
      const indexJson = JSON.parse(fs.readFileSync(path.join(tempDir, 'templates', 'index.json'), 'utf-8'));
      assert.ok(indexJson.sections.custom_banner);
      assert.strictEqual(indexJson.sections.custom_banner.type, 'custom_banner');
      assert.strictEqual(indexJson.sections.custom_banner.settings.heading, 'Khuyến mãi đặc biệt');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('5. Compiles theme.js with universal declarative runtime and injects data-antifan attributes into sections', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-runtime-test-'));
    const ir = {
      version: '1.1.0' as const,
      metadata: {
        sourceUrl: 'https://declarative-store.vn',
        extractedAt: new Date().toISOString()
      },
      layout: {
        containerMaxWidth: 1280,
        containerPaddingPx: 16,
        gridGapPx: 20,
        breakpoints: {
          mobileMax: 767,
          tabletMin: 768,
          tabletMax: 1024,
          desktopMin: 1025
        }
      },
      themeSettings: [],
      sections: [
        {
          id: 'hero_slider_1',
          name: 'Hero Slider',
          archetype: 'hero_slider' as const,
          layoutType: 'scroll_snap_carousel' as const,
          className: 'hero-slider-wrap',
          liquidTemplate: '<section class="hero-slider-wrap"><div class="slider"><div class="item">Slide 1</div></div></section>',
          settings: {},
          blocks: []
        },
        {
          id: 'video_modal_sec',
          name: 'Video Modal Section',
          archetype: 'custom_section' as const,
          layoutType: 'flow' as const,
          className: 'video-sec',
          liquidTemplate: '<section class="video-sec"><button class="modal-btn">Xem video</button></section>',
          settings: {},
          blocks: []
        }
      ],
      storefrontRuntime: {
        controllers: [
          {
            id: 'hero_ctrl_1',
            sectionId: 'hero_slider_1',
            roleId: 'slider_track',
            type: 'carousel' as const,
            targetSelector: '.hero-slider-wrap .slider',
            triggerSelector: '.nav-btn',
            behavior: 'css_scroll_snap' as const
          },
          {
            id: 'modal_ctrl_1',
            sectionId: 'video_modal_sec',
            roleId: 'video_dialog',
            type: 'modal' as const,
            targetSelector: '#video-dialog-popup',
            triggerSelector: '.modal-btn',
            behavior: 'dialog_native' as const
          }
        ]
      }
    };

    try {
      compiler.compileTheme(tempDir, ir);

      // 1. Verify assets/theme.js
      const themeJsPath = path.join(tempDir, 'assets', 'theme.js');
      assert.ok(fs.existsSync(themeJsPath), 'assets/theme.js must exist');
      const themeJs = fs.readFileSync(themeJsPath, 'utf-8');
      assert.ok(!themeJs.includes('.slide-content__detail'), 'Must not contain hardcoded hero selector');
      assert.ok(!themeJs.includes('Nt2J6ZXPuw0'), 'Must not contain hardcoded YouTube ID');
      assert.ok(!themeJs.includes('alert('), 'Must not contain blocking alert');
      assert.ok(themeJs.includes('data-antifan-toggle'), 'Must contain declarative toggle handler');
      assert.ok(themeJs.includes('data-antifan-modal'), 'Must contain declarative modal handler');
      assert.ok(themeJs.includes('data-antifan-slider'), 'Must contain declarative slider handler');

      // 2. Verify layout/theme.liquid has defer attribute
      const layoutPath = path.join(tempDir, 'layout', 'theme.liquid');
      const layoutContent = fs.readFileSync(layoutPath, 'utf-8');
      assert.ok(layoutContent.includes('<script src="{{ \'theme.js\' | asset_url }}" defer></script>'), 'theme.js must have defer attribute');

      // 3. Verify sections have injected data-antifan attributes
      const heroPath = path.join(tempDir, 'sections', 'hero_slider_1.liquid');
      const heroContent = fs.readFileSync(heroPath, 'utf-8');
      assert.ok(heroContent.includes('data-antifan-slider'), 'Hero slider section must have data-antifan-slider');
      assert.ok(heroContent.includes('data-antifan-slider-track'), 'Slider track must have data-antifan-slider-track');

      const modalPath = path.join(tempDir, 'sections', 'video_modal_sec.liquid');
      const modalContent = fs.readFileSync(modalPath, 'utf-8');
      assert.ok(modalContent.includes('data-antifan-modal="#video-dialog-popup"'), 'Modal button must have data-antifan-modal target');
      assert.ok(modalContent.includes('data-antifan-modal-dialog'), 'Modal dialog shell must be present with data-antifan-modal-dialog');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('6. Full End-to-End Pipeline compiles clean Haravan OS 2.0 theme with settings_schema, settings_data, templates, and runtime', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-e2e-theme-test-'));
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Cửa Hàng Thiết Bị Tự Động Hóa</title>
          <link rel="stylesheet" href="https://example.com/theme.css" />
        </head>
        <body>
          <header class="site-header">
            <nav class="main-navigation">
              <ul>
                <li><a href="/dien">Thiết bị điện</a></li>
              </ul>
            </nav>
          </header>
          <div class="hero-slider">
            <div class="slide-item">Slide 1</div>
          </div>
          <div class="catalog-grid">
            <div class="product-card">
              <a href="/products/plc-fx5u"><img src="https://example.com/plc.jpg" alt="PLC" /></a>
              <h3 class="product-title">PLC Mitsubishi FX5U</h3>
              <span class="price-current">5.400.000₫</span>
              <span class="price-old">6.000.000₫</span>
            </div>
          </div>
          <footer class="site-footer">
            <p>© 2026 Cửa Hàng Tự Động Hóa</p>
          </footer>
        </body>
      </html>
    `;

    try {
      const res = compiler.compileTheme(tempDir, sampleHtml);
      assert.strictEqual(res.success, true);
      assert.ok(res.sectionCount >= 1);

      // 1. Check layout/theme.liquid
      const layoutPath = path.join(tempDir, 'layout', 'theme.liquid');
      assert.ok(fs.existsSync(layoutPath), 'layout/theme.liquid must exist');
      const layoutContent = fs.readFileSync(layoutPath, 'utf-8');
      assert.ok(layoutContent.includes('content_for_layout'));
      assert.ok(layoutContent.includes('theme.js'));

      // 2. Check templates/index.json
      const indexJsonPath = path.join(tempDir, 'templates', 'index.json');
      assert.ok(fs.existsSync(indexJsonPath), 'templates/index.json must exist');
      const indexJson = JSON.parse(fs.readFileSync(indexJsonPath, 'utf-8'));
      assert.ok(Array.isArray(indexJson.order));

      // 3. Check config/settings_schema.json
      const schemaPath = path.join(tempDir, 'config', 'settings_schema.json');
      assert.ok(fs.existsSync(schemaPath), 'config/settings_schema.json must exist');
      const schemaObj = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      assert.ok(Array.isArray(schemaObj));

      // 4. Check config/settings_data.json
      const dataPath = path.join(tempDir, 'config', 'settings_data.json');
      assert.ok(fs.existsSync(dataPath), 'config/settings_data.json must exist');
      const dataObj = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      assert.ok(dataObj.current && dataObj.presets);

      // 5. Check assets/theme.js
      const themeJsPath = path.join(tempDir, 'assets', 'theme.js');
      assert.ok(fs.existsSync(themeJsPath), 'assets/theme.js must exist');
      const themeJsContent = fs.readFileSync(themeJsPath, 'utf-8');
      assert.ok(themeJsContent.includes('data-antifan-toggle'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
