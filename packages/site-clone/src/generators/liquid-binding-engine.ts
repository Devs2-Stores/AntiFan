/**
 * Generator: Dynamic Liquid Binding Engine
 * Implements Dynamic Liquid Binding (Audit P0.5, §31 - §32)
 * Binds static HTML representations to Haravan OS 2.0 Liquid contracts
 * and sanitizes against DotLiquid .NET quirks.
 */

import { DomTreeParser, ParsedElementNode } from '../models/dom-tree-parser.js';

export interface ProductBindingOptions {
  isCard?: boolean;
}

export class LiquidBindingEngine {
  /**
   * Binds product card or product detail HTML to Liquid objects:
   * - Replaces product titles with {{ product.title }}
   * - Replaces price displays with {{ product.price | money }} and compare-at-price with {{ product.compare_at_price | money }}
   * - Replaces product images with {{ product.featured_image | img_url: 'master' }}
   * - Replaces product links with {{ product.url }}
   * - Injects variant selectors and add-to-cart form tags ({% form 'product', product %})
   */
  public bindProductSection(html: string, options?: ProductBindingOptions): string {
    if (!html || typeof html !== 'string') return '';
    const isCard = options?.isCard === true;
    let bound = html;

    // 1. Bind Product Images
    bound = this.bindProductImages(bound);

    // 2. Bind Product Links
    bound = this.bindProductLinks(bound, isCard);

    // 3. Bind Product Titles
    bound = this.bindProductTitles(bound, isCard);

    // 4. Bind Product Prices and Compare-at-prices
    bound = this.bindProductPrices(bound);

    // 5. Product Detail Specific Bindings (Description, Vendor, SKU)
    if (!isCard) {
      bound = this.bindProductDetailMetadata(bound);
    }

    // 6. Form and Variant Selector Injection
    bound = this.bindProductForm(bound, isCard);

    return bound;
  }

