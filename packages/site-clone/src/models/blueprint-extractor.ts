/**
 * Model 1: Blueprint Extractor
 * Token-tree DOM parser, strict Liquid escaping, and polymorphic block extraction
 * Supports hybrid image handling (local image_picker + external image_url fallback)
 */

import { DomTreeParser, ParsedElementNode } from './dom-tree-parser.js';

export interface BlockSchemaSettingDefinition {
  type: string;
  id: string;
  label: string;
  default?: unknown;
}

export interface BlockDefinition {
  type: string;
  name: string;
  settings: BlockSchemaSettingDefinition[];
}

export interface BlockInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
}

export interface ExtractedSectionBlueprint {
  id: string;
  type: string;
  name: string;
  tagName: string;
  className: string;
  heading?: string;
  rawHtml: string;
  liquidTemplate: string;
  schemaSettings: Array<{
    type: string;
    id: string;
    label: string;
    default?: unknown;
  }>;
  blockDefinitions: BlockDefinition[];
  blockInstances: BlockInstance[];
}

export class BlueprintExtractor {
  private usedIds = new Set<string>();

  public extractSections(html: string): ExtractedSectionBlueprint[] {
    this.usedIds.clear();
    const sections: ExtractedSectionBlueprint[] = [];
    const root = DomTreeParser.parse(html);

    // 1. Extract <header>
    const headerNodes = DomTreeParser.findByTag(root, 'header');
    if (headerNodes.length > 0) {
      const hNode = headerNodes[0];
      const rawClass = hNode.attributes['class'] || 'site-header';
      const rawId = hNode.attributes['id'] || 'site_header';
      const cleanId = this.sanitizeAndDedupeId(rawId, 'header');
      const cleanClass = this.sanitizeClassName(rawClass);

      sections.push({
        id: cleanId,
        type: 'header',
        name: 'Site Header',
        tagName: 'header',
        className: cleanClass,
        rawHtml: hNode.outerHtml,
        liquidTemplate: this.generateHeaderLiquid(),
        schemaSettings: [
          { type: 'image_picker', id: 'logo', label: 'Logo Image' },
          { type: 'text', id: 'logo_url', label: 'External Logo URL' },
          { type: 'link_list', id: 'main_menu', label: 'Main Navigation Menu' },
          { type: 'text', id: 'hotline', label: 'Support Hotline', default: '1900.6536' }
        ],
        blockDefinitions: [],
        blockInstances: []
      });
    }

    // 2. Extract all <section> elements (including nested sections)
    const sectionNodes = DomTreeParser.findByTag(root, 'section');
    let secIndex = 1;

    for (const secNode of sectionNodes) {
      const rawClass = secNode.attributes['class'] || `section-${secIndex}`;
      const cleanClass = this.sanitizeClassName(rawClass);
      const rawId = secNode.attributes['id'] || `section_${cleanClass}_${secIndex}`;
      const cleanId = this.sanitizeAndDedupeId(rawId, `section_${secIndex}`);

      const headingText = this.extractHeadingFromNode(secNode);
      const sectionType = this.classifySectionType(cleanClass, secNode);
      const blueprintName = headingText || this.formatSectionName(cleanClass);
      const { blockDefinitions, blockInstances } = this.extractBlocksFromNode(sectionType, secNode);

      sections.push({
        id: cleanId,
        type: sectionType,
        name: blueprintName,
        tagName: 'section',
        className: cleanClass,
        heading: headingText,
        rawHtml: secNode.outerHtml,
        liquidTemplate: this.generateSectionLiquid(sectionType, cleanClass, headingText),
        schemaSettings: this.deriveSchemaSettings(sectionType, headingText),
        blockDefinitions,
        blockInstances
      });

      secIndex++;
    }

    // 3. Extract <footer>
    const footerNodes = DomTreeParser.findByTag(root, 'footer');
    if (footerNodes.length > 0) {
      const fNode = footerNodes[0];
      const rawClass = fNode.attributes['class'] || 'site-footer';
      const rawId = fNode.attributes['id'] || 'site_footer';
      const cleanId = this.sanitizeAndDedupeId(rawId, 'footer');
      const cleanClass = this.sanitizeClassName(rawClass);

      sections.push({
        id: cleanId,
        type: 'footer',
        name: 'Site Footer',
        tagName: 'footer',
        className: cleanClass,
        rawHtml: fNode.outerHtml,
        liquidTemplate: this.generateFooterLiquid(),
        schemaSettings: [
          { type: 'text', id: 'company_name', label: 'Company Name', default: 'Công ty Cổ phần Công nghệ Hợp Long' },
          { type: 'textarea', id: 'address', label: 'Company Address' },
          { type: 'text', id: 'phone', label: 'Phone Number', default: '1900.6536' },
          { type: 'text', id: 'email', label: 'Support Email', default: 'info@hoplong.com' }
        ],
        blockDefinitions: [],
        blockInstances: []
      });
    }

    return sections;
  }

