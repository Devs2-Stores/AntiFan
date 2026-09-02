/**
 * Generator: Haravan Schema Generator
 * Generates config/settings_schema.json for Haravan theme editor customizer
 */

export class HaravanSchemaGenerator {
  public generateSettingsSchema(): string {
    const schema = [
      {
        name: 'theme_info',
        theme_name: 'Hop Long Tech Pro',
        theme_author: 'AntiFan Theme Engineering',
        theme_version: '1.0.0'
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
            default: '1900.6536'
          },
          {
            type: 'text',
            id: 'email',
            label: 'Contact Email',
            default: 'info@hoplong.com'
          }
        ]
      }
    ];

    return JSON.stringify(schema, null, 2);
  }
}
