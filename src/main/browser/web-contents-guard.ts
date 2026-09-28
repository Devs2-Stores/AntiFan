/**
 * Race-safe WebContents send helper.
 *
 * Extracted from the tab host so per-window shells can dispatch to their own
 * chrome surfaces without importing the host (which imports them).
 */
export function safeSendWebContents(
  wc: Electron.WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (typeof wc.isCrashed === 'function' && wc.isCrashed()) return false;
    if (!wc.mainFrame) return false;
    wc.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}
