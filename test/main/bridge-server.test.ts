import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { BridgeServer, type MobileSessionGrant } from '../../src/main/bridge/bridge-server';
import { StorageLocations } from '../../src/main/config/storage-locations';
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
  // Mirrors NativeTabHost.createTab, where activation defaults to true.
  createTab(url = 'https://google.com', activate = true, options?: { ephemeral?: boolean; offscreen?: boolean }) {
    this.lastCreateTab = { url, activate, options };
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
  public reloadWindowCalls = 0;
  public lastCreateTab: { url?: string; activate?: boolean; options?: { ephemeral?: boolean; offscreen?: boolean } } | null = null;
  reloadWindow() {
    this.reloadWindowCalls++;
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${server.getToken()}` },
    });
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

  it('opens an activated tab on the visible plane for an agent caller, and keeps inactive ones offscreen', async () => {
    const mockHost = new MockTabHost();
    const server = new BridgeServer(mockHost as unknown as NativeTabHost, 0, false);
    const port = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${server.getToken()}` },
    });
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const send = async (id: string, params: Record<string, unknown>) => {
      // Wire payload from the bridge; the id/success/data shape is asserted below.
      type OpenTabResult = { id: string; success: boolean; data: { tabId: string } };
      const response = new Promise<OpenTabResult>((resolve) => ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as OpenTabResult;
        if (parsed.id === id) resolve(parsed);
      }));
      ws.send(JSON.stringify({ id, method: 'antifan.openTab', params }));
      return response;
    };
    try {
      const activated = await send('open-visible-1', { url: 'https://example.com', activate: true, attachmentId: 'attachment-1' });
      assert.strictEqual(activated.success, true);
      assert.strictEqual(mockHost.lastCreateTab?.activate, true);
      assert.deepStrictEqual(
        mockHost.lastCreateTab?.options,
        { ephemeral: false, offscreen: false },
        'a tab the caller asked to activate must exist on screen'
      );

      const inactive = await send('open-hidden-1', { url: 'https://example.com/2', attachmentId: 'attachment-1' });
      assert.strictEqual(inactive.success, true);
      assert.deepStrictEqual(
        mockHost.lastCreateTab?.options,
        { ephemeral: true, offscreen: true },
        'without activation an agent tab stays an isolated offscreen surface'
      );
    } finally {
      ws.close();
      server.dispose();
    }
  });

  it('starts on local port and responds to getStatus and RPC methods with valid token', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0); // ephemeral port
    const port = await server.start();
    assert.ok(port > 0);

    const token = server.getToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

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

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: 'Bearer wrong-forged-token' },
    });
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'http://malicious-website.com',
      },
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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

  it('broadcasts terminal data as non-empty JSON frames over a live socket', { timeout: 35000 }, async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${server.getToken()}` },
    });
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
    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
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
      const req = http.get(`http://127.0.0.1:${port}/mobile`, {
        headers: { 'x-antifan-attachment-secret': launch.secret },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
    });
    assert.strictEqual(forbiddenRes.statusCode, 403, 'Attachment token must receive 403 Forbidden on mobile admin route');
    assert.ok(!forbiddenRes.body.includes(server.getToken()), 'Forbidden response must not leak master bridge token');

    // 2. Request with unauthenticated token should reach the pairing modal (200) but never leak the master token
    const unauthorizedRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/mobile`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
    });
    assert.strictEqual(unauthorizedRes.statusCode, 200, 'Unauthenticated request must reach the pairing modal');
    assert.ok(unauthorizedRes.body.includes('pairingCodeInput'), 'Pairing modal must be present for unauthenticated client');
    assert.ok(!unauthorizedRes.body.includes(server.getToken()), 'Pairing modal must not embed the master bridge token');

    // 3. Request with master bridge token should return 200 OK
    const successRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/mobile`, {
        headers: { Authorization: `Bearer ${server.getToken()}` },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
    });
    assert.strictEqual(successRes.statusCode, 200, 'Master token must receive 200 OK');
    assert.ok(!successRes.body.includes(server.getToken()), 'Authorized mobile HTML must not embed the master bridge token');

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

  it('enforces soft-reload RPC security: dev-only, rejects attachment sockets, handles unknown scripts, and clears overrides', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;

    // 1. Production rejection: when isDev is false, reloadScripts must fail with FORBIDDEN
    const prodServer = new BridgeServer(mockHost, 0, false);
    let prodWs: WebSocket | null = null;
    try {
      const prodPort = await prodServer.start();
      prodWs = new WebSocket(`ws://127.0.0.1:${prodPort}`, {
      headers: { Authorization: `Bearer ${prodServer.getToken()}` },
    });
      await new Promise((res) => prodWs!.on('open', res));

      const prodResp = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        prodWs!.on('message', (raw) => resolve(JSON.parse(raw.toString())));
        prodWs!.send(JSON.stringify({ id: 'req-prod', method: 'antifan.system.reloadScripts', params: {} }));
      });
      assert.strictEqual(prodResp.success, false);
      assert.match(prodResp.error || '', /FORBIDDEN/i);
    } finally {
      try { prodWs?.close(); } catch {}
      try { prodServer.dispose(); } catch {}
    }

    // 2. Dev server: test attachment rejection, unknown script ID, and successful cache invalidation
    const registry = new AttachmentRegistry();
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtimeId = makeControlPlaneId('binding');
    const lease = { runtimeId, projectId, workspaceId, token: 'tok-reload-test', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 30_000 };
    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'omp',
      lease,
      leaseToken: lease.token,
      grant: 'write',
      tabId: 'tab-1',
    });
    const devServer = new BridgeServer(mockHost, 0, true, undefined, undefined, registry);
    let wsAttachment: WebSocket | null = null;
    let wsMaster: WebSocket | null = null;
    try {
      const devPort = await devServer.start();

      // 2a. Attachment-authenticated socket rejection
      wsAttachment = new WebSocket(`ws://127.0.0.1:${devPort}`, {
      headers: { 'x-antifan-attachment-secret': launch.secret },
    });
      await new Promise((res) => wsAttachment!.on('open', res));

      const attachResp = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        wsAttachment!.on('message', (raw) => resolve(JSON.parse(raw.toString())));
        wsAttachment!.send(JSON.stringify({ id: 'req-attach', method: 'antifan.system.reloadScripts', params: {} }));
      });
      assert.strictEqual(attachResp.success, false);
      assert.match(attachResp.error || '', /Forbidden/i);

      // 2b. Master-authenticated socket: unknown script ID cleanly succeeds/no-ops
      wsMaster = new WebSocket(`ws://127.0.0.1:${devPort}`, {
      headers: { Authorization: `Bearer ${devServer.getToken()}` },
    });
      await new Promise((res) => wsMaster!.on('open', res));

      const unknownResp = await new Promise<{ success: boolean; data?: { reloaded: boolean; scriptCount: number } }>((resolve) => {
        wsMaster!.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.id === 'req-unknown') resolve(msg);
        });
        wsMaster!.send(JSON.stringify({
          id: 'req-unknown',
          method: 'antifan.system.reloadScripts',
          params: { scriptId: 'non.existent.script.id' },
        }));
      });
      assert.strictEqual(unknownResp.success, true);
      assert.strictEqual(unknownResp.data?.reloaded, true);

      // 2c. Master-authenticated socket: full reload clears overrides and returns list
      const fullResp = await new Promise<{ success: boolean; data?: { reloaded: boolean; scriptCount: number; scripts: Array<{ id: string } | string> } }>((resolve) => {
        wsMaster!.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.id === 'req-full') resolve(msg);
        });
        wsMaster!.send(JSON.stringify({
          id: 'req-full',
          method: 'antifan.system.reloadScripts',
          params: {},
        }));
      });
      assert.strictEqual(fullResp.success, true);
      assert.strictEqual(fullResp.data?.reloaded, true);
      assert.ok(typeof fullResp.data?.scriptCount === 'number' && fullResp.data.scriptCount > 0);
      assert.ok(Array.isArray(fullResp.data?.scripts));
      assert.ok(fullResp.data?.scripts.some((s) => (typeof s === 'string' ? s === 'media.freeze' : s.id === 'media.freeze')));
    } finally {
      try { wsAttachment?.close(); } catch {}
      try { wsMaster?.close(); } catch {}
      try { devServer.dispose(); } catch {}
    }
  });

  it('enforces UI reload RPC security: dev-only, rejects attachment sockets, and reloads UI surfaces on master token', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;

    // 1. Production rejection: when isDev is false, reloadUi must fail with FORBIDDEN
    const prodServer = new BridgeServer(mockHost, 0, false);
    let prodWs: WebSocket | null = null;
    try {
      const prodPort = await prodServer.start();
      prodWs = new WebSocket(`ws://127.0.0.1:${prodPort}`, {
      headers: { Authorization: `Bearer ${prodServer.getToken()}` },
    });
      await new Promise((res) => prodWs!.on('open', res));

      const prodResp = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        prodWs!.on('message', (raw) => resolve(JSON.parse(raw.toString())));
        prodWs!.send(JSON.stringify({ id: 'req-ui-prod', method: 'antifan.system.reloadUi', params: {} }));
      });
      assert.strictEqual(prodResp.success, false);
      assert.match(prodResp.error || '', /FORBIDDEN/i);
    } finally {
      try { prodWs?.close(); } catch {}
      try { prodServer.dispose(); } catch {}
    }

    // 2. Dev server: attachment sockets must be rejected; master token reloads UI surfaces
    const registry = new AttachmentRegistry();
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtimeId = makeControlPlaneId('binding');
    const lease = { runtimeId, projectId, workspaceId, token: 'tok-reload-ui', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 30_000 };
    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'omp',
      lease,
      leaseToken: lease.token,
      grant: 'write',
      tabId: 'tab-1',
    });
    const devServer = new BridgeServer(mockHost, 0, true, undefined, undefined, registry);
    let wsAttachment: WebSocket | null = null;
    let wsMaster: WebSocket | null = null;
    try {
      const devPort = await devServer.start();

      // 2a. Attachment-authenticated socket rejection
      wsAttachment = new WebSocket(`ws://127.0.0.1:${devPort}`, {
      headers: { 'x-antifan-attachment-secret': launch.secret },
    });
      await new Promise((res) => wsAttachment!.on('open', res));

      const attachResp = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        wsAttachment!.on('message', (raw) => resolve(JSON.parse(raw.toString())));
        wsAttachment!.send(JSON.stringify({ id: 'req-ui-attach', method: 'antifan.system.reloadUi', params: {} }));
      });
      assert.strictEqual(attachResp.success, false);
      assert.match(attachResp.error || '', /Forbidden/i);
      assert.strictEqual((mockHost as unknown as MockTabHost).reloadWindowCalls, 0, 'Attachment socket must never trigger a UI reload');

      // 2b. Master-authenticated socket: reloadUi succeeds and invokes reloadWindow
      wsMaster = new WebSocket(`ws://127.0.0.1:${devPort}`, {
      headers: { Authorization: `Bearer ${devServer.getToken()}` },
    });
      await new Promise((res) => wsMaster!.on('open', res));

      const reloadResp = await new Promise<{ success: boolean; data?: { reloaded: boolean; surfaces: string[] } }>((resolve) => {
        wsMaster!.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.id === 'req-ui-master') resolve(msg);
        });
        wsMaster!.send(JSON.stringify({ id: 'req-ui-master', method: 'antifan.system.reloadUi', params: {} }));
      });
      assert.strictEqual(reloadResp.success, true);
      assert.strictEqual(reloadResp.data?.reloaded, true);
      assert.ok(Array.isArray(reloadResp.data?.surfaces));
      assert.ok(reloadResp.data!.surfaces.includes('terminal-windows'));
      assert.strictEqual((mockHost as unknown as MockTabHost).reloadWindowCalls, 1, 'Master token must trigger exactly one reloadWindow invocation');
    } finally {
      try { wsAttachment?.close(); } catch {}
      try { wsMaster?.close(); } catch {}
      try { devServer.dispose(); } catch {}
    }
  });
});

