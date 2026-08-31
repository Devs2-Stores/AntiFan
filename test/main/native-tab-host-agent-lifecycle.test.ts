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
      if (code.includes('click') || code.includes('__antifanAgentClick')) {
        return new Promise<boolean>((resolve) => pending.push(() => resolve(true)));
      }
      return Promise.resolve(true);
    });
    const first = host.agentClick({ x: 10, y: 20 });
    const second = host.agentClick({ x: 30, y: 40 });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(host.agentWorkingRefs.get('tab-1'), 2);
    assert.strictEqual(state.aiState, 'agent_working');

    pending[0]!();
    assert.strictEqual(await first, true);
    assert.strictEqual(host.agentWorkingRefs.get('tab-1'), 1);
    assert.strictEqual(state.aiState, 'agent_working');

    pending[1]!();
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
