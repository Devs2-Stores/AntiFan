/**
 * A close the platform answers with NOTHING must still reach a terminal outcome.
 *
 * The swallow is measured, not hypothetical: a close issued while a previous refusal is still
 * processing produces no `close`, no `will-prevent-unload` and no `closed` at all. Both close
 * surfaces used to wait for exactly those two events, so one swallowed answer was permanent —
 * the page's pending promise was handed to every later attempt and its reservation stayed held
 * (the tab could never be closed again), and the shell's own close promise never resolved while
 * the application quit awaited it holding application admission, which made the app unquittable.
 *
 * The bound decides nothing about the close. `closed` is still reported only from a fact — a
 * destroyed instance, or a window that is gone — and nothing is destroyed on a timer: a
 * surviving page keeps its page, a surviving window keeps its window, and the next attempt asks
 * again. What the bound removes is silence being indistinguishable from progress.
 *
 * The doubles are the host and shell prototypes with the fields each path reads, because these
 * rows are about the outcome machine and not about Chromium. The clock is mocked so the
 * deadline is advanced instead of waited for.
 */
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost, PAGE_CLOSE_OUTCOME_DEADLINE_MS } from '../../src/main/browser/native-tab-host';
import { ProjectWindowShell } from '../../src/main/browser/project-window-shell';

const TAB_ID = 'tab-1';

/** A content that answers a close with nothing, and can be told to emit the one event that is a fact. */
class StubContents {
  public closeCalls = 0;
  private destroyed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public once(event: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(event) ?? [];
    this.listeners.set(event, bucket.filter((entry) => entry !== listener));
  }

  /** Ask to close: the platform's silent answer is exactly "nothing happens". */
  public close(): void {
    this.closeCalls += 1;
  }

  /** The platform landing the destruction, which is the only proof of a close. */
  public emitDestroyed(): void {
    this.destroyed = true;
    for (const listener of [...(this.listeners.get('destroyed') ?? [])]) listener();
  }

  /** The destruction landing WITHOUT its event, the way a dropped `destroyed` answer lands. */
  public markGone(): void {
    this.destroyed = true;
  }
}

interface TestHost {
  isDisposed: boolean;
  tabs: Map<string, unknown>;
  resolveTargetTabId: (tabId?: string) => string | undefined;
  pendingPageCloses: Map<string, Promise<string>>;
  attemptAuthorizedCloses: Set<string>;
  finalizeClosedPage: () => void;
}

function buildHost(): { host: NativeTabHost; contents: StubContents; finalizeCalls: () => number } {
  const contents = new StubContents();
  let finalizes = 0;
  const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
  host.isDisposed = false;
  host.tabs = new Map([[TAB_ID, { view: { webContents: contents } }]]);
  host.resolveTargetTabId = (tabId?: string) => tabId;
  host.pendingPageCloses = new Map();
  host.attemptAuthorizedCloses = new Set();
  // The record cleanup's own effects are exercised by the host's own suites; what this suite
  // needs from it is whether it ran at all, because that is the difference between an outcome
  // the shell can act on and a closed page's record left behind.
  host.finalizeClosedPage = () => { finalizes += 1; };
  return { host: host as unknown as NativeTabHost, contents, finalizeCalls: () => finalizes };
}

describe('page close outcome deadline', () => {
  it('reports unknown, not a wait, when the platform answers a page close with nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { host, contents } = buildHost();
      const pending = host.closePage(TAB_ID);
      await Promise.resolve();
      assert.equal(contents.closeCalls, 1, 'the page was asked to close');

      mock.timers.tick(PAGE_CLOSE_OUTCOME_DEADLINE_MS);

      assert.equal(await pending, 'unknown', 'no terminal outcome is an outcome');
      assert.equal(contents.isDestroyed(), false, 'and the page is left standing');
    } finally {
      mock.timers.reset();
    }
  });

  it('releases the reservation, so a later attempt can ask the page again', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { host, contents } = buildHost();
      const state = host as unknown as TestHost;

      const first = host.closePage(TAB_ID);
      await Promise.resolve();
      mock.timers.tick(PAGE_CLOSE_OUTCOME_DEADLINE_MS);
      assert.equal(await first, 'unknown');

      assert.equal(state.pendingPageCloses.size, 0, 'a settled attempt leaves no pending entry');
      assert.equal(state.attemptAuthorizedCloses.size, 0, 'and no standing authorization');

      const second = host.closePage(TAB_ID);
      await Promise.resolve();
      assert.equal(contents.closeCalls, 2, 'the next attempt really asks again');
      mock.timers.tick(PAGE_CLOSE_OUTCOME_DEADLINE_MS);
      assert.equal(await second, 'unknown');
    } finally {
      mock.timers.reset();
    }
  });

  it('reports closed, and cleans the record up, when the destruction landed without its event', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { host, contents, finalizeCalls } = buildHost();
      const pending = host.closePage(TAB_ID);
      await Promise.resolve();

      // The instance is gone, but its `destroyed` event never reached this call. Reporting
      // silence here would be the false answer: the page IS closed, and the shell would keep
      // owning a record for it.
      contents.markGone();
      mock.timers.tick(PAGE_CLOSE_OUTCOME_DEADLINE_MS);

      assert.equal(await pending, 'closed', 'the bound reads the same fact the observer reads');
      assert.equal(finalizeCalls(), 1, 'and the closed record is cleaned up despite the missing event');
    } finally {
      mock.timers.reset();
    }
  });

  it('reports closed from the fact, and the deadline cannot change it afterwards', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { host, contents } = buildHost();
      const pending = host.closePage(TAB_ID);
      await Promise.resolve();

      contents.emitDestroyed();

      assert.equal(await pending, 'closed', 'a destroyed instance is a closed page');
      mock.timers.tick(PAGE_CLOSE_OUTCOME_DEADLINE_MS * 2);
      assert.equal(await pending, 'closed', 'a settled outcome is final');
    } finally {
      mock.timers.reset();
    }
  });
});

