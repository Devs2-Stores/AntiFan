import { DomTreeParser, ParsedElementNode } from '../models/dom-tree-parser.js';

/**
 * QA: Mutation QA Safety Harness
 * Stress-tests layout resilience, text-wrap, cardinality shifts, and image distortions
 * Authoritative measurements execute via live Chromium CDP; static fixtures provide mutant payloads
 */
export type MutationScenarioType =
  | 'text_stretch'
  | 'cardinality_1'
  | 'cardinality_11'
  | 'image_ratio_tall'
  | 'image_ratio_wide';

export interface MutationScenarioConfig {
  type: MutationScenarioType;
  description: string;
  hardBlockerThresholds: {
    maxHorizontalOverflowPx: number;
    minHeightRatio: number;
    maxHeightRatio: number;
    allowOverlappingBoxes: boolean;
    allowUnrenderedLiquid: boolean;
  };
}

export interface MutationMeasurement {
  targetFound: boolean;
  cardCount: number;
  scrollWidth: number;
  clientWidth: number;
  overflowDeltaX: number;
  cardWidth?: number;
  cardHeight?: number;
  baselineCardHeight?: number;
  heightRatio?: number;
  imageFound: boolean;
  imageLoaded: boolean;
  imageRenderWidth?: number;
  imageRenderHeight?: number;
  aspectRatioDistortion?: number;
  objectFitApplied?: boolean;
  priceFound: boolean;
  priceValid: boolean;
  priceValue?: number;
  navControlsHidden?: boolean;
  gridWrapAndRowAlignmentValid?: boolean;
  liquidLeakDetected: boolean;
  overlapDetected: boolean;
  details?: Record<string, unknown>;
}

export interface MutationResult {
  scenario: MutationScenarioType;
  passed: boolean;
  measurement: MutationMeasurement;
  hardBlockerTriggered: boolean;
  failureReasons: string[];
}

export class MutationQAHarness {
  public static readonly SCENARIOS: Record<MutationScenarioType, MutationScenarioConfig> = {
    text_stretch: {
      type: 'text_stretch',
      description: 'Injects 200-character unspaced and spaced Vietnamese string into product titles to test word-break and line clamp',
      hardBlockerThresholds: {
        maxHorizontalOverflowPx: 2,
        minHeightRatio: 0.5,
        maxHeightRatio: 3.5,
        allowOverlappingBoxes: false,
        allowUnrenderedLiquid: false
      }
    },
    cardinality_1: {
      type: 'cardinality_1',
      description: 'Mutates product repeaters to 1 item to verify card width capping and graceful navigation hiding',
      hardBlockerThresholds: {
        maxHorizontalOverflowPx: 2,
        minHeightRatio: 0.3,
        maxHeightRatio: 2.0,
        allowOverlappingBoxes: false,
        allowUnrenderedLiquid: false
      }
    },
    cardinality_11: {
      type: 'cardinality_11',
      description: 'Mutates product repeaters to 11 items to test grid wrap, column gap alignment, and negative margin containment',
      hardBlockerThresholds: {
        maxHorizontalOverflowPx: 2,
        minHeightRatio: 0.5,
        maxHeightRatio: 4.0,
        allowOverlappingBoxes: false,
        allowUnrenderedLiquid: false
      }
    },
    image_ratio_tall: {
      type: 'image_ratio_tall',
      description: 'Mutates product images to 1:3 ultra-tall aspect ratio to verify object-fit and card height containment',
      hardBlockerThresholds: {
        maxHorizontalOverflowPx: 2,
        minHeightRatio: 0.5,
        maxHeightRatio: 2.5,
        allowOverlappingBoxes: false,
        allowUnrenderedLiquid: false
      }
    },
    image_ratio_wide: {
      type: 'image_ratio_wide',
      description: 'Mutates product images to 3:1 ultra-wide aspect ratio to verify aspect ratio distortion protection',
      hardBlockerThresholds: {
        maxHorizontalOverflowPx: 2,
        minHeightRatio: 0.5,
        maxHeightRatio: 2.5,
        allowOverlappingBoxes: false,
        allowUnrenderedLiquid: false
      }
    }
  };

