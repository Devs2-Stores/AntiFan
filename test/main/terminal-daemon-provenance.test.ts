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
import { WebSocketServer, type WebSocket } from 'ws';
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

  it('5. Daemon entry dispatch threads capsuleId into TerminalManager.createSession and startTerminal', () => {
    interface TerminalManagerTestHarness {
      spawn: (
        id: string,
        cwd: string,
        restoredBuffer?: string,
        initialCols?: number,
        initialRows?: number,
        minimumRows?: number,
        parentSessionId?: string,
        generation?: number,
        parentGeneration?: number
      ) => unknown;
      sessions: Map<string, unknown>;
      effectiveCreationCapsuleId?: string;
      currentCapsuleId?: string;
    }
    const tm = TerminalManager.getInstance();
    const tmInternal = tm as unknown as TerminalManagerTestHarness;
    const originalSpawn = tmInternal.spawn.bind(tmInternal);
    const spawnedSessions: Array<{ id: string; cwd: string; capsuleId: string }> = [];

    tmInternal.spawn = function (
      id: string,
      cwd: string,
      restoredBuffer = '',
      initialCols?: number,
      initialRows?: number,
      minimumRows = 4,
      parentSessionId?: string,
      generation?: number,
      parentGeneration?: number
    ) {
      const effectiveCapsuleId = tmInternal.effectiveCreationCapsuleId || tmInternal.currentCapsuleId || 'default';
      const record = {
        id,
        name: `Terminal ${id.replace('terminal-', '')}`,
        cwd: cwd || 'E:/Work/project',
        pty: null,
        buffer: restoredBuffer || '',
        capsuleId: effectiveCapsuleId,
        disposed: false,
        lastSeq: 0,
        sessionGeneration: 1,
        state: 'running' as const,
      };
      tmInternal.sessions.set(id, record);
      spawnedSessions.push({ id, cwd, capsuleId: effectiveCapsuleId });
      return record;
    };
    try {
      // (a) Simulate HOST_METHOD.newSession dispatch in daemon-entry.ts
      const pNew = { cwd: 'E:/Work/project-b', capsuleId: 'capsule-window-b' };
      const cwdNew = typeof pNew.cwd === 'string' && pNew.cwd ? pNew.cwd : undefined;
      const capsuleIdNew = typeof pNew.capsuleId === 'string' && pNew.capsuleId ? pNew.capsuleId : undefined;
      const sessionIdNew = tm.createSession(cwdNew, capsuleIdNew);

      const sessionNew = tm.getSession(sessionIdNew);
      assert.ok(sessionNew, 'session was created');
      assert.strictEqual(
        sessionNew?.capsuleId,
        'capsule-window-b',
        'TerminalManager must record capsuleId from daemon-entry dispatch'
      );

      // (b) Simulate HOST_METHOD.start dispatch in daemon-entry.ts
      tmInternal.sessions.clear();
      const pStart = { cwd: 'E:/Work/project-start', capsuleId: 'capsule-window-start' };
      const cwdStart = typeof pStart.cwd === 'string' && pStart.cwd ? pStart.cwd : undefined;
      const capsuleIdStart = typeof pStart.capsuleId === 'string' && pStart.capsuleId ? pStart.capsuleId : undefined;
      const started = tm.startTerminal(cwdStart, capsuleIdStart);

      assert.strictEqual(started, true);
      const activeId = tm.getActiveSessionId();
      const sessionStart = tm.getSession(activeId);
      assert.ok(sessionStart, 'startup session was created');
      assert.strictEqual(
        sessionStart?.capsuleId,
        'capsule-window-start',
        'TerminalManager startTerminal must record capsuleId from daemon-entry dispatch'
      );
    } finally {
      tmInternal.spawn = originalSpawn;
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
