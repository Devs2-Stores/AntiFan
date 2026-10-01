/**
 * AntiFan Browser Desktop — Tab ambient authority
 *
 * The routing layer shared services consult before touching a host: which window
 * owns this tab, and which host answers when the call names no tab at all.
 *
 * Two failure shapes this module exists to keep honest once several project
 * windows are live:
 *
 * - A call that names no tab and has no pinned owner refuses with a typed
 *   `TARGET_REQUIRED` (never an untyped error — the transport maps those to
 *   `UNAUTHENTICATED`, which made even `tabs.list`/`rebind_target` deadlock).
 * - A call carrying an explicit id no live host owns — a bound tab that died —
 *   does NOT fall back to the ambient host. Each seam degrades to exactly the
 *   answer a live host gives for an unknown id (`[]`, `new Set()`, `false`,
 *   `1`, `undefined`), or refuses with `TARGET_STALE`, the same code the host
 *   itself answers a dead tab with. The degrade is journaled so the misroute
 *   stays diagnosable.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';
import type { NativeTabHost } from './native-tab-host';
import type { TabAuthorityDirectory } from './tab-authority-directory';
import type { WorkspaceCapsule } from '../project/workspace-capsule';

/** The affiliation a tab measures into, when one could be measured. */
export type MeasuredTabAffiliation = { projectId?: string; workspaceId?: string; capsuleId?: string } | undefined;
export interface TabAmbientAuthorityDeps {
  /** The live window→host directory — the same instance index.ts registers shells into. */
  directory: Pick<TabAuthorityDirectory, 'hosts' | 'hostForTab'>;
  /** The capsule ledger the affiliation read consults; undefined when no store exists. */
  capsules?: () => ReadonlyArray<Pick<WorkspaceCapsule, 'id' | 'projectId' | 'workspaceId'>>;
  /** Lifecycle journal sink; degrades are recorded under `tabhost.boundTabDegraded`. */
  journal?: (event: string, fields?: Record<string, unknown>) => void;
}

export class TabAmbientAuthority {
  /** Ids already journaled as unowned — a dead binding polls many seams per dispatch. */
  private readonly journaledUnowned = new Set<string>();

  constructor(private readonly deps: TabAmbientAuthorityDeps) {}

  /**
   * The host a shared service acts on when the call names neither a tab nor a sender.
   *
   * There is no ambient "current window": the automation-target owner is the one
   * window an unbound agent authority is already pinned to (see the bridge's runtime
   * binding), and a single-window process is unambiguous by construction. Anything
   * else refuses with `TARGET_REQUIRED`, so a request can never land in whichever
   * window was created first — and never degrades to `UNAUTHENTICATED` in flight.
   */
  ambientHostOrThrow(): NativeTabHost {
    const hosts = this.deps.directory.hosts();
    const automationHost = hosts.find((host) => host.getAutomationTabId() != null);
    if (automationHost) return automationHost;
    if (hosts.length === 1) return hosts[0]!;
    if (hosts.length === 0) {
      throw new CapabilityError('TARGET_REQUIRED', 'No project window is live, so no tab host can serve this request');
    }
    throw new CapabilityError(
      'TARGET_REQUIRED',
      `${hosts.length} project windows are live and this request names no window, tab or sender`,
      { liveHosts: hosts.length }
    );
  }

  /**
   * The host for a functional or write seam.
   *
   * An explicit id routes to its owning host; an explicit id no live host owns
   * refuses with `TARGET_STALE`, the same answer the host itself gives a dead
   * tab — falling through to the ambient host would let a stale binding silently
   * act on another window's tab. Only an absent id consults the ambient host.
   */
  hostForTabOrBootstrap(tabId: string | undefined): NativeTabHost {
    if (tabId) {
      const owner = this.deps.directory.hostForTab(tabId);
      if (owner) return owner;
      this.noteUnowned(tabId, 'bootstrap-refusal');
      throw new CapabilityError('TARGET_STALE', `Target tab '${tabId}' is not owned by any live window`, { tabId });
    }
    return this.ambientHostOrThrow();
  }

  /**
   * The host for a read/recovery seam, or `undefined` when the named tab is dead.
   *
   * Callers supply the degrade value their seam answers with — identical to the
   * value a live host returns for an unknown id — so `tabs.list`, the retarget
   * gate and `rebind_target` keep working for sessions whose bound tab is gone.
   * An absent id still consults the ambient host and may refuse `TARGET_REQUIRED`.
   */
  hostForTabOrDegrade(tabId: string | undefined, seam: string): NativeTabHost | undefined {
    if (tabId) {
      const owner = this.deps.directory.hostForTab(tabId);
      if (owner) return owner;
      this.noteUnowned(tabId, seam);
      return undefined;
    }
    return this.ambientHostOrThrow();
  }

  /**
   * Measured affiliation of a tab: the capsule it was created under, read off the live
   * host rather than the capsule ledger (which holds entries no runtime path writes).
   * Shared by the control plane's terminal-origin gate and the browser port, so both
   * refuse a foreign bound tab on the same evidence instead of two copies that can
   * drift apart. A tab no live host owns measures nothing — never the ambient host's
   * guess at it.
   */
  measuredTabAffiliation(tabId: string): MeasuredTabAffiliation {
    const host = this.deps.directory.hostForTab(tabId);
    if (!host || !host.hasTab(tabId)) return undefined;
    const resolvedTabId = host.resolveTargetTabId ? host.resolveTargetTabId(tabId) : tabId;
    const capsuleId = host.getTabCapsuleId(resolvedTabId ?? tabId);
    const capsule = capsuleId ? this.deps.capsules?.().find((c) => c.id === capsuleId) : undefined;
    if (!capsule) return undefined;
    return { projectId: capsule.projectId, workspaceId: capsule.workspaceId, capsuleId: capsule.id };
  }

  /** Journal the first degrade per id so a bound-but-dead route stays diagnosable. */
  private noteUnowned(tabId: string, seam: string): void {
    if (!this.deps.journal || this.journaledUnowned.has(tabId)) return;
    this.journaledUnowned.add(tabId);
    try {
      this.deps.journal('tabhost.boundTabDegraded', { tabId, seam });
    } catch {
      // The journal must never turn a degradable read into a failure.
    }
  }
}
