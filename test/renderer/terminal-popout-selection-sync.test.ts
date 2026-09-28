/**
 * Popout selection sync: the session the user picks in a terminal popout is the window's session.
 *
 * Drives the real shipped `src/renderer/standalone.js` through the shared vm harness in popout
 * mode. A popout used to switch its own pane without telling main, so the sidebar kept
 * highlighting the session the popout had left behind, and routes that ask main for "this
 * window's session" answered with the stale one.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/** The element a user actually clicks to select a tab. */
function tabButton(harness: StandaloneHarness, sessionId: string): FakeElement {
  const wrap = harness.tabsRoot.querySelector(`.terminal-tab-wrap[data-session-id="${sessionId}"]`);
  assert.ok(wrap, `expected a tab wrap for ${sessionId}`);
  const button = wrap.querySelector('.terminal-tab');
  assert.ok(button, `expected the tab button for ${sessionId}`);
  return button;
}

function reportedSwitches(harness: StandaloneHarness): unknown[] {
  return harness.apiCallArgs.filter((call) => call.name === 'switchTerminal').map((call) => call.args[0]);
}

function popoutWithTwoSessions(): StandaloneHarness {
  const harness = loadStandalone({ popout: true });
  harness.emitSession({
    activeSessionId: 's1',
    sessions: [
      { id: 's1', name: 'One', state: 'running' },
      { id: 's2', name: 'Two', state: 'running' },
    ],
    snapshot: '',
    snapshotThroughSeq: 0,
  });
  harness.renderTabs();
  return harness;
}

describe('Renderer terminal popout selection', () => {
  it('reports the session the user selects so the window follows it', async () => {
    const harness = popoutWithTwoSessions();
    await flush();

    harness.apiCalls.length = 0;
    harness.apiCallArgs.length = 0;
    tabButton(harness, 's2').click();

    assert.strictEqual(harness.getActiveId(), 's2', 'the popout shows the tab the user picked');
    assert.deepStrictEqual(reportedSwitches(harness), ['s2'], 'and reports exactly that selection to main');
  });

  it('reports nothing when the selected tab is already the active one', async () => {
    const harness = popoutWithTwoSessions();
    await flush();

    harness.apiCalls.length = 0;
    harness.apiCallArgs.length = 0;
    tabButton(harness, 's1').click();

    assert.deepStrictEqual(reportedSwitches(harness), [], 'a click that changes no selection is not a switch');
  });

  it('never repoints the window from popout traffic', async () => {
    const harness = popoutWithTwoSessions();
    await flush();

    harness.apiCalls.length = 0;
    harness.apiCallArgs.length = 0;
    harness.emitData({ sessionId: 's1', data: 'output-for-the-other-tab' });

    assert.strictEqual(harness.getActiveId(), 's1', 'arriving output does not change what the popout shows');
    assert.deepStrictEqual(reportedSwitches(harness), [], 'and never repoints the window active session');
  });
});
