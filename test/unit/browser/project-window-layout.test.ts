/**
 * Per-shell isolation of project-window presentation state.
 *
 * Two REAL `ProjectWindowShell` instances, each owning its own REAL
 * `NativeTabHost`, are driven through the REAL chrome route table and the REAL
 * `TabAuthorityDirectory` sender resolver. Only the Electron boundary is
 * stubbed: `BrowserWindow` / `WebContentsView` are recording doubles, so every
 * assertion reads state the production objects actually produced — per-shell
 * active tab ids, split/device fields, view bounds, window child stacks, the
 * messages chrome surfaces received, and capture-host ownership.
 *
 * This is not the stylesheet-text contract in
 * `test/unit/browser/tab-layout-invariants.test.ts` (which greps toolbar.css
 * and standalone.css). Here a registry that shared layout, active-tab, split,
 * device or capture state between two shells fails the suite.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebContents, WebContentsView } from 'electron';
import type { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import type { ProjectWindowShell, WindowOwner } from '../../../src/main/browser/project-window-shell';

// ---------------------------------------------------------------------------
// Isolation: every persistence path this suite can reach points at a scratch
// directory, so no test can read or write the developer's real
// saved-tabs.json / workspace-capsules.json.
// ---------------------------------------------------------------------------
const SCRATCH_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'tsc-wsg', 'tmp-project-window-layout');
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
process.env.ANTIFAN_DATA_ROOT = SCRATCH_DIR;

// ---------------------------------------------------------------------------
// Electron boundary doubles
// ---------------------------------------------------------------------------

interface Bounds { x: number; y: number; width: number; height: number }

let nextWebContentsId = 4100;

/** WebContents double: an EventEmitter plus the methods the host calls. */
class FakeWebContents extends EventEmitter {
  public readonly id: number = nextWebContentsId++;
  public mainFrame: { url: string; parent: unknown } = { url: 'about:blank', parent: null };
  public readonly sent: Array<{ channel: string; args: unknown[] }> = [];
  public destroyed = false;
  public zoomFactor = 1;
  public backgroundThrottling = true;
  public audioMuted = false;
  public userAgent = '';
  public windowOpenHandler: ((details: unknown) => unknown) | null = null;

  public isDestroyed(): boolean { return this.destroyed; }
  public isCrashed(): boolean { return false; }
  public getURL(): string { return this.mainFrame.url || 'about:blank'; }
  public getTitle(): string { return ''; }
  public send(channel: string, ...args: unknown[]): void { this.sent.push({ channel, args }); }
  public loadURL(url: string): Promise<void> { this.mainFrame.url = url; return Promise.resolve(); }
  public loadFile(filePath: string): Promise<void> { this.mainFrame.url = pathToFileURL(filePath).href; return Promise.resolve(); }
  public setWindowOpenHandler(handler: (details: unknown) => unknown): void { this.windowOpenHandler = handler; }
  public setBackgroundThrottling(value: boolean): void { this.backgroundThrottling = value; }
  public setZoomFactor(value: number): void { this.zoomFactor = value; }
  public getZoomFactor(): number { return this.zoomFactor; }
  public setUserAgent(value: string): void { this.userAgent = value; }
  public setAudioMuted(value: boolean): void { this.audioMuted = value; }
  public isAudioMuted(): boolean { return this.audioMuted; }
  public insertCSS(): Promise<string> { return Promise.resolve('css-key'); }
  public removeInsertedCSS(): Promise<void> { return Promise.resolve(); }
  public executeJavaScript(): Promise<unknown> { return Promise.resolve(undefined); }
  public invalidate(): void {}
  public focus(): void {}
  public reload(): void {}
  public stop(): void {}
  public isDevToolsOpened(): boolean { return false; }
  public openDevTools(): void {}
  public closeDevTools(): void {}
  public destroy(): void { this.destroyed = true; this.emit('destroyed'); }
  public close(): void { this.destroy(); }
}

/** WebContentsView double that records every bounds write. */
class FakeWebContentsView {
  public readonly webContents: FakeWebContents;
  public bounds: Bounds | null = null;
  public readonly boundsHistory: Bounds[] = [];
  public readonly backgrounds: string[] = [];

  constructor(_options?: unknown) { this.webContents = new FakeWebContents(); }

