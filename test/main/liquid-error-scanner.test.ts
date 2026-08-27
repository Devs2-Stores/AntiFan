import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';

describe('LiquidErrorScanner', () => {
  it('detects Liquid syntax errors and missing snippets from HTML string', () => {
    const html = `
      <div>
        <h1>Product Page</h1>
        <div class="error-box">Liquid error: Could not find snippet 'product-card-custom'</div>
        <p>Liquid syntax error: Expected end_of_string but found pipe</p>
      </div>
    `;

    const result = LiquidErrorScanner.scanHtmlString(html);
    assert.strictEqual(result.hasErrors, true);
    assert.ok(result.errors.length >= 2);
    assert.strictEqual(result.errors[0]?.type, 'missing_include');
    assert.strictEqual(result.errors[1]?.type, 'syntax_error');
  });

  it('detects translation missing errors', () => {
    const html = `
      <div class="cart-title">
        <span>translation missing: vi.cart.checkout_button</span>
      </div>
    `;

    const result = LiquidErrorScanner.scanHtmlString(html);
    assert.ok(result.errors.length >= 1);
    assert.strictEqual(result.errors[0]?.type, 'translation_missing');
  });

  it('ignores "Liquid error" text written inside RTE or article content containers (RT-05 mitigation)', () => {
    const html = `
      <div class="article__content rte">
        <p>In this tutorial, we will learn how to debug: Liquid error: Could not find snippet 'header'</p>
      </div>
    `;

    const result = LiquidErrorScanner.scanHtmlString(html);
    assert.strictEqual(result.hasErrors, false);
    assert.strictEqual(result.errors.length, 0);
  });

  it('provides a valid executable browser scan script (IIFE isolated)', () => {
    const script = LiquidErrorScanner.getBrowserScanScript();
    assert.ok(script.startsWith('(() => {'));
    assert.ok(script.endsWith('})()'));
    assert.ok(script.includes('EXCLUDED_SELECTORS'));
  });
});
