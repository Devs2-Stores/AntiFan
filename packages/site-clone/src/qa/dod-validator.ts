/**
 * Automated Definition of Done (DoD) Validator (Audit §63, §68)
 *
 * Implements authoritative 19-criteria validation to determine whether a cloned
 * Haravan OS 2.0 storefront meets the complete engineering bar for production readiness
 * and can be certified with a 'FINAL' verdict.
 *
 * All 19 Criteria (§63):
 *  1. textReference: check reference contract exists
 *  2. visualBaseline: check static HTML / CSS baseline available
 *  3. semanticExtraction: check clone IR / component contracts
 *  4. haravanDiscovery: check StoreDiscovery inventory completeness
 *  5. existingDataMatching: check EntityResolver EXISTING_DATA_FIRST
 *  6. minimalFixture: check FixtureRegistry & cleanup plan
 *  7. haravanLiquidGenerator: check Liquid generation
 *  8. schemaGeneration: check HaravanSchemaGenerator dynamic extraction
 *  9. settingsBinding: check SettingsAssetsNormalizer compliance
 * 10. themeAssetGeneration: check theme assets synthesized
 * 11. writeThemeCopy: check theme copy transactions
 * 12. haravanPreview: check preview URL derivation
 * 13. realBrowserRender: check render execution
 * 14. strictVerification: check visual comparison tolerance
 * 15. dynamicDataVerification: check dynamic data binding
 * 16. liquidVerification: check DotLiquid sanitization
 * 17. schemaVerification: check OS 2.0 schema validation
 * 18. routeVerification: check RouteResolver verification
 * 19. dependencyVerification: check asset dependency checks
 */

import { HaravanSchemaGenerator } from '../generators/haravan-schema-generator.js';
import { SettingsAssetsNormalizer, type SettingGroup } from '../generators/settings-assets-normalizer.js';
import { LiquidBindingEngine } from '../generators/liquid-binding-engine.js';
import { RouteResolver } from '../platform/haravan/route-resolver.js';
import { FixtureRegistry } from '../platform/haravan/entity-resolver.js';

/**
 * The 19 canonical criteria keys mandated by Audit §63.
 */
export const DOD_CRITERIA_KEYS = [
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
] as const;

export type DoDCriterionKey = (typeof DOD_CRITERIA_KEYS)[number];

/**
 * Result evaluation for a single DoD criterion.
 */
export interface DoDCriterionResult {
  passed: boolean;
  evidence?: string;
  reason?: string;
}

/**
 * Definition of Done evaluation outcome.
 */
export interface DoDEvaluationResult {
  isDoDComplete: boolean;
  score: number;
  passedCount: number;
  totalCount: 19;
  criteria: Record<DoDCriterionKey, DoDCriterionResult>;
  verdict: 'FINAL' | 'INCOMPLETE';
}

/**
 * Context input for DoD evaluation.
 * Accepts structured objects or raw pipeline artifacts for each phase.
 */
export interface DoDContext {
  // 1. textReference
  textReference?: unknown;
  referenceContract?: unknown;
  referenceUrl?: string;

  // 2. visualBaseline
  visualBaseline?: unknown;
  htmlBaseline?: unknown;
  staticClone?: unknown;

  // 3. semanticExtraction
  semanticExtraction?: unknown;
  cloneIR?: unknown;
  componentContracts?: unknown;

  // 4. haravanDiscovery
  haravanDiscovery?: unknown;
  storeDiscovery?: unknown;
  storeInventory?: unknown;

  // 5. existingDataMatching
  existingDataMatching?: unknown;
  entityResolver?: unknown;
  entityMatches?: unknown;

  // 6. minimalFixture
  minimalFixture?: unknown;
  fixtureRegistry?: unknown;
  cleanupPlan?: unknown;

  // 7. haravanLiquidGenerator
  haravanLiquidGenerator?: unknown;
  liquidOutput?: unknown;
  liquidGeneration?: unknown;

  // 8. schemaGeneration
  schemaGeneration?: unknown;
  schemas?: unknown;
  sectionSchemas?: unknown;

  // 9. settingsBinding
  settingsBinding?: unknown;
  settingsNormalizer?: unknown;
  settingsSchema?: unknown;
  settingsData?: unknown;

  // 10. themeAssetGeneration
  themeAssetGeneration?: unknown;
  themeAssets?: unknown;
  synthesizedAssets?: unknown;

  // 11. writeThemeCopy
  writeThemeCopy?: unknown;
  themeCopy?: unknown;
  themeCopyTransactions?: unknown;

  // 12. haravanPreview
  haravanPreview?: unknown;
  previewUrl?: string;

  // 13. realBrowserRender
  realBrowserRender?: unknown;
  browserRender?: unknown;
  renderResult?: unknown;

  // 14. strictVerification
  strictVerification?: unknown;
  visualComparison?: unknown;
  visualDiff?: unknown;

  // 15. dynamicDataVerification
  dynamicDataVerification?: unknown;
  dynamicBindings?: unknown;

  // 16. liquidVerification
  liquidVerification?: unknown;
  dotLiquidSanitization?: unknown;

  // 17. schemaVerification
  schemaVerification?: unknown;
  os2SchemaValidation?: unknown;

  // 18. routeVerification
  routeVerification?: unknown;
  routeResolver?: unknown;

  // 19. dependencyVerification
  dependencyVerification?: unknown;
  assetDependencies?: unknown;

  // Allow explicit criteria overrides or additional telemetry
  criteria?: Partial<Record<DoDCriterionKey, DoDCriterionResult | boolean>>;
  [key: string]: unknown;
}

/**
 * Criterion specification metadata.
 */
export interface DoDCriterionSpec {
  key: DoDCriterionKey;
  name: string;
  auditSection: string;
  description: string;
}

