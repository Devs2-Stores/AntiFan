/**
 * Deterministic 3-axis stopping criteria for the theme repair loop.
 *
 * Formalizes the Jev-Mem stopping axes as pure arithmetic — no model, no I/O,
 * no wall-clock dependence:
 *   - sufficiency  (s_d): the verification verdict is fully supported by evidence.
 *   - missingness  (m_d): evidence the verification could not produce.
 *   - contradiction (c_d): the repair contradicted the R0 baseline (regressions).
 */
export interface ThreeAxisState {
  /** s_d — 1 when the verification verdict is fully supported, otherwise 0. */
  sufficiency: number;
  /** m_d — count of missing-evidence gaps on the verification report. */
  missingness: number;
  /** c_d — count of contradictions against the baseline (introduced regressions). */
  contradiction: number;
}

export type StopDecisionAction =
  | 'PROCEED_VERIFIED'
  | 'ABORT_ROLLBACK'
  | 'ABORT_BLOCKED'
  | 'CONTINUE_REPAIR';

export interface StopDecision {
  action: StopDecisionAction;
  reason: string;
}

/** Terminal cap on repair iterations before a session must stop retrying. */
export const MAX_REPAIR_ITERATIONS = 3;

/** Missing-evidence gap count above which the session stops immediately (m_d axis). */
export const MAX_MISSINGNESS_GAP = 3;

export function evaluateThreeAxisStop(
  current: ThreeAxisState,
  attemptCount: number,
  maxAttempts: number = MAX_REPAIR_ITERATIONS
): StopDecision {
  if (current.contradiction > 0) {
    return { action: 'ABORT_ROLLBACK', reason: 'Contradiction/regression detected (c_d > 0)' };
  }
  if (current.sufficiency >= 1 && current.missingness === 0) {
    return { action: 'PROCEED_VERIFIED', reason: 'Evidence fully sufficient with zero gaps (s_d=1, m_d=0)' };
  }
  if (attemptCount >= maxAttempts || current.missingness > MAX_MISSINGNESS_GAP) {
    return { action: 'ABORT_BLOCKED', reason: 'STOP_CRITERIA_EXCEEDED' };
  }
  return { action: 'CONTINUE_REPAIR', reason: 'Repairs advancing without contradiction' };
}
