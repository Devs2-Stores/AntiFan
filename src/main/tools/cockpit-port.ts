/**
 * CockpitPort — the host-resolution seam between the `theme.cockpit_*`
 * capability family and `NativeTabHost`.
 *
 * The composition root (`index.ts`) fills `CockpitHostPort` with the same
 * tab-authority callbacks `BrowserControlPort` is built from, so this port
 * never names a tab a live window does not own, and a dead bound tab degrades
 * to a `TARGET_REQUIRED` refusal instead of silently retargeting another
 * window's surface.
 *
 * Scope derivation is memoized per tab and keyed on the tab's current URL —
 * but only the URL-derived parts (origin) are cached. `workspaceRoot` is
 * re-resolved on EVERY call: a workspace that becomes resolvable later (new
 * terminal session, capsule binding, URL→project mapping) must upgrade the
 * identity from provisional immediately, and a provisional identity is never
 * memoized at all. Navigation still changes the URL, which invalidates the
 * memo on the next `resolveScope` call.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';
import {
  checklistScope,
  workspaceTag,
  type ThemeChecklistItem,
} from '../../shared/theme-checklist';
import type {
  ChecklistMutationOp,
  ChecklistMutationResult,
} from '../qa/theme-checklist-store';

/** The QA state row a host keeps per tab (mirrors NativeTabHost's record). */
export interface CockpitQaState {
  status: 'idle' | 'running' | 'pass' | 'fail' | 'error';
  issueCount: number;
  reportArtifactId?: string;
  report?: unknown;
  error?: string;
  updatedAt: number;
}

export interface CockpitChecklistLoadResult {
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
  existed: boolean;
  migrated: boolean;
  isProvisional: boolean;
}

export interface CockpitChecklistSaveResult {
  ok: boolean;
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
  conflict?: boolean;
  isProvisional?: boolean;
}

export interface CockpitChecklistMutateResult extends ChecklistMutationResult {
  scope: string;
  workspaceRoot: string;
  isProvisional: boolean;
}

export interface CockpitScopeIdentity {
  tabId: string;
  origin: string;
  workspaceRoot: string;
  scope: string;
  /** True when no workspace root resolved — the scope is memory-only. */
  isProvisional: boolean;
}

/**
 * Everything the port needs from the owning window. `index.ts` binds these to
 * `tabAuthorities`-routed calls so a tab id always lands on the host that owns
 * it; a tab id no host owns refuses rather than drifting to the ambient host.
 */
export interface CockpitHostPort {
  /** Whether any live host owns this tab id. */
  hasTab(tabId: string): boolean;
  /** The tab's current URL (`''` for absent/blank). */
  getTabUrl(tabId: string): string;
  /** The tab's resolved workspace root (`''` when unresolvable). */
  resolveTabWorkspaceRoot(tabId: string, tabUrl?: string): string;
  navigateAndWait(tabId: string, url: string, timeoutMs?: number): Promise<boolean>;
  runThemeQa(tabId: string, options?: { workspaceRoot?: string }): Promise<{ ok: boolean; report?: unknown; error?: string }>;
  getThemeQaState(tabId: string): CockpitQaState;
  checklistLoad(tabId: string, input: { scope: string; workspaceRoot: string }): CockpitChecklistLoadResult;
  checklistMutate(tabId: string, input: { scope: string; workspaceRoot: string; op: ChecklistMutationOp }): CockpitChecklistMutateResult;
  checklistSave(tabId: string, input: { scope: string; workspaceRoot: string; items: unknown; baseUpdatedAt?: number }): CockpitChecklistSaveResult;
}

export class CockpitPort {
  /** Memoized `{url, origin}` per tab; the workspace root is resolved fresh. */
  private readonly scopeMemos = new Map<string, { url: string; origin: string }>();

  constructor(private readonly host: CockpitHostPort) {}

  /**
   * Derive the checklist identity for a bound tab. The scope is only as
   * durable as the workspace it names: when the host cannot resolve a root the
   * identity is provisional (`origin@unknown-workspace`) and capability code
   * must not pretend persistence exists.
   */
  public resolveScope(tabId: string): CockpitScopeIdentity {
    const cleanId = typeof tabId === 'string' ? tabId.trim() : '';
    if (!cleanId || !this.host.hasTab(cleanId)) {
      // Dead tabs self-release their memo: with no close-event seam into this
      // port, the authority check is the single choke point every capability
      // already passes through.
      if (cleanId) this.scopeMemos.delete(cleanId);
      throw new CapabilityError('TARGET_REQUIRED', `Cockpit scope requires a live bound tab; "${cleanId}" owns no window`);
    }
    const url = this.host.getTabUrl(cleanId) || '';
    const memo = this.scopeMemos.get(cleanId);
    let origin: string;
    if (memo && memo.url === url) {
      origin = memo.origin;
    } else {
      origin = 'unbound';
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
      } catch {
        // not a navigable origin — 'unbound' stays the honest answer
      }
      this.scopeMemos.set(cleanId, { url, origin });
    }
    // Resolved fresh every call — never memoized, so a later-bound workspace
    // and a resolved→unresolvable transition both surface immediately.
    const workspaceRoot = this.host.resolveTabWorkspaceRoot(cleanId, url) || '';
    return {
      tabId: cleanId,
      origin,
      workspaceRoot,
      scope: checklistScope(origin, workspaceTag(workspaceRoot)),
      isProvisional: workspaceRoot.trim().length === 0,
    };
  }

  /** Forget the memoized identity for a closed tab. */
  public releaseTab(tabId: string): void {
    this.scopeMemos.delete(tabId);
  }

  public navigateAndWait(tabId: string, url: string, timeoutMs?: number): Promise<boolean> {
    const cleanId = typeof tabId === 'string' ? tabId.trim() : '';
    if (!cleanId || !this.host.hasTab(cleanId)) {
      throw new CapabilityError('TARGET_REQUIRED', `navigateAndWait requires a live bound tab; "${cleanId}" owns no window`);
    }
    return this.host.navigateAndWait(cleanId, url, timeoutMs);
  }

  public runThemeQa(tabId: string, options?: { workspaceRoot?: string }): Promise<{ ok: boolean; report?: unknown; error?: string }> {
    const cleanId = typeof tabId === 'string' ? tabId.trim() : '';
    if (!cleanId || !this.host.hasTab(cleanId)) {
      throw new CapabilityError('TARGET_REQUIRED', `runThemeQa requires a live bound tab; "${cleanId}" owns no window`);
    }
    return this.host.runThemeQa(cleanId, options);
  }

  public getThemeQaState(tabId: string): CockpitQaState {
    return this.host.getThemeQaState(tabId);
  }

  public checklistLoad(tabId: string, input: { scope: string; workspaceRoot: string }): CockpitChecklistLoadResult {
    return this.host.checklistLoad(tabId, input);
  }

  public checklistMutate(tabId: string, input: { scope: string; workspaceRoot: string; op: ChecklistMutationOp }): CockpitChecklistMutateResult {
    return this.host.checklistMutate(tabId, input);
  }

  public checklistSave(tabId: string, input: { scope: string; workspaceRoot: string; items: unknown; baseUpdatedAt?: number }): CockpitChecklistSaveResult {
    return this.host.checklistSave(tabId, input);
  }
}
