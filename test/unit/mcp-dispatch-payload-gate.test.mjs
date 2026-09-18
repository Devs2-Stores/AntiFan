import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeFrameChecksum } from '../../.compiled/src/main/session/invocation-frame-checksum.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(ROOT, 'scripts', 'check-mcp-dispatch-payload.mjs');
const CLI = path.join(ROOT, 'scripts', 'antifan-mcp-dispatch-account.cjs');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'mcp-dispatch-payload');
const SEEDED_DIR = path.join(FIXTURE_DIR, 'seeded');
const GATE_SOURCE = readFileSync(GATE, 'utf8');

/**
 * The three comparison rules, as message families. Rule 4/5 are not comparison
 * rules: rule 4 is a role assertion and rule 5 is the source self-check below.
 */
const RULE_FAMILIES = [
  { rule: 'rule 1 allowlist', shape: /is not in the frozen (?:payload|row|per-file roll-up) allowlist/ },
  { rule: 'rule 2 passthrough', shape: /forbidden frame field/ },
  { rule: 'rule 3 location', shape: /(?:absolute-path-shaped|URL-shaped) (?:string|KEY)/ },
];

function runGate(extraArgs = []) {
  return spawnSync(process.execPath, [GATE, ...extraArgs], { cwd: ROOT, encoding: 'utf8' });
}

// Phase 6 rule 5: the gate's safety property is its input set, and the only thing
// that keeps a later "helpful" edit from re-arming the launch-path hazard is a
// test over the gate's own text.
const FORBIDDEN_STORE_TOKENS = [
  'control-plane-v2',
  '.antifan-data',
  '.antifan/telemetry',
  'ANTIFAN_DATA_ROOT',
  'process.env',
  'process.cwd(',
];

