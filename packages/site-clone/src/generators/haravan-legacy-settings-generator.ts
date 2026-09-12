/**
 * Haravan Legacy Settings Generator
 *
 * Generates pure HTML config/settings.html for the Haravan Admin theme customizer.
 * Invariants:
 *  - 100% pure HTML, zero Liquid tags (no {{ }}, no {% %})
 *  - Compact single-line <tr> layout inside <table> inside <fieldset>
 *  - Nested fieldsets wrapped in <div class="ml-5"> (Haravan strips class on fieldset)
 *  - Special input classes:
 *      class="color" for color pickers
 *      class="linklist" for navigation menus
 *      class="collection" for collections
 *      class="blog" for blogs
 *      class="page" for static pages
 *  - File upload inputs carry target file extension in name attribute: <input type="file" name="logo.png">
 *  - Explicit visibility checkbox per optional section or group
 *  - Strict escaping of attribute values and text content
 */

import type { ComponentContractIR, ThemeSettingContract } from '../models/clone-ir.js';
import { sanitizeSettingId, normalizeHexColor } from './haravan-schema-generator.js';

export interface LegacySettingField {
  id: string;
  type: string;
  label: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  info?: string;
}

export interface LegacySettingGroup {
  name: string;
  isOptional?: boolean;
  enabledSettingId?: string;
  enabledDefault?: boolean;
  fields: LegacySettingField[];
  nestedGroups?: LegacySettingGroup[];
}

/**
 * Legacy settings.html control class per authored IR setting type.
 * Haravan's legacy customizer documents control classes for color / linklist /
 * collection / blog / page / file uploads; a font picker has no documented legacy
 * control, so it degrades to an editable text input rather than being dropped.
 */
const LEGACY_CONTROL_TYPE_BY_DECLARED_TYPE: Record<string, string> = {
  color: 'color',
  image_picker: 'file',
  text: 'text',
  textarea: 'textarea',
  range: 'range',
  font_picker: 'text',
  link_list: 'linklist',
};

