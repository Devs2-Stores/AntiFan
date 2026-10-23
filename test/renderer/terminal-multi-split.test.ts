/**
 * Several splits per base session, driven through the shared vm harness: every split of the active
 * base is its own pane of the lower row (`#terminal-split`), left to right in `splitSessionIds`
 * order, with its own terminal, header, close button and a draggable divider between neighbours.
 */
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  loadStandalone,
  type FakeElement,
  type FakeTerminal,
  type StandaloneHarness,
} from './standalone-harness';

interface PaneView {
  id: string;
  term: FakeTerminal;
  paneEl: FakeElement;
  labelEl: FakeElement;
  badgeEl: FakeElement;
  closeBtn: FakeElement;
  released: boolean;
  hydrationEpoch: number;
}

type Row = Record<string, unknown>;

/** Flush pending microtasks and the immediates the renderer schedules. */
const settle = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const baseRow = (id: string, splitSessionIds: string[]): Row => ({
  id,
  name: `Base ${id}`,
  state: 'running',
  splitSessionIds,
  buffer: '',
});

const splitRow = (id: string, splitOf: string, extra: Row = {}): Row => ({
  id,
  name: `Split ${id}`,
  state: 'running',
  splitOf,
  buffer: '',
  ...extra,
});

const pushState = (activeSessionId: string, sessions: Row[]) => ({
  activeSessionId,
  sessions,
  snapshot: '',
  snapshotThroughSeq: 0,
});

/** Give a pane element a measurable box; every stub element otherwise reports the same one. */
const stubRect = (el: FakeElement, left: number, right: number): void => {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ width: right - left, height: 100, top: 0, left, right, bottom: 100 }),
    configurable: true,
  });
};

