/**
 * Generator: Haravan Layout Generator
 * Compiles layout/theme.liquid with standard flat Haravan architecture
 */

export interface HaravanLayoutOptions {
  stylesheets?: string[];
  scripts?: string[];
  htmlAttributes?: string;
  bodyAttributes?: string;
  mainClass?: string;
  mainAttributes?: string;
  includeHeader?: boolean;
  includeFooter?: boolean;
  headerSnippet?: string;
  footerSnippet?: string;
  bottomNavigationSnippet?: string;
}

export class HaravanLayoutGenerator {
  public generateThemeLiquid(options?: HaravanLayoutOptions): string {
    const additionalStylesheets = (options?.stylesheets || [])
      .filter(s => s !== 'theme.css' && s !== 'custom.css')
      .map(s => `    {{ '${s}' | asset_url | stylesheet_tag }}`)
      .join('\n');

    const additionalScripts = (options?.scripts || [])
      .filter(s => s !== 'theme.js')
      .map(s => `    {{ '${s}' | asset_url | script_tag }}`)
      .join('\n');

    const rawHtmlAttrs = (options?.htmlAttributes || '').trim();
    const htmlAttrs = rawHtmlAttrs ? ` ${rawHtmlAttrs}` : ' class="no-js" lang="vi"';

    const rawBodyAttrs = (options?.bodyAttributes || '').trim();
    const defaultBodyClass = "template-{{ template | replace: '.', ' ' | truncatewords: 1, '' | handle }}";
    let bodyAttrs = '';
    if (rawBodyAttrs) {
      if (/\bclass=["']([^"']*)["']/i.test(rawBodyAttrs)) {
        bodyAttrs = ' ' + rawBodyAttrs.replace(/\bclass=["']([^"']*)["']/i, `class="${defaultBodyClass} $1"`);
      } else {
        bodyAttrs = ` class="${defaultBodyClass}" ${rawBodyAttrs}`;
      }
    } else {
      bodyAttrs = ` class="${defaultBodyClass}"`;
    }

    const mainClass = options?.mainClass || 'content-for-layout focus-none';
    const mainAttrs = options?.mainAttributes ? ` ${options.mainAttributes.trim()}` : '';

    const includeHeader = options?.includeHeader !== false;
    const includeFooter = options?.includeFooter !== false;
    const headerSnippet = options?.headerSnippet || 'header';
    const footerSnippet = options?.footerSnippet || 'footer';
    const bottomNavSnippet = options?.bottomNavigationSnippet;

    const headerLiquid = includeHeader ? `    {% include '${headerSnippet}' %}\n` : '';
    const footerLiquid = includeFooter ? `\n    {% include '${footerSnippet}' %}` : '';
    const bottomNavLiquid = bottomNavSnippet ? `\n    {% include '${bottomNavSnippet}' %}` : '';
    return `
<!doctype html>
<html${htmlAttrs}>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="{{ settings.color_primary | default: '#005baa' }}">
    <link rel="canonical" href="{{ canonical_url }}">

    {%- if settings.favicon != blank -%}
      <link rel="icon" type="image/png" href="{{ settings.favicon | img_url: '32x32' }}">
    {%- endif -%}

    <title>
      {{ page_title }}
      {%- if current_tags %} &ndash; tagged "{{ current_tags | join: ', ' }}"{% endif -%}
      {%- if current_page != 1 %} &ndash; Page {{ current_page }}{% endif -%}
      {%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}
    </title>

    {% if page_description %}
      <meta name="description" content="{{ page_description | escape }}">
    {% endif %}

    {{ 'theme.css' | asset_url | stylesheet_tag }}
    {{ 'custom.css' | asset_url | stylesheet_tag }}
${additionalStylesheets ? additionalStylesheets + '\n' : ''}

    {{ content_for_header }}
  </head>
  <body${bodyAttrs}>
${headerLiquid}    <main id="MainContent" class="${mainClass}" role="main" tabindex="-1"${mainAttrs}>
      {{ content_for_layout }}
    </main>${footerLiquid}${bottomNavLiquid}

${additionalScripts ? additionalScripts + '\n' : ''}    <script src="{{ 'theme.js' | asset_url }}" defer></script>
  </body>
</html>
    `.trim();
  }
}