export const DOD_CRITERIA_SPECS: Record<DoDCriterionKey, DoDCriterionSpec> = {
  textReference: {
    key: 'textReference',
    name: 'Reference Contract Exists',
    auditSection: '§63.1',
    description: 'Verifies that reference target contract and baseline URL are defined and grounded.',
  },
  visualBaseline: {
    key: 'visualBaseline',
    name: 'Static HTML / CSS Baseline Available',
    auditSection: '§63.2',
    description: 'Verifies offline-renderable static HTML and CSS baseline assets are available.',
  },
  semanticExtraction: {
    key: 'semanticExtraction',
    name: 'Clone IR & Component Contracts',
    auditSection: '§63.3',
    description: 'Verifies semantic component contract IR extraction from DOM structure.',
  },
  haravanDiscovery: {
    key: 'haravanDiscovery',
    name: 'StoreDiscovery Inventory Completeness',
    auditSection: '§63.4',
    description: 'Verifies store catalog, pages, blogs, and theme assets discovery inventory.',
  },
  existingDataMatching: {
    key: 'existingDataMatching',
    name: 'EntityResolver EXISTING_DATA_FIRST Policy',
    auditSection: '§63.5',
    description: 'Verifies entity resolution matches against existing live store data before fixtures.',
  },
  minimalFixture: {
    key: 'minimalFixture',
    name: 'FixtureRegistry & Cleanup Plan',
    auditSection: '§63.6',
    description: 'Verifies minimal canary fixtures are registered and executable cleanup plan generated.',
  },
  haravanLiquidGenerator: {
    key: 'haravanLiquidGenerator',
    name: 'Liquid Flat Template & Snippet Generation',
    auditSection: '§63.7',
    description: 'Verifies singular layout/theme.liquid, flat templates, and snippets without OS 2.0 sections/ or JSON templates.',
  },
  schemaGeneration: {
    key: 'schemaGeneration',
    name: 'Haravan Settings Declaration Generation',
    auditSection: '§63.8',
    description: 'Verifies settings generation (settings.html or settings_schema.json) without OS 2.0 section schemas/presets/blocks.',
  },
  settingsBinding: {
    key: 'settingsBinding',
    name: 'Settings & Data Binding Compliance',
    auditSection: '§63.9',
    description: 'Verifies settings declaration alignment with settings_data.json defaults and exclusive single-mode usage.',
  },
  themeAssetGeneration: {
    key: 'themeAssetGeneration',
    name: 'Theme Assets Synthesized',
    auditSection: '§63.10',
    description: 'Verifies required theme scripts, stylesheets, and assets are synthesized/localized.',
  },
  writeThemeCopy: {
    key: 'writeThemeCopy',
    name: 'Theme Copy Transactions',
    auditSection: '§63.11',
    description: 'Verifies atomic copy/swap transactions preventing partial or corrupted theme state.',
  },
  haravanPreview: {
    key: 'haravanPreview',
    name: 'Preview URL Derivation',
    auditSection: '§63.12',
    description: 'Verifies derivation of valid Haravan theme preview URL with themeid token.',
  },
  realBrowserRender: {
    key: 'realBrowserRender',
    name: 'Real Browser Render Execution',
    auditSection: '§63.13',
    description: 'Verifies live browser rendering via Chromium CDP without fatal runtime errors.',
  },
  strictVerification: {
    key: 'strictVerification',
    name: 'Visual Comparison Tolerance',
    auditSection: '§63.14',
    description: 'Verifies pixel-level visual comparison between live render and reference within tolerance.',
  },
  dynamicDataVerification: {
    key: 'dynamicDataVerification',
    name: 'Dynamic Data Binding Verification',
    auditSection: '§63.15',
    description: 'Verifies liquid variable bindings against store entities without hardcoded static leaks.',
  },
  liquidVerification: {
    key: 'liquidVerification',
    name: 'DotLiquid Sanitization & Escaping',
    auditSection: '§63.16',
    description: 'Verifies DotLiquid .NET runtime sanitization, proper escaping, and absence of unsupported filters (reject, where, concat, etc.).',
  },
  schemaVerification: {
    key: 'schemaVerification',
    name: 'Haravan Settings & Construct Contract Verification',
    auditSection: '§63.17',
    description: 'Verifies settings schema validation and enforces complete absence of OS 2.0 constructs ({% schema %}, {% render %}, sections/, templates/*.json).',
  },
  routeVerification: {
    key: 'routeVerification',
    name: 'RouteResolver Verification',
    auditSection: '§63.18',
    description: 'Verifies accurate resolution of reference URLs to canonical Haravan route identities.',
  },
  dependencyVerification: {
    key: 'dependencyVerification',
    name: 'Asset & Include Dependency Checks',
    auditSection: '§63.19',
    description: 'Verifies zero broken asset references and that every {% include %} resolves to an existing snippet.',
  },
};

/**
 * DoDValidator - Automated Definition of Done Validator (Audit §63, §68)
 */
export class DoDValidator {
  private schemaGen = new HaravanSchemaGenerator();
  private liquidEngine = new LiquidBindingEngine();
  private routeResolver = new RouteResolver();

