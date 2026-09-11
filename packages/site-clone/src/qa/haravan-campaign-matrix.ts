/**
 * Haravan Campaign Surface Matrix Engine (Audit §52, §68)
 *
 * Implements the canonical 15-page surface catalogue across the 3 standard viewports
 * (desktop: 1440x900, laptop: 1024x900, mobile: 390x844), producing an authoritative
 * 45-leg evaluation matrix for comprehensive storefront visual and regression QA.
 *
 * Grounded in Haravan OS 2.0 template architectures, RouteResolver canonical routing,
 * and StoreInventory catalog binding.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { RouteResolver } from '../platform/haravan/route-resolver.js';
import type { HaravanRouteIdentity } from '../platform/haravan/types.js';
import type {
  StoreInventory,
  InventoryProduct,
  InventoryCollection,
  InventoryArticle,
  InventoryBlog,
  InventoryPage,
} from '../platform/haravan/store-discovery.js';

export type CanonicalSurfaceName =
  | 'home'
  | 'product-standard'
  | 'product-variants'
  | 'product-out-of-stock'
  | 'collection-grid'
  | 'collection-filtered'
  | 'collection-empty'
  | 'blog-listing'
  | 'article-detail'
  | 'article-comments'
  | 'page-standard'
  | 'page-contact'
  | 'cart-active'
  | 'cart-empty'
  | 'search-results';

export type CampaignViewportName = 'desktop' | 'laptop' | 'mobile';

export interface CampaignViewport {
  name: CampaignViewportName;
  width: number;
  height: number;
}

export interface CanonicalSurfaceDefinition {
  surface: CanonicalSurfaceName;
  kind: HaravanRouteIdentity['kind'];
  template: string;
  description: string;
  defaultPath: string;
  stateModifier?: string;
  required: boolean;
}

export interface BoundEntityInfo {
  type: 'root' | 'product' | 'collection' | 'blog' | 'article' | 'page' | 'cart' | 'search';
  id?: number | string;
  handle?: string;
  title?: string;
  [key: string]: unknown;
}

export interface CampaignMatrixLeg {
  id: string;
  surface: CanonicalSurfaceName | string;
  kind: string;
  template: string;
  viewport: CampaignViewport;
  required: boolean;
  url: string;
  canonicalUrl: string;
  stateModifier?: string;
  description?: string;
  boundEntity?: BoundEntityInfo;
}

export interface MatrixCoverageReport {
  coveragePercentage: number;
  missingLegs: string[];
  isComplete: boolean;
  totalLegs: number;
  executedCount: number;
}

/**
 * Standard responsive viewports defined for Haravan campaign evaluation
 */
export const STANDARD_VIEWPORTS: Record<CampaignViewportName, CampaignViewport> = {
  desktop: {
    name: 'desktop',
    width: 1440,
    height: 900,
  },
  laptop: {
    name: 'laptop',
    width: 1024,
    height: 900,
  },
  mobile: {
    name: 'mobile',
    width: 390,
    height: 844,
  },
};

/**
 * Canonical 15-page surface catalogue for Haravan storefront visual verification
 */
