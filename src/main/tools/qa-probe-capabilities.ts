/**
 * Storefront QA probes exposed as capabilities: `anti.qa.variant_image_probe`,
 * `anti.qa.pdp_contract`, `anti.qa.cart_contract`, `anti.qa.menu_depth`, `anti.qa.page_structure`,
 * `anti.qa.pick_product` and the offline `theme.package_check`.
 *
 * Probe bodies live in `qa/probes/*` and only see the narrow `ProbeDeps`
 * surface; this module owns argument validation, the effect policy and the
 * binding to the live tab.
 */
import * as path from 'node:path';
import { CapabilityError, type BrowserTarget, type CapabilityEffectPolicyInput, type CapabilityRequestContext } from '../../shared/control-plane-contracts';
import type { CapabilityCatalogue } from './capability-catalogue';
import type { BrowserControlPort } from './browser-control-port';
import { resolveCallerWorkspaceRoot } from './file-capabilities';
import { confineWorkspaceRootStrict } from '../qa/diagnostics-filter';
import { assertThemeWorkspaceRoot } from '../qa/workspace-markers';
import { makeProbeDeps, type ProbeDeps } from '../qa/probes/probe-deps';
import { runVariantImageProbe } from '../qa/probes/variant-image-probe';
import { runPdpContract } from '../qa/probes/pdp-contract';
import { runCartContract } from '../qa/probes/cart-contract';
import { runMenuDepth } from '../qa/probes/menu-depth';
import { runPageStructure } from '../qa/probes/page-structure';
import { runPickProduct, type PickProductStrategy } from '../qa/probes/pick-product';
import type { HomeStructureRules } from '../qa/probes/home-structure-rules';
import { runPackageCheck } from '../qa/probes/package-check';
// Circular edge (browser-capabilities registers this module): resolved lazily
// inside the registration body, never at load time.
import * as browserCaps from './browser-capabilities';

const PICK_PRODUCT_STRATEGIES: readonly PickProductStrategy[] = ['max-variants', 'long-title', 'sold-out', 'no-image'];

const MAX_VALUES_LIMIT = 40;
const SAMPLE_LIMIT_MAX = 200;
const MAX_DEPTH_LIMIT = 6;
const MAX_FORBIDDEN_WORDS = 100;
const MAX_FORM_ENTRIES = 200;
const MAX_TEXT_CHARS = 500;

interface ProbeTabParams {
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
}

function invalid(capability: string, message: string): CapabilityError {
  return new CapabilityError('INVALID_ARGUMENT', `${capability}: ${message}`);
}

