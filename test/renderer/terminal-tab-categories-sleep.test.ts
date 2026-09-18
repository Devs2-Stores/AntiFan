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

/**
 * The strip's tabs bucketed under the header that precedes them. A wrap is a SIBLING of
 * a header, not a child, so membership is positional and has to be read that way.
 */
const buckets = (harness: StandaloneHarness): Record<string, string[]> => {
  const out: Record<string, string[]> = { __top__: [] };
  let key = '__top__';
  const children = harness.tabsRoot.children
    .filter((el) => el.matches('.terminal-tab-category-header') || el.matches('.terminal-tab-wrap'));
  for (const el of children) {
    if (el.matches('.terminal-tab-category-header')) {
      key = el.getAttribute('data-category') ?? '';
      if (!out[key]) out[key] = [];
      continue;
    }
    let list = out[key];
    if (!list) {
      list = [];
      out[key] = list;
    }
    list.push(el.getAttribute('data-session-id') ?? '');
  }
  return out;
};

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

    // The row names the group and nothing more: the tab count badge was removed, so a
    // numeric chip must never creep back into a header. Membership itself is proven by
    // `flattened` above and by the label each header carries.
    const buildHeader = groupHeaders[0];
    assert.ok(buildHeader);
    assert.strictEqual(
      buildHeader.querySelector('.terminal-tab-category-count'),
      null,
      'the header must carry no tab count',
    );
    assert.strictEqual(buildHeader.querySelector('.terminal-tab-category-label')?.textContent, 'Build');
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

    // A header is a category drop target, never a reorder target: a drop on it
    // must leave the session order completely untouched. s3 is already
    // uncategorised and this is the uncategorised header, so this drop is also a
    // category no-op — the assertion is purely about the untouched order.
    const header = headers(harness)[1];
    assert.ok(header);
    assert.strictEqual(header.getAttribute('data-category'), '__uncategorized__');
    header.dispatch('drop', { dataTransfer: dataTransfer('s3') });
    assert.deepStrictEqual(
      sessionIds(harness),
      ['s1', 's2', 's3'],
      'dropping onto a header must never splice the session order',
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

  it('re-groups a tab dropped on a group header, and never reorders it', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
      { id: 's3', name: 'Three', state: 'running' },
    ], 's1');
    harness.renderTabs();

    const findHeader = (key: string): FakeElement => {
      const header = headers(harness).find((el) => el.getAttribute('data-category') === key);
      assert.ok(header, `expected a header for ${key}`);
      return header;
    };
    const buildHeader = findHeader('Build');

    // A dragover with no tab drag in flight must not arm the header, so an
    // unrelated drag (a file, a link) can never become a category drop.
    buildHeader.dispatch('dragover', { dataTransfer: dataTransfer('s3') });
    assert.strictEqual(buildHeader.classList.contains('drag-over'), false);

    wrapFor(harness, 's3').dispatch('dragstart', { dataTransfer: dataTransfer('s3') });
    buildHeader.dispatch('dragover', { dataTransfer: dataTransfer('s3') });
    assert.strictEqual(buildHeader.classList.contains('drag-over'), true, 'a live tab drag arms the header');

    buildHeader.dispatch('drop', { dataTransfer: dataTransfer('s3') });
    assert.strictEqual(buildHeader.classList.contains('drag-over'), false, 'the highlight is cleared');
    assert.strictEqual(harness.getSessions().find((s) => s.id === 's3')?.category, 'Build');
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['s3', 'Build']);
    // Membership moved; the session ORDER did not.
    assert.deepStrictEqual(sessionIds(harness), ['s1', 's2', 's3']);
    assert.deepStrictEqual(
      headers(harness).map((el) => el.getAttribute('data-category')),
      ['Build', '__uncategorized__'],
      'a category drop must never reshuffle the group order either',
    );

    // Re-dropping into the group it already belongs to is inert: that guard is what
    // keeps a stray drop from costing an IPC round-trip and a disk write.
    const writes = countCalls(harness, 'setCategory');
    buildHeader.dispatch('drop', { dataTransfer: dataTransfer('s3') });
    assert.strictEqual(countCalls(harness, 'setCategory'), writes, 're-dropping into the same group is inert');

    // A payload that is not a session id is ignored outright.
    findHeader('Build').dispatch('drop', { dataTransfer: dataTransfer('C:\\tmp\\file.txt') });
    assert.strictEqual(countCalls(harness, 'setCategory'), writes, 'a non-session payload changes nothing');

    // Dropping on the uncategorised header releases the tab back to ungrouped.
    findHeader('__uncategorized__').dispatch('drop', { dataTransfer: dataTransfer('s3') });
    assert.strictEqual(harness.getSessions().find((s) => s.id === 's3')?.category, undefined);
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['s3', undefined]);
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
    assert.match(wrap.querySelector('.terminal-tab-icon')?.innerHTML ?? '', /terminal-tab-sleep-icon/);
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

