/**
 * CSS viewport geometry equality for the canary pair.
 *
 * The authoritative comparator rasterizes two tabs that must be emulating the
 * same CSS viewport. The app verifies a viewport *write* against the tab's
 * render surface, but that check does not see the emulated CSS geometry the
 * comparator actually rasterizes: a clone tab was measured at 780x1688 (2x the
 * requested 390x844) while the reference stayed at 390x844, and the pair was
 * compared across two different layouts. These predicates decide symmetry from
 * measurements, so a geometry artifact can never be reported as a fidelity
 * verdict.
 *
 * Tolerance is one CSS pixel: emulation rounds sub-pixel sizes, and a whole
 * viewport doubling (the observed failure) stays far outside it.
 */

export const VIEWPORT_TOLERANCE_PX = 1;

/** A measurement is usable only when both CSS dimensions are finite numbers. */
export function isMeasurableViewport(m) {
  return Boolean(m) && Number.isFinite(m.width) && Number.isFinite(m.height);
}

/**
 * Two measured viewports are the same when both CSS dimensions are within
 * tolerance and the device pixel ratios agree. An unmeasurable side is never
 * treated as agreeing.
 */
export function sameViewport(a, b, tolerance = VIEWPORT_TOLERANCE_PX) {
  if (!isMeasurableViewport(a) || !isMeasurableViewport(b)) return false;
  const aDpr = Number.isFinite(a.dpr) ? a.dpr : 1;
  const bDpr = Number.isFinite(b.dpr) ? b.dpr : 1;
  return (
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance &&
    Math.abs(aDpr - bDpr) < 0.01
  );
}

export function describeViewport(m) {
  return isMeasurableViewport(m) ? `${m.width}x${m.height}@${Number.isFinite(m.dpr) ? m.dpr : 1}` : 'unmeasurable';
}

/**
 * A pair is comparable when both sides match each other AND match the geometry
 * the runner requested; matching each other at the wrong size is still a
 * geometry artifact.
 */
export function isSymmetricViewport(reference, clone, requested, tolerance = VIEWPORT_TOLERANCE_PX) {
  return (
    sameViewport(reference, clone, tolerance) &&
    sameViewport(reference, requested, tolerance) &&
    sameViewport(clone, requested, tolerance)
  );
}
