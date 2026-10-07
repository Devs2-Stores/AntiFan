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
 *   2. The sidebar is one flat list now — the legacy category axis is retired, so
 *      reordering resolves both ends by SESSION ID, never by raw DOM position.
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
 * The strip drags with POINTER events, not HTML5 drag & drop. `f4d90277` replaced the
 * HTML5 path because Windows routes it through OLE / DirectUI (DUI70.dll) and it
 * null-deref'd the process while a tab was dragged onto a group. A wrap is therefore
 * never `draggable` and carries no `dragstart`/`drop` listener of its own; the gesture is
 * a pointerdown on the source row, a move past the 4px threshold, then a pointerup over
 * whatever the cursor resolves to. Only a category HEADER still answers an HTML5 `drop`,
 * because an external drag (a file) is the one payload the strip does not originate.
 */
const POINTER_ID = 7;

const pressRow = (harness: StandaloneHarness, row: FakeElement): void => {
  row.dispatch('pointerdown', { button: 0, pointerId: POINTER_ID, clientX: 100, clientY: 100 });
};

/** A move only becomes a drag past 4px — the strip compares squared distance to 16. */
const dragRowOver = (harness: StandaloneHarness, over: FakeElement | null): void => {
  harness.setElementFromPoint(over);
  harness.dispatchWindowPointer('pointermove', { pointerId: POINTER_ID, clientX: 140, clientY: 140 });
};

const releaseOver = (harness: StandaloneHarness, over: FakeElement | null): void => {
  harness.setElementFromPoint(over);
  harness.dispatchWindowPointer('pointerup', { pointerId: POINTER_ID, clientX: 140, clientY: 140 });
};

/** The whole gesture: press the row owning `sessionId`, drag it, release over `over`. */
const dragRowOnto = (harness: StandaloneHarness, sessionId: string, over: FakeElement | null): void => {
  pressRow(harness, wrapFor(harness, sessionId));
  dragRowOver(harness, over);
  releaseOver(harness, over);
};