describe('Renderer sleep preview: a retained capture renders as text, not as escape codes', () => {
  /**
   * The retained buffer is raw PTY output. Rendering it verbatim is what produced a wall
   * of `[0m[0K[?25l` in the preview, so this pins the treatment: the control sequences go,
   * and the words the user actually saw stay.
   */
  const ansiCapture = [
    '\u001b[0m\u001b[0K\u001b[?25l',
    '\u001b[?25hPS E:\\Work\\customizes\\Seahorse2>\u001b[0K\u001b[?25l',
    '\u001b]0;window title\u0007npm run build',
    '\u001b[0K',
    '\u001b[3Jdone in 617ms',
  ].join('\r\n');

  const previewText = (harness: StandaloneHarness): string =>
    harness.sleepPreview()?.querySelector('.terminal-sleep-preview-body')?.textContent ?? '';

  it('drops SGR, erase, cursor and window-title sequences while keeping the text', () => {
    const harness = loadStandalone();
    const list = [{ id: 'sl1', name: 'Sleepy', state: 'sleeping', buffer: ansiCapture }];
    seed(harness, list, 'sl1');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'sl1');

    const body = previewText(harness);
    assert.ok(body.includes('PS E:\\Work\\customizes\\Seahorse2>'), 'the prompt line survives');
    assert.ok(body.includes('npm run build'), 'typed text survives');
    assert.ok(body.includes('done in 617ms'), 'erase-to-end-of-line must not eat the text');
    assert.ok(!body.includes('\u001b'), 'no escape byte may reach the DOM');
    assert.ok(!/\[0m|\[0K|\[\?25|\[3J|\[1G/.test(body), 'no CSI sequence may be shown literally');
    assert.ok(!body.includes('window title'), 'an OSC window title is chrome, not transcript');
  });

  it('resolves a carriage-return overwrite to the last write on that line', () => {
    const harness = loadStandalone();
    const list = [{ id: 'sl2', name: 'Progress', state: 'sleeping', buffer: 'progress 10%\rprogress 100%\n' }];
    seed(harness, list, 'sl2');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'sl2');

    assert.strictEqual(previewText(harness).trim(), 'progress 100%');
  });

  it('explains an empty capture instead of rendering a blank pane', () => {
    const harness = loadStandalone();
    const list = [{ id: 'sl3', name: 'Blank', state: 'sleeping', buffer: '\u001b[0m\u001b[0K\u001b[?25l' }];
    seed(harness, list, 'sl3');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'sl3');

    assert.match(previewText(harness), /Không có nội dung lưu lại/);
  });
});

describe('Renderer group header: reachable and operable from the keyboard', () => {
  it('takes focus and answers Enter and Space the way it answers a click', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 } },
    });
    // The boot payload is applied asynchronously, so the render below must wait for it or
    // it runs under the default layout and no group header exists to test.
    await flush();
    const list = [
      { id: 'k1', name: 'Build', category: 'Build', state: 'running' },
      { id: 'k2', name: 'Deploy', category: 'Deploy', state: 'running' },
    ];
    seed(harness, list, 'k1');
    harness.renderTabs();

    const header = headers(harness)[0];
    assert.ok(header, 'the Build header must render');
    assert.strictEqual(header.getAttribute('role'), 'button');
    assert.strictEqual(header.tabIndex, 0, 'a role="button" nothing can Tab to is unusable');

    header.dispatch('keydown', { key: 'Enter', target: header });
    await flush();
    assert.strictEqual(header.getAttribute('aria-expanded'), 'false', 'Enter collapses');
    assert.strictEqual(wrapFor(harness, 'k1').classList.contains('is-category-collapsed'), true);

    header.dispatch('keydown', { key: ' ', target: header });
    await flush();
    assert.strictEqual(header.getAttribute('aria-expanded'), 'true', 'Space expands again');
  });

  it('does not collapse when Enter was aimed at the rename control inside it', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 } },
    });
    await flush();
    const list = [{ id: 'r1', name: 'Build', category: 'Build', state: 'running' }];
    seed(harness, list, 'r1');
    harness.renderTabs();

    const header = headers(harness)[0];
    assert.ok(header, 'the Build header must render');
    const rename = header.querySelector('.terminal-tab-category-rename');
    assert.ok(rename, 'the rename control must exist');
    // The keydown still bubbles to the header, but a bubbled Enter belongs to the control
    // that has focus, not to the collapse underneath it.
    rename.dispatch('keydown', { key: 'Enter', target: rename });
    await flush();

    assert.strictEqual(header.getAttribute('aria-expanded'), 'true', 'the group must stay open');
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

  it('pins the header right edge with the label own width, not a count', () => {
    const label = ruleBody('.standalone.tabs-sidebar .terminal-tab-category-label');
    assert.ok(label, 'the group label rule must exist');
    assert.match(label, /flex:\s*1\s+1\s+auto/, 'the label takes the free width, which is what keeps its controls right');
    assert.match(label, /min-width:\s*0/);
    assert.match(label, /text-overflow:\s*ellipsis/, 'a long name ellipsises rather than pushing its own controls out');
    // The right-edge auto margin belongs to the TAB row's beacon; the header pins its own
    // edge with the label's flex. One auto margin per row, or the two would fight.
    const beacon = ruleBody('.standalone.tabs-sidebar .terminal-tab-status-beacon');
    assert.ok(beacon, 'the status beacon rule must still exist');
    assert.match(beacon, /margin-left:\s*auto/);
  });
});

