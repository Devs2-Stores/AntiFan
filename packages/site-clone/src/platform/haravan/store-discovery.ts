/**
 * Haravan Store Discovery & Data Inventory (Audit §47 - §48, P0.2)
 *
 * Discovers and inventories store catalog, content, navigation, and theme assets
 * to ground cloning and prevent unverified synthetic assumptions.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ThemeAsset, StoreContext } from './types.js';

export interface InventoryProduct {
  id: number | string;
  title: string;
  handle: string;
  variants: Array<Record<string, unknown>>;
  images: string[];
  tags: string[];
}

export interface InventoryCollection {
  id: number | string;
  title: string;
  handle: string;
  productsCount: number;
}

export interface InventoryArticle {
  id: number | string;
  title: string;
  handle: string;
  blogHandle: string;
}

export interface InventoryBlog {
  id: number | string;
  title: string;
  handle: string;
}

export interface InventoryPage {
  id: number | string;
  title: string;
  handle: string;
}

export interface InventoryMenuItem {
  title: string;
  url: string;
  children?: InventoryMenuItem[];
}

export interface InventoryMenu {
  id: number | string;
  title: string;
  handle: string;
  items: InventoryMenuItem[];
}

export interface InventoryThemeSettings {
  data: Record<string, unknown>;
  schema?: Array<Record<string, unknown>>;
}

export interface StoreInventory {
  products: InventoryProduct[];
  collections: InventoryCollection[];
  articles: InventoryArticle[];
  blogs: InventoryBlog[];
  pages: InventoryPage[];
  menus: InventoryMenu[];
  themeSettings: InventoryThemeSettings;
  themeAssets: string[];
  capturedAt: string;
}

export interface InventoryValidationResult {
  isComplete: boolean;
  missingSurfaces: string[];
  warnings: string[];
}

export interface HaravanDiscoveryAdapter {
  getStoreContext?(): Promise<StoreContext>;
  getProducts?(options?: unknown): Promise<unknown[]>;
  getCollections?(options?: unknown): Promise<unknown[]>;
  getBlogs?(): Promise<unknown[]>;
  getArticles?(options?: unknown): Promise<unknown[]>;
  getPages?(options?: unknown): Promise<unknown[]>;
  getMenus?(): Promise<unknown[]>;
  getThemeSettings?(themeId?: number | string): Promise<unknown>;
  getThemeAssets?(themeId?: number | string): Promise<ThemeAsset[] | string[]>;
  fetchProducts?(): Promise<unknown[]>;
  fetchCollections?(): Promise<unknown[]>;
  fetchBlogs?(): Promise<unknown[]>;
  fetchArticles?(): Promise<unknown[]>;
  fetchPages?(): Promise<unknown[]>;
  fetchMenus?(): Promise<unknown[]>;
  fetchThemeSettings?(themeId?: number | string): Promise<unknown>;
  fetchThemeAssets?(themeId?: number | string): Promise<ThemeAsset[] | string[]>;
  listProducts?(): Promise<unknown[]>;
  listCollections?(): Promise<unknown[]>;
  listBlogs?(): Promise<unknown[]>;
  listArticles?(): Promise<unknown[]>;
  listPages?(): Promise<unknown[]>;
  listMenus?(): Promise<unknown[]>;
  listThemeAssets?(themeId?: number | string): Promise<ThemeAsset[] | string[]>;
}

function extractString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const v = record[key];
  return typeof v === 'string' ? v : fallback;
}

function extractId(record: Record<string, unknown>, key = 'id'): number | string {
  const v = record[key];
  if (typeof v === 'number' || typeof v === 'string') {
    return v;
  }
  return '';
}

export class StoreDiscovery {
  /**
   * Discovers all store entities and theme metadata via the platform adapter.
   */
  async discoverStore(adapter: HaravanDiscoveryAdapter | unknown): Promise<StoreInventory> {
    if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
      throw new Error('StoreDiscovery.discoverStore: Adapter instance is required');
    }

    const ad = adapter as HaravanDiscoveryAdapter;

    // Resolve context for store context and active themeId
    let themeId: number | string | undefined;
    try {
      if (typeof ad.getStoreContext === 'function') {
        const ctx = await ad.getStoreContext();
        themeId = ctx?.themeId;
      }
    } catch {
      // Stateless adapters might not implement getStoreContext
    }

    // Safely invoke and resolve all discovery surfaces concurrently
    const [
      rawProducts,
      rawCollections,
      rawBlogs,
      rawArticles,
      rawPages,
      rawMenus,
      rawThemeSettings,
      rawThemeAssets,
    ] = await Promise.all([
      (async () => {
        try {
          if (typeof ad.getProducts === 'function') return await ad.getProducts();
          if (typeof ad.fetchProducts === 'function') return await ad.fetchProducts();
          if (typeof ad.listProducts === 'function') return await ad.listProducts();
        } catch {
          return [];
        }
        return [];
      })(),
      (async () => {
        try {
          if (typeof ad.getCollections === 'function') return await ad.getCollections();
          if (typeof ad.fetchCollections === 'function') return await ad.fetchCollections();
          if (typeof ad.listCollections === 'function') return await ad.listCollections();
        } catch {
          return [];
        }
        return [];
      })(),
      (async () => {
        try {
          if (typeof ad.getBlogs === 'function') return await ad.getBlogs();
          if (typeof ad.fetchBlogs === 'function') return await ad.fetchBlogs();
          if (typeof ad.listBlogs === 'function') return await ad.listBlogs();
        } catch {
          return [];
        }
        return [];
      })(),
      (async () => {
        try {
          if (typeof ad.getArticles === 'function') return await ad.getArticles();
          if (typeof ad.fetchArticles === 'function') return await ad.fetchArticles();
          if (typeof ad.listArticles === 'function') return await ad.listArticles();
        } catch {
          return [];
        }
        return [];
      })(),
      (async () => {
        try {
          if (typeof ad.getPages === 'function') return await ad.getPages();
          if (typeof ad.fetchPages === 'function') return await ad.fetchPages();
          if (typeof ad.listPages === 'function') return await ad.listPages();
        } catch {
          return [];
        }
        return [];
      })(),
      (async () => {
        try {
          if (typeof ad.getMenus === 'function') return await ad.getMenus();
          if (typeof ad.fetchMenus === 'function') return await ad.fetchMenus();
          if (typeof ad.listMenus === 'function') return await ad.listMenus();
        } catch {
          return [];
        }
        return [];
      })(),
      (async () => {
        try {
          if (typeof ad.getThemeSettings === 'function') return await ad.getThemeSettings(themeId);
          if (typeof ad.fetchThemeSettings === 'function') return await ad.fetchThemeSettings(themeId);
        } catch {
          return { data: {} };
        }
        return { data: {} };
      })(),
      (async () => {
        try {
          if (typeof ad.getThemeAssets === 'function') return await ad.getThemeAssets(themeId);
          if (typeof ad.fetchThemeAssets === 'function') return await ad.fetchThemeAssets(themeId);
          if (typeof ad.listThemeAssets === 'function') return await ad.listThemeAssets(themeId);
        } catch {
          return [];
        }
        return [];
      })(),
    ]);

    // Normalize Blogs first to construct blogId -> blogHandle lookup
    const blogs: InventoryBlog[] = [];
    if (Array.isArray(rawBlogs)) {
      for (const b of rawBlogs) {
        if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
        const rec = b as Record<string, unknown>;
        blogs.push({
          id: extractId(rec),
          title: extractString(rec, 'title'),
          handle: extractString(rec, 'handle'),
        });
      }
    }

    const blogIdToHandleMap: Record<string, string> = {};
    for (const b of blogs) {
      if (b.id !== '') {
        blogIdToHandleMap[String(b.id)] = b.handle;
      }
    }

    // Normalize Products
    const products: InventoryProduct[] = [];
    if (Array.isArray(rawProducts)) {
      for (const p of rawProducts) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
        const rec = p as Record<string, unknown>;

        let images: string[] = [];
        if (Array.isArray(rec.images)) {
          for (const img of rec.images) {
            if (typeof img === 'string') {
              if (img) images.push(img);
            } else if (img && typeof img === 'object' && !Array.isArray(img)) {
              const imgObj = img as Record<string, unknown>;
              if (typeof imgObj.src === 'string' && imgObj.src) {
                images.push(imgObj.src);
              }
            }
          }
        } else if (typeof rec.image === 'string' && rec.image) {
          images = [rec.image];
        } else if (rec.image && typeof rec.image === 'object' && !Array.isArray(rec.image)) {
          const imgObj = rec.image as Record<string, unknown>;
          if (typeof imgObj.src === 'string' && imgObj.src) {
            images = [imgObj.src];
          }
        }

        let tags: string[] = [];
        if (Array.isArray(rec.tags)) {
          tags = rec.tags
            .map(t => (typeof t === 'string' ? t.trim() : String(t).trim()))
            .filter(t => t.length > 0);
        } else if (typeof rec.tags === 'string') {
          tags = rec.tags
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);
        }

        const variants: Array<Record<string, unknown>> = [];
        if (Array.isArray(rec.variants)) {
          for (const v of rec.variants) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              variants.push(v as Record<string, unknown>);
            }
          }
        }

        products.push({
          id: extractId(rec),
          title: extractString(rec, 'title'),
          handle: extractString(rec, 'handle'),
          variants,
          images,
          tags,
        });
      }
    }

    // Normalize Collections
    const collections: InventoryCollection[] = [];
    if (Array.isArray(rawCollections)) {
      for (const c of rawCollections) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
        const rec = c as Record<string, unknown>;

        let count = 0;
        if (typeof rec.productsCount === 'number') count = rec.productsCount;
        else if (typeof rec.products_count === 'number') count = rec.products_count;
        else if (Array.isArray(rec.products)) count = rec.products.length;

        collections.push({
          id: extractId(rec),
          title: extractString(rec, 'title'),
          handle: extractString(rec, 'handle'),
          productsCount: count,
        });
      }
    }

    // Normalize Articles
    const articles: InventoryArticle[] = [];
    if (Array.isArray(rawArticles)) {
      for (const a of rawArticles) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
        const rec = a as Record<string, unknown>;

        let blogHandle = extractString(rec, 'blogHandle');
        if (!blogHandle) {
          blogHandle = extractString(rec, 'blog_handle');
        }
        if (!blogHandle) {
          const bId = rec.blog_id ?? rec.blogId;
          if (bId !== undefined && bId !== null && blogIdToHandleMap[String(bId)]) {
            blogHandle = blogIdToHandleMap[String(bId)];
          }
        }

        articles.push({
          id: extractId(rec),
          title: extractString(rec, 'title'),
          handle: extractString(rec, 'handle'),
          blogHandle,
        });
      }
    }

    // Normalize Pages
    const pages: InventoryPage[] = [];
    if (Array.isArray(rawPages)) {
      for (const pg of rawPages) {
        if (!pg || typeof pg !== 'object' || Array.isArray(pg)) continue;
        const rec = pg as Record<string, unknown>;
        pages.push({
          id: extractId(rec),
          title: extractString(rec, 'title'),
          handle: extractString(rec, 'handle'),
        });
      }
    }

    // Normalize Menus
    const menus: InventoryMenu[] = [];
    if (Array.isArray(rawMenus)) {
      for (const m of rawMenus) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
        const rec = m as Record<string, unknown>;
        const items = this.normalizeMenuItems(rec.items);
        menus.push({
          id: extractId(rec),
          title: extractString(rec, 'title'),
          handle: extractString(rec, 'handle'),
          items,
        });
      }
    }

    // Normalize Theme Settings
    let themeSettings: InventoryThemeSettings = { data: {} };
    if (rawThemeSettings && typeof rawThemeSettings === 'object' && !Array.isArray(rawThemeSettings)) {
      const rec = rawThemeSettings as Record<string, unknown>;
      if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
        themeSettings = {
          data: rec.data as Record<string, unknown>,
        };
        if (Array.isArray(rec.schema)) {
          themeSettings.schema = rec.schema.filter(s => s && typeof s === 'object' && !Array.isArray(s)) as Array<Record<string, unknown>>;
        }
      } else {
        themeSettings = {
          data: rec,
        };
      }
    }

    // Normalize Theme Assets
    let themeAssets: string[] = [];
    if (Array.isArray(rawThemeAssets)) {
      for (const asset of rawThemeAssets) {
        if (typeof asset === 'string' && asset.length > 0) {
          themeAssets.push(asset);
        } else if (asset && typeof asset === 'object' && 'key' in asset) {
          const key = asset.key;
          if (typeof key === 'string' && key.length > 0) {
            themeAssets.push(key);
          }
        }
      }
    }

    return {
      products,
      collections,
      articles,
      blogs,
      pages,
      menus,
      themeSettings,
      themeAssets,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Atomically writes the store inventory to inventory.json in the target directory.
   */
  async saveInventory(inventory: StoreInventory, targetDir: string): Promise<string> {
    if (!inventory || typeof inventory !== 'object') {
      throw new Error('StoreDiscovery.saveInventory: Invalid inventory object');
    }
    if (!targetDir || typeof targetDir !== 'string') {
      throw new Error('StoreDiscovery.saveInventory: targetDir must be a valid directory path');
    }

    await fs.mkdir(targetDir, { recursive: true });

    const targetFile = path.join(targetDir, 'inventory.json');
    const tempFile = path.join(
      targetDir,
      `.inventory.json.tmp.${Date.now()}.${randomUUID().replace(/-/g, '')}`
    );

    const serialized = JSON.stringify(inventory, null, 2);

    try {
      await fs.writeFile(tempFile, serialized, 'utf-8');
      await fs.rename(tempFile, targetFile);
    } catch (err) {
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore temp file cleanup error
      }
      throw err;
    }

    return targetFile;
  }

  /**
   * Loads and validates inventory.json from source directory or file path.
   */
  async loadInventory(sourceDir: string): Promise<StoreInventory> {
    if (!sourceDir || typeof sourceDir !== 'string') {
      throw new Error('StoreDiscovery.loadInventory: sourceDir must be provided');
    }

    let filePath = sourceDir;
    if (!filePath.endsWith('.json')) {
      filePath = path.join(sourceDir, 'inventory.json');
    }

    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`StoreDiscovery.loadInventory: Invalid JSON format in ${filePath}`);
    }

    const rec = parsed as Record<string, unknown>;

    const themeSettingsRaw = rec.themeSettings && typeof rec.themeSettings === 'object' && !Array.isArray(rec.themeSettings)
      ? (rec.themeSettings as Record<string, unknown>)
      : {};

    const themeSettingsData = themeSettingsRaw.data && typeof themeSettingsRaw.data === 'object' && !Array.isArray(themeSettingsRaw.data)
      ? (themeSettingsRaw.data as Record<string, unknown>)
      : {};

    const themeSettingsSchema = Array.isArray(themeSettingsRaw.schema)
      ? (themeSettingsRaw.schema.filter(s => s && typeof s === 'object' && !Array.isArray(s)) as Array<Record<string, unknown>>)
      : undefined;

    const products: InventoryProduct[] = [];
    if (Array.isArray(rec.products)) {
      for (const p of rec.products) {
        if (p && typeof p === 'object' && !Array.isArray(p)) {
          const pRec = p as Record<string, unknown>;
          products.push({
            id: extractId(pRec),
            title: extractString(pRec, 'title'),
            handle: extractString(pRec, 'handle'),
            variants: Array.isArray(pRec.variants)
              ? (pRec.variants.filter(v => v && typeof v === 'object' && !Array.isArray(v)) as Array<Record<string, unknown>>)
              : [],
            images: Array.isArray(pRec.images) ? pRec.images.filter((img): img is string => typeof img === 'string') : [],
            tags: Array.isArray(pRec.tags) ? pRec.tags.filter((t): t is string => typeof t === 'string') : [],
          });
        }
      }
    }

    const collections: InventoryCollection[] = [];
    if (Array.isArray(rec.collections)) {
      for (const c of rec.collections) {
        if (c && typeof c === 'object' && !Array.isArray(c)) {
          const cRec = c as Record<string, unknown>;
          collections.push({
            id: extractId(cRec),
            title: extractString(cRec, 'title'),
            handle: extractString(cRec, 'handle'),
            productsCount: typeof cRec.productsCount === 'number' ? cRec.productsCount : 0,
          });
        }
      }
    }

    const articles: InventoryArticle[] = [];
    if (Array.isArray(rec.articles)) {
      for (const a of rec.articles) {
        if (a && typeof a === 'object' && !Array.isArray(a)) {
          const aRec = a as Record<string, unknown>;
          articles.push({
            id: extractId(aRec),
            title: extractString(aRec, 'title'),
            handle: extractString(aRec, 'handle'),
            blogHandle: extractString(aRec, 'blogHandle'),
          });
        }
      }
    }

    const blogs: InventoryBlog[] = [];
    if (Array.isArray(rec.blogs)) {
      for (const b of rec.blogs) {
        if (b && typeof b !== 'object' && Array.isArray(b)) continue;
        if (b && typeof b === 'object') {
          const bRec = b as Record<string, unknown>;
          blogs.push({
            id: extractId(bRec),
            title: extractString(bRec, 'title'),
            handle: extractString(bRec, 'handle'),
          });
        }
      }
    }

    const pages: InventoryPage[] = [];
    if (Array.isArray(rec.pages)) {
      for (const pg of rec.pages) {
        if (pg && typeof pg === 'object' && !Array.isArray(pg)) {
          const pgRec = pg as Record<string, unknown>;
          pages.push({
            id: extractId(pgRec),
            title: extractString(pgRec, 'title'),
            handle: extractString(pgRec, 'handle'),
          });
        }
      }
    }

    const menus: InventoryMenu[] = [];
    if (Array.isArray(rec.menus)) {
      for (const m of rec.menus) {
        if (m && typeof m === 'object' && !Array.isArray(m)) {
          const mRec = m as Record<string, unknown>;
          menus.push({
            id: extractId(mRec),
            title: extractString(mRec, 'title'),
            handle: extractString(mRec, 'handle'),
            items: this.normalizeMenuItems(mRec.items),
          });
        }
      }
    }

    const themeAssets: string[] = Array.isArray(rec.themeAssets)
      ? rec.themeAssets.filter((a): a is string => typeof a === 'string')
      : [];

    return {
      products,
      collections,
      articles,
      blogs,
      pages,
      menus,
      themeSettings: {
        data: themeSettingsData,
        ...(themeSettingsSchema !== undefined ? { schema: themeSettingsSchema } : {}),
      },
      themeAssets,
      capturedAt: typeof rec.capturedAt === 'string' ? rec.capturedAt : new Date().toISOString(),
    };
  }

  /**
   * Validates inventory completeness across critical storefront surfaces.
   */
  validateCompleteness(inventory: StoreInventory): InventoryValidationResult {
    const missingSurfaces: string[] = [];
    const warnings: string[] = [];

    if (!inventory || typeof inventory !== 'object') {
      return {
        isComplete: false,
        missingSurfaces: ['inventory'],
        warnings: ['Inventory is null or undefined'],
      };
    }

    // 1. Products surface
    if (!Array.isArray(inventory.products) || inventory.products.length === 0) {
      missingSurfaces.push('products');
    } else {
      const missingVariants = inventory.products.filter(p => !Array.isArray(p.variants) || p.variants.length === 0);
      if (missingVariants.length > 0) {
        warnings.push(`${missingVariants.length} product(s) have zero variants`);
      }
      const missingImages = inventory.products.filter(p => !Array.isArray(p.images) || p.images.length === 0);
      if (missingImages.length > 0) {
        warnings.push(`${missingImages.length} product(s) have zero images`);
      }
    }

    // 2. Collections surface
    if (!Array.isArray(inventory.collections) || inventory.collections.length === 0) {
      missingSurfaces.push('collections');
    }

    // 3. Pages surface
    if (!Array.isArray(inventory.pages) || inventory.pages.length === 0) {
      missingSurfaces.push('pages');
    }

    // 4. Navigation Menus surface
    if (!Array.isArray(inventory.menus) || inventory.menus.length === 0) {
      missingSurfaces.push('menus');
    } else {
      const emptyMenus = inventory.menus.filter(m => !Array.isArray(m.items) || m.items.length === 0);
      if (emptyMenus.length > 0) {
        warnings.push(`${emptyMenus.length} menu(s) have empty items`);
      }
    }

    // 5. Theme Assets surface
    if (!Array.isArray(inventory.themeAssets) || inventory.themeAssets.length === 0) {
      missingSurfaces.push('themeAssets');
    } else {
      const essentialAssets = ['layout/theme.liquid', 'config/settings_data.json'];
      for (const essential of essentialAssets) {
        if (!inventory.themeAssets.includes(essential)) {
          warnings.push(`Essential theme asset '${essential}' is missing from inventory`);
        }
      }
    }

    // 6. Theme Settings surface
    if (
      !inventory.themeSettings ||
      !inventory.themeSettings.data ||
      Object.keys(inventory.themeSettings.data).length === 0
    ) {
      missingSurfaces.push('themeSettings');
    }

    // 7. Editorial / Content checks
    if (!Array.isArray(inventory.blogs) || inventory.blogs.length === 0) {
      warnings.push('No blogs found in store inventory');
    }
    if (!Array.isArray(inventory.articles) || inventory.articles.length === 0) {
      warnings.push('No articles found in store inventory');
    } else {
      const orphanedArticles = inventory.articles.filter(a => !a.blogHandle);
      if (orphanedArticles.length > 0) {
        warnings.push(`${orphanedArticles.length} article(s) do not have an associated blogHandle`);
      }
    }

    return {
      isComplete: missingSurfaces.length === 0,
      missingSurfaces,
      warnings,
    };
  }

  private normalizeMenuItems(rawItems: unknown): InventoryMenuItem[] {
    if (!Array.isArray(rawItems)) return [];
    const result: InventoryMenuItem[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const rawChildren = Array.isArray(rec.children)
        ? rec.children
        : (Array.isArray(rec.links) ? rec.links : undefined);

      const menuItem: InventoryMenuItem = {
        title: extractString(rec, 'title'),
        url: extractString(rec, 'url') || extractString(rec, 'link') || '/',
      };
      if (rawChildren) {
        menuItem.children = this.normalizeMenuItems(rawChildren);
      }
      result.push(menuItem);
    }
    return result;
  }
}
