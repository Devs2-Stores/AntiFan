import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CleanTabProbe } from './clean-tab-probe.js';

describe('CleanTabProbe - Behavioral Interactive Verification', () => {
  it('1. Executes behavioral probes for tabs, navigation, branch dropdown, and modal', async () => {
    // Mock evaluator simulating successful DOM behavioral responses
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('brand_tabs') || expr.includes('tab-item')) {
        return { passed: true, details: { tab2After: true, tab1After: false } };
      }
      if (expr.includes('category-navigation') || expr.includes('submenu')) {
        return { passed: true, details: { activeAfterEnter: true } };
      }
      if (expr.includes('systerm') || expr.includes('branch_selector')) {
        return { passed: true, details: { openedDisplay: 'block', closedDisplay: 'none' } };
      }
      if (expr.includes('popup-video') || expr.includes('video_modal')) {
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
});
