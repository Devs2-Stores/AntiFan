/**
 * AntiFan Core - Verification Contract & 5 Primitives Substrate
 *
 * Grounding Axiom:
 * Claims are distinct from facts; confidence is not proof.
 * Only deterministic & semantic evidence evaluated through verifiable contracts
 * can transition a claim to VERIFIED.
 *
 * ============================================================================
 * AntiFan B-Lite v2 Loop Lifecycle & Ownership Split Contract
 * ============================================================================
 *
 * Epistemic & Architectural Boundary:
 * 1. Verification Engine Ownership:
 *    - The AntiFan verification engine owns evidence, artifact, and lifecycle state ONLY.
 *    - It maintains proof obligations, metric samples, batch lifecycles, circuit breakers,
 *      and typed outcome adjudication (FIXED_VERIFIED, REFUSED_SCOPE, STALEMATE, SCOPE_DISCOVERY).
 *    - It has NO SOURCE-FILE ROLLBACK PATH inside the verification engine.
 *
 * 2. Workspace Mutation & Recovery Ownership (Main):
 *    - The ONLY writer to the real workspace is Main's merge gate (after staging & audit).
 *    - Workspace recovery is strictly Main's path-scoped restore (restoring pre-merge bytes
 *      of named files from real disk snapshots).
 *    - Repo-wide destructive git commands (git checkout -- ., git clean -fd, git reset --hard)
 *      are forbidden by invariant.
 *
 * 3. Pre-existing Capability Exception:
 *    - `theme.qa_repair.begin` and `theme.qa_repair.verify` are pre-existing write-class
 *      capabilities in AntiFan that snapshot and can roll back the workspace to R0.
 *    - EXCEPTION STATUS: These capabilities are OUTSIDE the fixer allowlist (which admits
 *      only file.read and file.write in the staged workspace) and are NEVER invoked by
 *      this B-Lite v2 fix loop. Recorded here explicitly so this legacy capability does
 *      not silently contradict the strict ownership split.
 *
 * 4. SCOPE_DISCOVERY Contract:
 *    - SCOPE_DISCOVERY is a returned class (a fix that cannot proceed inside `allowedFiles`),
 *      consumed by Main to evaluate and issue a new FixRequest.
 *    - It must NEVER expand scope in place within the staged or real workspace.
 * ============================================================================
 */

import type {
  FixDecision,
  FixDiffBudget,
  FixLifecycleState,
  FixRequestV2,
  FixResultV2,
  RouteRefusalCode,
  ScopeDiscoveryReceipt,
} from '../../shared/control-plane-contracts';

export type {
  FixDecision,
  FixDiffBudget,
  FixLifecycleState,
  FixRequestV2,
  FixResultV2,
  RouteRefusalCode,
  ScopeDiscoveryReceipt,
};

export type ProofCompleteness = 'FULL' | 'PARTIAL' | 'EMPTY';
export type ProofFreshness = 'FRESH' | 'STALE' | 'UNKNOWN';
export type ProofSource = 'deterministic' | 'semantic' | 'composite';

export interface ProofViolation {
  metric: string;
  expected: unknown;
  actual: unknown;
  delta?: number;
  message?: string;
}

export interface ProofProfile {
  completeness: ProofCompleteness;
  freshness: ProofFreshness;
  source: ProofSource;
  evaluatedMetricsCount: number;
  passedMetricsCount: number;
  violations: ProofViolation[];
  documentGeneration?: number;
  mutationRevision?: number;
  captureTimestamp?: number;
}

export interface ProofObligation {
  id: string;
  metric: string;
  expected?: unknown;
  tolerance?: number;
  critical?: boolean;
  description?: string;
  source?: ProofSource;
}

export interface VerificationScope {
  tabId: string;
  selector?: string;
  viewport?: string;
  paneId?: 'desktop' | 'mobile';
}

export interface InteractionBaseline {
  selector?: string;
  hasActive?: boolean;
  hasOverlay?: boolean;
  classSnapshot?: string;
  url?: string;
}
export interface VerificationClaim {
  id: string;
  claim: string;
  actor: 'agent' | 'user';
  scope: VerificationScope;
  proofObligations: ProofObligation[];
  targetGeneration?: number;
  targetMutationRevision?: number;
  interactionBaseline?: InteractionBaseline;
  confidence?: number;
}

export type VerificationVerdict =
  | 'VERIFIED'
  | 'PARTIAL'
  | 'REJECTED'
  | 'INCONCLUSIVE'
  | 'UNVERIFIED';

export type InconclusiveReason =
  | 'RESAMPLE'
  | 'NEED_INPUT'
  | 'UNOBSERVABLE'
  | 'UNSUPPORTED';

export type StalemateState = 'ACTIVE' | 'STALEMATE' | 'EXEMPTION_WAIVED' | 'SCOPE_DISCOVERY';

export type VerificationLifecycleState =
  | 'ACTIVE'
  | 'HALTED'
  | 'STALEMATE'
  | 'EXEMPTION_WAIVED'
  | 'VERIFIED'
  | 'FIXED_VERIFIED'
  | 'REFUSED_SCOPE'
  | 'SCOPE_DISCOVERY';

/**
 * Structured repair budget tracking repair attempts against maximum allowed repairs.
 */
export interface RepairBudget {
  repairAttempts: number;
  maxRepairs: number;
  remainingRepairs?: number;
}

/**
 * Discovered scope requirements when a fix cannot proceed within allowedFiles.
 * Consumed by Main to evaluate and issue a new FixRequest without in-place expansion.
 */
