/**
 * Project windows: one shell per owner, a serialized open that never presents
 * for agent intent, record-owned titles, per-shell local state, and the
 * lifecycle API the close path uses.
 *
 * The manager never constructs a BrowserWindow itself — createShell is injected —
 * so no case here needs a real Electron process. The first suite drives
 * hand-written shell doubles to pin the directory's contract; the second runs
 * real ProjectWindowShell instances over a stubbed Electron seam, which lets a
 * case assert what the code did *not* do (no show, focus, maximize or raise)
 * and read back the views, window options and loads it produced.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, WebContentsView } from 'electron';
import { ProjectWindowManager, type OpenIntent } from '../../src/main/browser/project-window-manager';
import {
  PageCloseReservations,
  ProjectCloseCoordinator,
  type CloseSurface,
  type LiveUseReport,
  type LiveUseRequest,
} from '../../src/main/browser/project-close-coordinator';
import { TabAuthorityDirectory } from '../../src/main/browser/tab-authority-directory';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  ProjectWindowShell,
  ownerKey,
  ownerLabel,
  type ProjectWindowShellOptions,
  type ShellDisplayInfo,
  type ShellNativeSeam,
  type WindowOwner,
} from '../../src/main/browser/project-window-shell';

const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'project-aaaaaaaa-0000-4000-8000-000000000001' };
const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'project-bbbbbbbb-0000-4000-8000-000000000002' };

interface FakeShell {
  destroyed: boolean;
  chromeDisposed: number;
  ownedWebContentsIds: number[];
}

function makeShell(
  owner: WindowOwner,
  destroyed = false
): { shell: ProjectWindowShell; state: FakeShell; emitClosed: () => void } {
  const state: FakeShell = { destroyed, chromeDisposed: 0, ownedWebContentsIds: [] };
  const closedListeners = new Set<() => void>();
  const shell = {
    owner,
    window: {
      isDestroyed: () => state.destroyed,
    },
    onClosed: (listener: () => void) => {
      closedListeners.add(listener);
      return () => { closedListeners.delete(listener); };
    },
    ownsChromeWebContents: (id: number) => state.ownedWebContentsIds.includes(id),
    disposeChrome: () => { state.chromeDisposed += 1; },
  } as unknown as ProjectWindowShell;
  return {
    shell,
    state,
    emitClosed: () => {
      state.destroyed = true;
      for (const listener of [...closedListeners]) listener();
    },
  };
}

function makeManager(options: {
  createShell: (owner: WindowOwner, intent: OpenIntent) => ProjectWindowShell;
  onPresent?: (shell: ProjectWindowShell) => void;
}): ProjectWindowManager {
  return new ProjectWindowManager({
    createShell: options.createShell,
    presentShell: options.onPresent,
  });
}

/**
 * One window's tab authority, as these cases need it: the real `NativeTabHost` surface
 * the production wiring reads (`hasTab`, `getTabList`, `visibleMemberTabIds`,
 * `windowOwnerKey`), with membership a case can open and close. The manager keeps no
 * page state of its own, so which pages a window presents is answered here — by the
 * host that owns them — and a disposed host answers nothing, exactly as production.
 */
interface WindowHost {
  host: NativeTabHost;
  openTab(tabId: string): void;
  closeTab(tabId: string): void;
  dispose(): void;
  /** This window's own pages, through the production accessor. */
  tabIds(): string[];
}

function makeHost(owner: WindowOwner, tabIds: readonly string[] = []): WindowHost {
  const order = [...tabIds];
  let disposed = false;
  const host = {
    hasTab: (tabId?: string | null) => !disposed && typeof tabId === 'string' && order.includes(tabId),
    getTabList: () => (disposed ? [] : order.map((id) => ({ id }))),
    visibleMemberTabIds: () => (disposed ? [] : [...order]),
    windowOwnerKey: () => ownerKey(owner),
  } as unknown as NativeTabHost;
  return {
    host,
    openTab: (tabId) => { if (!order.includes(tabId)) order.push(tabId); },
    closeTab: (tabId) => {
      const at = order.indexOf(tabId);
      if (at >= 0) order.splice(at, 1);
    },
    dispose: () => { disposed = true; order.length = 0; },
    tabIds: () => host.getTabList().map((tab) => tab.id),
  };
}

/** The window's own tab authority; a shell created by `createShellFor` always has one. */
function hostOf(stub: NativeStub, shell: ProjectWindowShell): WindowHost {
  const windowHost = stub.hosts.get(shell);
  assert.ok(windowHost, 'a shell created by createShellFor registers its own host');
  return windowHost;
}

/** The window host a tab resolves to, read through the real authority directory. */
function hostForTab(stub: NativeStub, tabId: string): WindowHost | undefined {
  const host = stub.directory.hostForTab(tabId);
  return host ? [...stub.hosts.values()].find((candidate) => candidate.host === host) : undefined;
}

/** index.ts's shell lookup: the shell that presents the host owning a tab. */
function shellForTab(
  directory: TabAuthorityDirectory,
  manager: ProjectWindowManager,
  tabId: string
): ProjectWindowShell | undefined {
  const host = directory.hostForTab(tabId);
  return host ? manager.listShells().find((shell) => directory.hostForShell(shell) === host) : undefined;
}

/**
 * index.ts's `withHostMembers`: a browser surface's live member list is read from the tab
 * authority that presents the shell — under-reporting is the dangerous direction — and only
 * a shell that is already gone falls back to the surface's own (loud) answer.
 */
function withHostMembers(
  surface: CloseSurface,
  manager: ProjectWindowManager,
  directory: TabAuthorityDirectory
): CloseSurface {
  if (surface.kind !== 'browser') return surface;
  return {
    ...surface,
    visibleMemberIds: () => {
      const shell = manager.listShells().find((candidate) => ownerKey(candidate.owner) === surface.key);
      const host = shell ? directory.hostForShell(shell) : undefined;
      return host ? host.visibleMemberTabIds() : surface.visibleMemberIds();
    },
  };
}

