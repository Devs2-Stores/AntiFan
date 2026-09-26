/**
 * MCP dispatch accounting — unit and integration matrix.
 *
 * Runs against the **compiled** module (`npm run compile` emits `.compiled/`), which is this repo's
 * convention for `.mjs` unit tests (`test/unit/frame-queue.test.mjs:25`,
 * `test/unit/invocation-frame-checksum.test.mjs:31`).
 *
 * ## Fixture policy
 *
 * Every fixture is authored **in this file** and written into a run-scoped temporary store under
 * `test/fixtures/mcp-dispatch-accounting/` that the suite removes in its `after()` hook. No fixture
 * frame, line or byte is copied out of the live store: the store holds live dispatch payloads, and
 * copying one into the repository would be data exfiltration by fixture
 * (`plans/260917-0341-mcp-dispatch-accounting/phase-03:132`). No live file or frame count is asserted
 * anywhere below.
 *
 * The only external input is the shared frame-checksum seam, which the phase file itself mandates for
 * building checksum-valid fixtures (`phase-02:190`) and which is independently pinned against a
 * hand-derived canonical form in `test/unit/invocation-frame-checksum.test.mjs`. The strict-versus-
 * variant pair is the one place where the *choice* of hash matters, and both of those rows are built
 * from the two seam helpers explicitly so the reader is being tested, not the fixture builder.
 *
 * Row names follow the plan's matrices (T = line reader, C = census, I = identity, U = aggregate,
 * S = sink, P = population, R = roll-up, X = pass/ceiling/worker) so a reviewer can line this file up
 * with `phase-01`/`phase-02`/`phase-03` row by row.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  AffectedToken,
  CensusBudgetExpiredError,
  CensusDirectoryUnreadableError,
  ChecksumMismatchReason,
  EVIDENCE_REF_PATTERN,
  HISTOGRAM_TOKEN_PATTERN,
  IN_PROCESS_YIELD_INTERVAL_FILES,
  JSONL_NAME_MARKER,
  LatencyProvenance,
  MAX_CENSUS_BYTES,
  MAX_CENSUS_FILES,
  MEASURED_REASON_CODE,
  NAMED_INVALID_RESIDUE_CLASSES,
  NAMED_RESIDUE_CLASSES,
  PASS_BUDGET_MS,
  PASS_LIMITS,
  QUARANTINE_NAME_MARKER,
  REQUIRED_IDENTITY_FIELDS,
  RETENTION_NOTE,
  ResidueClass,
  SHORT_READ_RESIDUE_CLASSES,
  SUPPORTED_FORMAT_VERSION,
  StructuralInvalidReason,
  TEMP_NAME_MARKER,
  TRUNCATION_ORDER,
  UNPARSEABLE_REASON,
  UNRECOGNIZED_HISTOGRAM_KEY,
  UnmeasuredReason,
  accountStore,
  aggregateByName,
  classifyLine,
  clearAccountMemo,
  compositeIdentity,
  computePopulationMemoKey,
  emptyAccumulator,
  evidenceRefsFor,
  finalizeAggregate,
  foldFrame,
  isLocationShaped,
  latencyProvenance,
  quarantineMargin,
  readAdmittedFrames,
  readFramesIncremental,
  reconcile,
  residueHistogram,
  runCensusPass,
  runPopulationSweep,
  storeDisplayLabel,
  unmeasuredEnvelope,
} from '../../.compiled/src/main/diagnostics/mcp-dispatch-accounting.js';
import {
  computeFrameChecksum,
  computeFrameChecksumNullArrayVariant,
} from '../../.compiled/src/main/session/invocation-frame-checksum.js';

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_SOURCE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'mcp-dispatch-accounting');
const MODULE_SOURCE_PATH = path.join(REPO_ROOT, 'src', 'main', 'diagnostics', 'mcp-dispatch-accounting.ts');
const CONTRACTS_SOURCE_PATH = path.join(REPO_ROOT, 'src', 'shared', 'mcp-dispatch-contracts.ts');
const MODULE_EMIT_PATH = path.join(REPO_ROOT, '.compiled', 'src', 'main', 'diagnostics', 'mcp-dispatch-accounting.js');
const AS_OF = '2026-09-17T03:41:00.000Z';

/** A fixed integer-millisecond stamp: the filesystem round-trips these exactly (see X8). */
const STAMP = 1789619000000;

const createdStores = [];

function newStore() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'run-'));
  createdStores.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdStores) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store the OS still holds open is reclaimed by the temp-fixture directory's own lifecycle.
    }
  }
});

function writeStoreFile(dir, name, text) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, text);
  return full;
}

/** Sets an mtime in whole milliseconds, which is the only form the filesystem round-trips exactly. */
function setMtime(full, ms) {
  fs.utimesSync(full, ms / 1000, ms / 1000);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** A content-and-metadata hash of a directory tree, for the "the reader never writes" row. */
function treeHash(dir) {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).slice().sort()) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    hash.update(`${name}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000`);
    if (stat.isFile()) hash.update(fs.readFileSync(full));
  }
  return hash.digest('hex');
}

function collector() {
  const emitted = [];
  return { emitted, sink: { emit: (entry) => emitted.push(entry) } };
}

