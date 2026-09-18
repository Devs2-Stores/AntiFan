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
  releaseSessionTab: (sessionId: string, tabId: string) => boolean;
};

// A live host without Electron: the release path is pure bookkeeping over `tabs`
// and `sessionTabPools`, and the production surface is entered through its own
// prototype (the same seam test/integration/mcp-multi-tab-e2e.test.ts uses).
function makeHost(pools: Array<[string, string[]]>, liveIds: string[]): HostInternals {
  const host = Object.create(NativeTabHost.prototype) as unknown as HostInternals;
  host.tabs = new Map(liveIds.map((id) => [id, { id, state: { url: `https://${id}.test` } }]));
  host.sessionTabPools = new Map(pools.map(([key, ids]) => [key, new Set(ids)]));
  host.terminalAgentAffinity = undefined;
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
});