describe('ProjectWindowManager window directory', () => {
  it('collapses concurrent opens for one owner into a single window and a single result', async () => {
    let created = 0;
    const made = makeShell(PROJECT_A);
    const manager = makeManager({
      createShell: () => { created += 1; return made.shell; },
    });

    const [first, second] = await Promise.all([
      manager.ensureWindow(PROJECT_A, 'user'),
      manager.ensureWindow(PROJECT_A, 'user'),
    ]);

    assert.strictEqual(created, 1, 'a double open must create one window');
    assert.strictEqual(first, second, 'both callers must observe the same shell');
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('keeps the window already on screen when a second creation races it', async () => {
    const winner = makeShell(PROJECT_A);
    const loser = makeShell(PROJECT_A);
    const created: ProjectWindowShell[] = [];
    const manager = makeManager({
      createShell: () => {
        const shell = created.length === 0 ? winner.shell : loser.shell;
        created.push(shell);
        return shell;
      },
    });

    const settled = await manager.ensureWindow(PROJECT_A, 'user');
    const raced = await manager.ensureWindow(PROJECT_A, 'user');

    assert.strictEqual(settled, winner.shell);
    assert.strictEqual(raced, winner.shell, 'the live shell is never replaced');
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('leaves no dead mapping when initialization fails and allows a later explicit open', async () => {
    let attempts = 0;
    const recovered = makeShell(PROJECT_A);
    const manager = makeManager({
      createShell: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('shell initialization failed');
        return recovered.shell;
      },
    });

    await assert.rejects(manager.ensureWindow(PROJECT_A, 'user'), /shell initialization failed/);
    assert.strictEqual(manager.browserShellCount(), 0);

    const shell = await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(shell, recovered.shell, 'a failed open must not poison the owner mapping');
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('presents an existing window for user intent and never for agent intent', async () => {
    const presented: ProjectWindowShell[] = [];
    const made = makeShell(PROJECT_A);
    const manager = makeManager({
      createShell: () => made.shell,
      onPresent: (shell) => presented.push(shell),
    });

    const created = await manager.ensureWindow(PROJECT_A, 'agent');
    assert.deepStrictEqual(presented, [], 'agent intent must never present a window');

    const againByUser = await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(againByUser, created);
    assert.deepStrictEqual(presented, [made.shell], 'user intent presents the window it reuses');
  });

  it('routes a sender to the shell that owns it and refuses an unknown sender', async () => {
    const alpha = makeShell(PROJECT_A);
    const beta = makeShell(PROJECT_B);
    alpha.state.ownedWebContentsIds.push(11);
    beta.state.ownedWebContentsIds.push(22);
    let created = 0;
    const manager = makeManager({
      createShell: () => (created++ === 0 ? alpha.shell : beta.shell),
    });

    await manager.ensureWindow(PROJECT_A, 'user');
    await manager.ensureWindow(PROJECT_B, 'user');

    assert.strictEqual(manager.shellForSender(11), alpha.shell);
    assert.strictEqual(manager.shellForSender(22), beta.shell);
    assert.strictEqual(manager.shellForSender(99), undefined, 'unknown senders fail closed');
  });

  it('keeps a live tab on the host that owns it and never re-parents it into another window', async () => {
    const alpha = makeShell(PROJECT_A);
    const beta = makeShell(PROJECT_B);
    let created = 0;
    const manager = makeManager({
      createShell: () => (created++ === 0 ? alpha.shell : beta.shell),
    });

    await manager.ensureWindow(PROJECT_A, 'user');

    // The authority is the hosts themselves: a window's host is registered when its shell
    // is admitted, and a tab resolves to the host that holds it.
    const directory = new TabAuthorityDirectory();
    const alphaHost = makeHost(PROJECT_A, ['tab-1']);
    directory.register(alpha.shell, alphaHost.host);
    const hostBefore = directory.hostForTab('tab-1');
    assert.strictEqual(hostBefore, alphaHost.host);
    assert.strictEqual(shellForTab(directory, manager, 'tab-1'), alpha.shell);

    // Admitting a second window is the operation that used to re-parent the tab into it.
    await manager.ensureWindow(PROJECT_B, 'user');
    const betaHost = makeHost(PROJECT_B);
    directory.register(beta.shell, betaHost.host);

    assert.strictEqual(directory.hostForTab('tab-1'), hostBefore, 'a live window keeps its tab');
    assert.strictEqual(shellForTab(directory, manager, 'tab-1'), alpha.shell);
    assert.strictEqual(betaHost.host.hasTab('tab-1'), false, 'the new window never holds another window\'s tab');

    // A window that is gone stops answering for its tabs, and the tab resolves only through
    // the host that actually holds it — including after it changes hands while A is gone.
    alpha.state.destroyed = true;
    assert.strictEqual(directory.hostForTab('tab-1'), undefined);
    betaHost.openTab('tab-1');
    assert.strictEqual(directory.hostForTab('tab-1'), betaHost.host);
    assert.strictEqual(shellForTab(directory, manager, 'tab-1'), beta.shell);

    // Releasing a tab through the real path — its host drops it — ends resolution for it.
    betaHost.closeTab('tab-1');
    assert.strictEqual(directory.hostForTab('tab-1'), undefined);
  });

  it('keeps another window\'s presentation usable after one window is disposed', async () => {
    const alpha = makeShell(PROJECT_A);
    const beta = makeShell(PROJECT_B);
    let created = 0;
    const manager = makeManager({
      createShell: () => (created++ === 0 ? alpha.shell : beta.shell),
    });

    await manager.ensureWindow(PROJECT_A, 'user');
    await manager.ensureWindow(PROJECT_B, 'user');

    const directory = new TabAuthorityDirectory();
    const betaHost = makeHost(PROJECT_B, ['tab-beta']);
    directory.register(beta.shell, betaHost.host);

    alpha.state.destroyed = true;
    manager.notifyShellGone(PROJECT_A);

    assert.strictEqual(manager.browserShellCount(), 1);
    assert.deepStrictEqual(manager.listShells(), [beta.shell]);
    assert.strictEqual(directory.hostForTab('tab-beta'), betaHost.host, 'a surviving window keeps its tab');
    const survivingShell = shellForTab(directory, manager, 'tab-beta');
    assert.strictEqual(survivingShell, beta.shell);
    assert.deepStrictEqual(survivingShell?.owner, PROJECT_B);
    assert.deepStrictEqual(betaHost.tabIds(), ['tab-beta']);
    assert.strictEqual(beta.state.chromeDisposed, 0, 'disposal of one window never tears down another');
  });

  it('opens a fresh window for the same owner after the previous one was destroyed', async () => {
    const first = makeShell(PROJECT_A);
    const second = makeShell(PROJECT_A);
    let created = 0;
    const manager = makeManager({
      createShell: () => (created++ === 0 ? first.shell : second.shell),
    });

    const original = await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(original, first.shell);

    first.state.destroyed = true;
    const reopened = await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(reopened, second.shell, 'a destroyed shell is replaced, not returned');
  });
});

/**
 * The manager and the shell never construct native objects here: every case
 * below runs a real ProjectWindowShell over a stubbed Electron seam, so a case
 * can assert what the code did *not* do — no show, focus, maximize or raise —
 * and can read back the views, loads and bindings it produced.
 */
interface ShellRecord {
  title: string;
  pathLabel?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

const RECORD_A: ShellRecord = { title: 'Project Alpha', pathLabel: 'E:/work/alpha', x: 100, y: 80, width: 1600, height: 900 };
const RECORD_B: ShellRecord = { title: 'Project Beta', pathLabel: 'E:/work/beta', x: 2000, y: 100, width: 1024, height: 700 };
/** A project with no saved placement: WindowState resolves size only, never coordinates. */
const RECORD_UNPOSITIONED: ShellRecord = { title: 'Project Gamma', pathLabel: 'E:/work/gamma', width: 1360, height: 880 };

function createDisplaySet(): { primary: ShellDisplayInfo; secondary: ShellDisplayInfo; tertiary: ShellDisplayInfo } {
  return {
    primary: { id: 11, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    secondary: { id: 22, scaleFactor: 1.5, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
    tertiary: { id: 33, scaleFactor: 2, bounds: { x: 4480, y: 0, width: 1280, height: 1024 }, workArea: { x: 4480, y: 0, width: 1280, height: 984 } },
  };
}

interface NativeCalls {
  show: number;
  showInactive: number;
  focus: number;
  maximize: number;
  unmaximize: number;
  restore: number;
  center: number;
  destroy: number;
  close: number;
}

type Rect = { x: number; y: number; width: number; height: number };

/** Electron's `Event`: `preventDefault()` plus the final state of a dispatch. */
interface PreventableEvent {
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function makeEvent(): PreventableEvent {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

/** Every call that presents a window to the user. Agent-driven work must make none of them. */
const PRESENTATION_CALLS: ReadonlyArray<keyof NativeCalls> = ['show', 'showInactive', 'focus', 'maximize', 'unmaximize', 'restore'];

class StubWebContents {
  public readonly id: number;
  public readonly mainFrame: { url: string } = { url: '' };
  public destroyed = false;
  /** Every page event this content emitted, for veto and terminal-state assertions. */
  public readonly emitted: Array<{ event: string; payload: PreventableEvent }> = [];
  private readonly recordLoad: (url: string) => void;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(id: number, recordLoad: (url: string) => void) {
    this.id = id;
    this.recordLoad = recordLoad;
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (existing && index >= 0) existing.splice(index, 1);
    return this;
  }

  /** Emit a page event the shell observes; returns the event object for veto assertions. */
  public emitEvent(event: string, payload: PreventableEvent = makeEvent()): PreventableEvent {
    this.emitted.push({ event, payload });
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
    return payload;
  }

  public listenerEvents(): string[] { return [...this.listeners.keys()]; }

  public loadFile(file: string): void {
    this.mainFrame.url = pathToFileURL(file).href;
    this.recordLoad(this.mainFrame.url);
  }

  public loadURL(url: string): void {
    this.mainFrame.url = url;
    this.recordLoad(url);
  }

  public getURL(): string { return this.mainFrame.url; }
  public isDestroyed(): boolean { return this.destroyed; }
  public destroy(): void { this.destroyed = true; this.emitEvent('destroyed'); }
  public close(): void { this.destroyed = true; this.emitEvent('destroyed'); }
}

class StubView {
  public readonly webContents: StubWebContents;
  public readonly backgroundColors: string[] = [];
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(id: number, recordLoad: (url: string) => void) {
    this.webContents = new StubWebContents(id, recordLoad);
  }

  public setBackgroundColor(color: string): void { this.backgroundColors.push(color); }
  public setBounds(rect: Rect): void { this.bounds = { ...rect }; }
  public getBounds(): Rect { return { ...this.bounds }; }
}

class StubWindow {
  public readonly options: Electron.BrowserWindowConstructorOptions;
  public readonly calls: NativeCalls = { show: 0, showInactive: 0, focus: 0, maximize: 0, unmaximize: 0, restore: 0, center: 0, destroy: 0, close: 0 };
  public readonly children: unknown[] = [];
  public readonly contentView: { children: unknown[]; addChildView: (view: unknown) => void; removeChildView: (view: unknown) => void };
  /** The window's own document. Electron destroys it with the window; the shell inspects it for unload vetoes. */
  public readonly webContents: StubWebContents;
  public destroyed = false;
  public visible = false;
  public minimized = false;
  public maximized = false;
  public title: string;
  /** Model a close whose destruction settles later than the request. */
  public autoClose = true;
  /** Model a document that vetoes its own unload: close event first, then will-prevent-unload. */
  public documentVeto = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private readonly onceWrappers = new Map<(...args: unknown[]) => void, (...args: unknown[]) => void>();
  private bounds: Rect;
  private contentBounds: Rect;

  constructor(options: Electron.BrowserWindowConstructorOptions, webContentsId: number) {
    this.options = options;
    this.title = typeof options.title === 'string' ? options.title : '';
    this.webContents = new StubWebContents(webContentsId, () => {});
    this.bounds = {
      x: typeof options.x === 'number' ? options.x : 0,
      y: typeof options.y === 'number' ? options.y : 0,
      width: typeof options.width === 'number' ? options.width : 800,
      height: typeof options.height === 'number' ? options.height : 600,
    };
    this.contentBounds = { ...this.bounds };
    this.contentView = {
      children: this.children,
      addChildView: (view: unknown) => { if (!this.children.includes(view)) this.children.push(view); },
      removeChildView: (view: unknown) => {
        const index = this.children.indexOf(view);
        if (index >= 0) this.children.splice(index, 1);
      },
    };
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.onceWrappers.delete(listener);
      this.removeListener(event, wrapped);
      listener(...args);
    };
    this.onceWrappers.set(listener, wrapped);
    return this.on(event, wrapped);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = this.onceWrappers.get(listener);
    if (wrapped) {
      this.onceWrappers.delete(listener);
      return this.removeListener(event, wrapped);
    }
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (existing && index >= 0) existing.splice(index, 1);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    // Electron's own contract: the window follows its page title unless a
    // listener refuses the event.
    if (event === 'page-title-updated') {
      const titleEvent = args[0] as { defaultPrevented?: boolean } | undefined;
      const nextTitle = args[1];
      if (typeof nextTitle === 'string' && !titleEvent?.defaultPrevented) this.title = nextTitle;
    }
  }

  public listenerEvents(): string[] { return [...this.listeners.keys()]; }

  public isDestroyed(): boolean { return this.destroyed; }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.calls.destroy += 1;
    // Electron destroys the window's own document with the window. Child view contents are
    // deliberately left to the shell's own disposal: that is what makes the shell's leak
    // check load-bearing instead of incidental.
    this.webContents.destroy();
    this.emit('closed');
  }

  /**
   * A native close request, as Electron's `BrowserWindow.close()` produces it: the `close`
   * event runs first, a prevented event cancels the close, and an unprevented one proceeds to
   * the document's unload — a document veto surfaces as `will-prevent-unload` and keeps the
   * window alive.
   */
  public close(): PreventableEvent {
    this.calls.close += 1;
    const event = makeEvent();
    this.emit('close', event);
    if (event.defaultPrevented) return event;
    if (this.documentVeto) {
      this.webContents.emitEvent('will-prevent-unload');
      return event;
    }
    if (this.autoClose) this.destroy();
    return event;
  }

  public getBounds(): Rect { return { ...this.bounds }; }
  public setBounds(rect: Rect): void { this.bounds = { ...rect }; this.contentBounds = { ...rect }; }
  public getContentBounds(): Rect { return { ...this.contentBounds }; }
  public setContentBounds(rect: Rect): void { this.contentBounds = { ...rect }; }
  public isVisible(): boolean { return this.visible; }
  public isMinimized(): boolean { return this.minimized; }
  public isMaximized(): boolean { return this.maximized; }
  public show(): void { this.calls.show += 1; this.visible = true; }
  public showInactive(): void { this.calls.showInactive += 1; this.visible = true; }
  public focus(): void { this.calls.focus += 1; }
  public maximize(): void { this.calls.maximize += 1; this.maximized = true; }
  public unmaximize(): void { this.calls.unmaximize += 1; this.maximized = false; }
  public restore(): void { this.calls.restore += 1; this.minimized = false; }
  public center(): void { this.calls.center += 1; }
  public setTitle(title: string): void { this.title = title; }
  public getTitle(): string { return this.title; }
}

interface NativeStub {
  seam: ShellNativeSeam;
  windows: StubWindow[];
  views: StubView[];
  loads: string[];
  displays: ShellDisplayInfo[];
  /** The tab authority's own directory: one host per admitted shell, as index.ts keeps. */
  directory: TabAuthorityDirectory;
  hosts: Map<ProjectWindowShell, WindowHost>;
}

function createNativeStub(displays?: ShellDisplayInfo[]): NativeStub {
  const windows: StubWindow[] = [];
  const views: StubView[] = [];
  const loads: string[] = [];
  const displayList = displays ?? [createDisplaySet().primary];
  let nextWebContentsId = 100;
  // Window documents get their own id space: view ids stay exactly as they were before the
  // window's own webContents existed in this stub.
  let nextWindowDocumentId = 1;
  return {
    windows,
    views,
    loads,
    displays: displayList,
    directory: new TabAuthorityDirectory(),
    hosts: new Map<ProjectWindowShell, WindowHost>(),
    seam: {
      createWindow: (options) => {
        const window = new StubWindow(options, nextWindowDocumentId);
        nextWindowDocumentId += 1;
        windows.push(window);
        return window as unknown as BrowserWindow;
      },
      createView: (options) => {
        const view = new StubView(nextWebContentsId, (url) => loads.push(url));
        nextWebContentsId += 1;
        views.push(view);
        return view as unknown as WebContentsView;
      },
      displayForBounds: (bounds) => {
        // The real seam snapshots the display, so a later metrics change is only
        // observable through a refresh — the stub must model that, not hand back
        // a live object reference.
        const found = displayList.find((display) => (
          bounds.x >= display.bounds.x && bounds.x < display.bounds.x + display.bounds.width
          && bounds.y >= display.bounds.y && bounds.y < display.bounds.y + display.bounds.height
        )) ?? displayList[0];
        if (!found) return undefined;
        return {
          id: found.id,
          scaleFactor: found.scaleFactor,
          bounds: { ...found.bounds },
          workArea: { ...found.workArea },
        };
      },
    },
  };
}

function createShellFor(stub: NativeStub, owner: WindowOwner, record: ShellRecord, show = false): ProjectWindowShell {
  const options: ProjectWindowShellOptions = {
    owner,
    title: record.title,
    pathLabel: record.pathLabel,
    bounds: { x: record.x, y: record.y, width: record.width ?? 1280, height: record.height ?? 800 },
    show,
  };
  const shell = new ProjectWindowShell(options, undefined, stub.seam);
  // index.ts registers a shell's own host in the same directory the resolver reads, so a
  // window that exists here always has a tab authority to answer for it.
  const windowHost = makeHost(owner);
  stub.hosts.set(shell, windowHost);
  stub.directory.register(shell, windowHost.host);
  return shell;
}

describe('ProjectWindowManager and ProjectWindowShell over a stubbed Electron', () => {
  it('opens one real window per owner and presents it when a user open reuses it', async () => {
    const stub = createNativeStub();
    const presented: ProjectWindowShell[] = [];
    const manager = new ProjectWindowManager({
      // Main's wiring decides construction visibility from the intent; the
      // manager never presents a window it just created, so the app's
      // ready-to-show first-paint path stays intact.
      createShell: (owner, intent) => createShellFor(stub, owner, RECORD_A, intent === 'user'),
      presentShell: (shell) => {
        presented.push(shell);
        shell.window.show();
        shell.window.focus();
      },
    });

    const first = await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(presented.length, 0, 'creation stays the caller\'s to present');

    const second = await manager.ensureWindow(PROJECT_A, 'user');

    assert.strictEqual(first, second, 'a duplicate open must reuse the live shell');
    assert.strictEqual(stub.windows.length, 1, 'one BrowserWindow for the owner');
    assert.strictEqual(presented.length, 1, 'the duplicate user open presents the shell it reused');
    assert.strictEqual(presented[0], first);
    assert.strictEqual(stub.windows[0]?.calls.show, 1);
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('creates an agent-intent window hidden and performs no show, focus, maximize or raise', async () => {
    const stub = createNativeStub();
    const presented: ProjectWindowShell[] = [];
    const manager = new ProjectWindowManager({
      // Main's wiring: only an explicit user intent may build a visible window.
      createShell: (owner, intent) => createShellFor(stub, owner, RECORD_A, intent === 'user'),
      presentShell: (shell) => { presented.push(shell); },
    });

    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);

    assert.strictEqual(win.options.show, false, 'an agent-created window is built hidden');
    assert.strictEqual(win.visible, false, 'the window is not visible after an agent open');
    for (const call of PRESENTATION_CALLS) {
      assert.strictEqual(win.calls[call], 0, `agent intent must not call ${call}`);
    }
    assert.strictEqual(presented.length, 0, 'agent intent never presents');

    // A ready-to-show handler is the classic way a window presents itself. The
    // shell registers none, so a late load cannot raise an agent-created window.
    assert.ok(!win.listenerEvents().includes('ready-to-show'), 'the shell never schedules its own presentation');
    win.emit('ready-to-show');
    assert.strictEqual(win.visible, false, 'nothing shows the window after load');
    assert.strictEqual(win.maximized, false);

    // The same shell still obeys an explicit user presentation, and a user
    // creation is the only path allowed to build a visible window.
    await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(presented.length, 1);
    assert.strictEqual(presented[0], shell);
    await manager.ensureWindow(PROJECT_B, 'user');
    const userWindow = stub.windows[stub.windows.length - 1];
    assert.ok(userWindow);
    assert.strictEqual(userWindow.options.show, true, 'a user-created window may be built visible');
  });

  it('presents the single window when an explicit user open joins an in-flight agent creation', async () => {
    const stub = createNativeStub();
    const intents: OpenIntent[] = [];
    const presented: ProjectWindowShell[] = [];
    const manager = new ProjectWindowManager({
      createShell: (owner, intent) => {
        intents.push(intent);
        return createShellFor(stub, owner, RECORD_A);
      },
      presentShell: (shell) => {
        presented.push(shell);
        shell.window.show();
      },
    });

    const agentOpen = manager.ensureWindow(PROJECT_A, 'agent');
    const userOpen = manager.ensureWindow(PROJECT_A, 'user');
    const [agentShell, userShell] = await Promise.all([agentOpen, userOpen]);
    const win = stub.windows[0];
    assert.ok(win);

    assert.strictEqual(agentShell, userShell, 'both callers observe the one shell');
    assert.deepStrictEqual(intents, ['agent'], 'one creation, at the intent that arrived first');
    assert.strictEqual(stub.windows.length, 1);
    assert.strictEqual(presented.length, 1, 'the user open presents the shell it joined');
    assert.strictEqual(presented[0], agentShell);
    assert.strictEqual(win.calls.show, 1);
  });

  it('opens an empty project with an empty tab set and no placeholder page', async () => {
    const stub = createNativeStub();
    const manager = new ProjectWindowManager({ createShell: (owner) => createShellFor(stub, owner, RECORD_A) });

    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const windowHost = hostOf(stub, shell);

    assert.deepStrictEqual(windowHost.tabIds(), [], 'an empty project has no member tabs');
    assert.strictEqual(windowHost.host.hasTab('tab-alpha'), false);
    assert.strictEqual(stub.views.length, 3, 'exactly the three chrome views; no page view is allocated');
    assert.deepStrictEqual(
      [...new Set(stub.loads.map((url) => decodeURIComponent(url).split('/').pop()))].sort(),
      ['frame-backdrop.html', 'standalone.html', 'toolbar.html'],
    );
    assert.ok(stub.loads.every((url) => url.startsWith('file:')), 'only local chrome assets load');
    assert.ok(!stub.loads.some((url) => url.includes('about:blank')), 'no hidden about:blank page is created');
    assert.strictEqual(shell.title, RECORD_A.title);

    // The empty state is data-driven: a page opening on this window's host changes what
    // the window reports, and the authority resolves that page to this window.
    windowHost.openTab('tab-alpha');
    assert.deepStrictEqual(windowHost.tabIds(), ['tab-alpha']);
    assert.strictEqual(stub.directory.hostForTab('tab-alpha'), windowHost.host);
    assert.strictEqual(shellForTab(stub.directory, manager, 'tab-alpha'), shell);
  });

  it('takes title and path label from the validated record and refuses page-supplied renaming', async () => {
    const stub = createNativeStub();
    const manager = new ProjectWindowManager({ createShell: (owner) => createShellFor(stub, owner, RECORD_A) });

    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);

    assert.strictEqual(shell.title, RECORD_A.title);
    assert.strictEqual(shell.pathLabel, RECORD_A.pathLabel);
    assert.strictEqual(win.options.title, RECORD_A.title);
    assert.deepStrictEqual(
      manager.listShells().map((shell) => ({ key: ownerKey(shell.owner), title: shell.title, pathLabel: shell.pathLabel })),
      [{ key: ownerKey(PROJECT_A), title: RECORD_A.title, pathLabel: RECORD_A.pathLabel }],
    );

    // Electron follows the page title by default. A renderer-supplied name must
    // never become the project's identity in the title bar.
    const titleEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.emit('page-title-updated', titleEvent, 'Renderer supplied name');
    assert.strictEqual(titleEvent.defaultPrevented, true, 'the shell refuses page-driven retitling');
    assert.strictEqual(win.getTitle(), RECORD_A.title);
    assert.strictEqual(shell.title, RECORD_A.title);
  });

  it('passes an unpositioned record through without inventing coordinates or presenting it', async () => {
    const stub = createNativeStub();
    const presented: ProjectWindowShell[] = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, RECORD_UNPOSITIONED),
      presentShell: (shell) => { presented.push(shell); },
    });

    await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);

    // WindowState resolves size only for a project with no saved placement: the
    // window layer must keep owning placement, not receive a fabricated rect.
    assert.strictEqual(win.options.x, undefined);
    assert.strictEqual(win.options.y, undefined);
    assert.strictEqual(win.options.width, RECORD_UNPOSITIONED.width);
    assert.strictEqual(win.options.height, RECORD_UNPOSITIONED.height);
    assert.strictEqual(win.calls.center, 0, 'the shell never places itself');
    for (const call of PRESENTATION_CALLS) {
      assert.strictEqual(win.calls[call], 0, `an unpositioned creation must not call ${call}`);
    }
    assert.strictEqual(presented.length, 0);

    // Placement stays the presenter's decision on the explicit user path.
    await manager.ensureWindow(PROJECT_A, 'user');
    assert.strictEqual(presented.length, 1);
    assert.strictEqual(win.calls.center, 0, 'the manager never substitutes its own placement');
  });

  it('keeps two shells independent in identity, geometry, sidebar state and display events', async () => {
    const displays = createDisplaySet();
    const stub = createNativeStub([displays.primary, displays.secondary, displays.tertiary]);
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, ownerKey(owner) === ownerKey(PROJECT_A) ? RECORD_A : RECORD_B),
    });

    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const winA = stub.windows[0];
    assert.ok(winA);

    assert.strictEqual(shellA.title, RECORD_A.title);
    assert.strictEqual(shellB.title, RECORD_B.title);

    shellA.isSidebarOpen = true;
    shellA.sidebarWidth = 420;
    assert.strictEqual(shellB.isSidebarOpen, false, 'sidebar state never leaks between shells');
    assert.strictEqual(shellB.sidebarWidth, 380);

    const geometryA = shellA.getContentGeometry(76);
    const geometryB = shellB.getContentGeometry(76);
    assert.ok(geometryA, 'a live shell answers its content geometry');
    assert.ok(geometryB, 'a live shell answers its content geometry');
    assert.strictEqual(geometryA.width, RECORD_A.width);
    assert.strictEqual(geometryB.width, RECORD_B.width);
    assert.strictEqual(geometryB.availableWidth, RECORD_B.width, "B's geometry ignores A's sidebar");

    const eventsA: Array<ShellDisplayInfo | undefined> = [];
    const eventsB: Array<ShellDisplayInfo | undefined> = [];
    const stopA = shellA.onDisplayChange((info) => eventsA.push(info));
    shellB.onDisplayChange((info) => eventsB.push(info));
    assert.strictEqual(shellA.getDisplayInfo()?.id, displays.primary.id);
    assert.strictEqual(shellB.getDisplayInfo()?.id, displays.secondary.id);

    // Moving A to the third monitor is A's event only.
    winA.setBounds({ x: 4500, y: 300, width: 1600, height: 900 });
    winA.emit('move');
    assert.deepStrictEqual(eventsA.map((info) => info?.id), [displays.tertiary.id]);
    assert.strictEqual(eventsB.length, 0, "A's move never reaches B's listeners");
    assert.strictEqual(shellA.getDisplayInfo()?.scaleFactor, displays.tertiary.scaleFactor);
    assert.strictEqual(shellB.getDisplayInfo()?.scaleFactor, displays.secondary.scaleFactor);

    // A move inside one display is not a display change.
    winA.emit('move');
    assert.strictEqual(eventsA.length, 1);

    // A scale change on A's new display is A's event, not B's.
    displays.tertiary.scaleFactor = 2.5;
    winA.emit('resize');
    assert.deepStrictEqual(eventsA.map((info) => info?.scaleFactor), [2, 2.5]);
    // B hears its own display, and only after its own refresh.
    displays.secondary.scaleFactor = 1.75;
    shellB.refreshDisplayInfo();
    assert.deepStrictEqual(eventsB.map((info) => info?.scaleFactor), [1.75]);
    assert.strictEqual(eventsA.length, 2, "B's display change is not A's event");

    stopA();
    winA.setBounds({ x: 4600, y: 300, width: 1600, height: 900 });
    winA.emit('move');
    assert.strictEqual(eventsA.length, 2, 'an unsubscribed listener hears nothing');
  });

  it('never counts or disposes auxiliary windows as browser shells', async () => {
    const stub = createNativeStub();
    const disposed: ProjectWindowShell[] = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, ownerKey(owner) === ownerKey(PROJECT_A) ? RECORD_A : RECORD_B),
      onShellDisposed: (shell) => { disposed.push(shell); },
    });

    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    // A terminal popout or a capture host is an auxiliary window built by
    // another owner. It is never admitted to the browser-shell directory.
    stub.seam.createWindow({ title: 'AntiFan Terminal Workbench', width: 900, height: 600, show: false });
    const auxiliary = stub.windows[2];
    assert.ok(auxiliary);

    assert.strictEqual(manager.browserShellCount(), 2, 'auxiliary windows are not browser shells');
    assert.strictEqual(manager.listShells().length, 2);
    assert.strictEqual(manager.listShells()[0], shellA);
    assert.strictEqual(manager.listShells()[1], shellB);
    assert.deepStrictEqual(manager.listShells().map((shell) => ownerKey(shell.owner)), [ownerKey(PROJECT_A), ownerKey(PROJECT_B)]);

    assert.strictEqual(manager.disposeShell(PROJECT_A), true);
    assert.strictEqual(disposed.length, 1);
    assert.strictEqual(disposed[0], shellA);
    assert.strictEqual(auxiliary.destroyed, false, 'disposing a project shell never touches an auxiliary window');
    assert.strictEqual(auxiliary.calls.destroy, 0);
    assert.strictEqual(shellB.window.isDestroyed(), false, 'the other project shell stays alive');
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('disposes one shell: bindings dropped, routing unregistered, chrome torn down', async () => {
    const stub = createNativeStub();
    const seen: Array<{ key: string; windowAlive: boolean; chromeAlive: boolean }> = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, ownerKey(owner) === ownerKey(PROJECT_A) ? RECORD_A : RECORD_B),
      onShellDisposed: (shell) => {
        seen.push({
          key: ownerKey(shell.owner),
          windowAlive: !shell.window.isDestroyed(),
          chromeAlive: shell.toolbarView !== null && !shell.toolbarView.webContents.isDestroyed(),
        });
        // Main's wiring, in this order: routing goes first, then the host that presented
        // the window's pages (its own teardown is what ends its membership answers).
        stub.directory.unregister(shell);
        hostOf(stub, shell).dispose();
      },
    });

    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const hostA = hostOf(stub, shellA);
    const hostB = hostOf(stub, shellB);
    hostA.openTab('tab-a');
    hostB.openTab('tab-b');
    assert.strictEqual(stub.directory.hostForTab('tab-a'), hostA.host);
    assert.strictEqual(stub.directory.hostForTab('tab-b'), hostB.host);

    assert.strictEqual(manager.disposeShell(PROJECT_A), true);

    assert.deepStrictEqual(seen, [{
      key: ownerKey(PROJECT_A),
      // Routing is unregistered while the window and its chrome are still resolvable.
      windowAlive: true,
      chromeAlive: true,
    }]);
    assert.strictEqual(shellA.window.isDestroyed(), true, 'the disposed shell window is destroyed');
    assert.strictEqual(shellA.toolbarView, null, 'a disposed shell releases its chrome views');
    assert.deepStrictEqual(hostA.tabIds(), [], 'a disposed shell keeps no member tabs');
    assert.strictEqual(hostA.host.hasTab('tab-a'), false);
    assert.strictEqual(stub.directory.hostForTab('tab-a'), undefined);
    assert.strictEqual(stub.directory.hostForTab('tab-b'), hostB.host, 'the other shell keeps its binding');
    assert.strictEqual(shellForTab(stub.directory, manager, 'tab-b'), shellB);
    assert.deepStrictEqual(hostB.tabIds(), ['tab-b']);
    assert.strictEqual(manager.disposeShell(PROJECT_A), false, 'disposing twice is a no-op');
    assert.strictEqual(manager.browserShellCount(), 1);

    // A platform-destroyed window unregisters through the same door, without a second teardown.
    shellB.window.destroy();
    manager.notifyShellGone(PROJECT_B);
    assert.deepStrictEqual(seen, [
      { key: ownerKey(PROJECT_A), windowAlive: true, chromeAlive: true },
      { key: ownerKey(PROJECT_B), windowAlive: false, chromeAlive: false },
    ]);
    assert.strictEqual(manager.browserShellCount(), 0);
  });

  it('lists the Unassigned owner beside projects with its own key and label', async () => {
    const unassigned: WindowOwner = { kind: 'unassigned' };
    const stub = createNativeStub();
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, ownerKey(owner) === ownerKey(PROJECT_A)
        ? RECORD_A
        : { title: 'Unassigned', pathLabel: 'Unresolved pages' }),
    });

    await manager.ensureWindow(PROJECT_A, 'agent');
    await manager.ensureWindow(unassigned, 'agent');

    assert.strictEqual(ownerKey(unassigned), 'unassigned');
    assert.strictEqual(ownerLabel(unassigned), 'Unassigned');
    assert.deepStrictEqual(
      manager.listShells().map((shell) => ({ key: ownerKey(shell.owner), title: shell.title, pathLabel: shell.pathLabel })),
      [
        { key: ownerKey(PROJECT_A), title: RECORD_A.title, pathLabel: RECORD_A.pathLabel },
        { key: 'unassigned', title: 'Unassigned', pathLabel: 'Unresolved pages' },
      ],
    );
    assert.strictEqual(manager.browserShellCount(), 2, 'project and Unassigned never collide on one window');

    // A tab's owner is the owner of the window that presents it: key and kind both come
    // from the shell the authority resolves the tab to, never from a manager-side guess.
    const unassignedShell = manager.listShells().find((shell) => ownerKey(shell.owner) === 'unassigned');
    assert.ok(unassignedShell);
    const unassignedHost = hostOf(stub, unassignedShell);
    unassignedHost.openTab('tab-unassigned');
    assert.strictEqual(stub.directory.hostForTab('tab-unassigned'), unassignedHost.host);
    assert.strictEqual(shellForTab(stub.directory, manager, 'tab-unassigned')?.owner.kind, 'unassigned');
  });

  it('answers capture readiness for an attached view without presenting the window', async () => {
    const stub = createNativeStub();
    const manager = new ProjectWindowManager({ createShell: (owner) => createShellFor(stub, owner, RECORD_A) });
    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);

    const tabView = stub.seam.createView({}) as unknown as WebContentsView;
    const stubView = stub.views[stub.views.length - 1];
    assert.ok(stubView);
    stubView.setBounds({ x: 0, y: 76, width: 1280, height: 724 });
    win.contentView.addChildView(tabView);

    assert.deepStrictEqual(shell.captureReadinessFor(tabView), {
      attached: true,
      laidOut: true,
      bounds: { x: 0, y: 76, width: 1280, height: 724 },
    });
    assert.deepStrictEqual(shell.captureReadinessFor(null), { attached: false, laidOut: false });

    stubView.setBounds({ x: 0, y: 76, width: 0, height: 0 });
    assert.deepStrictEqual(shell.captureReadinessFor(tabView), {
      attached: true,
      laidOut: false,
      bounds: { x: 0, y: 76, width: 0, height: 0 },
    });

    win.contentView.removeChildView(tabView);
    assert.deepStrictEqual(shell.captureReadinessFor(tabView), { attached: false, laidOut: false }, 'a detached view is not a capture source');

    for (const call of PRESENTATION_CALLS) {
      assert.strictEqual(win.calls[call], 0, `capture readiness must not call ${call}`);
    }
    assert.strictEqual(win.visible, false, 'the project window stays hidden for capture');
  });

  it('fails closed when creation returns a shell for a different owner', async () => {
    const stub = createNativeStub();
    let attempts = 0;
    const manager = new ProjectWindowManager({
      // Buggy wiring: asks for A, hands back B's shell first.
      createShell: (owner) => {
        attempts += 1;
        return attempts === 1 ? createShellFor(stub, PROJECT_B, RECORD_B) : createShellFor(stub, owner, RECORD_A);
      },
    });

    await assert.rejects(manager.ensureWindow(PROJECT_A, 'agent'), /requested owner/);
    assert.strictEqual(manager.browserShellCount(), 0, 'a mistyped shell is never admitted');
    const rejected = stub.windows[0];
    assert.ok(rejected);
    assert.strictEqual(rejected.isDestroyed(), true, 'the rejected shell is torn down');

    const recovered = await manager.ensureWindow(PROJECT_A, 'agent');
    assert.strictEqual(ownerKey(recovered.owner), ownerKey(PROJECT_A));
    assert.strictEqual(manager.browserShellCount(), 1, 'a later correct creation still opens');
  });
});

