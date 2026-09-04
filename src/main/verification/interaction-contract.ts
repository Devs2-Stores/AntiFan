/**
 * AntiFan Core - Interaction Contract & Semantic Evidence Types
 *
 * Grounding Axiom:
 * Claims are distinct from facts; confidence is not proof.
 * Raw observations represent empirical facts and must never carry synthetic confidence scores.
 * Only inferences carry confidence, machine-readable rationale, and causal attribution metadata.
 */

export type DeltaFieldStatus<T> =
  | { status: 'changed'; before: T; after: T; delta?: unknown }
  | { status: 'unchanged'; value: T }
  | { status: 'unavailable'; reason: string };

export interface RawTargetSnapshot {
  found: boolean;
  tagName?: string;
  classes?: string[];
  rect?: { x: number; y: number; width: number; height: number };
  ariaExpanded?: string | null;
  ariaHidden?: string | null;
  ariaSelected?: string | null;
  ariaModal?: string | null;
  display?: string;
  visibility?: string;
  opacity?: string;
  transform?: string;
}

export interface RawOverlayCandidate {
  tagName: string;
  id?: string;
  className: string;
  rect: { width: number; height: number };
  role?: string;
}

export interface RawBehaviorScope {
  url: string;
  title: string;
  bodyClasses: string[];
  bodyOverflowLocked: boolean;
  bodyOverflowY?: string;
  bodyOverflowX?: string;
  target?: RawTargetSnapshot;
  activeOverlays: RawOverlayCandidate[];
  hasHorizontalOverflow: boolean;
  scrollWidth: number;
  viewportWidth: number;
}

export interface OverlayCandidateDelta {
  added: RawOverlayCandidate[];
  removed: RawOverlayCandidate[];
  retained: Array<{
    before: RawOverlayCandidate;
    after: RawOverlayCandidate;
    rectChanged: boolean;
  }>;
}

export interface SparseInteractionDelta {
  target: {
    classes?: DeltaFieldStatus<string[]>;
    rect?: DeltaFieldStatus<{ x: number; y: number; width: number; height: number }>;
    style?: DeltaFieldStatus<{ display: string; visibility: string; opacity: string; transform: string }>;
    aria?: DeltaFieldStatus<{
      ariaExpanded: string | null;
      ariaHidden: string | null;
      ariaSelected: string | null;
      ariaModal: string | null;
    }>;
  };
  overlayCandidateDelta: OverlayCandidateDelta;
  document: {
    url?: DeltaFieldStatus<string>;
    bodyClasses?: DeltaFieldStatus<string[]>;
    bodyOverflowLocked?: DeltaFieldStatus<boolean>;
    hasHorizontalOverflow?: DeltaFieldStatus<boolean>;
  };
}

export type CausalityRelation =
  | 'DIRECT'     // Target element state change directly associated with the action
  | 'INDIRECT'   // Related disclosure/overlay/component state change
  | 'UNKNOWN';   // Unverified / correlation without listener-level lineage
export type AttributionMethod =
  | 'TEMPORAL'   // Inferred from timestamp correlation within attribution window
  | 'HEURISTIC'  // Inferred from selector, ARIA, or class matching
  | 'UNKNOWN';

export type AttributionScope = 'TARGET' | 'RELATED' | 'AMBIENT' | 'UNKNOWN';

export type AttributionReasonCode =
  | 'WITHIN_ACTION_WINDOW'
  | 'TARGET_MATCH'
  | 'RELATED_OVERLAY_APPEARED'
  | 'BODY_STATE_CHANGED'
  | 'ARIA_STATE_CHANGED'
  | 'OUTSIDE_ACTION_WINDOW'
  | 'INSUFFICIENT_EVIDENCE';

export type IntegrityStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'TRUNCATED'
  | 'STALE'
  | 'UNAVAILABLE';

export type IntegrityReason =
  | 'BUFFER_LIMIT_EXCEEDED'
  | 'OBSERVER_SETUP_FAILED'
  | 'ACTION_MARKER_FAILED'
  | 'ACTION_ABORTED'
  | 'DOCUMENT_CHANGED'
  | 'TARGET_DISAPPEARED'
  | 'TIMEOUT'
  | 'CLEAN_OBSERVATION';
export interface ObservationIntegrity {
  status: IntegrityStatus;
  reason?: IntegrityReason;
  details?: string;
  totalObserved: number;
  bufferLimit: number;
}

export interface ActionBoundary {
  armedAt: number;                // T_arm: Monotonic page performance.now() when observer armed
  actionStartedAt: number;        // T_action: Monotonic page performance.now() when action initiated
  settleStartedAt?: number;       // When settle pause began
  settledAt?: number;             // T_settle: Monotonic page performance.now() when settle completed
  attributionWindowMs: number;    // Enforced maximum window duration (e.g. 1500ms)
  attributionDeadline?: number;   // actionStartedAt + attributionWindowMs
}

export interface MutationObservationRecord {
  sequence: number;
  timestampOffsetMs: number;      // Monotonic offset relative to actionStartedAt (T_action)
  type: 'attributes' | 'childList' | 'characterData';
  targetTag?: string;
  targetId?: string;
  targetClass?: string;
  attributeName?: string;
  addedCount: number;
  removedCount: number;
  documentGeneration?: number;
  mutationRevision?: number;
}

export interface AttributionRecord {
  observation: MutationObservationRecord;
  classification: {
    causality: CausalityRelation;
    scope: AttributionScope;
    method: AttributionMethod;
  };
  inference?: {
    confidence: number;
    reasonCode: AttributionReasonCode;
    details?: string;
    derivedFrom?: string[];
  };
}

export interface MutationAttributionBatch {
  actionBoundary: ActionBoundary;
  integrity: ObservationIntegrity;
  records: AttributionRecord[];
  outOfBoundsCount: number;
}

export type InteractionOutcome =
  | 'EFFECT_OBSERVED'
  | 'NO_OBSERVABLE_EFFECT'
  | 'ACTION_FAILED'
  | 'MEASUREMENT_INCONCLUSIVE';
