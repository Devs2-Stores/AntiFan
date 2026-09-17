#!/usr/bin/env node
'use strict';
/**
 * probe-live-races.cjs — live, reproducible evidence for the two acceptance rows that a frozen copy
 * cannot exercise: a **mid-read append** (acceptance row B1) and a **compaction mid-read**
 * (acceptance row B2), both against a real directory that is being mutated while the reader reads it.
 *
 * ## What this probe does, in one paragraph
 *
 * It copies the live invocation store (`ANTIFAN_DATA_ROOT/control-plane-v2/invocations`) into a fresh
 * OS-temp root, so every mutation below happens on the COPY. It then runs the real CLI
 * (`scripts/antifan-mcp-dispatch-account.cjs --store <copy> --json`) twice — once while frames are
 * appended to the copy (Race A), once while partitions are compacted inside the copy (Race B) — and
 * records the reader's own published output (the `totals.residue` histogram, each censused file's
 * frozen `consistency` verdict, the two reconciliation identity lines, the quarantine-margin line and
 * the ledger's own stats) beside the wall-clock timestamps that prove the mutation overlapped the read.
 *
 * ## Deviation from the task brief (stated, not hidden)
 *
 * The brief says to append frames "through `InvocationLedger.observe(...)`". In this revision
 * `observe()` is a **read-only idempotency lookup** (`src/main/session/invocation-ledger.ts:288-356`:
 * it replays a partition into memory, returns `{kind:'join'|'replay'}` or `undefined`, and contains no
 * append call). Appending through it is not possible. This probe therefore:
 *
 *   1. calls `observe()` on every append and records its actual verdict, plus the byte delta across
 *      that call (0) — evidence for the claim above rather than a restatement of it,
 *   2. performs the appends through the ledger's real public write paths, `claimOwner()` (one frame)
 *      and `settle()` (one terminal frame) — the same two calls the application makes; `claimOwner()`
 *      itself calls `observe()` under its I/O lock (`invocation-ledger.ts:380`), so the read path the
 *      brief names is genuinely exercised on the write path.
 *
 * `compactPartition(attachmentId)` — public, `invocation-ledger.ts:859` — is called directly for the
 * forced mid-read compaction; auto-compaction (`:494-496`, `:655-657`, gated by
 * `maxHotRecordsPerPartition`, constructor default 200 at `:121`) is exercised separately, at that
 * default, in B1.
 *
 * ## Where the reader's vocabulary is read from
 *
 * The published envelope has no per-file residue rows: the frozen per-file witness is
 * `census.files[].consistency` (`clean` | `post-census-append` | `post-census-truncate` |
 * `rewritten-identical` | `vanished`, `mcp-dispatch-accounting.ts:1168-1224`) and the class-level
 * witness is `totals.residue` (`POST_CENSUS_APPEND`, `POST_CENSUS_TRUNCATE`, `VANISHED`, ...). This
 * probe reads both and cross-checks that the number of files whose `consistency` implies a class
 * equals that class's histogram count. A `CENSUS_DRIFT` payload publishes `census` but no
 * `totals`/`reconciliation` at all (`:2026-2033`), and is reported as exactly that.
 *
 * ## Sandbox constraint (why no piped stdio)
 *
 * A child spawned with `stdio: 'pipe'` can fail with EPERM in this environment, so each CLI pass is
 * spawned with `stdio: ['ignore', <stdout fd>, <stderr fd>]` — real files opened by this process, not
 * pipes. The reader's stdout is read back from that file and quoted verbatim. No shell, no string
 * interpolation.
 *
 * ## Safety
 *
 * The live store is opened read-only for the copy and is never written, renamed, deleted or compacted:
 * `assertNotLive()` refuses to mutate anything that is not under this run's temp root before the first
 * mutation happens.
 *
 * Usage: node plans/260917-0341-mcp-dispatch-accounting/reports/probe-live-races.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------------------------------------
// Paths, transcript, preconditions
// ---------------------------------------------------------------------------------------------

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..', '..');
const CLI = path.join(ROOT, 'scripts', 'antifan-mcp-dispatch-account.cjs');
const LEDGER_MODULE = path.join(ROOT, '.compiled', 'src', 'main', 'session', 'invocation-ledger.js');
const TRANSCRIPT = path.join(HERE, 'live-races-output.txt');

const LIVE_DATA_ROOT = typeof process.env.ANTIFAN_DATA_ROOT === 'string' && process.env.ANTIFAN_DATA_ROOT.trim() !== ''
  ? path.resolve(process.env.ANTIFAN_DATA_ROOT)
  : null;
const LIVE_STORE = LIVE_DATA_ROOT === null ? null : path.join(LIVE_DATA_ROOT, 'control-plane-v2', 'invocations');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TMP_ROOT = path.join(os.tmpdir(), `probe-live-races-${process.pid}-${STAMP}`);
const RACE_A_STORE = path.join(TMP_ROOT, 'A', 'control-plane-v2', 'invocations');
const RACE_B_STORE = path.join(TMP_ROOT, 'B', 'control-plane-v2', 'invocations');
const RACE_A_JSON = path.join(TMP_ROOT, 'race-a.json');
const RACE_B_JSON = path.join(TMP_ROOT, 'race-b.json');

const transcriptFd = fs.openSync(TRANSCRIPT, 'w');
/** Tee one line to stdout and to the raw transcript (synchronous, so a crash cannot lose the record). */
function log(line = '') {
  const text = `${line}\n`;
  fs.writeSync(transcriptFd, text);
  process.stdout.write(text);
}
function logRaw(text) {
  fs.writeSync(transcriptFd, text);
  process.stdout.write(text);
}
function logBlock(title, text) {
  log(`----- ${title} -----`);
  logRaw(`${String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`);
  log('----- end -----');
}

/** Normalised absolute path for prefix comparison (Windows is case-insensitive). */
function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}
/** Fail closed rather than touch the operator's only history. */
function assertNotLive(target, why) {
  if (LIVE_DATA_ROOT === null) throw new Error('ANTIFAN_DATA_ROOT is not set: refusing to pick a store');
  const t = norm(target);
  const live = norm(LIVE_DATA_ROOT);
  if (t === live || t.startsWith(`${live}${path.sep}`)) {
    throw new Error(`refusing to mutate inside the live data root (${why}): ${target}`);
  }
  if (!t.startsWith(norm(TMP_ROOT))) {
    throw new Error(`refusing to mutate outside this probe's temp root (${why}): ${target}`);
  }
}

for (const p of [CLI, LEDGER_MODULE]) {
  if (!fs.existsSync(p)) throw new Error(`missing prerequisite: ${p}`);
}
if (LIVE_STORE === null || !fs.existsSync(LIVE_STORE)) {
  throw new Error(`live store not found (ANTIFAN_DATA_ROOT=${LIVE_DATA_ROOT}): ${LIVE_STORE}`);
}

log('# probe-live-races.cjs — raw output');
log(`# command: node ${path.relative(ROOT, __filename).replace(/\\/g, '/')}`);
log(`# cwd: ${process.cwd()}`);
log(`# node: ${process.version}`);
log(`# started: ${new Date().toISOString()}`);
log(`# live data root (read-only source): ${LIVE_DATA_ROOT}`);
log(`# live store (read-only source):     ${LIVE_STORE}`);
log(`# temp root (ALL mutation happens here): ${TMP_ROOT}`);
log('');

// ---------------------------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------------------------

/** Byte-level newline count: the writer's own line terminator is `\n` (`invocation-ledger.ts:806`). */
function countLinesOfFile(p) {
  const buf = fs.readFileSync(p);
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  return n;
}

function statOf(p) {
  try {
    const s = fs.statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs, ino: s.ino };
  } catch (err) {
    return { error: err.code || String(err) };
  }
}