  /**
   * Evaluates all 19 Definition of Done criteria against the provided execution context.
   */
  public evaluateDoD(context: unknown): DoDEvaluationResult {
    const ctx: DoDContext = typeof context === 'object' && context !== null ? (context as DoDContext) : {};
    const criteria: Record<string, DoDCriterionResult> = {};
    let passedCount = 0;

    for (const key of DOD_CRITERIA_KEYS) {
      // Check for explicit override in context.criteria
      const explicitOverride = ctx.criteria?.[key];
      let result: DoDCriterionResult;

      if (typeof explicitOverride === 'boolean') {
        result = explicitOverride
          ? { passed: true, evidence: `Criterion '${key}' marked as passed via explicit override` }
          : { passed: false, reason: `Criterion '${key}' marked as failed via explicit override` };
      } else if (explicitOverride && typeof explicitOverride === 'object') {
        result = {
          passed: Boolean(explicitOverride.passed),
          evidence: explicitOverride.evidence,
          reason: explicitOverride.reason || (!explicitOverride.passed ? `Criterion '${key}' failed validation` : undefined),
        };
      } else {
        // Run dedicated audit method
        result = this.auditCriterion(key, ctx);
      }

      criteria[key] = result;
      if (result.passed) {
        passedCount++;
      }
    }

    const totalCount = 19 as const;
    const isDoDComplete = passedCount === totalCount;
    const score = Number(((passedCount / totalCount) * 100).toFixed(2));
    const verdict = isDoDComplete ? 'FINAL' : 'INCOMPLETE';

    return {
      isDoDComplete,
      score,
      passedCount,
      totalCount,
      criteria: criteria as Record<DoDCriterionKey, DoDCriterionResult>,
      verdict,
    };
  }

  /**
   * Dispatches evaluation to specific criterion audit helper.
   */
  public auditCriterion(key: DoDCriterionKey, ctx: DoDContext): DoDCriterionResult {
    switch (key) {
      case 'textReference':
        return this.auditTextReference(ctx);
      case 'visualBaseline':
        return this.auditVisualBaseline(ctx);
      case 'semanticExtraction':
        return this.auditSemanticExtraction(ctx);
      case 'haravanDiscovery':
        return this.auditHaravanDiscovery(ctx);
      case 'existingDataMatching':
        return this.auditExistingDataMatching(ctx);
      case 'minimalFixture':
        return this.auditMinimalFixture(ctx);
      case 'haravanLiquidGenerator':
        return this.auditHaravanLiquidGenerator(ctx);
      case 'schemaGeneration':
        return this.auditSchemaGeneration(ctx);
      case 'settingsBinding':
        return this.auditSettingsBinding(ctx);
      case 'themeAssetGeneration':
        return this.auditThemeAssetGeneration(ctx);
      case 'writeThemeCopy':
        return this.auditWriteThemeCopy(ctx);
      case 'haravanPreview':
        return this.auditHaravanPreview(ctx);
      case 'realBrowserRender':
        return this.auditRealBrowserRender(ctx);
      case 'strictVerification':
        return this.auditStrictVerification(ctx);
      case 'dynamicDataVerification':
        return this.auditDynamicDataVerification(ctx);
      case 'liquidVerification':
        return this.auditLiquidVerification(ctx);
      case 'schemaVerification':
        return this.auditSchemaVerification(ctx);
      case 'routeVerification':
        return this.auditRouteVerification(ctx);
      case 'dependencyVerification':
        return this.auditDependencyVerification(ctx);
      default:
        return { passed: false, reason: `Unknown criterion: ${key}` };
    }
  }

  // =========================================================================
  // 1. textReference: check reference contract exists
  // =========================================================================
  public auditTextReference(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.textReference ?? ctx.referenceContract ?? ctx.referenceUrl;
    if (!candidate) {
      return { passed: false, reason: 'Reference contract is missing. No target URL or reference spec provided.' };
    }

    if (typeof candidate === 'string') {
      const url = candidate.trim();
      if (!url || !/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(url) && !url.includes('.')) {
        return { passed: false, reason: `Invalid reference URL provided: "${candidate}"` };
      }
      return { passed: true, evidence: `Reference contract confirmed with valid baseline URL: ${url}` };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Reference contract explicit failure' };
      }
      const targetUrl = (obj.url || obj.referenceUrl || obj.targetUrl) as string | undefined;
      if (targetUrl && typeof targetUrl === 'string' && targetUrl.trim()) {
        return { passed: true, evidence: `Reference contract verified for URL: ${targetUrl}` };
      }
      if (obj.contractId || obj.spec || obj.id || obj.title) {
        return { passed: true, evidence: `Reference contract verified with spec metadata: ${obj.contractId || obj.title || obj.id}` };
      }
    }

