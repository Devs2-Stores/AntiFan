/**
 * AntiFan Core - Canonical Proof Templates
 *
 * Anti-Gaming Invariant:
 * Agents MUST NOT invent arbitrarily weak or empty proof obligations.
 * Claims MUST adhere to canonical proof obligations tailored to their domain
 * (Interaction, Layout, Responsive).
 */

import { ProofObligation } from './verification-contract';

export type ClaimCategory = 'INTERACTION' | 'LAYOUT' | 'RESPONSIVE' | 'CUSTOM';

export interface CanonicalProofSpec {
  category: ClaimCategory;
  description: string;
  obligations: ProofObligation[];
}

export class ProofTemplateRegistry {
  /**
   * Returns canonical obligations for interaction claims.
   * Mandates:
   * 1. Target existence
   * 2. Observable style / state mutation
   * 3. Zero layout bleed
   */
  public static getInteractionTemplate(targetSelector: string): ProofObligation[] {
    return [
      {
        id: 'obl-interaction-target-present',
        metric: `element_present:${targetSelector}`,
        source: 'deterministic',
        description: `Target element ${targetSelector} must be present in DOM`,
      },
      {
        id: 'obl-interaction-observable-effect',
        metric: 'observable_mutation_effect',
        source: 'deterministic',
        critical: true,
        description: 'Gesture must produce an observable DOM, style, overlay, or URL transition',
      },
      {
        id: 'obl-interaction-no-overflow-bleed',
        metric: 'no_layout_overflow_bleed',
        source: 'deterministic',
        description: 'Gesture must not cause horizontal layout overflow beyond viewport',
      },
    ];
  }

  /**
   * Returns canonical obligations for layout parity claims.
   * Mandates:
   * 1. Section inventory completeness
   * 2. Height parity delta <= 5% (or custom tolerance)
   * 3. No horizontal scroll bleed
   */
  public static getLayoutTemplate(
    expectedHeightOrSectionCount?: number,
    expectedSectionCountOrTolerance?: number,
    tolerance = 0.05
  ): ProofObligation[] {
    let expectedHeight: number | undefined;
    let expectedSectionCount: number | undefined;
    let effectiveTolerance = tolerance;

    if (
      typeof expectedSectionCountOrTolerance === 'number' &&
      expectedSectionCountOrTolerance < 1 &&
      tolerance === 0.05
    ) {
      // Called with (expectedSectionCount, tolerance) signature
      expectedSectionCount = expectedHeightOrSectionCount;
      effectiveTolerance = expectedSectionCountOrTolerance;
    } else {
      expectedHeight = expectedHeightOrSectionCount;
      expectedSectionCount = expectedSectionCountOrTolerance;
      effectiveTolerance = tolerance;
    }

    const obligations: ProofObligation[] = [
      {
        id: 'obl-layout-height-parity',
        metric: 'height_parity_delta',
        expected: expectedHeight,
        tolerance: effectiveTolerance,
        source: 'deterministic',
        description: `Total scroll height must match target within ${Math.round(effectiveTolerance * 100)}% tolerance`,
      },
      {
        id: 'obl-layout-no-horizontal-overflow',
        metric: 'no_layout_overflow_bleed',
        source: 'deterministic',
        description: 'Page layout must not bleed horizontally outside viewport boundary',
      },
    ];
    if (expectedSectionCount !== undefined && expectedSectionCount > 0) {
      obligations.unshift({
        id: 'obl-layout-section-count',
        metric: 'section_inventory_count',
        expected: expectedSectionCount,
        tolerance: 0,
        source: 'deterministic',
        description: `Page must contain exactly ${expectedSectionCount} visual sections`,
      });
    }

    return obligations;
  }

  private static readonly CANONICAL_RESPONSIVE_TEMPLATE: ReadonlyArray<ProofObligation> = Object.freeze([
    Object.freeze({
      id: 'obl-responsive-mobile-no-bleed',
      metric: 'mobile_zero_overflow_bleed',
      source: 'deterministic',
      description: 'Mobile viewport (390px) must have zero horizontal overflow scroll',
    }),
    Object.freeze({
      id: 'obl-responsive-desktop-clean',
      metric: 'desktop_zero_overflow_bleed',
      source: 'deterministic',
      description: 'Desktop viewport (1440px) must maintain clean boundaries',
    }),
    Object.freeze({
      id: 'obl-responsive-touch-actionable',
      metric: 'touch_targets_actionable',
      source: 'deterministic',
      description: 'Navigation and primary controls must remain actionable across viewports',
    }),
  ]);

  /**
   * Returns canonical obligations for responsive claims.
   * Mandates:
   * 1. Mobile viewport (390px) zero horizontal overflow
   * 2. Desktop viewport (1440px) structure stability
   */
  public static getResponsiveTemplate(): ProofObligation[] {
    return this.CANONICAL_RESPONSIVE_TEMPLATE.map((o) => ({ ...o }));
  }
  /**
   * Augments a claim with mandatory canonical proof obligations based on category.
   */
  public static augmentObligations(
    category: ClaimCategory,
    customObligations: ProofObligation[] = [],
    options?: {
      targetSelector?: string;
      expectedSections?: number;
      expectedHeight?: number;
      tolerance?: number;
    }
  ): ProofObligation[] {
    const customHeightObl = customObligations.find(
      (o) => o.id === 'obl-layout-height-parity' || o.metric === 'height_parity_delta'
    );
    const resolvedHeight =
      options?.expectedHeight ?? (typeof customHeightObl?.expected === 'number' ? customHeightObl.expected : undefined);

    const customSectionObl = customObligations.find(
      (o) => o.id === 'obl-layout-section-count' || o.metric === 'section_inventory_count'
    );
    const resolvedSections =
      options?.expectedSections ??
      (typeof customSectionObl?.expected === 'number' ? customSectionObl.expected : undefined);

    const resolvedTolerance =
      options?.tolerance ?? (typeof customHeightObl?.tolerance === 'number' ? customHeightObl.tolerance : 0.05);

    let canonical: ProofObligation[] = [];

    switch (category) {
      case 'INTERACTION':
        canonical = this.getInteractionTemplate(options?.targetSelector || 'body');
        break;
      case 'LAYOUT':
        canonical = this.getLayoutTemplate(resolvedHeight, resolvedSections, resolvedTolerance);
        break;
      case 'RESPONSIVE':
        canonical = this.getResponsiveTemplate();
        break;
      default:
        canonical = [];
        break;
    }
    if (customObligations.length === 0) {
      return canonical;
    }

    // Canonical obligations ALWAYS win and cannot be overridden or shadowed by caller IDs.
    const canonicalIds = new Set(canonical.map((o) => o.id));
    const safeCustom = customObligations.filter((o) => !canonicalIds.has(o.id));
    return [...canonical, ...safeCustom];
  }

  /**
   * Detects whether an obligation list contains only non-discriminating DOM presence checks
   * (e.g. element_present:*, element.exists, dom.exists, dom.*) without any behavioral,
   * mutation, style, or layout metric.
   */
  public static isPurePresenceCheck(obligations: ProofObligation[]): boolean {
    if (!obligations || obligations.length === 0) return true;
    return obligations.every((o) => {
      const m = o.metric.trim().toLowerCase();
      return (
        m.startsWith('element_present:') ||
        m === 'element.exists' ||
        m === 'dom.exists' ||
        m === 'element_exists' ||
        m === 'dom.present' ||
        m.startsWith('dom.')
      );
    });
  }
}
