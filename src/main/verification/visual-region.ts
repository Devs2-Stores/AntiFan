/**
 * AntiFan Core - Visual Region Substrate (Lean Evidence Primitive)
 *
 * Scope Discipline:
 * AntiFan Core owns raw observable sensory truth (Bounding Boxes, CSS properties,
 * Viewport coordinates, and Masking flags).
 * Core MUST NOT include O(N^2) spatial clustering graphs, semantic entity engines,
 * or heavy computer vision models. High-level cognitive aggregation belongs to
 * external reasoning agents (OMP / Claude / Subagents).
 */

export interface VisualBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface RawElementSensoryData {
  ref: string;
  tag: string;
  selector?: string;
  rect: VisualBox;
  styles?: Record<string, string>;
  isCanvasOrIframe?: boolean;
  opacity?: number;
  visible?: boolean;
}

export interface VisualRegion {
  id: string;
  ref: string;
  tag: string;
  selector?: string;
  bounds: VisualBox;
  computedStyles: Record<string, string>;
  needsMasking: boolean;
  maskReason?: 'CANVAS_3D' | 'CROSS_ORIGIN_IFRAME' | 'DYNAMIC_MEDIA';
  capturedAt: number;
}

export interface VisualRegionBundle {
  regions: VisualRegion[];
  viewport: { width: number; height: number };
  documentGeneration: number;
  timestamp: number;
  maskedCount: number;
}

/**
 * Extracts and normalizes visual regions with strict O(N) performance.
 * Rejects O(N^2) spatial clustering or graph analysis in Core.
 */
export function normalizeVisualRegions(
  rawElements: RawElementSensoryData[],
  viewport: { width: number; height: number },
  documentGeneration: number
): VisualRegionBundle {
  const regions: VisualRegion[] = [];
  let maskedCount = 0;
  const now = Date.now();

  for (let i = 0; i < rawElements.length; i++) {
    const raw = rawElements[i]!;
    const rect = raw.rect;
    // Skip completely invisible or collapsed elements
    if (raw.visible === false || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const rawTag = raw.tag;
    const tag = rawTag.length <= 6 ? rawTag.toLowerCase() : rawTag;
    const isCanvasOrIframe = Boolean(raw.isCanvasOrIframe || tag === 'canvas' || tag === 'iframe' || tag === 'embed' || tag === 'object');

    let needsMasking = false;
    let maskReason: VisualRegion['maskReason'];

    if (isCanvasOrIframe) {
      needsMasking = true;
      maskedCount++;
      if (tag === 'canvas') {
        maskReason = 'CANVAS_3D';
      } else if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
        maskReason = 'CROSS_ORIGIN_IFRAME';
      } else {
        maskReason = 'DYNAMIC_MEDIA';
      }
    }

    regions.push({
      id: `vr-${raw.ref || i}`,
      ref: raw.ref,
      tag: rawTag,
      selector: raw.selector,
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      computedStyles: raw.styles ? { ...raw.styles } : {},
      needsMasking,
      maskReason,
      capturedAt: now,
    });
  }

  return {
    regions,
    viewport: { ...viewport },
    documentGeneration,
    timestamp: now,
    maskedCount,
  };
}

export interface GroupStructuralMetrics {
  readonly selector: string;
  readonly targetCount: number;
  readonly baselineCount: number;
  readonly cardinalityMatch: boolean;
  readonly comparedCount: number;
  readonly skippedForCardinalityMismatch: boolean;
  readonly maxGeometryDeltaPx: number;
}

export interface StructuralMetricsResult {
  readonly geometryWithinTolerance: boolean;
  readonly deltaGeometry: number;
  readonly cardinalityMatch: boolean;
  readonly deltaCardinality: number;
  readonly cardinality: { readonly target: number; readonly baseline: number };
  readonly maxGeometryShift: { readonly selector?: string; readonly deltaPx: number };
  readonly groups: Record<string, GroupStructuralMetrics>;
}

