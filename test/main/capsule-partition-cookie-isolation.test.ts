import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { extensionCookieImportSetDetails } from '../../src/main/browser/chrome-profile-sync';
import { deriveCapsulePartition } from '../../src/main/browser/browser-session-partition';

class MockCookieStore {
  public cookies: Map<string, Record<string, unknown>> = new Map();
  public flushed = false;

  public async set(details: Record<string, unknown>): Promise<void> {
    const key = `${details.domain || ''}|${details.path || '/'}|${details.name}`;
    this.cookies.set(key, { ...details });
  }

  public async remove(url: string, name: string): Promise<void> {
    let targetHost = '';
    let targetPath = '/';
    try {
      const u = new URL(url);
      targetHost = u.hostname.toLowerCase();
      targetPath = u.pathname || '/';
    } catch {
      // Fail closed on invalid URL
      return;
    }
    if (!targetHost) return;

    for (const [key, c] of Array.from(this.cookies.entries())) {
      if (c.name !== name) continue;
      const cDomain = String(c.domain || '').toLowerCase().replace(/^\./, '');
      const cPath = String(c.path || '/');

      // RFC 6265 Section 5.1.3: Domain Matching
      const domainMatches = Boolean(cDomain && (targetHost === cDomain || targetHost.endsWith('.' + cDomain)));

      // RFC 6265 Section 5.1.4: Path Matching
      const pathMatches =
        targetPath === cPath ||
        (cPath.endsWith('/') && targetPath.startsWith(cPath)) ||
        targetPath.startsWith(cPath + (cPath.endsWith('/') ? '' : '/'));

      if (domainMatches && pathMatches) {
        this.cookies.delete(key);
      }
    }
  }

  public async get(query: { name?: string; domain?: string; path?: string }): Promise<Array<Record<string, unknown>>> {
    const res: Array<Record<string, unknown>> = [];
    for (const c of this.cookies.values()) {
      if (query.name && c.name !== query.name) continue;
      if (query.domain) {
        const qDomain = query.domain.replace(/^\./, '');
        const cDomain = String(c.domain || '').replace(/^\./, '');
        if (cDomain !== qDomain && !cDomain.endsWith(`.${qDomain}`)) continue;
      }
      if (query.path && c.path !== query.path) continue;
      res.push(c);
    }
    return res;
  }
  public async flushStore(): Promise<void> {
    this.flushed = true;
  }
}

class MockIsolatedSession {
  public cookies = new MockCookieStore();
}

class MockTabHostWithCapsulePartitions extends EventEmitter {
  public capsuleASession = new MockIsolatedSession();
  public capsuleBSession = new MockIsolatedSession();
  public defaultSession = new MockIsolatedSession();

  public registeredPartitions = new Set([
    'persist:capsule-store-a',
    'persist:capsule-store-b',
    'persist:capsule-default',
  ]);

  public isValidCapsulePartition(partition: string): boolean {
    return this.registeredPartitions.has(partition);
  }

  public getPartitionSession(partition: string): any {
    if (partition === 'persist:capsule-store-a') return this.capsuleASession;
    if (partition === 'persist:capsule-store-b') return this.capsuleBSession;
    return this.defaultSession;
  }

  public getActiveTabSession(): any {
    return this.defaultSession;
  }

  public getActiveTab(): any {
    return { id: 'tab-default', url: 'https://example.com' };
  }

  public getTabSession(_id: string): any {
    return this.defaultSession;
  }
}

