import * as fs from 'node:fs';
import { parseOwnerKey } from '../project/project-context';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { recordBenchmark } from '../benchmark/telemetry';
import { ChatStore } from '../chat/chat-store';
import { ProjectRegistry } from '../project/project-registry';
import { WorkspaceRegistry } from '../project/workspace-registry';
import { RunService } from '../run/run-service';
import { EventStore } from '../session/event-store';
import { ReceiptStore, type ReceiptStoreStats } from '../session/receipt-store';
import { InvocationLedger, type InvocationLedgerStats } from '../session/invocation-ledger';
import { ArtifactStore, type ArtifactStoreOptions, type ArtifactStoreStats } from '../tools/artifact-store';
import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { BrowserControlPort } from '../tools/browser-control-port';
import { registerBrowserCapabilities } from '../tools/browser-capabilities';
import { registerDeviceCapabilities } from '../tools/device-capabilities';
import type { DeviceControlPort, DeviceRegistryPort } from '../device/device-control-port';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { registerFileCapabilities } from '../tools/file-capabilities';
import { registerArtifactCapabilities } from '../tools/artifact-capabilities';
import { registerTerminalCapabilities, type TerminalHostAuthority, type TerminalOwnershipPort } from '../tools/terminal-capabilities';
import { registerCoreCapabilities, createLazyCorePort } from '../tools/core-capabilities';
import { registerWorkflowCapabilities } from '../workflow/workflow-capabilities';
import { WorkflowRegistry } from '../workflow/workflow-registry';
import { TerminalManager, type TerminalManagerStats } from '../browser/terminal-manager';
import { WorkflowEngine } from '../workflow/workflow-engine';
import { assertExactBrowserTarget, BrowserTarget, CapabilityError, CapabilityRequestContext, issueRuntimeLease, RuntimeFeatureSwitch, RuntimeLease, WorkspaceRecord } from '../../shared/control-plane-contracts';
import { WorkflowDefinition, WorkflowExecutionResult, WorkflowEventListener } from '../workflow/workflow-schema';
import { ThemeQaWorkflow, ThemeQaReport } from '../qa/theme-qa-workflow';
import { ThemeTransactionRegistry } from '../qa/theme-transaction-registry';
import { registerThemeTransactionCapabilities } from '../tools/theme-transaction-capabilities';

export interface ControlPlaneRuntimeOptions {
  projectId: string;
  workspaceId: string;
  dataRoot: string;
  workspaceRoot?: string;
  runtimeId?: string;
  hostEpoch?: number;
  allowEval?: boolean;
  projects?: ProjectRegistry;
  workspaces?: WorkspaceRegistry;
  getDocumentGeneration?: (tabId?: string) => number;
  getAutomationTabId?: () => string | null;
  isTabAllowed?: (primaryTabId: string, requestedTabId: string) => boolean;
  resolveTabId?: (tabIdOrIdentifier: string) => string | undefined;
  resolveFailoverTabId?: (staleTabId: string) => string | undefined;
  releaseSessionTab?: (sessionId: string, tabId: string) => boolean;
  releaseSessionTabPool?: (sessionId: string) => boolean;
  browserControlPort?: BrowserControlPort;
  /**
   * Canonical single TerminalManager owned by the composition root (src/main/index.ts).
   * Required in production so the control plane registers terminal capabilities against
   * the one instance the UI, Bridge, and NativeTabHost share. Falls back to the global
   * instance only for test helpers that don't construct a full composition root.
   */
  terminal?: TerminalManager;
  /**
   * Host-side tab authority (live browser-tab affinity of a terminal) the runtime joins to its own
   * attachment registry so an attachment-bound terminal call is scoped to the terminals its tab
   * owns. Omitted in test helpers that construct a runtime without the host; an attachment-bound
   * call is then refused rather than allowed unverified.
   */
  terminalAuthority?: TerminalHostAuthority;
  /**
   * Terminal session → owning project/workspace, measured by the composition root
   * (terminal capsule → capsule affiliation, with owner-key fallback inside the
   * runtime). A `createCliSession` carrying `terminalSessionId` is minted under
   * this scope — never under a cwd-derived or caller-claimed one — and is refused
   * when the terminal cannot be attributed.
   */
  resolveTerminalProjectScope?: (terminalSessionId: string) => { projectId: string; workspaceId: string } | undefined;
  /**
   * Measured capsule affiliation of a tab (same probe the browser port uses for
   * routed tab creation). Terminal-origin sessions refuse a bound/provisioned tab
   * that measures in a different project than the terminal resolved to.
   */
  resolveTabAffiliation?: (tabId: string) => { projectId?: string; workspaceId?: string; capsuleId?: string } | undefined;
  /**
   * Artifact capacity overrides (root is always owned by the runtime). Populated ONLY by explicit
   * canary/benchmark startup configuration; production leaves it undefined so the default limits stand.
   */
  artifactStoreOptions?: Omit<ArtifactStoreOptions, 'root'>;
}

