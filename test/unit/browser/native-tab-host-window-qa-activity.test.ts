/**
 * NativeTabHost: host-window presentation, Theme QA state rows, and terminal activity throttling.
 * Each runs on a partially constructed host (`Object.create` plus only the fields the path reads).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { TERMINAL_CHANNELS } from '../../../src/shared/contracts';
import { AsyncThemeQaQueue } from '../../../src/main/qa/async-qa-job-queue';
import { acquireQaRunLock, resetQaRunLocksForTests } from '../../../src/main/qa/qa-run-lock';

interface FakeWindow {
  destroyed: boolean;
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  /** Windows' SW_SHOWNOACTIVATE brings a minimized window back; false models a platform that does not. */
  showInactiveUnminimizes: boolean;
  calls: string[];
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  restore(): void;
  showInactive(): void;
  show(): void;
  focus(): void;
}

function fakeWindow(init: Partial<Pick<FakeWindow, 'visible' | 'minimized' | 'maximized' | 'showInactiveUnminimizes'>> = {}): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    visible: true,
    minimized: false,
    maximized: false,
    showInactiveUnminimizes: true,
    ...init,
    calls: [],
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible && !win.minimized,
    isMinimized: () => win.minimized,
    isMaximized: () => win.maximized,
    restore: () => {
      win.calls.push('restore');
      win.minimized = false;
    },
    showInactive: () => {
      win.calls.push('showInactive');
      win.visible = true;
      if (win.showInactiveUnminimizes) win.minimized = false;
    },
    show: () => {
      win.calls.push('show');
      win.visible = true;
    },
    focus: () => {
      win.calls.push('focus');
    },
  };
  return win;
}

describe('host window presentation', () => {
  function hostWith(win: FakeWindow) {
    const host = Object.create(NativeTabHost.prototype);
    host.tabs = new Map([['tab-1', { state: { id: 'tab-1' } }]]);
    host.activeTabId = 'tab-1';
    host.shell = { window: win };
    host.unfocusedWindowPresenter = null;
    return host;
  }

  it('reports a minimized window as hidden and a shown window as visible', () => {
    const minimized = hostWith(fakeWindow({ minimized: true }));
    assert.deepEqual(minimized.getHostWindowPresentation('tab-1'), {
      visible: false,
      minimized: true,
      maximized: false,
      hostWindowHidden: true,
    });
    const shown = hostWith(fakeWindow({ maximized: true }));
    assert.deepEqual(shown.getHostWindowPresentation(), {
      visible: true,
      minimized: false,
      maximized: true,
      hostWindowHidden: false,
    });
  });

  it('answers undefined for a tab the host does not own', () => {
    assert.equal(hostWith(fakeWindow()).getHostWindowPresentation('tab-other'), undefined);
  });

  it('restores a minimized window with showInactive alone, never restore() or focus', () => {
    const win = fakeWindow({ minimized: true });
    const host = hostWith(win);
    const result = host.restoreHostWindowUnfocused('tab-1');
    assert.equal(result.restored, true);
    assert.equal(result.presentation?.hostWindowHidden, false);
    assert.deepEqual(win.calls, ['showInactive']);
  });

  it('falls back to restore() only when showInactive leaves the window minimized', () => {
    const win = fakeWindow({ minimized: true, showInactiveUnminimizes: false });
    const host = hostWith(win);
    const result = host.restoreHostWindowUnfocused('tab-1');
    assert.equal(result.restored, true);
    assert.deepEqual(win.calls, ['showInactive', 'restore']);
  });

  it('uses the injected presenter when the composition root provides one', () => {
    const win = fakeWindow({ minimized: true });
    const host = hostWith(win);
    let presented = 0;
    host.setUnfocusedWindowPresenter(() => {
      presented += 1;
      win.minimized = false;
    });
    assert.equal(host.restoreHostWindowUnfocused('tab-1').restored, true);
    assert.equal(presented, 1);
    assert.deepEqual(win.calls, [], 'the presenter owns the window calls');
  });

  it('leaves a window that is already on screen untouched', () => {
    const win = fakeWindow();
    const host = hostWith(win);
    const result = host.restoreHostWindowUnfocused('tab-1');
    assert.equal(result.restored, false);
    assert.equal(result.presentation?.hostWindowHidden, false);
    assert.deepEqual(win.calls, []);
  });

  it('reports not restored when the window never came back', () => {
    const win = fakeWindow({ minimized: true });
    const host = hostWith(win);
    host.setUnfocusedWindowPresenter(() => {});
    const result = host.restoreHostWindowUnfocused('tab-1');
    assert.equal(result.restored, false);
    assert.equal(result.presentation?.hostWindowHidden, true);
  });
});

