/**
 * Per-project appearance (colour + star) on the shared manager's group headers.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the shared vm
 * harness, so they exercise the header controls the hub actually paints rather than a
 * re-implementation of them.
 *
 * The properties this surface lives or dies on:
 *   1. A derived (folder) section whose rows name a project wears that project's id,
 *      colour and star state, and its header carries the controls that write them.
 *   2. Clicking the star writes through `setProjectAppearance` — the optimistic flip is
 *      Main's answer, never the click itself.
 *   3. A header that cannot name a project (a user group, or a folder of ownerless
 *      rows) offers neither control.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const lastArgs = (harness: StandaloneHarness, name: string): unknown[] | undefined =>
  harness.apiCallArgs.filter((entry) => entry.name === name).at(-1)?.args;

/** The shared manager reads every project's rows; project shells read only their own. */
const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
};

/** The inventory entry the appearance map is built from: one coloured, starred project. */
const PROJECT_CANDIDATE = {
  projectId: 'p1',
  title: 'x',
  name: 'x',
  workspacePath: '',
  color: '#ff8800',
  starred: true,
  canAssignTerminal: true,
  isCurrent: false,
};

function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
}

/**
 * Load the renderer as the shared manager in the sidebar layout (group headers only exist
 * there), with the project inventory and the appearance write-back both stubbed. The
 * inventory stub lands before the boot flush so `applyShellScope`'s appearance read sees
 * it; the explicit re-read afterwards keeps the map populated even if boot ordering ever
 * moves the first read earlier.
 */
async function loadManagerWithProjects(): Promise<StandaloneHarness> {
  const harness = loadStandalone({ contextMenuActions: ['assign-capsule'], initialState: MANAGER_STATE });
  harness.api.listProjects = async () => ({ candidates: [PROJECT_CANDIDATE] });
  // Main echoes the record it now holds, so a star write keeps the colour and a colour
  // write keeps the star — the display copy must follow the answer, not the patch.
  harness.api.setProjectAppearance = async (payload: unknown) => {
    const patch = payload as { projectId: string; starred?: boolean; color?: string | null };
    return {
      status: 'UPDATED',
      projectId: patch.projectId,
      color: typeof patch.color === 'string' ? patch.color : PROJECT_CANDIDATE.color,
      starred: typeof patch.starred === 'boolean' ? patch.starred : PROJECT_CANDIDATE.starred,
    };
  };
  await flush();
  await harness.read<() => Promise<boolean>>('ensureProjectAppearance')();
  harness.assign("terminalTabLayout = 'sidebar';");
  harness.apiCalls.length = 0;
  harness.apiCallArgs.length = 0;
  return harness;
}


describe('hub project appearance', () => {
  it('wears the project id, star state and colour on the folder header that owns it', async () => {
    const harness = await loadManagerWithProjects();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 't-1');
    harness.renderTabs();

    const header = harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="project"]');
    assert.ok(header, 'a project-owned row files under a folder section');
    assert.strictEqual(header.getAttribute('data-project-id'), 'p1', 'the section names the project its rows carry');
    assert.strictEqual(header.classList.contains('is-project-starred'), true, 'a starred project marks its section');

    const star = header.querySelector('[data-role="project-star"]');
    assert.ok(star, 'a project-named section carries the star control');
    assert.strictEqual(star.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(star.textContent, '★');

    const color = header.querySelector('[data-role="project-color"]');
    assert.ok(color, 'a project-named section carries the colour control');
    assert.strictEqual(color.value, '#ff8800', 'the picker shows the persisted colour');

    // The colour is paint on the label itself, so it survives a sidebar that hides the input.
    assert.strictEqual(
      header.querySelector('.terminal-tab-category-label')?.style.color,
      '#ff8800',
      'the project colour tints the section name',
    );
  });

  it('writes the star flip through Main when the header star is clicked', async () => {
    const harness = await loadManagerWithProjects();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 't-1');
    harness.renderTabs();

    const header = harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="project"]');
    assert.ok(header);
    const star = header.querySelector('[data-role="project-star"]');
    assert.ok(star);
    star.dispatch('click');
    await flush();

    // The payload was built inside the vm realm, so its prototype differs from a host
    // literal's — JSON normalises it for the exact-payload comparison.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(lastArgs(harness, 'setProjectAppearance'))), [{ projectId: 'p1', starred: false }]);
    // Main confirmed the flip: the repainted header reports the new state.
    assert.strictEqual(header.classList.contains('is-project-starred'), false);
    assert.strictEqual(star.getAttribute('aria-pressed'), 'false');
  });

  it('writes a picked colour through the same route', async () => {
    const harness = await loadManagerWithProjects();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'project:p1', folderKey: 'e:\\work\\x', folderLabel: 'x', folderPath: 'E:\\Work\\x' },
    ], 't-1');
    harness.renderTabs();

    const header = harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="project"]');
    assert.ok(header);
    const color = header.querySelector('[data-role="project-color"]');
    assert.ok(color);
    color.value = '#22d3ee';
    color.dispatch('change');
    await flush();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(lastArgs(harness, 'setProjectAppearance'))), [{ projectId: 'p1', color: '#22d3ee' }]);
  });

  it('shows neither control on a header that cannot name a project', async () => {
    const harness = await loadManagerWithProjects();
    seed(harness, [
      { id: 't-1', name: 'Terminal 1', state: 'running', ownerKey: 'agent:tab-1', category: 'Review' },
      { id: 't-2', name: 'Terminal 2', state: 'running', ownerKey: 'agent:tab-2', folderKey: 'e:\\work\\y', folderLabel: 'y', folderPath: 'E:\\Work\\y' },
    ], 't-1');
    harness.renderTabs();

    // The retired user group is gone entirely: a stored category can no longer mint a
    // header, so the agent row files under the catch-all — which paints no chrome at all.
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="category"]'),
      null,
      'the catch-all is the last stop, not a section with controls',
    );
    const agentRow = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="t-1"]');
    assert.ok(agentRow, 'the agent row still renders as a plain wrap');

    // A derived section whose rows own no project keeps the controls created but hidden.
    const ownerlessFolder = harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="folder"]');
    assert.ok(ownerlessFolder, 'an unattributed row still files under its folder section');
    assert.strictEqual(ownerlessFolder.getAttribute('data-project-id'), null);
    assert.strictEqual(ownerlessFolder.classList.contains('is-project-starred'), false);
    assert.strictEqual(ownerlessFolder.querySelector('[data-role="project-star"]')?.style.display, 'none', 'the star stays hidden while no project owns the section');
    assert.strictEqual(ownerlessFolder.querySelector('[data-role="project-color"]')?.style.display, 'none', 'the colour picker stays hidden while no project owns the section');
  });
});
