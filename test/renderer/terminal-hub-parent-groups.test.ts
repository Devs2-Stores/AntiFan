/**
 * The shared manager's parent-folder blocks: projects grouped under the direct parent
 * directory of their workspace folder.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the shared vm
 * harness, so they exercise the headers the hub actually paints.
 *
 * The properties this surface lives or dies on:
 *   1. One header per parent directory, in a stable order, labelled relative to the
 *      workspace root, with the full path as its tooltip and the project count beside it.
 *   2. A block collapses with its projects, and the fold persists through the same
 *      `collapsedCategories` prefs as every other section.
 *   3. A project is only ordered among the projects of its own block.
 *   4. The awake-first promotion happens inside a block, never across blocks.
 *   5. A row that names no project keeps its fallback section and joins no block.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const lastArgs = (harness: StandaloneHarness, name: string): unknown[] | undefined =>
  harness.apiCallArgs.filter((entry) => entry.name === name).at(-1)?.args;

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
};

/** Project id -> the workspace folder Main's inventory reports for it. */
const WORKSPACES: Record<string, string> = {
  p1: 'E:\\Work\\apps\\AntiFan',
  p2: 'E:\\Work\\apps\\Other',
  p3: 'E:\\Work\\themes\\f1genz\\Lux Shoes',
  p4: 'E:\\Work\\themes\\f1genz\\Garden',
  p5: 'E:\\Work\\FigForYou',
  p6: 'D:\\Elsewhere\\site',
};

/** Two apps and two f1genz themes: every stored project is listed, so a test names exactly the ones it needs. */
const DEFAULT_WORKSPACES: Record<string, string> = { p1: WORKSPACES.p1!, p2: WORKSPACES.p2!, p3: WORKSPACES.p3!, p4: WORKSPACES.p4! };

const APPS = 'parent:e:\\work\\apps';
const THEMES = 'parent:e:\\work\\themes\\f1genz';

async function loadManager(
  workspaces: Record<string, string> = DEFAULT_WORKSPACES,
  initialState: Record<string, unknown> = {},
): Promise<StandaloneHarness> {
  const harness = loadStandalone({ initialState: { ...MANAGER_STATE, ...initialState } });
  harness.api.listProjects = async () => ({
    candidates: [],
    stored: Object.entries(workspaces).map(([projectId, workspacePath]) => ({
      projectId, name: projectId, workspacePath, status: 'LIVE', color: '', starred: false,
    })),
  });
  await flush();
  await harness.read<() => Promise<boolean>>('ensureProjectAppearance')();
  harness.assign("terminalTabLayout = 'sidebar';");
  harness.apiCalls.length = 0;
  harness.apiCallArgs.length = 0;
  return harness;
}

/** A row whose own folder is a sub-folder of the project workspace: the stored path decides. */
const row = (id: string, project: string, state = 'running') => ({
  id, name: id, state, ownerKey: `project:${project}`,
  folderKey: `${WORKSPACES[project]!.toLowerCase()}\\sub`, folderLabel: project,
  folderPath: `${WORKSPACES[project]}\\sub`,
});

const seed = (harness: StandaloneHarness, list: unknown[], active: string): void => {
  harness.setSessions(list);
  harness.setActiveId(active);
  harness.renderTabs();
};

const parentHeaders = (harness: StandaloneHarness): FakeElement[] =>
  harness.tabsRoot.querySelectorAll('.terminal-tab-parent-header');

const projectHeader = (harness: StandaloneHarness, project: string): FakeElement => {
  const header = harness.tabsRoot.querySelector(`.terminal-tab-category-header[data-category="project:${project}"]`);
  assert.ok(header, `project header ${project}`);
  return header;
};

/** Every header in drawn order: parent blocks and project sections interleaved. */
const drawnHeaders = (harness: StandaloneHarness): string[] =>
  harness.tabsRoot.children
    .filter((el) => el.classList.contains('terminal-tab-parent-header') || el.classList.contains('terminal-tab-category-header'))
    .map((el) => el.classList.contains('terminal-tab-parent-header')
      ? el.getAttribute('data-parent-key')!
      : el.getAttribute('data-category') || '');

