/**
 * Phase 3 — the offscreen (OSR) render surface.
 *
 * An OSR agent tab is sized by Emulation.setDeviceMetricsOverride on its own
 * debugger channel: the OSR RenderWidgetHostView owns its compositor and
 * BeginFrame source, so the view produces layout and rasters without ever
 * entering the window. Three invariants pin that here:
 *
 *  1. createTab mints the surface: the metrics override is applied at mint
 *     (deferred to did-finish-load before a document commits), never an attach.
 *  2. runWithAttachedTabView never attaches an OSR view — AddChildView poisons
 *     the OSR raster size on every later window resize (Electron #45864).
 *  3. setViewportSize on an OSR tab applies the override directly: it bypasses
 *     the window content-box measurement AND the attach the background path
 *     wraps it in.
 *
 * A fourth case covers the renderer swap: recreation must preserve the OSR web
 * preferences and re-arm the emulation, or the tab silently turns windowed and
 * un-sized.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { installElectronStub } from '../support/electron-stub';

installElectronStub();

interface CapturedCdpCall { method: string; params: Record<string, unknown>; }

class FakeWebContents {
  static nextId = 100;
  id = FakeWebContents.nextId++;
  currentUrl = '';
  loadCalls: string[] = [];
  cdpCalls: CapturedCdpCall[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }
  isCrashed(): boolean { return false; }
  isLoading(): boolean { return false; }
  getURL(): string { return this.currentUrl; }
  setURL(url: string): void { this.currentUrl = url; }
  loadURL(url: string): Promise<void> {
    this.loadCalls.push(url);
    this.currentUrl = url;
    return Promise.resolve();
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
    return this;
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  setBackgroundThrottling(_enabled: boolean): void {}
  invalidate(): void {}
  setZoomFactor(_f: number): void {}
  setUserAgent(_ua: string): void {}
  getUserAgent(): string { return 'fake-ua'; }
  insertCSS(): Promise<string> { return Promise.resolve(''); }
  executeJavaScript(): Promise<unknown> { return Promise.resolve(undefined); }
  session = { cookies: { flushStore: () => Promise.resolve() } };
  debugger = {
    isAttached: () => true,
    attach: () => {},
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      this.cdpCalls.push({ method, params });
      return {};
    },
  };
}

class FakeWebContentsView {
  static instances: FakeWebContentsView[] = [];
  webContents = new FakeWebContents();
  webPreferences: Record<string, unknown>;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  backgroundColor?: string;
  constructor(options?: { webPreferences?: Record<string, unknown> }) {
    this.webPreferences = options?.webPreferences ?? {};
    FakeWebContentsView.instances.push(this);
  }
  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...rect };
  }
  getBounds(): { x: number; y: number; width: number; height: number } { return { ...this.bounds }; }
  setBackgroundColor(color: string): void { this.backgroundColor = color; }
}

// The compiled host reads `electron.WebContentsView` per construction, so
// swapping the stub's export property before the require installs the double.
import type * as NativeTabHostModule from '../../src/main/browser/native-tab-host';
const electronStub = require('electron') as { WebContentsView: unknown };
electronStub.WebContentsView = FakeWebContentsView;

const { NativeTabHost: NativeTabHostRuntime } = require('../../src/main/browser/native-tab-host') as typeof NativeTabHostModule;
import type { NativeTabRecord } from '../../src/main/browser/native-tab-host';
import type { AntiFanTab } from '../../src/shared/contracts';
import type { ShellDouble } from '../support/project-window-shell-double';
import { createShellDouble } from '../support/project-window-shell-double';

const flushCdp = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const WINDOW_CONTENT_BOX = { x: 0, y: 0, width: 1280, height: 800 };
const TOOLBAR_HEIGHT = 90;

/**
 * The members of NativeTabHost the OSR surface paths reach for. Declared rather
 * than inherited because the harness sets private fields the type system keeps
 * hidden on the real class — a prototype-created host owns no declaration.
 */
