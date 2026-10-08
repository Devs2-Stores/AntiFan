/**
 * AntiFan Browser Desktop — Protected close and host disposal
 *
 * Phase-4 host-side contract, proved with real host objects over a stubbed Electron
 * seam: the unload-aware page close the close coordinator injects as `deps.closePage`,
 * the closing reservation this host consumes, the visible-member/auxiliary split, the
 * shell-local layout restore, and exactly-once child-content disposal.
 *
 * The stubs model the Electron contract the host depends on rather than a convenient
 * one: `close(opts)` returns nothing, so an outcome can only arrive as an event;
 * `destroy()` emits `destroyed`; and `will-prevent-unload` carries a `preventDefault`
 * the host must never call, because calling it would override the page's veto.
 *
 * Presentation helpers (`switchTab`, `reassertPresentedView`, `createTab`,
 * `broadcastState`) are stubbed where a case is about *which* path the host takes. The
 * shell window is a spy double, so "no window was raised" is asserted on real calls
 * rather than on the absence of code.
 */
import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { lifecycleLogDrained } from '../../src/main/diagnostics/main-lifecycle-log';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { createShellDouble, type ShellDoubleWindow } from '../support/project-window-shell-double';

// The close path journals a `tabhost.tabClosed` row per removal into the app's
// lifecycle log. Redirect it to a temp runtime BEFORE the first event is recorded —
// the journal binds its file lazily on first write.
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-closedisposal-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

function tabClosedRows(sinceCount = 0): Array<Record<string, unknown>> {
  const logPath = path.join(RUNTIME_DIR, 'logs', 'main.log');
  if (!fs.existsSync(logPath)) return [];
  const rows = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"tabhost.tabClosed"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return sinceCount > 0 ? rows.slice(sinceCount) : rows;
}

type TestHost = any;

interface CloseLog {
  entries: string[];
  throwOnClose: boolean;
  destroyOnClose: boolean;
  destroyThenVetoOnClose: boolean;
}

type Listener = (...args: unknown[]) => void;

function createLog(): CloseLog {
  return { entries: [], throwOnClose: false, destroyOnClose: false, destroyThenVetoOnClose: false };
}

/**
 * A `WebContents` double with EventEmitter semantics: registration order is observable,
 * `once` listeners detach after firing, and `destroy()` is the only thing that emits
 * `destroyed` — exactly as Electron behaves.
 */