  /**
   * 200-character test payload with unspaced tokens and Vietnamese diacritics
   */
  public static readonly LONG_TEXT_PAYLOAD =
    'Sản phẩm thử nghiệm siêu dài 200 ký tự supercalifragilisticexpialidocious_1234567890_abcdefghij nhằm kiểm tra khả năng bẻ dòng và tính ổn định của layout giao diện người dùng trên mọi loại màn hình hiển thị';

  /**
   * Inline SVG data-URIs for image ratio stress tests
   */
  public static readonly SVG_TALL =
    'data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 900" width="300" height="900"><rect width="100%" height="100%" fill="%23e2e8f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="24" fill="%23475569">1:3 Tall</text></svg>';

  public static readonly SVG_WIDE =
    'data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300" width="900" height="300"><rect width="100%" height="100%" fill="%23e2e8f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="24" fill="%23475569">3:1 Wide</text></svg>';

  /**
   * Identifies candidate product cards, strictly excluding navigation, headers, footers, and blog articles
   */
  public static findProductCards(root: ParsedElementNode): ParsedElementNode[] {
    // 1. Check explicit role attribute first
    const explicitCards = DomTreeParser.findByAttribute(root, 'data-antifan-product');
    if (explicitCards.length > 0) return explicitCards;

    // 2. Locate cards by specific product class archetypes
    const rawCandidates = [
      ...DomTreeParser.findByClass(root, 'product-card'),
      ...DomTreeParser.findByClass(root, 'product-item'),
      ...DomTreeParser.findByClass(root, 'card-product'),
      ...DomTreeParser.findByClass(root, 'item-product')
    ];

    const seen = new Set<ParsedElementNode>();
    return rawCandidates.filter((node) => {
      if (seen.has(node)) return false;
      seen.add(node);

      const nodeClass = (node.attributes['class'] || '').toLowerCase();
      // Reject negative context classes
      if (
        nodeClass.includes('menu') ||
        nodeClass.includes('nav') ||
        nodeClass.includes('footer') ||
        nodeClass.includes('header') ||
        nodeClass.includes('blog') ||
        nodeClass.includes('article')
      ) {
        return false;
      }

      // Must contain at least one image inside the card
      const imgs = DomTreeParser.findByTag(node, 'img');
      return imgs.length > 0;
    });
  }

