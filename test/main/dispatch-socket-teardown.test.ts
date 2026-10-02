/**
 * Regression: what a caller learns when the shared dispatch socket is torn down
 * *under an in-flight request*.
 *
 * Recorded production symptom (AntiFan Browser Desktop, `anti.browser.dump_dom`):
 *
 *   {"code":"CONNECTION_CLOSED",
 *    "message":"Dispatch WebSocket closed while request in flight (code=1005)",
 *    "closeCode":1005}
 *
 * Close code 1005 is NOT an abnormal closure. `ws` reports 1006 when the socket
 * dies with no close frame at all (`node_modules/ws/lib/websocket.js` initialises
 * `_closeCode = 1006`), and reports 1005 only when a close frame with a
 * ZERO-LENGTH payload arrived (`node_modules/ws/lib/receiver.js`, control-frame
 * branch: `emit('conclude', 1005, EMPTY_BUFFER)`). An empty close frame is what
 * `WebSocket.prototype.close()` with no arguments sends — which is exactly what
 * `BridgeServer.dispose()` does to every live client
 * (`for (const client of this.clients) client.close()`).
 *
 * That one fact is what these tests pin, and it is what excludes the whole
 * "a timeout/heartbeat killed the busy socket" family of explanations:
 *
 *   1. `close()` with no code (bridge dispose) => originating closeCode 1005.
 *   2. `terminate()` (bridge heartbeat reaper, slow-client reaper, or force-kill)
 *      => originating closeCode 1006. Recovery's later failure is the top-level
 *      diagnostic; its details retain the original dispatch attribution.
 *   3. One teardown rejects EVERY in-flight call on that socket, but a late
 *      close from an old socket must not reject calls on its replacement.
 *
 * The mock bridge leaves dispatches unanswered unless a test explicitly answers
 * them, so requests stay in flight like a long DOM dump. The proxy is real in
 * this repo; no AntiFan Desktop instance is contacted (the bootstrap is pinned to
 * the mock port and every ambient discovery input is scrubbed, mirroring
 * `test/main/mcp-persistent-transport.test.ts`).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

const PROXY_SCRIPT = path.resolve(process.cwd(), 'scripts', 'antifan-omp-mcp.cjs');
const BOUND_TAB_ID = 'tab-1005-regression';

/**
 * Ambient inputs that would let the proxy leave this mock and talk to a real
 * desktop (a pinned attachment, or terminal context that enables disk discovery).
 * A harness leaving these set would replay a dropped call onto the live instance
 * and answer it successfully — hiding the very fault under test.
 */
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

interface DispatchRecord {
  socket: WebSocket;
  id: string;
  capability: string | undefined;
}

interface TransportDiagnostic {
  code?: string;
  message?: string;
  closeCode?: number;
  details?: {
    previousFailure?: {
      code?: string;
      closeCode?: number;
      transmitted?: boolean;
      signedAttachmentId?: string;
    };
  };
}

