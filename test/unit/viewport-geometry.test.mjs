import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeViewport, isMeasurableViewport, isSymmetricViewport, sameViewport, VIEWPORT_TOLERANCE_PX } from '../../scripts/lib/viewport-geometry.mjs';

test('a doubled emulated viewport is not symmetric with the requested one', () => {
  // Observed live: the clone tab rasterized 780x1688 for a requested 390x844
  // while the reference stayed at 390x844, and the pair was compared across two
  // different layouts.
  const reference = { width: 390, height: 844, dpr: 1 };
  const clone = { width: 780, height: 1688, dpr: 1 };
  const requested = { width: 390, height: 844, dpr: 1 };
  assert.equal(sameViewport(reference, clone), false);
  assert.equal(isSymmetricViewport(reference, clone, requested), false);
});

test('a pair that agrees with itself at the wrong size is still not symmetric', () => {
  const both = { width: 780, height: 1688, dpr: 1 };
  const requested = { width: 390, height: 844, dpr: 1 };
  assert.equal(sameViewport(both, both), true);
  assert.equal(isSymmetricViewport(both, both, requested), false);
});

test('matching measurements at the requested geometry are symmetric', () => {
  const m = { width: 390, height: 844, dpr: 1 };
  assert.equal(isSymmetricViewport(m, { ...m }, { ...m }), true);
  // The viewport height is measured (innerHeight), not the document height: a
  // 5000px-tall page still reports a 900px viewport on both sides.
  const desktop = { width: 1440, height: 900, dpr: 1 };
  assert.equal(isSymmetricViewport(desktop, { ...desktop }, { ...desktop }), true);
  assert.equal(isSymmetricViewport(desktop, { width: 1440, height: 900, dpr: 2 }, { ...desktop }), false);
});

test('a device pixel ratio difference breaks symmetry', () => {
  const reference = { width: 390, height: 844, dpr: 2 };
  const clone = { width: 390, height: 844, dpr: 1 };
  assert.equal(sameViewport(reference, clone), false);
});

test('sub-pixel emulation rounding is tolerated, a whole pixel is not', () => {
  const a = { width: 390, height: 844, dpr: 1 };
  const rounded = { width: 390 + VIEWPORT_TOLERANCE_PX, height: 844, dpr: 1 };
  const off = { width: 390 + VIEWPORT_TOLERANCE_PX + 1, height: 844, dpr: 1 };
  assert.equal(sameViewport(a, rounded), true);
  assert.equal(sameViewport(a, off), false);
});

test('an unmeasurable side never matches', () => {
  const m = { width: 390, height: 844, dpr: 1 };
  assert.equal(isMeasurableViewport(null), false);
  assert.equal(isMeasurableViewport({ width: 390, height: Number.NaN, dpr: 1 }), false);
  assert.equal(sameViewport(m, null), false);
  assert.equal(sameViewport(m, { width: 390, height: undefined, dpr: 1 }), false);
  assert.equal(sameViewport(null, null), false);
});

test('describeViewport names the measured geometry and flags an unmeasurable side', () => {
  assert.equal(describeViewport({ width: 780, height: 1688, dpr: 1 }), '780x1688@1');
  assert.equal(describeViewport({ width: 390, height: 844 }), '390x844@1');
  assert.equal(describeViewport(null), 'unmeasurable');
});
