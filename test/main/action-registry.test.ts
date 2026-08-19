import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { BrowserActionRegistry } from '../../src/main/browser/browser-action-registry';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

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
  reload(tabId: string) {
    return true;
  }
  goBack(tabId: string) {
    return true;
  }
  goForward(tabId: string) {
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
  async getDom(selector?: string) {
    return '<html><body><h1>AntiFan</h1></body></html>';
  }
  async captureScreenshot() {
    return 'mock-base64-screenshot';
  }
  async evalJs(expr: string) {
    return { evaluated: expr };
  }
}

describe('BrowserActionRegistry (Extensibility Phase 1)', () => {
  it('registers core actions with aliases and MCP tool mappings', () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const registry = new BrowserActionRegistry(mockHost);

    const tools = registry.listMcpTools(false);
    assert.ok(tools.length >= 8, `Expected at least 8 tools, got ${tools.length}`);

    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes('antifan_open_tab'));
    assert.ok(toolNames.includes('antifan_list_tabs'));
    assert.ok(toolNames.includes('antifan_switch_tab'));
    assert.ok(toolNames.includes('antifan_close_tab'));
    assert.ok(toolNames.includes('antifan_navigate'));
    assert.ok(toolNames.includes('antifan_screenshot'));
    assert.ok(toolNames.includes('antifan_get_dom'));
    assert.ok(toolNames.includes('antifan_toggle_inspect'));

    // eval_js should be excluded when includeHighRisk = false
    assert.strictEqual(toolNames.includes('antifan_eval_js'), false);

    // eval_js should be included when includeHighRisk = true
    const highRiskTools = registry.listMcpTools(true);
    assert.ok(highRiskTools.map((t) => t.name).includes('antifan_eval_js'));
  });

  it('dispatches core actions via aliases correctly', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const registry = new BrowserActionRegistry(mockHost);

    // Test openTab
    const openRes = await registry.execute('openTab', { url: 'https://example.com' });
    assert.strictEqual(openRes.success, true);
    assert.ok(openRes.tabId);

    // Test alias antifan.openTab
    const aliasRes = await registry.execute('antifan.openTab', { url: 'https://github.com' });
    assert.strictEqual(aliasRes.success, true);
    assert.ok(aliasRes.tabId);

    // Test getDOM
    const domRes = await registry.execute('getDOM');
    assert.strictEqual(domRes.html, '<html><body><h1>AntiFan</h1></body></html>');

    // Test captureScreenshot
    const shotRes = await registry.execute('captureScreenshot');
    assert.strictEqual(shotRes.imageBase64, 'mock-base64-screenshot');
  });

  it('enforces high-risk execution guard', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const registry = new BrowserActionRegistry(mockHost);

    // Without allowHighRisk, evalJs should throw
    await assert.rejects(
      async () => {
        await registry.execute('evalJs', { expression: '1 + 1' }, false);
      },
      /high-risk/
    );

    // With allowHighRisk, evalJs succeeds
    const evalRes = await registry.execute('evalJs', { expression: '1 + 1' }, true);
    assert.deepStrictEqual(evalRes.result, { evaluated: '1 + 1' });
  });
});
