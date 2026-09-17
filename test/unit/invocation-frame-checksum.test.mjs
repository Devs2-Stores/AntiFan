/**
 * The persisted invocation-frame contract: hash, byte ceiling and line boundary.
 *
 * The defect this guards: `computeFrameChecksum`, the 64 MB frame ceiling and the line
 * splitting `raw.split(/\r?\n/).filter((line) => line.trim().length > 0)` all lived inside
 * `invocation-ledger.ts` (`:13`, `:90-93`, `:177`, `:418`). A read-only accounting reader for
 * the same store therefore had to either import the ledger — linking `InvocationLedger` and
 * making `initialize()` (mkdir + replay + quarantine renames) reachable from a read-only pass
 * — or re-derive the format, producing a second source of truth where any drift silently
 * flips frames between admitted and rejected. The contract now lives in
 * `src/main/session/invocation-frame-checksum.ts` and both callers share it.
 *
 * Every expectation below is hand-derived: the canonical serialization is written out
 * literally and hashed with `node:crypto` directly, so nothing here asserts the
 * implementation against itself. The files under test are the compiled emits, which is also
 * what the two ledger consumers load (`scripts/certify-core-freeze.cjs:60`,
 * `scripts/smoke-real-soak.cjs:25`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_INVOCATION_FRAME_BYTES,
  computeFrameChecksum,
  computeFrameChecksumNullArrayVariant,
  frameLineSpans,
  splitFrameLines,
} from '../../.compiled/src/main/session/invocation-frame-checksum.js';

const SEAM_EMIT_PATH = fileURLToPath(
  new URL('../../.compiled/src/main/session/invocation-frame-checksum.js', import.meta.url),
);

/** Independent hash: the canonical serialization, hashed by node:crypto without the module. */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The ledger's retired line expression, kept here as the test oracle for C6. It is a frozen
 * copy of `invocation-ledger.ts:177` used to prove the seam is behaviour-identical — it is
 * test-local, never production logic.
 */