/** Every `.ts` file under a directory, recursively — for source-text assertions over the whole tree. */
function sourceFilesUnder(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Strips comments, so a doc reference to a function is never counted as a call site. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function foldAll(emitted) {
  const acc = emptyAccumulator();
  for (const entry of emitted) foldFrame(acc, entry.frame, false);
  return acc;
}

/** Builds a store of `{ name: text }` files and runs one full pass over it. */
async function passOver(files, options = {}) {
  const dir = newStore();
  for (const [name, text] of Object.entries(files)) writeStoreFile(dir, name, text);
  const result = await runCensusPass(dir, AS_OF, options);
  return { dir, result };
}

function residueFor(result, file, residueClass) {
  return result.residue.find((entry) => entry.file === file && entry.class === residueClass) ?? null;
}

function residueTotal(result, residueClass) {
  return result.residue
    .filter((entry) => entry.class === residueClass)
    .reduce((sum, entry) => sum + entry.count, 0);
}

function censusEntry(census, name) {
  return census.files.find((entry) => entry.name === name) ?? null;
}

function rowFor(envelope, name) {
  return envelope.rows.find((row) => row.name === name) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Frame fixtures — authored here, never copied from the store
// ---------------------------------------------------------------------------------------------

let frameSeq = 0;

function frameBody(overrides = {}) {
  frameSeq += 1;
  return {
    formatVersion: 1,
    id: `frame-${frameSeq}`,
    attachmentId: 'attachment-1',
    requestId: `request-${frameSeq}`,
    idempotencyKey: `key-${frameSeq}`,
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

/**
 * One persisted line.
 *
 * `checksumOf` overrides the hash, which is how the strict-versus-variant pair below is built: the two
 * helpers differ only in how an array slot holding `null` canonicalizes, and a fixture that needed
 * that distinction cannot be built any other way (`invocation-frame-checksum.ts:68-88`).
 */
function frameLine(overrides = {}, checksumOf = computeFrameChecksum) {
  const body = frameBody(overrides);
  return JSON.stringify({ ...body, checksum: checksumOf(body) });
}

function isoAt(baseIso, offsetMs) {
  return new Date(Date.parse(baseIso) + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------------------------
// X17 — the frozen closed sets
// ---------------------------------------------------------------------------------------------

test('X17 the closed sets are exactly the frozen members, in classification order', () => {
  assert.deepEqual(Object.keys(ResidueClass), [
    'ADMITTED',
    'STRUCTURAL_INVALID',
    'CHECKSUM_MISMATCH',
    'TORN_TAIL',
    'UNPARSEABLE',
    'RESIDUE_NO_CHECKSUM',
    'POST_CENSUS_APPEND',
    'POST_CENSUS_TRUNCATE',
    'VANISHED',
  ]);
  assert.deepEqual(Object.keys(UnmeasuredReason), [
    'NO_DATA_ROOT_RESOLVED',
    'DIR_UNREADABLE',
    'READ_BUDGET_EXCEEDED',
    'POPULATION_TRUNCATED',
    'CENSUS_DRIFT',
    'NO_DATA',
    'SERVICE_FAILED',
  ]);
  assert.deepEqual(Object.keys(LatencyProvenance), [
    'OWNER_WRITTEN',
    'EXCLUDED_UNKNOWN_STATE',
    'EXCLUDED_REPLAY_PROVENANCE',
  ]);
  assert.deepEqual(Object.keys(StructuralInvalidReason), ['MISSING_IDENTITY', 'UNSUPPORTED_FORMAT_VERSION']);
  assert.deepEqual(Object.keys(ChecksumMismatchReason), ['WRITER_CANONICALIZATION_ARRAY_SLOT', 'UNEXPLAINED']);

  // The eight-member residue histogram is derived from the nine-member class set, and the named-invalid
  // and short-read categories partition it without overlapping. `ADMITTED` is in neither: a histogram
  // of "named invalid" that contains an admitted count is a category error (`phase-03:59-61`).
  assert.equal(NAMED_RESIDUE_CLASSES.length, 8);
  assert.ok(!NAMED_RESIDUE_CLASSES.includes(ResidueClass.ADMITTED));
  assert.deepEqual(
    [...NAMED_INVALID_RESIDUE_CLASSES, ...SHORT_READ_RESIDUE_CLASSES].slice().sort(),
    NAMED_RESIDUE_CLASSES.slice().sort(),
  );

  // The bounds are real named values, because the delivery surface reads the budget lazily before it
  // can afford this module's import cost.
  assert.equal(PASS_BUDGET_MS, 20_000);
  assert.equal(MAX_CENSUS_BYTES, 512 * 1024 * 1024);
  assert.equal(MAX_CENSUS_FILES, 4096);
  assert.deepEqual(PASS_LIMITS, { budgetMs: 20_000, maxBytes: 512 * 1024 * 1024, maxFiles: 4096 });
  assert.equal(SUPPORTED_FORMAT_VERSION, 1);
  assert.deepEqual([...REQUIRED_IDENTITY_FIELDS], ['id', 'idempotencyKey', 'attachmentId']);

  // The evidence grammar accepts only a resolvable pointer and no free-form string.
  assert.ok(EVIDENCE_REF_PATTERN.test('census:0f1e2d3c#L12'));
  assert.ok(!EVIDENCE_REF_PATTERN.test('census:0f1e2d3#L12'));
  assert.ok(!EVIDENCE_REF_PATTERN.test('census:0F1E2D3C#L12'));
  assert.ok(!EVIDENCE_REF_PATTERN.test('C:/Users/me/store#L1'));
  assert.ok(!EVIDENCE_REF_PATTERN.test('census:0f1e2d3c#0'));
});

// ---------------------------------------------------------------------------------------------
// T — the line reader
// ---------------------------------------------------------------------------------------------

test('T1 three valid frames are admitted, counted and rolled up so the per-file identity closes', async () => {
  const lines = [frameLine(), frameLine(), frameLine()];
  const { result } = await passOver({ 'a.jsonl': `${lines.join('\n')}\n` });

  assert.equal(result.counters.outcome, 'COMPLETE');
  assert.equal(result.counters.admittedTotal, 3);
  assert.equal(result.counters.distinctComposites, 3);
  assert.equal(result.counters.superseded, 0);
  assert.equal(result.counters.linesRead, 3);
  assert.equal(result.counters.bytesRead, Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8'));
  assert.deepEqual(result.residue, []);
  assert.equal(result.fileRollups.length, 1);
  assert.deepEqual(result.fileRollups[0], {
    file: 'a.jsonl',
    quarantineLike: false,
    tempLike: false,
    frames: 3,
    admitted: 3,
    namedInvalid: 0,
  });
  assert.equal(result.counters.labels['a.jsonl'].trailingNewline, true);
  const entry = censusEntry(result.census, 'a.jsonl');
  assert.equal(entry.lineCount, 3);
  assert.equal(entry.size, Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8'));
  assert.equal(entry.consistency, 'clean');
  assert.equal(entry.sha256, sha256Hex(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
});

test('T2 a valid frame with no trailing newline is admitted', async () => {
  const { result } = await passOver({ 'a.jsonl': frameLine() });
  assert.equal(result.counters.admittedTotal, 1);
  assert.deepEqual(result.residue, []);
  assert.equal(result.counters.labels['a.jsonl'].trailingNewline, false);
});

test('T5 blank lines and a whitespace-only partial tail are not frames and not residue', async () => {
  const line = frameLine();
  const { result } = await passOver({ 'a.jsonl': `\n${line}\n\n   \n` });
  assert.equal(result.counters.admittedTotal, 1);
  assert.equal(result.counters.linesRead, 1);
  assert.deepEqual(result.residue, []);
  assert.equal(censusEntry(result.census, 'a.jsonl').lineCount, 1);
});

test('T6 a torn JSON tail is TORN_TAIL, is named once per file, and contributes no frame', async () => {
  const line = frameLine();
  const torn = line.slice(0, line.length - 6);
  const { result } = await passOver({ 'a.jsonl': `${line}\n${torn}` });

  assert.equal(result.counters.admittedTotal, 1);
  const residue = residueFor(result, 'a.jsonl', ResidueClass.TORN_TAIL);
  assert.ok(residue, 'the torn tail must be named');
  assert.equal(residue.count, 1);
  assert.equal(residue.firstLine, 1);
  assert.equal(residue.firstByteOffset, Buffer.byteLength(`${line}\n`, 'utf8'));
  assert.equal(result.counters.labels['a.jsonl'].parseFailures, 1);
  assert.deepEqual(result.fileRollups[0], {
    file: 'a.jsonl',
    quarantineLike: false,
    tempLike: false,
    frames: 2,
    admitted: 1,
    namedInvalid: 1,
  });
});

test('T3 a checksum mismatch the null-array variant reproduces is named, and is never admitted', async () => {
  const withNullSlot = frameBody({ result: { items: [null, 1] } });
  const line = JSON.stringify({ ...withNullSlot, checksum: computeFrameChecksumNullArrayVariant(withNullSlot) });
  const { result } = await passOver({ 'a.jsonl': `${line}\n` });

  assert.equal(result.counters.admittedTotal, 0);
  const residue = residueFor(result, 'a.jsonl', ResidueClass.CHECKSUM_MISMATCH);
  assert.equal(residue.reason, ChecksumMismatchReason.WRITER_CANONICALIZATION_ARRAY_SLOT);
  assert.equal(residue.count, 1);
  assert.equal(result.fileRollups[0].namedInvalid, 1);
  assert.equal(result.fileRollups[0].admitted, 0);
});

test('T3b a checksum mismatch no variant explains is reported as unexplained', async () => {
  const { result } = await passOver({ 'a.jsonl': `${frameLine({}, () => 'deadbeef').replace('"deadbeef"', '"deadbeef"')}\n` });
  const residue = residueFor(result, 'a.jsonl', ResidueClass.CHECKSUM_MISMATCH);
  assert.equal(residue.reason, ChecksumMismatchReason.UNEXPLAINED);
});

test('T4 the strict comparison decides admission: literal nulls in an array are admitted', async () => {
  // The counterexample that forbids normalize-before-hash: these frames pass strict and would fail the
  // variant, so normalizing first would destroy them (`invocation-frame-checksum.ts:78-83`).
  const withNullSlot = frameBody({ result: { items: [null, 1] } });
  const line = JSON.stringify({ ...withNullSlot, checksum: computeFrameChecksum(withNullSlot) });
  const { result } = await passOver({ 'a.jsonl': `${line}\n` });

  assert.equal(result.counters.admittedTotal, 1);
  assert.deepEqual(result.residue, []);
  assert.equal(result.counters.labels['a.jsonl'].checksumFailures, 0);
});

test('T5b the structural guard runs before the checksum: a blank attachmentId with a valid checksum', async () => {
  // The checksum is *correct*, so a reader that hashed first and validated afterwards would admit it.
  const body = frameBody({ attachmentId: '' });
  const { result } = await passOver({ 'a.jsonl': `${JSON.stringify({ ...body, checksum: computeFrameChecksum(body) })}\n` });

  assert.equal(result.counters.admittedTotal, 0);
  const residue = residueFor(result, 'a.jsonl', ResidueClass.STRUCTURAL_INVALID);
  assert.equal(residue.reason, StructuralInvalidReason.MISSING_IDENTITY);
  assert.deepEqual(residue.fields, ['attachmentId']);
  assert.equal(result.counters.labels['a.jsonl'].checksumFailures, 0);
  assert.equal(result.counters.labels['a.jsonl'].structuralInvalid, 1);
});

test('T6b an unsupported formatVersion is never admitted and reports the version it saw', async () => {
  const body = frameBody({ formatVersion: 2 });
  const { result } = await passOver({ 'a.jsonl': `${JSON.stringify({ ...body, checksum: computeFrameChecksum(body) })}\n` });

  assert.equal(result.counters.admittedTotal, 0);
  const residue = residueFor(result, 'a.jsonl', ResidueClass.STRUCTURAL_INVALID);
  assert.equal(residue.reason, StructuralInvalidReason.UNSUPPORTED_FORMAT_VERSION);
  assert.equal(residue.observedFormatVersion, 2);
});

test('T6c an absent formatVersion reports no observed version rather than inventing one', async () => {
  const body = frameBody();
  delete body.formatVersion;
  const { result } = await passOver({ 'a.jsonl': `${JSON.stringify({ ...body, checksum: computeFrameChecksum(body) })}\n` });

  const residue = residueFor(result, 'a.jsonl', ResidueClass.STRUCTURAL_INVALID);
  assert.equal(residue.reason, StructuralInvalidReason.UNSUPPORTED_FORMAT_VERSION);
  assert.equal(residue.observedFormatVersion, undefined);
});

test('T7 a line that parses to null is named residue and the frames after it are still classified', async () => {
  const line = frameLine();
  const { result } = await passOver({ 'a.jsonl': `null\n${line}\n` });

  const residue = residueFor(result, 'a.jsonl', ResidueClass.STRUCTURAL_INVALID);
  assert.equal(residue.reason, StructuralInvalidReason.MISSING_IDENTITY);
  assert.deepEqual(residue.fields, ['id', 'idempotencyKey', 'attachmentId']);
  assert.equal(result.counters.admittedTotal, 1, 'the frame after the null line must survive it');
});

test('T8 a line with no usable checksum is RESIDUE_NO_CHECKSUM', async () => {
  const numeric = frameBody();
  const missing = frameBody();
  const content = `${JSON.stringify({ ...numeric, checksum: 123 })}\n${JSON.stringify(missing)}\n`;
  const { result } = await passOver({ 'a.jsonl': content });

  assert.equal(result.counters.admittedTotal, 0);
  const residue = residueFor(result, 'a.jsonl', ResidueClass.RESIDUE_NO_CHECKSUM);
  assert.equal(residue.count, 2, 'a non-string checksum and an absent one are the same verdict');
  assert.equal(result.counters.labels['a.jsonl'].noChecksum, 2);
});

test('T15 an empty file is censused as zero frames, zero residue and a zero-byte digest', async () => {
  const { result } = await passOver({ 'a.jsonl': '' });

  assert.equal(result.counters.admittedTotal, 0);
  assert.equal(result.counters.filesRead, 1);
  assert.deepEqual(result.residue, []);
  assert.deepEqual(result.fileRollups[0], {
    file: 'a.jsonl',
    quarantineLike: false,
    tempLike: false,
    frames: 0,
    admitted: 0,
    namedInvalid: 0,
  });
  const entry = censusEntry(result.census, 'a.jsonl');
  assert.equal(entry.size, 0);
  assert.equal(entry.lineCount, 0);
  assert.equal(entry.sha256, sha256Hex(Buffer.alloc(0)));
  assert.equal(result.counters.labels['a.jsonl'].trailingNewline, false);
});

test('T16 CRLF line endings are read with the CR excluded, so the frame still verifies', async () => {
  const { result } = await passOver({ 'a.jsonl': `${frameLine()}\r\n` });

  assert.equal(result.counters.admittedTotal, 1);
  assert.deepEqual(result.residue, []);
  assert.equal(result.counters.labels['a.jsonl'].trailingNewline, true);
});

test('T17 multi-byte content is read byte-exactly and needs no repair', async () => {
  const line = frameLine({ name: 'anti.browser.Ω-evaluate' });
  const { result } = await passOver({ 'a.jsonl': `${line}\n` });

  assert.equal(result.counters.admittedTotal, 1);
  assert.equal(censusEntry(result.census, 'a.jsonl').sha256, sha256Hex(Buffer.from(`${line}\n`, 'utf8')));
});

// ---------------------------------------------------------------------------------------------
// I — identity
// ---------------------------------------------------------------------------------------------

test('I1 one composite seen twice in one file is calls 1, frames 2, superseded 1', async () => {
  const first = frameBody({ attachmentId: 'att-x', idempotencyKey: 'k-x', state: 'dispatched' });
  const second = frameBody({ attachmentId: 'att-x', idempotencyKey: 'k-x', state: 'settled' });
  const emitted = collector();
  const { result } = await passOver({
    'a.jsonl': `${JSON.stringify({ ...first, checksum: computeFrameChecksum(first) })}\n`
      + `${JSON.stringify({ ...second, checksum: computeFrameChecksum(second) })}\n`,
  }, { sink: emitted.sink });

  assert.equal(result.counters.admittedTotal, 2);
  assert.equal(result.counters.distinctComposites, 1);
  assert.equal(result.counters.superseded, 1);
  assert.equal(emitted.emitted.length, 2);

  const rows = aggregateByName(emitted.emitted.map((entry) => entry.frame)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 1);
  assert.equal(rows[0].frames, 2);
  assert.equal(rows[0].superseded, 1);
  assert.deepEqual(rows[0].states, { dispatched: 1, settled: 1 });
});

test('I2 one composite across two files stays one call and one superseded frame', async () => {
  const first = frameBody({ attachmentId: 'att-y', idempotencyKey: 'k-y' });
  const second = frameBody({ attachmentId: 'att-y', idempotencyKey: 'k-y' });
  const emitted = collector();
  const { result } = await passOver({
    'a.jsonl': `${JSON.stringify({ ...first, checksum: computeFrameChecksum(first) })}\n`,
    'b.jsonl': `${JSON.stringify({ ...second, checksum: computeFrameChecksum(second) })}\n`,
  }, { sink: emitted.sink });

  assert.equal(result.counters.admittedTotal, 2);
  assert.equal(result.counters.distinctComposites, 1);
  assert.equal(result.counters.superseded, 1);
  const rows = aggregateByName(emitted.emitted.map((entry) => entry.frame)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 1);
  assert.equal(rows[0].frames, 2);
});

test('I3 a blank identity field composes no key and never the string "undefined"', () => {
  assert.deepEqual(compositeIdentity({ attachmentId: '', idempotencyKey: 'k' }), {
    ok: false,
    reason: 'MISSING_IDENTITY_FIELD',
    field: 'attachmentId',
  });
  assert.deepEqual(compositeIdentity({ attachmentId: 'a', idempotencyKey: '' }), {
    ok: false,
    reason: 'MISSING_IDENTITY_FIELD',
    field: 'idempotencyKey',
  });
  const identity = compositeIdentity({ attachmentId: 'a', idempotencyKey: 'b' });
  assert.ok(identity.ok);
  assert.ok(!identity.key.includes('undefined'), 'the key must never be built from undefined');
});

test('I4 a valid composite with a blank name is unattributed through the real pipeline', async () => {
  // `name` is not part of the identity guard: the frame is admitted, and then it is credited to no row.
  const line = frameLine({ name: '' });
  const emitted = collector();
  const { result } = await passOver({ 'a.jsonl': `${line}\n` }, { sink: emitted.sink });

  assert.equal(result.counters.admittedTotal, 1);
  const acc = foldAll(emitted.emitted);
  const reconciliation = reconcile(acc, result.residue, result.fileRollups);
  const rows = finalizeAggregate(acc).rows;

  assert.deepEqual(rows, []);
  assert.equal(reconciliation.compositeKeys, 1);
  assert.equal(reconciliation.classifiedKeys, 0);
  assert.equal(reconciliation.unattributedKeys, 1);
  assert.equal(reconciliation.unattributedFrames, 1);
  assert.equal(reconciliation.unattributedByReason.MISSING_ROW_KEY, 1);
  assert.equal(reconciliation.unattributedByReason.MISSING_IDENTITY_FIELD, 0);
  assert.equal(reconciliation.keylessFrames, 0);
  assert.equal(reconciliation.holdsKeys, true, '0 + 1 == 1');
  assert.equal(reconciliation.holdsFrames, true, '1 == 1 + 0 + 0');
});

test('I5 a whitespace-only identity field is blank: the unit guard rejects it and the pass names it', async () => {
  assert.deepEqual(compositeIdentity({ attachmentId: '   ', idempotencyKey: 'k' }), {
    ok: false,
    reason: 'MISSING_IDENTITY_FIELD',
    field: 'attachmentId',
  });
  const body = frameBody({ attachmentId: '   ' });
  const { result } = await passOver({ 'a.jsonl': `${JSON.stringify({ ...body, checksum: computeFrameChecksum(body) })}\n` });
  assert.equal(result.counters.admittedTotal, 0);
  assert.equal(residueFor(result, 'a.jsonl', ResidueClass.STRUCTURAL_INVALID).reason, StructuralInvalidReason.MISSING_IDENTITY);
});

test('I6 a frame with no idempotencyKey is named residue, not admitted', async () => {
  const body = frameBody();
  delete body.idempotencyKey;
  const { result } = await passOver({ 'a.jsonl': `${JSON.stringify({ ...body, checksum: computeFrameChecksum(body) })}\n` });
  assert.equal(result.counters.admittedTotal, 0);
  assert.deepEqual(residueFor(result, 'a.jsonl', ResidueClass.STRUCTURAL_INVALID).fields, ['idempotencyKey']);
});

// ---------------------------------------------------------------------------------------------
// U — the aggregate
// ---------------------------------------------------------------------------------------------

test('U1 rows are one per name, sorted by calls desc then name asc', () => {
  const frames = [
    { ...frameBody({ name: 'zzz', attachmentId: 'a', idempotencyKey: 'k1' }) },
    { ...frameBody({ name: 'aaa', attachmentId: 'a', idempotencyKey: 'k2' }) },
    { ...frameBody({ name: 'aaa', attachmentId: 'a', idempotencyKey: 'k3' }) },
  ];
  const rows = aggregateByName(frames).rows;
  assert.deepEqual(rows.map((row) => row.name), ['aaa', 'zzz']);
  assert.deepEqual(rows.map((row) => row.calls), [2, 1]);
});

test('U2 calls counts distinct composites and superseded is reported, never added', () => {
  const shared = { attachmentId: 'a', idempotencyKey: 'k' };
  const frames = [
    frameBody({ ...shared, state: 'dispatched' }),
    frameBody({ ...shared, state: 'settled' }),
    frameBody({ ...shared, state: 'settled' }),
  ];
  const rows = aggregateByName(frames).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 1);
  assert.equal(rows[0].frames, 3);
  assert.equal(rows[0].superseded, 2);
});

test('U3 the state histogram counts observed states without a hard-coded list', () => {
  const frames = [
    frameBody({ attachmentId: 'a', idempotencyKey: 'k1', state: 'settled' }),
    frameBody({ attachmentId: 'b', idempotencyKey: 'k2', state: 'unknown' }),
    frameBody({ attachmentId: 'c', idempotencyKey: 'k3', state: 'a-state-this-build-has-never-seen' }),
  ];
  const rows = aggregateByName(frames).rows;
  assert.deepEqual(rows[0].states, {
    'a-state-this-build-has-never-seen': 1,
    settled: 1,
    unknown: 1,
  });
});

test('U4 the error histogram counts codes as-is and names a codeless error UNKNOWN_ERROR', () => {
  const frames = [
    frameBody({ attachmentId: 'a', idempotencyKey: 'k1', state: 'failed', error: { code: 'E_TIMEOUT', message: 'x' } }),
    frameBody({ attachmentId: 'b', idempotencyKey: 'k2', state: 'failed', error: { message: 'no code' } }),
    frameBody({ attachmentId: 'c', idempotencyKey: 'k3', state: 'failed', error: { code: '', message: 'blank' } }),
  ];
  const rows = aggregateByName(frames).rows;
  assert.deepEqual(rows[0].errors, { E_TIMEOUT: 1, UNKNOWN_ERROR: 2 });
});

test('U5 latency is owner-written only and the excluded population is reported beside it', () => {
  const base = '2026-09-17T03:00:00.000Z';
  const frames = [
    frameBody({ attachmentId: 'a', idempotencyKey: 'k1', state: 'settled', createdAt: base, settledAt: isoAt(base, 13) }),
    frameBody({ attachmentId: 'b', idempotencyKey: 'k2', state: 'unknown', createdAt: base, settledAt: isoAt(base, 262_957) }),
    frameBody({
      attachmentId: 'c',
      idempotencyKey: 'k3',
      state: 'unknown',
      createdAt: base,
      settledAt: isoAt(base, 5000),
      error: { code: 'E_REPLAY', message: 'x', details: { reconciledByPid: 42 } },
    }),
  ];
  assert.equal(latencyProvenance(frames[0]), LatencyProvenance.OWNER_WRITTEN);
  assert.equal(latencyProvenance(frames[1]), LatencyProvenance.EXCLUDED_UNKNOWN_STATE);
  assert.equal(latencyProvenance(frames[2]), LatencyProvenance.EXCLUDED_REPLAY_PROVENANCE);

  const result = aggregateByName(frames);
  assert.deepEqual(result.rows[0].latency, { count: 1, p50Ms: 13, p95Ms: 13 });
  assert.deepEqual(result.rows[0].excludedLatency, { count: 2, p50Ms: 5000, p95Ms: 262_957 });
  assert.deepEqual(result.excludedLatency, { count: 2, p50Ms: 5000, p95Ms: 262_957 });
});

test('U6 firstSeen and lastSeen bound the observed window as ISO instants', () => {
  const frames = [
    frameBody({ attachmentId: 'a', idempotencyKey: 'k1', createdAt: '2026-09-10T01:00:00.000Z' }),
    frameBody({ attachmentId: 'b', idempotencyKey: 'k2', createdAt: '2026-09-16T22:10:00.000Z' }),
    frameBody({ attachmentId: 'c', idempotencyKey: 'k3', createdAt: '2026-09-12T09:30:00.000Z' }),
  ];
  const result = aggregateByName(frames);
  assert.equal(result.rows[0].firstSeen, '2026-09-10T01:00:00.000Z');
  assert.equal(result.rows[0].lastSeen, '2026-09-16T22:10:00.000Z');
  assert.equal(result.firstSeen, '2026-09-10T01:00:00.000Z');
  assert.equal(result.lastSeen, '2026-09-16T22:10:00.000Z');
});

test('U7 an empty latency sample is null, never a zero', () => {
  const frames = [frameBody({ attachmentId: 'a', idempotencyKey: 'k1', settledAt: undefined })];
  const result = aggregateByName(frames);
  assert.equal(result.rows[0].latency, null);
  assert.equal(result.rows[0].excludedLatency, null);
  assert.equal(result.excludedLatency, null);
  assert.equal(result.rows[0].calls, 1, 'the frame is still counted as a call');
});

test('U8 an unparseable createdAt measures no window and no latency', () => {
  const frames = [frameBody({ attachmentId: 'a', idempotencyKey: 'k1', createdAt: 'not-an-instant' })];
  const result = aggregateByName(frames);
  assert.equal(result.rows[0].firstSeen, null);
  assert.equal(result.rows[0].lastSeen, null);
  assert.equal(result.rows[0].latency, null);
  assert.equal(result.firstSeen, null);
});

test('U9 a fresh state change moves the histogram and never the composite count', () => {
  const shared = { attachmentId: 'a', idempotencyKey: 'k' };
  const frames = [
    frameBody({ ...shared, state: 'dispatched' }),
    frameBody({ ...shared, state: 'settled' }),
  ];
  const rows = aggregateByName(frames).rows;
  assert.equal(rows[0].calls, 1);
  assert.deepEqual(rows[0].states, { dispatched: 1, settled: 1 });
});

test('U10 percentiles are nearest-rank over the sorted sample', () => {
  const base = '2026-09-17T03:00:00.000Z';
  const frames = [];
  for (let index = 1; index <= 10; index += 1) {
    frames.push(frameBody({
      attachmentId: `att-${index}`,
      idempotencyKey: `key-${index}`,
      createdAt: base,
      settledAt: isoAt(base, index),
    }));
  }
  const result = aggregateByName(frames);
  assert.deepEqual(result.rows[0].latency, { count: 10, p50Ms: 5, p95Ms: 10 });
});

test('U10b folds a settled-error frame and an unknown-state frame into one pinned row', () => {
  const frames = [
    frameBody({ attachmentId: 'a', idempotencyKey: 'k1', state: 'settled', error: { code: 'E' } }),
    frameBody({ attachmentId: 'b', idempotencyKey: 'k2', state: 'unknown' }),
  ];
  // The pinned row proves the fold itself: a full-output snapshot catches a changed
  // composite, miscounted states, a mis-bucketed error, or a shifted latency sample —
  // none of which a self-comparison could ever see.
  assert.deepEqual(aggregateByName(frames), {
    rows: [
      {
        name: 'anti.browser.evaluate',
        calls: 2,
        frames: 2,
        superseded: 0,
        states: { settled: 1, unknown: 1 },
        errors: { E: 1 },
        latency: { count: 1, p50Ms: 250, p95Ms: 250 },
        excludedLatency: { count: 1, p50Ms: 250, p95Ms: 250 },
        firstSeen: '2026-09-17T03:00:00.000Z',
        lastSeen: '2026-09-17T03:00:00.000Z',
        lowerBound: false,
      },
    ],
    lowerBound: false,
    excludedLatency: { count: 1, p50Ms: 250, p95Ms: 250 },
    firstSeen: '2026-09-17T03:00:00.000Z',
    lastSeen: '2026-09-17T03:00:00.000Z',
  });
});

test('U14 a keyless frame is counted and never folded under an undefined name', () => {
  // The F4 hand-built case: a blank identity means the frame can be admitted but carries no composite.
  // It is unreachable from the reader (the structural guard names it first), which is exactly why this
  // term is measured by the fold and not inferred from a pass.
  const acc = emptyAccumulator();
  foldFrame(acc, frameBody({ attachmentId: '', idempotencyKey: 'k' }), false);
  const reconciliation = reconcile(acc, [], []);

  assert.equal(reconciliation.frames, 1);
  assert.equal(reconciliation.keylessFrames, 1);
  assert.equal(reconciliation.compositeKeys, 0);
  assert.equal(reconciliation.superseded, 0);
  assert.deepEqual(finalizeAggregate(acc).rows, []);
  assert.equal(reconciliation.unattributedByReason.MISSING_IDENTITY_FIELD, 1);
  assert.equal(reconciliation.unattributedKeys, 0);
  assert.equal(reconciliation.unattributedFrames, 1, 'unattributedKeys + keylessFrames');
  assert.equal(reconciliation.holdsFrames, true, 'the keyless term it measured closes the identity');
  assert.equal(reconciliation.holdsKeys, true);
});

test('U15 each reconciliation boolean is falsifiable, and a seeded non-closing case does not throw', () => {
  // A reconciliation that cannot disagree with itself is decoration, so every boolean is asserted
  // false once against an accumulator made deliberately inconsistent, and true once against a closed
  // one. Each seed is a real anomaly: a superseded count no frame backs, a composite key that was
  // never folded, and a roll-up whose two halves do not add up.
  const seeded = emptyAccumulator();
  foldFrame(seeded, frameBody({ attachmentId: 'a', idempotencyKey: 'k1' }), false);
  seeded.superseded += 1;
  const supersededLie = reconcile(seeded, [], []);
  assert.equal(supersededLie.frames, 1);
  assert.equal(supersededLie.compositeKeys, 1);
  assert.equal(supersededLie.superseded, 1);
  assert.equal(supersededLie.holdsFrames, false, '1 != 1 + 1 + 0');
  assert.equal(supersededLie.holdsKeys, true, 'a frame-level lie leaves the key identity standing');

  const phantom = emptyAccumulator();
  foldFrame(phantom, frameBody({ attachmentId: 'b', idempotencyKey: 'k2' }), false);
  phantom.compositeKeys.add('b\u0000phantom');
  const phantomKey = reconcile(phantom, [], []);
  assert.equal(phantomKey.holdsKeys, false, '1 + 0 != 2');
  assert.equal(phantomKey.holdsFrames, false, '1 != 2 + 0');

  let unbalanced;
  assert.doesNotThrow(() => {
    unbalanced = reconcile(emptyAccumulator(), [], [
      { file: 'q.jsonl.quarantine-1', quarantineLike: true, tempLike: false, frames: 3, admitted: 1, namedInvalid: 1 },
    ]);
  });
  assert.equal(unbalanced.holdsMargin, false, '3 != 1 + 1');

  const closed = reconcile(seeded, [], [
    { file: 'q.jsonl.quarantine-1', quarantineLike: true, tempLike: false, frames: 2, admitted: 1, namedInvalid: 1 },
  ]);
  assert.equal(closed.holdsMargin, true);
});

test('U15c the unattributed split always sums to the unattributed frame count', async () => {
  // The published split has to be a partition of the published total, or the panel's two numbers
  // describe different populations: `MISSING_IDENTITY_FIELD` is counted per keyless frame and
  // `MISSING_ROW_KEY` once per uncredited composite, so the sum closes in both directions.
  const emitted = collector();
  const { result } = await passOver({ 'a.jsonl': `${frameLine({ name: '' })}\n` }, { sink: emitted.sink });
  const acc = foldAll(emitted.emitted);
  foldFrame(acc, frameBody({ attachmentId: '', idempotencyKey: 'k' }), false);
  const reconciliation = reconcile(acc, result.residue, result.fileRollups);

  assert.equal(reconciliation.unattributedKeys, 1);
  assert.equal(reconciliation.keylessFrames, 1);
  assert.equal(reconciliation.unattributedFrames, 2);
  assert.equal(
    reconciliation.unattributedByReason.MISSING_ROW_KEY + reconciliation.unattributedByReason.MISSING_IDENTITY_FIELD,
    reconciliation.unattributedFrames,
  );
  assert.equal(reconciliation.holdsFrames, true, 'the keyless term closes the frame identity');
});

test('U15b the two invariant lines are built from the numbers, not from constants', () => {
  const shared = { attachmentId: 'a', idempotencyKey: 'k' };
  const frames = [
    frameBody(shared),
    frameBody(shared),
    frameBody({ attachmentId: 'b', idempotencyKey: 'k2' }),
  ];
  const acc = emptyAccumulator();
  for (const frame of frames) foldFrame(acc, frame, false);
  const reconciliation = reconcile(acc, [], []);

  assert.equal(reconciliation.lines.length, 2);
  assert.equal(
    reconciliation.lines[0],
    `classifiedKeys + unattributedKeys == compositeKeys  (${reconciliation.classifiedKeys} + ${reconciliation.unattributedKeys} == ${reconciliation.compositeKeys})`,
  );
  assert.equal(
    reconciliation.lines[1],
    `frames == compositeKeys + superseded + keylessFrames  (${reconciliation.frames} == ${reconciliation.compositeKeys} + ${reconciliation.superseded} + ${reconciliation.keylessFrames})`,
  );
});

test('U16 the quarantine margin is summed from roll-ups only and its label states the balance', () => {
  const rollups = [
    { file: 'a.jsonl', quarantineLike: false, tempLike: false, frames: 4, admitted: 4, namedInvalid: 0 },
    { file: 'b.jsonl.quarantine-1', quarantineLike: true, tempLike: false, frames: 3, admitted: 2, namedInvalid: 1 },
  ];
  const residue = [
    { file: 'b.jsonl.quarantine-1', class: ResidueClass.CHECKSUM_MISMATCH, reason: ChecksumMismatchReason.WRITER_CANONICALIZATION_ARRAY_SLOT, count: 1, firstLine: 2, firstByteOffset: 100 },
    { file: 'a.jsonl', class: ResidueClass.UNPARSEABLE, reason: UNPARSEABLE_REASON, count: 1, firstLine: 0, firstByteOffset: 0 },
  ];
  const margin = quarantineMargin(rollups, residue);

  assert.equal(margin.files, 1, 'the live file is not margin');
  assert.equal(margin.framesPresent, 3);
  assert.equal(margin.framesAdmitted, 2);
  assert.equal(margin.framesNamedInvalid, 1);
  assert.deepEqual(margin.reasons, [
    { class: ResidueClass.CHECKSUM_MISMATCH, reason: ChecksumMismatchReason.WRITER_CANONICALIZATION_ARRAY_SLOT, count: 1 },
  ]);
  assert.equal(
    margin.label,
    'quarantine margin: present 3 = admitted 2 + named-invalid 1 (CHECKSUM_MISMATCH writer-canonicalization-array-slot 1) \u2014 a margin, not a recovery promise',
  );
  assert.ok(margin.label.includes('not a recovery promise'));
});

test('U17 the residue histogram has one key per non-admitted class, always all of them', () => {
  const histogram = residueHistogram([
    { file: 'a.jsonl', class: ResidueClass.TORN_TAIL, count: 2, firstLine: 1, firstByteOffset: 10 },
    { file: 'a.jsonl', class: ResidueClass.VANISHED, count: 1, firstLine: 0, firstByteOffset: 0 },
  ]);
  assert.deepEqual(Object.keys(histogram), [...NAMED_RESIDUE_CLASSES]);
  assert.equal(histogram.TORN_TAIL, 2);
  assert.equal(histogram.VANISHED, 1);
  assert.equal(histogram.CHECKSUM_MISMATCH, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(histogram, ResidueClass.ADMITTED));
});

// ---------------------------------------------------------------------------------------------
// V — the published vocabulary. A histogram over persisted strings and a row name both become JSON
// *keys* in the payload, and a value-only sanitiser downstream cannot see a key.
// ---------------------------------------------------------------------------------------------

test('V1 the two published-vocabulary rules: isLocationShaped and the histogram token grammar', () => {
  for (const value of [
    'C:\\Users\\Admin\\secrets',
    'C:x',
    '\\\\host\\share',
    '/var/lib/antifan/invocations',
    'file:///c:/x',
    'file:x',
    'a/b',
    'a\\b',
  ]) {
    assert.equal(isLocationShaped(value), true, `${value} must read as location-shaped`);
  }
  for (const value of [
    '2026-08-01T00:00:00.000Z',
    'census:deadbeef#L12',
    'ceiling:MAX_CENSUS_BYTES',
    '1:2',
    'a b:c',
    '',
    'settled',
    'UNKNOWN_ERROR',
  ]) {
    assert.equal(isLocationShaped(value), false, `${value} must not read as location-shaped`);
  }

  // The live vocabulary must survive the token grammar untouched, or the collapse would be a
  // measurement loss: `InvocationState` and the codes the ledger actually writes
  // (`invocation-ledger.ts:579-581`, `:232`, `:240`), plus the fixture's spellings.
  for (const token of [
    'settled',
    'unknown',
    'dispatched',
    'failed',
    'in_progress',
    'completed',
    'interrupted',
    'EXECUTION_UNKNOWN',
    'PROCESS_INTERRUPTED',
    'UNKNOWN_ERROR',
    'store.not_found',
    'HTTP:404',
    '1:2',
    'a-b_c.d',
    'x'.repeat(64),
  ]) {
    assert.ok(HISTOGRAM_TOKEN_PATTERN.test(token), `${token} must be an admissible histogram key`);
  }
  for (const token of [
    '',
    ' ',
    'a/b',
    'a\\b',
    'C:x',
    'C:\\Users',
    '\\\\host\\share',
    '/etc/passwd',
    'file:///c:/x',
    'a b',
    'a\u0000b',
    '\u03a9',
    'x'.repeat(65),
  ]) {
    assert.ok(!HISTOGRAM_TOKEN_PATTERN.test(token), `${token} must not be an admissible histogram key`);
  }

  // The collapse literal is itself an admissible token, so the rule is idempotent: a producer that
  // legitimately used that name is not renamed twice, and the pattern is stateless.
  assert.equal(UNRECOGNIZED_HISTOGRAM_KEY, 'UNRECOGNIZED');
  assert.ok(HISTOGRAM_TOKEN_PATTERN.test(UNRECOGNIZED_HISTOGRAM_KEY));
  assert.equal(HISTOGRAM_TOKEN_PATTERN.flags, '', 'no g/y flag: the shared instance cannot leak lastIndex');
});

test('V2 a path-shaped state or error code publishes as UNRECOGNIZED with every count intact', async () => {
  const hostileState = 'D:\\operator\\private\\state';
  const hostileCode = 'C:\\Users\\Admin\\secrets';
  const driveRelative = 'C:x-no-separator';
  const fileUrl = 'file:///c:/tools';
  const frames = [
    frameLine({
      name: 'anti.browser.hostile',
      attachmentId: 'a',
      idempotencyKey: 'k1',
      state: hostileState,
      error: { code: hostileCode },
    }),
    frameLine({
      name: 'anti.browser.hostile',
      attachmentId: 'b',
      idempotencyKey: 'k2',
      state: hostileState,
      error: { code: driveRelative },
    }),
    frameLine({
      name: 'anti.browser.hostile',
      attachmentId: 'c',
      idempotencyKey: 'k3',
      state: fileUrl,
      error: { code: fileUrl },
    }),
    frameLine({
      name: 'anti.browser.hostile',
      attachmentId: 'd',
      idempotencyKey: 'k4',
      state: 'settled',
      error: { code: 'E_TIMEOUT' },
    }),
  ];
  const { dir } = await passOver({ 'a.jsonl': `${frames.join('\n')}\n` });
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF });
  const row = rowFor(envelope, 'anti.browser.hostile');

  assert.equal(envelope.status, 'MEASURED');
  assert.deepEqual(row.states, { UNRECOGNIZED: 3, settled: 1 });
  assert.deepEqual(row.errors, { E_TIMEOUT: 1, UNRECOGNIZED: 3 });
  // Counts are preserved and sum on collision: the collapse renames keys, it never drops a frame, so
  // the row's own totals are exactly what they would be with a legitimate vocabulary.
  assert.equal(Object.values(row.states).reduce((sum, n) => sum + n, 0), row.frames);
  assert.equal(Object.values(row.errors).reduce((sum, n) => sum + n, 0), row.frames);
  assert.equal(row.calls, 4);
  assert.equal(row.frames, 4);
  assert.equal(row.superseded, 0);
  assert.equal(envelope.reconciliation.holdsFrames, true);
  assert.equal(envelope.reconciliation.holdsKeys, true);
  assert.equal(envelope.totals.residue.CHECKSUM_MISMATCH, 0, 'the crafted frames are checksum-valid');

  // Not one byte of any hostile spelling reaches the payload, as a key or as a value.
  const serialized = JSON.stringify(envelope);
  for (const hostile of [hostileState, hostileCode, driveRelative, fileUrl]) {
    assert.ok(!serialized.includes(hostile), `${hostile} must not appear in the payload`);
  }

  // The control: four frames carrying a legitimate vocabulary. Only the key names differ, so any
  // difference in the totals would mean the collapse lost or double-counted a frame.
  const controlFrames = [
    frameLine({ name: 'anti.browser.hostile', attachmentId: 'a', idempotencyKey: 'k1', state: 'dispatched', error: { code: 'E_TIMEOUT' } }),
    frameLine({ name: 'anti.browser.hostile', attachmentId: 'b', idempotencyKey: 'k2', state: 'dispatched', error: { code: 'E_REPLAY' } }),
    frameLine({ name: 'anti.browser.hostile', attachmentId: 'c', idempotencyKey: 'k3', state: 'failed', error: { code: 'E_REPLAY' } }),
    frameLine({ name: 'anti.browser.hostile', attachmentId: 'd', idempotencyKey: 'k4', state: 'settled', error: { code: 'E_TIMEOUT' } }),
  ];
  const control = await passOver({ 'a.jsonl': `${controlFrames.join('\n')}\n` });
  const controlEnvelope = await accountStore({ storeDir: control.dir, asOf: AS_OF });
  const controlRow = rowFor(controlEnvelope, 'anti.browser.hostile');

  assert.deepEqual(controlRow.errors, { E_REPLAY: 2, E_TIMEOUT: 2 });
  assert.equal(controlRow.calls, row.calls);
  assert.equal(controlRow.frames, row.frames);
  assert.equal(controlRow.superseded, row.superseded);
  assert.equal(
    Object.values(controlRow.states).reduce((sum, n) => sum + n, 0),
    Object.values(row.states).reduce((sum, n) => sum + n, 0),
  );
  assert.equal(
    Object.values(controlRow.errors).reduce((sum, n) => sum + n, 0),
    Object.values(row.errors).reduce((sum, n) => sum + n, 0),
  );
});

test('V3 a location-shaped name is credited to no row, so rows[].name cannot carry a path', async () => {
  const hostileName = 'C:\\Users\\Admin\\tools\\evil';
  const other = '\\\\host\\share\\tool';
  const { dir } = await passOver({
    'a.jsonl': `${frameLine({ name: hostileName })}\n${frameLine({ name: other })}\n${frameLine({ name: 'anti.browser.fine' })}\n`,
  });
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF });

  assert.equal(envelope.status, 'MEASURED');
  assert.deepEqual(envelope.rows.map((row) => row.name), ['anti.browser.fine']);
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes(hostileName));
  assert.ok(!serialized.includes(other));

  // Credited nowhere, and counted there: the key-level identity still closes because the two
  // unattributed composites are in the ledger's own bucket.
  assert.equal(envelope.reconciliation.compositeKeys, 3);
  assert.equal(envelope.reconciliation.classifiedKeys, 1);
  assert.equal(envelope.reconciliation.unattributedKeys, 2);
  assert.equal(envelope.reconciliation.unattributedByReason.MISSING_ROW_KEY, 2);
  assert.equal(envelope.reconciliation.keylessFrames, 0);
  assert.equal(envelope.reconciliation.holdsKeys, true);
  assert.equal(envelope.reconciliation.holdsFrames, true);
});

// ---------------------------------------------------------------------------------------------
// C — the census
// ---------------------------------------------------------------------------------------------

test('C1 the census counts the full matched population and the four-term tautology holds', async () => {
  const { result } = await passOver({
    'live.jsonl': `${frameLine()}\n`,
    'quarantined.jsonl.quarantine-1': `${frameLine()}\n`,
    'inflight.jsonl.tmp-3': `${frameLine()}\n`,
    'backup.jsonl.bak': `${frameLine()}\n`,
    'not-a-partition.txt': 'ignored\n',
  });

  const census = result.census;
  assert.equal(census.fileCount, 4, 'every name containing .jsonl is population');
  assert.equal(census.jsonlCount, 1);
  assert.equal(census.quarantineCount, 1);
  assert.equal(census.tempCount, 1);
  assert.equal(census.otherCount, 1);
  assert.equal(
    census.fileCount,
    census.jsonlCount + census.quarantineCount + census.tempCount + census.otherCount,
  );
  assert.equal(census.fileCount, census.limits.observedFiles);
  assert.equal(census.totalBytes, census.limits.observedBytes);
  assert.equal(census.limits.outcome, 'COMPLETE');
  assert.equal(census.limits.ceiling, null);
  assert.equal(census.files.length, 4);
  assert.ok(census.censusHash !== null);
  assert.equal(result.counters.filesRead, 4);
  assert.equal(result.counters.filesSkipped, 0);
});

test('C2 the census hash is content-derived: mtime alone does not move it, content does', async () => {
  const dir = newStore();
  const first = frameLine({ name: 'anti.browser.alpha' });
  const second = frameLine({ name: 'anti.browser.beta!' });
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(second), 'the rewrite keeps the byte length');

  const full = writeStoreFile(dir, 'a.jsonl', `${first}\n`);
  setMtime(full, STAMP);
  const passOne = await runCensusPass(dir, AS_OF);

  // Same content, different mtime: the hash answers "what content was measured", not "was it touched".
  setMtime(full, STAMP + 60_000);
  const passTwo = await runCensusPass(dir, AS_OF);
  assert.equal(passTwo.census.censusHash, passOne.census.censusHash);

  // Same size, different content: only a content-derived hash can see this.
  writeStoreFile(dir, 'a.jsonl', `${second}\n`);
  setMtime(full, STAMP + 120_000);
  const passThree = await runCensusPass(dir, AS_OF);
  assert.notEqual(passThree.census.censusHash, passTwo.census.censusHash);
  assert.equal(passThree.census.files[0].size, passTwo.census.files[0].size);
});

test('C3 two passes over an unchanged store are identical apart from the pass clock', async () => {
  const { dir, result: first } = await passOver({ 'a.jsonl': `${frameLine()}\n`, 'b.jsonl': `${frameLine()}\n` });
  const second = await runCensusPass(dir, AS_OF);

  assert.equal(second.census.censusHash, first.census.censusHash);
  assert.deepEqual(second.census.files, first.census.files);
  const strip = (census) => ({ ...census, limits: { ...census.limits, elapsedMs: 0 } });
  assert.deepEqual(strip(second.census), strip(first.census));
});

test('C4 no serialized envelope contains an absolute path, a drive letter or a separator-shaped label', async () => {
  const line = frameLine();
  const { dir } = await passOver({ 'a.jsonl': `${line}\n${line.slice(0, line.length - 4)}` });
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF });

  assert.equal(envelope.storePath, storeDisplayLabel(dir));
  assert.ok(!envelope.storePath.includes('/') && !envelope.storePath.includes('\\'));

  const text = JSON.stringify(envelope);
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), 'no drive-letter path in the serialized payload');
  assert.ok(!text.includes(dir), 'the injected directory must not appear anywhere');

  const walk = (value, trail) => {
    if (typeof value === 'string') {
      assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `${trail} is location-shaped: ${value}`);
      assert.ok(!value.startsWith('/'), `${trail} is absolute: ${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, `${trail}.${key}`);
    }
  };
  walk(envelope, 'envelope');

  // The census has no directory field at all: the reader is handed the store as an argument.
  assert.ok(!Object.prototype.hasOwnProperty.call(envelope.census, 'dir'));
  for (const member of envelope.affected) {
    assert.ok(!member.includes('/') && !member.includes('\\'), `affected member is path-shaped: ${member}`);
  }
});

test('C5 the reader never writes: the store tree is byte-identical across a full pass', async () => {
  const dir = newStore();
  writeStoreFile(dir, 'a.jsonl', `${frameLine()}\n`);
  writeStoreFile(dir, 'b.jsonl.quarantine-1', `${frameLine({}, () => 'nope')}\n`);
  const before = treeHash(dir);

  await accountStore({ storeDir: dir, asOf: AS_OF });
  assert.equal(treeHash(dir), before);
});

test('C6 the module is structurally read-only and imports nothing that could reach a writer', () => {
  const source = fs.readFileSync(MODULE_SOURCE_PATH, 'utf8');
  const emit = fs.readFileSync(MODULE_EMIT_PATH, 'utf8');

  // A closed import list: the module may reach the seam, its own contract and Node's read-only
  // primitives, and nothing else. `invocation-ledger` in particular is the writer — importing it for a
  // constant would put the store's own read-modify-write path one call away from a reader.
  const specifiers = new Set();
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) specifiers.add(match[1]);
  assert.deepEqual([...specifiers].sort(), [
    '../../shared/mcp-dispatch-contracts',
    '../session/invocation-frame-checksum',
    'node:crypto',
    'node:fs',
    'node:path',
    'node:worker_threads',
  ]);
  for (const forbidden of ['invocation-ledger', 'control-plane-runtime', 'capability-transport', 'electron']) {
    assert.ok(!new RegExp(`require\\(['"][^'"]*${forbidden}`).test(emit), `the emit must not require ${forbidden}`);
  }

  // Every filesystem member this module touches, taken from the source itself, must be read-only. The
  // scan is bounded by a word boundary so an ordinary `stats.push(...)` is not read as a filesystem
  // call, and it is an allowlist rather than a shape check: a write has to appear by name to pass.
  const READ_ONLY_MEMBERS = new Set(['readdirSync', 'statSync', 'stat', 'open', 'Stats']);
  const members = new Set();
  for (const match of source.matchAll(/\bfs\.promises\.([A-Za-z_$]+)|\bfs\.([A-Za-z_$]+)/g)) {
    members.add(match[1] ?? match[2]);
  }
  assert.ok(members.size > 0, 'the scan must actually find the module\'s filesystem calls');
  for (const member of members) {
    assert.ok(READ_ONLY_MEMBERS.has(member), `fs.${member} is not a read-only member`);
  }
});

test('C7 the pass returns counters, roll-ups and bounded residue — never a frame array', async () => {
  const emitted = collector();
  const dir = newStore();
  writeStoreFile(dir, 'a.jsonl', `${frameLine()}\n${frameLine()}\n`);
  const result = await runCensusPass(dir, AS_OF, { sink: emitted.sink });

  assert.deepEqual(Object.keys(result), ['census', 'fileRollups', 'residue', 'counters']);
  assert.deepEqual(Object.keys(result.counters), [
    'outcome',
    'admittedTotal',
    'distinctComposites',
    'superseded',
    'keylessFrames',
    'bytesRead',
    'linesRead',
    'filesRead',
    'filesSkipped',
    'ceiling',
    'drift',
    'yields',
    'labels',
  ]);
  assert.equal(result.counters.admittedTotal, emitted.emitted.length, 'every admitted frame reached the sink once');
  assert.equal(result.counters.admittedTotal, 2);
  assert.equal(
    result.fileRollups.reduce((sum, rollup) => sum + rollup.admitted, 0),
    emitted.emitted.length,
    'the roll-ups account for exactly the emitted frames',
  );
  assert.ok(!Object.values(result).some((value) => Array.isArray(value) && value.some((item) => item && item.frame)));
  assert.ok(
    !Object.values(result.counters).some((value) => Array.isArray(value)),
    'no counter is a frame array either',
  );

  // The reader's own frozen seven-member result, driven directly: stage B is reusable on its own, and
  // re-reading the same census bytes yields the same counters, residue and roll-ups.
  const again = collector();
  const readResult = await readAdmittedFrames(result.census, again.sink, { storeDir: dir });
  assert.deepEqual(Object.keys(readResult), [
    'admittedTotal',
    'residue',
    'fileRollups',
    'labels',
    'distinctComposites',
    'superseded',
    'drift',
  ]);
  assert.equal(readResult.admittedTotal, result.counters.admittedTotal);
  assert.equal(readResult.distinctComposites, result.counters.distinctComposites);
  assert.equal(readResult.superseded, result.counters.superseded);
  assert.deepEqual(readResult.residue, result.residue);
  assert.deepEqual(readResult.fileRollups, result.fileRollups);
  assert.deepEqual(readResult.labels, result.counters.labels);

  // The stage-B core has one name and one call site, and the materialized-array helper is test-only:
  // across the whole `src/` tree `aggregateByName` appears exactly once, as its own definition, so
  // every call site in the repository lives under `test/`. Comments are stripped first — this module
  // documents its own single-call-site rule, and a doc reference is not a call site — and the scan
  // reads the source files, never a compiled copy.
  const code = stripComments(fs.readFileSync(MODULE_SOURCE_PATH, 'utf8'));
  assert.equal(
    [...code.matchAll(/(?<!function )readAdmittedFrames\(/g)].length,
    1,
    'exactly one call site, inside the pass core',
  );
  assert.equal(readFramesIncremental, readAdmittedFrames, 'one function, two names');

  const srcFiles = sourceFilesUnder(path.join(REPO_ROOT, 'src'));
  assert.ok(srcFiles.length > 50, 'the source scan must actually cover the tree');
  let definitions = 0;
  let productionCalls = 0;
  for (const file of srcFiles) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    definitions += [...text.matchAll(/function aggregateByName\(/g)].length;
    productionCalls += [...text.matchAll(/(?<!function )aggregateByName\(/g)].length;
  }
  assert.equal(definitions, 1, 'one definition, in this module');
  assert.equal(productionCalls, 0, 'no production call site: the materialized array is test-only');
  assert.ok(
    /aggregateByName\(/.test(fs.readFileSync(TEST_SOURCE_PATH, 'utf8')),
    'this lane is where the test-only form is exercised',
  );
});

// ---------------------------------------------------------------------------------------------
// P / R — population and roll-ups
// ---------------------------------------------------------------------------------------------

test('P1 the population is the census and not a re-filter: a .jsonl.bak entry is read', async () => {
  const emitted = collector();
  const { result } = await passOver({ 'decoy.jsonl.bak': `${frameLine()}\n` }, { sink: emitted.sink });

  assert.equal(result.counters.admittedTotal, 1, 'an entry whose name merely contains .jsonl is population');
  assert.equal(censusEntry(result.census, 'decoy.jsonl.bak').bucket, 'other');
  assert.equal(emitted.emitted[0].file, 'decoy.jsonl.bak');
});

test('P2 the name-derived labels are labels: they never change the admitted set', async () => {
  const line = frameLine();
  const live = await passOver({ 'part.jsonl': `${line}\n` });
  const quarantined = await passOver({ 'part.jsonl.quarantine-1': `${line}\n` });

  assert.equal(live.result.counters.admittedTotal, quarantined.result.counters.admittedTotal);
  assert.equal(live.result.fileRollups[0].quarantineLike, false);
  assert.equal(quarantined.result.fileRollups[0].quarantineLike, true);

  const liveMargin = quarantineMargin(live.result.fileRollups, live.result.residue);
  const quarantinedMargin = quarantineMargin(quarantined.result.fileRollups, quarantined.result.residue);
  assert.equal(liveMargin.files, 0);
  assert.equal(quarantinedMargin.files, 1);
  assert.ok(quarantinedMargin.label.includes('present 1 = admitted 1 + named-invalid 0'));
});

test('R1 every roll-up carries one entry per file actually read and closes', async () => {
  const { result } = await passOver({
    'a.jsonl': `${frameLine()}\n`,
    'b.jsonl': `${frameLine()}\nbroken\n`,
    'empty.jsonl': '',
  });

  assert.equal(result.fileRollups.length, result.census.files.length);
  for (const rollup of result.fileRollups) {
    assert.equal(rollup.frames, rollup.admitted + rollup.namedInvalid, `${rollup.file} must close`);
  }
  assert.equal(
    result.fileRollups.reduce((sum, rollup) => sum + rollup.frames, 0),
    result.counters.linesRead,
  );
  assert.equal(result.counters.linesRead, result.census.files.reduce((sum, entry) => sum + entry.lineCount, 0));
});

// ---------------------------------------------------------------------------------------------
// X — the pass, its ceilings, its failures and its worker
// ---------------------------------------------------------------------------------------------

test('X1 a clean store is MEASURED/OK with the frozen envelope, totals and reconciliation key sets', async () => {
  const line = frameLine();
  const { dir } = await passOver({ 'a.jsonl': `${line}\n` });
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF });

  assert.equal(envelope.status, 'MEASURED');
  assert.equal(envelope.reasonCode, MEASURED_REASON_CODE);
  assert.deepEqual(envelope.affected, []);
  assert.deepEqual(Object.keys(envelope), [
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
  ]);
  assert.deepEqual(Object.keys(envelope.census), [
    'asOf',
    'files',
    'fileCount',
    'jsonlCount',
    'quarantineCount',
    'tempCount',
    'otherCount',
    'totalBytes',
    'censusHash',
    'limits',
  ]);
  assert.deepEqual(Object.keys(envelope.census.limits), [
    'budgetMs',
    'maxBytes',
    'maxFiles',
    'observedBytes',
    'observedFiles',
    'filesRead',
    'filesSkipped',
    'ceiling',
    'windowNewestMtimeMs',
    'windowOldestMtimeMs',
    'elapsedMs',
    'outcome',
  ]);
  assert.deepEqual(Object.keys(envelope.census.files[0]), [
    'name',
    'bucket',
    'size',
    'mtimeMs',
    'lineCount',
    'sha256',
    'consistency',
  ]);
  assert.deepEqual(Object.keys(envelope.totals), [
    'residue',
    'quarantineMargin',
    'retention',
    'excludedLatency',
    'unattributedByReason',
    'truncation',
  ]);
  assert.deepEqual(Object.keys(envelope.totals.residue), [...NAMED_RESIDUE_CLASSES]);
  assert.deepEqual(Object.keys(envelope.totals.retention), ['firstSeen', 'lastSeen', 'note']);
  assert.equal(envelope.totals.retention.note, RETENTION_NOTE);
  assert.deepEqual(Object.keys(envelope.reconciliation), [
    'classifiedKeys',
    'unattributedKeys',
    'unattributedFrames',
    'unattributedByReason',
    'keylessFrames',
    'compositeKeys',
    'frames',
    'superseded',
    'holdsKeys',
    'holdsFrames',
    'holdsMargin',
    'lines',
  ]);
  assert.deepEqual(Object.keys(envelope.rows[0]), [
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
  ]);
  for (const rollup of envelope.fileRollups) {
    assert.deepEqual(Object.keys(rollup), ['file', 'quarantineLike', 'tempLike', 'frames', 'admitted', 'namedInvalid']);
  }

  assert.equal(envelope.reconciliation.holdsKeys, true);
  assert.equal(envelope.reconciliation.holdsFrames, true);
  assert.equal(envelope.reconciliation.holdsMargin, true);
  assert.equal(envelope.rows[0].lowerBound, false);
  assert.equal(envelope.rows[0].calls, 1);
  assert.equal(envelope.rows[0].frames, 1);
  assert.equal(envelope.rows[0].superseded, 0);
  assert.equal(envelope.totals.truncation, null);
  assert.equal(envelope.census.limits.ceiling, null);
  assert.equal(envelope.census.limits.filesRead, 1);
  assert.equal(envelope.census.limits.filesSkipped, 0);
  assert.equal(envelope.census.limits.windowNewestMtimeMs, envelope.census.files[0].mtimeMs);
  assert.equal(envelope.census.limits.windowOldestMtimeMs, envelope.census.files[0].mtimeMs);
  assert.equal(envelope.census.limits.maxBytes, MAX_CENSUS_BYTES);
  assert.equal(envelope.census.limits.maxFiles, MAX_CENSUS_FILES);
  assert.equal(envelope.census.limits.budgetMs, PASS_BUDGET_MS);
  assert.equal(envelope.census.limits.observedFiles, 1);
  assert.ok(Number.isFinite(envelope.census.limits.elapsedMs));
});

test('X2 one UNMEASURED envelope carries the same key set as the MEASURED one, in the same order', async () => {
  const { dir } = await passOver({ 'a.jsonl': `${frameLine()}\n` });
  const measured = await accountStore({ storeDir: dir, asOf: AS_OF });
  const unmeasured = unmeasuredEnvelope(UnmeasuredReason.READ_BUDGET_EXCEEDED, [AffectedToken.BUDGET_EXPIRED], 'invocations', { asOf: AS_OF });

  assert.deepEqual(Object.keys(unmeasured), Object.keys(measured));
  assert.equal(unmeasured.status, 'UNMEASURED');
  assert.equal(unmeasured.reasonCode, UnmeasuredReason.READ_BUDGET_EXCEEDED);
  assert.deepEqual(unmeasured.affected, ['budget-expired']);
  assert.deepEqual(unmeasured.rows, []);
  assert.equal(unmeasured.totals, null);
  assert.equal(unmeasured.reconciliation, null);
  assert.equal(unmeasured.census, null);
  assert.equal(unmeasured.storePath, 'invocations');
  assert.deepEqual(unmeasured.evidenceRefs, []);
});

test('X4 a file that vanishes after the sweep is named, the pass survives, and it is no roll-up', async () => {
  const dir = newStore();
  const survivor = frameLine({ name: 'anti.browser.survivor' });
  writeStoreFile(dir, 'a-live.jsonl', `${survivor}\n`);
  const vanishing = path.join(dir, 'z-gone.jsonl');
  writeStoreFile(dir, 'z-gone.jsonl', `${frameLine({ name: 'anti.browser.gone' })}\n`);

  const envelope = await accountStore({
    storeDir: dir,
    asOf: AS_OF,
    hooks: {
      afterPopulationSweep: (name) => {
        if (name === 'z-gone.jsonl') fs.rmSync(vanishing, { force: true });
      },
    },
  });

  assert.equal(envelope.status, 'MEASURED');
  const entry = censusEntry(envelope.census, 'z-gone.jsonl');
  assert.equal(entry.consistency, 'vanished');
  assert.equal(entry.size, 0);
  assert.equal(entry.lineCount, 0);
  assert.equal(entry.sha256, sha256Hex(Buffer.alloc(0)));
  assert.equal(envelope.fileRollups.length, 1, 'a file that was never read is no roll-up');
  assert.equal(envelope.fileRollups[0].file, 'a-live.jsonl');
  assert.equal(envelope.totals.residue.VANISHED, 1);
  assert.equal(envelope.rows.length, 1);
  assert.equal(envelope.rows[0].lowerBound, true, 'a vanished file makes every count a floor');
  assert.equal(envelope.reconciliation.holdsMargin, true);
  assert.equal(envelope.rows[0].name, 'anti.browser.survivor');
});

test('X5 the byte ceiling truncates newest-first, discloses itself and makes every row a floor', async () => {
  const dir = newStore();
  const names = ['anti.browser.oldest', 'anti.browser.middle', 'anti.browser.newest'];
  const sizes = [];
  names.forEach((name, index) => {
    const text = `${frameLine({ name })}\n`;
    const full = writeStoreFile(dir, `part-${index}.jsonl`, text);
    setMtime(full, STAMP + index * 1000);
    sizes.push(Buffer.byteLength(text));
  });

  const envelope = await accountStore({
    storeDir: dir,
    asOf: AS_OF,
    limits: { maxBytes: sizes[1] + sizes[2] },
  });

  assert.equal(envelope.status, 'MEASURED');
  assert.equal(envelope.census.limits.ceiling, 'MAX_CENSUS_BYTES');
  assert.equal(envelope.census.limits.filesRead, 2);
  assert.equal(envelope.census.limits.filesSkipped, 1);
  assert.equal(envelope.census.fileCount, 3, 'the full matched population is still counted');
  assert.equal(envelope.census.files.length, 2, 'the read set is what was read');
  assert.equal(envelope.census.limits.outcome, 'POPULATION_TRUNCATED');
  assert.equal(envelope.totals.truncation.ceiling, 'MAX_CENSUS_BYTES');
  assert.equal(envelope.totals.truncation.filesRead, 2);
  assert.equal(envelope.totals.truncation.filesSkipped, 1);
  assert.equal(envelope.totals.truncation.order, TRUNCATION_ORDER);
  assert.equal(envelope.totals.truncation.label, 'partial: 2 of 3 files');
  assert.deepEqual(envelope.rows.map((row) => row.name).sort(), ['anti.browser.middle', 'anti.browser.newest']);
  assert.ok(envelope.rows.every((row) => row.lowerBound === true));
  assert.equal(envelope.fileRollups.length, 2, 'a skipped file is no roll-up');
  assert.equal(envelope.totals.quarantineMargin.files, 0);
  assert.ok(envelope.census.limits.windowNewestMtimeMs > envelope.census.limits.windowOldestMtimeMs);
});

test('X6 the file-count ceiling is the same shape under a different name', async () => {
  const dir = newStore();
  for (let index = 0; index < 3; index += 1) {
    const full = writeStoreFile(dir, `part-${index}.jsonl`, `${frameLine({ name: `anti.browser.n${index}` })}\n`);
    setMtime(full, STAMP + index * 1000);
  }
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF, limits: { maxFiles: 2 } });

  assert.equal(envelope.status, 'MEASURED');
  assert.equal(envelope.census.limits.ceiling, 'MAX_CENSUS_FILES');
  assert.equal(envelope.census.limits.filesRead, 2);
  assert.equal(envelope.census.limits.filesSkipped, 1);
  assert.equal(envelope.totals.truncation.ceiling, 'MAX_CENSUS_FILES');
  assert.equal(envelope.totals.truncation.label, 'partial: 2 of 3 files');
  assert.ok(envelope.rows.every((row) => row.lowerBound === true));
});

test('X7 a same-size rewrite with a new mtime is CENSUS_DRIFT: UNMEASURED, no rows, no totals', async () => {
  const dir = newStore();
  const before = frameLine({ name: 'anti.browser.aaa' });
  const after = frameLine({ name: 'anti.browser.bbb' });
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  const full = writeStoreFile(dir, 'a.jsonl', `${before}\n`);
  setMtime(full, STAMP);

  const hooks = {
    afterRead: (name) => {
      if (name === 'a.jsonl') fs.writeFileSync(full, `${after}\n`);
    },
  };
  // Every pass gets a pristine store. The hook rewrites the partition, so reusing one store would
  // measure the second pass against bytes the first pass had already replaced — equal content, which
  // is `rewritten-identical`, a different verdict carrying a different reason code.
  const prepare = () => {
    fs.writeFileSync(full, `${before}\n`);
    setMtime(full, STAMP);
  };

  prepare();
  const pass = await runCensusPass(dir, AS_OF, { hooks });
  assert.equal(pass.counters.outcome, 'CENSUS_DRIFT');
  assert.ok(pass.counters.drift.includes('a.jsonl'));
  assert.ok(pass.census !== null, 'the census that detected the drift is still published');

  prepare();
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF, hooks });
  assert.equal(envelope.status, 'UNMEASURED');
  assert.equal(envelope.reasonCode, UnmeasuredReason.CENSUS_DRIFT);
  assert.deepEqual(envelope.affected, [AffectedToken.CENSUS_DRIFT, storeDisplayLabel(dir)]);
  assert.deepEqual(envelope.rows, []);
  assert.equal(envelope.totals, null);
  assert.equal(envelope.reconciliation, null);
  assert.ok(envelope.census !== null, 'the drift verdict ships its evidence');
  assert.equal(envelope.census.files[0].sha256, sha256Hex(Buffer.from(`${before}\n`, 'utf8')));
});

