/**
 * Terminal tab-strip layout: header toggle + sidebar resizer.
 *
 * Regression guard for the shipped-but-unwired `#btnTerminalTabLayout`: the button,
 * the `#tabsSidebarResizer` separator and the whole `.standalone.tabs-sidebar` grid
 * existed in standalone.html/css, but standalone.js bound no handlers at all, so the
 * control was inert and the sidebar layout was unreachable.
 *
 * These tests drive the real shipped `src/renderer/standalone.js` inside the shared
 * vm harness (only document/window/xterm are stubbed), so they exercise the actual
 * wiring, clamping and persistence calls rather than a re-implementation.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/**
 * Drain a scheduled animation frame.
 *
 * The harness backs `requestAnimationFrame` with `setTimeout`, and node:test runs
 * test bodies from the event loop's *check* phase — where a `setImmediate`
 * continuation resolves before the next *timers* phase runs. Awaiting a real timer
 * is therefore the only thing that actually waits for the frame the renderer
 * scheduled, so drag assertions use this instead of `flush`.
 */
const flushFrame = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await flush();
};

const countCalls = (harness: StandaloneHarness, name: string): number =>
  harness.apiCalls.filter((entry) => entry === name).length;

const widthVar = (harness: StandaloneHarness): string =>
  harness.standaloneRoot.style.getPropertyValue('--term-sidebar-w');

const isSidebar = (harness: StandaloneHarness): boolean =>
  harness.standaloneRoot.classList.contains('tabs-sidebar');

/** The fake `getBoundingClientRect()` reports left=60 for every element. */
const CONTROLS_LEFT = 60;

describe('Renderer terminal tab-strip layout', () => {
  it('boots into the horizontal strip by default and publishes the default width', async () => {
    const harness = loadStandalone();
    await flush();

    assert.strictEqual(isSidebar(harness), false, 'a fresh install must stay horizontal');
    assert.strictEqual(harness.read<string>('terminalTabLayout'), 'horizontal');
    assert.strictEqual(harness.tabLayoutButton.getAttribute('aria-pressed'), 'false');
    assert.strictEqual(widthVar(harness), '220px');

    // The separator must not be reachable while it cannot be operated.
    assert.strictEqual(harness.tabSidebarResizer.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(harness.tabSidebarResizer.tabIndex, -1);
    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 0, 'boot must not persist anything');
  });

  it('boots into the persisted sidebar layout returned by GET_INITIAL_STATE', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 300 } },
    });
    await flush();

    assert.strictEqual(isSidebar(harness), true);
    assert.strictEqual(harness.read<string>('terminalTabLayout'), 'sidebar');
    assert.strictEqual(widthVar(harness), '300px');
    assert.strictEqual(harness.tabLayoutButton.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(harness.tabSidebarResizer.getAttribute('aria-hidden'), 'false');
    assert.strictEqual(harness.tabSidebarResizer.tabIndex, 0);
    assert.strictEqual(harness.tabSidebarResizer.getAttribute('aria-valuenow'), '300');
  });

  it('clamps a corrupt persisted width into the allowed range', async () => {
    const tooWide = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 9999 } },
    });
    await flush();
    assert.strictEqual(widthVar(tooWide), '400px');

    const tooNarrow = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: -5 } },
    });
    await flush();
    assert.strictEqual(widthVar(tooNarrow), '140px');

    const notANumber = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: Number.NaN } },
    });
    await flush();
    assert.strictEqual(widthVar(notANumber), '220px', 'a non-finite width falls back to the default');
  });

  it('the header button toggles both ways and asks the main process to persist', async () => {
    const harness = loadStandalone();
    await flush();
    assert.strictEqual(harness.tabLayoutButton.listeners['click']?.length, 1, 'the button must have a handler');

    harness.tabLayoutButton.dispatch('click');
    assert.strictEqual(isSidebar(harness), true, 'the first click must enter the sidebar layout');
    assert.strictEqual(harness.read<string>('terminalTabLayout'), 'sidebar');
    assert.strictEqual(harness.tabLayoutButton.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 1, 'the new layout must be persisted');
    await flush();

    harness.tabLayoutButton.dispatch('click');
    assert.strictEqual(isSidebar(harness), false, 'the second click must return to the horizontal strip');
    assert.strictEqual(harness.read<string>('terminalTabLayout'), 'horizontal');
    assert.strictEqual(harness.tabLayoutButton.getAttribute('aria-pressed'), 'false');
    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 2);
  });

  it('a resizer drag clamps to the bounds and persists once on release', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 220 } },
    });
    await flush();
    assert.strictEqual(harness.tabSidebarResizer.listeners['pointerdown']?.length, 1);

    harness.tabSidebarResizer.dispatch('pointerdown', { pointerId: 1 });
    assert.strictEqual(harness.tabSidebarResizer.classList.contains('is-dragging'), true);

    harness.tabSidebarResizer.dispatch('pointermove', { pointerId: 1, clientX: CONTROLS_LEFT + 1000 });
    await flushFrame();
    assert.strictEqual(widthVar(harness), '400px', 'a drag past the maximum must clamp');

    harness.tabSidebarResizer.dispatch('pointermove', { pointerId: 1, clientX: CONTROLS_LEFT - 500 });
    await flushFrame();
    assert.strictEqual(widthVar(harness), '140px', 'a drag past the minimum must clamp');

    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 0, 'a drag must not persist per frame');

    harness.tabSidebarResizer.dispatch('pointerup', { pointerId: 1 });
    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 1, 'the release must persist exactly once');
    assert.strictEqual(harness.tabSidebarResizer.classList.contains('is-dragging'), false);
    assert.strictEqual(widthVar(harness), '140px');
  });

  it('ignores resizer input while the strip is horizontal', async () => {
    const harness = loadStandalone();
    await flush();

    harness.tabSidebarResizer.dispatch('pointerdown', { pointerId: 1 });
    harness.tabSidebarResizer.dispatch('pointermove', { pointerId: 1, clientX: CONTROLS_LEFT + 90 });
    await flushFrame();

    assert.strictEqual(widthVar(harness), '220px', 'the width must not move in the horizontal layout');
    assert.strictEqual(harness.tabSidebarResizer.classList.contains('is-dragging'), false);
    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 0);
  });

  it('the separator is keyboard-operable and clamps the same way', async () => {
    const harness = loadStandalone({
      initialState: { terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 220 } },
    });
    await flush();

    harness.tabSidebarResizer.dispatch('keydown', { key: 'ArrowRight' });
    assert.strictEqual(widthVar(harness), '236px');
    assert.strictEqual(harness.tabSidebarResizer.getAttribute('aria-valuenow'), '236');

    harness.tabSidebarResizer.dispatch('keydown', { key: 'ArrowLeft' });
    assert.strictEqual(widthVar(harness), '220px');

    harness.tabSidebarResizer.dispatch('keydown', { key: 'Home' });
    assert.strictEqual(widthVar(harness), '140px');

    harness.tabSidebarResizer.dispatch('keydown', { key: 'End' });
    assert.strictEqual(widthVar(harness), '400px');

    assert.strictEqual(countCalls(harness, 'setTerminalTabPrefs'), 4, 'each keyboard step persists');
  });
});
