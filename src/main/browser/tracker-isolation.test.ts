import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import {
  buildTrackerStubProbeScript,
  buildTrackerStubScript,
  buildTrackerStubTeardownScript,
  isTrackerIsolationConsoleNoise,
  TRACKER_BLOCK_PATTERNS,
  TRACKER_STUB_GLOBALS,
  TRACKER_STUB_MARKER,
} from './tracker-isolation.js';

interface Sandbox {
  window: Record<string, unknown>;
}

/** Runs the installer in a real JS realm and hands back the sandbox window. */
function installStubs(seed?: Record<string, unknown>): { sandbox: Sandbox; installed: string[] } {
  const context = vm.createContext({ window: { ...(seed || {}) } }) as vm.Context & Sandbox;
  const result = vm.runInContext(buildTrackerStubScript(), context) as { installed: string[] };
  return { sandbox: context, installed: result.installed };
}

describe('Tracker isolation stubs', () => {
  it('installs a stub for every declared global and records them for teardown', () => {
    const { sandbox, installed } = installStubs();
    const declared = [...TRACKER_STUB_GLOBALS.callable, ...TRACKER_STUB_GLOBALS.array];

    assert.deepEqual([...installed].sort(), [...declared].sort());
    for (const name of declared) {
      assert.ok(name in sandbox.window, `stub global ${name} must exist on window`);
    }
    const registry = sandbox.window[TRACKER_STUB_MARKER] as { globals: string[] };
    assert.deepEqual([...registry.globals].sort(), [...declared].sort());
  });

  it('swallows vendor calls and never looks thenable, so an awaited stub cannot hang', async () => {
    const { sandbox } = installStubs();
    const fbq = sandbox.window.fbq as (...args: unknown[]) => unknown;

    assert.equal(typeof fbq, 'function');
    assert.doesNotThrow(() => fbq('track', 'AddToCart'));
    assert.doesNotThrow(() => fbq('init', '1234', { currency: 'VND' }));

    // `then` is the whole point: vendor snippets and theme code both do
    // `await fbq(...)`, and a thenable that never resolves would hang the
    // storefront script this stub exists to keep running.
    const call = fbq('track', 'Purchase');
    assert.equal((call as { then?: unknown }).then, undefined);
    assert.equal(await Promise.resolve(call), call);
  });

  it('answers nested property reads with a callable stub so object-shaped APIs survive', () => {
    const { sandbox } = installStubs();
    const tawk = sandbox.window.Tawk_API as Record<string, unknown>;

    assert.doesNotThrow(() => {
      (tawk.onLoad as () => void)();
      (tawk.setAttributes as (value: unknown) => void)({ name: 'x' });
    });
    tawk.onLoad = 'page-owned';
    assert.equal(tawk.onLoad, 'page-owned');
  });

  it('exposes array-shaped globals as real arrays that push, length and iterate', () => {
    const { sandbox } = installStubs();
    const dataLayer = sandbox.window.dataLayer as unknown[];

    assert.ok(Array.isArray(dataLayer));
    (dataLayer.push as (value: unknown) => void)({ event: 'page_view' });
    assert.equal(dataLayer.length, 1);
    assert.deepEqual([...dataLayer], [{ event: 'page_view' }]);
  });

  it('never clobbers a vendor global that already loaded', () => {
    const real = () => 'real-vendor';
    const { sandbox, installed } = installStubs({ fbq: real });

    assert.equal(sandbox.window.fbq, real);
    assert.ok(!installed.includes('fbq'));
    assert.ok(installed.includes('gtag'));
  });

  it('is idempotent across repeated installs and removes exactly what it installed', () => {
    const context = vm.createContext({ window: {} }) as vm.Context & Sandbox;
    const first = vm.runInContext(buildTrackerStubScript(), context) as { installed: string[] };
    const fbqAfterFirst = context.window.fbq;
    const second = vm.runInContext(buildTrackerStubScript(), context) as { installed: string[] };

    assert.deepEqual(second.installed, first.installed);
    assert.equal(context.window.fbq, fbqAfterFirst);

    const probe = vm.runInContext(buildTrackerStubProbeScript(), context) as { installed: string[] };
    assert.equal(probe.installed.length, first.installed.length);

    const teardown = vm.runInContext(buildTrackerStubTeardownScript(), context) as { removed: string[] };
    assert.deepEqual([...teardown.removed].sort(), [...first.installed].sort());
    for (const name of first.installed) {
      assert.ok(!(name in context.window), `${name} must be removed by teardown`);
    }
    assert.ok(!(TRACKER_STUB_MARKER in context.window));
  });

  it('removes the globals it installed even when the page overwrote one', () => {
    const context = vm.createContext({ window: {} }) as vm.Context & Sandbox;
    vm.runInContext(buildTrackerStubScript(), context);
    (context.window as Record<string, unknown>).hj = () => 'page-owned';

    const teardown = vm.runInContext(buildTrackerStubTeardownScript(), context) as { removed: string[] };

    assert.ok(teardown.removed.includes('hj'));
    assert.ok(!('hj' in context.window));
  });
});

