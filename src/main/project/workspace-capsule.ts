import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectRegistry } from './project-registry';

export interface CapsuleBrowserTab {
  id: string;
  url: string;
  title?: string;
  devicePresetId?: string;
  zoomFactor?: number;
}

export interface CapsuleTerminalTab {
  id: string;
  name: string;
  cwd: string;
  splitSessionId?: string;
  splitRatio?: number;
}

export interface WorkspaceCapsuleState {
  browserTabs: CapsuleBrowserTab[];
  activeBrowserTabId?: string;
  terminalTabs: CapsuleTerminalTab[];
  activeTerminalTabId?: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  appZoomFactor: number;
  devicePresetId: string;
  chromeProfileId?: string;
}

export interface CapsuleAffiliation {
  projectId: string;
  workspaceId: string;
}

export type CapsuleAffiliationMarker = 'explicit' | 'legacy';

export interface WorkspaceCapsule {
  id: string;
  name: string;
  workspacePath: string;
  state: WorkspaceCapsuleState;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  workspaceId?: string;
  migrationMarker?: CapsuleAffiliationMarker;
}

export interface WorkspaceCapsuleManagerOptions {
  filePath: string;
  now?: () => number;
  idFactory?: () => string;
  affiliationAuthority?: { projectRegistry: ProjectRegistry };
}

const DEFAULT_STATE: WorkspaceCapsuleState = {
  browserTabs: [],
  terminalTabs: [],
  sidebarOpen: false,
  sidebarWidth: 380,
  appZoomFactor: 1,
  devicePresetId: 'responsive',
};

export function resolveUniqueAffiliationByRoot(
  capsule: WorkspaceCapsule,
  projectRegistry: ProjectRegistry,
): CapsuleAffiliation | undefined {
  if (capsule.projectId && capsule.workspaceId) {
    return {
      projectId: capsule.projectId,
      workspaceId: capsule.workspaceId,
    };
  }

  return resolveUniqueAffiliationForRoot(capsule.workspacePath, projectRegistry);
}

/**
 * The one open project + workspace a directory belongs to, or undefined when it belongs to none or
 * to several.
 *
 * This is the ownership question a caller asks before treating a record of a directory as a
 * project's own: a directory attached by two projects has no single owner, so nothing may be
 * adopted into either of them on the strength of the path alone.
 */