export const CANONICAL_SURFACES: readonly CanonicalSurfaceDefinition[] = [
  {
    surface: 'home',
    kind: 'home',
    template: 'index.liquid',
    description: 'Storefront home landing page and hero showcase',
    defaultPath: '/',
    required: true,
  },
  {
    surface: 'product-standard',
    kind: 'product',
    template: 'product.liquid',
    description: 'Standard product detail template with default variant',
    defaultPath: '/products/standard-product',
    required: true,
  },
  {
    surface: 'product-variants',
    kind: 'product',
    template: 'product.liquid',
    description: 'Product detail template with variant selection options',
    defaultPath: '/products/variant-product?variant=1',
    stateModifier: 'variant_selection',
    required: true,
  },
  {
    surface: 'product-out-of-stock',
    kind: 'product',
    template: 'product.liquid',
    description: 'Product detail template with out-of-stock / unavailable inventory state',
    defaultPath: '/products/out-of-stock-product?state=unavailable',
    stateModifier: 'out_of_stock',
    required: true,
  },
  {
    surface: 'collection-grid',
    kind: 'collection',
    template: 'collection.liquid',
    description: 'Collection grid listing of available products',
    defaultPath: '/collections/all',
    required: true,
  },
  {
    surface: 'collection-filtered',
    kind: 'collection',
    template: 'collection.liquid',
    description: 'Collection grid listing with active tag or type filters',
    defaultPath: '/collections/all?filter=tag',
    stateModifier: 'filtered',
    required: true,
  },
  {
    surface: 'collection-empty',
    kind: 'collection',
    template: 'collection.liquid',
    description: 'Collection grid empty state notice with zero products',
    defaultPath: '/collections/empty',
    stateModifier: 'empty_state',
    required: true,
  },
  {
    surface: 'blog-listing',
    kind: 'blog',
    template: 'blog.liquid',
    description: 'Blog index listing articles and editorial posts',
    defaultPath: '/blogs/news',
    required: true,
  },
  {
    surface: 'article-detail',
    kind: 'article',
    template: 'article.liquid',
    description: 'Article editorial post content and author metadata',
    defaultPath: '/blogs/news/sample-article',
    required: true,
  },
  {
    surface: 'article-comments',
    kind: 'article',
    template: 'article.liquid',
    description: 'Article editorial post with active discussion and comments section',
    defaultPath: '/blogs/news/sample-article#comments',
    stateModifier: 'discussion_section',
    required: true,
  },
  {
    surface: 'page-standard',
    kind: 'page',
    template: 'page.liquid',
    description: 'Standard static content and policy page',
    defaultPath: '/pages/about-us',
    required: true,
  },
  {
    surface: 'page-contact',
    kind: 'page',
    template: 'page.contact.liquid',
    description: 'Contact page with customer feedback and inquiry submission form',
    defaultPath: '/pages/contact',
    stateModifier: 'contact_form',
    required: true,
  },
  {
    surface: 'cart-active',
    kind: 'cart',
    template: 'cart.liquid',
    description: 'Shopping cart with active line items and checkout action',
    defaultPath: '/cart',
    stateModifier: 'active_items',
    required: true,
  },
  {
    surface: 'cart-empty',
    kind: 'cart',
    template: 'cart.liquid',
    description: 'Shopping cart empty state with continuation CTA',
    defaultPath: '/cart?state=empty',
    stateModifier: 'empty_state',
    required: true,
  },
  {
    surface: 'search-results',
    kind: 'search',
    template: 'search.liquid',
    description: 'Search query results page with matching catalog items',
    defaultPath: '/search?q=test',
    required: true,
  },
] as const;

export class HaravanCampaignMatrix {
  private readonly routeResolver: RouteResolver;

  constructor(routeResolver?: RouteResolver) {
    this.routeResolver = routeResolver || new RouteResolver();
  }

  /**
   * Constructs the full 45-leg evaluation matrix (15 canonical surfaces x 3 standard viewports).
   *
   * When a StoreInventory instance is provided, matrix surfaces bind to live inventory catalog
   * entities and resolve canonical URLs through RouteResolver. When omitted, canonical default
   * handles and routes are assigned.
   */
  public buildFullMatrix(inventory?: StoreInventory | Record<string, unknown> | null): CampaignMatrixLeg[] {
    const legs: CampaignMatrixLeg[] = [];
    const viewports: CampaignViewport[] = [
      STANDARD_VIEWPORTS.desktop,
      STANDARD_VIEWPORTS.laptop,
      STANDARD_VIEWPORTS.mobile,
    ];

    // Pre-resolve surface bindings for the inventory
    const surfaceBindings = this.resolveSurfaceBindings(inventory);

    for (const surfaceDef of CANONICAL_SURFACES) {
      const binding = surfaceBindings.get(surfaceDef.surface) || {
        url: surfaceDef.defaultPath,
        canonicalUrl: surfaceDef.defaultPath,
        boundEntity: undefined,
      };

      for (const vp of viewports) {
        const legId = `${surfaceDef.surface}:${vp.name}`;

        legs.push({
          id: legId,
          surface: surfaceDef.surface,
          kind: surfaceDef.kind,
          template: surfaceDef.template,
          viewport: {
            name: vp.name,
            width: vp.width,
            height: vp.height,
          },
          required: surfaceDef.required,
          url: binding.url,
          canonicalUrl: binding.canonicalUrl,
          ...(surfaceDef.stateModifier ? { stateModifier: surfaceDef.stateModifier } : {}),
          description: surfaceDef.description,
          ...(binding.boundEntity ? { boundEntity: binding.boundEntity } : {}),
        });
      }
    }

    return legs;
  }

