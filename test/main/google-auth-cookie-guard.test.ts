import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert';
import type { CookieSetDetails } from '../../src/main/browser/capsule-partition-migration';
import {
  armGoogleAuthCookieGuard,
  isGoogleAnalyticsCookieName,
  isGoogleSessionCookieName,
  type GoogleAuthCookieGuardRecord,
  type GoogleAuthCookieGuardTarget,
} from '../../src/main/browser/google-auth-cookie-guard';

const FUTURE = 4_000_000_000;

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: string;
}

function cookie(overrides: Partial<FakeCookie> = {}): FakeCookie {
  return {
    name: 'SID',
    value: 'session-secret',
    domain: '.google.com',
    path: '/',
    secure: false,
    httpOnly: true,
    expirationDate: FUTURE,
    sameSite: 'lax',
    ...overrides,
  };
}

class FakeCookieStore implements GoogleAuthCookieGuardTarget {
  public sets: CookieSetDetails[] = [];
  public removed: { url: string; name: string }[] = [];
  public stored: FakeCookie[] = [];
  public failNextSet = false;
  private listener: ((...args: unknown[]) => void) | null = null;

  public cookies = {
    on: (_event: 'changed', listener: (...args: unknown[]) => void) => {
      this.listener = listener;
    },
    set: (details: CookieSetDetails): Promise<void> => {
      if (this.failNextSet) {
        this.failNextSet = false;
        return Promise.reject(new Error('set failed'));
      }
      this.sets.push(details);
      return Promise.resolve();
    },
    get: (filter: { domain?: string }): Promise<unknown[]> =>
      Promise.resolve(this.stored.filter((c) => c.domain.endsWith(filter.domain ?? ''))),
    remove: (url: string, name: string): Promise<void> => {
      this.removed.push({ url, name });
      return Promise.resolve();
    },
  };

  public change(c: FakeCookie, cause: string, removed: boolean): void {
    this.listener?.({}, c, cause, removed);
  }
}

function arm(store: FakeCookieStore, options: Record<string, unknown> = {}): GoogleAuthCookieGuardRecord[] {
  const records: GoogleAuthCookieGuardRecord[] = [];
  armGoogleAuthCookieGuard(store, 'persist:profile-x', (r) => records.push(r), options);
  return records;
}

function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe('cookie-name classifiers', () => {
  it('classifies session cookies', () => {
    for (const n of ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LSID', 'SIDCC', 'SIDTS', 'LOGIN_INFO',
      '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
      '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
      '__Host-GAPS', '__Host-1PLSID', '__Host-3PLSID', 'ACCOUNT_CHOOSER']) {
      assert.equal(isGoogleSessionCookieName(n), true, n);
    }
    for (const n of ['_ga', '_gcl_au', '__utmz', 'NID', 'OTZ', 'FOO', 'AEC']) {
      assert.equal(isGoogleSessionCookieName(n), false, n);
    }
  });

  it('classifies analytics cookies without catching session names', () => {
    for (const n of ['_ga', '_ga_B7W0ZKZYDK', '_gcl_au', '_gcl_aw', '_gac_UA-1-1', '__utmz', '__utma', 'NID', 'OTZ', 'AEC', 'SOCS', 'CONSENT', '_gid', 'AMP_TOKEN']) {
      assert.equal(isGoogleAnalyticsCookieName(n), true, n);
    }
    for (const n of ['SID', 'SIDCC', '__Secure-1PSID', 'SEARCH_SAMESITE', 'storefront_digest', 'sessionid']) {
      assert.equal(isGoogleAnalyticsCookieName(n), false, n);
    }
  });
});

