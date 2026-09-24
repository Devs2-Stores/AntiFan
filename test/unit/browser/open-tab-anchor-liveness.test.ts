/**
 * What `openTab` reports when the tab cannot belong to the session.
 *
 * A session is identified by its anchor tab. Two different failures can stop a new
 * tab from joining it, and they need different recoveries:
 *
 * - the anchor is gone, so no tab can be adopted at all - the session must be
 *   rebound to a live tab before anything else can work;
 * - the anchor is alive but its pool refused the tab - normally a full session,
 *   where the caller closes a tab it owns.
 *
 * Reporting the first as the second is not cosmetic: the measured case sent the
 * caller looking for tabs to close while the session's managed set held one id, and
 * the refusal named a quota that had not been reached.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';
import type { BrowserTarget } from '../../../src/shared/control-plane-contracts';

const SESSION_TAB_LIMIT = 10;

type Harness = {
  port: BrowserControlPort;
  target: BrowserTarget;
  created: string[];
  closed: string[];
};

function makeHarness(options: {
  anchorAlive: boolean;
  adopt: boolean;
  owned: string[];
}): Harness {
  const created: string[] = [];
  const closed: string[] = [];
  const host = {
    hasTab: (tabId?: string | null) => Boolean(tabId) && tabId === 'tab-anchor' && options.anchorAlive,
    getTabList: () => [{ id: 'tab-anchor', url: 'about:blank', title: 'Anchor' }],
    getManagedTabIds: () => new Set(options.owned),
    adoptChildTab: () => options.adopt,
    createTab: (_url?: string) => {
      const id = `tab-created-${created.length + 1}`;
      created.push(id);
      return id;
    },
    closeTab: (tabId: string) => {
      closed.push(tabId);
      return true;
    },
  } as unknown as BrowserHostPort;
  return {
    port: new BrowserControlPort(host),
    target: { tabId: 'tab-anchor' } as unknown as BrowserTarget,
    created,
    closed,
  };
}

function refusal(run: () => unknown): CapabilityError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CapabilityError, `expected a CapabilityError, received ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to be refused');
}

describe('Opening a tab for a session', () => {
  it('refuses a dead anchor without creating a tab, and names the rebind recovery', () => {
    const { port, target, created, closed } = makeHarness({ anchorAlive: false, adopt: false, owned: ['tab-anchor'] });

    const error = refusal(() => port.openTab({}, { target }));

    assert.equal(error.code, 'TARGET_STALE');
    assert.equal(error.details?.boundTabId, 'tab-anchor');
    assert.equal(error.details?.recovery, 'anti.browser.rebind_target');
    // Nothing is created, so there is no leak to close either.
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(closed, []);
  });

  it('reports a pool refusal under the limit as the measured count, not as the quota', () => {
    const { port, target, created, closed } = makeHarness({ anchorAlive: true, adopt: false, owned: ['tab-anchor'] });

    const error = refusal(() => port.openTab({}, { target }));

    assert.equal(error.code, 'SESSION_STALE');
    assert.equal(error.details?.used, 1);
    assert.equal(error.details?.limit, SESSION_TAB_LIMIT);
    assert.deepStrictEqual(error.details?.countedTabIds, ['tab-anchor']);
    // The tab it could not own is closed rather than left outside the session.
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.deepStrictEqual(closed, ['tab-created-1']);
  });

  it('refuses a full session at the gate, before creating anything, and reports the quota', () => {
    const owned = Array.from({ length: SESSION_TAB_LIMIT }, (_, index) => `tab-owned-${index + 1}`);
    const { port, target, created, closed } = makeHarness({ anchorAlive: true, adopt: true, owned });

    const error = refusal(() => port.openTab({}, { target }));

    assert.equal(error.code, 'POLICY_DENIED');
    assert.equal(error.details?.used, SESSION_TAB_LIMIT);
    assert.equal(error.details?.limit, SESSION_TAB_LIMIT);
    // The gate refuses before the host creates a view, so there is nothing to close.
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(closed, []);
  });

  it('returns the created tab when the anchor adopts it', () => {
    const { port, target } = makeHarness({ anchorAlive: true, adopt: true, owned: ['tab-anchor'] });

    assert.deepStrictEqual(port.openTab({}, { target }), { tabId: 'tab-created-1' });
  });
});