/**
 * Artifact capacity/retention options for the production runtime. Retention is enabled
 * unconditionally: the store exempts permanent report evidence, so the sweep can only prune
 * captures that exceed the age or byte ceilings. Env vars tune those ceilings and are applied
 * on top; non-numeric values are ignored so production limits stay untouched.
 */
export function resolveArtifactStoreOptionsFromEnv(env: Record<string, string | undefined> = process.env): Omit<ArtifactStoreOptions, 'root'> {
  const parsePositiveInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
    return parsed;
  };
  const maxArtifactBytes = parsePositiveInt(env.ANTIFAN_ARTIFACT_MAX_ARTIFACT_BYTES);
  const maxRunBytes = parsePositiveInt(env.ANTIFAN_ARTIFACT_MAX_RUN_BYTES);
  const overrides: Omit<ArtifactStoreOptions, 'root'> = { enableRetentionCleaner: true };
  if (maxArtifactBytes !== undefined) overrides.maxArtifactBytes = maxArtifactBytes;
  if (maxRunBytes !== undefined) overrides.maxRunBytes = maxRunBytes;
  return overrides;
}

export interface ControlPlaneResourceStats {
  artifacts: ArtifactStoreStats;
  invocations: InvocationLedgerStats;
  receipts: ReceiptStoreStats;
  terminal: TerminalManagerStats;
}


