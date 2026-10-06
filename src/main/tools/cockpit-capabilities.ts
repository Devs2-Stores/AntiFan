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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CapabilityError,
  type CapabilityRequestContext,
  type CapabilityRisk,
} from '../../shared/control-plane-contracts';
import type { CapabilityCatalogue } from './capability-catalogue';
import type { CapabilityEffectPolicyInput } from '../../shared/control-plane-contracts';
import type { BrowserControlPort } from './browser-control-port';
import type { CockpitPort, CockpitScopeIdentity } from './cockpit-port';
import type { ChecklistMutationOp } from '../qa/theme-checklist-store';
import { PlatformDetector } from '../qa/scanners/platform-detector';
import { loadOrBootstrapBaseline, evaluateSettingsRatchet, type SettingsFinding } from '../qa/settings-ratchet';
import {
  PAGE_DEFS,
  PRODUCT_PAGE_PATH,
  buildChecklistReport,
  adaptChecklistItems,
  type ThemeChecklistItem,
} from '../../shared/theme-checklist';
import { confineWorkspaceRoot } from '../qa/diagnostics-filter';
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
  topViolations: SettingsFinding[];
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

async function collectHaravanSettingsFindings(workspaceRoot: string): Promise<SettingsFinding[]> {
  const repoRoot = resolveRepoRoot();
  const themeChecksPath = path.join(repoRoot, 'scripts', 'lib', 'theme-checks.mjs');
  if (!fs.existsSync(themeChecksPath)) return [];

  try {
    const themeChecksModule = await import(pathToFileURL(themeChecksPath).href);
    const {
      checkHaravanLiquidContracts,
      checkSettingsBinding,
      checkAssetReferences,
    } = themeChecksModule;

    const haravanContracts = typeof checkHaravanLiquidContracts === 'function'
      ? checkHaravanLiquidContracts(workspaceRoot, { platform: 'haravan' })
      : null;
    const settingsBinding = typeof checkSettingsBinding === 'function'
      ? checkSettingsBinding(workspaceRoot)
      : null;
    const assets = typeof checkAssetReferences === 'function'
      ? checkAssetReferences(workspaceRoot)
      : null;

    const findings: SettingsFinding[] = [];

    if (Array.isArray(haravanContracts?.failures)) {
      for (const f of haravanContracts.failures) {
        findings.push({
          rule: f.rule || 'HARAVAN_CONTRACT_FAILURE',
          id: f.id,
          file: f.file || 'config/settings.html',
          line: f.line,
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

    return findings;
  } catch {
    return [];
  }
}

export async function resolveSettingsSummary(workspaceRoot?: string): Promise<CockpitSettingsSummary | undefined> {
  if (!workspaceRoot || !isHaravanThemeWorkspace(workspaceRoot)) {
    return undefined;
  }
  try {
    const findings = await collectHaravanSettingsFindings(workspaceRoot);
    // Non-pure ratchet: load baseline FRESH on every call so in-memory ratchet mutation
    // never leaks or drifts across invocations.
    const baseline = loadOrBootstrapBaseline(workspaceRoot, findings);
    // Cockpit is strictly READ-ONLY surface: pass { persist: false }
    const settingsRatchet = evaluateSettingsRatchet(baseline, findings, {
      workspaceRoot,
      persist: false,
    });
    return {
      ok: settingsRatchet.ok,
      newFailures: settingsRatchet.newFailures.length,
      legacyDebt: settingsRatchet.legacyDebt.length,
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
 * route is never fabricated for a page the storefront cannot serve.
 */
function resolveScanRoute(page: string, boundUrl: string, origin: string): string | null {
  const pageDef = PAGE_DEFS[page];
  if (!pageDef) return null;
  if (pageDef.routeKind === 'handle-required') {
    if (!boundUrl) return null;
    try {
      return PRODUCT_PAGE_PATH.test(new URL(boundUrl).pathname) ? boundUrl : null;
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
    description: 'Navigate the bound tab to a checklist page route and run the authoritative Theme QA scan on it',
    risk: 'read',
    requiresBrowserTarget: true,
    // Navigating the tab is a real interactive effect: the run is not replay-safe
    // (a client retry re-navigates and re-scans), so this stays out of READ_SAFE.
    policy: cockpitPolicy({ effect: 'interactive-effect', risk: 'read', lane: 'viewport-gate', timeoutMs: DEADLINES.toolPolicyMs }),
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'PAGE_DEFS page key; when omitted the tab is scanned on its current URL' },
        workspaceRoot: { type: 'string', description: 'Workspace root assertion; confined to the bound tab resolved root before the QA run' },
        tabId: { type: 'string' },
      },
    },
    execute: async (params: { page?: string; workspaceRoot?: string; tabId?: string }, context) => {
      const identity = resolveBoundScope(cockpit, params, context, 'theme.cockpit_scan');
      const boundUrl = await browser.getLiveTabUrl(identity.tabId).catch(() => '');
      const page = typeof params.page === 'string' ? params.page.trim() : '';
      if (page) {
        const pageDef = PAGE_DEFS[page];
        if (!pageDef) {
          throw new CapabilityError('INVALID_ARGUMENT', `theme.cockpit_scan page '${page}' is not a known page; expected one of ${Object.keys(PAGE_DEFS).join(', ')}`);
        }
        const route = resolveScanRoute(page, boundUrl, identity.origin);
        if (!route) {
          throw new CapabilityError(
            'ROUTE_UNRESOLVED',
            `theme.cockpit_scan cannot resolve a route for page '${page}' on '${identity.origin || 'unbound'}'${pageDef.routeKind === 'handle-required' ? '; open a live /products/<handle> page on the bound tab first' : ''}`
          );
        }
        // Already on the resolved route: the QA run reloads itself, so a
        // pre-navigation would only add a second full load (toolbar mirror).
        if (route !== boundUrl) {
          const navigated = await cockpit.navigateAndWait(identity.tabId, route, DEADLINES.toolPolicyMs);
          if (!navigated) {
            // Scanning the stale page would report findings for the wrong URL
            // under the requested page's name — refuse instead of drifting.
            throw new CapabilityError('NAVIGATION_FAILED', `theme.cockpit_scan could not reach '${route}' on the bound tab within ${DEADLINES.toolPolicyMs}ms`);
          }
        }
      }
      // A caller-supplied workspaceRoot is an assertion, not a target: outside
      // the bound root it falls back, never escapes (F4; belt under the P1
      // confine inside runThemeQa). An unresolvable bound root fails closed —
      // a candidate can't leak through the pass-through branch.
      const confinedRoot = identity.workspaceRoot
        ? confineWorkspaceRoot(params.workspaceRoot, identity.workspaceRoot)
        : '';
      const result = await cockpit.runThemeQa(identity.tabId, { workspaceRoot: confinedRoot });
      return { ok: result.ok === true, report: result.report, error: result.error, scope: identity.scope, workspaceRoot: confinedRoot, isProvisional: identity.isProvisional };
    },
  });

  catalogue.register({
    name: 'theme.cockpit_findings',
    description: 'Read the latest Theme QA state row (status, issueCount, report) for the bound tab',
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