interface OsrTestHost {
  isDisposed: boolean;
  tabs: Map<string, NativeTabRecord>;
  tabOrder: string[];
  tabByWebContents: WeakMap<object, { tabId: string; tab: NativeTabRecord }>;
  pendingEmulationDeferrals: WeakMap<object, { preset?: unknown; scale: number }>;
  temporaryViewAttachCounts: WeakMap<object, { count: number; attachedByHelper: boolean }>;
  tabReadyWaits: Map<string, Promise<boolean>>;
  sessionTabPools: Map<string, Set<string>>;
  tabPreviewUnsubscribers: Map<string, () => void>;
  bookmarks: unknown[];
  defaultUserAgent: string;
  activeTabId: string;
  shell: ShellDouble;
  getToolbarHeight(): number;
  updateLayout(): void;
  broadcastState(): void;
  schedulePersist(): void;
  setSafeUserAgent(wc: unknown, ua: string): void;
  applyCdpTouchEmulation(wc: unknown, enabled: boolean): Promise<void>;
  applyDeviceCornerClipping(wc: unknown, radius: number): void;
  setupTabWebContentsEvents(id: string, view: unknown, state: AntiFanTab, paneId: string): void;
  destroyOwnedWebContents(wc: unknown): void;
  previewWatcherPool: { retain(id: string, root: string, cb: (e: unknown) => void): () => void };
  capsuleManager: { list(): unknown[]; getActive(): undefined };
  createTab(url: string, activate: boolean, options?: Record<string, unknown>): string;
  runWithAttachedTabView<T>(view: unknown, action: () => Promise<T>, isMobile?: boolean): Promise<T>;
  setViewportSize(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string; reload?: boolean }): Promise<boolean>;
  recreateDesktopView(targetId: string, target: NativeTabRecord): FakeWebContentsView | null;
  ensureTabReady(tabId: string, timeoutMs?: number): Promise<boolean>;
  reassertPresentedView(): void;
}

interface OsrHostHarness {
  host: OsrTestHost;
  shell: ShellDouble;
  children: unknown[];
}

/**
 * A prototype-created host carrying exactly the seams the OSR paths read:
 * a real contentView (attach attempts are observed, not stubbed away), real
 * applyTabDeviceEmulation/applyCdpDeviceEmulationState, and stubbed chrome
 * notifications. Deliberately shares WINDOW_CONTENT_BOX arithmetic with the
 * viewport suite, not its constants.
 */
function createOsrHost(): OsrHostHarness {
  // Cast reason: a prototype-created host has every member the OSR paths call
  // once the fields below are set; declaring them on OsrTestHost is the point
  // of the interface above.
  const host = Object.create(NativeTabHostRuntime.prototype) as OsrTestHost;
  host.isDisposed = false;
  host.tabs = new Map<string, NativeTabRecord>();
  host.tabOrder = [];
  host.tabByWebContents = new WeakMap();
  host.pendingEmulationDeferrals = new WeakMap();
  host.temporaryViewAttachCounts = new WeakMap();
  host.tabReadyWaits = new Map();
  host.sessionTabPools = new Map();
  host.tabPreviewUnsubscribers = new Map();
  host.bookmarks = [];
  host.defaultUserAgent = 'MockDesktopUA';
  host.activeTabId = '';
  const shell = createShellDouble({ contentBounds: { ...WINDOW_CONTENT_BOX }, isSidebarOpen: false });
  host.shell = shell;
  host.getToolbarHeight = () => TOOLBAR_HEIGHT;
  host.updateLayout = () => {};
  host.broadcastState = () => {};
  host.reassertPresentedView = () => {};
  host.schedulePersist = () => {};
  host.setSafeUserAgent = () => {};
  host.applyCdpTouchEmulation = () => Promise.resolve();
  host.applyDeviceCornerClipping = () => {};
  host.setupTabWebContentsEvents = () => {};
  host.destroyOwnedWebContents = () => {};
  host.previewWatcherPool = { retain: () => () => {} };
  host.capsuleManager = { list: () => [], getActive: () => undefined };
  const children = shell.window.contentView.children;
  return { host, shell, children };
}