describe('Renderer group management: create and rename as their own operations', () => {
  const headerKeys = (harness: StandaloneHarness): (string | null)[] =>
    headers(harness).map((el) => el.getAttribute('data-category'));

  /**
   * The shared name popover. Selected by id, not by its styling class: the harness
   * creates this node with `new FakeElement('div', id)`, so it carries no class.
   */
  const popover = (harness: StandaloneHarness): FakeElement => {
    const el = harness.queryAll('#categoryPickerPopover')[0];
    assert.ok(el, 'the shared name popover must exist');
    return el;
  };

  /** Type a name into the open popover and commit it with Enter. */
  const submitName = (harness: StandaloneHarness, value: string): void => {
    const input = popover(harness).querySelector('.terminal-category-picker-input');
    assert.ok(input, 'the popover must own a name input');
    input.value = value;
    input.dispatch('keydown', { key: 'Enter' });
  };

  /**
   * The renderer's live group list as a plain host-realm array. `terminalCategories`
   * lives inside the vm context, so `assert.deepStrictEqual` rejects it as "same
   * structure but not reference-equal" unless the realm is normalized.
   */
  const categories = (harness: StandaloneHarness): string[] =>
    Array.from(harness.read<string[]>('terminalCategories'));

  const persistedCategories = (harness: StandaloneHarness): string[] | undefined => {
    const value = (lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { categories?: string[] } | undefined)?.categories;
    return Array.isArray(value) ? Array.from(value) : undefined;
  };

  it('creates an empty group from a strip control, without touching any tab', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'One', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
    ], 's1');
    harness.renderTabs();

    // The control is a sibling of "+ Terminal" on the strip — not a tab context menu,
    // which is the whole point: creating a group is its own operation.
    const button = harness.tabsRoot.querySelector('.terminal-tab-new-category');
    assert.ok(button, 'the strip must offer a dedicated new-group control');
    // Icon-only, so its accessible name is what identifies it.
    assert.match(button.getAttribute('aria-label') ?? '', /nhóm/i);
    assert.match(button.innerHTML, /<svg/);
    assert.deepStrictEqual(headerKeys(harness), ['__uncategorized__'], 'nothing exists yet');

    button.dispatch('click');
    await flush();
    assert.strictEqual(popover(harness).style.display, 'block', 'the name popover opens');

    submitName(harness, 'Khách hàng');
    await flush();

    // An empty group is real: it has a header, holds no tabs of its own (its wraps are
    // siblings, never children), and survives a restart while empty.
    assert.deepStrictEqual(headerKeys(harness), ['Khách hàng', '__uncategorized__']);
    assert.deepStrictEqual(buckets(harness)['Khách hàng'], [], 'an empty group reports no tabs');
    assert.strictEqual(
      headers(harness)
        .find((el) => el.getAttribute('data-category') === 'Khách hàng')
        ?.querySelectorAll('.terminal-tab-wrap').length,
      0,
    );
    // Registered and persisted, which is what lets it survive a restart while empty.
    assert.deepStrictEqual(categories(harness), ['Khách hàng']);
    assert.deepStrictEqual(persistedCategories(harness), ['Khách hàng']);
  });

  it('ignores a duplicate name and an empty submit instead of forking a header', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', state: 'running' }], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.renderTabs();

    const button = harness.tabsRoot.querySelector('.terminal-tab-new-category');
    assert.ok(button);

    // Case-insensitive duplicate: one header, never two.
    button.dispatch('click');
    await flush();
    submitName(harness, 'build');
    await flush();
    assert.deepStrictEqual(categories(harness), ['Build']);
    assert.deepStrictEqual(headerKeys(harness), ['Build', '__uncategorized__']);

    // A blank submit is refused outright.
    button.dispatch('click');
    await flush();
    submitName(harness, '   ');
    await flush();
    assert.deepStrictEqual(categories(harness), ['Build']);
  });

  it('renames a group from its own header and moves every tab with it', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', category: 'Build', state: 'running' },
      { id: 's3', name: 'Three', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.renderTabs();

    const rename = headers(harness)
      .find((el) => el.getAttribute('data-category') === 'Build')
      ?.querySelector('.terminal-tab-category-rename');
    assert.ok(rename, 'a real group header must offer rename');
    rename.dispatch('click');
    await flush();

    const input = popover(harness).querySelector('.terminal-category-picker-input');
    assert.ok(input);
    assert.strictEqual(input.value, 'Build', 'the popover starts from the current name');

    submitName(harness, 'Xây dựng');
    await flush();

    // The rename follows on the registry and on every tab that was filed under it,
    // so renaming can never silently empty a group.
    assert.deepStrictEqual(categories(harness), ['Xây dựng']);
    assert.deepStrictEqual(
      Array.from(harness.getSessions(), (s) => s.category),
      ['Xây dựng', 'Xây dựng', undefined],
    );
    assert.deepStrictEqual(headerKeys(harness), ['Xây dựng', '__uncategorized__']);
    assert.deepStrictEqual(buckets(harness)['Xây dựng'], ['s1', 's2'], 'the renamed group keeps both of its tabs');
    assert.deepStrictEqual(
      harness.apiCallArgs.filter((e) => e.name === 'setCategory').map((e) => e.args),
      [['s1', 'Xây dựng'], ['s2', 'Xây dựng']],
    );
    assert.deepStrictEqual(persistedCategories(harness), ['Xây dựng']);
  });

  it('renaming never also toggles the collapse it sits inside', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', category: 'Build', state: 'running' }], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.renderTabs();

    const header = headers(harness).find((el) => el.getAttribute('data-category') === 'Build');
    assert.ok(header);
    const rename = header.querySelector('.terminal-tab-category-rename');
    assert.ok(rename);
    // The control stops propagation, so the header's own click-to-collapse must not run.
    rename.dispatch('click');
    await flush();
    assert.strictEqual(header.getAttribute('aria-expanded'), 'true', 'the group stays expanded');
    assert.strictEqual(popover(harness).style.display, 'block');
  });

  it('deletes a group when the new name is left empty, releasing its tabs', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', category: 'Deploy', state: 'running' }], 's1');
    harness.assign("applyCategories(['Deploy'])");
    harness.renderTabs();

    const rename = headers(harness)[0]?.querySelector('.terminal-tab-category-rename');
    assert.ok(rename);
    rename.dispatch('click');
    await flush();
    submitName(harness, '');
    await flush();

    assert.deepStrictEqual(categories(harness), []);
    assert.deepStrictEqual(Array.from(harness.getSessions(), (s) => s.category), [undefined]);
    assert.deepStrictEqual(headerKeys(harness), ['__uncategorized__'], 'the group is gone');
  });

  it('makes the persisted group list, not first appearance, the header order', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'One', category: 'Alpha', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Zeta', 'Alpha'])");
    harness.renderTabs();

    assert.deepStrictEqual(
      headerKeys(harness),
      ['Zeta', 'Alpha', '__uncategorized__'],
      'the user-created order wins, and an empty group still keeps its slot',
    );
    assert.deepStrictEqual(buckets(harness)['Zeta'], [], 'Zeta holds no tab, yet still has a header');
    assert.deepStrictEqual(buckets(harness)['Alpha'], ['s1']);
  });

  it('offers no rename on the uncategorised bucket, which is not a real group', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', state: 'running' }], 's1');
    harness.renderTabs();

    const uncat = headers(harness).find((el) => el.getAttribute('data-category') === '__uncategorized__');
    assert.ok(uncat);
    assert.strictEqual(uncat.querySelector('.terminal-tab-category-rename'), null);
  });

  it('registers a name typed into a tab\'s picker as a durable group too', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', state: 'running' }], 's1');
    harness.renderTabs();
    assert.deepStrictEqual(categories(harness), []);

    harness.assign("applyCategoryToSession('s1', 'Billing', null)");
    await flush();

    // A group created from a tab is still a group: it outlives that tab.
    assert.deepStrictEqual(categories(harness), ['Billing']);
    assert.deepStrictEqual(persistedCategories(harness), ['Billing']);
  });
});