/** Files, bytes and lines of a store directory, plus a per-name index. */
function snapshotStore(dir) {
  const names = fs.readdirSync(dir).filter((n) => n.includes('.jsonl'));
  const index = {};
  let bytes = 0;
  let lines = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const l = countLinesOfFile(full);
    index[name] = { size: st.size, lines: l, mtimeMs: st.mtimeMs, ino: st.ino, birthtimeMs: st.birthtimeMs, ctimeMs: st.ctimeMs };
    bytes += st.size;
    lines += l;
  }
  return { dir, files: Object.keys(index).length, bytes, lines, index };
}

function copyStore(srcDir, dstDir) {
  const t0 = Date.now();
  fs.mkdirSync(dstDir, { recursive: true });
  const names = fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  let bytes = 0;
  for (const name of names) {
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    fs.copyFileSync(from, to);
    bytes += fs.statSync(to).size;
  }
  return { files: names.length, bytes, durationMs: Date.now() - t0, dstDir };
}

/** Parse a CLI stdout document: UTF-8 (BOM tolerated) or UTF-16LE if a shell ever wrote it. */
function loadJsonDoc(file) {
  const d = fs.readFileSync(file);
  let s = d.length >= 2 && d[0] === 0xff && d[1] === 0xfe ? d.toString('utf16le') : d.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return JSON.parse(s);
}

/** Spawn one real CLI pass. stdout/stderr go to FILES (never pipes). */
function startCli(storeDir, outFile, errFile, asOf) {
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const args = [CLI, '--store', storeDir, '--json'];
  if (typeof asOf === 'string') args.push('--as-of', asOf);
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { stdio: ['ignore', outFd, errFd], cwd: ROOT, windowsHide: true });
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: null, signal: null, error: String(err), startedAt, endedAt: Date.now() }));
    child.on('exit', (code, signal) => {
      const endedAt = Date.now();
      try { fs.closeSync(outFd); } catch { /* already closed */ }
      try { fs.closeSync(errFd); } catch { /* already closed */ }
      resolve({ code, signal, error: null, startedAt, endedAt, durationMs: endedAt - startedAt });
    });
  });
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  return { child, done, startedAt, hasExited, outFile, errFile };
}

/**
 * Watch a directory for the writer's temp artifact (`<partition>.jsonl.tmp-<pid>-<ts>`,
 * `invocation-ledger.ts:833`) and for the partition names it replaces.
 *
 * Two independent detectors, because the temp file lives only for the duration of one
 * `writeFile`+`rename` pair: an `fs.watch` subscription (Windows reports create+rename) and a 2 ms
 * `readdir` poller. Whichever sees it first wins; both timestamps are kept.
 */
