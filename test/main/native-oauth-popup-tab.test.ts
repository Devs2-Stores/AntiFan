/**
 * An OAuth `window.open` is hosted as a regular tab of the opener's window, not as a native window.
 *
 * Electron's `createWindow` hook hands the host the WebContents Chromium already created for the
 * popup inside the opener's browsing context (that is what carries `window.opener` and the opener's
 * Session). The host wraps exactly that object, registers it through the ordinary `createTab`
 * path, marks it `popupOf` its opener, presents it one turn later and, when the popup page closes,
 * hands the window back to the opener. The real-Chromium half of this contract (opener, shared
 * cookies, `window.close()`) is certified by `test/e2e/oauth-popup-tab-smoke.cjs`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { installElectronStub } from '../support/electron-stub';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';
import { createShellDouble } from '../support/project-window-shell-double';
import type { AntiFanTab } from '../../src/shared/contracts';
import type * as NativeTabHostModule from '../../src/main/browser/native-tab-host';

installElectronStub();

type AnyRecord = Record<string, any>;

interface FakeViewOptions {
  webContents?: AnyRecord;
  webPreferences?: AnyRecord;
}

/** Stand-in for Electron's WebContentsView: wraps the supplied WebContents when given one. */
class FakeWebContentsView {
  public readonly webContents: AnyRecord;
  public constructor(public readonly options: FakeViewOptions) {
    this.webContents = options.webContents ?? makeWebContents(9000);
  }
  public setBounds(): void {}
  public setBackgroundColor(): void {}
}
const electronStub: AnyRecord = require('electron');
electronStub.WebContentsView = FakeWebContentsView;

const { NativeTabHost } = require('../../src/main/browser/native-tab-host') as typeof NativeTabHostModule;
type PrivateHostMethods = {
  setupTabWebContentsEvents: (id: string, view: unknown, state: unknown, paneId: string) => void;
  buildPersistData: () => { tabs: Array<{ id: string }>; activeTabId?: string };
};
const privateHost = NativeTabHost.prototype as unknown as PrivateHostMethods;

interface HandlerDetails {
  url: string;
  disposition?: string;
}

interface WindowOpenResponse {
  action?: string;
  createWindow?: (options: AnyRecord) => AnyRecord;
  overrideBrowserWindowOptions?: AnyRecord;
}

const OPENER_ID = 'tab-opener';
const OPENER_CAPSULE = 'capsule-oauth-parent';
const OPENER_PARTITION = 'persist:capsule-oauth-parent-native';
const OPENER_USER_AGENT_MODE = 'native';
const OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123';

function makeWebContents(id: number): AnyRecord & EventEmitter {
  const state = { windowOpenHandler: null as null | ((details: HandlerDetails) => unknown), destroyed: false };
  const wc = Object.assign(new EventEmitter(), {
    id,
    session: { name: 'opener-session' },
    isDestroyed: (): boolean => state.destroyed,
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
    setWindowOpenHandler: (candidate: (details: HandlerDetails) => unknown) => { state.windowOpenHandler = candidate; },
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false, attach: () => {}, sendCommand: async () => {} }),
    destroy: () => { state.destroyed = true; },
    windowOpenHandler: () => {
      assert.ok(state.windowOpenHandler, 'the tab installed no window-open handler');
      return state.windowOpenHandler as (details: HandlerDetails) => unknown;
    },
  });
  return wc;
}

interface Harness {
  host: AnyRecord;
  openerContents: AnyRecord;
  switched: Array<{ tabId: string; plane?: string }>;
  adopted: Array<{ identifier: string; childTabId: string; source?: string; parentTabId?: string }>;
  open: (url: string) => WindowOpenResponse;
}

function createHarness(options: { adoptResult?: boolean } = {}): Harness {
  const host = Object.create(NativeTabHost.prototype) as AnyRecord;
  EventEmitter.call(host);

  const openerContents = makeWebContents(501);
  const openerView = { webContents: openerContents, setBounds: () => {} };
  const openerState: AntiFanTab = {
    id: OPENER_ID,
    url: 'https://example.com/opener',
    title: 'Opener',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    devicePresetId: 'responsive',
    capsuleId: OPENER_CAPSULE,
    partition: OPENER_PARTITION,
    userAgentMode: OPENER_USER_AGENT_MODE,
  };

  host.touchEmulationStates = new WeakMap();
  host.pendingEmulationDeferrals = new WeakMap();
  host.activeTabId = OPENER_ID;
  host.tabs = new Map([[OPENER_ID, { state: openerState, view: openerView, focusedPane: 'desktop' }]]);
  host.tabOrder = [OPENER_ID];
  host.tabByWebContents = new WeakMap();
  host.mutedSites = new Set<string>();
  host.recentlyClosedTabs = [];
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
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
  host.semanticRefRegistry = { list: () => [], invalidateTab: () => {} };
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
  host.reassertPresentedView = () => {};
  host.setupGlobalShortcutsOnView = () => {};
  host.setupContextMenu = () => {};
  host.isDisposed = false;
  host.bookmarks = [];
  host.mutedSites = new Set<string>();
  host.sessionTabPools = new Map();
  host.closedTabAnchors = new Map();
  host.splitCoordinator = { cleanupTab: () => {} };
  host.lastActiveTabByProject = new Map();
  host.getSharedProfilePartition = () => OPENER_PARTITION;
  host.recordTabClosedTelemetry = () => {};
  host.hibernatingTabIds = new Set<string>();

  const switched: Array<{ tabId: string; plane?: string }> = [];
  const adopted: Array<{ identifier: string; childTabId: string; source?: string; parentTabId?: string }> = [];
  host.switchTab = (tabId: string, opts?: { plane?: string }) => {
    switched.push({ tabId, plane: opts?.plane });
    host.activeTabId = tabId;
    return true;
  };
  host.adoptChildTab = (identifier: string, childTabId: string, _generation?: unknown, source?: string, parentTabId?: string) => {
    adopted.push({ identifier, childTabId, source, parentTabId });
    return options.adoptResult !== false;
  };

  privateHost.setupTabWebContentsEvents.call(host, OPENER_ID, openerView, openerState, 'desktop');

  return {
    host,
    openerContents,
    switched,
    adopted,
    open: (url: string) => openerContents.windowOpenHandler()({ url, disposition: 'new-window' }) as WindowOpenResponse,
  };
}

