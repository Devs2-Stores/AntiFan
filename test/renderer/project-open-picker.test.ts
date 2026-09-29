/**
 * The in-window "Mở dự án" picker in the terminal renderer.
 *
 * These tests drive the shipped `src/renderer/standalone.js` inside the shared vm harness,
 * delivering the `PROJECT_OPEN_PICKER` push through the captured listener exactly the way
 * Main's `safeSendWebContents` would. What is pinned here is the interaction contract the
 * native dialog could not keep:
 *   1. ONE click on a project row is the whole pick — it answers `{kind:'project'}` exactly
 *      once, with no selection-then-confirm step for a second click to complete.
 *   2. Esc answers `{kind:'cancelled'}` and clicking a footer action answers that action.
 *   3. Typing filters the rows and Enter picks the highlighted one.
 *   4. `Chọn thư mục…` answers `{kind:'folder'}` — the folder chooser stays a real answer
 *      even when the inventory is empty.
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

/**
 * The last payload this API was called with, as this realm's own object. The renderer runs
 * in the harness's vm context, so its literals carry that context's prototypes and a strict
 * deep comparison against a literal here would fail on identity rather than on content.
 * Round-tripping through JSON compares exactly what crosses the IPC boundary.
 */
const wire = (harness: StandaloneHarness, name: string): unknown =>
  JSON.parse(JSON.stringify(lastArgs(harness, name) ?? null));

const PROJECTS = [
  { projectId: 'project-comnieu', name: 'Comnieu', workspacePath: 'E:\\Work\\comnieu' },
  { projectId: 'project-phukien', name: 'Phukienmymoc', workspacePath: 'E:\\Work\\phukienmymoc' },
  { projectId: 'project-donhang', name: 'Don-hang', workspacePath: 'E:\\Work\\don-hang', isCurrent: true },
];

const overlay = (harness: StandaloneHarness): FakeElement => {
  const el = harness.elements.get('projectOpenOverlay');
  assert.ok(el, 'the picker overlay element must exist');
  return el;
};

const rows = (harness: StandaloneHarness): FakeElement[] =>
  overlay(harness).querySelectorAll('.project-open-row');

const key = (k: string): KeyEventLike => ({
  key: k,
  preventDefault: () => {},
  stopPropagation: () => {},
});

/**
 * The modal's keyboard lives on `document` in the capture phase, so the harness records
 * it among the renderer's other keydown listeners; listeners added after the push are the
 * ones this modal bound.
 */
function pressDocumentKey(harness: StandaloneHarness, beforeCount: number, k: string): void {
  for (const listener of [...harness.documentKeydownListeners.slice(beforeCount)]) listener(key(k));
}

/** Load the renderer, answer the inventory with `PROJECTS`, and push one picker request. */
async function openPicker(harness: StandaloneHarness, requestId = 'req-1'): Promise<{ input: FakeElement }> {
  harness.api.listProjects = async () => ({ candidates: PROJECTS });
  harness.emitProjectPicker({ requestId });
  await flush();
  await flush();
  assert.strictEqual(overlay(harness).style.display, 'flex', 'the push shows the modal');
  const input = harness.elements.get('projectOpenInput');
  assert.ok(input, 'the search input must exist');
  return { input };
}

