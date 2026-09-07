import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

describe('Target Stale & Structured Rebind Contract Reproduction', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-test',
    workspaceId: 'ws-test',
    runtimeId: 'rt-test',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (overrides?: Partial<BrowserHostPort>): BrowserHostPort => ({
    getTabList: () => [{ id: 'tab-1' }],
    getActiveTabId: () => 'tab-1',
    getAutomationTabId: () => 'tab-1',
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html><body><div>Test</div></body></html>',
    captureScreenshot: async () => Buffer.from('fake-screenshot').toString('base64'),
    evalJs: async () => true,
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    agentClick: async () => true,
    agentType: async () => true,
    sendKeyboardPress: async () => ({ success: true, key: 'Enter', modifiers: [] }),
    ...overrides,
  });

  it('proves that TARGET_STALE throws when document generation advances and must carry structured details', async () => {
    let currentDocGen = 1;
    const host = createMockHost({
      getDocumentGeneration: () => currentDocGen,
    });
    const port = new BrowserControlPort(host);

    // Document advances due to out-of-band navigation / page submit
    currentDocGen = 2;

    await assert.rejects(
      async () => {
        await port.agentClick({ ref: '@e1' }, baseTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        assert.ok(err.details !== undefined, 'TARGET_STALE must carry structured details for recovery');
        assert.strictEqual(err.details?.tabId, 'tab-1');
        assert.strictEqual(err.details?.targetDocumentGeneration, 1);
        assert.strictEqual(err.details?.liveDocumentGeneration, 2);
        assert.strictEqual(err.details?.canRebind, true);
        return true;
      }
    );
  });

  it('allows caller to rebind target via rebindTarget and retry action successfully', async () => {
    let currentDocGen = 1;
    const host = createMockHost({
      getDocumentGeneration: () => currentDocGen,
      getTabList: () => [{ id: 'tab-1', url: 'https://example.com', title: 'Test' }],
    });
    const port = new BrowserControlPort(host);

    // Navigation bumps docGen to 2
    currentDocGen = 2;

    // 1. Stale action fails with TARGET_STALE and canRebind: true
    let staleError: CapabilityError | undefined;
    try {
      await port.agentClick({ ref: '@e1' }, baseTarget);
    } catch (e: any) {
      staleError = e;
    }
    assert.ok(staleError instanceof CapabilityError);
    assert.strictEqual(staleError.code, 'TARGET_STALE');
    assert.strictEqual(staleError.details?.canRebind, true);

    // 2. Caller uses rebindTarget to resynchronize
    const rebindReceipt = port.rebindTarget({ tabId: 'tab-1' }, baseTarget);
    assert.strictEqual(rebindReceipt.success, true);
    assert.strictEqual(rebindReceipt.tabId, 'tab-1');
    assert.strictEqual(rebindReceipt.documentGeneration, 2);

    // 3. Updated target with new documentGeneration succeeds
    const updatedTarget: BrowserTarget = {
      ...baseTarget,
      documentGeneration: rebindReceipt.documentGeneration,
    };
    const clickRes = await port.agentClick({ ref: '@e1' }, updatedTarget);
    assert.strictEqual(clickRes.clicked, true);
  });

  it('rebindTarget rejects non-existent tabId with TARGET_STALE and canRebind: false', () => {
    const host = createMockHost({
      getTabList: () => [{ id: 'tab-1' }],
    });
    const port = new BrowserControlPort(host);

    assert.throws(
      () => {
        port.rebindTarget({ tabId: 'non-existent-tab' }, baseTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        assert.strictEqual(err.details?.canRebind, false);
        return true;
      }
    );
  });

  it('rebindTarget rejects empty tabId with TARGET_REQUIRED', () => {
    const host = createMockHost({
      getTabList: () => [],
    });
    const port = new BrowserControlPort(host);

    assert.throws(
      () => {
        port.rebindTarget({ tabId: '' }, { ...baseTarget, tabId: '' });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_REQUIRED');
        return true;
      }
    );
  });
});
