/**
 * Reusable AntiFan control-plane RPC client (module).
 *
 * Mirrors the OMP MCP shim transport (`antifan.capability.dispatch` over the
 * bridge WebSocket) with three deltas:
 *   - tracks the rotating authority revision across process boundaries and
 *     self-heals on REVISION_STALE using the revision the bridge reports, and
 *   - imposes no fixed 30s client timeout, so canonical long-running
 *     capabilities (visual compare + settle barrier, full-page captures)
 *     can complete, and
 *   - is at-most-once: one requestId/idempotencyKey per logical call (reused
 *     only across the REVISION_STALE self-heal), no retry or reconnect after a
 *     client-budget TIMEOUT or a server EXECUTION_TIMEOUT, and
 *     EXECUTION_TIMEOUT_PENDING_CLEANUP is surfaced as a typed nonterminal error
 *     (`err.pendingCleanup`) that is joinable only by re-issuing with the same
 *     `options.idempotencyKey`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const SESSION_FILE = path.resolve(process.env.ANTIFAN_MCP_BOOTSTRAP_FILE || '.canary/state/canary-session.json');

/**
 * The canary session file is authoritative. A dev shell exports an ambient
 * ANTIFAN_MCP_BOOTSTRAP for the user's own instance (bridge 20130); silently
 * preferring it binds canary tooling to user-instance tabs and contaminates
 * evidence. Set ANTIFAN_MCP_BOOTSTRAP_FILE to target a different instance; the
 * env JSON is only a fallback when no file exists.
 */
function resolveBootstrap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (parsed && parsed.port && parsed.secret) return parsed;
  } catch {}
  try {
    const fromEnv = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP || '{}');
    if (fromEnv && fromEnv.port && fromEnv.secret) return fromEnv;
  } catch {}
  throw new Error(`no canary bootstrap: mint ${SESSION_FILE} with .canary/tools/canary-session.mjs (or set ANTIFAN_MCP_BOOTSTRAP_FILE)`);
}

const boot = resolveBootstrap();

export const bootstrap = boot;
export const bootstrapFile = SESSION_FILE;

/**
 * Re-read the session file after a re-mint.
 *
 * A session's attachment is bound to the tab it was minted with, and the binding
 * dies when that tab closes, so a long-lived runner renews by minting again
 * (measured: the mint itself still succeeds with a dead binding, and the next
 * create then adopts normally). The minted identity is module state, so the
 * runner has to reload it here; callers keep the same object identity, which is
 * what the tab-creation path and the state file validation both read.
 */
export function reloadBootstrap() {
  const fresh = resolveBootstrap();
  for (const key of Object.keys(boot)) delete boot[key];
  Object.assign(boot, fresh);
  currentRevision = loadRevision();
  return boot;
}

const STATE_DIR = path.resolve('.canary/state');
const STATE_FILE = path.join(STATE_DIR, 'authority-revision.json');

function loadRevision() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Only trust a persisted revision minted for THIS attachment. The state file
    // outlives the process that wrote it, and a revision belonging to a different
    // attachment is rejected as AUTHENTICATION_DENIED by the bridge.
    if (
      j.attachmentId === boot.attachmentId &&
      typeof j.revision === 'string' &&
      j.revision.startsWith('rev_')
    ) return j.revision;
  } catch {}
  return boot.authorityRevision;
}

let currentRevision = loadRevision();