interface FakeWebContents {
  id: string;
  closeCalls: number;
  destroyCalls: number;
  prevented: boolean;
  isDestroyed(): boolean;
  on(event: string, listener: Listener): void;
  once(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
  listenerCount(event: string): number;
  emit(event: string, ...args: unknown[]): void;
  close(opts?: { waitForBeforeUnload?: boolean }): void;
  destroy(): void;
  setBackgroundThrottling(): void;
  executeJavaScript(): Promise<unknown>;
  send(): void;
  focus(): void;
  invalidate(): void;
  getURL(): string;
}

function createFakeWebContents(id: string, log: CloseLog): FakeWebContents {
  const listeners = new Map<string, Listener[]>();
  const onceListeners = new Set<Listener>();
  let destroyed = false;
  const api: FakeWebContents = {
    id,
    closeCalls: 0,
    destroyCalls: 0,
    prevented: false,
    isDestroyed: () => destroyed,
    on(event: string, listener: Listener): void {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      log.entries.push(`on:${id}:${event}`);
    },
    once(event: string, listener: Listener): void {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      onceListeners.add(listener);
      log.entries.push(`once:${id}:${event}`);
    },
    removeListener(event: string, listener: Listener): void {
      const list = listeners.get(event);
      if (!list) return;
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
      onceListeners.delete(listener);
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        if (onceListeners.has(listener)) api.removeListener(event, listener);
        listener(...args);
      }
    },
    close(opts?: { waitForBeforeUnload?: boolean }): void {
      api.closeCalls += 1;
      log.entries.push(`close:${id}:waitForBeforeUnload=${String(opts?.waitForBeforeUnload)}`);
      if (log.throwOnClose) throw new Error('native close failed');
      if (log.destroyOnClose) api.destroy();
      if (log.destroyThenVetoOnClose) {
        api.destroy();
        api.emit('will-prevent-unload', { preventDefault: () => { api.prevented = true; } });
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      api.destroyCalls += 1;
      log.entries.push(`destroy:${id}`);
      api.emit('destroyed');
    },
    setBackgroundThrottling(): void {},
    executeJavaScript(): Promise<unknown> {
      return Promise.resolve(undefined);
    },
    send(): void {},
    focus(): void {},
    invalidate(): void {},
    getURL: () => 'https://example.test/',
  };
  return api;
}

function createWindowSpy() {
  const calls: string[] = [];
  const children: unknown[] = [];
  const bounds = { x: 0, y: 0, width: 1440, height: 900 };
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isMaximized: () => false,
    getBounds: () => bounds,
    getContentBounds: () => bounds,
    contentView: {
      children,
      addChildView: (view: unknown) => {
        if (!children.includes(view)) children.push(view);
      },
      removeChildView: (view: unknown) => {
        const idx = children.indexOf(view);
        if (idx >= 0) children.splice(idx, 1);
      },
    },
    on: () => {},
    removeListener: () => {},
    show: () => { calls.push('show'); },
    showInactive: () => { calls.push('showInactive'); },
    focus: () => { calls.push('focus'); },
    focusOnWebView: () => { calls.push('focusOnWebView'); },
    moveTop: () => { calls.push('moveTop'); },
    setBounds: () => { calls.push('setBounds'); },
  };
  return { window, calls, children };
}

interface HarnessOptions {
  tabIds?: string[];
  activeTabId?: string;
  ephemeralTabIds?: string[];
  mobileViewOn?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  const log = createLog();
  const host = Object.create(NativeTabHost.prototype) as TestHost;
  const tabIds = options.tabIds ?? ['tab-1'];
  const records = new Map<string, unknown>();
  const webContentsById = new Map<string, FakeWebContents>();
  const windowSpy = createWindowSpy();

  for (const id of tabIds) {
    const wc = createFakeWebContents(id, log);
    webContentsById.set(id, wc);
    const record: { state: Record<string, unknown>; view: { webContents: unknown }; mobileView?: { webContents: unknown } } = {
      state: {
        id,
        url: 'https://example.test/',
        title: id,
        ephemeral: options.ephemeralTabIds?.includes(id) === true,
      },
      view: { webContents: wc },
    };
    if (options.mobileViewOn?.includes(id)) {
      const mobileWc = createFakeWebContents(`${id}-mobile`, log);
      webContentsById.set(`${id}-mobile`, mobileWc);
      record.mobileView = { webContents: mobileWc };
    }
    records.set(id, record);
  }

