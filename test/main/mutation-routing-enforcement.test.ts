import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

describe('Priority 1: Mutation Routing & Active Tab Protection Invariants', () => {
  const baseTarget: BrowserTarget = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: 'run-1',
    tabId: '',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  it('1. Rejects write actions with TARGET_REQUIRED when no explicit tabId, no auto tab, and host cannot create tabs', async () => {
    let activeTabMutated = false;
    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'user-working-tab-active', url: 'https://youtube.com', title: 'User Working Tab' }],
      getActiveTabId: () => 'user-working-tab-active',
      getAutomationTabId: () => null,
      agentClick: async (params) => {
        if (params.tabId === 'user-working-tab-active') {
          activeTabMutated = true;
        }
        return true;
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);

    // Call agentClick without explicit args.tabId and without target.tabId
    await assert.rejects(
      async () => {
        await port.agentClick({ selector: 'button.dangerous' }, baseTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_REQUIRED');
        assert.match(err.message, /Behavioral mutation requires an explicit target tabId or dedicated automation tab/);
        return true;
      }
    );

    // Verify active working tab was NOT mutated
    assert.strictEqual(activeTabMutated, false, 'User active working tab must not be touched by automated write');
  });

  it('2. Auto-provisions an isolated ephemeral RAM tab when host.createTab exists, protecting active working tab', async () => {
    let createdOptions: { ephemeral?: boolean } | undefined;
    let createdUrl: string | undefined;
    let automationTabIdSet: string | undefined;
    let clickedTabId: string | undefined;

    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [
        { id: 'user-active-tab', url: 'https://admin.haravan.com', title: 'Merchant Admin' },
        ...(automationTabIdSet ? [{ id: automationTabIdSet, url: 'about:blank', title: 'Automation' }] : []),
      ],
      getActiveTabId: () => 'user-active-tab',
      getAutomationTabId: () => automationTabIdSet || null,
      setAutomationTabId: (id) => {
        automationTabIdSet = id;
      },
      createTab: (url, activate, options) => {
        createdUrl = url;
        createdOptions = options;
        const newId = 'ephemeral-auto-tab-999';
        return newId;
      },
      agentClick: async (params) => {
        clickedTabId = params.tabId;
        return true;
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);

    const res = await port.agentClick({ selector: '#buy-now' }, baseTarget);
    assert.strictEqual(res.clicked, true);

    // Verified: An ephemeral tab was created
    assert.strictEqual(createdUrl, 'about:blank');
    assert.ok(createdOptions, 'createTab must receive options');
    assert.strictEqual(createdOptions?.ephemeral, true, 'Auto-provisioned automation tab must be strictly ephemeral');
    assert.strictEqual(clickedTabId, 'ephemeral-auto-tab-999', 'Write action must target the ephemeral tab');
    assert.notStrictEqual(clickedTabId, 'user-active-tab', 'Write action must NEVER target user-active-tab');
  });

  it('3. Reuses existing automation tab when present', async () => {
    let clickedTabId: string | undefined;

    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [
        { id: 'user-active-tab', url: 'https://admin.haravan.com' },
        { id: 'existing-auto-tab', url: 'https://storefront.dev' },
      ],
      getActiveTabId: () => 'user-active-tab',
      getAutomationTabId: () => 'existing-auto-tab',
      agentClick: async (params) => {
        clickedTabId = params.tabId;
        return true;
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);

    const res = await port.agentClick({ selector: '.btn' }, baseTarget);
    assert.strictEqual(res.clicked, true);
    assert.strictEqual(clickedTabId, 'existing-auto-tab');
  });

  it('4. Allows read-only actions (dom, screenshot, eval) to read from active tab when no tab is specified', async () => {
    let readTabId: string | undefined;

    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'user-active-tab', url: 'https://storefront.dev' }],
      getActiveTabId: () => 'user-active-tab',
      getAutomationTabId: () => null,
      getDom: async (sel, tabId) => {
        readTabId = tabId;
        return '<html><body>Safe Read</body></html>';
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);

    // Read action does not mutate, should safely read from active tab
    const dom = await port.dom(baseTarget, 'run-1', 'att-1');
    assert.strictEqual(typeof dom, 'string');
    assert.strictEqual(readTabId, 'user-active-tab');
  });

  it('5. User-directed gestures with explicit tabId execute directly on that targeted tab', async () => {
    let clickedTabId: string | undefined;

    const mockHost: Partial<BrowserHostPort> = {
      getTabList: () => [
        { id: 'user-active-tab', url: 'https://storefront.dev' },
        { id: 'other-tab', url: 'https://other.dev' },
      ],
      getActiveTabId: () => 'user-active-tab',
      getAutomationTabId: () => 'other-tab',
      agentClick: async (params) => {
        clickedTabId = params.tabId;
        return true;
      },
    };

    const port = new BrowserControlPort(mockHost as BrowserHostPort);

    // User explicitly asks to click on user-active-tab
    const res = await port.agentClick({ selector: '#cart-btn', tabId: 'user-active-tab' }, baseTarget);
    assert.strictEqual(res.clicked, true);
    assert.strictEqual(clickedTabId, 'user-active-tab', 'Explicit tabId must be honored');
  });
});
