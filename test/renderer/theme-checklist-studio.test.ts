/**
 * Theme Studio checklist surfaces (page-by-page A-Z checklist) — real DOM proof.
 *
 * Loads the compiled toolbar.html + toolbar.js into jsdom with a stubbed
 * antifanToolbar bridge and asserts the checklist contract the cockpit exposes:
 * one card per storefront page group, every item carrying a QA point, the
 * per-page open/scan/toggle actions, the "Chưa làm" and per-page filters, the
 * persisted progress record, the Markdown report export, and the per-page scan
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

interface JsdomLike { window: Window & { eval: (src: string) => unknown } }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM?: JsdomCtor; error?: string } {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    return { JSDOM: (req(resolved) as { JSDOM: JsdomCtor }).JSDOM };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
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

function makeApi(clipboard: ClipboardSpy, calls: string[], tabs: StubTab[], activeTabId: string, workspacePath = DEFAULT_WORKSPACE, hangWorkspace = false) {
  const stateListeners: Array<(state: unknown) => void> = [];
  let liveTabs = tabs;
  let liveActiveTabId = activeTabId;
  let liveWorkspacePath = workspacePath;
  const broadcast = () => {
    const state = { tabs: liveTabs, activeTabId: liveActiveTabId, bookmarks: [] };
    for (const listener of stateListeners) listener(state);
  };
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
    __clipboard: clipboard,
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
}

async function loadToolbar(options: LoadToolbarOptions = {}): Promise<ToolbarHandle> {
  const { openUrl = `${DEFAULT_ORIGIN}/`, workspacePath = DEFAULT_WORKSPACE, hangWorkspace = false } = options;
  const { JSDOM, error } = loadJsdom();
  if (!JSDOM) throw new Error(`jsdom unavailable: ${error}`);
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
  const api = makeApi(clipboard, calls, [tab('tab-1', openUrl)], 'tab-1', workspacePath, hangWorkspace);
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const { doc, win, dom } = await loadToolbar();
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const { doc, win, dom } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/`, workspacePath: '' });
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const { doc, win, dom, api } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/`, workspacePath: 'E:\\Work\\Themes\\Shop-A' });
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const { doc, win, dom, runTimers } = await loadToolbar({ openUrl: `${DEFAULT_ORIGIN}/`, hangWorkspace: true });
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    // 127.0.0.1:9292 is the fixed local storefront port, so both projects present the
    // same origin; only the workspace tells them apart.
    const localPort = 'http://127.0.0.1:9292';
    const { doc, win, dom, api } = await loadToolbar({ openUrl: `${localPort}/`, workspacePath: 'E:\\Work\\themes\\shop-a' });
    try {
      const list = doc.getElementById('themeChecklistList');
      assert.ok(list, 'checklist list exists');
      (list.querySelector('.theme-btn-toggle-all') as HTMLElement).click();
      await flush(4);
      const projectADone = list.querySelectorAll('.theme-item-row.is-done').length;
      assert.ok(projectADone > 0, 'project A is in progress');

      api.__setWorkspace('E:\\Work\\themes\\shop-b');
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(6);

      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, 0, 'project B does not inherit project A\'s ticks');
      assert.equal(doc.getElementById('themeChecklistProgressVal')?.textContent, `0/${CHECKLIST_ITEMS} (0%)`, 'project B starts at zero');
      assert.equal(storedScopeKeys(win).length, 1, 'project B has no stored progress of its own yet');

      api.__setWorkspace('E:\\Work\\themes\\shop-a');
      (doc.getElementById('tabNavThemeChecklist') as HTMLElement).click();
      await flush(6);

      assert.equal(list.querySelectorAll('.theme-item-row.is-done').length, projectADone, 'project A\'s ticks come back');
      assert.equal(storedScopeKeys(win).length, 2, 'the two projects hold separate scopes on the same origin');
      for (const key of storedScopeKeys(win)) {
        assert.ok(key.startsWith(`${CHECKLIST_STORAGE_PREFIX}:${localPort}@`), `scope ${key} is origin- and workspace-tagged`);
      }
    } finally {
      dom.window.close();
    }
  });

  test('page card can be collapsed and expanded by clicking header', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
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
});
