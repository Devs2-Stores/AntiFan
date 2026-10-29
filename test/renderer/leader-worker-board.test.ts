/**
 * Leader terminals and the Worker board (Renderer).
 *
 * Main stamps `leader` / `workerOf` / `workerTitle` on the session rows it projects and the
 * run-card push carries each terminal's OMP state. Verifies:
 * - the tab context menu offers `Đặt làm Leader` / `Bỏ Leader`, calls `setTerminalLeader`
 *   with the target id and the flipped flag, hides on split rows and reports a refusal
 * - a Leader row carries the crown, a worker row names its Leader in the badge tooltip
 * - the Manager-only board groups workers under their Leader with run-state labels and a tally
 * - clicking a worker row focuses that terminal (`switchTerminal(workerId)`)
 * - the attention filter keeps only waiting / ended / exited rows
 * - the open board repaints on session pushes and run-card pushes, and Escape closes it
 */
import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
  terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 },
};

const PROJECT_STATE = {
  projectWindow: { owner: { kind: 'project', projectId: 'proj-comnieu' }, title: 'Comnieu' },
  terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 },
};

const CAPSULES = [
  { id: 'capsule-comnieu', name: 'Comnieu', workspacePath: 'E:/Work/comnieu', projectId: 'proj-comnieu' },
  { id: 'capsule-phukien', name: 'Phukien', workspacePath: 'E:/Work/phukien', projectId: 'proj-phukien' },
];

const MENU_EVENT = { preventDefault: () => {}, stopPropagation: () => {}, clientX: 20, clientY: 20 };

/** Harnesses opened by a test: each one's board is closed afterwards so its refresh timer ends. */
const opened: StandaloneHarness[] = [];

afterEach(() => {
  for (const harness of opened.splice(0)) {
    harness.read<() => void>('closeLeaderBoard')();
  }
});

async function load(initialState: unknown = MANAGER_STATE): Promise<StandaloneHarness> {
  const harness = loadStandalone({ initialState, contextMenuActions: ['leader', 'split'] });
  opened.push(harness);
  harness.api.listCapsules = async () => ({ activeCapsuleId: 'capsule-comnieu', capsules: CAPSULES });
  await flush();
  harness.apiCalls.length = 0;
  harness.apiCallArgs.length = 0;
  return harness;
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    state: 'running',
    capsuleId: 'capsule-comnieu',
    ownerKey: 'project:proj-comnieu',
    folderLabel: 'Comnieu',
    ...overrides,
  };
}

/** One Leader with five workers covering every run state the board names. */
function fleet(): unknown[] {
  return [
    row({ id: 'L1', name: 'Leader F1', leader: true }),
    row({ id: 'W1', name: 'Worker 1', workerOf: 'L1', workerTitle: 'Sửa header' }),
    row({ id: 'W2', name: 'Worker 2', workerOf: 'L1' }),
    row({ id: 'W3', name: 'Worker 3', workerOf: 'L1' }),
    row({ id: 'W4', name: 'Worker 4', workerOf: 'L1' }),
    row({ id: 'W5', name: 'Worker 5', workerOf: 'L1' }),
    row({ id: 'S9', name: 'Terminal thường' }),
  ];
}

function card(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalSessionId: sessionId,
    ompSessionId: `omp-${sessionId}`,
    state: 'running',
    stale: false,
    mode: 'direct',
    runSeq: 2,
    lastEventAt: Date.now() - 90_000,
    promptHead: `việc của ${sessionId}`,
    viewOnly: false,
    ...overrides,
  };
}

function fleetCards(): Record<string, unknown>[] {
  return [
    card('W1'),
    card('W2', { state: 'waiting_user' }),
    card('W3', { state: 'idle' }),
    card('W5', { state: 'ended' }),
  ];
}

function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
  harness.renderTabs();
}

async function openBoard(harness: StandaloneHarness): Promise<FakeElement> {
  harness.leaderBoardButton.dispatch('click');
  // The outside-click and Escape listeners attach a tick after the opening gesture.
  await wait(20);
  return harness.leaderBoardDialog;
}

function boardRows(harness: StandaloneHarness): FakeElement[] {
  return harness.leaderBoardDialog.querySelectorAll('.leader-board-row');
}

function rowFor(harness: StandaloneHarness, id: string): FakeElement {
  const found = boardRows(harness).find((candidate) => candidate.getAttribute('data-session-id') === id);
  assert.ok(found, `expected a board row for ${id}`);
  return found;
}

