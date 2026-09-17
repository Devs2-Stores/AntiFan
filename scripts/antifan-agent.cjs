#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Per-Agent CLI Launcher
 * Authenticates with local AntiFan Bridge, acquires an ephemeral MCP attachment session,
 * injects credentials into the target AI CLI (omp, claude, codex, etc.),
 * and cleanly revokes attachment tokens upon process exit.
 */

const spawn = require('cross-spawn');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { WebSocket } = require('ws');

function printUsage() {
  console.log(`
AntiFan Agent Launcher (v1.0.0)
Usage:
  antifan [--tab=<tabId>] <command> [args...]
  antifan-agent [--tab=<tabId>] <command> [args...]

Options:
  --tab=<tabId>, -t <tabId>   Explicitly bind to a Chromium tab ID

Examples:
  antifan mcp
  antifan omp
  antifan claude
  antifan codex
  antifan npm test
Description:
  Wraps any AI coding agent or CLI, granting it zero-trust, temporary access
  to control the live AntiFan Desktop Chromium instance.
`);
}

function resolveBridgeCandidates() {
  const candidates = [];
  const seenTargets = new Set();

  // 1. Explicit instance pin: the owning instance stamps its own endpoint into
  // every terminal it spawns (see TerminalManager.setBridgeEndpoint). It outranks
  // every discovery file for as long as the pinned process is not provably dead.
  if (process.env.ANTIFAN_BRIDGE_PORT) {
    const port = parseInt(process.env.ANTIFAN_BRIDGE_PORT, 10);
    const host = process.env.ANTIFAN_BRIDGE_HOST || '127.0.0.1';
    const token = process.env.ANTIFAN_BRIDGE_TOKEN || '';
    const rawPinnedPid = parseInt(process.env.ANTIFAN_BRIDGE_PID || '', 10);
    const pinnedPid = Number.isInteger(rawPinnedPid) && rawPinnedPid > 0 ? rawPinnedPid : null;
    if (!Number.isNaN(port) && port > 0) {
      const targetKey = `${host}:${port}:${token}`;
      seenTargets.add(targetKey);
      candidates.push({
        source: 'env',
        file: null,
        port,
        host,
        token,
        pid: pinnedPid,
        // A pin without a pid is the owning instance speaking for itself; an
        // out-of-range pid proves nothing, so it stays "unknown" rather than live.
        pidAlive: pinnedPid !== null ? isPidAlive(pinnedPid) : (process.env.ANTIFAN_BRIDGE_PID ? null : true),
        pinned: true,
        provenance: 'env',
        startedAt: 0,
        isDev: false,
      });
    }
  }

  // 2. Discover configuration directories across Drive E and standard locations
  const candidateDirs = [
    process.env.ANTIFAN_CONFIG_DIR,
    process.env.ANTIFAN_DATA_ROOT ? path.join(process.env.ANTIFAN_DATA_ROOT, 'config') : null,
    path.join('E:', 'Work', '.antifan-data', 'config'),
    path.join('E:\\', 'Work', '.antifan-data', 'config'),
    path.join('E:', '.antifan-data', 'config'),
    path.join('D:', 'Work', '.antifan-data', 'config'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'AntiFan', 'data', 'config') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'antifan-browser-desktop', 'data', 'config') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'antifan-data', 'config') : null,
    path.join(os.homedir(), '.antifan'),
    path.join(os.homedir(), '.gemini'),
  ].filter(Boolean);

  const fileNames = ['bridge-dev.json', 'bridge.json', 'antifan_bridge_dev.json', 'antifan_bridge.json'];
  const seenFiles = new Set();

  for (const dir of candidateDirs) {
    for (const name of fileNames) {
      const filePath = path.resolve(dir, name);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);

      if (fs.existsSync(filePath)) {
        try {
          const stat = fs.statSync(filePath);
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.port === 'number' && parsed.port > 0) {
            const host = parsed.host || '127.0.0.1';
            const port = parsed.port;
            const token = parsed.token || '';
            const targetKey = `${host}:${port}:${token}`;
            if (seenTargets.has(targetKey)) continue;
            seenTargets.add(targetKey);

            candidates.push({
              source: 'file',
              file: filePath,
              port,
              host,
              token,
              pid: parsed.pid,
              pidAlive: isPidAlive(parsed.pid),
              pinned: false,
              provenance: isHomeMirrorDir(dir) ? 'legacy-mirror' : 'instance-file',
              startedAt: parsed.startedAt || stat.mtimeMs || 0,
              isDev: Boolean(parsed.isDev),
            });
          }
        } catch {}
      }
    }
  }

  candidates.sort(compareCandidates);

  return candidates;
}

