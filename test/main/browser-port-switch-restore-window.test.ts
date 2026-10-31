import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import type { BrowserTarget } from '../../src/shared/control-plane-contracts';

const BOUND_TAB = 'tab-bound';
const SIBLING_TAB = 'tab-sibling';
const FOREIGN_TAB = 'tab-foreign';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'rt-1',
  tabId: BOUND_TAB,
  browserEpoch: 1,
  documentGeneration: 1,
};

const HIDDEN = { visible: false, minimized: true, maximized: false, hostWindowHidden: true };
const SHOWN = { visible: true, minimized: false, maximized: false, hostWindowHidden: false };

function makeHost(): { host: BrowserHostPort; restoreCalls: Array<string | undefined>; switched: string[] } {
  const restoreCalls: Array<string | undefined> = [];
  const switched: string[] = [];
  const hiddenWindows = new Set<string>([BOUND_TAB, SIBLING_TAB, FOREIGN_TAB]);
  const host = {
    getTabList: () => [{ id: BOUND_TAB }, { id: SIBLING_TAB }, { id: FOREIGN_TAB }],
    hasTab: () => true,
    isTabAllowed: (_bound: string, requested: string) => requested !== FOREIGN_TAB,
    trySwitchTab: (tabId: string) => {
      switched.push(tabId);
      return { ok: true, tabId };
    },
    getHostWindowPresentation: (tabId?: string) => (tabId && hiddenWindows.has(tabId) ? HIDDEN : SHOWN),
    restoreHostWindowUnfocused: (tabId?: string) => {
      restoreCalls.push(tabId);
      if (tabId) hiddenWindows.delete(tabId);
      return { restored: true, presentation: SHOWN };
    },
  };
  return { host: host as unknown as BrowserHostPort, restoreCalls, switched };
}

describe('switchTab restoreWindow', () => {
  it('presents the hidden window of the bound tab and reports it rendered', () => {
    const { host, restoreCalls } = makeHost();
    const port = new BrowserControlPort(host);
    const result = port.switchTab(BOUND_TAB, { target: TARGET, isAgent: true, restoreWindow: true });
    assert.deepStrictEqual(restoreCalls, [BOUND_TAB]);
    assert.deepStrictEqual(result, { switched: true, tabId: BOUND_TAB, rendered: true, hostWindowHidden: false });
  });

  it('restores the window of a tab the session may retarget', () => {
    const { host, restoreCalls } = makeHost();
    const port = new BrowserControlPort(host);
    const result = port.switchTab(SIBLING_TAB, { target: TARGET, isAgent: true, restoreWindow: true });
    assert.deepStrictEqual(restoreCalls, [SIBLING_TAB]);
    assert.strictEqual(result.rendered, true);
  });

  it('leaves a hidden window hidden and says so when restoreWindow is not requested', () => {
    const { host, restoreCalls } = makeHost();
    const port = new BrowserControlPort(host);
    const result = port.switchTab(BOUND_TAB, { target: TARGET, isAgent: true });
    assert.deepStrictEqual(restoreCalls, []);
    assert.deepStrictEqual(result, { switched: true, tabId: BOUND_TAB, rendered: false, hostWindowHidden: true });
  });

  it('never restores the window of a tab outside the session, though the agent plane may activate it', () => {
    const { host, restoreCalls, switched } = makeHost();
    const port = new BrowserControlPort(host);
    const result = port.switchTab(FOREIGN_TAB, { target: TARGET, isAgent: true, restoreWindow: true });
    assert.deepStrictEqual(switched, [FOREIGN_TAB]);
    assert.deepStrictEqual(restoreCalls, [], 'a foreign window must not be presented');
    assert.strictEqual(result.restoreRefused, 'TAB_NOT_IN_SESSION');
    assert.strictEqual(result.rendered, false);
    assert.strictEqual(result.hostWindowHidden, true);
  });

  it('refuses a user-plane switch to a foreign tab before any restore', () => {
    const { host, restoreCalls } = makeHost();
    const port = new BrowserControlPort(host);
    assert.throws(() => port.switchTab(FOREIGN_TAB, { target: TARGET, plane: 'user', restoreWindow: true }));
    assert.deepStrictEqual(restoreCalls, []);
  });
});