describe('Renderer split panes follow the tab that owns them', () => {
  const headerKeys = (harness: StandaloneHarness): (string | null)[] =>
    headers(harness).map((el) => el.getAttribute('data-category'));

  const menuEvent = () => ({
    key: '',
    clientX: 10,
    clientY: 10,
    preventDefault: () => {},
    stopPropagation: () => {},
  });

  it('files a pane under its parent group, directly under its parent', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    // Main creates a pane with no category of its own; the tab it splits is in a group.
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
      { id: 's3', name: 'Loose', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['Build', '__uncategorized__'],
      'a pane must not fork a group of its own');
    assert.deepStrictEqual(buckets(harness)['Build'], ['s1', 's2'],
      'the pane sits in the parent group, directly under the tab it splits');
    assert.deepStrictEqual(buckets(harness)['__uncategorized__'], ['s3']);
    assert.strictEqual(wrapFor(harness, 's2').classList.contains('is-split-pane'), true);
  });

  it('takes the pane along when the parent is dragged into another group', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build', 'Deploy'])");
    harness.renderTabs();

    const deploy = headers(harness).find((el) => el.getAttribute('data-category') === 'Deploy');
    assert.ok(deploy);
    wrapFor(harness, 's1').dispatch('dragstart', { dataTransfer: dataTransfer('s1') });
    deploy.dispatch('dragover', { dataTransfer: dataTransfer('s1') });
    deploy.dispatch('drop', { dataTransfer: dataTransfer('s1') });
    await flush();

    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['s1', 'Deploy'], 'the parent is what moves');
    assert.deepStrictEqual(buckets(harness)['Deploy'], ['s1', 's2'],
      'the pane follows its parent into the new group instead of staying behind');
    assert.deepStrictEqual(buckets(harness)['Build'], [], 'nothing is left in the old group');
  });

  it('moves by the parent alone: a pane row is not a drag source', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build', 'Deploy'])");
    harness.renderTabs();

    // A drag a later render would undo is not an affordance: the parent's row is the
    // handle for the family, so the pane refuses to start a drag at all.
    assert.strictEqual(wrapFor(harness, 's2').draggable, false, 'a pane must not drag on its own');
    assert.strictEqual(wrapFor(harness, 's1').draggable, true, 'the owning tab still reorders');
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), undefined, 'nothing was written by the render');
  });

  it('resolves the category picker on a pane to the tab that owns it', async () => {
    const harness = loadStandalone({ contextMenuActions: ['category'] });
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.renderTabs();

    harness.showContextMenu(menuEvent(), 's2');
    const categoryItem = harness.contextMenu.querySelector('.context-item[data-action="category"]');
    assert.ok(categoryItem, 'the menu offers the category action');
    categoryItem.dispatch('click');
    await flush();

    const popover = harness.queryAll('#categoryPickerPopover')[0];
    assert.ok(popover, 'the shared name popover must exist');
    const input = popover.querySelector('.terminal-category-picker-input');
    assert.ok(input);
    assert.strictEqual(input.value, 'Build', 'the picker starts from the group of the owning tab');

    input.value = 'Deploy';
    input.dispatch('keydown', { key: 'Enter' });
    await flush();

    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['s1', 'Deploy'],
      'the write lands on the parent, so the pane can never be filed away from it');
    assert.deepStrictEqual(buckets(harness)['Deploy'], ['s1', 's2']);
  });
});

