import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  computeStructuralMetrics,
  normalizeVisualRegions,
  type RawElementSensoryData,
  type VisualBox,
} from '../../src/main/verification/visual-region';

function makeBox(x: number, y: number, width: number, height: number): VisualBox {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
  };
}

describe('Visual Region Structural Parity Suite (P0.1 - P0.3)', () => {
  it('P0.1: eliminates selector collision in repeated grids by grouping instances in DOM order', () => {
    // 4 product cards in a 2x2 grid (0,0), (200,0), (0,300), (200,300)
    const baselineRaw: RawElementSensoryData[] = [
      { ref: 'b0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 'b1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
      { ref: 'b2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 'b3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    const targetRaw: RawElementSensoryData[] = [
      { ref: 't0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 't1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
      { ref: 't2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 't3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    const bBundle = normalizeVisualRegions(baselineRaw, { width: 1200, height: 800 }, 1);
    const tBundle = normalizeVisualRegions(targetRaw, { width: 1200, height: 800 }, 1);

    const res = computeStructuralMetrics(tBundle, bBundle);

    assert.strictEqual(res.groups['.product-card']?.comparedCount, 4);
    assert.strictEqual(res.groups['.product-card']?.cardinalityMatch, true);
    assert.strictEqual(res.groups['.product-card']?.skippedForCardinalityMismatch, false);
    // In old Map<string, VisualRegion> implementation, t0 at (0,0) was compared against b3 at (200,300) -> 300px delta!
    // With grouped DOM order, card i is compared to card i -> delta is exactly 0.
    assert.strictEqual(res.groups['.product-card']?.maxGeometryDeltaPx, 0);
    assert.strictEqual(res.deltaGeometry, 0);
    assert.strictEqual(res.geometryWithinTolerance, true);
  });

  it('P0.2: insert cardinality shift stops cascade by skipping geometry pairing for that group', () => {
    // Baseline: 4 cards [A, B, C, D]
    const baselineRaw: RawElementSensoryData[] = [
      { ref: 'b0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 'b1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
      { ref: 'b2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 'b3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    // Target: 5 cards [X, A, B, C, D] (Card inserted at index 0, shifting others)
    const targetRaw: RawElementSensoryData[] = [
      { ref: 't-new', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 't0', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
      { ref: 't1', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 't2', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
      { ref: 't3', tag: 'div', selector: '.product-card', rect: makeBox(0, 600, 180, 280), visible: true },
    ];

    const bBundle = normalizeVisualRegions(baselineRaw, { width: 1200, height: 800 }, 1);
    const tBundle = normalizeVisualRegions(targetRaw, { width: 1200, height: 800 }, 1);

    const res = computeStructuralMetrics(tBundle, bBundle);

    const cardGroup = res.groups['.product-card'];
    assert.ok(cardGroup, 'product-card group must exist');
    assert.strictEqual(cardGroup.cardinalityMatch, false);
    assert.strictEqual(cardGroup.skippedForCardinalityMismatch, true);
    assert.strictEqual(cardGroup.comparedCount, 0);
    assert.strictEqual(cardGroup.maxGeometryDeltaPx, 0);
    // Crucial: no artificial cascade geometry delta is reported from mismatched cards
    assert.strictEqual(res.deltaGeometry, 0);
    assert.strictEqual(res.cardinalityMatch, false);
    assert.strictEqual(res.deltaCardinality, 1);
  });

  it('P0.2: delete cardinality shift skips geometry pairing for that group', () => {
    // Baseline: 4 cards
    const baselineRaw: RawElementSensoryData[] = [
      { ref: 'b0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 'b1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
      { ref: 'b2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 'b3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    // Target: 3 cards (Card deleted)
    const targetRaw: RawElementSensoryData[] = [
      { ref: 't0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 't2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 't3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    const bBundle = normalizeVisualRegions(baselineRaw, { width: 1200, height: 800 }, 1);
    const tBundle = normalizeVisualRegions(targetRaw, { width: 1200, height: 800 }, 1);

    const res = computeStructuralMetrics(tBundle, bBundle);

    const cardGroup = res.groups['.product-card'];
    assert.ok(cardGroup);
    assert.strictEqual(cardGroup.cardinalityMatch, false);
    assert.strictEqual(cardGroup.skippedForCardinalityMismatch, true);
    assert.strictEqual(cardGroup.comparedCount, 0);
    assert.strictEqual(cardGroup.maxGeometryDeltaPx, 0);
    assert.strictEqual(res.deltaGeometry, 0);
  });

  it('P0.2: multi-group isolation: cardinality mismatch in one group does not mask geometry drift in another', () => {
    // Baseline: 4 product cards + 1 header at (0, 0)
    const baselineRaw: RawElementSensoryData[] = [
      { ref: 'b-hdr', tag: 'header', selector: '.site-header', rect: makeBox(0, 0, 1200, 80), visible: true },
      { ref: 'b0', tag: 'div', selector: '.product-card', rect: makeBox(0, 100, 180, 280), visible: true },
      { ref: 'b1', tag: 'div', selector: '.product-card', rect: makeBox(200, 100, 180, 280), visible: true },
      { ref: 'b2', tag: 'div', selector: '.product-card', rect: makeBox(0, 400, 180, 280), visible: true },
      { ref: 'b3', tag: 'div', selector: '.product-card', rect: makeBox(200, 400, 180, 280), visible: true },
    ];

    // Target: 5 product cards (mismatched) + 1 header shifted down by 20px to (0, 20)
    const targetRaw: RawElementSensoryData[] = [
      { ref: 't-hdr', tag: 'header', selector: '.site-header', rect: makeBox(0, 20, 1200, 80), visible: true },
      { ref: 't-new', tag: 'div', selector: '.product-card', rect: makeBox(0, 120, 180, 280), visible: true },
      { ref: 't0', tag: 'div', selector: '.product-card', rect: makeBox(200, 120, 180, 280), visible: true },
      { ref: 't1', tag: 'div', selector: '.product-card', rect: makeBox(0, 420, 180, 280), visible: true },
      { ref: 't2', tag: 'div', selector: '.product-card', rect: makeBox(200, 420, 180, 280), visible: true },
      { ref: 't3', tag: 'div', selector: '.product-card', rect: makeBox(0, 720, 180, 280), visible: true },
    ];

    const bBundle = normalizeVisualRegions(baselineRaw, { width: 1200, height: 800 }, 1);
    const tBundle = normalizeVisualRegions(targetRaw, { width: 1200, height: 800 }, 1);

    const res = computeStructuralMetrics(tBundle, bBundle);

    // .product-card group is skipped
    assert.strictEqual(res.groups['.product-card']?.skippedForCardinalityMismatch, true);
    assert.strictEqual(res.groups['.product-card']?.maxGeometryDeltaPx, 0);

    // .site-header group has equal cardinality (1 === 1) and catches the 20px shift
    assert.strictEqual(res.groups['.site-header']?.cardinalityMatch, true);
    assert.strictEqual(res.groups['.site-header']?.comparedCount, 1);
    assert.strictEqual(res.groups['.site-header']?.maxGeometryDeltaPx, 20);

    // Global deltaGeometry reflects the genuine drift of the header, NOT 0!
    assert.strictEqual(res.deltaGeometry, 20);
    assert.strictEqual(res.maxGeometryShift.selector, '.site-header');
    assert.strictEqual(res.maxGeometryShift.deltaPx, 20);
    assert.strictEqual(res.geometryWithinTolerance, false);
  });

  it('P0.3: accurately detects real geometry shift on an individual instance in a matching group', () => {
    // 4 cards in baseline
    const baselineRaw: RawElementSensoryData[] = [
      { ref: 'b0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 'b1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
      { ref: 'b2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 'b3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    // In target, Card #1 has expanded height from 280 to 325 (+45px drift)
    const targetRaw: RawElementSensoryData[] = [
      { ref: 't0', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 't1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 325), visible: true },
      { ref: 't2', tag: 'div', selector: '.product-card', rect: makeBox(0, 300, 180, 280), visible: true },
      { ref: 't3', tag: 'div', selector: '.product-card', rect: makeBox(200, 300, 180, 280), visible: true },
    ];

    const bBundle = normalizeVisualRegions(baselineRaw, { width: 1200, height: 800 }, 1);
    const tBundle = normalizeVisualRegions(targetRaw, { width: 1200, height: 800 }, 1);

    const res = computeStructuralMetrics(tBundle, bBundle);

    assert.strictEqual(res.groups['.product-card']?.maxGeometryDeltaPx, 45);
    assert.strictEqual(res.deltaGeometry, 45);
    assert.strictEqual(res.maxGeometryShift.selector, '.product-card');
    assert.strictEqual(res.maxGeometryShift.deltaPx, 45);
    assert.strictEqual(res.geometryWithinTolerance, false);
  });

  it('P0.3: permuted ref sets strictly pair by DOM order without promoting unverified refs to authority', () => {
    // Baseline: Card 0 has ref 'e1' at (0, 0); Card 1 has ref 'e2' at (200, 0)
    const baselineRaw: RawElementSensoryData[] = [
      { ref: 'e1', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 'e2', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
    ];

    // Target: Card 0 has ref 'e2' at (0, 0); Card 1 has ref 'e1' at (200, 0)
    // Geometry is identical in DOM order! If ref were used as authority, Card 0 ('e2') would pair with
    // Baseline Card 1 ('e2') at (200, 0), generating a false 200px delta.
    const targetRaw: RawElementSensoryData[] = [
      { ref: 'e2', tag: 'div', selector: '.product-card', rect: makeBox(0, 0, 180, 280), visible: true },
      { ref: 'e1', tag: 'div', selector: '.product-card', rect: makeBox(200, 0, 180, 280), visible: true },
    ];

    const bBundle = normalizeVisualRegions(baselineRaw, { width: 1200, height: 800 }, 1);
    const tBundle = normalizeVisualRegions(targetRaw, { width: 1200, height: 800 }, 1);

    const res = computeStructuralMetrics(tBundle, bBundle);

    // Strict DOM-order pairing ensures index 0 pairs with index 0 -> delta is 0!
    assert.strictEqual(res.groups['.product-card']?.maxGeometryDeltaPx, 0);
    assert.strictEqual(res.deltaGeometry, 0);
    assert.strictEqual(res.geometryWithinTolerance, true);
  });
});
