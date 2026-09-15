/**
 * Theme harness verdict contract.
 *
 * Every layer emits the same verdict shape and every verdict carries the
 * evidence tier it was measured under, so an offline source scan can never be
 * mistaken for a live storefront measurement:
 *
 *   tier OFFLINE_STATIC — the theme source tree on disk (scripts/theme-checks.mjs
 *     + scripts/lint-haravan-theme.mjs). Proves declarations, bindings, assets
 *     and Haravan contracts. Cannot prove rendering.
 *   tier LIVE_PUBLISHED — the published theme served by the store, measured in a
 *     bound AntiFan tab pinned with ?themeid=<id>. Proves the remote bytes render
 *     clean. Cannot prove uncommitted working-tree edits.
 *   tier WORKING_TREE — the local tree pushed to a user-approved unpublished
 *     theme and measured through the same live suite. Gated; until the
 *     prerequisites exist the layer is BLOCKED, never simulated.
 *   tier BLOCKED — the layer produced no measurement at all; `blockedReasons`
 *     name each missing prerequisite.
 *
 * verdict: PASS | FAIL | INCONCLUSIVE | BLOCKED.
 */

export const EVIDENCE_TIERS = Object.freeze([
  'OFFLINE_STATIC',
  'LIVE_PUBLISHED',
  'WORKING_TREE',
  'BLOCKED',
]);

export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);

export const LAYERS = Object.freeze({
  L0: 'L0-offline-static',
  L1: 'L1-live-published',
  L2: 'L2-working-tree',
});

/**
 * @param {{ layer: string, tier: string, verdict: string, checks?: object,
 *   limits?: string[], blockedReasons?: string[], evidence?: object,
 *   notes?: string[] }} input
 */
export function makeVerdict(input) {
  if (!LAYERS[input.layer] && !Object.values(LAYERS).includes(input.layer)) {
    throw new Error(`unknown harness layer: ${input.layer}`);
  }
  if (!EVIDENCE_TIERS.includes(input.tier)) {
    throw new Error(`unknown evidence tier: ${input.tier}`);
  }
  if (!VERDICTS.includes(input.verdict)) {
    throw new Error(`unknown verdict: ${input.verdict}`);
  }
  if (input.verdict === 'BLOCKED' && (!input.blockedReasons || input.blockedReasons.length === 0)) {
    throw new Error('a BLOCKED verdict must name its blockedReasons');
  }
  return {
    layer: input.layer,
    tier: input.tier,
    verdict: input.verdict,
    measuredAt: new Date().toISOString(),
    checks: input.checks ?? {},
    limits: input.limits ?? [],
    blockedReasons: input.blockedReasons ?? [],
    evidence: input.evidence ?? {},
    notes: input.notes ?? [],
  };
}

export function blockedVerdict(layer, tier, blockedReasons, extra = {}) {
  return makeVerdict({ layer, tier, verdict: 'BLOCKED', blockedReasons, ...extra });
}

/**
 * Fold layer verdicts into the harness verdict. FAIL dominates; a run where no
 * layer produced a measurement is BLOCKED; anything partially measured is
 * INCONCLUSIVE so a gated L2 never inflates the result into PASS.
 */
export function overallVerdict(layers) {
  const verdicts = layers.map((l) => l.verdict);
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.every((v) => v === 'PASS')) return 'PASS';
  if (verdicts.every((v) => v === 'BLOCKED')) return 'BLOCKED';
  return 'INCONCLUSIVE';
}
