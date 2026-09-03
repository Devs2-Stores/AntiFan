/**
 * AntiFan Core - Verification Evaluator
 *
 * Authority Boundary:
 * Deterministic DOM/style/visual checks are primary ground truth.
 * A model or agent cannot claim success without verifiable proof.
 * High confidence scores cannot override missing or failed mechanical evidence.
 */

import {
  VerificationClaim,
  EvidenceSampleBundle,
  ProofProfile,
  ProofViolation,
  ProofCompleteness,
  ProofFreshness,
  ProofSource,
  VerificationVerdict,
  InconclusiveReason,
} from './verification-contract';

export interface EvaluationResult {
  verdict: VerificationVerdict;
  proofProfile: ProofProfile;
  inconclusiveReason?: InconclusiveReason;
  summary: string;
}

export interface EvaluatorOptions {
  allowStale?: boolean;
  strictCompleteness?: boolean;
  defaultTolerance?: number;
}

export class VerificationEvaluator {
  public static evaluate(
    claim: VerificationClaim,
    bundle: EvidenceSampleBundle,
    options?: EvaluatorOptions
  ): EvaluationResult {
    const violations: ProofViolation[] = [];
    const obligations = claim.proofObligations || [];

    // ─── 1. Freshness Check (DocumentGeneration Barrier) ───
    let freshness: ProofFreshness = 'FRESH';

    if (
      claim.targetGeneration !== undefined &&
      bundle.documentGeneration < claim.targetGeneration
    ) {
      freshness = 'STALE';
    } else if (
      bundle.currentTabGeneration !== undefined &&
      bundle.documentGeneration < bundle.currentTabGeneration
    ) {
      freshness = 'STALE';
    }

    if (freshness === 'STALE' && !options?.allowStale) {
      const proofProfile: ProofProfile = {
        completeness: 'EMPTY',
        freshness: 'STALE',
        source: 'deterministic',
        evaluatedMetricsCount: 0,
        passedMetricsCount: 0,
        violations: [
          {
            metric: 'documentGeneration',
            expected: claim.targetGeneration ?? bundle.currentTabGeneration,
            actual: bundle.documentGeneration,
            message: 'Evidence was captured on an obsolete documentGeneration',
          },
        ],
        documentGeneration: bundle.documentGeneration,
        captureTimestamp: bundle.captureTimestamp,
      };

      return {
        verdict: 'INCONCLUSIVE',
        inconclusiveReason: 'RESAMPLE',
        proofProfile,
        summary: 'Evidence rejected: Document generation is stale, resample required.',
      };
    }

    // ─── 2. Completeness & Metric Matching ───
    const samples = bundle.samples;
    const sampleCount = samples.length;
    let sampleMap: Map<string, (typeof samples)[number]> | undefined;
    if (sampleCount > 4) {
      sampleMap = new Map();
      for (let i = 0; i < sampleCount; i++) {
        const s = samples[i]!;
        sampleMap.set(s.metric, s);
      }
    }

    const getSample = (metric: string) => {
      if (sampleMap) return sampleMap.get(metric);
      for (let i = 0; i < sampleCount; i++) {
        if (samples[i]!.metric === metric) return samples[i];
      }
      return undefined;
    };

    let passedMetricsCount = 0;
    let evaluatedCount = 0;
    let hasCriticalFailure = false;

    for (const obl of obligations) {
      const sample = getSample(obl.metric);
      if (!sample) {
        if (obl.critical) {
          hasCriticalFailure = true;
          violations.push({
            metric: obl.metric,
            expected: obl.expected,
            actual: 'missing',
            message: `Critical proof obligation '${obl.metric}' is missing from evidence`,
          });
        }
        continue;
      }

      evaluatedCount++;
      const tolerance = obl.tolerance ?? options?.defaultTolerance ?? 0;
      const actualVal = sample.actual !== undefined ? sample.actual : sample.value;
      let passed: boolean;

      if (sample.passed !== undefined) {
        passed = Boolean(sample.passed);
      } else if (sample.delta !== undefined && typeof tolerance === 'number') {
        passed = Math.abs(sample.delta) <= tolerance;
      } else if (obl.expected !== undefined) {
        passed = actualVal === obl.expected;
      } else {
        // FAIL-CLOSED: A sample with no passed status and no expected comparison has no verifiable proof signal
        passed = false;
      }

      if (passed) {
        passedMetricsCount++;
      } else {
        if (obl.critical) {
          hasCriticalFailure = true;
        }
        violations.push({
          metric: obl.metric,
          expected: obl.expected ?? 'pass',
          actual: actualVal,
          delta: sample.delta,
          message: sample.message || `Metric '${obl.metric}' failed validation threshold`,
        });
      }
    }

    // ─── 3. Completeness Determination ───
    let completeness: ProofCompleteness = 'FULL';
    if (obligations.length === 0) {
      completeness = 'EMPTY';
    } else if (evaluatedCount === 0) {
      completeness = 'EMPTY';
    } else if (evaluatedCount < obligations.length) {
      completeness = 'PARTIAL';
    }

    const source: ProofSource = bundle.semanticWitness ? 'composite' : 'deterministic';

    const proofProfile: ProofProfile = {
      completeness,
      freshness,
      source,
      evaluatedMetricsCount: evaluatedCount,
      passedMetricsCount,
      violations,
      documentGeneration: bundle.documentGeneration,
      captureTimestamp: bundle.captureTimestamp,
    };

    // ─── 4. Verdict Synthesis ───
    if (completeness === 'EMPTY') {
      return {
        verdict: 'INCONCLUSIVE',
        inconclusiveReason: 'UNOBSERVABLE',
        proofProfile,
        summary: 'No proof obligations could be evaluated against available evidence.',
      };
    }

    if (hasCriticalFailure) {
      return {
        verdict: 'REJECTED',
        proofProfile,
        summary: `Verification REJECTED: ${violations.length} violations including critical obligations.`,
      };
    }

    if (violations.length > 0) {
      const isPartial = passedMetricsCount > 0 && !options?.strictCompleteness;
      return {
        verdict: isPartial ? 'PARTIAL' : 'REJECTED',
        proofProfile,
        summary: isPartial
          ? `Verification PARTIAL: ${passedMetricsCount}/${evaluatedCount} metrics passed, ${violations.length} minor violations.`
          : `Verification REJECTED: ${violations.length} violations observed.`,
      };
    }

    if (completeness === 'PARTIAL') {
      return {
        verdict: 'PARTIAL',
        inconclusiveReason: 'NEED_INPUT',
        proofProfile,
        summary: `Verification PARTIAL: Only ${evaluatedCount}/${obligations.length} proof obligations were observed.`,
      };
    }

    if (bundle.semanticWitness) {
      if (bundle.semanticWitness.modelConfirmed !== true) {
        return {
          verdict: 'PARTIAL',
          inconclusiveReason: 'NEED_INPUT',
          proofProfile,
          summary: `Verification PARTIAL: Mechanical checks passed, but semantic witness did not explicitly confirm (modelConfirmed: ${String(
            bundle.semanticWitness.modelConfirmed
          )})${
            bundle.semanticWitness.observations?.length
              ? `: ${bundle.semanticWitness.observations.join('; ')}`
              : '.'
          }`,
        };
      }
    }

    return {
      verdict: 'VERIFIED',
      proofProfile,
      summary: `Verification VERIFIED: All ${passedMetricsCount} obligations met deterministic proof criteria.`,
    };
  }
}
