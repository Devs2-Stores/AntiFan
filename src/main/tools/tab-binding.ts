/** Whether a tab's URL is on the storefront host (scheme and port are ignored: preview and live differ only there). */
export function storefrontHostMatches(tabUrl: unknown, storefrontOrigin: string | undefined): boolean {
  if (typeof tabUrl !== 'string' || !tabUrl || !storefrontOrigin) return false;
  try {
    return new URL(tabUrl).hostname.toLowerCase() === new URL(storefrontOrigin).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The one tab a session that lost its bound tab may rebind to without asking: exactly one storefront
 * match, and only while the bound tab is really gone. Two matches are ambiguous, so none is named.
 */
export function pickAutoBindCandidate(rows: ReadonlyArray<{ id: string; storefrontMatch?: boolean }>, boundTabAlive: boolean): string | undefined {
  if (boundTabAlive) return undefined;
  const matches = rows.filter((row) => row.storefrontMatch === true);
  return matches.length === 1 ? matches[0]!.id : undefined;
}
