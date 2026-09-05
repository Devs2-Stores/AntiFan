/**
 * clearStorageForActiveTab must be origin-scoped and fail closed.
 *
 * Regression for review finding 6: on URLs without a parseable http(s) origin
 * (about:blank, file:, chrome://), the old code called clearStorageData
 * WITHOUT an origin — wiping the ENTIRE partition. It now refuses.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

function makeSession(clearCalls: Array<Record<string, unknown>>) {
  return {
    clearStorageData: async (details: Record<string, unknown>) => {
      clearCalls.push(details);
    },
  };
}

function makeTab(url: string, session: { clearStorageData: (details: Record<string, unknown>) => Promise<void> }, reloadFlag: { reloaded: boolean }) {
  return {
    view: {
      webContents: {
        getURL: () => url,
        session,
        isDestroyed: () => false,
        reload: () => {
          reloadFlag.reloaded = true;
        },
      },
    },
    state: { splitMode: false, mobileView: null },
  };
}

function makeHost(tab: unknown) {
  const host = Object.create(NativeTabHost.prototype) as { tabs: Map<string, unknown>; activeTabId: string };
  host.tabs = new Map([['tab-1', tab]]);
  host.activeTabId = 'tab-1';
  return host;
}

describe('clearStorageForActiveTab origin scope', () => {
  it('refuses to clear for non-http(s) URLs (about:blank) and never calls clearStorageData', async () => {
    const clearCalls: Array<Record<string, unknown>> = [];
    const reloadFlag = { reloaded: false };
    const host = makeHost(makeTab('about:blank', makeSession(clearCalls), reloadFlag));

    const res = await (host as unknown as NativeTabHost).clearStorageForActiveTab();

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'UNSUPPORTED_ORIGIN');
    assert.strictEqual(clearCalls.length, 0, 'clearStorageData must not be called without a scoped origin');
    assert.strictEqual(reloadFlag.reloaded, false);
  });

  it('refuses for file: URLs too', async () => {
    const clearCalls: Array<Record<string, unknown>> = [];
    const host = makeHost(makeTab('file:///C:/index.html', makeSession(clearCalls), { reloaded: false }));
    const res = await (host as unknown as NativeTabHost).clearStorageForActiveTab();
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'UNSUPPORTED_ORIGIN');
    assert.strictEqual(clearCalls.length, 0);
  });

  it('clears scoped to the exact https origin and reloads the page', async () => {
    const clearCalls: Array<Record<string, unknown>> = [];
    const reloadFlag = { reloaded: false };
    const host = makeHost(makeTab('https://example.com/path?q=1#frag', makeSession(clearCalls), reloadFlag));

    const res = await (host as unknown as NativeTabHost).clearStorageForActiveTab();

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.origin, 'https://example.com');
    assert.strictEqual(clearCalls.length, 1);
    assert.deepStrictEqual(clearCalls[0], {
      origin: 'https://example.com',
      storages: ['cookies', 'localstorage', 'cachestorage'],
    });
    assert.strictEqual(reloadFlag.reloaded, true);
  });

  it('returns NO_ACTIVE_TAB when no tab is active', async () => {
    const host = Object.create(NativeTabHost.prototype) as { tabs: Map<string, unknown>; activeTabId: string };
    host.tabs = new Map();
    host.activeTabId = 'missing';
    const res = await (host as unknown as NativeTabHost).clearStorageForActiveTab();
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'NO_ACTIVE_TAB');
  });
});

describe('getSharedProfilePartition explicit profile routing', () => {
  it('derives persist:profile-* from the EXPLICIT profileId, independent of active state', () => {
    const host = Object.create(NativeTabHost.prototype) as {
      getSharedProfilePartition: (mode?: string, ephemeral?: boolean, profileId?: string) => string;
    };
    assert.strictEqual(host.getSharedProfilePartition('clean', false, 'Default'), 'persist:profile-default');
    assert.strictEqual(host.getSharedProfilePartition('clean', false, 'Profile 1'), 'persist:profile-profile-1');
    assert.strictEqual(host.getSharedProfilePartition('clean', false, 'Work-X'), 'persist:profile-work-x');
    assert.strictEqual(host.getSharedProfilePartition('native', false, 'Default'), 'persist:profile-default-native');
  });

  it('takes the same explicit path via getSharedProfileSession without touching Electron in the string layer', () => {
    // Partition naming is a pure string function; only session.fromPartition
    // needs Electron (covered by the hermetic boot smoke).
    const host = Object.create(NativeTabHost.prototype) as {
      getSharedProfilePartition: (mode?: string, ephemeral?: boolean, profileId?: string) => string;
    };
    assert.strictEqual(host.getSharedProfilePartition('clean', false, 'Profile 2'), 'persist:profile-profile-2');
  });
});