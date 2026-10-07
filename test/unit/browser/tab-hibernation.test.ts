import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  shouldHibernate,
  HIBERNATE_IDLE_MS,
  HIBERNATE_SWEEP_INTERVAL_MS,
  type HibernationContext,
} from '../../../src/main/browser/tab-hibernation';
import { NativeTabHost, type NativeTabRecord } from '../../../src/main/browser/native-tab-host';
import { createShellDouble, type ShellDoubleWindow } from '../../support/project-window-shell-double';
import type { AntiFanTab } from '../../../src/shared/contracts';

// The host journals presentation changes into the runtime the live app writes to; a
// unit run must not append to the user's journal, so it is redirected before the
// first event can be recorded (the journal resolves its path on first write).
process.env.ANTIFAN_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-hibernation-runtime-'));

const T0 = 1_700_000_000_000;

function makeState(overrides: Partial<AntiFanTab> = {}): AntiFanTab {
  return {
    id: 'tab-x',
    url: 'https://example.test/',
    title: 'Example',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<HibernationContext> = {}): HibernationContext {
  return { activeTabId: 'tab-active', now: T0, ...overrides };
}

function tab(
  id: string,
  state: Partial<AntiFanTab> = {},
  lastActiveAt?: number
) {
  return { id, state: makeState({ id, ...state }), lastActiveAt };
}

describe('shouldHibernate policy', () => {
  it('hibernates a background tab idle past 5 minutes', () => {
    const d = shouldHibernate(tab('tab-x', {}, T0 - 5 * 60 * 1000 - 1), makeCtx());
    assert.deepStrictEqual(d, { hibernate: true });
  });

  it('refuses the active tab of the window', () => {
    const d = shouldHibernate(tab('tab-active', {}, T0 - 10 * HIBERNATE_IDLE_MS), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'active-tab' });
  });

  it('refuses an audible tab', () => {
    const d = shouldHibernate(tab('tab-x', { isAudible: true }, 0), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'audible' });
  });

  it('refuses a tab still loading', () => {
    const d = shouldHibernate(tab('tab-x', { isLoading: true }, 0), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'loading' });
  });

  it('refuses offscreen and ephemeral agent-plane tabs', () => {
    for (const flag of ['offscreen', 'ephemeral'] as const) {
      const d = shouldHibernate(tab('tab-x', { [flag]: true }, 0), makeCtx());
      assert.deepStrictEqual(d, { hibernate: false, reason: 'agent-plane' }, flag);
    }
  });

  it('refuses the automation target tab', () => {
    const d = shouldHibernate(tab('tab-x', {}, 0), makeCtx({ automationTabId: 'tab-x' }));
    assert.deepStrictEqual(d, { hibernate: false, reason: 'automation-target' });
  });

  it('refuses an MCP/attachment-bound tab', () => {
    const d = shouldHibernate(tab('tab-x', {}, 0), makeCtx({ boundTabIds: new Set(['tab-x']) }));
    assert.deepStrictEqual(d, { hibernate: false, reason: 'mcp-bound' });
  });

  it('refuses a tab with an open CDP session', () => {
    const d = shouldHibernate(tab('tab-x', {}, 0), makeCtx({ cdpBoundTabIds: new Set(['tab-x']) }));
    assert.deepStrictEqual(d, { hibernate: false, reason: 'cdp-bound' });
  });

  it('refuses a tab whose beforeunload vetoed a prior probe', () => {
    const d = shouldHibernate(tab('tab-x', {}, 0), makeCtx({ unloadVetoedTabIds: new Set(['tab-x']) }));
    assert.deepStrictEqual(d, { hibernate: false, reason: 'unload-veto' });
  });

  it('refuses an already-hibernated tab (no double-sleep)', () => {
    const d = shouldHibernate(tab('tab-x', { hibernated: true }, 0), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'already-hibernated' });
  });

  it('refuses a tab still inside the idle window', () => {
    const d = shouldHibernate(tab('tab-x', {}, T0 - 5 * 60 * 1000 + 1), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'not-idle' });
  });

  it('hibernates exactly at the 5-minute boundary', () => {
    const d = shouldHibernate(tab('tab-x', {}, T0 - 5 * 60 * 1000), makeCtx());
    assert.deepStrictEqual(d, { hibernate: true });
  });

  it('holds a Google Docs tab idle past 5 minutes', () => {
    const url = 'https://docs.google.com/document/d/abc123/edit';
    const d = shouldHibernate(tab('tab-x', { url }, T0 - 10 * 60 * 1000), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'not-idle' });
  });

  it('holds a Google Sheets tab idle past 5 minutes', () => {
    const url = 'https://docs.google.com/spreadsheets/d/xyz/edit#gid=0';
    const d = shouldHibernate(tab('tab-x', { url }, T0 - 10 * 60 * 1000), makeCtx());
    assert.deepStrictEqual(d, { hibernate: false, reason: 'not-idle' });
  });

  it('hibernates a Google Docs/Sheets tab past the 20-minute floor', () => {
    for (const url of [
      'https://docs.google.com/document/d/abc123/edit',
      'https://docs.google.com/spreadsheets/d/xyz/edit',
    ]) {
      const d = shouldHibernate(tab('tab-x', { url }, T0 - 20 * 60 * 1000 - 1), makeCtx());
      assert.deepStrictEqual(d, { hibernate: true }, url);
    }
  });

  it('keeps the 5-minute threshold for non-editor Google URLs', () => {
    const urls = [
      'https://docs.google.com/',
      'https://docs.google.com/presentation/d/p1/edit',
      'https://docs.google.com/forms/d/f1/edit',
      'https://docs.google.com.evil.test/document/d/x/edit',
      'https://drive.google.com/drive/my-drive',
      'https://sheets.google.com/',
    ];
    for (const url of urls) {
      const d = shouldHibernate(tab('tab-x', { url }, T0 - 10 * 60 * 1000), makeCtx());
      assert.deepStrictEqual(d, { hibernate: true }, url);
    }
  });

  it('malformed URLs keep the 5-minute threshold', () => {
    const d = shouldHibernate(tab('tab-x', { url: 'not a url' }, T0 - 10 * 60 * 1000), makeCtx());
    assert.deepStrictEqual(d, { hibernate: true });
  });

  it('treats a never-active tab (lastActiveAt absent) as idlest — hibernates', () => {
    const d = shouldHibernate(tab('tab-x'), makeCtx());
    assert.deepStrictEqual(d, { hibernate: true });
  });

  it('honours a shorter idleMs seam without changing default policy behavior', () => {
    const d = shouldHibernate(tab('tab-x', {}, T0 - 5_000), makeCtx({ idleMs: 1_000 }));
    assert.deepStrictEqual(d, { hibernate: true });
    // Same tab under the default must be refused.
    const d2 = shouldHibernate(tab('tab-x', {}, T0 - 5_000), makeCtx());
    assert.deepStrictEqual(d2, { hibernate: false, reason: 'not-idle' });
  });

  it('uses Date.now() when ctx.now is absent', () => {
    const before = Date.now();
    // A tab last active "now" is inside the window regardless of clock.
    const d = shouldHibernate(tab('tab-x', {}, Date.now()), makeCtx({ now: undefined }));
    assert.deepStrictEqual(d, { hibernate: false, reason: 'not-idle' });
    assert.ok(Date.now() >= before);
  });

  it('exclusion order: active-tab wins over not-idle (a just-activated tab)', () => {
    const d = shouldHibernate(tab('tab-active', {}, T0), makeCtx({ automationTabId: 'tab-active' }));
    assert.deepStrictEqual(d, { hibernate: false, reason: 'active-tab' });
  });
});