  public setBounds(bounds: Bounds): void {
    this.bounds = { ...bounds };
    this.boundsHistory.push({ ...bounds });
  }
  public getBounds(): Bounds { return this.bounds ?? { x: 0, y: 0, width: 0, height: 0 }; }
  public setBackgroundColor(color: string): void { this.backgrounds.push(color); }
}

class FakeContentView {
  public readonly children: unknown[] = [];

  public addChildView(view: unknown, index?: number): void {
    const existing = this.children.indexOf(view);
    if (existing >= 0) this.children.splice(existing, 1);
    if (typeof index === 'number') this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, view);
    else this.children.push(view);
  }
  public removeChildView(view: unknown): void {
    const existing = this.children.indexOf(view);
    if (existing >= 0) this.children.splice(existing, 1);
  }
}

/** BrowserWindow double: identity, content geometry, a child stack and events. */
class FakeBrowserWindow extends EventEmitter {
  public readonly contentView = new FakeContentView();
  public readonly webContents = new FakeWebContents();
  public readonly windowOptions: Record<string, unknown>;
  public readonly calls = { show: 0, showInactive: 0, focus: 0, maximize: 0, restore: 0, destroy: 0 };
  public contentBounds: Bounds;
  public destroyed = false;
  public title = '';

  constructor(options: Record<string, unknown> = {}) {
    super();
    this.windowOptions = options;
    this.contentBounds = {
      x: typeof options.x === 'number' ? options.x : 0,
      y: typeof options.y === 'number' ? options.y : 0,
      width: typeof options.width === 'number' ? options.width : 1440,
      height: typeof options.height === 'number' ? options.height : 900,
    };
  }

  public isDestroyed(): boolean { return this.destroyed; }
  public isVisible(): boolean { return !this.destroyed; }
  public isMaximized(): boolean { return false; }
  public isMinimized(): boolean { return false; }
  public getBounds(): Bounds { return { ...this.contentBounds }; }
  public getContentBounds(): Bounds { return { ...this.contentBounds }; }
  public setBounds(bounds: Partial<Bounds>): void { this.contentBounds = { ...this.contentBounds, ...bounds }; }
  public setContentBounds(bounds: Partial<Bounds>): void { this.setBounds(bounds); }
  public show(): void { this.calls.show += 1; }
  public showInactive(): void { this.calls.showInactive += 1; }
  public focus(): void { this.calls.focus += 1; }
  public maximize(): void { this.calls.maximize += 1; }
  public restore(): void { this.calls.restore += 1; }
  public minimize(): void {}
  public setTitle(title: string): void { this.title = title; }
  public getTitle(): string { return this.title; }
  public setMenuBarVisibility(): void {}
  public destroy(): void { this.calls.destroy += 1; this.destroyed = true; this.emit('closed'); }

  public static fromWebContents(): null { return null; }
  public static getFocusedWindow(): null { return null; }
  public static getAllWindows(): FakeBrowserWindow[] { return []; }
  public static fromId(): null { return null; }
}

class FakeIpcMain {
  public readonly handlers = new Map<string, unknown>();
  public readonly listeners = new Map<string, unknown>();
  public handle(channel: string, handler: unknown): void { this.handlers.set(channel, handler); }
  public on(channel: string, listener: unknown): void { this.listeners.set(channel, listener); }
  public removeHandler(channel: string): void { this.handlers.delete(channel); }
  public removeAllListeners(channel: string): void { this.listeners.delete(channel); }
  public invoke(): unknown { return undefined; }
}

const fakeIpcMain = new FakeIpcMain();
const fakeSessions = new Map<string, Record<string, unknown>>();
function fakeSessionFor(partition: string): Record<string, unknown> {
  const existing = fakeSessions.get(partition);
  if (existing) return existing;
  const created: Record<string, unknown> = {
    getUserAgent: () => '',
    setUserAgent: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    clearStorageData: () => Promise.resolve(),
    cookies: { get: () => Promise.resolve([]), set: () => Promise.resolve(), remove: () => Promise.resolve(), flushStore: () => Promise.resolve() },
    webRequest: {
      onBeforeRequest: () => {},
      onBeforeSendHeaders: () => {},
      onHeadersReceived: () => {},
      onCompleted: () => {},
      onErrorOccurred: () => {},
    },
  };
  fakeSessions.set(partition, created);
  return created;
}

