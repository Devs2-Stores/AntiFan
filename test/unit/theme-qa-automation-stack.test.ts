import { describe, it } from 'node:test';
import * as assert from 'node:assert';
// @ts-ignore
import { JSDOM } from 'jsdom';
import { ThemeQaWorkflow, ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';
import {
  extractCorrelatableAssetFailures,
  extractDocumentHttpStatus,
  isSameDocumentUrl,
} from '../../src/main/qa/diagnostics-filter';
import { DomSemanticsScanner } from '../../src/main/qa/scanners/dom-semantics-scanner';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';
import { VisualSettleReceipt } from '../../src/main/verification/capture-settle';

const makeTarget = (docGen = 1): BrowserTarget => ({
  tabId: 'tab-auto-qa-1',
  browserEpoch: 1,
  documentGeneration: docGen,
  projectId: 'test-project',
  workspaceId: 'test-workspace',
  runtimeId: 'test-runtime',
  url: 'https://store.example.com',
});

const createMockPorts = (overrides?: {
  settleCapture?: (target: BrowserTarget) => Promise<VisualSettleReceipt>;
  diagnostics?: () => { console: unknown[]; failures: unknown[] };
  responsiveCheck?: (tabId: string) => Promise<Record<string, unknown>>;
  eval?: (target: BrowserTarget, script: string) => Promise<unknown>;
}): ThemeQaWorkflowPorts => {
  const defaultBreakpoints = {
    'mobile-small': { width: 320, height: 568, mobile: true, hasHorizontalOverflow: false },
    'mobile-standard': { width: 375, height: 667, mobile: true, hasHorizontalOverflow: false },
    'tablet-portrait': { width: 768, height: 1024, mobile: false, hasHorizontalOverflow: false },
    'tablet-landscape': { width: 1024, height: 768, mobile: false, hasHorizontalOverflow: false },
    'desktop-laptop': { width: 1440, height: 900, mobile: false, hasHorizontalOverflow: false },
  };

  const browserObj: Record<string, unknown> = {
    dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
    screenshot: async () => ({
      artifactRef: { id: 'art-screenshot', kind: 'screenshot' },
      envelope: {},
    }),
    eval: overrides?.eval ?? (async (_target: BrowserTarget, script: string) => {
      if (script.includes('deadband = 1.0 * dpr') || script.includes('LayoutOverflowEngine')) {
        return { viewport: { name: 'desktop', width: 1440, height: 900 }, measured: true, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
      }
      if (script.includes('ERROR_PATTERNS') || script.includes('LiquidErrorScanner')) {
        return { hasErrors: false, errors: [], scannedElementsCount: 20 };
      }
      if (script.includes('naturalWidth') || script.includes('BrokenAssetScanner')) {
        return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
      }
      if (script.includes('HS-') || script.includes('violations') || script.includes('HsGateRules')) {
        return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
      }
      if (script.includes('ServerCrashScanner')) {
        return { hasCrash: false, errorsCount: 0, findings: [] };
      }
      if (script.includes('MAX_TOP_OFFENDERS') || script.includes('DomSemanticsScanner')) {
        return {
          measured: true,
          score: 100,
          summary: {
            h1Count: 1,
            headingLevelSkipsCount: 0,
            imgMissingAltCount: 0,
            controlsMissingNameCount: 0,
            formControlsMissingLabelCount: 0,
            duplicateIdCount: 0,
            hasHtmlLang: true,
            hasMetaDescription: true,
            hasCanonical: true,
            hasOgTitle: true,
            hasOgImage: true,
            jsonLdBlocksCount: 1,
            jsonLdInvalidCount: 0,
            jsonLdTypes: ['Product'],
            touchTargetsSub24Count: 0,
          },
          findings: [],
        };
      }
      return {};
    }),
    diagnostics: overrides?.diagnostics ?? (() => ({ console: [], failures: [] })),
    listTabs: () => [{ id: 'tab-auto-qa-1', url: 'https://store.example.com' }],
    getDocumentGeneration: () => 1,
    freezeMedia: async () => ({ frozen: true, mediaCount: 0, counts: { media: 0, css: 0, waapi: 0, smil: 0 }, classes: [], animations: [], pausedHandles: 0, restoredHandles: 0 }),
    responsiveCheck: overrides?.responsiveCheck ?? (async () => ({ ok: true, breakpoints: defaultBreakpoints })),
    settleCapture: overrides?.settleCapture ?? (async () => ({
      settleComplete: true,
      gates: { network: true, fonts: true, images: true, dom: true },
      timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 },
      brokenImages: [],
    })),
  };

  return {
    browser: browserObj as unknown as ThemeQaWorkflowPorts['browser'],
    artifacts: {
      stage: (item: { kind: string; data: Buffer | string }) => ({
        id: `art-${item.kind}`,
        kind: item.kind,
        bytes: typeof item.data === 'string' ? Buffer.byteLength(item.data) : item.data.length,
        createdAt: Date.now(),
      }),
      readBytesById: () => ({ data: Buffer.from('<html><body><main>Clean</main></body></html>') }),
    } as unknown as ThemeQaWorkflowPorts['artifacts'],
    reload: (t) => ({ reloaded: true, target: t }),
  };
};

describe('Theme QA Automation Stack (Haravan Next Stack Enhancements)', () => {
  describe('1. Responsive Multi-Breakpoint Defaults and UNMEASURED Gating', () => {
    it('defaults multiBreakpoint to true inside workflow and reports responsive PASS on clean breakpoints', async () => {
      let responsiveCheckCalled = false;
      const ports = createMockPorts({
        responsiveCheck: async () => {
          responsiveCheckCalled = true;
          return {
            ok: true,
            breakpoints: {
              'mobile-small': { width: 320, height: 568, mobile: true, hasHorizontalOverflow: false },
              'mobile-standard': { width: 375, height: 667, mobile: true, hasHorizontalOverflow: false },
              'tablet-portrait': { width: 768, height: 1024, mobile: false, hasHorizontalOverflow: false },
              'tablet-landscape': { width: 1024, height: 768, mobile: false, hasHorizontalOverflow: false },
              'desktop-laptop': { width: 1440, height: 900, mobile: false, hasHorizontalOverflow: false },
            },
          };
        },
      });

      const workflow = new ThemeQaWorkflow(ports);
      // Omit multiBreakpoint param: must default to true
      const report = await workflow.validate({
        runId: 'run-responsive-default',
        attemptId: 'att-responsive-default',
        workspaceRoot: 'E:/Work/test-theme',
        target: makeTarget(),
      });

      assert.strictEqual(responsiveCheckCalled, true, 'responsiveCheck must run by default');
      assert.strictEqual(report.checklist.responsive, true);
      assert.strictEqual(report.summary.responsive, true);
      assert.strictEqual(report.summary.passed, true);
      assert.strictEqual(report.summary.verdict, 'PASS');
    });

    it('marks checklist.responsive and summary.responsive as UNMEASURED when multiBreakpoint: false opts out', async () => {
      const ports = createMockPorts();
      const workflow = new ThemeQaWorkflow(ports);

      const report = await workflow.validate({
        runId: 'run-responsive-opt-out',
        attemptId: 'att-responsive-opt-out',
        workspaceRoot: 'E:/Work/test-theme',
        target: makeTarget(),
        multiBreakpoint: false,
      });

      assert.strictEqual(report.checklist.responsive, 'UNMEASURED');
      assert.strictEqual(report.summary.responsive, 'UNMEASURED');
      assert.strictEqual(report.summary.passed, true, 'Degrades gracefully when responsive sweep is not executed');
      assert.strictEqual(report.summary.verdict, 'PASS');
    });

    it('yields INCONCLUSIVE when responsive check is explicitly required but unmeasured', async () => {
      const ports = createMockPorts();
      const workflow = new ThemeQaWorkflow(ports);

      const report = await workflow.validate({
        runId: 'run-responsive-required-unmeasured',
        attemptId: 'att-responsive-required-unmeasured',
        workspaceRoot: 'E:/Work/test-theme',
        target: makeTarget(),
        multiBreakpoint: false,
        enabledChecks: { responsive: true },
      });

      assert.strictEqual(report.checklist.responsive, 'UNMEASURED');
      assert.strictEqual(report.summary.responsive, 'UNMEASURED');
      assert.strictEqual(report.summary.passed, false, 'Explicitly required responsive check cannot pass when unmeasured');
      assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
      assert.ok(
        report.findings?.evidenceGaps?.some((g) => g.includes('responsive')),
        'Evidence gap must disclose unmeasured responsive check'
      );
    });

    it('fails checklist.responsive and summary when responsive horizontal overflow is detected', async () => {
      const ports = createMockPorts({
        responsiveCheck: async () => ({
          ok: true,
          breakpoints: {
            'mobile-small': { width: 320, height: 568, mobile: true, hasHorizontalOverflow: false },
            'mobile-standard': { width: 375, height: 667, mobile: true, hasHorizontalOverflow: false },
            'tablet-portrait': { width: 768, height: 1024, mobile: false, hasHorizontalOverflow: true, scrollWidth: 800, clientWidth: 768 },
            'tablet-landscape': { width: 1024, height: 768, mobile: false, hasHorizontalOverflow: false },
            'desktop-laptop': { width: 1440, height: 900, mobile: false, hasHorizontalOverflow: false },
          },
        }),
      });

      const workflow = new ThemeQaWorkflow(ports);
      const report = await workflow.validate({
        runId: 'run-responsive-overflow',
        attemptId: 'att-responsive-overflow',
        workspaceRoot: 'E:/Work/test-theme',
        target: makeTarget(),
      });

      assert.strictEqual(report.checklist.responsive, false);
      assert.strictEqual(report.summary.responsive, false);
      assert.strictEqual(report.summary.passed, false);
      assert.strictEqual(report.summary.verdict, 'FAIL');
    });
  });

  describe('2. 404 Route Document Status and Broken Asset Disambiguation', () => {
    it('isSameDocumentUrl normalizes and matches document URLs correctly', () => {
      assert.strictEqual(isSameDocumentUrl('https://example.com/404', 'https://example.com/404'), true);
      assert.strictEqual(isSameDocumentUrl('https://example.com/404/', 'https://example.com/404'), true);
      assert.strictEqual(isSameDocumentUrl('https://example.com/404?themeid=123', 'https://example.com/404'), true);
      assert.strictEqual(isSameDocumentUrl('https://example.com/khong-ton-tai#top', 'https://example.com/khong-ton-tai'), true);
      assert.strictEqual(isSameDocumentUrl('https://example.com/assets/app.js', 'https://example.com/404'), false);
      assert.strictEqual(isSameDocumentUrl('https://cdn.hstatic.net/img.png', 'https://example.com/404'), false);
    });

    it('extractCorrelatableAssetFailures excludes document own URL and includes subresource failures', () => {
      const failures = [
        { url: 'https://store.example.com/khong-ton-tai', status: 404, isMainFrame: true },
        { url: 'https://store.example.com/assets/theme.css', status: 404, isFirstParty: true },
        { url: 'https://store.example.com/assets/logo.png', status: 404, isFirstParty: true },
      ];
      const contextUrl = 'https://store.example.com/khong-ton-tai';

      const correlatable = extractCorrelatableAssetFailures(failures, contextUrl);
      assert.strictEqual(correlatable.length, 2);
      assert.ok(!correlatable.some((f) => f.url.includes('khong-ton-tai')), 'Document URL must be excluded');
      assert.ok(correlatable.some((f) => f.url.includes('theme.css')));
      assert.ok(correlatable.some((f) => f.url.includes('logo.png')));
    });

    it('extractDocumentHttpStatus extracts HTTP status code for main document URL', () => {
      const failures = [
        { url: 'https://store.example.com/assets/logo.png', status: 404 },
        { url: 'https://store.example.com/khong-ton-tai', status: 404, isMainFrame: true },
      ];
      const status = extractDocumentHttpStatus(failures, 'https://store.example.com/khong-ton-tai');
      assert.strictEqual(status, 404);
    });

    it('allows intentional 404 route with clean subresources to PASS while surfacing documentStatus', async () => {
      const doc404Url = 'https://store.example.com/khong-ton-tai-qa-test';
      const ports = createMockPorts({
        diagnostics: () => ({
          console: [],
          failures: [
            {
              url: doc404Url,
              validatedURL: doc404Url,
              status: 404,
              isMainFrame: true,
              isFirstParty: true,
              errorDescription: 'HTTP 404 Not Found',
            },
          ],
        }),
      });

      const workflow = new ThemeQaWorkflow(ports);
      const report = await workflow.validate({
        runId: 'run-404-clean',
        attemptId: 'att-404-clean',
        workspaceRoot: 'E:/Work/test-theme',
        target: { ...makeTarget(), url: doc404Url },
      });

      assert.strictEqual(report.findings?.documentStatus, 404);
      assert.strictEqual(report.summary.documentStatus, 404);
      assert.strictEqual(report.findings?.assets.hasBrokenAssets, false, 'Document 404 must not be treated as a broken asset');
      assert.strictEqual(report.checklist.assetsValid, true);
      assert.strictEqual(report.summary.passed, true);
      assert.strictEqual(report.summary.verdict, 'PASS');
    });

    it('fails 404 route if subresources (images/stylesheets) are genuinely broken', async () => {
      const doc404Url = 'https://store.example.com/khong-ton-tai-qa-test';
      const brokenImageUrl = 'https://store.example.com/assets/banner-missing.png';
      const ports = createMockPorts({
        diagnostics: () => ({
          console: [],
          failures: [
            {
              url: doc404Url,
              validatedURL: doc404Url,
              status: 404,
              isMainFrame: true,
              isFirstParty: true,
            },
            {
              url: brokenImageUrl,
              validatedURL: brokenImageUrl,
              status: 404,
              isMainFrame: false,
              isFirstParty: true,
              errorDescription: 'Not Found',
            },
          ],
        }),
      });

      const workflow = new ThemeQaWorkflow(ports);
      const report = await workflow.validate({
        runId: 'run-404-broken-subresource',
        attemptId: 'att-404-broken-subresource',
        workspaceRoot: 'E:/Work/test-theme',
        target: { ...makeTarget(), url: doc404Url },
      });

      assert.strictEqual(report.findings?.documentStatus, 404);
      assert.strictEqual(report.findings?.assets.hasBrokenAssets, true);
      assert.strictEqual(report.checklist.assetsValid, false);
      assert.strictEqual(report.summary.passed, false);
      assert.strictEqual(report.summary.verdict, 'FAIL');
      assert.ok(report.findings?.assets.brokenAssets.some((a) => a.url === brokenImageUrl));
    });
  });

  describe('3. Layout Integrity .sr-only / .visually-hidden False Positive Exclusions', () => {
    it('LayoutIntegrityEngine script source includes isSrOnly detection', () => {
      const script = LayoutIntegrityEngine.getBrowserScanScript('active');
      assert.ok(script.includes('isSrOnly'), 'Script must define isSrOnly memoized helper');
      assert.ok(script.includes('.sr-only'), 'Script must check .sr-only pattern');
      assert.ok(script.includes('.visually-hidden'), 'Script must check .visually-hidden pattern');
    });
  });

  describe('4. DOM Semantics Scanner (SEO & Accessibility In-Page Audit)', () => {
    it('evaluates clean document semantics and returns high score with valid JSON-LD types', () => {
      const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>Trang chủ Cửa Hàng</title>
  <meta name="description" content="Khám phá bộ sưu tập rượu vang nhập khẩu cao cấp chính hãng tại Lux Wine với giá tốt nhất thị trường.">
  <link rel="canonical" href="https://luxwine.vn/">
  <meta property="og:title" content="Lux Wine — Rượu Vang Cao Cấp">
  <meta property="og:image" content="https://luxwine.vn/og-image.jpg">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Vang Chateau Margaux",
    "image": "https://luxwine.vn/margaux.jpg"
  }
  </script>
</head>
<body>
  <header>
    <a href="/" title="Trang chủ">Trang chủ</a>
    <button type="button" aria-label="Tìm kiếm">🔍</button>
  </header>
  <main>
    <h1>Bộ Sưu Tập Rượu Vang Cao Cấp</h1>
    <h2>Vang Đỏ Pháp</h2>
    <img src="/margaux.jpg" alt="Chai rượu vang Chateau Margaux">
    <form>
      <label for="newsletter-email">Email nhận tin:</label>
      <input type="email" id="newsletter-email">
    </form>
  </main>
</body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.measured, true);
      assert.strictEqual(res.summary.h1Count, 1);
      assert.strictEqual(res.summary.headingLevelSkipsCount, 0);
      assert.strictEqual(res.summary.imgMissingAltCount, 0);
      assert.strictEqual(res.summary.controlsMissingNameCount, 0);
      assert.strictEqual(res.summary.formControlsMissingLabelCount, 0);
      assert.strictEqual(res.summary.duplicateIdCount, 0);
      assert.strictEqual(res.summary.hasHtmlLang, true);
      assert.strictEqual(res.summary.hasMetaDescription, true);
      assert.strictEqual(res.summary.hasCanonical, true);
      assert.strictEqual(res.summary.hasOgTitle, true);
      assert.strictEqual(res.summary.hasOgImage, true);
      assert.strictEqual(res.summary.jsonLdInvalidCount, 0);
      assert.deepStrictEqual(res.summary.jsonLdTypes, ['Product']);
      assert.strictEqual(res.score, 100);
      assert.strictEqual(res.findings.length, 0);
    });

    it('detects missing H1, multiple H1s, and heading level skips', () => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head><title>Test</title></head>
<body>
  <h1>Heading One</h1>
  <h3>Heading Three (skipped H2)</h3>
  <h1>Second H1 (multiple)</h1>
</body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.summary.h1Count, 2);
      assert.strictEqual(res.summary.headingLevelSkipsCount, 1);
      assert.ok(res.findings.some((f) => f.type === 'multiple_h1'));
      assert.ok(res.findings.some((f) => f.type === 'heading_level_skip' && f.details?.from === 1 && f.details?.to === 3));
    });

    it('detects images missing alt attributes while properly excluding aria-hidden and presentation role', () => {
      const html = `<!DOCTYPE html>
<html lang="vi">
<head><title>Images</title></head>
<body>
  <img id="img-broken" src="broken.jpg">
  <img id="img-decorative" src="dec.png" role="presentation">
  <img id="img-hidden" src="hid.png" aria-hidden="true">
  <img id="img-empty-alt" src="clean.png" alt="">
  <img id="img-valid" src="valid.png" alt="A nice bottle">
</body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.summary.imgMissingAltCount, 1);
      const missingFinding = res.findings.find((f) => f.type === 'missing_img_alt');
      assert.ok(missingFinding);
      assert.ok(missingFinding.selector?.includes('#img-broken'));
    });

    it('detects unlabeled form controls and buttons missing accessible name', () => {
      const html = `<!DOCTYPE html>
<html lang="vi">
<head><title>Form</title></head>
<body>
  <button id="btn-empty"></button>
  <button id="btn-labeled" aria-label="Close">X</button>
  <a id="link-empty" href="/cart"></a>
  <input id="input-unlabeled" type="text">
  <label for="input-labeled">Name</label>
  <input id="input-labeled" type="text">
  <input type="hidden" name="id" value="123">
</body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.summary.controlsMissingNameCount, 2);
      assert.strictEqual(res.summary.formControlsMissingLabelCount, 1);
      assert.ok(res.findings.some((f) => f.type === 'missing_accessible_name' && f.selector?.includes('#btn-empty')));
      assert.ok(res.findings.some((f) => f.type === 'missing_accessible_name' && f.selector?.includes('#link-empty')));
      assert.ok(res.findings.some((f) => f.type === 'unlabeled_form_control' && f.selector?.includes('#input-unlabeled')));
    });

    it('detects duplicate IDs on elements', () => {
      const html = `<!DOCTYPE html>
<html lang="vi">
<head><title>Duplicate IDs</title></head>
<body>
  <div id="duplicate-header">A</div>
  <div id="duplicate-header">B</div>
  <div id="unique-box">C</div>
</body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.summary.duplicateIdCount, 1);
      const dup = res.findings.find((f) => f.type === 'duplicate_id');
      assert.ok(dup);
      assert.strictEqual(dup.details?.id, 'duplicate-header');
      assert.strictEqual(dup.details?.count, 2);
    });

    it('flags invalid JSON-LD syntax with critical severity', () => {
      const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <title>JSON-LD Error</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Broken JSON"
    "unquoted": trailing comma,
  }
  </script>
</head>
<body><h1>Product</h1></body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.summary.jsonLdInvalidCount, 1);
      const invalid = res.findings.find((f) => f.type === 'invalid_json_ld');
      assert.ok(invalid);
      assert.strictEqual(invalid.severity, 'critical');
    });

    it('extracts nested and @graph JSON-LD @type lists', () => {
      const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <title>JSON-LD Graph</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "name": "Lux Wine" },
      { "@type": "BreadcrumbList", "itemListElement": [] }
    ]
  }
  </script>
</head>
<body><h1>Store</h1></body>
</html>`;

      const dom = new JSDOM(html);
      const res = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

      assert.strictEqual(res.summary.jsonLdInvalidCount, 0);
      assert.ok(res.summary.jsonLdTypes.includes('WebSite'));
      assert.ok(res.summary.jsonLdTypes.includes('BreadcrumbList'));
    });
  });
});
