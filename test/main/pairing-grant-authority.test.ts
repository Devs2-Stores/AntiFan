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
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';
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
    // Anchor on package.json, never on scripts/: the build mirrors scripts into
    // .compiled/, so checking for a script alone would resolve the repository
    // root to the STALE compiled copy and hash the wrong proxy build.
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'scripts', 'antifan-agent.cjs'))) return dir;
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
  hasTab(tabId?: string | null): boolean { return tabId === 'tab-1'; }
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

// ── D. Fresh pairing evidence: anchor/terminal scope over the real HTTP mint ────
/**
 * A fresh `/api/pairing/challenge` → `/api/pairing/exchange` round must mint the MCP
 * attachment under the scope the caller's evidence MEASURES to — the owning project of
 * the anchor tab (`tabId`) or of the origin terminal (`terminalSessionId`) — never under
 * the binding provider's default scope or a workspace that merely contains the caller's
 * cwd. Evidence that cannot be verified (a closed anchor tab, an anchor and terminal
 * claiming different projects, a terminal whose claimed project resolves no workspace)
 * is refused fail-closed instead of minting authority on an unverifiable claim.
 *
 * Everything below goes through the real HTTP handler (bridge-server.ts 1009+ →
 * control-plane-runtime.ts `resolveBrowserSessionWorkspace` 612+), not unit seams.
 */
const EVID_TAB_ANCHOR = 'tab-ev-anchor';
const EVID_TAB_FOREIGN = 'tab-ev-foreign';
const EVID_TAB_STALE = 'tab-ev-stale';
const EVID_TERM_ANCHOR = 'term-ev-anchor';
const EVID_TERM_MALFORMED = 'term-ev-badstamp';

/** A MockTabHost whose live set extends beyond 'tab-1' to the evidence anchor tabs. */
class ScopedPairingTabHost extends MockTabHost {
  private readonly liveTabIds: readonly string[];
  constructor(liveTabs: string[]) {
    super();
    this.liveTabIds = liveTabs;
  }
  hasTab(tabId?: string | null) { return !!tabId && this.liveTabIds.includes(tabId); }
}

/** Terminal-manager facade whose owner-key map is the capsule seam's evidence source. */
function makePairingTerminalStub(ownerBySession: Record<string, string>) {
  return {
    sessionCapsuleId: (_id: string) => undefined as string | undefined,
    sessionOwnerKey: (id: string) => ownerBySession[id],
    getStats: () => ({ sessions: 0 }),
    getSession: (id: string) => ({ id, sessionGeneration: 1, state: 'live' }),
    listSessions: () => [] as Array<{ id: string }>,
    getActiveSessionId: () => undefined as string | undefined,
    getCurrentCwd: () => undefined as string | undefined,
    writeTo: async () => {},
    createSession: async () => 'terminal-new',
    createSplitSession: async () => 'terminal-new-split',
    closeSession: async () => true,
    closeSplitSession: async () => true,
  } as unknown as TerminalManager;
}

