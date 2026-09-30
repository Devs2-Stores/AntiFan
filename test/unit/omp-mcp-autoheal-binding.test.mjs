// omp-mcp-autoheal-binding.test.mjs — regression for the unbound pairing
// attachment defect in scripts/antifan-omp-mcp.cjs `autohealSession`.
//
// Defect being pinned: when the pairing exchange mints an attachment with no
// browser target and `browser.list-tabs` answers `[]`, the old code fabricated
// `tabId: 'default-tab'` — a phantom id that passed the session-mandatory-field
// check and skipped `antifan.cli.startSession`, leaving the attachment
// permanently unbound (`tabs.list` `[]`, TARGET_REQUIRED / CAPABILITY_ERROR on
// every browser call — the Whenever session reproduction).
//
// Contract under test: a paired exchange that resolves no real tabId MUST fall
// through to `antifan.cli.startSession` scoped to the pairing attachment, and
// the caller's later dispatch MUST carry the freshly minted attachment identity
// (attachmentId + secret), not the unbound pairing one.
//
// What this file deliberately does NOT do:
//   * it never touches a real bridge, disk discovery, or ANTIFAN_* env;
//   * the mock bridge is the only endpoint the child can reach: the bootstrap
//     names the mock's port and every ANTIFAN_(TERMINAL|BRIDGE|ATTACHMENT|…)
//     env key is stripped so no live instance can be reused.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');

const UNBOUND_ATTACHMENT = 'att-pairing-unbound';
const BOUND_ATTACHMENT = 'att-session-bound';
const BOUND_TAB = 'tab-agent-provisioned-1';

/** Env for the proxy child: bootstrap names ONLY the mock bridge. */
function childEnv(port) {
  const env = {
    ...process.env,
    ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({ port, host: '127.0.0.1', token: 'stale-tok', secret: 'stale-tok' }),
  };
  for (const key of Object.keys(env)) {
    if (/^ANTIFAN_(TERMINAL|BRIDGE|BOUND|ATTACHMENT|AUTHORITY|RUN_ID|ATTEMPT|PROJECT|WORKSPACE|OWNER|DATA|CONFIG)/.test(key)) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Mock bridge: HTTP pairing endpoints + a WS endpoint that only accepts the
 * pairing-minted or session-minted secrets (the stale bootstrap token gets 401,
 * which is what drives the child into autoheal).
 */
function startMockBridge(record) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/pairing/challenge') {
        res.end(JSON.stringify({ success: true, code: 'challenge-' + crypto.randomUUID() }));
        return;
      }
      if (req.url === '/api/pairing/exchange') {
        const payload = JSON.parse(body || '{}');
        res.end(
          JSON.stringify({
            success: true,
            secret: 'pairing-secret',
            attachmentId: UNBOUND_ATTACHMENT,
            authorityRevision: 1,
            runId: 'run-pair',
            attemptId: 'attempt-pair',
            projectId: 'project-x',
            workspaceId: 'workspace-x',
            grant: payload.requestedGrant || 'write',
          })
        );
        return;
      }
      res.end(JSON.stringify({ success: false, error: 'unknown endpoint' }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer pairing-secret' && auth !== 'Bearer session-secret') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      record.push(msg);
      const send = (data) => ws.send(JSON.stringify({ id: msg.id, success: true, data }));
      const fail = (error) => ws.send(JSON.stringify({ id: msg.id, success: false, error }));
      if (msg.method === 'antifan.cli.renewSession') return fail('unknown attachment');
      if (msg.method === 'antifan.capability.dispatch' && msg.params?.name === 'browser.list-tabs') {
        // The pairing attachment is unbound: list-tabs fails closed to [].
        return send([]);
      }
      if (msg.method === 'antifan.cli.startSession') {
        return send({
          runId: 'run-session',
          attemptId: 'attempt-session',
          attachmentId: BOUND_ATTACHMENT,
          secret: 'session-secret',
          authorityRevision: 2,
          projectId: 'project-x',
          workspaceId: 'workspace-x',
          tabId: BOUND_TAB,
          expiresAt: Date.now() + 3_600_000,
        });
      }
      if (msg.method === 'antifan.capability.dispatch') return send({ ok: true });
      return send({ ok: true });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('paired exchange with an unbound attachment falls through to startSession and dispatches on the minted session', async () => {
  const record = [];
  const { server, port } = await startMockBridge(record);
  const child = spawn(process.execPath, [PROXY], { env: childEnv(port), stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    // The first tools/call triggers connect (401 on the stale bootstrap secret)
    // → autoheal → pairing → unbound attachment → the code under test.
    await new Promise((r) => setTimeout(r, 1200));
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'anti.browser.tabs.list', arguments: { all: true } } });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const text = Buffer.concat(stdout).toString('utf8');
      if (/"id"\s*:\s*2/.test(text)) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const startSessionCalls = record.filter((m) => m.method === 'antifan.cli.startSession');
    assert.equal(startSessionCalls.length, 1, 'startSession must run exactly once when no tabId resolves');
    assert.equal(
      startSessionCalls[0].params?.attachmentId,
      UNBOUND_ATTACHMENT,
      'startSession stays self-scoped to the pairing attachment (bridge requires p.attachmentId === boundAttachmentId)'
    );

    const dispatches = record.filter((m) => m.method === 'antifan.capability.dispatch');
    const agentDispatch = dispatches.find((m) => m.params?.name === 'anti.browser.tabs.list');
    assert.ok(agentDispatch, 'the caller tools/call must reach the bridge as a dispatch');
    assert.equal(
      agentDispatch.params?.attachmentId,
      BOUND_ATTACHMENT,
      'post-bootstrap dispatch must carry the startSession-minted attachment, not the unbound pairing one'
    );
    assert.equal(agentDispatch.params?.attachmentSecret, 'session-secret');

    const text = Buffer.concat(stdout).toString('utf8');
    assert.ok(!text.includes('default-tab'), 'no phantom tab id may leak to the caller');
    assert.ok(!Buffer.concat(stderr).toString('utf8').includes('default-tab'), 'no phantom tab id in proxy logs');
  } finally {
    child.kill();
    await new Promise((r) => server.close(r));
  }
});