const fakeElectron: Record<string, unknown> = {
  app: {
    getPath: () => path.join(SCRATCH_DIR, 'userdata'),
    getName: () => 'AntiFan',
    getVersion: () => '0.0.0-test',
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    setPath: () => {},
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: () => {}, hasSwitch: () => false },
  },
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  MenuItem: function MenuItem() {},
  clipboard: { writeText: () => {}, readText: () => '' },
  ipcMain: fakeIpcMain,
  shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
  net: {},
  session: { fromPartition: (partition: string) => fakeSessionFor(partition), defaultSession: fakeSessionFor('default') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }],
    getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    on: () => {},
    removeListener: () => {},
  },
};

const fakeSessionVaultModule = {
  LocalSessionVault: { getInstance: () => ({ registerIpcHandlers: () => {} }) },
  isTrustedSessionVaultSender: () => true,
};

const fakeCredentialVaultModule = {
  LocalCredentialVault: {
    DEFAULT_VAULT_FILENAME: 'credentials.vault',
    getInstance: () => ({ registerIpcHandlers: () => {} }),
  },
  resolveSenderFrameOrigin: () => null,
};

// The Electron-dependent modules must load AFTER the boundary is installed, so
// they are required (not imported) — a static import would run first.
const NodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalModuleLoad = NodeModule._load;
NodeModule._load = function patchedModuleLoad(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron') return fakeElectron;
  if (request.endsWith('local-session-vault')) return fakeSessionVaultModule;
  if (request.endsWith('local-credential-vault')) return fakeCredentialVaultModule;
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { NativeTabHost: HostClass } = require('../../../src/main/browser/native-tab-host') as typeof import('../../../src/main/browser/native-tab-host');
const { ProjectWindowShell: ShellClass, ownerKey } = require('../../../src/main/browser/project-window-shell') as typeof import('../../../src/main/browser/project-window-shell');
const { ProjectWindowManager: ManagerClass } = require('../../../src/main/browser/project-window-manager') as typeof import('../../../src/main/browser/project-window-manager');
const { TabAuthorityDirectory: DirectoryClass } = require('../../../src/main/browser/tab-authority-directory') as typeof import('../../../src/main/browser/tab-authority-directory');
const { setChromeSenderResolver, dispatchChromeRoute } = require('../../../src/main/browser/ipc-router') as typeof import('../../../src/main/browser/ipc-router');
const { TOOLBAR_CHANNELS, FRAME_BACKDROP_CHANNELS } = require('../../../src/shared/contracts') as typeof import('../../../src/shared/contracts');

// ---------------------------------------------------------------------------
// Fixture: two real shells, each with its own real host and two real tabs
// ---------------------------------------------------------------------------

const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'project-aaaaaaaa-0000-4000-8000-000000000001' };
const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'project-bbbbbbbb-0000-4000-8000-000000000002' };

interface TabRecord {
  view: FakeWebContentsView;
  mobileView?: FakeWebContentsView;
  focusedPane?: 'desktop' | 'mobile';
  state: Record<string, unknown> & {
    splitMode?: boolean;
    splitDesktopPresetId?: string;
    splitMobilePresetId?: string;
    splitFocusedPane?: string;
    devicePresetId?: string;
    url?: string;
  };
}

interface HostInternals {
  tabs: Map<string, TabRecord>;
  activeTabId: string;
  captureHostWindow: FakeBrowserWindow | null;
  raisedCaptureView: FakeWebContentsView | null;
}

interface ShellHarness {
  owner: WindowOwner;
  shell: ProjectWindowShell;
  host: NativeTabHost;
  window: FakeBrowserWindow;
  toolbar: FakeWebContents;
  firstTabId: string;
  secondTabId: string;
}

function internalsOf(host: NativeTabHost): HostInternals {
  return host as unknown as HostInternals;
}

function recordOf(host: NativeTabHost, tabId: string): TabRecord {
  const record = internalsOf(host).tabs.get(tabId);
  assert.ok(record, `tab ${tabId} must exist on the host that owns it`);
  return record;
}

/** chrome view handles for bounds assertions (the shell types them as Electron views). */
function viewHandle(view: unknown): FakeWebContentsView {
  return view as FakeWebContentsView;
}

