/**
 * AntiFan Core — CSS Cascade Analyzer
 *
 * Transforms raw Chromium CDP CSS.getMatchedStylesForNode payloads into
 * causality-aware CSS evidence. Distinguishes ACTIVE declarations from
 * OVERRIDDEN rules and evaluates the Tiered Definition of Done (PASS vs STRONG PASS).
 */

import {
  ThemeEvidenceEnvelope,
  createThemeEvidenceEnvelope,
} from '../tools/theme-evidence-envelope';

export interface CssDeclaration {
  property: string;
  value: string;
  selector: string;
  specificity: [number, number, number];
  styleSheetId?: string;
  sourceUrl?: string;
  line?: number;
  column?: number;
  important: boolean;
  status: 'ACTIVE' | 'OVERRIDDEN';
}

export interface MatchedStylesResult {
  activeRules: CssDeclaration[];
  overriddenRules: CssDeclaration[];
  cssVariables: Record<string, string>;
  definitionOfDone: 'STRONG PASS' | 'PASS' | 'PARTIAL';
  totalRulesAnalyzed: number;
}

export interface RawCdpProperty {
  name: string;
  value: string;
  important?: boolean;
  disabled?: boolean;
  parsedOk?: boolean;
}

export interface RawCdpRule {
  selectorList?: {
    selectors?: Array<{ text: string }>;
    text?: string;
  };
  style?: {
    cssProperties?: RawCdpProperty[];
    styleSheetId?: string;
  };
  styleSheetId?: string;
  sourceUrl?: string;
  origin?: string;
}

export interface RawCdpMatchedRuleItem {
  rule: RawCdpRule;
  matchingSelectors?: number[];
}

export interface RawCdpMatchedStylesPayload {
  matchedCSSRules?: RawCdpMatchedRuleItem[];
  inlineStyle?: {
    cssProperties?: RawCdpProperty[];
  };
}