/**
 * Structural parity check between target regions and baseline regions (Audit v5 §16, §25, Freeze #13/#14).
 * Groups elements by selector to eliminate single-region Map collision in grids.
 * Prevents cascade geometry drift by skipping pairing when group cardinality mismatches.
 */
export function computeStructuralMetrics(
  targetBundle: VisualRegionBundle,
  baselineBundle: VisualRegionBundle,
  options: {
    maxGeometryDeltaPx?: number;
    trackedSelectors?: string[];
  } = {}
): StructuralMetricsResult {
  const maxTol = options.maxGeometryDeltaPx ?? 2;
  const targetRegions = targetBundle.regions;
  const baselineRegions = baselineBundle.regions;

  const trackedSet = options.trackedSelectors !== undefined ? new Set(options.trackedSelectors) : null;
  const isTrackedFilter = trackedSet !== null;
  const isExplicitEmptyTracked = isTrackedFilter && options.trackedSelectors?.length === 0;

  // Group by selector
  const baselineGroups = new Map<string, VisualRegion[]>();
  for (let i = 0; i < baselineRegions.length; i++) {
    const br = baselineRegions[i]!;
    if (br.selector) {
      if (trackedSet && !trackedSet.has(br.selector)) {
        continue;
      }
      let list = baselineGroups.get(br.selector);
      if (!list) {
        list = [];
        baselineGroups.set(br.selector, list);
      }
      list.push(br);
    }
  }

  const targetGroups = new Map<string, VisualRegion[]>();
  for (let i = 0; i < targetRegions.length; i++) {
    const tr = targetRegions[i]!;
    if (tr.selector) {
      if (trackedSet && !trackedSet.has(tr.selector)) {
        continue;
      }
      let list = targetGroups.get(tr.selector);
      if (!list) {
        list = [];
        targetGroups.set(tr.selector, list);
      }
      list.push(tr);
    }
  }

  const allSelectors = new Set<string>([
    ...(trackedSet ? Array.from(trackedSet) : []),
    ...baselineGroups.keys(),
    ...targetGroups.keys(),
  ]);
  const groups: Record<string, GroupStructuralMetrics> = {};
  let maxDelta = 0;
  let maxShiftSelector: string | undefined = undefined;

  let sumTargetCount = 0;
  let sumBaselineCount = 0;
  let sumDeltaCardinality = 0;
  let allGroupsMatch = true;

  for (const selector of allSelectors) {
    const bList = baselineGroups.get(selector) ?? [];
    const tList = targetGroups.get(selector) ?? [];
    const tCount = tList.length;
    const bCount = bList.length;
    const groupCardMatch = tCount === bCount;

    sumTargetCount += tCount;
    sumBaselineCount += bCount;
    sumDeltaCardinality += Math.abs(tCount - bCount);

    if (!groupCardMatch) {
      allGroupsMatch = false;
      // Group cardinality mismatch: short-circuit geometry pairing to prevent cascade error
      groups[selector] = {
        selector,
        targetCount: tCount,
        baselineCount: bCount,
        cardinalityMatch: false,
        comparedCount: 0,
        skippedForCardinalityMismatch: true,
        maxGeometryDeltaPx: 0,
      };
      continue;
    }

    // Group cardinality matches: compare instances
    let groupMaxDelta = 0;
    const comparedCount = tCount;

    // P0 Frozen Rule: Pair equal-cardinality selector groups strictly by DOM order
    for (let k = 0; k < tCount; k++) {
      const tr = tList[k]!;
      const br = bList[k]!;

      const dx = Math.abs(tr.bounds.x - br.bounds.x);
      const dy = Math.abs(tr.bounds.y - br.bounds.y);
      const dw = Math.abs(tr.bounds.width - br.bounds.width);
      const dh = Math.abs(tr.bounds.height - br.bounds.height);
      const shift = Math.max(dx, dy, dw, dh);
      if (shift > groupMaxDelta) {
        groupMaxDelta = shift;
      }
    }

    groups[selector] = {
      selector,
      targetCount: tCount,
      baselineCount: bCount,
      cardinalityMatch: true,
      comparedCount,
      skippedForCardinalityMismatch: false,
      maxGeometryDeltaPx: groupMaxDelta,
    };

    if (groupMaxDelta > maxDelta) {
      maxDelta = groupMaxDelta;
      maxShiftSelector = selector;
    }
  }

  // If no tracked filter, include regions without a selector in top-level telemetry
  if (!isTrackedFilter) {
    const unselectedTarget = targetRegions.filter((r) => !r.selector).length;
    const unselectedBaseline = baselineRegions.filter((r) => !r.selector).length;
    sumTargetCount += unselectedTarget;
    sumBaselineCount += unselectedBaseline;
    const unselectedDelta = Math.abs(unselectedTarget - unselectedBaseline);
    sumDeltaCardinality += unselectedDelta;
    if (unselectedDelta > 0) {
      allGroupsMatch = false;
    }
  }

  const hasTrackedElements = isExplicitEmptyTracked
    ? true
    : (!isTrackedFilter || (sumTargetCount > 0 || sumBaselineCount > 0));
  const cardinalityMatch = allGroupsMatch && sumDeltaCardinality === 0 && hasTrackedElements;

  return {
    geometryWithinTolerance: hasTrackedElements && maxDelta <= maxTol,
    deltaGeometry: maxDelta,
    cardinalityMatch,
    deltaCardinality: sumDeltaCardinality,
    cardinality: { target: sumTargetCount, baseline: sumBaselineCount },
    maxGeometryShift: { selector: maxShiftSelector, deltaPx: maxDelta },
    groups,
  };
}

