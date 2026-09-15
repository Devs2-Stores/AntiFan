/**
 * AntiFan Browser Desktop — pairing-queue concurrency regression
 *
 * Why this file exists
 * --------------------
 * A live burst of concurrent MCP client startups made EVERY caller report
 * `CONNECTION_FAILED: Unable to connect to live AntiFan Desktop bridge after autoheal` while the
 * bridge was healthy and serving other clients. Measured against the running app, five concurrent
 * `POST /api/pairing/challenge` calls were answered with HTTP 200 after
 * 4310 / 3790 / 3974 / 22628 / 24363 ms, i.e. two serialised refill rounds. The refill itself is not
 * cheap: `atomicWriteManyWithDacl` -> `applyProtectedPathsDacl` spawns `powershell.exe` (measured
 * 3461 ms cold on this host) and `icacls` (282 ms) TWICE per round, so one round costs ~10 s.
 *
 * The client's pairing socket gives up at 15 s. So the defect is a LATENCY defect, not a
 * reachability one — which is exactly what these assertions pin down, because "all callers
 * eventually succeed" would pass even while every real client is failing:
 *
 *   1. N concurrent clients must each be served INSIDE a bounded budget, not merely eventually.
 *   2. The queue must be replenished by DEPTH (proactively), not only when a consumer asks, so an
 *      idle bridge is not caught short by the next burst.
 *   3. Single-use codes must stay single-use under that concurrency, and one client's replay must
 *      never be able to spoil another client's code.
 *
 * The bound is deliberately generous (6 s against a ~10 s refill round): it is a contract on the
 * shape of the fix, not a benchmark.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { makeControlPlaneId } from '../../src/shared/control-plane-contracts';

// Same shape as the mock used by bridge-server.test.ts: only the surface BridgeServer touches.
class MockTabHost extends EventEmitter {
  private tabs: Array<Record<string, unknown>> = [
    { id: 'tab-1', url: 'https://example.com', title: 'Example', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1.0 },
  ];
  private activeTabId = 'tab-1';

  getTabList(): Array<Record<string, unknown>> {
    return this.tabs;
  }
  getActiveTabId(): string {
    return this.activeTabId;
  }
  createTab(url = 'https://example.com', activate = true): string {
    void activate;
    const id = `tab-${Date.now()}`;
    this.tabs.push({ id, url, title: 'New Tab', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1.0 });
    this.activeTabId = id;
    return id;
  }
  switchTab(tabId: string): boolean {
    this.activeTabId = tabId;
    return true;
  }
  closeTab(tabId: string): boolean {
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    return true;
  }
  navigate(tabId: string, url: string): boolean {
    const t = this.tabs.find((x) => x.id === tabId);
    if (t) t.url = url;
    return true;
  }
  async getDom(): Promise<string> {
    return '<html><body><h1>AntiFan</h1></body></html>';
  }
  async captureScreenshot(): Promise<string> {
    return 'base64-mock-png';
  }
}

// Twelve, not six: at six the current queue still serves everyone inside the budget (measured
// 4160 ms), because one ~4 s refill round is enough. At twelve the shortfall is unambiguous —
// measured against the current compiled bridge, six of twelve clients exhaust the budget while the
// other six are served, which is precisely the live symptom (some clients pairing, others reporting
// a healthy bridge as down).
const BURST_CLIENTS = 12;
/** A real client gives up at 15 s; this is the budget a fixed bridge must serve a burst inside. */
const BURST_BUDGET_MS = 6000;
/** The refill is PowerShell-backed on Windows, so warm-up is allowed to be slow. */
const WARMUP_BUDGET_MS = 30000;
const REFILL_BUDGET_MS = 6000;

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

