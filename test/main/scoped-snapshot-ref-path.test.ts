// A ref from a selector-scoped snapshot must resolve the same way as one from a whole-page
// snapshot: its recorded path starts at the document, not at the scope root.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
// @ts-ignore jsdom ships no type declarations (same as theme-qa-automation-stack.test.ts)
import { JSDOM } from 'jsdom';
import { buildIsolatedCollectorScript } from '../../src/main/browser/semantic-ref-executor';
import { buildRefLookupExpression } from '../../src/main/tools/browser-control-port';

const URL_ = 'https://shop.example.com/';

function page() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div class="topbar"><a href="/sale">Sale</a></div>' +
      '<header class="site-header"><nav><a href="/collections/all">Shop</a><button class="cart">Cart</button></nav></header>' +
      '<main><a href="/collections/all">Shop too</a></main></body></html>',
    { url: URL_, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  // jsdom lays nothing out: give every element a painted box so the collector keeps it.
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON() { return this; } };
  };
  return dom;
}

describe('scoped snapshot ref paths', () => {
  it('records paths from the document so a scoped ref resolves to the element it named', () => {
    const dom = page();
    const res = dom.window.eval(buildIsolatedCollectorScript('n1', URL_, 'header.site-header')) as {
      ok: boolean;
      descriptors: Array<{ text?: string; name?: string; tag?: string; path: unknown[] }>;
    };
    assert.strictEqual(res.ok, true, JSON.stringify(res).slice(0, 300));
    const cart = res.descriptors.find((d) => JSON.stringify(d).includes('Cart'));
    assert.ok(cart, 'the scoped snapshot saw the header button');
    const el = dom.window.eval(buildRefLookupExpression({ path: cart.path as never, tag: 'button', id: null } as never, '@e1', '')) as Element | null;
    assert.ok(el, 'the recorded path resolves from the document');
    assert.strictEqual(el.className, 'cart');
  });
});