export function resolveUniqueAffiliationForRoot(
  workspacePath: string,
  projectRegistry: ProjectRegistry,
): CapsuleAffiliation | undefined {
  const workspaces = projectRegistry.findWorkspacesByRoot(workspacePath);
  const matchingPairs: CapsuleAffiliation[] = [];
  const seenPairs = new Set<string>();

  for (const ws of workspaces) {
    try {
      const project = projectRegistry.getProject(ws.projectId);
      if (project.state !== 'open') continue;
      const key = `${project.id}::${ws.id}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        matchingPairs.push({ projectId: project.id, workspaceId: ws.id });
      }
    } catch {
      continue;
    }
  }

  if (matchingPairs.length === 1) {
    return matchingPairs[0];
  }

  return undefined;
}

/**
 * Capsules that already spell `resolvedRoot`, compared resolved and case-insensitively the way the
 * registry compares workspace roots — Windows does not distinguish `E:\Work` from `e:\work` — and
 * then, when that finds nothing, through the filesystem, because a capsule may have been created
 * from a junction or an 8.3 path that spells the same directory differently.
 */
function matchesByRoot(capsules: WorkspaceCapsule[], resolvedRoot: string): WorkspaceCapsule[] {
  // Both sides resolve, so a caller that hands over a drive-relative or unnormalized spelling
  // still compares against the path each capsule stores the same way.
  const target = path.resolve(resolvedRoot).toLowerCase();
  const bySpelling = capsules.filter(
    (capsule) => typeof capsule.workspacePath === 'string' && capsule.workspacePath.trim().length > 0
      && path.resolve(capsule.workspacePath).toLowerCase() === target,
  );
  if (bySpelling.length > 0) return bySpelling;
  return capsules.filter((capsule) => {
    try {
      return fs.realpathSync(capsule.workspacePath).toLowerCase() === target;
    } catch {
      return false;
    }
  });
}

/** The active match wins, then the most recently touched one. */
function preferActiveThenNewest(matches: WorkspaceCapsule[], activeCapsuleId: string): WorkspaceCapsule | null {
  if (matches.length === 0) return null;
  const active = matches.find((capsule) => capsule.id === activeCapsuleId);
  if (active) return active;
  return matches.reduce((best, capsule) => (capsule.updatedAt > best.updatedAt ? capsule : best));
}

/**
 * The capsule a folder open should adopt instead of minting a new one, or null when the folder has
 * none. Only capsules that claim no project are candidates: a capsule already affiliated to a
 * project is that project's durable record, and re-pointing it at a new project would leave the old
 * one with no capsule, and so no way back after the next boot.
 *
 * The active capsule wins, then the most recently touched one: the user's working context survives
 * being folded into a project, and a folder that accumulated duplicates folds into the row that was
 * used last rather than an arbitrary one.
 */
export function findReusableCapsule(
  capsules: WorkspaceCapsule[],
  resolvedRoot: string,
  activeCapsuleId: string,
): WorkspaceCapsule | null {
  const unaffiliated = capsules.filter((capsule) => !capsule.projectId && !capsule.workspaceId);
  if (unaffiliated.length === 0) return null;
  return preferActiveThenNewest(matchesByRoot(unaffiliated, resolvedRoot), activeCapsuleId);
}

/**
 * The capsule that already records `resolvedRoot`, of any affiliation, or null when the folder has
 * none yet.
 *
 * A capsule is a workspace record, and the same folder has one record no matter which project it
 * was later folded into. Pointing a shell at a folder it already has a capsule for — the sidebar's
 * workspace switcher, which only re-points the shell and never moves affiliations — must adopt that
 * record instead of minting a second one: duplicates are what turned one folder into nine
 * identically named rows that a folder open then had to fold back together.
 *
 * A row that claims no project wins over one that does. The free row is the row a folder open
 * adopts and affiliates, so both paths land on the same row and no third one appears; handing the
 * shell the project's own row would leave the free row unused by every path that adopts.
 *
 * This selects a row, it does not merge or delete any: rows a folder already accumulated stay in
 * the store until something removes them, so duplicates are prevented here, never cleaned up.
 */
export function findCapsuleByRoot(
  capsules: WorkspaceCapsule[],
  resolvedRoot: string,
  activeCapsuleId: string,
): WorkspaceCapsule | null {
  const matches = matchesByRoot(capsules, resolvedRoot);
  const free = matches.filter((capsule) => !capsule.projectId && !capsule.workspaceId);
  return preferActiveThenNewest(free.length > 0 ? free : matches, activeCapsuleId);
}

export class WorkspaceCapsuleManager {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private capsules = new Map<string, WorkspaceCapsule>();
  private activeCapsuleId = '';

  constructor(private readonly options: WorkspaceCapsuleManagerOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.load();
  }

  create(name: string, workspacePath: string, state?: Partial<WorkspaceCapsuleState>): WorkspaceCapsule {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('Capsule name is required');
    const normalizedPath = this.normalizeWorkspacePath(workspacePath);
    const now = this.now();
    const capsule: WorkspaceCapsule = {
      id: `capsule-${this.idFactory()}`,
      name: trimmedName,
      workspacePath: normalizedPath,
      state: this.mergeState(DEFAULT_STATE, state),
      createdAt: now,
      updatedAt: now,
      migrationMarker: 'legacy',
    };
    this.capsules.set(capsule.id, capsule);
    if (!this.activeCapsuleId) this.activeCapsuleId = capsule.id;
    this.persist();
    return this.clone(capsule);
  }

  list(): WorkspaceCapsule[] {
    return [...this.capsules.values()].map((capsule) => this.clone(capsule));
  }

  get(capsuleId: string): WorkspaceCapsule {
    const capsule = this.capsules.get(capsuleId);
    if (!capsule) throw new Error(`Capsule not found: ${capsuleId}`);
    return this.clone(capsule);
  }

  getActive(): WorkspaceCapsule | null {
    return this.activeCapsuleId ? this.get(this.activeCapsuleId) : null;
  }

  /**
   * The one open project this directory belongs to, or undefined when it belongs to none or to
   * several.
   *
   * A caller that finds a record of a directory and needs to know whose it is asks here rather than
   * inferring ownership from the path: two projects may attach one directory, and a record that
   * outlived its window carries no project of its own, so only a registry answer can say whether
   * adopting it into a project would be unambiguous.
   */
  uniqueAffiliationByRoot(workspacePath: string): CapsuleAffiliation | undefined {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) return undefined;
    const registry = this.options.affiliationAuthority?.projectRegistry;
    if (!registry) return undefined;
    try {
      return resolveUniqueAffiliationForRoot(this.normalizeWorkspacePath(workspacePath), registry);
    } catch {
      return undefined;
    }
  }

  switchTo(capsuleId: string): WorkspaceCapsule {
    const capsule = this.get(capsuleId);
    this.activeCapsuleId = capsule.id;
    this.persist();
    return capsule;
  }

  updateState(capsuleId: string, state: Partial<WorkspaceCapsuleState>): WorkspaceCapsule {
    const capsule = this.capsules.get(capsuleId);
    if (!capsule) throw new Error(`Capsule not found: ${capsuleId}`);
    capsule.state = this.mergeState(capsule.state, state);
    capsule.updatedAt = this.now();
    this.persist();
    return this.clone(capsule);
  }

  updateActiveState(state: Partial<WorkspaceCapsuleState>): WorkspaceCapsule {
    if (!this.activeCapsuleId) throw new Error('No active capsule');
    return this.updateState(this.activeCapsuleId, state);
  }

  rename(capsuleId: string, name: string): WorkspaceCapsule {
    const capsule = this.capsules.get(capsuleId);
    if (!capsule) throw new Error(`Capsule not found: ${capsuleId}`);
    if (!name.trim()) throw new Error('Capsule name is required');
    capsule.name = name.trim();
    capsule.updatedAt = this.now();
    this.persist();
    return this.clone(capsule);
  }

  setAffiliation(capsuleId: string, affiliation: CapsuleAffiliation): WorkspaceCapsule {
    const capsule = this.capsules.get(capsuleId);
    if (!capsule) {
      throw new Error(`Capsule not found: ${capsuleId}`);
    }
    if (!affiliation || typeof affiliation.projectId !== 'string' || typeof affiliation.workspaceId !== 'string') {
      throw new Error('Project ID and Workspace ID are required for affiliation');
    }

    const authority = this.options.affiliationAuthority;
    if (!authority || !authority.projectRegistry) {
      throw new Error('Affiliation authority is unavailable');
    }

    const project = authority.projectRegistry.getProject(affiliation.projectId);
    const workspace = authority.projectRegistry.getWorkspace(affiliation.workspaceId, affiliation.projectId);

    capsule.projectId = project.id;
    capsule.workspaceId = workspace.id;
    capsule.migrationMarker = 'explicit';
    capsule.updatedAt = this.now();
    this.persist();
    return this.clone(capsule);
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.filePath, 'utf8')) as {
        version?: number;
        activeCapsuleId?: string;
        capsules?: Array<WorkspaceCapsule & {
          projectId?: string;
          workspaceId?: string;
          migrationMarker?: CapsuleAffiliationMarker;
        }>;
      };
      if (!Array.isArray(raw.capsules)) return;
      for (const item of raw.capsules) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.workspacePath !== 'string') continue;
        const capsule: WorkspaceCapsule = {
          id: item.id,
          name: item.name,
          workspacePath: this.normalizeWorkspacePath(item.workspacePath),
          state: this.mergeState(DEFAULT_STATE, item.state),
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : this.now(),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : this.now(),
        };
        if (typeof item.projectId === 'string' && item.projectId.trim()) {
          capsule.projectId = item.projectId.trim();
        }
        if (typeof item.workspaceId === 'string' && item.workspaceId.trim()) {
          capsule.workspaceId = item.workspaceId.trim();
        }
        if (item.migrationMarker === 'explicit' || item.migrationMarker === 'legacy') {
          capsule.migrationMarker = item.migrationMarker;
        } else if (capsule.projectId && capsule.workspaceId) {
          capsule.migrationMarker = 'explicit';
        } else {
          capsule.migrationMarker = 'legacy';
        }
        this.capsules.set(capsule.id, capsule);
      }
      if (raw.activeCapsuleId && this.capsules.has(raw.activeCapsuleId)) this.activeCapsuleId = raw.activeCapsuleId;
    } catch {
      this.capsules.clear();
      this.activeCapsuleId = '';
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    const tempPath = `${this.options.filePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(
        tempPath,
        JSON.stringify(
          {
            version: 2,
            activeCapsuleId: this.activeCapsuleId,
            capsules: this.list(),
            updatedAt: this.now(),
          },
          null,
          2,
        ),
        'utf8',
      );
      fs.renameSync(tempPath, this.options.filePath);
    } catch (err) {
      // A failed swap must not leave the staged file behind (Windows can hold the
      // destination open past the write); the caller sees the original error.
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      throw err;
    }
  }

  private normalizeWorkspacePath(workspacePath: string): string {
    if (!workspacePath.trim() || !path.isAbsolute(workspacePath)) throw new Error('Capsule workspace must be an absolute path');
    return path.resolve(workspacePath);
  }

  private mergeState(base: WorkspaceCapsuleState, patch?: Partial<WorkspaceCapsuleState>): WorkspaceCapsuleState {
    return {
      browserTabs: patch?.browserTabs ? patch.browserTabs.map((tab) => ({ ...tab })) : base.browserTabs.map((tab) => ({ ...tab })),
      activeBrowserTabId: patch?.activeBrowserTabId ?? base.activeBrowserTabId,
      terminalTabs: patch?.terminalTabs ? patch.terminalTabs.map((tab) => ({ ...tab })) : base.terminalTabs.map((tab) => ({ ...tab })),
      activeTerminalTabId: patch?.activeTerminalTabId ?? base.activeTerminalTabId,
      sidebarOpen: patch?.sidebarOpen ?? base.sidebarOpen,
      sidebarWidth: patch?.sidebarWidth ?? base.sidebarWidth,
      appZoomFactor: patch?.appZoomFactor ?? base.appZoomFactor,
      devicePresetId: patch?.devicePresetId ?? base.devicePresetId,
      chromeProfileId: patch?.chromeProfileId ?? base.chromeProfileId,
    };
  }

  private clone(capsule: WorkspaceCapsule): WorkspaceCapsule {
    return JSON.parse(JSON.stringify(capsule)) as WorkspaceCapsule;
  }
}