  host.tabs = records;
  host.tabOrder = [...tabIds];
  host.activeTabId = options.activeTabId ?? tabIds[0] ?? '';
  host.isDisposed = false;
  host.closeAdmission = null;
  host.pendingPageCloses = new Map();
  host.attemptAuthorizedCloses = new Set();
  host.childViewsDisposed = false;
  host.terminalSubscriptionReleases = [];
  host.automationTabId = null;
  host.isInspecting = false;
  host.recentlyClosedTabs = [];
  host.tabPreviewUnsubscribers = new Map();
  host.documentGenerations = new Map();
  host.semanticDocumentGenerations = new Map();
  host.targetOperationQueues = new Map();
  host.targetOperationOwners = new Map();
  host.sessionTabPools = new Map();
  host.closedTabAnchors = new Map();
  host.tabThemeQaStates = new Map();
  host.terminalAgentAffinity = new Map();
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  host.popoutWindow = null;
  host.captureLift = null;
  host.captureLiftQueue = [];
  host.captureHostWindow = null;
  host.terminalDisplayedSessions = new Map();
  host.hibernatingTabIds = new Set();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.agentWorkingRefs = new Map();
  host.agentWorkingTimers = new Map();
  host.broadcastCount = 0;
  host.shell = createShellDouble({ window: windowSpy.window as unknown as ShellDoubleWindow });
  host.semanticRefRegistry = new SemanticRefRegistry();
  host.asyncQaQueue = { abortAll: () => { log.entries.push('abortAll'); } };
  host.networkTracker = { dispose: () => {}, detachTarget: () => {} };
  host.previewWatcherPool = { clear: () => {} };
  host.broadcastState = () => { host.broadcastCount += 1; };
  host.switchTab = (id: string) => { log.entries.push(`switchTab:${id}`); return true; };
  host.createTab = (url: string) => { log.entries.push(`createTab:${url}`); return 'created-tab'; };
  host.reassertPresentedView = () => { log.entries.push('reassertPresentedView'); };
  host.updateLayout = () => {};
  host.persistTabs = () => { log.entries.push('persistTabs'); };
  host.flushAllSessions = () => Promise.resolve();
  host.flushAllTerminalDataBatches = () => {};

  return { host, log, records, webContentsById, windowSpy };
}

function countMatching(log: CloseLog, prefix: string): number {
  return log.entries.filter((entry) => entry.startsWith(prefix)).length;
}

