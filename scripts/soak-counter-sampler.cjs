#!/usr/bin/env node
'use strict';

/**
 * AntiFan soak counter sampler (phase 10 R4/R5 evidence).
 *
 * Runs alongside the 120-minute soak window and records, on a fixed cadence:
 *   - the live verification register's byte length, record count and md5
 *   - the same count as the MCP surface reports it (`anti.verification.list`),
 *     read through the real stdio proxy the agent uses — never a client tally
 *   - one real read-only/self-restoring call per interval against the live app
 *     (rotation pool) plus a low-cadence every-N group, so the invocation
 *     ledger and the dispatch accounting aggregate carry the R4 tool names
 *   - the defect-taxonomy occurrences the runner watches (TARGET_MISMATCH,
 *     TARGET_STALE, TARGET_BUSY_DRAINING, NO_RENDER_SURFACE, RUNTIME_MISMATCH,
 *     args-parse failures, doubled mcp__ prefix) in the log bytes appended
 *     since the previous sample
 *   - the app main-process RSS/heapUsed from the lifecycle heartbeat journal,
 *     with the slope over the FINAL 30 minutes computed here (the runner only
 *     computes the whole-window slope; R5.6 names the final 30 minutes)
 *
 * Truth rules (external review fixes):
 *   - A sample whose surface probe cannot produce a numeric totalCount is a
 *     FAILED sample. `surfaceSamples` counts samples where the surface
 *     answered; the summary gate requires surfaceSamples === samples and
 *     names the failing sample indexes. `null` never passes.
 *   - Counters are reported as DELTAS (per-sample and first→last), because the
 *     first sample reads the whole historical register/log; raw per-sample
 *     values stay in the JSONL.
 *
 * Usage:
 *   node scripts/soak-counter-sampler.cjs --minutes 120 --interval-minutes 10
 *   node scripts/soak-counter-sampler.cjs --selfcheck
 *
 * Defaults write under plans/260917-1821-antifan-consolidated-remediation-soak/reports/.
 * Exit code is non-zero when any invariant gate fails (R7 honest failure).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const DEFAULT_REPORTS_DIR = path.join('plans', '260917-1821-antifan-consolidated-remediation-soak', 'reports');
const FINAL_SLOPE_WINDOW_MINUTES = 30;
const SURFACE_TIMEOUT_MS = 30000;
const ROTATION_TIMEOUT_MS = 20000;
const CADENCE_TIMEOUT_MS = 60000;
const MB = 1024 * 1024;

function parseArgs(argv) {
  const parsed = {
    minutes: 120,
    intervalMinutes: 10,
    jsonlPath: path.join(rootDir, DEFAULT_REPORTS_DIR, 'soak-counter-samples.jsonl'),
    summaryPath: path.join(rootDir, DEFAULT_REPORTS_DIR, 'soak-counter-summary.json'),
    dataRoot: process.env.ANTIFAN_DATA_ROOT || 'E:/Work/.antifan-data',
    everyN: 10,
    baselineRef: null,
    quiet: false,
    selfcheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--minutes' && argv[i + 1]) parsed.minutes = parseFloat(argv[++i]) || parsed.minutes;
    else if (arg === '--interval-minutes' && argv[i + 1]) parsed.intervalMinutes = parseFloat(argv[++i]) || parsed.intervalMinutes;
    else if (arg === '--jsonl' && argv[i + 1]) parsed.jsonlPath = path.resolve(rootDir, argv[++i]);
    else if (arg === '--summary' && argv[i + 1]) parsed.summaryPath = path.resolve(rootDir, argv[++i]);
    else if (arg === '--data-root' && argv[i + 1]) parsed.dataRoot = argv[++i];
    else if (arg === '--every-n' && argv[i + 1]) parsed.everyN = Math.max(1, parseInt(argv[++i], 10) || parsed.everyN);
    else if (arg === '--baseline-ref' && argv[i + 1]) parsed.baselineRef = argv[++i];
    else if (arg === '--quiet') parsed.quiet = true;
    else if (arg === '--selfcheck') parsed.selfcheck = true;
  }
  return parsed;
}

const TAXONOMY_PATTERNS = {
  TARGET_MISMATCH: /TARGET_MISMATCH/g,
  TARGET_STALE: /TARGET_STALE/g,
  TARGET_BUSY_DRAINING: /TARGET_BUSY_DRAINING/g,
  NO_RENDER_SURFACE: /NO_RENDER_SURFACE/g,
  RUNTIME_MISMATCH: /RUNTIME_MISMATCH/g,
  ARGS_PARSE_FAILURE: /expects a JSON args object as content/g,
  OBJECT_OBJECT: /\[object Object\]/g,
  DOUBLE_MCP_PREFIX: /mcp__mcp__/g,
  XD_MCP_PATH: /xd:\/\/mcp__antifan/g,
};

function countTaxonomy(text) {
  const counts = {};
  for (const [key, pattern] of Object.entries(TAXONOMY_PATTERNS)) {
    const matches = text.match(pattern);
    counts[key] = matches ? matches.length : 0;
  }
  return counts;
}

function readRegister(dataRoot) {
  const registerPath = path.join(dataRoot, 'issues', 'verification-register.jsonl');
  if (!fs.existsSync(registerPath)) return { path: registerPath, exists: false, bytes: 0, records: 0, md5: null, recordsByTab: {}, lastRecordId: null };
  const raw = fs.readFileSync(registerPath, 'utf8');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  let records = 0;
  let lastRecordId = null;
  const recordsByTab = {};
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      records += 1;
      if (parsed && parsed.id) lastRecordId = parsed.id;
      const tabId = parsed && parsed.scope && typeof parsed.scope.tabId === 'string' ? parsed.scope.tabId : null;
      if (tabId) recordsByTab[tabId] = (recordsByTab[tabId] || 0) + 1;
    } catch {}
  }
  return {
    path: registerPath,
    exists: true,
    bytes: Buffer.byteLength(raw, 'utf8'),
    records,
    recordsByTab,
    md5: crypto.createHash('md5').update(raw).digest('hex'),
    lastRecordId,
  };
}

/**
 * Per-interval rotation: every sample issues exactly one real call from this
 * pool (round-robin) against the live app through the same stdio proxy the
 * agent mounts, so the invocation ledger and the dispatch accounting
 * aggregate carry the R4 tool names. Every entry is read-only or
 * self-restoring (media.freeze is always followed by its unfreeze call, even
 * when the freeze itself errors — an unfreeze on an unfrozen tab is a no-op).
 * Nothing here creates/closes tabs, writes files, or mutates app state.
 */