  /**
   * Binds product grids to collection loops ({% for product in collection.products %} ... {% endfor %})
   */
  public bindCollectionSection(html: string, collectionHandle?: string): string {
    if (!html || typeof html !== 'string') return '';
    let bound = html;

    const source = collectionHandle
      ? `collections['${collectionHandle}']`
      : 'collection';
    const productsLoopVar = `${source}.products`;
    const titleBinding = `{{ ${source}.title }}`;
    const descBinding = `{{ ${source}.description }}`;

    // 1. Bind Collection Title if present
    bound = bound.replace(
      /(<(?:h1|h2|h3|h4|div|span)\b[^>]*class=["'][^"']*(?:collection-title|collection__title|category-title|heading-title)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:h1|h2|h3|h4|div|span)>)/gi,
      `$1${titleBinding}$3`
    );

    // 2. Bind Collection Description if present
    bound = bound.replace(
      /(<(?:div|p|span)\b[^>]*class=["'][^"']*(?:collection-description|collection-desc|category-description)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:div|p|span)>)/gi,
      `$1${descBinding}$3`
    );

    // 3. Detect Product Grid and Card Items
    const root = DomTreeParser.parse(bound);
    const gridCandidates = [
      ...DomTreeParser.findByClass(root, 'product-grid'),
      ...DomTreeParser.findByClass(root, 'products-grid'),
      ...DomTreeParser.findByClass(root, 'grid-products'),
      ...DomTreeParser.findByClass(root, 'product-list'),
      ...DomTreeParser.findByClass(root, 'products-list'),
      ...DomTreeParser.findByClass(root, 'product-slider'),
      ...DomTreeParser.findByClass(root, 'grid-uniform')
    ];

    let gridNode: ParsedElementNode | undefined;
    let cardNodes: ParsedElementNode[] = [];

    if (gridCandidates.length > 0) {
      gridNode = gridCandidates[0];
      cardNodes = this.extractCardNodesFromContainer(gridNode);
    }

    // Fallback: Scan root for repeated card items
    if (cardNodes.length === 0) {
      cardNodes = this.extractCardNodesFromContainer(root);
    }

    if (cardNodes.length > 0) {
      const firstCardOuterHtml = cardNodes[0].outerHtml;
      const boundFirstCard = this.bindProductSection(firstCardOuterHtml, { isCard: true });

      const loopTemplate = `\n{% for product in ${productsLoopVar} %}\n  ${boundFirstCard.trim()}\n{% else %}\n  <p class="empty-collection">Chưa có sản phẩm nào trong danh mục này.</p>\n{% endfor %}\n`;

      if (gridNode) {
        // Replace inner content of grid container with the for-loop
        const gridOuter = gridNode.outerHtml;
        const gridOpenTagMatch = gridOuter.match(/^<[a-zA-Z0-9_-]+[^>]*>/);
        const gridCloseTagMatch = gridOuter.match(/<\/[a-zA-Z0-9_-]+>$/);

        if (gridOpenTagMatch && gridCloseTagMatch) {
          const newGrid = `${gridOpenTagMatch[0]}${loopTemplate}${gridCloseTagMatch[0]}`;
          bound = bound.replace(gridOuter, newGrid);
        } else {
          bound = bound.replace(gridOuter, loopTemplate);
        }
      } else {
        // Replace the card sequence with the for-loop
        const firstCardPos = bound.indexOf(cardNodes[0].outerHtml);
        const lastCard = cardNodes[cardNodes.length - 1];
        const lastCardPos = bound.indexOf(lastCard.outerHtml);

        if (firstCardPos !== -1 && lastCardPos !== -1) {
          const replaceStart = firstCardPos;
          const replaceEnd = lastCardPos + lastCard.outerHtml.length;
          bound = bound.slice(0, replaceStart) + loopTemplate + bound.slice(replaceEnd);
        } else {
          bound = bound.replace(firstCardOuterHtml, loopTemplate);
        }
      }
    }

    return bound;
  }

  /**
   * Binds blog article titles, content ({{ article.content }}), author ({{ article.author }}), and published_at
   */
  public bindArticleSection(html: string): string {
    if (!html || typeof html !== 'string') return '';
    let bound = html;

    // 1. Bind Article Title
    let titleBound = false;
    bound = bound.replace(
      /(<(?:h1|h2|h3)\b[^>]*class=["'][^"']*(?:article-title|post-title|entry-title|blog-title|article__title)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:h1|h2|h3)>)/gi,
      () => {
        titleBound = true;
        return `$1{{ article.title }}$3`;
      }
    );

    if (!titleBound) {
      // Fallback to first h1
      bound = bound.replace(
        /(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/i,
        `$1{{ article.title }}$3`
      );
    }

    // 2. Bind Article Content
    let contentBound = false;
    bound = bound.replace(
      /(<(?:div|section|article)\b[^>]*class=["'][^"']*(?:article-content|post-content|entry-content|article-body|post-body|article__content|blog-content)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:div|section|article)>)/gi,
      () => {
        contentBound = true;
        return `$1{{ article.content }}$3`;
      }
    );

    if (!contentBound) {
      // Look for id="article-content"
      bound = bound.replace(
        /(<(?:div|section|article)\b[^>]*id=["'][^"']*(?:article-content|article-body)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:div|section|article)>)/gi,
        `$1{{ article.content }}$3`
      );
    }

    // 3. Bind Article Author
    bound = bound.replace(
      /(<(?:span|div|a|p)\b[^>]*class=["'][^"']*(?:author|article-author|post-author|article__author|by-author)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div|a|p)>)/gi,
      (match, open, inner, close) => {
        if (/tác giả|by|author/i.test(inner)) {
          return `${open}${inner.replace(/(?:tác giả|by|author)\s*:\s*[^<]+/i, 'Tác giả: {{ article.author }}')}${close}`;
        }
        return `${open}{{ article.author }}${close}`;
      }
    );

    // Also match rel="author"
    bound = bound.replace(
      /(<[a-zA-Z0-9_-]+\b[^>]*\brel=["']author["'][^>]*>)([\s\S]*?)(<\/[a-zA-Z0-9_-]+>)/gi,
      `$1{{ article.author }}$3`
    );

    // 4. Bind Published Date
    // First check for <time> element
    bound = bound.replace(
      /<time\b([^>]*)>([\s\S]*?)<\/time>/gi,
      (_match, attrs) => {
        const hasDatetime = /datetime=["'][^"']*["']/i.test(attrs);
        const updatedAttrs = hasDatetime
          ? attrs.replace(/datetime=["'][^"']*["']/i, `datetime="{{ article.published_at | date: '%Y-%m-%d' }}"`)
          : `${attrs} datetime="{{ article.published_at | date: '%Y-%m-%d' }}"`;
        return `<time${updatedAttrs}>{{ article.published_at | date: '%d/%m/%Y' }}</time>`;
      }
    );

    // Check date classes
    bound = bound.replace(
      /(<(?:span|div|p)\b[^>]*class=["'][^"']*(?:published-at|published-date|post-date|article-date|date|entry-date)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div|p)>)/gi,
      `$1{{ article.published_at | date: '%d/%m/%Y' }}$3`
    );

    // 5. Bind Featured Image
    bound = bound.replace(
      /<img\b([^>]*class=["'][^"']*(?:article-image|featured-image|article-featured-image|post-image|article__image)[^"']*["'][^>]*)>/gi,
      (match) => {
        let tag = match;
        tag = tag.replace(/\s(src|data-src)=["'][^"']*["']/gi, ` $1="{{ article.image | img_url: 'master' }}"`);
        tag = tag.replace(/\salt=["'][^"']*["']/gi, ` alt="{{ article.title | escape }}"`);
        return tag;
      }
    );

    // 6. Bind Article Excerpt
    bound = bound.replace(
      /(<(?:div|p)\b[^>]*class=["'][^"']*(?:article-excerpt|post-excerpt|excerpt)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:div|p)>)/gi,
      `$1{{ article.excerpt }}$3`
    );

    return bound;
  }

  /**
   * Sanitizes syntax against DotLiquid .NET quirks (safe filters, no unsupported Ruby methods, safe variable lookups)
   */
  public sanitizeDotLiquid(liquidText: string): string {
    if (!liquidText || typeof liquidText !== 'string') return '';
    let sanitized = liquidText;

    // 1. DotLiquid Quirk: String Slicing (HS20)
    // | slice: 0, N or | slice: 0 on string dumps LINQ enumerators in .NET DotLiquid
    sanitized = sanitized.replace(
      /\|\s*slice:\s*0\s*,\s*(\d+)/gi,
      `| truncate: $1, ''`
    );
    sanitized = sanitized.replace(
      /\|\s*slice:\s*0\b/gi,
      `| truncate: 1, ''`
    );

    // 2. DotLiquid Quirk: Type Mismatch with 'empty' Keyword
    // DotLiquid .NET throws type mismatch when comparing Drops or IDs with empty
    sanitized = sanitized.replace(
      /(!=\s*empty\b)/g,
      '!= blank'
    );
    sanitized = sanitized.replace(
      /(==\s*empty\b)/g,
      '== blank'
    );

    // 3. DotLiquid Quirk: Metafield and Drop .size Checks
    // Drops often do not expose .size > 0 in DotLiquid; replace with != blank
    sanitized = sanitized.replace(
      /\b([a-zA-Z0-9_.]+)\.size\s*>\s*0\b/g,
      '$1 != blank'
    );
    sanitized = sanitized.replace(
      /\b([a-zA-Z0-9_.]+)\.size\s*==\s*0\b/g,
      '$1 == blank'
    );

    // 4. DotLiquid Quirk: Unsupported Ruby Method Invocations
    // {% for x in list.each %} -> {% for x in list %}
    sanitized = sanitized.replace(
      /({%\s*for\s+\w+\s+in\s+[^%]+?)\.each\b/gi,
      '$1'
    );

    // {% for x in list.reverse %} -> {% for x in list reversed %}
    sanitized = sanitized.replace(
      /({%\s*for\s+\w+\s+in\s+[\w.]+)\.reverse\b/gi,
      '$1 reversed'
    );

    // Ruby type casting methods inside Liquid tags
    sanitized = sanitized.replace(
      /({[{%][\s\S]*?)\.to_i\b([\s\S]*?[}%]})/gi,
      '$1 | plus: 0$2'
    );
    sanitized = sanitized.replace(
      /({[{%][\s\S]*?)\.to_s\b([\s\S]*?[}%]})/gi,
      '$1 | append: \'\'$2'
    );
    sanitized = sanitized.replace(
      /({[{%][\s\S]*?)\.to_f\b([\s\S]*?[}%]})/gi,
      '$1 | plus: 0.0$2'
    );
    sanitized = sanitized.replace(
      /({[{%][\s\S]*?)\.length\b([\s\S]*?[}%]})/gi,
      '$1 | size$2'
    );

    // 5. DotLiquid Quirk: Logical Operators inside Liquid Tags
    // Convert && -> and, || -> or, === -> ==, !== -> !=, null -> nil
    sanitized = sanitized.replace(
      /{%[\s\S]*?%}/g,
      (tag) => {
        let cleaned = tag;
        // Do not touch string literals inside tag
        cleaned = cleaned.replace(/\s&&\s/g, ' and ');
        cleaned = cleaned.replace(/\s\|\|\s/g, ' or ');
        cleaned = cleaned.replace(/===/g, '==');
        cleaned = cleaned.replace(/!==/g, '!=');
        cleaned = cleaned.replace(/\bnull\b/g, 'nil');
        return cleaned;
      }
    );

    // 6. DotLiquid Quirk: Ruby Symbols and Unquoted Arguments
    // Convert [:key] -> ['key']
    sanitized = sanitized.replace(
      /\[:([a-zA-Z0-9_]+)\]/g,
      "['$1']"
    );

    // Ensure standard image size filters are quoted strings (DotLiquid treats unquoted as nil variable lookup)
    sanitized = sanitized.replace(
      /\|\s*img_url:\s*(master|pico|icon|thumb|small|compact|medium|large|grande|original|1024x1024|2048x2048)(?!\w|['"])/gi,
      "| img_url: '$1'"
    );

    // Ensure date filter formats starting with % are quoted
    sanitized = sanitized.replace(
      /\|\s*date:\s*(%[a-zA-Z0-9_\/%-]+)(?!\w|['"])/gi,
      "| date: '$1'"
    );

    // 7. DotLiquid Quirk: Article image absolute URL filter protection (HS21)
    // Replace raw article.image.src | img_url with safe article.image | img_url: 'master'
    sanitized = sanitized.replace(
      /article\.image\.src\s*\|\s*img_url(?::\s*['"]?([^'"}]+)['"]?)?/gi,
      (_match, size) => `article.image | img_url: '${size || 'master'}'`
    );

    return sanitized;
  }

  // =========================================================================
  // Private Helper Methods
  // =========================================================================

  private bindProductImages(html: string): string {
    return html.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
      // Check if this is a product image
      const isProductImg =
        /(?:product|featured|thumb|pro-img|card-img|item-img|gallery)/i.test(attrs) ||
        !/(?:logo|banner|icon|payment|avatar|flag)/i.test(attrs);

      if (!isProductImg) return match;

      let newAttrs = attrs;

      // Replace or add src
      if (/\ssrc=["'][^"']*["']/i.test(newAttrs)) {
        newAttrs = newAttrs.replace(
          /(\ssrc=)["'][^"']*["']/i,
          `$1"{{ product.featured_image | img_url: 'master' }}"`
        );
      } else {
        newAttrs = ` src="{{ product.featured_image | img_url: 'master' }}"${newAttrs}`;
      }

      // Replace data-src if present
      if (/\sdata-src=["'][^"']*["']/i.test(newAttrs)) {
        newAttrs = newAttrs.replace(
          /(\sdata-src=)["'][^"']*["']/i,
          `$1"{{ product.featured_image | img_url: 'master' }}"`
        );
      }

      // Replace or set alt
      if (/\salt=["'][^"']*["']/i.test(newAttrs)) {
        newAttrs = newAttrs.replace(
          /(\salt=)["'][^"']*["']/i,
          `$1"{{ product.title | escape }}"`
        );
      } else {
        newAttrs += ` alt="{{ product.title | escape }}"`;
      }

      // Clean or harmonize srcset
      if (/\ssrcset=["'][^"']*["']/i.test(newAttrs)) {
        newAttrs = newAttrs.replace(
          /(\ssrcset=)["'][^"']*["']/i,
          `$1"{{ product.featured_image | img_url: 'master' }}"`
        );
      }

      return `<img${newAttrs}>`;
    });
  }

  private bindProductLinks(html: string, isCard: boolean): string {
    return html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
      const isProductLink =
        /(?:products?|san-pham|item|prod|p)\//i.test(attrs) ||
        /(?:product-link|item-link|pro-link|title-link|thumb-link)/i.test(attrs) ||
        (isCard && !/(?:cart|wishlist|quickview|compare|social)/i.test(attrs));

      if (!isProductLink) return match;

      let newAttrs = attrs;
      if (/\shref=["'][^"']*["']/i.test(newAttrs)) {
        newAttrs = newAttrs.replace(
          /(\shref=)["'][^"']*["']/i,
          `$1"{{ product.url }}"`
        );
      } else {
        newAttrs = ` href="{{ product.url }}"${newAttrs}`;
      }

      return `<a${newAttrs}>`;
    });
  }

  private bindProductTitles(html: string, isCard: boolean): string {
    let bound = html;

    // 1. Explicit title classes
    bound = bound.replace(
      /(<(?:h1|h2|h3|h4|h5|h6|div|span|p)\b[^>]*class=["'][^"']*(?:product-title|product-name|product__title|pro-title|pro-name|item-title|card-title)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:h1|h2|h3|h4|h5|h6|div|span|p)>)/gi,
      (_match, open, inner, close) => {
        // If inner contains an anchor tag, preserve anchor but bind title inside
        if (/<a\b[^>]*>/i.test(inner)) {
          const updatedInner = inner.replace(
            /(<a\b[^>]*>)([\s\S]*?)(<\/a>)/i,
            `$1{{ product.title }}$3`
          );
          return `${open}${updatedInner}${close}`;
        }
        return `${open}{{ product.title }}${close}`;
      }
    );

    // 2. Direct title links <a class="product-title ...">
    bound = bound.replace(
      /(<a\b[^>]*class=["'][^"']*(?:product-title|product-name|pro-name|card-title)[^"']*["'][^>]*>)([\s\S]*?)(<\/a>)/gi,
      `$1{{ product.title }}$3`
    );

    // 3. For product detail page, bind primary <h1> if not yet bound
    if (!isCard && !bound.includes('{{ product.title }}')) {
      bound = bound.replace(
        /(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/i,
        `$1{{ product.title }}$3`
      );
    }

    return bound;
  }

  private bindProductPrices(html: string): string {
    let bound = html;

    // 1. Compare-at-price / Old price displays
    // Tags: <del> or elements with compare-price/old-price/regular-price
    bound = bound.replace(
      /(<(?:del|span|div|p|ins)\b[^>]*class=["'][^"']*(?:compare-price|compare-at-price|price-compare|old-price|price-old|original-price|strike)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:del|span|div|p|ins)>)/gi,
      `$1{{ product.compare_at_price | money }}$3`
    );

    // Match bare <del>...</del> if not already matched
    bound = bound.replace(
      /(<del\b[^>]*>)([\s\S]*?)(<\/del>)/gi,
      (_match, open, inner, close) => {
        if (inner.includes('{{ product.compare_at_price')) return _match;
        return `${open}{{ product.compare_at_price | money }}${close}`;
      }
    );

    // 2. Current / Regular Price displays
    bound = bound.replace(
      /(<(?:span|div|p|ins)\b[^>]*class=["'][^"']*(?:current-price|price-current|pro-price|special-price|price-new|sale-price|item-price)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div|p|ins)>)/gi,
      (_match, open, inner, close) => {
        if (inner.includes('{{ product.')) return _match;
        return `${open}{{ product.price | money }}${close}`;
      }
    );

    // Generic .price class if inner content contains price-like digits
    bound = bound.replace(
      /(<(?:span|div|p)\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div|p)>)/gi,
      (_match, open, inner, close) => {
        if (inner.includes('{{ product.')) return _match;
        // If it contains child tags like <del> or another span, avoid clobbering whole container
        if (/<(?:span|del|ins|div)\b/i.test(inner)) return _match;
        return `${open}{{ product.price | money }}${close}`;
      }
    );

    return bound;
  }

  private bindProductDetailMetadata(html: string): string {
    let bound = html;

    // 1. Description / Content
    bound = bound.replace(
      /(<(?:div|section)\b[^>]*class=["'][^"']*(?:product-description|product-content|pro-desc|product__description)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:div|section)>)/gi,
      `$1{{ product.content }}$3`
    );

    // 2. Vendor
    bound = bound.replace(
      /(<(?:span|div|p|a)\b[^>]*class=["'][^"']*(?:product-vendor|vendor|pro-vendor|brand)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div|p|a)>)/gi,
      `$1{{ product.vendor }}$3`
    );

    // 3. SKU
    bound = bound.replace(
      /(<(?:span|div|p)\b[^>]*class=["'][^"']*(?:product-sku|sku|pro-sku)[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:span|div|p)>)/gi,
      `$1{{ product.selected_or_first_available_variant.sku }}$3`
    );

    return bound;
  }

  private bindProductForm(html: string, isCard: boolean): string {
    let bound = html;

    const variantSelectorMarkup = `
<select name="id" id="product-select" class="product-form__variants">
  {% for variant in product.variants %}
    <option value="{{ variant.id }}" {% if variant == product.selected_or_first_available_variant %}selected="selected"{% endif %} {% unless variant.available %}disabled="disabled"{% endunless %}>
      {{ variant.title }} - {{ variant.price | money }}
    </option>
  {% endfor %}
</select>
`.trim();

    const hiddenVariantMarkup = `<input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}" />`;

    // 1. Check if HTML already has a <form ...>
    const formOpenRegex = /<form\b([^>]*)>/i;
    const formCloseRegex = /<\/form>/i;

    if (formOpenRegex.test(bound)) {
      // Replace <form ...> with {% form 'product', product %}
      bound = bound.replace(formOpenRegex, `{% form 'product', product %}`);
      // Replace </form> with {% endform %}
      bound = bound.replace(formCloseRegex, `{% endform %}`);

      // Handle variant selector inside the form
      if (!isCard) {
        if (/<select\b[^>]*name=["']id["'][^>]*>[\s\S]*?<\/select>/i.test(bound)) {
          bound = bound.replace(
            /<select\b[^>]*name=["']id["'][^>]*>[\s\S]*?<\/select>/i,
            variantSelectorMarkup
          );
        } else if (!bound.includes('name="id"')) {
          // Inject variant selector before submit button or endform
          if (/<button\b[^>]*type=["']submit["']/i.test(bound)) {
            bound = bound.replace(
              /(<button\b[^>]*type=["']submit["'])/i,
              `${variantSelectorMarkup}\n$1`
            );
          } else {
            bound = bound.replace('{% endform %}', `${variantSelectorMarkup}\n{% endform %}`);
          }
        }
      } else {
        // For card, ensure hidden variant ID is present
        if (!bound.includes('name="id"')) {
          bound = bound.replace('{% form \'product\', product %}', `{% form 'product', product %}\n${hiddenVariantMarkup}`);
        }
      }

      return bound;
    }

    // 2. If no <form> is present:
    // For product detail, find purchase action or add-to-cart button and wrap in {% form 'product', product %}
    const btnRegex = /(<button\b[^>]*class=["'][^"']*(?:btn-add-to-cart|add-to-cart|buy-now|btn-buy|btn-cart)[^"']*["'][^>]*>[\s\S]*?<\/button>)/i;

    if (btnRegex.test(bound)) {
      if (!isCard) {
        bound = bound.replace(btnRegex, (buttonMarkup) => {
          return `{% form 'product', product %}\n  ${variantSelectorMarkup}\n  ${buttonMarkup}\n{% endform %}`;
        });
      } else {
        bound = bound.replace(btnRegex, (buttonMarkup) => {
          return `{% form 'product', product %}\n  ${hiddenVariantMarkup}\n  ${buttonMarkup}\n{% endform %}`;
        });
      }
    }

    return bound;
  }

  private extractCardNodesFromContainer(container: ParsedElementNode): ParsedElementNode[] {
    const cardNodes: ParsedElementNode[] = [];
    const CARD_CLASS_REGEX = /(?:product-card|product-item|col-product|product-col|grid__item|card-product|pro-item|item-product)\b/i;

    const walk = (node: ParsedElementNode) => {
      const cls = node.attributes['class'] || '';
      if (CARD_CLASS_REGEX.test(cls)) {
        cardNodes.push(node);
        return; // do not recurse into nested cards
      }

      for (const child of node.children) {
        if (typeof child !== 'string') {
          walk(child);
        }
      }
    };

    walk(container);
    return cardNodes;
  }
}
