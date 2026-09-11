import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  HaravanSchemaGenerator,
  sanitizeSettingType,
  sanitizeSettingId,
  normalizeHexColor,
  VALID_HARAVAN_SCHEMA_TYPES,
  type HaravanSchemaInputType,
  type HaravanSectionSchema,
  type SectionExtractionContext
} from './haravan-schema-generator.js';
import type { ComponentContractIR, ComponentSectionContract } from '../models/clone-ir.js';

describe('HaravanSchemaGenerator - Dynamic Extraction & OS 2.0 Compliance (Audit §20)', () => {
  const generator = new HaravanSchemaGenerator();

  describe('1. Dynamic Color Extraction', () => {
    it('normalizes hex, rgb, rgba, and named colors accurately', () => {
      assert.strictEqual(normalizeHexColor('#fff'), '#ffffff');
      assert.strictEqual(normalizeHexColor('#005baa'), '#005baa');
      assert.strictEqual(normalizeHexColor('#ff660088'), '#ff6600');
      assert.strictEqual(normalizeHexColor('rgb(0, 91, 170)'), '#005baa');
      assert.strictEqual(normalizeHexColor('rgba(255, 102, 0, 0.9)'), '#ff6600');
      assert.strictEqual(normalizeHexColor('rgba(0, 0, 0, 0)'), null); // transparent ignored
      assert.strictEqual(normalizeHexColor('white'), '#ffffff');
      assert.strictEqual(normalizeHexColor('black'), '#000000');
      assert.strictEqual(normalizeHexColor('invalid'), null);
    });

    it('extracts color settings from CSS variables, cssRules, and computedStyles', () => {
      const context: SectionExtractionContext = {
        name: 'Feature Showcase',
        archetype: 'custom_section',
        cssRules: {
          '--primary-color': '#005baa',
          '--accent-color': 'rgb(255, 102, 0)',
          'background-color': '#f8f9fa',
          'color': 'rgb(34, 52, 62)'
        },
        rawHtml: `
          <section class="feature-showcase" style="--border-color: #e0e0e0;">
            <h2 class="title">Đặc Điểm Nổi Bật</h2>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(context);
      const colorSettings = schema.settings.filter((s) => s.type === 'color');

      assert.ok(colorSettings.length >= 3, 'Should discover multiple color settings');

      const primary = colorSettings.find((s) => s.id === 'color_primary');
      assert.ok(primary, 'color_primary must be extracted');
      assert.strictEqual(primary.default, '#005baa');

      const bg = colorSettings.find((s) => s.id === 'color_bg');
      assert.ok(bg, 'color_bg must be extracted');
      assert.strictEqual(bg.default, '#f8f9fa');

      const text = colorSettings.find((s) => s.id === 'color_text');
      assert.ok(text, 'color_text must be extracted');
      assert.strictEqual(text.default, '#22343e');

      const validation = generator.validateSectionSchema(schema);
      assert.strictEqual(validation.valid, true, `Schema must be valid: ${validation.errors.join(', ')}`);
    });
  });

  describe('2. Dynamic Image Extraction', () => {
    it('detects logo in header sections and generates image_picker with id logo', () => {
      const headerContext: SectionExtractionContext = {
        name: 'Site Header',
        archetype: 'header',
        isStatic: true,
        rawHtml: `
          <header class="site-header">
            <div class="logo">
              <img src="/cdn/logo.png" alt="Company Logo" class="brand-logo">
            </div>
          </header>
        `
      };

      const schema = generator.extractSectionSchema(headerContext);
      const logoSetting = schema.settings.find((s) => s.id === 'logo');

      assert.ok(logoSetting, 'Logo image setting must exist');
      assert.strictEqual(logoSetting.type, 'image_picker');
      assert.strictEqual(schema.presets, undefined, 'Static header must not have presets');
    });

    it('detects banner image and CSS background-image', () => {
      const bannerContext: SectionExtractionContext = {
        name: 'Hero Banner',
        archetype: 'hero_slider',
        cssRules: {
          'background-image': 'url(/cdn/bg-pattern.jpg)'
        },
        rawHtml: `
          <section class="hero-banner">
            <img src="/cdn/hero-main.jpg" alt="Summer Promo" class="hero-image">
          </section>
        `
      };

      const schema = generator.extractSectionSchema(bannerContext);
      const bgSetting = schema.settings.find((s) => s.id === 'background_image');
      const bannerSetting = schema.settings.find((s) => s.id === 'banner_image');

      assert.ok(bgSetting, 'Background image must be detected from cssRules');
      assert.strictEqual(bgSetting.type, 'image_picker');

      assert.ok(bannerSetting, 'Banner image must be detected from img tag');
      assert.strictEqual(bannerSetting.type, 'image_picker');
    });
  });

  describe('3. Dynamic Text, Headings & CTA Extraction', () => {
    it('extracts heading, subheading, rich text description, and CTA button', () => {
      const context: SectionExtractionContext = {
        name: 'About Section',
        archetype: 'rich_text',
        rawHtml: `
          <section class="about-us">
            <h2 class="title">Về Chúng Tôi</h2>
            <h4 class="subtitle">Chất lượng hàng đầu từ 2015</h4>
            <div class="description">
              <p>Chúng tôi cung cấp các sản phẩm <strong>chính hãng</strong> với cam kết tốt nhất thị trường.</p>
            </div>
            <a href="/pages/about" class="btn btn-primary">Tìm Hiểu Thêm</a>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(context);

      const heading = schema.settings.find((s) => s.id === 'heading');
      assert.ok(heading, 'Heading setting must be extracted');
      assert.strictEqual(heading.type, 'text');
      assert.strictEqual(heading.default, 'Về Chúng Tôi');

      const subheading = schema.settings.find((s) => s.id === 'subheading');
      assert.ok(subheading, 'Subheading setting must be extracted');
      assert.strictEqual(subheading.type, 'text');
      assert.strictEqual(subheading.default, 'Chất lượng hàng đầu từ 2015');

      const content = schema.settings.find((s) => s.id === 'content' || s.id === 'description');
      assert.ok(content, 'Rich text content setting must be extracted');
      assert.strictEqual(content.type, 'richtext');
      assert.ok(String(content.default).includes('strong'), 'Rich text default must preserve HTML formatting');

      const btnLabel = schema.settings.find((s) => s.id === 'button_label');
      assert.ok(btnLabel, 'Button label setting must be extracted');
      assert.strictEqual(btnLabel.type, 'text');
      assert.strictEqual(btnLabel.default, 'Tìm Hiểu Thêm');

      const btnLink = schema.settings.find((s) => s.id === 'button_link');
      assert.ok(btnLink, 'Button link setting must be extracted');
      assert.strictEqual(btnLink.type, 'url');
      assert.strictEqual(btnLink.default, '/pages/about');
    });

    it('extracts plain multi-line paragraphs as textarea', () => {
      const longText = 'Đây là đoạn mô tả chi tiết của cửa hàng chúng tôi với rất nhiều thông tin cần thể hiện đầy đủ không chứa mã HTML.';
      const context: SectionExtractionContext = {
        name: 'Simple Intro',
        archetype: 'rich_text',
        rawHtml: `
          <section class="intro">
            <h2>Giới Thiệu</h2>
            <p class="description">${longText}</p>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(context);
      const desc = schema.settings.find((s) => s.id === 'description');
      assert.ok(desc, 'Description setting must exist');
      assert.strictEqual(desc.type, 'textarea');
      assert.strictEqual(desc.default, longText);
    });
  });

  describe('4. Dynamic Toggle (Checkbox) Extraction', () => {
    it('infers carousel toggles: autoplay, show_arrows, and show_dots', () => {
      const carouselContext: SectionExtractionContext = {
        name: 'Brand Carousel',
        archetype: 'hero_slider',
        className: 'brand-carousel slider',
        rawHtml: `
          <section class="brand-carousel" data-antifan-slider>
            <div class="swiper-button-prev"></div>
            <div class="swiper-button-next"></div>
            <div class="swiper-pagination"></div>
            <div class="item">Brand 1</div>
            <div class="item">Brand 2</div>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(carouselContext);

      const autoplay = schema.settings.find((s) => s.id === 'autoplay');
      assert.ok(autoplay, 'autoplay checkbox must be extracted');
      assert.strictEqual(autoplay.type, 'checkbox');
      assert.strictEqual(autoplay.default, true);

      const arrows = schema.settings.find((s) => s.id === 'show_arrows');
      assert.ok(arrows, 'show_arrows checkbox must be extracted');
      assert.strictEqual(arrows.type, 'checkbox');
      assert.strictEqual(arrows.default, true);

      const dots = schema.settings.find((s) => s.id === 'show_dots');
      assert.ok(dots, 'show_dots checkbox must be extracted');
      assert.strictEqual(dots.type, 'checkbox');
      assert.strictEqual(dots.default, true);
    });

    it('detects full_width and view_all toggles', () => {
      const context: SectionExtractionContext = {
        name: 'Wide Section',
        className: 'wide-section container-fluid',
        rawHtml: `
          <section class="wide-section container-fluid">
            <h2>Sản Phẩm Mới</h2>
            <a href="/all" class="view-all">Xem tất cả</a>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(context);

      const fullWidth = schema.settings.find((s) => s.id === 'full_width');
      assert.ok(fullWidth, 'full_width toggle must exist');
      assert.strictEqual(fullWidth.type, 'checkbox');
      assert.strictEqual(fullWidth.default, true);

      const viewAll = schema.settings.find((s) => s.id === 'show_view_all');
      assert.ok(viewAll, 'show_view_all toggle must exist');
      assert.strictEqual(viewAll.type, 'checkbox');
      assert.strictEqual(viewAll.default, true);
    });
  });

  describe('5. Dynamic Sliders & Collection Extraction', () => {
    it('infers collection picker and range settings for product grid', () => {
      const productContext: SectionExtractionContext = {
        name: 'Featured Products',
        archetype: 'product_grid',
        className: 'product-grid',
        rawHtml: `
          <section class="product-grid">
            <h2>Sản Phẩm Nổi Bật</h2>
            <div class="products">
              <div class="product-item">P1</div>
              <div class="product-item">P2</div>
              <div class="product-item">P3</div>
              <div class="product-item">P4</div>
              <div class="product-item">P5</div>
              <div class="product-item">P6</div>
            </div>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(productContext);

      const collection = schema.settings.find((s) => s.id === 'collection');
      assert.ok(collection, 'collection picker setting must exist');
      assert.strictEqual(collection.type, 'collection');

      const productsToShow = schema.settings.find((s) => s.id === 'products_to_show');
      assert.ok(productsToShow, 'products_to_show range must exist');
      assert.strictEqual(productsToShow.type, 'range');
      assert.strictEqual(productsToShow.min, 2);
      assert.strictEqual(productsToShow.max, 24);
      assert.strictEqual(productsToShow.default, 6, 'Default products_to_show should match inspected count (6)');

      const colsDesktop = schema.settings.find((s) => s.id === 'columns_desktop');
      assert.ok(colsDesktop, 'columns_desktop range must exist');
      assert.strictEqual(colsDesktop.type, 'range');
      assert.strictEqual(colsDesktop.min, 2);
      assert.strictEqual(colsDesktop.max, 6);

      const colsMobile = schema.settings.find((s) => s.id === 'columns_mobile');
      assert.ok(colsMobile, 'columns_mobile range must exist');
      assert.strictEqual(colsMobile.type, 'range');
      assert.strictEqual(colsMobile.default, 2);
    });

    it('infers slider_speed range for carousels with autoplay duration', () => {
      const sliderContext: SectionExtractionContext = {
        name: 'Homepage Hero',
        archetype: 'hero_slider',
        rawHtml: `
          <section class="hero-slider" data-antifan-slider data-antifan-autoplay="4000">
            <div class="swiper-slide"><img src="s1.jpg"></div>
            <div class="swiper-slide"><img src="s2.jpg"></div>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(sliderContext);
      const speed = schema.settings.find((s) => s.id === 'slider_speed');

      assert.ok(speed, 'slider_speed range setting must exist');
      assert.strictEqual(speed.type, 'range');
      assert.strictEqual(speed.unit, 's');
      assert.strictEqual(speed.default, 4, 'Speed should parse 4000ms into 4s');
    });
  });

  describe('6. Dynamic Block & Preset Generation', () => {
    it('extracts slide items into block definitions and builds preset instances matching inspected DOM', () => {
      const sliderContext: SectionExtractionContext = {
        name: 'Main Slider',
        archetype: 'hero_slider',
        rawHtml: `
          <section class="main-slider">
            <div class="swiper-slide">
              <a href="/promo-1"><img src="/banners/slide1.jpg" alt="Khuyến Mãi Tháng 9"></a>
            </div>
            <div class="swiper-slide">
              <a href="/promo-2"><img src="/banners/slide2.jpg" alt="Bộ Sưu Tập Mới"></a>
            </div>
            <div class="swiper-slide">
              <a href="/promo-3"><img src="/banners/slide3.jpg" alt="Xả Hàng Giá Sốc"></a>
            </div>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(sliderContext);

      assert.ok(schema.blocks && schema.blocks.length > 0, 'Schema must define blocks');
      const slideBlock = schema.blocks.find((b) => b.type === 'slide_item');
      assert.ok(slideBlock, 'slide_item block must be defined');
      assert.ok(slideBlock.settings.some((s) => s.id === 'image' && s.type === 'image_picker'));
      assert.ok(slideBlock.settings.some((s) => s.id === 'title' && s.type === 'text'));
      assert.ok(slideBlock.settings.some((s) => s.id === 'link' && s.type === 'url'));

      // Check presets
      assert.ok(schema.presets && schema.presets.length > 0, 'Presets must be generated');
      const preset = schema.presets[0];
      assert.strictEqual(preset.name, 'Main Slider');
      assert.strictEqual(preset.category, 'Banners & Sliders');
      assert.ok(preset.blocks, 'Preset must contain default blocks');
      assert.strictEqual(preset.blocks.length, 3, 'Preset must contain 3 block instances matching inspected DOM');
      assert.strictEqual(preset.blocks[0].settings?.title, 'Khuyến Mãi Tháng 9');
      assert.strictEqual(preset.blocks[0].settings?.link, '/promo-1');
      assert.strictEqual(preset.blocks[1].settings?.title, 'Bộ Sưu Tập Mới');
    });

    it('extracts category items into category_item block definitions and presets', () => {
      const catContext: SectionExtractionContext = {
        name: 'Danh Mục Sản Phẩm',
        archetype: 'collection_list',
        className: 'category-grid',
        rawHtml: `
          <section class="category-grid">
            <div class="item">
              <a href="/collections/ao-thun">
                <img src="/icons/shirt.png" alt="Áo Thun">
                <span>Áo Thun Nam</span>
              </a>
            </div>
            <div class="item">
              <a href="/collections/quan-jean">
                <img src="/icons/jeans.png" alt="Quần Jean">
                <span>Quần Jean Nam</span>
              </a>
            </div>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(catContext);
      assert.ok(schema.blocks, 'Category blocks must exist');
      const catBlock = schema.blocks.find((b) => b.type === 'category_item');
      assert.ok(catBlock, 'category_item block must be defined');

      assert.ok(schema.presets && schema.presets[0].blocks, 'Presets must have blocks');
      assert.strictEqual(schema.presets[0].blocks.length, 2);
      assert.strictEqual(schema.presets[0].blocks[0].settings?.title, 'Áo Thun Nam');
      assert.strictEqual(schema.presets[0].blocks[0].settings?.link, '/collections/ao-thun');
    });

    it('omits presets for static sections like Header and Footer', () => {
      const footerContext: SectionExtractionContext = {
        name: 'Site Footer',
        archetype: 'footer',
        isStatic: true,
        rawHtml: `<footer class="site-footer"><p>Copyright 2026</p></footer>`
      };

      const schema = generator.extractSectionSchema(footerContext);
      assert.strictEqual(schema.presets, undefined, 'Footer section schema must not have presets');
    });
  });

  describe('7. Haravan OS 2.0 Compatibility & Legacy Type Avoidance', () => {
    it('sanitizes legacy types (font-size, font_style, dropdown, choice, file) to valid OS 2.0 types', () => {
      const s1 = sanitizeSettingType('font-size');
      assert.strictEqual(s1.type, 'range');
      assert.strictEqual(s1.transformedProps?.unit, 'px');

      const s2 = sanitizeSettingType('font_style');
      assert.strictEqual(s2.type, 'select');
      assert.ok(Array.isArray(s2.transformedProps?.options));

      const s3 = sanitizeSettingType('dropdown');
      assert.strictEqual(s3.type, 'select');

      const s4 = sanitizeSettingType('file');
      assert.strictEqual(s4.type, 'image_picker');

      const s5 = sanitizeSettingType('font_family');
      assert.strictEqual(s5.type, 'font_picker');
    });

    it('sanitizes setting IDs to lowercase alphanumeric and underscore', () => {
      assert.strictEqual(sanitizeSettingId('Hero-Title!'), 'hero_title');
      assert.strictEqual(sanitizeSettingId('__color--primary__'), 'color_primary');
      assert.strictEqual(sanitizeSettingId('123number'), 'setting_123number');
    });

    it('automatically remedies legacy types present in raw schemaSettings input', () => {
      const context: SectionExtractionContext = {
        name: 'Legacy Configured Section',
        archetype: 'custom_section',
        schemaSettings: [
          { type: 'font-size', id: 'title_size', label: 'Title Size' },
          { type: 'dropdown', id: 'layout_mode', label: 'Layout Mode' },
          { type: 'file', id: 'badge_icon', label: 'Badge Icon' }
        ]
      };

      const schema = generator.extractSectionSchema(context);

      const titleSize = schema.settings.find((s) => s.id === 'title_size');
      assert.ok(titleSize);
      assert.strictEqual(titleSize.type, 'range', 'font-size must become range');

      const layoutMode = schema.settings.find((s) => s.id === 'layout_mode');
      assert.ok(layoutMode);
      assert.strictEqual(layoutMode.type, 'select', 'dropdown must become select');

      const badgeIcon = schema.settings.find((s) => s.id === 'badge_icon');
      assert.ok(badgeIcon);
      assert.strictEqual(badgeIcon.type, 'image_picker', 'file must become image_picker');

      // Check validation
      for (const s of schema.settings) {
        assert.ok(VALID_HARAVAN_SCHEMA_TYPES[s.type], `Type ${s.type} must be in VALID_HARAVAN_SCHEMA_TYPES`);
      }
    });

    it('detects invalid schemas and reports meaningful errors', () => {
      const invalidSchema: HaravanSectionSchema = {
        name: '',
        settings: [
          { type: 'invalid_type' as unknown as HaravanSchemaInputType, id: 'test_1', label: 'Test 1' },
          { type: 'text', id: 'duplicate_id', label: 'Dup 1' },
          { type: 'text', id: 'duplicate_id', label: 'Dup 2' },
          { type: 'header', id: 'illegal_header_id', content: 'Header' },
          { type: 'range', id: 'bad_range', label: 'Bad Range', min: 10, max: 5, step: 1 }
        ]
      };

      const result = generator.validateSectionSchema(invalidSchema);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('non-empty name')));
      assert.ok(result.errors.some((e) => e.includes('invalid Haravan type')));
      assert.ok(result.errors.some((e) => e.includes('must not contain an id attribute')));
      assert.ok(result.errors.some((e) => e.includes('Duplicate setting id detected')));
      assert.ok(result.errors.some((e) => e.includes('min (10) must be strictly less than max (5)')));
    });
  });

  describe('8. Theme Settings Schema (config/settings_schema.json)', () => {
    it('generates valid backward-compatible settings_schema.json', () => {
      const jsonStr = generator.generateSettingsSchema('Test Theme Pro', '19001234', 'support@theme.vn');
      const parsed = JSON.parse(jsonStr);

      assert.ok(Array.isArray(parsed), 'settings_schema must be an array of groups');
      assert.strictEqual(parsed[0].name, 'theme_info');
      assert.strictEqual(parsed[0].theme_name, 'Test Theme Pro');

      const validation = generator.validateThemeSettingsSchema(parsed);
      assert.strictEqual(validation.valid, true, `Validation errors: ${validation.errors.join(', ')}`);
    });

    it('generates dynamic theme settings schema from ComponentContractIR', () => {
      const mockIR: ComponentContractIR = {
        version: '1.2.0',
        metadata: { sourceUrl: 'https://test-shop.vn', extractedAt: new Date().toISOString() },
        layout: { containerMaxWidth: 1200, containerPaddingPx: 16, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
        normalizedData: {
          siteSettings: {
            title: 'Dynamic Store Pro',
            hotline: '0987654321',
            email: 'admin@dynamicstore.vn'
          }
        },
        headStyles: [
          ':root { --brand-color: #0088cc; --color-accent: #e60000; }'
        ],
        themeSettings: [
          { id: 'color_primary', type: 'color', label: 'Primary', default: '#005baa' },
          { id: 'color_secondary', type: 'color', label: 'Secondary', default: '#ff6600' }
        ],
        sections: [],
        storefrontRuntime: { controllers: [] }
      };

      const jsonStr = generator.generateSettingsSchema(mockIR);
      const parsed = JSON.parse(jsonStr);

      assert.strictEqual(parsed[0].theme_name, 'Dynamic Store Pro');
      const contactGroup = parsed.find((g: { name: string }) => g.name === 'Header & Contact Information');
      assert.ok(contactGroup && contactGroup.settings);
      const hotlineSetting = contactGroup.settings.find((s: { id: string }) => s.id === 'hotline');
      const emailSetting = contactGroup.settings.find((s: { id: string }) => s.id === 'email');
      assert.strictEqual(hotlineSetting?.default, '0987654321');
      assert.strictEqual(emailSetting?.default, 'admin@dynamicstore.vn');

      const colorGroup = parsed.find((g: { name: string }) => g.name === 'Colors & Branding');
      assert.ok(colorGroup && colorGroup.settings);
      assert.ok(colorGroup.settings.some((s: { id: string; default?: unknown }) => s.id === 'color_brand' && s.default === '#0088cc'));

      const validation = generator.validateThemeSettingsSchema(parsed);
      assert.strictEqual(validation.valid, true);
    });
  });

  describe('9. Full Liquid Template Wrapping with {% schema %}', () => {
    it('wraps Liquid code with valid parseable {% schema %} block', () => {
      const context: SectionExtractionContext = {
        name: 'Call To Action',
        archetype: 'custom_section',
        rawHtml: `
          <section class="cta-banner">
            <h2>Đăng Ký Ngay</h2>
            <a href="/register" class="btn">Tham Gia</a>
          </section>
        `
      };

      const schema = generator.extractSectionSchema(context);
      const liquidOutput = generator.generateSectionLiquidWithSchema(
        '<section class="cta-banner">\n  <h2>{{ section.settings.heading }}</h2>\n</section>',
        schema
      );

      assert.ok(liquidOutput.includes('{% schema %}'), 'Output must contain {% schema %}');
      assert.ok(liquidOutput.includes('{% endschema %}'), 'Output must contain {% endschema %}');

      const schemaMatch = liquidOutput.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
      assert.ok(schemaMatch, 'Schema tag must match regex');

      const parsedSchema = JSON.parse(schemaMatch[1].trim());
      assert.strictEqual(parsedSchema.name, 'Call To Action');
      assert.strictEqual(parsedSchema.presets[0].name, 'Call To Action');
    });
  });
});
