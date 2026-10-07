/**
 * Cross-project tab search surfaces — real DOM proof.
 *
 * Loads the compiled toolbar.html + toolbar.js into jsdom with a stubbed
 * antifanToolbar bridge and drives the shipped search control for the behaviors the
 * project-window contract depends on: the whole inventory in Main's order for an empty
 * query, literal case-insensitive title/URL matching, an explicit no-results state, an
 * error state that clears stale rows, a stale result that renders unavailable with no
 * substitute target, exact-id activation over the activate channel only, Escape
 * returning focus to the invoking control, and the aria-live announcements.
 *
 * jsdom is a declared devDependency and a hard prerequisite of this suite; when the
 * shared node_modules copy is broken the test honors ANTIFAN_JSDOM (a dir containing
 * node_modules/jsdom) and fails with the resolution error as the named blocker.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * A jsdom window: the DOM, plus the globals a test drives events through. `antifanToolbar`
 * is rewritten here with a stub narrower than the shipped bridge, so the shipped
 * declaration is omitted rather than widened.
 */
interface ToolbarWindow extends Omit<Window, 'antifanToolbar'> {
  eval: (src: string) => unknown;
  antifanToolbar?: unknown;
  Event: typeof Event;
  KeyboardEvent: typeof KeyboardEvent;
}
interface JsdomLike { window: ToolbarWindow }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM: JsdomCtor } {
  const req = createRequire(__filename);
  // ANTIFAN_JSDOM points at a dir containing node_modules/jsdom and wins first;
  // the default lookup (junctioned node_modules) is the fallback.
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    // `createRequire` returns `any`; naming the shape once keeps every later read checked.
    const jsdomModule: { JSDOM: JsdomCtor } = req(resolved);
    return { JSDOM: jsdomModule.JSDOM };
  } catch (err) {
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RENDERER_DIR = (() => {
  // Compiled tests run from .compiled/test/renderer (or an isolated scratch outDir) —
  // walk up until the compiled renderer assets are found.
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

interface InventoryRow {
  tabId: string;
  title: string;
  url: string;
  ownerLabel: string;
  pathLabel?: string;
  live?: boolean;
}

type SearchAnswer = { status: 'OK'; rows: InventoryRow[] } | { status: 'UNAVAILABLE'; reason: string };
type ActivationAnswer =
  | { status: 'ACTIVATED'; tabId: string }
  | { status: 'UNAVAILABLE'; tabId: string; reasonCode: string; reason: string };

interface BridgeStub {
  /** The arguments the renderer actually sent, verbatim. */
  searches: Array<Record<string, unknown>>;
  activations: Array<Record<string, unknown>>;
  answerSearch: (query: string) => SearchAnswer | Promise<SearchAnswer>;
  answerActivate: (tabId: string) => ActivationAnswer | Promise<ActivationAnswer>;
  /** Deliver one state broadcast through the renderer's registered subscription. */
  pushState: (state: Record<string, unknown>) => void;
}

/**
 * Three tabs across two projects and the Unassigned bucket. The ids are deliberately
 * unrelated to position, so an activation that carried an index instead of an id would
 * be visibly wrong rather than accidentally right.
 */
const INVENTORY: InventoryRow[] = [
  { tabId: 'tab-a1', title: 'Acme Storefront — Orders', url: 'https://shop.example.com/admin/orders', ownerLabel: 'Acme', pathLabel: 'E:\\Work\\acme' },
  { tabId: 'tab-b9', title: 'Beta checkpoint spec', url: 'file:///E:/Work/beta/checkpoint-spec.md', ownerLabel: 'Beta', pathLabel: 'E:\\Work\\beta' },
  { tabId: 'tab-u3', title: 'Legacy orphan page', url: 'https://old.example.com/legacy/acme-archive', ownerLabel: 'Unassigned' },
];

const ACME_IDENTITY = {
  owner: { kind: 'project', projectId: 'proj-acme' },
  title: 'Acme',
  pathLabel: 'E:\\Work\\acme',
};

function makeApi(state: Record<string, unknown>, stub: BridgeStub) {
  const noop = () => () => undefined;
  const stateSubscribers: Array<(state: unknown) => void> = [];
  stub.pushState = (next) => {
    for (const subscriber of stateSubscribers) subscriber(next);
  };
  return {
    getInitialState: () => Promise.resolve(state),
    getWorkflowState: () => Promise.resolve({ workflows: [], tools: [] }),
    searchProjectTabs: (query: string) => {
      stub.searches.push({ query });
      return Promise.resolve().then(() => stub.answerSearch(query));
    },
    activateProjectTab: (tabId: string) => {
      stub.activations.push({ tabId });
      return Promise.resolve().then(() => stub.answerActivate(tabId));
    },
    onStateUpdated: (callback: (state: unknown) => void) => {
      stateSubscribers.push(callback);
      return () => undefined;
    },
    onThemeQaState: noop,
    // A refused close/quit is pushed by Main for display only. This suite asserts nothing
    // about that region, but the bridge member belongs to the chrome's declared surface, so
    // its absence here would be the harness lying about which bridge the renderer talks to.
    onCloseRefused: noop,
    onFocusFind: noop,
    onFocusOmnibox: noop,
    onShowShortcuts: noop,
    onFindResult: noop,
    onPhoneStatusChanged: noop,
    onWorkflowEvent: noop,
    getPhoneStatus: () => Promise.resolve({ state: 'unknown' }),
    // The overlay owner chain reports its strip height to Main; the stub records nothing,
    // but the call must exist so a passing run has no stray TypeErrors in its output.
    setOverlay: () => Promise.resolve(),
  };
}

async function flush(rounds = 12) {
  // Microtask yields only — every async hop in the search path is promise-based, so
  // draining the microtask queue is the deterministic wait (no timers).
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

function makeStub(overrides: Partial<BridgeStub> = {}): BridgeStub {
  return {
    searches: [],
    activations: [],
    answerSearch: () => ({ status: 'OK', rows: INVENTORY }),
    answerActivate: (tabId) => ({ status: 'ACTIVATED', tabId }),
    // Replaced by `makeApi` with the real channel to the renderer's subscription.
    pushState: () => undefined,
    ...overrides,
  };
}

async function loadToolbar(projectWindow: unknown, stub: BridgeStub) {
  const { JSDOM } = loadJsdom();
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  const state: Record<string, unknown> = { tabs: [], activeTabId: '', bookmarks: [], projectWindow };
  win.antifanToolbar = makeApi(state, stub);
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'exports-shim.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.js'), 'utf8'));
  await flush();
  return { dom, win, doc: win.document };
}

function listedRows(doc: Document): HTMLElement[] {
  // `Array.from`, not a spread: this project's `lib` has no `dom.iterable`.
  return Array.from(doc.querySelectorAll<HTMLElement>('#tabSearchResults [role="option"]'));
}

function rowState(row: HTMLElement | undefined): string | null {
  return row ? row.getAttribute('data-state') : null;
}

function searchStatus(doc: Document): string {
  return doc.getElementById('tabSearchStatus')?.textContent ?? '';
}

function searchInput(doc: Document): HTMLInputElement {
  const input = doc.querySelector<HTMLInputElement>('#tabSearchInput');
  assert.ok(input, 'the tab-search input exists');
  return input;
}

async function openSearch(ctx: { doc: Document; win: ToolbarWindow }) {
  const btn = ctx.doc.querySelector<HTMLButtonElement>('#btnTabSearch');
  assert.ok(btn, 'the tab-search control exists in every shell chrome');
  btn.focus();
  btn.click();
  await flush();
  return { btn, input: searchInput(ctx.doc) };
}

async function typeQuery(ctx: { doc: Document; win: ToolbarWindow }, query: string) {
  const input = searchInput(ctx.doc);
  input.value = query;
  input.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
  await flush();
}

function pressKey(ctx: { doc: Document; win: ToolbarWindow }, key: string) {
  searchInput(ctx.doc).dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('Cross-project tab search', () => {
  let dom: JsdomLike | undefined;
  after(() => { dom?.window.close(); });

  test('empty query lists Main inventory in order, announces the count, and never activates', async () => {
    const stub = makeStub();
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;

    // Nothing is requested or presented before the user opens the control.
    assert.deepEqual(stub.searches, [], 'no inventory read happens before the control is used');
    assert.deepEqual(stub.activations, []);

    const { input } = await openSearch(ctx);
    assert.deepEqual(stub.searches, [{ query: '' }], 'the empty query is the inventory read');
    assert.deepEqual(Object.keys(stub.searches[0] ?? {}), ['query'], 'the listing carries only the query');

    const listed = listedRows(doc);
    assert.equal(listed.length, 3);
    assert.deepEqual(
      listed.map((row) => row.getAttribute('data-tab-id')),
      ['tab-a1', 'tab-b9', 'tab-u3'],
      'an empty query keeps the stable inventory order Main returned',
    );

    const first = listed[0];
    assert.equal(first?.querySelector('.tab-search-row-title')?.textContent, 'Acme Storefront — Orders');
    assert.equal(first?.querySelector('.tab-search-row-url')?.textContent, 'https://shop.example.com/admin/orders');
    // Every row carries the project label and, when the owner has one, its path.
    assert.equal(first?.querySelector('.tab-search-row-project')?.textContent, 'Acme');
    assert.equal(first?.querySelector('.tab-search-row-path')?.textContent, 'E:\\Work\\acme');
    assert.equal(listed[1]?.querySelector('.tab-search-row-project')?.textContent, 'Beta');
    assert.equal(listed[2]?.querySelector('.tab-search-row-project')?.textContent, 'Unassigned');

    // Screen-reader surface: the live region announces the result count.
    const status = doc.getElementById('tabSearchStatus');
    assert.equal(status?.getAttribute('aria-live'), 'polite');
    assert.equal(status?.getAttribute('role'), 'status');
    assert.equal(status?.getAttribute('aria-atomic'), 'true');
    assert.equal(searchStatus(doc), '3 tab đang mở');

    // Keyboard wiring: the top available row is highlighted but not activated.
    assert.equal(input.getAttribute('aria-activedescendant'), 'tabSearchOption0');
    assert.equal(listed[0]?.getAttribute('aria-selected'), 'true');
    assert.deepEqual(stub.activations, [], 'listing performs no activation call');
  });

  test('matching is literal and case-insensitive over title and URL, preserving inventory order', async () => {
    const stub = makeStub();
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    await openSearch(ctx);

    // 'ACME' is the uppercase form of the project name in row 1's title and row 3's URL.
    await typeQuery(ctx, 'ACME');
    assert.deepEqual(
      listedRows(doc).map((row) => row.getAttribute('data-tab-id')),
      ['tab-a1', 'tab-u3'],
      'case-insensitive match over title and URL, in inventory order',
    );
    assert.equal(searchStatus(doc), 'Tìm thấy 2 tab khớp "ACME"');

    // A literal URL substring with punctuation matches no title at all.
    await typeQuery(ctx, 'checkpoint-spec');
    assert.deepEqual(listedRows(doc).map((row) => row.getAttribute('data-tab-id')), ['tab-b9']);
    assert.equal(searchStatus(doc), 'Tìm thấy 1 tab khớp "checkpoint-spec"');
    // URL matching folds case too, and the highlight follows the filtered set.
    await typeQuery(ctx, 'FILE:///E:/WORK/BETA');
    assert.deepEqual(listedRows(doc).map((row) => row.getAttribute('data-tab-id')), ['tab-b9']);
    assert.equal(searchInput(doc).getAttribute('aria-activedescendant'), 'tabSearchOption0');

    assert.deepEqual(stub.activations, [], 'filtering never presents a tab');
  });

  test('a query with no literal match reports an explicit no-results state', async () => {
    const stub = makeStub();
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    await openSearch(ctx);
    assert.equal(listedRows(doc).length, 3);

    await typeQuery(ctx, 'zzz-not-a-tab');
    assert.equal(doc.getElementById('tabSearchResults')?.getAttribute('data-state'), 'no-results');
    assert.equal(listedRows(doc).length, 0, 'no option rows survive a query with no match');
    assert.match(doc.querySelector('#tabSearchResults .tab-search-message')?.textContent ?? '', /Không có tab nào khớp "zzz-not-a-tab"/);
    assert.match(searchStatus(doc), /Không có tab nào khớp/);
    assert.deepEqual(stub.activations, []);
  });

  test('an empty inventory reads as an empty shell, not as a failed query', async () => {
    const stub = makeStub({ answerSearch: () => ({ status: 'OK', rows: [] }) });
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    await openSearch(ctx);

    assert.equal(ctx.doc.getElementById('tabSearchResults')?.getAttribute('data-state'), 'empty');
    assert.equal(searchStatus(ctx.doc), 'Chưa có tab nào đang mở');
  });

  test('a row Main already reported gone renders unavailable and Enter never substitutes a target', async () => {
    const stale = [...INVENTORY];
    stale[1] = { ...INVENTORY[1]!, live: false };
    const stub = makeStub({ answerSearch: () => ({ status: 'OK', rows: stale }) });
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    await openSearch(ctx);

    const listed = listedRows(doc);
    assert.equal(rowState(listed[1]), 'unavailable');
    assert.equal(listed[1]?.getAttribute('aria-disabled'), 'true');
    assert.equal(rowState(listed[0]), 'available');
    assert.equal(rowState(listed[2]), 'available');

    // Arrow navigation steps over the dead row instead of stopping on it.
    pressKey(ctx, 'ArrowDown');
    await flush();
    assert.equal(searchInput(doc).getAttribute('aria-activedescendant'), 'tabSearchOption2');

    // Clicking the stale row reports it and never falls back to a neighbouring row.
    listed[1]?.click();
    await flush();
    assert.deepEqual(stub.activations, [], 'a row known to be gone is not re-asked');
    assert.match(searchStatus(doc), /không còn khả dụng/);

    // Enter on the highlighted live row still activates exactly that id.
    pressKey(ctx, 'Enter');
    await flush();
    assert.deepEqual(stub.activations, [{ tabId: 'tab-u3' }]);
  });

  test('a stale activation marks that row unavailable without presenting anything else', async () => {
    const stub = makeStub({
      answerActivate: (tabId) => ({ status: 'UNAVAILABLE', tabId, reasonCode: 'TAB_CLOSED', reason: 'tab đã đóng' }),
    });
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    const { input } = await openSearch(ctx);

    pressKey(ctx, 'ArrowDown');
    await flush();
    pressKey(ctx, 'Enter');
    await flush();

    assert.deepEqual(stub.activations, [{ tabId: 'tab-b9' }], 'one exact id, asked once');
    assert.deepEqual(Object.keys(stub.activations[0] ?? {}), ['tabId'], 'only the id leaves the renderer');
    assert.equal(stub.searches.length, 1, 'no re-listing is used as a fallback path');

    const listed = listedRows(doc);
    assert.equal(listed.length, 3, 'the result set is unchanged — nothing was substituted');
    assert.equal(rowState(listed[1]), 'unavailable', 'the stale row renders as unavailable in place');
    assert.equal(listed[1]?.getAttribute('aria-disabled'), 'true');
    assert.equal(rowState(listed[0]), 'available');
    assert.equal(rowState(listed[2]), 'available');
    assert.match(searchStatus(doc), /Beta checkpoint spec không còn khả dụng/);
    assert.match(searchStatus(doc), /tab đã đóng/);
    assert.equal(doc.getElementById('tabSearchOverlay')?.style.display, 'flex', 'the table stays up for a deliberate second choice');
    assert.equal(doc.activeElement, input, 'no focus moved, because nothing was presented');

    // Enter again on the known-stale row is inert: no retry, no fallback.
    pressKey(ctx, 'Enter');
    await flush();
    assert.equal(stub.activations.length, 1);
  });

  test('an activation answering with a different tab id is refused rather than followed', async () => {
    const stub = makeStub({ answerActivate: () => ({ status: 'ACTIVATED', tabId: 'tab-a1' }) });
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    await openSearch(ctx);

    pressKey(ctx, 'ArrowDown');
    await flush();
    pressKey(ctx, 'Enter');
    await flush();

    // The requested row is the second one; a confirmation naming another tab is not an
    // activation of this one, so the row is marked unavailable and the panel stays open.
    assert.deepEqual(stub.activations, [{ tabId: 'tab-b9' }]);
    assert.equal(rowState(listedRows(doc)[1]), 'unavailable');
    assert.equal(doc.getElementById('tabSearchOverlay')?.style.display, 'flex');
    assert.match(searchStatus(doc), /main xác nhận một tab khác/);
  });

  test('Enter activates the exact id through the activate channel only', async () => {
    const stub = makeStub();
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    await openSearch(ctx);

    pressKey(ctx, 'ArrowDown');
    await flush();
    pressKey(ctx, 'Enter');
    await flush();

    assert.deepEqual(stub.activations, [{ tabId: 'tab-b9' }]);
    assert.deepEqual(Object.keys(stub.activations[0] ?? {}), ['tabId'], 'display text never becomes a target');
    assert.equal(stub.searches.length, 1, 'activation does not travel the listing channel');
    assert.equal(doc.getElementById('tabSearchOverlay')?.style.display, 'none', 'a presented tab closes the table');
    assert.equal(doc.querySelector<HTMLButtonElement>('#btnTabSearch')?.getAttribute('aria-expanded'), 'false');
  });

  test('Escape closes search and returns focus to the control that opened it', async () => {
    const stub = makeStub();
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    const { btn, input } = await openSearch(ctx);
    assert.equal(doc.activeElement, input, 'search takes focus when it opens');
    assert.equal(btn.getAttribute('aria-expanded'), 'true', 'the control reports the panel it opened');

    pressKey(ctx, 'Escape');
    await flush();

    assert.equal(doc.getElementById('tabSearchOverlay')?.style.display, 'none');
    assert.equal(doc.activeElement, btn, 'Escape returns focus to the invoking control');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(input.value, '');
    assert.deepEqual(stub.activations, []);
  });

  test('a listing failure shows the error state, clears stale rows and announces the reason', async () => {
    const stub = makeStub();
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    const { doc } = ctx;
    await openSearch(ctx);
    assert.equal(listedRows(doc).length, 3);

    stub.answerSearch = () => { throw new Error('tab authority offline'); };
    await typeQuery(ctx, 'acme');

    assert.equal(doc.getElementById('tabSearchResults')?.getAttribute('data-state'), 'error');
    assert.equal(listedRows(doc).length, 0, 'rows from the previous answer are not left looking live');
    assert.match(doc.querySelector('#tabSearchResults .tab-search-message')?.textContent ?? '', /tab authority offline/);
    assert.match(searchStatus(doc), /Không tải được danh sách tab/);
    assert.match(searchStatus(doc), /tab authority offline/);
    assert.deepEqual(stub.activations, []);
  });

  test('a rejected listing is an error state, not an empty result', async () => {
    const stub = makeStub({ answerSearch: () => Promise.reject(new Error('no handler registered')) });
    const ctx = await loadToolbar(ACME_IDENTITY, stub);
    dom = ctx.dom;
    await openSearch(ctx);

    assert.equal(ctx.doc.getElementById('tabSearchResults')?.getAttribute('data-state'), 'error');
    assert.match(searchStatus(ctx.doc), /no handler registered/);
  });

  test('the tab strip names its project scope on the identity chip', async () => {
    const ctx = await loadToolbar(ACME_IDENTITY, makeStub());
    dom = ctx.dom;
    // A detached project shell's strip is scoped to that project; the chip carries the
    // label (and the detach affordance), the rows never do.
    const chip = ctx.doc.getElementById('projectIdentityChip');
    assert.ok(chip, 'the project identity chip exists');
    await flush();
    assert.equal(chip.style.display, 'inline-flex', 'a project identity surfaces the chip');
    assert.equal(ctx.doc.getElementById('projectIdentityName')?.textContent, 'Acme');
    assert.equal(chip.classList.contains('is-detached'), true, 'a project-owned shell reads as detached');
    assert.equal(ctx.doc.getElementById('projectChipTitle')?.textContent, 'Acme', 'the popover title mirrors the identity');
  });
});
