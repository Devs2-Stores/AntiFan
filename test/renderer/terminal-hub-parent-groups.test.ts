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
 *   4. An awake project is lifted above every block, out of its own, and drops back into its
 *      block when it sleeps.
 *   5. A section no parent folder holds (a project of unknown folder, the fallback section of
 *      rows no project claims) is filed in the trailing `KHÁC` block, never drawn loose.
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
const OTHER = 'parent:*';

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

/**
 * A row whose own folder is a sub-folder of the project workspace: the stored path decides.
 * The default state is `exited` (no live shell): an awake section is lifted out of its block,
 * which the promotion tests cover, so the block tests use rows that keep their place.
 */
const row = (id: string, project: string, state = 'exited') => ({
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
      { id: 'x', name: 'x', state: 'exited', ownerKey: 'project:px', folderKey: 'e:\\work\\apps\\x', folderLabel: 'x', folderPath: 'E:\\Work\\apps\\x' },
    ], 'x');
    assert.deepStrictEqual(parentHeaders(harness).map((h) => h.getAttribute('data-parent-key')), [APPS]);
  });

  it('files rows that name no project in their fallback section under the trailing KHÁC block', async () => {
    const harness = await loadManager();
    const loose = { id: 'l', name: 'l', state: 'exited', ownerKey: 'agent:tab-9', folderKey: 'e:\\work\\loose', folderLabel: 'loose', folderPath: 'E:\\Work\\loose' };
    seed(harness, [row('a', 'p1'), loose], 'a');

    const folder = harness.tabsRoot.querySelector('.terminal-tab-category-header[data-group-kind="folder"]');
    assert.ok(folder, 'the fallback folder section is still drawn');
    assert.strictEqual(folder.getAttribute('data-parent-key'), OTHER);
    assert.strictEqual(
      parentHeaders(harness).some((h) => h.getAttribute('data-parent-key') === 'parent:e:\\work'),
      false,
      'no block is minted from the row folder of a project-less row',
    );
    assert.strictEqual(drawnHeaders(harness).at(-2), OTHER, 'KHÁC is the last block');
    assert.strictEqual(wrapOf(harness, 'l')?.classList.contains('is-category-collapsed'), false);
  });

  it('never strands a project of unknown folder between the awake sections and the blocks', async () => {
    const harness = await loadManager({ ...DEFAULT_WORKSPACES, hub: '' });
    seed(harness, [
      row('a', 'p1', 'sleeping'), row('b', 'p2', 'sleeping'),
      row('c', 'p3', 'running'), row('d', 'p4', 'sleeping'),
      { id: 'h', name: 'h', state: 'exited', ownerKey: 'project:hub' },
    ], 'c');
    assert.deepStrictEqual(drawnHeaders(harness), [
      'project:p3',
      APPS, 'project:p1', 'project:p2',
      THEMES, 'project:p4',
      OTHER, 'project:hub',
    ]);
    const other = parentHeaders(harness).find((h) => h.getAttribute('data-parent-key') === OTHER)!;
    assert.strictEqual(other.querySelector('.terminal-tab-parent-label')?.textContent, 'KHÁC');
    assert.strictEqual(other.querySelector('.terminal-tab-parent-count')?.textContent, '1 mục');
    assert.ok(other.title, 'the block explains what it holds');
    const apps = parentHeaders(harness).find((h) => h.getAttribute('data-parent-key') === APPS)!;
    assert.strictEqual(apps.classList.contains('is-promotion-boundary'), true, 'the rule sits on the first block after the awake sections');

    other.dispatch('click');
    await flush();
    assert.strictEqual(projectHeader(harness, 'hub').classList.contains('is-parent-collapsed'), true, 'KHÁC folds like any block');
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
    it('lifts an awake project above every block, out of its own block and its fold', async () => {
      const harness = await loadManager();
      seed(harness, [
        row('a', 'p1', 'sleeping'), row('b', 'p2', 'sleeping'),
        row('c', 'p3', 'sleeping'), row('d', 'p4', 'running'),
      ], 'd');
      assert.deepStrictEqual(drawnHeaders(harness), [
        'project:p4',
        APPS, 'project:p1', 'project:p2',
        THEMES, 'project:p3',
      ], 'the awake project of the later block is drawn first, above the earlier block');
      assert.strictEqual(projectHeader(harness, 'p4').classList.contains('is-awake-promoted'), true);
      const header = (key: string): FakeElement => parentHeaders(harness).find((h) => h.getAttribute('data-parent-key') === key)!;
      assert.strictEqual(header(APPS).classList.contains('is-promotion-boundary'), true, 'the rule sits where the blocks resume');
      assert.strictEqual(header(THEMES).classList.contains('is-promotion-boundary'), false);
      assert.strictEqual(projectHeader(harness, 'p1').classList.contains('is-promotion-boundary'), false, 'no second rule under the block header');
      assert.strictEqual(header(THEMES).getAttribute('data-project-count'), '1', 'the block counts the projects drawn under it');

      header(THEMES).dispatch('click');
      await flush();
      assert.strictEqual(projectHeader(harness, 'p3').classList.contains('is-parent-collapsed'), true);
      assert.strictEqual(projectHeader(harness, 'p4').classList.contains('is-parent-collapsed'), false, 'folding its block never hides an awake project');
      assert.strictEqual(wrapOf(harness, 'd')?.classList.contains('is-category-collapsed'), false);
    });

    it('draws no header for a block whose projects are all awake, and puts a project back when it sleeps', async () => {
      const harness = await loadManager();
      seed(harness, [
        row('a', 'p1', 'sleeping'), row('b', 'p2', 'sleeping'),
        row('c', 'p3', 'running'), row('d', 'p4', 'running'),
      ], 'c');
      assert.deepStrictEqual(drawnHeaders(harness), ['project:p3', 'project:p4', APPS, 'project:p1', 'project:p2']);

      seed(harness, [
        row('a', 'p1', 'sleeping'), row('b', 'p2', 'sleeping'),
        row('c', 'p3', 'sleeping'), row('d', 'p4', 'sleeping'),
      ], 'c');
      assert.deepStrictEqual(drawnHeaders(harness), [APPS, 'project:p1', 'project:p2', THEMES, 'project:p3', 'project:p4']);
      assert.strictEqual(parentHeaders(harness).some((h) => h.classList.contains('is-promotion-boundary')), false, 'nothing awake, no rule');
    });
  });
});
