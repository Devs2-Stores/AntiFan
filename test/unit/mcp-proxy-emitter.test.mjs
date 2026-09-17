// mcp-proxy-emitter.test.mjs — Phase 5 (`core.*` proxy attempt store).
//
// The wrap point under test is `scripts/antifan-omp-mcp.cjs` inside `invoke()`:
// a `core.*` call returns in-process before invocation identity is minted, so
// the control-plane ledger has zero `core.*` frames. Phase 5 records them in a
// separate bounded store (provenance `omp-proxy`, unit `proxy-attempt`).
//
// What this file deliberately does NOT do:
//   * it never starts the app, never reaches the bridge, and never calls a real
//     `core.*` capability against a real store;
//   * it never runs the compile chain (`npm run compile`) or a `test:*` lane.
//
// The phase's P1/P2 fixtures are "stubbed `invokeCore` resolves / rejects".
// `invokeCore` is a module-private closure that this file may not modify, so the
// stub is installed at the boundary the proxy itself resolves —
// `getCore()` → `require('../packages/super-core/dist/index.js').openCore` — via
// a `require.cache` entry. No proxy source is patched and no SQLite file is
// created; `SUPER_CORE_DB` is additionally pinned to `:memory:` so even a
// missed seam could not write a repo-relative database. The rejection carries a
// real `.code`, which is what proves the emitter reads the PROPAGATED code.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const BUDGET_GATE = path.join(ROOT, 'scripts', 'check-mcp-budget-dominance.mjs');
const SUPER_CORE_DIST = path.join(ROOT, 'packages', 'super-core', 'dist', 'index.js');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proxy-emitter-'));
after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function makeDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── store double (the seeded `invokeCore`) ─────────────────────────────────
// `query` rejects after a measurable delay: only a record emitted from the
// SETTLED promise can carry a non-zero `durationMs`. A `finally` around the
// un-awaited async call would stamp ~0 ms and claim 'ok'.
const CORE_STORE_DOUBLE = {
  stats: () => ({ counts: { claims: 0, cases: 0 } }),
  query: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const err = new Error('CORE_UNAVAILABLE: seeded store refusal');
    err.code = 'CORE_UNAVAILABLE';
    throw err;
  },
  // invokeCore's REAL refusal shape: the code is serialized into a JSON message
  // body and no `.code` is attached (`scripts/antifan-omp-mcp.cjs` invokeCore).
  // Reproducing it here is what proves the message-parsing step of the
  // derivation, instead of assuming it.
  health: async () => {
    throw new Error(JSON.stringify({ code: 'CAPABILITY_NOT_FOUND', message: 'Super Core store has no method health' }));
  },
  // A rejection carrying no code anywhere: the derived value must degrade to the
  // literal 'ERROR' rather than guessing.
  snapshot: async () => {
    throw new Error('boom');
  },
  // A code longer than the 64-char cap: the derived value must be bounded too.
  // core.fix_patterns declares no required fields, so the call reaches the wrap
  // point (core.record_observation is refused by the pre-dispatch required-field
  // contract first, and a pre-wrap refusal is not an attempt and is not stored).
  fixPatterns: async () => {
    throw new Error(JSON.stringify({ code: `LONG_${'X'.repeat(200)}`, message: 'oversized code' }));
  },
};

function installStoreDouble() {
  require.cache[SUPER_CORE_DIST] = {
    id: SUPER_CORE_DIST,
    filename: SUPER_CORE_DIST,
    loaded: true,
    exports: { openCore: () => CORE_STORE_DOUBLE },
  };
}

// The proxy reads capability policy from the ambient environment. A fixer
// session or a pre-set allow-list in the shell would refuse `core.*` BEFORE the
// wrap point and silently turn this suite into a no-op.
for (const key of [
  'ANTIFAN_FIXER_SESSION',
  'ANTIFAN_ALLOWED_CAPABILITIES',
  'ANTIFAN_ALLOWED_CAPABILITY_NAMES',
  'ANTIFAN_FORBIDDEN_CAPABILITIES',
  'ANTIFAN_FORBIDDEN_CAPABILITY_NAMES',
]) {
  delete process.env[key];
}
process.env.SUPER_CORE_DB = ':memory:';
const MAIN_DIR = makeDir('main');
process.env.ANTIFAN_PROXY_TELEMETRY_DIR = MAIN_DIR;
installStoreDouble();
const proxy = require(PROXY);

