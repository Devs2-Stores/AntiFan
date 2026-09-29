/**
 * A `window.open` popup is created from the opener's identity, one turn after the page asked.
 *
 * The row in the project-window scenario proves the inheritance live, but only for a plain user
 * tab: there the opener's partition and user agent mode are the defaults, so a child that takes
 * the defaults too passes the parity assertions without inheriting anything. This suite pins the
 * decision itself, with an opener that carries a non-default partition and mode, plus the two
 * failure paths the deferred creation opens up: the opener closed before the child is built, and
 * an adoption that refuses the child.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';
import type { AntiFanTab } from '../../src/shared/contracts';
import { createShellDouble } from '../support/project-window-shell-double';

type PrivateHostMethods = {
  setupTabWebContentsEvents: (id: string, view: unknown, state: unknown, paneId: string) => void;
};
const privateHost = NativeTabHost.prototype as unknown as PrivateHostMethods;

interface HandlerDetails {
  url: string;
  disposition?: string;
}

type AnyRecord = Record<string, any>;

const PARENT_ID = 'tab-opener';
const PARENT_CAPSULE = 'capsule-popup-parent';
/** Deliberately not the shared profile jar and not the default `clean` mode. */
const PARENT_PARTITION = 'persist:capsule-popup-parent-native';
const PARENT_USER_AGENT_MODE = 'native';

/**
 * The same host shape the split-review suite builds: a prototype host with one installed view
 * whose `setWindowOpenHandler` records the handler the product registers.
 */
function createPopupHost(options: { adoptResult?: boolean } = {}): {
  host: AnyRecord;
  windowOpenHandler: () => (details: HandlerDetails) => unknown;
  created: Array<{ url: string; activate: boolean; options?: AnyRecord }>;
  adopted: Array<{ identifier: string; childTabId: string; source?: string; parentTabId?: string }>;
  closed: string[];
} {
  const host = Object.create(NativeTabHost.prototype) as AnyRecord;
  EventEmitter.call(host);

  let handler: ((details: HandlerDetails) => unknown) | null = null;
  const webContents = Object.assign(new EventEmitter(), {
    id: 501,
    isDestroyed: (): boolean => false,
    getURL: (): string => 'https://example.com/opener',
    getUserAgent: (): string => '',
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    isLoading: (): boolean => false,
    setZoomFactor: (_z?: number) => {},
    setAudioMuted: (_muted: boolean) => {},
    isCurrentlyAudible: () => false,
    capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
    executeJavaScript: async () => undefined,
    insertCSS: async () => '',
    setUserAgent: (_ua: string) => {},
    setWindowOpenHandler: (candidate: (details: HandlerDetails) => unknown) => { handler = candidate; },
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false, attach: () => {}, sendCommand: async () => {} }),
    destroy: () => {},
  });
  const view = { webContents, setBounds: () => {} };

  const state: AntiFanTab = {
    id: PARENT_ID,
    url: 'https://example.com/opener',
    title: 'Opener',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    devicePresetId: 'responsive',
    capsuleId: PARENT_CAPSULE,
    partition: PARENT_PARTITION,
    userAgentMode: PARENT_USER_AGENT_MODE,
  };

  host.touchEmulationStates = new WeakMap();
  host.pendingEmulationDeferrals = new WeakMap();
  host.activeTabId = PARENT_ID;
  host.tabs = new Map([[PARENT_ID, { state, view, focusedPane: 'desktop' }]]);
  host.tabOrder = [PARENT_ID];
  host.mutedSites = new Set<string>();
  host.recentlyClosedTabs = [];
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  // Field initializers do not run on a prototype-built double; the input tracking the
  // real trackUserActivityOnView listener feeds reads both counters from the host.
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.documentGenerations = new Map();
  host.semanticDocumentGenerations = new Map();
  host.targetOperationQueues = new Map();
  host.lastNavigationFailures = new Map();
  host.previewWatcherPool = { retain: () => () => {}, clear: () => {} };
  host.persistTabs = () => {};
  host.inspectGeneration = 0;
  host.isInspecting = false;
  host.isProcessingInspectPick = false;
  host.inspectedTabId = null;
  host.programmaticNavigations = new Map();
  host.tabPreviewUnsubscribers = new Map();
  host.agentWorkingTimers = new Map();
  host.agentWorkingRefs = new Map();
  host.semanticRefRegistry = { list: () => [] };
  host.networkTracker = new FirstPartyNetworkTracker();
  host.isBookmarkBarVisible = false;
  host.appliedClipRadius = new WeakMap();
  host.diagnosticsManager = { recordConsole: () => {}, recordFailure: () => {}, clear: () => {}, deleteTab: () => {} };
  host.shell = createShellDouble({
    toolbarView: { webContents: { id: 1, isDestroyed: () => false, send: () => {} }, setBounds: () => {} },
    contentBounds: { x: 0, y: 0, width: 1400, height: 900 },
  });
  host.broadcastState = () => {};
  host.updateLayout = () => {};
  host.schedulePersist = () => {};
  host.setupGlobalShortcutsOnView = () => {};
  host.setupContextMenu = () => {};
  host.isDisposed = false;

  const created: Array<{ url: string; activate: boolean; options?: AnyRecord }> = [];
  const adopted: Array<{ identifier: string; childTabId: string; source?: string; parentTabId?: string }> = [];
  const closed: string[] = [];
  host.createTab = (url: string, activate: boolean, tabOptions?: AnyRecord) => {
    created.push({ url, activate, options: tabOptions });
    return 'tab-popup-child';
  };
  host.adoptChildTab = (identifier: string, childTabId: string, _generation?: unknown, source?: string, parentTabId?: string) => {
    adopted.push({ identifier, childTabId, source, parentTabId });
    return options.adoptResult !== false;
  };
  host.closeTab = (tabId: string) => {
    closed.push(tabId);
    host.tabs.delete(tabId);
    return true;
  };

  privateHost.setupTabWebContentsEvents.call(host, PARENT_ID, view, state, 'desktop');

  return {
    host,
    windowOpenHandler: () => {
      assert.ok(handler, 'the tab installed no window-open handler');
      return handler as (details: HandlerDetails) => unknown;
    },
    created,
    adopted,
    closed,
  };
}

