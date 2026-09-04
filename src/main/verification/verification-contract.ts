/**
 * AntiFan Core - Verification Contract & 5 Primitives Substrate
 *
 * Grounding Axiom:
 * Claims are distinct from facts; confidence is not proof.
 * Only deterministic & semantic evidence evaluated through verifiable contracts
 * can transition a claim to VERIFIED.
 */

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

export type StalemateState = 'ACTIVE' | 'STALEMATE' | 'EXEMPTION_WAIVED';

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
  exemptionReason?: string;
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
