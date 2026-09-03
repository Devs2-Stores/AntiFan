/**
 * Generator: Haravan Layout Generator
 * Compiles layout/theme.liquid with standard Haravan OS 2.0 architecture
 */

export class HaravanLayoutGenerator {
  public generateThemeLiquid(): string {
    return `
<!doctype html>
<html class="no-js" lang="{{ request.locale.iso_code }}">
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

    {{ content_for_header }}
  </head>

  <body class="template-{{ template | replace: '.', ' ' | truncatewords: 1, '' | handle }}">
    {% section 'header' %}

    <main id="MainContent" class="content-for-layout focus-none" role="main" tabindex="-1">
      {{ content_for_layout }}
    </main>

    {% section 'footer' %}

    <script src="{{ 'theme.js' | asset_url }}" defer></script>
  </body>
</html>
    `.trim();
  }
}