function isPidAlive(pid) {
  // Only a positive integer names a single process; pid 0 and negatives address
  // process groups, so process.kill would report "alive" for a meaningless id.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM' ? true : false;
  }
}

function isHomeMirrorDir(dir) {
  if (!dir) return false;
  const resolved = path.resolve(dir);
  return resolved === path.resolve(os.homedir(), '.gemini')
    || resolved === path.resolve(os.homedir(), '.antifan');
}

function getLivenessRank(pidAlive) {
  if (pidAlive === true) return 2;
  if (pidAlive === null) return 1;
  return 0;
}

function getProvenanceRank(provenance) {
  if (provenance === 'env') return 3;
  if (provenance === 'instance-file') return 2;
  if (provenance === 'legacy-mirror') return 1;
  return 0;
}

// Candidate ordering contract (shared with the MCP proxy in antifan-omp-mcp.cjs):
//   1. An explicit instance pin outranks every file candidate while the pinned
//      instance is not provably dead.
//   2. Otherwise: live (2) > unknown (1) > dead (0) pid liveness.
//   3. Otherwise: env pin > instance-owned config file > home-directory mirror.
//   4. Otherwise: newer startedAt.
//   5. Otherwise: dev before prod.
function compareCandidates(a, b) {
  const aPinned = a.pinned === true && getLivenessRank(a.pidAlive) > 0;
  const bPinned = b.pinned === true && getLivenessRank(b.pidAlive) > 0;
  if (aPinned !== bPinned) return bPinned ? 1 : -1;

  const livenessDiff = getLivenessRank(b.pidAlive) - getLivenessRank(a.pidAlive);
  if (livenessDiff !== 0) return livenessDiff;

  const provenanceDiff = getProvenanceRank(b.provenance) - getProvenanceRank(a.provenance);
  if (provenanceDiff !== 0) return provenanceDiff;

  const startedDiff = (b.startedAt || 0) - (a.startedAt || 0);
  if (startedDiff !== 0) return startedDiff;

  return (b.isDev ? 1 : 0) - (a.isDev ? 1 : 0);
}


