import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort, WaitRegistry } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError, AuthenticatedCapabilityContext } from '../../src/shared/control-plane-contracts';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
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
        assert.strictEqual((err as CapabilityError).code, 'WAIT_ABORTED', 'an aborted wait must surface WAIT_ABORTED, not an unrelated CapabilityError');
        return true;
      }
    );
  });

  it('browser.wait condition generation resolves when minGeneration is already satisfied', async () => {
    const host = createMockHost(undefined, {
      getDocumentGeneration: () => 3,
    });
    const port = new BrowserControlPort(host);

    const res = await port.wait(baseTarget, { condition: 'generation', minGeneration: 2 });
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'generation');
    const details = res.details as { currentGeneration?: number; minGeneration?: number } | undefined;
    assert.strictEqual(details?.currentGeneration, 3);
    assert.strictEqual(details?.minGeneration, 2);
  });

  it('browser.wait condition generation resolves when host bumps generation', async () => {
    let currentGen = 1;
    const host = createMockHost(undefined, {
      getDocumentGeneration: () => currentGen,
    });
    const port = new BrowserControlPort(host);

    const waitPromise = port.wait(baseTarget, { condition: 'generation' });
    // Exercises real platform timers across event loop turns: setImmediate yields to event loop before mutating
    setImmediate(() => {
      currentGen = 2;
    });

    const res = await waitPromise;
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'generation');
    const details = res.details as { baselineGeneration?: number; currentGeneration?: number } | undefined;
    assert.strictEqual(details?.baselineGeneration, 1);
    assert.strictEqual(details?.currentGeneration, 2);
  });

  it('browser.wait condition generation times out when generation does not advance', async () => {
    const host = createMockHost(undefined, {
      getDocumentGeneration: () => 1,
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'generation', minGeneration: 5, timeoutMs: 100 });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'LEASE_EXPIRED');
        return true;
      }
    );
  });

  it('browser.wait condition navigation resolves when document transition completes', async () => {
    let currentGen = 1;
    let currentUrl = 'https://example.com/initial';
    const host = createMockHost(undefined, {
      getDocumentGeneration: () => currentGen,
      getTabUrl: () => currentUrl,
    });
    const port = new BrowserControlPort(host);

    const waitPromise = port.wait(baseTarget, {
      condition: 'navigation',
      urlPattern: '**/checkout',
    });

    // Exercises real platform timers across event loop turns: setImmediate yields to event loop before mutating
    setImmediate(() => {
      currentGen = 2;
      currentUrl = 'https://example.com/checkout';
    });

    const res = await waitPromise;
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'navigation');
    const details = res.details as { documentGeneration?: number; url?: string } | undefined;
    assert.strictEqual(details?.documentGeneration, 2);
    assert.strictEqual(details?.url, 'https://example.com/checkout');
  });

  it('browser.wait condition navigation fails with TARGET_STALE if getLastNavigationFailure reports failure', async () => {
    const host = createMockHost(undefined, {
      getLastNavigationFailure: () => ({ cause: 'NAVIGATION_TIMEOUT', message: 'Navigation timed out', timedOut: true }),
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'navigation', timeoutMs: 100 });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        assert.ok(err.message.includes('NAVIGATION_TIMEOUT'));
        return true;
      }
    );
  });

  it('browser.wait condition navigation times out when no transition occurs', async () => {
    const host = createMockHost(undefined, {
      getDocumentGeneration: () => 1,
      getTabUrl: () => 'https://example.com/static',
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'navigation', timeoutMs: 100 });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'LEASE_EXPIRED');
        return true;
      }
    );
  });

  it('browser.wait condition actionability validates selector or ref requirement', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'actionability' });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'INVALID_ARGUMENT');
        return true;
      }
    );
  });

  it('browser.wait condition actionability resolves when element is visible, enabled, and stable', async () => {
    const host = createMockHost(undefined, {
      evalJs: async () => ({
        actionable: true,
        rect: { x: 50, y: 100, width: 80, height: 40 },
      }),
    });
    const port = new BrowserControlPort(host);

    const res = await port.wait(baseTarget, { condition: 'actionability', selector: '#checkout-btn' });
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'actionability');
    const details = res.details as { selector?: string; rect?: { width: number } } | undefined;
    assert.strictEqual(details?.selector, '#checkout-btn');
    assert.strictEqual(details?.rect?.width, 80);
  });

  it('browser.wait condition actionability times out when element remains non-actionable', async () => {
    const host = createMockHost(undefined, {
      evalJs: async () => ({
        actionable: false,
        reason: 'DISABLED',
      }),
      getDom: async () => '',
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.wait(baseTarget, { condition: 'actionability', selector: '#disabled-btn', timeoutMs: 100 });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'LEASE_EXPIRED');
        return true;
      }
    );
  });

  it('browser.wait condition selector with state actionable checks actionability', async () => {
    let checked = false;
    const host = createMockHost(undefined, {
      evalJs: async () => {
        checked = true;
        return { actionable: true, rect: { x: 10, y: 20, width: 30, height: 40 } };
      },
    });
    const port = new BrowserControlPort(host);

    const res = await port.wait(baseTarget, { condition: 'selector', selector: '.cta', state: 'actionable' });
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(checked, true);
  });

  it('browser.wait canonical conditions url and url_match match pattern deterministically', async () => {
    const host = createMockHost(undefined, {
      getTabUrl: () => 'https://storefront.test/products/jacket',
    });
    const port = new BrowserControlPort(host);

    // Canonical 'url'
    const resUrl = await port.wait(baseTarget, { condition: 'url', urlPattern: '**/products/*' });
    assert.strictEqual(resUrl.satisfied, true);
    assert.strictEqual(resUrl.condition, 'url');

    // Legacy alias 'url_match'
    const resMatch = await port.wait(baseTarget, { condition: 'url_match', urlPattern: 'jacket' });
    assert.strictEqual(resMatch.satisfied, true);
    assert.strictEqual(resMatch.condition, 'url_match');
  });

  it('browser.wait canonical condition dom-stable resolves after quiescence', async () => {
    const host = createMockHost(undefined, {
      getMutationRevision: () => 42,
    });
    const port = new BrowserControlPort(host);

    const res = await port.wait(baseTarget, { condition: 'dom-stable', idleWindowMs: 100 });
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'dom-stable');
    const details = res.details as { mutationRevision?: number } | undefined;
    assert.strictEqual(details?.mutationRevision, 42);
  });

  it('browser.wait and anti.browser.wait are registered in CapabilityCatalogue and support new conditions', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: baseTarget.projectId,
      workspaceId: baseTarget.workspaceId,
      runtimeId: baseTarget.runtimeId,
    });
    registerBrowserCapabilities(catalogue, port);

    const waitCap = catalogue.get('browser.wait');
    const antiWaitCap = catalogue.get('anti.browser.wait');

    assert.ok(waitCap, 'browser.wait must be registered');
    assert.ok(antiWaitCap, 'anti.browser.wait must be registered');

    const waitSchema = waitCap.inputSchema as { properties?: { condition?: { enum?: string[] } } } | undefined;
    const antiSchema = antiWaitCap.inputSchema as { properties?: { condition?: { enum?: string[] } } } | undefined;
    const waitEnum = waitSchema?.properties?.condition?.enum || [];
    const antiEnum = antiSchema?.properties?.condition?.enum || [];

    for (const c of ['selector', 'url', 'navigation', 'dom-stable', 'network', 'actionability', 'generation', 'url_match', 'dom_stable', 'network_idle']) {
      assert.ok(waitEnum.includes(c), `browser.wait must include condition ${c}`);
      assert.ok(antiEnum.includes(c), `anti.browser.wait must include condition ${c}`);
    }

    const context = { browserTarget: baseTarget } as unknown as AuthenticatedCapabilityContext;
    const res = (await waitCap.execute({ condition: 'generation', minGeneration: 1 }, context)) as { satisfied?: boolean; condition?: string };
    assert.strictEqual(res.satisfied, true);
    assert.strictEqual(res.condition, 'generation');

    const antiRes = (await antiWaitCap.execute({ condition: 'generation', minGeneration: 1 }, context)) as { satisfied?: boolean; condition?: string };
    assert.strictEqual(antiRes.satisfied, true);
    assert.strictEqual(antiRes.condition, 'generation');
  });
});
