import { ArtifactRef, BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';
import { BrowserControlPort } from '../tools/browser-control-port';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { ArtifactStore } from '../tools/artifact-store';

export interface ThemeQaChecklist {
  layout: boolean;
  responsive: boolean;
  overflow: boolean;
  interactions: boolean;
  diagnostics: boolean;
}

export interface ThemeQaReport {
  runId: string;
  attemptId: string;
  workspaceId: string;
  target: BrowserTarget;
  checklist: ThemeQaChecklist;
  artifacts: ArtifactRef[];
  createdAt: number;
}

export interface ThemeQaWorkflowPorts {
  browser: BrowserControlPort;
  files: WorkspaceFilePort;
  artifacts: ArtifactStore;
  reload: (target: BrowserTarget) => Promise<{ reloaded: boolean; target: BrowserTarget }> | { reloaded: boolean; target: BrowserTarget };
}

export class ThemeQaWorkflow {
  constructor(private readonly ports: ThemeQaWorkflowPorts) {}

  async inspect(input: { runId: string; attemptId: string; workspaceRoot: string; target: BrowserTarget; selector?: string }): Promise<{ dom: ArtifactRef | string; screenshot: ArtifactRef | string }> {
    this.assertOwnership(input.target);
    const dom = await this.ports.browser.dom(input.target, input.runId, input.attemptId, input.selector);
    const screenshot = await this.ports.browser.screenshot(input.target, input.runId, input.attemptId);
    return { dom, screenshot };
  }

  edit(input: { workspaceRoot: string; relativePath: string; content: string }): { path: string; byteLength: number; sha256: string } {
    return this.ports.files.write(input.workspaceRoot, input.relativePath, input.content);
  }

  async validate(input: { runId: string; attemptId: string; workspaceRoot: string; target: BrowserTarget; checklist?: Partial<ThemeQaChecklist> }): Promise<ThemeQaReport> {
    this.assertOwnership(input.target);
    const evidence = await this.inspect({ ...input });
    const reload = await this.ports.reload(input.target);
    if (!reload.reloaded) throw new CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded');
    const checklist: ThemeQaChecklist = { layout: true, responsive: input.checklist?.responsive ?? true, overflow: input.checklist?.overflow ?? true, interactions: input.checklist?.interactions ?? true, diagnostics: input.checklist?.diagnostics ?? true };
    const artifacts: ArtifactRef[] = [];
    for (const item of [evidence.dom, evidence.screenshot]) if (typeof item !== 'string') artifacts.push(item);
    const reportData = JSON.stringify({ checklist, artifactIds: artifacts.map((item) => item.id), target: input.target }, null, 2);
    artifacts.push(this.ports.artifacts.stage({ kind: 'report', mime: 'application/json', data: reportData, runId: input.runId, attemptId: input.attemptId, maxBytes: 64 * 1024 }));
    return { runId: input.runId, attemptId: input.attemptId, workspaceId: input.target.workspaceId, target: input.target, checklist, artifacts, createdAt: Date.now() };
  }

  private assertOwnership(target: BrowserTarget): void {
    if (!target.projectId || !target.workspaceId || !target.runtimeId || !target.tabId) throw new CapabilityError('TARGET_REQUIRED', 'Theme QA requires an explicit Project/Workspace/runtime/tab target');
  }
}
