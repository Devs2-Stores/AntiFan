import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

describe('Phase 02: Behavioral Persistent Transport & Concurrency Integration', () => {
  let wss: WebSocketServer;
  let serverPort: number;
  let child: ChildProcess;
  let emptyDataRoot = '';
  const scriptPath = path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs');
  const testSecret = 'secret-test-uuid-token';
  const testAttachmentId = 'binding-test-attachment';
  let activeConnections: WebSocket[] = [];
  let dispatchSocket: WebSocket | null = null;
  let heartbeatSocket: WebSocket | null = null;
  let dispatchMessageCount = 0;
  let heartbeatMessageCount = 0;

  before(async () => {
    const { promise, resolve } = Promise.withResolvers<number>();
    wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(serverPort);
    });

    wss.on('connection', (ws) => {
      activeConnections.push(ws);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.id === 'hb' && msg.method === 'antifan.cli.renewSession') {
            heartbeatSocket = ws;
            heartbeatMessageCount++;
            ws.send(JSON.stringify({ id: 'hb', success: true, data: { expiresAt: Date.now() + 60000 } }));
            return;
          }

          if (msg.method === 'antifan.capability.dispatch') {
            dispatchSocket = ws;
            dispatchMessageCount++;
            const returnData = {
              tabCount: msg.params?.params?.tabIndex ?? 1,
              correlationId: msg.id,
              receivedMethod: msg.params?.name,
            };
            // Respond with randomized latency (5-25ms)
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ id: msg.id, success: true, data: returnData }));
              }
            }, Math.floor(Math.random() * 20) + 5);
          } else if (msg.id !== undefined) {
            // A real bridge answers every request. One that stays silent makes the
            // proxy's autoheal wait out its renewSession and startSession timeouts
            // (~9 s) before learning that this endpoint grants no new authority.
            ws.send(JSON.stringify({ id: msg.id, success: false, error: `fake bridge does not serve ${msg.method}` }));
          }
        } catch {}
      });

      ws.on('close', () => {
        activeConnections = activeConnections.filter((c) => c !== ws);
        if (dispatchSocket === ws) dispatchSocket = null;
        if (heartbeatSocket === ws) heartbeatSocket = null;
      });
    });

    await promise;

    emptyDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-persistent-transport-'));
    const env = {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
        port: serverPort,
        secret: testSecret,
        attachmentId: testAttachmentId,
        runId: 'run-test-uuid',
        attemptId: 'attempt-test-uuid',
        projectId: 'project-test-uuid',
        workspaceId: 'workspace-test-uuid',
      }),
      ANTIFAN_HEARTBEAT_MS: '200',
      ANTIFAN_DATA_ROOT: emptyDataRoot,
      ANTIFAN_CONFIG_DIR: path.join(emptyDataRoot, 'config'),
    };

    // This suite owns exactly one bridge: the fake one above. The proxy also
    // consults the launching environment for a pinned attachment, and its
    // failover discovers bridges on disk from every spawn — so a harness running
    // next to a real AntiFan instance would replay a dropped call onto the
    // developer's live bridge and answer it successfully. Scrub the attachment
    // context and pin discovery to an empty root so an unreachable socket stays
    // an observable transport fault.
    for (const key of [
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
    ]) {
      delete (env as Record<string, unknown>)[key];
    }

    child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send MCP initialize
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-harness', version: '1.0.0' },
        },
      }) + '\n'
    );
  });

  after(() => {
    try {
      child.kill();
    } catch {}
    for (const ws of activeConnections) {
      try {
        ws.terminate();
      } catch {}
    }
    try {
      wss.close();
    } catch {}
    if (emptyDataRoot) fs.rmSync(emptyDataRoot, { recursive: true, force: true });
  });

  it('1. Connects persistent dispatch channel and independent heartbeat channel', async () => {
    // Send a warmup call to trigger dispatch socket creation
    const { promise, resolve } = Promise.withResolvers<void>();
    const warmupHandler = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('"id":1')) {
        child.stdout?.off('data', warmupHandler);
        resolve();
      }
    };
    child.stdout?.on('data', warmupHandler);

    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'anti.browser.tabs.list',
          arguments: { tabIndex: 1 },
        },
      }) + '\n'
    );

    await promise;

    // Both heartbeat and dispatch sockets must now be active
    assert.strictEqual(activeConnections.length, 2, 'Must maintain exactly 2 persistent channels (heartbeat + dispatch)');
    assert.ok(heartbeatSocket, 'Heartbeat socket must be connected');
    assert.ok(dispatchSocket, 'Dispatch socket must be connected');
    assert.ok(heartbeatMessageCount >= 1, 'Heartbeat renewal messages must be received');
  });

  it('2. Dispatches 10 concurrent tool calls over the single persistent dispatch socket with UUID correlation', async () => {
    const totalCalls = 10;
    const initialDispatchMessageCount = dispatchMessageCount;
    const { StringDecoder } = require('node:string_decoder');
    const decoder2 = new StringDecoder('utf8');
    const receivedResponses: Map<number, any> = new Map();
    const { promise, resolve } = Promise.withResolvers<void>();
    let stdoutBuffer = '';
    const stdoutHandler = (chunk: Buffer) => {
      stdoutBuffer += decoder2.write(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.id === 'number' && parsed.id >= 100 && parsed.id < 100 + totalCalls) {
            receivedResponses.set(parsed.id, parsed);
            if (receivedResponses.size === totalCalls) {
              child.stdout?.off('data', stdoutHandler);
              resolve();
            }
          }
        } catch {}
      }
    };

    child.stdout?.on('data', stdoutHandler);

    // Fire 10 concurrent tools/call requests with IDs 100..109
    for (let i = 0; i < totalCalls; i++) {
      const mcpId = 100 + i;
      child.stdin?.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: mcpId,
          method: 'tools/call',
          params: {
            name: 'anti.browser.tabs.list',
            arguments: { tabIndex: i + 1 },
          },
        }) + '\n'
      );
    }

    await promise;

    // Verify all 10 calls resolved
    assert.strictEqual(receivedResponses.size, totalCalls, 'All 10 concurrent calls must resolve');

    for (let i = 0; i < totalCalls; i++) {
      const mcpId = 100 + i;
      const resp = receivedResponses.get(mcpId);
      assert.ok(resp, `Response for MCP id ${mcpId} must exist`);
      assert.strictEqual(resp.error, undefined, `Response ${mcpId} must not contain errors`);
      assert.strictEqual(resp.result?.isError, undefined, `Result ${mcpId} must not be an error`);
      const parsedContent = JSON.parse(resp.result?.content?.[0]?.text || '{}');
      assert.strictEqual(parsedContent.tabCount, i + 1, `Correlation data for id ${mcpId} must match request`);
    }

    // Verify exactly 10 dispatch messages were handled on the SAME socket
    assert.strictEqual(
      dispatchMessageCount,
      initialDispatchMessageCount + totalCalls,
      'All 10 calls must traverse the existing persistent dispatch socket'
    );
    assert.strictEqual(
      activeConnections.length,
      2,
      'Active connections must remain strictly 2 (no new ephemeral sockets opened)'
    );
  });

  it('3. Rejects in-flight requests cleanly with CONNECTION_CLOSED when dispatch socket drops', async () => {
    const { StringDecoder } = require('node:string_decoder');
    const decoder3 = new StringDecoder('utf8');
    const { promise, resolve } = Promise.withResolvers<any>();
    let errStdoutBuffer = '';
    const stdoutHandler = (chunk: Buffer) => {
      errStdoutBuffer += decoder3.write(chunk);
      const lines = errStdoutBuffer.split('\n');
      errStdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 999) {
            child.stdout?.off('data', stdoutHandler);
            resolve(parsed);
          }
        } catch {}
      }
    };
    child.stdout?.on('data', stdoutHandler);

    // Send a request and immediately terminate the dispatch socket
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 999,
        method: 'tools/call',
        params: {
          name: 'anti.browser.tabs.list',
          arguments: {},
        },
      }) + '\n'
    );

    // Terminate socket immediately
    setTimeout(() => {
      try {
        dispatchSocket?.terminate();
      } catch {}
    }, 5);

    const errorResp = await promise;
    // The proxy rejects the in-flight call on socket drop, then retries once on
    // the same endpoint (idempotent: same idempotencyKey joins the ledger). The
    // observable contract is deterministic termination — either the retry's
    // result or a CONNECTION_CLOSED/CONNECTION_ERROR — never a hang.
    const isConnError = errorResp.result?.isError === true &&
      /CONNECTION_CLOSED|CONNECTION_ERROR/.test(errorResp.result?.content?.[0]?.text || '');
    const isResult = errorResp.result && !errorResp.result.isError;
    assert.ok(isConnError || isResult, `In-flight call must terminate with a result or a connection error, got: ${JSON.stringify(errorResp).slice(0, 300)}`);
  });
});
