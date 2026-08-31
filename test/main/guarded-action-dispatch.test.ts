import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { SemanticRefRegistry, makeTargetKey } from '../../src/main/browser/semantic-ref-registry';
import { SplitNavigationCoordinator } from '../../src/main/browser/split-review-coordinator';
import { AntiFanTab, SplitPaneId } from '../../src/shared/contracts';
import { RawElementDescriptor } from '../../src/main/browser/semantic-ref-types';
import { ISOLATED_AGENT_WORLD_ID } from '../../src/main/browser/semantic-ref-executor';

type TestHost = any;

function sampleDescriptor(id = 'btn-search'): RawElementDescriptor {
  return {
    path: [{ kind: 'dom', index: 0, tag: 'button' }],
    fingerprint: { tag: 'button', role: 'button', id },
    rect: { x: 10, y: 10, width: 100, height: 30, centerX: 60, centerY: 25 },
    label: 'Search',
    role: 'button',
    id,
  };
}

function createGuardedTestHost() {
  const host = Object.create(NativeTabHost.prototype) as TestHost;
  EventEmitter.call(host);

  const desktopIsolatedCalls: Array<{ worldId: number; code: string }> = [];
  const mobileIsolatedCalls: Array<{ worldId: number; code: string }> = [];
  const desktopExecutedScripts: string[] = [];
  const mobileExecutedScripts: string[] = [];

  const desktopMainFrame = {
    executeJavaScriptInIsolatedWorld: async (worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code || '';
      desktopIsolatedCalls.push({ worldId, code });
      return {
        ok: true,
        executed: true,
        rect: { x: 10, y: 10, width: 100, height: 30, centerX: 60, centerY: 25 },
      };
    },
  };

  const mobileMainFrame = {
    executeJavaScriptInIsolatedWorld: async (worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code || '';
      mobileIsolatedCalls.push({ worldId, code });
      return {
        ok: true,
        executed: true,
        rect: { x: 10, y: 10, width: 100, height: 30, centerX: 60, centerY: 25 },
      };
    },
  };

  const desktopWc: any = Object.assign(new EventEmitter(), {
    mainFrame: desktopMainFrame,
    isDestroyed: (): boolean => false,
    getUserAgent: (): string => '',
    getURL: (): string => 'https://example.com/shop',
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: (): boolean => true,
    canGoForward: (): boolean => false,
    executeJavaScript: async (code: string) => {
      desktopExecutedScripts.push(code);
      if (code.includes('__antifanAgentTrajectory')) {
        return { success: true, executedSteps: 2, totalSteps: 2 };
      }
      return true;
    },
    executeJavaScriptInIsolatedWorld: desktopMainFrame.executeJavaScriptInIsolatedWorld,
    destroy: () => {},
  });

  const mobileWc: any = Object.assign(new EventEmitter(), {
    mainFrame: mobileMainFrame,
    isDestroyed: (): boolean => false,
    getUserAgent: (): string => '',
    getURL: (): string => 'https://example.com/shop',
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: (): boolean => true,
    canGoForward: (): boolean => false,
    executeJavaScript: async (code: string) => {
      mobileExecutedScripts.push(code);
      if (code.includes('__antifanAgentTrajectory')) {
        return { success: true, executedSteps: 3, totalSteps: 3 };
      }
      return true;
    },
    executeJavaScriptInIsolatedWorld: mobileMainFrame.executeJavaScriptInIsolatedWorld,
    destroy: () => {},
  });

  const desktopView = { webContents: desktopWc, setBounds: () => {} };
  const mobileView = { webContents: mobileWc, setBounds: () => {} };

  const state: AntiFanTab = {
    id: 'tab-1',
    url: 'https://example.com/shop',
    title: 'Shop Home',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    devicePresetId: 'responsive',
  };

  host.activeTabId = 'tab-1';
  host.tabs = new Map([['tab-1', { state, view: desktopView, focusedPane: 'desktop' }]]);
  host.tabOrder = ['tab-1'];
  host.browserEpoch = 1;
  host.hostEpoch = 1;
  host.documentGenerations = new Map([['tab-1', 1]]);
  host.semanticDocumentGenerations = new Map();
  host.semanticRefRegistry = new SemanticRefRegistry();
  host.targetOperationQueues = new Map();
  host.splitCoordinator = new SplitNavigationCoordinator();
  host.agentWorkingTimers = new Map();
  host.agentWorkingRefs = new Map();
  host.broadcastState = () => {};
  host.ensureAgentBrowserInjected = async () => true;
  host.persistTabs = () => {};

  return {
    host,
    state,
    desktopWc,
    mobileWc,
    desktopView,
    mobileView,
    desktopIsolatedCalls,
    mobileIsolatedCalls,
    desktopExecutedScripts,
    mobileExecutedScripts,
  };
}