describe('Theme QA state rows', () => {
  function hostWithTabs(...ids: string[]) {
    const host = Object.create(NativeTabHost.prototype);
    host.tabs = new Map(ids.map((id) => [id, { state: { id } }]));
    host.tabThemeQaStates = new Map();
    host.activeTabId = '';
    host.shell = {};
    host.broadcastState = () => {};
    return host;
  }

  it('an idle tab has no count and says why', () => {
    const state = hostWithTabs('tab-1').getThemeQaState('tab-1');
    assert.equal(state.status, 'idle');
    assert.equal(state.issueCount, null);
    assert.equal(state.reasonCode, 'QA_NOT_RUN');
  });

  it('a finished report publishes its critical count as a number', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-1', {
      summary: { criticalCount: 3, passed: false, verdict: 'FAIL' },
      artifacts: [{ kind: 'report', id: 'art-1' }],
    });
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.status, 'fail');
    assert.equal(state.issueCount, 3);
    assert.equal(state.reportArtifactId, 'art-1');
    assert.equal(state.reasonCode, undefined);
  });

  it('a passing report publishes zero findings, distinct from "not run"', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-1', { summary: { criticalCount: 0, passed: true, verdict: 'PASS' } });
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.status, 'pass');
    assert.equal(state.issueCount, 0);
  });

  it('an inconclusive report publishes no count and carries its reason code', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-1', {
      summary: { criticalCount: 0, passed: false, verdict: 'INCONCLUSIVE' },
      artifacts: [{ kind: 'report', id: 'art-2' }],
    });
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.issueCount, null, 'not "0 issues"');
    assert.equal(state.reasonCode, 'QA_INCONCLUSIVE');
    assert.notEqual(state.status, 'pass');
    assert.notEqual(state.status, 'fail');
    assert.equal(state.reportArtifactId, 'art-2');
  });

  it('a capture-environment inconclusive run keeps no count even when suspect criticals exist', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-1', {
      summary: { criticalCount: 4, passed: false, verdict: 'INCONCLUSIVE', environment: { degraded: true } },
    });
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.issueCount, null);
    assert.equal(state.reasonCode, 'QA_INCONCLUSIVE');
  });

  it('an inconclusive verdict with observed criticals and a healthy environment stays a failure with its count', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-1', { summary: { criticalCount: 2, passed: false, verdict: 'INCONCLUSIVE' } });
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.status, 'fail');
    assert.equal(state.issueCount, 2);
    assert.equal(state.reasonCode, undefined);
  });

  it('derives the count from the findings when the summary has none', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-1', {
      findings: { liquid: { errors: [{}, {}] }, overflow: { culprits: [{}] }, assets: { brokenAssets: [{}] }, hsRules: { totalViolations: 4 } },
    });
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.issueCount, 8);
    assert.equal(state.status, 'fail');
  });

  it('ignores a report for a tab that closed meanwhile', () => {
    const host = hostWithTabs('tab-1');
    host.publishThemeQaState('tab-gone', { summary: { criticalCount: 1, passed: false } });
    assert.equal(host.tabThemeQaStates.has('tab-gone'), false);
  });
});

