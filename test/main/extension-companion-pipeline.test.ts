import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BridgeServer, DEFAULT_EXTENSION_ALLOWED_DOMAINS } from '../../src/main/bridge/bridge-server';
import { LocalIpcServer } from '../../src/main/native-messaging/local-ipc-server';
import { LocalIpcClient } from '../../src/main/native-messaging/local-ipc-client';
import {
  validateBridgeAuth,
  executeAuthenticatedCookieImport,
  dispatchDeltaSync,
  loadSettings,
  triggerAutoHydration,
  ensureBridgeAuth,
  __resetExtensionStateForTesting,
  type BridgeAuth,
} from '../../src/extension/background';
import { SCOPE_PROFILES, isCookieInScope } from '../../src/extension/domain-scoper';
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

    // 3. Valid grant token -> /status responds with 200 -> validateBridgeAuth returns true
    const grant = server.issueExtensionGrant('persist:profile-default');
    const validAuth: BridgeAuth = {
      port,
      token: grant.grantToken,
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

test('Companion Pipeline: ExtensionSessionGrant enforces least authority, capability denial, and partition pinning', async () => {
  const host = new MockTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const masterToken = server.getToken();
  const targetPartition = 'persist:profile-default';
  const foreignPartition = 'persist:profile-foreign';
  const grant = server.issueExtensionGrant(targetPartition, ['haravan.com', 'myharavan.com']);

  try {
    // 1. Extension grant token must NOT equal master bridge token
    assert.notStrictEqual(grant.grantToken, masterToken, 'Grant token must be distinct from master token');

    // 2. /status with extension grant -> 200 OK, read-only payload, no master token leak
    const statusRes = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${grant.grantToken}` },
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = (await statusRes.json()) as Record<string, unknown>;
    assert.strictEqual(statusData.active, true);
    assert.strictEqual('token' in statusData, false, 'Status must never leak token');

    // 3. Capability Denial: /api/screenshot with extension grant -> 403 Forbidden
    const screenshotRes = await fetch(`http://127.0.0.1:${port}/api/screenshot`, {
      headers: { Authorization: `Bearer ${grant.grantToken}` },
    });
    assert.strictEqual(screenshotRes.status, 403);
    const screenshotData = (await screenshotRes.json()) as Record<string, unknown>;
    assert.strictEqual(screenshotData.error, 'FORBIDDEN');

    // 4. Capability Denial: /api/remote-info and /api/lan-ips with extension grant -> 403 Forbidden
    const remoteInfoRes = await fetch(`http://127.0.0.1:${port}/api/remote-info`, {
      headers: { Authorization: `Bearer ${grant.grantToken}` },
    });
    assert.strictEqual(remoteInfoRes.status, 403);

    const lanIpsRes = await fetch(`http://127.0.0.1:${port}/api/lan-ips`, {
      headers: { Authorization: `Bearer ${grant.grantToken}` },
    });
    assert.strictEqual(lanIpsRes.status, 403);

    // 5. Partition Pinning Denial: Grant A targeting Partition B -> 403 Forbidden
    const forbiddenPartitionRes = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${grant.grantToken}`,
      },
      body: JSON.stringify({
        targetPartition: foreignPartition,
        cookies: [{ name: 'test_cookie', value: 'val', domain: '.haravan.com' }],
      }),
    });
    assert.strictEqual(forbiddenPartitionRes.status, 403);
    const forbiddenData = (await forbiddenPartitionRes.json()) as Record<string, unknown>;
    assert.strictEqual(forbiddenData.error, 'FORBIDDEN_PARTITION');

    // 6. Valid Cookie Import: Grant A targeting Partition A -> 200 OK + domain scoping
    const validImportRes = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${grant.grantToken}`,
      },
      body: JSON.stringify({
        targetPartition,
        cookies: [
          { name: 'allowed_cookie', value: 'secret1', domain: '.haravan.com' },
          { name: 'disallowed_cookie', value: 'secret2', domain: '.facebook.com' },
        ],
      }),
    });
    assert.strictEqual(validImportRes.status, 200);
    const validImportData = (await validImportRes.json()) as Record<string, unknown>;
    assert.strictEqual(validImportData.success, true);
    assert.strictEqual(validImportData.importedCount, 1, 'Only the cookie in allowedDomains must be imported');

    // 6b. Empty Allowlist Denial: Grant with allowedDomains=[] denies all cookies by default
    const emptyDomainGrant = server.issueExtensionGrant(targetPartition, []);
    const emptyDomainRes = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emptyDomainGrant.grantToken}`,
      },
      body: JSON.stringify({
        targetPartition,
        cookies: [{ name: 'test_cookie', value: 'secret', domain: '.haravan.com' }],
      }),
    });
    assert.strictEqual(emptyDomainRes.status, 200);
    const emptyDomainData = (await emptyDomainRes.json()) as Record<string, unknown>;
    assert.strictEqual(emptyDomainData.success, true);
    assert.strictEqual(emptyDomainData.importedCount, 0, 'Empty allowedDomains must deny all cookie imports');

    // 7. Expired Grant Denial: Grant with negative TTL -> 401 Unauthorized EXPIRED_GRANT
    const expiredGrant = server.issueExtensionGrant(targetPartition, [], -1000);
    const expiredRes = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${expiredGrant.grantToken}` },
    });
    assert.strictEqual(expiredRes.status, 401);
    const expiredData = (await expiredRes.json()) as Record<string, unknown>;
    assert.strictEqual(expiredData.error, 'EXPIRED_GRANT');
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: default grant reaches every domain the companion extension is scoped to send', async () => {
  // The companion extracts according to SCOPE_PROFILES, but the bridge can only
  // write what its own allowlist covers. When the two lists drift apart the
  // receiver drops the extra domains and still answers 200 with every counter at
  // zero — the state in which Google logins never arrived while the popup
  // reported a successful sync. This test drives the real import route once per
  // scope pattern, so it fails on drift without duplicating the matcher.
  const host = new MockTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';

  try {
    const scopeEntries = Object.entries(SCOPE_PROFILES).flatMap(([profile, patterns]) =>
      patterns.map((pattern) => ({
        profile,
        // /(^|\.)accounts\.google\.com$/ -> ".accounts.google.com"
        host: `.${pattern.source.replace('(^|\\.)', '').replace(/\\\./g, '.').replace(/\$$/, '')}`,
      }))
    );
    assert.ok(scopeEntries.length >= 12, `expected the companion scope to be populated, saw ${scopeEntries.length} patterns`);

    const cookies = scopeEntries.map((entry, index) => ({
      name: `scoped_${index}`,
      value: 'v',
      domain: entry.host,
      path: '/',
    }));
    cookies.push({ name: 'out_of_scope', value: 'v', domain: '.evil.test', path: '/' });

    const res = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.issueExtensionGrant(targetPartition).grantToken}`,
      },
      body: JSON.stringify({ targetPartition, cookies }),
    });
    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;

    const landedHosts = new Set(
      (await host.session.cookies.get({})).map((c) => {
        const hostValue = typeof c.domain === 'string' ? c.domain : new URL(String(c.url)).hostname;
        return hostValue.startsWith('.') ? hostValue.slice(1) : hostValue;
      })
    );
    const missing = scopeEntries.filter((entry) => !landedHosts.has(entry.host.slice(1)));
    assert.deepStrictEqual(
      missing,
      [],
      `default grant dropped companion-scoped domains (add them to DEFAULT_EXTENSION_ALLOWED_DOMAINS): ${JSON.stringify(missing)}`
    );
    assert.strictEqual(data.importedCount, scopeEntries.length);
    assert.strictEqual(data.totalReceived, scopeEntries.length + 1);
    assert.strictEqual(data.filteredCount, 1, 'the out-of-scope cookie must be reported as filtered, never silently dropped');
    assert.strictEqual(landedHosts.has('evil.test'), false, 'allowlist must stay a least-privilege boundary');
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: identity cookies are refused at the bridge for every credential class', async () => {
  // Refusing the auth half of a signed-in jar is what keeps the session alive:
  // overwriting `idsrv` with a second browser's copy splits it from the
  // `idsrv.session` marker the server issued alongside it, and the server
  // answers by logging the user out. The boundary must therefore hold for a
  // caller holding the master bridge token too, not only for the companion
  // grant, so `_haravan_session` and `cart` prove the storefront half still
  // lands while `idsrv` and `idsrv.session` never reach the store.
  const host = new MockTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';
  const payloadCookies = [
    { name: 'idsrv', value: 'other-browser-identity', domain: '.accounts.haravan.com', path: '/' },
    { name: 'idsrv.session', value: 'other-browser-marker', domain: '.accounts.haravan.com', path: '/' },
    { name: 'cart', value: 'storefront-cart', domain: '.haravan.com', path: '/' },
    { name: '_haravan_session', value: 'storefront-visit', domain: '.haravan.com', path: '/' },
  ];

  try {
    const grant = server.issueExtensionGrant(targetPartition, ['haravan.com']);
    const grantedRes = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${grant.grantToken}`,
      },
      body: JSON.stringify({ targetPartition, cookies: payloadCookies }),
    });
    assert.strictEqual(grantedRes.status, 200);
    const grantedData = (await grantedRes.json()) as Record<string, unknown>;
    assert.strictEqual(grantedData.importedCount, 2, 'storefront context must keep syncing');
    assert.strictEqual(grantedData.authRejectedCount, 2, 'both identity cookies must be refused');
    assert.strictEqual(grantedData.filteredCount, 2, 'refusals must be reported, never silently dropped');

    const masterRes = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.getToken()}`,
      },
      body: JSON.stringify({ targetPartition, cookies: payloadCookies }),
    });
    assert.strictEqual(masterRes.status, 200);
    const masterData = (await masterRes.json()) as Record<string, unknown>;
    assert.strictEqual(masterData.importedCount, 2);
    assert.strictEqual(masterData.authRejectedCount, 2);

    const landedNames = (await host.session.cookies.get({})).map((c) => c.name);
    assert.deepStrictEqual(landedNames, ['cart', '_haravan_session', 'cart', '_haravan_session']);
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: identity cookies stay out of extension scope under every scope configuration', async () => {
  // The sender is the cheaper place to stop the payload, but it must not depend
  // on which profiles the user enabled. An identity cookie in scope means the
  // companion re-pushes it on every service-worker wake and on every cookie
  // change, so a wildcard profile or an actively focused admin tab must not be
  // able to opt auth cookies back in.
  const identityCookie = { name: 'idsrv.session', domain: '.accounts.haravan.com' };

  assert.strictEqual(isCookieInScope(identityCookie, ['all']), false);
  assert.strictEqual(isCookieInScope(identityCookie, ['*']), false);
  assert.strictEqual(isCookieInScope(identityCookie, ['ecommerce']), false);
  assert.strictEqual(isCookieInScope(identityCookie, ['ecommerce'], 'accounts.haravan.com'), false);
  assert.strictEqual(isCookieInScope(identityCookie, ['ecommerce'], null, ['accounts.haravan.com']), false);

  // The non-identity cookie on the very same host stays in scope, so the rule
  // cannot be mistaken for a host-wide block.
  assert.strictEqual(isCookieInScope({ name: 'cart', domain: '.haravan.com' }, ['ecommerce']), true);
  assert.strictEqual(isCookieInScope({ name: 'cart', domain: '.haravan.com' }, ['all']), true);
});

test('Companion Pipeline: Shopify account-plane cookies are refused even when the grant covers open admin tabs', async () => {
  // The handshake grant adds the host of every open AntiFan tab to the
  // allowlist, so a merchant working in admin.shopify.com puts that host in
  // the grant. Chrome's own Shopify login must still never overwrite the one
  // signed in inside AntiFan: the storefront cookie lands, every cookie on the
  // shopify.com account plane is refused, whatever its name.
  const host = new MockTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';
  const payloadCookies = [
    { name: 'account_session', value: 'chrome-login', domain: 'accounts.shopify.com', path: '/' },
    { name: 'admin_session', value: 'chrome-admin', domain: 'admin.shopify.com', path: '/' },
    { name: 'device_id', value: 'chrome-device', domain: '.shopify.com', path: '/' },
    { name: 'storefront_digest', value: 'preview-pass', domain: 'rebel-streetwear.myshopify.com', path: '/' },
  ];

  try {
    const grant = server.issueExtensionGrant(targetPartition, [
      ...DEFAULT_EXTENSION_ALLOWED_DOMAINS,
      'admin.shopify.com',
      'accounts.shopify.com',
      'dev.shopify.com',
    ]);
    const res = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${grant.grantToken}`,
      },
      body: JSON.stringify({ targetPartition, cookies: payloadCookies }),
    });
    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(data.importedCount, 1);
    assert.strictEqual(data.authRejectedCount, 3);

    const landedNames = (await host.session.cookies.get({})).map((c) => c.name);
    assert.deepStrictEqual(landedNames, ['storefront_digest']);
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: Shopify account-plane cookies stay out of extension scope under every scope configuration', async () => {
  const accountCookie = { name: 'account_session', domain: 'accounts.shopify.com' };

  assert.strictEqual(isCookieInScope(accountCookie, ['all']), false);
  assert.strictEqual(isCookieInScope(accountCookie, ['ecommerce']), false);
  assert.strictEqual(isCookieInScope(accountCookie, ['ecommerce'], 'admin.shopify.com'), false);
  assert.strictEqual(isCookieInScope({ name: 'device_id', domain: '.shopify.com' }, ['ecommerce'], null, ['shopify.com']), false);

  // The suffix match is label-aligned: storefront hosts that merely end in
  // "shopify.com" as a string keep syncing.
  assert.strictEqual(isCookieInScope({ name: 'storefront_digest', domain: 'rebel-streetwear.myshopify.com' }, ['ecommerce']), true);
  assert.strictEqual(isCookieInScope({ name: 'cart', domain: '.myshopify.com' }, ['all']), true);
});

