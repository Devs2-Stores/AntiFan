/**
 * The settle contract, without the transport.
 *
 * `canary-settle.mjs` needs a live session to import (its RPC client resolves the
 * bootstrap at module load), so the decision logic lives here where it can be
 * tested against the passes it actually decides on. One owner for the composite:
 * `settleAndMeasure` reports it, `requireDoubleSettledMetrics` gates on it, and
 * the campaign's evidence records it.
 *
 * The composite is `mediaFrozen && fontsSettled && imagesSettled && visualStable
 * && renderStateStable`. `domQuiet` is deliberately not a component: raw
 * childList churn cannot distinguish a cosmetic re-parenting document from a
 * swapped one, so it is recorded evidence and the content fingerprint decides.
 */
import crypto from 'node:crypto';

export const SETTLE_COMPONENTS = ['mediaFrozen', 'fontsSettled', 'imagesSettled', 'visualStable', 'renderStateStable'];

export const SETTLE_REFUSAL_CODES = {
  DYNAMIC_CONTENT_UNCONTROLLED: 'DYNAMIC_CONTENT_UNCONTROLLED',
};

export function composeSettleVerdict({ freezeOk, images, visual, state }) {
  const components = {
    mediaFrozen: freezeOk === true,
    fontsSettled: images && images.fontsSettled === true,
    imagesSettled: images && images.imagesSettled === true,
    visualStable: visual && visual.visualStable === true,
    renderStateStable: state && state.renderStateStable === true,
  };
  const settled = components.mediaFrozen && components.fontsSettled && components.imagesSettled && components.visualStable && components.renderStateStable;
  const refusal = components.mediaFrozen
    ? null
    : {
        code: SETTLE_REFUSAL_CODES.DYNAMIC_CONTENT_UNCONTROLLED,
        reason: 'anti.media.freeze did not freeze the page, so an uncontrolled dynamic widget could swap content behind an equal-geometry comparison',
      };
  return { ...components, settled, refusal };
}

/** Stable hash of the rendered content, used as the equality key across passes. */
export function settleFingerprintHash(state) {
  const fp = state && state.fingerprint;
  if (!fp) return null;
  return crypto.createHash('sha256').update(JSON.stringify(fp)).digest('hex').slice(0, 16);
}

/**
 * Decide the contract from the measured passes. The last two must both satisfy
 * the composite and describe the same rendered content: equal fingerprints with
 * equal geometry settle, a moved fingerprint does not — even when the structural
 * counts and the element rectangles are identical, which is the swap this gate
 * exists to catch. A pass that could not freeze the page is refused, not waited
 * on: another pass cannot make an uncontrolled widget controllable.
 */
export function decideSettle(passes) {
  if (!Array.isArray(passes) || passes.length < 2) {
    return { settled: false, reason: 'needs-two-passes', failed: [], refusal: null };
  }
  const last = passes[passes.length - 1];
  const prev = passes[passes.length - 2];
  const refusal = last.refusal || prev.refusal || null;
  if (refusal) return { settled: false, reason: refusal.code, failed: [], refusal };
  if (passes.some((p) => p.settled !== true)) {
    const failed = SETTLE_COMPONENTS.filter((name) => !last.components || last.components[name] !== true);
    return { settled: false, reason: 'predicate-unsatisfied', failed, refusal: null };
  }
  if (!last.fingerprint || !prev.fingerprint || last.fingerprint !== prev.fingerprint) {
    return { settled: false, reason: 'content-changed-between-passes', failed: [], refusal: null };
  }
  return { settled: true, reason: 'two-consecutive-matching-settled-passes', failed: [], refusal: null };
}

/** The per-pass diagnostic line: every component and its value, never a subset. */
export function describeSettlePass(index, pass) {
  const c = (pass && pass.components) || {};
  const values = SETTLE_COMPONENTS.map((name) => `${name}=${c[name] === true}`);
  return `#${index}{${values.join(',')},settled=${pass && pass.settled === true},churn=${(pass && pass.structuralMutations) ?? 'null'},sections=${(pass && pass.counts && pass.counts.sections) ?? 'null'},cards=${(pass && pass.counts && pass.counts.cards) ?? 'null'},docHeight=${(pass && pass.counts && pass.counts.docHeight) ?? 'null'},fp=${pass && pass.fingerprint ? String(pass.fingerprint).slice(0, 8) : 'null'}}`;
}
