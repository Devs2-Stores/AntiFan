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
import { issueRuntimeLease, RuntimeFeatureSwitch, RuntimeLease } from '../../shared/control-plane-contracts';

export interface ControlPlaneRuntimeOptions {
  projectId: string;
  workspaceId: string;
  dataRoot: string;
  workspaceRoot?: string;
  runtimeId?: string;
  hostEpoch?: number;
  allowEval?: boolean;
}

export class ControlPlaneRuntime {
  readonly projects = new ProjectRegistry();
  readonly workspaces = new WorkspaceRegistry(this.projects);
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

  constructor(options: ControlPlaneRuntimeOptions) {
    this.events = new EventStore({ filePath: path.join(options.dataRoot, 'events.jsonl'), projectId: options.projectId, workspaceId: options.workspaceId });
    this.receipts = new ReceiptStore({ filePath: path.join(options.dataRoot, 'receipts.jsonl') });
    this.artifacts = new ArtifactStore({ root: path.join(options.dataRoot, 'artifacts') });
    this.runs = new RunService(this.chats, this.events, this.receipts);
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
  registerBrowser(browser: BrowserControlPort): void { registerBrowserCapabilities(this.capabilities, browser); }
  getLifecycle(): RuntimeFeatureSwitch { return { ...this.switchState }; }
  getLease(): RuntimeLease {
    if (this.leaseState.expiresAt - Date.now() < 10_000) {
      const renewed = issueRuntimeLease(this.leaseState.projectId, this.leaseState.workspaceId, 30_000, this.leaseState.hostEpoch);
      this.leaseState = { ...renewed, runtimeId: this.leaseState.runtimeId };
    }
    return { ...this.leaseState };
  }
}
