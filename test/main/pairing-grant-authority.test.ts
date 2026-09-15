/**
 * Regression coverage for the Core authorization fix in `/api/pairing/exchange`.
 *
 * THE BUG THIS PINS
 * -----------------
 * The exchange used to compute the session's authority as
 *   `requestedGrant || record.requestedGrantCeiling || 'write'`
 * while the bridge minted every MCP pairing challenge with NO `requestedGrantCeiling`
 * (bridge-server.ts, `issuePairingCode({ clientClass: 'mcp', ttlMs: 600_000 })`) and both
 * MCP clients omitted `requestedGrant` from their exchange body. Every MCP session was
 * therefore minted with `grant='write'`, and `capability-catalogue.isVisible()` has
 *   `if (grant === 'write') return definition.risk === 'write';`
 * so each `eval`-risk capability (`anti.browser.evaluate`, `anti.browser.evaluate_frame`,
 * `anti.inspect.eval`) was INVISIBLE and refused with POLICY_DENIED even though the app
 * runs with `--allow-eval` (`allowEval === true`). Live symptom:
 *   POLICY_DENIED: Capability anti.browser.evaluate is not enabled by the current policy
 *   (capabilityRisk=eval, sessionGrant=write, allowEval=true, runtimeMode=standalone).
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * A. The exchange honours a declared `requestedGrant`, keeps the fail-closed `'write'`
 *    default when none is declared, reports WHERE the grant came from (`grantSource`),
 *    warns on the silent default, honours an operator ceiling, and refuses an unknown or
 *    non-string grant by name instead of minting an unusable session.
 * B. The two pairing clients (`scripts/antifan-agent.cjs`, `scripts/antifan-omp-mcp.cjs`)
 *    declare the grant they need and surface a downgrade instead of failing later with a
 *    POLICY_DENIED that reads like an --allow-eval problem.
 * C. The capability-policy consequence: with a pairing-issued `eval` grant and
 *    `allowEval: true` in `standalone` mode an eval-risk capability is VISIBLE and
 *    dispatchable end-to-end; with the fail-closed `write` grant it is refused with a
 *    POLICY_DENIED that names the risk, the grant, `allowEval` and the runtime mode.
 *
 * Nothing in this file edits product code: it only exercises the behaviour the fix
 * defines, through the same fixtures the neighbouring suites use.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  type BrowserTarget,
  type RuntimeLease,
} from '../../src/shared/control-plane-contracts';

// ── Repository root ────────────────────────────────────────────────────────────
// Tests normally run from `.compiled/test/main`, so the root is found by walking up.
// A targeted compile into a scratch directory outside the repo is also supported.
const REPO_ROOT = ((): string => {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'antifan-agent.cjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = process.env.ANTIFAN_TEST_REPO_ROOT || 'E:\\Work\\apps\\AntiFan';
  if (fs.existsSync(path.join(fallback, 'scripts', 'antifan-agent.cjs'))) return fallback;
  throw new Error(`pairing-grant-authority: could not locate the AntiFan repository root from '${__dirname}'`);
})();

const AGENT_LAUNCHER = path.join(REPO_ROOT, 'scripts', 'antifan-agent.cjs');
const OMP_MCP = path.join(REPO_ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const EVAL_RISK_CAPABILITIES = ['anti.browser.evaluate', 'anti.browser.evaluate_frame', 'anti.inspect.eval'];

// ── Shared fixtures (same shape as test/main/bridge-server.test.ts) ────────────
class MockTabHost extends EventEmitter {
  private tabs: Array<Record<string, unknown>> = [
    { id: 'tab-1', url: 'https://example.com', title: 'Example', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1.0 },
  ];
  getTabList() { return this.tabs; }
  getActiveTabId() { return 'tab-1'; }
  hasTab(tabId?: string | null) { return tabId === 'tab-1'; }
  resolveTargetTabId(tabId?: string | null) { return tabId === 'tab-1' ? 'tab-1' : undefined; }
  isTabAllowed(bound: string, requested: string) { return bound === requested; }
  getDocumentGeneration() { return 1; }
  createTab(url = 'about:blank') {
    const id = `tab-${this.tabs.length + 1}`;
    this.tabs.push({ id, url, title: 'New Tab' });
    return id;
  }
  switchTab() { return true; }
  closeTab(tabId: string) { this.tabs = this.tabs.filter((t) => t.id !== tabId); return true; }
  navigate() { return true; }
  toggleInspect() { return true; }
  toggleSidebar() { return true; }
  async getDom() { return '<html><body><h1>AntiFan</h1></body></html>'; }
  async captureScreenshot() { return 'base64-mock-png'; }
}

/** Isolated config/data roots so a test run never touches the live app's stores. */
async function withIsolatedRoots(fn: () => Promise<void> | void): Promise<void> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-grant-config-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-grant-root-'));
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

