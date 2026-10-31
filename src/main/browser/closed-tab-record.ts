/**
 * What a host remembers about a tab it closed, so a later `TARGET_STALE` for that id can say who
 * closed it and why instead of only "tab gone".
 *
 * Kept as plain functions over a caller-owned `Map` so the host's partially built test doubles keep
 * working and the bounded-history rule is testable without a window.
 */

/** Who initiated the close. */
export type ClosedBy = 'agent' | 'page' | 'user' | 'app';

/** One closed tab as the host recorded it. */
export interface ClosedTabRecord {
  /** The session pool anchor the tab belonged to, when it was in one (feeds failover). */
  anchor?: string;
  closedBy: ClosedBy;
  /** The close source label the host was given (`mcp-tool`, `view-close`, ...). */
  reason: string;
  /** Epoch ms of the close. */
  at: number;
}

/** The caller-visible part of a record, with the live replacement the session can rebind to. */
export interface ClosedTabInfo {
  closedBy: ClosedBy;
  closeReason: string;
  closedAt: number;
  replacementTabId?: string;
}

/** Most recent closes kept per host. */
export const CLOSED_TAB_RECORD_CAP = 64;

/**
 * Map a host close-source label onto the party that caused it.
 *
 * `view-close` and `view-destroyed` are raised by the page's own web contents (`window.close()` or a
 * renderer teardown), `user-*` by the toolbar and menus, `mcp-tool`/`bridge-rpc`/`agent-*` by an
 * automation caller. Anything else (`close-attempt`, an unlabeled call) is the application itself.
 */
export function classifyCloseSource(source: string | undefined): ClosedBy {
  const label = typeof source === 'string' ? source.trim() : '';
  if (label.startsWith('user-')) return 'user';
  if (label === 'mcp-tool' || label === 'bridge-rpc' || label.startsWith('agent-')) return 'agent';
  if (label === 'view-close' || label === 'view-destroyed') return 'page';
  return 'app';
}

/** Record one close, newest last, evicting the oldest past `CLOSED_TAB_RECORD_CAP`. */
export function recordClosedTab(
  records: Map<string, ClosedTabRecord>,
  tabId: string,
  anchor: string | undefined,
  source: string | undefined,
  now: number = Date.now()
): void {
  if (!tabId) return;
  records.delete(tabId);
  records.set(tabId, {
    ...(anchor ? { anchor } : {}),
    closedBy: classifyCloseSource(source),
    reason: typeof source === 'string' && source.trim() ? source.trim() : 'unspecified',
    at: now,
  });
  while (records.size > CLOSED_TAB_RECORD_CAP) {
    const oldest = records.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

/** The caller-visible view of a record; `replacementTabId` is only included when one is live. */
export function describeClosedTab(record: ClosedTabRecord | undefined, replacementTabId?: string): ClosedTabInfo | undefined {
  if (!record) return undefined;
  return {
    closedBy: record.closedBy,
    closeReason: record.reason,
    closedAt: record.at,
    ...(replacementTabId ? { replacementTabId } : {}),
  };
}
