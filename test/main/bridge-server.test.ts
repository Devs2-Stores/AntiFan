import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

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
  pushAgentMessage(msg: any) {
    return true;
  }
  async getDom() {
    return '<html><body><h1>AntiFan</h1></body></html>';
  }
  async captureScreenshot() {
    return 'base64-mock-png';
  }
}

describe('AntiFan Bridge Server', () => {
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
});
