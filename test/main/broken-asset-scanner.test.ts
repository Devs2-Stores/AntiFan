import { describe, it } from 'node:test';
import * as assert from 'node:assert';
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

  it('provides a valid executable browser scan script', () => {
    const script = BrokenAssetScanner.getBrowserScanScript();
    assert.ok(script.startsWith('(() => {'));
    assert.ok(script.endsWith('})()'));
    assert.ok(script.includes('data:image/svg+xml'));
  });
});