/** Let the deferred presentation run: the hook answers the opener's window.open first by contract. */
async function drainImmediates(ticks = 5): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/** What Electron passes to `createWindow`: the WebContents Chromium made for the popup. */
function chromiumPopupOptions(popupContents: AnyRecord): AnyRecord {
  return { webContents: popupContents, show: true, webPreferences: { sandbox: true, contextIsolation: true } };
}

describe('OAuth window.open hosted as a popup tab', () => {
  it('registers the Chromium-created popup as a tab of the opener, marked popupOf and inheriting its identity', async () => {
    const harness = createHarness();
    const response = harness.open(OAUTH_URL);
    assert.equal(response.action, 'allow');
    assert.equal(typeof response.createWindow, 'function');
    assert.equal(response.overrideBrowserWindowOptions?.parent, undefined, 'no native parent window');
    assert.equal(response.overrideBrowserWindowOptions?.webPreferences?.session, undefined, 'the session is the opener\'s by construction');

    const popupContents = makeWebContents(777);
    const returned = response.createWindow!(chromiumPopupOptions(popupContents));
    assert.strictEqual(returned, popupContents, 'the hook must hand Chromium back the very WebContents it created');

    const popupId = harness.host.tabOrder.find((id: string) => id !== OPENER_ID);
    assert.ok(popupId, 'the popup is registered as a tab synchronously, inside the hook');
    const record = harness.host.tabs.get(popupId);
    assert.ok(record.view instanceof FakeWebContentsView);
    assert.strictEqual(record.view.webContents, popupContents, 'the tab wraps the popup\'s own WebContents, not a fresh one');
    assert.strictEqual(record.view.options.webContents, popupContents);
    assert.equal(record.state.popupOf, OPENER_ID);
    assert.equal(record.state.url, OAUTH_URL);
    assert.equal(record.state.partition, OPENER_PARTITION, 'same cookie jar as the opener');
    assert.equal(record.state.userAgentMode, OPENER_USER_AGENT_MODE);
    assert.equal(record.state.capsuleId, OPENER_CAPSULE);
    assert.equal(record.state.ephemeral, false, 'a popup is a user-plane tab of the opener\'s window');
    assert.strictEqual(harness.host.tabByWebContents.get(popupContents)?.tabId, popupId, 'the tab is resolvable from its WebContents like any other');

    // tabs.list reads rows spread from the tab state, so the field reaches the wire.
    const row = harness.host.getTabList().find((tab: AntiFanTab) => tab.id === popupId);
    assert.ok(row, 'the popup appears in the tab list');
    assert.equal(row.popupOf, OPENER_ID);
    assert.equal(harness.host.getTabList().find((tab: AntiFanTab) => tab.id === OPENER_ID).popupOf, undefined);

    assert.deepEqual(harness.switched, [], 'presentation waits one turn: the opener is blocked inside window.open');
    assert.deepEqual(harness.adopted, []);
    await drainImmediates();
    assert.deepEqual(harness.switched, [{ tabId: popupId, plane: 'user' }], 'the popup is presented like a user-opened tab');
    assert.deepEqual(harness.adopted, [{
      identifier: OPENER_ID,
      childTabId: popupId,
      source: 'native_window_open',
      parentTabId: OPENER_ID,
    }]);
  });

  it('keeps the popup when the agent pool refuses to adopt it', async () => {
    const harness = createHarness({ adoptResult: false });
    const popupContents = makeWebContents(778);
    harness.open(OAUTH_URL).createWindow!(chromiumPopupOptions(popupContents));
    await drainImmediates();

    const popupId = harness.host.tabOrder.find((id: string) => id !== OPENER_ID);
    assert.ok(popupId && harness.host.tabs.has(popupId), 'a sign-in popup is never closed because adoption was refused');
    assert.equal(popupContents.isDestroyed(), false);
    assert.deepEqual(harness.switched, [{ tabId: popupId, plane: 'user' }]);
  });

  it('removes the tab and re-activates the opener when the popup page closes itself', async () => {
    const harness = createHarness();
    const popupContents = makeWebContents(779);
    harness.open(OAUTH_URL).createWindow!(chromiumPopupOptions(popupContents));
    await drainImmediates();
    const popupId = harness.host.tabOrder.find((id: string) => id !== OPENER_ID);
    assert.equal(harness.host.activeTabId, popupId);
    harness.switched.length = 0;

    // window.close() in the popup: Chromium emits `close` on its WebContents, then destroys it.
    popupContents.emit('close');

    assert.equal(harness.host.tabs.has(popupId), false, 'the popup tab is gone');
    assert.deepEqual(harness.host.tabOrder, [OPENER_ID]);
    assert.equal(popupContents.isDestroyed(), true, 'its WebContents is released');
    assert.deepEqual(harness.switched, [{ tabId: OPENER_ID, plane: 'user' }], 'the opener is activated again');
    assert.equal(harness.host.activeTabId, OPENER_ID);
  });

  it('re-activates the opener when the popup WebContents is destroyed without a close event', async () => {
    const harness = createHarness();
    const popupContents = makeWebContents(780);
    harness.open(OAUTH_URL).createWindow!(chromiumPopupOptions(popupContents));
    await drainImmediates();
    const popupId = harness.host.tabOrder.find((id: string) => id !== OPENER_ID);
    harness.switched.length = 0;

    popupContents.emit('destroyed');

    assert.equal(harness.host.tabs.has(popupId), false);
    assert.deepEqual(harness.switched, [{ tabId: OPENER_ID, plane: 'user' }]);
  });

  it('does not steal the window back when a popup that is not presented closes', async () => {
    const harness = createHarness();
    const popupContents = makeWebContents(781);
    harness.open(OAUTH_URL).createWindow!(chromiumPopupOptions(popupContents));
    await drainImmediates();
    const popupId = harness.host.tabOrder.find((id: string) => id !== OPENER_ID);
    // The user moved on to another tab while the popup stayed in the background.
    harness.host.activeTabId = OPENER_ID;
    harness.switched.length = 0;

    popupContents.emit('close');

    assert.equal(harness.host.tabs.has(popupId), false);
    assert.deepEqual(harness.switched, [], 'only closing the presented popup hands focus back');
  });

  it('wraps and tears down a popup it cannot register when the opener is already gone', async () => {
    const harness = createHarness();
    const response = harness.open(OAUTH_URL);
    harness.host.tabs.delete(OPENER_ID);
    harness.host.tabOrder = [];

    const popupContents = makeWebContents(782);
    const returned = response.createWindow!(chromiumPopupOptions(popupContents));

    assert.strictEqual(returned, popupContents, 'Chromium still gets its WebContents back');
    assert.deepEqual(harness.host.tabOrder, [], 'no tab is registered for a dead opener');
    assert.equal(popupContents.isDestroyed(), false, 'teardown is deferred, never inside the hook');
    await drainImmediates();
    assert.equal(popupContents.isDestroyed(), true);
    assert.deepEqual(harness.adopted, []);
    assert.deepEqual(harness.switched, []);
  });

  it('keeps a non-OAuth window.open on the ordinary deferred-tab path', async () => {
    const harness = createHarness();
    const created: Array<{ url: string; options?: AnyRecord }> = [];
    harness.host.createTab = (url: string, _activate: boolean, tabOptions?: AnyRecord) => {
      created.push({ url, options: tabOptions });
      return 'tab-plain-child';
    };
    const response = harness.open('https://example.com/docs');

    assert.equal(response.action, 'deny');
    assert.equal(response.createWindow, undefined, 'an ordinary popup is never given a window');
    await drainImmediates();
    assert.equal(created.length, 1);
    assert.equal(created[0]?.url, 'https://example.com/docs');
    assert.equal(created[0]?.options?.popup, undefined, 'only OAuth popups are registered as popup tabs');
  });

  it('never persists a popup tab or its active slot', async () => {
    const harness = createHarness();
    harness.host.terminalAgentAffinity = new Map();
    harness.host.terminalTabLayout = 'list';
    harness.host.terminalCollapsedCategories = [];
    harness.host.terminalCategories = [];
    harness.host.terminalCategoryColors = {};
    harness.host.terminalStarredCategories = [];
    harness.host.terminalProjectOrder = [];
    const popupContents = makeWebContents(783);
    harness.open(OAUTH_URL).createWindow!(chromiumPopupOptions(popupContents));
    await drainImmediates();
    const popupId = harness.host.tabOrder.find((id: string) => id !== OPENER_ID);
    assert.equal(harness.host.activeTabId, popupId);

    const persisted = privateHost.buildPersistData.call(harness.host);

    assert.deepEqual(persisted.tabs.map((tab) => tab.id), [OPENER_ID], 'a restored popup would be a sign-in page with no opener');
    assert.equal(persisted.activeTabId, undefined);
  });
});
