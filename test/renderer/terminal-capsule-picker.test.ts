/**
 * The tab context menu's "assign to capsule" flow in the terminal renderer.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the shared vm
 * harness (only document/window/xterm/preload are stubbed), so they exercise the picker
 * the renderer actually builds rather than a re-implementation of it.
 *
 * The four properties the flow lives or dies on:
 *   1. The picker is opened from the tab context menu, against the row that was right-clicked.
 *   2. The list comes from Main on every open — a capsule created in another window has to be
 *      offered without a restart — and only a capsule whose project can be named is pickable.
 *   3. Typing filters on the name and the path, and Enter dispatches the row the user can see.
 *   4. The window is opened BEFORE the session is handed over, and a cancelled or refused open
 *      leaves the row exactly where it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type FakeElement, type KeyEventLike, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const countCalls = (harness: StandaloneHarness, name: string): number =>
  harness.apiCalls.filter((entry) => entry === name).length;

const lastArgs = (harness: StandaloneHarness, name: string): unknown[] | undefined =>
  harness.apiCallArgs.filter((entry) => entry.name === name).at(-1)?.args;

/** Replace the renderer's live session list the way a `session` broadcast does. */
function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
}

const menuEvent = (): KeyEventLike & { clientX: number; clientY: number } => ({
  key: '',
  clientX: 10,
  clientY: 10,
  preventDefault: () => {},
  stopPropagation: () => {},
});

/**
 * The shell Main reports for the shared manager: one that owns no project. The handover row in the
 * tab context menu is enabled only there — a window that owns a single project has no second
 * project to move a terminal to — and a manager shell reads the capsule index once at boot so it can
 * name the capsules its rows belong to.
 */
