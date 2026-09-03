/**
 * AntiFan Core - Stability Policy & Document Generation Barrier
 *
 * Grounding Axiom:
 * Verification evidence is truthful ONLY when captured on a quiescent document
 * that reflects the latest build generation.
 * Evidence captured on documentGeneration <= mutation.documentGeneration is STALE.
 */

export interface StabilityPolicyConfig {
  settleWindowMs: number;
  maxWaitMs: number;
  requireFirstPartyQuiescence: boolean;
  requireMediaFreeze: boolean;
  minDocumentGeneration?: number;
}

export const DEFAULT_STABILITY_POLICY: StabilityPolicyConfig = {
  settleWindowMs: 150,
  maxWaitMs: 3000,
  requireFirstPartyQuiescence: true,
  requireMediaFreeze: true,
};

export interface StabilityCheckResult {
  ready: boolean;
  settledAt?: number;
  reason?: 'DOCUMENT_STALE' | 'NETWORK_BUSY' | 'TIMEOUT' | 'MEDIA_ACTIVE';
  observedGeneration: number;
  requiredGeneration?: number;
}

export class StabilityPolicyEvaluator {
  /**
   * Verifies whether evidence conforms to the Document Generation Barrier.
   * If evidence was produced on an older or equal generation than the mutation,
   * it fails closed with DOCUMENT_STALE.
   */
  public static verifyGenerationBarrier(
    observedDocumentGeneration: number,
    mutationDocumentGeneration?: number
  ): { valid: boolean; error?: string } {
    if (mutationDocumentGeneration === undefined) {
      return { valid: true };
    }

    if (observedDocumentGeneration <= mutationDocumentGeneration) {
      return {
        valid: false,
        error: `DOCUMENT_STALE: Observed generation ${observedDocumentGeneration} is not newer than mutation generation ${mutationDocumentGeneration}`,
      };
    }

    return { valid: true };
  }

  /**
   * Evaluates stability state against the configured policy.
   */
  public static evaluateState(
    config: StabilityPolicyConfig,
    state: {
      observedGeneration: number;
      inflightFirstPartyCount: number;
      isMediaFrozen: boolean;
      timeSinceLastMutationMs: number;
    }
  ): StabilityCheckResult {
    // 1. Generation barrier check
    if (state.observedGeneration < 0 || !Number.isFinite(state.observedGeneration) ||
        (config.minDocumentGeneration !== undefined && state.observedGeneration < config.minDocumentGeneration)) {
      return {
        ready: false,
        reason: 'DOCUMENT_STALE',
        observedGeneration: state.observedGeneration,
        requiredGeneration: config.minDocumentGeneration,
      };
    }

    // 2. First party network quiescence
    if (config.requireFirstPartyQuiescence && state.inflightFirstPartyCount > 0) {
      return {
        ready: false,
        reason: 'NETWORK_BUSY',
        observedGeneration: state.observedGeneration,
        requiredGeneration: config.minDocumentGeneration,
      };
    }

    // 3. Media freeze requirement
    if (config.requireMediaFreeze && !state.isMediaFrozen) {
      return {
        ready: false,
        reason: 'MEDIA_ACTIVE',
        observedGeneration: state.observedGeneration,
        requiredGeneration: config.minDocumentGeneration,
      };
    }

    // 4. Settle window
    if (state.timeSinceLastMutationMs < config.settleWindowMs) {
      return {
        ready: false,
        reason: 'TIMEOUT',
        observedGeneration: state.observedGeneration,
        requiredGeneration: config.minDocumentGeneration,
      };
    }

    return {
      ready: true,
      settledAt: Date.now(),
      observedGeneration: state.observedGeneration,
      requiredGeneration: config.minDocumentGeneration,
    };
  }
}