  /**
   * Generates mutant HTML fixture string using structured DOM targeting (fails closed if no product card)
   */
  public static generateMutantHtml(originalHtml: string, scenario: MutationScenarioType): string {
    const root = DomTreeParser.parse(originalHtml);
    const cards = this.findProductCards(root);

    if (cards.length === 0) {
      throw new Error(`MutationQAHarness: No valid product card candidate found in HTML fixture for scenario '${scenario}'`);
    }

    const firstCard = cards[0];

    switch (scenario) {
      case 'text_stretch': {
        let result = originalHtml;
        // 1. Mutate header text or heading if present
        const headerNodes = DomTreeParser.findByTag(root, 'header');
        if (headerNodes.length > 0) {
          const header = headerNodes[0];
          const headerHeadings = [
            ...DomTreeParser.findByTag(header, 'h1'),
            ...DomTreeParser.findByTag(header, 'h2'),
            ...DomTreeParser.findByTag(header, 'h3'),
            ...DomTreeParser.findByClass(header, 'title'),
            ...DomTreeParser.findByClass(header, 'logo')
          ];
          if (headerHeadings.length > 0) {
            const targetH = headerHeadings[0];
            if (targetH.tag === 'img') {
              const newHeaderHtml = header.outerHtml.replace(
                targetH.outerHtml,
                `${targetH.outerHtml}<h2 class="header-stretch-title">${MutationQAHarness.LONG_TEXT_PAYLOAD}</h2>`
              );
              result = result.replace(header.outerHtml, newHeaderHtml);
            } else {
              const newHHtml = targetH.outerHtml.replace(
                targetH.innerHtml,
                MutationQAHarness.LONG_TEXT_PAYLOAD
              );
              result = result.replace(targetH.outerHtml, newHHtml);
            }
          }
        }

        // 2. Target heading/title specifically inside firstCard
        const titleNodes = [
          ...DomTreeParser.findByClass(firstCard, 'title'),
          ...DomTreeParser.findByClass(firstCard, 'product-title'),
          ...DomTreeParser.findByClass(firstCard, 'name'),
          ...DomTreeParser.findByTag(firstCard, 'h2'),
          ...DomTreeParser.findByTag(firstCard, 'h3'),
          ...DomTreeParser.findByTag(firstCard, 'h4')
        ];

        let mutatedCardHtml = firstCard.outerHtml;
        if (titleNodes.length > 0) {
          const targetTitle = titleNodes[0];
          const newTitleHtml = targetTitle.outerHtml.replace(
            targetTitle.innerHtml,
            MutationQAHarness.LONG_TEXT_PAYLOAD
          );
          mutatedCardHtml = mutatedCardHtml.replace(targetTitle.outerHtml, newTitleHtml);
        } else {
          mutatedCardHtml = mutatedCardHtml.replace(
            firstCard.innerHtml,
            `<h3 class="product-title">${MutationQAHarness.LONG_TEXT_PAYLOAD}</h3>${firstCard.innerHtml}`
          );
        }
        return result.replace(firstCard.outerHtml, mutatedCardHtml);
      }
      case 'cardinality_1': {
        // Keep only first card, remove subsequent sibling product cards
        let result = originalHtml;
        for (let i = 1; i < cards.length; i++) {
          result = result.replace(cards[i].outerHtml, '');
        }
        return result;
      }
      case 'cardinality_11': {
        // Remove subsequent cards in reverse order to prevent matching newly cloned cards
        let result = originalHtml;
        for (let i = cards.length - 1; i >= 1; i--) {
          const idx = result.lastIndexOf(cards[i].outerHtml);
          if (idx !== -1) {
            result = result.slice(0, idx) + result.slice(idx + cards[i].outerHtml.length);
          }
        }
        const elevenCards = Array(11).fill(firstCard.outerHtml).join('\n');
        return result.replace(firstCard.outerHtml, elevenCards);
      }
      case 'image_ratio_tall': {
        // Mutate only image INSIDE firstCard, leaving logo/header images untouched
        const imgs = DomTreeParser.findByTag(firstCard, 'img');
        const targetImg = imgs[0];
        const newImgHtml = targetImg.outerHtml.replace(/src=["'][^"']*["']/i, `src="${MutationQAHarness.SVG_TALL}"`);
        const mutatedCardHtml = firstCard.outerHtml.replace(targetImg.outerHtml, newImgHtml);
        return originalHtml.replace(firstCard.outerHtml, mutatedCardHtml);
      }
      case 'image_ratio_wide': {
        const imgs = DomTreeParser.findByTag(firstCard, 'img');
        const targetImg = imgs[0];
        const newImgHtml = targetImg.outerHtml.replace(/src=["'][^"']*["']/i, `src="${MutationQAHarness.SVG_WIDE}"`);
        const mutatedCardHtml = firstCard.outerHtml.replace(targetImg.outerHtml, newImgHtml);
        return originalHtml.replace(firstCard.outerHtml, mutatedCardHtml);
      }
      default:
        return originalHtml;
    }
  }
  /**
   * Generates the authoritative JavaScript expression to evaluate in real Chromium
   */
  public static buildChromiumEvaluationScript(scenario: MutationScenarioType): string {
    return `(() => {
      const cards = Array.from(document.querySelectorAll('.product-card, .product-item, .card-product, [data-antifan-product]'));
      const targetFound = cards.length > 0;
      const cardCount = cards.length;

      const scrollW = document.documentElement.scrollWidth || 0;
      const clientW = window.innerWidth || document.documentElement.clientWidth || 0;
      const deltaX = Math.max(0, scrollW - clientW);

      // Check for unrendered Liquid markers in text
      const bodyText = document.body ? document.body.innerText : '';
      const liquidLeak = /\\{\\{|\\{%/.test(bodyText);

      const firstCard = cards[0] || null;
      const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;

      // Check image presence, dimensions, object-fit and aspect ratio
      let imageFound = false;
      let imageLoaded = false;
      let imageRenderW = 0;
      let imageRenderH = 0;
      let distortion = 0;
      let objectFitApplied = false;

      if (firstCard) {
        const img = firstCard.querySelector('img');
        if (img) {
          const srcAttr = img.getAttribute('src');
          imageFound = Boolean(srcAttr && srcAttr.trim().length > 0);
          const rect = img.getBoundingClientRect();
          imageRenderW = img.clientWidth || Math.round(rect.width);
          imageRenderH = img.clientHeight || Math.round(rect.height);
          imageLoaded = Boolean(
            img.complete &&
            (img.naturalWidth > 0 || srcAttr?.startsWith('data:image/svg')) &&
            imageRenderW > 0 &&
            imageRenderH > 0
          );
          const computed = window.getComputedStyle(img);
          const fit = computed.objectFit;
          objectFitApplied = fit === 'cover' || fit === 'contain' || fit === 'scale-down';
          if (img.naturalWidth && img.naturalHeight && imageRenderW && imageRenderH) {
            const natRatio = img.naturalWidth / img.naturalHeight;
            const renRatio = imageRenderW / imageRenderH;
            distortion = Math.abs((renRatio / natRatio) - 1);
          }
        }
      }

      // Check price presence and parsing validity (starts invalid unless parsed cleanly)
      let priceFound = false;
      let priceValid = false;
      let priceVal = 0;
      if (firstCard) {
        const priceEl = firstCard.querySelector('.price, .price-current, .amount, [data-price]');
        if (priceEl) {
          priceFound = true;
          const rawText = priceEl.textContent || '';
          const digits = rawText.replace(/[^0-9]/g, '');
          priceVal = digits ? parseInt(digits, 10) : NaN;
          priceValid = !isNaN(priceVal) && priceVal > 0;
        }
      }

      // Check navigation controls visibility for single-item cardinality
      let navHidden = true;
      const navControls = Array.from(document.querySelectorAll('.swiper-button-next, .swiper-button-prev, .splide__arrow, [data-antifan-slider-next], [data-antifan-slider-prev], .slick-arrow'));
      if (navControls.length > 0) {
        navHidden = navControls.every((el) => {
          const style = window.getComputedStyle(el);
          return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || el.offsetParent === null;
        });
      }

      // Check 11-item row alignment and container containment
      let gridWrapAndRowAlignmentValid = true;
      if (cards.length > 1) {
        const parent = cards[0].parentElement;
        const parentRect = parent ? parent.getBoundingClientRect() : null;
        const cardRects = cards.map((c) => c.getBoundingClientRect());
        const isSliderOrCarousel = parent && (
          parent.closest('[data-antifan-slider]') !== null ||
          parent.classList.contains('swiper-wrapper') ||
          parent.classList.contains('splide__list') ||
          parent.classList.contains('slick-track') ||
          window.getComputedStyle(parent).overflowX === 'scroll' ||
          window.getComputedStyle(parent).overflowX === 'auto'
        );

        if (parentRect && !isSliderOrCarousel) {
          for (const r of cardRects) {
            if (r.right > parentRect.right + 4 || r.left < parentRect.left - 4) {
              gridWrapAndRowAlignmentValid = false;
              break;
            }
          }
        }

        if (gridWrapAndRowAlignmentValid) {
          const rows = [];
          for (const r of cardRects) {
            let existingRow = rows.find((row) => Math.abs(row.top - r.top) <= 4);
            if (existingRow) {
              existingRow.cards.push(r);
              existingRow.bottom = Math.max(existingRow.bottom, r.bottom);
            } else {
              rows.push({ top: r.top, bottom: r.bottom, cards: [r] });
            }
          }
          for (let i = 1; i < rows.length; i++) {
            if (rows[i].top < rows[i - 1].bottom - 4) {
              gridWrapAndRowAlignmentValid = false;
              break;
            }
          }
        }
      }

      // Check bounding box collisions between title and button/price
      let overlap = false;
      if (firstCard) {
        const title = firstCard.querySelector('h2, h3, h4, .title, .product-title, .name');
        const btn = firstCard.querySelector('button, .price');
        if (title && btn && !title.contains(btn) && !btn.contains(title)) {
          const r1 = title.getBoundingClientRect();
          const r2 = btn.getBoundingClientRect();
          const xOverlap = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
          const yOverlap = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
          if (xOverlap > 2 && yOverlap > 2) {
            overlap = true;
          }
        }
      }

      return {
        targetFound,
        cardCount,
        scrollWidth: scrollW,
        clientWidth: clientW,
        overflowDeltaX: deltaX,
        cardWidth: cardRect ? cardRect.width : undefined,
        cardHeight: cardRect ? cardRect.height : undefined,
        imageFound,
        imageLoaded,
        imageRenderWidth: imageRenderW,
        imageRenderHeight: imageRenderH,
        aspectRatioDistortion: distortion,
        objectFitApplied,
        priceFound,
        priceValid,
        priceValue: priceVal,
        navControlsHidden: navHidden,
        gridWrapAndRowAlignmentValid,
        liquidLeakDetected: liquidLeak,
        overlapDetected: overlap
      };
    })()`;
  }