function registerScopedProject(runtime: ControlPlaneRuntime, projectId: string, workspaceId: string, rootPath: string, dataRoot: string) {
  runtime.projects.registerProject({
    id: projectId,
    name: projectId,
    dataRoot,
    state: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  runtime.workspaces.register({
    id: workspaceId,
    projectId,
    rootPath,
    state: 'attached',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

interface ScopedPairingFixture {
  server: BridgeServer;
  runtime: ControlPlaneRuntime;
  registry: AttachmentRegistry;
  port: number;
  defaultProjectId: string;
  defaultWorkspaceId: string;
  anchorProjectId: string;
  anchorWorkspaceId: string;
  anchorRoot: string;
  decoyProjectId: string;
  decoyWorkspaceId: string;
  decoyRoot: string;
  unresolvedProjectId: string;
  ambiguousWorkspaceId: string;
  dispose(): void;
}

/**
 * The production layout this proves: the bridge's ambient binding is the default
 * project while the agent's anchor tab and origin terminal live under ANOTHER
 * project. A third project owns only a workspace root — the cwd containment decoy
 * that must lose to evidence.
 */
async function startScopedPairingBridge(): Promise<ScopedPairingFixture> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-evid-data-'));
  const anchorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-evid-anchor-'));
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-evid-decoy-'));
  const defaultProjectId = makeControlPlaneId('project');
  const defaultWorkspaceId = makeControlPlaneId('workspace');
  const anchorProjectId = makeControlPlaneId('project');
  const anchorWorkspaceId = makeControlPlaneId('workspace');
  const decoyProjectId = makeControlPlaneId('project');
  const decoyWorkspaceId = makeControlPlaneId('workspace');
  const ambiguousWorkspaceId = makeControlPlaneId('workspace');
  const unresolvedProjectId = makeControlPlaneId('project');
  const unregisteredWorkspaceId = makeControlPlaneId('workspace');

  const ownerBySession: Record<string, string> = {
    [EVID_TERM_ANCHOR]: `project:${anchorProjectId}`,
    'term-ev-missing-workspace': `project:${unresolvedProjectId}`,
    // A `project:`-prefixed key is a project CLAIM even when its id is malformed:
    // resolveTerminalScope reports it 'unmeasurable', which must refuse closed.
    [EVID_TERM_MALFORMED]: 'project:',
  };
  const runtime = new ControlPlaneRuntime({
    projectId: defaultProjectId,
    workspaceId: defaultWorkspaceId,
    dataRoot,
    workspaceRoot: decoyRoot,
    terminal: makePairingTerminalStub(ownerBySession),
    resolveTabAffiliation: (tabId) =>
      tabId === EVID_TAB_ANCHOR
        ? { projectId: anchorProjectId, workspaceId: anchorWorkspaceId }
        : tabId === EVID_TAB_FOREIGN
        ? { projectId: defaultProjectId, workspaceId: defaultWorkspaceId }
        : undefined,
  });
  await runtime.initialize();
  registerScopedProject(runtime, anchorProjectId, anchorWorkspaceId, anchorRoot, dataRoot);
  // Second attached workspaces make this dedicated project-only claim ambiguous:
  // there is no sole workspace to select, so recovery must refuse, not guess.
  registerScopedProject(runtime, unresolvedProjectId, ambiguousWorkspaceId, fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-evid-extra-')), dataRoot);
  registerScopedProject(runtime, unresolvedProjectId, unregisteredWorkspaceId, fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-evid-extra2-')), dataRoot);
  registerScopedProject(runtime, decoyProjectId, decoyWorkspaceId, decoyRoot, dataRoot);

  const bindingLease = issueRuntimeLease(defaultProjectId, defaultWorkspaceId, 3_600_000, 1);
  const server = new BridgeServer(
    new ScopedPairingTabHost([EVID_TAB_ANCHOR, EVID_TAB_FOREIGN, 'tab-1']) as unknown as NativeTabHost,
    0,
    false,
    undefined,
    () => ({ lease: bindingLease, projectId: defaultProjectId, workspaceId: defaultWorkspaceId }),
    runtime.runs.attachments,
    '127.0.0.1',
    runtime
  );
  const port = await server.start();
  return {
    server,
    runtime,
    registry: runtime.runs.attachments,
    port,
    defaultProjectId,
    defaultWorkspaceId,
    anchorProjectId,
    anchorWorkspaceId,
    anchorRoot,
    decoyProjectId,
    decoyWorkspaceId,
    decoyRoot,
    unresolvedProjectId,
    ambiguousWorkspaceId,
    dispose: () => {
      server.dispose();
      try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(anchorRoot, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(decoyRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Claims a fresh code through the real HTTP challenge endpoint — the mint path, not issuePairingCode. */
async function claimChallengeCodeOverHttp(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/pairing/challenge`, { method: 'POST' });
  const body = (await res.json()) as { success?: boolean; code?: string; error?: string };
  assert.strictEqual(res.status, 200, `the pairing challenge must be claimable: ${JSON.stringify(body)}`);
  assert.strictEqual(body.success, true);
  const code = body.code;
  if (typeof code !== 'string' || code.length === 0) assert.fail('the challenge must carry a code');
  return code;
}

/**
 * The MCP proxy's module scope exports no pairing helper, so its real source is executed
 * in a child process (where the stdio/MCP bootstrap is skipped by `require.main`) and the
 * function is reached through the compiled module's own exports slot. This is a behavioral
 * harness: assertions land on the HTTP traffic and minted record, never on source text.
 * The 60s timer is a watchdog for a wedged child, not a timing assertion.
 */
async function runOmpPairingChild(
  port: number,
  envOverrides: NodeJS.ProcessEnv,
  cwd?: string
): Promise<{ exchange?: Record<string, unknown>; error?: string; errorCode?: string; stdout: string; stderr: string }> {
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
    "  .catch((err) => { process.stdout.write('ANTIFAN_RESULT:' + JSON.stringify({ ok: false, error: String((err && err.message) || err), errorCode: err && err.errorCode }), () => process.exit(0)); });",
  ].join('\n');

  // Strip ambient ANTIFAN_* so a developer/CI environment can never leak evidence
  // the test did not declare, then apply exactly the env the case under test sets.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ANTIFAN_')) continue;
    env[key] = value;
  }
  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, ['-e', childScript, OMP_MCP, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    ...(cwd ? { cwd } : {}),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60_000); // watchdog only: the child exits on its own
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve(code); });
  });
  assert.strictEqual(exitCode, 0, `omp pairing child exited ${exitCode}: ${stderr}`);

  const marker = 'ANTIFAN_RESULT:';
  const markerAt = stdout.lastIndexOf(marker);
  assert.ok(markerAt >= 0, `omp pairing child produced no result line: ${stdout}${stderr}`);
  const parsed = JSON.parse(stdout.slice(markerAt + marker.length)) as
    { ok?: boolean; error?: string; errorCode?: string; exchange?: Record<string, unknown> };
  if (!parsed.ok) return { error: parsed.error, errorCode: parsed.errorCode, stdout, stderr };
  return { exchange: parsed.exchange, stdout, stderr };
}

/**
 * Runs one exchange, then mutates what `fs.readFileSync(__filename)` returns and
 * runs a SECOND exchange in the same process — the load-time PROXY_BUILD must
 * survive the simulated post-load upgrade and be sent unchanged on the re-pair.
 * The hook lives inside the module's own scope so the probe touches no real
 * file and compiles the shipped script in place (sibling requires resolve).
 */
async function runOmpPairingChildAcrossUpgrade(
  port: number,
  envOverrides: NodeJS.ProcessEnv
): Promise<{ exchanges: Array<Record<string, unknown>>; stderr: string }> {
  const childScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const Module = require('node:module');",
    'const target = process.argv[1];',
    'const port = Number(process.argv[2]);',
    // Compiled in place: the module sees the real __filename and sibling
    // requires resolve. The appended shim exports what we need and exposes a
    // drift hook that makes a later readFileSync(__filename) hand back upgraded
    // bytes — the on-disk rewrite a stale proxy lives through.
    "const source = fs.readFileSync(target, 'utf8') + '\\nmodule.exports.performPairingExchange = performPairingExchange;\\nmodule.exports.__injectUpgrade = () => { const f = require(\\'node:fs\\'); const orig = f.readFileSync; f.readFileSync = (p, o) => p === __filename ? Buffer.from(\\'upgraded proxy bytes on disk\\') : orig.call(f, p, o); };\\n';",
    'const mod = new Module(target, null);',
    'mod.filename = target;',
    'mod.paths = Module._nodeModulePaths(path.dirname(target));',
    'mod._compile(source, target);',
    '(async () => {',
    '  const first = await mod.exports.performPairingExchange(\'127.0.0.1\', port);',
    '  mod.exports.__injectUpgrade();',
    '  const second = await mod.exports.performPairingExchange(\'127.0.0.1\', port);',
    "  process.stdout.write('ANTIFAN_RESULT:' + JSON.stringify({ ok: true, exchanges: [first, second] }), () => process.exit(0));",
    "})().catch((err) => { process.stdout.write('ANTIFAN_RESULT:' + JSON.stringify({ ok: false, error: String((err && err.message) || err) }), () => process.exit(0)); });",
  ].join('\n');

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ANTIFAN_')) continue;
    env[key] = value;
  }
  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, ['-e', childScript, OMP_MCP, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60_000); // watchdog only: the child exits on its own
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve(code); });
  });
  assert.strictEqual(exitCode, 0, `proxy-upgrade child exited ${exitCode}: ${stderr}`);

  const marker = 'ANTIFAN_RESULT:';
  const markerAt = stdout.lastIndexOf(marker);
  assert.ok(markerAt >= 0, `proxy-upgrade child produced no result line: ${stdout}${stderr}`);
  const parsed = JSON.parse(stdout.slice(markerAt + marker.length)) as
    { ok?: boolean; error?: string; exchanges?: Array<Record<string, unknown>> };
  assert.ok(parsed.ok && parsed.exchanges, `proxy-upgrade pairing failed: ${parsed.error || stdout}${stderr}`);
  return { exchanges: parsed.exchanges, stderr };
}

describe('Fresh pairing evidence exchange (HTTP, ControlPlaneRuntime-scoped)', () => {
  let fixture: ScopedPairingFixture;
  before(async () => {
    fixture = await startScopedPairingBridge();
  });
  after(() => {
    fixture?.dispose();
  });

  it('mints the attachment under the measured anchor-tab scope, not the ambient binding or the cwd', async () => {
    const code = await claimChallengeCodeOverHttp(fixture.port);
    // cwd sits inside the decoy project's root: if evidence were ignored, workspace
    // containment alone would pull the mint under the decoy — and without evidence at
    // all, the ambient binding would land it under the default scope.
    const { status, body } = await postExchange(fixture.port, {
      code,
      clientClass: 'mcp',
      requestedGrant: 'write',
      tabId: EVID_TAB_ANCHOR,
      cwd: fixture.decoyRoot,
    });

    assert.strictEqual(status, 200, `anchor-scoped pairing must succeed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.projectId, fixture.anchorProjectId, 'the anchor tab affiliation must win over the ambient default binding');
    assert.strictEqual(body.workspaceId, fixture.anchorWorkspaceId);
    assert.notStrictEqual(body.projectId, fixture.defaultProjectId, 'the minted scope must not fall back to the ambient binding project');
    assert.notStrictEqual(body.projectId, fixture.decoyProjectId, 'the minted scope must not be pulled by caller cwd containment');

    const record = fixture.registry.getRecord(String(body.attachmentId));
    assert.ok(record, 'the exchange must register the attachment it mints');
    assert.strictEqual(record?.projectId, fixture.anchorProjectId);
    assert.strictEqual(record?.workspaceId, fixture.anchorWorkspaceId);
    assert.strictEqual(record?.tabId, EVID_TAB_ANCHOR, 'the supplied anchor must be written to the attachment record');
  });

  it('mints under the origin terminal measured project even when the cwd lives elsewhere', async () => {
    const code = await claimChallengeCodeOverHttp(fixture.port);
    const { status, body } = await postExchange(fixture.port, {
      code,
      clientClass: 'mcp',
      requestedGrant: 'write',
      terminalSessionId: EVID_TERM_ANCHOR,
      cwd: fixture.decoyRoot,
    });

    assert.strictEqual(status, 200, `terminal-scoped pairing must succeed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.projectId, fixture.anchorProjectId, "the terminal's owner-key measurement must win over cwd containment and the ambient binding");
    assert.strictEqual(body.workspaceId, fixture.anchorWorkspaceId);

    const record = fixture.registry.getRecord(String(body.attachmentId));
    assert.ok(record);
    assert.strictEqual(record?.projectId, fixture.anchorProjectId);
    assert.strictEqual(record?.workspaceId, fixture.anchorWorkspaceId);
  });

  it('refuses stale or conflicting evidence fail-closed and keeps each code single-use', async () => {
    const beforeIds = fixture.registry.getActiveRecordIds();

    const staleCode = fixture.server.issuePairingCode({ clientClass: 'mcp' }).code;
    const stale = await postExchange(fixture.port, { code: staleCode, clientClass: 'mcp', tabId: EVID_TAB_STALE });
    assert.strictEqual(stale.status, 409, `a closed anchor tab must be refused: ${JSON.stringify(stale.body)}`);
    assert.strictEqual(stale.body.error, 'TARGET_STALE');
    assert.match(String(stale.body.message ?? ''), /Pairing anchor tab is not live/, 'the refusal must carry the TARGET_STALE reason text');
    // Single-use is proven BEFORE anything else mints: the consumed record is still
    // in the store, so a replay must hit the explicit ALREADY_USED denial — never a
    // second mint or a silent retry.
    const replay = await postExchange(fixture.port, { code: staleCode, clientClass: 'mcp' });
    assert.strictEqual(replay.status, 409, `a consumed code must never replay: ${JSON.stringify(replay.body)}`);
    assert.strictEqual(replay.body.error, 'PAIRING_CODE_ALREADY_USED');
    assert.ok(!replay.body.attachmentId, 'a replayed exchange must never mint an attachment');

    const conflicts: Array<{ payload: Record<string, unknown>; status: number; error: string; reason: RegExp }> = [
      // Anchor tab measures under the default project while the origin terminal's
      // owner key measures under the anchor project: two pieces of evidence that
      // disagree about where authority must land.
      { payload: { tabId: EVID_TAB_FOREIGN, terminalSessionId: EVID_TERM_ANCHOR }, status: 409, error: 'PROJECT_MISMATCH', reason: /conflicts with the measured anchor project/ },
      // The terminal carries a malformed `project:` claim — a real claim that cannot
      // be measured to a workspace, which must fail closed, not fall back to cwd.
      { payload: { terminalSessionId: EVID_TERM_MALFORMED }, status: 403, error: 'TERMINAL_SCOPE_UNRESOLVED', reason: /terminal scope cannot be measured/ },
    ];
    for (const { payload, status, error, reason } of conflicts) {
      const code = fixture.server.issuePairingCode({ clientClass: 'mcp' }).code;
      const result = await postExchange(fixture.port, { code, clientClass: 'mcp', requestedGrant: 'write', ...payload });
      assert.strictEqual(result.status, status, `conflicting evidence ${JSON.stringify(payload)} must be refused: ${JSON.stringify(result.body)}`);
      assert.strictEqual(result.body.error, error);
      assert.match(String(result.body.message ?? ''), reason, 'the refusal must name the measured reason');
      const refusedReplay = await postExchange(fixture.port, { code, clientClass: 'mcp' });
      assert.strictEqual(refusedReplay.status, 409);
      assert.strictEqual(refusedReplay.body.error, 'PAIRING_CODE_ALREADY_USED');
      assert.ok(!refusedReplay.body.attachmentId, 'scope refusal must consume the code without minting authority');
    }
    const unresolvedScopeCode = await claimChallengeCodeOverHttp(fixture.port);
    const unresolvedScope = await postExchange(fixture.port, {
      code: unresolvedScopeCode,
      clientClass: 'mcp',
      requestedGrant: 'write',
      tabId: EVID_TAB_STALE,
      terminalSessionId: 'term-ev-missing-workspace',
      projectId: fixture.unresolvedProjectId,
      workspaceId: fixture.ambiguousWorkspaceId,
    });
    assert.strictEqual(unresolvedScope.status, 403, `an unresolvable measured workspace must be refused: ${JSON.stringify(unresolvedScope.body)}`);
    assert.strictEqual(unresolvedScope.body.error, 'TERMINAL_SCOPE_UNRESOLVED');
    assert.ok(!unresolvedScope.body.attachmentId, 'unresolvable measured scope must never mint authority');
    const unresolvedReplay = await postExchange(fixture.port, { code: unresolvedScopeCode, clientClass: 'mcp' });
    assert.strictEqual(unresolvedReplay.status, 409);
    assert.strictEqual(unresolvedReplay.body.error, 'PAIRING_CODE_ALREADY_USED');
    assert.ok(!unresolvedReplay.body.attachmentId, 'the refused code must stay single-use');

    for (const scope of [{ projectId: ' ' }, { workspaceId: ' ' }]) {
      const code = await claimChallengeCodeOverHttp(fixture.port);
      const result = await postExchange(fixture.port, {
        code, clientClass: 'mcp', requestedGrant: 'write', tabId: EVID_TAB_STALE,
        terminalSessionId: EVID_TERM_ANCHOR, projectId: fixture.anchorProjectId, workspaceId: fixture.anchorWorkspaceId,
        ...scope,
      });
      assert.strictEqual(result.status, 409, `blank scope evidence must be refused: ${JSON.stringify(result.body)}`);
      assert.strictEqual(result.body.error, 'TARGET_STALE');
      assert.ok(!result.body.attachmentId, 'blank scope evidence must never mint authority');
      const replay = await postExchange(fixture.port, { code, clientClass: 'mcp' });
      assert.strictEqual(replay.status, 409);
      assert.strictEqual(replay.body.error, 'PAIRING_CODE_ALREADY_USED');
      assert.ok(!replay.body.attachmentId, 'the refused code must stay single-use');
    }

    assert.strictEqual(
      fixture.registry.getActiveRecordIds().size,
      beforeIds.size,
      'refused evidence must never mint an attachment'
    );

    // The same code replayed again — now after `issuePairingCode` has pruned the
    // consumed record — is still refused fail-closed (NOT_FOUND in place of
    // ALREADY_USED). The invariant is "denied, never minted"; which refusal the
    // store answers with depends on prune timing and is not pinned.
    const replayAfterPrune = await postExchange(fixture.port, { code: staleCode, clientClass: 'mcp' });
    assert.notStrictEqual(replayAfterPrune.status, 200, 'a spent code must stay refused even after store pruning');
    assert.ok(replayAfterPrune.body.success !== true, 'a spent code must never answer success');
    assert.ok(!replayAfterPrune.body.attachmentId, 'a replayed exchange must never mint an attachment');
    assert.strictEqual(fixture.registry.getActiveRecordIds().size, beforeIds.size, 'replays must leave the registry untouched');
  });

  it('refuses stale-anchor recovery with missing or conflicting terminal scope and burns each code once', async () => {
    const beforeIds = fixture.registry.getActiveRecordIds();
    const cases = [
      { terminalSessionId: EVID_TERM_ANCHOR, projectId: fixture.defaultProjectId, workspaceId: fixture.anchorWorkspaceId, status: 409, error: 'PROJECT_MISMATCH' },
      { terminalSessionId: EVID_TERM_ANCHOR, projectId: fixture.anchorProjectId, workspaceId: fixture.defaultWorkspaceId, status: 409, error: 'WORKSPACE_MISMATCH' },
    ];
    for (const { status, error, ...scope } of cases) {
      const code = await claimChallengeCodeOverHttp(fixture.port);
      const result = await postExchange(fixture.port, {
        code, clientClass: 'mcp', requestedGrant: 'write', tabId: EVID_TAB_STALE, ...scope,
      });
      assert.strictEqual(result.status, status, JSON.stringify(result.body));
      assert.strictEqual(result.body.error, error);
      assert.ok(!result.body.attachmentId, 'conflicting scope must not mint authority');
      const replay = await postExchange(fixture.port, { code, clientClass: 'mcp', requestedGrant: 'write' });
      assert.strictEqual(replay.status, 409);
      assert.strictEqual(replay.body.error, 'PAIRING_CODE_ALREADY_USED');
      assert.ok(!replay.body.attachmentId, 'scope refusal must not leave a reusable challenge');
    }
    // An unattributed terminal claims no project, so the caller's stale
    // projectId/workspaceId cannot be verified against it — the recovery mints
    // under the default binding instead of trusting the claim or refusing the
    // re-pair outright (that refusal wedged every post-restart MCP proxy).
    const unattributedCode = await claimChallengeCodeOverHttp(fixture.port);
    const unattributed = await postExchange(fixture.port, {
      code: unattributedCode, clientClass: 'mcp', requestedGrant: 'write', tabId: EVID_TAB_STALE,
      terminalSessionId: 'term-unmeasured', projectId: fixture.anchorProjectId, workspaceId: fixture.anchorWorkspaceId,
    });
    assert.strictEqual(unattributed.status, 200, `unattributed recovery must mint: ${JSON.stringify(unattributed.body)}`);
    assert.strictEqual(unattributed.body.recoveredStaleAnchor, true);
    assert.strictEqual(unattributed.body.projectId, fixture.defaultProjectId, 'unverifiable caller scope must be stripped, not honored');
    assert.strictEqual(unattributed.body.workspaceId, fixture.defaultWorkspaceId);
    assert.ok(!unattributed.body.tabId, 'the stale anchor tab must not be bound');
    assert.deepStrictEqual(
      new Set([...fixture.registry.getActiveRecordIds()].filter((id) => !beforeIds.has(id))),
      new Set([String(unattributed.body.attachmentId)]),
      'only the unattributed recovery may mint an attachment',
    );
  });

  it('keeps malformed JSON a 400 refusal without consuming an unused challenge', async () => {
    const code = await claimChallengeCodeOverHttp(fixture.port);
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/pairing/exchange`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, clientClass: 'mcp' }).slice(0, -1),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.strictEqual(response.status, 400);
    assert.strictEqual(body.error, 'INVALID_JSON_BODY');
    const valid = await postExchange(fixture.port, { code, clientClass: 'mcp', requestedGrant: 'write', tabId: EVID_TAB_ANCHOR });
    assert.strictEqual(valid.status, 200, JSON.stringify(valid.body));
    assert.strictEqual(valid.body.projectId, fixture.anchorProjectId);
  });

  for (const { error, status } of [
    { error: 'TARGET_STALE', status: 409 },
    { error: 'PROJECT_MISMATCH', status: 409 },
    { error: 'WORKSPACE_MISMATCH', status: 409 },
    { error: 'TERMINAL_SCOPE_UNRESOLVED', status: 403 },
    { error: 'POLICY_DENIED', status: 403 },
  ]) {
    it(`has the omp-mcp proxy stop after one challenge on ${error}`, async () => {
      let challenges = 0;
      const exchangedCodes: unknown[] = [];
      const stub = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        req.on('end', () => {
          if (req.url === '/api/pairing/challenge') {
            challenges++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, code: `scope-refusal-${challenges}` }));
            return;
          }
          const payload = JSON.parse(raw) as Record<string, unknown>;
          exchangedCodes.push(payload.code);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error, message: 'Measured pairing authority refuses this scope' }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        stub.once('error', reject);
        stub.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = stub.address();
        assert.ok(address && typeof address === 'object');
        const result = await runOmpPairingChild(address.port, { ANTIFAN_SESSION_GRANT: 'write' });
        assert.ok(!result.exchange, 'terminal scope refusal must not return a paired session');
        assert.strictEqual(result.errorCode, error, 'the caller must receive the typed refusal');
        assert.strictEqual(challenges, 1, 'terminal refusal must not drain fresh challenge codes');
        assert.deepStrictEqual(exchangedCodes, ['scope-refusal-1'], 'the refused code must be exchanged exactly once');
      } finally {
        await new Promise<void>((resolve, reject) => stub.close((err) => err ? reject(err) : resolve()));
      }
    });
  }

  it("has the omp-mcp proxy pair with env-supplied evidence and land the attachment under the terminal's project", async () => {
    // The real proxy carries ANTIFAN_BOUND_TAB_ID / ANTIFAN_TERMINAL_*_SESSION_ID env
    // evidence into the exchange body; running its own module scope (not a source
    // assertion) proves the wire and the measured mint end-to-end.
    const result = await runOmpPairingChild(
      fixture.port,
      {
        ANTIFAN_SESSION_GRANT: 'write',
        ANTIFAN_BOUND_TAB_ID: EVID_TAB_ANCHOR,
        ANTIFAN_TERMINAL_AFFINITY_SESSION_ID: EVID_TERM_ANCHOR,
      },
      fixture.decoyRoot
    );

    assert.ok(result.exchange, `proxy pairing failed: ${result.error || result.stderr}`);
    const exchange = result.exchange;
    assert.strictEqual(exchange.success, true);
    assert.strictEqual(exchange.projectId, fixture.anchorProjectId, 'the proxy evidence must steer the mint to the measured project');
    assert.strictEqual(exchange.workspaceId, fixture.anchorWorkspaceId);
    assert.notStrictEqual(exchange.projectId, fixture.decoyProjectId);

    const record = fixture.registry.getRecord(String(exchange.attachmentId));
    assert.ok(record, 'the proxy pairing must have minted an attachment');
    assert.strictEqual(record?.projectId, fixture.anchorProjectId);
    assert.strictEqual(record?.tabId, EVID_TAB_ANCHOR, 'the proxy-sent tabId must land on the attachment record');
  });

  it('has the omp-mcp proxy send tabId, terminalSessionId and cwd on the exchange wire', async () => {
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
          res.end(JSON.stringify({ success: true, code: 'stub-evidence-code' }));
        } else {
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
    assert.ok(stubPort > 0, 'stub bridge must be listening');

    const proxyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-evid-cwd-'));
    try {
      const result = await runOmpPairingChild(
        stubPort,
        {
          ANTIFAN_SESSION_GRANT: 'write',
          ANTIFAN_BOUND_TAB_ID: 'tab-env-bound',
          // Affinity takes precedence over parent/session in the proxy's own env chain.
          ANTIFAN_TERMINAL_AFFINITY_SESSION_ID: 'term-env-affinity',
          ANTIFAN_TERMINAL_PARENT_SESSION_ID: 'term-env-parent',
          ANTIFAN_TERMINAL_SESSION_ID: 'term-env-self',
          ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({ projectId: 'stub-project', workspaceId: 'stub-workspace' }),
        },
        proxyCwd
      );
      assert.ok(result.exchange, `proxy pairing against the stub failed: ${result.error || result.stderr}`);
      assert.strictEqual(result.exchange?.success, true);

      const challengeCall = received.find((r) => r.path.endsWith('/challenge'));
      assert.ok(challengeCall, 'the proxy must claim a fresh challenge');
      const exchangeCall = received.find((r) => r.path.endsWith('/exchange'));
      assert.ok(exchangeCall, 'the proxy must POST /api/pairing/exchange');
      const wire = exchangeCall.payload;
      assert.strictEqual(wire.code, 'stub-evidence-code', 'the exchange must redeem the challenge the proxy just claimed');
      assert.strictEqual(wire.clientClass, 'mcp');
      assert.strictEqual(wire.requestedGrant, 'write');
      assert.strictEqual(wire.tabId, 'tab-env-bound', 'the env anchor evidence must reach the wire');
      assert.strictEqual(
        wire.terminalSessionId,
        'term-env-affinity',
        'the affinity terminal env must reach the wire and outrank the parent/session fallbacks'
      );
      assert.strictEqual(wire.projectId, 'stub-project', 'the proxy bootstrap project must reach the wire as stale-anchor evidence');
      assert.strictEqual(wire.workspaceId, 'stub-workspace', 'the proxy bootstrap workspace must reach the wire as stale-anchor evidence');
      // Canonicalize both sides: mkdtemp may hand back a short-name path while the
      // child's process.cwd() is canonical.
      assert.strictEqual(
        fs.realpathSync.native(path.resolve(String(wire.cwd))),
        fs.realpathSync.native(proxyCwd),
        'the proxy must report its own cwd as workspace evidence'
      );
    } finally {
      try { stub.close(); } catch {}
      try { fs.rmSync(proxyCwd, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── Stale-proxy build detection ──────────────────────────────────────────────
// A proxy process survives Desktop restarts and keeps executing the
// antifan-omp-mcp.cjs bytes it was spawned from. The proxy sends the digest of
// those loaded bytes (`proxyBuild`); the bridge echoes the hash of the script
// it ships and flags `proxyStale` on mismatch. A proxy that predates the field
// sends nothing and still pairs — refusing it would orphan every pre-field
// session.
describe('Stale-proxy build detection on the exchange', () => {
  const scriptDigest = (): string =>
    crypto.createHash('sha256').update(fs.readFileSync(OMP_MCP)).digest('hex').slice(0, 16);

  it('answers proxyStale=false and echoes the shipped digest when the declared build matches', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        const code = await claimChallengeCode(fixture.server);
        const { status, body } = await postExchange(fixture.port, {
          code,
          clientClass: 'mcp',
          proxyBuild: scriptDigest(),
        });
        assert.strictEqual(status, 200, `matching proxy build must pair: ${JSON.stringify(body)}`);
        assert.strictEqual(body.proxyBuild, scriptDigest(), 'the bridge must echo the digest of the script it ships');
        assert.strictEqual(body.proxyStale, false);
      } finally {
        fixture.dispose();
      }
    });
  });

  it('flags proxyStale=true on a mismatched digest but still mints the attachment', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        const code = await claimChallengeCode(fixture.server);
        const { status, body } = await postExchange(fixture.port, {
          code,
          clientClass: 'mcp',
          proxyBuild: 'deadbeefdeadbeef',
        });
        assert.strictEqual(status, 200, `a stale proxy must still pair — refusing it would orphan pre-field sessions: ${JSON.stringify(body)}`);
        assert.strictEqual(body.proxyStale, true);
        assert.strictEqual(body.proxyBuild, scriptDigest());
        assert.ok(body.secret, 'the stale proxy still receives usable authority');
      } finally {
        fixture.dispose();
      }
    });
  });

  it('leaves proxyStale undefined when the client declares no build (pre-field proxy)', async () => {
    await withIsolatedRoots(async () => {
      const fixture = await startBridge();
      try {
        const code = await claimChallengeCode(fixture.server);
        const { status, body } = await postExchange(fixture.port, { code, clientClass: 'mcp' });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.proxyStale, undefined);
      } finally {
        fixture.dispose();
      }
    });
  });

  it('sends the load-time digest on a re-pair even after the on-disk script changes', async () => {
    // The advisory invariant end-to-end: the proxy loads, an upgrade rewrites
    // the file it was spawned from, and the SAME process re-pairs. Because
    // PROXY_BUILD is captured at module load, the second exchange must carry
    // the digest of the bytes the process executes — not the upgraded bytes a
    // lazy readFileSync would return. The drift hook simulates the rewrite
    // inside the module scope; no repo file is mutated.
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
          res.end(JSON.stringify({ success: true, code: `stub-code-${received.length}` }));
        } else {
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
    assert.ok(stubPort > 0, 'stub bridge must be listening');

    try {
      const { exchanges, stderr } = await runOmpPairingChildAcrossUpgrade(stubPort, {
        ANTIFAN_SESSION_GRANT: 'write',
      });
      assert.strictEqual(exchanges.length, 2, 'both pairings must succeed');
      const exchangeCalls = received.filter((r) => r.path.endsWith('/exchange'));
      assert.strictEqual(exchangeCalls.length, 2, 'the proxy must POST the exchange twice');
      const first = exchangeCalls[0]?.payload.proxyBuild;
      const second = exchangeCalls[1]?.payload.proxyBuild;
      const shippedDigest = crypto.createHash('sha256').update(fs.readFileSync(OMP_MCP)).digest('hex').slice(0, 16);
      assert.strictEqual(first, shippedDigest, 'the first exchange must carry the digest of the loaded script');
      assert.strictEqual(
        second,
        first,
        'the re-pair must still report the loaded bytes, not the post-load upgrade on disk'
      );
    } finally {
      try { stub.close(); } catch {}
    }
  });
});
