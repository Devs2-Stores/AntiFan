import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntiFanMcpClient } from '../../scripts/lib/antifan-mcp-client.mjs';

const FIXTURE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp', 'fake-omp-mcp.cjs');

// The client spawns its MCP server and bootstraps it with a Desktop attachment record. These
// tests hand it an explicit bootstrap and a server double, so they run without a live
// attachment; live tool execution belongs to the smoke lane that owns a real session record.
function createClient() {
  return new AntiFanMcpClient({
    mcpScript: FIXTURE_SERVER,
    bootstrap: { port: 1, secret: 'fixture-secret', attachmentId: 'att-fixture', authorityRevision: 'rev-fixture' },
  });
}

test('AntiFanMcpClient connects and lists 52 MCP tools', async () => {
  const client = createClient();
  try {
    await client.connect();
    const tools = await client.listTools();
    assert.ok(tools.length >= 50, `Expected at least 50 tools, got ${tools.length}`);

    const toolNames = new Set(tools.map(t => t.name));
    assert.ok(toolNames.has('anti.browser.tabs.list'));
    assert.ok(toolNames.has('anti.browser.navigate'));
    assert.ok(toolNames.has('anti.inspect.dom'));
    assert.ok(toolNames.has('anti.screenshot.full_page'));
    assert.ok(toolNames.has('theme.qa_validate'));
    assert.ok(toolNames.has('anti.verification.record_claim'));

    const tabs = await client.callTool('anti.browser.tabs.list', { all: true });
    assert.ok(Array.isArray(tabs), 'tabs must be an array');
    assert.equal(tabs.length, 2);
  } finally {
    client.close();
  }
});

test('AntiFanMcpClient rejects when a tool call reports an error result', async () => {
  const client = createClient();
  try {
    await assert.rejects(
      () => client.callTool('anti.browser.fail', {}),
      /REVISION_STALE/,
      'a failed tool call must surface its cause, not return the message as data'
    );
  } finally {
    client.close();
  }
});