// ─── store helpers ──────────────────────────────────────────────────────────
const STORE_FILE = /^core-attempts-.*\.jsonl$/;

function storeRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!STORE_FILE.test(name)) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push({ ...JSON.parse(line), __file: name });
      } catch {
        records.push({ kind: '__unparseable', __file: name, __line: line.slice(0, 40) });
      }
    }
  }
  return records;
}

const attemptsIn = (dir) => storeRecords(dir).filter((record) => record.kind === 'attempt');

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const waitForAttempts = (dir, count) => waitFor(
  () => {
    const found = attemptsIn(dir);
    return found.length >= count ? found : null;
  },
  `${count} attempt record(s) in ${dir}`,
);

function runReader(dir) {
  const args = [PROXY, '--core-attempts', '--json'];
  if (dir) args.push('--dir', dir);
  const env = { ...process.env };
  if (!dir) delete env.ANTIFAN_PROXY_TELEMETRY_DIR;
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(result.status, 0, `reader must exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ─── child drivers (a second pid / an immediate exit) ───────────────────────
// Every child runs from a directory it is told about, writes its pid
// synchronously before it does anything observable, and never touches the
// bridge.
const CHILD_PRELUDE = `
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const DIST = path.join(REPO, 'packages', 'super-core', 'dist', 'index.js');
require.cache[DIST] = {
  id: DIST,
  filename: DIST,
  loaded: true,
  exports: { openCore: () => ({ stats: () => ({ counts: { claims: 0 } }) }) },
};
fs.writeFileSync(process.env.ANTIFAN_TEST_PID_FILE, String(process.pid), 'utf8');
const proxy = require(path.join(REPO, 'scripts', 'antifan-omp-mcp.cjs'));
`;

function runChild(body, { storeDir, cwd, env: extraEnv } = {}) {
  const pidFile = path.join(TMP_ROOT, `pid-${Math.random().toString(16).slice(2)}.txt`);
  const env = { ...process.env, SUPER_CORE_DB: ':memory:', ANTIFAN_TEST_PID_FILE: pidFile, ...(extraEnv || {}) };
  // `null` means "the variable is absent" (Node drops an undefined env value,
  // which would also delete a value the parent had set); a string overrides it;
  // omitting the option inherits the parent's value.
  if (storeDir === null) delete env.ANTIFAN_PROXY_TELEMETRY_DIR;
  else if (typeof storeDir === 'string') env.ANTIFAN_PROXY_TELEMETRY_DIR = storeDir;
  const result = spawnSync(process.execPath, ['-e', `${CHILD_PRELUDE}${body}`], {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    env,
  });
  const childPid = fs.existsSync(pidFile) ? Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10) : null;
  return { result, childPid };
}

// ─── P1: a resolved dispatch ────────────────────────────────────────────────
test('P1: a resolved core.* dispatch records exactly one ok attempt and leaves the caller result untouched', async () => {
  const dir = makeDir('p1');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  const result = await proxy.invoke('core.stats', {});
  assert.deepEqual(result, { counts: { claims: 0, cases: 0 } }, 'the caller result value must be untouched');

  const records = await waitForAttempts(dir, 1);
  assert.equal(records.length, 1, 'one dispatch is one attempt record');
  const [record] = records;
  assert.equal(record.outcome, 'ok');
  assert.equal(record.method, 'core.stats');
  assert.equal(record.requestedAs, 'core.stats');
  assert.equal(record.attemptKind, 'dispatched');
  assert.equal(record.unit, 'proxy-attempt');
  assert.equal(record.provenance, 'omp-proxy');
  assert.equal(record.pid, process.pid);
  assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0, `durationMs must be a number, got ${record.durationMs}`);
  assert.ok(!('errorCode' in record), 'a successful attempt carries no errorCode');
});

// ─── P2: the forced rejection (the finding this phase exists to fix) ────────
test('P2: a forced rejection records outcome error with the propagated errorCode and a real duration', async () => {
  const dir = makeDir('p2');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  const seen = await proxy.invoke('core.query', { text: 'probe' }).then(() => null, (err) => err);
  assert.ok(seen instanceof Error, 'the caller must still observe the rejection');
  assert.equal(seen.code, 'CORE_UNAVAILABLE', 'the caller must still observe the propagated code');

  const [record] = await waitForAttempts(dir, 1);
  assert.equal(record.outcome, 'error', 'an un-awaited finally/catch would have recorded every failure as ok');
  assert.equal(record.errorCode, 'CORE_UNAVAILABLE', 'step (a) of the derivation: an attached Error.code wins');
  assert.equal(record.method, 'core.query');
  assert.equal(record.requestedAs, 'core.query');
  assert.ok(
    record.durationMs > 0,
    `a settled failure must carry the real attempt duration, got ${record.durationMs} (the seeded store refuses after 5 ms)`,
  );
});

// ─── P3: unknown capability reaches the wrap point too ──────────────────────
test('P3: a core.* name with no dispatch entry records attemptKind unknown-capability', async () => {
  const dir = makeDir('p3');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  const seen = await proxy.invoke('core.no_such_capability', {}).then(() => null, (err) => err);
  assert.ok(seen instanceof Error, 'an unknown core.* capability must still reject for the caller');

  const [record] = await waitForAttempts(dir, 1);
  assert.equal(record.attemptKind, 'unknown-capability');
  assert.equal(record.outcome, 'error');
  // invokeCore refuses an unmapped core.* name with `unknown core capability: …`
  // — a plain, non-JSON message. Step (b) cannot read a code out of it, so the
  // record reads the literal fallback 'ERROR' = "no code derivable". This is the
  // proven fallback path, not a pinned defect.
  assert.equal(record.errorCode, 'ERROR');
});

// ─── C4 on the REAL refusal path (no seeded store double) ───────────────────
// The defect C4 fixes, proven where it actually occurs: invokeCore serializes its
// refusal code into the message and attaches no `.code` — test/unit/
// mcp-core-parity.test.mjs:218 has to JSON.parse the message to see it. Under the
// literal rule the record read 'ERROR'; under the derivation it must read the
// real code. No store double here: the DB path is unopenable, so the refusal is
// the real one.
test('C4 applies to the real invokeCore refusal, not only to the seeded double', () => {
  const dir = makeDir('c4-real');
  const script = `
const proxy = require(${JSON.stringify(PROXY)});
(async () => {
  const err = await proxy.invoke('core.record_regression', { newKnowledge: 'c4-real' }).then(() => null, (e) => e);
  console.log(JSON.stringify({ attachedCode: err && err.code === undefined ? null : String(err && err.code), message: err && err.message }));
})();
`;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SUPER_CORE_DB: path.join(ROOT, 'package.json', 'core.db'), ANTIFAN_PROXY_TELEMETRY_DIR: dir },
  });
  assert.equal(child.status, 0, `probe failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  const observed = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(observed.attachedCode, null, 'the real refusal attaches no Error.code: this is why the message must be read');
  assert.equal(JSON.parse(observed.message).code, 'CORE_UNAVAILABLE');

  const record = storeRecords(dir).find((entry) => entry.kind === 'attempt');
  assert.ok(record, 'the real refusal must still produce an attempt record');
  assert.equal(record.outcome, 'error');
  assert.equal(record.errorCode, 'CORE_UNAVAILABLE', 'the histogram must show the real code, never a content-free ERROR');
});