/**
 * The strip's tabs bucketed under the header that precedes them. A wrap is a SIBLING of
 * a header, not a child, so membership is positional and has to be read that way. With
 * the category axis retired the only header left in a plain shell is the sleep bucket,
 * so awake rows land under `__top__` and parked rows under `__sleeping__`.
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
  it('renders the sidebar as one flat list — categorised rows get no header and no chip', async () => {
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
    harness.assign("applyCategories(['Build', 'Deploy'])");
    harness.renderTabs();

    // The legacy classification is retired: a stored category on the row — and even a
    // registered name in `terminalCategories` — can no longer paint a header.
    assert.strictEqual(headers(harness).length, 0, 'the retired category axis must render no header');
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="category"]').length,
      0,
      'no legacy classification header may appear',
    );
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip').length,
      0,
      'a non-manager row never carries a category chip',
    );
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-rename').length,
      0,
      'with no group headers there is no rename affordance left',
    );

    // The DOM order is the session order, verbatim — nothing groups or re-files a row.
    const flattened = harness.tabsRoot.children
      .filter((el) => el.matches('.terminal-tab-category-header') || el.matches('.terminal-tab-wrap'))
      .map((el) => el.getAttribute('data-category') ?? el.getAttribute('data-session-id'));
    assert.deepStrictEqual(flattened, ['s1', 's2', 's3', 's4']);

    // The stored field survives untouched: retirement is a display concern only.
    assert.deepStrictEqual(
      Array.from(harness.getSessions(), (s) => s.category),
      ['Build', undefined, 'Build', 'Deploy'],
      'rendering never rewrites the stored category',
    );
  });

  it('ignores persisted collapsed categories, so a stale collapse can never hide rows', async () => {
    const harness = loadStandalone({
      // A prefs payload from before the retirement may still carry names — including
      // the catch-all key itself. None of them may collapse the flat list.
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240, collapsedCategories: ['Build', '__uncategorized__'] } },
    });
    await flush();
    seed(harness, [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', category: 'Build', state: 'running' },
      { id: 's3', name: 'Three', state: 'sleeping', buffer: 'zzz' },
    ], 's1');
    harness.renderTabs();

    assert.deepStrictEqual(
      headers(harness).map((el) => el.getAttribute('data-category')),
      ['__sleeping__'],
      'the only remaining bucket header is the sleep state, not a stored name',
    );
    for (const id of ['s1', 's2', 's3']) {
      assert.strictEqual(
        wrapFor(harness, id).classList.contains('is-category-collapsed'),
        false,
        `a stale collapsedCategories entry must not hide ${id}`,
      );
    }

    // The sleep bucket is still a real bucket: its own collapse gesture works, hides the
    // parked row only, and persists the set once — the stale names are never elided.
    const sleepingHeader = () => {
      // The sweep recreates the bucket header every render, so it must be re-queried.
      const found = headers(harness).find((el) => el.getAttribute('data-category') === '__sleeping__');
      assert.ok(found, 'the sleep bucket header renders');
      return found;
    };
    sleepingHeader().dispatch('click', {});
    await flush();

    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 1, 'a collapse must persist exactly once');
    const payload = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
    assert.deepStrictEqual(plain(payload?.collapsedCategories).sort(), ['Build', '__sleeping__', '__uncategorized__']);
    assert.strictEqual(wrapFor(harness, 's3').classList.contains('is-category-collapsed'), true, 'the parked row collapses');
    assert.strictEqual(wrapFor(harness, 's1').classList.contains('is-category-collapsed'), false, 'flat rows never collapse');
    assert.strictEqual(sleepingHeader().getAttribute('aria-expanded'), 'false');

    // Expanding again restores the row and persists the set with the bucket removed.
    sleepingHeader().dispatch('click', {});
    await flush();
    assert.strictEqual(wrapFor(harness, 's3').classList.contains('is-category-collapsed'), false);
    const restored = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
    assert.deepStrictEqual(plain(restored?.collapsedCategories).sort(), ['Build', '__uncategorized__']);
  });

  it('ignores the persisted collapsed categories on boot', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240, collapsedCategories: ['Build'] } },
    });
    await flush();
    seed(harness, [{ id: 'b1', name: 'Build', category: 'Build', state: 'running' }], 'b1');
    harness.renderTabs();

    assert.strictEqual(wrapFor(harness, 'b1').classList.contains('is-category-collapsed'), false);
    assert.strictEqual(headers(harness).length, 0, 'a stored name must never boot a header back into existence');
    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 0, 'a render must never write prefs');
  });

  it('paints no category chrome at all — no chips in the strip, no headers in the sidebar', async () => {
    const harness = loadStandalone();
    await flush();
    const list = [
      { id: 'h1', name: 'A', category: 'Build', state: 'running' },
      { id: 'h2', name: 'B', state: 'running' },
      { id: 'h3', name: 'C', category: 'Deploy', state: 'running' },
    ];
    seed(harness, list, 'h1');
    harness.renderTabs();

    assert.strictEqual(headers(harness).length, 0, 'headers are gone in every layout');
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip').length,
      0,
      'a stored category must not paint a chip in the horizontal strip',
    );

    // A re-render cannot bring the retired chrome back.
    harness.renderTabs();
    assert.strictEqual(harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip').length, 0);

    // Switching to the sidebar stays flat too — no header per category, no catch-all header.
    harness.assign("applyTerminalTabLayout('sidebar')");
    assert.strictEqual(headers(harness).length, 0, 'the sidebar renders a flat list, not a header per category');
    assert.strictEqual(harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip').length, 0);
  });

  it('reorders tabs by session id, and a drop onto the sleep bucket moves nothing', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    const list = [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
      { id: 's3', name: 'Three', state: 'sleeping', buffer: 'zzz' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    // The only header left is the sleep bucket. A drop on it is a state write that does
    // not exist, so the gesture is inert: no reorder, no category write.
    const sleepHeader = headers(harness).find((el) => el.getAttribute('data-category') === '__sleeping__');
    assert.ok(sleepHeader, 'the sleep bucket header renders');
    dragRowOnto(harness, 's2', sleepHeader);
    assert.deepStrictEqual(sessionIds(harness), ['s1', 's2', 's3'], 'a bucket drop must never splice the session order');
    assert.strictEqual(countCalls(harness, 'setCategory'), 0, 'a state bucket is not a category target');
    assert.strictEqual(countCalls(harness, 'reorderTerminals'), 0);

    // Dropping onto a tab resolves both ends by session id, not by DOM index.
    dragRowOnto(harness, 's2', wrapFor(harness, 's1'));
    assert.deepStrictEqual(sessionIds(harness), ['s2', 's1', 's3']);
    assert.deepStrictEqual(plain(lastArgs(harness, 'reorderTerminals')?.[0] as string[] | undefined), ['s2', 's1', 's3']);

    // The drop still adopts the target's stored category: the field exists even though
    // nothing renders it, and the re-render keeps the flat session order.
    assert.strictEqual(harness.getSessions().find((s) => s.id === 's2')?.category, 'Build');
    const flattened = harness.tabsRoot.children
      .filter((el) => el.matches('.terminal-tab-category-header') || el.matches('.terminal-tab-wrap'))
      .map((el) => el.getAttribute('data-category') ?? el.getAttribute('data-session-id'));
    assert.deepStrictEqual(flattened, ['s2', 's1', '__sleeping__', 's3']);
    assert.deepStrictEqual(
      headers(harness).map((header) => header.getAttribute('data-category')),
      ['__sleeping__'],
      'a reorder can never mint a category header',
    );
  });

  it('refuses the sleep bucket as a category drop target — the release is inert', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'One', category: 'Build', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
      { id: 's3', name: 'Asleep', state: 'sleeping', buffer: 'zzz' },
    ], 's1');
    harness.renderTabs();

    // The sweep recreates the bucket header every render, so it must be re-queried
    // rather than held across gestures.
    const sleepHeader = () => {
      const found = headers(harness).find((el) => el.getAttribute('data-category') === '__sleeping__');
      assert.ok(found, 'the sleep bucket header renders');
      return found;
    };

    // A move with no tab drag in flight must not light the header up: the highlight is
    // drag feedback, not ambient hover chrome.
    harness.setElementFromPoint(sleepHeader());
    harness.dispatchWindowPointer('pointermove', { pointerId: POINTER_ID, clientX: 140, clientY: 140 });
    assert.strictEqual(sleepHeader().classList.contains('drag-over'), false);

    // Releasing over the bucket is refused by the drop itself: a state is not a
    // category, so nothing is written and the order is untouched.
    dragRowOnto(harness, 's2', sleepHeader());
    assert.strictEqual(sleepHeader().classList.contains('drag-over'), false, 'the highlight is cleared after the drop');
    assert.strictEqual(countCalls(harness, 'setCategory'), 0, 'dropping onto a state bucket must never file a category');
    assert.deepStrictEqual(sessionIds(harness), ['s1', 's2', 's3'], 'the refused drop moves nothing');
    assert.strictEqual(countCalls(harness, 'reorderTerminals'), 0);
    assert.strictEqual(harness.getSessions().find((s) => s.id === 's2')?.category, undefined);

    // A payload that is not a session id is ignored outright.
    sleepHeader().dispatch('drop', { dataTransfer: dataTransfer('C:\\tmp\\file.txt') });
    assert.strictEqual(countCalls(harness, 'setCategory'), 0, 'a non-session payload changes nothing');
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

describe('Renderer tab context-menu actions', () => {
  it('wires sleep, wake and the category picker, and refuses impossible actions', async () => {
    const harness = loadStandalone({
      // `assign-capsule` is the tab→project handover: its item must exist for the menu to offer
      // the move, and the picker it opens is driven in terminal-capsule-picker.test.ts.
      contextMenuActions: ['sleep', 'wake', 'category', 'assign-capsule', 'close'],
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
    assert.strictEqual(harness.getSessions().find((s) => s.id === 'c1')?.category, 'Build',
      'the picker writes the stored field');
    assert.strictEqual(
      wrapFor(harness, 'c1').querySelector('.terminal-tab-category-chip'),
      null,
      'a stored category paints no chip — the axis is retired',
    );

    // Clearing a category sends an explicit empty string.
    harness.showCategoryPicker('c1', wrapFor(harness, 'c1'));
    popover.querySelector('.terminal-category-picker-item.clear')?.dispatch('click', {});
    await flush();
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), ['c1', undefined]);
    assert.strictEqual(harness.getSessions().find((s) => s.id === 'c1')?.category, undefined);
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
  it('collapses a spinner redraw run into one counted line', () => {
    // The lag this pins down: a slept TUI tab captured tens of thousands of identical
    // "Working…" status lines, and the preview stuffed all of them into one <pre>.
    const harness = loadStandalone();
    const spinnerRun = Array.from({ length: 5000 }, () => '⠋ Working…');
    const buffer = [...spinnerRun, 'final line'].join('\n');
    const list = [{ id: 'sl4', name: 'Spinner', state: 'sleeping', buffer }];
    seed(harness, list, 'sl4');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'sl4');

    const body = previewText(harness);
    assert.match(body, /⠋ Working…\n\s+↳ lặp lại ×5000/, 'one spinner run collapses to a counted line');
    assert.ok(body.includes('final line'), 'the line after the run survives');
    assert.strictEqual(body.split('⠋ Working…').length - 1, 1, 'the run renders once, not 5000 times');
  });

  it('caps the body at the last 2000 lines and states the omission', () => {
    const harness = loadStandalone();
    const uniqueTail = Array.from({ length: 3000 }, (_, i) => `unique-line-${i}`);
    const list = [{ id: 'sl5', name: 'Long', state: 'sleeping', buffer: uniqueTail.join('\n') }];
    seed(harness, list, 'sl5');
    harness.renderTabs();
    harness.syncTerminalPool(list, 'sl5');

    const body = previewText(harness);
    assert.strictEqual(body.split('unique-line-').length - 1, 2000, 'the body is capped at the last 2000 lines');
    assert.match(body, /đã lược 1000 dòng đầu/, 'the cap states how many lines were omitted');
    assert.ok(body.includes('unique-line-2999'), 'the tail survives the cap');
    assert.ok(!body.includes('unique-line-0\n'), 'the head is what is omitted');

    // A settled view must not re-parse on every push: sync again with the same buffer
    // and the same DOM must serve from the mount, not from another strip pass.
    const elBefore = harness.sleepPreview();
    harness.syncTerminalPool(list, 'sl5');
    assert.strictEqual(harness.sleepPreview(), elBefore, 'an unchanged push keeps the mounted view');
    assert.strictEqual(previewText(harness), body, 're-sync leaves the rendered text untouched');
  });
});

describe('Renderer group header: reachable and operable from the keyboard', () => {
  it('takes focus and answers Enter and Space the way it answers a click', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 } },
    });
    // The boot payload is applied asynchronously, so the render below must wait for it or
    // it runs under the default layout and no bucket header exists to test.
    await flush();
    // The sleep bucket is the only header a plain shell still renders — category
    // headers are retired — so it is the surface keyboard operability is proven on.
    const list = [
      { id: 'k1', name: 'Live', state: 'running' },
      { id: 'k2', name: 'Asleep', state: 'sleeping', buffer: 'zzz' },
    ];
    seed(harness, list, 'k1');
    harness.renderTabs();

    const header = (): FakeElement => {
      // The sweep recreates the bucket header every render, so it must be re-queried.
      const found = headers(harness).find((el) => el.getAttribute('data-category') === '__sleeping__');
      assert.ok(found, 'the sleep bucket header must render');
      return found;
    };
    assert.strictEqual(header().getAttribute('role'), 'button');
    assert.strictEqual(header().tabIndex, 0, 'a role="button" nothing can Tab to is unusable');

    header().dispatch('keydown', { key: 'Enter', target: header() });
    await flush();
    assert.strictEqual(header().getAttribute('aria-expanded'), 'false', 'Enter collapses');
    assert.strictEqual(wrapFor(harness, 'k2').classList.contains('is-category-collapsed'), true, 'the parked row hides');
    assert.strictEqual(wrapFor(harness, 'k1').classList.contains('is-category-collapsed'), false, 'the live row stays');

    header().dispatch('keydown', { key: ' ', target: header() });
    await flush();
    assert.strictEqual(header().getAttribute('aria-expanded'), 'true', 'Space expands again');
    assert.strictEqual(wrapFor(harness, 'k2').classList.contains('is-category-collapsed'), false);
  });

  it('does not collapse when Enter was aimed at a control inside it', async () => {
    // The surviving managed headers are the manager's project sections: they carry
    // inner controls, so the target guard is proven there.
    const harness = loadStandalone({
      contextMenuActions: ['assign-capsule'],
      initialState: {
        projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
        terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 },
      },
    });
    await flush();
    const list = [{ id: 'r1', name: 'X', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' }];
    seed(harness, list, 'r1');
    harness.renderTabs();

    const header = headers(harness).find((el) => el.getAttribute('data-group-kind') === 'project');
    assert.ok(header, 'the project section header must render');
    const star = header.querySelector('[data-role="project-star"]');
    assert.ok(star, 'the header must carry an inner control');
    // The keydown still bubbles to the header, but a bubbled Enter belongs to the control
    // that has focus, not to the collapse underneath it.
    header.dispatch('keydown', { key: 'Enter', target: star });
    await flush();

    assert.strictEqual(header.getAttribute('aria-expanded'), 'true', 'the section must stay open');

    // The same key aimed at the header itself does collapse — the guard is about the
    // target, not the key.
    header.dispatch('keydown', { key: 'Enter', target: header });
    await flush();
    assert.strictEqual(header.getAttribute('aria-expanded'), 'false', 'Enter on the header collapses the section');
    assert.strictEqual(wrapFor(harness, 'r1').classList.contains('is-category-collapsed'), true);
  });
});

/**
 * Structural CSS check for the sidebar tab-row alignment.
 *
 * The vm harness has no layout engine, so this can only prove the rules exist and
 * are mutually consistent (exactly one `margin-left: auto` per row, a shrinkable
 * name). The PIXEL result — the status beacon flush against the right edge — is
 * unverified by test and must be confirmed in the running app.
 */
