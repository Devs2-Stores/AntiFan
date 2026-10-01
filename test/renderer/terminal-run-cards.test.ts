/**
 * Run cards + capsule pinned brief (Renderer).
 *
 * The card is a projection of a terminal-bound run pushed by Main on
 * `onRunCardState` (`{ runs: RunCardState[] }`). Verifies:
 * - a pushed payload paints one card per session inside its tab wrap (sidebar):
 *   state dot, elapsed, mode badge, last tool, capsule label, promptHead tooltip
 * - the card ticks elapsed locally from runStartedAt (1s interval, no IPC)
 * - a `viewOnly` card renders its tag and no operator controls
 * - an ended+stale card renders the dimmed `kết thúc` chip and no buttons
 * - run cards carry no cancel/steer controls: run lifecycle is owned by OMP,
 *   so every card state is display-only evidence
 * - the change footer lists deduped files and a path click calls `openInVSCode`
 * - the horizontal strip folds the run state into a dot and mounts no card
 * - clicking a card never activates or retargets the session
 * - the capsule brief dialog reads `capsuleGetBrief`, writes `capsuleSetBrief`,
 *   closes on Escape, and surfaces a refused write's reason
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, pickHeaderMenuItem, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

const lastArgs = (harness: StandaloneHarness, name: string): unknown[] | undefined =>
  harness.apiCallArgs.filter((entry) => entry.name === name).at(-1)?.args;

const countCalls = (harness: StandaloneHarness, name: string): number =>
  harness.apiCalls.filter((entry) => entry === name).length;
/** Normalize vm-realm objects so deepStrictEqual compares structure, not prototypes. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));


/** The shared manager in the sidebar layout: capsule groups + room for cards. */
const MANAGER_SIDEBAR_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
  terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 },
};

const MANAGER_HORIZONTAL_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
  terminalTabPrefs: { layout: 'horizontal' },
};

const CAPSULES = [
  { id: 'capsule-comnieu', name: 'Comnieu', workspacePath: 'E:/Work/comnieu', projectId: 'proj-comnieu' },
  { id: 'capsule-phukien', name: 'Phukien', workspacePath: 'E:/Work/phukien', projectId: 'proj-phukien' },
];

async function loadManager(initialState: unknown = MANAGER_SIDEBAR_STATE): Promise<StandaloneHarness> {
  const harness = loadStandalone({ initialState });
  harness.api.listCapsules = async () => ({ activeCapsuleId: 'capsule-comnieu', capsules: CAPSULES });
  await flush();
  harness.apiCalls.length = 0;
  harness.apiCallArgs.length = 0;
  return harness;
}

function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
}

function runningCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalSessionId: 's1',
    ompSessionId: 'omp-1',
    state: 'running',
    stale: false,
    mode: 'direct',
    runSeq: 3,
    runStartedAt: Date.now() - 65_000,
    lastEventAt: Date.now() - 5_000,
    lastTool: 'theme.check',
    promptHead: 'sửa header cho storefront',
    capsuleId: 'capsule-comnieu',
    viewOnly: false,
    ...overrides,
  };
}

function wrapFor(harness: StandaloneHarness, sessionId: string): FakeElement {
  const wrap = harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${sessionId}"]`);
  assert.ok(wrap, `expected a tab wrap for ${sessionId}`);
  return wrap;
}

function cardFor(harness: StandaloneHarness, sessionId: string): FakeElement {
  const wrap = wrapFor(harness, sessionId);
  const card = wrap.querySelector('.terminal-run-card');
  assert.ok(card, `expected a run card on ${sessionId}`);
  return card;
}