// ─── C4: the histogram must not collapse into one content-free ERROR bucket ─
test('C4: errorCode is derived from the JSON message body, and degrades to ERROR only when no code exists', async () => {
  const jsonDir = makeDir('c4-json');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = jsonDir;
  const jsonErr = await proxy.invoke('core.health', {}).then(() => null, (err) => err);
  assert.ok(jsonErr instanceof Error, 'the caller still observes the rejection');
  assert.equal(jsonErr.code, undefined, 'the seeded rejection must attach no Error.code: step (b) is under test');
  const [jsonRecord] = await waitForAttempts(jsonDir, 1);
  assert.equal(jsonRecord.outcome, 'error');
  assert.equal(
    jsonRecord.errorCode,
    'CAPABILITY_NOT_FOUND',
    'the code the refuser serialized into its message must reach the histogram',
  );

  const plainDir = makeDir('c4-plain');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = plainDir;
  const plainErr = await proxy.invoke('core.snapshot', { note: 'c4' }).then(() => null, (err) => err);
  assert.ok(plainErr instanceof Error);
  assert.equal(plainErr.message, 'boom', 'the caller error object must be untouched');
  const [plainRecord] = await waitForAttempts(plainDir, 1);
  assert.equal(plainRecord.errorCode, 'ERROR', 'a non-JSON message must fall back to ERROR, never to a guess');

  const longDir = makeDir('c4-long');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = longDir;
  await proxy.invoke('core.fix_patterns', {}).then(() => null, (err) => err);
  const [longRecord] = await waitForAttempts(longDir, 1);
  assert.equal(longRecord.errorCode.length, 64, 'a derived code obeys the same 64-char cap as an attached one');
  assert.ok(longRecord.errorCode.startsWith('LONG_XXX'), `unexpected derived code ${longRecord.errorCode}`);
});

