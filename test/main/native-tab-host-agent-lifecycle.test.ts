import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';
import { AsyncThemeQaQueue } from '../../src/main/qa/async-qa-job-queue';
type TestHost = any;

function createHost(executeJavaScript: (code: string) => Promise<unknown>) {
  const host = Object.create(NativeTabHost.prototype) as TestHost;
  const state = {
    id: 'tab-1',
    url: 'https://example.test/',
    title: 'Example',
    aiState: 'idle',
  };
  const mainFrame = {
    executeJavaScriptInIsolatedWorld: async (worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code || '';
      const res = await executeJavaScript(code);
      if (res && typeof res === 'object' && 'ok' in (res as any)) return res;
      if (res === false) {
        return { ok: false, error: 'Simulated failure' };
      }
      return { ok: true, executed: Boolean(res), rect: { x: 10, y: 20, width: 50, height: 20, centerX: 35, centerY: 30 } };
    },
  };
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    getURL: () => state.url,
    executeJavaScript,
    executeJavaScriptInIsolatedWorld: mainFrame.executeJavaScriptInIsolatedWorld,
  };
  host.activeTabId = 'tab-1';
  // Dual-Plane: these lifecycle tests exercise working-ref / aiState behavior, so
  // bind tab-1 as the agent automation tab. Agent actions must never fall back to
  // the user's active foreground tab, but here tab-1 is the agent's own target.
  host.automationTabId = 'tab-1';
  host.tabs = new Map([['tab-1', { state, view: { webContents } }]]);
  host.tabOrder = ['tab-1'];
  host.documentGenerations = new Map([['tab-1', 7]]);
  host.programmaticNavigations = new Map();
  host.agentWorkingTimers = new Map();
  host.agentWorkingRefs = new Map();
  host.broadcastState = () => {};
  host.ensureAgentBrowserInjected = async () => true;
  host.asyncQaQueue = new AsyncThemeQaQueue();
  host.semanticRefRegistry = new SemanticRefRegistry();
  host.semanticDocumentGenerations = new Map();
  host.targetOperationQueues = new Map();
  host.persistTabs = () => {};
  return { host, state, webContents };
}

