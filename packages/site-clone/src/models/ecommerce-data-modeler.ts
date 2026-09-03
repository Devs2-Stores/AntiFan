/**
 * Model 5: E-Commerce Data Modeler
 * Extracts and normalizes products, collections, brands, and pricing from storefront DOM
 */

import { DomTreeParser, ParsedElementNode } from './dom-tree-parser.js';

export interface NormalizedProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  price: number;
  compareAtPrice?: number;
  currency?: string;
  available?: boolean;
  featuredImage?: string;
  url: string;
}

export interface NormalizedCategory {
  id: string;
  title: string;
  handle: string;
  icon?: string;
  url: string;
  children?: NormalizedCategory[];
}
export interface StorefrontDataBundle {
  products: NormalizedProduct[];
  categories: NormalizedCategory[];
  siteSettings: {
    title: string;
    hotline: string;
    email: string;
  };
}

export class EcommerceDataModeler {
  public extractStorefrontData(html: string): StorefrontDataBundle {
    const root = DomTreeParser.parse(html);

    return {
      products: this.extractProducts(root),
      categories: this.extractCategories(root),
      siteSettings: this.extractSiteSettings(root, html)
    };
  }

  private extractSiteSettings(root: ParsedElementNode, html: string): { title: string; hotline: string; email: string } {
    let title = '';
    const titleNodes = DomTreeParser.findByTag(root, 'title');
    if (titleNodes.length > 0) {
      title = DomTreeParser.extractText(titleNodes[0]).split('|')[0].trim();
    }

    let hotline = '';
    const telLinks = DomTreeParser.findByTag(root, 'a').filter(a => a.attributes['href']?.startsWith('tel:'));
    if (telLinks.length > 0) {
      hotline = (telLinks[0].attributes['href'] || '').replace('tel:', '').trim();
    }

    let email = '';
    const mailLinks = DomTreeParser.findByTag(root, 'a').filter(a => a.attributes['href']?.startsWith('mailto:'));
    if (mailLinks.length > 0) {
      email = (mailLinks[0].attributes['href'] || '').replace('mailto:', '').trim();
    }

    return {
      title: title || 'Storefront',
      hotline: hotline || '',
      email: email || ''
    };
  }
  private extractProducts(root: ParsedElementNode): NormalizedProduct[] {
    const candidateNodes: ParsedElementNode[] = [];
    const CURRENCY_REGEX = /\d+[\.,]?\d*\s*(?:₫|đ|VND|VNĐ|USD|\$|€)/i;
    const PRODUCT_URL_REGEX = /\/(?:products?|san-pham|item|prod|p)\//i;

    // Recursive scanner tracking negative context ancestors
    const scan = (node: ParsedElementNode, inNegativeContext: boolean) => {
      const tag = node.tag.toLowerCase();
      const cls = node.attributes['class'] || '';

      // Exclude navigation, header, footer, blog, and news containers
      const isNegative = inNegativeContext ||
        ['header', 'nav', 'footer'].includes(tag) ||
        /(?:^|\s)(?:header|nav|footer|menu|category-navigation|blog|news|article)(?:$|\s)/i.test(cls);

      // Collect child element nodes
      const childElements: ParsedElementNode[] = [];
      for (const child of node.children) {
        if (typeof child !== 'string') {
          childElements.push(child);
        }
      }

      if (!isNegative && childElements.length > 0) {
        // Count siblings sharing the same tag and containing both <img> and <a>
        const qualifyingCount = childElements.filter(c => {
          const imgs = DomTreeParser.findByTag(c, 'img');
          const links = DomTreeParser.findByTag(c, 'a');
          return imgs.length > 0 && links.length > 0;
        }).length;

        for (const child of childElements) {
          const cTag = child.tag.toLowerCase();
          if (['script', 'style', 'noscript'].includes(cTag)) continue;

          // Count siblings sharing identical tag and containing both <img> and <a>
          const sameTagSiblings = childElements.filter(c => {
            if (c.tag.toLowerCase() !== cTag) return false;
            const imgs = DomTreeParser.findByTag(c, 'img');
            const links = DomTreeParser.findByTag(c, 'a');
            return imgs.length > 0 && links.length > 0;
          });
          const qualifyingCount = sameTagSiblings.length;

          // If child is itself a container with >= 2 card-like sub-children, recurse into it
          const subCardCount = child.children.filter(c => {
            if (typeof c === 'string') return false;
            const imgs = DomTreeParser.findByTag(c, 'img');
            const links = DomTreeParser.findByTag(c, 'a');
            return imgs.length > 0 && links.length > 0;
          }).length;

          if (subCardCount >= 2) {
            scan(child, isNegative);
            continue;
          }

          const cCls = child.attributes['class'] || '';
          const text = DomTreeParser.extractText(child);
          const links = DomTreeParser.findByTag(child, 'a');
          const imgs = DomTreeParser.findByTag(child, 'img');
          const hasProductUrl = links.some(l => PRODUCT_URL_REGEX.test(l.attributes['href'] || ''));
          const hasCurrency = CURRENCY_REGEX.test(text);
          const hasMicrodata = (child.attributes['itemtype'] || '').includes('Product');

          // 1. Mandatory Commercial Anchor Gate
          const hasAnchor = hasCurrency || hasProductUrl || hasMicrodata;
          if (!hasAnchor || imgs.length === 0) {
            scan(child, isNegative);
            continue;
          }

          // 2. Orthogonal Hybrid Confidence Scoring (0.35 Class + 0.35 Repetition + 0.30 Price)
          let sClass = 0;
          if (/(?:^|\s)(?:product-item|product-card|card-product|item-product|product-grid__item|product-tile|product-box)(?:$|\s)/i.test(cCls) || hasMicrodata) {
            sClass = 1.0;
          } else if (/\bproduct\b|\bcard-product\b/i.test(cCls)) {
            sClass = 0.9;
          } else if (/prod-/i.test(cCls)) {
            sClass = 0.7;
          }

          let sRepetition = 0;
          if (qualifyingCount >= 3) {
            sRepetition = 1.0;
          }

          const sPrice = hasCurrency ? 1.0 : 0.0;

          const confidence = 0.35 * sClass + 0.35 * sRepetition + 0.30 * sPrice;

          // Candidate cluster accepted if confidence >= 0.60
          if (confidence >= 0.60 && imgs.length > 0) {
            candidateNodes.push(child);
            continue;
          }

          scan(child, isNegative);
        }
      } else {
        for (const child of childElements) {
          scan(child, isNegative);
        }
      }
    };

    scan(root, false);

    // Deduplicate candidate nodes
    const seen = new Set<ParsedElementNode>();
    const uniqueNodes = candidateNodes.filter(n => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });

