import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

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

export interface WorkspaceCapsule {
  id: string;
  name: string;
  workspacePath: string;
  state: WorkspaceCapsuleState;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceCapsuleManagerOptions {
  filePath: string;
  now?: () => number;
  idFactory?: () => string;
}

const DEFAULT_STATE: WorkspaceCapsuleState = {
  browserTabs: [],
  terminalTabs: [],
  sidebarOpen: false,
  sidebarWidth: 380,
  appZoomFactor: 1,
  devicePresetId: 'responsive',
};

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

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.filePath, 'utf8')) as { activeCapsuleId?: string; capsules?: WorkspaceCapsule[] };
      if (!Array.isArray(raw.capsules)) return;
      for (const item of raw.capsules) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.workspacePath !== 'string') continue;
        this.capsules.set(item.id, {
          id: item.id,
          name: item.name,
          workspacePath: this.normalizeWorkspacePath(item.workspacePath),
          state: this.mergeState(DEFAULT_STATE, item.state),
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : this.now(),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : this.now(),
        });
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
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, activeCapsuleId: this.activeCapsuleId, capsules: this.list(), updatedAt: this.now() }, null, 2), 'utf8');
    fs.renameSync(tempPath, this.options.filePath);
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
