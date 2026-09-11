import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  StoreDiscovery,
  StoreInventory,
  HaravanDiscoveryAdapter,
} from './store-discovery.js';
import { StoreContext, ThemeAsset } from './types.js';

describe('StoreDiscovery - Data Inventory & Platform Discovery (P0.2)', () => {
  const discovery = new StoreDiscovery();

  it('1. Throws descriptive error when discoverStore is called without an adapter', async () => {
    await assert.rejects(
      async () => {
        await discovery.discoverStore(null);
      },
      /Adapter instance is required/
    );
  });

  it('2. Discovers and normalizes complete store inventory via mock adapter', async () => {
    const mockContext: StoreContext = {
      store: 'test-shop',
      domain: 'test-shop.myharavan.com',
      themeId: 123456,
      environment: 'development',
      adminOrigin: 'https://admin.haravan.com',
    };

    const mockAdapter: HaravanDiscoveryAdapter = {
      async getStoreContext(): Promise<StoreContext> {
        return mockContext;
      },
      async getProducts(): Promise<unknown[]> {
        return [
          {
            id: 101,
            title: 'Schneider Electric LC1D09M7',
            handle: 'schneider-lc1d09m7',
            variants: [{ id: 1001, price: 250000, sku: 'LC1D09M7' }],
            images: ['https://file.hstatic.net/test/lc1d09m7.jpg', { src: 'https://file.hstatic.net/test/lc1d09m7-2.jpg' }],
            tags: ['contactor', 'schneider', '3p'],
          },
          {
            id: '102',
            title: 'Biến Tần ATV310 0.75kW',
            handle: 'atv310-0-75kw',
            variants: [{ id: 1002, price: 1800000 }],
            image: 'https://file.hstatic.net/test/atv310.jpg',
            tags: 'bien-tan, atv310, schneider',
          },
        ];
      },
      async getCollections(): Promise<unknown[]> {
        return [
          {
            id: 201,
            title: 'Thiết Bị Đóng Cắt',
            handle: 'thiet-bi-dong-cat',
            productsCount: 42,
          },
          {
            id: '202',
            title: 'Biến Tần & Khởi Động Mềm',
            handle: 'bien-tan-khoi-dong-mem',
            products_count: 15,
          },
        ];
      },
      async getBlogs(): Promise<unknown[]> {
        return [
          {
            id: 301,
            title: 'Tin Tức Kỹ Thuật',
            handle: 'tin-tuc-ky-thuat',
          },
        ];
      },
      async getArticles(): Promise<unknown[]> {
        return [
          {
            id: 401,
            title: 'Hướng dẫn cài đặt biến tần ATV310',
            handle: 'huong-dan-cai-dat-atv310',
            blog_id: 301,
          },
          {
            id: '402',
            title: 'Bảng giá khởi động từ Schneider 2026',
            handle: 'bang-gia-khoi-dong-tu-schneider',
            blogHandle: 'tin-tuc-ky-thuat',
          },
        ];
      },
      async getPages(): Promise<unknown[]> {
        return [
          {
            id: 501,
            title: 'Giới Thiệu Doanh Nghiệp',
            handle: 'about-us',
          },
          {
            id: '502',
            title: 'Chính Sách Bảo Hành',
            handle: 'chinh-sach-bao-hanh',
          },
        ];
      },
      async getMenus(): Promise<unknown[]> {
        return [
          {
            id: 601,
            title: 'Main Menu',
            handle: 'main-menu',
            items: [
              {
                title: 'Trang Chủ',
                url: '/',
              },
              {
                title: 'Sản Phẩm',
                url: '/collections/all',
                children: [
                  {
                    title: 'Khởi Động Từ',
                    url: '/collections/thiet-bi-dong-cat',
                  },
                ],
              },
            ],
          },
        ];
      },
      async getThemeSettings(themeId?: number | string): Promise<unknown> {
        assert.strictEqual(themeId, 123456);
        return {
          data: {
            color_primary: '#ff3300',
            typography_base_size: '15px',
          },
          schema: [{ name: 'Colors', settings: [] }],
        };
      },
      async getThemeAssets(themeId?: number | string): Promise<ThemeAsset[]> {
        assert.strictEqual(themeId, 123456);
        return [
          { key: 'layout/theme.liquid' },
          { key: 'config/settings_data.json' },
          { key: 'templates/index.liquid' },
          { key: 'assets/style.css' },
        ];
      },
    };

    const inventory = await discovery.discoverStore(mockAdapter);

    assert.strictEqual(inventory.products.length, 2);
    assert.strictEqual(inventory.products[0].id, 101);
    assert.strictEqual(inventory.products[0].handle, 'schneider-lc1d09m7');
    assert.strictEqual(inventory.products[0].images.length, 2);
    assert.deepStrictEqual(inventory.products[0].tags, ['contactor', 'schneider', '3p']);
    assert.strictEqual(inventory.products[1].images.length, 1);
    assert.deepStrictEqual(inventory.products[1].tags, ['bien-tan', 'atv310', 'schneider']);

    assert.strictEqual(inventory.collections.length, 2);
    assert.strictEqual(inventory.collections[0].productsCount, 42);
    assert.strictEqual(inventory.collections[1].productsCount, 15);

    assert.strictEqual(inventory.blogs.length, 1);
    assert.strictEqual(inventory.articles.length, 2);
    assert.strictEqual(inventory.articles[0].blogHandle, 'tin-tuc-ky-thuat', 'Maps blog_id to blogHandle');
    assert.strictEqual(inventory.articles[1].blogHandle, 'tin-tuc-ky-thuat');

    assert.strictEqual(inventory.pages.length, 2);
    assert.strictEqual(inventory.menus.length, 1);
    assert.strictEqual(inventory.menus[0].items.length, 2);
    assert.strictEqual(inventory.menus[0].items[1].children?.length, 1);

    assert.strictEqual(inventory.themeSettings.data.color_primary, '#ff3300');
    assert.ok(Array.isArray(inventory.themeSettings.schema));
    assert.deepStrictEqual(inventory.themeAssets, [
      'layout/theme.liquid',
      'config/settings_data.json',
      'templates/index.liquid',
      'assets/style.css',
    ]);
    assert.ok(inventory.capturedAt);
  });

  it('3. Resilient against degraded or partial adapter methods', async () => {
    const degradedAdapter = {
      async getProducts(): Promise<unknown[]> {
        return [{ id: 1, title: 'Item' }];
      },
      async getCollections(): Promise<unknown[]> {
        throw new Error('500 Internal Server Error');
      },
    };

    const inventory = await discovery.discoverStore(degradedAdapter);
    assert.strictEqual(inventory.products.length, 1);
    assert.deepStrictEqual(inventory.collections, []);
    assert.deepStrictEqual(inventory.articles, []);
    assert.deepStrictEqual(inventory.blogs, []);
    assert.deepStrictEqual(inventory.pages, []);
    assert.deepStrictEqual(inventory.menus, []);
    assert.deepStrictEqual(inventory.themeAssets, []);
    assert.deepStrictEqual(inventory.themeSettings.data, {});
  });

  it('4. Atomically persists inventory to inventory.json and loads it with full fidelity', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haravan-discovery-test-'));

    try {
      const sampleInventory: StoreInventory = {
        products: [
          {
            id: 999,
            title: 'Sample Product',
            handle: 'sample-product',
            variants: [{ id: 9991, price: 10000 }],
            images: ['https://cdn.example.com/p.jpg'],
            tags: ['promo'],
          },
        ],
        collections: [
          {
            id: 888,
            title: 'Sample Collection',
            handle: 'sample-collection',
            productsCount: 1,
          },
        ],
        articles: [],
        blogs: [],
        pages: [
          {
            id: 777,
            title: 'Sample Page',
            handle: 'sample-page',
          },
        ],
        menus: [
          {
            id: 666,
            title: 'Header Menu',
            handle: 'header-menu',
            items: [{ title: 'Home', url: '/' }],
          },
        ],
        themeSettings: {
          data: { layout: 'wide' },
        },
        themeAssets: ['layout/theme.liquid', 'config/settings_data.json'],
        capturedAt: '2026-09-12T10:00:00.000Z',
      };

      const savedPath = await discovery.saveInventory(sampleInventory, tmpDir);
      assert.strictEqual(savedPath, path.join(tmpDir, 'inventory.json'));

      // Check file exists on disk
      const stat = await fs.stat(savedPath);
      assert.ok(stat.isFile());

      // Load via directory path
      const loadedFromDir = await discovery.loadInventory(tmpDir);
      assert.deepStrictEqual(loadedFromDir, sampleInventory);

      // Load via explicit file path
      const loadedFromFile = await discovery.loadInventory(savedPath);
      assert.deepStrictEqual(loadedFromFile, sampleInventory);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. Validates inventory completeness and emits missing surfaces and warnings', () => {
    // A. Completely empty inventory
    const emptyInventory: StoreInventory = {
      products: [],
      collections: [],
      articles: [],
      blogs: [],
      pages: [],
      menus: [],
      themeSettings: { data: {} },
      themeAssets: [],
      capturedAt: new Date().toISOString(),
    };

    const emptyRes = discovery.validateCompleteness(emptyInventory);
    assert.strictEqual(emptyRes.isComplete, false);
    assert.ok(emptyRes.missingSurfaces.includes('products'));
    assert.ok(emptyRes.missingSurfaces.includes('collections'));
    assert.ok(emptyRes.missingSurfaces.includes('pages'));
    assert.ok(emptyRes.missingSurfaces.includes('menus'));
    assert.ok(emptyRes.missingSurfaces.includes('themeAssets'));
    assert.ok(emptyRes.missingSurfaces.includes('themeSettings'));

    // B. Complete inventory with edge warnings
    const warningInventory: StoreInventory = {
      products: [
        {
          id: 1,
          title: 'Product without variants or images',
          handle: 'no-var',
          variants: [],
          images: [],
          tags: [],
        },
      ],
      collections: [
        {
          id: 2,
          title: 'Empty Col',
          handle: 'empty-col',
          productsCount: 0,
        },
      ],
      articles: [
        {
          id: 3,
          title: 'Article without blog',
          handle: 'orphan-article',
          blogHandle: '',
        },
      ],
      blogs: [],
      pages: [
        {
          id: 4,
          title: 'Contact',
          handle: 'contact',
        },
      ],
      menus: [
        {
          id: 5,
          title: 'Empty Nav',
          handle: 'empty-nav',
          items: [],
        },
      ],
      themeSettings: {
        data: { primary_color: '#000' },
      },
      themeAssets: ['assets/theme.css'], // Missing layout/theme.liquid
      capturedAt: new Date().toISOString(),
    };

    const warnRes = discovery.validateCompleteness(warningInventory);
    assert.strictEqual(warnRes.isComplete, true, 'All surfaces are present, though with warnings');
    assert.strictEqual(warnRes.missingSurfaces.length, 0);
    assert.ok(warnRes.warnings.some(w => w.includes('zero variants')));
    assert.ok(warnRes.warnings.some(w => w.includes('zero images')));
    assert.ok(warnRes.warnings.some(w => w.includes('empty items')));
    assert.ok(warnRes.warnings.some(w => w.includes('Essential theme asset \'layout/theme.liquid\'')));
    assert.ok(warnRes.warnings.some(w => w.includes('No blogs found')));
    assert.ok(warnRes.warnings.some(w => w.includes('do not have an associated blogHandle')));
  });
});