const ROTATION_POOL = [
  { name: 'terminal.list', args: {} },
  { name: 'browser.wait', args: { condition: 'dom-stable', timeoutMs: 2000, idleWindowMs: 250 } },
  { name: 'anti.browser.tabs.list', args: {} },
  { name: 'anti.browser.get_viewport', args: {} },
  { name: 'anti.screenshot.viewport', args: { format: 'jpeg', quality: 70 } },
  {
    name: 'anti.media.freeze',
    args: { freeze: true },
    followups: [{ name: 'anti.media.freeze', args: { freeze: false }, restore: true }],
  },
];

/**
 * Low-cadence group (every --every-n sample, and always on the final sample so
 * short runs still emit the R4 names once). `anti.visual.compare` is skipped
 * with a recorded reason when no promoted baseline exists. The OMP proxy
 * advertises the QA validator as `theme.qa_validate` (`anti.theme.qa_validate`
 * is the in-app MCP alias for the same catalogue entry); the advertised name
 * is what the ledger records, so it is what we dispatch. A refusal is data
 * for the R4 error-rate row, not a crash — it is recorded verbatim.
 */
function cadenceSpecs(dataRoot, baselineRefArg) {
  const baselineRef = baselineRefArg || findLatestBaselineRef(dataRoot);
  return [
    { name: 'anti.screenshot.full_page', args: {} },
    baselineRef
      ? { name: 'anti.visual.compare', args: { baselineRef } }
      : {
          name: 'anti.visual.compare',
          skipped: true,
          skipReason: `no promoted baseline under ${path.join(dataRoot, 'baselines')} (pass --baseline-ref to pin one)`,
        },
    // workspaceRoot points at the temp dir: the call passes args validation
    // and reaches the real capability, which refuses or runs against a
    // throwaway directory — never the repo, never live app state.
    { name: 'theme.qa_validate', requestedAs: 'anti.theme.qa_validate', args: { workspaceRoot: os.tmpdir() } },
  ];
}