describe('Sidebar tab row: status beacon pinned right (CSS structure only)', () => {
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
    assert.match(beacon, /order:\s*1/, 'the beacon is ordered after the name');
  });

  it('lets the sidebar name shrink so the beacon, not the name, is what gets pinned', () => {
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

  it('renames a stored group and moves every tab with it — still flat on screen', async () => {
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

    // The header that used to open this is gone, so the same operation runs through the
    // rename path the header's pencil used to call.
    assert.strictEqual(headers(harness).length, 0, 'no group header is left to click');
    harness.assign("beginRenameCategory('Build')");
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
    // The strip stays flat: the renamed name still paints no header and no chip.
    assert.strictEqual(headers(harness).length, 0, 'a renamed group still renders no header');
    assert.strictEqual(harness.tabsRoot.querySelectorAll('.terminal-tab-category-chip').length, 0);
    assert.deepStrictEqual(
      harness.apiCallArgs.filter((e) => e.name === 'setCategory').map((e) => e.args),
      [['s1', 'Xây dựng'], ['s2', 'Xây dựng']],
    );
    assert.deepStrictEqual(persistedCategories(harness), ['Xây dựng']);
  });

  it('carries the collapsed marker across a rename without ever hiding a row', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', category: 'Build', state: 'running' }], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.assign("collapsedCategories.add('Build')");
    harness.renderTabs();

    // Even with the group "collapsed" the flat list shows the row: collapse state is a
    // per-key marker the retired axis can no longer spend.
    assert.strictEqual(wrapFor(harness, 's1').classList.contains('is-category-collapsed'), false);

    harness.assign("beginRenameCategory('Build')");
    await flush();
    submitName(harness, 'Dock');
    await flush();

    // The marker follows the name, so a collapsed group stays collapsed in the stored
    // prefs — and it still hides nothing, because nothing reads it for flat rows.
    assert.deepStrictEqual(
      Array.from(harness.read<Iterable<string>>('collapsedCategories')),
      ['Dock'],
      'the collapsed marker follows the rename',
    );
    assert.strictEqual(wrapFor(harness, 's1').classList.contains('is-category-collapsed'), false);
    assert.strictEqual(headers(harness).length, 0);
  });

  it('deletes a group when the new name is left empty, releasing its tabs', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', category: 'Deploy', state: 'running' }], 's1');
    harness.assign("applyCategories(['Deploy'])");
    harness.renderTabs();

    harness.assign("beginRenameCategory('Deploy')");
    await flush();
    submitName(harness, '');
    await flush();

    assert.deepStrictEqual(categories(harness), []);
    assert.deepStrictEqual(Array.from(harness.getSessions(), (s) => s.category), [undefined]);
    assert.strictEqual(headers(harness).length, 0, 'the strip stays flat either way');
  });

  it('keeps the persisted group list as data — it can never reorder the strip', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'One', category: 'Alpha', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Zeta', 'Alpha'])");
    harness.renderTabs();

    // The registry still holds the user order — it is the list Main persists — but it
    // paints nothing: the strip is the session order and nothing else.
    assert.deepStrictEqual(categories(harness), ['Zeta', 'Alpha'], 'the stored order survives as data');
    assert.strictEqual(headers(harness).length, 0, 'no group gets a header, empty or not');
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1', 's2'], 'the flat list is the session order');
  });

  it('paints no group affordance anywhere — no header, no rename, no group menu', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [{ id: 's1', name: 'One', state: 'running' }], 's1');
    harness.renderTabs();

    assert.strictEqual(headers(harness).length, 0, 'even the catch-all renders no header');
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-rename').length,
      0,
      'there is no surface left that could offer rename',
    );
    assert.strictEqual(harness.tabsRoot.querySelectorAll('.terminal-tab-category-menu').length, 0);
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

    // A group created from a tab is still registered: it outlives that tab in the
    // persisted list, even though it never paints a header.
    assert.deepStrictEqual(categories(harness), ['Billing']);
    assert.deepStrictEqual(persistedCategories(harness), ['Billing']);
    assert.strictEqual(headers(harness).length, 0);
  });
});