describe('NativeTabHost unload-aware page close', () => {
  it('still reports closed when the native close destroys the page before it returns', async () => {
    // The observers must already be attached when the native close runs: this double's `close()`
    // destroys the page synchronously, so a listener registered afterwards would never see
    // `destroyed` and the attempt would fall through to its bound as `unknown`.
    const { host, log } = createHarness();
    log.destroyOnClose = true;

    assert.strictEqual(await host.closePage('tab-1'), 'closed');
    assert.strictEqual(host.tabs.has('tab-1'), false, 'the closed page is finalized, not left owned');
  });

  it('reports a veto as skipped and keeps the page and its record, never overriding it', async () => {
    const { host, log, webContentsById, records } = createHarness();
    const wc = webContentsById.get('tab-1')!;
    const closing = host.closePage('tab-1');
    wc.emit('will-prevent-unload', { preventDefault: () => { wc.prevented = true; } });

    assert.strictEqual(await closing, 'vetoed');
    assert.strictEqual(wc.prevented, false, 'the host must never preventDefault a page veto');
    assert.strictEqual(wc.destroyCalls, 0);
    assert.strictEqual(records.has('tab-1'), true, 'a vetoed page and its record survive');
    assert.strictEqual(wc.listenerCount('destroyed'), 0, 'the destroyed observer is released');
    assert.strictEqual(wc.listenerCount('will-prevent-unload'), 0, 'the veto observer is released');
    assert.deepStrictEqual(log.entries.filter((entry) => entry.startsWith('destroy:')), []);
  });

  it('reports a page destroyed during the close as closed, and a later veto does not rewrite it', async () => {
    const { host, log, webContentsById, records } = createHarness();
    const wc = webContentsById.get('tab-1')!;
    log.destroyThenVetoOnClose = true;

    assert.strictEqual(await host.closePage('tab-1'), 'closed');
    assert.strictEqual(wc.destroyCalls, 1, 'the tab content is disposed exactly once');
    assert.strictEqual(records.has('tab-1'), false, 'a closed page leaves no record behind');
    assert.strictEqual(host.tabOrder.includes('tab-1'), false);
    assert.deepStrictEqual(log.entries.filter((entry) => entry.startsWith('destroy:tab-1')), ['destroy:tab-1']);
  });

  it('rejects with the native error when the close call throws, and leaves no observer behind', async () => {
    const { host, webContentsById, records, log } = createHarness();
    const wc = webContentsById.get('tab-1')!;
    log.throwOnClose = true;

    await assert.rejects(() => host.closePage('tab-1'), /native close failed/);
    assert.strictEqual(wc.destroyCalls, 0);
    assert.strictEqual(records.has('tab-1'), true, 'a failed close keeps the page');
    assert.strictEqual(wc.listenerCount('destroyed'), 0, 'the destroyed observer is released');
    assert.strictEqual(wc.listenerCount('will-prevent-unload'), 0, 'the veto observer is released');
  });

  it('never calls close on an already destroyed instance and still disposes its record', async () => {
    const { host, log, webContentsById, records } = createHarness();
    const wc = webContentsById.get('tab-1')!;
    wc.destroy();
    const before = webContentsById.get('tab-1')!.closeCalls;

    assert.strictEqual(await host.closePage('tab-1'), 'closed');
    assert.strictEqual(webContentsById.get('tab-1')!.closeCalls, before, 'no native close is attempted on a terminal instance');
    assert.strictEqual(records.has('tab-1'), false);
    assert.deepStrictEqual(log.entries.filter((entry) => entry.startsWith('once:')), []);
  });

  it('resolves unknown for a page it cannot resolve, without touching any page', async () => {
    const { host, log } = createHarness();

    assert.strictEqual(await host.closePage('missing-tab'), 'unknown');
    assert.deepStrictEqual(log.entries, []);
  });

  it('closes a record-only page (hibernated or dead contents) as closed, not unknown', async () => {
    const { host, log, records } = createHarness();
    // Hibernation parks the record and drops the view: there is no page to ask,
    // no unload to veto, and the durable state lives in the record itself — so
    // the local cleanup IS the close. Reporting 'unknown' here retained whole
    // shells: the coordinator saw a page with no terminal outcome and refused.
    const record = records.get('tab-1') as { view?: unknown };
    delete record.view;

    assert.strictEqual(await host.closePage('tab-1'), 'closed');
    assert.strictEqual(records.has('tab-1'), false, 'a record-only page is disposed by its own close');
    assert.deepStrictEqual(log.entries.filter((entry) => entry.startsWith('close:')), [], 'no native close call exists to make');
  });

  it('does the same under the force flag: force has nothing to bypass when no contents exist', async () => {
    const { host, records } = createHarness();
    const record = records.get('tab-1') as { view?: unknown };
    delete record.view;

    assert.strictEqual(await host.closePage('tab-1', true), 'closed');
    assert.strictEqual(records.has('tab-1'), false);
  });

  it('shares one in-flight close between duplicate calls for the same page', async () => {
    const { host, log, webContentsById } = createHarness();
    const wc = webContentsById.get('tab-1')!;
    const first = host.closePage('tab-1');
    const second = host.closePage('tab-1');
    wc.destroy();

    assert.strictEqual(await first, 'closed');
    assert.strictEqual(await second, 'closed');
    assert.strictEqual(countMatching(log, 'close:tab-1'), 1, 'one native close per page');
  });
});

