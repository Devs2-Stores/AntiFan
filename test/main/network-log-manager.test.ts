import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  NETWORK_LOG_HEADER_ALLOWLIST,
  NetworkLogManager,
  redactNetworkHeaders,
  redactNetworkUrl,
} from '../../src/main/browser/network-log-manager';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';
import { EVAL_ELEMENT_HTML_MAX_CHARS, EVAL_MAX_DEPTH_MARKER, findEvalTruncation } from '../../src/main/browser/eval-result-truncation';

function request(manager: NetworkLogManager, id: string, url: string, extra: Record<string, unknown> = {}, tab = 't1') {
  manager.onCdpEvent(tab, 'desktop', 'Network.requestWillBeSent', {
    requestId: id,
    timestamp: 100,
    wallTime: 1_700_000_000,
    type: 'XHR',
    documentURL: 'https://shop.example.com/cart',
    request: { url, method: 'post', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc', Cookie: 'sid=1' } },
    ...extra,
  });
}

describe('NetworkLogManager', () => {
  it('records method, url, status, timing and a lower-case resource type', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/cart/add.js');
    manager.onCdpEvent('t1', 'desktop', 'Network.responseReceived', {
      requestId: '1',
      response: { status: 422, statusText: 'Unprocessable', mimeType: 'application/json', headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } },
    });
    manager.onCdpEvent('t1', 'desktop', 'Network.loadingFinished', { requestId: '1', timestamp: 100.25, encodedDataLength: 321 });
    const { entries } = manager.query('t1');
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.method, 'POST');
    assert.equal(entry.resourceType, 'xhr');
    assert.equal(entry.status, 422);
    assert.equal(entry.durationMs, 250);
    assert.equal(entry.encodedDataLength, 321);
    assert.equal(entry.documentUrl, 'https://shop.example.com/cart');
  });

  it('keeps only allowlisted headers and never a credential', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/a');
    manager.onCdpEvent('t1', 'desktop', 'Network.responseReceived', {
      requestId: '1',
      response: { status: 200, headers: { 'Set-Cookie': 'sid=secret', 'Content-Type': 'text/html', 'X-Custom': 'v' } },
    });
    const entry = manager.query('t1').entries[0]!;
    assert.deepEqual(entry.requestHeaders, { 'content-type': 'application/json' });
    assert.deepEqual(entry.responseHeaders, { 'content-type': 'text/html' });
    const serialized = JSON.stringify(entry);
    for (const leaked of ['Bearer abc', 'sid=', 'secret', 'X-Custom']) assert.equal(serialized.includes(leaked), false, leaked);
    assert.ok(NETWORK_LOG_HEADER_ALLOWLIST.every((name) => name === name.toLowerCase()));
    assert.equal(NETWORK_LOG_HEADER_ALLOWLIST.includes('authorization'), false);
    assert.equal(NETWORK_LOG_HEADER_ALLOWLIST.includes('set-cookie'), false);
    assert.equal(manager.query('t1', 'desktop', { includeHeaders: false }).entries[0]!.requestHeaders, undefined);
  });

  it('redacts credentials in URLs: userinfo, secret-looking query values and data payloads', () => {
    assert.equal(redactNetworkUrl('https://user:pw@shop.example.com/p?token=abc&page=2#frag'), 'https://shop.example.com/p?token=REDACTED&page=2#');
    assert.equal(redactNetworkUrl('https://x.test/a?api_key=1&access_token=2&q=shirt'), 'https://x.test/a?api_key=REDACTED&access_token=REDACTED&q=shirt');
    assert.match(redactNetworkUrl('data:image/png;base64,AAAA'), /^data:image\/png;base64,\.\.\.$/);
    assert.equal(redactNetworkHeaders('nope'), undefined);
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/api?session=zzz&id=5');
    assert.equal(manager.query('t1').entries[0]!.url, 'https://shop.example.com/api?session=REDACTED&id=5');
  });

  it('is a ring: the oldest entries go first and the count of evicted entries is reported', () => {
    const manager = new NetworkLogManager(3);
    for (let i = 1; i <= 5; i++) request(manager, String(i), `https://shop.example.com/r${i}`);
    const result = manager.query('t1');
    assert.deepEqual(result.entries.map((e) => e.url.slice(-2)), ['r3', 'r4', 'r5']);
    assert.equal(result.evictedCount, 2);
    assert.equal(result.bufferCapacity, 3);
    assert.equal(result.highestSeq, 5);
    // A response for an evicted request is dropped, not attached to a neighbour.
    manager.onCdpEvent('t1', 'desktop', 'Network.responseReceived', { requestId: '1', response: { status: 500 } });
    assert.equal(manager.query('t1').entries.some((e) => e.status === 500), false);
  });

  it('pages on sinceSeq with the returned highestSeq and keeps tabs apart', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/one');
    request(manager, '2', 'https://shop.example.com/two');
    request(manager, 'x', 'https://other.example.com/else', {}, 't2');
    const first = manager.query('t1');
    request(manager, '3', 'https://shop.example.com/three');
    const next = manager.query('t1', 'desktop', { sinceSeq: first.highestSeq });
    assert.deepEqual(next.entries.map((e) => e.url.slice(-5)), ['three']);
    assert.equal(manager.query('t2').entries.length, 1);
    assert.equal(manager.query('missing').entries.length, 0);
  });

  it('filters by url substring, regex, method, status class, failure and resource type', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/cart/add.js');
    request(manager, '2', 'https://shop.example.com/img/a.png', { type: 'Image', request: { url: 'https://shop.example.com/img/a.png', method: 'GET' } });
    request(manager, '3', 'https://shop.example.com/api/pay');
    manager.onCdpEvent('t1', 'desktop', 'Network.responseReceived', { requestId: '1', response: { status: 404 } });
    manager.onCdpEvent('t1', 'desktop', 'Network.responseReceived', { requestId: '2', response: { status: 200 } });
    manager.onCdpEvent('t1', 'desktop', 'Network.loadingFailed', { requestId: '3', errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' });
    const urls = (filters: Record<string, unknown>) => manager.query('t1', 'desktop', filters as never).entries.map((e) => e.url.split('/').pop());
    assert.deepEqual(urls({ urlPattern: 'CART' }), ['add.js']);
    assert.deepEqual(urls({ urlPattern: '/\\.(png|js)$/i' }), ['add.js', 'a.png']);
    assert.deepEqual(urls({ method: 'get' }), ['a.png']);
    assert.deepEqual(urls({ status: '4xx' }), ['add.js']);
    assert.deepEqual(urls({ status: 200 }), ['a.png']);
    assert.deepEqual(urls({ status: 'failed' }), ['pay']);
    assert.deepEqual(urls({ status: 'error' }), ['add.js', 'pay']);
    assert.deepEqual(urls({ resourceType: 'image' }), ['a.png']);
    const failed = manager.query('t1', 'desktop', { status: 'failed' }).entries[0]!;
    assert.equal(failed.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
    assert.equal(failed.blockedReason, 'inspector');
  });

  it('links a redirect to the request it replaced', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/old');
    request(manager, '1', 'https://shop.example.com/new', { redirectResponse: { status: 301, headers: { location: 'https://shop.example.com/new' } } });
    const entries = manager.query('t1').entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.status, 301);
    assert.equal(entries[1]!.redirectedFrom, entries[0]!.seq);
  });

  it('refuses malformed filters and body capture instead of ignoring them', () => {
    const manager = new NetworkLogManager();
    assert.throws(() => manager.query('t1', 'desktop', { includeBodies: true }), /never captured/);
    assert.throws(() => manager.query('t1', 'desktop', { limit: 0 }), /limit must be an integer/);
    assert.throws(() => manager.query('t1', 'desktop', { limit: 100_000 }), /limit must be an integer/);
    assert.throws(() => manager.query('t1', 'desktop', { sinceSeq: -1 }), /sinceSeq/);
    assert.throws(() => manager.query('t1', 'desktop', { status: '9xx' }), /status must be/);
    assert.throws(() => manager.query('t1', 'desktop', { urlPattern: '/(/i' }), /not a valid regular expression/);
    assert.throws(() => manager.query('t1', 'desktop', { urlPattern: '   ' }), /urlPattern/);
  });

  it('returns the newest `limit` entries but counts every match', () => {
    const manager = new NetworkLogManager();
    for (let i = 1; i <= 10; i++) request(manager, String(i), `https://shop.example.com/r${i}`);
    const result = manager.query('t1', 'desktop', { limit: 4 });
    assert.equal(result.returned, 4);
    assert.equal(result.totalMatched, 10);
    assert.equal(result.entries[0]!.url.endsWith('r7'), true);
  });

  it('reads /text/ without a flag as a plain substring, so a path filter is never mistaken for a regular expression', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', 'https://shop.example.com/cart/add.js');
    request(manager, '2', 'https://shop.example.com/api/v1/items');
    const urls = (urlPattern: string) => manager.query('t1', 'desktop', { urlPattern }).entries.map((e) => e.url.split('/').pop());
    assert.deepEqual(urls('/cart/add'), ['add.js']);
    assert.deepEqual(urls('/api/v1/'), ['items']);
    assert.deepEqual(urls('/ITEMS$/i'), ['items']);
  });

  it('refuses a regular expression that can backtrack catastrophically, before running it', () => {
    const manager = new NetworkLogManager();
    request(manager, '1', `https://shop.example.com/${'a'.repeat(40)}!`);
    const refused = ['/(a+)+$/i', '/(a|aa)+$/i', '/(.*)*x/i', '/(a)\\1/i', '/a*a*a*a*b/i', `/${'a'.repeat(201)}/i`];
    for (const pattern of refused) {
      assert.throws(() => manager.query('t1', 'desktop', { urlPattern: pattern }), /urlPattern/, pattern);
    }
    assert.equal(manager.query('t1', 'desktop', { urlPattern: '/^https:\\/\\/shop\\.[a-z]+\\.com\\/(a|b)x?/i' }).entries.length, 1);
  });

  it('pages a sinceSeq cursor oldest first so a poller that follows nextSeq never skips an entry', () => {
    const manager = new NetworkLogManager();
    for (let i = 1; i <= 7; i++) request(manager, String(i), `https://shop.example.com/r${i}`);
    const names = (r: { entries: Array<{ url: string }> }) => r.entries.map((e) => e.url.slice(-2));
    const first = manager.query('t1', 'desktop', { sinceSeq: 0, limit: 3 });
    assert.deepEqual(names(first), ['r1', 'r2', 'r3']);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextSeq, 3);
    const second = manager.query('t1', 'desktop', { sinceSeq: first.nextSeq, limit: 3 });
    assert.deepEqual(names(second), ['r4', 'r5', 'r6']);
    assert.equal(second.hasMore, true);
    const third = manager.query('t1', 'desktop', { sinceSeq: second.nextSeq, limit: 3 });
    assert.deepEqual(names(third), ['r7']);
    assert.equal(third.hasMore, false);
    const idle = manager.query('t1', 'desktop', { sinceSeq: third.nextSeq });
    assert.equal(idle.entries.length, 0);
    assert.equal(idle.nextSeq, 7);
    const newest = manager.query('t1', 'desktop', { limit: 2 });
    assert.deepEqual(names(newest), ['r6', 'r7']);
    assert.equal(newest.hasMore, undefined);
  });

  it('redacts hmac, sig, otp, nonce, state and code parameters, opaque checkout and order segments, and unwraps blob: URLs', () => {
    assert.equal(
      redactNetworkUrl('https://x.test/a?hmac=1&sig=2&X-Amz-Signature=3&otp=4&nonce=5&state=6&code=7&q=shirt&footprint=8'),
      'https://x.test/a?hmac=REDACTED&sig=REDACTED&X-Amz-Signature=REDACTED&otp=REDACTED&nonce=REDACTED&state=REDACTED&code=REDACTED&q=shirt&footprint=8'
    );
    assert.equal(redactNetworkUrl('https://shop.example.com/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSEVYQUpD/shipping'), 'https://shop.example.com/checkouts/cn/REDACTED/shipping');
    assert.equal(redactNetworkUrl('https://shop.example.com/orders/6f9a1c2b3d4e5f60718293a4b5c6d7e8'), 'https://shop.example.com/orders/REDACTED');
    assert.equal(redactNetworkUrl('https://shop.example.com/products/ao-thun-nam-2024-premium-edition'), 'https://shop.example.com/products/ao-thun-nam-2024-premium-edition');
    assert.equal(redactNetworkUrl('https://shop.example.com/orders/1234567890123'), 'https://shop.example.com/orders/1234567890123');
    assert.equal(redactNetworkUrl('blob:https://shop.example.com/0f6d1a52-1c3e'), 'blob:https://shop.example.com/0f6d1a52-1c3e');
    assert.equal(redactNetworkUrl('about:blank'), 'about:blank');
    assert.equal(redactNetworkUrl('javascript:alert(document.cookie)'), 'javascript:...');
  });
});

