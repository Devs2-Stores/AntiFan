/**
 * Pure hibernation policy for Chrome tabs.
 *
 * The host owns every side effect — snapshotting, destroying views, recreating
 * them — while this module answers the one question a sweep asks per tab:
 * may this record lose its live views now? The answer is computed from the
 * tab's serialized state plus the host-supplied context, so the rule is
 * testable without an Electron process.
 */
import type { AntiFanTab } from '../../shared/contracts';

/** Idle threshold the user picked: 5 minutes. The production sweep always uses this constant. */
export const HIBERNATE_IDLE_MS = 5 * 60 * 1000;
/**
 * Extended idle floor for Google Docs and Sheets editor tabs: 20 minutes. A
 * sleeping editor tab loses its live renderer on return, so documents and
 * spreadsheets the user works in get a longer grace period than an ordinary
 * page before the sweep may park them.
 */
export const GOOGLE_DOCS_HIBERNATE_IDLE_MS = 20 * 60 * 1000;
/** How often one host asks the policy about every tab. */
export const HIBERNATE_SWEEP_INTERVAL_MS = 60 * 1000;
/** A blank tab (no page) unused this long is closed by the sweep: 30 minutes. */
export const BLANK_TAB_CLOSE_IDLE_MS = 30 * 60 * 1000;

/**
 * True only for the Google Docs and Sheets editor surfaces under
 * `docs.google.com` (`/document`, `/spreadsheets`). Presentations, forms and
 * other paths keep the ordinary threshold. Malformed or absent URLs answer
 * false — the floor is a privilege, never the default.
 */
export function isGoogleDocsEditorUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'docs.google.com' && !host.endsWith('.docs.google.com')) return false;
    return parsed.pathname.startsWith('/document') || parsed.pathname.startsWith('/spreadsheets');
  } catch {
    return false;
  }
}

/**
 * The idle threshold one tab's URL earns: `GOOGLE_DOCS_HIBERNATE_IDLE_MS` for
 * Docs/Sheets editors, `baseMs` otherwise. The floor is a maximum, so a URL
 * rule can only keep a tab awake longer, never shorten the base.
 */
export function hibernationIdleMsForUrl(url: string | undefined, baseMs: number): number {
  return isGoogleDocsEditorUrl(url) ? Math.max(baseMs, GOOGLE_DOCS_HIBERNATE_IDLE_MS) : baseMs;
}

/**
 * Facts the policy cannot read from the tab record itself. The host computes
 * them once per sweep; the module stays free of host/Electron types.
 */
export interface HibernationContext {
  /** The tab this host's window is presenting right now. */
  activeTabId: string;
  /** The agent-automation target tab, when one is bound. */
  automationTabId?: string | null;
  /** Tab ids a live MCP attachment or evidence lease is bound to. */
  boundTabIds?: ReadonlySet<string>;
  /** Tab ids with an open debugger/CDP session or open DevTools. */
  cdpBoundTabIds?: ReadonlySet<string>;
  /** Tab ids a dirty-form probe already vetoed for this sleep cycle. */
  unloadVetoedTabIds?: ReadonlySet<string>;
  /** The wall clock, injectable so tests and the sweep share one reading. */
  now?: number;
  /**
   * Idle threshold in ms. Defaults to `HIBERNATE_IDLE_MS`; a test seam may pass
   * a smaller value — production code never does.
   */
  idleMs?: number;
  /**
   * Idle threshold in ms for closing blank tabs. Defaults to
   * `BLANK_TAB_CLOSE_IDLE_MS`; a test seam may pass a smaller value.
   */
  blankCloseIdleMs?: number;
}

export type HibernationDecision =
  | { hibernate: true }
  | { hibernate: false; reason: HibernationRefusal };

export type HibernationRefusal =
  | 'already-hibernated'
  | 'active-tab'
  | 'audible'
  | 'loading'
  | 'agent-plane'
  | 'oauth-popup'
  | 'automation-target'
  | 'mcp-bound'
  | 'cdp-bound'
  | 'unload-veto'
  | 'not-idle';

