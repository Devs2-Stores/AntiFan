import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { PassiveExecutionPool } from '../../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';

describe('PassiveExecutionPool Unit Tests (Phase 03)', () => {
  it('allows concurrent executions up to 4 per tab and 16 globally', async () => {
    const pool = new PassiveExecutionPool({ queueTimeoutMs: 0 });
    const deferreds: Array<{ resolve: () => void; promise: Promise<void> }> = [];

    const createDeferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { resolve, promise };
    };

    // 1. Run 4 concurrent operations on tab-1
    for (let i = 0; i < 4; i++) {
      const d = createDeferred();
      deferreds.push(d);
      void pool.execute('tab-1', () => d.promise);
    }

    assert.strictEqual(pool.getActiveTabCount('tab-1'), 4);
    assert.strictEqual(pool.getGlobalActiveCount(), 4);

    // 2. 5th operation on tab-1 fails-closed with CAPABILITY_OVERLOADED
    await assert.rejects(
      async () => pool.execute('tab-1', async () => 'overflow'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_OVERLOADED'
    );

    // 3. Operations on tab-2 succeed
    const dTab2 = createDeferred();
    deferreds.push(dTab2);
    void pool.execute('tab-2', () => dTab2.promise);

    assert.strictEqual(pool.getActiveTabCount('tab-2'), 1);
    assert.strictEqual(pool.getGlobalActiveCount(), 5);

    // 4. Resolve 2 operations on tab-1
    deferreds[0]?.resolve();
    deferreds[1]?.resolve();
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(pool.getActiveTabCount('tab-1'), 2);
    assert.strictEqual(pool.getGlobalActiveCount(), 3);

    // 5. Now another operation on tab-1 succeeds
    const dTab1New = createDeferred();
    deferreds.push(dTab1New);
    const p1 = pool.execute('tab-1', () => dTab1New.promise);

    assert.strictEqual(pool.getActiveTabCount('tab-1'), 3);

    // Clean up remaining deferreds
    for (const d of deferreds) {
      d.resolve();
    }
    await p1;
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(pool.getActiveTabCount('tab-1'), 0);
    assert.strictEqual(pool.getActiveTabCount('tab-2'), 0);
    assert.strictEqual(pool.getGlobalActiveCount(), 0);
  });

  it('enforces 16 global concurrent operations across multiple tabs', async () => {
    const pool = new PassiveExecutionPool({ queueTimeoutMs: 0 });
    const deferreds: Array<{ resolve: () => void; promise: Promise<void> }> = [];

    const createDeferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { resolve, promise };
    };

    // Spawn 16 operations across 8 tabs (2 per tab)
    for (let t = 0; t < 8; t++) {
      for (let i = 0; i < 2; i++) {
        const d = createDeferred();
        deferreds.push(d);
        void pool.execute(`tab-${t}`, () => d.promise);
      }
    }

    assert.strictEqual(pool.getGlobalActiveCount(), 16);

    // 17th operation on a new tab-fresh fails with CAPABILITY_OVERLOADED
    await assert.rejects(
      async () => pool.execute('tab-fresh', async () => 'overflow-global'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_OVERLOADED'
    );

    // Cleanup
    for (const d of deferreds) {
      d.resolve();
    }
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pool.getGlobalActiveCount(), 0);
  });

  it('guarantees zero active count leaks when executed action throws an error', async () => {
    const pool = new PassiveExecutionPool();

    await assert.rejects(
      async () => pool.execute('tab-err', async () => {
        throw new Error('Explosion inside action');
      }),
      /Explosion inside action/
    );

    assert.strictEqual(pool.getActiveTabCount('tab-err'), 0);
    assert.strictEqual(pool.getGlobalActiveCount(), 0);
  });

  it('runs a nested execute on a held tab inside the caller slot', async () => {
    const pool = new PassiveExecutionPool({ queueTimeoutMs: 0 });
    const release = Promise.withResolvers<void>();
    const outer = Array.from({ length: 4 }, () => pool.execute('tab-1', async () => {
      await release.promise;
      // Every slot is taken; the nested call must ride the caller's own slot
      // (queueTimeoutMs 0 would refuse it at once if it were counted again).
      return pool.execute('tab-1', async () => pool.getActiveTabCount('tab-1'));
    }));
    const tick = Promise.withResolvers<void>();
    setImmediate(tick.resolve);
    await tick.promise;
    assert.strictEqual(pool.getActiveTabCount('tab-1'), 4);
    release.resolve();
    assert.deepStrictEqual(await Promise.all(outer), [4, 4, 4, 4]);
    // Outside any holder the cap still applies.
    const hold = Promise.withResolvers<void>();
    const holders = Array.from({ length: 4 }, () => pool.execute('tab-1', () => hold.promise));
    await assert.rejects(
      async () => pool.execute('tab-1', async () => 'x'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_OVERLOADED'
    );
    hold.resolve();
    await Promise.all(holders);
  });

  it('parks a burst over the cap in arrival order and refuses when parking times out', async () => {
    const pool = new PassiveExecutionPool({ queueTimeoutMs: 200, maxQueued: 2 });
    const hold = Promise.withResolvers<void>();
    const holders = Array.from({ length: 4 }, () => pool.execute('tab-1', () => hold.promise));
    const order: number[] = [];
    const parked = [1, 2].map((n) => pool.execute('tab-1', async () => { order.push(n); }));
    assert.strictEqual(pool.getQueuedCount(), 2);
    // Queue full: refused at once, not after the timeout.
    const started = Date.now();
    await assert.rejects(
      async () => pool.execute('tab-1', async () => 'x'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_OVERLOADED'
    );
    assert.ok(Date.now() - started < 100);
    hold.resolve();
    await Promise.all([...holders, ...parked]);
    assert.deepStrictEqual(order, [1, 2]);
    assert.strictEqual(pool.getGlobalActiveCount(), 0);

    // Sustained overload: a parked caller is refused once its wait runs out.
    const stuck = Promise.withResolvers<void>();
    const blockers = Array.from({ length: 4 }, () => pool.execute('tab-1', () => stuck.promise));
    await assert.rejects(
      async () => pool.execute('tab-1', async () => 'late'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_OVERLOADED'
    );
    assert.strictEqual(pool.getQueuedCount(), 0);
    stuck.resolve();
    await Promise.all(blockers);
    assert.strictEqual(pool.getActiveTabCount('tab-1'), 0);
  });
});
