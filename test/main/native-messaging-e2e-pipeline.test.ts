import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { LocalIpcServer } from '../../src/main/native-messaging/local-ipc-server';
import { NativeMessageDecoder, encodeNativeMessage } from '../../src/main/native-messaging/framing';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { deriveCapsulePartition } from '../../src/main/browser/browser-session-partition';

class MockCookieStore {
  public cookies: Map<string, Record<string, unknown>> = new Map();
  public flushed = false;

  public async set(details: Record<string, unknown>): Promise<void> {
    const key = `${details.domain || ''}|${details.path || '/'}|${details.name}`;
    this.cookies.set(key, { ...details });
  }

  public async remove(url: string, name: string): Promise<void> {
    for (const [key, c] of Array.from(this.cookies.entries())) {
      if (c.name === name) {
        this.cookies.delete(key);
      }
    }
  }

  public async get(query: { name?: string; domain?: string }): Promise<Array<Record<string, unknown>>> {
    const res: Array<Record<string, unknown>> = [];
    for (const c of this.cookies.values()) {
      if (query.name && c.name !== query.name) continue;
      if (query.domain && c.domain !== query.domain) continue;
      res.push(c);
    }
    return res;
  }

  public async flushStore(): Promise<void> {
    this.flushed = true;
  }
}

class MockIsolatedSession {
  public cookies = new MockCookieStore();
}

class MockTabHostWithCapsulePartitions extends EventEmitter {
  public capsuleASession = new MockIsolatedSession();
  public capsuleBSession = new MockIsolatedSession();
  public defaultSession = new MockIsolatedSession();

  public registeredPartitions = new Set([
    'persist:capsule-store-a',
    'persist:capsule-store-b',
    'persist:capsule-default',
  ]);

  public isValidCapsulePartition(partition: string): boolean {
    return this.registeredPartitions.has(partition);
  }

  public getPartitionSession(partition: string): any {
    if (partition === 'persist:capsule-store-a') return this.capsuleASession;
    if (partition === 'persist:capsule-store-b') return this.capsuleBSession;
    return this.defaultSession;
  }

  public getActiveTabSession(): any {
    return this.defaultSession;
  }

  public getActiveTab(): any {
    return { id: 'tab-default', url: 'https://example.com' };
  }

  public getTabSession(_id: string): any {
    return this.defaultSession;
  }
}

