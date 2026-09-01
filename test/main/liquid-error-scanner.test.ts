import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { LiquidErrorScanner, LiquidScanResult } from '../../src/main/qa/scanners/liquid-error-scanner';

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

  it('detects Shopify line-number formatted Liquid errors (e.g. line 42)', () => {
    const html = `
      <div class="product-wrapper">
        <div class="error-line">Liquid error (line 42): Could not find snippet 'snippets/product-form.liquid'</div>
        <p>Liquid syntax error (sections/header.liquid line 10): Unknown tag 'schema_invalid'</p>
        <span>Liquid error (cart-template line 5): Index out of bounds</span>
      </div>
    `;
    const result = LiquidErrorScanner.scanHtmlString(html);
    assert.strictEqual(result.hasErrors, true);
    assert.strictEqual(result.errors.length, 3);
    assert.strictEqual(result.errors[0]?.type, 'missing_include');
    assert.strictEqual(result.errors[1]?.type, 'syntax_error');
    assert.strictEqual(result.errors[2]?.type, 'runtime_error');
  });

  it('compiles and executes in-browser liquid scanner script in contract-complete DOM sandbox', () => {
    const scriptText = LiquidErrorScanner.getBrowserScanScript();
    const script = new vm.Script(scriptText);

    // Contract-complete mock text node and parent element
    const parentDiv = {
      tagName: 'DIV',
      id: 'error-container',
      className: 'storefront-error',
      closest: (_sel: string) => null,
    };

    const textNodes = [
      {
        textContent: "Liquid error: Could not find snippet 'custom-header'",
        parentElement: parentDiv,
      },
    ];

    const commentNodes = [
      {
        textContent: 'Liquid error: internal server trace in comment',
      },
    ];

    const NodeFilter = {
      SHOW_TEXT: 4,
      SHOW_COMMENT: 128,
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
      FILTER_SKIP: 3,
    };

    function createMockWalker(nodes: Array<{ textContent: string; parentElement?: any }>, filter?: { acceptNode: (n: any) => number }) {
      let idx = 0;
      return {
        nextNode: () => {
          while (idx < nodes.length) {
            const node = nodes[idx++];
            if (filter && typeof filter.acceptNode === 'function') {
              const status = filter.acceptNode(node);
              if (status === NodeFilter.FILTER_ACCEPT) return node;
              continue;
            }
            return node;
          }
          return null;
        },
      };
    }

    const mockDocument = {
      body: {},
      documentElement: {},
      createTreeWalker: (_root: unknown, whatToShow: number, filter?: any) => {
        if (whatToShow === NodeFilter.SHOW_TEXT) {
          return createMockWalker(textNodes, filter);
        }
        if (whatToShow === NodeFilter.SHOW_COMMENT) {
          return createMockWalker(commentNodes);
        }
        return createMockWalker([]);
      },
    };

    const sandbox = {
      document: mockDocument,
      NodeFilter,
      window: {},
      console: { log: () => {} },
    };

    const context = vm.createContext(sandbox);
    const result = script.runInContext(context) as LiquidScanResult;

    assert.ok(result, 'Script must return LiquidScanResult');
    assert.strictEqual(result.hasErrors, true, 'Must detect Liquid error in DOM text and comment');
    assert.strictEqual(result.errors.length, 2);
    const err0 = result.errors[0];
    const err1 = result.errors[1];
    assert.ok(err0);
    assert.ok(err1);
    assert.strictEqual(err0.type, 'missing_include');
    assert.strictEqual(err0.selector, 'div#error-container');
    assert.strictEqual(err1.type, 'runtime_error');
    assert.ok(err1.message.includes('HTML comment'));
  });
});