test('X8 a rewrite that preserves size and mtime is invisible: clean, and the earlier hash stands', async () => {
  const dir = newStore();
  const before = frameLine({ name: 'anti.browser.aaa' });
  const after = frameLine({ name: 'anti.browser.bbb' });
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  const full = writeStoreFile(dir, 'a.jsonl', `${before}\n`);
  setMtime(full, STAMP);

  const first = await runCensusPass(dir, AS_OF);
  assert.equal(first.census.files[0].consistency, 'clean');

  // The rewrite lands inside the pass — after the read, before the post-read checkpoint — and it puts
  // the size and the whole-millisecond mtime back exactly as they were. A size+mtime checkpoint cannot
  // see this, so the pass reports `clean` and publishes the digest of the bytes it actually read. This
  // row documents the hole in the checkpoint rather than pretending the check is total.
  const second = await runCensusPass(dir, AS_OF, {
    hooks: {
      afterRead: (name) => {
        if (name !== 'a.jsonl') return;
        fs.writeFileSync(full, `${after}\n`);
        setMtime(full, STAMP);
      },
    },
  });

  assert.equal(fs.statSync(full).mtimeMs, STAMP, 'the fixture proves the filesystem kept the stamp');
  assert.equal(second.census.files[0].consistency, 'clean');
  assert.equal(second.census.files[0].sha256, sha256Hex(Buffer.from(`${before}\n`, 'utf8')));
  assert.equal(second.census.censusHash, first.census.censusHash);
  assert.equal(second.counters.drift, null);

  // The window really did change on disk, so the next undisturbed pass reads the new bytes: the hole
  // belongs to the pass that raced the rewrite, not to the reader.
  const third = await runCensusPass(dir, AS_OF);
  assert.equal(third.census.files[0].consistency, 'clean');
  assert.equal(third.census.files[0].sha256, sha256Hex(Buffer.from(`${after}\n`, 'utf8')));
  assert.notEqual(third.census.censusHash, first.census.censusHash);
});

