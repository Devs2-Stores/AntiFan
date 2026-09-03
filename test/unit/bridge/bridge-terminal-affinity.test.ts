import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { ControlPlaneRuntime } from '../../../src/main/control-plane/control-plane-runtime';

describe('BridgeServer Terminal Affinity Resolution Live RPC Contract Tests', () => {
  let server: BridgeServer;
  let port: number;
  let ws: WebSocket;
  let recordedAutomationTabId: string | null = null;
  let lastSessionCreatedOpts: any = null;

  class MockTabHost extends EventEmitter {
    hasTab(id?: string | null) { return id === 'tab-alive' || id === 'tab-auto' || id === 'tab-active'; }
    getAutomationTabId() { return 'tab-auto'; }
    getActiveTabId() { return 'tab-active'; }
    setAutomationTabId(id: string) { recordedAutomationTabId = id; }
    getActiveTab() { return { id: 'tab-active' }; }
    getTabList() { return [{ id: 'tab-alive' }, { id: 'tab-auto' }]; }
    createTab() { return 'tab-created'; }
    getTerminalAgentAffinity(termId: string, gen?: string | number) {
      if (termId === 'term-alive' && (gen === undefined || String(gen) === '1')) {
        return { tabId: 'tab-alive', status: 'alive' as const, lastUrl: 'https://alive.test' };
      }
      if (termId === 'term-closed') {
        return { tabId: 'tab-closed', status: 'closed' as const, lastUrl: 'https://closed.test' };
      }
      return undefined;
    }
  }

  const mockControlPlane = {
    createCliSession: async (opts: any) => {
      lastSessionCreatedOpts = opts;
      return {
        run: { id: 'run-test-123456789012' },
        attempt: { id: 'attempt-test-123456789012' },
        launch: {
          attachmentId: 'binding-test-123456789012',
          secret: 'secret-test-123456789012',
          authorityRevision: 'rev-test-123456789012',
          projectId: opts?.projectId || 'project-local',
          workspaceId: opts?.workspaceId || 'workspace-local',
          expiresAt: Date.now() + 3600000,
        },
      };
    },
  };

  before(async () => {
    const mockHost = new MockTabHost();
    server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    server.setControlPlane(mockControlPlane as unknown as ControlPlaneRuntime);
    port = await server.start();
    const token = server.getToken();
    ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.once('open', () => resolve());
    ws.once('error', reject);
    await promise;
  });

  after(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    if (server) {
      server.dispose();
    }
  });

  function rpcCall(method: string, params: any, timeoutMs = 5000): Promise<any> {
    const id = `rpc-${Math.random().toString(36).slice(2)}`;
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`RPC timed out for method ${method}`));
    }, timeoutMs);

    const onMessage = (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {}
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  it('1. Successfully resolves alive terminal affinity and sets automation tab', async () => {
    recordedAutomationTabId = null;
    const resp = await rpcCall('antifan.cli.startSession', {
      terminalSessionId: 'term-alive',
      terminalGeneration: 1,
    });

    assert.strictEqual(resp.success, true);
    assert.strictEqual(recordedAutomationTabId, 'tab-alive');
  });

  it('2. Fails closed with TERMINAL_TAB_CLOSED when bound tab was closed', async () => {
    const resp = await rpcCall('antifan.cli.startSession', {
      terminalSessionId: 'term-closed',
    });

    assert.strictEqual(resp.success, false);
    assert.ok(resp.error.includes('TERMINAL_TAB_CLOSED'));
  });

  it('3. Fails closed with TERMINAL_TAB_UNBOUND when terminal has no affinity or generation mismatch', async () => {
    const resp = await rpcCall('antifan.cli.startSession', {
      terminalSessionId: 'term-alive',
      terminalGeneration: 999, // mismatch
    });

    assert.strictEqual(resp.success, false);
    assert.ok(resp.error.includes('TERMINAL_TAB_UNBOUND'));
  });

  it('4. Validates explicit tabId and rejects non-existent tabId up front with TAB_NOT_FOUND', async () => {
    const resp = await rpcCall('antifan.cli.startSession', {
      tabId: 'tab-does-not-exist',
    });

    assert.strictEqual(resp.success, false);
    assert.ok(resp.error.includes('TAB_NOT_FOUND'));
  });

  it('5. Accepts valid explicit tabId and sets automation tab', async () => {
    recordedAutomationTabId = null;
    const resp = await rpcCall('antifan.cli.startSession', {
      tabId: 'tab-alive',
    });

    assert.strictEqual(resp.success, true);
    assert.strictEqual(recordedAutomationTabId, 'tab-alive');
  });

  it('6. Uses fallback only when terminalSessionId and tabId are omitted', async () => {
    recordedAutomationTabId = null;
    const resp = await rpcCall('antifan.cli.startSession', {});

    assert.strictEqual(resp.success, true);
    assert.strictEqual(recordedAutomationTabId, 'tab-auto');
  });
});
