import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessIdentityCache } from '../../../scripts/lib/process-identity.mjs';

test('caches only the current process identity and leaves other pid reads fresh', async () => {
  const calls = [];
  const read = createProcessIdentityCache(41, async (pid) => {
    calls.push(pid);
    return { pid, processStartToken: `token-${calls.length}` };
  });

  const [firstOwn, secondOwn] = await Promise.all([read(41), read(41)]);
  assert.deepEqual(secondOwn, firstOwn);
  assert.deepEqual(calls, [41]);

  const otherFirst = await read(42);
  const otherSecond = await read(42);
  assert.notDeepEqual(otherSecond, otherFirst);
  assert.deepEqual(calls, [41, 42, 42]);
});

test('skips the Windows process query when the pid is already absent', async () => {
  const { readWindowsIdentityIfPresent } = await import('../../../scripts/lib/process-identity.mjs');
  let queries = 0;
  const result = await readWindowsIdentityIfPresent(99, () => false, async () => {
    queries++;
    return { alive: true, startToken: 'unexpected', startTokenFormat: 'win32:CreationDate', startedAt: null };
  });

  assert.deepEqual(result, {
    alive: false,
    startToken: null,
    startTokenFormat: 'unavailable',
    startedAt: null,
  });
  assert.equal(queries, 0);
});