/**
 * Builds the in-page DOM query script for collecting elements and their structural selectors.
 * Supports arbitrary CSS selectors in trackedSelectors (nested, compound, attribute, etc.),
 * class attributes on HTML and SVG, and deterministic fallback when untracked.
 */
export function buildStructuralQueryScript(
  rootSel: string = 'body',
  trackedSelectors: string[] = []
): string {
  const trackedList = Array.isArray(trackedSelectors) ? trackedSelectors : [];
  return `(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    if (!root) return [];
    const tracked = ${JSON.stringify(trackedList)};

    const matchedMap = new Map();
    if (tracked.length > 0) {
      for (const sel of tracked) {
        try {
          const matchedEls = root.querySelectorAll(sel);
          for (let k = 0; k < matchedEls.length; k++) {
            const mEl = matchedEls[k];
            if (!matchedMap.has(mEl)) {
              matchedMap.set(mEl, sel);
            }
          }
          if (typeof root.matches === 'function' && root.matches(sel) && !matchedMap.has(root)) {
            matchedMap.set(root, sel);
          }
        } catch {}
      }
    }

    const candidateElements = tracked.length > 0
      ? Array.from(matchedMap.keys())
      : [root, ...Array.from(root.children)];

    return candidateElements.map((el, i) => {
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      let sel = matchedMap.get(el);
      if (!sel) {
        if (el.id) {
          sel = '#' + el.id;
        } else {
          const classAttr = (typeof el.getAttribute === 'function' && el.getAttribute('class')) || '';
          const rawClasses = typeof classAttr === 'string' ? classAttr.trim().split(/\\s+/).filter(Boolean) : [];
          sel = rawClasses.length > 0 ? (tag + '.' + rawClasses.join('.')) : tag;
        }
      }
      return {
        ref: (typeof el.getAttribute === 'function' && el.getAttribute('data-ref')) || ('el-' + i),
        tag,
        selector: sel,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          top: Math.round(r.top),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left)
        },
        visible: r.width > 0 && r.height > 0
      };
    });
  })()`;
}
