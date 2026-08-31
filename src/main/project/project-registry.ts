import * as path from 'node:path';
import {
  ProjectRecord,
  WorkspaceRecord,
  makeControlPlaneId,
  validateControlPlaneId,
} from '../../shared/control-plane-contracts';

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();

  createProject(name: string, dataRoot: string): ProjectRecord {
    if (!name.trim()) throw new Error('Project name is required');
    const now = Date.now();
    const project: ProjectRecord = {
      id: makeControlPlaneId('project'),
      name: name.trim(),
      dataRoot: path.resolve(dataRoot),
      state: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    return { ...project };
  }

  registerProject(project: ProjectRecord): ProjectRecord {
    const id = validateControlPlaneId(project.id, 'project');
    const record: ProjectRecord = {
      ...project,
      id,
      dataRoot: path.resolve(project.dataRoot),
    };
    this.projects.set(id, record);
    return { ...record };
  }

  registerWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
    const id = validateControlPlaneId(workspace.id, 'workspace');
    const projectId = validateControlPlaneId(workspace.projectId, 'project');
    const record: WorkspaceRecord = {
      ...workspace,
      id,
      projectId,
      rootPath: path.resolve(workspace.rootPath),
    };
    this.workspaces.set(id, record);
    return { ...record };
  }
  getProject(projectId: string): ProjectRecord {
    const project = this.projects.get(validateControlPlaneId(projectId, 'project'));
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return { ...project };
  }

  closeProject(projectId: string): ProjectRecord {
    const project = this.getProject(projectId);
    if (project.state === 'closed') return project;
    project.state = 'closed';
    project.updatedAt = Date.now();
    this.projects.set(project.id, project);
    for (const workspace of this.workspaces.values()) {
      if (workspace.projectId === project.id) {
        workspace.state = 'detached';
        workspace.updatedAt = project.updatedAt;
      }
    }
    return { ...project };
  }

  attachWorkspace(projectId: string, rootPath: string): WorkspaceRecord {
    const project = this.getProject(projectId);
    if (project.state !== 'open') throw new Error('Cannot attach a Workspace to a closed Project');
    const normalized = path.resolve(rootPath);
    const existing = Array.from(this.workspaces.values()).find((item) => item.projectId === project.id && item.rootPath.toLowerCase() === normalized.toLowerCase());
    if (existing && existing.state === 'attached') return { ...existing };
    const now = Date.now();
    const workspace: WorkspaceRecord = existing ? {
      ...existing,
      rootPath: normalized,
      state: 'attached',
      updatedAt: now,
    } : {
      id: makeControlPlaneId('workspace'),
      projectId: project.id,
      rootPath: normalized,
      state: 'attached',
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(workspace.id, workspace);
    return { ...workspace };
  }

  getWorkspace(workspaceId: string, projectId?: string): WorkspaceRecord {
    const workspace = this.workspaces.get(validateControlPlaneId(workspaceId, 'workspace'));
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (projectId && workspace.projectId !== validateControlPlaneId(projectId, 'project')) throw new Error('Workspace does not belong to Project');
    if (workspace.state !== 'attached') throw new Error('Workspace is detached');
    return { ...workspace };
  }

  detachWorkspace(workspaceId: string, projectId: string): WorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId, projectId);
    workspace.state = 'detached';
    workspace.updatedAt = Date.now();
    this.workspaces.set(workspace.id, workspace);
    return { ...workspace };
  }

  listWorkspaces(projectId: string): WorkspaceRecord[] {
    const id = validateControlPlaneId(projectId, 'project');
    return Array.from(this.workspaces.values()).filter((item) => item.projectId === id && item.state === 'attached').map((item) => ({ ...item }));
  }

  listProjects(): ProjectRecord[] {
    return Array.from(this.projects.values()).map((p) => ({ ...p }));
  }

  listAllWorkspaces(): WorkspaceRecord[] {
    return Array.from(this.workspaces.values()).map((w) => ({ ...w }));
  }

  findWorkspaceById(workspaceId: string): WorkspaceRecord | undefined {
    try {
      const id = validateControlPlaneId(workspaceId, 'workspace');
      const ws = this.workspaces.get(id);
      return ws ? { ...ws } : undefined;
    } catch {
      return undefined;
    }
  }

  ensureInitialWorkspace(projectId: string, workspaceId: string, rootPath: string, dataRoot: string): WorkspaceRecord {
    const validProjectId = validateControlPlaneId(projectId, 'project');
    const validWorkspaceId = validateControlPlaneId(workspaceId, 'workspace');

    let project = this.projects.get(validProjectId);
    if (!project) {
      project = this.registerProject({
        id: validProjectId,
        name: `Project-${validProjectId}`,
        dataRoot: path.resolve(dataRoot),
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } else if (project.state !== 'open') {
      throw new Error('Cannot initialize a Workspace on a closed Project');
    }
    const existingWs = this.workspaces.get(validWorkspaceId);
    if (existingWs) {
      if (existingWs.projectId !== validProjectId) {
        throw new Error(`Cannot initialize workspace '${validWorkspaceId}': already registered to another project '${existingWs.projectId}'`);
      }
      if (existingWs.state === 'detached') {
        throw new Error(`Cannot initialize workspace '${validWorkspaceId}': workspace is detached`);
      }
      return { ...existingWs };
    }

    return this.registerWorkspace({
      id: validWorkspaceId,
      projectId: validProjectId,
      rootPath: path.resolve(rootPath),
      state: 'attached',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}
