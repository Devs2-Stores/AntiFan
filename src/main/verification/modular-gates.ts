/**
 * AntiFan Core - Modular Gates Substrate
 *
 * Architecture Law:
 * Core owns the 5 deterministic structural & behavioral gates:
 * 1. SPEC_READY: Static HTML/CSS syntax and relative asset path integrity.
 * 2. LAYOUT_READY: Section inventory alignment and height parity delta (<= 5%).
 * 3. RESPONSIVE_READY: Multi-viewport zero-horizontal-overflow validation (1440, 768, 375).
 * 4. INTERACTION_READY: Interactive states (modal, drawer, tab, accordion) toggle cleanly.
 * 5. MOTION_READY: Animation transition duration (delta <= 33ms) and easing curve match.
 *
 * Anti-Leakage Invariant:
 * THEME_READY is a composite platform workflow contract (Shopify/Haravan/Sapo cart,
 * variant matrices, Liquid templates) and MUST NOT be placed in Core.
 */

import { VerificationVerdict } from './verification-contract';

export interface GateResult {
  gate: 'SPEC_READY' | 'LAYOUT_READY' | 'RESPONSIVE_READY' | 'INTERACTION_READY' | 'MOTION_READY';
  passed: boolean;
  verdict: VerificationVerdict;
  metrics: Record<string, unknown>;
  violations: Array<{ code: string; message: string; severity: 'P0' | 'P1' | 'P2' }>;
  summary: string;
}

export interface SpecReadyInput {
  htmlContent?: string;
  hasConsoleErrors?: boolean;
  brokenAssetsCount?: number;
  relativeAssetViolations?: string[];
}

export interface LayoutReadyInput {
  specSectionCount: number;
  targetSectionCount: number;
  specHeight: number;
  targetHeight: number;
  tolerance?: number; // default 0.05 (5%)
  hasHorizontalOverflow?: boolean;
}

export interface ResponsiveViewportCheck {
  viewport: 'desktop' | 'tablet' | 'mobile';
  width: number;
  height: number;
  hasHorizontalOverflow: boolean;
  scrollWidth: number;
}

export interface InteractionReadyInput {
  action: string;
  selector: string;
  verified: boolean;
  verdict: string;
  overflowBleedDetected?: boolean;
}

export interface MotionReadyInput {
  expectedDurationMs: number;
  observedDurationMs: number;
  expectedEasing?: string;
  observedEasing?: string;
  temporalDeltaLimitMs?: number; // default 33ms
}

export class ModularGateValidator {
  /**
   * 1. SPEC_READY Gate: Validates static syntax, console sanity, and asset relative paths.
   */
  public static validateSpecReady(input: SpecReadyInput): GateResult {
    const violations: GateResult['violations'] = [];

    if (input.hasConsoleErrors) {
      violations.push({
        code: 'CONSOLE_SYNTAX_ERROR',
        message: 'Runtime console or syntax errors detected in spec document',
        severity: 'P1',
      });
    }

    if ((input.brokenAssetsCount || 0) > 0) {
      violations.push({
        code: 'BROKEN_ASSETS',
        message: `Detected ${input.brokenAssetsCount} broken or missing asset references`,
        severity: 'P1',
      });
    }

    if (input.relativeAssetViolations && input.relativeAssetViolations.length > 0) {
      violations.push({
        code: 'ILLEGAL_ASSET_PATH',
        message: `Absolute or traversal paths found in relative assets: ${input.relativeAssetViolations.join(', ')}`,
        severity: 'P1',
      });
    }

    const passed = violations.length === 0;
    return {
      gate: 'SPEC_READY',
      passed,
      verdict: passed ? 'VERIFIED' : 'REJECTED',
      metrics: {
        brokenAssetsCount: input.brokenAssetsCount || 0,
        hasConsoleErrors: Boolean(input.hasConsoleErrors),
        relativeViolationsCount: input.relativeAssetViolations?.length || 0,
      },
      violations,
      summary: passed ? 'SPEC_READY: Static spec and relative asset contracts verified' : `SPEC_READY: ${violations.length} violation(s) found`,
    };
  }

  /**
   * 2. LAYOUT_READY Gate: Validates section inventory and height delta within tolerance.
   */
  public static validateLayoutReady(input: LayoutReadyInput): GateResult {
    const violations: GateResult['violations'] = [];
    const tolerance = input.tolerance ?? 0.05;

    // Section count
    if (input.specSectionCount !== input.targetSectionCount) {
      violations.push({
        code: 'SECTION_COUNT_MISMATCH',
        message: `Section count mismatch: spec has ${input.specSectionCount}, target has ${input.targetSectionCount}`,
        severity: 'P1',
      });
    }

    // Height parity
    const heightDiff = Math.abs(input.targetHeight - input.specHeight);
    const heightDeltaPercent = input.specHeight > 0 ? heightDiff / input.specHeight : (input.targetHeight > 0 ? 1.0 : 0);
    if (heightDeltaPercent > tolerance) {
      violations.push({
        code: 'HEIGHT_PARITY_EXCEEDED',
        message: `Height delta ${(heightDeltaPercent * 100).toFixed(1)}% exceeds tolerance ${(tolerance * 100).toFixed(1)}% (spec: ${input.specHeight}px, target: ${input.targetHeight}px)`,
        severity: 'P1',
      });
    }

    // Overflow check
    if (input.hasHorizontalOverflow) {
      violations.push({
        code: 'HORIZONTAL_OVERFLOW',
        message: 'Layout has horizontal scroll bleed beyond viewport',
        severity: 'P1',
      });
    }

    const passed = violations.length === 0;
    return {
      gate: 'LAYOUT_READY',
      passed,
      verdict: passed ? 'VERIFIED' : 'REJECTED',
      metrics: {
        specSectionCount: input.specSectionCount,
        targetSectionCount: input.targetSectionCount,
        specHeight: input.specHeight,
        targetHeight: input.targetHeight,
        heightDeltaPercent: Number(heightDeltaPercent.toFixed(4)),
        tolerance,
      },
      violations,
      summary: passed
        ? `LAYOUT_READY: Layout parity confirmed (delta: ${(heightDeltaPercent * 100).toFixed(1)}%, tolerance: ${(tolerance * 100).toFixed(1)}%)`
        : `LAYOUT_READY: ${violations.length} layout parity violation(s)`,
    };
  }

