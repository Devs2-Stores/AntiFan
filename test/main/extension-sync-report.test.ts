import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';

/**
 * The companion reports the outcome of a manual sync back to its popup. The
 * bridge is the only party that knows what it actually wrote, so the handler
 * must forward the bridge's count — reporting the number of cookies it merely
 * tried to send turned a receiver that rejected everything into "✅ Đã đồng bộ
 * thành công N cookies", which is how the whole cookie channel stayed broken
 * while the UI said otherwise.
 *
 * This lives in its own file because the extension registers its
 * `runtime.onMessage` listener as an import side effect: the shared companion
 * test file imports `background.ts` statically, by which point the chrome stub
 * no longer exists and the registration window has closed. Here the stub is
 * installed first and the module is imported dynamically, so the listener is
 * captured.
 */

interface CapturedRequest {
  action?: string;
}

type SyncListener = (request: CapturedRequest, sender: unknown, sendResponse: (res: unknown) => void) => unknown;

let capturedSyncListener: SyncListener | null = null;
let bridgeGrant: { token: string; port: number } = { token: '', port: 0 };

class MockCookieStore {
  public setCalls: Array<Record<string, unknown>> = [];

  public async set(cookie: Record<string, unknown>): Promise<void> {
    this.setCalls.push(cookie);
  }

  public async get(): Promise<Array<Record<string, unknown>>> {
    return this.setCalls;
  }

  public async flushStore(): Promise<void> {}
}

class MockTabHost extends EventEmitter {
  public session = { cookies: new MockCookieStore() };

  public getActiveCapsule(): { id: string } | null {
    return { id: 'capsule-sync-report' };
  }

  public getActiveTab(): { id: string } | null {
    return { id: 'tab-sync-report' };
  }

  public getActiveTabId(): string | null {
    return 'tab-sync-report';
  }

  public getTabList(): unknown[] {
    return [{ id: 'tab-sync-report', url: 'https://www.google.com/' }];
  }

  public getSharedProfilePartition(): string {
    return 'persist:profile-default';
  }

  public isValidCapsulePartition(): boolean {
    return true;
  }

  public getActiveTabSession(): unknown {
    return this.session;
  }

  public getTabSession(): unknown {
    return this.session;
  }

  public getPartitionSession(): unknown {
    return this.session;
  }
}

test('Companion Pipeline: the popup is told what the bridge accepted, not what the extension sent', async () => {
  const originalChrome = (globalThis as any).chrome;

  const host = new MockTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();

  // The grant has to exist before `background.ts` is evaluated: importing the
  // module kicks off its own bootstrap handshake, and a later call reuses that
  // in-flight attempt instead of starting a fresh one. A receiver grant scoped to
  // the storefront only means the extension still sends the Google cookie (it is
  // inside the extension scope the user enabled) while this bridge drops it.
  const grant = server.issueExtensionGrant('persist:profile-default', ['myharavan.com']);
  bridgeGrant = { token: grant.grantToken, port };

  // chrome stub must exist before `background.ts` is evaluated, or the module
  // never registers the listener this test drives.
  (globalThis as any).chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: {
      onMessage: {
        addListener: (cb: SyncListener) => {
          capturedSyncListener = cb;
        },
      },
      connectNative: () => {
        // The host answers each HANDSHAKE frame it receives, so the reply has to
        // be produced by postMessage — not once at connect time, when this test
        // has not issued the grant yet.
        const listeners: Array<(msg: unknown) => void> = [];
        return {
          onMessage: {
            addListener: (cb: (msg: unknown) => void) => {
              listeners.push(cb);
            },
          },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {
            const frame = {
              status: 'SUCCESS',
              token: bridgeGrant.token,
              port: bridgeGrant.port,
              activePartition: 'persist:profile-default',
            };
            for (const listener of listeners) {
              queueMicrotask(() => listener(frame));
            }
          },
          disconnect: () => {},
        };
      },
    },
  };

  try {
    await import('../../src/extension/background.js');
    assert.ok(capturedSyncListener, 'the extension must register its runtime message listener');

    (globalThis as any).chrome.tabs = {
      query: async () => [{ url: 'https://www.google.com/search?q=antifan' }],
    };
    (globalThis as any).chrome.cookies = {
      getAll: async () => [
        { name: 'SID', value: 'google-sid', domain: '.google.com', path: '/', secure: true, httpOnly: true },
        { name: 'sess', value: 'storefront-session', domain: '.myharavan.com', path: '/', secure: true, httpOnly: true },
      ],
      set: async () => undefined,
      remove: async () => undefined,
    };

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('SYNC_ACTIVE_TAB never answered the popup')), 10000);
      capturedSyncListener!({ action: 'SYNC_ACTIVE_TAB' }, {}, (res: unknown) => {
        clearTimeout(guard);
        resolve(res as Record<string, unknown>);
      });
    });

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.attempted, 2, 'both cookies are inside the extension scope the user enabled');
    assert.strictEqual(response.count, 1, 'only the cookie the receiver accepted may be reported as synced');
    const landed = host.session.cookies.setCalls;
    assert.strictEqual(landed.length, 1);
    assert.strictEqual(landed[0]?.name, 'sess');
  } finally {
    server.dispose();
    (globalThis as any).chrome = originalChrome;
  }
});