function stateOf(harness: StandaloneHarness, id: string): string {
  return rowFor(harness, id).querySelector('.leader-board-state')?.textContent ?? '';
}

function openButton(harness: StandaloneHarness, id: string): FakeElement {
  const found = rowFor(harness, id).querySelector('.leader-board-row-open');
  assert.ok(found, `expected an open button on the row for ${id}`);
  return found;
}

function nameOf(harness: StandaloneHarness, id: string): string {
  return openButton(harness, id).textContent;
}

function activeElement(harness: StandaloneHarness): FakeElement {
  return harness.read<FakeElement>('document.activeElement');
}

function pressEscape(harness: StandaloneHarness): void {
  for (const listener of [...harness.documentKeydownListeners]) listener({
    key: 'Escape', preventDefault: () => {}, stopPropagation: () => {},
  });
}

function summaryOf(dialog: FakeElement, index = 0): string {
  return dialog.querySelectorAll('.leader-board-summary')[index]?.textContent ?? '';
}

function leaderItem(harness: StandaloneHarness): FakeElement {
  const item = harness.contextMenu.querySelector('.context-item[data-action="leader"]');
  assert.ok(item, 'the menu offers the leader action');
  return item;
}

function labelOf(item: FakeElement): string {
  return item.querySelector('span:last-child')?.textContent ?? '';
}

function noticeText(harness: StandaloneHarness): string {
  return harness.read<string>('terminalNoticeEl ? terminalNoticeEl.textContent : ""');
}

describe('Leader context menu', () => {
  it('toggles the Leader mark with the target id and the flipped flag', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.api.setTerminalLeader = async (id: unknown, leader: unknown) => ({ ok: true, leader });

    harness.showContextMenu(MENU_EVENT as never, 'S9');
    assert.strictEqual(labelOf(leaderItem(harness)), 'Đặt làm Leader');
    leaderItem(harness).dispatch('click');
    await flush();
    const first = harness.apiCallArgs.filter((entry) => entry.name === 'setTerminalLeader');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first.map((entry) => entry.args))), [['S9', true]]);
    assert.match(noticeText(harness), /Đã đặt “Terminal thường” làm Leader/);
    assert.match(noticeText(harness), /Mở hoặc mở lại OMP trong terminal này/);

    harness.showContextMenu(MENU_EVENT as never, 'L1');
    assert.strictEqual(labelOf(leaderItem(harness)), 'Bỏ Leader');
    leaderItem(harness).dispatch('click');
    await flush();
    const all = harness.apiCallArgs.filter((entry) => entry.name === 'setTerminalLeader');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(all.at(-1)?.args)), ['L1', false]);
    assert.match(noticeText(harness), /Đã bỏ Leader/);
    assert.match(noticeText(harness), /vẫn bị chặn push theme.*Worker mồ côi/);
  });

  it('is hidden on a split pane and never calls Main for one', async () => {
    const harness = await load();
    seed(harness, [...fleet(), row({ id: 'split-1', name: 'Pane', splitOf: 'S9' })], 'S9');

    harness.showContextMenu(MENU_EVENT as never, 'split-1');
    assert.strictEqual(leaderItem(harness).style.display, 'none');
    leaderItem(harness).dispatch('click');
    await flush();
    assert.strictEqual(harness.apiCalls.filter((name) => name === 'setTerminalLeader').length, 0);

    harness.showContextMenu(MENU_EVENT as never, 'S9');
    assert.strictEqual(leaderItem(harness).style.display, '', 'a base terminal offers it again');
  });

  it('reports a refusal instead of silently keeping the old mark', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.api.setTerminalLeader = async () => ({ ok: false, leader: false, error: 'SESSION_NOT_FOUND' });

    harness.showContextMenu(MENU_EVENT as never, 'S9');
    leaderItem(harness).dispatch('click');
    await flush();
    assert.match(noticeText(harness), /Không đổi được Leader.*SESSION_NOT_FOUND/);
  });
});

