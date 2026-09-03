import * as path from 'node:path';
import { ChatStore } from '../chat/chat-store';
import { ProjectRegistry } from '../project/project-registry';
import { WorkspaceRegistry } from '../project/workspace-registry';
import { RunService } from '../run/run-service';
import { EventStore } from '../session/event-store';
import { ReceiptStore } from '../session/receipt-store';
import { InvocationLedger } from '../session/invocation-ledger';
import { ArtifactStore } from '../tools/artifact-store';
import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { BrowserControlPort } from '../tools/browser-control-port';
import { registerBrowserCapabilities } from '../tools/browser-capabilities';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { registerFileCapabilities } from '../tools/file-capabilities';
import { registerArtifactCapabilities } from '../tools/artifact-capabilities';
import { registerTerminalCapabilities } from '../tools/terminal-capabilities';
import { registerWorkflowCapabilities } from '../workflow/workflow-capabilities';
import { WorkflowRegistry } from '../workflow/workflow-registry';
import { TerminalManager } from '../browser/terminal-manager';
import { WorkflowEngine } from '../workflow/workflow-engine';
import { assertExactBrowserTarget, BrowserTarget, CapabilityError, CapabilityRequestContext, issueRuntimeLease, RuntimeFeatureSwitch, RuntimeLease, WorkspaceRecord } from '../../shared/control-plane-contracts';
import { WorkflowDefinition, WorkflowExecutionResult, WorkflowEventListener } from '../workflow/workflow-schema';
import { ThemeQaWorkflow, ThemeQaReport } from '../qa/theme-qa-workflow';

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
  readonly workflowEngine: WorkflowEngine;
  readonly workflowRegistry: WorkflowRegistry;
  private leaseState: RuntimeLease;
  private switchState: RuntimeFeatureSwitch = { mode: 'standalone', lifecycle: 'active' };
  private workspaceRoot: string;
  private themeQaWorkflow: ThemeQaWorkflow | null = null;

  constructor(options: ControlPlaneRuntimeOptions) {
    this.projects = options.projects || new ProjectRegistry();
    this.workspaces = options.workspaces || new WorkspaceRegistry(this.projects);
    if (options.projectId && options.workspaceId) {
      this.workspaces.ensureInitialWorkspace(
        options.projectId,
        options.workspaceId,
        options.workspaceRoot || path.resolve(options.dataRoot, '..'),
        options.dataRoot
      );
    }
    this.events = new EventStore({ filePath: path.join(options.dataRoot, 'events.jsonl'), projectId: options.projectId, workspaceId: options.workspaceId });
    this.receipts = new ReceiptStore({ filePath: path.join(options.dataRoot, 'receipts.jsonl') });
    this.ledger = new InvocationLedger({ dataRoot: options.dataRoot });
    this.artifacts = new ArtifactStore({ root: path.join(options.dataRoot, 'artifacts') });
    this.workspaceRoot = options.workspaceRoot || path.resolve(options.dataRoot, '..');
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
      }
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
    });
    this.transport = new CapabilityTransportAdapter(this.capabilities, this.runs.attachments, this.ledger);
    this.terminal = new TerminalManager();
    registerFileCapabilities(this.capabilities, this.files, () => this.getWorkspaceRoot());
    registerArtifactCapabilities(this.capabilities, this.artifacts);
    registerTerminalCapabilities(this.capabilities, this.terminal);
    this.workflowRegistry = new WorkflowRegistry(path.join(options.dataRoot, 'workflows'));
    this.workflowEngine = new WorkflowEngine({
      transport: this.transport,
      catalogue: this.capabilities,
      artifacts: this.artifacts,
    });
    registerWorkflowCapabilities(this.capabilities, this.workflowEngine);
  }

  public async initialize(): Promise<void> {
    await this.runs.attachments.initialize();
    await this.ledger.initialize();
  }

  getWorkspaceRoot(): string {
    if (this.leaseState.workspaceId) {
      try {
        const ws = this.workspaces.get(this.leaseState.workspaceId, this.leaseState.projectId);
        if (ws?.rootPath) return ws.rootPath;
      } catch {}
    }
    return this.workspaceRoot;
  }
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  beginDrain(): void { this.switchState = { ...this.switchState, lifecycle: 'draining' }; this.capabilities.beginDrain(); }
  completeDrain(): void { this.switchState = { ...this.switchState, lifecycle: 'drained' }; this.capabilities.completeDrain(); }
  rollbackLegacy(): void { this.switchState = { mode: 'legacy', lifecycle: 'legacy' }; this.capabilities.switchToLegacy(); }
  registerBrowser(browser: BrowserControlPort): void {
    this.themeQaWorkflow = new ThemeQaWorkflow({ browser, artifacts: this.artifacts, reload: (target) => browser.reload(target) });
    registerBrowserCapabilities(this.capabilities, browser, this.themeQaWorkflow, () => this.getWorkspaceRoot());
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
    if (options?.workspaceId && options?.projectId) {
      return this.workspaces.get(options.workspaceId, options.projectId);
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
    return this.workspaces.get(this.leaseState.workspaceId || '', this.leaseState.projectId);
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
