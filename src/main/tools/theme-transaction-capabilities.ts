import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CapabilityCatalogue } from './capability-catalogue';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  BrowserTarget,
  assertWorkspaceContained,
  canonicalizeWorkspaceRoot,
} from '../../shared/control-plane-contracts';
import { ThemeTransactionRegistry, RuntimeTenancyIdentity } from '../qa/theme-transaction-registry';
import { ThemeWorkspaceContext, assertValidThemeWorkspaceContext } from '../../shared/theme-task-context';
import { resolveTenantWorkspaceRoot } from './file-capabilities';
import { BrowserControlPort } from './browser-control-port';
import { ShopIdentity, resolveWorkspaceShop, probeTabShopIdentity } from '../qa/shop-identity';
import { PlatformDetector } from '../qa/scanners/platform-detector';
import { isHaravanThemeWorkspace } from './cockpit-capabilities';
import {
  type TerminalOwnershipPort,
  resolveTerminalCallerScope,
  assertTerminalOwnership,
} from './terminal-capabilities';

export { ShopIdentity, probeTabShopIdentity } from '../qa/shop-identity';

/** Which findings `theme.settings_check` keeps: the named files and/or the files modified since a moment. */
interface SettingsCheckScope {
  files: string[] | null;
  changedSinceMs: number | null;
  keeps(file: string | undefined): boolean;
}

const normalizeThemeFilePath = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Reads the `files` / `changedSince` arguments of `theme.settings_check`. `files` entries are confined
 * to `root` (a path that escapes it is refused, never read); the scope only filters the findings of a
 * full run, it does not shorten the run.
 */
function parseSettingsCheckScope(root: string, params: { files?: unknown; changedSince?: unknown } | undefined): SettingsCheckScope | null {
  const rawFiles = params?.files;
  const rawSince = params?.changedSince;
  if (rawFiles === undefined && rawSince === undefined) return null;

  let files: string[] | null = null;
  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.some((f) => typeof f !== 'string' || f.trim().length === 0)) {
      throw new CapabilityError('INVALID_ARGUMENT', 'theme.settings_check: files must be a non-empty array of theme file paths relative to the workspace root');
    }
    files = (rawFiles as string[]).map((entry) => {
      const relative = path.relative(root, path.resolve(root, entry.trim()));
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new CapabilityError('INVALID_ARGUMENT', `theme.settings_check: files entry '${entry}' is outside the workspace root`, {
          recovery: 'name theme files relative to workspaceRoot, for example "config/settings_schema.json"',
        });
      }
      return normalizeThemeFilePath(relative);
    });
  }

  let changedSinceMs: number | null = null;
  if (rawSince !== undefined) {
    const numeric = typeof rawSince === 'number' ? rawSince : typeof rawSince === 'string' && /^\d+$/.test(rawSince.trim()) ? Number(rawSince.trim()) : NaN;
    const parsed = Number.isFinite(numeric) ? numeric : typeof rawSince === 'string' ? Date.parse(rawSince) : NaN;
    if (!Number.isFinite(parsed)) {
      throw new CapabilityError('INVALID_ARGUMENT', 'theme.settings_check: changedSince must be an ISO timestamp or epoch milliseconds');
    }
    changedSinceMs = parsed;
  }

  const mtimes = new Map<string, number | null>();
  const mtimeOf = (file: string): number | null => {
    if (!mtimes.has(file)) {
      try {
        mtimes.set(file, fs.statSync(path.join(root, file)).mtimeMs);
      } catch {
        mtimes.set(file, null);
      }
    }
    return mtimes.get(file) ?? null;
  };
  return {
    files,
    changedSinceMs,
    keeps: (file) => {
      if (typeof file !== 'string' || file.length === 0) return false;
      const normalized = normalizeThemeFilePath(file);
      if (files && !files.includes(normalized)) return false;
      if (changedSinceMs !== null) {
        const modified = mtimeOf(normalized);
        if (modified === null || modified < changedSinceMs) return false;
      }
      return true;
    },
  };
}

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

