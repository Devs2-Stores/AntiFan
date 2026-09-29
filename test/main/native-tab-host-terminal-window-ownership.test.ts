/**
 * A terminal window a disposed host had to leave behind must not become unanswerable.
 *
 * A host asks its terminal windows (the sidebar popout and the workbench windows) to close
 * politely while it is disposed, and a `beforeunload` veto holds — the veto is never
 * overridden, because it belongs to the user's window and not to this process. That leaves a
 * live window whose host no longer exists, and the application quit gate resolves an auxiliary
 * terminal window through a *live* host (`surfaceForWebContents`). Without a process-wide
 * record of it, such a window is invisible to every later close attempt: alive while the
 * application reports a committed quit, and then destroyed by the platform with its veto
 * unread.
 *
 * These rows drive the real `dispose()` and the real `surfaceForWebContents` over window
 * doubles, because the question is exactly what one host still answers after another one was
 * disposed. `close()` posts its destruction on a later turn, the way Chromium does, so a row
 * that expects no survivor report fails if the check reads the state in the task that asked —
 * the clock is mocked, so that turn and the settle window are advanced instead of waited for.
 */
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NativeTabHost, isUnhostedTerminalWindow } from '../../src/main/browser/native-tab-host';
import { ownerKey, type WindowOwner } from '../../src/main/browser/project-window-shell';

const OWNER: WindowOwner = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-000000000f1e' };
const OWNER_KEY = ownerKey(OWNER);

/** Long enough for the window's own teardown and for the disposal's settle check to run. */
const SETTLE_WAIT_MS = 200;

/**
 * One terminal window. `close()` requests the close and Chromium lands the destruction on a
 * later turn; a window that refuses the close (a `beforeunload` veto) stays exactly as it is,
 * which is the case this suite exists for.
 */
class StubTerminalWindow {
  public readonly id: number;
  public readonly webContents: { id: number; isDestroyed: () => boolean; getURL: () => string };
  public closeCalls = 0;
  public pageUrl = '';
  private destroyed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(windowId: number, contentsId: number, private readonly refusesClose: boolean) {
    this.id = windowId;
    this.webContents = { id: contentsId, isDestroyed: () => this.destroyed, getURL: () => this.pageUrl };
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public close(): void {
    this.closeCalls += 1;
    if (this.refusesClose) return;
    setTimeout(() => { this.markGone(); }, 0);
  }

  /** A platform-driven death: the same terminal state a refused close never reaches. */
  public destroy(): void {
    this.markGone();
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (index >= 0 && existing) existing.splice(index, 1);
    return this;
  }

  private markGone(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of [...(this.listeners.get('closed') ?? [])]) listener();
  }
}

/**
 * A host with one terminal window, built over the real prototype: the question this suite asks
 * is what the real `dispose()` does with such a window, so only the collaborators dispose()
 * touches are replaced.
 *
 * The ownership record is process-wide by design — that is what makes a window answerable after
 * its host is gone — so every row names its own content id and disposes of the window it left
 * alive, instead of relying on another row's cleanup.
 */
function buildHost(refusesClose: boolean, contentsId: number, windowId = 31): { host: NativeTabHost; window: StubTerminalWindow } {
  const window = new StubTerminalWindow(windowId, contentsId, refusesClose);
  const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
  host.shell = { owner: OWNER, isSidebarOpen: false, sidebarWidth: 380, disposeChrome: () => {} };
  host.popoutWindow = window;
  host.terminalWindows = new Map([[window.id, window]]);
  host.terminalWindowMeta = new Map([[window.id, { isPopout: true }]]);
  host.terminalDisplayedSessions = new Map();
  host.captureLift = null;
  host.captureLiftQueue = [];
  host.hibernatingTabIds = new Set();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.tabPreviewUnsubscribers = new Map();
  host.previewWatcherPool = { clear: () => {} };
  host.networkTracker = { dispose: () => {} };
  host.persistTabs = () => {};
  host.flushAllSessions = async () => {};
  host.flushAllTerminalDataBatches = () => {};
  host.disposeChildViewContents = () => {};
  host.releaseTerminalSubscriptions = () => {};
  return { host: host as unknown as NativeTabHost, window };
}

/** Another live window, which is the only thing that can answer for an unowned terminal window. */
function buildLiveHost(): NativeTabHost {
  const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
  host.shell = { chromeSurfaceFor: () => undefined, window: null, toolbarView: null, sidebarView: null, frameBackdropView: null };
  host.popoutWindow = null;
  host.terminalWindows = new Map();
  host.terminalDisplayedSessions = new Map();
  host.captureLift = null;
  host.captureLiftQueue = [];
  host.hibernatingTabIds = new Set();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  return host as unknown as NativeTabHost;
}

/**
 * Run one row on a mocked clock, with the honesty channel captured: the survivor report is the
 * only thing that says a window was left behind, so a row judges the report itself.
 */
function runOnMockedClock(run: () => void): string[] {
  const errors: string[] = [];
  const originalError = console.error;
  mock.timers.enable({ apis: ['setTimeout'] });
  console.error = (...args: unknown[]) => { errors.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    run();
    mock.timers.tick(SETTLE_WAIT_MS);
    return errors;
  } finally {
    console.error = originalError;
    mock.timers.reset();
  }
}

const survivorReports = (errors: string[]): string[] => errors.filter((line) => line.includes('still alive'));

