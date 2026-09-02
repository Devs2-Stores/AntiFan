import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CanvasMaskingHelper, MaskBoundingBox } from './canvas-masking-helper.js';

describe('CanvasMaskingHelper - Dual-Geometry & Viewport Masking', () => {
  it('1. Normalizes document coordinates to viewport clip space using scroll offsets', () => {
    const docBox: MaskBoundingBox = { x: 100, y: 500, width: 200, height: 100 };
    const scroll = { scrollX: 20, scrollY: 150 };

    const viewportBox = CanvasMaskingHelper.normalizeToViewport(docBox, scroll);
    assert.strictEqual(viewportBox.x, 80);
    assert.strictEqual(viewportBox.y, 350);
    assert.strictEqual(viewportBox.width, 200);
    assert.strictEqual(viewportBox.height, 100);
  });

  it('2. Derives union masks when baseline and current dynamic widgets have differing geometries', () => {
    // Current widget at (50, 50, 100, 50)
    const currentBoxes: MaskBoundingBox[] = [{ x: 50, y: 50, width: 100, height: 50 }];
    // Baseline widget shifted slightly at (60, 55, 110, 55) (e.g. 10px shift, 10px wider)
    const baselineBoxes: MaskBoundingBox[] = [{ x: 60, y: 55, width: 110, height: 55 }];

    const unionMasks = CanvasMaskingHelper.deriveUnionMasks(currentBoxes, baselineBoxes);
    assert.strictEqual(unionMasks.length, 1, 'Overlapping boxes must merge into single bounding box');
    assert.strictEqual(unionMasks[0].x, 50);
    assert.strictEqual(unionMasks[0].y, 50);
    assert.strictEqual(unionMasks[0].width, 120); // 170 - 50
    assert.strictEqual(unionMasks[0].height, 60); // 110 - 50
  });

  it('3. Preserves disjoint boxes across baseline and current widgets', () => {
    const currentBoxes: MaskBoundingBox[] = [{ x: 10, y: 10, width: 50, height: 50 }];
    const baselineBoxes: MaskBoundingBox[] = [{ x: 200, y: 200, width: 50, height: 50 }];

    const unionMasks = CanvasMaskingHelper.deriveUnionMasks(currentBoxes, baselineBoxes);
    assert.strictEqual(unionMasks.length, 2, 'Disjoint boxes must both be included');
  });

  it('4. Correctly masks RGBA pixel buffer to neutral gray', () => {
    const width = 10;
    const height = 10;
    const buffer = Buffer.alloc(width * height * 4, 255); // White buffer

    const box: MaskBoundingBox = { x: 2, y: 2, width: 3, height: 3 };
    const masked = CanvasMaskingHelper.maskDynamicRegions(buffer, width, height, [box]);

    // Check pixel at (3, 3) inside mask
    const idxIn = (3 * width + 3) * 4;
    assert.strictEqual(masked[idxIn], 128);
    assert.strictEqual(masked[idxIn + 1], 128);
    assert.strictEqual(masked[idxIn + 2], 128);
    assert.strictEqual(masked[idxIn + 3], 255);

    // Check pixel at (0, 0) outside mask
    const idxOut = 0;
    assert.strictEqual(masked[idxOut], 255);
  });
});
