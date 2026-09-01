import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

describe('Phase 03: Browser Owner Target Revalidation & Two-Tier Input Invariants', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: 'rt-1',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (overrides?: Partial<BrowserHostPort>): BrowserHostPort => ({
    getTabList: () => [{ id: 'tab-1' }, { id: 'tab-2' }],
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

  it('rejects explicit tabId mismatch with TARGET_MISMATCH without retargeting', async () => {
    const host = createMockHost();
    const port = new BrowserControlPort(host);

    await assert.rejects(
      async () => {
        await port.agentClick({ tabId: 'tab-2', ref: '@e1' }, baseTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_MISMATCH');
        return true;
      }
    );
  });

  it('revalidates document generation inside lock and fails with TARGET_STALE if document generation advanced while queued', async () => {
    let docGen = 1;
    const host = createMockHost({
      getDocumentGeneration: () => docGen,
    });
    const port = new BrowserControlPort(host);

    // Document advances while in flight
    docGen = 2;

    await assert.rejects(
      async () => {
        await port.agentClick({ ref: '@e1' }, baseTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        return true;
      }
    );
  });

  it('revalidates exact tab existence inside lock and fails if target tab was destroyed', async () => {
    let aliveTabs = [{ id: 'tab-1' }];
    const host = createMockHost({
      getTabList: () => aliveTabs,
    });
    const port = new BrowserControlPort(host);

    // Tab destroyed
    aliveTabs = [];

    await assert.rejects(
      async () => {
        await port.agentClick({ ref: '@e1' }, baseTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        return true;
      }
    );
  });

  it('wraps uploadFileInput and dropFiles in ViewportGate and revalidates target invariants', async () => {
    let uploadInvoked = false;
    let dropInvoked = false;

    const host = createMockHost({
      uploadFileInput: async () => {
        uploadInvoked = true;
        return { success: true, uploadedCount: 1 };
      },
      dropFiles: async () => {
        dropInvoked = true;
        return { success: true, droppedCount: 1 };
      },
    });
    const port = new BrowserControlPort(host);

    const upRes = await port.uploadFileInput({ refOrSelector: '@e1', filePaths: ['C:/test.jpg'] }, baseTarget);
    assert.strictEqual(upRes.success, true);
    assert.strictEqual(uploadInvoked, true);

    const dropRes = await port.dropFiles({ refOrSelector: '@e1', filePaths: ['C:/test.jpg'] }, baseTarget);
    assert.strictEqual(dropRes.success, true);
    assert.strictEqual(dropInvoked, true);
  });

  it('reports executionTier on interactive actions', async () => {
    let clickTrustedPassed: boolean | undefined;
    const host = createMockHost({
      agentClick: async (params) => {
        clickTrustedPassed = params.trusted;
        return true;
      },
    });
    const port = new BrowserControlPort(host);

    const res = await port.agentClick({ ref: '@e1', trusted: true }, baseTarget);
    assert.strictEqual(res.clicked, true);
    assert.strictEqual(clickTrustedPassed, true);
  });
});