function legacyLedgerLines(raw) {
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** A frame in the shape declared at `invocation-ledger.ts:19-45`, without its `checksum`. */
function handBuiltFrame() {
  return {
    formatVersion: 1,
    id: 'invocation-0001',
    attachmentId: 'attachment-0001',
    requestId: 'request-0001',
    idempotencyKey: 'idem-mcp-1',
    name: 'browser.switch-tab',
    paramDigest: 'a'.repeat(64),
    policyDigest: 'b'.repeat(64),
    policyVersion: 1,
    recordedVisibility: 'full',
    state: 'completed',
    authoritySnapshot: {
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      runtimePid: 4242,
      runtimeLeaseToken: 'lease-0001',
    },
    result: { switched: true },
    createdAt: 1_700_000_000_000,
    settledAt: 1_700_000_000_013,
  };
}

test('the checksum is sha256 over the canonical form, not over JSON.stringify', () => {
  // Keys deliberately out of order, a nested object, an array, and a property whose value is
  // `undefined` — which the canonicalizer drops and `JSON.stringify` also drops.
  const frame = { b: 2, a: 1, nested: { z: [1, 'two'], y: true }, dropped: undefined };
  // Hand-derived canonical form: keys sorted, no whitespace, undefined properties removed.
  const expectedCanonical = '{"a":1,"b":2,"nested":{"y":true,"z":[1,"two"]}}';

  assert.equal(computeFrameChecksum(frame), sha256(expectedCanonical));
  // Ordering is canonicalization, not insertion/JSON.stringify order — otherwise the
  // expectation above would coincide with the naive serialization.
  assert.notEqual(expectedCanonical, JSON.stringify(frame));
});

test('writer and reader agree through the persisted line shape', () => {
  const frame = handBuiltFrame();
  const recorded = computeFrameChecksum(frame);

  // The writer's own shape: `JSON.stringify({ ...rest, checksum }) + '\n'` (:795-806).
  const line = `${JSON.stringify({ ...frame, checksum: recorded })}\n`;
  const lines = splitFrameLines(line);
  assert.equal(lines.length, 1, 'one terminated line yields exactly one non-blank line');

  const persisted = JSON.parse(lines[0]);
  const { checksum, ...rest } = persisted;
  assert.equal(checksum, recorded);
  assert.equal(computeFrameChecksum(rest), checksum, 'the reader reproduces the recorded checksum');

  // The ceiling is one exported constant, consumed here rather than re-declared.
  assert.ok(Buffer.byteLength(line, 'utf8') + 1 <= DEFAULT_MAX_INVOCATION_FRAME_BYTES);
});

test('the null-array variant reproduces the recorded checksum of an undefined array slot', () => {
  // The writer hashed the in-memory value, where the slot was `undefined`
  // (canonicalJsonStringify renders it as an empty slot via Array.prototype.join), while
  // JSON.stringify persisted it as `null`. Strict cannot reproduce it; the variant can.
  const inMemory = { ...handBuiltFrame(), artifactIds: [undefined] };
  const recorded = computeFrameChecksum(inMemory);
  const persisted = JSON.parse(JSON.stringify({ ...inMemory, checksum: recorded }));

  assert.deepEqual(persisted.artifactIds, [null], 'JSON.stringify wrote null for the undefined slot');
  const { checksum, ...rest } = persisted;
  assert.notEqual(computeFrameChecksum(rest), checksum, 'strict fails on the persisted bytes');
  assert.equal(computeFrameChecksumNullArrayVariant(rest), checksum, 'the variant is the named sub-reason');
});

test('a literal-null array passes strict and fails the variant, so normalization is a defect', () => {
  // The measured counterexample: frames whose arrays really held `null` when the writer
  // hashed them. Normalizing array nulls to undefined *before* hashing would flip these
  // valid frames to CHECKSUM_MISMATCH, so strict runs first and alone decides admission.
  const inMemory = { ...handBuiltFrame(), artifactIds: [null] };
  const recorded = computeFrameChecksum(inMemory);
  const persisted = JSON.parse(JSON.stringify({ ...inMemory, checksum: recorded }));

  assert.deepEqual(persisted.artifactIds, [null]);
  const { checksum, ...rest } = persisted;
  assert.equal(computeFrameChecksum(rest), checksum, 'strict admits this frame');
  assert.notEqual(computeFrameChecksumNullArrayVariant(rest), checksum, 'the variant does not reproduce it');

  // Only array slots are converted: a null object property is rendered as "null" by the
  // canonicalizer, and mapping it to undefined would drop the key and change the hash.
  const objectNull = { ...handBuiltFrame(), evidence: { note: null } };
  assert.equal(computeFrameChecksumNullArrayVariant(objectNull), computeFrameChecksum(objectNull));
});

test('LF and CRLF split equivalently and match the ledger line expression', () => {
  const cases = [
    'a\nb\nc\n',
    'a\r\nb\r\nc\r\n',
    'a\r\nb\nc',
    'a\n\nb\n',
    '\n',
    '\n\n\n',
    '',
    '   \n\t\n',
    '\r\n',
    'x\r\r\ny\n',
    'a\rb\n',
    ' leading and trailing \n ',
    'a\n  ',
  ];

  for (const raw of cases) {
    assert.deepEqual(splitFrameLines(raw), legacyLedgerLines(raw), `line projection for ${JSON.stringify(raw)}`);
    // frameLineSpans decodes to the same texts with byte-exact offsets.
    const texts = frameLineSpans(Buffer.from(raw, 'utf8'))
      .filter((span) => span.text.trim().length > 0)
      .map((span) => span.text);
    assert.deepEqual(texts, legacyLedgerLines(raw), `span texts for ${JSON.stringify(raw)}`);
  }

  assert.deepEqual(splitFrameLines('a\nb\nc\n'), splitFrameLines('a\r\nb\r\nc\r\n'));
  assert.deepEqual(splitFrameLines('a\nb\nc\n'), ['a', 'b', 'c']);
});

test('byte offsets are exact and a final unterminated line is kept verbatim', () => {
  const unterminated = Buffer.from('a\nb\nc', 'utf8');
  const spans = frameLineSpans(unterminated);
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((span) => [span.start, span.end, span.text, span.terminated]),
    [
      [0, 1, 'a', true],
      [2, 3, 'b', true],
      [4, 5, 'c', false],
    ],
  );
  assert.deepEqual(splitFrameLines('a\nb\nc'), ['a', 'b', 'c']);

  // No phantom span is emitted after a final terminator: the next span would otherwise start
  // at the buffer length, which the reader's boundary test reads as an append.
  assert.equal(frameLineSpans(Buffer.from('a\nb\nc\n', 'utf8')).length, 3);

  // A whitespace-only unterminated tail keeps its bytes in the span but is dropped by the
  // non-blank filter — the documented hole (phase-02:144), pinned so it stays a named hole.
  const blankTail = frameLineSpans(Buffer.from('a\n  ', 'utf8'));
  assert.equal(blankTail.length, 2);
  assert.equal(blankTail[1].text, '  ');
  assert.equal(blankTail[1].terminated, false);
  assert.deepEqual(splitFrameLines('a\n  '), ['a']);
});