test('Companion Pipeline: Google auth cookies are suppressed in background sync but permitted on manual active-tab sync', async () => {
  const googleAuthCookies = [
    { name: 'SAPISID', domain: '.google.com' },
    { name: 'LOGIN_INFO', domain: '.youtube.com' },
    { name: 'SID', domain: '.google.com' },
    { name: 'SSID', domain: '.google.com' },
    { name: '__Secure-3PSID', domain: '.google.com' },
    { name: '__Secure-1PAPISID', domain: '.google.com' },
  ];

  // 1. Background sync (default options, e.g. triggerAutoHydration and chrome.cookies.onChanged)
  // Must suppress Google auth cookies across all profile configurations to prevent desyncing active SPAs in AntiFan
  for (const c of googleAuthCookies) {
    assert.strictEqual(isCookieInScope(c, ['all']), false, `${c.name} must be suppressed in background sync under 'all'`);
    assert.strictEqual(isCookieInScope(c, ['google']), false, `${c.name} must be suppressed in background sync under 'google'`);
    assert.strictEqual(isCookieInScope(c, ['*']), false, `${c.name} must be suppressed in background sync under '*'`);
    assert.strictEqual(isCookieInScope(c, ['google'], 'music.youtube.com'), false, `${c.name} must be suppressed without allowGoogleAuth`);
  }

  // Non-auth Google preferences & consent cookies remain in scope in the background
  assert.strictEqual(isCookieInScope({ name: 'PREF', domain: '.youtube.com' }, ['google']), true);
  assert.strictEqual(isCookieInScope({ name: 'SOCS', domain: '.google.com' }, ['google']), true);

  // 2. Manual sync (allowGoogleAuth: true from popup SYNC_ACTIVE_TAB)
  // Deliberate user action allows syncing Google auth cookies for the active tab
  for (const c of googleAuthCookies) {
    const activeHost = c.domain.includes('youtube') ? 'music.youtube.com' : 'accounts.google.com';
    assert.strictEqual(
      isCookieInScope(c, ['google'], activeHost, [], { allowGoogleAuth: true }),
      true,
      `${c.name} must be allowed on manual active-tab sync`
    );
  }

  // 3. Platform identity cookies (Haravan idsrv) remain blocked even if allowGoogleAuth is passed
  assert.strictEqual(
    isCookieInScope({ name: 'idsrv.session', domain: '.accounts.haravan.com' }, ['ecommerce'], 'accounts.haravan.com', [], { allowGoogleAuth: true }),
    false,
    'Haravan identity cookies must stay blocked regardless of allowGoogleAuth'
  );

  // 4. Non-Google domains with same-named cookies (e.g. 'SID', 'SSID') must NOT be suppressed
  assert.strictEqual(
    isCookieInScope({ name: 'SID', domain: '.example.com' }, ['all']),
    true,
    'SID on non-Google domain must stay in scope under wildcard'
  );
  assert.strictEqual(
    isCookieInScope({ name: 'SSID', domain: '.example.com' }, ['all']),
    true,
    'SSID on non-Google domain must stay in scope under wildcard'
  );
});


