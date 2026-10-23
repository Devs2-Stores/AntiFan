import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BrowserTarget, CapabilityRequestContext, AuthenticatedCapabilityContext, CapabilityError, CapabilityEffectPolicyInput, CapabilityRisk, ReceiptBinding, digestText } from '../../shared/control-plane-contracts';
import { BrowserControlPort, BrowserWaitParams, buildRefLookupExpression, ResponsiveBreakpointOption, VISUAL_COMPARE_EXECUTION_BUDGET_MS, VISUAL_COMPARE_CANCELLATION_ACK_MS, FULL_PAGE_CAPTURE_EXECUTION_BUDGET_MS, FULL_PAGE_CAPTURE_CANCELLATION_ACK_MS, VIEWPORT_CAPTURE_EXECUTION_BUDGET_MS, VIEWPORT_CAPTURE_CANCELLATION_ACK_MS, REFERENCE_CAPTURE_EXECUTION_BUDGET_MS, REFERENCE_CAPTURE_CANCELLATION_ACK_MS, BROWSER_WAIT_INVOCATION_BUDGET_MS, BROWSER_EVAL_INVOCATION_BUDGET_MS } from './browser-control-port';
import { CapabilityCatalogue } from './capability-catalogue';
import { resolveCallerWorkspaceRoot } from './file-capabilities';
import { PlatformDetector } from '../qa/scanners/platform-detector';
import { loadOrBootstrapBaseline, evaluateSettingsRatchet, type SettingsFinding } from '../qa/settings-ratchet';
import { LiquidErrorScanner } from '../qa/scanners/liquid-error-scanner';
import { LayoutOverflowEngine } from '../qa/scanners/layout-overflow-engine';
import { HsGateRules, HsEvaluationResult } from '../qa/rules/hs-gate-rules';
import {
  AUTH_ROUTE_RE,
  buildReceiptFindings,
  computeScopedCriticalCount,
  resolveAnnotationTargetSelector,
  type QaReceiptFinding,
  type ThemeQaWorkflow,
  type ThemeQaReport,
  type QaThresholds,
  type QaWaiver,
  type QaSettleOverrides,
  type QaProfile,
} from '../qa/theme-qa-workflow';
import { dispositionFor, isRebindableStale, type RefusalDisposition } from '../qa/qa-state';
import { ThemeQaRepairCoordinator } from '../qa/theme-qa-repair-coordinator';
import type { CockpitPort } from './cockpit-port';
import { registerCockpitCapabilities } from './cockpit-capabilities';
import { confineWorkspaceRoot, confineWorkspaceRootStrict } from '../qa/diagnostics-filter';
import { DEFAULT_QA_PROFILE } from '../qa/qa-thresholds';
import { assertThemeWorkspaceRoot } from '../qa/workspace-markers';
import { registerQaProbeCapabilities } from './qa-probe-capabilities';
import { registerSheetCapabilities } from './sheet-capabilities';
import { recordFallbackTelemetry, FallbackTelemetryPayload } from '../telemetry/fallback-recorder';
import { IssueRegister, VerificationVerdict } from '../session/issue-register';
import { VerificationEvaluator, deriveFailureSignature, resolvePreviousLifecycle } from '../verification/verification-evaluator';
import { VerificationClaim, EvidenceSampleBundle, InteractionBaseline, THEME_METRICS } from '../verification/verification-contract';
import { ProofTemplateRegistry, ClaimCategory } from '../verification/proof-templates';
import { ThemeSourceMapper, isAuthoritativeSourceCandidate } from '../browser/theme-source-mapper';
import { CssCascadeAnalyzer } from '../browser/css-cascade-analyzer';
import { createThemeEvidenceEnvelope } from './theme-evidence-envelope';
import { checkRouteIdentity } from '../verification/visual-capture';
import { ReceiptStore } from '../session/receipt-store';
import { VerificationCircuitBreaker } from '../verification/circuit-breaker';
import { DEADLINES } from '../../shared/deadline-chain';
function resolveRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'lib', 'theme-checks.mjs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isHaravanThemeWorkspace(workspaceRoot: string): boolean {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return false;
  if (fs.existsSync(path.join(workspaceRoot, '.haravan-cli_local.json'))) return true;
  if (fs.existsSync(path.join(workspaceRoot, 'config', 'settings.html'))) return true;
  try {
    const detected = PlatformDetector.detectFromWorkspace(workspaceRoot);
    if (detected.platform === 'haravan') return true;
  } catch {}
  return false;
}

function getThemeHierarchyScript(): string {
  return `(() => {
    const template = document.documentElement?.getAttribute('data-template')
      || document.body?.getAttribute('data-template')
      || document.querySelector('meta[name="template"]')?.getAttribute('content')
      || undefined;
    const selector = [
      'header', 'nav', 'main', 'section', 'article', 'aside', 'footer',
      '[data-section-id]', '[data-section-type]', '[data-component]', '[data-section]',
      'section[id^="shopify-section-"]', 'section[id^="haravan-section-"]'
    ].join(', ');
    const sections = Array.from(document.querySelectorAll(selector))
      .slice(0, 200)
      .map((element) => ({
        id: element.getAttribute('data-section-id') || element.getAttribute('data-component') || element.id || undefined,
        type: element.getAttribute('data-section-type') || element.getAttribute('data-component') || element.tagName.toLowerCase(),
        tag: element.tagName.toLowerCase(),
      }));
    return { template, sections };
  })()`;
}
function getProductResolverScript(handle?: string): string {
  const handleJson = JSON.stringify(handle || '');
  return `(async () => {
    try {
      let targetHandle = ${handleJson};
      if (!targetHandle) {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        const prodIdx = pathSegments.findIndex((seg) => seg === 'products' || seg === 'san-pham' || seg === 'product');
        if (prodIdx !== -1 && pathSegments[prodIdx + 1]) {
          targetHandle = pathSegments[prodIdx + 1].split('?')[0].split('#')[0];
        }
      }
      let productData = null;
      // 1. Structured JSON-LD / schema.org detection (universal)
      const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of ldScripts) {
        if (!s.textContent) continue;
        try {
          const parsed = JSON.parse(s.textContent);
          const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
          const prod = items.find((it) => it && (it['@type'] === 'Product' || it['@type']?.includes?.('Product')));
          if (prod) {
            const priceVal = prod.offers ? (Array.isArray(prod.offers) ? prod.offers[0]?.price : prod.offers.price) : undefined;
            const avail = prod.offers ? (Array.isArray(prod.offers) ? prod.offers[0]?.availability : prod.offers.availability) : undefined;
            productData = {
              handle: targetHandle || prod.sku || (prod.name ? prod.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'product'),
              title: prod.name,
              vendor: typeof prod.brand === 'object' ? prod.brand?.name : (prod.brand || prod.manufacturer),
              price: priceVal ? (typeof priceVal === 'number' ? priceVal : parseFloat(String(priceVal).replace(/[^0-9.]/g, ''))) : undefined,
              compare_at_price: undefined,
              available: avail ? String(avail).includes('InStock') : true,
              variants: [],
              featured_image: Array.isArray(prod.image) ? prod.image[0] : (typeof prod.image === 'object' ? prod.image?.url : prod.image),
            };
            break;
          }
        } catch {}
      }
      // 2. Standard e-commerce DOM JSON script blocks
      if (!productData) {
        const scriptEl = document.querySelector('script[type="application/json"][data-product-json], script[type="application/json"][id*="ProductJson"]');
        if (scriptEl && scriptEl.textContent) {
          try {
            const parsed = JSON.parse(scriptEl.textContent);
            productData = Array.isArray(parsed) ? parsed[0] : parsed;
          } catch {}
        }
      }
      // 3. Storefront runtime window globals
      if (!productData && window.meta && window.meta.product) {
        productData = window.meta.product;
      }
      if (!productData && window.product) {
        productData = window.product;
      }
      // 4. Delegated platform endpoint fallback if handle is detected
      if (!productData && targetHandle) {
        const isShopifyOrHaravan = Boolean(window.Shopify || window.Haravan || window.theme || document.querySelector('link[href*="hstatic.net"], link[href*="cdn.shopify.com"]'));
        if (isShopifyOrHaravan) {
          try {
            const res = await fetch('/products/' + encodeURIComponent(targetHandle) + '.js');
            if (res.ok) {
              productData = await res.json();
            }
          } catch {}
        }
      }
      if (productData) {
        return {
          ok: true,
          handle: targetHandle || productData.handle,
          title: productData.title || productData.name,
          vendor: productData.vendor || productData.brand,
          price: productData.price,
          compare_at_price: productData.compare_at_price,
          available: productData.available,
          variantsCount: Array.isArray(productData.variants) ? productData.variants.length : 1,
          variants: Array.isArray(productData.variants) ? productData.variants.map((v) => ({
            id: v.id,
            title: v.title,
            price: v.price,
            compare_at_price: v.compare_at_price,
            sku: v.sku,
            available: v.available,
            featured_image: v.featured_image ? (typeof v.featured_image === 'string' ? v.featured_image : v.featured_image.src) : undefined,
          })) : [],
          options: productData.options || [],
        };
      }
      return {
        ok: false,
        error: 'No product metadata or structured schema found on current page',
        url: window.location.href,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })()`;
}

/**
 * `browser.screenshot` and `anti.screenshot.viewport` are viewport-only
 * capabilities. `anti.screenshot.full_page` is the single canonical full-page
 * capability; silently capturing viewport pixels for a fullPage request would
 * mislabel evidence, so the request is rejected with a typed error.
 */
export function assertViewportOnlyScreenshot(capability: string, fullPage: unknown): void {
  if (fullPage === true) {
    throw new CapabilityError(
      'INVALID_ARGUMENT',
      `${capability} is viewport-only and rejects fullPage: true; use anti.screenshot.full_page for canonical full-page evidence`
    );
  }
}

export function makeBrowserPolicy(options: {
  effect: CapabilityEffectPolicyInput['effect'];
  risk: CapabilityRisk;
  requiresBrowserTarget?: boolean;
  lane?: CapabilityEffectPolicyInput['schedulerLane'];
  timeoutMs?: number;
  duplicateMode?: CapabilityEffectPolicyInput['duplicateMode'];
  ownerCancellationBehavior?: CapabilityEffectPolicyInput['ownerCancellationBehavior'];
  subscriberDisconnectBehavior?: CapabilityEffectPolicyInput['subscriberDisconnectBehavior'];
  cancellationAckTimeoutMs?: number;
  receiptReadPermission?: CapabilityRisk;
}): CapabilityEffectPolicyInput {
  const reqTarget = Boolean(options.requiresBrowserTarget);
  const defaultLane = reqTarget ? (options.risk === 'read' ? 'short-passive' : 'viewport-gate') : 'unbounded';
  const ownerCancellation = options.ownerCancellationBehavior || (options.effect === 'read' ? 'abort-immediate' : 'drain-and-persist');
  const subscriberDisconnect = options.subscriberDisconnectBehavior || (ownerCancellation === 'abort-immediate' ? 'abort-when-unobserved' : 'detach-and-continue');
  const timeoutMs = options.timeoutMs || 30_000;
  const cancellationAckTimeoutMs = options.cancellationAckTimeoutMs || Math.min(timeoutMs, 5_000);
  return {
    effect: options.effect,
    risk: options.risk,
    requiresBrowserTarget: reqTarget,
    schedulerLane: options.lane || defaultLane,
    duplicateMode: options.duplicateMode || (options.effect === 'destructive-mutation' ? 'reject-concurrent' : 'in-process-join'),
    recordedVisibility: 'tenant-scoped',
    receiptReadPermission: options.receiptReadPermission || options.risk,
    timeoutMs,
    retentionPolicy: 'run-durable',
    ownerCancellationBehavior: ownerCancellation,
    subscriberDisconnectBehavior: subscriberDisconnect,
    cancellationAckTimeoutMs,
    policyVersion: 1,
  };
}

/**
 * Terminal verdict recorded on a workspace QA receipt. `QA_INCONCLUSIVE` is the only
 * honest verdict when the workflow never returned a structured report (any throw),
 * which is what makes the receipt writable on the failure path at all.
 */
export type QaReceiptVerdict = 'QA_PASSED' | 'QA_FAILED' | 'QA_INCONCLUSIVE';

/** Bound on a non-CapabilityError thrown value recorded as `errorCode`. */
const QA_RECEIPT_ERROR_CODE_MAX = 200;
/** Bound on the human-readable message recorded as `errorMessage`. */
const QA_RECEIPT_ERROR_MESSAGE_MAX = 2000;

/** `String(value)` cannot be trusted on a hostile thrown object; it may throw itself. */
export function safeErrorText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'UNKNOWN_ERROR';
  }
}

/**
 * A throw terminates the QA call without a report, so no pass/fail can be claimed.
 * The parameter is accepted (not ignored) so callers can extend the classification
 * per error class without changing the call site.
 */
export function classifyTerminalVerdict(_err: unknown): 'QA_INCONCLUSIVE' {
  return 'QA_INCONCLUSIVE';
}

/** Leading `UPPER_SNAKE:` token of a message, e.g. `CAPTURE_TIMEOUT: Page.captureScreenshot ...`. */
const QA_RECEIPT_LEADING_CODE = /^([A-Z][A-Z0-9_]{2,}):/;

/**
 * Machine-readable code for the receipt, so a consumer gate can branch on the failure
 * class instead of parsing prose. Ordered by reliability:
 *   1. `CapabilityError.code` — the control-plane's own taxonomy.
 *   2. Any other typed error carrying a non-empty string `code` — the production
 *      `CAPTURE_TIMEOUT` evidence is thrown as a `CaptureError` (`visual-capture.ts`),
 *      not a `CapabilityError`, and duck-typing is what keeps `errorCode:
 *      "CAPTURE_TIMEOUT"` true on the real path.
 *   3. A leading `UPPER_SNAKE:` token of the message (`CAPTURE_TIMEOUT: ...`).
 *   4. `String(err)`, truncated so one hostile thrown value cannot bloat the receipt.
 */
export function extractErrorCode(err: unknown): string {
  if (err instanceof CapabilityError) return err.code;
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code.slice(0, QA_RECEIPT_ERROR_CODE_MAX);
  }
  const message = err instanceof Error ? err.message : safeErrorText(err);
  const leading = QA_RECEIPT_LEADING_CODE.exec(message.trim());
  if (leading?.[1]) return leading[1];
  return safeErrorText(err).slice(0, QA_RECEIPT_ERROR_CODE_MAX);
}

/** Human-readable detail for the receipt; `null` when the thrown value carries none. */
export function extractErrorMessage(err: unknown): string | null {
  if (err instanceof Error) return err.message.slice(0, QA_RECEIPT_ERROR_MESSAGE_MAX);
  const text = safeErrorText(err);
  return text ? text.slice(0, QA_RECEIPT_ERROR_MESSAGE_MAX) : null;
}

/** Profile `theme.qa_validate` grades under when the caller names none. */
export const DEFAULT_QA_VALIDATE_PROFILE: QaProfile = DEFAULT_QA_PROFILE;
const QA_SETTLE_TIMEOUT_KEYS = ['networkTimeoutMs', 'fontsTimeoutMs', 'imagesTimeoutMs', 'domTimeoutMs', 'totalTimeoutMs'] as const;
const QA_SETTLE_TIMEOUT_MAX_MS = 120_000;
const QA_MAX_LISTED_ITEMS = 50;
const QA_MAX_SELECTOR_CHARS = 200;
const QA_THRESHOLD_KEYS = ['minTextPx', 'minTapHitPx'] as const;

export interface QaValidateOptions {
  thresholds?: QaThresholds;
  waivers: QaWaiver[];
  settle?: QaSettleOverrides;
  coverageFloor?: number;
  profile?: QaProfile;
  expectedStatus?: number;
  /** Declared greenfield run: the caller states why no visual baseline exists. */
  greenfield?: { reason: string };
}

function invalidQaArgument(message: string): CapabilityError {
  return new CapabilityError('INVALID_ARGUMENT', `theme.qa_validate: ${message}`);
}

const TITLE_LEVELS = ['h1', 'h2', 'h3', 'h4'] as const;

function parseTitleScale(value: unknown): Record<'h1' | 'h2' | 'h3' | 'h4', [number, number]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidQaArgument('thresholds.titleScale must be an object with h1, h2, h3 and h4');
  const raw = value as Record<string, unknown>;
  const out = {} as Record<'h1' | 'h2' | 'h3' | 'h4', [number, number]>;
  for (const level of TITLE_LEVELS) {
    const range = raw[level];
    if (!Array.isArray(range) || range.length !== 2 || range.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || (range[0] as number) > (range[1] as number)) {
      throw invalidQaArgument(`thresholds.titleScale.${level} must be [min, max] positive numbers with min <= max`);
    }
    out[level] = [range[0] as number, range[1] as number];
  }
  return out;
}

const VIEWPORT_MIN_PX = 200;
const VIEWPORT_MAX_PX = 3000;
const VIEWPORTS_MAX_ENTRIES = 5;

/** Schema fragment for the optional extra sweep sizes of the responsive and batch matrix tools. */
const VIEWPORTS_SCHEMA = {
  type: 'array',
  maxItems: VIEWPORTS_MAX_ENTRIES,
  description: `Extra viewport sizes appended to the standard widths, e.g. landscape phone {w:667,h:375}, laptop {w:1366,h:600}, short phone {w:375,h:350}. At most ${VIEWPORTS_MAX_ENTRIES} entries, w and h ${VIEWPORT_MIN_PX}-${VIEWPORT_MAX_PX} CSS px`,
  items: {
    type: 'object',
    properties: { w: { type: 'number' }, h: { type: 'number' } },
    required: ['w', 'h'],
  },
};

/** Validates the `viewports: [{w,h}]` array; absent means "standard sizes only". */
export function parseViewportsParam(value: unknown, capability: string): Array<{ w: number; h: number }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > VIEWPORTS_MAX_ENTRIES) {
    throw new CapabilityError('INVALID_ARGUMENT', `${capability}: viewports must be an array of 1-${VIEWPORTS_MAX_ENTRIES} {w,h} entries`);
  }
  return value.map((entry, index) => {
    const item = entry as { w?: unknown; h?: unknown } | null;
    const w = item?.w;
    const h = item?.h;
    const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= VIEWPORT_MIN_PX && n <= VIEWPORT_MAX_PX;
    if (!item || typeof item !== 'object' || !inRange(w) || !inRange(h)) {
      throw new CapabilityError('INVALID_ARGUMENT', `${capability}: viewports[${index}] needs integer w and h between ${VIEWPORT_MIN_PX} and ${VIEWPORT_MAX_PX}`);
    }
    return { w, h };
  });
}

function readSelectorList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > QA_MAX_LISTED_ITEMS) throw invalidQaArgument(`${field} must be an array of at most ${QA_MAX_LISTED_ITEMS} selectors`);
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > QA_MAX_SELECTOR_CHARS) throw invalidQaArgument(`${field} entries must be non-empty strings of at most ${QA_MAX_SELECTOR_CHARS} characters`);
    return item.trim();
  });
}

/** Validates and normalizes the caller-tunable qa_validate inputs; any malformed value is refused, never defaulted. */
export function parseQaValidateOptions(params: Record<string, unknown>): QaValidateOptions {
  const out: QaValidateOptions = { waivers: [] };

  if (params.profile !== undefined) {
    if (params.profile !== 'audit' && params.profile !== 'build-strict') throw invalidQaArgument("profile must be 'audit' or 'build-strict'");
    out.profile = params.profile;
  }

  if (params.thresholds !== undefined) {
    const raw = params.thresholds as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidQaArgument('thresholds must be an object');
    const thresholds = {} as Record<string, number>;
    for (const key of QA_THRESHOLD_KEYS) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw invalidQaArgument(`thresholds.${key} must be a positive number`);
      thresholds[key] = value;
    }
    const extras: { titleScale?: Record<'h1' | 'h2' | 'h3' | 'h4', [number, number]>; inputHeightBandPx?: number } = {};
    if (raw.titleScale !== undefined) extras.titleScale = parseTitleScale(raw.titleScale);
    if (raw.inputHeightBandPx !== undefined) {
      const band = raw.inputHeightBandPx;
      if (typeof band !== 'number' || !Number.isFinite(band) || band <= 0 || band > 64) throw invalidQaArgument('thresholds.inputHeightBandPx must be a number between 0 and 64');
      extras.inputHeightBandPx = band;
    }
    out.thresholds = { ...thresholds, ...extras } as unknown as QaThresholds;
  }

  if (params.coverageFloor !== undefined) {
    const floor = params.coverageFloor;
    if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) throw invalidQaArgument('coverageFloor must be a number between 0 and 1');
    out.coverageFloor = floor;
  }

  if (params.waivers !== undefined) {
    if (!Array.isArray(params.waivers) || params.waivers.length > QA_MAX_LISTED_ITEMS) throw invalidQaArgument(`waivers must be an array of at most ${QA_MAX_LISTED_ITEMS} {rule, reason} entries`);
    out.waivers = params.waivers.map((entry) => {
      const item = entry as { rule?: unknown; reason?: unknown } | null;
      if (!item || typeof item !== 'object' || typeof item.rule !== 'string' || !item.rule.trim() || typeof item.reason !== 'string' || !item.reason.trim()) {
        throw invalidQaArgument('each waiver needs a non-empty rule and a non-empty reason');
      }
      return { rule: item.rule.trim().slice(0, 80), reason: item.reason.trim().slice(0, 500) };
    });
  }

  if (params.expectedStatus !== undefined) {
    const status = params.expectedStatus;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) throw invalidQaArgument('expectedStatus must be an HTTP status code between 100 and 599');
    out.expectedStatus = status;
  }

  const settle: QaSettleOverrides = {};
  if (params.settle !== undefined) {
    const raw = params.settle as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidQaArgument('settle must be an object');
    if (raw.scopeSelector !== undefined) {
      if (typeof raw.scopeSelector !== 'string' || !raw.scopeSelector.trim() || raw.scopeSelector.length > QA_MAX_SELECTOR_CHARS) throw invalidQaArgument('settle.scopeSelector must be a non-empty selector string');
      settle.scopeSelector = raw.scopeSelector.trim();
    }
    if (raw.ignoreSelectors !== undefined) settle.ignoreSelectors = readSelectorList(raw.ignoreSelectors, 'settle.ignoreSelectors');
    for (const key of QA_SETTLE_TIMEOUT_KEYS) {
      const value = raw[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > QA_SETTLE_TIMEOUT_MAX_MS) throw invalidQaArgument(`settle.${key} must be a number between 1 and ${QA_SETTLE_TIMEOUT_MAX_MS}`);
      settle[key] = value;
    }
  }
  if (params.ignoreSelectors !== undefined) {
    const top = readSelectorList(params.ignoreSelectors, 'ignoreSelectors');
    settle.ignoreSelectors = [...(settle.ignoreSelectors ?? []), ...top.filter((s) => !(settle.ignoreSelectors ?? []).includes(s))];
  }
  if (Object.keys(settle).length > 0) out.settle = settle;

  if (params.greenfield !== undefined) {
    const raw = params.greenfield as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidQaArgument('greenfield must be an object {reason}');
    if (typeof raw.reason !== 'string' || !raw.reason.trim()) throw invalidQaArgument('greenfield.reason must be a non-empty string naming why no visual baseline exists');
    out.greenfield = { reason: raw.reason.trim().slice(0, 500) };
  }
  return out;
}

/**
 * Ids of the promoted visual baselines on record for the caller's workspace. A greenfield run is only
 * legitimate when this list is empty, so a store that cannot be read refuses the run instead of
 * reading as "no baselines".
 */