test('empty input yields no spans and no lines', () => {
  assert.deepEqual(frameLineSpans(Buffer.alloc(0)), []);
  assert.deepEqual(splitFrameLines(''), []);
  // A lone terminator is one blank span, which projects to no lines.
  const loneNewline = frameLineSpans(Buffer.from('\n', 'utf8'));
  assert.equal(loneNewline.length, 1);
  assert.equal(loneNewline[0].text, '');
  assert.deepEqual(splitFrameLines('\n'), []);
});

test('offsets stay byte-exact across multi-byte UTF-8 characters', () => {
  // 'é' is 2 bytes, 'ế' is 3 bytes. A UTF-16-index implementation would report starts
  // 0, 2, 4; the byte offsets are 0, 3, 7.
  const multibyte = 'é\nế\nx\n';
  const spans = frameLineSpans(Buffer.from(multibyte, 'utf8'));
  assert.deepEqual(spans.map((span) => span.start), [0, 3, 7]);
  assert.deepEqual(spans.map((span) => span.end), [2, 6, 8]);
  assert.deepEqual(spans.map((span) => span.text), ['é', 'ế', 'x']);
  assert.deepEqual(spans.map((span) => span.terminated), [true, true, true]);
  assert.equal(spans[1].start, 3);
  assert.notEqual(spans[1].start, multibyte.indexOf('ế'), 'UTF-16 index, not a byte offset');
  for (const span of spans) {
    assert.equal(span.end - span.start, Buffer.byteLength(span.text, 'utf8'));
  }

  // A 4-byte astral character is 2 UTF-16 code units but 4 bytes.
  const astralSpans = frameLineSpans(Buffer.from('𝄞\nz\n', 'utf8'));
  assert.deepEqual(astralSpans.map((span) => [span.start, span.end]), [[0, 4], [5, 6]]);
  assert.equal(astralSpans[0].text.length, 2);
  assert.equal(astralSpans[0].end - astralSpans[0].start, 4);

  // A census boundary that fell inside a multi-byte character (Phase 2's `size + 1` probe,
  // matrix row T12): the offsets are the buffer's own byte counts even though the truncated
  // sequence decodes to U+FFFD and the decoded text is wider than the span.
  const full = Buffer.from('q\u1ebf\u1ebf\nz\n', 'utf8');
  assert.equal(frameLineSpans(full)[0].end, 7, 'the complete character set puts the boundary after it');
  const partial = full.subarray(0, 5);
  const partialSpans = frameLineSpans(partial);
  assert.equal(partialSpans.length, 1);
  assert.equal(partialSpans[0].start, 0);
  assert.equal(partialSpans[0].end, 5);
  assert.equal(partialSpans[0].terminated, false);
  assert.ok(partialSpans[0].text.endsWith('\uFFFD'), 'the cut sequence decodes to a replacement char');
  assert.notEqual(
    Buffer.byteLength(partialSpans[0].text, 'utf8'),
    partialSpans[0].end - partialSpans[0].start,
    'decoded text width is not the span width once a character is cut',
  );
});

