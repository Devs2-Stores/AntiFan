#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — MCP dispatch accounting CLI.
 *
 * Proves the accounting reader runs outside Electron, over one injected store
 * directory, with no service, no IPC channel and no renderer. This process is
 * the in-process caller of the reader: it resolves a store, requires the
 * COMPILED diagnostics module, and calls `accountStore` exactly once. It
 * re-implements no reader step — no census, no per-line classification, no fold,
 * no reconciliation — and it never writes inside the store it was handed.
 *
 * Store resolution is `--store` or `ANTIFAN_DATA_ROOT` ONLY:
 *   --store <dir>              the invocation store directory itself
 *   ANTIFAN_DATA_ROOT=<root>   <root>/control-plane-v2/invocations
 * With neither, the run is `UNMEASURED` / `NO_DATA_ROOT_RESOLVED`. There is
 * deliberately no repo-relative, working-directory or `%APPDATA%` ladder: on
 * this machine `E:\Work\apps\AntiFan\.antifan-data` does not exist while the
 * live store is `E:\Work\.antifan-data`, so a plausible-path fallback would
 * silently read the real store while the operator believes `--store` won.
 *
 * stdout contract:
 *   human mode  line 1 is `store: <absolute>` (the CLI is where a location is
 *               permitted — phase-01 §7), then the human summary.
 *   --json mode stdout is the envelope document and NOTHING else, so
 *               `JSON.parse(stdout)` is well defined; the absolute location the
 *               run actually read is carried as the CLI-only `storeAbsolute`
 *               field. The service envelope never carries it (constraint D).
 *
 * `--core-attempts` does not re-implement anything: it delegates to the proxy
 * that owns the store and therefore owns its reader
 * (`scripts/antifan-omp-mcp.cjs --core-attempts [--json] [--dir <dir>]`) by
 * spawning it with the current interpreter, streaming its stdout/stderr
 * unchanged and propagating its exit code. Two readers over one store with two
 * schemas would be a second source of truth.
 *
 * Exit codes: 0 once a well-formed envelope was printed (`MEASURED` or
 * `UNMEASURED` — the status is data, not a failure), 2 for malformed argv or a
 * refused flag combination, 1 when the delegated reader could not be spawned or
 * did not exit normally.
 *
 * Usage: node scripts/antifan-mcp-dispatch-account.cjs [--store <dir>] [--as-of <iso>]
 *          [--json] [--no-memo] [--freeze] [--core-attempts] [--dir <dir>]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ACCOUNTING_MODULE_PATH = path.join(ROOT, '.compiled', 'src', 'main', 'diagnostics', 'mcp-dispatch-accounting.js');
const PROXY_MODULE_PATH = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const STORE_SUFFIX = ['control-plane-v2', 'invocations'];
// The proxy attempt store under the same data root: the bridge mints
// `<dataRoot>/telemetry/core-attempts` into the launcher's child environment.
const CORE_ATTEMPT_SUFFIX = ['telemetry', 'core-attempts'];
const STORE_LABEL = STORE_SUFFIX.join('/');
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ARGV = 2;
const LOG = '[accounting:mcp-dispatch]';

const USAGE = [
  `usage: node scripts/antifan-mcp-dispatch-account.cjs [options]`,
  '',
  '  --store <dir>     invocation store directory',
  `                    (default: ANTIFAN_DATA_ROOT + ${STORE_LABEL})`,
  '  --as-of <iso>     instant the payload describes (default: now; ledger section only)',
  '  --json            print the envelope as JSON (stdout is the JSON document only,',
  '                    with the absolute read location in the CLI-only `storeAbsolute`)',
  '  --no-memo         state a cold read explicitly (the CLI never memoises)',
  '  --freeze          read a point-in-time copy under the OS temp directory (ledger only)',
  '  --core-attempts   delegate to the proxy attempt-store reader',
  '                    (scripts/antifan-omp-mcp.cjs --core-attempts)',
  `  --dir <dir>       explicit proxy attempt store for --core-attempts`,
  `                    (default: the same data root + ${CORE_ATTEMPT_SUFFIX.join('/')})`,
].join('\n');

