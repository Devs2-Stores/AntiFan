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

  it('detects negative leftward overflow and correctly recurses through >=50 child elements', () => {
    const scriptText = LayoutOverflowEngine.getBrowserScanScript('mobile');
    const script = new vm.Script(scriptText);

    // Create container with 60 children, where child #55 has negative left overflow (-50px)
    const children: any[] = [];
    for (let i = 0; i < 60; i++) {
      const isLeftCulprit = i === 55;
      children.push({
        nodeType: 1,
        tagName: 'DIV',
        id: `grid-item-${i}`,
        className: isLeftCulprit ? 'left-overflow-card' : 'normal-card',
        children: [],
        parentElement: null,
        outerHTML: `<div id="grid-item-${i}">Item ${i}</div>`,
        getBoundingClientRect: () => ({
          left: isLeftCulprit ? -50 : 10,
          right: isLeftCulprit ? 100 : 350,
          width: 150,
          top: i * 20,
          bottom: i * 20 + 20,
          height: 20,
        }),
      });
    }

    const container = {
      nodeType: 1,
      tagName: 'SECTION',
      id: 'product-grid',
      className: 'large-grid-container',
      children,
      parentElement: null,
      outerHTML: '<section id="product-grid">...</section>',
      getBoundingClientRect: () => ({
        left: -50,
        right: 390,
        width: 440,
        top: 0,
        bottom: 1200,
        height: 1200,
      }),
    };

    const mockDocument = {
      documentElement: {
        scrollWidth: 440,
        clientWidth: 393,
        getBoundingClientRect: () => ({ left: 0, right: 393, width: 393, top: 0, bottom: 1200, height: 1200 }),
      },
      body: { scrollWidth: 440, clientWidth: 393 },
      querySelectorAll: (_sel: string) => [container],
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
      Array,
      Math,
      console: { log: () => {}, warn: () => {} },
    };

    const context = vm.createContext(sandbox);
    const result = script.runInContext(context) as ViewportOverflowResult;
    assert.strictEqual(result.hasOverflow, true);
    assert.ok(result.culprits.some((c) => c.id === 'grid-item-55'), 'Child #55 must be identified as the narrower leftward culprit');
  });
});