test('X9 a truncation between the sweep and the read is POST_CENSUS_TRUNCATE, never a broken identity', async () => {
  const dir = newStore();
  const kept = frameLine({ name: 'anti.browser.kept' });
  const lost = frameLine({ name: 'anti.browser.lost' });
  const trimmed = `${kept}\n`;
  writeStoreFile(dir, 'a.jsonl', `${kept}\n${lost}\n`);

  const envelope = await accountStore({
    storeDir: dir,
    asOf: AS_OF,
    hooks: {
      afterPopulationSweep: (name) => {
        if (name === 'a.jsonl') fs.writeFileSync(path.join(dir, 'a.jsonl'), trimmed);
      },
    },
  });

  assert.equal(envelope.status, 'MEASURED');
  assert.equal(envelope.totals.residue.POST_CENSUS_TRUNCATE, 1);
  assert.equal(envelope.census.files[0].consistency, 'post-census-truncate');
  assert.equal(envelope.census.files[0].size, Buffer.byteLength(trimmed, 'utf8'));
  assert.equal(envelope.fileRollups[0].frames, envelope.fileRollups[0].admitted + envelope.fileRollups[0].namedInvalid);
  assert.deepEqual(envelope.rows.map((row) => row.name), ['anti.browser.kept']);
  assert.equal(envelope.rows[0].lowerBound, true);
});

