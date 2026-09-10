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
import { findPortOwnerPid, readProcessIdentity, FORMAT_UNAVAILABLE } from '../../scripts/lib/process-identity.mjs';

const port = Number(process.argv[2] || process.env.ANTIFAN_BRIDGE_PORT || 20131);
const outFile = path.resolve(process.argv[3] || '.canary/state/canary-session.json');
const instanceRecordPath = path.resolve(process.env.ANTIFAN_INSTANCE_RECORD || '.canary/state/canary-instance.json');

/**
 * The mint refuses to invent an instance identity. A session may only be minted
 * against an instance whose launcher published a record, and that record must
 * still describe the process actually holding this bridge port.
 *
 * A bare pid is not enough: pids are recycled, so liveness is `pid exists AND
 * the OS-reported start token equals the recorded one`. Port ownership is
 * checked as corroboration, never as proof.
 */
async function validateInstanceRecord() {
  const raw = fs.existsSync(instanceRecordPath) ? fs.readFileSync(instanceRecordPath, 'utf8') : null;
  if (!raw) return { ok: false, code: 'INSTANCE_RECORD_MISSING', path: instanceRecordPath };
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: 'INSTANCE_RECORD_UNREADABLE', path: instanceRecordPath, error: String(err.message) };
  }
  if (record.port !== null && record.port !== undefined && Number(record.port) !== port) {
    return { ok: false, code: 'INSTANCE_RECORD_PORT_MISMATCH', path: instanceRecordPath, record, expectedPort: port };
  }
  const observed = await readProcessIdentity(record.instancePid);
  if (!observed.alive) {
    return { ok: false, code: 'INSTANCE_RECORD_STALE', path: instanceRecordPath, reason: 'INSTANCE_PID_ABSENT', record, observed };
  }
  if (!record.processStartToken || observed.startTokenFormat === FORMAT_UNAVAILABLE || !observed.startToken) {
    return { ok: false, code: 'INSTANCE_RECORD_STALE', path: instanceRecordPath, reason: 'START_TOKEN_UNVERIFIABLE', record, observed };
  }
  if (observed.startToken !== record.processStartToken) {
    return { ok: false, code: 'INSTANCE_RECORD_STALE', path: instanceRecordPath, reason: 'INSTANCE_PID_REUSED', record, observed };
  }
  const ownerPid = await findPortOwnerPid(port);
  if (ownerPid === null) {
    // No observable owner means the recorded pid cannot be shown to hold the
    // port: refuse rather than mint a session against an unverified instance.
    return { ok: false, code: 'INSTANCE_RECORD_STALE', path: instanceRecordPath, reason: 'PORT_OWNER_UNVERIFIABLE', record, observed, expectedPort: port };
  }
  if (ownerPid !== record.instancePid) {
    return { ok: false, code: 'INSTANCE_RECORD_STALE', path: instanceRecordPath, reason: 'PORT_OWNED_BY_OTHER_PID', record, ownerPid };
  }
  return { ok: true, record, observed, portOwnerPid: ownerPid };
}

const instanceCheck = await validateInstanceRecord();
if (!instanceCheck.ok) {
  console.error(`[canary-session] refusing to mint: ${instanceCheck.code} ${instanceCheck.reason || ''} (${instanceCheck.path})`);
  console.error(`[canary-session] detail: ${JSON.stringify(instanceCheck).slice(0, 600)}`);
  process.exit(4);
}

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

/**
 * A live port is not a live bridge.
 *
 * The launcher's readiness probe accepts the TCP connection, and the socket keeps
 * accepting while the server stops answering, so a mint can reach a bridge that resets
 * the request: measured twice on this instance as `Error: read ECONNRESET` (errno -4077,
 * syscall read) at the challenge step, each time with a valid instance record and the
 * port owned by the recorded pid — once nine seconds after a fresh start, once after a
 * long run without any restart. Reading the pairing route until the bridge answers with
 * an HTTP response is an idempotent readiness check; the mint itself is still attempted
 * once and never retried.
 */
async function waitForBridgeHttp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = 'no attempt made';
  for (;;) {
    attempts++;
    try {
      const probe = await request('GET', '/api/pairing/challenge');
      if (probe.status >= 200 && probe.status < 500) return { ok: true, attempts, status: probe.status };
      lastError = `HTTP ${probe.status}`;
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
    if (Date.now() >= deadline) return { ok: false, attempts, error: lastError };
    await new Promise((r) => setTimeout(r, 500));
  }
}

const bridge = await waitForBridgeHttp();
if (!bridge.ok) {
  console.error(`bridge not answering HTTP after 30s (${bridge.attempts} attempts): ${bridge.error}`);
  process.exit(1);
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
  // Instance identity, echoed into every verdict downstream: the session is only
  // as trustworthy as the record it was minted against.
  instancePid: instanceCheck.record.instancePid,
  instanceStartedAt: instanceCheck.record.startedAt ?? null,
  instanceProcessStartToken: instanceCheck.record.processStartToken,
  instanceProcessStartTokenFormat: instanceCheck.record.processStartTokenFormat ?? null,
  instancePortOwnerPid: instanceCheck.portOwnerPid ?? null,
  bridgePort: port,
  mintedAt: new Date().toISOString(),
  leaseUntil: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
};
const { writeRecordAtomic } = await import('../../scripts/lib/atomic-record.mjs');
writeRecordAtomic(outFile, bootstrap);
console.log(`ANTIFAN_MCP_BOOTSTRAP=${JSON.stringify(bootstrap)}`);
console.error(
  `[canary-session] port=${bootstrap.port} attachment=${bootstrap.attachmentId} primaryTab=${bootstrap.tabId} ` +
  `instancePid=${bootstrap.instancePid} leaseUntil=${bootstrap.leaseUntil ?? 'unknown'} -> ${outFile}`
);