function persistRevision(rev) {
  if (typeof rev !== 'string' || !rev.startsWith('rev_')) return;
  currentRevision = rev;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ attachmentId: boot.attachmentId, revision: rev, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

function openSocket() {
  return new WebSocket(`ws://127.0.0.1:${boot.port}`, {
    headers: {
      Authorization: `Bearer ${boot.secret}`,
      'x-antifan-attachment-secret': boot.secret,
    },
  });
}

function waitOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function rpcError(code, message, extra) {
  const err = new Error(typeof message === 'string' && message.length > 0 ? message : code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * One invocation identity per logical call. `idempotencyKey` is the ledger join
 * key; it is minted once and reused across the REVISION_STALE self-heal so the
 * retry joins the original invocation instead of minting a new one.
 * Pass `options.idempotencyKey` (from a prior pending-cleanup result) to join
 * that invocation — it is the only identity the ledger accepts for the join.
 */
function resolveIdentity(options) {
  const o = options && typeof options === 'object' ? options : {};
  const explicitKey = typeof o.idempotencyKey === 'string' && o.idempotencyKey.trim() ? o.idempotencyKey.trim() : null;
  const explicitRequest = typeof o.requestId === 'string' && o.requestId.trim() ? o.requestId.trim() : null;
  const nonce = crypto.randomUUID();
  return {
    requestId: explicitRequest || `req-canary-${nonce}`,
    idempotencyKey: explicitKey || `idem-canary-${nonce}`,
  };
}

/** Nonterminal surface for EXECUTION_TIMEOUT_PENDING_CLEANUP (no receipt yet). */
function buildPendingCleanup(payload, identity) {
  const details = payload && typeof payload.details === 'object' && payload.details !== null ? payload.details : {};
  const invocationId = typeof details.invocationId === 'string'
    ? details.invocationId
    : (typeof payload.invocationId === 'string' ? payload.invocationId : null);
  return {
    _type: 'PENDING_CLEANUP',
    code: 'EXECUTION_TIMEOUT_PENDING_CLEANUP',
    message: typeof payload.message === 'string' && payload.message
      ? payload.message
      : 'Capability execution timed out with owned-resource cleanup still pending. No terminal receipt exists yet.',
    invocationId,
    cleanupPending: true,
    terminal: false,
    joinableBy: 'idempotencyKey',
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey,
  };
}

function dispatchOnce(ws, capability, params, revision, timeoutMs, identity) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      ws.off('message', onMessage);
      clearTimeout(timer);
      fn();
    };
    const onMessage = (raw) => {
      let resp;
      try { resp = JSON.parse(raw.toString()); } catch { return; }
      if (!resp || resp.id !== id) return;
      finish(() => {
        const envelope = resp.data && typeof resp.data === 'object' ? resp.data : {};
        persistRevision(envelope.authorityRevision || envelope.replacementAuthorityRevision);
        const payload = envelope.data !== undefined ? envelope.data : resp.data;
        if (resp.success) {
          if (payload && typeof payload === 'object') {
            persistRevision(payload.authorityRevision || payload.replacementAuthorityRevision);
          }
          resolve(payload);
          return;
        }
        const code = typeof envelope.code === 'string' && envelope.code
          ? envelope.code
          : (typeof resp.error === 'string' && resp.error.includes(':')
            ? resp.error.slice(0, resp.error.indexOf(':'))
            : 'CAPABILITY_ERROR');
        if (code === 'EXECUTION_TIMEOUT_PENDING_CLEANUP') {
          // Nonterminal: owned resources are still being cleaned up and no
          // receipt exists. Join only by re-issuing with the same idempotencyKey.
          const pending = buildPendingCleanup(envelope, identity);
          process.stderr.write(`[canary-rpc] pending cleanup: ${JSON.stringify(pending)}\n`);
          reject(rpcError(
            code,
            `${code}: ${pending.message} (invocationId=${pending.invocationId ?? 'unknown'}; idempotencyKey=${identity.idempotencyKey}; cleanupPending=true; terminal=false)`,
            { pendingCleanup: pending, invocationId: pending.invocationId, idempotencyKey: identity.idempotencyKey, nonterminal: true, cleanupPending: true },
          ));
          return;
        }
        const errText = typeof resp.error === 'string' && resp.error
          ? resp.error
          : JSON.stringify(envelope.code ? envelope : { code: 'CAPABILITY_ERROR' });
        reject(rpcError(code, errText, { details: envelope.details }));
      });
    };
    // Client budget exhaustion is an operation outcome: never reconnect and
    // never replay. A late response for this id is ignored by the settled guard
    // and cannot disturb concurrent calls.
    timer = setTimeout(() => {
      finish(() => reject(rpcError('TIMEOUT', `RPC timeout ${timeoutMs}ms: ${capability}`)));
    }, timeoutMs);
    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'antifan.capability.dispatch',
      params: {
        name: capability,
        params,
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        attachmentId: boot.attachmentId,
        attachmentSecret: boot.secret,
        authorityRevision: revision,
        attachmentClaims: {
          attachmentSecret: boot.secret,
          attachmentId: boot.attachmentId,
          authorityRevision: revision,
          runId: boot.runId,
          attemptId: boot.attemptId,
          projectId: boot.projectId,
          workspaceId: boot.workspaceId,
          ownerPid: boot.ownerPid,
        },
      },
    }));
  });
}

