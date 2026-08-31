import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { PassiveExecutionPool } from '../../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';

describe('PassiveExecutionPool Unit Tests (Phase 03)', () => {
  it('allows concurrent executions up to 4 per tab and 16 globally', async () => {
    const pool = new PassiveExecutionPool();
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
    const pool = new PassiveExecutionPool();
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
});
