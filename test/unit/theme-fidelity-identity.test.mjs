/**
 * Pure unit tests for the theme-fidelity identity axis: how a pin-vs-measurement
 * drift is read, and the question that decides whether a drifted pair is still
 * comparable — did both sides drift by the same amount, or did only one side move?
 * Also covers the instrument revision a compare leg stamps beside its timestamps.
 * Nothing here touches the browser, a session file or the filesystem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_HEIGHT_TOLERANCE_PX,
  compareCrossSideIdentity,
  compareIdentityFields,
  isSymmetricIdentityDrift,
  readInstrumentRevision,
} from '../../.canary/tools/theme-fidelity.mjs';

const PIN = {
  device: 'web',
  ua: 'Mozilla/5.0',
  innerWidth: 1024,
  innerHeight: 900,
  dpr: 1,
  docHeight: 5426,
  sections: 11,
  widgetNodes: 30,
};

test('a drift both sides share is symmetric', () => {
  const drifted = { ...PIN, docHeight: PIN.docHeight + 13, sections: 12 };
  const reference = compareIdentityFields(PIN, drifted, DOC_HEIGHT_TOLERANCE_PX, { pinned: PIN, measured: drifted });

  assert.equal(reference.agree, false, 'the shared drift still disagrees with the pin');
  assert.equal(reference.symmetric, true);
  assert.deepEqual(reference.symmetricFields, ['docHeight', 'sections']);
  assert.deepEqual(reference.asymmetricFields, []);
  assert.deepEqual(
    reference.differences.map((d) => [d.field, d.magnitude, d.symmetric]),
    [['docHeight', 13, true], ['sections', 1, true]],
  );

  // The axis verdict is the conjunction of the two sides, so the same pair read from
  // the subject side is symmetric too.
  const subject = compareIdentityFields(PIN, drifted, DOC_HEIGHT_TOLERANCE_PX, { pinned: PIN, measured: drifted });
  assert.equal(isSymmetricIdentityDrift(reference, subject), true);
});

test('a drift only one side moved is asymmetric', () => {
  const drifted = { ...PIN, docHeight: PIN.docHeight + 13 };
  const reference = compareIdentityFields(PIN, drifted, DOC_HEIGHT_TOLERANCE_PX, { pinned: PIN, measured: { ...PIN } });
  const subject = compareIdentityFields(PIN, { ...PIN }, DOC_HEIGHT_TOLERANCE_PX, { pinned: PIN, measured: drifted });

  assert.equal(reference.agree, false);
  assert.equal(reference.symmetric, false);
  assert.deepEqual(reference.symmetricFields, []);
  assert.deepEqual(reference.asymmetricFields, ['docHeight']);
  assert.equal(reference.differences[0].symmetric, false);
  assert.equal(isSymmetricIdentityDrift(reference, subject), false, 'a one-sided move is not a shared drift');

  // Same field, opposite directions: the two sides moved, but not together.
  const opposite = compareIdentityFields(PIN, { ...PIN, docHeight: PIN.docHeight + 13 }, DOC_HEIGHT_TOLERANCE_PX, {
    pinned: PIN,
    measured: { ...PIN, docHeight: PIN.docHeight - 13 },
  });
  assert.equal(opposite.symmetric, false);

  // Same field, same direction, magnitudes further apart than the measured-rounding
  // tolerance: still not a shared drift.
  const spread = compareIdentityFields(PIN, { ...PIN, docHeight: PIN.docHeight + 13 }, DOC_HEIGHT_TOLERANCE_PX, {
    pinned: PIN,
    measured: { ...PIN, docHeight: PIN.docHeight + 13 + DOC_HEIGHT_TOLERANCE_PX + 1 },
  });
  assert.equal(spread.symmetric, false);

  // A non-numeric field is compared as a value pair, so both sides must have changed
  // the same way.
  const sameDevice = compareIdentityFields(PIN, { ...PIN, device: 'mobile' }, DOC_HEIGHT_TOLERANCE_PX, {
    pinned: PIN,
    measured: { ...PIN, device: 'mobile' },
  });
  assert.equal(sameDevice.symmetric, true);

  // A field that moved on one side only makes the pair asymmetric even when another
  // field drifted together: the axis reads the union of both sides' drifts, so the
  // side that moved alone reports it.
  const shared = { ...PIN, docHeight: PIN.docHeight + 13 };
  const extra = { ...PIN, docHeight: PIN.docHeight + 13, sections: 12 };
  const referenceSide = compareIdentityFields(PIN, shared, DOC_HEIGHT_TOLERANCE_PX, { pinned: PIN, measured: extra });
  const subjectSide = compareIdentityFields(PIN, extra, DOC_HEIGHT_TOLERANCE_PX, { pinned: PIN, measured: shared });
  assert.equal(referenceSide.symmetric, true);
  assert.equal(subjectSide.symmetric, false);
  assert.deepEqual(subjectSide.asymmetricFields, ['sections']);
  assert.equal(isSymmetricIdentityDrift(referenceSide, subjectSide), false, 'a field that moved on one side only is seen');
});

test('document-height drift keeps the measured-rounding tolerance', () => {
  const within = compareIdentityFields(PIN, { ...PIN, docHeight: PIN.docHeight + DOC_HEIGHT_TOLERANCE_PX });
  assert.equal(within.agree, true, 'a two-pixel difference is rounding, not drift');
  assert.deepEqual(within.differences, []);

  const beyond = compareIdentityFields(PIN, { ...PIN, docHeight: PIN.docHeight + DOC_HEIGHT_TOLERANCE_PX + 1 });
  assert.equal(beyond.agree, false, 'a three-pixel difference is drift');
  assert.deepEqual(beyond.differences.map((d) => d.field), ['docHeight']);
  assert.equal(beyond.differences[0].pinned, PIN.docHeight);
  assert.equal(beyond.differences[0].measured, PIN.docHeight + 3);
  assert.equal(beyond.differences[0].magnitude, DOC_HEIGHT_TOLERANCE_PX + 1);
  assert.equal(beyond.differences[0].driftPx, DOC_HEIGHT_TOLERANCE_PX + 1);

  // Symmetry applies the same tolerance to the difference between the two drifts:
  // two sides that each moved past it still drift together when they moved alike.
  const together = compareIdentityFields(PIN, { ...PIN, docHeight: PIN.docHeight + 3 }, DOC_HEIGHT_TOLERANCE_PX, {
    pinned: PIN,
    measured: { ...PIN, docHeight: PIN.docHeight + 3 + DOC_HEIGHT_TOLERANCE_PX },
  });
  assert.equal(together.symmetric, true);
});

test('cross-side identity evidence lists exactly the fields the two measurements disagree on', () => {
  const matched = compareCrossSideIdentity(PIN, { ...PIN });
  assert.equal(matched.matched, true);
  assert.deepEqual(matched.differences, []);

  // Two sides that drifted by the same amount agree with each other — which is why
  // this block is evidence only and cannot stand in for the pin comparison.
  const shared = compareCrossSideIdentity(
    { ...PIN, docHeight: PIN.docHeight + 13 },
    { ...PIN, docHeight: PIN.docHeight + 13 },
  );
  assert.equal(shared.matched, true);

  const differing = compareCrossSideIdentity(
    { ...PIN, docHeight: PIN.docHeight + 13, sections: 12 },
    { ...PIN, docHeight: PIN.docHeight + 20, widgetNodes: 31 },
  );
  assert.equal(differing.matched, false);
  assert.deepEqual(differing.differences.map((d) => d.field), ['docHeight', 'sections', 'widgetNodes']);

  const height = differing.differences.find((d) => d.field === 'docHeight');
  assert.deepEqual(height, { field: 'docHeight', reference: PIN.docHeight + 13, subject: PIN.docHeight + 20, delta: 7, tolerance: DOC_HEIGHT_TOLERANCE_PX });

  const sections = differing.differences.find((d) => d.field === 'sections');
  assert.deepEqual(sections, { field: 'sections', reference: 12, subject: 11, delta: null, tolerance: 0 });

  // Height inside the shared tolerance is not a cross-side disagreement.
  const rounded = compareCrossSideIdentity({ ...PIN, docHeight: PIN.docHeight + 13 }, { ...PIN, docHeight: PIN.docHeight + 13 + DOC_HEIGHT_TOLERANCE_PX });
  assert.equal(rounded.matched, true);
});

test('a leg names the instrument revision the parent handed down, or null when none was', () => {
  // The compare document itself is built inside the browser-running stage, so the field
  // value it carries is produced by this helper and tested here.
  assert.equal(readInstrumentRevision({ CANARY_INSTRUMENT_REVISION: 'a1b2c3d4' }), 'a1b2c3d4');
  assert.equal(readInstrumentRevision({ CANARY_INSTRUMENT_REVISION: 'rev with spaces' }), 'rev with spaces');

  // Absent is unknown, not a value and not a failure: the leg still gets written.
  assert.strictEqual(readInstrumentRevision({}), null);
  assert.strictEqual(readInstrumentRevision({ CANARY_INSTRUMENT_REVISION: undefined }), null);
  assert.strictEqual(readInstrumentRevision({ CANARY_INSTRUMENT_REVISION: '' }), null);
  assert.strictEqual(readInstrumentRevision({ CANARY_INSTRUMENT_REVISION: '   ' }), null);

  // The no-argument call reads the ambient process environment. With the variable set
  // there it names that revision; with it absent the call reports unknown. A reader that
  // returned the ambient value regardless of its argument fails the explicit assertion,
  // and one that ignored the environment fails the no-argument assertions.
  const ambient = process.env.CANARY_INSTRUMENT_REVISION;
  try {
    process.env.CANARY_INSTRUMENT_REVISION = 'ambient-a1b2c3d4';
    assert.strictEqual(readInstrumentRevision(), 'ambient-a1b2c3d4');
    assert.strictEqual(readInstrumentRevision({ CANARY_INSTRUMENT_REVISION: 'explicit-rev' }), 'explicit-rev');
    delete process.env.CANARY_INSTRUMENT_REVISION;
    assert.strictEqual(readInstrumentRevision(), null);
  } finally {
    if (ambient === undefined) delete process.env.CANARY_INSTRUMENT_REVISION;
    else process.env.CANARY_INSTRUMENT_REVISION = ambient;
  }

  // JSON null, never undefined and never a throw.
  assert.equal(JSON.stringify({ instrumentRevision: readInstrumentRevision({}) }), '{"instrumentRevision":null}');
});
