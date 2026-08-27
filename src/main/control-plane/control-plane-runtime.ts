import * as path from 'node:path';
import { ChatStore } from '../chat/chat-store';
import { ProjectRegistry } from '../project/project-registry';
import { WorkspaceRegistry } from '../project/workspace-registry';
import { RunService } from '../run/run-service';
import { EventStore } from '../session/event-store';
import { ReceiptStore } from '../session/receipt-store';
import { ArtifactStore } from '../tools/artifact-store';
import { CapabilityCatalogue } from '../tools/capability-catalogue';
import { BrowserControlPort } from '../tools/browser-control-port';
import { registerBrowserCapabilities } from '../tools/browser-capabilities';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { registerFileCapabilities } from '../tools/file-capabilities';
import { WorkflowEngine } from '../workflow/workflow-engine';
import { registerWorkflowCapabilities } from '../workflow/workflow-capabilities';
import { WorkflowRegistry } from '../workflow/workflow-registry';
import { assertExactBrowserTarget, BrowserTarget, CapabilityError, CapabilityRequestContext, issueRuntimeLease, RuntimeFeatureSwitch, RuntimeLease } from '../../shared/control-plane-contracts';
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
}

export class ControlPlaneRuntime {
  readonly projects: ProjectRegistry;
  readonly workspaces: WorkspaceRegistry;
  readonly chats = new ChatStore();
  readonly events: EventStore;
  readonly receipts: ReceiptStore;
  readonly artifacts: ArtifactStore;
  readonly runs: RunService;
  readonly files: WorkspaceFilePort;
  readonly capabilities: CapabilityCatalogue;
  readonly workflowEngine: WorkflowEngine;
  readonly workflowRegistry: WorkflowRegistry;
  private leaseState: RuntimeLease;
  private switchState: RuntimeFeatureSwitch = { mode: 'standalone', lifecycle: 'active' };
  private workspaceRoot: string;
  private themeQaWorkflow: ThemeQaWorkflow | null = null;