/**
 * Phase-4 close path. The shell owns the native close and its authorization; the manager
 * publishes the close surfaces, counts browser shells and reports disposal; the real
 * ProjectCloseCoordinator drives both, so these cases exercise the seam index.ts wires.
 */
async function openSingleShell(stub: NativeStub): Promise<{
  manager: ProjectWindowManager;
  shell: ProjectWindowShell;
  win: StubWindow;
}> {
  const manager = new ProjectWindowManager({ createShell: (owner) => createShellFor(stub, owner, RECORD_A) });
  const shell = await manager.ensureWindow(PROJECT_A, 'agent');
  const win = stub.windows[0];
  assert.ok(win);
  return { manager, shell, win };
}

function twoShellManager(stub: NativeStub, onShellDisposed?: (shell: ProjectWindowShell) => void): ProjectWindowManager {
  return new ProjectWindowManager({
    createShell: (owner) => createShellFor(stub, owner, ownerKey(owner) === ownerKey(PROJECT_A) ? RECORD_A : RECORD_B),
    onShellDisposed,
  });
}

describe('ProjectWindowShell native close authorization', () => {
  it('refuses a native close it was not authorized for and hands the request to policy', async () => {
    const stub = createNativeStub();
    const { manager, shell, win } = await openSingleShell(stub);
    const requests: string[] = [];
    shell.onCloseRequest((key) => requests.push(key));

    const event = win.close();

    assert.strictEqual(event.defaultPrevented, true, 'an unauthorized native close is refused synchronously');
    assert.deepStrictEqual(requests, [ownerKey(PROJECT_A)], 'policy is told about the refused close');
    assert.strictEqual(win.isDestroyed(), false, 'the refusal leaves the shell standing');
    assert.strictEqual(shell.toolbarView?.webContents.isDestroyed(), false, 'no chrome was torn down');
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('authorizes exactly one attempt and reports closed after the window is really gone', async () => {
    const stub = createNativeStub();
    const disposed: Array<{ key: string; windowAlive: boolean; chromeAlive: boolean }> = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, RECORD_A),
      onShellDisposed: (shell) => {
        disposed.push({
          key: ownerKey(shell.owner),
          windowAlive: !shell.window.isDestroyed(),
          chromeAlive: shell.toolbarView !== null && !shell.toolbarView.webContents.isDestroyed(),
        });
      },
    });
    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);
    const requests: string[] = [];
    shell.onCloseRequest((key) => requests.push(key));

    assert.strictEqual(await shell.closeSelf(), 'closed');

    assert.strictEqual(win.calls.close, 1, 'one native close request carried the authorization');
    assert.deepStrictEqual(requests, [], 'an authorized close never asks policy again');
    assert.strictEqual(win.isDestroyed(), true);
    assert.strictEqual(shell.toolbarView, null, 'the shell disposed its own chrome');
    assert.strictEqual(manager.browserShellCount(), 0);
    assert.deepStrictEqual(disposed, [{ key: ownerKey(PROJECT_A), windowAlive: false, chromeAlive: false }]);
  });

  it('reports a veto, withdraws that attempt\'s authorization, and still closes on a later attempt', async () => {
    const stub = createNativeStub();
    const { manager, shell, win } = await openSingleShell(stub);
    const requests: string[] = [];
    shell.onCloseRequest((key) => requests.push(key));
    // Main's own guard: benchmark mode refuses every close of this window.
    let refuseClose = true;
    win.on('close', (event) => { if (refuseClose) (event as unknown as PreventableEvent).preventDefault(); });

    assert.strictEqual(await shell.closeSelf(), 'vetoed');
    assert.strictEqual(win.isDestroyed(), false, 'a veto retains the shell');
    assert.strictEqual(shell.toolbarView?.webContents.isDestroyed(), false, 'a veto retains the shell chrome');
    assert.strictEqual(win.calls.destroy, 0, 'a veto is never answered with a forced destroy');

    // The authorization belonged to that attempt: the next native close is refused again.
    assert.strictEqual(win.close().defaultPrevented, true);
    assert.deepStrictEqual(requests, [ownerKey(PROJECT_A)]);
    assert.strictEqual(manager.browserShellCount(), 1);

    refuseClose = false;
    assert.strictEqual(await shell.closeSelf(), 'closed', 'a new attempt authorizes its own close');
    assert.strictEqual(manager.browserShellCount(), 0);
  });

  it('honors a document that vetoes its own unload instead of overriding it', async () => {
    const stub = createNativeStub();
    const { manager, shell, win } = await openSingleShell(stub);
    win.documentVeto = true;

    assert.strictEqual(await shell.closeSelf(), 'vetoed');

    const veto = win.webContents.emitted.find((entry) => entry.event === 'will-prevent-unload');
    assert.ok(veto, 'the document veto was observed');
    assert.strictEqual(veto.payload.defaultPrevented, false, 'the shell never overrides the page\'s veto');
    assert.strictEqual(win.isDestroyed(), false, 'the vetoed window is still there');
    assert.strictEqual(win.calls.destroy, 0, 'no timeout-driven destroy follows a veto');
    assert.strictEqual(manager.browserShellCount(), 1);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_A), true);
  });

  it('honors an unload veto from one of its own chrome contents', async () => {
    const stub = createNativeStub();
    const { manager, shell, win } = await openSingleShell(stub);
    // The window stays alive until the platform closes it, so the attempt is still in flight.
    win.autoClose = false;

    const closing = shell.closeSelf();
    const veto = (shell.toolbarView?.webContents as unknown as StubWebContents).emitEvent('will-prevent-unload');

    assert.strictEqual(veto.defaultPrevented, false, 'the shell never overrides its own content\'s veto');
    assert.strictEqual(await closing, 'vetoed');
    assert.strictEqual(win.isDestroyed(), false);
    assert.strictEqual(manager.browserShellCount(), 1);
  });

  it('withdraws the authorization when the native call itself fails, and closes on a later attempt', async () => {
    const stub = createNativeStub();
    const { manager, shell, win } = await openSingleShell(stub);
    const realClose = win.close.bind(win);
    let failNext = true;
    win.close = (): PreventableEvent => {
      if (failNext) {
        failNext = false;
        throw new Error('native close failed');
      }
      return realClose();
    };

    await assert.rejects(() => shell.closeSelf(), /native close failed/);

    assert.strictEqual(win.isDestroyed(), false, 'a failed native call destroys nothing');
    assert.strictEqual(shell.toolbarView?.webContents.isDestroyed(), false, 'a failed call tears down no chrome');
    assert.strictEqual(manager.browserShellCount(), 1);
    // The authorization died with that attempt: a bare native close is refused again.
    assert.strictEqual(win.close().defaultPrevented, true);
    assert.strictEqual(win.calls.close, 1, 'the refusal went through the real native close');

    // A later attempt arms its own authorization and closes for real.
    assert.strictEqual(await shell.closeSelf(), 'closed');
    assert.strictEqual(win.calls.close, 2);
    assert.strictEqual(manager.browserShellCount(), 0);
  });

  it('withdraws an attempt on reset: no outcome claimed, and no close may follow', async () => {
    const stub = createNativeStub();
    const { shell, win } = await openSingleShell(stub);
    const attempt = shell.beginCloseAttempt();
    attempt.authorize();
    assert.strictEqual(attempt.isAuthorized(), true);

    attempt.reset();

    assert.strictEqual(await attempt.settled, 'unknown', 'a withdrawn attempt reports no outcome instead of a close');
    assert.strictEqual(win.isDestroyed(), false);
    assert.throws(() => shell.requestNativeClose(), /armed close attempt/);
    assert.strictEqual(win.calls.close, 0, 'a withdrawn attempt issued no native close');
  });

  it('runs one attempt at a time and answers closed for a window that is already gone', async () => {
    const stub = createNativeStub();
    const { shell, win } = await openSingleShell(stub);
    const attempt = shell.beginCloseAttempt();
    assert.throws(() => shell.beginCloseAttempt(), /already running a close attempt/);
    attempt.reset();

    win.destroy();

    assert.strictEqual(await shell.closeSelf(), 'closed', 'a window that is already gone needs no native close');
    assert.strictEqual(win.calls.close, 0);
  });
});

