import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  HaravanCampaignMatrix,
  CANONICAL_SURFACES,
  STANDARD_VIEWPORTS,
  executeMatrixCampaign,
  type CampaignMatrixLeg,
  type MatrixLegEvaluator,
  type MatrixExecutionOptions,
  type MatrixExecutionReport,
  type MatrixLegResult,
  type HaravanSurfaceSpec,
  type ViewportDimension,
  type HaravanEntityCandidate,
} from './haravan-campaign-matrix.js';
import type { StoreInventory } from '../platform/haravan/store-discovery.js';

describe('HaravanCampaignMatrix - Storefront Campaign Surface Matrix Engine (Audit §52, §68)', () => {
  const matrixEngine = new HaravanCampaignMatrix();

  describe('1. 45-Leg Matrix Generation & Viewport Coverage', () => {
    it('produces exactly 45 evaluation legs (15 canonical surfaces x 3 viewports)', () => {
      const matrix = matrixEngine.buildFullMatrix();

      assert.strictEqual(matrix.length, 45, 'Matrix must contain exactly 45 legs');

      // Verify all 15 canonical surfaces are represented 3 times each
      for (const surfaceDef of CANONICAL_SURFACES) {
        const legsForSurface = matrix.filter((l) => l.surface === surfaceDef.surface);
        assert.strictEqual(
          legsForSurface.length,
          3,
          `Surface ${surfaceDef.surface} must have exactly 3 legs`
        );

        // Verify the 3 standard viewports are present
        const viewportNames = legsForSurface.map((l) => l.viewport.name).sort();
        assert.deepStrictEqual(viewportNames, ['desktop', 'laptop', 'mobile']);
      }
    });

    it('verifies exact canonical templates and kinds for all 15 surfaces', () => {
      const matrix = matrixEngine.buildFullMatrix();

      const expectedCatalogue: Record<string, { template: string; kind: string; stateModifier?: string }> = {
        'home': { template: 'index.liquid', kind: 'home' },
        'product-standard': { template: 'product.liquid', kind: 'product' },
        'product-variants': { template: 'product.liquid', kind: 'product', stateModifier: 'variant_selection' },
        'product-out-of-stock': { template: 'product.liquid', kind: 'product', stateModifier: 'out_of_stock' },
        'collection-grid': { template: 'collection.liquid', kind: 'collection' },
        'collection-filtered': { template: 'collection.liquid', kind: 'collection', stateModifier: 'filtered' },
        'collection-empty': { template: 'collection.liquid', kind: 'collection', stateModifier: 'empty_state' },
        'blog-listing': { template: 'blog.liquid', kind: 'blog' },
        'article-detail': { template: 'article.liquid', kind: 'article' },
        'article-comments': { template: 'article.liquid', kind: 'article', stateModifier: 'discussion_section' },
        'page-standard': { template: 'page.liquid', kind: 'page' },
        'page-contact': { template: 'page.contact.liquid', kind: 'page', stateModifier: 'contact_form' },
        'cart-active': { template: 'cart.liquid', kind: 'cart', stateModifier: 'active_items' },
        'cart-empty': { template: 'cart.liquid', kind: 'cart', stateModifier: 'empty_state' },
        'search-results': { template: 'search.liquid', kind: 'search' },
      };

      for (const [surface, expected] of Object.entries(expectedCatalogue)) {
        const legs = matrix.filter((l) => l.surface === surface);
        assert.ok(legs.length > 0, `Missing legs for surface: ${surface}`);
        for (const leg of legs) {
          assert.strictEqual(leg.template, expected.template);
          assert.strictEqual(leg.kind, expected.kind);
          assert.strictEqual(leg.required, true, `Surface ${surface} must be marked required`);
          if (expected.stateModifier) {
            assert.strictEqual(leg.stateModifier, expected.stateModifier);
          }
        }
      }
    });

    it('verifies exact standard viewport dimensions across all legs', () => {
      const matrix = matrixEngine.buildFullMatrix();

      for (const leg of matrix) {
        if (leg.viewport.name === 'desktop') {
          assert.strictEqual(leg.viewport.width, 1440);
          assert.strictEqual(leg.viewport.height, 900);
        } else if (leg.viewport.name === 'laptop') {
          assert.strictEqual(leg.viewport.width, 1024);
          assert.strictEqual(leg.viewport.height, 900);
        } else if (leg.viewport.name === 'mobile') {
          assert.strictEqual(leg.viewport.width, 390);
          assert.strictEqual(leg.viewport.height, 844);
        } else {
          assert.fail(`Unknown viewport: ${leg.viewport.name}`);
        }
      }
    });

    it('ensures each leg has a unique composite identifier', () => {
      const matrix = matrixEngine.buildFullMatrix();
      const ids = new Set<string>();

      for (const leg of matrix) {
        assert.ok(leg.id, 'Leg must possess an id');
        assert.ok(!ids.has(leg.id), `Duplicate leg id detected: ${leg.id}`);
        ids.add(leg.id);
        assert.strictEqual(leg.id, `${leg.surface}:${leg.viewport.name}`);
      }

      assert.strictEqual(ids.size, 45);
    });
  });

  describe('2. Store Inventory Binding & RouteResolver Integration', () => {
    const mockInventory: StoreInventory = {
      products: [
        {
          id: 101,
          title: 'Premium Linen Shirt',
          handle: 'premium-linen-shirt',
          variants: [
            { id: 201, title: 'White / S', available: true, inventory_quantity: 15 },
            { id: 202, title: 'White / M', available: true, inventory_quantity: 20 },
            { id: 203, title: 'Navy / L', available: true, inventory_quantity: 8 },
          ],
          images: ['https://cdn.haravan.com/p1.jpg'],
          tags: ['summer', 'linen', 'menswear'],
        },
        {
          id: 102,
          title: 'Sold Out Wool Scarf',
          handle: 'sold-out-wool-scarf',
          variants: [
            { id: 204, title: 'Grey / OS', available: false, inventory_quantity: 0 },
          ],
          images: ['https://cdn.haravan.com/p2.jpg'],
          tags: ['winter', 'out-of-stock'],
        },
      ],
      collections: [
        {
          id: 301,
          title: 'Summer Collection',
          handle: 'summer-collection',
          productsCount: 12,
        },
        {
          id: 302,
          title: 'Archive Clearance',
          handle: 'archive-clearance',
          productsCount: 0,
        },
      ],
      articles: [
        {
          id: 401,
          title: 'Linen Care Guide 101',
          handle: 'linen-care-guide-101',
          blogHandle: 'style-journal',
        },
      ],
      blogs: [
        {
          id: 501,
          title: 'Style Journal',
          handle: 'style-journal',
        },
      ],
      pages: [
        {
          id: 601,
          title: 'About Our Atelier',
          handle: 'about-our-atelier',
        },
        {
          id: 602,
          title: 'Customer Contact',
          handle: 'contact',
        },
      ],
      menus: [],
      themeSettings: { data: {} },
      themeAssets: [],
      capturedAt: new Date().toISOString(),
    };

    it('binds live inventory entities to corresponding surface legs', () => {
      const boundMatrix = matrixEngine.buildFullMatrix(mockInventory);
      assert.strictEqual(boundMatrix.length, 45);

      // 1. Home
      const homeLeg = boundMatrix.find((l) => l.surface === 'home' && l.viewport.name === 'desktop')!;
      assert.strictEqual(homeLeg.url, '/');
      assert.strictEqual(homeLeg.boundEntity?.type, 'root');

      // 2. Product Standard
      const prodStdLeg = boundMatrix.find((l) => l.surface === 'product-standard' && l.viewport.name === 'desktop')!;
      assert.strictEqual(prodStdLeg.url, '/products/premium-linen-shirt');
      assert.strictEqual(prodStdLeg.canonicalUrl, '/products/premium-linen-shirt');
      assert.strictEqual(prodStdLeg.boundEntity?.handle, 'premium-linen-shirt');
      assert.strictEqual(prodStdLeg.boundEntity?.id, 101);

      // 3. Product Variants
      const prodVarLeg = boundMatrix.find((l) => l.surface === 'product-variants' && l.viewport.name === 'desktop')!;
      assert.ok(prodVarLeg.url.includes('/products/premium-linen-shirt?variant='));
      assert.strictEqual(prodVarLeg.canonicalUrl, '/products/premium-linen-shirt');
      assert.strictEqual(prodVarLeg.boundEntity?.selectedVariantId, 202);

      // 4. Product Out-of-Stock
      const prodOosLeg = boundMatrix.find((l) => l.surface === 'product-out-of-stock' && l.viewport.name === 'desktop')!;
      assert.strictEqual(prodOosLeg.url, '/products/sold-out-wool-scarf?state=out_of_stock');
      assert.strictEqual(prodOosLeg.boundEntity?.handle, 'sold-out-wool-scarf');
      assert.strictEqual(prodOosLeg.boundEntity?.available, false);

      // 5. Collection Grid
      const colGridLeg = boundMatrix.find((l) => l.surface === 'collection-grid' && l.viewport.name === 'desktop')!;
      assert.strictEqual(colGridLeg.url, '/collections/summer-collection');
      assert.strictEqual(colGridLeg.boundEntity?.handle, 'summer-collection');
      assert.strictEqual(colGridLeg.boundEntity?.productsCount, 12);

      // 6. Collection Filtered
      const colFilterLeg = boundMatrix.find((l) => l.surface === 'collection-filtered' && l.viewport.name === 'desktop')!;
      assert.ok(colFilterLeg.url.startsWith('/collections/summer-collection?filter='));
      assert.ok(colFilterLeg.boundEntity?.activeFilter);

      // 7. Collection Empty
      const colEmptyLeg = boundMatrix.find((l) => l.surface === 'collection-empty' && l.viewport.name === 'desktop')!;
      assert.strictEqual(colEmptyLeg.url, '/collections/archive-clearance');
      assert.strictEqual(colEmptyLeg.boundEntity?.productsCount, 0);

      // 8. Blog Listing
      const blogLeg = boundMatrix.find((l) => l.surface === 'blog-listing' && l.viewport.name === 'desktop')!;
      assert.strictEqual(blogLeg.url, '/blogs/style-journal');
      assert.strictEqual(blogLeg.boundEntity?.handle, 'style-journal');

      // 9. Article Detail
      const articleLeg = boundMatrix.find((l) => l.surface === 'article-detail' && l.viewport.name === 'desktop')!;
      assert.strictEqual(articleLeg.url, '/blogs/style-journal/linen-care-guide-101');
      assert.strictEqual(articleLeg.boundEntity?.handle, 'linen-care-guide-101');

      // 10. Article Comments
      const articleCommentsLeg = boundMatrix.find((l) => l.surface === 'article-comments' && l.viewport.name === 'desktop')!;
      assert.strictEqual(articleCommentsLeg.url, '/blogs/style-journal/linen-care-guide-101#comments');
      assert.strictEqual(articleCommentsLeg.boundEntity?.hasComments, true);

      // 11. Page Standard
      const pageStdLeg = boundMatrix.find((l) => l.surface === 'page-standard' && l.viewport.name === 'desktop')!;
      assert.strictEqual(pageStdLeg.url, '/pages/about-our-atelier');
      assert.strictEqual(pageStdLeg.boundEntity?.handle, 'about-our-atelier');

      // 12. Page Contact
      const pageContactLeg = boundMatrix.find((l) => l.surface === 'page-contact' && l.viewport.name === 'desktop')!;
      assert.strictEqual(pageContactLeg.url, '/pages/contact');
      assert.strictEqual(pageContactLeg.boundEntity?.isContactForm, true);

      // 13. Cart Active & 14. Cart Empty
      const cartActive = boundMatrix.find((l) => l.surface === 'cart-active' && l.viewport.name === 'desktop')!;
      assert.strictEqual(cartActive.url, '/cart');
      assert.strictEqual(cartActive.boundEntity?.hasLineItems, true);

      const cartEmpty = boundMatrix.find((l) => l.surface === 'cart-empty' && l.viewport.name === 'desktop')!;
      assert.strictEqual(cartEmpty.url, '/cart?state=empty');
      assert.strictEqual(cartEmpty.boundEntity?.hasLineItems, false);

      // 15. Search Results
      const searchLeg = boundMatrix.find((l) => l.surface === 'search-results' && l.viewport.name === 'desktop')!;
      assert.ok(searchLeg.url.startsWith('/search?q='));
      assert.strictEqual(searchLeg.boundEntity?.type, 'search');
    });
  });

  describe('3. Coverage Validation Engine (validateMatrixCoverage)', () => {
    it('reports 100% complete coverage when all 45 legs are executed', () => {
      const matrix = matrixEngine.buildFullMatrix();
      const allLegIds = matrix.map((l) => l.id);

      const report = matrixEngine.validateMatrixCoverage(matrix, allLegIds);
      assert.strictEqual(report.isComplete, true);
      assert.strictEqual(report.coveragePercentage, 100);
      assert.strictEqual(report.missingLegs.length, 0);
      assert.strictEqual(report.totalLegs, 45);
      assert.strictEqual(report.executedCount, 45);
    });

    it('reports partial coverage and lists missing legs accurately', () => {
      const matrix = matrixEngine.buildFullMatrix();
      // Execute only desktop viewports (15 out of 45 legs)
      const executed = matrix.filter((l) => l.viewport.name === 'desktop').map((l) => l.id);

      const report = matrixEngine.validateMatrixCoverage(matrix, executed);
      assert.strictEqual(report.isComplete, false);
      assert.strictEqual(report.executedCount, 15);
      assert.strictEqual(report.totalLegs, 45);
      // 15 / 45 * 100 = 33.33%
      assert.strictEqual(report.coveragePercentage, 33.33);
      assert.strictEqual(report.missingLegs.length, 30);

      // Verify missing legs do not contain desktop
      for (const missing of report.missingLegs) {
        assert.ok(!missing.endsWith(':desktop'), `Desktop leg should not be missing: ${missing}`);
      }
    });

    it('handles executed legs supplied as objects with surface and viewport', () => {
      const matrix = matrixEngine.buildFullMatrix();
      const executedObjects = [
        { surface: 'home', viewport: { name: 'desktop' } },
        { surface: 'home', viewport: 'laptop' },
        { id: 'home:mobile' },
      ];

      const report = matrixEngine.validateMatrixCoverage(matrix, executedObjects);
      assert.strictEqual(report.executedCount, 3);
      assert.strictEqual(report.missingLegs.length, 42);
      assert.ok(!report.missingLegs.includes('home:desktop'));
      assert.ok(!report.missingLegs.includes('home:laptop'));
      assert.ok(!report.missingLegs.includes('home:mobile'));
    });

    it('handles executed legs with hyphen format e.g. home-desktop', () => {
      const matrix = matrixEngine.buildFullMatrix();
      const executedHyphen = ['home-desktop', 'product-standard-mobile'];

      const report = matrixEngine.validateMatrixCoverage(matrix, executedHyphen);
      assert.strictEqual(report.executedCount, 2);
      assert.ok(!report.missingLegs.includes('home:desktop'));
      assert.ok(!report.missingLegs.includes('product-standard:mobile'));
    });

    it('handles empty executed list and empty matrix boundary conditions', () => {
      const matrix = matrixEngine.buildFullMatrix();
      const emptyReport = matrixEngine.validateMatrixCoverage(matrix, []);
      assert.strictEqual(emptyReport.isComplete, false);
      assert.strictEqual(emptyReport.coveragePercentage, 0);
      assert.strictEqual(emptyReport.missingLegs.length, 45);

      const zeroMatrixReport = matrixEngine.validateMatrixCoverage([], ['home:desktop']);
      assert.strictEqual(zeroMatrixReport.isComplete, false);
      assert.strictEqual(zeroMatrixReport.coveragePercentage, 0);
      assert.strictEqual(zeroMatrixReport.missingLegs.length, 0);
      assert.strictEqual(zeroMatrixReport.executedCount, 0);
      assert.strictEqual(zeroMatrixReport.totalLegs, 0);

      const nullMatrixReport = matrixEngine.validateMatrixCoverage(null as unknown as CampaignMatrixLeg[], []);
      assert.strictEqual(nullMatrixReport.isComplete, false);
      assert.strictEqual(nullMatrixReport.coveragePercentage, 0);
      assert.strictEqual(nullMatrixReport.totalLegs, 0);
    });
  });

  describe('4. Serialization & File Export / Import', () => {
    let tmpDir: string;

    it('exports matrix to JSON file and imports back matching all 45 legs', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haravan-matrix-test-'));
      const targetFile = path.join(tmpDir, 'campaign-matrix.json');

      const matrix = matrixEngine.buildFullMatrix();
      await matrixEngine.exportSurfaceInventory(targetFile, matrix);

      // Verify file exists on disk
      const stat = await fs.stat(targetFile);
      assert.ok(stat.size > 0, 'Exported file must not be empty');

      // Verify contents parsed as JSON
      const content = await fs.readFile(targetFile, 'utf-8');
      const parsed = JSON.parse(content);
      assert.ok(Array.isArray(parsed));
      assert.strictEqual(parsed.length, 45);

      // Test import method roundtrip
      const reimported = await matrixEngine.importSurfaceInventory(targetFile);
      assert.strictEqual(reimported.length, 45);
      assert.strictEqual(reimported[0].surface, matrix[0].surface);
      assert.strictEqual(reimported[0].viewport.name, matrix[0].viewport.name);

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates nested directories automatically if path does not exist', async () => {
      const baseTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haravan-nested-'));
      const nestedPath = path.join(baseTmp, 'deep', 'nested', 'matrix.json');

      const matrix = matrixEngine.buildFullMatrix();
      await matrixEngine.exportSurfaceInventory(nestedPath, matrix);

      const exists = await fs.stat(nestedPath).then(() => true).catch(() => false);
      assert.strictEqual(exists, true, 'Nested target file must be created');

      await fs.rm(baseTmp, { recursive: true, force: true });
    });

    it('supports static proxy methods on HaravanCampaignMatrix', async () => {
      const matrix = HaravanCampaignMatrix.buildFullMatrix();
      assert.strictEqual(matrix.length, 45);

      const report = HaravanCampaignMatrix.validateMatrixCoverage(matrix, [matrix[0].id]);
      assert.strictEqual(report.executedCount, 1);
    });
  });

  describe('5. Matrix Campaign Execution Engine (executeMatrixCampaign - Audit §52, §68)', () => {
    const sampleInventory: StoreInventory = {
      products: [
        {
          id: 101,
          title: 'Oxford Shirt Standard',
          handle: 'oxford-shirt-standard',
          variants: [{ id: 1001, title: 'Default', available: true, inventory_quantity: 15 }],
          images: ['https://cdn.haravan.com/shirt.jpg'],
          tags: ['oxford', 'shirt'],
        },
      ],
      collections: [
        {
          id: 201,
          title: 'Spring Lookbook',
          handle: 'spring-lookbook',
          productsCount: 8,
        },
      ],
      articles: [
        {
          id: 301,
          title: 'Fabric Guide 2026',
          handle: 'fabric-guide-2026',
          blogHandle: 'news',
        },
      ],
      blogs: [],
      pages: [],
      menus: [],
      themeSettings: { data: {} },
      themeAssets: [],
      capturedAt: new Date().toISOString(),
    };

    it('iterates through all 45 legs (15 canonical surfaces x 3 viewports) and provides complete context', async () => {
      const visitedLegs: string[] = [];
      const visitedSurfaces = new Set<string>();
      const visitedViewports = new Set<string>();

      const report = await matrixEngine.executeMatrixCampaign(async (context) => {
        assert.ok(context.legId, 'context.legId must be defined');
        assert.ok(context.surface, 'context.surface must be defined');
        assert.ok(context.viewport, 'context.viewport must be defined');
        assert.ok(context.targetUrl, 'context.targetUrl must be defined');
        assert.ok(context.viewport.width > 0, 'viewport width must be positive');
        assert.ok(context.viewport.height > 0, 'viewport height must be positive');

        visitedLegs.push(context.legId);
        visitedSurfaces.add(context.surface.surface);
        visitedViewports.add(context.viewport.name);

        return {
          passed: true,
          visualDiff: 0.25,
          durationMs: 5,
          renderErrors: [],
          measurement: {
            domNodeCount: 145,
            layoutShiftScore: 0.01,
            renderTimeMs: 12,
          },
          liquidChecks: {
            syntaxValid: true,
            missingFilters: [],
            missingTags: [],
          },
        };
      });

      assert.strictEqual(visitedLegs.length, 45, 'Evaluator must receive all 45 legs');
      assert.strictEqual(visitedSurfaces.size, 15, 'All 15 canonical surfaces must be visited');
      assert.strictEqual(visitedViewports.size, 3, 'All 3 standard viewports must be visited');

      // Comprehensive report checks
      assert.strictEqual(report.totalLegs, 45);
      assert.strictEqual(report.executedLegs, 45);
      assert.strictEqual(report.passedLegs, 45);
      assert.strictEqual(report.failedLegs, 0);
      assert.strictEqual(report.passRate, 100);
      assert.strictEqual(report.isPublishReady, true);
      assert.strictEqual(report.results.length, 45);

      // Check individual result fields
      const first = report.results[0];
      assert.strictEqual(first.passed, true);
      assert.strictEqual(first.visualDiff, 0.25);
      assert.strictEqual(first.renderErrors.length, 0);
      assert.ok(first.measurement);
      assert.strictEqual(first.measurement.domNodeCount, 145);
      assert.ok(first.liquidChecks);
      assert.strictEqual(first.liquidChecks.syntaxValid, true);
    });

    it('binds catalog entity info in leg context when store inventory is supplied', async () => {
      let productContextSeen = false;
      let collectionContextSeen = false;

      await matrixEngine.executeMatrixCampaign(
        async (context) => {
          if (context.surface.surface === 'product-standard' && context.viewport.name === 'desktop') {
            productContextSeen = true;
            assert.ok(context.boundEntity, 'product leg must have bound entity');
            assert.strictEqual(context.boundEntity.type, 'product');
            assert.strictEqual(context.boundEntity.handle, 'oxford-shirt-standard');
            assert.strictEqual(context.targetUrl, '/products/oxford-shirt-standard');
          }
          if (context.surface.surface === 'collection-grid' && context.viewport.name === 'laptop') {
            collectionContextSeen = true;
            assert.ok(context.boundEntity, 'collection leg must have bound entity');
            assert.strictEqual(context.boundEntity.type, 'collection');
            assert.strictEqual(context.boundEntity.handle, 'spring-lookbook');
          }
          return true;
        },
        { inventory: sampleInventory }
      );

      assert.strictEqual(productContextSeen, true);
      assert.strictEqual(collectionContextSeen, true);
    });

    it('records pass/fail, visualDiff percentage, durationMs, and detected render errors accurately', async () => {
      const report = await matrixEngine.executeMatrixCampaign(async (context) => {
        if (context.legId === 'product-standard:mobile') {
          // Leg with visual regression (12.5% diff exceeds default 5% threshold)
          return {
            visualDiff: 12.5,
            renderErrors: [],
          };
        }
        if (context.legId === 'cart-active:desktop') {
          // Leg with Liquid render errors
          return {
            visualDiff: 0.5,
            liquidChecks: {
              syntaxValid: false,
              syntaxErrors: ['Liquid error: Unknown tag line_item_subtotal'],
            },
          };
        }
        return {
          visualDiff: 1.2,
          renderErrors: [],
        };
      });

      assert.strictEqual(report.totalLegs, 45);
      assert.strictEqual(report.executedLegs, 45);
      assert.strictEqual(report.failedLegs, 2);
      assert.strictEqual(report.passedLegs, 43);
      assert.strictEqual(report.passRate, 95.56);
      assert.strictEqual(report.isPublishReady, false);

      const visualFailedLeg = report.results.find((r) => r.legId === 'product-standard:mobile');
      assert.ok(visualFailedLeg);
      assert.strictEqual(visualFailedLeg.passed, false);
      assert.strictEqual(visualFailedLeg.visualDiff, 12.5);

      const liquidFailedLeg = report.results.find((r) => r.legId === 'cart-active:desktop');
      assert.ok(liquidFailedLeg);
      assert.strictEqual(liquidFailedLeg.passed, false);
      assert.ok(liquidFailedLeg.renderErrors.some((e) => e.includes('line_item_subtotal')));
    });

    it('handles evaluator throwing an unhandled exception cleanly without crashing campaign', async () => {
      const report = await matrixEngine.executeMatrixCampaign(async (context) => {
        if (context.legId === 'cart-empty:laptop') {
          throw new Error('CDP execution failed: tab disconnected');
        }
        return true;
      });

      assert.strictEqual(report.executedLegs, 45);
      assert.strictEqual(report.failedLegs, 1);
      assert.strictEqual(report.passedLegs, 44);
      assert.strictEqual(report.isPublishReady, false);

      const crashedLeg = report.results.find((r) => r.legId === 'cart-empty:laptop');
      assert.ok(crashedLeg);
      assert.strictEqual(crashedLeg.passed, false);
      assert.strictEqual(crashedLeg.visualDiff, 100);
      assert.ok(crashedLeg.error?.includes('tab disconnected'));
      assert.ok(crashedLeg.renderErrors.some((e) => e.includes('tab disconnected')));
    });

    it('respects failFast option and halts immediately upon first failure', async () => {
      let executionCount = 0;

      const report = await matrixEngine.executeMatrixCampaign(
        async () => {
          executionCount++;
          if (executionCount === 3) {
            return { passed: false, renderErrors: ['Critical layout collapse'] };
          }
          return true;
        },
        { failFast: true }
      );

      assert.strictEqual(executionCount, 3);
      assert.strictEqual(report.executedLegs, 3);
      assert.strictEqual(report.failedLegs, 1);
      assert.strictEqual(report.passedLegs, 2);
      assert.strictEqual(report.totalLegs, 45);
      assert.strictEqual(report.isPublishReady, false);
    });

    it('supports filtering by surface and viewport in options', async () => {
      const report = await matrixEngine.executeMatrixCampaign(
        async () => true,
        {
          surfaces: ['home', 'search-results'],
          viewports: ['desktop', 'mobile'],
        }
      );

      // 2 surfaces x 2 viewports = 4 legs
      assert.strictEqual(report.executedLegs, 4);
      assert.strictEqual(report.passedLegs, 4);
      assert.ok(report.results.every((r) => ['home', 'search-results'].includes(r.surface as string)));
      assert.ok(report.results.every((r) => ['desktop', 'mobile'].includes(r.viewport as string)));
    });

    it('supports static proxy and top-level exported executeMatrixCampaign helper', async () => {
      // Static proxy
      const staticReport = await HaravanCampaignMatrix.executeMatrixCampaign(
        async () => true,
        { surfaces: ['home'], viewports: ['desktop'] }
      );
      assert.strictEqual(staticReport.executedLegs, 1);
      assert.strictEqual(staticReport.passedLegs, 1);

      // Standalone helper
      const standaloneReport = await executeMatrixCampaign(
        async () => true,
        { surfaces: ['home'], viewports: ['desktop'] }
      );
      assert.strictEqual(standaloneReport.executedLegs, 1);
      assert.strictEqual(standaloneReport.passedLegs, 1);
    });

    it('rejects non-callable evaluator with descriptive error', async () => {
      await assert.rejects(
        async () => {
          await matrixEngine.executeMatrixCampaign(null as unknown as MatrixLegEvaluator);
        },
        {
          name: 'Error',
          message: /evaluator must be a callable function/,
        }
      );
    });
  });
});
