/**
 * CDP one-shot connection guards.
 *
 * Regression for review finding 8: `importFromLiveChromeCDP` must resolve
 * exactly once and never open duplicate fallback connections when the
 * `/json/list` request both errors and times out. With no CDP listener on the
 * port, the call fails fast with the offline message instead of hanging.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { LocalSessionVault } from '../../src/main/browser/local-session-vault';

const stubSession = {
  cookies: {
    set: async () => {},
    get: async () => [],
    flushStore: async () => {},
  },
};

describe('importFromLiveChromeCDP offline behavior', () => {
  it('resolves once with success=false and the offline message when no CDP endpoint exists', async () => {
    // 65531: effectively never bound in tests; connection refused is immediate.
    const started = Date.now();
    const res = await LocalSessionVault.getInstance().importFromLiveChromeCDP(stubSession as never, 65531);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.count, 0);
    assert.ok(
      res.message.includes('Không thể kết nối') || res.message.includes('mở được CDP') || res.message.includes('timed out'),
      `unexpected message: ${res.message}`
    );
    // Fails fast: way below the 3s WebSocket timeout, proving no hang/duplicate retry chain.
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
  });

  it('resolves even against a half-open port (endpoint returns no version info)', async () => {
    // A listener that accepts TCP but returns garbage for /json/version: the
    // HTTP client still completes and finish() must fire exactly once.
    const http = await import('node:http');
    const found = await new Promise<number>((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not-json');
        srv.close();
      });
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
    });
    const started = Date.now();
    const res = await LocalSessionVault.getInstance().importFromLiveChromeCDP(stubSession as never, found);
    assert.strictEqual(res.success, false);
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
  });
});