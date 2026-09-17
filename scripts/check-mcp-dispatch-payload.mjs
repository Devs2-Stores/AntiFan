#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — MCP dispatch payload gate (source-only).
 *
 * This gate pins the SHAPE of the MCP dispatch accounting payload at build time.
 * It is deliberately source-only: its entire input is a set of committed fixture
 * JSON documents plus this file's own committed location. It never reads a
 * runtime store, never reads an environment variable, and never resolves a
 * relative path against the current working directory — the default fixture root
 * is derived from this file's own URL, and a relative `--fixture` is resolved
 * against this file's directory. That property is load-bearing: `npm run compile`
 * sits on the launch path (main.cjs runs it and exits 1 on failure), so a gate
 * whose verdict depended on machine state could refuse to start the app on a
 * dirty or absent store.
 *
 * Rules (frozen by phase-06-gates-docs-and-followup.md; each has a fixture that
 * must fail it, committed under `seeded/`):
 *
 *   1. Allowlist    — the payload's key set is a subset of the frozen aggregate
 *                     allowlist, the same one every row and every per-file
 *                     roll-up must obey.
 *   2. No passthrough — no identity/authority/frame field of a persisted
 *                     invocation record appears anywhere in the payload.
 *   3. No location  — no payload string, and no payload KEY, is an absolute path
 *                     or an http(s) URL. Keys carry writer-supplied text (the
 *                     `errors` histogram is keyed by `frame.error.code`), so a
 *                     value-only walk would miss the leak entirely.
 *   4. UNMEASURED   — the empty-store fixture must assert `status UNMEASURED`,
 *                     `totals: null`, `rows: []`, and then every comparison rule
 *                     is SKIPPED for it. A gate that fails on absence (an
 *                     unguarded `null === null`) is worse than no gate.
 *   5. (self-check) — a unit test greps THIS file for store tokens and for any
 *                     filesystem read outside the fixture directory.
 *
 * Usage: node scripts/check-mcp-dispatch-payload.mjs [--fixture <dir>] [--quiet]
 * Exit : 0 all rules hold; 1 a rule fired; 2 malformed argv.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(GATE_DIR, '..');
const DEFAULT_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'mcp-dispatch-payload');

/** Frozen aggregate allowlist (phase-01 §9 envelope + phase-03 row key set). */
const TOP_LEVEL_ALLOWLIST = [
  'status',
  'reasonCode',
  'affected',
  'evidenceRefs',
  'asOf',
  'storePath',
  'census',
  'fileRollups',
  'rows',
  'totals',
  'reconciliation',
];

/** Frozen per-row key set — exactly the aggregate Phase 3 finalizes. */
const ROW_ALLOWLIST = [
  'name',
  'calls',
  'frames',
  'superseded',
  'states',
  'errors',
  'latency',
  'excludedLatency',
  'firstSeen',
  'lastSeen',
  'lowerBound',
];

/** Frozen per-file roll-up (Phase 1) — file NAMES only, never an absolute path. */
const FILE_ROLLUP_ALLOWLIST = ['file', 'quarantineLike', 'tempLike', 'frames', 'admitted', 'namedInvalid'];

/**
 * The frame/authority identifier list constraint D names. Every one of these is
 * a persisted invocation-record field; none may cross the projection boundary.
 * `evidenceRefs` is a different key and stays legal — the comparison below is on
 * keys, never on substrings, so an allowed key containing a banned word is not a
 * violation and a banned key nested in an allowed container still is.
 */
const FORBIDDEN_KEYS = [
  'runtimeLeaseToken',
  'authoritySnapshot',
  'runtimePid',
  'runId',
  'attemptId',
  'tabId',
  'browserEpoch',
  'revisionNumber',
  'requestId',
  'paramDigest',
  'policyDigest',
  'attachmentId',
  'idempotencyKey',
  'evidence',
];

