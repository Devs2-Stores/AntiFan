import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';

describe('FirstPartyNetworkTracker & Settle Gate Invariants', () => {
  const contextUrl = 'https://mystore.haravan.com/products/test-product';

  it('correctly classifies first-party critical theme assets and rejects third-party analytics/beacons', () => {
    const tracker = new FirstPartyNetworkTracker();

    // First-party critical assets
    assert.equal(tracker.isFirstPartyCritical('https://mystore.haravan.com/theme.css', contextUrl, 'stylesheet'), true);
    assert.equal(tracker.isFirstPartyCritical('https://mystore.haravan.com/bundle.js', contextUrl, 'Script'), true);
    assert.equal(tracker.isFirstPartyCritical('https://mystore.haravan.com/fonts/inter.woff2', contextUrl, 'Font'), true);
    assert.equal(tracker.isFirstPartyCritical('https://mystore.haravan.com/products/test-product', contextUrl, 'mainFrame'), true);
    assert.equal(tracker.isFirstPartyCritical('https://theme.hstatic.net/1000/assets/style.css', contextUrl, 'stylesheet'), true);
    assert.equal(tracker.isFirstPartyCritical('https://bizweb.dktcdn.net/assets/app.js', contextUrl, 'script'), true);

    // Third-party beacons, analytics, non-critical resources
    assert.equal(tracker.isFirstPartyCritical('https://www.google-analytics.com/g/collect', contextUrl, 'fetch'), false);
    assert.equal(tracker.isFirstPartyCritical('https://connect.facebook.net/en_US/fbevents.js', contextUrl, 'script'), false);
    assert.equal(tracker.isFirstPartyCritical('https://mystore.haravan.com/hero.jpg', contextUrl, 'image'), false);
    assert.equal(tracker.isFirstPartyCritical('https://mystore.haravan.com/analytics/ping', contextUrl, 'ping'), false);
  });

  it('tracks inflight requests separately across tabs and pane keys', () => {
    const tracker = new FirstPartyNetworkTracker();

    tracker.onRequestStarted('tab-1', 'desktop', 101, 'https://mystore.haravan.com/theme.css', contextUrl, 'stylesheet');
    tracker.onRequestStarted('tab-1', 'mobile', 102, 'https://mystore.haravan.com/mobile.css', contextUrl, 'stylesheet');
    tracker.onRequestStarted('tab-2', 'desktop', 103, 'https://mystore.haravan.com/theme.css', contextUrl, 'stylesheet');

    assert.equal(tracker.getInflightCount('tab-1', 'desktop'), 1);
    assert.equal(tracker.getInflightCount('tab-1', 'mobile'), 1);
    assert.equal(tracker.getInflightCount('tab-2', 'desktop'), 1);

    tracker.onRequestFinished('tab-1', 'desktop', 101);
    assert.equal(tracker.getInflightCount('tab-1', 'desktop'), 0);
    assert.equal(tracker.getInflightCount('tab-1', 'mobile'), 1);

    tracker.resetInflight('tab-1', 'mobile');
    assert.equal(tracker.getInflightCount('tab-1', 'mobile'), 0);
  });

  it('delays quiescence until delayed first-party font completes', async () => {
    const tracker = new FirstPartyNetworkTracker();

    // Start a first-party font request
    const accepted = tracker.onRequestStarted(
      'tab-1',
      'desktop',
      'font-req-1',
      'https://mystore.haravan.com/fonts/custom.woff2',
      contextUrl,
      'font'
    );
    assert.equal(accepted, true);
    assert.equal(tracker.getInflightCount('tab-1', 'desktop'), 1);

    const quiescencePromise = tracker.awaitQuiescence('tab-1', 'desktop', { idleWindowMs: 50, maxCeilingMs: 1000 });

    let isSettled = false;
    quiescencePromise.then(() => {
      isSettled = true;
    });

    // While font is pending, quiescence must remain unresolved
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(isSettled, false, 'Quiescence must not resolve while first-party font is inflight');

    // Font completes
    tracker.onRequestFinished('tab-1', 'desktop', 'font-req-1');
    assert.equal(tracker.getInflightCount('tab-1', 'desktop'), 0);

    const result = await quiescencePromise;
    assert.equal(result.settled, true);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 100, `Duration ${result.durationMs}ms must reflect delayed font wait`);
  });

  it('does NOT block quiescence on never-ending third-party analytics beacons', async () => {
    const tracker = new FirstPartyNetworkTracker();

    // Third-party beacon starts (rejected from inflight tracking)
    const accepted = tracker.onRequestStarted(
      'tab-1',
      'desktop',
      'beacon-req-1',
      'https://analytics.google.com/collect?stream=neverending',
      contextUrl,
      'fetch'
    );
    assert.equal(accepted, false, 'Third-party beacon must not be accepted into first-party tracker');
    assert.equal(tracker.getInflightCount('tab-1', 'desktop'), 0);

    // Await quiescence with 50ms debounce
    const result = await tracker.awaitQuiescence('tab-1', 'desktop', { idleWindowMs: 50, maxCeilingMs: 1000 });
    assert.equal(result.settled, true);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs < 200, 'Quiescence must settle promptly despite active third-party beacon');
  });

  it('enforces max ceiling timeout when first-party requests hang indefinitely', async () => {
    const tracker = new FirstPartyNetworkTracker();

    tracker.onRequestStarted(
      'tab-1',
      'desktop',
      'hung-req-1',
      'https://mystore.haravan.com/hung-theme.css',
      contextUrl,
      'stylesheet'
    );

    const result = await tracker.awaitQuiescence('tab-1', 'desktop', { idleWindowMs: 50, maxCeilingMs: 150 });
    assert.equal(result.settled, true);
    assert.equal(result.timedOut, true, 'Quiescence must time out on max ceiling when request hangs');
  });

  it('hooks CDP WebContents debugger Network events via ensureAttached exactly once without leaks', async () => {
    const tracker = new FirstPartyNetworkTracker();
    const messageListeners: Array<(_event: unknown, method: string, params: any) => void> = [];

    const mockWc = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: (_ver: string) => {},
        sendCommand: async (cmd: string) => {
          assert.equal(cmd, 'Network.enable');
        },
        on: (ev: string, listener: any) => {
          if (ev === 'message') messageListeners.push(listener);
        },
        removeListener: (ev: string, listener: any) => {
          const idx = messageListeners.indexOf(listener);
          if (idx !== -1) messageListeners.splice(idx, 1);
        },
      },
      once: (_ev: string, _fn: any) => {},
      removeListener: (_ev: string, _fn: any) => {},
    };

    // First call attaches
    await tracker.ensureAttached('tab-cdp', 'desktop', mockWc as any, () => contextUrl);
    assert.equal(messageListeners.length, 1);

    // Second call reuses existing attachment without adding duplicate listeners
    await tracker.ensureAttached('tab-cdp', 'desktop', mockWc as any, () => contextUrl);
    assert.equal(messageListeners.length, 1);

    // Simulate CDP Network.requestWillBeSent for theme.js
    const onMessage = messageListeners[0]!;
    assert.ok(onMessage);

    onMessage({}, 'Network.requestWillBeSent', {
      requestId: 'cdp-req-1',
      request: { url: 'https://mystore.haravan.com/assets/theme.js' },
      type: 'Script',
    });
    assert.equal(tracker.getInflightCount('tab-cdp', 'desktop'), 1);

    // Simulate CDP Network.loadingFinished
    onMessage({}, 'Network.loadingFinished', {
      requestId: 'cdp-req-1',
    });
    assert.equal(tracker.getInflightCount('tab-cdp', 'desktop'), 0);

    tracker.detachTarget('tab-cdp', 'desktop');
    assert.equal(messageListeners.length, 0);
  });

  it('handles CDP Network.loadingFailed and releases inflight tracking', async () => {
    const tracker = new FirstPartyNetworkTracker();
    const messageListeners: Array<(_event: unknown, method: string, params: any) => void> = [];

    const mockWc = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => {},
        sendCommand: async () => {},
        on: (ev: string, listener: any) => {
          if (ev === 'message') messageListeners.push(listener);
        },
        removeListener: (ev: string, listener: any) => {
          const idx = messageListeners.indexOf(listener);
          if (idx !== -1) messageListeners.splice(idx, 1);
        },
      },
      once: () => {},
      removeListener: () => {},
    };

    await tracker.ensureAttached('tab-failed', 'desktop', mockWc as any, () => contextUrl);
    const onMessage = messageListeners[0]!;

    onMessage({}, 'Network.requestWillBeSent', {
      requestId: 'cdp-fail-1',
      request: { url: 'https://mystore.haravan.com/assets/failing.js' },
      type: 'Script',
    });
    assert.strictEqual(tracker.getInflightCount('tab-failed', 'desktop'), 1);

    // Simulate CDP Network.loadingFailed
    onMessage({}, 'Network.loadingFailed', {
      requestId: 'cdp-fail-1',
      errorText: 'net::ERR_CONNECTION_RESET',
    });
    assert.strictEqual(tracker.getInflightCount('tab-failed', 'desktop'), 0);
  });

  it('fails closed with TARGET_STALE if WebContents is destroyed or CAPABILITY_NOT_FOUND if debugger is absent', async () => {
    const tracker = new FirstPartyNetworkTracker();

    // 1. Destroyed WebContents
    const destroyedWc = { isDestroyed: () => true };
    await assert.rejects(
      async () => {
        await tracker.ensureAttached('tab-stale', 'desktop', destroyedWc as any, () => contextUrl);
      },
      (err: any) => {
        assert.strictEqual(err.code, 'TARGET_STALE');
        return true;
      }
    );

    // 2. Missing debugger interface
    const noDebuggerWc = { isDestroyed: () => false, debugger: null };
    await assert.rejects(
      async () => {
        await tracker.ensureAttached('tab-nodebug', 'desktop', noDebuggerWc as any, () => contextUrl);
      },
      (err: any) => {
        assert.strictEqual(err.code, 'CAPABILITY_NOT_FOUND');
        return true;
      }
    );
  });
});
