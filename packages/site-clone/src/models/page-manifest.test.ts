import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  PageManifestEngine,
  PageSurface,
  GlobalAssetsManifest,
  ThemeSettingsManifest,
  ThemeFixtureManifest,
  ThemeBundleMetadata,
  ThemeBundleIR,
  PageManifest,
  DEFAULT_VIEWPORTS,
  MANIFEST_FILENAME,
} from './page-manifest.js';

describe('Multi-Page Manifest & ThemeBundleIR (Audit §53)', () => {
  const engine = new PageManifestEngine();

  describe('1. Model Shape & Types Invariants', () => {
    it('satisfies PageManifest & ThemeBundleIR interface definitions', () => {
      const surface: PageSurface = {
        id: 'surface-home',
        name: 'Trang chủ Storefront',
        route: {
          kind: 'home',
          pattern: '/',
          template: 'index',
          canonicalUrl: '/',
        },
        template: 'index',
        entities: [],
        sections: ['header', 'banner-slideshow', 'featured-collection', 'footer'],
        viewports: ['desktop', 'tablet', 'mobile'],
      };

      const globalAssets: GlobalAssetsManifest = {
        stylesheets: ['assets/theme.css', 'assets/vendor.css'],
        scripts: ['assets/theme.js', 'assets/vendor.js'],
        images: ['assets/logo.png', 'assets/favicon.ico'],
        fonts: ['assets/roboto.woff2'],
      };

      const settings: ThemeSettingsManifest = {
        schema: [{ name: 'Colors', settings: [] }],
        data: { color_primary: '#ff5500', logo_width: 180 },
      };

      const fixtures: ThemeFixtureManifest[] = [
        {
          id: 'fixture-product-ao-thun',
          type: 'product',
          cleanupTag: 'CANARY_FIXTURE_PRODUCT_001',
          handle: 'ao-thun-cotton-unisex',
        },
      ];

      const metadata: ThemeBundleMetadata = {
        version: '1.2.0',
        generatedAt: '2026-09-12T10:00:00.000Z',
        sourceStore: 'https://reference-fashion.vn',
        targetThemeId: 199920,
      };

      const bundle: ThemeBundleIR = {
        surfaces: [surface],
        globalAssets,
        settings,
        fixtures,
        metadata,
      };

      // Type alias equivalence
      const manifest: PageManifest = bundle;
      assert.strictEqual(manifest.surfaces.length, 1);
      assert.strictEqual(manifest.surfaces[0].id, 'surface-home');
      assert.strictEqual(manifest.globalAssets.stylesheets.length, 2);
      assert.strictEqual(manifest.settings.data.color_primary, '#ff5500');
      assert.strictEqual(manifest.fixtures[0].type, 'product');
      assert.strictEqual(manifest.metadata.targetThemeId, 199920);
    });
  });

  describe('2. PageManifestEngine.buildBundleIR', () => {
    it('builds a canonical ThemeBundleIR with sensible fail-safe defaults', () => {
      const bundle = engine.buildBundleIR();

      assert.ok(Array.isArray(bundle.surfaces));
      assert.strictEqual(bundle.surfaces.length, 0);

      assert.deepStrictEqual(bundle.globalAssets, {
        stylesheets: [],
        scripts: [],
        images: [],
        fonts: [],
      });

      assert.deepStrictEqual(bundle.settings, {
        schema: [],
        data: {},
      });

      assert.deepStrictEqual(bundle.fixtures, []);

      assert.strictEqual(bundle.metadata.version, '1.0.0');
      assert.strictEqual(typeof bundle.metadata.generatedAt, 'string');
      assert.ok(!isNaN(Date.parse(bundle.metadata.generatedAt)));
      assert.strictEqual(bundle.metadata.targetThemeId, 0);
    });

    it('normalizes surface declarations and auto-fills missing viewports & route mapping', () => {
      const bundle = engine.buildBundleIR({
        surfaces: [
          {
            name: 'Trang sản phẩm chi tiết',
            template: 'product',
            sections: ['main-product', 'product-recommendations'],
          },
          {
            id: 'surface-catalog',
            route: 'https://fashion-demo.vn/collections/dam-nu?page=2',
            sections: ['collection-header', 'collection-grid'],
            viewports: ['desktop', 'mobile'],
          },
        ],
        sourceStore: 'https://fashion-demo.vn',
        targetThemeId: 'theme_staging_123',
      });

      assert.strictEqual(bundle.surfaces.length, 2);

      // First surface: product
      const s0 = bundle.surfaces[0];
      assert.strictEqual(s0.id, 'surface-product-0');
      assert.strictEqual(s0.name, 'Trang sản phẩm chi tiết');
      assert.strictEqual(s0.template, 'product');
      assert.deepStrictEqual(s0.viewports, DEFAULT_VIEWPORTS);
      assert.strictEqual(s0.route.kind, 'product');

      // Second surface: collection resolved from reference route
      const s1 = bundle.surfaces[1];
      assert.strictEqual(s1.id, 'surface-catalog');
      assert.strictEqual(s1.template, 'collection');
      assert.deepStrictEqual(s1.viewports, ['desktop', 'mobile']);
      assert.strictEqual(s1.route.kind, 'collection');
      assert.strictEqual(s1.route.handle, 'dam-nu');

      assert.strictEqual(bundle.metadata.sourceStore, 'https://fashion-demo.vn');
      assert.strictEqual(bundle.metadata.targetThemeId, 'theme_staging_123');
    });

    it('deduplicates and trims global asset references', () => {
      const bundle = engine.buildBundleIR({
        globalAssets: {
          stylesheets: ['assets/main.css', '  assets/main.css  ', 'assets/vendor.css', ''],
          scripts: ['assets/app.js', 'assets/app.js', 'assets/runtime.js'],
          images: ['assets/logo.svg', 'assets/logo.svg'],
          fonts: ['assets/font.woff2', 'assets/font.woff2'],
        },
      });

      assert.deepStrictEqual(bundle.globalAssets.stylesheets, ['assets/main.css', 'assets/vendor.css']);
      assert.deepStrictEqual(bundle.globalAssets.scripts, ['assets/app.js', 'assets/runtime.js']);
      assert.deepStrictEqual(bundle.globalAssets.images, ['assets/logo.svg']);
      assert.deepStrictEqual(bundle.globalAssets.fonts, ['assets/font.woff2']);
    });

    it('normalizes fixtures and preserves extra options', () => {
      const bundle = engine.buildBundleIR({
        fixtures: [
          { type: 'product' },
          { id: 'custom-canary', type: 'collection', cleanupTag: 'CANARY_COLL_99' },
        ],
        extraIRKey: 'custom-ir-payload',
        themeFiles: {
          'layout/theme.liquid': '<html>{{ content_for_layout }}</html>',
        },
      });

      assert.strictEqual(bundle.fixtures.length, 2);
      assert.strictEqual(bundle.fixtures[0].id, 'fixture-product-0');
      assert.strictEqual(bundle.fixtures[0].cleanupTag, 'CANARY_FIXTURE_fixture-product-0');

      assert.strictEqual(bundle.fixtures[1].id, 'custom-canary');
      assert.strictEqual(bundle.fixtures[1].cleanupTag, 'CANARY_COLL_99');

      assert.strictEqual(bundle.extraIRKey, 'custom-ir-payload');
      assert.strictEqual(bundle.themeFiles['layout/theme.liquid'], '<html>{{ content_for_layout }}</html>');
    });
  });

  describe('3. PageManifestEngine.exportManifest & loadManifest', () => {
    it('roundtrips a ThemeBundleIR to disk and back with exact fidelity', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antifan-manifest-test-'));

      try {
        const originalBundle: ThemeBundleIR = engine.buildBundleIR({
          surfaces: [
            {
              id: 'surface-home',
              name: 'Home Index',
              template: 'index',
              sections: ['header', 'hero-slider', 'footer'],
              viewports: ['desktop', 'mobile'],
              entities: [],
            },
            {
              id: 'surface-product',
              name: 'Product Details',
              template: 'product',
              sections: ['main-product', 'related-products'],
              viewports: ['desktop', 'tablet', 'mobile'],
              entities: [{ id: 101, handle: 'vay-hoa' }],
            },
          ],
          globalAssets: {
            stylesheets: ['assets/theme.css'],
            scripts: ['assets/app.js'],
            images: ['assets/logo.png'],
            fonts: ['assets/font.woff2'],
          },
          settings: {
            schema: [{ name: 'General', settings: [{ id: 'logo', type: 'image_picker' }] }],
            data: { logo: 'logo.png', show_announcement: true },
          },
          fixtures: [
            { id: 'canary-prod-1', type: 'product', cleanupTag: 'CLEANUP_PROD_1' },
          ],
          metadata: {
            version: '2.0.0',
            generatedAt: '2026-09-12T12:00:00.000Z',
            sourceStore: 'https://orig-store.com',
            targetThemeId: 887766,
          },
        });

        // 1. Export manifest
        const manifestFilePath = await engine.exportManifest(originalBundle, tmpDir);
        assert.strictEqual(manifestFilePath, path.join(tmpDir, MANIFEST_FILENAME));

        const stat = await fs.stat(manifestFilePath);
        assert.ok(stat.isFile() && stat.size > 0);

        // 2. Load manifest by directory
        const loadedFromDir = await engine.loadManifest(tmpDir);
        assert.strictEqual(loadedFromDir.surfaces.length, 2);
        assert.strictEqual(loadedFromDir.surfaces[0].id, 'surface-home');
        assert.strictEqual(loadedFromDir.surfaces[1].entities[0].handle, 'vay-hoa');
        assert.strictEqual(loadedFromDir.settings.data.show_announcement, true);
        assert.strictEqual(loadedFromDir.fixtures[0].cleanupTag, 'CLEANUP_PROD_1');
        assert.strictEqual(loadedFromDir.metadata.version, '2.0.0');
        assert.strictEqual(loadedFromDir.metadata.targetThemeId, 887766);

        // 3. Load manifest directly by file path
        const loadedFromFile = await engine.loadManifest(manifestFilePath);
        assert.strictEqual(loadedFromFile.surfaces.length, 2);
        assert.strictEqual(loadedFromFile.surfaces[0].name, 'Home Index');

        // 4. Fallback legacy filename loading
        const legacyPath = path.join(tmpDir, 'theme-bundle-ir.json');
        await fs.copyFile(manifestFilePath, legacyPath);
        await fs.unlink(manifestFilePath);

        const loadedFromLegacy = await engine.loadManifest(tmpDir);
        assert.strictEqual(loadedFromLegacy.surfaces.length, 2);
        assert.strictEqual(loadedFromLegacy.surfaces[0].id, 'surface-home');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects invalid inputs on export and load', async () => {
      await assert.rejects(
        () => engine.exportManifest(null as any, '/tmp/any'),
        /bundle must be a valid ThemeBundleIR object/
      );

      await assert.rejects(
        () => engine.exportManifest({} as any, ''),
        /targetDir must be a non-empty string/
      );

      await assert.rejects(
        () => engine.loadManifest(''),
        /sourceDir must be a non-empty string/
      );

      await assert.rejects(
        () => engine.loadManifest('/path/that/does/not/exist/at/all'),
        /path does not exist/
      );

      const emptyTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antifan-empty-manifest-'));
      try {
        await assert.rejects(
          () => engine.loadManifest(emptyTmpDir),
          /No manifest file found in directory/
        );

        // Corrupted JSON
        const corruptFile = path.join(emptyTmpDir, 'page-manifest.json');
        await fs.writeFile(corruptFile, '{ invalid json syntax ...', 'utf-8');
        await assert.rejects(
          () => engine.loadManifest(emptyTmpDir),
          /Failed to parse JSON/
        );
      } finally {
        await fs.rm(emptyTmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('4. PageManifestEngine.validateBundleIntegrity', () => {
    it('validates a complete, healthy ThemeBundleIR successfully', () => {
      const validBundle: ThemeBundleIR = engine.buildBundleIR({
        surfaces: [
          {
            id: 'surface-home',
            name: 'Trang chủ',
            template: 'index',
            sections: ['header', 'footer'],
            viewports: ['desktop', 'mobile'],
          },
          {
            id: 'surface-product-1',
            name: 'Chi tiết sản phẩm',
            template: 'product',
            sections: ['main-product'],
            viewports: ['desktop'],
          },
        ],
        globalAssets: {
          stylesheets: ['assets/style.css'],
          scripts: ['assets/script.js'],
          images: ['assets/banner.jpg'],
          fonts: ['assets/font.woff2'],
        },
        settings: {
          schema: [{ name: 'Theme', settings: [] }],
          data: { color: '#ffffff' },
        },
        fixtures: [
          { id: 'fix-1', type: 'product', cleanupTag: 'CLEANUP_1' },
        ],
        metadata: {
          version: '1.0.0',
          generatedAt: new Date().toISOString(),
          targetThemeId: 12345,
        },
      });

      const result = engine.validateBundleIntegrity(validBundle);
      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.missingSurfaces, []);
      assert.deepStrictEqual(result.errors, []);
    });

    it('detects missing required surfaces (default: home)', () => {
      const bundleWithoutHome = engine.buildBundleIR({
        surfaces: [
          {
            id: 'surface-product-only',
            name: 'Sản phẩm',
            template: 'product',
            sections: ['product'],
            viewports: ['desktop'],
          },
        ],
      });

      const result = engine.validateBundleIntegrity(bundleWithoutHome);
      assert.strictEqual(result.valid, false);
      assert.ok(result.missingSurfaces.includes('home'));
      assert.ok(result.errors.some(e => e.includes('Missing required surface: "home"')));
    });

    it('enforces custom required surfaces list', () => {
      const bundle = engine.buildBundleIR({
        surfaces: [
          { id: 'surface-home', name: 'Home', template: 'index', sections: [], viewports: ['desktop'] },
        ],
      });

      const result = engine.validateBundleIntegrity(bundle, {
        requiredSurfaces: ['home', 'product', 'collection', 'cart'],
      });

      assert.strictEqual(result.valid, false);
      assert.ok(!result.missingSurfaces.includes('home'));
      assert.ok(result.missingSurfaces.includes('product'));
      assert.ok(result.missingSurfaces.includes('collection'));
      assert.ok(result.missingSurfaces.includes('cart'));
    });

    it('detects empty or invalid surfaces list', () => {
      const emptyBundle = engine.buildBundleIR({ surfaces: [] });
      const result = engine.validateBundleIntegrity(emptyBundle);

      assert.strictEqual(result.valid, false);
      assert.ok(result.missingSurfaces.includes('home'));
      assert.ok(result.errors.some(e => e.includes('zero page surfaces')));

      const nonArraySurfaces = { ...emptyBundle, surfaces: 'invalid' as any };
      const nonArrayResult = engine.validateBundleIntegrity(nonArraySurfaces);
      assert.strictEqual(nonArrayResult.valid, false);
      assert.ok(nonArrayResult.errors.some(e => e.includes('must be an array')));
    });

    it('detects duplicate surface IDs, missing templates, and empty viewports', () => {
      const invalidBundle: ThemeBundleIR = {
        surfaces: [
          {
            id: 'duplicate-id',
            name: 'Page A',
            route: { kind: 'home', template: 'index' },
            template: 'index',
            entities: [],
            sections: [],
            viewports: ['desktop'],
          },
          {
            id: 'duplicate-id',
            name: 'Page B',
            route: {},
            template: '',
            entities: [],
            sections: [],
            viewports: [], // Empty viewports
          },
        ],
        globalAssets: { stylesheets: [], scripts: [], images: [], fonts: [] },
        settings: { schema: [], data: {} },
        fixtures: [],
        metadata: { version: '1.0.0', generatedAt: new Date().toISOString(), targetThemeId: 1 },
      };

      const result = engine.validateBundleIntegrity(invalidBundle);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Duplicate surface ID: "duplicate-id"')));
      assert.ok(result.errors.some(e => e.includes('missing or empty template')));
      assert.ok(result.errors.some(e => e.includes('must specify at least one viewport')));
    });

    it('detects path traversal attempts in globalAssets', () => {
      const traversalBundle: ThemeBundleIR = {
        surfaces: [
          {
            id: 'surface-home',
            name: 'Home',
            route: { kind: 'home', template: 'index' },
            template: 'index',
            entities: [],
            sections: [],
            viewports: ['desktop'],
          },
        ],
        globalAssets: {
          stylesheets: ['assets/safe.css', '../../etc/passwd'],
          scripts: ['assets/vendor.js'],
          images: ['assets/image.png\0bad'],
          fonts: [],
        },
        settings: { schema: [], data: {} },
        fixtures: [],
        metadata: { version: '1.0.0', generatedAt: new Date().toISOString(), targetThemeId: 1 },
      };

      const result = engine.validateBundleIntegrity(traversalBundle);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('invalid path traversal: "../../etc/passwd"')));
      assert.ok(result.errors.some(e => e.includes('invalid path traversal: "assets/image.png\0bad"')));
    });

    it('detects duplicate fixture IDs and missing fixture fields', () => {
      const fixtureBundle: ThemeBundleIR = {
        surfaces: [
          {
            id: 'surface-home',
            name: 'Home',
            route: { kind: 'home', template: 'index' },
            template: 'index',
            entities: [],
            sections: [],
            viewports: ['desktop'],
          },
        ],
        globalAssets: { stylesheets: [], scripts: [], images: [], fonts: [] },
        settings: { schema: [], data: {} },
        fixtures: [
          { id: 'fix-dup', type: 'product', cleanupTag: 'CANARY_1' },
          { id: 'fix-dup', type: '', cleanupTag: '' },
        ],
        metadata: { version: '1.0.0', generatedAt: new Date().toISOString(), targetThemeId: 1 },
      };

      const result = engine.validateBundleIntegrity(fixtureBundle);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Duplicate fixture ID: "fix-dup"')));
      assert.ok(result.errors.some(e => e.includes('missing or empty type')));
      assert.ok(result.errors.some(e => e.includes('missing or empty cleanupTag')));
    });

    it('detects invalid metadata (bad version, non-ISO generatedAt, missing targetThemeId)', () => {
      const badMetaBundle: ThemeBundleIR = {
        surfaces: [
          {
            id: 'surface-home',
            name: 'Home',
            route: { kind: 'home', template: 'index' },
            template: 'index',
            entities: [],
            sections: [],
            viewports: ['desktop'],
          },
        ],
        globalAssets: { stylesheets: [], scripts: [], images: [], fonts: [] },
        settings: { schema: [], data: {} },
        fixtures: [],
        metadata: {
          version: '',
          generatedAt: 'not-a-valid-date-string',
          targetThemeId: undefined as any,
        },
      };

      const result = engine.validateBundleIntegrity(badMetaBundle);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('metadata.version must be a non-empty string')));
      assert.ok(result.errors.some(e => e.includes('not a valid ISO date string')));
      assert.ok(result.errors.some(e => e.includes('metadata.targetThemeId must be defined')));
    });
  });

  describe('5. Static Class Method Delegates', () => {
    it('executes static delegates identically to instance methods', async () => {
      const bundle = PageManifestEngine.buildBundleIR({
        surfaces: [
          { id: 'home', name: 'Home', template: 'index', sections: ['header'], viewports: ['desktop'] },
        ],
        metadata: { targetThemeId: 555 },
      });

      assert.strictEqual(bundle.surfaces[0].id, 'home');
      const validation = PageManifestEngine.validateBundleIntegrity(bundle);
      assert.strictEqual(validation.valid, true);

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antifan-static-manifest-'));
      try {
        const exportedPath = await PageManifestEngine.exportManifest(bundle, tmpDir);
        const loaded = await PageManifestEngine.loadManifest(exportedPath);
        assert.strictEqual(loaded.surfaces[0].id, 'home');
        assert.strictEqual(loaded.metadata.targetThemeId, 555);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