export function listPromotedBaselineIds(
  browser: BrowserControlPort,
  context: { workspaceId?: string; projectId?: string }
): string[] {
  const authority = browser.baselineAuthority;
  if (!authority || typeof authority.getBaselineDir !== 'function') {
    throw new CapabilityError('EXECUTION_ERROR', 'The promoted baseline store is not available, so a greenfield run cannot prove that no baseline exists', {
      recovery: 'run theme.qa_validate without greenfield and supply viewports from an anti.visual.compare against a promoted baseline',
    });
  }
  if (!context.workspaceId) {
    throw new CapabilityError('WORKSPACE_UNBOUND', 'A greenfield run needs the bound workspace to look up its promoted baselines');
  }
  const dir = authority.getBaselineDir(context.workspaceId);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /^vbase_[a-zA-Z0-9_-]+\.json$/.test(name));
  } catch (err) {
    throw new CapabilityError('EXECUTION_ERROR', `The promoted baseline directory could not be read: ${(err as Error).message}`, {
      recovery: 'repair the baseline store, or run theme.qa_validate without greenfield',
    });
  }
  const found: string[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { workspaceId?: unknown; projectId?: unknown };
      const sameWorkspace = manifest.workspaceId === undefined || manifest.workspaceId === context.workspaceId;
      const sameProject = typeof manifest.projectId !== 'string' || !context.projectId || manifest.projectId === context.projectId;
      if (sameWorkspace && sameProject) found.push(id);
    } catch {
      // An unreadable manifest still names a baseline that was promoted here: never read it as absence.
      found.push(id);
    }
  }
  return found.sort();
}

const SEQUENCE_ACTION_TYPES = ['navigate', 'click', 'type', 'scroll', 'hover', 'pressKey', 'wait', 'screenshot', 'snapshot'];

/** One sequence step; shared by the `actions` argument and its `steps` alias. */
function sequenceStepsSchema(description?: string): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: SEQUENCE_ACTION_TYPES },
        url: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
        deltaY: { type: 'number' },
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' } },
        waitMs: { type: 'number', description: 'Pause length for wait steps (1-10000 ms, default 100)' },
        timeoutMs: { type: 'number', description: 'Navigation budget for navigate steps in milliseconds (1000-60000, default 10000)' },
        settleMs: { type: 'number' },
        format: { type: 'string', enum: ['jpeg', 'png'] },
        quality: { type: 'number' },
      },
      required: ['type'],
    },
    ...(description ? { description } : {}),
  };
}

/** Input schema of every sequence registration: the steps arrive as `actions` or as its alias `steps`, never both. */
function sequenceInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      actions: sequenceStepsSchema('Ordered array of action steps to execute sequentially'),
      steps: sequenceStepsSchema('Alias of actions; mutually exclusive with it'),
      tabId: { type: 'string' },
      paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      stopOnError: { type: 'boolean' },
    },
    oneOf: [{ required: ['actions'] }, { required: ['steps'] }],
  };
}

type SequenceParams = {
  actions?: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
  stopOnError?: boolean;
};

/** Folds the `steps` alias into `actions`; supplying both forms is ambiguous and refused. */
function normalizeSequenceParams(capability: string, params: SequenceParams): {
  actions: Array<Record<string, unknown>>;
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
  stopOnError?: boolean;
} {
  if (params.actions !== undefined && params.steps !== undefined) {
    throw new CapabilityError('INVALID_ARGUMENT', `${capability}: pass the steps as 'actions' or as its alias 'steps', not both`);
  }
  const { steps, actions, ...rest } = params;
  return { ...rest, actions: (actions ?? steps) as Array<Record<string, unknown>> };
}

/** Input schema of every navigate registration. */
function navigateInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL, or about:blank to reset the tab to an empty document; every other about: page, file:, data: and javascript: is refused' },
      tabId: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Navigation budget in milliseconds (default 20000, capped at 60000)' },
    },
    required: ['url'],
  };
}

/** Description suffix shared by every tab-close registration. */
const CLOSE_TAB_DESCRIPTION = 'Close a Chromium browser tab by ID. A tab that is already gone is not an error: the result is {closed:false, alreadyGone:true}';

/** The settle gate that held a degraded or refused run, read from the report or the thrown refusal. */
function settleFailureOf(report: ThemeQaReport | undefined, err: unknown): { code: 'SETTLE_INCOMPLETE'; reason: string } | null {
  if (err instanceof CapabilityError && err.code === 'SETTLE_INCOMPLETE') {
    const predicate = err.details && typeof err.details.failingPredicate === 'string' ? err.details.failingPredicate : null;
    return { code: 'SETTLE_INCOMPLETE', reason: predicate ?? 'settle' };
  }
  const settle = report?.settleReceipt;
  if (settle && (settle.settleComplete === false || settle.domUnstable === true || typeof settle.failingPredicate === 'string')) {
    return { code: 'SETTLE_INCOMPLETE', reason: settle.failingPredicate ?? (settle.domUnstable ? 'dom' : 'settle') };
  }
  return null;
}

