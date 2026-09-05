import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { LocalIpcServer } from '../../src/main/native-messaging/local-ipc-server';
import { LocalIpcClient } from '../../src/main/native-messaging/local-ipc-client';
import {
  validateBridgeAuth,
  executeAuthenticatedCookieImport,
  dispatchDeltaSync,
  loadSettings,
  ensureBridgeAuth,
  __resetExtensionStateForTesting,
  type BridgeAuth,
} from '../../src/extension/background';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';

class MockCookieStore {
  private cookies: Array<Record<string, unknown>> = [];
  public flushed = false;

  public async set(cookie: Record<string, unknown>): Promise<void> {
    this.cookies.push(cookie);
  }

  public async get(query: { name?: string; domain?: string }): Promise<Array<Record<string, unknown>>> {
    return this.cookies.filter((c) => {
      if (query.name && c.name !== query.name) return false;
      if (query.domain && c.domain !== query.domain) return false;
      return true;
    });
  }

  public async flushStore(): Promise<void> {
    this.flushed = true;
  }
}

class MockTabHost extends EventEmitter {
  public session = { cookies: new MockCookieStore() };

  public getActiveCapsule(): { id: string } | null {
    return { id: 'capsule-test-1' };
  }

  public getActiveTab(): { id: string } | null {
    return { id: 'tab-1' };
  }

  public getActiveTabId(): string | null {
    return 'tab-1';
  }

  public getTabList(): any[] {
    return [{ id: 'tab-1', url: 'https://admin.haravan.com' }];
  }

  public getSharedProfilePartition(): string {
    return 'persist:profile-default';
  }

  public isValidCapsulePartition(): boolean {
    return true;
  }

  public getActiveTabSession(): any {
    return this.session;
  }

  public getTabSession(): any {
    return this.session;
  }

  public getPartitionSession(): any {
    return this.session;
  }
}

test('Companion Pipeline: validateBridgeAuth validates liveness against authenticated /status endpoint', async () => {
  const host = new MockTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();

  try {
    // 1. Missing auth
    assert.strictEqual(await validateBridgeAuth(null), false);

    // 2. Invalid or stale token -> /status responds with 401 -> validateBridgeAuth returns false
    const invalidAuth: BridgeAuth = {
      port,
      token: 'invalid-stale-token-12345',
      activePartition: 'persist:profile-default',
    };
    assert.strictEqual(await validateBridgeAuth(invalidAuth), false);

    // 3. Valid master token -> /status responds with 200 -> validateBridgeAuth returns true
    const validAuth: BridgeAuth = {
      port,
      token: server.getToken(),
      activePartition: 'persist:profile-default',
    };
    assert.strictEqual(await validateBridgeAuth(validAuth), true);
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: executeAuthenticatedCookieImport performs authenticated import with 401 retry', async () => {
  let initialCall = true;
  const mockSupplier = async (): Promise<BridgeAuth> => ({
    port: 20130,
    token: initialCall ? 'stale-token' : 'fresh-token',
    activePartition: 'persist:profile-default',
  });

  const mockReauth = async (): Promise<BridgeAuth> => {
    initialCall = false;
    return {
      port: 20130,
      token: 'fresh-token',
      activePartition: 'persist:profile-default',
    };
  };

  const requests: Array<{ url: string; authHeader?: string }> = [];

  const fakeFetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const authHeader = init?.headers?.Authorization;
    requests.push({ url, authHeader });

    if (authHeader === 'Bearer stale-token') {
      return {
        status: 401,
        ok: false,
        json: async () => ({ error: 'Unauthorized' }),
      } as any;
    }

    return {
      status: 200,
      ok: true,
      json: async () => ({ success: true, importedCount: 2 }),
    } as any;
  }) as unknown as typeof fetch;

  const result = await executeAuthenticatedCookieImport(
    { cookies: [{ name: 'test', value: '1', domain: 'example.com' }] },
    mockSupplier,
    mockReauth,
    fakeFetch
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.count, 2);
  assert.strictEqual(requests.length, 2, 'Must perform initial request then retry on 401');
  assert.ok(requests[0]);
  assert.ok(requests[1]);
  assert.strictEqual(requests[0].authHeader, 'Bearer stale-token');
  assert.strictEqual(requests[1].authHeader, 'Bearer fresh-token');
});

