/**
 * Haravan Platform Adapter Unit Tests
 * Tests store context, theme discovery, asset operations, atomic transactions,
 * policy violations (fail-closed), rollback buffer, and CLI transport delegation.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  HaravanAdapter,
  InMemoryHaravanApiTransport,
  HttpHaravanApiTransport,
  HaravanCliProcessTransport,
  ThemeTransactionPolicyError,
  ThemeTransactionNotFoundError,
  ThemeTransactionStateError,
  matchGlobPattern,
  ThemeCliProcessResult,
  HaravanCliTransport,
  HaravanApiTransport,
  CleanupPlan,
} from './haravan-adapter.js';
import { ThemeAsset } from './types.js';
import { FixtureRegistry } from './entity-resolver.js';

describe('HaravanAdapter', () => {
  describe('Glob Pattern Matching Helper', () => {
    it('matches exact file paths', () => {
      assert.equal(matchGlobPattern('config/settings_data.json', 'config/settings_data.json'), true);
      assert.equal(matchGlobPattern('config/settings_data.json', 'config/settings_schema.json'), false);
    });

    it('matches directory prefixes', () => {
      assert.equal(matchGlobPattern('snippets/product-card.liquid', 'snippets/'), true);
      assert.equal(matchGlobPattern('templates/product.liquid', 'snippets/'), false);
    });

    it('matches single-level wildcards', () => {
      assert.equal(matchGlobPattern('templates/product.liquid', 'templates/*'), true);
      assert.equal(matchGlobPattern('templates/sub/nested.liquid', 'templates/*'), false);
      assert.equal(matchGlobPattern('assets/app.min.js', 'assets/*.js'), true);
      assert.equal(matchGlobPattern('assets/app.min.css', 'assets/*.js'), false);
    });

    it('matches multi-level recursive wildcards', () => {
      assert.equal(matchGlobPattern('snippets/sub/deep/card.liquid', 'snippets/**'), true);
      assert.equal(matchGlobPattern('snippets/card.liquid', 'snippets/**'), true);
      assert.equal(matchGlobPattern('layout/theme.liquid', 'snippets/**'), false);
    });

    it('matches prefix wildcards', () => {
      assert.equal(matchGlobPattern('assets/secure-credentials.json', 'assets/secure-*'), true);
      assert.equal(matchGlobPattern('assets/public-icon.svg', 'assets/secure-*'), false);
    });
  });

  describe('Store Context & Theme Discovery (§8)', () => {
    it('retrieves store context with full metadata', async () => {
      const transport = new InMemoryHaravanApiTransport({
        storeContext: {
          store: 'my-anti-store',
          domain: 'my-anti-store.myharavan.com',
          themeId: 9999,
          environment: 'production',
        },
      });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      const ctx = await adapter.getStoreContext();
      assert.equal(ctx.store, 'my-anti-store');
      assert.equal(ctx.domain, 'my-anti-store.myharavan.com');
      assert.equal(ctx.themeId, 9999);
      assert.equal(ctx.environment, 'production');
    });

    it('lists themes and gets a specific theme by ID', async () => {
      const transport = new InMemoryHaravanApiTransport({
        themes: [
          { id: 101, name: 'Live Production Theme', role: 'main' },
          { id: 102, name: 'Draft Clone Candidate', role: 'unpublished' },
        ],
      });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      const themes = await adapter.listThemes();
      assert.equal(themes.length, 2);
      assert.equal(themes[0].id, 101);
      assert.equal(themes[1].id, 102);

      const theme = await adapter.getTheme(102);
      assert.equal(theme.name, 'Draft Clone Candidate');
      assert.equal(theme.role, 'unpublished');
    });

    it('throws error when getting a non-existent theme', async () => {
      const adapter = new HaravanAdapter();
      await assert.rejects(
        () => adapter.getTheme(888888),
        /Theme with ID 888888 not found/
      );
    });
  });

  describe('Theme Assets Discovery & Inspection (§8)', () => {
    it('retrieves existing assets and handles missing assets gracefully', async () => {
      const initialAssets: Record<string, Record<string, ThemeAsset>> = {
        '1001': {
          'layout/theme.liquid': {
            key: 'layout/theme.liquid',
            value: '<html><body>{{ content_for_layout }}</body></html>',
          },
          'snippets/header.liquid': {
            key: 'snippets/header.liquid',
            value: '<header>AntiFan Header</header>',
          },
        },
      };

      const transport = new InMemoryHaravanApiTransport({ assets: initialAssets });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      const assets = await adapter.getThemeAssets(1001);
      assert.equal(assets.length, 2);

      const themeLiquid = await adapter.getThemeAsset(1001, 'layout/theme.liquid');
      assert.ok(themeLiquid);
      assert.match(themeLiquid.value ?? '', /content_for_layout/);

      const missingAsset = await adapter.getThemeAsset(1001, 'non-existent/file.liquid');
      assert.equal(missingAsset, null);
    });
  });

  describe('Theme Transactions Lifecycle & Commit (§8)', () => {
    it('executes create, update, and delete mutations atomically on commit', async () => {
      const initialAssets: Record<string, Record<string, ThemeAsset>> = {
        '1002': {
          'snippets/old.liquid': {
            key: 'snippets/old.liquid',
            value: 'old-content',
          },
          'snippets/to-delete.liquid': {
            key: 'snippets/to-delete.liquid',
            value: 'will-be-deleted',
          },
        },
      };

      const transport = new InMemoryHaravanApiTransport({ assets: initialAssets });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      // Begin transaction with permissive policy on staging theme 1002
      const tx = await adapter.beginTransaction(1002, {});
      assert.equal(tx.status, 'pending');

      // Stage operations
      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/new.liquid',
        value: '<nav>New Navigation</nav>',
      });

      await adapter.stageAssetMutation(tx.id, {
        type: 'update',
        key: 'snippets/old.liquid',
        value: 'updated-content-v2',
      });

      await adapter.stageAssetMutation(tx.id, {
        type: 'delete',
        key: 'snippets/to-delete.liquid',
      });

      // Before commit, store is still in initial state
      assert.equal(await adapter.getThemeAsset(1002, 'snippets/new.liquid'), null);
      assert.equal((await adapter.getThemeAsset(1002, 'snippets/old.liquid'))?.value, 'old-content');
      assert.ok(await adapter.getThemeAsset(1002, 'snippets/to-delete.liquid'));

      // Commit transaction
      await adapter.commitTransaction(tx.id);

      const committedTx = adapter.getTransaction(tx.id);
      assert.equal(committedTx?.status, 'committed');
      assert.ok(committedTx?.committedAt);

      // Verify store was updated
      const newAsset = await adapter.getThemeAsset(1002, 'snippets/new.liquid');
      assert.equal(newAsset?.value, '<nav>New Navigation</nav>');

      const updatedAsset = await adapter.getThemeAsset(1002, 'snippets/old.liquid');
      assert.equal(updatedAsset?.value, 'updated-content-v2');

      const deletedAsset = await adapter.getThemeAsset(1002, 'snippets/to-delete.liquid');
      assert.equal(deletedAsset, null);
    });
  });

  describe('Policy Violations Enforcement (Fail-Closed)', () => {
    it('blocks direct mutations on live production theme (role: main) (Audit §33, §64)', async () => {
      const adapter = new HaravanAdapter();
      await assert.rejects(
        () => adapter.beginTransaction(1001, {}),
        (err: unknown) => {
          assert.ok(err instanceof ThemeTransactionPolicyError);
          assert.equal(err.reason, 'LIVE_THEME_MUTATION_FORBIDDEN');
          assert.equal(err.violatingKey, '1001');
          return true;
        }
      );
    });

    it('blocks mutations matching forbiddenFiles policy', async () => {
      const adapter = new HaravanAdapter();
      const tx = await adapter.beginTransaction(1002, {
        forbiddenFiles: ['config/settings_data.json', 'assets/secure-*'],
      });
      await assert.rejects(
        () =>
          adapter.stageAssetMutation(tx.id, {
            type: 'update',
            key: 'config/settings_data.json',
            value: '{"current": {}}',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ThemeTransactionPolicyError);
          assert.equal(err.reason, 'FORBIDDEN_FILE');
          assert.equal(err.violatingKey, 'config/settings_data.json');
          return true;
        }
      );

      await assert.rejects(
        () =>
          adapter.stageAssetMutation(tx.id, {
            type: 'create',
            key: 'assets/secure-secret.key',
            value: 'secret-content',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ThemeTransactionPolicyError);
          assert.equal(err.reason, 'FORBIDDEN_FILE');
          assert.equal(err.violatingKey, 'assets/secure-secret.key');
          return true;
        }
      );
    });

    it('blocks mutations not in allowedFiles policy', async () => {
      const adapter = new HaravanAdapter();
      const tx = await adapter.beginTransaction(1002, {
        allowedFiles: ['templates/*', 'snippets/*'],
      });

      // Allowed file stages cleanly
      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/product-card.liquid',
        value: '<div>card</div>',
      });

      // Disallowed file is rejected
      await assert.rejects(
        () =>
          adapter.stageAssetMutation(tx.id, {
            type: 'create',
            key: 'locales/vi.json',
            value: '{}',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ThemeTransactionPolicyError);
          assert.equal(err.reason, 'NOT_ALLOWED_FILE');
          assert.equal(err.violatingKey, 'locales/vi.json');
          return true;
        }
      );
    });

    it('enforces diffBudget maxFilesChanged limit', async () => {
      const adapter = new HaravanAdapter();
      const tx = await adapter.beginTransaction(1002, {
        diffBudget: {
          maxFilesChanged: 2,
        },
      });

      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/a.liquid',
        value: 'a',
      });
      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/b.liquid',
        value: 'b',
      });

      // Third unique file exceeds budget
      await assert.rejects(
        () =>
          adapter.stageAssetMutation(tx.id, {
            type: 'create',
            key: 'snippets/c.liquid',
            value: 'c',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ThemeTransactionPolicyError);
          assert.equal(err.reason, 'DIFF_BUDGET_FILES');
          assert.equal(err.violatingKey, 'snippets/c.liquid');
          return true;
        }
      );
    });

    it('enforces diffBudget maxBytesDelta limit', async () => {
      const adapter = new HaravanAdapter();
      const tx = await adapter.beginTransaction(1002, {
        diffBudget: {
          maxBytesDelta: 50, // max 50 bytes total mutation
        },
      });

      // 30 bytes is fine
      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/small.liquid',
        value: '123456789012345678901234567890', // 30 bytes
      });

      // Additional 30 bytes makes total 60 bytes, exceeding 50 bytes limit
      await assert.rejects(
        () =>
          adapter.stageAssetMutation(tx.id, {
            type: 'create',
            key: 'snippets/overflow.liquid',
            value: '123456789012345678901234567890', // 30 bytes
          }),
        (err: unknown) => {
          assert.ok(err instanceof ThemeTransactionPolicyError);
          assert.equal(err.reason, 'DIFF_BUDGET_BYTES');
          assert.equal(err.violatingKey, 'snippets/overflow.liquid');
          return true;
        }
      );
    });
  });

  describe('In-Memory Rollback Buffer & Atomic Revert', () => {
    it('discards staged mutations on pending transaction rollback', async () => {
      const adapter = new HaravanAdapter();
      const tx = await adapter.beginTransaction(1002, {});

      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/discarded.liquid',
        value: 'temp',
      });

      await adapter.rollbackTransaction(tx.id);

      const rolledBackTx = adapter.getTransaction(tx.id);
      assert.equal(rolledBackTx?.status, 'rolled_back');

      // Asset was never written
      assert.equal(await adapter.getThemeAsset(1002, 'snippets/discarded.liquid'), null);

      // Cannot commit a rolled back transaction
      await assert.rejects(
        () => adapter.commitTransaction(tx.id),
        ThemeTransactionStateError
      );
    });

    it('reverts committed changes accurately on post-commit rollback', async () => {
      const initialAssets: Record<string, Record<string, ThemeAsset>> = {
        '1002': {
          'snippets/hero.liquid': {
            key: 'snippets/hero.liquid',
            value: 'original-hero',
          },
          'snippets/footer.liquid': {
            key: 'snippets/footer.liquid',
            value: 'original-footer',
          },
        },
      };

      const transport = new InMemoryHaravanApiTransport({ assets: initialAssets });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      const tx = await adapter.beginTransaction(1002, {});

      // 1. Update hero
      await adapter.stageAssetMutation(tx.id, {
        type: 'update',
        key: 'snippets/hero.liquid',
        value: 'mutated-hero',
      });

      // 2. Delete footer
      await adapter.stageAssetMutation(tx.id, {
        type: 'delete',
        key: 'snippets/footer.liquid',
      });

      // 3. Create new banner
      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/banner.liquid',
        value: 'new-banner',
      });

      // Commit
      await adapter.commitTransaction(tx.id);
      assert.equal((await adapter.getThemeAsset(1002, 'snippets/hero.liquid'))?.value, 'mutated-hero');
      assert.equal(await adapter.getThemeAsset(1002, 'snippets/footer.liquid'), null);
      assert.equal((await adapter.getThemeAsset(1002, 'snippets/banner.liquid'))?.value, 'new-banner');

      // Now Rollback the committed transaction
      await adapter.rollbackTransaction(tx.id);

      // Hero should be restored to original-hero
      const restoredHero = await adapter.getThemeAsset(1002, 'snippets/hero.liquid');
      assert.equal(restoredHero?.value, 'original-hero');

      // Footer should be restored to original-footer
      const restoredFooter = await adapter.getThemeAsset(1002, 'snippets/footer.liquid');
      assert.equal(restoredFooter?.value, 'original-footer');

      // Banner created in transaction should be deleted
      const restoredBanner = await adapter.getThemeAsset(1002, 'snippets/banner.liquid');
      assert.equal(restoredBanner, null);
    });

    it('performs automatic atomic rollback if commit fails midway', async () => {
      class FailingPutApiTransport extends InMemoryHaravanApiTransport {
        private callCount = 0;
        public override async putThemeAsset(
          themeId: number | string,
          asset: { key: string; value?: string }
        ): Promise<ThemeAsset> {
          this.callCount += 1;
          if (this.callCount === 2) {
            throw new Error('Simulated network timeout on second write');
          }
          return super.putThemeAsset(themeId, asset);
        }
      }

      const initialAssets: Record<string, Record<string, ThemeAsset>> = {
        '1002': {
          'snippets/first.liquid': { key: 'snippets/first.liquid', value: 'orig-first' },
        },
      };

      const failingTransport = new FailingPutApiTransport({ assets: initialAssets });
      const adapter = new HaravanAdapter({ apiTransport: failingTransport });

      const tx = await adapter.beginTransaction(1002, {});

      await adapter.stageAssetMutation(tx.id, {
        type: 'update',
        key: 'snippets/first.liquid',
        value: 'new-first',
      });

      await adapter.stageAssetMutation(tx.id, {
        type: 'create',
        key: 'snippets/second.liquid',
        value: 'new-second',
      });

      // Commit must fail and automatically rollback first mutation
      await assert.rejects(
        () => adapter.commitTransaction(tx.id),
        /Failed to commit transaction/
      );

      const statusTx = adapter.getTransaction(tx.id);
      assert.equal(statusTx?.status, 'rolled_back');

      // first.liquid was rolled back to original
      const first = await adapter.getThemeAsset(1002, 'snippets/first.liquid');
      assert.equal(first?.value, 'orig-first');

      // second.liquid was not created
      const second = await adapter.getThemeAsset(1002, 'snippets/second.liquid');
      assert.equal(second, null);
    });
  });

  describe('Invalid Transaction State Handling', () => {
    it('throws ThemeTransactionNotFoundError for unknown transaction ID', async () => {
      const adapter = new HaravanAdapter();
      await assert.rejects(
        () =>
          adapter.stageAssetMutation('tx_non_existent', {
            type: 'create',
            key: 'snippets/x.liquid',
          }),
        ThemeTransactionNotFoundError
      );
    });

    it('rejects mutations on already committed transactions', async () => {
      const adapter = new HaravanAdapter();
      const tx = await adapter.beginTransaction(1002, {});
      await adapter.commitTransaction(tx.id);

      await assert.rejects(
        () =>
          adapter.stageAssetMutation(tx.id, {
            type: 'create',
            key: 'snippets/x.liquid',
          }),
        ThemeTransactionStateError
      );
    });
  });

  describe('CLI Transport Delegation (§9)', () => {
    it('delegates preview, sync, and watch to configured CLI transport', async () => {
      let previewCalled = false;
      let syncCalled = false;
      let watchCalled = false;

      const mockCliTransport: HaravanCliTransport = {
        async preview(themeId, options) {
          previewCalled = true;
          assert.equal(themeId, 1001);
          assert.equal(options?.port, 9000);
          return { command: 'hrv', args: ['theme', 'preview'], url: 'http://127.0.0.1:9000' };
        },
        async sync(themeId, options) {
          syncCalled = true;
          assert.equal(themeId, 1001);
          assert.equal(options?.dir, './dist');
          return { command: 'hrv', args: ['theme', 'sync'] };
        },
        async watch(themeId, options) {
          watchCalled = true;
          assert.equal(themeId, 1001);
          assert.equal(options?.env, 'staging');
          return { command: 'hrv', args: ['theme', 'watch'] };
        },
      };

      const adapter = new HaravanAdapter({ cliTransport: mockCliTransport });

      const previewRes = await adapter.previewTheme(1001, { port: 9000 });
      assert.ok(previewCalled);
      assert.equal(previewRes.url, 'http://127.0.0.1:9000');

      await adapter.syncTheme(1001, { dir: './dist' });
      assert.ok(syncCalled);

      await adapter.watchTheme(1001, { env: 'staging' });
      assert.ok(watchCalled);
    });

    it('uses default HaravanCliProcessTransport when cliTransport is not injected', async () => {
      const adapter = new HaravanAdapter();
      const previewRes = await adapter.previewTheme(1001, { port: 9292 });
      assert.equal(previewRes.command, 'hrv');
      assert.equal(previewRes.url, 'http://127.0.0.1:9292');
      assert.deepEqual(previewRes.args, ['theme', 'preview', '--theme', '1001', '--port', '9292']);
    });
  });

  describe('Data Discovery Endpoints (§47 - §48, §62)', () => {
    it('exposes products, collections, articles, blogs, pages, menus, settings', async () => {
      const transport = new InMemoryHaravanApiTransport({
        products: [{ id: 1, title: 'AntiFan T-Shirt', handle: 'antifan-t-shirt' }],
        collections: [{ id: 10, title: 'Summer Collection', handle: 'summer-collection' }],
        articles: [{ id: 20, title: 'Release Notes v1', handle: 'release-notes-v1' }],
        blogs: [{ id: 30, title: 'News', handle: 'news' }],
        pages: [{ id: 40, title: 'About Us', handle: 'about-us' }],
        menus: [{ id: 50, title: 'Main Menu', handle: 'main-menu' }],
        settings: { '1001': { header_logo: 'logo.png', font_size: '16px' } },
      });

      const adapter = new HaravanAdapter({ apiTransport: transport });

      const products = await adapter.getProducts();
      assert.equal(products.length, 1);
      assert.equal((products[0] as Record<string, unknown>).handle, 'antifan-t-shirt');

      const collections = await adapter.getCollections();
      assert.equal(collections.length, 1);
      assert.equal((collections[0] as Record<string, unknown>).handle, 'summer-collection');

      const articles = await adapter.getArticles();
      assert.equal(articles.length, 1);

      const blogs = await adapter.getBlogs();
      assert.equal(blogs.length, 1);

      const pages = await adapter.getPages();
      assert.equal(pages.length, 1);

      const menus = await adapter.getMenus();
      assert.equal(menus.length, 1);

      const settings = await adapter.getThemeSettings(1001);
      assert.deepEqual(settings, { header_logo: 'logo.png', font_size: '16px' });
    });
  });

  describe('Canary Cleanup Plan Execution (Audit §43)', () => {
    it('safely deletes canary fixtures (products, collections, articles, pages) via apiTransport', async () => {
      const transport = new InMemoryHaravanApiTransport({
        products: [{ id: 101, title: 'Canary Product 101' }],
        collections: [{ id: 202, title: 'Canary Collection 202' }],
        articles: [{ id: 303, title: 'Canary Article 303' }],
        pages: [{ id: 404, title: 'Canary Page 404' }],
      });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      const plan: CleanupPlan = [
        { action: 'delete', type: 'product', id: 101 },
        { action: 'delete', type: 'collection', id: 202 },
        { action: 'delete', type: 'article', id: 303 },
        { action: 'delete', type: 'page', id: 404 },
      ];

      const result = await adapter.executeCleanupPlan(plan);
      assert.equal(result.executed, 4);
      assert.equal(result.failed, 0);
      assert.deepEqual(result.errors, []);

      // Verify fixtures were removed from store
      assert.equal((await adapter.getProducts()).length, 0);
      assert.equal((await adapter.getCollections()).length, 0);
      assert.equal((await adapter.getArticles()).length, 0);
      assert.equal((await adapter.getPages()).length, 0);
    });

    it('accepts and executes CleanupPlan generated by FixtureRegistry', async () => {
      const registry = new FixtureRegistry();
      registry.registerFixture({
        fixtureId: 'canary-prod-1',
        key: 'product:canary-hoodie',
        type: 'product',
        id: 777,
        cleanupTag: 'antifan-canary-fixture',
        createdAt: new Date().toISOString(),
      });
      registry.registerFixture({
        fixtureId: 'canary-col-1',
        key: 'collection:canary-apparel',
        type: 'collection',
        id: 888,
        cleanupTag: 'antifan-canary-fixture',
        createdAt: new Date().toISOString(),
      });

      const transport = new InMemoryHaravanApiTransport({
        products: [{ id: 777, title: 'Canary Hoodie' }],
        collections: [{ id: 888, title: 'Canary Apparel' }],
      });
      const adapter = new HaravanAdapter({ apiTransport: transport });

      // Execute directly from registry
      const result = await adapter.executeCleanupPlan(registry);
      assert.equal(result.executed, 2);
      assert.equal(result.failed, 0);
      assert.equal(result.errors.length, 0);

      assert.equal((await adapter.getProducts()).length, 0);
      assert.equal((await adapter.getCollections()).length, 0);
    });

    it('captures failures gracefully when deletion fails or type is unknown', async () => {
      const transport = new InMemoryHaravanApiTransport();
      transport.deleteProduct = async (id: number | string) => {
        throw new Error(`Product ${id} is locked by external process`);
      };

      const adapter = new HaravanAdapter({ apiTransport: transport });
      const plan: CleanupPlan = [
        { action: 'delete', type: 'product', id: 999 },
        { action: 'delete', type: 'unsupported_fixture', id: 111 },
      ];

      const result = await adapter.executeCleanupPlan(plan);
      assert.equal(result.executed, 0);
      assert.equal(result.failed, 2);
      assert.equal(result.errors.length, 2);
      assert.equal(result.errors[0]?.targetId, '999');
      assert.match(result.errors[0]?.error ?? '', /is locked by external process/);
      assert.equal(result.errors[1]?.targetId, '111');
      assert.match(result.errors[1]?.error ?? '', /Unsupported entity type/);
    });
  });

  describe('HttpHaravanApiTransport (Audit §16)', () => {
    it('authenticates via X-Haravan-Access-Token header and fetches themes', async () => {
      let capturedHeader: string | null = null;
      let requestedUrl = '';

      const mockFetch: typeof fetch = async (input, init) => {
        requestedUrl = String(input);
        const headers = new Headers(init?.headers);
        capturedHeader = headers.get('X-Haravan-Access-Token');
        return new Response(
          JSON.stringify({
            themes: [
              { id: 2001, name: 'Live Production', role: 'main' },
              { id: 2002, name: 'Staging Theme', role: 'unpublished' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const transport = new HttpHaravanApiTransport({
        accessToken: 'hrv_sec_token_999',
        baseUrl: 'https://apis.haravan.com/web',
        fetchFn: mockFetch,
      });

      const themes = await transport.listThemes();
      assert.equal(themes.length, 2);
      assert.equal(themes[0]?.name, 'Live Production');
      assert.equal(capturedHeader, 'hrv_sec_token_999');
      assert.equal(requestedUrl, 'https://apis.haravan.com/web/admin/themes.json');
    });

    it('authenticates via Bearer Authorization header when configured', async () => {
      let authHeader: string | null = null;

      const mockFetch: typeof fetch = async (_input, init) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get('Authorization');
        return new Response(
          JSON.stringify({
            theme: { id: 2002, name: 'Staging Theme', role: 'unpublished' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const transport = new HttpHaravanApiTransport({
        accessToken: 'oauth_bearer_123',
        authType: 'bearer',
        fetchFn: mockFetch,
      });

      const theme = await transport.getTheme(2002);
      assert.equal(theme.id, 2002);
      assert.equal(authHeader, 'Bearer oauth_bearer_123');
    });

    it('handles rate limiting (429 Retry-After) and transparently recovers', async () => {
      let callCount = 0;

      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'Throttled' }), {
            status: 429,
            headers: { 'Retry-After': '0.01' },
          });
        }
        return new Response(
          JSON.stringify({
            products: [{ id: 55, title: 'Recovered Product' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const transport = new HttpHaravanApiTransport({
        accessToken: 'token_rate_limit',
        retryDelayMs: 10,
        fetchFn: mockFetch,
      });

      const products = await transport.getProducts();
      assert.equal(callCount, 2);
      assert.equal(products.length, 1);
    });

    it('handles 404 for missing asset by returning null', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Asset not found', { status: 404, statusText: 'Not Found' });
      };

      const transport = new HttpHaravanApiTransport({
        accessToken: 'token',
        fetchFn: mockFetch,
      });

      const asset = await transport.getThemeAsset(1002, 'snippets/missing.liquid');
      assert.equal(asset, null);
    });

    it('implements putThemeAsset, deleteThemeAsset, and canary deletions', async () => {
      const records: string[] = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const method = init?.method ?? 'GET';
        records.push(`${method} ${input}`);
        if (method === 'PUT') {
          return new Response(
            JSON.stringify({
              asset: { key: 'snippets/nav.liquid', value: '<nav></nav>', size: 12 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const transport = new HttpHaravanApiTransport({
        accessToken: 'test_token',
        baseUrl: 'https://apis.haravan.com/web',
        fetchFn: mockFetch,
      });

      const asset = await transport.putThemeAsset(1002, { key: 'snippets/nav.liquid', value: '<nav></nav>' });
      assert.equal(asset.key, 'snippets/nav.liquid');

      await transport.deleteThemeAsset(1002, 'snippets/nav.liquid');
      await transport.deleteProduct(101);
      await transport.deleteCollection(202);
      await transport.deleteArticle(303, 99);
      await transport.deletePage(404);

      assert.ok(records.some((r) => r.startsWith('PUT https://apis.haravan.com/web/admin/themes/1002/assets.json')));
      assert.ok(records.some((r) => r.startsWith('DELETE https://apis.haravan.com/web/admin/themes/1002/assets.json?asset[key]=snippets%2Fnav.liquid')));
      assert.ok(records.some((r) => r.startsWith('DELETE https://apis.haravan.com/web/admin/products/101.json')));
      assert.ok(records.some((r) => r.startsWith('DELETE https://apis.haravan.com/web/admin/custom_collections/202.json')));
      assert.ok(records.some((r) => r.startsWith('DELETE https://apis.haravan.com/web/admin/blogs/99/articles/303.json')));
      assert.ok(records.some((r) => r.startsWith('DELETE https://apis.haravan.com/web/admin/pages/404.json')));
    });
  });

  describe('HaravanCliProcessTransport Execution & Lifecycle (Audit P0.1, §9)', () => {
    it('preview spawns process, derives preview url, and stops process on request', async () => {
      const transport = new HaravanCliProcessTransport({
        binaryPath: process.execPath,
      });

      const res = await transport.preview(1002, { port: 9191 });
      assert.equal(res.command, process.execPath);
      assert.equal(res.url, 'http://127.0.0.1:9191');
      assert.ok(typeof res.stop === 'function');
      await res.stop();
    });

    it('sync executes command and captures exit code and output', async () => {
      const transport = new HaravanCliProcessTransport({
        binaryPath: process.execPath,
      });

      const res = await transport.exec(['-e', 'console.log("Haravan CLI Sync OK"); process.exit(0);']);
      assert.equal(res.exitCode, 0);
      assert.match(res.stdout ?? '', /Haravan CLI Sync OK/);
    });

    it('enforces execution timeout and terminates runaway process', async () => {
      const transport = new HaravanCliProcessTransport({
        binaryPath: process.execPath,
      });

      const res = await transport.exec(
        ['-e', 'setInterval(() => {}, 1000);'],
        { timeoutMs: 80 }
      );
      assert.equal(res.exitCode, 124);
      assert.match(res.stderr ?? '', /timed out/);
    });
  });
});