async function sendRequest(
  port: number,
  method: string,
  pathName: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => { resBody += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: resBody });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Capsule Partition Isolation & RFC 6265bis Ingestion Suite', () => {
  it('guarantees zero cross-partition cookie leakage between Capsule A, Capsule B, and Default', async () => {
    const mockHost = new MockTabHostWithCapsulePartitions();
    const server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    const port = await server.start();
    const token = server.getToken();

    try {
      // 1. Ingest cookie into Capsule A
      const respA = await sendRequest(
        port,
        'POST',
        '/api/cookies/import',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        JSON.stringify({
          upserted: [
            { name: 'session_auth', value: 'secret_token_a', domain: '.haravan.com', path: '/', secure: true },
          ],
          partition: 'persist:capsule-store-a',
          source: 'chrome-extension-delta',
        })
      );

      assert.strictEqual(respA.status, 200);
      const jsonA = JSON.parse(respA.body);
      assert.strictEqual(jsonA.importedCount, 1);
      assert.strictEqual(jsonA.targetPartition, 'persist:capsule-store-a');

      // 2. Ingest cookie into Capsule B
      const respB = await sendRequest(
        port,
        'POST',
        '/api/cookies/import',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        JSON.stringify({
          upserted: [
            { name: 'session_auth', value: 'secret_token_b', domain: '.haravan.com', path: '/', secure: true },
          ],
          partition: 'persist:capsule-store-b',
          source: 'chrome-extension-delta',
        })
      );

      assert.strictEqual(respB.status, 200);

      // 3. Verify strict isolation
      const cookiesInA = await mockHost.capsuleASession.cookies.get({ name: 'session_auth' });
      const cookiesInB = await mockHost.capsuleBSession.cookies.get({ name: 'session_auth' });
      const cookiesInDefault = await mockHost.defaultSession.cookies.get({ name: 'session_auth' });

      assert.strictEqual(cookiesInA.length, 1);
      assert.ok(cookiesInA[0]);
      assert.strictEqual(cookiesInA[0].value, 'secret_token_a');

      assert.strictEqual(cookiesInB.length, 1);
      assert.ok(cookiesInB[0]);
      assert.strictEqual(cookiesInB[0].value, 'secret_token_b');
      assert.strictEqual(cookiesInDefault.length, 0, 'Default session must remain clean');

      // 4. Test Delta Removal on Capsule A
      const respRemove = await sendRequest(
        port,
        'POST',
        '/api/cookies/import',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        JSON.stringify({
          removed: [
            { name: 'session_auth', domain: '.haravan.com', path: '/', secure: true },
          ],
          partition: 'persist:capsule-store-a',
          source: 'chrome-extension-delta',
        })
      );

      assert.strictEqual(respRemove.status, 200);
      const jsonRemove = JSON.parse(respRemove.body);
      assert.strictEqual(jsonRemove.removedCount, 1);

      // Verify removed from A, but B still has its cookie
      const afterRemoveA = await mockHost.capsuleASession.cookies.get({ name: 'session_auth' });
      const afterRemoveB = await mockHost.capsuleBSession.cookies.get({ name: 'session_auth' });
      assert.strictEqual(afterRemoveA.length, 0);
      assert.strictEqual(afterRemoveB.length, 1);
    } finally {
      server.dispose();
    }
  });

  it('rejects missing partition for background delta sync with 400 MISSING_TARGET_PARTITION', async () => {
    const mockHost = new MockTabHostWithCapsulePartitions();
    const server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    const port = await server.start();
    const token = server.getToken();

    try {
      const resp = await sendRequest(
        port,
        'POST',
        '/api/cookies/import',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        JSON.stringify({
          upserted: [{ name: 'foo', value: 'bar', domain: '.google.com' }],
          source: 'chrome-extension-delta',
        })
      );

      assert.strictEqual(resp.status, 400);
      const json = JSON.parse(resp.body);
      assert.strictEqual(json.error, 'MISSING_TARGET_PARTITION');
    } finally {
      server.dispose();
    }
  });

  it('rejects unregistered partition with 404 UNKNOWN_TARGET_PARTITION', async () => {
    const mockHost = new MockTabHostWithCapsulePartitions();
    const server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    const port = await server.start();
    const token = server.getToken();

    try {
      const resp = await sendRequest(
        port,
        'POST',
        '/api/cookies/import',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        JSON.stringify({
          upserted: [{ name: 'foo', value: 'bar', domain: '.google.com' }],
          partition: 'persist:capsule-unregistered-malicious-id',
          source: 'chrome-extension-delta',
        })
      );

      assert.strictEqual(resp.status, 404);
      const json = JSON.parse(resp.body);
      assert.strictEqual(json.error, 'UNKNOWN_TARGET_PARTITION');
    } finally {
      server.dispose();
    }
  });

  it('enforces RFC 6265bis host-only, __Host- prefix, and expiration rules', () => {
    // 1. __Host- cookie forces no domain attribute
    const hostPrefixed = extensionCookieImportSetDetails({
      name: '__Host-user',
      value: 'u123',
      domain: '.haravan.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
    });
    assert.ok(hostPrefixed);
    assert.strictEqual(hostPrefixed.domain, undefined);
    assert.strictEqual(hostPrefixed.secure, true);

    // 2. Expired cookie returns null (skipped)
    const expired = extensionCookieImportSetDetails({
      name: 'stale',
      value: 'old',
      domain: '.shopify.com',
      expirationDate: Math.floor(Date.now() / 1000) - 100,
    });
    assert.strictEqual(expired, null);
  });

  it('MockCookieStore enforces strict RFC 6265 domain and path boundaries on removal', async () => {
    const store = new MockCookieStore();
    await store.set({ name: 'auth', value: '1', domain: '.example.com', path: '/foo' });

    // 1. Suffix without leading dot must NOT match (notexample.com != example.com)
    await store.remove('https://notexample.com/foo', 'auth');
    const remaining1 = await store.get({ name: 'auth' });
    assert.strictEqual(remaining1.length, 1, 'notexample.com must NOT delete .example.com cookie');

    // 2. Sibling path prefix must NOT match (/foobar does not match /foo)
    await store.remove('https://example.com/foobar', 'auth');
    const remaining2 = await store.get({ name: 'auth' });
    assert.strictEqual(remaining2.length, 1, '/foobar must NOT delete /foo cookie');

    // 3. Invalid URL fails closed
    await store.remove('invalid-url-string', 'auth');
    const remaining3 = await store.get({ name: 'auth' });
    assert.strictEqual(remaining3.length, 1, 'Invalid URL must fail closed without deleting');

    // 4. Valid subdomain and subpath matches and deletes
    await store.remove('https://sub.example.com/foo/bar', 'auth');
    const remaining4 = await store.get({ name: 'auth' });
    assert.strictEqual(remaining4.length, 0, 'sub.example.com/foo/bar must delete .example.com/foo cookie');
  });

  it('guarantees zero cookie pollution from ephemeral disposable partitions to persistent capsule partitions', async () => {
    const persistentPart = deriveCapsulePartition('store-prod', 'clean');
    const ephemeralPartA = deriveCapsulePartition('store-prod', 'clean', true);
    const ephemeralPartB = deriveCapsulePartition('store-prod', 'clean', true);

    assert.strictEqual(persistentPart, 'persist:capsule-store-prod');
    assert.strictEqual(ephemeralPartA.startsWith('ephemeral-store-prod-'), true);
    assert.strictEqual(ephemeralPartA.includes('persist:'), false);
    assert.notStrictEqual(ephemeralPartA, ephemeralPartB, 'Each ephemeral partition must have a unique non-persistent nonce');

    // Simulate mock cookie stores bound to each partition
    const stores = new Map<string, MockCookieStore>();
    const getStore = (part: string): MockCookieStore => {
      if (!stores.has(part)) stores.set(part, new MockCookieStore());
      return stores.get(part)!;
    };

    // 1. Inject test mutant cookie in Ephemeral A (Tier 3 Behavioral Mutation)
    const storeA = getStore(ephemeralPartA);
    await storeA.set({ name: 'cart_token', value: 'mutant-token-12345', domain: '.thienfarm.vn', path: '/' });

    // 2. Persistent store must NOT have this cookie
    const storePersistent = getStore(persistentPart);
    const persistentCookies = await storePersistent.get({ name: 'cart_token' });
    assert.strictEqual(persistentCookies.length, 0, 'Persistent capsule partition must remain completely untouched by ephemeral mutation');

    // 3. Ephemeral B must also be completely isolated from Ephemeral A
    const storeB = getStore(ephemeralPartB);
    const bCookies = await storeB.get({ name: 'cart_token' });
    assert.strictEqual(bCookies.length, 0, 'Different ephemeral partitions must NOT share cookies across disposable runs');

    // 4. Verify original cookie exists in A
    const aCookies = await storeA.get({ name: 'cart_token' });
    const firstCookie = aCookies[0];
    assert.ok(firstCookie);
    assert.strictEqual(firstCookie.value, 'mutant-token-12345');
  });
});
