import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { BrowserActionRegistry } from '../../src/main/browser/browser-action-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { ISOLATED_AGENT_WORLD_ID } from '../../src/main/browser/semantic-ref-executor';
import { makeControlPlaneId, issueRuntimeLease, BrowserTarget } from '../../src/shared/control-plane-contracts';
import { AntiFanTab } from '../../src/shared/contracts';
function createIntegrationHost() {
  const host = Object.create(NativeTabHost.prototype) as any;
  EventEmitter.call(host);

  const isolatedCalls: Array<{ worldId: number; code: string }> = [];

  const createMockWc = (url = 'https://example.com/store') => {
    let curUrl = url;
    const mainFrame = {
      executeJavaScriptInIsolatedWorld: async (worldId: number, scripts: Array<{ code: string }>) => {
        const code = scripts[0]?.code || '';
        isolatedCalls.push({ worldId, code });

        if (code.includes('expectedNonce')) {
          // Collector script mock
          return {
            ok: true,
            nonce: code.match(/expectedNonce = "([^"]+)"/)?.[1] || 'mock-nonce',
            documentUrl: curUrl,
            descriptors: [
              {
                path: [{ kind: 'dom', index: 0, tag: 'button', id: 'checkout-btn' }],
                fingerprint: { tag: 'button', id: 'checkout-btn', role: 'button' },
                rect: { x: 100, y: 200, width: 150, height: 45, centerX: 175, centerY: 222.5 },
                label: 'Proceed to Checkout',
                role: 'button',
                id: 'checkout-btn',
              },
            ],
          };
        }

        // Executor script mock
        return {
          ok: true,
          executed: true,
          rect: { x: 100, y: 200, width: 150, height: 45, centerX: 175, centerY: 222.5 },
        };
      },
    };

    return Object.assign(new EventEmitter(), {
      mainFrame,
      isDestroyed: () => false,
      getURL: () => curUrl,
      setURL: (u: string) => { curUrl = u; },
      executeJavaScriptInIsolatedWorld: mainFrame.executeJavaScriptInIsolatedWorld,
      executeJavaScript: async (code: string) => true,
      destroy: () => {},
    });
  };

  const desktopWc = createMockWc('https://example.com/store');
  const mobileWc = createMockWc('https://example.com/store');

  const state: AntiFanTab = {
    id: 'tab-integration-1',
    url: 'https://example.com/store',
    title: 'Store Front',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    devicePresetId: 'responsive',
  };

  host.activeTabId = 'tab-integration-1';
  host.tabs = new Map([
    [
      'tab-integration-1',
      {
        state,
        view: { webContents: desktopWc },
        mobileView: { webContents: mobileWc },
        focusedPane: 'desktop',
      },
    ],
  ]);
  host.tabOrder = ['tab-integration-1'];
  host.browserEpoch = 1;
  host.documentGenerations = new Map([['tab-integration-1', 1]]);
  host.semanticDocumentGenerations = new Map();
  host.semanticRefRegistry = new (require('../../src/main/browser/semantic-ref-registry').SemanticRefRegistry)();
  host.targetOperationQueues = new Map();
  host.agentWorkingTimers = new Map();
  host.agentWorkingRefs = new Map();
  host.broadcastState = () => {};
  host.persistTabs = () => {};
  host.isCurrentTarget = (target: BrowserTarget) => !target?.tabId || host.tabs.has(target.tabId);
  return { host, desktopWc, mobileWc, isolatedCalls };
}