describe('NativeTabHost terminal window ownership', () => {
  it('keeps a terminal window a disposed host had to leave behind answerable to a live host', () => {
    const live = buildLiveHost();
    const { host, window } = buildHost(true, 41);

    assert.equal(live.surfaceForWebContents(window.webContents.id), undefined, 'another window claimed this content before any disposal');
    assert.equal(isUnhostedTerminalWindow(window.webContents.id), false, 'a hosted terminal window was answered as unhosted');
    runOnMockedClock(() => { host.dispose(); });

    assert.equal(window.closeCalls, 1, 'disposal must ask the terminal window to close');
    assert.equal(window.isDestroyed(), false, 'the double refused the close and must survive it');
    assert.equal(isUnhostedTerminalWindow(window.webContents.id), true, 'a terminal window no host answers for must be reported as such');
    assert.equal(
      live.surfaceForWebContents(window.webContents.id),
      'terminalPopout',
      'a live host must still recognise the terminal window its peer had to leave behind'
    );
    // The answer is about terminal windows only: an unrelated renderer stays unclaimed.
    assert.equal(live.surfaceForWebContents(window.webContents.id + 1000), undefined, 'an unknown content was claimed as a terminal window');
    assert.equal(isUnhostedTerminalWindow(window.webContents.id + 1000), false, 'an unknown content was answered as an unhosted terminal window');
    window.destroy();
    assert.equal(isUnhostedTerminalWindow(window.webContents.id), false, 'a window that is gone is still answered as an unhosted terminal window');
  });

  it('drops the answer the moment that window is gone', () => {
    const live = buildLiveHost();
    const { host, window } = buildHost(true, 42);
    runOnMockedClock(() => { host.dispose(); });
    assert.equal(live.surfaceForWebContents(window.webContents.id), 'terminalPopout', 'precondition: the unowned window was recognised');

    window.destroy();

    assert.equal(live.surfaceForWebContents(window.webContents.id), undefined, 'a window that is gone must not be answered for');
  });

  it('answers for a later window that recycles the content id of a terminal window that died', () => {
    const live = buildLiveHost();
    const first = buildHost(true, 43, 31);
    runOnMockedClock(() => { first.host.dispose(); });
    first.window.destroy();
    assert.equal(live.surfaceForWebContents(first.window.webContents.id), undefined, 'precondition: the dead window is no longer answerable');

    // Chromium recycles a content id once its webContents is gone.
    const second = buildHost(true, 43, 32);
    runOnMockedClock(() => { second.host.dispose(); });

    assert.equal(
      live.surfaceForWebContents(second.window.webContents.id),
      'terminalPopout',
      'a recycled content id must answer for the window that holds it now, not for the one that died'
    );
    second.window.destroy();
  });

  it('leaves nothing behind and reports nothing when the terminal window closes as asked', () => {
    const live = buildLiveHost();
    const { host, window } = buildHost(false, 44);
    const errors = runOnMockedClock(() => { host.dispose(); });

    assert.equal(window.closeCalls, 1, 'disposal must ask the terminal window to close');
    assert.equal(window.isDestroyed(), true, 'the window that accepted the close must be gone');
    assert.equal(live.surfaceForWebContents(window.webContents.id), undefined, 'a window that closed is not left answerable');
    assert.deepEqual(survivorReports(errors), [], `a window that closed as asked was reported as a survivor: ${JSON.stringify(errors)}`);
  });

  it('reports a surviving terminal window honestly, naming the owner, the content and the window', () => {
    const { host, window } = buildHost(true, 45);
    const errors = runOnMockedClock(() => { host.dispose(); });

    const survivors = survivorReports(errors);
    assert.equal(survivors.length, 1, `expected exactly one survivor report, got ${JSON.stringify(errors)}`);
    const report: string = survivors[0] ?? '';
    assert.ok(report.length > 0, `the survivor report is missing: ${JSON.stringify(errors)}`);
    assert.ok(report.includes(OWNER_KEY), `the report must name the owner that was disposed: ${report}`);
    assert.ok(report.includes(`terminalPopout#${window.webContents.id}`), `the report must name the content that survived: ${report}`);
    assert.ok(report.includes(`window ${window.id}`), `the report must name the window that survived: ${report}`);
    window.destroy();
  });

  it('reports a survivor once, not once per lookup', () => {
    const live = buildLiveHost();
    const { host, window } = buildHost(true, 46);
    const errors = runOnMockedClock(() => {
      host.dispose();
      // A later close attempt resolves the window through a live host; that read must not be
      // mistaken for a new survivor.
      mock.timers.tick(SETTLE_WAIT_MS);
      live.surfaceForWebContents(window.webContents.id);
      live.surfaceForWebContents(window.webContents.id);
    });

    assert.equal(survivorReports(errors).length, 1, `survivor reports were duplicated: ${JSON.stringify(errors)}`);
    window.destroy();
  });

  it('refuses a terminal window whose page was replaced, and keeps the one still on the workbench page', () => {
    const live = buildLiveHost();
    const { host, window } = buildHost(true, 47);
    window.pageUrl = 'https://phishing.example/login';
    runOnMockedClock(() => { host.dispose(); });
    assert.equal(
      live.surfaceForWebContents(window.webContents.id),
      undefined,
      'a window showing a foreign page must not be trusted as a terminal workbench'
    );

    // A local page that is not the workbench renderer is refused too: the check compares the
    // page, it does not merely accept the file: scheme.
    window.pageUrl = `file:///${path.join(process.cwd(), 'package.json').replace(/\\/g, '/')}`;
    assert.equal(
      live.surfaceForWebContents(window.webContents.id),
      undefined,
      'another local page must not be answered as a terminal workbench'
    );

    const workbenchPage = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'standalone.html');
    assert.ok(fs.existsSync(workbenchPage), `the workbench page must exist for this control: ${workbenchPage}`);
    window.pageUrl = `file:///${workbenchPage.replace(/\\/g, '/')}`;
    assert.equal(
      live.surfaceForWebContents(window.webContents.id),
      'terminalPopout',
      'a window still showing the workbench page keeps its surface role'
    );
    window.destroy();
  });
});