describe('sweep constants', () => {
  it('sweep interval is 60 seconds', () => {
    assert.strictEqual(HIBERNATE_SWEEP_INTERVAL_MS, 60 * 1000);
  });
});

/**
 * Host-level hibernate/wake round-trip.
 *
 * The same Object.create(NativeTabHost.prototype) + shell-double harness the
 * presented-view suite uses, extended with webContents doubles that answer the
 * close probe the sweep issues. `recreateDesktopView` is stubbed because
 * `WebContentsView` exists only inside Electron — everything else runs the real
 * host methods: the unload-aware destroy, the record bookkeeping, the wake
 * orchestration and the capability funnel.
 */

type CloseOutcome = 'destroyed' | 'will-prevent-unload';

interface FakeWebContents {
  id: number;
  destroyed: boolean;
  closeOutcome: CloseOutcome;
  loadCalls: string[];
  execJs: string[];
  onceHandlers: Map<string, Array<() => void>>;
  isDestroyed(): boolean;
  isDevToolsOpened(): boolean;
  once(event: string, cb: () => void): void;
  emit(event: string): void;
  close(options?: { waitForBeforeUnload?: boolean }): void;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
}

let fakeWcSeq = 7000;

function makeFakeWebContents(closeOutcome: CloseOutcome): FakeWebContents {
  const wc: FakeWebContents = {
    id: ++fakeWcSeq,
    destroyed: false,
    closeOutcome,
    loadCalls: [],
    execJs: [],
    onceHandlers: new Map(),
    isDestroyed() {
      return wc.destroyed;
    },
    isDevToolsOpened() {
      return false;
    },
    once(event, cb) {
      const list = wc.onceHandlers.get(event) || [];
      list.push(cb);
      wc.onceHandlers.set(event, list);
    },
    emit(event) {
      for (const cb of wc.onceHandlers.get(event) || []) cb();
    },
    close() {
      // The sweep arms `will-prevent-unload` and `destroyed` BEFORE calling
      // close(), so emitting synchronously answers it exactly the way the real
      // platform does.
      if (wc.closeOutcome === 'destroyed') {
        wc.destroyed = true;
        wc.emit('destroyed');
      } else {
        wc.emit('will-prevent-unload');
      }
    },
    executeJavaScript(code) {
      wc.execJs.push(code);
      if (code.includes('scrollX')) return Promise.resolve({ x: 0, y: 300 });
      return Promise.resolve(undefined);
    },
    loadURL(url) {
      wc.loadCalls.push(url);
      // A committed load settles the wake-and-wait path; emit after the host
      // has armed its `did-finish-load`/`did-stop-loading` listeners.
      queueMicrotask(() => {
        wc.emit('did-finish-load');
        wc.emit('did-stop-loading');
      });
      return Promise.resolve();
    },
  };
  return wc;
}