describe('Leader and worker badges', () => {
  it('crowns a Leader row and names the Leader on a worker row', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');

    const crown = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="L1"] .terminal-tab-leader-badge');
    assert.ok(crown, 'the Leader row carries a crown');
    assert.strictEqual(crown.textContent, '👑');
    assert.strictEqual(crown.title, 'Leader');

    const worker = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="W1"] .terminal-tab-worker-badge');
    assert.ok(worker, 'a worker row carries the worker badge');
    assert.strictEqual(worker.title, '⇠ Leader: Leader F1');

    const plain = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="S9"]');
    assert.ok(plain);
    assert.strictEqual(plain.querySelector('.terminal-tab-leader-badge'), null);
    assert.strictEqual(plain.querySelector('.terminal-tab-worker-badge'), null);
  });

  it('drops the crown when Main stops marking the row and follows a renamed Leader', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');

    const renamed = fleet().map((entry) => (
      (entry as { id: string }).id === 'L1' ? row({ id: 'L1', name: 'Leader mới', leader: true }) : entry
    ));
    harness.emitSession({ sessions: renamed, activeSessionId: 'S9' });
    const worker = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="W1"] .terminal-tab-worker-badge');
    assert.strictEqual(worker?.title, '⇠ Leader: Leader mới');

    harness.emitSession({
      sessions: renamed.map((entry) => ({ ...(entry as object), leader: undefined })),
      activeSessionId: 'S9',
    });
    assert.strictEqual(
      harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="L1"] .terminal-tab-leader-badge'),
      null,
    );
  });
});