export class ControlPlaneRuntime {
  readonly projects: ProjectRegistry;
  readonly workspaces: WorkspaceRegistry;
  readonly chats = new ChatStore();
  readonly events: EventStore;
  readonly receipts: ReceiptStore;
  readonly ledger: InvocationLedger;
  readonly artifacts: ArtifactStore;
  readonly runs: RunService;
  readonly files: WorkspaceFilePort;
  readonly capabilities: CapabilityCatalogue;
  readonly transport: CapabilityTransportAdapter;
  readonly terminal: TerminalManager;
  readonly themeTransactions: ThemeTransactionRegistry;
  readonly workflowEngine: WorkflowEngine;
  readonly workflowRegistry: WorkflowRegistry;
  private leaseState: RuntimeLease;
  private switchState: RuntimeFeatureSwitch = { mode: 'standalone', lifecycle: 'active' };
  private workspaceRoot: string;
  private readonly dataRoot: string;
  private readonly isDefaultWorkspaceSynthesized: boolean;
  private themeQaWorkflow: ThemeQaWorkflow | null = null;
  /**
   * Physical-device execution surface. Null until `registerDevice` runs: the adapter needs the host's
   * lease and artifact store, which only exist once the owning runtime is constructed.
   */
  private devicePort: DeviceControlPort | null = null;
  private deviceManager: DeviceRegistryPort | null = null;
  private readonly resolveTerminalProjectScopeOption?: (terminalSessionId: string) => { projectId: string; workspaceId: string } | undefined;
  private readonly resolveTabAffiliationOption?: (tabId: string) => { projectId?: string; workspaceId?: string; capsuleId?: string } | undefined;
  // Memoized workspace-root resolution: wether resolving from a workspace record
  // or the fallback chain, the sync fs.existsSync checks only need to run once
  // per (workspaceId, explicitRoot) pair. Invalidation is explicit below.
  private cachedWorkspaceRoot: string | null = null;
  private cachedWorkspaceKey: string = '';
  constructor(options: ControlPlaneRuntimeOptions) {
    this.projects = options.projects || new ProjectRegistry();
    this.workspaces = options.workspaces || new WorkspaceRegistry(this.projects);
    this.dataRoot = path.resolve(options.dataRoot);
    const dataRootResolved = this.dataRoot;
    const dataParentResolved = path.resolve(dataRootResolved, '..');
    this.isDefaultWorkspaceSynthesized = !(options.workspaceRoot && typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim().length > 0);

    const resolveInitialWorkspaceRoot = (): string => {
      if (options.workspaceRoot && typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim().length > 0) {
        const candidate = path.resolve(options.workspaceRoot.trim());
        if (candidate !== dataRootResolved && candidate !== dataParentResolved) {
          return candidate;
        }
      }
      const envRoot = process.env.THEME_WORKSPACE_ROOT || process.env.ANTIFAN_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
      if (envRoot && typeof envRoot === 'string' && envRoot.trim().length > 0 && fs.existsSync(envRoot)) {
        const candidate = path.resolve(envRoot.trim());
        if (candidate !== dataRootResolved && candidate !== dataParentResolved) {
          return candidate;
        }
      }
      // Underlying default fix: no dataRoot parent as workspace; unbound root remains empty.
      return '';
    };

    const initialWorkspaceRoot = resolveInitialWorkspaceRoot();
    if (options.projectId && options.workspaceId) {
      this.workspaces.ensureInitialWorkspace(
        options.projectId,
        options.workspaceId,
        initialWorkspaceRoot,
        options.dataRoot
      );
    }
    this.events = new EventStore({ filePath: path.join(options.dataRoot, 'events.jsonl'), projectId: options.projectId, workspaceId: options.workspaceId });
    this.receipts = new ReceiptStore({ filePath: path.join(options.dataRoot, 'receipts.jsonl') });
    this.ledger = new InvocationLedger({ dataRoot: options.dataRoot });
    this.artifacts = new ArtifactStore({ root: path.join(options.dataRoot, 'artifacts'), ...options.artifactStoreOptions });
    this.workspaceRoot = initialWorkspaceRoot;
    this.leaseState = issueRuntimeLease(options.projectId, options.workspaceId, 30_000, options.hostEpoch ?? 1);
    this.runs = new RunService(
      this.chats,
      this.events,
      this.receipts,
      (wsId: string, pId: string) => {
        return this.workspaces.get(wsId, pId).rootPath;
      },
      undefined,
      () => this.leaseState.hostEpoch,
      options.getDocumentGeneration,
      options.getAutomationTabId,
      options.dataRoot,
      (record: any, reqTabId: string) => {
        if (!record?.tabId) return true;
        if (record.tabId === reqTabId) return true;
        if (record.allowedTabIds && record.allowedTabIds.has(reqTabId)) return true;
        return options.isTabAllowed ? options.isTabAllowed(record.tabId, reqTabId) : false;
      },
      options.releaseSessionTab,
      options.releaseSessionTabPool
    );
    this.files = new WorkspaceFilePort();
    this.capabilities = new CapabilityCatalogue({
      runtime: this.switchState,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      runtimeId: this.leaseState.runtimeId,
      hostEpoch: options.hostEpoch ?? 1,
      allowEval: options.allowEval ?? true,
      getActiveLease: () => this.getLease(),
      workspaceRegistry: this.workspaces,
      isTabAllowed: options.isTabAllowed,
      resolveTabId: options.resolveTabId,
      resolveFailoverTabId: options.resolveFailoverTabId,
      getDocumentGeneration: options.getDocumentGeneration,
      // Read lazily at dispatch time: the device adapter registers after this runtime is constructed,
      // so the binding must be resolved per request rather than captured here.
      getDeviceBinding: () => this.deviceManager?.getLiveBinding(),
    });
    this.transport = new CapabilityTransportAdapter(this.capabilities, this.runs.attachments, this.ledger);
    this.terminal = options.terminal ?? TerminalManager.getInstance();
    this.resolveTerminalProjectScopeOption = options.resolveTerminalProjectScope;
    this.resolveTabAffiliationOption = options.resolveTabAffiliation;
    // Terminal-origin scope gates on the attachment registry: minting records the
    // terminal id, and every later validate re-measures it through these seams. Only a
    // measured scope answers here — an unattributed terminal is never stamped with an
    // origin, so the registry never has to re-measure one.
    this.runs.attachments.setTerminalProjectScopeResolver((terminalSessionId) => {
      const scope = this.resolveTerminalScope(terminalSessionId);
      return scope.kind === 'measured' ? { projectId: scope.projectId, workspaceId: scope.workspaceId } : undefined;
    });
    this.runs.attachments.setTabAffiliationResolver(this.resolveTabAffiliationOption);
    this.themeTransactions = new ThemeTransactionRegistry(
      { projectId: options.projectId, workspaceId: options.workspaceId, runtimeId: this.leaseState.runtimeId },
      this.files,
      this.terminal,
      options.browserControlPort
    );
    registerFileCapabilities(this.capabilities, this.files, () => this.getWorkspaceRoot(), this.themeTransactions);
    registerThemeTransactionCapabilities(this.capabilities, this.themeTransactions, () => this.getWorkspaceRoot());
    registerArtifactCapabilities(this.capabilities, this.artifacts);
    registerTerminalCapabilities(this.capabilities, this.terminal, this.composeTerminalOwnership(options.terminalAuthority));
    registerCoreCapabilities(this.capabilities, createLazyCorePort());
    this.workflowRegistry = new WorkflowRegistry(path.join(options.dataRoot, 'workflows'));
    this.workflowEngine = new WorkflowEngine({
      catalogue: this.capabilities,
      artifacts: this.artifacts,
    });
    registerWorkflowCapabilities(this.capabilities, this.workflowEngine);
  }

