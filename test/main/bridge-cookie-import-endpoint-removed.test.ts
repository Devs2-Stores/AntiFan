/**
 * The legacy delta-sync HTTP surface is gone.
 *
 * Regression for review finding 7: `/api/cookies/import` was removed as part
 * of eliminating the extension delta architecture. A POST must now answer 404
 * (unknown route) and MUST NOT mutate any session — the stub host's cookie
 * write counter must stay at zero even though the payload looks like a
 * legitimate import request. The preflight is a generic 204, not an
 * import-specific origin gate (the route has no CORS boundary of its own).
 *
 * Servers are torn down with BridgeServer.dispose() (closes WSS + HTTP) so
 * no listener leaks keep the node --test child process alive.
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
}

function requestHttp(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => (resBody += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: resBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Bridge cookie import endpoint removal', () => {
  it('POST /api/cookies/import answers 404 and mutates no session', async () => {
    const host = new StubHost();
    // Session accessor: any writer path would land here and bump the counter.
    (host as unknown as { getSessionForTarget?: unknown }).getSessionForTarget = () => ({
      cookies: {
        set: async () => {
          host.cookieWriteCalls += 1;
          return {};
        },
        get: async () => {
          host.cookieReadCalls += 1;
          return [];
        },
      },
    });
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(
        port,
        'POST',
        '/api/cookies/import',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ cookies: [{ name: 'SID', value: 'v', domain: '.example.com' }] })
      );
      assert.strictEqual(res.status, 404, 'removed endpoint must 404, not ingest');
      assert.strictEqual(host.cookieWriteCalls, 0, 'removed route must never write cookies');
      assert.strictEqual(host.cookieReadCalls, 0, 'removed route must never read cookies either');
    } finally {
      server.dispose();
    }
  });

  it('OPTIONS preflight for the removed route is a generic 204 (no import-specific origin gate)', async () => {
    const host = new StubHost();
    const server = new BridgeServer(host as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(port, 'OPTIONS', '/api/cookies/import', { Origin: 'http://localhost:8080' });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(host.cookieWriteCalls, 0);
    } finally {
      server.dispose();
    }
  });
});