export class CssCascadeAnalyzer {
  /**
   * Computes standard CSS specificity tuple: [IDs, Classes/Attributes/Pseudos, Elements/Pseudo-elements]
   */
  public static calculateSpecificity(selector: string): [number, number, number] {
    let a = 0;
    let b = 0;
    let c = 0;

    const cleaned = selector
      .replace(/:not\(([^)]*)\)/g, '$1')
      .replace(/:is\(([^)]*)\)/g, '$1')
      .replace(/:where\([^)]*\)/g, '');

    // IDs (#id)
    const idMatches = cleaned.match(/#[a-zA-Z0-9_-]+/g);
    if (idMatches) a += idMatches.length;

    // Pseudo-elements (::before, ::after)
    const pseudoElemMatches = cleaned.match(/::[a-zA-Z0-9_-]+/g);
    if (pseudoElemMatches) c += pseudoElemMatches.length;

    // Remove pseudo-elements before counting single-colon pseudo-classes
    const withoutPseudoElems = cleaned.replace(/::[a-zA-Z0-9_-]+/g, '');

    // Classes (.class)
    const classMatches = withoutPseudoElems.match(/\.[a-zA-Z0-9_-]+/g);
    if (classMatches) b += classMatches.length;

    // Attributes ([attr=value])
    const attrMatches = withoutPseudoElems.match(/\[[^\]]+\]/g);
    if (attrMatches) b += attrMatches.length;

    // Pseudo-classes (:hover, :focus)
    const pseudoClassMatches = withoutPseudoElems.match(/:[a-zA-Z0-9_-]+/g);
    if (pseudoClassMatches) b += pseudoClassMatches.length;

    // Elements (tag names)
    const stripped = withoutPseudoElems
      .replace(/#[a-zA-Z0-9_-]+/g, ' ')
      .replace(/\.[a-zA-Z0-9_-]+/g, ' ')
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/:[a-zA-Z0-9_-]+/g, ' ')
      .replace(/[>+~]/g, ' ')
      .trim();

    const words = stripped.split(/\s+/).filter((w) => w.length > 0 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(w));
    c += words.length;

    return [a, b, c];
  }

  public static compareSpecificity(s1: [number, number, number], s2: [number, number, number]): number {
    if (s1[0] !== s2[0]) return s1[0] - s2[0];
    if (s1[1] !== s2[1]) return s1[1] - s2[1];
    return s1[2] - s2[2];
  }

  public static analyze(
    rawPayload: unknown,
    stylesheetUrlMap: Record<string, string> = {}
  ): ThemeEvidenceEnvelope<MatchedStylesResult> {
    const startTime = Date.now();

    if (!rawPayload || typeof rawPayload !== 'object') {
      return createThemeEvidenceEnvelope<MatchedStylesResult>({
        success: false,
        evidenceQuality: 'LOW',
        signals: {
          hasMatchedRules: false,
          hasStylesheetId: false,
          hasResolvedUrl: false,
        },
        error: 'Invalid or missing CDP getMatchedStylesForNode payload',
      });
    }

    const payload = rawPayload as RawCdpMatchedStylesPayload;
    const rawRules = Array.isArray(payload.matchedCSSRules) ? payload.matchedCSSRules : [];

    const allDeclarations: Array<Omit<CssDeclaration, 'status'> & { order: number }> = [];
    const cssVariables: Record<string, string> = {};
    let orderCounter = 0;

    for (const item of rawRules) {
      const rule = item.rule;
      if (!rule || !rule.style || !Array.isArray(rule.style.cssProperties)) continue;

      const selectors = rule.selectorList?.selectors?.map((s) => s.text) || [rule.selectorList?.text || ''];
      const primarySelector = selectors[0] || '*';
      const specificity = this.calculateSpecificity(primarySelector);
      const sheetId = rule.styleSheetId || rule.style.styleSheetId;
      const sourceUrl = rule.sourceUrl || (sheetId && stylesheetUrlMap ? stylesheetUrlMap[sheetId] : undefined);
      for (const prop of rule.style.cssProperties) {
        if (!prop.name || prop.disabled) continue;
        const propName = prop.name.trim();
        const propVal = (prop.value || '').trim();

        if (propName.startsWith('--')) {
          cssVariables[propName] = propVal;
        } else {
          const varMatch = propVal.match(/var\((--[\w-]+)\)/);
          if (varMatch && varMatch[1]) {
            cssVariables[varMatch[1]] = propVal;
          }
        }

        allDeclarations.push({
          property: propName,
          value: propVal,
          selector: primarySelector,
          specificity,
          styleSheetId: sheetId,
          sourceUrl,
          important: Boolean(prop.important),
          order: orderCounter++,
        });
      }
    }

    // Determine ACTIVE vs OVERRIDDEN
    // Cascade resolution: group declarations by property name
    const propBuckets = new Map<string, Array<typeof allDeclarations[0]>>();
    for (const decl of allDeclarations) {
      const list = propBuckets.get(decl.property) || [];
      list.push(decl);
      propBuckets.set(decl.property, list);
    }

    const activeRules: CssDeclaration[] = [];
    const overriddenRules: CssDeclaration[] = [];

    for (const [propName, bucket] of propBuckets.entries()) {
      // Sort bucket by cascade precedence:
      // 1. important flag (true > false)
      // 2. specificity [a, b, c]
      // 3. source order (later order wins)
      bucket.sort((a, b) => {
        if (a.important !== b.important) {
          return a.important ? 1 : -1;
        }
        const specDiff = CssCascadeAnalyzer.compareSpecificity(a.specificity, b.specificity);
        if (specDiff !== 0) {
          return specDiff;
        }
        return a.order - b.order;
      });

      const winner = bucket[bucket.length - 1];
      if (winner) {
        activeRules.push({
          property: winner.property,
          value: winner.value,
          selector: winner.selector,
          specificity: winner.specificity,
          styleSheetId: winner.styleSheetId,
          sourceUrl: winner.sourceUrl,
          important: winner.important,
          status: 'ACTIVE',
        });
      }

      for (let i = 0; i < bucket.length - 1; i++) {
        const loser = bucket[i];
        if (loser) {
          overriddenRules.push({
            property: loser.property,
            value: loser.value,
            selector: loser.selector,
            specificity: loser.specificity,
            styleSheetId: loser.styleSheetId,
            sourceUrl: loser.sourceUrl,
            important: loser.important,
            status: 'OVERRIDDEN',
          });
        }
      }
    }

    // Evaluate Tiered Definition of Done
    let definitionOfDone: 'STRONG PASS' | 'PASS' | 'PARTIAL' = 'PARTIAL';
    const hasActiveRules = activeRules.length > 0;
    const hasStylesheetIds = activeRules.some((r) => Boolean(r.styleSheetId));
    const hasResolvedUrls = activeRules.some((r) => Boolean(r.sourceUrl));

    if (hasActiveRules && hasStylesheetIds && hasResolvedUrls) {
      definitionOfDone = 'STRONG PASS';
    } else if (hasActiveRules && hasStylesheetIds) {
      definitionOfDone = 'PASS';
    } else if (hasActiveRules) {
      definitionOfDone = 'PARTIAL';
    }

    const evidenceQuality = definitionOfDone === 'STRONG PASS' ? 'HIGH' : definitionOfDone === 'PASS' ? 'MEDIUM' : 'LOW';

    return createThemeEvidenceEnvelope<MatchedStylesResult>({
      success: true,
      evidenceQuality,
      data: {
        activeRules,
        overriddenRules,
        cssVariables,
        definitionOfDone,
        totalRulesAnalyzed: rawRules.length,
      },
      signals: {
        hasMatchedRules: hasActiveRules,
        hasStylesheetId: hasStylesheetIds,
        hasResolvedUrl: hasResolvedUrls,
      },
      timestamp: startTime,
    });
  }
}
