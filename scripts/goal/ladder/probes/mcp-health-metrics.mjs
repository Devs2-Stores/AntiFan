#!/usr/bin/env node
// Probe: ladder item 25 — "Health metrics (MCP)".
//
// Acceptance signal: the MCP proxy (scripts/antifan-omp-mcp.cjs) exposes a Core
// Health surface over MCP — a dispatch key such as `core.health` whose
// invocation returns an object carrying at least `status` and `reasonCode`, so
// a client can read health over MCP instead of only through the local CLI
// (scripts/antifan-core.cjs `health`, which composes stats + corpusAudit +
// checkPhaseGate + decayCheck + classifyUncertainty).
//
// Protocol: prints exactly one JSON verdict object as the LAST stdout line.
//   exit 0 PASS | 1 FAIL | 3 NOT_IMPLEMENTED | 4 BLOCKED
//
// The proxy module is loaded in a child `node -e` process: requiring it
// registers stdin/signal shutdown handlers, so it is never imported in-process.
// The child is pointed at a TEMP store via SUPER_CORE_DB — never the production
// `.super-core/core.db`.
//
// Debug escape hatch: MCP_HEALTH_PROBE_KEY=<dispatch key> overrides the health
// key under test (used for fail-before demonstrations, e.g. core.stats).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PROXY_PATH = path.join(REPO_ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const HEALTH_KEY_RE = /health|stat|audit|gate/;
const EXPECTED_HEALTH_KEY = 'core.health';
const PROBE_KEY = process.env.MCP_HEALTH_PROBE_KEY || EXPECTED_HEALTH_KEY;
// Statuses that would mean "healthy". An empty temp store must NOT report one.
const HEALTHY_STATUS_RE = /^(OK|HEALTHY|PASS|PASSED|GREEN|GOOD|FINE)$/i;

// Probe-owned state; declared before emit so every exit path can clean up.
let tmpDir;
let core;

