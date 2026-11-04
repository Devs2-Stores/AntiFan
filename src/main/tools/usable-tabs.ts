/**
 * The tabs a session may address, as a refusal about the wrong tab must show them so the caller can
 * pick a right one instead of guessing. Read-only and diagnostic: it never grants anything, it only
 * lists what the host's own authority checks already admit.
 */

/** Most tabs a refusal lists. */
export const USABLE_TABS_SAMPLE_MAX = 8;

export interface UsableTab {
  id: string;
  url?: string;
}

/** What a host answers about the tabs of one session; every reader may throw and is then treated as "no". */
export interface UsableTabsSource {
  /** Tabs the session manages (opened or adopted), not including the bound tab itself. */
  managedTabIds(boundTabId: string): Iterable<string>;
  /** False for a tab that no longer exists: offering it would send the caller into a stale-target refusal. */
  isLive(tabId: string): boolean;
  /** The host's own admission check for acting on `tabId` while bound to `boundTabId`. */
  isAllowed(boundTabId: string, tabId: string): boolean;
  urlOf(tabId: string): string | undefined;
}

/** The bound tab first, then the managed ones, live and admitted only, bounded. */
export function listUsableTabs(boundTabId: string, source: UsableTabsSource, max = USABLE_TABS_SAMPLE_MAX): UsableTab[] {
  let managed: Iterable<string> = [];
  try {
    managed = source.managedTabIds(boundTabId) ?? [];
  } catch {
    managed = [];
  }
  const usable = (id: string): boolean => {
    try {
      if (!source.isLive(id)) return false;
      return id === boundTabId || source.isAllowed(boundTabId, id);
    } catch {
      return false;
    }
  };
  return [...new Set([boundTabId, ...managed])].filter(usable).slice(0, max).map((id) => {
    let url: string | undefined;
    try {
      url = source.urlOf(id) || undefined;
    } catch {
      url = undefined;
    }
    return url ? { id, url } : { id };
  });
}

/** Sentence naming the usable tabs and the call that opens one of the session's own. */
export function describeUsableTabs(tabs: readonly UsableTab[]): string {
  const list = tabs.map((tab) => (tab.url ? `${tab.id} (${tab.url})` : tab.id)).join(', ');
  const open = 'open your own with anti.browser.tabs.create {url, bind: false} and use the tabId it returns';
  if (!list) return `This session has no live tab it may use: ${open}, or rebind to a live one with anti.browser.rebind_target.`;
  return `Tabs this session may use: ${list}. Pass one of them as tabId on every call, or ${open}.`;
}

/** The hosts a session's tabs may live on, as a refusal sees them. */
export interface UsableTabsDirectory {
  /** The host-level reader for a tab, or undefined when no live host owns it (the tab is dead). */
  sourceForTab(tabId: string): UsableTabsSource | undefined;
  /** The live tab the host names as the survivor of a closed bound tab the same session owned. */
  failoverOf(staleTabId: string): string | undefined;
}

/**
 * The usable tabs of the session bound to `boundTabId`. A binding whose tab is gone has no host to
 * ask, yet the session may well hold other live tabs: they are found through the failover the
 * retarget gate already uses, which only names tabs the stale session owns. Undefined when neither
 * the binding nor a survivor can be asked, so a refusal never claims "no tab" on no evidence.
 */
export function listUsableTabsForSession(boundTabId: string, directory: UsableTabsDirectory, max = USABLE_TABS_SAMPLE_MAX): UsableTab[] | undefined {
  const direct = directory.sourceForTab(boundTabId);
  if (direct) return listUsableTabs(boundTabId, direct, max);
  const survivor = directory.failoverOf(boundTabId);
  const survivorSource = survivor ? directory.sourceForTab(survivor) : undefined;
  return survivor && survivorSource ? listUsableTabs(survivor, survivorSource, max) : undefined;
}
