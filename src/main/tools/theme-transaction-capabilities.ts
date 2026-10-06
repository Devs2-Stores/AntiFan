import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CapabilityCatalogue } from './capability-catalogue';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  BrowserTarget,
  canonicalizeWorkspaceRoot,
} from '../../shared/control-plane-contracts';
import { ThemeTransactionRegistry, RuntimeTenancyIdentity } from '../qa/theme-transaction-registry';
import { ThemeWorkspaceContext } from '../../shared/theme-task-context';
import { BrowserControlPort } from './browser-control-port';
import { ShopIdentity, resolveWorkspaceShop, probeTabShopIdentity } from '../qa/shop-identity';

export { ShopIdentity, probeTabShopIdentity } from '../qa/shop-identity';
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
  getBrowserControlPort?: BrowserControlPort | (() => BrowserControlPort | undefined)
): void {
  const resolveRoot = (
    providedRoot?: string,
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): string => {
    if (providedRoot && typeof providedRoot === 'string' && providedRoot.trim()) {
      return canonicalizeWorkspaceRoot(providedRoot);
    }
    if (getAuthoritativeWorkspaceRoot) {
      const root = getAuthoritativeWorkspaceRoot();
      if (root) return canonicalizeWorkspaceRoot(root);
    }
    if (context && context.projectId && context.workspaceId) {
      try {
        const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
        if (ws?.rootPath) return canonicalizeWorkspaceRoot(ws.rootPath);
      } catch {}
    }
    throw new CapabilityError(
      'WORKSPACE_UNBOUND',
      'Cannot resolve workspaceRoot for theme transaction capability. Provide workspaceRoot explicitly or bind workspace tenancy.'
    );
  };

  const extractTenancy = (
    context?: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): Partial<RuntimeTenancyIdentity> | undefined => {
    if (!context) return undefined;
    const runtimeId = 'lease' in context ? context.lease?.runtimeId : undefined;
    return {
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      runtimeId,
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
        const callerTenancy = extractTenancy(context);
        return await transactionRegistry.begin(
          params.context,
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
      const normalizedRelative = path.posix.normalize(params.relativePath.replace(/\\/g, '/')).replace(/^\.?\//, '').replace(/^\/+/, '').toLowerCase();
      // Security invariant: the shop-identity gate must classify the file the
      // write actually resolves to, not the caller's string. Resolve inside the
      // workspace root so traversal forms like 'config/../config/settings_data.json'
      // or './config//settings_data.json' cannot slip past the equality check.
      const resolvedRelative = path.relative(root, path.resolve(root, params.relativePath)).replace(/\\/g, '/').toLowerCase();
      const isSettingsDataPath = normalizedRelative === 'config/settings_data.json' || resolvedRelative === 'config/settings_data.json';

      if (isSettingsDataPath) {
        const session = transactionRegistry.getActiveSession(root);
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

          const callerTenancy = extractTenancy(context);
          const baseTarget: Partial<BrowserTarget> = {
            projectId: callerTenancy?.projectId,
            workspaceId: callerTenancy?.workspaceId,
            runtimeId: callerTenancy?.runtimeId,
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

      const callerTenancy = extractTenancy(context);
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
        workspaceRoot: { type: 'string', description: 'Workspace root path' },
      },
    },
    execute: async (
      params?: { workspaceRoot?: string },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const root = resolveRoot(params?.workspaceRoot, context);
      const repoRoot = resolveRepoRoot();
      const themeChecksPath = path.join(repoRoot, 'scripts', 'lib', 'theme-checks.mjs');
      // Dynamic import: scripts/lib/theme-checks.mjs is an uncompiled pure-ESM CLI module outside TypeScript rootDir.
      const themeChecksModule = await import(pathToFileURL(themeChecksPath).href);
      const {
        checkHaravanLiquidContracts,
        checkSettingsBinding,
        checkAssetReferences,
      } = themeChecksModule;

      const haravanContracts = checkHaravanLiquidContracts(root, { platform: 'haravan' });
      const settingsBinding = checkSettingsBinding(root);
      const assets = checkAssetReferences(root);

      const failures = [
        ...(haravanContracts?.failures || []),
        ...(settingsBinding?.failures || []),
        ...(assets?.localMissing?.map((m: { ref: string; files?: string[] }) => ({
          rule: 'LOCAL_ASSET_MISSING',
          file: m.files?.[0] || 'assets/',
          line: 1,
          message: `Asset '${m.ref}' not found locally`,
          detail: `Local asset missing: ${m.ref}`,
        })) || []),
      ];

      const refusals = [];
      if (settingsBinding && !settingsBinding.ok) refusals.push({ check: 'settings-binding', failures: settingsBinding.failures.length });
      if (assets && !assets.ok) refusals.push({ check: 'assets', failures: assets.localMissing.length });
      if (haravanContracts && !haravanContracts.ok) refusals.push({ check: 'haravan-contracts', failures: haravanContracts.failures.length });

      const ok = failures.length === 0;

      return {
        ok,
        failures,
        totalFailures: failures.length,
        refusals,
        settingsBinding,
        assets,
        haravanContracts,
      };
    },
  });
}
