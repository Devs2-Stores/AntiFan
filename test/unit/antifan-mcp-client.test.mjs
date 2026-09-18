import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-unit-'));
let scriptCounter = 0;

function createServerScript(body) {
  const scriptPath = path.join(tempDir, `server-double-${++scriptCounter}.cjs`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); } catch { return; }
  ${body}
});
`
  );
  return scriptPath;
}

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

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

test('AntiFanMcpClient rejects promptly when a request exceeds the configured timeout', async () => {
  const hangScript = createServerScript(`
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hang-double', version: '0.0.0' } } }) + '\\n');
    }
  `);
  const client = new AntiFanMcpClient({
    mcpScript: hangScript,
    bootstrap: { port: 1, secret: 'fixture-secret' },
    timeoutMs: 50,
    silent: true,
  });
  try {
    await assert.rejects(
      () => client.callTool('any.tool', {}),
      /timed out after 50ms/i,
      'tool call must time out when server does not respond'
    );
  } finally {
    client.close();
  }
});

test('AntiFanMcpClient sendRaw supports per-call timeout override', async () => {
  const hangScript = createServerScript(`
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hang-double', version: '0.0.0' } } }) + '\\n');
    }
  `);
  const client = new AntiFanMcpClient({
    mcpScript: hangScript,
    bootstrap: { port: 1, secret: 'fixture-secret' },
    silent: true,
  });
  try {
    await client.connect();
    await assert.rejects(
      () => client.sendRaw('tools/call', { name: 'slow.tool' }, 40),
      /timed out after 40ms/i,
      'sendRaw must reject when per-call timeout expires'
    );
  } finally {
    client.close();
  }
});

test('AntiFanMcpClient rejects promptly when child process crashes during an in-flight request', async () => {
  const crashScript = createServerScript(`
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'crash-double', version: '0.0.0' } } }) + '\\n');
    } else if (req.method === 'tools/call') {
      process.exit(42);
    }
  `);
  const client = new AntiFanMcpClient({
    mcpScript: crashScript,
    bootstrap: { port: 1, secret: 'fixture-secret' },
    silent: true,
  });
  try {
    await assert.rejects(
      () => client.callTool('crash.tool', {}),
      /exited with code 42/i,
      'client must reject pending requests when child process crashes'
    );
  } finally {
    client.close();
  }
});

test('AntiFanMcpClient rejects promptly when server emits invalid JSON on stdout', async () => {
  const malformedScript = createServerScript(`
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'malformed-double', version: '0.0.0' } } }) + '\\n');
    } else if (req.method === 'tools/call') {
      process.stdout.write('INVALID_NON_JSON_RAW_STRING\\n');
    }
  `);
  const client = new AntiFanMcpClient({
    mcpScript: malformedScript,
    bootstrap: { port: 1, secret: 'fixture-secret' },
    silent: true,
  });
  try {
    await assert.rejects(
      () => client.callTool('malformed.tool', {}),
      /invalid JSON/i,
      'client must reject promptly when server emits malformed JSON on stdout'
    );
  } finally {
    client.close();
  }
});

test('AntiFanMcpClient rejects connection when child process exits abnormally during handshake', async () => {
  const exitScript = createServerScript(`
    process.exit(1);
  `);
  const client = new AntiFanMcpClient({
    mcpScript: exitScript,
    bootstrap: { port: 1, secret: 'fixture-secret' },
    silent: true,
  });
  try {
    await assert.rejects(
      () => client.connect(),
      /exited with code 1/i,
      'client must reject connect() if child exits immediately'
    );
  } finally {
    client.close();
  }
});
