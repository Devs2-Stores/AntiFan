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
function startMockBridge(record, options = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/pairing/challenge') {
        record.push({ method: 'pairing.challenge' });
        res.end(JSON.stringify({ success: true, code: 'challenge-' + crypto.randomUUID() }));
        return;
      }
      if (req.url === '/api/pairing/exchange') {
        record.push({ method: 'pairing.exchange' });
        const payload = JSON.parse(body || '{}');
        if (options.recoveredStaleAnchor) {
          assert.equal(payload.projectId, 'project-x', 'exchange must claim the measured dead-authority project');
          assert.equal(payload.workspaceId, 'workspace-x', 'exchange must claim the measured dead-authority workspace');
          assert.equal(payload.terminalSessionId, 'terminal-restart-regression', 'exchange must carry terminal scope evidence');
          assert.equal(payload.tabId, 'tab-before-restart', 'exchange must claim the stale anchor it is recovering');
        }
        res.end(
          JSON.stringify({
            success: true,
            secret: 'pairing-secret',
            attachmentId: UNBOUND_ATTACHMENT,
            authorityRevision: 1,
            recoveredStaleAnchor: Boolean(options.recoveredStaleAnchor),
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
  let staleBootstrapAccepted = false;
  let staleDispatchCount = 0;
  let attachmentRotated = false;
  const executed = new Map();
  const refused = new Set();
  server.on('upgrade', (req, socket, head) => {
    const auth = req.headers['authorization'] || '';
    const isStale = auth === 'Bearer stale-tok';
    const isCurrent = auth === 'Bearer pairing-secret' || auth === 'Bearer session-secret';
    if (!isCurrent && !(isStale && options.closeAfterFirstDispatch && (!staleBootstrapAccepted || (options.reuseAttachment && !attachmentRotated)))) {
      if (isStale && attachmentRotated) record.push({ method: 'fixture.attachmentReuseRefused', phase: 'upgrade' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const oldAuthority = req.headers.authorization === 'Bearer stale-tok';
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      record.push(msg);
      const send = (data) => ws.send(JSON.stringify({ id: msg.id, success: true, data }));
      const fail = (error) => ws.send(JSON.stringify({ id: msg.id, success: false, error }));
      if (oldAuthority && msg.method === 'antifan.capability.dispatch') {
        staleDispatchCount += 1;
        if (options.reuseAttachment) {
          const key = msg.params.idempotencyKey;
          const digest = JSON.stringify(msg.params.params);
          if (options.refuseOnceWith && !refused.has(key)) {
            refused.add(key);
            return ws.send(JSON.stringify({
              id: msg.id, success: false,
              error: `${options.refuseOnceWith}: authority revision stale`,
              data: { code: options.refuseOnceWith, message: 'authority revision stale', details: { requestedRevision: 1, liveRevision: 2 } },
            }));
          }
          const previous = executed.get(key);
          if (previous) {
            assert.equal(digest, previous.digest, 'same identity must preserve the exact mutation params');
            return send(previous.result);
          }
          const result = { ok: true, execution: 1 };
          executed.set(key, { digest, result });
          record.push({ method: 'fixture.mutationExecuted', key, digest });
          if (staleDispatchCount >= (options.closeAfterDispatchCount || 1)) {
            staleBootstrapAccepted = true;
            ws.close(4001, 'Unauthorized: missing or invalid token');
            return;
          }
          return send(result);
        }
        staleBootstrapAccepted = true;
        if (staleDispatchCount >= (options.closeAfterDispatchCount || 1)) ws.close(4001, 'Unauthorized: missing or invalid token');
        return;
      }
      if (msg.method === 'antifan.cli.renewSession') {
        if (oldAuthority && options.reuseAttachment && msg.id === 'hb') return send({ expiresAt: Date.now() + 3_600_000 });
        if (oldAuthority && options.reuseAttachment && !attachmentRotated) {
          record.push({ method: 'fixture.attachmentReuseSucceeded', attachmentId: msg.params.attachmentId });
          send({ expiresAt: Date.now() + 3_600_000 });
          if (options.rotateInsideRetry) attachmentRotated = true;
          return;
        }
        record.push({ method: 'fixture.attachmentReuseRefused', attachmentId: msg.params.attachmentId });
        return fail('unknown attachment');
      }
      if (msg.method === 'antifan.capability.dispatch' && msg.params?.name === 'browser.list-tabs') return send([]);
      if (msg.method === 'antifan.cli.startSession') {
        return send({
          runId: 'run-session', attemptId: 'attempt-session', attachmentId: BOUND_ATTACHMENT,
          secret: 'session-secret', authorityRevision: 2, projectId: 'project-x',
          workspaceId: 'workspace-x', tabId: BOUND_TAB, expiresAt: Date.now() + 3_600_000,
        });
      }
      if (msg.method === 'antifan.capability.dispatch' && options.staleTabId && msg.params?.params?.tabId === options.staleTabId) {
        return ws.send(JSON.stringify({ id: msg.id, success: false, error: 'TARGET_MISMATCH: Requested tab is stale', data: { code: 'TARGET_MISMATCH', message: 'Requested tab is stale', details: { requestedTabId: options.staleTabId, liveTabId: BOUND_TAB } } }));
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

test('dispatch closed with 4001 re-pairs and retries using current attachment authority', async () => {
  const record = [];
  const { server, port } = await startMockBridge(record, { closeAfterFirstDispatch: true, recoveredStaleAnchor: true });
  const env = childEnv(port);
  env.ANTIFAN_MCP_BOOTSTRAP = JSON.stringify({ port, secret: 'stale-tok', attachmentId: 'att-before-restart', authorityRevision: 1, projectId: 'project-x', workspaceId: 'workspace-x' });
  env.ANTIFAN_BOUND_TAB_ID = 'tab-before-restart';
  env.ANTIFAN_TERMINAL_SESSION_ID = 'terminal-restart-regression';
  const child = spawn(process.execPath, [PROXY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const response = async id => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const row = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(value => value.id === id);
      if (row) return row;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`No MCP response for ${id}`);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' } } });
    await response(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    for (const id of [2, 3]) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'anti.browser.tabs.list', arguments: {} } });
      assert.notEqual((await response(id)).result?.isError, true);
    }
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch' && value.params.name === 'anti.browser.tabs.list');
    assert.equal(calls[0].params.attachmentId, 'att-before-restart');
    assert.equal(calls.length, 3, 'one failed dispatch, one recovered read, and one subsequent read');
    assert.equal(calls[1].params.idempotencyKey, calls[0].params.idempotencyKey, 'transmitted read retains its identity across attachment recovery');
    assert.equal(record.filter(value => value.method === 'pairing.exchange').length, 1);
    assert.equal(calls.at(-1).params.attachmentId, BOUND_ATTACHMENT);
    assert.equal(calls.at(-1).params.attachmentSecret, 'session-secret');
    assert.equal(record.filter(value => value.method === 'antifan.cli.startSession').length, 1);
    assert.match(stderr, /code=4001/);
    assert.match(stderr, /Autohealing/);
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

async function withRecoveryProxy(options, exercise) {
  const record = [];
  const { server, port } = await startMockBridge(record, options);
  const env = childEnv(port);
  env.ANTIFAN_MCP_BOOTSTRAP = JSON.stringify({ port, secret: 'stale-tok', attachmentId: 'att-before-restart', authorityRevision: 1, projectId: 'project-x', workspaceId: 'workspace-x' });
  env.ANTIFAN_BOUND_TAB_ID = 'tab-before-restart';
  env.ANTIFAN_TERMINAL_SESSION_ID = 'terminal-restart-regression';
  const retryRotationBootstrap = `
    const { WebSocket } = require('ws');
    const originalEmit = WebSocket.prototype.emit;
    const originalSend = WebSocket.prototype.send;
    const state = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'readyState');
    WebSocket.prototype.send = function(data, ...args) {
      const message = JSON.parse(String(data));
      if (message.method === 'antifan.cli.renewSession' && message.id !== 'hb') {
        const socket = this;
        const requestId = message.id;
        const arm = function(event, ...values) {
          if (event === 'message') {
            const response = JSON.parse(String(values[0]));
            if (response.id === requestId && response.success) {
              let armed = true;
              Object.defineProperty(socket, 'readyState', { configurable: true, get() {
                if (armed && new Error().stack.includes('ensureDispatchSocket')) {
                  armed = false;
                  originalSend.call(socket, JSON.stringify({ method: 'fixture.retrySocketInvalidated' }));
                  return WebSocket.CLOSED;
                }
                return state.get.call(socket);
              } });
              socket.emit = originalEmit;
            }
          }
          return originalEmit.call(socket, event, ...values);
        };
        socket.emit = arm;
      }
      return originalSend.call(this, data, ...args);
    };
    process.argv[1] = ${JSON.stringify(PROXY)};
    require('node:module').runMain();
  `;
  const child = spawn(process.execPath, options.rotateInsideRetry ? ['--eval', retryRotationBootstrap] : [PROXY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const response = async id => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const row = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(value => value.id === id);
      if (row) return row;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`No MCP response for ${id}: ${stderr}`);
  };
  const call = (id, name, args = {}) => {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return response(id);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'recovery-regression', version: '1' } } });
    await response(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await exercise({ record, call });
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('first ambient read after upgrade refusal uses the recovered bound tab', async () => {
  await withRecoveryProxy({ recoveredStaleAnchor: true, staleTabId: 'tab-before-restart' }, async ({ record, call }) => {
    assert.notEqual((await call(2, 'anti.inspect.dom')).result?.isError, true);
    assert.notEqual((await call(3, 'anti.inspect.dom')).result?.isError, true, 'subsequent ambient call must keep working after recovery');
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch' && value.params.name === 'browser.dom');
    assert.equal(calls.length, 2, 'recovered ambient read plus the subsequent ambient read');
    for (const dispatch of calls) {
      assert.equal(dispatch.params.params.tabId, BOUND_TAB);
      assert.equal(dispatch.params.attachmentId, BOUND_ATTACHMENT);
    }
  });
});

test('transmitted ambient read retargets after recovery with a fresh identity', async () => {
  await withRecoveryProxy({ closeAfterFirstDispatch: true, recoveredStaleAnchor: true, staleTabId: 'tab-before-restart' }, async ({ record, call }) => {
    assert.notEqual((await call(2, 'anti.inspect.dom')).result?.isError, true);
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch' && value.params.name === 'browser.dom');
    assert.equal(calls.length, 3, 'old transmitted read, frozen recovered read, then measured retarget');
    assert.equal(calls[1].params.params.tabId, 'tab-before-restart');
    assert.equal(calls[1].params.idempotencyKey, calls[0].params.idempotencyKey);
    assert.equal(calls[2].params.params.tabId, BOUND_TAB);
    assert.notEqual(calls[2].params.idempotencyKey, calls[1].params.idempotencyKey, 'changed target must not reuse the frozen parameter identity');
  });
});

test('caller explicit target stays unchanged even when recovered bridge refuses it', async () => {
  await withRecoveryProxy({ recoveredStaleAnchor: true, staleTabId: 'tab-explicit' }, async ({ record, call }) => {
    const response = await call(2, 'anti.inspect.dom', { tabId: 'tab-explicit' });
    assert.equal(response.result?.isError, true);
    assert.match(JSON.stringify(response), /TARGET_MISMATCH/);
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch' && value.params.name === 'browser.dom');
    assert.equal(calls.length, 1, 'explicit refusal must not cause an ambient retarget');
    assert.equal(calls[0].params.params.tabId, 'tab-explicit');
  });
});

test('transmitted mutation refuses replay under a new attachment', async () => {
  await withRecoveryProxy({ closeAfterFirstDispatch: true, recoveredStaleAnchor: true }, async ({ record, call }) => {
    const response = await call(2, 'anti.browser.navigate', { url: 'https://example.test/recovery' });
    assert.equal(response.result?.isError, true);
    assert.match(JSON.stringify(response), /EXECUTION_UNCERTAIN/);
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch' && value.params.name !== 'browser.list-tabs');
    assert.equal(calls.length, 1, 'a possibly executed mutation gets zero replay frames');
    assert.equal(calls[0].params.attachmentId, 'att-before-restart');
    assert.equal(record.filter(value => value.method === 'antifan.cli.startSession').length, 1, 'refusal follows successful recovery, not a failed heal');
  });
});

test('concurrent failed reads share one pairing recovery and both finish', async () => {
  await withRecoveryProxy({ closeAfterFirstDispatch: true, closeAfterDispatchCount: 2, recoveredStaleAnchor: true }, async ({ record, call }) => {
    const responses = await Promise.all([call(2, 'anti.browser.tabs.list'), call(3, 'anti.browser.tabs.list')]);
    for (const response of responses) assert.notEqual(response.result?.isError, true);
    assert.equal(record.filter(value => value.method === 'pairing.challenge').length, 1);
    assert.equal(record.filter(value => value.method === 'pairing.exchange').length, 1);
    assert.equal(record.filter(value => value.method === 'antifan.cli.startSession').length, 1);
    const recovered = record.filter(value => value.method === 'antifan.capability.dispatch' && value.params.name === 'anti.browser.tabs.list' && value.params.attachmentId === BOUND_ATTACHMENT);
    assert.equal(recovered.length, 2, 'each concurrent caller keeps its own recovered outcome');
    assert.notEqual(recovered[0].params.idempotencyKey, recovered[1].params.idempotencyKey);
  });
});

test('same attachment mutation retry joins its original execution with frozen params and identity', async () => {
  await withRecoveryProxy({ closeAfterFirstDispatch: true, reuseAttachment: true }, async ({ record, call }) => {
    const response = await call(2, 'anti.browser.navigate', { url: 'https://example.test/same-attachment' });
    assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.attachmentId, calls[0].params.attachmentId);
    assert.equal(calls[1].params.idempotencyKey, calls[0].params.idempotencyKey);
    assert.deepEqual(calls[1].params.params, calls[0].params.params);
    assert.equal(record.filter(value => value.method === 'fixture.mutationExecuted').length, 1, 'same-attachment ledger join must not execute again');
    assert.equal(record.filter(value => value.method === 'pairing.exchange').length, 0);
  });
});

test('mutation authority rotation inside retry socket establishment refuses a second frame', async () => {
  await withRecoveryProxy({ closeAfterFirstDispatch: true, reuseAttachment: true, rotateInsideRetry: true, recoveredStaleAnchor: true }, async ({ record, call }) => {
    const response = await call(2, 'anti.browser.navigate', { url: 'https://example.test/inner-rotation' });
    assert.equal(response.result?.isError, true);
    assert.match(JSON.stringify(response), /EXECUTION_UNCERTAIN/);
    const reused = record.findIndex(value => value.method === 'fixture.attachmentReuseSucceeded');
    const invalidated = record.findIndex(value => value.method === 'fixture.retrySocketInvalidated');
    const refused = record.findIndex(value => value.method === 'fixture.attachmentReuseRefused');
    const paired = record.findIndex(value => value.method === 'pairing.exchange');
    assert.ok(reused >= 0 && invalidated > reused, 'outer heal must reuse the attachment before retry socket invalidation');
    assert.ok(refused > invalidated && paired > refused, 'inner heal must refuse old authority before pairing a replacement');
    assert.equal(record.filter(value => value.method === 'pairing.exchange').length, 1, 'retry connection then heals to a different attachment');
    assert.equal(record.filter(value => value.method === 'antifan.cli.startSession').length, 1);
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch');
    assert.equal(calls.length, 1, 'authority must be checked again after ensureDispatchSocket before another mutation frame');
    assert.equal(calls[0].params.attachmentId, 'att-before-restart');
    assert.equal(record.filter(value => value.method === 'fixture.mutationExecuted').length, 1);
  });
});

test('transmitted mutation refused REVISION_STALE resends on same-attachment reuse, not uncertain', async () => {
  await withRecoveryProxy({ closeAfterFirstDispatch: true, closeAfterDispatchCount: 99, reuseAttachment: true, refuseOnceWith: 'REVISION_STALE' }, async ({ record, call }) => {
    const response = await call(2, 'anti.browser.navigate', { url: 'https://example.test/revision-stale' });
    assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    assert.doesNotMatch(JSON.stringify(response), /EXECUTION_UNCERTAIN/);
    const calls = record.filter(value => value.method === 'antifan.capability.dispatch');
    assert.equal(calls.length, 2, 'refusal then one same-attachment resend');
    assert.equal(calls[1].params.attachmentId, calls[0].params.attachmentId);
    assert.equal(calls[1].params.idempotencyKey, calls[0].params.idempotencyKey);
    assert.deepEqual(calls[1].params.params, calls[0].params.params, 'resend stays byte-frozen for ledger join');
    assert.equal(record.filter(value => value.method === 'fixture.mutationExecuted').length, 1, 'first frame was refused before execution; join executes exactly once');
    assert.ok(record.some(value => value.method === 'fixture.attachmentReuseSucceeded'), 'autoheal must reuse the same attachment');
    assert.equal(record.filter(value => value.method === 'pairing.exchange').length, 0);
  });
});
