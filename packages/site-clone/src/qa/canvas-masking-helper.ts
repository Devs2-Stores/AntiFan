/**
 * QA: Canvas Masking Helper
 * Resolves per-viewport and dual-geometry bounding box masks for dynamic widgets
 * Supports scroll offset normalization and union geometry derivation
 */

export interface MaskBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScrollOffset {
  scrollX: number;
  scrollY: number;
}

export class CanvasMaskingHelper {
  /**
   * Normalizes document coordinates to viewport clip space using scroll offsets
   */
  public static normalizeToViewport(
    box: MaskBoundingBox,
    scroll: ScrollOffset = { scrollX: 0, scrollY: 0 }
  ): MaskBoundingBox {
    return {
      x: box.x - scroll.scrollX,
      y: box.y - scroll.scrollY,
      width: box.width,
      height: box.height
    };
  }

  /**
   * Derives a unified mask list from both current and baseline widget geometries
   * When dynamic widgets have differing positions or sizes, masking both geometries
   * prevents false positive pixel mismatches during visual comparison.
   */
  public static deriveUnionMasks(
    currentBoxes: MaskBoundingBox[],
    baselineBoxes: MaskBoundingBox[]
  ): MaskBoundingBox[] {
    const combined = [...currentBoxes];

    for (const bBox of baselineBoxes) {
      // Check if overlapping or close to an existing box
      let merged = false;
      for (let i = 0; i < combined.length; i++) {
        const cBox = combined[i];
        if (this.boxesOverlap(cBox, bBox)) {
          // Merge to bounding union
          const minX = Math.min(cBox.x, bBox.x);
          const minY = Math.min(cBox.y, bBox.y);
          const maxX = Math.max(cBox.x + cBox.width, bBox.x + bBox.width);
          const maxY = Math.max(cBox.y + cBox.height, bBox.y + bBox.height);

          combined[i] = {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
          };
          merged = true;
          break;
        }
      }

      if (!merged) {
        combined.push({ ...bBox });
      }
    }

    return combined;
  }

  /**
   * Applies solid neutral color mask over specified bounding regions in an RGBA buffer
   */
  public static maskDynamicRegions(
    imageBuffer: Buffer,
    width: number,
    height: number,
    boxes: MaskBoundingBox[]
  ): Buffer {
    const masked = Buffer.from(imageBuffer);
    for (const box of boxes) {
      const startX = Math.max(0, Math.floor(box.x));
      const endX = Math.min(width, Math.ceil(box.x + box.width));
      const startY = Math.max(0, Math.floor(box.y));
      const endY = Math.min(height, Math.ceil(box.y + box.height));

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (y * width + x) * 4;
          // Set RGBA to neutral gray (128, 128, 128, 255)
          masked[idx] = 128;
          masked[idx + 1] = 128;
          masked[idx + 2] = 128;
          masked[idx + 3] = 255;
        }
      }
    }
    return masked;
  }

  private static boxesOverlap(a: MaskBoundingBox, b: MaskBoundingBox): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }
}
