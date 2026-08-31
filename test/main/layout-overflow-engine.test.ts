import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { LayoutOverflowEngine, ViewportOverflowResult } from '../../src/main/qa/scanners/layout-overflow-engine';

describe('LayoutOverflowEngine', () => {
  it('defines standard e-commerce breakpoints (mobile, tablet, desktop)', () => {
    const bps = LayoutOverflowEngine.BREAKPOINTS;
    assert.strictEqual(bps.length, 3);
    assert.strictEqual(bps[0]?.name, 'mobile');
    assert.strictEqual(bps[0]?.width, 393);
    assert.strictEqual(bps[1]?.name, 'tablet');
    assert.strictEqual(bps[1]?.width, 820);
    assert.strictEqual(bps[2]?.name, 'desktop');
    assert.strictEqual(bps[2]?.width, 1440);
  });

  it('compiles and executes layout overflow engine script in contract-complete sandbox', () => {
    const scriptText = LayoutOverflowEngine.getBrowserScanScript('mobile');
    const script = new vm.Script(scriptText);

    // Contract-complete mock element satisfying all property access
    const offendingElement = {
      nodeType: 1,
      tagName: 'DIV',
      id: 'banner-1',
      className: 'hero-banner-overflow',
      children: [],
      parentElement: null,
      outerHTML: '<div id="banner-1" class="hero-banner-overflow">Big Banner</div>',
      getBoundingClientRect: () => ({
        left: 0,
        right: 420,
        width: 420,
        top: 10,
        bottom: 50,
        height: 40,
      }),
    };

    const mockDocument = {
      documentElement: {
        scrollWidth: 420,
        clientWidth: 393,
        getBoundingClientRect: () => ({ left: 0, right: 393, width: 393, top: 0, bottom: 800, height: 800 }),
      },
      body: {
        scrollWidth: 420,
        clientWidth: 393,
      },
      querySelectorAll: (_sel: string) => [offendingElement],
    };

    const sandbox = {
      window: {
        innerWidth: 393,
        devicePixelRatio: 1.0,
        getComputedStyle: (_el: unknown) => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          overflowX: 'visible',
          position: 'static',
        }),
      },
      document: mockDocument,
      Set,
      Math,
      Array,
      console: { log: () => {}, warn: () => {} },
    };

    const context = vm.createContext(sandbox);
    const result = script.runInContext(context) as ViewportOverflowResult;

    assert.ok(result, 'Engine script must return ViewportOverflowResult');
    assert.strictEqual(result.hasOverflow, true, 'Must detect 27px horizontal overflow on 393px viewport');
    assert.strictEqual(result.deltaX, 27);
    assert.strictEqual(result.culprits.length, 1);
    const firstCulprit = result.culprits[0];
    assert.ok(firstCulprit);
    assert.strictEqual(firstCulprit.tagName, 'div');
    assert.strictEqual(firstCulprit.id, 'banner-1');
    assert.strictEqual(firstCulprit.selector, 'div#banner-1');
    assert.strictEqual(firstCulprit.deltaX, 27);
  });
});
