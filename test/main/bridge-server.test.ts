import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { makeControlPlaneId } from '../../src/shared/control-plane-contracts';
// Mock NativeTabHost for pure isolated bridge test
class MockTabHost extends EventEmitter {
  private tabs: any[] = [{ id: 'tab-1', url: 'https://google.com', title: 'Google', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1.0 }];
  private activeTabId = 'tab-1';

  getTabList() {
    return this.tabs;
  }
  getActiveTabId() {
    return this.activeTabId;
  }
  createTab(url = 'https://google.com') {
    const id = `tab-${Date.now()}`;
    this.tabs.push({ id, url, title: 'New Tab', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1.0 });
    this.activeTabId = id;
    return id;
  }
  switchTab(tabId: string) {
    this.activeTabId = tabId;
    return true;
  }
  closeTab(tabId: string) {
    this.tabs = this.tabs.filter(t => t.id !== tabId);
    return true;
  }
  navigate(tabId: string, url: string) {
    const t = this.tabs.find(x => x.id === tabId);
    if (t) t.url = url;
    return true;
  }
  toggleInspect() {
    return true;
  }
  toggleSidebar() {
    return true;
  }
  async getDom() {
    return '<html><body><h1>AntiFan</h1></body></html>';
  }
  async captureScreenshot() {
    return 'base64-mock-png';
  }
}

interface TerminalDataFrame {
  event: 'antifan:terminal:data';
  sessionId: string;
  data: string;
}

function parseTerminalDataFrame(text: string): TerminalDataFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('event' in parsed) || parsed.event !== 'antifan:terminal:data') return null;
  if (!('data' in parsed) || !parsed.data || typeof parsed.data !== 'object') return null;
  const body = parsed.data;
  if (!('sessionId' in body) || typeof body.sessionId !== 'string') return null;
  if (!('data' in body) || typeof body.data !== 'string') return null;
  return { event: 'antifan:terminal:data', sessionId: body.sessionId, data: body.data };
}