function optionalInt(capability: string, field: string, value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(capability, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalText(capability: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS) {
    throw invalid(capability, `${field} must be a non-empty string of at most ${MAX_TEXT_CHARS} characters`);
  }
  return value.trim();
}

function stringRecord(capability: string, field: string, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(capability, `${field} must be an object of string values`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FORM_ENTRIES) throw invalid(capability, `${field} holds more than ${MAX_FORM_ENTRIES} entries`);
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') throw invalid(capability, `${field}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

export function registerQaProbeCapabilities(
  catalogue: CapabilityCatalogue,
  browser: BrowserControlPort,
  getWorkspaceRoot?: () => string
): void {
  const tabProps = {
    tabId: { type: 'string' },
    paneId: { type: 'string', enum: ['desktop', 'mobile'] },
  };

  const depsFor = (params: ProbeTabParams, context: CapabilityRequestContext): ProbeDeps => {
    const target = context.browserTarget as BrowserTarget;
    const tabId = params.tabId || target.tabId;
    return makeProbeDeps(browser, target, tabId, params.paneId === 'mobile' ? 'mobile' : 'desktop', context.signal);
  };

  const passivePolicy = (): CapabilityEffectPolicyInput =>
    browserCaps.makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' });
  const interactionPolicy = (risk: 'read' | 'write'): CapabilityEffectPolicyInput =>
    browserCaps.makeBrowserPolicy({ effect: 'interactive-effect', risk, requiresBrowserTarget: true, lane: 'viewport-gate', timeoutMs: 120_000 });

  catalogue.register({
    name: 'anti.qa.variant_image_probe',
    description: 'On a product page click each option value (never add-to-cart or checkout) and compare the gallery image after the click with the variant featured_image from /products/<handle>.js. Findings: swatch-no-image-switch and variant-missing-featured-image (critical), option-values-excess (info). Clicks real controls, so the page state changes.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: interactionPolicy('write'),
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProps,
        maxValues: { type: 'number', description: `Option values to click (default 12, max ${MAX_VALUES_LIMIT})` },
        productHandle: { type: 'string', description: 'Product handle when it cannot be read from the page URL' },
      },
    },
    execute: (params: ProbeTabParams & { maxValues?: number; productHandle?: string }, context) => {
      const name = 'anti.qa.variant_image_probe';
      const maxValues = optionalInt(name, 'maxValues', params.maxValues, 1, MAX_VALUES_LIMIT);
      const productHandle = optionalText(name, 'productHandle', params.productHandle);
      return runVariantImageProbe(depsFor(params, context), {
        ...(maxValues !== undefined ? { maxValues } : {}),
        ...(productHandle ? { productHandle } : {}),
      });
    },
  });

  catalogue.register({
    name: 'anti.qa.pdp_contract',
    description: 'Check that a product page carries its contract elements: size-guide opener (when a size option exists), variant selector, quantity, add-to-cart, buy-now, price, compare-at, SKU, availability, breadcrumb and related products. Reports measured:false on a non-product route.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: passivePolicy(),
    inputSchema: { type: 'object', properties: { ...tabProps } },
    execute: (params: ProbeTabParams, context) => runPdpContract(depsFor(params, context)),
  });

  catalogue.register({
    name: 'anti.qa.cart_contract',
    description: 'Check the cart page: the quantity (+ / − / input), remove and checkout controls exist, and the checkout target is usable (checkout-target-invalid for /[object Object], undefined, empty or #). Passive by default: reads /cart.js and the controls and clicks nothing. exerciseCart:true clicks + then − on the first line, watches for the /cart/change|update request and the quantity change (cart-control-no-request when a click sends nothing) and puts the quantity back; allowRemove:true also clicks the remove control and adds the line back. An empty cart returns measured:false with QA_EMPTY_CART_NOT_EXERCISED: the probe never adds items. Reports measured:false on a non-cart route.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: interactionPolicy('write'),
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProps,
        exerciseCart: { type: 'boolean', description: 'Click + then − on the first cart line and restore the quantity (changes the cart temporarily)' },
        allowRemove: { type: 'boolean', description: 'With exerciseCart: also click the remove control of the first line, then add the line back' },
      },
    },
    execute: (params: ProbeTabParams & { exerciseCart?: unknown; allowRemove?: unknown }, context) => {
      const name = 'anti.qa.cart_contract';
      if (params.exerciseCart !== undefined && typeof params.exerciseCart !== 'boolean') throw invalid(name, 'exerciseCart must be a boolean');
      if (params.allowRemove !== undefined && typeof params.allowRemove !== 'boolean') throw invalid(name, 'allowRemove must be a boolean');
      if (params.allowRemove === true && params.exerciseCart !== true) throw invalid(name, 'allowRemove only applies together with exerciseCart: true');
      return runCartContract(depsFor(params, context), {
        ...(params.exerciseCart === true ? { exerciseCart: true } : {}),
        ...(params.allowRemove === true ? { allowRemove: true } : {}),
      });
    },
  });

  catalogue.register({
    name: 'anti.qa.menu_depth',
    description: 'Hover or click the header menu (desktop) or open the drawer (mobile) and report how many levels render and are visible. expectedMaxDepth (from the admin navigation tree) above the rendered depth raises menu-level-not-rendered. Hovers real controls, so transient page state changes.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: interactionPolicy('read'),
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProps,
        expectedMaxDepth: { type: 'number', description: `Levels the navigation tree defines (1-${MAX_DEPTH_LIMIT})` },
        mobile: { type: 'boolean', description: 'Probe the mobile drawer instead of the desktop menu' },
      },
    },
    execute: (params: ProbeTabParams & { expectedMaxDepth?: number; mobile?: boolean }, context) => {
      const expectedMaxDepth = optionalInt('anti.qa.menu_depth', 'expectedMaxDepth', params.expectedMaxDepth, 1, MAX_DEPTH_LIMIT);
      if (params.mobile !== undefined && typeof params.mobile !== 'boolean') throw invalid('anti.qa.menu_depth', 'mobile must be a boolean');
      return runMenuDepth(depsFor(params, context), {
        ...(expectedMaxDepth !== undefined ? { expectedMaxDepth } : {}),
        ...(params.mobile !== undefined ? { mobile: params.mobile } : {}),
      });
    },
  });

  catalogue.register({
    name: 'anti.qa.page_structure',
    description: 'Classify the page sections (hero, category rail, product rail, banner, USP, testimonial, blog, newsletter, brands, footer) and grade the home structure rules: 6-10 sections, hero first, newsletter/brands after the first product rail, at most two consecutive banners, no repeated role back to back, footer last.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: passivePolicy(),
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProps,
        rules: { type: 'object', description: 'Overrides for the built-in home structure rules (merged over the defaults)' },
        viewportHeight: { type: 'number', description: 'Viewport height in px used for the page-height and first-product-rail rules (default: measured)' },
      },
    },
    execute: (params: ProbeTabParams & { rules?: unknown; viewportHeight?: number }, context) => {
      const name = 'anti.qa.page_structure';
      if (params.rules !== undefined && (!params.rules || typeof params.rules !== 'object' || Array.isArray(params.rules))) {
        throw invalid(name, 'rules must be an object');
      }
      const viewportHeight = optionalInt(name, 'viewportHeight', params.viewportHeight, 200, 3000);
      return runPageStructure(depsFor(params, context), {
        ...(params.rules ? { rules: params.rules as Partial<HomeStructureRules> } : {}),
        ...(viewportHeight !== undefined ? { viewportHeight } : {}),
      });
    },
  });

  catalogue.register({
    name: 'anti.qa.pick_product',
    description: 'Crawl product links from /collections/all and return the handles that best exercise a risky layout: max-variants, long-title, sold-out or no-image. Use the first handle as the product page for the PDP probes.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: passivePolicy(),
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProps,
        strategy: { type: 'string', enum: [...PICK_PRODUCT_STRATEGIES] },
        sampleLimit: { type: 'number', description: `Products to inspect (default 40, max ${SAMPLE_LIMIT_MAX})` },
      },
      required: ['strategy'],
    },
    execute: (params: ProbeTabParams & { strategy?: string; sampleLimit?: number }, context) => {
      const name = 'anti.qa.pick_product';
      if (!PICK_PRODUCT_STRATEGIES.includes(params.strategy as PickProductStrategy)) {
        throw invalid(name, `strategy must be one of ${PICK_PRODUCT_STRATEGIES.join(', ')}`);
      }
      const sampleLimit = optionalInt(name, 'sampleLimit', params.sampleLimit, 1, SAMPLE_LIMIT_MAX);
      return runPickProduct(depsFor(params, context), {
        strategy: params.strategy as PickProductStrategy,
        ...(sampleLimit !== undefined ? { sampleLimit } : {}),
      });
    },
  });

  catalogue.register({
    name: 'theme.package_check',
    description: 'Offline dry run of a theme package before upload: required entries, residue and forbidden brand words, secret patterns, asset reference existence, settings schema shape and, with formBefore/formAfter, a Partners form diff (price changes, Notes without diacritics). Lists a zip without extracting it. Reads only inside the bound workspace.',
    risk: 'read',
    requiresBrowserTarget: false,
    policy: browserCaps.makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded', timeoutMs: 60_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Theme root; must equal or sit inside the bound workspace' },
        zipPath: { type: 'string', description: 'Workspace-relative path of the exported zip to list and scan' },
        expectedBrand: { type: 'string', description: 'Brand name the package must carry' },
        forbiddenWords: { type: 'array', items: { type: 'string' }, description: 'Words (base-theme brand, client names) that must not appear' },
        formBefore: { type: 'object', description: 'Partners form values before the edit (field -> value)' },
        formAfter: { type: 'object', description: 'Partners form values after the edit (field -> value)' },
        allowNonTheme: { type: 'boolean', description: 'Accept a workspace root without theme markers' },
      },
    },
    execute: async (params: { workspaceRoot?: string; zipPath?: string; expectedBrand?: string; forbiddenWords?: string[]; formBefore?: unknown; formAfter?: unknown; allowNonTheme?: boolean }, context?: CapabilityRequestContext) => {
      const name = 'theme.package_check';
      const bound = resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot);
      const strict = confineWorkspaceRootStrict(params.workspaceRoot, bound);
      if (strict.redirected) {
        throw new CapabilityError('WORKSPACE_MISMATCH', `Requested workspaceRoot '${strict.requested}' is outside the bound workspace '${strict.root}'`, { requested: strict.requested, bound: strict.root });
      }
      if (!strict.root.trim()) {
        throw new CapabilityError('WORKSPACE_UNBOUND', `${name} needs a workspace root: none is bound and none was supplied`);
      }
      if (params.allowNonTheme !== true) assertThemeWorkspaceRoot(strict.root, name);
      const zipPath = optionalText(name, 'zipPath', params.zipPath);
      let resolvedZip: string | undefined;
      if (zipPath) {
        resolvedZip = path.isAbsolute(zipPath) ? path.resolve(zipPath) : path.resolve(strict.root, zipPath);
        const rel = path.relative(strict.root, resolvedZip);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw invalid(name, `zipPath '${zipPath}' resolves outside the workspace`);
        }
      }
      if (params.forbiddenWords !== undefined) {
        if (!Array.isArray(params.forbiddenWords) || params.forbiddenWords.length > MAX_FORBIDDEN_WORDS || params.forbiddenWords.some((w) => typeof w !== 'string' || !w.trim() || w.length > MAX_TEXT_CHARS)) {
          throw invalid(name, `forbiddenWords must be an array of at most ${MAX_FORBIDDEN_WORDS} non-empty strings`);
        }
      }
      const expectedBrand = optionalText(name, 'expectedBrand', params.expectedBrand);
      const formBefore = stringRecord(name, 'formBefore', params.formBefore);
      const formAfter = stringRecord(name, 'formAfter', params.formAfter);
      return runPackageCheck({
        workspaceRoot: strict.root,
        ...(resolvedZip ? { zipPath: resolvedZip } : {}),
        ...(expectedBrand ? { expectedBrand } : {}),
        ...(params.forbiddenWords ? { forbiddenWords: params.forbiddenWords.map((w) => w.trim()) } : {}),
        ...(formBefore ? { formBefore } : {}),
        ...(formAfter ? { formAfter } : {}),
      });
    },
  });
}