describe('Phase 4: Grant Revocation, Rotation Invalidation & LAN Binding', () => {
  it('revokeMobileGrant marks a grant revoked and getMobileGrant rejects it', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    const grantToken = `mob-${crypto.randomBytes(16).toString('hex')}`;
    const record: MobileSessionGrant = {
      grantToken,
      sessionId: 'session-revoke-1',
      clientClass: 'mobile',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 8 * 3600_000,
      revoked: false,
      allowedScopes: ['terminal.sync'],
    };
    (server as unknown as { mobileGrants: Map<string, MobileSessionGrant> }).mobileGrants.set(grantToken, record);

    assert.ok(server.getMobileGrant(grantToken), 'grant must be valid before revocation');
    assert.strictEqual(server.revokeMobileGrant(grantToken), true, 'revoke must acknowledge an existing grant token');
    assert.strictEqual(server.getMobileGrant(grantToken), null, 'revoked grant must be rejected');
    assert.strictEqual(server.revokeMobileGrant('nonexistent-token'), false, 'revoke of unknown token returns false');
    server.dispose();
    void port;
  });

  it('rotateToken invalidates previously issued mobile grants', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    await server.start();

    const grantToken = `mob-${crypto.randomBytes(16).toString('hex')}`;
    const record: MobileSessionGrant = {
      grantToken,
      sessionId: 'session-rotate-mob',
      clientClass: 'mobile',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 8 * 3600_000,
      revoked: false,
      allowedScopes: ['terminal.sync'],
    };
    (server as unknown as { mobileGrants: Map<string, MobileSessionGrant> }).mobileGrants.set(grantToken, record);
    assert.ok(server.getMobileGrant(grantToken), 'precondition: grant valid');

    server.rotateToken();
    assert.strictEqual(server.getMobileGrant(grantToken), null, 'rotation must revoke all derived mobile grants');
    server.dispose();
  });

  it('rotateToken invalidates issued extension grants', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    await server.start();

    const grant = server.issueExtensionGrant('partition-cookies', ['example.com']);
    assert.ok(server.getExtensionGrant(grant.grantToken), 'precondition: extension grant valid');
    assert.strictEqual(server.revokeExtensionGrant(grant.grantToken), true, 'explicit revocation acknowledges token');
    assert.strictEqual(server.getExtensionGrant(grant.grantToken), null, 'revoked extension grant rejected');

    const grant2 = server.issueExtensionGrant('partition-cookies-2', ['example.com']);
    assert.ok(server.getExtensionGrant(grant2.grantToken), 'precondition: second grant valid');
    server.rotateToken();
    assert.strictEqual(server.getExtensionGrant(grant2.grantToken), null, 'rotation must revoke extension grants');
    server.dispose();
  });

  it('LAN access is forbidden by default and permitted after opt-in rebind', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    // Default: loopback-only bind host (no LAN exposure).
    assert.strictEqual(server.isLanOptIn(), false, 'LAN opt-in must default to false');

    await server.setLanOptIn(true);
    assert.strictEqual(server.isLanOptIn(), true, 'opt-in must be readable');
    server.dispose();
  });
});

