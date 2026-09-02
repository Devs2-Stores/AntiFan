/**
 * Generator: Haravan Snippet Generator
 * Generates modular, reusable Liquid snippets and clean inline SVG icon components
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SnippetDefinition {
  name: string;
  liquidTemplate: string;
}

export class HaravanSnippetGenerator {
  public generateSnippets(snippetsDir: string): string[] {
    fs.mkdirSync(snippetsDir, { recursive: true });
    const writtenFiles: string[] = [];

    const snippets: SnippetDefinition[] = [
      {
        name: 'product-card',
        liquidTemplate: `
<div class="product-card" data-product-id="{{ product.id }}">
  <div class="product-card__image">
    <a href="{{ product.url }}">
      {% if product.featured_image != blank %}
        <img src="{{ product.featured_image | img_url: 'medium' }}" alt="{{ product.title | escape }}" loading="lazy">
      {% else %}
        <div class="placeholder-image"></div>
      {% endif %}
    </a>
  </div>
  <div class="product-card__info">
    <h3 class="product-title"><a href="{{ product.url }}">{{ product.title }}</a></h3>
    <div class="product-price">
      {% if product.price > 0 %}
        <span class="price-current">{{ product.price | money }}</span>
        {% if product.compare_at_price > product.price %}
          <span class="price-compare">{{ product.compare_at_price | money }}</span>
        {% endif %}
      {% else %}
        <span class="price-contact">Liên hệ</span>
      {% endif %}
    </div>
  </div>
</div>
        `.trim()
      },
      {
        name: 'category-navigation',
        liquidTemplate: `
<div class="category-navigation">
  <div class="category-navigation__title">
    <span>Danh mục sản phẩm</span>
  </div>
  <div class="category-navigation__list">
    <ul>
      {% for link in linklists.main-menu.links %}
        <li><a href="{{ link.url }}">{{ link.title }}</a></li>
      {% endfor %}
    </ul>
  </div>
</div>
        `.trim()
      },
      {
        name: 'search-bar',
        liquidTemplate: `
<div class="search-bar">
  <form action="{{ routes.search_url }}" method="get" role="search">
    <input type="search" name="q" placeholder="Tìm kiếm sản phẩm..." value="{{ search.terms | escape }}" autocomplete="off">
    <button type="submit" aria-label="Tìm kiếm">
      {% render 'icon-search' %}
    </button>
  </form>
</div>
        `.trim()
      },
      {
        name: 'icon-search',
        liquidTemplate: `
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 19L14.65 14.65M17 9C17 13.4183 13.4183 17 9 17C4.58172 17 1 13.4183 1 9C1 4.58172 4.58172 1 9 1C13.4183 1 17 4.58172 17 9Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
        `.trim()
      },
      {
        name: 'icon-hotline',
        liquidTemplate: `
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
</svg>
        `.trim()
      },
      {
        name: 'icon-cart',
        liquidTemplate: `
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
</svg>
        `.trim()
      },
      {
        name: 'icon-close',
        liquidTemplate: `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
</svg>
        `.trim()
      }
    ];

    for (const item of snippets) {
      const filePath = path.join(snippetsDir, `${item.name}.liquid`);
      fs.writeFileSync(filePath, item.liquidTemplate, 'utf-8');
      writtenFiles.push(filePath);
    }

    return writtenFiles;
  }
}
