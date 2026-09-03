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
      window: {},
      console: { log: () => {}, error: () => {} },
    };
    const context = vm.createContext(sandbox);
    const result = script.runInContext(context) as BrokenAssetScanResult;

    assert.strictEqual(result.hasBrokenAssets, false, 'Lazyloaded image with data-src must NOT be flagged as broken');
    assert.strictEqual(result.brokenAssets.length, 0);
  });
});