// The Electron type a record carries; the doubles only need webContents.
function fakeView(wc: FakeWebContents): Electron.WebContentsView {
  return { webContents: wc, setBackgroundColor: () => {} } as unknown as Electron.WebContentsView;
}

interface HarnessedTab {
  record: NativeTabRecord;
  wc: FakeWebContents;
  /** Contents the record's view currently carries — the original fake, or the
      one the wake stub fabricated. */
  liveWc(): FakeWebContents;
}

// The members this suite reads or seeds; everything else stays the real host.
type HostHarness = NativeTabHost & { broadcastCount: number };

interface HibernationHarness {
  host: HostHarness;
  children: unknown[];
  tabs: Map<string, HarnessedTab>;
}

function createHibernationHost(
  specs: Array<{ id: string; url: string; closeOutcome?: CloseOutcome; lastActiveAt?: number }>,
  activeTabId: string,
): HibernationHarness {
  const host = Object.create(NativeTabHost.prototype) as HostHarness;
  const tabMap = new Map<string, NativeTabRecord>();
  const hostFields = host as unknown as Record<string, unknown>;
  hostFields.isDisposed = false;
  hostFields.tabs = tabMap;
  hostFields.tabOrder = [] as string[];
  hostFields.activeTabId = activeTabId;
  hostFields.automationTabId = null;
  hostFields.hibernatingTabIds = new Set<string>();
  hostFields.unloadVetoedTabIds = new Set<string>();
  hostFields.tabReadyWaits = new Map<string, Promise<boolean>>();
  hostFields.pendingPageCloses = new Map<string, Promise<unknown>>();
  hostFields.attemptAuthorizedCloses = new Set<string>();
  hostFields.tabByWebContents = new WeakMap<object, unknown>();
  hostFields.temporaryViewAttachCounts = new WeakMap<object, unknown>();
  // The probe narrows the seam's idle threshold; the harness mirrors it so the
  // seam's own context is exercised, not the shipped 15-minute fallback.
  hostFields.hibernationIdleMs = 1;
  host.broadcastCount = 0;

  const children: unknown[] = [];
  const windowDouble: ShellDoubleWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    contentView: {
      children,
      addChildView: (view: unknown, index?: number) => {
        const at = typeof index === 'number' ? Math.max(0, Math.min(index, children.length)) : children.length;
        children.splice(at, 0, view);
      },
      removeChildView: (view: unknown) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      },
    },
    on: () => {},
    removeListener: () => {},
  };
  hostFields.shell = createShellDouble({ window: windowDouble, isSidebarOpen: false });

  hostFields.resolveTargetTabId = (id?: string) => id || '';
  hostFields.broadcastState = () => {
    host.broadcastCount += 1;
  };
  hostFields.schedulePersist = () => {};
  hostFields.persistTabs = () => {};
  hostFields.destroyOwnedWebContents = () => {};
  hostFields.setSafeUserAgent = () => {};
  hostFields.setupTabWebContentsEvents = () => {};
  hostFields.indexTabWebContents = () => {};
  hostFields.networkTracker = undefined;
  hostFields.controlPlane = undefined;
  hostFields.devToolsHost = undefined;

  // Production builds a WebContentsView here; under node --test the constructor
  // does not exist, so the double fabricates the same surface and registers it
  // exactly the way recreateDesktopView does.
  hostFields.recreateDesktopView = (targetId: string, target: NativeTabRecord) => {
    const wc = makeFakeWebContents('destroyed');
    const view = fakeView(wc);
    target.view = view;
    (hostFields.tabByWebContents as WeakMap<object, unknown>).set(wc, { tabId: targetId, tab: target });
    return view;
  };
  hostFields.recreateMobileView = () => null;

  const tabs = new Map<string, HarnessedTab>();
  for (const spec of specs) {
    const wc = makeFakeWebContents(spec.closeOutcome || 'destroyed');
    const record = {
      state: makeState({ id: spec.id, url: spec.url }),
      view: fakeView(wc),
      lastActiveAt: spec.lastActiveAt,
    } as NativeTabRecord;
    tabMap.set(spec.id, record);
    (hostFields.tabOrder as string[]).push(spec.id);
    (hostFields.tabByWebContents as WeakMap<object, unknown>).set(wc, { tabId: spec.id, tab: record });
    children.push(record.view);
    tabs.set(spec.id, {
      record,
      wc,
      liveWc: () => record.view!.webContents as unknown as FakeWebContents,
    });
  }
  return { host, children, tabs };
}