test('Native Messaging E2E: Framed Stdio Host -> Named Pipe IPC -> BridgeServer -> Partition Session', async () => {
  const rootDir = process.cwd();
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-e2e-real-${crypto.randomUUID()}`);
  const targetCapsuleId = 'store-a';
  const targetPartition = deriveCapsulePartition(targetCapsuleId);

  // 1. Start real BridgeServer
  const mockHost = new MockTabHostWithCapsulePartitions();
  const bridgeServer = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
  const bridgePort = await bridgeServer.start();
  const masterToken = bridgeServer.getToken();

  // 2. Start real Local IPC Server
  const ipcServer = new LocalIpcServer();
  await ipcServer.start(
    bridgePort,
    () => ({
      token: masterToken,
      port: bridgePort,
      activeCapsuleId: targetCapsuleId,
      activePartition: targetPartition,
    }),
    tmpRuntimeDir
  );

  // 3. Spawn real Host Runner process with stdio framing
  const hostRunnerJs = path.join(rootDir, '.compiled', 'src', 'main', 'native-messaging', 'host-runner.js');
  const child = spawn(process.execPath, [hostRunnerJs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIFAN_RUNTIME_DIR: tmpRuntimeDir,
    },
  });

  const stdoutDecoder = new NativeMessageDecoder();
  child.stdout.pipe(stdoutDecoder);

  const incomingMessages: any[] = [];
  stdoutDecoder.on('data', (msg) => {
    incomingMessages.push(msg);
  });

  try {
    // 4. Send Framed HANDSHAKE over Chromium Native Messaging Stdio
    const handshakeBuf = encodeNativeMessage({ action: 'HANDSHAKE' });
    child.stdin.write(handshakeBuf);

    // Wait for response frame
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (incomingMessages.length > 0) return resolve();
        if (Date.now() - start > 5000) return reject(new Error('Timed out waiting for Native Host handshake frame'));
        setTimeout(check, 50);
      };
      check();
    });

    assert.equal(incomingMessages.length, 1);
    const handshakeRes = incomingMessages[0];
    assert.equal(handshakeRes.status, 'SUCCESS');
    assert.equal(handshakeRes.token, masterToken);
    assert.equal(handshakeRes.port, bridgePort);
    assert.equal(handshakeRes.activePartition, targetPartition);

    // 5. Execute HTTP POST /api/cookies/import on real BridgeServer with negotiated token
    // 5A. Valid Upsert into Capsule A
    const upsertResp = await fetch(`http://127.0.0.1:${bridgePort}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${handshakeRes.token}`,
      },
      body: JSON.stringify({
        upserted: [
          { name: 'session_auth', value: 'token_xyz_123', domain: '.haravan.com', path: '/', secure: true },
          { name: 'cart_id', value: 'cart_999', domain: '.haravan.com', path: '/', secure: true },
        ],
        partition: handshakeRes.activePartition,
        source: 'chrome-extension-delta',
      }),
    });

    assert.equal(upsertResp.status, 200);
    const upsertJson = (await upsertResp.json()) as any;
    assert.equal(upsertJson.success, true);
    assert.equal(upsertJson.importedCount, 2);
    assert.equal(upsertJson.targetPartition, targetPartition);

    // Verify cookies in Capsule A
    const cookiesInA = await mockHost.capsuleASession.cookies.get({ name: 'session_auth' });
    assert.equal(cookiesInA.length, 1);
    assert.ok(cookiesInA[0]);
    assert.equal(cookiesInA[0].value, 'token_xyz_123');
    const cookiesInB = await mockHost.capsuleBSession.cookies.get({ name: 'session_auth' });
    const cookiesInDefault = await mockHost.defaultSession.cookies.get({ name: 'session_auth' });
    assert.equal(cookiesInB.length, 0, 'Capsule B must have 0 cookies');
    assert.equal(cookiesInDefault.length, 0, 'Default session must have 0 cookies');

    // 5B. Delta Removal on Capsule A
    const removeResp = await fetch(`http://127.0.0.1:${bridgePort}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${handshakeRes.token}`,
      },
      body: JSON.stringify({
        removed: [
          { name: 'session_auth', domain: '.haravan.com', path: '/', secure: true },
        ],
        partition: handshakeRes.activePartition,
        source: 'chrome-extension-delta',
      }),
    });

    assert.equal(removeResp.status, 400);
    const removeJson = (await removeResp.json()) as any;
    assert.equal(removeJson.error, 'REMOVALS_UNSUPPORTED');

    // Verify session_auth is still intact because one-way additive contract protects desktop cookies
    const afterRemoveA = await mockHost.capsuleASession.cookies.get({ name: 'session_auth' });
    assert.equal(afterRemoveA.length, 1);

    // 5C. Missing partition rejection for delta sync
    const missingResp = await fetch(`http://127.0.0.1:${bridgePort}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${handshakeRes.token}`,
      },
      body: JSON.stringify({
        upserted: [{ name: 'test', value: '1', domain: '.haravan.com' }],
        source: 'chrome-extension-delta',
      }),
    });
    assert.equal(missingResp.status, 400);
    const missingJson = (await missingResp.json()) as any;
    assert.equal(missingJson.error, 'MISSING_TARGET_PARTITION');

    // 5D. Unknown partition rejection
    const unknownResp = await fetch(`http://127.0.0.1:${bridgePort}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${handshakeRes.token}`,
      },
      body: JSON.stringify({
        upserted: [{ name: 'test', value: '1', domain: '.haravan.com' }],
        partition: 'persist:capsule-malicious-unregistered',
        source: 'chrome-extension-delta',
      }),
    });
    assert.equal(unknownResp.status, 404);
    const unknownJson = (await unknownResp.json()) as any;
    assert.equal(unknownJson.error, 'UNKNOWN_TARGET_PARTITION');

  } finally {
    // End stdin to tell child process to exit
    child.stdin.end();
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 2000);
    });

    ipcServer.close();
    bridgeServer.dispose();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});

test('Native Host Runner: terminates with exitCode 1 and emits IPC_FORWARDING_FAILED frame when Desktop IPC is unavailable', async () => {
  const rootDir = process.cwd();
  const tmpRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-host-fail-'));

  const hostRunnerJs = path.join(rootDir, '.compiled', 'src', 'main', 'native-messaging', 'host-runner.js');
  const child = spawn(process.execPath, [hostRunnerJs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIFAN_RUNTIME_DIR: tmpRuntimeDir,
    },
  });

  const stdoutDecoder = new NativeMessageDecoder();
  child.stdout.pipe(stdoutDecoder);

  const incomingMessages: any[] = [];
  stdoutDecoder.on('data', (msg) => {
    incomingMessages.push(msg);
  });

  try {
    // Send Framed HANDSHAKE over Chromium Native Messaging Stdio while IPC server is down
    const handshakeBuf = encodeNativeMessage({ action: 'HANDSHAKE' });
    child.stdin.write(handshakeBuf);

    // Wait for the child to exit cleanly with code 1
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('Timed out waiting for child process to exit after IPC failure'));
      }, 5000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 1, 'Host runner must exit with code 1 on IPC failure');
    assert.equal(incomingMessages.length, 1, 'Must emit exactly one error frame to Chromium');
    assert.equal(incomingMessages[0].status, 'ERROR');
    assert.equal(incomingMessages[0].error, 'IPC_FORWARDING_FAILED');
  } finally {
    try { child.kill(); } catch {}
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
});