describe('Bridge discovery & pairing queue isolation from the live data root', () => {
  const withIsolatedRoots = async (
    fn: (dirs: { configDir: string; dataRoot: string }) => Promise<void> | void
  ): Promise<void> => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-bridge-config-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-bridge-root-'));
    const prevConfig = process.env.ANTIFAN_CONFIG_DIR;
    const prevRoot = process.env.ANTIFAN_DATA_ROOT;
    process.env.ANTIFAN_CONFIG_DIR = configDir;
    process.env.ANTIFAN_DATA_ROOT = dataRoot;
    StorageLocations.resetCache();
    try {
      await fn({ configDir, dataRoot });
    } finally {
      if (prevConfig === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
      else process.env.ANTIFAN_CONFIG_DIR = prevConfig;
      if (prevRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
      else process.env.ANTIFAN_DATA_ROOT = prevRoot;
      StorageLocations.resetCache();
      try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
    }
  };

  it('ephemeral instances serve pairing without publishing discovery or touching the shared queue', async () => {
    await withIsolatedRoots(async ({ configDir, dataRoot }) => {
      const mockHost = new MockTabHost() as unknown as NativeTabHost;
      const server = new BridgeServer(mockHost, 0, true);
      try {
        await server.start();
        assert.strictEqual(
          fs.existsSync(path.join(configDir, 'bridge-dev.json')),
          false,
          'an ephemeral-port instance must not publish discovery metadata into the shared config dir'
        );
        const sharedQueue = path.join(dataRoot, 'runtime', 'pairing-queue');
        assert.deepStrictEqual(
          fs.existsSync(sharedQueue) ? fs.readdirSync(sharedQueue) : [],
          [],
          'an ephemeral-port instance must not populate the shared pairing queue'
        );
        const challenge = server.claimPairingChallenge('mcp');
        assert.ok(challenge?.code, 'ephemeral instances must still serve pairing challenges from their private queue');
      } finally {
        server.dispose();
      }
    });
  });

  it('refills a depleted pairing queue synchronously for the observing caller', async () => {
    await withIsolatedRoots(async () => {
      const mockHost = new MockTabHost() as unknown as NativeTabHost;
      const server = new BridgeServer(mockHost, 0, true);
      try {
        const port = await server.start();
        const queueDir = (server as unknown as { pairingQueueDir: string }).pairingQueueDir;
        for (const file of fs.readdirSync(queueDir)) {
          fs.unlinkSync(path.join(queueDir, file));
        }
        assert.deepStrictEqual(fs.readdirSync(queueDir), [], 'precondition: queue is empty');

        const response = await fetch(`http://127.0.0.1:${port}/api/pairing/challenge`, { method: 'POST' });
        assert.strictEqual(response.status, 200, 'the caller that observed the empty queue must still receive a challenge');
        const payload = (await response.json()) as { success?: boolean; code?: string };
        assert.strictEqual(payload.success, true);
        assert.ok(payload.code, 'refilled queue must yield a pairing code');
      } finally {
        server.dispose();
      }
    });
  });

  it('honors a challenge file that outlived the instance that minted it', async () => {
    await withIsolatedRoots(async () => {
      const mockHost = new MockTabHost() as unknown as NativeTabHost;
      const registry = new AttachmentRegistry();
      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');
      const lease = {
        runtimeId: makeControlPlaneId('runtime'),
        projectId,
        workspaceId,
        token: 'lease-token',
        protocolVersion: 1,
        hostEpoch: 1,
        ownerPid: process.pid,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      };
      const server = new BridgeServer(mockHost, 0, true, undefined, () => ({ lease, projectId, workspaceId }), registry);
      try {
        const port = await server.start();
        const queueDir = (server as unknown as { pairingQueueDir: string }).pairingQueueDir;
        for (const file of fs.readdirSync(queueDir)) {
          fs.unlinkSync(path.join(queueDir, file));
        }
        // Simulate the queue file a previous, now-dead instance left behind: the file
        // is valid and unexpired, but its code is absent from this instance's store.
        const orphanCode = crypto.randomBytes(16).toString('hex');
        const challengeId = 'challenge-orphaned-instance';
        fs.writeFileSync(
          path.join(queueDir, `${challengeId}.json`),
          JSON.stringify({
            challengeId,
            code: orphanCode,
            clientClass: 'mcp',
            expiresAt: Date.now() + 600_000,
            port,
            host: '127.0.0.1',
          })
        );

        const claim = await fetch(`http://127.0.0.1:${port}/api/pairing/challenge`, { method: 'POST' });
        const claimBody = (await claim.json()) as { code?: string };
        assert.strictEqual(claimBody.code, orphanCode, 'the orphaned file code must be handed out');

        const exchange = await fetch(`http://127.0.0.1:${port}/api/pairing/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: orphanCode, clientClass: 'mcp' }),
        });
        const exchangeBodyText = await exchange.text();
        assert.strictEqual(exchange.status, 200, `an orphaned but unexpired code must still exchange: ${exchangeBodyText}`);
        const exchangeBody = JSON.parse(exchangeBodyText) as { success?: boolean; attachmentId?: string };
        assert.strictEqual(exchangeBody.success, true);
        assert.ok(exchangeBody.attachmentId, 'exchange must mint an attachment for the adopted code');
      } finally {
        server.dispose();
      }
    });
  });

  it('dispose removes only discovery metadata owned by the current process', async () => {
    await withIsolatedRoots(async ({ configDir }) => {
      const mockHost = new MockTabHost() as unknown as NativeTabHost;
      const discoveryPath = path.join(configDir, 'bridge.json');
      fs.writeFileSync(
        discoveryPath,
        JSON.stringify({ port: 20129, pid: process.pid + 1, host: '127.0.0.1' }),
        'utf8'
      );
      new BridgeServer(mockHost, 20129, false).dispose();
      assert.strictEqual(
        fs.existsSync(discoveryPath),
        true,
        'must not delete discovery metadata written by another process'
      );

      fs.writeFileSync(
        discoveryPath,
        JSON.stringify({ port: 20129, pid: process.pid, host: '127.0.0.1' }),
        'utf8'
      );
      new BridgeServer(mockHost, 20129, false).dispose();
      assert.strictEqual(
        fs.existsSync(discoveryPath),
        false,
        'must delete its own discovery metadata'
      );
    });
  });

  it('never overwrites a legacy home mirror held by another live instance', async () => {
    const readMirrorPid = (file: string): unknown => {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && 'pid' in parsed ? parsed.pid : undefined;
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-home-'));
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    const mirrorPath = path.join(home, '.gemini', 'antifan_bridge_dev.json');
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await withIsolatedRoots(async () => {
        const mockHost = new MockTabHost() as unknown as NativeTabHost;
        fs.writeFileSync(mirrorPath, JSON.stringify({ port: 20129, pid: holder.pid, host: '127.0.0.1' }), 'utf8');

        // Port 20190 is never bound: start() is not called, so this is inert
        // discovery metadata, and a non-zero port keeps discovery publishing on.
        const server = new BridgeServer(mockHost, 20190, true);
        server.rotateToken();
        assert.strictEqual(readMirrorPid(mirrorPath), holder.pid, 'a mirror held by a live instance keeps its entry');

        holder.kill();
        await new Promise<void>((resolve) => holder.once('exit', () => resolve()));

        server.rotateToken();
        assert.strictEqual(readMirrorPid(mirrorPath), process.pid, 'a mirror whose holder is dead is replaced');
        server.dispose();
      });
    } finally {
      try { holder.kill(); } catch {}
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});
