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
