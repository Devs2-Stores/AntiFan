/**
 * The Worker board's job rows (Renderer): the Leader jobs Main reads from the ledger are listed above
 * each Leader's worker table, needs-me first, with round, state chip, worker silence and report
 * status. Verifies ordering, blank (not NaN/undefined) cells for absent data, markup rendered as
 * text, a click that focuses the job's worker terminal, and that a failed read keeps the last rows.
 */
import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';
/** Lets the board's pending `getLeaderJobs` promise settle and repaint. */
const wait = async (_ms: number): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
};


const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
  terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 },
};

const opened: StandaloneHarness[] = [];

afterEach(() => {
  for (const harness of opened.splice(0)) harness.read<() => void>('closeLeaderBoard')();
});

function session(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    state: 'running',
    capsuleId: 'capsule-a',
    ownerKey: 'project:proj-a',
    folderLabel: 'A',
    ...overrides,
  };
}

async function openWith(jobs: unknown, sessions: unknown[] = [
  session({ id: 'L1', name: 'Leader', leader: true }),
  session({ id: 'W1', name: 'Worker 1', workerOf: 'L1' }),
]): Promise<StandaloneHarness> {
  const harness = loadStandalone({ initialState: MANAGER_STATE, contextMenuActions: [] });
  opened.push(harness);
  harness.api.getLeaderJobs = async () => jobs;
  harness.setSessions(sessions);
  harness.setActiveId('L1');
  harness.renderTabs();
  harness.leaderBoardButton.dispatch('click');
  await wait(20);
  return harness;
}

function jobRows(harness: StandaloneHarness): FakeElement[] {
  return harness.leaderBoardDialog.querySelectorAll('.leader-job-row');
}

function cell(row: FakeElement, selector: string): string {
  const found = row.querySelector(selector);
  assert.ok(found, `expected ${selector}`);
  return found.textContent;
}

describe('Worker board job rows', () => {
  it('lists needs-me jobs first and renders round, state, silence, last tool and report status', async () => {
    const harness = await openWith({
      L1: [
        { job: 'calm', state: 'dispatched', needsMe: false, round: 1, kind: 'work', silentMin: 3, lastTool: 'bash', reportStatus: null, worker: 'W1' },
        { job: 'asks', state: 'dispatched', needsMe: true, round: 2, kind: 'followup', silentMin: 12, lastTool: 'edit', reportStatus: 'NEEDS_INPUT', worker: 'W9' },
      ],
    });
    const rows = jobRows(harness);
    assert.deepStrictEqual(rows.map((r) => r.getAttribute('data-job')), ['asks', 'calm']);
    assert.strictEqual(cell(rows[0]!, '.leader-job-cell-round'), 'r2/followup');
    assert.strictEqual(cell(rows[0]!, '.leader-board-state'), 'đang chạy');
    assert.strictEqual(cell(rows[0]!, '.leader-board-cell-age'), 'im lặng 12 phút · edit');
    assert.strictEqual(cell(rows[0]!, '.leader-job-cell-report'), 'NEEDS_INPUT');
    assert.strictEqual(cell(rows[0]!, '.leader-job-cell-needs'), 'Cần bạn');
    assert.strictEqual(cell(rows[1]!, '.leader-job-cell-needs'), '');
    assert.strictEqual(cell(rows[1]!, '.leader-job-cell-report'), '');
  });

  it('leaves cells blank when the data is absent instead of printing NaN or undefined', async () => {
    const harness = await openWith({ L1: [{ job: 'bare', state: 'open' }] });
    const [row] = jobRows(harness);
    assert.ok(row);
    assert.strictEqual(cell(row, '.leader-job-cell-round'), '');
    assert.strictEqual(cell(row, '.leader-board-cell-age'), '');
    assert.strictEqual(cell(row, '.leader-job-cell-report'), '');
    const text = row.textContent;
    assert.ok(!/NaN|undefined|null/.test(text), `row text was ${text}`);
  });

  it('renders a job name containing markup as plain text', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const harness = await openWith({ L1: [{ job: name, state: 'dispatched', reportStatus: '<b>DONE</b>' }] });
    const [row] = jobRows(harness);
    assert.ok(row);
    assert.strictEqual(row.querySelector('img'), null);
    assert.strictEqual(row.querySelector('b'), null);
    assert.strictEqual(cell(row, '.leader-board-cell-name'), name);
    assert.strictEqual(cell(row, '.leader-job-cell-report'), '<b>DONE</b>');
  });

  it('focuses the worker terminal of a job when its row is clicked', async () => {
    const harness = await openWith({ L1: [{ job: 'j', state: 'dispatched', worker: 'W1' }] });
    const [row] = jobRows(harness);
    assert.ok(row);
    harness.apiCalls.length = 0;
    harness.apiCallArgs.length = 0;
    row.dispatch('click');
    assert.ok(harness.apiCalls.includes('switchTerminal') || harness.read<string>('activeId') === 'W1');
  });

  it('shows no job block for a malformed answer and keeps the last good rows when a later read fails', async () => {
    const harness = await openWith({ L1: [{ job: 'keep', state: 'dispatched' }] });
    assert.strictEqual(jobRows(harness).length, 1);
    harness.api.getLeaderJobs = async () => { throw new Error('ipc down'); };
    harness.read<() => Promise<void>>('fetchLeaderJobs')();
    await wait(20);
    assert.deepStrictEqual(jobRows(harness).map((r) => r.getAttribute('data-job')), ['keep']);
    harness.api.getLeaderJobs = async () => 'garbage';
    harness.read<() => Promise<void>>('fetchLeaderJobs')();
    await wait(20);
    assert.deepStrictEqual(jobRows(harness).map((r) => r.getAttribute('data-job')), ['keep']);
  });

  it('draws nothing extra when the preload has no job reader', async () => {
    const harness = await openWith(undefined);
    assert.strictEqual(jobRows(harness).length, 0);
  });
});