export function registerThemeTransactionCapabilities(
  catalogue: CapabilityCatalogue,
  transactionRegistry: ThemeTransactionRegistry,
  getAuthoritativeWorkspaceRoot?: () => string,
  getBrowserControlPort?: BrowserControlPort | (() => BrowserControlPort | undefined),
  terminalOwnership?: TerminalOwnershipPort
): void {
  /** Attached root of the caller's own workspace (projectId + workspaceId). */
  const resolveCallerRoot = (context?: CapabilityRequestContext | AuthenticatedCapabilityContext): string => {
    try {
      return canonicalizeWorkspaceRoot(resolveTenantWorkspaceRoot(catalogue, context, getAuthoritativeWorkspaceRoot));
    } catch (err) {
      if (err instanceof CapabilityError && (err.code === 'PROJECT_MISMATCH' || err.code === 'WORKSPACE_MISMATCH')) {
        throw new CapabilityError('WORKSPACE_UNBOUND', `Project tenancy mismatch: ${err.message}`);
      }
      throw err;
    }
  };

  /**
   * Root a transaction operates on: the caller's workspace root, or a directory
   * inside it named by `providedRoot`. Both sides go through realpath, so a
   * junction inside the workspace cannot carry a transaction outside it, and
   * one project can never lock, write or roll back another project's files.
   */
  const resolveRoot = (
    providedRoot: string | undefined,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): string => {
    const callerRoot = resolveCallerRoot(context);
    if (!providedRoot || typeof providedRoot !== 'string' || !providedRoot.trim()) return callerRoot;
    const candidate = canonicalizeWorkspaceRoot(path.resolve(callerRoot, providedRoot.trim()));
    try {
      return assertWorkspaceContained(callerRoot, candidate, true);
    } catch (err) {
      if (err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE') {
        throw new CapabilityError(
          'OUTSIDE_WORKSPACE',
          `workspaceRoot "${providedRoot}" is outside the caller's workspace "${callerRoot}"; a theme transaction may only run inside the workspace of the session that calls it`,
          { workspaceRoot: providedRoot, callerRoot }
        );
      }
      throw err;
    }
  };

  const extractTenancy = (
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): RuntimeTenancyIdentity => {
    if (!context || !context.projectId || !context.workspaceId) {
      throw new CapabilityError(
        'WORKSPACE_UNBOUND',
        'Theme transaction requests must carry projectId and workspaceId tenancy.'
      );
    }
    return {
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      runtimeId: ('lease' in context ? context.lease?.runtimeId : undefined) ?? '',
    };
  };

  catalogue.register({
    name: 'theme.transaction.begin',
    description: 'Begin an atomic ThemeMutationSession: creates immutable R0 snapshot and acquires exclusive workspace lock',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'object',
          description: 'Theme workspace context',
          properties: {
            storeId: { type: 'string' },
            storeDomain: { type: 'string' },
            themeId: { type: 'string' },
            workspaceRoot: { type: 'string' },
            targetTabId: { type: 'string' },
            platform: { type: 'string', enum: ['haravan', 'sapo', 'shopify'] },
          },
          required: ['storeId', 'storeDomain', 'themeId', 'workspaceRoot', 'targetTabId', 'platform'],
        },
        policy: {
          type: 'string',
          enum: ['HARD_FAIL_ROLLBACK', 'EXPLORATORY_HOLD', 'PERMISSIVE'],
        },
        initialBrowserEpoch: { type: 'number' },
        initialDocGen: { type: 'number' },
      },
      required: ['context'],
    },
    execute: async (
      params: {
        context: ThemeWorkspaceContext;
        policy?: 'HARD_FAIL_ROLLBACK' | 'EXPLORATORY_HOLD' | 'PERMISSIVE';
        initialBrowserEpoch?: number;
        initialDocGen?: number;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.context) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameter "context" is required for theme.transaction.begin');
      }
      try {
        assertValidThemeWorkspaceContext(params.context);
        const callerTenancy = extractTenancy(context);
        // The session snapshots and writes through this root, so it must be the
        // confined realpath, never the caller's raw string.
        const root = resolveRoot(params.context.workspaceRoot, context);
        return await transactionRegistry.begin(
          { ...params.context, workspaceRoot: root },
          callerTenancy,
          {
            policy: params.policy,
            initialBrowserEpoch: params.initialBrowserEpoch,
            initialDocGen: params.initialDocGen,
          }
        );
      } catch (err) {
        if (err instanceof CapabilityError) throw err;
        throw new CapabilityError('INVALID_ARGUMENT', err instanceof Error ? err.message : String(err));
      }
    },
  });

  catalogue.register({
    name: 'theme.transaction.write_cas',
    description: 'Execute an atomic Compare-And-Swap (CAS) write within the active ThemeMutationSession',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        relativePath: { type: 'string', description: 'Relative file path within workspace' },
        content: { type: 'string', description: 'File content to write' },
        expectedSha256: { type: 'string', description: 'Expected sha256 hash of existing file' },
        targetTabId: { type: 'string', description: 'Target tab ID for storefront shop validation' },
      },
      required: ['relativePath', 'content'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        relativePath: string;
        content: string;
        expectedSha256?: string;
        targetTabId?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.relativePath || typeof params.content !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameters "relativePath" and "content" are required for theme.transaction.write_cas');
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      const session = transactionRegistry.assertSessionOwner(root, callerTenancy);
      const normalizedRelative = path.posix.normalize(params.relativePath.replace(/\\/g, '/')).replace(/^\.?\//, '').replace(/^\/+/, '').toLowerCase();
      // Security invariant: the shop-identity gate must classify the file the
      // write actually resolves to, not the caller's string. Resolve inside the
      // workspace root so traversal forms like 'config/../config/settings_data.json'
      // or './config//settings_data.json' cannot slip past the equality check.
      const resolvedRelative = path.relative(root, path.resolve(root, params.relativePath)).replace(/\\/g, '/').toLowerCase();
      const isSettingsDataPath = normalizedRelative === 'config/settings_data.json' || resolvedRelative === 'config/settings_data.json';

      if (isSettingsDataPath) {
        const isHaravan =
          session?.context?.platform === 'haravan' ||
          fs.existsSync(path.join(root, '.haravan-cli_local.json')) ||
          resolveWorkspaceShop(root) !== null;

        if (isHaravan) {
          const workspaceShop = resolveWorkspaceShop(root);
          if (workspaceShop === null) {
            throw new CapabilityError(
              'WORKSPACE_SHOP_UNBOUND',
              'Cannot mutate config/settings_data.json: workspace lacks valid (org_id, theme_id) in .haravan-cli_local.json.'
            );
          }

          const rawTabId = params.targetTabId !== undefined ? params.targetTabId : session?.context?.targetTabId;
          const targetTabId = typeof rawTabId === 'string' ? rawTabId.trim() : '';
          if (!targetTabId) {
            throw new CapabilityError(
              'TARGET_TAB_REQUIRED',
              'Mutating config/settings_data.json requires targetTabId affiliated with the matching storefront shop.'
            );
          }
          const explicitBrowser = typeof getBrowserControlPort === 'function' ? getBrowserControlPort() : getBrowserControlPort;
          const registryWithBrowser = transactionRegistry as unknown as { browserPort?: BrowserControlPort };
          const browser = explicitBrowser || registryWithBrowser.browserPort;
          if (!browser) {
            throw new CapabilityError(
              'TAB_SHOP_UNVERIFIED',
              `Target tab ${targetTabId} does not expose a verifiable Haravan storefront identity. Write refused.`
            );
          }

          const baseTarget: Partial<BrowserTarget> = {
            projectId: callerTenancy.projectId,
            workspaceId: callerTenancy.workspaceId,
            runtimeId: callerTenancy.runtimeId,
            tabId: targetTabId,
            browserEpoch: 1,
            documentGeneration: 1,
          };
          const tabShop = await probeTabShopIdentity(browser, targetTabId, baseTarget);
          if (tabShop === null) {
            throw new CapabilityError(
              'TAB_SHOP_UNVERIFIED',
              `Target tab ${targetTabId} does not expose a verifiable Haravan storefront identity. Write refused.`
            );
          }

          if (tabShop.orgId !== workspaceShop.orgId || tabShop.themeId !== workspaceShop.themeId) {
            throw new CapabilityError(
              'SHOP_IDENTITY_MISMATCH',
              `Target tab belongs to shop org=${tabShop.orgId} theme=${tabShop.themeId}, but workspace is org=${workspaceShop.orgId} theme=${workspaceShop.themeId}. Write refused.`
            );
          }
        }
      }

      return await transactionRegistry.writeCAS(
        root,
        {
          relativePath: params.relativePath,
          content: params.content,
          expectedSha256: params.expectedSha256,
        },
        callerTenancy
      );
    },
  });

  catalogue.register({
    name: 'theme.transaction.await_sync_and_reload',
    description:
      'Await Haravan theme dev watcher upload acknowledgment and reload the bound tab so the transaction reaches state settled (required before settle("VERIFIED")). Obtain cursor BEFORE theme.transaction.write_cas by calling terminal.list and reading the hrv theme dev session id (sessionId), sessionGeneration, and snapshotThroughSeq (baselineSeq).',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: true,
      schedulerLane: 'viewport-gate',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        cursor: {
          type: 'object',
          description:
            'Pre-mutation terminal sync cursor from terminal.list (sessionId = id, sessionGeneration, baselineSeq = snapshotThroughSeq)',
          properties: {
            sessionId: { type: 'string' },
            sessionGeneration: { type: 'number' },
            baselineSeq: { type: 'number' },
          },
          required: ['sessionId', 'sessionGeneration', 'baselineSeq'],
        },
        pattern: { type: 'string', description: 'Optional upload acknowledgment regex override' },
        timeoutMs: { type: 'number', description: 'Optional sync wait timeout in ms (default 15000)' },
        tabId: { type: 'string', description: 'Optional target tab ID' },
      },
      required: ['cursor'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        cursor: {
          sessionId: string;
          sessionGeneration: number;
          baselineSeq: number;
        };
        pattern?: string;
        timeoutMs?: number;
        tabId?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.cursor) {
        throw new CapabilityError(
          'INVALID_ARGUMENT',
          'Parameter "cursor" is required for theme.transaction.await_sync_and_reload'
        );
      }
      if (!context || !context.browserTarget || !context.browserTarget.tabId) {
        throw new CapabilityError(
          'TARGET_REQUIRED',
          'theme.transaction.await_sync_and_reload requires a bound browser target'
        );
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      assertTerminalOwnership(
        resolveTerminalCallerScope(terminalOwnership, context),
        params.cursor.sessionId
      );
      const target: BrowserTarget =
        typeof params.tabId === 'string' && params.tabId.trim()
          ? { ...context.browserTarget, tabId: params.tabId.trim() }
          : context.browserTarget;
      return await transactionRegistry.awaitSyncAndReload(
        root,
        target,
        {
          cursor: params.cursor,
          pattern: params.pattern,
          timeoutMs: params.timeoutMs,
        },
        callerTenancy
      );
    },
  });

  catalogue.register({
    name: 'theme.transaction.settle',
    description: 'Settle an active ThemeMutationSession with VERIFIED, REJECTED, or HELD verdict',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        verdict: { type: 'string', enum: ['VERIFIED', 'REJECTED', 'HELD'] },
        details: { type: 'object', description: 'Settlement details' },
      },
      required: ['verdict'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        verdict: 'VERIFIED' | 'REJECTED' | 'HELD';
        details?: Record<string, unknown>;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || !params.verdict) {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameter "verdict" is required for theme.transaction.settle');
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.settle(root, params.verdict, params.details, callerTenancy);
    },
  });

  catalogue.register({
    name: 'theme.transaction.rollback',
    description: 'Roll back an active ThemeMutationSession to its R0 snapshot',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        reason: { type: 'string', description: 'Reason for rollback' },
      },
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        reason?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const root = resolveRoot(params?.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.rollback(root, params?.reason, callerTenancy);
    },
  });

  catalogue.register({
    name: 'theme.transaction.resolve_hold',
    description: 'Resolve a held quarantine ThemeMutationSession by rolling back to R0',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
        action: { type: 'string', enum: ['rollback'] },
        reason: { type: 'string', description: 'Reason for resolving hold' },
      },
      required: ['action'],
    },
    execute: async (
      params: {
        workspaceRoot?: string;
        action: 'rollback';
        reason?: string;
      },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params || params.action !== 'rollback') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Parameter "action" must be "rollback" for theme.transaction.resolve_hold');
      }
      const root = resolveRoot(params.workspaceRoot, context);
      const callerTenancy = extractTenancy(context);
      return await transactionRegistry.resolveHold(root, params.action, params.reason, callerTenancy);
    },
  });

  catalogue.register({
    name: 'theme.settings_check',
    description: 'Run offline Haravan theme settings, binding, and asset reference checks without requiring a browser tab',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'public',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Theme workspace root; defaults to the authoritative workspace' },
        files: { type: 'array', items: { type: 'string' }, description: 'Theme files (relative to workspaceRoot) whose findings to keep. Filters the result; it does not shorten the run. A path that escapes workspaceRoot is refused' },
        changedSince: { type: ['string', 'number'], description: 'ISO timestamp or epoch milliseconds; keeps only findings for files modified at or after it. Filters the result; it does not shorten the run' },
      },
    },
    execute: async (
      params?: { workspaceRoot?: string; files?: string[]; changedSince?: string | number },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      // Read-only offline check: any named theme directory may be inspected;
      // a relative workspaceRoot resolves against the caller's workspace (never
      // process.cwd() or the boot runtime's).
      const callerRoot = resolveCallerRoot(context);
      const providedRoot = typeof params?.workspaceRoot === 'string' ? params.workspaceRoot.trim() : '';
      const root = providedRoot
        ? canonicalizeWorkspaceRoot(path.resolve(callerRoot, providedRoot))
        : callerRoot;
      const scope = parseSettingsCheckScope(root, params);
      const repoRoot = resolveRepoRoot();
      const themeChecksPath = path.join(repoRoot, 'scripts', 'lib', 'theme-checks.mjs');
      // Dynamic import: scripts/lib/theme-checks.mjs is an uncompiled pure-ESM CLI module outside TypeScript rootDir.
      const themeChecksModule = await import(pathToFileURL(themeChecksPath).href);
      const {
        checkHaravanLiquidContracts,
        validateThemeSchemas,
        checkSettingsBinding,
        checkAssetReferences,
        checkF1genzSettingsSchema,
      } = themeChecksModule;

      const isHaravan = isHaravanThemeWorkspace(root);
      const hasSettingsSchema = fs.existsSync(path.join(root, 'config', 'settings_schema.json'));
      const detectedPlatform = isHaravan
        ? 'haravan'
        : PlatformDetector.detectFromWorkspace(root).platform;
      const haravanContracts = isHaravan
        ? checkHaravanLiquidContracts(root, { platform: 'haravan' })
        : { ok: true, failures: [] };
      const schemaValidation = typeof validateThemeSchemas === 'function'
        ? validateThemeSchemas(root, {
            platform: detectedPlatform !== 'unknown' ? detectedPlatform : null,
            schemaRequired: hasSettingsSchema,
          })
        : null;
      const settingsBinding = checkSettingsBinding(root);
      const assets = checkAssetReferences(root);
      const f1genzSchema =
        isHaravan && hasSettingsSchema && typeof checkF1genzSettingsSchema === 'function'
          ? checkF1genzSettingsSchema(root)
          : null;

      const contractFailures: Array<{ rule: string; file?: string }> = haravanContracts?.failures || [];
      const schemaFailures = (schemaValidation?.failures || [])
        .filter(
          (f: { rule: string; path?: string }) =>
            !contractFailures.some(
              (cf) => cf.rule === f.rule && cf.file === (f.path || 'config/settings_schema.json')
            )
        )
        .map((f: { rule: string; path?: string; detail: string; line?: number; pointer?: string }) => ({
          rule: f.rule,
          file: f.path || 'config/settings_schema.json',
          ...(f.line !== undefined ? { line: f.line } : {}),
          ...(f.pointer ? { pointer: f.pointer } : {}),
          message: f.detail,
          detail: f.detail,
        }));
      const f1genzFailures = (f1genzSchema?.failures || []).map(
        (f: { rule: string; id?: string; file?: string; line?: number; pointer?: string; message: string }) => ({
          rule: f.rule,
          ...(f.id ? { id: f.id } : {}),
          file: f.file || 'config/settings_schema.json',
          ...(f.line ? { line: f.line } : {}),
          ...(f.pointer ? { pointer: f.pointer } : {}),
          message: f.message,
          detail: f.message,
        })
      );
      const deadSettingFindings = (settingsBinding?.dead || [])
        .filter(
          (d: { id: string }) =>
            !f1genzFailures.some((f: { rule: string; id?: string }) => f.rule === 'dead-setting' && f.id === d.id)
        )
        .map((d: { id: string; line?: number; pointer?: string }) => ({
          rule: 'dead-setting',
          id: d.id,
          file: hasSettingsSchema ? 'config/settings_schema.json' : 'config/settings.html',
          ...(d.line ? { line: d.line } : {}),
          ...(d.pointer ? { pointer: d.pointer } : {}),
          message: `schema setting has no resolved reference: ${d.id}`,
          detail: `Declared setting '${d.id}' is never referenced in theme Liquid files`,
        }));
      // Haravan reads every schema setting through the theme, so an unread one is dead. Other
      // platforms read some settings themselves (Shopify checkout_*), so there it is a warning.
      const deadSettingFailures = isHaravan ? deadSettingFindings : [];
      const warnings = isHaravan ? [] : deadSettingFindings;
      const failures = [
        ...(haravanContracts?.failures || []),
        ...schemaFailures,
        ...(settingsBinding?.failures || []),
        ...f1genzFailures,
        ...deadSettingFailures,
        ...(assets?.localMissing?.map((m: { ref: string; files?: string[] }) => ({
          rule: 'LOCAL_ASSET_MISSING',
          file: m.files?.[0] || 'assets/',
          line: 1,
          message: `Asset '${m.ref}' not found locally`,
          detail: `Local asset missing: ${m.ref}`,
        })) || []),
      ];

      const kept = <T extends { file?: string }>(items: T[]): T[] => (scope ? items.filter((item) => scope.keeps(item.file)) : items);
      const scopedFailures = kept(failures);
      const scopedDeadFailures = kept(deadSettingFailures);
      const scopedF1genz = kept(f1genzFailures);
      const scopedSchema = kept(schemaFailures);
      const scopedBinding = kept<{ file?: string }>(settingsBinding?.failures || []);
      const scopedContracts = kept<{ file?: string }>(haravanContracts?.failures || []);
      const scopedMissing = scope
        ? (assets?.localMissing || []).filter((m: { files?: string[] }) => scope.keeps(m.files?.[0] || 'assets/'))
        : assets?.localMissing || [];

      const refusals = [];
      if (settingsBinding && (scope ? scopedBinding.length > 0 : !settingsBinding.ok)) {
        refusals.push({ check: 'settings-binding', failures: scopedBinding.length });
      }
      if (scopedF1genz.length + scopedDeadFailures.length > 0) {
        refusals.push({ check: 'f1genz-settings-schema', failures: scopedF1genz.length + scopedDeadFailures.length });
      }
      if (assets && (scope ? scopedMissing.length > 0 : !assets.ok)) refusals.push({ check: 'assets', failures: scopedMissing.length });
      if (haravanContracts && (scope ? scopedContracts.length > 0 : !haravanContracts.ok)) {
        refusals.push({ check: 'haravan-contracts', failures: scopedContracts.length });
      }
      if (scopedSchema.length > 0) refusals.push({ check: 'theme-schemas', failures: scopedSchema.length });

      const deadInSchema = Array.isArray(settingsBinding?.dead) ? settingsBinding.dead.length : 0;
      const ok = scopedFailures.length === 0;
      const scopedWarnings = kept(warnings);

      if (scope) {
        // The scope filters the findings of a full run, so the unscoped detail payloads are not returned:
        // they would still carry the findings the scope removed.
        return {
          ok,
          failures: scopedFailures,
          totalFailures: scopedFailures.length,
          unscopedTotalFailures: failures.length,
          deadInSchema,
          ...(scopedWarnings.length > 0 ? { warnings: scopedWarnings } : {}),
          refusals,
          scope: {
            ...(scope.files ? { files: scope.files } : {}),
            ...(scope.changedSinceMs !== null ? { changedSince: new Date(scope.changedSinceMs).toISOString() } : {}),
            note: 'findings are filtered to the scope; the run itself still covered the whole theme',
          },
        };
      }

      return {
        ok,
        failures,
        totalFailures: failures.length,
        deadInSchema,
        ...(warnings.length > 0 ? { warnings } : {}),
        refusals,
        settingsBinding,
        assets,
        haravanContracts,
        ...(schemaValidation ? { schemaValidation } : {}),
        ...(f1genzSchema ? { f1genzSchema } : {}),
      };
    },
  });
}