/** A window that answers its own close with nothing, and can be told to be gone. */
class StubWindow {
  public closeCalls = 0;
  private destroyed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public once(event: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(event) ?? [];
    this.listeners.set(event, bucket.filter((entry) => entry !== listener));
  }

  public close(): void {
    this.closeCalls += 1;
  }

  public markGone(): void {
    this.destroyed = true;
  }
}

interface TestShell {
  closeAttemptCounter: number;
  activeCloseAttempt: unknown;
  observeCloseAttempt: (attempt: unknown) => void;
}

function buildShell(): { shell: ProjectWindowShell; window: StubWindow; attempts: Array<{ isSettled: () => boolean; settle: (outcome: string) => void }>; disposalCalls: () => number } {
  const window = new StubWindow();
  const attempts: Array<{ isSettled: () => boolean; settle: (outcome: string) => void }> = [];
  let disposals = 0;
  const shell = Object.create(ProjectWindowShell.prototype) as Record<string, unknown>;
  shell.window = window;
  shell.closeAttemptCounter = 0;
  shell.activeCloseAttempt = null;
  // The attempt's own observers are not this suite's subject; capturing the attempt lets a row
  // settle it the way a real native event would.
  shell.observeCloseAttempt = (attempt: unknown) => { attempts.push(attempt as { isSettled: () => boolean; settle: (outcome: string) => void }); };
  // A `'closed'` outcome owes the disposal audit, so the double must survive it: this shell owns
  // no contents, and the disposal is counted so a row can prove the audit actually ran.
  shell.everOwnedContents = () => [];
  shell.isContentsDestroyed = () => true;
  shell.disposeChrome = () => { disposals += 1; };
  shell.owner = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-000000000f1e' };
  return { shell: shell as unknown as ProjectWindowShell, window, attempts, disposalCalls: () => disposals };
}

describe('shell self close outcome deadline', () => {
  it('reports unknown for a window that answers its close with nothing, and leaves it standing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { shell, window } = buildShell();
      const pending = shell.closeSelf();
      await Promise.resolve();
      assert.equal(window.closeCalls, 1, 'the window was asked to close');

      mock.timers.tick(2_000);

      assert.equal(await pending, 'unknown');
      assert.equal(window.isDestroyed(), false, 'a surviving window keeps its window');
    } finally {
      mock.timers.reset();
    }
  });

  it('reports closed when the window is in fact gone by the deadline', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { shell, window, disposalCalls } = buildShell();
      const pending = shell.closeSelf();
      await Promise.resolve();

      window.markGone();
      mock.timers.tick(2_000);

      assert.equal(await pending, 'closed', 'the deadline reports the fact it can read');
      assert.equal(disposalCalls(), 1, 'and a closed shell still owes, and runs, its disposal audit');
    } finally {
      mock.timers.reset();
    }
  });

  it('lets the native outcome win before the deadline', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { shell, attempts } = buildShell();
      const pending = shell.closeSelf();
      await Promise.resolve();
      const attempt = attempts[0];
      assert.ok(attempt, 'one close attempt is running');

      attempt.settle('vetoed');

      assert.equal(await pending, 'vetoed', 'a veto is reported as soon as it arrives');
      assert.equal(attempt.isSettled(), true);
    } finally {
      mock.timers.reset();
    }
  });
});
