"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const tab_hibernation_1 = require("../../../src/main/browser/tab-hibernation");
const native_tab_host_1 = require("../../../src/main/browser/native-tab-host");
const project_window_shell_double_1 = require("../../support/project-window-shell-double");
// The host journals presentation changes into the runtime the live app writes to; a
// unit run must not append to the user's journal, so it is redirected before the
// first event can be recorded (the journal resolves its path on first write).
process.env.ANTIFAN_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-hibernation-runtime-'));
const T0 = 1_700_000_000_000;
function makeState(overrides = {}) {
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
function makeCtx(overrides = {}) {
    return { activeTabId: 'tab-active', now: T0, ...overrides };
}
function tab(id, state = {}, lastActiveAt) {
    return { id, state: makeState({ id, ...state }), lastActiveAt };
}
(0, node_test_1.describe)('shouldHibernate policy', () => {
    (0, node_test_1.it)('hibernates a background tab idle past 5 minutes', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, T0 - 5 * 60 * 1000 - 1), makeCtx());
        assert.deepStrictEqual(d, { hibernate: true });
    });
    (0, node_test_1.it)('refuses the active tab of the window', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-active', {}, T0 - 10 * tab_hibernation_1.HIBERNATE_IDLE_MS), makeCtx());
        assert.deepStrictEqual(d, { hibernate: false, reason: 'active-tab' });
    });
    (0, node_test_1.it)('refuses an audible tab', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', { isAudible: true }, 0), makeCtx());
        assert.deepStrictEqual(d, { hibernate: false, reason: 'audible' });
    });
    (0, node_test_1.it)('refuses a tab still loading', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', { isLoading: true }, 0), makeCtx());
        assert.deepStrictEqual(d, { hibernate: false, reason: 'loading' });
    });
    (0, node_test_1.it)('refuses offscreen and ephemeral agent-plane tabs', () => {
        for (const flag of ['offscreen', 'ephemeral']) {
            const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', { [flag]: true }, 0), makeCtx());
            assert.deepStrictEqual(d, { hibernate: false, reason: 'agent-plane' }, flag);
        }
    });
    (0, node_test_1.it)('refuses the automation target tab', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, 0), makeCtx({ automationTabId: 'tab-x' }));
        assert.deepStrictEqual(d, { hibernate: false, reason: 'automation-target' });
    });
    (0, node_test_1.it)('refuses an MCP/attachment-bound tab', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, 0), makeCtx({ boundTabIds: new Set(['tab-x']) }));
        assert.deepStrictEqual(d, { hibernate: false, reason: 'mcp-bound' });
    });
    (0, node_test_1.it)('refuses a tab with an open CDP session', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, 0), makeCtx({ cdpBoundTabIds: new Set(['tab-x']) }));
        assert.deepStrictEqual(d, { hibernate: false, reason: 'cdp-bound' });
    });
    (0, node_test_1.it)('refuses a tab whose beforeunload vetoed a prior probe', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, 0), makeCtx({ unloadVetoedTabIds: new Set(['tab-x']) }));
        assert.deepStrictEqual(d, { hibernate: false, reason: 'unload-veto' });
    });
    (0, node_test_1.it)('refuses an already-hibernated tab (no double-sleep)', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', { hibernated: true }, 0), makeCtx());
        assert.deepStrictEqual(d, { hibernate: false, reason: 'already-hibernated' });
    });
    (0, node_test_1.it)('refuses a tab still inside the idle window', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, T0 - 5 * 60 * 1000 + 1), makeCtx());
        assert.deepStrictEqual(d, { hibernate: false, reason: 'not-idle' });
    });
    (0, node_test_1.it)('hibernates exactly at the 5-minute boundary', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, T0 - 5 * 60 * 1000), makeCtx());
        assert.deepStrictEqual(d, { hibernate: true });
    });
    (0, node_test_1.it)('treats a never-active tab (lastActiveAt absent) as idlest — hibernates', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x'), makeCtx());
        assert.deepStrictEqual(d, { hibernate: true });
    });
    (0, node_test_1.it)('honours a shorter idleMs seam without changing default policy behavior', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, T0 - 5_000), makeCtx({ idleMs: 1_000 }));
        assert.deepStrictEqual(d, { hibernate: true });
        // Same tab under the default must be refused.
        const d2 = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, T0 - 5_000), makeCtx());
        assert.deepStrictEqual(d2, { hibernate: false, reason: 'not-idle' });
    });
    (0, node_test_1.it)('uses Date.now() when ctx.now is absent', () => {
        const before = Date.now();
        // A tab last active "now" is inside the window regardless of clock.
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-x', {}, Date.now()), makeCtx({ now: undefined }));
        assert.deepStrictEqual(d, { hibernate: false, reason: 'not-idle' });
        assert.ok(Date.now() >= before);
    });
    (0, node_test_1.it)('exclusion order: active-tab wins over not-idle (a just-activated tab)', () => {
        const d = (0, tab_hibernation_1.shouldHibernate)(tab('tab-active', {}, T0), makeCtx({ automationTabId: 'tab-active' }));
        assert.deepStrictEqual(d, { hibernate: false, reason: 'active-tab' });
    });
});
(0, node_test_1.describe)('sweep constants', () => {
    (0, node_test_1.it)('sweep interval is 60 seconds', () => {
        assert.strictEqual(tab_hibernation_1.HIBERNATE_SWEEP_INTERVAL_MS, 60 * 1000);
    });
});
let fakeWcSeq = 7000;
function makeFakeWebContents(closeOutcome) {
    const wc = {
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
            for (const cb of wc.onceHandlers.get(event) || [])
                cb();
        },
        close() {
            // The sweep arms `will-prevent-unload` and `destroyed` BEFORE calling
            // close(), so emitting synchronously answers it exactly the way the real
            // platform does.
            if (wc.closeOutcome === 'destroyed') {
                wc.destroyed = true;
                wc.emit('destroyed');
            }
            else {
                wc.emit('will-prevent-unload');
            }
        },
        executeJavaScript(code) {
            wc.execJs.push(code);
            if (code.includes('scrollX'))
                return Promise.resolve({ x: 0, y: 300 });
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
function fakeView(wc) {
    return { webContents: wc, setBackgroundColor: () => { } };
}
function createHibernationHost(specs, activeTabId) {
    const host = Object.create(native_tab_host_1.NativeTabHost.prototype);
    const tabMap = new Map();
    const hostFields = host;
    hostFields.isDisposed = false;
    hostFields.tabs = tabMap;
    hostFields.tabOrder = [];
    hostFields.activeTabId = activeTabId;
    hostFields.automationTabId = null;
    hostFields.hibernatingTabIds = new Set();
    hostFields.unloadVetoedTabIds = new Set();
    hostFields.tabReadyWaits = new Map();
    hostFields.pendingPageCloses = new Map();
    hostFields.attemptAuthorizedCloses = new Set();
    hostFields.tabByWebContents = new WeakMap();
    hostFields.temporaryViewAttachCounts = new WeakMap();
    // The probe narrows the seam's idle threshold; the harness mirrors it so the
    // seam's own context is exercised, not the shipped 15-minute fallback.
    hostFields.hibernationIdleMs = 1;
    host.broadcastCount = 0;
    const children = [];
    const windowDouble = {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
        getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
        contentView: {
            children,
            addChildView: (view, index) => {
                const at = typeof index === 'number' ? Math.max(0, Math.min(index, children.length)) : children.length;
                children.splice(at, 0, view);
            },
            removeChildView: (view) => {
                const at = children.indexOf(view);
                if (at >= 0)
                    children.splice(at, 1);
            },
        },
        on: () => { },
        removeListener: () => { },
    };
    hostFields.shell = (0, project_window_shell_double_1.createShellDouble)({ window: windowDouble, isSidebarOpen: false });
    hostFields.resolveTargetTabId = (id) => id || '';
    hostFields.broadcastState = () => {
        host.broadcastCount += 1;
    };
    hostFields.schedulePersist = () => { };
    hostFields.persistTabs = () => { };
    hostFields.destroyOwnedWebContents = () => { };
    hostFields.setSafeUserAgent = () => { };
    hostFields.setupTabWebContentsEvents = () => { };
    hostFields.indexTabWebContents = () => { };
    hostFields.networkTracker = undefined;
    hostFields.controlPlane = undefined;
    hostFields.devToolsHost = undefined;
    // Production builds a WebContentsView here; under node --test the constructor
    // does not exist, so the double fabricates the same surface and registers it
    // exactly the way recreateDesktopView does.
    hostFields.recreateDesktopView = (targetId, target) => {
        const wc = makeFakeWebContents('destroyed');
        const view = fakeView(wc);
        target.view = view;
        hostFields.tabByWebContents.set(wc, { tabId: targetId, tab: target });
        return view;
    };
    hostFields.recreateMobileView = () => null;
    const tabs = new Map();
    for (const spec of specs) {
        const wc = makeFakeWebContents(spec.closeOutcome || 'destroyed');
        const record = {
            state: makeState({ id: spec.id, url: spec.url }),
            view: fakeView(wc),
            lastActiveAt: spec.lastActiveAt,
        };
        tabMap.set(spec.id, record);
        hostFields.tabOrder.push(spec.id);
        hostFields.tabByWebContents.set(wc, { tabId: spec.id, tab: record });
        children.push(record.view);
        tabs.set(spec.id, {
            record,
            wc,
            liveWc: () => record.view.webContents,
        });
    }
    return { host, children, tabs };
}
(0, node_test_1.describe)('hibernation snapshot races', () => {
    for (const change of ['activation', 'audio']) {
        (0, node_test_1.it)(`preserves a page gaining ${change} while its scroll snapshot is pending`, async () => {
            const { host, tabs } = createHibernationHost([{ id: 'music', url: 'https://music.youtube.com/' }], 'other');
            const music = tabs.get('music');
            const snapshot = Promise.withResolvers();
            music.wc.executeJavaScript = () => snapshot.promise;
            const sleep = host.beginTabHibernation('music');
            const hostFields = host;
            if (change === 'activation')
                hostFields.activeTabId = 'music';
            else
                music.record.state.isAudible = true;
            snapshot.resolve({ x: 0, y: 10 });
            assert.strictEqual(await sleep, false);
            assert.strictEqual(music.wc.destroyed, false);
            assert.strictEqual(music.record.view.webContents, music.wc);
            assert.notStrictEqual(music.record.state.hibernated, true);
        });
    }
});
(0, node_test_1.describe)('host hibernate/wake round-trip', () => {
    (0, node_test_1.it)('hibernate destroys the view, the capability funnel wakes it with URL and scroll restored', async () => {
        const { host, children, tabs } = createHibernationHost([{ id: 'tab-sleep', url: 'https://store.example.com/products' }], 'tab-other');
        const { record, wc } = tabs.get('tab-sleep');
        const hibernate = host['hibernateTab'];
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
        assert.notStrictEqual(awake, wc, 'the wake produced a new renderer, not the dead one');
        assert.strictEqual(record.state.hibernated, false, 'the record woke');
        assert.strictEqual(host.isTabHibernated('tab-sleep'), false);
        const { liveWc } = tabs.get('tab-sleep');
        assert.deepStrictEqual(liveWc().loadCalls, ['https://store.example.com/products'], 'wake reloads the saved URL');
        // The saved scroll is re-applied once the woken page finishes loading.
        const { promise: settled, resolve: markSettled } = Promise.withResolvers();
        setImmediate(markSettled);
        await settled;
        assert.ok(liveWc().execJs.some((code) => code.includes('scrollTo(0, 300)')), 'scroll restore runs after did-finish-load');
    });
    (0, node_test_1.it)('a beforeunload veto keeps the tab live, marks it, and the sweep skips it next pass', async () => {
        const { host, tabs } = createHibernationHost([
            { id: 'tab-dirty', url: 'https://dirty.example.com', closeOutcome: 'will-prevent-unload' },
            { id: 'tab-clean', url: 'https://clean.example.com' },
        ], 'tab-active');
        // Both records look freshly idle to the sweep: past the 15-minute window.
        const aged = Date.now() - 20 * 60 * 1000;
        tabs.get('tab-dirty').record.lastActiveAt = aged;
        tabs.get('tab-clean').record.lastActiveAt = aged;
        const hibernate = host['hibernateTab'];
        assert.strictEqual(await hibernate.call(host, 'tab-dirty'), false, 'a vetoed close must not sleep the tab');
        const dirty = tabs.get('tab-dirty');
        assert.strictEqual(dirty.record.state.hibernated !== true, true, 'a vetoed tab stays awake');
        assert.ok(dirty.record.view, 'a vetoed tab keeps its live view');
        const vetoed = host.unloadVetoedTabIds;
        assert.ok(vetoed.has('tab-dirty'), 'the veto is recorded for the sweep');
        const sweep = host['runHibernationSweep'];
        await sweep.call(host);
        assert.strictEqual(tabs.get('tab-clean').record.state.hibernated, true, 'the idle clean tab slept on the sweep');
        assert.strictEqual(dirty.record.state.hibernated !== true, true, 'the vetoed tab is never re-probed');
        assert.ok(dirty.record.view, 'the vetoed tab kept its renderer through the sweep');
    });
    (0, node_test_1.it)('beginTabHibernation force-sleeps an eligible tab but honors every exclusion', async () => {
        const { host, tabs } = createHibernationHost([
            { id: 'tab-active', url: 'https://a.example.com' },
            { id: 'tab-auto', url: 'https://b.example.com' },
            { id: 'tab-sleep', url: 'https://c.example.com' },
        ], 'tab-active');
        const hostFields = host;
        hostFields.automationTabId = 'tab-auto';
        assert.strictEqual(await host.beginTabHibernation('tab-active'), false, 'the presented tab is never slept');
        assert.strictEqual(await host.beginTabHibernation('tab-auto'), false, 'the automation target is never slept');
        assert.strictEqual(await host.beginTabHibernation('tab-sleep'), true, 'an eligible background tab sleeps on demand');
        assert.strictEqual(tabs.get('tab-sleep').record.state.hibernated, true);
        // Wake through the user path: presenting the tab must rebuild its view.
        assert.strictEqual(host.ensureTabAwake('tab-sleep'), true);
        assert.strictEqual(tabs.get('tab-sleep').record.state.hibernated, false);
        assert.deepStrictEqual(tabs.get('tab-sleep').liveWc().loadCalls, ['https://c.example.com']);
    });
});