const wrapOf = (harness: StandaloneHarness, sessionId: string): FakeElement | null =>
  harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${sessionId}"]`);

describe('hub parent-folder blocks', () => {
  it('draws one labelled block per direct parent folder, in a stable order', async () => {
    const harness = await loadManager(WORKSPACES);
    const rows = [row('a', 'p1'), row('b', 'p2'), row('c', 'p3'), row('d', 'p4'), row('e', 'p5'), row('f', 'p6')];
    seed(harness, rows, 'a');

    const blocks = parentHeaders(harness);
    assert.deepStrictEqual(
      blocks.map((h) => h.getAttribute('data-parent-key')),
      ['parent:d:\\elsewhere', 'parent:e:\\work', APPS, THEMES],
      'blocks are ordered by their parent folder, independent of session order',
    );
    assert.deepStrictEqual(
      blocks.map((h) => h.querySelector('.terminal-tab-parent-label')?.textContent),
      ['D:\\Elsewhere', 'WORK', 'APPS', 'THEMES › F1GENZ'],
      'labels are relative to E:\\Work; the root reads WORK; an outside folder shows its full path',
    );
    assert.deepStrictEqual(
      blocks.map((h) => h.title),
      ['D:\\Elsewhere', 'E:\\Work', 'E:\\Work\\apps', 'E:\\Work\\themes\\f1genz'],
      'the tooltip is the full path',
    );
    assert.deepStrictEqual(
      blocks.map((h) => h.querySelector('.terminal-tab-parent-count')?.textContent),
      ['1 dự án', '1 dự án', '2 dự án', '2 dự án'],
    );
    assert.deepStrictEqual(blocks.map((h) => h.getAttribute('data-project-count')), ['1', '1', '2', '2']);
    assert.strictEqual(
      blocks[2]!.querySelector('.terminal-tab-parent-names')?.textContent,
      'p1 · p2',
      'a small block names its projects',
    );

    // Each block header sits directly above its own project sections.
    assert.deepStrictEqual(drawnHeaders(harness), [
      'parent:d:\\elsewhere', 'project:p6',
      'parent:e:\\work', 'project:p5',
      APPS, 'project:p1', 'project:p2',
      THEMES, 'project:p3', 'project:p4',
    ]);

    // Reversing the session list moves no block.
    seed(harness, rows.slice().reverse(), 'a');
    assert.deepStrictEqual(
      parentHeaders(harness).map((h) => h.getAttribute('data-parent-key')),
      ['parent:d:\\elsewhere', 'parent:e:\\work', APPS, THEMES],
    );
  });

  it('lists a stored project with no live terminal under its block and counts it', async () => {
    const harness = await loadManager();
    seed(harness, [row('a', 'p1')], 'a');
    const apps = parentHeaders(harness).find((h) => h.getAttribute('data-parent-key') === APPS);
    assert.ok(apps);
    assert.strictEqual(apps.getAttribute('data-project-count'), '2', 'the seeded project p2 is counted');
    assert.ok(projectHeader(harness, 'p2'), 'the project with no terminal still has its section');
  });

  it('falls back to the folder of a project row when the inventory names no workspace', async () => {
    const harness = await loadManager({});
    seed(harness, [
      { id: 'x', name: 'x', state: 'running', ownerKey: 'project:px', folderKey: 'e:\\work\\apps\\x', folderLabel: 'x', folderPath: 'E:\\Work\\apps\\x' },
    ], 'x');
    assert.deepStrictEqual(parentHeaders(harness).map((h) => h.getAttribute('data-parent-key')), [APPS]);
  });

  it('keeps rows that name no project in their fallback section, outside every block', async () => {
    const harness = await loadManager();
    const loose = { id: 'l', name: 'l', state: 'running', ownerKey: 'agent:tab-9', folderKey: 'e:\\work\\loose', folderLabel: 'loose', folderPath: 'E:\\Work\\loose' };
    seed(harness, [row('a', 'p1'), loose], 'a');

    const folder = harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="folder"]');
    assert.ok(folder, 'the fallback folder section is still drawn');
    assert.strictEqual(folder.getAttribute('data-parent-key'), null, 'it belongs to no block');
    assert.strictEqual(
      parentHeaders(harness).some((h) => h.getAttribute('data-parent-key') === 'parent:e:\\work'),
      false,
      'no block is minted for it',
    );
    assert.strictEqual(wrapOf(harness, 'l')?.classList.contains('is-category-collapsed'), false);
  });

  describe('collapse', () => {
    it('folds the block with its projects and persists the fold through collapsedCategories', async () => {
      const harness = await loadManager();
      seed(harness, [row('a', 'p1'), row('b', 'p2'), row('c', 'p3')], 'c');
      const apps = parentHeaders(harness).find((h) => h.getAttribute('data-parent-key') === APPS)!;
      assert.strictEqual(apps.getAttribute('aria-expanded'), 'true');

      apps.dispatch('click');
      await flush();
      assert.strictEqual(apps.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(projectHeader(harness, 'p1').classList.contains('is-parent-collapsed'), true);
      assert.strictEqual(projectHeader(harness, 'p2').classList.contains('is-parent-collapsed'), true);
      assert.strictEqual(wrapOf(harness, 'a')?.classList.contains('is-category-collapsed'), true, 'its rows fold');
      assert.strictEqual(projectHeader(harness, 'p3').classList.contains('is-parent-collapsed'), false, 'another block is untouched');
      assert.strictEqual(wrapOf(harness, 'c')?.classList.contains('is-category-collapsed'), false);
      const prefs = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
      assert.deepStrictEqual(plain(prefs?.collapsedCategories), [APPS], 'the block key is what is stored');

      apps.dispatch('click');
      await flush();
      assert.strictEqual(apps.getAttribute('aria-expanded'), 'true');
      assert.strictEqual(wrapOf(harness, 'a')?.classList.contains('is-category-collapsed'), false);
      const restored = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { collapsedCategories?: string[] } | undefined;
      assert.deepStrictEqual(plain(restored?.collapsedCategories), []);
    });

    it('opens collapsed when the persisted prefs carry the block key', async () => {
      const harness = await loadManager(DEFAULT_WORKSPACES, {
        terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240, collapsedCategories: [THEMES] },
      });
      seed(harness, [row('a', 'p1'), row('c', 'p3')], 'a');
      const themes = parentHeaders(harness).find((h) => h.getAttribute('data-parent-key') === THEMES)!;
      assert.strictEqual(themes.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(wrapOf(harness, 'c')?.classList.contains('is-category-collapsed'), true);
      assert.strictEqual(wrapOf(harness, 'a')?.classList.contains('is-category-collapsed'), false);
    });

    it('keeps the key out of the user group list', async () => {
      const harness = await loadManager();
      assert.strictEqual(harness.read<(key: string) => boolean>('isDerivedGroupKey')(APPS), true);
    });
  });

  describe('ordering', () => {
    const press = (harness: StandaloneHarness, header: FakeElement): void => {
      header.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10, target: header } as never);
      harness.dispatchWindowPointer('pointermove', { pointerId: 1, clientX: 40, clientY: 40 });
    };
    const release = (harness: StandaloneHarness, over: FakeElement | null): void => {
      harness.setElementFromPoint(over);
      harness.dispatchWindowPointer('pointerup', { pointerId: 1, clientX: 40, clientY: 200 });
    };
    const projectOrder = (harness: StandaloneHarness): string[] =>
      plain(harness.read<() => string[]>('currentProjectKeys')());

    it('refuses a drop onto a project of another parent folder', async () => {
      const harness = await loadManager();
      seed(harness, [row('a', 'p1'), row('b', 'p2'), row('c', 'p3')], 'a');
      const before = projectOrder(harness);

      const p1 = projectHeader(harness, 'p1');
      press(harness, p1);
      release(harness, projectHeader(harness, 'p3'));
      await flush();
      assert.strictEqual(lastArgs(harness, 'setTerminalTabPrefs'), undefined, 'a cross-block drop stores nothing');
      assert.deepStrictEqual(projectOrder(harness), before);

      // The model refuses it too, whatever drives it.
      harness.read<(a: string, b: string, after: boolean) => void>('moveProjectGroup')('project:p1', 'project:p3', true);
      assert.deepStrictEqual(projectOrder(harness), before);
      assert.strictEqual(lastArgs(harness, 'setTerminalTabPrefs'), undefined);
    });

    it('accepts a drop onto a project of the same parent folder and stores the order', async () => {
      const harness = await loadManager();
      seed(harness, [row('a', 'p1'), row('b', 'p2'), row('c', 'p3')], 'a');

      press(harness, projectHeader(harness, 'p1'));
      // Every stub reports the same rect (top 40, height 175), so a release at y=200 is below the midpoint: after the target.
      release(harness, projectHeader(harness, 'p2'));
      await flush();
      const prefs = lastArgs(harness, 'setTerminalTabPrefs')?.[0] as { projectOrder?: string[] } | undefined;
      assert.ok(prefs?.projectOrder, 'a same-block drop is stored');
      assert.deepStrictEqual(
        drawnHeaders(harness).filter((k) => k.startsWith('project:')),
        ['project:p2', 'project:p1', 'project:p3', 'project:p4'],
      );
    });

    it('steps Alt+Arrow only among the projects of the same parent folder', async () => {
      const harness = await loadManager();
      seed(harness, [row('a', 'p1'), row('b', 'p2'), row('c', 'p3')], 'a');
      const p2 = projectHeader(harness, 'p2');
      // p2 is last in its block: the next project drawn (p3) belongs to another block.
      p2.dispatch('keydown', { key: 'ArrowDown', altKey: true, target: p2 } as never);
      await flush();
      assert.strictEqual(lastArgs(harness, 'setTerminalTabPrefs'), undefined, 'a step into another block is refused');

      p2.dispatch('keydown', { key: 'ArrowUp', altKey: true, target: p2 } as never);
      await flush();
      assert.ok(lastArgs(harness, 'setTerminalTabPrefs'), 'a step inside the block is stored');
    });
  });

  describe('awake promotion', () => {
    const drawnProjects = (harness: StandaloneHarness): string[] =>
      drawnHeaders(harness).filter((k) => k.startsWith('project:'));

    it('promotes awake projects inside their own block only', async () => {
      const harness = await loadManager();
      seed(harness, [
        row('a', 'p1', 'sleeping'), row('b', 'p2', 'running'),
        row('c', 'p3', 'sleeping'), row('d', 'p4', 'sleeping'),
      ], 'b');
      const blockOrder = () => parentHeaders(harness).map((h) => h.getAttribute('data-parent-key'));
      assert.deepStrictEqual(blockOrder(), [APPS, THEMES]);
      assert.deepStrictEqual(drawnProjects(harness), ['project:p2', 'project:p1', 'project:p3', 'project:p4']);
      assert.strictEqual(projectHeader(harness, 'p2').classList.contains('is-awake-promoted'), true);
      assert.strictEqual(projectHeader(harness, 'p1').classList.contains('is-promotion-boundary'), true, 'the dashed rule sits inside the block');
      assert.strictEqual(projectHeader(harness, 'p3').classList.contains('is-promotion-boundary'), false, 'a block with nothing awake has no rule');

      // An awake project in the later block does not lift it above the earlier block.
      seed(harness, [
        row('a', 'p1', 'sleeping'), row('b', 'p2', 'sleeping'),
        row('c', 'p3', 'sleeping'), row('d', 'p4', 'running'),
      ], 'd');
      assert.deepStrictEqual(blockOrder(), [APPS, THEMES], 'blocks never jump around');
      assert.deepStrictEqual(drawnProjects(harness), ['project:p1', 'project:p2', 'project:p4', 'project:p3']);
      assert.strictEqual(projectHeader(harness, 'p1').classList.contains('is-promotion-boundary'), false);
      assert.strictEqual(projectHeader(harness, 'p3').classList.contains('is-promotion-boundary'), true);
      assert.strictEqual(projectHeader(harness, 'p1').classList.contains('is-awake-promoted'), false);
    });
  });
});
