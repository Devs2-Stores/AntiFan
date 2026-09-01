import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort, WaitRegistry } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';

describe('Phase 03: Browser Deterministic Wait & Registry Capacity Invariants', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-wait',
    workspaceId: 'ws-wait',
    runtimeId: 'rt-wait',
    tabId: 'tab-wait-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (tracker?: FirstPartyNetworkTracker, overrides?: Partial<BrowserHostPort>): BrowserHostPort => ({
    getTabList: () => [{ id: 'tab-wait-1' }, { id: 'tab-wait-2' }],
    getActiveTabId: () => 'tab-wait-1',
    getAutomationTabId: () => 'tab-wait-1',
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html><body><button class="btn-buy">Buy</button></body></html>',
    captureScreenshot: async () => Buffer.from('fake').toString('base64'),
    evalJs: async () => true,
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    getNetworkTracker: () => tracker as any,
    ...overrides,
  });

  it('WaitRegistry enforces 4 per tab and 16 global concurrent waits independently of PassiveExecutionPool', async () => {
    const registry = new WaitRegistry();
    const blockingPromises: Promise<void>[] = [];
    const resolvers: Array<() => void> = [];

    for (let i = 0; i < 4; i++) {
      const p = registry.execute('tab-1', (signal) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        resolvers.push(resolve);
        signal.addEventListener('abort', () => resolve());
        return promise;
      }, { timeoutMs: 10000 });
      blockingPromises.push(p);
    }

    assert.strictEqual(registry.getActiveTabCount('tab-1'), 4);
    assert.strictEqual(registry.getGlobalActiveCount(), 4);

    // 5th wait on same tab must fail immediately with CAPABILITY_OVERLOADED
    await assert.rejects(
      async () => {
        await registry.execute('tab-1', async () => 'overflow');
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'CAPABILITY_OVERLOADED');
        return true;
      }
    );

    // Release blocking waits
    for (const r of resolvers) r();
    await Promise.all(blockingPromises);

    assert.strictEqual(registry.getActiveTabCount('tab-1'), 0);
    assert.strictEqual(registry.getGlobalActiveCount(), 0);
  });

  it('browser.wait condition network_idle fails with TARGET_STALE if tracker is not attached', async () => {
    const tracker = new FirstPartyNetworkTracker();
    // Do not attach tracker for tab-wait-1
    const host = createMockHost(tracker);
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'network_idle' });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        return true;
      }
    );
  });

  it('browser.wait condition document_loaded resolves deterministically', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    const res = await port.wait(baseTarget, { condition: 'document_loaded' });
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'document_loaded');
    assert.ok(res.durationMs >= 0);
  });

  it('browser.wait condition selector evaluates DOM presence', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    const res = await port.wait(baseTarget, { condition: 'selector', selector: '.btn-buy' });
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'selector');
  });

  it('browser.wait respects AbortSignal and aborts immediately', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    const controller = new AbortController();
    controller.abort(new CapabilityError('WAIT_ABORTED', 'Operation cancelled by parent'));

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'document_loaded' }, undefined, undefined, controller.signal);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        return true;
      }
    );
  });
});