// ─── P4: an unboundable caller name is refused, never truncated ─────────────
test('P4: an oversized method is refused and counted, never truncated into a record', async () => {
  const dir = makeDir('p4');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  const oversized = `core.${'x'.repeat(50000)}`;
  const seen = await proxy.invoke(oversized, {}).then(() => null, (err) => err);
  assert.ok(seen instanceof Error, 'an oversized capability name must still reject for the caller');

  const records = await waitFor(
    () => {
      const found = storeRecords(dir).filter((record) => record.kind === 'refusal');
      return found.length >= 1 ? storeRecords(dir) : null;
    },
    'a refusal record',
  );
  assert.equal(records.filter((record) => record.kind === 'attempt').length, 0, 'a refused attempt must not be written');
  const [refusal] = records.filter((record) => record.kind === 'refusal');
  assert.equal(refusal.reason, 'METHOD_NOT_BOUNDABLE');
  assert.equal(refusal.unit, 'proxy-attempt');
  assert.ok(
    !records.some((record) => JSON.stringify(record).includes('x'.repeat(200))),
    'no fragment of the oversized caller name may reach the store',
  );
  for (const name of fs.readdirSync(dir)) {
    const size = fs.statSync(path.join(dir, name)).size;
    assert.ok(size <= 4096, `${name} grew past the record budget (${size} bytes)`);
  }
});

