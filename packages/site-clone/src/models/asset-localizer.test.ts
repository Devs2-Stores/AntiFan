import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  AssetLocalizer,
  downloadUrlWithPinning,
  isPathContained,
  isPrivateOrReservedIp,
  isSafeDownloadUrlSyntax,
  normalizeIp,
  rewriteCssUrls,
  rewriteHtmlContent,
  sanitizeRequestHeaders,
  type DownloadTransport,
  type DownloadedAssetResult
} from './asset-localizer.js';
import { AssetHarvester, type HarvestedAssetManifest, type HarvestFileInput, type HarvestedAssetItem } from './asset-harvester.js';

interface MockTransportWithState extends DownloadTransport {
  lookupCalls: number;
}

function createMockTransport(config: {
  statusCode: number;
  headers?: Record<string, string>;
  body: Buffer | string;
  overrideResolvedIp?: string;
}): MockTransportWithState {
  const publicIp = config.overrideResolvedIp || '93.184.216.34'; // example.com IANA public IPv4
  let callCount = 0;

  return {
    get lookupCalls() {
      return callCount;
    },
    lookup: (_hostname, _options, callback) => {
      callCount++;
      callback(null, [{ address: publicIp, family: 4 }]);
    },
    request: (options: any, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = (err?: Error) => {
        if (err) req.emit('error', err);
      };
      req.end = () => {};

      process.nextTick(() => {
        // Node HTTP Agent contract: options.lookup MUST be called to resolve IP before socket connect
        if (typeof options.lookup === 'function') {
          options.lookup(options.hostname || 'example.com', {}, (err: any, address: string) => {
            if (err) {
              req.destroy(err);
              return;
            }

            const socket = new EventEmitter() as any;
            socket.remoteAddress = address || publicIp;
            req.emit('socket', socket);
            socket.emit('connect');

            const stream = new Readable({
              read() {
                this.push(typeof config.body === 'string' ? Buffer.from(config.body) : config.body);
                this.push(null);
              }
            }) as any;

            stream.statusCode = config.statusCode;
            stream.headers = config.headers || {};
            stream.socket = socket;

            if (callback) {
              callback(stream);
            }
          });
        }
      });

      return req;
    }
  };
}
describe('AssetLocalizer - A1, A2, A3 Unified Pipeline & Invariants', () => {

  // --- 1. SSRF & Security Invariants ---
  describe('1. SSRF & Security Invariants', () => {
    it('1.1. isPrivateOrReservedIp identifies loopback, private IPv4, link-local, and CGNAT', () => {
      // Loopback
      assert.strictEqual(isPrivateOrReservedIp('127.0.0.1').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('127.12.34.56').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('0.0.0.0').blocked, true);

      // Private IPv4
      assert.strictEqual(isPrivateOrReservedIp('10.0.0.1').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('10.255.255.255').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('172.16.0.1').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('172.31.255.255').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('172.32.0.1').blocked, false, '172.32.0.1 is public');
      assert.strictEqual(isPrivateOrReservedIp('192.168.1.1').blocked, true);

      // Link-local & Cloud Metadata (169.254.169.254)
      assert.strictEqual(isPrivateOrReservedIp('169.254.169.254').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('169.254.1.1').blocked, true);

      // CGNAT (100.64.0.0/10)
      assert.strictEqual(isPrivateOrReservedIp('100.64.0.1').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('100.127.255.255').blocked, true);
      assert.strictEqual(isPrivateOrReservedIp('100.128.0.1').blocked, false, '100.128.0.1 is outside CGNAT');

      // Public IPs
      assert.strictEqual(isPrivateOrReservedIp('8.8.8.8').blocked, false);
      assert.strictEqual(isPrivateOrReservedIp('1.1.1.1').blocked, false);
      assert.strictEqual(isPrivateOrReservedIp('104.21.45.67').blocked, false);
    });

    it('1.2. normalizeIp decodes decimal integer and hex IP bypasses', () => {
      // 2130706433 -> 127.0.0.1
      assert.strictEqual(normalizeIp('2130706433'), '127.0.0.1');
      assert.strictEqual(isPrivateOrReservedIp(normalizeIp('2130706433')).blocked, true);

      // 0x7f000001 -> 127.0.0.1
      assert.strictEqual(normalizeIp('0x7f000001'), '127.0.0.1');
      assert.strictEqual(isPrivateOrReservedIp(normalizeIp('0x7f000001')).blocked, true);

      // 2886729729 -> 172.16.0.1 (Private 172)
      assert.strictEqual(normalizeIp('2886729729'), '172.16.0.1');
      assert.strictEqual(isPrivateOrReservedIp(normalizeIp('2886729729')).blocked, true);
    });

    it('1.3. isSafeDownloadUrlSyntax rejects non-http schemes and loopback hostnames', () => {
      assert.strictEqual(isSafeDownloadUrlSyntax('file:///etc/passwd').safe, false);
      assert.strictEqual(isSafeDownloadUrlSyntax('javascript:alert(1)').safe, false);
      assert.strictEqual(isSafeDownloadUrlSyntax('data:text/html;base64,...').safe, false);
      assert.strictEqual(isSafeDownloadUrlSyntax('ftp://ftp.example.com').safe, false);

      assert.strictEqual(isSafeDownloadUrlSyntax('http://localhost:8080/test.png').safe, false);
      assert.strictEqual(isSafeDownloadUrlSyntax('http://my.internal.localhost/app.css').safe, false);
      assert.strictEqual(isSafeDownloadUrlSyntax('http://127.0.0.1:3000/api').safe, false);
      assert.strictEqual(isSafeDownloadUrlSyntax('https://169.254.169.254/latest/meta-data').safe, false);

      assert.strictEqual(isSafeDownloadUrlSyntax('https://cdn.example.com/assets/logo.png').safe, true);
      assert.strictEqual(isSafeDownloadUrlSyntax('//cdn.example.com/assets/logo.png').safe, true);
    });

    it('1.4. isPathContained prevents directory traversal escapes', () => {
      const rootDir = path.resolve(os.tmpdir(), 'antifan-test-containment');
      fs.mkdirSync(rootDir, { recursive: true });
      try {
        assert.strictEqual(isPathContained(path.join(rootDir, 'logo.png'), rootDir), true);
        assert.strictEqual(isPathContained(path.join(rootDir, 'sub', 'nested.css'), rootDir), true);
        assert.strictEqual(isPathContained(path.join(rootDir, '..', 'escape.txt'), rootDir), false);
        assert.strictEqual(isPathContained(path.join(rootDir, 'sub', '..', '..', 'escape.txt'), rootDir), false);
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  // --- 2. Phase A1: Downloader & Content Validation ---
  describe('2. Phase A1: Downloader & Content Validation', () => {
    it('2.1. downloadAssets correctly handles skipDownload without fabricating skipped_cached', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a1-skip-'));

      try {
        const items = [
          { type: 'image' as const, sourceUrl: 'https://example.com/img.png', filename: 'img.png', localPath: path.join(tempDir, 'img.png') }
        ];

        const res = await localizer.downloadAssets(items, {
          assetsDir: tempDir,
          skipDownload: true
        });

        assert.strictEqual(res.downloaded.length, 1);
        assert.strictEqual(res.downloaded[0].status, 'skipped_offline', 'Non-existent file with skipDownload must be skipped_offline, NOT skipped_cached');
        assert.strictEqual(res.totalBytes, 0);

        // Now create a real file and verify it reports skipped_cached
        fs.writeFileSync(path.join(tempDir, 'img.png'), Buffer.from('FAKE_IMAGE_DATA'));
        const cachedRes = await localizer.downloadAssets(items, {
          assetsDir: tempDir,
          skipDownload: true
        });

        assert.strictEqual(cachedRes.downloaded[0].status, 'skipped_cached');
        assert.strictEqual(cachedRes.downloaded[0].byteCount, Buffer.from('FAKE_IMAGE_DATA').length);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('2.2. downloadAssets rejects path containment violations fail-closed', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a1-containment-'));

      try {
        const items = [
          { type: 'image' as const, sourceUrl: 'https://example.com/escaped.png', filename: '../../escaped.png', localPath: path.resolve(tempDir, '../../escaped.png') }
        ];

        const res = await localizer.downloadAssets(items, {
          assetsDir: tempDir
        });

        assert.strictEqual(res.failedCount, 1);
        assert.strictEqual(res.downloaded[0].status, 'failed');
        assert.ok(res.downloaded[0].error?.includes('PATH_CONTAINMENT_VIOLATION'));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('2.3. downloadAssets rejects SSRF destinations before connecting', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a1-ssrf-'));

      try {
        const items = [
          { type: 'image' as const, sourceUrl: 'http://169.254.169.254/latest/meta-data', filename: 'meta.png', localPath: path.join(tempDir, 'meta.png') },
          { type: 'css' as const, sourceUrl: 'http://localhost:8000/evil.css', filename: 'evil.css', localPath: path.join(tempDir, 'evil.css') }
        ];

        const res = await localizer.downloadAssets(items, {
          assetsDir: tempDir
        });

        assert.strictEqual(res.failedCount, 2);
        assert.ok(res.downloaded[0].error?.includes('SSRF_SYNTAX_REJECTED'));
        assert.ok(res.downloaded[1].error?.includes('SSRF_SYNTAX_REJECTED'));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it('2.4. downloadUrlWithPinning successfully downloads bytes, computes SHA-256, and atomically renames file', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dl-success-'));
      try {
        const targetPath = path.join(tempDir, 'logo.png');
        const payload = Buffer.from('RAW_PNG_BINARY_BYTES_123456');
        const expectedSha256 = createHash('sha256').update(payload).digest('hex');

        const mockTransport = createMockTransport({
          statusCode: 200,
          headers: { 'content-type': 'image/png' },
          body: payload
        });

        const res = await downloadUrlWithPinning(
          'https://example.com/logo.png',
          targetPath,
          {
            timeoutMs: 5000,
            maxAssetBytes: 10 * 1024 * 1024,
            assetType: 'image'
          },
          mockTransport
        );

        assert.strictEqual(res.byteCount, payload.length);
        assert.strictEqual(res.sha256, expectedSha256);
        assert.strictEqual(res.mimeType, 'image/png');
        assert.strictEqual(mockTransport.lookupCalls >= 1, true, 'pinnedLookup must be executed through options.lookup');

        // Verify file is atomically on disk and contains exact bytes
        assert.strictEqual(fs.existsSync(targetPath), true);
        const diskBytes = fs.readFileSync(targetPath);
        assert.deepStrictEqual(diskBytes, payload);

        // Verify no temporary files remain in directory
        const remainingFiles = fs.readdirSync(tempDir);
        assert.deepStrictEqual(remainingFiles, ['logo.png']);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('2.5. downloadUrlWithPinning rejects HTTP 404 response without writing file to disk', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dl-404-'));
      try {
        const targetPath = path.join(tempDir, 'missing.png');
        const mockTransport = createMockTransport({
          statusCode: 404,
          headers: { 'content-type': 'text/plain' },
          body: 'Not Found'
        });

        await assert.rejects(
          async () => {
            await downloadUrlWithPinning(
              'https://example.com/missing.png',
              targetPath,
              {
                timeoutMs: 5000,
                maxAssetBytes: 10 * 1024 * 1024,
                assetType: 'image'
              },
              mockTransport
            );
          },
          /HTTP_STATUS_404/
        );

        // Target file must NOT exist on disk
        assert.strictEqual(fs.existsSync(targetPath), false);
        // Directory must be completely clean (no leftover .tmp files)
        assert.deepStrictEqual(fs.readdirSync(tempDir), []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('2.6. downloadUrlWithPinning rejects HTTP 500 response without writing file to disk', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dl-500-'));
      try {
        const targetPath = path.join(tempDir, 'error.png');
        const mockTransport = createMockTransport({
          statusCode: 500,
          headers: { 'content-type': 'text/plain' },
          body: 'Internal Server Error'
        });

        await assert.rejects(
          async () => {
            await downloadUrlWithPinning(
              'https://example.com/error.png',
              targetPath,
              {
                timeoutMs: 5000,
                maxAssetBytes: 10 * 1024 * 1024,
                assetType: 'image'
              },
              mockTransport
            );
          },
          /HTTP_STATUS_500/
        );

        assert.strictEqual(fs.existsSync(targetPath), false);
        assert.deepStrictEqual(fs.readdirSync(tempDir), []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('2.7. downloadUrlWithPinning detects and rejects HTML error page masquerading as image', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dl-html-'));
      try {
        const targetPath = path.join(tempDir, 'masquerade.png');
        const htmlBody = `<!DOCTYPE html><html lang="en"><head><title>404 Not Found</title></head><body>Error</body></html>`;
        const mockTransport = createMockTransport({
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: htmlBody
        });

        await assert.rejects(
          async () => {
            await downloadUrlWithPinning(
              'https://example.com/masquerade.png',
              targetPath,
              {
                timeoutMs: 5000,
                maxAssetBytes: 10 * 1024 * 1024,
                assetType: 'image'
              },
              mockTransport
            );
          },
          /REJECTED_HTML_ERROR_PAGE/
        );

        assert.strictEqual(fs.existsSync(targetPath), false);
        assert.deepStrictEqual(fs.readdirSync(tempDir), []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it('2.8. downloadUrlWithPinning invokes options.lookup and rejects DNS rebinding to private IP', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dl-rebinding-'));
      try {
        const targetPath = path.join(tempDir, 'rebind.png');
        const mockTransport = createMockTransport({
          statusCode: 200,
          headers: { 'content-type': 'image/png' },
          body: 'PAYLOAD',
          overrideResolvedIp: '10.0.0.1' // Rebinding attack resolves to private RFC 1918 address
        });

        await assert.rejects(
          async () => {
            await downloadUrlWithPinning(
              'https://example.com/rebind.png',
              targetPath,
              {
                timeoutMs: 5000,
                maxAssetBytes: 10 * 1024 * 1024,
                assetType: 'image'
              },
              mockTransport
            );
          },
          /SSRF_DNS_REBINDING_BLOCKED/
        );

        // Verified that options.lookup was actually executed by the transport
        assert.strictEqual(mockTransport.lookupCalls >= 1, true, 'pinnedLookup must be executed and recorded');
        // Verified that no file was created
        assert.strictEqual(fs.existsSync(targetPath), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --- 3. Phase A2: Syntax-Aware Rewriter ---
  describe('3. Phase A2: Syntax-Aware Rewriting', () => {
    it('3.1. rewriteHtmlContent rewrites attributes without mutating text nodes or comments', () => {
      const html = `
        <!-- Comment with https://cdn.example.com/logo.png that must stay intact -->
        <div class="logo">
          <img src="https://cdn.example.com/logo.png" data-src="https://cdn.example.com/logo-lazy.png" alt="Company Logo">
          <p>Please visit https://cdn.example.com/logo.png for details.</p>
        </div>
      `;

      const urlMap = new Map<string, string>([
        ['https://cdn.example.com/logo.png', "{{ 'logo.png' | asset_url }}"],
        ['https://cdn.example.com/logo-lazy.png', "{{ 'logo-lazy.png' | asset_url }}"]
      ]);

      const res = rewriteHtmlContent(html, urlMap, { mode: 'liquid' });
      assert.strictEqual(res.replacementCount, 2, 'Must replace exactly the 2 img attributes');

      // Attributes replaced
      assert.ok(res.content.includes(`src="{{ 'logo.png' | asset_url }}"`));
      assert.ok(res.content.includes(`data-src="{{ 'logo-lazy.png' | asset_url }}"`));

      // Comment and paragraph text node preserved untouched
      assert.ok(res.content.includes('<!-- Comment with https://cdn.example.com/logo.png that must stay intact -->'));
      assert.ok(res.content.includes('<p>Please visit https://cdn.example.com/logo.png for details.</p>'));
    });

    it('3.2. rewriteHtmlContent handles srcset, video poster, onerror fallback, and inline style', () => {
      const html = `
        <picture>
          <source srcset="https://cdn.example.com/hero-1440.webp 1440w, https://cdn.example.com/hero-480.webp 480w">
          <img src="https://cdn.example.com/hero.jpg" onerror="this.src='https://cdn.example.com/fallback.jpg'">
        </picture>
        <video poster="https://cdn.example.com/poster.jpg"></video>
        <div style="background-image: url('https://cdn.example.com/bg.png'); color: red;">Banner</div>
      `;

      const urlMap = new Map<string, string>([
        ['https://cdn.example.com/hero-1440.webp', "{{ 'hero-1440.webp' | asset_url }}"],
        ['https://cdn.example.com/hero-480.webp', "{{ 'hero-480.webp' | asset_url }}"],
        ['https://cdn.example.com/hero.jpg', "{{ 'hero.jpg' | asset_url }}"],
        ['https://cdn.example.com/fallback.jpg', "{{ 'fallback.jpg' | asset_url }}"],
        ['https://cdn.example.com/poster.jpg', "{{ 'poster.jpg' | asset_url }}"],
        ['https://cdn.example.com/bg.png', "{{ 'bg.png' | asset_url }}"]
      ]);

      const res = rewriteHtmlContent(html, urlMap, { mode: 'liquid' });
      assert.strictEqual(res.replacementCount, 6);

      // Attributes replaced with valid syntax and non-colliding quotes
      assert.ok(res.content.includes(`src="{{ 'hero.jpg' | asset_url }}"`));
      assert.ok(res.content.includes(`srcset="{{ 'hero-1440.webp' | asset_url }} 1440w, {{ 'hero-480.webp' | asset_url }} 480w"`));
      assert.ok(res.content.includes(`poster="{{ 'poster.jpg' | asset_url }}"`));
      assert.ok(res.content.includes(`style="background-image: url(&quot;{{ 'bg.png' | asset_url }}&quot;); color: red;"`));

      // Regression check: onerror is handled solely by onerror pass with serialized &quot;, not broken by singleAttrRegex
      assert.ok(res.content.includes(`onerror="this.src=&quot;{{ 'fallback.jpg' | asset_url }}&quot;"`));
      assert.strictEqual(res.content.includes(`onerror="this.src='{{ '`), false, 'Must not leave broken nested single quotes in onerror');
    });

    it('3.3. rewriteCssUrls rewrites @import and url(...) with controlled outer double-quotes and preserves @import qualifiers', () => {
      const css = [
        `/* Single quoted url */`,
        `body { background: url('https://cdn.example.com/single.png'); }`,
        `/* Double quoted url */`,
        `header { background: url("https://cdn.example.com/double.png"); }`,
        `/* Unquoted url */`,
        `footer { background: url(https://cdn.example.com/unquoted.png); }`,
        `/* Single quoted import */`,
        `@import 'https://fonts.example.com/roboto.css';`,
        `/* Double quoted import */`,
        `@import "https://cdn.example.com/reset.css";`,
        `/* url() import */`,
        `@import url('https://cdn.example.com/extra.css');`,
        `/* Single quoted import with media query qualifier */`,
        `@import 'https://fonts.example.com/responsive.css' screen and (min-width: 40em);`,
        `/* url() import with layer qualifier */`,
        `@import url('https://cdn.example.com/utilities.css') layer(utilities);`
      ].join('\n');

      const urlMap = new Map<string, string>([
        ['https://cdn.example.com/single.png', "{{ 'single.png' | asset_url }}"],
        ['https://cdn.example.com/double.png', "{{ 'double.png' | asset_url }}"],
        ['https://cdn.example.com/unquoted.png', "{{ 'unquoted.png' | asset_url }}"],
        ['https://fonts.example.com/roboto.css', "{{ 'roboto.css' | asset_url }}"],
        ['https://cdn.example.com/reset.css', "{{ 'reset.css' | asset_url }}"],
        ['https://cdn.example.com/extra.css', "{{ 'extra.css' | asset_url }}"],
        ['https://fonts.example.com/responsive.css', "{{ 'responsive.css' | asset_url }}"],
        ['https://cdn.example.com/utilities.css', "{{ 'utilities.css' | asset_url }}"]
      ]);

      const res = rewriteCssUrls(css, urlMap, { mode: 'liquid' });
      assert.strictEqual(res.replacementCount, 8);

      // Exact emitted string assertions: Must use outer double-quotes wrapping the Liquid expression
      assert.ok(
        res.content.includes(`url("{{ 'single.png' | asset_url }}")`),
        'Single-quoted input must emit url("{{ \'single.png\' | asset_url }}") without nested single quotes'
      );
      assert.ok(
        res.content.includes(`url("{{ 'double.png' | asset_url }}")`),
        'Double-quoted input must emit url("{{ \'double.png\' | asset_url }}")'
      );
      assert.ok(
        res.content.includes(`url("{{ 'unquoted.png' | asset_url }}")`),
        'Unquoted input must emit url("{{ \'unquoted.png\' | asset_url }}")'
      );
      assert.ok(
        res.content.includes(`@import url("{{ 'roboto.css' | asset_url }}");`),
        'Single-quoted @import must emit @import url("{{ \'roboto.css\' | asset_url }}");'
      );
      assert.ok(
        res.content.includes(`@import url("{{ 'reset.css' | asset_url }}");`),
        'Double-quoted @import must emit @import url("{{ \'reset.css\' | asset_url }}");'
      );
      assert.ok(
        res.content.includes(`@import url("{{ 'extra.css' | asset_url }}");`),
        'url() @import must emit @import url("{{ \'extra.css\' | asset_url }}");'
      );

      // Exact qualifier assertions: Must strictly preserve trailing conditions
      assert.ok(
        res.content.includes(`@import url("{{ 'responsive.css' | asset_url }}") screen and (min-width: 40em);`),
        'Must preserve media query qualifier on rewritten @import'
      );
      assert.ok(
        res.content.includes(`@import url("{{ 'utilities.css' | asset_url }}") layer(utilities);`),
        'Must preserve layer qualifier on rewritten @import'
      );

      // Verify no broken nested single-quote sequence exists: url('{{ '
      assert.strictEqual(res.content.includes(`url('{{ '`), false, 'Must never emit url(\'{{ \'');
    });
    it('3.4. rewriteHtmlContent normalizes single-quoted source attributes to outer double quotes, eliminating nested single-quote collisions', () => {
      const html = `
        <div class='product'>
          <img src='https://cdn.example.com/product.jpg' data-src='https://cdn.example.com/product-lazy.jpg' onerror='this.src="https://cdn.example.com/product-fallback.jpg"'>
          <source srcset='https://cdn.example.com/product-hd.jpg 2x, https://cdn.example.com/product-sd.jpg 1x'>
          <div style='background-image: url("https://cdn.example.com/product-bg.png"); color: blue;'>Tile</div>
        </div>
      `;

      const urlMap = new Map<string, string>([
        ['https://cdn.example.com/product.jpg', "{{ 'product.jpg' | asset_url }}"],
        ['https://cdn.example.com/product-lazy.jpg', "{{ 'product-lazy.jpg' | asset_url }}"],
        ['https://cdn.example.com/product-fallback.jpg', "{{ 'product-fallback.jpg' | asset_url }}"],
        ['https://cdn.example.com/product-hd.jpg', "{{ 'product-hd.jpg' | asset_url }}"],
        ['https://cdn.example.com/product-sd.jpg', "{{ 'product-sd.jpg' | asset_url }}"],
        ['https://cdn.example.com/product-bg.png', "{{ 'product-bg.png' | asset_url }}"]
      ]);

      const res = rewriteHtmlContent(html, urlMap, { mode: 'liquid' });
      assert.strictEqual(res.replacementCount, 6);

      // Verifies all rewritten attributes were normalized to outer double quotes:
      assert.ok(res.content.includes(`src="{{ 'product.jpg' | asset_url }}"`), 'Single-quoted src must be normalized to double-quotes');
      assert.ok(res.content.includes(`data-src="{{ 'product-lazy.jpg' | asset_url }}"`), 'Single-quoted data-src must be normalized to double-quotes');
      assert.ok(res.content.includes(`srcset="{{ 'product-hd.jpg' | asset_url }} 2x, {{ 'product-sd.jpg' | asset_url }} 1x"`), 'Single-quoted srcset must be normalized to double-quotes');
      assert.ok(res.content.includes(`style="background-image: url(&quot;{{ 'product-bg.png' | asset_url }}&quot;); color: blue;"`), 'Single-quoted style must be normalized to double-quotes');
      assert.ok(res.content.includes(`onerror="this.src=&quot;{{ 'product-fallback.jpg' | asset_url }}&quot;"`), 'Single-quoted onerror must be normalized to double-quotes');

      // Regression verification: ABSOLUTELY ZERO nested single quotes inside single-quoted attributes
      assert.strictEqual(res.content.includes(`src='{{ '`), false, 'Must never produce src=\'{{ \'');
      assert.strictEqual(res.content.includes(`data-src='{{ '`), false, 'Must never produce data-src=\'{{ \'');
      assert.strictEqual(res.content.includes(`srcset='{{ '`), false, 'Must never produce srcset=\'{{ \'');
      assert.strictEqual(res.content.includes(`style='background-image: url('{{ '`), false, 'Must never produce nested single quotes in style');
    });

    it('3.5. rewriteFiles rewrites the upstream form of a repaired reference instead of leaving it dangling', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [],
        javascripts: [],
        fonts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://hoplong.com/wp-content/uploads/2023/12/map_back.png',
            rawSourceUrl: 'https:/wp-content/uploads/2023/12/map_back.png',
            filename: 'map_back.png',
            localPath: '/nonexistent/map_back.png'
          }
        ],
        totalBytes: 0
      };

      const res = localizer.rewriteFiles(
        [{ path: 'index.html', content: '<style>.box{background-image:url(https:/wp-content/uploads/2023/12/map_back.png)}</style>' }],
        manifest,
        { mode: 'relative' }
      );

      assert.ok(res.files[0].rewrittenContent.includes('assets/map_back.png'), 'the repaired reference must resolve to the local asset');
      assert.strictEqual(res.files[0].rewrittenContent.includes('https:/wp-content'), false, 'the upstream typo must not survive');
    });
    it('4.1. localizes raw relative references inside stylesheets and rewrites on-disk CSS', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-css-chain-'));

      try {
        // Prepare main.css containing relative imports and relative url(...)
        const mainCss = `
          @import url('nested/theme.css');
          .hero { background: url('../images/banner.png'); }
        `;
        fs.writeFileSync(path.join(tempDir, 'main.css'), mainCss, 'utf8');

        // Prepare nested/theme.css containing relative font reference
        const nestedDir = path.join(tempDir, 'nested');
        fs.mkdirSync(nestedDir, { recursive: true });
        const nestedCss = `
          @font-face {
            font-family: 'TestFont';
            src: url('../fonts/font.woff2') format('woff2');
          }
        `;
        // In flat assets directory, nested/theme.css is stored as theme_dep.css
        fs.writeFileSync(path.join(tempDir, 'theme_dep.css'), nestedCss, 'utf8');

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://cdn.example.com/css/main.css',
              filename: 'main.css',
              localPath: path.join(tempDir, 'main.css')
            },
            {
              type: 'css',
              sourceUrl: 'https://cdn.example.com/css/nested/theme.css',
              filename: 'theme_dep.css',
              localPath: path.join(tempDir, 'theme_dep.css')
            }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        const res = await localizer.localizeDownloadedStylesheets(manifest, {
          assetsDir: tempDir,
          skipDownload: true // Offline test: verifies queue, relative resolution, and rewrite without network
        });

        // Verify that secondary relative references were discovered and resolved relative to their respective stylesheets!
        const fontItem = manifest.fonts.find(f => f.sourceUrl.includes('font.woff2'));
        assert.ok(fontItem, 'Must discover font.woff2 from nested CSS');
        assert.strictEqual(
          fontItem.sourceUrl,
          'https://cdn.example.com/css/fonts/font.woff2',
          'Relative ../fonts/font.woff2 must be resolved against https://cdn.example.com/css/nested/theme.css'
        );

        const imgItem = manifest.images.find(img => img.sourceUrl.includes('banner.png'));
        assert.ok(imgItem, 'Must discover banner.png from main.css');
        assert.strictEqual(
          imgItem.sourceUrl,
          'https://cdn.example.com/images/banner.png',
          'Relative ../images/banner.png must be resolved against https://cdn.example.com/css/main.css'
        );

        // Verify on-disk CSS files were rewritten in-place
        const rewrittenMain = fs.readFileSync(path.join(tempDir, 'main.css'), 'utf8');
        assert.ok(
          rewrittenMain.includes(`{{ 'theme_dep.css' | asset_url }}`),
          'main.css must have raw relative "nested/theme.css" rewritten to theme_dep.css'
        );
        assert.ok(
          rewrittenMain.includes(`{{ '${imgItem.filename}' | asset_url }}`),
          'main.css must have raw relative "../images/banner.png" rewritten to localized image'
        );

        const rewrittenNested = fs.readFileSync(path.join(tempDir, 'theme_dep.css'), 'utf8');
        assert.ok(
          rewrittenNested.includes(`{{ '${fontItem.filename}' | asset_url }}`),
          'theme_dep.css must have raw relative "../fonts/font.woff2" rewritten to localized font'
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it('4.2. localizes with maxDepth cutoff and records DEPTH_CUTOFF_EXCEEDED in audit findings', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-depth-cutoff-'));

      try {
        // Create a chain: a.css (depth 0) -> b.css (depth 1) -> c.css (depth 2)
        const aCss = `@import url('b.css');\n.a { color: red; }`;
        const bCss = `@import url('c.css');\n.b { color: green; }`;
        const cCss = `.c { color: blue; }`;

        fs.writeFileSync(path.join(tempDir, 'a.css'), aCss, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'b.css'), bCss, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'c.css'), cCss, 'utf8');

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://example.com/css/a.css',
              filename: 'a.css',
              localPath: path.join(tempDir, 'a.css')
            }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        // Run with maxDepth: 1 -> b.css will be queued at depth 1, and when processed hits depth >= maxDepth
        const secondaryResult = await localizer.localizeDownloadedStylesheets(manifest, {
          assetsDir: tempDir,
          skipDownload: true
        }, 1);

        assert.ok(secondaryResult.depthExceededUrls.length > 0, 'Must record depth exceeded URLs');

        // Verify A3 ledger audit catches the depth cutoff and fails closed
        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [],
          depthExceededUrls: secondaryResult.depthExceededUrls
        });

        assert.strictEqual(audit.passed, false, 'Audit must fail closed when depth cutoff is exceeded');
        const depthFindings = audit.findings.filter(f => f.code === 'DEPTH_CUTOFF_EXCEEDED');
        assert.ok(depthFindings.length > 0, 'Must contain DEPTH_CUTOFF_EXCEEDED finding');
        assert.strictEqual(depthFindings[0].severity, 'error');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it('4.3. does not localize paint-server fragments inside embedded SVG data URIs and preserves them verbatim', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-svg-fragment-'));

      try {
        // Real storefront shape: a CSS rule whose background is an embedded SVG data URI
        // whose <rect> references a paint server through a percent-encoded fragment.
        const dataUri = `data:image/svg+xml;utf8,<svg width="73" height="86" viewBox="0 0 73 86" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0.938843" y="0.542236" width="72.0612" height="85" fill="url(%23paint0_linear_1543_2487)"/><defs><linearGradient id="paint0_linear_1543_2487"><stop stop-color="#00B4E1"/></linearGradient></defs></svg>`;
        const mainCss = [
          `.menu-header .menu-list:after{content:"";display:block;width:73px;height:65px;background-image:url('${dataUri}')}`,
          `.hero { background: url('../images/banner.png'); }`
        ].join('\n');
        fs.writeFileSync(path.join(tempDir, 'home.css'), mainCss, 'utf8');

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://hoplongtech.com/build/assets/home.css',
              filename: 'home.css',
              localPath: path.join(tempDir, 'home.css')
            }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        await localizer.localizeDownloadedStylesheets(manifest, {
          assetsDir: tempDir,
          skipDownload: true
        });

        const fragmentAssets = [...manifest.images, ...manifest.fonts, ...manifest.stylesheets].filter(
          (item) => item.sourceUrl.includes('paint0_linear') || item.sourceUrl.includes('%23')
        );
        assert.deepStrictEqual(fragmentAssets, [], 'Paint-server fragments must never be harvested as downloadable assets');

        // The legitimate relative dependency must still be discovered (no over-skip regression).
        const bannerItem = manifest.images.find((img) => img.sourceUrl.includes('banner.png'));
        assert.ok(bannerItem, 'Relative banner.png must still be discovered');

        // The embedded data URI must survive the rewrite byte-for-byte.
        const rewritten = fs.readFileSync(path.join(tempDir, 'home.css'), 'utf8');
        assert.ok(rewritten.includes(dataUri), 'Embedded SVG data URI must be preserved verbatim');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --- 5. Phase A3: Direct Token Audit Ledger & Fail-Closed Gates ---
  describe('5. Phase A3: Direct Token Audit Ledger & Fail-Closed Gates', () => {
    it('5.1. verifyAndAudit flags MISSING_LOCAL_FILE when asset is not on disk', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a3-missing-'));

      try {
        const manifest: HarvestedAssetManifest = {
          stylesheets: [],
          javascripts: [],
          images: [
            { type: 'image', sourceUrl: 'https://example.com/missing.png', filename: 'missing.png', localPath: path.join(tempDir, 'missing.png') }
          ],
          fonts: [],
          totalBytes: 0
        };

        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: []
        });

        assert.strictEqual(audit.passed, false, 'Must fail closed when file is missing');
        assert.strictEqual(audit.findings.length, 1);
        assert.strictEqual(audit.findings[0].code, 'MISSING_LOCAL_FILE');
        assert.strictEqual(audit.findings[0].severity, 'error');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('5.2. verifyAndAudit flags ZERO_BYTE_ASSET when asset file is empty', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a3-zerobyte-'));

      try {
        fs.writeFileSync(path.join(tempDir, 'empty.png'), Buffer.alloc(0));

        const manifest: HarvestedAssetManifest = {
          stylesheets: [],
          javascripts: [],
          images: [
            { type: 'image', sourceUrl: 'https://example.com/empty.png', filename: 'empty.png', localPath: path.join(tempDir, 'empty.png') }
          ],
          fonts: [],
          totalBytes: 0
        };

        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: []
        });

        assert.strictEqual(audit.passed, false, 'Must fail closed on zero-byte asset');
        assert.strictEqual(audit.findings.length, 1);
        assert.strictEqual(audit.findings[0].code, 'ZERO_BYTE_ASSET');
        assert.strictEqual(audit.findings[0].severity, 'error');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('5.8. verifyAndAudit accepts a zero-byte asset only when the download result proves an empty upstream body', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a3-empty-upstream-'));
      const emptyCss = path.join(tempDir, '3e35695.css');

      try {
        fs.writeFileSync(emptyCss, Buffer.alloc(0));

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://hoplong.com/wp-content/litespeed/css/3e35695.css?ver=585c6',
              filename: '3e35695.css',
              localPath: emptyCss
            }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [],
          downloadResults: [
            {
              sourceUrl: 'https://hoplong.com/wp-content/litespeed/css/3e35695.css?ver=585c6',
              filename: '3e35695.css',
              localPath: emptyCss,
              status: 'downloaded',
              byteCount: 0
            }
          ]
        });

        assert.strictEqual(audit.passed, true, 'An empty upstream body is reproduced faithfully, not an integrity failure');
        assert.strictEqual(audit.findings.length, 0);
        assert.strictEqual(audit.verifiedAssets[0].status, 'zero_byte');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('5.9. verifyAndAudit still fails a zero-byte asset whose own download did not produce the empty body', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a3-empty-collision-'));

      try {
        fs.writeFileSync(path.join(tempDir, 'shared.css'), Buffer.alloc(0));

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            { type: 'css', sourceUrl: 'https://example.com/broken/shared.css', filename: 'shared.css', localPath: path.join(tempDir, 'shared.css') }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [],
          // A different source URL downloaded an empty body under the same filename.
          downloadResults: [
            {
              sourceUrl: 'https://example.com/other/shared.css',
              filename: 'shared.css',
              localPath: path.join(tempDir, 'shared.css'),
              status: 'downloaded',
              byteCount: 0
            }
          ]
        });

        assert.strictEqual(audit.passed, false, 'A filename collision must not excuse a zero-byte asset');
        assert.deepStrictEqual(audit.findings.map(f => f.code), ['ZERO_BYTE_ASSET']);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('5.3. verifyAndAudit flags UNRESOLVED_CSS_DEPENDENCY on unlocalized relative/remote tokens in CSS', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a3-css-tokens-'));

      try {
        // Write a CSS file containing unlocalized relative reference
        const brokenCss = `
          .icon { background: url('../icons/unresolved.png'); }
          @import url('/assets/unresolved.css');
        `;
        fs.writeFileSync(path.join(tempDir, 'broken.css'), brokenCss, 'utf8');

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            { type: 'css', sourceUrl: 'https://example.com/broken.css', filename: 'broken.css', localPath: path.join(tempDir, 'broken.css') }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: []
        });

        assert.strictEqual(audit.passed, false, 'Must fail closed on unresolved CSS tokens');
        const tokenErrors = audit.findings.filter(f => f.code === 'UNRESOLVED_CSS_DEPENDENCY');
        assert.strictEqual(tokenErrors.length, 2, 'Must catch both the unresolved url() and @import tokens');
        assert.strictEqual(tokenErrors[0].severity, 'error');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('5.4. verifyAndAudit passes with zero findings when all assets and dependencies are localized', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-a3-pass-'));

      try {
        fs.writeFileSync(path.join(tempDir, 'style.css'), `body { background: url("{{ 'bg.png' | asset_url }}"); }`, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'bg.png'), Buffer.from('VALID_PNG_CONTENT'));

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            { type: 'css', sourceUrl: 'https://example.com/style.css', filename: 'style.css', localPath: path.join(tempDir, 'style.css') }
          ],
          javascripts: [],
          images: [
            { type: 'image', sourceUrl: 'https://example.com/bg.png', filename: 'bg.png', localPath: path.join(tempDir, 'bg.png') }
          ],
          fonts: [],
          totalBytes: 0
        };

        const audit = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [
            {
              path: 'index.liquid',
              replacementCount: 1,
              originalContent: `<img src="https://example.com/bg.png">`,
              rewrittenContent: `<img src="{{ 'bg.png' | asset_url }}">`
            }
          ]
        });

        assert.strictEqual(audit.passed, true, 'Audit must pass when all assets exist and all tokens are localized');
        assert.strictEqual(audit.findings.length, 0);
        assert.strictEqual(audit.verifiedAssets.length, 2);
        assert.strictEqual(audit.verifiedAssets.every(v => v.status === 'valid'), true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it('5.5. verifyAndAudit exempts namespace attributes (xmlns, itemtype, vocab) while strictly flagging remote resource URLs on the same domains', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-audit-ns-'));
      try {
        const manifest: HarvestedAssetManifest = {
          stylesheets: [],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        // Case A: Pure semantic namespace attributes -> MUST PASS with 0 findings
        const validNamespaceContent = `
          <html xmlns="http://www.w3.org/1999/xhtml" vocab="http://schema.org/">
            <body itemscope itemtype="https://schema.org/Product">
              <span property="name">Test</span>
            </body>
          </html>
        `;
        const auditA = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{
            path: 'index.liquid',
            replacementCount: 0,
            originalContent: validNamespaceContent,
            rewrittenContent: validNamespaceContent
          }]
        });
        assert.strictEqual(auditA.passed, true, 'Namespace attributes must be exempt from network URL audit');
        assert.strictEqual(auditA.findings.length, 0);

        // Case B: Remote resource URLs using schema.org or w3.org (e.g. script src, img src) -> MUST FAIL with LINGERING_REMOTE_NETWORK_URL
        const maliciousResourceContent = `
          <html xmlns="http://www.w3.org/1999/xhtml">
            <body>
              <script src="https://schema.org/x.js"></script>
              <img src="https://www.w3.org/Icons/valid-xhtml10.png">
            </body>
          </html>
        `;
        const auditB = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{
            path: 'index.liquid',
            replacementCount: 0,
            originalContent: maliciousResourceContent,
            rewrittenContent: maliciousResourceContent
          }]
        });
        assert.strictEqual(auditB.passed, false, 'Resource URLs on schema.org/w3.org must be caught and fail audit');
        assert.strictEqual(auditB.findings.length, 2);
        assert.ok(auditB.findings.every(f => f.code === 'LINGERING_REMOTE_NETWORK_URL'));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it('5.6. verifyAndAudit strictly catches unlocalized iframe[src], extensionless CDN assets, and video[poster] while ignoring harmless inline script strings', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-audit-subres-'));
      try {
        const manifest: HarvestedAssetManifest = {
          stylesheets: [],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        const htmlWithIframeAndExtensionless = `
          <!DOCTYPE html>
          <html>
          <head>
            <link rel="stylesheet" href="assets/theme.css">
            <script>
              // Inline script with harmless URL-like string or base64
              const fakeUrl = "//ffuFCxcqZD85Odn05ptvUlJSMv+egZUbSV6l49p009m";
            </script>
          </head>
          <body>
            <a href="https://example.com/nav-link">Harmless Link</a>
            <iframe src="https://www.youtube.com/embed/Nt2J6ZXPuw0"></iframe>
            <img src="https://cdn.example.com/asset-without-extension">
            <video poster="https://cdn.example.com/preview.jpg"></video>
          </body>
          </html>
        `;

        const auditRes = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{
            path: path.join(tempDir, 'index.html'),
            rewrittenContent: htmlWithIframeAndExtensionless,
            originalContent: htmlWithIframeAndExtensionless,
            replacementCount: 0
          }]
        });

        assert.strictEqual(auditRes.passed, false, 'Audit must fail closed due to iframe, extensionless CDN img, and video poster');
        const lingeringCodes = auditRes.findings.filter(f => f.code === 'LINGERING_REMOTE_NETWORK_URL');
        assert.strictEqual(lingeringCodes.length, 3, 'Must flag exactly the 3 remote sub-resources (iframe, extensionless img, poster)');
        const urls = lingeringCodes.map(f => f.details?.url);
        assert.ok(urls.includes('https://www.youtube.com/embed/Nt2J6ZXPuw0'), 'Must flag iframe src');
        assert.ok(urls.includes('https://cdn.example.com/asset-without-extension'), 'Must flag extensionless CDN asset');
        assert.ok(urls.includes('https://cdn.example.com/preview.jpg'), 'Must flag video poster');
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });
    it('accepts inert iframe data-src metadata when src is about:blank', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-audit-inert-iframe-'));
      try {
        const manifest: HarvestedAssetManifest = { stylesheets: [], javascripts: [], images: [], fonts: [], totalBytes: 0 };
        const html = '<!DOCTYPE html><html><body><iframe src="about:blank" data-src="https://video.example.test/film.mp4"></iframe></body></html>';
        const auditRes = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{ path: path.join(tempDir, 'index.html'), rewrittenContent: html, originalContent: html, replacementCount: 0 }]
        });
        assert.ok(!auditRes.findings.some(f => f.code === 'LINGERING_REMOTE_NETWORK_URL'), 'inert iframe metadata must not be treated as a loaded resource');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('fails closed on Alpine/Vue bound resource attributes (:src, :data-src) containing remote URLs', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-audit-bound-'));
      try {
        const manifest: HarvestedAssetManifest = {
          stylesheets: [],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        // Exact shape observed on Hoplongtech video popup line 983
        const htmlWithBoundRemote = `
          <div class="popup-content__wrap flex-left-between">
            <iframe width="1280" height="536" :data-src="openVideo ? '' : 'https://www.youtube.com/embed/Nt2J6ZXPuw0'" :src="openVideo ? 'https://www.youtube.com/embed/Nt2J6ZXPuw0' : ''" frameborder="0" allowfullscreen=""></iframe>
          </div>
        `;

        const auditRes = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{
            path: path.join(tempDir, 'index.html'),
            rewrittenContent: htmlWithBoundRemote,
            originalContent: htmlWithBoundRemote,
            replacementCount: 0
          }]
        });

        assert.strictEqual(auditRes.passed, false, 'Audit must fail closed on remote URL in Alpine bound attributes');
        const lingering = auditRes.findings.filter(f => f.code === 'LINGERING_REMOTE_NETWORK_URL');
        assert.strictEqual(lingering.length, 2, 'Must flag both :data-src and :src bound remote URLs');
        assert.strictEqual(lingering[0].details?.url, 'https://www.youtube.com/embed/Nt2J6ZXPuw0');
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });
    it('5.7. verifyAndAudit exempts inline data: URIs (SVG xmlns namespace) from LINGERING_REMOTE_NETWORK_URL while still flagging genuine remote src', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-audit-datauri-'));
      try {
        const manifest: HarvestedAssetManifest = { stylesheets: [], javascripts: [], images: [], fonts: [], totalBytes: 0 };

        // Case A: <img src="data:image/svg+xml,..."> whose embedded SVG declares the standard
        // w3.org xmlns namespace. data: URIs are inline payloads, never network fetches; the
        // namespace must NOT be flagged as a lingering remote URL (regression for fail-closed
        // false positive that threw on legitimate storefronts using inline SVG).
        const inlineSvgContent = `
          <div>
            <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23ccc'/%3E%3C/svg%3E" alt="inline" width="32" height="32">
            <img src="data:image/png;base64,iVBORw0KGgo=" alt="png">
          </div>
        `;
        const auditA = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{
            path: 'index.html',
            replacementCount: 0,
            originalContent: inlineSvgContent,
            rewrittenContent: inlineSvgContent
          }]
        });
        assert.strictEqual(auditA.passed, true, 'data: URIs must be exempt from network URL audit');
        assert.strictEqual(auditA.findings.length, 0, 'no findings for inline data: URIs');

        // Case B: A genuine remote http src in the same document MUST still be flagged.
        const mixedContent = inlineSvgContent + '\n<img src="https://cdn.example.com/real.png" alt="real">';
        const auditB = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{
            path: 'index.html',
            replacementCount: 0,
            originalContent: mixedContent,
            rewrittenContent: mixedContent
          }]
        });
        assert.strictEqual(auditB.passed, false, 'genuine remote src must still fail audit');
        const remoteFindings = auditB.findings.filter(f => f.code === 'LINGERING_REMOTE_NETWORK_URL');
        assert.strictEqual(remoteFindings.length, 1, 'exactly the genuine remote URL flagged');
        assert.strictEqual(remoteFindings[0].details?.url, 'https://cdn.example.com/real.png');
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });
  });

  // --- 6. Deterministic Naming, Surface Qualifiers & Behavioral Invariants ---
  describe('6. Deterministic Naming, Surface Qualifiers & Behavioral Invariants', () => {
    it('6.0. verifyAndAudit ignores remote-looking literals inside a Liquid template inline runtime while still flagging real sub-resources', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-liquid-inline-runtime-'));
      try {
        const manifest: HarvestedAssetManifest = { stylesheets: [], javascripts: [], images: [], fonts: [], totalBytes: 0 };
        // A shipped theme template carries the cloned page's inline runtime verbatim; JS
        // string literals are not network sub-resources and must not fail the final audit.
        const runtimeContent = `<main data-antifan-clone="1">
  <img src="{{ 'hero-banner.webp' | asset_url }}" alt="hero">
  <script>
    var CDN = 'https://theme.hstatic.net/1000000000/1000000000/14/app.js';
    var FALLBACK = "https://cdn.example.com/assets/logo.png";
    if (window.location.hash) { document.write('<img src="https://tracker.example.com/pixel.png">'); }
  </script>
</main>`;
        const auditPass = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{ path: 'snippets/hero_section.liquid', replacementCount: 0, originalContent: runtimeContent, rewrittenContent: runtimeContent }]
        });
        assert.strictEqual(auditPass.passed, true, 'inline runtime literals in a .liquid template must not be treated as sub-resources');
        assert.strictEqual(auditPass.findings.length, 0, 'no findings expected for Liquid inline runtime literals');

        // A real remote sub-resource in the same template still fails closed.
        const withRemoteScript = runtimeContent.replace('</main>', '<script src="https://cdn.example.com/real.js"></script>\n</main>');
        const auditFail = localizer.verifyAndAudit(manifest, {
          assetsDir: tempDir,
          rewrittenFiles: [{ path: 'snippets/hero_section.liquid', replacementCount: 0, originalContent: withRemoteScript, rewrittenContent: withRemoteScript }]
        });
        assert.strictEqual(auditFail.passed, false, 'a remote script src in a .liquid template must still fail the audit');
        const flagged = auditFail.findings.filter(f => f.code === 'LINGERING_REMOTE_NETWORK_URL');
        assert.strictEqual(flagged.length, 1, 'exactly the real remote sub-resource is flagged');
        assert.strictEqual(flagged[0].details?.url, 'https://cdn.example.com/real.js');
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('6.0.1. CSS-discovered dependencies inherit the same opaque-stem rule as harvested assets', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-css-opaque-dep-'));
      try {
        const mainCss = `
          @font-face { font-family: 'X'; src: url('https://cdn.example.com/img/1739329183_a8f71c2.woff2') format('woff2'); }
          .hero { background: url('https://cdn.example.com/images/hero-banner.webp'); }
        `;
        fs.writeFileSync(path.join(tempDir, 'main.css'), mainCss, 'utf8');
        const manifest: HarvestedAssetManifest = {
          stylesheets: [{
            type: 'css',
            sourceUrl: 'https://cdn.example.com/css/main.css',
            filename: 'main.css',
            localPath: path.join(tempDir, 'main.css')
          }],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 0
        };

        await localizer.localizeDownloadedStylesheets(manifest, { assetsDir: tempDir, skipDownload: true });

        const fontItem = manifest.fonts.find(f => f.sourceUrl.includes('1739329183_a8f71c2'));
        assert.ok(fontItem, 'Opaque-stem font dependency must still be discovered and localized');
        assert.match(fontItem.filename, /^asset-[0-9a-f]{8}\.woff2$/, 'Opaque CDN stem must not leak into the theme');

        const imageItem = manifest.images.find(i => i.sourceUrl.includes('hero-banner'));
        assert.ok(imageItem, 'Semantic image dependency must still be discovered');
        assert.strictEqual(imageItem.filename, 'hero-banner.webp', 'A meaningful stem must be preserved');
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('6.1. Reversed input order invariance: harvesting [desktop, mobile] vs [mobile, desktop] produces identical manifest filenames', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-order-invariance-'));

      const desktopFile = {
        path: 'index.html',
        content: `
          <link rel="stylesheet" href="https://example.com/assets/app-DCc2d3nB.css">
          <script src="https://example.com/assets/bundle-1.js"></script>
          <img src="https://example.com/images/hero.png">
          <img src="https://example.com/shared/logo.png">
        `
      };

      const mobileFile = {
        path: 'mobile/index.html',
        content: `
          <link rel="stylesheet" href="https://example.com/assets/app-5WA_Jy_a.css">
          <script src="https://example.com/assets/bundle-2.js"></script>
          <img src="https://example.com/mobile-images/hero.png">
          <img src="https://example.com/shared/logo.png">
        `
      };

      try {
        const manifestForward = harvester.harvestFromFiles([desktopFile, mobileFile], tempDir);
        const manifestReversed = harvester.harvestFromFiles([mobileFile, desktopFile], tempDir);

        const getFilenames = (m: HarvestedAssetManifest) => ({
          stylesheets: m.stylesheets.map(s => `${s.sourceUrl} -> ${s.filename}`).sort(),
          javascripts: m.javascripts.map(j => `${j.sourceUrl} -> ${j.filename}`).sort(),
          images: m.images.map(i => `${i.sourceUrl} -> ${i.filename}`).sort(),
        });

        const forwardNames = getFilenames(manifestForward);
        const reversedNames = getFilenames(manifestReversed);

        assert.deepStrictEqual(forwardNames, reversedNames, 'Reversing file order MUST produce exact same allocated filenames');

        // Confirm no arbitrary _2 or _3 sequential numbers
        const allAllocated = [
          ...manifestForward.stylesheets.map(s => s.filename),
          ...manifestForward.javascripts.map(j => j.filename),
          ...manifestForward.images.map(i => i.filename),
        ];
        for (const fn of allAllocated) {
          assert.strictEqual(/_[2-9]\.[a-zA-Z0-9]+$/.test(fn), false, `Filename must not have traversal-order counter: ${fn}`);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.2. Same stem across surfaces receives proven -desktop and -mobile qualifiers', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-surface-qualifiers-'));

      const files = [
        {
          path: 'index.html',
          content: `
            <img src="https://example.com/desktop-assets/banner.jpg">
            <img src="https://example.com/common/shared-logo.png">
          `
        },
        {
          path: 'mobile/index.html',
          content: `
            <img src="https://example.com/mobile-assets/banner.jpg">
            <img src="https://example.com/common/shared-logo.png">
          `
        }
      ];

      try {
        const manifest = harvester.harvestFromFiles(files, tempDir);
        const desktopBanner = manifest.images.find(i => i.sourceUrl === 'https://example.com/desktop-assets/banner.jpg');
        const mobileBanner = manifest.images.find(i => i.sourceUrl === 'https://example.com/mobile-assets/banner.jpg');
        const sharedLogo = manifest.images.find(i => i.sourceUrl === 'https://example.com/common/shared-logo.png');

        assert.ok(desktopBanner, 'Desktop banner harvested');
        assert.ok(mobileBanner, 'Mobile banner harvested');
        assert.ok(sharedLogo, 'Shared logo harvested');

        assert.strictEqual(desktopBanner.filename, 'banner-desktop.jpg');
        assert.strictEqual(mobileBanner.filename, 'banner-mobile.jpg');
        assert.strictEqual(sharedLogo.filename, 'shared-logo.png');
        assert.strictEqual(sharedLogo.occurrences?.length, 2);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.3. Preserves retina density (@2x), dimensions (1920x1080), and query variants without collapsing', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-retina-dims-'));

      const html = `
        <img src="https://example.com/images/hero.png">
        <img src="https://example.com/images/hero@2x.png">
        <img src="https://example.com/images/background-1920x1080.jpg">
        <img src="https://example.com/images/background-480x320.jpg">
        <img src="https://example.com/products/shirt.jpg?width=600">
        <img src="https://example.com/products/shirt.jpg?width=1200">
      `;

      try {
        const manifest = harvester.harvestFromHtml(html, tempDir);
        assert.strictEqual(manifest.images.length, 6);

        const hero = manifest.images.find(i => i.sourceUrl === 'https://example.com/images/hero.png');
        const hero2x = manifest.images.find(i => i.sourceUrl === 'https://example.com/images/hero@2x.png');
        const bg1080 = manifest.images.find(i => i.sourceUrl === 'https://example.com/images/background-1920x1080.jpg');
        const bg320 = manifest.images.find(i => i.sourceUrl === 'https://example.com/images/background-480x320.jpg');
        const shirt600 = manifest.images.find(i => i.sourceUrl === 'https://example.com/products/shirt.jpg?width=600');
        const shirt1200 = manifest.images.find(i => i.sourceUrl === 'https://example.com/products/shirt.jpg?width=1200');

        assert.strictEqual(hero?.filename, 'hero.png');
        assert.strictEqual(hero2x?.filename, 'hero@2x.png');
        assert.strictEqual(bg1080?.filename, 'background-1920x1080.jpg');
        assert.strictEqual(bg320?.filename, 'background-480x320.jpg');
        assert.strictEqual(shirt600?.filename, 'shirt-w600.jpg');
        assert.strictEqual(shirt1200?.filename, 'shirt-w1200.jpg');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.4. Windows reserved names (CON, AUX, NUL) and case-insensitive collision safety', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-win-reserved-'));

      const html = `
        <img src="https://example.com/images/con.png">
        <link rel="stylesheet" href="https://example.com/styles/aux.css">
        <script src="https://example.com/scripts/nul.js"></script>
        <img src="https://example.com/bucketA/Logo.png">
        <img src="https://example.com/bucketB/logo.png">
      `;

      try {
        const manifest = harvester.harvestFromHtml(html, tempDir);

        const conImg = manifest.images.find(i => i.sourceUrl === 'https://example.com/images/con.png');
        const auxCss = manifest.stylesheets.find(s => s.sourceUrl === 'https://example.com/styles/aux.css');
        const nulJs = manifest.javascripts.find(j => j.sourceUrl === 'https://example.com/scripts/nul.js');

        assert.strictEqual(conImg?.filename, 'asset-con.png');
        assert.strictEqual(auxCss?.filename, 'asset-aux.css');
        assert.strictEqual(nulJs?.filename, 'asset-nul.js');

        const logoA = manifest.images.find(i => i.sourceUrl === 'https://example.com/bucketA/Logo.png');
        const logoB = manifest.images.find(i => i.sourceUrl === 'https://example.com/bucketB/logo.png');

        assert.ok(logoA);
        assert.ok(logoB);
        assert.notStrictEqual(
          logoA.filename.toLowerCase(),
          logoB.filename.toLowerCase(),
          `Case-variant URLs must not collide case-insensitively on Windows: ${logoA.filename} vs ${logoB.filename}`
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.5. HTML entity (&amp;) and secondary CSS dependency rewriting without lingering remote URLs', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [{
          type: 'css',
          sourceUrl: 'https://example.com/styles/main.css',
          filename: 'main.css',
          localPath: '/tmp/main.css'
        }],
        javascripts: [],
        images: [{
          type: 'image',
          sourceUrl: 'https://example.com/images/product.jpg?w=100&h=200',
          filename: 'product-100x200.jpg',
          localPath: '/tmp/product-100x200.jpg'
        }],
        fonts: [],
        totalBytes: 0
      };

      const htmlWithEntity = '<img src="https://example.com/images/product.jpg?w=100&amp;h=200">';
      const res = localizer.rewriteFiles([{ path: 'index.html', content: htmlWithEntity }], manifest, { mode: 'liquid' });

      assert.strictEqual(res.totalReplacements, 1);
      assert.strictEqual(res.files[0].rewrittenContent, '<img src="{{ \'product-100x200.jpg\' | asset_url }}">');

      const cssWithImport = '@import url("https://example.com/styles/main.css");';
      const cssRes = rewriteCssUrls(cssWithImport, new Map([
        ['https://example.com/styles/main.css', 'main.css']
      ]), { mode: 'relative' });

      assert.strictEqual(cssRes.replacementCount, 1);
      assert.strictEqual(cssRes.content, '@import url("main.css");');
    });

    it('6.6. Zero-byte failure cleanup removes aborted empty files from targetLocalPath', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-zerobyte-cleanup-'));

      try {
        const item = {
          type: 'image' as const,
          sourceUrl: 'https://invalid-host-that-cannot-resolve-12345.example/test.png',
          filename: 'test.png',
          localPath: path.join(tempDir, 'test.png')
        };

        // Simulate pre-existing zero-byte corrupted artifact
        fs.writeFileSync(item.localPath, Buffer.alloc(0));
        assert.strictEqual(fs.existsSync(item.localPath), true);

        const res = await localizer.downloadAssets([item], {
          assetsDir: tempDir,
          concurrency: 1,
          timeoutMs: 1000
        });

        assert.strictEqual(res.failedCount, 1);
        assert.strictEqual(
          fs.existsSync(item.localPath),
          false,
          'Corrupted zero-byte file must be cleaned up on download failure'
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.7. HarvestFileInput context with surface and UA partitions same-URL variants into distinct -desktop / -mobile items without Map collapse', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-context-harvest-'));

      try {
        const files: HarvestFileInput[] = [
          {
            path: 'index.html',
            content: '<img src="https://example.com/banner.png">',
            context: {
              surface: 'desktop',
              userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
              requestHeaders: { 'sec-ch-ua-mobile': '?0' }
            }
          },
          {
            path: 'mobile/index.html',
            content: '<img src="https://example.com/banner.png">',
            context: {
              surface: 'mobile',
              userAgent: 'Mozilla/5.0 (iPhone)',
              requestHeaders: { 'sec-ch-ua-mobile': '?1' }
            }
          }
        ];

        const manifest = harvester.harvestFromFiles(files, tempDir);
        assert.strictEqual(manifest.images.length, 2, 'Same URL with different surface context must partition into 2 items');

        const desktopItem = manifest.images.find(img => img.requestIdentity === 'desktop');
        const mobileItem = manifest.images.find(img => img.requestIdentity === 'mobile');

        assert.ok(desktopItem, 'Desktop item must exist');
        assert.ok(mobileItem, 'Mobile item must exist');

        assert.strictEqual(desktopItem.filename, 'banner-desktop.png');
        assert.strictEqual(mobileItem.filename, 'banner-mobile.png');

        assert.strictEqual(desktopItem.requestHeaders?.['sec-ch-ua-mobile'], '?0');
        assert.strictEqual(mobileItem.requestHeaders?.['sec-ch-ua-mobile'], '?1');

        assert.strictEqual(desktopItem.originalFilename, 'banner.png');
        assert.strictEqual(mobileItem.originalFilename, 'banner.png');

        assert.ok(manifest.assetMap, 'Manifest assetMap must be present');
        // Ambiguous bare alias must NOT clobber with last-wins; must only be accessible via qualified keys
        assert.strictEqual(manifest.assetMap['https://example.com/banner.png'], undefined, 'Ambiguous alias with conflicting targets must not be assigned to bare key');
        assert.strictEqual(manifest.assetMap['https://example.com/banner.png#desktop'], 'banner-desktop.png');
        assert.strictEqual(manifest.assetMap['https://example.com/banner.png#mobile'], 'banner-mobile.png');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.8. rewriteFiles in relative mode outputs ../assets/ for mobile/index.html across all attributes (href, src, srcset, inline CSS)', () => {
      const localizer = new AssetLocalizer();

      const manifest: HarvestedAssetManifest = {
        stylesheets: [{
          type: 'css',
          sourceUrl: 'https://example.com/app.css',
          filename: 'app.css',
          localPath: '/tmp/app.css'
        }],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/banner.png',
            filename: 'banner-desktop.png',
            localPath: '/tmp/banner-desktop.png',
            requestIdentity: 'desktop'
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/banner.png',
            filename: 'banner-mobile.png',
            localPath: '/tmp/banner-mobile.png',
            requestIdentity: 'mobile'
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/banner@2x.png',
            filename: 'banner-2x.png',
            localPath: '/tmp/banner-2x.png'
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/bg.png',
            filename: 'bg.png',
            localPath: '/tmp/bg.png'
          }
        ],
        fonts: [],
        totalBytes: 0
      };

      const html = [
        '<link rel="stylesheet" href="https://example.com/app.css">',
        '<img src="https://example.com/banner.png">',
        '<picture><source srcset="https://example.com/banner.png 1x, https://example.com/banner@2x.png 2x"></picture>',
        '<div style="background-image: url(&quot;https://example.com/bg.png&quot;)"></div>'
      ].join('\n');

      // 1. Mobile rewrite test: must output ../assets/ for all attributes and select banner-mobile.png
      const mobileRes = localizer.rewriteFiles([
        { path: 'mobile/index.html', content: html, context: { surface: 'mobile' } }
      ], manifest, { mode: 'relative' });

      const mobileContent = mobileRes.files[0].rewrittenContent;
      assert.ok(mobileContent.includes('href="../assets/app.css"'), 'href must point to ../assets/');
      assert.ok(mobileContent.includes('src="../assets/banner-mobile.png"'), 'src must point to ../assets/ with mobile variant');
      assert.ok(mobileContent.includes('srcset="../assets/banner-mobile.png 1x, ../assets/banner-2x.png 2x"'), 'srcset must point to ../assets/');
      assert.ok(mobileContent.includes('url(&quot;../assets/bg.png&quot;)'), 'inline style must point to ../assets/');
      assert.strictEqual(mobileContent.includes('assets/banner-desktop.png'), false, 'Desktop variant must not leak into mobile');

      // 2. Desktop rewrite test: must output assets/ for all attributes and select banner-desktop.png
      const desktopRes = localizer.rewriteFiles([
        { path: 'index.html', content: html, context: { surface: 'desktop' } }
      ], manifest, { mode: 'relative' });

      const desktopContent = desktopRes.files[0].rewrittenContent;
      assert.ok(desktopContent.includes('href="assets/app.css"'), 'href must point to assets/');
      assert.ok(desktopContent.includes('src="assets/banner-desktop.png"'), 'src must point to assets/ with desktop variant');
      assert.ok(desktopContent.includes('srcset="assets/banner-desktop.png 1x, assets/banner-2x.png 2x"'), 'srcset must point to assets/');
      assert.ok(desktopContent.includes('url(&quot;assets/bg.png&quot;)'), 'inline style must point to assets/');
      assert.strictEqual(desktopContent.includes('assets/banner-mobile.png'), false, 'Mobile variant must not leak into desktop');
    });

    it('6.9. Downloaded asset content checksum (sha256) calculation and cache-read hashing', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sha-test-'));

      try {
        const payload = Buffer.from('TEST_PAYLOAD_FOR_SHA256');
        const expectedSha = createHash('sha256').update(payload).digest('hex');

        const item: HarvestedAssetItem = {
          type: 'image',
          sourceUrl: 'https://example.com/cached.png',
          filename: 'cached.png',
          localPath: path.join(tempDir, 'cached.png'),
          requestIdentity: 'desktop'
        };

        // Pre-create file on disk
        fs.writeFileSync(item.localPath, payload);

        const res = await localizer.downloadAssets([item], {
          assetsDir: tempDir,
          concurrency: 1
        });

        assert.strictEqual(res.downloaded.length, 1);
        assert.strictEqual(res.downloaded[0].status, 'skipped_cached');
        assert.strictEqual(res.downloaded[0].sha256, expectedSha);
        assert.strictEqual(res.downloaded[0].requestIdentity, 'desktop');
        assert.strictEqual(item.sha256, expectedSha);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.10. sanitizeRequestHeaders enforces strict allowlist (UA, accept, client hints) and drops secrets, Host, and header injection attempts', () => {
      const dirty = {
        'Authorization': 'Bearer secret_token_xyz',
        'authorization': 'Bearer second_secret',
        'Cookie': 'session=super_secret_cookie',
        'set-cookie': 'id=123',
        'x-haravan-access-token': 'token123',
        'X-Shopify-Access-Token': 'token456',
        'x-api-key': 'secret-api-key-999',
        'proxy-authorization': 'Basic credentials',
        'token': 'plain-token',
        'Host': 'malicious-host.com',
        'host': 'evil.internal',
        'X-Forwarded-Host': 'spoofed.domain',
        'User-Agent': 'ValidUA/1.0 (Windows NT 10.0)',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"iOS"',
        'Accept': 'image/webp,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua-injected': 'val\r\nInjected-Header: evil'
      };

      const clean = sanitizeRequestHeaders(dirty);
      assert.ok(clean);
      assert.strictEqual(clean['User-Agent'], 'ValidUA/1.0 (Windows NT 10.0)');
      assert.strictEqual(clean['sec-ch-ua-mobile'], '?1');
      assert.strictEqual(clean['sec-ch-ua-platform'], '"iOS"');
      assert.strictEqual(clean['Accept'], 'image/webp,*/*');
      assert.strictEqual(clean['Accept-Language'], 'en-US,en;q=0.9');

      // Strict allowlist checks:
      assert.strictEqual(clean['Authorization'], undefined);
      assert.strictEqual(clean['authorization'], undefined);
      assert.strictEqual(clean['Cookie'], undefined);
      assert.strictEqual(clean['set-cookie'], undefined);
      assert.strictEqual(clean['x-haravan-access-token'], undefined);
      assert.strictEqual(clean['X-Shopify-Access-Token'], undefined);
      assert.strictEqual(clean['x-api-key'], undefined);
      assert.strictEqual(clean['proxy-authorization'], undefined);
      assert.strictEqual(clean['token'], undefined);
      assert.strictEqual(clean['Host'], undefined);
      assert.strictEqual(clean['host'], undefined);
      assert.strictEqual(clean['X-Forwarded-Host'], undefined);
      // Header injection attempt must be dropped
      assert.strictEqual(clean['sec-ch-ua-injected'], undefined);
    });

    it('6.11. Collision registry uses entityKey (type::sourceUrl::reqId) and progressively extends hash slice on collision', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-collision-harvest-'));

      try {
        const files: HarvestFileInput[] = [
          {
            path: 'a.html',
            content: '<img src="https://cdn.example.com/v1/logo.png">'
          },
          {
            path: 'b.html',
            content: '<img src="https://other.example.com/v2/logo.png">'
          }
        ];

        const manifest = harvester.harvestFromFiles(files, tempDir);
        assert.strictEqual(manifest.images.length, 2);
        assert.notStrictEqual(manifest.images[0].filename, manifest.images[1].filename);
        // Both start with logo, but second has deterministic hash slice
        assert.ok(manifest.images[0].filename.startsWith('logo'));
        assert.ok(manifest.images[1].filename.startsWith('logo'));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.12. Differing request headers on same surface generate distinct header fingerprints and prevent asset collapse', () => {
      const harvester = new AssetHarvester();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-headerfp-harvest-'));

      try {
        const files: HarvestFileInput[] = [
          {
            path: 'index-en.html',
            content: '<img src="https://example.com/dynamic-banner.png">',
            context: {
              surface: 'desktop',
              requestHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
            }
          },
          {
            path: 'index-vi.html',
            content: '<img src="https://example.com/dynamic-banner.png">',
            context: {
              surface: 'desktop',
              requestHeaders: { 'Accept-Language': 'vi-VN,vi;q=0.9' }
            }
          }
        ];

        const manifest = harvester.harvestFromFiles(files, tempDir);
        assert.strictEqual(manifest.images.length, 2, 'Differing request headers must prevent collapse into 1 item');
        assert.notStrictEqual(manifest.images[0].requestIdentity, manifest.images[1].requestIdentity);
        assert.notStrictEqual(manifest.images[0].filename, manifest.images[1].filename);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.13. rewriteFiles handles absolute caller file paths relative to options.assetsDir without ../../../ traversal bugs', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-abs-path-test-'));
      const assetsDir = path.join(tempDir, 'assets');
      const desktopHtmlPath = path.join(tempDir, 'index.html');
      const mobileHtmlPath = path.join(tempDir, 'mobile', 'index.html');

      try {
        const manifest: HarvestedAssetManifest = {
          stylesheets: [{
            type: 'css',
            sourceUrl: 'https://example.com/app.css',
            filename: 'app.css',
            localPath: path.join(assetsDir, 'app.css')
          }],
          javascripts: [],
          images: [{
            type: 'image',
            sourceUrl: 'https://example.com/logo.png',
            filename: 'logo.png',
            localPath: path.join(assetsDir, 'logo.png')
          }],
          fonts: [],
          totalBytes: 0
        };

        const res = localizer.rewriteFiles([
          { path: desktopHtmlPath, content: '<link rel="stylesheet" href="https://example.com/app.css"><img src="https://example.com/logo.png">' },
          { path: mobileHtmlPath, content: '<link rel="stylesheet" href="https://example.com/app.css"><img src="https://example.com/logo.png">' }
        ], manifest, { mode: 'relative', assetsDir });

        assert.strictEqual(res.files.length, 2);
        const desktopRes = res.files.find(f => f.path === desktopHtmlPath)!;
        const mobileRes = res.files.find(f => f.path === mobileHtmlPath)!;

        assert.ok(desktopRes.rewrittenContent.includes('href="assets/app.css"'));
        assert.ok(desktopRes.rewrittenContent.includes('src="assets/logo.png"'));
        assert.strictEqual(desktopRes.rewrittenContent.includes('../'), false, 'Desktop must not contain ../ traversal');

        assert.ok(mobileRes.rewrittenContent.includes('href="../assets/app.css"'));
        assert.ok(mobileRes.rewrittenContent.includes('src="../assets/logo.png"'));
        assert.strictEqual(mobileRes.rewrittenContent.includes('../../'), false, 'Mobile must resolve to clean ../assets/ not excessive ../');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.14. Same URL used across multiple types (css and js) rewrites link and script tags to distinct targets without collision', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [{
          type: 'css',
          sourceUrl: 'https://example.com/bundle',
          filename: 'bundle.css',
          localPath: '/tmp/bundle.css'
        }],
        javascripts: [{
          type: 'js',
          sourceUrl: 'https://example.com/bundle',
          filename: 'bundle.js',
          localPath: '/tmp/bundle.js'
        }],
        images: [],
        fonts: [],
        totalBytes: 0
      };

      const html = '<link rel="stylesheet" href="https://example.com/bundle"><script src="https://example.com/bundle"></script>';
      const res = localizer.rewriteFiles([{ path: 'index.html', content: html }], manifest, { mode: 'relative' });

      assert.strictEqual(res.totalReplacements, 2);
      assert.ok(res.files[0].rewrittenContent.includes('href="assets/bundle.css"'), 'link tag must resolve to css target');
      assert.ok(res.files[0].rewrittenContent.includes('src="assets/bundle.js"'), 'script tag must resolve to js target');
    });

    it('6.15. Provenance occurrence matching selects exact variant for file even when surface is identical', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/banner.png',
            filename: 'banner-page1.png',
            localPath: '/tmp/banner-page1.png',
            occurrences: [{ filePath: 'pages/page1.html', tag: 'img', attribute: 'src' }]
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/banner.png',
            filename: 'banner-page2.png',
            localPath: '/tmp/banner-page2.png',
            occurrences: [{ filePath: 'pages/page2.html', tag: 'img', attribute: 'src' }]
          }
        ],
        fonts: [],
        totalBytes: 0
      };

      const res1 = localizer.rewriteFiles([{ path: 'pages/page1.html', content: '<img src="https://example.com/banner.png">' }], manifest, { mode: 'relative' });
      const res2 = localizer.rewriteFiles([{ path: 'pages/page2.html', content: '<img src="https://example.com/banner.png">' }], manifest, { mode: 'relative' });

      assert.ok(res1.files[0].rewrittenContent.includes('banner-page1.png'), 'page1 must resolve to banner-page1');
      assert.ok(res2.files[0].rewrittenContent.includes('banner-page2.png'), 'page2 must resolve to banner-page2');
    });

    it('6.16. Ambiguous asset variants without matching provenance, requestIdentity, or surface fail closed with AMBIGUOUS_ASSET_VARIANT', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/conflicting.png',
            filename: 'conflicting-a.png',
            localPath: '/tmp/a.png',
            requestIdentity: 'custom-variant-a'
          },
          {
            type: 'image',
            sourceUrl: 'https://example.com/conflicting.png',
            filename: 'conflicting-b.png',
            localPath: '/tmp/b.png',
            requestIdentity: 'custom-variant-b'
          }
        ],
        fonts: [],
        totalBytes: 0
      };

      assert.throws(() => {
        localizer.rewriteFiles([{ path: 'unknown.html', content: '<img src="https://example.com/conflicting.png">' }], manifest, { mode: 'relative' });
      }, /AMBIGUOUS_ASSET_VARIANT/);
    });

    it('6.16b. rewriteFiles never registers a bare path+query key that collides across origins', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://cdn-a.example.com/logo.png',
            filename: 'logo-a.png',
            localPath: '/tmp/logo-a.png'
          },
          {
            type: 'image',
            sourceUrl: 'https://cdn-b.example.com/logo.png',
            filename: 'logo-b.png',
            localPath: '/tmp/logo-b.png'
          }
        ],
        fonts: [],
        totalBytes: 0
      };

      const html = '<img src="https://cdn-a.example.com/logo.png"><img src="https://cdn-b.example.com/logo.png"><img src="/logo.png">';
      const res = localizer.rewriteFiles([{ path: 'index.html', content: html }], manifest, { mode: 'relative' });

      assert.ok(
        res.files[0].rewrittenContent.includes('src="assets/logo-a.png"'),
        'origin A reference must resolve to origin A file'
      );
      assert.ok(
        res.files[0].rewrittenContent.includes('src="assets/logo-b.png"'),
        'origin B reference must resolve to origin B file'
      );
      assert.ok(
        res.files[0].rewrittenContent.includes('src="/logo.png"'),
        'an ambiguous bare path must not be rewritten to either origin\'s file'
      );
    });

    it('6.17. consolidateIdenticalContent collapses byte-identical items across contexts to surface-neutral file and preserves distinct-byte variants', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-consolidate-test-'));

      try {
        const pngContent = Buffer.from('FAKE_PNG_BYTE_IDENTICAL_HEADER_AND_BODY');
        const pngSha = createHash('sha256').update(pngContent).digest('hex');

        const cssDesktopContent = Buffer.from('body { color: red; font-size: 16px; }');
        const cssDesktopSha = createHash('sha256').update(cssDesktopContent).digest('hex');

        const cssMobileContent = Buffer.from('body { color: blue; font-size: 12px; margin: 0; }');
        const cssMobileSha = createHash('sha256').update(cssMobileContent).digest('hex');

        // Write all 4 files on disk in tempDir
        fs.writeFileSync(path.join(tempDir, 'logo-desktop.png'), pngContent);
        fs.writeFileSync(path.join(tempDir, 'logo-mobile.png'), pngContent);
        fs.writeFileSync(path.join(tempDir, 'app-desktop.css'), cssDesktopContent);
        fs.writeFileSync(path.join(tempDir, 'app-mobile.css'), cssMobileContent);

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://example.com/assets/app.css',
              filename: 'app-desktop.css',
              localPath: path.join(tempDir, 'app-desktop.css'),
              requestIdentity: 'desktop',
              byteCount: cssDesktopContent.length,
              sha256: cssDesktopSha
            },
            {
              type: 'css',
              sourceUrl: 'https://example.com/assets/app.css',
              filename: 'app-mobile.css',
              localPath: path.join(tempDir, 'app-mobile.css'),
              requestIdentity: 'mobile',
              byteCount: cssMobileContent.length,
              sha256: cssMobileSha
            }
          ],
          javascripts: [],
          images: [
            {
              type: 'image',
              sourceUrl: 'https://example.com/images/logo.png',
              filename: 'logo-desktop.png',
              localPath: path.join(tempDir, 'logo-desktop.png'),
              requestIdentity: 'desktop',
              byteCount: pngContent.length,
              sha256: pngSha
            },
            {
              type: 'image',
              sourceUrl: 'https://example.com/images/logo.png',
              filename: 'logo-mobile.png',
              localPath: path.join(tempDir, 'logo-mobile.png'),
              requestIdentity: 'mobile',
              byteCount: pngContent.length,
              sha256: pngSha
            }
          ],
          fonts: [],
          totalBytes: (pngContent.length * 2) + cssDesktopContent.length + cssMobileContent.length,
          assetMap: {
            'https://example.com/images/logo.png#desktop': 'logo-desktop.png',
            'https://example.com/images/logo.png#mobile': 'logo-mobile.png',
            'logo-desktop.png': 'logo-desktop.png',
            'logo-mobile.png': 'logo-mobile.png',
            'https://example.com/assets/app.css#desktop': 'app-desktop.css',
            'https://example.com/assets/app.css#mobile': 'app-mobile.css',
            'app-desktop.css': 'app-desktop.css',
            'app-mobile.css': 'app-mobile.css'
          }
        };

        const downloaded: DownloadedAssetResult[] = [
          {
            sourceUrl: 'https://example.com/images/logo.png',
            filename: 'logo-desktop.png',
            localPath: path.join(tempDir, 'logo-desktop.png'),
            status: 'downloaded',
            byteCount: pngContent.length,
            sha256: pngSha,
            requestIdentity: 'desktop'
          },
          {
            sourceUrl: 'https://example.com/images/logo.png',
            filename: 'logo-mobile.png',
            localPath: path.join(tempDir, 'logo-mobile.png'),
            status: 'downloaded',
            byteCount: pngContent.length,
            sha256: pngSha,
            requestIdentity: 'mobile'
          },
          {
            sourceUrl: 'https://example.com/assets/app.css',
            filename: 'app-desktop.css',
            localPath: path.join(tempDir, 'app-desktop.css'),
            status: 'downloaded',
            byteCount: cssDesktopContent.length,
            sha256: cssDesktopSha,
            requestIdentity: 'desktop'
          },
          {
            sourceUrl: 'https://example.com/assets/app.css',
            filename: 'app-mobile.css',
            localPath: path.join(tempDir, 'app-mobile.css'),
            status: 'downloaded',
            byteCount: cssMobileContent.length,
            sha256: cssMobileSha,
            requestIdentity: 'mobile'
          }
        ];

        const res = localizer.consolidateIdenticalContent(downloaded, manifest, tempDir);

        // 1. Result metrics
        assert.strictEqual(res.consolidated, 1, 'Exactly one duplicate copy must be eliminated');
        assert.strictEqual(res.freedBytes, pngContent.length, 'Freed bytes must equal size of duplicate file');
        assert.strictEqual(res.groups.length, 1);
        assert.strictEqual(res.groups[0].canonical, 'logo.png', 'Canonical member must be renamed to surface-neutral name');
        assert.strictEqual(res.groups[0].renamedFrom, 'logo-desktop.png', 'Renamed canonical must be documented in renamedFrom');
        assert.deepStrictEqual(res.groups[0].removed, ['logo-mobile.png'], 'Only physically unlinked file must appear in removed');
        assert.ok(res.groups[0].aliases?.includes('logo-desktop.png'));
        assert.ok(res.groups[0].aliases?.includes('logo-mobile.png'));
        // 2. On-disk verification
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'logo.png')), true, 'Neutral logo.png must exist on disk');
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'logo-desktop.png')), false, 'logo-desktop.png must be gone from disk');
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'logo-mobile.png')), false, 'logo-mobile.png must be gone from disk');
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'app-desktop.css')), true, 'Distinct-byte app-desktop.css must stay on disk');
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'app-mobile.css')), true, 'Distinct-byte app-mobile.css must stay on disk');

        // 3. Manifest item verification
        assert.strictEqual(manifest.images[0].filename, 'logo.png');
        assert.strictEqual(manifest.images[0].localPath, path.join(tempDir, 'logo.png'));
        assert.strictEqual(manifest.images[1].filename, 'logo.png');
        assert.strictEqual(manifest.images[1].localPath, path.join(tempDir, 'logo.png'));
        assert.strictEqual(manifest.stylesheets[0].filename, 'app-desktop.css');
        assert.strictEqual(manifest.stylesheets[1].filename, 'app-mobile.css');

        // 4. AssetMap aliases verification: both qualified aliases and bare URL resolve to canonical
        assert.strictEqual(manifest.assetMap!['https://example.com/images/logo.png#desktop'], 'logo.png');
        assert.strictEqual(manifest.assetMap!['https://example.com/images/logo.png#mobile'], 'logo.png');
        assert.strictEqual(manifest.assetMap!['https://example.com/images/logo.png'], 'logo.png');
        assert.strictEqual(manifest.assetMap!['logo-desktop.png'], 'logo.png');
        assert.strictEqual(manifest.assetMap!['logo-mobile.png'], 'logo.png');
        assert.strictEqual(manifest.assetMap!['https://example.com/assets/app.css#desktop'], 'app-desktop.css');
        assert.strictEqual(manifest.assetMap!['https://example.com/assets/app.css#mobile'], 'app-mobile.css');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.18. localizeDownloadedStylesheets rewrites every on-disk stylesheet belonging to downloaded CSS rows sharing one source URL', async () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-multicss-rewrite-test-'));

      try {
        const cssDesktopContent = `@font-face { font-family: 'Roboto'; src: url('/build/assets/Roboto-Bold.ttf') format('truetype'); }\n.hero { background: url('https://example.com/images/hero-bg.png'); }`;
        const cssMobileContent = `@font-face { font-family: 'Roboto'; src: url('/build/assets/Roboto-Bold.ttf') format('truetype'); }\n.hero { background: url('https://example.com/images/hero-bg.png'); }`;
        const fontContent = Buffer.from('MOCK_ROBOTO_FONT_BYTES');
        const imageContent = Buffer.from('MOCK_HERO_BG_PNG_BYTES');

        fs.writeFileSync(path.join(tempDir, 'app-desktop-dcc2d3nb.css'), cssDesktopContent);
        fs.writeFileSync(path.join(tempDir, 'app-mobile-dcc2d3nb.css'), cssMobileContent);
        fs.writeFileSync(path.join(tempDir, 'Roboto-Bold.ttf'), fontContent);
        fs.writeFileSync(path.join(tempDir, 'hero-bg.png'), imageContent);

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://example.com/build/assets/app-DCc2d3nB.css',
              filename: 'app-desktop-dcc2d3nb.css',
              localPath: path.join(tempDir, 'app-desktop-dcc2d3nb.css'),
              requestIdentity: 'desktop'
            },
            {
              type: 'css',
              sourceUrl: 'https://example.com/build/assets/app-DCc2d3nB.css',
              filename: 'app-mobile-dcc2d3nb.css',
              localPath: path.join(tempDir, 'app-mobile-dcc2d3nb.css'),
              requestIdentity: 'mobile'
            }
          ],
          javascripts: [],
          images: [
            {
              type: 'image',
              sourceUrl: 'https://example.com/images/hero-bg.png',
              filename: 'hero-bg.png',
              localPath: path.join(tempDir, 'hero-bg.png')
            }
          ],
          fonts: [
            {
              type: 'font',
              sourceUrl: 'https://example.com/build/assets/Roboto-Bold.ttf',
              filename: 'Roboto-Bold.ttf',
              localPath: path.join(tempDir, 'Roboto-Bold.ttf')
            }
          ],
          totalBytes: cssDesktopContent.length + cssMobileContent.length + fontContent.length + imageContent.length
        };

        const res = await localizer.localizeDownloadedStylesheets(manifest, {
          assetsDir: tempDir,
          sourceBaseUrl: 'https://example.com/build/assets/app-DCc2d3nB.css',
          skipDownload: true,
          mode: 'relative'
        });

        // Both files must be rewritten in-place
        const rewrittenDesktop = fs.readFileSync(path.join(tempDir, 'app-desktop-dcc2d3nb.css'), 'utf8');
        const rewrittenMobile = fs.readFileSync(path.join(tempDir, 'app-mobile-dcc2d3nb.css'), 'utf8');

        assert.strictEqual(rewrittenDesktop.includes('url("/build/assets/Roboto-Bold.ttf")'), false, 'Desktop must not contain raw /build/assets/');
        assert.strictEqual(rewrittenDesktop.includes('https://example.com/images/hero-bg.png'), false, 'Desktop must not contain remote image URL');
        assert.ok(rewrittenDesktop.includes('Roboto-Bold.ttf'), 'Desktop must reference localized font');
        assert.ok(rewrittenDesktop.includes('hero-bg.png'), 'Desktop must reference localized image');

        assert.strictEqual(rewrittenMobile.includes('url("/build/assets/Roboto-Bold.ttf")'), false, 'Mobile must not contain raw /build/assets/');
        assert.strictEqual(rewrittenMobile.includes('https://example.com/images/hero-bg.png'), false, 'Mobile must not contain remote image URL');
        assert.ok(rewrittenMobile.includes('Roboto-Bold.ttf'), 'Mobile must reference localized font');
        assert.ok(rewrittenMobile.includes('hero-bg.png'), 'Mobile must reference localized image');

        // Verify audit reports zero UNLOCALIZED_REMOTE_URL or UNRESOLVED_CSS_DEPENDENCY
        const audit = localizer.verifyAndAudit(manifest, { assetsDir: tempDir, rewrittenFiles: [] });
        const cssFindings = audit.findings.filter(f => f.code === 'UNLOCALIZED_REMOTE_URL' || f.code === 'UNRESOLVED_CSS_DEPENDENCY');
        assert.strictEqual(cssFindings.length, 0, `Expected 0 CSS audit findings, got: ${JSON.stringify(cssFindings)}`);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.19. consolidateIdenticalContent groups strictly by on-disk sha256: preserves distinct-byte on-disk files and merges equal on-disk files recording canonical on-disk hash', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ondisk-sha-test-'));

      try {
        // Scenario 1: On-disk bytes differ -> NOT merged, nothing deleted
        const desktopContent1 = Buffer.from('body { font-family: Roboto; color: red; }');
        const mobileContent1 = Buffer.from('body { font-family: Arial; color: blue; }');

        fs.writeFileSync(path.join(tempDir, 'style-desktop.css'), desktopContent1);
        fs.writeFileSync(path.join(tempDir, 'style-mobile.css'), mobileContent1);

        const staleServedHash = 'f1a989eebd43382c4aa86e122cfbe937da07c9f552455ef1586bf12ae101598f';
        const manifest1: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://example.com/style.css',
              filename: 'style-desktop.css',
              localPath: path.join(tempDir, 'style-desktop.css'),
              requestIdentity: 'desktop',
              sha256: staleServedHash,
              byteCount: 100
            },
            {
              type: 'css',
              sourceUrl: 'https://example.com/style.css',
              filename: 'style-mobile.css',
              localPath: path.join(tempDir, 'style-mobile.css'),
              requestIdentity: 'mobile',
              sha256: staleServedHash,
              byteCount: 100
            }
          ],
          javascripts: [],
          images: [],
          fonts: [],
          totalBytes: 200
        };

        const dl1: DownloadedAssetResult[] = [
          {
            sourceUrl: 'https://example.com/style.css',
            filename: 'style-desktop.css',
            localPath: path.join(tempDir, 'style-desktop.css'),
            status: 'downloaded',
            sha256: staleServedHash,
            byteCount: 100
          },
          {
            sourceUrl: 'https://example.com/style.css',
            filename: 'style-mobile.css',
            localPath: path.join(tempDir, 'style-mobile.css'),
            status: 'downloaded',
            sha256: staleServedHash,
            byteCount: 100
          }
        ];

        const res1 = localizer.consolidateIdenticalContent(dl1, manifest1, tempDir);
        assert.strictEqual(res1.consolidated, 0, 'Different on-disk bytes must not be merged');
        assert.strictEqual(res1.freedBytes, 0);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'style-desktop.css')), true);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'style-mobile.css')), true);

        // Scenario 2: On-disk bytes are equal -> merged, one file deleted, groups[].sha256 equals surviving on-disk hash
        const identicalContent = Buffer.from('body { font-family: Roboto; font-size: 14px; margin: 0; }');
        const expectedOnDiskHash = createHash('sha256').update(identicalContent).digest('hex');

        fs.writeFileSync(path.join(tempDir, 'style-desktop.css'), identicalContent);
        fs.writeFileSync(path.join(tempDir, 'style-mobile.css'), identicalContent);

        const res2 = localizer.consolidateIdenticalContent(dl1, manifest1, tempDir);
        assert.strictEqual(res2.consolidated, 1, 'Equal on-disk bytes must be merged');
        assert.strictEqual(res2.freedBytes, identicalContent.length, 'Freed bytes must equal deleted file size');
        assert.strictEqual(res2.groups.length, 1);
        assert.strictEqual(res2.groups[0].canonical, 'style.css');
        assert.strictEqual(res2.groups[0].sha256, expectedOnDiskHash, 'Reported sha256 must match surviving file on disk');

        // Verify on disk
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'style.css')), true);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'style-desktop.css')), false);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'style-mobile.css')), false);

        const actualOnDiskBytes = fs.readFileSync(path.join(tempDir, 'style.css'));
        const actualOnDiskHash = createHash('sha256').update(actualOnDiskBytes).digest('hex');
        assert.strictEqual(res2.groups[0].sha256, actualOnDiskHash);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.20. consolidateIdenticalContent yields qualifier-free canonical when all members carry surface qualifiers (<base>-desktop.<ext> + <base>-mobile.<ext>)', () => {
      const localizer = new AssetLocalizer();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-neutral-qualifier-test-'));

      try {
        const cssBytes = Buffer.from('/* identical css */ body { margin: 0; }');
        const imgBytes = Buffer.from('/* identical img */ FAKE_PNG_DATA');
        const cssSha = createHash('sha256').update(cssBytes).digest('hex');
        const imgSha = createHash('sha256').update(imgBytes).digest('hex');

        // Two groups with NO neutral member:
        // Group 1: embedded surface qualifier before hash: app-desktop-dcc2d3nb.css + app-mobile-dcc2d3nb.css
        // Group 2: trailing surface qualifier: autonics-ben-main-desktop.jpg + autonics-ben-main-mobile.jpg
        fs.writeFileSync(path.join(tempDir, 'app-desktop-dcc2d3nb.css'), cssBytes);
        fs.writeFileSync(path.join(tempDir, 'app-mobile-dcc2d3nb.css'), cssBytes);
        fs.writeFileSync(path.join(tempDir, 'autonics-ben-main-desktop.jpg'), imgBytes);
        fs.writeFileSync(path.join(tempDir, 'autonics-ben-main-mobile.jpg'), imgBytes);

        const manifest: HarvestedAssetManifest = {
          stylesheets: [
            {
              type: 'css',
              sourceUrl: 'https://example.com/assets/app-DCc2d3nB.css',
              filename: 'app-desktop-dcc2d3nb.css',
              localPath: path.join(tempDir, 'app-desktop-dcc2d3nb.css'),
              requestIdentity: 'desktop'
            },
            {
              type: 'css',
              sourceUrl: 'https://example.com/assets/app-DCc2d3nB.css',
              filename: 'app-mobile-dcc2d3nb.css',
              localPath: path.join(tempDir, 'app-mobile-dcc2d3nb.css'),
              requestIdentity: 'mobile'
            }
          ],
          javascripts: [],
          images: [
            {
              type: 'image',
              sourceUrl: 'https://example.com/images/autonics-ben-main.jpg',
              filename: 'autonics-ben-main-desktop.jpg',
              localPath: path.join(tempDir, 'autonics-ben-main-desktop.jpg'),
              requestIdentity: 'desktop'
            },
            {
              type: 'image',
              sourceUrl: 'https://example.com/images/autonics-ben-main.jpg',
              filename: 'autonics-ben-main-mobile.jpg',
              localPath: path.join(tempDir, 'autonics-ben-main-mobile.jpg'),
              requestIdentity: 'mobile'
            }
          ],
          fonts: [],
          totalBytes: (cssBytes.length * 2) + (imgBytes.length * 2),
          assetMap: {
            'https://example.com/assets/app-DCc2d3nB.css#desktop': 'app-desktop-dcc2d3nb.css',
            'https://example.com/assets/app-DCc2d3nB.css#mobile': 'app-mobile-dcc2d3nb.css',
            'https://example.com/images/autonics-ben-main.jpg#desktop': 'autonics-ben-main-desktop.jpg',
            'https://example.com/images/autonics-ben-main.jpg#mobile': 'autonics-ben-main-mobile.jpg'
          }
        };

        const dl: DownloadedAssetResult[] = [
          {
            sourceUrl: 'https://example.com/assets/app-DCc2d3nB.css',
            filename: 'app-desktop-dcc2d3nb.css',
            localPath: path.join(tempDir, 'app-desktop-dcc2d3nb.css'),
            status: 'downloaded',
            sha256: cssSha,
            byteCount: cssBytes.length
          },
          {
            sourceUrl: 'https://example.com/assets/app-DCc2d3nB.css',
            filename: 'app-mobile-dcc2d3nb.css',
            localPath: path.join(tempDir, 'app-mobile-dcc2d3nb.css'),
            status: 'downloaded',
            sha256: cssSha,
            byteCount: cssBytes.length
          },
          {
            sourceUrl: 'https://example.com/images/autonics-ben-main.jpg',
            filename: 'autonics-ben-main-desktop.jpg',
            localPath: path.join(tempDir, 'autonics-ben-main-desktop.jpg'),
            status: 'downloaded',
            sha256: imgSha,
            byteCount: imgBytes.length
          },
          {
            sourceUrl: 'https://example.com/images/autonics-ben-main.jpg',
            filename: 'autonics-ben-main-mobile.jpg',
            localPath: path.join(tempDir, 'autonics-ben-main-mobile.jpg'),
            status: 'downloaded',
            sha256: imgSha,
            byteCount: imgBytes.length
          }
        ];

        const res = localizer.consolidateIdenticalContent(dl, manifest, tempDir);

        // 1. Accounting: exactly 2 files deleted (1 per group)
        assert.strictEqual(res.consolidated, 2, 'Exactly 2 files physically deleted');
        assert.strictEqual(res.freedBytes, cssBytes.length + imgBytes.length, 'Freed bytes must equal size of deleted files');
        assert.strictEqual(res.groups.length, 2);

        const cssGroup = res.groups.find(g => g.canonical === 'app-dcc2d3nb.css');
        const imgGroup = res.groups.find(g => g.canonical === 'autonics-ben-main.jpg');
        assert.ok(cssGroup, 'CSS canonical must be qualifier-free app-dcc2d3nb.css');
        assert.ok(imgGroup, 'Image canonical must be qualifier-free autonics-ben-main.jpg');

        assert.strictEqual(cssGroup?.renamedFrom, 'app-desktop-dcc2d3nb.css');
        assert.deepStrictEqual(cssGroup?.removed, ['app-mobile-dcc2d3nb.css']);

        assert.strictEqual(imgGroup?.renamedFrom, 'autonics-ben-main-desktop.jpg');
        assert.deepStrictEqual(imgGroup?.removed, ['autonics-ben-main-mobile.jpg']);

        // 2. On-disk check: qualifier-free files exist, surface-qualified files deleted
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'app-dcc2d3nb.css')), true);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'app-desktop-dcc2d3nb.css')), false);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'app-mobile-dcc2d3nb.css')), false);

        assert.strictEqual(fs.existsSync(path.join(tempDir, 'autonics-ben-main.jpg')), true);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'autonics-ben-main-desktop.jpg')), false);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'autonics-ben-main-mobile.jpg')), false);

        // 3. AssetMap aliases check: all resolve to qualifier-free canonical
        assert.strictEqual(manifest.assetMap!['https://example.com/assets/app-DCc2d3nB.css#desktop'], 'app-dcc2d3nb.css');
        assert.strictEqual(manifest.assetMap!['https://example.com/assets/app-DCc2d3nB.css#mobile'], 'app-dcc2d3nb.css');
        assert.strictEqual(manifest.assetMap!['https://example.com/assets/app-DCc2d3nB.css'], 'app-dcc2d3nb.css');
        assert.strictEqual(manifest.assetMap!['https://example.com/images/autonics-ben-main.jpg#desktop'], 'autonics-ben-main.jpg');
        assert.strictEqual(manifest.assetMap!['https://example.com/images/autonics-ben-main.jpg#mobile'], 'autonics-ben-main.jpg');
        assert.strictEqual(manifest.assetMap!['https://example.com/images/autonics-ben-main.jpg'], 'autonics-ben-main.jpg');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6.21. rewriteFiles accurately resolves Next.js image URLs containing &amp; in HTML against harvested assets', () => {
      const localizer = new AssetLocalizer();
      const manifest: HarvestedAssetManifest = {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fpic.jpg&w=640&q=75',
            rawSourceUrl: '/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fpic.jpg&amp;w=640&amp;q=75',
            filename: 'pic-640.jpg',
            localPath: '/tmp/pic-640.jpg'
          }
        ],
        fonts: [],
        totalBytes: 100
      };

      const htmlContent = '<img src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fpic.jpg&amp;w=640&amp;q=75" srcset="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fpic.jpg&amp;w=640&amp;q=75 640w">';
      const res = localizer.rewriteFiles([{ path: 'index.html', content: htmlContent }], manifest, { mode: 'relative', assetsDir: 'assets' });

      assert.strictEqual(res.files.length, 1);
      assert.ok(res.files[0].rewrittenContent.includes('src="assets/pic-640.jpg"'), 'src should be rewritten to local asset');
      assert.ok(res.files[0].rewrittenContent.includes('srcset="assets/pic-640.jpg 640w"'), 'srcset candidate should be rewritten to local asset');
    });
  });
});