function cleanup() {
  try { core?.close(); } catch { /* best-effort */ }
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function emit(verdict, reason, evidence) {
  cleanup();
  process.stdout.write(JSON.stringify({ verdict, reason, evidence }) + '\n');
  const code = { PASS: 0, FAIL: 1, NOT_IMPLEMENTED: 3, BLOCKED: 4 }[verdict];
  process.exit(code);
}

// Covers the paths emit does not reach: an uncaught throw or a signal exit
// would otherwise leave the temp store behind.
process.on('exit', cleanup);

// --- prerequisite: super-core dist must be built ---------------------------
let openCore;
try {
  ({ openCore } = await import('../../../../packages/super-core/dist/index.js'));
} catch {
  emit('BLOCKED', 'packages/super-core/dist/index.js is not built; cannot open a temp store', {
    prerequisite: 'packages/super-core/dist not built',
    predecessor: 'packages/super-core/dist not built',
  });
}

// --- temp store (never the production db) -----------------------------------
tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-health-'));
const tempDbPath = path.join(tmpDir, 'core.db');
let tempStats = null;
try {
  core = openCore(tempDbPath);
  tempStats = core.stats();
} catch (e) {
  emit('FAIL', `openCore failed on a fresh temp db: ${e && e.message}`, {
    tempDbPath,
  });
} finally {
  try { core && core.close(); } catch {}
  core = undefined;
}

// --- child process: require the real proxy, dump dispatch + invoke ----------
// argv layout under `node -e`: argv[1] = REPO_ROOT, argv[2] = tempDbPath,
// argv[3] = probe key.
const CHILD_SOURCE = `
const path = require('node:path');
const repoRoot = process.argv[1];
const tempDbPath = process.argv[2];
const probeKey = process.argv[3];
process.env.SUPER_CORE_DB = tempDbPath;
function done(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\\n', () => process.exit(code));
}
let proxy;
try {
  proxy = require(path.join(repoRoot, 'scripts', 'antifan-omp-mcp.cjs'));
} catch (e) {
  done({ loadError: String((e && e.message) || e) }, 2);
}
const dispatch = proxy.CORE_DISPATCH || {};
const dispatchKeys = Object.keys(dispatch);
const advertised = (proxy.definitions || []).map((d) => d[0]).filter((n) => /^core\\./.test(n));
const out = {
  dispatchKeys,
  healthLikeDispatchKeys: dispatchKeys.filter((k) => /health|stat|audit|gate/.test(k)),
  advertisedCoreTools: advertised,
  healthLikeAdvertised: advertised.filter((k) => /health|stat|audit|gate/.test(k)),
  keyPresent: Object.prototype.hasOwnProperty.call(dispatch, probeKey),
  probeKey,
};
if (out.keyPresent && typeof proxy.invokeCore === 'function') {
  Promise.resolve()
    .then(() => proxy.invokeCore(probeKey, {}))
    .then((r) => { out.invocation = { ok: true, result: r }; done(out, 0); })
    .catch((e) => { out.invocation = { ok: false, error: String((e && e.message) || e) }; done(out, 0); });
} else {
  done(out, 0);
}
`;

const child = spawnSync(
  process.execPath,
  ['-e', CHILD_SOURCE, REPO_ROOT, tempDbPath, PROBE_KEY],
  { encoding: 'utf8', timeout: 60000, cwd: REPO_ROOT },
);

if (child.error) {
  emit('BLOCKED', `could not spawn node child to load the MCP proxy: ${child.error.message}`, {
    prerequisite: 'node child process spawn',
    spawnError: String(child.error),
  });
}
if (child.status !== 0) {
  const stderr = String(child.stderr || '').trim();
  const missingDep = /Cannot find module|MODULE_NOT_FOUND/.test(stderr);
  emit(missingDep ? 'BLOCKED' : 'FAIL',
    missingDep
      ? 'MCP proxy module could not be loaded: a dependency is missing'
      : `MCP proxy module threw on require (exit ${child.status})`,
    {
      prerequisite: missingDep ? 'MCP proxy dependencies (node_modules)' : undefined,
      loadError: stderr.split('\n').slice(0, 6).join(' | ') || null,
      childExit: child.status,
    });
}

const lastLine = String(child.stdout || '').trim().split('\n').filter(Boolean).pop();
let report = null;
try { report = JSON.parse(lastLine); } catch {}
if (!report || !Array.isArray(report.dispatchKeys)) {
  emit('FAIL', 'child process did not return a parseable dispatch report', {
    childStdoutTail: String(child.stdout || '').trim().split('\n').slice(-3),
    childStderrTail: String(child.stderr || '').trim().split('\n').slice(-3),
  });
}

const evidence = {
  probeKey: PROBE_KEY,
  expectedHealthKey: EXPECTED_HEALTH_KEY,
  dispatchKeyCount: report.dispatchKeys.length,
  healthLikeDispatchKeys: report.healthLikeDispatchKeys,
  healthLikeAdvertised: report.healthLikeAdvertised,
  advertisedCoreToolCount: report.advertisedCoreTools.length,
  tempDbPath,
  tempStoreStats: tempStats,
};

// --- verdict ----------------------------------------------------------------
if (!report.keyPresent) {
  emit('NOT_IMPLEMENTED',
    `no health capability is reachable over MCP: dispatch key '${PROBE_KEY}' is absent from CORE_DISPATCH`,
    {
      ...evidence,
      absent: `dispatch key '${PROBE_KEY}' — only 'core.stats' and 'core.corpus_audit' expose raw numbers over MCP; no key returns a {status, reasonCode} health envelope like the CLI 'health' command composes`,
    });
}

const inv = report.invocation;
if (!inv) {
  emit('FAIL', `dispatch key '${PROBE_KEY}' exists but invokeCore is not exported/invocable`, {
    ...evidence, invocation: null,
  });
}
if (!inv.ok) {
  emit('FAIL', `'${PROBE_KEY}' invocation threw: ${inv.error}`, {
    ...evidence, invocation: inv,
  });
}
const result = inv.result;
const missingFields = ['status', 'reasonCode'].filter((f) => {
  const v = result && result[f];
  return typeof v !== 'string' || v.length === 0;
});
if (!result || typeof result !== 'object' || missingFields.length > 0) {
  emit('FAIL',
    `'${PROBE_KEY}' returned a payload without the required health envelope; missing/empty fields: ${missingFields.join(', ') || '(result not an object)'}`,
    { ...evidence, invocation: inv, missingFields });
}
if (HEALTHY_STATUS_RE.test(result.status)) {
  emit('FAIL',
    `'${PROBE_KEY}' reported a healthy-style status '${result.status}' against an EMPTY temp store — a fake-healthy signal`,
    { ...evidence, invocation: inv, tempStoreClaims: tempStats && tempStats.claims });
}

emit('PASS',
  `'${PROBE_KEY}' is reachable over MCP and returned status='${result.status}' reasonCode='${result.reasonCode}' on an empty temp store`,
  { ...evidence, invocation: inv });
