import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decidePullAction, PULL_ACTION } from '../../scripts/lib/pull-decision.mjs';

const HASH = 'a'.repeat(64);

function record(overrides = {}) {
  return {
    exists: true,
    localSize: 100,
    localHash: HASH,
    recorded: { sha256: HASH, updated_at: '2026-09-12T00:00:00.000Z' },
    isText: true,
    remoteSize: 100,
    remoteUpdatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

test('a file changed after the pull is never overwritten', () => {
  assert.equal(decidePullAction(record({ localHash: 'b'.repeat(64) })), PULL_ACTION.EDITED);
  assert.equal(
    decidePullAction(record({ localHash: 'b'.repeat(64), forceRefresh: true })),
    PULL_ACTION.EDITED,
    'even an explicit refresh must not take a file someone is editing'
  );
});

test('a missing or empty target is fetched', () => {
  assert.equal(decidePullAction(record({ exists: false })), PULL_ACTION.FETCH);
  assert.equal(decidePullAction(record({ localSize: 0 })), PULL_ACTION.FETCH);
});

test('an intact, unchanged asset is skipped', () => {
  assert.equal(decidePullAction(record()), PULL_ACTION.SKIP);
  assert.equal(decidePullAction(record({ isText: false })), PULL_ACTION.SKIP);
});

test('a binary whose remote updated_at moved is refreshed', () => {
  const action = decidePullAction(record({
    isText: false,
    remoteUpdatedAt: '2026-09-13T00:00:00.000Z',
    remoteSize: 100,
  }));
  assert.equal(action, PULL_ACTION.REFRESH);
});

test('a binary whose length disagrees with the stored asset is re-pulled once', () => {
  // The mirror can hold an older representation while the API stamp never moved.
  const action = decidePullAction(record({ isText: false, remoteSize: 45678 }));
  assert.equal(action, PULL_ACTION.REFRESH);
});

test('a recorded variant representation stops the length signal repeating', () => {
  const action = decidePullAction(record({
    isText: false,
    remoteSize: 45678,
    recorded: { sha256: HASH, updated_at: '2026-09-12T00:00:00.000Z', variantRepresentation: true },
  }));
  assert.equal(action, PULL_ACTION.SKIP, 'a weak signal must not become a download-every-run loop');
});

test('a moved stamp still refreshes a recorded variant representation', () => {
  const action = decidePullAction(record({
    isText: false,
    remoteSize: 45678,
    remoteUpdatedAt: '2026-09-13T00:00:00.000Z',
    recorded: { sha256: HASH, updated_at: '2026-09-12T00:00:00.000Z', variantRepresentation: true },
  }));
  assert.equal(action, PULL_ACTION.REFRESH);
});

test('a text asset whose remote length changed is refreshed', () => {
  assert.equal(decidePullAction(record({ remoteSize: 101 })), PULL_ACTION.REFRESH);
});

test('an unrecorded key is adopted, never re-fetched on length alone', () => {
  assert.equal(
    decidePullAction(record({ isText: false, recorded: null, remoteSize: 45678 })),
    PULL_ACTION.SKIP
  );
  assert.equal(decidePullAction(record({ recorded: null })), PULL_ACTION.SKIP);
});

test('a listing without a size cannot manufacture drift', () => {
  // A missing size is unknown, not zero: it must never read as a disagreement.
  assert.equal(
    decidePullAction(record({ isText: false, remoteSize: null, remoteUpdatedAt: null })),
    PULL_ACTION.SKIP
  );
  assert.equal(decidePullAction(record({ remoteSize: null })), PULL_ACTION.SKIP);
  assert.equal(
    decidePullAction(record({ remoteSize: undefined, remoteUpdatedAt: null })),
    PULL_ACTION.SKIP
  );
});

test('a missing stamp on either side cannot manufacture drift', () => {
  assert.equal(
    decidePullAction(record({ isText: false, remoteUpdatedAt: null, remoteSize: 100 })),
    PULL_ACTION.SKIP
  );
  assert.equal(
    decidePullAction(record({
      isText: false,
      remoteSize: 100,
      recorded: { sha256: HASH, updated_at: null },
      remoteUpdatedAt: '2026-09-13T00:00:00.000Z',
    })),
    PULL_ACTION.SKIP
  );
});

test('force refresh takes the remote copy for an unmodified file', () => {
  assert.equal(decidePullAction(record({ forceRefresh: true })), PULL_ACTION.REFRESH);
});
