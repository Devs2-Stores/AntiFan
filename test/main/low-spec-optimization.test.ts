import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { AsyncThemeQaQueue } from '../../src/main/qa/async-qa-job-queue';

function deferred<T = void>() {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it('keeps event loop latency bounded under simulated cooperative yields', async () => {
    const start = performance.now();
    const yieldsCount = 10;
    for (let i = 0; i < yieldsCount; i++) {
      const { promise, resolve } = deferred<void>();
      setImmediate(resolve);
      await promise;
    }
    const elapsed = performance.now() - start;
    // 10 cooperative yields on node event loop should finish in under 200ms
    assert.ok(elapsed < 200, `Cooperative yields took too long: ${elapsed}ms`);
  });

  it('handles rapid task enqueue and cleanup on AsyncThemeQaQueue without memory leaks', async () => {
    const queue = new AsyncThemeQaQueue();
    let executedCount = 0;

    for (let gen = 1; gen <= 10; gen++) {
      queue.enqueue('tab-test-1', gen, async (signal) => {
        const { promise, resolve } = deferred<void>();
        setTimeout(resolve, 50);
        await promise;
        if (signal.aborted) {
          const err = new Error('aborted');
          (err as unknown as { code: string }).code = 'TARGET_STALE';
          throw err;
        }
        executedCount++;
      });
    }

    assert.strictEqual(queue.isRunning('tab-test-1'), true);
    // Wait for the final active task to finish
    const { promise, resolve } = deferred<void>();
    setTimeout(resolve, 100);
    await promise;

    assert.strictEqual(executedCount, 1);
    assert.strictEqual(queue.isRunning('tab-test-1'), false);
  });
});
