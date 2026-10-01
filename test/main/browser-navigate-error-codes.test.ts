import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

// Regression: navigate() used to wrap every failure in a hard-coded
// TARGET_STALE, even when the host's navigation waiter had already recorded a
// typed cause (NAVIGATION_TIMEOUT, LOAD_FAILED, ...). The port now propagates
// the recorded cause as the error code so retries/reports classify correctly;
// TARGET_STALE survives only for failures with no recorded classification.
describe('browser-control-port navigate error code propagation', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-nav',
    workspaceId: 'ws-nav',
    runtimeId: 'rt-nav',
    tabId: 'tab-nav-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (overrides?: Partial<BrowserHostPort>): BrowserHostPort => ({
    getTabList: () => [{ id: 'tab-nav-1' }],
    getActiveTabId: () => 'tab-nav-1',
    getAutomationTabId: () => 'tab-nav-1',
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html><body></body></html>',
    captureScreenshot: async () => Buffer.from('fake').toString('base64'),
    evalJs: async () => true,
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    ...overrides,
  });

  it('propagates the recorded NAVIGATION_TIMEOUT cause as the error code', async () => {
    const host = createMockHost({
      navigateAndWait: async () => false,
      getLastNavigationFailure: () => ({
        cause: 'NAVIGATION_TIMEOUT',
        message: 'Navigation load completion timed out after 8000ms',
        timedOut: true,
      }),
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.navigate(baseTarget, 'https://example.com/slow'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'NAVIGATION_TIMEOUT');
        assert.ok(err.message.includes('Navigation load completion timed out after 8000ms'));
        return true;
      }
    );
  });

  it('propagates the recorded LOAD_FAILED cause via the legacy navigate path too', async () => {
    const host = createMockHost({
      // No navigateAndWait: the port falls back to host.navigate, which may
      // also settle false with a recorded failure.
      navigate: async () => false,
      getLastNavigationFailure: () => ({
        cause: 'LOAD_FAILED',
        message: 'Navigation failed: net::ERR_CONNECTION_REFUSED',
        timedOut: false,
      }),
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.navigate(baseTarget, 'https://example.com/down'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'LOAD_FAILED');
        assert.ok(err.message.includes('net::ERR_CONNECTION_REFUSED'));
        return true;
      }
    );
  });

  it('keeps a typed CapabilityError thrown by the host untouched (committed-navigation error shape)', async () => {
    const host = createMockHost({
      navigateAndWait: async () => {
        throw new CapabilityError('TARGET_BUSY_DRAINING', 'Target is still draining a timed-out command');
      },
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.navigate(baseTarget, 'https://example.com/busy'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_BUSY_DRAINING');
        assert.strictEqual(err.message, 'Target is still draining a timed-out command');
        return true;
      }
    );
  });

  it('falls back to TARGET_STALE only when the host recorded no failure cause', async () => {
    const host = createMockHost({
      navigateAndWait: async () => false,
      // getLastNavigationFailure absent / returns undefined: the host could not
      // classify the miss, so stale-target remains the honest refusal.
      getLastNavigationFailure: () => undefined,
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.navigate(baseTarget, 'https://example.com/vanished'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        assert.ok(err.message.includes('Navigation failed or timed out'));
        return true;
      }
    );
  });

  it('treats a bare timedOut flag without a cause as NAVIGATION_TIMEOUT', async () => {
    const host = createMockHost({
      navigateAndWait: async () => false,
      getLastNavigationFailure: () => ({ cause: '', message: '', timedOut: true }),
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.navigate(baseTarget, 'https://example.com/slow2'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'NAVIGATION_TIMEOUT');
        return true;
      }
    );
  });
});