  /**
   * Sanitizes ID to prevent path traversal (../), special chars, and guarantees uniqueness
   */
  public sanitizeAndDedupeId(rawId: string, fallbackPrefix: string): string {
    let clean = rawId
      .replace(/[\0\r\n\t]/g, '')
      .replace(/(\.\.[\/\\])+/g, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();

    if (!clean || clean === '..' || clean === '.') {
      clean = fallbackPrefix.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    let candidate = clean;
    let counter = 1;
    while (this.usedIds.has(candidate)) {
      counter++;
      candidate = `${clean}_${counter}`;
    }

    this.usedIds.add(candidate);
    return candidate;
  }

  /**
   * Strict sanitation for CSS class names to prevent HTML/Liquid injection
   */
  public sanitizeClassName(rawClass: string): string {
    return rawClass
      .replace(/[\0\r\n\t]/g, '')
      .replace(/[{}[\]%`"'\\]/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[^a-zA-Z0-9_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractHeadingFromNode(secNode: ParsedElementNode): string {
    for (const hTag of ['h1', 'h2', 'h3', 'h4']) {
      const headings = DomTreeParser.findByTag(secNode, hTag);
      if (headings.length > 0) {
        return DomTreeParser.extractText(headings[0]);
      }
    }
    return '';
  }

  private extractBlocksFromNode(
    sectionType: string,
    secNode: ParsedElementNode
  ): { blockDefinitions: BlockDefinition[]; blockInstances: BlockInstance[] } {
    const blockDefinitions: BlockDefinition[] = [];
    const blockInstances: BlockInstance[] = [];

    if (sectionType === 'hero-slider') {
      blockDefinitions.push({
        type: 'slide_item',
        name: 'Slide Item',
        settings: [
          { type: 'image_picker', id: 'image', label: 'Slide Image' },
          { type: 'text', id: 'image_url', label: 'External Image URL' },
          { type: 'text', id: 'title', label: 'Slide Title' },
          { type: 'url', id: 'link', label: 'Slide Link' }
        ]
      });

      const items = [
        ...DomTreeParser.findByClass(secNode, 'item'),
        ...DomTreeParser.findByClass(secNode, 's-content__item')
      ];
      let idx = 1;
      for (const item of items) {
        const imgs = DomTreeParser.findByTag(item, 'img');
        const links = DomTreeParser.findByTag(item, 'a');
        const rawSrc = imgs[0]?.attributes['src'] || '';
        blockInstances.push({
          id: `slide_${idx}`,
          type: 'slide_item',
          settings: {
            image_url: rawSrc,
            title: imgs[0]?.attributes['alt'] || `Banner ${idx}`,
            link: links[0]?.attributes['href'] || '#'
          }
        });
        idx++;
      }
    } else if (sectionType === 'category-grid') {
      blockDefinitions.push({
        type: 'category_item',
        name: 'Category Item',
        settings: [
          { type: 'image_picker', id: 'icon', label: 'Category Icon' },
          { type: 'text', id: 'icon_url', label: 'External Icon URL' },
          { type: 'text', id: 'title', label: 'Category Title' },
          { type: 'url', id: 'link', label: 'Category Link' }
        ]
      });

      const items = DomTreeParser.findByClass(secNode, 'item');
      let idx = 1;
      for (const item of items) {
        const spans = DomTreeParser.findByTag(item, 'span');
        const imgs = DomTreeParser.findByTag(item, 'img');
        const links = DomTreeParser.findByTag(item, 'a');
        const title = spans.length > 0 ? DomTreeParser.extractText(spans[0]) : `Category ${idx}`;
        const rawSrc = imgs[0]?.attributes['src'] || '';
        blockInstances.push({
          id: `category_${idx}`,
          type: 'category_item',
          settings: {
            title,
            icon_url: rawSrc,
            link: links[0]?.attributes['href'] || '#'
          }
        });
        idx++;
      }
    }

    return { blockDefinitions, blockInstances };
  }

  private classifySectionType(className: string, secNode: ParsedElementNode): string {
    const c = className.toLowerCase();
    if (c.includes('slide') || c.includes('banner') || c.includes('hero')) return 'hero-slider';
    if (c.includes('category-list') || c.includes('categories')) return 'category-grid';
    if (c.includes('block-category') || c.includes('product')) return 'featured-products';
    if (c.includes('form') || c.includes('quote') || c.includes('contact')) return 'quote-form';
    if (c.includes('accessory')) return 'accessory-showcase';
    if (c.includes('partner') || c.includes('brand')) return 'partner-carousel';
    return 'custom-content';
  }

  private formatSectionName(className: string): string {
    const firstClass = className.split(/\s+/)[0] || 'custom-section';
    return firstClass
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  private generateHeaderLiquid(): string {
    return `
<header class="site-header">
  <div class="site-header__top w-100">
    <div class="container container-fuild">
      <div class="main-header flex flex-left-between w-100">
        <div class="main-header__logo">
          <a href="{{ routes.root_url }}">
            {% if section.settings.image_url != blank %}
              <img src="{{ section.settings.image_url }}" alt="{{ shop.name }}">
            {% elsif section.settings.logo != blank %}
              <img src="{{ section.settings.logo | img_url: 'master' }}" alt="{{ shop.name }}">
            {% else %}
              <span class="shop-name">{{ shop.name }}</span>
            {% endif %}
          </a>
        </div>
        <div class="main-header__search">
          {% render 'search-bar' %}
        </div>
        <div class="main-header__contact flex">
          <div class="hotline">
            <span>Hotline:</span>
            <strong>{{ section.settings.hotline }}</strong>
          </div>
        </div>
      </div>
    </div>
  </div>
</header>
    `.trim();
  }

  private generateSectionLiquid(type: string, className: string, heading: string): string {
    if (type === 'hero-slider') {
      return `
<section class="${className}">
  <div class="container container-fuild">
    <div class="slide-content flex flex-left-between">
      {% render 'category-navigation' %}
      <div class="slide-content__detail">
        <div class="s-content flex">
          {% for block in section.blocks %}
            {% assign slide_src = block.settings.image_url | default: (block.settings.image | img_url: 'master') %}
            <div class="s-content__item" {{ block.haravan_attributes }}>
              <a href="{{ block.settings.link }}">
                {% if slide_src != blank %}
                  <img src="{{ slide_src }}" alt="{{ block.settings.title | escape }}" loading="lazy">
                {% endif %}
              </a>
            </div>
          {% endfor %}
        </div>
      </div>
    </div>
  </div>
</section>
      `.trim();
    }

    if (type === 'featured-products') {
      return `
<section class="${className}">
  <div class="container container-fuild">
    <div class="block-category__header flex flex-left-between">
      <h2 class="title">{{ section.settings.heading | default: '${heading || "Sản Phẩm Nổi Bật"}' }}</h2>
      <a href="{{ section.settings.view_all_link }}" class="view-more">Xem thêm</a>
    </div>
    <div class="product-grid flex">
      {% for product in collections[section.settings.collection].products limit: section.settings.limit %}
        {% render 'product-card', product: product %}
      {% endfor %}
    </div>
  </div>
</section>
      `.trim();
    }

    if (type === 'quote-form') {
      return `
<section class="${className}">
  <div class="container container-fuild">
    <div class="home-form__wrapper">
      <h2 class="form-title">{{ section.settings.heading | default: '${heading || "Nhận Báo Giá Nhanh"}' }}</h2>
      <form action="/contact" method="post" id="quote-form">
        <input type="text" name="contact[name]" placeholder="Họ và tên *" required>
        <input type="tel" name="contact[phone]" placeholder="Số điện thoại *" required>
        <input type="email" name="contact[email]" placeholder="Email">
        <textarea name="contact[body]" placeholder="Nội dung yêu cầu báo giá"></textarea>
        <button type="submit" class="btn btn-primary">Gửi Yêu Cầu</button>
      </form>
    </div>
  </div>
</section>
      `.trim();
    }

    return `
<section class="${className}" id="{{ section.id }}">
  <div class="container container-fuild">
    {% if section.settings.heading != blank %}
      <h2 class="section-title">{{ section.settings.heading }}</h2>
    {% endif %}
    <div class="section-content">
      {% for block in section.blocks %}
        <div class="section-block" {{ block.haravan_attributes }}>
          {{ block.settings.content }}
        </div>
      {% endfor %}
    </div>
  </div>
</section>
    `.trim();
  }

  private generateFooterLiquid(): string {
    return `
<footer class="site-footer">
  <div class="container container-fuild">
    <div class="site-footer__top flex">
      <div class="footer-col col-info">
        <h3>{{ section.settings.company_name }}</h3>
        <p class="address">{{ section.settings.address }}</p>
        <p class="hotline">Hotline: {{ section.settings.phone }}</p>
        <p class="email">Email: {{ section.settings.email }}</p>
      </div>
      <div class="footer-col col-links">
        <h4>Liên kết nhanh</h4>
        <ul>
          {% for link in linklists.footer.links %}
            <li><a href="{{ link.url }}">{{ link.title }}</a></li>
          {% endfor %}
        </ul>
      </div>
    </div>
  </div>
</footer>
    `.trim();
  }

  private deriveSchemaSettings(type: string, heading: string): Array<{ type: string; id: string; label: string; default?: unknown }> {
    const settings: Array<{ type: string; id: string; label: string; default?: unknown }> = [
      { type: 'text', id: 'heading', label: 'Section Heading', default: heading || 'Tiêu Đề Section' }
    ];

    if (type === 'hero-slider') {
      settings.push({ type: 'checkbox', id: 'autoplay', label: 'Autoplay Slider', default: true });
      settings.push({ type: 'range', id: 'interval', label: 'Interval (seconds)', default: 5 });
    } else if (type === 'featured-products') {
      settings.push({ type: 'collection', id: 'collection', label: 'Featured Collection' });
      settings.push({ type: 'range', id: 'limit', label: 'Number of Products', default: 8 });
      settings.push({ type: 'url', id: 'view_all_link', label: 'View All URL' });
    }

    return settings;
  }
}