// ─── P6: the retained-file ring ─────────────────────────────────────────────
test('P6: rotation keeps at most the retained ring and never prunes another pid active file', async () => {
  const dir = makeDir('p6');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  const active = path.join(dir, `core-attempts-${process.pid}.jsonl`);
  // Push the active file past the declared 256 KiB cap so the next append rotates.
  fs.writeFileSync(active, 'x'.repeat(300 * 1024), 'utf8');
  const otherPidActive = path.join(dir, 'core-attempts-999999.jsonl');
  fs.writeFileSync(otherPidActive, '{"kind":"header","schema":1,"pid":999999}\n', 'utf8');

  const preexisting = [];
  for (let i = 1; i <= 7; i += 1) {
    const name = `core-attempts-${process.pid}.2026-09-0${i}T00-00-00-000Z.jsonl`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, '{"kind":"header","schema":1}\n', 'utf8');
    const ageMs = i * 3600_000; // i=1 newest of the pre-created set, i=7 oldest
    fs.utimesSync(full, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    preexisting.push(name);
  }

  await proxy.invoke('core.stats', {});
  await waitForAttempts(dir, 1);
  await waitFor(
    () => fs.readdirSync(dir).filter((name) => /^core-attempts-\d+\..+\.jsonl$/.test(name)).length <= 5,
    'the rotation ring to be enforced',
  );

  const rotated = fs.readdirSync(dir).filter((name) => /^core-attempts-\d+\..+\.jsonl$/.test(name));
  assert.equal(rotated.length, 5, `the ring is the only bound on file count; saw ${rotated.length}`);
  assert.ok(fs.existsSync(otherPidActive), "another pid's ACTIVE file must never be pruned as a rotation slot");
  for (const name of preexisting.slice(4)) {
    assert.ok(!fs.existsSync(path.join(dir, name)), `${name} is among the oldest and must be pruned`);
  }
  for (const name of preexisting.slice(0, 4)) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} is newer than the ring and must survive`);
  }
});

// ─── the env knobs are bounded tuning, never an off switch ──────────────────
// `coreAttemptLimits()` caches per process, so this must run in a child with the
// knobs already set. Behaviour is the proof: a garbage byte cap that became NaN
// would make `size + bytes > cap` false and rotation would never happen; a
// retained count of 0 that was not clamped would let the rotated set grow.
const KNOB_CHILD = `
const dir = process.env.ANTIFAN_PROXY_TELEMETRY_DIR;
const active = path.join(dir, 'core-attempts-' + process.pid + '.jsonl');
fs.writeFileSync(active, 'x'.repeat(300 * 1024), 'utf8');
for (let i = 1; i <= 7; i += 1) {
  const full = path.join(dir, 'core-attempts-' + process.pid + '.seeded-' + i + '.jsonl');
  fs.writeFileSync(full, '{"kind":"header","schema":1}\\n', 'utf8');
  const age = i * 3600_000;
  fs.utimesSync(full, new Date(Date.now() - age), new Date(Date.now() - age));
}
(async () => {
  await proxy.invoke('core.stats', {});
  await new Promise((resolve) => setTimeout(resolve, 400));
})();
`;

test('the env knobs are clamped: garbage falls back to the default cap/ring and 0 cannot disable the ring', async () => {
  const rotatedIn = (dir) => fs.readdirSync(dir).filter((name) => /^core-attempts-\d+\..+\.jsonl$/.test(name));

  const garbageDir = makeDir('knobs-garbage');
  const garbage = runChild(KNOB_CHILD, {
    storeDir: garbageDir,
    env: {
      ANTIFAN_PROXY_TELEMETRY_MAX_BYTES: 'not-a-number',
      ANTIFAN_PROXY_TELEMETRY_RETAINED_FILES: 'garbage',
    },
  });
  assert.equal(garbage.result.status, 0, `garbage-knob child failed\nstdout:\n${garbage.result.stdout}\nstderr:\n${garbage.result.stderr}`);
  const garbageRotated = rotatedIn(garbageDir);
  assert.ok(
    garbageRotated.length >= 1,
    'a garbage byte cap must fall back to the 256 KiB default: NaN would make every comparison false and never rotate',
  );
  assert.equal(
    garbageRotated.length,
    5,
    `a garbage retained count must fall back to the default ring of 5, saw ${garbageRotated.length}`,
  );
  const garbageAttempts = attemptsIn(garbageDir);
  assert.equal(garbageAttempts.length, 1, 'the store must still work with unusable knob values');

  const zeroDir = makeDir('knobs-zero');
  const zero = runChild(KNOB_CHILD, {
    storeDir: zeroDir,
    env: { ANTIFAN_PROXY_TELEMETRY_MAX_BYTES: '0', ANTIFAN_PROXY_TELEMETRY_RETAINED_FILES: '0' },
  });
  assert.equal(zero.result.status, 0, `zero-knob child failed\nstdout:\n${zero.result.stdout}\nstderr:\n${zero.result.stderr}`);
  assert.equal(
    rotatedIn(zeroDir).length,
    1,
    'retained=0 must clamp to a minimum of 1, so the ring can never be switched off',
  );
  assert.equal(attemptsIn(zeroDir).length, 1, 'the zero-clamped byte cap must still record the attempt');
});

// ─── P7: two pids, two files ────────────────────────────────────────────────
test('P7: two proxies in one directory write one file per pid with no interleaving', async () => {
  const dir = makeDir('p7');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  await proxy.invoke('core.stats', {});
  await waitForAttempts(dir, 1);

  const { result, childPid } = runChild("(async () => { await proxy.invoke('core.stats', {}); })();\n");
  assert.equal(result.status, 0, `child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'the child must report its pid');
  assert.notEqual(childPid, process.pid);

  const childFile = path.join(dir, `core-attempts-${childPid}.jsonl`);
  await waitFor(
    () => fs.existsSync(childFile) && storeRecords(dir).some((record) => record.kind === 'attempt' && record.pid === childPid),
    `the child pid file ${childFile}`,
  );

  const parentFile = path.join(dir, `core-attempts-${process.pid}.jsonl`);
  assert.ok(fs.existsSync(parentFile), 'the parent keeps its own file');
  const names = fs.readdirSync(dir).filter((name) => STORE_FILE.test(name));
  assert.deepEqual(names.sort(), [path.basename(childFile), path.basename(parentFile)].sort(), 'one file per pid');

  for (const name of names) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => line.trim());
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `every line in ${name} must be a complete JSON record`);
    }
    const filePid = Number.parseInt(name.slice('core-attempts-'.length), 10);
    for (const record of storeRecords(dir).filter((entry) => entry.__file === name && entry.kind === 'attempt')) {
      assert.equal(record.pid, filePid, `${name} must hold only pid ${filePid} records`);
    }
  }
});

