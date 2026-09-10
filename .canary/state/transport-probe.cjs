/**
 * Throwaway probe: what does the MCP proxy do when the dispatch socket is
 * terminated while a call is in flight? Records every dispatch frame the fake
 * bridge receives (with its invocation identity) so the retry contract can be
 * asserted from evidence rather than from reading the proxy.
 */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');

const frames = [];
const connections = [];
let child;

async function main() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;

  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.method === 'antifan.cli.renewSession' || msg.id === 'hb') {
        ws.send(JSON.stringify({ id: 'hb', success: true, data: { expiresAt: Date.now() + 60000 } }));
        return;
      }
      if (msg.method === 'antifan.capability.dispatch') {
        frames.push({
          socket: connections.indexOf(ws),
          outerId: msg.id,
          requestId: msg.params && msg.params.requestId,
          idempotencyKey: msg.params && msg.params.idempotencyKey,
          name: msg.params && msg.params.name,
          at: Date.now(),
        });
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: msg.id, success: true, data: { ok: true, requestId: msg.params && msg.params.requestId } }));
          }
        }, Math.floor(Math.random() * 20) + 5);
      }
    });
  });

  child = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({ port, secret: 'probe-secret', attachmentId: 'binding-probe', runId: 'run-probe', attemptId: 'attempt-probe', projectId: 'project-probe', workspaceId: 'workspace-probe' }),
      ANTIFAN_HEARTBEAT_MS: '500',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  const responses = [];
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { responses.push(JSON.parse(line)); } catch {}
    }
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });

  await new Promise((r) => setTimeout(r, 500));
  // Warm the persistent dispatch socket.
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'anti.browser.tabs.list', arguments: {} } });
  await new Promise((r) => setTimeout(r, 700));

  frames.length = 0;
  send({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'anti.browser.tabs.list', arguments: {} } });
  await new Promise((r) => setTimeout(r, 5));
  const live = contacts_target();
  function contacts_target() {
    const target = connections.find((c) => c === null) || connections[connections.length - 1];
    return target;
  }
  let terminateError = null;
  try { live.terminate(); } catch (err) { terminateError = String(err && err.message); }
  console.log('PROBE_TERMINATED_SOCKET', connections.indexOf(live), 'total', connections.length, 'error', terminateError, 'readyState', live.readyState);
  await new Promise((r) => setTimeout(r, 15000));

  const final = responses.find((r) => r.id === 999);
  console.log('PROBE_FRAMES', JSON.stringify(frames, null, 2));
  console.log('PROBE_FINAL', JSON.stringify(final));
  console.log('PROBE_CONNECTIONS', connections.length);
  console.log('PROBE_STDERR', stderr.join('').split('\n').filter((l) => l.trim()).slice(0, 12).join(' | '));

  try { child.kill(); } catch {}
  for (const ws of connections) { try { ws.terminate(); } catch {} }
  wss.close();
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error('PROBE_CRASH', err);
  process.exit(1);
});
