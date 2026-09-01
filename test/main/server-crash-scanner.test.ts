import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServerCrashScanner } from '../../src/main/qa/scanners/server-crash-scanner';
import { classifyDiagnostics } from '../../src/main/qa/diagnostics-filter';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

describe('ServerCrashScanner — Browser Injection Script Compilation & Execution', () => {
  it('compiles and executes getBrowserScanScript() without syntax or runtime error', () => {
    const scriptText = ServerCrashScanner.getBrowserScanScript();
    assert.doesNotThrow(() => {
      new vm.Script(scriptText);
    }, 'getBrowserScanScript() must be valid JavaScript syntax');

    // Create a mock DOM environment in vm context
    const context = vm.createContext({
      document: {
        title: 'My Haravan Store',
        body: { innerText: 'Welcome to our store' },
        querySelectorAll: () => [],
        querySelector: () => null,
      },
    });

    const result = vm.runInContext(scriptText, context);
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.hasCrash, false);
    assert.strictEqual(result.errorsCount, 0);
    assert.strictEqual(result.findings.length, 0);
  });

  it('detects Haravan 500 in simulated browser DOM via getBrowserScanScript()', () => {
    const scriptText = ServerCrashScanner.getBrowserScanScript();
    const context = vm.createContext({
      document: {
        title: 'Có gì đó không ổn !',
        body: { innerText: 'Server Error 500\nTraceId: 67b84319000000000000000000000000' },
        querySelectorAll: (selector: string) => {
          if (selector.includes('h1')) {
            return [{
              textContent: 'Có gì đó không ổn !',
              closest: () => null,
              nodeType: 1,
            }];
          }
          return [];
        },
        querySelector: () => null,
      },
    });

    const result = vm.runInContext(scriptText, context);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.errorsCount, 1);
    assert.strictEqual(result.findings[0]!.provider, 'haravan');
    assert.strictEqual(result.findings[0]!.type, 'server_500');
    assert.strictEqual(result.findings[0]!.traceId, '67b84319000000000000000000000000');
  });

  it('detects Cloudflare 520 / Ray ID in simulated browser DOM via getBrowserScanScript()', () => {
    const scriptText = ServerCrashScanner.getBrowserScanScript();
    const context = vm.createContext({
      document: {
        title: 'Web server is returning an unknown error',
        body: { innerText: 'Error 520 Ray ID: 893ab491823c9012' },
        querySelectorAll: () => [],
        querySelector: (selector: string) => {
          if (selector.includes('cf-wrapper') || selector.includes('cf-error-details')) {
            return { nodeType: 1 };
          }
          return null;
        },
      },
    });

    const result = vm.runInContext(scriptText, context);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.findings[0]!.provider, 'cloudflare');
    assert.strictEqual(result.findings[0]!.traceId, '893ab491823c9012');
  });
});