describe('Renderer split panes follow the tab that owns them', () => {


  const menuEvent = () => ({
    key: '',
    clientX: 10,
    clientY: 10,
    preventDefault: () => {},
    stopPropagation: () => {},
  });

  it('files a pane directly under its parent in the flat list', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    // Main creates a pane with no category of its own; the tab it splits still carries one.
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
      { id: 's3', name: 'Loose', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build'])");
    harness.renderTabs();

    assert.strictEqual(headers(harness).length, 0, 'a pane must not fork a group of its own — nothing does anymore');
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1', 's2', 's3'],
      'the pane sits directly under the tab it splits in the flat session order');
    assert.strictEqual(wrapFor(harness, 's2').classList.contains('is-split-pane'), true);
  });

  it('takes the pane along when the owning tab reorders', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
      { id: 's3', name: 'Other', state: 'running' },
    ], 's1');
    harness.renderTabs();

    // The owning tab is the drag handle for the whole family: the gesture moves the tab,
    // and the pane stays glued under it whatever position the list lands on.
    dragRowOnto(harness, 's1', wrapFor(harness, 's3'));
    await flush();

    assert.deepStrictEqual(sessionIds(harness), ['s2', 's1', 's3'], 'the reorder resolves by session id');
    assert.deepStrictEqual(plain(lastArgs(harness, 'reorderTerminals')?.[0] as string[] | undefined), ['s2', 's1', 's3']);
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1', 's2', 's3'],
      'the pane follows its parent instead of staying behind at the old slot');
    assert.deepStrictEqual(
      harness.apiCallArgs.filter((e) => e.name === 'setCategory').map((e) => e.args),
      [['s1', undefined]],
      'the drop adopts the target row\'s stored category on the parent — the pane is never written',
    );
  });

  it('moves by the parent alone: a pane row is not a drag source', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'App', category: 'Build', state: 'running' },
      { id: 's2', name: 'App split-1', splitOf: 's1', state: 'running' },
      { id: 's3', name: 'Other', category: 'Build', state: 'running' },
    ], 's1');
    harness.assign("applyCategories(['Build', 'Deploy'])");
    harness.renderTabs();

    // The crash fix stands: no wrap is an HTML5 drag source (`f4d90277`), because Windows
    // routes that path through OLE / DirectUI (DUI70.dll) and it null-deref'd the process
    // mid-drag. Reordering is the pointer gesture below, so this asserts the safety
    // invariant rather than the affordance.
    assert.strictEqual(wrapFor(harness, 's1').draggable, false, 'a wrap must never be an HTML5 drag source');
    assert.strictEqual(wrapFor(harness, 's2').draggable, false, 'a pane must never be an HTML5 drag source');

    // A drag a later render would undo is not an affordance: the parent's row is the
    // handle for the family, so pressing a pane never arms a drag — and since the strip
    // reorders only from an armed pointer drag, the pane cannot reorder anything.
    dragRowOnto(harness, 's2', wrapFor(harness, 's3'));
    assert.deepStrictEqual(lastArgs(harness, 'reorderTerminals'), undefined, 'a pane must not drag on its own');
    assert.deepStrictEqual(sessionIds(harness), ['s1', 's2', 's3'], 'nothing moved');

    // The owning tab is the handle, so the very same gesture from it does reorder.
    dragRowOnto(harness, 's1', wrapFor(harness, 's3'));
    assert.deepStrictEqual(sessionIds(harness), ['s2', 's1', 's3'], 'the owning tab still reorders');
    assert.deepStrictEqual(plain(lastArgs(harness, 'reorderTerminals')?.[0] as string[] | undefined), ['s2', 's1', 's3']);
    assert.deepStrictEqual(lastArgs(harness, 'setCategory'), undefined,
      'both rows already share the stored category, so the reorder writes nothing');
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
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1', 's2'],
      'the flat strip still keeps the pane glued under its tab');
  });
});