    const products: NormalizedProduct[] = [];
    let idx = 1;
    for (const node of uniqueNodes) {
      const titles = [
        ...DomTreeParser.findByClass(node, 'title'),
        ...DomTreeParser.findByClass(node, 'product-title'),
        ...DomTreeParser.findByClass(node, 'name'),
        ...DomTreeParser.findByTag(node, 'h3'),
        ...DomTreeParser.findByTag(node, 'h2'),
        ...DomTreeParser.findByTag(node, 'h4')
      ];
      const title = titles.length > 0 ? DomTreeParser.extractText(titles[0]).trim() : `Sản phẩm ${idx}`;

      const imgs = DomTreeParser.findByTag(node, 'img');
      const links = DomTreeParser.findByTag(node, 'a');

      // Price extraction
      const currentPrices = [
        ...DomTreeParser.findByClass(node, 'special-price'),
        ...DomTreeParser.findByClass(node, 'price-current'),
        ...DomTreeParser.findByClass(node, 'current-price'),
        ...DomTreeParser.findByClass(node, 'product-price'),
        ...DomTreeParser.findByClass(node, 'price-now'),
        ...DomTreeParser.findByClass(node, 'price'),
        ...DomTreeParser.findByClass(node, 'amount')
      ];
      const oldPrices = [
        ...DomTreeParser.findByClass(node, 'price-old'),
        ...DomTreeParser.findByClass(node, 'compare-price'),
        ...DomTreeParser.findByClass(node, 'old-price'),
        ...DomTreeParser.findByTag(node, 'del'),
        ...DomTreeParser.findByTag(node, 's')
      ];

      const priceText = currentPrices.length > 0 ? DomTreeParser.extractText(currentPrices[0]) : DomTreeParser.extractText(node);
      const parsedPrice = EcommerceDataModeler.parseStructuredPrice(priceText);
      let price = parsedPrice.price;
      let compareAtPrice = parsedPrice.compareAtPrice;

      if (oldPrices.length > 0) {
        const oldText = DomTreeParser.extractText(oldPrices[0]);
        const oldParsed = EcommerceDataModeler.parseSinglePrice(oldText);
        if (oldParsed > price) {
          compareAtPrice = oldParsed;
        }
      }

      // Vendor extraction
      const vendors = [
        ...DomTreeParser.findByClass(node, 'vendor'),
        ...DomTreeParser.findByClass(node, 'brand')
      ];
      const vendor = vendors.length > 0 ? DomTreeParser.extractText(vendors[0]).trim() : '';

      const fullText = DomTreeParser.extractText(node).toLowerCase();
      const isOutOfStock = fullText.includes('hết hàng') || fullText.includes('out of stock') || fullText.includes('tam het hang');

      const currency = EcommerceDataModeler.detectCurrency(priceText);
      const product: NormalizedProduct = {
        id: `prod_${idx}`,
        title,
        handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `product-${idx}`,
        vendor,
        price,
        currency,
        available: !isOutOfStock,
        featuredImage: imgs[0]?.attributes['src'] || imgs[0]?.attributes['data-src'] || '',
        url: links[0]?.attributes['href'] || '#'
      };
      if (compareAtPrice && compareAtPrice > price) {
        product.compareAtPrice = compareAtPrice;
      }

      products.push(product);
      idx++;
    }

