/**
 * Terminal Daemon Provenance & Async/Sync Seam Test Suite (RC2).
 *
 * Verifies:
 * 1. DaemonTerminalProxy.createSession forwards capsuleId across the WebSocket wire in HOST_METHOD.newSession payload.
 * 2. DaemonTerminalProxy.startTerminal forwards capsuleId across the WebSocket wire in HOST_METHOD.start payload.
 * 3. Daemon entry point dispatch logic passes capsuleId to TerminalManager.createSession and startTerminal,
 *    persisting workspace provenance end-to-end.
 * 4. A synchronous read of proxy.createSession() cannot be mistaken for a session ID string:
 *    it returns an object (Promise), not a string, and cannot be passed bare where a string is expected.
 *    Awaiting it resolves to a valid string session ID.
 * 5. Capability catalogue terminal.create accepts optional capsuleId and forwards it to createSession,
 *    demonstrating the awaiting seam convention.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { DaemonTerminalProxy } from '../../src/main/terminal-daemon/daemon-client';
import { HOST_METHOD } from '../../src/main/terminal-daemon/protocol';
import type { BridgeRequestPayload, BridgeResponsePayload } from '../../src/shared/contracts';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerTerminalCapabilities } from '../../src/main/tools/terminal-capabilities';
import { issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-daemon-prov-test-'));
const PREVIOUS_CONFIG_DIR = process.env.ANTIFAN_CONFIG_DIR;
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
fs.mkdirSync(process.env.ANTIFAN_CONFIG_DIR, { recursive: true });

describe('Terminal Daemon Provenance & Async Seam Invariants (RC2)', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let serverPort = 0;
  let lastReceivedPayload: BridgeRequestPayload<Record<string, unknown>> | null = null;
  let activeWs: WebSocket | null = null;
  const recordedRequests: BridgeRequestPayload<Record<string, unknown>>[] = [];

  before(async () => {
    server = http.createServer();
    wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        activeWs = ws;
        ws.on('message', (raw) => {
          try {
            const parsed = JSON.parse(String(raw)) as BridgeRequestPayload<Record<string, unknown>>;
            lastReceivedPayload = parsed;
            recordedRequests.push(parsed);
            const { id, method, params } = parsed;

            if (method === HOST_METHOD.getSessionState) {
              const resp: BridgeResponsePayload = {
                id,
                success: true,
                data: {
                  activeSessionId: 'term-1',
                  sessions: [{ id: 'term-1', state: 'running', cwd: 'E:/Work/default', capsuleId: 'capsule-default' }],
                  splitSessionId: '',
                  snapshot: '',
                  snapshotThroughSeq: 0,
                },
              };
              ws.send(JSON.stringify(resp));
              return;
            }

            if (method === HOST_METHOD.newSession) {
              const resp: BridgeResponsePayload = {
                id,
                success: true,
                data: {
                  sessionId: 'term-new-mock',
                  sessions: [],
                  activeSessionId: 'term-new-mock',
                },
              };
              ws.send(JSON.stringify(resp));
              return;
            }

            if (method === HOST_METHOD.start) {
              const resp: BridgeResponsePayload = {
                id,
                success: true,
                data: {
                  started: true,
                  sessions: [],
                  activeSessionId: 'term-start-mock',
                },
              };
              ws.send(JSON.stringify(resp));
              return;
            }

            const fallback: BridgeResponsePayload = { id, success: true, data: {} };
            ws.send(JSON.stringify(fallback));
          } catch (e) {
            // ignore malformed test frames
          }
        });
        wss.emit('connection', ws, req);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    serverPort = addr.port;
  });

  after(async () => {
    if (activeWs) {
      try { activeWs.close(); } catch {}
    }
    wss.close();
    server.close();
    if (PREVIOUS_CONFIG_DIR !== undefined) {
      process.env.ANTIFAN_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
    } else {
      delete process.env.ANTIFAN_CONFIG_DIR;
    }
    try {
      fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('1. DaemonTerminalProxy.createSession forwards capsuleId across the WebSocket wire', async () => {
    const proxy = new DaemonTerminalProxy({ port: serverPort, token: 'test-token' });
    try {
      recordedRequests.length = 0;
      const returnedSessionId = await proxy.createSession('E:/Work/project-b', 'capsule-window-b');

      assert.strictEqual(returnedSessionId, 'term-new-mock');
      const req = recordedRequests.find((r) => r.method === HOST_METHOD.newSession);
      assert.ok(req, 'HOST_METHOD.newSession was dispatched over wire');
      assert.strictEqual(req?.params?.cwd, 'E:/Work/project-b');
      assert.strictEqual(
        req?.params?.capsuleId,
        'capsule-window-b',
        'capsuleId must be forwarded in newSession payload'
      );
    } finally {
      proxy.dispose();
    }
  });

  it('2. DaemonTerminalProxy.createSession preserves existing behavior when capsuleId is omitted', async () => {
    const proxy = new DaemonTerminalProxy({ port: serverPort, token: 'test-token' });
    try {
      recordedRequests.length = 0;
      const returnedSessionId = await proxy.createSession('E:/Work/project-c');

      assert.strictEqual(returnedSessionId, 'term-new-mock');
      const req = recordedRequests.find((r) => r.method === HOST_METHOD.newSession);
      assert.ok(req, 'HOST_METHOD.newSession was dispatched over wire');
      assert.strictEqual(req?.params?.cwd, 'E:/Work/project-c');
      assert.strictEqual(
        req?.params?.capsuleId,
        undefined,
        'capsuleId must not be present when omitted'
      );
    } finally {
      proxy.dispose();
    }
  });

  it('3. DaemonTerminalProxy.startTerminal forwards capsuleId across the WebSocket wire', async () => {
    const proxy = new DaemonTerminalProxy({ port: serverPort, token: 'test-token' });
    try {
      recordedRequests.length = 0;
      const started = await proxy.startTerminal('E:/Work/project-start', 'capsule-window-start');

      assert.strictEqual(started, true);
      const req = recordedRequests.find((r) => r.method === HOST_METHOD.start);
      assert.ok(req, 'HOST_METHOD.start was dispatched over wire');
      assert.strictEqual(req?.params?.cwd, 'E:/Work/project-start');
      assert.strictEqual(
        req?.params?.capsuleId,
        'capsule-window-start',
        'capsuleId must be forwarded in start payload'
      );
    } finally {
      proxy.dispose();
    }
  });

  it('4. A synchronous read of proxy.createSession cannot be mistaken for a session id', async () => {
    const proxy = new DaemonTerminalProxy({ port: serverPort, token: 'test-token' });
    try {
      // Synchronous read (not awaited)
      const syncResult = proxy.createSession('E:/Work/project-b', 'capsule-window-b');

      // (a) Must NOT be a string
      assert.notStrictEqual(
        typeof syncResult,
        'string',
        'synchronous read of proxy.createSession must not be a string'
      );

      // (b) Must be an object / Promise instance
      assert.strictEqual(
        typeof syncResult,
        'object',
        'synchronous return must be an object'
      );
      assert.strictEqual(
        syncResult instanceof Promise,
        true,
        'synchronous return must be an instance of Promise'
      );
      const isThenable = typeof syncResult === 'object' && syncResult !== null && 'then' in syncResult && typeof syncResult.then === 'function';
      assert.strictEqual(
        isThenable,
        true,
        'synchronous return must be thenable'
      );

      // (c) Demonstrates the serialisation hazard: in JSON RPC or unawaited string contexts,
      // a Promise serializes to empty object `{}`
      const jsonOutput = JSON.stringify({ sessionId: syncResult });
      assert.strictEqual(
        jsonOutput,
        '{"sessionId":{}}',
        'unawaited Promise serializes to empty object, proving why synchronous string assumption fails'
      );

      // (d) Proper awaiting convention yields the genuine session id string
      const resolvedSessionId = await syncResult;
      assert.strictEqual(typeof resolvedSessionId, 'string');
      assert.strictEqual(resolvedSessionId, 'term-new-mock');
    } finally {
      proxy.dispose();
    }
  });

  it('5. Daemon entry dispatch threads capsuleId into TerminalManager.createSession and startTerminal', async () => {
    const entryPath = path.resolve(process.cwd(), '.compiled/src/main/terminal-daemon/daemon-entry.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-entry-prov-test-'));
    const token = 'test-token-prov-' + Date.now();

    const child = spawn(process.execPath, [entryPath, '--port', '0', '--cwd', tmpDir], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ANTIFAN_TERMINAL_HOST_TOKEN: token,
        ANTIFAN_DATA_ROOT: tmpDir,
        ANTIFAN_CONFIG_DIR: tmpDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let port = 0;
    let stderrBuf = '';
    child.stderr?.on('data', (d) => {
      stderrBuf += d.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        child.stdout?.on('data', (d) => {
          buf += d.toString();
          const match = buf.match(/TERMINAL_HOST_READY\s+(\{[^\n]+\})/);
          if (match && match[1]) {
            port = JSON.parse(match[1]).port;
            resolve();
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error('Daemon host exited early with code ' + code + '\n' + stderrBuf)));
      });

      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { 'x-antifan-token': token },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      let reqId = 1;
      function call(method: string, params: Record<string, unknown>): Promise<BridgeResponsePayload> {
        const id = `prov-req-${reqId++}`;
        return new Promise<BridgeResponsePayload>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.off('message', handler);
            reject(new Error(`Daemon RPC timeout for method ${method}`));
          }, 10_000);
          const handler = (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as BridgeResponsePayload;
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              resolve(msg);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });
      }

      try {
        interface NewSessionData {
          sessionId: string;
          sessions: Array<{ id: string; capsuleId?: string }>;
        }
        interface SessionSummaryRecord {
          id: string;
          capsuleId?: string;
        }
        interface GetSessionData {
          session?: SessionSummaryRecord | null;
        }
        interface ListSessionsData {
          sessions: Array<{ id: string }>;
        }
        interface StartSessionData {
          started: boolean;
          activeSessionId: string;
        }

        // (a) Execute production HOST_METHOD.newSession dispatch in daemon-entry.ts
        const newRes = await call(HOST_METHOD.newSession, {
          cwd: 'E:/Work/project-b',
          capsuleId: 'capsule-window-b',
        });
        assert.strictEqual(newRes.success, true, 'HOST_METHOD.newSession must succeed');
        const newData = newRes.data as NewSessionData;
        const sessionIdNew = newData.sessionId;

        const stateNew = await call(HOST_METHOD.getSession, { sessionId: sessionIdNew });
        assert.strictEqual(stateNew.success, true, 'HOST_METHOD.getSession must succeed');
        const stateData = stateNew.data as GetSessionData;
        const sessionNew = stateData?.session;
        assert.ok(sessionNew, 'session was created by production daemon-entry');
        assert.strictEqual(
          sessionNew?.capsuleId,
          'capsule-window-b',
          'TerminalManager must record capsuleId from production daemon-entry newSession dispatch'
        );

        // (a2) A watcher minted with role meta is already guarded in the very reply that names it,
        // and the daemon refuses to sleep it.
        const watcherRes = await call(HOST_METHOD.newSession, {
          cwd: 'E:/Work/project-b',
          capsuleId: 'capsule-window-b',
          role: 'sync',
          idlePolicy: 'never',
          spaceTerminalId: 'sync',
        });
        assert.strictEqual(watcherRes.success, true, 'newSession with role meta must succeed');
        const watcherData = watcherRes.data as {
          sessionId: string;
          sessions: Array<{ id: string; role?: string; idlePolicy?: string; spaceTerminalId?: string }>;
        };
        const minted = watcherData.sessions.find((s) => s.id === watcherData.sessionId);
        assert.strictEqual(minted?.role, 'sync');
        assert.strictEqual(minted?.idlePolicy, 'never');
        assert.strictEqual(minted?.spaceTerminalId, 'sync');
        const sleepRes = await call(HOST_METHOD.sleepSession, { sessionId: watcherData.sessionId });
        assert.deepStrictEqual(
          (sleepRes.data as { result?: unknown }).result,
          { ok: false, reason: 'SLEEP_REFUSED_WATCHER' },
        );

        // (b) Execute production HOST_METHOD.start dispatch in daemon-entry.ts
        const listRes = await call(HOST_METHOD.listSessions, {});
        const listData = listRes.data as ListSessionsData;
        for (const s of listData.sessions) {
          await call(HOST_METHOD.closeSession, { sessionId: s.id, force: true });
        }
        await call(HOST_METHOD.persistSync, {});
        const startRes = await call(HOST_METHOD.start, {
          cwd: 'E:/Work/project-start',
          capsuleId: 'capsule-window-start',
        });
        assert.strictEqual(startRes.success, true, 'HOST_METHOD.start must succeed');
        const startData = startRes.data as StartSessionData;
        const activeId = startData.activeSessionId;

        const stateStart = await call(HOST_METHOD.getSession, { sessionId: activeId });
        assert.strictEqual(stateStart.success, true, 'HOST_METHOD.getSession must succeed for startup session');
        const startStateData = stateStart.data as GetSessionData;
        const sessionStart = startStateData?.session;
        assert.ok(sessionStart, 'startup session was created by production daemon-entry');
        assert.strictEqual(
          sessionStart?.capsuleId,
          'capsule-window-start',
          'TerminalManager startTerminal must record capsuleId from production daemon-entry start dispatch'
        );
      } finally {
        try { ws.close(); } catch {}
      }
    } finally {
      try { child.kill(); } catch {}
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.on('exit', () => resolve());
      });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('6. terminal.create capability forwards capsuleId and resolves session ID string', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });

    const calls: Array<{ cwd?: string; capsuleId?: string }> = [];
    const asyncFacade = {
      createSession: async (cwd?: string, capsuleId?: string) => {
        calls.push({ cwd, capsuleId });
        return 'terminal-async-123';
      },
      createSplitSession: async () => 'terminal-async-split',
      getSession: (id: string) => ({ id, sessionGeneration: 1 }),
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;

    const ownership = {
      ownerTabId: (attachmentId: string) => (attachmentId === 'att-1' ? 'tab-1' : undefined),
      allowsTab: () => true,
      isAgentTerminal: () => false,
      bind: () => true,
      tabAffiliation: () => ({ live: true }),
    };

    registerTerminalCapabilities(catalogue, asyncFacade, ownership);

    const context = {
      attachmentId: 'att-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      projectId,
      workspaceId,
      backendId: 'backend-1',
      hostEpoch: 1,
      invocationId: 'inv-1',
      lease,
      leaseToken: lease.token,
      grant: 'write' as const,
    };

    const res = (await catalogue.dispatch(
      'terminal.create',
      { cwd: 'E:/Work/my-project', capsuleId: 'capsule-my-window' },
      context
    )) as { sessionId: string; ownerBound?: boolean };

    assert.strictEqual(res.sessionId, 'terminal-async-123');
    assert.deepStrictEqual(calls, [{ cwd: 'E:/Work/my-project', capsuleId: 'capsule-my-window' }]);
  });
});
