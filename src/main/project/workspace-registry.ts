import {
  WorkspaceRecord,
  assertWorkspaceContained,
  canonicalizeWorkspaceRoot,
} from '../../shared/control-plane-contracts';
import { ProjectRegistry } from './project-registry';

export class WorkspaceRegistry {
  constructor(private readonly projects: ProjectRegistry) {}

  attach(projectId: string, rootPath: string): WorkspaceRecord {
    return this.projects.attachWorkspace(projectId, canonicalizeWorkspaceRoot(rootPath));
  }

  get(workspaceId: string, projectId: string): WorkspaceRecord {
    return this.projects.getWorkspace(workspaceId, projectId);
  }

  detach(workspaceId: string, projectId: string): WorkspaceRecord {
    return this.projects.detachWorkspace(workspaceId, projectId);
  }

  assertContained(workspaceId: string, projectId: string, candidate: string, allowRoot = false): string {
    const workspace = this.get(workspaceId, projectId);
    return assertWorkspaceContained(workspace.rootPath, candidate, allowRoot);
  }

  register(workspace: WorkspaceRecord): WorkspaceRecord {
    return this.projects.registerWorkspace(workspace);
  }
}
