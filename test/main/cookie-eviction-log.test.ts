import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  COOKIE_EVICTION_BATCH_MS,
  COOKIE_EVICTION_MAX_NAMES,
  armCookieEvictionLog,
  type CookieEvictionBatch,
  type CookieEvictionTarget,
} from '../../src/main/browser/cookie-eviction-log';

/** Emits `changed` with Electron's argument order: (event, cookie, cause, removed). */
class FakeCookieStore implements CookieEvictionTarget {
  private listener: ((...args: unknown[]) => void) | null = null;

  public cookies = {
    on: (event: 'changed', listener: (...args: unknown[]) => void): unknown => {
      if (event === 'changed') this.listener = listener;
      return this;
    },
  };

  public change(name: string, domain: string, cause: string, removed: boolean, value = 'secret-digest-value'): void {
    this.listener?.({}, { name, domain, value }, cause, removed);
  }
}

describe('armCookieEvictionLog', () => {
  it('collapses one purge burst into a single record grouped by domain', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    const records: CookieEvictionBatch[] = [];
    assert.strictEqual(armCookieEvictionLog(store, 'persist:profile-profile-2', (b) => records.push(b)), true);

    store.change('storefront_digest', 'm-n-bakery.myharavan.com', 'evicted', true);
    store.change('_ab', 'm-n-bakery.myharavan.com', 'evicted', true);
    store.change('_ga', '.myharavan.com', 'evicted', true);
    assert.strictEqual(records.length, 0, 'must wait for the burst to finish');

    t.mock.timers.tick(COOKIE_EVICTION_BATCH_MS);
    assert.deepStrictEqual(records, [
      {
        partition: 'persist:profile-profile-2',
        count: 3,
        byDomain: {
          'm-n-bakery.myharavan.com': ['storefront_digest', '_ab'],
          '.myharavan.com': ['_ga'],
        },
        unlisted: 0,
      },
    ]);
    assert.ok(!JSON.stringify(records).includes('secret-digest-value'), 'cookie values must never reach the journal');

    store.change('cart_token', 'rog-bike.myharavan.com', 'evicted', true);
    t.mock.timers.tick(COOKIE_EVICTION_BATCH_MS);
    assert.strictEqual(records.length, 2, 'a later purge is its own record');
    assert.deepStrictEqual(records[1]?.byDomain, { 'rog-bike.myharavan.com': ['cart_token'] });
  });

  it('ignores every removal that is not an eviction, and insertions', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    const records: CookieEvictionBatch[] = [];
    armCookieEvictionLog(store, 'persist:p', (b) => records.push(b));

    store.change('storefront_digest', 'shop.myharavan.com', 'explicit', true);
    store.change('storefront_digest', 'shop.myharavan.com', 'expired', true);
    store.change('storefront_digest', 'shop.myharavan.com', 'expired-overwrite', true);
    store.change('storefront_digest', 'shop.myharavan.com', 'overwrite', true);
    store.change('storefront_digest', 'shop.myharavan.com', 'evicted', false);
    t.mock.timers.tick(COOKIE_EVICTION_BATCH_MS * 4);
    assert.deepStrictEqual(records, []);
  });

  it('bounds a jar-wide purge: lists the first names, counts the rest', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    const records: CookieEvictionBatch[] = [];
    armCookieEvictionLog(store, 'persist:p', (b) => records.push(b));

    const purged = COOKIE_EVICTION_MAX_NAMES + 100;
    for (let i = 0; i < purged; i += 1) store.change(`c${i}`, 'example.com', 'evicted', true);
    t.mock.timers.tick(COOKIE_EVICTION_BATCH_MS);

    assert.strictEqual(records.length, 1);
    const [record] = records;
    assert.strictEqual(record?.count, purged);
    assert.strictEqual(record?.unlisted, 100);
    assert.strictEqual(record?.byDomain['example.com']?.length, COOKIE_EVICTION_MAX_NAMES);
  });

  it('arms a store exactly once and survives a throwing sink', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    let calls = 0;
    assert.strictEqual(armCookieEvictionLog(store, 'persist:p', () => { calls += 1; throw new Error('disk full'); }), true);
    assert.strictEqual(armCookieEvictionLog(store, 'persist:p', () => { calls += 1; }), false);

    store.change('a', 'example.com', 'evicted', true);
    t.mock.timers.tick(COOKIE_EVICTION_BATCH_MS);
    store.change('b', 'example.com', 'evicted', true);
    t.mock.timers.tick(COOKIE_EVICTION_BATCH_MS);
    assert.strictEqual(calls, 2, 'one listener, and a failed write must not stop later records');
  });

  it('refuses a store that cannot emit changes instead of throwing', () => {
    assert.strictEqual(armCookieEvictionLog(null, 'persist:p', () => {}), false);
    assert.strictEqual(armCookieEvictionLog(undefined, 'persist:p', () => {}), false);
    assert.strictEqual(armCookieEvictionLog({} as CookieEvictionTarget, 'persist:p', () => {}), false);
  });
});
