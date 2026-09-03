import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as vm from 'node:vm';
import { CleanTabProbe } from './clean-tab-probe.js';
import { StateSynthesizer } from '../models/state-synthesizer.js';

describe('CleanTabProbe - Behavioral Interactive Verification', () => {
  it('1. Executes behavioral probes for tabs, navigation, branch dropdown, and modal', async () => {
    // Mock evaluator simulating successful DOM behavioral responses
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('brand_tabs') || expr.includes('tab-item') || expr.includes('data-antifan-toggle')) {
        return { passed: true, details: { tab2After: true, tab1After: false } };
      }
      if (expr.includes('category-navigation') || expr.includes('submenu') || expr.includes('data-antifan-hover')) {
        return { passed: true, details: { activeAfterEnter: true } };
      }
      if (expr.includes('systerm') || expr.includes('branch_selector') || expr.includes('branch_selector_toggle')) {
        return { passed: true, details: { openedDisplay: 'block', closedDisplay: 'none' } };
      }
      if (expr.includes('popup-video') || expr.includes('video_modal') || expr.includes('data-antifan-modal')) {
        return { passed: true, details: { openedDisplay: 'flex', closedDisplay: 'none' } };
      }
      return { passed: true };
    };
    const results = await CleanTabProbe.verifyInteractiveChecks(mockEvaluator);
    assert.strictEqual(results.length, 4);

    const tabsCheck = results.find(r => r.name === 'brand_tabs_switching');
    assert.ok(tabsCheck?.passed, 'brand_tabs_switching must pass');

    const navCheck = results.find(r => r.name === 'category_submenu_hover');
    assert.ok(navCheck?.passed, 'category_submenu_hover must pass');

    const branchCheck = results.find(r => r.name === 'branch_selector_toggle');
    assert.ok(branchCheck?.passed, 'branch_selector_toggle must pass');

    const modalCheck = results.find(r => r.name === 'video_modal_open_close');
    assert.ok(modalCheck?.passed, 'video_modal_open_close must pass');
  });

  it('2. Fails closed with structured diagnostics when interactive element is missing', async () => {
    const failingEvaluator = async (): Promise<unknown> => {
      return { passed: false, reason: 'Target interactive element missing' };
    };

    const results = await CleanTabProbe.verifyInteractiveChecks(failingEvaluator);
    for (const r of results) {
      assert.strictEqual(r.passed, false, `${r.name} must fail when element is missing`);
    }
  });

  it('3. verifyCriticalBreaks validates overflow, commercial forms, and zero liquid leak', async () => {
    const mockBreakEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('scrollWidth') && expr.includes('innerWidth')) {
        return { passed: true, details: 'scrollWidth: 1200px, innerWidth: 1200px, deltaX: 0px' };
      }
      if (expr.includes('forms') && expr.includes('productCards')) {
        return { passed: true, details: 'forms: 2, productCards: 8' };
      }
      if (expr.includes('leakedTags')) {
        return { passed: true, details: 'Zero Liquid syntax leakage' };
      }
      return { passed: true };
    };

    const check = await CleanTabProbe.verifyCriticalBreaks(mockBreakEvaluator);
    assert.strictEqual(check.passed, true);
    assert.strictEqual(check.breaks.length, 3);
    assert.ok(check.breaks.every(b => b.passed));
  });

  it('4. Real Declarative Runtime satisfies modularity and attribute contracts', () => {
    const synth = new StateSynthesizer();
    const runtimeCode = synth.generateDeclarativeRuntime();

    // 1. Line count requirement (<100 lines)
    const lineCount = runtimeCode.split('\n').length;
    assert.ok(lineCount < 100, `Runtime must be < 100 lines (actual: ${lineCount} lines)`);

    // 2. Zero benchmark class names or hardcoded selectors
    assert.ok(!runtimeCode.includes('.category-navigation__sub'), 'Must not contain legacy navigation sub selector');
    assert.ok(!runtimeCode.includes('.slide-content__detail'), 'Must not contain legacy slider selector');
    assert.ok(!runtimeCode.includes('.systerm .item-cta'), 'Must not contain legacy branch selector');
    assert.ok(!runtimeCode.includes('#popup-video'), 'Must not contain legacy modal selector');
    assert.ok(!runtimeCode.includes('Nt2J6ZXPuw0'), 'Must not contain hardcoded YouTube embed ID');
    assert.ok(!runtimeCode.includes('alert('), 'Must not contain blocking alert');

    // 3. Declarative attribute handlers present
    assert.ok(runtimeCode.includes('data-antifan-toggle'), 'Must handle data-antifan-toggle');
    assert.ok(runtimeCode.includes('data-antifan-hover'), 'Must handle data-antifan-hover');
    assert.ok(runtimeCode.includes('data-antifan-modal'), 'Must handle data-antifan-modal');
    assert.ok(runtimeCode.includes('data-antifan-modal-dialog'), 'Must handle data-antifan-modal-dialog');
    assert.ok(runtimeCode.includes('data-antifan-modal-close'), 'Must handle data-antifan-modal-close');
    assert.ok(runtimeCode.includes('data-antifan-slider'), 'Must handle data-antifan-slider');
    assert.ok(runtimeCode.includes('data-antifan-slider-track'), 'Must handle data-antifan-slider-track');
    assert.ok(runtimeCode.includes('data-antifan-slider-next'), 'Must handle data-antifan-slider-next');
    assert.ok(runtimeCode.includes('data-antifan-slider-prev'), 'Must handle data-antifan-slider-prev');
    assert.ok(runtimeCode.includes('data-antifan-src'), 'Must preserve and restore data-antifan-src on iframes');
  });
});
