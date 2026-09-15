/**
 * Tab categories + sleeping sessions in the terminal renderer.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the
 * shared vm harness (only document/window/xterm/preload are stubbed), so they
 * exercise the actual grouping pass, the sleeping-session pane guards, the
 * wake-on-input funnel and the bulk affinity round-trip rather than a
 * re-implementation of them.
 *
 * The two properties the feature lives or dies on:
 *   1. A sleeping session must never build an xterm — that is the whole
 *      "zero-cost" guarantee, and `terminalPool.get` is its last line of defence.
 *   2. A category header must never be a reorder target — tab reordering must
 *      resolve both ends by SESSION ID, not by raw DOM position.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadStandalone, RENDERER_DIR, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const flushFrame = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await flush();
};

const countCalls = (harness: StandaloneHarness, name: string): number =>
  harness.apiCalls.filter((entry) => entry === name).length;

const lastArgs = (harness: StandaloneHarness, name: string): unknown[] | undefined =>
  harness.apiCallArgs.filter((entry) => entry.name === name).at(-1)?.args;

/**
 * Session ids as a plain host-realm array.
 *
 * `sessions` lives inside the vm context, so anything derived from it carries the
 * vm's Array.prototype and `assert.deepStrictEqual` would reject it as
 * "same structure but not reference-equal". `Array.from` normalizes the realm.
 */
const sessionIds = (harness: StandaloneHarness): string[] =>
  Array.from(harness.getSessions(), (session) => String(session.id));

const plain = <T>(values: ArrayLike<T> | undefined): T[] => Array.from(values ?? []);

const wrapFor = (harness: StandaloneHarness, sessionId: string): FakeElement => {
  const wrap = harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${sessionId}"]`);
  assert.ok(wrap, `expected a tab wrap for ${sessionId}`);
  return wrap;
};

const headers = (harness: StandaloneHarness): FakeElement[] =>
  harness.tabsRoot.querySelectorAll('.terminal-tab-category-header');

function dataTransfer(sourceId: string): {
  getData: (type: string) => string;
  setData: (type: string, value: string) => void;
  effectAllowed: string;
  dropEffect: string;
} {
  let value = sourceId;
  return {
    getData: () => value,
    setData: (_type: string, next: string) => { value = next; },
    effectAllowed: '',
    dropEffect: '',
  };
}

/** Replace the renderer's live session list the way a `session` broadcast does. */
function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
}

