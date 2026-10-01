/**
 * The sidebar's project chip — the project entry a user can actually click.
 *
 * The rule under test is reachability: a project window is the only window this build boots,
 * so an "Open Project" action offered only in an Unassigned shell is an action no user can
 * reach. The chip therefore shows in every described shell, and the request it sends carries
 * no project id — a request that carried the shell's own id would turn "open another project"
 * into "focus the window I am already in", which is the bug this surface used to have.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

const PROJECT_IDENTITY = {
  owner: { kind: 'project', projectId: 'project-alpha' },
  title: 'Alpha',
  pathLabel: 'E:\\Work\\alpha',
  workspacePath: 'E:\\Work\\alpha',
};
const UNASSIGNED_IDENTITY = { owner: { kind: 'unassigned' }, title: 'Unassigned' };

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function chip(harness: StandaloneHarness): FakeElement | null {
  return harness.standaloneRoot.querySelector('#shellScopeChip');
}

function openButton(harness: StandaloneHarness): FakeElement | null {
  return harness.standaloneRoot.querySelector('#btnOpenProject');
}

function chipStatus(harness: StandaloneHarness): string {
  const notice = harness.read<{ textContent?: string; style?: { display?: string } } | null>('terminalNoticeEl');
  return notice && notice.style?.display !== 'none' ? (notice.textContent ?? '') : '';
}

function openProjectCalls(harness: StandaloneHarness): unknown[][] {
  return harness.apiCallArgs
    .filter((call) => call.name === 'openProject')
    .map((call) => call.args);
}

function answerOpenProject(harness: StandaloneHarness, answer: unknown): void {
  harness.api.openProject = async () => answer;
}

describe('sidebar project chip', () => {
  it('offers Open Project in a project window, and asks Main which project without naming one', async () => {
    const harness = loadStandalone({ initialState: { projectWindow: PROJECT_IDENTITY } });
    await flush();
    answerOpenProject(harness, { status: 'OPENED', projectId: 'project-beta' });

    assert.strictEqual(chip(harness)?.style.display, 'flex', 'a described shell shows the chip');
    assert.strictEqual(
      openButton(harness)?.style.display,
      'flex',
      'the project window is the only window a launch creates, so the action has to be reachable there',
    );

    openButton(harness)?.click();
    await flush();

    assert.deepStrictEqual(
      openProjectCalls(harness),
      [[]],
      'the request carries no id: Main owns the choice of which project to open',
    );
    assert.strictEqual(chipStatus(harness), 'Đã mở project-beta', 'the outcome is reported from what Main answered');
  });

  it('offers the same action in the shared manager, which carries no label', async () => {
    const harness = loadStandalone({ initialState: { projectWindow: UNASSIGNED_IDENTITY } });
    await flush();
    answerOpenProject(harness, { status: 'FOCUSED', projectId: 'project-alpha' });

    assert.strictEqual(chip(harness)?.style.display, 'none', 'the manager names no single project');
    assert.strictEqual(openButton(harness)?.style.display, 'flex');

    openButton(harness)?.click();
    await flush();

    assert.deepStrictEqual(openProjectCalls(harness), [[]]);
    assert.strictEqual(chipStatus(harness), 'Đã chuyển tới project-alpha');
  });

  it('shows nothing while Main has not described the shell', async () => {
    const harness = loadStandalone({ initialState: {} });
    await flush();

    assert.strictEqual(chip(harness)?.style.display, 'none', 'an undescribed shell is not named by this renderer');
    assert.strictEqual(openButton(harness)?.style.display, 'none');
  });

  it('says nothing when the user dismisses the picker, and names each refusal in the user\'s language', async () => {
    const dismissed = loadStandalone({ initialState: { projectWindow: PROJECT_IDENTITY } });
    await flush();
    answerOpenProject(dismissed, { status: 'CANCELLED' });
    openButton(dismissed)?.click();
    await flush();
    assert.strictEqual(chipStatus(dismissed), '', 'a dialog the user closed is not an error to report');

    for (const [reason, text] of [
      ['PROJECT_FOLDER_INVALID', 'Thư mục không hợp lệ hoặc không truy cập được'],
      ['AMBIGUOUS_PROJECT_FOLDER', 'Nhiều dự án cùng dùng thư mục này'],
    ] as const) {
      const refused = loadStandalone({ initialState: { projectWindow: PROJECT_IDENTITY } });
      await flush();
      answerOpenProject(refused, { status: 'FAILED', reason });
      openButton(refused)?.click();
      await flush();
      assert.strictEqual(chipStatus(refused), text, `the machine reason ${reason} is translated for the user`);
    }
  });
});