const FS_READ_CALL = /\bfs\.(?:readFileSync|readdirSync|statSync|lstatSync|existsSync|accessSync|realpathSync|readFile|readdir|stat|openSync|createReadStream)\s*\(/;

test('payload gate source carries no live-store token', () => {
  for (const token of FORBIDDEN_STORE_TOKENS) {
    assert.ok(!GATE_SOURCE.includes(token), `the gate must not name '${token}'`);
  }
});

test('payload gate derives its input root from its own location, never an ambient one', () => {
  assert.match(GATE_SOURCE, /fileURLToPath\(import\.meta\.url\)/, 'the gate must locate itself from its module URL');
  assert.doesNotMatch(GATE_SOURCE, /process\.cwd/, 'an ambient working directory must never decide the gate input');
  assert.doesNotMatch(GATE_SOURCE, /process\.env/, 'no environment variable may reach the gate verdict');
});

test('every filesystem read in the payload gate lives under the fixture root', () => {
  const lines = GATE_SOURCE.split('\n');
  const readLines = lines.map((line, index) => ({ line, number: index + 1 })).filter((entry) => FS_READ_CALL.test(entry.line));
  assert.ok(readLines.length > 0, 'the gate must read its committed fixtures');
  for (const entry of readLines) {
    assert.ok(
      /fixture/i.test(entry.line),
      `gate line ${entry.number} reads the filesystem outside the fixture root: ${entry.line.trim()}`
    );
  }
});

test('payload gate is green on the committed fixture set', () => {
  const result = runGate();
  assert.equal(result.status, 0, `gate must pass on the committed fixtures\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /OK: \d+ payload fixture\(s\) obey the frozen projection/);
});

test('payload gate skips every comparison rule for the empty-store payload instead of comparing nulls', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-dispatch-empty-'));
  try {
    writeFileSync(path.join(dir, 'empty-store.json'), readFileSync(path.join(FIXTURE_DIR, 'empty-store.json')));
    const result = runGate(['--fixture', dir]);
    assert.equal(result.status, 0, `an empty store must not fail the build\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /rule 4 skips every comparison rule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('payload gate is red on every seeded fixture, naming the rule that fired', () => {
  const result = runGate(['--fixture', SEEDED_DIR]);
  assert.equal(result.status, 1, `the seeded fixtures must fail the gate\nstdout:\n${result.stdout}`);
  for (const expected of [
    /unknown-key\.json: top-level key 'rawFrames' is not in the frozen payload allowlist/,
    /frame-passthrough\.json: forbidden frame field 'runtimeLeaseToken'/,
    /absolute-path\.json: absolute-path-shaped string/,
    /url\.json: URL-shaped string/,
    // Rule 3 inspects KEYS as well as values: the `errors` histogram is keyed by a persisted
    // `frame.error.code`, so a location can arrive as a key exactly as easily as as a value. A
    // value-only walk let this payload through with the gate printing OK.
    /location-key\.json: absolute-path-shaped KEY at payload\.rows\[0\]\.errors\["C:\\\\Users\\\\Admin\\\\secrets"\]/,
  ]) {
    assert.match(result.stderr, expected);
  }
});

test('each seeded fixture trips exactly one rule family, so a seed cannot hide a second defect', () => {
  const names = readdirSync(SEEDED_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.ok(names.length >= 5, `the seeded directory must keep one seed per rule, found: ${names.join(', ')}`);
  for (const name of names) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'antifan-seed-one-'));
    try {
      writeFileSync(path.join(dir, name), readFileSync(path.join(SEEDED_DIR, name)));
      const result = runGate(['--fixture', dir]);
      assert.equal(result.status, 1, `${name} must fail the gate`);
      const fired = RULE_FAMILIES.filter((family) => family.shape.test(result.stderr)).map((family) => family.rule);
      assert.equal(fired.length, 1, `${name} must trip exactly one rule family, tripped: ${fired.join(', ')}\nstderr:\n${result.stderr}`);
      const failLines = result.stderr.split('\n').filter((line) => line.includes('FAIL '));
      assert.ok(failLines.length > 0, `${name} must report at least one failing line`);
      for (const line of failLines) {
        assert.ok(
          RULE_FAMILIES.some((family) => family.shape.test(line)),
          `${name} reported a failure outside the three comparison rules: ${line}`
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Rule 3 against REAL reader output, not only hand-written fixtures
// ---------------------------------------------------------------------------------------------

const REAL_AS_OF = '2099-01-01T00:00:00.000Z';

let frameSeq = 0;

/** One admissible persisted frame, built with the writer's own checksum seam. */
function frameBody(overrides = {}) {
  frameSeq += 1;
  return {
    formatVersion: 1,
    id: `gate-frame-${frameSeq}`,
    attachmentId: 'gate-attachment',
    requestId: `gate-request-${frameSeq}`,
    idempotencyKey: `gate-key-${frameSeq}`,
    name: 'anti.browser.evaluate',
    paramDigest: 'sha256:param',
    policyDigest: 'sha256:policy',
    policyVersion: 1,
    recordedVisibility: 'summary',
    state: 'settled',
    authoritySnapshot: { revision: 1 },
    createdAt: '2026-09-17T03:00:00.000Z',
    settledAt: '2026-09-17T03:00:00.250Z',
    ...overrides,
  };
}

function frameLine(overrides = {}) {
  const body = frameBody(overrides);
  return `${JSON.stringify({ ...body, checksum: computeFrameChecksum(body) })}\n`;
}

/** A small store this test authors itself: three partitions, one real error histogram. */
function buildSyntheticStore(dir) {
  writeFileSync(
    path.join(dir, 'gate-partition-0001.jsonl'),
    frameLine({ attachmentId: 'gate-att-a', idempotencyKey: 'gate-key-a' })
      + frameLine({ attachmentId: 'gate-att-a', idempotencyKey: 'gate-key-a', state: 'unknown' })
  );
  writeFileSync(
    path.join(dir, 'gate-partition-0002.jsonl'),
    frameLine({
      attachmentId: 'gate-att-b',
      idempotencyKey: 'gate-key-b',
      state: 'failed',
      error: { code: 'EXECUTION_TIMEOUT', message: 'gate fixture' },
    })
  );
  writeFileSync(
    path.join(dir, 'gate-partition-0003.jsonl'),
    frameLine({
      attachmentId: 'gate-att-c',
      idempotencyKey: 'gate-key-c',
      name: 'browser.dom',
      state: 'failed',
      error: { code: 'REFUSED_TOOL_SURFACE', message: 'gate fixture' },
    })
  );
}

function readSyntheticStore() {
  const store = mkdtempSync(path.join(os.tmpdir(), 'antifan-gate-synthetic-'));
  buildSyntheticStore(store);
  const run = spawnSync(
    process.execPath,
    [CLI, '--store', store, '--as-of', REAL_AS_OF, '--no-memo', '--json'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  return { store, run };
}

test('the payload gate accepts the payload the real reader emits, histogram included', () => {
  const { store, run } = readSyntheticStore();
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'antifan-gate-real-payload-'));
  try {
    assert.equal(run.status, 0, `the CLI must read the synthetic store\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    // Pure JSON: a human line before the document would throw here, which is the
    // property the old prefix-line shape broke.
    const document = JSON.parse(run.stdout);
    assert.deepEqual(
      Object.keys(document),
      ['storeAbsolute', 'payload'],
      '--json separates the CLI-only location from the payload instead of smearing one document'
    );
    assert.equal(document.storeAbsolute, store, 'the CLI discloses the store it actually read');
    assert.equal(Object.prototype.hasOwnProperty.call(document.payload, 'storeAbsolute'), false);

    const payload = document.payload;
    assert.equal(payload.status, 'MEASURED', `the synthetic store must measure; affected=${JSON.stringify(payload.affected)}`);
    const withHistogram = payload.rows.filter((row) => row.errors && Object.keys(row.errors).length > 0);
    assert.ok(withHistogram.length > 0, `the synthetic store must produce a real errors histogram: ${JSON.stringify(payload.rows)}`);
    assert.ok(
      withHistogram.some((row) => Object.keys(row.errors).includes('EXECUTION_TIMEOUT')),
      'the histogram must carry the code the fixture wrote'
    );
    assert.equal(
      payload.storePath === null || !/[/\\:]/.test(payload.storePath),
      true,
      `storePath must stay a separator-free, drive-free label, got ${JSON.stringify(payload.storePath)}`
    );

    // The gate's whole input is the payload half of that document.
    writeFileSync(path.join(fixtureDir, 'real-reader-output.json'), `${JSON.stringify(payload, null, 2)}\n`);
    const gate = runGate(['--fixture', fixtureDir]);
    assert.equal(
      gate.status,
      0,
      `the gate must accept real reader output\nstdout:\n${gate.stdout}\nstderr:\n${gate.stderr}`
    );
    assert.match(gate.stdout, /OK: 1 payload fixture\(s\) obey the frozen projection/);

    // The wrapper is NOT the payload: the same document taken whole is rejected by
    // both rule 1 (the CLI-only key) and rule 3 (the absolute location), which is
    // exactly why the two halves are separate members rather than one flat object.
    rmSync(path.join(fixtureDir, 'real-reader-output.json'), { force: true });
    writeFileSync(path.join(fixtureDir, 'cli-document.json'), `${JSON.stringify(document, null, 2)}\n`);
    const wrapperGate = runGate(['--fixture', fixtureDir]);
    assert.equal(wrapperGate.status, 1, `the CLI document must not pass as a renderer payload\nstdout:\n${wrapperGate.stdout}`);
    assert.match(wrapperGate.stderr, /top-level key 'storeAbsolute' is not in the frozen payload allowlist/);
    assert.match(wrapperGate.stderr, /absolute-path-shaped string at payload\.storeAbsolute/);
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('the payload gate rejects a location-shaped histogram key in real reader output', () => {
  const { store, run } = readSyntheticStore();
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'antifan-gate-real-key-'));
  try {
    assert.equal(run.status, 0, `the CLI must read the synthetic store\nstderr:\n${run.stderr}`);
    const payload = JSON.parse(run.stdout).payload;
    const withHistogram = payload.rows.find((row) => row.errors && Object.keys(row.errors).length > 0);
    assert.ok(withHistogram, 'the fixture must expose a histogram row to poison');
    // Whoever produced it — this phase's reader, a later revision, or a fixture —
    // a location must not cross as a key.
    withHistogram.errors['C:\\Users\\Admin\\secrets'] = 1;
    writeFileSync(path.join(fixtureDir, 'poisoned-histogram.json'), `${JSON.stringify(payload, null, 2)}\n`);
    const gate = runGate(['--fixture', fixtureDir]);
    assert.equal(gate.status, 1, 'a location-shaped histogram key must fail the gate');
    assert.match(gate.stderr, /absolute-path-shaped KEY at payload\.rows\[\d+\]\.errors\["C:\\\\Users\\\\Admin\\\\secrets"\]/);
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('the compile payload gate properly gates artifacts and fails on a real payload violation', () => {
  // Observable behavior: the gate validates committed payload artifacts
  const cleanRun = runGate();
  assert.equal(cleanRun.status, 0, `compile payload gate must pass on clean artifacts\nstdout:\n${cleanRun.stdout}\nstderr:\n${cleanRun.stderr}`);
  assert.match(cleanRun.stdout, /OK: \d+ payload fixture\(s\) obey the frozen projection/);

  // The gate's intent: it must fail on an artifact carrying a real payload violation
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'antifan-gate-compile-violation-'));
  try {
    const payload = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'measured.json'), 'utf8'));
    payload.rows[0].runtimeLeaseToken = 'leak-token-12345';
    writeFileSync(path.join(fixtureDir, 'violation.json'), `${JSON.stringify(payload, null, 2)}\n`);
    const failingRun = runGate(['--fixture', fixtureDir]);
    assert.equal(failingRun.status, 1, 'the gate must reject an artifact with a real payload violation');
    assert.match(failingRun.stderr, /forbidden frame field 'runtimeLeaseToken'/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