// ─── Pairing availability contract ───────────────────────────────────────────
// The bridge mints pairing challenges into a SMALL on-disk queue and only used to refill it when a
// consumer asked, paying a PowerShell DACL cost (~10 s on this host) inside the request. Measured
// live with five concurrent pairs: 24.4 s / 22.6 s / 4.3 s / 3.8 s / 4.0 s. The pairing socket below
// gives up at 15 s, so those clients abandoned a bridge that was alive and a second away from
// answering — and then reported it as DOWN. Two independent defences live here, and they compose:
//   1. every pairing failure is CLASSIFIED, so a policy refusal is never retried while a transient
//      stall always is, and the real reason reaches the caller instead of one fixed string; and
//   2. retries are JITTERED, so N clients that all fail at the same instant do not re-ask in
//      lockstep and rebuild the very burst that caused the failure.
const PAIRING_ATTEMPT_LIMIT = 4;
const PAIRING_ATTEMPT_TIMEOUT_MS = 8000;
const PAIRING_TOTAL_BUDGET_MS = 30000;
const PAIRING_RETRY_BASE_MS = 250;
const PAIRING_RETRY_CAP_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter: the delay is drawn from [ceiling/2, ceiling]. A fixed exponential schedule would
// merely re-synchronise the herd it exists to break up.
function pairingBackoffMs(attempt) {
  const ceiling = Math.min(PAIRING_RETRY_CAP_MS, PAIRING_RETRY_BASE_MS * Math.pow(2, attempt));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

// Refusals a retry cannot fix, because they describe the REQUEST rather than the moment: the grant
// name is wrong, the client class does not match, the code was revoked. Retrying one of these would
// hammer the bridge, still fail, and hide a real policy error behind a timeout. Everything else — a
// stalled socket, a refused connection, a depleted queue, a 5xx, or a code consumed or expired
// before we could spend it — is a transient availability fact and is retried with a FRESH challenge.
// A retry never re-presents the previous code, so the single-use guarantee is untouched: the bridge
// still refuses the old code with 409, and this process never sends it twice.
const TERMINAL_PAIRING_ERRORS = new Set([
  'PAIRING_GRANT_UNKNOWN',
  'PAIRING_GRANT_CEILING_EXCEEDED',
  'PAIRING_CLIENT_CLASS_MISMATCH',
  'PAIRING_CLIENT_ID_MISMATCH',
  'PAIRING_CODE_REVOKED',
  'INVALID_PAIRING_REQUEST',
  'INVALID_CLIENT_CLASS',
  'LAN_ACCESS_FORBIDDEN',
  'SECRETS_IN_URL_FORBIDDEN',
  'PAYLOAD_TOO_LARGE',
]);

function pairingFailureParts(err) {
  return {
    msg: err && err.message ? String(err.message) : String(err || ''),
    status: err && typeof err.status === 'number' ? err.status : null,
    errorCode: err && typeof err.errorCode === 'string' ? err.errorCode : null,
  };
}

function isTerminalPairingFailure(err) {
  const { msg, errorCode } = pairingFailureParts(err);
  if (errorCode && TERMINAL_PAIRING_ERRORS.has(errorCode)) return true;
  for (const code of TERMINAL_PAIRING_ERRORS) {
    if (msg.includes(code)) return true;
  }
  return false;
}

// 'ECONNREFUSED' means nothing is listening (bridge not running). A timeout or a depleted queue
// means the bridge IS listening and could not serve pairing in time. Those two need opposite
// responses from an operator, so they must not collapse into one string.
function classifyPairingFailure(err) {
  const { msg, status, errorCode } = pairingFailureParts(err);
  if (status === 404 || errorCode === 'CHALLENGE_QUEUE_DEPLETED' || /CHALLENGE_QUEUE_DEPLETED/i.test(msg)) {
    return 'PAIRING_QUEUE_DEPLETED';
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return 'BRIDGE_UNREACHABLE';
  if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(errorCode || '')) return 'BRIDGE_UNREACHABLE';
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'PAIRING_TIMEOUT';
  if (status !== null && status >= 500) return 'BRIDGE_ERROR';
  if (errorCode) return errorCode;
  return 'PAIRING_FAILED';
}

function describePairingFailure(err) {
  const { msg, status, errorCode } = pairingFailureParts(err);
  const label = errorCode || (status !== null ? `HTTP ${status}` : classifyPairingFailure(err));
  return `${label}: ${msg}`.trim();
}

function httpJsonPost(host, port, requestPath, payload, timeoutMs = PAIRING_ATTEMPT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload || {});
    const req = http.request({
      hostname: host,
      port: port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed.message || parsed.error || `HTTP ${res.statusCode}`;
            const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
            // Carry the typed reason, not just the prose: the classifier and the CONNECTION_FAILED
            // cause both key off these, and re-deriving them from a message string is guesswork.
            err.status = typeof res.statusCode === 'number' ? res.statusCode : null;
            err.errorCode = typeof parsed.error === 'string' ? parsed.error : null;
            reject(err);
          }
        } catch {
          reject(new Error(`Failed to parse JSON response (${res.statusCode}): ${data}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Pairing request timeout after ${timeoutMs}ms (${requestPath})`);
      err.errorCode = 'PAIRING_TIMEOUT';
      req.destroy(err);
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.write(postData);
    req.end();
  });
}

