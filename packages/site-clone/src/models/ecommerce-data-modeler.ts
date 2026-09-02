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
    const products: NormalizedProduct[] = [];
    // Support generic product card class archetypes
    const productNodes = [
      ...DomTreeParser.findByClass(root, 'product-item'),
      ...DomTreeParser.findByClass(root, 'product-card'),
      ...DomTreeParser.findByClass(root, 'card-product'),
      ...DomTreeParser.findByClass(root, 'item-product')
    ];

    // Deduplicate nodes
    const seen = new Set<ParsedElementNode>();
    const uniqueNodes = productNodes.filter(n => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });

    let idx = 1;
    for (const node of uniqueNodes) {
      const titles = [
        ...DomTreeParser.findByClass(node, 'title'),
        ...DomTreeParser.findByClass(node, 'product-title'),
        ...DomTreeParser.findByClass(node, 'name'),
        ...DomTreeParser.findByTag(node, 'h3'),
        ...DomTreeParser.findByTag(node, 'h2')
      ];
      const title = titles.length > 0 ? DomTreeParser.extractText(titles[0]).trim() : `Sản phẩm ${idx}`;

      const imgs = DomTreeParser.findByTag(node, 'img');
      const links = DomTreeParser.findByTag(node, 'a');
      const prices = [
        ...DomTreeParser.findByClass(node, 'price'),
        ...DomTreeParser.findByClass(node, 'price-current'),
        ...DomTreeParser.findByClass(node, 'amount')
      ];
      const priceText = prices.length > 0 ? DomTreeParser.extractText(prices[0]) : '';
      const price = this.parsePrice(priceText);

      // Extract vendor dynamically if present
      const vendors = [
        ...DomTreeParser.findByClass(node, 'vendor'),
        ...DomTreeParser.findByClass(node, 'brand')
      ];
      const vendor = vendors.length > 0 ? DomTreeParser.extractText(vendors[0]).trim() : '';

      products.push({
        id: `prod_${idx}`,
        title,
        handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `product-${idx}`,
        vendor,
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