describe('Worker board', () => {
  it('shows its button only in the Manager shell', async () => {
    const manager = await load(MANAGER_STATE);
    assert.strictEqual(manager.leaderBoardButton.style.display, '');
    const project = await load(PROJECT_STATE);
    assert.strictEqual(project.leaderBoardButton.style.display, 'none');
  });

  it('groups workers under their Leader with run-state labels, prompt and age', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    const dialog = await openBoard(harness);

    assert.strictEqual(dialog.style.display, 'flex');
    const sections = dialog.querySelectorAll('.leader-board-section');
    assert.strictEqual(sections.length, 1, 'one section per Leader');
    assert.strictEqual(sections[0]!.querySelector('.leader-board-leader')?.textContent, '👑 Leader F1');
    assert.strictEqual(
      summaryOf(dialog),
      '5 worker · đang chạy 1 · chờ bạn 1 · xong lượt 1 · nghỉ 1 · kết thúc 1',
      'a shell with no run card counts as nghỉ; no không phản hồi tail while nothing is silent',
    );

    assert.deepStrictEqual(boardRows(harness).map((r) => r.getAttribute('data-session-id')), ['W1', 'W2', 'W3', 'W4', 'W5']);
    assert.strictEqual(stateOf(harness, 'W1'), 'đang chạy');
    assert.strictEqual(stateOf(harness, 'W2'), 'chờ bạn');
    assert.strictEqual(stateOf(harness, 'W3'), 'xong lượt', 'an idle run that already ran a turn is a finished turn');
    assert.strictEqual(stateOf(harness, 'W4'), 'shell', 'no run card falls back to the session state');
    assert.strictEqual(stateOf(harness, 'W5'), 'kết thúc');

    const first = rowFor(harness, 'W1');
    assert.strictEqual(nameOf(harness, 'W1'), 'Sửa header', 'workerTitle wins over the name');
    assert.strictEqual(nameOf(harness, 'W2'), 'Worker 2');
    assert.strictEqual(first.querySelector('.leader-board-cell-project')?.textContent, 'Comnieu');
    assert.strictEqual(first.querySelector('.leader-board-cell-prompt')?.textContent, 'việc của W1');
    assert.strictEqual(first.querySelector('.leader-board-cell-age')?.textContent, '1 phút trước');
    assert.strictEqual(
      dialog.querySelectorAll('.leader-board-row').some((r) => r.getAttribute('data-session-id') === 'S9'),
      false,
      'a terminal no Leader drives is not a worker',
    );
  });

  it('names a sleeping or exited worker by its session state', async () => {
    const harness = await load();
    seed(harness, [
      row({ id: 'L1', name: 'Leader F1', leader: true }),
      row({ id: 'W1', name: 'Worker 1', workerOf: 'L1', state: 'sleeping' }),
      row({ id: 'W2', name: 'Worker 2', workerOf: 'L1', state: 'exited' }),
    ], 'L1');
    await openBoard(harness);

    assert.strictEqual(stateOf(harness, 'W1'), 'ngủ');
    assert.strictEqual(stateOf(harness, 'W2'), 'đã thoát');
  });

  it('focuses the clicked worker through switchTerminal', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    const dialog = await openBoard(harness);
    harness.apiCalls.length = 0;
    harness.apiCallArgs.length = 0;

    rowFor(harness, 'W2').dispatch('click');

    const switched = harness.apiCallArgs.filter((entry) => entry.name === 'switchTerminal');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched.map((entry) => entry.args))), [['W2']]);
    assert.strictEqual(harness.getActiveId(), 'W2');
    assert.strictEqual(dialog.style.display, 'none', 'the board gets out of the way of the terminal it opened');
  });

  it('focuses the Leader when its name is clicked', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    const dialog = await openBoard(harness);
    harness.apiCallArgs.length = 0;

    dialog.querySelector('.leader-board-leader')?.dispatch('click');

    const switched = harness.apiCallArgs.filter((entry) => entry.name === 'switchTerminal');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched.map((entry) => entry.args))), [['L1']]);
  });

  it('keeps only rows that need attention when the filter is on', async () => {
    const harness = await load();
    seed(harness, [...fleet(), row({ id: 'W6', name: 'Worker 6', workerOf: 'L1', state: 'exited' })], 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    const dialog = await openBoard(harness);
    assert.strictEqual(boardRows(harness).length, 6);

    const box = harness.elements.get('leaderBoardAttention') as FakeElement & { checked?: boolean };
    box.checked = true;
    box.dispatch('change');

    assert.deepStrictEqual(
      boardRows(harness).map((r) => r.getAttribute('data-session-id')),
      ['W2', 'W3', 'W5', 'W6'],
      'waiting, finished turn, ended and exited stay; running and shell go',
    );
    assert.match(
      dialog.querySelector('.leader-board-summary')?.textContent ?? '',
      /^6 worker/,
      'the tally still counts every worker, not just the visible ones',
    );

    box.checked = false;
    box.dispatch('change');
    assert.strictEqual(boardRows(harness).length, 6);
  });

  it('repaints while open on run-card and session pushes', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    await openBoard(harness);
    assert.strictEqual(stateOf(harness, 'W1'), 'đang chạy');

    harness.emitRunCardState({ runs: [card('W1', { state: 'waiting_user' }), ...fleetCards().slice(1)] });
    assert.strictEqual(stateOf(harness, 'W1'), 'chờ bạn');

    harness.emitSession({
      sessions: [...fleet(), row({ id: 'W7', name: 'Worker 7', workerOf: 'L1', workerTitle: 'Việc mới' })],
      activeSessionId: 'S9',
    });
    assert.strictEqual(boardRows(harness).length, 6);
    assert.strictEqual(nameOf(harness, 'W7'), 'Việc mới');

    harness.emitSession({ sessions: fleet().filter((entry) => (entry as { id: string }).id !== 'W3'), activeSessionId: 'S9' });
    assert.strictEqual(boardRows(harness).some((r) => r.getAttribute('data-session-id') === 'W3'), false);
  });

  it('explains how to mark a Leader when there is none, and closes on Escape', async () => {
    const harness = await load();
    seed(harness, [row({ id: 'S9', name: 'Terminal thường' })], 'S9');
    const dialog = await openBoard(harness);

    const empty = dialog.querySelector('.leader-board-empty');
    assert.ok(empty, 'an empty state is drawn');
    assert.match(empty.textContent, /chuột phải.*Đặt làm Leader/);

    for (const listener of [...harness.documentKeydownListeners]) listener({
      key: 'Escape', preventDefault: () => {}, stopPropagation: () => {},
    });
    assert.strictEqual(dialog.style.display, 'none');

    // A closed board no longer repaints from pushes.
    harness.emitSession({ sessions: fleet(), activeSessionId: 'S9' });
    assert.strictEqual(dialog.querySelectorAll('.leader-board-section').length, 0);
  });
});