describe('NativeTabHost close reservation', () => {
  it('refuses to destroy a page reserved by an authorized close attempt', () => {
    const { host, log, webContentsById, records } = createHarness();
    host.setCloseAdmission({ isPageReserved: (tabId: string) => tabId === 'tab-1' });

    assert.strictEqual(host.closeTab('tab-1'), false);
    assert.strictEqual(records.has('tab-1'), true);
    assert.strictEqual(webContentsById.get('tab-1')!.destroyCalls, 0);
    assert.deepStrictEqual(log.entries.filter((entry) => entry.startsWith('destroy:')), []);
  });

  it('fails closed when the reservation cannot be read', () => {
    const { host, webContentsById } = createHarness();
    host.setCloseAdmission({
      isPageReserved: () => {
        throw new Error('reservation store unavailable');
      },
    });

    assert.strictEqual(host.closeTab('tab-1'), false);
    assert.strictEqual(webContentsById.get('tab-1')!.destroyCalls, 0);
  });

  it('lets the attempt\'s own close clean up the one page it reserved', async () => {
    const { host, records, webContentsById } = createHarness();
    host.setCloseAdmission({ isPageReserved: (tabId: string) => tabId === 'tab-1' });
    const wc = webContentsById.get('tab-1')!;

    const closing = host.closePage('tab-1');
    wc.destroy();

    assert.strictEqual(await closing, 'closed');
    assert.strictEqual(records.has('tab-1'), false, 'the attempt\'s own close still disposes the record');
  });

  it('keeps the pre-attempt behaviour verbatim when no attempt is running', () => {
    const { host, log } = createHarness();
    host.setCloseAdmission(null);

    assert.strictEqual(host.closeTab('tab-1'), true);
    assert.strictEqual(host.tabs.has('tab-1'), false);
    assert.strictEqual(
      log.entries.includes('createTab:https://www.google.com'),
      true,
      'closing the last presented page outside a close still repairs the empty window',
    );
  });

  it('does not manufacture a replacement page while the shell closes its own last page', async () => {
    const { host, log, webContentsById } = createHarness();
    host.setCloseAdmission({ isPageReserved: (tabId: string) => tabId === 'tab-1' });

    // The public path: `closePage` is the shell's own attempt, so it registers the authorization
    // the admission gate requires rather than the row reaching into that state itself.
    const closing = host.closePage('tab-1');
    webContentsById.get('tab-1')!.destroy();
    assert.strictEqual(await closing, 'closed');

    assert.strictEqual(host.tabs.has('tab-1'), false);
    assert.strictEqual(host.activeTabId, '');
    assert.strictEqual(
      log.entries.some((entry) => entry.startsWith('createTab:')),
      false,
      'an arrival manufactured by the close would make the shell impossible to close',
    );
  });

  it('keeps a page that arrives during a close as a real member and never destroys it', async () => {
    const { host, records, log, webContentsById } = createHarness({ tabIds: ['tab-a', 'tab-b'], activeTabId: 'tab-a' });
    host.setCloseAdmission({ isPageReserved: (tabId: string) => tabId === 'tab-a' });

    const closing = host.closePage('tab-a');
    webContentsById.get('tab-a')!.destroy();
    assert.strictEqual(await closing, 'closed');

    // The arrival a user or agent causes while the attempt is closing pages.
    const arrived = createFakeWebContents('tab-c', log);
    records.set('tab-c', { state: { id: 'tab-c', url: 'https://example.test/c', title: 'c' }, view: { webContents: arrived } });
    host.tabOrder.push('tab-c');

    assert.deepStrictEqual(host.visibleMemberTabIds(), ['tab-b', 'tab-c']);
    assert.strictEqual(host.closeTab('tab-c'), true, 'a non-reserved page still closes normally');
    assert.strictEqual(records.has('tab-b'), true, 'the other member was never touched');
  });
});

describe('NativeTabHost close telemetry', () => {
  it('labels a close driven by an authorized attempt as close-attempt', async () => {
    await lifecycleLogDrained();
    const mark = tabClosedRows().length;
    const { host } = createHarness({ tabIds: ['tele-attempt'] });
    // The authorization the close attempt installs for its own page: the fallback
    // source is what `finalizeClosedPage` relies on for post-closePage reconciliation.
    host.attemptAuthorizedCloses.add('tele-attempt');

    assert.strictEqual(host.closeTab('tele-attempt'), true);

    // Runtime journal rows are appended off the main thread; read after the drain.
    await lifecycleLogDrained();
    const rows = tabClosedRows(mark).filter((row) => row['tabId'] === 'tele-attempt');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['source'], 'close-attempt');
    assert.strictEqual(rows[0]!['urlOrigin'], 'https://example.test');
  });

  it('journals host-dispose once per tab when disposal bypasses closeTab', async () => {
    await lifecycleLogDrained();
    const mark = tabClosedRows().length;
    const { host } = createHarness({ tabIds: ['tele-dispose-1', 'tele-dispose-2'], ephemeralTabIds: ['tele-dispose-2'] });

    host.dispose();

    await lifecycleLogDrained();
    const rows = tabClosedRows(mark).filter((row) => row['source'] === 'host-dispose');
    const row1 = rows.find((row) => row['tabId'] === 'tele-dispose-1');
    const row2 = rows.find((row) => row['tabId'] === 'tele-dispose-2');
    assert.ok(row1, 'the visible tab removed by disposal is still attributable');
    assert.ok(row2, 'the ephemeral tab removed by disposal is still attributable');
    assert.strictEqual(row2!['ephemeral'], true);
    assert.strictEqual(rows.length, 2, 'no closeTab double-emit: the dispose path emits directly');
  });
});

