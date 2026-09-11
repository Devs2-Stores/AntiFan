/**
 * Generator: Haravan Schema Generator
 * Dynamic extraction of Haravan OS 2.0 section schemas and theme settings schema.
 * Implements Audit §20 & P0.5: Dynamic Binding & Semantic Schema Compilation.
 */

import { DomTreeParser, ParsedElementNode } from '../models/dom-tree-parser.js';
import type {
  ComponentContractIR,
  ComponentSectionContract,
  ComponentBlockContract,
  ThemeSettingContract
} from '../models/clone-ir.js';
import type { ExtractedSectionBlueprint, BlockDefinition } from '../models/blueprint-extractor.js';

/**
 * All valid Haravan OS 2.0 schema input types.
 * Strictly whitelisted to avoid legacy validator errors.
 */
export type HaravanSchemaInputType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'checkbox'
  | 'number'
  | 'radio'
  | 'range'
  | 'select'
  | 'color'
  | 'font_picker'
  | 'collection'
  | 'product'
  | 'blog'
  | 'page'
  | 'link_list'
  | 'url'
  | 'video_url'
  | 'image_picker'
  | 'html'
  | 'header'
  | 'paragraph';

export const VALID_HARAVAN_SCHEMA_TYPES: Record<HaravanSchemaInputType, true> = {
  text: true,
  textarea: true,
  richtext: true,
  checkbox: true,
  number: true,
  radio: true,
  range: true,
  select: true,
  color: true,
  font_picker: true,
  collection: true,
  product: true,
  blog: true,
  page: true,
  link_list: true,
  url: true,
  video_url: true,
  image_picker: true,
  html: true,
  header: true,
  paragraph: true
};

export interface HaravanSelectOption {
  value: string;
  label: string;
}

export interface HaravanSchemaSetting {
  type: HaravanSchemaInputType;
  id?: string;
  label?: string;
  content?: string; // used for header/paragraph
  default?: string | number | boolean | Record<string, unknown>;
  info?: string;
  min?: number; // for range
  max?: number; // for range
  step?: number; // for range
  unit?: string; // for range (e.g. 'px', 's', '%')
  options?: HaravanSelectOption[]; // for select/radio
  placeholder?: string;
}

export interface HaravanBlockDefinition {
  type: string;
  name: string;
  limit?: number;
  settings: HaravanSchemaSetting[];
}

export interface HaravanPresetBlock {
  type: string;
  settings?: Record<string, unknown>;
}

export interface HaravanPreset {
  name: string;
  category?: string;
  settings?: Record<string, unknown>;
  blocks?: HaravanPresetBlock[];
}

export interface HaravanSectionSchema {
  name: string;
  tag?: string;
  class?: string;
  max_blocks?: number;
  settings: HaravanSchemaSetting[];
  blocks?: HaravanBlockDefinition[];
  presets?: HaravanPreset[];
  locales?: Record<string, Record<string, string>>;
}

export interface HaravanThemeSettingsGroup {
  name: string;
  theme_name?: string;
  theme_author?: string;
  theme_version?: string;
  theme_documentation_url?: string;
  theme_support_url?: string;
  settings?: HaravanSchemaSetting[];
}

export interface InspectedElementStyle {
  selector?: string;
  tag?: string;
  className?: string;
  id?: string;
  attributes?: Record<string, string>;
  styles?: Record<string, string>;
  computedStyles?: Record<string, string>;
  text?: string;
  innerHTML?: string;
}

export interface SectionExtractionContext {
  id?: string;
  name?: string;
  tag?: string;
  className?: string;
  archetype?: string;
  layoutType?: string;
  heading?: string;
  rawHtml?: string;
  cssRules?: Record<string, string>;
  computedStyles?: Record<string, string>;
  inspectedElements?: InspectedElementStyle[];
  schemaSettings?: Array<{ type: string; id?: string; label?: string; content?: string; default?: unknown; [k: string]: unknown }>;
  blockDefinitions?: Array<{ type: string; name: string; settings: Array<{ type: string; id?: string; label?: string; default?: unknown }> }>;
  blocks?: Array<{ id?: string; type: string; name?: string; settings?: Record<string, unknown> }>;
  settings?: Record<string, unknown>;
  isStatic?: boolean;
}

export interface HaravanSettingsSchemaOptions {
  themeName?: string;
  author?: string;
  version?: string;
  hotline?: string;
  email?: string;
  customGroups?: HaravanThemeSettingsGroup[];
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Legacy to Haravan OS 2.0 type sanitization helper.
 * Replaces legacy types that trigger platform validator errors.
 */
export function sanitizeSettingType(rawType: string): { type: HaravanSchemaInputType; transformedProps?: Partial<HaravanSchemaSetting> } {
  const normalized = (rawType || '').toLowerCase().trim().replace(/[-]/g, '_');

  if (normalized === 'font_size') {
    return {
      type: 'range',
      transformedProps: {
        min: 10,
        max: 72,
        step: 1,
        unit: 'px',
        default: 16
      }
    };
  }

  if (normalized === 'font_style') {
    return {
      type: 'select',
      transformedProps: {
        options: [
          { value: 'normal', label: 'Normal' },
          { value: 'italic', label: 'Italic' },
          { value: 'bold', label: 'Bold' }
        ],
        default: 'normal'
      }
    };
  }

  if (normalized === 'font_family') {
    return {
      type: 'font_picker',
      transformedProps: {
        default: 'roboto_n4'
      }
    };
  }

  if (normalized === 'dropdown' || normalized === 'choice') {
    return { type: 'select' };
  }

  if (normalized === 'file' || normalized === 'media' || normalized === 'picture') {
    return { type: 'image_picker' };
  }

  if (Boolean(VALID_HARAVAN_SCHEMA_TYPES[rawType as HaravanSchemaInputType])) {
    return { type: rawType as HaravanSchemaInputType };
  }

  if (Boolean(VALID_HARAVAN_SCHEMA_TYPES[normalized as HaravanSchemaInputType])) {
    return { type: normalized as HaravanSchemaInputType };
  }
  return { type: 'text' };
}

/**
 * Strict ID sanitizer for Haravan settings and blocks.
 * Enforces /^[a-z0-9_]+$/ with lowercase and no leading/trailing underscores.
 */
export function sanitizeSettingId(rawId: string, fallbackPrefix: string = 'setting'): string {
  let clean = (rawId || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  if (!clean || !/^[a-z]/.test(clean)) {
    clean = `${fallbackPrefix}_${clean}`.replace(/_+/g, '_').replace(/_+$/, '');
  }

  return clean;
}

const NAMED_HEX_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  navy: '#000080',
  orange: '#ffa500',
  yellow: '#ffff00',
  silver: '#c0c0c0',
  gold: '#ffd700'
};

/**
 * Normalizes CSS colors (hex, rgb, rgba, named colors) to 6-digit lowercase #rrggbb format.
 */
export function normalizeHexColor(rawColor: string): string | null {
  if (!rawColor || typeof rawColor !== 'string') return null;
  const trimmed = rawColor.trim().toLowerCase();
  if (trimmed === 'transparent' || trimmed === 'inherit' || trimmed === 'initial' || trimmed === 'none') {
    return null;
  }

  if (NAMED_HEX_COLORS[trimmed]) {
    return NAMED_HEX_COLORS[trimmed];
  }

  // Hex check
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return `#${hex}`;
    }
    if (/^[0-9a-f]{8}$/.test(hex)) {
      return `#${hex.slice(0, 6)}`;
    }
    return null;
  }

  // RGB / RGBA check
  const rgbMatch = trimmed.match(/^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const a = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
    if (a <= 0.05) return null; // Ignore nearly invisible/transparent
    const rHex = Math.max(0, Math.min(255, r)).toString(16).padStart(2, '0');
    const gHex = Math.max(0, Math.min(255, g)).toString(16).padStart(2, '0');
    const bHex = Math.max(0, Math.min(255, b)).toString(16).padStart(2, '0');
    return `#${rHex}${gHex}${bHex}`;
  }

  return null;
}