describe('Worker board status', () => {
  it('keeps a finished turn visible under the attention filter and an unused idle OMP out of it', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({
      runs: [
        card('W1', { state: 'idle', runSeq: 1 }),
        card('W2', { state: 'idle', runSeq: 0 }),
      ],
    });
    const dialog = await openBoard(harness);

    assert.strictEqual(stateOf(harness, 'W1'), 'xong lượt');
    assert.strictEqual(stateOf(harness, 'W2'), 'nghỉ', 'an OMP that never ran a prompt is only open');

    const box = harness.elements.get('leaderBoardAttention') as FakeElement & { checked?: boolean };
    box.checked = true;
    box.dispatch('change');
    assert.deepStrictEqual(boardRows(harness).map((r) => r.getAttribute('data-session-id')), ['W1']);
    assert.match(summaryOf(dialog), /xong lượt 1 · nghỉ 4 · kết thúc 0$/);
  });

  it('reads a silent run as không phản hồi, never as kết thúc', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    // The run-state projection marks a run whose hook went quiet as ended + stale.
    harness.emitRunCardState({ runs: [card('W1', { state: 'ended', stale: true }), card('W2', { state: 'ended' })] });
    const dialog = await openBoard(harness);

    assert.strictEqual(stateOf(harness, 'W1'), 'không phản hồi');
    assert.strictEqual(stateOf(harness, 'W2'), 'kết thúc', 'a run that really ended keeps its label');
    const chip = rowFor(harness, 'W1').querySelector('.leader-board-state');
    assert.match(chip?.title ?? '', /45 giây/);
    assert.ok(chip?.classList.contains('run-stale'));
    assert.match(summaryOf(dialog), /kết thúc 1 · không phản hồi 1$/);

    const box = harness.elements.get('leaderBoardAttention') as FakeElement & { checked?: boolean };
    box.checked = true;
    box.dispatch('change');
    assert.deepStrictEqual(boardRows(harness).map((r) => r.getAttribute('data-session-id')), ['W1', 'W2']);
  });
});

describe('Worker board orphans', () => {
  it('lists a worker whose Leader was unmarked in its own section instead of dropping it', async () => {
    const harness = await load();
    const unmarked = fleet().map((entry) => (
      (entry as { id: string }).id === 'L1' ? row({ id: 'L1', name: 'Leader F1' }) : entry
    ));
    seed(harness, unmarked, 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    const dialog = await openBoard(harness);

    const sections = dialog.querySelectorAll('.leader-board-section');
    assert.strictEqual(sections.length, 1, 'only the orphan section: nothing is a Leader any more');
    assert.ok(sections[0]!.classList.contains('is-orphan'));
    assert.strictEqual(sections[0]!.querySelector('.leader-board-orphan-title')?.textContent, 'Worker mồ côi');
    assert.match(sections[0]!.querySelector('.leader-board-orphan-hint')?.textContent ?? '', /vẫn bị chặn push theme.*nhận lại/);
    assert.deepStrictEqual(boardRows(harness).map((r) => r.getAttribute('data-session-id')), ['W1', 'W2', 'W3', 'W4', 'W5']);
    assert.strictEqual(dialog.querySelector('.leader-board-empty'), null, 'orphans are not an empty board');
    assert.strictEqual(dialog.querySelector('.leader-board-leader'), null);
  });

  it('lists a worker whose Leader terminal is gone beside the live Leaders, and nothing for ordinary terminals', async () => {
    const harness = await load();
    seed(harness, [
      ...fleet(),
      row({ id: 'W8', name: 'Worker 8', workerOf: 'terminal-closed' }),
      row({ id: 'split-8', name: 'Pane', splitOf: 'W8', workerOf: 'terminal-closed' }),
    ], 'S9');
    const dialog = await openBoard(harness);

    const sections = dialog.querySelectorAll('.leader-board-section');
    assert.strictEqual(sections.length, 2, 'the Leader plus the orphans');
    assert.strictEqual(sections[0]!.getAttribute('data-leader-id'), 'L1');
    assert.ok(sections[1]!.classList.contains('is-orphan'));
    assert.strictEqual(summaryOf(dialog, 1).startsWith('1 worker'), true, 'a split pane is not a worker of its own');
    const orphanRows = sections[1]!.querySelectorAll('.leader-board-row').map((r) => r.getAttribute('data-session-id'));
    assert.deepStrictEqual(orphanRows, ['W8']);
  });

  it('says in the worker tooltip that the old Leader is gone', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    const unmarked = fleet().map((entry) => (
      (entry as { id: string }).id === 'L1' ? row({ id: 'L1', name: 'Leader F1' }) : entry
    ));
    harness.emitSession({ sessions: unmarked, activeSessionId: 'S9' });
    const worker = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="W1"] .terminal-tab-worker-badge');
    assert.strictEqual(worker?.title, '⇠ Worker mồ côi (Leader cũ: Leader F1)');
  });

  it('does not name a Leader in the worker tooltip when the owner row is not in this window', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitSession({
      sessions: fleet().filter((entry) => (entry as { id: string }).id !== 'L1'),
      activeSessionId: 'S9',
    });
    const worker = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="W1"] .terminal-tab-worker-badge');
    assert.strictEqual(worker?.title, '⇠ Worker mồ côi (Leader không có trong cửa sổ này: L1)');
  });

  it('tells a Leader with no worker how workers appear', async () => {
    const harness = await load();
    seed(harness, [row({ id: 'L1', name: 'Leader F1', leader: true })], 'L1');
    const dialog = await openBoard(harness);
    assert.match(dialog.querySelector('.leader-board-none')?.textContent ?? '', /Nhờ OMP trong terminal Leader giao việc/);
  });
});

