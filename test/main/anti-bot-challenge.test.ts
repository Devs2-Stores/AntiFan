import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyAntiBotUrl, antiBotChallengeError, AntiBotLatch, ANTI_BOT_LATCH_TTL_MS } from '../../src/main/tools/anti-bot-challenge';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'run-1',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

const SECRET_QUERY = 'token=SECRET123&return=https%3A%2F%2Fshopee.vn%2Fproduct-i.1.2';

function buildHost(liveUrl: () => string, overrides: Partial<BrowserHostPort> = {}): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: liveUrl() }],
    hasTab: (id) => id === 'tab-1',
    getTabUrl: () => liveUrl(),
    getDocumentGeneration: () => 1,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => liveUrl(),
    agentClick: async () => true,
    ...overrides,
  };
}

describe('anti-bot challenge detection (K13)', () => {
  it('classifies /verify/traffic and /verify/captcha and drops the query', () => {
    const traffic = classifyAntiBotUrl(`https://shopee.vn/verify/traffic/error?${SECRET_QUERY}`);
    assert.equal(traffic?.marker, 'verify-traffic');
    assert.equal(traffic?.host, 'shopee.vn');
    assert.equal(traffic?.path, '/verify/traffic/error');
    assert.equal(classifyAntiBotUrl('https://shopee.vn/verify/captcha?x=1')?.marker, 'verify-captcha');
    assert.equal(classifyAntiBotUrl('https://example.com/anti_bot/check')?.marker, 'anti-bot-marker');
    assert.equal(classifyAntiBotUrl('https://example.com/p?anti_bot=1')?.marker, 'anti-bot-marker');
  });

  it('leaves ordinary pages and anti-bot words in query VALUES alone', () => {
    assert.equal(classifyAntiBotUrl('https://shopee.vn/product-i.1.2'), undefined);
    assert.equal(classifyAntiBotUrl('https://example.com/search?q=anti_bot'), undefined);
    assert.equal(classifyAntiBotUrl(''), undefined);
    assert.equal(classifyAntiBotUrl('about:blank'), undefined);
  });

  it('the refusal carries host and path, never the query', () => {
    const challenge = classifyAntiBotUrl(`https://shopee.vn/verify/traffic?${SECRET_QUERY}`);
    assert.ok(challenge);
    const err = antiBotChallengeError(challenge);
    assert.equal(err.code, 'ANTI_BOT_CHALLENGE');
    assert.ok(!err.message.includes('SECRET123'));
    assert.ok(!JSON.stringify(err.details).includes('SECRET123'));
    assert.equal(err.details?.retryable, false);
  });

  it('navigate that lands on a verification page throws ANTI_BOT_CHALLENGE, not TARGET_STALE', async () => {
    let url = 'https://shopee.vn/';
    const host = buildHost(() => url, {
      navigateAndWait: async () => {
        url = `https://shopee.vn/verify/traffic/error?${SECRET_QUERY}`;
        return true;
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.navigate(TARGET, 'https://shopee.vn/product-i.1.2', 'tab-1'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'ANTI_BOT_CHALLENGE');
        assert.ok(!err.message.includes('SECRET123'));
        assert.equal(err.details?.path, '/verify/traffic/error');
        return true;
      }
    );
  });

  it('navigating TO a verification page on purpose is not refused', async () => {
    let url = 'https://shopee.vn/';
    const host = buildHost(() => url, {
      navigateAndWait: async (_tab, next) => {
        url = next;
        return true;
      },
    });
    const port = new BrowserControlPort(host);
    const res = await port.navigate(TARGET, 'https://shopee.vn/verify/traffic/error', 'tab-1');
    assert.equal(res.navigated, true);
  });

  it('a stale generation on a tab that sits on a verification page is reported as the challenge', async () => {
    const url = 'https://shopee.vn/verify/traffic/error?a=1';
    const host = buildHost(() => url, { getDocumentGeneration: () => 5 });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.agentClick({ selector: 'button' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE'
    );
  });

  it('a stale generation on a verification page is still the challenge for an @eN ref', async () => {
    const url = 'https://shopee.vn/verify/traffic/error?a=1';
    const host = buildHost(() => url, { getDocumentGeneration: () => 5 });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.agentClick({ ref: '@e1' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE'
    );
  });

  it('a selector call on an ordinary page is rebased onto the live generation and reports it', async () => {
    const host = buildHost(() => 'https://shopee.vn/product-i.1.2', { getDocumentGeneration: () => 5 });
    const port = new BrowserControlPort(host);
    const result = await port.agentClick({ selector: 'button' }, TARGET);
    assert.deepEqual(result.documentGenerationRebased, { from: TARGET.documentGeneration, to: 5 });
  });

  it('the same stale generation on an ordinary page stays TARGET_STALE with cause dom-drift', async () => {
    const host = buildHost(() => 'https://shopee.vn/product-i.1.2', { getDocumentGeneration: () => 5 });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.agentClick({ ref: '@e1' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE' && err.details?.cause === 'dom-drift'
    );
  });
});

describe('anti-bot latch', () => {
  const challenge = classifyAntiBotUrl('https://shopee.vn/verify/traffic/error?a=1')!;

  it('refuses a host that already served the partition a challenge, and only that partition', () => {
    const latch = new AntiBotLatch();
    latch.set('persist:profile-a', challenge, 'tab-1');
    assert.ok(latch.check('persist:profile-a', 'https://shopee.vn/product-i.1.2'));
    assert.equal(latch.check('persist:profile-b', 'https://shopee.vn/product-i.1.2'), undefined, 'another partition is another visitor');
    assert.equal(latch.check('persist:profile-a', 'https://other.example/'), undefined, 'another host is unaffected');
    assert.equal(latch.check('persist:profile-a', 'about:blank'), undefined);
  });

  it('expires after the TTL', () => {
    let now = 1_000;
    const latch = new AntiBotLatch(() => now);
    latch.set('default', challenge, 'tab-1');
    now += ANTI_BOT_LATCH_TTL_MS - 1;
    assert.equal(latch.check('default', 'https://shopee.vn/')?.retryAfterMs, 1);
    now += 1;
    assert.equal(latch.check('default', 'https://shopee.vn/'), undefined);
  });

  it('a second navigate to the latched host fails fast without touching the host', async () => {
    let url = 'https://shopee.vn/';
    let navigations = 0;
    const host = buildHost(() => url, {
      navigateAndWait: async (_tab, next) => {
        navigations += 1;
        url = next.includes('/verify/') ? next : 'https://shopee.vn/verify/traffic/error?a=1';
        return true;
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(() => port.navigate(TARGET, 'https://shopee.vn/product-i.1.2', 'tab-1'), (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE' && err.details?.latched === undefined);
    assert.equal(navigations, 1);
    await assert.rejects(
      () => port.navigate(TARGET, 'https://shopee.vn/product-i.9.9', 'tab-1'),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'ANTI_BOT_CHALLENGE'
        && err.details?.latched === true
        && typeof err.details?.retryAfterMs === 'number'
        && err.details.retryAfterMs > 0
    );
    assert.equal(navigations, 1, 'the latched refusal never reached the host');
  });

  it('lifts when the tab that met the challenge shows an ordinary page again (the user cleared it)', async () => {
    let url = 'https://shopee.vn/';
    let navigations = 0;
    const host = buildHost(() => url, {
      navigateAndWait: async (_tab, next) => {
        navigations += 1;
        url = navigations === 1 ? 'https://shopee.vn/verify/traffic/error?a=1' : next;
        return true;
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(() => port.navigate(TARGET, 'https://shopee.vn/product-i.1.2', 'tab-1'), (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE');
    url = 'https://shopee.vn/';
    const res = await port.navigate(TARGET, 'https://shopee.vn/product-i.2.2', 'tab-1');
    assert.equal(res.navigated, true);
    assert.equal(navigations, 2);
  });
});

describe('NAVIGATION_TIMEOUT details (K21)', () => {
  it('reports navigated:true and the live URL when the URL committed but the load never completed', async () => {
    let url = 'https://shop.example/a';
    const host = buildHost(() => url, {
      navigateAndWait: async () => {
        url = 'https://shop.example/b';
        return false;
      },
      getLastNavigationFailure: () => ({ cause: 'NAVIGATION_TIMEOUT', message: 'timed out after 20000ms', timedOut: true }),
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.navigate(TARGET, 'https://shop.example/b', 'tab-1'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(String(err.code), 'NAVIGATION_TIMEOUT');
        assert.equal(err.details?.navigated, true);
        assert.equal(err.details?.loaded, false);
        assert.equal(err.details?.url, 'https://shop.example/b');
        return true;
      }
    );
  });

  it('reports navigated:false when the tab never left the previous URL', async () => {
    const host = buildHost(() => 'https://shop.example/a', {
      navigateAndWait: async () => false,
      getLastNavigationFailure: () => ({ cause: 'NAVIGATION_TIMEOUT', message: 'timed out after 20000ms', timedOut: true }),
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.navigate(TARGET, 'https://shop.example/b', 'tab-1'),
      (err: unknown) => err instanceof CapabilityError && err.details?.navigated === false && err.details?.loaded === false
    );
  });
});
