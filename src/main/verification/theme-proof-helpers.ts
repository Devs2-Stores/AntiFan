/**
 * AntiFan Core — Theme Proof Helpers
 *
 * Bridges ThemeEvidenceEnvelope payloads into canonical MetricSample objects and
 * EvidenceSampleBundle for evaluation by VerificationEvaluator.
 */

import {
  MetricSample,
  ProofObligation,
  EvidenceSampleBundle,
  THEME_METRICS,
} from './verification-contract';
import { ThemeEvidenceEnvelope } from '../tools/theme-evidence-envelope';
import { SourceMappingResult, isAuthoritativeSourceCandidate } from '../browser/theme-source-mapper';
import { MatchedStylesResult } from '../browser/css-cascade-analyzer';

export interface ThemeEvidenceBundleInput {
  sourceMappingEnvelope?: ThemeEvidenceEnvelope<SourceMappingResult>;
  matchedStylesEnvelope?: ThemeEvidenceEnvelope<MatchedStylesResult>;
  responsiveMatrixEnvelope?: ThemeEvidenceEnvelope<Record<string, unknown>>;
  tabId?: string;
  documentGeneration?: number;
}

export class ThemeProofHelpers {
  /**
   * Constructs the standard canonical proof obligations for Theme Evidence verification.
   */
  public static buildThemeProofObligations(options: {
    criticalSourceFound?: boolean;
    criticalCssMatched?: boolean;
    criticalNoTargetOverflow?: boolean;
    requireStrongPass?: boolean;
  } = {}): ProofObligation[] {
    return [
      {
        id: 'obl-theme-source-found',
        metric: THEME_METRICS.SOURCE_FILE_IDENTIFIED,
        expected: true,
        critical: options.criticalSourceFound !== false,
        description: 'Target DOM element maps to a local theme Liquid file with sufficient evidence',
        source: 'deterministic',
      },
      {
        id: 'obl-theme-css-matched',
        metric: THEME_METRICS.CSS_ACTIVE_RULE_MATCHED,
        expected: true,
        critical: options.criticalCssMatched !== false,
        description: 'CDP cascade analysis isolates active CSS rules for the target element',
        source: 'deterministic',
      },
      {
        id: 'obl-theme-no-target-overflow',
        metric: THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW,
        expected: true,
        critical: options.criticalNoTargetOverflow !== false,
        description: 'Component must not overflow its container across all 5 tested breakpoints',
        source: 'deterministic',
      },
      {
        id: 'obl-theme-css-strong-pass',
        metric: THEME_METRICS.CSS_STRONG_PASS_RESOLVED,
        expected: true,
        critical: Boolean(options.requireStrongPass),
        description: 'Stylesheet source URL and line/column resolved (STRONG PASS DoD)',
        source: 'deterministic',
      },
      {
        id: 'obl-theme-no-doc-overflow',
        metric: THEME_METRICS.RESPONSIVE_NO_DOC_OVERFLOW,
        expected: true,
        critical: false,
        description: 'Entire document must not exhibit horizontal overflow across tested breakpoints',
        source: 'deterministic',
      },
    ];
  }

  /**
   * Converts a Source Mapping envelope to a MetricSample
   */
  public static sourceMappingToSample(
    envelope?: ThemeEvidenceEnvelope<SourceMappingResult>
  ): MetricSample {
    if (!envelope || !envelope.success) {
      return {
        metric: THEME_METRICS.SOURCE_FILE_IDENTIFIED,
        expected: true,
        actual: 'missing',
        passed: false,
        message: envelope?.error || 'Source mapping telemetry unavailable or failed',
        source: 'deterministic',
      };
    }

    const primary = envelope.data?.primaryCandidate;
    const passed = isAuthoritativeSourceCandidate(envelope.data);

    return {
      metric: THEME_METRICS.SOURCE_FILE_IDENTIFIED,
      expected: true,
      actual: passed,
      passed,
      message: primary
        ? `Candidate file: ${primary.file} (${primary.confidence}, score ${primary.score}; ${envelope.data?.selectionReason})`
        : envelope.data?.selectionReason || 'No authoritative candidate file identified',
      source: 'deterministic',
    };
  }