  /**
   * Evaluates matrix test coverage against a collection of executed legs.
   * Supports executed legs represented as leg IDs, surface/viewport strings, or leg objects.
   */
  public validateMatrixCoverage(
    matrix: Array<CampaignMatrixLeg | Record<string, unknown>>,
    executedLegs: Array<string | CampaignMatrixLeg | Record<string, unknown>>
  ): MatrixCoverageReport {
    if (!Array.isArray(matrix) || matrix.length === 0) {
      return {
        coveragePercentage: 100,
        missingLegs: [],
        isComplete: true,
        totalLegs: 0,
        executedCount: 0,
      };
    }

    const executedSet = new Set<string>();

    for (const executed of executedLegs || []) {
      if (typeof executed === 'string') {
        const trimmed = executed.trim();
        executedSet.add(trimmed);
        executedSet.add(trimmed.toLowerCase());
        // Also normalize separator formats (e.g. 'home-desktop' -> 'home:desktop')
        if (trimmed.includes('-') && !trimmed.includes(':')) {
          const lastDash = trimmed.lastIndexOf('-');
          const normalized = `${trimmed.slice(0, lastDash)}:${trimmed.slice(lastDash + 1)}`;
          executedSet.add(normalized);
          executedSet.add(normalized.toLowerCase());
        }
      } else if (executed && typeof executed === 'object') {
        const execObj = executed as Record<string, unknown>;
        if (typeof execObj.id === 'string') {
          executedSet.add(execObj.id);
          executedSet.add(execObj.id.toLowerCase());
        }
        if (typeof execObj.legId === 'string') {
          executedSet.add(execObj.legId);
          executedSet.add(execObj.legId.toLowerCase());
        }
        const surface = typeof execObj.surface === 'string' ? execObj.surface : '';
        let vpName = '';
        if (typeof execObj.viewport === 'string') {
          vpName = execObj.viewport;
        } else if (execObj.viewport && typeof execObj.viewport === 'object') {
          const vpObj = execObj.viewport as Record<string, unknown>;
          if (typeof vpObj.name === 'string') {
            vpName = vpObj.name;
          }
        }
        if (surface && vpName) {
          executedSet.add(`${surface}:${vpName}`);
          executedSet.add(`${surface}:${vpName}`.toLowerCase());
          executedSet.add(`${surface}-${vpName}`);
        }
      }
    }

    const missingLegs: string[] = [];

    for (const leg of matrix) {
      const legObj = leg as Record<string, unknown>;
      const legId = typeof legObj.id === 'string' ? legObj.id : '';
      const surface = typeof legObj.surface === 'string' ? legObj.surface : '';
      let vpName = '';
      if (legObj.viewport && typeof legObj.viewport === 'object') {
        const vp = legObj.viewport as Record<string, unknown>;
        if (typeof vp.name === 'string') {
          vpName = vp.name;
        }
      }

      const canonicalId = legId || (surface && vpName ? `${surface}:${vpName}` : '');
      const dashId = surface && vpName ? `${surface}-${vpName}` : '';

      const isCovered =
        (canonicalId && executedSet.has(canonicalId)) ||
        (canonicalId && executedSet.has(canonicalId.toLowerCase())) ||
        (dashId && executedSet.has(dashId)) ||
        (dashId && executedSet.has(dashId.toLowerCase())) ||
        (executedLegs as unknown[]).includes(leg);
      if (!isCovered) {
        missingLegs.push(canonicalId || 'unknown-leg');
      }
    }

    const totalLegs = matrix.length;
    const executedCount = totalLegs - missingLegs.length;
    const coveragePercentage = totalLegs > 0 ? Number(((executedCount / totalLegs) * 100).toFixed(2)) : 100;
    const isComplete = missingLegs.length === 0 && totalLegs > 0;

    return {
      coveragePercentage,
      missingLegs,
      isComplete,
      totalLegs,
      executedCount,
    };
  }

