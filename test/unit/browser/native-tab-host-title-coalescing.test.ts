import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';

// Seam interface exposing private throttle fields without using `any`
interface TestableHost {
  isDisposed: boolean;
  titleBroadcastDeadline: number;
  titleBroadcastTimer?: NodeJS.Timeout;
  broadcastState: () => void;
  scheduleTitleBroadcast: () => void;
}

interface Seam {
  host: TestableHost;
  count: () => number;
}

// Helper uses Promise.withResolvers per repo rule.
// Real timers are used here because this is an integration test asserting
// true wall-clock scheduling behavior of the throttle against Node's event loop.
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function createSeam(): Seam {
  const host = Object.create(NativeTabHost.prototype) as unknown as TestableHost;
  host.isDisposed = false;
  host.titleBroadcastDeadline = 0;
  host.titleBroadcastTimer = undefined;
  let broadcasts = 0;
  host.broadcastState = () => { broadcasts++; };
  return { host, count: () => broadcasts };
}

describe('NativeTabHost title broadcast throttle (leading + trailing)', () => {
  it('emits leading edge immediately then folds the burst tail into one trailing flush', async () => {
    const { host, count } = createSeam();
    host.scheduleTitleBroadcast();
    // Leading edge: first title update paints immediately (no initial delay)
    assert.strictEqual(count(), 1);

    // Rapid burst tail within the 200ms window does NOT re-fire immediately
    host.scheduleTitleBroadcast();
    host.scheduleTitleBroadcast();
    assert.strictEqual(count(), 1);

    // After the 200ms window elapses, exactly ONE trailing flush lands
    await delay(240);
    assert.strictEqual(count(), 2);
  });

  it('never starves under sustained churn and caps rate at <= 5 Hz', async () => {
    const { host, count } = createSeam();
    const start = Date.now();
    // Simulate high-frequency continuous title rewrites (every 35ms for ~420ms)
    for (let i = 0; i < 12; i++) {
      host.scheduleTitleBroadcast();
      await delay(35);
    }
    const elapsed = Date.now() - start;

    // CRITICAL: A pure trailing debounce would have fired ZERO broadcasts here (starvation).
    // The throttle must have fired at least 2 broadcasts across ~420ms (leading + 1-2 intervals).
    assert.ok(count() >= 2, `Expected >= 2 broadcasts under sustained churn, got ${count()} (starvation bug!)`);

    // Rate must still be strictly capped at ~5/sec (no event storm)
    const rate = count() / (elapsed / 1000);
    assert.ok(rate <= 7, `Rate ${rate.toFixed(1)}/sec exceeded ceiling (expected <= ~5-6/sec)`);

    // Wait for the final trailing flush to land after churn stops
    await delay(240);
    const finalCount = count();
    assert.ok(finalCount >= 2, 'Final flush must land');
  });

  it('final value lands within one interval of the last event without ghost timers', async () => {
    const { host, count } = createSeam();
    host.scheduleTitleBroadcast(); // Leading edge
    assert.strictEqual(count(), 1);

    await delay(80);
    host.scheduleTitleBroadcast(); // Mid-window trailing arm
    assert.strictEqual(count(), 1);

    await delay(200);
    assert.strictEqual(count(), 2);

    // Wait another full window: no phantom/ghost timers must fire
    await delay(250);
    assert.strictEqual(count(), 2);
  });

  it('never broadcasts when disposed (leading or trailing)', async () => {
    const { host, count } = createSeam();
    host.isDisposed = true;
    host.scheduleTitleBroadcast();
    assert.strictEqual(count(), 0);
    await delay(260);
    assert.strictEqual(count(), 0);
  });
});