const MANAGER_STATE = { projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' } };

/**
 * Load the renderer as the shared manager and let its boot settle, then start recording calls: the
 * boot read of the capsule index is the shell starting up, not the flow under test, and a row that
 * counted it would be measuring the wrong thing.
 */
async function loadManagerShell(): Promise<StandaloneHarness> {
  const harness = loadStandalone({ contextMenuActions: ['assign-capsule'], initialState: MANAGER_STATE });
  await flush();
  harness.apiCalls.length = 0;
  harness.apiCallArgs.length = 0;
  return harness;
}

/** The context-menu row for one action, as `standalone.html` provides it. */
function menuItem(harness: StandaloneHarness, action: string): FakeElement {
  const found = harness.contextMenu.querySelector(`.context-item[data-action="${action}"]`);
  assert.ok(found, `expected a context-menu item for ${action}`);
  return found;
}

const pickerPopover = (harness: StandaloneHarness): FakeElement => {
  const popover = harness.elements.get('capsulePickerPopover');
  assert.ok(popover, 'the capsule picker popover element must exist');
  return popover;
};

/** The capsule rows the picker is offering right now, in paint order. */
const offeredCapsules = (popover: FakeElement): Array<{ id: string; row: FakeElement }> =>
  popover
    .querySelectorAll('.terminal-capsule-picker-item')
    .filter((row) => row.getAttribute('data-capsule-id') !== null)
    .map((row) => ({ id: String(row.getAttribute('data-capsule-id')), row }));

function capsuleRow(popover: FakeElement, capsuleId: string): FakeElement {
  const found = offeredCapsules(popover).find((entry) => entry.id === capsuleId);
  assert.ok(found, `expected the picker to offer ${capsuleId}, offered: ${offeredCapsules(popover).map((entry) => entry.id).join(', ')}`);
  return found.row;
}

/**
 * Two capsules with a project (`resolvedProjectId` is Main's additively resolved affiliation for
 * a record claiming none) and one folder row that names no project at all.
 */
const CAPSULES = [
  { id: 'capsule-comnieu', name: 'Comnieu', workspacePath: 'E:/Work/comnieu', projectId: 'proj-comnieu' },
  { id: 'capsule-phukien', name: 'Phukienmymoc', workspacePath: 'E:/Work/phukienmymoc', resolvedProjectId: 'proj-phukien' },
  { id: 'capsule-folder', name: 'Folder only', workspacePath: 'E:/Work/loose-folder' },
];

interface PickerFixture {
  harness: StandaloneHarness;
  popover: FakeElement;
  input: FakeElement;
}

/** Load the renderer, open the picker from the context menu of `sessionId`, and hand back its parts. */
async function openPicker(options: {
  sessions?: unknown[];
  active?: string;
  rightClicked: string;
  listCapsules?: () => Promise<{ activeCapsuleId?: string; capsules: unknown[] }>;
  openProject?: (projectId: string) => Promise<unknown>;
}): Promise<PickerFixture> {
  const harness = await loadManagerShell();
  harness.api.listCapsules = options.listCapsules ?? (async () => ({ activeCapsuleId: 'capsule-comnieu', capsules: CAPSULES }));
  // Main reports the window it opened, and only that answer lets step two run: the default here is
  // the successful open, so a row that means to fail the open has to say so on purpose.
  harness.api.openProject = options.openProject ?? (async () => ({ status: 'OPENED' }));
  seed(harness, options.sessions ?? [{ id: 'c1', name: 'C1', state: 'running', capsuleId: 'capsule-comnieu' }], options.active ?? 'c1');
  harness.renderTabs();

  harness.showContextMenu(menuEvent(), options.rightClicked);
  menuItem(harness, 'assign-capsule').dispatch('click');
  // The open reads the capsule list from Main and repaints when that read lands.
  await flush();
  await flush();

  const popover = pickerPopover(harness);
  const input = popover.querySelector('.terminal-capsule-picker-input');
  assert.ok(input, 'the picker must offer a search input');
  return { harness, popover, input };
}

describe('Renderer capsule picker — opening from the tab context menu', () => {
  it('opens for the right-clicked row and offers every capsule Main knows', async () => {
    const { harness, popover } = await openPicker({ rightClicked: 'c1' });

    assert.strictEqual(popover.style.display, 'block', 'the picker is shown');
    assert.strictEqual(popover.getAttribute('data-active-session-id'), 'c1', 'the picker names the session it would move');
    assert.strictEqual(popover.querySelector('.terminal-capsule-picker-header')?.textContent, 'Chuyển Terminal sang Dự án');
    assert.strictEqual(countCalls(harness, 'listCapsules'), 1, 'the list is read from Main on open, not from a boot-time index');

    assert.deepStrictEqual(
      offeredCapsules(popover).map((entry) => entry.id),
      ['capsule-comnieu', 'capsule-phukien', 'capsule-folder'],
      'every capsule is offered, in name order',
    );
    // The session's own capsule is named as the current state, and a folder row names no project,
    // so neither is a pick the user can make. Only the one real move is offered.
    assert.strictEqual(capsuleRow(popover, 'capsule-phukien').querySelector('.terminal-capsule-picker-name')?.textContent, 'Phukienmymoc');
    assert.strictEqual(capsuleRow(popover, 'capsule-comnieu').getAttribute('aria-disabled'), 'true');
    assert.strictEqual(capsuleRow(popover, 'capsule-comnieu').querySelector('.terminal-capsule-picker-current')?.textContent, '✓ Hiện tại');
    assert.strictEqual(capsuleRow(popover, 'capsule-folder').getAttribute('aria-disabled'), 'true');
    assert.strictEqual(capsuleRow(popover, 'capsule-folder').querySelector('.terminal-capsule-picker-blocked')?.textContent, 'chưa gắn dự án');
    assert.strictEqual(capsuleRow(popover, 'capsule-phukien').getAttribute('aria-disabled'), 'false');
  });

  it('shows what Main reported when the capsule list cannot be read', async () => {
    const { harness, popover } = await openPicker({
      rightClicked: 'c1',
      listCapsules: async () => { throw new Error('bridge offline'); },
    });

    assert.strictEqual(capsuleRow_optionalError(popover), 'bridge offline');
    assert.strictEqual(countCalls(harness, 'assignTerminalCapsule'), 0, 'a list that could not be read moves nothing');
  });
});

/** The one error row a failed capsule read paints, or the text of the empty row if it did not. */
function capsuleRow_optionalError(popover: FakeElement): string {
  const error = popover.querySelector('.terminal-capsule-picker-item.is-error');
  assert.ok(error, 'a failed read must be shown where the list would have been');
  return error.textContent;
}

describe('Renderer capsule picker — filtering and picking', () => {
  it('filters on the typed query and dispatches the pick with the id the user chose', async () => {
    const { harness, popover, input } = await openPicker({ rightClicked: 'c1' });

    // A path fragment filters as literally as a name does.
    input.value = 'phukien';
    input.dispatch('input');
    assert.deepStrictEqual(offeredCapsules(popover).map((entry) => entry.id), ['capsule-phukien']);
    assert.strictEqual(popover.querySelector('.terminal-capsule-picker-hint')?.textContent, '1/3 dự án khớp “phukien”');

    // A query nothing matches says so instead of offering the unfiltered list.
    input.value = 'khong-co-du-an-nao';
    input.dispatch('input');
    assert.deepStrictEqual(offeredCapsules(popover), [], 'no row is offered for a query nothing matches');
    assert.strictEqual(popover.querySelector('.terminal-capsule-picker-hint')?.textContent, '0/3 dự án khớp');
    assert.match(popover.querySelector('.terminal-capsule-picker-item.is-empty')?.textContent ?? '', /Không có dự án nào khớp/);

    input.value = 'phukien';
    input.dispatch('input');
    input.dispatch('keydown', { key: 'Enter' });
    await flush();

    assert.strictEqual(popover.style.display, 'none', 'picking closes the picker');
    assert.deepStrictEqual(lastArgs(harness, 'openProject'), ['proj-phukien'], "the target project's window is opened first");
    assert.deepStrictEqual(
      lastArgs(harness, 'assignTerminalCapsule'),
      ['c1', 'capsule-phukien'],
      "the handover names the right-clicked session and the capsule the user picked",
    );
  });

  it('moves the tab that owns the pane, never the pane alone', async () => {
    const { harness } = await openPicker({
      sessions: [
        { id: 'c1', name: 'C1', state: 'running', capsuleId: 'capsule-comnieu' },
        { id: 'c1-split', name: 'C1 split-1', splitOf: 'c1', state: 'running', capsuleId: 'capsule-comnieu' },
      ],
      active: 'c1',
      rightClicked: 'c1-split',
    });

    const popover = pickerPopover(harness);
    capsuleRow(popover, 'capsule-phukien').dispatch('click');
    await flush();

    assert.deepStrictEqual(
      lastArgs(harness, 'assignTerminalCapsule'),
      ['c1', 'capsule-phukien'],
      'a pane has no window of its own: the move is the owning tab\'s, so the whole family travels',
    );
  });

  it('leaves the row where it is when the target window is never opened', async () => {
    const harness = await loadManagerShell();
    harness.api.listCapsules = (async () => ({ activeCapsuleId: 'capsule-comnieu', capsules: CAPSULES })) as unknown as StandaloneHarness['api']['listCapsules'];
    harness.api.openProject = (async () => ({ status: 'CANCELLED' })) as unknown as StandaloneHarness['api']['openProject'];
    seed(harness, [{ id: 'c1', name: 'C1', state: 'running', capsuleId: 'capsule-comnieu' }], 'c1');
    harness.renderTabs();

    harness.showContextMenu(menuEvent(), 'c1');
    menuItem(harness, 'assign-capsule').dispatch('click');
    await flush();
    await flush();

    const popover = pickerPopover(harness);
    capsuleRow(popover, 'capsule-phukien').dispatch('click');
    await flush();

    assert.deepStrictEqual(lastArgs(harness, 'openProject'), ['proj-phukien'], 'the window open was attempted');
    assert.strictEqual(countCalls(harness, 'assignTerminalCapsule'), 0, 'a cancelled open must not hand the session over');
    assert.strictEqual(
      harness.getSessions().find((session) => session.id === 'c1')?.capsuleId,
      'capsule-comnieu',
      'the row is still filed where it was',
    );
  });

  it('never dispatches a move for a capsule whose project cannot be named', async () => {
    const { harness, popover } = await openPicker({ rightClicked: 'c1' });

    // The folder row carries no project id, so the renderer has no window to open for it: the row
    // is painted disabled and offers no click at all.
    capsuleRow(popover, 'capsule-folder').dispatch('click');
    await flush();

    assert.strictEqual(countCalls(harness, 'openProject'), 0, 'no window can be opened for a capsule with no project');
    assert.strictEqual(countCalls(harness, 'assignTerminalCapsule'), 0);
    assert.strictEqual(popover.style.display, 'block', 'the picker stays open, with the reason on the row');
  });
});
