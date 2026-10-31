/**
 * `theme.cockpit_*` capability family — the agent-facing surface of the Theme
 * Studio checklist/QA bridge.
 *
 * Every capability here derives `{scope, workspaceRoot}` from the *bound* tab
 * via `CockpitPort.resolveScope` (memoized per tab+URL, Phase 1). Caller-supplied
 * `scope` is an assertion, not a selector: a value that re-derives unequal is
 * refused with `SCOPE_MISMATCH` so an agent can never file a checklist tick into
 * a workspace it never named (F8). `workspaceRoot` params are confined to the
 * bound tab's resolved root before reaching the host (F4).
 *
 * Registration must never dereference `cockpit` or `browser` members: the
 * budget-dominance gate builds the catalogue against recording stubs, so
 * collaborator access happens only inside `execute` bodies.
 * MAINTENANCE: adding/removing/renaming a `theme.cockpit_*` capability (or its
 * error semantics) must update the skill `antifan-qa-cockpit`
 * (~/.claude/skills/antifan-qa-cockpit/SKILL.md) in the same commit - its
 * reference table is maintained by hand and its refusal table mirrors the
 * CapabilityError codes thrown below.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CapabilityError,
  type BrowserTarget,
  type CapabilityRequestContext,
  type CapabilityRisk,
} from '../../shared/control-plane-contracts';
import type { CapabilityCatalogue } from './capability-catalogue';
import type { CapabilityEffectPolicyInput } from '../../shared/control-plane-contracts';
import type { BrowserControlPort } from './browser-control-port';
import type { CockpitPort, CockpitScopeIdentity, CockpitThemeQaOptions } from './cockpit-port';
import type { ChecklistMutationOp } from '../qa/theme-checklist-store';
import { PlatformDetector } from '../qa/scanners/platform-detector';
import { loadOrBootstrapBaseline, evaluateSettingsRatchet, type SettingsFinding } from '../qa/settings-ratchet';
import {
  PAGE_DEFS,
  PRODUCT_PAGE_PATH,
  ARTICLE_PAGE_PATH,
  buildChecklistReport,
  adaptChecklistItems,
  type ThemeChecklistItem,
} from '../../shared/theme-checklist';
import { confineWorkspaceRoot } from '../qa/diagnostics-filter';
import { assertThemeWorkspaceRoot } from '../qa/workspace-markers';
import { deriveChecklistTicks, type ChecklistProbeResults } from '../qa/checklist-autotick';
import { makeProbeDeps, type ProbeDeps } from '../qa/probes/probe-deps';
import { runPickProduct, type PickProductStrategy } from '../qa/probes/pick-product';
import { runPageStructure } from '../qa/probes/page-structure';
import { runMenuDepth } from '../qa/probes/menu-depth';
import { runVariantImageProbe } from '../qa/probes/variant-image-probe';
import { runPdpContract } from '../qa/probes/pdp-contract';
import { runCartContract } from '../qa/probes/cart-contract';
import { parseBaselineViewportsInput, resolveBaselineViewports, type BaselineViewportsInput } from '../qa/baseline-provenance';
import { DEADLINES } from '../../shared/deadline-chain';
// Circular edge (browser-capabilities ↔ this module): the namespace is resolved
// lazily inside the registration body, so neither module may reference it at
// load time.
import * as browserCaps from './browser-capabilities';

function cockpitPolicy(options: {
  effect: CapabilityEffectPolicyInput['effect'];
  risk: CapabilityRisk;
  lane?: CapabilityEffectPolicyInput['schedulerLane'];
  timeoutMs?: number;
}): CapabilityEffectPolicyInput {
  return browserCaps.makeBrowserPolicy({ ...options, requiresBrowserTarget: true });
}

type CockpitParams = {
  scope?: string;
  tabId?: string;
  workspaceRoot?: string;
};

export interface CockpitSettingsSummary {
  ok: boolean;
  newFailures: number;
  legacyDebt: number;
  deadInSchema?: number;
  topViolations: SettingsFinding[];
}

export function isHaravanThemeWorkspace(workspaceRoot: string): boolean {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return false;
  if (fs.existsSync(path.join(workspaceRoot, '.haravan-cli_local.json'))) return true;
  if (fs.existsSync(path.join(workspaceRoot, 'config', 'settings.html'))) return true;
  try {
    const detected = PlatformDetector.detectFromWorkspace(workspaceRoot);
    if (detected.platform === 'haravan') return true;
  } catch {}
  return false;
}

function detectThemeSettingsMode(workspaceRoot?: string): 'legacy' | 'f1genz' {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return 'f1genz';
  const hasSettingsHtml = fs.existsSync(path.join(workspaceRoot, 'config', 'settings.html'));
  const hasSettingsSchema = fs.existsSync(path.join(workspaceRoot, 'config', 'settings_schema.json'));
  if (hasSettingsHtml && !hasSettingsSchema) return 'legacy';
  if (hasSettingsHtml) {
    try {
      const raw = fs.readFileSync(path.join(workspaceRoot, 'config', 'settings_schema.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const isLive = Array.isArray(parsed) && parsed.some((panel) => Array.isArray(panel?.settings) && panel.settings.length > 0);
      if (!isLive) return 'legacy';
    } catch {
      return 'legacy';
    }
  }
  return 'f1genz';
}

/**
 * Locate the AntiFan repo root by walking up from this module until
 * scripts/lib/theme-checks.mjs resolves — identical contract to the copies in
 * browser-capabilities.ts and theme-transaction-capabilities.ts. process.cwd()
 * is the caller's workspace, not the repo, so it must never locate this script.
 */
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

