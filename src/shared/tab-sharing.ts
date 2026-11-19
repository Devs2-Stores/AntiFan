/**
 * Single owner of the strings and limits that describe how an agent session gets (or is refused)
 * a browser tab. The context-menu renderers, the capability gate, the ambient-authority refusals
 * and the control port all import from here, so the label the user is told to click is the label
 * the menu renders.
 */

/** How many tabs one agent session may hold (counted against the session's managed set). */
export const SESSION_TAB_LIMIT = 10;

/** Exact label of the tab context-menu entry that lets the user grant this project's agents a tab. */
export const SHARE_TAB_MENU_LABEL = 'Cho agent của project này dùng tab';

/** Exact label of the entry that lets the user grant the agents of EVERY project (for example a dispatched worker) a tab. */
export const SHARE_TAB_ALL_PROJECTS_MENU_LABEL = 'Cho agent của mọi project dùng tab';

/** Exact label of the entry that takes that grant back. */
export const REVOKE_TAB_SHARE_MENU_LABEL = 'Thu hồi quyền dùng tab của agent';

/** Native menus prefix these labels with an icon; the text after the icon is the shared label. */
export const SHARE_TAB_MENU_ICON = '🤝';
export const REVOKE_TAB_SHARE_MENU_ICON = '🚫';

/** Menu text for the share/revoke toggle, with or without the leading icon. */
export function shareTabMenuText(shared: boolean, withIcon: boolean): string {
  const label = shared ? REVOKE_TAB_SHARE_MENU_LABEL : SHARE_TAB_MENU_LABEL;
  if (!withIcon) return label;
  return `${shared ? REVOKE_TAB_SHARE_MENU_ICON : SHARE_TAB_MENU_ICON} ${label}`;
}

/** Menu text of the all-projects share entry, with or without the leading icon. */
export function shareTabAllProjectsMenuText(withIcon: boolean): string {
  return withIcon ? `${SHARE_TAB_MENU_ICON} ${SHARE_TAB_ALL_PROJECTS_MENU_LABEL}` : SHARE_TAB_ALL_PROJECTS_MENU_LABEL;
}

/**
 * Guidance appended to refusals that name a tab outside the session's authority. The owner of
 * the browser (not the agent) is the only one who can widen that authority, and the grant is an
 * entry of the page's context menu (not of the tab-strip menu), so a user who pastes a tab id is
 * told where to find it.
 */
export const SHARE_TAB_GUIDANCE =
  `To work in a tab this session does not manage (for example one the user opened), the user must right-click INSIDE THE PAGE of that tab (not on the tab strip) and choose '${SHARE_TAB_MENU_LABEL}'; then call anti.browser.rebind_target with its tabId. If this session belongs to a different project than the tab (for example a worker dispatched from another project), the user must choose '${SHARE_TAB_ALL_PROJECTS_MENU_LABEL}' instead. A grant lasts a limited time and ends when the tab closes. Tell the user these exact steps in your reply instead of opening a new tab, which would not carry the page the user has open.`;
