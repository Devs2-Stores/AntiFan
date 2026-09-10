/**
 * The settle contract decides whether a page may be measured, so every way it
 * can be wrong is pinned here: a dropped component (the previous bug — two
 * predicates computed from different component sets), a geometry-only
 * comparison that admits a content swap, and an unfrozen page admitted rather
 * than refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLE_COMPONENTS,
  composeSettleVerdict,
  settleFingerprintHash,
  decideSettle,
  describeSettlePass,
} from '../../scripts/lib/settle-contract.mjs';

/** A pass that satisfies every component, with a fingerprint of its own. */
function settledPass(fingerprint, counts = { sections: 15, cards: 83, docHeight: 5422 }) {
  return {
    components: { mediaFrozen: true, fontsSettled: true, imagesSettled: true, visualStable: true, renderStateStable: true },
    settled: true,
    refusal: null,
    fingerprint,
    structuralMutations: 18,
    counts,
  };
}

function verdictOf(overrides = {}) {
  return composeSettleVerdict({
    freezeOk: true,
    images: { fontsSettled: true, imagesSettled: true },
    visual: { visualStable: true },
    state: { renderStateStable: true },
    ...overrides,
  });
}

test('the composite requires every component, including fonts', () => {
  assert.equal(verdictOf().settled, true);
  // The regression this contract exists for: fonts were reported but not gated.
  const fontsLate = verdictOf({ images: { fontsSettled: false, imagesSettled: true } });
  assert.equal(fontsLate.settled, false);
  assert.equal(fontsLate.fontsSettled, false);
  assert.equal(verdictOf({ images: { fontsSettled: true, imagesSettled: false } }).settled, false);
  assert.equal(verdictOf({ visual: { visualStable: false } }).settled, false);
  assert.equal(verdictOf({ state: { renderStateStable: false } }).settled, false);
});

test('an unfrozen page is refused with a typed code instead of being admitted', () => {
  const v = verdictOf({ freezeOk: false });
  assert.equal(v.settled, false);
  assert.equal(v.refusal.code, 'DYNAMIC_CONTENT_UNCONTROLLED');
  assert.equal(decideSettle([{ ...settledPass('a'), refusal: v.refusal }, settledPass('a')]).reason, 'DYNAMIC_CONTENT_UNCONTROLLED');
});

test('raw churn is not a gate input', () => {
  assert.equal(SETTLE_COMPONENTS.includes('domQuiet'), false);
  assert.equal(SETTLE_COMPONENTS.includes('structuralMutations'), false);
  // 18 mutations per pass, identical geometry, identical content: settle.
  assert.equal(decideSettle([settledPass('fp1'), settledPass('fp1')]).settled, true);
});

test('two consecutive passes with equal fingerprints and equal geometry settle', () => {
  const d = decideSettle([settledPass('fp1'), settledPass('fp1')]);
  assert.equal(d.settled, true);
  assert.equal(d.reason, 'two-consecutive-matching-settled-passes');
});

test('a moved fingerprint fails even when counts and geometry are identical', () => {
  const equalShape = { sections: 15, cards: 83, docHeight: 5422 };
  const d = decideSettle([settledPass('fp-before', equalShape), settledPass('fp-after', equalShape)]);
  assert.equal(d.settled, false);
  assert.equal(d.reason, 'content-changed-between-passes');
});

test('a missing fingerprint cannot settle on counts alone', () => {
  assert.equal(decideSettle([settledPass(null), settledPass(null)]).reason, 'content-changed-between-passes');
  const one = decideSettle([settledPass('fp1')]);
  assert.equal(one.settled, false);
  assert.equal(one.reason, 'needs-two-passes');
});

test('a failing component is named, not summarised as a count', () => {
  const failed = settledPass('fp1');
  failed.components.fontsSettled = false;
  failed.settled = false;
  const d = decideSettle([settledPass('fp1'), failed]);
  assert.equal(d.settled, false);
  assert.equal(d.reason, 'predicate-unsatisfied');
  assert.deepEqual(d.failed, ['fontsSettled']);
});

test('the diagnostic line names every component of the pass', () => {
  const line = describeSettlePass(2, settledPass('abcdef123456'));
  for (const name of SETTLE_COMPONENTS) assert.match(line, new RegExp(`${name}=(true|false)`));
  assert.match(line, /churn=18/);
  assert.match(line, /fp=abcdef12/);
});

test('the fingerprint hash follows the rendered content, not the caller', () => {
  const base = { fingerprint: { sectionCount: 15, productCardCount: 83, docHeight: 5422, imageCount: 61, pendingImages: 0, brokenImages: 0, imageSetHash: 'aaaa1111', imageSetSize: 61, textHash: 'bbbb2222', textLength: 9000 } };
  const swap = { fingerprint: { ...base.fingerprint, imageSetHash: 'cccc3333' } };
  const same = { fingerprint: { ...base.fingerprint } };
  assert.equal(settleFingerprintHash(base), settleFingerprintHash(same));
  assert.notEqual(settleFingerprintHash(base), settleFingerprintHash(swap));
  assert.equal(settleFingerprintHash({}), null);
});