describe('Theme QA scan run lock', () => {
  interface Deferred {
    promise: Promise<unknown>;
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }
  const deferred = (): Deferred => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    return { promise, resolve, reject };
  };

  function scanHost() {
    const runs: Deferred[] = [];
    const host = Object.create(NativeTabHost.prototype);
    host.tabs = new Map([['tab-1', { state: { id: 'tab-1', url: 'https://shop.example.com/' } }]]);
    host.tabThemeQaStates = new Map();
    host.activeTabId = '';
    host.shell = {};
    host.broadcastState = () => {};
    host.getDocumentGeneration = () => 1;
    host.resolveTabWorkspace = () => '';
    host.guardQaWorkspaceRoot = () => ({ root: '' });
    host.asyncQaQueue = new AsyncThemeQaQueue();
    host.controlPlane = {
      getLease: () => ({ projectId: 'p', workspaceId: 'w', runtimeId: 'r', hostEpoch: 1 }),
      validateThemeQa: () => {
        const run = deferred();
        runs.push(run);
        return run.promise;
      },
    };
    return { host, runs };
  }

  const passReport = { summary: { criticalCount: 0, passed: true, verdict: 'PASS' } };

  it('refuses a second scan on the same tab while one runs and keeps the running row', async () => {
    resetQaRunLocksForTests();
    const { host, runs } = scanHost();
    const first = host.runThemeQa('tab-1');
    const second = await host.runThemeQa('tab-1');
    assert.equal(second.ok, false);
    assert.match(String(second.error), /^QA_BUSY:/);
    assert.equal(host.getThemeQaState('tab-1').status, 'running', 'the in-flight scan keeps its truthful row');
    assert.equal(runs.length, 1, 'the refused scan never reached the workflow');
    runs[0]!.resolve(passReport);
    assert.equal((await first).ok, true);
    assert.equal(host.getThemeQaState('tab-1').status, 'pass');
  });

  it('records QA_BUSY on the row when another run holds the tab', async () => {
    resetQaRunLocksForTests();
    const { host, runs } = scanHost();
    const held = acquireQaRunLock('tab-1');
    const result = await host.runThemeQa('tab-1');
    assert.equal(result.ok, false);
    assert.match(String(result.error), /^QA_BUSY:/);
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.status, 'error');
    assert.equal(state.reasonCode, 'QA_BUSY');
    assert.equal(state.issueCount, null);
    assert.equal(runs.length, 0);
    held.release();
    const next = host.runThemeQa('tab-1');
    runs[0]!.resolve(passReport);
    assert.equal((await next).ok, true);
  });

  it('does not release the lock when the scan is aborted while the workflow is still running', async () => {
    resetQaRunLocksForTests();
    const { host, runs } = scanHost();
    const first = host.runThemeQa('tab-1');
    host.asyncQaQueue.abort('tab-1');
    const during = await host.runThemeQa('tab-1');
    assert.equal(during.ok, false);
    assert.match(String(during.error), /^QA_BUSY:/, 'the aborted run is still measuring the tab');
    runs[0]!.reject(new Error('aborted'));
    assert.equal((await first).ok, false);
    const after = host.runThemeQa('tab-1');
    runs[1]!.resolve(passReport);
    assert.equal((await after).ok, true, 'the lock is free once the workflow has stopped');
  });

  it('releases the lock when the workflow throws', async () => {
    resetQaRunLocksForTests();
    const { host, runs } = scanHost();
    const first = host.runThemeQa('tab-1');
    runs[0]!.reject(Object.assign(new Error('capture failed'), { code: 'CAPTURE_TIMEOUT' }));
    const failed = await first;
    assert.equal(failed.ok, false);
    assert.equal(host.getThemeQaState('tab-1').reasonCode, 'CAPTURE_TIMEOUT');
    const next = host.runThemeQa('tab-1');
    runs[1]!.resolve(passReport);
    assert.equal((await next).ok, true);
  });
});