describe('Renderer project-open picker', () => {
  it('answers {kind:"project"} exactly once on a single row click', async () => {
    const harness = loadStandalone();
    await flush();
    harness.apiCalls.length = 0;
    await openPicker(harness);

    const target = rows(harness).find((row) => row.getAttribute('data-project-id') === 'project-phukien');
    assert.ok(target, 'the pushed inventory is painted as rows');

    target.dispatch('click');
    target.dispatch('click'); // a second click has no modal left to answer with
    await flush();

    assert.strictEqual(countCalls(harness, 'answerProjectOpenPicker'), 1, 'one pick answers once');
    assert.deepStrictEqual(wire(harness, 'answerProjectOpenPicker'), [
      { requestId: 'req-1', choice: { kind: 'project', projectId: 'project-phukien' } },
    ]);
    assert.strictEqual(overlay(harness).style.display, 'none', 'picking closes the modal');
  });

  it('answers {kind:"cancelled"} on Escape', async () => {
    const harness = loadStandalone();
    await flush();
    harness.apiCalls.length = 0;
    const keydownBefore = harness.documentKeydownListeners.length;
    await openPicker(harness);

    pressDocumentKey(harness, keydownBefore, 'Escape');
    await flush();

    assert.deepStrictEqual(wire(harness, 'answerProjectOpenPicker'), [
      { requestId: 'req-1', choice: { kind: 'cancelled' } },
    ]);
    assert.strictEqual(overlay(harness).style.display, 'none');
  });

  it('filters rows as the user types and Enter picks the highlighted row', async () => {
    const harness = loadStandalone();
    await flush();
    harness.apiCalls.length = 0;
    const keydownBefore = harness.documentKeydownListeners.length;
    const { input } = await openPicker(harness);

    // A path fragment filters as literally as a name does.
    input.value = 'phukien';
    input.dispatch('input');
    assert.deepStrictEqual(
      rows(harness).map((row) => row.getAttribute('data-project-id')),
      ['project-phukien'],
      'only the matching project stays offered',
    );

    pressDocumentKey(harness, keydownBefore, 'Enter');
    await flush();

    assert.deepStrictEqual(wire(harness, 'answerProjectOpenPicker'), [
      { requestId: 'req-1', choice: { kind: 'project', projectId: 'project-phukien' } },
    ], 'Enter answers the highlighted row — no second step');

    // A query nothing matches says so instead of offering the unfiltered list.
    harness.apiCalls.length = 0;
    harness.emitProjectPicker({ requestId: 'req-2' });
    await flush();
    await flush();
    input.value = 'khong-co-du-an-nao';
    input.dispatch('input');
    assert.deepStrictEqual(rows(harness), [], 'no row is offered for a query nothing matches');
    assert.match(
      overlay(harness).querySelector('.project-open-message')?.textContent ?? '',
      /Không có dự án nào khớp/,
    );
  });

  it('moves the highlight with the arrows before Enter answers it', async () => {
    const harness = loadStandalone();
    await flush();
    harness.apiCalls.length = 0;
    const keydownBefore = harness.documentKeydownListeners.length;
    await openPicker(harness);

    pressDocumentKey(harness, keydownBefore, 'ArrowDown');
    assert.ok(
      rows(harness)[1]?.classList.contains('is-highlighted'),
      'the second row is the one Enter would pick',
    );

    pressDocumentKey(harness, keydownBefore, 'Enter');
    await flush();

    assert.deepStrictEqual(wire(harness, 'answerProjectOpenPicker'), [
      { requestId: 'req-1', choice: { kind: 'project', projectId: 'project-phukien' } },
    ]);
  });

  it('answers {kind:"folder"} on "Chọn thư mục…"', async () => {
    const harness = loadStandalone();
    await flush();
    harness.apiCalls.length = 0;
    await openPicker(harness);

    const folder = harness.elements.get('projectOpenFolder');
    assert.ok(folder, 'the folder action must exist');
    folder.dispatch('click');
    await flush();

    assert.deepStrictEqual(wire(harness, 'answerProjectOpenPicker'), [
      { requestId: 'req-1', choice: { kind: 'folder' } },
    ]);
    assert.strictEqual(overlay(harness).style.display, 'none');
  });

  it('marks the project this window already owns as the current row', async () => {
    const harness = loadStandalone();
    await flush();
    await openPicker(harness);

    const current = rows(harness).find((row) => row.getAttribute('data-project-id') === 'project-donhang');
    assert.ok(current?.classList.contains('is-current'), 'the current project is marked');
    assert.match(current?.querySelector('.project-open-row-current')?.textContent ?? '', /Hiện tại/);
    // Names and paths are painted as text, never parsed markup.
    assert.strictEqual(
      current?.querySelector('.project-open-row-path')?.textContent,
      'E:\\Work\\don-hang',
    );
  });
});

/**
 * The row-level CRUD the same modal now hosts: rename edits inline, remove asks in
 * the row — quoting the live-terminal count Main reported — and only the confirm
 * strip sends the `REMOVE_ANSWER` consent. A row mid-edit never answers a pick.
 */
