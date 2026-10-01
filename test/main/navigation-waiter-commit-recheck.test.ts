import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

// Regression for the navigation lifecycle waiter's post-timeout commit recheck.
// A heavy page that commits just past the total bound used to resolve false and
// report TARGET_STALE on the wire while the tab had in fact loaded; the waiter
// now gets one bounded (~500ms, unref'd) grace window that still accepts
// did-finish-load / did-navigate-in-page, plus a document.readyState probe gated
// on the committed URL so the OLD document can never satisfy it. A WebContents
// destroyed mid-grace settles unclassified (no record) so the port's no-record
// TARGET_STALE keeps its "target is genuinely gone" meaning.
class FakeWebContents extends EventEmitter {
  url = '';
  readyStateValue: unknown = 'loading';
  // Models a committed Chromium error page (chrome-error:// interstitial):
  // readyState 'complete' in the page, getURL() reads the FAILED target URL.
  errorPage = false;
  destroyed = false;
  loadCalls = 0;
  reloadCalls = 0;
  loadURL(_url: string) { this.loadCalls += 1; return Promise.resolve(); }
  reload() { this.reloadCalls += 1; }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  executeJavaScript(expr: string) {
    // The waiter's probe rejects chrome-error:// documents; only expressions
    // that carry the error-page discriminant see the error document.
    if (this.errorPage && String(expr).includes('chrome-error')) return Promise.resolve(false);
    return Promise.resolve(this.readyStateValue);
  }
}

// NativeTabHost's fields are private, so tests reach the runtime surface via a
// structural double (the repo's Object.create(prototype) harness convention).
type TestHost = {
  tabs: Map<string, { view: { webContents: FakeWebContents }; state: { url: string }; redirectChain?: string[] }>;
  activeTabId: string;
  lastNavigationFailures: Map<string, { cause: string; message: string; timedOut: boolean }>;
  navigateAndWait(tabId: string, url: string, timeoutMs?: number): Promise<boolean>;
  reloadAndWait(tabId: string, timeoutMs?: number): Promise<boolean>;
  getLastNavigationFailure(tabId: string): { cause: string; message: string; timedOut: boolean } | undefined;
};

// The code under test owns real setTimeout boundaries (start/total/grace) and
// node:test has no fake-timer seam to drive them deterministically, so the
// suite deliberately exercises platform-clock timer behavior (rule exception:
// the timer code itself is the behavior being verified).
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildHost(wc: FakeWebContents, stateUrl: string): TestHost {
  const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
  host.tabs = new Map([['tab-1', { view: { webContents: wc }, state: { url: stateUrl } }]]);
  host.activeTabId = 'tab-1';
  host.lastNavigationFailures = new Map();
  host.networkTracker = {
    resetInflight: () => {},
    ensureAttached: () => Promise.resolve(),
    awaitQuiescence: () => Promise.resolve(),
  };
  return host as unknown as TestHost;
}

describe('navigation lifecycle waiter post-timeout commit recheck', () => {
  it('returns true with no failure record when a started navigation commits just past the bound', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    const host = buildHost(wc, 'https://example.com/old');

    const pending = host.navigateAndWait('tab-1', 'https://example.com/slow', 60);
    wc.emit('did-start-navigation', {}, 'https://example.com/slow', false, true);
    // The page commits during the grace window: resolved URL + loaded document.
    wc.url = 'https://example.com/slow';
    wc.readyStateValue = true;

    const res = await pending;
    assert.strictEqual(res, true);
    assert.strictEqual(host.getLastNavigationFailure('tab-1'), undefined);
  });

  it('returns false with a NAVIGATION_TIMEOUT record when a started navigation never commits', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    const host = buildHost(wc, 'https://example.com/old');

    const pending = host.navigateAndWait('tab-1', 'https://example.com/slow', 60);
    wc.emit('did-start-navigation', {}, 'https://example.com/slow', false, true);

    const res = await pending;
    assert.strictEqual(res, false);
    const failure = host.getLastNavigationFailure('tab-1');
    assert.strictEqual(failure?.cause, 'NAVIGATION_TIMEOUT');
    assert.strictEqual(failure?.timedOut, true);
  });

  it('settles unclassified when the WebContents is destroyed inside the grace window', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    const host = buildHost(wc, 'https://example.com/old');

    const pending = host.navigateAndWait('tab-1', 'https://example.com/slow', 60);
    wc.emit('did-start-navigation', {}, 'https://example.com/slow', false, true);
    // Wait out the total bound so the grace window is open, then tear down.
    await delay(150);
    wc.destroyed = true;
    wc.emit('destroyed');

    const res = await pending;
    assert.strictEqual(res, false);
    assert.strictEqual(host.getLastNavigationFailure('tab-1'), undefined);
  });

  it('refuses the old document during the start-timeout recheck: readyState alone is not a commit', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    wc.readyStateValue = true;
    const host = buildHost(wc, 'https://example.com/old');

    const pending = host.navigateAndWait('tab-1', 'https://example.com/slow', 60);
    // No did-start-navigation ever arrives and the URL stays on the old doc.

    const res = await pending;
    assert.strictEqual(res, false);
    const failure = host.getLastNavigationFailure('tab-1');
    assert.strictEqual(failure?.cause, 'NAVIGATION_START_TIMEOUT');
    assert.strictEqual(failure?.timedOut, true);
  });

  it('refuses the start-timeout recheck when no did-start-navigation was observed, even if getURL reports the target', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    wc.readyStateValue = true;
    const host = buildHost(wc, 'https://example.com/old');

    const pending = host.navigateAndWait('tab-1', 'https://example.com/slow', 60);
    // No did-start-navigation ever fires, yet getURL() already reads the target
    // (a redirect that committed before the start event was observed, or a stale
    // read): the recheck is bounded to require the observed start event, so the
    // untrusted URL answer can never false-positive a never-started navigation.
    wc.url = 'https://example.com/slow';

    const res = await pending;
    assert.strictEqual(res, false);
    const failure = host.getLastNavigationFailure('tab-1');
    assert.strictEqual(failure?.cause, 'NAVIGATION_START_TIMEOUT');
    assert.strictEqual(failure?.timedOut, true);
  });
});