interface ExchangeResult { status: number; body: Record<string, unknown>; }

async function postExchange(port: number, payload: Record<string, unknown>): Promise<ExchangeResult> {
  const res = await fetch(`http://127.0.0.1:${port}/api/pairing/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

interface BridgeFixture {
  server: BridgeServer;
  registry: AttachmentRegistry;
  port: number;
  projectId: string;
  workspaceId: string;
  lease: RuntimeLease;
  browserTarget: BrowserTarget;
  dispose(): void;
}

async function startBridge(): Promise<BridgeFixture> {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
  const browserTarget: BrowserTarget = {
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };
  const registry = new AttachmentRegistry();
  const server = new BridgeServer(
    new MockTabHost() as unknown as NativeTabHost,
    0,
    false,
    undefined,
    () => ({ lease, projectId, workspaceId, browserTarget }),
    registry
  );
  const port = await server.start();
  return { server, registry, port, projectId, workspaceId, lease, browserTarget, dispose: () => server.dispose() };
}

/** Claims a pairing code the way both MCP clients do: from the bridge's own challenge. */
async function claimChallengeCode(server: BridgeServer): Promise<string> {
  const challenge = await server.claimPairingChallenge('mcp');
  assert.ok(challenge?.code, 'precondition: the bridge must issue an MCP pairing challenge');
  return challenge.code;
}

interface RpcResponse { id: string; success: boolean; data?: Record<string, unknown>; error?: string; }

async function dispatchOverSocket(
  port: number,
  secret: string,
  request: { id: string; name: string; params: Record<string, unknown>; attachmentId: string; authorityRevision: string }
): Promise<RpcResponse> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-antifan-attachment-secret': secret } });
  const opened = new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await opened;
  try {
    return await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dispatch '${request.name}' timed out`)), 15_000);
      const handler = (raw: string | Buffer) => {
        const resp = JSON.parse(raw.toString()) as RpcResponse;
        if (resp.id === request.id) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(resp);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({
        id: request.id,
        method: 'antifan.capability.dispatch',
        params: {
          name: request.name,
          params: request.params,
          attachmentId: request.attachmentId,
          attachmentSecret: secret,
          authorityRevision: request.authorityRevision,
          idempotencyKey: `idem-${request.id}-${Date.now()}`,
        },
      }));
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