describe('request log survives navigation, not the tab', () => {
  class FakeWebContents extends EventEmitter {
    public readonly commands: string[] = [];
    private attached = false;
    public readonly debugger = Object.assign(new EventEmitter(), {
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true;
      },
      sendCommand: async (command: string) => {
        this.commands.push(command);
        return {};
      },
    });
    isDestroyed() {
      return false;
    }
  }

  it('keeps entries across a main-frame navigation and records the new document too', async () => {
    const tracker = new FirstPartyNetworkTracker();
    const wc = new FakeWebContents();
    await tracker.ensureAttached('t1', 'desktop', wc as never, () => 'https://shop.example.com/');
    assert.deepEqual(wc.commands, ['Network.enable']);
    const emit = (method: string, params: unknown) => wc.debugger.emit('message', {}, method, params);
    emit('Network.requestWillBeSent', { requestId: '1', timestamp: 1, type: 'Document', request: { url: 'https://shop.example.com/a', method: 'GET' } });
    emit('Network.loadingFinished', { requestId: '1', timestamp: 1.1 });
    // The navigation itself: a frame event the log has no reason to react to, then the next document's requests.
    emit('Page.frameNavigated', { frame: { url: 'https://shop.example.com/b' } });
    emit('Network.requestWillBeSent', { requestId: '2', timestamp: 2, type: 'Document', request: { url: 'https://shop.example.com/b', method: 'GET' } });
    const log = tracker.getNetworkLog().query('t1');
    assert.deepEqual(log.entries.map((e) => e.url.slice(-1)), ['a', 'b']);
    assert.ok(typeof log.attachedAt === 'number');
  });

  it('forgets a tab when its target is detached', async () => {
    const tracker = new FirstPartyNetworkTracker();
    const wc = new FakeWebContents();
    await tracker.ensureAttached('t1', 'desktop', wc as never, () => 'https://shop.example.com/');
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: '1', timestamp: 1, request: { url: 'https://shop.example.com/a', method: 'GET' } });
    assert.equal(tracker.getNetworkLog().query('t1').entries.length, 1);
    tracker.detachTarget('t1', 'desktop');
    assert.equal(tracker.getNetworkLog().query('t1').entries.length, 0);
  });

  it('says so when the debugger session is lost and records again once the target is re-attached', async () => {
    const tracker = new FirstPartyNetworkTracker();
    const wc = new FakeWebContents();
    const context = () => 'https://shop.example.com/';
    await tracker.ensureAttached('t1', 'desktop', wc as never, context);
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: '1', timestamp: 1, request: { url: 'https://shop.example.com/slow', method: 'GET' } });
    wc.debugger.emit('detach', {}, 'target closed');
    const lost = tracker.getNetworkLog().query('t1');
    assert.equal(lost.detached, true);
    assert.equal(lost.detachReason, 'target closed');
    assert.equal(lost.entries[0]!.interrupted, true);
    assert.equal(tracker.isAttached('t1', 'desktop'), false);
    // A dead session's events are not recorded.
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: '2', timestamp: 2, request: { url: 'https://shop.example.com/lost', method: 'GET' } });
    assert.equal(tracker.getNetworkLog().query('t1').entries.length, 1);
    await tracker.ensureAttached('t1', 'desktop', wc as never, context);
    assert.deepEqual(wc.commands, ['Network.enable', 'Network.enable']);
    const back = tracker.getNetworkLog().query('t1');
    assert.equal(back.detached, undefined);
    assert.equal(back.recordingGaps?.count, 1);
    assert.equal(back.recordingGaps?.lastReason, 'target closed');
    assert.equal(typeof back.recordingGaps?.lastEndedAt, 'number');
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: '3', timestamp: 3, request: { url: 'https://shop.example.com/after', method: 'GET' } });
    assert.equal(tracker.getNetworkLog().query('t1').entries.length, 2);
  });

  it('shares one injected manager so the host reads what the tracker recorded', async () => {
    const manager = new NetworkLogManager();
    const tracker = new FirstPartyNetworkTracker(manager);
    assert.equal(tracker.getNetworkLog(), manager);
  });
});

describe('evaluated result truncation markers', () => {
  it('finds the depth marker anywhere in a nested value', () => {
    assert.deepEqual(findEvalTruncation({ a: [{ b: EVAL_MAX_DEPTH_MARKER }] }), ['max-depth']);
    assert.deepEqual(findEvalTruncation('plain'), []);
    assert.deepEqual(findEvalTruncation({ note: `${EVAL_MAX_DEPTH_MARKER} is only a marker when it is the whole value` }), []);
  });

  it('flags a DOM element whose markup hit the cap, but not a short one', () => {
    const long = { tagName: 'DIV', outerHTML: 'x'.repeat(EVAL_ELEMENT_HTML_MAX_CHARS) };
    const short = { tagName: 'DIV', outerHTML: '<div></div>' };
    assert.deepEqual(findEvalTruncation([long]), ['element-html']);
    assert.deepEqual(findEvalTruncation([short]), []);
    assert.deepEqual(findEvalTruncation({ deep: { level: [long, EVAL_MAX_DEPTH_MARKER] } }).sort(), ['element-html', 'max-depth']);
  });
});