/** A committed fixture's role decides which extra expectations apply to it. */
const FIXTURE_ROLES = {
  'measured.json': 'measured',
  'ceiling-tripped.json': 'ceiling',
  'budget-expired.json': 'budget',
  'empty-store.json': 'empty-store',
};

const TRUNCATION_ORDER = 'mtimeMs-desc,name-asc';
const ABSOLUTE_SHAPE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const URL_SHAPE = /^https?:\/\//;

const problems = [];
const notes = [];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgv(argv) {
  const options = { fixtureDir: DEFAULT_FIXTURE_DIR, explicitFixture: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--fixture' || arg.startsWith('--fixture=')) {
      const value = arg === '--fixture' ? argv[i + 1] : arg.slice('--fixture='.length);
      if (arg === '--fixture') i += 1;
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--fixture needs a directory argument' };
      }
      // Resolved against THIS repository's root (derived from this file's own
      // location), never against an ambient current working directory.
      options.fixtureDir = path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
      options.explicitFixture = true;
    } else {
      return { error: `unrecognized argument: ${arg}` };
    }
  }
  return options;
}

/** Rule 1 — the payload's key set is a subset of the frozen aggregate allowlist. */
function checkAllowlist(payload, label) {
  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_ALLOWLIST.includes(key)) {
      problems.push(`${label}: top-level key '${key}' is not in the frozen payload allowlist`);
    }
  }
  if (Array.isArray(payload.rows)) {
    payload.rows.forEach((row, index) => {
      if (!isPlainObject(row)) {
        problems.push(`${label}: rows[${index}] is not an object`);
        return;
      }
      for (const key of Object.keys(row)) {
        if (!ROW_ALLOWLIST.includes(key)) {
          problems.push(`${label}: rows[${index}] key '${key}' is not in the frozen row allowlist`);
        }
      }
    });
  }
  if (Array.isArray(payload.fileRollups)) {
    payload.fileRollups.forEach((rollup, index) => {
      if (!isPlainObject(rollup)) {
        problems.push(`${label}: fileRollups[${index}] is not an object`);
        return;
      }
      for (const key of Object.keys(rollup)) {
        if (!FILE_ROLLUP_ALLOWLIST.includes(key)) {
          problems.push(`${label}: fileRollups[${index}] key '${key}' is not in the frozen per-file roll-up allowlist`);
        }
      }
    });
  }
}

/** Rule 2 — no persisted frame, authority or identity field crosses the boundary. */
function checkNoFramePassthrough(value, trail, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkNoFramePassthrough(item, `${trail}[${index}]`, label));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      problems.push(`${label}: forbidden frame field '${key}' present at ${trail}.${key}`);
    }
    checkNoFramePassthrough(child, `${trail}.${key}`, label);
  }
}

/** A property access this trail can name, whether or not the key is an identifier. */
function renderTrailKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * Rule 3 — no string **and no key** is an absolute path or an http(s) URL.
 *
 * Keys are data: the per-name `errors` histogram is keyed by the persisted
 * `frame.error.code`, which is writer-supplied text, so a location can arrive as
 * a key exactly as easily as it can arrive as a value. A value-only walk lets
 * `rows[0].errors = { "C:\\Users\\Admin\\secrets": 2 }` cross the boundary while
 * the gate prints OK, which is the leak this rule exists to catch. The failure
 * trail names the key so an operator can find it in the payload.
 */