export function registerBrowserCapabilities(catalogue: CapabilityCatalogue, browser: BrowserControlPort, themeQaWorkflow?: ThemeQaWorkflow, getWorkspaceRoot?: () => string, receipts?: ReceiptStore, getStylesheetUrlMap?: () => Record<string, string>, cockpit?: CockpitPort): void {
  const coordinator = themeQaWorkflow ? new ThemeQaRepairCoordinator(themeQaWorkflow) : undefined;
  /**
   * `expression` and `expressionFile` are mutually exclusive forms of the same
   * argument: the file form exists because a workspace-relative path survives
   * transports that mangle a large escaped expression. The file is read through
   * the same workspace-boundary confinement `browser.dump_dom` uses, so a path
   * outside the root is refused rather than read.
   */
  const resolveExpressionInput = (
    capabilityName: string,
    params: { expression?: string; expressionFile?: string },
    context: CapabilityRequestContext
  ): string => {
    const hasExpression = params.expression !== undefined && params.expression !== null && !(typeof params.expression === 'string' && params.expression.trim().length === 0);
    const hasExpressionFile = params.expressionFile !== undefined && params.expressionFile !== null && !(typeof params.expressionFile === 'string' && params.expressionFile.trim().length === 0);
    if (hasExpression && hasExpressionFile) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        `${capabilityName} accepts exactly one of 'expression' or 'expressionFile'; this call supplied both`
      );
    }
    if (!hasExpression && !hasExpressionFile) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        `${capabilityName} requires 'expression' or 'expressionFile'; this call supplied neither`
      );
    }
    if (!hasExpressionFile) return params.expression as string;
    if (typeof params.expressionFile !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', `${capabilityName} expressionFile must be a workspace-relative path string`);
    }
    let rootPath = process.cwd();
    if (context?.projectId && context?.workspaceId) {
      try {
        const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
        if (ws?.rootPath) rootPath = ws.rootPath;
      } catch {}
    }
    const resolvedTarget = path.isAbsolute(params.expressionFile)
      ? params.expressionFile
      : path.resolve(rootPath, params.expressionFile);
    const safePath = confineWorkspaceRoot(resolvedTarget, rootPath);
    // `confineWorkspaceRoot` falls back to the root itself when the candidate
    // escapes it, and a directory is not an expression source either way.
    if (path.resolve(safePath) === path.resolve(rootPath)) {
      const reason = path.resolve(resolvedTarget) === path.resolve(rootPath)
        ? `expressionFile '${params.expressionFile}' resolves to the workspace root directory '${rootPath}'; pass a file path inside the root`
        : `expressionFile '${params.expressionFile}' resolves outside workspace root '${rootPath}'; pass a path inside the root`;
      throw new CapabilityError('INVALID_ARGUMENT', reason);
    }
    try {
      return fs.readFileSync(safePath, 'utf8');
    } catch (err) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        `${capabilityName} could not read expressionFile '${params.expressionFile}' at '${safePath}': ${extractErrorMessage(err) || 'unreadable'}`
      );
    }
  };


  // 1. Standard canonical capabilities
  catalogue.register({
    name: 'browser.list-tabs',
    description: 'List Chromium tabs in this session\'s project scope (each row carries affiliated). Pass all: true for global GUI discovery of the whole window strip, affiliatedOnly: true to keep only in-scope rows. The tab bound to this session is marked with isBoundTab: true.',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', default: false, description: 'Pass true for global GUI discovery: every tab in the window is listed and each row carries affiliated (true when the tab measures into this session\'s project/workspace). Default lists only this session\'s project scope.' },
        affiliatedOnly: { type: 'boolean', default: false, description: 'Restrict the returned rows to tabs measuring into this session\'s project/workspace.' },
        projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused; it can never widen authority.' },
      },
    },
    execute: (params: { all?: boolean; affiliatedOnly?: boolean; projectId?: string }, context) => browser.listTabs({
      target: context.browserTarget,
      scope: params?.all === true ? 'global' : 'project',
      affiliatedOnly: params?.affiliatedOnly === true,
      projectId: typeof params?.projectId === 'string' ? params.projectId : undefined,
      // The caller's authenticated scope travels on the dispatch context, never
      // inside the browser target — a bindingless or stale target keeps it.
      authenticatedProjectId: context.projectId,
      authenticatedWorkspaceId: context.workspaceId,
    }),
  });

  catalogue.register({
    name: 'browser.open-tab',
    description: 'Open a Chromium browser tab without changing the visible tab by default',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        activate: { type: 'boolean' },
        anchorTabId: { type: 'string', description: 'Live same-project tab selecting the window for creation' },
        ephemeral: { type: 'boolean' },
        userFacing: { type: 'boolean', description: 'Open tab directly on the visible user plane (non-ephemeral) for interactive inspection/debugging' },
        devicePresetId: { type: 'string', description: 'Device preset ID (e.g. iphone-15, xiaomi-14)' },
        mobile: { type: 'boolean', description: 'Open directly in mobile mode with mobile User-Agent and viewport' },
        projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused before allocation; it never widens authority.' },
      },
    },
    execute: (params: { url?: string; activate?: boolean; anchorTabId?: string; ephemeral?: boolean; userFacing?: boolean; devicePresetId?: string; mobile?: boolean; projectId?: string }, context) => browser.openTab(params, { target: context?.browserTarget, authenticatedProjectId: context?.projectId }),
  });
  catalogue.register({
    name: 'browser.close-tab',
    description: CLOSE_TAB_DESCRIPTION,
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.closeTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'browser.switch-tab',
    description: 'Switch to a Chromium browser tab by ID',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => {
      const authCtx = context as Partial<AuthenticatedCapabilityContext>;
      return browser.switchTab(params.tabId, {
        target: context.browserTarget as BrowserTarget,
        attachmentId: authCtx.attachmentId,
        runId: authCtx.runId,
        attemptId: authCtx.attemptId,
        isAgent: Boolean(authCtx.attachmentId),
      });
    },
  });

  catalogue.register({
    name: 'browser.navigate',
    description: 'Navigate the explicitly bound Chromium tab (or specified tabId)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: navigateInputSchema(),
    execute: (params: { url: string; tabId?: string; timeoutMs?: number }, context) =>
      browser.navigate(context.browserTarget as BrowserTarget, params.url, params.tabId, params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined),
  });

  catalogue.register({
    name: 'browser.reload',
    description: 'Reload the explicitly bound Chromium tab (or specified tabId)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reload(context.browserTarget as BrowserTarget, params.tabId),
  });
  catalogue.register({
    name: 'browser.reload_zero_network',
    description: 'Reload an isolated offline or cloned tab under strict zero-external-network denial gate (CDP Fetch interceptor)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reloadZeroNetwork(context.browserTarget as BrowserTarget, params.tabId),
  });


  catalogue.register({
    name: 'browser.dom',
    description: 'Capture bounded DOM evidence for the explicitly bound tab (or specified tabId/paneId)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dom(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.selector, params.tabId, params.paneId),
  });
  catalogue.register({
    name: 'browser.dump_dom',
    description: 'Stream clean or raw page DOM directly to a workspace file with zero MCP transport truncation and Windows-safe atomic writes',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'Destination file path relative to workspace root' },
        selector: { type: 'string', description: 'Optional CSS selector to isolate subtrees' },
        tabId: { type: 'string', description: 'Optional target tabId' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        clean: { type: 'boolean', description: 'Automatically sanitize Livewire/SSR metadata blobs', default: true },
        materialize: { type: 'boolean', description: 'Automatically walk and materialize full-page lazy/SSR content before dumping', default: true },
        materializeDataSrc: { type: 'boolean', description: 'Also swap lazy data-src/data-srcset into live sources during the walk, for loaders that only swap on user interaction (default false: such images refuse the export as unmaterialized)' },
      },
      required: ['outputPath'],
    },
    execute: async (params: { outputPath: string; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; clean?: boolean; materialize?: boolean; materializeDataSrc?: boolean }, context) => {
      let rootPath = process.cwd();
      if (context?.projectId && context?.workspaceId) {
        try {
          const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
          if (ws?.rootPath) rootPath = ws.rootPath;
        } catch {}
      }
      const resolvedTarget = path.isAbsolute(params.outputPath)
        ? params.outputPath
        : path.resolve(rootPath, params.outputPath);
      const safePath = confineWorkspaceRoot(resolvedTarget, rootPath);
      // `confineWorkspaceRoot` falls back to the root itself when the candidate
      // escapes it. Writing there is never the caller's intent and a directory
      // target fails later as a bare EISDIR rename, so refuse with the reason.
      // An explicit `outputPath: '.'` lands on the same directory, so it is
      // refused by the same check rather than surfacing as EISDIR downstream.
      if (path.resolve(safePath) === path.resolve(rootPath)) {
        const reason = path.resolve(resolvedTarget) === path.resolve(rootPath)
          ? `outputPath '${params.outputPath}' resolves to the workspace root directory '${rootPath}'; pass a file path inside the root`
          : `outputPath '${params.outputPath}' resolves outside workspace root '${rootPath}'; pass a path inside the root`;
        throw new CapabilityError('INVALID_ARGUMENT', reason);
      }
      return browser.dumpDom(context.browserTarget as BrowserTarget, safePath, params);
    },
  });


  catalogue.register({
    name: 'browser.screenshot',
    description: 'Capture bounded screenshot evidence for the explicitly bound tab (or specified tabId/paneId)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' }, fullPage: { type: 'boolean', description: 'Rejected: browser.screenshot is viewport-only; use anti.screenshot.full_page' } } },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }, context) => {
      assertViewportOnlyScreenshot('browser.screenshot', params.fullPage);
      return browser.screenshot(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.tabId, params.paneId, { format: params.format, quality: params.quality, fullPage: false });
    },
  });
  catalogue.register({
    name: 'browser.observe',
    description: 'Truthful identity-coherent multi-modal observation capturing bounded DOM, screenshot, snapshot, and diagnostics with drift metadata',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        components: {
          type: 'array',
          items: { type: 'string', enum: ['dom', 'screenshot', 'snapshot', 'diagnostics'] },
          description: 'List of up to 4 components to observe',
        },
        selector: { type: 'string', description: 'Optional CSS selector root' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: async (params: { components?: Array<'dom' | 'screenshot' | 'snapshot' | 'diagnostics'>; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.observe(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'browser.wait',
    description: 'Deterministic wait for selector, url, navigation, dom-stable, network, actionability, generation, or legacy condition states',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'event-wait', timeoutMs: BROWSER_WAIT_INVOCATION_BUDGET_MS }),
    inputSchema: {
      type: 'object',
      properties: {
        condition: {
          type: 'string',
          enum: [
            'selector',
            'url',
            'navigation',
            'dom-stable',
            'network',
            'actionability',
            'generation',
            'ref',
            'document_loaded',
            'url_match',
            'network_idle',
            'dom_stable',
            'images-settled',
            'timeout',
          ],
          description: 'Wait condition to evaluate: selector | url | navigation | dom-stable | network | actionability | generation | images-settled | timeout (or legacy aliases)',
        },
        type: {
          type: 'string',
          enum: [
            'selector',
            'url',
            'navigation',
            'dom-stable',
            'network',
            'actionability',
            'generation',
            'ref',
            'document_loaded',
            'url_match',
            'network_idle',
            'dom_stable',
            'images-settled',
            'timeout',
          ],
          description: 'Alias for condition',
        },
        selector: { type: 'string', description: 'CSS selector to wait for' },
        ref: { type: 'string', description: 'Semantic reference token (@e1) to wait for' },
        urlPattern: { type: 'string', description: 'URL pattern or substring to match' },
        url: { type: 'string', description: 'Alias for urlPattern' },
        minGeneration: { type: 'number', description: 'Minimum document generation to wait for (generation or navigation condition)' },
        state: { type: 'string', enum: ['attached', 'visible', 'actionable', 'detached', 'hidden'] },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (5000 default, 30000 max)' },
        idleWindowMs: { type: 'number', description: 'Debounce idle window in milliseconds (500 default)' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      // `type` is an alias of `condition`: either or both may be sent.
      anyOf: [{ required: ['condition'] }, { required: ['type'] }],
    },
    execute: (params: BrowserWaitParams, context) =>
      browser.wait(context.browserTarget as BrowserTarget, params, params.tabId, params.paneId, context.signal),
  });

  catalogue.register({
    name: 'browser.eval',
    description: 'Evaluate JavaScript only with an explicit eval grant',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate', timeoutMs: BROWSER_EVAL_INVOCATION_BUDGET_MS }),
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, timeoutMs: { type: 'number', description: 'In-page execution budget in milliseconds (default 15000, capped by the capability invocation budget)' } }, required: ['expression'] },
    execute: (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile'; timeoutMs?: number }, context) => browser.eval(context.browserTarget as BrowserTarget, params.expression, params.tabId, params.paneId, { timeoutMs: params.timeoutMs }),
  });

  catalogue.register({
    name: 'browser.diagnostics',
    description: 'Get tab console logs and network failures',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, level: { type: 'number' } } },
    execute: (params: { tabId?: string; level?: number | string }) => browser.diagnostics(params.tabId, params.level),
  });

  catalogue.register({
    name: 'browser.responsive-check',
    description: 'Run responsive layout verification on a tab',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.responsiveCheck(params.tabId),
  });

  catalogue.register({
    name: 'browser.agent-move',
    description: 'Move agent virtual cursor to an element, ref (@e1), or coordinate',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentMove(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-click',
    description: 'Click an element or coordinate using agent cursor (supports @ref or CSS selector)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, trusted: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClick(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-drag',
    description: 'Drag an element or coordinate to another with a bounded interpolated pointer gesture (price sliders, range handles, drag-to-reorder)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        fromRef: { type: 'string', description: 'Origin semantic ref (@e1) from a snapshot' },
        fromSelector: { type: 'string', description: 'Origin CSS selector (unused when fromRef or fromX/fromY is given)' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toRef: { type: 'string', description: 'Destination semantic ref (@e1)' },
        toSelector: { type: 'string', description: 'Destination CSS selector' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        steps: { type: 'number', description: 'Interpolated pointer-move steps, clamped to 4..20 (default 10)' },
        force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered target' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: {
      fromRef?: string;
      fromSelector?: string;
      fromX?: number;
      fromY?: number;
      toRef?: string;
      toSelector?: string;
      toX?: number;
      toY?: number;
      steps?: number;
      force?: boolean;
      tabId?: string;
      paneId?: 'desktop' | 'mobile';
    }, context) => browser.agentDrag(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.drag',
    description: 'Alias for browser.agent-drag',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        fromRef: { type: 'string' },
        fromSelector: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toRef: { type: 'string' },
        toSelector: { type: 'string' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        steps: { type: 'number' },
        force: { type: 'boolean' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: {
      fromRef?: string;
      fromSelector?: string;
      fromX?: number;
      fromY?: number;
      toRef?: string;
      toSelector?: string;
      toX?: number;
      toY?: number;
      steps?: number;
      force?: boolean;
      tabId?: string;
      paneId?: 'desktop' | 'mobile';
    }, context) => browser.agentDrag(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-type',
    description: 'Type text into an input element using agent cursor (supports @ref or CSS selector)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, trusted: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['text'] },
    execute: (params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentType(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.keyboard-press',
    description: 'Send native key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Ctrl+A) to the active tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, required: ['key'] },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-scroll',
    description: 'Scroll page or element using agent cursor (supports @ref or CSS selector)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentScroll(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-hover',
    description: 'Hover an element, ref (@e1), or coordinate using agent cursor. Returns executionTier and verified hoverActive.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-highlight',
    description: 'Highlight an element or ref on page',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, color: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; label?: string; color?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHighlight(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.agent-clear',
    description: 'Clear all agent visual cursor overlays',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClear(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.agent-snapshot',
    description: 'Capture agent visual snapshot tree (supports selector and viewportOnly filtering)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; viewportOnly?: boolean }, context) => browser.agentSnapshot(params, context.browserTarget),
  });
  catalogue.register({
    name: 'browser.find',
    description: 'Search accessibility snapshot descriptors for text or regex pattern and return matching @eN element references with metadata',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text to search for in page snapshot' },
        regex: { type: 'string', description: 'Regular expression to search for in page snapshot' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-review pane' },
        maxMatches: { type: 'number', description: 'Maximum number of matches to return' },
      },
    },
    execute: (params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });


  catalogue.register({
    name: 'browser.agent-trajectory',
    description: 'Execute a continuous multi-step Bézier mouse trajectory and action sequence',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object' } }, speed: { type: 'string', enum: ['fast', 'natural', 'slow'] }, smoothScroll: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['steps'] },
    execute: (params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentTrajectory(params, context.browserTarget, context.signal),
  });
  catalogue.register({
    name: 'browser.agent-sequence',
    description: 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: sequenceInputSchema(),
    execute: (params: SequenceParams, context) =>
      browser.sequence(normalizeSequenceParams('browser.agent-sequence', params), context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.upload-file',
    description: 'Upload local files into a file input element in active tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        refOrSelector: { type: 'string', description: 'CSS selector or @ref of target file input' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Array of local file paths' },
        workspaceRoot: { type: 'string', description: 'Explicit workspace root directory validated against authorized project roots' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['refOrSelector', 'filePaths'],
    },
    execute: (params: { refOrSelector: string; filePaths: string[]; workspaceRoot?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => {
      let wsRoot = params.workspaceRoot;
      if (!wsRoot && context?.projectId && context?.workspaceId) {
        try {
          const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
          if (ws?.rootPath) wsRoot = ws.rootPath;
        } catch {}
      }
      return browser.uploadFileInput({ ...params, workspaceRoot: wsRoot }, context.browserTarget, context.signal);
    },
  });

  catalogue.register({
    name: 'browser.drop-files',
    description: 'Dispatch native drag and drop file transfer onto a target drop zone element in active tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        refOrSelector: { type: 'string', description: 'CSS selector or @ref of target drop zone' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Array of local file paths' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['refOrSelector', 'filePaths'],
    },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.dropFiles(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.inspect.snapshot',
    description: 'Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references (supports selector and viewportOnly filtering)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; viewportOnly?: boolean }, context) => browser.agentSnapshot(params, context.browserTarget),
  });
  catalogue.register({
    name: 'anti.inspect.find',
    description: 'Alias for browser.find',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text to search for' },
        regex: { type: 'string', description: 'Regular expression to search for' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        maxMatches: { type: 'number' },
      },
    },
    execute: (params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });
  catalogue.register({
    name: 'anti.inspect.observe',
    description: 'Alias for browser.observe',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        components: {
          type: 'array',
          items: { type: 'string', enum: ['dom', 'screenshot', 'snapshot', 'diagnostics'] },
          description: 'List of up to 4 components to observe',
        },
        selector: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: async (params: { components?: Array<'dom' | 'screenshot' | 'snapshot' | 'diagnostics'>; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.observe(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.browser.wait',
    description: 'Alias for browser.wait',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'event-wait', timeoutMs: BROWSER_WAIT_INVOCATION_BUDGET_MS }),
    inputSchema: {
      type: 'object',
      properties: {
        condition: {
          type: 'string',
          enum: [
            'selector',
            'url',
            'navigation',
            'dom-stable',
            'network',
            'actionability',
            'generation',
            'ref',
            'document_loaded',
            'url_match',
            'network_idle',
            'dom_stable',
            'images-settled',
            'timeout',
          ],
        },
        type: {
          type: 'string',
          enum: [
            'selector',
            'url',
            'navigation',
            'dom-stable',
            'network',
            'actionability',
            'generation',
            'ref',
            'document_loaded',
            'url_match',
            'network_idle',
            'dom_stable',
            'images-settled',
            'timeout',
          ],
        },
        selector: { type: 'string' },
        ref: { type: 'string' },
        urlPattern: { type: 'string' },
        url: { type: 'string' },
        minGeneration: { type: 'number' },
        state: { type: 'string', enum: ['attached', 'visible', 'actionable', 'detached', 'hidden'] },
        timeoutMs: { type: 'number' },
        idleWindowMs: { type: 'number' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      // `type` is an alias of `condition`: either or both may be sent.
      anyOf: [{ required: ['condition'] }, { required: ['type'] }],
    },
    execute: (params: BrowserWaitParams, context) =>
      browser.wait(context.browserTarget as BrowserTarget, params, params.tabId, params.paneId, context.signal),
  });


  catalogue.register({
    name: 'anti.browser.evaluate',
    description: 'Execute JavaScript expression in page context (refuses a tab with no laid-out surface unless allowDegradedSurface is set)',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate', timeoutMs: BROWSER_EVAL_INVOCATION_BUDGET_MS }),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate; mutually exclusive with expressionFile' },
        expressionFile: { type: 'string', description: 'Workspace-relative path to a file containing the JavaScript expression; mutually exclusive with expression' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch)' },
        timeoutMs: { type: 'number', description: 'In-page execution budget in milliseconds (default 15000; capped by the capability invocation budget, so the in-page guard — not the platform deadline — produces the timeout answer)' },
      },
      oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }],
    },
    execute: (params: { expression?: string; expressionFile?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; allowDegradedSurface?: boolean; timeoutMs?: number }, context) =>
      browser.eval(context.browserTarget as BrowserTarget, resolveExpressionInput('anti.browser.evaluate', params, context), params.tabId, params.paneId, {
        requireRenderSurface: true,
        allowDegradedSurface: params.allowDegradedSurface === true,
        timeoutMs: params.timeoutMs,
      }),
  });

  catalogue.register({
    name: 'anti.browser.evaluate_frame',
    description: 'Execute JavaScript inside a child frame (cross-origin iframe) selected by frameUrl substring',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate; mutually exclusive with expressionFile' },
        expressionFile: { type: 'string', description: 'Workspace-relative path to a file containing the JavaScript expression; mutually exclusive with expression' },
        frameUrl: { type: 'string', description: 'Substring of the child frame URL to target (e.g. "web.haravan.app")' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['frameUrl'],
      oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }],
    },
    execute: (params: { expression?: string; expressionFile?: string; frameUrl: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.evalInFrame(context.browserTarget as BrowserTarget, resolveExpressionInput('anti.browser.evaluate_frame', params, context), params.frameUrl, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.eval',
    description: 'Alias for anti.browser.evaluate',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate; mutually exclusive with expressionFile' },
        expressionFile: { type: 'string', description: 'Workspace-relative path to a file containing the JavaScript expression; mutually exclusive with expression' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        requireRenderSurface: { type: 'boolean', description: 'Refuse a tab that reports no laid-out surface (0x0 CSS px) instead of evaluating against an unrendered page' },
        allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch)' },
        timeoutMs: { type: 'number', description: 'In-page execution budget in milliseconds (default 15000; capped by the capability invocation budget)' },
      },
      oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }],
    },
    execute: (
      params: { expression?: string; expressionFile?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; requireRenderSurface?: boolean; allowDegradedSurface?: boolean; timeoutMs?: number },
      context
    ) =>
      browser.eval(context.browserTarget as BrowserTarget, resolveExpressionInput('anti.inspect.eval', params, context), params.tabId, params.paneId, {
        requireRenderSurface: params.requireRenderSurface === true,
        allowDegradedSurface: params.allowDegradedSurface === true,
        timeoutMs: params.timeoutMs,
      }),
  });

  catalogue.register({
    name: 'anti.agent.file_upload',
    description: 'Upload local files into a file input element',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, workspaceRoot: { type: 'string', description: 'Explicit workspace root directory validated against authorized project roots' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; workspaceRoot?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => {
      let wsRoot = params.workspaceRoot;
      if (!wsRoot && context?.projectId && context?.workspaceId) {
        try {
          const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
          if (ws?.rootPath) wsRoot = ws.rootPath;
        } catch {}
      }
      return browser.uploadFileInput({ ...params, workspaceRoot: wsRoot }, context.browserTarget, context.signal);
    },
  });

  catalogue.register({
    name: 'anti.agent.drop',
    description: 'Dispatch native drag and drop file transfer onto a target drop zone',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dropFiles(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_upload_file',
    description: 'Alias for browser.upload-file',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, workspaceRoot: { type: 'string', description: 'Explicit workspace root directory validated against authorized project roots' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; workspaceRoot?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => {
      let wsRoot = params.workspaceRoot;
      if (!wsRoot && context?.projectId && context?.workspaceId) {
        try {
          const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
          if (ws?.rootPath) wsRoot = ws.rootPath;
        } catch {}
      }
      return browser.uploadFileInput({ ...params, workspaceRoot: wsRoot }, context.browserTarget, context.signal);
    },
  });

  catalogue.register({
    name: 'antifan_drop_files',
    description: 'Alias for browser.drop-files',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['refOrSelector', 'filePaths'] },
    execute: (params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dropFiles(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.telemetry.record_fallback',
    description: 'Record sanitized structured fallback telemetry when falling back to Playwright',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        targetUrl: { type: 'string' },
        primaryTool: { type: 'string' },
        errorCode: { type: 'string' },
        errorMessage: { type: 'string' },
        fallbackTool: { type: 'string' },
        fallbackResult: { type: 'string', enum: ['SUCCESS', 'FAILED', 'SKIPPED'] },
        durationMs: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['primaryTool', 'fallbackTool', 'fallbackResult'],
    },
    execute: async (params: FallbackTelemetryPayload, context) => {
      // Telemetry never fails the call: an unresolvable tenant root records without one.
      let root: string | undefined;
      try { root = resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot) || undefined; } catch { root = undefined; }
      return recordFallbackTelemetry(params, root);
    },
  });
  catalogue.register({
    name: 'browser.set-viewport',
    description: 'Set browser responsive viewport dimensions (width, height, mobile emulation, DPR)',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Pin the page zoom factor (0.25-5.0). Defaults to 1.0 so a persisted preview zoom cannot silently scale the captured raster' }, tabId: { type: 'string' }, reload: { type: 'boolean', description: 'Whether to reload the tab after changing viewport to ensure clean responsive hydration' } }, required: ['width', 'height'] },
    execute: (params: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; zoomFactor?: number; tabId?: string; reload?: boolean }, context) => browser.setViewport(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.browser.set_viewport',
    description: 'Set browser responsive viewport dimensions (width, height, mobile emulation, DPR) and verify the tab measured them before reporting success',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Pin the page zoom factor (0.25-5.0). Defaults to 1.0 so a persisted preview zoom cannot silently scale the captured raster' }, tabId: { type: 'string' }, reload: { type: 'boolean', description: 'Whether to reload the tab after changing viewport to ensure clean responsive hydration' } }, required: ['width', 'height'] },
    execute: (params: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; zoomFactor?: number; tabId?: string; reload?: boolean }, context) => browser.setViewport(params, context.browserTarget),
  });
  catalogue.register({
    name: 'browser.get-viewport',
    description: 'Get browser viewport dimensions, DPR, device preset, and layout surface state without applying overrides',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string', description: 'Optional tab ID to inspect (defaults to active tab)' } } },
    execute: (params: { tabId?: string }, context) => browser.getViewport(params, context.browserTarget),
  });

  catalogue.register({
    name: 'anti.browser.get_viewport',
    description: 'Get browser viewport dimensions, DPR, device preset, and layout surface state without applying overrides',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string', description: 'Optional tab ID to inspect (defaults to active tab)' } } },
    execute: (params: { tabId?: string }, context) => browser.getViewport(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.set-device-preset',
    description: 'Emulate a real device preset (iPhone, iPad, Galaxy, Pixel, MacBook, 4K, Desktop) on a tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { presetId: { type: 'string' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, required: ['presetId'] },
    execute: (params: { presetId: string; tabId?: string; reload?: boolean }, context) => browser.setDevicePreset(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.list-device-presets',
    description: 'List all available responsive device presets with their resolutions and categories',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: () => browser.listDevicePresets(),
  });

  catalogue.register({
    name: 'browser.set-zoom',
    description: 'Set zoom factor for a Chromium tab (0.25 to 5.0)',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Zoom factor between 0.25 and 5.0' }, tabId: { type: 'string' } }, required: ['zoomFactor'] },
    execute: (params: { zoomFactor: number; tabId?: string }, context) => browser.setZoom(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.toggle-inspect',
    description: 'Toggle native element inspection overlay',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: () => browser.toggleInspect(),
  });

  catalogue.register({
    name: 'browser.split-review',
    description: 'Toggle or explicitly set Split Review dual-pane mode on the active or specified tab (desktop + mobile)',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Explicitly enable (true) or disable (false) split review. Omit to toggle.' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
      },
    },
    execute: (params: { enabled?: boolean; tabId?: string }, context) =>
      browser.toggleSplitReview(params, context.browserTarget),
  });
  catalogue.register({
    name: 'antifan_toggle_split_review',
    description: 'Alias for browser.split-review',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Explicitly enable (true) or disable (false) split review. Omit to toggle.' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
      },
    },
    execute: (params: { enabled?: boolean; tabId?: string }, context) =>
      browser.toggleSplitReview(params, context.browserTarget),
  });

  catalogue.register({
    name: 'browser.set-automation-target',
    description: 'Explicitly set the automation target tab for AI actions',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'management', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.setAutomationTarget(params.tabId),
  });

  catalogue.register({
    name: 'browser.rebind-target',
    description: 'Resynchronize and rebind the browser target to the live document generation after navigation or DOM mutation',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'management', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.rebindTarget(params, context.browserTarget),
  });

  // 2. Compatibility aliases for MCP & Bridge protocols
  catalogue.register({
    name: 'antifan_list_tabs',
    description: 'List Chromium tabs in this session\'s project scope (each row carries affiliated). Pass all: true for global GUI discovery of the whole window strip, affiliatedOnly: true to keep only in-scope rows. The tab bound to this session is marked with isBoundTab: true.',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', default: false, description: 'Pass true for global GUI discovery: every tab in the window is listed and each row carries affiliated (true when the tab measures into this session\'s project/workspace). Default lists only this session\'s project scope.' },
        affiliatedOnly: { type: 'boolean', default: false, description: 'Restrict the returned rows to tabs measuring into this session\'s project/workspace.' },
        projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused; it can never widen authority.' },
      },
    },
    execute: (params: { all?: boolean; affiliatedOnly?: boolean; projectId?: string }, context) => browser.listTabs({
      target: context.browserTarget,
      scope: params?.all === true ? 'global' : 'project',
      affiliatedOnly: params?.affiliatedOnly === true,
      projectId: typeof params?.projectId === 'string' ? params.projectId : undefined,
      authenticatedProjectId: context.projectId,
      authenticatedWorkspaceId: context.workspaceId,
    }),
  });

  catalogue.register({
    name: 'antifan_open_tab',
    description: 'Alias for browser.open-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, activate: { type: 'boolean' }, anchorTabId: { type: 'string', description: 'Live same-project tab selecting the window for creation' }, ephemeral: { type: 'boolean' }, userFacing: { type: 'boolean', description: 'Open tab directly on the visible user plane (non-ephemeral) for interactive inspection/debugging' }, projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused before allocation; it never widens authority.' } } },
    execute: (params: { url?: string; activate?: boolean; anchorTabId?: string; ephemeral?: boolean; userFacing?: boolean; projectId?: string }, context) => browser.openTab(params, { target: context?.browserTarget, authenticatedProjectId: context?.projectId }),
  });

  catalogue.register({
    name: 'antifan_close_tab',
    description: CLOSE_TAB_DESCRIPTION,
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.closeTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'antifan_switch_tab',
    description: 'Alias for browser.switch-tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => {
      const authCtx = context as Partial<AuthenticatedCapabilityContext>;
      return browser.switchTab(params.tabId, {
        target: context.browserTarget as BrowserTarget,
        attachmentId: authCtx.attachmentId,
        runId: authCtx.runId,
        attemptId: authCtx.attemptId,
        isAgent: Boolean(authCtx.attachmentId),
      });
    },
  });

  catalogue.register({
    name: 'antifan_navigate',
    description: 'Alias for browser.navigate',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: navigateInputSchema(),
    execute: (params: { url: string; tabId?: string; timeoutMs?: number }, context) =>
      browser.navigate(context.browserTarget as BrowserTarget, params.url, params.tabId, params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined),
  });

  catalogue.register({
    name: 'antifan_reload',
    description: 'Alias for browser.reload',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reload(context.browserTarget as BrowserTarget, params.tabId),
  });

  catalogue.register({
    name: 'antifan_get_dom',
    description: 'Alias for browser.dom',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dom(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.selector, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'antifan_screenshot',
    description: 'Alias for browser.screenshot',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' }, fullPage: { type: 'boolean', description: 'Rejected: antifan_screenshot is viewport-only; use anti.screenshot.full_page' } } },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }, context) => {
      assertViewportOnlyScreenshot('antifan_screenshot', params.fullPage);
      return browser.screenshot(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.tabId, params.paneId, { format: params.format, quality: params.quality, fullPage: false });
    },
  });

  catalogue.register({
    name: 'antifan_toggle_inspect',
    description: 'Alias for browser.toggle-inspect',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: () => browser.toggleInspect(),
  });

  catalogue.register({
    name: 'antifan_agent_snapshot',
    description: 'Alias for browser.agent-snapshot',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentSnapshot(params, context.browserTarget),
  });
  catalogue.register({
    name: 'antifan_find',
    description: 'Alias for browser.find',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        regex: { type: 'string' },
        pattern: { type: 'string' },
        query: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        maxMatches: { type: 'number' },
      },
    },
    execute: (params: { text?: string; regex?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; maxMatches?: number }, context) =>
      browser.agentFind(params, context.browserTarget),
  });


  catalogue.register({
    name: 'antifan_eval_js',
    description: 'Alias for browser.eval',
    risk: 'eval',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'eval', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['expression'] },
    execute: (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.eval(context.browserTarget as BrowserTarget, params.expression, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'antifan_agent_click',
    description: 'Alias for browser.agent-click',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, trusted: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClick(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_agent_type',
    description: 'Alias for browser.agent-type',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, trusted: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['text'] },
    execute: (params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentType(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_keyboard_press',
    description: 'Alias for browser.keyboard-press',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, required: ['key'] },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget, context.signal),
  });
  catalogue.register({
    name: 'antifan_agent_sequence',
    description: 'Alias for browser.agent-sequence',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: sequenceInputSchema(),
    execute: (params: SequenceParams, context) =>
      browser.sequence(normalizeSequenceParams('antifan_agent_sequence', params), context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'browser.send-keyboard-press',
    description: 'Alias for browser.keyboard-press',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' } }, required: ['key'] },
    execute: (params: { key: string; modifiers?: string[]; tabId?: string }, context) => browser.keyboardPress(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_agent_scroll',
    description: 'Alias for browser.agent-scroll',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentScroll(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_agent_hover',
    description: 'Alias for browser.agent-hover: returns executionTier and verified hoverActive',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_agent_highlight',
    description: 'Alias for browser.agent-highlight',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, color: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; label?: string; color?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHighlight(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_agent_clear',
    description: 'Alias for browser.agent-clear',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClear(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_agent_trajectory',
    description: 'Alias for browser.agent-trajectory',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object' } }, speed: { type: 'string', enum: ['fast', 'natural', 'slow'] }, smoothScroll: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['steps'] },
    execute: (params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentTrajectory(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'antifan_console_messages',
    description: 'Alias for browser.diagnostics',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, level: { type: 'number' } } },
    execute: (params: { tabId?: string; level?: number | string }) => browser.diagnostics(params.tabId, params.level),
  });

  catalogue.register({
    name: 'anti.inspect.console',
    description: 'Alias for browser.diagnostics: returns tab console messages and failed requests',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, level: { type: 'number' } } },
    execute: (params: { tabId?: string; level?: number | string }) => browser.diagnostics(params.tabId, params.level),
  });

  catalogue.register({
    name: 'antifan_network_failures',
    description: 'Alias for browser.diagnostics',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }) => browser.diagnostics(params.tabId),
  });

  catalogue.register({
    name: 'antifan_responsive_check',
    description: 'Alias for browser.responsive-check',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.responsiveCheck(params.tabId),
  });

  catalogue.register({
    name: 'antifan_set_viewport',
    description: 'Alias for browser.set-viewport',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Pin the page zoom factor (0.25-5.0). Defaults to 1.0' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, required: ['width', 'height'] },
    execute: (params: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; zoomFactor?: number; tabId?: string; reload?: boolean }, context) => browser.setViewport(params, context.browserTarget),
  });
  catalogue.register({
    name: 'antifan_get_viewport',
    description: 'Alias for browser.get-viewport',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.getViewport(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_set_device_preset',
    description: 'Alias for browser.set-device-preset',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { presetId: { type: 'string' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, required: ['presetId'] },
    execute: (params: { presetId: string; tabId?: string; reload?: boolean }, context) => browser.setDevicePreset(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_list_device_presets',
    description: 'Alias for browser.list-device-presets',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: () => browser.listDevicePresets(),
  });

  catalogue.register({
    name: 'antifan_set_zoom',
    description: 'Alias for browser.set-zoom',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Zoom factor between 0.25 and 5.0' }, tabId: { type: 'string' } }, required: ['zoomFactor'] },
    execute: (params: { zoomFactor: number; tabId?: string }, context) => browser.setZoom(params, context.browserTarget),
  });

  catalogue.register({
    name: 'antifan_set_automation_target',
    description: 'Alias for browser.set-automation-target',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'management', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }) => browser.setAutomationTarget(params.tabId),
  });

  catalogue.register({
    name: 'antifan_rebind_target',
    description: 'Alias for browser.rebind-target',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'management', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.rebindTarget(params, context.browserTarget),
  });

  catalogue.register({
    name: 'theme.qa_validate',
    description: 'Execute the authoritative Theme QA workflow for the bound storefront tab and workspace',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: DEADLINES.toolPolicyMs }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        workspaceRoot: { type: 'string', description: 'Workspace root path. Must equal or sit inside the bound workspace; an outside root is refused with WORKSPACE_MISMATCH and no receipt is written. Confines the QA receipt directory (.antifan/qa-receipts/) and matches the QA Binding workspaceRoot emitted in the annotation markdown' },
        annotationId: { type: 'string', description: 'Annotation ID this QA run verifies (from the annotation markdown). Recorded on the workspace receipt so consuming-runtime gates can match evidence to the task' },
        expectedUrl: { type: 'string', description: 'Expected route URL of the bound tab (annotation Page URL). Fail-closed: mismatch throws the route-gate code (URL_HOST_MISMATCH/URL_THEME_MISMATCH/URL_PATH_MISMATCH) instead of silently QA-ing the wrong page or theme' },
        multiBreakpoint: { type: 'boolean', description: 'Enable multi-breakpoint responsive testing (320, 375, 768, 1024, 1440). Defaults to true inside workflow; pass false to opt out.' },
        profile: { type: 'string', enum: ['audit', 'build-strict'], description: 'build-strict (default) fails on contrast below WCAG AA, sub-24px tap targets, invisible click blockers, floating widgets over controls and the contract-threshold registry rules, and treats unmeasured scans as evidence gaps; audit reports visual-quality findings without affecting the verdict' },
        thresholds: { type: 'object', description: 'Contract thresholds the registry rules grade against (kit registry/thresholds.json shape). Optional: when omitted the workspace contract typeScale, else the built-in defaults (12/24) apply automatically and the receipt records thresholdsSource', properties: { minTextPx: { type: 'number' }, minTapHitPx: { type: 'number' }, titleScale: { type: 'object', description: 'Allowed [min,max] px per heading level at <=768px', properties: { h1: { type: 'array', items: { type: 'number' } }, h2: { type: 'array', items: { type: 'number' } }, h3: { type: 'array', items: { type: 'number' } }, h4: { type: 'array', items: { type: 'number' } } } }, inputHeightBandPx: { type: 'number', description: 'Maximum height spread between inputs of one form (default 4)' } } },
        coverageFloor: { type: 'number', description: 'Minimum measured/expected scan-family share (0..1). Below it a green run is QA_INCONCLUSIVE. Defaults to 1 under build-strict, 0 under audit' },
        waivers: { type: 'array', description: 'Accepted visual-quality rule exceptions; each needs a rule id and a reason and is echoed on the report and receipt', items: { type: 'object', properties: { rule: { type: 'string' }, reason: { type: 'string' } }, required: ['rule', 'reason'] } },
        ignoreSelectors: { type: 'array', items: { type: 'string' }, description: 'Selectors whose subtree mutations are excluded from the DOM-quiet settle predicate (for example a live countdown). Echoed on the receipt so a pass stays auditable' },
        settle: { type: 'object', description: 'Per-call settle barrier overrides', properties: { scopeSelector: { type: 'string' }, ignoreSelectors: { type: 'array', items: { type: 'string' } }, networkTimeoutMs: { type: 'number' }, fontsTimeoutMs: { type: 'number' }, imagesTimeoutMs: { type: 'number' }, domTimeoutMs: { type: 'number' }, totalTimeoutMs: { type: 'number' } } },
        expectedStatus: { type: 'number', description: 'HTTP status the contract screen declares for this route (for example 404 on a not-found screen). A document returning exactly that status is not reported as ROUTE_404; echoed on the receipt' },
        allowNonTheme: { type: 'boolean', description: 'Accept a workspace root without theme markers (layout/theme.liquid, config/settings_schema.json, config/settings.html) for a plain-folder run. Otherwise such a root is refused with WORKSPACE_NOT_THEME and no receipt is written' },
        greenfield: { type: 'object', description: 'Declare that no visual baseline exists yet for this storefront (a new build). The run records the reason and the observed baseline state on the receipt; it is refused when baselines already exist for the route', properties: { reason: { type: 'string', description: 'Why the run has no baseline to compare against' } }, required: ['reason'] },
        viewports: {
          type: 'object',
          properties: {
            desktop: { type: 'object', properties: { mismatchPercent: { type: 'number' }, passed: { type: 'boolean' } } },
            tablet: { type: 'object', properties: { mismatchPercent: { type: 'number' }, passed: { type: 'boolean' } } },
            mobile: { type: 'object', properties: { mismatchPercent: { type: 'number' }, passed: { type: 'boolean' } } },
          },
        },
      },
    },
    execute: async (
      params: {
        tabId?: string;
        annotationId?: string;
        expectedUrl?: string;
        workspaceRoot?: string;
        multiBreakpoint?: boolean;
        profile?: QaProfile;
        thresholds?: QaThresholds;
        coverageFloor?: number;
        waivers?: QaWaiver[];
        ignoreSelectors?: string[];
        expectedStatus?: number;
        settle?: QaSettleOverrides;
        allowNonTheme?: boolean;
        greenfield?: { reason: string };
        viewports?: {
          // `passed` is the caller structural verdict; the QA matrix ANDs it with the pixel threshold, so only downgrades are possible.
          desktop?: { mismatchPercent: number; passed: boolean };
          tablet?: { mismatchPercent: number; passed: boolean };
          mobile?: { mismatchPercent: number; passed: boolean };
        };
      },
      context
    ) => {
      const target = context.browserTarget as BrowserTarget;
      const runId = context.runId || 'run-unbound';
      const attemptId = context.attemptId || 'attempt-unbound';
      const callId = randomUUID();
      const qaOptions = parseQaValidateOptions(params as Record<string, unknown>);
      // Refuse a root outside the bound workspace before anything runs: silently
      // substituting the default root would write receipts a caller believes
      // describe a different theme.
      const strictRoot = confineWorkspaceRootStrict(params.workspaceRoot, resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot));
      if (strictRoot.redirected) {
        throw new CapabilityError('WORKSPACE_MISMATCH', `Requested workspaceRoot '${strictRoot.requested}' is outside the bound workspace '${strictRoot.root}'; no QA ran and no receipt was written`, { requested: strictRoot.requested, bound: strictRoot.root });
      }
      if (params.allowNonTheme !== true) assertThemeWorkspaceRoot(strictRoot.root, 'theme.qa_validate');
      // Resolve the confined workspace root BEFORE any terminal branch. The route gate
      // and the pre-flight guards below can throw, and every one of those throws is a
      // terminal QA outcome that still owes the consuming-runtime gate a receipt.
      const confinedRoot = strictRoot.root;
      let receiptVerdict: QaReceiptVerdict = 'QA_INCONCLUSIVE';
      let errorCode: string | null = null;
      let errorMessage: string | null = null;
      let passed: boolean | null = null;
      let criticalCount: number | null = null;
      let pageCriticalCount: number | null = null;
      let scopedCriticalCount: number | null | undefined = undefined;
      let receiptFindings: QaReceiptFinding[] = [];
      // Read from the evidence gaps, not the capped findings list a warning can fall off.
      let authRedirect = false;
      let authLandingNote: string | null = null;
      let receiptViewport: { width: number; height: number } | undefined;
      let settingsRatchetPayload: {
        ok: boolean;
        newFailures: number;
        legacyDebt: number;
        findings: SettingsFinding[];
      } | null = null;
      // Resilient-QA axes mirrored onto the receipt so consuming runtimes can
      // separate "storefront failed" from "automation degraded".
      let receiptExecution: 'COMPLETED' | 'DEGRADED' | 'BLOCKED' = 'COMPLETED';
      let receiptRecovery = { attempted: 0, succeeded: 0 };
      let receiptDisposition: RefusalDisposition | null = null;
      let errorReason: string | null = null;
      let finalReport: ThemeQaReport | undefined;
      // Set once the promoted baseline store has been consulted for a declared greenfield run.
      let greenfieldInput: { reason: string; baselineExists: boolean } | undefined;
      const runValidate = async (t: BrowserTarget) => themeQaWorkflow!.validate({
        runId,
        attemptId,
        workspaceRoot: confinedRoot,
        multiBreakpoint: params.multiBreakpoint,
        viewports: params.viewports,
        target: t,
        annotationId: params.annotationId,
        profile: qaOptions.profile ?? DEFAULT_QA_VALIDATE_PROFILE,
        ...(qaOptions.thresholds ? { thresholds: qaOptions.thresholds } : {}),
        ...(qaOptions.coverageFloor !== undefined ? { coverageFloor: qaOptions.coverageFloor } : {}),
        ...(qaOptions.waivers.length > 0 ? { waivers: qaOptions.waivers } : {}),
        ...(qaOptions.settle ? { settle: qaOptions.settle } : {}),
        ...(qaOptions.expectedStatus !== undefined ? { expectedDocumentStatus: qaOptions.expectedStatus } : {}),
        // Mirror real wrapper recovery into the report — never hard-code zero
        // after a failover rebind succeeded.
        recovery: receiptRecovery,
        ...(greenfieldInput ? { greenfield: greenfieldInput } : {}),
      });
      try {
        if (!target?.tabId) {
          throw new CapabilityError('TARGET_MISMATCH', 'No valid browser target bound to context');
        }
        if (!themeQaWorkflow) {
          throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme QA workflow is not available');
        }
        if (qaOptions.greenfield) {
          const existingBaselines = listPromotedBaselineIds(browser, context);
          if (existingBaselines.length > 0) {
            throw new CapabilityError('GREENFIELD_BASELINE_EXISTS', `A promoted visual baseline already exists for this workspace (${existingBaselines.join(', ')}); a greenfield run cannot replace it`, {
              baselineIds: existingBaselines,
              recovery: 'compare against the promoted baseline with anti.visual.compare and pass the results as viewports, or delete the old baseline deliberately',
            });
          }
          greenfieldInput = { reason: qaOptions.greenfield.reason, baselineExists: false };
        }
        if (typeof params.expectedUrl === 'string' && params.expectedUrl.trim()) {
          const observedUrl = await browser.getLiveTabUrl(target.tabId);
          const routeCheck = checkRouteIdentity(params.expectedUrl, observedUrl, browser.getTabRedirectChain(target.tabId));
          if (!routeCheck.ok) {
            // Haravan sends an auth-gated route to its hosted sign-in and drops ?themeid=; that landing is the
            // platform's page, so the run is unmeasured (authRedirect) rather than a route-gate error.
            const landedPath = (() => { try { return new URL(routeCheck.observedUrl).pathname; } catch { return routeCheck.observedUrl; } })();
            const authDrift = (routeCheck.code === 'URL_THEME_MISMATCH' || routeCheck.code === 'URL_PATH_MISMATCH') && AUTH_ROUTE_RE.test(landedPath);
            if (!authDrift) {
              throw new CapabilityError(
                routeCheck.status,
                `Theme QA route gate failed on tab '${target.tabId}': ${routeCheck.reason || routeCheck.status} (observed: ${routeCheck.observedUrl || 'unknown'})`
              );
            }
            authLandingNote = `AUTH_REDIRECT: Route '${params.expectedUrl}' landed on authentication page '${routeCheck.observedUrl}' (${routeCheck.code}); the page is not graded`;
          }
        }
        // Auto-recovery is narrow by design: only a TARGET_STALE (or sibling
        // transient code) whose error details carry a rebind signal AND whose
        // host can name a failover tab earns exactly one re-validate on the new
        // target. Route gate, identity, and policy errors above are preflight
        // hard blocks and never enter this path. Full validate() is not blindly
        // retried — the failover target makes the reload/barrier re-run sound.
        let report: ThemeQaReport;
        try {
          report = await runValidate(target);
        } catch (firstErr) {
          const disposition = dispositionFor(firstErr, 'read');
          receiptDisposition = disposition;
          if (disposition !== 'AUTO_RECOVER' || !isRebindableStale(firstErr)) {
            throw firstErr;
          }
          const failoverTabId = browser.resolveFailoverTargetTab(target.tabId);
          if (!failoverTabId || failoverTabId === target.tabId) {
            throw firstErr;
          }
          receiptRecovery.attempted = 1;
          const rebound = browser.rebindTarget({ tabId: failoverTabId }, target);
          if (!rebound?.success || !rebound.tabId) {
            throw firstErr;
          }
          const recoveredTarget: BrowserTarget = {
            ...target,
            tabId: rebound.tabId,
            documentGeneration: rebound.documentGeneration,
            browserEpoch: rebound.browserEpoch,
            url: rebound.url ?? target.url,
          };
          // A failover tab is a different document — the preflight route gate
          // must pass on IT before revalidation, or we'd certify the wrong page.
          if (typeof params.expectedUrl === 'string' && params.expectedUrl.trim()) {
            const recoveredUrl = await browser.getLiveTabUrl(recoveredTarget.tabId);
            const recoveredRoute = checkRouteIdentity(params.expectedUrl, recoveredUrl, browser.getTabRedirectChain(recoveredTarget.tabId));
            if (!recoveredRoute.ok) {
              throw firstErr; // refuse: failover does not satisfy the route contract
            }
          }
          // Recovery succeeded at the rebind — record it BEFORE revalidation so
          // the staged report serializes the real counters, not a stale zero.
          receiptRecovery.succeeded = 1;
          report = await runValidate(recoveredTarget);
        }
        const summary = report.summary;
        finalReport = report;
        receiptViewport = report.viewport ?? summary?.viewport;
        passed = summary?.passed ?? null;
        criticalCount = summary?.criticalCount ?? null;
        pageCriticalCount =
          typeof summary?.pageCriticalCount === 'number' ? summary.pageCriticalCount : criticalCount;
        if (summary && typeof summary.pageCriticalCount !== 'number' && typeof pageCriticalCount === 'number') {
          summary.pageCriticalCount = pageCriticalCount;
        }
        if (report.execution === 'DEGRADED' || report.execution === 'COMPLETED' || report.execution === 'BLOCKED') {
          receiptExecution = report.execution;
        }
        // Three-valued on purpose: a DEGRADED run (settle gaps, missing evidence)
        // is INCONCLUSIVE, not FAILED. The QA gate keeps itself armed on
        // QA_FAILED only, so collapsing INCONCLUSIVE into FAILED would pin the
        // gate on every degraded capture and loop the agent on re-validation.
        // A critical finding still fails regardless of the verdict axis.
        receiptVerdict = summary?.passed === true && (summary?.criticalCount ?? 0) === 0
          ? 'QA_PASSED'
          : (summary?.verdict === 'INCONCLUSIVE' && (summary?.criticalCount ?? 0) === 0 ? 'QA_INCONCLUSIVE' : 'QA_FAILED');
        if (authLandingNote) {
          if (report.findings) {
            const gaps = report.findings.evidenceGaps ?? (report.findings.evidenceGaps = []);
            if (!gaps.includes(authLandingNote)) gaps.push(authLandingNote);
          }
          report.execution = 'DEGRADED';
          receiptExecution = 'DEGRADED';
          receiptVerdict = 'QA_INCONCLUSIVE';
          passed = false;
          if (report.summary) {
            report.summary.passed = false;
            report.summary.verdict = 'INCONCLUSIVE';
            if (report.summary.certification === 'CERTIFIED') report.summary.certification = 'STRUCTURAL';
          }
          errorCode = 'AUTH_REDIRECT';
          errorReason = 'auth-redirect';
          errorMessage = authLandingNote.slice(0, QA_RECEIPT_ERROR_MESSAGE_MAX);
        }

        if (confinedRoot && isHaravanThemeWorkspace(confinedRoot)) {
          try {
            const repoRoot = resolveRepoRoot();
            const themeChecksPath = path.join(repoRoot, 'scripts', 'lib', 'theme-checks.mjs');
            if (fs.existsSync(themeChecksPath)) {
              // Dynamic import: scripts/lib/theme-checks.mjs is an uncompiled pure-ESM CLI module outside TypeScript rootDir.
              const themeChecksModule = await import(pathToFileURL(themeChecksPath).href);
              const { checkHaravanLiquidContracts, checkSettingsBinding, checkF1genzSettingsSchema } = themeChecksModule;
              const hasSettingsSchema = fs.existsSync(path.join(confinedRoot, 'config', 'settings_schema.json'));
              const haravanContracts = typeof checkHaravanLiquidContracts === 'function'
                ? checkHaravanLiquidContracts(confinedRoot, { platform: 'haravan' })
                : { ok: true, failures: [] };
              const settingsBinding = typeof checkSettingsBinding === 'function'
                ? checkSettingsBinding(confinedRoot)
                : { ok: true, failures: [] };
              const f1genzSchema = hasSettingsSchema && typeof checkF1genzSettingsSchema === 'function'
                ? checkF1genzSettingsSchema(confinedRoot)
                : null;

              const findings: SettingsFinding[] = [];
              if (Array.isArray(haravanContracts?.failures)) {
                for (const f of haravanContracts.failures) {
                  findings.push({
                    rule: f.rule,
                    id: f.id,
                    file: f.file || 'config/settings.html',
                    line: f.line,
                    ...(f.pointer ? { pointer: f.pointer } : {}),
                    message: f.message,
                    detail: f.detail,
                  });
                }
              }
              if (Array.isArray(settingsBinding?.failures)) {
                for (const f of settingsBinding.failures) {
                  if (Array.isArray(f.files) && f.files.length > 0) {
                    for (const file of f.files) {
                      findings.push({
                        rule: f.rule,
                        id: f.id,
                        file,
                        line: f.line,
                        ...(f.pointer ? { pointer: f.pointer } : {}),
                        message: f.message,
                        detail: f.detail,
                      });
                    }
                  } else {
                    findings.push({
                      rule: f.rule,
                      id: f.id,
                      file: f.file || 'config/settings.html',
                      line: f.line,
                      ...(f.pointer ? { pointer: f.pointer } : {}),
                      message: f.message,
                      detail: f.detail,
                    });
                  }
                }
              }
              const deadIds = Array.isArray(settingsBinding?.dead) ? settingsBinding.dead : [];
              const seenF1genzKeys = new Set<string>();
              if (Array.isArray(f1genzSchema?.failures)) {
                for (const f of f1genzSchema.failures) {
                  const file = f.file || 'config/settings_schema.json';
                  const key = `${f.rule}::${f.id || ''}::${file}`;
                  if (seenF1genzKeys.has(key)) continue;
                  seenF1genzKeys.add(key);
                  findings.push({
                    rule: f.rule,
                    id: f.id,
                    file,
                    ...(f.line ? { line: f.line } : {}),
                    ...(f.pointer ? { pointer: f.pointer } : {}),
                    message: f.message,
                    detail: f.message,
                  });
                }
              }
              for (const d of deadIds) {
                if (!d || typeof d.id !== 'string') continue;
                const file = hasSettingsSchema ? 'config/settings_schema.json' : 'config/settings.html';
                const key = `dead-setting::${d.id}::${file}`;
                if (seenF1genzKeys.has(key)) continue;
                seenF1genzKeys.add(key);
                findings.push({
                  rule: 'dead-setting',
                  id: d.id,
                  file,
                  ...(d.line ? { line: d.line } : {}),
                  ...(d.pointer ? { pointer: d.pointer } : {}),
                  message: `schema setting has no resolved reference: ${d.id}`,
                  detail: `Declared setting '${d.id}' is never referenced in theme Liquid files`,
                });
              }

              const baseline = loadOrBootstrapBaseline(confinedRoot, findings);
              const ratchetResult = evaluateSettingsRatchet(baseline, findings, {
                workspaceRoot: confinedRoot,
                deadIds,
              });

              settingsRatchetPayload = {
                ok: ratchetResult.ok,
                newFailures: ratchetResult.newFailures.length,
                legacyDebt: ratchetResult.legacyDebt.length,
                ...(typeof ratchetResult.deadInSchema === 'number' ? { deadInSchema: ratchetResult.deadInSchema } : {}),
                findings: ratchetResult.newFailures,
              };

              if (!ratchetResult.ok) {
                receiptVerdict = 'QA_FAILED';
                passed = false;
                errorCode = errorCode || 'SETTINGS_CONTRACT_REGRESSION';
                errorMessage = `Settings contract regression: ${ratchetResult.newFailures.length} new finding(s) introduced.`;
                // The report returned to the MCP caller must agree with the on-disk
                // receipt: agents gate on summary.passed/criticalCount, so a ratchet
                // failure has to be visible on the returned object, not only the receipt.
                report.summary.passed = false;
                report.summary.verdict = 'FAIL';
                // A settings-contract regression is a critical finding class for
                // consumers that gate on criticalCount alone.
                report.summary.criticalCount = Math.max(report.summary.criticalCount ?? 0, 1);
              }
              // Publish on success too: a clean settings check must be
              // distinguishable from one that never ran.
              report.settingsRatchet = settingsRatchetPayload;
            }
          } catch (settingsErr) {
            // The storefront verdict stands, but the caller must see that the
            // settings contract was NOT checked instead of reading "0 findings".
            const reason = settingsErr instanceof Error ? settingsErr.message : String(settingsErr);
            report.settingsRatchet = null;
            report.settleReceipt = {
              ...(report.settleReceipt ?? ({} as NonNullable<typeof report.settleReceipt>)),
              evidenceGaps: [
                ...(report.settleReceipt?.evidenceGaps ?? []),
                `Settings contract check did not run: ${reason}`,
              ],
            };
            if (report.execution === 'COMPLETED') {
              report.execution = 'DEGRADED';
              receiptExecution = 'DEGRADED';
            }
            if (receiptVerdict === 'QA_PASSED') {
              receiptVerdict = 'QA_INCONCLUSIVE';
              report.summary.verdict = 'INCONCLUSIVE';
            }
          }
        }
        receiptFindings = buildReceiptFindings(report.findings, settingsRatchetPayload, 200);
        authRedirect = Array.isArray(report.findings?.evidenceGaps) && report.findings.evidenceGaps.some((gap) => /^AUTH_REDIRECT:/.test(String(gap)));
        if (typeof report.summary?.criticalCount === 'number') {
          criticalCount = report.summary.criticalCount;
          if (typeof pageCriticalCount !== 'number' || report.summary.criticalCount > pageCriticalCount) {
            pageCriticalCount = report.summary.criticalCount;
            report.summary.pageCriticalCount = pageCriticalCount;
          }
        }
        if (params.annotationId) {
          const annotationTarget = resolveAnnotationTargetSelector(confinedRoot, params.annotationId);
          if (typeof report.summary?.scopedCriticalCount === 'number') {
            scopedCriticalCount = report.summary.scopedCriticalCount;
          } else if (annotationTarget) {
            scopedCriticalCount = computeScopedCriticalCount(
              report.findings,
              annotationTarget.selector,
              annotationTarget.domAncestry,
              receiptFindings
            );
            if (report.summary) {
              report.summary.scopedCriticalCount = scopedCriticalCount;
            }
          } else {
            scopedCriticalCount = null;
            if (report.summary && report.summary.scopedCriticalCount === undefined) {
              report.summary.scopedCriticalCount = null;
            }
          }
        } else if (typeof report.summary?.scopedCriticalCount === 'number') {
          scopedCriticalCount = report.summary.scopedCriticalCount;
        }
        if (receiptExecution !== 'COMPLETED' && !errorCode) {
          // A degraded run must say why: the failing settle gate when there is one, else the evidence gaps.
          const settleFailure = settleFailureOf(report, undefined);
          const gaps = [...(report.settleReceipt?.evidenceGaps ?? []), ...(report.findings?.evidenceGaps ?? [])]
            .filter((gap, index, all) => all.indexOf(gap) === index);
          errorCode = settleFailure ? settleFailure.code : 'EVIDENCE_INCOMPLETE';
          errorReason = settleFailure ? settleFailure.reason : (gaps[0] ? String(gaps[0]).slice(0, QA_RECEIPT_ERROR_MESSAGE_MAX) : 'evidence');
          errorMessage = gaps.length > 0 ? gaps.join('; ').slice(0, QA_RECEIPT_ERROR_MESSAGE_MAX) : null;
        }
        return report;
      } catch (err) {
        // Terminal failure: the report never materialised, so the receipt must say so.
        // Diagnostics are best-effort (they must never replace the original error) and
        // the original error is rethrown unchanged so this call still fails honestly.
        try {
          receiptVerdict = classifyTerminalVerdict(err);
          errorCode = extractErrorCode(err);
          errorMessage = extractErrorMessage(err);
          errorReason = settleFailureOf(undefined, err)?.reason ?? errorMessage;
          // Terminal classification: identity/policy errors are the only
          // BLOCKED executions; every other refusal degrades the run to
          // INCONCLUSIVE evidence with DEGRADED execution (or records the
          // retry demand / unreadable attempt explicitly).
          const disp = dispositionFor(err, 'read');
          receiptDisposition = receiptDisposition || disp;
          if (disp === 'HARD_BLOCK') receiptExecution = 'BLOCKED';
          else if (disp === 'RETRY_REQUIRED') { receiptExecution = 'DEGRADED'; receiptRecovery.attempted = 0; }
          else if (disp !== 'AUTO_RECOVER' || receiptRecovery.succeeded === 0) receiptExecution = 'DEGRADED';
        } catch {
          errorCode = 'UNKNOWN_ERROR';
          errorMessage = null;
        }
        throw err;
      } finally {
        // Workspace-side QA receipt: consuming runtimes (OMP post-hooks) gate fix
        // handoffs on this file, not on agent prose. It is emitted on EVERY terminal
        // branch — success and every throw — because a gate that only sees passing runs
        // deadlocks on a failing tab. Advisory evidence: a receipt failure (or the
        // `observedUrl` probe) must never change the QA call's own outcome.
        try {
          if (confinedRoot) {
            const tabId = target?.tabId;
            const observedUrl = tabId ? await browser.getLiveTabUrl(tabId).catch(() => '') : '';
            const settleSource = finalReport?.settleReceipt;
            const summaryExtras = (finalReport?.summary ?? {}) as { certificationReasons?: unknown; thresholdsSource?: unknown; viewport?: { width?: number; requestedWidth?: number | null; observedWidth?: number } };
            const certification: 'CERTIFIED' | 'STRUCTURAL' = finalReport?.summary?.certification === 'CERTIFIED' ? 'CERTIFIED' : 'STRUCTURAL';
            const certificationReasons = Array.isArray(summaryExtras.certificationReasons) ? summaryExtras.certificationReasons.map(String) : [];
            const reportThresholdsSource = (finalReport as { thresholdsSource?: unknown } | undefined)?.thresholdsSource ?? summaryExtras.thresholdsSource;
            const thresholdsSource = typeof reportThresholdsSource === 'string' ? reportThresholdsSource : null;
            const observedWidth = summaryExtras.viewport?.observedWidth ?? receiptViewport?.width;
            const receiptViewportDetail = receiptViewport || typeof observedWidth === 'number'
              ? { ...(receiptViewport ?? {}), requestedWidth: summaryExtras.viewport?.requestedWidth ?? null, observedWidth: observedWidth ?? null }
              : null;
            const receipt = {
              receiptVersion: '1.3',
              runId,
              attemptId,
              callId,
              annotationId: params.annotationId || null,
              tabId: tabId || null,
              documentGeneration: target?.documentGeneration ?? null,
              browserEpoch: (target as { browserEpoch?: number } | undefined)?.browserEpoch ?? null,
              expectedUrl: params.expectedUrl || null,
              expectedStatus: qaOptions.expectedStatus ?? null,
              observedUrl: observedUrl || null,
              workspaceRoot: confinedRoot,
              workspaceRootRequested: strictRoot.requested || null,
              workspaceRootRedirected: strictRoot.redirected,
              profile: finalReport?.profile ?? null,
              certification,
              certificationReasons,
              thresholdsSource,
              scope: params.annotationId ? 'annotation' : certification === 'CERTIFIED' ? 'certified' : 'structural',
              measuredRules: finalReport?.measuredRules ?? [],
              coverage: finalReport?.coverage ?? null,
              coverageFloor: finalReport?.coverageFloor ?? null,
              verdict: receiptVerdict,
              execution: receiptExecution,
              recovery: receiptRecovery,
              disposition: receiptDisposition,
              errorCode,
              errorMessage,
              errorReason,
              settle: settleSource
                ? {
                    settleComplete: settleSource.settleComplete ?? null,
                    failingPredicate: settleSource.failingPredicate ?? null,
                    domUnstable: settleSource.domUnstable === true,
                    evidenceGaps: settleSource.evidenceGaps ?? [],
                    ignoreSelectors: settleSource.ignoreSelectors ?? [],
                    retries: settleSource.settleRetries ?? 0,
                    scopeSelector: settleSource.scopeSelector ?? null,
                  }
                : null,
              waivers: finalReport?.waivers ?? qaOptions.waivers,
              passed,
              criticalCount,
              pageCriticalCount,
              ...(scopedCriticalCount !== undefined ? { scopedCriticalCount } : {}),
              authRedirect,
              findings: receiptFindings,
              ...(receiptViewportDetail ? { viewport: receiptViewportDetail } : {}),
              createdAt: new Date().toISOString(),
            };
            if (settingsRatchetPayload) {
              (receipt as Record<string, unknown>).settingsRatchet = settingsRatchetPayload;
            }
            const receiptsDir = path.join(confinedRoot, '.antifan', 'qa-receipts');
            fs.mkdirSync(receiptsDir, { recursive: true });
            const safeRunId = String(receipt.runId).replace(/[^a-zA-Z0-9_-]/g, '_');
            const receiptPath = path.join(receiptsDir, `${Date.now()}-${safeRunId}-${callId.slice(0, 8)}.json`);
            fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
            if (finalReport) finalReport.receipt = { written: true, path: receiptPath };
          }
        } catch {
          if (finalReport) {
            finalReport.receipt = { written: false, code: 'RECEIPT_WRITE_FAILED' };
            // A run whose evidence file could not be persisted cannot be certified: the consuming gate would find nothing.
            if (finalReport.summary && finalReport.summary.certification === 'CERTIFIED') finalReport.summary.certification = 'STRUCTURAL';
          }
        }
      }
    },
  });

  catalogue.register({
    name: 'theme.qa_repair.begin',
    description: 'Begin a safe theme repair session: creates immutable R0 snapshot and validates Round 1 baseline',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object' },
    execute: async (_params: Record<string, unknown>, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (!context.runId || !context.attemptId) {
        throw new CapabilityError('UNAUTHENTICATED', 'runId and attemptId context are required for repair session');
      }
      const authWs = catalogue.resolveAuthoritativeWorkspace(
        context.projectId || target.projectId,
        context.workspaceId || target.workspaceId
      );
      if (!coordinator) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme repair coordinator is not available');
      return coordinator.begin({
        workspaceRoot: authWs.rootPath,
        target,
        runId: context.runId,
        attemptId: context.attemptId,
      });
    },
  });

  catalogue.register({
    name: 'theme.qa_repair.verify',
    description: 'Verify a repair against fresh workspace revision and baseline findings; failed checks retain a bounded retry session, regressions roll back to R0, exhausted repairs return blocked',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: async (params: { sessionId: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      // Write-class capability: require an authenticated attempt context. The coordinator mints
      // its own per-verification attempt id, so the caller's id is deliberately not forwarded.
      if (!context.attemptId) {
        throw new CapabilityError('UNAUTHENTICATED', 'attemptId context is required for verify session');
      }
      if (!coordinator) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme repair coordinator is not available');
      return coordinator.verify({
        sessionId: params.sessionId,
        target,
      });
    },
  });

  catalogue.register({
    name: 'theme.qa_rollback',
    description: 'Roll back an active repair session to its initial R0 baseline',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'destructive-mutation',
      risk: 'write',
      requiresBrowserTarget: true,
      lane: 'viewport-gate',
      duplicateMode: 'reject-concurrent',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
    }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: async (params: { sessionId: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (!coordinator) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Theme repair coordinator is not available');
      return coordinator.rollback({
        sessionId: params.sessionId,
        target,
      });
    },
  });

  catalogue.register({
    name: 'antifan_theme_qa_repair_begin',
    description: 'Alias for theme.qa_repair.begin',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object' },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_repair.begin')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_qa_repair_verify',
    description: 'Alias for theme.qa_repair.verify',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_repair.verify')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_qa_rollback',
    description: 'Alias for theme.qa_rollback',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'destructive-mutation',
      risk: 'write',
      requiresBrowserTarget: true,
      lane: 'viewport-gate',
      duplicateMode: 'reject-concurrent',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
    }),
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_rollback')!.execute(params, context),
  });
  // theme.cockpit_* family: registered only when the host actually wired a
  // CockpitPort (the gate and headless builds pass none — the registrations
  // must not exist in a catalogue that cannot execute them).
  if (cockpit) registerCockpitCapabilities(catalogue, cockpit, browser);
  registerQaProbeCapabilities(catalogue, browser, getWorkspaceRoot);
  registerSheetCapabilities(catalogue, browser);

  catalogue.register({
    name: 'theme.assert_cart',
    description: 'Assert passive storefront AJAX cart contract telemetry without adding synthetic items',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: async (params: { tabId?: string }, context) => {
      const value = await browser.eval(context.browserTarget as BrowserTarget, HsGateRules.getBrowserCartAssertionScript(), params.tabId);
      return HsGateRules.evaluateCartTelemetry(value);
    },
  });

  catalogue.register({
    name: 'theme.debug_bundle',
    description: 'Return a single atomic bundle containing platform metadata, active template/section hierarchy, zero-Liquid error scan, layout overflow deltaX, and passive cart telemetry',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: async (params: { tabId?: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      const domResult = await browser.dom(target, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', undefined, params.tabId);
      let rawHtml = '';
      if (typeof domResult === 'string') {
        rawHtml = domResult;
      } else if (domResult && typeof domResult === 'object' && 'id' in domResult && browser.artifacts && typeof (browser.artifacts as any).readTextById === 'function') {
        try {
          rawHtml = (browser.artifacts as any).readTextById(domResult.id, context).text;
        } catch {
          rawHtml = '';
        }
      }
      const platform = PlatformDetector.detect(undefined, undefined, rawHtml);
      const liquid = LiquidErrorScanner.scanHtmlString(rawHtml);
      const evidenceGaps: string[] = [];
      let overflow: { measured: boolean; unmeasuredReason?: string; hasOverflow: boolean; deltaX: number; culprits: unknown[] } = {
        measured: false,
        unmeasuredReason: 'Layout overflow scan did not run',
        hasOverflow: false,
        deltaX: 0,
        culprits: [],
      };
      const markOverflowUnmeasured = (reason: string): void => {
        overflow = { measured: false, unmeasuredReason: reason, hasOverflow: false, deltaX: 0, culprits: [] };
        evidenceGaps.push(`Layout overflow not measured: ${reason}`);
      };
      try {
        const evalOverflow = await browser.eval(target, LayoutOverflowEngine.getBrowserScanScript('active'), params.tabId, undefined, { requireRenderSurface: true });
        const record = evalOverflow && typeof evalOverflow === 'object' && !Array.isArray(evalOverflow)
          ? (evalOverflow as Record<string, unknown>)
          : undefined;
        const measured = record !== undefined
          && record.measured !== false
          && typeof record.clientWidth === 'number' && Number.isFinite(record.clientWidth) && record.clientWidth > 0
          && typeof record.hasOverflow === 'boolean'
          && typeof record.deltaX === 'number' && Number.isFinite(record.deltaX) && record.deltaX >= 0
          && Array.isArray(record.culprits);
        if (record && measured) {
          overflow = { measured: true, hasOverflow: record.hasOverflow as boolean, deltaX: record.deltaX as number, culprits: record.culprits as unknown[] };
        } else {
          markOverflowUnmeasured(LayoutOverflowEngine.readUnmeasuredReason(evalOverflow) ?? 'the scanned tab returned no usable viewport measurement');
        }
      } catch (error) {
        markOverflowUnmeasured(error instanceof Error ? error.message : String(error));
      }
      let hsRules = HsGateRules.evaluateHtml(rawHtml, platform.platform);
      try { const evalHs = await browser.eval(target, HsGateRules.getBrowserEvaluationScript(platform.platform), params.tabId); if (evalHs && typeof evalHs === 'object' && 'passed' in evalHs) hsRules = evalHs as HsEvaluationResult; } catch {}
      let templateHierarchy: unknown = { template: undefined, sections: [] };
      try { templateHierarchy = await browser.eval(target, getThemeHierarchyScript(), params.tabId) || templateHierarchy; } catch {}
      let cartTelemetry = hsRules.cartTelemetry;
      if (!cartTelemetry) { try { const value = await browser.eval(target, HsGateRules.getBrowserCartAssertionScript(), params.tabId); cartTelemetry = HsGateRules.evaluateCartTelemetry(value); } catch {} }
      const effectiveTarget = params.tabId && typeof params.tabId === 'string' && params.tabId.trim().length > 0 && params.tabId.trim() !== target?.tabId
        ? { ...target, tabId: params.tabId.trim() }
        : target;
      return { target: effectiveTarget, platform, templateHierarchy, liquid, overflow, cartTelemetry, hsRules, evidenceGaps, timestamp: Date.now() };
    },
  });

  catalogue.register({
    name: 'antifan_theme_qa_validate',
    description: 'Alias for theme.qa_validate',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        workspaceRoot: { type: 'string' },
        greenfield: { type: 'object', description: 'Declare that no visual baseline exists yet for this storefront (a new build)', properties: { reason: { type: 'string' } }, required: ['reason'] },
        multiBreakpoint: { type: 'boolean' },
        viewports: {
          type: 'object',
          properties: {
            desktop: { type: 'object', properties: { mismatchPercent: { type: 'number' }, passed: { type: 'boolean' } } },
            tablet: { type: 'object', properties: { mismatchPercent: { type: 'number' }, passed: { type: 'boolean' } } },
            mobile: { type: 'object', properties: { mismatchPercent: { type: 'number' }, passed: { type: 'boolean' } } },
          },
        },
      },
    },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.qa_validate')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_debug_bundle',
    description: 'Alias for theme.debug_bundle',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 60_000 }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.debug_bundle')!.execute(params, context),
  });
  catalogue.register({
    name: 'theme.resolve_product',
    description: 'Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: async (params: { handle?: string; tabId?: string }, context) => {
      const target = context.browserTarget as BrowserTarget;
      return browser.eval(target, getProductResolverScript(params.handle), params.tabId);
    },
  });

  catalogue.register({
    name: 'anti.theme.resolve_product',
    description: 'Alias for theme.resolve_product',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.resolve_product')!.execute(params, context),
  });

  catalogue.register({
    name: 'storefront.resolve_product',
    description: 'Alias for theme.resolve_product',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.resolve_product')!.execute(params, context),
  });

  catalogue.register({
    name: 'antifan_theme_resolve_product',
    description: 'Alias for theme.resolve_product',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive', timeoutMs: 30_000 }),
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, tabId: { type: 'string' } } },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.resolve_product')!.execute(params, context),
  });
  catalogue.register({
    name: 'theme.style_override',
    description: 'In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers). Automatically scoped to page memory.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['apply', 'clear', 'remove', 'revert'], description: 'apply injects/replaces the override; clear (synonyms: remove, revert) removes it' },
        id: { type: 'string', description: 'Unique identifier for the stylesheet element (e.g. "sticky-header-fix")' },
        css: { type: 'string', description: 'CSS rules to inject when operation is apply' },
        tabId: { type: 'string', description: 'Target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Target pane ID in split review mode' },
      },
      required: ['operation'],
    },
    execute: async (params: { operation: 'apply' | 'clear' | 'remove' | 'revert'; id?: string; css?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => {
      const target = context.browserTarget as BrowserTarget;
      if (params.operation === 'apply') {
        if (!params.id || typeof params.id !== 'string' || !params.id.trim()) {
          throw new CapabilityError('INVALID_ARGUMENT', 'id is required when operation is "apply"');
        }
        const styleId = `__antifan_override_${params.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const cssContent = params.css || '';
        const script = `(() => {
          let el = document.getElementById(${JSON.stringify(styleId)});
          if (!el) {
            el = document.createElement('style');
            el.id = ${JSON.stringify(styleId)};
            el.setAttribute('data-antifan-override', 'true');
            (document.head || document.documentElement).appendChild(el);
          }
          el.textContent = ${JSON.stringify(cssContent)};
          return { applied: true, id: ${JSON.stringify(params.id)}, byteLength: ${cssContent.length} };
        })()`;
        return browser.eval(target, script, params.tabId, params.paneId);
      }
      if (!params.id || !params.id.trim()) {
        const script = `(() => {
          const elements = document.querySelectorAll('style[data-antifan-override="true"], style[id^="__antifan_override_"]');
          const count = elements.length;
          elements.forEach(el => el.remove());
          return { cleared: true, clearedCount: count };
        })()`;
        return browser.eval(target, script, params.tabId, params.paneId);
      }
      const styleId = `__antifan_override_${params.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const script = `(() => {
        const el = document.getElementById(${JSON.stringify(styleId)});
        if (el) { el.remove(); return { cleared: true, id: ${JSON.stringify(params.id)} }; }
        return { cleared: false, id: ${JSON.stringify(params.id)}, message: 'Override element not found' };
      })()`;
      return browser.eval(target, script, params.tabId, params.paneId);
    },
  });

  catalogue.register({
    name: 'anti.theme.style_override',
    description: 'Alias for theme.style_override: in-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['apply', 'clear', 'remove', 'revert'], description: 'apply injects/replaces the override; clear (synonyms: remove, revert) removes it' },
        id: { type: 'string', description: 'Unique identifier for the stylesheet element' },
        css: { type: 'string', description: 'CSS rules to inject when operation is apply' },
        tabId: { type: 'string', description: 'Target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Target pane ID in split review mode' },
      },
      required: ['operation'],
    },
    execute: (params: Record<string, unknown>, context) => catalogue.get('theme.style_override')!.execute(params as { operation: 'apply' | 'clear' | 'remove' | 'revert'; id?: string; css?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context),
  });

  // 3. anti.* aliases for unified client / bridge execution
  catalogue.register({
    name: 'anti.browser.tabs.list',
    description: 'List Chromium tabs in this session\'s project scope (each row carries affiliated: true when the tab measures into this session\'s project/workspace, including hibernated tabs whose views are parked). Pass all: true for global GUI discovery of the whole window strip, affiliatedOnly: true to keep only in-scope rows. The tab bound to this session is marked with isBoundTab: true.',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', default: false, description: 'Pass true for global GUI discovery: every tab in the window is listed and each row carries affiliated. Default lists only this session\'s project scope.' },
        affiliatedOnly: { type: 'boolean', default: false, description: 'Restrict the returned rows to tabs measuring into this session\'s project/workspace.' },
        projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused; it can never widen authority.' },
      }
    },
    execute: (params: { all?: boolean; affiliatedOnly?: boolean; projectId?: string }, context) => browser.listTabs({
      target: context.browserTarget,
      scope: params?.all === true ? 'global' : 'project',
      affiliatedOnly: params?.affiliatedOnly === true,
      projectId: typeof params?.projectId === 'string' ? params.projectId : undefined,
      authenticatedProjectId: context.projectId,
      authenticatedWorkspaceId: context.workspaceId,
    }),
  });
  catalogue.register({
    name: 'anti.browser.tabs.get',
    description: 'Read a single tab row in this session\'s project scope by tabId (same row shape and scope checks as tabs.list rows; refused for tabs outside the authenticated project/workspace).',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to read; omit to read this session\'s bound tab.' },
        projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused; it can never widen authority.' },
      },
    },
    execute: (params: { tabId?: string; projectId?: string }, context) => browser.getTab(context.browserTarget, typeof params?.tabId === 'string' ? params.tabId : '', {
      projectId: typeof params?.projectId === 'string' ? params.projectId : undefined,
      authenticatedProjectId: context.projectId,
      authenticatedWorkspaceId: context.workspaceId,
    }),
  });
  catalogue.register({
    name: 'anti.browser.tabs.create',
    description: 'Alias for browser.open-tab',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        activate: { type: 'boolean' },
        anchorTabId: { type: 'string', description: 'Live same-project tab selecting the window for creation' },
        ephemeral: { type: 'boolean' },
        userFacing: { type: 'boolean', description: 'Open tab directly on the visible user plane (non-ephemeral) for interactive inspection/debugging' },
        devicePresetId: { type: 'string', description: 'Device preset ID (e.g. iphone-15, xiaomi-14)' },
        mobile: { type: 'boolean', description: 'Open directly in mobile mode with mobile User-Agent and viewport' },
        projectId: { type: 'string', description: 'Scope selector: must equal this session\'s authenticated projectId. A foreign or unbound selector is refused before allocation; it never widens authority.' },
      },
    },
    execute: (params: { url?: string; activate?: boolean; anchorTabId?: string; ephemeral?: boolean; userFacing?: boolean; devicePresetId?: string; mobile?: boolean; projectId?: string }, context) => browser.openTab(params, { target: context?.browserTarget, authenticatedProjectId: context?.projectId }),
  });
  catalogue.register({
    name: 'anti.browser.tabs.activate',
    description: 'Alias for browser.switch-tab',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId?: string }, context) => {
      const authCtx = context as Partial<AuthenticatedCapabilityContext>;
      return browser.switchTab(String(params?.tabId || ''), {
        target: context.browserTarget as BrowserTarget,
        attachmentId: authCtx.attachmentId,
        runId: authCtx.runId,
        attemptId: authCtx.attemptId,
        isAgent: Boolean(authCtx.attachmentId),
      });
    },
  });
  catalogue.register({
    name: 'anti.browser.tabs.close',
    description: CLOSE_TAB_DESCRIPTION,
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] },
    execute: (params: { tabId: string }, context) => browser.closeTab(params.tabId, { target: context.browserTarget }),
  });

  catalogue.register({
    name: 'anti.browser.navigate',
    description: 'Alias for browser.navigate',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: navigateInputSchema(),
    execute: (params: { url: string; tabId?: string; timeoutMs?: number }, context) =>
      browser.navigate(context.browserTarget as BrowserTarget, params.url, params.tabId, params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined),
  });

  catalogue.register({
    name: 'anti.browser.reload',
    description: 'Alias for browser.reload',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: (params: { tabId?: string }, context) => browser.reload(context.browserTarget as BrowserTarget, params.tabId),
  });

  catalogue.register({
    name: 'anti.inspect.dom',
    description: 'Alias for browser.dom',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.dom(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.selector, params.tabId, params.paneId),
  });

  catalogue.register({
    name: 'anti.reference.capture',
    description: 'Capture a reference from a live page: materialize lazily-mounted content, settle, then stage the settled DOM (and optionally a screenshot) so later measurements describe the page a comparator actually rasterizes',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      lane: 'short-passive',
      timeoutMs: REFERENCE_CAPTURE_EXECUTION_BUDGET_MS + REFERENCE_CAPTURE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: REFERENCE_CAPTURE_CANCELLATION_ACK_MS,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        selector: { type: 'string', description: 'Scope the staged DOM to a selector (default: whole document)' },
        screenshot: { type: 'boolean', description: 'Also stage a viewport screenshot (default true)' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        quality: { type: 'number' },
        materializeDataSrc: { type: 'boolean', description: 'Also materialize images that carry only lazy data-src/data-srcset attributes (default false: they are counted as unmaterialized instead)' },
      },
    },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; selector?: string; screenshot?: boolean; format?: 'png' | 'jpeg'; quality?: number; materializeDataSrc?: boolean }, context) =>
      browser.referenceCapture(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params, context.signal),
  });

  catalogue.register({
    name: 'anti.screenshot.viewport',
    description: 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes, format: jpeg/png)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      lane: 'short-passive',
      timeoutMs: VIEWPORT_CAPTURE_EXECUTION_BUDGET_MS + VIEWPORT_CAPTURE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: VIEWPORT_CAPTURE_CANCELLATION_ACK_MS,
    }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' }, fullPage: { type: 'boolean', description: 'Rejected: anti.screenshot.viewport is viewport-only; use anti.screenshot.full_page' }, inline: { type: 'boolean', description: 'When false, returns only artifact metadata and file path without base64 image data' } } },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; inline?: boolean }, context) => {
      assertViewportOnlyScreenshot('anti.screenshot.viewport', params.fullPage);
      return browser.screenshot(context.browserTarget as BrowserTarget, context.runId || 'run-unbound', context.attemptId || 'attempt-unbound', params.tabId, params.paneId, { format: params.format || 'jpeg', quality: params.quality ?? 85, fullPage: false });
    },
  });

  catalogue.register({
    name: 'anti.screenshot.full_page',
    description: 'Capture canonical CDP full-page evidence (entire document scroll height) and stage it under the evidence lease',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      lane: 'short-passive',
      timeoutMs: FULL_PAGE_CAPTURE_EXECUTION_BUDGET_MS + FULL_PAGE_CAPTURE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: FULL_PAGE_CAPTURE_CANCELLATION_ACK_MS,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'png (default) is validated as PNG bytes; jpeg stages a smaller file for very tall pages. A page taller than the single-capture limit is captured in tiles and stitched' },
        quality: { type: 'number', description: 'JPEG quality 1-100 (default 85); ignored for png' },
        leaseToken: { type: 'string', description: 'Evidence-run artifact lease token from artifact.preflight; required while the run holds an exclusive lease' },
        expectedUrl: { type: 'string', description: 'Expected route URL for route identity gate assertion' },
        materializeDataSrc: { type: 'boolean', description: 'Swap lazy data-src/data-srcset into live sources before capture, for loaders that only swap on user interaction (default false: such images fail the imagesSettled gate with CAPTURE_NOT_READY)' },
        inline: { type: 'boolean', description: 'When false, returns only artifact metadata and file path without base64 image data' },
      },
    },
    execute: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; format?: 'png' | 'jpeg'; quality?: number; leaseToken?: string; expectedUrl?: string; materializeDataSrc?: boolean; inline?: boolean }, context) => {
      if (params.format !== undefined && params.format !== 'png' && params.format !== 'jpeg') {
        throw new CapabilityError('INVALID_ARGUMENT', `anti.screenshot.full_page format must be 'png' or 'jpeg', got '${String(params.format)}'`);
      }
      if (params.quality !== undefined && (typeof params.quality !== 'number' || !Number.isFinite(params.quality) || params.quality < 1 || params.quality > 100)) {
        throw new CapabilityError('INVALID_ARGUMENT', 'anti.screenshot.full_page quality must be a number between 1 and 100');
      }
      return browser.screenshotFullPage(
        context.browserTarget as BrowserTarget,
        context.runId || 'run-unbound',
        context.attemptId || 'attempt-unbound',
        params.tabId,
        params.paneId,
        {
          leaseToken: params.leaseToken,
          signal: context.signal,
          timeoutMs: FULL_PAGE_CAPTURE_EXECUTION_BUDGET_MS,
          expectedUrl: params.expectedUrl,
          materializeDataSrc: params.materializeDataSrc,
          ...(params.format ? { format: params.format } : {}),
          ...(params.quality !== undefined ? { quality: params.quality } : {}),
        }
      );
    },
  });

  catalogue.register({
    name: 'anti.agent.cursor.click',
    description: 'Alias for browser.agent-click',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, trusted: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClick(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.cursor.type',
    description: 'Alias for browser.agent-type',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, trusted: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['text'] },
    execute: (params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentType(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.cursor.move',
    description: 'Alias for browser.agent-move',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentMove(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.cursor.hover',
    description: 'Alias for browser.agent-hover: returns executionTier and verified hoverActive',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHover(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.cursor.scroll',
    description: 'Alias for browser.agent-scroll',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentScroll(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.cursor.highlight',
    description: 'Alias for browser.agent-highlight',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, color: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { selector?: string; ref?: string; label?: string; color?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentHighlight(params, context.browserTarget, context.signal),
  });

  catalogue.register({
    name: 'anti.agent.cursor.clear',
    description: 'Alias for browser.agent-clear',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } } },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => browser.agentClear(params, context.browserTarget),
  });
  catalogue.register({
    name: 'anti.browser.dialog',
    description: "Read or answer the JavaScript dialog (alert / confirm / beforeunload) the bound tab shows. While one is open every other operation on the tab is refused with DIALOG_OPEN; action 'get' reads it, 'accept' / 'dismiss' answer it. The native box left on screen is closed only when it is provably this dialog's (result nativeBox says which); a background tab's box is never closed.",
    risk: 'write',
    requiresBrowserTarget: true,
    // Unbounded, not viewport-gate: the click that opened the dialog may still hold the viewport lock.
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'unbounded', timeoutMs: 15_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'accept', 'dismiss'] },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['action'],
    },
    execute: (params: { action: 'get' | 'accept' | 'dismiss'; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.jsDialog(params, context.browserTarget as BrowserTarget),
  });

  catalogue.register({
    name: 'anti.agent.sequence',
    description: 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: sequenceInputSchema(),
    execute: (params: SequenceParams, context) =>
      browser.sequence(normalizeSequenceParams('anti.agent.sequence', params), context.browserTarget, context.signal),
  });
  catalogue.register({
    name: 'browser.inspect_styles',
    description: 'Inspect computed CSS styles, box model, typography, layout, and CSS variables for an element (supports @ref or CSS selector)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectStyles(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.styles',
    description: 'Alias for browser.inspect_styles',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectStyles(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.inspect_layout',
    description: 'Inspect layout, box model (padding, margin, border), bounding rects, and typography for one or multiple selectors in a single atomic pass',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Single CSS selector to inspect' },
        selectors: { type: 'array', items: { type: 'string' }, description: 'Array of CSS selectors to inspect in a single pass' },
        tabId: { type: 'string', description: 'Optional tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
      },
    },
    execute: (params: { selector?: string; selectors?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectLayout(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.layout',
    description: 'Alias for browser.inspect_layout',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Single CSS selector to inspect' },
        selectors: { type: 'array', items: { type: 'string' }, description: 'Array of CSS selectors to inspect in a single pass' },
        tabId: { type: 'string', description: 'Optional tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
      },
    },
    execute: (params: { selector?: string; selectors?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectLayout(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.inspect_font',
    description: 'Inspect 100% accurate rendered typography & platform fonts (Skia/HarfBuzz via CDP) with fallback detection and Vietnamese glyph analysis',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to inspect' },
        ref: { type: 'string', description: 'Semantic reference of the element (@e1..@eN)' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-pane ID' },
      },
    },
    execute: (params: { selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectFont(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.font',
    description: 'Alias for browser.inspect_font',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to inspect' },
        ref: { type: 'string', description: 'Semantic reference of the element (@e1..@eN)' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-pane ID' },
      },
    },
    execute: (params: { selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectFont(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.get-matched-styles',
    description: 'Retrieve low-level Chromium CDP CSS.getMatchedStylesForNode response containing matched CSS rules and stylesheet IDs',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number', description: 'CDP DOM Node ID if already known' },
        selector: { type: 'string', description: 'CSS selector of the element' },
        ref: { type: 'string', description: 'Semantic reference of the element (@e1..@eN)' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-pane ID' },
      },
    },
    execute: (params: { nodeId?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.getMatchedStylesForNode(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.cdp_matched_styles',
    description: 'Alias for browser.get-matched-styles',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number', description: 'CDP DOM Node ID if already known' },
        selector: { type: 'string', description: 'CSS selector of the element' },
        ref: { type: 'string', description: 'Semantic reference of the element (@e1..@eN)' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-pane ID' },
      },
    },
    execute: (params: { nodeId?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.getMatchedStylesForNode(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.theme.resolve_element',
    description: 'Map rendered DOM element to local theme Liquid source template/snippet files with tri-state evidence and 2-signal confidence verification',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the target element' },
        ref: { type: 'string', description: 'Semantic reference of the target element (@e1..@eN)' },
        workspaceRoot: { type: 'string', description: 'Optional local theme workspace directory' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-pane ID' },
      },
    },
    execute: async (params: { selector?: string; ref?: string; workspaceRoot?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => {
      let root = params.workspaceRoot;
      if (!root) {
        const candidate = getWorkspaceRoot ? resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot) : process.cwd();
        if (!candidate || candidate.includes('.antifan-data')) {
          const cwd = process.cwd();
          if (fs.existsSync(path.join(cwd, 'layout', 'theme.liquid')) || fs.existsSync(path.join(cwd, 'templates')) || fs.existsSync(path.join(cwd, 'sections'))) {
            root = cwd;
          } else {
            root = candidate;
          }
        } else {
          root = candidate;
        }
      }
      let classes: string[] = [];
      const attributes: Record<string, string> = {};
      const commentHints: string[] = [];
      const rawRef = typeof params.ref === 'string' ? params.ref.trim() : '';
      const rawSelector = typeof params.selector === 'string' ? params.selector.trim() : '';
      if (!rawRef && !rawSelector) {
        throw new CapabilityError('INVALID_ARGUMENT', 'anti.theme.resolve_element needs a selector or a snapshot ref (@eN) naming the element to map');
      }
      const normalizedRef = rawRef ? (rawRef.startsWith('@') ? rawRef : `@${rawRef}`) : '';
      // Snapshots mint refs as "@e" + an integer; anything else would be spliced into an
      // attribute selector and could match an unrelated element.
      if (normalizedRef && !/^@e\d+$/.test(normalizedRef)) {
        throw new CapabilityError('INVALID_ARGUMENT', `ref "${rawRef}" is not a snapshot ref (expected @eN, e.g. @e12)`);
      }
      // anti.inspect.snapshot keeps refs in the semantic registry (traversal path + fingerprint),
      // not on the DOM, so the page script walks the descriptor's path. The registry's
      // REF_STALE / REF_NOT_FOUND propagate; a host without a registry falls back to refs
      // stamped as data-antifan-ref="@eN" by the legacy snapshot.
      const descriptor = normalizedRef
        ? browser.semanticRefDescriptor(context.browserTarget as BrowserTarget, normalizedRef, params?.tabId, params?.paneId)
        : null;

      let elementMissing = false;
      try {
        const inspectScript = `(() => {
          const el = ${buildRefLookupExpression(descriptor ? { path: descriptor.path, tag: descriptor.fingerprint?.tag || null, id: descriptor.fingerprint?.id || descriptor.id || null } : null, normalizedRef, rawSelector)};
          if (!el) return null;
          const cls = typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : [];
          const attrs = {};
          for (let i = 0; i < el.attributes.length; i++) {
            const a = el.attributes[i];
            if (a.name.startsWith('data-') || a.name === 'id' || a.name === 'class') {
              attrs[a.name] = a.value;
            }
          }
          return { classes: cls, attributes: attrs, tagName: el.tagName.toLowerCase() };
        })()`;
        const raw = await browser.eval(context.browserTarget as BrowserTarget, inspectScript, params?.tabId, params?.paneId);
        if (raw === null) {
          elementMissing = true;
        } else if (raw && typeof raw === 'object') {
          const typedRaw = raw as { classes?: string[]; attributes?: Record<string, string> };
          if (Array.isArray(typedRaw.classes)) classes = typedRaw.classes;
          if (typedRaw.attributes) Object.assign(attributes, typedRaw.attributes);
        }
      } catch {}
      // A definitive miss must not degrade into a confident-looking mapping built from no evidence.
      if (elementMissing) {
        throw normalizedRef
          ? new CapabilityError('REF_NOT_FOUND', `No live element matches ref ${normalizedRef}${rawSelector ? ` and selector "${rawSelector}" matched nothing` : ''}; take a fresh anti.inspect.snapshot`)
          : new CapabilityError('SELECTOR_NOT_FOUND', `Selector "${rawSelector}" matched no element on the bound tab`);
      }

      return ThemeSourceMapper.mapElementToSource(root, {
        classes,
        attributes,
        commentHints,
      });
    },
  });

  catalogue.register({
    name: 'anti.inspect.matched_styles',
    description: 'Retrieve causality-aware CSS matched rules categorized into ACTIVE vs OVERRIDDEN with specificity calculation and Tiered DoD (PASS vs STRONG PASS)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number', description: 'CDP DOM Node ID if already known' },
        selector: { type: 'string', description: 'CSS selector of the target element' },
        ref: { type: 'string', description: 'Semantic reference of the target element (@e1..@eN)' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split-pane ID' },
        stylesheetUrlMap: { type: 'object', description: 'Optional mapping of styleSheetId to source URL' },
      },
    },
    execute: async (params: { nodeId?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile'; stylesheetUrlMap?: Record<string, string> }, context) => {
      const rawCdp = await browser.getMatchedStylesForNode(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId);
      return CssCascadeAnalyzer.analyze(rawCdp, params?.stylesheetUrlMap);
    },
  });

  catalogue.register({
    name: 'anti.inspect.responsive_matrix',
    description: 'Probe 5 standard responsive breakpoints (320, 375, 768, 1024, 1440px) in one atomic call, disambiguating documentOverflowX from targetOverflowX',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector of the component to measure across breakpoints' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
        customBreakpoints: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional custom breakpoints ({ id, name, width, height, mobile, deviceScaleFactor })',
        },
        viewports: VIEWPORTS_SCHEMA,
      },
    },
    execute: async (
      params: {
        selector?: string;
        tabId?: string;
        viewports?: unknown;
        customBreakpoints?: Array<{
          id?: string;
          name?: string;
          width?: number;
          height?: number;
          mobile?: boolean;
          deviceScaleFactor?: number;
        }>;
      },
      context
    ) => {
      let normalizedCustomBreakpoints: ResponsiveBreakpointOption[] | undefined;
      const viewports = parseViewportsParam(params.viewports, 'anti.inspect.responsive_matrix');
      if (Array.isArray(params.customBreakpoints) && params.customBreakpoints.length > 0) {
        const seenIds: Record<string, true> = Object.create(null);
        normalizedCustomBreakpoints = params.customBreakpoints.map((bp, idx) => {
          if (
            !bp ||
            typeof bp !== 'object' ||
            typeof bp.width !== 'number' ||
            !Number.isFinite(bp.width) ||
            bp.width < 240 ||
            bp.width > 3840
          ) {
            const badWidth = bp && typeof bp === 'object' && 'width' in bp ? String(bp.width) : 'undefined';
            throw new CapabilityError(
              'INVALID_ARGUMENT',
              `customBreakpoints width ${badWidth} is out of range; expected a finite width between 240 and 3840`
            );
          }
          const width = Math.round(bp.width);
          const height =
            typeof bp.height === 'number' && Number.isFinite(bp.height) && bp.height >= 240 && bp.height <= 3840
              ? Math.round(bp.height)
              : width < 768
                ? 667
                : width < 1024
                  ? 1024
                  : width < 1440
                    ? 768
                    : 900;
          const mobile = typeof bp.mobile === 'boolean' ? bp.mobile : width < 768;
          const deviceScaleFactor =
            typeof bp.deviceScaleFactor === 'number' && Number.isFinite(bp.deviceScaleFactor) && bp.deviceScaleFactor > 0
              ? bp.deviceScaleFactor
              : width <= 1024
                ? 2
                : 1;
          const baseId = typeof bp.id === 'string' && bp.id.trim().length > 0 ? bp.id.trim() : `bp-${width}`;
          const modeTag = mobile ? 'mobile' : 'desktop';
          let id = baseId;
          if (seenIds[id]) {
            id = `${baseId}-${modeTag}`;
          }
          let suffix = idx + 1;
          while (seenIds[id]) {
            id = `${baseId}-${modeTag}-${suffix}`;
            suffix += 1;
          }
          seenIds[id] = true;
          return {
            id,
            name: typeof bp.name === 'string' && bp.name.trim().length > 0 ? bp.name.trim() : `${width}px`,
            width,
            height,
            mobile,
            deviceScaleFactor,
          };
        });
      }
      // Only the declared inputs go through: `perWidthScript` runs in the page and is not a caller option.
      const rawRes = await browser.responsiveCheck(
        {
          selector: params.selector,
          tabId: params.tabId,
          ...(normalizedCustomBreakpoints ? { customBreakpoints: normalizedCustomBreakpoints } : {}),
          ...(viewports ? { viewports } : {}),
        },
        context.browserTarget as BrowserTarget
      );
      const typedRaw = (rawRes && typeof rawRes === 'object') ? (rawRes as Record<string, unknown>) : {};
      const isOk = typedRaw.ok !== false;
      const breakpoints = (typedRaw.breakpoints && typeof typedRaw.breakpoints === 'object')
        ? (typedRaw.breakpoints as Record<string, Record<string, unknown>>)
        : {};
      const bpEntries = Object.values(breakpoints);
      const expectedCount = normalizedCustomBreakpoints ? normalizedCustomBreakpoints.length : 5 + (viewports?.length ?? 0);

      const hasDocOverflow = bpEntries.some((b) => b.documentOverflowX === true || b.hasHorizontalOverflow === true);
      const hasTargetOverflow = bpEntries.some((b) => b.targetOverflowX === true);
      const allMeasured = isOk
        && bpEntries.length >= expectedCount
        && bpEntries.every((b) => b.emulationApplied !== false
          && (typeof b.documentOverflowX === 'boolean' || typeof b.hasHorizontalOverflow === 'boolean'));

      return createThemeEvidenceEnvelope({
        success: isOk,
        evidenceQuality: allMeasured ? 'HIGH' : 'LOW',
        data: rawRes,
        signals: {
          hasDocOverflow,
          hasTargetOverflow,
          allBreakpointsTested: allMeasured,
        },
      });
    },
  });

  catalogue.register({
    name: 'browser.style_override',
    description: 'Safely inject, update, remove, or clear temporary CSS overrides in page for non-destructive layout/style testing',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string', description: 'CSS rules to inject or update' },
        scopeId: { type: 'string', description: 'Scope identifier for this override (default: "default")' },
        action: { type: 'string', enum: ['apply', 'remove', 'clear'], description: 'Action: apply, remove, or clear' },
        tabId: { type: 'string', description: 'Optional tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
      },
    },
    execute: (params: { css?: string; scopeId?: string; action?: 'apply' | 'remove' | 'clear'; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.styleOverride(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.browser.style_override',
    description: 'Alias for browser.style_override',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string', description: 'CSS rules to inject or update' },
        scopeId: { type: 'string', description: 'Scope identifier for this override (default: "default")' },
        action: { type: 'string', enum: ['apply', 'remove', 'clear'], description: 'Action: apply, remove, or clear' },
        tabId: { type: 'string', description: 'Optional tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
      },
    },
    execute: (params: { css?: string; scopeId?: string; action?: 'apply' | 'remove' | 'clear'; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.styleOverride(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.theme.preview_css',
    description: 'Alias for browser.style_override',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string', description: 'CSS rules to inject or update' },
        scopeId: { type: 'string', description: 'Scope identifier for this override (default: "default")' },
        action: { type: 'string', enum: ['apply', 'remove', 'clear'], description: 'Action: apply, remove, or clear' },
        tabId: { type: 'string', description: 'Optional tab ID' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
      },
    },
    execute: (params: { css?: string; scopeId?: string; action?: 'apply' | 'remove' | 'clear'; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.styleOverride(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.inspect_region',
    description: 'Inspect spatial region bounds, collecting intersecting visible DOM elements with coordinates and z-index',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        selector: { type: 'string' },
        ref: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectRegion(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.region',
    description: 'Alias for browser.inspect_region',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        selector: { type: 'string' },
        ref: { type: 'string' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.inspectRegion(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'browser.trace_interaction',
    description: 'Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout shifts',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] },
        selector: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
        deltaY: { type: 'number' },
        settleMs: { type: 'number' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        motionSpec: { type: 'object', description: 'Expected motion specification (duration, easing, properties, amplitude)' },
      },
      required: ['action'],
    },
    execute: (params: { action: 'click' | 'hover' | 'focus' | 'type' | 'scroll'; selector?: string; ref?: string; text?: string; deltaY?: number; settleMs?: number; tabId?: string; paneId?: 'desktop' | 'mobile'; motionSpec?: any }, context) =>
      browser.traceInteraction(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId, context.signal),
  });

  catalogue.register({
    name: 'anti.trace.interaction',
    description: 'Alias for browser.trace_interaction',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] },
        selector: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
        deltaY: { type: 'number' },
        settleMs: { type: 'number' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        motionSpec: { type: 'object', description: 'Expected motion specification (duration, easing, properties, amplitude)' },
      },
      required: ['action'],
    },
    execute: (params: { action: 'click' | 'hover' | 'focus' | 'type' | 'scroll'; selector?: string; ref?: string; text?: string; deltaY?: number; settleMs?: number; tabId?: string; paneId?: 'desktop' | 'mobile'; motionSpec?: any }, context) =>
      browser.traceInteraction(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId, context.signal),
  });
  catalogue.register({
    name: 'browser.visual_compare',
    description: 'Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking, and configurable tolerance',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      lane: 'short-passive',
      timeoutMs: VISUAL_COMPARE_EXECUTION_BUDGET_MS + VISUAL_COMPARE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: VISUAL_COMPARE_CANCELLATION_ACK_MS,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        baselineScreenshotRef: { type: 'string' },
        baselineRef: { type: 'string', description: 'Promoted baseline authority reference ID (Phase 6)' },
        comparisonTabId: { type: 'string' },
        tolerance: { type: 'number' },
        selector: { type: 'string' },
        clipRect: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        maskSelectors: {
          type: 'array',
          items: { type: 'string' },
        },
        maskOptionalSelectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additive: selectors that MAY match zero elements without failing the compare',
        },
        normalizeScroll: { type: 'boolean' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        fullPage: { type: 'boolean', description: 'Capture entire document scroll height for full-page visual comparison' },
        useDefaultWidgetMasks: { type: 'boolean', description: 'Apply the implicit optional mask set (DEFAULT_STOREFRONT_WIDGETS plus iframe[id]). Default true; final fidelity runs pass false so generic selectors cannot hide first-party content' },
        leaseToken: { type: 'string', description: 'Evidence-run artifact lease token from artifact.preflight; required while the run holds an exclusive lease' },
        trackedSelectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit list of component selectors to track for structural parity and cardinality authority',
        },
        heightTolerance: { type: 'number', description: 'Maximum acceptable height delta ratio (0.0 to 1.0) before triggering STRUCTURAL_TRUNCATION_DETECTED. Default 0.10' },
        allowHeightDrift: { type: 'boolean', description: 'When true, bypasses the hard STRUCTURAL_TRUNCATION failure gate and proceeds to section/pixel diff evaluation' },
        maxGeometryDeltaPx: { type: 'number', description: 'Maximum acceptable structural component geometry shift in pixels. On responsive mobile/tablet, defaults to 16px when pixel diff matches' },
        expectedUrl: { type: 'string', description: 'Expected route URL for target side. Load-bearing for a verdict: the route gate is fail-closed, so when no side declares an expectation the compare settles INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of returning PASS/FAIL, and retrying without this parameter reproduces the identical refusal' },
        expectedTargetUrl: { type: 'string', description: 'Expected route URL for target side. Load-bearing for a verdict: the route gate is fail-closed, so when no side declares an expectation the compare settles INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of returning PASS/FAIL, and retrying without this parameter reproduces the identical refusal' },
        expectedBaselineUrl: { type: 'string', description: 'Expected route URL for baseline side. Load-bearing for a verdict when comparing against a live comparison tab: the route gate is fail-closed, so omitting it settles the compare INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of returning PASS/FAIL' },
      },
    },
    execute: (params: { baselineScreenshotRef?: string; baselineRef?: string; comparisonTabId?: string; tolerance?: number; selector?: string; clipRect?: { x: number; y: number; width: number; height: number }; maskSelectors?: string[]; maskOptionalSelectors?: string[]; normalizeScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile'; fullPage?: boolean; useDefaultWidgetMasks?: boolean; leaseToken?: string; trackedSelectors?: string[]; heightTolerance?: number; allowHeightDrift?: boolean; maxGeometryDeltaPx?: number; expectedUrl?: string; expectedTargetUrl?: string; expectedBaselineUrl?: string }, context) =>
      browser.visualCompare(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId, context.signal),
  });

  catalogue.register({
    name: 'anti.visual.compare',
    description: 'Alias for browser.visual_compare with element selection, dynamic masking, and subpixel stabilization',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      lane: 'short-passive',
      timeoutMs: VISUAL_COMPARE_EXECUTION_BUDGET_MS + VISUAL_COMPARE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: VISUAL_COMPARE_CANCELLATION_ACK_MS,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        baselineScreenshotRef: { type: 'string' },
        baselineRef: { type: 'string', description: 'Promoted baseline authority reference ID (Phase 6)' },
        comparisonTabId: { type: 'string' },
        tolerance: { type: 'number' },
        selector: { type: 'string' },
        clipRect: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        maskSelectors: {
          type: 'array',
          items: { type: 'string' },
        },
        maskOptionalSelectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additive: selectors that MAY match zero elements without failing the compare',
        },
        normalizeScroll: { type: 'boolean' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        fullPage: { type: 'boolean', description: 'Capture entire document scroll height for full-page visual comparison' },
        useDefaultWidgetMasks: { type: 'boolean', description: 'Apply the implicit optional mask set (DEFAULT_STOREFRONT_WIDGETS plus iframe[id]). Default true; final fidelity runs pass false so generic selectors cannot hide first-party content' },
        leaseToken: { type: 'string', description: 'Evidence-run artifact lease token from artifact.preflight; required while the run holds an exclusive lease' },
        trackedSelectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit list of component selectors to track for structural parity and cardinality authority',
        },
        heightTolerance: { type: 'number', description: 'Maximum acceptable height delta ratio (0.0 to 1.0) before triggering STRUCTURAL_TRUNCATION_DETECTED. Default 0.10' },
        allowHeightDrift: { type: 'boolean', description: 'When true, bypasses the hard STRUCTURAL_TRUNCATION failure gate and proceeds to section/pixel diff evaluation' },
        maxGeometryDeltaPx: { type: 'number', description: 'Maximum acceptable structural component geometry shift in pixels. On responsive mobile/tablet, defaults to 16px when pixel diff matches' },
        expectedUrl: { type: 'string', description: 'Expected route URL for target side. Load-bearing for a verdict: the route gate is fail-closed, so when no side declares an expectation the compare settles INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of returning PASS/FAIL, and retrying without this parameter reproduces the identical refusal' },
        expectedTargetUrl: { type: 'string', description: 'Expected route URL for target side. Load-bearing for a verdict: the route gate is fail-closed, so when no side declares an expectation the compare settles INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of returning PASS/FAIL, and retrying without this parameter reproduces the identical refusal' },
        expectedBaselineUrl: { type: 'string', description: 'Expected route URL for baseline side. Load-bearing for a verdict when comparing against a live comparison tab: the route gate is fail-closed, so omitting it settles the compare INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of returning PASS/FAIL' },
      },
    },
    execute: (params: { baselineScreenshotRef?: string; baselineRef?: string; comparisonTabId?: string; tolerance?: number; selector?: string; clipRect?: { x: number; y: number; width: number; height: number }; maskSelectors?: string[]; maskOptionalSelectors?: string[]; normalizeScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile'; fullPage?: boolean; useDefaultWidgetMasks?: boolean; leaseToken?: string; trackedSelectors?: string[]; heightTolerance?: number; allowHeightDrift?: boolean; maxGeometryDeltaPx?: number; expectedUrl?: string; expectedTargetUrl?: string; expectedBaselineUrl?: string }, context) =>
      browser.visualCompare(context.browserTarget as BrowserTarget, context.runId || 'run-default', context.attemptId || 'att-default', params, params?.tabId, params?.paneId, context.signal),
  });
  catalogue.register({
    name: 'browser.promote-baseline',
    description: 'Canonically capture the current tab (or specified tabId) via CDP, stage screenshot artifact, and promote to an authoritative, immutable visual baseline reference (Phase 6, V-22)',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to capture and promote (defaults to bound tab)' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        fullPage: { type: 'boolean', description: 'Capture the entire document as the promoted baseline; clipRect takes precedence when provided' },
        clipRect: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        materializeDataSrc: { type: 'boolean', description: 'Swap data-src/data-srcset into live sources before capture so custom lazy loaders (e.g. Pancake) promote in one call; mutates the page — opt-in only' },
      },
    },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; fullPage?: boolean; clipRect?: { x: number; y: number; width: number; height: number }; materializeDataSrc?: boolean }, context) => {
      return browser.promoteBaseline(context, params);
    },
  });

  catalogue.register({
    name: 'anti.visual.promote_baseline',
    description: 'Alias for browser.promote-baseline: canonically capture and promote current tab to an authoritative visual baseline reference',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to capture and promote (defaults to bound tab)' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        fullPage: { type: 'boolean', description: 'Capture the entire document as the promoted baseline; clipRect takes precedence when provided' },
        clipRect: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        materializeDataSrc: { type: 'boolean', description: 'Swap data-src/data-srcset into live sources before capture so custom lazy loaders (e.g. Pancake) promote in one call; mutates the page — opt-in only' },
      },
    },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; fullPage?: boolean; clipRect?: { x: number; y: number; width: number; height: number }; materializeDataSrc?: boolean }, context) => {
      return browser.promoteBaseline(context, params);
    },
  });

  // ─── Semantic Sensory & Parity Capabilities ───
  catalogue.register({
    name: 'anti.media.freeze',
    description: 'Pause visual media and CSS animations without suspending application requestAnimationFrame scheduling; optional slider normalization is restored on unfreeze',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        freeze: { type: 'boolean', description: 'True to freeze media and pause animations; false to resume' },
        normalizeSliders: { type: 'boolean', description: 'Explicit opt-in to normalize sliders/carousels (defaults to false to preserve storefront layout)' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { freeze?: boolean; normalizeSliders?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.freezeMedia(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });
  catalogue.register({
    name: 'browser.media-freeze',
    description: 'Alias for anti.media.freeze',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        freeze: { type: 'boolean' },
        normalizeSliders: { type: 'boolean', description: 'Explicit opt-in to normalize sliders/carousels (defaults to false to preserve storefront layout)' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
    },
    execute: (params: { freeze?: boolean; normalizeSliders?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) =>
      browser.freezeMedia(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });
  catalogue.register({
    name: 'anti.inspect.page_inventory',
    description: 'Scan entire physical page structure from y=0 to scrollHeight, returning list of all sections, coordinates, heights, and layout groups (chống sót header/footer/newsletter). Refuses a tab with no laid-out surface unless allowDegradedSurface is set.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch; the page is not laid out, so every measured height is 0)' },
      },
    },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; allowDegradedSurface?: boolean }, context) =>
      browser.pageInventory(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });
  catalogue.register({
    name: 'anti.layout.compare_candidates',
    description: 'Compare 1-5 CSS candidates for one section beside the current design (baseline) at up to 3 widths, sequentially in the bound tab: apply CSS in memory, settle, capture the section, measure, remove. Returns per-width section captures and one contact sheet per width (columns left-to-right: baseline, then candidates in order; colour bar per column), deterministic breaks that disqualify (page overflow, section spill, clipped text, overlapping text) and penalties (contrast, tap targets, type-scale sprawl, misaligned edges, off-grid gaps), a ranking and a recommendation. Nothing is written to theme files; the stylesheet is removed and the viewport restored on every exit path.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate', timeoutMs: 120_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        scopeSelector: { type: 'string', description: 'CSS selector of the section being redesigned' },
        candidates: {
          type: 'array',
          description: '1-5 candidates; css is injected after the theme stylesheets, so it overrides them',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' }, css: { type: 'string' } },
            required: ['id', 'css'],
          },
        },
        breakpoints: { type: 'array', items: { type: 'number' }, description: 'CSS widths, at most 3 (default [375, 1440])' },
        settleMs: { type: 'number', description: 'Wait after applying each candidate (default 350, 100-2000)' },
        includeBaseline: { type: 'boolean', description: 'Include the current design as the first column (default true)' },
      },
      required: ['scopeSelector', 'candidates'],
    },
    execute: (params: Record<string, unknown>, context) =>
      browser.compareCandidates(
        context.browserTarget as BrowserTarget,
        params as unknown as Parameters<BrowserControlPort['compareCandidates']>[1],
        { runId: context.runId || 'run-unbound', attemptId: context.attemptId || 'attempt-unbound', signal: context.signal }
      ),
  });
  catalogue.register({
    name: 'anti.qa.state_matrix',
    description: 'Drive overlays (cart/menu/filter drawers, modals, quickview, dropdowns, mega menus) through OPEN -> MEASURE -> CLOSE with trusted CDP input. Open: visible, opacity >= 0.95, pointer-events, minimum size, inside viewport, not clipped/occluded, no content spill, scroll lock + focus inside + close control (dialogs), plus contrast/tap grading inside the panel. Close: Escape, close control and backdrop each from a fresh open, then scroll lock released and focus returned. Failure codes include MODAL_UNSTYLED (critical for drawers/modals: UA-default fonts, buttons, links, tables or zero panel padding) and CLOSE_ESCAPE_UNMEASURED (warning: the page was unfocused or the key was not delivered, so Escape was not graded). Safe mode always on: anchor navigation and form submits are blocked; add-to-cart/submit/checkout/foreign-origin controls are never triggers. Auto-discovers triggers or takes explicit {selector, panelSelector?, closeSelector?, kind?}.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate', timeoutMs: 120_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        triggers: {
          type: 'array',
          description: 'Explicit overlays to exercise; omit to auto-discover from aria-controls / aria-haspopup / data-*-open / data-action="open-*"',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              panelSelector: { type: 'string' },
              closeSelector: { type: 'string' },
              kind: { type: 'string', enum: ['drawer', 'modal', 'dropdown', 'megamenu'] },
            },
            required: ['selector'],
          },
        },
        maxTriggers: { type: 'number', description: 'Overlays to exercise (default 8, max 12)' },
        settleMs: { type: 'number', description: 'Wait after each open/close input (default 450, 100-2000)' },
        closeMethods: { type: 'array', items: { type: 'string', enum: ['escape', 'close-button', 'backdrop'] } },
        gradeVisualQuality: { type: 'boolean', description: 'Grade contrast and tap targets inside each open panel (default true)' },
        autoPopulate: { type: 'string', enum: ['pdp'], description: 'pdp: also open size-guide / quick-view / share / review openers' },
      },
    },
    execute: (params: Record<string, unknown>, context) =>
      browser.stateMatrix(context.browserTarget as BrowserTarget, params as Parameters<BrowserControlPort['stateMatrix']>[1], context.signal),
  });
  catalogue.register({
    name: 'anti.qa.visual_quality',
    description: 'Measure WCAG AA text contrast (text over images/gradients reported as indeterminate), mobile tap targets (<24px WCAG 2.2 minimum, pseudo-element hit area included; inline links exempt) and floating widgets or transparent fixed layers covering text/controls at page top and page end. Findings are warnings with selector, rect and measured values; scroll position is restored.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        mobile: { type: 'boolean', description: 'Force mobile tap-target rules on/off (default: viewport width <= 767px)' },
        skipPageEnd: { type: 'boolean', description: 'Check floating widgets only at the current scroll position, so the scan never scrolls' },
        scopeSelector: { type: 'string', description: 'Grade contrast and tap targets inside this subtree only (e.g. an open drawer)' },
        allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch)' },
      },
    },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; mobile?: boolean; skipPageEnd?: boolean; scopeSelector?: string; allowDegradedSurface?: boolean }, context) =>
      browser.visualQuality(context.browserTarget as BrowserTarget, params),
  });
  catalogue.register({
    name: 'browser.page-inventory',
    description: 'Alias for anti.inspect.page_inventory',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
        allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch; the page is not laid out, so every measured height is 0)' },
      },
    },
    execute: (params: { tabId?: string; paneId?: 'desktop' | 'mobile'; allowDegradedSurface?: boolean }, context) =>
      browser.pageInventory(context.browserTarget as BrowserTarget, params, params?.tabId, params?.paneId),
  });

  catalogue.register({
    name: 'anti.inspect.style_diff',
    description: 'Compare computed CSS styles and box-model metrics between elements on two tabs (or two selectors)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of target element on tab 1' },
        comparisonSelector: { type: 'string', description: 'CSS selector on tab 2 (defaults to selector)' },
        tabId: { type: 'string' },
        comparisonTabId: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' }, description: 'CSS properties to compare' },
      },
      required: ['selector'],
    },
    execute: (params: { selector: string; comparisonSelector?: string; tabId?: string; comparisonTabId?: string; properties?: string[] }, context) =>
      browser.styleDiff(context.browserTarget as BrowserTarget, params),
  });

  catalogue.register({
    name: 'anti.spec.validate_gate',
    description: 'Validate HTML Specification against target page to certify HTML_SPEC_READY status before theme compilation',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
    inputSchema: {
      type: 'object',
      properties: {
        specTabId: { type: 'string', description: 'Actual tab ID of the HTML specification' },
        targetTabId: { type: 'string', description: 'Actual target tab ID (defaults to the bound tab)' },
        tolerance: { type: 'number', description: 'Visual/height tolerance percentage (default 5.0)' },
      },
      required: ['specTabId'],
    },
    execute: (params: { specTabId?: string; targetTabId?: string; tolerance?: number }, context) =>
      browser.validateSpecGate(context.browserTarget as BrowserTarget, params, context.signal),
  });

  // ─── Issue Register & Diagnostics Capabilities ───
  catalogue.register({
    name: 'anti.diagnostics.list_issues',
    description: 'List recorded issues, tool failures, and bypassed bugs from the durable issue register',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['OPEN', 'RESOLVED', 'BYPASSED'] },
        severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        limit: { type: 'number' },
      },
    },
    execute: (params: { status?: string; severity?: string; limit?: number }) => {
      const issues = IssueRegister.getInstance().list(params);
      return { totalCount: issues.length, issues };
    },
  });
  catalogue.register({
    name: 'antifan_list_issues',
    description: 'Alias for anti.diagnostics.list_issues',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: { type: 'object' },
    execute: (params: { status?: string; severity?: string; limit?: number }) => {
      const issues = IssueRegister.getInstance().list(params);
      return { totalCount: issues.length, issues };
    },
  });

  catalogue.register({
    name: 'anti.diagnostics.record_issue',
    description: 'Record an observed issue, error, or tool failure into the durable issue register',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string' },
        errorMessage: { type: 'string' },
        severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        errorCode: { type: 'string' },
        targetUrl: { type: 'string' },
        tabId: { type: 'string' },
        workaroundApplied: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['toolName', 'errorMessage'],
    },
    execute: (params: { toolName: string; errorMessage: string; severity?: 'P0' | 'P1' | 'P2' | 'P3'; errorCode?: string; targetUrl?: string; tabId?: string; workaroundApplied?: string; notes?: string }) => {
      const recorded = IssueRegister.getInstance().record({
        toolName: params.toolName,
        errorMessage: params.errorMessage,
        severity: params.severity || 'P2',
        errorCode: params.errorCode,
        targetUrl: params.targetUrl,
        tabId: params.tabId,
        workaroundApplied: params.workaroundApplied,
        status: params.workaroundApplied ? 'BYPASSED' : 'OPEN',
        notes: params.notes,
      });
      return { recorded: true, issue: recorded };
    },
  });

  catalogue.register({
    name: 'anti.diagnostics.resolve_issue',
    description: 'Mark an issue in the durable issue register as RESOLVED',
    risk: 'write',
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
    execute: (params: { id: string; notes?: string }) => {
      const resolved = IssueRegister.getInstance().resolve(params.id, params.notes);
      return { success: resolved };
    },
  });

  // ─── Native Google Sheet Extraction Capability ───
  catalogue.register({
    name: 'anti.sheet.extract',
    description: 'Directly extract row, range, or structured data from Google Sheets in <100ms via authenticated in-tab GViz protocol',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Actual Google Sheets tab ID (defaults to the bound tab)' },
        row: { type: 'number', description: '1-indexed target row number (e.g. 34)' },
        gid: { type: 'string', description: 'Optional sheet GID override' },
      },
    },
    execute: async (params: { tabId?: string; row?: number; gid?: string }, context) => {
      const targetTabId = params.tabId;
      const targetRow = typeof params.row === 'number' && params.row > 0 ? params.row : undefined;
      const script = `(async () => {
        try {
          const url = window.location.href;
          const matchId = url.match(/\\/spreadsheets\\/d\\/([a-zA-Z0-9-_]+)/);
          if (!matchId) return { success: false, error: 'Current tab is not a Google Spreadsheet' };
          const sheetId = matchId[1];
          const explicitGid = ${JSON.stringify(params.gid || '')};
          const matchGid = explicitGid || (url.match(/[#&]gid=([0-9]+)/) || [])[1] || '0';

          // headers=0: without it GViz guesses a header block and joins the first
          // rows' cells into one header row, so row N no longer means sheet row N.
          const gvizUrl = '/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:csv&headers=0&gid=' + matchGid;
          const res = await fetch(gvizUrl, { credentials: 'include' });
          if (!res.ok) return { success: false, status: res.status, error: 'GViz request returned HTTP ' + res.status };
          const csv = await res.text();

          function parseCsvRecords(text) {
            const rows = [];
            let row = [];
            let cur = '';
            let inQuotes = false;
            for (let i = 0; i < text.length; i++) {
              const c = text[i];
              if (c === '"') {
                if (inQuotes && text[i + 1] === '"') { cur += '"'; i++; }
                else { inQuotes = !inQuotes; }
              } else if (c === ',' && !inQuotes) {
                row.push(cur.trim());
                cur = '';
              } else if ((c === '\\r' || c === '\\n') && !inQuotes) {
                if (c === '\\r' && text[i + 1] === '\\n') i++;
                row.push(cur.trim());
                cur = '';
                // Blank rows inside the data stay: records[N - 1] is sheet row N.
                rows.push(row);
                row = [];
              } else {
                cur += c;
              }
            }
            if (cur.length > 0 || row.length > 0) {
              row.push(cur.trim());
              rows.push(row);
            }
            while (rows.length > 0 && !rows[rows.length - 1].some((cell) => cell.length > 0)) rows.pop();
            return rows;
          }

          const records = parseCsvRecords(csv);
          const headers = records[0] || [];

          if (${JSON.stringify(targetRow)}) {
            const rowIdx = ${JSON.stringify(targetRow)} - 1;
            if (records.length <= rowIdx) {
              return { success: false, error: 'Row ' + ${JSON.stringify(targetRow)} + ' exceeds total rows (' + records.length + ')' };
            }
            const cells = records[rowIdx];
            const rawRow = cells.join(' | ');
            const mapped = {};
            headers.forEach((h, idx) => {
              mapped[h || ('col_' + (idx + 1))] = cells[idx] || '';
            });
            return {
              success: true,
              sheetId,
              gid: matchGid,
              targetRow: ${JSON.stringify(targetRow)},
              totalRows: records.length,
              headers,
              data: mapped,
              raw: rawRow
            };
          }

          return {
            success: true,
            sheetId,
            gid: matchGid,
            totalRows: records.length,
            headers,
            rowsCount: records.length
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()`;

      return await browser.eval(context.browserTarget as BrowserTarget, script, targetTabId);
    },
  });
  catalogue.register({
    name: 'antifan_sheet_extract',
    description: 'Alias for anti.sheet.extract',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        row: { type: 'number' },
        gid: { type: 'string' },
      },
    },
    execute: (params: { tabId?: string; row?: number; gid?: string }, context) => {
      const extractCap = catalogue.get('anti.sheet.extract');
      if (!extractCap) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'anti.sheet.extract capability not found');
      return extractCap.execute(params, context);
    },
  });
  catalogue.register({
    name: 'anti.verification.record_claim',
    description: 'Record an agent or user claim into the durable register. All claims enter strictly as UNVERIFIED; callers cannot self-certify or pass forged verdicts.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      properties: {
        claim: { type: 'string' },
        category: { type: 'string', enum: ['INTERACTION', 'LAYOUT', 'RESPONSIVE', 'CUSTOM', 'VISUAL'] },
        actor: { type: 'string', enum: ['agent', 'user'] },
        tabId: { type: 'string' },
        selector: { type: 'string' },
        expectedHeight: { type: 'number', description: 'Expected full page scroll height in pixels for LAYOUT parity verification' },
        expectedSections: { type: 'number', description: 'Expected number of visual structural sections for LAYOUT parity verification' },
        tolerance: { type: 'number', description: 'Allowed tolerance ratio (e.g. 0.05 for 5%)' },
        proofObligations: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              metric: { type: 'string' },
              tolerance: { type: 'number' },
              critical: { type: 'boolean' },
              expected: {},
            },
            required: ['metric'],
          },
        },
        linkedIssueId: { type: 'string' },
      },
      required: ['claim', 'tabId', 'category'],
    },
    execute: async (
      params: {
        claim: string;
        category?: ClaimCategory;
        actor?: 'agent' | 'user';
        tabId: string;
        selector?: string;
        expectedHeight?: number;
        expectedSections?: number;
        tolerance?: number;
        proofObligations?: Array<{ id?: string; metric: string; tolerance?: number; critical?: boolean; expected?: unknown }>;
        linkedIssueId?: string;
      },
      context
    ) => {
      if (!context.browserTarget) {
        throw new CapabilityError('TARGET_MISMATCH', 'Browser target is required to record and baseline a verification claim.');
      }
      if (context.browserTarget.tabId && params.tabId && context.browserTarget.tabId !== params.tabId) {
        throw new CapabilityError('TARGET_MISMATCH', `Claim target tab '${params.tabId}' does not match authorized browser target '${context.browserTarget.tabId}'.`);
      }
      if (!params.claim || !params.claim.trim()) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Claim description cannot be empty.');
      }
      if (!params.tabId || !params.tabId.trim()) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Target tabId is required.');
      }
      if (!params.category || !['INTERACTION', 'LAYOUT', 'RESPONSIVE', 'CUSTOM', 'VISUAL'].includes(params.category)) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Claim category is required and must be one of: INTERACTION, LAYOUT, RESPONSIVE, CUSTOM, VISUAL.');
      }

      const validatedObligations: Array<{ id: string; metric: string; tolerance?: number; critical?: boolean; expected?: unknown }> = [];
      if (Array.isArray(params.proofObligations)) {
        if (params.proofObligations.length > 50) {
          throw new CapabilityError('INVALID_ARGUMENT', 'Exceeded maximum of 50 proof obligations per claim.');
        }
        for (let i = 0; i < params.proofObligations.length; i++) {
          const obl = params.proofObligations[i];
          if (!obl || typeof obl.metric !== 'string' || !obl.metric.trim()) {
            throw new CapabilityError('INVALID_ARGUMENT', `Obligation at index ${i} must have a non-empty metric string.`);
          }
          validatedObligations.push({
            id: obl.id || `obl-${i + 1}`,
            metric: obl.metric.trim(),
            tolerance: typeof obl.tolerance === 'number' ? obl.tolerance : undefined,
            expected: obl.expected,
            critical: Boolean(obl.critical),
          });
        }
      }

      if (params.category === 'CUSTOM') {
        if (ProofTemplateRegistry.isPurePresenceCheck(validatedObligations)) {
          throw new CapabilityError(
            'INVALID_ARGUMENT',
            'CUSTOM claims must include at least one discriminating behavioral, layout, or mutation metric; pure DOM presence checks (element_present:*) cannot prove completion.'
          );
        }
      } else {
        if (params.category === 'LAYOUT') {
          const customHeight = validatedObligations.find(
            (o) => o.id === 'obl-layout-height-parity' || o.metric === 'height_parity_delta'
          );
          const hasExpectedHeight =
            typeof params.expectedHeight === 'number' || typeof customHeight?.expected === 'number';
          if (!hasExpectedHeight) {
            throw new CapabilityError(
              'INVALID_ARGUMENT',
              'LAYOUT claims require expectedHeight (either via params.expectedHeight or within a height_parity_delta obligation) to establish a verifiable baseline.'
            );
          }
        }
        const augmented = ProofTemplateRegistry.augmentObligations(params.category, validatedObligations, {
          targetSelector: params.selector,
          expectedHeight: params.expectedHeight,
          expectedSections: params.expectedSections,
          tolerance: params.tolerance,
        });
        validatedObligations.length = 0;
        validatedObligations.push(...augmented);
      }
      const currentDocGen = browser.getDocumentGeneration(params.tabId) ?? 1;
      const currentMutationRev = browser.getMutationRevision ? (browser.getMutationRevision(params.tabId) ?? 1) : 1;
      const targetMutationRevision = params.category === 'INTERACTION' ? currentMutationRev + 1 : undefined;

      let interactionBaseline: InteractionBaseline | undefined;
      if (params.category === 'INTERACTION') {
        try {
          const sel = params.selector || '';
          interactionBaseline = (await browser.eval(
            context.browserTarget,
            `(() => {
              const sel = ${JSON.stringify(sel)};
              const el = sel ? document.querySelector(sel) : null;
              const hasActive = el ? (el.classList.contains('active') || el.classList.contains('open') || el.classList.contains('expanded') || el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-selected') === 'true') : false;
              const hasOverlay = Boolean(document.querySelector('.modal.open, .modal.active, .drawer.open, .drawer.active, [aria-modal="true"], dialog[open], .popup.show, .dropdown-menu.show'));
              return {
                selector: sel,
                hasActive,
                hasOverlay,
                classSnapshot: el ? el.className : '',
                url: window.location.href,
              };
            })()`,
            params.tabId
          )) as InteractionBaseline;
        } catch (err: unknown) {
          if (context.signal?.aborted) throw err;
          throw new CapabilityError(
            'TARGET_STALE',
            `Failed to capture live interaction baseline for INTERACTION claim: ${String(err)}`
          );
        }
        if (!interactionBaseline) {
          throw new CapabilityError('TARGET_STALE', 'Interaction baseline probe returned empty state.');
        }
      }

      const claimObj: VerificationClaim = {
        id: `CLM-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        claim: params.claim.trim(),
        actor: params.actor || 'agent',
        scope: { tabId: params.tabId.trim(), selector: params.selector },
        targetGeneration: currentDocGen,
        targetMutationRevision,
        interactionBaseline,
        proofObligations: validatedObligations,
      };

      const record = IssueRegister.getInstance().recordVerification({
        id: claimObj.id,
        claim: claimObj.claim,
        actor: claimObj.actor,
        scope: claimObj.scope,
        targetGeneration: claimObj.targetGeneration,
        targetMutationRevision: claimObj.targetMutationRevision,
        interactionBaseline: claimObj.interactionBaseline,
        proofObligations: claimObj.proofObligations,
        verdict: 'UNVERIFIED',
        linkedIssueId: params.linkedIssueId,
      });
      return record;
    },
  });

  catalogue.register({
    name: 'anti.verification.verify_claim',
    description: 'Authoritatively evaluate a registered claim against live browser ground-truth evidence. Computes verdict server-side via VerificationEvaluator.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'string' },
        witnessObservation: { type: 'string' },
        semanticFailureObservation: { type: 'string' },
      },
      required: ['claimId'],
    },
    execute: async (
      params: { claimId: string; witnessObservation?: string; semanticFailureObservation?: string },
      context
    ) => {
      const claim = IssueRegister.getInstance().getVerification(params.claimId);
      if (!claim) {
        throw new CapabilityError('INVALID_ARGUMENT', `Claim with ID '${params.claimId}' was not found in register.`);
      }

      if (!context.browserTarget) {
        throw new CapabilityError('TARGET_MISMATCH', 'Browser target is required for verification probe.');
      }
      if (context.browserTarget.tabId && claim.scope.tabId && context.browserTarget.tabId !== claim.scope.tabId) {
        throw new CapabilityError(
          'TARGET_MISMATCH',
          `Claim target tab '${claim.scope.tabId}' does not match authorized browser target '${context.browserTarget.tabId}'.`
        );
      }

      const target = context.browserTarget as BrowserTarget;
      const runId = context.runId || 'run-unbound';
      const attemptId = context.attemptId || 'attempt-unbound';
      const invocationId = 'invocationId' in context && typeof context.invocationId === 'string' && context.invocationId.trim()
        ? context.invocationId
        : undefined;
      if (receipts && !invocationId) {
        throw new CapabilityError('MCP_CONTEXT_REQUIRED', 'Receipt-enabled verification requires authenticated invocation identity.');
      }
      const receiptBinding: ReceiptBinding | undefined = receipts && invocationId
        ? {
            commandId: invocationId,
            promptDigest: digestText(`anti.verification.verify_claim:${claim.id}`),
            projectId: context.projectId,
            workspaceId: context.workspaceId,
            canonicalWorkspace: typeof getWorkspaceRoot === 'function' ? resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot) : process.cwd(),
            hostInstanceId: 'verification-engine',
            hostEpoch: 'hostEpoch' in context && typeof context.hostEpoch === 'number' ? context.hostEpoch : context.lease.hostEpoch,
            attemptId,
            backendSessionRef: `${'backendId' in context && typeof context.backendId === 'string' ? context.backendId : 'trusted'}:${runId}`,
          }
        : undefined;
      const previousLifecycle = resolvePreviousLifecycle(claim, runId);
      if (previousLifecycle?.state === 'STALEMATE' || previousLifecycle?.state === 'HALTED') {
        throw new CapabilityError('POLICY_DENIED', `Verification batch is ${previousLifecycle.state} and cannot be retried in the same run attempt.`, {
          claimId: claim.id,
          lifecycle: previousLifecycle,
        });
      }
      if (previousLifecycle?.state === 'VERIFIED' || previousLifecycle?.state === 'EXEMPTION_WAIVED') {
        if (receipts && receiptBinding) receipts.put(receiptBinding, 'completed', 'accepted-exact');
        return claim;
      }
      const tabId = claim.scope.tabId;
      const currentDocGen = browser.getDocumentGeneration(tabId) ?? 1;

      const samples: Array<{
        metric: string;
        actual: unknown;
        expected?: unknown;
        delta?: number;
        passed: boolean;
        message?: string;
      }> = [];

      for (const obl of claim.proofObligations) {
        if (context.signal?.aborted) {
          throw new CapabilityError('WAIT_ABORTED', 'Claim verification was aborted by execution control signal.');
        }
        try {
          if (obl.metric.startsWith('element_present:') || obl.metric.startsWith('dom.') || obl.metric === 'element.exists') {
            const selector = obl.metric.startsWith('element_present:')
              ? obl.metric.substring('element_present:'.length).trim() || claim.scope.selector || 'body'
              : claim.scope.selector || 'body';
            let exists = false;
            try {
              const waitResult = await browser.wait(
                target,
                { condition: 'selector', selector, tabId, timeoutMs: 1500 },
                tabId,
                undefined,
                context.signal
              );
              exists = Boolean(waitResult && waitResult.satisfied);
            } catch (err: unknown) {
              if (context.signal?.aborted || (err instanceof CapabilityError && err.code === 'WAIT_ABORTED')) {
                throw err;
              }
              exists = false;
            }
            samples.push({
              metric: obl.metric,
              actual: exists,
              expected: obl.expected ?? true,
              passed: exists === (obl.expected ?? true),
              message: exists ? `Element '${selector}' verified present in live DOM` : `Element '${selector}' not found in live DOM`,
            });
          } else if (obl.metric === 'observable_mutation_effect') {
            const targetMutationRev = claim.targetMutationRevision ?? 0;
            const currentMutationRev = browser.getMutationRevision ? (browser.getMutationRevision(tabId) ?? 1) : 1;
            const hasMutationAdvanced = currentMutationRev >= targetMutationRev;

            let currentState: InteractionBaseline | undefined;
            try {
              const selector = claim.scope.selector || '';
              currentState = (await browser.eval(
                target,
                `(() => {
                  const sel = ${JSON.stringify(selector)};
                  const el = sel ? document.querySelector(sel) : null;
                  const hasActive = el ? (el.classList.contains('active') || el.classList.contains('open') || el.classList.contains('expanded') || el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-selected') === 'true') : false;
                  const hasOverlay = Boolean(document.querySelector('.modal.open, .modal.active, .drawer.open, .drawer.active, [aria-modal="true"], dialog[open], .popup.show, .dropdown-menu.show'));
                  return {
                    selector: sel,
                    hasActive,
                    hasOverlay,
                    classSnapshot: el ? el.className : '',
                    url: window.location.href,
                  };
                })()`,
                tabId
              )) as InteractionBaseline;
            } catch (err: unknown) {
              if (context.signal?.aborted) throw err;
              currentState = undefined;
            }
            const baseline = claim.interactionBaseline;
            const domChanged = Boolean(baseline) && (
              Boolean(currentState?.hasActive) !== Boolean(baseline?.hasActive) ||
              Boolean(currentState?.hasOverlay) !== Boolean(baseline?.hasOverlay) ||
              String(currentState?.classSnapshot || '') !== String(baseline?.classSnapshot || '') ||
              String(currentState?.url || '') !== String(baseline?.url || '')
            );

            const hasActiveTransition = Boolean(currentState?.hasActive || currentState?.hasOverlay);
            const passed = hasMutationAdvanced && domChanged && hasActiveTransition;

            samples.push({
              metric: obl.metric,
              actual: { generationAdvanced: hasMutationAdvanced, domChanged, hasActiveTransition, targetMutationRev, currentMutationRev, currentState },
              expected: true,
              passed,
              message: passed
                ? `Observable mutation confirmed: state transitioned from baseline (classes: '${baseline?.classSnapshot || 'none'}', overlay: ${baseline?.hasOverlay}) to active state (classes: '${currentState?.classSnapshot || 'none'}', overlay: ${currentState?.hasOverlay})`
                : (!hasMutationAdvanced
                    ? `No new gesture or mutation observed since claim was recorded (target revision: ${targetMutationRev}, current: ${currentMutationRev})`
                    : (!domChanged
                        ? 'Target DOM element and overlay state are identical to pre-action baseline (no transition occurred)'
                        : 'State changed but target did not reach active or overlay state')),
            });
          } else if (obl.metric === 'no_layout_overflow_bleed') {
            let bleedDelta = 999;
            try {
              const overflowRes = await browser.eval(
                target,
                `Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)`,
                tabId
              );
              bleedDelta = typeof overflowRes === 'number' ? overflowRes : 999;
            } catch (err: unknown) {
              if (context.signal?.aborted) throw err;
              bleedDelta = 999;
            }
            const passed = bleedDelta <= 2;
            samples.push({
              metric: obl.metric,
              actual: bleedDelta,
              expected: 0,
              delta: bleedDelta,
              passed,
              message: passed ? 'Zero horizontal layout overflow bleed satisfied' : `Layout overflow bleed detected: ${bleedDelta}px`,
            });
          } else if (obl.metric === 'desktop_zero_overflow_bleed') {
            let passed = false;
            let msg = '';
            try {
              const resp = (await browser.responsiveCheck(tabId)) as Record<string, any>;
              const desktop = resp['desktop-laptop'];
              if (desktop && typeof desktop === 'object') {
                passed = !desktop.hasHorizontalOverflow;
                msg = passed
                  ? `Desktop (1440px) zero horizontal overflow confirmed (scrollW: ${desktop.scrollWidth}px, clientW: ${desktop.clientWidth}px)`
                  : `Desktop (1440px) layout overflow detected: scrollWidth ${desktop.scrollWidth}px > clientWidth ${desktop.clientWidth}px`;
              } else {
                passed = false;
                msg = 'Failed to obtain desktop emulation results from responsiveCheck';
              }
            } catch (err: unknown) {
              if (context.signal?.aborted) throw err;
              passed = false;
              msg = `Desktop responsive check failed: ${String(err)}`;
            }
            samples.push({
              metric: obl.metric,
              actual: passed,
              expected: true,
              passed,
              message: msg,
            });
          } else if (obl.metric === 'mobile_zero_overflow_bleed') {
            let passed = false;
            let msg = '';
            try {
              const resp = (await browser.responsiveCheck(tabId)) as Record<string, any>;
              const mobile = resp['mobile-iphone15'];
              if (mobile && typeof mobile === 'object') {
                passed = !mobile.hasHorizontalOverflow;
                msg = passed
                  ? `Mobile iPhone 15 (393px) zero horizontal overflow confirmed (scrollW: ${mobile.scrollWidth}px, clientW: ${mobile.clientWidth}px)`
                  : `Mobile iPhone 15 (393px) layout overflow detected: scrollWidth ${mobile.scrollWidth}px > clientWidth ${mobile.clientWidth}px`;
              } else {
                passed = false;
                msg = 'Failed to obtain mobile emulation results from responsiveCheck';
              }
            } catch (err: unknown) {
              if (context.signal?.aborted) throw err;
              passed = false;
              msg = `Mobile responsive check failed: ${String(err)}`;
            }
            samples.push({
              metric: obl.metric,
              actual: passed,
              expected: true,
              passed,
              message: msg,
            });
          } else if (obl.metric === 'section_inventory_count') {
            if (obl.expected === undefined || typeof obl.expected !== 'number') {
              samples.push({
                metric: obl.metric,
                actual: undefined,
                expected: undefined,
                passed: false,
                message: "Missing required 'expected' baseline for section_inventory_count obligation.",
              });
            } else {
              let count = 0;
              try {
                const inv = await browser.pageInventory(target, { tabId });
                count = Array.isArray(inv?.sections) ? inv.sections.length : 0;
              } catch (err: unknown) {
                if (context.signal?.aborted) throw err;
                count = 0;
              }
              const expected = obl.expected;
              const passed = count === expected;
              samples.push({
                metric: obl.metric,
                actual: count,
                expected,
                delta: Math.abs(count - expected),
                passed,
                message: passed ? `Section count matches expected (${count})` : `Section count mismatch: expected ${expected}, got ${count}`,
              });
            }
          } else if (obl.metric === 'height_parity_delta') {
            if (obl.expected === undefined || typeof obl.expected !== 'number') {
              samples.push({
                metric: obl.metric,
                actual: undefined,
                expected: undefined,
                passed: false,
                message: "Missing required 'expected' baseline for height_parity_delta obligation.",
              });
            } else {
              let scrollH = 0;
              try {
                const hRes = await browser.eval(target, `document.documentElement.scrollHeight`, tabId);
                scrollH = typeof hRes === 'number' ? hRes : 0;
              } catch (err: unknown) {
                if (context.signal?.aborted) throw err;
                scrollH = 0;
              }
              const expectedH = obl.expected;
              const delta = expectedH > 0 ? Math.abs(scrollH - expectedH) / expectedH : 0;
              const tolerance = obl.tolerance ?? 0.05;
              const passed = delta <= tolerance;
              samples.push({
                metric: obl.metric,
                actual: scrollH,
                expected: expectedH,
                delta,
                passed,
                message: passed
                  ? `Height parity within tolerance (${(delta * 100).toFixed(1)}% <= ${(tolerance * 100).toFixed(1)}%)`
                  : `Height parity delta exceeded: ${(delta * 100).toFixed(1)}% > ${(tolerance * 100).toFixed(1)}%`,
              });
            }
          } else if (obl.metric === 'touch_targets_actionable') {
            let actionable = false;
            try {
              const actRes = await browser.eval(
                target,
                `(() => {
                  const targets = Array.from(document.querySelectorAll('a, button, input, [role="button"]'));
                  if (targets.length === 0) return false;
                  return targets.some(t => {
                    const r = t.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                  });
                })()`,
                tabId
              );
              actionable = Boolean(actRes);
            } catch (err: unknown) {
              if (context.signal?.aborted) throw err;
              actionable = false;
            }
            samples.push({
              metric: obl.metric,
              actual: actionable,
              expected: true,
              passed: actionable,
              message: actionable ? 'Touch and interaction targets are actionable' : 'No actionable interaction targets found',
            });
          } else if (obl.metric.startsWith('style.')) {
            const selector = claim.scope.selector || 'body';
            const prop = obl.metric.replace(/^style\./, '').trim();
            const camelProp = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const styles = await browser.inspectStyles(target, { selector, tabId }, tabId);
            const actualVal = styles[prop] ?? styles[camelProp];

            if (actualVal === undefined) {
              samples.push({
                metric: obl.metric,
                actual: undefined,
                expected: obl.expected,
                passed: false,
                message: `CSS property '${prop}' not found in computed styles for selector '${selector}'`,
              });
            } else if (obl.expected !== undefined) {
              const normActual = String(actualVal).trim().toLowerCase();
              const normExpected = String(obl.expected).trim().toLowerCase();
              const passed = normActual === normExpected;
              samples.push({
                metric: obl.metric,
                actual: actualVal,
                expected: obl.expected,
                passed,
                message: passed
                  ? `Style '${prop}' matched expected '${obl.expected}'`
                  : `Style '${prop}' mismatch: expected '${obl.expected}', got '${actualVal}'`,
              });
            } else {
              samples.push({
                metric: obl.metric,
                actual: actualVal,
                expected: obl.expected,
                passed: false,
                message: `Style obligation '${obl.metric}' is underspecified: missing required expected value`,
              });
            }
          } else if (obl.metric.startsWith('theme.')) {
            if (obl.metric === THEME_METRICS.SOURCE_FILE_IDENTIFIED) {
              const root = typeof getWorkspaceRoot === 'function' ? resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot) : process.cwd();
              const sel = JSON.stringify(claim.scope.selector || 'body');
              let classes: string[] = [];
              let attributes: Record<string, string> = {};
              try {
                const raw = await browser.eval(
                  target,
                  `(() => {
                    const el = document.querySelector(${sel});
                    if (!el) return null;
                    const cls = typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : [];
                    const attrs = {};
                    for (let i = 0; i < el.attributes.length; i++) {
                      const a = el.attributes[i];
                      if (a.name.startsWith('data-') || a.name === 'id' || a.name === 'class') attrs[a.name] = a.value;
                    }
                    return { classes: cls, attributes: attrs };
                  })()`,
                  tabId
                );
                if (raw && typeof raw === 'object') {
                  const typed = raw as { classes?: string[]; attributes?: Record<string, string> };
                  if (Array.isArray(typed.classes)) classes = typed.classes;
                  if (typed.attributes) Object.assign(attributes, typed.attributes);
                }
              } catch {}
              const envelope = ThemeSourceMapper.mapElementToSource(root, { classes, attributes });
              const identified = envelope.success && isAuthoritativeSourceCandidate(envelope.data);
              samples.push({
                metric: obl.metric,
                actual: identified ? envelope.data?.primaryCandidate?.file : envelope.data?.selectionReason || 'none',
                expected: obl.expected ?? true,
                passed: identified,
                message: identified
                  ? `Theme source identified: ${envelope.data?.primaryCandidate?.file} (unique correlated HIGH)`
                  : `Theme source remains candidate-only for selector ${claim.scope.selector}: ${envelope.data?.selectionReason || 'no evidence'}`,
              });
            } else if (obl.metric === THEME_METRICS.CSS_ACTIVE_RULE_MATCHED || obl.metric === THEME_METRICS.CSS_STRONG_PASS_RESOLVED) {
              const urlMap = typeof getStylesheetUrlMap === 'function' ? getStylesheetUrlMap() : undefined;
              const styles = await browser.getMatchedStylesForNode(target, { selector: claim.scope.selector, tabId }, tabId);
              const envelope = CssCascadeAnalyzer.analyze(styles, urlMap);
              if (obl.metric === THEME_METRICS.CSS_ACTIVE_RULE_MATCHED) {
                const passed = envelope.success && (envelope.data?.activeRules.length ?? 0) > 0;
                samples.push({
                  metric: obl.metric,
                  actual: envelope.data?.activeRules.length ?? 0,
                  expected: obl.expected ?? true,
                  passed,
                  message: passed
                    ? `Isolated ${envelope.data?.activeRules.length} active CSS declarations`
                    : 'No active CSS declarations matched for selector',
                });
              } else {
                const passed = envelope.success && envelope.data?.definitionOfDone === 'STRONG PASS';
                samples.push({
                  metric: obl.metric,
                  actual: envelope.data?.definitionOfDone || 'FAILED',
                  expected: 'STRONG PASS',
                  passed,
                  message: passed ? 'CSS cascade resolved to STRONG PASS' : `CSS cascade DoD was ${envelope.data?.definitionOfDone}`,
                });
              }
            } else if (obl.metric === THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW || obl.metric === THEME_METRICS.RESPONSIVE_NO_DOC_OVERFLOW) {
              const res = await browser.responsiveCheck({ selector: claim.scope.selector, tabId }, target);
              const standardWidths = [320, 375, 768, 1024, 1440];
              let hasTargetOverflow = false;
              let hasDocOverflow = false;
              let complete = false;

              if (res && typeof res === 'object' && 'breakpoints' in res && res.breakpoints && typeof res.breakpoints === 'object') {
                const bpValues = Object.values(res.breakpoints as Record<string, Record<string, unknown>>);
                const standardBpMap = new Map<number, Record<string, unknown>>();
                for (const bp of bpValues) {
                  if (typeof bp.width === 'number') {
                    standardBpMap.set(bp.width, bp);
                  }
                }

                let allValid = standardWidths.every((w) => standardBpMap.has(w));
                if (allValid) {
                  for (const w of standardWidths) {
                    const bp = standardBpMap.get(w)!;
                    const hasValidTarget = typeof bp.targetOverflowX === 'boolean';
                    const hasValidDoc = typeof bp.documentOverflowX === 'boolean' || typeof bp.hasHorizontalOverflow === 'boolean';
                    if (!hasValidTarget || !hasValidDoc) {
                      allValid = false;
                      break;
                    }
                  }
                }

                if (allValid) {
                  complete = true;
                  for (const w of standardWidths) {
                    const bp = standardBpMap.get(w)!;
                    if (bp.targetOverflowX === true) hasTargetOverflow = true;
                    if (bp.documentOverflowX === true || bp.hasHorizontalOverflow === true) hasDocOverflow = true;
                  }
                }
              }

              if (!complete) {
                samples.push({
                  metric: obl.metric,
                  actual: 'missing',
                  expected: true,
                  passed: false,
                  message: 'Incomplete responsive telemetry: not all 5 standard breakpoints (320, 375, 768, 1024, 1440) have explicit boolean overflow signals',
                });
              } else if (obl.metric === THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW) {
                samples.push({
                  metric: obl.metric,
                  actual: !hasTargetOverflow,
                  expected: true,
                  passed: !hasTargetOverflow,
                  message: !hasTargetOverflow ? 'Zero target horizontal overflow across all 5 standard breakpoints' : 'Target horizontal overflow detected',
                });
              } else {
                samples.push({
                  metric: obl.metric,
                  actual: !hasDocOverflow,
                  expected: true,
                  passed: !hasDocOverflow,
                  message: !hasDocOverflow ? 'Zero document horizontal overflow across all 5 standard breakpoints' : 'Document horizontal overflow detected',
                });
              }
            }
          } else {
            samples.push({
              metric: obl.metric,
              actual: 'unsupported_metric',
              passed: false,
              message: `Metric '${obl.metric}' is not directly verifiable by server probe.`,
            });
          }
        } catch (err: unknown) {
          if (context.signal?.aborted || (err instanceof CapabilityError && err.code === 'WAIT_ABORTED')) {
            throw err;
          }
          samples.push({
            metric: obl.metric,
            actual: 'error',
            passed: false,
            message: String(err),
          });
        }
      }
      const currentMutationRev = browser.getMutationRevision ? (browser.getMutationRevision(tabId) ?? 1) : 1;
      const bundle: EvidenceSampleBundle = {
        documentGeneration: currentDocGen,
        mutationRevision: currentMutationRev,
        currentTabGeneration: currentDocGen,
        captureTimestamp: Date.now(),
        samples,
        semanticWitness: params.semanticFailureObservation
          ? { modelConfirmed: false, observations: [params.semanticFailureObservation] }
          : params.witnessObservation
            ? { modelConfirmed: true, observations: [params.witnessObservation] }
            : undefined,
      };

      const evalResult = VerificationEvaluator.evaluate(claim, bundle);
      // The circuit breaker's cross-attempt STALEMATE lever keys on a failure signature. Nothing
      // else in the engine supplies one, so it is derived here from the evidence this probe just
      // observed: a second REJECTED attempt on the same failed obligations halts the batch
      // instead of looping. Non-REJECTED verdicts return no signature and never advance it.
      const failureSignature = deriveFailureSignature(evalResult);
      const transition = VerificationCircuitBreaker.getInstance().recordAttempt(
        { runId, attemptId, claimId: claim.id },
        evalResult.verdict,
        evalResult.inconclusiveReason,
        previousLifecycle,
        invocationId,
        failureSignature ? { failureSignature } : undefined
      );
      const updated = IssueRegister.getInstance().updateVerificationVerdict(
        claim.id,
        evalResult.verdict,
        evalResult.proofProfile,
        evalResult.inconclusiveReason,
        transition.lifecycle
      );
      if (receipts && receiptBinding) {
        receipts.put(receiptBinding, 'completed', 'accepted-exact');
      }
      return updated || claim;
    },
  });

  catalogue.register({
    name: 'anti.verification.list',
    description: 'List recorded verification claims and their verdicts from the durable register',
    risk: 'read',
    policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['VERIFIED', 'PARTIAL', 'REJECTED', 'INCONCLUSIVE', 'UNVERIFIED'] },
        actor: { type: 'string', enum: ['agent', 'user'] },
        tabId: { type: 'string' },
        stalemateState: { type: 'string', enum: ['ACTIVE', 'STALEMATE', 'EXEMPTION_WAIVED'] },
        limit: { type: 'number' },
      },
    },
    execute: (params: {
      verdict?: 'VERIFIED' | 'PARTIAL' | 'REJECTED' | 'INCONCLUSIVE' | 'UNVERIFIED';
      actor?: 'agent' | 'user';
      tabId?: string;
      stalemateState?: 'ACTIVE' | 'STALEMATE' | 'EXEMPTION_WAIVED';
      limit?: number;
    }) => {
      const list = IssueRegister.getInstance().listVerifications(params);
      return { totalCount: list.length, verifications: list };
    },
  });

  catalogue.register({
    name: 'anti.theme.await_cdn_sync',
    description: 'Poll the storefront copy of one static asset until its SHA-256 matches the local workspace file, then optionally reload the bound tab. A .liquid file is never served as-is: pass expectContains / expectNotContains and the compiled asset (the name without .liquid) is polled until every expected string is present and every forbidden string is absent. Reads only inside the bound workspace; lastError says why a poll did not match.',
    // The optional reload changes the tab's document, so the declaration covers it: same class
    // as anti.browser.reload, never replayed as a read.
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'event-wait', timeoutMs: BROWSER_WAIT_INVOCATION_BUDGET_MS }),
    inputSchema: {
      type: 'object',
      properties: {
        assetPath: { type: 'string', description: 'Workspace-relative or filename asset path (e.g. assets/theme.css or theme.css)' },
        workspaceRoot: { type: 'string' },
        allowNonTheme: { type: 'boolean', description: 'Accept a workspace root without theme markers (layout/theme.liquid, config/settings_schema.json, config/settings.html)' },
        timeoutMs: { type: 'number', description: 'Polling timeout in milliseconds (default 15000, max 25000)' },
        pollIntervalMs: { type: 'number' },
        reloadOnMatch: { type: 'boolean' },
        expectContains: { type: 'array', items: { type: 'string' }, description: 'Strings that must all appear in the served asset; required for .liquid assets, optional hash-match refinement otherwise' },
        expectNotContains: { type: 'array', items: { type: 'string' }, description: 'Strings that must all be absent from the served asset' },
        tabId: { type: 'string' },
        paneId: { type: 'string', enum: ['desktop', 'mobile'] },
      },
      required: ['assetPath'],
    },
    execute: (params: { assetPath: string; workspaceRoot?: string; allowNonTheme?: boolean; timeoutMs?: number; pollIntervalMs?: number; reloadOnMatch?: boolean; expectContains?: string[]; expectNotContains?: string[]; tabId?: string; paneId?: 'desktop' | 'mobile' }, context) => {
      const { allowNonTheme, ...syncParams } = params;
      const strict = confineWorkspaceRootStrict(params.workspaceRoot, resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot));
      if (strict.redirected) {
        throw new CapabilityError('WORKSPACE_MISMATCH', `Requested workspaceRoot '${strict.requested}' is outside the bound workspace '${strict.root}'`, { requested: strict.requested, bound: strict.root });
      }
      if (allowNonTheme !== true) assertThemeWorkspaceRoot(strict.root, 'anti.theme.await_cdn_sync');
      return browser.awaitCdnSync(context.browserTarget as BrowserTarget, {
        ...syncParams,
        workspaceRoot: strict.root || undefined,
      });
    },
  });

  catalogue.register({
    name: 'anti.qa.batch_matrix',
    description: 'Sequentially navigate and sweep up to 20 routes of the bound storefront (same origin only) across responsive breakpoints in the bound tab, then return the tab to its starting page. A route with an unmeasured width reports passed: null. When routes x widths exceed the per-call budget, whole routes run in order and the result lists the rest in remainingRoutes: call again with exactly those routes.',
    // Navigates the bound tab route by route: the same class as anti.browser.navigate.
    risk: 'write',
    requiresBrowserTarget: true,
    policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate', timeoutMs: 210_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        routes: { type: 'array', items: { type: 'string' }, description: 'Storefront URLs or paths to scan sequentially in the bound tab' },
        breakpoints: { type: 'array', items: { type: 'number' }, description: 'Viewport widths in CSS px (default [320, 375, 768, 1024, 1440])' },
        viewports: VIEWPORTS_SCHEMA,
        tabId: { type: 'string' },
      },
      required: ['routes'],
    },
    execute: (params: { routes: string[]; breakpoints?: number[]; viewports?: unknown; tabId?: string }, context) => {
      const viewports = parseViewportsParam(params.viewports, 'anti.qa.batch_matrix');
      return browser.runBatchMatrix(context.browserTarget as BrowserTarget, {
        routes: params.routes,
        breakpoints: params.breakpoints,
        tabId: params.tabId,
        ...(viewports ? { viewports } : {}),
      });
    },
  });
}

export function legacyContext(target: BrowserTarget, lease: CapabilityRequestContext['lease']): CapabilityRequestContext {
  return { lease, leaseToken: lease.token, projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
}

