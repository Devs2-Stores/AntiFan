import { afterEach, describe, it } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import * as assert from 'node:assert';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { acquireQaRunLock, DEFAULT_QA_RUN_LEASE_MS, resetQaRunLocksForTests } from '../../src/main/qa/qa-run-lock';

afterEach(() => resetQaRunLocksForTests());

const isBusy = (error: unknown): boolean =>
  error instanceof CapabilityError &&
  error.code === 'QA_BUSY' &&
  error.details?.retryable === true &&
  typeof error.details?.retryAfterMs === 'number' &&
  error.details?.tabId === 'tab-1';

describe('QA run lock', () => {
  it('lets one run per tab proceed and refuses the second with QA_BUSY', () => {
    const first = acquireQaRunLock('tab-1');
    assert.throws(() => acquireQaRunLock('tab-1'), isBusy);
    first.release();
  });

  it('reports a bounded retry hint', () => {
    acquireQaRunLock('tab-1', { leaseMs: 60 * 60 * 1000 });
    try {
      acquireQaRunLock('tab-1');
      assert.fail('expected QA_BUSY');
    } catch (error) {
      assert.ok(isBusy(error));
      const retryAfterMs = (error as CapabilityError).details?.retryAfterMs as number;
      assert.ok(retryAfterMs >= 1000 && retryAfterMs <= 15000, `retryAfterMs ${retryAfterMs}`);
    }
  });

  it('does not block a different tab', () => {
    const a = acquireQaRunLock('tab-1');
    const b = acquireQaRunLock('tab-2');
    a.release();
    b.release();
  });

  it('frees the tab on release, and release is idempotent', () => {
    const first = acquireQaRunLock('tab-1');
    first.release();
    first.release();
    const second = acquireQaRunLock('tab-1');
    first.release();
    assert.throws(() => acquireQaRunLock('tab-1'), isBusy, 'a late release of the old handle must not free the new holder');
    second.release();
  });

  it('releases when the run throws inside a try/finally', async () => {
    const run = async (): Promise<void> => {
      const lock = acquireQaRunLock('tab-1');
      try {
        throw new Error('scanner failed');
      } finally {
        lock.release();
      }
    };
    await assert.rejects(run, /scanner failed/);
    acquireQaRunLock('tab-1').release();
  });

  it('takes over an expired lease and the stale holder cannot release the new one', () => {
    let clock = 1_000_000;
    const stale = acquireQaRunLock('tab-1', { leaseMs: 5_000, now: () => clock });
    clock += 4_999;
    assert.throws(() => acquireQaRunLock('tab-1', { now: () => clock }), isBusy, 'still inside the lease');
    clock += 2;
    const fresh = acquireQaRunLock('tab-1', { leaseMs: 5_000, now: () => clock });
    stale.release();
    assert.throws(() => acquireQaRunLock('tab-1', { now: () => clock }), isBusy, 'the new holder keeps the lock');
    fresh.release();
    acquireQaRunLock('tab-1', { now: () => clock }).release();
  });

  it('defaults the lease to the longest policy timeout plus thirty seconds of teardown', () => {
    assert.strictEqual(DEFAULT_QA_RUN_LEASE_MS, 330_000);
    let clock = 0;
    acquireQaRunLock('tab-1', { now: () => clock });
    clock = DEFAULT_QA_RUN_LEASE_MS - 1;
    assert.throws(() => acquireQaRunLock('tab-1', { now: () => clock }), isBusy);
    clock = DEFAULT_QA_RUN_LEASE_MS + 1;
    acquireQaRunLock('tab-1', { now: () => clock }).release();
  });

  it('falls back to the default lease for a non-positive or non-finite lease', () => {
    let clock = 0;
    for (const leaseMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      resetQaRunLocksForTests();
      clock = 0;
      acquireQaRunLock('tab-1', { leaseMs, now: () => clock });
      clock = 60_000;
      assert.throws(() => acquireQaRunLock('tab-1', { now: () => clock }), isBusy, `lease ${leaseMs}`);
    }
  });

  it('refuses an empty tab id', () => {
    assert.throws(
      () => acquireQaRunLock(''),
      (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENT'
    );
  });

  it('serialises concurrent starters: exactly one wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async () => {
        const lock = acquireQaRunLock('tab-1');
        await nextTick();
        lock.release();
      })
    );
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual(results.filter((r) => r.status === 'rejected').length, 7);
    for (const r of results) if (r.status === 'rejected') assert.ok(isBusy(r.reason));
  });
});