/** Newest promoted visual baseline id under <dataRoot>/baselines/<workspace>/. */
function findLatestBaselineRef(dataRoot) {
  const baseDir = path.join(dataRoot, 'baselines');
  if (!fs.existsSync(baseDir)) return null;
  let best = null;
  for (const ws of fs.readdirSync(baseDir)) {
    const wsDir = path.join(baseDir, ws);
    try {
      if (!fs.statSync(wsDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of fs.readdirSync(wsDir)) {
      if (!/^vbase_.*\.json$/i.test(file)) continue;
      try {
        const full = path.join(wsDir, file);
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        const id = parsed && typeof parsed.id === 'string' ? parsed.id : file.replace(/\.json$/i, '');
        const score = Number(parsed && parsed.promotedAt) || fs.statSync(full).mtimeMs;
        if (!best || score > best.score) best = { id, score };
      } catch {}
    }
  }
  return best ? best.id : null;
}

/**
 * One stdio proxy session (scripts/antifan-agent.cjs mcp) per sample. The
 * verification probe and the interval's rotation calls share it, so a sample
 * costs one spawn. Any pending call rejects if the proxy dies.
 */
function openSurfaceSession(defaultTimeoutMs = SURFACE_TIMEOUT_MS) {
  const proxyPath = path.join(rootDir, 'scripts', 'antifan-agent.cjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTIFAN_MCP_BOOTSTRAP')));
  const proc = spawn(process.execPath, [proxyPath, 'mcp'], { cwd: rootDir, env });

  const pending = new Map();
  let buffer = '';
  let seq = 0;
  let stderrTail = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const entry = parsed && parsed.id !== undefined ? pending.get(parsed.id) : null;
        if (entry) {
          pending.delete(parsed.id);
          clearTimeout(entry.timer);
          entry.resolve(parsed);
        }
      } catch {}
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  proc.on('exit', (code) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`proxy exited (code ${code})`));
    }
    pending.clear();
  });
  proc.on('error', (err) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
    pending.clear();
  });

  const call = (method, params, timeoutMs = defaultTimeoutMs) =>
    new Promise((resolve, reject) => {
      seq += 1;
      const id = `s${seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });

  const close = () => {
    try { proc.stdin.end(); } catch {}
    try { proc.kill(); } catch {}
  };

  return { call, close, stderr: () => stderrTail };
}

function extractContentText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
}

/**
 * initialize + tools/list + anti.verification.list on an open session.
 * `answered` is true only when the surface produced a numeric totalCount —
 * anything less means the R5.2 invariant could not be observed and the sample
 * fails. `pairingMs` is the spawn→initialize-response latency; `verificationMs`
 * is the verification.list call latency.
 */
async function probeSurface(session) {
  const t0 = Date.now();
  await session.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'soak-counter-sampler', version: '1.1' },
  });
  const pairingMs = Date.now() - t0;

  const listResp = await session.call('tools/list', {});
  const tools = (listResp.result?.tools || []).map((t) => t.name);
  const registerTool = tools.find((n) => /verification[._-]?list/i.test(n)) || null;
  const base = {
    tool: registerTool,
    toolCount: tools.length,
    terminalAdvertised: tools.filter((n) => /terminal[._-]/i.test(n)).length,
    pairingMs,
  };
  if (!registerTool) {
    return { ...base, answered: false, totalCount: null, isError: null, verificationMs: null, boundTabId: null, boundTabProbeMs: null, reason: 'verification surface not advertised' };
  }

  const t1 = Date.now();
  let resp;
  try {
    resp = await session.call('tools/call', { name: registerTool, arguments: {} });
  } catch (err) {
    return {
      ...base,
      answered: false,
      totalCount: null,
      isError: true,
      verificationMs: Date.now() - t1,
      reason: `verification.list failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const verificationMs = Date.now() - t1;

  const text = extractContentText(resp.result);
  let totalCount = resp.result?.structuredContent?.totalCount;
  if (typeof totalCount !== 'number') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.totalCount === 'number') totalCount = parsed.totalCount;
    } catch {}
  }
  const answered = typeof totalCount === 'number';
  const rpcError = resp.error ? JSON.stringify(resp.error) : null;

  // Bound-tab attribution probe. The proxy injects the session's bound tabId
  // into every call that omits one, and verification.list filters
  // scope.tabId on it — so an "unscoped" list can return a tab-scoped count.
  // anti.browser.get_viewport resolves the same injected tabId, which makes
  // its result the honest witness for which tab scoped this sample's count.
  let boundTabId = null;
  let boundTabProbeMs = null;
  const viewportTool = tools.find((n) => /^anti\.browser\.get_viewport$/i.test(n)) || tools.find((n) => /get[._-]?viewport/i.test(n)) || null;
  if (viewportTool) {
    const t2 = Date.now();
    try {
      const vp = await session.call('tools/call', { name: viewportTool, arguments: {} });
      boundTabProbeMs = Date.now() - t2;
      const vpText = extractContentText(vp.result);
      let tabId = vp.result?.structuredContent?.tabId;
      if (typeof tabId !== 'string' || !tabId) {
        try {
          const parsed = JSON.parse(vpText);
          if (parsed && typeof parsed.tabId === 'string') tabId = parsed.tabId;
        } catch {}
      }
      boundTabId = typeof tabId === 'string' && tabId ? tabId : null;
    } catch {
      boundTabProbeMs = Date.now() - t2;
    }
  }

  return {
    ...base,
    answered,
    totalCount: answered ? totalCount : null,
    isError: Boolean(resp.result?.isError) || Boolean(resp.error),
    verificationMs,
    boundTabId,
    boundTabProbeMs,
    reason: answered
      ? null
      : rpcError
        ? `verification.list rpc error: ${rpcError}`
        : text
          ? `surface returned no totalCount: ${text.slice(0, 300)}`
          : 'surface returned no totalCount',
  };
}

/** One rotation call; errors and refusals are recorded verbatim, never thrown. */
async function runToolCall(session, name, args, timeoutMs) {
  const started = Date.now();
  try {
    const resp = await session.call('tools/call', { name, arguments: args }, timeoutMs);
    const latencyMs = Date.now() - started;
    const isError = Boolean(resp.result?.isError) || Boolean(resp.error);
    const error = resp.error
      ? JSON.stringify(resp.error).slice(0, 600)
      : isError
        ? extractContentText(resp.result).slice(0, 600) || 'tool returned isError'
        : null;
    return { name, args, ok: !isError, isError, error, latencyMs };
  } catch (err) {
    return {
      name,
      args,
      ok: false,
      isError: true,
      error: String((err && err.message) || err).slice(0, 600),
      latencyMs: Date.now() - started,
    };
  }
}