describe('Renderer project manager CRUD', () => {
  it('rename edits the row inline and Enter commits through renameProject', async () => {
    const harness = loadStandalone();
    await flush();
    harness.api.renameProject = async () => ({ status: 'RENAMED', projectId: 'project-phukien', name: 'Phukien Moi' });
    await openPicker(harness);

    const row = rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien');
    assert.ok(row, 'the target row exists');
    const renameBtn = row.querySelector('.project-open-row-action');
    assert.ok(renameBtn, 'the row carries a rename action');
    renameBtn.dispatch('click');
    await flush();

    const editing = rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien');
    const input = editing?.querySelector('.project-open-row-rename-input');
    assert.ok(input, 'the name line becomes an inline input');
    input.value = 'Phukien Moi';
    input.dispatch('keydown', { key: 'Enter' });
    await flush();
    await flush();

    assert.deepStrictEqual(wire(harness, 'renameProject'), [
      { projectId: 'project-phukien', name: 'Phukien Moi' },
    ]);
    assert.strictEqual(
      rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
        ?.querySelector('.project-open-row-name')?.textContent,
      'Phukien Moi',
      'the row repaints with the renamed label',
    );
  });

  it('a refused rename keeps the input up with the reason instead of losing the name', async () => {
    const harness = loadStandalone();
    await flush();
    harness.api.renameProject = async () => ({ status: 'FAILED', projectId: 'project-phukien', reason: 'NO_NAME_RECORD' });
    await openPicker(harness);

    rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
      ?.querySelector('.project-open-row-action')?.dispatch('click');
    await flush();
    const editing = rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien');
    const input = editing?.querySelector('.project-open-row-rename-input');
    assert.ok(input, 'the name line becomes an inline input');
    input!.value = 'Anything';
    input!.dispatch('keydown', { key: 'Enter' });
    await flush();
    await flush();

    const stillEditing = rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
      ?.querySelector('.project-open-row-rename-input');
    assert.ok(stillEditing, 'the edit stays open for correction');
    assert.match(
      rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
        ?.querySelector('.project-open-row-error')?.textContent ?? '',
      /NO_NAME_RECORD/,
    );
  });

  it('remove with live terminals quotes the count and confirms through REMOVE_ANSWER', async () => {
    const harness = loadStandalone();
    await flush();
    harness.api.removeProject = async () => ({ status: 'CONFIRM_REQUIRED', projectId: 'project-phukien', liveSessions: 2 });
    harness.api.answerProjectRemove = async () => ({ status: 'REMOVED', projectId: 'project-phukien' });
    await openPicker(harness);

    const row = rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien');
    const removeBtn = row?.querySelector('.project-open-row-action.is-danger');
    assert.ok(removeBtn, 'the row carries a remove action');
    removeBtn.dispatch('click');
    await flush();
    await flush();

    const strip = rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
      ?.querySelector('.project-open-row-confirm');
    assert.ok(strip, 'the row switches to its inline confirm');
    assert.match(
      strip.querySelector('.project-open-row-confirm-text')?.textContent ?? '',
      /2 Terminal/,
      'the strip quotes the live count Main reported',
    );
    // While the confirm is up, the row no longer answers a pick.
    assert.strictEqual(countCalls(harness, 'answerProjectOpenPicker'), 0);

    strip.querySelector('.project-open-row-confirm-btn.is-danger')?.dispatch('click');
    await flush();
    await flush();

    assert.deepStrictEqual(wire(harness, 'answerProjectRemove'), [
      { projectId: 'project-phukien', confirmed: true },
    ]);
    assert.ok(
      !rows(harness).some((r) => r.getAttribute('data-project-id') === 'project-phukien'),
      'a reported removal drops the row from the list',
    );
  });

  it('removing a project with no live terminals drops the row directly', async () => {
    const harness = loadStandalone();
    await flush();
    harness.api.removeProject = async () => ({ status: 'REMOVED', projectId: 'project-comnieu' });
    await openPicker(harness);

    rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-comnieu')
      ?.querySelector('.project-open-row-action.is-danger')?.dispatch('click');
    await flush();
    await flush();

    assert.deepStrictEqual(wire(harness, 'removeProject'), [{ projectId: 'project-comnieu' }]);
    assert.ok(
      !rows(harness).some((r) => r.getAttribute('data-project-id') === 'project-comnieu'),
      'the row is gone',
    );
    assert.strictEqual(countCalls(harness, 'answerProjectOpenPicker'), 0, 'removal never answers the open pick');
  });

  it('Escape backs out of a row edit without dismissing the modal', async () => {
    const harness = loadStandalone();
    await flush();
    harness.apiCalls.length = 0;
    const keydownBefore = harness.documentKeydownListeners.length;
    harness.api.removeProject = async () => ({ status: 'CONFIRM_REQUIRED', projectId: 'project-phukien', liveSessions: 1 });
    await openPicker(harness);

    rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
      ?.querySelector('.project-open-row-action.is-danger')?.dispatch('click');
    await flush();
    await flush();

    pressDocumentKey(harness, keydownBefore, 'Escape');
    await flush();

    assert.strictEqual(overlay(harness).style.display, 'flex', 'the modal stays open');
    assert.strictEqual(countCalls(harness, 'answerProjectOpenPicker'), 0, 'Esc cancelled the edit, not the pick');
    assert.ok(
      !rows(harness).find((r) => r.getAttribute('data-project-id') === 'project-phukien')
        ?.querySelector('.project-open-row-confirm'),
      'the confirm strip is gone',
    );
  });
});
