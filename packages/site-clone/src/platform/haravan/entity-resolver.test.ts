import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  EntityResolver,
  FixtureRegistry,
  normalizeText,
  normalizeHandle,
  slugify,
  titleize,
  HaravanProductFixture,
  HaravanCollectionFixture,
  HaravanArticleFixture,
  HaravanPageFixture
} from './entity-resolver.js';

describe('EntityResolver & FixtureRegistry (EXISTING_DATA_FIRST Policy)', () => {
  let registry: FixtureRegistry;
  let resolver: EntityResolver;

  beforeEach(() => {
    registry = new FixtureRegistry();
    resolver = new EntityResolver(registry);
  });

  // ==========================================================================
  // Helper Functions Tests
  // ==========================================================================
  describe('Helper Functions', () => {
    it('normalizes Vietnamese text and removes accents properly', () => {
      assert.strictEqual(normalizeText('Áo Thun Nam Cao Cấp'), 'ao thun nam cao cap');
      assert.strictEqual(normalizeText('Đầm Dạ Hội Nữ - 2026!'), 'dam da hoi nu 2026');
      assert.strictEqual(normalizeText('  Điện Thoại & Phụ Kiện  '), 'dien thoai phu kien');
      assert.strictEqual(normalizeText(''), '');
    });

    it('normalizes handles and extracts clean slug', () => {
      assert.strictEqual(normalizeHandle('/products/ao-thun-nam/'), 'ao-thun-nam');
      assert.strictEqual(normalizeHandle('https://store.myharavan.com/collections/dam-nu'), 'dam-nu');
      assert.strictEqual(normalizeHandle('blogs/news/bai-viet-1?view=amp#section'), 'bai-viet-1');
      assert.strictEqual(normalizeHandle('simple-handle'), 'simple-handle');
    });

    it('converts titles to slugs and vice-versa', () => {
      assert.strictEqual(slugify('Áo Thun Nam 100% Cotton'), 'ao-thun-nam-100-cotton');
      assert.strictEqual(titleize('ao-thun-nam-cotton'), 'Ao Thun Nam Cotton');
    });
  });

  // ==========================================================================
  // Step 1: Exact Handle Matching (§12)
  // ==========================================================================
  describe('Step 1: Exact Handle Matching', () => {
    const mockInventory = {
      products: [
        {
          id: 101,
          title: 'Áo Thun Nam Classic',
          handle: 'ao-thun-nam-classic',
          price: 250000,
          vendor: 'Coolmate'
        },
        {
          id: 102,
          title: 'Quần Jeans Slimfit',
          handle: 'quan-jeans-slimfit',
          price: 450000,
          vendor: 'Levi'
        }
      ],
      collections: [
        {
          id: 201,
          title: 'Bộ Sưu Tập Hè',
          handle: 'summer-collection',
          sort_order: 'manual'
        }
      ]
    };

    it('reuses existing product when handle matches exactly', async () => {
      const result = await resolver.resolveEntity<typeof mockInventory.products[0]>(
        {
          type: 'product',
          handle: 'ao-thun-nam-classic'
        },
        mockInventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 101);
      assert.ok(result.entity);
      assert.strictEqual(result.entity.title, 'Áo Thun Nam Classic');
      assert.strictEqual(result.fixtureCreated, undefined);
    });

    it('reuses existing product when handle has leading/trailing slashes or route prefix', async () => {
      const result = await resolver.resolveEntity(
        {
          type: 'product',
          handle: '/products/quan-jeans-slimfit/'
        },
        mockInventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 102);
    });

    it('matches collection when inventory is provided as flat array', async () => {
      const flatInventory = [
        { id: 201, type: 'collection', title: 'Bộ Sưu Tập Hè', handle: 'summer-collection' },
        { id: 202, type: 'collection', title: 'Thu Đông', handle: 'winter-collection' }
      ];

      const result = await resolver.resolveEntity(
        {
          type: 'collection',
          handle: 'summer-collection'
        },
        flatInventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 201);
    });

    it('matches entity by URL field if handle is omitted in candidate', async () => {
      const inventory = [
        { id: 501, title: 'Landing Page Test', url: '/pages/landing-page-canary' }
      ];

      const result = await resolver.resolveEntity(
        {
          type: 'page',
          handle: 'landing-page-canary'
        },
        inventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 501);
    });
  });

  // ==========================================================================
  // Step 2: Query by Normalized Title or Tags (§12, §49)
  // ==========================================================================
  describe('Step 2: Normalized Title & Tags Fuzzy Matching', () => {
    const mockInventory = [
      {
        id: 301,
        title: 'Áo Sơ Mi Nam Oxford Trắng',
        handle: 'so-mi-oxford-trang',
        tags: 'ao so mi, nam, oxford, cong so'
      },
      {
        id: 302,
        title: 'Đầm Nữ Xòe Hoa Nhí',
        handle: 'dam-xoe-hoa-nhi',
        tags: ['dam nu', 'vintage', 'mua he']
      },
      {
        id: 303,
        title: 'Giày Thể Thao Nam Running Pro',
        handle: 'giay-running-pro',
        tags: ['giay nam', 'running', 'the thao']
      }
    ];

    it('matches existing entity by normalized title (handling Vietnamese diacritics)', async () => {
      // Requirement title without accents should match entity with accents
      const result = await resolver.resolveEntity(
        {
          type: 'product',
          title: 'ao so mi nam oxford trang'
        },
        mockInventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 301);
      assert.ok(result.entity);
    });

    it('matches existing entity by partial/substring title match when handle is missing', async () => {
      const result = await resolver.resolveEntity(
        {
          type: 'product',
          title: 'Đầm Nữ Xòe'
        },
        mockInventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 302);
    });

    it('matches existing entity by matching tags', async () => {
      const result = await resolver.resolveEntity(
        {
          type: 'product',
          tags: ['running', 'the thao']
        },
        mockInventory
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 303);
    });

    it('prioritizes exact title match over tag match', async () => {
      const candidates = [
        { id: 401, title: 'Váy Công Sở', tags: ['vintage', 'summer'] },
        { id: 402, title: 'Đầm Dạ Hội Cao Cấp', tags: ['vintage'] }
      ];

      const result = await resolver.resolveEntity(
        {
          type: 'product',
          title: 'dam da hoi cao cap',
          tags: ['summer']
        },
        candidates
      );

      assert.strictEqual(result.action, 'REUSE_EXISTING');
      assert.strictEqual(result.matchedId, 402);
    });
  });

  // ==========================================================================
  // Step 3: Minimal Traceable Fixture Generation (§12, §50, P0.4)
  // ==========================================================================
  describe('Step 3: Minimal Traceable Fixture Generation', () => {
    it('generates a minimal Haravan Product fixture when no inventory matches', async () => {
      const result = await resolver.resolveEntity<HaravanProductFixture>(
        {
          type: 'product',
          handle: 'ao-khoac-canary-fixture',
          title: 'Áo Khoác Canary Test',
          tags: ['canary', 'winter']
        },
        [] // empty inventory
      );

      assert.strictEqual(result.action, 'CREATE_MINIMAL_FIXTURE');
      assert.strictEqual(result.fixtureCreated, true);
      assert.ok(result.matchedId);
      assert.ok(result.entity);

      // Verify Haravan Product schema
      const product = result.entity;
      assert.strictEqual(product.handle, 'ao-khoac-canary-fixture');
      assert.strictEqual(product.title, 'Áo Khoác Canary Test');
      assert.strictEqual(product.vendor, 'AntiFan');
      assert.strictEqual(product.product_type, 'Canary Fixture');
      assert.strictEqual(product.status, 'active');
      assert.ok(product.variants.length > 0);
      assert.strictEqual(product.variants[0].title, 'Default Title');
      assert.strictEqual(product.variants[0].requires_shipping, true);
      assert.ok(product.variants[0].sku.startsWith('CANARY-'));
      assert.ok(product.options.length > 0);

      // Verify Fixture Receipt
      assert.ok(result.fixtureReceipt);
      assert.strictEqual(result.fixtureReceipt.cleanupTag, 'antifan-canary-fixture');
      assert.strictEqual(result.fixtureReceipt.key, 'product/ao-khoac-canary-fixture');
      assert.ok(result.fixtureReceipt.fixtureId.startsWith('canary-product-'));
      assert.ok(result.fixtureReceipt.createdAt);
    });

    it('generates a minimal Haravan Collection fixture', async () => {
      const result = await resolver.resolveEntity<HaravanCollectionFixture>(
        {
          type: 'collection',
          handle: 'summer-sale-canary'
        },
        null
      );

      assert.strictEqual(result.action, 'CREATE_MINIMAL_FIXTURE');
      assert.ok(result.entity);
      assert.strictEqual(result.entity.handle, 'summer-sale-canary');
      assert.strictEqual(result.entity.sort_order, 'best-selling');
      assert.strictEqual(result.entity.products_count, 0);
      assert.strictEqual(result.fixtureReceipt?.cleanupTag, 'antifan-canary-fixture');
    });

    it('generates a minimal Haravan Article fixture', async () => {
      const result = await resolver.resolveEntity<HaravanArticleFixture>(
        {
          type: 'article',
          title: 'Hướng Dẫn Chọn Size Áo',
          tags: ['tutorial', 'canary']
        },
        []
      );

      assert.strictEqual(result.action, 'CREATE_MINIMAL_FIXTURE');
      assert.ok(result.entity);
      assert.strictEqual(result.entity.title, 'Hướng Dẫn Chọn Size Áo');
      assert.strictEqual(result.entity.author, 'AntiFan Canary');
      assert.strictEqual(result.entity.blog_id, 1);
      assert.ok(result.entity.summary_html);
      assert.ok(result.entity.body_html);
    });

    it('generates a minimal Haravan Page fixture', async () => {
      const result = await resolver.resolveEntity<HaravanPageFixture>(
        {
          type: 'page',
          handle: 'about-us-canary'
        },
        []
      );

      assert.strictEqual(result.action, 'CREATE_MINIMAL_FIXTURE');
      assert.ok(result.entity);
      assert.strictEqual(result.entity.handle, 'about-us-canary');
      assert.strictEqual(result.entity.author, 'AntiFan Canary');
      assert.ok(result.entity.body_html);
    });
  });

  // ==========================================================================
  // FixtureRegistry & Cleanup Plan (§50)
  // ==========================================================================
  describe('FixtureRegistry & Cleanup Plan Generation', () => {
    it('automatically registers fixtures created during entity resolution', async () => {
      assert.strictEqual(registry.size, 0);

      await resolver.resolveEntity(
        { type: 'product', handle: 'canary-auto-registered-1' },
        []
      );
      await resolver.resolveEntity(
        { type: 'collection', handle: 'canary-auto-registered-2' },
        []
      );

      assert.strictEqual(registry.size, 2);
      const fixtures = registry.listFixtures();
      assert.strictEqual(fixtures.length, 2);
      assert.strictEqual(fixtures[0].cleanupTag, 'antifan-canary-fixture');
    });

    it('supports direct registration of raw receipts and EntityMatchResults', () => {
      const standaloneRegistry = new FixtureRegistry();

      // Register raw receipt object
      standaloneRegistry.registerFixture({
        fixtureId: 'canary-fixture-101',
        key: 'product/canary-item',
        cleanupTag: 'antifan-canary-fixture',
        type: 'product',
        id: 990001
      });

      // Register EntityMatchResult object
      standaloneRegistry.registerFixture({
        action: 'CREATE_MINIMAL_FIXTURE',
        matchedId: 990002,
        fixtureReceipt: {
          fixtureId: 'canary-fixture-102',
          key: 'collection/canary-coll',
          cleanupTag: 'antifan-canary-fixture',
          createdAt: new Date().toISOString()
        },
        entity: {
          id: 990002,
          type: 'collection'
        }
      });

      assert.strictEqual(standaloneRegistry.size, 2);

      // Filtering by cleanup tag
      const tagged = standaloneRegistry.listFixtures('antifan-canary-fixture');
      assert.strictEqual(tagged.length, 2);

      const nonExistent = standaloneRegistry.listFixtures('unknown-tag');
      assert.strictEqual(nonExistent.length, 0);
    });

    it('generates an executable cleanup plan of delete actions', async () => {
      const isolatedRegistry = new FixtureRegistry();
      const localResolver = new EntityResolver(isolatedRegistry);

      await localResolver.resolveEntity(
        { type: 'product', handle: 'prod-to-delete' },
        []
      );
      await localResolver.resolveEntity(
        { type: 'page', handle: 'page-to-delete' },
        []
      );

      const plan = isolatedRegistry.generateCleanupPlan();
      assert.strictEqual(plan.length, 2);

      for (const step of plan) {
        assert.strictEqual(step.action, 'delete');
        assert.ok(step.type === 'product' || step.type === 'page');
        assert.ok(typeof step.id === 'number' || typeof step.id === 'string');
      }

      // Test clear
      isolatedRegistry.clear();
      assert.strictEqual(isolatedRegistry.size, 0);
      assert.strictEqual(isolatedRegistry.generateCleanupPlan().length, 0);
    });
  });
});