/**
 * Builds one line of `payloadBytes` payload bytes terminated by `terminator` and reports only
 * the numbers the ceiling comparison needs, so the 64 MiB buffers stay scoped to this call.
 */
function probeCeiling(payloadBytes, terminator) {
  const raw = Buffer.concat([Buffer.alloc(payloadBytes, 0x78), Buffer.from(terminator, 'utf8')]);
  const spans = frameLineSpans(raw);
  assert.equal(spans.length, 1, 'a single terminated line yields exactly one span');
  assert.equal(spans[0].terminated, true);
  const textBytes = Buffer.byteLength(spans[0].text, 'utf8');
  return {
    rawBytes: raw.length,
    textBytes,
    spanWidth: spans[0].end - spans[0].start,
    // The ledger's `:178`/`:836` spelling and the reader's comparison: payload + one terminator.
    overCeiling: textBytes + 1 > DEFAULT_MAX_INVOCATION_FRAME_BYTES,
    // The naive spelling this must never be replaced by: the span width omits the terminator.
    spanWidthOverCeiling: spans[0].end - spans[0].start > DEFAULT_MAX_INVOCATION_FRAME_BYTES,
  };
}

test('a line at exactly the byte ceiling is within the bound, and one byte more is oversize', () => {
  const ceiling = DEFAULT_MAX_INVOCATION_FRAME_BYTES;

  // payload + '\n' == ceiling: the bound is strict (`>`), so this line is not oversize.
  const atCeilingLf = probeCeiling(ceiling - 1, '\n');
  assert.equal(atCeilingLf.rawBytes, ceiling);
  assert.equal(atCeilingLf.textBytes, ceiling - 1);
  assert.equal(atCeilingLf.overCeiling, false);

  // payload + '\n' == ceiling + 1: oversize, and the span width alone would miss it by one
  // byte — which is exactly why the reader compares `byteLength(text) + 1`, like `:178`.
  const overCeilingLf = probeCeiling(ceiling, '\n');
  assert.equal(overCeilingLf.rawBytes, ceiling + 1);
  assert.equal(overCeilingLf.textBytes, ceiling);
  assert.equal(overCeilingLf.overCeiling, true);
  assert.equal(overCeilingLf.spanWidthOverCeiling, false);

  // CRLF: both terminator bytes are excluded from `text`, exactly as `/\r?\n/` did. The
  // bounded quantity is unchanged, so the same payload is still within the ceiling while the
  // raw width is one byte larger. The writer only ever emits a bare '\n' (:802, :841), so a
  // CRLF line can only arrive from a foreign rewrite of the store.
  const atCeilingCrlf = probeCeiling(ceiling - 1, '\r\n');
  assert.equal(atCeilingCrlf.rawBytes, ceiling + 1);
  assert.equal(atCeilingCrlf.textBytes, ceiling - 1);
  assert.equal(atCeilingCrlf.overCeiling, false);
});

test('the seam emit links no ledger, control-plane-runtime, capability-transport or electron', () => {
  const emit = fs.readFileSync(SEAM_EMIT_PATH, 'utf8');
  const requiredSpecifiers = [...emit.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);

  // A vacuous match list would make the assertion below meaningless.
  assert.ok(requiredSpecifiers.length >= 2, 'the emit requires its real dependencies');
  const allowed = new Set(['node:crypto', '../../shared/control-plane-contracts']);
  for (const specifier of requiredSpecifiers) {
    assert.ok(allowed.has(specifier), `unexpected runtime dependency in the seam: ${specifier}`);
    assert.ok(
      !/invocation-ledger|control-plane-runtime|capability-transport|electron/.test(specifier),
      `forbidden runtime dependency in the seam: ${specifier}`,
    );
  }
  // The static import at the top of this file already proves the transitive load is
  // electron-free: it would have thrown on `require('electron')` in a plain Node process.
});