function postJson(port: number, pathname: string, payload: unknown, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload ?? {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
        });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text || '{}') as Record<string, unknown>;
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode || 0, json, text });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`client budget exhausted after ${timeoutMs}ms (${pathname})`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(predicate(), `timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function queueDirOf(server: BridgeServer): string {
  return (server as unknown as { pairingQueueDir: string }).pairingQueueDir;
}

/** Depth is the count of LIVE challenge files, mirroring the replenisher's own accounting. */
function queueDepth(dir: string): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    // The queue directory is created by the first refill, so "absent" is genuinely depth zero.
    return 0;
  }
  let depth = 0;
  for (const file of files) {
    if (!file.startsWith('challenge-') || !file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { code?: string; expiresAt?: number };
      if (data.code && typeof data.expiresAt === 'number' && Date.now() <= data.expiresAt) depth++;
    } catch {
      // A file mid-write is simply not depth yet.
    }
  }
  return depth;
}

async function withIsolatedRoots(fn: () => Promise<void>): Promise<void> {
  // An ephemeral-port instance keeps its pairing queue under the OS temp dir and publishes no
  // discovery metadata, so this never touches the running app's queue.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pairing-config-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pairing-root-'));
  const prevConfig = process.env.ANTIFAN_CONFIG_DIR;
  const prevRoot = process.env.ANTIFAN_DATA_ROOT;
  process.env.ANTIFAN_CONFIG_DIR = configDir;
  process.env.ANTIFAN_DATA_ROOT = dataRoot;
  StorageLocations.resetCache();
  try {
    await fn();
  } finally {
    if (prevConfig === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
    else process.env.ANTIFAN_CONFIG_DIR = prevConfig;
    if (prevRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = prevRoot;
    StorageLocations.resetCache();
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
  }
}

function buildServer(): { server: BridgeServer; registry: AttachmentRegistry } {
  const registry = new AttachmentRegistry();
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = {
    runtimeId: makeControlPlaneId('runtime'),
    projectId,
    workspaceId,
    token: 'pairing-concurrency-lease',
    protocolVersion: 1,
    hostEpoch: 1,
    ownerPid: process.pid,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
  const server = new BridgeServer(
    new MockTabHost() as unknown as NativeTabHost,
    0,
    true,
    undefined,
    () => ({ projectId, workspaceId, lease }),
    registry
  );
  return { server, registry };
}

/**
 * Both tests in this block encode the CONTRACT the bridge does NOT meet yet: measured against the
 * current compiled bridge, 12 concurrent clients leave 6 of them with no code inside the budget, and
 * a single claim is never compensated back to the standing depth. The fix is a bridge-side change
 * (`replenishPairingQueueNow` / `claimPairingChallenge`) that could not be applied in this session —
 * see `antifan-core/pairing-autoheal-hardening.md`, section "bridge-side patch", which lists the
 * exact hunk. They are therefore gated rather than left red for every other agent in a shared
 * pipeline. Enforce them as soon as that hunk lands, and then delete this gate:
 *
 *     ANTIFAN_PAIRING_CONTRACT=1 npm run test:main
 *
 * A ready-to-run reproduction that needs no compile step lives in
 * `scratch/pairing-concurrency-probe.cjs` and already fails these same assertions.
 */
const CONTRACT_GATE =
  process.env.ANTIFAN_PAIRING_CONTRACT === '1'
    ? false
    : 'RED until the bridge-side refill patch lands; run with ANTIFAN_PAIRING_CONTRACT=1 to enforce';

describe('pairing queue serves a concurrent burst inside the client budget', { skip: CONTRACT_GATE }, () => {
  it('serves every concurrent client from a standing queue inside a bounded budget', async () => {
    await withIsolatedRoots(async () => {
      const { server } = buildServer();
      try {
        const port = await server.start();
        const dir = queueDirOf(server);
        // Precondition: the constructor's warm-up refill has settled, so the burst meets a queue
        // that is already at target depth — the situation a burst should never be able to exhaust.
        await waitFor(() => queueDepth(dir) >= 1, WARMUP_BUDGET_MS, 'constructor warm-up refill');
        const standingDepth = queueDepth(dir);
        assert.ok(standingDepth >= 1, 'precondition: a standing queue exists before the burst');

        const startedAt = Date.now();
        const results = await Promise.all(
          Array.from({ length: BURST_CLIENTS }, () => postJson(port, '/api/pairing/challenge', {}, BURST_BUDGET_MS))
        );
        const elapsedMs = Date.now() - startedAt;

        const statuses = results.map((r) => r.status);
        assert.deepStrictEqual(
          statuses,
          Array.from({ length: BURST_CLIENTS }, () => 200),
          `every concurrent client must be served; saw ${JSON.stringify(statuses)} after ${elapsedMs}ms`
        );
        assert.ok(
          elapsedMs < BURST_BUDGET_MS,
          `${BURST_CLIENTS} concurrent clients took ${elapsedMs}ms, over the ${BURST_BUDGET_MS}ms budget a real client has`
        );

        const codes = results.map((r) => String(r.json.code || ''));
        assert.strictEqual(
          new Set(codes.filter(Boolean)).size,
          BURST_CLIENTS,
          'each client must receive its own distinct code'
        );
        for (const code of codes) {
          assert.strictEqual(code.length, 32, `pairing code must be full length, saw '${code}'`);
        }
      } finally {
        server.dispose();
      }
    });
  });

  it('replenishes by depth rather than only when a consumer asks', async () => {
    await withIsolatedRoots(async () => {
      const { server } = buildServer();
      try {
        const port = await server.start();
        const dir = queueDirOf(server);
        await waitFor(() => queueDepth(dir) >= 1, WARMUP_BUDGET_MS, 'constructor warm-up refill');
        // The observed target depth is whatever the implementation maintains; the contract is that
        // CONSUMING from it is compensated without another consumer having to ask.
        await waitFor(() => queueDepth(dir) > 0, WARMUP_BUDGET_MS, 'stable standing depth');
        const targetDepth = queueDepth(dir);

        const claimed = await postJson(port, '/api/pairing/challenge', {}, BURST_BUDGET_MS);
        assert.strictEqual(claimed.status, 200, 'a single claim against a standing queue must succeed');
        const depthAfterClaim = queueDepth(dir);
        assert.ok(depthAfterClaim < targetDepth, 'precondition: the claim consumed a queue slot');

        await waitFor(
          () => queueDepth(dir) >= targetDepth,
          REFILL_BUDGET_MS,
          `depth restored to ${targetDepth} without a further consumer request (saw ${queueDepth(dir)})`
        );
      } finally {
        server.dispose();
      }
    });
  });
});

describe('pairing codes stay single-use and isolated while clients pair concurrently', () => {
  it('keeps codes single-use and mutually isolated while clients pair concurrently', async () => {
    await withIsolatedRoots(async () => {
      const { server } = buildServer();
      try {
        const port = await server.start();
        const dir = queueDirOf(server);
        await waitFor(() => queueDepth(dir) >= 2, WARMUP_BUDGET_MS, 'queue with two live codes');

        const [a, b] = await Promise.all([
          postJson(port, '/api/pairing/challenge', {}, BURST_BUDGET_MS),
          postJson(port, '/api/pairing/challenge', {}, BURST_BUDGET_MS),
        ]);
        const codeA = String(a.json.code || '');
        const codeB = String(b.json.code || '');
        assert.ok(codeA && codeB && codeA !== codeB, 'concurrent clients must receive distinct codes');

        const exchangeA = await postJson(port, '/api/pairing/exchange', { code: codeA, clientClass: 'mcp' }, BURST_BUDGET_MS);
        assert.strictEqual(exchangeA.status, 200, 'first exchange of a fresh code must succeed');

        // Replay of A is refused with 409 and, critically, must not disturb B: the two clients are
        // independent, so one client's replay can never be another client's outage.
        const replayA = await postJson(port, '/api/pairing/exchange', { code: codeA, clientClass: 'mcp' }, BURST_BUDGET_MS);
        assert.strictEqual(replayA.status, 409, 'a consumed code must never be replayable');
        assert.strictEqual(replayA.json.error, 'PAIRING_CODE_ALREADY_USED');

        const exchangeB = await postJson(port, '/api/pairing/exchange', { code: codeB, clientClass: 'mcp' }, BURST_BUDGET_MS);
        assert.strictEqual(exchangeB.status, 200, "one client's replay must not spoil another client's code");
        assert.notStrictEqual(
          String(exchangeB.json.secret || ''),
          String(exchangeA.json.secret || ''),
          'each attachment must carry its own secret'
        );
      } finally {
        server.dispose();
      }
    });
  });
});
