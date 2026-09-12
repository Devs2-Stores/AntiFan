/**
 * Decides what a mirror run does with one asset.
 *
 * A pull is a mirror, never a sync: a file that changed after the pull is
 * someone's work and is left alone. For the remaining files the only question
 * is whether the remote copy moved on.
 *
 * Remote drift is read from the API `updated_at`, from the byte length of a text
 * asset — whose length is exact — and, for a binary, from a length that disagrees
 * with the API-declared stored size. That last signal is weak: the CDN sometimes
 * answers a download with a converted variant, and the mirror then holds bytes
 * whose length differs from the stored asset with no remote change at all. A key
 * that already showed that behaviour is recorded as a variant representation and
 * is no longer refreshed on length, so the weak signal can never become a
 * download-every-run loop.
 */

export const PULL_ACTION = Object.freeze({
  FETCH: 'fetch',
  REFRESH: 'refresh',
  SKIP: 'skip',
  EDITED: 'edited',
});

export function decidePullAction({
  exists,
  localSize = 0,
  localHash = null,
  recorded = null,
  isText = false,
  remoteSize = null,
  remoteUpdatedAt = null,
  forceRefresh = false,
}) {
  if (!exists || localSize === 0) return PULL_ACTION.FETCH;

  if (recorded && recorded.sha256 && localHash && recorded.sha256 !== localHash) {
    return PULL_ACTION.EDITED;
  }
  if (forceRefresh) return PULL_ACTION.REFRESH;

  if (recorded && recorded.sha256 === localHash) {
    const remoteMovedOn = Boolean(
      recorded.updated_at && remoteUpdatedAt && recorded.updated_at !== remoteUpdatedAt
    );
    const lengthDrift = Boolean(
      typeof remoteSize === 'number' &&
        localSize !== remoteSize &&
        (isText || recorded.variantRepresentation !== true)
    );
    return remoteMovedOn || lengthDrift ? PULL_ACTION.REFRESH : PULL_ACTION.SKIP;
  }

  // No manifest entry for this key: the file is adopted as-is and recorded, so
  // only files the manifest knows about can be replaced by a later remote change.
  // A text asset whose length matches the API is provably intact; an unrecorded
  // binary has no comparable signal, so it is kept too.
  return PULL_ACTION.SKIP;
}