export function escapeHtmlAttribute(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeHtmlText(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class HaravanLegacySettingsGenerator {
  /**
   * Generates the complete config/settings.html document string from structured groups.
   */
  public generateSettingsHtml(groups: LegacySettingGroup[]): string {
    const lines: string[] = [];

    for (const group of groups) {
      lines.push(this.renderGroup(group, 0));
    }

    return lines.join('\n\n').trim() + '\n';
  }

  /**
   * Builds groups from ComponentContractIR and any additional settings detected in Liquid.
   */
  public buildGroupsFromIR(
    ir: ComponentContractIR,
    additionalSettingIds: Set<string> = new Set()
  ): LegacySettingGroup[] {
    const groups: LegacySettingGroup[] = [];
    const usedIds = new Set<string>();

    // 1. Colors & Branding group
    const colorFields: LegacySettingField[] = [];
    const baseColors: Array<{ id: string; label: string; default: string }> = [
      { id: 'color_primary', label: 'Màu chủ đạo (Primary Color)', default: '#005baa' },
      { id: 'color_secondary', label: 'Màu phụ trợ (Secondary Color)', default: '#ff6600' },
      { id: 'color_text', label: 'Màu chữ chính (Text Color)', default: '#22343e' },
      { id: 'color_bg', label: 'Màu nền trang (Background Color)', default: '#ffffff' },
    ];

    for (const c of baseColors) {
      colorFields.push({
        id: c.id,
        type: 'color',
        label: c.label,
        default: c.default,
      });
      usedIds.add(c.id);
    }

    // Add extra colors from IR themeSettings or headStyles
    if (ir.themeSettings && Array.isArray(ir.themeSettings)) {
      for (const ts of ir.themeSettings) {
        if (ts.type === 'color' && !usedIds.has(ts.id)) {
          const norm = typeof ts.default === 'string' ? normalizeHexColor(ts.default) : null;
          colorFields.push({
            id: sanitizeSettingId(ts.id, 'color'),
            type: 'color',
            label: ts.label || `Màu ${ts.id}`,
            default: norm || '#005baa',
          });
          usedIds.add(ts.id);
        }
      }
    }

    groups.push({
      name: 'Màu sắc & Giao diện (Colors & Branding)',
      isOptional: false,
      fields: colorFields,
    });

    // 2. Site Information group (Header & Contact)
    const siteSettings = ir.normalizedData?.siteSettings;
    const infoFields: LegacySettingField[] = [
      {
        id: 'logo.png',
        type: 'file',
        label: 'Logo cửa hàng (logo.png)',
        default: '',
      },
      {
        id: 'favicon.png',
        type: 'file',
        label: 'Favicon cửa hàng (favicon.png)',
        default: '',
      },
      {
        id: 'theme_title',
        type: 'text',
        label: 'Tiêu đề storefront (Store Title)',
        default: (typeof siteSettings?.title === 'string' && siteSettings.title) || 'Storefront Pro',
      },
      {
        id: 'hotline',
        type: 'text',
        label: 'Hotline hỗ trợ (Support Hotline)',
        default: (typeof siteSettings?.hotline === 'string' && siteSettings.hotline) || '',
      },
      {
        id: 'email',
        type: 'text',
        label: 'Email liên hệ (Support Email)',
        default: (typeof siteSettings?.email === 'string' && siteSettings.email) || '',
      },
    ];

    for (const f of infoFields) {
      usedIds.add(f.id);
      usedIds.add(f.id.replace(/\.[^.]+$/, ''));
    }

    groups.push({
      name: 'Thông tin Cửa hàng (Header & Contact Info)',
      isOptional: false,
      fields: infoFields,
    });

    // 3. Declared theme settings from IR (non-color), honoring the authored type/label/default.
    // A declared setting MUST NOT be re-typed from its id substring, and MUST NOT be dropped.
    const declaredFields: LegacySettingField[] = [];
    if (ir.themeSettings && Array.isArray(ir.themeSettings)) {
      for (const ts of ir.themeSettings) {
        if (ts.type === 'color') continue; // emitted by the Colors & Branding group
        const cleanId = sanitizeSettingId(ts.id, 'setting');
        if (usedIds.has(cleanId) || usedIds.has(ts.id)) continue;
        declaredFields.push({
          id: cleanId,
          type: LEGACY_CONTROL_TYPE_BY_DECLARED_TYPE[ts.type] || 'text',
          label: ts.label || `Thiết lập ${cleanId}`,
          default:
            ts.default === undefined
              ? ''
              : typeof ts.default === 'boolean' || typeof ts.default === 'number'
                ? ts.default
                : String(ts.default),
        });
        usedIds.add(cleanId);
        usedIds.add(ts.id);
      }
    }

    if (declaredFields.length > 0) {
      groups.push({
        name: 'Thiết lập chung (Declared Theme Settings)',
        isOptional: false,
        fields: declaredFields,
      });
    }

    // 4. Sections groups from IR
    if (ir.sections && Array.isArray(ir.sections)) {
      for (const sec of ir.sections) {
        const secId = sanitizeSettingId(sec.id, 'sec');
        const isHeaderOrFooter = sec.archetype === 'header' || sec.archetype === 'footer';
        const enabledId = `${secId}_enabled`;
        const sectionFields: LegacySettingField[] = [];

        // Track visibility setting
        if (!isHeaderOrFooter) {
          usedIds.add(enabledId);
        }

        // Add heading setting if section has heading
        if (sec.heading || sec.name) {
          const headingId = `${secId}_heading`;
          if (!usedIds.has(headingId)) {
            sectionFields.push({
              id: headingId,
              type: 'text',
              label: `Tiêu đề ${sec.name || sec.id}`,
              default: sec.heading || sec.name || '',
            });
            usedIds.add(headingId);
          }
        }

        // Add schemaSettings if defined
        if (sec.schemaSettings && Array.isArray(sec.schemaSettings)) {
          for (const s of sec.schemaSettings) {
            const rawId = s.id || '';
            const mappedId = rawId.startsWith(secId + '_') ? rawId : `${secId}_${rawId}`;
            const cleanId = sanitizeSettingId(mappedId, 'setting');
            if (!usedIds.has(cleanId)) {
              sectionFields.push({
                id: cleanId,
                type: s.type || 'text',
                label: s.label || `Cấu hình ${cleanId}`,
                default: s.default !== undefined ? String(s.default) : '',
              });
              usedIds.add(cleanId);
            }
          }
        }

        // Add key-value settings from sec.settings
        if (sec.settings && typeof sec.settings === 'object') {
          for (const [key, val] of Object.entries(sec.settings)) {
            const mappedId = key.startsWith(secId + '_') ? key : `${secId}_${key}`;
            const cleanId = sanitizeSettingId(mappedId, 'setting');
            if (!usedIds.has(cleanId)) {
              const inferredType = typeof val === 'boolean' ? 'checkbox' : 'text';
              sectionFields.push({
                id: cleanId,
                type: inferredType,
                label: `Cấu hình ${cleanId}`,
                default: val !== undefined ? (typeof val === 'boolean' ? val : String(val)) : '',
              });
              usedIds.add(cleanId);
            }
          }
        }

        groups.push({
          name: sec.name || `Section ${sec.id}`,
          isOptional: !isHeaderOrFooter,
          enabledSettingId: !isHeaderOrFooter ? enabledId : undefined,
          enabledDefault: true,
          fields: sectionFields,
        });
      }
    }

    // 5. Any remaining settings read by generated Liquid
    const remainingFields: LegacySettingField[] = [];
    for (const rawId of additionalSettingIds) {
      const cleanId = sanitizeSettingId(rawId, 'setting');
      if (!usedIds.has(cleanId) && !usedIds.has(rawId)) {
        let type = 'text';
        let def: string | boolean = '';

        if (cleanId.includes('enable') || cleanId.includes('show') || cleanId.includes('active')) {
          type = 'checkbox';
          def = true;
        } else if (cleanId.includes('color')) {
          type = 'color';
          def = '#005baa';
        } else if (cleanId.includes('image') || cleanId.includes('logo') || cleanId.includes('img')) {
          type = 'file';
          def = '';
        }

        remainingFields.push({
          id: cleanId,
          type,
          label: `Thiết lập ${cleanId}`,
          default: def,
        });
        usedIds.add(cleanId);
        usedIds.add(rawId);
      }
    }

    if (remainingFields.length > 0) {
      groups.push({
        name: 'Cấu hình bổ sung (Additional Storefront Settings)',
        isOptional: false,
        fields: remainingFields,
      });
    }

    return groups;
  }

  private renderGroup(group: LegacySettingGroup, depth: number): string {
    const lines: string[] = [];
    lines.push('<fieldset>');
    lines.push(`  <legend>${escapeHtmlText(group.name)}</legend>`);
    lines.push('  <table>');

    // Visibility checkbox for optional group
    if (group.isOptional && group.enabledSettingId) {
      const isChecked = group.enabledDefault !== false ? ' checked' : '';
      lines.push(
        `    <tr><td><strong>Bật/Tắt hiển thị (Enable)</strong></td><td><input type="checkbox" name="${escapeHtmlAttribute(group.enabledSettingId)}" value="1"${isChecked} /></td></tr>`
      );
    }

    // Fields
    for (const field of group.fields) {
      lines.push(`    ${this.renderFieldRow(field)}`);
    }

    lines.push('  </table>');

    // Nested groups wrapped in <div class="ml-5">
    if (group.nestedGroups && group.nestedGroups.length > 0) {
      lines.push('  <div class="ml-5">');
      for (const nested of group.nestedGroups) {
        lines.push(this.renderGroup(nested, depth + 1));
      }
      lines.push('  </div>');
    }

    lines.push('</fieldset>');
    return lines.join('\n');
  }

  private renderFieldRow(field: LegacySettingField): string {
    const labelHtml = `<strong>${escapeHtmlText(field.label)}</strong>`;
    const controlHtml = this.renderControl(field);
    return `<tr><td>${labelHtml}</td><td>${controlHtml}</td></tr>`;
  }

  private renderControl(field: LegacySettingField): string {
    const rawType = (field.type || 'text').toLowerCase().trim();
    const idAttr = escapeHtmlAttribute(field.id);
    const defaultVal = field.default !== undefined ? field.default : '';

    switch (rawType) {
      case 'color': {
        const hex = typeof defaultVal === 'string' ? normalizeHexColor(defaultVal) || defaultVal : '#000000';
        return `<input type="text" class="color" name="${idAttr}" value="${escapeHtmlAttribute(hex)}" />`;
      }

      case 'checkbox': {
        const checked = Boolean(defaultVal) && defaultVal !== 'false' && defaultVal !== '0' ? ' checked' : '';
        return `<input type="checkbox" name="${idAttr}" value="1"${checked} />`;
      }

      case 'linklist':
      case 'link_list':
      case 'menu': {
        return `<select class="linklist" name="${idAttr}"></select>`;
      }

      case 'collection': {
        return `<select class="collection" name="${idAttr}"></select>`;
      }

      case 'blog': {
        return `<select class="blog" name="${idAttr}"></select>`;
      }

      case 'page': {
        return `<select class="page" name="${idAttr}"></select>`;
      }

      case 'image_picker':
      case 'image':
      case 'file': {
        // File upload input: name carries target filename with extension, no value attribute!
        let fileName = field.id;
        if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(fileName)) {
          fileName = `${fileName}.png`;
        }
        return `<input type="file" name="${escapeHtmlAttribute(fileName)}" />`;
      }

      case 'textarea': {
        return `<textarea name="${idAttr}">${escapeHtmlText(defaultVal)}</textarea>`;
      }

      case 'select':
      case 'radio': {
        if (field.options && field.options.length > 0) {
          const opts = field.options
            .map((opt) => {
              const selected = String(opt.value) === String(defaultVal) ? ' selected' : '';
              return `<option value="${escapeHtmlAttribute(opt.value)}"${selected}>${escapeHtmlText(opt.label)}</option>`;
            })
            .join('');
          return `<select name="${idAttr}">${opts}</select>`;
        }
        return `<input type="text" name="${idAttr}" value="${escapeHtmlAttribute(defaultVal)}" />`;
      }

      case 'number':
      case 'range': {
        return `<input type="number" name="${idAttr}" value="${escapeHtmlAttribute(defaultVal)}" />`;
      }

      default: {
        return `<input type="text" name="${idAttr}" value="${escapeHtmlAttribute(defaultVal)}" />`;
      }
    }
  }
}
