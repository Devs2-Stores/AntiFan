import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ViewportGate } from '../../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';

function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ViewportGate Unit Tests (Phase 03)', () => {
  it('serializes concurrent interactive actions in strict FIFO order', async () => {
    const gate = new ViewportGate();
    const executionOrder: number[] = [];

    const createAction = (id: number, delayMs: number) => async () => {
      executionOrder.push(id);
      await new Promise((r) => setTimeout(r, delayMs));
      return id;
    };

    const p1 = gate.withLock(createAction(1, 40));
    const p2 = gate.withLock(createAction(2, 20));
    const p3 = gate.withLock(createAction(3, 10));

    const results = await Promise.all([p1, p2, p3]);

    assert.deepStrictEqual(results, [1, 2, 3]);
    assert.deepStrictEqual(executionOrder, [1, 2, 3]);
    assert.strictEqual(gate.isBusy(), false);
  });

  it('preempts the active lock holder via AbortSignal without corrupting queued callers', async () => {
    const gate = new ViewportGate();
    let session1Aborted = false;
    let session2Executed = false;

    let session1StartedResolve!: () => void;
    const session1Started = new Promise<void>((r) => { session1StartedResolve = r; });

    const session1Action = async (signal: AbortSignal) => {
      session1StartedResolve();
      const { promise, reject } = withResolvers<string>();
      signal.addEventListener('abort', () => {
        session1Aborted = true;
        reject(signal.reason);
      }, { once: true });
      return promise;
    };

    const session2Action = async () => {
      session2Executed = true;
      return 'session2_success';
    };

    // 1. Session 1 acquires the lock
    const p1 = gate.withLock(session1Action, { tabId: 'tab-1' });
    await session1Started;

    // 2. Session 2 queues behind Session 1
    const p2 = gate.withLock(session2Action, { tabId: 'tab-2' });

    assert.strictEqual(gate.getQueueLength(), 1, 'Session 2 must be queued');

    // 3. Trigger preemption: physical keyboard input detected
    gate.preemptActiveAgent('Manual human typing preempted agent');

    // 4. Verify Session 1 is aborted with PREEMPTED_BY_USER
    await assert.rejects(
      p1,
      (err: unknown) => err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER'
    );
    assert.strictEqual(session1Aborted, true);

    // 5. Verify Session 2 executes normally once Session 1 releases the lock
    const res2 = await p2;
    assert.strictEqual(res2, 'session2_success');
    assert.strictEqual(session2Executed, true);
    assert.strictEqual(gate.isBusy(), false);
  });

  it('cancels queued requests when a tab is closed via cleanupTab(tabId)', async () => {
    const gate = new ViewportGate();
    const { promise: blockPromise, resolve: blockResolve } = withResolvers<void>();

    const holder = gate.withLock(async () => {
      await blockPromise;
      return 'holder_done';
    }, { tabId: 'tab-active' });

    const queuedTab1 = gate.withLock(async () => 'queued_tab1_done', { tabId: 'tab-to-close' });
    const queuedTab2 = gate.withLock(async () => 'queued_tab2_done', { tabId: 'tab-keep' });

    assert.strictEqual(gate.getQueueLength(), 2);

    // Close tab-to-close
    gate.cleanupTab('tab-to-close');

    // queuedTab1 must reject immediately with TARGET_STALE
    await assert.rejects(
      queuedTab1,
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    assert.strictEqual(gate.getQueueLength(), 1, 'Only tab-keep remains in queue');

    // Release holder
    blockResolve();
    await holder;

    const resKeep = await queuedTab2;
    assert.strictEqual(resKeep, 'queued_tab2_done');
    assert.strictEqual(gate.isBusy(), false);
  });

  it('enforces execution deadline and rejects with LEASE_EXPIRED when action hangs', async () => {
    const gate = new ViewportGate();

    await assert.rejects(
      async () => gate.withLock(async () => {
        // Hang indefinitely
        await new Promise(() => {});
      }, { timeoutMs: 50 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'LEASE_EXPIRED'
    );

    assert.strictEqual(gate.isBusy(), false, 'Gate must be cleanly unlocked after timeout');
  });

  it('invokes cancellation callback on abort and waits for settlement before passing lock', async () => {
    const gate = new ViewportGate();
    let cancelInvokedWith: string | undefined;
    gate.setCancellationHandler(async (tabId) => {
      cancelInvokedWith = tabId;
      return true;
    });

    let actionSettled = false;
    let p1StartedResolve!: () => void;
    const p1Started = new Promise<void>((r) => { p1StartedResolve = r; });

    const p1 = gate.withLock(async (signal) => {
      p1StartedResolve();
      await new Promise<void>((_, rej) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            actionSettled = true;
            rej(signal.reason);
          }, 30);
        });
      });
    }, { tabId: 'tab-c1' });

    await p1Started;
    const p2 = gate.withLock(async () => 'next_action_done', { tabId: 'tab-c2' });

    // Preempt active action
    gate.preemptActiveAgent('User interruption');

    await assert.rejects(
      p1,
      (err: unknown) => err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER'
    );

    assert.strictEqual(cancelInvokedWith, 'tab-c1');
    assert.strictEqual(actionSettled, true, 'Lock was not released until action settled');

    const res2 = await p2;
    assert.strictEqual(res2, 'next_action_done');
  });

  it('deterministically rejects with abort reason even when action resolves gracefully on abort', async () => {
    const gate = new ViewportGate();
    gate.setCancellationHandler(async () => true);

    let p1StartedResolve!: () => void;
    const p1Started = new Promise<void>((r) => { p1StartedResolve = r; });

    // Action catches abort and resolves with a status object instead of throwing
    const p1 = gate.withLock(async (signal) => {
      p1StartedResolve();
      return await new Promise<{ success: boolean; reason?: string }>((resolve) => {
        signal.addEventListener('abort', () => {
          // Renderer trajectory-like graceful resolution on cancel
          resolve({ success: false, reason: 'Cancelled by user or navigation' });
        });
      });
    }, { tabId: 'tab-resolving-abort' });

    await p1Started;
    const p2 = gate.withLock(async () => 'session_p2_success', { tabId: 'tab-p2' });

    gate.preemptActiveAgent('User intervened physically');

    // withLock must reject with PREEMPTED_BY_USER rather than returning { success: false }
    await assert.rejects(
      p1,
      (err: unknown) => err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER'
    );

    const res2 = await p2;
    assert.strictEqual(res2, 'session_p2_success');
  });

  it('poisons gate and drains queued callers when cancellation is unacknowledged', async () => {
    const gate = new ViewportGate();
    gate.setCancellationHandler(async () => {
      // Return false to simulate failed/unacknowledged cancellation
      return false;
    });

    let p1StartedResolve!: () => void;
    const p1Started = new Promise<void>((r) => { p1StartedResolve = r; });

    const p1 = gate.withLock(async () => {
      p1StartedResolve();
      // The action never answers the abort: nothing proves it stopped acting.
      await new Promise<void>(() => {});
    }, { tabId: 'tab-unack' });

    await p1Started;
    const queuedP2 = gate.withLock(async () => 'should_never_run', { tabId: 'tab-queued' });

    gate.preemptActiveAgent('Test preemption');

    await assert.rejects(
      p1,
      (err: unknown) => err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER'
    );

    await assert.rejects(
      queuedP2,
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    // Subsequent calls reject immediately while poisoned
    await assert.rejects(
      async () => gate.withLock(async () => 'denied'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    gate.resetPoisonState();
    const recovered = await gate.withLock(async () => 'recovered');
    assert.strictEqual(recovered, 'recovered');
  });

  it('scopes an ordinary lease-timeout poison to the lock target, leaving other tabs usable', async () => {
    const gate = new ViewportGate();
    gate.setCancellationHandler(async () => false);

    await assert.rejects(
      async () => gate.withLock(async () => {
        await new Promise<void>(() => {});
      }, { tabId: 'tab-timeout', timeoutMs: 40 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'LEASE_EXPIRED'
    );

    // Only the timed-out tab is fenced; unrelated tabs keep working.
    await assert.rejects(
      async () => gate.withLock(async () => 'denied', { tabId: 'tab-timeout' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    const other = await gate.withLock(async () => 'ok', { tabId: 'tab-other' });
    assert.strictEqual(other, 'ok');
  });

  it('does not let a prior scoped preemption decide a later lock poison scope', async () => {
    const gate = new ViewportGate();
    gate.setCancellationHandler(async () => false);

    let startedResolve!: () => void;
    const started = new Promise<void>((r) => { startedResolve = r; });
    const p1 = gate.withLock(async () => {
      startedResolve();
      // The abandoned action never settles, so the fence has no evidence to lift on.
      await new Promise<void>(() => {});
    }, { tabId: 'tab-a' });
    await started;
    gate.preemptActiveAgent('User typed on tab-a', 'tab-a');
    await assert.rejects(
      p1,
      (err: unknown) => err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER'
    );

    // A later lock on a different tab times out with no preemption of its own.
    await assert.rejects(
      async () => gate.withLock(async () => {
        await new Promise<void>(() => {});
      }, { tabId: 'tab-b', timeoutMs: 40 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'LEASE_EXPIRED'
    );

    // The stale tab-a scope must not be reused: tab-b is the fenced tab.
    await assert.rejects(
      async () => gate.withLock(async () => 'denied', { tabId: 'tab-b' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    const untouched = await gate.withLock(async () => 'ok', { tabId: 'tab-c' });
    assert.strictEqual(untouched, 'ok');
  });
});

describe('ViewportGate poison recovery on evidence', () => {
  const NEVER = () => new Promise<void>(() => {});

  /** Poisons `tabId` with a lease timeout whose action never answers the cancel. */
  async function poisonByHungAction(gate: ViewportGate, tabId: string): Promise<void> {
    gate.setCancellationHandler(async () => false);
    await assert.rejects(
      async () => gate.withLock(NEVER, { tabId, timeoutMs: 30 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'LEASE_EXPIRED'
    );
  }

  it('clears the fence when the document generation changed since the poison', async () => {
    const gate = new ViewportGate();
    let generation = 4;
    gate.setGenerationProbe(() => generation);
    await poisonByHungAction(gate, 'tab-gen');

    await assert.rejects(
      async () => gate.withLock(async () => 'denied', { tabId: 'tab-gen' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    generation = 5;
    assert.strictEqual(await gate.withLock(async () => 'ok', { tabId: 'tab-gen' }), 'ok');
    // The record is gone for good, not just bypassed once.
    assert.strictEqual(await gate.withLock(async () => 'again', { tabId: 'tab-gen' }), 'again');
  });

  it('clears the fence when the host drained the target and proved the page answers', async () => {
    const gate = new ViewportGate();
    const drained: string[] = [];
    gate.setRecoveryHandler(async (tabId) => { drained.push(tabId); return true; });
    await poisonByHungAction(gate, 'tab-drain');

    assert.strictEqual(await gate.withLock(async () => 'ok', { tabId: 'tab-drain' }), 'ok');
    assert.deepStrictEqual(drained, ['tab-drain']);
    assert.strictEqual(await gate.withLock(async () => 'again', { tabId: 'tab-drain' }), 'again');
    assert.deepStrictEqual(drained, ['tab-drain'], 'a lifted fence needs no second recovery');
  });

  it('keeps refusing with a recovery instruction when the drain fails', async () => {
    const gate = new ViewportGate();
    gate.setRecoveryHandler(async () => false);
    await poisonByHungAction(gate, 'tab-drain-fail');

    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        async () => gate.withLock(async () => 'denied', { tabId: 'tab-drain-fail' }),
        (err: unknown) => err instanceof CapabilityError
          && err.code === 'TARGET_STALE'
          && typeof err.details?.recovery === 'string'
          && /anti\.browser\.(reload|rebind_target)/.test(String(err.details?.recovery))
          && err.details?.tabId === 'tab-drain-fail'
      );
    }
  });

  it('keeps refusing when the recovery handler throws', async () => {
    const gate = new ViewportGate();
    gate.setRecoveryHandler(async () => { throw new Error('probe exploded'); });
    await poisonByHungAction(gate, 'tab-drain-throw');

    await assert.rejects(
      async () => gate.withLock(async () => 'denied', { tabId: 'tab-drain-throw' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });

  it('does not clear the fence while the abandoned action is still hung and nothing else proves recovery', async () => {
    const gate = new ViewportGate();
    gate.setGenerationProbe(() => 7);
    await poisonByHungAction(gate, 'tab-hung');

    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(
        async () => gate.withLock(async () => 'denied', { tabId: 'tab-hung' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
      );
    }
    // A fence on one tab never leaks onto another.
    assert.strictEqual(await gate.withLock(async () => 'ok', { tabId: 'tab-free' }), 'ok');
  });

  it('clears the fence once the abandoned action itself settles', async () => {
    const gate = new ViewportGate();
    gate.setCancellationHandler(async () => false);
    let finish!: () => void;
    const hung = new Promise<void>((resolve) => { finish = resolve; });

    await assert.rejects(
      async () => gate.withLock(() => hung, { tabId: 'tab-settles', timeoutMs: 30 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'LEASE_EXPIRED'
    );
    await assert.rejects(
      async () => gate.withLock(async () => 'denied', { tabId: 'tab-settles' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(await gate.withLock(async () => 'ok', { tabId: 'tab-settles' }), 'ok');
  });

  it('runs one recovery for concurrent callers on the same poisoned tab', async () => {
    const gate = new ViewportGate();
    let calls = 0;
    let release!: (value: boolean) => void;
    gate.setRecoveryHandler(() => {
      calls++;
      return new Promise<boolean>((resolve) => { release = resolve; });
    });
    await poisonByHungAction(gate, 'tab-concurrent');

    const first = gate.withLock(async () => 'a', { tabId: 'tab-concurrent' });
    const second = gate.withLock(async () => 'b', { tabId: 'tab-concurrent' });
    await new Promise((resolve) => setImmediate(resolve));
    release(true);

    assert.deepStrictEqual(await Promise.all([first, second]), ['a', 'b']);
    assert.strictEqual(calls, 1);
  });

  it('releasing a tab drops its fence', async () => {
    const gate = new ViewportGate();
    await poisonByHungAction(gate, 'tab-gone');
    gate.releaseForTab('tab-gone');
    assert.strictEqual(await gate.withLock(async () => 'ok', { tabId: 'tab-gone' }), 'ok');
  });
});
