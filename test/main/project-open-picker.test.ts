/**
 * The project picker's inventory and its response mapping.
 *
 * The user's click is a *position* in a list Main built, so the only thing that makes the
 * resulting id trustworthy is that one function produced both the visible order and the ids
 * behind it. These cases pin that pairing, the de-duplication across the two inventory
 * sources, the label disambiguation that keeps two same-named projects distinguishable, and
 * the folder action that always sits after the last project button so an empty inventory
 * still has a real answer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  collectProjectOpenCandidates,
  projectOpenDialogSpec,
  projectOpenChoiceFor,
  projectOpenWireChoice,
  PROJECT_OPEN_FOLDER_LABEL,
  PROJECT_OPEN_CANCEL_LABEL,
} from '../../src/main/project/project-open-picker';

const describeById = (labels: Record<string, { title: string; pathLabel?: string }>) =>
  (projectId: string): { title: string; pathLabel?: string } => labels[projectId] ?? { title: projectId };

describe('project open picker inventory', () => {
  it('offers open projects and drops closed ones', () => {
    const candidates = collectProjectOpenCandidates({
      registryProjects: [
        { id: 'project-open-b', name: 'Beta', state: 'open' },
        { id: 'project-closed', name: 'Closed', state: 'closed' },
        { id: 'project-open-a', name: 'Alpha', state: 'open' },
      ],
      describe: describeById({ 'project-open-a': { title: 'Alpha' }, 'project-open-b': { title: 'Beta' } }),
    });

    assert.deepStrictEqual(
      candidates,
      [{ projectId: 'project-open-a', title: 'Alpha' }, { projectId: 'project-open-b', title: 'Beta' }],
      'the list is ordered by title, and a closed project is not offered at all',
    );
  });

  it('offers a project a live window already owns even when the registry has no record for it', () => {
    const candidates = collectProjectOpenCandidates({
      registryProjects: [{ id: 'project-registry', name: 'Registered', state: 'open' }],
      knownProjectIds: ['project-live', 'project-boot', ''],
      describe: describeById({
        'project-registry': { title: 'Registered' },
        'project-live': { title: 'Live window' },
        'project-boot': { title: 'Boot identity' },
      }),
    });

    assert.deepStrictEqual(candidates.map((candidate) => candidate.projectId), [
      'project-boot',
      'project-live',
      'project-registry',
    ]);
  });

  it('lists a project once when it is both registered and owned by a live window', () => {
    const candidates = collectProjectOpenCandidates({
      registryProjects: [{ id: 'project-both', name: 'Both', state: 'open' }],
      knownProjectIds: ['project-both', 'project-both'],
      describe: describeById({ 'project-both': { title: 'Both' } }),
    });

    assert.deepStrictEqual(candidates, [{ projectId: 'project-both', title: 'Both' }]);
  });

  it('keeps the workspace path off the button and inside the candidate record', () => {
    // A long "name — path" button is what made the native row unreadable; the path still
    // travels with the candidate so `projectOpenDialogSpec` can list it in `detail`.
    const candidates = collectProjectOpenCandidates({
      registryProjects: [{ id: 'project-solo', name: 'Solo', state: 'open' }],
      describe: describeById({ 'project-solo': { title: 'Solo', pathLabel: 'E:\\Work\\solo' } }),
    });

    assert.deepStrictEqual(candidates, [
      { projectId: 'project-solo', title: 'Solo', pathLabel: 'E:\\Work\\solo' },
    ]);
  });

  it('falls back to the project id when two projects repeat the exact same label', () => {
    // Same title *and* same workspace still renders one legible button per project:
    // the stable id is the last resort that keeps the two apart.
    const candidates = collectProjectOpenCandidates({
      registryProjects: [
        { id: 'project-twin-a', name: 'Twin', state: 'open' },
        { id: 'project-twin-b', name: 'Twin', state: 'open' },
      ],
      describe: describeById({
        'project-twin-a': { title: 'Twin', pathLabel: 'E:\\Work\\shared' },
        'project-twin-b': { title: 'Twin', pathLabel: 'E:\\Work\\shared' },
      }),
    });

    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.title).sort(),
      ['Twin — project-twin-a', 'Twin — project-twin-b'],
    );
  });

  it('disambiguates a shared title with the id and keeps a unique one plain', () => {
    const candidates = collectProjectOpenCandidates({
      registryProjects: [
        { id: 'project-1', name: 'Theme', state: 'open' },
        { id: 'project-2', name: 'Theme', state: 'open' },
        { id: 'project-3', name: 'Unique', state: 'open' },
      ],
      describe: describeById({
        'project-1': { title: 'Theme', pathLabel: 'E:\\Work\\one' },
        'project-2': { title: 'Theme', pathLabel: 'E:\\Work\\two' },
        'project-3': { title: 'Unique' },
      }),
    });

    assert.deepStrictEqual(candidates, [
      { projectId: 'project-1', title: 'Theme — project-1', pathLabel: 'E:\\Work\\one' },
      { projectId: 'project-2', title: 'Theme — project-2', pathLabel: 'E:\\Work\\two' },
      { projectId: 'project-3', title: 'Unique' },
    ], 'an ambiguous title falls back on the stable id, and an unambiguous one stays plain');
  });

  it('falls back to the project id when a shared title has no workspace path', () => {
    const candidates = collectProjectOpenCandidates({
      registryProjects: [
        { id: 'project-x', name: 'Same', state: 'open' },
        { id: 'project-y', name: 'Same', state: 'open' },
      ],
      describe: describeById({ 'project-x': { title: 'Same' }, 'project-y': { title: 'Same' } }),
    });

    assert.deepStrictEqual(candidates.map((candidate) => candidate.title), [
      'Same — project-x',
      'Same — project-y',
    ], 'the stable id is the last resort that keeps the label unique');
  });

  it('names a project by its id when the projection carries no title', () => {
    const candidates = collectProjectOpenCandidates({
      registryProjects: [{ id: 'project-blank', name: '', state: 'open' }],
      describe: () => ({ title: '   ' }),
    });

    assert.deepStrictEqual(candidates, [{ projectId: 'project-blank', title: 'project-blank' }]);
  });
});

describe('project open picker dialog', () => {
  it('still shows a folder chooser when the inventory is empty', () => {
    // Windows drops the dialog's detail line, so the buttons are the only honest text; with no
    // project to offer, "choose a folder" is still a real answer to "open a project".
    const spec = projectOpenDialogSpec([]);
    assert.deepStrictEqual(spec.buttons, [PROJECT_OPEN_FOLDER_LABEL, PROJECT_OPEN_CANCEL_LABEL]);
    assert.strictEqual(spec.folderActionId, 0);
    assert.strictEqual(spec.cancelId, 1);
    assert.strictEqual(spec.defaultId, 0);
    assert.deepStrictEqual(spec.ids, []);
  });

  it('appends the folder and cancel actions after the project buttons', () => {
    const spec = projectOpenDialogSpec([
      { projectId: 'project-a', title: 'Alpha' },
      { projectId: 'project-b', title: 'Beta' },
    ]);
    assert.deepStrictEqual(spec.buttons, ['Alpha', 'Beta', PROJECT_OPEN_FOLDER_LABEL, PROJECT_OPEN_CANCEL_LABEL]);
    assert.strictEqual(spec.folderActionId, 2, 'the folder action is the first button after the candidates');
    assert.strictEqual(spec.cancelId, 3);
    assert.deepStrictEqual(spec.ids, ['project-a', 'project-b']);
  });

  it('maps each project button to the id at the same position', () => {
    // Deliberately not sorted by id: a positional mapping that used the registry order
    // instead of the rendered order would hand the user the neighbouring project.
    const spec = projectOpenDialogSpec([
      { projectId: 'project-z', title: 'Alpha' },
      { projectId: 'project-a', title: 'Beta' },
    ]);

    assert.deepStrictEqual(projectOpenChoiceFor(spec, 0), { kind: 'project', projectId: 'project-z' });
    assert.deepStrictEqual(projectOpenChoiceFor(spec, 1), { kind: 'project', projectId: 'project-a' });
  });

  it('reads the folder action as a folder request at every inventory size', () => {
    const empty = projectOpenDialogSpec([]);
    assert.deepStrictEqual(projectOpenChoiceFor(empty, empty.folderActionId), { kind: 'folder' });

    const listed = projectOpenDialogSpec([{ projectId: 'project-a', title: 'Alpha' }]);
    assert.deepStrictEqual(projectOpenChoiceFor(listed, listed.folderActionId), { kind: 'folder' });
  });

  it('reads cancel, a fractional index, and an out-of-range index as a dismissal, never a neighbour', () => {
    // A dialog that answered with an index it never offered must not be read as a choice the
    // user could not have made.
    const spec = projectOpenDialogSpec([{ projectId: 'project-a', title: 'Alpha' }]);

    assert.deepStrictEqual(projectOpenChoiceFor(spec, spec.cancelId), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenChoiceFor(spec, 7), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenChoiceFor(spec, -1), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenChoiceFor(spec, 1.5), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenChoiceFor(spec, Number.NaN), { kind: 'cancelled' });
  });

  it('lists each workspace path in the detail line under the name it belongs to', () => {
    const spec = projectOpenDialogSpec([
      { projectId: 'project-a', title: 'Alpha', pathLabel: 'E:\\Work\\alpha' },
      { projectId: 'project-b', title: 'Beta' },
    ]);
    assert.match(spec.detail, /Alpha — E:\\Work\\alpha/);
    assert.doesNotMatch(spec.detail, /Beta —/, 'a project with no recorded path adds no line');
    assert.deepStrictEqual(spec.buttons, ['Alpha', 'Beta', PROJECT_OPEN_FOLDER_LABEL, PROJECT_OPEN_CANCEL_LABEL],
      'the button itself never carries the path');
  });

  it('reads a renderer answer only when it names an id the spec offered', () => {
    const spec = projectOpenDialogSpec([
      { projectId: 'project-a', title: 'Alpha' },
      { projectId: 'project-b', title: 'Beta' },
    ]);

    assert.deepStrictEqual(projectOpenWireChoice(spec, { kind: 'project', projectId: 'project-b' }), { kind: 'project', projectId: 'project-b' });
    assert.deepStrictEqual(projectOpenWireChoice(spec, { kind: 'folder' }), { kind: 'folder' });
    assert.deepStrictEqual(projectOpenWireChoice(spec, { kind: 'cancelled' }), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenWireChoice(spec, { kind: 'project', projectId: 'project-never-offered' }), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenWireChoice(spec, undefined), { kind: 'cancelled' });
    assert.deepStrictEqual(projectOpenWireChoice(spec, 'project-a'), { kind: 'cancelled' });
  });
});
