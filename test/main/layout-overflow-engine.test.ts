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
    assert.strictEqual(result.measured, true, 'A laid-out 393px viewport counts as measured');
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
    assert.strictEqual(result.measured, true);
    assert.strictEqual(result.hasOverflow, true);
    assert.ok(result.culprits.some((c) => c.id === 'grid-item-55'), 'Child #55 must be identified as the narrower leftward culprit');
  });

  it('marks a 0 CSS px viewport as unmeasured instead of reporting the document as overflow', () => {
    const scriptText = LayoutOverflowEngine.getBrowserScanScript('active');
    const script = new vm.Script(scriptText);

    // An offscreen surface: content keeps its intrinsic width, the viewport collapses.
    // The second shape is the masked variant — the window still reports a size while
    // the documentElement content box (the compositor surface) is zero.
    const collapsedSurfaces = [
      { label: 'collapsed window and content box', windowWidth: 0, contentBoxWidth: 0, expectedClientWidth: 0 },
      { label: 'collapsed content box behind a window width', windowWidth: 1440, contentBoxWidth: 0, expectedClientWidth: 1440 },
    ];

    for (const surface of collapsedSurfaces) {
      const wideElement = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'wide-document',
        className: 'page-wrapper',
        children: [],
        parentElement: null,
        outerHTML: '<div id="wide-document" class="page-wrapper">content</div>',
        getBoundingClientRect: () => ({ left: 0, right: 5000, width: 5000, top: 0, bottom: 400, height: 400 }),
      };

      const mockDocument = {
        documentElement: {
          scrollWidth: 5000,
          clientWidth: surface.contentBoxWidth,
          getBoundingClientRect: () => ({ left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 }),
        },
        body: { scrollWidth: 5000, clientWidth: surface.contentBoxWidth },
        querySelectorAll: (_sel: string) => [wideElement],
      };

      const sandbox = {
        window: {
          innerWidth: surface.windowWidth,
          innerHeight: 0,
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

      assert.strictEqual(result.measured, false, `${surface.label}: a 0 px content box must be reported as unmeasured`);
      assert.strictEqual(result.hasOverflow, false, `${surface.label}: a collapsed viewport must not fabricate document-wide overflow`);
      assert.strictEqual(result.deltaX, 0, `${surface.label}: deltaX must never be computed against a 0 width`);
      assert.strictEqual(result.culprits.length, 0, `${surface.label}: no culprit may be attributed without a measurable viewport`);
      assert.strictEqual(result.scrollWidth, 5000, `${surface.label}: raw geometry is retained as evidence, only the verdict is withheld`);
      assert.strictEqual(result.clientWidth, surface.expectedClientWidth, `${surface.label}: the raw anchor stays readable`);
      assert.strictEqual(
        typeof result.unmeasuredReason === 'string' && result.unmeasuredReason.length > 0,
        true,
        `${surface.label}: unmeasured result must carry a reason, got ${JSON.stringify(result.unmeasuredReason)}`
      );
      assert.strictEqual(
        LayoutOverflowEngine.readUnmeasuredReason(result),
        result.unmeasuredReason,
        `${surface.label}: both consumers read the marker through the engine reader`
      );
    }
  });
});