describe('ProjectWindowManager close surfaces, browser-shell counting and the last-browser rule', () => {
  it('publishes one stable close surface per live browser shell with live member tab ids', async () => {
    const stub = createNativeStub();
    const manager = twoShellManager(stub);
    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const hostA = hostOf(stub, shellA);
    const hostB = hostOf(stub, shellB);
    hostA.openTab('tab-a1');
    hostB.openTab('tab-b1');

    const surfaces = manager.listCloseSurfaces();
    assert.deepStrictEqual(surfaces.map((surface) => [surface.key, surface.kind]), [
      [ownerKey(PROJECT_A), 'browser'],
      [ownerKey(PROJECT_B), 'browser'],
    ]);
    const surfaceA = manager.closeSurfaceForOwner(ownerKey(PROJECT_A));
    assert.strictEqual(surfaceA, surfaces[0], 'the surface for a shell is stable across reads');

    // index.ts hands the coordinator this same surface with its members read from the
    // hosting tab authority, so the published instance and the live membership agree.
    const memberIds = (key: string): readonly string[] => {
      const surface = manager.closeSurfaceForOwner(key);
      assert.ok(surface, `no close surface for ${key}`);
      return withHostMembers(surface, manager, stub.directory).visibleMemberIds();
    };
    assert.deepStrictEqual(memberIds(ownerKey(PROJECT_A)), ['tab-a1']);
    assert.deepStrictEqual(memberIds(ownerKey(PROJECT_B)), ['tab-b1']);

    // Membership is a live read: the coordinator snapshots it immediately before it reserves.
    hostA.openTab('tab-a2');
    assert.deepStrictEqual(memberIds(ownerKey(PROJECT_A)), ['tab-a1', 'tab-a2']);
    hostA.closeTab('tab-a1');
    assert.deepStrictEqual(memberIds(ownerKey(PROJECT_A)), ['tab-a2']);

    assert.strictEqual(manager.disposeShell(PROJECT_A), true);
    assert.strictEqual(shellA.window.isDestroyed(), true);
    assert.strictEqual(manager.closeSurfaceForOwner(ownerKey(PROJECT_A)), undefined);
    assert.deepStrictEqual(manager.listCloseSurfaces().map((surface) => surface.key), [ownerKey(PROJECT_B)]);
    assert.strictEqual(
      manager.closeSurfaceForOwner(ownerKey(PROJECT_B)),
      surfaces[1],
      'a surviving shell keeps the surface instance it was published with'
    );
  });

  it('counts browser shells only and tells the last browser shell apart from open auxiliaries', async () => {
    const stub = createNativeStub();
    const manager = twoShellManager(stub);
    await manager.ensureWindow(PROJECT_A, 'agent');
    // A terminal popout or a capture host is an auxiliary window built by another owner.
    stub.seam.createWindow({ title: 'AntiFan Terminal Workbench', width: 900, height: 600, show: false });
    const auxiliary = stub.windows[1];
    assert.ok(auxiliary);

    assert.strictEqual(manager.browserShellCount(), 1);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_A), true);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_B), false, 'an owner with no shell is never the last browser shell');
    assert.strictEqual(
      manager.listCloseSurfaces().length,
      manager.browserShellCount(),
      'the coordinator counts exactly the browser shells this directory holds'
    );
    assert.deepStrictEqual(manager.listCloseSurfaces().map((surface) => surface.kind), ['browser']);

    await manager.ensureWindow(PROJECT_B, 'agent');
    assert.strictEqual(manager.browserShellCount(), 2, 'the auxiliary window never inflates the count');
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_A), false);

    stub.windows[0]?.destroy();
    assert.strictEqual(manager.browserShellCount(), 1);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_B), true);
    assert.strictEqual(manager.closeSurfaceForOwner(ownerKey(PROJECT_A)), undefined);

    stub.windows[2]?.destroy();
    assert.strictEqual(manager.browserShellCount(), 0, 'no browser shell is left');
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_B), false, 'no shell means no last shell');
    assert.strictEqual(auxiliary.isDestroyed(), false, 'an auxiliary window is still open — a different fact');
    assert.deepStrictEqual(manager.listCloseSurfaces(), []);
    assert.deepStrictEqual(manager.listShells(), []);
  });

  it('keeps a mid-close shell counted until its native closure actually completes', async () => {
    const stub = createNativeStub();
    const manager = twoShellManager(stub);
    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const winA = stub.windows[0];
    assert.ok(winA);
    // The platform carries the close out after the request, not during it.
    winA.autoClose = false;

    const closing = shellA.closeSelf();

    assert.strictEqual(winA.calls.close, 1, 'the native close was requested');
    assert.strictEqual(manager.browserShellCount(), 2, 'a shell mid-close is still one browser shell');
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_A), false, 'a mid-close shell is not the last one while another lives');
    assert.deepStrictEqual(
      manager.listCloseSurfaces().map((surface) => surface.key),
      [ownerKey(PROJECT_A), ownerKey(PROJECT_B)],
      'the closing shell keeps its surface until it is actually gone'
    );
    assert.strictEqual(shellB.window.isDestroyed(), false, 'the other shell is untouched');

    winA.destroy();

    assert.strictEqual(await closing, 'closed');
    assert.strictEqual(manager.browserShellCount(), 1, 'the count drops only once the window is gone');
    assert.deepStrictEqual(manager.listCloseSurfaces().map((surface) => surface.key), [ownerKey(PROJECT_B)]);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_B), true);
    assert.strictEqual(manager.disposeShell(PROJECT_A), false, 'a shell that closed natively is not disposed twice');
  });

  it('reports each shell disposed exactly once, after native closure, never for a refused close', async () => {
    const stub = createNativeStub();
    const disposed: Array<{ key: string; windowAlive: boolean; chromeAlive: boolean }> = [];
    const manager = twoShellManager(stub, (shell) => {
      disposed.push({
        key: ownerKey(shell.owner),
        windowAlive: !shell.window.isDestroyed(),
        chromeAlive: shell.toolbarView !== null && !shell.toolbarView.webContents.isDestroyed(),
      });
      // Main's wiring: the window's routing and its host go with the shell.
      stub.directory.unregister(shell);
      hostOf(stub, shell).dispose();
    });
    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const hostA = hostOf(stub, shellA);
    const hostB = hostOf(stub, shellB);
    hostA.openTab('tab-a');
    hostB.openTab('tab-b');
    const winA = stub.windows[0];
    assert.ok(winA);

    // A refused close keeps the shell, so it reports nothing.
    let refuseClose = true;
    winA.on('close', (event) => { if (refuseClose) (event as unknown as PreventableEvent).preventDefault(); });
    assert.strictEqual(await shellA.closeSelf(), 'vetoed');
    assert.deepStrictEqual(disposed, [], 'a vetoed close never reports a disposed shell');
    assert.deepStrictEqual(hostA.tabIds(), ['tab-a'], 'the vetoed shell keeps its pages');
    assert.strictEqual(stub.directory.hostForTab('tab-a'), hostA.host);

    refuseClose = false;
    assert.strictEqual(await shellA.closeSelf(), 'closed');
    assert.deepStrictEqual(disposed, [{ key: ownerKey(PROJECT_A), windowAlive: false, chromeAlive: false }]);

    // The mapping is already gone, so neither explicit door reports a second disposal.
    manager.notifyShellGone(PROJECT_A);
    assert.strictEqual(manager.disposeShell(PROJECT_A), false);
    assert.strictEqual(disposed.length, 1, 'exactly one disposal report per shell');
    assert.deepStrictEqual(hostA.tabIds(), [], 'a closed shell keeps no pages');
    assert.strictEqual(hostA.host.hasTab('tab-a'), false);
    assert.strictEqual(stub.directory.hostForTab('tab-a'), undefined);
    assert.strictEqual(shellA.window.isDestroyed(), true);

    // The other shell keeps everything it had.
    assert.strictEqual(shellForTab(stub.directory, manager, 'tab-b')?.owner.kind, 'project');
    assert.deepStrictEqual(hostB.tabIds(), ['tab-b']);
    assert.strictEqual(stub.directory.hostForTab('tab-b'), hostB.host);
    assert.strictEqual(manager.browserShellCount(), 1);
  });
});