function createShellHarness(owner: WindowOwner, contentBounds: Bounds): ShellHarness {
  const shell = new ShellClass({
    owner,
    title: owner.kind === 'project' ? owner.projectId : 'Unassigned',
    bounds: { x: contentBounds.x, y: contentBounds.y, width: contentBounds.width, height: contentBounds.height },
  });
  const window = shell.window as unknown as FakeBrowserWindow;
  const host = new HostClass(shell);
  // Both tabs are real host tabs created through the production path; a blank
  // URL keeps the browser's network/CDP machinery out of a layout contract.
  const firstTabId = host.createTab('about:blank', true);
  const secondTabId = host.createTab('about:blank', false);
  assert.ok(firstTabId, 'first tab must be created');
  assert.ok(secondTabId, 'second tab must be created');
  assert.equal(host.getActiveTabId(), firstTabId, 'the first tab is presented until something selects another');
  return { owner, shell, host, window, toolbar: shell.toolbarView?.webContents as unknown as FakeWebContents, firstTabId, secondTabId };
}

interface TwoShellFixture {
  a: ShellHarness;
  b: ShellHarness;
  directory: InstanceType<typeof DirectoryClass>;
  manager: InstanceType<typeof ManagerClass>;
}

async function createTwoShellFixture(): Promise<TwoShellFixture> {
  const a = createShellHarness(PROJECT_A, { x: 0, y: 0, width: 1440, height: 900 });
  const b = createShellHarness(PROJECT_B, { x: 1600, y: 0, width: 1200, height: 800 });

  const directory = new DirectoryClass();
  directory.register(a.shell, a.host);
  directory.register(b.shell, b.host);
  // The production resolver: a sender is routed to the host of the shell whose
  // chrome surface it is, never to a focused or first-registered window.
  setChromeSenderResolver((sender) => directory.resolveSender(sender.id));

  const shells = new Map([[ownerKey(a.owner), a.shell], [ownerKey(b.owner), b.shell]]);
  const manager = new ManagerClass({ createShell: (owner) => shells.get(ownerKey(owner))! });
  await manager.ensureWindow(a.owner, 'agent');
  await manager.ensureWindow(b.owner, 'agent');

  return { a, b, directory, manager };
}

/**
 * The shell a tab resolves to: the directory's answer for the host that holds the tab,
 * mapped through the manager's own shell list — index.ts's lookup, never a second index.
 */
function shellOfTab(
  manager: InstanceType<typeof ManagerClass>,
  directory: InstanceType<typeof DirectoryClass>,
  tabId: string
): ProjectWindowShell | undefined {
  const host = directory.hostForTab(tabId);
  return host ? manager.listShells().find((shell) => directory.hostForShell(shell) === host) : undefined;
}

/** Observed layout/capture state of one shell, used to prove it never moves. */
interface ShellSnapshot {
  chromeBounds: Array<Bounds | null>;
  chromeWrites: number[];
  childOrder: unknown[];
  tabStates: Array<{ id: string; state: Record<string, unknown> }>;
  tabBounds: Array<{ id: string; bounds: Bounds | null; writes: number }>;
  activeTabId: string;
  captureHostOpen: boolean;
  raisedCaptureView: unknown;
}

function snapshotShell(harness: ShellHarness): ShellSnapshot {
  const { host, shell } = harness;
  const tabs = internalsOf(host).tabs;
  return {
    chromeBounds: [shell.toolbarView, shell.sidebarView, shell.frameBackdropView].map((view) => (view ? (viewHandle(view).bounds ? { ...viewHandle(view).bounds! } : null) : null)),
    chromeWrites: [shell.toolbarView, shell.sidebarView, shell.frameBackdropView].map((view) => (view ? viewHandle(view).boundsHistory.length : 0)),
    childOrder: [...harness.window.contentView.children],
    tabStates: [...tabs.entries()].map(([id, record]) => ({ id, state: { ...record.state } })),
    tabBounds: [...tabs.entries()].map(([id, record]) => ({
      id,
      bounds: record.view.bounds ? { ...record.view.bounds } : null,
      writes: record.view.boundsHistory.length,
    })),
    activeTabId: host.getActiveTabId(),
    captureHostOpen: internalsOf(host).captureHostWindow !== null,
    raisedCaptureView: internalsOf(host).raisedCaptureView,
  };
}

function layoutMessages(webContents: FakeWebContents, channel: string): Array<Record<string, unknown>> {
  return webContents.sent
    .filter((message) => message.channel === channel)
    .map((message) => (message.args[0] ?? {}) as Record<string, unknown>);
}