/**
 * A jar with the semantics the receiver relies on: a cookie is unique per
 * name + domain + path, a second set replaces the first, `get({})` lists every
 * live cookie, and a host-only cookie reports the host it was set for.
 */
class LiveJarCookieStore {
  private jar = new Map<string, Record<string, unknown>>();
  public getAllCalls = 0;
  public getCalls = 0;

  private static keyOf(name: string, domain: string, cookiePath: string): string {
    return `${name}|${domain.startsWith('.') ? domain.slice(1) : domain}|${cookiePath}`;
  }

  public seed(cookie: { name: string; value: string; domain: string; path?: string; expirationDate?: number }): void {
    const cookiePath = cookie.path ?? '/';
    this.jar.set(LiveJarCookieStore.keyOf(cookie.name, cookie.domain, cookiePath), { ...cookie, path: cookiePath });
  }

  public async set(details: { url: string; name: string; value: string; domain?: string; path?: string; expirationDate?: number }): Promise<void> {
    const domain = details.domain ?? new URL(details.url).hostname;
    const cookiePath = details.path ?? '/';
    this.jar.set(LiveJarCookieStore.keyOf(details.name, domain, cookiePath), {
      name: details.name,
      value: details.value,
      domain,
      path: cookiePath,
      expirationDate: details.expirationDate,
    });
  }