  /**
   * Bind the host's tab authority to this runtime's attachment registry.
   *
   * Ownership has exactly one source of truth per plane: the attachment registry knows which browser
   * tab an attachment is bound to, the host knows which tab currently drives which terminal. Joining
   * them here is what lets an agent-created filter "the terminals I own" without a second, drifting
   * ownership record — and what makes a foreign project's live shell unreachable by construction
   * rather than by a policy check somewhere else.
   */
  private composeTerminalOwnership(host?: TerminalHostAuthority): TerminalOwnershipPort | undefined {
    if (!host) return undefined;
    return {
      ownerTabId: (attachmentId) => {
        const record = this.runs.attachments.getRecord(attachmentId);
        return record?.tabId || record?.browserTarget?.tabId;
      },
      allowsTab: (tabId, terminalId) => host.allowsTab(tabId, terminalId),
      isAgentTerminal: (terminalId) => host.isAgentTerminal(terminalId),
      bind: (terminalId, generation, tabId) => host.bind(terminalId, generation, tabId),
    };
  }
  public async initialize(): Promise<void> {
    const t0 = performance.now();
    await this.runs.attachments.initialize(this.leaseState.runtimeId);
    const t1 = performance.now();
    await this.ledger.initialize();
    const t2 = performance.now();
    try {
      const activeIds = this.runs.attachments.getActiveRecordIds();
      await this.ledger.pruneDeadPartitions(activeIds);
    } catch {}
    const t3 = performance.now();
    recordBenchmark({ surface: 'startup', name: 'cpInitBreakdown', extra: { attachmentsMs: Math.round(t1 - t0), ledgerMs: Math.round(t2 - t1), pruneMs: Math.round(t3 - t2) } });
  }
  public getResourceStats(): ControlPlaneResourceStats {
    return {
      artifacts: this.artifacts.getStats(),
      invocations: this.ledger.getStats(),
      receipts: this.receipts.getStats(),
      terminal: this.terminal.getStats(),
    };
  }