// ── A. /api/pairing/exchange grant authority ───────────────────────────────────
describe('Pairing exchange grant authority', () => {
  it("mints an 'eval' attachment and reports grantSource='requested' when the client declares requestedGrant", async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        // The bridge's own challenge carries no requestedGrantCeiling — exactly the
        // condition under which the pre-fix exchange silently fell back to 'write'.
        const code = await claimChallengeCode(fixture.server);
        const { status, body } = await postExchange(fixture.port, { code, clientClass: 'mcp', requestedGrant: 'eval' });

        assert.strictEqual(status, 200, `declared eval grant must be accepted: ${JSON.stringify(body)}`);
        assert.strictEqual(body.grant, 'eval');
        assert.strictEqual(body.grantSource, 'requested');

        const record = fixture.registry.getRecord(String(body.attachmentId));
        assert.ok(record, 'the exchange must register the attachment it mints');
        assert.strictEqual(record?.grant, 'eval', "the issued attachment itself must carry grant 'eval', not just the response body");
      } finally {
        fixture.dispose();
      }
    });
  });

  it("keeps the fail-closed 'write' default, reports grantSource='default' and warns when requestedGrant is omitted", async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      const warns: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg?: unknown, ...rest: unknown[]) => { warns.push([msg, ...rest].map(String).join(' ')); };
      try {
        const code = await claimChallengeCode(fixture.server);
        const { status, body } = await postExchange(fixture.port, { code, clientClass: 'mcp' });

        assert.strictEqual(status, 200);
        assert.strictEqual(body.grant, 'write', 'omitting requestedGrant must stay fail-closed');
        assert.strictEqual(body.grantSource, 'default');

        const record = fixture.registry.getRecord(String(body.attachmentId));
        assert.strictEqual(record?.grant, 'write');

        assert.ok(
          warns.some((w) => w.includes('requestedGrant') && w.includes('POLICY_DENIED')),
          `the silent default must be logged loudly, got: ${JSON.stringify(warns)}`
        );
      } finally {
        console.warn = originalWarn;
        fixture.dispose();
      }
    });
  });

  it("inherits the operator ceiling and reports grantSource='ceiling' when the client declares nothing", async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        const issued = fixture.server.issuePairingCode({ clientClass: 'mcp', requestedGrantCeiling: 'execute' });
        const { status, body } = await postExchange(fixture.port, { code: issued.code, clientClass: 'mcp' });

        assert.strictEqual(status, 200);
        assert.strictEqual(body.grant, 'execute');
        assert.strictEqual(body.grantSource, 'ceiling');

        const record = fixture.registry.getRecord(String(body.attachmentId));
        assert.strictEqual(record?.grant, 'execute');
      } finally {
        fixture.dispose();
      }
    });
  });

  it('refuses a request that exceeds the operator ceiling with PAIRING_GRANT_CEILING_EXCEEDED and mints nothing', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        const refusedCode = fixture.server.issuePairingCode({ clientClass: 'mcp', requestedGrantCeiling: 'write' }).code;
        const refused = await postExchange(fixture.port, { code: refusedCode, clientClass: 'mcp', requestedGrant: 'eval' });

        assert.strictEqual(refused.status, 403, `an over-ceiling request must be refused: ${JSON.stringify(refused.body)}`);
        assert.strictEqual(refused.body.error, 'PAIRING_GRANT_CEILING_EXCEEDED');
        assert.strictEqual(
          fixture.registry.getActiveRecordIds().size,
          0,
          'a refused exchange must not leave an attachment behind'
        );

        // The same ceiling still admits a request that does not exceed it.
        const allowedCode = fixture.server.issuePairingCode({ clientClass: 'mcp', requestedGrantCeiling: 'write' }).code;
        const allowed = await postExchange(fixture.port, { code: allowedCode, clientClass: 'mcp', requestedGrant: 'write' });
        assert.strictEqual(allowed.status, 200);
        assert.strictEqual(allowed.body.grant, 'write');
        assert.strictEqual(allowed.body.grantSource, 'requested');
      } finally {
        fixture.dispose();
      }
    });
  });

  it('refuses an unknown or non-string requestedGrant with HTTP 400 PAIRING_GRANT_UNKNOWN', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        const badGrants: unknown[] = ['superuser', 'EVAL', 123, {}, null, true, ['eval']];
        for (const bad of badGrants) {
          const code = fixture.server.issuePairingCode({ clientClass: 'mcp' }).code;
          const { status, body } = await postExchange(fixture.port, { code, clientClass: 'mcp', requestedGrant: bad });
          assert.strictEqual(status, 400, `requestedGrant=${JSON.stringify(bad)} must be refused by name, got ${status} ${JSON.stringify(body)}`);
          assert.strictEqual(body.error, 'PAIRING_GRANT_UNKNOWN');
        }
        assert.strictEqual(
          fixture.registry.getActiveRecordIds().size,
          0,
          'an unknown grant must never mint an attachment whose capabilities are all invisible'
        );
      } finally {
        fixture.dispose();
      }
    });
  });
});