// One pairing attempt per iteration, each with its OWN freshly claimed challenge. The retry exists
// because the bridge can legitimately need a moment to refill its small challenge queue while other
// clients pair; it does not relax any check, and it never re-sends a code the bridge already saw.
async function performPairingExchange(host, port, options = {}) {
  const budgetMs = typeof options.budgetMs === 'number' ? options.budgetMs : PAIRING_TOTAL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let lastError = null;

  for (let attempt = 0; attempt < PAIRING_ATTEMPT_LIMIT; attempt++) {
    if (attempt > 0) {
      const waitMs = pairingBackoffMs(attempt - 1);
      process.stderr.write(
        `[AntiFan Pairing] attempt ${attempt + 1}/${PAIRING_ATTEMPT_LIMIT} for ${host}:${port} in ${waitMs}ms after ` +
          `${describePairingFailure(lastError)}\n`
      );
      await sleep(waitMs);
    }

    try {
      const challenge = await httpJsonPost(host, port, '/api/pairing/challenge', {});
      const code = challenge?.code;
      if (!challenge?.success || !code) {
        const err = new Error(`PAIRING_CHALLENGE_FAILED: ${challenge?.message || challenge?.error || 'No challenge code returned'}`);
        err.errorCode = 'PAIRING_CHALLENGE_FAILED';
        throw err;
      }
      const exchange = await httpJsonPost(host, port, '/api/pairing/exchange', {
        code,
        clientClass: 'mcp',
        // Declare the authority this session needs. Omitting it lets the bridge fall back to a silent
        // 'write' grant, which then refuses every eval-risk capability (anti.browser.evaluate,
        // anti.inspect.eval) with a POLICY_DENIED that never mentions the grant.
        requestedGrant: resolveSessionGrant(),
      });
      if (!exchange?.success || !exchange?.secret) {
        const err = new Error(`PAIRING_EXCHANGE_FAILED: ${exchange?.message || exchange?.error || 'No secret returned'}`);
        err.errorCode = 'PAIRING_EXCHANGE_FAILED';
        throw err;
      }
      assertGrantNotDowngraded(exchange);
      return exchange;
    } catch (err) {
      lastError = err;
      if (isTerminalPairingFailure(err)) throw err;
      if (Date.now() >= deadline) break;
    }
  }

  const fatal = new Error(
    `PAIRING_UNAVAILABLE after ${PAIRING_ATTEMPT_LIMIT} attempts against ${host}:${port}: ${describePairingFailure(lastError)}`
  );
  fatal.errorCode = classifyPairingFailure(lastError);
  fatal.cause = lastError;
  throw fatal;
}

// A silent downgrade is indistinguishable from "the tool is not permitted" once the agent is deep in
// a run, so surface it at pairing time instead.
const GRANT_RANKS = { read: 1, write: 2, execute: 3, eval: 4 };
function assertGrantNotDowngraded(exchange) {
  const requested = resolveSessionGrant();
  const granted = exchange?.grant;
  if (!(requested in GRANT_RANKS) || !(granted in GRANT_RANKS)) return;
  if (GRANT_RANKS[granted] < GRANT_RANKS[requested]) {
    process.stderr.write(
      `ANTIFAN_GRANT_DOWNGRADED: requested grant '${requested}' but the bridge granted '${granted}'; ` +
        'eval-risk capabilities will be refused with POLICY_DENIED.\n'
    );
  }
}

const isFixerSession = process.env.ANTIFAN_FIXER_SESSION === 'true' ||
  process.env.ANTIFAN_FIXER_SESSION === '1' ||
  process.argv.includes('--fixer');

// The fixer's permitted surface is policy, not a local constant: it lives beside the other B-Lite
// audits so the launcher, the pre-tool hook and the merge gate cannot drift into three lists.
// A module that does not yield the list refuses the fixer session outright — an unstated surface
// would silently widen to whatever the bridge grants, which is the failure this filter exists to stop.
let fixerToolSurface = null;
try {
  fixerToolSurface = createRequire(__filename)('../.canary/tools/fix-loop/audits.mjs').DEFAULT_PERMITTED_TOOLS;
} catch {}
if (isFixerSession && (!Array.isArray(fixerToolSurface) || fixerToolSurface.length === 0)) {
  console.error('TOOL_SURFACE_POLICY_UNLOADABLE: .canary/tools/fix-loop/audits.mjs did not yield DEFAULT_PERMITTED_TOOLS; refusing to launch a fixer session whose permitted tool surface is unstated.');
  process.exit(1);
}

function resolveSessionGrant() {
  if (process.env.ANTIFAN_SESSION_GRANT) {
    return process.env.ANTIFAN_SESSION_GRANT;
  }
  const grantArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--grant='));
  if (grantArg) {
    return grantArg.slice('--grant='.length);
  }
  return 'eval';
}