// ─── P10: the process-end flush ─────────────────────────────────────────────
test('P10: a record still lands when the process exits immediately after the outcome is known', async () => {
  const dir = makeDir('p10');
  // The child awaits the dispatch, then exits WITHOUT waiting for the async
  // append: only the exit-time flush can put the record on disk.
  const { result, childPid } = runChild(
    "(async () => { await proxy.invoke('core.stats', {}); process.exit(0); })();\n",
    { storeDir: dir },
  );
  assert.equal(result.status, 0, `child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'the child must report its pid');

  const childFile = path.join(dir, `core-attempts-${childPid}.jsonl`);
  await waitFor(() => fs.existsSync(childFile), `the exit-flushed store file ${childFile}`);
  const records = storeRecords(dir).filter((record) => record.kind === 'attempt' && record.pid === childPid);
  assert.equal(records.length, 1, 'the last call before an immediate exit must not be lost');
  assert.equal(records[0].outcome, 'ok');
});

// ─── the dispatch never waits on the writer ─────────────────────────────────
test('the dispatch returns without awaiting the append, and the record still lands', async () => {
  const dir = makeDir('nonblocking');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  const original = fs.promises.appendFile;
  let appends = 0;
  // The emitter writes through `require('node:fs').promises` — the same object
  // this file holds — so a slow writer is observable without patching the proxy.
  fs.promises.appendFile = async (...args) => {
    appends += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return original.apply(fs.promises, args);
  };
  let elapsed = 0;
  try {
    const startedAt = Date.now();
    const result = await proxy.invoke('core.stats', {});
    elapsed = Date.now() - startedAt;
    assert.deepEqual(result, { counts: { claims: 0, cases: 0 } });
    assert.ok(elapsed < 200, `the caller must not wait on a 300 ms telemetry append (took ${elapsed} ms)`);
    const records = await waitForAttempts(dir, 1);
    assert.equal(records[0].outcome, 'ok');
  } finally {
    fs.promises.appendFile = original;
  }
  assert.ok(appends >= 1, 'the writer must have been engaged for this dispatch');
});

// ─── P5: no injected directory ⇒ no write, one notice ───────────────────────
test('P5: without the injected variable nothing is written and exactly one notice is emitted', async () => {
  const cwd = makeDir('p5-cwd');
  const { result, childPid } = runChild(
    "(async () => { await proxy.invoke('core.stats', {}); await proxy.invoke('core.stats', {}); })();\n",
    { storeDir: null, cwd },
  );
  assert.equal(result.status, 0, `child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'the child must report its pid');

  const notices = result.stderr.split('proxyTelemetryUnavailable').length - 1;
  assert.equal(notices, 1, `two unrecordable dispatches must emit exactly one notice, saw ${notices}\n${result.stderr}`);
  assert.match(result.stderr, /ANTIFAN_PROXY_TELEMETRY_DIR is not set/);
  // No plausible-path fallback: the child's own cwd carries no store, and the
  // store the suite points at is untouched by this child.
  assert.deepEqual(fs.readdirSync(cwd), [], 'an absent variable must not create a fallback store near the cwd');
  assert.deepEqual(fs.readdirSync(MAIN_DIR), [], 'an unbound process must not write into any injected store either');
});