describe('NativeTabHost member and auxiliary inventories', () => {
  it('keeps ephemeral views out of the member snapshot and inside the auxiliary inventory', () => {
    const { host } = createHarness({
      tabIds: ['tab-1', 'tab-2', 'agent-1', 'agent-2'],
      ephemeralTabIds: ['agent-1', 'agent-2'],
    });

    assert.deepStrictEqual(host.visibleMemberTabIds(), ['tab-1', 'tab-2']);
    assert.deepStrictEqual(host.auxiliaryViewTabIds(), ['agent-1', 'agent-2']);
  });

  it('never under-reports membership when a record is missing from the strip order', () => {
    const { host, records, log } = createHarness({ tabIds: ['tab-1'] });
    const wc = createFakeWebContents('tab-2', log);
    records.set('tab-2', { state: { id: 'tab-2', url: 'https://example.test/2', title: '2' }, view: { webContents: wc } });

    assert.deepStrictEqual(host.visibleMemberTabIds(), ['tab-1', 'tab-2']);
  });
});

describe('NativeTabHost surviving layout restore', () => {
  it('re-presents the surviving active page without raising a window', () => {
    const { host, log, windowSpy, webContentsById } = createHarness({
      tabIds: ['tab-a', 'tab-b'],
      activeTabId: 'tab-b',
    });

    assert.strictEqual(host.restoreSurvivingLayout(['tab-a', 'tab-b']), true);
    assert.deepStrictEqual(log.entries, ['reassertPresentedView']);
    assert.deepStrictEqual(windowSpy.calls, [], 'no show, focus or raise may follow a refused close');
    assert.strictEqual(webContentsById.get('tab-b')!.destroyCalls, 0);
  });

  it('falls back to the last survivor when the active page is gone', () => {
    const { host, log, windowSpy } = createHarness({ tabIds: ['tab-a', 'tab-b'], activeTabId: '' });

    assert.strictEqual(host.restoreSurvivingLayout(['tab-a', 'tab-b']), true);
    assert.deepStrictEqual(log.entries, ['switchTab:tab-b']);
    assert.deepStrictEqual(windowSpy.calls, []);
  });

  it('ignores a survivor that is not a member and does nothing when none survived', () => {
    const { host, log } = createHarness({
      tabIds: ['tab-a', 'agent-1'],
      activeTabId: '',
      ephemeralTabIds: ['agent-1'],
    });

    assert.strictEqual(host.restoreSurvivingLayout(['agent-1']), false, 'an auxiliary view is not a member page');
    assert.strictEqual(host.restoreSurvivingLayout(['tab-a']), true);
    assert.deepStrictEqual(log.entries, ['switchTab:tab-a']);
  });
});