export interface ScopeDiscoveryInfo {
  missingPaths: string[];
  requestedTargets?: string[];
  notes?: string;
}

export interface VerificationBatchLifecycle {
  runId: string;
  attemptId: string;
  resampleAttempts: number;
  repairAttempts: number;
  maxResamples: number;
  maxRepairs: number;
  state: VerificationLifecycleState;
  lastInvocationId?: string;
  haltReason?: InconclusiveReason;
  /**
   * Structured repair budget tracking repairAttempts against maxRepairs.
   * Optional with defaults so existing callers compile without modification.
   */
  repairBudget?: RepairBudget;
  /**
   * Last observed failure signature or audit refusal cause code for circuit breaker tracking.
   */
  lastFailureSignature?: string;
  /**
   * Consecutive count of identical failure signatures or refusal causes.
   */
  consecutiveRefusalCount?: number;
  /**
   * Path to evidence artifacts explaining failure or terminal state.
   */
  evidencePath?: string;
  /**
   * Typed terminal outcome from the shared contract: FIXED_VERIFIED, REFUSED_SCOPE, STALEMATE, SCOPE_DISCOVERY.
   */
  terminalOutcome?: FixLifecycleState;
  /**
   * Scope discovery payload when lifecycle terminates in SCOPE_DISCOVERY.
   */
  scopeDiscovery?: ScopeDiscoveryInfo;
}
export const VerificationRecord = Object.freeze({});
export const VerificationVerdict = Object.freeze({});
export const StalemateState = Object.freeze({});
export const InconclusiveReason = Object.freeze({});
export const ProofProfile = Object.freeze({});
export const VerificationBatchLifecycle = Object.freeze({});
export interface VerificationRecord {
  id: string;
  claim: string;
  actor: 'agent' | 'user';
  scope: VerificationScope;
  targetGeneration?: number;
  targetMutationRevision?: number;
  interactionBaseline?: InteractionBaseline;
  proofObligations: ProofObligation[];
  proofProfile?: ProofProfile;
  verdict: VerificationVerdict;
  inconclusiveReason?: InconclusiveReason;
  stalemateState?: StalemateState;
  lifecycle?: VerificationBatchLifecycle;
  lifecycleHistory?: VerificationBatchLifecycle[];
  exemptionReason?: string;
  repairBudget?: RepairBudget;
  terminalOutcome?: FixLifecycleState;
  scopeDiscovery?: ScopeDiscoveryInfo;
  evidencePath?: string;
  timestamp: number;
  timeFormatted: string;
  linkedIssueId?: string;
}

export interface MetricSample {
  metric: string;
  obligationId?: string;
  actual?: unknown;
  value?: unknown;
  expected?: unknown;
  delta?: number;
  passed?: boolean;
  source?: ProofSource;
  message?: string;
}

export interface EvidenceSampleBundle {
  claimId?: string;
  tabId?: string;
  documentGeneration: number;
  mutationRevision?: number;
  currentTabGeneration?: number;
  captureTimestamp?: number;
  samples: MetricSample[];
  semanticWitness?: {
    modelConfirmed?: boolean;
    confidence?: number;
    observations?: string[];
  };
}

export type ThemeMetricName =
  | 'theme.source_mapping.file_identified'
  | 'theme.css.active_rule_matched'
  | 'theme.css.strong_pass_resolved'
  | 'theme.responsive.no_target_overflow'
  | 'theme.responsive.no_doc_overflow';

export const THEME_METRICS = {
  SOURCE_FILE_IDENTIFIED: 'theme.source_mapping.file_identified',
  CSS_ACTIVE_RULE_MATCHED: 'theme.css.active_rule_matched',
  CSS_STRONG_PASS_RESOLVED: 'theme.css.strong_pass_resolved',
  RESPONSIVE_NO_TARGET_OVERFLOW: 'theme.responsive.no_target_overflow',
  RESPONSIVE_NO_DOC_OVERFLOW: 'theme.responsive.no_doc_overflow',
} as const;

export type VisualMetricName =
  | 'visual.pixel_mismatch_pct'
  | 'visual.dimensions_match'
  | 'visual.capture_state_compatible'
  | 'visual.mask_resolution_complete'
  | 'visual.geometry_within_tolerance'
  | 'visual.cardinality_match'
  | 'visual.settle_complete'
  | 'visual.critical_regions_pass'; // Deferred: producer not yet wired; see Audit v5 §25

export const VISUAL_METRICS = {
  PIXEL_MISMATCH_PCT: 'visual.pixel_mismatch_pct',
  DIMENSIONS_MATCH: 'visual.dimensions_match',
  CAPTURE_STATE_COMPATIBLE: 'visual.capture_state_compatible',
  MASK_RESOLUTION_COMPLETE: 'visual.mask_resolution_complete',
  GEOMETRY_WITHIN_TOLERANCE: 'visual.geometry_within_tolerance',
  CARDINALITY_MATCH: 'visual.cardinality_match',
  SETTLE_COMPLETE: 'visual.settle_complete',
  CRITICAL_REGIONS_PASS: 'visual.critical_regions_pass', // Deferred: see Audit v5 §25
} as const;

export interface VisualEvidenceReceipt {
  match: boolean;
  mismatchPercentage: number;
  dimensionsMatch: boolean;
  captureStateCompatible: boolean;
  maskResolutionStatus: string;
  maskedAreaRatio: number;
  settleComplete: boolean;
  metricSamples: MetricSample[];
  notes?: string;
}
