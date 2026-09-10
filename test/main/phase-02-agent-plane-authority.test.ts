import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost, NativeTabRecord } from '../../src/main/browser/native-tab-host';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { CapabilityError, BrowserTarget, ExecutionAttachmentRecord } from '../../src/shared/control-plane-contracts';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { AntiFanTab, SplitPaneId } from '../../src/shared/contracts';

interface MockWebContents {
  isDestroyed: () => boolean;
  sendInputEvent: (event: unknown) => void;
  setBackgroundThrottling: (throttling: boolean) => void;
  capturePage: (rect?: unknown) => Promise<{
    isEmpty: () => boolean;
    toPNG: () => { toString: (fmt: string) => string; length?: number };
    toJPEG: (quality?: number) => { toString: (fmt: string) => string; length?: number };
  }>;
  executeJavaScript: (script: string, ...args: unknown[]) => Promise<unknown>;
}

interface MockTabRecord {
  state: AntiFanTab;
  focusedPane: SplitPaneId;
  view: { webContents: MockWebContents };
  mobileView?: { webContents: MockWebContents };
}

interface TestTabHost {
  tabs: Map<string, MockTabRecord>;
  tabOrder: string[];
  activeTabId?: string;
  automationTabId?: string;
  terminalAgentAffinity: Map<string, unknown>;
  sessionTabPools: Map<string, Set<string>>;
  isDisposed: boolean;
  withTabAgentWorking: (_tabId: string, action: () => Promise<unknown>) => Promise<unknown>;
  syncWithAgentInput: <T>(action: () => T) => T;
  broadcastState: () => void;
  bindTerminalAgentAffinity(terminalId: string, generation: number | string | undefined, tabId: string): boolean;
  isTerminalAllowedForTab(tabId: string, terminalId: string): boolean;
  assertTerminalAccess(tabId: string, terminalId: string): void;
  terminalWrite(tabId: string, input: string, terminalId?: string): boolean;
  sendKeyboardPress(params: { key: string; modifiers?: string[]; tabId?: string }): Promise<{ success: boolean; key: string; modifiers: string[]; error?: string }>;
  applyTabThrottling(): void;
}

type TerminalManagerInternal = {
  sessions: Map<string, { id: string; sessionGeneration: number }>;
  writeTo: (id: string, input: string) => void;
};

function createMockWebContents(): MockWebContents & {
  inputEvents: unknown[];
  throttlingHistory: boolean[];
  capturePageCalls: number;
} {
  const inputEvents: unknown[] = [];
  const throttlingHistory: boolean[] = [];
  let capturePageCalls = 0;

  return {
    inputEvents,
    throttlingHistory,
    get capturePageCalls() {
      return capturePageCalls;
    },
    isDestroyed: () => false,
    sendInputEvent: (evt: unknown) => {
      inputEvents.push(evt);
    },
    setBackgroundThrottling: (throttling: boolean) => {
      throttlingHistory.push(throttling);
    },
    capturePage: async () => {
      capturePageCalls++;
      return {
        isEmpty: () => false,
        toPNG: () => ({
          toString: (_fmt: string) => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          length: 68,
        }),
        toJPEG: (_quality?: number) => ({
          toString: (_fmt: string) => '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...',
          length: 40,
        }),
      };
    },
    executeJavaScript: async () => undefined,
  };
}

function createMockTabHost(): TestTabHost {
  const host = Object.create(NativeTabHost.prototype) as unknown as TestTabHost;
  host.tabs = new Map<string, MockTabRecord>();
  host.tabOrder = [];
  host.activeTabId = undefined;
  host.automationTabId = undefined;
  host.terminalAgentAffinity = new Map();
  host.sessionTabPools = new Map();
  host.isDisposed = false;
  host.withTabAgentWorking = async (_tabId: string, action: () => Promise<unknown>) => action();
  host.syncWithAgentInput = <T>(action: () => T): T => action();
  host.broadcastState = () => {};
  return host;
}

