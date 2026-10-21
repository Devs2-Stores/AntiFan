/**
 * Shared manager: reconciled project health on the section header, and the legacy
 * category migration (a user category that only mirrors a project name).
 *
 * Both drive the real `src/renderer/standalone.js` in the vm harness.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
};

const CANDIDATE = { projectId: 'p1', title: 'x', name: 'x', workspacePath: '', canAssignTerminal: true };
const ROW = { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' };

async function loadManager(stored: unknown[]): Promise<StandaloneHarness> {
  const harness = loadStandalone({ contextMenuActions: ['assign-capsule'], initialState: MANAGER_STATE });
  harness.api.listProjects = async () => ({ candidates: [CANDIDATE], stored });
  await flush();
  await harness.read<() => Promise<boolean>>('ensureProjectAppearance')();
  harness.assign("terminalTabLayout = 'sidebar';");
  harness.setSessions([ROW]);
  harness.setActiveId('t-1');
  return harness;
}

const header = (harness: StandaloneHarness, kind: string) =>
  harness.tabsRoot.querySelector(`.terminal-tab-category-header[data-group-kind="${kind}"]`);

describe('hub project status', () => {
  it('marks a section STALE from Main\'s stored inventory and never a LIVE one', async () => {
    const stale = await loadManager([{ projectId: 'p1', name: 'x', workspacePath: 'E:\\gone', status: 'STALE', statusReason: 'workspace-path-missing' }]);
    stale.renderTabs();
    const staleHeader = header(stale, 'project');
    assert.ok(staleHeader);
    assert.strictEqual(staleHeader.getAttribute('data-project-status'), 'STALE');
    assert.strictEqual(staleHeader.classList.contains('is-project-stale'), true);

    const live = await loadManager([{ projectId: 'p1', name: 'x', workspacePath: 'E:\\gone', status: 'LIVE', statusReason: 'live-session' }]);
    live.renderTabs();
    const liveHeader = header(live, 'project');
    assert.ok(liveHeader);
    assert.strictEqual(liveHeader.getAttribute('data-project-status'), 'LIVE');
    assert.strictEqual(liveHeader.classList.contains('is-project-stale'), false);
  });

  it('drops the status again when Main stops reporting it', async () => {
    const harness = await loadManager([{ projectId: 'p1', name: 'x', workspacePath: '', status: 'STALE', statusReason: 'workspace-path-missing' }]);
    harness.renderTabs();
    harness.api.listProjects = async () => ({ candidates: [CANDIDATE], stored: [] });
    await harness.read<() => Promise<boolean>>('ensureProjectAppearance')();
    harness.renderTabs();
    assert.strictEqual(header(harness, 'project')?.getAttribute('data-project-status'), null);
  });

  it('shows a newly created project as soon as Main says the list moved', async () => {
    const harness = await loadManager([{ projectId: 'p1', name: 'x', workspacePath: 'E:\\Work\\x', status: 'LIVE', statusReason: 'live-session' }]);
    harness.renderTabs();
    const ids = () => Array.from(harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="project"]'))
      .map((h: { getAttribute(n: string): string | null }) => h.getAttribute('data-project-id'));
    assert.deepStrictEqual(ids(), ['p1']);

    harness.api.listProjects = async () => ({
      candidates: [CANDIDATE],
      stored: [
        { projectId: 'p1', name: 'x', workspacePath: 'E:\\Work\\x', status: 'LIVE', statusReason: 'live-session' },
        { projectId: 'hapas', name: 'Hapas', workspacePath: 'E:\\Work\\hapas', status: 'LIVE', statusReason: 'live-window' },
      ],
    });
    harness.emitProjectInventoryChanged();
    await flush();
    await flush();
    assert.deepStrictEqual(ids().sort(), ['hapas', 'p1'], 'the new project gets its section without a restart');
  });

  it('lists every stored project, with the name and why for a stale one, terminal or not', async () => {
    const harness = await loadManager([
      { projectId: 'p1', name: 'x', workspacePath: 'E:\\Work\\x', status: 'LIVE', statusReason: 'live-session' },
      { projectId: 'gone', name: 'Old shop', workspacePath: 'E:\\gone', status: 'STALE', statusReason: 'workspace-path-missing' },
      { projectId: 'kept', name: 'Parked', workspacePath: 'E:\\parked', status: 'DEAD', statusReason: 'closed-resumable' },
    ]);
    harness.renderTabs();
    const headers = Array.from(harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="project"]'));
    const byId = new Map(headers.map((h: { getAttribute(n: string): string | null }) => [h.getAttribute('data-project-id'), h]));
    const gone = byId.get('gone') as { getAttribute(n: string): string | null; title: string; classList: { contains(c: string): boolean } } | undefined;
    assert.ok(gone, 'a stale project with no terminal still gets a section');
    assert.strictEqual(gone.getAttribute('data-project-status'), 'STALE');
    assert.strictEqual(gone.classList.contains('is-project-stale'), true);
    assert.match(gone.title, /E:\\gone/);
    assert.match(gone.title, /không còn tồn tại/);
    assert.ok(byId.has('p1'), 'the live project keeps its section');
    const kept = byId.get('kept') as { getAttribute(n: string): string | null } | undefined;
    assert.ok(kept, 'a healthy closed project is listed too: the Terminal Manager shows the whole inventory');
    assert.strictEqual(kept.getAttribute('data-project-status'), 'DEAD');
  });

  it('files two folders of one project under a single project section', async () => {
    const harness = await loadManager([]);
    harness.setSessions([
      ROW,
      { id: 't-2', name: 'Terminal 2', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x2', folderLabel: 'x2', folderPath: 'E:\\Work\\x2' },
      { id: 't-3', name: 'Terminal 3', state: 'running', ownerKey: 'unassigned', folderKey: 'e:\\work\\z', folderLabel: 'z', folderPath: 'E:\\Work\\z' },
    ]);
    harness.renderTabs();
    assert.strictEqual(harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="project"]').length, 1);
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="folder"]').length,
      0,
      'ownerless rows render once, in triage, not in a folder section',
    );
    assert.ok(harness.tabsRoot.querySelector('.terminal-triage-row[data-session-id="t-3"]'));
  });
});

describe('hub legacy category removal', () => {
  it('never renders stored user categories, even ones no project name matches', async () => {
    const harness = await loadManager([]);
    harness.assign("terminalCategories = ['x', 'Review'];");
    harness.renderTabs();
    harness.renderTabs();

    const headers = harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="category"]');
    assert.strictEqual(headers.length, 0, 'no legacy classification header is seeded in the manager');
    assert.ok(header(harness, 'project'), 'the project section still holds the row');
  });

  it('shows an unattributed row only in triage, never under its stale category', async () => {
    const harness = await loadManager([]);
    harness.assign("terminalCategories = ['x'];");
    harness.setSessions([ROW, { id: 't-2', name: 'Terminal 2', state: 'running', ownerKey: 'unassigned', category: 'x' }]);
    harness.renderTabs();
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="category"]').length,
      0,
      'the stored category name stays out of the sidebar',
    );
    const triageRow = harness.tabsRoot.querySelector('.terminal-triage-row[data-session-id="t-2"]');
    assert.ok(triageRow, 'the unattributed row is listed in "Chưa gắn dự án" triage');
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-wrap[data-session-id="t-2"]').length,
      0,
      'a triaged row is not also filed into a group',
    );
  });

  it('lists an ownerless row only in triage — even one carrying a folder', async () => {
    const harness = await loadManager([]);
    harness.setSessions([
      ROW,
      { id: 't-2', name: 'Terminal 2', state: 'running', ownerKey: 'unassigned', folderKey: 'e:\\work\\z', folderLabel: 'z', folderPath: 'E:\\Work\\z' },
    ]);
    harness.renderTabs();
    const triageRow = harness.tabsRoot.querySelector('.terminal-triage-row[data-session-id="t-2"]');
    assert.ok(triageRow, 'ownerless rows are triage business — assigning them is what the section is for');
    assert.strictEqual(
      harness.tabsRoot.querySelectorAll('.terminal-tab-wrap[data-session-id="t-2"]').length,
      0,
      'a triaged row must not also render inside a folder group',
    );
  });

  it('keeps an agent-owned orphan in the catch-all group, out of triage', async () => {
    const harness = await loadManager([]);
    harness.setSessions([ROW, { id: 't-9', name: 'Agent work', state: 'running', ownerKey: 'agent:codex' }]);
    harness.renderTabs();
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-triage-row[data-session-id="t-9"]'),
      null,
      'agent rows are never triage rows',
    );
    const wrap = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="t-9"]');
    assert.ok(wrap, 'an unattributable agent row is still listed — the catch-all paints no header anymore');
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="category"]'),
      null,
      'the catch-all never renders a header',
    );
  });
});

describe('hub search by section name', () => {
  const MNB = { projectId: 'mnb', name: 'Mnbakery', workspacePath: 'E:\\Work\\customizes\\Mnbakery', status: 'DEAD', statusReason: 'closed-resumable' };
  const projectIds = (harness: StandaloneHarness): Array<string | null> =>
    Array.from(harness.tabsRoot.querySelectorAll('.terminal-tab-category-header[data-group-kind="project"]'))
      .map((h: { getAttribute(n: string): string | null }) => h.getAttribute('data-project-id'));
  const rowIds = (harness: StandaloneHarness): Array<string | null> =>
    Array.from(harness.tabsRoot.querySelectorAll('.terminal-tab-wrap'))
      .map((w: { getAttribute(n: string): string | null }) => w.getAttribute('data-session-id'));
  const emptyNotice = (harness: StandaloneHarness) => harness.tabsRoot.querySelector('.terminal-tab-search-empty');
  const search = (harness: StandaloneHarness, query: string): void => {
    harness.assign(`setTabSearchQuery(${JSON.stringify(query)})`);
  };

  it('finds a stored project with no terminal by its name, in any case', async () => {
    const harness = await loadManager([MNB]);
    for (const query of ['mn', 'MN', 'bakery']) {
      search(harness, query);
      assert.deepStrictEqual(projectIds(harness), ['mnb'], `"${query}" keeps the Mnbakery section`);
      assert.deepStrictEqual(rowIds(harness), [], 'the section has no row to show');
      assert.strictEqual(emptyNotice(harness), null, `"${query}" is not reported as a miss`);
    }

    search(harness, 'mnbakery zzz');
    assert.deepStrictEqual(projectIds(harness), [], 'every token must match');
    assert.ok(emptyNotice(harness), 'a real miss still says so');
  });

  it('keeps the header of a name-matched project with zero terminals while sibling sections with terminals drop out', async () => {
    const harness = await loadManager([MNB]);
    harness.renderTabs();
    assert.deepStrictEqual(rowIds(harness), ['t-1'], 'the other project has a terminal');

    search(harness, 'Mnbakery');
    assert.deepStrictEqual(projectIds(harness), ['mnb'], 'the zero-terminal project keeps its section header');
    assert.deepStrictEqual(rowIds(harness), [], 'no row survives: the matched section is empty');
    assert.strictEqual(emptyNotice(harness), null, 'the empty notice stays hidden while a header is shown');

    search(harness, '');
    assert.deepStrictEqual(projectIds(harness).sort(), ['mnb', 'p1'], 'clearing the query restores both sections');
    assert.strictEqual(emptyNotice(harness), null);
  });

  it('keeps a matched section whole and narrows by section and row text together', async () => {
    const harness = await loadManager([MNB]);
    const folder = { folderKey: 'e:\\work\\customizes\\mnbakery', folderLabel: 'Mnbakery', folderPath: 'E:\\Work\\customizes\\Mnbakery' };
    harness.setSessions([
      ROW,
      { id: 'm-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:mnb', ...folder },
      { id: 'm-2', name: 'Terminal 2', state: 'running', ownerKey: 'project:mnb', ...folder },
    ]);

    search(harness, 'mn');
    assert.deepStrictEqual(rowIds(harness).sort(), ['m-1', 'm-2'], 'a section found by name shows every row in it');

    search(harness, 'mnbakery 2');
    assert.deepStrictEqual(rowIds(harness), ['m-2'], 'the second token narrows inside the named section');
    assert.deepStrictEqual(projectIds(harness), ['mnb']);
  });

  it('never matches a fuzzy token across two folders of one section', async () => {
    const harness = await loadManager([MNB]);
    harness.setSessions([
      { id: 'm-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:mnb', folderKey: 'e:\\work\\customizes\\mnbakery', folderLabel: 'Mnbakery', folderPath: 'E:\\Work\\customizes\\Mnbakery' },
      { id: 'm-2', name: 'Terminal 2', state: 'running', ownerKey: 'project:mnb', folderKey: 'e:\\work\\qq-shop', folderLabel: 'qq-shop', folderPath: 'E:\\Work\\qq-shop' },
    ]);
    // "y" only ends the first folder and "qq" only names the second: the header's joined
    // hint holds the pair in order, no single field does.
    search(harness, 'yqq');
    assert.deepStrictEqual(projectIds(harness), [], 'no field holds the whole token');
    assert.ok(emptyNotice(harness));

    search(harness, 'qq-shop');
    assert.deepStrictEqual(projectIds(harness), ['mnb'], 'each folder still matches on its own');
  });
});
