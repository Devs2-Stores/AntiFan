import test from 'node:test';
import assert from 'node:assert/strict';
import { AntiFanMcpClient } from '../../scripts/lib/antifan-mcp-client.mjs';

test('AntiFanMcpClient connects and lists 52 MCP tools', async () => {
  const client = new AntiFanMcpClient();
  try {
    await client.connect();
    const tools = await client.listTools();
    assert.ok(tools.length >= 50, `Expected at least 50 tools, got ${tools.length}`);

    // Verify key categories exist
    const toolNames = new Set(tools.map(t => t.name));
    assert.ok(toolNames.has('anti.browser.tabs.list'));
    assert.ok(toolNames.has('anti.browser.navigate'));
    assert.ok(toolNames.has('anti.inspect.dom'));
    assert.ok(toolNames.has('anti.screenshot.full_page'));
    assert.ok(toolNames.has('theme.qa_validate'));
    assert.ok(toolNames.has('anti.verification.record_claim'));

    // Call anti.browser.tabs.list via MCP
    const tabs = await client.callTool('anti.browser.tabs.list', { all: true });
    assert.ok(Array.isArray(tabs), 'tabs must be an array');
    console.log('[Test OK] Open tabs retrieved via AntiFan MCP:', tabs.length);
  } finally {
    client.close();
  }
});
