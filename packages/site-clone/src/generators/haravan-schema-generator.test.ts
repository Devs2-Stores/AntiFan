import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  HaravanSchemaGenerator,
  sanitizeSettingType,
  sanitizeSettingId,
  normalizeHexColor,
  VALID_HARAVAN_SCHEMA_TYPES,
  type HaravanSchemaInputType,
  type HaravanThemeSettingsGroup,
  type HaravanSchemaSetting,
} from './haravan-schema-generator.js';
import type { ComponentContractIR } from '../models/clone-ir.js';

describe('HaravanSchemaGenerator - Theme Settings Schema Contract (Audit Phase 05)', () => {
  const generator = new HaravanSchemaGenerator();

  describe('1. Color Normalization', () => {
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
  });

  describe('2. Setting ID & Type Sanitization', () => {
    it('sanitizes setting IDs to identifier-safe lowercase snake_case', () => {
      assert.strictEqual(sanitizeSettingId('Hero-Title!'), 'hero_title');
      assert.strictEqual(sanitizeSettingId('123_invalid_lead'), 'setting_123_invalid_lead');
      assert.strictEqual(sanitizeSettingId(''), 'setting');
      assert.strictEqual(sanitizeSettingId('___multiple___underscores___'), 'multiple_underscores');
    });

    it('sanitizes setting types and normalizes aliases', () => {
      assert.strictEqual(sanitizeSettingType('color').type, 'color');
      assert.strictEqual(sanitizeSettingType('text').type, 'text');
      assert.strictEqual(sanitizeSettingType('dropdown').type, 'select');
      assert.strictEqual(sanitizeSettingType('choice').type, 'select');
      assert.strictEqual(sanitizeSettingType('toggle').type, 'checkbox');
      assert.strictEqual(sanitizeSettingType('font').type, 'font_picker');
      assert.strictEqual(sanitizeSettingType('font_family').type, 'font_picker');
      assert.strictEqual(sanitizeSettingType('unknown_type_xyz').type, 'text');

      // alias normalization carries the authored control constraints through
      const fontSize = sanitizeSettingType('font_size');
      assert.strictEqual(fontSize.type, 'range');
      assert.strictEqual(fontSize.transformedProps?.min, 10);
      assert.ok(
        typeof fontSize.transformedProps?.max === 'number' &&
          typeof fontSize.transformedProps?.min === 'number' &&
          fontSize.transformedProps.min < fontSize.transformedProps.max,
        'font_size range bounds must satisfy min < max'
      );
    });

    it('confirms all valid Haravan schema types', () => {
      const expectedTypes = [
        'header',
        'paragraph',
        'text',
        'textarea',
        'checkbox',
        'color',
        'image_picker',
        'select',
        'radio',
        'link_list',
        'collection',
        'blog',
        'page',
        'font_picker',
        'number',
        'range',
      ];
      for (const t of expectedTypes) {
        assert.ok(VALID_HARAVAN_SCHEMA_TYPES[t as HaravanSchemaInputType], `Type ${t} must be valid`);
      }
    });
  });

  describe('3. Theme Settings Schema Generation (config/settings_schema.json)', () => {
    it('generates valid F1GENZ settings_schema.json with theme_info header', () => {
      const jsonStr = generator.generateSettingsSchema('Haravan Store Pro', '19001234', 'support@haravan.vn');
      const parsed = JSON.parse(jsonStr) as HaravanThemeSettingsGroup[];

      assert.ok(Array.isArray(parsed), 'settings_schema must be an array of groups');
      assert.strictEqual(parsed[0].name, 'theme_info');
      assert.strictEqual(parsed[0].theme_name, 'Haravan Store Pro');

      const validation = generator.validateSettingsSchema(parsed);
      assert.strictEqual(validation.valid, true, `Validation errors: ${validation.errors.join(', ')}`);
    });

    it('generates dynamic theme settings schema from ComponentContractIR', () => {
      const mockIR: ComponentContractIR = {
        version: '1.2.0',
        metadata: { sourceUrl: 'https://test-shop.vn', extractedAt: new Date().toISOString() },
        layout: {
          containerMaxWidth: 1200,
          containerPaddingPx: 16,
          gridGapPx: 20,
          breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 },
        },
        normalizedData: {
          siteSettings: {
            title: 'Dynamic Haravan Store',
            hotline: '0987654321',
            email: 'admin@dynamicstore.vn',
          },
        },
        headStyles: [':root { --brand-color: #0088cc; --color-accent: #e60000; }'],
        themeSettings: [
          { id: 'color_primary', type: 'color', label: 'Primary', default: '#005baa' },
          { id: 'color_secondary', type: 'color', label: 'Secondary', default: '#ff6600' },
        ],
        sections: [],
        storefrontRuntime: { controllers: [] },
      };

      const jsonStr = generator.generateSettingsSchema(mockIR);
      const parsed = JSON.parse(jsonStr) as HaravanThemeSettingsGroup[];

      assert.strictEqual(parsed[0].theme_name, 'Dynamic Haravan Store');
      const contactGroup = parsed.find((g) => g.name === 'Header & Contact Information');
      assert.ok(contactGroup && contactGroup.settings);
      const hotlineSetting = contactGroup.settings.find((s) => s.id === 'hotline');
      const emailSetting = contactGroup.settings.find((s) => s.id === 'email');
      assert.strictEqual(hotlineSetting?.default, '0987654321');
      assert.strictEqual(emailSetting?.default, 'admin@dynamicstore.vn');

      const colorGroup = parsed.find((g) => g.name === 'Colors & Branding');
      assert.ok(colorGroup && colorGroup.settings);
      assert.ok(
        colorGroup.settings.some((s) => s.id === 'color_brand' && s.default === '#0088cc')
      );

      const validation = generator.validateSettingsSchema(parsed);
      assert.strictEqual(validation.valid, true, `Validation errors: ${validation.errors.join(', ')}`);
    });
  });

  describe('4. Settings Schema Validation & Invariants', () => {
    it('detects duplicate setting IDs across groups and reports error', () => {
      const groups: HaravanThemeSettingsGroup[] = [
        {
          name: 'Group 1',
          settings: [
            { type: 'text', id: 'shared_id', label: 'Field 1', default: 'A' },
          ],
        },
        {
          name: 'Group 2',
          settings: [
            { type: 'text', id: 'shared_id', label: 'Field 2', default: 'B' },
          ],
        },
      ];

      const res = generator.validateSettingsSchema(groups);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('Duplicate setting id "shared_id" detected')));
    });

    it('detects invalid setting types and reports error', () => {
      const groups: HaravanThemeSettingsGroup[] = [
        {
          name: 'General',
          settings: [
            { type: 'invalid_type_xyz' as unknown as HaravanSchemaInputType, id: 'bad_setting', label: 'Bad' },
          ],
        },
      ];

      const res = generator.validateSettingsSchema(groups);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('invalid Haravan type')));
    });

    it('detects missing required fields (name, id, label)', () => {
      const groups = [
        {
          name: '',
          settings: [
            { type: 'text', id: '', label: '' } as unknown as HaravanSchemaSetting,
          ],
        },
      ] as HaravanThemeSettingsGroup[];

      const res = generator.validateSettingsSchema(groups);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('non-empty name')));
      assert.ok(res.errors.some((e) => e.includes('non-empty "id"')));
      assert.ok(res.errors.some((e) => e.includes('non-empty "label"')));
    });

    it('rejects section presets and blocks in theme settings', () => {
      const invalidWithPresets = [
        {
          name: 'Hero Section',
          settings: [{ type: 'text', id: 'title', label: 'Title' }],
          presets: [{ name: 'Default Hero' }],
        },
      ];

      const res = generator.validateSettingsSchema(invalidWithPresets);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('Presets are not supported in Haravan flat theme settings')));
    });

    it('validates proper range bounds: min < max', () => {
      const invalidRange: HaravanThemeSettingsGroup[] = [
        {
          name: 'Layout',
          settings: [
            { type: 'range', id: 'font_size', label: 'Font Size', min: 20, max: 10, step: 1 },
          ],
        },
      ];

      const res = generator.validateSettingsSchema(invalidRange);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('min (20) must be strictly less than max (10)')));
    });

    it('preserves and safely escapes quotes in setting defaults', () => {
      const irWithQuotes: ComponentContractIR = {
        version: '1.2.0',
        metadata: { sourceUrl: 'https://test.vn', extractedAt: new Date().toISOString() },
        layout: { containerMaxWidth: 1200, containerPaddingPx: 16, gridGapPx: 20, breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 } },
        normalizedData: {
          siteSettings: {
            title: 'Store "Special" & <Best>',
          },
        },
        headStyles: [],
        themeSettings: [
          { id: 'quote_text', type: 'text', label: 'Quote', default: 'He said: "Hello, world!" & bye' },
        ],
        sections: [],
        storefrontRuntime: { controllers: [] },
      };

      const groups = generator.buildThemeSettingsGroupsFromIR(irWithQuotes);
      const textSetting = groups
        .flatMap((g) => g.settings || [])
        .find((s) => s.id === 'quote_text');

      assert.ok(textSetting);
      assert.strictEqual(textSetting.default, 'He said: "Hello, world!" & bye');

      const json = JSON.stringify(groups);
      // Valid JSON string roundtrip
      const reParsed = JSON.parse(json) as HaravanThemeSettingsGroup[];
      const reSetting = reParsed
        .flatMap((g) => g.settings || [])
        .find((s) => s.id === 'quote_text');
      assert.strictEqual(reSetting?.default, 'He said: "Hello, world!" & bye');
    });
  });
});
