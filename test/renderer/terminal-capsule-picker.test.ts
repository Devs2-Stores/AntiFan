/**
 * The tab context menu's "assign to capsule" flow in the terminal renderer.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the shared vm
 * harness (only document/window/xterm/preload are stubbed), so they exercise the picker
 * the renderer actually builds rather than a re-implementation of it.
 *
 * The four properties the flow lives or dies on:
 *   1. The picker is opened from the tab context menu, against the row that was right-clicked.
 *   2. The list comes from Main's project inventory on every open, not capsule history;
 *      only a project with a canonical destination capsule is pickable.
 *   3. Typing filters on the name and the path, and Enter dispatches the row the user can see.
 *   4. The handover is direct: assigning never opens or focuses the target project's
 *      window — ASSIGN_PROJECT re-stamps the row where the manager already shows it.
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

/** The shared manager reads every project's rows; project shells read only their own. */
const MANAGER_STATE: { projectWindow: { owner: { kind: string; projectId?: string }; title: string } } = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
};

/**
 * Load the renderer as the shared manager and let its boot settle, then start recording calls: the
 * boot read of the capsule index is the shell starting up, not the flow under test, and a row that
 * counted it would be measuring the wrong thing.
 */
async function loadManagerShell(initialState = MANAGER_STATE): Promise<StandaloneHarness> {
  const harness = loadStandalone({ contextMenuActions: ['assign-capsule'], initialState });
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
const PROJECTS = [
  { projectId: 'proj-comnieu', name: 'Comnieu', workspacePath: 'E:/Work/comnieu', capsuleId: 'capsule-comnieu' },
  { projectId: 'proj-phukien', name: 'Phukienmymoc', workspacePath: 'E:/Work/phukienmymoc', capsuleId: 'capsule-phukien' },
  { projectId: 'proj-unmapped', name: 'Unmapped project', workspacePath: '' },
];

interface PickerFixture {
  harness: StandaloneHarness;
  popover: FakeElement;
  input: FakeElement;
}

/** Load the renderer, open the picker from the context menu of `sessionId`, and hand back its parts. */
async function openPicker(options: {
  initialState?: typeof MANAGER_STATE;
  sessions?: unknown[];
  active?: string;
  rightClicked: string;
  listCapsules?: () => Promise<{ activeCapsuleId?: string; capsules: unknown[] }>;
  listProjects?: () => Promise<{ candidates: unknown[] }>;
  openProject?: (projectId: string) => Promise<unknown>;
}): Promise<PickerFixture> {
  const harness = await loadManagerShell(options.initialState);
  harness.api.listCapsules = options.listCapsules ?? (async () => ({ activeCapsuleId: 'capsule-comnieu', capsules: CAPSULES }));
  harness.api.listProjects = options.listProjects ?? (async () => ({ candidates: PROJECTS }));
  // Main reports the window it opened, and only that answer lets step two run: the default here is
  // the successful open, so a row that means to fail the open has to say so on purpose.
  harness.api.openProject = options.openProject ?? (async () => ({ status: 'OPENED' }));
  seed(harness, options.sessions ?? [{ id: 'c1', name: 'C1', state: 'running', capsuleId: 'capsule-comnieu', ownerKey: 'project:proj-comnieu' }], options.active ?? 'c1');
  harness.renderTabs();

  harness.showContextMenu(menuEvent(), options.rightClicked);
  menuItem(harness, 'assign-capsule').dispatch('click');
  // The open reads the project inventory from Main and repaints when that read lands.
  await flush();
  await flush();

  const popover = pickerPopover(harness);
  const input = popover.querySelector('.terminal-capsule-picker-input');
  assert.ok(input, 'the picker must offer a search input');
  return { harness, popover, input };
}

describe('Renderer capsule picker — opening from the tab context menu', () => {
  it('offers the authoritative project inventory, not historical workspace capsules', async () => {
    const { harness, popover } = await openPicker({ rightClicked: 'c1' });

    assert.strictEqual(popover.style.display, 'block', 'the picker is shown');
    assert.strictEqual(popover.getAttribute('data-active-session-id'), 'c1', 'the picker names the session it would move');
    assert.strictEqual(popover.querySelector('.terminal-capsule-picker-header')?.textContent, 'Chuyển Terminal sang Dự án');
    assert.strictEqual(countCalls(harness, 'listProjects'), 1, 'project inventory is refreshed on every open');

    assert.deepStrictEqual(
      offeredCapsules(popover).map((entry) => entry.id),
      ['capsule-comnieu', 'capsule-phukien'],
      'only canonical capsules from the project inventory are offered',
    );
    // A known project without a workspace can still own a terminal.
    assert.strictEqual(capsuleRow(popover, 'capsule-phukien').querySelector('.terminal-capsule-picker-name')?.textContent, 'Phukienmymoc');
    assert.strictEqual(capsuleRow(popover, 'capsule-comnieu').getAttribute('aria-disabled'), 'true');
    assert.strictEqual(capsuleRow(popover, 'capsule-comnieu').querySelector('.terminal-capsule-picker-current')?.textContent, '✓ Hiện tại');
    const unmapped = popover.querySelector('[data-project-id="proj-unmapped"]');
    assert.ok(unmapped);
    assert.strictEqual(unmapped.getAttribute('aria-disabled'), 'false');
    assert.strictEqual(capsuleRow(popover, 'capsule-phukien').getAttribute('aria-disabled'), 'false');
  });

  it('refreshes manager labels for capsules created or renamed after boot', async () => {
    const { harness, input } = await openPicker({ rightClicked: 'c1' });
    const chip = () => harness.tabsRoot.querySelector('.terminal-tab-capsule-chip[data-capsule-id="capsule-comnieu"]');
    assert.strictEqual(chip()?.textContent, 'Comnieu');
    input.dispatch('keydown', { key: 'Escape' });
    harness.api.listCapsules = async () => ({ capsules: [
      { ...CAPSULES[0], name: 'Renamed project' },
      { id: 'capsule-new', name: 'New project', workspacePath: 'E:/Work/new' },
    ] });
    seed(harness, [
      { id: 'c1', state: 'running', capsuleId: 'capsule-comnieu', ownerKey: 'project:proj-comnieu' },
      { id: 'c2', state: 'running', capsuleId: 'capsule-new', ownerKey: 'project:proj-new' },
    ], 'c1');
    harness.renderTabs();
    harness.showContextMenu(menuEvent(), 'c1');
    menuItem(harness, 'assign-capsule').dispatch('click');
    await flush();
    await flush();
    assert.strictEqual(chip()?.textContent, 'Renamed project');
    assert.strictEqual(harness.tabsRoot.querySelector('.terminal-tab-capsule-chip[data-capsule-id="capsule-new"]')?.textContent, 'New project');
  });

  it('opens from a project window for its own terminal and offers another project', async () => {
    const { harness, popover } = await openPicker({
      initialState: { projectWindow: { owner: { kind: 'project', projectId: 'proj-comnieu' }, title: 'Comnieu' } },
      rightClicked: 'c1',
    });
    assert.strictEqual(menuItem(harness, 'assign-capsule').getAttribute('aria-disabled'), 'false');
    assert.strictEqual(popover.style.display, 'block');
    assert.strictEqual(capsuleRow(popover, 'capsule-comnieu').getAttribute('aria-disabled'), 'true');
    assert.strictEqual(capsuleRow(popover, 'capsule-phukien').getAttribute('aria-disabled'), 'false');
  });

  it('shows one canonical destination despite hundreds of legacy capsule duplicates', async () => {
    const { popover } = await openPicker({
      rightClicked: 'c1',
      listCapsules: async () => ({ capsules: [
        ...CAPSULES,
        ...Array.from({ length: 226 }, (_, index) => ({
          id: `legacy-${index}`, name: 'Comnieu', workspacePath: 'E:/Work/comnieu', resolvedProjectId: 'proj-comnieu',
        })),
      ] }),
    });
    assert.deepStrictEqual(offeredCapsules(popover).map((entry) => entry.id), ['capsule-comnieu', 'capsule-phukien']);
    assert.strictEqual(popover.querySelector('.terminal-capsule-picker-hint')?.textContent, '3 dự án — hiện tại: Comnieu');
  });

  it('marks the session owner as current even when the session has no capsule', async () => {
    const { popover } = await openPicker({
      rightClicked: 'c1',
      sessions: [{ id: 'c1', state: 'running', ownerKey: 'project:proj-comnieu' }],
    });
    assert.strictEqual(capsuleRow(popover, 'capsule-comnieu').getAttribute('aria-disabled'), 'true');
    assert.strictEqual(capsuleRow(popover, 'capsule-phukien').getAttribute('aria-disabled'), 'false');
  });

  for (const owner of [{ kind: 'unassigned' }, { kind: 'project', projectId: 'proj-comnieu' }]) {
    it(`keeps agent-owned terminals read-only in a ${owner.kind} window`, async () => {
      const harness = loadStandalone({
        contextMenuActions: ['assign-capsule'],
        initialState: { projectWindow: { owner, title: 'Shell' } },
      });
      await flush();
      seed(harness, [{ id: 'agent-session', name: 'Agent', state: 'running', ownerKey: 'agent:tab-9' }], 'agent-session');
      harness.renderTabs();
      harness.showContextMenu(menuEvent(), 'agent-session');
      const item = menuItem(harness, 'assign-capsule');
      assert.strictEqual(item.getAttribute('aria-disabled'), 'true');
      item.dispatch('click');
      await flush();
      assert.notStrictEqual(pickerPopover(harness).style.display, 'block');
      assert.strictEqual(countCalls(harness, 'openProject'), 0);
      assert.strictEqual(countCalls(harness, 'assignTerminalProject'), 0);
    });
  }

  it('offers the move for an agent row no agent holds any more', async () => {
    const harness = loadStandalone({
      contextMenuActions: ['assign-capsule'],
      initialState: { projectWindow: { owner: { kind: 'unassigned' }, title: 'Shell' } },
    });
    await flush();
    // Main stamps `agentHeld: false` once the minting tab is gone; the row is then an ordinary one.
    seed(harness, [{ id: 'orphan-session', name: 'Orphan', state: 'running', ownerKey: 'agent:tab-gone', agentHeld: false }], 'orphan-session');
    harness.renderTabs();
    harness.showContextMenu(menuEvent(), 'orphan-session');
    assert.strictEqual(menuItem(harness, 'assign-capsule').getAttribute('aria-disabled'), 'false');
  });

  it('shows what Main reported when the project inventory cannot be read', async () => {
    const { harness, popover } = await openPicker({
      rightClicked: 'c1',
      listProjects: async () => { throw new Error('bridge offline'); },
    });

    assert.strictEqual(capsuleRow_optionalError(popover), 'bridge offline');
    assert.strictEqual(countCalls(harness, 'assignTerminalProject'), 0, 'a list that could not be read moves nothing');
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
    assert.strictEqual(countCalls(harness, 'openProject'), 0, 'assigning a terminal must not pop the project window open');
    assert.deepStrictEqual(
      lastArgs(harness, 'assignTerminalProject'),
      ['c1', 'proj-phukien'],
      'the handover names the right-clicked session and durable project identity',
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
      lastArgs(harness, 'assignTerminalProject'),
      ['c1', 'proj-phukien'],
      'a pane has no window of its own: the move is the owning tab\'s, so the whole family travels',
    );
  });

  it('moves the row straight to the project without opening its window', async () => {
    const harness = await loadManagerShell();
    harness.api.listCapsules = (async () => ({ activeCapsuleId: 'capsule-comnieu', capsules: CAPSULES })) as unknown as StandaloneHarness['api']['listCapsules'];
    harness.api.listProjects = async () => ({ candidates: PROJECTS });
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

    assert.strictEqual(countCalls(harness, 'openProject'), 0, 'the assignment path never touches the window opener');
    assert.deepStrictEqual(lastArgs(harness, 'assignTerminalProject'), ['c1', 'proj-phukien']);
    assert.strictEqual(
      harness.getSessions().find((session) => session.id === 'c1')?.ownerKey,
      'project:proj-phukien',
      'the row is filed under its new owner',
    );
  });

  it('moves into a project without a workspace and clears the prior capsule label', async () => {
    const { harness, popover } = await openPicker({ rightClicked: 'c1' });
    const destination = popover.querySelector('[data-project-id="proj-unmapped"]');
    assert.ok(destination);
    destination.dispatch('click');
    await flush();
    assert.deepStrictEqual(lastArgs(harness, 'assignTerminalProject'), ['c1', 'proj-unmapped']);
    const session = harness.getSessions().find((row) => row.id === 'c1');
    assert.strictEqual(session?.ownerKey, 'project:proj-unmapped');
    assert.strictEqual(session?.capsuleId, undefined);
  });

  it('refuses a project Main reports as ambiguous even when its old capsule is present', async () => {
    const { harness, popover } = await openPicker({
      rightClicked: 'c1',
      listProjects: async () => ({ candidates: [{ ...PROJECTS[1], canAssignTerminal: false }] }),
    });
    const row = capsuleRow(popover, 'capsule-phukien');
    assert.strictEqual(row.getAttribute('aria-disabled'), 'true');
    row.dispatch('click');
    await flush();
    assert.strictEqual(countCalls(harness, 'assignTerminalProject'), 0);
  });
});
