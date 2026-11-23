// A wait named only by its duration must reach the capability as the timeout form it infers its
// condition from. A live bridge cannot be assumed in a unit run, and the ambient ANTIFAN_* environment
// of an agent shell names a real one, so the call is driven against a throwaway WebSocket dispatch
// server in a child process with a cleared environment: the frame the proxy sends is the assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');

test('a wait carrying only timeoutMs is dispatched as a timeout wait', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wait-form-'));
  const script = `
const { WebSocketServer } = require('ws');
const proxy = require(${JSON.stringify(PROXY)});
let frame = null;
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
  process.env.ANTIFAN_ATTACHMENT_SECRET = 'unit-secret';
  process.env.ANTIFAN_ATTACHMENT_ID = 'att-unit';
  process.env.ANTIFAN_MCP_PORT = String(server.address().port);
  proxy.invoke('anti.browser.wait', { tabId: 't-1', timeoutMs: 3000 }).then((result) => {
    process.stdout.write(JSON.stringify({
      name: frame && frame.name,
      params: frame && frame.params,
      attachmentId: frame && frame.attachmentId,
      result,
    }));
    server.close();
    process.exit(0);
  }, (err) => {
    process.stdout.write(JSON.stringify({ error: String(err && err.message) }));
    server.close();
    process.exit(0);
  });
});
server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    frame = message.params;
    socket.send(JSON.stringify({ id: message.id, success: true, data: { satisfied: true, timedOut: false } }));
  });
});
`;
  // Every ambient ANTIFAN_* variable names this machine's real bridge (port, secret, data root); a
  // child that inherited them would dispatch to it instead of the throwaway server.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('ANTIFAN_')) env[key] = value;
  env.ANTIFAN_DATA_ROOT = dataRoot;
  const child = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  assert.equal(child.status, 0, `probe failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  const observed = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(observed.error, undefined, `the call must dispatch: ${observed.error}`);
  assert.equal(observed.name, 'anti.browser.wait', 'the advertised alias row is registered by the catalogue, so it dispatches under its own name');
  assert.deepEqual(observed.params, { tabId: 't-1', timeoutMs: 3000, timeout: 3000 }, 'the capability receives the duration in the form it infers its condition from');
  assert.equal(observed.attachmentId, 'att-unit');
  assert.deepEqual(observed.result.aliasApplied, [{ from: 'timeoutMs=3000', to: 'timeout=3000' }]);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
