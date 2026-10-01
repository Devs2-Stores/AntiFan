/**
 * The shared manager's folder grouping, minted-row labels, run badges and the
 * unassigned triage section in the terminal renderer.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the shared vm
 * harness, so they exercise the grouping the hub actually paints rather than a
 * re-implementation of it.
 *
 * The properties this surface lives or dies on:
 *   1. Rows group by the stamped `folderKey` in the manager shell — one key, one section —
 *      and only there; a project window keeps category grouping untouched.
 *   2. `displayLabel` is paint only: persisted `name` is never rewritten, and a
 *      user-renamed row keeps the name the user typed.
 *   3. Folder keys are derived keys: nothing about them may enter `terminalCategories`
 *      or the group menu's write-back list.
 *   4. The "Chưa gắn dự án" block lists every ownerless row with an assign affordance that
 *      opens the project inventory, and agent-owned rows never appear there.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, pickHeaderMenuItem, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const countCalls = (harness: StandaloneHarness, name: string): number =>
  harness.apiCalls.filter((entry) => entry === name).length;

const lastArgs = (harness: StandaloneHarness, name: string): unknown[] | undefined =>
  harness.apiCallArgs.filter((entry) => entry.name === name).at(-1)?.args;

/** The shared manager reads every project's rows; project shells read only their own. */
const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
};

function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
}

/**
 * Load the renderer as the shared manager in the sidebar layout (group headers only exist
 * there) and let its boot settle before any call recording the test cares about.
 */
async function loadManagerSidebar(): Promise<StandaloneHarness> {
  const harness = loadStandalone({ contextMenuActions: ['assign-capsule'], initialState: MANAGER_STATE });
  await flush();
  harness.assign("terminalTabLayout = 'sidebar';");
  harness.apiCalls.length = 0;
  harness.apiCallArgs.length = 0;
  return harness;
}

function groupHeaders(harness: StandaloneHarness): FakeElement[] {
  return harness.tabsRoot.querySelectorAll('.terminal-tab-category-header');
}

function folderHeaders(harness: StandaloneHarness): FakeElement[] {
  return [
    ...harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="folder"]'),
    ...harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="project"]'),
  ];
}