test('X10 an append that completes a multi-byte character is TORN_TAIL plus POST_CENSUS_APPEND', async () => {
  const dir = newStore();
  const kept = frameLine({ name: 'anti.browser.kept' });
  const torn = frameLine({ name: 'anti.browser.Ω-torn' });
  const bytes = Buffer.from(`${kept}\n${torn}\n`, 'utf8');
  const multiByteAt = bytes.indexOf(Buffer.from('\u03a9', 'utf8'));
  assert.ok(multiByteAt > 0, 'the fixture must contain a multi-byte character');
  const cut = multiByteAt + 1;
  const initial = bytes.subarray(0, cut);
  const appended = bytes.subarray(cut);
  const full = writeStoreFile(dir, 'a.jsonl', initial);

  const pass = await runCensusPass(dir, AS_OF, {
    hooks: {
      afterPopulationSweep: (name) => {
        if (name === 'a.jsonl') fs.writeFileSync(full, bytes);
      },
    },
  });

  assert.equal(pass.counters.admittedTotal, 1, 'the intact frame is still measured');
  assert.equal(residueTotal(pass, ResidueClass.TORN_TAIL), 1);
  assert.equal(residueTotal(pass, ResidueClass.UNPARSEABLE), 0, 'a boundary cut is not a malformed frame');
  assert.equal(residueTotal(pass, ResidueClass.CHECKSUM_MISMATCH), 0);
  const append = residueFor(pass, 'a.jsonl', ResidueClass.POST_CENSUS_APPEND);
  assert.equal(append.bytes, appended.length, 'the appended bytes are disclosed, not parsed');

  const entry = censusEntry(pass.census, 'a.jsonl');
  assert.equal(entry.consistency, 'post-census-append');
  assert.equal(entry.size, initial.length, 'the censused window is the bytes the pass read');
  assert.equal(entry.sha256, sha256Hex(initial), 'the probe bytes are never hashed');
  assert.equal(entry.lineCount, 2, 'the counted frames come from the window, not from the append');
  const tornTail = residueFor(pass, 'a.jsonl', ResidueClass.TORN_TAIL);
  assert.equal(tornTail.firstByteOffset, Buffer.byteLength(`${kept}\n`, 'utf8'), 'byte offsets stay exact');
});

