import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { LocalIpcServer } from '../../src/main/native-messaging/local-ipc-server';
import { LocalIpcClient } from '../../src/main/native-messaging/local-ipc-client';
import { encodeNativeMessage } from '../../src/main/native-messaging/framing';
import * as net from 'node:net';

test('Local IPC Handshake: successfully negotiates credentials with valid launchNonce', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-ipc-${crypto.randomUUID()}`);
  const server = new LocalIpcServer();
  const mockToken = 'ephemeral-session-token-12345';
  const bridgePort = 20129;
  const activeCapsuleId = 'capsule-haravan-store-1';

  try {
    await server.start(
      bridgePort,
      () => ({
        token: mockToken,
        port: bridgePort,
        activeCapsuleId,
        activePartition: 'persist:capsule-haravan-store-1',
      }),
      tmpRuntimeDir
    );
    const client = new LocalIpcClient(tmpRuntimeDir);
    try {
      const response = await client.send({ action: 'HANDSHAKE' });
      assert.equal(response.status, 'SUCCESS');
      assert.equal(response.token, mockToken);
      assert.equal(response.port, bridgePort);
      assert.equal(response.activeCapsuleId, activeCapsuleId);
      assert.equal(response.activePartition, 'persist:capsule-haravan-store-1');
    } finally {
      client.disconnect();
    }
  } finally {
    server.close();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});

test('Local IPC Handshake: rejects connection attempt with invalid launchNonce', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-ipc-${crypto.randomUUID()}`);
  const server = new LocalIpcServer();

  try {
    await server.start(
      20129,
      () => ({
        token: 'token-abc',
        port: 20129,
      }),
      tmpRuntimeDir
    );

    const socketPath = server.getSocketPath();
    const socket = net.createConnection(socketPath);

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        const badPayload = { action: 'HANDSHAKE', launchNonce: 'fake-invalid-nonce-00000000000000000000' };
        socket.write(encodeNativeMessage(badPayload));
      });

      socket.on('data', (data) => {
        const len = data.readUInt32LE(0);
        const json = JSON.parse(data.subarray(4, 4 + len).toString('utf8'));
        assert.equal(json.status, 'ERROR');
        assert.equal(json.error, 'INVALID_LAUNCH_NONCE');
      });

      socket.on('close', () => {
        resolve();
      });

      socket.on('error', () => {
        resolve();
      });
    });
  } finally {
    server.close();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});

test('Local IPC: supports PING action and returns PONG', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-ipc-${crypto.randomUUID()}`);
  const server = new LocalIpcServer();

  try {
    await server.start(
      20129,
      () => ({
        token: 'ping-token',
        port: 20129,
      }),
      tmpRuntimeDir
    );

    const client = new LocalIpcClient(tmpRuntimeDir);
    try {
      const response = await client.send({ action: 'PING' });
      assert.equal(response.status, 'PONG');
      assert.ok(response.timestamp > 0);
    } finally {
      client.disconnect();
    }
  } finally {
    server.close();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});

test('LocalIpcClient: rejects connection when auth file points to dead PID', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-dead-pid-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpRuntimeDir, { recursive: true });
  const authFile = path.join(tmpRuntimeDir, 'bridge-auth.json');

  fs.writeFileSync(authFile, JSON.stringify({
    instanceUuid: 'dead-uuid',
    launchNonce: 'nonce-123',
    socketPath: '\\\\.\\pipe\\antifan-bridge-ipc-dead-uuid',
    port: 20129,
    pid: 99999999, // Non-existent PID
    createdAt: Date.now(),
  }), 'utf8');

  const client = new LocalIpcClient(tmpRuntimeDir);
  try {
    await assert.rejects(
      async () => {
        await client.connect();
      },
      (err: Error) => {
        assert.match(err.message, /is no longer running/i);
        return true;
      }
    );
  } finally {
    client.disconnect();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});

test('LocalIpcServer: writes bridge-auth.json atomically with current PID and cleans up on close', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-lifecycle-${crypto.randomUUID()}`);
  const server = new LocalIpcServer();
  const authFile = path.join(tmpRuntimeDir, 'bridge-auth.json');

  try {
    await server.start(
      20129,
      () => ({
        token: 'test-token',
        port: 20129,
      }),
      tmpRuntimeDir
    );

    assert.equal(fs.existsSync(authFile), true);
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.equal(auth.pid, process.pid);
    assert.equal(auth.instanceUuid, server.getInstanceUuid());
    assert.equal(auth.port, 20129);
  } finally {
    server.close();
    assert.equal(fs.existsSync(authFile), false, 'Auth file should be removed on close');
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});

test('LocalIpcServer: enforces runtime ownership and rejects concurrent competing live server', async () => {
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-test-contention-${crypto.randomUUID()}`);
  const server1 = new LocalIpcServer();
  const server2 = new LocalIpcServer();

  try {
    // 1. Server 1 starts successfully and acquires ownership of tmpRuntimeDir
    await server1.start(
      20129,
      () => ({ token: 'token-1', port: 20129 }),
      tmpRuntimeDir
    );

    // 2. Server 2 attempts to start on the SAME runtimeDir while Server 1 is alive -> MUST reject with ownership conflict
    await assert.rejects(
      async () => {
        await server2.start(
          20130,
          () => ({ token: 'token-2', port: 20130 }),
          tmpRuntimeDir
        );
      },
      (err: Error) => {
        assert.match(err.message, /Runtime ownership conflict/i);
        return true;
      }
    );

    // 3. Close Server 1 -> ownership is cleanly released
    server1.close();

    // 4. Server 2 can now successfully acquire ownership of tmpRuntimeDir
    await server2.start(
      20130,
      () => ({ token: 'token-2', port: 20130 }),
      tmpRuntimeDir
    );
    assert.equal(fs.existsSync(path.join(tmpRuntimeDir, 'bridge-auth.json')), true);
    const auth2 = JSON.parse(fs.readFileSync(path.join(tmpRuntimeDir, 'bridge-auth.json'), 'utf8'));
    assert.equal(auth2.instanceUuid, server2.getInstanceUuid());
    assert.equal(auth2.port, 20130);
  } finally {
    server1.close();
    server2.close();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});
