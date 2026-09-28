/**
 * Terminal Daemon Client — socket close before handshake settling invariant.
 *
 * If the peer socket closes before the handshake completes, connect() must settle
 * (reject) within a bounded time rather than hanging forever, and a subsequent
 * connect() must be able to retry cleanly without poison.
 *
 * It also covers the proxy's two other contracts: a write resolves only when its RPC
 * settles, and the facade can answer a window's capsule scope from the summaries it
 * caches (the host asks it who may see which session).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DaemonClient, DaemonTerminalProxy, HANDSHAKE_TIMEOUT_MS } from '../../src/main/terminal-daemon/daemon-client';
import { HOST_METHOD } from '../../src/main/terminal-daemon/protocol';

const SETTLE_BOUND_MS = 2000;

/** Helper to race a promise against a deterministic timeout. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('DaemonClient — connection handshake invariants', () => {
  it('settles (rejects) within bound when TCP peer accepts and immediately ends connection without upgrade', async () => {
    let connectionCount = 0;
    const openSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      connectionCount++;
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
      socket.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    const client = new DaemonClient({ port: addr.port, token: 'test-token' });

    try {
      // First connect attempt must reject within bound, never hang.
      await assert.rejects(
        withTimeout(client.connect(), SETTLE_BOUND_MS, 'first connect() attempt'),
        /socket hang up|ECONNRESET|daemon socket closed before handshake/
      );
      assert.strictEqual(connectionCount, 1, 'server accepted first TCP connection');

      // Retry hygiene: a second connect() must attempt a new connection, not stay poisoned.
      await assert.rejects(
        withTimeout(client.connect(), SETTLE_BOUND_MS, 'second connect() attempt'),
        /socket hang up|ECONNRESET|daemon socket closed before handshake/
      );
      assert.strictEqual(connectionCount, 2, 'second connect() retried on server');
    } finally {
      client.close();
      for (const s of openSockets) s.destroy();
      server.close();
    }
  });

  it('allows successful retry after an initial abrupt TCP connection closure', async () => {
    let shouldReject = true;
    let socketCloseCount = 0;
    const openSockets = new Set<net.Socket>();
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });

    server.on('connection', (s) => {
      openSockets.add(s);
      s.on('close', () => openSockets.delete(s));
    });

    server.on('upgrade', (req, socket, head) => {
      if (shouldReject) {
        socketCloseCount++;
        socket.destroy();
      } else {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    const client = new DaemonClient({ port: addr.port, token: 'test-token' });

    try {
      // Attempt 1: abrupt destruction -> must reject within bound.
      await assert.rejects(
        withTimeout(client.connect(), SETTLE_BOUND_MS, 'initial failed connect()'),
        /ECONNRESET|socket hang up|daemon socket closed before handshake/
      );
      assert.strictEqual(socketCloseCount, 1);
      assert.strictEqual(client.connected, false);

      // Attempt 2: server becomes healthy -> retry must resolve within bound.
      shouldReject = false;
      await withTimeout(client.connect(), SETTLE_BOUND_MS, 'healthy retry connect()');
      assert.strictEqual(client.connected, true);
    } finally {
      client.close();
      for (const s of openSockets) s.destroy();
      wss.close();
      server.close();
    }
  });

  it('settles (rejects) when socket emits close event before handshake without an error event', async () => {
    const openSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    const client = new DaemonClient({ port: addr.port, token: 'test-token' });

    try {
      const connectPromise = client.connect();

      // Trigger socket close without preceding error event
      const ws = (client as unknown as { ws: WebSocket }).ws;
      ws.emit('close', 1006, Buffer.from('abrupt peer drop'));

      await assert.rejects(
        withTimeout(connectPromise, SETTLE_BOUND_MS, 'close without error connect()'),
        /daemon socket closed before handshake/
      );
    } finally {
      client.close();
      for (const s of openSockets) s.destroy();
      server.close();
    }
  });

  it('settles (rejects) when client is closed while connect is in flight without stranding callers', async () => {
    const openSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    const client = new DaemonClient({ port: addr.port, token: 'test-token' });

    try {
      const connectPromise = client.connect();

      // Close client while connection is in flight.
      client.close();

      // connect() promise must settle (reject), never hang.
      await assert.rejects(
        withTimeout(connectPromise, SETTLE_BOUND_MS, 'in-flight close connect()'),
        /daemon socket closed before handshake|closed before the connection was established|daemon socket closed/
      );
    } finally {
      client.close();
      for (const s of openSockets) s.destroy();
      server.close();
    }
  });

  it('settles (rejects) when TCP peer accepts but never completes WebSocket upgrade within handshake timeout', async () => {
    const openSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
      // Accept connection but never write any response
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    const client = new DaemonClient({ port: addr.port, token: 'test-token' });

    try {
      // Pass a short timeout (150ms) to test deadline expiration without stalling test suite
      await assert.rejects(
        withTimeout(client.connect(150), SETTLE_BOUND_MS, 'silent peer handshake timeout'),
        /daemon handshake timed out after 150ms/
      );
      assert.strictEqual(client.connected, false);
    } finally {
      client.close();
      for (const s of openSockets) s.destroy();
      server.close();
    }
  });
});

describe('DaemonTerminalProxy — write settlement contract', () => {
  /**
   * The proxy is installed as the process-wide terminal singleton by cast, so close
   * admissions release from whatever write() returns: it must resolve only once the
   * daemon RPC settles — true on delivery, false on failure, never rejecting — or an
   * admitted write would read as finished while the daemon still holds the input.
   */
  function proxyWithCalls(): {
    proxy: DaemonTerminalProxy;
    calls: Array<{ method: string; params: Record<string, unknown>; deferred: PromiseWithResolvers<unknown> }>;
  } {
    const calls: Array<{ method: string; params: Record<string, unknown>; deferred: PromiseWithResolvers<unknown> }> = [];
    const client = {
      call(method: string, params: Record<string, unknown>) {
        const deferred = Promise.withResolvers<unknown>();
        calls.push({ method, params, deferred });
        return deferred.promise;
      },
    };
    // Inject the transport as a record field: `client` is private and readonly, and
    // constructing the proxy for real would open a socket — the test only needs the seam.
    const proxy = Object.create(DaemonTerminalProxy.prototype) as Record<string, unknown>;
    proxy.client = client;
    return { proxy: proxy as unknown as DaemonTerminalProxy, calls };
  }

  it('write/writeTo return a promise that resolves true only after the daemon RPC settles', async () => {
    const { proxy, calls } = proxyWithCalls();

    const writeResult = proxy.write('ls\n');
    const writeToResult = proxy.writeTo('terminal-2', 'pwd\n');

    assert.equal(typeof writeResult.then, 'function', 'write must surface the RPC promise, not a sync boolean');
    assert.equal(typeof writeToResult.then, 'function', 'writeTo must surface the RPC promise, not a sync boolean');
    assert.equal(calls.length, 2);
    assert.deepStrictEqual(
      calls.map((c) => ({ method: c.method, params: c.params })),
      [
        { method: HOST_METHOD.input, params: { text: 'ls\n' } },
        { method: HOST_METHOD.input, params: { sessionId: 'terminal-2', text: 'pwd\n' } },
      ]
    );

    // Neither write may resolve while its daemon call is still in flight: that early
    // true is the exact defect that let a quit tear down mid-write.
    let writeSettled = false;
    let writeToSettled = false;
    void Promise.resolve(writeResult).then(() => { writeSettled = true; });
    void Promise.resolve(writeToResult).then(() => { writeToSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(writeSettled, false, 'write must not resolve before the RPC settles');
    assert.equal(writeToSettled, false, 'writeTo must not resolve before the RPC settles');

    calls[0]!.deferred.resolve({ ok: true });
    assert.equal(await writeResult, true, 'a delivered write resolves true');
    assert.equal(writeSettled, true);
    assert.equal(writeToSettled, false, 'each write is pinned to its own RPC settlement');

    calls[1]!.deferred.resolve({ ok: true });
    assert.equal(await writeToResult, true);
    assert.equal(writeToSettled, true);
  });

  it('write/writeTo resolve false when the daemon RPC fails, preserving the never-throws contract', async () => {
    const { proxy, calls } = proxyWithCalls();

    const writeResult = proxy.write('x');
    const writeToResult = proxy.writeTo('terminal-1', 'y');
    calls[0]!.deferred.reject(new Error('daemon socket closed'));
    calls[1]!.deferred.reject(new Error('timeout: terminalInput'));

    assert.equal(await writeResult, false, 'a failed RPC resolves false, never a stray true');
    assert.equal(await writeToResult, false);
  });
});

