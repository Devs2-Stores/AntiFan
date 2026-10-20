/**
 * Google session cookie journal (no Electron).
 *
 * The log exists to tell a local cookie loss from a sign-out Google decided, so the claims under
 * test are: the boot record lists exactly the session cookies the jar loaded, every later change
 * of one carries its cause, unrelated cookies stay out, and no cookie value ever reaches the sink.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  GOOGLE_AUTH_COOKIE_BATCH_MS,
  armGoogleAuthCookieLog,
  type GoogleAuthCookieRecord,
  type GoogleAuthCookieTarget,
} from '../../src/main/browser/google-auth-cookie-log';

type StoredCookie = { name: string; domain: string; value: string };

class FakeJar implements GoogleAuthCookieTarget {
  private listener: ((...args: unknown[]) => void) | null = null;

  constructor(private readonly stored: StoredCookie[]) {}

  public cookies = {
    on: (_event: 'changed', listener: (...args: unknown[]) => void): unknown => {
      this.listener = listener;
      return this;
    },
    get: async (filter: { domain?: string }): Promise<StoredCookie[]> => {
      const want = filter.domain ?? '';
      return this.stored.filter((c) => c.domain.replace(/^\./, '') === want || c.domain.endsWith(`.${want}`));
    },
  };

  public change(cookie: StoredCookie, cause: string, removed: boolean): void {
    this.listener?.({}, cookie, cause, removed);
  }
}

const SECRET = 'g.a000-secret-value';

describe('armGoogleAuthCookieLog', () => {
  it('records which session cookies the jar loaded, without values', async () => {
    const jar = new FakeJar([
      { name: 'SID', domain: '.google.com', value: SECRET },
      { name: '__Secure-1PSIDTS', domain: '.google.com', value: SECRET },
      { name: 'NID', domain: '.google.com', value: SECRET },
      { name: 'LOGIN_INFO', domain: '.youtube.com', value: SECRET },
      { name: 'SID', domain: '.example.com', value: SECRET },
    ]);
    const records: GoogleAuthCookieRecord[] = [];
    assert.strictEqual(armGoogleAuthCookieLog(jar, 'persist:profile-profile-2', (r) => records.push(r)), true);
    await nextTurn();

    assert.deepStrictEqual(records, [{
      kind: 'present',
      partition: 'persist:profile-profile-2',
      cookies: ['.google.com SID', '.google.com __Secure-1PSIDTS', '.youtube.com LOGIN_INFO'],
    }]);
    assert.ok(!JSON.stringify(records).includes(SECRET), 'a cookie value reached the journal');
  });

  it('batches session cookie changes with their cause and ignores the rest', async (t) => {
    const records: GoogleAuthCookieRecord[] = [];
    const jar = new FakeJar([]);
    armGoogleAuthCookieLog(jar, 'persist:p', (r) => records.push(r));
    await nextTurn();
    records.length = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // A rotation: Google overwrites the freshness token, then a sign-out expires the session.
    jar.change({ name: '__Secure-1PSIDTS', domain: '.google.com', value: SECRET }, 'overwrite', true);
    jar.change({ name: '__Secure-1PSIDTS', domain: '.google.com', value: SECRET }, 'explicit', false);
    jar.change({ name: '_ga', domain: '.google.com', value: SECRET }, 'explicit', false);
    jar.change({ name: 'SID', domain: 'shop.myharavan.com', value: SECRET }, 'evicted', true);
    jar.change({ name: 'SID', domain: '.google.com', value: SECRET }, 'expired-overwrite', true);
    assert.deepStrictEqual(records, [], 'changes are batched, not written one by one');

    t.mock.timers.tick(GOOGLE_AUTH_COOKIE_BATCH_MS);
    assert.deepStrictEqual(records, [{
      kind: 'changed',
      partition: 'persist:p',
      changes: [
        { domain: '.google.com', name: '__Secure-1PSIDTS', cause: 'overwrite', removed: true },
        { domain: '.google.com', name: '__Secure-1PSIDTS', cause: 'explicit', removed: false },
        { domain: '.google.com', name: 'SID', cause: 'expired-overwrite', removed: true },
      ],
    }]);
    assert.ok(!JSON.stringify(records).includes(SECRET), 'a cookie value reached the journal');

    jar.change({ name: 'SID', domain: '.google.com', value: SECRET }, 'explicit', true);
    t.mock.timers.tick(GOOGLE_AUTH_COOKIE_BATCH_MS);
    assert.strictEqual(records.length, 2, 'a change after a flushed batch opens a new batch');
  });

  it('arms a jar once and refuses one it cannot read', () => {
    const jar = new FakeJar([]);
    assert.strictEqual(armGoogleAuthCookieLog(jar, 'persist:p', () => {}), true);
    assert.strictEqual(armGoogleAuthCookieLog(jar, 'persist:p', () => {}), false);
    assert.strictEqual(armGoogleAuthCookieLog(null, 'persist:p', () => {}), false);
    assert.strictEqual(
      armGoogleAuthCookieLog({ cookies: { on: () => undefined } } as unknown as GoogleAuthCookieTarget, 'persist:p', () => {}),
      false,
    );
  });
});