describe('Tracker block patterns', () => {
  const toRegExp = (pattern: string): RegExp =>
    new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

  const blocked = (url: string): boolean => TRACKER_BLOCK_PATTERNS.some((pattern) => toRegExp(pattern).test(url));

  it('blocks the measurement origins a storefront theme actually loads', () => {
    assert.ok(blocked('https://www.googletagmanager.com/gtm.js?id=GTM-ABC'));
    assert.ok(blocked('https://connect.facebook.net/en_US/fbevents.js'));
    assert.ok(blocked('https://www.facebook.com/tr/?id=123&ev=PageView'));
    assert.ok(blocked('https://analytics.tiktok.com/i18n/pixel/events.js'));
    assert.ok(blocked('https://embed.tawk.to/abc/default'));
  });

  it('never blocks first-party CDNs, identity providers or bot protection', () => {
    const mustStayReachable = [
      'https://theme.hstatic.net/200000000000/1000000000/14/theme.js',
      'https://cdn.shopify.com/s/files/1/0000/0000/files/theme.css',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://store.example.com/cart.js',
    ];
    for (const url of mustStayReachable) {
      assert.ok(!blocked(url), `${url} must not be blocked by tracker isolation`);
    }
  });
});

describe('Tracker isolation console noise', () => {
  const blockedMessage = 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT';
  const documentSource = 'https://store.example.com/products/ao-thun';

  it('never hides a console entry while no isolation window is open', () => {
    // The same message outside the window is a real blocked resource (an
    // extension, a user blocklist) and must stay visible.
    assert.equal(isTrackerIsolationConsoleNoise(blockedMessage, documentSource, false), false);
  });

  it('hides the blocked-resource entry the window itself produces', () => {
    // Chromium names the document as the source of this entry, so the URL match
    // cannot identify it; only the window being open can.
    assert.equal(isTrackerIsolationConsoleNoise(blockedMessage, documentSource, true), true);
  });

  it('hides an entry whose source is a blocked tracker URL', () => {
    assert.equal(
      isTrackerIsolationConsoleNoise('anything', 'https://connect.facebook.net/en_US/fbevents.js', true),
      true
    );
  });

  it('keeps genuine page errors visible during the window', () => {
    const realErrors = [
      'TypeError: Cannot read properties of undefined (reading \'total_price\')',
      'Failed to load resource: the server responded with a status of 500',
      'Liquid error: Unknown tag legacy_tag',
    ];
    for (const message of realErrors) {
      assert.equal(
        isTrackerIsolationConsoleNoise(message, documentSource, true),
        false,
        `isolation must not swallow: ${message}`
      );
    }
  });
});