describe('hibernation snapshot races', () => {
  for (const change of ['activation', 'audio'] as const) {
    it(`preserves a page gaining ${change} while its scroll snapshot is pending`, async () => {
      const { host, tabs } = createHibernationHost([{ id: 'music', url: 'https://music.youtube.com/' }], 'other');
      const music = tabs.get('music')!;
      const snapshot = Promise.withResolvers<unknown>();
      music.wc.executeJavaScript = () => snapshot.promise;
      const sleep = host.beginTabHibernation('music');
      const hostFields = host as unknown as Record<string, unknown>;
      if (change === 'activation') hostFields.activeTabId = 'music';
      else music.record.state.isAudible = true;
      snapshot.resolve({ x: 0, y: 10 });
      assert.strictEqual(await sleep, false);
      assert.strictEqual(music.wc.destroyed, false);
      assert.strictEqual(music.record.view!.webContents, music.wc);
      assert.notStrictEqual(music.record.state.hibernated, true);
    });
  }
});

describe('host hibernate/wake round-trip', () => {
  it('hibernate destroys the view, the capability funnel wakes it with URL and scroll restored', async () => {
    const { host, children, tabs } = createHibernationHost(
      [{ id: 'tab-sleep', url: 'https://store.example.com/products' }],
      'tab-other',
    );
    const { record, wc } = tabs.get('tab-sleep')!;

    const hibernate = host['hibernateTab' as keyof HostHarness] as (id: string) => Promise<boolean>;
    assert.strictEqual(await hibernate.call(host, 'tab-sleep'), true, 'a clean close must sleep the tab');
    assert.strictEqual(record.state.hibernated, true, 'the record carries the sleeping mark');
    assert.strictEqual(record.view, undefined, 'the destroyed view is detached from the record');
    assert.strictEqual(wc.destroyed, true, 'the close probe actually destroyed the contents');
    assert.strictEqual(record.state.scrollY, 300, 'scroll was snapshotted before the destroy');
    assert.strictEqual(host.isTabHibernated('tab-sleep'), true, 'the strip-facing oracle reports asleep');
    assert.strictEqual(children.length, 0, 'the dead view left the window');

    // A capability call that asks for the tab's webContents wakes it.
    const awake = host.getTabWebContents('tab-sleep');
    assert.ok(awake, 'a woken tab answers with live contents');
    assert.notStrictEqual(awake as unknown as FakeWebContents, wc, 'the wake produced a new renderer, not the dead one');
    assert.strictEqual(record.state.hibernated, false, 'the record woke');
    assert.strictEqual(host.isTabHibernated('tab-sleep'), false);
    const { liveWc } = tabs.get('tab-sleep')!;
    assert.deepStrictEqual(liveWc().loadCalls, ['https://store.example.com/products'], 'wake reloads the saved URL');

    // The saved scroll is re-applied once the woken page finishes loading.
    const { promise: settled, resolve: markSettled } = Promise.withResolvers<void>();
    setImmediate(markSettled);
    await settled;
    assert.ok(
      liveWc().execJs.some((code) => code.includes('scrollTo(0, 300)')),
      'scroll restore runs after did-finish-load',
    );
  });

  it('a beforeunload veto keeps the tab live, marks it, and the sweep skips it next pass', async () => {
    const { host, tabs } = createHibernationHost(
      [
        { id: 'tab-dirty', url: 'https://dirty.example.com', closeOutcome: 'will-prevent-unload' },
        { id: 'tab-clean', url: 'https://clean.example.com' },
      ],
      'tab-active',
    );
    // Both records look freshly idle to the sweep: past the 15-minute window.
    const aged = Date.now() - 20 * 60 * 1000;
    tabs.get('tab-dirty')!.record.lastActiveAt = aged;
    tabs.get('tab-clean')!.record.lastActiveAt = aged;

    const hibernate = host['hibernateTab' as keyof HostHarness] as (id: string) => Promise<boolean>;
    assert.strictEqual(await hibernate.call(host, 'tab-dirty'), false, 'a vetoed close must not sleep the tab');
    const dirty = tabs.get('tab-dirty')!;
    assert.strictEqual(dirty.record.state.hibernated !== true, true, 'a vetoed tab stays awake');
    assert.ok(dirty.record.view, 'a vetoed tab keeps its live view');
    const vetoed = (host as unknown as { unloadVetoedTabIds: Set<string> }).unloadVetoedTabIds;
    assert.ok(vetoed.has('tab-dirty'), 'the veto is recorded for the sweep');

    const sweep = host['runHibernationSweep' as keyof HostHarness] as () => Promise<void>;
    await sweep.call(host);
    assert.strictEqual(tabs.get('tab-clean')!.record.state.hibernated, true, 'the idle clean tab slept on the sweep');
    assert.strictEqual(dirty.record.state.hibernated !== true, true, 'the vetoed tab is never re-probed');
    assert.ok(dirty.record.view, 'the vetoed tab kept its renderer through the sweep');
  });

  it('beginTabHibernation force-sleeps an eligible tab but honors every exclusion', async () => {
    const { host, tabs } = createHibernationHost(
      [
        { id: 'tab-active', url: 'https://a.example.com' },
        { id: 'tab-auto', url: 'https://b.example.com' },
        { id: 'tab-sleep', url: 'https://c.example.com' },
      ],
      'tab-active',
    );
    const hostFields = host as unknown as { automationTabId: string | null };
    hostFields.automationTabId = 'tab-auto';

    assert.strictEqual(await host.beginTabHibernation('tab-active'), false, 'the presented tab is never slept');
    assert.strictEqual(await host.beginTabHibernation('tab-auto'), false, 'the automation target is never slept');
    assert.strictEqual(await host.beginTabHibernation('tab-sleep'), true, 'an eligible background tab sleeps on demand');
    assert.strictEqual(tabs.get('tab-sleep')!.record.state.hibernated, true);

    // Wake through the user path: presenting the tab must rebuild its view.
    assert.strictEqual(host.ensureTabAwake('tab-sleep'), true);
    assert.strictEqual(tabs.get('tab-sleep')!.record.state.hibernated, false);
    assert.deepStrictEqual(tabs.get('tab-sleep')!.liveWc().loadCalls, ['https://c.example.com']);
  });
});