describe('hub folder grouping', () => {
  it('files two rows stamped with one folderKey under a single folder section', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
      { id: 't-2', name: 'Terminal 2', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 2' },
      { id: 't-3', name: 'Terminal 3', state: 'running', ownerKey: 'project:p2', folderKey: 'e:\\work\\y', folderLabel: 'y', folderPath: 'E:\\Work\\y', displayLabel: 'y · 1' },
    ], 't-1');
    harness.renderTabs();

    const folders = folderHeaders(harness);
    assert.strictEqual(folders.length, 2, 'two distinct folders must paint two sections, not three rows');
    const labels = folders.map((header) => header.querySelector('.terminal-tab-category-label')?.textContent);
    assert.deepStrictEqual(labels, ['x', 'y'], 'each section is titled by its folder label');
    // The folder path is the section's hint: two storefronts with the same label are told
    // apart by where they run.
    const firstFolder = folders[0];
    assert.ok(firstFolder);
    assert.strictEqual(firstFolder.title?.includes('E:\\Work\\x'), true, 'the full path is the header tooltip');
    assert.strictEqual(firstFolder.getAttribute('data-folder-path'), 'E:\\Work\\x');
  });

  it('shows the minted displayLabel while the persisted name stays untouched', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
      { id: 't-2', name: 'mine', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 't-1');
    harness.renderTabs();

    const wrapOf = (id: string) => harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${id}"]`);
    assert.strictEqual(wrapOf('t-1')?.querySelector('.terminal-tab-title')?.textContent, 'x · 1', 'the minted row wears the folder badge');
    assert.strictEqual(wrapOf('t-2')?.querySelector('.terminal-tab-title')?.textContent, 'mine', 'a user-set name is never replaced by a badge');

    // The projection is paint-only: the sessions the renderer holds keep the names Main
    // sent, and nothing rewrites them to disk through the rename route.
    assert.deepStrictEqual(Array.from(harness.getSessions().map((s) => s.name)), ['Terminal 1', 'mine']);
    assert.strictEqual(countCalls(harness, 'renameTerminal'), 0);
  });

  it('keeps folder keys out of terminalCategories and the persisted category list', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
    ], 't-1');
    harness.renderTabs();

    const categories = harness.read<string[]>('terminalCategories');
    assert.ok(categories.every((name) => !name.startsWith('folder:')), 'a derived key must never enter the user group list');

    // Collapsing the folder section persists prefs: the categories payload that reaches
    // Main must still carry no folder key.
    const header = folderHeaders(harness)[0];
    assert.ok(header);
    header.dispatch('click');
    await flush();
    for (const call of harness.apiCallArgs.filter((entry) => entry.name === 'setTerminalTabPrefs')) {
      const prefs = call.args[0] as { categories?: string[] };
      assert.ok(
        !Array.isArray(prefs.categories) || prefs.categories.every((name) => !name.startsWith('folder:')),
        'a persisted categories payload must never spell a folder key',
      );
    }
  });

  it('refuses a category drop aimed at a derived group', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
      { id: 't-2', name: 'Other', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\y', folderLabel: 'y', folderPath: 'E:\\Work\\y', displayLabel: 'y · 1' },
    ], 't-1');
    harness.renderTabs();

    // A drop whose header carries a derived key is refused before any category write.
    const header = folderHeaders(harness)[0];
    assert.ok(header);
    header.setAttribute('data-category', 'folder:e:\\work\\x');
    harness.read<(sourceId: string, header: unknown) => void>('commitCategoryDrop')('t-2', header);
    await flush();
    assert.strictEqual(countCalls(harness, 'setCategory'), 0, 'dropping onto a folder section must never file a category');
    assert.deepStrictEqual(
      Array.from(harness.read<string[]>('terminalCategories').filter((name) => name.startsWith('folder:'))),
      [],
    );
  });

  it('offers a new terminal in the section folder from the header right-click menu', async () => {
    const harness = await loadManagerSidebar();
    harness.api.newTerminalInFolder = async () => ({ ok: true, sessionId: 'fresh', capsuleId: 'cap-x' });
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
    ], 't-1');
    harness.renderTabs();

    const header = folderHeaders(harness)[0];
    assert.ok(header, 'the folder section renders');
    assert.strictEqual(header.querySelectorAll('.terminal-tab-category-mint').length, 0, 'the header carries no inline buttons');
    pickHeaderMenuItem(harness, header, 'Terminal mới trong thư mục này');
    await flush();
    assert.deepStrictEqual(lastArgs(harness, 'newTerminalInFolder'), ['E:\\Work\\x']);
  });

  it('offers Space on a docked folder header menu but not in a popout: popout-mode renderers cannot invoke a sidebar-only route', async () => {
    const row = { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' };

    // Docked: the sidebar surface is the one the main-process handler admits.
    const docked = await loadManagerSidebar();
    docked.api.openSpace = async () => ({ ok: true });
    seed(docked, [row], 't-1');
    docked.renderTabs();
    const dockedLabels = pickHeaderMenuItem(docked, folderHeaders(docked)[0]!, null);
    assert.ok(dockedLabels.some((label) => label.startsWith('Mở Space')), 'a docked folder header menu carries Space');

    // Popout: `antifan:space:open` only admits the sidebar surface, so a renderer that
    // identifies as a popout must not offer an entry guaranteed to be refused.
    const popout = loadStandalone({ popout: true, contextMenuActions: ['assign-capsule'], initialState: MANAGER_STATE });
    await flush();
    popout.assign("terminalTabLayout = 'sidebar';");
    popout.api.openSpace = async () => ({ ok: true });
    seed(popout, [row], 't-1');
    popout.renderTabs();
    assert.ok(folderHeaders(popout)[0], 'the popout still paints the folder section');
    const popoutLabels = pickHeaderMenuItem(popout, folderHeaders(popout)[0]!, null);
    assert.strictEqual(popoutLabels.some((label) => label.includes('Space')), false, 'a popout folder header menu omits Space');
    assert.ok(popoutLabels.some((label) => label.startsWith('Terminal mới')), 'and keeps its new terminal');
  });
});