// ── B. Pairing client contracts ────────────────────────────────────────────────
describe('Pairing client grant contracts', () => {
  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  it('scripts/antifan-agent.cjs declares requestedGrant and the bridge mints the eval attachment it asked for', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      const previousGrant = process.env.ANTIFAN_SESSION_GRANT;
      delete process.env.ANTIFAN_SESSION_GRANT;
      try {
        const launcher = require(AGENT_LAUNCHER) as {
          performPairingExchange(host: string, port: number): Promise<Record<string, unknown>>;
        };
        const exchange = await launcher.performPairingExchange('127.0.0.1', fixture.port);

        assert.strictEqual(exchange.success, true, `client pairing failed: ${JSON.stringify(exchange)}`);
        assert.strictEqual(
          exchange.grant,
          'eval',
          "the launcher's default session grant must reach the bridge (pre-fix it sent no requestedGrant, so the bridge answered 'write')"
        );
        assert.strictEqual(exchange.grantSource, 'requested');

        const record = fixture.registry.getRecord(String(exchange.attachmentId));
        assert.ok(record, 'the client pairing must have minted an attachment');
        assert.strictEqual(record?.grant, 'eval');
      } finally {
        restoreEnv('ANTIFAN_SESSION_GRANT', previousGrant);
        fixture.dispose();
      }
    });
  });

  it('scripts/antifan-agent.cjs honours ANTIFAN_SESSION_GRANT instead of always asking for eval', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      const previousGrant = process.env.ANTIFAN_SESSION_GRANT;
      process.env.ANTIFAN_SESSION_GRANT = 'read';
      try {
        const launcher = require(AGENT_LAUNCHER) as {
          performPairingExchange(host: string, port: number): Promise<Record<string, unknown>>;
        };
        const exchange = await launcher.performPairingExchange('127.0.0.1', fixture.port);

        assert.strictEqual(exchange.success, true);
        assert.strictEqual(exchange.grant, 'read');
        assert.strictEqual(exchange.grantSource, 'requested');
      } finally {
        restoreEnv('ANTIFAN_SESSION_GRANT', previousGrant);
        fixture.dispose();
      }
    });
  });

  it('scripts/antifan-agent.cjs sends requestedGrant on the wire and reports ANTIFAN_GRANT_DOWNGRADED on a weaker answer', async () => {
    const received: Array<{ path: string; payload: Record<string, unknown> }> = [];
    const stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(raw || '{}') as Record<string, unknown>; } catch {}
        received.push({ path: req.url || '', payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if ((req.url || '').endsWith('/challenge')) {
          res.end(JSON.stringify({ success: true, code: 'stub-pairing-code' }));
        } else {
          // A bridge that grants less than the client asked for: the client must say so.
          res.end(JSON.stringify({ success: true, secret: 'stub-secret', grant: 'write', grantSource: 'ceiling' }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(0, '127.0.0.1', () => resolve());
    });
    const address = stub.address();
    const stubPort = address && typeof address === 'object' ? address.port : 0;
    assert.ok(stubPort > 0, 'stub bridge must be listening on a TCP port');

    const previousGrant = process.env.ANTIFAN_SESSION_GRANT;
    delete process.env.ANTIFAN_SESSION_GRANT;
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const launcher = require(AGENT_LAUNCHER) as {
        performPairingExchange(host: string, port: number): Promise<Record<string, unknown>>;
      };
      const exchange = await launcher.performPairingExchange('127.0.0.1', stubPort);

      const exchangeCall = received.find((r) => r.path.endsWith('/exchange'));
      assert.ok(exchangeCall, 'the client must POST /api/pairing/exchange');
      assert.strictEqual(
        exchangeCall?.payload.requestedGrant,
        'eval',
        "the exchange body must declare requestedGrant (pre-fix no client sent this key at all)"
      );
      assert.strictEqual(exchange.grant, 'write', 'the stub bridge answered with a weaker grant');
      assert.ok(
        stderrChunks.some((chunk) => chunk.includes('ANTIFAN_GRANT_DOWNGRADED')),
        `a silent downgrade must be announced on stderr, got: ${JSON.stringify(stderrChunks)}`
      );
      assert.ok(
        stderrChunks.some((chunk) => chunk.includes("'eval'") && chunk.includes("'write'")),
        'the downgrade notice must name both the requested and the granted grant'
      );
    } finally {
      process.stderr.write = originalWrite;
      restoreEnv('ANTIFAN_SESSION_GRANT', previousGrant);
      try { stub.close(); } catch {}
    }
  });

  it("scripts/antifan-omp-mcp.cjs performs the same pairing exchange and lands an 'eval' attachment", async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      const previousGrant = process.env.ANTIFAN_SESSION_GRANT;
      delete process.env.ANTIFAN_SESSION_GRANT;
      try {
        // The MCP proxy exports no pairing helper, so its own module scope is executed
        // in a child process (where its stdio/MCP side effects are harmless) and the
        // helper is reached through the module cache entry for the real script path.
        const childScript = [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const Module = require('node:module');",
          'const target = process.argv[1];',
          'const port = Number(process.argv[2]);',
          "const source = fs.readFileSync(target, 'utf8') + '\\nmodule.exports.performPairingExchange = performPairingExchange;\\n';",
          'const mod = new Module(target, null);',
          'mod.filename = target;',
          'mod.paths = Module._nodeModulePaths(path.dirname(target));',
          'mod._compile(source, target);',
          "mod.exports.performPairingExchange('127.0.0.1', port)",
          "  .then((exchange) => { process.stdout.write('ANTIFAN_RESULT:' + JSON.stringify({ ok: true, exchange }), () => process.exit(0)); })",
          "  .catch((err) => { process.stdout.write('ANTIFAN_RESULT:' + JSON.stringify({ ok: false, error: String((err && err.message) || err) }), () => process.exit(0)); });",
        ].join('\n');

        const child = spawn(process.execPath, ['-e', childScript, OMP_MCP, String(fixture.port)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const exitCode = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60_000);
          child.on('close', (code: number | null) => { clearTimeout(timer); resolve(code); });
        });
        assert.strictEqual(exitCode, 0, `omp child failed (exit ${exitCode}): ${stderr}`);

        const marker = 'ANTIFAN_RESULT:';
        const markerAt = stdout.lastIndexOf(marker);
        assert.ok(markerAt >= 0, `omp child produced no result line: ${stdout}${stderr}`);
        const parsed = JSON.parse(stdout.slice(markerAt + marker.length)) as { ok?: boolean; error?: string; exchange?: Record<string, unknown> };
        assert.strictEqual(parsed.ok, true, `omp pairing failed: ${parsed.error || stdout}`);
        const exchange = parsed.exchange || {};
        assert.strictEqual(exchange.grant, 'eval', "the MCP proxy's default session grant must reach the bridge");
        assert.strictEqual(exchange.grantSource, 'requested');
        const record = fixture.registry.getRecord(String(exchange.attachmentId));
        assert.ok(record, 'the omp pairing must have minted an attachment');
        assert.strictEqual(record?.grant, 'eval');
      } finally {
        restoreEnv('ANTIFAN_SESSION_GRANT', previousGrant);
        fixture.dispose();
      }
    });
  });
});

