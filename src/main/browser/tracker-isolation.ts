/**
 * AntiFan Browser Desktop — Tracker Isolation Primitives
 *
 * Storefront QA waits for network quiescence, and third-party measurement
 * scripts are what keep that wait from ever finishing: GTM re-tries its collect
 * beacon, the Meta pixel fires `tr` on scroll and interaction, Tawk.to holds a
 * long poll open. Blocking those requests alone is not enough either — the
 * storefront calls `fbq('track', 'AddToCart')` and `gtag('event', …)` directly,
 * so removing the script without replacing the global turns a working page into
 * a `ReferenceError` mid-QA.
 *
 * This module holds the pure half of the fix: the blocklist and the in-page
 * stub builders. `TabDevToolsHost` owns the CDP lifecycle that applies them to
 * a target and removes them again.
 *
 * Scope is the whole point: this list must only ever contain third-party
 * measurement endpoints. Blocking a first-party CDN, an OAuth provider or a
 * bot-protection endpoint would break the page under test and the user's
 * subsequent browsing far beyond the QA window.
 */

/** Global name installed by the stubs; also the teardown registry key. */
export const TRACKER_STUB_MARKER = '__antifanTrackerStub__';

/**
 * Third-party measurement endpoints. Kept to analytics/pixel hosts — never a
 * first-party CDN (hstatic/cdn.shopify), never an identity or bot-protection
 * origin (Google OAuth, Cloudflare Turnstile).
 */
export const TRACKER_BLOCK_PATTERNS: readonly string[] = [
  '*://www.googletagmanager.com/*',
  '*://googletagmanager.com/*',
  '*://www.google-analytics.com/*',
  '*://analytics.google.com/*',
  '*://connect.facebook.net/*',
  '*://www.facebook.com/tr/*',
  '*://analytics.tiktok.com/*',
  '*://analytics.pinterest.com/*',
  '*://ct.pinterest.com/*',
  '*://static.ads-twitter.com/*',
  '*://bat.bing.com/*',
  '*://static.hotjar.com/*',
  '*://script.hotjar.com/*',
  '*://in.hotjar.com/*',
  '*://www.clarity.ms/*',
  '*://static.klaviyo.com/*',
  '*://embed.tawk.to/*',
  '*://va.tawk.to/*',
  '*://cdn.heapanalytics.com/*',
  '*://cdn.mxpnl.com/*',
  '*://cdn.segment.com/*',
  '*://mc.yandex.ru/*',
];

/**
 * Globals a storefront theme calls directly. `callable` covers both functions
 * and the object-shaped vendor APIs (Tawk_API, klaviyo) because the stub is a
 * Proxy that answers every property with a nested stub.
 */
export const TRACKER_STUB_GLOBALS: Readonly<{ callable: readonly string[]; array: readonly string[] }> = {
  callable: [
    'fbq',
    '_fbq',
    'gtag',
    'ga',
    'ttq',
    'hj',
    'clarity',
    'snaptr',
    'pintrk',
    'twq',
    'lintrk',
    'uetq',
    'ym',
    'gtag_report_conversion',
    '_learnq',
    'klaviyo',
    'Tawk_API',
    'Tawk_LoadStart',
  ],
  // `dataLayer` and `_paq` are real arrays in the vendor APIs, and page code
  // reads `.length` and iterates them — a Proxy stub would satisfy neither.
  array: ['dataLayer', '_paq'],
};

/**
 * In-page installer. Runs in the MAIN world (page code reads `window.fbq`), so
 * it must tolerate being executed twice and must never clobber a real global
 * that already loaded: only absent names are installed, and every installed
 * name is recorded so teardown can tell our stub from the vendor's code.
 */
