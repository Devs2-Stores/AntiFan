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
  const action = decidePullAction(record({ localHash: 'b'.repeat(64), forceRefresh: false }));
  assert.equal(action, PULL_ACTION.EDITED);
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

test('a binary size difference alone is not remote drift', () => {
  // The API reports the stored asset while the CDN serves a converted variant.
  const action = decidePullAction(record({ isText: false, remoteSize: 45678 }));
  assert.equal(action, PULL_ACTION.SKIP);
});

test('a text asset whose remote length changed is refreshed', () => {
  assert.equal(decidePullAction(record({ remoteSize: 101 })), PULL_ACTION.REFRESH);
});

test('an id-less remote or an unrecorded timestamp cannot manufacture drift', () => {
  assert.equal(
    decidePullAction(record({ isText: false, remoteUpdatedAt: null, remoteSize: 999 })),
    PULL_ACTION.SKIP
  );
  assert.equal(
    decidePullAction(record({ recorded: { sha256: HASH, updated_at: null }, isText: false, remoteUpdatedAt: '2026-09-13T00:00:00.000Z' })),
    PULL_ACTION.SKIP
  );
});

test('force refresh takes the remote copy for an unmodified file', () => {
  assert.equal(decidePullAction(record({ forceRefresh: true })), PULL_ACTION.REFRESH);
});
