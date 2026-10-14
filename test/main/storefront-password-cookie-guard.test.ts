import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import type { CookieSetDetails } from '../../src/main/browser/capsule-partition-migration';
import {
  STOREFRONT_PASSWORD_COOKIE,
  STOREFRONT_RESTORE_COOLDOWN_MS,
  armStorefrontPasswordCookieGuard,
  type StorefrontCookieGuardRecord,
  type StorefrontCookieGuardTarget,
} from '../../src/main/browser/storefront-password-cookie-guard';

const DIGEST = 'd'.repeat(96);
const FUTURE = 2_000_000_000;

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite: string;
}

function digestCookie(overrides: Partial<FakeCookie> = {}): FakeCookie {
  return {
    name: STOREFRONT_PASSWORD_COOKIE,
    value: DIGEST,
    domain: 'm-n-bakery.myharavan.com',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    session: false,
    expirationDate: FUTURE,
    sameSite: 'unspecified',
    ...overrides,
  };
}

class FakeCookieStore implements StorefrontCookieGuardTarget {
  public sets: CookieSetDetails[] = [];
  public failNextSet = false;
  private listener: ((...args: unknown[]) => void) | null = null;

  public cookies = {
    on: (event: 'changed', listener: (...args: unknown[]) => void): unknown => {
      if (event === 'changed') this.listener = listener;
      return this;
    },
    set: (details: CookieSetDetails): Promise<void> => {
      this.sets.push(details);
      if (this.failNextSet) {
        this.failNextSet = false;
        return Promise.reject(new Error('Failed to set cookie'));
      }
      return Promise.resolve();
    },
  };

  public change(cookie: FakeCookie, cause: string, removed: boolean): void {
    this.listener?.({}, cookie, cause, removed);
  }
}

function arm(store: FakeCookieStore, now: () => number = () => 1_000_000): StorefrontCookieGuardRecord[] {
  const records: StorefrontCookieGuardRecord[] = [];
  assert.strictEqual(armStorefrontPasswordCookieGuard(store, 'persist:p', (r) => records.push(r), { now }), true);
  return records;
}

function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe('armStorefrontPasswordCookieGuard', () => {
  it('re-sets a non-secure storefront password cookie as Secure, keeping value, host-only scope and expiry', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);

    store.change(digestCookie(), 'explicit', false);
    await settle();

    assert.deepStrictEqual(store.sets, [
      {
        url: 'https://m-n-bakery.myharavan.com/',
        name: STOREFRONT_PASSWORD_COOKIE,
        value: DIGEST,
        domain: undefined,
        path: '/',
        secure: true,
        httpOnly: false,
        expirationDate: FUTURE,
        sameSite: 'unspecified',
      },
    ]);
    assert.deepStrictEqual(records, [{ partition: 'persist:p', action: 'upgraded', domain: 'm-n-bakery.myharavan.com', path: '/' }]);
    assert.ok(!JSON.stringify(records).includes(DIGEST), 'the digest value must never reach a record');

    store.change(digestCookie(), 'overwrite', true);
    store.change(digestCookie({ secure: true }), 'explicit', false);
    await settle();
    assert.strictEqual(store.sets.length, 1, 'its own Secure re-set must not trigger another write');
  });

  it('leaves other cookies and loopback dev hosts untouched on insert', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);

    store.change(digestCookie({ name: 'cart_token' }), 'explicit', false);
    store.change(digestCookie({ domain: '127.0.0.1' }), 'explicit', false);
    store.change(digestCookie({ domain: 'localhost' }), 'explicit', false);
    await settle();
    assert.deepStrictEqual(store.sets, []);
    assert.deepStrictEqual(records, []);
  });

  it('restores an evicted password cookie, and only an evicted one', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);

    for (const cause of ['explicit', 'expired', 'expired-overwrite', 'overwrite']) {
      store.change(digestCookie({ domain: `${cause}.myharavan.com` }), cause, true);
    }
    await settle();
    assert.deepStrictEqual(store.sets, [], 'user clears, server expiry and overwrites must stay deleted');

    store.change(digestCookie({ domain: '.shop.myharavan.com', hostOnly: false, httpOnly: true, session: true, expirationDate: undefined }), 'evicted', true);
    await settle();
    assert.deepStrictEqual(store.sets, [
      {
        url: 'https://shop.myharavan.com/',
        name: STOREFRONT_PASSWORD_COOKIE,
        value: DIGEST,
        domain: '.shop.myharavan.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'unspecified',
      },
    ]);
    assert.deepStrictEqual(records, [{ partition: 'persist:p', action: 'restored', domain: '.shop.myharavan.com', path: '/' }]);
  });

  it('restores a loopback cookie without upgrading it, and skips an already expired one', async () => {
    const store = new FakeCookieStore();
    const records = arm(store, () => (FUTURE + 1) * 1000);

    store.change(digestCookie({ domain: '127.0.0.1', expirationDate: FUTURE + 3600 }), 'evicted', true);
    store.change(digestCookie({ domain: 'old.myharavan.com' }), 'evicted', true);
    await settle();

    assert.strictEqual(store.sets.length, 1);
    assert.strictEqual(store.sets[0]?.secure, false);
    assert.strictEqual(store.sets[0]?.url, 'http://127.0.0.1/');
    assert.deepStrictEqual(records.map((r) => [r.action, r.domain, r.reason]), [
      ['restore-skipped', 'old.myharavan.com', 'expired'],
      ['restored', '127.0.0.1', undefined],
    ]);
  });

  it('restores the same cookie at most once per cooldown window', async () => {
    const store = new FakeCookieStore();
    let clock = 1_000_000;
    const records = arm(store, () => clock);

    store.change(digestCookie(), 'evicted', true);
    clock += STOREFRONT_RESTORE_COOLDOWN_MS - 1;
    store.change(digestCookie(), 'evicted', true);
    store.change(digestCookie({ domain: 'other.myharavan.com' }), 'evicted', true);
    clock += 1;
    store.change(digestCookie(), 'evicted', true);
    await settle();

    assert.deepStrictEqual(store.sets.map((s) => s.url), [
      'https://m-n-bakery.myharavan.com/',
      'https://other.myharavan.com/',
      'https://m-n-bakery.myharavan.com/',
    ]);
    assert.deepStrictEqual(
      records.filter((r) => r.action === 'restore-skipped').map((r) => [r.domain, r.reason]),
      [['m-n-bakery.myharavan.com', 'cooldown']],
    );
  });

  it('reports a rejected write instead of throwing, and arms a store once', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);
    assert.strictEqual(armStorefrontPasswordCookieGuard(store, 'persist:p', () => {}), false);

    store.failNextSet = true;
    store.change(digestCookie(), 'evicted', true);
    await settle();
    assert.deepStrictEqual(records, [
      { partition: 'persist:p', action: 'failed', domain: 'm-n-bakery.myharavan.com', path: '/', reason: 'restored: Failed to set cookie' },
    ]);
    assert.strictEqual(store.sets.length, 1, 'a second arm must not add a second listener');
  });

  it('refuses a store that cannot listen or write', () => {
    assert.strictEqual(armStorefrontPasswordCookieGuard(null, 'persist:p', () => {}), false);
    assert.strictEqual(armStorefrontPasswordCookieGuard({} as StorefrontCookieGuardTarget, 'persist:p', () => {}), false);
    assert.strictEqual(
      armStorefrontPasswordCookieGuard({ cookies: { on: () => undefined } } as unknown as StorefrontCookieGuardTarget, 'persist:p', () => {}),
      false,
    );
  });
});
