import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  LocalIpcClient,
  LocalIpcTimeoutError,
  LocalIpcClosedError,
  LOCAL_IPC_RESPONSE_DEADLINE_MS,
} from '../../src/main/native-messaging/local-ipc-client';
import { NativeMessageDecoder, encodeNativeMessage } from '../../src/main/native-messaging/framing';

interface TestHarness {
  server: net.Server;
  peerSocketPromise: Promise<net.Socket>;
  clientSocket: net.Socket;
  cleanup: () => Promise<void>;
}

async function createHarness(): Promise<TestHarness> {
  let peerSocketResolve!: (sock: net.Socket) => void;
  const peerSocketPromise = new Promise<net.Socket>((resolve) => {
    peerSocketResolve = resolve;
  });

  const server = net.createServer((socket) => {
    peerSocketResolve(socket);
  });

  // Ephemeral local TCP server guarantees determinism across all platforms
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as net.AddressInfo;
  const clientSocket = net.createConnection({ port: addr.port, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    clientSocket.once('connect', () => resolve());
    clientSocket.once('error', reject);
  });

  const cleanup = async () => {
    clientSocket.destroy();
    server.close();
  };

  return { server, peerSocketPromise, clientSocket, cleanup };
}

test('Row 1: peer never answers -> request rejects with typed no-answer failure inside the bound', { timeout: 1500 }, async () => {
  const harness = await createHarness();
  try {
    // Wait for the peer to accept the connection; peer intentionally sends NOTHING back
    await harness.peerSocketPromise;

    const client = new LocalIpcClient({
      socket: harness.clientSocket,
      responseDeadlineMs: 150,
    });

    const start = Date.now();
    await assert.rejects(
      async () => {
        await client.send({ action: 'PING' });
      },
      (err: unknown) => {
        assert.ok(err instanceof LocalIpcTimeoutError, `Expected LocalIpcTimeoutError, got ${(err as Error)?.name}`);
        assert.equal((err as LocalIpcTimeoutError).code, 'LOCAL_IPC_TIMEOUT');
        return true;
      }
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 100, `Expected elapsed >= 100ms, got ${elapsed}ms`);
    assert.ok(elapsed < 1000, `Expected elapsed < 1000ms, got ${elapsed}ms`);
  } finally {
    await harness.cleanup();
  }
});

test('Row 2: peer answers normally -> resolves with payload (bound does not cut real answer short)', { timeout: 2000 }, async () => {
  const harness = await createHarness();
  try {
    const peerSocket = await harness.peerSocketPromise;
    const decoder = new NativeMessageDecoder();
    peerSocket.pipe(decoder);

    decoder.on('data', (req: { action?: string }) => {
      // Simulate real processing round-trip before replying
      setTimeout(() => {
        if (!peerSocket.destroyed) {
          peerSocket.write(encodeNativeMessage({ status: 'PONG', echo: req.action }));
        }
      }, 30);
    });

    const client = new LocalIpcClient({
      socket: harness.clientSocket,
      responseDeadlineMs: 1000,
    });

    const response = await client.send({ action: 'PING' });
    assert.deepEqual(response, { status: 'PONG', echo: 'PING' });
  } finally {
    await harness.cleanup();
  }
});

test('Peer closes connection without answering -> rejects with LocalIpcClosedError immediately', { timeout: 1500 }, async () => {
  const harness = await createHarness();
  try {
    const peerSocket = await harness.peerSocketPromise;
    const decoder = new NativeMessageDecoder();
    peerSocket.pipe(decoder);

    decoder.on('data', () => {
      // Peer crashes or disconnects abruptly without sending an answer
      peerSocket.destroy();
    });

    const client = new LocalIpcClient({
      socket: harness.clientSocket,
      responseDeadlineMs: 1000,
    });

    const start = Date.now();
    await assert.rejects(
      async () => {
        await client.send({ action: 'PING' });
      },
      (err: unknown) => {
        assert.ok(err instanceof LocalIpcClosedError, `Expected LocalIpcClosedError, got ${(err as Error)?.name}`);
        assert.equal((err as LocalIpcClosedError).code, 'LOCAL_IPC_CLOSED');
        return true;
      }
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Expected immediate closure rejection (< 500ms), got ${elapsed}ms`);
  } finally {
    await harness.cleanup();
  }
});

test('Pre-closed socket rejects immediately without waiting for bound', async () => {
  const harness = await createHarness();
  try {
    harness.clientSocket.destroy();
    const client = new LocalIpcClient({
      socket: harness.clientSocket,
      responseDeadlineMs: 1000,
    });

    await assert.rejects(
      async () => {
        await client.send({ action: 'PING' });
      },
      (err: unknown) => {
        assert.ok(err instanceof LocalIpcClosedError, `Expected LocalIpcClosedError, got ${(err as Error)?.name}`);
        assert.equal((err as LocalIpcClosedError).code, 'LOCAL_IPC_CLOSED');
        return true;
      }
    );
  } finally {
    await harness.cleanup();
  }
});

test('End-to-end connect via runtime auth file resolves normally', { timeout: 2000 }, async () => {
  let peerSocketResolve!: (sock: net.Socket) => void;
  const peerSocketPromise = new Promise<net.Socket>((resolve) => {
    peerSocketResolve = resolve;
  });

  const server = net.createServer((socket) => {
    peerSocketResolve(socket);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as net.AddressInfo;
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-ipc-client-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpRuntimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpRuntimeDir, 'bridge-auth.json'),
    JSON.stringify({
      instanceUuid: 'test-uuid-1',
      launchNonce: 'test-nonce-1',
      socketPath: String(addr.port),
      port: addr.port,
      createdAt: Date.now(),
    }),
    'utf8'
  );

  const client = new LocalIpcClient({
    customRuntimeDir: tmpRuntimeDir,
    responseDeadlineMs: 1000,
  });

  try {
    peerSocketPromise.then((peerSocket) => {
      const decoder = new NativeMessageDecoder();
      peerSocket.pipe(decoder);
      decoder.on('data', (req: { action?: string }) => {
        peerSocket.write(encodeNativeMessage({ status: 'PONG', echo: req.action }));
      });
    });

    const response = await client.send({ action: 'PING' });
    assert.deepEqual(response, { status: 'PONG', echo: 'PING' });
  } finally {
    client.disconnect();
    server.close();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});
