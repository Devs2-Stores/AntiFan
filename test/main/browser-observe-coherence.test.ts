import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

describe('Phase 03: Browser Observe Coherence & Bounded Evidence Invariants', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-obs',
    workspaceId: 'ws-obs',
    runtimeId: 'rt-obs',
    tabId: 'tab-obs-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (overrides?: Partial<BrowserHostPort>): BrowserHostPort => ({
    getTabList: () => [{ id: 'tab-obs-1' }],
    getActiveTabId: () => 'tab-obs-1',
    getAutomationTabId: () => 'tab-obs-1',
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html><body><h1>Storefront Observe</h1></body></html>',
    captureScreenshot: async () => Buffer.from('fake-screenshot-data').toString('base64'),
    evalJs: async () => true,
    agentSnapshot: async () => '@e1 [button] "Add to Cart"\n@e2 [link] "Checkout"',
    getDiagnostics: () => ({ console: [], failures: [] }),
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    ...overrides,
  });

  it('captures multi-component observation with truthful drift and component timestamps', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    const res = await port.observe(baseTarget, 'run-1', 'att-1', {
      components: ['dom', 'screenshot', 'snapshot', 'diagnostics'],
    });

    assert.strictEqual(res.target.tabId, 'tab-obs-1');
    assert.strictEqual(res.target.documentGeneration, 1);
    assert.ok(res.components.dom && typeof res.components.dom === 'string' && res.components.dom.includes('Storefront Observe'));
    assert.ok(res.components.screenshot && typeof res.components.screenshot === 'string');
    assert.ok(res.components.snapshot && typeof res.components.snapshot === 'string' && res.components.snapshot.includes('@e1'));
    assert.ok(res.components.diagnostics && Array.isArray(res.components.diagnostics.console));

    assert.ok(Number.isFinite(res.metadata.driftMs));
    assert.ok(res.metadata.timestamps.start > 0);
    assert.ok(res.metadata.timestamps.end >= res.metadata.timestamps.start);
    assert.ok(res.metadata.timestamps.perComponent.dom);
    assert.ok(res.metadata.timestamps.perComponent.screenshot);
    assert.ok(res.metadata.timestamps.perComponent.snapshot);
    assert.ok(res.metadata.timestamps.perComponent.diagnostics);
  });

  it('rejects observation request with more than 4 components', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.observe(baseTarget, 'run-1', 'att-1', {
          components: ['dom', 'screenshot', 'snapshot', 'diagnostics', 'dom' as any],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'INVALID_ARGUMENT');
        return true;
      }
    );
  });

  it('fails with TARGET_STALE if document generation advances between component captures', async () => {
    let docGen = 1;
    const host = createMockHost({
      getDocumentGeneration: () => docGen,
      getDom: async () => {
        // Navigation occurred during DOM capture
        docGen = 2;
        return '<html><body>Fresh Doc</body></html>';
      },
    });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.observe(baseTarget, 'run-1', 'att-1', {
          components: ['dom', 'screenshot'],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        return true;
      }
    );
  });

  it('truncates oversized payloads to prevent unbounded memory retention', async () => {
    const hugeHtml = 'x'.repeat(600 * 1024); // 600 KiB > 512 KiB limit
    const host = createMockHost({
      getDom: async () => hugeHtml,
    });
    const port = new BrowserControlPort(host);

    const res = await port.observe(baseTarget, 'run-1', 'att-1', {
      components: ['dom'],
    });

    assert.ok(typeof res.components.dom === 'string');
    assert.ok(res.components.dom.includes('truncated'));
    assert.ok(res.components.dom.length < 550 * 1024);
  });
});
