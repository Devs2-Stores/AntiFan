import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DoDValidator,
  DOD_CRITERIA_KEYS,
  DOD_CRITERIA_SPECS,
  type DoDCriterionKey,
  type DoDContext,
} from './dod-validator.js';
import { FixtureRegistry } from '../platform/haravan/entity-resolver.js';
import { FinalProvenanceLedger } from './final-provenance-ledger.js';

describe('DoDValidator - Automated Definition of Done Validator (Audit §63, §68)', () => {
  const validator = new DoDValidator();

  describe('1. Canonical Criteria Catalogue (§63)', () => {
    it('declares exactly 19 canonical criteria keys in order', () => {
      assert.strictEqual(DOD_CRITERIA_KEYS.length, 19, 'Must define exactly 19 criteria');
      const expectedKeys: DoDCriterionKey[] = [
        'textReference',
        'visualBaseline',
        'semanticExtraction',
        'haravanDiscovery',
        'existingDataMatching',
        'minimalFixture',
        'haravanLiquidGenerator',
        'schemaGeneration',
        'settingsBinding',
        'themeAssetGeneration',
        'writeThemeCopy',
        'haravanPreview',
        'realBrowserRender',
        'strictVerification',
        'dynamicDataVerification',
        'liquidVerification',
        'schemaVerification',
        'routeVerification',
        'dependencyVerification',
      ];
      assert.deepStrictEqual(Array.from(DOD_CRITERIA_KEYS), expectedKeys);
    });

    it('provides metadata specs for all 19 criteria', () => {
      for (const key of DOD_CRITERIA_KEYS) {
        const spec = DOD_CRITERIA_SPECS[key];
        assert.ok(spec, `Spec must exist for criterion: ${key}`);
        assert.strictEqual(spec.key, key);
        assert.ok(spec.name.length > 0, `Name must not be empty for ${key}`);
        assert.ok(spec.auditSection.startsWith('§63.'), `Section must reference §63 for ${key}`);
        assert.ok(spec.description.length > 0, `Description must not be empty for ${key}`);
      }
    });
  });

  describe('2. Individual Criteria Auditing', () => {
    // 1. textReference
    describe('1) textReference', () => {
      it('passes when valid reference URL string is provided', () => {
        const res = validator.auditTextReference({ referenceUrl: 'https://demo-store.myharavan.com/products/shirt' });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('https://demo-store.myharavan.com'));
      });

      it('passes when structured reference contract object is provided', () => {
        const res = validator.auditTextReference({
          referenceContract: { contractId: 'REF-2026-09', targetUrl: 'https://reference-brand.com' },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('https://reference-brand.com'));
      });

      it('fails when reference is missing or invalid', () => {
        const res1 = validator.auditTextReference({});
        assert.strictEqual(res1.passed, false);
        assert.ok(res1.reason?.includes('Reference contract is missing'));

        const res2 = validator.auditTextReference({ referenceUrl: 'not a url' });
        assert.strictEqual(res2.passed, false);
        assert.ok(res2.reason?.includes('Invalid reference URL'));
      });
    });

    // 2. visualBaseline
    describe('2) visualBaseline', () => {
      it('passes when IndependentHtmlCloneResult baseline is provided', () => {
        const res = validator.auditVisualBaseline({
          staticClone: {
            success: true,
            entryHtmlPath: '/tmp/stage/index.html',
            filesWritten: ['/tmp/stage/index.html', '/tmp/stage/assets/style.css'],
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('/tmp/stage/index.html'));
      });

      it('passes when HTML and CSS baseline strings are provided', () => {
        const res = validator.auditVisualBaseline({
          visualBaseline: { html: '<main>Storefront content</main>', css: 'body { margin: 0; }' },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('HTML present'));
      });

      it('fails when baseline is missing or generation failed', () => {
        const res1 = validator.auditVisualBaseline({});
        assert.strictEqual(res1.passed, false);

        const res2 = validator.auditVisualBaseline({ staticClone: { success: false, error: 'Network timeout' } });
        assert.strictEqual(res2.passed, false);
        assert.ok(res2.reason?.includes('Network timeout'));
      });
    });

    // 3. semanticExtraction
    describe('3) semanticExtraction', () => {
      it('passes when Clone IR has component sections', () => {
        const res = validator.auditSemanticExtraction({
          cloneIR: {
            irVersion: '1.0',
            sections: [
              { id: 'header', type: 'header', markup: '<header></header>' },
              { id: 'hero', type: 'hero', markup: '<section></section>' },
            ],
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('2 component section contracts'));
      });

      it('fails when Clone IR is missing or has zero components', () => {
        const res1 = validator.auditSemanticExtraction({});
        assert.strictEqual(res1.passed, false);

        const res2 = validator.auditSemanticExtraction({ cloneIR: { sections: [] } });
        assert.strictEqual(res2.passed, false);
        assert.ok(res2.reason?.includes('zero components'));
      });
    });

    // 4. haravanDiscovery
    describe('4) haravanDiscovery', () => {
      it('passes when store inventory contains catalog data', () => {
        const res = validator.auditHaravanDiscovery({
          storeInventory: {
            products: [{ id: 1, title: 'Item' }],
            collections: [{ id: 10, title: 'Summer' }],
            themeAssets: ['assets/theme.css'],
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('1 products, 1 collections'));
      });

      it('fails when store inventory is empty', () => {
        const res = validator.auditHaravanDiscovery({
          storeInventory: { products: [], collections: [], themeAssets: [] },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('inventory empty'));
      });
    });

    // 5. existingDataMatching
    describe('5) existingDataMatching', () => {
      it('passes when EXISTING_DATA_FIRST policy is enforced', () => {
        const res = validator.auditExistingDataMatching({
          entityMatches: {
            policy: 'EXISTING_DATA_FIRST',
            matchedCount: 5,
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('EXISTING_DATA_FIRST'));
      });

      it('fails when an invalid or non-compliant policy is used', () => {
        const res = validator.auditExistingDataMatching({
          entityMatches: {
            policy: 'SYNTHETIC_CANARY_FIRST',
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Must enforce EXISTING_DATA_FIRST'));
      });
    });

    // 6. minimalFixture
    describe('6) minimalFixture', () => {
      it('passes when FixtureRegistry instance has executable delete cleanup plan', () => {
        const registry = new FixtureRegistry();
        registry.registerFixture({ id: 'fixture-1', type: 'product' });
        registry.registerFixture({ id: 'fixture-2', type: 'collection' });

        const res = validator.auditMinimalFixture({ fixtureRegistry: registry });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('2 fixture(s) tracked'));
        assert.ok(res.evidence?.includes('cleanup plan'));
      });

      it('passes when zero fixtures were created (100% matched to existing)', () => {
        const res = validator.auditMinimalFixture({
          minimalFixture: { fixtureCount: 0, cleanupPlan: [] },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('0 unnecessary canary fixtures'));
      });

      it('fails when fixtures were created but cleanup plan is missing', () => {
        const res = validator.auditMinimalFixture({
          minimalFixture: { fixtureCount: 3, cleanupPlan: [] },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Cleanup plan missing'));
      });
    });

    // 7. haravanLiquidGenerator
    describe('7) haravanLiquidGenerator', () => {
      it('passes when sections or templates are generated', () => {
        const res = validator.auditHaravanLiquidGenerator({
          liquidOutput: {
            sectionCount: 4,
            sections: ['header.liquid', 'featured-collection.liquid'],
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('4 valid flat template/snippet components'));
      });

      it('fails when no liquid files or sections are produced', () => {
        const res = validator.auditHaravanLiquidGenerator({
          liquidOutput: { sectionCount: 0, sections: [] },
        });
        assert.strictEqual(res.passed, false);
      });
    });

    // 8. schemaGeneration
    describe('8) schemaGeneration', () => {
      it('passes when dynamic schemas are extracted with name and settings', () => {
        const res = validator.auditSchemaGeneration({
          sectionSchemas: [
            { name: 'Featured Products', settings: [{ id: 'title', type: 'text', label: 'Title' }] },
          ],
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('1 valid setting group'));
      });

      it('fails when schema definitions are missing', () => {
        const res = validator.auditSchemaGeneration({});
        assert.strictEqual(res.passed, false);
      });
    });

    // 9. settingsBinding
    describe('9) settingsBinding', () => {
      it('normalizes and verifies settingsSchema and settingsData automatically', () => {
        const res = validator.auditSettingsBinding({
          settingsSchema: [{ name: 'General', settings: [] }],
          settingsData: { color_primary: '#ff0000', add_to_cart_show: true },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('SettingsAssetsNormalizer executed'));
      });

      it('passes with pre-verified compliant flag', () => {
        const res = validator.auditSettingsBinding({
          settingsBinding: { compliant: true, unmappedCount: 0 },
        });
        assert.strictEqual(res.passed, true);
      });
    });

    // 10. themeAssetGeneration
    describe('10) themeAssetGeneration', () => {
      it('passes when synthesized assets list is non-empty', () => {
        const res = validator.auditThemeAssetGeneration({
          themeAssets: ['assets/theme.css', 'assets/theme.js', 'assets/icon-cart.svg'],
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('3 assets synthesized'));
      });

      it('fails when theme assets are empty', () => {
        const res = validator.auditThemeAssetGeneration({ themeAssets: [] });
        assert.strictEqual(res.passed, false);
      });
    });

    // 11. writeThemeCopy
    describe('11) writeThemeCopy', () => {
      it('passes when atomic theme write completed successfully', () => {
        const res = validator.auditWriteThemeCopy({
          themeCopy: { success: true, filesWritten: ['snippets/hero.liquid', 'layout/theme.liquid'] },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('2 files written atomically'));
      });

      it('fails when partial or corrupted write is reported', () => {
        const res = validator.auditWriteThemeCopy({
          themeCopy: { success: false, corrupted: true, reason: 'Disk full' },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('corrupted') || res.reason?.includes('Disk full'));
      });
    });

    // 12. haravanPreview
    describe('12) haravanPreview', () => {
      it('passes when preview URL has themeid parameter', () => {
        const res = validator.auditHaravanPreview({
          previewUrl: 'https://store.myharavan.com/?themeid=12345678',
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('themeid=12345678'));
      });

      it('fails when preview URL is missing preview token', () => {
        const res = validator.auditHaravanPreview({
          previewUrl: 'https://store.myharavan.com/products/all?preview=true',
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('missing Haravan preview token'));
      });

      it('rejects a non-numeric themeid and the Shopify theme-selection spellings', () => {
        for (const previewUrl of [
          'https://store.myharavan.com/?themeid=',
          'https://store.myharavan.com/?themeid=abc',
          'https://store.myharavan.com/?theme_id=12345678',
          'https://store.myharavan.com/?preview_theme_id=12345678',
        ]) {
          const res = validator.auditHaravanPreview({ previewUrl });
          assert.strictEqual(res.passed, false, `expected refusal for ${previewUrl}`);
        }
      });

      it('accepts a numeric themeid alongside other query parameters', () => {
        const res = validator.auditHaravanPreview({
          previewUrl: 'https://store.myharavan.com/?view=all&themeid=12345678&utm_source=x',
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('themeid=12345678'));
      });
    });

    // 13. realBrowserRender / Theme QA
    describe('13) realBrowserRender', () => {
      it('passes when browser render executes with HTTP 200 and DOM ready', () => {
        const res = validator.auditRealBrowserRender({
          browserRender: { status: 200, domLoaded: true, rendered: true, viewport: { width: 1440, height: 900 } },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('status 200'));
      });

      it('passes when Theme QA actual verdict is PASS with zero critical issues', () => {
        const res = validator.auditRealBrowserRender({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/',
          themeQa: {
            summary: { verdict: 'PASS', criticalCount: 0, passed: true },
            surface: 'desktop',
            targetUrl: 'https://demo.haravan.com/',
            domLoaded: true,
            rendered: true,
          },
        });
        assert.strictEqual(res.passed, true);
      });

      it('fails when Theme QA detects critical issues', () => {
        const res = validator.auditRealBrowserRender({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/',
          themeQa: {
            summary: { verdict: 'FAIL', criticalCount: 3, passed: false },
            surface: 'desktop',
            targetUrl: 'https://demo.haravan.com/',
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Theme QA detected 3 critical issue(s)'));
      });

      it('fails when Theme QA verdict is INCONCLUSIVE', () => {
        const res = validator.auditRealBrowserRender({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/',
          themeQa: {
            summary: { verdict: 'INCONCLUSIVE', criticalCount: 0, passed: false },
            surface: 'desktop',
            targetUrl: 'https://demo.haravan.com/',
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('INCONCLUSIVE'));
      });

      it('fails when Theme QA checklist reports failure on active checks', () => {
        const res = validator.auditRealBrowserRender({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/',
          themeQa: {
            summary: { verdict: 'PASS', criticalCount: 0, passed: true },
            checklist: { layout: false, responsive: true, overflow: true, liquidClean: true, assetsValid: true, hsCompliant: true },
            surface: 'desktop',
            targetUrl: 'https://demo.haravan.com/',
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Theme QA checklist reported failure on: layout'));
      });
      it('fails when browser reports crash or fatal error', () => {
        const res = validator.auditRealBrowserRender({
          browserRender: { status: 500, fatalError: 'Target crashed' },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Browser crash'));
      });
    });

    // 14. strictVerification
    describe('14) strictVerification', () => {
      it('passes when visual diff conforms to canonical comparator match/status metric contract', () => {
        const res = validator.auditStrictVerification({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/products/polo',
          visualDiff: {
            match: true,
            status: 'PASS',
            mismatchPercentage: 1.2,
            diffPercentage: 1.2,
            tolerance: 5.0,
            surface: 'desktop',
            targetUrl: 'https://demo.haravan.com/products/polo',
            diffPixels: 48,
            totalPixels: 4000,
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('diff 1.20%'));
        assert.ok(res.evidence?.includes('diffPixels: 48/4000'));
      });

      it('passes when visual comparison provides canonical VisualEvidenceReceipt and MATCH status with mismatchedPixels fallback', () => {
        const res = validator.auditStrictVerification({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/products/polo',
          visualDiff: {
            status: 'MATCH',
            mismatchedPixels: 15,
            totalPixels: 3000,
            mismatchPercentage: 0.5,
            receipt: {
              match: true,
              mismatchPercentage: 0.5,
              dimensionsMatch: true,
              captureStateCompatible: true,
              maskResolutionStatus: 'ok',
              settleComplete: true,
            },
          },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('diff 0.50%'));
        assert.ok(res.evidence?.includes('diffPixels: 15/3000'));
      });
      it('supports explicit diagnostic mode for preflight diff check without full visual artifacts', () => {
        const res = validator.auditStrictVerification({
          mode: 'diagnostic',
          visualDiff: { diffPercentage: 1.2, tolerance: 5.0 },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('[Diagnostic]'));
      });

      it('fails in final mode when bare diffPercentage lacks comparator metric contract', () => {
        const res = validator.auditStrictVerification({
          visualDiff: { diffPercentage: 1.2, tolerance: 5.0 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('canonical comparator match/status metric contract'));
      });

      it('fails in final mode when candidate is only a loose string screenshot without comparator metrics', () => {
        const res = validator.auditStrictVerification({
          visualDiff: { screenshot: 'shot.png', passed: true },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('canonical comparator match/status metric contract'));
      });

      it('fails when canonical comparator reports match=false', () => {
        const res = validator.auditStrictVerification({
          visualDiff: {
            match: false,
            status: 'FAIL',
            diffPixels: 500,
            totalPixels: 4000,
            diffPercentage: 12.5,
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('match=false'));
      });

      it('fails when canonical comparator reports dimensions mismatch', () => {
        const res = validator.auditStrictVerification({
          visualDiff: {
            match: true,
            dimensionsMatch: false,
            diffPixels: 10,
            totalPixels: 4000,
            diffPercentage: 0.25,
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('dimensions mismatch'));
      });

      it('fails when visual diff exceeds tolerance', () => {
        const res = validator.auditStrictVerification({
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/products/polo',
          visualDiff: {
            diffPercentage: 7.8,
            tolerance: 5.0,
            surface: 'desktop',
            targetUrl: 'https://demo.haravan.com/products/polo',
            diffPixels: 312,
            totalPixels: 4000,
          },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('exceeds tolerance'));
      });

      it('regression: fails closed when visual receipts array is empty', () => {
        const res = validator.auditStrictVerification({
          visualDiff: { receipts: [] },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Missing visual verification receipts'));
      });

      it('regression: propagates failure when receipt verdict is FAIL, INCONCLUSIVE, or BLOCKED', () => {
        const res1 = validator.auditStrictVerification({
          visualDiff: { verdict: 'INCONCLUSIVE' },
        });
        assert.strictEqual(res1.passed, false);
        assert.ok(res1.reason?.includes('INCONCLUSIVE'));

        const res2 = validator.auditStrictVerification({
          visualDiff: {
            receipts: [{ id: 'r1', verdict: 'BLOCKED' }],
          },
        });
        assert.strictEqual(res2.passed, false);
        assert.ok(res2.reason?.includes('BLOCKED'));
      });

      it('regression: fails closed when visual verification surface target is mismatched', () => {
        const res = validator.auditStrictVerification({
          surface: 'desktop',
          visualDiff: { surface: 'mobile', diffPercentage: 1.0 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Wrong surface target'));
      });

      it('regression: fails closed when target URL does not match expected target', () => {
        const res = validator.auditStrictVerification({
          referenceUrl: 'https://source-store.com/products/hat',
          visualDiff: { targetUrl: 'https://source-store.com/products/shoes', diffPercentage: 1.0 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Wrong surface target URL'));
      });

      it('regression: fails closed when receipt revision does not match current artifact revision', () => {
        const res = validator.auditStrictVerification({
          revision: 'rev-v2-final',
          visualDiff: { revision: 'rev-v1-draft', diffPercentage: 1.0 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Artifact revision change'));
      });

      it('regression: rejects static lint approval or proxy in place of visual parity', () => {
        const res = validator.auditStrictVerification({
          visualDiff: { isLint: true, diffPercentage: 0.0, passed: true },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Static lint approval or proxy cannot replace visual comparison'));
      });

      it('regression: rejects stale or invalidated receipts', () => {
        const res = validator.auditStrictVerification({
          visualDiff: { isStale: true, diffPercentage: 0.5 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('stale or invalidated'));
      });

      it('regression: rejects bare ungrounded claims lacking visual diff telemetry', () => {
        const res = validator.auditStrictVerification({
          visualDiff: { passed: true },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason !== undefined);
      });
    });

    // 15. dynamicDataVerification
    describe('15) dynamicDataVerification', () => {
      it('passes when dynamic bindings are verified without static leaks', () => {
        const res = validator.auditDynamicDataVerification({
          dynamicBindings: { bindingsCount: 12, staticLeaksDetected: false },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('12 Liquid variable bindings'));
      });

      it('fails when static text leaks are detected', () => {
        const res = validator.auditDynamicDataVerification({
          dynamicBindings: { bindingsCount: 5, staticLeaksDetected: true, leakCount: 3 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('static text leaks detected'));
      });
    });

    // 16. liquidVerification
    describe('16) liquidVerification', () => {
      it('passes clean DotLiquid code', () => {
        const res = validator.auditLiquidVerification({
          dotLiquidSanitization: { sanitized: true, violations: [] },
        });
        assert.strictEqual(res.passed, true);
      });

      it('detects un-sanitized DotLiquid quirks in raw template strings', () => {
        const rawWithQuirks = '{{ customer.name | slice: 0, 5 }} {% if a != empty %}';
        const res = validator.auditLiquidVerification({ liquidVerification: rawWithQuirks });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('DotLiquid incompatibilities'));
      });

      it('validates clean raw liquid template string', () => {
        const cleanRaw = '{{ customer.name | truncate: 5, "" }} {% if a != blank %}';
        const res = validator.auditLiquidVerification({ liquidVerification: cleanRaw });
        assert.strictEqual(res.passed, true);
      });
    });

    // 17. schemaVerification
    describe('17) schemaVerification', () => {
      it('validates raw Haravan settings schema using HaravanSchemaGenerator', () => {
        const validSchema = {
          name: 'Hero Banner',
          settings: [
            { id: 'heading_text', type: 'text', label: 'Heading' },
            { id: 'background_color', type: 'color', label: 'Background Color' },
          ],
        };
        const res = validator.auditSchemaVerification({ os2SchemaValidation: validSchema });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('Hero Banner'));
      });

      it('fails when schema contains disallowed types or formatting errors', () => {
        const invalidSchema = {
          name: 'Bad Section',
          settings: [
            { id: 'font', type: 'font-size', label: 'Invalid type' }, // font-size is invalid in Haravan OS 2.0
          ],
        };
        const res = validator.auditSchemaVerification({ os2SchemaValidation: invalidSchema });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Schema validation failed'));
      });
    });

    // 18. routeVerification
    describe('18) routeVerification', () => {
      it('passes when canonical Haravan routes are mapped', () => {
        const res = validator.auditRouteVerification({
          routeResolver: { routeCount: 15, unmappedRoutes: 0 },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('15 canonical Haravan route(s)'));
      });

      it('passes when verifying a single reference URL string', () => {
        const res = validator.auditRouteVerification({ routeVerification: '/products/den-ban-hoc' });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('product'));
      });

      it('fails when unmapped routes are reported', () => {
        const res = validator.auditRouteVerification({
          routeResolver: { unmappedRoutes: 2 },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('unmapped or invalid storefront routes'));
      });
    });

    // 19. dependencyVerification
    describe('19) dependencyVerification', () => {
      it('passes when zero missing assets or snippets are detected', () => {
        const res = validator.auditDependencyVerification({
          assetDependencies: { missingAssets: [], missingSnippets: [], brokenReferences: 0 },
        });
        assert.strictEqual(res.passed, true);
        assert.ok(res.evidence?.includes('zero broken asset'));
      });

      it('fails when missing assets or snippets are found', () => {
        const res = validator.auditDependencyVerification({
          assetDependencies: { missingAssets: ['assets/missing-bg.png'], missingSnippets: [] },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Missing theme assets'));
      });

      it('fails when unresolved includes are detected', () => {
        const res = validator.auditDependencyVerification({
          assetDependencies: { missingAssets: [], missingSnippets: [], unresolvedIncludes: ['header_missing'] },
        });
        assert.strictEqual(res.passed, false);
        assert.ok(res.reason?.includes('Unresolved include targets'));
      });
    });
  });

  describe('3. Full DoD Evaluation Pipeline (evaluateDoD)', () => {
    it('certifies "FINAL" verdict and score 100 when all 19 criteria pass', () => {
      const registry = new FixtureRegistry();
      registry.registerFixture({ id: 'fixture-test', type: 'product' });

      const fullPassingContext: DoDContext = {
        // 1. textReference
        referenceUrl: 'https://demo.haravan.com/products/polo',
        // 2. visualBaseline
        staticClone: { success: true, entryHtmlPath: '/tmp/entry.html', filesWritten: ['/tmp/entry.html'] },
        // 3. semanticExtraction
        cloneIR: { sections: [{ id: 'header', name: 'Header' }] },
        // 4. haravanDiscovery
        storeInventory: { products: [{ id: 1, title: 'Item' }], collections: [{ id: 2, title: 'Summer' }], themeAssets: ['theme.css'] },
        // 5. existingDataMatching
        entityMatches: { policy: 'EXISTING_DATA_FIRST', matchedCount: 3 },
        // 6. minimalFixture
        fixtureRegistry: registry,
        // 7. haravanLiquidGenerator
        liquidOutput: { sectionCount: 2, sections: ['header.liquid', 'footer.liquid'] },
        // 8. schemaGeneration
        sectionSchemas: [{ name: 'Header', settings: [{ id: 'menu', type: 'link_list', label: 'Menu' }] }],
        // 9. settingsBinding
        settingsBinding: { compliant: true, unmappedCount: 0 },
        // 10. themeAssetGeneration
        themeAssets: ['assets/theme.css', 'assets/theme.js'],
        // 11. writeThemeCopy
        themeCopy: { success: true, filesWritten: ['layout/theme.liquid'] },
        // 12. haravanPreview
        surface: 'desktop',
        targetUrl: 'https://demo.haravan.com/products/polo',
        // 12. haravanPreview
        previewUrl: 'https://demo.haravan.com/?themeid=987654321',
        // 13. realBrowserRender
        browserRender: { status: 200, domLoaded: true, rendered: true, surface: 'desktop', url: 'https://demo.haravan.com/?themeid=987654321', screenshot: 'render.png' },
        // 14. strictVerification
        visualDiff: {
          match: true,
          status: 'PASS',
          diffPercentage: 1.5,
          mismatchPercentage: 1.5,
          tolerance: 5.0,
          surface: 'desktop',
          targetUrl: 'https://demo.haravan.com/products/polo',
          diffPixels: 60,
          totalPixels: 4000,
          dimensionsMatch: true,
        },
        // 15. dynamicDataVerification
        dynamicBindings: { bindingsCount: 8, staticLeaksDetected: false },
        // 16. liquidVerification
        dotLiquidSanitization: { sanitized: true, violations: [] },
        // 17. schemaVerification
        os2SchemaValidation: { valid: true },
        // 18. routeVerification
        routeResolver: { routeCount: 15, unmappedRoutes: 0 },
        // 19. dependencyVerification
        assetDependencies: { missingAssets: [], missingSnippets: [], brokenReferences: 0 },
      };

      const result = validator.evaluateDoD(fullPassingContext);

      assert.strictEqual(result.isDoDComplete, true);
      assert.strictEqual(result.score, 100);
      assert.strictEqual(result.passedCount, 19);
      assert.strictEqual(result.totalCount, 19);
      assert.strictEqual(result.verdict, 'FINAL');

      for (const key of DOD_CRITERIA_KEYS) {
        assert.strictEqual(result.criteria[key].passed, true, `Criterion ${key} should have passed`);
        assert.ok(result.criteria[key].evidence, `Criterion ${key} should have evidence`);
      }
    });

    it('returns "INCOMPLETE" verdict and accurate partial score when some criteria fail', () => {
      // 18 passing, 1 failing (e.g. strictVerification diff exceeded)
      const contextWithFailure: DoDContext = {
        referenceUrl: 'https://demo.haravan.com',
        staticClone: { success: true, entryHtmlPath: '/tmp/entry.html' },
        cloneIR: { sections: [{ id: 's1' }] },
        storeInventory: { products: [{ id: 1 }] },
        entityMatches: { policy: 'EXISTING_DATA_FIRST', matchedCount: 1 },
        minimalFixture: { fixtureCount: 0, cleanupPlan: [] },
        liquidOutput: { sectionCount: 1 },
        sectionSchemas: [{ name: 'S1', settings: [] }],
        settingsBinding: { compliant: true },
        themeAssets: ['assets/main.css'],
        themeCopy: { success: true, filesWritten: ['layout/theme.liquid'] },
        previewUrl: 'https://demo.haravan.com/?themeid=12345678',
        browserRender: { status: 200, domLoaded: true, rendered: true, screenshot: 'render.png' },
        visualDiff: { diffPercentage: 12.5, tolerance: 5.0, screenshot: 'diff.png' }, // FAILS: 12.5% > 5.0%
        dynamicBindings: { bindingsCount: 5 },
        dotLiquidSanitization: { sanitized: true },
        os2SchemaValidation: { valid: true },
        routeResolver: { routeCount: 10, unmappedRoutes: 0 },
        assetDependencies: { brokenReferences: 0 },
      };

      const result = validator.evaluateDoD(contextWithFailure);

      assert.strictEqual(result.isDoDComplete, false);
      assert.strictEqual(result.verdict, 'INCOMPLETE');
      assert.strictEqual(result.passedCount, 18);
      assert.strictEqual(result.totalCount, 19);
      // 18 / 19 * 100 = 94.7368... -> 94.74
      assert.strictEqual(result.score, 94.74);

      assert.strictEqual(result.criteria.strictVerification.passed, false);
      assert.ok(result.criteria.strictVerification.reason?.includes('exceeds tolerance'));
    });

    it('supports explicit criterion overrides via context.criteria', () => {
      const partialContext: DoDContext = {
        referenceUrl: 'https://example.com',
        criteria: {
          visualBaseline: { passed: true, evidence: 'Pre-certified visual baseline' },
          strictVerification: false,
        },
      };

      const result = validator.evaluateDoD(partialContext);

      assert.strictEqual(result.criteria.visualBaseline.passed, true);
      assert.strictEqual(result.criteria.visualBaseline.evidence, 'Pre-certified visual baseline');
      assert.strictEqual(result.criteria.strictVerification.passed, false);
      assert.ok(result.criteria.strictVerification.reason?.includes('explicit override'));
    });

    it('handles empty or undefined context gracefully', () => {
      const result1 = validator.evaluateDoD({});
      assert.strictEqual(result1.isDoDComplete, false);
      assert.strictEqual(result1.passedCount, 0);
      assert.strictEqual(result1.score, 0);
      assert.strictEqual(result1.verdict, 'INCOMPLETE');

      const result2 = validator.evaluateDoD(null);
      assert.strictEqual(result2.isDoDComplete, false);
      assert.strictEqual(result2.passedCount, 0);
    });

    it('returns "DIAGNOSTIC" verdict and isDoDComplete=false in diagnostic mode', () => {
      const registry = new FixtureRegistry();
      registry.registerFixture({ id: 'fixture-test', type: 'product' });

      const diagContext: DoDContext = {
        mode: 'diagnostic',
        referenceUrl: 'https://demo.haravan.com/products/polo',
        staticClone: { success: true, entryHtmlPath: '/tmp/entry.html', filesWritten: ['/tmp/entry.html'] },
        cloneIR: { sections: [{ id: 'header', name: 'Header' }] },
        storeInventory: { products: [{ id: 1, title: 'Item' }], collections: [{ id: 2, title: 'Summer' }], themeAssets: ['theme.css'] },
        entityMatches: { policy: 'EXISTING_DATA_FIRST', matchedCount: 3 },
        fixtureRegistry: registry,
        liquidOutput: { sectionCount: 2, sections: ['header.liquid', 'footer.liquid'] },
        sectionSchemas: [{ name: 'Header', settings: [{ id: 'menu', type: 'link_list', label: 'Menu' }] }],
        settingsBinding: { compliant: true, unmappedCount: 0 },
        themeAssets: ['assets/theme.css', 'assets/theme.js'],
        themeCopy: { success: true, filesWritten: ['layout/theme.liquid'] },
        previewUrl: 'https://demo.haravan.com/?themeid=987654321',
        browserRender: { status: 200, domLoaded: true, rendered: true },
        visualDiff: { diffPercentage: 1.5, tolerance: 5.0 }, // In diagnostic mode, bare diffPercentage passes diagnostically
        dynamicBindings: { bindingsCount: 8, staticLeaksDetected: false },
        dotLiquidSanitization: { sanitized: true, violations: [] },
        os2SchemaValidation: { valid: true },
        routeResolver: { routeCount: 15, unmappedRoutes: 0 },
        assetDependencies: { missingAssets: [], missingSnippets: [], brokenReferences: 0 },
      };

      const result = validator.evaluateDoD(diagContext);
      assert.strictEqual(result.isDoDComplete, false, 'Diagnostic run must never certify isDoDComplete=true');
      assert.strictEqual(result.verdict, 'DIAGNOSTIC', 'Diagnostic run must return DIAGNOSTIC verdict');
      assert.strictEqual(result.passedCount, 19);
      assert.strictEqual(result.score, 100);
    });

    it('rejects bare boolean true override attempting to bypass strictVerification', () => {
      const result = validator.evaluateDoD({
        criteria: {
          strictVerification: true,
        },
      });
      assert.strictEqual(result.criteria.strictVerification.passed, false);
      assert.ok(result.criteria.strictVerification.reason?.includes('cannot be certified via bare boolean override'));
    });
  });

  describe('4. Fail-Closed Acceptance & Provenance Invariants (§54, §63)', () => {
    it('rejects static lint overrides attempting to force pass on behavioral visual criteria', () => {
      const result = validator.evaluateDoD({
        criteria: {
          strictVerification: { passed: true, isLint: true, evidence: 'HTML linter passed 100%' } as unknown as boolean,
        },
      });

      assert.strictEqual(result.criteria.strictVerification.passed, false);
        assert.ok(result.criteria.strictVerification.reason !== undefined);
    });

    it('validates DoD with FinalProvenanceLedger receipt integration', () => {
      const ledger = new FinalProvenanceLedger({ instrumentRevision: 'rev-2026' });
      ledger.recordArtifact('templates/index.liquid', '<main>Storefront</main>');
      const receipt = ledger.recordReceipt({
        id: 'rec-idx-1',
        verdict: 'PASS',
        surface: 'desktop',
        targetUrl: 'https://store.haravan.com/',
        artifact: 'templates/index.liquid',
        evidence: ['Visual diff 0.8% <= 5.0%'],
      });

      const res = validator.auditStrictVerification({
        provenanceLedger: ledger,
        surface: 'desktop',
        referenceUrl: 'https://store.haravan.com/',
        revision: 'rev-2026',
        strictVerification: {
          receiptId: receipt.id,
          diffPercentage: 0.8,
          tolerance: 5.0,
        },
      });
      assert.strictEqual(res.passed, true);
      assert.ok(res.evidence?.includes('diff 0.80%'));
    });

    it('fails closed when ledger receipt was invalidated after template modification', () => {
      const ledger = new FinalProvenanceLedger({ instrumentRevision: 'rev-2026' });
      ledger.recordArtifact('templates/index.liquid', '<main>Storefront v1</main>');
      const receipt = ledger.recordReceipt({
        id: 'rec-idx-2',
        verdict: 'PASS',
        surface: 'desktop',
        targetUrl: 'https://store.haravan.com/',
        artifact: 'templates/index.liquid',
      });

      // Modify template after receipt was issued
      ledger.recordArtifact('templates/index.liquid', '<main>Storefront v2 modified</main>');

      const res = validator.auditStrictVerification({
        provenanceLedger: ledger,
        surface: 'desktop',
        referenceUrl: 'https://store.haravan.com/',
        revision: 'rev-2026',
        strictVerification: {
          receiptId: receipt.id,
          diffPercentage: 0.8,
        },
      });

      assert.strictEqual(res.passed, false);
      assert.ok(res.reason?.includes('stale') || res.reason?.includes('modified'));
    });
  });
});