interface Harness {
  child: ChildProcess;
  dispatches: DispatchRecord[];
  /** Wait until at least `count` dispatch requests have reached the mock bridge. */
  waitForDispatches: (count: number, timeoutMs: number) => Promise<DispatchRecord[]>;
  /** Emulate `BridgeServer.dispose()`: a graceful close frame carrying NO status. */
  closeLikeDispose: (socket: WebSocket) => void;
  /** Emulate the heartbeat reaper / a force-killed app: no close frame at all. */
  closeLikeTerminate: (socket: WebSocket) => void;
  /**
   * Stop listening so the proxy's own autoheal + last-ditch reconnect cannot
   * answer the call on a fresh socket. Without this the retry succeeds and the
   * lost-request path under test never becomes observable.
   */
  refuseFurtherConnections: () => void;
  callTool: (mcpId: number, name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  waitForLateClose: () => Promise<void>;
  answerDispatch: (record: DispatchRecord) => void;
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
 * The proxy reports the transport fault as an MCP error *result* whose text is the
 * JSON detail string; unwrap the envelope and parse it so assertions read typed
 * fields (code / closeCode) rather than pattern-matching prose.
 */
function unwrapDiagnostic(response: unknown): TransportDiagnostic {
  const envelope = response as { result?: { content?: Array<{ text?: string }> } };
  const text = envelope?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return {};
  const start = text.indexOf('{');
  if (start === -1) return {};
  try {
    return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as TransportDiagnostic;
  } catch {
    return {};
  }
}

function requireRecord(record: DispatchRecord | undefined, message: string): DispatchRecord {
  if (!record) throw new Error(message);
  return record;
}

async function startHarness(options: { delayOldClose?: boolean } = {}): Promise<Harness> {
  assert.ok(fs.existsSync(PROXY_SCRIPT), `proxy script must exist: ${PROXY_SCRIPT}`);

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert.ok(port > 0, 'mock bridge must bind an ephemeral port');

  const connections = new Set<WebSocket>();
  const dispatches: DispatchRecord[] = [];
  let dispatchWatchers: Array<() => void> = [];
  let refusing = false;
  let releaseLateClose: () => void = () => {};
  const lateClose = new Promise<void>((resolve) => { releaseLateClose = resolve; });

  wss.on('connection', (ws) => {
    if (refusing) {
      ws.terminate();
      return;
    }
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    ws.on('message', (raw) => {
      let message: { id?: string; method?: string; params?: { name?: string } };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.method === 'harness.lateCloseReleased') {
        releaseLateClose();
        return;
      }
      // The dedicated heartbeat channel must stay answerable, otherwise the proxy
      // spends the test re-connecting it instead of exercising the dispatch path.
      if (message.id === 'hb') {
        ws.send(JSON.stringify({ id: 'hb', success: true, data: { expiresAt: Date.now() + 60_000 } }));
        return;
      }
      if (message.method === 'antifan.capability.dispatch') {
        dispatches.push({ socket: ws, capability: message.params?.name, id: String(message.id) });
        // Deliberately unanswered: a slow capability (a large DOM dump) is the
        // situation whose socket teardown this suite characterises.
        for (const watcher of dispatchWatchers) watcher();
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
      secret: 'secret-1005-regression',
      attachmentId: 'attachment-1005-regression',
      authorityRevision: 'rev-1',
      runId: 'run-1005',
      attemptId: 'attempt-1005',
      projectId: 'project-1005',
      workspaceId: 'workspace-1005',
      tabId: BOUND_TAB_ID,
    }),
    // This suite owns dispatch semantics, not renewal cadence.
    ANTIFAN_HEARTBEAT_MS: '60000',
  };
  for (const key of DISCOVERY_ENV_KEYS) delete env[key];

  // Control the client event ordering, not the product handlers: a real old
  // socket close is held until a dispatch is pending on its replacement.
  const delayedCloseBootstrap = `
    const { WebSocket } = require('ws');
    const originalEmit = WebSocket.prototype.emit;
    const originalSend = WebSocket.prototype.send;
    let oldSocket;
    let heldClose;
    let released = false;
    WebSocket.prototype.emit = function(event, ...args) {
      if (event === 'close' && this === oldSocket && !released) {
        heldClose = () => originalEmit.call(this, event, ...args);
        originalEmit.call(this, 'error', new Error('Old dispatch transport failed before its late close'));
        return true;
      }
      return originalEmit.call(this, event, ...args);
    };
    WebSocket.prototype.send = function(data, ...args) {
      const message = JSON.parse(String(data));
      if (message.method === 'antifan.capability.dispatch' && !oldSocket) oldSocket = this;
      const result = originalSend.call(this, data, ...args);
      if (message.method === 'antifan.capability.dispatch' && this !== oldSocket && heldClose && !released) {
        released = true;
        queueMicrotask(() => {
          heldClose();
          originalSend.call(this, JSON.stringify({ method: 'harness.lateCloseReleased' }));
        });
      }
      return result;
    };
    process.argv[1] = ${JSON.stringify(PROXY_SCRIPT)};
    require('node:module').runMain();
  `;
  const child = spawn(process.execPath, options.delayOldClose ? ['--eval', delayedCloseBootstrap] : [PROXY_SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Drain stderr: a full pipe would stall the child, and the text is the first
  // thing a human wants when an assertion here fails.
  let stderrBuffer = '';
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

  // Serve the MCP handshake before any tool call: the SDK server answers
  // `initialize` first, and a tools/call raced ahead of it would not be a
  // transport assertion.
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
          clientInfo: { name: 'dispatch-teardown-harness', version: '1.0.0' },
        },
      }) + '\n'
    );
  });
  await withTimeout(initialized, 15_000, 'MCP initialize handshake');

  const waitForDispatches = (count: number, timeoutMs: number): Promise<DispatchRecord[]> => {
    if (dispatches.length >= count) return Promise.resolve(dispatches.slice(0, count));
    return new Promise<DispatchRecord[]>((resolve, reject) => {
      const watcher = () => {
        if (dispatches.length < count) return;
        clearTimeout(timer);
        dispatchWatchers = dispatchWatchers.filter((entry) => entry !== watcher);
        resolve(dispatches.slice(0, count));
      };
      const timer = setTimeout(() => {
        dispatchWatchers = dispatchWatchers.filter((entry) => entry !== watcher);
        reject(new Error(`expected ${count} in-flight dispatch request(s), saw ${dispatches.length}${stderrBuffer ? `\n${stderrBuffer}` : ''}`));
      }, timeoutMs);
      dispatchWatchers.push(watcher);
    });
  };

  return {
    child,
    dispatches,
    waitForDispatches,
    // Exactly `BridgeServer.dispose()`: `ws.close()` with neither code nor reason.
    closeLikeDispose: (socket: WebSocket) => socket.close(),
    // Exactly the heartbeat reaper / slow-client reaper / a force-killed app.
    closeLikeTerminate: (socket: WebSocket) => socket.terminate(),
    refuseFurtherConnections: () => {
      refusing = true;
      wss.close();
    },
    callTool,
    waitForLateClose: () => withTimeout(lateClose, 15_000, 'old socket close must occur after replacement dispatch'),
    answerDispatch: (record) => record.socket.send(JSON.stringify({ id: record.id, success: true, data: { ok: true } })),
    dispose: () => {
      refusing = true;
      try { child.kill(); } catch {}
      for (const ws of connections) {
        try { ws.terminate(); } catch {}
      }
      try { wss.close(); } catch {}
    },
  };
}

