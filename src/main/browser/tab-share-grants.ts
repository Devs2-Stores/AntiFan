/**
 * Tab share grants: the one way a user hands an agent a tab the agent does not own.
 *
 * A grant is written only by Main on behalf of a user gesture (the tab context menu).
 * No capability, tool or IPC route the agent can reach calls `grant`. It is read by
 * the explicit-retarget authority check (`CapabilityCatalogue.isTabAllowedForRetarget`)
 * and by nothing that decides session ownership: a granted tab is never part of a
 * session's own tab pool.
 *
 * A grant is scoped to one project, expires on its own clock and is dropped when its tab
 * closes. Expiry and revocation are enforced where the grant is read, so a stale
 * registry entry can never authorise anything.
 */

/** How long a grant lasts when the user does not choose. */
export const DEFAULT_TAB_SHARE_TTL_MS = 15 * 60_000;
/** The longest a single grant may last, whatever TTL is requested. */
export const MAX_TAB_SHARE_TTL_MS = 60 * 60_000;

export interface TabShareGrant {
  readonly tabId: string;
  readonly projectId: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
}

export type TabShareJournal = (event: string, fields: Record<string, unknown>) => void;

export interface TabShareGrantsOptions {
  /** Clock seam; production reads `Date.now`. */
  now?: () => number;
  /** Journal seam; a throwing journal never affects grant state. */
  journal?: TabShareJournal;
}

export class TabShareGrants {
  private readonly grants = new Map<string, TabShareGrant>();
  private readonly now: () => number;
  private journal: TabShareJournal | undefined;

  constructor(options: TabShareGrantsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
  }

  /** Replace the journal sink (Main installs the lifecycle journal at host construction). */
  setJournal(journal: TabShareJournal | undefined): void {
    this.journal = journal;
  }

  /**
   * Record a grant for a tab, replacing any earlier one. The TTL is clamped to
   * `MAX_TAB_SHARE_TTL_MS`; a missing or non-positive TTL takes the default.
   */
  grant(tabId: string, projectId: string, ttlMs: number = DEFAULT_TAB_SHARE_TTL_MS): TabShareGrant {
    const tab = typeof tabId === 'string' ? tabId.trim() : '';
    const project = typeof projectId === 'string' ? projectId.trim() : '';
    if (!tab) throw new Error('A tab share grant needs a tab id');
    if (!project) throw new Error('A tab share grant needs a project id');
    const requested = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TAB_SHARE_TTL_MS;
    const grantedAt = this.now();
    const grant: TabShareGrant = Object.freeze({
      tabId: tab,
      projectId: project,
      grantedAt,
      expiresAt: grantedAt + Math.min(requested, MAX_TAB_SHARE_TTL_MS),
    });
    this.grants.set(tab, grant);
    this.record('tab-share-grant.granted', { tabId: tab, projectId: project, expiresAt: grant.expiresAt });
    return grant;
  }

  /** The live grant for a tab, or undefined when there is none or it has expired. */
  get(tabId: string): TabShareGrant | undefined {
    if (typeof tabId !== 'string') return undefined;
    const key = tabId.trim();
    const found = this.grants.get(key);
    if (!found) return undefined;
    if (found.expiresAt <= this.now()) {
      this.grants.delete(key);
      this.record('tab-share-grant.expired', { tabId: key, projectId: found.projectId });
      return undefined;
    }
    return found;
  }

  /** Withdraw a grant. Returns whether a live grant was removed. */
  revoke(tabId: string): boolean {
    if (typeof tabId !== 'string') return false;
    const key = tabId.trim();
    const found = this.grants.get(key);
    if (!found) return false;
    this.grants.delete(key);
    this.record('tab-share-grant.revoked', { tabId: key, projectId: found.projectId });
    return true;
  }

  /** Drop the grant of a tab that no longer exists. */
  revokeForClosedTab(tabId: string): void {
    if (typeof tabId !== 'string') return;
    const key = tabId.trim();
    const found = this.grants.get(key);
    if (!found) return;
    this.grants.delete(key);
    this.record('tab-share-grant.revoked', { tabId: key, projectId: found.projectId, reason: 'tab-closed' });
  }

  /** Journal that a live grant authorised a retarget. */
  noteUse(grant: TabShareGrant): void {
    this.record('tab-share-grant.used', { tabId: grant.tabId, projectId: grant.projectId });
  }

  /** Every live grant; expired entries are pruned first. */
  all(): readonly TabShareGrant[] {
    for (const tabId of Array.from(this.grants.keys())) this.get(tabId);
    return Array.from(this.grants.values());
  }

  private record(event: string, fields: Record<string, unknown>): void {
    if (!this.journal) return;
    try {
      this.journal(event, fields);
    } catch {
      // A journal fault must never change what a grant allows.
    }
  }
}

/**
 * The process-wide registry. Tab ids are unique across every window of this process, so
 * one registry serves all hosts: the host that owns the tab writes it (through a user
 * gesture) and the retarget check reads it without a per-window lookup.
 */
export const tabShareGrants = new TabShareGrants();