describe('Renderer terminal tab categories', () => {
  it('groups a sidebar into stable collapsible headers and never makes a header draggable', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");

    const list = [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
      { id: 's3', name: 'Three', category: 'Build', state: 'running' },
      { id: 's4', name: 'Four', category: 'Deploy', state: 'running' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    const groupHeaders = headers(harness);
    assert.deepStrictEqual(
      groupHeaders.map((header) => header.getAttribute('data-category')),
      ['Build', '__uncategorized__', 'Deploy'],
      'groups must follow first appearance in the session list, with uncategorised as its own group',
    );
    for (const header of groupHeaders) {
      assert.strictEqual(header.draggable, false, 'a category header must never be a drag source');
      assert.strictEqual(header.getAttribute('role'), 'button');
      assert.strictEqual(header.getAttribute('aria-expanded'), 'true');
    }

    // The DOM order must be header, its own wraps, next header, … — i.e. a header
    // can only ever sit directly above the tabs it actually groups.
    const flattened = harness.tabsRoot.children
      .filter((el) => el.matches('.terminal-tab-category-header') || el.matches('.terminal-tab-wrap'))
      .map((el) => el.getAttribute('data-category') ?? el.getAttribute('data-session-id'));
    assert.deepStrictEqual(flattened, ['Build', 's1', 's3', '__uncategorized__', 's2', 'Deploy', 's4']);

    assert.strictEqual(
      groupHeaders[0]?.querySelector('.terminal-tab-category-count')?.textContent,
      '2',
      'the Build header must count both of its tabs',
    );
    assert.strictEqual(
      groupHeaders[1]?.querySelector('.terminal-tab-category-label')?.textContent,
      'Chưa phân nhóm',
    );
  });

  it('collapses a group, hides its tabs and persists the collapsed set once', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    const list = [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', category: 'Build', state: 'running' },
      { id: 's3', name: 'Three', category: 'Deploy', state: 'running' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    headers(harness)[0]?.dispatch('click', {});
    await flush();

    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 1, 'a collapse must persist exactly once');
    const payload = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
    assert.deepStrictEqual(plain(payload?.collapsedCategories), ['Build']);

    assert.strictEqual(wrapFor(harness, 's1').classList.contains('is-category-collapsed'), true);
    assert.strictEqual(wrapFor(harness, 's2').classList.contains('is-category-collapsed'), true);
    assert.strictEqual(wrapFor(harness, 's3').classList.contains('is-category-collapsed'), false);
    assert.strictEqual(headers(harness)[0]?.getAttribute('aria-expanded'), 'false');

    // Expanding again restores the tabs and persists the empty set.
    headers(harness)[0]?.dispatch('click', {});
    await flush();
    assert.strictEqual(wrapFor(harness, 's1').classList.contains('is-category-collapsed'), false);
    const restored = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
    assert.deepStrictEqual(plain(restored?.collapsedCategories), []);
  });

  it('restores the persisted collapsed categories on boot', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240, collapsedCategories: ['Build'] } },
    });
    await flush();
    seed(harness, [{ id: 'b1', name: 'Build', category: 'Build', state: 'running' }], 'b1');
    harness.renderTabs();

    assert.strictEqual(wrapFor(harness, 'b1').classList.contains('is-category-collapsed'), true);
    assert.strictEqual(headers(harness)[0]?.getAttribute('aria-expanded'), 'false');
  });

  it('renders a colour chip per categorised tab in horizontal mode and no headers', async () => {
    const harness = loadStandalone();
    await flush();
    const list = [
      { id: 'h1', name: 'A', category: 'Build', state: 'running' },
      { id: 'h2', name: 'B', state: 'running' },
      { id: 'h3', name: 'C', category: 'Deploy', state: 'running' },
    ];
    seed(harness, list, 'h1');
    harness.renderTabs();

    assert.strictEqual(headers(harness).length, 0, 'headers are a sidebar-only affordance');
    const chips = harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip');
    assert.strictEqual(chips.length, 2, 'only categorised tabs carry a chip; uncategorised tabs carry none');
    assert.deepStrictEqual(chips.map((chip) => chip.getAttribute('data-category')), ['Build', 'Deploy']);
    assert.strictEqual(chips[0]?.textContent, 'Build');
    assert.match(chips[0]?.style.getPropertyValue('background') ?? '', /^#[0-9a-f]{6}$/i);
    assert.notStrictEqual(
      chips[0]?.style.getPropertyValue('background'),
      chips[1]?.style.getPropertyValue('background'),
      'different categories must get different colours',
    );

    // The colour is a pure function of the name, so a re-render cannot reshuffle it.
    const before = chips[0]?.style.getPropertyValue('background');
    harness.renderTabs();
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip')[0]?.style.getPropertyValue('background'),
      before,
    );

    // Switching to the sidebar drops the chips (grouping becomes headers instead).
    harness.assign("applyTerminalTabLayout('sidebar')");
    assert.strictEqual(harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip').length, 0);
    assert.strictEqual(headers(harness).length, 3, 'sidebar shows a header per group, including uncategorised');
  });

  it('reorders tabs by session id, so a category header can never corrupt the order', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    const list = [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
      { id: 's3', name: 'Three', state: 'running' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    // A header registers no drop handler at all: dropping a tab onto it is inert.
    const header = headers(harness)[0];
    assert.ok(header);
    header.dispatch('drop', { dataTransfer: dataTransfer('s3') });
    assert.deepStrictEqual(
      sessionIds(harness),
      ['s1', 's2', 's3'],
      'dropping onto a header must not splice anything',
    );

    // Dropping onto a tab resolves both ends by session id, not by DOM index —
    // indices would be shifted by the header interleaved between the wraps.
    wrapFor(harness, 's1').dispatch('drop', { dataTransfer: dataTransfer('s3') });
    assert.deepStrictEqual(sessionIds(harness), ['s3', 's1', 's2']);
    assert.deepStrictEqual(plain(lastArgs(harness, 'reorderTerminals')?.[0] as string[] | undefined), ['s3', 's1', 's2']);

    // The re-render keeps each tab inside its own group, and — because a group
    // keeps the slot it first appeared in — the group order is unchanged even
    // though the leading tab now belongs to the uncategorised group.
    const flattened = harness.tabsRoot.children
      .filter((el) => el.matches('.terminal-tab-category-header') || el.matches('.terminal-tab-wrap'))
      .map((el) => el.getAttribute('data-category') ?? el.getAttribute('data-session-id'));
    assert.deepStrictEqual(flattened, ['Build', 's1', '__uncategorized__', 's3', 's2']);
    assert.deepStrictEqual(
      headers(harness).map((header) => header.getAttribute('data-category')),
      ['Build', '__uncategorized__'],
      'reordering tabs must never reshuffle the group order',
    );
  });
});