/**
 * Whether `tab` may be hibernated at `ctx.now`. Pure: no I/O, no Electron.
 * `lastActiveAt` is the last time the tab was activated or the user interacted
 * with it; absent/zero reads as the epoch — a background tab that was never
 * foregrounded is the idlest tab in the window.
 *
 * Exclusion order is deliberate: the cheap identity checks run before the time
 * comparison, and each refusal carries the reason the sweep logs.
 */
export function shouldHibernate(
  tab: { id: string; state: AntiFanTab; lastActiveAt?: number },
  ctx: HibernationContext
): HibernationDecision {
  const state = tab.state;

  if (state.hibernated === true) return { hibernate: false, reason: 'already-hibernated' };
  const protectedReason = tabProtectionReason(tab, ctx);
  if (protectedReason) return { hibernate: false, reason: protectedReason };
  if (ctx.unloadVetoedTabIds?.has(tab.id)) return { hibernate: false, reason: 'unload-veto' };

  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
  const baseIdleMs = typeof ctx.idleMs === 'number' && ctx.idleMs > 0 ? ctx.idleMs : HIBERNATE_IDLE_MS;
  const idleMs = hibernationIdleMsForUrl(state.url, baseIdleMs);
  const lastActiveAt = typeof tab.lastActiveAt === 'number' && tab.lastActiveAt > 0 ? tab.lastActiveAt : 0;
  if (now - lastActiveAt < idleMs) return { hibernate: false, reason: 'not-idle' };

  return { hibernate: true };
}

/**
 * Refusals both sleeping and closing a tab honor: the tab is presented, playing,
 * loading, owned by an agent or an opener, or held by a live automation/MCP/CDP
 * binding. Undefined when none applies.
 */
function tabProtectionReason(
  tab: { id: string; state: AntiFanTab },
  ctx: HibernationContext
): HibernationRefusal | undefined {
  const state = tab.state;
  if (tab.id === ctx.activeTabId) return 'active-tab';
  if (state.isAudible === true) return 'audible';
  if (state.isLoading === true) return 'loading';
  if (state.ephemeral === true) return 'agent-plane';
  // A popup's page is tied to its opener through window.opener; rebuilding the view on wake
  // would load the URL into a fresh page with no opener, so the sign-in could never complete.
  if (typeof state.popupOf === 'string' && state.popupOf) return 'oauth-popup';
  if (ctx.automationTabId && tab.id === ctx.automationTabId) return 'automation-target';
  if (ctx.boundTabIds?.has(tab.id)) return 'mcp-bound';
  if (ctx.cdpBoundTabIds?.has(tab.id)) return 'cdp-bound';
  return undefined;
}

/** A tab with no page: `about:blank`, or no URL at all. */
export function isBlankTabUrl(url: string | undefined): boolean {
  return !url || url === 'about:blank';
}

/**
 * Whether `tab` is an empty tab (no page) that has sat unused for
 * `BLANK_TAB_CLOSE_IDLE_MS` and may be closed outright. Only blank tabs ever
 * qualify: a tab holding a page is slept by `shouldHibernate`, never closed.
 * Idle time counts the later of the last user activity and the last agent
 * operation on the tab. Pure: no I/O, no Electron.
 */
export function shouldCloseIdleBlankTab(
  tab: { id: string; state: AntiFanTab; lastActiveAt?: number; agentActivityAt?: number },
  ctx: HibernationContext
): boolean {
  if (!isBlankTabUrl(tab.state.url)) return false;
  if (tabProtectionReason(tab, ctx)) return false;
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
  const idleMs = typeof ctx.blankCloseIdleMs === 'number' && ctx.blankCloseIdleMs > 0
    ? ctx.blankCloseIdleMs
    : BLANK_TAB_CLOSE_IDLE_MS;
  const lastUsedAt = Math.max(
    typeof tab.lastActiveAt === 'number' ? tab.lastActiveAt : 0,
    typeof tab.agentActivityAt === 'number' ? tab.agentActivityAt : 0,
  );
  return now - lastUsedAt >= idleMs;
}