async function runSpec(session, spec, timeoutMs) {
  if (spec.skipped) {
    return [{ name: spec.name, requestedAs: spec.requestedAs || spec.name, skipped: true, skipReason: spec.skipReason }];
  }
  const entries = [];
  const first = await runToolCall(session, spec.name, spec.args || {}, timeoutMs);
  if (spec.requestedAs) first.requestedAs = spec.requestedAs;
  entries.push(first);
  for (const follow of spec.followups || []) {
    const entry = await runToolCall(session, follow.name, follow.args || {}, timeoutMs);
    if (follow.restore) entry.restore = true;
    entries.push(entry);
  }
  return entries;
}

function readLogTail(file, maxBytes = 256 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** Latest lifecycle heartbeat (app main-process RSS/heapUsed) from main.log tail. */
function latestHeartbeat(logPath) {
  const tail = readLogTail(logPath);
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('"heartbeat"')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.event === 'heartbeat' && Number.isFinite(rec.ts)) {
        return {
          ts: rec.ts,
          iso: rec.iso || null,
          pid: Number.isFinite(rec.pid) ? rec.pid : null,
          rssBytes: Number.isFinite(rec.rss) ? rec.rss : null,
          heapUsedBytes: Number.isFinite(rec.heapUsed) ? rec.heapUsed : null,
          tabCount: rec.tabCount ?? null,
          webContentsCount: rec.webContentsCount ?? null,
        };
      }
    } catch {}
  }
  return null;
}

/**
 * All heartbeat points from main.log (+ the rotated main.log.1 so a mid-window
 * rotation cannot truncate the series). Bounded: each file is capped at 2 MB
 * by the lifecycle journal itself.
 */
function readHeartbeatSeries(dataRoot) {
  const logDir = path.join(dataRoot, 'runtime', 'logs');
  const points = [];
  for (const file of [path.join(logDir, 'main.log.1'), path.join(logDir, 'main.log')]) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"heartbeat"')) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (rec && rec.event === 'heartbeat' && Number.isFinite(rec.ts) && Number.isFinite(rec.rss) && Number.isFinite(rec.heapUsed)) {
          points.push({ ts: rec.ts, pid: rec.pid, rssBytes: rec.rss, heapUsedBytes: rec.heapUsed });
        }
      } catch {}
    }
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

/** Least-squares slope in MB/min over epoch-ms points; null when unprovable. */
function slopeMbPerMin(points, valueSelector) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const t0 = points[0].ts;
  const pts = points.map((p) => ({ minutes: (p.ts - t0) / 60000, value: valueSelector(p) / MB }));
  const meanT = pts.reduce((s, p) => s + p.minutes, 0) / pts.length;
  const meanV = pts.reduce((s, p) => s + p.value, 0) / pts.length;
  let covariance = 0;
  let variance = 0;
  for (const p of pts) {
    const dt = p.minutes - meanT;
    covariance += dt * (p.value - meanV);
    variance += dt * dt;
  }
  if (!Number.isFinite(variance) || variance <= 0) return null;
  return Number((covariance / variance).toFixed(4));
}