function startStoreWatcher(dir) {
  const events = [];
  const tmpSeen = new Map();
  const tracked = new Set();
  const cap = 400;
  const push = (e) => { if (events.length < cap) events.push(e); };
  let watcher = null;
  try {
    watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
      const name = filename === null ? '' : String(filename);
      if (name.includes('.tmp-') || tracked.has(name)) push({ source: 'fs.watch', eventType, name, t: Date.now() });
    });
    watcher.on('error', (err) => push({ source: 'fs.watch', eventType: 'error', name: String(err), t: Date.now() }));
  } catch (err) {
    push({ source: 'fs.watch', eventType: 'open-failed', name: String(err), t: Date.now() });
  }
  const timer = setInterval(() => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.includes('.jsonl.tmp-')) continue;
      if (tmpSeen.has(name)) continue;
      let size = null;
      try { size = fs.statSync(path.join(dir, name)).size; } catch { /* it may be gone already */ }
      const rec = { name, firstSeenAt: Date.now(), sizeWhenFirstSeen: size };
      tmpSeen.set(name, rec);
      push({ source: 'poll', eventType: 'tmp-observed', name, size, t: rec.firstSeenAt });
    }
  }, 2);
  timer.unref();
  return {
    events,
    tmpSeen,
    /** Start recording fs.watch events for these partition names too (proves the atomic replace). */
    track(names) { for (const n of names) tracked.add(n); },
    stop() {
      clearInterval(timer);
      if (watcher !== null) { try { watcher.close(); } catch { /* ignore */ } }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Ledger harness (the real writer, on the copy)
// ---------------------------------------------------------------------------------------------

const ledgerModule = require(LEDGER_MODULE);
const InvocationLedger = ledgerModule.InvocationLedger;
if (typeof InvocationLedger !== 'function') {
  throw new Error(`compiled ledger does not export InvocationLedger: ${LEDGER_MODULE}`);
}

/** The public surface this probe relies on, reported verbatim as evidence. */
const LEDGER_SURFACE = ['initialize', 'observe', 'claimOwner', 'settle', 'advanceStage', 'getStats', 'drain', 'compactPartition', 'settleInFlightForShutdown', 'pruneDeadPartitions']
  .map((m) => `${m}:${typeof InvocationLedger.prototype[m]}`)
  .join(' ');

function makeAuthority(attachmentId) {
  const now = Date.now();
  return {
    attachmentId,
    authorityRevision: `probe-rev-${STAMP}`,
    revisionNumber: 1,
    projectId: 'probe-project',
    workspaceId: 'probe-workspace',
    runId: `probe-run-${STAMP}`,
    attemptId: 'probe-attempt-1',
    backendId: 'probe-backend',
    grant: 'read',
    hostEpoch: 1,
    runtimePid: process.pid,
    leaseExpiresAt: now + 3_600_000,
    issuedAt: now,
  };
}

let keyCounter = 0;
function makeIntent(attachmentId, tag) {
  keyCounter += 1;
  return {
    requestId: `probe-request-${tag}-${keyCounter}`,
    idempotencyKey: `probe-key-${tag}-${STAMP}-${keyCounter}`,
    attachmentId,
    attachmentSecret: 'probe-secret',
    authorityRevision: `probe-rev-${STAMP}`,
    name: 'probe.live.races',
    params: { probe: tag, n: keyCounter },
  };
}

const POLICY_DIGEST = `probe-policy-digest-${'0'.repeat(16)}`;
const POLICY_VERSION = 1;
const VISIBILITY = 'run-scoped';

/**
 * One real frame appended through the public write path.
 *
 * `observe()` is called first (the brief names it) and its verdict plus the byte delta across that
 * call are recorded: in this revision it is a read-only lookup, so the delta is 0 and the verdict is
 * `undefined` for a key that does not exist.
 */
async function appendOneFrame(ledger, storeDir, attachmentId, tag, resultPayload) {
  const partitionPath = path.join(storeDir, `${attachmentId}.jsonl`);
  const intent = makeIntent(attachmentId, tag);
  const authority = makeAuthority(attachmentId);

  const beforeObserve = statOf(partitionPath);
  let observed;
  let observedError = null;
  try {
    const o = await ledger.observe(intent, authority);
    observed = o === undefined ? 'undefined' : String(o.kind);
  } catch (err) {
    observed = 'threw';
    observedError = String(err && err.message ? err.message : err);
  }
  const afterObserve = statOf(partitionPath);

  const before = statOf(partitionPath);
  const linesBefore = typeof before.size === 'number' ? countLinesOfFile(partitionPath) : null;
  const t0 = Date.now();
  const claim = await ledger.claimOwner(intent, authority, POLICY_DIGEST, POLICY_VERSION, VISIBILITY);
  let settled = null;
  if (resultPayload !== undefined) {
    settled = await ledger.settle(claim.invocationId, 'completed', resultPayload);
  }
  const t1 = Date.now();
  const after = statOf(partitionPath);
  return {
    tag,
    attachmentId,
    observed,
    observedError,
    observeBytesWritten: typeof afterObserve.size === 'number' && typeof beforeObserve.size === 'number'
      ? afterObserve.size - beforeObserve.size
      : null,
    claimKind: claim.kind,
    invocationId: claim.invocationId,
    settledState: settled === null ? null : settled.state,
    t0,
    t1,
    sizeBefore: before.size,
    sizeAfter: after.size,
    linesBefore,
    linesAfter: typeof after.size === 'number' ? countLinesOfFile(partitionPath) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Envelope inspection
// ---------------------------------------------------------------------------------------------

/** The frozen per-file `consistency` value implies exactly one residue class (`:1177-1224`). */
const CONSISTENCY_TO_CLASS = {
  clean: null,
  'rewritten-identical': null,
  'post-census-append': 'POST_CENSUS_APPEND',
  'post-census-truncate': 'POST_CENSUS_TRUNCATE',
  vanished: 'VANISHED',
};

function inspectEnvelope(doc) {
  const p = doc.payload;
  const census = p.census;
  const files = census && Array.isArray(census.files) ? census.files : [];
  const consistency = {};
  for (const f of files) consistency[f.consistency] = (consistency[f.consistency] || 0) + 1;
  const fileIndex = new Map();
  for (const f of files) fileIndex.set(f.name, f);
  const rollupIndex = new Map();
  for (const r of (Array.isArray(p.fileRollups) ? p.fileRollups : [])) rollupIndex.set(r.file, r);
  return {
    storeAbsolute: doc.storeAbsolute,
    status: p.status,
    reasonCode: p.reasonCode,
    affected: p.affected,
    evidenceRefsCount: Array.isArray(p.evidenceRefs) ? p.evidenceRefs.length : 0,
    census: census === null || census === undefined ? null : {
      fileCount: census.fileCount,
      jsonlCount: census.jsonlCount,
      quarantineCount: census.quarantineCount,
      tempCount: census.tempCount,
      otherCount: census.otherCount,
      totalBytes: census.totalBytes,
      censusHash: census.censusHash,
      limits: census.limits,
      filesRead: files.length,
    },
    consistency,
    fileIndex,
    rollupIndex,
    residue: p.totals ? p.totals.residue : null,
    marginLabel: p.totals ? p.totals.quarantineMargin.label : null,
    margin: p.totals ? p.totals.quarantineMargin : null,
    truncation: p.totals ? p.totals.truncation : null,
    rowsCount: Array.isArray(p.rows) ? p.rows.length : 0,
    reconciliation: p.reconciliation,
  };
}

/** Independently re-check an identity line the reader printed, using only the numbers it printed. */
function printedIdentityHolds(line, form) {
  const nums = (String(line).match(/-?\d+/g) || []).map(Number);
  if (form === 'keys') return nums.length === 3 && nums[0] + nums[1] === nums[2];
  if (form === 'frames') return nums.length === 4 && nums[0] === nums[1] + nums[2] + nums[3];
  return false;
}

function invariantsOf(info) {
  const rec = info.reconciliation;
  const rollups = [...info.rollupIndex.values()];
  const rollupsClosed = rollups.length > 0 && rollups.every((r) => r.frames === r.admitted + r.namedInvalid);
  const rollupsUnclosed = rollups.filter((r) => r.frames !== r.admitted + r.namedInvalid).map((r) => r.file);
  const lines = rec && Array.isArray(rec.lines) ? rec.lines : [];
  const holdsKeys = rec ? rec.holdsKeys === true : false;
  const holdsFrames = rec ? rec.holdsFrames === true : false;
  const holdsMargin = rec ? rec.holdsMargin === true : false;
  const printedKeysIdentityHolds = lines.length > 0 ? printedIdentityHolds(lines[0], 'keys') : false;
  const printedFramesIdentityHolds = lines.length > 1 ? printedIdentityHolds(lines[1], 'frames') : false;
  return {
    available: rec !== null && rec !== undefined,
    holdsKeys,
    holdsFrames,
    holdsMargin,
    rollupsClosed,
    rollupsUnclosed,
    printedKeysIdentityHolds,
    printedFramesIdentityHolds,
    closed: Boolean(rec) && holdsKeys && holdsFrames && holdsMargin && rollupsClosed
      && printedKeysIdentityHolds && printedFramesIdentityHolds,
    lines,
  };
}

/** One log block with everything the evidence bar asks about the payload's shape and closure. */
function logEnvelopeFacts(raceLabel, info, inv) {
  logBlock(`${raceLabel} — payload shape and counters`, JSON.stringify({
    storeAbsolute: info.storeAbsolute,
    status: info.status,
    reasonCode: info.reasonCode,
    affected: info.affected,
    evidenceRefs: info.evidenceRefsCount,
    rows: info.rowsCount,
    census: info.census,
  }, null, 2));
  logBlock(`${raceLabel} — invariants (as published, plus an independent re-check of the printed lines)`, JSON.stringify({
    holdsKeys: inv.holdsKeys,
    holdsFrames: inv.holdsFrames,
    holdsMargin: inv.holdsMargin,
    rollupsClosed: inv.rollupsClosed,
    rollupsUnclosed: inv.rollupsUnclosed,
    printedKeysIdentityHolds: inv.printedKeysIdentityHolds,
    printedFramesIdentityHolds: inv.printedFramesIdentityHolds,
    invariantsClosed: inv.closed,
    reconciliationNumbers: info.reconciliation === null || info.reconciliation === undefined ? null : {
      classifiedKeys: info.reconciliation.classifiedKeys,
      unattributedKeys: info.reconciliation.unattributedKeys,
      keylessFrames: info.reconciliation.keylessFrames,
      compositeKeys: info.reconciliation.compositeKeys,
      frames: info.reconciliation.frames,
      superseded: info.reconciliation.superseded,
    },
  }, null, 2));
}

/** Cross-check: the number of files whose `consistency` implies a class must equal its histogram count. */
function residueVersusConsistency(info) {
  const rows = [];
  for (const [consistency, cls] of Object.entries(CONSISTENCY_TO_CLASS)) {
    if (cls === null) continue;
    const fromCensus = info.consistency[consistency] || 0;
    const fromHistogram = info.residue === null ? null : (info.residue[cls] || 0);
    rows.push({ consistency, class: cls, filesWithConsistency: fromCensus, histogramCount: fromHistogram, agree: fromHistogram === null ? null : fromCensus === fromHistogram });
  }
  return rows;
}

function detectedClasses(info) {
  const out = [];
  if (info.residue !== null) {
    for (const [k, v] of Object.entries(info.residue)) if (v > 0) out.push(`${k}=${v}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// RACE A — mid-read append (acceptance row B1)
// ---------------------------------------------------------------------------------------------

async function raceA(ledgerFactory) {
  log('');
  log('================================================================================');
  log('RACE A — mid-read APPEND against a copy that is growing while the reader reads');
  log('================================================================================');

  const copied = copyStore(LIVE_STORE, RACE_A_STORE);
  assertNotLive(RACE_A_STORE, 'race A copy destination');
  log(`copied live store -> ${RACE_A_STORE}`);
  log(`  files=${copied.files} bytes=${copied.bytes} durationMs=${copied.durationMs}`);

  const before = snapshotStore(RACE_A_STORE);
  log(`copy snapshot BEFORE: files=${before.files} bytes=${before.bytes} lines=${before.lines}`);

  // Targets: oldest mtime first, small (so no auto-compaction at the default 200 threshold can fire
  // while appending, and so the frozen read order - mtimeMs desc, `mcp-dispatch-accounting.ts:319` -
  // puts every target at the very END of the pass: the widest possible window after the census).
  const candidates = Object.entries(before.index)
    .filter(([name]) => name.endsWith('.jsonl') && !name.includes('quarantine') && !name.includes('.tmp-'))
    .filter(([, e]) => e.lines > 0 && e.lines < 150 && e.size <= 262144)
    .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  if (candidates.length < 7) throw new Error(`not enough small old partitions to race on: ${candidates.length}`);
  const appendTargets = candidates.slice(0, 6).map(([name]) => name);
  const vanishedTarget = candidates[6][0];
  log(`append targets (oldest mtime first => read last), pre-state:`);
  for (const name of appendTargets) log(`  ${name}  ${before.index[name].lines} lines / ${before.index[name].size} B`);
  log(`rename target (supplementary VANISHED probe): ${vanishedTarget} ${before.index[vanishedTarget].lines} lines / ${before.index[vanishedTarget].size} B`);

  const storeWatcher = startStoreWatcher(RACE_A_STORE);
  const pass = startCli(RACE_A_STORE, RACE_A_JSON, `${RACE_A_JSON}.err`, new Date().toISOString());
  log(`CLI started pid=${pass.child.pid} at ${new Date(pass.startedAt).toISOString()}`);
  log(`  argv: node ${path.relative(ROOT, CLI).replace(/\\/g, '/')} --store "${RACE_A_STORE}" --json`);
  log(`  stdout -> ${pass.outFile}`);
  log(`  (the child also inherits ANTIFAN_DATA_ROOT=${LIVE_DATA_ROOT}; --store wins in resolveStore(), so the pass reads the COPY only)`);

  const ledger = ledgerFactory({ dataRoot: path.join(TMP_ROOT, 'A', 'control-plane-v2') });
  log(`ledger surface: ${LEDGER_SURFACE}`);

  const appends = [];
  let renamed = null;
  let tick = 0;
  const TICK_MS = 700;
  const RENAME_AT_MS = 4500;
  const perTarget = new Map();

  while (!pass.hasExited()) {
    await sleep(TICK_MS);
    tick += 1;
    const elapsed = Date.now() - pass.startedAt;
    if (pass.hasExited()) break;

    if (renamed === null && elapsed >= RENAME_AT_MS) {
      const from = path.join(RACE_A_STORE, vanishedTarget);
      const to = `${from}.quarantine-${Date.now()}`;
      assertNotLive(to, 'race A rename target');
      const t0 = Date.now();
      let err = null;
      try { fs.renameSync(from, to); } catch (e) { err = String(e && e.message ? e.message : e); }
      // Writer-shaped name: the ledger's own quarantine rename is `${filePath}.quarantine-${Date.now()}`
      // (`invocation-ledger.ts:269`), and the reader's population predicate is `includes('.jsonl')`.
      renamed = { from: path.basename(from), to: path.basename(to), t0, t1: Date.now(), err, elapsedMs: elapsed };
      log(`[rename] ${path.basename(from)} -> ${path.basename(to)} at +${elapsed}ms err=${err === null ? 'none' : err}`);
    }

    const target = appendTargets[(tick - 1) % appendTargets.length];
    const resultPayload = tick % 2 === 0 ? { probe: 'race-a', tick, blob: 'x'.repeat(4096) } : undefined;
    const attachmentId = target.replace(/\.jsonl$/, '');
    const rec = await appendOneFrame(ledger, RACE_A_STORE, attachmentId, `a${tick}`, resultPayload);
    const entry = {
      ...rec,
      tick,
      file: target,
      elapsedAtStartMs: rec.t0 - pass.startedAt,
      elapsedAtEndMs: rec.t1 - pass.startedAt,
    };
    appends.push(entry);
    if (!perTarget.has(target)) perTarget.set(target, []);
    perTarget.get(target).push(entry);
    log(`[append] #${tick} ${target} lines ${rec.linesBefore} -> ${rec.linesAfter} (${rec.sizeBefore} -> ${rec.sizeAfter} B)`
      + ` observe=${rec.observed}(wrote ${rec.observeBytesWritten} B) claim=${rec.claimKind}`
      + ` at +${entry.elapsedAtStartMs}ms..+${entry.elapsedAtEndMs}ms`);
    if (rec.observedError !== null) log(`         observe error: ${rec.observedError}`);
  }

  const outcome = await pass.done;
  storeWatcher.stop();
  const after = snapshotStore(RACE_A_STORE);
  log(`CLI exit code=${outcome.code} signal=${outcome.signal} durationMs=${outcome.durationMs} (ended ${new Date(outcome.endedAt).toISOString()})`);
  log(`copy snapshot AFTER: files=${after.files} bytes=${after.bytes} lines=${after.lines}`);
  log(`appends inside the pass process lifetime: ${appends.filter((a) => a.t0 >= outcome.startedAt && a.t1 <= outcome.endedAt).length} of ${appends.length}`);

  const stderrText = fs.existsSync(`${RACE_A_JSON}.err`) ? fs.readFileSync(`${RACE_A_JSON}.err`, 'utf8') : '';
  if (stderrText.trim() !== '') logBlock('RACE A — CLI stderr (verbatim)', stderrText);
  if (outcome.code !== 0) log(`RACE A — WARNING: CLI exit code was ${outcome.code}`);

  let doc;
  try {
    doc = loadJsonDoc(RACE_A_JSON);
  } catch (err) {
    logBlock('RACE A — CLI stdout HEAD (unparseable, 1200 chars)', fs.readFileSync(RACE_A_JSON, 'utf8').slice(0, 1200));
    throw new Error(`race A: CLI stdout was not parseable JSON: ${String(err && err.message ? err.message : err)}`);
  }

  const info = inspectEnvelope(doc);
  const inv = invariantsOf(info);
  const xcheck = residueVersusConsistency(info);
  if (info.census === null) log('RACE A — census is null on this payload shape');

  logBlock('RACE A — reader reconciliation lines (verbatim)', inv.lines.length > 0 ? inv.lines.join('\n') : '(no reconciliation published by this payload shape)');
  logEnvelopeFacts('RACE A', info, inv);
  if (info.marginLabel !== null) logBlock('RACE A — quarantine margin (verbatim)', info.marginLabel);
  if (info.truncation !== null) logBlock('RACE A — truncation disclosure (verbatim)', info.truncation.label);
  logBlock('RACE A — totals.residue histogram', JSON.stringify(info.residue, null, 2));
  logBlock('RACE A — census consistency histogram', JSON.stringify(info.consistency, null, 2));
  logBlock('RACE A — consistency vs residue-histogram cross-check', JSON.stringify(xcheck, null, 2));

  const targetRows = [];
  for (const [file, list] of perTarget) {
    const censusEntry = info.fileIndex.get(file) || null;
    const rollup = info.rollupIndex.get(file) || null;
    const impliedClass = censusEntry === null ? null : CONSISTENCY_TO_CLASS[censusEntry.consistency] ?? null;
    targetRows.push({
      file,
      pre: before.index[file],
      post: after.index[file],
      appendCount: list.length,
      appendWindowMs: [list[0].elapsedAtStartMs, list[list.length - 1].elapsedAtEndMs],
      censusEntry,
      impliedClass,
      rollup,
    });
    log(`[target] ${file}: ${before.index[file].lines} lines/${before.index[file].size} B -> ${after.index[file].lines} lines/${after.index[file].size} B; appends=${list.length} at +${list[0].elapsedAtStartMs}..+${list[list.length - 1].elapsedAtEndMs}ms`);
    log(`         reader census entry: ${JSON.stringify(censusEntry)}`);
    log(`         reader consistency => ${censusEntry === null ? 'n/a' : censusEntry.consistency} (implies ${impliedClass === null ? 'no residue class' : impliedClass})`);
    log(`         reader rollup: ${JSON.stringify(rollup)}`);
  }

  const vanishedCensusEntry = info.fileIndex.get(vanishedTarget) || null;
  log(`[target] ${vanishedTarget} (renamed mid-pass at +${renamed === null ? 'n/a' : renamed.elapsedMs}ms):`
    + ` census entry ${JSON.stringify(vanishedCensusEntry)} => ${vanishedCensusEntry === null ? 'n/a' : vanishedCensusEntry.consistency}`);
  log(`[rename] ${JSON.stringify(renamed)}`);
  log(`[tmp files observed during race A] ${storeWatcher.tmpSeen.size === 0 ? 'none' : JSON.stringify([...storeWatcher.tmpSeen.values()])}`);

  const residueObserved = detectedClasses(info);
  const classOf = (c) => (info.residue === null ? 0 : (info.residue[c] || 0));
  const appendResidue = classOf('POST_CENSUS_APPEND');
  const vanishedResidue = classOf('VANISHED');
  const appendFilesDetected = targetRows.filter((r) => r.impliedClass === 'POST_CENSUS_APPEND').map((r) => r.file);
  const appendsInsideLifetime = appends.filter((a) => a.t0 >= outcome.startedAt && a.t1 <= outcome.endedAt).length;
  const overlap = appendsInsideLifetime > 0 && (appendResidue > 0 || vanishedResidue > 0);

  let verdict;
  if (info.status !== 'MEASURED' && info.status !== 'UNMEASURED') {
    verdict = `UNEXPECTED payload status=${info.status}`;
  } else if (info.status === 'UNMEASURED') {
    verdict = `NO MEASUREMENT — status=UNMEASURED reasonCode=${info.reasonCode}; this payload publishes no residue, so the append race produced no reader vocabulary on this run`;
  } else if (appendResidue > 0) {
    verdict = `DETECTED — the reader named the mid-read append: totals.residue.POST_CENSUS_APPEND=${appendResidue}`
      + ` (censused files reporting consistency=post-census-append: ${appendFilesDetected.length}${appendFilesDetected.length > 0 ? ` -> ${appendFilesDetected.join(', ')}` : ''})`
      + `${vanishedResidue > 0 ? `, and VANISHED=${vanishedResidue} for the partition renamed mid-pass` : ''}`;
  } else {
    verdict = 'NOT DETECTED as a short-read residue — every censused file came back clean, so each append landed outside the window of the file the reader read and stat-ed; the invariants closed because nothing inside the window changed';
  }

  return {
    race: 'A',
    kind: 'append',
    copied,
    storeDir: RACE_A_STORE,
    jsonFile: RACE_A_JSON,
    outcome,
    before,
    after,
    info,
    invariants: inv,
    xcheck,
    appends,
    targetRows,
    renamed,
    vanishedTarget,
    vanishedCensusEntry,
    tmpSeen: [...storeWatcher.tmpSeen.values()],
    watchEvents: storeWatcher.events,
    appendsInsideLifetime,
    overlap,
    residueObserved,
    verdict,
  };
}

// ---------------------------------------------------------------------------------------------
// RACE B — compaction mid-read (acceptance row B2)
// ---------------------------------------------------------------------------------------------

async function raceB(ledgerFactory) {
  log('');
  log('================================================================================');
  log('RACE B — COMPACTION mid-read: auto-compaction at the default threshold (200) plus');
  log('         explicit public compactPartition() calls while a CLI pass is reading');
  log('================================================================================');

  const copied = copyStore(LIVE_STORE, RACE_B_STORE);
  assertNotLive(RACE_B_STORE, 'race B copy destination');
  log(`copied live store -> ${RACE_B_STORE}`);
  log(`  files=${copied.files} bytes=${copied.bytes} durationMs=${copied.durationMs}`);

  const before = snapshotStore(RACE_B_STORE);
  log(`copy snapshot BEFORE (pre-seed): files=${before.files} bytes=${before.bytes} lines=${before.lines}`);

  const B_DATA_ROOT = path.join(TMP_ROOT, 'B', 'control-plane-v2');
  const storeWatcher = startStoreWatcher(RACE_B_STORE);

  // ---- B1: auto-compaction, default maxHotRecordsPerPartition (200), no explicit compact call ----
  log('');
  log('--- B1: auto-compaction at the DEFAULT threshold (200), no explicit compact call ---');
  const autoAttachment = `attachment-probe-autocompact-${STAMP.replace(/[^0-9a-zA-Z-]/g, '')}`;
  const autoPath = path.join(RACE_B_STORE, `${autoAttachment}.jsonl`);
  const autoLedger = ledgerFactory({ dataRoot: B_DATA_ROOT }); // DEFAULT maxHotRecordsPerPartition
  const autoStatsBefore = autoLedger.getStats();
  const autoShrinks = [];
  const autoTimeline = [];
  const autoT0 = Date.now();
  const AUTO_KEYS = 100;
  let autoLastSize = 0;
  // A 2 ms size timeline for the single partition: the auto-compaction is fire-and-forget
  // (`invocation-ledger.ts:494-496`), so its shrink can land after the append that triggered it
  // returns. Polling the size independently of the append loop is what makes the shrink observable.
  let lastPolledSize = -1;
  const autoTimer = setInterval(() => {
    let s;
    try { s = fs.statSync(autoPath).size; } catch { return; }
    if (s !== lastPolledSize) {
      autoTimeline.push({ t: Date.now(), size: s, elapsedMs: Date.now() - autoT0 });
      lastPolledSize = s;
    }
  }, 2);
  autoTimer.unref();
  for (let k = 1; k <= AUTO_KEYS; k += 1) {
    const intent = makeIntent(autoAttachment, `auto${k}`);
    const authority = makeAuthority(autoAttachment);
    const claim = await autoLedger.claimOwner(intent, authority, POLICY_DIGEST, POLICY_VERSION, VISIBILITY);
    await autoLedger.settle(claim.invocationId, 'completed', { probe: 'auto', k, blob: 'y'.repeat(24 * 1024) });
    const sizeNow = statOf(autoPath).size;
    if (k > 1 && typeof sizeNow === 'number' && Number.isFinite(autoLastSize) && autoLastSize > 0 && sizeNow < autoLastSize) {
      autoShrinks.push({
        afterKey: k,
        appendsSoFar: k * 2,
        sizeBefore: autoLastSize,
        sizeAfter: sizeNow,
        linesAtObservation: countLinesOfFile(autoPath),
        t: Date.now(),
        elapsedMs: Date.now() - autoT0,
      });
      log(`[B1 shrink] ${autoAttachment}.jsonl shrank ${autoLastSize} -> ${sizeNow} B after key #${k} (append #${k * 2}, t+${Date.now() - autoT0}ms) — auto-compaction fired on its own`);
    }
    autoLastSize = sizeNow;
  }
  await autoLedger.drain(autoAttachment);
  await sleep(600);
  clearInterval(autoTimer);
  const autoStatsAfter = autoLedger.getStats();
  const autoLines = countLinesOfFile(autoPath);
  const autoTmpArtifacts = [...storeWatcher.tmpSeen.values()].filter((t) => t.name.startsWith(`${autoAttachment}.jsonl.tmp-`));
  const timelineShrinks = autoTimeline.filter((e, i) => i > 0 && e.size < autoTimeline[i - 1].size);
  const autoCompactionObserved = autoLines < AUTO_KEYS * 2
    && autoTmpArtifacts.length > 0
    && autoStatsAfter.frameCount === autoLines;
  log(`[B1] constructor threshold in force: maxHotRecordsPerPartition default = 200 (` +
    `invocation-ledger.ts:121); frames appended = ${AUTO_KEYS} x (claimOwner + settle) = ${AUTO_KEYS * 2}`);
  log(`[B1] explicit compactPartition() calls issued by this probe in B1: 0`);
  log(`[B1] ledger getStats BEFORE: ${JSON.stringify(autoStatsBefore)}`);
  log(`[B1] ledger getStats AFTER:  ${JSON.stringify(autoStatsAfter)}`);
  log(`[B1] partition lines now: ${autoLines} (one retained frame per idempotencyKey => ${AUTO_KEYS});` +
    ` lines without a compaction would still be ${AUTO_KEYS * 2}`);
  log(`[B1] partition size now: ${statOf(autoPath).size} B`);
  log(`[B1] temp artifacts for this partition: ${autoTmpArtifacts.length === 0 ? 'none' : JSON.stringify(autoTmpArtifacts)}`);
  log(`[B1] size timeline (2 ms poll): ${JSON.stringify(autoTimeline)}`);
  log(`[B1] shrink transitions in the timeline: ${JSON.stringify(timelineShrinks)}`);
  log(`[B1] shrink observations from the append loop: ${JSON.stringify(autoShrinks)}`);
  log(`[B1] AUTO-COMPACTION OBSERVED: ${autoCompactionObserved ? 'yes' : 'no'}` +
    ` (lines ${autoLines} < ${AUTO_KEYS * 2} AND a temp artifact was seen AND getStats().frameCount ${autoStatsAfter.frameCount} == ${autoLines})`);

  // ---- B2: explicit compactPartition() while a CLI pass is reading ----
  log('');
  log('--- B2: explicit public compactPartition() timed to land inside a CLI pass ---');
  // A high threshold is used ONLY here, so the explicit call is the only compaction in the window;
  // the default-threshold behaviour is what B1 above measures.
  const ctlLedger = ledgerFactory({ dataRoot: B_DATA_ROOT, maxHotRecordsPerPartition: 1_000_000 });
  const targets = [];
  const KEYS_PER_TARGET = 80;
  const RESULT_BYTES = 32 * 1024;
  for (let ti = 1; ti <= 4; ti += 1) {
    const attachmentId = `attachment-probe-race-b${ti}-${STAMP.replace(/[^0-9a-zA-Z-]/g, '')}`;
    const p = path.join(RACE_B_STORE, `${attachmentId}.jsonl`);
    for (let k = 1; k <= KEYS_PER_TARGET; k += 1) {
      const intent = makeIntent(attachmentId, `b${ti}k${k}`);
      const authority = makeAuthority(attachmentId);
      const claim = await ctlLedger.claimOwner(intent, authority, POLICY_DIGEST, POLICY_VERSION, VISIBILITY);
      await ctlLedger.settle(claim.invocationId, 'completed', { probe: 'race-b', ti, k, blob: 'z'.repeat(RESULT_BYTES) });
    }
    await ctlLedger.drain(attachmentId);
    // Backdate so the reader - frozen order mtimeMs desc, `mcp-dispatch-accounting.ts:319` - reads
    // this file LAST, which is the widest possible window after the census.
    const backdatedSec = Date.UTC(1970, 0, 1 + ti) / 1000;
    fs.utimesSync(p, backdatedSec, backdatedSec);
    const st = statOf(p);
    const lines = countLinesOfFile(p);
    targets.push({
      attachmentId,
      name: path.basename(p),
      path: p,
      preSize: st.size,
      preLines: lines,
      preStat: st,
      backdatedTo: new Date(backdatedSec * 1000).toISOString(),
      waves: [],
    });
    log(`[B2 seed] ${path.basename(p)} ${lines} lines / ${st.size} B (threshold raised to 1000000 so only the explicit call can compact) mtime backdated to ${new Date(backdatedSec * 1000).toISOString()}`);
  }

  const afterSeed = snapshotStore(RACE_B_STORE);
  log(`copy snapshot AFTER SEED (= the census population of the pass): files=${afterSeed.files} bytes=${afterSeed.bytes} lines=${afterSeed.lines}`);

  // Track the four partition names so the directory watcher records the rename that replaces each
  // one (the writer's `rename(tempFile, filePath)`, `invocation-ledger.ts:848`).
  storeWatcher.track(targets.map((t) => t.name));
  storeWatcher.track([`${autoAttachment}.jsonl`]);

  const pass = startCli(RACE_B_STORE, RACE_B_JSON, `${RACE_B_JSON}.err`, new Date().toISOString());
  log(`CLI started pid=${pass.child.pid} at ${new Date(pass.startedAt).toISOString()}`);
  log(`  argv: node ${path.relative(ROOT, CLI).replace(/\\/g, '/')} --store "${RACE_B_STORE}" --json`);
  log(`  stdout -> ${pass.outFile}`);

  const WAVES_MS = [1000, 2000, 3000, 4000];
  let aborted = false;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    await sleepUntil(pass.startedAt + WAVES_MS[i], () => pass.hasExited());
    if (pass.hasExited()) { aborted = true; break; }
    const elapsed = Date.now() - pass.startedAt;
    const statBefore = statOf(target.path);
    const linesBefore = countLinesOfFile(target.path);
    const statsBefore = ctlLedger.getStats();
    const watchMark = storeWatcher.events.length;
    const t0 = Date.now();
    let err = null;
    try {
      await ctlLedger.compactPartition(target.attachmentId);
    } catch (e) {
      err = String(e && e.message ? e.message : e);
    }
    const t1 = Date.now();
    const statAfter = statOf(target.path);
    const linesAfter = countLinesOfFile(target.path);
    const statsAfter = ctlLedger.getStats();
    const wave = {
      wave: i + 1,
      elapsedMsAtCall: t0 - pass.startedAt,
      t0,
      t1,
      err,
      sizeBefore: statBefore.size,
      sizeAfter: statAfter.size,
      linesBefore,
      linesAfter,
      inoBefore: statBefore.ino,
      inoAfter: statAfter.ino,
      birthtimeBefore: statBefore.birthtimeMs,
      birthtimeAfter: statAfter.birthtimeMs,
      mtimeBefore: statBefore.mtimeMs,
      mtimeAfter: statAfter.mtimeMs,
      ledgerFrameCountBefore: statsBefore.frameCount,
      ledgerFrameCountAfter: statsAfter.frameCount,
      ledgerPersistedBytesBefore: statsBefore.persistedBytes,
      ledgerPersistedBytesAfter: statsAfter.persistedBytes,
      watchEvents: storeWatcher.events.slice(watchMark),
    };
    target.waves.push(wave);
    log(`[B2 wave ${i + 1}] compactPartition(${target.attachmentId}) called at +${wave.elapsedMsAtCall}ms err=${err === null ? 'none' : err}`);
    log(`           ${target.name}: ${linesBefore} lines/${statBefore.size} B -> ${linesAfter} lines/${statAfter.size} B`);
    log(`           ino ${statBefore.ino} -> ${statAfter.ino}; birthtime ${statBefore.birthtimeMs} -> ${statAfter.birthtimeMs}`);
    log(`           ledger frameCount ${wave.ledgerFrameCountBefore} -> ${wave.ledgerFrameCountAfter}; persistedBytes ${wave.ledgerPersistedBytesBefore} -> ${wave.ledgerPersistedBytesAfter}`);
    log(`           watcher events in this window: ${JSON.stringify(wave.watchEvents.slice(0, 10))}`);
  }
  if (aborted) log('[B2] the CLI pass exited before all four waves ran (reported as-is; no wave was fabricated)');

  const outcome = await pass.done;
  storeWatcher.stop();
  const after = snapshotStore(RACE_B_STORE);
  log(`CLI exit code=${outcome.code} signal=${outcome.signal} durationMs=${outcome.durationMs} (ended ${new Date(outcome.endedAt).toISOString()})`);
  if (outcome.code !== 0) log(`RACE B — WARNING: CLI exit code was ${outcome.code}`);
  log(`copy snapshot AFTER: files=${after.files} bytes=${after.bytes} lines=${after.lines}`);

  const stderrText = fs.existsSync(`${RACE_B_JSON}.err`) ? fs.readFileSync(`${RACE_B_JSON}.err`, 'utf8') : '';
  if (stderrText.trim() !== '') logBlock('RACE B — CLI stderr (verbatim)', stderrText);

  let doc;
  try {
    doc = loadJsonDoc(RACE_B_JSON);
  } catch (err) {
    logBlock('RACE B — CLI stdout HEAD (unparseable, 1200 chars)', fs.readFileSync(RACE_B_JSON, 'utf8').slice(0, 1200));
    throw new Error(`race B: CLI stdout was not parseable JSON: ${String(err && err.message ? err.message : err)}`);
  }
  const info = inspectEnvelope(doc);
  const inv = invariantsOf(info);
  const xcheck = residueVersusConsistency(info);

  logBlock('RACE B — reader reconciliation lines (verbatim)', inv.lines.length > 0 ? inv.lines.join('\n') : '(no reconciliation published by this payload shape)');
  logEnvelopeFacts('RACE B', info, inv);
  if (info.marginLabel !== null) logBlock('RACE B — quarantine margin (verbatim)', info.marginLabel);
  if (info.truncation !== null) logBlock('RACE B — truncation disclosure (verbatim)', info.truncation.label);
  logBlock('RACE B — totals.residue histogram', JSON.stringify(info.residue, null, 2));
  logBlock('RACE B — census consistency histogram', JSON.stringify(info.consistency, null, 2));
  logBlock('RACE B — consistency vs residue-histogram cross-check', JSON.stringify(xcheck, null, 2));

  const targetRows = [];
  for (const target of targets) {
    const censusEntry = info.fileIndex.get(target.name) || null;
    const rollup = info.rollupIndex.get(target.name) || null;
    const impliedClass = censusEntry === null ? null : CONSISTENCY_TO_CLASS[censusEntry.consistency] ?? null;
    const row = {
      name: target.name,
      preLines: target.preLines,
      preSize: target.preSize,
      postLines: after.index[target.name] === undefined ? null : after.index[target.name].lines,
      postSize: after.index[target.name] === undefined ? null : after.index[target.name].size,
      waves: target.waves.map((w) => ({
        wave: w.wave,
        elapsedMsAtCall: w.elapsedMsAtCall,
        err: w.err,
        linesBefore: w.linesBefore,
        linesAfter: w.linesAfter,
        sizeBefore: w.sizeBefore,
        sizeAfter: w.sizeAfter,
        tmpNamesInWindow: w.watchEvents.filter((e) => e.name.includes('.tmp-')).map((e) => e.name),
      })),
      censusEntry,
      impliedClass,
      rollup,
    };
    targetRows.push(row);
    log(`[target] ${target.name}: seeded ${row.preLines} lines/${row.preSize} B -> final ${row.postLines} lines/${row.postSize} B`);
    log(`         waves: ${JSON.stringify(row.waves)}`);
    log(`         reader census entry: ${JSON.stringify(censusEntry)}`);
    log(`         reader consistency => ${censusEntry === null ? 'n/a' : censusEntry.consistency} (implies ${impliedClass === null ? 'no residue class' : impliedClass})`);
  }

  const tmpAll = [...storeWatcher.tmpSeen.values()];
  log(`[tmp files observed during race B] ${tmpAll.length === 0 ? 'none' : JSON.stringify(tmpAll)}`);
  const tmpWatchEvents = storeWatcher.events.filter((e) => e.name.includes('.tmp-'));
  log(`[fs.watch temp events during race B] ${tmpWatchEvents.length === 0 ? 'none' : JSON.stringify(tmpWatchEvents.slice(0, 20))}`);

  const autoCensusEntry = info.fileIndex.get(`${autoAttachment}.jsonl`) || null;
  log(`[B1 census] attachment-probe-autocompact: ${JSON.stringify(autoCensusEntry)}`);
  const leftoverTmp = fs.readdirSync(RACE_B_STORE).filter((n) => n.includes('.tmp-'));
  log(`[leftover tmp files after the pass] ${leftoverTmp.length === 0 ? 'none' : JSON.stringify(leftoverTmp)}`);

  const residueObserved = detectedClasses(info);
  const classOf = (c) => (info.residue === null ? 0 : (info.residue[c] || 0));
  const truncateCount = classOf('POST_CENSUS_TRUNCATE');
  const vanishedCount = classOf('VANISHED');
  const rewrittenCount = info.consistency['rewritten-identical'] || 0;
  const truncateFiles = targetRows.filter((r) => r.impliedClass === 'POST_CENSUS_TRUNCATE').map((r) => r.name);
  const wavesShrank = targets.flatMap((t) => t.waves).filter((w) => w.linesAfter < w.linesBefore);
  const waveTmpEvents = tmpWatchEvents.filter((e) => e.t >= outcome.startedAt && e.t <= outcome.endedAt);
  const replacementEvents = storeWatcher.events.filter((e) => !e.name.includes('.tmp-') && e.t >= outcome.startedAt);
  log(`[B2 replacement events on tracked partition names] ${replacementEvents.length === 0 ? 'none' : JSON.stringify(replacementEvents.slice(0, 12))}`);
  // The compaction really happened when the temp artifact was seen for a partition that also ended
  // up rewritten (shorter, new inode/birthtime) and the ledger's own stats moved with it.
  const compactionProven = autoCompactionObserved
    && wavesShrank.length === targets.length
    && tmpAll.length >= targets.length
    && wavesShrank.every((w) => w.ledgerFrameCountAfter < w.ledgerFrameCountBefore)
    && autoStatsAfter.frameCount === autoLines;
  const overlap = waveTmpEvents.length > 0 && wavesShrank.length > 0;

  let verdict;
  if (info.status === 'CENSUS_DRIFT') {
    verdict = `DETECTED AS DRIFT — the reader refused to publish rows and returned UNMEASURED/${info.reasonCode}; the census it did publish carries the evidence (this payload shape has no residue histogram and no reconciliation)`;
  } else if (info.status === 'UNMEASURED' && info.reasonCode !== 'OK') {
    verdict = `NO MEASUREMENT — status=UNMEASURED reasonCode=${info.reasonCode}`;
  } else if (truncateCount > 0) {
    verdict = `DETECTED — the reader named the mid-read compaction: totals.residue.POST_CENSUS_TRUNCATE=${truncateCount}`
      + ` (censused files reporting consistency=post-census-truncate: ${truncateFiles.join(', ') || 'none'})`;
  } else if (vanishedCount > 0) {
    verdict = `DETECTED — the reader named a vanished partition: totals.residue.VANISHED=${vanishedCount}`;
  } else if (rewrittenCount > 0) {
    verdict = `DETECTED (weaker vocabulary) — no short-read residue, but ${rewrittenCount} censused file(s) published consistency=rewritten-identical`;
  } else {
    verdict = 'NOT DETECTED — the reader closed its invariants and every census entry is clean, so each compaction landed outside the window of the file the reader had already read and stat-ed';
  }

  return {
    race: 'B',
    kind: 'compaction',
    copied,
    storeDir: RACE_B_STORE,
    jsonFile: RACE_B_JSON,
    outcome,
    before,
    after,
    afterSeed,
    info,
    invariants: inv,
    xcheck,
    auto: {
      attachment: `${autoAttachment}.jsonl`,
      keys: AUTO_KEYS,
      expectedLinesWithoutCompaction: AUTO_KEYS * 2,
      shrinks: autoShrinks,
      timeline: autoTimeline,
      timelineShrinks,
      tmpArtifacts: autoTmpArtifacts,
      autoCompactionObserved,
      statsBefore: autoStatsBefore,
      statsAfter: autoStatsAfter,
      linesNow: autoLines,
      censusEntry: autoCensusEntry,
    },
    replacementEvents,
    targets: targetRows,
    rawTargets: targets,
    tmpAll,
    tmpWatchEvents,
    leftoverTmp,
    overlap,
    compactionProven,
    residueObserved,
    verdict,
  };
}

// ---------------------------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });
}
async function sleepUntil(targetMs, isAborted) {
  while (Date.now() < targetMs) {
    if (isAborted()) return;
    await sleep(Math.min(50, Math.max(1, targetMs - Date.now())));
  }
}

/**
 * Control: one more real CLI pass over the same directory with NOTHING mutating it.
 *
 * This is what separates "the reader reported the race" from "the directory's content is what the
 * reader reports": the race classes must be gone and every censused file must be `clean` again.
 */
async function controlPass(label, storeDir, jsonPath) {
  log('');
  log(`--- CONTROL — a second CLI pass over the same directory with nothing mutating (${label}) ---`);
  const pass = startCli(storeDir, jsonPath, `${jsonPath}.err`, new Date().toISOString());
  const outcome = await pass.done;
  let info = null;
  let inv = null;
  let error = null;
  try {
    info = inspectEnvelope(loadJsonDoc(jsonPath));
    inv = invariantsOf(info);
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  if (info === null) {
    log(`[control ${label}] unparseable stdout: ${error}`);
    return { label, storeDir, jsonPath, outcome, info: null, inv: null, error };
  }
  log(`[control ${label}] exit=${outcome.code} durationMs=${outcome.durationMs} status=${info.status}/${info.reasonCode}`);
  log(`[control ${label}] totals.residue = ${JSON.stringify(info.residue)}`);
  log(`[control ${label}] census consistency = ${JSON.stringify(info.consistency)}`);
  log(`[control ${label}] invariants closed = ${inv.closed} (holdsKeys=${inv.holdsKeys} holdsFrames=${inv.holdsFrames}`
    + ` holdsMargin=${inv.holdsMargin} rollupsClosed=${inv.rollupsClosed} printedIdentities=${inv.printedKeysIdentityHolds}/${inv.printedFramesIdentityHolds})`);
  log(`[control ${label}] reconciliation lines: ${inv.lines.join(' | ')}`);
  const raceClasses = ['POST_CENSUS_APPEND', 'POST_CENSUS_TRUNCATE', 'VANISHED'];
  const stillPresent = raceClasses.filter((c) => info.residue !== null && (info.residue[c] || 0) > 0);
  const shortReadConsistency = Object.keys(info.consistency).filter((k) => k !== 'clean' && k !== 'rewritten-identical');
  log(`[control ${label}] race classes still present: ${stillPresent.length === 0 ? 'none' : stillPresent.join(',')}`
    + `; non-clean consistencies: ${shortReadConsistency.length === 0 ? 'none' : shortReadConsistency.join(',')}`);
  return { label, storeDir, jsonPath, outcome, info, inv, error: null, stillPresent, shortReadConsistency };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function raceSummaryLine(result) {
  const residue = result.residueObserved.length === 0 ? 'none' : result.residueObserved.join(',');
  const invClosed = result.invariants.available ? String(result.invariants.closed) : `n/a(status=${result.info.status})`;
  return `RACE ${result.race} (${result.kind}): overlap_proven=${result.overlap ? 'yes' : 'no'}`
    + ` | files ${result.before.files} -> ${result.after.files}`
    + ` | lines ${result.before.lines} -> ${result.after.lines}`
    + ` | residue_observed=${residue}`
    + ` | invariants_closed=${invClosed}`
    + ` | reader=${result.info.status}/${result.info.reasonCode}`
    + ` | verdict=${result.verdict}`;
}

async function main() {
  fs.mkdirSync(RACE_A_STORE, { recursive: true });
  fs.mkdirSync(RACE_B_STORE, { recursive: true });
  const ledgerFactory = (options) => new InvocationLedger(options);

  const resultA = await raceA(ledgerFactory);
  const controlA = await controlPass('A', RACE_A_STORE, path.join(TMP_ROOT, 'control-a.json'));
  const resultB = await raceB(ledgerFactory);
  const controlB = await controlPass('B', RACE_B_STORE, path.join(TMP_ROOT, 'control-b.json'));

  log('');
  log('================================================================================');
  log('SUMMARY');
  log('================================================================================');
  log(raceSummaryLine(resultA));
  log(raceSummaryLine(resultB));
  log('');
  log('RACE A detail:');
  log(`  appended frames landing inside the pass process lifetime: ${resultA.appendsInsideLifetime}/${resultA.appends.length}`);
  for (const r of resultA.targetRows) {
    log(`  ${r.file}: ${r.appendCount} append(s) at +${r.appendWindowMs[0]}..+${r.appendWindowMs[1]}ms ->`
      + ` reader consistency=${r.censusEntry === null ? 'absent from census' : r.censusEntry.consistency}`
      + ` residue=${r.impliedClass === null ? 'none' : r.impliedClass}`);
  }
  log(`  rename probe ${resultA.vanishedTarget} -> consistency=${resultA.vanishedCensusEntry === null ? 'n/a' : resultA.vanishedCensusEntry.consistency}`);
  log(`  consistency vs histogram cross-check: ${JSON.stringify(resultA.xcheck)}`);
  log(`  artifacts: store=${resultA.storeDir} json=${resultA.jsonFile} outcome=${JSON.stringify(resultA.outcome)}`);
  log('');
  log('RACE B detail:');
  log(`  B1 auto-compaction (default threshold 200, no explicit call): observed=${resultB.auto.autoCompactionObserved ? 'yes' : 'no'}`
    + ` lines=${resultB.auto.linesNow}/${resultB.auto.expectedLinesWithoutCompaction}`
    + ` tmpArtifacts=${JSON.stringify(resultB.auto.tmpArtifacts)}`
    + ` timelineShrinks=${JSON.stringify(resultB.auto.timelineShrinks)}`);
  log(`  B1 getStats: before=${JSON.stringify(resultB.auto.statsBefore)} after=${JSON.stringify(resultB.auto.statsAfter)}`);
  log(`  B2 explicit compactPartition() calls: ${resultB.rawTargets.flatMap((t) => t.waves).length}`
    + ` with a line-count collapse: ${resultB.rawTargets.flatMap((t) => t.waves).filter((w) => w.linesAfter < w.linesBefore).length}`
    + ` errors: ${JSON.stringify(resultB.rawTargets.flatMap((t) => t.waves).map((w) => w.err))}`);
  log(`  B2 replacement events on the tracked partition names inside the pass: ${JSON.stringify(resultB.replacementEvents.slice(0, 8))}`);
  for (const r of resultB.targets) {
    log(`  ${r.name}: seeded ${r.preLines} lines/${r.preSize} B -> final ${r.postLines} lines/${r.postSize} B;`
      + ` reader consistency=${r.censusEntry === null ? 'absent from census' : r.censusEntry.consistency}`
      + ` residue=${r.impliedClass === null ? 'none' : r.impliedClass}`);
  }
  log(`  tmp artifacts observed (${resultB.tmpAll.length}): ${JSON.stringify(resultB.tmpAll)}`);
  log(`  fs.watch temp events (${resultB.tmpWatchEvents.length}): ${JSON.stringify(resultB.tmpWatchEvents.slice(0, 8))}`);
  log(`  leftover tmp files after the pass: ${JSON.stringify(resultB.leftoverTmp)}`);
  log(`  consistency vs histogram cross-check: ${JSON.stringify(resultB.xcheck)}`);
  log(`  compaction really occurred (temp artifact or line collapse, plus the ledger's own stats): ${resultB.compactionProven ? 'yes' : 'no'}`);
  log(`  artifacts: store=${resultB.storeDir} json=${resultB.jsonFile} outcome=${JSON.stringify(resultB.outcome)}`);
  log('');
  log('');
  log(`live store post-check (read-only): files=${fs.readdirSync(LIVE_STORE).length}`
    + ` tmp-artifacts=${JSON.stringify(fs.readdirSync(LIVE_STORE).filter((n) => n.includes('.tmp-')))}`
    + ` probe-named=${JSON.stringify(fs.readdirSync(LIVE_STORE).filter((n) => n.includes('probe-')))}`);
  log(`note: copy A bytes=${resultA.copied.bytes}, copy B bytes=${resultB.copied.bytes}; a difference is the`
    + ` running application writing to the source store between the two copies, not this probe.`);
  log(`CONTROL A (same directory, nothing mutating): status=${controlA.info === null ? 'unparseable' : `${controlA.info.status}/${controlA.info.reasonCode}`}`
    + ` race-classes-still-present=${JSON.stringify(controlA.stillPresent)} non-clean-consistencies=${JSON.stringify(controlA.shortReadConsistency)}`
    + ` residue=${JSON.stringify(controlA.info === null ? null : controlA.info.residue)}`);
  log(`CONTROL B (same directory, nothing mutating): status=${controlB.info === null ? 'unparseable' : `${controlB.info.status}/${controlB.info.reasonCode}`}`
    + ` race-classes-still-present=${JSON.stringify(controlB.stillPresent)} non-clean-consistencies=${JSON.stringify(controlB.shortReadConsistency)}`
    + ` residue=${JSON.stringify(controlB.info === null ? null : controlB.info.residue)}`);
  log(`live store untouched: source=${LIVE_STORE} (opened read-only for the copy; every mutation above is under ${TMP_ROOT})`);
  log(`# finished: ${new Date().toISOString()}`);
  fs.closeSync(transcriptFd);
  return { resultA, resultB, controlA, controlB };
}

main().then(
  () => { process.exitCode = 0; },
  (err) => {
    try {
      log('');
      log(`FATAL: ${err && err.stack ? err.stack : String(err)}`);
      log(`# finished (with failure): ${new Date().toISOString()}`);
      fs.closeSync(transcriptFd);
    } catch { /* transcript already closed */ }
    process.exitCode = 1;
  },
);