// ── C. Capability-policy consequence of the pairing grant ──────────────────────
interface EvalStack {
  catalogue: CapabilityCatalogue;
  registry: AttachmentRegistry;
  transport: CapabilityTransportAdapter;
  bridge: BridgeFixture;
  evalCalls: string[];
  dispose(): void;
}

async function startEvalStack(): Promise<EvalStack> {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
  const evalCalls: string[] = [];
  const browserHost = {
    getTabList: () => [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }],
    hasTab: (tabId?: string | null) => tabId === 'tab-1',
    getActiveTabId: () => 'tab-1',
    isCurrentTarget: () => true,
    getDocumentGeneration: () => 1,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html><body>eval stack</body></html>',
    captureScreenshot: async () => Buffer.from('png').toString('base64'),
    evalJs: async (expression: string) => { evalCalls.push(expression); return { evaluated: expression }; },
  };
  const browser = new BrowserControlPort(browserHost as unknown as BrowserHostPort);
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    // The app runs with --allow-eval; the fix is that the SESSION can hold the grant.
    allowEval: true,
    resolveTabId: (tabId: string) => (tabId === 'tab-1' ? 'tab-1' : undefined),
    isTabAllowed: (bound: string, requested: string) => bound === requested,
    getDocumentGeneration: () => 1,
  });
  registerBrowserCapabilities(catalogue, browser);
  const registry = new AttachmentRegistry();
  const transport = new CapabilityTransportAdapter(catalogue, registry);
  const browserTarget: BrowserTarget = {
    projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1,
  };
  const server = new BridgeServer(
    new MockTabHost() as unknown as NativeTabHost,
    0,
    false,
    transport,
    () => ({ lease, projectId, workspaceId, browserTarget }),
    registry
  );
  const port = await server.start();
  return {
    catalogue,
    registry,
    transport,
    bridge: { server, registry, port, projectId, workspaceId, lease, browserTarget, dispose: () => server.dispose() },
    evalCalls,
    dispose: () => server.dispose(),
  };
}