  /**
   * Converts a Matched Styles envelope to MetricSamples
   */
  public static matchedStylesToSamples(
    envelope?: ThemeEvidenceEnvelope<MatchedStylesResult>
  ): MetricSample[] {
    if (!envelope || !envelope.success) {
      return [
        {
          metric: THEME_METRICS.CSS_ACTIVE_RULE_MATCHED,
          expected: true,
          actual: 'missing',
          passed: false,
          message: envelope?.error || 'CSS matched styles telemetry unavailable or failed',
          source: 'deterministic',
        },
        {
          metric: THEME_METRICS.CSS_STRONG_PASS_RESOLVED,
          expected: true,
          actual: 'missing',
          passed: false,
          message: envelope?.error || 'CSS matched styles telemetry unavailable or failed',
          source: 'deterministic',
        },
      ];
    }

    const activeRules = envelope.data?.activeRules || [];
    const hasActiveRules = activeRules.length > 0;
    const isStrongPass = envelope.data?.definitionOfDone === 'STRONG PASS';

    return [
      {
        metric: THEME_METRICS.CSS_ACTIVE_RULE_MATCHED,
        expected: true,
        actual: hasActiveRules,
        passed: hasActiveRules,
        message: `${activeRules.length} active CSS declaration(s) isolated`,
        source: 'deterministic',
      },
      {
        metric: THEME_METRICS.CSS_STRONG_PASS_RESOLVED,
        expected: true,
        actual: isStrongPass,
        passed: isStrongPass,
        message: `Definition of Done: ${envelope.data?.definitionOfDone || 'PARTIAL'}`,
        source: 'deterministic',
      },
    ];
  }

  /**
   * Converts a Responsive Matrix envelope to MetricSamples
   */
  public static responsiveMatrixToSamples(
    envelope?: ThemeEvidenceEnvelope<Record<string, unknown>>
  ): MetricSample[] {
    if (!envelope || !envelope.success) {
      return [
        {
          metric: THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW,
          expected: true,
          actual: 'missing',
          passed: false,
          message: envelope?.error || 'Responsive matrix telemetry unavailable or failed',
          source: 'deterministic',
        },
        {
          metric: THEME_METRICS.RESPONSIVE_NO_DOC_OVERFLOW,
          expected: true,
          actual: 'missing',
          passed: false,
          message: envelope?.error || 'Responsive matrix telemetry unavailable or failed',
          source: 'deterministic',
        },
      ];
    }
    const allTested = envelope.signals.allBreakpointsTested === true;
    const hasTargetSignal = typeof envelope.signals.hasTargetOverflow === 'boolean';
    const hasDocSignal = typeof envelope.signals.hasDocOverflow === 'boolean';

    if (!allTested || !hasTargetSignal || !hasDocSignal) {
      return [
        {
          metric: THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW,
          expected: true,
          actual: 'missing',
          passed: false,
          message: 'Incomplete responsive telemetry: not all 5 standard breakpoints were evaluated or signals are missing',
          source: 'deterministic',
        },
        {
          metric: THEME_METRICS.RESPONSIVE_NO_DOC_OVERFLOW,
          expected: true,
          actual: 'missing',
          passed: false,
          message: 'Incomplete responsive telemetry: not all 5 standard breakpoints were evaluated or signals are missing',
          source: 'deterministic',
        },
      ];
    }

    const noTargetOverflow = envelope.signals.hasTargetOverflow === false;
    const noDocOverflow = envelope.signals.hasDocOverflow === false;

    return [
      {
        metric: THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW,
        expected: true,
        actual: noTargetOverflow,
        passed: noTargetOverflow,
        message: noTargetOverflow ? 'Zero target overflow across all 5 standard breakpoints' : 'Target horizontal overflow detected',
        source: 'deterministic',
      },
      {
        metric: THEME_METRICS.RESPONSIVE_NO_DOC_OVERFLOW,
        expected: true,
        actual: noDocOverflow,
        passed: noDocOverflow,
        message: noDocOverflow ? 'Zero document overflow across all 5 standard breakpoints' : 'Document horizontal overflow detected',
        source: 'deterministic',
      },
    ];
  }

  /**
   * Bundles all theme evidence samples into a canonical EvidenceSampleBundle
   */
  public static createEvidenceBundle(input: ThemeEvidenceBundleInput): EvidenceSampleBundle {
    const samples: MetricSample[] = [];

    samples.push(this.sourceMappingToSample(input.sourceMappingEnvelope));
    samples.push(...this.matchedStylesToSamples(input.matchedStylesEnvelope));
    samples.push(...this.responsiveMatrixToSamples(input.responsiveMatrixEnvelope));

    return {
      tabId: input.tabId || 'tab-active',
      documentGeneration: input.documentGeneration || 1,
      captureTimestamp: Date.now(),
      samples,
    };
  }
}