export class HaravanSchemaGenerator {
  /**
   * Validates a Section Schema against Haravan OS 2.0 schema rules.
   */
  public validateSectionSchema(schema: HaravanSectionSchema): SchemaValidationResult {
    const errors: string[] = [];

    if (!schema || typeof schema !== 'object') {
      return { valid: false, errors: ['Section schema must be a valid non-empty object'] };
    }

    if (!schema.name || typeof schema.name !== 'string' || !schema.name.trim()) {
      errors.push('Section schema must have a non-empty name string');
    }

    const seenIds = new Set<string>();

    if (!Array.isArray(schema.settings)) {
      errors.push('Section schema settings must be an array');
    } else {
      for (let i = 0; i < schema.settings.length; i++) {
        const s = schema.settings[i];
        if (!s || typeof s !== 'object') {
          errors.push(`Setting at index ${i} is not a valid object`);
          continue;
        }

        if (!VALID_HARAVAN_SCHEMA_TYPES[s.type as HaravanSchemaInputType]) {
          errors.push(`Setting at index ${i} has invalid Haravan type: "${s.type}"`);
        }

        if (s.type === 'header' || s.type === 'paragraph') {
          if (s.id) {
            errors.push(`Structural setting "${s.type}" at index ${i} must not contain an id attribute`);
          }
          if (!s.content || typeof s.content !== 'string' || !s.content.trim()) {
            errors.push(`Structural setting "${s.type}" at index ${i} requires a non-empty content string`);
          }
        } else {
          if (!s.id || typeof s.id !== 'string' || !/^[a-z0-9_]+$/.test(s.id)) {
            errors.push(`Setting at index ${i} has missing or invalid id: "${s.id}". Must match /^[a-z0-9_]+$/`);
          } else {
            if (seenIds.has(s.id)) {
              errors.push(`Duplicate setting id detected in section: "${s.id}"`);
            }
            seenIds.add(s.id);
          }

          if (!s.label || typeof s.label !== 'string' || !s.label.trim()) {
            errors.push(`Setting "${s.id || i}" requires a non-empty label`);
          }

          if (s.type === 'range') {
            if (typeof s.min !== 'number' || typeof s.max !== 'number' || typeof s.step !== 'number') {
              errors.push(`Range setting "${s.id}" requires numeric min, max, and step attributes`);
            } else if (s.min >= s.max) {
              errors.push(`Range setting "${s.id}" min (${s.min}) must be strictly less than max (${s.max})`);
            }
          }

          if (s.type === 'select' || s.type === 'radio') {
            if (!Array.isArray(s.options) || s.options.length === 0) {
              errors.push(`Select/radio setting "${s.id}" requires a non-empty options array`);
            }
          }
        }
      }
    }

    if (schema.blocks !== undefined) {
      if (!Array.isArray(schema.blocks)) {
        errors.push('Section schema blocks must be an array when specified');
      } else {
        const blockTypes = new Set<string>();
        for (let bIdx = 0; bIdx < schema.blocks.length; bIdx++) {
          const block = schema.blocks[bIdx];
          if (!block || typeof block !== 'object') {
            errors.push(`Block definition at index ${bIdx} is not a valid object`);
            continue;
          }

          if (!block.type || typeof block.type !== 'string' || !/^[a-z0-9_]+$/.test(block.type)) {
            errors.push(`Block definition at index ${bIdx} has invalid type: "${block.type}"`);
          } else {
            blockTypes.add(block.type);
          }

          if (!block.name || typeof block.name !== 'string' || !block.name.trim()) {
            errors.push(`Block definition at index ${bIdx} requires a non-empty name`);
          }

          if (!Array.isArray(block.settings)) {
            errors.push(`Block definition "${block.type || bIdx}" settings must be an array`);
          } else {
            const blockSeenIds = new Set<string>();
            for (let bsIdx = 0; bsIdx < block.settings.length; bsIdx++) {
              const bs = block.settings[bsIdx];
              if (!VALID_HARAVAN_SCHEMA_TYPES[bs.type as HaravanSchemaInputType]) {
                errors.push(`Block "${block.type}" setting at index ${bsIdx} has invalid type "${bs.type}"`);
              }
              if (bs.type !== 'header' && bs.type !== 'paragraph') {
                if (!bs.id || !/^[a-z0-9_]+$/.test(bs.id)) {
                  errors.push(`Block "${block.type}" setting at index ${bsIdx} has invalid id: "${bs.id}"`);
                } else {
                  if (blockSeenIds.has(bs.id)) {
                    errors.push(`Duplicate setting id in block "${block.type}": "${bs.id}"`);
                  }
                  blockSeenIds.add(bs.id);
                }
              }
            }
          }
        }
      }
    }

    if (schema.presets !== undefined) {
      if (!Array.isArray(schema.presets)) {
        errors.push('Section presets must be an array when specified');
      } else {
        for (let pIdx = 0; pIdx < schema.presets.length; pIdx++) {
          const p = schema.presets[pIdx];
          if (!p || typeof p !== 'object') {
            errors.push(`Preset at index ${pIdx} is not a valid object`);
            continue;
          }
          if (!p.name || typeof p.name !== 'string' || !p.name.trim()) {
            errors.push(`Preset at index ${pIdx} requires a non-empty name string`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validates Theme Settings Schema groups (config/settings_schema.json).
   */
  public validateThemeSettingsSchema(groups: HaravanThemeSettingsGroup[]): SchemaValidationResult {
    const errors: string[] = [];

    if (!Array.isArray(groups)) {
      return { valid: false, errors: ['Theme settings schema must be an array of groups'] };
    }

    const seenGroupNames = new Set<string>();
    const seenSettingIds = new Set<string>();

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const g = groups[gIdx];
      if (!g || typeof g !== 'object') {
        errors.push(`Settings group at index ${gIdx} is not a valid object`);
        continue;
      }

      if (!g.name || typeof g.name !== 'string' || !g.name.trim()) {
        errors.push(`Settings group at index ${gIdx} requires a non-empty name`);
      } else {
        if (seenGroupNames.has(g.name)) {
          errors.push(`Duplicate settings group name: "${g.name}"`);
        }
        seenGroupNames.add(g.name);
      }

      if (g.name === 'theme_info') {
        if (!g.theme_name) errors.push('Group "theme_info" requires theme_name');
        if (!g.theme_author) errors.push('Group "theme_info" requires theme_author');
        if (!g.theme_version) errors.push('Group "theme_info" requires theme_version');
        continue;
      }

      if (g.settings) {
        if (!Array.isArray(g.settings)) {
          errors.push(`Group "${g.name}" settings must be an array`);
        } else {
          for (let sIdx = 0; sIdx < g.settings.length; sIdx++) {
            const s = g.settings[sIdx];
            if (!VALID_HARAVAN_SCHEMA_TYPES[s.type as HaravanSchemaInputType]) {
              errors.push(`Group "${g.name}" setting "${s.id || sIdx}" has invalid type "${s.type}"`);
            }

            if (s.type === 'header' || s.type === 'paragraph') {
              if (s.id) errors.push(`Header/paragraph setting in group "${g.name}" must not have an id`);
              if (!s.content) errors.push(`Header/paragraph setting in group "${g.name}" requires content`);
            } else {
              if (!s.id || !/^[a-z0-9_]+$/.test(s.id)) {
                errors.push(`Group "${g.name}" setting at index ${sIdx} has invalid id: "${s.id}"`);
              } else {
                if (seenSettingIds.has(s.id)) {
                  errors.push(`Duplicate global setting id in settings_schema.json: "${s.id}"`);
                }
                seenSettingIds.add(s.id);
              }
              if (!s.label) {
                errors.push(`Group "${g.name}" setting "${s.id}" requires a label`);
              }
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Main Dynamic Extractor:
   * Analyzes Section IR, DOM structure, and element styles to infer a complete Haravan OS 2.0 schema.
   */
  public extractSectionSchema(
    input: SectionExtractionContext | ComponentSectionContract | ExtractedSectionBlueprint
  ): HaravanSectionSchema {
    const ctx = this.normalizeSectionContext(input);
    const usedSettingIds = new Set<string>();
    const settings: HaravanSchemaSetting[] = [];

    // Helper to allocate unique setting IDs
    const allocateId = (preferred: string): string => {
      const base = sanitizeSettingId(preferred);
      let candidate = base;
      let counter = 2;
      while (usedSettingIds.has(candidate)) {
        candidate = `${base}_${counter}`;
        counter++;
      }
      usedSettingIds.add(candidate);
      return candidate;
    };

    // 1. Process and sanitize pre-existing schema settings if provided
    if (ctx.schemaSettings && ctx.schemaSettings.length > 0) {
      for (const rawSet of ctx.schemaSettings) {
        const sanitized = sanitizeSettingType(rawSet.type);
        if (sanitized.type === 'header' || sanitized.type === 'paragraph') {
          settings.push({
            type: sanitized.type,
            content: rawSet.content || rawSet.label || 'Header'
          });
        } else {
          const settingId = allocateId(rawSet.id || 'setting');
          const settingObj: HaravanSchemaSetting = {
            type: sanitized.type,
            id: settingId,
            label: rawSet.label || rawSet.id || 'Setting',
            default: rawSet.default !== undefined ? (rawSet.default as HaravanSchemaSetting['default']) : undefined,
            ...sanitized.transformedProps
          };
          if (Array.isArray(rawSet.options) && !settingObj.options) {
            settingObj.options = rawSet.options as HaravanSelectOption[];
          }
          if (typeof rawSet.min === 'number' && settingObj.min === undefined) {
            settingObj.min = rawSet.min;
          }
          if (typeof rawSet.max === 'number' && settingObj.max === undefined) {
            settingObj.max = rawSet.max;
          }
          if (typeof rawSet.step === 'number' && settingObj.step === undefined) {
            settingObj.step = rawSet.step;
          }
          if (typeof rawSet.unit === 'string' && settingObj.unit === undefined) {
            settingObj.unit = rawSet.unit;
          }
          if (typeof rawSet.info === 'string' && settingObj.info === undefined) {
            settingObj.info = rawSet.info;
          }
          if (typeof rawSet.placeholder === 'string' && settingObj.placeholder === undefined) {
            settingObj.placeholder = rawSet.placeholder;
          }
          settings.push(settingObj);
        }
      }
    }

    // 2. Parse raw HTML if available for DOM-based dynamic extraction
    const rootNode = ctx.rawHtml ? DomTreeParser.parse(ctx.rawHtml) : null;

    // 3. Dynamic Text / Heading Extraction
    this.extractDynamicTextSettings(ctx, rootNode, settings, usedSettingIds, allocateId);

    // 4. Dynamic Color Extraction (CSS variables and computed styles)
    this.extractDynamicColorSettings(ctx, rootNode, settings, usedSettingIds, allocateId);

    // 5. Dynamic Image Extraction (<img> tags and CSS background-images)
    this.extractDynamicImageSettings(ctx, rootNode, settings, usedSettingIds, allocateId);

    // 6. Dynamic Toggle (Checkbox) Extraction
    this.extractDynamicToggleSettings(ctx, rootNode, settings, usedSettingIds, allocateId);

    // 7. Dynamic Sliders & Collection Extraction
    this.extractDynamicSliderAndCollectionSettings(ctx, rootNode, settings, usedSettingIds, allocateId);

    // 8. Dynamic Block Definitions & Preset Instances Extraction
    const { blockDefinitions, presetBlocks } = this.extractDynamicBlocksAndPresets(
      ctx,
      rootNode
    );

    // 9. Build Preset Configuration (only for non-static sections)
    const isStaticSection = this.isStaticSection(ctx);
    let presets: HaravanPreset[] | undefined;

    if (!isStaticSection) {
      const presetSettings: Record<string, unknown> = {};
      for (const s of settings) {
        if (s.id && s.default !== undefined) {
          presetSettings[s.id] = s.default;
        }
      }

      presets = [
        {
          name: ctx.name || 'Custom Section',
          category: this.inferPresetCategory(ctx.archetype, ctx.className),
          settings: Object.keys(presetSettings).length > 0 ? presetSettings : undefined,
          blocks: presetBlocks.length > 0 ? presetBlocks : undefined
        }
      ];
    }

    const sectionSchema: HaravanSectionSchema = {
      name: ctx.name || 'Custom Section',
      tag: ctx.tag || 'section',
      class: ctx.className || `section-${ctx.id || 'custom'}`,
      settings,
      blocks: blockDefinitions,
      presets
    };

    return sectionSchema;
  }

  /**
   * Generates formatted JSON string for {% schema %} section block.
   */
  public generateSectionSchemaJson(
    input: SectionExtractionContext | ComponentSectionContract | ExtractedSectionBlueprint,
    pretty: boolean = true
  ): string {
    const schema = this.extractSectionSchema(input);
    return JSON.stringify(schema, null, pretty ? 2 : undefined);
  }

  /**
   * Wraps Liquid markup and generated {% schema %} block into full section file contents.
   */
  public generateSectionLiquidWithSchema(liquidTemplate: string, schema: HaravanSectionSchema): string {
    const schemaJson = JSON.stringify(schema, null, 2);
    return `${liquidTemplate.trim()}\n\n{% schema %}\n${schemaJson}\n{% endschema %}\n`;
  }

  /**
   * Generates config/settings_schema.json for theme-level customizer.
   * Fully backward-compatible with theme-compiler while supporting dynamic IR extraction.
   */
  public generateSettingsSchema(
    themeNameOrIR: string | ComponentContractIR = 'Storefront Pro',
    hotline: string = '',
    email: string = '',
    options?: HaravanSettingsSchemaOptions
  ): string {
    if (typeof themeNameOrIR === 'object' && themeNameOrIR !== null) {
      return this.generateThemeSettingsSchemaFromIR(themeNameOrIR, options);
    }

    const themeName = (typeof themeNameOrIR === 'string' && themeNameOrIR) || options?.themeName || 'Storefront Pro';
    const supportHotline = hotline || options?.hotline || '';
    const supportEmail = email || options?.email || '';

    const schema: HaravanThemeSettingsGroup[] = [
      {
        name: 'theme_info',
        theme_name: themeName,
        theme_author: options?.author || 'AntiFan Theme Engineering',
        theme_version: options?.version || '1.0.0',
        theme_documentation_url: 'https://antifan.f1genz.dev/docs',
        theme_support_url: 'https://antifan.f1genz.dev/support'
      },
      {
        name: 'Colors & Branding',
        settings: [
          {
            type: 'color',
            id: 'color_primary',
            label: 'Primary Brand Color',
            default: '#005baa'
          },
          {
            type: 'color',
            id: 'color_secondary',
            label: 'Secondary Accent Color',
            default: '#ff6600'
          },
          {
            type: 'color',
            id: 'color_text',
            label: 'Body Text Color',
            default: '#22343e'
          },
          {
            type: 'color',
            id: 'color_bg',
            label: 'Page Background Color',
            default: '#ffffff'
          }
        ]
      },
      {
        name: 'Typography',
        settings: [
          {
            type: 'font_picker',
            id: 'font_body',
            label: 'Body Font Family',
            default: 'roboto_n4'
          },
          {
            type: 'font_picker',
            id: 'font_heading',
            label: 'Heading Font Family',
            default: 'roboto_n7'
          }
        ]
      },
      {
        name: 'Header & Contact Information',
        settings: [
          {
            type: 'image_picker',
            id: 'logo',
            label: 'Main Logo'
          },
          {
            type: 'text',
            id: 'hotline',
            label: 'Support Hotline',
            default: supportHotline
          },
          {
            type: 'text',
            id: 'email',
            label: 'Contact Email',
            default: supportEmail
          }
        ]
      }
    ];

    if (options?.customGroups && options.customGroups.length > 0) {
      schema.push(...options.customGroups);
    }

    return JSON.stringify(schema, null, 2);
  }

  /**
   * Generates dynamic config/settings_schema.json by inspecting ComponentContractIR.
   */
  public generateThemeSettingsSchemaFromIR(
    ir: ComponentContractIR,
    options?: HaravanSettingsSchemaOptions
  ): string {
    const siteSettings = ir.normalizedData?.siteSettings;
    const themeName = options?.themeName || (typeof siteSettings?.title === 'string' && siteSettings.title) || 'Storefront Pro';
    const hotline = options?.hotline || (typeof siteSettings?.hotline === 'string' && siteSettings.hotline) || '';
    const email = options?.email || (typeof siteSettings?.email === 'string' && siteSettings.email) || '';

    // Extract dynamic colors from ir.headStyles, ir.layout, or ir.themeSettings
    const dynamicColors: Record<string, string> = {
      color_primary: '#005baa',
      color_secondary: '#ff6600',
      color_text: '#22343e',
      color_bg: '#ffffff'
    };

    if (ir.themeSettings && Array.isArray(ir.themeSettings)) {
      for (const ts of ir.themeSettings) {
        if (ts.type === 'color' && typeof ts.default === 'string') {
          const norm = normalizeHexColor(ts.default);
          if (norm) {
            const cleanId = sanitizeSettingId(ts.id, 'color');
            dynamicColors[cleanId] = norm;
          }
        }
      }
    }

    if (ir.headStyles && Array.isArray(ir.headStyles)) {
      for (const styleBlock of ir.headStyles) {
        const varMatches = styleBlock.matchAll(/--([a-zA-Z0-9_-]*(?:color|brand|primary|secondary|accent|bg|text)[a-zA-Z0-9_-]*)\s*:\s*([^;]+);/gi);
        for (const match of varMatches) {
          const rawVar = match[1].toLowerCase().replace(/-/g, '_');
          const cleanSuffix = rawVar.replace(/^color_|_color$/g, '').replace(/_+/g, '_');
          const norm = normalizeHexColor(match[2]);
          if (norm) {
            const cleanId = sanitizeSettingId(`color_${cleanSuffix}`);
            dynamicColors[cleanId] = norm;
          }
        }
      }
    }

    const colorSettings: HaravanSchemaSetting[] = Object.entries(dynamicColors).map(([id, hex]) => ({
      type: 'color',
      id,
      label: this.formatSettingLabel(id),
      default: hex
    }));

    const schema: HaravanThemeSettingsGroup[] = [
      {
        name: 'theme_info',
        theme_name: themeName,
        theme_author: options?.author || 'AntiFan Theme Engineering',
        theme_version: options?.version || '1.0.0',
        theme_documentation_url: 'https://antifan.f1genz.dev/docs',
        theme_support_url: 'https://antifan.f1genz.dev/support'
      },
      {
        name: 'Colors & Branding',
        settings: colorSettings
      },
      {
        name: 'Typography',
        settings: [
          {
            type: 'font_picker',
            id: 'font_body',
            label: 'Body Font Family',
            default: 'roboto_n4'
          },
          {
            type: 'font_picker',
            id: 'font_heading',
            label: 'Heading Font Family',
            default: 'roboto_n7'
          }
        ]
      },
      {
        name: 'Header & Contact Information',
        settings: [
          {
            type: 'image_picker',
            id: 'logo',
            label: 'Main Logo'
          },
          {
            type: 'text',
            id: 'hotline',
            label: 'Support Hotline',
            default: hotline
          },
          {
            type: 'text',
            id: 'email',
            label: 'Contact Email',
            default: email
          }
        ]
      }
    ];

    if (options?.customGroups && options.customGroups.length > 0) {
      schema.push(...options.customGroups);
    }

    return JSON.stringify(schema, null, 2);
  }

  // ==========================================
  // Private Dynamic Extraction Helpers
  // ==========================================

  private normalizeSectionContext(
    input: SectionExtractionContext | ComponentSectionContract | ExtractedSectionBlueprint
  ): SectionExtractionContext {
    const raw = input as Record<string, unknown>;
    const archetype = (raw.archetype as string) || (raw.type as string) || 'custom_section';
    const rawName = (raw.name as string) || 'Custom Section';
    const isStatic =
      archetype === 'header' ||
      archetype === 'footer' ||
      rawName.toLowerCase().includes('header') ||
      rawName.toLowerCase().includes('footer');

    const schemaSettings = Array.isArray(raw.schemaSettings)
      ? (raw.schemaSettings as SectionExtractionContext['schemaSettings'])
      : undefined;

    const blockDefinitions = Array.isArray(raw.blockDefinitions)
      ? (raw.blockDefinitions as SectionExtractionContext['blockDefinitions'])
      : undefined;

    const blocks = Array.isArray(raw.blocks)
      ? (raw.blocks as SectionExtractionContext['blocks'])
      : Array.isArray(raw.blockInstances)
        ? (raw.blockInstances as SectionExtractionContext['blocks'])
        : undefined;

    return {
      id: (raw.id as string) || 'section',
      name: rawName,
      tag: (raw.tagName as string) || (raw.tag as string) || 'section',
      className: (raw.className as string) || '',
      archetype,
      layoutType: (raw.layoutType as string) || 'flow',
      heading: (raw.heading as string) || '',
      rawHtml: (raw.rawHtml as string) || '',
      cssRules: (raw.cssRules as Record<string, string>) || {},
      computedStyles: (raw.computedStyles as Record<string, string>) || {},
      inspectedElements: (raw.inspectedElements as InspectedElementStyle[]) || [],
      schemaSettings,
      blockDefinitions,
      blocks,
      settings: (raw.settings as Record<string, unknown>) || {},
      isStatic
    };
  }

  private isStaticSection(ctx: SectionExtractionContext): boolean {
    if (ctx.isStatic) return true;
    const arch = (ctx.archetype || '').toLowerCase();
    const name = (ctx.name || '').toLowerCase();
    const id = (ctx.id || '').toLowerCase();
    return (
      arch === 'header' ||
      arch === 'footer' ||
      name.includes('header') ||
      name.includes('footer') ||
      id.includes('header') ||
      id.includes('footer')
    );
  }

  private extractDynamicTextSettings(
    ctx: SectionExtractionContext,
    rootNode: ParsedElementNode | null,
    settings: HaravanSchemaSetting[],
    usedIds: Set<string>,
    allocateId: (preferred: string) => string
  ): void {
    // Heading extraction
    let headingText = ctx.heading || '';
    if (!headingText && rootNode) {
      for (const hTag of ['h1', 'h2', 'h3']) {
        const headings = DomTreeParser.findByTag(rootNode, hTag);
        if (headings.length > 0) {
          const txt = DomTreeParser.extractText(headings[0]);
          if (txt) {
            headingText = txt;
            break;
          }
        }
      }
    }

    if (headingText && !settings.some((s) => s.id === 'heading')) {
      settings.push({
        type: 'text',
        id: allocateId('heading'),
        label: 'Section Heading',
        default: headingText.trim()
      });
    }

    // Subheading extraction (h4, h5, .subtitle, .sub-heading)
    if (rootNode) {
      let subHeadingText = '';
      for (const hTag of ['h4', 'h5']) {
        const subH = DomTreeParser.findByTag(rootNode, hTag);
        if (subH.length > 0) {
          const txt = DomTreeParser.extractText(subH[0]);
          if (txt && txt !== headingText) {
            subHeadingText = txt;
            break;
          }
        }
      }

      if (!subHeadingText) {
        const subtitleNodes = [
          ...DomTreeParser.findByClass(rootNode, 'subtitle'),
          ...DomTreeParser.findByClass(rootNode, 'sub-heading'),
          ...DomTreeParser.findByClass(rootNode, 'section-subtitle')
        ];
        if (subtitleNodes.length > 0) {
          subHeadingText = DomTreeParser.extractText(subtitleNodes[0]);
        }
      }

      if (subHeadingText && !settings.some((s) => s.id === 'subheading')) {
        settings.push({
          type: 'text',
          id: allocateId('subheading'),
          label: 'Section Subheading',
          default: subHeadingText.trim()
        });
      }

      // Description / Rich Text extraction
      const descNodes = [
        ...DomTreeParser.findByClass(rootNode, 'description'),
        ...DomTreeParser.findByClass(rootNode, 'section-desc'),
        ...DomTreeParser.findByClass(rootNode, 'content'),
        ...DomTreeParser.findByClass(rootNode, 'rte')
      ];

      const pNodes = DomTreeParser.findByTag(rootNode, 'p');
      const candidateNode = descNodes[0] || (pNodes.length === 1 ? pNodes[0] : null);

      if (candidateNode && !settings.some((s) => s.id === 'description' || s.id === 'content')) {
        const inner = candidateNode.innerHtml || '';
        const text = DomTreeParser.extractText(candidateNode);

        if (text && text !== headingText && text !== subHeadingText && text.length > 10) {
          // If contains rich formatting tags (strong, em, a, ul, ol), use richtext
          if (/<(strong|b|em|i|a|ul|ol|li)\b/i.test(inner)) {
            settings.push({
              type: 'richtext',
              id: allocateId('content'),
              label: 'Section Description',
              default: `<p>${inner.trim()}</p>`
            });
          } else if (text.length > 100 || inner.includes('\n')) {
            settings.push({
              type: 'textarea',
              id: allocateId('description'),
              label: 'Section Description',
              default: text.trim()
            });
          } else {
            settings.push({
              type: 'text',
              id: allocateId('description'),
              label: 'Section Description',
              default: text.trim()
            });
          }
        }
      }

      // Button / CTA label and link extraction
      const btnNodes = [
        ...DomTreeParser.findByClass(rootNode, 'btn'),
        ...DomTreeParser.findByClass(rootNode, 'button'),
        ...DomTreeParser.findByClass(rootNode, 'cta-btn')
      ];

      if (btnNodes.length > 0 && !settings.some((s) => s.id === 'button_label')) {
        const btn = btnNodes[0];
        const btnText = DomTreeParser.extractText(btn);
        const btnHref = btn.attributes['href'] || '#';

        if (btnText && btnText.length < 50) {
          settings.push({
            type: 'text',
            id: allocateId('button_label'),
            label: 'Button Label',
            default: btnText.trim()
          });
          settings.push({
            type: 'url',
            id: allocateId('button_link'),
            label: 'Button Link',
            default: btnHref
          });
        }
      }
    }
  }

  private extractDynamicColorSettings(
    ctx: SectionExtractionContext,
    rootNode: ParsedElementNode | null,
    settings: HaravanSchemaSetting[],
    usedIds: Set<string>,
    allocateId: (preferred: string) => string
  ): void {
    const discoveredColors = new Map<string, string>();

    // 1. Inspect CSS rules from context
    if (ctx.cssRules) {
      for (const [prop, val] of Object.entries(ctx.cssRules)) {
        const norm = normalizeHexColor(val);
        if (!norm) continue;

        const p = prop.toLowerCase();
        if (p.includes('primary') || p.includes('brand')) {
          discoveredColors.set('color_primary', norm);
        } else if (p.includes('secondary') || p.includes('accent')) {
          discoveredColors.set('color_secondary', norm);
        } else if (p.includes('background') || p === 'background-color' || p === 'bg') {
          discoveredColors.set('color_bg', norm);
        } else if (p === 'color' || p.includes('text')) {
          discoveredColors.set('color_text', norm);
        } else if (p.includes('border')) {
          discoveredColors.set('color_border', norm);
        }
      }
    }

    // 2. Inspect computedStyles from context
    if (ctx.computedStyles) {
      for (const [prop, val] of Object.entries(ctx.computedStyles)) {
        const norm = normalizeHexColor(val);
        if (!norm) continue;
        const p = prop.toLowerCase();
        if (p === 'background-color' && !discoveredColors.has('color_bg')) {
          discoveredColors.set('color_bg', norm);
        } else if (p === 'color' && !discoveredColors.has('color_text')) {
          discoveredColors.set('color_text', norm);
        }
      }
    }

    // 3. Inspect inspectedElements styles
    if (ctx.inspectedElements) {
      for (const el of ctx.inspectedElements) {
        const allStyles = { ...(el.styles || {}), ...(el.computedStyles || {}) };
        for (const [prop, val] of Object.entries(allStyles)) {
          const norm = normalizeHexColor(val);
          if (!norm) continue;
          if (prop.startsWith('--')) {
            const varKey = prop.replace(/^--/, '').replace(/-/g, '_');
            discoveredColors.set(`color_${varKey}`, norm);
          }
        }
      }
    }

    // 4. Scan raw HTML for CSS variables or style declarations
    if (ctx.rawHtml) {
      const varMatches = ctx.rawHtml.matchAll(/--([a-zA-Z0-9_-]*(?:color|bg|background|text|primary|accent|brand)[a-zA-Z0-9_-]*)\s*:\s*([^;"]+)/gi);
      for (const vm of varMatches) {
        const rawVar = vm[1].toLowerCase().replace(/-/g, '_');
        const cleanSuffix = rawVar.replace(/^color_|_color$/g, '').replace(/_+/g, '_');
        const norm = normalizeHexColor(vm[2]);
        if (norm) {
          discoveredColors.set(`color_${cleanSuffix}`, norm);
        }
      }
    }

    for (const [key, hexVal] of discoveredColors.entries()) {
      if (!settings.some((s) => s.id === key)) {
        settings.push({
          type: 'color',
          id: allocateId(key),
          label: this.formatSettingLabel(key),
          default: hexVal
        });
      }
    }
  }

  private extractDynamicImageSettings(
    ctx: SectionExtractionContext,
    rootNode: ParsedElementNode | null,
    settings: HaravanSchemaSetting[],
    usedIds: Set<string>,
    allocateId: (preferred: string) => string
  ): void {
    if (!rootNode) return;

    // Check for background-image in section or banner element
    let bgImageUrl = '';
    const styleAttr = rootNode.attributes['style'] || '';
    const bgMatch = styleAttr.match(/background-image\s*:\s*url\(['"]?([^'"]+)['"]?\)/i);
    if (bgMatch) {
      bgImageUrl = bgMatch[1];
    } else if (ctx.cssRules?.['background-image']) {
      const match = ctx.cssRules['background-image'].match(/url\(['"]?([^'"]+)['"]?\)/i);
      if (match) bgImageUrl = match[1];
    }

    if (bgImageUrl && !settings.some((s) => s.id === 'background_image' || s.id === 'bg_image')) {
      settings.push({
        type: 'image_picker',
        id: allocateId('background_image'),
        label: 'Section Background Image',
        info: 'Recommended dimensions: 1920x800px'
      });
    }

    // Check for standalone hero / banner image (not part of repeated cards/blocks)
    const imgs = DomTreeParser.findByTag(rootNode, 'img');
    const isHeader = ctx.isStatic && ctx.name?.toLowerCase().includes('header');

    for (const img of imgs) {
      const src = img.attributes['src'] || '';
      const alt = img.attributes['alt'] || '';
      const cls = (img.attributes['class'] || '').toLowerCase();

      // Logo detection
      if ((isHeader || cls.includes('logo') || alt.toLowerCase().includes('logo')) && !settings.some((s) => s.id === 'logo')) {
        settings.push({
          type: 'image_picker',
          id: allocateId('logo'),
          label: 'Logo Image'
        });
        continue;
      }

      // Standalone hero banner image
      if ((cls.includes('banner') || cls.includes('hero') || cls.includes('featured')) && !settings.some((s) => s.id === 'image' || s.id === 'banner_image')) {
        settings.push({
          type: 'image_picker',
          id: allocateId('banner_image'),
          label: 'Banner Image',
          info: alt ? `Alt: ${alt}` : undefined
        });
      }
    }
  }

  private extractDynamicToggleSettings(
    ctx: SectionExtractionContext,
    rootNode: ParsedElementNode | null,
    settings: HaravanSchemaSetting[],
    usedIds: Set<string>,
    allocateId: (preferred: string) => string
  ): void {
    const rawClass = (ctx.className || '').toLowerCase();
    const rawHtml = (ctx.rawHtml || '').toLowerCase();

    // Full width toggle
    const isFullWidth = rawClass.includes('container-fluid') || rawClass.includes('full-width');
    if (!settings.some((s) => s.id === 'full_width')) {
      settings.push({
        type: 'checkbox',
        id: allocateId('full_width'),
        label: 'Full Width Section',
        default: isFullWidth
      });
    }

    // Carousel feature toggles
    const isCarousel =
      ctx.archetype === 'hero_slider' ||
      rawClass.includes('slider') ||
      rawClass.includes('carousel') ||
      rawClass.includes('swiper') ||
      rawClass.includes('slick') ||
      rawHtml.includes('data-antifan-slider');

    if (isCarousel) {
      if (!settings.some((s) => s.id === 'autoplay')) {
        settings.push({
          type: 'checkbox',
          id: allocateId('autoplay'),
          label: 'Enable Autoplay',
          default: true
        });
      }

      const hasArrows = rawHtml.includes('arrow') || rawHtml.includes('prev') || rawHtml.includes('next') || rawHtml.includes('swiper-button');
      if (!settings.some((s) => s.id === 'show_arrows')) {
        settings.push({
          type: 'checkbox',
          id: allocateId('show_arrows'),
          label: 'Show Navigation Arrows',
          default: hasArrows || true
        });
      }

      const hasDots = rawHtml.includes('dot') || rawHtml.includes('pagination') || rawHtml.includes('swiper-pagination');
      if (!settings.some((s) => s.id === 'show_dots')) {
        settings.push({
          type: 'checkbox',
          id: allocateId('show_dots'),
          label: 'Show Pagination Dots',
          default: hasDots || true
        });
      }
    }

    // 'View All' link toggle
    if ((rawHtml.includes('xem tất cả') || rawHtml.includes('view all') || rawClass.includes('view-all')) && !settings.some((s) => s.id === 'show_view_all')) {
      settings.push({
        type: 'checkbox',
        id: allocateId('show_view_all'),
        label: "Show 'View All' Button",
        default: true
      });
    }
  }

  private extractDynamicSliderAndCollectionSettings(
    ctx: SectionExtractionContext,
    rootNode: ParsedElementNode | null,
    settings: HaravanSchemaSetting[],
    usedIds: Set<string>,
    allocateId: (preferred: string) => string
  ): void {
    const rawClass = (ctx.className || '').toLowerCase();
    const isProductOrCollection =
      ctx.archetype === 'product_grid' ||
      ctx.archetype === 'collection_list' ||
      rawClass.includes('product') ||
      rawClass.includes('collection') ||
      rawClass.includes('category-grid') ||
      rawClass.includes('block-category');

    if (isProductOrCollection) {
      // Collection picker
      if (!settings.some((s) => s.id === 'collection')) {
        settings.push({
          type: 'collection',
          id: allocateId('collection'),
          label: 'Select Collection'
        });
      }

      // Count inspected product items
      let itemCount = 8;
      if (rootNode) {
        const items = [
          ...DomTreeParser.findByClass(rootNode, 'product-item'),
          ...DomTreeParser.findByClass(rootNode, 'product-card'),
          ...DomTreeParser.findByClass(rootNode, 'item')
        ];
        if (items.length > 0) {
          itemCount = Math.min(24, Math.max(2, items.length));
        }
      }

      if (!settings.some((s) => s.id === 'products_to_show')) {
        settings.push({
          type: 'range',
          id: allocateId('products_to_show'),
          label: 'Products to Show',
          min: 2,
          max: 24,
          step: 1,
          default: itemCount
        });
      }

      if (!settings.some((s) => s.id === 'columns_desktop')) {
        settings.push({
          type: 'range',
          id: allocateId('columns_desktop'),
          label: 'Columns on Desktop',
          min: 2,
          max: 6,
          step: 1,
          default: 4
        });
      }

      if (!settings.some((s) => s.id === 'columns_mobile')) {
        settings.push({
          type: 'range',
          id: allocateId('columns_mobile'),
          label: 'Columns on Mobile',
          min: 1,
          max: 3,
          step: 1,
          default: 2
        });
      }
    }

    // Slider speed range for carousels
    const isCarousel =
      ctx.archetype === 'hero_slider' ||
      rawClass.includes('slider') ||
      rawClass.includes('carousel') ||
      (ctx.rawHtml || '').includes('data-antifan-slider');

    if (isCarousel && !settings.some((s) => s.id === 'slider_speed')) {
      let speedSec = 5;
      const speedMatch = (ctx.rawHtml || '').match(/data-antifan-autoplay=["'](\d+)["']/i);
      if (speedMatch) {
        const ms = parseInt(speedMatch[1], 10);
        if (ms > 0) speedSec = Math.max(2, Math.min(10, Math.round(ms / 1000)));
      }

      settings.push({
        type: 'range',
        id: allocateId('slider_speed'),
        label: 'Slider Speed',
        min: 2,
        max: 10,
        step: 1,
        unit: 's',
        default: speedSec
      });
    }
  }

  private extractDynamicBlocksAndPresets(
    ctx: SectionExtractionContext,
    rootNode: ParsedElementNode | null
  ): { blockDefinitions: HaravanBlockDefinition[]; presetBlocks: HaravanPresetBlock[] } {
    const blockDefinitions: HaravanBlockDefinition[] = [];
    const presetBlocks: HaravanPresetBlock[] = [];

    // 1. If explicit blockDefinitions are already provided, sanitize their settings
    if (ctx.blockDefinitions && ctx.blockDefinitions.length > 0) {
      for (const bDef of ctx.blockDefinitions) {
        const sanitizedBlockSettings: HaravanSchemaSetting[] = [];
        const seenBlockIds = new Set<string>();

        for (const rawBs of bDef.settings) {
          const sanitizedType = sanitizeSettingType(rawBs.type);
          if (sanitizedType.type === 'header' || sanitizedType.type === 'paragraph') {
            sanitizedBlockSettings.push({
              type: sanitizedType.type,
              content: rawBs.label || 'Header'
            });
          } else {
            const cleanId = sanitizeSettingId(rawBs.id || 'item_setting');
            if (!seenBlockIds.has(cleanId)) {
              seenBlockIds.add(cleanId);
              sanitizedBlockSettings.push({
                type: sanitizedType.type,
                id: cleanId,
                label: rawBs.label || cleanId,
                default: rawBs.default !== undefined ? (rawBs.default as HaravanSchemaSetting['default']) : undefined,
                ...sanitizedType.transformedProps
              });
            }
          }
        }

        blockDefinitions.push({
          type: sanitizeSettingId(bDef.type, 'block'),
          name: bDef.name || 'Block Item',
          settings: sanitizedBlockSettings
        });
      }

      // Populate preset blocks from provided blocks
      if (ctx.blocks && ctx.blocks.length > 0) {
        for (const b of ctx.blocks) {
          presetBlocks.push({
            type: sanitizeSettingId(b.type, 'block'),
            settings: b.settings || {}
          });
        }
      }

      return { blockDefinitions, presetBlocks };
    }

    // 2. Dynamic discovery of repeated DOM elements
    if (!rootNode) {
      return { blockDefinitions, presetBlocks };
    }

    const rawClass = (ctx.className || '').toLowerCase();
    const isHero = ctx.archetype === 'hero_slider' || rawClass.includes('slider') || rawClass.includes('swiper');
    const isCategory = ctx.archetype === 'collection_list' || rawClass.includes('category');

    const candidateItems = [
      ...DomTreeParser.findByClass(rootNode, 'swiper-slide'),
      ...DomTreeParser.findByClass(rootNode, 'slick-slide'),
      ...DomTreeParser.findByClass(rootNode, 's-content__item'),
      ...DomTreeParser.findByClass(rootNode, 'item')
    ];

    // Deduplicate DOM nodes by reference
    const uniqueItems: ParsedElementNode[] = [];
    const seenOuter = new Set<string>();
    for (const it of candidateItems) {
      if (!seenOuter.has(it.outerHtml)) {
        seenOuter.add(it.outerHtml);
        uniqueItems.push(it);
      }
    }

    if (uniqueItems.length >= 2) {
      if (isHero) {
        const slideBlockDef: HaravanBlockDefinition = {
          type: 'slide_item',
          name: 'Slide Item',
          settings: [
            { type: 'image_picker', id: 'image', label: 'Slide Image' },
            { type: 'text', id: 'title', label: 'Slide Title' },
            { type: 'text', id: 'subtitle', label: 'Slide Subtitle' },
            { type: 'url', id: 'link', label: 'Slide Link' }
          ]
        };
        blockDefinitions.push(slideBlockDef);

        for (let idx = 0; idx < uniqueItems.length; idx++) {
          const item = uniqueItems[idx];
          const img = DomTreeParser.findByTag(item, 'img')[0];
          const link = DomTreeParser.findByTag(item, 'a')[0];
          const title = img?.attributes['alt'] || `Banner ${idx + 1}`;
          const href = link?.attributes['href'] || '#';

          presetBlocks.push({
            type: 'slide_item',
            settings: {
              title,
              link: href
            }
          });
        }
      } else if (isCategory) {
        const catBlockDef: HaravanBlockDefinition = {
          type: 'category_item',
          name: 'Category Item',
          settings: [
            { type: 'image_picker', id: 'icon', label: 'Category Icon' },
            { type: 'text', id: 'title', label: 'Category Title' },
            { type: 'url', id: 'link', label: 'Category Link' }
          ]
        };
        blockDefinitions.push(catBlockDef);

        for (let idx = 0; idx < uniqueItems.length; idx++) {
          const item = uniqueItems[idx];
          const titleEl = DomTreeParser.findByTag(item, 'span')[0] || DomTreeParser.findByTag(item, 'h3')[0];
          const link = DomTreeParser.findByTag(item, 'a')[0];
          const title = titleEl ? DomTreeParser.extractText(titleEl) : `Category ${idx + 1}`;
          const href = link?.attributes['href'] || '#';

          presetBlocks.push({
            type: 'category_item',
            settings: {
              title,
              link: href
            }
          });
        }
      } else {
        const genericBlockDef: HaravanBlockDefinition = {
          type: 'item',
          name: 'Content Item',
          settings: [
            { type: 'image_picker', id: 'image', label: 'Item Image' },
            { type: 'text', id: 'title', label: 'Item Title' },
            { type: 'textarea', id: 'text', label: 'Item Description' },
            { type: 'url', id: 'link', label: 'Item Link' }
          ]
        };
        blockDefinitions.push(genericBlockDef);

        for (let idx = 0; idx < Math.min(6, uniqueItems.length); idx++) {
          const item = uniqueItems[idx];
          const titleEl = DomTreeParser.findByTag(item, 'h3')[0] || DomTreeParser.findByTag(item, 'h4')[0];
          const link = DomTreeParser.findByTag(item, 'a')[0];
          const title = titleEl ? DomTreeParser.extractText(titleEl) : `Item ${idx + 1}`;
          const href = link?.attributes['href'] || '#';

          presetBlocks.push({
            type: 'item',
            settings: {
              title,
              link: href
            }
          });
        }
      }
    }

    return { blockDefinitions, presetBlocks };
  }

  private inferPresetCategory(archetype?: string, className?: string): string {
    const arch = (archetype || '').toLowerCase();
    const cls = (className || '').toLowerCase();

    if (arch === 'hero_slider' || cls.includes('banner') || cls.includes('slider') || cls.includes('slide')) {
      return 'Banners & Sliders';
    }
    if (arch === 'product_grid' || cls.includes('product')) {
      return 'Products';
    }
    if (arch === 'collection_list' || cls.includes('category')) {
      return 'Collections';
    }
    if (cls.includes('article') || cls.includes('news') || cls.includes('blog')) {
      return 'Blog & Articles';
    }
    if (cls.includes('partner') || cls.includes('brand')) {
      return 'Brands & Partners';
    }
    return 'Custom Sections';
  }

  private formatSettingLabel(id: string): string {
    return id
      .replace(/^(color_|font_)/, '')
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .trim();
  }
}