describe('waiter failure veto — ERR_UNSAFE_PORT / error-page race', () => {
  it('resolves false with LOAD_FAILED when the error page beats the failed-load event to the grace probe', async () => {
    // The observed flake: navigation to a refused port commits a chrome-error://
    // document (readyState 'complete', getURL() reads the failed target), and
    // under load did-fail-load lands after the timeout's readyState probe has
    // already consulted that document. The probe must reject the error page and
    // the recorded did-fail-load must veto — never resolve true.
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    const host = buildHost(wc, 'https://example.com/old');
    const target = 'http://127.0.0.1:1/dwh-miss';

    const pending = host.navigateAndWait('tab-1', target, 60);
    wc.emit('did-start-navigation', {}, target, false, true);
    // The error document commits: getURL reports the failed target, readyState
    // complete — but it is a chrome-error page.
    wc.url = target;
    wc.readyStateValue = true;
    wc.errorPage = true;
    // did-fail-load arrives after the probe microtask drained (the race arm that
    // answered navigated:true), still inside the 500ms grace window.
    setTimeout(() => {
      wc.emit('did-fail-load', {}, -312, 'ERR_UNSAFE_PORT', target, true);
    }, 120);

    const res = await pending;
    assert.strictEqual(res, false, 'a failed navigation must never resolve true off an error-page readyState');
    const failure = host.getLastNavigationFailure('tab-1');
    assert.strictEqual(failure?.cause, 'LOAD_FAILED');
    assert.match(failure?.message || '', /ERR_UNSAFE_PORT/);
    assert.strictEqual(failure?.timedOut, false);
  });

  it('resolves false with LOAD_FAILED when did-fail-load for the target races ahead of did-start-navigation', async () => {
    // Reordered delivery: the main-frame failure names our target URL even
    // though no start event was observed yet — it is still our navigation.
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    wc.errorPage = true;
    const host = buildHost(wc, 'https://example.com/old');
    const target = 'http://127.0.0.1:1/dwh-miss';

    const pending = host.navigateAndWait('tab-1', target, 60);
    wc.emit('did-fail-load', {}, -312, 'ERR_UNSAFE_PORT', target, true);

    const res = await pending;
    assert.strictEqual(res, false);
    const failure = host.getLastNavigationFailure('tab-1');
    assert.strictEqual(failure?.cause, 'LOAD_FAILED');
    assert.match(failure?.message || '', /ERR_UNSAFE_PORT/);
  });

  it('does not latch the veto on an unattributed pre-start failure: a real commit still resolves true', async () => {
    // A main-frame did-fail-load for a DIFFERENT url (leftover from the previous
    // document's load) before any start event must not veto this navigation.
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    const host = buildHost(wc, 'https://example.com/old');
    const target = 'https://example.com/committed';

    const pending = host.navigateAndWait('tab-1', target, 60);
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/old-doc', true);
    wc.emit('did-start-navigation', {}, target, false, true);
    wc.url = target;
    wc.readyStateValue = true;

    const res = await pending;
    assert.strictEqual(res, true);
    assert.strictEqual(host.getLastNavigationFailure('tab-1'), undefined);
  });

  it('ignores a subframe did-fail-load during the grace window', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/old';
    const host = buildHost(wc, 'https://example.com/old');
    const target = 'https://example.com/subframe-load';

    const pending = host.navigateAndWait('tab-1', target, 60);
    wc.emit('did-start-navigation', {}, target, false, true);
    wc.url = target;
    wc.readyStateValue = true;
    // A subframe failure inside the grace window must not veto the commit probe.
    setTimeout(() => {
      wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://cdn.example.com/x.js', false);
    }, 90);

    const res = await pending;
    assert.strictEqual(res, true);
    assert.strictEqual(host.getLastNavigationFailure('tab-1'), undefined);
  });
});

describe('reloadAndWait timeout classification', () => {
  it('records NAVIGATION_TIMEOUT when the load completion waiter times out', async () => {
    const wc = new FakeWebContents();
    wc.url = 'https://example.com/x';
    const host = buildHost(wc, 'https://example.com/x');

    const res = await host.reloadAndWait('tab-1', 60);
    assert.strictEqual(res, false);
    const failure = host.getLastNavigationFailure('tab-1');
    assert.strictEqual(failure?.cause, 'NAVIGATION_TIMEOUT');
    assert.strictEqual(failure?.timedOut, true);
  });
});