describe('Worker board keyboard and focus', () => {
  it('opens a worker from a real button, once, and gives the row no link semantics', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    await openBoard(harness);
    harness.apiCallArgs.length = 0;

    const target = rowFor(harness, 'W2');
    assert.strictEqual(target.getAttribute('role'), null);
    assert.strictEqual(target.listeners['keydown'], undefined, 'the row no longer emulates a button');
    const button = openButton(harness, 'W2');
    assert.strictEqual(button.tagName, 'button');

    // The row opens on a click too, so the button has to stop its own click or one press opens twice.
    let stopped = false;
    button.dispatch('click', { stopPropagation: () => { stopped = true; } });
    const switched = harness.apiCallArgs.filter((entry) => entry.name === 'switchTerminal');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched.map((entry) => entry.args))), [['W2']]);
    assert.strictEqual(stopped, true);
    assert.strictEqual(harness.getActiveId(), 'W2');
  });

  it('keeps focus on the same row button when a push repaints the board', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    await openBoard(harness);

    const before = openButton(harness, 'W2');
    before.focus();
    assert.strictEqual(activeElement(harness), before);

    harness.emitSession({ sessions: [...fleet(), row({ id: 'W7', name: 'Worker 7', workerOf: 'L1' })], activeSessionId: 'S9' });
    const after = openButton(harness, 'W2');
    assert.notStrictEqual(after, before, 'the repaint rebuilt the row');
    assert.strictEqual(activeElement(harness), after, 'focus follows the row to its rebuilt button');

    harness.emitRunCardState({ runs: [card('W2', { state: 'running' }), ...fleetCards().slice(2)] });
    assert.strictEqual(activeElement(harness), openButton(harness, 'W2'), 'a run-card push keeps it too');
  });

  it('keeps focus on a Leader name across a repaint, and does not steal focus from outside the board body', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    await openBoard(harness);

    const leader = harness.leaderBoardDialog.querySelector('.leader-board-leader')!;
    leader.focus();
    harness.emitSession({ sessions: fleet(), activeSessionId: 'S9' });
    const rebuilt = harness.leaderBoardDialog.querySelector('.leader-board-leader')!;
    assert.notStrictEqual(rebuilt, leader);
    assert.strictEqual(activeElement(harness), rebuilt);

    const closeButton = harness.elements.get('leaderBoardClose')!;
    closeButton.focus();
    harness.emitSession({ sessions: fleet(), activeSessionId: 'S9' });
    assert.strictEqual(activeElement(harness), closeButton, 'a repaint never moves focus that was not in the body');
  });

  it('drops focus quietly when the focused worker leaves the board', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    await openBoard(harness);
    openButton(harness, 'W3').focus();

    harness.emitSession({ sessions: fleet().filter((entry) => (entry as { id: string }).id !== 'W3'), activeSessionId: 'S9' });
    assert.strictEqual(boardRows(harness).some((r) => r.getAttribute('data-session-id') === 'W3'), false);
    assert.notStrictEqual(activeElement(harness).getAttribute('data-session-id'), 'W3');
  });

  it('returns focus to the opener on Escape and on the close button', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    const dialog = await openBoard(harness);
    harness.elements.get('leaderBoardClose')!.focus();

    pressEscape(harness);
    assert.strictEqual(dialog.style.display, 'none');
    assert.strictEqual(activeElement(harness), harness.leaderBoardButton);

    await openBoard(harness);
    harness.elements.get('leaderBoardClose')!.focus();
    harness.elements.get('leaderBoardClose')!.dispatch('click');
    assert.strictEqual(dialog.style.display, 'none');
    assert.strictEqual(activeElement(harness), harness.leaderBoardButton);
  });

  it('does not pull focus back to the opener when a row sends the person into a terminal', async () => {
    const harness = await load();
    seed(harness, fleet(), 'S9');
    harness.emitRunCardState({ runs: fleetCards() });
    const dialog = await openBoard(harness);

    openButton(harness, 'W2').dispatch('click');
    assert.strictEqual(dialog.style.display, 'none');
    assert.notStrictEqual(activeElement(harness), harness.leaderBoardButton);
  });
});
