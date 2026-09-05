/**
 * The legacy delta-sync HTTP surface is gone.
 *
 * Regression for review finding 7: `/api/cookies/import` was removed as part
 * of eliminating the extension delta architecture. A POST must now answer 404
 * (unknown route), never perform cookie ingestion.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';

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

async function stopServer(server: BridgeServer): Promise<void> {
  // Close the listening HTTP server so the test child process can exit
  // (an open server keeps the event loop alive and node --test hangs).
  const httpServer = (server as unknown as { httpServer?: http.Server }).httpServer;
  if (!httpServer) return;
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections?.();
  });
}

describe('Bridge cookie import endpoint removal', () => {
  it('POST /api/cookies/import answers 404 (route removed)', async () => {
    // Minimal host: the removed route never reaches tabHost; an EventEmitter
    // satisfies wireTabHostEvents() listeners.
    const server = new BridgeServer(new EventEmitter() as never, 0);
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
    } finally {
      await stopServer(server);
    }
  });

  it('OPTIONS preflight for the removed route is a generic 204 (no import-specific origin gate)', async () => {
    const server = new BridgeServer(new EventEmitter() as never, 0);
    const port = await server.start();
    try {
      const res = await requestHttp(port, 'OPTIONS', '/api/cookies/import', { Origin: 'http://localhost:8080' });
      assert.strictEqual(res.status, 204);
    } finally {
      await stopServer(server);
    }
  });
});