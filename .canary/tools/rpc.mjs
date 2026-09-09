/**
 * Direct AntiFan control-plane RPC client.
 *
 * Uses the exact dispatch envelope the OMP MCP shim uses
 * (`antifan.capability.dispatch` over the bridge WebSocket) but without the
 * shim's fixed 30s client timeout, so long-running canonical capabilities
 * (visual compare with settle barrier, full-page captures) can complete.
 *
 * Usage:
 *   node .canary/tools/rpc.mjs <capability> [paramsJson|-] [--timeout ms] [--out file]
 * Params JSON may be passed inline, via `-` (stdin), or omitted for {}.
 * Prints the capability result JSON to stdout (or writes it to --out).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const argv = process.argv.slice(2);
const capability = argv[0];
if (!capability) {
  console.error('usage: rpc.mjs <capability> [paramsJson|-] [--timeout ms] [--out file]');
  process.exit(2);
}
let paramsArg = null;
let timeoutMs = 240000;
let outFile = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--timeout') { timeoutMs = Number(argv[++i]); continue; }
  if (a === '--out') { outFile = argv[++i]; continue; }
  if (paramsArg === null) { paramsArg = a; continue; }
}
let params = {};
if (paramsArg && paramsArg !== '-') {
  params = JSON.parse(paramsArg);
} else if (paramsArg === '-') {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) params = JSON.parse(raw);
}

// lib-rpc resolves the canary session file first (ambient ANTIFAN_MCP_BOOTSTRAP
// points at the user's instance); ANTIFAN_MCP_BOOTSTRAP_FILE targets another.
let boot;
try {
  ({ bootstrap: boot } = await import('./lib-rpc.mjs'));
} catch (err) {
  console.error(String(err?.message || err));
  process.exit(3);
}

const ws = new WebSocket(`ws://127.0.0.1:${boot.port}`, {
  headers: {
    Authorization: `Bearer ${boot.secret}`,
    'x-antifan-attachment-secret': boot.secret,
  },
});

const id = crypto.randomUUID();
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`RPC timeout after ${timeoutMs}ms for ${capability}`)), timeoutMs);
  ws.once('open', () => {
    ws.send(JSON.stringify({
      id,
      method: 'antifan.capability.dispatch',
      params: {
        name: capability,
        params,
        requestId: `req-canary-${id}`,
        idempotencyKey: `idem-canary-${id}`,
        attachmentId: boot.attachmentId,
        attachmentSecret: boot.secret,
        authorityRevision: boot.authorityRevision,
        attachmentClaims: {
          attachmentSecret: boot.secret,
          attachmentId: boot.attachmentId,
          authorityRevision: boot.authorityRevision,
          runId: boot.runId,
          attemptId: boot.attemptId,
          projectId: boot.projectId,
          workspaceId: boot.workspaceId,
          ownerPid: boot.ownerPid,
        },
      },
    }));
  });
  ws.on('message', (raw) => {
    let resp;
    try { resp = JSON.parse(raw.toString()); } catch { return; }
    if (!resp || resp.id !== id) return;
    clearTimeout(timer);
    if (resp.success) {
      const data = resp.data && typeof resp.data === 'object' && resp.data.data !== undefined ? resp.data.data : resp.data;
      resolve(data);
    } else {
      reject(new Error(typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error || { code: 'CAPABILITY_ERROR' })));
    }
  });
  ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  ws.once('close', (code, reason) => { clearTimeout(timer); reject(new Error(`ws closed ${code} ${reason}`)); });
});

ws.close();
const text = JSON.stringify(result, null, 2);
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log(JSON.stringify({ ok: true, out: outFile, bytes: text.length }));
} else {
  console.log(text);
}
process.exit(0);