describe('Capability policy consequence of the pairing grant', () => {
  it("hides every eval-risk capability from a 'write' session and exposes it to an 'eval' session", async () => {
    await withIsolatedRoots(async () => {
      const stack = await startEvalStack();
      try {
        const visibleToEval = new Set(stack.transport.list({ grant: 'eval' }).map((item) => item.name));
        const visibleToWrite = new Set(stack.transport.list({ grant: 'write' }).map((item) => item.name));

        for (const name of EVAL_RISK_CAPABILITIES) {
          assert.ok(visibleToEval.has(name), `${name} must be visible to a session holding grant='eval' with allowEval=true`);
          assert.ok(!visibleToWrite.has(name), `${name} must stay hidden from a session holding grant='write'`);
        }
      } finally {
        stack.dispose();
      }
    });
  });

  it("dispatches anti.browser.evaluate with grant='eval' and refuses it with a self-explaining POLICY_DENIED for grant='write'", async () => {
    await withIsolatedRoots(async () => {
      const stack = await startEvalStack();
      try {
        const { catalogue, bridge } = stack;
        const context = {
          lease: bridge.lease,
          leaseToken: bridge.lease.token,
          projectId: bridge.projectId,
          workspaceId: bridge.workspaceId,
          browserTarget: bridge.browserTarget,
        };

        const result = await catalogue.dispatch('anti.browser.evaluate', { expression: '1 + 1' }, { ...context, grant: 'eval' });
        assert.deepStrictEqual(result, { evaluated: '1 + 1' }, 'an eval-risk capability must actually execute under grant=eval');
        assert.deepStrictEqual(stack.evalCalls, ['1 + 1']);

        await assert.rejects(
          () => catalogue.dispatch('anti.browser.evaluate', { expression: '1 + 1' }, { ...context, grant: 'write' }),
          (error: unknown) => {
            assert.ok(error instanceof CapabilityError, `expected a CapabilityError, got ${String(error)}`);
            assert.strictEqual(error.code, 'POLICY_DENIED');
            assert.match(error.message, /capabilityRisk=eval/);
            assert.match(error.message, /sessionGrant=write/);
            assert.match(error.message, /allowEval=true/);
            assert.match(error.message, /runtimeMode=standalone/);
            assert.match(error.message, /requires sessionGrant='eval'/);
            return true;
          }
        );
        assert.deepStrictEqual(stack.evalCalls, ['1 + 1'], 'the refused dispatch must not have evaluated anything');
      } finally {
        stack.dispose();
      }
    });
  });

  it("carries a pairing-declared 'eval' grant all the way to a dispatchable anti.browser.evaluate", async () => {
    await withIsolatedRoots(async () => {
      const stack = await startEvalStack();
      try {
        const code = await claimChallengeCode(stack.bridge.server);
        const { status, body } = await postExchange(stack.bridge.port, { code, clientClass: 'mcp', requestedGrant: 'eval' });
        assert.strictEqual(status, 200, JSON.stringify(body));

        const response = await dispatchOverSocket(stack.bridge.port, String(body.secret), {
          id: 'eval-dispatch-1',
          name: 'anti.browser.evaluate',
          params: { expression: 'window.location.href' },
          attachmentId: String(body.attachmentId),
          authorityRevision: String(body.authorityRevision),
        });

        assert.strictEqual(response.success, true, `a pairing-issued eval session must dispatch eval capabilities: ${JSON.stringify(response)}`);
        assert.deepStrictEqual(response.data?.data, { evaluated: 'window.location.href' });
        assert.deepStrictEqual(stack.evalCalls, ['window.location.href']);
      } finally {
        stack.dispose();
      }
    });
  });

  it("replays the original bug end-to-end: a session paired without requestedGrant is held at 'write' and refused with the full reason", async () => {
    await withIsolatedRoots(async () => {
      const stack = await startEvalStack();
      const warns: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg?: unknown, ...rest: unknown[]) => { warns.push([msg, ...rest].map(String).join(' ')); };
      try {
        // This is exactly what both clients did before the fix: no requestedGrant.
        const code = await claimChallengeCode(stack.bridge.server);
        const { status, body } = await postExchange(stack.bridge.port, { code, clientClass: 'mcp' });
        assert.strictEqual(status, 200, JSON.stringify(body));
        assert.strictEqual(body.grant, 'write');
        assert.strictEqual(body.grantSource, 'default');

        const response = await dispatchOverSocket(stack.bridge.port, String(body.secret), {
          id: 'write-dispatch-1',
          name: 'anti.browser.evaluate',
          params: { expression: 'window.location.href' },
          attachmentId: String(body.attachmentId),
          authorityRevision: String(body.authorityRevision),
        });

        assert.strictEqual(response.success, false, 'fail-closed: an undeclared grant must not reach an eval-risk capability');
        const errorData = response.data || {};
        assert.strictEqual(errorData.code, 'POLICY_DENIED');
        const message = String(errorData.message || '');
        assert.match(message, /capabilityRisk=eval/);
        assert.match(message, /sessionGrant=write/);
        assert.match(message, /allowEval=true/);
        assert.match(message, /runtimeMode=standalone/);
        assert.deepStrictEqual(stack.evalCalls, [], 'the refused dispatch must never have reached the page');
        assert.ok(
          warns.some((w) => w.includes('requestedGrant') && w.includes('POLICY_DENIED')),
          'the fail-closed fallback must be announced at pairing time, not only at dispatch time'
        );
      } finally {
        console.warn = originalWarn;
        stack.dispose();
      }
    });
  });
});