describe('armGoogleAuthCookieGuard session restore', () => {
  it('restores an evicted session cookie with its reported value', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);
    store.change(cookie({ name: 'SIDCC' }), 'evicted', true);
    await settle();
    assert.equal(store.sets.length, 1);
    assert.equal(store.sets[0]!.name, 'SIDCC');
    assert.equal(store.sets[0]!.value, 'session-secret');
    assert.equal(store.sets[0]!.domain, '.google.com');
    assert.equal(records.some((r) => r.action === 'session-restored' && r.name === 'SIDCC'), true);
  });

  it('does not restore on Google-decided causes', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);
    for (const cause of ['overwrite', 'expired', 'explicit', 'expired-overwrite']) {
      store.change(cookie({ name: 'SID' }), cause, true);
    }
    await settle();
    assert.equal(store.sets.length, 0);
    assert.equal(records.length, 0);
  });

  it('does not restore an already-expired cookie', async () => {
    const store = new FakeCookieStore();
    const records = arm(store, { now: () => 2_000_000_000_000 });
    store.change(cookie({ name: 'SID', expirationDate: 1_000_000 }), 'evicted', true);
    await settle();
    assert.equal(store.sets.length, 0);
    assert.equal(records.some((r) => r.action === 'session-restore-skipped' && r.reason === 'expired'), true);
  });

  it('ignores non-Google domains and non-session names', async () => {
    const store = new FakeCookieStore();
    arm(store);
    store.change(cookie({ name: 'SID', domain: '.myharavan.com' }), 'evicted', true);
    store.change(cookie({ name: 'storefront_digest', domain: '.google.com' }), 'evicted', true);
    await settle();
    assert.equal(store.sets.length, 0);
  });

  it('rate-limits restores of the same cookie', async () => {
    let at = 1_000_000;
    const store = new FakeCookieStore();
    arm(store, { now: () => at, cooldownMs: 3000 });
    store.change(cookie({ name: 'SID' }), 'evicted', true);
    store.change(cookie({ name: 'SID' }), 'evicted', true);
    await settle();
    assert.equal(store.sets.length, 1);
    at += 4000;
    store.change(cookie({ name: 'SID' }), 'evicted', true);
    await settle();
    assert.equal(store.sets.length, 2);
  });

  it('reports set failures', async () => {
    const store = new FakeCookieStore();
    const records = arm(store);
    store.failNextSet = true;
    store.change(cookie({ name: 'SID' }), 'evicted', true);
    await settle();
    assert.equal(records.some((r) => r.action === 'session-restore-failed'), true);
  });
});

describe('armGoogleAuthCookieGuard analytics pruning', () => {
  it('prunes analytics cookies after a debounce on Google-domain writes', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    try {
      const store = new FakeCookieStore();
      store.stored = [
        cookie({ name: '_ga', value: 'a' }),
        cookie({ name: '_gcl_au', value: 'b', domain: '.google.com', secure: true }),
        cookie({ name: 'SID', value: 'keep' }),
        cookie({ name: '_ga', value: 'c', domain: '.youtube.com' }),
      ];
      const records = arm(store, { pruneDebounceMs: 1 });
      store.change(cookie({ name: '_ga_XYZ', value: 'x' }), 'inserted', false);
      mock.timers.tick(5);
      await settle();
      const names = store.removed.map((r) => `${r.url}::${r.name}`).sort();
      assert.deepEqual(names, [
        'http://google.com/::_ga',
        'http://youtube.com/::_ga',
        'https://google.com/::_gcl_au',
      ]);
      assert.equal(records.some((r) => r.action === 'analytics-pruned' && r.count === 3), true);
      assert.equal(store.removed.some((r) => r.name === 'SID'), false);
    } finally {
      mock.timers.reset();
    }
  });

  it('honours the prune period between sweeps', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    try {
      const store = new FakeCookieStore();
      store.stored = [cookie({ name: '_ga' })];
      arm(store, { pruneDebounceMs: 1, prunePeriodMs: 60_000 });
      store.change(cookie({ name: '_ga', value: 'x' }), 'inserted', false);
      mock.timers.tick(5);
      await settle();
      assert.equal(store.removed.length, 1);
      store.change(cookie({ name: '_ga2', value: 'y' }), 'inserted', false);
      mock.timers.tick(5);
      await settle();
      assert.equal(store.removed.length, 1, 'second sweep inside the period must not run');
      mock.timers.tick(61_000);
      store.change(cookie({ name: '_ga3', value: 'z' }), 'inserted', false);
      mock.timers.tick(5);
      await settle();
      assert.equal(store.removed.length, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it('arms exactly once per store', () => {
    const store = new FakeCookieStore();
    assert.equal(armGoogleAuthCookieGuard(store, 'p', () => {}), true);
    assert.equal(armGoogleAuthCookieGuard(store, 'p', () => {}), false);
  });
});
