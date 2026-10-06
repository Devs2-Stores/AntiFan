/**
 * Resilient-QA state model: separates what the storefront is (verification),
 * what the automation did (execution), and what recovery happened (recovery).
 * Read/QA paths classify refusals into dispositions so a missing screenshot or
 * stale tab degrades evidence instead of blocking the run; write/mutation and
 * security surfaces stay fail-closed — `dispositionFor(..., 'write')` is always
 * HARD_BLOCK.
 */

export type QaVerification = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type QaExecution = 'RUNNING' | 'COMPLETED' | 'DEGRADED' | 'BLOCKED';
export type QaRecovery = 'NONE' | 'AUTO_RECOVERED' | 'RETRY_REQUIRED' | 'HUMAN_REQUIRED';

export type RefusalDisposition =
  | 'HARD_BLOCK'
  | 'AUTO_RECOVER'
  | 'DEGRADED_CONTINUE'
  | 'RETRY_REQUIRED'
  | 'INCONCLUSIVE';

export type QaOperationKind = 'read' | 'write';

/** Error codes that must never be retried or degraded on any surface. */
const HARD_BLOCK_CODES: Record<string, true> = {
  WORKSPACE_MISMATCH: true,
  WORKSPACE_UNBOUND: true,
  WORKSPACE_SHOP_UNBOUND: true,
  PROJECT_MISMATCH: true,
  RUNTIME_MISMATCH: true,
  SHOP_IDENTITY_MISMATCH: true,
  TAB_SHOP_UNVERIFIED: true,
  URL_HOST_MISMATCH: true,
  URL_THEME_MISMATCH: true,
  URL_PATH_MISMATCH: true,
  POLICY_DENIED: true,
  REFUSED_TOOL_SURFACE: true,
  TERMINAL_FORBIDDEN: true,
  REPLAY_DENIED: true,
  INTEGRITY_COMPROMISED: true,
  TRANSACTION_CONFLICT: true,
  BINDING_COLLISION: true,
  OUTSIDE_WORKSPACE: true,
  UNAUTHENTICATED: true,
  SCOPE_MISMATCH: true,
  ATTACHMENT_REBIND_FAILED: true,
  TRUST_BOUNDARY_VIOLATION: true,
};

/** Transient target/state failures a read path may recover by rebind + one retry. */
const AUTO_RECOVER_CODES: Record<string, true> = {
  TARGET_STALE: true,
  REF_STALE: true,
  LEASE_EXPIRED: true,
  PREEMPTED_BY_USER: true,
  TARGET_TRANSITION_UNCOMMITTED: true,
  CAPTURE_LIFT_BUSY: true,
};

/** Degraded evidence: the dimension is unmeasured but the run continues. */
const DEGRADED_CODES: Record<string, true> = {
  REF_NOT_FOUND: true,
  CAPTURE_TIMEOUT: true,
  NO_RENDER_SURFACE: true,
  CAPTURE_FRAME_STARVATION: true,
  CAPTURE_EMPTY_PAYLOAD: true,
  FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN: true,
  FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY: true,
  TARGET_OBSCURED: true,
  DEVICE_NOT_CONNECTED: true,
};

/** Worth one immediate retry without a rebind. */
const RETRY_CODES: Record<string, true> = {
  NAVIGATION_TIMEOUT: true,
  WAIT_TIMEOUT: true,
  WAIT_ABORTED: true,
  EVAL_HARD_TIMEOUT: true,
  EXECUTION_ERROR: true,
  CAPABILITY_OVERLOADED: true,
};

/** Caller input or environment faults: nothing to recover, report as-is. */
const INCONCLUSIVE_CODES: Record<string, true> = {
  INVALID_ARGUMENT: true,
  TARGET_REQUIRED: true,
  TARGET_TAB_REQUIRED: true,
  TARGET_MISMATCH: true,
  ROUTE_UNRESOLVED: true,
  NAVIGATION_FAILED: true,
  LOAD_FAILED: true,
  CAPABILITY_NOT_FOUND: true,
  ARTIFACT_TOO_LARGE: true,
  SETTLE_INCOMPLETE: true,
  RUNTIME_DRAINING: true,
};

export function extractErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

/**
 * Classify a thrown refusal. Write/mutation operations collapse everything to
 * HARD_BLOCK — resilient semantics only exist for read/QA surfaces.
 * Unknown codes fail toward INCONCLUSIVE on reads (report the gap, don't guess).
 */
export function dispositionFor(err: unknown, op: QaOperationKind): RefusalDisposition {
  if (op === 'write') return 'HARD_BLOCK';
  const code = extractErrorCode(err);
  // hasOwnProperty, not indexing: error codes are attacker/environment-controlled
  // strings, and 'toString'/'constructor'/'hasOwnProperty' would otherwise read
  // Object.prototype members as truthy classifications.
  const has = (table: Record<string, true>): boolean => Object.prototype.hasOwnProperty.call(table, code);
  if (has(HARD_BLOCK_CODES)) return 'HARD_BLOCK';
  if (has(AUTO_RECOVER_CODES)) return 'AUTO_RECOVER';
  if (has(DEGRADED_CODES)) return 'DEGRADED_CONTINUE';
  if (has(RETRY_CODES)) return 'RETRY_REQUIRED';
  if (has(INCONCLUSIVE_CODES)) return 'INCONCLUSIVE';
  return 'INCONCLUSIVE';
}

/** A stale-target error only earns a rebind retry when the error itself says a
 * live target may exist (canRebind/recovery hint). Without that signal the
 * stale code is terminal for this run — never retry blind. */
export function isRebindableStale(err: unknown): boolean {
  if (extractErrorCode(err) !== 'TARGET_STALE') return false;
  const details = (err as { details?: Record<string, unknown> } | null | undefined)?.details;
  if (!details || typeof details !== 'object') return false;
  if (details.canRebind === true) return true;
  if (typeof details.recovery === 'string' && details.recovery.length > 0) return true;
  return false;
}