test('Companion Pipeline: End-to-end Local IPC negotiation to authenticated cookie ingestion', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-ipc-e2e-${crypto.randomUUID()}`);
  const host = new MockTabHost();
  const bridgeServer = new BridgeServer(host as unknown as NativeTabHost, 0);
  const bridgePort = await bridgeServer.start();

  const ipcServer = new LocalIpcServer();
  await ipcServer.start(
    bridgePort,
    () => ({
      token: bridgeServer.getToken(),
      port: bridgePort,
      activeCapsuleId: 'capsule-test-1',
      activePartition: 'persist:profile-default',
    }),
    tmpRuntimeDir
  );
  const client = new LocalIpcClient(tmpRuntimeDir);
  try {
    // 1. Client connects to Native Messaging Named Pipe IPC to negotiate token
    const handshakeResult = await client.send({ action: 'HANDSHAKE' });

    assert.strictEqual(handshakeResult.status, 'SUCCESS');
    assert.strictEqual(handshakeResult.token, bridgeServer.getToken());
    assert.strictEqual(handshakeResult.port, bridgePort);
    assert.strictEqual(handshakeResult.activePartition, 'persist:profile-default');

    // 2. Validate token liveness against /status
    const auth: BridgeAuth = {
      token: handshakeResult.token!,
      port: handshakeResult.port!,
      activePartition: handshakeResult.activePartition,
    };
    const isLive = await validateBridgeAuth(auth);
    assert.strictEqual(isLive, true);

    // 3. Ingest cookies using negotiated token
    const importResult = await executeAuthenticatedCookieImport(
      {
        cookies: [
          { name: 'session_auth', value: 'test_val_999', domain: '.haravan.com', path: '/', secure: true },
        ],
        partition: auth.activePartition,
      },
      async () => auth,
      async () => auth
    );

    assert.strictEqual(importResult.success, true);
    assert.strictEqual(importResult.count, 1);

    // 4. Verify cookie reached target session store
    const stored = await host.session.cookies.get({ name: 'session_auth' });
    assert.strictEqual(stored.length, 1);
    assert.ok(stored[0]);
    assert.strictEqual(stored[0].value, 'test_val_999');
  } finally {
    client.disconnect();
    ipcServer.close();
    bridgeServer.dispose();
  }
});

test('Companion Pipeline: ensureBridgeAuth requires fresh native handshake and never trusts stored credentials without live nativePort', async () => {
  __resetExtensionStateForTesting();
  let connectNativeCalled = false;
  let httpProbeCount = 0;

  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;

  (globalThis as any).fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/status')) {
      httpProbeCount += 1;
    }
    return { ok: true, status: 200, json: async () => ({ active: true, port: 20130 }) } as any;
  }) as typeof fetch;

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => ({
          bridgeAuth: { token: 'stale-attacker-token', port: 20130, activePartition: 'persist:profile-default' },
        }),
        set: async () => {},
        remove: async () => {},
      },
    },
    runtime: {
      connectNative: () => {
        connectNativeCalled = true;
        return {
          onMessage: { addListener: () => {} },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {},
          disconnect: () => {},
        };
      },
    },
  };

  try {
    // 1. Service worker starts/restarts: loadSettings() must not restore bridgeAuth into active credentials
    await loadSettings();

    // 2. ensureBridgeAuth must force a fresh connectNative and must NOT probe HTTP based on stored stale credentials
    await ensureBridgeAuth();

    assert.strictEqual(connectNativeCalled, true, 'Must initiate Native Messaging handshake');
    assert.strictEqual(httpProbeCount, 0, 'Must NOT probe loopback HTTP when nativePort was absent');
  } finally {
    __resetExtensionStateForTesting();
    globalThis.fetch = originalFetch;
    (globalThis as any).chrome = originalChrome;
  }
});

test('Companion Pipeline: concurrent ensureBridgeAuth calls are deduplicated into a single native handshake', async () => {
  __resetExtensionStateForTesting();
  let connectCount = 0;
  let postMessageCount = 0;
  let onMessageListener: any = null;

  const originalChrome = (globalThis as any).chrome;

  (globalThis as any).chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: {
      connectNative: () => {
        connectCount += 1;
        return {
          onMessage: { addListener: (cb: any) => { onMessageListener = cb; } },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {
            postMessageCount += 1;
            queueMicrotask(() => {
              if (onMessageListener) {
                onMessageListener({
                  status: 'SUCCESS',
                  token: 'concurrent-safe-token-999',
                  port: 20130,
                  activePartition: 'persist:profile-default',
                });
              }
            });
          },
          disconnect: () => {},
        };
      },
    },
  };

  try {
    // Fire 5 concurrent calls
    const results = await Promise.all([
      ensureBridgeAuth(),
      ensureBridgeAuth(),
      ensureBridgeAuth(),
      ensureBridgeAuth(),
      ensureBridgeAuth(),
    ]);

    assert.strictEqual(connectCount, 1, 'Only one native connection must be opened');
    assert.strictEqual(postMessageCount, 1, 'Only one handshake message must be dispatched');
    for (const r of results) {
      assert.ok(r);
      assert.strictEqual(r?.token, 'concurrent-safe-token-999');
      assert.strictEqual(r?.port, 20130);
    }
  } finally {
    __resetExtensionStateForTesting();
    (globalThis as any).chrome = originalChrome;
  }
});

test('Companion Pipeline: Desktop loss triggers disconnect and subsequent auth calls return null without probing stale port', async () => {
  __resetExtensionStateForTesting();
  let onDisconnectListener: any = null;
  let httpProbeCount = 0;

  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;

  (globalThis as any).fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/status') || url.includes('/api/cookies/import')) {
      httpProbeCount += 1;
    }
    return { ok: true, status: 200, json: async () => ({ active: true, port: 20130 }) } as any;
  }) as typeof fetch;

  (globalThis as any).chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: {
      connectNative: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: (cb: any) => { onDisconnectListener = cb; } },
        postMessage: () => {},
        disconnect: () => {},
      }),
    },
  };

  try {
    // Force refresh and simulate disconnect when Desktop terminates
    await ensureBridgeAuth(true);
    if (onDisconnectListener) {
      onDisconnectListener();
    }

    // Subsequent ensureBridgeAuth call must return null (handshake times out without Desktop response)
    // and must NEVER send HTTP probes to the stale loopback port
    const result = await ensureBridgeAuth();
    assert.strictEqual(result, null, 'Must return null when Desktop is absent');
    assert.strictEqual(httpProbeCount, 0, 'Must never probe stale port when Desktop is lost');

    // Cookie import fails closed immediately without leaking cookies to the stale port
    const importRes = await executeAuthenticatedCookieImport(
      { cookies: [{ name: 'stale_check', value: 'secret' }] },
      ensureBridgeAuth,
      ensureBridgeAuth,
      globalThis.fetch
    );
    assert.strictEqual(importRes.success, false);
    assert.strictEqual(importRes.count, 0);
    assert.strictEqual(importRes.error, 'NOT_CONNECTED_TO_ANTIFAN');
    assert.strictEqual(httpProbeCount, 0, 'Must never transmit cookies to stale port');
  } finally {
    __resetExtensionStateForTesting();
    globalThis.fetch = originalFetch;
    (globalThis as any).chrome = originalChrome;
  }
});

test('Companion Pipeline: dispatchDeltaSync with removal-only batch no-ops and performs zero HTTP calls', async () => {
  __resetExtensionStateForTesting();
  let httpCalls = 0;
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = (async () => {
    httpCalls += 1;
    return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
  }) as typeof fetch;

  try {
    const result = await dispatchDeltaSync({
      upserted: [],
      removed: [{ name: 'session_old', domain: '.haravan.com', path: '/', secure: true }],
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(httpCalls, 0, 'Must not send HTTP request for removal-only batch');
  } finally {
    __resetExtensionStateForTesting();
    globalThis.fetch = originalFetch;
  }
});

test('Companion Pipeline: dispatchDeltaSync with mixed batch strips removals and imports upserted cookies', async () => {
  __resetExtensionStateForTesting();
  let dispatchedPayload: any = null;
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;

  (globalThis as any).fetch = (async (_input: any, init?: any) => {
    if (init?.body) {
      dispatchedPayload = JSON.parse(init.body);
    }
    return { ok: true, status: 200, json: async () => ({ success: true, importedCount: 1 }) } as any;
  }) as typeof fetch;

  // Mock active nativePort & auth so ensureBridgeAuth resolves
  (globalThis as any).chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: {
      connectNative: () => ({
        onMessage: {
          addListener: (cb: any) => {
            queueMicrotask(() => {
              cb({ status: 'SUCCESS', token: 'test-token', port: 20130, activePartition: 'persist:profile-default' });
            });
          },
        },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    },
  };

  try {
    const result = await dispatchDeltaSync({
      upserted: [
        {
          name: 'auth_new',
          value: 'secret_123',
          domain: '.haravan.com',
          path: '/',
          secure: true,
          httpOnly: true,
        },
      ],
      removed: [
        {
          name: 'auth_old',
          domain: '.haravan.com',
          path: '/',
          secure: true,
        },
      ],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.error, undefined);
    assert.ok(dispatchedPayload, 'Payload must be dispatched via HTTP');
    assert.strictEqual(dispatchedPayload.source, 'chrome-extension-delta');
    assert.strictEqual(typeof dispatchedPayload.timestamp, 'number');
    assert.strictEqual(dispatchedPayload.cookies?.length, 1);
    assert.strictEqual(dispatchedPayload.cookies[0].name, 'auth_new');
    assert.strictEqual('removed' in dispatchedPayload, false, 'Must strictly omit removed property from HTTP payload');
  } finally {
    __resetExtensionStateForTesting();
    globalThis.fetch = originalFetch;
    (globalThis as any).chrome = originalChrome;
  }
});