describe('Renderer sleeping bucket: parked, and returned to the flat list', () => {
  const headerKeys = (harness: StandaloneHarness): (string | null)[] =>
    headers(harness).map((el) => el.getAttribute('data-category'));

  const headerFor = (harness: StandaloneHarness, key: string): FakeElement => {
    const found = headers(harness).find((el) => el.getAttribute('data-category') === key);
    assert.ok(found, `expected a header for ${key}`);
    return found;
  };

  it('parks a sleeping tab in its own bucket at the end of the flat list', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Live', category: 'Build', state: 'running' },
      { id: 's2', name: 'Asleep', category: 'Build', state: 'sleeping' },
    ], 's1');
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['__sleeping__'],
      'a state is not a group: only the parked bucket keeps a header');
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1'], 'the live tab stays in the flat list');
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

    assert.deepStrictEqual(headerKeys(harness), [],
      'a sleeping split must not create a parked bucket row, and a group name paints no header');
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1'], 'the parent stays in the flat list alone');
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="s2"]'),
      null,
      'the sleeping split row must be removed from the sidebar',
    );
  });

  it('parks a pane row with a parent that is already asleep, never into a row of its own', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    // The pane's own record has not flipped yet — this is the broadcast window where the
    // parent is already parked. The pane inherits its bucket from that parent, so without
    // the park-with-parent rule the row is filed as a live tab and shows up as a terminal
    // the user never opened.
    seed(harness, [
      { id: 's1', name: 'Hapas', state: 'sleeping' },
      { id: 's2', name: 'Terminal split-2', splitOf: 's1', state: 'running' },
    ], 's1');
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), ['__sleeping__'],
      'the pane must not create a row of its own beside the parked parent');
    assert.deepStrictEqual(buckets(harness)['__sleeping__'], ['s1'], 'only the parent keeps a parked row');
    assert.deepStrictEqual(buckets(harness)['__top__'], [], 'no leaked pane row in the flat list');
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="s2"]'),
      null,
      'a pane whose parent is parked has no row of its own',
    );
  });

  it('returns a woken tab to the flat list in session order, because sleep never rewrote its category', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Live', category: 'Build', state: 'running' },
      { id: 's2', name: 'Asher', category: 'Deploy', state: 'sleeping' },
    ], 's1');
    // The names are still registered — registration is data — but they paint nothing.
    harness.assign("applyCategories(['Build', 'Deploy'])");
    harness.renderTabs();
    assert.deepStrictEqual(headerKeys(harness), ['__sleeping__']);
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1']);

    // Main reports the very same session awake again: same record, new state.
    harness.assign(
      "sessions = sessions.map((s) => (s.id === 's2' ? Object.assign({}, s, { state: 'running' }) : s))",
    );
    harness.renderTabs();

    assert.deepStrictEqual(headerKeys(harness), [],
      'the bucket disappears with its last tenant and nothing replaces it');
    assert.deepStrictEqual(buckets(harness)['__top__'], ['s1', 's2'],
      'the wake returns the tab to the flat list at its own session slot');
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

  it('filters by name, folder and the stored category string — flat list throughout', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);
    assert.strictEqual(visibleIds(harness).length, 3);

    search(harness, 'seahorse');
    assert.deepStrictEqual(visibleIds(harness), ['s1'], 'the name is searchable');
    assert.strictEqual(headers(harness).length, 0,
      'filtering never paints a header — the retired axis stays dead even mid-search');

    search(harness, 'apps');
    assert.deepStrictEqual(visibleIds(harness), ['s2', 's3'], 'the stored category text still feeds the query');

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

  it('filters without ever reordering the tabs', async () => {
    const harness = loadStandalone();
    await flush();
    seedThree(harness);
    const before = visibleIds(harness);

    search(harness, 'uncommon');
    assert.deepStrictEqual(visibleIds(harness), ['s2'], 'only the match renders');
    search(harness, '');
    assert.deepStrictEqual(visibleIds(harness), before, 'a filter hides; clearing restores the exact order');
    assert.strictEqual(headers(harness).length, 0, 'and the strip stays headerless either way');
  });

  it('opens the sleep bucket while a parked row matches, then restores its collapsed state', async () => {
    const harness = loadStandalone();
    await flush();
    harness.assign("applyTerminalTabLayout('sidebar')");
    seed(harness, [
      { id: 's1', name: 'Live', state: 'running' },
      { id: 's2', name: 'Uncommon sleeper', state: 'sleeping', buffer: 'zzz' },
    ], 's1');
    harness.renderTabs();
    const sleeping = (): FakeElement => {
      const found = headers(harness).find((el) => el.getAttribute('data-category') === '__sleeping__');
      assert.ok(found);
      return found;
    };

    sleeping().dispatch('click', {});
    await flush();
    assert.strictEqual(sleeping().getAttribute('aria-expanded'), 'false');

    // Hiding the match inside a collapsed bucket would read as a failed search.
    search(harness, 'uncommon');
    assert.strictEqual(sleeping().getAttribute('aria-expanded'), 'true', 'a filtered bucket is shown open');
    assert.deepStrictEqual(visibleIds(harness), ['s2']);

    search(harness, '');
    assert.strictEqual(sleeping().getAttribute('aria-expanded'), 'false',
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
    assert.strictEqual(toolbar.querySelector('.terminal-tab-new-category'), null, 'groups are made by the project flow, not a strip control');

    // A tab drag reorders tabs; it must never be able to move the row.
    wrapFor(harness, 's3').dispatch('dragstart', { dataTransfer: dataTransfer('s3') });
    wrapFor(harness, 's3').dispatch('dragend', {});
    harness.renderTabs();
    assert.strictEqual(harness.tabsRoot.firstChild, toolbar, 'the row stays pinned across renders');
  });
});