/** Parse argv. Returns `{ error }` for anything the frozen flag list does not name. */
function parseArgv(argv) {
  const options = { store: null, asOf: null, json: false, noMemo: false, freeze: false, coreAttempts: false, coreDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--store' || arg.startsWith('--store=')) {
      const inline = arg.startsWith('--store=') ? arg.slice('--store='.length) : null;
      const value = inline === null ? argv[i + 1] : inline;
      if (inline === null) i += 1;
      if (typeof value !== 'string' || value.trim() === '') return { error: '--store needs a directory argument' };
      options.store = value;
      continue;
    }
    if (arg === '--as-of' || arg.startsWith('--as-of=')) {
      const inline = arg.startsWith('--as-of=') ? arg.slice('--as-of='.length) : null;
      const value = inline === null ? argv[i + 1] : inline;
      if (inline === null) i += 1;
      if (typeof value !== 'string' || value.trim() === '') return { error: '--as-of needs an ISO-8601 instant' };
      if (Number.isNaN(Date.parse(value))) return { error: `--as-of is not a parseable instant: ${value}` };
      options.asOf = value;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--no-memo') {
      options.noMemo = true;
      continue;
    }
    if (arg === '--freeze') {
      options.freeze = true;
      continue;
    }
    if (arg === '--core-attempts') {
      options.coreAttempts = true;
      continue;
    }
    if (arg === '--dir' || arg.startsWith('--dir=')) {
      const inline = arg.startsWith('--dir=') ? arg.slice('--dir='.length) : null;
      const value = inline === null ? argv[i + 1] : inline;
      if (inline === null) i += 1;
      if (typeof value !== 'string' || value.trim() === '') return { error: '--dir needs a directory argument' };
      options.coreDir = value;
      continue;
    }
    return { error: `unrecognized argument: ${arg}` };
  }
  return options;
}

/**
 * Resolve the store directory from `--store` or `ANTIFAN_DATA_ROOT` only.
 * No existence probe: whether the directory is absent, empty or unreadable is
 * the reader's verdict to publish (`NO_DATA_ROOT_RESOLVED`, `NO_DATA`,
 * `DIR_UNREADABLE`), not something this CLI may pre-empt.
 */
function resolveStore(options) {
  if (options.store !== null) {
    return { dir: path.resolve(options.store), source: '--store' };
  }
  const envRoot = process.env.ANTIFAN_DATA_ROOT;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    return { dir: path.join(path.resolve(envRoot), ...STORE_SUFFIX), source: 'ANTIFAN_DATA_ROOT' };
  }
  return null;
}

/** One envelope shape for every UNMEASURED reason (phase-01 §7). */
function unmeasuredEnvelope(reasonCode, affected, asOf, storePath) {
  return {
    status: 'UNMEASURED',
    reasonCode,
    affected,
    evidenceRefs: [],
    asOf,
    storePath,
    census: null,
    fileRollups: [],
    rows: [],
    totals: null,
    reconciliation: null,
  };
}

/**
 * Copy the resolved store into a fresh directory under the OS temp directory and
 * read the copy, so a determinism proof cannot be perturbed by a live append.
 * The snapshot path is printed (stdout, line 1) because every later comparison
 * run reads that same copy through `--store`.
 */