interface FakePage {
  tabId: string;
  view: WebContentsView;
  stubView: StubView;
  win: StubWindow;
}

/** A page the shell presents: a real view attached to its window and seated on its host. */
function attachFakePage(
  stub: NativeStub,
  win: StubWindow,
  manager: ProjectWindowManager,
  owner: WindowOwner,
  tabId: string
): FakePage {
  const view = stub.seam.createView({}) as unknown as WebContentsView;
  const stubView = stub.views[stub.views.length - 1];
  assert.ok(stubView);
  win.contentView.addChildView(view);
  const shell = manager.listShells().find((candidate) => candidate.window === (win as unknown as BrowserWindow));
  assert.ok(shell, `tab ${tabId} needs the live shell that presents it`);
  assert.deepStrictEqual(shell.owner, owner, `tab ${tabId} must belong to the window that presents it`);
  const windowHost = hostOf(stub, shell);
  windowHost.openTab(tabId);
  assert.strictEqual(stub.directory.hostForTab(tabId), windowHost.host, `tab ${tabId} must resolve to its own window's host`);
  return { tabId, view, stubView, win };
}

/** The close coordinator wired the way index.ts wires it: manager surfaces, host page closes. */
function closeHarness(args: {
  stub: NativeStub;
  manager: ProjectWindowManager;
  pages: readonly FakePage[];
  queryLiveUse: (request: LiveUseRequest) => LiveUseReport;
  vetoedTabs?: ReadonlySet<string>;
}): { coordinator: ProjectCloseCoordinator; closedTabs: string[] } {
  const { stub, manager } = args;
  const closedTabs: string[] = [];
  const byId = new Map(args.pages.map((page) => [page.tabId, page]));
  const coordinator = new ProjectCloseCoordinator({
    reservations: new PageCloseReservations(),
    // The members of every browser surface are read from the tab authority that presents
    // it, and a page's owner is the owner of the window whose host holds the page.
    listSurfaces: () => manager.listCloseSurfaces().map((surface) => withHostMembers(surface, manager, stub.directory)),
    surfaceForOwner: (key) => {
      const surface = manager.closeSurfaceForOwner(key);
      return surface ? withHostMembers(surface, manager, stub.directory) : undefined;
    },
    ownerOfPage: (tabId) => stub.directory.hostForTab(tabId)?.windowOwnerKey(),
    closePage: async (tabId) => {
      const page = byId.get(tabId);
      if (!page) return 'unknown';
      if (args.vetoedTabs?.has(tabId)) return 'vetoed';
      page.win.contentView.removeChildView(page.view);
      page.stubView.webContents.destroy();
      // The real release path: the page's own window drops it from its strip.
      hostForTab(stub, tabId)?.closeTab(tabId);
      closedTabs.push(tabId);
      return 'closed';
    },
    queryLiveUse: (request) => args.queryLiveUse(request),
    commitShutdown: () => {},
  });
  return { coordinator, closedTabs };
}

