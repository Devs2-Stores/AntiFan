import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SettingsAssetsNormalizer,
  type SettingGroup,
} from './settings-assets-normalizer.js';

describe('SettingsAssetsNormalizer - Haravan Theme Schema & Asset Compliance', () => {
  const normalizer = new SettingsAssetsNormalizer();

  describe('1. Type & Label Inference', () => {
    it('infers checkbox for boolean and toggle-like keys', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('add_to_cart_show', true), 'checkbox');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('addthis_iconList_show', false), 'checkbox');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('is_sticky_header', 'true'), 'checkbox');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('enable_search_modal', 'false'), 'checkbox');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('quickview_enable'), 'checkbox');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('cart_drawer_active'), 'checkbox');
    });

    it('infers color for hex, rgb, and color-related keys', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('color_primary', '#005baa'), 'color');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('shop_main_color', '#ff6600'), 'color');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('brand_bg_color', 'rgba(0,0,0,0.5)'), 'color');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('header_text_color'), 'color');
    });

    it('infers image_picker for media extensions and naming conventions', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('appbuyxgety_icon', 'icon.png'), 'image_picker');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('hero_slide_1_img', 'slide1.jpg'), 'image_picker');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('header_logo_image'), 'image_picker');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('favicon_icon'), 'image_picker');
    });

    it('infers number for counts, limits, and numeric strings', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('products_per_row', 4), 'number');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('cart_items_limit', '10'), 'number');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('logo_width_size', '200'), 'number');
    });

    it('infers textarea for code, scripts, or multiline strings', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('code_messenger_mb', ''), 'textarea');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('custom_css_code', '.btn { color: red; }'), 'textarea');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('footer_description', 'Line 1\nLine 2'), 'textarea');
    });

    it('infers text for general text strings and fallback keys', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('cart_deliverytime_start', '08:00'), 'text');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('cart_deliverytime_end', '18:00'), 'text');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingType('hotline_number', '1900-1234'), 'text');
    });

    it('generates clean title-case labels from snake_case and camelCase keys', () => {
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingLabel('add_to_cart_show'), 'Add To Cart Show');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingLabel('cart_deliverytime_start'), 'Cart Deliverytime Start');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingLabel('shop_main_color'), 'Shop Main Color');
      assert.strictEqual(SettingsAssetsNormalizer.inferSettingLabel('code_messenger_mb'), 'Code Messenger Mb');
    });
  });

  describe('2. Schema Normalization & Group Placement', () => {
    it('normalizes undeclared keys without corrupting theme_info or existing groups', () => {
      const initialSchema: SettingGroup[] = [
        {
          name: 'theme_info',
          theme_name: 'Haravan Storefront',
          theme_version: '1.0.0',
        },
        {
          name: 'Colors & Branding',
          settings: [
            {
              type: 'color',
              id: 'color_primary',
              label: 'Primary Color',
              default: '#005baa',
            },
          ],
        },
      ];

      const settingsData = {
        color_primary: '#005baa', // Already declared, should be skipped
        shop_main_color: '#ff6600', // Missing color, should go to Colors & Branding
        add_to_cart_show: true, // Missing boolean, should go to Cart & Checkout
        cart_deliverytime_start: '08:00', // Missing text, should go to Cart & Checkout
        appbuyxgety_icon: 'buyx.png', // Missing image, should go to Products & Catalog
        code_messenger_mb: '<script></script>', // Missing textarea, should go to Social & Integrations
      };

      const result = normalizer.normalizeSettingsSchema(settingsData, initialSchema);

      assert.strictEqual(result.addedSettingsCount, 5);
      assert.deepStrictEqual(result.fixedKeys.sort(), [
        'add_to_cart_show',
        'appbuyxgety_icon',
        'cart_deliverytime_start',
        'code_messenger_mb',
        'shop_main_color',
      ]);

      // Verify theme_info is intact with no settings
      assert.strictEqual(result.normalizedSchema[0].name, 'theme_info');
      assert.strictEqual(result.normalizedSchema[0].settings, undefined);

      // Verify shop_main_color joined Colors & Branding
      const colorGroup = result.normalizedSchema.find((g) => g.name === 'Colors & Branding');
      assert.ok(colorGroup, 'Colors & Branding group must exist');
      const shopColorSetting = colorGroup?.settings?.find((s) => s.id === 'shop_main_color');
      assert.ok(shopColorSetting, 'shop_main_color must be in Colors & Branding');
      assert.strictEqual(shopColorSetting?.type, 'color');
      assert.strictEqual(shopColorSetting?.default, '#ff6600');

      // Verify Cart & Checkout group was created
      const cartGroup = result.normalizedSchema.find((g) => g.name === 'Cart & Checkout');
      assert.ok(cartGroup, 'Cart & Checkout group must be created');
      const addToCartSetting = cartGroup?.settings?.find((s) => s.id === 'add_to_cart_show');
      assert.ok(addToCartSetting, 'add_to_cart_show must be in Cart group');
      assert.strictEqual(addToCartSetting?.type, 'checkbox');
      assert.strictEqual(addToCartSetting?.default, true);

      // Verify idempotency
      const rerunResult = normalizer.normalizeSettingsSchema(settingsData, result.normalizedSchema);
      assert.strictEqual(rerunResult.addedSettingsCount, 0);
      assert.strictEqual(rerunResult.fixedKeys.length, 0);
    });

    it('resolves batch of 95 undeclared settings conforming to Haravan audit scenario', () => {
      const initialSchema: SettingGroup[] = [
        { name: 'theme_info', theme_name: 'Phukienmaymoc Theme' },
      ];

      // Build 95 undeclared keys reflecting real Haravan audit findings
      const mock95Data: Record<string, unknown> = {};
      for (let i = 1; i <= 30; i++) {
        mock95Data[`feature_toggle_${i}_show`] = i % 2 === 0;
      }
      for (let i = 1; i <= 20; i++) {
        mock95Data[`custom_accent_color_${i}`] = `#00${i.toString(16).padStart(2, '0')}ff`;
      }
      for (let i = 1; i <= 15; i++) {
        mock95Data[`banner_slide_${i}_img`] = `slide_${i}.jpg`;
      }
      for (let i = 1; i <= 15; i++) {
        mock95Data[`cart_delivery_rule_${i}`] = `rule_${i}`;
      }
      for (let i = 1; i <= 15; i++) {
        mock95Data[`integration_script_${i}_code`] = `<!-- code ${i} -->`;
      }

      assert.strictEqual(Object.keys(mock95Data).length, 95);

      const result = normalizer.normalizeSettingsSchema(mock95Data, initialSchema);

      assert.strictEqual(result.addedSettingsCount, 95);
      assert.strictEqual(result.fixedKeys.length, 95);

      const declaredIds = SettingsAssetsNormalizer.collectDeclaredSettingIds(result.normalizedSchema);
      assert.strictEqual(declaredIds.size, 95);

      for (const key of Object.keys(mock95Data)) {
        assert.ok(declaredIds.has(key), `Key ${key} must be declared in schema`);
      }
    });

    it('extracts settings from Haravan settings_data.json with current and presets structure', () => {
      const settingsData = {
        current: {
          color_primary: '#171717',
          add_to_cart_show: true,
        },
        presets: {
          Default: {
            color_primary: '#171717',
            header_sticky_enable: true,
          },
        },
      };

      const extracted = SettingsAssetsNormalizer.extractSettingsEntries(settingsData);
      assert.strictEqual(extracted.color_primary, '#171717');
      assert.strictEqual(extracted.add_to_cart_show, true);
      assert.strictEqual(extracted.header_sticky_enable, true);

      const result = normalizer.normalizeSettingsSchema(settingsData, []);
      assert.strictEqual(result.addedSettingsCount, 3);
      assert.ok(result.fixedKeys.includes('header_sticky_enable'));
    });
  });

  describe('3. Asset Auditing & Synthesis', () => {
    it('synthesizes missing assets including 6 audit jpgs, svgs, css, and js with valid formats', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-asset-test-'));

      try {
        // The 6 missing assets from the audit report + supplementary assets
        const declaredAssets = [
          'blogs_banner_paralax.jpg',
          'home_coll_1_banner.jpg',
          'home_collection_banner.jpg',
          'loomline_index_form_img.jpg',
          'slide_1_img.jpg',
          'slide_1_img_mb.jpg',
          'icon-cart.svg',
          'vendor.js',
          'theme-styles.css',
        ];

        const result = await normalizer.auditAndSynthesizeAssets(tempDir, declaredAssets);

        assert.strictEqual(result.missingCount, 9);
        assert.strictEqual(result.synthesizedAssets.length, 9);

        // Verify synthesized files exist in assets/
        const assetsDir = path.join(tempDir, 'assets');
        assert.ok(fs.existsSync(assetsDir), 'assets directory must exist');

        // Check JPEG format validity (JFIF marker 0xff, 0xd8 and EOI 0xff, 0xd9)
        const blogJpgPath = path.join(assetsDir, 'blogs_banner_paralax.jpg');
        assert.ok(fs.existsSync(blogJpgPath), 'blogs_banner_paralax.jpg must exist');
        const jpgBuffer = fs.readFileSync(blogJpgPath);
        assert.strictEqual(jpgBuffer[0], 0xff);
        assert.strictEqual(jpgBuffer[1], 0xd8);
        assert.strictEqual(jpgBuffer[jpgBuffer.length - 2], 0xff);
        assert.strictEqual(jpgBuffer[jpgBuffer.length - 1], 0xd9);

        // Check SVG validity
        const svgPath = path.join(assetsDir, 'icon-cart.svg');
        assert.ok(fs.existsSync(svgPath), 'icon-cart.svg must exist');
        const svgText = fs.readFileSync(svgPath, 'utf-8');
        assert.ok(svgText.includes('<svg'), 'SVG must contain <svg tag');

        // Check JS validity
        const jsPath = path.join(assetsDir, 'vendor.js');
        assert.ok(fs.existsSync(jsPath), 'vendor.js must exist');
        const jsText = fs.readFileSync(jsPath, 'utf-8');
        assert.ok(jsText.includes('Synthesized asset'), 'JS must have header');

        // Check CSS validity
        const cssPath = path.join(assetsDir, 'theme-styles.css');
        assert.ok(fs.existsSync(cssPath), 'theme-styles.css must exist');

        // Re-run: should detect 0 missing assets
        const rerunResult = await normalizer.auditAndSynthesizeAssets(tempDir, declaredAssets);
        assert.strictEqual(rerunResult.missingCount, 0);
        assert.strictEqual(rerunResult.synthesizedAssets.length, 0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('recognizes compiled Liquid asset aliases (.liquid) and does not re-synthesize', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-liquid-asset-test-'));

      try {
        const assetsDir = path.join(tempDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });

        // Pre-create a .liquid asset
        fs.writeFileSync(path.join(assetsDir, 'color_font.scss.liquid'), '/* liquid scss */');

        // Check for 'color_font.scss.css' which is satisfied by 'color_font.scss.liquid'
        const result = await normalizer.auditAndSynthesizeAssets(tempDir, ['color_font.scss.css']);
        assert.strictEqual(result.missingCount, 0);
        assert.strictEqual(result.synthesizedAssets.length, 0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('4. Full Theme Directory Normalization', () => {
    it('scans theme templates and normalizes schema and assets end-to-end', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-full-theme-test-'));

      try {
        // Create theme folder structure
        const configDir = path.join(tempDir, 'config');
        const layoutDir = path.join(tempDir, 'layout');
        const snippetsDir = path.join(tempDir, 'snippets');
        fs.mkdirSync(configDir, { recursive: true });
        fs.mkdirSync(layoutDir, { recursive: true });
        fs.mkdirSync(snippetsDir, { recursive: true });

        // Create layout/theme.liquid reading undeclared settings and referencing assets
        fs.writeFileSync(
          path.join(layoutDir, 'theme.liquid'),
          `<!DOCTYPE html>
           <html>
           <head>
             <link rel="stylesheet" href="{{ 'global.css' | asset_url }}">
           </head>
           <body>
             {% if settings.addthis_iconList_show %}
               <div class="addthis">Share</div>
             {% endif %}
             {{ content_for_layout }}
           </body>
           </html>`
        );

        // Create snippets/product-card.liquid
        fs.writeFileSync(
          path.join(snippetsDir, 'product-card.liquid'),
          `<div class="card">
             {% if settings.add_to_cart_show %}
               <button>Buy</button>
             {% endif %}
             <img src="{{ 'badge-sale.png' | file_url }}">
           </div>`
        );

        // Initial config
        fs.writeFileSync(
          path.join(configDir, 'settings_schema.json'),
          JSON.stringify([{ name: 'theme_info', theme_name: 'EndToEnd' }], null, 2)
        );
        fs.writeFileSync(
          path.join(configDir, 'settings_data.json'),
          JSON.stringify({ current: { cart_deliverytime_start: '08:00' } }, null, 2)
        );

        // Execute normalizeTheme
        const result = await normalizer.normalizeTheme(tempDir);

        // Verify schema result
        assert.ok(result.schemaResult.addedSettingsCount >= 3);
        assert.ok(result.schemaResult.fixedKeys.includes('addthis_iconList_show'));
        assert.ok(result.schemaResult.fixedKeys.includes('add_to_cart_show'));
        assert.ok(result.schemaResult.fixedKeys.includes('cart_deliverytime_start'));

        // Verify updated schema file written to disk
        const savedSchema = JSON.parse(
          fs.readFileSync(path.join(configDir, 'settings_schema.json'), 'utf-8')
        );
        const declaredIds = SettingsAssetsNormalizer.collectDeclaredSettingIds(savedSchema);
        assert.ok(declaredIds.has('addthis_iconList_show'));
        assert.ok(declaredIds.has('add_to_cart_show'));
        assert.ok(declaredIds.has('cart_deliverytime_start'));

        // Verify asset synthesis on disk
        assert.ok(result.assetResult.missingCount >= 2);
        assert.ok(fs.existsSync(path.join(tempDir, 'assets', 'global.css')));
        assert.ok(fs.existsSync(path.join(tempDir, 'assets', 'badge-sale.png')));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
