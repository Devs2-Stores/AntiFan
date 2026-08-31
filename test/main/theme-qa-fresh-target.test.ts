import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { DiagnosticsInput } from '../../src/main/qa/diagnostics-filter';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { BrokenAssetScanner } from '../../src/main/qa/scanners/broken-asset-scanner';
import { HsGateRules } from '../../src/main/qa/rules/hs-gate-rules';
import { AsyncThemeQaQueue } from '../../src/main/qa/async-qa-job-queue';
interface CallRecord {
  method: string;
  targetGen?: number;
  args?: unknown[];
}

function makeTarget(docGen = 1): BrowserTarget {
  return {
    projectId: 'project-12345678901234567890',
    workspaceId: 'workspace-12345678901234567890',
    runtimeId: 'binding-12345678901234567890',
    tabId: 'tab-fresh-1',
    browserEpoch: 1,
    documentGeneration: docGen,
  };
}

class StatefulBrowserHost implements BrowserHostPort {
  public documentGeneration = 1;
  public browserEpoch = 1;
  public calls: CallRecord[] = [];
  public reloadResolver?: (val: boolean) => void;
  public reloadPromiseOverride?: Promise<boolean>;
  public diagnosticsProvider?: (tabId?: string) => { console: unknown[]; failures: unknown[] };
  public evalJsOverride?: (expression: string, tabId?: string) => Promise<unknown>;
  public responsiveCheckOverride?: (tabId: string) => Promise<Record<string, unknown>>;
  public failReload = false;

  getTabList(): unknown[] {
    this.calls.push({ method: 'getTabList', targetGen: this.documentGeneration });
    return [{ id: 'tab-fresh-1', url: 'https://store.example.com/' }];
  }

  getDocumentGeneration(_tabId?: string): number {
    return this.documentGeneration;
  }

  isCurrentTarget(target: BrowserTarget): boolean {
    if (!target) return false;
    return (
      target.tabId === 'tab-fresh-1' &&
      target.projectId === 'project-12345678901234567890' &&
      target.workspaceId === 'workspace-12345678901234567890' &&
      target.runtimeId === 'binding-12345678901234567890' &&
      target.browserEpoch === this.browserEpoch &&
      target.documentGeneration === this.documentGeneration
    );
  }

  async navigate(_tabId: string, _url: string): Promise<boolean> {
    this.calls.push({ method: 'navigate', targetGen: this.documentGeneration });
    return true;
  }

  async reload(_tabId: string): Promise<boolean> {
    this.calls.push({ method: 'reload', targetGen: this.documentGeneration });
    if (this.failReload) {
      return false;
    }
    if (this.reloadPromiseOverride) {
      const result = await this.reloadPromiseOverride;
      if (result) this.documentGeneration++;
      return result;
    }
    this.documentGeneration++;
    return true;
  }

  async getDom(_selector?: string, _tabId?: string): Promise<string> {
    this.calls.push({ method: 'getDom', targetGen: this.documentGeneration });
    return `<html><body><h1>Store Gen ${this.documentGeneration}</h1></body></html>`;
  }

  async captureScreenshot(_rect?: unknown, _tabId?: string): Promise<string> {
    this.calls.push({ method: 'captureScreenshot', targetGen: this.documentGeneration });
    return Buffer.from(`screenshot-gen-${this.documentGeneration}`).toString('base64');
  }

  async evalJs(expression: string, tabId?: string): Promise<unknown> {
    this.calls.push({ method: 'evalJs', targetGen: this.documentGeneration, args: [expression] });
    if (this.evalJsOverride) {
      return this.evalJsOverride(expression, tabId);
    }
    return null;
  }

  getDiagnostics(tabId?: string): { console: unknown[]; failures: unknown[] } {
    this.calls.push({ method: 'getDiagnostics', targetGen: this.documentGeneration });
    if (this.diagnosticsProvider) {
      return this.diagnosticsProvider(tabId);
    }
    return { console: [], failures: [] };
  }

  async runResponsiveCheck(tabId: string): Promise<Record<string, unknown>> {
    this.calls.push({ method: 'runResponsiveCheck', targetGen: this.documentGeneration });
    if (this.responsiveCheckOverride) {
      return this.responsiveCheckOverride(tabId);
    }
    return { breakpoints: {} };
  }
}