function checkNoAbsoluteLocation(value, trail, label) {
  if (typeof value === 'string') {
    if (ABSOLUTE_SHAPE.test(value)) {
      problems.push(`${label}: absolute-path-shaped string at ${trail}: ${JSON.stringify(value)}`);
    } else if (URL_SHAPE.test(value)) {
      problems.push(`${label}: URL-shaped string at ${trail}: ${JSON.stringify(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkNoAbsoluteLocation(item, `${trail}[${index}]`, label));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const keyTrail = `${trail}${renderTrailKey(key)}`;
    if (ABSOLUTE_SHAPE.test(key)) {
      problems.push(`${label}: absolute-path-shaped KEY at ${keyTrail}: ${JSON.stringify(key)}`);
    } else if (URL_SHAPE.test(key)) {
      problems.push(`${label}: URL-shaped KEY at ${keyTrail}: ${JSON.stringify(key)}`);
    }
    checkNoAbsoluteLocation(child, keyTrail, label);
  }
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Rule 4 plus the two bounded-outcome expectations. Returns true when every
 * comparison rule must be skipped for this fixture.
 */
function checkRole(role, payload, label, text) {
  if (role === 'empty-store') {
    if (payload.status !== 'UNMEASURED') {
      problems.push(`${label}: empty store must be status 'UNMEASURED', got ${JSON.stringify(payload.status)}`);
    }
    if (payload.totals !== null) {
      problems.push(`${label}: empty store must carry totals: null, got ${JSON.stringify(payload.totals)}`);
    }
    if (!Array.isArray(payload.rows) || payload.rows.length !== 0) {
      problems.push(`${label}: empty store must carry rows: [], got ${JSON.stringify(payload.rows)}`);
    }
    notes.push(`${label}: empty-store case asserted (UNMEASURED, totals null, rows []); rule 4 skips every comparison rule`);
    return true;
  }

  if (role === 'measured') {
    if (payload.status !== 'MEASURED') {
      problems.push(`${label}: the measured fixture must be status 'MEASURED', got ${JSON.stringify(payload.status)}`);
    }
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
      problems.push(`${label}: the measured fixture must carry at least one row`);
    }
    notes.push(`${label}: measured payload (${Array.isArray(payload.rows) ? payload.rows.length : 0} row(s))`);
    return false;
  }

  if (role === 'ceiling') {
    if (payload.status !== 'MEASURED') {
      problems.push(`${label}: an input ceiling renders rows, so status must be 'MEASURED', got ${JSON.stringify(payload.status)}`);
    }
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
      problems.push(`${label}: an input ceiling must render rows over the files read`);
    } else {
      payload.rows.forEach((row, index) => {
        if (!isPlainObject(row) || row.lowerBound !== true) {
          problems.push(`${label}: rows[${index}].lowerBound must be true for a ceiling-tripped read`);
        }
      });
    }
    const totals = isPlainObject(payload.totals) ? payload.totals : null;
    if (totals === null) {
      problems.push(`${label}: a ceiling-tripped payload must carry totals (totals is ${JSON.stringify(payload.totals)})`);
    }
    const truncation = totals && isPlainObject(totals.truncation) ? totals.truncation : null;
    if (truncation === null) {
      problems.push(`${label}: a ceiling-tripped payload must carry totals.truncation`);
    } else {
      if (truncation.order !== TRUNCATION_ORDER) {
        problems.push(`${label}: totals.truncation.order must be '${TRUNCATION_ORDER}', got ${JSON.stringify(truncation.order)}`);
      }
      if (!isNumber(truncation.filesRead) || !isNumber(truncation.filesSkipped)) {
        problems.push(`${label}: totals.truncation must carry numeric filesRead/filesSkipped`);
      } else {
        const derived = `partial: ${truncation.filesRead} of ${truncation.filesRead + truncation.filesSkipped} files`;
        if (typeof truncation.label === 'string') {
          if (truncation.label !== derived) {
            problems.push(`${label}: totals.truncation.label must read '${derived}', got ${JSON.stringify(truncation.label)}`);
          }
        } else if (!text.includes(derived)) {
          problems.push(`${label}: the payload must disclose '${derived}'`);
        }
      }
    }
    const limits = isPlainObject(payload.census) && isPlainObject(payload.census.limits) ? payload.census.limits : null;
    if (limits === null) {
      problems.push(`${label}: a ceiling-tripped payload must carry census.limits`);
    } else if (!isNumber(limits.windowNewestMtimeMs) || !isNumber(limits.windowOldestMtimeMs)) {
      problems.push(`${label}: census.limits must disclose the covered window (windowNewestMtimeMs/windowOldestMtimeMs)`);
    }
    notes.push(`${label}: ceiling-tripped payload (totals.truncation disclosed, every row lowerBound)`);
    return false;
  }

  if (role === 'budget') {
    if (payload.status !== 'UNMEASURED') {
      problems.push(`${label}: a time-budget expiry is UNMEASURED, got ${JSON.stringify(payload.status)}`);
    }
    if (payload.reasonCode !== 'READ_BUDGET_EXCEEDED') {
      problems.push(`${label}: a time-budget expiry must report READ_BUDGET_EXCEEDED, got ${JSON.stringify(payload.reasonCode)}`);
    }
    if (!Array.isArray(payload.rows) || payload.rows.length !== 0) {
      problems.push(`${label}: a time-budget expiry discards the partial fold, so rows must be [], got ${JSON.stringify(payload.rows)}`);
    }
    if (payload.totals !== null) {
      problems.push(`${label}: a time-budget expiry must carry totals: null, got ${JSON.stringify(payload.totals)}`);
    }
    if (payload.census !== null) {
      problems.push(`${label}: a time-budget expiry must carry census: null, got ${JSON.stringify(payload.census)}`);
    }
    notes.push(`${label}: time-budget expiry asserted (UNMEASURED/READ_BUDGET_EXCEEDED, census null, totals null, rows [])`);
    return false;
  }

  notes.push(`${label}: no declared role — rules 1-3 applied`);
  return false;
}

function main() {
  const options = parseArgv(process.argv.slice(2));
  if (options.error) {
    process.stderr.write(`[mcp-dispatch-payload] ${options.error}\n`);
    process.stderr.write('[mcp-dispatch-payload] usage: node scripts/check-mcp-dispatch-payload.mjs [--fixture <dir>] [--quiet]\n');
    process.exit(2);
  }

  let entries;
  try {
    entries = fs.readdirSync(options.fixtureDir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`[mcp-dispatch-payload] FAIL cannot read the fixture root ${path.relative(REPO_ROOT, options.fixtureDir)}: ${err.message}\n`);
    process.exit(1);
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  if (!options.quiet) {
    process.stdout.write(`[mcp-dispatch-payload] fixture root: ${path.relative(REPO_ROOT, options.fixtureDir) || '.'}\n`);
  }

  if (names.length === 0) {
    problems.push(`no committed fixture found in ${options.fixtureDir}`);
  }

  if (!options.explicitFixture) {
    for (const declared of Object.keys(FIXTURE_ROLES)) {
      if (!names.includes(declared)) {
        problems.push(`committed fixture missing from the default fixture root: ${declared}`);
      }
    }
  }

  for (const name of names) {
    const text = fs.readFileSync(path.join(options.fixtureDir, name), 'utf8');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      problems.push(`${name}: not valid JSON (${err.message})`);
      continue;
    }
    if (!isPlainObject(payload)) {
      problems.push(`${name}: payload must be a JSON object`);
      continue;
    }
    const label = name;
    const role = FIXTURE_ROLES[name] || 'unclassified';
    const skipComparisons = checkRole(role, payload, label, text);
    if (skipComparisons) continue;
    checkAllowlist(payload, label);
    checkNoFramePassthrough(payload, 'payload', label);
    checkNoAbsoluteLocation(payload, 'payload', label);
  }

  for (const note of notes) {
    process.stdout.write(`[mcp-dispatch-payload] ${note}\n`);
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`[mcp-dispatch-payload] FAIL ${problem}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`[mcp-dispatch-payload] OK: ${names.length} payload fixture(s) obey the frozen projection\n`);
}

main();