describe('project window per-shell layout isolation', () => {
  it('keeps an independent local active tab per shell and never moves the other shell on selection', async () => {
    const { a, b, directory, manager } = await createTwoShellFixture();
    const aFirst = recordOf(a.host, a.firstTabId);
    const bFirst = recordOf(b.host, b.firstTabId);

    assert.notEqual(a.host.getActiveTabId(), b.host.getActiveTabId(), 'two shells must not share one active tab id');
    assert.notEqual(aFirst.state, bFirst.state, 'tab states must be distinct objects, not one shared record');

    // Each window holds only its own presented pane.
    assert.ok(a.window.contentView.children.includes(aFirst.view), "A must present A's own tab view");
    assert.ok(b.window.contentView.children.includes(bFirst.view), "B must present B's own tab view");
    assert.ok(!a.window.contentView.children.includes(bFirst.view), "A's window must never hold B's view");
    assert.ok(!b.window.contentView.children.includes(aFirst.view), "B's window must never hold A's view");

    // The authority binds each tab to the host that holds it, before the selection happens.
    assert.equal(directory.hostForTab(a.firstTabId), a.host);
    assert.equal(directory.hostForTab(b.firstTabId), b.host);

    // Explicit local selection in A, through A's own toolbar sender. The route answers with
    // whether it accepted the target: the MCP authority path reads that value
    // (`requireActivatedTab`) to tell a refused activation from an accepted one.
    const switched = dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.SWITCH_TAB, a.toolbar as unknown as WebContents, [a.secondTabId]);
    assert.equal(switched, true, "A's own toolbar is allowed to select A's second tab");

    assert.equal(a.host.getActiveTabId(), a.secondTabId, "A must select A's second tab");
    assert.equal(b.host.getActiveTabId(), b.firstTabId, "B's active tab must not follow A's selection");
    assert.ok(a.window.contentView.children.includes(recordOf(a.host, a.secondTabId).view), 'the newly selected A tab is presented in A');
    assert.ok(b.window.contentView.children.includes(bFirst.view), 'B keeps presenting its own tab');
    assert.deepEqual(shellOfTab(manager, directory, b.firstTabId)?.owner, b.owner, "B's tab ownership must not move when A selects");
    assert.equal(shellOfTab(manager, directory, b.firstTabId), b.shell, "B's tab must still resolve to B's shell");
  });

  it('routes a split-review change to the sender shell\'s own active tab only', async () => {
    const { a, b } = await createTwoShellFixture();
    const bChildrenBefore = [...b.window.contentView.children];
    const bBackdropBefore = b.shell.frameBackdropView ? viewHandle(b.shell.frameBackdropView).boundsHistory.length : 0;

    const enabled = dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.TOGGLE_SPLIT_REVIEW, a.toolbar as unknown as WebContents, [{ enabled: true }]);
    assert.equal(enabled, true, "A's toolbar enables split review on A's active tab");

    const aActive = recordOf(a.host, a.firstTabId);
    const aIdle = recordOf(a.host, a.secondTabId);
    const bActive = recordOf(b.host, b.firstTabId);
    assert.equal(aActive.state.splitMode, true, "A's active tab enters split review");
    assert.ok(aActive.mobileView, "A's split tab owns a mobile pane");
    assert.ok(a.window.contentView.children.includes(aActive.mobileView!), "the mobile pane is presented in A's window");
    assert.notEqual(aIdle.state.splitMode, true, "A's inactive tab must not enter split review");
    assert.notEqual(bActive.state.splitMode, true, "B's tab must not enter split review");
    assert.equal(bActive.mobileView, undefined, "B's tab must not gain a mobile pane");
    assert.deepEqual(b.window.contentView.children, bChildrenBefore, "B's view stack must be untouched");
    assert.equal(b.shell.frameBackdropView ? viewHandle(b.shell.frameBackdropView).boundsHistory.length : 0, bBackdropBefore, "B's backdrop must not be re-laid-out");

    // Observed calls: only A's own chrome was told about the split layout.
    const aSplitMessages = layoutMessages(a.shell.frameBackdropView!.webContents as unknown as FakeWebContents, FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT).filter((payload) => payload.splitMode === true);
    const bSplitMessages = layoutMessages(b.shell.frameBackdropView!.webContents as unknown as FakeWebContents, FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT).filter((payload) => payload.splitMode === true);
    assert.ok(aSplitMessages.length > 0, "A's backdrop must receive A's split layout");
    assert.equal(bSplitMessages.length, 0, "B's backdrop must never receive A's split layout");

    // A foreign tab id arriving through A's toolbar is refused, not re-parented.
    const foreign = dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.TOGGLE_SPLIT_REVIEW, a.toolbar as unknown as WebContents, [{ tabId: b.firstTabId, enabled: true }]);
    assert.equal(foreign, false, "A's toolbar may not toggle split on a tab owned by B");
    assert.notEqual(recordOf(b.host, b.firstTabId).state.splitMode, true, "the refused change left B's tab untouched");

    // B's own toolbar targets B's own active tab.
    const bEnabled = dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.TOGGLE_SPLIT_REVIEW, b.toolbar as unknown as WebContents, [{ enabled: true }]);
    assert.equal(bEnabled, true, "B's toolbar enables split review on B's active tab");
    assert.equal(recordOf(b.host, b.firstTabId).state.splitMode, true, "B's own tab enters split review");
    assert.equal(recordOf(a.host, a.firstTabId).state.splitMode, true, "A's tab is unaffected by B's toggle");
    assert.ok(b.window.contentView.children.includes(recordOf(b.host, b.firstTabId).mobileView!), "B's mobile pane is presented in B's window");
  });

  it('keeps split presets and device presets per shell and refuses a foreign tab id', async () => {
    const { a, b } = await createTwoShellFixture();

    // Split presets are per-tab state on the shell's own host.
    assert.equal(dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.TOGGLE_SPLIT_REVIEW, a.toolbar as unknown as WebContents, [{ enabled: true }]), true);
    assert.equal(dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.SET_SPLIT_PRESET, a.toolbar as unknown as WebContents, [{ paneId: 'mobile', presetId: 'ipad-mini' }]), true);

    const aRecord = recordOf(a.host, a.firstTabId);
    const bRecord = recordOf(b.host, b.firstTabId);
    assert.equal(aRecord.state.splitMobilePresetId, 'ipad-mini', "A's split tab keeps its own mobile preset");
    assert.equal(bRecord.state.splitMobilePresetId, undefined, "B's tab must not inherit A's split preset");
    assert.notEqual(bRecord.state.splitMode, true, "B's tab must stay out of split review");

    // Device presets: A's choice lands on A's active tab only.
    assert.equal(dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.SET_DEVICE_PRESET, a.toolbar as unknown as WebContents, [{ presetId: 'desktop-fhd' }]), true);
    assert.equal(recordOf(a.host, a.firstTabId).state.devicePresetId, 'desktop-fhd', "A's active tab takes the requested preset");
    assert.equal(recordOf(a.host, a.secondTabId).state.devicePresetId, 'responsive', "A's inactive tab keeps its own preset");
    assert.equal(recordOf(b.host, b.firstTabId).state.devicePresetId, 'responsive', "B's tab must not take A's device preset");

    // The reverse direction holds too: B's choice stays in B.
    assert.equal(dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.SET_DEVICE_PRESET, b.toolbar as unknown as WebContents, [{ presetId: 'ipad-mini' }]), true);
    assert.equal(recordOf(b.host, b.firstTabId).state.devicePresetId, 'ipad-mini', "B's active tab takes its own preset");
    assert.equal(recordOf(a.host, a.firstTabId).state.devicePresetId, 'desktop-fhd', "A's preset is untouched by B's change");

    // A foreign tab id is rejected by the sender's own host.
    assert.equal(dispatchChromeRoute(HostClass.CHROME_ROUTES, TOOLBAR_CHANNELS.SET_DEVICE_PRESET, a.toolbar as unknown as WebContents, [{ tabId: b.firstTabId, presetId: 'tablet-ipad-pro' }]), false);
    assert.equal(recordOf(b.host, b.firstTabId).state.devicePresetId, 'ipad-mini', "a refused device change must not reach B");
  });

  it('resizing A moves only A\'s bounds and leaves B\'s bounds, presented page and capture state unchanged', async () => {
    const { a, b } = await createTwoShellFixture();
    const bBefore = snapshotShell(b);
    const aToolbarWritesBefore = viewHandle(a.shell.toolbarView).boundsHistory.length;
    const aTabWritesBefore = recordOf(a.host, a.firstTabId).view.boundsHistory.length;

    a.window.contentBounds = { ...a.window.contentBounds, width: 1180, height: 760 };
    a.window.emit('resize');

    // Positive control: A really was re-laid-out by its own resize event.
    assert.ok(viewHandle(a.shell.toolbarView).boundsHistory.length > aToolbarWritesBefore, "A's toolbar must be re-laid-out on A's resize");
    assert.ok(recordOf(a.host, a.firstTabId).view.boundsHistory.length > aTabWritesBefore, "A's tab view must be re-laid-out on A's resize");
    assert.deepEqual(viewHandle(a.shell.toolbarView).bounds, { x: 0, y: 0, width: 1180, height: 76 }, "A's toolbar takes the new content width");
    assert.deepEqual(recordOf(a.host, a.firstTabId).view.bounds, { x: 0, y: 76, width: 1180, height: 684 }, "A's presented tab fills A's new content box");

    // B is untouched by every observable measure this suite can take.
    assert.deepEqual(snapshotShell(b), bBefore, "B's chrome bounds, tab states, tab bounds, view stack, active tab and capture state must be untouched by A's resize");
    assert.equal(recordOf(b.host, b.firstTabId).view.bounds?.width, 1200, "B's presented tab keeps B's own width");
  });

  it('keeps capture-host ownership inside the shell that raised the pane', async () => {
    const { a, b } = await createTwoShellFixture();
    // raiseViewForCapture takes the Electron view; the recording double stands in for it.
    const aView = recordOf(a.host, a.firstTabId).view as unknown as WebContentsView;
    const bView = recordOf(b.host, b.firstTabId).view as unknown as WebContentsView;
    const bChildrenBefore = [...b.window.contentView.children];

    // Raising A's pane parks it on A's own off-screen capture window.
    a.host.raiseViewForCapture(aView);
    const aCaptureHost = internalsOf(a.host).captureHostWindow;
    assert.ok(aCaptureHost, "A's capture raise creates A's own capture host");
    assert.equal(internalsOf(a.host).raisedCaptureView, aView, "A raises its own pane for capture");
    assert.ok(aCaptureHost!.contentView.children.includes(aView), "A's pane is hosted by A's own capture window");
    assert.ok(!a.window.contentView.children.includes(aView), "a captured pane leaves A's own window stack");

    assert.equal(internalsOf(b.host).captureHostWindow, null, "A's capture must not create a capture host for B");
    assert.equal(internalsOf(b.host).raisedCaptureView, null, "B must never inherit A's raised capture pane");
    assert.deepEqual(b.window.contentView.children, bChildrenBefore, "A's capture must not paint into B's window");
    assert.ok(b.window.contentView.children.includes(bView), "B keeps presenting its own tab while A captures");
    assert.ok(!b.window.contentView.children.includes(aView), "A's pane must never enter B's view stack");

    // B's own capture uses B's own host and leaves A's alone.
    b.host.raiseViewForCapture(bView);
    const bCaptureHost = internalsOf(b.host).captureHostWindow;
    assert.ok(bCaptureHost, "B's capture raise creates B's own capture host");
    assert.notEqual(bCaptureHost, aCaptureHost, "each shell owns a separate capture host window");
    assert.equal(internalsOf(b.host).raisedCaptureView, bView, "B raises its own pane");
    assert.ok(bCaptureHost!.contentView.children.includes(bView), "B's pane is hosted by B's own capture window");
    assert.ok(!b.window.contentView.children.includes(bView), "B's captured pane leaves B's window stack");
    assert.equal(internalsOf(a.host).raisedCaptureView, aView, "A's raised pane survives B's capture");
    assert.ok(aCaptureHost!.contentView.children.includes(aView), "A's capture host still holds A's pane");

    // Lowering B's capture returns B's pane to B's window and touches nothing in A.
    b.host.reassertPresentedView();
    assert.equal(internalsOf(b.host).raisedCaptureView, null, "B's reassert lowers only B's raised pane");
    assert.ok(b.window.contentView.children.includes(bView), "B's pane returns to B's own window");
    assert.equal(internalsOf(a.host).raisedCaptureView, aView, "A's raised pane must survive B's reassert");
    assert.ok(aCaptureHost!.contentView.children.includes(aView), "A's capture host is untouched by B's reassert");
    assert.equal(internalsOf(b.host).captureHostWindow, bCaptureHost, "B's own capture host stays B's");
  });
});
