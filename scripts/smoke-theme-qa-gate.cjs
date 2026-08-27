/**
 * Automated Theme QA & Verification Gate Smoke Test
 * Tests PlatformDetector, LiquidErrorScanner, LayoutOverflowEngine, and HsGateRules end-to-end.
 */
const http = require('node:http');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { PlatformDetector } = require('../.compiled/src/main/qa/scanners/platform-detector');
const { LiquidErrorScanner } = require('../.compiled/src/main/qa/scanners/liquid-error-scanner');
const { LayoutOverflowEngine } = require('../.compiled/src/main/qa/scanners/layout-overflow-engine');
const { HsGateRules } = require('../.compiled/src/main/qa/rules/hs-gate-rules');
const { ThemeQaWorkflow } = require('../.compiled/src/main/qa/theme-qa-workflow');
const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port');
const { WorkspaceFilePort } = require('../.compiled/src/main/tools/workspace-file-port');
const { ArtifactStore } = require('../.compiled/src/main/tools/artifact-store');

async function runSmokeThemeQaGate() {
  console.log('[Theme QA Smoke] Starting Automated Theme QA Verification Gate Smoke Test...');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-smoke-qa-'));
  const artifactsDir = path.join(root, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  let server = null;
  let port = 0;

  try {
    // 1. Start mock server with simulated storefront errors
    const mockStorefrontHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Mock Storefront - Theme QA Gate</title>
  <script src="https://bizweb.dktcdn.net/100/123/themes/all.js"></script>
  <style>
    body { margin: 0; font-family: sans-serif; }
    .banner-wide { width: 2500px; height: 120px; background: red; color: white; }
  </style>
</head>
<body>
  <header>
    <h1>Mock Storefront</h1>
    <div class="liquid-err">Liquid error: Could not find snippet 'header-nav-v2'</div>
  </header>
  <main>
    <div class="banner-wide">Oversized Banner (causes layout overflow)</div>
    <!-- Sapo cart form violating HS-01 -->
    <form action="/cart/add" method="post">
      <input type="hidden" name="id" value="101" />
      <button type="submit">Thêm vào giỏ</button>
    </form>
    <!-- Sapo contact form violating HS-02 -->
    <form action="/contact" method="post">
      <input type="email" name="email" value="customer@example.com" />
      <button type="submit">Gửi liên hệ</button>
    </form>
  </main>
</body>
</html>`;

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(mockStorefrontHtml);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const serverUrl = `http://127.0.0.1:${port}/`;
    console.log(`[Theme QA Smoke] Mock storefront HTTP server listening on ${serverUrl}`);

    // 2. Test PlatformDetector
    console.log('[Theme QA Smoke] Step 1: Testing PlatformDetector...');
    const detected = PlatformDetector.detectFromRuntime(serverUrl, mockStorefrontHtml);
    console.log(`[Theme QA Smoke] Platform detected: ${detected.platform} (confidence: ${detected.confidence})`);
    assert.strictEqual(detected.platform, 'sapo');

    // 3. Test LiquidErrorScanner
    console.log('[Theme QA Smoke] Step 2: Testing LiquidErrorScanner...');
    const liquidScan = LiquidErrorScanner.scanHtmlString(mockStorefrontHtml);
    console.log(`[Theme QA Smoke] Liquid errors detected: ${liquidScan.errors.length}`);
    assert.strictEqual(liquidScan.hasErrors, true);
    assert.strictEqual(liquidScan.errors[0].type, 'missing_include');
    assert.ok(liquidScan.errors[0].message.includes('header-nav-v2'));

    // 4. Test HsGateRules
    console.log('[Theme QA Smoke] Step 3: Testing HsGateRules for Sapo...');
    const hsResult = HsGateRules.evaluateHtml(mockStorefrontHtml, 'sapo');
    console.log(`[Theme QA Smoke] HS violations detected: ${hsResult.violations.length} (errors: ${hsResult.errorsCount}, warnings: ${hsResult.warningsCount})`);
    console.log('[Theme QA Smoke] Violations detail:', JSON.stringify(hsResult.violations, null, 2));
    assert.ok(hsResult.violations.some((v) => v.ruleId === 'HS-02'));

    // 5. Test ThemeQaWorkflow integration
    console.log('[Theme QA Smoke] Step 4: Testing ThemeQaWorkflow integration...');
    const artifactStore = new ArtifactStore({ root: artifactsDir });
    const browser = new BrowserControlPort(
      {
        getTabList: () => [{ id: 'tab-smoke' }],
        navigate: () => true,
        reload: () => true,
        getDom: async () => mockStorefrontHtml,
        captureScreenshot: async () => Buffer.from('mock-png').toString('base64'),
        evalJs: async () => null,
      },
      artifactStore
    );

    const workflow = new ThemeQaWorkflow({
      browser,
      files: new WorkspaceFilePort(),
      artifacts: artifactStore,
      reload: (value) => browser.reload(value),
    });

    const target = {
      projectId: 'project-smoke-1234567890',
      workspaceId: 'workspace-smoke-1234567890',
      runtimeId: 'binding-smoke-1234567890',
      tabId: 'tab-smoke',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const report = await workflow.validate({
      runId: 'run-smoke-1234567890',
      attemptId: 'attempt-smoke-1234567890',
      workspaceRoot: root,
      target,
    });

    console.log('[Theme QA Smoke] ThemeQaReport generated successfully:');
    console.log(`  - Platform: ${report.findings.platform.platform}`);
    console.log(`  - Diagnostics check: ${report.checklist.diagnostics ? 'PASS' : 'FAIL (Expected)'}`);
    console.log(`  - Interactions check: ${report.checklist.interactions ? 'PASS' : 'FAIL (Expected)'}`);
    console.log(`  - Artifacts count: ${report.artifacts.length}`);

    assert.strictEqual(report.checklist.diagnostics, false); // Because of Liquid error
    assert.strictEqual(report.checklist.interactions, false); // Because of HS-01 / HS-02 error
    assert.ok(report.artifacts.some((a) => a.kind === 'report'));

    // 6. Verify PII Sanitization in report
    const reportArtifact = report.artifacts.find((a) => a.kind === 'report');
    const { data } = artifactStore.readBytesById(reportArtifact.id);
    const reportContent = data.toString('utf8');
    assert.ok(!reportContent.includes('customer@example.com'));

    console.log('\n[Theme QA Smoke] ==========================================');
    console.log('[Theme QA Smoke] ALL THEME QA VERIFICATION CHECKS PASSED!');
    console.log('[Theme QA Smoke] ==========================================\n');
  } finally {
    if (server) {
      server.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runSmokeThemeQaGate().catch((err) => {
  console.error('[Theme QA Smoke] FAIL:', err);
  process.exit(1);
});
