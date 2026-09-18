/**
 * Releasing a session's tab slot, asserted at the source the quota gates read.
 *
 * The attachment registry is the only producer of release calls, and it knows the
 * tab it let go — not the key its pool happens to carry. A tab seated through
 * `createTab({ terminalSessionId })` or adopted by a terminal lives in a pool keyed
 * by the terminal id, so a key-only release is a silent no-op: the slot stays
 * counted after a rebind-away and the next `openTab` refuses against a tab the
 * session has already given up (R1 in the remediation plan's phase 08).
 *
 * `getManagedTabIds` is the observable because it is the single pruning source both
 * quota gates and the adopt path read — a slot freed here is freed for all of them.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';

type HostInternals = {
  tabs: Map<string, unknown>;
  sessionTabPools: Map<string, Set<string>>;
  terminalAgentAffinity: Map<string, unknown> | undefined;
  getManagedTabIds: (key: string) => Set<string>;
  adoptChildTabForSession: (sessionId: string, childTabId: string) => boolean;
  adoptChildTab: (identifier: string, childTabId: string, generation?: number | string) => boolean;
  releaseSessionTab: (sessionId: string, tabId: string) => boolean;
  releaseSessionTabPool: (sessionId: string) => boolean;
};

// A live host without Electron: the release path is pure bookkeeping over `tabs`
// and `sessionTabPools`, and the production surface is entered through its own
// prototype (the same seam test/integration/mcp-multi-tab-e2e.test.ts uses).
function makeHost(pools: Array<[string, string[]]>, liveIds: string[]): HostInternals {
  const host = Object.create(NativeTabHost.prototype) as unknown as HostInternals;
  host.tabs = new Map(liveIds.map((id) => [id, { id, state: { url: `https://${id}.test` } }]));
  host.sessionTabPools = new Map(pools.map(([key, ids]) => [key, new Set(ids)]));
  host.terminalAgentAffinity = undefined;
  (host as { broadcastState?: () => void }).broadcastState = () => {};
  return host;
}

const TAB_A = 'tab-a';
const TAB_B = 'tab-b';
const CHILDREN = ['tab-c1', 'tab-c2', 'tab-c3'];

describe('session tab slot release', () => {
  it('frees the slot of a tab seated in a terminal-keyed pool', () => {
    const host = makeHost([['terminal-1', [TAB_A, TAB_B, ...CHILDREN]]], [TAB_A, TAB_B, ...CHILDREN]);
    assert.strictEqual(host.getManagedTabIds(TAB_B).size, 5, 'the terminal cluster is the quota base');

    assert.strictEqual(
      host.releaseSessionTab(TAB_A, TAB_A),
      true,
      'the release reports the slot it freed instead of a silent no-op'
    );

    const after = host.getManagedTabIds(TAB_B);
    assert.strictEqual(after.has(TAB_A), false, 'the released tab is no longer counted');
    assert.strictEqual(after.size, 4, 'exactly one slot was freed');
  });

  it('frees the slot of a tab seated in a pool keyed by the tab itself', () => {
    const host = makeHost([[TAB_A, [TAB_A, ...CHILDREN]]], [TAB_A, ...CHILDREN]);
    assert.strictEqual(host.getManagedTabIds(TAB_A).size, 4);

    assert.strictEqual(host.releaseSessionTab(TAB_A, TAB_A), true);
    assert.deepStrictEqual([...host.getManagedTabIds(TAB_A)], [...CHILDREN], 'the ad-hoc pool keeps its children only');
  });

  it('drops a pool once its last slot is released', () => {
    const host = makeHost([['terminal-1', [TAB_A]]], [TAB_A]);

    assert.strictEqual(host.releaseSessionTab(TAB_A, TAB_A), true);
    assert.strictEqual(host.sessionTabPools.has('terminal-1'), false, 'an emptied pool is not left behind');
  });

  it('reports false and leaves every pool untouched when no pool holds the tab', () => {
    const host = makeHost([['terminal-1', [TAB_B, ...CHILDREN]]], [TAB_B, ...CHILDREN]);
    const before = [...host.sessionTabPools].map(([key, pool]) => [key, [...pool]]);

    assert.strictEqual(host.releaseSessionTab(TAB_A, TAB_A), false, 'nothing held, nothing released');
    assert.deepStrictEqual(
      [...host.sessionTabPools].map(([key, pool]) => [key, [...pool]]),
      before,
      'a release that matches no pool is not allowed to disturb one'
    );
  });

  // Session end goes through the pool release instead of the per-slot one, and it
  // names the bound tab the same way (agent-owned tabs are closed by the dispose
  // listener; a user-visible bound tab stays open, so the slot it occupied is the
  // case that has to be freed by value).
  it('frees a slot named by the tab when the adopting terminal keys the pool', () => {
    const host = makeHost([['terminal-1', [TAB_A, TAB_B, ...CHILDREN]]], [TAB_A, TAB_B, ...CHILDREN]);

    assert.strictEqual(
      host.releaseSessionTabPool(TAB_A),
      true,
      'the session-end release reports the slot it freed instead of a silent no-op'
    );

    const after = host.getManagedTabIds(TAB_B);
    assert.strictEqual(after.has(TAB_A), false, 'the released tab is no longer counted against the terminal');
    assert.strictEqual(after.size, 4, 'exactly one slot was freed');
  });

  it('frees the named tab without evicting a pool its siblings share', () => {
    const host = makeHost([[TAB_A, [TAB_A, ...CHILDREN]]], [TAB_A, ...CHILDREN]);

    assert.strictEqual(host.releaseSessionTabPool(TAB_A), true, 'the pool key doubles as a tab id for an ad-hoc pool');
    assert.deepStrictEqual(
      [...host.getManagedTabIds(TAB_A)],
      [...CHILDREN],
      'the pool keeps the members that were not released'
    );
  });

  it('reports false on a session-end release that owns nothing', () => {
    const host = makeHost([['terminal-1', [TAB_B, ...CHILDREN]]], [TAB_B, ...CHILDREN]);
    const before = [...host.sessionTabPools].map(([key, pool]) => [key, [...pool]]);

    assert.strictEqual(host.releaseSessionTabPool(TAB_A), false);
    assert.deepStrictEqual(
      [...host.sessionTabPools].map(([key, pool]) => [key, [...pool]]),
      before,
      'an identifier that names no pool and no member frees nothing'
    );
  });

  // A tab belongs to one session at a time, and the user can seat an existing tab
  // into a second terminal. Every count a gate reads comes from the pool the tab
  // resolves through, so a copy left behind in the first terminal's pool makes the
  // two readers disagree — and the release for the new owner then subtracts a slot
  // from the old one.
  it('transfers a tab out of the session it is seated away from', () => {
    const host = makeHost(
      [['terminal-1', [TAB_A, TAB_B]], ['terminal-2', [...CHILDREN]]],
      [TAB_A, TAB_B, ...CHILDREN]
    );

    assert.strictEqual(host.adoptChildTabForSession('terminal-2', TAB_B), true, 'the second session seats the tab');

    const previousOwner = host.getManagedTabIds('terminal-1');
    assert.strictEqual(previousOwner.has(TAB_B), false, 'the tab is no longer counted against the session it left');
    assert.deepStrictEqual([...previousOwner], [TAB_A], 'the rest of that session is untouched');
    assert.strictEqual(host.getManagedTabIds('terminal-2').has(TAB_B), true, 'the receiving session counts it');
  });

  // The cap `adoptChildTab` enforces reads the affinity entry's managed set, while
  // the `openTab` gate reads the pool. Releasing a tab from only one of them leaves
  // the other counting a slot the session already gave up: the next adoption is
  // refused on a full session, against tabs the session no longer holds.
  it('frees the slot the adopt-path cap counts, not only the pool slot', () => {
    const managed = [TAB_A, TAB_B, ...CHILDREN, 'tab-d', 'tab-e', 'tab-f', 'tab-g', 'tab-h'];
    const host = makeHost([['terminal-1', managed]], [...managed, 'tab-new']);
    host.terminalAgentAffinity = new Map([
      ['terminal-1@1', { tabId: TAB_A, primaryTabId: TAB_A, managedTabIds: new Set(managed) }],
    ]);

    assert.strictEqual(
      host.adoptChildTab('terminal-1', 'tab-new', 1),
      false,
      'a session at its cap refuses a new tab while the slot is still counted'
    );

    assert.strictEqual(host.releaseSessionTab(TAB_A, TAB_A), true, 'the release reports the slot it freed');

    assert.strictEqual(
      host.adoptChildTab('terminal-1', 'tab-new', 1),
      true,
      'the freed slot is adoptable again instead of counting against the cap'
    );
    assert.strictEqual(host.getManagedTabIds('terminal-1').has(TAB_A), false, 'and it stays released in the pool');
  });
});