describe('hub idle project sections', () => {
  const row = (id: string, state: string, folder: string, owner: string) => ({
    id, name: id, state, ownerKey: `project:${owner}`,
    folderKey: `e:\\work\\${folder}`, folderLabel: folder, folderPath: `E:\\Work\\${folder}`,
  });
  const wrapOf = (harness: StandaloneHarness, id: string) =>
    harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${id}"]`);
  const headerFor = (harness: StandaloneHarness, id: string) =>
    folderHeaders(harness).find((h) => (h.querySelector('.terminal-tab-category-label')?.textContent) === id);

  it('keeps a parked row in its project and folds an all-sleeping project to one line', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [row('live', 'running', 'x', 'p1'), row('nap-1', 'sleeping', 'y', 'p2'), row('nap-2', 'sleeping', 'y', 'p2')], 'live');
    harness.renderTabs();

    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-category-header[data-category="__sleeping__"]'),
      null,
      'the manager paints no separate sleep bucket: a project is shown in one place',
    );
    const idle = headerFor(harness, 'y');
    assert.ok(idle, 'the idle project keeps its own section');
    assert.strictEqual(idle.getAttribute('aria-expanded'), 'false', 'an all-sleeping project starts folded');
    assert.match(idle.querySelector('.terminal-tab-category-run-counts')?.textContent ?? '', /☾ 2/);
    assert.strictEqual(wrapOf(harness, 'nap-1')?.classList.contains('is-category-collapsed'), true);
    assert.strictEqual(headerFor(harness, 'x')?.getAttribute('aria-expanded'), 'true', 'a live project stays open');

    // Opening it is session state only: nothing derived leaks into the persisted folds.
    idle.dispatch('click');
    await flush();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(wrapOf(harness, 'nap-1')?.classList.contains('is-category-collapsed'), false);
    const persisted = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
    assert.ok(!persisted?.collapsedCategories?.length, 'a derived fold is never written to prefs');

    // Once a terminal wakes the section is live; when it sleeps again it folds again.
    harness.setSessions([row('live', 'running', 'x', 'p1'), row('nap-1', 'running', 'y', 'p2'), row('nap-2', 'sleeping', 'y', 'p2')]);
    harness.renderTabs();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'true');
    harness.setSessions([row('live', 'running', 'x', 'p1'), row('nap-1', 'sleeping', 'y', 'p2'), row('nap-2', 'sleeping', 'y', 'p2')]);
    harness.renderTabs();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'false');
  });

  it('never folds the section holding the active tab', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [row('live', 'running', 'x', 'p1'), row('nap-1', 'sleeping', 'y', 'p2')], 'nap-1');
    harness.renderTabs();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(wrapOf(harness, 'nap-1')?.classList.contains('is-category-collapsed'), false);

    // A section the user opened by hand, then worked in, folds again once they leave it.
    harness.setActiveId('live');
    harness.renderTabs();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'false', 'leaving the active tab folds it');
    headerFor(harness, 'y')!.dispatch('click');
    await flush();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'true', 'opened by hand');
    harness.setActiveId('nap-1');
    harness.renderTabs();
    harness.setActiveId('live');
    harness.renderTabs();
    assert.strictEqual(headerFor(harness, 'y')?.getAttribute('aria-expanded'), 'false', 'no stale hand-open survives the active spell');
  });
});