/** Let the deferred creation run: the handler answers the page first by contract. */
async function drainImmediates(ticks = 5): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('native window.open popup inheritance', () => {
  it('creates the child with the opener\'s capsule, partition and user agent mode', async () => {
    const harness = createPopupHost();
    const response = harness.windowOpenHandler()({ url: 'https://example.com/native-popup', disposition: 'new-window' }) as { action?: string };
    assert.equal(response.action, 'deny', 'the native window is denied and the popup becomes a tab');

    assert.deepEqual(harness.created, [], 'the child is not built while the page is blocked inside window.open');
    await drainImmediates();

    assert.equal(harness.created.length, 1, 'exactly one child tab is created');
    assert.deepEqual(harness.created[0], {
      url: 'https://example.com/native-popup',
      activate: true,
      options: {
        capsuleId: PARENT_CAPSULE,
        partition: PARENT_PARTITION,
        userAgentMode: PARENT_USER_AGENT_MODE,
        // The child joins the opener's project; this opener carries none.
        projectId: null,
      },
    });
    assert.deepEqual(harness.adopted, [{
      identifier: PARENT_ID,
      childTabId: 'tab-popup-child',
      source: 'native_window_open',
      parentTabId: PARENT_ID,
    }]);
    assert.deepEqual(harness.closed, [], 'an adopted child is not closed again');
  });

  it('creates nothing when the opener was closed before the deferred creation ran', async () => {
    const harness = createPopupHost();
    harness.windowOpenHandler()({ url: 'https://example.com/native-popup', disposition: 'new-window' });
    // The opener closing is exactly the race the deferral opens: the tab is gone from this
    // window before the child would be built, and adopting into a gone parent would leave a
    // tab nothing owns.
    harness.host.tabs.delete(PARENT_ID);
    harness.host.tabOrder = [];
    await drainImmediates();

    assert.deepEqual(harness.created, [], 'no child is created for a dead opener');
    assert.deepEqual(harness.adopted, []);
    assert.deepEqual(harness.closed, []);
  });

  it('closes only the child it just created when adoption refuses it', async () => {
    const harness = createPopupHost({ adoptResult: false });
    harness.windowOpenHandler()({ url: 'https://example.com/native-popup', disposition: 'new-window' });
    await drainImmediates();

    assert.equal(harness.created.length, 1, 'the child was created');
    assert.equal(harness.adopted.length, 1, 'adoption was attempted');
    assert.deepEqual(harness.closed, ['tab-popup-child'], 'the unowned child is closed, and nothing else is');
  });
  it('creates nothing when the host was disposed before the deferred creation ran', async () => {
    const harness = createPopupHost();
    harness.windowOpenHandler()({ url: 'https://example.com/native-popup', disposition: 'new-window' });
    harness.host.isDisposed = true;
    await drainImmediates();

    assert.deepEqual(harness.created, [], 'no child is created when host is disposed');
    assert.deepEqual(harness.adopted, []);
    assert.deepEqual(harness.closed, []);
  });

  it('creates the child when opened with foreground-tab disposition', async () => {
    const harness = createPopupHost();
    const response = harness.windowOpenHandler()({ url: 'https://example.com/native-popup-fg', disposition: 'foreground-tab' }) as { action?: string };
    assert.equal(response.action, 'deny', 'foreground-tab disposition is handled and denied to become a tab');
    await drainImmediates();

    assert.equal(harness.created.length, 1, 'child tab is created for foreground-tab disposition');
    assert.equal(harness.created[0]?.url, 'https://example.com/native-popup-fg');
  });
});