describe('NativeTabHost agent activity lifecycle', () => {
  it('normalizes legacy trajectory steps and rejects a partial success result', async () => {
    let executedScript = '';
    const { host, state } = createHost(async (code) => {
      if (code.includes('__antifanAgentTrajectory')) {
        executedScript = code;
        return { success: true, executedSteps: 1, totalSteps: 2 };
      }
      return true;
    });

    const result = await host.agentTrajectory({
      steps: [
        { type: 'click', selector: '#submit' },
        { type: 'scroll', deltaY: 250 },
      ],
      speed: 'slow',
      smoothScroll: false,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.executedSteps, 1);
    assert.strictEqual(result.totalSteps, 2);
    assert.strictEqual(result.reason, 'Trajectory did not complete all steps');
    assert.match(executedScript, /"action":"click"/);
    assert.match(executedScript, /"action":"scroll"/);
    assert.match(executedScript, /"speed":"slow"/);
    assert.match(executedScript, /"smoothScroll":false/);
    assert.strictEqual(state.aiState, 'idle');
    assert.strictEqual(host.agentWorkingRefs.size, 0);
  });

  it('returns structured preflight failures for malformed and unsupported steps', async () => {
    let executionCount = 0;
    const { host } = createHost(async (code) => {
      if (code.includes('__antifanAgentTrajectory')) {
        executionCount++;
        return { success: true, executedSteps: 1, totalSteps: 1 };
      }
      return true;
    });

    const malformed = await host.agentTrajectory({ steps: undefined } as any);
    assert.deepStrictEqual(malformed, {
      success: false,
      executedSteps: 0,
      totalSteps: 0,
      reason: 'Missing or invalid steps array',
    });

    const unsupported = await host.agentTrajectory({ steps: [{ type: 'launch' }] });
    assert.strictEqual(unsupported.success, false);
    assert.strictEqual(unsupported.executedSteps, 0);
    assert.strictEqual(unsupported.totalSteps, 1);
    assert.match(String(unsupported.reason), /Unsupported trajectory action at step 0: launch/);
    assert.strictEqual(executionCount, 0);
  });

  it('forces failure when the document changes during trajectory execution', async () => {
    const { host } = createHost(async (code) => {
      if (code.includes('__antifanAgentTrajectory')) {
        host.documentGenerations.set('tab-1', 8);
        return { success: true, executedSteps: 1, totalSteps: 1 };
      }
      return true;
    });

    const result = await host.agentTrajectory({ steps: [{ action: 'move', x: 10, y: 20 }] });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.executedSteps, 1);
    assert.strictEqual(result.totalSteps, 1);
    assert.strictEqual(result.reason, 'Interrupted by navigation or document change');
  });

  it('keeps overlapping agent actions active until the final action settles', async () => {
    const pending: Array<() => void> = [];
    const { host, state } = createHost((code) => {
      // Only the real isolated-world dispatch (which carries documentUrl) is a
      // controllable pending. The agent-browser injection script also defines
      // __antifanAgentClick but must resolve synchronously so it never consumes a
      // dispatch slot. Overlapping actions are FIFO-serialized per tab: the second
      // action's dispatch only runs after the first settles.
      if (code.includes('documentUrl')) {
        return new Promise<boolean>((resolve) => pending.push(() => resolve(true)));
      }
      return Promise.resolve(true);
    });
    // Dual-Plane: agent actions require an explicit target tabId (never fall back
    // to the user's active foreground tab), so bind both overlapping actions to
    // tab-1 explicitly; getAutomationTabId resolves via NativeTabHost.prototype.
    const first = host.agentClick({ x: 10, y: 20, tabId: 'tab-1' });
    const second = host.agentClick({ x: 30, y: 40, tabId: 'tab-1' });
    await Promise.resolve();
    await Promise.resolve();

    // Both overlapping actions are active: refs=2 and the tab is agent_working,
    // even though FIFO serializes their dispatch.
    assert.strictEqual(host.agentWorkingRefs.get('tab-1'), 2);
    assert.strictEqual(state.aiState, 'agent_working');

    // Let the first action's FIFO turn run and push its dispatch pending slot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // First action's dispatch settles; it must be resolved explicitly. Its
    // process-tree listener (withTabAgentWorking -> runTargetOperation) increments
    // refs for the overlapping sibling already, so this resolves just first.
    pending.splice(0, 1)[0]!();
    assert.strictEqual(await first, true);
    assert.strictEqual(host.agentWorkingRefs.get('tab-1'), 1);
    assert.strictEqual(state.aiState, 'agent_working');

    // Let the FIFO release so the second action's dispatch acquires the lock and
    // pushes its own pending slot, then settle it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.splice(0, 1)[0]!();
    assert.strictEqual(await second, true);
    assert.strictEqual(host.agentWorkingRefs.size, 0);
    assert.strictEqual(state.aiState, 'idle');
  });

  it('propagates false hook results for direct actions', async () => {
    const { host } = createHost(async (code) => {
      if (
        code.includes('click') ||
        code.includes('type') ||
        code.includes('scroll') ||
        code.includes('move') ||
        code.includes('hover') ||
        code.includes('highlight') ||
        code.includes('__antifanAgent')
      ) {
        return false;
      }
      return true;
    });
    assert.strictEqual(await host.agentClick({ x: 10, y: 20 }), false);
    assert.strictEqual(await host.agentType({ selector: '#name', text: 'Ada' }), false);
    assert.strictEqual(await host.agentScroll({ deltaY: 200 }), false);
    assert.strictEqual(await host.agentHover({ x: 10, y: 20 }), false);
    assert.strictEqual(await host.agentHighlight({ selector: '#name' }), false);
  });

  it('waits for asynchronous typing hooks before settling', async () => {
    let resolveType!: (result: boolean) => void;
    const typeResult = new Promise<boolean>((resolve) => { resolveType = resolve; });
    const { host } = createHost(async (code) => {
      if (code.includes('type') || code.includes('__antifanAgentType')) return typeResult;
      return true;
    });

    let settled = false;
    const result = host.agentType({ selector: '#name', text: 'Ada' }).then((value: boolean) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(settled, false);

    resolveType(true);
    assert.strictEqual(await result, true);
  });

  it('clears per-tab activity timers before closing the tab', () => {
    let destroyed = false;
    const { host } = createHost(async () => true);
    const target = host.tabs.get('tab-1');
    target.view.webContents.destroy = () => { destroyed = true; };
    host.activeTabId = 'other-tab';
    host.recentlyClosedTabs = [];
    host.tabPreviewUnsubscribers = new Map();
    host.diagnosticsManager = { deleteTab: () => {} };
    host.automationTabId = 'tab-1';
    host.isInspecting = false;
    host.agentWorkingRefs.set('tab-1', 1);
    host.agentWorkingTimers.set('tab-1', {} as NodeJS.Timeout);
    assert.strictEqual(host.closeTab('tab-1'), true);
    assert.strictEqual(host.agentWorkingRefs.has('tab-1'), false);
    assert.strictEqual(host.agentWorkingTimers.has('tab-1'), false);
    assert.strictEqual(host.automationTabId, null);
    assert.strictEqual(destroyed, true);
  });
});

describe('NativeTabHost initial navigation history', () => {
  it('clears the implicit initial entry and refreshes back/forward state', () => {
    let clearCount = 0;
    let broadcastCount = 0;
    let historyLength = 2;
    const host = Object.create(NativeTabHost.prototype) as TestHost;
    const state = { canGoBack: true, canGoForward: false };
    const navigationHistory = {
      length: () => historyLength,
      clear: () => { clearCount++; historyLength = 1; },
      canGoBack: () => historyLength > 1,
      canGoForward: () => false,
    };
    host.broadcastState = () => { broadcastCount++; };

    host.clearInitialNavigationHistory({ navigationHistory }, state);

    assert.strictEqual(clearCount, 1);
    assert.strictEqual(broadcastCount, 1);
    assert.deepStrictEqual(state, { canGoBack: false, canGoForward: false });
  });

  it('does not clear a single-entry history', () => {
    let clearCount = 0;
    const host = Object.create(NativeTabHost.prototype) as TestHost;
    host.broadcastState = () => {};
    host.clearInitialNavigationHistory({
      navigationHistory: {
        length: () => 1,
        clear: () => { clearCount++; },
        canGoBack: () => false,
        canGoForward: () => false,
      },
    }, { canGoBack: false, canGoForward: false });

    assert.strictEqual(clearCount, 0);
  });
});

// Device emulation no longer touches the native `WebContents.enableDeviceEmulation`
// API at all: that call dereferences the view's render widget host without a null
// check, so a view whose frame host has no widget (never attached, pre-commit, or
// renderer gone) takes the whole browser process down (STATUS_ACCESS_VIOLATION,
// read of 0x0) — a native fault no try/catch can intercept and no JS-observable
// guard can prevent. Every parameter the native call carried, including the
// fit-preview scale, now rides `Emulation.setDeviceMetricsOverride` through the
// DevTools agent, whose handler checks the widget and answers with a protocol
// error instead of dereferencing it. These cases pin the CDP contract: the
// override carries size and scale, clearing goes through the same channel, and
// no native emulation call is ever made — attached or detached.
describe('NativeTabHost device emulation rides the DevTools agent', () => {
  let nextWcId = 1;

  function createEmulationHost() {
    const host = Object.create(NativeTabHost.prototype) as TestHost;
    const cdpCalls: Array<{ wc: string; method: string; params: Record<string, unknown> }> = [];
    const nativeCalls: string[] = [];
    const makeWc = (name: string) => ({
      id: nextWcId++,
      isDestroyed: () => false,
      getURL: () => `https://example.test/${name}`,
      getUserAgent: () => 'default-ua',
      setUserAgent: () => {},
      setZoomFactor: () => {},
      insertCSS: async () => 'clip-key',
      executeJavaScript: async () => true,
      on: () => {},
      debugger: {
        isAttached: () => true,
        attach: () => {},
        once: () => {},
        on: () => {},
        sendCommand: async (method: string, params: Record<string, unknown>) => {
          cdpCalls.push({ wc: name, method, params });
        },
      },
      // Spies, not stubs: production must never reach either native API again.
      enableDeviceEmulation: () => { nativeCalls.push(`enable:${name}`); },
      disableDeviceEmulation: () => { nativeCalls.push(`disable:${name}`); },
    });
    const makeView = (webContents: unknown) => ({
      webContents,
      setBounds: () => {},
      setBackgroundColor: () => {},
    });
    const desktopWc = makeWc('desktop');
    const mobileWc = makeWc('mobile');
    const desktopView = makeView(desktopWc);
    const mobileView = makeView(mobileWc);
    const children: unknown[] = [];
    host.window = {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      contentView: {
        children,
        addChildView: (view: unknown) => {
          const existing = children.indexOf(view);
          if (existing >= 0) children.splice(existing, 1);
          children.push(view);
        },
        removeChildView: (view: unknown) => {
          const existing = children.indexOf(view);
          if (existing >= 0) children.splice(existing, 1);
        },
      },
    };
    host.appliedClipRadius = new Map();
    host.touchEmulationStates = new Map();
    host.pendingEmulationDeferrals = new Map();
    host.tabs = new Map();
    host.activeTabId = 'tab-desktop';
    host.isSidebarOpen = false;
    host.defaultUserAgent = 'default-ua';
    host.broadcastState = () => {};
    return { host, cdpCalls, nativeCalls, children, desktopWc, mobileWc, desktopView, mobileView };
  }

  const flushCdp = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  it('applies the full emulation override through CDP, including the fit-preview scale', async () => {
    const { host, cdpCalls, nativeCalls, children, desktopView } = createEmulationHost();
    host.tabs.set('tab-desktop', { state: { id: 'tab-desktop', splitMode: false, devicePresetId: 'phone-iphone15pro', zoomFactor: 1 }, view: desktopView });
    children.push(desktopView);

    host.applyTabDeviceEmulation(host.tabs.get('tab-desktop'), 400, 300, 74);
    await flushCdp();

    const metrics = cdpCalls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    assert.ok(metrics, 'the preset must reach the DevTools agent as a metrics override');
    assert.strictEqual(metrics?.params.mobile, true);
    assert.strictEqual(typeof metrics?.params.width, 'number');
    // 390x844 into a 400x300 pane fits at ~0.355: the shrink the native call used to
    // carry must arrive on the same override, not a second channel.
    assert.ok(
      typeof metrics?.params.scale === 'number' && metrics.params.scale > 0 && metrics.params.scale < 1,
      `fit-preview scale must ride the override, got ${String(metrics?.params.scale)}`
    );
    assert.deepStrictEqual(nativeCalls, [], 'no native device-emulation call may be made');
  });

  it('clears the override through CDP when the tab has no preset', async () => {
    const { host, cdpCalls, nativeCalls, children, desktopView } = createEmulationHost();
    host.tabs.set('tab-desktop', { state: { id: 'tab-desktop', splitMode: false, devicePresetId: 'responsive', zoomFactor: 1 }, view: desktopView });
    children.push(desktopView);

    host.applyTabDeviceEmulation(host.tabs.get('tab-desktop'), 1600, 900, 74);
    await flushCdp();

    assert.ok(
      cdpCalls.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'),
      'a preset-less tab must clear the metrics override through the DevTools agent'
    );
    assert.deepStrictEqual(nativeCalls, [], 'no native device-emulation call may be made');
  });

  it('emulates a detached pane through CDP without any native call', async () => {
    const run = async (attachMobile: boolean) => {
      const { host, cdpCalls, nativeCalls, children, desktopView, mobileView } = createEmulationHost();
      const tab = { state: { id: 'tab-desktop', splitMode: true, zoomFactor: 1 }, view: desktopView, mobileView };
      host.tabs.set('tab-desktop', tab);
      children.push(desktopView);
      if (attachMobile) children.push(mobileView);

      host.applyTabDeviceEmulation(tab, 1600, 900, 74);
      await flushCdp();
      return { cdpCalls, nativeCalls };
    };

    // Attached or detached, the DevTools agent answers a protocol error instead of
    // dereferencing a missing widget — the pane is emulated identically either way,
    // which is exactly what makes the detached path safe now.
    const attached = await run(true);
    assert.ok(
      attached.cdpCalls.some((c) => c.wc === 'mobile' && c.method === 'Emulation.setDeviceMetricsOverride'),
      'an attached mobile pane is emulated through CDP'
    );
    assert.deepStrictEqual(attached.nativeCalls, []);

    const detached = await run(false);
    assert.ok(
      detached.cdpCalls.some((c) => c.wc === 'mobile' && c.method === 'Emulation.setDeviceMetricsOverride'),
      'a detached mobile pane is emulated through CDP without a native call'
    );
    assert.deepStrictEqual(detached.nativeCalls, []);
  });
  it('defers the override until first commit instead of touching a renderer-less view', async () => {
    // The crash this guards: Emulation.setDeviceMetricsOverride sent to a
    // WebContents with no committed document kills the process the same way the
    // native API did. The gate is getURL() — empty means no renderer exists, so
    // the override must wait for did-finish-load.
    const { host, cdpCalls, nativeCalls, children, desktopView } = createEmulationHost();
    const wc = desktopView.webContents as { getURL: () => string; once: (ev: string, fn: () => void) => void };
    let committed = false;
    const loadListeners: Array<() => void> = [];
    wc.getURL = () => (committed ? 'https://example.test/loaded' : '');
    wc.once = (_ev: string, fn: () => void) => { loadListeners.push(fn); };

    host.tabs.set('tab-desktop', { state: { id: 'tab-desktop', splitMode: false, devicePresetId: 'phone-iphone15pro', zoomFactor: 1 }, view: desktopView });
    children.push(desktopView);

    host.applyTabDeviceEmulation(host.tabs.get('tab-desktop'), 400, 300, 74);
    await flushCdp();
    assert.strictEqual(cdpCalls.length, 0, 'no CDP command may reach a renderer-less view');
    assert.ok(loadListeners.length > 0, 'the override must be deferred to did-finish-load');

    committed = true;
    for (const fn of loadListeners) fn();
    await flushCdp();
    assert.ok(
      cdpCalls.some((c) => c.method === 'Emulation.setDeviceMetricsOverride'),
      'the deferred override must apply once the document commits'
    );
    assert.deepStrictEqual(nativeCalls, []);
  });

});