describe('Renderer sleeping bucket: parked, and returned to its own group', () => {
  const headerKeys = (harness: StandaloneHarness): (string | null)[] =>
    headers(harness).map((el) => el.getAttribute('data-category'));

  const headerFor = (harness: StandaloneHarness, key: string): FakeElement => {
    const found = headers(harness).find((el) => el.getAttribute('data-category') === key);
    assert.ok(found, `expected a header for ${key}`);
    return found;
  };

  it('parks a sleeping tab in its own bucket instead of inside its group', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Live', category: 'Build', state: 'running' },
      { id: 's2', name: 'Asleep', category: 'Build', state: 'sleeping' },
    ], 's1');
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['Build', '__sleeping__'],
      'an asleep tab leaves its group for the sleep bucket');
    assert.deepStrictEqual(buckets(harness)['Build'], ['s1'], 'the group keeps only its live tab');
    assert.deepStrictEqual(buckets(harness)['__sleeping__'], ['s2'], 'the asleep tab is parked under the bucket');
  });
 
  it('hides a sleeping split pane instead of leaking it into the parked bucket', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Parent', category: 'Build', state: 'running' },
      { id: 's2', name: 'Parent split-1', splitOf: 's1', state: 'sleeping' },
    ], 's1');
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['Build'],
      'a sleeping split must not create a separate parked bucket row');
    assert.deepStrictEqual(buckets(harness)['Build'], ['s1']);
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="s2"]'),
      null,
      'the sleeping split row must be removed from the sidebar',
    );
  });

  it('parks a pane row with a parent that is already asleep, never into another group', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    // The pane's own record has not flipped yet — this is the broadcast window where the
    // parent is already parked. The pane inherits its group from that parent, so without
    // the park-with-parent rule the row is filed by its own (absent) category and shows up
    // in "Chưa phân nhóm" as a tab the user never opened.
    seed(harness, [
      { id: 's1', name: 'Hapas', state: 'sleeping' },
      { id: 's2', name: 'Terminal split-2', splitOf: 's1', state: 'running' },
    ], 's1');
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['__sleeping__'],
      'the pane must not create a group of its own beside the parked parent');
    assert.deepStrictEqual(buckets(harness)['__sleeping__'], ['s1'], 'only the parent keeps a parked row');
    assert.strictEqual(buckets(harness)['__uncategorized__'], undefined, 'no leaked pane row');
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="s2"]'),
      null,
      'a pane whose parent is parked has no row of its own',
    );
  });

  it('keeps the affinity badge on the tab that owns the pane, never on a pane row', async () => {
    const harness = loadStandalone({ contextMenuActions: ['rebind-tab'] });
    await flush();
    seed(harness, [
      { id: 'p1', name: 'Parent', state: 'running' },
      { id: 'p2', name: 'Terminal split-1', splitOf: 'p1', state: 'running' },
    ], 'p1');
    harness.renderTabs();

    const ownerBadge = wrapFor(harness, 'p1').querySelector('.terminal-tab-affinity-badge');
    assert.ok(ownerBadge, 'the owning tab keeps its affinity badge');
    assert.strictEqual(ownerBadge.getAttribute('data-session-id'), 'p1');
    assert.strictEqual(
      wrapFor(harness, 'p2').querySelector('.terminal-tab-affinity-badge'),
      null,
      'a pane row offers no binding: its shell reports the parent session id',
    );

    // The right-click path still reaches the picker, for the parent.
    const menuEvent = {
      key: '', clientX: 10, clientY: 10, preventDefault: () => {}, stopPropagation: () => {},
    };
    harness.showContextMenu(menuEvent, 'p2');
    const rebind = harness.contextMenu.querySelector('.context-item[data-action="rebind-tab"]');
    assert.ok(rebind, 'the pane row still offers the affinity action');
    rebind.dispatch('click', {});
    await flush();
    assert.strictEqual(
      harness.elements.get('affinityPickerPopover')?.getAttribute('data-active-session-id'),
      'p1',
      'the pane rebinds the tab it splits, not itself',
    );
  });

  it('returns a woken tab to its own group, because sleep never rewrote its category', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Live', category: 'Build', state: 'running' },
      { id: 's2', name: 'Asher', category: 'Deploy', state: 'sleeping' },
    ], 's1');
    // Both groups are registered, so each keeps its slot even while its only tab sleeps.
    harness.assign("applyCategories(['Build', 'Deploy'])");
    harness.renderTabs();
    assert.deepStrictEqual(headerKeys(harness), ['Build', 'Deploy', '__sleeping__']);

    // Main reports the very same session awake again: same record, new state.
    harness.assign(
      "sessions = sessions.map((s) => (s.id === 's2' ? Object.assign({}, s, { state: 'running' }) : s))",
    );
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['Build', 'Deploy'],
      'the bucket disappears with its last tenant');
    assert.deepStrictEqual(buckets(harness)['Deploy'], ['s2'],
      'the wake returns the tab to its own group, not to the catch-all');
    assert.strictEqual(harness.getSessions().find((s) => s.id === 's2')?.category, 'Deploy');
    assert.strictEqual(countCalls(harness, 'setCategory'), 0,
      'parking and waking are a display concern and must never rewrite a category');
  });

  it('offers no rename on the sleep bucket and never arms it as a drop target', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Live', category: 'Build', state: 'running' },
      { id: 's2', name: 'Asleep', state: 'sleeping' },
    ], 's1');
    harness.renderTabs();

    const sleeping = headerFor(harness, '__sleeping__');
    assert.strictEqual(sleeping.querySelector('.terminal-tab-category-rename'), null,
      'a state is not a name, so there is nothing to rename');

    wrapFor(harness, 's1').dispatch('dragstart', { dataTransfer: dataTransfer('s1') });
    sleeping.dispatch('dragover', { dataTransfer: dataTransfer('s1') });
    assert.strictEqual(sleeping.classList.contains('drag-over'), false,
      'a state bucket must never be armed as a drop target');
    sleeping.dispatch('drop', { dataTransfer: dataTransfer('s1') });
    assert.strictEqual(countCalls(harness, 'setCategory'), 0, 'no drag can file a tab under a state');
  });

  it('refuses to bind a browser tab to a sleeping terminal at all', async () => {
    const harness = loadStandalone();
    await flush();
    seed(harness, [{ id: 's1', name: 'Asleep', state: 'sleeping' }], 's1');
    harness.renderTabs();
    harness.apiCalls.length = 0;

    // A sleeping session has no PTY, so a binding could never be honoured: the picker
    // must not even start down that path.
    await harness.showAffinityPicker('s1', wrapFor(harness, 's1'));
    assert.strictEqual(countCalls(harness, 'getTabs'), 0,
      'the picker must not fetch tabs for a sleeping session');
    assert.strictEqual(countCalls(harness, 'setTerminalAffinity'), 0);
  });
});