test('X11 an append of a complete frame is disclosed and never admitted', async () => {
  const dir = newStore();
  const kept = frameLine({ name: 'anti.browser.kept' });
  const appended = frameLine({ name: 'anti.browser.late' });
  const full = writeStoreFile(dir, 'a.jsonl', `${kept}\n`);

  const envelope = await accountStore({
    storeDir: dir,
    asOf: AS_OF,
    hooks: {
      afterPopulationSweep: (name) => {
        if (name === 'a.jsonl') fs.appendFileSync(full, `${appended}\n`);
      },
    },
  });

  assert.equal(envelope.totals.residue.POST_CENSUS_APPEND, 1);
  assert.deepEqual(envelope.rows.map((row) => row.name), ['anti.browser.kept']);
  assert.equal(envelope.census.files[0].lineCount, 1);
  assert.equal(envelope.census.files[0].consistency, 'post-census-append');
  assert.equal(envelope.rows[0].lowerBound, true);
});

test('X12 a degenerate ceiling reads nothing and is UNMEASURED with the census as its evidence', async () => {
  const { dir } = await passOver({ 'a.jsonl': `${frameLine()}\n` });
  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF, limits: { maxBytes: 0 } });

  assert.equal(envelope.status, 'UNMEASURED');
  assert.equal(envelope.reasonCode, UnmeasuredReason.POPULATION_TRUNCATED);
  assert.deepEqual(envelope.affected, [AffectedToken.POPULATION_TRUNCATED, storeDisplayLabel(dir)]);
  assert.deepEqual(envelope.rows, []);
  assert.equal(envelope.totals, null);
  assert.equal(envelope.reconciliation, null);
  assert.ok(envelope.census !== null, 'limits.filesRead === 0 is the answer, so it must be published');
  assert.equal(envelope.census.limits.filesRead, 0);
  assert.equal(envelope.census.limits.filesSkipped, 1);
  assert.equal(envelope.census.limits.ceiling, 'MAX_CENSUS_BYTES');
  assert.equal(envelope.census.limits.outcome, 'POPULATION_TRUNCATED');
  assert.equal(envelope.census.censusHash, null);
  assert.equal(envelope.census.limits.windowNewestMtimeMs, null);
  assert.equal(envelope.census.limits.windowOldestMtimeMs, null);
  assert.deepEqual(envelope.census.files, []);
  assert.equal(envelope.census.fileCount, 1);
});

