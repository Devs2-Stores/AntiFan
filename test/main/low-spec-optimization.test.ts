import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { AsyncThemeQaQueue } from '../../src/main/qa/async-qa-job-queue';

/** Mirrors the stale-work error the QA queue recognises by code. */
class StaleTargetError extends Error {
  public readonly code = 'TARGET_STALE';
}

/** Yield to the event loop so queued job continuations can run. */
const settle = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/** Real timer wait: the queue schedules background tasks on the event loop. */
const wait = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

describe('Low-Spec Hardware Optimization', () => {
  it('configures constrained disk and media cache boundaries', () => {
    const networkCacheDir = StorageLocations.getNetworkCacheDir();
    const gpuCacheDir = StorageLocations.getGpuCacheDir();
    assert.strictEqual(typeof networkCacheDir, 'string');
    assert.strictEqual(typeof gpuCacheDir, 'string');
    assert.ok(networkCacheDir.includes('Profile-cache'));
    assert.ok(networkCacheDir.includes('network'));
    assert.ok(gpuCacheDir.includes('gpu'));
  });

  it('supersedes an in-flight job synchronously and keeps the newer generation active', { timeout: 5000 }, async () => {
    const queue = new AsyncThemeQaQueue();
    const started = Promise.withResolvers<void>();
    const staleGate = Promise.withResolvers<void>();
    const currentGate = Promise.withResolvers<void>();
    let staleSignal: AbortSignal | undefined;

    queue.enqueue('tab-supersede', 1, async (signal) => {
      staleSignal = signal;
      started.resolve();
      await staleGate.promise;
      throw new StaleTargetError('superseded');
    });
    await started.promise;

    queue.enqueue('tab-supersede', 2, async () => {
      await currentGate.promise;
    });

    assert.strictEqual(staleSignal?.aborted, true, 'superseding must abort the running generation during enqueue');
    assert.strictEqual(queue.getActiveJob('tab-supersede')?.generation, 2);

    // The superseded task settling later must not evict the generation that replaced it.
    staleGate.resolve();
    await settle();
    assert.strictEqual(queue.getActiveJob('tab-supersede')?.generation, 2, 'a stale job must not clear its replacement');
    assert.strictEqual(queue.isRunning('tab-supersede'), true);

    currentGate.resolve();
    await settle();
    assert.strictEqual(queue.isRunning('tab-supersede'), false, 'the current job clears itself once it settles');
  });

  it('keeps only the newest generation of rapid enqueues running', async () => {
    const queue = new AsyncThemeQaQueue();
    let executedCount = 0;

    for (let gen = 1; gen <= 10; gen++) {
      queue.enqueue('tab-test-1', gen, async (signal) => {
        await wait(50);
        if (signal.aborted) {
          throw new StaleTargetError('aborted');
        }
        executedCount++;
      });
    }

    assert.strictEqual(queue.isRunning('tab-test-1'), true);
    const deadline = Date.now() + 2000;
    while (queue.isRunning('tab-test-1') && Date.now() < deadline) {
      await settle();
    }

    assert.strictEqual(executedCount, 1, 'only the newest generation may complete');
    assert.strictEqual(queue.isRunning('tab-test-1'), false);
  });
});