export function buildTrackerStubScript(): string {
  const callable = JSON.stringify([...TRACKER_STUB_GLOBALS.callable]);
  const array = JSON.stringify([...TRACKER_STUB_GLOBALS.array]);

  return `(() => {
    try {
      const MARKER = ${JSON.stringify(TRACKER_STUB_MARKER)};
      const registry = window[MARKER] && typeof window[MARKER] === 'object' && Array.isArray(window[MARKER].globals)
        ? window[MARKER]
        : { globals: [] };
      window[MARKER] = registry;

      const makeCallableStub = (label) => {
        const target = function () { return proxy; };
        const proxy = new Proxy(target, {
          get(t, prop) {
            if (typeof prop === 'symbol') return undefined;
            if (prop === MARKER) return true;
            // Never look thenable: an awaited stub must not swallow the await.
            if (prop === 'then') return undefined;
            if (prop === 'toString') return () => '[antifan tracker stub: ' + label + ']';
            if (!(prop in t)) t[prop] = makeCallableStub(label + '.' + prop);
            return t[prop];
          },
          set(t, prop, value) { t[prop] = value; return true; },
          has() { return true; },
          apply() { return proxy; },
          construct() { return {}; },
        });
        return proxy;
      };

      const install = (name, kind) => {
        if (registry.globals.indexOf(name) !== -1) return;
        const existing = window[name];
        if (existing !== undefined && existing !== null) return;
        const value = kind === 'array' ? [] : makeCallableStub(name);
        try {
          Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
        } catch {
          try { window[name] = value; } catch { return; }
        }
        registry.globals.push(name);
      };

      const callableNames = ${callable};
      for (let i = 0; i < callableNames.length; i++) install(callableNames[i], 'callable');
      const arrayNames = ${array};
      for (let j = 0; j < arrayNames.length; j++) install(arrayNames[j], 'array');

      return { installed: registry.globals.slice() };
    } catch (err) {
      return { installed: [], error: err instanceof Error ? err.message : String(err) };
    }
  })()`;
}

/**
 * Removes exactly the globals this module installed. Used when a caller wants
 * the live document cleaned; the target-level isolation teardown
 * (`TabDevToolsHost.endTrackerIsolation`) deliberately does not call this on a
 * document whose vendor script was blocked, because deleting the only `fbq`
 * there converts a benign no-op into the ReferenceError the stub prevents.
 */
export function buildTrackerStubTeardownScript(): string {
  return `(() => {
    try {
      const MARKER = ${JSON.stringify(TRACKER_STUB_MARKER)};
      const registry = window[MARKER];
      if (!registry || !Array.isArray(registry.globals)) return { removed: [] };
      const removed = [];
      for (let i = 0; i < registry.globals.length; i++) {
        const name = registry.globals[i];
        try { delete window[name]; removed.push(name); } catch {}
      }
      try { delete window[MARKER]; } catch {}
      return { removed };
    } catch (err) {
      return { removed: [], error: err instanceof Error ? err.message : String(err) };
    }
  })()`;
}

/** Reports which stub globals are currently installed in the live document. */
export function buildTrackerStubProbeScript(): string {
  return `(() => {
    try {
      const registry = window[${JSON.stringify(TRACKER_STUB_MARKER)}];
      return { installed: registry && Array.isArray(registry.globals) ? registry.globals.slice() : [] };
    } catch {
      return { installed: [] };
    }
  })()`;
}

const TRACKER_BLOCK_MATCHERS = new Map(
  TRACKER_BLOCK_PATTERNS.map((pattern) => [
    pattern,
    new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`),
  ])
);

/**
 * True when a URL is one this module blocks.
 *
 * `Network.setBlockedURLs` reports a blocked request to the renderer as
 * `net::ERR_BLOCKED_BY_CLIENT`, which the failure pipeline records as a real
 * load failure. Isolation must be able to recognise its own damage, otherwise a
 * QA run manufactured by the tool itself shows up as third-party network
 * warnings on the page under test.
 */
export function isTrackerBlockedUrl(url: string): boolean {
  if (!url) return false;
  return TRACKER_BLOCK_PATTERNS.some((pattern) => TRACKER_BLOCK_MATCHERS.get(pattern)?.test(url) === true);
}

export interface TrackerIsolationReceipt {
  /** True when blocking + stubs are now applied to the target. */
  active: boolean;
  /** Stub globals installed by this call (empty when a real global already existed). */
  stubsInstalled: string[];
  /** Blocked URL patterns applied through `Network.setBlockedURLs`. */
  blockedPatterns: string[];
  /** `Page.addScriptToEvaluateOnNewDocument` identifier, when registration succeeded. */
  preDocumentScriptIdentifier: string | null;
  /** Human-readable degradation reason when the target could not be fully isolated. */
  degradedReason?: string;
}
