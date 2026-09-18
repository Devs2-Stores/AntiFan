/**
 * Contract: the tab an omitted-`tabId` call rides must track the authority.
 *
 * The proxy advertises `tabId` as optional and fills it from its own bound-tab
 * default. That default is a cache of what the desktop treats as the session's
 * tab, so every operation that moves the session has to move the cache with it:
 *
 *   - `anti.browser.tabs.create` adopts the tab it opens, and the authority
 *     rotates onto it;
 *   - `anti.browser.tabs.close` rotates back to the replacement it hands back
 *     (`failoverTabId`) when the tab it closed was the one being defaulted to.
 *
 * A cache that misses either rotation keeps naming a tab that no longer exists,
 * and the failure is not local to the proxy: the desktop honours the id as an
 * explicit request and refuses the call as an unknown target, so the session
 * looks broken until the client re-pairs. The close-without-replacement case is
 * the sharper edge — the bootstrap file still names the closed tab, so a naive
 * cache re-reads the dead id on the next call; the default has to be *cleared*
 * rather than re-derived.
 *
 * A default can also go stale without any of those operations: another client
 * rotates the session, or the tab dies behind the proxy's back. The desktop then
 * refuses the injected id as an unknown target — carrying the live target in the
 * refusal — so the proxy retargets onto it and retries once instead of surfacing
 * a failure the session would have to re-pair out of. An id the caller passed
 * explicitly, and a refusal that does not name a different live target, are left
 * to surface unchanged.
 *
 * The proxy under test is the real one shipped in this repo, driven over stdio
 * MCP against a mock bridge that scripts the capability responses. No AntiFan
 * Desktop instance is contacted: the bootstrap is pinned to the mock port and
 * every ambient discovery input is scrubbed, mirroring
 * `test/main/dispatch-socket-teardown.test.ts`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

const PROXY_SCRIPT = path.resolve(process.cwd(), 'scripts', 'antifan-omp-mcp.cjs');
const BOOTSTRAP_TAB_ID = 'tab-anchor';
const CREATED_TAB_ID = 'tab-child';
const LIVE_TAB_ID = 'tab-live';
const CALLER_TAB_ID = 'tab-caller';

/** Ambient inputs that would let the proxy leave this mock and talk to a real desktop. */
const DISCOVERY_ENV_KEYS = [
  'ANTIFAN_TERMINAL_AFFINITY_SESSION_ID',
  'ANTIFAN_TERMINAL_PARENT_SESSION_ID',
  'ANTIFAN_TERMINAL_SESSION_ID',
  'ANTIFAN_BRIDGE_PID',
  'ANTIFAN_ATTACHMENT_SECRET',
  'ANTIFAN_ATTACHMENT_ID',
  'ANTIFAN_MCP_PORT',
  'ANTIFAN_OWNER_PID',
  'ANTIFAN_AUTHORITY_REVISION',
  'ANTIFAN_BOUND_TAB_ID',
  'ANTIFAN_HOST',
];

interface DispatchFrame {
  capability: string | undefined;
  params: Record<string, unknown>;
}

