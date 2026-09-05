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