describe('Theme QA Fresh Target Reliability', () => {
  it('waits for load completion before inspecting, propagates fresh generation 2 across all operations and reports', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-fresh-order-'));
    const host = new StatefulBrowserHost();
    let releaseReload!: (val: boolean) => void;
    const reloadPromise = new Promise<boolean>((resolve) => {
      releaseReload = resolve;
    });
    host.reloadPromiseOverride = reloadPromise;

    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifactStore);
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts: artifactStore,
      reload: (t) => browser.reload(t),
    });

    const targetGen1 = makeTarget(1);
    const validatePromise = workflow.validate({
      runId: 'run-12345678901234567890',
      attemptId: 'attempt-12345678901234567890',
      workspaceRoot: root,
      target: targetGen1,
    });

    // Wait for Stage 1 FS debounce (150ms) to complete and trigger reload
    await new Promise((r) => setTimeout(r, 200));
    // Assert: Before reload releases, only synchronous pre-reload diagnostics and pre-reload listTabs were called.
    // No getDom, captureScreenshot, or evalJs should have run.
    const preReleaseCalls = host.calls.map((c) => c.method);
    assert.ok(preReleaseCalls.includes('reload'), 'Reload must be initiated');
    assert.ok(preReleaseCalls.includes('getDiagnostics'), 'Pre-reload diagnostics must be read');
    assert.strictEqual(preReleaseCalls.includes('getDom'), false, 'DOM inspection must not occur before reload completes');
    assert.strictEqual(preReleaseCalls.includes('captureScreenshot'), false, 'Screenshot must not occur before reload completes');
    assert.strictEqual(preReleaseCalls.includes('evalJs'), false, 'Evals must not occur before reload completes');

    // Release reload to load-complete (generation 2)
    releaseReload(true);
    const report = await validatePromise;

    // Assert: After release, all target-bound calls use generation 2
    assert.strictEqual(report.target.documentGeneration, 2, 'Returned report target must have generation 2');
    assert.strictEqual(host.documentGeneration, 2, 'Host generation must be 2');

    // Verify DOM artifact contains generation-2 content
    const domArtifact = report.artifacts.find((a) => a.kind === 'dom');
    assert.ok(domArtifact, 'DOM artifact must be present');
    const { data: domData } = artifactStore.readBytesById(domArtifact.id);
    assert.ok(domData.toString('utf8').includes('Store Gen 2'), 'DOM artifact must be from post-reload generation 2');

    // Verify report artifact JSON contains target with documentGeneration 2
    const reportArtifact = report.artifacts.find((a) => a.kind === 'report');
    assert.ok(reportArtifact, 'Report artifact must be present');
    const { data: reportData } = artifactStore.readBytesById(reportArtifact.id);
    const reportJson = JSON.parse(reportData.toString('utf8'));
    assert.strictEqual(reportJson.target.documentGeneration, 2, 'Report JSON target must be generation 2');

    // Verify that every post-reload call recorded targetGen 2
    const postReloadCalls = host.calls.filter((c) => c.method === 'getDom' || c.method === 'captureScreenshot' || c.method === 'evalJs');
    assert.ok(postReloadCalls.length > 0, 'Post-reload calls must exist');
    for (const call of postReloadCalls) {
      assert.strictEqual(call.targetGen, 2, `Call ${call.method} must use generation 2`);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails with TARGET_STALE when reload returns false without executing post-reload evidence or scanners', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-fresh-fail-'));
    const host = new StatefulBrowserHost();
    host.failReload = true;

    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifactStore);
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts: artifactStore,
      reload: (t) => browser.reload(t),
    });

    await assert.rejects(
      async () => {
        await workflow.validate({
          runId: 'run-12345678901234567890',
          attemptId: 'attempt-12345678901234567890',
          workspaceRoot: root,
          target: makeTarget(1),
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'TARGET_STALE');
        return true;
      }
    );

    // Verify no DOM, screenshot, or eval was called
    const calledMethods = host.calls.map((c) => c.method);
    assert.strictEqual(calledMethods.includes('getDom'), false);
    assert.strictEqual(calledMethods.includes('captureScreenshot'), false);
    assert.strictEqual(calledMethods.includes('evalJs'), false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('separates pre-reload diagnostics (audit-only) from fresh diagnostics (gate-verdict)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-diag-sep-'));
    const host = new StatefulBrowserHost();

    let diagCallCount = 0;
    host.diagnosticsProvider = () => {
      diagCallCount++;
      if (diagCallCount === 1) {
        // Pre-reload diagnostics (generation 1): contains a critical error
        return {
          console: [
            { level: 3, message: 'Pre-reload fatal error', source: 'https://store.example.com/old.js', isFirstParty: true },
          ],
          failures: [],
        };
      }
      // Fresh diagnostics (generation 2): clean / no errors
      return {
        console: [],
        failures: [],
      };
    };

    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifactStore);
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts: artifactStore,
      reload: (t) => browser.reload(t),
    });

    const report = await workflow.validate({
      runId: 'run-12345678901234567890',
      attemptId: 'attempt-12345678901234567890',
      workspaceRoot: root,
      target: makeTarget(1),
    });

    // Two diagnostics reads must have occurred
    assert.strictEqual(diagCallCount, 2, 'Exactly two diagnostics reads must occur (pre-reload and post-reload)');

    // Verdict must PASS because fresh diagnostics are clean
    assert.strictEqual(report.summary.passed, true, 'Fresh clean diagnostics must determine the verdict');
    assert.strictEqual(report.summary.criticalCount, 0, 'Critical count must be 0 for fresh diagnostics');
    assert.strictEqual(report.checklist.diagnostics, true, 'Checklist diagnostics must be true');
    assert.strictEqual(report.findings?.diagnosticIssues.length, 0);

    // Pre-reload fatal error must be preserved in preReloadDiagnostics for audit
    assert.ok(report.findings?.preReloadDiagnostics, 'preReloadDiagnostics must be populated');
    const preReload = report.findings?.preReloadDiagnostics;
    assert.ok(preReload);
    assert.strictEqual(preReload.criticalIssues.length, 1);
    assert.ok(preReload.criticalIssues[0]?.message.includes('Pre-reload fatal error'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rethrows target lifecycle errors from each individual scanner catch block rather than silently masking them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-rethrow-all-'));
    const liquidScript = LiquidErrorScanner.getBrowserScanScript();
    const layoutScript = LayoutOverflowEngine.getBrowserScanScript('active');
    const brokenAssetScript = BrokenAssetScanner.getBrowserScanScript();

    const scannerCases = [
      {
        name: 'Liquid scanner eval',
        isTarget: (expr: string) => expr === liquidScript || expr.includes('liquid') || expr.includes('Liquid'),
        throwOnResponsive: false,
        multiBreakpoint: false,
      },
      {
        name: 'Layout overflow scanner eval',
        isTarget: (expr: string) => expr === layoutScript || expr.includes('overflow') || expr.includes('scrollWidth'),
        throwOnResponsive: false,
        multiBreakpoint: false,
      },
      {
        name: 'Responsive check API',
        isTarget: () => false,
        throwOnResponsive: true,
        multiBreakpoint: true,
      },
      {
        name: 'Broken asset scanner eval',
        isTarget: (expr: string) => expr === brokenAssetScript || expr.includes('broken') || expr.includes('naturalWidth'),
        throwOnResponsive: false,
        multiBreakpoint: false,
      },
      {
        name: 'HS gate rules eval',
        isTarget: (expr: string) => expr.includes('HS-') || expr.includes('violations') || expr.includes('sapo') || expr.includes('haravan'),
        throwOnResponsive: false,
        multiBreakpoint: false,
      },
    ];

    for (const sc of scannerCases) {
      const host = new StatefulBrowserHost();
      host.evalJsOverride = async (expr: string) => {
        if (expr.includes('document.fonts') || expr.includes('rafPromise') || expr.includes('settleScript')) {
          return true;
        }
        if (sc.isTarget(expr)) {
          throw new CapabilityError('TARGET_STALE', `Document generation is stale in ${sc.name}`);
        }
        if (expr === liquidScript || expr.includes('liquid') || expr.includes('Liquid')) {
          return { hasErrors: false, errors: [], scannedElementsCount: 1 };
        }
        if (expr === layoutScript || expr.includes('overflow') || expr.includes('scrollWidth')) {
          return {
            viewport: { name: 'desktop', width: 1440, height: 900 },
            hasOverflow: false,
            deltaX: 0,
            scrollWidth: 1440,
            clientWidth: 1440,
            culprits: [],
          };
        }
        if (expr === brokenAssetScript || expr.includes('broken') || expr.includes('naturalWidth')) {
          return {
            hasBrokenAssets: false,
            brokenAssets: [],
            totalImagesScanned: 1,
            totalStylesheetsScanned: 1,
          };
        }
        return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
      };

      if (sc.throwOnResponsive) {
        host.responsiveCheckOverride = async () => {
          throw new CapabilityError('TARGET_STALE', 'Document generation is stale in responsiveCheck');
        };
      }

      const artifactStore = new ArtifactStore({ root: path.join(root, `artifacts-${sc.name.replace(/\s+/g, '-')}`) });
      const browser = new BrowserControlPort(host, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: artifactStore,
        reload: (t) => browser.reload(t),
      });

      await assert.rejects(
        async () => {
          await workflow.validate({
            runId: 'run-12345678901234567890',
            attemptId: 'attempt-12345678901234567890',
            workspaceRoot: root,
            target: makeTarget(1),
            multiBreakpoint: sc.multiBreakpoint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError, `${sc.name} must throw CapabilityError`);
          assert.strictEqual((err as CapabilityError).code, 'TARGET_STALE');
          return true;
        },
        `${sc.name} throwing TARGET_STALE must propagate instead of being swallowed`
      );
    }

    // Assert: TARGET_MISMATCH and TARGET_REQUIRED also propagate
    const otherCodes: Array<{ name: string; error: CapabilityError }> = [
      { name: 'TARGET_MISMATCH', error: new CapabilityError('TARGET_MISMATCH', 'Target mismatch') },
      { name: 'TARGET_REQUIRED', error: new CapabilityError('TARGET_REQUIRED', 'Target required') },
    ];
    for (const oc of otherCodes) {
      const hostOther = new StatefulBrowserHost();
      hostOther.evalJsOverride = async () => {
        throw oc.error;
      };
      const artifactStoreOther = new ArtifactStore({ root: path.join(root, `artifacts-${oc.name}`) });
      const browserOther = new BrowserControlPort(hostOther, artifactStoreOther);
      const workflowOther = new ThemeQaWorkflow({
        browser: browserOther,
        artifacts: artifactStoreOther,
        reload: (t) => browserOther.reload(t),
      });
      await assert.rejects(
        async () => {
          await workflowOther.validate({
            runId: 'run-12345678901234567890',
            attemptId: 'attempt-12345678901234567890',
            workspaceRoot: root,
            target: makeTarget(1),
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual((err as CapabilityError).code, oc.error.code);
          return true;
        }
      );
    }

    // Assert: Non-target error (e.g. generic script eval error) retains static analysis fallback
    const hostNonTarget = new StatefulBrowserHost();
    hostNonTarget.evalJsOverride = async (expr: string) => {
      if (expr.includes('document.fonts') || expr.includes('rafPromise') || expr.includes('settleScript')) {
        return true;
      }
      throw new Error('Some arbitrary non-target DOM execution error');
    };
    const artifactStoreNonTarget = new ArtifactStore({ root: path.join(root, 'artifacts-fallback') });
    const browserNonTarget = new BrowserControlPort(hostNonTarget, artifactStoreNonTarget);
    const workflowNonTarget = new ThemeQaWorkflow({
      browser: browserNonTarget,
      artifacts: artifactStoreNonTarget,
      reload: (t) => browserNonTarget.reload(t),
    });

    const report = await workflowNonTarget.validate({
      runId: 'run-12345678901234567890',
      attemptId: 'attempt-12345678901234567890',
      workspaceRoot: root,
      target: makeTarget(1),
    });
    assert.ok(report, 'Non-target error must fall back gracefully to static analysis');
    const hostDiagStale = new StatefulBrowserHost();
    hostDiagStale.diagnosticsProvider = () => {
      throw new CapabilityError('TARGET_STALE', 'Tab diagnostics target is stale');
    };
    const artifactStoreDiag = new ArtifactStore({ root: path.join(root, 'artifacts-diag-stale') });
    const browserDiag = new BrowserControlPort(hostDiagStale, artifactStoreDiag);
    const workflowDiag = new ThemeQaWorkflow({
      browser: browserDiag,
      artifacts: artifactStoreDiag,
      reload: (t) => browserDiag.reload(t),
    });
    await assert.rejects(
      async () => {
        await workflowDiag.validate({
          runId: 'run-12345678901234567890',
          attemptId: 'attempt-12345678901234567890',
          workspaceRoot: root,
          target: makeTarget(1),
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'TARGET_STALE');
        return true;
      },
      'Diagnostics lifecycle error must propagate'
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('aborts ThemeQaWorkflow.validate immediately when signal is aborted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-qa-abort-test-'));
    const host = new StatefulBrowserHost();
    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifactStore);
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts: artifactStore,
      reload: (t) => browser.reload(t),
    });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await workflow.validate({
          runId: 'run-12345678901234567890',
          attemptId: 'attempt-12345678901234567890',
          workspaceRoot: root,
          target: makeTarget(1),
          signal: controller.signal,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'TARGET_STALE');
        return true;
      },
      'Pre-aborted signal must throw TARGET_STALE'
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('manages background jobs and aborts old generations cleanly in AsyncThemeQaQueue', async () => {
    const queue = new AsyncThemeQaQueue();
    let task1Aborted = false;
    let task2Completed = false;

    // Enqueue task 1 with generation 1
    queue.enqueue('tab-1', 1, async (signal) => {
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          task1Aborted = true;
          resolve();
        });
      });
    });

    assert.strictEqual(queue.isRunning('tab-1'), true);
    assert.strictEqual(queue.getActiveJob('tab-1')?.generation, 1);

    // Enqueue task 2 with generation 2 (simulating navigation)
    queue.enqueue('tab-1', 2, async (signal) => {
      task2Completed = true;
    });

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(task1Aborted, true, 'Task 1 must have been aborted when generation bumped');
    assert.strictEqual(task2Completed, true, 'Task 2 must complete');
    assert.strictEqual(queue.isRunning('tab-1'), false, 'Queue must be empty after task 2 completes');
  });
});