  getWorkspaceRoot(): string {
    const workspaceId = this.leaseState.workspaceId || '';
    // Cache hit: same lease workspace and no explicit-root change => reuse the
    // previously resolved root and skip the sync fs.existsSync checks entirely.
    const key = `${workspaceId}|${this.workspaceRoot}`;
    if (this.cachedWorkspaceRoot !== null && this.cachedWorkspaceKey === key) {
      return this.cachedWorkspaceRoot;
    }

    const dataRootResolved = this.dataRoot;
    const dataParentResolved = path.resolve(dataRootResolved, '..');

    let resolved = this.workspaceRoot;
    let registryProvidedRoot = false;
    if (workspaceId) {
      try {
        const ws = this.workspaces.get(workspaceId, this.leaseState.projectId);
        // Authoritative registry tenant root is accepted by evidence, not rejected by name.
        if (ws?.rootPath && typeof ws.rootPath === 'string' && ws.rootPath.trim().length > 0 && ws.rootPath !== dataRootResolved && ws.rootPath !== dataParentResolved && fs.existsSync(ws.rootPath)) {
          resolved = ws.rootPath;
          registryProvidedRoot = true;
        }
      } catch {}
    }
    // Only fall through to env when the registry did not supply a root AND the
    // configured root is unusable (empty or pointing at the data root). A
    // registry hit equal to the configured root is a confirmation, not a miss.
    if (!registryProvidedRoot && (!resolved || resolved === dataRootResolved || resolved === dataParentResolved)) {
      const envRoot = process.env.THEME_WORKSPACE_ROOT || process.env.ANTIFAN_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
      if (envRoot && typeof envRoot === 'string' && envRoot.trim().length > 0 && fs.existsSync(envRoot)) {
        const candidate = path.resolve(envRoot.trim());
        if (candidate !== dataRootResolved && candidate !== dataParentResolved) {
          resolved = candidate;
        } else {
          resolved = '';
        }
      } else {
        resolved = '';
      }
    }
    this.cachedWorkspaceRoot = resolved;
    this.cachedWorkspaceKey = key;
    return resolved;
  }
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    this.cachedWorkspaceRoot = null;
    this.cachedWorkspaceKey = '';
  }

  beginDrain(): void { this.switchState = { ...this.switchState, lifecycle: 'draining' }; this.capabilities.beginDrain(); }
  completeDrain(): void { this.switchState = { ...this.switchState, lifecycle: 'drained' }; this.capabilities.completeDrain(); }
  rollbackLegacy(): void { this.switchState = { mode: 'legacy', lifecycle: 'legacy' }; this.capabilities.switchToLegacy(); }
  registerBrowser(browser: BrowserControlPort): void {
    this.themeTransactions.bindBrowserPort(browser);
    this.themeQaWorkflow = new ThemeQaWorkflow({
      browser,
      artifacts: this.artifacts,
      reload: (target, options) => browser.reload(target, undefined, options),
      transactionRegistry: this.themeTransactions,
      trackerIsolation: (target, active, paneId) => browser.setTrackerIsolation(target, active, paneId),
    });
    registerBrowserCapabilities(this.capabilities, browser, this.themeQaWorkflow, () => this.getWorkspaceRoot(), this.receipts);
  }

  /**
   * Registers the physical-device surface as a PEER execution adapter.
   *
   * The phone is not a mobile pane of the browser port: it gets its own port, its own capability
   * family and its own lifecycle, while publishing evidence through the same ArtifactStore and the
   * same ledger as the Chromium fast loop. That shared evidence path is what lets a Tier-2 device
   * receipt be compared against the Tier-1 capture that preceded it.
   */
  registerDevice(device: DeviceControlPort, manager: DeviceRegistryPort): void {
    this.deviceManager = manager;
    this.devicePort = device;
    registerDeviceCapabilities(this.capabilities, device);
  }

  getDevicePort(): DeviceControlPort | null {
    return this.devicePort;
  }

  getDeviceManager(): DeviceRegistryPort | null {
    return this.deviceManager;
  }
  async validateThemeQa(target: BrowserTarget, options: { runId?: string; attemptId?: string; workspaceRoot?: string; multiBreakpoint?: boolean; signal?: AbortSignal } = {}): Promise<ThemeQaReport> {
    if (!this.themeQaWorkflow) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Browser control is not registered');
    return this.themeQaWorkflow.validate({
      runId: options.runId || `run-theme-qa-${Date.now()}`,
      attemptId: options.attemptId || `attempt-theme-qa-${Date.now()}`,
      workspaceRoot: options.workspaceRoot || this.getWorkspaceRoot(),
      multiBreakpoint: options.multiBreakpoint,
      signal: options.signal,
      target,
    });
  }
  getLifecycle(): RuntimeFeatureSwitch { return { ...this.switchState }; }
  getLease(): RuntimeLease {
    const now = Date.now();
    if (this.leaseState.expiresAt - now < 10_000) {
      this.leaseState = {
        ...this.leaseState,
        expiresAt: now + 30_000,
      };
    }
    return { ...this.leaseState };
  }

  public resolveWorkspaceForSession(options?: { projectId?: string; workspaceId?: string; cwd?: string }): WorkspaceRecord {
    const dataRootResolved = this.dataRoot;
    const dataParentResolved = path.resolve(dataRootResolved, '..');

    // Evidence-aware migration: limited strictly to default workspace known synthesized
    // (options.workspaceRoot was absent at initialization + root matches old fallback).
    // Never clears or mutates explicitly registered tenant roots or intentional workspaceRoots.
    if (this.isDefaultWorkspaceSynthesized) {
      try {
        const defaultWs = this.workspaces.get(this.leaseState.workspaceId || '', this.leaseState.projectId);
        if (defaultWs && (defaultWs.rootPath === dataRootResolved || defaultWs.rootPath === dataParentResolved)) {
          this.workspaces.register({ ...defaultWs, rootPath: '' });
          if (this.workspaceRoot === dataRootResolved || this.workspaceRoot === dataParentResolved) {
            this.setWorkspaceRoot('');
          }
        }
      } catch {}
    }

    if (options?.workspaceId && options?.projectId) {
      const explicitWs = this.workspaces.get(options.workspaceId, options.projectId);
      const isDefault = explicitWs.projectId === this.leaseState.projectId && explicitWs.id === this.leaseState.workspaceId;
      if (isDefault && !explicitWs.rootPath && options.cwd) {
        const candidateCwd = path.resolve(options.cwd);
        if (candidateCwd !== dataRootResolved && candidateCwd !== dataParentResolved && fs.existsSync(candidateCwd)) {
          if (this.isExplicitTerminalCwd(candidateCwd)) {
            const updated = this.workspaces.register({ ...explicitWs, rootPath: candidateCwd, updatedAt: Date.now() });
            this.setWorkspaceRoot(candidateCwd);
            return updated;
          }
        }
      }
      return explicitWs;
    }

    if (options?.cwd) {
      const normalizedCwd = path.resolve(options.cwd);
      const all = this.projects.listProjects();
      const candidates: WorkspaceRecord[] = [];
      for (const proj of all) {
        if (proj.state !== 'open') continue;
        const wsList = this.projects.listWorkspaces(proj.id);
        for (const w of wsList) {
          if (w.state !== 'attached' || !w.rootPath) continue;
          const root = path.resolve(w.rootPath);
          const rel = path.relative(root, normalizedCwd);
          const isInsideOrEqual = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
          if (isInsideOrEqual) {
            candidates.push(w);
          }
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => path.resolve(b.rootPath).length - path.resolve(a.rootPath).length);
        const best = candidates[0];
        if (best) return best;
      }
    }

    const defaultWs = this.workspaces.get(this.leaseState.workspaceId || '', this.leaseState.projectId);
    if (!defaultWs.rootPath && options?.cwd) {
      const candidateCwd = path.resolve(options.cwd);
      if (candidateCwd !== dataRootResolved && candidateCwd !== dataParentResolved && fs.existsSync(candidateCwd)) {
        if (this.isExplicitTerminalCwd(candidateCwd)) {
          const updated = this.workspaces.register({ ...defaultWs, rootPath: candidateCwd, updatedAt: Date.now() });
          this.setWorkspaceRoot(candidateCwd);
          return updated;
        }
      }
    }
    return defaultWs;
  }

  /**
   * Where a terminal session lives, answered as one of three distinct things — never as a
   * bare `undefined`, because the gate must tell "this row belongs to no project" apart from
   * "this row belongs to a project whose workspace cannot be singled out".
   *
   * - `measured`   — the capsule seam named the terminal's own workspace, or its owner key
   *                  (`project:<id>`) has exactly one attached workspace.
   * - `unattributed` — no project claims the row at all: a legacy record written before owner
   *                  keys existed, a terminal of the workspace-less built-in project, or a daemon
   *                  boot shell. Nothing says where it lives, so it cannot be *foreign* to any
   *                  project, and terminal-origin authority is simply not minted from it.
   * - `unmeasurable` — a project window claimed the row, but its workspace cannot be resolved
   *                  (none attached, or more than one), or its project stamp is unusable. That is
   *                  ambiguity about a real claim, and it fails closed rather than guessing.
   */
  private resolveTerminalScope(terminalSessionId: string):
    | { kind: 'measured'; projectId: string; workspaceId: string }
    | { kind: 'unattributed' }
    | { kind: 'unmeasurable' } {
    if (!terminalSessionId) return { kind: 'unattributed' };
    const measured = this.resolveTerminalProjectScopeOption?.(terminalSessionId);
    if (measured && typeof measured.projectId === 'string' && typeof measured.workspaceId === 'string') {
      return { kind: 'measured', projectId: measured.projectId, workspaceId: measured.workspaceId };
    }
    const owner = typeof this.terminal.sessionOwnerKey === 'function'
      ? this.terminal.sessionOwnerKey(terminalSessionId)
      : undefined;
    // No presence check belongs here. In the default daemon-owned terminal host the proxy's
    // session summaries carry neither `capsuleId` nor `ownerKey` at all (verified against the
    // live daemon: every session answers `undefined` on both reads), so "unknown id" and
    // "known row that claims nothing" are indistinguishable there. Treating an absent read as
    // unknown would refuse every terminal the daemon owns — the whole surface this gate must
    // keep working. Provenance that the proxy cannot report is the daemon's problem to expose,
    // not a reason to guess at mint time.
    const parsedOwner = parseOwnerKey(owner);
    if (parsedOwner.kind === 'malformed') {
      // A `project:`-prefixed key is a project claim even when its id is malformed: an
      // empty id is a corrupted stamp, not the absence of one, so it must not fall
      // through to the ambient path.
      return { kind: 'unmeasurable' };
    }
    if (parsedOwner.kind === 'project') {
      const claimedProjectId = parsedOwner.projectId;
      try {
        const workspaces = this.projects.listWorkspaces(claimedProjectId).filter((w) => w.state === 'attached');
        const sole = workspaces.length === 1 ? workspaces[0] : undefined;
        if (sole) return { kind: 'measured', projectId: claimedProjectId, workspaceId: sole.id };
      } catch {}
      return { kind: 'unmeasurable' };
    }
    return { kind: 'unattributed' };
  }

  private isExplicitTerminalCwd(candidateCwd: string): boolean {
    if (!this.terminal) return false;
    try {
      const target = path.resolve(candidateCwd);
      const current = this.terminal.getCurrentCwd();
      if (current && path.resolve(current) === target) {
        return true;
      }
      const activeId = this.terminal.getActiveSessionId();
      if (activeId) {
        const active = this.terminal.getSession(activeId);
        if (active?.cwd && path.resolve(active.cwd) === target) {
          return true;
        }
      }
      const sessions = this.terminal.listSessions();
      if (Array.isArray(sessions)) {
        for (const s of sessions) {
          if (s.cwd && path.resolve(s.cwd) === target) {
            return true;
          }
        }
      }
    } catch {}
    return false;
  }

  async issueAttemptAttachment(
    runId: string,
    attemptId: string,
    options: {
      projectId?: string;
      workspaceId?: string;
      cwd?: string;
      backendId?: string;
      chatId?: string;
      grant?: 'read' | 'write' | 'execute' | 'eval';
      tabId?: string;
      browserEpoch?: number;
      ttlMs?: number;
    } = {}
  ) {
    const targetWs = this.resolveWorkspaceForSession(options);
    const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 7_200_000;
    const isDefault = targetWs.projectId === this.leaseState.projectId && targetWs.id === this.leaseState.workspaceId;
    const baseLease = isDefault ? this.getLease() : issueRuntimeLease(targetWs.projectId, targetWs.id, ttlMs, this.leaseState.hostEpoch);
    const lease: RuntimeLease = {
      ...baseLease,
      projectId: targetWs.projectId,
      workspaceId: targetWs.id,
      expiresAt: Date.now() + ttlMs,
    };
    if (this.leaseState.runtimeId) {
      lease.runtimeId = this.leaseState.runtimeId;
    }
    return await this.runs.attachments.issueAttachment(runId, attemptId, targetWs.projectId, targetWs.id, {
      backendId: options.backendId || 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: lease.hostEpoch,
      chatId: options.chatId,
      grant: options.grant,
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
      ttlMs,
    });
  }

  async createCliSession(
    options: {
      projectId?: string;
      workspaceId?: string;
      cwd?: string;
      backendId?: string;
      chatId?: string;
      grant?: 'read' | 'write' | 'execute' | 'eval';
      tabId?: string;
      browserEpoch?: number;
      ttlMs?: number;
      ownerPid?: number;
      /**
       * Terminal the CLI session was started from (`antifan.cli.startSession`
       * `terminalSessionId`). When the terminal is attributed to a project the session is
       * minted under that measured scope — caller-supplied projectId/workspaceId/cwd cannot
       * widen or redirect it — and stamped onto the attachment so a terminal later moved to
       * another project loses this authority on the next validate.
       */
      originTerminalSessionId?: string;
    } = {}
  ) {
    // A terminal-origin session is scoped by WHERE THE TERMINAL LIVES, not by the
    // caller's cwd or claimed ids: resolveWorkspaceForSession's cwd containment is
    // exactly how a foreign project's terminal minted authority under this project.
    const terminalSessionId = typeof options.originTerminalSessionId === 'string' && options.originTerminalSessionId.trim()
      ? options.originTerminalSessionId.trim()
      : undefined;
    const terminalScope = terminalSessionId ? this.resolveTerminalScope(terminalSessionId) : undefined;
    const measuredTerminalScope = terminalScope?.kind === 'measured' ? terminalScope : undefined;
    if (terminalSessionId && measuredTerminalScope) {
      if (options.projectId && options.projectId !== measuredTerminalScope.projectId) {
        throw new CapabilityError(
          'PROJECT_MISMATCH',
          `Requested project '${options.projectId}' conflicts with the origin terminal's measured project '${measuredTerminalScope.projectId}'`
        );
      }
      if (options.workspaceId && options.workspaceId !== measuredTerminalScope.workspaceId) {
        throw new CapabilityError(
          'WORKSPACE_MISMATCH',
          `Requested workspace '${options.workspaceId}' conflicts with the origin terminal's measured workspace '${measuredTerminalScope.workspaceId}'`
        );
      }
      // The bound tab must measure inside the same project: a foreign affiliation is
      // proof the tab was provisioned in another project's window, which would keep
      // this session driving that window. An unmeasured affiliation is allowed —
      // the bootstrap default capsule legitimately carries none.
      if (options.tabId && this.resolveTabAffiliationOption) {
        const affiliation = this.resolveTabAffiliationOption(options.tabId);
        if (affiliation?.projectId && affiliation.projectId !== measuredTerminalScope.projectId) {
          throw new CapabilityError(
            'POLICY_DENIED',
            `Refusing to mint terminal-origin session: bound tab '${options.tabId}' measures in project '${affiliation.projectId}', ` +
              `not the terminal's project '${measuredTerminalScope.projectId}'. The agent tab must be provisioned in the terminal's own project window.`,
            { tabId: options.tabId, measuredProjectId: affiliation.projectId, terminalProjectId: measuredTerminalScope.projectId }
          );
        }
      }
    }
    // A window claimed this terminal but its workspace cannot be singled out (none
    // attached, or more than one). That is ambiguity about a real claim, so it fails
    // closed: minting it under the caller's cwd would hand a project's terminal to
    // whichever project that cwd resolved to.
    if (terminalSessionId && terminalScope?.kind === 'unmeasurable') {
      throw new CapabilityError(
        'TERMINAL_SCOPE_UNRESOLVED',
        `Cannot mint a session from terminal '${terminalSessionId}': a project owns it, but no single workspace could be measured for it ` +
          '(none attached, or more than one). Terminal-origin browser authority is never minted from the caller cwd. ' +
          'Attach exactly one workspace to the owning project, or start the session without terminal affinity.'
      );
    }
    // No project claims this terminal at all — the app stamps terminal affinity into every
    // PTY it mints, and a legacy row written before owner keys existed, a terminal of the
    // workspace-less built-in project, or a daemon boot shell legitimately carries neither a
    // capsule affiliation nor an owner key. Nothing says where such a terminal lives, so it
    // cannot be foreign to any project, and refusing it would make the app's own terminal
    // unable to mint at all. The caller's own resolution stands instead, and no
    // terminal-origin binding is stamped: there is no claim for a later dispatch to re-measure.
    const targetWs = measuredTerminalScope
      ? this.resolveWorkspaceForSession({ projectId: measuredTerminalScope.projectId, workspaceId: measuredTerminalScope.workspaceId })
      : this.resolveWorkspaceForSession(options);
    const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 7_200_000;
    const isDefault = targetWs.projectId === this.leaseState.projectId && targetWs.id === this.leaseState.workspaceId;
    const baseLease = isDefault ? this.getLease() : issueRuntimeLease(targetWs.projectId, targetWs.id, ttlMs, this.leaseState.hostEpoch);
    const lease: RuntimeLease = {
      ...baseLease,
      projectId: targetWs.projectId,
      workspaceId: targetWs.id,
      expiresAt: Date.now() + ttlMs,
    };
    if (this.leaseState.runtimeId) {
      lease.runtimeId = this.leaseState.runtimeId;
    }
    return await this.runs.createCliSession({
      projectId: targetWs.projectId,
      workspaceId: targetWs.id,
      chatId: options.chatId,
      backendId: options.backendId || 'cli',
      grant: options.grant || 'eval',
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
      ttlMs,
      hostEpoch: lease.hostEpoch,
      ownerPid: options.ownerPid,
      lease,
      leaseToken: lease.token,
      originTerminalSessionId: measuredTerminalScope ? terminalSessionId : undefined,
    });
  }

  async endCliSession(
    runId: string,
    attemptId: string,
    outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
    error?: string
  ): Promise<{ ok: boolean }> {
    return await this.runs.endCliSession(runId, attemptId, outcome, error);
  }

  async renewCliSession(
    attachmentId: string,
    secret: string,
    options?: { extensionMs?: number; ownerPid?: number }
  ): Promise<{ expiresAt: number }> {
    return await this.runs.renewCliSession(attachmentId, secret, options);
  }

  async executeWorkflow(options: {
    workflow: WorkflowDefinition;
    target: BrowserTarget;
    grant?: 'read' | 'write' | 'execute' | 'eval';
    signal?: AbortSignal;
    onEvent?: WorkflowEventListener;
  }): Promise<WorkflowExecutionResult> {
    const targetProjectId = options.target?.projectId || this.leaseState.projectId;
    const targetWorkspaceId = options.target?.workspaceId || this.leaseState.workspaceId || '';

    let targetWs: WorkspaceRecord;
    try {
      targetWs = this.resolveWorkspaceForSession({
        projectId: targetProjectId,
        workspaceId: targetWorkspaceId,
      });
    } catch {
      throw new CapabilityError('WORKSPACE_MISMATCH', `Target workspace '${targetWorkspaceId}' is not valid or not attached to project '${targetProjectId}'`);
    }

    const boundTarget = assertExactBrowserTarget(options.target, {
      projectId: targetWs.projectId,
      workspaceId: targetWs.id,
      runtimeId: this.leaseState.runtimeId || '',
      browserEpoch: this.leaseState.hostEpoch,
    }, false);

    const ttlMs = 600_000;
    const isDefault = targetWs.projectId === this.leaseState.projectId && targetWs.id === this.leaseState.workspaceId;
    const lease = isDefault ? this.getLease() : issueRuntimeLease(targetWs.projectId, targetWs.id, ttlMs, this.leaseState.hostEpoch);
    if (this.leaseState.runtimeId) {
      lease.runtimeId = this.leaseState.runtimeId;
    }

    const session = await this.runs.createWorkflowSession({
      projectId: targetWs.projectId,
      workspaceId: targetWs.id,
      workflowName: options.workflow.name,
      grant: options.grant || 'write',
      tabId: boundTarget.tabId,
      browserEpoch: boundTarget.browserEpoch,
      browserTarget: boundTarget,
      hostEpoch: lease.hostEpoch,
      ttlMs,
      lease,
      leaseToken: lease.token,
    });
    try {
      const resultEnvelope = await this.transport.dispatchIntent(
        {
          requestId: session.attempt.id,
          idempotencyKey: `wf-root-${session.attempt.id}`,
          attachmentId: session.launch.attachmentId,
          attachmentSecret: session.launch.secret,
          authorityRevision: session.launch.authorityRevision,
          name: 'workflow.execute',
          params: {
            workflow: options.workflow,
            workspaceRoot: targetWs.rootPath,
          },
        },
        {
          signal: options.signal,
          progressSink: options.onEvent ? {
            onProgress: (event: any) => options.onEvent?.(event),
          } : undefined,
        }
      );

      if (!resultEnvelope.ok) {
        const errorMsg = resultEnvelope.error?.message || 'Workflow execution failed';
        await this.runs.endWorkflowSession(session.run.id, session.attempt.id, 'failed', errorMsg);
        const code = (resultEnvelope.error?.code as any) || 'CAPABILITY_ERROR';
        const err = new CapabilityError(code, errorMsg);
        (err as any)._alreadyFinalized = true;
        throw err;
      }

      const result = resultEnvelope.data as WorkflowExecutionResult;
      await this.runs.endWorkflowSession(
        session.run.id,
        session.attempt.id,
        result.status === 'passed' ? 'completed' : result.status === 'interrupted' ? 'cancelled' : 'failed',
        result.status !== 'passed' ? result.stepResults?.find((s) => s.error)?.error : undefined
      );
      return result;
    } catch (err: unknown) {
      if (!(err && typeof err === 'object' && '_alreadyFinalized' in err)) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.runs.endWorkflowSession(session.run.id, session.attempt.id, 'failed', errorMsg);
      }
      throw err;
    }
  }
}