  /**
   * Serializes the surface evaluation matrix to a target JSON file on disk.
   * Recursively creates target directory structure if absent.
   */
  public async exportSurfaceInventory(
    targetPath: string,
    matrix: Array<CampaignMatrixLeg | Record<string, unknown>>
  ): Promise<void> {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new Error('HaravanCampaignMatrix.exportSurfaceInventory: targetPath must be a non-empty string');
    }

    let resolvedFilePath = path.resolve(targetPath);
    if (!resolvedFilePath.endsWith('.json')) {
      resolvedFilePath = path.join(resolvedFilePath, 'surface-inventory.json');
    }

    const parentDir = path.dirname(resolvedFilePath);
    await fs.mkdir(parentDir, { recursive: true });

    const content = JSON.stringify(matrix, null, 2);
    await fs.writeFile(resolvedFilePath, content, 'utf-8');
  }

  /**
   * Deserializes a surface evaluation matrix from a target JSON file on disk.
   */
  public async importSurfaceInventory(sourcePath: string): Promise<CampaignMatrixLeg[]> {
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new Error('HaravanCampaignMatrix.importSurfaceInventory: sourcePath must be a non-empty string');
    }

    const resolvedFilePath = path.resolve(sourcePath);
    const content = await fs.readFile(resolvedFilePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.legs)) {
        return record.legs as CampaignMatrixLeg[];
      }
      if (Array.isArray(record.matrix)) {
        return record.matrix as CampaignMatrixLeg[];
      }
    }
    return [];
  }

  // --- Static Convenience Proxies ---

  public static buildFullMatrix(inventory?: StoreInventory | Record<string, unknown> | null): CampaignMatrixLeg[] {
    return new HaravanCampaignMatrix().buildFullMatrix(inventory);
  }

  public static validateMatrixCoverage(
    matrix: Array<CampaignMatrixLeg | Record<string, unknown>>,
    executedLegs: Array<string | CampaignMatrixLeg | Record<string, unknown>>
  ): MatrixCoverageReport {
    return new HaravanCampaignMatrix().validateMatrixCoverage(matrix, executedLegs);
  }

  public static async exportSurfaceInventory(
    targetPath: string,
    matrix: Array<CampaignMatrixLeg | Record<string, unknown>>
  ): Promise<void> {
    return new HaravanCampaignMatrix().exportSurfaceInventory(targetPath, matrix);
  }

  public static async importSurfaceInventory(sourcePath: string): Promise<CampaignMatrixLeg[]> {
    return new HaravanCampaignMatrix().importSurfaceInventory(sourcePath);
  }

  // --- Private Catalog & Route Binding Helpers ---

  private resolveSurfaceBindings(
    inventory?: StoreInventory | Record<string, unknown> | null
  ): Map<CanonicalSurfaceName, { url: string; canonicalUrl: string; boundEntity?: BoundEntityInfo }> {
    const bindings = new Map<CanonicalSurfaceName, { url: string; canonicalUrl: string; boundEntity?: BoundEntityInfo }>();

    const invRecord = (inventory && typeof inventory === 'object' ? inventory : {}) as Record<string, unknown>;
    const products = Array.isArray(invRecord.products)
      ? (invRecord.products as InventoryProduct[])
      : [];
    const collections = Array.isArray(invRecord.collections)
      ? (invRecord.collections as InventoryCollection[])
      : [];
    const articles = Array.isArray(invRecord.articles)
      ? (invRecord.articles as InventoryArticle[])
      : [];
    const blogs = Array.isArray(invRecord.blogs)
      ? (invRecord.blogs as InventoryBlog[])
      : [];
    const pages = Array.isArray(invRecord.pages)
      ? (invRecord.pages as InventoryPage[])
      : [];

    // 1. Home
    const homeRef = this.routeResolver.resolveReferenceUrl('/');
    const homeHaravan = this.routeResolver.mapToHaravanRoute(homeRef);
    bindings.set('home', {
      url: '/',
      canonicalUrl: homeHaravan.canonicalUrl,
      boundEntity: { type: 'root', title: 'Home' },
    });

    // 2. Product Standard
    const standardProduct = products.find((p) => Array.isArray(p.variants) && p.variants.length > 0) || products[0];
    if (standardProduct) {
      const prodUrl = `/products/${standardProduct.handle}`;
      const prodRef = this.routeResolver.resolveReferenceUrl(prodUrl);
      const prodHaravan = this.routeResolver.mapToHaravanRoute(prodRef);
      bindings.set('product-standard', {
        url: prodUrl,
        canonicalUrl: prodHaravan.canonicalUrl,
        boundEntity: {
          type: 'product',
          id: standardProduct.id,
          handle: standardProduct.handle,
          title: standardProduct.title,
        },
      });
    }

    // 3. Product Variants
    const multiVariantProduct =
      products.find((p) => Array.isArray(p.variants) && p.variants.length > 1) || standardProduct;
    if (multiVariantProduct) {
      const variants = multiVariantProduct.variants || [];
      const selectedVariant = variants.length > 1 ? variants[1] : variants[0];
      const variantId = (selectedVariant?.id as number | string | undefined) ?? 'variant-2';
      const variantUrl = `/products/${multiVariantProduct.handle}?variant=${variantId}`;
      const baseRef = this.routeResolver.resolveReferenceUrl(`/products/${multiVariantProduct.handle}`);
      const baseHaravan = this.routeResolver.mapToHaravanRoute(baseRef);
      bindings.set('product-variants', {
        url: variantUrl,
        canonicalUrl: baseHaravan.canonicalUrl,
        boundEntity: {
          type: 'product',
          id: multiVariantProduct.id,
          handle: multiVariantProduct.handle,
          title: multiVariantProduct.title,
          selectedVariantId: variantId,
        },
      });
    }

    // 4. Product Out-of-Stock
    const outOfStockProduct =
      products.find((p) => {
        const hasOosTag =
          Array.isArray(p.tags) &&
          p.tags.some((t) => ['out-of-stock', 'sold-out', 'het-hang'].includes(t.toLowerCase()));
        const hasOosVariant =
          Array.isArray(p.variants) &&
          p.variants.some((v) => v.available === false || v.inventory_quantity === 0);
        return hasOosTag || hasOosVariant;
      }) || standardProduct;

    if (outOfStockProduct) {
      const oosUrl = `/products/${outOfStockProduct.handle}?state=out_of_stock`;
      const baseRef = this.routeResolver.resolveReferenceUrl(`/products/${outOfStockProduct.handle}`);
      const baseHaravan = this.routeResolver.mapToHaravanRoute(baseRef);
      bindings.set('product-out-of-stock', {
        url: oosUrl,
        canonicalUrl: baseHaravan.canonicalUrl,
        boundEntity: {
          type: 'product',
          id: outOfStockProduct.id,
          handle: outOfStockProduct.handle,
          title: outOfStockProduct.title,
          available: false,
        },
      });
    }

    // 5. Collection Grid
    const gridCollection = collections.find((c) => (c.productsCount ?? 0) > 0) || collections[0];
    if (gridCollection) {
      const colUrl = `/collections/${gridCollection.handle}`;
      const colRef = this.routeResolver.resolveReferenceUrl(colUrl);
      const colHaravan = this.routeResolver.mapToHaravanRoute(colRef);
      bindings.set('collection-grid', {
        url: colUrl,
        canonicalUrl: colHaravan.canonicalUrl,
        boundEntity: {
          type: 'collection',
          id: gridCollection.id,
          handle: gridCollection.handle,
          title: gridCollection.title,
          productsCount: gridCollection.productsCount,
        },
      });
    }

    // 6. Collection Filtered
    const activeFilterTag = products.flatMap((p) => p.tags || []).find((t) => Boolean(t && t.length > 0)) || 'sale';
    const targetFilteredCol = gridCollection || { id: 1, handle: 'all', title: 'All Products', productsCount: 1 };
    const filteredUrl = `/collections/${targetFilteredCol.handle}?filter=${encodeURIComponent(activeFilterTag)}`;
    const baseColRef = this.routeResolver.resolveReferenceUrl(`/collections/${targetFilteredCol.handle}`);
    const baseColHaravan = this.routeResolver.mapToHaravanRoute(baseColRef);
    bindings.set('collection-filtered', {
      url: filteredUrl,
      canonicalUrl: baseColHaravan.canonicalUrl,
      boundEntity: {
        type: 'collection',
        id: targetFilteredCol.id,
        handle: targetFilteredCol.handle,
        title: targetFilteredCol.title,
        activeFilter: activeFilterTag,
      },
    });

    // 7. Collection Empty
    const emptyCollection = collections.find((c) => c.productsCount === 0);
    if (emptyCollection) {
      const emptyUrl = `/collections/${emptyCollection.handle}`;
      const emptyRef = this.routeResolver.resolveReferenceUrl(emptyUrl);
      const emptyHaravan = this.routeResolver.mapToHaravanRoute(emptyRef);
      bindings.set('collection-empty', {
        url: emptyUrl,
        canonicalUrl: emptyHaravan.canonicalUrl,
        boundEntity: {
          type: 'collection',
          id: emptyCollection.id,
          handle: emptyCollection.handle,
          title: emptyCollection.title,
          productsCount: 0,
        },
      });
    } else {
      const emptyHandle = 'empty-collection';
      const emptyUrl = `/collections/${emptyHandle}`;
      bindings.set('collection-empty', {
        url: emptyUrl,
        canonicalUrl: emptyUrl,
        boundEntity: {
          type: 'collection',
          handle: emptyHandle,
          title: 'Empty Collection',
          productsCount: 0,
        },
      });
    }

    // 8. Blog Listing
    const blog = blogs[0];
    if (blog) {
      const blogUrl = `/blogs/${blog.handle}`;
      const blogRef = this.routeResolver.resolveReferenceUrl(blogUrl);
      const blogHaravan = this.routeResolver.mapToHaravanRoute(blogRef);
      bindings.set('blog-listing', {
        url: blogUrl,
        canonicalUrl: blogHaravan.canonicalUrl,
        boundEntity: {
          type: 'blog',
          id: blog.id,
          handle: blog.handle,
          title: blog.title,
        },
      });
    }

    // 9. Article Detail
    const article = articles[0];
    if (article) {
      const blogHandle = article.blogHandle || (blog ? blog.handle : 'news');
      const articleUrl = `/blogs/${blogHandle}/${article.handle}`;
      const articleRef = this.routeResolver.resolveReferenceUrl(articleUrl);
      const articleHaravan = this.routeResolver.mapToHaravanRoute(articleRef);
      bindings.set('article-detail', {
        url: articleUrl,
        canonicalUrl: articleHaravan.canonicalUrl,
        boundEntity: {
          type: 'article',
          id: article.id,
          handle: article.handle,
          blogHandle,
          title: article.title,
        },
      });
    }

    // 10. Article Comments
    const articleWithComments = articles[0];
    if (articleWithComments) {
      const blogHandle = articleWithComments.blogHandle || (blog ? blog.handle : 'news');
      const commentsUrl = `/blogs/${blogHandle}/${articleWithComments.handle}#comments`;
      const baseArtRef = this.routeResolver.resolveReferenceUrl(`/blogs/${blogHandle}/${articleWithComments.handle}`);
      const baseArtHaravan = this.routeResolver.mapToHaravanRoute(baseArtRef);
      bindings.set('article-comments', {
        url: commentsUrl,
        canonicalUrl: baseArtHaravan.canonicalUrl,
        boundEntity: {
          type: 'article',
          id: articleWithComments.id,
          handle: articleWithComments.handle,
          blogHandle,
          title: articleWithComments.title,
          hasComments: true,
        },
      });
    }

    // 11. Page Standard
    const standardPage =
      pages.find((p) => p.handle !== 'contact' && p.handle !== 'lien-he') || pages[0];
    if (standardPage) {
      const pageUrl = `/pages/${standardPage.handle}`;
      const pageRef = this.routeResolver.resolveReferenceUrl(pageUrl);
      const pageHaravan = this.routeResolver.mapToHaravanRoute(pageRef);
      bindings.set('page-standard', {
        url: pageUrl,
        canonicalUrl: pageHaravan.canonicalUrl,
        boundEntity: {
          type: 'page',
          id: standardPage.id,
          handle: standardPage.handle,
          title: standardPage.title,
        },
      });
    }

    // 12. Page Contact
    const contactPage = pages.find((p) =>
      ['contact', 'lien-he', 'lien-he-chung-toi'].includes(p.handle.toLowerCase())
    );
    if (contactPage) {
      const contactUrl = `/pages/${contactPage.handle}`;
      const contactRef = this.routeResolver.resolveReferenceUrl(contactUrl);
      const contactHaravan = this.routeResolver.mapToHaravanRoute(contactRef);
      bindings.set('page-contact', {
        url: contactUrl,
        canonicalUrl: contactHaravan.canonicalUrl,
        boundEntity: {
          type: 'page',
          id: contactPage.id,
          handle: contactPage.handle,
          title: contactPage.title,
          isContactForm: true,
        },
      });
    } else {
      const contactUrl = '/pages/contact';
      bindings.set('page-contact', {
        url: contactUrl,
        canonicalUrl: contactUrl,
        boundEntity: {
          type: 'page',
          handle: 'contact',
          title: 'Contact Us',
          isContactForm: true,
        },
      });
    }

    // 13. Cart Active
    const cartActiveRef = this.routeResolver.resolveReferenceUrl('/cart');
    const cartActiveHaravan = this.routeResolver.mapToHaravanRoute(cartActiveRef);
    bindings.set('cart-active', {
      url: '/cart',
      canonicalUrl: cartActiveHaravan.canonicalUrl,
      boundEntity: {
        type: 'cart',
        state: 'active',
        hasLineItems: true,
      },
    });

    // 14. Cart Empty
    const cartEmptyRef = this.routeResolver.resolveReferenceUrl('/cart');
    const cartEmptyHaravan = this.routeResolver.mapToHaravanRoute(cartEmptyRef);
    bindings.set('cart-empty', {
      url: '/cart?state=empty',
      canonicalUrl: cartEmptyHaravan.canonicalUrl,
      boundEntity: {
        type: 'cart',
        state: 'empty',
        hasLineItems: false,
      },
    });

    // 15. Search Results
    const searchKeyword = standardProduct?.title ? standardProduct.title.split(' ')[0] : 'shirt';
    const searchUrl = `/search?q=${encodeURIComponent(searchKeyword)}`;
    const searchRef = this.routeResolver.resolveReferenceUrl(searchUrl);
    const searchHaravan = this.routeResolver.mapToHaravanRoute(searchRef);
    bindings.set('search-results', {
      url: searchUrl,
      canonicalUrl: searchHaravan.canonicalUrl,
      boundEntity: {
        type: 'search',
        query: searchKeyword,
      },
    });

    return bindings;
  }
}