describe('terminal activity throttle', () => {
  interface Sent {
    channel: string;
    args: unknown[];
  }

  function makeSurface(id: number) {
    const sent: Sent[] = [];
    const wc = {
      id,
      mainFrame: {},
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        sent.push({ channel, args });
      },
    };
    return { wc, sent };
  }

  function makeHost() {
    const sidebar = makeSurface(31);
    const host = Object.create(NativeTabHost.prototype);
    host.shell = { isSidebarOpen: true, sidebarView: { webContents: sidebar.wc } };
    host.terminalWindows = new Map();
    host.terminalDisplayedSessions = new Map();
    host.terminalFanoutMessages = 0;
    host.terminalActivitySlots = new Map();
    host.terminalActivityStats = { sent: 0, coalesced: 0, bytes: 0 };
    let now = 10_000;
    host.terminalActivityClock = () => now;
    return {
      host,
      sidebar,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const chunk = (seq: number, data: string, generation = 1) => ({
    sessionId: 'sess-1',
    data,
    seq,
    fromSeq: seq,
    throughSeq: seq,
    generation,
  });
  const activityFrames = (sent: Sent[]) => sent.filter((m) => m.channel === TERMINAL_CHANNELS.ACTIVITY).map((m) => m.args[0] as Record<string, unknown>);

  it('sends the first envelope at once and coalesces a burst into one trailing envelope', () => {
    const { host, sidebar } = makeHost();
    for (let seq = 1; seq <= 100; seq += 1) host.dispatchTerminalData(chunk(seq, `line ${seq}\n`));

    assert.equal(activityFrames(sidebar.sent).length, 1, 'only the leading envelope went out inside the window');
    host.flushTerminalActivity();

    const frames = activityFrames(sidebar.sent);
    assert.equal(frames.length, 2, 'one trailing envelope carries the rest');
    assert.equal(frames[0]!['seq'], 1);
    assert.equal(frames[1]!['seq'], 100, 'the trailing envelope carries the newest sequence');
    assert.equal(frames[1]!['throughSeq'], 100, 'the ack cursor names the real end of the burst');
    assert.match(String(frames[1]!['data']), /line 100\n$/);

    const stats = host.getTerminalActivityStats();
    assert.equal(stats.sent, 2);
    assert.equal(stats.coalesced, 99);
  });

  it('keeps a wait marker that sat in a coalesced chunk', () => {
    const { host, sidebar } = makeHost();
    const marker = '\x1b]777;antifan;wait=1';
    host.dispatchTerminalData(chunk(1, 'first'));
    host.dispatchTerminalData(chunk(2, `asking${marker}`));
    host.dispatchTerminalData(chunk(3, 'trailing output'));
    host.flushTerminalActivity();
    const last = activityFrames(sidebar.sent).at(-1)!;
    assert.ok(String(last['data']).includes(marker), 'the merged tail still carries the marker');
    assert.equal(last['seq'], 3);
  });

  it('bounds the merged tail', () => {
    const { host, sidebar } = makeHost();
    host.dispatchTerminalData(chunk(1, 'x'));
    host.dispatchTerminalData(chunk(2, 'a'.repeat(3000)));
    host.dispatchTerminalData(chunk(3, 'b'.repeat(3000)));
    host.flushTerminalActivity();
    const last = activityFrames(sidebar.sent).at(-1)!;
    assert.ok(String(last['data']).length <= 4096);
    assert.ok(String(last['data']).endsWith('b'.repeat(100)));
  });

  it('keeps the first coalesced envelope\'s fromSeq so a current active pane applies the batch without a resync', () => {
    const { host, sidebar } = makeHost();
    for (let seq = 1; seq <= 5; seq += 1) host.dispatchTerminalData(chunk(seq, `l${seq}\n`));
    host.flushTerminalActivity();
    const last = activityFrames(sidebar.sent).at(-1)!;
    assert.equal(last['fromSeq'], 2, 'the trailing envelope starts at the first sequence it replaced');
    assert.equal(last['throughSeq'], 5);
    assert.equal(String(last['data']), 'l2\nl3\nl4\nl5\n', 'the classifier still sees every coalesced chunk');
  });

  it('names only the newest sequence once the merged head was dropped', () => {
    const { host, sidebar } = makeHost();
    host.dispatchTerminalData(chunk(1, 'x'));
    host.dispatchTerminalData(chunk(2, 'a'.repeat(3000)));
    host.dispatchTerminalData(chunk(3, 'b'.repeat(3000)));
    host.flushTerminalActivity();
    const last = activityFrames(sidebar.sent).at(-1)!;
    assert.equal(last['fromSeq'], 3, 'a head-truncated tail must not claim the whole range');
    assert.equal(last['throughSeq'], 3);
  });

  it('sends again at once once the window has passed', () => {
    const { host, sidebar, advance } = makeHost();
    host.dispatchTerminalData(chunk(1, 'a'));
    advance(150);
    host.dispatchTerminalData(chunk(2, 'b'));
    assert.equal(activityFrames(sidebar.sent).length, 2);
    assert.equal(host.getTerminalActivityStats().coalesced, 0);
  });

  it('throttles per session, not across sessions', () => {
    const { host, sidebar } = makeHost();
    host.dispatchTerminalData(chunk(1, 'a'));
    host.dispatchTerminalData({ ...chunk(1, 'b'), sessionId: 'sess-2' });
    assert.equal(activityFrames(sidebar.sent).length, 2);
  });

  it('flushes the pending envelope before a new generation so the renderer never merges across restarts', () => {
    const { host, sidebar } = makeHost();
    host.dispatchTerminalData(chunk(1, 'old-1', 1));
    host.dispatchTerminalData(chunk(2, 'old-2', 1));
    host.dispatchTerminalData(chunk(1, 'new-1', 2));
    host.flushTerminalActivity();
    const frames = activityFrames(sidebar.sent);
    assert.deepEqual(
      frames.map((f) => [f['generation'], f['seq']]),
      [[1, 1], [1, 2], [2, 1]]
    );
  });

  it('drops a pending envelope when the surface starts displaying the session', () => {
    const { host, sidebar } = makeHost();
    host.dispatchTerminalData(chunk(1, 'a'));
    host.dispatchTerminalData(chunk(2, 'b'));
    host.terminalDisplayedSessions.set('c31', new Set(['sess-1']));
    host.dispatchTerminalData(chunk(3, 'c'));
    host.flushTerminalActivity();
    assert.equal(activityFrames(sidebar.sent).length, 1, 'the stale trailing envelope is discarded');
    const data = sidebar.sent.filter((m) => m.channel === TERMINAL_CHANNELS.DATA);
    assert.equal(data.length, 1);
    assert.equal((data[0]!.args[0] as Record<string, unknown>)['seq'], 3);
  });
});

describe('NativeTabHost.getNetworkLog', () => {
  function hostWithPage(alive: boolean) {
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const wc = { isDestroyed: () => !alive, getURL: () => 'https://shop.example.com/' };
    const host = Object.create(NativeTabHost.prototype);
    host.tabs = new Map([['tab-1', { state: { id: 'tab-1' } }]]);
    host.activeTabId = 'tab-1';
    host.getTabWebContents = (tabId: string, pane: string) => (tabId === 'tab-1' && pane === 'desktop' ? wc : null);
    host.networkTracker = {
      ensureAttached: async (...args: unknown[]) => {
        calls.push({ kind: 'attach', args });
      },
      getNetworkLog: () => ({
        query: (...args: unknown[]) => {
          calls.push({ kind: 'query', args });
          return { entries: [], totalMatched: 0, returned: 0 };
        },
      }),
    };
    return { host, calls };
  }

  it('attaches the pane once and queries the log without the pane selector in the filters', async () => {
    const { host, calls } = hostWithPage(true);
    const result = await host.getNetworkLog('tab-1', { paneId: 'desktop', method: 'GET' });
    assert.equal(result.returned, 0);
    assert.deepEqual(calls.map((c) => c.kind), ['attach', 'query']);
    assert.deepEqual(calls[1]!.args, ['tab-1', 'desktop', { method: 'GET' }]);
  });

  it('refuses a tab with no live page as TARGET_STALE', async () => {
    const { host } = hostWithPage(false);
    await assert.rejects(
      () => host.getNetworkLog('tab-1'),
      (err: unknown) => (err as { code?: string }).code === 'TARGET_STALE'
    );
  });
});