describe('AntiFan Bridge Server', () => {
  it('exposes the authenticated OMP runtime binding over RPC', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const lease = { runtimeId: 'binding-runtime', projectId: 'project-local', workspaceId: 'workspace-local', token: 'lease-token', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 30_000 };
    const server = new BridgeServer(mockHost, 0, false, undefined, () => ({ lease, projectId: 'project-local', workspaceId: 'workspace-local', browserTarget: { projectId: 'project-local', workspaceId: 'workspace-local', runtimeId: lease.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 } }));
    const port = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${server.getToken()}`);
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const response = new Promise<any>((resolve) => ws.on('message', (data) => { const parsed = JSON.parse(data.toString()); if (parsed.id === 'runtime-1') resolve(parsed); }));
    ws.send(JSON.stringify({ id: 'runtime-1', method: 'antifan.getRuntimeBinding' }));
    const result = await response;
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.lease.runtimeId, 'binding-runtime');
    assert.strictEqual(result.data.browserTarget.tabId, 'tab-1');
    ws.close();
    server.dispose();
  });

  it('starts on local port and responds to getStatus and RPC methods with valid token', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0); // ephemeral port
    const port = await server.start();
    assert.ok(port > 0);

    const token = server.getToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Test getStatus
    const statusPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'req-1') resolve(parsed);
      });
    });

    ws.send(JSON.stringify({ id: 'req-1', method: 'getStatus' }));
    const statusResp = await statusPromise;
    assert.strictEqual(statusResp.success, true);
    assert.strictEqual(statusResp.data.active, true);

    // Test toggleSidebar
    const sidebarPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'req-3') resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ id: 'req-3', method: 'toggleSidebar' }));
    const sidebarResp = await sidebarPromise;
    assert.strictEqual(sidebarResp.success, true);

    // Test getTerminalSessions
    const termPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'req-term') resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ id: 'req-term', method: 'antifan.getTerminalSessions' }));
    const termResp = await termPromise;
    assert.strictEqual(termResp.success, true);
    assert.ok(Array.isArray(termResp.data.sessions));

    // Test terminalSendKey (ctrl_c)
    const keyPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'req-key') resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ id: 'req-key', method: 'antifan.terminalSendKey', params: { key: 'ctrl_c' } }));
    const keyResp = await keyPromise;
    assert.strictEqual(keyResp.success, true);
    assert.strictEqual(keyResp.data.sent, true);
    ws.close();
    server.dispose();
  });

  it('rejects connection when token is missing', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });

    assert.strictEqual(closeCode, 4001);
    server.dispose();
  });

  it('rejects connection when token is invalid', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=wrong-forged-token`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });

    assert.strictEqual(closeCode, 4001);
    server.dispose();
  });

  it('rejects connection when browser Origin header is present', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();
    const token = server.getToken();

    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`, {
      headers: { Origin: 'http://malicious-website.com' },
    });

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });

    assert.strictEqual(closeCode, 4003);
    server.dispose();
  });

  it('handles antifan.cli.startSession and antifan.cli.renewSession RPC over WebSocket', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const lease = { runtimeId: 'binding-runtime', projectId: 'project-local', workspaceId: 'workspace-local', token: 'lease-token', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 30_000 };
    let renewedAttachmentId = '';
    const mockControlPlane = {
      createCliSession: () => ({
        run: { id: 'run-test-123456789012' },
        attempt: { id: 'attempt-test-123456789012' },
        launch: {
          attachmentId: 'binding-test-123456789012',
          secret: 'secret-123456',
          projectId: 'project-local',
          workspaceId: 'workspace-local',
          authorityRevision: 'rev-test-123456789012',
          expiresAt: Date.now() + 60_000,
        },
      }),
      renewCliSession: (attachmentId: string, secret: string, options?: { extensionMs?: number; ownerPid?: number }) => {
        renewedAttachmentId = attachmentId;
        if (options?.ownerPid !== process.pid) {
          throw new Error('PROCESS_MISMATCH');
        }
        return { expiresAt: Date.now() + 3600_000 };
      },
      runs: {
        attachments: {
          getRecord: () => ({ runId: 'run-test-123456789012', attemptId: 'attempt-test-123456789012' }),
          verifyAttachmentSecret: () => true,
        },
      },
      endCliSession: () => ({ ok: true }),
    };
    const server = new BridgeServer(mockHost, 0, false, undefined, () => ({ lease, projectId: 'project-local', workspaceId: 'workspace-local' }));
    server.setControlPlane(mockControlPlane as unknown as ControlPlaneRuntime);
    const port = await server.start();
    const token = server.getToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    // 1. Start CLI session
    const startPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'cli-start-1') resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ id: 'cli-start-1', method: 'antifan.cli.startSession', params: { backendId: 'cli', ownerPid: process.pid } }));
    const startResp = await startPromise;
    assert.strictEqual(startResp.success, true);
    assert.strictEqual(startResp.data.attachmentId, 'binding-test-123456789012');
    assert.strictEqual(startResp.data.authorityRevision, 'rev-test-123456789012');
    // 2. Renew CLI session
    const renewPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'cli-renew-1') resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ id: 'cli-renew-1', method: 'antifan.cli.renewSession', params: { attachmentId: 'binding-test-123456789012', secret: 'secret-123456', ownerPid: process.pid, extensionMs: 3600_000 } }));
    const renewResp = await renewPromise;
    assert.strictEqual(renewResp.success, true);
    assert.strictEqual(renewedAttachmentId, 'binding-test-123456789012');
    assert.ok(renewResp.data.expiresAt > Date.now());

    ws.close();
    server.dispose();
  });

  it('broadcasts terminal data as non-empty JSON frames over a live socket', { timeout: 5000 }, async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${server.getToken()}`);
    const open = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    await open;

    const dataFrames: TerminalDataFrame[] = [];
    let sawInspect = false;
    const allDelivered = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const text = String(data);
        assert.ok(text.length > 0, 'broadcast frames must never be empty strings');
        if (text.includes('"event":"antifan:inspectStateChanged"')) sawInspect = true;
        const frame = parseTerminalDataFrame(text);
        if (frame) dataFrames.push(frame);
        if (dataFrames.length >= 2 && sawInspect) resolve();
      });
    });

    server.broadcastEvent('antifan:inspectStateChanged', { active: true });
    server.broadcastEvent('antifan:terminal:data', { sessionId: 'bench-pty', data: 'line-1\r\n' });
    server.broadcastEvent('antifan:terminal:data', { sessionId: 'bench-pty', data: 'line-2\r\n' });
    await allDelivered;

    const first = dataFrames[0];
    const second = dataFrames[1];
    assert.ok(first && second, 'expected two terminal data frames');
    assert.strictEqual(first.event, 'antifan:terminal:data');
    assert.strictEqual(first.sessionId, 'bench-pty');
    assert.strictEqual(first.data, 'line-1\r\n');
    assert.strictEqual(second.data, 'line-2\r\n');

    ws.close();
    server.dispose();
  });

  it('terminates a client whose congestion FIFO exceeds the hard cap', { timeout: 30000 }, async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    let socket: net.Socket | undefined;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => { warns.push(String(msg)); };
    try {
      const port = await server.start();
      const token = server.getToken();
      const handshakeKey = crypto.randomBytes(16).toString('base64');
      socket = net.connect(port, '127.0.0.1');
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${handshakeKey}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`,
      );
      // Wait for the 101 handshake, then stop draining: the TCP window closes and the server backlog grows.
      await new Promise<void>((resolve, reject) => {
        socket!.once('data', () => resolve());
        socket!.once('error', reject);
      });
      socket.pause();
      socket.on('error', () => {});
      const chunk = 'x'.repeat(512 * 1024);
      let terminated = false;
      for (let i = 0; i < 128 && !terminated; i++) {
        server.broadcastEvent('antifan:terminal:data', { sessionId: 'stall-1', data: chunk });
        // Enqueue, cap-crossing, and dropSlowClient are all synchronous in the same call.
        terminated = warns.some((w) => w.includes('terminated slow client'));
      }
      assert.ok(terminated, 'server must log the overflow termination for a stalled client');
    } finally {
      console.warn = origWarn;
      socket?.destroy();
      server.dispose();
    }
  });

  it('coalesces consecutive terminal data frames for the same session and preserves highest seq', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const sentMessages: string[] = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 9 * 1024 * 1024, // Exceeds BRIDGE_SOFT_HIGH_WATER (8 MiB) to force congestion queueing
      send: (msg: string) => { sentMessages.push(msg); },
    };
    const wsHandle = fakeWs as unknown as WebSocket;

    const serverAny = server as unknown as {
      sendEventFrame: (ws: WebSocket, event: string, data: unknown, terminalSessionId?: string) => void;
      getCongestionState: (ws: WebSocket) => { queue: Array<{ data?: string; seq?: number; bytes: number }>; queuedBytes: number };
      flushCongestedClient: (ws: WebSocket) => void;
    };

    serverAny.sendEventFrame(wsHandle, 'antifan:terminal:data', { sessionId: 'coalesce-pty', data: 'chunk-1;', seq: 101 }, 'coalesce-pty');
    serverAny.sendEventFrame(wsHandle, 'antifan:terminal:data', { sessionId: 'coalesce-pty', data: 'chunk-2;', seq: 102 }, 'coalesce-pty');
    serverAny.sendEventFrame(wsHandle, 'antifan:terminal:data', { sessionId: 'coalesce-pty', data: 'chunk-3;', seq: 103 }, 'coalesce-pty');

    const state = serverAny.getCongestionState(wsHandle);
    assert.strictEqual(state.queue.length, 1, 'consecutive frames for the same session must coalesce into exactly 1 queue entry');
    assert.strictEqual(state.queue[0]?.data, 'chunk-1;chunk-2;chunk-3;');
    assert.strictEqual(state.queue[0]?.seq, 103, 'coalesced frame must carry the latest seq');

    const expectedPayload = JSON.stringify({
      event: 'antifan:terminal:data',
      data: {
        sessionId: 'coalesce-pty',
        data: 'chunk-1;chunk-2;chunk-3;',
        seq: 103,
      },
    });
    const expectedBytes = Buffer.byteLength(expectedPayload, 'utf8');
    assert.strictEqual(state.queue[0]?.bytes, expectedBytes, 'frame bytes must match exact merged JSON payload');
    assert.strictEqual(state.queuedBytes, expectedBytes, 'queuedBytes must match exact merged byte size without envelope accumulation');

    // Simulate socket drain
    fakeWs.bufferedAmount = 0;
    serverAny.flushCongestedClient(wsHandle);

    assert.strictEqual(state.queue.length, 0, 'queue must be empty after flush');
    assert.strictEqual(state.queuedBytes, 0, 'queuedBytes must be 0 after flush');
    assert.strictEqual(sentMessages.length, 1, 'exactly 1 coalesced frame must be sent over the wire');
    assert.strictEqual(sentMessages[0], expectedPayload);

    server.dispose();
  });

  it('enforces SEC-01: forbids attachment tokens from accessing administrative mobile HTML', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const registry = new AttachmentRegistry();
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtimeId = makeControlPlaneId('binding');
    const lease = { runtimeId, projectId, workspaceId, token: 'tok-1', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 30_000 };
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'omp',
      lease,
      leaseToken: lease.token,
      grant: 'write',
      tabId: 'tab-1',
    });
    const server = new BridgeServer(mockHost, 0, false, undefined, undefined, registry);
    const port = await server.start();

    // 1. Request with attachment secret should return 403 Forbidden
    const forbiddenRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/mobile?token=${launch.secret}`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
    });
    assert.strictEqual(forbiddenRes.statusCode, 403, 'Attachment token must receive 403 Forbidden on mobile admin route');
    assert.ok(!forbiddenRes.body.includes(server.getToken()), 'Forbidden response must not leak master bridge token');

    // 2. Request with unauthenticated token should return 401 Unauthorized
    const unauthorizedRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/mobile`, (res) => {
        resolve({ statusCode: res.statusCode || 0 });
      });
      req.on('error', reject);
    });
    assert.strictEqual(unauthorizedRes.statusCode, 401, 'Unauthenticated request must receive 401');

    // 3. Request with master bridge token should return 200 OK
    const successRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/mobile?token=${server.getToken()}`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
    });
    assert.strictEqual(successRes.statusCode, 200, 'Master token must receive 200 OK');
    assert.ok(successRes.body.includes(server.getToken()), 'Authorized response includes master token for legitimate pairing');

    server.dispose();
  });

  it('enforces SEC-02: rejects attacker domains from CORS origin reflection', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    // 1. Malicious origin http://localhost.evil.com on preflight
    const maliciousOptions = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/status`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost.evil.com' },
      }, (res) => {
        resolve({ statusCode: res.statusCode || 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(maliciousOptions.headers['access-control-allow-origin'], undefined, 'Malicious origin must not be reflected in preflight');

    // 2. Legitimate localhost origin on preflight
    const legitimateOptions = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/status`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      }, (res) => {
        resolve({ statusCode: res.statusCode || 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(legitimateOptions.headers['access-control-allow-origin'], 'http://localhost:3000', 'Legitimate localhost origin must be reflected');

    server.dispose();
  });
});