function resolveAllowedCapabilities() {
  if (isFixerSession) {
    return [...fixerToolSurface];
  }
  if (process.env.ANTIFAN_ALLOWED_CAPABILITIES || process.env.ANTIFAN_ALLOWED_CAPABILITY_NAMES) {
    const raw = process.env.ANTIFAN_ALLOWED_CAPABILITIES || process.env.ANTIFAN_ALLOWED_CAPABILITY_NAMES;
    try {
      if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch {}
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const allowArg = process.argv.find((a) => typeof a === 'string' && (a.startsWith('--allowed-capabilities=') || a.startsWith('--allow-capabilities=')));
  if (allowArg) {
    const val = allowArg.split('=')[1];
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function resolveForbiddenCapabilities() {
  if (process.env.ANTIFAN_FORBIDDEN_CAPABILITIES || process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES) {
    const raw = process.env.ANTIFAN_FORBIDDEN_CAPABILITIES || process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES;
    try {
      if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch {}
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const forbidArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--forbidden-capabilities='));
  if (forbidArg) {
    const val = forbidArg.split('=')[1];
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

async function acquireBridgeSession(candidates, boundPid, explicitTabId) {
  const errors = [];
  const rawPinnedPid = parseInt(process.env.ANTIFAN_BRIDGE_PID || '', 10);
  const pinnedPid = Number.isInteger(rawPinnedPid) && rawPinnedPid > 0 ? rawPinnedPid : null;
  let foreignFallback = null;
  for (const candidate of candidates) {
    const wsUrl = `ws://${candidate.host}:${candidate.port}`;
    let ws;
    let authSecret = candidate.token || '';
    let pairedExchange = null;
    try {
      // At most two authority attempts per candidate: the one this launcher already holds (an env
      // pin or a discovery-file token may still name a live attachment), then exactly one fresh
      // pairing if that one is refused. A rebuild rotates the host epoch and revokes EVERY
      // attachment at once, so "the token I hold is stale" is the routine case right after one —
      // treating it as a dead candidate is what turned a routine restart into "bridge offline".
      // Reuse is tried first because it spends no pairing code and grants nothing new.
      if (authSecret) {
        try {
          ws = await connectAuthenticatedSocket(wsUrl, {
            Authorization: `Bearer ${authSecret}`,
            'x-antifan-attachment-secret': authSecret,
          });
        } catch (heldErr) {
          errors.push(`${wsUrl} (held authority rejected): ${heldErr.message}`);
        }
      }
      if (!ws) {
        pairedExchange = await performPairingExchange(candidate.host, candidate.port);
        authSecret = pairedExchange.secret;
        ws = await connectAuthenticatedSocket(wsUrl, {
          'x-antifan-attachment-secret': pairedExchange.secret,
          Authorization: `Bearer ${pairedExchange.secret}`,
        });
      }

      const rawTerminalId = process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID || process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID || process.env.ANTIFAN_TERMINAL_SESSION_ID;
      const rawGen = process.env.ANTIFAN_TERMINAL_AFFINITY_GENERATION || process.env.ANTIFAN_TERMINAL_GENERATION;
      const targetGrant = resolveSessionGrant();
      const allowedCaps = resolveAllowedCapabilities();
      const forbiddenCaps = resolveForbiddenCapabilities();
      const startParams = {
        backendId: 'cli',
        grant: targetGrant,
        ownerPid: boundPid,
        ttlMs: 3600000,
        tabId: explicitTabId || undefined,
        terminalSessionId: rawTerminalId ? String(rawTerminalId).trim() : undefined,
        terminalGeneration: rawGen ? String(rawGen).trim() : undefined,
        attachmentId: pairedExchange?.attachmentId || undefined,
      };
      if (allowedCaps && allowedCaps.length > 0) {
        startParams.allowedCapabilityNames = allowedCaps;
      }
      if (forbiddenCaps && forbiddenCaps.length > 0) {
        startParams.forbiddenCapabilityNames = forbiddenCaps;
      }
      const session = await rpcCall(ws, 'antifan.cli.startSession', startParams, 5000);
      const targetTabId = session?.tabId || explicitTabId;
      if (!session || !session.attachmentId || !session.secret || !session.authorityRevision || !targetTabId) {
        const missing = [
          !session?.attachmentId && 'attachmentId',
          !session?.secret && 'secret',
          !session?.authorityRevision && 'authorityRevision',
          !targetTabId && 'tabId',
        ].filter(Boolean).join(', ');
        const err = new Error(`BOOTSTRAP_INVALID: Bridge startSession response missing mandatory fields (${missing})`);
        err.code = 'BOOTSTRAP_INVALID';
        err.missing = missing;
        throw err;
      }

      // The bridge reports which Electron instance answered. When this terminal was
      // pinned, only an answer proving that exact pid is trusted: a missing or
      // mismatched pid means an older or foreign bridge, and the pinned instance
      // still gets its chance. Never wedge while a local instance is up — the first
      // such answer is held as a last-resort fallback.
      const answeredPid = typeof session.runtimePid === 'number' && Number.isInteger(session.runtimePid) && session.runtimePid > 0
        ? session.runtimePid
        : null;
      if (pinnedPid !== null && answeredPid !== pinnedPid) {
        console.warn(`[antifan] FOREIGN_INSTANCE_ATTACH: pinned instance pid ${pinnedPid} did not answer; ${candidate.host}:${candidate.port} reports pid ${answeredPid === null ? 'unknown' : answeredPid}`);
        if (!foreignFallback) {
          foreignFallback = { ws, bridgeInfo: candidate, session };
        } else {
          try { ws.close(); } catch {}
        }
        continue;
      }
      if (foreignFallback) { try { foreignFallback.ws.close(); } catch {} foreignFallback = null; }
      if (candidates.indexOf(candidate) > 0) {
        console.warn(`[antifan] ATTACH_FAILOVER: attached to ${candidate.host}:${candidate.port} (${candidate.file || candidate.source}) after earlier candidates failed`);
      }
      return { ws, bridgeInfo: candidate, session };
    } catch (err) {
      errors.push(`${wsUrl} (${candidate.file || candidate.source || 'endpoint'}): ${err.message}`);
      try { ws?.close(); } catch {}
    }
  }
  if (foreignFallback) {
    console.warn('[antifan] FOREIGN_INSTANCE_ATTACH: falling back to a live local instance because the pinned instance never answered.');
    return foreignFallback;
  }
  throw new Error(`All candidate endpoints failed to authenticate or connect:\n  - ${errors.join('\n  - ')}`);
}

// A refused upgrade is not the same as an unreachable bridge: the bridge answers 4001 with a reason
// when it rejects the credential, and that distinction is what tells a caller apart "your authority
// was rotated" from "nothing is listening". The close reason is therefore preserved, not replaced.
function connectAuthenticatedSocket(wsUrl, headers, timeoutMs = 15000) {
  const ws = new WebSocket(wsUrl, { headers });
  return new Promise((resolve, reject) => {
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`WebSocket connection timed out after ${timeoutMs}ms (${wsUrl})`));
      }
    }, timeoutMs);

    ws.once('open', () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        resolve(ws);
      }
    });
    ws.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      }
    });
    ws.once('close', (code, reason) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error(`WebSocket closed early with code ${code}: ${reason?.toString() || 'Unauthorized'}`));
      }
    });
  });
}

