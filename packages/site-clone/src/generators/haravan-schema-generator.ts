/**
 * Haravan Schema Generator
 *
 * Generates and validates theme settings schema (config/settings_schema.json)
 * for the Haravan F1GENZ visual editor customizer.
 *
 * Complies with specs/base-theme-contract.json settings.visualEditor.
 * Note: Haravan themes use flat settings_schema.json for theme-level settings.
 * Section-embedded {% schema %} blocks, blocks, and presets are not supported.
 */

import type { ComponentContractIR, ThemeSettingContract } from '../models/clone-ir.js';

/**
 * Valid Haravan theme schema input types.
 * Strictly whitelisted to avoid platform validator errors.
 */
export type HaravanSchemaInputType =
  | 'header'
  | 'paragraph'
  | 'text'
  | 'textarea'
  | 'checkbox'
  | 'color'
  | 'image_picker'
  | 'select'
  | 'radio'
  | 'link_list'
  | 'collection'
  | 'blog'
  | 'page'
  | 'font_picker'
  | 'number'
  | 'range';

export const VALID_HARAVAN_SCHEMA_TYPES: Record<HaravanSchemaInputType, true> = {
  header: true,
  paragraph: true,
  text: true,
  textarea: true,
  checkbox: true,
  color: true,
  image_picker: true,
  select: true,
  radio: true,
  link_list: true,
  collection: true,
  blog: true,
  page: true,
  font_picker: true,
  number: true,
  range: true,
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
  unit?: string; // for range
  options?: HaravanSelectOption[]; // for select/radio
  placeholder?: string;
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
 * Legacy to Haravan schema type sanitization helper.
 * Replaces legacy types that trigger platform validator errors.
 */
export function sanitizeSettingType(
  rawType: string
): { type: HaravanSchemaInputType; transformedProps?: Partial<HaravanSchemaSetting> } {
  const normalized = (rawType || '').toLowerCase().trim().replace(/[-]/g, '_');

  if (normalized === 'font_size') {
    return {
      type: 'range',
      transformedProps: {
        min: 10,
        max: 72,
        step: 1,
        unit: 'px',
        default: 16,
      },
    };
  }

  if (normalized === 'font_style') {
    return {
      type: 'select',
      transformedProps: {
        options: [
          { value: 'normal', label: 'Normal' },
          { value: 'italic', label: 'Italic' },
          { value: 'bold', label: 'Bold' },
        ],
        default: 'normal',
      },
    };
  }

  if (normalized === 'dropdown' || normalized === 'choice') {
    return { type: 'select' };
  }

  if (normalized === 'toggle' || normalized === 'boolean' || normalized === 'switch') {
    return { type: 'checkbox' };
  }

  if (normalized === 'font' || normalized === 'font_family' || normalized === 'typeface') {
    return { type: 'font_picker' };
  }

  if (normalized === 'file' || normalized === 'media' || normalized === 'picture') {
    return { type: 'image_picker' };
  }

  if (normalized === 'linklist' || normalized === 'menu') {
    return { type: 'link_list' };
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
 * Strict ID sanitizer for Haravan settings.
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
  gold: '#ffd700',
};

/**
 * Normalizes CSS colors (hex, rgb, rgba, named colors) to 6-digit lowercase #rrggbb format.
 */
export function normalizeHexColor(rawColor: string): string | null {
  if (!rawColor || typeof rawColor !== 'string') return null;
  const trimmed = rawColor.trim().toLowerCase();
  if (
    trimmed === 'transparent' ||
    trimmed === 'inherit' ||
    trimmed === 'initial' ||
    trimmed === 'none'
  ) {
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
  const rgbMatch = trimmed.match(
    /^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i
  );
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
   * Validates a settings schema structure against Haravan schema rules.
   * Accepts either an array of HaravanThemeSettingsGroup or a single group.
   */
  public validateSettingsSchema(schema: unknown): SchemaValidationResult {
    const errors: string[] = [];

    if (!schema || (typeof schema !== 'object')) {
      return { valid: false, errors: ['Settings schema must be a valid non-empty object or array'] };
    }

    const groups: HaravanThemeSettingsGroup[] = Array.isArray(schema)
      ? (schema as HaravanThemeSettingsGroup[])
      : [schema as HaravanThemeSettingsGroup];

    if (groups.length === 0) {
      return { valid: false, errors: ['Settings schema must not be empty'] };
    }

    const seenIds = new Set<string>();

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const group = groups[gIdx];
      if (!group || typeof group !== 'object') {
        errors.push(`Group at index ${gIdx} is not a valid object`);
        continue;
      }

      if (typeof group.name !== 'string' || !group.name.trim()) {
        errors.push(`Group at index ${gIdx} must have a non-empty name`);
      }

      // Haravan flat theme settings carry no section constructs.
      if ('presets' in group) {
        errors.push(
          `Presets are not supported in Haravan flat theme settings (group "${group.name || gIdx}")`
        );
      }
      if ('blocks' in group) {
        errors.push(
          `Blocks are not supported in Haravan flat theme settings (group "${group.name || gIdx}")`
        );
      }

      // theme_info group does not require settings array
      if (group.name === 'theme_info') {
        continue;
      }

      if (!Array.isArray(group.settings)) {
        errors.push(`Group "${group.name || gIdx}" settings must be an array`);
        continue;
      }

      for (let sIdx = 0; sIdx < group.settings.length; sIdx++) {
        const s = group.settings[sIdx];
        if (!s || typeof s !== 'object') {
          errors.push(`Setting at [${group.name}][${sIdx}] is not a valid object`);
          continue;
        }

        if (!VALID_HARAVAN_SCHEMA_TYPES[s.type]) {
          errors.push(
            `Setting at [${group.name}][${sIdx}] has invalid Haravan type: "${s.type}"`
          );
        }

        if (s.type === 'header' || s.type === 'paragraph') {
          if (!s.content || typeof s.content !== 'string' || !s.content.trim()) {
            errors.push(
              `Header/paragraph at [${group.name}][${sIdx}] must have a non-empty "content" string`
            );
          }
        } else {
          if (!s.id || typeof s.id !== 'string' || !s.id.trim()) {
            errors.push(`Setting at [${group.name}][${sIdx}] must have a non-empty "id" string`);
          } else {
            if (!/^[a-z0-9_]+$/.test(s.id)) {
              errors.push(
                `Setting id "${s.id}" at [${group.name}][${sIdx}] contains invalid characters (must match /^[a-z0-9_]+$/)`
              );
            }

            if (seenIds.has(s.id)) {
              errors.push(
                `Duplicate setting id "${s.id}" detected in group "${group.name}"`
              );
            } else {
              seenIds.add(s.id);
            }
          }

          if (!s.label || typeof s.label !== 'string' || !s.label.trim()) {
            errors.push(`Setting "${s.id || sIdx}" in group "${group.name}" must have a non-empty "label"`);
          }

          if (s.type === 'range' || s.type === 'number') {
            const min = s.min;
            const max = s.max;
            if (typeof min !== 'number' || typeof max !== 'number') {
              errors.push(
                `Setting "${s.id || sIdx}" in group "${group.name}" type "${s.type}" requires numeric "min" and "max"`
              );
            } else if (!(min < max)) {
              errors.push(
                `Setting "${s.id || sIdx}" range bounds invalid: min (${min}) must be strictly less than max (${max})`
              );
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Generates config/settings_schema.json for Haravan visual theme customizer.
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

    const themeName =
      (typeof themeNameOrIR === 'string' && themeNameOrIR) ||
      options?.themeName ||
      'Storefront Pro';
    const supportHotline = hotline || options?.hotline || '';
    const supportEmail = email || options?.email || '';

    const schema: HaravanThemeSettingsGroup[] = [
      {
        name: 'theme_info',
        theme_name: themeName,
        theme_author: options?.author || 'AntiFan Theme Engineering',
        theme_version: options?.version || '1.0.0',
        theme_documentation_url: 'https://antifan.f1genz.dev/docs',
        theme_support_url: 'https://antifan.f1genz.dev/support',
      },
      {
        name: 'Colors & Branding',
        settings: [
          {
            type: 'color',
            id: 'color_primary',
            label: 'Màu chủ đạo (Primary Color)',
            default: '#005baa',
          },
          {
            type: 'color',
            id: 'color_secondary',
            label: 'Màu phụ trợ (Secondary Color)',
            default: '#ff6600',
          },
          {
            type: 'color',
            id: 'color_text',
            label: 'Màu chữ chính (Text Color)',
            default: '#22343e',
          },
          {
            type: 'color',
            id: 'color_bg',
            label: 'Màu nền trang (Background Color)',
            default: '#ffffff',
          },
        ],
      },
      {
        name: 'Header & Contact Information',
        settings: [
          {
            type: 'image_picker',
            id: 'logo',
            label: 'Logo chính',
          },
          {
            type: 'image_picker',
            id: 'favicon',
            label: 'Favicon',
          },
          {
            type: 'text',
            id: 'theme_title',
            label: 'Tiêu đề storefront',
            default: themeName,
          },
          {
            type: 'text',
            id: 'hotline',
            label: 'Hotline hỗ trợ',
            default: supportHotline,
          },
          {
            type: 'text',
            id: 'email',
            label: 'Email liên hệ',
            default: supportEmail,
          },
        ],
      },
    ];

    if (options?.customGroups && options.customGroups.length > 0) {
      schema.push(...options.customGroups);
    }

    return JSON.stringify(schema, null, 2);
  }

  /**
   * Generates dynamic config/settings_schema.json from ComponentContractIR and scanned settings.
   */
  public generateThemeSettingsSchemaFromIR(
    ir: ComponentContractIR,
    options?: HaravanSettingsSchemaOptions,
    additionalSettingIds: Set<string> = new Set()
  ): string {
    const groups = this.buildThemeSettingsGroupsFromIR(ir, options, additionalSettingIds);
    return JSON.stringify(groups, null, 2);
  }

  /**
   * Builds the complete array of HaravanThemeSettingsGroup from IR and additional settings.
   */
  public buildThemeSettingsGroupsFromIR(
    ir: ComponentContractIR,
    options?: HaravanSettingsSchemaOptions,
    additionalSettingIds: Set<string> = new Set()
  ): HaravanThemeSettingsGroup[] {
    const siteSettings = ir.normalizedData?.siteSettings;
    const themeName =
      options?.themeName ||
      (typeof siteSettings?.title === 'string' && siteSettings.title) ||
      'Storefront Pro';
    const hotline =
      options?.hotline ||
      (typeof siteSettings?.hotline === 'string' && siteSettings.hotline) ||
      '';
    const email =
      options?.email ||
      (typeof siteSettings?.email === 'string' && siteSettings.email) ||
      '';

    const usedIds = new Set<string>();

    // 1. theme_info group
    const groups: HaravanThemeSettingsGroup[] = [
      {
        name: 'theme_info',
        theme_name: themeName,
        theme_author: options?.author || 'AntiFan Theme Engineering',
        theme_version: options?.version || '1.0.0',
        theme_documentation_url: 'https://antifan.f1genz.dev/docs',
        theme_support_url: 'https://antifan.f1genz.dev/support',
      },
    ];

    // 2. Colors group
    const dynamicColors: Record<string, string> = {
      color_primary: '#005baa',
      color_secondary: '#ff6600',
      color_text: '#22343e',
      color_bg: '#ffffff',
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
        const varMatches = styleBlock.matchAll(
          /--([a-zA-Z0-9_-]*(?:color|brand|primary|secondary|accent|bg|text)[a-zA-Z0-9_-]*)\s*:\s*([^;]+);/gi
        );
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

    const colorSettings: HaravanSchemaSetting[] = Object.entries(dynamicColors).map(
      ([id, hex]) => {
        usedIds.add(id);
        return {
          type: 'color',
          id,
          label: this.formatSettingLabel(id),
          default: hex,
        };
      }
    );

    groups.push({
      name: 'Colors & Branding',
      settings: colorSettings,
    });

    // 2b. Declared theme settings from IR (non-color), honoring the authored type/label/default.
    // Both settings modes MUST resolve the same declared ids; a declared setting is never
    // dropped and never re-typed from an id substring.
    const declaredSettings: HaravanSchemaSetting[] = [];
    if (ir.themeSettings && Array.isArray(ir.themeSettings)) {
      for (const ts of ir.themeSettings) {
        if (ts.type === 'color') continue; // emitted by the Colors & Branding group
        const cleanId = sanitizeSettingId(ts.id, 'setting');
        if (usedIds.has(cleanId) || usedIds.has(ts.id)) continue;
        const sanitized = sanitizeSettingType(ts.type);
        declaredSettings.push({
          ...sanitized.transformedProps,
          type: sanitized.type,
          id: cleanId,
          label: ts.label || this.formatSettingLabel(cleanId),
          default:
            ts.default !== undefined
              ? (ts.default as HaravanSchemaSetting['default'])
              : (sanitized.transformedProps?.default as HaravanSchemaSetting['default']) ?? '',
        });
        usedIds.add(cleanId);
        usedIds.add(ts.id);
      }
    }

    if (declaredSettings.length > 0) {
      groups.push({
        name: 'Declared Theme Settings',
        settings: declaredSettings,
      });
    }

    // 3. Header & Contact group
    const infoSettings: HaravanSchemaSetting[] = [
      {
        type: 'image_picker',
        id: 'logo',
        label: 'Main Logo',
      },
      {
        type: 'image_picker',
        id: 'favicon',
        label: 'Favicon',
      },
      {
        type: 'text',
        id: 'theme_title',
        label: 'Store Title',
        default: themeName,
      },
      {
        type: 'text',
        id: 'hotline',
        label: 'Support Hotline',
        default: hotline,
      },
      {
        type: 'text',
        id: 'email',
        label: 'Contact Email',
        default: email,
      },
    ];

    for (const s of infoSettings) {
      if (s.id) usedIds.add(s.id);
    }

    groups.push({
      name: 'Header & Contact Information',
      settings: infoSettings,
    });

    // 4. Section groups from IR
    if (ir.sections && Array.isArray(ir.sections)) {
      for (const sec of ir.sections) {
        const secId = sanitizeSettingId(sec.id, 'sec');
        const isHeaderOrFooter = sec.archetype === 'header' || sec.archetype === 'footer';
        const sectionSettings: HaravanSchemaSetting[] = [];

        // Visibility checkbox for optional sections
        if (!isHeaderOrFooter) {
          const enabledId = `${secId}_enabled`;
          if (!usedIds.has(enabledId)) {
            sectionSettings.push({
              type: 'checkbox',
              id: enabledId,
              label: `Hiển thị ${sec.name || sec.id}`,
              default: true,
            });
            usedIds.add(enabledId);
          }
        }

        // Section heading setting
        if (sec.heading || sec.name) {
          const headingId = `${secId}_heading`;
          if (!usedIds.has(headingId)) {
            sectionSettings.push({
              type: 'text',
              id: headingId,
              label: `Tiêu đề ${sec.name || sec.id}`,
              default: sec.heading || sec.name || '',
            });
            usedIds.add(headingId);
          }
        }

        // Section schema settings
        if (sec.schemaSettings && Array.isArray(sec.schemaSettings)) {
          for (const s of sec.schemaSettings) {
            const rawId = s.id || '';
            const mappedId = rawId.startsWith(secId + '_') ? rawId : `${secId}_${rawId}`;
            const cleanId = sanitizeSettingId(mappedId, 'setting');
            if (!usedIds.has(cleanId)) {
              const sanitized = sanitizeSettingType(s.type);
              sectionSettings.push({
                type: sanitized.type,
                id: cleanId,
                label: s.label || this.formatSettingLabel(cleanId),
                default:
                  s.default !== undefined
                    ? (s.default as HaravanSchemaSetting['default'])
                    : sanitized.transformedProps?.default || '',
              });
              usedIds.add(cleanId);
            }
          }
        }

        // Section key-value settings
        if (sec.settings && typeof sec.settings === 'object') {
          for (const [k, v] of Object.entries(sec.settings)) {
            const mappedId = k.startsWith(secId + '_') ? k : `${secId}_${k}`;
            const cleanId = sanitizeSettingId(mappedId, 'setting');
            if (!usedIds.has(cleanId)) {
              const inferredType: HaravanSchemaInputType =
                typeof v === 'boolean' ? 'checkbox' : typeof v === 'number' ? 'number' : 'text';
              sectionSettings.push({
                type: inferredType,
                id: cleanId,
                label: this.formatSettingLabel(cleanId),
                default: v as HaravanSchemaSetting['default'],
              });
              usedIds.add(cleanId);
            }
          }
        }

        if (sectionSettings.length > 0) {
          groups.push({
            name: sec.name || `Section ${sec.id}`,
            settings: sectionSettings,
          });
        }
      }
    }

    // 5. Additional settings read by Liquid
    const remainingSettings: HaravanSchemaSetting[] = [];
    for (const rawId of additionalSettingIds) {
      const cleanId = sanitizeSettingId(rawId, 'setting');
      if (!usedIds.has(cleanId) && !usedIds.has(rawId)) {
        let type: HaravanSchemaInputType = 'text';
        let def: string | boolean = '';

        if (cleanId.includes('enable') || cleanId.includes('show') || cleanId.includes('active')) {
          type = 'checkbox';
          def = true;
        } else if (cleanId.includes('color')) {
          type = 'color';
          def = '#005baa';
        } else if (
          cleanId.includes('image') ||
          cleanId.includes('logo') ||
          cleanId.includes('img')
        ) {
          type = 'image_picker';
          def = '';
        }

        remainingSettings.push({
          type,
          id: cleanId,
          label: this.formatSettingLabel(cleanId),
          default: def,
        });
        usedIds.add(cleanId);
        usedIds.add(rawId);
      }
    }

    if (remainingSettings.length > 0) {
      groups.push({
        name: 'Cấu hình bổ sung (Additional Storefront Settings)',
        settings: remainingSettings,
      });
    }

    if (options?.customGroups && options.customGroups.length > 0) {
      groups.push(...options.customGroups);
    }

    return groups;
  }

  private formatSettingLabel(id: string): string {
    return id
      .replace(/^[a-z]+_/i, '')
      .split('_')
      .filter((s) => s.length > 0)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
}