describe('NativeTabHost disposal', () => {
  it('disposes every child view content exactly once, even when dispose runs twice', () => {
    const { host, records, webContentsById, windowSpy } = createHarness({
      tabIds: ['tab-1', 'tab-2'],
      mobileViewOn: ['tab-1'],
    });
    const desktop = webContentsById.get('tab-1')!;
    const mobile = webContentsById.get('tab-1-mobile')!;
    const second = webContentsById.get('tab-2')!;
    const firstRecord = records.get('tab-1') as { view: unknown; mobileView: unknown };
    const secondRecord = records.get('tab-2') as { view: unknown };
    // The views the host attached to the shell's content view: shell closure itself
    // proves nothing about them, so disposal has to detach and destroy each one.
    windowSpy.children.push(firstRecord.view, firstRecord.mobileView, secondRecord.view);

    host.dispose();
    host.dispose();

    assert.strictEqual(desktop.destroyCalls, 1);
    assert.strictEqual(mobile.destroyCalls, 1);
    assert.strictEqual(second.destroyCalls, 1);
    assert.deepStrictEqual(windowSpy.children, [], 'every disposed view is detached from the shell');
    assert.strictEqual(records.size, 0);
    assert.deepStrictEqual(host.tabOrder, []);
  });

  it('disposes a lifted capture view and its capture host window, which no tab record owns', () => {
    const { host, log } = createHarness();
    const raised = createFakeWebContents('raised', log);
    let hostWindowDestroyed = 0;
    host.captureLift = { token: 1, view: { webContents: raised }, origin: 'capture-host', liftedAtMs: Date.now(), lease: { release: () => {}, released: false } };
    host.captureHostWindow = {
      isDestroyed: () => false,
      destroy: () => { hostWindowDestroyed += 1; },
    };

    host.dispose();

    assert.strictEqual(raised.destroyCalls, 1);
    assert.strictEqual(hostWindowDestroyed, 1);
    assert.strictEqual(host.captureHostWindow, null);
    assert.strictEqual(host.captureLift, null);
  });

  it('runs its local cleanup and releases its subscriptions exactly once per host', () => {
    const { host, log } = createHarness({ tabIds: ['tab-1'] });
    let unsubscribed = 0;
    let released = 0;
    host.tabPreviewUnsubscribers.set('tab-1', () => { unsubscribed += 1; });
    host.terminalSubscriptionReleases.push(() => { released += 1; });
    host.sessionTabPools.set('terminal-1', new Set(['tab-1']));
    host.targetOperationQueues.set('tab-1:desktop', Promise.resolve());

    host.dispose();
    host.dispose();

    assert.strictEqual(unsubscribed, 1, 'the preview subscription is released once');
    assert.strictEqual(released, 1, 'the shared-manager subscription is released once');
    assert.strictEqual(countMatching(log, 'persistTabs'), 1, 'the final saved-tab write happens once');
    assert.strictEqual(countMatching(log, 'abortAll'), 1);
    assert.strictEqual(host.sessionTabPools.size, 0);
    assert.strictEqual(host.targetOperationQueues.size, 0);
    assert.strictEqual(host.tabPreviewUnsubscribers.size, 0);
    assert.strictEqual(host.terminalSubscriptionReleases.length, 0);
  });

  it('unsubscribes the shared TerminalManager listeners the constructor registered', () => {
    const manager = TerminalManager.getInstance();
    const observedEvents = new Set<string>(manager.eventNames().map(String));
    const before: Record<string, number> = {};
    for (const name of observedEvents) before[name] = manager.listenerCount(name);
    const { host } = createHarness();

    host.setupTerminalSubscriptions();
    assert.ok(
      manager.listenerCount('data') > (before['data'] ?? 0),
      'the host registers on the shared singleton'
    );

    host.dispose();
    // Every event the host touched must come back to its pre-registration count, whatever that
    // number was - the releases have to actually detach, not merely be recorded as released.
    const after = new Set<string>([...observedEvents, ...manager.eventNames().map(String)]);
    for (const name of after) {
      assert.strictEqual(
        manager.listenerCount(name),
        before[name] ?? 0,
        `disposal must release every "${name}" listener the host registered`
      );
    }
    assert.strictEqual(host.terminalSubscriptionReleases.length, 0, 'the tracking set is emptied by disposal');
  });
});

after(async () => {
  await lifecycleLogDrained();
  try {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  } catch {}
});