describe('Phase 2 Agent-Plane Authority Contract Regressions', () => {
  let terminalManager: TerminalManager;
  let originalWriteTo: ((id: string, input: string) => void) | undefined;
  let writesIntercepted: Array<{ id: string; input: string }>;

  beforeEach(() => {
    terminalManager = TerminalManager.getInstance();
    writesIntercepted = [];
    const tmInternal = terminalManager as unknown as TerminalManagerInternal;
    originalWriteTo = tmInternal.writeTo?.bind(terminalManager);
    tmInternal.writeTo = (id: string, input: string) => {
      writesIntercepted.push({ id, input });
    };
  });

  afterEach(() => {
    const tmInternal = terminalManager as unknown as TerminalManagerInternal;
    if (originalWriteTo) {
      tmInternal.writeTo = originalWriteTo;
    }
    tmInternal.sessions?.clear();
  });

  // =========================================================================
  // 1. TERMINAL_FORBIDDEN CONTRACT
  // =========================================================================
  describe('1. Terminal Authority (TERMINAL_FORBIDDEN)', () => {
    it('isTerminalAllowedForTab returns true only for owned terminal and false for foreign or user terminal', () => {
      const host = createMockTabHost();
      const tabA: MockTabRecord = {
        state: { id: 'tab-agent-a', url: 'about:blank', title: 'Agent A', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', ephemeral: true, offscreen: true },
        focusedPane: 'desktop',
        view: { webContents: createMockWebContents() },
      };
      const tabB: MockTabRecord = {
        state: { id: 'tab-agent-b', url: 'about:blank', title: 'Agent B', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', ephemeral: true, offscreen: true },
        focusedPane: 'desktop',
        view: { webContents: createMockWebContents() },
      };
      host.tabs.set('tab-agent-a', tabA);
      host.tabs.set('tab-agent-b', tabB);

      const tmInternal = terminalManager as unknown as TerminalManagerInternal;
      tmInternal.sessions.set('term-agent-a', { id: 'term-agent-a', sessionGeneration: 1 });
      tmInternal.sessions.set('term-agent-b', { id: 'term-agent-b', sessionGeneration: 1 });
      tmInternal.sessions.set('term-user', { id: 'term-user', sessionGeneration: 1 });

      // Bind affinity: term-agent-a belongs to tab-agent-a; term-agent-b belongs to tab-agent-b; term-user has NO affinity
      host.bindTerminalAgentAffinity('term-agent-a', 1, 'tab-agent-a');
      host.bindTerminalAgentAffinity('term-agent-b', 1, 'tab-agent-b');

      // Tab A should own term-agent-a
      assert.strictEqual(host.isTerminalAllowedForTab('tab-agent-a', 'term-agent-a'), true);

      // Tab A must NOT be allowed to operate Tab B's terminal (foreign terminal)
      assert.strictEqual(host.isTerminalAllowedForTab('tab-agent-a', 'term-agent-b'), false);

      // Tab A must NOT be allowed to operate a user terminal (unaffiliated)
      assert.strictEqual(host.isTerminalAllowedForTab('tab-agent-a', 'term-user'), false);

      // Tab B must NOT be allowed to operate Tab A's terminal
      assert.strictEqual(host.isTerminalAllowedForTab('tab-agent-b', 'term-agent-a'), false);
    });

    it('assertTerminalAccess rejects foreign or user terminal with CapabilityError code TERMINAL_FORBIDDEN', () => {
      const host = createMockTabHost();
      const tabA: MockTabRecord = {
        state: { id: 'tab-agent-a', url: 'about:blank', title: 'Agent A', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive' },
        focusedPane: 'desktop',
        view: { webContents: createMockWebContents() },
      };
      host.tabs.set('tab-agent-a', tabA);

      const tmInternal = terminalManager as unknown as TerminalManagerInternal;
      tmInternal.sessions.set('term-agent-a', { id: 'term-agent-a', sessionGeneration: 1 });
      tmInternal.sessions.set('term-foreign', { id: 'term-foreign', sessionGeneration: 1 });
      tmInternal.sessions.set('term-user', { id: 'term-user', sessionGeneration: 1 });

      host.bindTerminalAgentAffinity('term-agent-a', 1, 'tab-agent-a');

      // Owned terminal access succeeds
      assert.doesNotThrow(() => {
        host.assertTerminalAccess('tab-agent-a', 'term-agent-a');
      });

      // Foreign terminal access throws TERMINAL_FORBIDDEN CapabilityError
      assert.throws(
        () => host.assertTerminalAccess('tab-agent-a', 'term-foreign'),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError, 'Error must be an instance of CapabilityError');
          assert.strictEqual((err as CapabilityError).code, 'TERMINAL_FORBIDDEN');
          return true;
        }
      );

      // User terminal access throws TERMINAL_FORBIDDEN CapabilityError
      assert.throws(
        () => host.assertTerminalAccess('tab-agent-a', 'term-user'),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError, 'Error must be an instance of CapabilityError');
          assert.strictEqual((err as CapabilityError).code, 'TERMINAL_FORBIDDEN');
          return true;
        }
      );
    });

    it('terminalWrite rejects unauthorized write BEFORE emitting any input', () => {
      const host = createMockTabHost();
      const tabA: MockTabRecord = {
        state: { id: 'tab-agent-a', url: 'about:blank', title: 'Agent A', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive' },
        focusedPane: 'desktop',
        view: { webContents: createMockWebContents() },
      };
      const tabB: MockTabRecord = {
        state: { id: 'tab-agent-b', url: 'about:blank', title: 'Agent B', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive' },
        focusedPane: 'desktop',
        view: { webContents: createMockWebContents() },
      };
      host.tabs.set('tab-agent-a', tabA);
      host.tabs.set('tab-agent-b', tabB);

      const tmInternal = terminalManager as unknown as TerminalManagerInternal;
      tmInternal.sessions.set('term-agent-a', { id: 'term-agent-a', sessionGeneration: 1 });
      tmInternal.sessions.set('term-agent-b', { id: 'term-agent-b', sessionGeneration: 1 });
      tmInternal.sessions.set('term-user', { id: 'term-user', sessionGeneration: 1 });

      host.bindTerminalAgentAffinity('term-agent-a', 1, 'tab-agent-a');
      host.bindTerminalAgentAffinity('term-agent-b', 1, 'tab-agent-b');

      // Attempt 1: Agent A writing to foreign terminal B
      assert.throws(
        () => host.terminalWrite('tab-agent-a', 'malicious-command\n', 'term-agent-b'),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual((err as CapabilityError).code, 'TERMINAL_FORBIDDEN');
          return true;
        }
      );
      assert.strictEqual(writesIntercepted.length, 0, 'No input must be emitted on foreign terminal rejection');

      // Attempt 2: Agent A writing to user terminal
      assert.throws(
        () => host.terminalWrite('tab-agent-a', 'user-hijack\n', 'term-user'),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual((err as CapabilityError).code, 'TERMINAL_FORBIDDEN');
          return true;
        }
      );
      assert.strictEqual(writesIntercepted.length, 0, 'No input must be emitted on user terminal rejection');

      // Attempt 3: Authorized write on owned terminal succeeds and emits input
      const writeResult = host.terminalWrite('tab-agent-a', 'echo hello\n', 'term-agent-a');
      assert.strictEqual(writeResult, true);
      assert.strictEqual(writesIntercepted.length, 1);
      assert.deepStrictEqual(writesIntercepted[0], { id: 'term-agent-a', input: 'echo hello\n' });
    });
  });

  // =========================================================================
  // 2. KEYBOARD TARGET CONTRACT
  // =========================================================================
  describe('2. Keyboard Target Authority (KEYBOARD TARGET)', () => {
    it('NativeTabHost.sendKeyboardPress with no tabId and no automationTabId throws TARGET_REQUIRED and never touches foreground active tab', async () => {
      const host = createMockTabHost();
      const userWc = createMockWebContents();
      const userTab: MockTabRecord = {
        state: { id: 'tab-user-active', url: 'https://example.com/user', title: 'User Working Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive' },
        focusedPane: 'desktop',
        view: { webContents: userWc },
      };
      host.tabs.set('tab-user-active', userTab);
      host.activeTabId = 'tab-user-active';
      host.automationTabId = undefined; // No dedicated automation tab

      // Calling sendKeyboardPress without tabId must reject with TARGET_REQUIRED
      await assert.rejects(
        async () => {
          await host.sendKeyboardPress({ key: 'Enter' });
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError, 'Expected err to be CapabilityError');
          assert.strictEqual((err as CapabilityError).code, 'TARGET_REQUIRED');
          return true;
        }
      );

      // Verify fail-closed invariant: Active user tab received zero input events
      assert.strictEqual(userWc.inputEvents.length, 0, 'Active user tab must never receive input when agent target is missing');
    });

    it('NativeTabHost.sendKeyboardPress with explicit agent tabId dispatches only to that tab', async () => {
      const host = createMockTabHost();
      const userWc = createMockWebContents();
      const agentWc = createMockWebContents();

      const userTab: MockTabRecord = {
        state: { id: 'tab-user-active', url: 'https://example.com/user', title: 'User Working Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive' },
        focusedPane: 'desktop',
        view: { webContents: userWc },
      };
      const agentTab: MockTabRecord = {
        state: { id: 'tab-agent-offscreen', url: 'https://example.com/agent', title: 'Agent Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', ephemeral: true, offscreen: true },
        focusedPane: 'desktop',
        view: { webContents: agentWc },
      };

      host.tabs.set('tab-user-active', userTab);
      host.tabs.set('tab-agent-offscreen', agentTab);
      host.activeTabId = 'tab-user-active';

      const result = await host.sendKeyboardPress({
        key: 'a',
        modifiers: ['shift'],
        tabId: 'tab-agent-offscreen',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.key, 'a');

      // Verify agent tab received events and user tab received none
      assert.ok(agentWc.inputEvents.length > 0, 'Agent tab must receive input events');
      assert.strictEqual(userWc.inputEvents.length, 0, 'User tab must receive zero input events');
    });

    it('NativeTabHost.sendKeyboardPress with destroyed or non-existent tabId throws TARGET_STALE', async () => {
      const host = createMockTabHost();
      await assert.rejects(
        async () => {
          await host.sendKeyboardPress({ key: 'Escape', tabId: 'tab-non-existent' });
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual((err as CapabilityError).code, 'TARGET_STALE');
          return true;
        }
      );
    });

    it('BrowserControlPort.keyboardPress without tabId and without target throws TARGET_REQUIRED and refuses active tab fallback', async () => {
      let hostDispatchedParams: unknown = null;
      const mockHost: BrowserHostPort = {
        getTabList: () => [{ id: 'tab-user-active', url: 'https://example.com' }],
        getActiveTabId: () => 'tab-user-active',
        // Neither getAutomationTabId nor createTab is provided
        navigate: async () => true,
        reload: async () => true,
        getDom: async () => '<html></html>',
        captureScreenshot: async () => '',
        evalJs: async () => null,
        sendKeyboardPress: async (params) => {
          hostDispatchedParams = params;
          return { success: true, key: params.key, modifiers: params.modifiers || [] };
        },
      };

      const port = new BrowserControlPort(mockHost);

      // Call keyboardPress without tabId and without target
      await assert.rejects(
        async () => {
          await port.keyboardPress({ key: 'Enter' });
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError, 'Expected CapabilityError');
          assert.strictEqual((err as CapabilityError).code, 'TARGET_REQUIRED');
          return true;
        }
      );

      // Assert that sendKeyboardPress was NEVER dispatched to the host with the active tab
      assert.strictEqual(hostDispatchedParams, null, 'Host sendKeyboardPress must not be called with active tab');
    });

    it('BrowserControlPort.keyboardPress with bound BrowserTarget dispatches to target tabId', async () => {
      let hostDispatchedParams: { key: string; modifiers?: string[]; tabId?: string } | null = null;
      const mockHost: BrowserHostPort = {
        getTabList: () => [
          { id: 'tab-user-active', url: 'https://example.com' },
          { id: 'tab-agent-target', url: 'https://example.com/target' },
        ],
        getActiveTabId: () => 'tab-user-active',
        navigate: async () => true,
        reload: async () => true,
        getDom: async () => '<html></html>',
        captureScreenshot: async () => '',
        evalJs: async () => null,
        sendKeyboardPress: async (params) => {
          hostDispatchedParams = params;
          return { success: true, key: params.key, modifiers: params.modifiers || [] };
        },
      };

      const port = new BrowserControlPort(mockHost);
      const target: BrowserTarget = {
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        runtimeId: 'rt-1',
        tabId: 'tab-agent-target',
        browserEpoch: 1,
        documentGeneration: 1,
      };

      const res = await port.keyboardPress({ key: 'Tab', modifiers: ['shift'] }, target);
      assert.strictEqual(res.success, true);
      assert.ok((hostDispatchedParams as unknown) !== null);
      const dispatched = hostDispatchedParams as unknown as { key: string; modifiers?: string[]; tabId?: string };
      assert.strictEqual(dispatched.tabId, 'tab-agent-target');
      assert.strictEqual(dispatched.key, 'Tab');
    });
  });

  // =========================================================================
  // 3. OFFSCREEN CAPTURE PRESERVATION CONTRACT
  // =========================================================================
  describe('3. Offscreen Capture Preservation', () => {
    it('NativeTabHost.applyTabThrottling keeps backgroundThrottling disabled for offscreen agent tabs', () => {
      const host = createMockTabHost();

      const userFgWc = createMockWebContents();
      const userBgWc = createMockWebContents();
      const offscreenAgentWc = createMockWebContents();

      const userFgTab: MockTabRecord = {
        state: { id: 'tab-user-fg', url: 'https://example.com/fg', title: 'Foreground User Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: false },
        focusedPane: 'desktop',
        view: { webContents: userFgWc },
      };
      const userBgTab: MockTabRecord = {
        state: { id: 'tab-user-bg', url: 'https://example.com/bg', title: 'Background User Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: false },
        focusedPane: 'desktop',
        view: { webContents: userBgWc },
      };
      const offscreenAgentTab: MockTabRecord = {
        state: { id: 'tab-agent-offscreen', url: 'https://example.com/agent', title: 'Offscreen Agent Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: true, ephemeral: true },
        focusedPane: 'desktop',
        view: { webContents: offscreenAgentWc },
      };

      host.tabs.set('tab-user-fg', userFgTab);
      host.tabs.set('tab-user-bg', userBgTab);
      host.tabs.set('tab-agent-offscreen', offscreenAgentTab);
      host.activeTabId = 'tab-user-fg';

      // Run applyTabThrottling
      host.applyTabThrottling();

      // 1. Foreground tab: unthrottled (false)
      assert.strictEqual(userFgWc.throttlingHistory[userFgWc.throttlingHistory.length - 1], false, 'Foreground tab should have backgroundThrottling: false');

      // 2. Background user tab: throttled (true)
      assert.strictEqual(userBgWc.throttlingHistory[userBgWc.throttlingHistory.length - 1], true, 'Background user tab should have backgroundThrottling: true');

      // 3. Offscreen agent tab: MUST keep backgroundThrottling disabled (false)
      assert.strictEqual(offscreenAgentWc.throttlingHistory[offscreenAgentWc.throttlingHistory.length - 1], false, 'Offscreen agent tab must have backgroundThrottling: false');
      assert.ok(
        !offscreenAgentWc.throttlingHistory.includes(true),
        'Offscreen agent tab must NEVER have backgroundThrottling set to true'
      );
    });

    it('TabDevToolsHost.captureScreenshot for offscreen agent tab captures directly without switchTab or foreground swap', async () => {
      const tabs = new Map<string, MockTabRecord>();
      let switchTabCount = 0;
      let activeTabId = 'tab-user-active';

      const userWc = createMockWebContents();
      const agentWc = createMockWebContents();

      tabs.set('tab-user-active', {
        state: { id: 'tab-user-active', url: 'https://example.com/user', title: 'User Working Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: false },
        focusedPane: 'desktop',
        view: { webContents: userWc },
      });

      tabs.set('tab-agent-offscreen', {
        state: { id: 'tab-agent-offscreen', url: 'https://example.com/agent', title: 'Agent Offscreen Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: true, ephemeral: true },
        focusedPane: 'desktop',
        view: { webContents: agentWc },
      });

      const ctx: TabDevToolsContext = {
        getTabWebContents: (tabId) => tabs.get(tabId || '')?.view.webContents as unknown as Electron.WebContents,
        getTabRecord: (tabId) => tabs.get(tabId) as unknown as NativeTabRecord | undefined,
        getActiveTabId: () => activeTabId,
        getAllTabs: () => tabs.entries() as unknown as IterableIterator<[string, NativeTabRecord]>,
        broadcastState: () => {},
        getTabTerminalSession: () => undefined,
        resolveTargetWorkspace: () => 'E:/Work/project',
        resolveAnnotationWorkspace: () => 'E:/Work/project',
        createTab: () => 'tab-created',
        withTabAgentWorking: async (_tabId, action) => action(),
        switchTab: (id) => {
          if (id === 'tab-agent-offscreen') {
            switchTabCount++;
            activeTabId = id;
          }
          return true;
        },
      };

      const devTools = new TabDevToolsHost(ctx);

      // Capture screenshot of offscreen tab
      const screenshotBase64 = await devTools.captureScreenshot(undefined, 'tab-agent-offscreen');

      // Verify offscreen preservation:
      // 1. switchTab was NEVER called
      assert.strictEqual(switchTabCount, 0, 'switchTab must NEVER be called when capturing an offscreen agent tab');
      // 2. Active tab remained unchanged
      assert.strictEqual(activeTabId, 'tab-user-active', 'Active tab must remain on the user tab');
      // 3. capturePage was invoked directly on the offscreen webContents
      assert.strictEqual(agentWc.capturePageCalls, 1, 'capturePage must be invoked directly on offscreen WebContents');
      // 4. Returns non-empty base64 string
      assert.ok(screenshotBase64.length > 0, 'Screenshot base64 payload must be non-empty');
      assert.ok(screenshotBase64.startsWith('iVBOR'), 'Screenshot payload should be valid base64 PNG data');
    });

    it('TabDevToolsHost.captureScreenshot for regular background tab does invoke switchTab', async () => {
      const tabs = new Map<string, MockTabRecord>();
      let switchTabCount = 0;
      let activeTabId = 'tab-user-active';

      const userWc = createMockWebContents();
      const bgUserWc = createMockWebContents();

      tabs.set('tab-user-active', {
        state: { id: 'tab-user-active', url: 'https://example.com/user', title: 'User Working Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: false },
        focusedPane: 'desktop',
        view: { webContents: userWc },
      });

      tabs.set('tab-user-bg', {
        state: { id: 'tab-user-bg', url: 'https://example.com/bg', title: 'Background User Tab', isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive', offscreen: false },
        focusedPane: 'desktop',
        view: { webContents: bgUserWc },
      });

      const ctx: TabDevToolsContext = {
        getTabWebContents: (tabId) => tabs.get(tabId || '')?.view.webContents as unknown as Electron.WebContents,
        getTabRecord: (tabId) => tabs.get(tabId) as unknown as NativeTabRecord | undefined,
        getActiveTabId: () => activeTabId,
        getAllTabs: () => tabs.entries() as unknown as IterableIterator<[string, NativeTabRecord]>,
        broadcastState: () => {},
        getTabTerminalSession: () => undefined,
        resolveTargetWorkspace: () => 'E:/Work/project',
        resolveAnnotationWorkspace: () => 'E:/Work/project',
        createTab: () => 'tab-created',
        withTabAgentWorking: async (_tabId, action) => action(),
        switchTab: (id) => {
          if (id === 'tab-user-bg') {
            switchTabCount++;
            activeTabId = id;
          }
          return true;
        },
      };

      const devTools = new TabDevToolsHost(ctx);

      // Capture screenshot of regular background tab
      await devTools.captureScreenshot(undefined, 'tab-user-bg');

      // For normal non-offscreen tabs, switchTab IS called to bring the surface forward on Windows
      assert.strictEqual(switchTabCount, 1, 'Regular background tab must invoke switchTab for Windows surface capture');
      assert.strictEqual(activeTabId, 'tab-user-bg');
    });

    it('skips live Electron window HW composited validation (covered by Phase 6 Windows runtime certification)', (t) => {
      t.skip(
        'Skipped: Full live Electron GPU composited window capture and offscreen pixel rendering is covered by Phase 6 Windows runtime certification'
      );
    });
  });

  // =========================================================================
  // 4. ACTIVATION AUTHORITY (USER_VISIBLE_OPERATION_FORBIDDEN)
  // =========================================================================
  describe('4. Activation Authority', () => {
    function createSwitchHost() {
      let switchedTo: string | null = null;
      let switchCalls = 0;
      const mockHost: BrowserHostPort = {
        getTabList: () => [
          { id: 'tab-user-active', url: 'https://example.com/user', title: 'User Tab' },
          { id: 'tab-agent-offscreen', url: 'https://example.com/agent', title: 'Agent Tab' },
        ],
        hasTab: (tabId) => tabId === 'tab-user-active' || tabId === 'tab-agent-offscreen',
        getActiveTabId: () => 'tab-user-active',
        isTabOffscreen: (tabId) => tabId === 'tab-agent-offscreen',
        isTabEphemeral: (tabId) => tabId === 'tab-agent-offscreen',
        switchTab: (tabId) => {
          switchCalls++;
          switchedTo = tabId;
          return true;
        },
        isCurrentTarget: () => true,
        navigate: async () => true,
        reload: async () => true,
        getDom: async () => '<html></html>',
        captureScreenshot: async () => '',
        evalJs: async () => null,
      };
      const port = new BrowserControlPort(mockHost);
      return { mockHost, port, readState: () => ({ switchedTo, switchCalls }) };
    }

    it('agent attachment may activate a user-visible foreground tab (owner decision: no activation gate)', () => {
      const { port, readState } = createSwitchHost();
      const target: BrowserTarget = {
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        runtimeId: 'rt-1',
        tabId: 'tab-agent-offscreen',
        browserEpoch: 1,
        documentGeneration: 1,
      };
      const res = port.switchTab('tab-user-active', {
        target,
        attachmentId: 'attachment-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        isAgent: true,
        plane: 'agent',
      });
      assert.strictEqual(res.switched, true);
      assert.strictEqual(res.tabId, 'tab-user-active');
      const { switchCalls, switchedTo } = readState();
      assert.strictEqual(switchCalls, 1, 'the switch must reach the host exactly once');
      assert.strictEqual(switchedTo, 'tab-user-active', 'the user-visible tab becomes the active tab');
    });

    it('agent attachment may switch only to its own agent-owned (offscreen/ephemeral) tab', () => {
      const { port, readState } = createSwitchHost();
      const target: BrowserTarget = {
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        runtimeId: 'rt-1',
        tabId: 'tab-agent-offscreen',
        browserEpoch: 1,
        documentGeneration: 1,
      };
      const res = port.switchTab('tab-agent-offscreen', {
        target,
        attachmentId: 'attachment-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        isAgent: true,
        plane: 'agent',
      });
      assert.strictEqual(res.switched, true);
      const { switchCalls, switchedTo } = readState();
      assert.strictEqual(switchCalls, 1);
      assert.strictEqual(switchedTo, 'tab-agent-offscreen');
    });
  });

  // =========================================================================
  // 5. ATTACHMENT DISPOSAL HOOK (STEP 10)
  // =========================================================================
  describe('5. Attachment Disposal Hook', () => {
    it('revokeAttachment fires the dispose listener with the owned tab id only once', async () => {
      const registry = new AttachmentRegistry({ getHostEpoch: () => 1 });
      const fired: Array<{ attachmentId: string; tabId?: string }> = [];
      registry.setDisposeListener((info) => fired.push({ attachmentId: info.attachmentId, tabId: info.tabId }));

      const runId = 'run-aaaa1111-2222-3333-4444-555566667777';
      const attemptId = 'attempt-aaaa1111-2222-3333-4444-555566667777';
      const projectId = 'project-aaaa1111-2222-3333-4444-555566667777';
      const workspaceId = 'workspace-aaaa1111-2222-3333-4444-555566667777';
      const lease = {
        runtimeId: 'runtime-aaaa1111-2222-3333-4444-555566667777',
        projectId,
        workspaceId,
        token: 'lease-token-dispose-1',
        protocolVersion: 1,
        hostEpoch: 1,
        ownerPid: process.pid,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30_000,
      };
      const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
        backendId: 'cli',
        lease,
        leaseToken: lease.token,
        hostEpoch: 1,
        grant: 'write',
        tabId: 'tab-agent-owned',
        browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-agent-owned', browserEpoch: 1, documentGeneration: 1 },
      });

      await registry.revokeAttachment(launch.attachmentId);
      assert.strictEqual(fired.length, 1, 'Dispose listener must fire exactly once on revocation');
      assert.strictEqual(fired[0]?.attachmentId, launch.attachmentId);
      assert.strictEqual(fired[0]?.tabId, 'tab-agent-owned');
    });

    it('validateLiveExecution on an expired attachment fires the dispose listener', () => {
      const registry = new AttachmentRegistry({ getHostEpoch: () => 1 }, undefined, 100);
      const fired: Array<{ attachmentId: string; tabId?: string }> = [];
      registry.setDisposeListener((info) => fired.push({ attachmentId: info.attachmentId, tabId: info.tabId }));
      const record = {
        id: 'attachment-aaaa1111-2222-3333-4444-555566667777',
        runId: 'run-aaaa1111-2222-3333-4444-555566667777',
        attemptId: 'attempt-aaaa1111-2222-3333-4444-555566667777',
        projectId: 'project-aaaa1111-2222-3333-4444-555566667777',
        workspaceId: 'workspace-aaaa1111-2222-3333-4444-555566667777',
        backendId: 'cli',
        state: 'active' as const,
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() - 100, // already expired
        tabId: 'tab-agent-owned',
        browserTarget: { projectId: 'p', workspaceId: 'w', runtimeId: 'r', tabId: 'tab-agent-owned', browserEpoch: 1, documentGeneration: 1 },
        authorityRevision: 'rev_aaa',
        revisionNumber: 1,
      } as unknown as ExecutionAttachmentRecord;
      (registry as unknown as { records: Map<string, unknown> }).records.set(record.id, record);

      assert.throws(
        () => registry.validateLiveExecution(record, 'rev_aaa'),
        (err: unknown) => err instanceof CapabilityError && (err as CapabilityError).code === 'ATTACHMENT_STALE'
      );
      assert.strictEqual(fired.length, 1, 'Dispose listener must fire when attachment transitions to expired');
      assert.strictEqual(fired[0]?.tabId, 'tab-agent-owned');
    });
  });
});