  /**
   * Asserts measurement against scenario hard-blocker thresholds, comparing against mandatory baseline
   */
  public static evaluateMeasurement(
    scenario: MutationScenarioType,
    measurement: MutationMeasurement,
    baselineMeasurement?: MutationMeasurement
  ): MutationResult {
    const config = MutationQAHarness.SCENARIOS[scenario];
    const failureReasons: string[] = [];
    let hardBlocker = false;

    // 0. Fail closed: Target must be found
    if (!measurement.targetFound) {
      return {
        scenario,
        passed: false,
        measurement,
        hardBlockerTriggered: true,
        failureReasons: ['No valid product card target found in DOM for mutation measurement']
      };
    }

    // 1. Fail closed: Card height must be valid
    if (!measurement.cardHeight || measurement.cardHeight <= 0) {
      failureReasons.push('Product card has invalid or zero height dimensions');
      hardBlocker = true;
    }

    // 2. Fail closed: Baseline is required for ratio verification
    if (!baselineMeasurement || !baselineMeasurement.cardHeight || baselineMeasurement.cardHeight <= 0) {
      failureReasons.push('Missing valid baseline card height required for ratio verification');
      hardBlocker = true;
    } else if (measurement.cardHeight && measurement.cardHeight > 0) {
      const heightRatio = measurement.cardHeight / baselineMeasurement.cardHeight;
      measurement.baselineCardHeight = baselineMeasurement.cardHeight;
      measurement.heightRatio = heightRatio;

      if (heightRatio < config.hardBlockerThresholds.minHeightRatio || heightRatio > config.hardBlockerThresholds.maxHeightRatio) {
        failureReasons.push(
          `Card height ratio ${heightRatio.toFixed(2)} is outside allowed range [${config.hardBlockerThresholds.minHeightRatio}, ${config.hardBlockerThresholds.maxHeightRatio}]`
        );
        hardBlocker = true;
      }
    }

    // 3. Image presence and loading checks
    if (!measurement.imageFound) {
      failureReasons.push('Product card is missing an <img> element or image src is blank');
      hardBlocker = true;
    }
    if (!measurement.imageLoaded || !measurement.imageRenderWidth || measurement.imageRenderWidth <= 0 || !measurement.imageRenderHeight || measurement.imageRenderHeight <= 0) {
      failureReasons.push('Product image failed to load or has 0 render dimensions');
      hardBlocker = true;
    }
    // 4. Image distortion check
    if (scenario === 'image_ratio_tall' || scenario === 'image_ratio_wide') {
      if (measurement.aspectRatioDistortion === undefined) {
        failureReasons.push('Aspect ratio distortion measurement is undefined');
        hardBlocker = true;
      } else if (measurement.objectFitApplied === undefined) {
        failureReasons.push('Object-fit applied measurement is undefined');
        hardBlocker = true;
      } else if (measurement.aspectRatioDistortion > 0.05 && !measurement.objectFitApplied) {
        failureReasons.push(
          `Aspect ratio distortion factor ${measurement.aspectRatioDistortion.toFixed(3)} exceeded tolerance (0.05) without object-fit: cover`
        );
        hardBlocker = true;
      }
    }

    // 4.5. Price presence and validity checks
    if (!measurement.priceFound || !measurement.priceValid) {
      failureReasons.push('Product price element missing, unformatted, or parsed as NaN/0');
      hardBlocker = true;
    }
    // 5. Horizontal overflow check
    if (measurement.overflowDeltaX > config.hardBlockerThresholds.maxHorizontalOverflowPx) {
      failureReasons.push(
        `Horizontal scrollbar overflow leak detected: ${measurement.overflowDeltaX}px > threshold ${config.hardBlockerThresholds.maxHorizontalOverflowPx}px`
      );
      hardBlocker = true;
    }

    // 6. Unrendered Liquid expression leak check
    if (measurement.liquidLeakDetected && !config.hardBlockerThresholds.allowUnrenderedLiquid) {
      failureReasons.push('Unrendered Liquid template markers ({{ or {%) detected in visible text');
      hardBlocker = true;
    }

    // 7. Element collision overlap check
    if (measurement.overlapDetected && !config.hardBlockerThresholds.allowOverlappingBoxes) {
      failureReasons.push('Mutated text overlaps adjacent CTA or price bounding box');
      hardBlocker = true;
    }

    // 8. Cardinality counts and navigation assertions
    if (scenario === 'cardinality_1') {
      if (measurement.cardCount !== 1) {
        failureReasons.push(`Cardinality 1 scenario expected exactly 1 card, got ${measurement.cardCount}`);
        hardBlocker = true;
      }
      if (measurement.navControlsHidden === undefined) {
        failureReasons.push('Navigation controls visibility metric is undefined');
        hardBlocker = true;
      } else if (measurement.navControlsHidden === false) {
        failureReasons.push('Navigation controls (slider next/prev arrows) failed to hide when cardinality is 1');
        hardBlocker = true;
      }
      if (measurement.cardWidth === undefined || measurement.cardWidth <= 0) {
        failureReasons.push('Single product card width measurement is missing or zero');
        hardBlocker = true;
      } else if (measurement.cardWidth > 480) {
        failureReasons.push(`Single product card blown out to ${measurement.cardWidth}px (> 480px ceiling)`);
        hardBlocker = true;
      }
    } else if (scenario === 'cardinality_11') {
      if (measurement.cardCount !== 11) {
        failureReasons.push(`Cardinality 11 scenario expected exactly 11 cards, got ${measurement.cardCount}`);
        hardBlocker = true;
      }
      if (measurement.gridWrapAndRowAlignmentValid === undefined) {
        failureReasons.push('Grid wrap and row alignment metric is undefined');
        hardBlocker = true;
      } else if (measurement.gridWrapAndRowAlignmentValid === false) {
        failureReasons.push('11-item repeater failed grid wrap containment or row alignment bounds');
        hardBlocker = true;
      }
    }
    return {
      scenario,
      passed: failureReasons.length === 0,
      measurement,
      hardBlockerTriggered: hardBlocker,
      failureReasons
    };
  }
}
