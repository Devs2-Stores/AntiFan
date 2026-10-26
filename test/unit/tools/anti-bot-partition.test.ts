import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';

const CHALLENGE_URL = 'https://shopee.vn/verify/traffic/error?a=1';

function targetFor(tabId: string): BrowserTarget {
  return { projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'run-1', tabId, browserEpoch: 1, documentGeneration: 1 };
}

/**
 * `tab-1` is a strip tab on the shared `default` partition. `eph-1` is an ephemeral tab: the strip
 * list never shows it, only the session records do, and it runs in its own partition.
 */
function buildHost(urls: Map<string, string>, challengeOnTabs: Set<string>): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: urls.get('tab-1') }],
    getSessionTabList: (boundTabId: string) => (boundTabId === 'eph-1' ? [{ id: 'eph-1', url: urls.get('eph-1'), partition: 'persist:eph-1' }] : []),
    hasTab: (id: string) => id === 'tab-1' || id === 'eph-1',
    getTabUrl: (id: string) => urls.get(id),
    getDocumentGeneration: () => 1,
    navigate: () => true,
    navigateAndWait: async (tabId: string, next: string) => {
      urls.set(tabId, challengeOnTabs.has(tabId) ? CHALLENGE_URL : next);
      return true;
    },
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => '',
    agentClick: async () => true,
  } as unknown as BrowserHostPort;
}

describe('anti-bot latch partition of ephemeral tabs', () => {
  it('latches a challenge met on an ephemeral tab under its own partition, not under default', async () => {
    const urls = new Map([['tab-1', 'https://shopee.vn/'], ['eph-1', 'about:blank']]);
    const port = new BrowserControlPort(buildHost(urls, new Set(['eph-1'])));

    await assert.rejects(
      () => port.navigate(targetFor('eph-1'), 'https://shopee.vn/product-i.1.2'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE' && err.details?.latched === undefined
    );

    // The strip tab shares the `default` partition: it is a different visitor and must not be latched.
    const res = await port.navigate(targetFor('tab-1'), 'https://shopee.vn/product-i.2.2');
    assert.equal(res.navigated, true);

    // The ephemeral tab's own partition is latched, so its next attempt fails fast.
    await assert.rejects(
      () => port.navigate(targetFor('eph-1'), 'https://shopee.vn/product-i.3.3'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE' && err.details?.latched === true
    );
  });

  it('still latches a strip tab under default', async () => {
    const urls = new Map([['tab-1', 'https://shopee.vn/'], ['eph-1', 'about:blank']]);
    const port = new BrowserControlPort(buildHost(urls, new Set(['tab-1'])));

    await assert.rejects(
      () => port.navigate(targetFor('tab-1'), 'https://shopee.vn/product-i.1.2'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE'
    );
    await assert.rejects(
      () => port.navigate(targetFor('tab-1'), 'https://shopee.vn/product-i.2.2'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE' && err.details?.latched === true
    );
    const res = await port.navigate(targetFor('eph-1'), 'https://shopee.vn/product-i.3.3');
    assert.equal(res.navigated, true, 'the ephemeral tab runs in another partition and is not latched by the strip tab');
  });
});