test('X13 a budget expiry discards the partial fold: no census, no rows, no totals', async () => {
  const dir = newStore();
  writeStoreFile(dir, 'a.jsonl', `${frameLine()}\n`);
  writeStoreFile(dir, 'b.jsonl', `${frameLine()}\n`);

  // A clock that advances 30ms per read with a 50ms budget: the first file is read, the second is not.
  let ticks = 0;
  const clock = () => (ticks += 30);
  const emitted = collector();
  const pass = await runCensusPass(dir, AS_OF, { clock, limits: { budgetMs: 50 }, sink: emitted.sink });

  assert.equal(pass.counters.outcome, 'READ_BUDGET_EXCEEDED');
  assert.equal(pass.census, null);
  assert.equal(emitted.emitted.length, 1, 'frames were folded before the budget ran out…');

  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF, clock, limits: { budgetMs: 50 } });
  assert.equal(envelope.status, 'UNMEASURED');
  assert.equal(envelope.reasonCode, UnmeasuredReason.READ_BUDGET_EXCEEDED);
  assert.deepEqual(envelope.affected, [AffectedToken.BUDGET_EXPIRED, storeDisplayLabel(dir)]);
  assert.equal(envelope.census, null);
  assert.deepEqual(envelope.rows, [], '…and the partial fold is discarded, not published');
  assert.equal(envelope.totals, null);
  assert.equal(envelope.reconciliation, null);
  assert.deepEqual(envelope.fileRollups, []);
});

test('X14 the worker and in-process passes publish byte-identical envelopes apart from the clock', async () => {
  const dir = newStore();
  const quarantined = `${frameLine()}\n${frameLine({}, () => 'bad')}\nnot json\n`;
  writeStoreFile(dir, 'a.jsonl', `${frameLine({ name: 'anti.browser.alpha' })}\n`);
  writeStoreFile(dir, 'b.jsonl.quarantine-1', quarantined);
  writeStoreFile(dir, 'c.jsonl.tmp-1', `${frameLine()}\n`);

  const inProcess = await accountStore({ storeDir: dir, asOf: AS_OF, mode: 'in-process' });

  const messages = await new Promise((resolve, reject) => {
    const worker = new Worker(MODULE_EMIT_PATH, { workerData: { storeDir: dir, asOf: AS_OF, mode: 'worker' } });
    const received = [];
    worker.on('message', (message) => received.push(message));
    worker.on('error', reject);
    worker.on('exit', () => resolve(received));
  });

  assert.equal(messages.length, 1, 'the worker posts exactly one message');
  assert.equal(inProcess.status, 'MEASURED');
  assert.equal(messages[0].status, 'MEASURED');

  const normalize = (envelope) => JSON.parse(JSON.stringify({
    ...envelope,
    census: { ...envelope.census, limits: { ...envelope.census.limits, elapsedMs: 0 } },
  }));
  assert.equal(
    JSON.stringify(normalize(messages[0])),
    JSON.stringify(normalize(inProcess)),
    'worker and in-process mode must publish the same bytes',
  );
});

test('X14b in-process mode yields every 25 files and worker mode does not', async () => {
  const dir = newStore();
  // Explicit ascending mtimes make the read order deterministic — newest first — so the 25th file read
  // is index 29 - 24 = 5 regardless of how fast the fixture was written.
  for (let index = 0; index < 30; index += 1) {
    const full = writeStoreFile(dir, `part-${String(index).padStart(2, '0')}.jsonl`, `${frameLine({ name: `anti.browser.n${index}` })}\n`);
    setMtime(full, STAMP + index * 1000);
  }

  const yields = [];
  const inProcess = await runCensusPass(dir, AS_OF, {
    mode: 'in-process',
    hooks: { onYield: (fileIndex, name) => yields.push([fileIndex, name]) },
  });
  assert.equal(inProcess.counters.filesRead, 30);
  assert.equal(inProcess.counters.yields, 1);
  assert.deepEqual(yields, [[IN_PROCESS_YIELD_INTERVAL_FILES, 'part-05.jsonl']]);
  assert.equal(inProcess.census.limits.windowNewestMtimeMs, STAMP + 29 * 1000);

  const worker = await runCensusPass(dir, AS_OF, { mode: 'worker' });
  assert.equal(worker.counters.yields, 0);
  assert.equal(worker.counters.admittedTotal, inProcess.counters.admittedTotal, 'pacing changes no measurement');
  assert.equal(worker.census.censusHash, inProcess.census.censusHash);
});

test('X16 the census hash covers exactly the bytes the pass read', async () => {
  const dir = newStore();
  const sizes = [];
  for (let index = 0; index < 3; index += 1) {
    const text = `${frameLine({ name: `anti.browser.n${index}` })}\n`;
    const full = writeStoreFile(dir, `part-${index}.jsonl`, text);
    setMtime(full, STAMP + index * 1000);
    sizes.push(Buffer.byteLength(text));
  }

  const full = await runCensusPass(dir, AS_OF);
  const partial = await runCensusPass(dir, AS_OF, { limits: { maxBytes: sizes[1] + sizes[2] } });

  assert.equal(
    partial.counters.bytesRead,
    partial.census.files.reduce((sum, entry) => sum + entry.size, 0),
    'the byte accounting identity holds',
  );
  assert.ok(partial.counters.bytesRead <= partial.census.limits.maxBytes);
  assert.equal(partial.census.files.length, partial.census.limits.filesRead);
  assert.notEqual(partial.census.censusHash, full.census.censusHash, 'a partial census is not a full one');
  assert.equal(
    full.counters.bytesRead,
    full.census.limits.observedBytes,
    'a complete pass accounts for the whole population',
  );
  assert.equal(full.counters.linesRead, full.counters.admittedTotal, 'one frame per line in this fixture');
});

// ---------------------------------------------------------------------------------------------
// Integration — every residue class in one store, then every failure mode
// ---------------------------------------------------------------------------------------------

test('INT1 one store carrying every residue class still closes its reconciliation', async () => {
  clearAccountMemo();
  const dir = newStore();
  const valid = frameLine({ name: 'anti.browser.valid' });
  const withNullSlot = frameBody({ result: { items: [null, 1] } });
  const variantLine = JSON.stringify({ ...withNullSlot, checksum: computeFrameChecksumNullArrayVariant(withNullSlot) });
  const blankIdentity = frameBody({ attachmentId: '' });
  const futureVersion = frameBody({ formatVersion: 2 });
  const noChecksum = frameBody();

  // A quarantined partition carrying admitted frames *and* every named-invalid class. The last line is
  // left unterminated on purpose: a window that does not end in a newline is the only way a torn tail
  // is reachable, and a terminated but malformed line is plain `UNPARSEABLE` instead.
  writeStoreFile(dir, 'q.jsonl.quarantine-1', [
    valid,
    variantLine,
    JSON.stringify({ ...blankIdentity, checksum: computeFrameChecksum(blankIdentity) }),
    JSON.stringify({ ...futureVersion, checksum: computeFrameChecksum(futureVersion) }),
    JSON.stringify({ ...noChecksum, checksum: 123 }),
    'null',
    `${valid.slice(0, valid.length - 4)}`,
  ].join('\n'));
  // A live partition that grows after the sweep, and a live partition that is removed after it.
  writeStoreFile(dir, 'b.jsonl', `${frameLine({ name: 'anti.browser.second' })}\n`);
  writeStoreFile(dir, 'c.jsonl', `${frameLine({ name: 'anti.browser.third' })}\n`);

  const envelope = await accountStore({
    storeDir: dir,
    asOf: AS_OF,
    hooks: {
      afterPopulationSweep: (name) => {
        if (name === 'b.jsonl') fs.appendFileSync(path.join(dir, 'b.jsonl'), `${frameLine()}\n`);
        if (name === 'c.jsonl') fs.rmSync(path.join(dir, 'c.jsonl'), { force: true });
      },
    },
  });

  assert.equal(envelope.status, 'MEASURED');
  assert.equal(envelope.reasonCode, MEASURED_REASON_CODE);
  assert.equal(envelope.totals.residue.POST_CENSUS_APPEND, 1);
  assert.equal(envelope.totals.residue.VANISHED, 1);
  assert.equal(envelope.totals.residue.TORN_TAIL, 1);
  assert.equal(envelope.totals.residue.UNPARSEABLE, 0, 'an unterminated tail is torn, not malformed');
  assert.equal(envelope.totals.residue.STRUCTURAL_INVALID, 3, 'a blank identity, a future version, and a null line');
  assert.equal(envelope.totals.residue.CHECKSUM_MISMATCH, 1);
  assert.equal(envelope.totals.residue.RESIDUE_NO_CHECKSUM, 1);
  assert.equal(envelope.totals.residue.POST_CENSUS_TRUNCATE, 0);

  assert.equal(envelope.totals.quarantineMargin.files, 1);
  assert.equal(envelope.totals.quarantineMargin.framesPresent, 7);
  assert.equal(envelope.totals.quarantineMargin.framesAdmitted, 1);
  assert.equal(envelope.totals.quarantineMargin.framesNamedInvalid, 6);
  assert.equal(envelope.reconciliation.holdsMargin, true);
  assert.equal(envelope.reconciliation.holdsKeys, true);
  assert.equal(envelope.reconciliation.holdsFrames, true);
  assert.equal(envelope.reconciliation.keylessFrames, 0, 'the structural guard admits no keyless frame');
  assert.equal(envelope.reconciliation.unattributedFrames, 0);

  assert.deepEqual(envelope.rows.map((row) => row.name).sort(), [
    'anti.browser.second',
    'anti.browser.valid',
  ]);
  assert.ok(envelope.rows.every((row) => row.lowerBound === true));
  assert.ok(envelope.evidenceRefs.length >= 6);
  for (const ref of envelope.evidenceRefs) {
    assert.ok(EVIDENCE_REF_PATTERN.test(ref), `${ref} must be a resolvable pointer`);
    assert.ok(ref.startsWith(`census:${envelope.census.censusHash.slice(0, 8)}#L`));
  }
  assert.equal(new Set(envelope.evidenceRefs).size, envelope.evidenceRefs.length, 'references are deduplicated');
  assert.equal(evidenceRefsFor(null, []).length, 0);
  assert.equal(
    envelope.totals.quarantineMargin.reasons.reduce((sum, reason) => sum + reason.count, 0),
    envelope.totals.quarantineMargin.framesNamedInvalid,
  );
  for (const reason of envelope.totals.quarantineMargin.reasons) {
    assert.ok(NAMED_INVALID_RESIDUE_CLASSES.includes(reason.class));
    assert.ok(reason.reason === undefined || /^[a-z][a-z-]*$/.test(reason.reason), 'reasons are closed tokens');
  }
});

