// proxy-evaluate-envelope.test.mjs — the evaluate family answers in one stable JSON envelope
// { ok, value, valueType } whatever the page script returned, and nothing else is wrapped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const proxy = require(PROXY);

test('every evaluate-family name, and only those, is wrapped', () => {
  for (const name of ['anti.browser.evaluate', 'anti.inspect.eval', 'browser.evaluate', 'antifan_evaluate', 'anti.browser.evaluate_frame']) {
    assert.equal(proxy.isEvaluateTool(name), true, name);
  }
  for (const name of ['anti.inspect.dom', 'anti.browser.navigate', 'anti.artifact.read', 'theme.qa_validate']) {
    assert.equal(proxy.isEvaluateTool(name), false, name);
  }
});

test('the envelope types every kind of page result', () => {
  assert.deepEqual(proxy.wrapEvaluateResult('text'), { ok: true, value: 'text', valueType: 'string' });
  assert.deepEqual(proxy.wrapEvaluateResult(7), { ok: true, value: 7, valueType: 'number' });
  assert.deepEqual(proxy.wrapEvaluateResult(false), { ok: true, value: false, valueType: 'boolean' });
  assert.deepEqual(proxy.wrapEvaluateResult(null), { ok: true, value: null, valueType: 'null' });
  assert.deepEqual(proxy.wrapEvaluateResult({ a: 1 }), { ok: true, value: { a: 1 }, valueType: 'object' });
  assert.deepEqual(proxy.wrapEvaluateResult([1, 2]), { ok: true, value: [1, 2], valueType: 'object' });
  assert.equal(JSON.stringify(proxy.wrapEvaluateResult(undefined)), '{"ok":true,"valueType":"undefined"}');
});

test('a result already in envelope shape is not wrapped twice', () => {
  const enveloped = { ok: true, value: 'x', valueType: 'string' };
  assert.equal(proxy.wrapEvaluateResult(enveloped), enveloped);
  // An object that merely has an `ok` field is page data, not an envelope.
  assert.deepEqual(proxy.wrapEvaluateResult({ ok: true, value: 1 }), { ok: true, value: { ok: true, value: 1 }, valueType: 'object' });
});

// Deleting ANTIFAN_DATA_ROOT is not enough: bridge discovery then falls back to the default
// data root and can reach the live app. Pin both to an empty tempdir so it finds nothing.
const ISOLATED_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-envelope-test-'));
test.after(() => fs.rmSync(ISOLATED_DATA_ROOT, { recursive: true, force: true }));

function childEnv(port) {
  const env = {
    ...process.env,
    ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
      port, secret: 'live-secret', attachmentId: 'att-envelope', authorityRevision: 'rev_1', projectId: 'project-x', workspaceId: 'workspace-x',
    }),
  };
  for (const key of Object.keys(env)) {
    if (/^ANTIFAN_(TERMINAL|BRIDGE|BOUND|ATTACHMENT|AUTHORITY|RUN_ID|ATTEMPT|PROJECT|WORKSPACE|OWNER|DATA|CONFIG)/.test(key)) delete env[key];
  }
  env.ANTIFAN_DATA_ROOT = ISOLATED_DATA_ROOT;
  env.ANTIFAN_CONFIG_DIR = path.join(ISOLATED_DATA_ROOT, 'config');
  return env;
}

/** A bridge that answers every dispatch with the next queued page result. */
function startBridge(results) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const dispatched = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'antifan.capability.dispatch') {
        dispatched.push(msg.params.name);
        ws.send(JSON.stringify({ id: msg.id, success: true, data: { data: results.shift(), authorityRevision: 'rev_1' } }));
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, success: true, data: { expiresAt: Date.now() + 3_600_000, authorityRevision: 'rev_1' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, wss, dispatched, port: server.address().port })));
}

test('the proxy delivers each evaluate result as one JSON envelope text and leaves other tools alone', async () => {
  const values = ['hello', 42, { items: ['a', 'b'] }, null, true, 'line one\n\n[a trailing note]'];
  const results = [...values, 'plain string from another tool'];
  const { server, wss, port } = await startBridge(results);
  const child = spawn(process.execPath, [PROXY], { env: childEnv(port), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const response = async (id) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const row = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((value) => value.id === id);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No MCP response for ${id}: ${stderr}`);
  };
  const call = (id, name, args) => {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return response(id);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'envelope', version: '1' } } });
    await response(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const expectedTypes = ['string', 'number', 'object', 'null', 'boolean', 'string'];
    for (const [index, value] of values.entries()) {
      const reply = await call(10 + index, 'anti.browser.evaluate', { expression: 'irrelevant', tabId: 'tab-1' });
      assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
      assert.equal(reply.result.content.length, 1);
      assert.deepEqual(JSON.parse(reply.result.content[0].text), { ok: true, value, valueType: expectedTypes[index] });
    }

    const other = await call(30, 'anti.browser.tabs.list', {});
    assert.equal(other.result.content[0].text, 'plain string from another tool', 'only the evaluate family is wrapped');
  } finally {
    child.kill();
    wss.clients.forEach((client) => client.terminate());
    await new Promise((resolve) => server.close(resolve));
  }
});