function rpcCall(ws, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`RPC timeout waiting for ${method}`));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          if (msg.success) {
            resolve(msg.data);
          } else {
            reject(new Error(msg.error || `RPC ${method} failed`));
          }
        }
      } catch {}
    }

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function parseLauncherArgs(argv) {
  let explicitTabId = undefined;
  const commandArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--tab=')) {
      const val = arg.slice('--tab='.length).trim();
      if (!val) {
        throw new Error('--tab requires a non-empty tabId.');
      }
      explicitTabId = val;
    } else if (arg === '--tab' || arg === '-t') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        explicitTabId = argv[i + 1].trim();
        i++;
      } else {
        throw new Error('--tab requires a non-empty tabId.');
      }
    } else if (
      arg === '--fixer' ||
      arg.startsWith('--grant=') ||
      arg.startsWith('--allowed-capabilities=') ||
      arg.startsWith('--allow-capabilities=') ||
      arg.startsWith('--forbidden-capabilities=')
    ) {
      // Launcher flags handled by resolveSessionGrant / resolveAllowedCapabilities / resolveForbiddenCapabilities
    } else {
      commandArgs.push(arg);
    }
  }
  return { tabId: explicitTabId, commandArgs };
}
let activeCleanup = null;
// The spawned agent/MCP child is part of this session, so it dies with it. Without this the child
// outlived the launcher's own exit paths (SIGINT/SIGTERM and spawn failure): the launcher revoked
// the attachment and closed its socket, while the child kept a stdio transport and a bridge socket
// open for a session that no longer existed.
let activeChild = null;

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === '-h' || rawArgs[0] === '--help') {
    printUsage();
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseLauncherArgs(rawArgs);
  } catch (err) {
    console.error(`\x1b[31m[antifan-agent] Error: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  const explicitTabId = parsed.tabId;
  const args = parsed.commandArgs;
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }
  const candidates = resolveBridgeCandidates();
  if (candidates.length === 0) {
    console.error('MCP_BRIDGE_OFFLINE: AntiFan Browser Desktop is not running.');
    console.error('[antifan-agent] Please launch AntiFan Browser Desktop before running this agent.');
    process.exit(1);
  }

  const boundPid = process.pid;
  let bridgeAcquisition;
  try {
    bridgeAcquisition = await acquireBridgeSession(candidates, boundPid, explicitTabId);
  } catch (err) {
    console.error(`MCP_BRIDGE_OFFLINE: Failed to connect to AntiFan Bridge after bounded attempts:\n${err.message}`);
    console.error('[antifan-agent] Please verify that AntiFan Browser Desktop is running and responsive.');
    process.exit(1);
  }
  const { ws, bridgeInfo, session } = bridgeAcquisition;

  let cleanedUp = false;
  let heartbeatInterval = null;

  async function cleanup(outcome = 'completed', error = undefined) {
    if (cleanedUp) return;
    cleanedUp = true;
    activeCleanup = null;
    clearInterval(heartbeatInterval);
    try {
      if (ws.readyState === WebSocket.OPEN) {
        await rpcCall(ws, 'antifan.cli.endSession', {
          runId: session.runId,
          attemptId: session.attemptId,
          attachmentId: session.attachmentId,
          secret: session.secret,
          outcome,
          error,
        }, 3000);
      }
    } catch {}
    try { ws.close(); } catch {}
    // Terminate the wrapped child last: the session is already revoked and the socket closed, so
    // nothing this child could still do is wanted. A child that exits on its own makes this a no-op.
    if (activeChild) {
      try { activeChild.kill(); } catch {}
      activeChild = null;
    }
  }
  activeCleanup = cleanup;

  process.on('SIGINT', async () => {
    await cleanup('cancelled', 'User interrupted via SIGINT');
    process.exit(130);
  });

  process.on('SIGTERM', async () => {
    await cleanup('cancelled', 'Process terminated via SIGTERM');
    process.exit(143);
  });

  try {
    // The grant and the allowed/forbidden name sets are pure functions of env and argv, so resolving
    // them here yields what acquireBridgeSession started the session with — the child declares the
    // same surface the attachment was opened under, including the fixer's consolidated policy.
    const targetGrant = resolveSessionGrant();
    const allowedCaps = resolveAllowedCapabilities();
    const forbiddenCaps = resolveForbiddenCapabilities();
    const sanitizedParentEnv = { ...process.env };
    delete sanitizedParentEnv.ANTIFAN_BRIDGE_TOKEN;
    delete sanitizedParentEnv.ANTIFAN_BRIDGE_PORT;
    delete sanitizedParentEnv.ANTIFAN_BRIDGE_HOST;

    const childEnv = {
      ...sanitizedParentEnv,
      ANTIFAN_MCP_PORT: String(session.port || bridgeInfo.port),
      ANTIFAN_ATTACHMENT_SECRET: session.secret,
      ANTIFAN_ATTACHMENT_ID: session.attachmentId,
      ANTIFAN_AUTHORITY_REVISION: session.authorityRevision,
      ANTIFAN_RUN_ID: session.runId,
      ANTIFAN_ATTEMPT_ID: session.attemptId,
      ANTIFAN_PROJECT_ID: session.projectId,
      ANTIFAN_WORKSPACE_ID: session.workspaceId,
      ANTIFAN_OWNER_PID: String(boundPid),
      ANTIFAN_BOUND_TAB_ID: session.tabId || explicitTabId || '',
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
        port: session.port || bridgeInfo.port,
        secret: session.secret,
        attachmentId: session.attachmentId,
        authorityRevision: session.authorityRevision,
        runId: session.runId,
        attemptId: session.attemptId,
        projectId: session.projectId,
        workspaceId: session.workspaceId,
        tabId: session.tabId || explicitTabId,
        token: session.bridgeToken,
        ownerPid: boundPid,
        grant: targetGrant,
        allowedCapabilityNames: allowedCaps,
        forbiddenCapabilityNames: forbiddenCaps,
      }),
      ANTIFAN_FIXER_SESSION: isFixerSession ? 'true' : undefined,
      ANTIFAN_SESSION_GRANT: targetGrant,
      ANTIFAN_ALLOWED_CAPABILITY_NAMES: allowedCaps ? allowedCaps.join(',') : undefined,
      ANTIFAN_FORBIDDEN_CAPABILITY_NAMES: forbiddenCaps ? forbiddenCaps.join(',') : undefined,
    };
    // The proxy's core.* attempt store directory, minted by the bridge for this
    // session. Forwarded, never scrubbed: the value is what makes the proxy's
    // core.* population visible, and `undefined` would silently delete a value a
    // caller had already set in the parent environment (Node drops undefined env
    // entries), which is why this is a conditional assignment rather than a key
    // in the literal above. childEnv spreads the sanitized parent environment,
    // so this key is NOT confined to the proxy: a caller that pre-sets
    // ANTIFAN_PROXY_TELEMETRY_DIR sends it into the agent's whole subtree — a
    // documented limitation of this phase, not a guarantee that only the proxy
    // sees it.
    if (typeof session.proxyTelemetryDir === 'string' && session.proxyTelemetryDir.trim()) {
      childEnv.ANTIFAN_PROXY_TELEMETRY_DIR = session.proxyTelemetryDir;
    }
    const { command, commandArgs } = resolveAgentCommand(args, __dirname);

    console.error(`\x1b[36m[antifan-agent] Attached session ${session.attachmentId.slice(0, 16)}... to ${args[0]}\x1b[0m`);

    const child = spawnAgentChild(command, commandArgs, childEnv);
    activeChild = child;

    heartbeatInterval = setInterval(async () => {
      if (cleanedUp) return;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          await rpcCall(ws, 'antifan.cli.renewSession', {
            attachmentId: session.attachmentId,
            secret: session.secret,
            ownerPid: boundPid,
            extensionMs: 7200000,
          }, 3000);
        }
      } catch {}
    }, 30_000);
    heartbeatInterval.unref?.();

    child.on('error', async (err) => {
      console.error(`\x1b[31m[antifan-agent] Failed to spawn ${command}: ${err.message}\x1b[0m`);
      await cleanup('failed', err.message);
      process.exit(1);
    });

    child.on('exit', async (code, signal) => {
      const outcome = (code === 0 && !signal) ? 'completed' : (signal ? 'cancelled' : 'failed');
      await cleanup(outcome, signal ? `Signal: ${signal}` : (code !== 0 ? `Exit code: ${code}` : undefined));
      // A child killed by a signal reports code === null. Exiting 0 there would tell the
      // caller the delegated run succeeded, so a signalled exit is a failure (1) unless
      // the child produced a code of its own.
      process.exit(typeof code === 'number' ? code : (signal ? 1 : 0));
    });
  } catch (err) {
    await cleanup('failed', err?.message || String(err));
    throw err;
  }
}

function resolveAgentCommand(args, scriptsDir = __dirname) {
  if (!args || args.length === 0) {
    return { command: '', commandArgs: [], isMcpAlias: false };
  }
  const rawCommand = args[0];
  const restArgs = args.slice(1);

  if (rawCommand === 'mcp' || rawCommand === 'mcp-server' || rawCommand === 'stdio' || rawCommand === 'omp-mcp') {
    return {
      command: process.execPath,
      commandArgs: [path.resolve(scriptsDir, 'antifan-omp-mcp.cjs'), ...restArgs],
      isMcpAlias: true,
    };
  }

  return {
    command: rawCommand,
    commandArgs: restArgs,
    isMcpAlias: false,
  };
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('[antifan-agent] Unexpected error:', err);
    if (activeCleanup) {
      try {
        await activeCleanup('failed', err?.message || String(err));
      } catch {}
    }
    process.exit(1);
  });
} else {
  module.exports = {
    resolveBridgeCandidates,
    getLivenessRank,
    compareCandidates,
    acquireBridgeSession,
    performPairingExchange,
    spawnAgentChild,
    resolveAgentCommand,
    parseLauncherArgs,
  };
}

function spawnAgentChild(command, commandArgs, env, spawnOptions = {}) {
  const finalEnv = { ...(env || process.env) };
  delete finalEnv.ANTIFAN_BRIDGE_TOKEN;
  delete finalEnv.ANTIFAN_BRIDGE_PORT;
  delete finalEnv.ANTIFAN_BRIDGE_HOST;

  const { env: _ignoredEnv, ...restOptions } = spawnOptions;
  return spawn(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...restOptions,
    env: finalEnv,
  });
}
