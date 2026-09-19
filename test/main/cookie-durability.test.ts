/**
 * Cookie durability policy tests (no Electron).
 *
 * The claim under test is the one the user feels: a cookie set by a page must
 * reach disk shortly after the page goes quiet, instead of waiting for a
 * graceful quit that a crash or `taskkill /F` never performs. `armCookieDurability`
 * is driven through a cookie-store double, with Node's mock timers advancing
 * the debounce clock deterministically — no real waiting, and the shipped
 * window constant is the one actually exercised.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { COOKIE_FLUSH_DEBOUNCE_MS, armCookieDurability, type CookieDurabilityTarget } from '../../src/main/browser/cookie-durability';

/** Cookie store double: records every commit synchronously, and emits changes on demand. */
class FakeCookieStore implements CookieDurabilityTarget {
  public flushCount = 0;
  private listener: (() => void) | null = null;

  public cookies = {
    on: (event: 'changed', listener: (...args: any[]) => void): unknown => {
      if (event !== 'changed') return undefined;
      this.listener = listener as () => void;
      return this;
    },
    flushStore: (): Promise<void> => {
      this.flushCount += 1;
      const { promise } = Promise.withResolvers<void>();
      return promise.then(() => undefined);
    },
  };

  public emitChange(times = 1): void {
    for (let i = 0; i < times; i += 1) this.listener?.();
  }
}

describe('armCookieDurability', () => {
  it('commits once, after the debounce window, for a burst of cookie changes', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    assert.strictEqual(armCookieDurability(store), true);

    // A login redirect setting a dozen cookies: all inside one window.
    store.emitChange(12);
    assert.strictEqual(store.flushCount, 0, 'must not commit synchronously on every change');

    t.mock.timers.tick(COOKIE_FLUSH_DEBOUNCE_MS - 1);
    assert.strictEqual(store.flushCount, 0, 'must still be inside the debounce window');

    t.mock.timers.tick(2);
    assert.strictEqual(store.flushCount, 1, 'the burst must collapse into exactly one commit');
  });

  it('extends the window on a late change instead of committing twice', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    armCookieDurability(store);

    store.emitChange();
    t.mock.timers.tick(COOKIE_FLUSH_DEBOUNCE_MS - 1);
    store.emitChange(); // trailing edge resets the timer
    t.mock.timers.tick(COOKIE_FLUSH_DEBOUNCE_MS - 1);
    assert.strictEqual(store.flushCount, 0, 'the reset window has not elapsed yet');

    t.mock.timers.tick(2);
    assert.strictEqual(store.flushCount, 1, 'one commit for the whole activity, not one per change');
  });

  it('arms a store exactly once', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new FakeCookieStore();
    assert.strictEqual(armCookieDurability(store), true);
    assert.strictEqual(armCookieDurability(store), false, 'a second arm must be a no-op');

    store.emitChange();
    t.mock.timers.tick(COOKIE_FLUSH_DEBOUNCE_MS + 1);
    assert.strictEqual(store.flushCount, 1, 'a duplicate listener would commit twice');
  });

  it('refuses a store that cannot commit instead of throwing', () => {
    assert.strictEqual(armCookieDurability(null), false);
    assert.strictEqual(armCookieDurability(undefined), false);
    assert.strictEqual(armCookieDurability({} as CookieDurabilityTarget), false);
    assert.strictEqual(
      armCookieDurability({ cookies: { on: () => undefined } } as unknown as CookieDurabilityTarget),
      false,
    );
  });
});