describe('hub triage section', () => {
  it('lists ownerless rows at the top and never agent-owned ones', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 'free-1', name: 'Terminal 1', state: 'running', ownerKey: 'unassigned', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
      { id: 'free-2', name: 'Terminal 2', state: 'running', ownerKey: '', folderKey: 'e:\\work\\y', folderLabel: 'y', folderPath: 'E:\\Work\\y', displayLabel: 'y · 1' },
      { id: 'owned', name: 'Terminal 3', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
      { id: 'bot', name: 'Agent', state: 'running', ownerKey: 'agent:tab-9' },
    ], 'free-1');
    harness.renderTabs();

    const triage = harness.tabsRoot.querySelector('.terminal-triage-section');
    assert.ok(triage, 'ownerless rows must surface at the top of the hub');
    const rows = triage.querySelectorAll('.terminal-triage-row');
    assert.strictEqual(rows.length, 2, 'only unassigned and ownerless rows are listed');
    const ids = rows.map((row) => row.getAttribute('data-session-id'));
    assert.deepStrictEqual(ids.sort(), ['free-1', 'free-2']);
    assert.strictEqual(triage.querySelector('.terminal-triage-count')?.textContent, '2');
    assert.strictEqual(triage.querySelector('[data-session-id="bot"]'), null, 'agent rows are refused before they are offered');
  });

  it('opens the assign picker from a triage row with the new-from-folder choice', async () => {
    const harness = await loadManagerSidebar();
    harness.api.listProjects = async () => ({ candidates: [{ projectId: 'p1', name: 'X', workspacePath: 'E:\\Work\\x', capsuleId: 'cap-x' }] });
    seed(harness, [
      { id: 'free-1', name: 'Terminal 1', state: 'running', ownerKey: 'unassigned', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 'free-1');
    harness.renderTabs();

    const assign = harness.tabsRoot.querySelector('.terminal-triage-row .terminal-triage-assign');
    assert.ok(assign, 'a triage row carries its assign button');
    assign.dispatch('click');
    await flush();
    await flush();

    const popover = harness.elements.get('capsulePickerPopover');
    assert.ok(popover);
    assert.strictEqual(popover.style.display, 'block', 'the project inventory opens from the row');
    const fromFolder = popover.querySelector('.terminal-capsule-picker-new-folder');
    assert.ok(fromFolder, 'the picker offers "Dự án mới từ thư mục này" for a folder-bound row');
  });

  it('opens the project from the row folder then assigns the session', async () => {
    const harness = await loadManagerSidebar();
    harness.api.openProjectFromFolder = async () => ({ status: 'OPENED', projectId: 'p-x' });
    harness.api.assignTerminalProject = async () => ({ ok: true });
    harness.api.listProjects = async () => ({ candidates: [] });
    seed(harness, [
      { id: 'free-1', name: 'Terminal 1', state: 'running', ownerKey: 'unassigned', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 'free-1');
    harness.renderTabs();

    harness.tabsRoot.querySelector('.terminal-triage-row .terminal-triage-assign')?.dispatch('click');
    await flush();
    await flush();
    const popover = harness.elements.get('capsulePickerPopover');
    assert.ok(popover);
    popover.querySelector('.terminal-capsule-picker-new-folder')?.dispatch('click');
    await flush();
    await flush();

    assert.deepStrictEqual(lastArgs(harness, 'openProjectFromFolder'), ['E:\\Work\\x'], 'the session\'s own folder is the only project it may open');
    assert.deepStrictEqual(lastArgs(harness, 'assignTerminalProject'), ['free-1', 'p-x'], 'the session is handed to the project its folder resolved to');
  });

  it('vanishes when every row has an owner and in a project shell entirely', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 'owned', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 'owned');
    harness.renderTabs();
    assert.strictEqual(harness.tabsRoot.querySelector('.terminal-triage-section'), null, 'a fully owned hub shows no triage block');

    const projectShell = loadStandalone({
      contextMenuActions: ['assign-capsule'],
      initialState: { projectWindow: { owner: { kind: 'project', projectId: 'p1' }, title: 'X' } },
    });
    await flush();
    projectShell.setSessions([
      { id: 'free-1', name: 'Terminal 1', state: 'running', ownerKey: 'unassigned', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ]);
    projectShell.renderTabs();
    assert.strictEqual(projectShell.tabsRoot.querySelector('.terminal-triage-section'), null, 'the triage is the hub\'s own surface');
    // A project window keeps category grouping: a stamped folderKey changes nothing there.
    assert.strictEqual(
      projectShell.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="folder"]').length,
      0,
      'folder sections never appear outside the manager shell',
    );
  });
});

describe('hub run-state surfaces', () => {
  it('words only the waiting row and tallies both states on the folder header', async () => {
    const harness = await loadManagerSidebar();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 1' },
      { id: 't-2', name: 'Terminal 2', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x', displayLabel: 'x · 2' },
    ], 't-1');
    harness.renderTabs();

    harness.emitRunCardState([
      { terminalSessionId: 't-1', state: 'running', stale: false, mode: 'unset', runSeq: 1 },
      { terminalSessionId: 't-2', state: 'waiting_user', stale: false, mode: 'unset', runSeq: 1 },
    ]);
    await flush();

    const wrapOf = (id: string) => harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${id}"]`);
    assert.strictEqual(wrapOf('t-1')?.querySelector('.terminal-tab-run-badge'), null, 'a running row is told by its icon, not a word');
    assert.strictEqual(wrapOf('t-2')?.querySelector('.terminal-tab-run-badge')?.textContent, 'chờ bạn');
    assert.match(
      wrapOf('t-2')?.querySelector('.terminal-tab-run-badge')?.className ?? '',
      /run-waiting_user/,
      'waiting_user is the highlighted state',
    );
    const counts = folderHeaders(harness)[0]?.querySelector('.terminal-tab-category-run-counts');
    assert.ok(counts, 'the folder header carries its tally');
    assert.match(counts.textContent ?? '', /▶ 1/);
    assert.match(counts.textContent ?? '', /◔ 1/);
  });
});