describe('Renderer sleeping terminal sessions', () => {
  it('builds no xterm for a sleeping session and shows its retained transcript read-only', async () => {
    const harness = loadStandalone();
    await flush();
    const list = [
      { id: 'sl1', name: 'Sleepy', state: 'sleeping', buffer: 'old transcript\nsecond line' },
      { id: 'run1', name: 'Running', state: 'running', buffer: 'live output' },
    ];
    seed(harness, list, 'sl1');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'sl1');

    assert.strictEqual(harness.terminals.length, 0, 'sleep must never build an xterm');
    assert.strictEqual(harness.read<number>('rawTerminalPool.size'), 0, 'no pooled pane may exist for a sleeping session');

    const preview = harness.sleepPreview();
    assert.ok(preview, 'the sleeping active tab must show a read-only transcript preview');
    assert.strictEqual(preview.getAttribute('data-session-id'), 'sl1');
    assert.match(preview.querySelector('.terminal-sleep-preview-body')?.textContent ?? '', /old transcript/);

    const wrap = wrapFor(harness, 'sl1');
    assert.strictEqual(wrap.classList.contains('is-sleeping'), true);
    assert.match(wrap.querySelector('.terminal-tab-icon')?.innerHTML ?? '', /💤/);
    assert.strictEqual(
      wrap.querySelector('.terminal-tab-status-beacon')?.className,
      'terminal-tab-status-beacon sleeping',
    );
    assert.strictEqual(wrapFor(harness, 'run1').classList.contains('is-sleeping'), false);
  });

  it('shows a sleeping tab\'s retained transcript on click without building a pane', async () => {
    const harness = loadStandalone();
    await flush();
    const list = [
      { id: 'run1', name: 'Running', state: 'running', buffer: 'live output' },
      { id: 'sl1', name: 'Sleepy', state: 'sleeping', buffer: 'old transcript\nsecond line' },
    ];
    seed(harness, list, 'run1');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'run1');
    assert.strictEqual(harness.terminals.length, 1, 'only the running session owns a pane');
    assert.strictEqual(harness.sleepPreview(), null, 'no preview while a live tab is active');

    const pill = wrapFor(harness, 'sl1').querySelector('.terminal-tab');
    assert.ok(pill, 'the sleeping tab must have a clickable pill');
    pill.dispatch('click', {});
    await flushFrame();

    assert.strictEqual(harness.getActiveId(), 'sl1');
    assert.strictEqual(harness.terminals.length, 1, 'clicking a sleeping tab must not build an xterm');
    assert.strictEqual(harness.read<number>('rawTerminalPool.size'), 1);
    const preview = harness.sleepPreview();
    assert.ok(preview, 'the transcript is replayed read-only, with no PTY involved');
    assert.match(preview.querySelector('.terminal-sleep-preview-body')?.textContent ?? '', /old transcript/);
    assert.strictEqual(wrapFor(harness, 'sl1').classList.contains('active'), true);
  });

  it('releases an existing pane the moment main reports the session asleep', async () => {
    const harness = loadStandalone();
    await flush();
    const awake = [{ id: 'x1', name: 'X', state: 'running', buffer: 'hi' }];
    seed(harness, awake, 'x1');
    harness.syncTerminalPool(awake, 'x1');
    assert.strictEqual(harness.terminals.length, 1, 'a running active session gets a pane');
    assert.strictEqual(harness.mainPane.querySelectorAll('.terminal-session-pane').length, 1);

    const asleep = [{ id: 'x1', name: 'X', state: 'sleeping', buffer: 'hi' }];
    seed(harness, asleep, 'x1');
    harness.syncTerminalPool(asleep, 'x1');

    assert.strictEqual(harness.read<number>('rawTerminalPool.size'), 0, 'the pane must be released on sleep');
    assert.strictEqual(harness.mainPane.querySelectorAll('.terminal-session-pane').length, 0);
    assert.ok(harness.sleepPreview(), 'the released pane is replaced by the read-only preview');
  });

  it('never resurrects a pane for a sleeping session through fit, data or the split affordance', async () => {
    const harness = loadStandalone();
    await flush();
    const list = [{ id: 'f1', name: 'Frozen', state: 'sleeping', buffer: 'frozen output' }];
    seed(harness, list, 'f1');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'f1');

    harness.read<() => void>('fitCurrentTerminal')();
    await flushFrame();
    assert.strictEqual(harness.terminals.length, 0, 'fitCurrentTerminal must not build a sleeping pane');

    harness.emitData({ sessionId: 'f1', data: 'late chunk', seq: 4, generation: 1, throughSeq: 4 });
    await flushFrame();
    assert.strictEqual(harness.terminals.length, 0, 'onTerminalData must not build a sleeping pane');
    assert.strictEqual(harness.read<number>('rawTerminalPool.size'), 0);

    // `terminalPool.get` is the chokepoint every other lazy-create path funnels
    // through, so a direct touch must stay refused too.
    assert.strictEqual(harness.read<unknown>('terminalPool.get("f1")'), undefined);
    assert.strictEqual(harness.terminals.length, 0);

    assert.ok(harness.splitButton.onclick, 'the split toggle must be wired');
    await harness.splitButton.onclick();
    await flush();
    assert.strictEqual(countCalls(harness, 'splitTerminal'), 0, 'splitting needs two live PTYs — wake instead');
    assert.strictEqual(countCalls(harness, 'wakeTerminal'), 1, 'the split affordance wakes the sleeping session');
    assert.strictEqual(harness.terminals.length, 0);
  });

  it('calls wakeTerminal on the first keystroke and then delivers it to the fresh shell', async () => {
    const harness = loadStandalone();
    await flush();
    const sleeping = [{ id: 'w1', name: 'W', state: 'sleeping', buffer: 'bye' }];
    seed(harness, sleeping, 'w1');
    harness.syncTerminalPool(sleeping, 'w1');
    const preview = harness.sleepPreview();
    assert.ok(preview);

    assert.strictEqual(countCalls(harness, 'wakeTerminal'), 0);
    preview.dispatch('keydown', { key: 'l' });
    preview.dispatch('keydown', { key: 's' });
    assert.strictEqual(countCalls(harness, 'wakeTerminal'), 1, 'at most one wake request may be in flight');
    await flush();
    assert.strictEqual(countCalls(harness, 'wakeTerminal'), 1);
    assert.strictEqual(countCalls(harness, 'sendTerminalInputTo'), 0, 'a sleeping session must not be typed into');

    // Modified keys are shortcuts, not wake gestures.
    preview.dispatch('keydown', { key: 'c', ctrlKey: true });
    assert.strictEqual(countCalls(harness, 'wakeTerminal'), 1);

    // Main reports the session awake; the pane appears and the buffered keys land.
    const awake = [{ id: 'w1', name: 'W', state: 'running', buffer: 'bye' }];
    harness.setSessions(awake);
    harness.emitSession({ sessions: awake, activeSessionId: 'w1' });
    await flush();

    assert.strictEqual(harness.sleepPreview(), null, 'the preview must be released once the session is awake');
    assert.deepStrictEqual(lastArgs(harness, 'sendTerminalInputTo'), ['w1', 'ls']);
    assert.strictEqual(harness.read<number>('rawTerminalPool.size'), 1, 'the woken active session gets its pane back');
  });
});