function freezeStore(storeDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = path.join(os.tmpdir(), `antifan-mcp-dispatch-freeze-${process.pid}-${stamp}`);
  fs.mkdirSync(snapshotDir, { recursive: true });
  let names;
  try {
    names = fs.readdirSync(storeDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (err) {
    return { error: err };
  }
  for (const name of names) {
    fs.copyFileSync(path.join(storeDir, name), path.join(snapshotDir, name));
  }
  return { snapshotDir, copied: names.length };
}

function printStoreLine(storeResolution, extra) {
  if (storeResolution === null) {
    process.stdout.write(`store: unresolved (--store absent, ANTIFAN_DATA_ROOT unset)\n`);
    return;
  }
  process.stdout.write(`store: ${storeResolution.dir}${extra ? `  (${extra})` : ''}\n`);
}

function printHuman(envelope) {
  const lines = [`status: ${envelope.status}`, `reasonCode: ${envelope.reasonCode}`, `asOf: ${envelope.asOf}`];
  lines.push(`storePath: ${envelope.storePath === null ? '(unresolved)' : envelope.storePath}`);
  if (Array.isArray(envelope.affected) && envelope.affected.length > 0) {
    lines.push(`affected: ${envelope.affected.join(', ')}`);
  }
  const reconciliation = envelope.reconciliation;
  if (reconciliation && Array.isArray(reconciliation.lines)) {
    for (const line of reconciliation.lines) lines.push(line);
  }
  const totals = envelope.totals;
  if (totals && totals.quarantineMargin && typeof totals.quarantineMargin.label === 'string') {
    lines.push(totals.quarantineMargin.label);
  }
  if (totals && totals.truncation && typeof totals.truncation === 'object') {
    const { filesRead, filesSkipped } = totals.truncation;
    lines.push(`partial: ${filesRead} of ${filesRead + filesSkipped} files`);
  }
  const rows = Array.isArray(envelope.rows) ? envelope.rows : [];
  lines.push(`rows: ${rows.length}`);
  for (const row of rows) {
    const states = row.states && typeof row.states === 'object'
      ? Object.entries(row.states).map(([state, count]) => `${state}:${count}`).join(',')
      : 'UNMEASURED';
    const errors = row.errors && typeof row.errors === 'object' && Object.keys(row.errors).length > 0
      ? Object.entries(row.errors).map(([code, count]) => `${code}:${count}`).join(',')
      : 'none';
    const latency = row.latency && typeof row.latency === 'object' && row.latency.count > 0
      ? `p50=${row.latency.p50Ms}ms p95=${row.latency.p95Ms}ms (n=${row.latency.count})`
      : 'UNMEASURED';
    lines.push(`  ${row.name}  calls=${row.calls} frames=${row.frames} superseded=${row.superseded} states=[${states}] errors=[${errors}] latency=${latency}${row.lowerBound ? '  lowerBound' : ''}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * The separator-free display label of a store directory — the final path
 * segment only, or `null` when there is no path or the final segment is a drive
 * root.
 *
 * The rule is owned by the reader module (`storeDisplayLabel`,
 * `src/main/diagnostics/mcp-dispatch-accounting.ts`), which this CLI uses
 * whenever it can load it. This local copy exists for exactly one reason: the
 * `SERVICE_FAILED` and `DIR_UNREADABLE` envelopes are synthesized on the paths
 * where that module could not be required (or the read could not happen), so the
 * branch that must label a store is the branch where the owner is unavailable.
 * It is kept byte-equivalent to the owner, drive-root guard included: a drive
 * root (`Q:\`, `Q:/`) has a final segment that *is* a drive letter, and
 * phase-01's hard rule bans a drive letter exactly as it bans a separator, so the
 * label is absent rather than `Q:`. That guard is the divergence this comment
 * used to claim without having it.
 */
function fallbackStoreDisplayLabel(dir) {
  if (typeof dir !== 'string' || dir.trim().length === 0) return null;
  const trimmed = dir.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return null;
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  if (typeof last !== 'string' || last.length === 0) return null;
  return /^[A-Za-z]:$/.test(last) ? null : last;
}

/** The module's label rule once the module is loadable; the guarded copy until then. */
let moduleStoreDisplayLabel = null;

function storeLabelFor(dir) {
  return (moduleStoreDisplayLabel || fallbackStoreDisplayLabel)(dir);
}

/** Print the envelope.
 *
 * `--json` writes one JSON document and NOTHING else, so `JSON.parse(stdout)` is
 * well defined. The document carries two things and never smears them together:
 * `storeAbsolute` is the CLI-only absolute location (a CLI is where an absolute
 * location is permitted, phase-01 §7 — the service envelope never carries one),
 * and `payload` is exactly the envelope the renderer boundary would carry, so the
 * frozen payload gate can be run over `payload` unchanged. Consumers must read
 * `.payload`; the flat document this replaced put a key the project's own gate
 * rejects *inside* the payload it was meant to validate.
 */
function emit(envelope, options, storeAbsolute) {
  if (options.json) {
    const document = {
      storeAbsolute: storeAbsolute === undefined ? null : storeAbsolute,
      payload: envelope,
    };
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  } else {
    printHuman(envelope);
  }
}

/** The ledger section: the reader over the control-plane invocation store. */
async function runLedgerSection(options, storeResolution) {
  const asOf = options.asOf !== null ? options.asOf : new Date().toISOString();

  if (storeResolution === null) {
    // The envelope carries no path (there is none to carry); the CLI discloses
    // what it tried on stdout, because the CLI is where a location is allowed.
    // Token strings in this file are spelled out rather than read from the compiled `AffectedToken`
    // enum, because every branch below must still work when that module cannot be loaded (the
    // SERVICE_FAILED envelopes are exactly those paths). The canonical source is
    // `src/shared/mcp-dispatch-contracts.ts`; `'no-data-root-resolved'` is the member this branch
    // needs — the earlier `'unresolved-data-root'` was a stale name that no member produces, which
    // meant the CLI and the module labelled the same mechanism two different ways.
    if (!options.json) printStoreLine(null, null);
    emit(unmeasuredEnvelope('NO_DATA_ROOT_RESOLVED', ['no-data-root-resolved'], asOf, null), options, null);
    return EXIT_OK;
  }

  const memoFlag = options.noMemo ? 'memo=off (--no-memo)' : 'memo=off (default)';
  let readDir = storeResolution.dir;
  let humanStoreLine = storeResolution.dir;

  if (options.freeze) {
    const frozen = freezeStore(storeResolution.dir);
    if (frozen.error) {
      if (!options.json) printStoreLine(storeResolution, memoFlag);
      process.stderr.write(`${LOG} FAIL cannot freeze ${storeResolution.dir}: ${frozen.error.message}\n`);
      // Nothing was read, so no absolute read location exists to disclose.
      emit(unmeasuredEnvelope('DIR_UNREADABLE', ['dir-unreadable'], asOf, storeLabelFor(readDir)), options, null);
      return EXIT_OK;
    }
    readDir = frozen.snapshotDir;
    humanStoreLine = `${frozen.snapshotDir} (frozen copy of ${storeResolution.dir}, ${frozen.copied} file(s))`;
  }

  if (!options.json) process.stdout.write(`store: ${humanStoreLine}  (${memoFlag})\n`);

  let accounting;
  try {
    accounting = require(ACCOUNTING_MODULE_PATH);
  } catch (err) {
    const relative = path.relative(ROOT, ACCOUNTING_MODULE_PATH).replace(/\\/g, '/');
    process.stderr.write(`${LOG} FAIL cannot require the compiled reader ${relative}: ${err.message}\n`);
    emit(unmeasuredEnvelope('SERVICE_FAILED', ['service-failed'], asOf, storeLabelFor(readDir)), options, readDir);
    return EXIT_OK;
  }

  // The module owns the label rule; the local copy above covers only the branches
  // that run when this require fails.
  if (typeof accounting.storeDisplayLabel === 'function') {
    moduleStoreDisplayLabel = accounting.storeDisplayLabel;
  }

  if (typeof accounting.accountStore !== 'function') {
    process.stderr.write(`${LOG} FAIL the compiled reader does not export accountStore\n`);
    emit(unmeasuredEnvelope('SERVICE_FAILED', ['service-failed'], asOf, storeLabelFor(readDir)), options, readDir);
    return EXIT_OK;
  }

  let envelope;
  try {
    envelope = await accounting.accountStore({ storeDir: readDir, asOf, memo: false, mode: 'in-process' });
  } catch (err) {
    process.stderr.write(`${LOG} FAIL accountStore threw: ${err && err.message ? err.message : String(err)}\n`);
    emit(unmeasuredEnvelope('SERVICE_FAILED', ['service-failed'], asOf, storeLabelFor(readDir)), options, readDir);
    return EXIT_OK;
  }

  if (envelope === null || typeof envelope !== 'object' || typeof envelope.status !== 'string') {
    process.stderr.write(`${LOG} FAIL accountStore returned no envelope\n`);
    emit(unmeasuredEnvelope('SERVICE_FAILED', ['service-failed'], asOf, storeLabelFor(readDir)), options, readDir);
    return EXIT_OK;
  }

  emit(envelope, options, readDir);
  return EXIT_OK;
}

/**
 * Which directory the delegated proxy reader should be pointed at.
 *
 * The invocation store this CLI resolves is NOT the attempt store: the bridge
 * mints `<dataRoot>/telemetry/core-attempts` into the launcher's child
 * environment (`proxyTelemetryDir` in the `antifan.cli.startSession` response,
 * `src/main/bridge/bridge-server.ts`). Forwarding the resolved invocation
 * directory verbatim would point the reader at the partitions it already knows
 * how to read and have it parse them as attempt records, so the sibling is
 * derived arithmetically from the resolved directory's own suffix — never from a
 * plausible-path ladder — and `--dir` overrides it outright. With no root
 * resolved at all the proxy applies its own documented rule
 * (`ANTIFAN_PROXY_TELEMETRY_DIR`) instead of a guess made here.
 */
function resolveCoreAttemptDir(options, storeResolution) {
  if (options.coreDir !== null) return path.resolve(options.coreDir);
  if (storeResolution === null) return null;
  const parts = storeResolution.dir.split(path.sep);
  if (parts.length <= STORE_SUFFIX.length) return null;
  const tail = parts.slice(parts.length - STORE_SUFFIX.length);
  if (tail.some((segment, index) => segment !== STORE_SUFFIX[index])) return null;
  const root = parts.slice(0, parts.length - STORE_SUFFIX.length).join(path.sep);
  if (root === '') return null;
  return path.join(root, ...CORE_ATTEMPT_SUFFIX);
}

/**
 * The core-attempts section: a facade, not a reader.
 *
 * The proxy owns the attempt store, so the proxy owns its reader and its
 * schema. This spawns that reader with the current interpreter (no shell, no
 * string interpolation), streams its stdout/stderr through unchanged and
 * propagates its exit code, so there is exactly one implementation of the
 * attempt-store contract in the tree.
 */
function runCoreAttemptsSection(options, storeResolution) {
  const dir = resolveCoreAttemptDir(options, storeResolution);
  const args = [PROXY_MODULE_PATH, '--core-attempts'];
  if (dir !== null) args.push('--dir', dir);
  if (options.json) args.push('--json');

  const relativeProxy = path.relative(ROOT, PROXY_MODULE_PATH).replace(/\\/g, '/');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`${LOG} FAIL cannot spawn the proxy attempt reader ${relativeProxy}: ${result.error.message}\n`);
    return EXIT_FAIL;
  }
  if (typeof result.status === 'number') return result.status;
  process.stderr.write(`${LOG} FAIL the delegated reader ${relativeProxy} did not exit normally (signal ${result.signal})\n`);
  return EXIT_FAIL;
}

/** Section table: the ledger reader here, the attempt-store reader in the proxy. */
const SECTIONS = {
  ledger: { name: 'ledger', run: runLedgerSection },
  'core-attempts': { name: 'core-attempts', run: runCoreAttemptsSection },
};

async function main(argv) {
  const options = parseArgv(argv);
  if (options.error) {
    process.stderr.write(`${LOG} ${options.error}\n${USAGE}\n`);
    return EXIT_ARGV;
  }

  if (options.coreAttempts) {
    // The proxy reader takes neither of these, and silently dropping a flag
    // would let the operator believe it pinned the read.
    if (options.freeze) {
      process.stderr.write(`${LOG} --freeze applies to the ledger section; the core-attempts store is read in place by the proxy\n${USAGE}\n`);
      return EXIT_ARGV;
    }
    if (options.asOf !== null) {
      process.stderr.write(`${LOG} --as-of does not apply to the core-attempts section; the proxy reader reports its own store state\n${USAGE}\n`);
      return EXIT_ARGV;
    }
  } else if (options.coreDir !== null) {
    process.stderr.write(`${LOG} --dir only applies to --core-attempts\n${USAGE}\n`);
    return EXIT_ARGV;
  }

  const sectionName = options.coreAttempts ? 'core-attempts' : 'ledger';
  const section = SECTIONS[sectionName];
  if (!section) {
    process.stderr.write(`${LOG} section '${sectionName}' has no reader in this revision\n`);
    return EXIT_ARGV;
  }

  return section.run(options, resolveStore(options));
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${LOG} FAIL unexpected: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
);