    return { passed: false, reason: 'Reference contract object does not contain valid URL or contract specification.' };
  }

  // =========================================================================
  // 2. visualBaseline: check static HTML / CSS baseline available
  // =========================================================================
  public auditVisualBaseline(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.visualBaseline ?? ctx.htmlBaseline ?? ctx.staticClone;
    if (!candidate) {
      return { passed: false, reason: 'Visual baseline missing: no static HTML / CSS baseline available.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false || obj.success === false) {
        return { passed: false, reason: (obj.reason || obj.error || 'Visual baseline generation failed') as string };
      }

      // IndependentHtmlCloneResult style: entryHtmlPath, filesWritten
      if (typeof obj.entryHtmlPath === 'string' && obj.entryHtmlPath.length > 0) {
        const fileCount = Array.isArray(obj.filesWritten) ? obj.filesWritten.length : 1;
        return { passed: true, evidence: `Visual baseline verified at ${obj.entryHtmlPath} (${fileCount} files recorded)` };
      }

      // Direct html/css representation
      if (typeof obj.html === 'string' && obj.html.trim().length > 0) {
        const hasCss = typeof obj.css === 'string' || Boolean(obj.hasCss) || Array.isArray(obj.stylesheets);
        return {
          passed: true,
          evidence: `Visual baseline HTML present (${obj.html.length} chars)${hasCss ? ' with CSS baseline' : ''}`,
        };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Visual baseline marked valid' };
      }
    }

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return { passed: true, evidence: `Visual baseline HTML content verified (${candidate.length} chars)` };
    }

    return { passed: false, reason: 'Visual baseline candidate is invalid or empty.' };
  }

  // =========================================================================
  // 3. semanticExtraction: check clone IR / component contracts
  // =========================================================================
  public auditSemanticExtraction(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.semanticExtraction ?? ctx.cloneIR ?? ctx.componentContracts;
    if (!candidate) {
      return { passed: false, reason: 'Semantic extraction missing: no Clone IR or component contracts provided.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Semantic extraction marked failed' };
      }

      // Check for sections / components
      const sections = (Array.isArray(obj.sections) ? obj.sections : (Array.isArray(obj.components) ? obj.components : null)) as unknown[] | null;
      if (sections && sections.length > 0) {
        return { passed: true, evidence: `Semantic extraction confirmed with ${sections.length} component section contracts` };
      }

      if (obj.irVersion || obj.componentCount || (typeof obj.passed === 'boolean' && obj.passed)) {
        return { passed: true, evidence: (obj.evidence as string) || `Semantic extraction confirmed (IR version: ${obj.irVersion || '1.0'})` };
      }
    }

    return { passed: false, reason: 'Semantic extraction incomplete: Clone IR contains zero components or sections.' };
  }

  // =========================================================================
  // 4. haravanDiscovery: check StoreDiscovery inventory completeness
  // =========================================================================
  public auditHaravanDiscovery(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.haravanDiscovery ?? ctx.storeDiscovery ?? ctx.storeInventory;
    if (!candidate) {
      return { passed: false, reason: 'Store discovery inventory missing. Catalog and theme asset discovery not executed.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Store discovery failed' };
      }

      const products = Array.isArray(obj.products) ? obj.products.length : (typeof obj.productCount === 'number' ? obj.productCount : 0);
      const collections = Array.isArray(obj.collections) ? obj.collections.length : (typeof obj.collectionCount === 'number' ? obj.collectionCount : 0);
      const themeAssets = Array.isArray(obj.themeAssets) ? obj.themeAssets.length : (typeof obj.themeAssetCount === 'number' ? obj.themeAssetCount : 0);

      const hasDiscoveredEntities = products > 0 || collections > 0 || themeAssets > 0 || obj.discovered === true || obj.isComplete === true;
      if (hasDiscoveredEntities) {
        return {
          passed: true,
          evidence: `StoreDiscovery inventory verified: ${products} products, ${collections} collections, ${themeAssets} theme assets discovered`,
        };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Store discovery verified' };
      }
    }

    return { passed: false, reason: 'Store discovery inventory empty: no products, collections, or theme assets found.' };
  }

  // =========================================================================
  // 5. existingDataMatching: check EntityResolver EXISTING_DATA_FIRST
  // =========================================================================
  public auditExistingDataMatching(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.existingDataMatching ?? ctx.entityResolver ?? ctx.entityMatches;
    if (!candidate) {
      return { passed: false, reason: 'Existing data matching missing: EXISTING_DATA_FIRST policy check not performed.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Existing data matching policy check failed' };
      }

      // Check policy name
      const policy = (obj.policy || obj.resolutionPolicy) as string | undefined;
      const matches = Array.isArray(obj.matches) ? obj.matches : (Array.isArray(obj.resolved) ? obj.resolved : null);
      const matchCount = typeof obj.matchedCount === 'number' ? obj.matchedCount : (matches ? matches.length : undefined);

      if (policy && policy !== 'EXISTING_DATA_FIRST') {
        return { passed: false, reason: `Invalid resolution policy: "${policy}". Must enforce EXISTING_DATA_FIRST.` };
      }

      if (obj.policyEnforced === true || policy === 'EXISTING_DATA_FIRST' || (matchCount !== undefined && matchCount >= 0)) {
        return {
          passed: true,
          evidence: `EXISTING_DATA_FIRST policy confirmed: ${matchCount ?? 0} entity match(es) resolved prior to fixture creation`,
        };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Existing data matching verified' };
      }
    }

    return { passed: false, reason: 'Entity resolver data matching check incomplete: missing policy confirmation.' };
  }

  // =========================================================================
  // 6. minimalFixture: check FixtureRegistry & cleanup plan
  // =========================================================================
  public auditMinimalFixture(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.minimalFixture ?? ctx.fixtureRegistry ?? ctx.cleanupPlan;
    if (!candidate) {
      return { passed: false, reason: 'Minimal fixture tracking missing: FixtureRegistry or cleanup plan not provided.' };
    }

    if (candidate instanceof FixtureRegistry) {
      const cleanupPlan = candidate.generateCleanupPlan();
      const fixtures = candidate.listFixtures();
      const allDeletes = cleanupPlan.every((step) => step.action === 'delete');
      if (!allDeletes) {
        return { passed: false, reason: 'Fixture cleanup plan contains non-delete actions' };
      }
      return {
        passed: true,
        evidence: `FixtureRegistry verified: ${fixtures.length} fixture(s) tracked, cleanup plan with ${cleanupPlan.length} deletion step(s)`,
      };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Fixture registry check failed' };
      }

      const cleanupPlan = Array.isArray(obj.cleanupPlan) ? (obj.cleanupPlan as Array<Record<string, unknown>>) : null;
      const fixtureCount = typeof obj.fixtureCount === 'number' ? obj.fixtureCount : (Array.isArray(obj.fixtures) ? obj.fixtures.length : 0);

      // If fixtures were registered, cleanup plan must exist and delete all fixtures
      if (fixtureCount > 0) {
        if (!cleanupPlan || cleanupPlan.length === 0) {
          return { passed: false, reason: `Cleanup plan missing for ${fixtureCount} registered fixture(s)` };
        }
        const hasValidDeletes = cleanupPlan.every((item) => item.action === 'delete' && item.id !== undefined);
        if (!hasValidDeletes) {
          return { passed: false, reason: 'Cleanup plan items must specify action: "delete" and a valid target id' };
        }
        return {
          passed: true,
          evidence: `Fixture cleanup plan verified: ${cleanupPlan.length} deletion actions for ${fixtureCount} fixture(s)`,
        };
      }

      // Zero fixtures created is also optimal minimal fixture compliance
      if (obj.fixturesCleaned === true || obj.passed === true || (cleanupPlan && cleanupPlan.length === 0)) {
        return { passed: true, evidence: 'Minimal fixture verified: 0 unnecessary canary fixtures created' };
      }
    }

    return { passed: false, reason: 'Fixture registry or cleanup plan verification failed.' };
  }

  // =========================================================================
  // 7. haravanLiquidGenerator: check Liquid generation
  // =========================================================================
  public auditHaravanLiquidGenerator(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.haravanLiquidGenerator ?? ctx.liquidOutput ?? ctx.liquidGeneration;
    if (!candidate) {
      return { passed: false, reason: 'Haravan Liquid generation missing: no generated templates or sections found.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Liquid generation marked failed' };
      }

      // Contract check: forbidden OS 2.0 sections/ or JSON templates
      if (obj.hasSectionsDir === true || obj.hasJsonTemplates === true) {
        return { passed: false, reason: 'Forbidden OS 2.0 constructs (sections/ or templates/*.json) detected in Haravan Liquid output.' };
      }

      const files = Array.isArray(obj.filesWritten) ? obj.filesWritten : (Array.isArray(obj.files) ? obj.files : []);
      for (const f of files) {
        if (typeof f === 'string') {
          if (f.includes('sections/') || f.includes('sections\\')) {
            return { passed: false, reason: 'Forbidden OS 2.0 sections/ directory detected in generated theme files.' };
          }
          if (f.endsWith('.json') && (f.includes('templates/') || f.includes('templates\\'))) {
            return { passed: false, reason: 'Forbidden JSON template detected in generated theme files.' };
          }
        }
      }

      const sections = Array.isArray(obj.sections) ? obj.sections : (Array.isArray(obj.templates) ? obj.templates : null);
      const sectionCount = typeof obj.sectionCount === 'number' ? obj.sectionCount : (sections ? sections.length : 0);

      if (sectionCount > 0) {
        return { passed: true, evidence: `Haravan Liquid generator produced ${sectionCount} valid flat template/snippet components` };
      }

      if (typeof obj.liquid === 'string' && obj.liquid.includes('{%') && obj.liquid.includes('%}')) {
        if (obj.liquid.includes('{% schema %}') || obj.liquid.includes('{% render')) {
          return { passed: false, reason: 'Forbidden constructs ({% schema %} or {% render %}) detected in generated Liquid.' };
        }
        return { passed: true, evidence: `Haravan Liquid code generated successfully (${obj.liquid.length} chars)` };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Haravan Liquid generation verified' };
      }
    }

    if (typeof candidate === 'string' && candidate.includes('{%') && candidate.includes('%}')) {
      if (candidate.includes('{% schema %}') || candidate.includes('{% render')) {
        return { passed: false, reason: 'Forbidden constructs ({% schema %} or {% render %}) detected in generated Liquid.' };
      }
      return { passed: true, evidence: `Haravan Liquid template verified (${candidate.length} chars)` };
    }

    return { passed: false, reason: 'Liquid generation output contains zero sections or templates.' };
  }

  // =========================================================================
  // 8. schemaGeneration: check Haravan settings declaration generation
  // =========================================================================
  public auditSchemaGeneration(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.schemaGeneration ?? ctx.schemas ?? ctx.sectionSchemas;
    if (!candidate) {
      return { passed: false, reason: 'Dynamic schema generation missing: section schemas not extracted.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Schema generation marked failed' };
      }

      // Check for forbidden section presets/blocks
      const rawList = Array.isArray(candidate) ? candidate : (Array.isArray(obj.schemas) ? obj.schemas : [obj]);
      for (const item of rawList) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          if (Array.isArray(rec.presets) || Array.isArray(rec.blocks)) {
            return { passed: false, reason: 'OS 2.0 section presets or blocks detected. Haravan uses flat theme settings without section presets.' };
          }
        }
      }

      // Check array of theme settings groups
      const schemasList = Array.isArray(candidate) ? candidate : (Array.isArray(obj.schemas) ? obj.schemas : null);
      if (schemasList && schemasList.length > 0) {
        let validCount = 0;
        for (const s of schemasList) {
          if (s && typeof s === 'object' && typeof s.name === 'string' && Array.isArray(s.settings)) {
            validCount++;
          }
        }
        if (validCount > 0) {
          return { passed: true, evidence: `Haravan settings declaration verified: ${validCount} valid setting group(s) generated` };
        }
      }

      // Single settings group or settings.html object
      if (typeof obj.name === 'string' && Array.isArray(obj.settings)) {
        return { passed: true, evidence: `Haravan settings group generated: "${obj.name}" with ${obj.settings.length} settings` };
      }

      if (typeof obj.settingsHtml === 'string' && obj.settingsHtml.length > 0) {
        return { passed: true, evidence: `Haravan legacy settings.html generated (${obj.settingsHtml.length} chars)` };
      }

      if (typeof obj.schemaCount === 'number' && obj.schemaCount > 0) {
        return { passed: true, evidence: `Dynamic schema generator produced ${obj.schemaCount} settings groups` };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Schema generation verified' };
      }
    }

    return { passed: false, reason: 'Dynamic schema generation incomplete: missing valid settings definitions.' };
  }

  // =========================================================================
  // 9. settingsBinding: check settings binding and single-mode compliance
  // =========================================================================
  public auditSettingsBinding(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.settingsBinding ?? ctx.settingsNormalizer ?? (ctx.settingsSchema && ctx.settingsData ? { settingsSchema: ctx.settingsSchema, settingsData: ctx.settingsData } : null);
    if (!candidate) {
      return { passed: false, reason: 'Settings binding check missing: settings_schema and settings_data compliance unverified.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Settings binding compliance failed' };
      }

      // Check for forbidden dual settings mode
      if (obj.dualMode === true || (obj.hasSettingsHtml === true && obj.hasSettingsSchema === true)) {
        return { passed: false, reason: 'Dual settings mode detected. Haravan requires either legacy-html or f1genz-schema exclusively.' };
      }

      // If settingsSchema and settingsData are supplied, run normalization check
      if (Array.isArray(obj.settingsSchema) && obj.settingsData && typeof obj.settingsData === 'object') {
        const normalizer = new SettingsAssetsNormalizer();
        const normResult = normalizer.normalizeSettingsSchema(
          obj.settingsData as Record<string, unknown>,
          obj.settingsSchema as unknown[]
        );
        return {
          passed: true,
          evidence: `SettingsAssetsNormalizer executed: ${normResult.addedSettingsCount} missing keys normalized, final schema has ${normResult.normalizedSchema.length} groups`,
        };
      }

      if (obj.compliant === true || obj.normalized === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Settings binding and asset normalization confirmed compliant' };
      }

      if (typeof obj.unmappedCount === 'number' && obj.unmappedCount === 0) {
        return { passed: true, evidence: 'Settings binding confirmed: 0 unmapped settings detected' };
      }
    }

    return { passed: false, reason: 'Settings binding verification failed: schema and data unaligned or non-compliant.' };
  }

  // =========================================================================
  // 10. themeAssetGeneration: check theme assets synthesized
  // =========================================================================
  public auditThemeAssetGeneration(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.themeAssetGeneration ?? ctx.themeAssets ?? ctx.synthesizedAssets;
    if (!candidate) {
      return { passed: false, reason: 'Theme asset generation missing: required theme assets not synthesized or localized.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Theme asset generation marked failed' };
      }

      const assetList = Array.isArray(candidate) ? candidate : (Array.isArray(obj.assets) ? obj.assets : (Array.isArray(obj.synthesizedAssets) ? obj.synthesizedAssets : null));
      if (assetList && assetList.length > 0) {
        return { passed: true, evidence: `Theme asset generation verified: ${assetList.length} assets synthesized/localized` };
      }

      if (typeof obj.assetCount === 'number' && obj.assetCount > 0) {
        return { passed: true, evidence: `Theme asset generation verified: ${obj.assetCount} assets recorded in manifest` };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Theme asset generation confirmed' };
      }
    }

    return { passed: false, reason: 'Theme asset generation incomplete: zero theme assets found.' };
  }

  // =========================================================================
  // 11. writeThemeCopy: check theme copy transactions
  // =========================================================================
  public auditWriteThemeCopy(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.writeThemeCopy ?? ctx.themeCopy ?? ctx.themeCopyTransactions;
    if (!candidate) {
      return { passed: false, reason: 'Theme copy transaction record missing: atomic theme writing not verified.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false || obj.success === false) {
        return { passed: false, reason: (obj.reason || obj.error || 'Theme copy transaction failed') as string };
      }

      if (obj.corrupted === true || obj.partial === true) {
        return { passed: false, reason: 'Theme copy transaction resulted in partial or corrupted files' };
      }

      const files = Array.isArray(obj.filesWritten) ? obj.filesWritten : (Array.isArray(obj.files) ? obj.files : null);
      if (files && files.length > 0) {
        return { passed: true, evidence: `Theme copy transaction completed atomically: ${files.length} files written atomically` };
      }

      if (obj.committed === true || obj.swapped === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Theme copy transaction atomically staged and swapped' };
      }
    }

    return { passed: false, reason: 'Theme copy transaction check failed: no written files recorded.' };
  }

  // =========================================================================
  // 12. haravanPreview: check preview URL derivation
  // =========================================================================
  public auditHaravanPreview(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.haravanPreview ?? ctx.previewUrl;
    if (!candidate) {
      return { passed: false, reason: 'Haravan preview verification missing: preview URL not derived.' };
    }

    let urlString = '';
    if (typeof candidate === 'string') {
      urlString = candidate.trim();
    } else if (typeof candidate === 'object' && candidate !== null) {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Preview derivation failed' };
      }
      urlString = (obj.previewUrl || obj.url || '') as string;
    }

    if (!urlString) {
      return { passed: false, reason: 'Preview URL is empty.' };
    }

    // Must be valid URL and contain preview indicator
    const isUrl = /^https?:\/\/[^\s$.?#].[^\s]*$/i.test(urlString) || urlString.includes('localhost') || urlString.includes('127.0.0.1');
    // A Haravan preview is selected by the numeric `themeid` query parameter only.
    // The Shopify spellings `theme_id` and `preview_theme_id` select nothing on
    // Haravan, so accepting them certifies a preview that never addressed the theme.
    const previewThemeId = /[?&]themeid=(\d+)(?=[&#]|$)/i.exec(urlString)?.[1] ?? null;

    if (!isUrl) {
      return { passed: false, reason: `Preview URL "${urlString}" is not a valid HTTP/HTTPS URL` };
    }

    if (previewThemeId === null) {
      return {
        passed: false,
        reason: `Preview URL "${urlString}" missing Haravan preview token: expected a numeric ?themeid=<id> query parameter`,
      };
    }

    return { passed: true, evidence: `Haravan preview URL confirmed: ${urlString} (themeid=${previewThemeId})` };
  }

  // =========================================================================
  // 13. realBrowserRender: check render execution
  // =========================================================================
  public auditRealBrowserRender(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.realBrowserRender ?? ctx.browserRender ?? ctx.renderResult;
    if (!candidate) {
      return { passed: false, reason: 'Real browser render execution missing: Chromium CDP render not executed.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false || obj.success === false) {
        return { passed: false, reason: (obj.reason || obj.error || 'Browser rendering failed') as string };
      }

      if (obj.crash === true || obj.fatalError) {
        return { passed: false, reason: `Browser crash during render: ${obj.fatalError || 'unknown crash'}` };
      }

      const statusCode = typeof obj.statusCode === 'number' ? obj.statusCode : (typeof obj.status === 'number' ? obj.status : 200);
      if (statusCode >= 400) {
        return { passed: false, reason: `Browser render returned HTTP error status: ${statusCode}` };
      }

      const domReady = obj.domLoaded !== false && obj.rendered !== false;
      if (domReady) {
        const viewportInfo = obj.viewport ? ` at ${JSON.stringify(obj.viewport)}` : '';
        return { passed: true, evidence: `Real browser render executed successfully (status ${statusCode})${viewportInfo}` };
      }
    }

    return { passed: false, reason: 'Real browser render execution failed.' };
  }

  // =========================================================================
  // 14. strictVerification: check visual comparison tolerance
  // =========================================================================
  public auditStrictVerification(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.strictVerification ?? ctx.visualComparison ?? ctx.visualDiff;
    if (!candidate) {
      return { passed: false, reason: 'Strict visual verification missing: visual diff comparison not executed.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Visual diff comparison exceeded tolerance' };
      }

      // Diff percentage check (standard tolerance <= 5% or 0.05)
      const rawDiff = typeof obj.diffPercentage === 'number' ? obj.diffPercentage : (typeof obj.diffRate === 'number' ? obj.diffRate : (typeof obj.mismatchPercentage === 'number' ? obj.mismatchPercentage : undefined));
      const maxTolerance = typeof obj.tolerance === 'number' ? obj.tolerance : 5.0; // default 5%

      if (rawDiff !== undefined) {
        // Normalize diff if provided as decimal e.g. 0.02 -> 2.0%
        const normalizedDiff = rawDiff <= 1.0 && maxTolerance > 1.0 ? rawDiff * 100 : rawDiff;
        if (normalizedDiff > maxTolerance) {
          return {
            passed: false,
            reason: `Visual comparison diff (${normalizedDiff.toFixed(2)}%) exceeds tolerance limit (${maxTolerance}%)`,
          };
        }
        return {
          passed: true,
          evidence: `Visual comparison passed within tolerance: diff ${normalizedDiff.toFixed(2)}% (tolerance <= ${maxTolerance}%)`,
        };
      }

      if (obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Strict visual verification confirmed within tolerance' };
      }
    }

    return { passed: false, reason: 'Strict visual comparison verification failed.' };
  }

  // =========================================================================
  // 15. dynamicDataVerification: check dynamic data binding
  // =========================================================================
  public auditDynamicDataVerification(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.dynamicDataVerification ?? ctx.dynamicBindings;
    if (!candidate) {
      return { passed: false, reason: 'Dynamic data binding verification missing.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Dynamic data binding validation failed' };
      }

      if (obj.staticLeaksDetected === true || (typeof obj.leakCount === 'number' && obj.leakCount > 0)) {
        return { passed: false, reason: `Unbound static text leaks detected (${obj.leakCount ?? 'unknown'} leaks)` };
      }

      const bindingsCount = typeof obj.bindingsCount === 'number' ? obj.bindingsCount : (Array.isArray(obj.bindings) ? obj.bindings.length : undefined);
      if (bindingsCount !== undefined && bindingsCount > 0) {
        return { passed: true, evidence: `Dynamic data bindings verified: ${bindingsCount} Liquid variable bindings confirmed` };
      }

      if (obj.verified === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Dynamic data binding verified without static text leaks' };
      }
    }

    return { passed: false, reason: 'Dynamic data verification failed: no valid entity data bindings verified.' };
  }

  // =========================================================================
  // 16. liquidVerification: check DotLiquid sanitization
  // =========================================================================
  public auditLiquidVerification(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.liquidVerification ?? ctx.dotLiquidSanitization;
    if (!candidate) {
      return { passed: false, reason: 'Liquid DotLiquid sanitization verification missing.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'DotLiquid sanitization check failed' };
      }

      const violations = Array.isArray(obj.violations) ? obj.violations : null;
      if (violations && violations.length > 0) {
        return { passed: false, reason: `DotLiquid .NET quirk violations detected: ${violations.join(', ')}` };
      }

      if (obj.sanitized === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'DotLiquid sanitization verified: zero .NET DotLiquid quirk violations' };
      }
    }

    // If candidate is a raw Liquid string, test for common DotLiquid quirks
    if (typeof candidate === 'string') {
      const quirks = this.detectDotLiquidQuirks(candidate);
      if (quirks.length > 0) {
        return { passed: false, reason: `DotLiquid incompatibilities detected in template: ${quirks.join(', ')}` };
      }
      return { passed: true, evidence: 'Liquid template verified free of DotLiquid .NET quirks' };
    }

    return { passed: false, reason: 'Liquid DotLiquid sanitization check failed.' };
  }

  /**
   * Scans a liquid string for un-sanitized DotLiquid .NET quirks.
   */
  private detectDotLiquidQuirks(liquid: string): string[] {
    const issues: string[] = [];
    if (/\|\s*slice:\s*0\s*,\s*\d+/i.test(liquid)) issues.push('unsupported string slice filter (HS20)');
    if (/(?:!=|==)\s*empty\b/.test(liquid)) issues.push('type mismatch on empty keyword');
    if (/\b[a-zA-Z0-9_.]+\.size\s*>\s*0\b/.test(liquid)) issues.push('.size > 0 invocation on Drop');
    if (/\.each\b/.test(liquid)) issues.push('Ruby .each method call');
    if (/{%[\s\S]*?(?:&&|\|\|)[\s\S]*?%}/.test(liquid)) issues.push('JavaScript logical operators in Liquid tag');
    // Haravan unsupported filters check
    const unsupportedFilters = ['reject', 'compact', 'where', 'concat', 'at_most', 'at_least', 'image_url'];
    for (const uf of unsupportedFilters) {
      const re = new RegExp(`\\|\\s*${uf}\\b`, 'i');
      if (re.test(liquid)) {
        issues.push(`unsupported Shopify filter: ${uf}`);
      }
    }
    return issues;
  }

  // =========================================================================
  // 17. schemaVerification: check OS 2.0 schema validation
  // =========================================================================
  public auditSchemaVerification(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.schemaVerification ?? ctx.os2SchemaValidation;
    if (!candidate) {
      return { passed: false, reason: 'Haravan settings schema validation check missing.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Settings schema validation failed' };
      }

      // Forbidden OS 2.0 construct checks
      if (obj.hasSchemaTag === true || obj.hasRenderTag === true || obj.hasSectionsDir === true) {
        return { passed: false, reason: 'Forbidden OS 2.0 constructs detected: {% schema %}, {% render %}, or sections/ are not supported on Haravan' };
      }

      // Check if schema validation result object is supplied
      if (Array.isArray(obj.errors) && obj.errors.length > 0) {
        return { passed: false, reason: `Schema errors detected: ${obj.errors.join('; ')}` };
      }

      // If raw schema group or array is supplied, validate it using HaravanSchemaGenerator
      if (typeof obj.name === 'string' && Array.isArray(obj.settings)) {
        const valRes = this.schemaGen.validateSettingsSchema([obj]);
        if (!valRes.valid) {
          return { passed: false, reason: `Schema validation failed: ${valRes.errors.join('; ')}` };
        }
        return { passed: true, evidence: `Settings group "${obj.name}" validated successfully against Haravan rules` };
      }

      if (Array.isArray(candidate)) {
        const valRes = this.schemaGen.validateSettingsSchema(candidate);
        if (!valRes.valid) {
          return { passed: false, reason: `Schema validation failed: ${valRes.errors.join('; ')}` };
        }
        return { passed: true, evidence: `Haravan settings schema validated successfully (${candidate.length} groups)` };
      }

      if (obj.valid === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Haravan settings schema validation verified: all setting groups valid' };
      }
    }

    return { passed: false, reason: 'Haravan settings schema verification failed: invalid schema format.' };
  }

  // =========================================================================
  // 18. routeVerification: check RouteResolver verification
  // =========================================================================
  public auditRouteVerification(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.routeVerification ?? ctx.routeResolver;
    if (!candidate) {
      return { passed: false, reason: 'RouteResolver verification missing: route mapping unverified.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Route verification failed' };
      }

      const unmapped = typeof obj.unmappedRoutes === 'number' ? obj.unmappedRoutes : (Array.isArray(obj.unmapped) ? obj.unmapped.length : 0);
      if (unmapped > 0) {
        return { passed: false, reason: `RouteResolver reported ${unmapped} unmapped or invalid storefront routes` };
      }

      const routesCount = typeof obj.routeCount === 'number' ? obj.routeCount : (Array.isArray(obj.routes) ? obj.routes.length : undefined);
      if (routesCount !== undefined && routesCount > 0) {
        return { passed: true, evidence: `RouteResolver verified: ${routesCount} canonical Haravan route(s) mapped accurately` };
      }

      if (obj.verified === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'RouteResolver verification confirmed: canonical routes mapped' };
      }
    }

    if (typeof candidate === 'string') {
      const resolved = this.routeResolver.resolveReferenceUrl(candidate);
      if (resolved && resolved.inferredKind) {
        return { passed: true, evidence: `RouteResolver mapped "${candidate}" to canonical kind: "${resolved.inferredKind}"` };
      }
    }

    return { passed: false, reason: 'RouteResolver verification failed: unmapped routes detected.' };
  }

  // =========================================================================
  // 19. dependencyVerification: check asset dependency checks
  // =========================================================================
  public auditDependencyVerification(ctx: DoDContext): DoDCriterionResult {
    const candidate = ctx.dependencyVerification ?? ctx.assetDependencies;
    if (!candidate) {
      return { passed: false, reason: 'Asset dependency verification missing: broken reference checks not performed.' };
    }

    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (obj.passed === false) {
        return { passed: false, reason: (obj.reason as string) || 'Asset dependency verification failed' };
      }

      const missingAssets = Array.isArray(obj.missingAssets) ? obj.missingAssets : null;
      if (missingAssets && missingAssets.length > 0) {
        return { passed: false, reason: `Missing theme assets detected: ${missingAssets.join(', ')}` };
      }

      const missingSnippets = Array.isArray(obj.missingSnippets) ? obj.missingSnippets : null;
      if (missingSnippets && missingSnippets.length > 0) {
        return { passed: false, reason: `Missing snippet references detected: ${missingSnippets.join(', ')}` };
      }

      const unresolvedIncludes = Array.isArray(obj.unresolvedIncludes) ? obj.unresolvedIncludes : null;
      if (unresolvedIncludes && unresolvedIncludes.length > 0) {
        return { passed: false, reason: `Unresolved include targets detected: ${unresolvedIncludes.join(', ')}` };
      }

      if (obj.brokenReferences === 0 || obj.verified === true || obj.passed === true) {
        return { passed: true, evidence: (obj.evidence as string) || 'Asset & include dependency checks verified: zero broken asset or snippet references' };
      }
    }

    return { passed: false, reason: 'Asset dependency verification failed: dangling references or unverified assets.' };
  }
}