function latencyStats(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return { count: 0, min: null, max: null, mean: null };
  return {
    count: nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    mean: Number((nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(1)),
  };
}

/**
 * Pure summary builder (shared by the live run and --selfcheck).
 * Gates (R5): register bytes monotone; every sample's surface answered
 * (surfaceSamples === samples); totalCount === on-disk records at EVERY
 * sample — an unreadable surface fails both surface gates, never passes.
 */
function buildSummary(samples, opts = {}) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const answered = (s) => Boolean(s.surface && s.surface.answered === true);
  const failedSurfaceSamples = samples.filter((s) => !answered(s)).map((s) => s.sample);
  const mismatchedSamples = samples.filter((s) => answered(s) && s.countMatchesDisk === false).map((s) => s.sample);
  const nonMonotoneSamples = samples
    .filter((s, i) => i > 0 && s.register.bytes < samples[i - 1].register.bytes)
    .map((s) => s.sample);
  const surfaceSamples = samples.length - failedSurfaceSamples.length;

  const delta = (selector) => {
    const a = selector(first);
    const b = selector(last);
    return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  };
  const deltas = {
    registerBytes: delta((s) => s.register.bytes),
    registerRecords: delta((s) => s.register.records),
    surfaceTotalCount: delta((s) => (answered(s) ? s.surface.totalCount : NaN)),
    logBytes: delta((s) => s.logBytesTotal),
  };

  const taxonomyWindowTotals = {};
  for (const s of samples.slice(1)) {
    for (const [k, v] of Object.entries(s.taxonomyDelta || {})) {
      taxonomyWindowTotals[k] = (taxonomyWindowTotals[k] || 0) + v;
    }
  }

  const rotation = {};
  const rotationLatencies = [];
  for (const s of samples) {
    for (const r of s.rotation || []) {
      const bucket = rotation[r.name] || (rotation[r.name] = { calls: 0, errors: 0, skipped: 0 });
      if (r.skipped) {
        bucket.skipped += 1;
        continue;
      }
      bucket.calls += 1;
      if (!r.ok) bucket.errors += 1;
      if (Number.isFinite(r.latencyMs)) rotationLatencies.push(r.latencyMs);
    }
  }

  // R5.6: RSS/heap slope over the FINAL 30 minutes, from the app's own
  // lifecycle heartbeat journal (not the runner's whole-window figure).
  const heartbeats = (opts.heartbeats || []).filter((p) => p && Number.isFinite(p.ts));
  const windowEndTs = Number.isFinite(opts.windowEndTs) ? opts.windowEndTs : Date.now();
  const cutoff = windowEndTs - FINAL_SLOPE_WINDOW_MINUTES * 60000;
  const finalPoints = heartbeats.filter((p) => p.ts >= cutoff && p.ts <= windowEndTs + 60000);
  const memoryFinal30m = {
    windowMinutes: FINAL_SLOPE_WINDOW_MINUTES,
    heartbeats: finalPoints.length,
    rssSlopeMbPerMin: slopeMbPerMin(finalPoints, (p) => p.rssBytes),
    heapSlopeMbPerMin: slopeMbPerMin(finalPoints, (p) => p.heapUsedBytes),
    rssDeltaMb:
      finalPoints.length >= 2 ? Number(((finalPoints[finalPoints.length - 1].rssBytes - finalPoints[0].rssBytes) / MB).toFixed(2)) : null,
    heapDeltaMb:
      finalPoints.length >= 2
        ? Number(((finalPoints[finalPoints.length - 1].heapUsedBytes - finalPoints[0].heapUsedBytes) / MB).toFixed(2))
        : null,
    reason: finalPoints.length < 3 ? `insufficient heartbeat samples in final ${FINAL_SLOPE_WINDOW_MINUTES}m (${finalPoints.length})` : null,
  };

  const gates = {
    registerMonotone: { pass: nonMonotoneSamples.length === 0, failingSamples: nonMonotoneSamples },
    surfaceComplete: {
      pass: failedSurfaceSamples.length === 0,
      surfaceSamples,
      samples: samples.length,
      failingSamples: failedSurfaceSamples,
    },
    countMatchesDiskEverySample: {
      pass: failedSurfaceSamples.length === 0 && mismatchedSamples.length === 0,
      failingSamples: [...new Set([...failedSurfaceSamples, ...mismatchedSamples])].sort((a, b) => a - b),
      mismatchedSamples,
      // Tally of WHY samples failed the count invariant, so a bound-tab scoped
      // count is never misread as register loss (ambient-tabid-filter) and a
      // genuine register/surface disagreement is never hidden (register-divergence).
      attribution: samples.reduce((acc, s) => {
        const kind =
          s.countAttribution && s.countAttribution.kind
            ? s.countAttribution.kind
            : !answered(s)
              ? 'unreadable'
              : s.countMatchesDisk === true
                ? 'global-match'
                : 'register-divergence';
        acc[kind] = (acc[kind] || 0) + 1;
        return acc;
      }, {}),
    },
  };
  const allGatesPassed = Object.values(gates).every((g) => g.pass);

  return {
    samples: samples.length,
    surfaceSamples,
    windowMinutes: Number.isFinite(opts.windowMinutes) ? Number(opts.windowMinutes.toFixed(2)) : null,
    startedAt: first ? first.timestamp : null,
    finishedAt: last ? last.timestamp : null,
    registerBytesFirst: first ? first.register.bytes : null,
    registerBytesLast: last ? last.register.bytes : null,
    registerRecordsFirst: first ? first.register.records : null,
    registerRecordsLast: last ? last.register.records : null,
    deltas,
    pairingLatencyMs: latencyStats(samples.map((s) => s.surface && s.surface.pairingMs)),
    verificationLatencyMs: latencyStats(samples.map((s) => s.surface && s.surface.verificationMs)),
    rotation,
    rotationLatencyMs: latencyStats(rotationLatencies),
    taxonomyBaseline: first ? first.taxonomy : null,
    taxonomyWindowTotals,
    memoryFinal30m,
    gates,
    allGatesPassed,
  };
}

/**
 * --selfcheck: two synthetic sample sets in a temp dir — one where the surface
 * answers at every sample, one where it is unreachable for some samples (and
 * mismatched on another). Prints both verdicts plus the delta/slope math and
 * exits non-zero if any check fails.
 */