    return products;
  }

  private extractCategories(root: ParsedElementNode): NormalizedCategory[] {
    const categories: NormalizedCategory[] = [];

    const extractListItems = (ulNode: ParsedElementNode, parentId: string, depth = 1): NormalizedCategory[] => {
      if (depth > 4) return [];
      const result: NormalizedCategory[] = [];
      let itemIdx = 1;

      for (const child of ulNode.children) {
        if (typeof child === 'string' || child.tag.toLowerCase() !== 'li') continue;
        const links = DomTreeParser.findByTag(child, 'a');
        if (links.length === 0) continue;
        const title = DomTreeParser.extractText(links[0]).trim();
        if (!title) continue;

        const imgs = DomTreeParser.findByTag(child, 'img');
        const currentId = `${parentId}_${itemIdx}`;
        const cat: NormalizedCategory = {
          id: currentId,
          title,
          handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `category-${currentId}`,
          url: links[0].attributes['href'] || '#'
        };
        if (imgs.length > 0 && imgs[0].attributes['src']) {
          cat.icon = imgs[0].attributes['src'];
        }

        // Sub-categories: find child <ul>
        const subLists = DomTreeParser.findByTag(child, 'ul');
        if (subLists.length > 0) {
          const subItems = extractListItems(subLists[0], currentId, depth + 1);
          if (subItems.length > 0) {
            cat.children = subItems;
          }
        }

        result.push(cat);
        itemIdx++;
      }

      return result;
    };

    const catSections = DomTreeParser.findByClass(root, 'category-list');
    if (catSections.length > 0) {
      const items = DomTreeParser.findByClass(catSections[0], 'item');
      let idx = 1;
      for (const item of items) {
        const spans = DomTreeParser.findByTag(item, 'span');
        const imgs = DomTreeParser.findByTag(item, 'img');
        const links = DomTreeParser.findByTag(item, 'a');
        const title = spans.length > 0 ? DomTreeParser.extractText(spans[0]) : `Danh mục ${idx}`;

        categories.push({
          id: `cat_${idx}`,
          title,
          handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          icon: imgs[0]?.attributes['src'] || '',
          url: links[0]?.attributes['href'] || '#'
        });
        idx++;
      }
      return categories;
    }

    // Hierarchical category extraction from <nav>, category-navigation, or main-navigation
    const navNodes = [
      ...DomTreeParser.findByTag(root, 'nav'),
      ...DomTreeParser.findByClass(root, 'category-navigation'),
      ...DomTreeParser.findByClass(root, 'main-navigation')
    ];

    if (navNodes.length > 0) {
      const topLists = DomTreeParser.findByTag(navNodes[0], 'ul');
      if (topLists.length > 0) {
        return extractListItems(topLists[0], 'cat', 1);
      }
    }

    return categories;
  }

  public static detectCurrency(raw: string): string | undefined {
    if (!raw) return undefined;
    if (/[₫đ]|vn[dđ]/i.test(raw)) return 'VND';
    if (/\$|usd/i.test(raw)) return 'USD';
    if (/€|eur/i.test(raw)) return 'EUR';
    if (/¥|jpy|cny/i.test(raw)) return 'JPY';
    return undefined;
  }

  public static parseStructuredPrice(text: string): { price: number; compareAtPrice?: number; currency?: string } {
    if (!text || typeof text !== 'string') return { price: 0 };
    const currency = EcommerceDataModeler.detectCurrency(text);
    // Strip discount percentages (e.g. -30%, 15%) so badges are not mistaken for prices
    const clean = text.replace(/[-+]?\d+\s*%/g, ' ').trim();
    // Detect ranges: "1.299.000 - 1.599.000đ", "100k ~ 200k", "1.000.000 đến 2.000.000"
    const rangeParts = clean.split(/\s*(?:-|~|–|—|đến|to)\s*/i);
    if (rangeParts.length >= 2) {
      const p1 = EcommerceDataModeler.parseSinglePrice(rangeParts[0]);
      const p2 = EcommerceDataModeler.parseSinglePrice(rangeParts[1]);
      if (p1 > 0 && p2 > 0) {
        return {
          price: Math.min(p1, p2),
          compareAtPrice: Math.max(p1, p2),
          currency
        };
      }
    }

    return { price: EcommerceDataModeler.parseSinglePrice(clean), currency };
  }

  public static parseSinglePrice(raw: string): number {
    if (!raw || typeof raw !== 'string') return 0;
    // Strip discount percentages (e.g. -30%, 15%)
    let sanitized = raw.replace(/[-+]?\d+\s*%/g, ' ');
    // Strip common non-price prefixes
    sanitized = sanitized.replace(/^(?:từ|from|giá\s*:?|chỉ\s*từ|chỉ|price\s*:?|đơn\s*giá\s*:?)\s*/i, '');
    // Strip common period suffixes
    sanitized = sanitized.replace(/\s*\/\s*(?:tháng|month|năm|year|ngày|day|cái|chiếc|bộ|sp|pcs|pc|item)\b/i, '');

    // Check for "k" shorthand: e.g. "150k", "250K", "150.5k"
    const kMatch = sanitized.match(/(\d+(?:[\.,]\d+)?)\s*[kK]\b/);
    if (kMatch) {
      const val = parseFloat(kMatch[1].replace(',', '.'));
      if (!isNaN(val)) return Math.round(val * 1000);
    }
    // Check for "tr" / "triệu" shorthand: e.g. "1.5tr", "2 triệu"
    const trMatch = sanitized.match(/(\d+(?:[\.,]\d+)?)\s*(?:tr|triệu)\b/i);
    if (trMatch) {
      const val = parseFloat(trMatch[1].replace(',', '.'));
      if (!isNaN(val)) return Math.round(val * 1000000);
    }

    const match = sanitized.match(/[\d]+(?:[\.,]\d+)*/);
    if (!match) return 0;

    let numStr = match[0];

    // English currency pattern: thousands separator comma followed by 2-digit cents (e.g. 1,299.99 or 12,450.50)
    if (/^\d{1,3}(,\d{3})+(\.\d{1,2})$/.test(numStr)) {
      numStr = numStr.replace(/,/g, '');
      const parsed = parseFloat(numStr);
      return isNaN(parsed) ? 0 : Math.round(parsed);
    }

    // Multiple dots/commas -> thousands separators (e.g. 1.299.000 or 1,299,000)
    if ((numStr.match(/[\.,]/g) || []).length > 1) {
      numStr = numStr.replace(/[\.,]/g, '');
      return parseInt(numStr, 10) || 0;
    }

    // Single separator with 3 trailing digits -> thousands separator (e.g. 450.000 or 450,000)
    if (/[\.,]\d{3}$/.test(numStr)) {
      numStr = numStr.replace(/[\.,]/g, '');
      return parseInt(numStr, 10) || 0;
    }

    // Single dot with 1-2 trailing digits -> decimal (e.g. 49.99)
    if (/\.\d{1,2}$/.test(numStr)) {
      const parsed = parseFloat(numStr);
      return isNaN(parsed) ? 0 : Math.round(parsed);
    }

    const digits = numStr.replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }

  public parsePrice(text: string): number {
    return EcommerceDataModeler.parseStructuredPrice(text).price;
  }
}
