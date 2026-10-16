import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-ignore
import { JSDOM } from 'jsdom';
import {
  ThemeQaWorkflow,
  ThemeQaWorkflowPorts,
  buildReceiptFindings,
  buildScopeContainmentScript,
  collectScopeSelectors,
  computeScopedCriticalCount,
  isSelectorInAnnotationScope,
  type ThemeQaDetailedFindings,
} from '../../src/main/qa/theme-qa-workflow';
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
  listTabs?: (opts?: { target?: BrowserTarget }) => Array<{ id: string; url: string }>;
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
    listTabs: overrides?.listTabs ?? ((opts?: { target?: BrowserTarget }) => [{ id: 'tab-auto-qa-1', url: opts?.target?.url || 'https://store.example.com' }]),
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
        profile: 'audit',
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
        profile: 'audit',
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
        profile: 'audit',
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
        profile: 'audit',
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
      const doc404Url = 'https://store.example.com/404';
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
        profile: 'audit',
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

    it('fails non-/404 route returning HTTP 404 with ROUTE_404 critical issue', async () => {
      const brokenRouteUrl = 'https://store.example.com/khong-ton-tai-qa-test';
      const ports = createMockPorts({
        diagnostics: () => ({
          console: [],
          failures: [
            {
              url: brokenRouteUrl,
              validatedURL: brokenRouteUrl,
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
        profile: 'audit',
        runId: 'run-route-404-fail',
        attemptId: 'att-route-404-fail',
        workspaceRoot: 'E:/Work/test-theme',
        target: { ...makeTarget(), url: brokenRouteUrl },
      });

      assert.strictEqual(report.findings?.documentStatus, 404);
      assert.strictEqual(report.summary.documentStatus, 404);
      assert.strictEqual(report.findings?.assets.hasBrokenAssets, false);
      assert.strictEqual(report.checklist.diagnostics, false);
      assert.strictEqual(report.summary.passed, false);
      assert.strictEqual(report.summary.verdict, 'FAIL');
      assert.ok(report.summary.criticalCount >= 1);
      assert.ok(
        report.findings?.diagnosticIssues.some((d) => d.message.includes('ROUTE_404') && d.message.includes(brokenRouteUrl)),
        'ROUTE_404 must be recorded in critical diagnosticIssues'
      );
    });

    it('grades auth redirects on non-auth routes as INCONCLUSIVE (not PASS) across login, register, challenge, and auth', async () => {
      const cases = [
        { requested: 'https://store.example.com/account', landed: 'https://store.example.com/account/login' },
        { requested: 'https://store.example.com/account/orders', landed: 'https://store.example.com/account/register' },
        { requested: 'https://store.example.com/account/addresses', landed: 'https://store.example.com/challenge' },
        { requested: 'https://store.example.com/collections/vip-members', landed: 'https://store.example.com/auth' },
      ];

      for (const { requested, landed } of cases) {
        let callCount = 0;
        const ports = createMockPorts({
          listTabs: () => {
            callCount += 1;
            return [{ id: 'tab-auto-qa-1', url: callCount === 1 ? requested : landed }];
          },
        });
        const workflow = new ThemeQaWorkflow(ports);
        const report = await workflow.validate({
          profile: 'audit',
          runId: 'run-auth-redirect',
          attemptId: 'att-auth-redirect',
          workspaceRoot: 'E:/Work/test-theme',
          target: { ...makeTarget(), url: requested },
        });

        assert.strictEqual(report.summary.passed, false, `Auth redirect from ${requested} to ${landed} must not PASS`);
        assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE', `Auth redirect from ${requested} to ${landed} must be INCONCLUSIVE`);
        assert.ok(
          report.findings?.evidenceGaps?.some((g) => g.includes('AUTH_REDIRECT') && g.includes(requested) && g.includes(landed)),
          'evidenceGaps must include AUTH_REDIRECT'
        );
      }

      for (const authUrl of [
        'https://store.example.com/account/login',
        'https://store.example.com/account/register',
        'https://store.example.com/challenge',
        'https://store.example.com/auth',
      ]) {
        const ports = createMockPorts({
          listTabs: () => [{ id: 'tab-auto-qa-1', url: authUrl }],
        });
        const workflow = new ThemeQaWorkflow(ports);
        const report = await workflow.validate({
          profile: 'audit',
          runId: 'run-auth-direct',
          attemptId: 'att-auth-direct',
          workspaceRoot: 'E:/Work/test-theme',
          target: { ...makeTarget(), url: authUrl },
        });
        assert.strictEqual(report.summary.verdict, 'PASS', `Direct auth page ${authUrl} must not trigger AUTH_REDIRECT`);
        assert.strictEqual(report.summary.passed, true);
      }
    });

    it('fails 404 route if subresources (images/stylesheets) are genuinely broken', async () => {
      const doc404Url = 'https://store.example.com/404';
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
        profile: 'audit',
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

  describe('5. Direct-Edit Annotation Target Selector Scoping', () => {
    it('computes scopedCriticalCount and pageCriticalCount from .antifan/annotations/*.md', async () => {
      assert.strictEqual(
        isSelectorInAnnotationScope(
          'section#limited-edition > div.tw-home-deal__inner > a.tw-btn',
          '#limited-edition',
          'main#MainContent > div.tw-home > section#limited-edition'
        ),
        true,
        'Descendant of annotated element must be in scope'
      );
      assert.strictEqual(
        isSelectorInAnnotationScope(
          'div.tw-home',
          '#limited-edition',
          'main#MainContent > div.tw-home > section#limited-edition'
        ),
        true,
        'Layout ancestor of annotated element must be in scope'
      );
      assert.strictEqual(
        isSelectorInAnnotationScope(
          'footer.site-footer > div.footer-newsletter',
          '#limited-edition',
          'main#MainContent > div.tw-home > section#limited-edition'
        ),
        false,
        'Unrelated footer element must not be in scope'
      );

      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-scoped-qa-'));
      try {
        const annDir = path.join(tmpWs, '.antifan', 'annotations');
        fs.mkdirSync(annDir, { recursive: true });
        fs.writeFileSync(
          path.join(annDir, 'element_1792003171976.md'),
          [
            '---',
            'annotation_id: "annotation_1792003171976"',
            '---',
            '## Captured Element Evidence [Visual Mode: Element SnapDOM Capture]',
            '- Annotation ID: `annotation_1792003171976`',
            '- Element Selector: `#limited-edition`',
            '- DOM Ancestry: `main#MainContent > div.tw-home > section#limited-edition > div.container > div.tw-home-deal__inner`',
          ].join('\n'),
          'utf8'
        );

        const ports = createMockPorts({
          eval: async (_target: BrowserTarget, script: string) => {
            if (script.includes('deadband = 1.0 * dpr') || script.includes('LayoutOverflowEngine')) {
              return {
                viewport: { name: 'desktop', width: 1440, height: 900 },
                measured: true,
                hasOverflow: true,
                deltaX: 48,
                scrollWidth: 1488,
                clientWidth: 1440,
                culprits: [
                  {
                    selector: 'footer.site-footer > div.footer-marquee',
                    tagName: 'div',
                    deltaX: 48,
                    boundingBox: { x: 0, y: 1800, width: 1488, height: 60, right: 1488, bottom: 1860 },
                    outerHtmlSnippet: '<div class="footer-marquee"></div>',
                    offendingStyles: {},
                  },
                ],
              };
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
            return {};
          },
        });

        const workflow = new ThemeQaWorkflow(ports);
        const reportUnrelated = await workflow.validate({
          profile: 'audit',
          runId: 'run-scoped-0',
          attemptId: 'att-scoped-0',
          workspaceRoot: tmpWs,
          target: makeTarget(),
          annotationId: 'annotation_1792003171976',
        });
        assert.strictEqual(reportUnrelated.summary.pageCriticalCount, 1);
        assert.strictEqual(reportUnrelated.summary.scopedCriticalCount, 0);

        const portsScopedHit = createMockPorts({
          eval: async (_target: BrowserTarget, script: string) => {
            if (script.includes('deadband = 1.0 * dpr') || script.includes('LayoutOverflowEngine')) {
              return {
                viewport: { name: 'desktop', width: 1440, height: 900 },
                measured: true,
                hasOverflow: true,
                deltaX: 32,
                scrollWidth: 1472,
                clientWidth: 1440,
                culprits: [
                  {
                    selector: 'section#limited-edition > div.tw-home-deal__inner > a.tw-btn',
                    tagName: 'a',
                    deltaX: 32,
                    boundingBox: { x: 100, y: 400, width: 1400, height: 48, right: 1500, bottom: 448 },
                    outerHtmlSnippet: '<a class="tw-btn"></a>',
                    offendingStyles: {},
                  },
                ],
              };
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
            return {};
          },
        });
        const workflowScopedHit = new ThemeQaWorkflow(portsScopedHit);
        const reportScopedHit = await workflowScopedHit.validate({
          profile: 'audit',
          runId: 'run-scoped-1',
          attemptId: 'att-scoped-1',
          workspaceRoot: tmpWs,
          target: makeTarget(),
          annotationId: 'annotation_1792003171976',
        });
        assert.strictEqual(reportScopedHit.summary.pageCriticalCount, 1);
        assert.strictEqual(reportScopedHit.summary.scopedCriticalCount, 1);

        // 3. Annotated + ROUTE_404 on a non-/404 route -> scopedCriticalCount >= 1
        const brokenRouteUrl = 'https://store.example.com/collections/missing-collection';
        const portsRoute404 = createMockPorts({
          listTabs: () => [{ id: 'tab-auto-qa-1', url: brokenRouteUrl }],
          diagnostics: () => ({
            console: [],
            failures: [
              {
                url: brokenRouteUrl,
                validatedURL: brokenRouteUrl,
                status: 404,
                isMainFrame: true,
                isFirstParty: true,
                errorDescription: 'HTTP 404 Not Found',
              },
            ],
          }),
          eval: async (_target: BrowserTarget, script: string) => {
            if (script.includes('deadband = 1.0 * dpr') || script.includes('LayoutOverflowEngine')) {
              return {
                viewport: { name: 'desktop', width: 1440, height: 900 },
                measured: true,
                hasOverflow: false,
                deltaX: 0,
                scrollWidth: 1440,
                clientWidth: 1440,
                culprits: [],
              };
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
            return {};
          },
        });
        const workflowRoute404 = new ThemeQaWorkflow(portsRoute404);
        const reportRoute404 = await workflowRoute404.validate({
          profile: 'audit',
          runId: 'run-scoped-404',
          attemptId: 'att-scoped-404',
          workspaceRoot: tmpWs,
          target: { ...makeTarget(), url: brokenRouteUrl },
          annotationId: 'annotation_1792003171976',
        });
        assert.strictEqual(reportRoute404.summary.verdict, 'FAIL');
        assert.ok(
          (reportRoute404.summary.scopedCriticalCount ?? 0) >= 1,
          'Annotated run on a 404 route must count ROUTE_404 into scopedCriticalCount (>= 1)'
        );

        // 4. Annotated + selector-less Liquid error -> scopedCriticalCount >= 1
        const portsSelectorlessLiquid = createMockPorts({
          eval: async (_target: BrowserTarget, script: string) => {
            if (script.includes('deadband = 1.0 * dpr') || script.includes('LayoutOverflowEngine')) {
              return {
                viewport: { name: 'desktop', width: 1440, height: 900 },
                measured: true,
                hasOverflow: false,
                deltaX: 0,
                scrollWidth: 1440,
                clientWidth: 1440,
                culprits: [],
              };
            }
            if (script.includes('ERROR_PATTERNS') || script.includes('LiquidErrorScanner')) {
              return {
                hasErrors: true,
                errors: [
                  {
                    type: 'runtime_error',
                    message: 'Liquid error: Could not find snippet icon-watch',
                    snippet: '<!-- Liquid error: Could not find snippet icon-watch -->',
                  },
                ],
                scannedElementsCount: 20,
              };
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
            return {};
          },
        });
        const workflowSelectorlessLiquid = new ThemeQaWorkflow(portsSelectorlessLiquid);
        const reportSelectorlessLiquid = await workflowSelectorlessLiquid.validate({
          profile: 'audit',
          runId: 'run-scoped-liquid',
          attemptId: 'att-scoped-liquid',
          workspaceRoot: tmpWs,
          target: makeTarget(),
          annotationId: 'annotation_1792003171976',
        });
        assert.strictEqual(reportSelectorlessLiquid.summary.verdict, 'FAIL');
        assert.ok(
          (reportSelectorlessLiquid.summary.scopedCriticalCount ?? 0) >= 1,
          'Annotated run with a selector-less Liquid error must count it into scopedCriticalCount (>= 1)'
        );

        const reportOutScopeRegression = await workflow.validate({
          profile: 'audit',
          runId: 'run-scoped-diff-reg',
          attemptId: 'att-scoped-diff-reg',
          workspaceRoot: tmpWs,
          target: makeTarget(),
          annotationId: 'annotation_1792003171976',
          baselineFindings: [],
        });
        assert.strictEqual(
          reportOutScopeRegression.findings?.differential?.introducedRegressions.length,
          1,
          'Out-of-scope overflow must be recorded in differential.introducedRegressions when baseline was clean'
        );
        assert.strictEqual(
          reportOutScopeRegression.summary.scopedCriticalCount,
          1,
          'differential.introducedRegressions must be counted into scopedCriticalCount even when selector is outside targetSelector'
        );

        const reportOutScopePreExisting = await workflow.validate({
          profile: 'audit',
          runId: 'run-scoped-diff-pre',
          attemptId: 'att-scoped-diff-pre',
          workspaceRoot: tmpWs,
          target: makeTarget(),
          annotationId: 'annotation_1792003171976',
          baselineFindings: reportOutScopeRegression.findings,
        });
        assert.strictEqual(
          reportOutScopePreExisting.findings?.differential?.introducedRegressions.length,
          0,
          'Pre-existing out-of-scope overflow must not be in introducedRegressions'
        );
        assert.strictEqual(
          reportOutScopePreExisting.summary.scopedCriticalCount,
          0,
          'Pre-existing out-of-scope defect must keep scopedCriticalCount === 0'
        );
      } finally {
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    it('degrades verdict to INCONCLUSIVE when domSemantics scanner reports measured: false', async () => {
      const portsUnmeasuredDom = createMockPorts({
        eval: async (_target: BrowserTarget, script: string) => {
          if (script.includes('LayoutOverflowEngine') || script.includes('clipContainers')) {
            return {
              viewport: { name: 'desktop', width: 1440, height: 900 },
              measured: true,
              hasOverflow: false,
              deltaX: 0,
              scrollWidth: 1440,
              clientWidth: 1440,
              culprits: [],
            };
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
          if (script.includes('headingHierarchy') || script.includes('jsonLdTypes')) {
            return {
              measured: false,
              summary: {
                passed: true,
                totalIssues: 0,
                errorsCount: 0,
                warningsCount: 0,
                h1Count: 0,
                headingSkipsCount: 0,
                missingAltCount: 0,
                unlabeledControlsCount: 0,
                unnamedInputsCount: 0,
                duplicateIdsCount: 0,
                metaTagsMissingCount: 0,
                jsonLdCount: 0,
                jsonLdInvalidCount: 0,
                touchTargetUndersizedCount: 0,
              },
              findings: [],
              meta: {
                title: '',
                description: null,
                canonical: null,
                ogTitle: null,
                ogImage: null,
                htmlLang: null,
                viewport: null,
              },
              jsonLdTypes: [],
            };
          }
          return {};
        },
      });
      const workflow = new ThemeQaWorkflow(portsUnmeasuredDom);
      const report = await workflow.validate({
        profile: 'audit',
        runId: 'run-unmeasured-dom',
        attemptId: 'att-unmeasured-dom',
        workspaceRoot: '/tmp/ws',
        target: makeTarget(),
      });
      assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
      assert.strictEqual(report.summary.passed, false);
      assert.strictEqual(report.execution, 'DEGRADED');
      assert.ok(
        report.findings?.evidenceGaps?.some((g) => g.includes('DOM semantics not measured')),
        'evidenceGaps must record DOM semantics not measured'
      );
    });
  });
});

describe('responsive page overflow in scoped counts and receipts', () => {
  const entry = (documentOverflow: boolean | null) => ({
    documentOverflow,
    criticalOverflow: documentOverflow === null ? null : documentOverflow ? 1 : 0,
    criticalOverlap: 0,
    criticalClipping: 0,
    criticalOcclusion: 0,
    criticalOffscreen: 0,
    spacingWarnings: 0,
  });
  const findingsOf = (overflow: Record<string, unknown>, responsive: Record<string, unknown>) =>
    ({ overflow, responsive } as unknown as ThemeQaDetailedFindings);

  it('counts breakpoint overflow toward an annotation scope when the active culprits sit elsewhere', () => {
    // The active-viewport culprit is a footer strip outside the hero annotation; the page also
    // overflows at 375px and 1440px. A scoped pass here would hide a failing page verdict.
    const findings = findingsOf(
      { measured: true, hasOverflow: true, viewport: { name: 'desktop', width: 1440, height: 900 }, deltaX: 30, culprits: [{ selector: 'footer .promo-strip', deltaX: 30 }] },
      { '375': entry(true), '768': entry(false), '1440': entry(true) }
    );
    assert.strictEqual(computeScopedCriticalCount(findings, 'section.hero'), 2);
  });

  it('does not count twice the width the overflow block reported as page-level overflow', () => {
    const findings = findingsOf(
      { measured: true, hasOverflow: true, viewport: { name: 'mobile', width: 375, height: 812 }, deltaX: 20, culprits: [] },
      { '375': entry(true), '768': entry(false) }
    );
    assert.strictEqual(computeScopedCriticalCount(findings, 'section.hero'), 1);
  });

  it('writes breakpoint overflow into the receipt as a page-level critical', () => {
    const findings = findingsOf(
      { measured: true, hasOverflow: false, viewport: { name: 'desktop', width: 1440, height: 900 }, deltaX: 0, culprits: [] },
      { '375': entry(true), '1440': entry(false), '768': entry(null) }
    );
    const receipt = buildReceiptFindings(findings);
    const overflow = receipt.filter((f) => f.rule.startsWith('overflow@'));
    assert.deepStrictEqual(overflow.map((f) => [f.rule, f.severity, f.selector]), [['overflow@375', 'critical', null]]);
  });
});

describe('annotation scope reads the live page', () => {
  const html = '<!doctype html><html><body><main><div class="container"><div class="product-card"><p class="price">1.000₫</p><div>x</div></div></div>'
    + '<footer class="site-footer"><p class="price">Footer</p><div class="container">y</div></footer></main></body></html>';
  const liquidAt = (selectors: string[]) =>
    ({ liquid: { errors: selectors.map((selector) => ({ type: 'runtime', message: 'Liquid error', selector })) } } as unknown as ThemeQaDetailedFindings);

  it('asks the page which finding elements sit inside or around the annotated element', () => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const findings = liquidAt(['p.price', 'div.product-card > div', 'footer.site-footer > div.container', 'section.missing']);
    const selectors = collectScopeSelectors(findings);
    // JSON round-trip: the reading is an object from the page realm, as it arrives over eval.
    const reading = JSON.parse(JSON.stringify(dom.window.eval(buildScopeContainmentScript('div.product-card', selectors))));
    assert.deepStrictEqual(reading, {
      'p.price': true,
      'div.product-card > div': true,
      'footer.site-footer > div.container': false,
    });
    assert.strictEqual(computeScopedCriticalCount(findings, 'div.product-card', undefined, undefined, reading), 2);
    assert.strictEqual(dom.window.eval(buildScopeContainmentScript('section.gone', selectors)), null, 'no annotated element, no reading');
  });

  it('counts a selector with no distinctive token when the page could not be read', () => {
    const findings = liquidAt(['div', 'div.container', 'footer.site-footer > p.price']);
    assert.strictEqual(computeScopedCriticalCount(findings, 'div.product-card', 'main > div.container > div.product-card'), 2,
      'div and div.container cannot be shown to lie outside the card; the footer price can');
  });
});
