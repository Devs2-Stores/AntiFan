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

  /** Elements that never contribute renderable storefront structure. */
  private static readonly NON_STRUCTURAL_TAGS: Record<string, true> = {
    script: true, style: true, link: true, meta: true, noscript: true, template: true, iframe: true, base: true
  };

  public extractSections(html: string): ExtractedSectionBlueprint[] {
    this.usedIds.clear();
    const sections: ExtractedSectionBlueprint[] = [];
    const root = DomTreeParser.parse(html);

    // Walk the document's top-level structural blocks in document order.
    // Pure layout containers (<main>, app root wrappers) are descended into so
    // the generator can rebuild their semantics instead of flattening the whole
    // page into one opaque block. Tag whitelists are deliberately avoided:
    // real storefronts use <div class="site-footer">, <main>, <aside>, etc.
    const body = DomTreeParser.findByTag(root, 'body')[0] || root;
    const blocks: ParsedElementNode[] = [];
    // Nested sections stay first-class blueprints (existing contract); they are
    // emitted in document order after their ancestor.
    const collectNestedSections = (node: ParsedElementNode): void => {
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (child.tag === 'section') {
          blocks.push(child);
          collectNestedSections(child);
        } else if (DomTreeParser.findByTag(child, 'section').length > 0) {
          collectNestedSections(child);
        }
      }
    };
    const collect = (node: ParsedElementNode): void => {
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (BlueprintExtractor.NON_STRUCTURAL_TAGS[child.tag]) continue;
        if (child.tag === 'section') {
          blocks.push(child);
          collectNestedSections(child);
          continue;
        }
        if (this.isLayoutContainer(child)) {
          collect(child);
          continue;
        }
        blocks.push(child);
      }
    };
    collect(body);

    let secIndex = 1;
    for (const node of blocks) {
      const rawClass = node.attributes['class'] || '';
      const cleanClass = this.sanitizeClassName(rawClass) || `section-${secIndex}`;
      const rawId = node.attributes['id'] || `section_${cleanClass.replace(/\s+/g, '_')}_${secIndex}`;
      const cleanId = this.sanitizeAndDedupeId(rawId, `section_${secIndex}`);
      const role = this.classifyTopLevelRole(node, rawClass);

      if (role === 'header') {
        sections.push({
          id: cleanId,
          type: 'header',
          name: 'Site Header',
          tagName: node.tag,
          className: cleanClass,
          rawHtml: node.outerHtml,
          liquidTemplate: this.generateHeaderLiquid(),
          schemaSettings: [
            { type: 'image_picker', id: 'logo', label: 'Logo Image' },
            { type: 'text', id: 'logo_url', label: 'External Logo URL' },
            { type: 'link_list', id: 'main_menu', label: 'Main Navigation Menu' },
            { type: 'text', id: 'hotline', label: 'Support Hotline', default: '' }
          ],
          blockDefinitions: [],
          blockInstances: []
        });
        continue;
      }

      if (role === 'footer') {
        sections.push({
          id: cleanId,
          type: 'footer',
          name: 'Site Footer',
          tagName: node.tag,
          className: cleanClass,
          rawHtml: node.outerHtml,
          liquidTemplate: this.generateFooterLiquid(),
          schemaSettings: [
            { type: 'text', id: 'company_name', label: 'Company Name', default: 'Cửa hàng trực tuyến' },
            { type: 'textarea', id: 'address', label: 'Company Address' },
            { type: 'text', id: 'phone', label: 'Phone Number', default: '' },
            { type: 'text', id: 'email', label: 'Support Email', default: '' }
          ],
          blockDefinitions: [],
          blockInstances: []
        });
        continue;
      }

      const headingText = this.extractHeadingFromNode(node);
      const sectionType = this.classifySectionType(cleanClass, node);
      const blueprintName = headingText || this.formatSectionName(cleanClass);
      const { blockDefinitions, blockInstances } = this.extractBlocksFromNode(sectionType, node);

      sections.push({
        id: cleanId,
        type: sectionType,
        name: blueprintName,
        tagName: node.tag,
        className: cleanClass,
        heading: headingText,
        rawHtml: node.outerHtml,
        liquidTemplate: this.generateSectionLiquid(sectionType, cleanClass, headingText),
        schemaSettings: this.deriveSchemaSettings(sectionType, headingText),
        blockDefinitions,
        blockInstances
      });

      secIndex++;
    }

    return sections;
  }

  /**
   * A layout container carries no storefront content of its own: it only
   * positions the structural blocks inside it. Descending keeps the source's
   * semantic wrappers while avoiding one opaque mega-block.
   */
  private isLayoutContainer(node: ParsedElementNode): boolean {
    if (node.tag === 'main' || node.tag === 'body') return true;
    if (node.tag !== 'div') return false;
    if (DomTreeParser.findByTag(node, 'section').length === 0) return false;
    if (node.children.some((child) => typeof child === 'string' && child.trim().length > 0)) return false;
    return !/(^|\s)(?:site-)?(?:header|footer)($|\s)/i.test(node.attributes['class'] || '');
  }

  private classifyTopLevelRole(node: ParsedElementNode, className: string): 'header' | 'footer' | null {
    if (node.tag === 'header' || /(^|\s)(?:site-)?header($|\s)/i.test(className)) return 'header';
    if (node.tag === 'footer' || /(^|\s)(?:site-)?(?:header|footer)($|\s)/i.test(className)) return 'footer';
    return null;
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
        ...DomTreeParser.findByClass(secNode, 's-content__item'),
        ...DomTreeParser.findByClass(secNode, 'swiper-slide'),
        ...DomTreeParser.findByClass(secNode, 'slick-slide')
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

    // 1. Semantic specific section types MUST take precedence over generic carousel structure
    if (c.includes('news') || c.includes('article') || c.includes('blog') || c.includes('bai-viet') || c.includes('tin-tuc')) return 'news';
    if (c.includes('accessory')) return 'accessory-showcase';
    if (c.includes('partner') || c.includes('brand')) return 'partner-carousel';
    if (c.includes('category-list') || c.includes('categories')) return 'category-grid';
    if (c.includes('block-category') || c.includes('product')) return 'featured-products';
    if (c.includes('form') || c.includes('quote') || c.includes('contact')) return 'quote-form';

    // 2. Hero slider and carousel fallbacks
    const hasCarouselChild = (
      DomTreeParser.findByClass(secNode, 's-wrap').length > 0 ||
      DomTreeParser.findByClass(secNode, 'swiper').length > 0 ||
      DomTreeParser.findByClass(secNode, 'slick-slider').length > 0 ||
      DomTreeParser.findByClass(secNode, 'owl-carousel').length > 0 ||
      DomTreeParser.findByClass(secNode, 's-content').length > 0
    );
    if (c.includes('slide') || c.includes('banner') || c.includes('hero') || hasCarouselChild) return 'hero-slider';

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
    <div class="container container-fluid">
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
  <div class="container container-fluid">
    <div class="slide-content flex flex-left-between">
      <div class="slide-content__detail w-100">
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
  <div class="container container-fluid">
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
  <div class="container container-fluid">
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
  <div class="container container-fluid">
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
  <div class="container container-fluid">
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