  constructor(options: ControlPlaneRuntimeOptions) {
    this.projects = options.projects || new ProjectRegistry();
    this.workspaces = options.workspaces || new WorkspaceRegistry(this.projects);
    this.events = new EventStore({ filePath: path.join(options.dataRoot, 'events.jsonl'), projectId: options.projectId, workspaceId: options.workspaceId });
    this.receipts = new ReceiptStore({ filePath: path.join(options.dataRoot, 'receipts.jsonl') });
    this.artifacts = new ArtifactStore({ root: path.join(options.dataRoot, 'artifacts') });
    this.runs = new RunService(
      this.chats,
      this.events,
      this.receipts,
      (wsId, pId) => {
        return this.workspaces.get(wsId, pId).rootPath;
      },
      undefined,
      () => this.leaseState.hostEpoch,
      options.getDocumentGeneration,
      options.getAutomationTabId
    );
    this.files = new WorkspaceFilePort();
    this.workspaceRoot = options.workspaceRoot || path.resolve(options.dataRoot, '..');
    this.leaseState = issueRuntimeLease(options.projectId, options.workspaceId, 30_000, options.hostEpoch ?? 1);
    if (options.runtimeId) this.leaseState = { ...this.leaseState, runtimeId: options.runtimeId };
    this.capabilities = new CapabilityCatalogue({ runtime: this.switchState, projectId: options.projectId, workspaceId: options.workspaceId, runtimeId: this.leaseState.runtimeId, hostEpoch: options.hostEpoch ?? 1, getActiveLease: () => this.getLease(), allowEval: options.allowEval });

    // Wire file and workflow capabilities into authoritative catalogue
    registerFileCapabilities(this.capabilities, this.files, () => this.getWorkspaceRoot());
    this.workflowEngine = new WorkflowEngine({ catalogue: this.capabilities, artifacts: this.artifacts });
    this.workflowRegistry = new WorkflowRegistry(path.join(options.dataRoot, 'workflows'));
    registerWorkflowCapabilities(this.capabilities, this.workflowEngine);
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
    this.themeQaWorkflow = new ThemeQaWorkflow({ browser, files: this.files, artifacts: this.artifacts, reload: (target) => browser.reload(target) });
    registerBrowserCapabilities(this.capabilities, browser, this.themeQaWorkflow, () => this.getWorkspaceRoot());
  }
  async validateThemeQa(target: BrowserTarget, options: { runId?: string; attemptId?: string; workspaceRoot?: string; multiBreakpoint?: boolean } = {}): Promise<ThemeQaReport> {
    if (!this.themeQaWorkflow) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Browser control is not registered');
    return this.themeQaWorkflow.validate({
      runId: options.runId || `run-theme-qa-${Date.now()}`,
      attemptId: options.attemptId || `attempt-theme-qa-${Date.now()}`,
      workspaceRoot: options.workspaceRoot || this.getWorkspaceRoot(),
      multiBreakpoint: options.multiBreakpoint,
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

  issueAttemptAttachment(
    runId: string,
    attemptId: string,
    options: {
      backendId?: string;
      chatId?: string;
      grant?: 'read' | 'write' | 'execute' | 'eval';
      tabId?: string;
      browserEpoch?: number;
      ttlMs?: number;
    } = {}
  ) {
    const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 7_200_000;
    const currentLease = this.getLease();
    const lease: RuntimeLease = {
      ...currentLease,
      expiresAt: Date.now() + ttlMs,
    };
    return this.runs.attachments.issueAttachment(runId, attemptId, this.leaseState.projectId, this.leaseState.workspaceId || '', {
      backendId: options.backendId || 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: this.leaseState.hostEpoch,
      chatId: options.chatId,
      grant: options.grant,
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
      ttlMs,
    });
  }

  createCliSession(
    options: {
      backendId?: string;
      chatId?: string;
      grant?: 'read' | 'write' | 'execute' | 'eval';
      tabId?: string;
      browserEpoch?: number;
      ttlMs?: number;
      ownerPid?: number;
    } = {}
  ) {
    const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 7_200_000;
    const currentLease = this.getLease();
    const lease: RuntimeLease = {
      ...currentLease,
      expiresAt: Date.now() + ttlMs,
    };
    return this.runs.createCliSession({
      projectId: this.leaseState.projectId,
      workspaceId: this.leaseState.workspaceId || '',
      chatId: options.chatId,
      backendId: options.backendId || 'cli',
      grant: options.grant || 'write',
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
      ttlMs,
      hostEpoch: this.leaseState.hostEpoch,
      ownerPid: options.ownerPid,
      lease,
      leaseToken: lease.token,
    });
  }

  endCliSession(
    runId: string,
    attemptId: string,
    outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
    error?: string
  ) {
    return this.runs.endCliSession(runId, attemptId, outcome, error);
  }

  renewCliSession(attachmentId: string, secret: string, options?: { extensionMs?: number; ownerPid?: number }) {
    return this.runs.renewCliSession(attachmentId, secret, options);
  }

  async executeWorkflow(options: {
    workflow: WorkflowDefinition;
    target: BrowserTarget;
    grant?: 'read' | 'write' | 'execute' | 'eval';
    signal?: AbortSignal;
    onEvent?: WorkflowEventListener;
  }): Promise<WorkflowExecutionResult> {
    const lease = this.getLease();
    const boundTarget = assertExactBrowserTarget(options.target, {
      projectId: lease.projectId,
      workspaceId: lease.workspaceId || '',
      runtimeId: lease.runtimeId || '',
      browserEpoch: lease.hostEpoch,
    }, false);

    const session = this.runs.createWorkflowSession({
      projectId: this.leaseState.projectId,
      workspaceId: this.leaseState.workspaceId || '',
      workflowName: options.workflow.name,
      grant: options.grant || 'write',
      tabId: boundTarget.tabId,
      browserEpoch: boundTarget.browserEpoch,
      hostEpoch: lease.hostEpoch,
      ttlMs: 600_000,
      lease,
      leaseToken: lease.token,
    });
    const reqContext: CapabilityRequestContext = {
      lease: session.lease,
      leaseToken: session.leaseToken,
      projectId: this.leaseState.projectId,
      workspaceId: this.leaseState.workspaceId || '',
      runId: session.run.id,
      attemptId: session.attempt.id,
      browserTarget: boundTarget,
      grant: options.grant || 'write',
      signal: options.signal,
    };
    try {
      const result = (await this.capabilities.dispatch(
        'workflow.execute',
        {
          workflow: options.workflow,
          workspaceRoot: this.getWorkspaceRoot(),
          signal: options.signal,
          onEvent: options.onEvent,
        },
        reqContext
      )) as WorkflowExecutionResult;
      this.runs.endWorkflowSession(
        session.run.id,
        session.attempt.id,
        result.status === 'passed' ? 'completed' : (result.status === 'interrupted' ? 'cancelled' : 'failed'),
        result.status === 'failed' ? 'Workflow execution failed' : undefined,
        result.artifacts
      );
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runs.endWorkflowSession(session.run.id, session.attempt.id, 'failed', msg);
      throw err;
    }
  }
}
