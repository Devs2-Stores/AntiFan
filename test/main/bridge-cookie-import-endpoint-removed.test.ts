/**
 * Bridge cookie import & extension handshake endpoints.
 *
 * Verifies the Companion Extension endpoints:
 * 1. GET /api/extension/handshake is removed (returns 404); tokens are issued exclusively via Chromium Native Messaging.
 * 2. POST /api/cookies/import requires authentication (401 without token, mutates no session).
 * 3. POST /api/cookies/import enforces origin gate (403 for unauthorized cross-origin).
 * 4. POST /api/cookies/import with token successfully writes cookies to target session.
 * 5. OPTIONS preflight respects chrome-extension:// origins.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';

/** EventEmitter stand-in for NativeTabHost that records cookie writes. */
class StubHost extends EventEmitter {
  public cookieWriteCalls = 0;
  public cookieReadCalls = 0;
  public sessionAccessorCalls = {
    getActiveTabSession: 0,
    getTabSession: 0,
    getPartitionSession: 0,
  };
  public getActiveCapsule(): { id: string } | null {
    return { id: 'default-capsule' };
  }
  public getActiveTab(): { id: string } | null {
    return null;
  }
  public getActiveTabId(): string | null {
    return null;
  }
  public getTabList(): any[] {
    return [];
  }
  public getSharedProfilePartition(): string {
    return 'persist:profile-default';
  }
  public isValidCapsulePartition(): boolean {
    return true;
  }
  private readonly session = {
    cookies: {
      set: async () => {
        this.cookieWriteCalls += 1;
        return {};
      },
      get: async () => {
        this.cookieReadCalls += 1;
        return [];
      },
      flushStore: async () => {},
    },
  };
  public getActiveTabSession(): typeof this.session {
    this.sessionAccessorCalls.getActiveTabSession += 1;
    return this.session;
  }
  public getTabSession(): typeof this.session {
    this.sessionAccessorCalls.getTabSession += 1;
    return this.session;
  }
  public getPartitionSession(): typeof this.session {
    this.sessionAccessorCalls.getPartitionSession += 1;
    return this.session;
  }
}

function requestHttp(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (body) {
      finalHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: finalHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Bridge cookie import & companion extension endpoints', () => {
  const OFFICIAL_ORIGIN = 'chrome-extension://khjcaadjohoclofjkkfblkbfbpmjjedp';

  it('GET /api/extension/handshake is removed (returns 404) to prevent unauthenticated token theft', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(port, 'GET', '/api/extension/handshake', {
        Origin: OFFICIAL_ORIGIN,
      });
      assert.strictEqual(res.status, 404, 'unauthenticated handshake endpoint must not exist');
    } finally {
      server.dispose();
    }
  });
  it('GET /status without token or with invalid token returns 401 to prevent unauthenticated validation', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const noTokenRes = await requestHttp(port, 'GET', '/status');
      assert.strictEqual(noTokenRes.status, 401, 'unauthenticated status probe must be rejected with 401');

      const badTokenRes = await requestHttp(port, 'GET', '/status?token=fake-or-stale-token-12345');
      assert.strictEqual(badTokenRes.status, 401, 'status probe with invalid token must be rejected with 401');
    } finally {
      server.dispose();
    }
  });

  it('GET /status with valid bridge token returns 200 OK with server status payload', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const validRes = await requestHttp(port, 'GET', `/status?token=${server.getToken()}`);
      assert.strictEqual(validRes.status, 200, 'authenticated status probe must return 200');
      const payload = JSON.parse(validRes.body);
      assert.strictEqual(payload.active, true);
      assert.strictEqual(payload.port, port);
    } finally {
      server.dispose();
    }
  });

  it('POST /api/cookies/import without token returns 401 and mutates no session', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(
        port,
        'POST',
        '/api/cookies/import',
        { 'Content-Type': 'application/json', Origin: OFFICIAL_ORIGIN },
        JSON.stringify({ cookies: [{ name: 'SID', value: 'secret123', domain: '.example.com' }] })
      );
      assert.strictEqual(res.status, 401, 'unauthenticated import must return 401');
      assert.strictEqual(host.cookieWriteCalls, 0, 'must not write cookies without token');
      assert.deepStrictEqual(host.sessionAccessorCalls, { getActiveTabSession: 0, getTabSession: 0, getPartitionSession: 0 });
    } finally {
      server.dispose();
    }
  });

  it('POST /api/cookies/import rejects unauthorized cross-origin with 403', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(
        port,
        'POST',
        `/api/cookies/import?token=${server.getToken()}`,
        { 'Content-Type': 'application/json', Origin: 'https://malicious-site.com' },
        JSON.stringify({ cookies: [{ name: 'SID', value: 'secret123', domain: '.example.com' }] })
      );
      assert.strictEqual(res.status, 403, 'cross-origin import from non-whitelisted origin must return 403');
      assert.strictEqual(host.cookieWriteCalls, 0);
    } finally {
      server.dispose();
    }
  });

  it('POST /api/cookies/import with valid token imports cookies into target session', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(
        port,
        'POST',
        `/api/cookies/import?token=${server.getToken()}`,
        {
          'Content-Type': 'application/json',
          Origin: OFFICIAL_ORIGIN,
        },
        JSON.stringify({
          cookies: [
            { name: 'session_id', value: 'live-value-123', domain: 'example.com', path: '/' },
            { name: 'auth_token', value: 'jwt-abc', domain: '.example.com', path: '/' },
          ],
        })
      );
      assert.strictEqual(res.status, 200);
      const result = JSON.parse(res.body);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.importedCount, 2);
      assert.strictEqual(host.cookieWriteCalls, 2);
      assert.strictEqual(host.sessionAccessorCalls.getActiveTabSession, 1);
    } finally {
      server.dispose();
    }
  });

  it('OPTIONS preflight allows authorized companion origin and blocks unauthorized', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      // Authorized
      const resOk = await requestHttp(port, 'OPTIONS', '/api/cookies/import', { Origin: OFFICIAL_ORIGIN });
      assert.strictEqual(resOk.status, 204);
      assert.strictEqual(resOk.headers['access-control-allow-origin'], OFFICIAL_ORIGIN);
      assert.strictEqual(host.cookieWriteCalls, 0);

      // Unauthorized
      const resBad = await requestHttp(port, 'OPTIONS', '/api/cookies/import', { Origin: 'chrome-extension://unauthorizedrandomid123' });
      assert.strictEqual(resBad.status, 403);
    } finally {
      server.dispose();
    }
  });
});