import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ModularGateValidator } from '../../src/main/verification/modular-gates';

describe('Phase 4: Modular Gates Verification Suite (5 Independent Core Gates)', () => {
  describe('1. SPEC_READY Gate', () => {
    it('passes when HTML spec has no console errors and clean relative asset paths', () => {
      const res = ModularGateValidator.validateSpecReady({
        hasConsoleErrors: false,
        brokenAssetsCount: 0,
        relativeAssetViolations: [],
      });
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.verdict, 'VERIFIED');
      assert.strictEqual(res.violations.length, 0);
    });

    it('rejects when console errors or illegal absolute paths are present', () => {
      const res = ModularGateValidator.validateSpecReady({
        hasConsoleErrors: true,
        brokenAssetsCount: 2,
        relativeAssetViolations: ['/absolute/image.png'],
      });
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.verdict, 'REJECTED');
      assert.strictEqual(res.violations.length, 3);
    });
  });

  describe('2. LAYOUT_READY Gate', () => {
    it('passes when section count matches and height delta is within 5% tolerance', () => {
      const res = ModularGateValidator.validateLayoutReady({
        specSectionCount: 8,
        targetSectionCount: 8,
        specHeight: 4000,
        targetHeight: 4100, // 2.5% delta <= 5%
        hasHorizontalOverflow: false,
      });
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.verdict, 'VERIFIED');
    });

    it('rejects when height delta exceeds tolerance or section count differs', () => {
      const res = ModularGateValidator.validateLayoutReady({
        specSectionCount: 8,
        targetSectionCount: 7,
        specHeight: 4000,
        targetHeight: 4500, // 12.5% delta > 5%
        hasHorizontalOverflow: true,
      });
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.verdict, 'REJECTED');
      assert.strictEqual(res.violations.length, 3);
    });

    it('rejects when specHeight is 0 and targetHeight is non-zero (infinite delta)', () => {
      const res = ModularGateValidator.validateLayoutReady({
        specSectionCount: 4,
        targetSectionCount: 4,
        specHeight: 0,
        targetHeight: 800,
        hasHorizontalOverflow: false,
      });
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.verdict, 'REJECTED');
      assert.ok(res.violations.some((v) => v.code === 'HEIGHT_PARITY_EXCEEDED'));
    });
  });

  describe('3. RESPONSIVE_READY Gate', () => {
    it('passes when desktop, tablet, and mobile have zero horizontal overflow', () => {
      const res = ModularGateValidator.validateResponsiveReady([
        { viewport: 'desktop', width: 1440, height: 900, hasHorizontalOverflow: false, scrollWidth: 1440 },
        { viewport: 'tablet', width: 768, height: 1024, hasHorizontalOverflow: false, scrollWidth: 768 },
        { viewport: 'mobile', width: 375, height: 812, hasHorizontalOverflow: false, scrollWidth: 375 },
      ]);
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.verdict, 'VERIFIED');
    });

    it('rejects when mobile viewport has horizontal overflow bleed', () => {
      const res = ModularGateValidator.validateResponsiveReady([
        { viewport: 'desktop', width: 1440, height: 900, hasHorizontalOverflow: false, scrollWidth: 1440 },
        { viewport: 'mobile', width: 375, height: 812, hasHorizontalOverflow: true, scrollWidth: 420 },
      ]);
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.verdict, 'REJECTED');
      assert.ok(res.violations.some((v) => v.code === 'RESPONSIVE_OVERFLOW_BLEED'));
    });
  });

  describe('4. INTERACTION_READY Gate', () => {
    it('passes when all interactive gestures produce observable verified effects', () => {
      const res = ModularGateValidator.validateInteractionReady([
        { action: 'click', selector: '.nav-toggle', verified: true, verdict: 'DRAWER_EXPANDED' },
        { action: 'click', selector: '.modal-open', verified: true, verdict: 'MODAL_OPENED' },
      ]);
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.verdict, 'VERIFIED');
    });

    it('rejects when an action causes no observable effect or causes layout bleed', () => {
      const res = ModularGateValidator.validateInteractionReady([
        { action: 'click', selector: '.broken-tab', verified: false, verdict: 'NO_OBSERVABLE_EFFECT', overflowBleedDetected: true },
      ]);
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.verdict, 'REJECTED');
      assert.strictEqual(res.violations.length, 2);
    });
  });

  describe('5. MOTION_READY Gate', () => {
    it('passes when animation duration matches within 33ms temporal window', () => {
      const res = ModularGateValidator.validateMotionReady({
        expectedDurationMs: 300,
        observedDurationMs: 320, // delta 20ms <= 33ms
        expectedEasing: 'ease-out',
        observedEasing: 'ease-out',
      });
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.verdict, 'VERIFIED');
    });

    it('rejects when duration delta exceeds 33ms or easing curve mismatches', () => {
      const res = ModularGateValidator.validateMotionReady({
        expectedDurationMs: 300,
        observedDurationMs: 400, // delta 100ms > 33ms
        expectedEasing: 'ease-out',
        observedEasing: 'linear',
      });
      assert.strictEqual(res.passed, false);
      assert.strictEqual(res.verdict, 'PARTIAL');
      assert.strictEqual(res.violations.length, 2);
    });
  });
});
