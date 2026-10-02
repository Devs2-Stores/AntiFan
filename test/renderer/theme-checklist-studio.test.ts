/**
 * Theme Studio checklist surfaces (page-by-page A-Z checklist) — real DOM proof.
 *
 * Loads the compiled toolbar.html + toolbar.js into jsdom with a stubbed
 * antifanToolbar bridge and asserts the checklist contract the cockpit exposes:
 * one card per storefront page group, every item carrying a QA point, the
 * per-page open/scan/toggle actions, the "Chưa làm" and per-page filters, and
 * the Markdown report export. Persistence is exercised on BOTH lanes: the
 * in-memory CAS double behind getThemeChecklist/saveThemeChecklist/
 * onThemeChecklistUpdated (the IPC lane) and, for the tests that pin legacy
 * localStorage keys, `omitChecklistBridge` keeps the degraded lane selectable.
 * hand-off into the Live QA findings tab.
 *
 * The two tabs must stay siblings inside .theme-studio-body: a missing closing
 * tag nests #themeTabFindings inside #themeTabChecklist and silently breaks every
 * tab switch, which no amount of CSS can repair.
 *
 * jsdom is a transitive dep; when the shared node_modules copy is broken the
 * test honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom) and skips
 * with the resolution error as the named blocker.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { checklistScope, workspaceTag, DEFAULT_THEME_CHECKLIST, UNKNOWN_WORKSPACE_TAG, type ThemeChecklistItem } from '../../src/shared/theme-checklist';

interface JsdomLike { window: Window & { eval: (src: string) => unknown } }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM: JsdomCtor } {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    return { JSDOM: (req(resolved) as { JSDOM: JsdomCtor }).JSDOM };
  } catch (err) {
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RENDERER_DIR = (() => {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.compiled', 'src', 'renderer');
    if (fs.existsSync(path.join(candidate, 'toolbar.html'))) return candidate;
    const direct = path.join(dir, 'src', 'renderer');
    if (fs.existsSync(path.join(direct, 'toolbar.html'))) return direct;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', '.compiled', 'src', 'renderer');
})();

const PAGE_KEYS = ['home', 'collection', 'product', 'cart', 'blog', 'account', 'pages', 'qa-gate'] as const;
const CHECKLIST_ITEMS = 44;
const CHECKLIST_STORAGE_PREFIX = 'antifan_theme_checklist_state_v3';
const DEFAULT_ORIGIN = 'http://shop-a.local';
const DEFAULT_WORKSPACE = 'E:\\Work\\themes\\shop-a';

const QA_REPORT = {
  findings: {
    platform: { platform: 'haravan' },
    liquid: { errors: [] },
    overflow: { culprits: [{ selector: '#hero-banner' }] },
    assets: { brokenAssets: [] },
    hsRules: { totalViolations: 0, violations: [] },
    diagnosticIssues: [],
    diagnosticWarnings: [],
  },
  summary: { passed: false, totalIssues: 1 },
};

interface ClipboardSpy { writes: string[] }

/** Tab shape the toolbar renderer reads back from the main process. */
interface StubTab {
  id: string;
  url: string;
  title: string;
  favicon: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

function tab(id: string, url: string): StubTab {
  return { id, url, title: url, favicon: '', isLoading: false, canGoBack: false, canGoForward: false };
}
// ---------------------------------------------------------------------------
// In-memory double of the main-owned checklist store
// (`{workspaceRoot}/.antifan/qa-checklist.json` behind THEME_CHECKLIST_LOAD/SAVE).
// Same observable contract as the real one: whole-array CAS keyed on the
// record's `updatedAt`, a conflict returns the store's rows for adoption, and
// every successful write echoes through THEME_CHECKLIST_UPDATED — which the
// toolbar's own subscription then adopts (the real host does the same).
// ---------------------------------------------------------------------------

interface ChecklistStoreRecord {
  items: ThemeChecklistItem[];
  updatedAt: number;
  /** Mirrors the store's `legacyMigrated`: set once toolbar-side state has landed. */
  migrated: boolean;
}

interface ChecklistLoadResultLike {
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
  existed: boolean;
  migrated: boolean;
  isProvisional: boolean;
}

interface ChecklistSaveResultLike {
  ok: boolean;
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
  conflict: boolean;
  isProvisional: boolean;
}

interface ChecklistSaveCall {
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  baseUpdatedAt: number | undefined;
}

/** A LOAD invoke parked for deferred resolution (the "in-flight LOAD" seam). */
interface PendingChecklistLoad {
  scope: string;
  workspaceRoot: string;
  /** Settle the invoke; `override` replaces the record-derived snapshot. */
  resolve: (override?: Partial<ChecklistLoadResultLike>) => ChecklistLoadResultLike;
}

/** A SAVE invoke parked for deferred resolution (the "one save RTT" seam). */
interface PendingChecklistSave {
  call: ChecklistSaveCall;
  /** Settle the invoke; `override` replaces the CAS-computed result. */
  resolve: (override?: Partial<ChecklistSaveResultLike>) => ChecklistSaveResultLike;
  reject: (err: unknown) => void;
}

interface ChecklistBridgeDouble {
  /** Live records keyed by scope; the disk-equivalent state tests assert against. */
  records: Map<string, ChecklistStoreRecord>;
  saveCalls: ChecklistSaveCall[];
  loadCalls: Array<{ scope: string; workspaceRoot: string }>;
  /** When true, LOAD/SAVE invokes park instead of resolving; `pending*` holds them. */
  holdLoads: boolean;
  holdSaves: boolean;
  /** Number of next SAVE invokes that reject (transient main-process fault). */
  failNextSaves: number;
  pendingLoads: PendingChecklistLoad[];
  pendingSaves: PendingChecklistSave[];
  /** Write a record as the store would report it (no broadcast). */
  seed(scope: string, items: ThemeChecklistItem[], updatedAt?: number, migrated?: boolean): ChecklistStoreRecord;
  /** Interleaved-writer seam: write `items` unconditionally and broadcast the new head. */
  agentWrite(scope: string, workspaceRoot: string, items: ThemeChecklistItem[]): ChecklistStoreRecord;
  /** Fire THEME_CHECKLIST_UPDATED into the toolbar's subscription. */
  push(payload: { scope: string; workspaceRoot: string; items: ThemeChecklistItem[]; updatedAt: number }): void;
  getThemeChecklist(scope: string, workspaceRoot: string): Promise<ChecklistLoadResultLike>;
  saveThemeChecklist(scope: string, workspaceRoot: string, items: ThemeChecklistItem[], baseUpdatedAt?: number): Promise<ChecklistSaveResultLike>;
  onThemeChecklistUpdated(cb: (payload: { scope: string; workspaceRoot: string; items: ThemeChecklistItem[]; updatedAt: number }) => void): () => void;
}

interface ChecklistBridgeOptions {
  holdLoads?: boolean;
  holdSaves?: boolean;
  /** Records present before the toolbar boots; used to seed migration targets. */
  seed?: Record<string, { items: ThemeChecklistItem[]; updatedAt: number; migrated?: boolean }>;
}

function cloneChecklistItems(items: ThemeChecklistItem[]): ThemeChecklistItem[] {
  return items.map((item) => ({ ...item }));
}

function makeChecklistBridge(options: ChecklistBridgeOptions = {}): ChecklistBridgeDouble {
  const records = new Map<string, ChecklistStoreRecord>();
  const listeners: Array<(payload: { scope: string; workspaceRoot: string; items: ThemeChecklistItem[]; updatedAt: number }) => void> = [];
  // Monotonic clock: every store write stamps strictly newer than the head it replaced.
  let clock = 1;
  const stamp = (floor = 0): number => {
    clock = Math.max(clock + 1, floor + 1);
    return clock;
  };
  const provisional = (scope: string, workspaceRoot: string): boolean =>
    !workspaceRoot || !workspaceRoot.trim() || scope.slice(scope.lastIndexOf('@') + 1) === UNKNOWN_WORKSPACE_TAG;
  const broadcast = (payload: { scope: string; workspaceRoot: string; items: ThemeChecklistItem[]; updatedAt: number }): void => {
    for (const listener of listeners) listener(payload);
  };

  const buildLoad = (scope: string, workspaceRoot: string): ChecklistLoadResultLike => {
    const rec = records.get(scope);
    return {
      scope,
      workspaceRoot,
      items: cloneChecklistItems(rec ? rec.items : DEFAULT_THEME_CHECKLIST),
      updatedAt: rec?.updatedAt ?? 0,
      existed: Boolean(rec),
      migrated: rec?.migrated ?? false,
      isProvisional: provisional(scope, workspaceRoot),
    };
  };

  const settleSave = (call: ChecklistSaveCall): ChecklistSaveResultLike => {
    const rec = records.get(call.scope);
    // Fail-closed CAS: on an existing record, an absent/stale base conflicts and
    // returns the store rows so the caller re-bases (the store's contract).
    if (rec && rec.updatedAt !== call.baseUpdatedAt) {
      return {
        ok: true,
        scope: call.scope,
        workspaceRoot: call.workspaceRoot,
        items: cloneChecklistItems(rec.items),
        updatedAt: rec.updatedAt,
        conflict: true,
        isProvisional: provisional(call.scope, call.workspaceRoot),
      };
    }
    const committed: ChecklistStoreRecord = {
      items: cloneChecklistItems(call.items),
      updatedAt: stamp(rec?.updatedAt ?? 0),
      // A whole-array toolbar save IS the legacy localStorage state landing.
      migrated: true,
    };
    records.set(call.scope, committed);
    broadcast({ scope: call.scope, workspaceRoot: call.workspaceRoot, items: cloneChecklistItems(committed.items), updatedAt: committed.updatedAt });
    return {
      ok: true,
      scope: call.scope,
      workspaceRoot: call.workspaceRoot,
      items: cloneChecklistItems(committed.items),
      updatedAt: committed.updatedAt,
      conflict: false,
      isProvisional: provisional(call.scope, call.workspaceRoot),
    };
  };

  const bridge: ChecklistBridgeDouble = {
    records,
    saveCalls: [],
    loadCalls: [],
    holdLoads: options.holdLoads === true,
    holdSaves: options.holdSaves === true,
    failNextSaves: 0,
    pendingLoads: [],
    pendingSaves: [],
    seed(scope, items, updatedAt = 0, migrated = false) {
      const rec: ChecklistStoreRecord = { items: cloneChecklistItems(items), updatedAt, migrated };
      records.set(scope, rec);
      clock = Math.max(clock, updatedAt);
      return rec;
    },
    agentWrite(scope, workspaceRoot, items) {
      const prev = records.get(scope);
      const rec: ChecklistStoreRecord = { items: cloneChecklistItems(items), updatedAt: stamp(prev?.updatedAt ?? 0), migrated: prev?.migrated ?? false };
      records.set(scope, rec);
      broadcast({ scope, workspaceRoot, items: cloneChecklistItems(rec.items), updatedAt: rec.updatedAt });
      return rec;
    },
    push(payload) {
      broadcast(payload);
    },
    getThemeChecklist(scope, workspaceRoot) {
      bridge.loadCalls.push({ scope, workspaceRoot });
      if (bridge.holdLoads) {
        return new Promise<ChecklistLoadResultLike>((resolveLoad) => {
          bridge.pendingLoads.push({
            scope,
            workspaceRoot,
            resolve: (override) => {
              const result = { ...buildLoad(scope, workspaceRoot), ...override };
              resolveLoad(result);
              return result;
            },
          });
        });
      }
      return Promise.resolve(buildLoad(scope, workspaceRoot));
    },
    saveThemeChecklist(scope, workspaceRoot, items, baseUpdatedAt) {
      const call: ChecklistSaveCall = { scope, workspaceRoot, items: cloneChecklistItems(items), baseUpdatedAt };
      bridge.saveCalls.push(call);
      if (bridge.failNextSaves > 0) {
        bridge.failNextSaves -= 1;
        return Promise.reject(new Error('checklist save failed (injected transient fault)'));
      }
      if (bridge.holdSaves) {
        return new Promise<ChecklistSaveResultLike>((resolveSave, rejectSave) => {
          bridge.pendingSaves.push({
            call,
            resolve: (override) => {
              const result = { ...settleSave(call), ...override };
              resolveSave(result);
              return result;
            },
            reject: rejectSave,
          });
        });
      }
      return Promise.resolve(settleSave(call));
    },
    onThemeChecklistUpdated(cb) {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  if (options.seed) {
    for (const [scope, entry] of Object.entries(options.seed)) {
      bridge.seed(scope, entry.items, entry.updatedAt, entry.migrated ?? false);
    }
  }
  return bridge;
}

function makeApi(clipboard: ClipboardSpy, calls: string[], tabs: StubTab[], activeTabId: string, workspacePath = DEFAULT_WORKSPACE, hangWorkspace = false, checklist: ChecklistBridgeOptions | false = {}) {
  const stateListeners: Array<(state: unknown) => void> = [];
  let liveTabs = tabs;
  let liveActiveTabId = activeTabId;
  let liveWorkspacePath = workspacePath;
  const broadcast = () => {
    const state = { tabs: liveTabs, activeTabId: liveActiveTabId, bookmarks: [] };
    for (const listener of stateListeners) listener(state);
  };
  // `false` selects the degraded lane: the bridge members stay undefined and the
  // toolbar falls back to the two-key localStorage protocol exactly as when the
  // preload exposes no checklist APIs.
  const checklistBridge = checklist === false ? null : makeChecklistBridge(checklist);
  return {
    getInitialState: () => Promise.resolve({ tabs: liveTabs, activeTabId: liveActiveTabId, bookmarks: [] }),
    getWorkflowState: () => Promise.resolve({ workflows: [], tools: [] }),
    getCoreHealthState: () => Promise.resolve({ snapshot: null, bridge: null, taskRuns: null, rootCauses: null, regressions: null }),
    runThemeQa: () => {
      calls.push('runThemeQa');
      return Promise.resolve({ ok: true, report: QA_REPORT });
    },
    navigate: (url: string) => {
      calls.push(`navigate:${url}`);
      return Promise.resolve({ ok: true });
    },
    identifyWorkspace: () => (hangWorkspace ? new Promise<never>(() => undefined) : Promise.resolve({ workspacePath: liveWorkspacePath })),
    setOverlay: () => Promise.resolve(undefined),
    setDevicePreset: () => Promise.resolve(undefined),
    onStateUpdated: (callback: (state: unknown) => void) => {
      stateListeners.push(callback);
      return () => undefined;
    },
    onThemeQaState: () => () => undefined,
    onFocusFind: () => () => undefined,
    onFocusOmnibox: () => () => undefined,
    onShowShortcuts: () => () => undefined,
    onFindResult: () => () => undefined,
    onPhoneStatusChanged: () => () => undefined,
    onWorkflowEvent: () => () => undefined,
    getPhoneStatus: () => Promise.resolve({ state: 'unknown' }),
    ...(checklistBridge
      ? {
          getThemeChecklist: checklistBridge.getThemeChecklist,
          saveThemeChecklist: checklistBridge.saveThemeChecklist,
          onThemeChecklistUpdated: checklistBridge.onThemeChecklistUpdated,
        }
      : {}),
    __clipboard: clipboard,
    __checklist: checklistBridge,
    /** Move the renderer onto another storefront, exactly as a real tab switch would. */
    __pushState: (nextTabs: StubTab[], nextActiveTabId: string) => {
      liveTabs = nextTabs;
      liveActiveTabId = nextActiveTabId;
      broadcast();
    },
    /** Point the storefront at another theme workspace, as switching projects does. */
    __setWorkspace: (nextWorkspacePath: string) => {
      liveWorkspacePath = nextWorkspacePath;
    },
  };
}

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

/** Every storefront scope the checklist has persisted state under. */
function storedScopeKeys(win: Window): string[] {
  const keys: string[] = [];
  for (let i = 0; i < win.localStorage.length; i++) keys.push(win.localStorage.key(i) ?? '');
  return keys.filter((key) => key.startsWith(`${CHECKLIST_STORAGE_PREFIX}:`)).sort();
}

interface ToolbarStubApi {
  __clipboard: ClipboardSpy;
  /** Move the renderer onto another storefront, exactly as a real tab switch would. */
  __pushState: (tabs: StubTab[], activeTabId: string) => void;
  /** Point the storefront at another theme workspace, as switching projects does. */
  __setWorkspace: (workspacePath: string) => void;
  /** The checklist-store double behind the IPC lane — `null` in degraded mode. */
  __checklist: ChecklistBridgeDouble | null;
}

interface ToolbarHandle {
  dom: JsdomLike;
  win: Window & { eval: (src: string) => unknown };
  doc: Document;
  clipboard: ClipboardSpy;
  calls: string[];
  api: ToolbarStubApi;
  runTimers: () => void;
}

interface LoadToolbarOptions {
  /** Storefront the single tab starts on. */
  openUrl?: string;
  /** Workspace the main process reports for that storefront. */
  workspacePath?: string;
  /** Simulate a main process that never answers the workspace query. */
  hangWorkspace?: boolean;
  /**
   * Keep the checklist IPC bridge members off the stub: the toolbar then
   * degrades to the two-key localStorage lane, which is what the legacy
   * persistence pins still exercise.
   */
  omitChecklistBridge?: boolean;
  /** Bridge-double options (deferred LOAD/SAVE seams, seeded store records). */
  checklistBridge?: ChecklistBridgeOptions;
  /** Populate legacy localStorage state before the toolbar script evaluates. */
  seedLocalStorage?: (win: Window) => void;
}

async function loadToolbar(options: LoadToolbarOptions = {}): Promise<ToolbarHandle> {
  const { openUrl = `${DEFAULT_ORIGIN}/`, workspacePath = DEFAULT_WORKSPACE, hangWorkspace = false } = options;
  const { JSDOM } = loadJsdom();
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://antifan.local/' });
  const win = dom.window;
  const clipboard: ClipboardSpy = { writes: [] };
  const calls: string[] = [];
  Object.defineProperty(win.navigator, 'clipboard', {
    value: {
      writeText: (text: string) => {
        clipboard.writes.push(text);
        return Promise.resolve();
      },
    },
    configurable: true,
  });
  // Deterministic time: the cockpit arms real timers (navigation settle, toast
  // dismissal). Capture them so the test advances the clock on demand instead of
  // sleeping and hoping.
  const pendingTimers: Array<() => void> = [];
  win.setTimeout = ((handler: () => void) => {
    pendingTimers.push(handler);
    return pendingTimers.length;
  }) as unknown as typeof win.setTimeout;
  const runTimers = () => {
    while (pendingTimers.length > 0) pendingTimers.shift()!();
  };
  // jsdom without `pretendToBeVisual` has no frame scheduler; tab painting asks for
  // one. Frames land on the microtask queue so `flush()` settles them deterministically.
  let frameSeq = 0;
  win.requestAnimationFrame = ((handler: (time: number) => void) => {
    frameSeq += 1;
    queueMicrotask(() => handler(0));
    return frameSeq;
  }) as unknown as typeof win.requestAnimationFrame;
  const api = makeApi(
    clipboard,
    calls,
    [tab('tab-1', openUrl)],
    'tab-1',
    workspacePath,
    hangWorkspace,
    options.omitChecklistBridge ? false : (options.checklistBridge ?? {}),
  );
  options.seedLocalStorage?.(win);
  (win as { antifanToolbar?: unknown }).antifanToolbar = api;
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'exports-shim.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.js'), 'utf8'));
  await flush();
  // The checklist is painted through the Theme Studio tab, which also opens the overlay.
  const checklistTab = win.document.getElementById('tabNavThemeChecklist') as HTMLElement | null;
  checklistTab?.click();
  await flush();
  return { dom, win, doc: win.document, clipboard, calls, api, runTimers };
}
describe('Theme Studio page-by-page checklist', () => {
  test('both studio tabs are siblings inside the body, so tab switching can work', async (t) => {
    const { doc, dom } = await loadToolbar();
    try {
      const checklistTab = doc.getElementById('themeTabChecklist');
      const findingsTab = doc.getElementById('themeTabFindings');
      const body = doc.querySelector('.theme-studio-body');
      assert.ok(checklistTab && findingsTab && body, 'tabs and body exist');
      assert.equal(findingsTab.parentElement, body, 'findings tab is a direct child of the studio body');
      assert.equal(checklistTab.parentElement, body, 'checklist tab is a direct child of the studio body');
      assert.ok(!checklistTab.contains(findingsTab), 'findings tab is not nested inside the checklist tab');
    } finally {
      dom.window.close();
    }
  });

  test('renders one card per page group with every item carrying a QA point', async (t) => {
    const { doc, dom } = await loadToolbar();
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      const cards = list.querySelectorAll('.theme-phase-card');
      assert.equal(cards.length, PAGE_KEYS.length, 'one card per page group');
      const rows = list.querySelectorAll('.theme-item-row');
      assert.equal(rows.length, CHECKLIST_ITEMS, 'every checklist item is rendered');
      const codes = Array.from(list.querySelectorAll('.theme-item-code'), (e) => e.textContent);
      assert.equal(new Set(codes).size, codes.length, 'item codes are unique');
      const qaPoints = Array.from(list.querySelectorAll('.theme-item-qa-point'));
      assert.equal(qaPoints.length, CHECKLIST_ITEMS, 'every item states its QA point');
      assert.ok(qaPoints.every((e) => (e.textContent ?? '').includes('QA:')), 'QA point text is labelled');
      assert.equal(list.querySelectorAll('.theme-btn-open-page').length, PAGE_KEYS.length, 'each page card can open its storefront route');
      assert.equal(list.querySelectorAll('.theme-btn-scan-page').length, PAGE_KEYS.length, 'each page card can trigger a QA scan');
      assert.equal(list.querySelectorAll('.theme-btn-toggle-all').length, PAGE_KEYS.length, 'each page card can toggle its whole page');
      const gateNote = list.querySelectorAll('.theme-phase-card')[PAGE_KEYS.length - 1]?.querySelector('.theme-phase-note');
      assert.match(gateNote?.textContent ?? '', /viewport mobile 375px/, 'the QA gate card states what a route scan cannot certify');
      assert.equal(doc.getElementById('badgeThemeChecklist')?.textContent, `0/${CHECKLIST_ITEMS}`, 'nav badge counts every item');
    } finally {
      dom.window.close();
    }
  });

  test('page filter narrows the list to that page group only', async (t) => {
    const { doc, dom } = await loadToolbar();
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      for (const key of PAGE_KEYS) {
        (doc.querySelector(`.phase-filter-btn[data-page="${key}"]`) as HTMLElement).click();
        await flush(4);
        const cards = list.querySelectorAll('.theme-phase-card');
        assert.equal(cards.length, 1, `filter ${key} shows exactly its own card`);
        const groupRows = list.querySelectorAll('.theme-item-row');
        assert.ok(groupRows.length > 0, `filter ${key} keeps its items visible`);
        assert.ok(groupRows.length < CHECKLIST_ITEMS, `filter ${key} hides every other page`);
      }
      (doc.querySelector('.phase-filter-btn[data-page="all"]') as HTMLElement).click();
      await flush(4);
      assert.equal(list.querySelectorAll('.theme-item-row').length, CHECKLIST_ITEMS, 'the all filter restores every item');
    } finally {
      dom.window.close();
    }
  });

  test('toggle-all completes a page, persists it, and the uncompleted filter hides it', async (t) => {
    // Legacy lane: this test pins the two-key localStorage protocol itself.
    const { doc, win, dom } = await loadToolbar({ omitChecklistBridge: true });
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      const firstCard = list.querySelector('.theme-phase-card') as HTMLElement;
      const pageSize = firstCard.querySelectorAll('.theme-item-row').length;
      (firstCard.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);

      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, pageSize, 'the whole page is marked done');
      assert.equal(doc.getElementById('themeChecklistProgressVal')?.textContent, `${pageSize}/${CHECKLIST_ITEMS} (${Math.round((pageSize / CHECKLIST_ITEMS) * 100)}%)`, 'progress reflects the completed page');
      assert.equal(doc.getElementById('badgeThemeChecklist')?.textContent, `${pageSize}/${CHECKLIST_ITEMS}`, 'badge reflects the completed page');

      const scopeKey = `${CHECKLIST_STORAGE_PREFIX}:${DEFAULT_ORIGIN}@`;
      assert.equal(storedScopeKeys(win).length, 1, 'exactly one storefront scope is written');
      assert.ok(storedScopeKeys(win)[0]?.startsWith(scopeKey), 'the scope carries both storefront origin and workspace');
      assert.equal(
        win.localStorage.getItem(`${CHECKLIST_STORAGE_PREFIX}:${DEFAULT_ORIGIN}`),
        null,
        'progress is never filed under an origin-only key a second project would share'
      );

      const persisted = JSON.parse(win.localStorage.getItem(storedScopeKeys(win)[0] ?? '') ?? '{}') as Record<string, boolean>;
      assert.equal(Object.keys(persisted).length, pageSize, 'only the completed items are persisted as done');

      (doc.querySelector('.phase-filter-btn[data-page="uncompleted"]') as HTMLElement).click();
      await flush(4);
      assert.equal(list.querySelectorAll('.theme-item-row').length, CHECKLIST_ITEMS - pageSize, 'uncompleted filter hides done items');
      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, 0, 'no completed row survives the uncompleted filter');

      (doc.querySelector('.phase-filter-btn[data-page="all"]') as HTMLElement).click();
      await flush(4);
      const reRenderedCard = list.querySelector('.theme-phase-card') as HTMLElement;
      assert.equal(reRenderedCard.querySelector('.theme-btn-toggle-all')?.textContent, '↺ Bỏ xong', 'a fully completed page offers the reverse toggle');
      (reRenderedCard.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, 0, 'toggling again clears the page');
    } finally {
      dom.window.close();
    }
  });

  test('report export writes one markdown section per page and one line per item', async (t) => {
    const { doc, clipboard, dom } = await loadToolbar();
    try {
      (doc.getElementById('themeChecklistList')?.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      (doc.getElementById('btnThemeExportReport') as HTMLElement).click();
      await flush(8);

      assert.equal(clipboard.writes.length, 1, 'the report is written to the clipboard once');
      const report = clipboard.writes[0];
      assert.ok(report, 'the report text was captured');
      assert.match(report, /^# BÁO CÁO TIẾN ĐỘ THEME/m, 'report has a document heading');
      assert.equal((report.match(/^### /gm) ?? []).length, PAGE_KEYS.length, 'one markdown section per page group');
      assert.equal((report.match(/^- \[[ x]\]/gm) ?? []).length, CHECKLIST_ITEMS, 'one markdown line per checklist item');
      const doneRows = doc.getElementById('themeChecklistList')?.querySelectorAll('.theme-item-row.is-done').length ?? 0;
      assert.equal((report.match(/^- \[x\]/gm) ?? []).length, doneRows, 'checked lines match the completed items');
      assert.match(report, /🎯 QA:/, 'each item keeps its QA point in the report');
      assert.match(report, /Phạm vi bằng chứng:.*viewport mobile 375px/, 'the report states what the scan does not prove');
    } finally {
      dom.window.close();
    }
  });

  test('per-page scan navigates, runs QA, and hands the report to the findings tab', async (t) => {
    const { doc, calls, dom, runTimers } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/` });
    try {
      // Home is already open; the cart is not, so the card must open it before scanning.
      const cartCard = (Array.from(doc.querySelectorAll('.theme-phase-card')) as HTMLElement[])[3];
      assert.ok(cartCard, 'the cart card exists');
      (cartCard.querySelector('.theme-btn-scan-page') as HTMLElement).click();
      // The cockpit waits for the navigation to settle before scanning; advance that timer.
      runTimers();
      await flush(8);

      assert.ok(calls.includes(`navigate:${DEFAULT_ORIGIN}/cart`), 'the storefront route is opened first');
      assert.ok(calls.includes('runThemeQa'), 'the scan runs against the opened page');
      assert.equal(doc.getElementById('themeTabFindings')?.style.display, 'flex', 'the findings tab becomes visible');
      assert.equal(doc.getElementById('themeTabChecklist')?.style.display, 'none', 'the checklist tab is hidden while findings show');
      assert.ok(doc.querySelectorAll('#themeQaFindingsList .qa-finding-card').length > 0, 'the live findings are rendered');
      assert.equal(doc.getElementById('badgeThemeFindings')?.textContent, '1 Issues', 'the findings badge reflects the report');
    } finally {
      dom.window.close();
    }
  });

  test('the product card refuses to open or scan a route that does not exist', async (t) => {
    // Storefront open on the home page: no product page exists to scan.
    const { doc, calls, dom, runTimers } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/` });
    try {
      const cards = Array.from(doc.querySelectorAll('.theme-phase-card')) as HTMLElement[];
      const pdpCard = cards[2];
      assert.ok(pdpCard, 'the product card exists');

      (pdpCard.querySelector('.theme-btn-open-page') as HTMLElement).click();
      (pdpCard.querySelector('.theme-btn-scan-page') as HTMLElement).click();
      runTimers();
      await flush(8);

      assert.equal(calls.filter((c) => c.startsWith('navigate:')).length, 0, 'no invented /products route is opened');
      assert.ok(!calls.some((c) => c.includes('/products')), 'the PDP route is never guessed');
      assert.equal(calls.filter((c) => c === 'runThemeQa').length, 0, 'no QA run is claimed for a page that is not open');
    } finally {
      dom.window.close();
    }
  });

  test('the product card scans the product page that is actually open', async (t) => {
    const { doc, calls, dom, runTimers } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/products/ao-thun` });
    try {
      const pdpCard = (Array.from(doc.querySelectorAll('.theme-phase-card')) as HTMLElement[])[2];
      assert.ok(pdpCard, 'the product card exists');

      (pdpCard.querySelector('.theme-btn-scan-page') as HTMLElement).click();
      runTimers();
      await flush(8);

      assert.equal(calls.filter((c) => c === 'runThemeQa').length, 1, 'the open product page is scanned');
      assert.equal(calls.filter((c) => c.startsWith('navigate:')).length, 0, 'a page already on screen is not re-navigated before scanning');
    } finally {
      dom.window.close();
    }
  });

  test('progress follows the storefront, not the window', async (t) => {
    const { doc, dom, api } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/` });
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      (doc.getElementById('themeChecklistList')?.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      const firstPageDone = list.querySelectorAll('.theme-item-row.is-done').length;
      assert.ok(firstPageDone > 0, 'the first page is ticked on storefront A');

      api.__pushState([tab('tab-2', 'http://shop-b.local/')], 'tab-2');
      await flush(4);
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(4);
      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, 0, 'storefront B starts with nothing ticked');
      assert.equal(doc.getElementById('themeChecklistProgressVal')?.textContent, `0/${CHECKLIST_ITEMS} (0%)`, 'storefront B shows its own progress');

      api.__pushState([tab('tab-1', `${DEFAULT_ORIGIN}/`)], 'tab-1');
      await flush(4);
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(4);
      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, firstPageDone, 'storefront A keeps its own progress');
    } finally {
      dom.window.close();
    }
  });

  test('an unresolvable workspace still gets its own scope, never a bare origin key', async (t) => {
    // Legacy lane: the pin is the unknown-workspace key materializing in localStorage.
    const { doc, win, dom } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/`, workspacePath: '', omitChecklistBridge: true });
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      (list.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);

      assert.deepEqual(
        storedScopeKeys(win),
        [`${CHECKLIST_STORAGE_PREFIX}:${DEFAULT_ORIGIN}@unknown-workspace`],
        'an unknown workspace is marked as such instead of collapsing to the shared origin'
      );
      assert.equal(win.localStorage.getItem(`${CHECKLIST_STORAGE_PREFIX}:${DEFAULT_ORIGIN}`), null, 'no bare-origin key exists');
    } finally {
      dom.window.close();
    }
  });

  test('the same project reported with different path casing keeps one scope', async (t) => {
    // Legacy lane: asserts the stored key count, so it must run on localStorage.
    const { doc, win, dom, api } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/`, workspacePath: 'E:\\Work\\Themes\\Shop-A', omitChecklistBridge: true });
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      (list.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      const ticked = list.querySelectorAll('.theme-item-row.is-done').length;
      assert.ok(ticked > 0, 'the project has progress');

      // The same directory as Windows would report it from a different source.
      api.__setWorkspace('e:/work/themes/shop-a');
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(6);

      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, ticked, 'progress survives a path-case variant');
      assert.equal(storedScopeKeys(win).length, 1, 'one project never splits into two scopes');
    } finally {
      dom.window.close();
    }
  });

  test('the toolbar stays usable when the workspace query never answers', async (t) => {
    // Legacy lane: asserts the unknown-workspace key is written to localStorage.
    const { doc, win, dom, runTimers } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/`, hangWorkspace: true, omitChecklistBridge: true });
    try {
      // Boot must not wait on the workspace: the toolbar is already interactive.
      assert.ok(doc.getElementById('badgeThemeChecklist'), 'the toolbar rendered while the query hung');
      assert.ok(
        doc.getElementById('themeChecklistList')?.querySelector('.theme-checklist-pending'),
        'the checklist names the pending identity instead of showing a wrong list'
      );

      // The bounded wait gives up and the checklist opens on the unknown-workspace scope.
      runTimers();
      await flush(6);
      const list = doc.getElementById('themeChecklistList');
      assert.equal(list?.querySelectorAll('.theme-item-row').length, CHECKLIST_ITEMS, 'the checklist opens once the wait is bounded');
      assert.equal(list?.querySelector('.theme-checklist-pending'), null, 'the pending row is gone');

      (list?.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      assert.deepEqual(
        storedScopeKeys(win),
        [`${CHECKLIST_STORAGE_PREFIX}:${DEFAULT_ORIGIN}@unknown-workspace`],
        'an unanswered query files progress under the marked scope'
      );
    } finally {
      dom.window.close();
    }
  });

  test('a local dev port shared by two theme projects keeps two separate checklists', async (t) => {
    // 127.0.0.1:9292 is the fixed local storefront port, so both projects present the
    // same origin; only the workspace tells them apart. On the IPC lane the durable
    // artifact is the store's per-scope record, not a localStorage key — an
    // unmutated scope leaves no row at all, which is itself the separation proof.
    const localPort = 'http://127.0.0.1:9292';
    const { doc, dom, api } = await loadToolbar({ openUrl: `${localPort}/`, workspacePath: 'E:\\Work\\themes\\shop-a' });
    try {
      const bridge = api.__checklist;
      assert.ok(bridge, 'the checklist IPC lane is on in this fixture');
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      (list.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      const projectADone = list.querySelectorAll('.theme-item-row.is-done').length;
      assert.ok(projectADone > 0, 'project A is in progress');
      const scopeA = checklistScope(localPort, workspaceTag('E:\\Work\\themes\\shop-a'));
      const scopeB = checklistScope(localPort, workspaceTag('E:\\Work\\themes\\shop-b'));
      assert.notEqual(scopeA, scopeB, 'the two projects derive distinct scopes on the shared port');
      assert.ok(bridge.records.get(scopeA)?.items.filter((item) => item.done).length === projectADone, 'project A persisted under its own scope');

      api.__setWorkspace('E:\\Work\\themes\\shop-b');
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(6);

      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, 0, 'project B does not inherit project A\'s ticks');
      assert.equal(doc.getElementById('themeChecklistProgressVal')?.textContent, `0/${CHECKLIST_ITEMS} (0%)`, 'project B starts at zero');
      assert.equal(bridge.records.has(scopeB), false, 'an unmutated scope has no durable row — nothing of A leaks into B');

      api.__setWorkspace('E:\\Work\\themes\\shop-a');
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(6);

      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, projectADone, 'project A\'s ticks come back');
      // Mutating B must not touch A's record even though the origin is shared.
      api.__setWorkspace('E:\\Work\\themes\\shop-b');
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(6);
      (doc.getElementById('themeChecklistList')?.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      const recA = bridge.records.get(scopeA);
      const recB = bridge.records.get(scopeB);
      assert.ok(recA && recB, 'both projects hold their own store records under one origin');
      assert.equal(recB.items.filter((item) => item.done).length > 0, true, 'project B persisted its own progress');
      assert.equal(recA.items.filter((item) => item.done).length, projectADone, 'project A\'s record is untouched by B\'s save');
    } finally {
      dom.window.close();
    }
  });

  test('page card can be collapsed and expanded by clicking header', async (t) => {
    const { doc, dom } = await loadToolbar();
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      const firstCard = list.querySelector('.theme-phase-card') as HTMLElement;
      const header = firstCard.querySelector('.theme-phase-header') as HTMLElement;
      const itemsBox = firstCard.querySelector('.theme-phase-items') as HTMLElement;

      assert.notEqual(itemsBox.style.display, 'none', 'initially expanded');
      header.click();
      await flush(4);
      const collapsedCard = list.querySelector('.theme-phase-card') as HTMLElement;
      const collapsedItems = collapsedCard.querySelector('.theme-phase-items') as HTMLElement;
      assert.equal(collapsedItems.style.display, 'none', 'clicking header collapses card');

      (collapsedCard.querySelector('.theme-phase-header') as HTMLElement).click();
      await flush(4);
      const expandedCard = list.querySelector('.theme-phase-card') as HTMLElement;
      const expandedItems = expandedCard.querySelector('.theme-phase-items') as HTMLElement;
      assert.notEqual(expandedItems.style.display, 'none', 'clicking header again expands card');
    } finally {
      dom.window.close();
    }
  });

  test('supports full CRUD: add new item, edit it, and delete it with persistence', async (t) => {
    const { doc, win, dom } = await loadToolbar();
    try {
      // 1. CREATE: Open dialog, submit form
      const btnAdd = doc.getElementById('btnThemeItemAdd') as HTMLElement;
      assert.ok(btnAdd, 'add item button exists');
      btnAdd.click();
      await flush(4);

      const overlay = doc.getElementById('themeItemEditOverlay') as HTMLElement;
      assert.equal(overlay.style.display, 'flex', 'item edit modal opens');

      const nameInput = doc.getElementById('itemEditName') as HTMLInputElement;
      const descInput = doc.getElementById('itemEditDesc') as HTMLTextAreaElement;
      const qaInput = doc.getElementById('itemEditQa') as HTMLInputElement;
      const saveBtn = doc.getElementById('btnItemEditSave') as HTMLElement;

      nameInput.value = 'Banner Video Pop-up';
      descInput.value = 'Popup video review sản phẩm khi click banner';
      qaInput.value = 'Video tự động dừng khi đóng popup, autoplay muted';
      saveBtn.click();
      await flush(4);

      assert.equal(overlay.style.display, 'none', 'modal closes after save');
      const list = doc.getElementById('themeChecklistList') as HTMLElement;
      const allRows = list.querySelectorAll('.theme-item-row');
      assert.equal(allRows.length, CHECKLIST_ITEMS + 1, 'list has one extra item');

      const newItemRow = Array.from(allRows).find((r) => r.textContent?.includes('Banner Video Pop-up')) as HTMLElement;
      assert.ok(newItemRow, 'new item row is rendered in the list');
      assert.ok(newItemRow.textContent?.includes('Video tự động dừng'), 'QA criteria rendered');

      // 2. UPDATE: Click Edit button on the new item
      const btnEdit = newItemRow.querySelector('.theme-btn-item-edit') as HTMLElement;
      assert.ok(btnEdit, 'edit button exists on row');
      btnEdit.click();
      await flush(4);

      assert.equal(overlay.style.display, 'flex', 'edit modal opens');
      assert.equal(nameInput.value, 'Banner Video Pop-up', 'modal pre-fills item name');
      assert.equal(qaInput.value, 'Video tự động dừng khi đóng popup, autoplay muted', 'modal pre-fills QA criteria');

      nameInput.value = 'Banner Video Pop-up V2';
      qaInput.value = 'Hỗ trợ cả iframe Youtube và MP4 native';
      saveBtn.click();
      await flush(4);

      assert.equal(overlay.style.display, 'none', 'modal closes after update');
      const updatedRows = list.querySelectorAll('.theme-item-row');
      const updatedItemRow = Array.from(updatedRows).find((r) => r.textContent?.includes('Banner Video Pop-up V2')) as HTMLElement;
      assert.ok(updatedItemRow, 'updated item row is rendered');
      assert.ok(updatedItemRow.textContent?.includes('Hỗ trợ cả iframe Youtube'), 'updated QA criteria rendered');

      // 3. DELETE: Click Delete button on the item
      win.confirm = () => true;
      const btnDelete = updatedItemRow.querySelector('.theme-btn-item-delete') as HTMLElement;
      assert.ok(btnDelete, 'delete button exists on row');
      btnDelete.click();
      await flush(4);

      const afterDeleteRows = list.querySelectorAll('.theme-item-row');
      assert.equal(afterDeleteRows.length, CHECKLIST_ITEMS, 'item count returns to original after delete');
      assert.ok(!Array.from(afterDeleteRows).some((r) => r.textContent?.includes('Banner Video Pop-up V2')), 'deleted item no longer exists');
    } finally {
      dom.window.close();
    }
  });

  describe('checklist store bridge lane (IPC)', () => {
    const LEGACY_DATA_PREFIX = 'antifan_theme_checklist_custom_items';
    const legacyDoneKey = (scope: string) => `${CHECKLIST_STORAGE_PREFIX}:${scope}`;
    const legacyDataKey = (scope: string) => `${LEGACY_DATA_PREFIX}:${scope}`;
    const currentScope = () => checklistScope(DEFAULT_ORIGIN, workspaceTag(DEFAULT_WORKSPACE));

    /** Rendered row for a default-checklist item id, found by its code column. */
    const rowFor = (doc: Document, itemId: string): HTMLElement | null => {
      const item = DEFAULT_THEME_CHECKLIST.find((entry) => entry.id === itemId);
      assert.ok(item, `fixture item ${itemId} exists in the default checklist`);
      return (Array.from(doc.querySelectorAll('.theme-item-row')) as HTMLElement[])
        .find((row) => row.querySelector('.theme-item-code')?.textContent === item.code) ?? null;
    };

    test('two mutations inside one save RTT both persist on the serialized CAS chain', async () => {
      // Red→green pin for the lost second mutation: while save #1 is in flight a
      // second mutation enqueues. The chained save must price its CAS base at
      // execution time — off save #1's updatedAt — not at enqueue time, or the
      // second tick self-conflicts and is silently dropped.
      const { doc, dom, api } = await loadToolbar({ checklistBridge: { holdSaves: true } });
      try {
        const bridge = api.__checklist;
        assert.ok(bridge, 'the checklist IPC lane is on in this fixture');
        const scope = currentScope();

        (rowFor(doc, 'hom-01')?.querySelector('.theme-item-checkbox') as HTMLInputElement).click();
        await flush(2);
        assert.equal(bridge.pendingSaves.length, 1, 'the first save is parked on the wire');
        (rowFor(doc, 'hom-02')?.querySelector('.theme-item-checkbox') as HTMLInputElement).click();
        await flush(2);
        assert.equal(bridge.pendingSaves.length, 1, 'the second mutation queues behind the in-flight save');

        const firstResult = bridge.pendingSaves[0]!.resolve();
        await flush(4);
        assert.equal(bridge.pendingSaves.length, 2, 'the chained second save is invoked once the first lands');
        assert.equal(
          bridge.saveCalls[1]?.baseUpdatedAt,
          firstResult.updatedAt,
          'the second save bases on the first save\'s updatedAt — re-read inside the chain, not captured at enqueue',
        );
        const secondResult = bridge.pendingSaves[1]!.resolve();
        assert.equal(secondResult.conflict, false, 'the re-based second save lands without a conflict');
        await flush(6);

        const rec = bridge.records.get(scope);
        assert.ok(rec, 'the scope has a persisted record');
        assert.equal(rec.items.find((item) => item.id === 'hom-01')?.done, true, 'the first mutation persisted');
        assert.equal(rec.items.find((item) => item.id === 'hom-02')?.done, true, 'the second mutation survived the same RTT');
        const doneRows = doc.getElementById('themeChecklistList')?.querySelectorAll('.theme-item-row.is-done') ?? [];
        assert.equal(doneRows.length, 2, 'the checklist renders both ticks');
      } finally {
        dom.window.close();
      }
    });

    test('a rejected save degrades to legacy keys without wedging the IPC lane', async () => {
      // A transient rejection must not latch the bridge off: the fallback writes
      // the durable legacy pair, and the NEXT mutation reaches the store again.
      const { doc, win, dom, api } = await loadToolbar();
      try {
        const bridge = api.__checklist;
        assert.ok(bridge, 'the checklist IPC lane is on in this fixture');
        const scope = currentScope();
        bridge.failNextSaves = 1;

        (rowFor(doc, 'hom-01')?.querySelector('.theme-item-checkbox') as HTMLInputElement).click();
        await flush(6);

        assert.equal(bridge.saveCalls.length, 1, 'the rejected save reached the bridge');
        assert.ok(win.localStorage.getItem(legacyDoneKey(scope)), 'the done-map legacy key was written on fallback');
        assert.ok(win.localStorage.getItem(legacyDataKey(scope)), 'the items legacy key was written on fallback');
        assert.equal(JSON.parse(win.localStorage.getItem(legacyDoneKey(scope)) ?? '{}')['hom-01'], true, 'the fallback persisted the tick');

        // The very next mutation must use IPC again — the latch only belongs to
        // a MISSING bridge, not to a transient rejection.
        (rowFor(doc, 'hom-02')?.querySelector('.theme-item-checkbox') as HTMLInputElement).click();
        await flush(6);

        assert.equal(bridge.saveCalls.length, 2, 'the next save uses the IPC lane again');
        const rec = bridge.records.get(scope);
        assert.equal(rec?.items.find((item) => item.id === 'hom-02')?.done, true, 'the second tick persisted to the store');
        // The fallback row is a mirror, not a gate: the store stays authoritative.
        assert.equal(rec?.items.find((item) => item.id === 'hom-01')?.done, true, 'the store carries both ticks after recovery');
      } finally {
        dom.window.close();
      }
    });

    test('a CAS conflict on the migration save re-saves the winner∪legacy union before the legacy keys die', async () => {
      // An agent write lands between the migration LOAD and its SAVE. The merged
      // union must be recomputed against the conflict winner and re-saved, and
      // the localStorage keys only die once that union actually persisted.
      const scope = currentScope();
      const legacyRow: ThemeChecklistItem = { id: 'leg-01', code: 'LEG-01', name: 'legacy-only row', desc: 'd', qaPoint: 'q', page: 'pages', done: false };
      const { doc, win, dom, api } = await loadToolbar({
        checklistBridge: {
          holdSaves: true,
          // The store already carries a record (an agent seeded it): `existed`
          // is true, `migrated` is false, so the LOAD runs the migration merge.
          seed: { [scope]: { items: DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item })), updatedAt: 40, migrated: false } },
        },
        seedLocalStorage: (win) => {
          win.localStorage.setItem(legacyDoneKey(scope), JSON.stringify({ 'hom-01': true, 'leg-01': true }));
          win.localStorage.setItem(legacyDataKey(scope), JSON.stringify([legacyRow]));
        },
      });
      try {
        const bridge = api.__checklist;
        assert.ok(bridge, 'the checklist IPC lane is on in this fixture');
        assert.equal(bridge.pendingSaves.length, 1, 'the migration save is parked on the wire');
        const migrationCall = bridge.pendingSaves[0]!.call;
        assert.equal(migrationCall.baseUpdatedAt, 40, 'the migration save CASes on the loaded updatedAt');
        assert.ok(migrationCall.items.some((item) => item.id === 'leg-01'), 'the merge carries the legacy-only row');
        // File rows win id collisions on an existing record: the legacy
        // done-map only prices legacy-only rows, so hom-01 keeps the file's
        // authoritative flag while leg-01 arrives done from `savedDone`.
        assert.equal(migrationCall.items.find((item) => item.id === 'leg-01')?.done, true, 'the done-map prices the legacy-only row');
        assert.equal(migrationCall.items.find((item) => item.id === 'hom-01')?.done, false, 'the file row keeps its authoritative done flag');

        // The agent's interleaved write lands before the parked save resolves.
        const agentItems = DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item, done: item.id === 'hom-02' }));
        bridge.agentWrite(scope, DEFAULT_WORKSPACE, agentItems);

        const conflict = bridge.pendingSaves[0]!.resolve();
        assert.equal(conflict.conflict, true, 'the stale migration save conflicts');
        await flush(4);
        assert.equal(bridge.pendingSaves.length, 2, 'the union is re-saved on the conflict winner');
        const unionCall = bridge.pendingSaves[1]!.call;
        assert.ok(unionCall.items.some((item) => item.id === 'hom-02' && item.done), 'the union keeps the agent\'s mutation');
        assert.ok(unionCall.items.some((item) => item.id === 'leg-01'), 'the union keeps the legacy-only row');
        assert.equal(unionCall.baseUpdatedAt, conflict.updatedAt, 'the re-save bases on the conflict winner\'s updatedAt');

        // Ordering: the durable legacy keys survive until the union has persisted.
        assert.ok(win.localStorage.getItem(legacyDoneKey(scope)) !== null, 'legacy keys outlive the conflicting save');
        const unionResult = bridge.pendingSaves[1]!.resolve();
        assert.equal(unionResult.conflict, false, 'the union save lands');
        await flush(6);

        const rec = bridge.records.get(scope);
        assert.ok(rec?.items.some((item) => item.id === 'leg-01'), 'the persisted record carries the legacy row');
        assert.ok(rec?.items.some((item) => item.id === 'hom-02' && item.done), 'the persisted record carries the agent mutation');
        assert.equal(win.localStorage.getItem(legacyDoneKey(scope)), null, 'the done-map key is removed only after the union persisted');
        assert.equal(win.localStorage.getItem(legacyDataKey(scope)), null, 'the items key is removed only after the union persisted');
      } finally {
        dom.window.close();
      }
    });

    test('the boot sweep never removes keys for a scope with no durable root', async () => {
      // `unknown-workspace` scopes resolve to rootFor === '' — provisional, no
      // persisted file to migrate into. Their localStorage keys are the only
      // copy and must survive the sweep.
      const foreignScope = checklistScope('http://other-shop.local', 'foreign-tag-abc');
      const unknownScope = checklistScope('http://other-shop.local', UNKNOWN_WORKSPACE_TAG);
      const ownScope = checklistScope('http://other-shop.local', workspaceTag(DEFAULT_WORKSPACE));
      const { win, dom } = await loadToolbar({
        seedLocalStorage: (w) => {
          for (const scope of [foreignScope, unknownScope, ownScope]) {
            w.localStorage.setItem(legacyDoneKey(scope), JSON.stringify({ 'hom-01': true }));
            w.localStorage.setItem(legacyDataKey(scope), JSON.stringify([{ id: 'leg-x', code: 'LEG-X', name: 'n', desc: 'd', qaPoint: 'q', page: 'pages', done: false }]));
          }
        },
      });
      try {
        await flush(6); // let the post-identity sweep settle
        assert.equal(win.localStorage.getItem(legacyDoneKey(ownScope)), null, 'control: an own-workspace scope migrates and its keys are removed — the sweep ran');
        assert.equal(win.localStorage.getItem(legacyDoneKey(foreignScope)), '{"hom-01":true}', 'a foreign-tag scope is skipped');
        assert.ok(win.localStorage.getItem(legacyDoneKey(unknownScope)) !== null, 'the unknown-workspace scope keeps its durable keys');
        assert.ok(win.localStorage.getItem(legacyDataKey(unknownScope)) !== null, 'the unknown-workspace items key also survives');
      } finally {
        dom.window.close();
      }
    });

    test('an in-flight LOAD must not clobber a newer pushed snapshot', async () => {
      // A THEME_CHECKLIST_UPDATED push lands while the LOAD invoke is parked.
      // Resolving the load with the older snapshot must be a no-op — adopting it
      // would re-render stale rows AND roll the CAS base backward.
      const { doc, dom, api } = await loadToolbar({ checklistBridge: { holdLoads: true } });
      try {
        const bridge = api.__checklist;
        assert.ok(bridge, 'the checklist IPC lane is on in this fixture');
        const scope = currentScope();
        const pending = bridge.pendingLoads.find((entry) => entry.scope === scope);
        assert.ok(pending, 'the scope LOAD is parked on the wire');

        const pushedRow: ThemeChecklistItem = { id: 'push-01', code: 'PUSH-01', name: 'agent-pushed row', desc: 'd', qaPoint: 'q', page: 'home', done: true };
        bridge.push({ scope, workspaceRoot: DEFAULT_WORKSPACE, items: [pushedRow], updatedAt: 9999 });
        await flush(4);
        // The stale LOAD answer resolves AFTER the push — pre-fix it overwrote
        // the pushed rows wholesale.
        pending.resolve({ items: DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item })), updatedAt: 7, existed: true, migrated: true });
        await flush(6);

        const list = doc.getElementById('themeChecklistList');
        const codes = Array.from(list?.querySelectorAll('.theme-item-code') ?? [], (e) => e.textContent);
        assert.ok(codes.includes('PUSH-01'), 'the pushed snapshot stays on screen');
        assert.equal(codes.length, 1, 'the stale LOAD result does not clobber the pushed rows');
      } finally {
        dom.window.close();
      }
    });
  });
});
