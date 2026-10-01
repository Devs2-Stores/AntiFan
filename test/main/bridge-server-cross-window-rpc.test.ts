import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

/**
 * Two "windows": bootstrap host A owns tab-a; host B owns tab-b (a minted tab that
 * lives on a second window — the B-F1 finding). Every direct-RPC op that names a
 * tab id must reach the OWNING host, not the construction host the BridgeServer
 * was built on.
 */
class WindowTabHost extends EventEmitter {
  public calls: string[] = [];
  private tabs = new Map<string, string>();

  constructor(private name: string, tabIds: string[]) {
    super();
    for (const id of tabIds) this.tabs.set(id, 'about:blank');
  }

  hasTab(tabId?: string | null): boolean {
    return !!tabId && this.tabs.has(tabId);
  }
  resolveTargetTabId(tabId: string): string | undefined {
    return this.tabs.has(tabId) ? tabId : undefined;
  }
  noteAgentTabActivity() { /* noop */ }
  getActiveTabId() { return undefined; }
  getTabList() { return [...this.tabs.keys()].map((id) => ({ id, url: this.tabs.get(id) })); }

  switchTab(tabId: string) { this.calls.push(`${this.name}.switchTab:${tabId}`); return this.tabs.has(tabId); }
  closeTab(tabId: string) { this.calls.push(`${this.name}.closeTab:${tabId}`); return this.tabs.delete(tabId); }
  navigate(tabId: string, url: string) { this.calls.push(`${this.name}.navigate:${tabId}`); if (!this.tabs.has(tabId)) return false; this.tabs.set(tabId, url); return true; }
  reload(tabId: string) { this.calls.push(`${this.name}.reload:${tabId}`); return this.tabs.has(tabId); }
  goBack(tabId: string) { this.calls.push(`${this.name}.goBack:${tabId}`); return this.tabs.has(tabId); }
  goForward(tabId: string) { this.calls.push(`${this.name}.goForward:${tabId}`); return this.tabs.has(tabId); }
  async evalJs(expression: string, tabId?: string) { this.calls.push(`${this.name}.evalJs:${tabId}`); return { evaluated: expression, tabId }; }
  async getDom(_sel?: string, tabId?: string) { this.calls.push(`${this.name}.getDom:${tabId}`); return `<html>${tabId}</html>`; }
  async captureScreenshot(_rect?: unknown, tabId?: string) { this.calls.push(`${this.name}.captureScreenshot:${tabId}`); return 'png64'; }
}

function openRpc(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(ws)); ws.on('error', reject); });
}

function callRpc(ws: WebSocket, id: string, method: string, params?: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer | string) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.id === id) { ws.off('message', onMessage); resolve(parsed); }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

describe('Bridge direct-RPC cross-window host routing', () => {
  it('routes tab-addressed ops to the host that owns the tab, not the bootstrap host', async () => {
    const hostA = new WindowTabHost('A', ['tab-a']);
    const hostB = new WindowTabHost('B', ['tab-b']);
    const server = new BridgeServer(hostA as unknown as NativeTabHost, 0, false);
    server.setTabHostResolver((tabId) => (hostB.hasTab(tabId) ? hostB : undefined) as unknown as NativeTabHost | undefined);

    const ws = await openRpc(await server.start(), server.getToken());
    try {
      for (const [method, params] of [
        ['antifan.switchTab', { tabId: 'tab-b' }],
        ['antifan.closeTab', { tabId: 'tab-b' }],
        ['antifan.navigate', { tabId: 'tab-b', url: 'https://b.example' }],
        ['antifan.reload', { tabId: 'tab-b' }],
        ['antifan.goBack', { tabId: 'tab-b' }],
        ['antifan.goForward', { tabId: 'tab-b' }],
        ['antifan.evalJS', { tabId: 'tab-b', expression: '1' }],
        ['antifan.getDOM', { tabId: 'tab-b' }],
        ['antifan.captureScreenshot', { tabId: 'tab-b' }],
      ] as const) {
        // closeTab deletes tab-b, so restore it for the next op.
        const res = await callRpc(ws, `${method}-1`, method, { ...params });
        assert.strictEqual(res.success, true, `${method} failed: ${res.error}`);
        hostB['tabs'].set('tab-b', 'about:blank');
      }

      assert.ok(hostB.calls.length >= 9, `expected ops on B, got ${JSON.stringify(hostB.calls)}`);
      assert.ok(hostB.calls.every((c) => c.startsWith('B.') && c.endsWith(':tab-b')),
        `all ops must route to B/tab-b: ${JSON.stringify(hostB.calls)}`);
      assert.deepStrictEqual(
        hostA.calls.filter((c) => c.includes('tab-b')),
        [],
        `bootstrap host A must never see tab-b ops: ${JSON.stringify(hostA.calls)}`
      );
    } finally {
      ws.close();
      server.dispose();
    }
  });

  it('fails closed TARGET_CLOSED for a tab no window owns', async () => {
    const hostA = new WindowTabHost('A', ['tab-a']);
    const server = new BridgeServer(hostA as unknown as NativeTabHost, 0, false);
    server.setTabHostResolver(() => undefined);
    const ws = await openRpc(await server.start(), server.getToken());
    try {
      const res = await callRpc(ws, 'gone-1', 'antifan.navigate', { tabId: 'tab-gone', url: 'https://x' });
      assert.strictEqual(res.success, false);
      assert.match(res.error || '', /TARGET_CLOSED/);
    } finally {
      ws.close();
      server.dispose();
    }
  });
});
