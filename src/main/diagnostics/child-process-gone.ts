/**
 * The lifecycle record for an Electron `child-process-gone` event.
 *
 * Electron reports the process type, exit reason and code (plus `name`/`serviceName` for
 * utility processes) but no pid, so a crashed process cannot be matched to the pages that
 * used it by id. The one process whose death is known to reach every page is the GPU
 * process: every renderer composites through it, so a GPU exit lists all live tabs as
 * affected. For any other type the affected set is reported as unknown rather than guessed.
 *
 * Tabs are described by id plus host and path only, never the query or fragment.
 */

/** The subset of Electron's `Details` this record reads. */
export interface ChildProcessGoneDetails {
  type: string;
  reason: string;
  exitCode: number;
  name?: string;
  serviceName?: string;
}

export interface LiveTabSummary {
  id: string;
  url?: string;
}

export interface AffectedTabRecord {
  tabId: string;
  host: string;
  path: string;
}

export type ChildProcessGoneScope = 'all-tabs' | 'unknown';

export interface ChildProcessGoneRecord {
  type: string;
  reason: string;
  exitCode: number;
  name?: string;
  serviceName?: string;
  /** `all-tabs`: the process serves every page (GPU). `unknown`: no id-level match exists. */
  affectedScope: ChildProcessGoneScope;
  affectedTabCount: number;
  affectedTabs: AffectedTabRecord[];
}

/** Bounded so a window with many tabs cannot inflate one journal line. */
export const MAX_AFFECTED_TABS = 20;
const MAX_PATH_LENGTH = 120;

function hostAndPath(rawUrl: string | undefined): { host: string; path: string } {
  if (!rawUrl) return { host: '', path: '' };
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { host: '', path: '' };
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.slice(0, MAX_PATH_LENGTH) };
  } catch {
    return { host: '', path: '' };
  }
}

export function describeChildProcessGone(
  details: ChildProcessGoneDetails,
  liveTabs: readonly LiveTabSummary[],
): ChildProcessGoneRecord {
  const servesEveryPage = details.type === 'GPU';
  const affected = servesEveryPage ? liveTabs : [];
  return {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    ...(details.name ? { name: details.name } : {}),
    ...(details.serviceName ? { serviceName: details.serviceName } : {}),
    affectedScope: servesEveryPage ? 'all-tabs' : 'unknown',
    affectedTabCount: affected.length,
    affectedTabs: affected.slice(0, MAX_AFFECTED_TABS).map((tab) => ({ tabId: tab.id, ...hostAndPath(tab.url) })),
  };
}
