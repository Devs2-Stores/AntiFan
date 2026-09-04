/**
 * AntiFan Core - Mutation Attribution & Temporal Boundary Engine
 *
 * Pure domain function: attributes in-page mutation streams to an interaction boundary.
 * Adheres to:
 * 1. Single Relative Offset: raw.t is strictly the monotonic offset (ms) relative to actionStartedAt (T_action).
 * 2. Enforced Temporal Invariant: mutations beyond attributionWindowMs are strictly out of bounds.
 * 3. Zero Hallucination Causality:
 *    - In the absence of JS action-handler listener tracing, causality relation is strictly UNKNOWN.
 *    - Scope is classified heuristically (TARGET vs RELATED vs AMBIENT).
 *    - Method records whether temporal correlation or heuristic pattern matching was applied.
 * 4. Observation Integrity: flags buffer truncation with machine-readable reason.
 */

import {
  ActionBoundary,
  AttributionMethod,
  AttributionReasonCode,
  AttributionRecord,
  AttributionScope,
  CausalityRelation,
  MutationAttributionBatch,
  MutationObservationRecord,
  ObservationIntegrity,
} from './interaction-contract.js';

export interface RawMutationInput {
  t: number;                          // Monotonic offset in ms relative to actionStartedAt (t >= 0)
  type: 'attributes' | 'childList' | 'characterData';
  targetTag?: string;
  targetId?: string;
  targetClass?: string;
  attributeName?: string;
  addedCount?: number;
  removedCount?: number;
  documentGeneration?: number;
  mutationRevision?: number;
}

export interface TargetContextHint {
  selector?: string;
  ref?: string;
  id?: string;
  className?: string;
  tagName?: string;
}

const RELATED_OVERLAY_REGEX = /(modal|drawer|dialog|dropdown|submenu|popup|popover|cart|badge|toast|sheet|offcanvas)/i;

function matchesTarget(m: RawMutationInput, hint?: TargetContextHint): boolean {
  if (!hint) return false;
  if (hint.id && m.targetId && hint.id.trim() === m.targetId.trim()) {
    return true;
  }
  if (hint.className && m.targetClass) {
    const hintClasses = hint.className.split(/\s+/).filter(Boolean);
    const mutClasses = m.targetClass.split(/\s+/).filter(Boolean);
    if (hintClasses.some(c => mutClasses.includes(c))) {
      return true;
    }
  }
  if (hint.tagName && m.targetTag && hint.tagName.toLowerCase() === m.targetTag.toLowerCase()) {
    if (!hint.id && !hint.className) return true;
  }
  return false;
}

function isRelatedCandidate(m: RawMutationInput): boolean {
  if (m.targetClass && RELATED_OVERLAY_REGEX.test(m.targetClass)) return true;
  if (m.targetId && RELATED_OVERLAY_REGEX.test(m.targetId)) return true;
  if (m.targetTag && (m.targetTag.toLowerCase() === 'dialog' || m.targetTag.toLowerCase() === 'menu')) return true;
  if (m.attributeName && /^(aria-expanded|aria-hidden|aria-modal|aria-controls|open)$/i.test(m.attributeName)) return true;
  return false;
}

export function attributeMutations(
  rawMutations: RawMutationInput[],
  boundary: ActionBoundary,
  hint?: TargetContextHint,
  options?: {
    bufferLimit?: number;
    wasTruncated?: boolean;
  }
): MutationAttributionBatch {
  const bufferLimit = options?.bufferLimit ?? 100;
  const isTruncated = Boolean(options?.wasTruncated || rawMutations.length >= bufferLimit);

  const integrity: ObservationIntegrity = {
    status: isTruncated ? 'TRUNCATED' : 'COMPLETE',
    reason: isTruncated ? 'BUFFER_LIMIT_EXCEEDED' : 'CLEAN_OBSERVATION',
    details: isTruncated
      ? 'Mutation stream hit or exceeded buffer capacity; trailing mutations were dropped'
      : undefined,
    totalObserved: rawMutations.length,
    bufferLimit,
  };

  const records: AttributionRecord[] = [];
  let outOfBoundsCount = 0;

  for (let i = 0; i < rawMutations.length; i++) {
    const raw = rawMutations[i]!;

    // Enforced Temporal Deadline Check
    // If mutation occurred beyond the enforced relative window duration, it MUST NOT be attributed
    if (raw.t > boundary.attributionWindowMs) {
      outOfBoundsCount++;
      continue;
    }

    const observation: MutationObservationRecord = {
      sequence: i + 1,
      timestampOffsetMs: Math.max(0, Math.round(raw.t)),
      type: raw.type,
      targetTag: raw.targetTag,
      targetId: raw.targetId,
      targetClass: raw.targetClass,
      attributeName: raw.attributeName,
      addedCount: raw.addedCount ?? 0,
      removedCount: raw.removedCount ?? 0,
      documentGeneration: raw.documentGeneration,
      mutationRevision: raw.mutationRevision,
    };

    // Causality is UNKNOWN in P0 because current collector does not trace JS listener callstacks
    const causality: CausalityRelation = 'UNKNOWN';
    let scope: AttributionScope = 'UNKNOWN';
    let method: AttributionMethod = 'UNKNOWN';
    let reasonCode: AttributionReasonCode = 'INSUFFICIENT_EVIDENCE';
    let inferenceConfidence = 0.5;
    let details = 'Causality relation is UNKNOWN pending action-handler lineage; scope was classified heuristically.';

    if (matchesTarget(raw, hint)) {
      scope = 'TARGET';
      method = 'TEMPORAL';
      reasonCode = 'TARGET_MATCH';
      inferenceConfidence = 0.9;
      details = 'Target element matched hint identity within active causal window; action-handler lineage uninstrumented.';
    } else if (isRelatedCandidate(raw)) {
      scope = 'RELATED';
      method = 'HEURISTIC';
      reasonCode = 'RELATED_OVERLAY_APPEARED';
      inferenceConfidence = 0.75;
      details = 'Matched candidate disclosure/portal pattern within active causal window; action-handler lineage uninstrumented.';
    } else {
      scope = 'AMBIENT';
      method = 'TEMPORAL';
      reasonCode = 'WITHIN_ACTION_WINDOW';
      inferenceConfidence = 0.5;
      details = 'Uncorrelated ambient DOM mutation occurring within settle window; causality unproven.';
    }

    records.push({
      observation,
      classification: {
        causality,
        scope,
        method,
      },
      inference: {
        confidence: inferenceConfidence,
        reasonCode,
        details,
        derivedFrom: [`mutation-${i + 1}`],
      },
    });
  }

  return {
    actionBoundary: boundary,
    integrity,
    records,
    outOfBoundsCount,
  };
}