describe('Renderer run cards', () => {
  it('paints one card per pushed run inside its own tab wrap', async () => {
    const harness = await loadManager();
    seed(harness, [
      { id: 's1', name: 'S1', state: 'running', capsuleId: 'capsule-comnieu', ownerKey: 'project:proj-comnieu' },
      { id: 's2', name: 'S2', state: 'running', capsuleId: 'capsule-phukien', ownerKey: 'project:proj-phukien' },
    ], 's1');
    harness.renderTabs();

    harness.emitRunCardState({ runs: [
      runningCard(),
      runningCard({ terminalSessionId: 's2', ompSessionId: 'omp-2', mode: 'fast', promptHead: 'fix footer', capsuleId: 'capsule-phukien', lastTool: 'bash' }),
    ] });

    const card = cardFor(harness, 's1');
    assert.ok(card.classList.contains('is-compact'), 'every card renders the compact single-line form');
    const state = card.querySelector('.terminal-run-state');
    assert.strictEqual(state?.textContent, 'đang chạy');
    const mode = card.querySelector('.terminal-run-mode');
    assert.strictEqual(mode?.textContent, 'Direct');
    const tool = card.querySelector('.terminal-run-tool');
    assert.strictEqual(tool?.textContent, 'theme.check');
    const capsule = card.querySelector('.terminal-run-capsule');
    assert.strictEqual(capsule?.textContent, 'Comnieu', 'capsule label resolves through the index');
    assert.strictEqual(card.getAttribute('title'), 'sửa header cho storefront', 'promptHead is the card tooltip');

    const card2 = cardFor(harness, 's2');
    assert.strictEqual(card2.querySelector('.terminal-run-mode')?.textContent, 'Fast');
    assert.strictEqual(card2.querySelector('.terminal-run-capsule')?.textContent, 'Phukien');
  });

  it('waits state paints amber-waiting and hides the mode badge for unset', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', capsuleId: 'capsule-comnieu', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({ state: 'waiting_user', mode: 'unset' })] });

    const card = cardFor(harness, 's1');
    assert.ok(card.querySelector('.terminal-run-dot.run-waiting_user'), 'waiting dot');
    assert.strictEqual(card.querySelector('.terminal-run-state')?.textContent, 'chờ bạn');
    assert.strictEqual(card.querySelector('.terminal-run-mode'), null, 'unset mode shows no badge');
  });

  it('renders no elapsed read-out — the banner keeps no clock', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({ runStartedAt: Date.now() - 60_500 })] });
    const card = cardFor(harness, 's1');
    assert.strictEqual(card.querySelector('.terminal-run-elapsed'), null, 'the elapsed element is gone');
    const head = card.querySelector('.terminal-run-head')?.textContent;
    await flush();
    assert.strictEqual(card.querySelector('.terminal-run-head')?.textContent, head, 'nothing repaints without a new payload');
  });

  it('renders a viewOnly row with the tag and no controls', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', capsuleId: 'capsule-comnieu', ownerKey: 'agent:tab-7' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({ viewOnly: true })] });

    const card = cardFor(harness, 's1');
    const tag = card.querySelector('.terminal-run-viewonly');
    assert.ok(tag, 'a view-only tag renders');
    assert.strictEqual(tag?.textContent, 'Chỉ xem', 'a view-only tag names the read-only reason');
    assert.strictEqual(card.querySelector('.terminal-run-actions'), null, 'no actions container renders');
    assert.strictEqual(card.querySelectorAll('.terminal-run-btn').length, 0, 'no run control buttons');
    assert.strictEqual(countCalls(harness, 'runControl'), 0, 'no IPC is sent for a viewed row');
  });

  it('renders no cancel/steer controls on a live owned run — OMP owns run lifecycle', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard()] });

    const card = cardFor(harness, 's1');
    assert.strictEqual(card.querySelector('.terminal-run-actions'), null, 'a live run mounts no actions container');
    assert.strictEqual(card.querySelectorAll('.terminal-run-btn').length, 0, 'no run control buttons render');
    assert.strictEqual(card.querySelector('.terminal-run-steer-row'), null, 'no steer input exists');
    assert.strictEqual(countCalls(harness, 'runControl'), 0, 'the renderer never drives runControl itself');
  });

  it('renders ended+stale as a compact one-line card with the kết thúc chip and no buttons', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({ state: 'ended', stale: true })] });

    const card = cardFor(harness, 's1');
    assert.ok(card.classList.contains('is-compact'), 'an ended run collapses to the compact card');
    const head = card.querySelector('.terminal-run-head');
    const chip = card.querySelector('.terminal-run-ended-chip');
    assert.ok(chip, 'the corpse chip renders');
    assert.match(chip?.textContent ?? '', /kết thúc/);
    assert.strictEqual(chip?.parent, head, 'the chip folds into the single head line');
    assert.strictEqual(card.querySelector('.terminal-run-meta'), null, 'the meta row stays out of the compact card');
    assert.strictEqual(card.querySelector('.terminal-run-btn'), null, 'an ended run offers no controls');
    assert.strictEqual(
      Array.from(card.children).filter((c) => c !== head && !c.classList.contains('terminal-run-changes')).length,
      0,
      'nothing beside the head (and optional changes footer) survives on a compact card',
    );
  });

  it('an idle run adds nothing to the row', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard()] });
    assert.ok(wrapFor(harness, 's1').classList.contains('has-run-card'));

    harness.emitRunCardState({ runs: [runningCard({ state: 'idle' })] });
    const wrap = wrapFor(harness, 's1');
    assert.strictEqual(wrap.querySelector('.terminal-run-card'), null, 'an idle card must not grow the row');
    assert.strictEqual(wrap.classList.contains('has-run-card'), false);
    assert.strictEqual(wrap.querySelector('.terminal-tab-run-badge'), null, 'an idle run wears no badge');
  });

  it('shows the change-review footer, expands files, and opens a path in VS Code', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({
      changes: { files: ['sections/header.liquid', 'assets/theme.css'], fileCount: 2, blockedCount: 1 },
    })] });

    const card = cardFor(harness, 's1');
    const summary = card.querySelector('.terminal-run-changes-summary');
    assert.strictEqual(summary?.textContent, '2 file đã sửa · 1 bị chặn');
    const list = card.querySelector('.terminal-run-changes-list');
    assert.ok(list);
    assert.strictEqual(list.style.display, 'none', 'the file list starts collapsed');

    summary.dispatch('click');
    assert.strictEqual(list.style.display, 'block');
    const files = list.querySelectorAll('.terminal-run-file');
    assert.strictEqual(files.length, 2);
    files[0]?.dispatch('click');
    assert.deepStrictEqual(lastArgs(harness, 'openInVSCode'), ['sections/header.liquid']);
  });

  it('omits the footer when the run changed nothing', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({ changes: { files: [], fileCount: 0, blockedCount: 0 } })] });
    assert.strictEqual(cardFor(harness, 's1').querySelector('.terminal-run-changes'), null);
  });

  it('clears the card when the projection drops the run', async () => {
    const harness = await loadManager();
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard()] });
    assert.ok(wrapFor(harness, 's1').querySelector('.terminal-run-card'));
    harness.emitRunCardState({ runs: [] });
    assert.strictEqual(wrapFor(harness, 's1').querySelector('.terminal-run-card'), null, 'the pruned run leaves no corpse');
  });

  it('folds the run state into a strip dot in the horizontal layout and mounts no card', async () => {
    const harness = await loadManager(MANAGER_HORIZONTAL_STATE);
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard()] });

    const wrap = wrapFor(harness, 's1');
    assert.strictEqual(wrap.querySelector('.terminal-run-card'), null, 'horizontal strips mount no card');
    const dot = wrap.querySelector('.terminal-run-strip-dot');
    assert.ok(dot, 'the folded state dot exists');
    assert.match(dot.className, /run-running/);
  });

  it('never activates or retargets the session when the card is clicked', async () => {
    const harness = await loadManager();
    seed(harness, [
      { id: 's1', name: 'S1', state: 'running', ownerKey: 'project:proj-comnieu' },
      { id: 's2', name: 'S2', state: 'running', ownerKey: 'project:proj-phukien' },
    ], 's1');
    harness.renderTabs();
    harness.emitRunCardState({ runs: [runningCard({ terminalSessionId: 's2' })] });

    const card = cardFor(harness, 's2');
    card.dispatch('click');
    await flush();
    assert.strictEqual(harness.getActiveId(), 's1', 'the card is a projection: clicking it focuses nothing');
  });
});