interface MockFailureResult {
  __antiFanMockFailure: true;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Scripts a refusal on the wire exactly as the bridge reports one: `data` carries the
 * typed code and its details, `error` the rendered `CODE: message` text.
 */
function mockFailure(code: string, message: string, details?: Record<string, unknown>): MockFailureResult {
  return { __antiFanMockFailure: true, code, message, details };
}

function isMockFailure(value: unknown): value is MockFailureResult {
  return typeof value === 'object' && value !== null && '__antiFanMockFailure' in value && value.__antiFanMockFailure === true;
}

interface Harness {
  callTool: (mcpId: number, name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The most recent dispatch frame the proxy sent for `capability`. */
  lastDispatch: (capability: string) => DispatchFrame;
  /** Every dispatch frame the proxy sent for `capability`, in order. */
  dispatches: (capability: string) => DispatchFrame[];
  stderrText: () => string;
  dispose: () => void;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * `respond` answers one dispatched capability by name. Returning `undefined`
 * leaves the frame recorded but unanswered, which is how a call that must not
 * progress is expressed.
 */
async function startHarness(respond: (capability: string, params: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<Harness> {
  assert.ok(fs.existsSync(PROXY_SCRIPT), `proxy script must exist: ${PROXY_SCRIPT}`);

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert.ok(port > 0, 'mock bridge must bind an ephemeral port');

  const connections = new Set<WebSocket>();
  const frames: DispatchFrame[] = [];
  let stderrBuffer = '';

  wss.on('connection', (ws) => {
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    ws.on('message', (raw) => {
      let message: { id?: string; method?: string; params?: { name?: string; params?: Record<string, unknown> } };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      // The dedicated heartbeat channel must stay answerable, otherwise the proxy
      // spends the test re-connecting it instead of exercising the dispatch path.
      if (message.id === 'hb') {
        ws.send(JSON.stringify({ id: 'hb', success: true, data: { expiresAt: Date.now() + 60_000 } }));
        return;
      }
      if (message.method === 'antifan.capability.dispatch') {
        const capability = message.params?.name || '';
        const params = message.params?.params || {};
        frames.push({ capability, params });
        const data = respond(capability, params);
        if (data === undefined) return;
        if (isMockFailure(data)) {
          ws.send(
            JSON.stringify({
              id: message.id,
              success: false,
              error: `${data.code}: ${data.message}`,
              data: { code: data.code, message: data.message, details: data.details },
            })
          );
          return;
        }
        ws.send(JSON.stringify({ id: message.id, success: true, data }));
        return;
      }
      if (typeof message.id === 'string') {
        ws.send(JSON.stringify({ id: message.id, success: false, error: 'MOCK_UNSUPPORTED_METHOD' }));
      }
    });
  });

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
      port,
      secret: 'secret-bound-tab-rotation',
      attachmentId: 'attachment-bound-tab-rotation',
      authorityRevision: 'rev-1',
      runId: 'run-rotation',
      attemptId: 'attempt-rotation',
      projectId: 'project-rotation',
      workspaceId: 'workspace-rotation',
      tabId: BOOTSTRAP_TAB_ID,
    }),
    ANTIFAN_HEARTBEAT_MS: '60000',
  };
  for (const key of DISCOVERY_ENV_KEYS) delete env[key];

  const child: ChildProcess = spawn(process.execPath, [PROXY_SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => { stderrBuffer += chunk.toString('utf8'); });

  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const decoder = new TextDecoder('utf8');
  let stdoutBuffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += decoder.decode(chunk, { stream: true });
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: { id?: number };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (typeof parsed.id !== 'number') continue;
      const settle = pending.get(parsed.id);
      if (settle) {
        pending.delete(parsed.id);
        settle(parsed as Record<string, unknown>);
      }
    }
  });

  const callTool = (mcpId: number, name: string, args: Record<string, unknown>) =>
    withTimeout(
      new Promise<Record<string, unknown>>((resolve) => {
        pending.set(mcpId, resolve);
        child.stdin?.write(
          JSON.stringify({ jsonrpc: '2.0', id: mcpId, method: 'tools/call', params: { name, arguments: args } }) + '\n'
        );
      }),
      30_000,
      `tools/call ${name} never produced a response`
    );

  const initialized = new Promise<void>((resolve) => {
    pending.set(0, () => resolve());
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bound-tab-rotation-harness', version: '1.0.0' },
        },
      }) + '\n'
    );
  });
  await withTimeout(initialized, 15_000, 'MCP initialize handshake');

  return {
    callTool,
    lastDispatch: (capability: string) => {
      const frame = [...frames].reverse().find((entry) => entry.capability === capability);
      assert.ok(frame, `the proxy must have dispatched '${capability}' (saw: ${frames.map((f) => f.capability).join(', ')})`);
      return frame;
    },
    dispatches: (capability: string) => frames.filter((entry) => entry.capability === capability),
    stderrText: () => stderrBuffer,
    dispose: () => {
      try { child.kill(); } catch {}
      for (const ws of connections) {
        try { ws.terminate(); } catch {}
      }
      try { wss.close(); } catch {}
    },
  };
}

/** The probe used for the "next call" — any target-bound capability works. */
async function probeBoundTab(harness: Harness, mcpId: number, tabId: string | undefined): Promise<void> {
  await harness.callTool(mcpId, 'anti.inspect.dom', {});
  const frame = harness.lastDispatch('browser.dom');
  assert.equal(
    frame.params.tabId,
    tabId,
    `an omitted tabId must ride ${tabId === undefined ? 'the authority (no injected id)' : `'${tabId}'`}: ${harness.stderrText()}`
  );
}

/** A failed tool call is reported as `result.isError === true`, with the text in `result.content`. */
function toolCallFailed(response: Record<string, unknown>): boolean {
  const result = 'result' in response ? response.result : undefined;
  if (typeof result !== 'object' || result === null || !('isError' in result)) return false;
  return result.isError === true;
}

