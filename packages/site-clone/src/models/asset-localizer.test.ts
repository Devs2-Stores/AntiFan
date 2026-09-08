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
  type DownloadTransport
} from './asset-localizer.js';
import type { HarvestedAssetManifest } from './asset-harvester.js';

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
  });
});