function runSelfcheck() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-sampler-selfcheck-'));
  const t0 = 1_700_000_000_000;
  const okSurface = (n) => ({
    answered: true,
    tool: 'anti.verification.list',
    toolCount: 150,
    terminalAdvertised: 6,
    totalCount: n,
    isError: false,
    reason: null,
    pairingMs: 40,
    verificationMs: 25,
  });
  const downSurface = {
    answered: false,
    tool: 'anti.verification.list',
    toolCount: 150,
    terminalAdvertised: 6,
    totalCount: null,
    isError: true,
    reason: 'surface unreachable: simulated selfcheck outage',
    pairingMs: 40,
    verificationMs: null,
  };
  const mkSample = (i, elapsedMin, regBytes, regRecords, surface) => ({
    sample: i,
    timestamp: new Date(t0 + elapsedMin * 60000).toISOString(),
    elapsedMinutes: elapsedMin,
    register: {
      bytes: regBytes,
      records: regRecords,
      md5: `md5-${i}`,
      lastRecordId: `rec-${i}`,
    },
    deltas: {
      registerBytes: i === 1 ? null : 100,
      registerRecords: i === 1 ? null : 1,
      surfaceTotalCount: i === 1 ? null : 1,
      logBytes: 500,
    },
    surface,
    countMatchesDisk: surface.answered ? surface.totalCount === regRecords : null,
    rotation: [{ name: 'terminal.list', args: {}, ok: true, isError: false, error: null, latencyMs: 10 + i }],
    appMemory: null,
    logFile: 'synthetic',
    logBytesTotal: 1000 + 500 * i,
    logBytesRead: 500,
    taxonomy: { TARGET_MISMATCH: i === 1 ? 2 : 0, TARGET_STALE: 0 },
    taxonomyDelta: i === 1 ? null : { TARGET_MISMATCH: 0, TARGET_STALE: 0 },
  });

  const completeSamples = [1, 2, 3, 4].map((i) => mkSample(i, (i - 1) * 10, 1000 + 100 * (i - 1), 10 + (i - 1), okSurface(10 + (i - 1))));
  const vacuousSamples = [
    mkSample(1, 0, 1000, 10, okSurface(10)),
    mkSample(2, 10, 1100, 11, downSurface),
    {
      ...mkSample(3, 20, 1200, 12, okSurface(99)), // answered but mismatched
      countAttribution: { kind: 'ambient-tabid-filter', boundTabId: 'tab-syn-1', boundTabRecords: 99 },
    },
    mkSample(4, 30, 1300, 13, downSurface),
  ];

  // Synthetic heartbeats: rss +2 MB/min, heap +1 MB/min across 40 minutes, so
  // the final-30-minute slope is a known finite number (2.0 / 1.0).
  const heartbeats = [];
  for (let m = 0; m <= 40; m += 1) {
    heartbeats.push({ ts: t0 + m * 60000, rssBytes: (500 + 2 * m) * MB, heapUsedBytes: (200 + m) * MB });
  }
  const opts = { heartbeats, windowEndTs: t0 + 40 * 60000, windowMinutes: 40 };

  const completeSummary = buildSummary(completeSamples, opts);
  const vacuousSummary = buildSummary(vacuousSamples, opts);

  fs.writeFileSync(path.join(tmp, 'complete-samples.jsonl'), completeSamples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'vacuous-samples.jsonl'), vacuousSamples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'complete-summary.json'), JSON.stringify(completeSummary, null, 2));
  fs.writeFileSync(path.join(tmp, 'vacuous-summary.json'), JSON.stringify(vacuousSummary, null, 2));

  const gatePass = (s) => Object.fromEntries(Object.entries(s.gates).map(([k, g]) => [k, g.pass]));
  console.log(`[selfcheck] complete verdict: allGatesPassed=${completeSummary.allGatesPassed} gates=${JSON.stringify(gatePass(completeSummary))} surfaceSamples=${completeSummary.surfaceSamples}/${completeSummary.samples}`);
  console.log(`[selfcheck] vacuous  verdict: allGatesPassed=${vacuousSummary.allGatesPassed} gates=${JSON.stringify(gatePass(vacuousSummary))} surfaceSamples=${vacuousSummary.surfaceSamples}/${vacuousSummary.samples} failing=${JSON.stringify(vacuousSummary.gates.surfaceComplete.failingSamples)}`);
  console.log(`[selfcheck] deltas: ${JSON.stringify(completeSummary.deltas)}`);
  console.log(`[selfcheck] memoryFinal30m: ${JSON.stringify(completeSummary.memoryFinal30m)}`);
  console.log(`[selfcheck] pairingLatencyMs: ${JSON.stringify(completeSummary.pairingLatencyMs)}`);

  const checks = [
    ['complete set PASSES all gates', completeSummary.allGatesPassed === true],
    ['complete surfaceComplete gate passes (4/4 answered)', completeSummary.gates.surfaceComplete.pass === true && completeSummary.surfaceSamples === 4],
    ['vacuous set FAILS surfaceSamples gate', vacuousSummary.gates.surfaceComplete.pass === false],
    ['vacuous surfaceSamples is 2/4', vacuousSummary.surfaceSamples === 2 && vacuousSummary.samples === 4],
    ['vacuous names failing sample indexes [2,4]', JSON.stringify(vacuousSummary.gates.surfaceComplete.failingSamples) === '[2,4]'],
    ['vacuous countMatchesDisk gate fails', vacuousSummary.gates.countMatchesDiskEverySample.pass === false],
    ['vacuous mismatch names sample 3', vacuousSummary.gates.countMatchesDiskEverySample.mismatchedSamples.includes(3)],
    ['vacuous allGatesPassed is false', vacuousSummary.allGatesPassed === false],
    ['registerBytes delta is finite (300)', completeSummary.deltas.registerBytes === 300],
    ['registerRecords delta is finite (3)', completeSummary.deltas.registerRecords === 3],
    ['surfaceTotalCount delta is finite (3)', completeSummary.deltas.surfaceTotalCount === 3],
    ['rss slope finite and ≈2 MB/min', Number.isFinite(completeSummary.memoryFinal30m.rssSlopeMbPerMin) && Math.abs(completeSummary.memoryFinal30m.rssSlopeMbPerMin - 2) < 0.01],
    ['heap slope finite and ≈1 MB/min', Number.isFinite(completeSummary.memoryFinal30m.heapSlopeMbPerMin) && Math.abs(completeSummary.memoryFinal30m.heapSlopeMbPerMin - 1) < 0.01],
    ['pairing latency reported', Number.isFinite(completeSummary.pairingLatencyMs.max) && completeSummary.pairingLatencyMs.count === 4],
    ['attribution tally counts ambient-tabid-filter', vacuousSummary.gates.countMatchesDiskEverySample.attribution['ambient-tabid-filter'] === 1 && vacuousSummary.gates.countMatchesDiskEverySample.attribution.unreadable === 2],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`[selfcheck] ${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed += 1;
  }
  console.log(`[selfcheck] ${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`} — artifacts: ${tmp}`);
  return failed === 0 ? 0 : 1;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.selfcheck) {
    process.exitCode = runSelfcheck();
    return;
  }

  const logPath = path.join(cli.dataRoot, 'runtime', 'logs', 'main.log');
  const startedAt = Date.now();
  const deadline = startedAt + cli.minutes * 60 * 1000;
  const intervalMs = Math.max(1, cli.intervalMinutes) * 60 * 1000;

  for (const p of [cli.jsonlPath, cli.summaryPath]) {
    if (p) fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  }

  // The first sample reads the whole log (window baseline); later samples read
  // only the bytes appended since the last one. taxonomyDelta is therefore
  // null on sample 1 (baseline, not a delta) and the interval's own counts
  // afterwards — never a delta-of-deltas.
  let logCursor = 0;
  let sampleIndex = 0;
  let previousSample = null;

  const takeSample = async (isFinal) => {
    sampleIndex += 1;
    const now = Date.now();
    const register = readRegister(cli.dataRoot);

    let windowLog = '';
    if (fs.existsSync(logPath)) {
      const size = fs.statSync(logPath).size;
      const start = Math.min(logCursor, size);
      const length = Math.max(0, size - start);
      if (length > 0) {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        fs.closeSync(fd);
        windowLog = buf.toString('utf8');
      }
      logCursor = size;
    }
    const taxonomy = countTaxonomy(windowLog);
    const taxonomyDelta = sampleIndex === 1 ? null : taxonomy;

    // One proxy session per sample: verification probe + rotation calls.
    let surface;
    const rotation = [];
    const session = openSurfaceSession();
    try {
      surface = await probeSurface(session);
    } catch (err) {
      surface = {
        answered: false,
        tool: null,
        toolCount: null,
        terminalAdvertised: null,
        totalCount: null,
        isError: null,
        pairingMs: null,
        verificationMs: null,
        reason: `surface unreachable: ${err && err.message ? err.message : String(err)}`,
      };
    }
    // Rotation still runs when the probe failed but the session is alive: the
    // ledger needs a real call this interval regardless of the sample verdict.
    try {
      const poolSpec = ROTATION_POOL[(sampleIndex - 1) % ROTATION_POOL.length];
      rotation.push(...(await runSpec(session, poolSpec, ROTATION_TIMEOUT_MS)));
      if (isFinal || sampleIndex % cli.everyN === 0) {
        for (const spec of cadenceSpecs(cli.dataRoot, cli.baselineRef)) {
          rotation.push(...(await runSpec(session, spec, CADENCE_TIMEOUT_MS)));
        }
      }
    } catch (err) {
      rotation.push({ name: '(rotation)', ok: false, isError: true, error: `rotation aborted: ${err && err.message ? err.message : String(err)}`, latencyMs: null });
    } finally {
      session.close();
    }

    const appMemory = latestHeartbeat(logPath);
    const prev = previousSample;
    const sample = {
      sample: sampleIndex,
      timestamp: new Date(now).toISOString(),
      elapsedMinutes: Number(((now - startedAt) / 60000).toFixed(2)),
      register: {
        bytes: register.bytes,
        records: register.records,
        recordsByTab: register.recordsByTab,
        md5: register.md5,
        lastRecordId: register.lastRecordId,
      },
      deltas: {
        registerBytes: prev ? register.bytes - prev.register.bytes : null,
        registerRecords: prev ? register.records - prev.register.records : null,
        surfaceTotalCount:
          prev && surface.answered && prev.surface && prev.surface.answered ? surface.totalCount - prev.surface.totalCount : null,
        logBytes: prev ? Buffer.byteLength(windowLog, 'utf8') : null,
      },
      surface,
      countMatchesDisk: surface.answered ? surface.totalCount === register.records : null,
      // Why a mismatch happened, when it did. 'ambient-tabid-filter' means the
      // surface count equals the bound tab's scoped on-disk count — the proxy
      // injected its session tabId into the unscoped list call (a surface
      // defect, NOT register loss). 'register-divergence' means the count
      // matches neither the global nor the bound-tab count — a real
      // register/surface disagreement. The gate still fails either way; the
      // attribution keeps a scoped count from being misread as data loss.
      countAttribution: (() => {
        if (!surface.answered) return { kind: 'unreadable' };
        if (surface.totalCount === register.records) return { kind: 'global-match' };
        const boundTabId = surface.boundTabId || null;
        // A bound tab absent from the register has a scoped count of 0 by
        // definition — undefined must read as 0, or a 0-count scoped answer
        // is misattributed as divergence.
        const boundTabRecords = boundTabId && register.recordsByTab ? (register.recordsByTab[boundTabId] ?? 0) : undefined;
        if (boundTabId && typeof boundTabRecords === 'number' && surface.totalCount === boundTabRecords && surface.totalCount < register.records) {
          return { kind: 'ambient-tabid-filter', boundTabId, boundTabRecords };
        }
        if (boundTabId) return { kind: 'register-divergence', boundTabId, boundTabRecords: boundTabRecords ?? null };
        return { kind: 'unattributed-mismatch' };
      })(),
      rotation,
      appMemory,
      logFile: logPath,
      logBytesTotal: logCursor,
      logBytesRead: Buffer.byteLength(windowLog, 'utf8'),
      taxonomy,
      taxonomyDelta,
    };
    previousSample = sample;

    if (cli.jsonlPath) fs.appendFileSync(cli.jsonlPath, `${JSON.stringify(sample)}\n`, 'utf8');
    if (!cli.quiet) {
      const rot = rotation.map((r) => (r.skipped ? `${r.name}:skip` : `${r.name}:${r.ok ? 'ok' : 'ERR'}(${r.latencyMs}ms)`)).join(' ');
      console.log(
        `[soak-sampler] #${sampleIndex} +${sample.elapsedMinutes}m register=${register.bytes}B/${register.records}recs ` +
          `(Δ${sample.deltas.registerBytes === null ? 'base' : `${sample.deltas.registerBytes}B/${sample.deltas.registerRecords}recs`}) ` +
          `surface=${surface.answered ? surface.totalCount : `DOWN(${surface.reason})`} match=${sample.countMatchesDisk}${sample.countMatchesDisk === false ? `(${sample.countAttribution.kind}${sample.countAttribution.boundTabId ? `:${sample.countAttribution.boundTabId.slice(0, 8)}` : ''})` : ''} ` +
          `pairing=${surface.pairingMs === null || surface.pairingMs === undefined ? 'n/a' : `${surface.pairingMs}ms`} ` +
          `rot=${rot || 'none'} taxonomyΔ=${JSON.stringify(taxonomyDelta)}`
      );
    }
    return sample;
  };

  const samples = [];
  samples.push(await takeSample(Date.now() + intervalMs > deadline));
  while (Date.now() + intervalMs <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    samples.push(await takeSample(Date.now() + intervalMs > deadline));
  }

  const summary = buildSummary(samples, {
    heartbeats: readHeartbeatSeries(cli.dataRoot),
    windowEndTs: Date.now(),
    windowMinutes: (Date.now() - startedAt) / 60000,
  });
  summary.config = {
    everyN: cli.everyN,
    rotationPool: ROTATION_POOL.map((s) => s.name),
    cadenceGroup: cadenceSpecs(cli.dataRoot, cli.baselineRef).map((s) => s.requestedAs || s.name),
    baselineRef: cli.baselineRef || findLatestBaselineRef(cli.dataRoot),
    jsonlPath: cli.jsonlPath,
    summaryPath: cli.summaryPath,
    dataRoot: cli.dataRoot,
  };
  if (cli.summaryPath) fs.writeFileSync(cli.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`[soak-sampler] summary ${JSON.stringify(summary)}`);
  if (!summary.allGatesPassed) {
    const failed = Object.entries(summary.gates)
      .filter(([, g]) => !g.pass)
      .map(([name, g]) => `${name} (samples: ${JSON.stringify(g.failingSamples)})`);
    console.error(`[soak-sampler] GATES FAILED: ${failed.join('; ')}`);
    process.exitCode = 1;
  }
  return summary;
}

main().catch((err) => {
  console.error('[soak-sampler] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
