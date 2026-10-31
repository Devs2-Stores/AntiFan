/**
 * Which tabs each execution attachment created through `anti.browser.tabs.create`.
 *
 * The session tab pool the browser host keeps answers "may this session drive that tab" only for
 * tabs in the same pool as the bound one. A rebind onto a tab outside the pool orphans every tab
 * the session opened earlier: the catalogue gate and `closeTab` both refuse them. A tab an
 * attachment created itself stays under that attachment's authority whatever it is bound to now,
 * so the creator can close or switch back to it; no other attachment inherits that authority.
 *
 * One exception: an attachment minted from an in-app terminal. A terminal that re-attaches gets a
 * new attachment id, and without help it could no longer reach the tabs its previous attachment
 * opened. Such attachments also record the tabs they create under the owner scope
 * `workspaceId|projectId|originTerminalSessionId`, and a later attachment minted from the same
 * terminal in the same project and workspace re-adopts them. The scope is taken from the attachment
 * record the registry has just validated (it re-measures the terminal's current project and
 * workspace on every dispatch), so a terminal that moved projects, an attachment with no origin
 * terminal, or a different project never matches.
 *
 * In memory only: a tab outlives the app process no more than the attachment that opened it. Owner
 * entries are forgotten when their tabs are gone, and after `ownerTtlMs` without an attachment of
 * that scope being seen.
 */

/** Identity an attachment's tabs are owned under when it was minted from a terminal. */
export interface TabOwnerScope {
  workspaceId: string;
  projectId: string;
  /** The minting terminal. Absent means the attachment has no durable owner and re-adopts nothing. */
  originTerminalSessionId?: string;
}

interface OwnerEntry {
  tabs: Set<string>;
  touchedAt: number;
}

/** How long an owner scope stays adoptable with no attachment of that scope dispatching. */
export const TAB_OWNER_TTL_MS = 3_600_000;

function ownerKeyOf(scope: TabOwnerScope | undefined): string | undefined {
  const origin = scope?.originTerminalSessionId?.trim();
  if (!scope || !origin) return undefined;
  return `${scope.workspaceId}|${scope.projectId}|${origin}`;
}

export class AttachmentTabLedger {
  private readonly tabsByAttachment = new Map<string, Set<string>>();
  private readonly tabsByOwner = new Map<string, OwnerEntry>();
  private readonly ownerKeyByAttachment = new Map<string, string>();

  constructor(private readonly options: { now?: () => number; ownerTtlMs?: number } = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private ownerEntry(key: string): OwnerEntry | undefined {
    const entry = this.tabsByOwner.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.touchedAt > (this.options.ownerTtlMs ?? TAB_OWNER_TTL_MS)) {
      this.tabsByOwner.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Tell the ledger which owner scope a live attachment belongs to. Called for every validated
   * dispatch, after the registry accepted the attachment's terminal origin, so a scope only ever
   * comes from an attachment that currently passes the project/workspace check.
   */
  bindAttachment(attachmentId: string, scope: TabOwnerScope | undefined): void {
    if (!attachmentId) return;
    const key = ownerKeyOf(scope);
    if (!key) {
      this.ownerKeyByAttachment.delete(attachmentId);
      return;
    }
    this.ownerKeyByAttachment.set(attachmentId, key);
    const entry = this.ownerEntry(key);
    if (entry) entry.touchedAt = this.now();
  }

  /** Note that `attachmentId` created `tabId`; `scope` also files it under the terminal owner. */
  record(attachmentId: string, tabId: string, scope?: TabOwnerScope): void {
    if (!attachmentId || !tabId) return;
    let tabs = this.tabsByAttachment.get(attachmentId);
    if (!tabs) {
      tabs = new Set();
      this.tabsByAttachment.set(attachmentId, tabs);
    }
    tabs.add(tabId);
    const key = ownerKeyOf(scope);
    if (!key) return;
    this.ownerKeyByAttachment.set(attachmentId, key);
    const entry = this.ownerEntry(key) ?? { tabs: new Set<string>(), touchedAt: this.now() };
    entry.tabs.add(tabId);
    entry.touchedAt = this.now();
    this.tabsByOwner.set(key, entry);
  }

  /**
   * Whether `attachmentId` created `tabId` itself, or was minted from the same terminal (same
   * project and workspace) as the attachment that did.
   */
  owns(attachmentId: string, tabId: string): boolean {
    if (this.tabsByAttachment.get(attachmentId)?.has(tabId) === true) return true;
    const key = this.ownerKeyByAttachment.get(attachmentId);
    if (!key) return false;
    return this.ownerEntry(key)?.tabs.has(tabId) === true;
  }

  /** Forget the tabs `isLive` reports gone, and any attachment or owner left with none. */
  prune(isLive: (tabId: string) => boolean): void {
    for (const [attachmentId, tabs] of this.tabsByAttachment) {
      for (const tabId of tabs) {
        if (!isLive(tabId)) tabs.delete(tabId);
      }
      if (tabs.size === 0) this.tabsByAttachment.delete(attachmentId);
    }
    for (const key of [...this.tabsByOwner.keys()]) {
      const entry = this.ownerEntry(key);
      if (!entry) continue;
      for (const tabId of entry.tabs) {
        if (!isLive(tabId)) entry.tabs.delete(tabId);
      }
      if (entry.tabs.size === 0) this.tabsByOwner.delete(key);
    }
  }

  /**
   * Drop every tab recorded for an attachment that is gone. Tabs filed under its terminal owner
   * stay: the next attachment from that terminal is meant to re-adopt them.
   */
  release(attachmentId: string): void {
    this.tabsByAttachment.delete(attachmentId);
    this.ownerKeyByAttachment.delete(attachmentId);
  }

  /** Drop the record of every attachment that is not in `liveAttachmentIds`. */
  retainAttachments(liveAttachmentIds: ReadonlySet<string>): void {
    const known = new Set([...this.tabsByAttachment.keys(), ...this.ownerKeyByAttachment.keys()]);
    for (const attachmentId of known) {
      if (!liveAttachmentIds.has(attachmentId)) this.release(attachmentId);
    }
  }
}