describe('Renderer bulk affinity badges', () => {
  it('collapses the per-tab affinity loop into exactly one bulk call', async () => {
    const harness = loadStandalone();
    await flush();
    const list = [
      { id: 'a1', name: 'A', state: 'running' },
      { id: 'a2', name: 'B', state: 'running' },
      { id: 'a3', name: 'C', state: 'running' },
    ];
    seed(harness, list, 'a1');
    harness.apiCalls.length = 0;

    harness.renderTabs();
    await flush();

    assert.strictEqual(harness.queryAll('.terminal-tab-affinity-badge').length, 3, 'every tab carries a badge');
    assert.strictEqual(countCalls(harness, 'getTerminalAffinities'), 1, 'one bulk affinity round-trip');
    assert.strictEqual(countCalls(harness, 'getTerminalAffinity'), 0, 'no per-id affinity call may remain');

    // The bulk map is what decorates the badges.
    harness.api.getTerminalAffinities = async () => ({ a2: { tabId: 'tab-9', managedTabIds: ['tab-9'], status: 'alive' } });
    harness.api.getTabs = async () => [{ id: 'tab-9', title: 'Docs', url: 'https://example.com' }];
    await harness.updateAffinityBadges();
    assert.match(wrapFor(harness, 'a2').querySelector('.terminal-tab-affinity-badge')?.textContent ?? '', /Docs/);
  });
});

