import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { BrokenAssetScanner, BrokenAssetScanResult } from '../../src/main/qa/scanners/broken-asset-scanner';

describe('BrokenAssetScanner', () => {
  it('correlates DOM scan results with CDP network 404 failures', () => {
    const domResult: BrokenAssetScanResult = {
      hasBrokenAssets: false,
      brokenAssets: [],
      totalImagesScanned: 5,
      totalStylesheetsScanned: 2,
    };

    const networkFailures = [
      { url: 'https://hstatic.net/100/design/non-existent.png', status: 404, errorText: 'Not Found' },
      { url: 'https://hstatic.net/100/design/custom-style.css', status: 404, errorText: 'Not Found' },
      { url: 'https://hstatic.net/100/design/custom-font.woff2', status: 500, errorText: 'Server Error' },
    ];

    const correlated = BrokenAssetScanner.correlateWithNetworkFailures(domResult, networkFailures);
    assert.strictEqual(correlated.hasBrokenAssets, true);
    assert.ok(correlated.brokenAssets.length >= 3);
    assert.strictEqual(correlated.brokenAssets[0]?.type, 'image');
    assert.strictEqual(correlated.brokenAssets[1]?.type, 'stylesheet');
    assert.strictEqual(correlated.brokenAssets[2]?.type, 'font');
  });

  it('compiles and executes browser scan script in contract-complete DOM sandbox', () => {
    const scriptText = BrokenAssetScanner.getBrowserScanScript();
    const script = new vm.Script(scriptText);

    // Contract-complete mock DOM environment
    const mockDocument = {
      querySelectorAll: (sel: string) => {
        if (sel === 'img') {
          return [
            {
              tagName: 'IMG',
              id: 'broken-hero-img',
              className: 'hero-img',
              src: 'https://example.com/broken.jpg',
              naturalWidth: 0,
              naturalHeight: 0,
              complete: true,
              getAttribute: (_attr: string) => null,
              closest: (_sel: string) => null,
              outerHTML: '<img id="broken-hero-img" src="https://example.com/broken.jpg">',
            },
            {
              tagName: 'IMG',
              id: 'valid-product-img',
              className: 'product-img',
              src: 'https://example.com/valid.jpg',
              naturalWidth: 200,
              naturalHeight: 100,
              complete: true,
              getAttribute: (_attr: string) => null,
              closest: (_sel: string) => null,
              outerHTML: '<img id="valid-product-img" src="https://example.com/valid.jpg">',
            },
          ];
        }
        if (sel === 'link[rel="stylesheet"]') {
          return [
            {
              tagName: 'LINK',
              href: 'https://example.com/style.css',
              sheet: {},
              disabled: false,
              getAttribute: (attr: string) => (attr === 'href' ? 'https://example.com/style.css' : null),
              outerHTML: '<link rel="stylesheet" href="https://example.com/style.css">',
            },
          ];
        }
        return [];
      },
    };

    const sandbox = {
      document: mockDocument,
      window: {},
      console: { log: () => {}, error: () => {} },
    };
    const context = vm.createContext(sandbox);
    const result = script.runInContext(context) as BrokenAssetScanResult;

    assert.ok(result, 'Script must return scan result object');
    assert.strictEqual(result.hasBrokenAssets, true, 'Must detect 1 broken image');
    assert.strictEqual(result.brokenAssets.length, 1);
    const firstBroken = result.brokenAssets[0];
    assert.ok(firstBroken);
    assert.strictEqual(firstBroken.url, 'https://example.com/broken.jpg');
    assert.strictEqual(firstBroken.elementSelector, 'img#broken-hero-img');
    assert.strictEqual(result.totalImagesScanned, 2);
    assert.strictEqual(result.totalStylesheetsScanned, 1);
  });

  it('ignores empty src or placeholder src with lazyload data-src attributes without evaluating page URL', () => {
    const scriptText = BrokenAssetScanner.getBrowserScanScript();
    const script = new vm.Script(scriptText);

    const mockDocument = {
      querySelectorAll: (sel: string) => {
        if (sel === 'img') {
          return [
            {
              tagName: 'IMG',
              className: 'lazyload',
              classList: { contains: (c: string) => c === 'lazyload' },
              // Simulated Chromium behavior: img.src returns page URL when attribute is empty
              src: 'https://myshop.com/products/item-123',
              naturalWidth: 0,
              naturalHeight: 0,
              complete: false,
              getAttribute: (attr: string) => (attr === 'data-src' ? 'https://cdn.myshop.com/real.jpg' : null),
              closest: (_sel: string) => null,
            },
          ];
        }
        return [];
      },
    };

    const sandbox = {
      document: mockDocument,
      window: { location: { href: 'https://myshop.com/products/item-123' } },
      console: { log: () => {}, error: () => {} },
    };
    const context = vm.createContext(sandbox);
    const result = script.runInContext(context) as BrokenAssetScanResult;

    assert.strictEqual(result.hasBrokenAssets, false, 'Lazyloaded image with data-src must NOT be flagged as broken');
    assert.strictEqual(result.brokenAssets.length, 0);
  });

  it('flags lazyloaded images that completed with 0x0 dimensions, empty lazyload tags, and Liquid errors in data-src', () => {
    const scriptText = BrokenAssetScanner.getBrowserScanScript();
    const script = new vm.Script(scriptText);

    const mockDocument = {
      readyState: 'complete',
      querySelectorAll: (sel: string) => {
        if (sel === 'img') {
          return [
            {
              tagName: 'IMG',
              id: 'failed-lazyloaded',
              className: 'lazyloaded',
              classList: { contains: (c: string) => c === 'lazyloaded' },
              src: 'https://cdn.myshop.com/missing-404.jpg',
              naturalWidth: 0,
              naturalHeight: 0,
              complete: true,
              getAttribute: (attr: string) => {
                if (attr === 'src') return 'https://cdn.myshop.com/missing-404.jpg';
                if (attr === 'data-src') return 'https://cdn.myshop.com/missing-404.jpg';
                return null;
              },
              closest: () => null,
            },
            {
              tagName: 'IMG',
              id: 'bare-lazyload-no-attrs',
              className: 'lazyload',
              classList: { contains: (c: string) => c === 'lazyload' },
              src: '',
              naturalWidth: 0,
              naturalHeight: 0,
              complete: true,
              getAttribute: () => null,
              closest: () => null,
            },
            {
              tagName: 'IMG',
              id: 'liquid-error-lazy',
              className: 'lazyload',
              classList: { contains: (c: string) => c === 'lazyload' },
              src: '',
              naturalWidth: 0,
              naturalHeight: 0,
              complete: false,
              getAttribute: (attr: string) =>
                attr === 'data-src' ? 'Liquid error (sections/main-product.liquid line 42): invalid url input' : null,
              closest: () => null,
            },
          ];
        }
        return [];
      },
    };

    const sandbox = {
      document: mockDocument,
      window: { innerHeight: 800 },
      console: { log: () => {}, error: () => {} },
    };
    const result = script.runInContext(vm.createContext(sandbox)) as BrokenAssetScanResult;

    assert.strictEqual(result.hasBrokenAssets, true);
    assert.strictEqual(result.brokenAssets.length, 3);
    assert.strictEqual(result.brokenAssets[0]?.elementSelector, 'img#failed-lazyloaded');
    assert.strictEqual(result.brokenAssets[0]?.url, 'https://cdn.myshop.com/missing-404.jpg');
    assert.strictEqual(result.brokenAssets[1]?.elementSelector, 'img#bare-lazyload-no-attrs');
    assert.strictEqual(result.brokenAssets[1]?.url, '(empty src)');
    assert.strictEqual(result.brokenAssets[2]?.elementSelector, 'img#liquid-error-lazy');
    assert.match(result.brokenAssets[2]?.url || '', /Liquid error/);
  });

  it('flags visible stuck lazy placeholders when readyState is complete, while ignoring off-screen, lazyloading, or interactive-state images', () => {
    const scriptText = BrokenAssetScanner.getBrowserScanScript();
    const script = new vm.Script(scriptText);
    const gifPlaceholder = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    const buildImages = () => [
      {
        tagName: 'IMG',
        id: 'visible-stuck-placeholder',
        className: 'lazyload',
        classList: { contains: (c: string) => c === 'lazyload' },
        src: gifPlaceholder,
        naturalWidth: 1,
        naturalHeight: 1,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-src') return 'https://cdn.myshop.com/stuck-in-viewport.jpg';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 120, bottom: 320, width: 200, height: 200 }),
      },
      {
        tagName: 'IMG',
        id: 'offscreen-below-fold',
        className: 'lazyload',
        classList: { contains: (c: string) => c === 'lazyload' },
        src: gifPlaceholder,
        naturalWidth: 1,
        naturalHeight: 1,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-src') return 'https://cdn.myshop.com/below-fold.jpg';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 1400, bottom: 1600, width: 200, height: 200 }),
      },
      {
        tagName: 'IMG',
        id: 'in-flight-lazyloading',
        className: 'lazyloading',
        classList: { contains: (c: string) => c === 'lazyloading' },
        src: gifPlaceholder,
        naturalWidth: 1,
        naturalHeight: 1,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-src') return 'https://cdn.myshop.com/inflight.jpg';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 100, bottom: 300, width: 200, height: 200 }),
      },
    ];

    const completeResult = script.runInContext(
      vm.createContext({
        document: {
          readyState: 'complete',
          querySelectorAll: (sel: string) => (sel === 'img' ? buildImages() : []),
        },
        window: { innerHeight: 800 },
        console: { log: () => {}, error: () => {} },
      })
    ) as BrokenAssetScanResult;

    assert.strictEqual(completeResult.hasBrokenAssets, true);
    assert.strictEqual(completeResult.brokenAssets.length, 1);
    assert.strictEqual(completeResult.brokenAssets[0]?.elementSelector, 'img#visible-stuck-placeholder');
    assert.strictEqual(completeResult.brokenAssets[0]?.url, 'https://cdn.myshop.com/stuck-in-viewport.jpg');

    const interactiveResult = script.runInContext(
      vm.createContext({
        document: {
          readyState: 'interactive',
          querySelectorAll: (sel: string) => (sel === 'img' ? buildImages() : []),
        },
        window: { innerHeight: 800 },
        console: { log: () => {}, error: () => {} },
      })
    ) as BrokenAssetScanResult;

    assert.strictEqual(interactiveResult.hasBrokenAssets, false);
    assert.strictEqual(interactiveResult.brokenAssets.length, 0);
  });

  it('does not flag srcset-only responsive images, currentSrc-loaded lazy images, horizontally off-screen carousel slides, or visibility:hidden lazy images while still reporting stuck visible lazy images', () => {
    const scriptText = BrokenAssetScanner.getBrowserScanScript();
    const script = new vm.Script(scriptText);
    const gifPlaceholder = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    const images = [
      {
        tagName: 'IMG',
        id: 'srcset-only-responsive',
        className: 'hero-banner',
        src: '',
        currentSrc: 'https://cdn.myshop.com/hero-800.jpg',
        naturalWidth: 800,
        naturalHeight: 600,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'srcset') return 'https://cdn.myshop.com/hero-800.jpg 800w, https://cdn.myshop.com/hero-1600.jpg 1600w';
          if (attr === 'sizes') return '100vw';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 40, bottom: 440, left: 0, right: 1200, width: 1200, height: 400 }),
      },
      {
        tagName: 'IMG',
        id: 'offscreen-right-carousel-slide',
        className: 'lazyload',
        classList: { contains: (c: string) => c === 'lazyload' },
        src: gifPlaceholder,
        currentSrc: gifPlaceholder,
        naturalWidth: 1,
        naturalHeight: 1,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-src') return 'https://cdn.myshop.com/carousel-slide-2.jpg';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 100, bottom: 400, left: 1600, right: 1900, width: 300, height: 300 }),
      },
      {
        tagName: 'IMG',
        id: 'hidden-megamenu-lazy',
        className: 'lazyload',
        classList: { contains: (c: string) => c === 'lazyload' },
        src: gifPlaceholder,
        currentSrc: gifPlaceholder,
        naturalWidth: 1,
        naturalHeight: 1,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-src') return 'https://cdn.myshop.com/megamenu-promo.jpg';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 80, bottom: 280, left: 100, right: 300, width: 200, height: 200 }),
      },
      {
        tagName: 'IMG',
        id: 'lazyloaded-via-currentsrc',
        className: 'lazyloaded',
        classList: { contains: (c: string) => c === 'lazyloaded' },
        src: gifPlaceholder,
        currentSrc: 'https://cdn.myshop.com/product-card-480.jpg',
        naturalWidth: 480,
        naturalHeight: 480,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-srcset') return 'https://cdn.myshop.com/product-card-480.jpg 480w';
          if (attr === 'srcset') return 'https://cdn.myshop.com/product-card-480.jpg 480w';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 120, bottom: 320, left: 40, right: 240, width: 200, height: 200 }),
      },
      {
        tagName: 'IMG',
        id: 'truly-stuck-visible-lazy',
        className: 'lazyload',
        classList: { contains: (c: string) => c === 'lazyload' },
        src: gifPlaceholder,
        currentSrc: gifPlaceholder,
        naturalWidth: 1,
        naturalHeight: 1,
        complete: true,
        getAttribute: (attr: string) => {
          if (attr === 'src') return gifPlaceholder;
          if (attr === 'data-src') return 'https://cdn.myshop.com/truly-stuck.jpg';
          return null;
        },
        closest: () => null,
        getBoundingClientRect: () => ({ top: 120, bottom: 320, left: 300, right: 500, width: 200, height: 200 }),
      },
    ];

    const computeStyle = (el: { id?: string }) => {
      const visibility = el.id === 'hidden-megamenu-lazy' ? 'hidden' : 'visible';
      return { visibility };
    };

    const result = script.runInContext(
      vm.createContext({
        document: {
          readyState: 'complete',
          querySelectorAll: (sel: string) => {
            if (sel === 'img') return images;
            return [];
          },
        },
        window: {
          innerWidth: 1440,
          innerHeight: 900,
          getComputedStyle: computeStyle,
        },
        getComputedStyle: computeStyle,
        console: { log: () => {}, error: () => {} },
      })
    ) as BrokenAssetScanResult;

    assert.strictEqual(result.hasBrokenAssets, true);
    assert.strictEqual(result.brokenAssets.length, 1);
    assert.strictEqual(result.brokenAssets[0]?.elementSelector, 'img#truly-stuck-visible-lazy');
    assert.strictEqual(result.brokenAssets[0]?.url, 'https://cdn.myshop.com/truly-stuck.jpg');
  });
});