describe('DaemonTerminalProxy — workspace capsule scope', () => {
  /**
   * The proxy is the process-wide terminal singleton in daemon mode, which is the default,
   * and it owns no session records: the summaries the daemon pushes are all it knows. The
   * host reads the cached state and asks this facade which capsule each session belongs to,
   * so a facade that cannot name a session's capsule leaves every project window reading
   * every other project's terminals (the unscoped view) or receiving their PTY output.
   */
  function proxyWithState(): DaemonTerminalProxy {
    const sessions = [
      { id: 'session-a', capsuleId: 'capsule-a', state: 'running', buffer: 'a', snapshotThroughSeq: 3 },
      { id: 'session-b', capsuleId: 'capsule-b', state: 'running', buffer: 'b', snapshotThroughSeq: 4 },
      { id: 'session-untagged', state: 'running', buffer: 'u', snapshotThroughSeq: 5 },
    ];
    const proxy = Object.create(DaemonTerminalProxy.prototype) as Record<string, unknown>;
    proxy.cachedSessions = sessions;
    proxy.cachedSessionsById = new Map(sessions.map((session) => [session.id, session]));
    proxy.cachedActiveSessionId = 'session-b';
    proxy.cachedSessionState = {
      activeSessionId: 'session-b',
      sessions,
      splitSessionId: undefined,
      snapshot: 'b',
      snapshotThroughSeq: 4,
    };
    return proxy as unknown as DaemonTerminalProxy;
  }

  it('answers a session capsule from the summaries it caches, and never invents one', () => {
    const proxy = proxyWithState();

    assert.equal(proxy.sessionCapsuleId('session-a'), 'capsule-a');
    assert.equal(proxy.sessionCapsuleId('session-b'), 'capsule-b');
    assert.equal(proxy.sessionCapsuleId('session-untagged'), undefined, 'an untagged session has no capsule');
    assert.equal(proxy.sessionCapsuleId('session-unknown'), undefined, 'an unknown session has no capsule');
  });

  it('reports the capped sessions the host scopes by, and never rewrites the cache', () => {
    const proxy = proxyWithState();
    const before = JSON.stringify(proxy.getSessionState());

    const state = proxy.getSessionState() as { activeSessionId: string; sessions: Array<{ id: string; capsuleId?: string }> };
    assert.deepStrictEqual(state.sessions.map((session) => session.id), ['session-a', 'session-b', 'session-untagged']);
    assert.equal(state.activeSessionId, 'session-b', 'the cached active session is what the daemon last reported');

    assert.equal(JSON.stringify(proxy.getSessionState()), before, 'a read never rewrites the cache');
  });
});
