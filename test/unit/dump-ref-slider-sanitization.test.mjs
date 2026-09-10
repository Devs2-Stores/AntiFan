import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('dump-ref transient slider style sanitization', () => {
  it('strips transient slider inline styles inside verified carousel wrappers while preserving non-slider items', () => {
    function sanitizeSlidersInDom(doc) {
      const removed = [];
      const wraps = doc.querySelectorAll('.s-wrap, .slick-slider, [class*="carousel"], [class*="swiper"]');
      for (const wrap of wraps) {
        for (const track of wrap.querySelectorAll('.s-content, .slick-track, [class*="swiper-wrapper"]')) {
          if (track.style) {
            if (track.style.transform) { removed.push('slider-transform'); delete track.style.transform; }
            if (track.style.width) { removed.push('slider-track-width'); delete track.style.width; }
          }
        }
        for (const item of wrap.querySelectorAll('.s-content > .item, .slick-track > .slick-slide, [class*="swiper-slide"]')) {
          if (item.style) {
            if (item.style.flex) { removed.push('slider-item-flex'); delete item.style.flex; }
            if (item.style.maxWidth) { removed.push('slider-item-max-width'); delete item.style.maxWidth; }
            if (item.style.marginRight) { removed.push('slider-item-margin-right'); delete item.style.marginRight; }
          }
        }
      }
      return removed;
    }

    // Mock DOM elements
    const mockSliderItem = { style: { maxWidth: '775px', flex: '0 0 775px', marginRight: '0px', color: 'blue' } };
    const mockSliderTrack = { style: { transform: 'translateX(-1550px)', width: '7750px', background: 'red' } };
    const mockSliderWrap = {
      querySelectorAll: (sel) => {
        if (sel.includes('.item')) return [mockSliderItem];
        if (sel.includes('.s-content')) return [mockSliderTrack];
        return [];
      }
    };
    const mockNonSliderItem = { style: { maxWidth: '300px', flex: '0 0 300px', marginRight: '10px' } };

    const mockDoc = {
      querySelectorAll: (sel) => {
        if (sel.includes('.s-wrap')) return [mockSliderWrap];
        return [mockNonSliderItem];
      }
    };

    const removed = sanitizeSlidersInDom(mockDoc);

    // Verified: slider track styles stripped, preserving background
    assert.strictEqual(mockSliderTrack.style.transform, undefined);
    assert.strictEqual(mockSliderTrack.style.width, undefined);
    assert.strictEqual(mockSliderTrack.style.background, 'red');

    // Verified: slider item sizing stripped, preserving color
    assert.strictEqual(mockSliderItem.style.flex, undefined);
    assert.strictEqual(mockSliderItem.style.maxWidth, undefined);
    assert.strictEqual(mockSliderItem.style.marginRight, undefined);
    assert.strictEqual(mockSliderItem.style.color, 'blue');

    // Verified: non-slider item outside .s-wrap is untouched
    assert.strictEqual(mockNonSliderItem.style.maxWidth, '300px');
    assert.strictEqual(mockNonSliderItem.style.flex, '0 0 300px');
    assert.strictEqual(mockNonSliderItem.style.marginRight, '10px');

    assert.ok(removed.includes('slider-transform'));
    assert.ok(removed.includes('slider-track-width'));
    assert.ok(removed.includes('slider-item-flex'));
    assert.ok(removed.includes('slider-item-max-width'));
    assert.ok(removed.includes('slider-item-margin-right'));
  });
});