describe('Renderer tab context-menu actions', () => {
  it('wires sleep, wake and the category picker, and refuses impossible actions', async () => {
    const harness = loadStandalone({
      contextMenuActions: ['sleep', 'wake', 'category', 'rebind-tab', 'close'],
    });
    await flush();
    const list = [
      { id: 'c1', name: 'C1', state: 'running' },
      { id: 'c2', name: 'C2', state: 'sleeping', buffer: 'zzz' },
    ];
    seed(harness, list, 'c1');
    harness.renderTabs();

    const menuEvent = {
      key: '',
      clientX: 10,
      clientY: 10,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    const item = (action: string): FakeElement => {
      const found = harness.contextMenu.querySelector(`.context-item[data-action="${action}"]`);
      assert.ok(found, `expected a context-menu item for ${action}`);
      return found;
    };

    // A running tab can sleep; a sleeping tab cannot be slept again.
    harness.showContextMenu(menuEvent, 'c1');
    assert.strictEqual(item('sleep').getAttribute('aria-disabled'), 'false');
    assert.strictEqual(item('wake').getAttribute('aria-disabled'), 'true');
    item('sleep').dispatch('click', {});
    await flush();
    assert.strictEqual(countCalls(harness, 'sleepTerminal'), 1);
    assert.deepStrictEqual(lastArgs(harness, 'sleepTerminal'), ['c1']);

    harness.showContextMenu(menuEvent, 'c2');
    assert.strictEqual(item('sleep').getAttribute('aria-disabled'), 'true');
    assert.strictEqual(item('wake').getAttribute('aria-disabled'), 'false');
    item('sleep').dispatch('click', {});
    await flush();
    assert.strictEqual(countCalls(harness, 'sleepTerminal'), 1, 'sleeping an already-sleeping tab is a no-op');

    // Wake round-trips for the sleeping tab only. The menu is re-opened because
    // the previous action cleared the right-click target.
    harness.showContextMenu(menuEvent, 'c2');
    item('wake').dispatch('click', {});
    await flush();
    assert.strictEqual(countCalls(harness, 'wakeTerminal'), 1);
    assert.deepStrictEqual(harness.apiCallArgs.filter((c) => c.name === 'wakeTerminal')[0]?.args, ['c2']);

    // The category picker saves through setCategory.
    harness.showContextMenu(menuEvent, 'c1');
    item('category').dispatch('click', {});
    const popover = harness.elements.get('categoryPickerPopover');
    assert.ok(popover, 'the category picker popover element must exist');
    assert.strictEqual(popover.style.display, 'block');
    assert.strictEqual(popover.getAttribute('data-active-session-id'), 'c1');
    const input = popover.querySelector('.terminal-category-picker-input');
    assert.ok(input, 'the picker must offer a free-text category input');
    input.value = 'Build';
    input.dispatch('keydown', { key: 'Enter' });
    await flush();
    assert.strictEqual(popover.style.display, 'none');
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['c1', 'Build']);
    assert.strictEqual(wrapFor(harness, 'c1').querySelector('.terminal-tab-category-chip')?.textContent, 'Build');

    // Clearing a category sends an explicit empty string.
    harness.showCategoryPicker('c1', wrapFor(harness, 'c1'));
    popover.querySelector('.terminal-category-picker-item.clear')?.dispatch('click', {});
    await flush();
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['c1', undefined]);
    assert.strictEqual(wrapFor(harness, 'c1').querySelector('.terminal-tab-category-chip'), null);
  });
});