describe('Semantic Ref Integration Pipeline (World 1004 & Control Plane Parity)', () => {
  it('1. End-to-end flow: agentSnapshot collects via World 1004, publishes monotonic @e1, and agentClick executes via World 1004', async () => {
    const { host, isolatedCalls } = createIntegrationHost();

    // 1. Snapshot
    const snapshotText = await host.agentSnapshot('tab-integration-1', 'desktop');
    assert.ok(snapshotText.includes('@e1 [button] "Proceed to Checkout"'));
    assert.ok(snapshotText.includes('id: "checkout-btn"'));

    const collectorCall = isolatedCalls[0]!;
    assert.strictEqual(collectorCall.worldId, ISOLATED_AGENT_WORLD_ID);
    assert.strictEqual(ISOLATED_AGENT_WORLD_ID, 1004);

    // 2. Action via ref
    const clickSuccess = await host.agentClick({ ref: '@e1', tabId: 'tab-integration-1', paneId: 'desktop' });
    assert.strictEqual(clickSuccess, true);

    const executorCall = isolatedCalls[1]!;
    assert.strictEqual(executorCall.worldId, 1004);
    assert.ok(executorCall.code.includes('resolveTraversalPath'));
    assert.ok(executorCall.code.includes('checkout-btn'));
  });

  it('2. BrowserActionRegistry integration: executes agentSnapshot and agentClick over action registry routing', async () => {
    const { host } = createIntegrationHost();
    const registry = new BrowserActionRegistry(host);

    const snapResult = await registry.execute('agentSnapshot', { tabId: 'tab-integration-1', paneId: 'desktop' });
    assert.strictEqual(snapResult.success, true);
    assert.ok(snapResult.snapshot.includes('@e1'));

    const clickResult = await registry.execute('agentClick', {
      ref: '@e1',
      tabId: 'tab-integration-1',
      paneId: 'desktop',
    });
    assert.strictEqual(clickResult.success, true);
    assert.strictEqual(clickResult.clicked, true);
  });

  it('3. CapabilityCatalogue & BrowserControlPort integration: exposes ref-capable schemas and forwards pane targets', async () => {
    const { host } = createIntegrationHost();
    const port = new BrowserControlPort(host);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    registerBrowserCapabilities(catalogue, port);

    const snapCap = catalogue.get('antifan_agent_snapshot');
    assert.ok(snapCap);

    const clickCap = catalogue.get('antifan_agent_click');
    assert.ok(clickCap);
    const props = clickCap.inputSchema?.properties as Record<string, unknown>;
    assert.ok(props?.ref);
    assert.ok(props?.paneId);
    const boundTarget: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-integration-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };
    // Take snapshot to allocate @e1
    await host.agentSnapshot('tab-integration-1', 'desktop');

    const clickRes = await catalogue.dispatch('antifan_agent_click', {
      ref: '@e1',
      tabId: 'tab-integration-1',
      paneId: 'desktop',
    }, {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      grant: 'write',
      browserTarget: boundTarget,
    });
    assert.strictEqual(typeof clickRes, 'object');
  });

  it('4. Split review isolation: desktop and mobile panes maintain independent snapshots and generations', async () => {
    const { host } = createIntegrationHost();
    const curTab = host.tabs.get('tab-integration-1');
    curTab.state.splitMode = true;

    const desktopSnap = await host.agentSnapshot('tab-integration-1', 'desktop');
    assert.ok(desktopSnap.includes('@e1'));

    const mobileSnap = await host.agentSnapshot('tab-integration-1', 'mobile');
    // Monotonic counter increments: next ref is @e2
    assert.ok(mobileSnap.includes('@e2'));

    // Invalidate mobile pane via navigation
    host.setSemanticDocumentGeneration('tab-integration-1', 'mobile', 2);

    // Mobile @e2 is now stale and fails closed
    const mobileClick = await host.dispatchAgentAction('click', { ref: '@e2', tabId: 'tab-integration-1', paneId: 'mobile' });
    assert.strictEqual(mobileClick.success, false);
    assert.match(mobileClick.reason || '', /mismatch|stale|REF_STALE/i);

    // Desktop @e1 remains valid on untouched desktop pane
    const desktopClick = await host.dispatchAgentAction('click', { ref: '@e1', tabId: 'tab-integration-1', paneId: 'desktop' });
    assert.strictEqual(desktopClick.success, true);
  });

  it('5. Hardened error fallback: script collection failure returns structured error string without dumping outerHTML', async () => {
    const { host, desktopWc } = createIntegrationHost();
    desktopWc.mainFrame.executeJavaScriptInIsolatedWorld = async () => {
      throw new Error('Synthetic frame navigation crash during snapshot collection');
    };

    const res = await host.agentSnapshot('tab-integration-1', 'desktop');
    assert.ok(res.startsWith('[Semantic Snapshot Error:'), `Expected error prefix but got: ${res}`);
    assert.ok(res.includes('Synthetic frame navigation crash'));
    assert.ok(res.length < 200, `Expected compact error under 200 chars but got length ${res.length}`);
    assert.strictEqual(res.includes('<html'), false, 'Must never dump raw HTML on collection error');
  });
});
