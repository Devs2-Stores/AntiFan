import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PlatformDetector } from '../../src/main/qa/scanners/platform-detector';

describe('PlatformDetector', () => {
  it('detects Haravan from settings.html or Haravan schema markers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-hrv-'));
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'settings.html'), '<html>settings</html>');

    const result = PlatformDetector.detectFromWorkspace(tmp);
    assert.strictEqual(result.platform, 'haravan');
    assert.strictEqual(result.source, 'workspace');
    assert.ok(result.confidence > 0.5);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects Sapo from .bwt templates in snippets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sapo-'));
    fs.mkdirSync(path.join(tmp, 'snippets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'snippets', 'header.bwt'), '<div>Header</div>');

    const result = PlatformDetector.detectFromWorkspace(tmp);
    assert.strictEqual(result.platform, 'sapo');
    assert.strictEqual(result.source, 'workspace');
    assert.ok(result.confidence > 0.4);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects Shopify from runtime CDN and URL signatures', () => {
    const url = 'https://demo-theme.myshopify.com/products/test';
    const dom = '<html><head><script src="https://cdn.shopify.com/s/files/1/bundle.js"></script></head></html>';

    const result = PlatformDetector.detectFromRuntime(url, dom);
    assert.strictEqual(result.platform, 'shopify');
    assert.strictEqual(result.source, 'runtime');
    assert.ok(result.confidence > 0.5);
  });

  it('detects Sapo from runtime bizweb.dktcdn.net CDN', () => {
    const url = 'https://my-store.mysapo.net';
    const dom = '<html><body><img src="https://bizweb.dktcdn.net/100/123/themes/logo.png" /></body></html>';

    const result = PlatformDetector.detectFromRuntime(url, dom);
    assert.strictEqual(result.platform, 'sapo');
  });

  it('detects Haravan from runtime hstatic.net CDN', () => {
    const url = 'https://brand.myharavan.com';
    const dom = '<html><body><script src="https://hstatic.net/0/0/global/option_selection.js"></script></body></html>';

    const result = PlatformDetector.detectFromRuntime(url, dom);
    assert.strictEqual(result.platform, 'haravan');
  });
});
