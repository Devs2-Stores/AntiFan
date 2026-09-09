/**
 * Mint a durable canary session against a live AntiFan bridge over loopback.
 *
 *   node .canary/tools/canary-session.mjs [port] [outFile]
 *
 * Two-step, both canonical production paths:
 *   1. `/api/pairing/challenge` + `/api/pairing/exchange` -> short-lived unbound
 *      attachment (the pairing lease is the ambient ~30s runtime lease).
 *   2. `antifan.cli.startSession` on that attachment -> a CLI session with a real
 *      run/attempt, a 2h lease, and an offscreen ephemeral primary tab.
 *
 * The session's primary tab is the pool anchor: every tab opened afterwards with
 * this session's secret (`anti.browser.tabs.create`) is adopted into the pool, so
 * the harness can drive a reference tab and a clone tab from one authority
 * without tripping the bridge's bound-tab guard (bridge-server.ts:1235).
 *
 * Prints `ANTIFAN_MCP_BOOTSTRAP=<json>` and persists the same JSON to <outFile>
 * (default .canary/state/canary-session.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const port = Number(process.argv[2] || process.env.ANTIFAN_BRIDGE_PORT || 20131);
const outFile = path.resolve(process.argv[3] || '.canary/state/canary-session.json');

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('PAIRING_REQUEST_TIMEOUT')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** One raw lifecycle RPC over an attachment-authenticated socket. */
function lifecycle(method, secret, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${secret}`, 'x-antifan-attachment-secret': secret },
    });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`${method} timeout`)); }, 30000);
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('message', (raw) => {
      let resp;
      try { resp = JSON.parse(raw.toString()); } catch { return; }
      if (!resp || resp.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (resp.success) resolve(resp.data?.data !== undefined ? resp.data.data : resp.data);
      else reject(new Error(typeof resp.error === 'string' ? resp.error : JSON.stringify(resp).slice(0, 400)));
    });
    ws.once('open', () => ws.send(JSON.stringify({ id, method, params })));
  });
}

const challenge = await request('POST', '/api/pairing/challenge');
if (challenge.status !== 200 || !challenge.json?.code) {
  console.error(`challenge failed: status=${challenge.status} body=${challenge.text.slice(0, 300)}`);
  process.exit(1);
}

const exchange = await request('POST', '/api/pairing/exchange', {
  code: challenge.json.code,
  clientClass: 'mcp',
  requestedGrant: 'eval',
});
if (exchange.status !== 200 || !exchange.json?.success) {
  console.error(`exchange failed: status=${exchange.status} body=${exchange.text.slice(0, 300)}`);
  process.exit(1);
}
const pairing = exchange.json;

const session = await lifecycle('antifan.cli.startSession', pairing.secret, {
  attachmentId: pairing.attachmentId,
  projectId: pairing.projectId,
  workspaceId: pairing.workspaceId,
  backendId: 'cli',
  grant: 'eval',
  ttlMs: 7_200_000,
  cwd: process.cwd(),
});

const bootstrap = {
  port: session.port ?? port,
  secret: session.secret,
  attachmentId: session.attachmentId,
  authorityRevision: session.authorityRevision,
  runId: session.runId,
  attemptId: session.attemptId,
  projectId: session.projectId,
  workspaceId: session.workspaceId,
  tabId: session.tabId,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(bootstrap, null, 2));
console.log(`ANTIFAN_MCP_BOOTSTRAP=${JSON.stringify(bootstrap)}`);
console.error(
  `[canary-session] port=${bootstrap.port} attachment=${bootstrap.attachmentId} primaryTab=${bootstrap.tabId} ` +
  `leaseUntil=${new Date(session.expiresAt ?? 0).toISOString()} -> ${outFile}`
);