function makeOsrTab(host: OsrTestHost, id: string, url = 'https://agent.example/page'): { tab: NativeTabRecord; view: FakeWebContentsView; wc: FakeWebContents } {
  const view = new FakeWebContentsView();
  const wc = view.webContents;
  wc.setURL(url);
  const state: AntiFanTab = {
    id,
    url,
    title: 'Agent Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    devicePresetId: 'responsive',
    offscreen: true,
    ephemeral: true,
  };
  const tab = { view, state } as unknown as NativeTabRecord;
  host.tabs.set(id, tab);
  host.tabByWebContents.set(wc, { tabId: id, tab });
  return { tab, view, wc };
}

describe('offscreen render surface', () => {
  it('mints an OSR tab with webPreferences offscreen, a metrics-override surface at the window content box, and a materialized document', async () => {
    FakeWebContentsView.instances = [];
    const { host, children } = createOsrHost();
    const tabId = host.createTab('about:blank', false, { offscreen: true, ephemeral: true, partition: 'ephemeral-osr-probe' });
    assert.ok(tabId, 'createTab must mint the agent tab');
    const tab = host.tabs.get(tabId);
    assert.ok(tab?.view, 'the minted record holds its view');

    const minted = FakeWebContentsView.instances[0];
    assert.ok(minted, 'a WebContentsView was constructed');
    assert.strictEqual(minted.webPreferences.offscreen, true);
    assert.strictEqual(minted.webPreferences.backgroundThrottling, false, 'an OSR raster source must never be throttled');
    assert.ok(!children.includes(minted), 'minting must never attach the OSR view');

    // The document materializes (about:blank is loaded, not skipped) so the
    // pre-commit emulation deferral has a did-finish-load to fire on.
    const wc = minted.webContents;
    assert.strictEqual(wc.currentUrl, 'about:blank');
    // The surface claim is the record: window-box derived geometry, not a
    // leftover 'responsive' clear-override.
    assert.strictEqual(tab.state.devicePresetId, `custom-${WINDOW_CONTENT_BOX.width}x${WINDOW_CONTENT_BOX.height - TOOLBAR_HEIGHT}`);
    assert.deepStrictEqual(tab.customViewport, {
      width: WINDOW_CONTENT_BOX.width,
      height: WINDOW_CONTENT_BOX.height - TOOLBAR_HEIGHT,
      mobile: false,
      deviceScaleFactor: 1,
    });
    // Pre-commit: the override sits in the deferral, armed on did-finish-load.
    assert.ok(host.pendingEmulationDeferrals.get(wc), 'the mint emulation defers to first load');
    wc.emit('did-finish-load');
    await flushCdp();
    const metrics = wc.cdpCalls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    assert.ok(metrics, 'first commit must land the metrics override');
    assert.strictEqual(metrics.params.width, WINDOW_CONTENT_BOX.width);
    assert.strictEqual(metrics.params.height, WINDOW_CONTENT_BOX.height - TOOLBAR_HEIGHT);
    assert.strictEqual(metrics.params.scale, 1, 'an agent-plane tab renders at exactly its requested size');
  });

  it('runWithAttachedTabView runs the action on an OSR view without attaching it', async () => {
    const { host, children } = createOsrHost();
    const presented = makeOsrTab(host, 'tab-visible');
    presented.tab.state.offscreen = false;
    host.activeTabId = 'tab-visible';
    children.push(presented.view);
    const { view, tab } = makeOsrTab(host, 'tab-agent');
    assert.strictEqual(tab.state.offscreen, true);

    let ranInside = 0;
    let attachedDuringAction: boolean | undefined;
    await host.runWithAttachedTabView(view, async () => {
      ranInside++;
      attachedDuringAction = children.includes(view);
    });
    assert.strictEqual(ranInside, 1, 'the action still runs');
    assert.strictEqual(attachedDuringAction, false, 'the OSR view must never enter the window');
    assert.strictEqual(children.includes(view), false);

    // Control: a NON-offscreen background view still takes the attach path and
    // is released afterwards — the guard narrows to OSR, not background work.
    const normal = makeOsrTab(host, 'tab-bg');
    normal.tab.state.offscreen = false;
    let normalAttached: boolean | undefined;
    await host.runWithAttachedTabView(normal.view, async () => {
      normalAttached = children.includes(normal.view);
    });
    assert.strictEqual(normalAttached, true, 'the helper still attaches ordinary background views');
    assert.strictEqual(children.includes(normal.view), false, 'and releases them on return');
  });

  it('setViewportSize applies the requested size directly on an OSR tab — no attach, no window-box refusal', async () => {
    const { host, children } = createOsrHost();
    const { tab, view, wc } = makeOsrTab(host, 'tab-agent');
    host.activeTabId = 'tab-visible'; // background target exercises the else-branch shape

    const ok = await host.setViewportSize({ width: 390, height: 844, mobile: true, tabId: 'tab-agent' });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(tab.customViewport, { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 });
    assert.strictEqual(tab.state.devicePresetId, 'custom-390x844');
    assert.strictEqual(children.includes(view), false, 'an OSR viewport write must not attach the view');
    await flushCdp();
    const metrics = wc.cdpCalls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    assert.ok(metrics, 'the write reaches the metrics override');
    assert.strictEqual(metrics.params.width, 390);
    assert.strictEqual(metrics.params.height, 844);
    assert.strictEqual(metrics.params.deviceScaleFactor, 3);
    assert.strictEqual(metrics.params.mobile, true);
    assert.strictEqual(metrics.params.scale, 1, 'the agent plane renders exactly, never fit-preview scaled');
  });

  it('setViewportSize on an OSR tab still applies when the window cannot report a content box', async () => {
    const { host, shell } = createOsrHost();
    const { wc } = makeOsrTab(host, 'tab-agent');
    // A destroyed/unmeasurable window fails background tabs with
    // VIEWPORT_NOT_APPLIED; the OSR surface is window-independent, so it bypasses
    // that measurement entirely.
    shell.window.isDestroyed = () => true;
    shell.window.getContentBounds = () => { throw new Error('gone'); };
    const ok = await host.setViewportSize({ width: 1440, height: 900, tabId: 'tab-agent' });
    assert.strictEqual(ok, true, 'the OSR write bypasses the window-box refusal');
    await flushCdp();
    const metrics = wc.cdpCalls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    assert.strictEqual(metrics?.params.width, 1440);
    assert.strictEqual(metrics?.params.height, 900);
  });

  it('recreateDesktopView preserves the OSR prefs and re-arms the surface emulation', async () => {
    FakeWebContentsView.instances = [];
    const { host } = createOsrHost();
    const { tab, wc } = makeOsrTab(host, 'tab-agent', 'about:blank');
    tab.customViewport = { width: 1024, height: 768, mobile: false, deviceScaleFactor: 1 };
    tab.state.devicePresetId = 'custom-1024x768';
    tab.state.crashed = true;

    const view = host.recreateDesktopView('tab-agent', tab);
    assert.ok(view, 'a view is rebuilt');
    assert.notStrictEqual(view.webContents, wc, 'the renderer is replaced');
    const recreated = FakeWebContentsView.instances[1];
    assert.ok(recreated, 'a fresh view replaced the dead one');
    assert.strictEqual(recreated.webPreferences.offscreen, true, 'the rebuilt view stays OSR');
    assert.strictEqual(recreated.webPreferences.backgroundThrottling, false);
    // about:blank is re-materialized so the deferral has a commit to fire on.
    assert.deepStrictEqual(recreated.webContents.loadCalls, ['about:blank']);
    // The requested 1024x768 viewport survives the swap: re-emulation keeps the
    // custom geometry instead of collapsing to the window box.
    assert.strictEqual(tab.state.devicePresetId, 'custom-1024x768');
    assert.deepStrictEqual(tab.customViewport, { width: 1024, height: 768, mobile: false, deviceScaleFactor: 1 });
    assert.ok(host.pendingEmulationDeferrals.get(recreated.webContents), 'the surface emulation re-arms on the fresh renderer');

    // ensureTabReady shares the same re-arm for a tab woken on demand.
    const ready = await host.ensureTabReady('tab-agent');
    assert.strictEqual(ready, true);

    recreated.webContents.emit('did-finish-load');
    await flushCdp();
    const metrics = recreated.webContents.cdpCalls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    assert.strictEqual(metrics?.params.width, 1024);
    assert.strictEqual(metrics?.params.height, 768);
  });
});