  public async get(query: { name?: string; domain?: string; path?: string }): Promise<Array<Record<string, unknown>>> {
    if (query.name === undefined && query.domain === undefined && query.path === undefined) this.getAllCalls += 1;
    else this.getCalls += 1;
    return [...this.jar.values()].filter((c) => {
      if (query.name && c.name !== query.name) return false;
      if (query.domain && c.domain !== query.domain) return false;
      if (query.path && c.path !== query.path) return false;
      return true;
    });
  }

  public async flushStore(): Promise<void> {}

  public valueOf(name: string): unknown {
    return [...this.jar.values()].find((c) => c.name === name)?.value;
  }
}

class LiveJarTabHost extends MockTabHost {
  public liveJar = new LiveJarCookieStore();
  public override session = { cookies: this.liveJar as unknown as MockCookieStore };
}

async function postCookieImport(
  port: number,
  token: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/api/cookies/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

test('Companion Pipeline: hydrate never overwrites a live non-identity cookie', async () => {
  const host = new LiveJarTabHost();
  host.liveJar.seed({ name: 'foo', value: 'live', domain: '.haravan.com' });
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';

  try {
    const grant = server.issueExtensionGrant(targetPartition, ['haravan.com']);
    const data = await postCookieImport(port, grant.grantToken, {
      targetPartition,
      source: 'chrome-extension-hydrate',
      cookies: [
        { name: 'foo', value: 'chrome', domain: '.haravan.com', path: '/' },
        { name: 'bar', value: 'chrome', domain: '.haravan.com', path: '/' },
      ],
    });

    assert.strictEqual(host.liveJar.valueOf('foo'), 'live', 'the cookie the AntiFan jar already holds must win');
    assert.strictEqual(host.liveJar.valueOf('bar'), 'chrome', 'a cookie the jar lacks is still filled in');
    assert.ok((data.liveJarWinsCount as number) >= 1);
    assert.strictEqual(data.liveJarWinsCount, 1);
    assert.strictEqual(data.importedCount, 1);
    assert.strictEqual(data.skippedCount, 1, 'a cookie skipped because the live jar won is still counted as skipped');
    assert.strictEqual(host.liveJar.getCalls, 0, 'the jar is read once per request, never once per cookie');
    assert.strictEqual(host.liveJar.getAllCalls, 1);
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: hydrate into an empty jar imports every cookie', async () => {
  const host = new LiveJarTabHost();
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';

  try {
    const grant = server.issueExtensionGrant(targetPartition, ['haravan.com']);
    const data = await postCookieImport(port, grant.grantToken, {
      targetPartition,
      source: 'chrome-extension-hydrate',
      cookies: [
        { name: 'foo', value: 'chrome', domain: '.haravan.com', path: '/' },
        { name: 'bar', value: 'chrome', domain: 'shop.haravan.com', path: '/' },
      ],
    });

    assert.strictEqual(data.importedCount, 2);
    assert.strictEqual(data.liveJarWinsCount, 0);
    assert.strictEqual(host.liveJar.valueOf('foo'), 'chrome');
    assert.strictEqual(host.liveJar.valueOf('bar'), 'chrome');
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: an extension payload without a source is treated as hydrate', async () => {
  const host = new LiveJarTabHost();
  host.liveJar.seed({ name: 'foo', value: 'live', domain: '.haravan.com' });
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';

  try {
    const grant = server.issueExtensionGrant(targetPartition, ['haravan.com']);
    const data = await postCookieImport(port, grant.grantToken, {
      targetPartition,
      cookies: [{ name: 'foo', value: 'chrome', domain: '.haravan.com', path: '/' }],
    });

    assert.strictEqual(data.liveJarWinsCount, 1);
    assert.strictEqual(data.importedCount, 0);
    assert.strictEqual(host.liveJar.valueOf('foo'), 'live');
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: delta still mirrors non-identity cookies and identity cookies stay refused', async () => {
  const host = new LiveJarTabHost();
  host.liveJar.seed({ name: 'foo', value: 'old', domain: '.haravan.com' });
  host.liveJar.seed({ name: 'idsrv', value: 'live-identity', domain: '.accounts.haravan.com' });
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();
  const targetPartition = 'persist:profile-default';

  try {
    const grant = server.issueExtensionGrant(targetPartition, ['haravan.com']);
    const data = await postCookieImport(port, grant.grantToken, {
      targetPartition,
      source: 'chrome-extension-delta',
      cookies: [
        { name: 'foo', value: 'new', domain: '.haravan.com', path: '/' },
        { name: 'idsrv', value: 'chrome-identity', domain: '.accounts.haravan.com', path: '/' },
      ],
    });

    assert.strictEqual(host.liveJar.valueOf('foo'), 'new', 'a delta mirrors the change Chrome just observed');
    assert.strictEqual(host.liveJar.valueOf('idsrv'), 'live-identity', 'the identity cookie must never be replaced');
    assert.strictEqual(data.importedCount, 1);
    assert.strictEqual(data.liveJarWinsCount, 0);
    assert.ok((data.authRejectedCount as number) > 0);
    assert.strictEqual(host.liveJar.getAllCalls, 0, 'a delta does not snapshot the jar');
  } finally {
    server.dispose();
  }
});

test('Companion Pipeline: the master bridge token is not subject to hydrate set-if-absent', async () => {
  const host = new LiveJarTabHost();
  host.liveJar.seed({ name: 'foo', value: 'live', domain: '.haravan.com' });
  const server = new BridgeServer(host as unknown as NativeTabHost, 0);
  const port = await server.start();

  try {
    const data = await postCookieImport(port, server.getToken(), {
      targetPartition: 'persist:profile-default',
      cookies: [{ name: 'foo', value: 'explicit', domain: '.haravan.com', path: '/' }],
    });

    assert.strictEqual(data.liveJarWinsCount, 0);
    assert.strictEqual(host.liveJar.valueOf('foo'), 'explicit');
  } finally {
    server.dispose();
  }
});

function installHydrationChrome(storage: Record<string, unknown>, cookies: Array<Record<string, unknown>>): {
  connectCount: () => number;
} {
  let connects = 0;
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in storage).map((k) => [k, storage[k]])),
        set: async (items: Record<string, unknown>) => { Object.assign(storage, items); },
        remove: async () => {},
      },
    },
    cookies: { getAll: async () => cookies },
    runtime: {
      connectNative: () => {
        connects += 1;
        let listener: ((msg: unknown) => void) | null = null;
        return {
          onMessage: { addListener: (cb: (msg: unknown) => void) => { listener = cb; } },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {
            queueMicrotask(() => listener?.({
              status: 'SUCCESS',
              token: `grant-${connects}`,
              port: 20130,
              activePartition: 'persist:profile-default',
            }));
          },
          disconnect: () => {},
        };
      },
    },
  };
  return { connectCount: () => connects };
}

