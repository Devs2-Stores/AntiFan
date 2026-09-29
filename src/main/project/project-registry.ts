import * as path from 'node:path';
import {
  ProjectRecord,
  WorkspaceRecord,
  makeControlPlaneId,
  validateControlPlaneId,
} from '../../shared/control-plane-contracts';
import type { ProjectAppearance, ProjectAppearancePatch } from './project-preferences';

/** What the registry needs from a durable appearance store (satisfied by `ProjectPreferences`). */
export interface ProjectAppearanceStore {
  get(projectId: string): ProjectAppearance;
  set(projectId: string, patch: ProjectAppearancePatch): ProjectAppearance | undefined;
  remove(projectId: string): boolean;
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private appearanceStore: ProjectAppearanceStore | undefined;

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
    const stored = this.withStoredAppearance(project);
    this.projects.set(stored.id, stored);
    return { ...stored };
  }

  registerProject(project: ProjectRecord): ProjectRecord {
    const id = validateControlPlaneId(project.id, 'project');
    const record: ProjectRecord = this.withStoredAppearance({
      ...project,
      id,
      dataRoot: path.resolve(project.dataRoot),
    });
    this.projects.set(id, record);
    return { ...record };
  }

  /**
   * Back colour/star with a durable store. The store is authoritative for those two fields:
   * every registration (boot re-sync, rename, create) re-reads it, so a record can never
   * drift from what the user last chose. Records already registered are hydrated now.
   */
  attachAppearanceStore(store: ProjectAppearanceStore): void {
    this.appearanceStore = store;
    for (const [id, record] of this.projects) this.projects.set(id, this.withStoredAppearance(record));
  }

  /** Persist a colour/star change and reflect it on the record. `undefined` = refused or unknown. */
  setProjectAppearance(projectId: string, patch: ProjectAppearancePatch): ProjectRecord | undefined {
    const id = validateControlPlaneId(projectId, 'project');
    const existing = this.projects.get(id);
    if (!existing || !this.appearanceStore) return undefined;
    if (!this.appearanceStore.set(id, patch)) return undefined;
    const record = this.withStoredAppearance({ ...existing, updatedAt: Date.now() });
    this.projects.set(id, record);
    return { ...record };
  }

  /**
   * Forget a project's appearance durably (project removed from the list). Returns false when
   * the deletion could not be persisted; the record then keeps what the store still holds.
   */
  forgetProjectAppearance(projectId: string): boolean {
    const id = validateControlPlaneId(projectId, 'project');
    const forgotten = this.appearanceStore ? this.appearanceStore.remove(id) : true;
    const existing = this.projects.get(id);
    if (existing) this.projects.set(id, this.withStoredAppearance(existing));
    return forgotten;
  }

  private withStoredAppearance(record: ProjectRecord): ProjectRecord {
    if (!this.appearanceStore) return record;
    const { color, starred, ...rest } = record;
    const stored = this.appearanceStore.get(record.id);
    const next: ProjectRecord = { ...rest };
    if (stored.color) next.color = stored.color;
    if (stored.starred) next.starred = true;
    return next;
  }

  registerWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
    const id = validateControlPlaneId(workspace.id, 'workspace');
    const projectId = validateControlPlaneId(workspace.projectId, 'project');
    const resolvedRoot = workspace.rootPath && typeof workspace.rootPath === 'string' && workspace.rootPath.trim().length > 0
      ? path.resolve(workspace.rootPath)
      : '';
    const record: WorkspaceRecord = {
      ...workspace,
      id,
      projectId,
      rootPath: resolvedRoot,
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

  findWorkspacesByRoot(rootPath: string): WorkspaceRecord[] {
    const normalized = path.resolve(rootPath);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return Array.from(this.workspaces.values()).filter((item) => {
      const itemKey = process.platform === 'win32' ? item.rootPath.toLowerCase() : item.rootPath;
      return itemKey === key && item.state === 'attached';
    }).map((item) => ({ ...item }));
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

    const resolvedRoot = rootPath && typeof rootPath === 'string' && rootPath.trim().length > 0
      ? path.resolve(rootPath)
      : '';

    return this.registerWorkspace({
      id: validWorkspaceId,
      projectId: validProjectId,
      rootPath: resolvedRoot,
      state: 'attached',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}