/**
 * Structural CSS check for the sidebar affinity-badge alignment.
 *
 * The vm harness has no layout engine, so this can only prove the rules exist and
 * are mutually consistent (exactly one `margin-left: auto` per row, a shrinkable
 * name). The PIXEL result — badge flush against the right edge, immediately left
 * of the × — is unverified by test and must be confirmed in the running app.
 */
describe('Sidebar tab row: affinity badge pinned right (CSS structure only)', () => {
  const css = fs.readFileSync(path.join(RENDERER_DIR, 'standalone.css'), 'utf8');

  const ruleBody = (selector: string): string | null => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    return match?.[1] ?? null;
  };

  it('gives the sidebar row exactly one auto margin, on the status beacon', () => {
    const beacon = ruleBody('.standalone.tabs-sidebar .terminal-tab-status-beacon');
    assert.ok(beacon, 'the sidebar beacon rule must exist');
    assert.match(beacon, /margin-left:\s*auto/, 'the beacon carries the row\'s single auto margin');
    assert.match(beacon, /order:\s*1/, 'the beacon is ordered before the badge so the badge is last');

    const badge = ruleBody('.standalone.tabs-sidebar .terminal-tab-affinity-badge');
    assert.ok(badge, 'the sidebar badge rule must exist');
    assert.match(badge, /order:\s*2/);
    assert.doesNotMatch(badge, /margin-left:\s*auto/, 'only one element per row may take the auto margin');
    assert.match(badge, /margin-left:\s*4px/);
  });

  it('leaves the horizontal badge placement untouched', () => {
    const base = ruleBody('.terminal-tab-affinity-badge');
    assert.ok(base, 'the base badge rule must exist');
    assert.match(base, /width:\s*78px/);
    assert.match(base, /flex-shrink:\s*0/);
    assert.doesNotMatch(base, /margin-left:\s*auto/, 'horizontal mode must keep its inline badge slot');
    assert.doesNotMatch(base, /\border\s*:/, 'no `order` may leak into the base rule');
  });

  it('lets the sidebar name shrink so the badge, not the name, is what gets pinned', () => {
    const title = ruleBody('.standalone.tabs-sidebar .terminal-tab-title');
    assert.ok(title, 'the sidebar title rule must exist');
    assert.match(title, /min-width:\s*0/);
    assert.match(title, /text-overflow:\s*ellipsis/);
    assert.doesNotMatch(title, /flex:\s*0\s+0\s+auto/, 'the sidebar name must be allowed to shrink');
  });

  it('keeps the category-count auto margin in a different flex container', () => {
    const count = ruleBody('.standalone.tabs-sidebar .terminal-tab-category-count');
    assert.ok(count, 'the category count rule must still exist');
    assert.match(count, /margin-left:\s*auto/);
    // The count lives inside `.terminal-tab-category-header`, the badge inside
    // `.terminal-tab`, so the two auto margins can never compete for one row.
    assert.notStrictEqual(
      ruleBody('.standalone.tabs-sidebar .terminal-tab-status-beacon'),
      ruleBody('.standalone.tabs-sidebar .terminal-tab-category-count'),
    );
  });
});