describe('ProjectCloseCoordinator over the manager close surfaces', () => {
  it('leaves a refused shell fully functional: policy, bindings, views and count unchanged', async () => {
    const stub = createNativeStub();
    const disposed: string[] = [];
    const restoreCalls: Array<{ key: string; surviving: readonly string[] }> = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, RECORD_A),
      onShellDisposed: (shell) => { disposed.push(ownerKey(shell.owner)); },
      restoreShellLayout: (shell, surviving) => { restoreCalls.push({ key: ownerKey(shell.owner), surviving: [...surviving] }); },
    });
    const shellA = await manager.ensureWindow(PROJECT_A, 'agent');
    const winA = stub.windows[0];
    assert.ok(winA);
    const page = attachFakePage(stub, winA, manager, PROJECT_A, 'tab-a');
    const { coordinator, closedTabs } = closeHarness({
      stub,
      manager,
      pages: [page],
      queryLiveUse: () => ({
        state: 'busy',
        reasons: [{
          category: 'attachment-authority',
          detail: 'an attachment is bound to tab-a',
          tabId: 'tab-a',
          control: { id: 'attachments-panel', label: 'Attachments panel' },
        }],
      }),
    });

    const report = await coordinator.attemptClose(ownerKey(PROJECT_A), 'user');

    assert.strictEqual(report.disposition, 'retained');
    assert.strictEqual(report.haltedBy, 'busy');
    assert.deepStrictEqual(report.closed, []);
    assert.deepStrictEqual(report.skipped.map((outcome) => outcome.tabId), ['tab-a']);
    assert.strictEqual(report.refusals[0]?.controls.length, 1, 'the refusal carries an existing recovery control');
    assert.deepStrictEqual(closedTabs, [], 'a refused attempt destroys no page');
    assert.deepStrictEqual(restoreCalls, [], 'nothing was closed, so nothing needed restoring');
    assert.deepStrictEqual(disposed, [], 'a retained shell is never reported disposed');

    assert.strictEqual(winA.isDestroyed(), false);
    assert.strictEqual(winA.calls.close, 0, 'a refused close never issues a native close');
    assert.strictEqual(shellA.toolbarView?.webContents.isDestroyed(), false);
    assert.strictEqual(page.stubView.webContents.isDestroyed(), false, 'the page view is untouched');
    assert.deepStrictEqual(hostOf(stub, shellA).tabIds(), ['tab-a']);
    assert.strictEqual(stub.directory.hostForTab('tab-a')?.windowOwnerKey(), ownerKey(PROJECT_A));
    assert.strictEqual(shellForTab(stub.directory, manager, 'tab-a'), shellA);
    assert.strictEqual(manager.browserShellCount(), 1);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_A), true);
  });

  it('closes exactly one shell through the coordinator and reports its disposal once', async () => {
    const stub = createNativeStub();
    const disposed: string[] = [];
    const restoreCalls: Array<{ key: string; surviving: readonly string[] }> = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, ownerKey(owner) === ownerKey(PROJECT_A) ? RECORD_A : RECORD_B),
      onShellDisposed: (shell) => {
        disposed.push(ownerKey(shell.owner));
        // Main's wiring: the closed window's routing and host go with it.
        stub.directory.unregister(shell);
        hostOf(stub, shell).dispose();
      },
      restoreShellLayout: (shell, surviving) => { restoreCalls.push({ key: ownerKey(shell.owner), surviving: [...surviving] }); },
    });
    const shellA = await manager.ensureWindow(PROJECT_A, 'user');
    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const winA = stub.windows[0];
    const winB = stub.windows[1];
    assert.ok(winA);
    assert.ok(winB);
    const pageA1 = attachFakePage(stub, winA, manager, PROJECT_A, 'tab-a1');
    const pageA2 = attachFakePage(stub, winA, manager, PROJECT_A, 'tab-a2');
    const pageB = attachFakePage(stub, winB, manager, PROJECT_B, 'tab-b');
    const { coordinator, closedTabs } = closeHarness({
      stub,
      manager,
      pages: [pageA1, pageA2, pageB],
      queryLiveUse: () => ({ state: 'idle' }),
    });

    const report = await coordinator.attemptClose(ownerKey(PROJECT_A), 'user');

    assert.strictEqual(report.disposition, 'closed');
    assert.deepStrictEqual(closedTabs, ['tab-a1', 'tab-a2'], 'member pages close in presentation order');
    assert.deepStrictEqual(report.closed.map((outcome) => outcome.tabId), ['tab-a1', 'tab-a2']);
    assert.strictEqual(report.lastBrowserShellGone, false, 'the other project still has its shell');
    assert.deepStrictEqual(disposed, [ownerKey(PROJECT_A)], 'one disposal report for the one shell that closed');
    assert.deepStrictEqual(restoreCalls, []);

    assert.strictEqual(winA.isDestroyed(), true);
    assert.strictEqual(manager.closeSurfaceForOwner(ownerKey(PROJECT_A)), undefined);
    assert.deepStrictEqual(hostOf(stub, shellA).tabIds(), [], 'the closed window presents no pages');
    assert.strictEqual(stub.directory.hostForTab('tab-a1'), undefined, 'a closed window answers for none of its pages');

    assert.strictEqual(winB.isDestroyed(), false, 'the other shell is untouched');
    assert.strictEqual(shellB.toolbarView?.webContents.isDestroyed(), false);
    assert.strictEqual(pageB.stubView.webContents.isDestroyed(), false, "the other shell's page is untouched");
    assert.deepStrictEqual(hostOf(stub, shellB).tabIds(), ['tab-b']);
    assert.strictEqual(stub.directory.hostForTab('tab-b'), hostOf(stub, shellB).host);
    assert.strictEqual(shellForTab(stub.directory, manager, 'tab-b'), shellB);
    assert.strictEqual(manager.browserShellCount(), 1);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_B), true);
    assert.strictEqual(shellA.window.isDestroyed(), true);
  });

  it('stops at the first page veto, restores the survivor in-shell, and stays honest', async () => {
    const stub = createNativeStub();
    const disposed: string[] = [];
    const restoreCalls: Array<{ key: string; surviving: string[] }> = [];
    const manager = new ProjectWindowManager({
      createShell: (owner) => createShellFor(stub, owner, RECORD_A),
      onShellDisposed: (shell) => { disposed.push(ownerKey(shell.owner)); },
      restoreShellLayout: (shell, surviving) => { restoreCalls.push({ key: ownerKey(shell.owner), surviving: [...surviving] }); },
    });
    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);
    const first = attachFakePage(stub, win, manager, PROJECT_A, 'tab-a1');
    const second = attachFakePage(stub, win, manager, PROJECT_A, 'tab-a2');
    const { coordinator, closedTabs } = closeHarness({
      stub,
      manager,
      pages: [first, second],
      vetoedTabs: new Set(['tab-a2']),
      queryLiveUse: () => ({ state: 'idle' }),
    });

    const report = await coordinator.attemptClose(ownerKey(PROJECT_A), 'user');

    assert.strictEqual(report.disposition, 'retained');
    assert.strictEqual(report.partial, true, 'an earlier close that stands is reported as partial, not undone');
    assert.strictEqual(report.haltedBy, 'unload-veto');
    assert.deepStrictEqual(report.closed.map((outcome) => outcome.tabId), ['tab-a1']);
    assert.deepStrictEqual(
      report.skipped.map((outcome) => [outcome.tabId, outcome.reason, outcome.attempted]),
      [['tab-a2', 'unload-veto', true]]
    );
    assert.deepStrictEqual(closedTabs, ['tab-a1']);
    assert.deepStrictEqual(disposed, [], 'a retained shell is never reported disposed');
    assert.deepStrictEqual(restoreCalls, [{ key: ownerKey(PROJECT_A), surviving: ['tab-a2'] }]);
    assert.deepStrictEqual(report.warnings, []);

    assert.strictEqual(win.isDestroyed(), false, 'the vetoed shell stays open');
    assert.strictEqual(win.calls.close, 0, 'no shell close was attempted after the veto');
    for (const call of PRESENTATION_CALLS) {
      assert.strictEqual(win.calls[call], 0, `restoring a survivor must not call ${call}`);
    }
    assert.strictEqual(manager.browserShellCount(), 1);
    assert.strictEqual(manager.isFinalBrowserShell(PROJECT_A), true);
    assert.strictEqual(shell.window.isDestroyed(), false);
  });

  it('reports a missing layout hook as a warning instead of pretending the survivor was restored', async () => {
    const stub = createNativeStub();
    const manager = new ProjectWindowManager({ createShell: (owner) => createShellFor(stub, owner, RECORD_A) });
    const shell = await manager.ensureWindow(PROJECT_A, 'agent');
    const win = stub.windows[0];
    assert.ok(win);
    const first = attachFakePage(stub, win, manager, PROJECT_A, 'tab-a1');
    const second = attachFakePage(stub, win, manager, PROJECT_A, 'tab-a2');
    const { coordinator } = closeHarness({
      stub,
      manager,
      pages: [first, second],
      vetoedTabs: new Set(['tab-a2']),
      queryLiveUse: () => ({ state: 'idle' }),
    });

    const report = await coordinator.attemptClose(ownerKey(PROJECT_A), 'user');

    assert.strictEqual(report.disposition, 'retained');
    assert.strictEqual(report.partial, true);
    assert.strictEqual(report.warnings.length, 1, 'the missing restore is reported, not hidden');
    assert.match(report.warnings[0] ?? '', /Layout restore failed/);
    assert.strictEqual(shell.window.isDestroyed(), false);
  });
});
