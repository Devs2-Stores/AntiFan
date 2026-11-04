import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  listUsableTabs,
  listUsableTabsForSession,
  USABLE_TABS_SAMPLE_MAX,
  type UsableTabsDirectory,
  type UsableTabsSource,
} from '../../src/main/tools/usable-tabs';

interface World {
  live: Record<string, string>;
  /** Pool of managed tabs by the tab that anchors the session. */
  pools: Record<string, string[]>;
  /** Tabs the host refuses to admit for the session. */
  foreign?: string[];
}

function sourceOf(world: World): UsableTabsSource {
  return {
    managedTabIds: (bound) => world.pools[bound] ?? [],
    isLive: (id) => id in world.live,
    isAllowed: (_bound, id) => !(world.foreign ?? []).includes(id),
    urlOf: (id) => world.live[id],
  };
}

describe('listUsableTabs', () => {
  it('lists the bound tab first, then live admitted managed tabs, and drops dead and foreign ones', () => {
    const world: World = {
      live: { b: 'https://shop.test/', m1: 'https://shop.test/cart', f: 'https://other.test/' },
      pools: { b: ['m1', 'dead', 'f', 'b'] },
      foreign: ['f'],
    };
    assert.deepStrictEqual(listUsableTabs('b', sourceOf(world)), [
      { id: 'b', url: 'https://shop.test/' },
      { id: 'm1', url: 'https://shop.test/cart' },
    ]);
  });

  it('leaves a dead bound tab out, so a refusal never offers the tab that is gone', () => {
    const world: World = { live: { m1: 'https://shop.test/cart' }, pools: { b: ['m1'] } };
    assert.deepStrictEqual(listUsableTabs('b', sourceOf(world)), [{ id: 'm1', url: 'https://shop.test/cart' }]);
  });

  it('is bounded, and a reader that throws counts as "no" instead of failing the refusal', () => {
    const many: World = {
      live: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}`, ''])),
      pools: { t0: Array.from({ length: 20 }, (_, i) => `t${i}`) },
    };
    assert.strictEqual(listUsableTabs('t0', sourceOf(many)).length, USABLE_TABS_SAMPLE_MAX);
    const broken: UsableTabsSource = {
      managedTabIds: () => { throw new Error('pool gone'); },
      isLive: () => true,
      isAllowed: () => { throw new Error('host gone'); },
      urlOf: () => { throw new Error('no url'); },
    };
    assert.deepStrictEqual(listUsableTabs('b', broken), [{ id: 'b' }]);
  });
});

describe('listUsableTabsForSession', () => {
  function directory(world: World, failovers: Record<string, string> = {}): UsableTabsDirectory {
    return {
      sourceForTab: (id) => (id in world.live ? sourceOf(world) : undefined),
      failoverOf: (stale) => failovers[stale],
    };
  }

  it('asks the bound tab when it is alive', () => {
    const world: World = { live: { b: 'https://shop.test/' }, pools: {} };
    assert.deepStrictEqual(listUsableTabsForSession('b', directory(world)), [{ id: 'b', url: 'https://shop.test/' }]);
  });

  it('finds the live tabs of a session whose bound tab is gone through the failover survivor', () => {
    const world: World = {
      live: { m1: 'https://shop.test/cart', m2: 'https://shop.test/pdp' },
      pools: { m1: ['m2'] },
    };
    assert.deepStrictEqual(listUsableTabsForSession('b-dead', directory(world, { 'b-dead': 'm1' })), [
      { id: 'm1', url: 'https://shop.test/cart' },
      { id: 'm2', url: 'https://shop.test/pdp' },
    ]);
  });

  it('answers nothing, not an empty list, when the binding is dead and no survivor is known', () => {
    const world: World = { live: { other: 'https://elsewhere.test/' }, pools: {} };
    assert.strictEqual(listUsableTabsForSession('b-dead', directory(world)), undefined);
    assert.strictEqual(listUsableTabsForSession('b-dead', directory(world, { 'b-dead': 'also-dead' })), undefined);
  });
});