describe('Renderer smart tab search', () => {
  const visibleIds = (harness: StandaloneHarness): string[] =>
    harness.queryAll('.terminal-tab-wrap').map((el) => el.getAttribute('data-session-id') ?? '');

  const search = (harness: StandaloneHarness, query: string): void => {
    harness.assign(`setTabSearchQuery(${JSON.stringify(query)})`);
  };

  const seedThree = (harness: StandaloneHarness): void => {
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Seahorse2', cwd: 'E:\\Work\\customizes\\Seahorse2', category: 'Customizes', state: 'running' },
      { id: 's2', name: 'Uncommon', cwd: 'E:\\Work\\apps\\Uncommon', category: 'APPS', state: 'running' },
      { id: 's3', name: 'Cấu hình', cwd: 'E:\\Work\\don-hang', category: 'APPS', state: 'running' },
    ], 's1');
    harness.renderTabs();
  };

  it('filters by name, folder and group, and drops a group with no surviving tab', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);
    assert.strictEqual(visibleIds(harness).length, 3);

    search(harness, 'seahorse');
    assert.deepStrictEqual(visibleIds(harness), ['s1'], 'the name is searchable');
    assert.deepStrictEqual(
      headers(harness).map((el) => el.getAttribute('data-category')),
      ['Customizes'],
      'a group whose every tab was filtered out drops out of the filtered view',
    );

    search(harness, 'apps');
    assert.deepStrictEqual(visibleIds(harness), ['s2', 's3'], 'the group name is searchable too');

    search(harness, 'work\\apps');
    assert.deepStrictEqual(visibleIds(harness), ['s2'], 'the folder is searchable too');
  });

  it('matches accent-insensitively and fuzzily, but keeps short tokens literal', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);

    search(harness, 'cau hinh');
    assert.deepStrictEqual(visibleIds(harness), ['s3'], 'unaccented input must find an accented name');

    search(harness, 'don hang');
    assert.deepStrictEqual(visibleIds(harness), ['s3'], 'a folder query folds accents the same way');

    search(harness, 'sh2');
    assert.deepStrictEqual(visibleIds(harness), ['s1'], 'a 3+ character subsequence matches fuzzily');

    search(harness, 'sr');
    assert.deepStrictEqual(visibleIds(harness), [],
      'a 2-character token stays literal, so it cannot fuzzy-match its way across the strip');
  });

  it('requires every token to match, and explains an empty result', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);

    // "seahorse" and "uncommon" live in different sessions, so an AND query is empty.
    search(harness, 'seahorse uncommon');
    assert.deepStrictEqual(visibleIds(harness), [], 'a second word must narrow, never widen');
    assert.deepStrictEqual(headers(harness), [], 'no group survives, so no header is rendered');

    const empty = harness.queryAll('.terminal-tab-search-empty')[0];
    assert.ok(empty, 'an empty result must explain itself rather than look blank');
    assert.match(empty.textContent, /seahorse uncommon/);

    search(harness, '');
    assert.strictEqual(harness.queryAll('.terminal-tab-search-empty').length, 0, 'clearing removes the notice');
    assert.strictEqual(visibleIds(harness).length, 3, 'and restores every tab');
  });

  it('filters without ever reordering the tabs or the groups', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);
    const before = visibleIds(harness);
    const groupsBefore = headers(harness).map((el) => el.getAttribute('data-category'));

    search(harness, 'uncommon');
    assert.deepStrictEqual(visibleIds(harness), ['s2'], 'only the match renders');
    search(harness, '');
    assert.deepStrictEqual(visibleIds(harness), before, 'a filter hides; clearing restores the exact order');
    assert.deepStrictEqual(
      headers(harness).map((el) => el.getAttribute('data-category')),
      groupsBefore,
      'and it must never reshuffle the group order either',
    );
  });

  it('shows a collapsed group open while filtering, then restores its collapsed state', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);
    const apps = (): FakeElement => {
      const found = headers(harness).find((el) => el.getAttribute('data-category') === 'APPS');
      assert.ok(found);
      return found;
    };

    apps().dispatch('click', {});
    harness.renderTabs();
    assert.strictEqual(apps().getAttribute('aria-expanded'), 'false');

    // Hiding the match inside a collapsed group would read as a failed search.
    search(harness, 'uncommon');
    assert.strictEqual(apps().getAttribute('aria-expanded'), 'true', 'a filtered group is shown open');
    assert.deepStrictEqual(visibleIds(harness), ['s2']);

    search(harness, '');
    assert.strictEqual(apps().getAttribute('aria-expanded'), 'false',
      'clearing the filter restores the user\'s own collapsed state');
  });

  it('pins the header row first, with search leading and both create actions in it', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);

    const toolbar = harness.tabsRoot.firstChild;
    assert.ok(toolbar, 'the strip must start with a header row');
    assert.ok(toolbar.matches('.terminal-tab-toolbar'), 'and it must be the toolbar');
    assert.strictEqual(toolbar.firstChild, toolbar.querySelector('.terminal-tab-search'),
      'the smart search field leads the row');
    assert.ok(toolbar.querySelector('#btnNewTerminal'), 'the new-terminal action moved into the row');
    assert.ok(toolbar.querySelector('.terminal-tab-new-category'), 'and the new-group action sits beside it');

    // A tab drag reorders tabs; it must never be able to move the row.
    wrapFor(harness, 's3').dispatch('dragstart', { dataTransfer: dataTransfer('s3') });
    wrapFor(harness, 's3').dispatch('dragend', {});
    harness.renderTabs();
    assert.strictEqual(harness.tabsRoot.firstChild, toolbar, 'the row stays pinned across renders');
  });
});