test('E1 a missing directory is NO_DATA_ROOT_RESOLVED with nothing to publish', async () => {
  const missing = path.join(newStore(), 'does-not-exist');
  const pass = await runCensusPass(missing, AS_OF);
  assert.equal(pass.counters.outcome, 'NO_DATA_ROOT_RESOLVED');
  assert.equal(pass.census, null);

  const envelope = await accountStore({ storeDir: missing, asOf: AS_OF });
  assert.equal(envelope.status, 'UNMEASURED');
  assert.equal(envelope.reasonCode, UnmeasuredReason.NO_DATA_ROOT_RESOLVED);
  assert.deepEqual(envelope.affected, [AffectedToken.NO_DATA_ROOT_RESOLVED, 'does-not-exist']);
  assert.equal(envelope.storePath, 'does-not-exist');
  assert.equal(envelope.census, null);
  assert.equal(envelope.totals, null);
  assert.deepEqual(envelope.rows, []);
  assert.deepEqual(envelope.evidenceRefs, []);
});

test('E2 an empty store is NO_DATA, and no zero is published as a measurement', async () => {
  const dir = newStore();
  const pass = await runCensusPass(dir, AS_OF);
  assert.equal(pass.counters.outcome, 'NO_DATA');
  assert.equal(pass.census.fileCount, 0);
  assert.equal(pass.census.censusHash, null);
  assert.deepEqual(pass.census.files, []);

  const envelope = await accountStore({ storeDir: dir, asOf: AS_OF });
  assert.equal(envelope.status, 'UNMEASURED');
  assert.equal(envelope.reasonCode, UnmeasuredReason.NO_DATA);
  assert.deepEqual(envelope.affected, [storeDisplayLabel(dir)]);
  assert.equal(envelope.census, null, 'nothing was read, so there is no census to publish');
  assert.equal(envelope.totals, null);
  assert.deepEqual(envelope.rows, []);
  assert.equal(envelope.reconciliation, null);
  assert.deepEqual(envelope.fileRollups, []);
});

test('E3 a store path that is not a directory fails closed and is not mistaken for NO_DATA', async () => {
  const dir = newStore();
  const filePath = writeStoreFile(dir, 'not-a-dir.jsonl', `${frameLine()}\n`);
  const pass = await runCensusPass(filePath, AS_OF);

  assert.equal(pass.counters.outcome, 'DIR_UNREADABLE');
  assert.equal(pass.census, null);
  const envelope = await accountStore({ storeDir: filePath, asOf: AS_OF });
  assert.equal(envelope.reasonCode, UnmeasuredReason.DIR_UNREADABLE);
  assert.deepEqual(envelope.affected, [AffectedToken.DIR_UNREADABLE, 'not-a-dir.jsonl']);
  assert.equal(envelope.census, null);
});

test('E4 the sweep reports both directory failure modes as typed errors', async () => {
  const dir = newStore();
  assert.throws(
    () => runPopulationSweep(path.join(dir, 'nope')),
    (error) => error instanceof CensusDirectoryUnreadableError
      && error.reasonCode === UnmeasuredReason.NO_DATA_ROOT_RESOLVED,
  );
  const filePath = writeStoreFile(dir, 'plain.jsonl', '');
  assert.throws(
    () => runPopulationSweep(filePath),
    (error) => error instanceof CensusDirectoryUnreadableError
      && error.reasonCode === UnmeasuredReason.DIR_UNREADABLE,
  );
  const missing = await runCensusPass(path.join(dir, 'nope'), AS_OF);
  assert.equal(missing.counters.outcome, 'NO_DATA_ROOT_RESOLVED', 'the pass maps the failure, never throws');
  assert.equal(missing.census, null);
});

test('E5 the in-process memo returns the identical envelope, and a changed store misses it', async () => {
  clearAccountMemo();
  const dir = newStore();
  writeStoreFile(dir, 'a.jsonl', `${frameLine()}\n`);

  const first = await accountStore({ storeDir: dir, asOf: AS_OF, memo: true });
  const second = await accountStore({ storeDir: dir, asOf: AS_OF, memo: true });
  assert.equal(second, first, 'a memo hit returns the earlier envelope by identity');

  // A second *name*, so the population key moves and the row count can show the miss: reusing one name
  // would change the frame count while leaving a single row behind.
  writeStoreFile(dir, 'b.jsonl', `${frameLine({ name: 'anti.browser.extra' })}\n`);
  const third = await accountStore({ storeDir: dir, asOf: AS_OF, memo: true });
  assert.notEqual(third, first);
  assert.equal(third.rows.length, first.rows.length + 1);

  clearAccountMemo();
  const cold = await accountStore({ storeDir: dir, asOf: AS_OF, memo: false });
  assert.notEqual(cold, third);
  assert.equal(cold.rows.length, third.rows.length);
});

test('E6 the budget guard is a real bound and an expired pass throws through the reader', async () => {
  const dir = newStore();
  writeStoreFile(dir, 'a.jsonl', `${frameLine()}\n`);
  const census = (await runCensusPass(dir, AS_OF)).census;
  // A clock that advances 60s per reading: the pass starts, and the first budget check already finds
  // the budget spent. A constant clock could never expire one.
  let ticks = 0;
  const clock = () => (ticks += 60_000);

  await assert.rejects(
    () => readAdmittedFrames(census, { emit: () => undefined }, { storeDir: dir, clock, limits: { budgetMs: 1 } }),
    (error) => error instanceof CensusBudgetExpiredError && error.elapsedMs > 1,
  );
});

test('E7 storeDisplayLabel is the final segment only: no separator, no drive letter, no empty string', () => {
  assert.equal(storeDisplayLabel('E:\\Work\\.antifan-data\\control-plane-v2\\invocations'), 'invocations');
  assert.equal(storeDisplayLabel('/var/lib/antifan/invocations/'), 'invocations', 'a trailing separator is stripped');
  assert.equal(storeDisplayLabel('E:\\Work\\.antifan-data\\control-plane-v2\\invocations\\'), 'invocations');
  assert.equal(storeDisplayLabel('invocations'), 'invocations');
  assert.equal(storeDisplayLabel('a/b\\c'), 'c', 'mixed separators: still one segment');
  assert.equal(storeDisplayLabel(''), null);
  assert.equal(storeDisplayLabel(null), null);
  assert.equal(storeDisplayLabel(undefined), null);
  assert.equal(storeDisplayLabel('   '), null);
  assert.equal(storeDisplayLabel('/'), null);
  assert.equal(storeDisplayLabel('C:\\'), null, 'a drive root names no store, so it publishes no label');

  // The published label can never carry the shapes `phase-01:203` bans, whatever the input looked like.
  for (const input of ['E:\\Work\\.antifan-data\\control-plane-v2\\invocations', '/var/lib/antifan/invocations/', 'invocations', 'a/b\\c']) {
    const label = storeDisplayLabel(input);
    assert.ok(typeof label === 'string' && label.length > 0);
    assert.ok(!/[\\/]/.test(label), `${label} must not carry a separator`);
    assert.ok(!/^[A-Za-z]:/.test(label), `${label} must not be a drive letter`);
  }
});

test('E8 the memo key is the stage-A population, and it moves when the population does', () => {
  const entries = [
    { name: 'a.jsonl', bucket: 'jsonl', size: 10, mtimeMs: STAMP },
    { name: 'b.jsonl', bucket: 'jsonl', size: 20, mtimeMs: STAMP + 1 },
  ];
  const key = computePopulationMemoKey(entries);
  assert.equal(key.length, 64);
  assert.equal(key, computePopulationMemoKey([...entries].reverse()), 'the key is order-independent');
  assert.notEqual(key, computePopulationMemoKey([{ ...entries[0], size: 11 }, entries[1]]));
  assert.notEqual(key, computePopulationMemoKey([{ ...entries[0], mtimeMs: STAMP + 5 }, entries[1]]));
  assert.equal(key, computePopulationMemoKey([{ ...entries[0] }, { ...entries[1] }]));
});

test('E9 classifyLine is usable on its own and states the boundary rule it was given', () => {
  const line = frameLine();
  assert.equal(classifyLine(line).class, ResidueClass.ADMITTED);
  assert.equal(classifyLine('not json').class, ResidueClass.UNPARSEABLE);
  assert.equal(classifyLine('not json').reason, UNPARSEABLE_REASON);
  assert.equal(classifyLine('not json', { lastWindowSpan: true, windowTerminated: false }).class, ResidueClass.TORN_TAIL);
  assert.equal(classifyLine('not json', { lastWindowSpan: true, windowTerminated: true }).class, ResidueClass.UNPARSEABLE);
  assert.equal(classifyLine('not json', { lastWindowSpan: false, windowTerminated: false }).class, ResidueClass.UNPARSEABLE);
  assert.equal(classifyLine('null').class, ResidueClass.STRUCTURAL_INVALID);

  // A forced variant failure selects the sub-reason and can never change the verdict.
  const body = frameBody({ result: { items: [null, 1] } });
  const mismatched = JSON.stringify({ ...body, checksum: computeFrameChecksumNullArrayVariant(body) });
  assert.deepEqual(classifyLine(mismatched, { variantMatches: () => false }).reason, ChecksumMismatchReason.UNEXPLAINED);
  assert.deepEqual(classifyLine(mismatched, { variantMatches: () => true }).reason, ChecksumMismatchReason.WRITER_CANONICALIZATION_ARRAY_SLOT);
  assert.equal(classifyLine(mismatched, { variantMatches: () => true }).class, ResidueClass.CHECKSUM_MISMATCH);
});

test('E10 the module and its contract are separated so a renderer can import the types alone', () => {
  const contracts = fs.readFileSync(CONTRACTS_SOURCE_PATH, 'utf8');
  assert.ok(!/^\s*import\s/m.test(contracts), 'the contract module has no imports at all');
  assert.ok(contracts.includes(JSONL_NAME_MARKER === '.jsonl' ? "'jsonl'" : 'jsonl'));
  assert.ok(contracts.includes(QUARANTINE_NAME_MARKER) === false, 'the markers live in the reader, not the contract');
  assert.ok(contracts.includes(TEMP_NAME_MARKER) === false);
  // A declaration, not the word: both files discuss closed sets without declaring one, and an `enum`
  // declaration is anchored at the start of its own line.
  const enumDeclaration = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m;
  assert.ok(!enumDeclaration.test(contracts), 'this repo declares no TypeScript enums');
  const source = fs.readFileSync(MODULE_SOURCE_PATH, 'utf8');
  assert.ok(!enumDeclaration.test(source), 'this repo declares no TypeScript enums');
  assert.ok(source.includes("export * from '../../shared/mcp-dispatch-contracts'"), 'the contract is re-exported once');
});