/**
 * Dispatch one capability. `options.idempotencyKey` joins a specific in-flight or
 * pending-cleanup invocation; omit it to mint a fresh identity.
 */
export async function call(capability, params = {}, timeoutMs = 240000, options = {}) {
  // Identity is minted once per logical call and reused only across the
  // REVISION_STALE self-heal: operation timeouts are terminal/nonterminal
  // outcomes and are never retried or replayed.
  const identity = resolveIdentity(options);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ws = openSocket();
    try {
      await waitOpen(ws, 15000);
      return await dispatchOnce(ws, capability, params, currentRevision, timeoutMs, identity);
    } catch (err) {
      const msg = String(err && err.message || err);
      const m = msg.match(/REVISION_STALE[^]*?expected\s+(rev_[0-9a-f]+)/i);
      if (m && attempt < 3) {
        persistRevision(m[1]);
        continue;
      }
      throw err;
    } finally {
      try { ws.close(); } catch {}
    }
  }
  throw new Error(`call exhausted: ${capability}`);
}

export const evalOn = (tabId, expression, timeoutMs = 120000) =>
  call('anti.browser.evaluate', { tabId, expression }, timeoutMs);

/**
 * Is this tab still addressable? A host restart, a closed target or a dropped tab
 * leaves the id dangling, and every later capability call on it fails with an
 * unknown-tab error. Callers that reuse a long-lived tab check first so they can
 * replace it deliberately instead of failing mid-operation.
 */
export async function probeTabHealth(tabId, timeoutMs = 20000) {
  if (!tabId) return false;
  try {
    const r = await evalOn(tabId, '1', timeoutMs);
    return r === 1 || r === '1';
  } catch {
    return false;
  }
}

/**
 * Invoke a non-capability bridge method over the same attachment-authenticated
 * socket (`antifan.cli.renewSession`, `antifan.cli.heartbeat`, ...). These are
 * the only methods an attachment connection may call besides dispatch, and they
 * are how a harness keeps its own lease alive: the pairing-exchange lease is the
 * ambient 30s runtime lease, far too short to drive a canary run.
 */
export async function rpcCall(method, params = {}, timeoutMs = 30000) {
  const ws = openSocket();
  const id = crypto.randomUUID();
  try {
    await waitOpen(ws, 15000);
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => finish(() => reject(new Error(`RPC timeout ${timeoutMs}ms: ${method}`))), timeoutMs);
      ws.on('message', (raw) => {
        let resp;
        try { resp = JSON.parse(raw.toString()); } catch { return; }
        if (!resp || resp.id !== id) return;
        finish(() => {
          const envelope = resp.data && typeof resp.data === 'object' ? resp.data : {};
          if (resp.success) resolve(envelope.data !== undefined ? envelope.data : resp.data);
          else reject(new Error(typeof resp.error === 'string' ? resp.error : JSON.stringify(envelope).slice(0, 300)));
        });
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  } finally {
    try { ws.close(); } catch {}
  }
}