describe('MCP proxy bound-tab default follows the authority', () => {
  it('1. an opened tab becomes the default an omitted-tabId call rides', async () => {
    const harness = await startHarness((capability) =>
      capability === 'browser.open-tab' ? { tabId: CREATED_TAB_ID } : {}
    );
    try {
      await probeBoundTab(harness, 1, BOOTSTRAP_TAB_ID);
      await harness.callTool(2, 'anti.browser.tabs.create', {});
      await probeBoundTab(harness, 3, CREATED_TAB_ID);
    } finally {
      harness.dispose();
    }
  });

  it('2. closing the default with a replacement moves the default onto it', async () => {
    const harness = await startHarness((capability) => {
      if (capability === 'browser.open-tab') return { tabId: CREATED_TAB_ID };
      if (capability === 'browser.close-tab') return { closed: true, tabId: CREATED_TAB_ID, failoverTabId: BOOTSTRAP_TAB_ID };
      return {};
    });
    try {
      await harness.callTool(1, 'anti.browser.tabs.create', {});
      await probeBoundTab(harness, 2, CREATED_TAB_ID);
      await harness.callTool(3, 'anti.browser.tabs.close', { tabId: CREATED_TAB_ID });
      await probeBoundTab(harness, 4, BOOTSTRAP_TAB_ID);
    } finally {
      harness.dispose();
    }
  });

  it('3. closing the default with no replacement clears it instead of re-deriving the dead id', async () => {
    const harness = await startHarness((capability) =>
      capability === 'browser.close-tab' ? { closed: true, tabId: BOOTSTRAP_TAB_ID } : {}
    );
    try {
      await probeBoundTab(harness, 1, BOOTSTRAP_TAB_ID);
      await harness.callTool(2, 'anti.browser.tabs.close', { tabId: BOOTSTRAP_TAB_ID });
      // The bootstrap still names the closed tab; the default must not fall back to it.
      await probeBoundTab(harness, 3, undefined);
    } finally {
      harness.dispose();
    }
  });

  it('4. closing a tab that is not the default leaves the default alone', async () => {
    const harness = await startHarness((capability) =>
      capability === 'browser.close-tab'
        ? { closed: true, tabId: 'tab-unrelated', failoverTabId: 'tab-unrelated-anchor' }
        : {}
    );
    try {
      await probeBoundTab(harness, 1, BOOTSTRAP_TAB_ID);
      await harness.callTool(2, 'anti.browser.tabs.close', { tabId: 'tab-unrelated' });
      await probeBoundTab(harness, 3, BOOTSTRAP_TAB_ID);
    } finally {
      harness.dispose();
    }
  });

  it('5. a refusal naming the live target retargets an injected default and adopts it', async () => {
    let refused = false;
    const harness = await startHarness((capability) => {
      if (capability !== 'browser.dom' || refused) return {};
      refused = true;
      return mockFailure('TARGET_MISMATCH', `Unknown browser target: ${BOOTSTRAP_TAB_ID}`, {
        requestedTabId: BOOTSTRAP_TAB_ID,
        liveTabId: LIVE_TAB_ID,
        rebindTool: 'anti.browser.rebind_target',
      });
    });
    try {
      const response = await harness.callTool(1, 'anti.inspect.dom', {});
      assert.equal(toolCallFailed(response), false, `the retargeted call must succeed: ${harness.stderrText()}`);
      const attempts = harness.dispatches('browser.dom');
      assert.equal(attempts.length, 2, `the refusal must be retried exactly once: ${harness.stderrText()}`);
      const [first, second] = attempts;
      assert.ok(first, 'the first attempt must be recorded');
      assert.ok(second, 'the retry must be recorded');
      assert.equal(first.params.tabId, BOOTSTRAP_TAB_ID, 'the first attempt rode the stale default');
      assert.equal(second.params.tabId, LIVE_TAB_ID, 'the retry must be aimed at the live target the refusal named');
      // The adopted target is what the next omitted-tabId call rides.
      await probeBoundTab(harness, 2, LIVE_TAB_ID);
    } finally {
      harness.dispose();
    }
  });

  it('6. a refusal that names a live target for an id the caller chose is not retargeted', async () => {
    const harness = await startHarness((capability) =>
      capability === 'browser.dom'
        ? mockFailure('TARGET_MISMATCH', `Unknown browser target: ${CALLER_TAB_ID}`, {
            requestedTabId: CALLER_TAB_ID,
            liveTabId: BOOTSTRAP_TAB_ID,
            rebindTool: 'anti.browser.rebind_target',
          })
        : {}
    );
    try {
      const response = await harness.callTool(1, 'anti.inspect.dom', { tabId: CALLER_TAB_ID });
      assert.equal(toolCallFailed(response), true, `a caller-chosen target must surface its refusal: ${harness.stderrText()}`);
      assert.equal(
        harness.dispatches('browser.dom').length,
        1,
        `a caller-chosen target must be executed exactly once: ${harness.stderrText()}`
      );
    } finally {
      harness.dispose();
    }
  });
});