describe('ServerCrashScanner — HTML Static String Scanner', () => {
  it('detects Haravan 500 crash page with TraceId', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Có gì đó không ổn !</title></head>
        <body>
          <h1>Có gì đó không ổn !</h1>
          <p>Server Error 500</p>
          <div class="trace">TraceId: 98f12a34b56c78de9012345678abcdef</div>
        </body>
      </html>
    `;
    const result = ServerCrashScanner.scanHtmlString(html);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.errorsCount, 1);
    assert.strictEqual(result.findings[0]!.provider, 'haravan');
    assert.strictEqual(result.findings[0]!.traceId, '98f12a34b56c78de9012345678abcdef');
  });

  it('detects Shopify 500 Internal Server Error page', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>500 Internal Server Error</title></head>
        <body>
          <h1>500 Internal Server Error</h1>
          <p>Liquid error (line 42): Memory limit exceeded</p>
        </body>
      </html>
    `;
    const result = ServerCrashScanner.scanHtmlString(html);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.findings[0]!.provider, 'shopify');
    assert.strictEqual(result.findings[0]!.type, 'server_500');
  });

  it('detects Sapo / Bizweb 500 error page', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>500 - Lỗi máy chủ</title></head>
        <body>
          <h2>500 - Lỗi máy chủ</h2>
          <p>Hệ thống đang bận, vui lòng thử lại sau.</p>
        </body>
      </html>
    `;
    const result = ServerCrashScanner.scanHtmlString(html);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.findings[0]!.provider, 'sapo');
  });

  it('detects Cloudflare 502 / 524 / 520 Gateway Error with Ray ID', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>502 Bad Gateway</title></head>
        <body id="cf-wrapper">
          <div class="cf-error-details">
            <h1>Error 524</h1>
            <p>Ray ID: 7c8d9e0f1a2b3c4d</p>
          </div>
        </body>
      </html>
    `;
    const result = ServerCrashScanner.scanHtmlString(html);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.findings[0]!.provider, 'cloudflare');
    assert.strictEqual(result.findings[0]!.traceId, '7c8d9e0f1a2b3c4d');
  });

  it('detects Raw Backend Runtime Dump', () => {
    const html = `
      <html>
        <head><title>Error</title></head>
        <body>
          <pre>Fatal error: Uncaught Exception: Database connection lost in /var/www/html/index.php:123</pre>
        </body>
      </html>
    `;
    const result = ServerCrashScanner.scanHtmlString(html);
    assert.strictEqual(result.hasCrash, true);
    assert.strictEqual(result.findings[0]!.provider, 'runtime');
  });

  it('ignores benign mentions of 500 or errors inside article and blog RTE content', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Hướng dẫn sửa lỗi 500 trên website</title></head>
        <body>
          <header><h1>Blog Công Nghệ</h1></header>
          <article class="post-content">
            <h2>Làm thế nào khi gặp lỗi 500 - Lỗi máy chủ?</h2>
            <p>Khi gặp thông báo Có gì đó không ổn hoặc 500 Internal Server Error, hãy kiểm tra TraceId...</p>
          </article>
        </body>
      </html>
    `;
    const result = ServerCrashScanner.scanHtmlString(html);
    assert.strictEqual(result.hasCrash, false);
    assert.strictEqual(result.errorsCount, 0);
  });
});

describe('Main-Frame HTTP Status Telemetry in classifyDiagnostics', () => {
  const contextUrl = 'https://store.example.com/';

  it('marks main-frame status 500/502/503 as critical', () => {
    const result = classifyDiagnostics(
      {
        failures: [
          {
            errorCode: 0,
            errorDescription: 'Internal Server Error',
            validatedURL: 'https://store.example.com/',
            isMainFrame: true,
            status: 500,
          },
        ],
      },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 1);
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.criticalIssues[0]!.kind, 'network');
  });

  it('marks main-frame status 401/403/404 as warning only (e.g. password challenge)', () => {
    const result = classifyDiagnostics(
      {
        failures: [
          {
            errorCode: 0,
            errorDescription: 'Unauthorized - Password Protected Store',
            validatedURL: 'https://store.example.com/password',
            isMainFrame: true,
            status: 401,
          },
          {
            errorCode: 0,
            errorDescription: 'Not Found',
            validatedURL: 'https://store.example.com/404',
            isMainFrame: true,
            status: 404,
          },
        ],
      },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 0);
    assert.strictEqual(result.warnings.length, 2);
  });
});

describe('ThemeQaWorkflow Integration with ServerCrashScanner', () => {
  const target: BrowserTarget = {
    projectId: 'project-12345678901234567890',
    workspaceId: 'workspace-12345678901234567890',
    runtimeId: 'binding-12345678901234567890',
    tabId: 'tab-crash-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  it('ThemeQaWorkflow fails diagnostics checklist and summary.passed when server crash page is present', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-workflow-server500-'));
    try {
      const crashHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Có gì đó không ổn !</title></head>
          <body>
            <h1>Có gì đó không ổn !</h1>
            <p>Server Error 500</p>
            <div class="trace">TraceId: a1b2c3d4e5f60718293a4b5c6d7e8f90</div>
          </body>
        </html>
      `;

      const mockHost: BrowserHostPort = {
        getTabList: () => [{ id: 'tab-crash-1', url: 'https://store.example.com/' }],
        navigate: () => true,
        reload: () => true,
        getDom: async () => crashHtml,
        captureScreenshot: async () => Buffer.from('fake-png').toString('base64'),
        evalJs: async () => null,
        getDocumentGeneration: () => 1,
        isCurrentTarget: () => true,
        getDiagnostics: () => ({ console: [], failures: [] }),
      };

      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const browser = new BrowserControlPort(mockHost, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: artifactStore,
        reload: () => ({ reloaded: true, target }),
      });

      const report = await workflow.validate({
        runId: 'run-crash-test',
        attemptId: 'attempt-crash-test',
        workspaceRoot: root,
        target,
      });

      assert.strictEqual(report.summary.passed, false, 'Summary must fail when server crash is present');
      assert.strictEqual(report.checklist.diagnostics, false, 'Checklist diagnostics must be false on server crash');
      assert.strictEqual(report.summary.criticalCount >= 1, true, 'Critical count must include the crash finding');
      assert.strictEqual(report.findings?.serverCrash?.hasCrash, true, 'Detailed findings must include serverCrash result');
      assert.strictEqual(report.findings?.serverCrash?.findings[0]?.provider, 'haravan');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
