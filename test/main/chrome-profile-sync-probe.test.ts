import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';

/**
 * `probeCdpReachable` is the gate in front of the one-shot cookie hydration: it decides whether
 * the app-owned headless Chrome's DevTools endpoint is really answering before the CDP WS import
 * runs. Its retry deadline is consulted BETWEEN attempts, so an attempt that never settles takes
 * the whole probe with it — the caller then waits forever for a cookie import that can neither
 * succeed nor fail.
 *
 * The case below is measured on this platform: a response torn down mid-body answers NOTHING —
 * no `end` on the response, no `error` on the request, and no socket timeout, because the socket
 * was destroyed rather than idle.
 */
type ProbeSurface = {
  probeCdpReachable(port: number, timeoutMs: number): Promise<boolean>;
};

function probe(): ProbeSurface {
  return ChromeProfileSyncManager.getInstance() as unknown as ProbeSurface;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('ChromeProfileSyncManager CDP probe — an answer that never arrives', () => {
  it('reports the endpoint as unreachable when the reply is torn down mid-body', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"Browser":"Chrome"'); // headers plus a partial body only — no 'end', ever
      setTimeout(() => res.socket?.destroy(), 40);
    });
    try {
      const startedAt = Date.now();
      const reachable = await probe().probeCdpReachable(port, 1_500);
      const elapsed = Date.now() - startedAt;
      assert.equal(reachable, false, 'a torn-down body is not a reachable endpoint');
      assert.ok(elapsed < 3_000, `the probe must return inside its own budget, took ${elapsed}ms`);
    } finally {
      await close(server);
    }
  });

  it('still reports an endpoint that really answers as reachable', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"Browser":"Chrome","Protocol-Version":"1.3"}');
    });
    try {
      const startedAt = Date.now();
      assert.equal(await probe().probeCdpReachable(port, 1_500), true);
      assert.ok(Date.now() - startedAt < 1_000, 'a real answer must not wait for the retry loop');
    } finally {
      await close(server);
    }
  });

  it('reports a closed port as unreachable instead of waiting for it', async () => {
    const { server, port } = await listen((_req, res) => res.end('{}'));
    await close(server); // the port is now refusing connections
    const startedAt = Date.now();
    assert.equal(await probe().probeCdpReachable(port, 1_500), false);
    assert.ok(Date.now() - startedAt < 3_000, 'a refusing port must not hold the probe open');
  });
});
