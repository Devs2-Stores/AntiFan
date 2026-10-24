// The responsive sweep measures a base list of widths plus any `{ w, h }` viewports the caller adds.
// Short viewports (landscape phone, small laptop, keyboard open) are measured only when asked for.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DEFAULT_SWEEP_BREAKPOINTS,
  SHORT_HEIGHT_VIEWPORTS,
  SWEEP_VIEWPORT_MAX_ENTRIES,
  resolveSweepBreakpoints,
  viewportsToBreakpoints,
} from '../../src/main/browser/sweep-viewports';

describe('viewportsToBreakpoints', () => {
  it('turns { w, h } into breakpoints keyed by size', () => {
    const [landscape] = viewportsToBreakpoints([{ w: 667, h: 375 }]);
    assert.deepEqual(landscape, { id: 'vp-667x375', name: 'Viewport 667x375', width: 667, height: 375, mobile: true, deviceScaleFactor: 2 });
  });

  it('treats widths from 768 up as non-mobile', () => {
    const [laptop] = viewportsToBreakpoints([{ w: 1366, h: 600 }]);
    assert.equal(laptop!.mobile, false);
    assert.equal(laptop!.deviceScaleFactor, 1);
  });

  it('rejects an empty or non-array list', () => {
    assert.throws(() => viewportsToBreakpoints([]), /non-empty/);
    assert.throws(() => viewportsToBreakpoints('667x375'), /non-empty/);
  });

  it('rejects out-of-range, non-numeric and repeated entries and names the entry', () => {
    assert.throws(() => viewportsToBreakpoints([{ w: 199, h: 600 }]), /viewports\[0\]/);
    assert.throws(() => viewportsToBreakpoints([{ w: 600, h: 3001 }]), /viewports\[0\]/);
    assert.throws(() => viewportsToBreakpoints([{ w: 600, h: '300' }]), /viewports\[0\]/);
    assert.throws(() => viewportsToBreakpoints([null]), /viewports\[0\]/);
    assert.throws(() => viewportsToBreakpoints([{ w: 600, h: 300 }, { w: 600, h: 300 }]), /viewports\[1\] repeats 600x300/);
  });

  it('caps the list at the maximum entries', () => {
    const six = Array.from({ length: SWEEP_VIEWPORT_MAX_ENTRIES + 1 }, (_, i) => ({ w: 400 + i, h: 500 }));
    assert.throws(() => viewportsToBreakpoints(six), /cannot exceed/);
  });
});

describe('resolveSweepBreakpoints', () => {
  it('is the standard seven, including the wide desktop widths, when nothing is added', () => {
    const list = resolveSweepBreakpoints(undefined, undefined);
    assert.deepEqual(list.map((b) => b.width), [320, 375, 768, 1024, 1440, 1920, 2560]);
    assert.ok(list.some((b) => b.width === 1920 && !b.mobile) && list.some((b) => b.width === 2560 && !b.mobile));
    assert.equal(list.length, DEFAULT_SWEEP_BREAKPOINTS.length);
  });

  it('adds the short-height viewports only when they are passed', () => {
    const base = resolveSweepBreakpoints(undefined, undefined);
    assert.ok(!base.some((b) => b.height === 350 || b.height === 375 && b.width === 667));
    const withShort = resolveSweepBreakpoints(undefined, SHORT_HEIGHT_VIEWPORTS);
    assert.deepEqual(withShort.slice(DEFAULT_SWEEP_BREAKPOINTS.length).map((b) => `${b.width}x${b.height}`), ['667x375', '1366x600', '375x350']);
  });

  it('keeps a caller base list and appends the extras after it', () => {
    const base = [{ id: 'bp-390', name: 'Width 390px', width: 390, height: 812, mobile: true, deviceScaleFactor: 2 }];
    const list = resolveSweepBreakpoints(base, [{ w: 1366, h: 600 }]);
    assert.deepEqual(list.map((b) => b.id), ['bp-390', 'vp-1366x600']);
  });

  it('drops an extra that repeats a base width and height', () => {
    const list = resolveSweepBreakpoints(undefined, [{ w: 375, h: 667 }, { w: 375, h: 350 }]);
    assert.equal(list.filter((b) => b.width === 375).length, 2);
    assert.equal(list.filter((b) => b.width === 375 && b.height === 667).length, 1);
  });

  it('does not mutate the shared defaults', () => {
    const list = resolveSweepBreakpoints(undefined, [{ w: 500, h: 500 }]);
    list[0]!.width = 1;
    assert.equal(DEFAULT_SWEEP_BREAKPOINTS[0]!.width, 320);
  });

  it('propagates a bad list as an error before any work', () => {
    assert.throws(() => resolveSweepBreakpoints(undefined, [{ w: 10, h: 10 }]), /viewports\[0\]/);
  });
});