async function collectHaravanSettingsFindings(workspaceRoot: string): Promise<{ findings: SettingsFinding[]; deadIds: Array<{ id: string }> }> {
  const repoRoot = resolveRepoRoot();
  const themeChecksPath = path.join(repoRoot, 'scripts', 'lib', 'theme-checks.mjs');
  if (!fs.existsSync(themeChecksPath)) return { findings: [], deadIds: [] };

  try {
    const themeChecksModule = await import(pathToFileURL(themeChecksPath).href);
    const {
      checkHaravanLiquidContracts,
      checkSettingsBinding,
      checkAssetReferences,
      checkF1genzSettingsSchema,
    } = themeChecksModule;

    const hasSettingsSchema = fs.existsSync(path.join(workspaceRoot, 'config', 'settings_schema.json'));
    const haravanContracts = typeof checkHaravanLiquidContracts === 'function'
      ? checkHaravanLiquidContracts(workspaceRoot, { platform: 'haravan' })
      : null;
    const settingsBinding = typeof checkSettingsBinding === 'function'
      ? checkSettingsBinding(workspaceRoot)
      : null;
    const assets = typeof checkAssetReferences === 'function'
      ? checkAssetReferences(workspaceRoot)
      : null;
    const f1genzSchema = hasSettingsSchema && typeof checkF1genzSettingsSchema === 'function'
      ? checkF1genzSettingsSchema(workspaceRoot)
      : null;
    const findings: SettingsFinding[] = [];

    if (Array.isArray(haravanContracts?.failures)) {
      for (const f of haravanContracts.failures) {
        findings.push({
          rule: f.rule || 'HARAVAN_CONTRACT_FAILURE',
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
              rule: f.rule || 'SETTINGS_BINDING_FAILURE',
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
            rule: f.rule || 'SETTINGS_BINDING_FAILURE',
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

    if (Array.isArray(assets?.localMissing)) {
      for (const m of assets.localMissing) {
        findings.push({
          rule: 'LOCAL_ASSET_MISSING',
          file: (Array.isArray(m.files) && m.files[0]) || 'assets/',
          line: 1,
          message: `Asset '${m.ref}' not found locally`,
          detail: `Local asset missing: ${m.ref}`,
        });
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
          rule: f.rule || 'F1GENZ_SCHEMA_FAILURE',
          id: f.id,
          file,
          ...(f.line !== undefined ? { line: f.line } : {}),
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
        ...(d.line !== undefined ? { line: d.line } : {}),
        ...(d.pointer ? { pointer: d.pointer } : {}),
        message: `schema setting has no resolved reference: ${d.id}`,
        detail: `Declared setting '${d.id}' is never referenced in theme Liquid files`,
      });
    }
    return { findings, deadIds };
  } catch {
    return { findings: [], deadIds: [] };
  }
}

export async function resolveSettingsSummary(workspaceRoot?: string): Promise<CockpitSettingsSummary | undefined> {
  if (!workspaceRoot || !isHaravanThemeWorkspace(workspaceRoot)) {
    return undefined;
  }
  try {
    const { findings, deadIds } = await collectHaravanSettingsFindings(workspaceRoot);
    // Non-pure ratchet: load baseline FRESH on every call so in-memory ratchet mutation
    // never leaks or drifts across invocations.
    const baseline = loadOrBootstrapBaseline(workspaceRoot, findings);
    // Cockpit is strictly READ-ONLY surface: pass { persist: false }
    const settingsRatchet = evaluateSettingsRatchet(baseline, findings, {
      workspaceRoot,
      persist: false,
      deadIds,
    });
    return {
      ok: settingsRatchet.ok,
      newFailures: settingsRatchet.newFailures.length,
      legacyDebt: settingsRatchet.legacyDebt.length,
      ...(typeof settingsRatchet.deadInSchema === 'number' ? { deadInSchema: settingsRatchet.deadInSchema } : {}),
      topViolations: settingsRatchet.newFailures.slice(0, 5),
    };
  } catch {
    return undefined;
  }
}
/**
 * The single scope assertion point: everything derives from the bound tab id
 * the control plane already authorized (`requiresBrowserTarget`), and a caller
 * that also supplied `scope` must agree with what the tab actually resolves to.
 */
function resolveBoundScope(
  cockpit: CockpitPort,
  params: CockpitParams | undefined,
  context: CapabilityRequestContext,
  capability: string
): CockpitScopeIdentity {
  const tabId = (context.browserTarget?.tabId || '').trim();
  if (!tabId) {
    throw new CapabilityError('TARGET_REQUIRED', `${capability} requires a bound browser target`);
  }
  const identity = cockpit.resolveScope(tabId);
  const claimed = typeof params?.scope === 'string' ? params.scope.trim() : '';
  if (claimed && claimed !== identity.scope) {
    throw new CapabilityError(
      'SCOPE_MISMATCH',
      `${capability} scope '${claimed}' does not match the bound tab's scope '${identity.scope}'; omit scope or rebind to the tab that owns it`
    );
  }
  return identity;
}

/**
 * Mirrors the toolbar's `resolveChecklistRoute`: fixed `pageDef.path` resolves
 * against the bound tab's origin; `handle-required` pages (product) reuse the
 * bound tab's current URL only when it is a live `/products/<handle>` — a scan
 * route is never fabricated for a page the storefront cannot serve. When an
 * explicit `url` is supplied, it resolves against `origin`, must stay on the
 * same origin, and for `handle-required` pages must match `PRODUCT_PAGE_PATH`.
 */
function resolveScanRoute(page: string, boundUrl: string, origin: string, explicitUrl?: string): string | null {
  const pageDef = page ? PAGE_DEFS[page] : undefined;
  if (typeof explicitUrl === 'string' && explicitUrl.trim()) {
    if (page && !pageDef) return null;
    if (!origin) return null;
    try {
      const baseOrigin = new URL(origin).origin;
      const candidate = new URL(explicitUrl.trim(), baseOrigin);
      if (candidate.origin !== baseOrigin) return null;
      const handleRe = page === 'article' ? ARTICLE_PAGE_PATH : PRODUCT_PAGE_PATH;
      if (pageDef?.routeKind === 'handle-required' && !handleRe.test(candidate.pathname)) {
        return null;
      }
      return candidate.href;
    } catch {
      return null;
    }
  }
  if (!pageDef) return null;
  if (pageDef.routeKind === 'handle-required') {
    if (!boundUrl) return null;
    try {
      const handleRe = page === 'article' ? ARTICLE_PAGE_PATH : PRODUCT_PAGE_PATH;
      return handleRe.test(new URL(boundUrl).pathname) ? boundUrl : null;
    } catch {
      return null;
    }
  }
  try {
    return new URL(pageDef.path, origin).href;
  } catch {
    return null;
  }
}

const PICK_STRATEGIES: readonly PickProductStrategy[] = ['max-variants', 'long-title', 'sold-out', 'no-image'];

function parsePickStrategy(value: unknown): PickProductStrategy | undefined {
  if (value === undefined) return undefined;
  if (!PICK_STRATEGIES.includes(value as PickProductStrategy)) {
    throw new CapabilityError('INVALID_ARGUMENT', `theme.cockpit_scan pick must be one of ${PICK_STRATEGIES.join(', ')}`);
  }
  return value as PickProductStrategy;
}

/** The grading inputs of a cockpit scan; baselineViewports is still the caller's evidence until it is resolved against the ledger. */
type ScanQaOptions = Omit<CockpitThemeQaOptions, 'viewports' | 'viewportProvenance' | 'viewportRejections' | 'workspaceRoot'> & { baselineViewports?: BaselineViewportsInput };

/** A route that has not loaded within this bound is a navigation failure; the rest of the policy budget belongs to the QA run. */
const COCKPIT_NAVIGATION_MS = 60_000;

/** The QA grading inputs a cockpit scan forwards to the workflow; anything malformed is refused, never defaulted. */
function parseScanQaOptions(params: { profile?: unknown; thresholds?: unknown; viewports?: unknown; baselineViewports?: unknown; multiBreakpoint?: unknown; waivers?: unknown }): ScanQaOptions {
  if (params.viewports !== undefined) {
    throw new CapabilityError('INVALID_ARGUMENT', 'theme.cockpit_scan viewports was renamed to baselineViewports ({desktop,tablet,mobile} visual-compare results)', {
      capability: 'theme.cockpit_scan',
      renamedField: { from: 'viewports', to: 'baselineViewports' },
    });
  }
  const parsed = browserCaps.parseQaValidateOptions({
    ...(params.profile !== undefined ? { profile: params.profile } : {}),
    ...(params.thresholds !== undefined ? { thresholds: params.thresholds } : {}),
    ...(params.waivers !== undefined ? { waivers: params.waivers } : {}),
  });
  if (params.multiBreakpoint !== undefined && typeof params.multiBreakpoint !== 'boolean') {
    throw new CapabilityError('INVALID_ARGUMENT', 'theme.cockpit_scan multiBreakpoint must be a boolean');
  }
  const baselineViewports = parseBaselineViewportsInput(params.baselineViewports, 'theme.cockpit_scan baselineViewports');
  return {
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(parsed.thresholds ? { thresholds: parsed.thresholds } : {}),
    ...(baselineViewports ? { baselineViewports } : {}),
    ...(params.multiBreakpoint !== undefined ? { multiBreakpoint: params.multiBreakpoint } : {}),
    ...(parsed.waivers.length > 0 ? { waivers: parsed.waivers } : {}),
  };
}

/** Page key of a storefront URL when the caller named neither page nor url. */
function inferPageKey(liveUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(liveUrl).pathname;
  } catch {
    return '';
  }
  if (PRODUCT_PAGE_PATH.test(pathname)) return 'product';
  if (ARTICLE_PAGE_PATH.test(pathname)) return 'article';
  if (pathname === '/' || pathname === '') return 'home';
  if (/^\/cart\/?$/.test(pathname)) return 'cart';
  if (/^\/collections\/[^/]+\/?$/.test(pathname)) return 'collection';
  return '';
}

const PROBES_BY_PAGE: Readonly<Record<string, ReadonlyArray<keyof ChecklistProbeResults>>> = {
  home: ['page_structure', 'menu_depth'],
  product: ['variant_image_probe', 'pdp_contract'],
  collection: ['menu_depth'],
  cart: ['cart_contract'],
};

async function runPageProbes(deps: ProbeDeps, page: string): Promise<ChecklistProbeResults> {
  const results: ChecklistProbeResults = {};
  for (const name of PROBES_BY_PAGE[page] ?? []) {
    try {
      switch (name) {
        case 'page_structure': results[name] = await runPageStructure(deps); break;
        case 'menu_depth': results[name] = await runMenuDepth(deps); break;
        case 'variant_image_probe': results[name] = await runVariantImageProbe(deps, {}); break;
        case 'pdp_contract': results[name] = await runPdpContract(deps); break;
        case 'cart_contract': results[name] = await runCartContract(deps); break;
      }
    } catch (err) {
      results[name] = { measured: false, passed: null, findings: [], data: {}, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return results;
}

function loadChecklistItems(cockpit: CockpitPort, tabId: string, input: { scope: string; workspaceRoot: string }): ThemeChecklistItem[] | undefined {
  try {
    return cockpit.checklistLoad(tabId, input).items;
  } catch {
    return undefined;
  }
}

/** What a scan adds beyond the QA report: probe evidence and the checklist ticks it decided. */
export interface ScanProbeOutcome {
  probes?: ChecklistProbeResults;
  checklist?: {
    applied: Array<{ itemId: string; done: boolean }>;
    skipped: Array<{ itemId: string; reason: string }>;
  };
}

/**
 * Runs the page probes after a successful QA scan and writes the ticks the
 * measurements decide. An item the user changed while the scan ran is left alone:
 * a scan never overrides a manual tick or un-tick that is newer than its own start.
 */
async function finishScan(args: {
  cockpit: CockpitPort;
  browser: BrowserControlPort;
  context: CapabilityRequestContext;
  identity: CockpitScopeIdentity;
  checklistInput: { scope: string; workspaceRoot: string };
  checklistBefore: ThemeChecklistItem[] | undefined;
  ok: boolean;
  report: unknown;
  page: string;
}): Promise<ScanProbeOutcome> {
  const { cockpit, browser, context, identity, checklistInput, checklistBefore, ok, report, page } = args;
  if (!ok || !identity.workspaceRoot || !context.browserTarget) return {};
  const deps = makeProbeDeps(browser, context.browserTarget, identity.tabId, 'desktop', context.signal);
  const probes = await runPageProbes(deps, page);
  const ticks = deriveChecklistTicks({ qa: report, probes });
  const checklist: NonNullable<ScanProbeOutcome['checklist']> = { applied: [], skipped: [] };
  if (ticks.length === 0) return { probes, checklist };
  const current = loadChecklistItems(cockpit, identity.tabId, checklistInput);
  if (!current || !checklistBefore) {
    checklist.skipped = ticks.map((tick) => ({ itemId: tick.itemId, reason: 'checklist could not be loaded' }));
    return { probes, checklist };
  }
  const before = new Map(checklistBefore.map((item) => [item.id, item]));
  const now = new Map(current.map((item) => [item.id, item]));
  for (const tick of ticks) {
    const live = now.get(tick.itemId);
    if (!live) {
      checklist.skipped.push({ itemId: tick.itemId, reason: 'item is not in this checklist' });
      continue;
    }
    const was = before.get(tick.itemId);
    if (was && (was.done !== live.done || (was.note ?? '') !== (live.note ?? ''))) {
      checklist.skipped.push({ itemId: tick.itemId, reason: 'changed by the user while the scan ran' });
      continue;
    }
    cockpit.checklistMutate(identity.tabId, { ...checklistInput, op: { op: 'mark', itemId: tick.itemId, done: tick.done, note: tick.note } });
    checklist.applied.push({ itemId: tick.itemId, done: tick.done });
  }
  return { probes, checklist };
}

export function registerCockpitCapabilities(
  catalogue: CapabilityCatalogue,
  cockpit: CockpitPort,
  browser: BrowserControlPort
): void {
  const readPolicy = (): CapabilityEffectPolicyInput =>
    cockpitPolicy({ effect: 'read', risk: 'read', lane: 'unbounded' });
  const writePolicy = (): CapabilityEffectPolicyInput =>
    cockpitPolicy({ effect: 'idempotent-write', risk: 'write', lane: 'unbounded' });
  const scopeProps = {
    scope: { type: 'string', description: 'Checklist scope assertion; must re-derive equal to the bound tab scope or the call is refused' },
    tabId: { type: 'string' },
  };

  catalogue.register({
    name: 'theme.cockpit_list',
    description: 'Load the Theme QA checklist scope bound to this tab: items, progress, and per-page counts',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: readPolicy(),
    inputSchema: { type: 'object', properties: { ...scopeProps } },
    execute: (params: CockpitParams, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_list');
      const loaded = cockpit.checklistLoad(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot });
      const themeMode = detectThemeSettingsMode(identity.workspaceRoot);
      const items = adaptChecklistItems(loaded.items, themeMode);
      const pages = new Map<string, { page: string; done: number; total: number }>();
      for (const item of items) {
        const entry = pages.get(item.page) || { page: item.page, done: 0, total: 0 };
        entry.total += 1;
        if (item.done) entry.done += 1;
        pages.set(item.page, entry);
      }
      return {
        scope: loaded.scope,
        workspaceRoot: loaded.workspaceRoot,
        items,
        done: items.filter((item) => item.done).length,
        total: items.length,
        pages: Array.from(pages.values()),
        isProvisional: loaded.isProvisional,
        updatedAt: loaded.updatedAt,
        existed: loaded.existed,
        migrated: loaded.migrated,
      };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_mark',
    description: 'Mark one Theme QA checklist item done or undone on the bound tab scope; optional note is capped at 1KB',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: writePolicy(),
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        done: { type: 'boolean' },
        note: { type: 'string' },
        ...scopeProps,
      },
      required: ['itemId', 'done'],
    },
    execute: (params: { itemId?: string; done?: boolean; note?: string } & CockpitParams, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_mark');
      const op: ChecklistMutationOp = { op: 'mark', itemId: String(params.itemId ?? ''), done: params.done === true };
      if (params.note !== undefined) op.note = params.note;
      const result = cockpit.checklistMutate(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot, op });
      return { item: result.item, updatedAt: result.updatedAt, scope: result.scope, isProvisional: result.isProvisional };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_mark_page',
    description: 'Mark every checklist item on one page done or undone on the bound tab scope; unknown pages are refused',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: writePolicy(),
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'A PAGE_DEFS key (home, collection, product, cart, blog, account, pages, qa-gate) or a page already present in the loaded scope' },
        done: { type: 'boolean' },
        ...scopeProps,
      },
      required: ['page', 'done'],
    },
    execute: (params: { page?: string; done?: boolean } & CockpitParams, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_mark_page');
      const page = typeof params.page === 'string' ? params.page.trim() : '';
      // The enum alone is not the authority: a page also validates when the
      // loaded scope already carries items for it (custom pages), so a caller
      // can mark a page an earlier add_item created (F13).
      const loaded = cockpit.checklistLoad(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot });
      const known = new Set<string>(Object.keys(PAGE_DEFS));
      for (const item of loaded.items) known.add(item.page);
      if (!page || !known.has(page)) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          `theme.cockpit_mark_page page '${page}' is not a known page; expected one of ${Array.from(known).join(', ')}`
        );
      }
      const op: ChecklistMutationOp = { op: 'markPage', page, done: params.done === true };
      const result = cockpit.checklistMutate(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot, op });
      return { toggled: result.toggled ?? 0, updatedAt: result.updatedAt, scope: result.scope, isProvisional: result.isProvisional };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_add_item',
    description: 'Append one checklist item to the bound tab scope; a caller-supplied itemId makes a retried add a no-op',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: writePolicy(),
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Caller-chosen item id; re-adding the same id is a replay no-op' },
        code: { type: 'string' },
        name: { type: 'string' },
        desc: { type: 'string' },
        qaPoint: { type: 'string' },
        page: { type: 'string', description: "Page key (default 'home'); must match the checklist page pattern" },
        pathHint: { type: 'string', description: 'Storefront route hint; defaults to the page\'s declared path' },
        ...scopeProps,
      },
      required: ['name'],
    },
    execute: (params: { itemId?: string; code?: string; name?: string; desc?: string; qaPoint?: string; page?: string; pathHint?: string } & CockpitParams, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_add_item');
      const page = typeof params.page === 'string' && params.page.trim() ? params.page.trim() : 'home';
      const pathHint = typeof params.pathHint === 'string' && params.pathHint.trim() ? params.pathHint : PAGE_DEFS[page]?.path;
      const item: ThemeChecklistItem = {
        // Caller-supplied ids keep a retried add idempotent (F15); the default
        // matches the toolbar's `item_<ts>_<rand>` minted shape.
        id: typeof params.itemId === 'string' && params.itemId.trim() ? params.itemId.trim() : `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        code: params.code ?? '',
        name: params.name ?? '',
        desc: params.desc ?? '',
        qaPoint: params.qaPoint ?? '',
        page,
        done: false,
        ...(pathHint !== undefined ? { pathHint } : {}),
      };
      const op: ChecklistMutationOp = { op: 'add', item };
      const result = cockpit.checklistMutate(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot, op });
      return { item: result.item, updatedAt: result.updatedAt, scope: result.scope, isProvisional: result.isProvisional };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_remove_item',
    description: 'Remove one checklist item from the bound tab scope; removing an absent id is a no-op',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: writePolicy(),
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        ...scopeProps,
      },
      required: ['itemId'],
    },
    execute: (params: { itemId?: string } & CockpitParams, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_remove_item');
      const op: ChecklistMutationOp = { op: 'remove', itemId: String(params.itemId ?? '') };
      const result = cockpit.checklistMutate(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot, op });
      return { removed: result.removed === true, updatedAt: result.updatedAt, scope: result.scope, isProvisional: result.isProvisional };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_scan',
    description: 'Navigate the bound tab to a checklist page route, run the authoritative Theme QA scan on it, then run the page probes for that route (home: page_structure + menu_depth; product: variant_image_probe + pdp_contract; cart: cart_contract, passive, it reads the quantity, remove and checkout controls and the checkout target but never clicks or changes the cart, and an empty cart is reported as not exercised; collection: menu_depth) and tick the checklist items those measurements decide. profile/thresholds/baselineViewports/multiBreakpoint are forwarded to the QA run; pick chooses the product page (max-variants, long-title, sold-out, no-image) instead of the first product link. The report carries certification: STRUCTURAL unless every baseline viewport is receipt-backed.',
    risk: 'read',
    requiresBrowserTarget: true,
    // Navigating the tab is a real interactive effect: the run is not replay-safe
    // (a client retry re-navigates and re-scans), so this stays out of READ_SAFE.
    policy: cockpitPolicy({ effect: 'interactive-effect', risk: 'read', lane: 'viewport-gate', timeoutMs: DEADLINES.toolPolicyMs }),
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'PAGE_DEFS page key; when omitted the tab is scanned on its current URL' },
        url: { type: 'string', description: 'Optional explicit same-origin URL or /products/<handle> path to scan' },
        workspaceRoot: { type: 'string', description: 'Workspace root assertion; a root outside the bound tab workspace falls back to the bound root, and a bound root without theme markers is refused with WORKSPACE_NOT_THEME' },
        allowNonTheme: { type: 'boolean', description: 'Accept a workspace root without theme markers (layout/theme.liquid, config/settings_schema.json, config/settings.html)' },
        tabId: { type: 'string' },
        profile: { type: 'string', enum: ['audit', 'build-strict'], description: 'QA grading profile (default build-strict)' },
        thresholds: { type: 'object', description: 'Contract thresholds (minTextPx, minTapHitPx, optional titleScale, inputHeightBandPx). Omitted: workspace contract typeScale, else the built-in defaults' },
        baselineViewports: { type: 'object', description: 'Visual-compare evidence per size (desktop, tablet, mobile). Pass {compareReceiptId} from an anti.visual.compare result: the host reads the numbers from its own ledger, so a receipt-backed run can be CERTIFIED. Legacy {mismatchPercent, passed} is caller-asserted and caps the run at STRUCTURAL' },
        multiBreakpoint: { type: 'boolean', description: 'Run the responsive breakpoint sweep (default true)' },
        waivers: { type: 'array', items: { type: 'object', properties: { rule: { type: 'string' }, reason: { type: 'string' } }, required: ['rule', 'reason'] }, description: 'Same as theme.qa_validate waivers: {rule, reason} pairs echoed on the report and receipt' },
        pick: { type: 'string', enum: [...PICK_STRATEGIES], description: 'For page=product without an explicit url: crawl /collections/all and scan the product that best matches this strategy' },
      },
    },
    execute: async (params: { page?: string; url?: string; workspaceRoot?: string; allowNonTheme?: boolean; tabId?: string; profile?: unknown; thresholds?: unknown; baselineViewports?: unknown; multiBreakpoint?: unknown; waivers?: unknown; pick?: unknown }, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_scan');
      const qaOptions = parseScanQaOptions(params);
      const pick = parsePickStrategy(params.pick);
      // A caller-supplied workspaceRoot is an assertion, not a target: a root outside
      // the bound root falls back to the bound root. An unresolvable bound root stays
      // provisional (no marker check possible, no candidate honoured).
      let confinedRoot = '';
      if (identity.workspaceRoot) {
        confinedRoot = confineWorkspaceRoot(params.workspaceRoot, identity.workspaceRoot);
        if (params.allowNonTheme !== true) assertThemeWorkspaceRoot(confinedRoot, 'theme.cockpit_scan');
      }
      const boundUrl = await browser.getLiveTabUrl(identity.tabId).catch(() => '');
      const page = typeof params.page === 'string' ? params.page.trim() : '';
      const explicitUrl = typeof params.url === 'string' ? params.url.trim() : '';
      let resolvedPage = page;
      if (page || explicitUrl) {
        if (page && !PAGE_DEFS[page]) {
          throw new CapabilityError('INVALID_ARGUMENT', `theme.cockpit_scan page '${page}' is not a known page; expected one of ${Object.keys(PAGE_DEFS).join(', ')}`);
        }
        if (!resolvedPage && explicitUrl && identity.origin) {
          try {
            const candidate = new URL(explicitUrl, new URL(identity.origin).origin);
            if (PRODUCT_PAGE_PATH.test(candidate.pathname)) {
              resolvedPage = 'product';
            } else if (ARTICLE_PAGE_PATH.test(candidate.pathname)) {
              resolvedPage = 'article';
            } else {
              const matched = Object.entries(PAGE_DEFS).find(
                // A def path may carry a query (`/search?q=a`); the route is its pathname.
                ([, def]) => def.routeKind !== 'handle-required' && def.path.split(/[?#]/)[0] === candidate.pathname
              );
              if (matched) resolvedPage = matched[0];
            }
          } catch {}
        }
        const pageDef = resolvedPage ? PAGE_DEFS[resolvedPage] : undefined;
        const pageLabel = resolvedPage || 'custom';
        let pickedUrl: string | undefined;
        if (pick && resolvedPage === 'product' && !explicitUrl) {
          const picked = await runPickProduct(makeProbeDeps(browser, context.browserTarget as BrowserTarget, identity.tabId, 'desktop', context.signal), { strategy: pick });
          const handle = picked.data.handles[0];
          if (!handle) {
            throw new CapabilityError('ROUTE_UNRESOLVED', `theme.cockpit_scan pick '${pick}' found no matching product${picked.error ? `: ${picked.error}` : ''}`);
          }
          pickedUrl = `/products/${encodeURIComponent(handle)}`;
        }
        let route = resolveScanRoute(resolvedPage, boundUrl, identity.origin, pickedUrl ?? (explicitUrl || undefined));
        if (!route && pageDef?.routeKind === 'handle-required' && identity.origin && context.browserTarget && typeof browser.eval === 'function') {
          try {
            const selectorExpr = resolvedPage === 'article'
              ? `(() => { const a = document.querySelector('a[href*="/blogs/"][href*="/"], a[href*="/articles/"]'); return a ? a.getAttribute('href') : null; })()`
              : `(() => { const a = document.querySelector('a[href*="/products/"]'); return a ? a.getAttribute('href') : null; })()`;
            const discoveredHref = await browser.eval(
              context.browserTarget,
              selectorExpr,
              identity.tabId,
              'desktop',
              { allowDegradedSurface: true }
            );
            if (typeof discoveredHref === 'string' && discoveredHref.trim()) {
              route = resolveScanRoute(resolvedPage, boundUrl, identity.origin, discoveredHref.trim());
            }
          } catch {}
        }
        if (!route && pageDef?.routeKind === 'handle-required' && identity.origin && context.browserTarget && typeof browser.dom === 'function') {
          try {
            const domRes = await browser.dom(context.browserTarget, context.runId || 'cockpit-scan', context.attemptId || '1', undefined, identity.tabId);
            const html = typeof domRes === 'string' ? domRes : '';
            const linkRe = resolvedPage === 'article'
              ? /<a\b[^>]*\bhref\s*=\s*(['"])([^'"]*\/(?:blogs\/[^'"?#]+\/|articles\/)[^'"?#]+[^'"]*)\1/i
              : /<a\b[^>]*\bhref\s*=\s*(['"])([^'"]*\/products\/[^'"?#]+[^'"]*)\1/i;
            const m = linkRe.exec(html);
            if (m?.[2]) {
              route = resolveScanRoute(resolvedPage, boundUrl, identity.origin, m[2].trim());
            }
          } catch {}
        }
        if (!route) {
          throw new CapabilityError(
            'ROUTE_UNRESOLVED',
            `theme.cockpit_scan cannot resolve a route for page '${pageLabel}' on '${identity.origin || 'unbound'}'${pageDef?.routeKind === 'handle-required' ? '; open a live /products/<handle> page on the bound tab first' : ''}`
          );
        }
        // Already on the resolved route: the QA run reloads itself, so a
        // pre-navigation would only add a second full load (toolbar mirror).
        if (route !== boundUrl) {
          const navigated = await cockpit.navigateAndWait(identity.tabId, route, COCKPIT_NAVIGATION_MS);
          if (!navigated) {
            // Scanning the stale page would report findings for the wrong URL
            // under the requested page's name — refuse instead of drifting.
            throw new CapabilityError('NAVIGATION_FAILED', `theme.cockpit_scan could not reach '${route}' on the bound tab within ${COCKPIT_NAVIGATION_MS}ms`);
          }
        }
      }
      const checklistInput = { scope: identity.scope, workspaceRoot: identity.workspaceRoot };
      const checklistBefore = identity.workspaceRoot ? loadChecklistItems(cockpit, identity.tabId, checklistInput) : undefined;
      const { baselineViewports, ...gradingOptions } = qaOptions;
      // Receipt ids are read from the host's own comparison ledger, so a cockpit scan grades
      // baselines under the same rules and provenance as theme.qa_validate.
      const baselineUrl = baselineViewports ? await browser.getLiveTabUrl(identity.tabId).catch(() => '') : '';
      const baselineResolution = baselineViewports
        ? resolveBaselineViewports(baselineViewports, {
            workspaceId: context.workspaceId ?? (context.browserTarget as BrowserTarget | undefined)?.workspaceId ?? '',
            origin: browserCaps.originOfUrl(baselineUrl),
            pathname: browserCaps.pathnameOfUrl(baselineUrl),
          })
        : undefined;
      const result = await cockpit.runThemeQa(identity.tabId, {
        ...gradingOptions,
        ...(baselineResolution?.viewports ? { viewports: baselineResolution.viewports } : {}),
        ...(baselineResolution ? { viewportProvenance: baselineResolution.provenance, viewportRejections: baselineResolution.rejections } : {}),
        workspaceRoot: confinedRoot,
      });
      const scanned = await finishScan({
        cockpit,
        browser,
        context,
        identity,
        checklistInput,
        checklistBefore,
        ok: result.ok === true,
        report: result.report,
        page: resolvedPage || inferPageKey(await browser.getLiveTabUrl(identity.tabId).catch(() => boundUrl)),
      });
      return { ok: result.ok === true, report: result.report, error: result.error, scope: identity.scope, workspaceRoot: confinedRoot, isProvisional: identity.isProvisional, ...scanned };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_findings',
    description: 'Read the latest Theme QA state row for the bound tab: status (idle, running, pass, fail, error), issueCount and report. issueCount is a number only when a finished run produced it (pass or fail). An idle, running or errored row returns issueCount: null and a reasonCode (QA_NOT_RUN, QA_RUNNING, or the failure code), so null never means that nothing was found',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: readPolicy(),
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    execute: async (_params: { tabId?: string }, context) => {
      const identity = resolveBoundScope(cockpit, _params, context, 'theme.cockpit_findings');
      const state = cockpit.getThemeQaState(identity.tabId);
      const settingsSummary = await resolveSettingsSummary(identity.workspaceRoot);
      return {
        scope: identity.scope,
        isProvisional: identity.isProvisional,
        ...state,
        ...(settingsSummary ? { settingsSummary } : {}),
      };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_report',
    description: 'Render the markdown progress report for the bound tab checklist scope (identical to the toolbar export)',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: readPolicy(),
    inputSchema: { type: 'object', properties: { ...scopeProps } },
    execute: async (params: CockpitParams, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_report');
      const loaded = cockpit.checklistLoad(identity.tabId, { scope: identity.scope, workspaceRoot: identity.workspaceRoot });
      const themeMode = detectThemeSettingsMode(identity.workspaceRoot);
      const items = adaptChecklistItems(loaded.items, themeMode);
      const settingsSummary = await resolveSettingsSummary(identity.workspaceRoot);
      return {
        markdown: buildChecklistReport(loaded.scope, items, settingsSummary),
        scope: loaded.scope,
        isProvisional: loaded.isProvisional,
        ...(settingsSummary ? { settingsSummary } : {}),
      };
    },
  });

  // ─── antifan_* aliases ────────────────────────────────────────────────────
  // Alias bodies delegate to the canonical registration, so the same schema,
  // authorization, and scope assertion run for either name (precedent:
  // antifan_theme_qa_repair_begin).
  const aliases: Array<{ alias: string; canonical: string; risk: CapabilityRisk; policy: CapabilityEffectPolicyInput }> = [
    { alias: 'antifan_cockpit_list', canonical: 'theme.cockpit_list', risk: 'read', policy: readPolicy() },
    { alias: 'antifan_cockpit_mark', canonical: 'theme.cockpit_mark', risk: 'write', policy: writePolicy() },
    { alias: 'antifan_cockpit_mark_page', canonical: 'theme.cockpit_mark_page', risk: 'write', policy: writePolicy() },
    { alias: 'antifan_cockpit_add_item', canonical: 'theme.cockpit_add_item', risk: 'write', policy: writePolicy() },
    { alias: 'antifan_cockpit_remove_item', canonical: 'theme.cockpit_remove_item', risk: 'write', policy: writePolicy() },
    { alias: 'antifan_cockpit_scan', canonical: 'theme.cockpit_scan', risk: 'read', policy: cockpitPolicy({ effect: 'interactive-effect', risk: 'read', lane: 'viewport-gate', timeoutMs: DEADLINES.toolPolicyMs }) },
    { alias: 'antifan_cockpit_findings', canonical: 'theme.cockpit_findings', risk: 'read', policy: readPolicy() },
    { alias: 'antifan_cockpit_report', canonical: 'theme.cockpit_report', risk: 'read', policy: readPolicy() },
  ];
  for (const { alias, canonical, risk, policy } of aliases) {
    const canonicalSchema = catalogue.get(canonical)?.inputSchema ?? { type: 'object' };
    catalogue.register({
      name: alias,
      description: `Alias for ${canonical}`,
      risk,
      requiresBrowserTarget: true,
      policy,
      inputSchema: canonicalSchema,
      execute: (params: Record<string, unknown>, context) => {
        const target = catalogue.get(canonical);
        if (!target) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Alias target '${canonical}' is not registered`);
        return target.execute(params, context);
      },
    });
  }
}