// ─── P8: the compile-time gate cannot execute the emitter ───────────────────
test('P8: the budget gate require()s the proxy module without executing the emitter', () => {
  const dir = makeDir('p8');
  const result = spawnSync(process.execPath, [BUDGET_GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ANTIFAN_PROXY_TELEMETRY_DIR: dir },
  });
  // The gate's exit status depends on `.compiled`, which parallel work may be
  // rewriting; the property under test is that requiring this module never
  // writes: the gate drives the catalogue binding (`def.execute`), never
  // `proxy.invoke`, so no core.* attempt can be emitted at compile time.
  assert.deepEqual(
    fs.readdirSync(dir),
    [],
    `the budget gate must not emit core.* attempts (gate status ${result.status})\n${result.stderr}`,
  );
});

// ─── P9: the reader section over the same store ─────────────────────────────
test('P9: the --core-attempts reader summarises a store and refuses to invent one', () => {
  const dir = makeDir('p9');
  const fixture = [
    { kind: 'header', schema: 1, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111, instrumentedSince: '2026-09-16T00:00:00.000Z' },
    { kind: 'attempt', timestamp: '2026-09-16T00:00:01.000Z', method: 'core.stats', requestedAs: 'core.stats', attemptKind: 'dispatched', outcome: 'ok', durationMs: 10, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111 },
    { kind: 'attempt', timestamp: '2026-09-16T00:00:02.000Z', method: 'core.query', requestedAs: 'core.query', attemptKind: 'dispatched', outcome: 'ok', durationMs: 20, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111 },
    { kind: 'attempt', timestamp: '2026-09-16T00:00:03.000Z', method: 'core.query', requestedAs: 'core.query', attemptKind: 'dispatched', outcome: 'error', errorCode: 'CORE_UNAVAILABLE', durationMs: 30, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111 },
    { kind: 'attempt', timestamp: '2026-09-16T00:00:04.000Z', method: 'core.no_such_tool', requestedAs: 'core.no_such_tool', attemptKind: 'unknown-capability', outcome: 'error', errorCode: 'ERROR', durationMs: 40, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111 },
    { kind: 'refusal', timestamp: '2026-09-16T00:00:05.000Z', reason: 'METHOD_NOT_BOUNDABLE', requestedAs: null, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111 },
    { kind: 'drop', timestamp: '2026-09-16T00:00:06.000Z', reason: 'QUEUE_BOUND_EXCEEDED', count: 3, provenance: 'omp-proxy', unit: 'proxy-attempt', pid: 111 },
  ];
  fs.writeFileSync(
    path.join(dir, 'core-attempts-111.jsonl'),
    `${fixture.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );

  const report = runReader(dir);
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.reasonCode, null);
  assert.equal(report.unit, 'proxy-attempt');
  assert.equal(report.provenance, 'omp-proxy');
  assert.equal(report.files, 1);
  assert.equal(report.attempts, 4);
  assert.equal(report.ok, 2);
  assert.equal(report.error, 2);
  assert.equal(report.dispatched, 3);
  assert.equal(report.unknownCapability, 1);
  assert.deepEqual(report.errorCodes, { CORE_UNAVAILABLE: 1, ERROR: 1 });
  // Nearest-rank on [10, 20, 30, 40]: ceil(0.5*4)-1 = 1 -> 20, ceil(0.95*4)-1 = 3 -> 40.
  assert.deepEqual(report.durationMs, { p50: 20, p95: 40, samples: 4 });
  assert.equal(report.refusals, 1);
  assert.equal(report.drops, 3);
  assert.equal(report.unparseableLines, 0);
  assert.equal(report.instrumentedSince, '2026-09-16T00:00:00.000Z');
  assert.deepEqual(report.perFile, [{ file: 'core-attempts-111.jsonl', attempts: 4 }]);
  assert.match(report.note, /not yet instrumented/);

  const carry = report.launchPaths.filter((entry) => entry.canCarry).map((entry) => entry.path);
  const cannot = report.launchPaths.filter((entry) => !entry.canCarry).map((entry) => entry.path);
  assert.deepEqual(carry, ['scripts/antifan-agent.cjs']);
  for (const named of ['bin "antifan-mcp"', 'script "mcp"', 'Codex']) {
    assert.ok(cannot.some((entry) => entry.includes(named)), `the launch-path table must name ${named}`);
  }

  // An absent directory is UNMEASURED, never an empty success — and the reader
  // must not create the store it was asked to read.
  const missing = path.join(TMP_ROOT, 'p9-absent');
  const absent = runReader(missing);
  assert.equal(absent.status, 'UNMEASURED');
  assert.equal(absent.reasonCode, 'STORE_ABSENT');
  assert.equal(absent.attempts, 0);
  assert.ok(!fs.existsSync(missing), 'the reader must never create the store');

  // No directory at all is also named, never guessed from the repo or the cwd.
  const unbound = runReader(null);
  assert.equal(unbound.status, 'UNMEASURED');
  assert.equal(unbound.reasonCode, 'NO_STORE_DIR');
  assert.equal(unbound.storePath, null);
});

// ─── the store is read by the section that owns it ──────────────────────────
test('the reader section reads the store the emitter writes (round trip)', async () => {
  const dir = makeDir('roundtrip');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  await proxy.invoke('core.stats', {});
  await proxy.invoke('core.query', { text: 'round-trip' }).catch(() => {});
  await waitForAttempts(dir, 2);

  const report = runReader(dir);
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.attempts, 2);
  assert.equal(report.ok, 1);
  assert.equal(report.error, 1);
  assert.deepEqual(report.errorCodes, { CORE_UNAVAILABLE: 1 });
  assert.equal(report.unknownCapability, 0);
  assert.equal(report.refusals, 0);
  assert.equal(report.drops, 0);
  assert.equal(report.unparseableLines, 0);
  assert.equal(report.durationMs.samples, 2);
  assert.equal(typeof report.instrumentedSince, 'string', 'a written store must carry instrumentedSince');
  assert.deepEqual(report.perFile, [{ file: `core-attempts-${process.pid}.jsonl`, attempts: 2 }]);
});

// ─── the store itself is never a ledger population ──────────────────────────
test('the store header names provenance and unit so the population cannot be confused with ledger frames', async () => {
  const dir = makeDir('provenance');
  process.env.ANTIFAN_PROXY_TELEMETRY_DIR = dir;
  await proxy.invoke('core.stats', {});
  const records = await waitForAttempts(dir, 1);
  const header = storeRecords(dir).find((record) => record.kind === 'header');
  assert.ok(header, 'the per-pid file must open with a header line');
  assert.equal(header.provenance, 'omp-proxy');
  assert.equal(header.unit, 'proxy-attempt');
  assert.equal(header.pid, process.pid);
  assert.equal(typeof header.instrumentedSince, 'string');
  assert.equal(records[0].unit, 'proxy-attempt');
  // A proxy attempt is not a logical dispatch: it carries no invocation identity.
  for (const record of records) {
    for (const key of ['attachmentId', 'idempotencyKey', 'requestId', 'authoritySnapshot']) {
      assert.ok(!(key in record), `a proxy attempt must not carry the ledger field ${key}`);
    }
  }
});