  /**
   * 3. RESPONSIVE_READY Gate: Validates multi-viewport clean boundaries (zero horizontal scroll).
   */
  public static validateResponsiveReady(viewports: ResponsiveViewportCheck[]): GateResult {
    const violations: GateResult['violations'] = [];
    const viewportMetrics: Array<{ viewport: string; width: number; clean: boolean }> = new Array(viewports.length);

    for (let i = 0; i < viewports.length; i++) {
      const vp = viewports[i]!;
      const hasBleed = Boolean(vp.hasHorizontalOverflow || (vp.scrollWidth !== undefined && vp.scrollWidth > vp.width));
      const isClean = !hasBleed;
      viewportMetrics[i] = { viewport: vp.viewport, width: vp.width, clean: isClean };
      if (!isClean) {
        violations.push({
          code: 'RESPONSIVE_OVERFLOW_BLEED',
          message: `Viewport '${vp.viewport}' (${vp.width}px) has horizontal overflow bleed (overflow: ${Boolean(vp.hasHorizontalOverflow)}, scrollWidth: ${vp.scrollWidth}px, width: ${vp.width}px)`,
          severity: 'P1',
        });
      }
    }

    const passed = violations.length === 0;
    return {
      gate: 'RESPONSIVE_READY',
      passed,
      verdict: passed ? 'VERIFIED' : 'REJECTED',
      metrics: {
        viewportsChecked: viewports.length,
        viewports: viewportMetrics,
      },
      violations,
      summary: passed
        ? `RESPONSIVE_READY: All ${viewports.length} viewports clean with zero horizontal overflow`
        : `RESPONSIVE_READY: ${violations.length} viewport overflow violation(s)`,
    };
  }

  /**
   * 4. INTERACTION_READY Gate: Validates state transitions on gestures.
   */
  public static validateInteractionReady(inputs: InteractionReadyInput[]): GateResult {
    const violations: GateResult['violations'] = [];
    let verifiedCount = 0;

    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]!;
      if (inp.verified) {
        verifiedCount++;
      }
      if (!inp.verified || inp.verdict === 'NO_OBSERVABLE_EFFECT') {
        violations.push({
          code: 'INTERACTION_FAILED',
          message: `Action '${inp.action}' on '${inp.selector}' produced NO_OBSERVABLE_EFFECT or failed transition`,
          severity: 'P1',
        });
      }

      if (inp.overflowBleedDetected) {
        violations.push({
          code: 'INTERACTION_OVERFLOW_BLEED',
          message: `Action '${inp.action}' on '${inp.selector}' caused layout overflow bleed`,
          severity: 'P1',
        });
      }
    }

    const passed = violations.length === 0;
    return {
      gate: 'INTERACTION_READY',
      passed,
      verdict: passed ? 'VERIFIED' : 'REJECTED',
      metrics: {
        interactionsCount: inputs.length,
        verifiedCount,
      },
      violations,
      summary: passed ? `INTERACTION_READY: ${inputs.length} interactive transitions verified` : `INTERACTION_READY: ${violations.length} transition failure(s)`,
    };
  }
  /**
   * 5. MOTION_READY Gate: Validates timing and easing curves.
   */
  public static validateMotionReady(input: MotionReadyInput): GateResult {
    const violations: GateResult['violations'] = [];
    const limitMs = input.temporalDeltaLimitMs ?? 33; // 2 frames @ 60fps

    const temporalDelta = Math.abs(input.observedDurationMs - input.expectedDurationMs);
    if (temporalDelta > limitMs) {
      violations.push({
        code: 'TEMPORAL_DELTA_EXCEEDED',
        message: `Duration delta ${temporalDelta}ms exceeds tolerance ${limitMs}ms (expected: ${input.expectedDurationMs}ms, observed: ${input.observedDurationMs}ms)`,
        severity: 'P2',
      });
    }

    if (input.expectedEasing && input.observedEasing && input.expectedEasing !== input.observedEasing) {
      violations.push({
        code: 'EASING_CURVE_MISMATCH',
        message: `Easing curve mismatch: expected ${input.expectedEasing}, observed ${input.observedEasing}`,
        severity: 'P2',
      });
    }

    const passed = violations.length === 0;
    return {
      gate: 'MOTION_READY',
      passed,
      verdict: passed ? 'VERIFIED' : 'PARTIAL',
      metrics: {
        expectedDurationMs: input.expectedDurationMs,
        observedDurationMs: input.observedDurationMs,
        temporalDeltaMs: temporalDelta,
        limitMs,
        expectedEasing: input.expectedEasing,
        observedEasing: input.observedEasing,
      },
      violations,
      summary: passed
        ? `MOTION_READY: Motion parameters verified within ${limitMs}ms tolerance`
        : `MOTION_READY: Motion delta exceeded tolerance (${temporalDelta}ms > ${limitMs}ms)`,
    };
  }
}