test('Companion Pipeline: an identical hydrate is skipped across a worker restart', async () => {
  __resetExtensionStateForTesting();
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;
  const storage: Record<string, unknown> = {};
  const chromeCookies = [
    { name: 'cart', value: 'a', domain: '.haravan.com', path: '/', secure: true, httpOnly: false },
    { name: 'theme', value: 'b', domain: '.haravan.com', path: '/', secure: true, httpOnly: false, expirationDate: 4102444800 },
  ];
  const sent: Array<Record<string, unknown>> = [];
  (globalThis as any).fetch = (async (_input: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? '{}'));
    return { status: 200, ok: true, json: async () => ({ success: true, importedCount: 2 }) } as any;
  }) as unknown as typeof fetch;
  const chromeMock = installHydrationChrome(storage, chromeCookies);

  try {
    const first = await triggerAutoHydration();
    assert.strictEqual(first.success, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]?.source, 'chrome-extension-hydrate', 'bulk sync must declare itself as hydrate');
    assert.ok(storage['antifanHydrateDigest'], 'the digest must be persisted after a successful hydrate');

    // A service-worker restart drops every module variable but keeps storage.
    __resetExtensionStateForTesting();
    const second = await triggerAutoHydration();
    assert.deepStrictEqual(second, { success: true, count: 0 });
    assert.strictEqual(sent.length, 1, 'an unchanged jar inside the interval must not be posted again');
    assert.strictEqual(chromeMock.connectCount(), 1, 'a skipped hydrate must not spawn another native host');

    // A changed jar is a new digest and is posted again.
    chromeCookies.push({ name: 'wishlist', value: 'c', domain: '.haravan.com', path: '/', secure: true, httpOnly: false });
    __resetExtensionStateForTesting();
    const third = await triggerAutoHydration();
    assert.strictEqual(third.success, true);
    assert.strictEqual(sent.length, 2);
  } finally {
    __resetExtensionStateForTesting();
    globalThis.fetch = originalFetch;
    (globalThis as any).chrome = originalChrome;
  }
});

test('Companion Pipeline: a failed hydrate is not remembered and is retried', async () => {
  __resetExtensionStateForTesting();
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;
  const storage: Record<string, unknown> = {};
  let status = 500;
  let posts = 0;
  (globalThis as any).fetch = (async () => {
    posts += 1;
    return {
      status,
      ok: status === 200,
      json: async () => ({ success: true, importedCount: 1 }),
      text: async () => 'boom',
    } as any;
  }) as unknown as typeof fetch;
  installHydrationChrome(storage, [
    { name: 'cart', value: 'a', domain: '.haravan.com', path: '/', secure: true, httpOnly: false },
  ]);

  try {
    const failed = await triggerAutoHydration();
    assert.strictEqual(failed.success, false);
    assert.strictEqual(storage['antifanHydrateDigest'], undefined, 'a failed hydrate must not be recorded');

    status = 200;
    __resetExtensionStateForTesting();
    const retried = await triggerAutoHydration();
    assert.strictEqual(retried.success, true);
    assert.strictEqual(posts, 2);
  } finally {
    __resetExtensionStateForTesting();
    globalThis.fetch = originalFetch;
    (globalThis as any).chrome = originalChrome;
  }
});
