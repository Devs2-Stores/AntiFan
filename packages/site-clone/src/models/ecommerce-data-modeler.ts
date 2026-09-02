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
  featuredImage?: string;
  url: string;
}

export interface NormalizedCategory {
  id: string;
  title: string;
  handle: string;
  icon?: string;
  url: string;
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
      siteSettings: {
        title: 'Hop Long Tech Pro',
        hotline: '1900.6536',
        email: 'info@hoplong.com'
      }
    };
  }

  private extractProducts(root: ParsedElementNode): NormalizedProduct[] {
    const products: NormalizedProduct[] = [];
    const productNodes = DomTreeParser.findByClass(root, 'product-item');

    let idx = 1;
    for (const node of productNodes) {
      const titles = DomTreeParser.findByClass(node, 'title');
      const title = titles.length > 0 ? DomTreeParser.extractText(titles[0]) : `Sản phẩm ${idx}`;

      const imgs = DomTreeParser.findByTag(node, 'img');
      const links = DomTreeParser.findByTag(node, 'a');
      const prices = DomTreeParser.findByClass(node, 'price');
      const priceText = prices.length > 0 ? DomTreeParser.extractText(prices[0]) : '';
      const price = this.parsePrice(priceText);

      products.push({
        id: `prod_${idx}`,
        title,
        handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        vendor: 'Schneider / Omron',
        price,
        featuredImage: imgs[0]?.attributes['src'] || '',
        url: links[0]?.attributes['href'] || '#'
      });
      idx++;
    }

    return products;
  }

  private extractCategories(root: ParsedElementNode): NormalizedCategory[] {
    const categories: NormalizedCategory[] = [];
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
    }

    return categories;
  }

  private parsePrice(text: string): number {
    const clean = text.replace(/[^0-9]/g, '');
    return clean ? parseInt(clean, 10) : 0;
  }
}