describe('Renderer capsule pinned brief', () => {
  function capsuleHeader(harness: StandaloneHarness, capsuleId: string): FakeElement {
    const header = harness.tabsRoot.querySelector(`.terminal-tab-category-header[data-capsule-id="${capsuleId}"]`);
    assert.ok(header, `expected a capsule group header for ${capsuleId}`);
    return header;
  }

  async function loadWithBrief(options: {
    brief?: unknown;
    setReply?: unknown;
  } = {}): Promise<{ harness: StandaloneHarness; dialog: FakeElement }> {
    const harness = await loadManager();
    harness.api.capsuleGetBrief = async (capsuleId: string) => ({
      ok: true,
      capsuleId,
      brief: options.brief ?? null,
    });
    harness.api.capsuleSetBrief = async () => options.setReply ?? { ok: true, capsuleId: 'capsule-comnieu', brief: null };
    seed(harness, [{ id: 's1', name: 'S1', state: 'running', capsuleId: 'capsule-comnieu', ownerKey: 'project:proj-comnieu' }], 's1');
    harness.renderTabs();
    pickHeaderMenuItem(harness, capsuleHeader(harness, 'capsule-comnieu'), 'Ghi chú dự án');
    await flush();
    const dialog = harness.capsuleBriefDialog;
    assert.strictEqual(dialog.style.display, 'flex', 'the dialog opens');
    return { harness, dialog };
  }

  it('opens from the capsule header, reads the brief and fills the fields', async () => {
    const { harness, dialog } = await loadWithBrief({
      brief: { storefrontUrl: 'https://comnieu.myharavan.com', siteName: 'Cơm Niêu', themeId: '1001512680', rules: ['rule one', 'rule two'] },
    });
    assert.deepStrictEqual(lastArgs(harness, 'capsuleGetBrief'), ['capsule-comnieu']);
    assert.match(dialog.querySelector('#capsuleBriefTitle')?.textContent ?? '', /Comnieu/);
    const url = dialog.querySelector('#capsuleBriefUrl');
    const site = dialog.querySelector('#capsuleBriefSite');
    const theme = dialog.querySelector('#capsuleBriefTheme');
    const rules = dialog.querySelector('#capsuleBriefRules');
    assert.strictEqual(url?.value, 'https://comnieu.myharavan.com');
    assert.strictEqual(site?.value, 'Cơm Niêu');
    assert.strictEqual(theme?.value, '1001512680');
    assert.strictEqual(rules?.value, 'rule one\nrule two');
  });

  it('writes the edited brief through capsuleSetBrief and closes on success', async () => {
    const { harness, dialog } = await loadWithBrief();
    const url = dialog.querySelector('#capsuleBriefUrl');
    const site = dialog.querySelector('#capsuleBriefSite');
    const theme = dialog.querySelector('#capsuleBriefTheme');
    const rules = dialog.querySelector('#capsuleBriefRules');
    assert.ok(url && site && theme && rules, 'the dialog fields exist');
    url.value = 'https://phukien.myharavan.com';
    site.value = 'Phu Kien';
    theme.value = '1001600999';
    rules.value = 'no css generated\nalways check responsive\n';

    dialog.querySelector('#capsuleBriefSave')?.dispatch('click');
    await flush();

    assert.deepStrictEqual(plain(lastArgs(harness, 'capsuleSetBrief')), [
      'capsule-comnieu',
      { storefrontUrl: 'https://phukien.myharavan.com', siteName: 'Phu Kien', themeId: '1001600999', rules: ['no css generated', 'always check responsive'] },
    ], 'the edited brief travels as one payload');
    assert.strictEqual(dialog.style.display, 'none', 'a saved brief closes the dialog');
  });

  it('writes null when every field is empty, which clears the brief', async () => {
    const { harness, dialog } = await loadWithBrief();
    dialog.querySelector('#capsuleBriefSave')?.dispatch('click');
    await flush();
    assert.deepStrictEqual(lastArgs(harness, 'capsuleSetBrief'), ['capsule-comnieu', null]);
  });

  it('clears through the dedicated button', async () => {
    const { harness, dialog } = await loadWithBrief({ brief: { siteName: 'Cơm Niêu' } });
    dialog.querySelector('#capsuleBriefClear')?.dispatch('click');
    await flush();
    assert.deepStrictEqual(lastArgs(harness, 'capsuleSetBrief'), ['capsule-comnieu', null]);
    assert.strictEqual(dialog.style.display, 'none');
  });

  it('surfaces a refused write with its reason and keeps the dialog open', async () => {
    const { harness, dialog } = await loadWithBrief({
      setReply: { ok: false, reason: 'INVALID_BRIEF', message: 'storefrontUrl must be http(s)' },
    });
    const url = dialog.querySelector('#capsuleBriefUrl');
    assert.ok(url, 'the url field exists');
    url.value = 'ftp://not-a-storefront';
    dialog.querySelector('#capsuleBriefSave')?.dispatch('click');
    await flush();

    assert.strictEqual(dialog.style.display, 'flex', 'a refused write does not pretend to save');
    const error = dialog.querySelector('#capsuleBriefError');
    assert.match(error?.textContent ?? '', /INVALID_BRIEF/);
    assert.match(error?.textContent ?? '', /storefrontUrl must be http\(s\)/);
  });

  it('closes on Escape without writing', async () => {
    const { harness, dialog } = await loadWithBrief();
    const url = dialog.querySelector('#capsuleBriefUrl');
    assert.ok(url, 'the url field exists');
    url.dispatch('keydown', { key: 'Escape' });
    await flush();
    assert.strictEqual(dialog.style.display, 'none');
    assert.strictEqual(countCalls(harness, 'capsuleSetBrief'), 0);
  });

  it('closes on the document-level Escape listener as well', async () => {
    const { harness, dialog } = await loadWithBrief();
    // The document listener is armed a macrotask after open (the deferred pattern
    // the other popovers use so the opening click cannot close them again) — a
    // real tick is the only way to let that registration land.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    for (const listener of [...harness.documentKeydownListeners]) {
      listener({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    }
    assert.strictEqual(dialog.style.display, 'none');
  });
});