describe('Phase 3: Unified Guarded Agent Action Routing (World 1004 Isolated Executor)', () => {
  it('1. Valid ref: resolves, enters exact FIFO queue, and executes in isolated world 1004 with structured response', async () => {
    const { host, desktopIsolatedCalls } = createGuardedTestHost();
    const curGen = host.getSemanticDocumentGeneration('tab-1', 'desktop');

    const coll = host.semanticRefRegistry.beginCollection({
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
    });
    const snap = host.semanticRefRegistry.publishSnapshot({
      tabId: 'tab-1',
      paneId: 'desktop',
      nonce: coll.nonce,
      sequence: coll.sequence,
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
      rawDescriptors: [sampleDescriptor('btn-search')],
    });

    const ref = snap.refs[0]!;
    assert.strictEqual(ref, '@e1');

    const clicked = await host.agentClick({ ref, tabId: 'tab-1', paneId: 'desktop', trusted: false });
    assert.strictEqual(clicked, true, 'Valid ref action must resolve and return true');

    assert.strictEqual(desktopIsolatedCalls.length, 1, 'Must execute exactly 1 isolated world script');
    const call = desktopIsolatedCalls[0]!;
    assert.strictEqual(call.worldId, ISOLATED_AGENT_WORLD_ID, `Must execute in isolated world ${ISOLATED_AGENT_WORLD_ID}`);
    assert.ok(call.code.includes('resolveTraversalPath'), 'Must include path traversal logic');
    assert.ok(call.code.includes('btn-search'), 'Must check fingerprint id');
  });

  it('2. Ref action blocks concurrent collection until action completes (FIFO order via runTargetOperation)', async () => {
    const { host } = createGuardedTestHost();
    const eventOrder: string[] = [];

    const actionPromise = host.runTargetOperation('tab-1', 'desktop', async () => {
      eventOrder.push('action-start');
      await Promise.resolve();
      eventOrder.push('action-end');
      return true;
    });

    const collectionPromise = host.runTargetOperation('tab-1', 'desktop', async () => {
      eventOrder.push('collection-start');
      return true;
    });

    await Promise.all([actionPromise, collectionPromise]);
    assert.deepStrictEqual(eventOrder, ['action-start', 'action-end', 'collection-start'], 'Collection must wait for in-flight action');
  });

  it('3. Stale ref + valid selector fails closed without falling back to selector or triggering page events', async () => {
    const { host, desktopIsolatedCalls } = createGuardedTestHost();
    const curGen = host.getSemanticDocumentGeneration('tab-1', 'desktop');

    const coll = host.semanticRefRegistry.beginCollection({
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
    });
    const snap = host.semanticRefRegistry.publishSnapshot({
      tabId: 'tab-1',
      paneId: 'desktop',
      nonce: coll.nonce,
      sequence: coll.sequence,
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
      rawDescriptors: [sampleDescriptor('btn-1')],
    });
    const ref = snap.refs[0]!;

    // Invalidate target by bumping generation
    host.setSemanticDocumentGeneration('tab-1', 'desktop', curGen + 1);

    const initialCallCount = desktopIsolatedCalls.length;

    const result = await host.dispatchAgentAction('click', {
      ref,
      selector: 'button.checkout',
      tabId: 'tab-1',
      paneId: 'desktop',
    });

    assert.strictEqual(result.success, false, 'Stale ref must fail closed');
    assert.match(result.reason || '', /REF_STALE|REF_DOCUMENT_MUTATED|stale|mismatch/i);
    assert.strictEqual(desktopIsolatedCalls.length, initialCallCount, 'Must not execute any page scripts or fall back to selector');
  });

  it('4. Unknown ref + coordinates fails closed (REF_NOT_FOUND) without executing coordinate click', async () => {
    const { host, desktopIsolatedCalls } = createGuardedTestHost();
    const initialCallCount = desktopIsolatedCalls.length;

    const result = await host.dispatchAgentAction('click', {
      ref: '@e999',
      x: 100,
      y: 200,
      tabId: 'tab-1',
      paneId: 'desktop',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.reason || '', /not found|REF_NOT_FOUND|unknown/i);
    assert.strictEqual(desktopIsolatedCalls.length, initialCallCount, 'Must not execute coordinate click on unknown ref');
  });

  it('5. Explicit selector-only and coordinate-only modes execute in isolated world 1004', async () => {
    const { host, desktopIsolatedCalls } = createGuardedTestHost();

    const selRes = await host.dispatchAgentAction('click', {
      selector: 'button.add-to-cart',
      tabId: 'tab-1',
      paneId: 'desktop',
    });
    assert.strictEqual(selRes.success, true);
    assert.ok(desktopIsolatedCalls[desktopIsolatedCalls.length - 1]?.code.includes('button.add-to-cart'));
    assert.strictEqual(desktopIsolatedCalls[desktopIsolatedCalls.length - 1]?.worldId, ISOLATED_AGENT_WORLD_ID);

    const coordRes = await host.dispatchAgentAction('click', {
      x: 150,
      y: 350,
      label: 'Coords Click',
      tabId: 'tab-1',
      paneId: 'desktop',
    });
    assert.strictEqual(coordRes.success, true);
    assert.ok(desktopIsolatedCalls[desktopIsolatedCalls.length - 1]?.code.includes('150'));
  });

  it('6. Omitted pane normalizes to concrete focused pane and remains stable even if focus changes later', async () => {
    const { host, mobileIsolatedCalls, mobileView } = createGuardedTestHost();
    const curTab = host.tabs.get('tab-1');
    curTab.mobileView = mobileView;
    curTab.state.splitMode = true;
    curTab.focusedPane = 'mobile';

    const curGen = host.getSemanticDocumentGeneration('tab-1', 'mobile');
    const coll = host.semanticRefRegistry.beginCollection({
      tabId: 'tab-1',
      paneId: 'mobile',
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
    });
    const snap = host.semanticRefRegistry.publishSnapshot({
      tabId: 'tab-1',
      paneId: 'mobile',
      nonce: coll.nonce,
      sequence: coll.sequence,
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
      rawDescriptors: [sampleDescriptor('mobile-btn')],
    });
    const ref = snap.refs[0]!;

    // Action dispatched without explicit paneId
    const actionPromise = host.agentClick({ ref, tabId: 'tab-1', trusted: false });

    // Switch focus concurrently
    curTab.focusedPane = 'desktop';

    const res = await actionPromise;
    assert.strictEqual(res, true);
    assert.strictEqual(mobileIsolatedCalls.length, 1, 'Action must execute on mobile pane despite subsequent desktop focus');
    assert.strictEqual(mobileIsolatedCalls[0]?.worldId, ISOLATED_AGENT_WORLD_ID);
  });

  it('7. Navigation during preflight fails closed with safe reason without side effects', async () => {
    const { host } = createGuardedTestHost();
    const curGen = host.getSemanticDocumentGeneration('tab-1', 'desktop');

    const coll = host.semanticRefRegistry.beginCollection({
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
    });
    const snap = host.semanticRefRegistry.publishSnapshot({
      tabId: 'tab-1',
      paneId: 'desktop',
      nonce: coll.nonce,
      sequence: coll.sequence,
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
      rawDescriptors: [sampleDescriptor('btn-1')],
    });
    const ref = snap.refs[0]!;

    // Invalidate document generation before execution runs
    host.setSemanticDocumentGeneration('tab-1', 'desktop', curGen + 1);

    const res = await host.dispatchAgentAction('click', { ref, tabId: 'tab-1', paneId: 'desktop' });
    assert.strictEqual(res.success, false);
    assert.match(res.reason || '', /preflight|navigated|stale|mismatch/i);
  });

  it('8. Detached / destroyed WebContents returns safe failure instead of throwing unhandled error', async () => {
    const { host, desktopWc } = createGuardedTestHost();
    desktopWc.isDestroyed = () => true;

    const res = await host.dispatchAgentAction('click', { selector: '#btn', tabId: 'tab-1', paneId: 'desktop' });
    assert.strictEqual(res.success, false);
    assert.match(res.reason || '', /destroyed/i);
  });

  it('9. Document navigation during action execution fails closed with safe reason', async () => {
    const { host, desktopWc } = createGuardedTestHost();
    const curGen = host.getSemanticDocumentGeneration('tab-1', 'desktop');

    const coll = host.semanticRefRegistry.beginCollection({
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
    });
    const snap = host.semanticRefRegistry.publishSnapshot({
      tabId: 'tab-1',
      paneId: 'desktop',
      nonce: coll.nonce,
      sequence: coll.sequence,
      browserEpoch: host.getBrowserEpoch(),
      documentGeneration: curGen,
      documentUrl: 'https://example.com/shop',
      rawDescriptors: [sampleDescriptor('btn-1')],
    });
    const ref = snap.refs[0]!;

    desktopWc.mainFrame.executeJavaScriptInIsolatedWorld = async (): Promise<any> => {
      // Simulate navigation mid-action
      host.setSemanticDocumentGeneration('tab-1', 'desktop', curGen + 1);
      return { ok: true, executed: true, rect: { x: 10, y: 10, width: 100, height: 30, centerX: 60, centerY: 25 } };
    };

    const res = await host.dispatchAgentAction('click', { ref, tabId: 'tab-1', paneId: 'desktop' });
    assert.strictEqual(res.success, false);
    assert.match(res.reason || '', /navigated/i);
  });

  it('10. Trajectory executes sequential steps with expected return format', async () => {
    const { host } = createGuardedTestHost();
    const res = await host.dispatchAgentAction('trajectory', {
      tabId: 'tab-1',
      paneId: 'desktop',
      steps: [
        { action: 'move', x: 10, y: 20 },
        { action: 'click', selector: 'button.checkout' },
      ],
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.data);
  });

  it('11. Agent working indicator activates during action and clears on completion', async () => {
    const { host } = createGuardedTestHost();
    let broadcastWorkingState: string | undefined;
    host.broadcastState = () => {
      broadcastWorkingState = host.tabs.get('tab-1')?.state?.aiState;
    };

    const actionPromise = host.dispatchAgentAction('click', { selector: '#btn', tabId: 'tab-1' });
    assert.strictEqual(host.tabs.get('tab-1')?.state?.aiState, 'agent_working');

    await actionPromise;
    assert.strictEqual(host.tabs.get('tab-1')?.state?.aiState, 'idle');
  });

  it('12. Host wrapper methods delegate to dispatchAgentAction properly', async () => {
    const { host } = createGuardedTestHost();
    assert.strictEqual(await host.agentClick({ selector: '#btn', tabId: 'tab-1' }), true);
    assert.strictEqual(await host.agentType({ selector: '#input', text: 'hello', tabId: 'tab-1' }), true);
    assert.strictEqual(await host.agentHover({ selector: '#btn', tabId: 'tab-1' }), true);
    assert.strictEqual(await host.agentMove({ selector: '#btn', tabId: 'tab-1' }), true);
    assert.strictEqual(await host.agentScroll({ deltaY: 200, tabId: 'tab-1' }), true);
    assert.strictEqual(await host.agentHighlight({ selector: 'div.banner', label: 'Promo', tabId: 'tab-1' }), true);
    assert.strictEqual(await host.agentClear('tab-1'), true);
  });

  it('13. Fails closed with CAPABILITY_NOT_FOUND if isolated world execution is not supported', async () => {
    const { host, desktopWc } = createGuardedTestHost();
    desktopWc.mainFrame = null;
    desktopWc.executeJavaScriptInIsolatedWorld = undefined;

    const res = await host.dispatchAgentAction('click', { selector: '#btn', tabId: 'tab-1', paneId: 'desktop' });
    assert.strictEqual(res.success, false);
    assert.match(res.reason || '', /CAPABILITY_NOT_FOUND|Isolated world execution.*not supported/i);
  });
  it('14. Trajectory via dispatchAgentAction routes through real runTargetOperation queue and settles strictly in FIFO order', { timeout: 3000 }, async () => {
    const { host, desktopWc } = createGuardedTestHost();
    const executionOrder: string[] = [];

    // 1. Enqueue a prior long-running operation in runTargetOperation
    let unlockPriorOp: () => void = () => {};
    const priorOpPromise = new Promise<void>((resolve) => {
      unlockPriorOp = resolve;
    });

    const priorTask = host.runTargetOperation('tab-1', 'desktop', async () => {
      executionOrder.push('prior_start');
      await priorOpPromise;
      executionOrder.push('prior_done');
      return 'prior_result';
    });

    // Yield to allow priorTask to enter execution and push 'prior_start'
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 2. Mock trajectory execution to track execution order
    desktopWc.executeJavaScript = async (code: string) => {
      if (code.includes('window.__antifanAgentTrajectory(')) {
        executionOrder.push('trajectory_executed');
        return { success: true, executedSteps: 2, totalSteps: 2 };
      }
      return true;
    };

    // 3. Dispatch trajectory while prior operation is still in-flight
    const trajectoryPromise = host.dispatchAgentAction('trajectory', {
      tabId: 'tab-1',
      paneId: 'desktop',
      steps: [
        { action: 'move', x: 10, y: 20 },
        { action: 'click', selector: 'button.checkout' },
      ],
    });

    // Yield microtask to ensure trajectory promise is enqueued in runTargetOperation
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Verify trajectory has NOT executed yet because prior operation is in-flight
    assert.deepStrictEqual(executionOrder, ['prior_start'], 'Trajectory must wait in FIFO queue');

    // 4. Release prior operation
    unlockPriorOp();
    await priorTask;

    // 5. Await trajectory result bounded by hard Promise.race deadlock timeout
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Queue deadlock: trajectoryPromise failed to settle within 2000ms')), 2000);
      timer.unref?.();
    });

    const trajRes = await Promise.race([trajectoryPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    assert.strictEqual(trajRes.success, true, 'Trajectory must succeed');
    assert.deepStrictEqual(
      executionOrder,
      ['prior_start', 'prior_done', 'trajectory_executed'],
      'Execution order must be strictly FIFO'
    );
  });
});
