/**
 * Decides what a mirror run does with one asset.
 *
 * A pull is a mirror, never a sync: a file that changed after the pull is
 * someone's work and is left alone. For the remaining files the only question
 * is whether the remote copy moved on.
 *
 * Remote drift cannot be read off the byte length of a binary asset: the theme
 * API reports the size of the stored asset while the CDN serves a converted
 * variant, so lengths differ with no remote change at all. Binaries therefore
 * compare the API `updated_at`, and text assets — whose length is exact —
 * compare both.
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
    const textLengthDrift = Boolean(
      isText && typeof remoteSize === 'number' && localSize !== remoteSize
    );
    return remoteMovedOn || textLengthDrift ? PULL_ACTION.REFRESH : PULL_ACTION.SKIP;
  }

  // No manifest entry for this key: the file is adopted as-is and recorded, so
  // only files the manifest knows about can be replaced by a later remote change.
  // A text asset whose length matches the API is provably intact; an unrecorded
  // binary has no comparable signal, so it is kept too.
  return PULL_ACTION.SKIP;
}