describe('Renderer multi-split lower row', () => {
  let harness: StandaloneHarness;

  const pane = (id: string): PaneView => harness.read<PaneView>(`splitPanes.get(${JSON.stringify(id)})`);
  const paneOrder = (): string[] => Array.from(harness.read<string[]>('splitPaneOrder'));
  const rowPanes = (): FakeElement[] => harness.queryAll('.terminal-split-pane');
  const rowIds = (): Array<string | null> => rowPanes().map((el) => el.getAttribute('data-session-id'));
  const dividers = (): FakeElement[] => harness.queryAll('.terminal-split-vdivider');
  const storedWeight = (baseId: string, splitId: string): number =>
    harness.read<number>(`sessionSplitPaneWidths.get(${JSON.stringify(baseId)}).get(${JSON.stringify(splitId)})`);
  const unsplitCalls = (): unknown[][] => harness.apiCallArgs.filter((c) => c.name === 'unsplitTerminal').map((c) => c.args);

  beforeEach(() => {
    harness = loadStandalone();
  });

  it('mounts every split of the active base side by side in splitSessionIds order', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-b', 's-a', 's-c']),
      splitRow('s-a', 'b', { name: 'Alpha' }),
      splitRow('s-b', 'b', { name: 'Bravo', displayLabel: 'Bravo label' }),
      splitRow('s-c', 'b', { name: 'Charlie' }),
    ]));
    await settle();

    const row = harness.elements.get('terminal-split')!;
    assert.ok(row, 'the lower row exists');
    assert.deepStrictEqual(
      row.children.map((child) => child.className),
      ['terminal-split-pane', 'terminal-split-vdivider', 'terminal-split-pane', 'terminal-split-vdivider', 'terminal-split-pane'],
      'panes and vertical dividers alternate',
    );
    assert.deepStrictEqual(rowIds(), ['s-b', 's-a', 's-c'], 'the base row decides the order, not the session list');
    assert.deepStrictEqual(paneOrder(), ['s-b', 's-a', 's-c']);
    assert.deepStrictEqual(
      dividers().map((d) => [d.getAttribute('data-left-id'), d.getAttribute('data-right-id')]),
      [['s-b', 's-a'], ['s-a', 's-c']],
    );
    assert.deepStrictEqual(
      rowPanes().map((el) => el.querySelector('.split-pane-label')!.textContent),
      ['Bravo label', 'Alpha', 'Charlie'],
      'each header names its own split, preferring displayLabel',
    );

    const hosts = rowPanes().map((el) => el.querySelector('.terminal-split-pane-host'));
    assert.strictEqual(new Set(hosts).size, 3, 'every pane owns its own xterm host');
    assert.strictEqual(new Set(['s-a', 's-b', 's-c'].map((id) => pane(id).term)).size, 3, 'and its own terminal');

    assert.strictEqual(harness.container.children[1]?.id, 'terminal-divider', 'the horizontal divider sits between the main pane and the row');
    assert.strictEqual(harness.container.children[2], row);
    assert.strictEqual(harness.container.classList.contains('split'), true);
    assert.strictEqual(harness.splitButton.classList.contains('active'), true);
  });

  it('keeps the surviving panes mounted, appends a new split at the end, and unmounts only a vanished one', async () => {
    const rows = (ids: string[]): Row[] => [baseRow('b', ids), ...ids.map((id) => splitRow(id, 'b'))];
    harness.emitSession(pushState('b', rows(['s-a'])));
    await settle();
    const paneA = pane('s-a');

    harness.emitSession(pushState('b', rows(['s-a', 's-b', 's-c'])));
    await settle();
    assert.deepStrictEqual(rowIds(), ['s-a', 's-b', 's-c'], 'a new split joins the end of the row');
    assert.strictEqual(pane('s-a'), paneA, 'the surviving pane is the same pane, not a re-created one');

    const paneB = pane('s-b');
    const paneC = pane('s-c');
    const termA = paneA.term;
    const epochA = paneA.hydrationEpoch;
    const disposed: string[] = [];
    for (const [id, p] of [['s-a', paneA], ['s-b', paneB], ['s-c', paneC]] as const) {
      p.term.dispose = () => { disposed.push(id); };
    }
    const paneBEl = paneB.paneEl;

    harness.emitSession(pushState('b', rows(['s-b', 's-c'])));
    await settle();

    assert.deepStrictEqual(rowIds(), ['s-b', 's-c'], 'only the vanished pane left the row');
    assert.deepStrictEqual(paneOrder(), ['s-b', 's-c']);
    assert.strictEqual(dividers().length, 1, 'one divider remains between the two panes');
    assert.deepStrictEqual(disposed, ['s-a'], 'only the vanished pane disposed its terminal');
    assert.strictEqual(paneA.released, true);
    assert.ok(paneA.hydrationEpoch > epochA, 'an in-flight hydration of the vanished pane is retired');
    assert.strictEqual(harness.read<boolean>('splitPanes.has("s-a")'), false);
    assert.strictEqual(pane('s-b').paneEl, paneBEl, 'the other panes are left in place');
    assert.notStrictEqual(pane('s-b').term, termA);

    harness.emitSession(pushState('b', rows([])));
    await settle();
    assert.strictEqual(harness.elements.get('terminal-split'), undefined, 'the last split leaving removes the row');
    assert.strictEqual(harness.container.classList.contains('split'), false);
    assert.strictEqual(harness.splitButton.classList.contains('active'), false);
  });

  it('routes each pane input to its own session id', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-a', 's-b']),
      splitRow('s-a', 'b'),
      splitRow('s-b', 'b'),
    ]));
    await settle();

    pane('s-a').term.emitData('echo a');
    pane('s-b').term.emitData('echo b');
    pane('s-a').term.emitData('!');

    assert.deepStrictEqual(
      harness.apiCallArgs.filter((c) => c.name === 'sendTerminalInputTo').map((c) => c.args),
      [['s-a', 'echo a'], ['s-b', 'echo b'], ['s-a', '!']],
    );
  });

  it('wakes only the sleeping session whose pane received the keystroke', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-a', 's-b']),
      splitRow('s-a', 'b', { state: 'sleeping' }),
      splitRow('s-b', 'b'),
    ]));
    await settle();

    pane('s-b').term.emitData('live');
    pane('s-a').term.emitData('wake');
    await settle();

    assert.deepStrictEqual(
      harness.apiCallArgs.filter((c) => c.name === 'wakeTerminal').map((c) => c.args),
      [['s-a']],
    );
    assert.deepStrictEqual(
      harness.apiCallArgs.filter((c) => c.name === 'sendTerminalInputTo').map((c) => c.args),
      [['s-b', 'live']],
      'the awake pane forwards directly; the sleeping one buffers for the wake',
    );
  });

  it('writes live output only to the pane of the session that produced it', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-a', 's-b']),
      splitRow('s-a', 'b'),
      splitRow('s-b', 'b'),
    ]));
    await settle();
    await settle();

    harness.emitData({ sessionId: 's-b', data: 'only-b', seq: 1, generation: 1 });
    await settle();

    assert.ok(pane('s-b').term.writes.includes('only-b'));
    assert.strictEqual(pane('s-a').term.writes.includes('only-b'), false);
    assert.strictEqual(harness.read<number>('splitPanes.get("s-b").lastRenderedSeq'), 1);
    assert.strictEqual(harness.read<number>('splitPanes.get("s-a").lastRenderedSeq'), 0, 'each pane keeps its own cursor');
  });

  it('renders a role badge on sync and agent panes only, and follows role and rename changes', async () => {
    const rows = (syncRole: string | undefined, label: string): Row[] => [
      baseRow('b', ['s-sync', 's-agent', 's-plain']),
      splitRow('s-sync', 'b', { role: syncRole, displayLabel: label }),
      splitRow('s-agent', 'b', { role: 'agent' }),
      splitRow('s-plain', 'b'),
    ];
    harness.emitSession(pushState('b', rows('sync', 'Watcher')));
    await settle();

    const badge = (id: string) => pane(id).badgeEl;
    assert.strictEqual(badge('s-sync').textContent, 'sync');
    assert.match(badge('s-sync').className, /split-pane-role-badge/);
    assert.match(badge('s-sync').className, /role-sync/);
    assert.match(badge('s-sync').title, /Watcher/);
    assert.strictEqual(badge('s-sync').style.display, '');
    assert.strictEqual(badge('s-agent').textContent, 'agent');
    assert.match(badge('s-agent').className, /role-agent/);
    assert.strictEqual(badge('s-plain').textContent, '');
    assert.strictEqual(badge('s-plain').style.display, 'none', 'a role-less pane shows no badge');
    assert.match(pane('s-sync').closeBtn.title, /dừng watcher/, 'closing a sync pane says it stops the watcher');
    assert.doesNotMatch(pane('s-plain').closeBtn.title, /watcher/);

    harness.emitSession(pushState('b', rows(undefined, 'Renamed')));
    await settle();
    assert.strictEqual(badge('s-sync').textContent, '', 'the badge goes when the role does');
    assert.strictEqual(badge('s-sync').style.display, 'none');
    assert.strictEqual(pane('s-sync').labelEl.textContent, 'Renamed');
  });

  it('closes a pane from its header, asking first only for a sync pane', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-sync', 's-manual']),
      splitRow('s-sync', 'b', { role: 'sync' }),
      splitRow('s-manual', 'b'),
    ]));
    await settle();

    harness.setConfirmAnswer(false);
    pane('s-sync').closeBtn.dispatch('click');
    await settle();
    assert.strictEqual(harness.confirmMessages.length, 1);
    assert.match(harness.confirmMessages[0]!, /watcher/);
    assert.deepStrictEqual(unsplitCalls(), [], 'a declined confirm closes nothing');
    assert.deepStrictEqual(paneOrder(), ['s-sync', 's-manual']);

    harness.setConfirmAnswer(true);
    pane('s-sync').closeBtn.dispatch('click');
    await settle();
    assert.deepStrictEqual(unsplitCalls(), [['s-sync']], 'the close names exactly that split');
    assert.deepStrictEqual(paneOrder(), ['s-manual']);

    pane('s-manual').closeBtn.dispatch('click');
    await settle();
    assert.strictEqual(harness.confirmMessages.length, 2, 'a manual pane closes without asking');
    assert.deepStrictEqual(unsplitCalls(), [['s-sync'], ['s-manual']]);
    assert.strictEqual(harness.elements.get('terminal-split'), undefined);
  });

  it('toggling off closes only the manual split and leaves sync panes mounted', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-sync', 's-manual']),
      splitRow('s-sync', 'b', { role: 'sync' }),
      splitRow('s-manual', 'b'),
    ]));
    await settle();
    assert.match(harness.splitButton.title, /Unsplit/, 'a manual split exists, so the button offers to close it');

    await harness.splitButton.onclick!();

    assert.deepStrictEqual(unsplitCalls(), [['s-manual']], 'the toggle closes exactly the manual split');
    assert.deepStrictEqual(paneOrder(), ['s-sync']);
    assert.strictEqual(harness.confirmMessages.length, 0, 'the toggle never asks about the watcher: it never touches it');
    assert.strictEqual(harness.splitButton.classList.contains('active'), true, 'a sync pane is still a split');
    // Main answers the close with a session push that no longer lists the manual split.
    harness.emitSession(pushState('b', [baseRow('b', ['s-sync']), splitRow('s-sync', 'b', { role: 'sync' })]));
    await settle();
    assert.match(harness.splitButton.title, /thêm một ô bên dưới \(Split\)/, 'with no manual split left the button offers to create one');
  });

  it('toggling on with only a sync pane creates the manual split and adds it to the end of the row', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-sync']),
      splitRow('s-sync', 'b', { role: 'sync' }),
    ]));
    await settle();
    const created: string[] = [];
    harness.api.splitTerminal = async (parentId) => {
      created.push(parentId);
      return 's-new';
    };

    await harness.splitButton.onclick!();

    assert.deepStrictEqual(created, ['b']);
    assert.deepStrictEqual(unsplitCalls(), []);
    assert.deepStrictEqual(paneOrder(), ['s-sync', 's-new'], 'the new split is appended after the sync pane');
    assert.match(harness.splitButton.title, /Unsplit/);
  });

  it('enables the Space splits button only for a base whose Space declares splits, and lights it once they are all open', async () => {
    const asked: string[] = [];
    harness.api.getSpaceSplits = async (sessionId: string) => {
      asked.push(sessionId);
      return sessionId === 'b1'
        ? { ok: true, folder: 'E:/p', baseSpecId: 'main', splits: [{ id: 'haravan', label: 'Haravan sync', role: 'sync' }, { id: 'sapo', label: 'Sapo', role: 'shell' }] }
        : { ok: false, reason: 'NO_SPLITS', message: 'none' };
    };
    const button = harness.elements.get('btnSpaceSplits')!;
    harness.emitSession(pushState('b1', [baseRow('b1', []), baseRow('b2', [])]));
    await settle();
    assert.deepStrictEqual(asked, ['b1']);
    assert.strictEqual(button.getAttribute('aria-disabled'), 'false');
    assert.match(button.title, /Mở 2 split của Space bên dưới: Haravan sync, Sapo/);
    assert.strictEqual(button.classList.contains('active'), false);

    harness.emitSession(pushState('b1', [
      baseRow('b1', ['p-h', 'p-s']),
      splitRow('p-h', 'b1', { role: 'sync', spaceTerminalId: 'haravan' }),
      splitRow('p-s', 'b1', { role: 'shell', spaceTerminalId: 'sapo' }),
      baseRow('b2', []),
    ]));
    await settle();
    assert.deepStrictEqual(asked, ['b1'], 'a session push for the same base does not ask Main again');
    assert.strictEqual(button.classList.contains('active'), true, 'every declared split has a pane');

    harness.emitSession(pushState('b2', [baseRow('b1', []), baseRow('b2', [])]));
    await settle();
    assert.deepStrictEqual(asked, ['b1', 'b2']);
    assert.strictEqual(button.getAttribute('aria-disabled'), 'true', 'b2 declares no split: the button stays visible but dimmed');
    assert.match(button.title, /không khai báo split nào/, 'the title says why');
    assert.strictEqual(button.classList.contains('active'), false);
  });

  it('opens the Space splits under the active base, showing the commands first and echoing the confirmed hash', async () => {
    harness.api.getSpaceSplits = async () => ({ ok: true, folder: 'E:/p', baseSpecId: 'main', splits: [{ id: 'haravan', label: 'Haravan sync', role: 'sync' }] });
    const opens: unknown[][] = [];
    harness.api.openSpaceSplits = async (...args: unknown[]) => {
      opens.push(args);
      return args.length === 1
        ? { ok: false, reason: 'NEEDS_CONFIRM', hash: 'h1', commands: [{ label: 'Haravan sync', command: 'hrv theme dev' }] }
        : { ok: true, terminalsOpened: 1, terminalsReused: 0, tabsOpened: 0, tabsReused: 0 };
    };
    harness.emitSession(pushState('b1', [baseRow('b1', [])]));
    await settle();
    const button = harness.elements.get('btnSpaceSplits')!;

    harness.setConfirmAnswer(false);
    await button.onclick!();
    assert.deepStrictEqual(opens, [['b1']], 'a declined prompt runs nothing');
    assert.match(harness.confirmMessages[0] ?? '', /Haravan sync: hrv theme dev/);

    harness.setConfirmAnswer(true);
    await button.onclick!();
    assert.deepStrictEqual(opens, [['b1'], ['b1'], ['b1', 'h1']]);
  });

  it('puts the panes the Space declares first, in space.json order, and the free splits last', async () => {
    harness.api.getSpaceSplits = async (sessionId: string) => sessionId === 'b1'
      ? { ok: true, folder: 'E:/p', baseSpecId: 'main', splits: [{ id: 'haravan', label: 'Haravan sync', role: 'sync' }, { id: 'sapo', label: 'Sapo sync', role: 'sync' }] }
      : { ok: false, reason: 'NO_MANIFEST', message: 'none' };
    // Creation order is the reverse of what the user wants: the free split first, then Sapo
    // (reopened before Haravan), then Haravan.
    const b1Rows = (extra: Row[] = []): Row[] => [
      baseRow('b1', ['free', 'p-s', 'p-h', ...extra.map((r) => String(r.id))]),
      splitRow('free', 'b1'),
      splitRow('p-s', 'b1', { role: 'sync', spaceTerminalId: 'sapo' }),
      splitRow('p-h', 'b1', { role: 'sync', spaceTerminalId: 'haravan' }),
      ...extra,
    ];
    harness.emitSession(pushState('b1', b1Rows()));
    await settle();
    assert.deepStrictEqual(rowIds(), ['p-h', 'p-s', 'free'], 'declared panes in space.json order, then the free one');
    assert.deepStrictEqual(paneOrder(), ['p-h', 'p-s', 'free']);
    assert.deepStrictEqual(
      dividers().map((d) => [d.getAttribute('data-left-id'), d.getAttribute('data-right-id')]),
      [['p-h', 'p-s'], ['p-s', 'free']],
      'the dividers follow the panes they now sit between',
    );

    harness.emitSession(pushState('b1', b1Rows([splitRow('free-2', 'b1')])));
    await settle();
    assert.deepStrictEqual(rowIds(), ['p-h', 'p-s', 'free', 'free-2'], 'a later free split joins the end');

    // A Space that cannot be read still keeps its declared panes ahead of the free ones.
    harness.emitSession(pushState('b2', [
      ...b1Rows(),
      baseRow('b2', ['f2', 'q-s', 'q-h']),
      splitRow('f2', 'b2'),
      splitRow('q-s', 'b2', { role: 'sync', spaceTerminalId: 'sapo' }),
      splitRow('q-h', 'b2', { role: 'sync', spaceTerminalId: 'haravan' }),
    ]));
    await settle();
    assert.deepStrictEqual(rowIds(), ['q-s', 'q-h', 'f2']);
  });

  it('resizes adjacent panes by dragging their divider, clamped, and persists the fractions per base', async () => {
    const state = pushState('b1', [
      baseRow('b1', ['p1', 'p2']),
      splitRow('p1', 'b1'),
      splitRow('p2', 'b1'),
      baseRow('b2', ['q1']),
      splitRow('q1', 'b2'),
    ]);
    harness.emitSession(state);
    await settle();

    assert.strictEqual(pane('p1').paneEl.style.flex, '0.5 1 0px', 'new panes start with equal widths');
    assert.strictEqual(pane('p2').paneEl.style.flex, '0.5 1 0px');

    stubRect(pane('p1').paneEl, 0, 400);
    stubRect(pane('p2').paneEl, 407, 807);
    const divider = dividers()[0]!;
    divider.dispatch('pointerdown', { pointerId: 1, clientX: 400 });
    assert.match(divider.className, /dragging/);

    harness.dispatchWindowPointer('pointermove', { clientX: 250 });
    const dragged = 250 / 807;
    assert.ok(Math.abs(storedWeight('b1', 'p1') - dragged) < 1e-9, 'the dragged pane takes the pointer position');
    assert.ok(Math.abs(storedWeight('b1', 'p1') + storedWeight('b1', 'p2') - 1) < 1e-9, 'fractions of the base always sum to 1');
    assert.strictEqual(pane('p1').paneEl.style.flex, `${storedWeight('b1', 'p1')} 1 0px`);
    assert.strictEqual(pane('p2').paneEl.style.flex, `${storedWeight('b1', 'p2')} 1 0px`);

    harness.dispatchWindowPointer('pointermove', { clientX: 5 });
    const clampedLeft = 200 / 807;
    assert.ok(Math.abs(storedWeight('b1', 'p1') - clampedLeft) < 1e-9, 'a pane cannot be dragged below the minimum width');
    harness.dispatchWindowPointer('pointerup', {});
    assert.doesNotMatch(divider.className, /dragging/);

    // Another base has its own widths; coming back restores this base's.
    harness.emitSession({ ...state, activeSessionId: 'b2' });
    await settle();
    assert.deepStrictEqual(rowIds(), ['q1']);
    assert.strictEqual(pane('q1').paneEl.style.flex, '1 1 0px', 'a single pane takes the whole row');

    harness.emitSession(state);
    await settle();
    assert.deepStrictEqual(rowIds(), ['p1', 'p2']);
    assert.ok(Math.abs(storedWeight('b1', 'p1') - clampedLeft) < 1e-9, 'the dragged width survives a round trip to another base');
    assert.strictEqual(pane('p1').paneEl.style.flex, `${storedWeight('b1', 'p1')} 1 0px`);
    assert.strictEqual(pane('p2').paneEl.style.flex, `${storedWeight('b1', 'p2')} 1 0px`);
  });

  it('sizes every pane PTY from its own fit and re-fits the whole row', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-a', 's-b']),
      splitRow('s-a', 'b'),
      splitRow('s-b', 'b'),
    ]));
    await settle();
    await settle();
    harness.apiCalls.length = 0;
    harness.apiCallArgs.length = 0;

    pane('s-a').term.resize(10, 3);
    pane('s-b').term.resize(10, 3);
    harness.read<() => void>('fitSplitPanes')();

    const resizes = harness.apiCallArgs.filter((c) => c.name === 'resizeTerminalTo').map((c) => c.args[0]);
    assert.deepStrictEqual(resizes.sort(), ['s-a', 's-b'], 'each pane reports its own geometry to its own session');
  });

  it('focuses the pane last interacted with, falling back to the newest, and main on request', async () => {
    harness.emitSession(pushState('b', [
      baseRow('b', ['s-a', 's-b']),
      splitRow('s-a', 'b'),
      splitRow('s-b', 'b'),
    ]));
    await settle();
    const focusSplit = harness.read<(id?: string) => void>('focusSplitPane');
    const focusMain = harness.read<() => void>('focusMainPane');
    const row = harness.elements.get('terminal-split')!;
    const focused = (): string[] => rowPanes().filter((el) => el.classList.contains('is-focused')).map((el) => el.getAttribute('data-session-id')!);

    focusSplit();
    assert.deepStrictEqual(focused(), ['s-a'], 'with no interaction the first mounted pane is the focus target');
    assert.strictEqual(row.classList.contains('focused-pane'), true);

    pane('s-b').paneEl.dispatch('focusin');
    assert.deepStrictEqual(focused(), ['s-b'], 'focus moves into the pane the user touched');

    focusMain();
    assert.deepStrictEqual(focused(), []);
    assert.strictEqual(row.classList.contains('focused-pane'), false);
    assert.strictEqual(harness.mainPane.classList.contains('focused-pane'), true);

    focusSplit();
    assert.deepStrictEqual(focused(), ['s-b'], 'the shortcut returns to the pane last interacted with');
  });
});
