import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { settleWithinBound } from './target-operation-chain.js';

/**
 * The operation chain is a per-(tab, pane) promise chain. These cases pin the
 * property that keeps a stuck predecessor from becoming a dead tab: the wait must
 * always end, and it must distinguish "the chain moved on" from "the bound expired".
 */
describe('settleWithinBound', () => {
  it('returns true for an already-settled chain', async () => {
    assert.equal(await settleWithinBound(Promise.resolve(), 50), true);
  });

  it('returns true when the chain settles inside the bound', async () => {
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    setTimeout(release, 20);
    assert.equal(await settleWithinBound(tail, 500), true);
  });

  it('returns false at the bound when the chain never settles', async () => {
    const never = new Promise<void>(() => {
      /* deliberately never settles: this is the wedge being guarded against */
    });
    const startedAt = Date.now();
    const settled = await settleWithinBound(never, 120);
    const elapsed = Date.now() - startedAt;
    assert.equal(settled, false, 'a never-settling chain must never be reported as settled');
    assert.ok(elapsed >= 100, `refused before the bound expired: ${elapsed}ms`);
    assert.ok(elapsed < 600, `did not refuse promptly at the bound: ${elapsed}ms`);
  });

  it('counts a rejected predecessor as having left the chain', async () => {
    assert.equal(await settleWithinBound(Promise.reject(new Error('predecessor failed')), 500), true);
  });

  it('does not delay a settled chain by the full bound', async () => {
    const startedAt = Date.now();
    assert.equal(await settleWithinBound(Promise.resolve(), 5_000), true);
    assert.ok(Date.now() - startedAt < 200, 'a settled wait must clear its bound timer');
  });
});