describe('Dispatch socket teardown: the caller must learn the real cause', () => {
  it('1. An empty close frame (bridge dispose) surfaces as closeCode 1005, never as a timeout', async () => {
    const harness = await startHarness();
    try {
      const call = harness.callTool(501, 'anti.browser.dump_dom', { outputPath: 'scratch/dispatch-1005.html' });
      const inFlight = requireRecord(
        (await harness.waitForDispatches(1, 15_000))[0],
        'the dump_dom dispatch must be in flight before the teardown'
      );
      assert.strictEqual(
        inFlight.capability,
        'browser.dump_dom',
        'the advertised dotted tool name must resolve onto the registered capability'
      );

      // Failover must not be able to rescue the call, otherwise the retry answers
      // it and the lost-request diagnostic never becomes observable.
      harness.refuseFurtherConnections();
      harness.closeLikeDispose(inFlight.socket);

      const response = await call;
      const diagnostic = unwrapDiagnostic(response);
      const text = JSON.stringify(response);

      assert.strictEqual(diagnostic.code, 'CONNECTION_FAILED', `latest reconnect failure must surface: ${text}`);
      assert.strictEqual(diagnostic.details?.previousFailure?.code, 'CONNECTION_CLOSED', 'original dispatch close stays attributable');
      assert.strictEqual(diagnostic.details?.previousFailure?.transmitted, true, 'originating frame was dispatched, not a heartbeat or initial connect failure');
      assert.strictEqual(
        diagnostic.details?.previousFailure?.closeCode,
        1005,
        'an empty close frame is the only thing ws reports as 1005; a 1006 here would mean the teardown sent no frame at all'
      );
      assert.ok(
        !/timeout|heartbeat|idle/i.test(text),
        `a graceful teardown must never be reported as a timeout/heartbeat fault: ${text}`
      );
    } finally {
      harness.dispose();
    }
  });

  it('2. Control: terminate() (heartbeat reaper / force-kill) surfaces as closeCode 1006', async () => {
    const harness = await startHarness();
    try {
      const call = harness.callTool(502, 'anti.browser.dump_dom', { outputPath: 'scratch/dispatch-1006.html' });
      const inFlight = requireRecord(
        (await harness.waitForDispatches(1, 15_000))[0],
        'the dump_dom dispatch must be in flight before the teardown'
      );

      harness.refuseFurtherConnections();
      harness.closeLikeTerminate(inFlight.socket);

      const response = await call;
      const diagnostic = unwrapDiagnostic(response);

      assert.strictEqual(diagnostic.code, 'CONNECTION_FAILED', `latest reconnect failure must surface: ${JSON.stringify(response)}`);
      assert.strictEqual(diagnostic.details?.previousFailure?.code, 'CONNECTION_CLOSED', 'original dispatch close stays attributable');
      assert.strictEqual(diagnostic.details?.previousFailure?.transmitted, true, 'termination occurred while dispatch was in flight');
      assert.strictEqual(
        diagnostic.details?.previousFailure?.closeCode,
        1006,
        'terminate() destroys the socket with no close frame, so the peer must report 1006 — the code that distinguishes it from the recorded 1005'
      );
    } finally {
      harness.dispose();
    }
  });

  it('3. Current contract: one teardown rejects every in-flight call on the channel', async () => {
    const harness = await startHarness();
    try {
      const dump = harness.callTool(601, 'anti.browser.dump_dom', { outputPath: 'scratch/blast-radius.html' });
      const inspect = harness.callTool(602, 'anti.inspect.dom', { selector: 'body' });
      const inFlight = await harness.waitForDispatches(2, 15_000);
      const dying = requireRecord(inFlight[0], 'the first dispatch must be in flight before the teardown');
      assert.deepStrictEqual(
        inFlight.map((entry) => entry.capability).sort(),
        ['browser.dom', 'browser.dump_dom'],
        'both capabilities must have reached the bridge before the teardown'
      );
      assert.strictEqual(inFlight[1]?.socket, dying.socket, 'both calls must occupy the same dying channel');

      harness.refuseFurtherConnections();
      harness.closeLikeDispose(dying.socket);

      const [dumpResponse, inspectResponse] = await Promise.all([dump, inspect]);
      for (const [label, response] of [['dump_dom', dumpResponse], ['inspect.dom', inspectResponse]] as const) {
        const diagnostic = unwrapDiagnostic(response);
        assert.strictEqual(
          diagnostic.code,
          'CONNECTION_FAILED',
          `${label} must be terminally rejected, not left hanging: ${JSON.stringify(response)}`
        );
        assert.strictEqual(diagnostic.details?.previousFailure?.code, 'CONNECTION_CLOSED', `${label} retains the originating teardown`);
        assert.strictEqual(diagnostic.details?.previousFailure?.transmitted, true, `${label} was in flight on the dying socket`);
        assert.strictEqual(
          diagnostic.details?.previousFailure?.closeCode,
          1005,
          `${label} died from a teardown it did not cause; today the close status is the only attribution it gets`
        );
      }
    } finally {
      harness.dispose();
    }
  });

  it('4. A late old-socket close leaves the replacement socket call pending until its own response', async () => {
    const harness = await startHarness({ delayOldClose: true });
    try {
      let settled = false;
      const inspect = harness.callTool(701, 'anti.inspect.dom', { selector: 'body' }).then((response) => {
        settled = true;
        return response;
      });
      const old = requireRecord((await harness.waitForDispatches(1, 15_000))[0], 'old socket dispatch must be pending');
      harness.closeLikeDispose(old.socket);
      const replacement = requireRecord((await harness.waitForDispatches(2, 15_000))[1], 'replacement dispatch must reach the bridge');
      assert.notStrictEqual(replacement.socket, old.socket, 'survivor must be on a different socket, not a same-channel sibling');
      await harness.waitForLateClose();
      // A second round-trip is a process ordering barrier: the child has already
      // processed the injected real close event before sending the marker.
      const sibling = harness.callTool(702, 'anti.inspect.dom', { selector: 'html' });
      const siblingDispatch = requireRecord((await harness.waitForDispatches(3, 15_000))[2], 'replacement sibling must dispatch after late close');
      assert.strictEqual(siblingDispatch.socket, replacement.socket, 'late close must not clear the live replacement');
      assert.strictEqual(settled, false, 'replacement call must stay pending across the old socket close');
      harness.answerDispatch(replacement);
      harness.answerDispatch(siblingDispatch);
      const [inspectResponse, siblingResponse] = await Promise.all([inspect, sibling]);
      for (const response of [inspectResponse, siblingResponse]) {
        assert.notStrictEqual((response.result as { isError?: boolean } | undefined)?.isError, true, JSON.stringify(response));
        assert.strictEqual(unwrapDiagnostic(response).code, undefined, 'only its own successful response settles a replacement call');
      }
    } finally {
      harness.dispose();
    }
  });
});
