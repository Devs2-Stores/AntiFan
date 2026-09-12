import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ThemeQaWorkflow, ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { VisualSettleReceipt } from '../../src/main/verification/capture-settle';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { BrokenAssetScanner } from '../../src/main/qa/scanners/broken-asset-scanner';
import { HsGateRules } from '../../src/main/qa/rules/hs-gate-rules';
import { ServerCrashScanner } from '../../src/main/qa/scanners/server-crash-scanner';

const layoutScript = LayoutOverflowEngine.getBrowserScanScript('active');
const liquidScript = LiquidErrorScanner.getBrowserScanScript();
const assetScript = BrokenAssetScanner.getBrowserScanScript();
const serverCrashScript = ServerCrashScanner.getBrowserScanScript();

describe('Phase 01 — Fail-Closed Adjudication & Lifecycle Attestation', () => {
  const makeTarget = (docGen = 1): BrowserTarget => ({
    projectId: 'proj-test',
    workspaceId: 'ws-test',
    runtimeId: 'rt-test',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: docGen,
  });

  const createMockPorts = (overrides?: {
    settleCapture?: (target: BrowserTarget) => Promise<VisualSettleReceipt>;
    hasSettleCapture?: boolean;
    initialDocGen?: number;
    diagnostics?: () => { console: unknown[]; failures: unknown[] };
    responsiveCheck?: (tabId: string) => Promise<Record<string, unknown>>;
    eval?: (target: BrowserTarget, script: string) => Promise<unknown>;
  }): ThemeQaWorkflowPorts => {
    let currentGen = overrides?.initialDocGen ?? 1;
    const hasSettle = overrides?.hasSettleCapture ?? true;

    const browserObj: Record<string, unknown> = {
      dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
      screenshot: async () => ({
        artifactRef: { id: 'art-screenshot', kind: 'screenshot' },
        envelope: {},
      }),
      eval: overrides?.eval ?? (async (_target: BrowserTarget, script: string) => {
        if (script === layoutScript || script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX')) {
          return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
        }
        if (script === liquidScript || script.includes('ERROR_PATTERNS')) {
          return { hasErrors: false, errors: [], scannedElementsCount: 20 };
        }
        if (script === assetScript || script.includes('naturalWidth') || script.includes('img.decode')) {
          return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
        }
        if (script.includes('HS-') || script.includes('violations') || script.includes('sapo') || script.includes('haravan') || script.includes('evaluateHtml')) {
          return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
        }
        if (script === serverCrashScript || script.includes('crash') || script.includes('ServerCrashScanner')) {
          return { hasCrash: false, errorsCount: 0, findings: [] };
        }
        return {};
      }),
      diagnostics: overrides?.diagnostics ?? (() => ({ console: [], failures: [] })),
      listTabs: () => [{ id: 'tab-1', url: 'https://store.example.com' }],
      getDocumentGeneration: () => currentGen,
    };
    if (overrides?.responsiveCheck) {
      browserObj.responsiveCheck = overrides.responsiveCheck;
    }

    if (hasSettle) {
      browserObj.settleCapture = overrides?.settleCapture ?? (async () => ({
        settleComplete: true,
        gates: { network: true, fonts: true, images: true, dom: true },
        timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 },
        brokenImages: [],
      }));
    }

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
      reload: async (target: BrowserTarget) => {
        currentGen++;
        return {
          reloaded: true,
          target: { ...target, documentGeneration: currentGen },
        };
      },
    };
  };

  it('1. Pure read-only QA runs cleanly without waiting for nonexistent upload and passes when clean', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-ro',
      attemptId: 'att-ro',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });

    assert.strictEqual(report.summary.passed, true);
    assert.strictEqual(report.summary.criticalCount, 0);
    assert.strictEqual(report.qaMatrix?.passed, true);
    assert.strictEqual(report.qaMatrix?.verdict, 'PASS');
    assert.strictEqual(report.settleReceipt?.settleComplete, true);
  });

  it('2. Missing authoritative settle capability prevents false PASS certification (fails closed)', async () => {
    const ports = createMockPorts({ hasSettleCapture: false });
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-no-settle',
      attemptId: 'att-no-settle',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });

    assert.strictEqual(report.summary.passed, false, 'Summary must not pass when settle capability is missing');
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.strictEqual(report.checklist.diagnostics, true, 'Diagnostics must remain clean when no console/network errors exist');
    assert.strictEqual(report.summary.criticalCount, 0, 'Missing capability is evidence gap, not diagnostic critical defect');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('Authoritative settlement capability missing'))
    );
    assert.strictEqual(report.qaMatrix?.passed, false, 'qaMatrix must fail closed when settle capability is missing');
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('3. Incomplete settle gate throws SETTLE_INCOMPLETE and aborts validation', async () => {
    const ports = createMockPorts({
      settleCapture: async () => ({
        settleComplete: false,
        gates: { network: true, fonts: false, images: true, dom: true },
        timingsMs: { network: 5, fonts: 100, images: 5, dom: 5, total: 115 },
        brokenImages: [],
      }),
    });
    const workflow = new ThemeQaWorkflow(ports);

    await assert.rejects(
      async () => {
        await workflow.validate({
          runId: 'run-incomplete-settle',
          attemptId: 'att-incomplete-settle',
          workspaceRoot: 'E:/Work/test-theme',
          target: makeTarget(1),
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'SETTLE_INCOMPLETE');
        assert.ok(err.message.includes('fonts=false'));
        return true;
      }
    );
  });

  it('4. Known mutation session with missing upload barrier fails certification as INCONCLUSIVE', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-mutation-missing-barrier',
      attemptId: 'att-mutation-missing-barrier',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 10 },
        // syncReceipt omitted
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });
    assert.strictEqual(report.summary.passed, false, 'Mutation without upload barrier must not pass');
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.strictEqual(report.summary.criticalCount, 0, 'Missing barrier is evidence gap, not diagnostic critical defect');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('requires complete pre-mutation baseline'))
    );
    assert.strictEqual(report.qaMatrix?.passed, false, 'qaMatrix must not pass when upload barrier is missing');
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('4b. Rejects structural receipt alone without cursor and initialDocGen as INCONCLUSIVE', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-receipt-alone',
      attemptId: 'att-receipt-alone',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      mutationContext: {
        syncReceipt: {
          syncGen: 1,
          durationMs: 250,
          settledMethod: 'terminal-output',
          lastSeq: 42,
          sessionGeneration: 1,
        },
        // cursor and initialDocGen omitted!
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('structural receipt alone is not accepted'))
    );
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('4b2. Rejects malformed sync receipt as INCONCLUSIVE', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-invalid-receipt',
      attemptId: 'att-invalid-receipt',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(2),
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 10 },
        syncReceipt: {
          syncGen: 1,
          durationMs: -50, // negative duration!
          settledMethod: 'terminal-output',
          lastSeq: 42,
          sessionGeneration: 1,
        },
        initialDocGen: 1,
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('malformed'))
    );
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('4c. Rejects pre-mutation receipt (acknowledgment preceding mutation) as INCONCLUSIVE', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-pre-mutation-ack',
      attemptId: 'att-pre-mutation-ack',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 100 },
        syncReceipt: {
          syncGen: 1,
          durationMs: 250,
          settledMethod: 'terminal-output',
          lastSeq: 50, // preceding baselineSeq 100!
          sessionGeneration: 1,
        },
        initialDocGen: 0,
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('preceded or matched pre-mutation baseline'))
    );
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('4d. Rejects wrong-session receipt as INCONCLUSIVE', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-wrong-session',
      attemptId: 'att-wrong-session',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 10 },
        syncReceipt: {
          syncGen: 1,
          durationMs: 250,
          settledMethod: 'terminal-output',
          lastSeq: 42,
          sessionGeneration: 2, // mismatch with cursor sessionGeneration 1!
        },
        initialDocGen: 0,
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('does not match baseline cursor sessionGeneration'))
    );
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('4e. Rejects stale document generation lineage as INCONCLUSIVE', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-stale-docgen',
      attemptId: 'att-stale-docgen',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1), // docGen 1
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 10 },
        syncReceipt: {
          syncGen: 1,
          durationMs: 250,
          settledMethod: 'terminal-output',
          lastSeq: 42,
          sessionGeneration: 1,
        },
        initialDocGen: 1, // failed to advance beyond 1!
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });
    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('failed to advance beyond pre-mutation baseline'))
    );
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('4f. Active workspace transaction session with un-settled mutations cannot be bypassed by caller receipts', async () => {
    const ports = createMockPorts();
    const mockRegistry = {
      getActiveSession: () => ({
        sessionId: 'tx-unsettled-1',
        sessionState: 'mutated' as const,
        touchedFiles: ['templates/index.liquid'],
        lineage: { workspaceGen: 1, syncGen: 0, documentGeneration: 1, browserEpoch: 1 },
      }),
    };
    const workflow = new ThemeQaWorkflow({
      ...ports,
      transactionRegistry: mockRegistry as unknown as ConstructorParameters<typeof ThemeQaWorkflow>[0]['transactionRegistry'],
    });

    const report = await workflow.validate({
      runId: 'run-bypass-attempt',
      attemptId: 'att-bypass-attempt',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(2),
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 10 },
        syncReceipt: {
          syncGen: 1,
          durationMs: 250,
          settledMethod: 'terminal-output',
          lastSeq: 42,
          sessionGeneration: 1,
        },
        initialDocGen: 1,
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });

    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      report.findings?.evidenceGaps?.some((i) => i.includes('Active workspace mutation session "tx-unsettled-1" has un-settled mutations'))
    );
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('5. Mutation session with valid syncReceipt and advance passes certification', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-mutation-synced',
      attemptId: 'att-mutation-synced',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(2), // advanced to 2!
      mutationContext: {
        cursor: { sessionId: 'term-1', sessionGeneration: 1, baselineSeq: 10 },
        syncReceipt: {
          syncGen: 1,
          durationMs: 250,
          settledMethod: 'terminal-output',
          lastSeq: 42,
          sessionGeneration: 1,
        },
        initialDocGen: 1,
      },
      viewports: {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      },
    });

    assert.strictEqual(report.summary.passed, true);
    assert.strictEqual(report.summary.criticalCount, 0);
    assert.strictEqual(report.qaMatrix?.passed, true);
    assert.strictEqual(report.qaMatrix?.verdict, 'PASS');
  });

  it('6. Omitted viewports result in INCONCLUSIVE verdict, passed:false, and nullable scores', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-omitted-vp',
      attemptId: 'att-omitted-vp',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      // viewports omitted
    });

    assert.strictEqual(report.qaMatrix?.viewports.desktop.measured, false);
    assert.strictEqual(report.qaMatrix?.viewports.desktop.passed, false);
    assert.strictEqual(report.qaMatrix?.viewports.desktop.verdict, 'INCONCLUSIVE');
    assert.strictEqual(report.qaMatrix?.dimensions.visualFidelity.score, null);
    assert.strictEqual(report.qaMatrix?.dimensions.responsiveParity.score, null);
    assert.strictEqual(report.qaMatrix?.passed, false);
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
    assert.strictEqual(report.qaMatrix?.coverage?.measuredViewports, 0);
  });

  it('7. Invalid mismatch measurements (NaN, null, Infinity, out of range) cannot produce PASS even if caller passed:true', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-invalid-vp',
      attemptId: 'att-invalid-vp',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      viewports: {
        desktop: { mismatchPercent: NaN, passed: true },
        tablet: { mismatchPercent: Infinity, passed: true },
        mobile: { mismatchPercent: -10, passed: true },
      },
    });

    assert.strictEqual(report.qaMatrix?.viewports.desktop.measured, false);
    assert.strictEqual(report.qaMatrix?.viewports.desktop.passed, false);
    assert.strictEqual(report.qaMatrix?.viewports.tablet.measured, false);
    assert.strictEqual(report.qaMatrix?.viewports.tablet.passed, false);
    assert.strictEqual(report.qaMatrix?.viewports.mobile.measured, false);
    assert.strictEqual(report.qaMatrix?.viewports.mobile.passed, false);
    assert.strictEqual(report.qaMatrix?.passed, false);
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('8. Partial viewport coverage cannot produce PASS (INCONCLUSIVE with explicit coverage)', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-partial-vp',
      attemptId: 'att-partial-vp',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      viewports: {
        desktop: { mismatchPercent: 1.2, passed: true },
        // tablet & mobile omitted
      },
    });

    assert.strictEqual(report.qaMatrix?.viewports.desktop.measured, true);
    assert.strictEqual(report.qaMatrix?.viewports.desktop.passed, true);
    assert.strictEqual(report.qaMatrix?.viewports.tablet.measured, false);
    assert.strictEqual(report.qaMatrix?.viewports.mobile.measured, false);
    assert.strictEqual(report.qaMatrix?.coverage?.measuredViewports, 1);
    assert.strictEqual(report.qaMatrix?.coverage?.totalViewports, 3);
    assert.strictEqual(report.qaMatrix?.passed, false);
    assert.strictEqual(report.qaMatrix?.verdict, 'INCONCLUSIVE');
  });

  it('9. All measured viewports with absent compliance scan must not PASS (yields INCONCLUSIVE)', () => {
    const defaultSummary = { passed: true, totalIssues: 0, criticalCount: 0, verdict: 'PASS' as const };
    const checklistWithoutLiquid = {
      layout: true,
      responsive: true,
      overflow: true,
      interactions: true,
      diagnostics: true,
      assetsValid: true,
      hsCompliant: true,
      // liquidClean omitted (compliance scan absent)
    };

    const matrix = ThemeQaWorkflow.computeQaMatrix(
      defaultSummary,
      checklistWithoutLiquid as unknown as Parameters<typeof ThemeQaWorkflow.computeQaMatrix>[1],
      undefined,
      {
        desktop: { mismatchPercent: 0.5, passed: true },
        tablet: { mismatchPercent: 1.0, passed: true },
        mobile: { mismatchPercent: 1.5, passed: true },
      }
    );

    assert.strictEqual(matrix.passed, false, 'Must not PASS when compliance scan is absent');
    assert.strictEqual(matrix.verdict, 'INCONCLUSIVE');
    assert.strictEqual(matrix.dimensions.haravanCompliance.score, null);
    assert.ok(matrix.dimensions.haravanCompliance.details.includes('unmeasured or unknown'));
  });

  it('10. Responsive overflow without culprits fails summary and checklist.responsive (no false PASS, tablet attributed)', async () => {
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
      runId: 'run-overflow-no-culprits',
      attemptId: 'att-overflow-no-culprits',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      multiBreakpoint: true,
    });

    assert.strictEqual(report.findings?.overflow.hasOverflow, true);
    assert.strictEqual(report.findings?.overflow.viewport.name, 'tablet', 'Width 768 must be attributed to tablet');
    assert.strictEqual(report.findings?.overflow.viewport.width, 768);
    assert.strictEqual(report.checklist.responsive, false, 'Responsive checklist must not pass when responsive overflow exists');
    assert.strictEqual(report.checklist.layout, false);
    assert.strictEqual(report.checklist.overflow, false);
    assert.strictEqual(report.summary.passed, false, 'Summary must fail when responsive overflow exists');
    assert.strictEqual(report.summary.verdict, 'FAIL');
    assert.strictEqual(report.summary.criticalCount >= 1, true, 'Critical count must include responsive overflow even without culprits');

    const filteredReport = await workflow.validate({
      runId: 'run-overflow-filtered',
      attemptId: 'att-overflow-filtered',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      multiBreakpoint: true,
      enabledChecks: { responsive: true, layout: false, overflow: false },
    });
    assert.strictEqual(filteredReport.summary.passed, false, 'Summary must fail when responsive check is enabled and responsive overflow exists');
    assert.strictEqual(filteredReport.summary.verdict, 'FAIL');
  });

  it('11. Failed requested sweep yields INCONCLUSIVE under default enabled checks (precedence for known failure)', async () => {
    const ports = createMockPorts({
      responsiveCheck: async () => {
        throw new Error('CAPABILITY_NOT_FOUND: runResponsiveCheck is not supported by host');
      },
    });
    const workflow = new ThemeQaWorkflow(ports);

    // Subcase A: Clean scans but requested sweep failed -> INCONCLUSIVE
    const report = await workflow.validate({
      runId: 'run-failed-sweep',
      attemptId: 'att-failed-sweep',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      multiBreakpoint: true,
    });

    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
    assert.strictEqual(report.summary.criticalCount, 0, 'Missing sweep evidence is not an observed defect');
    assert.ok(
      report.findings?.evidenceGaps?.some((g) => g.includes('Responsive multi-breakpoint sweep failed or unsupported'))
    );

    // Subcase B: Known failure takes precedence over missing sweep evidence -> FAIL
    const portsWithFailure = createMockPorts({
      responsiveCheck: async () => {
        throw new Error('CAPABILITY_NOT_FOUND: runResponsiveCheck is not supported by host');
      },
      eval: async (_target: BrowserTarget, script: string) => {
        if (script === liquidScript || script.includes('ERROR_PATTERNS') || script.includes('LiquidErrorScanner')) {
          return { hasErrors: true, errors: [{ type: 'syntax', message: 'Unknown tag "foo"', location: 'index.liquid:1' }], scannedElementsCount: 5 };
        }
        if (script === layoutScript || script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX') || script.includes('LayoutOverflowEngine')) {
          return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
        }
        return {};
      },
    });
    const workflowWithFailure = new ThemeQaWorkflow(portsWithFailure);
    const failReport = await workflowWithFailure.validate({
      runId: 'run-failed-sweep-with-liquid',
      attemptId: 'att-failed-sweep-with-liquid',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      multiBreakpoint: true,
    });
    assert.strictEqual(failReport.summary.passed, false);
    assert.strictEqual(failReport.summary.verdict, 'FAIL', 'Known failure must take precedence over missing sweep evidence');
  });

  it('12. Empty or malformed requested sweep yields INCONCLUSIVE under default enabled checks', async () => {
    // Subcase A: Empty breakpoints
    const portsEmpty = createMockPorts({
      responsiveCheck: async () => ({ ok: true, breakpoints: {} }),
    });
    const workflowEmpty = new ThemeQaWorkflow(portsEmpty);
    const reportEmpty = await workflowEmpty.validate({
      runId: 'run-empty-sweep',
      attemptId: 'att-empty-sweep',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      multiBreakpoint: true,
    });
    assert.strictEqual(reportEmpty.summary.passed, false);
    assert.strictEqual(reportEmpty.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      reportEmpty.findings?.evidenceGaps?.some((g) => g.includes('no breakpoint measurements'))
    );

    // Subcase B: Malformed breakpoint rows (non-boolean hasHorizontalOverflow)
    const portsMalformed = createMockPorts({
      responsiveCheck: async () => ({
        ok: true,
        breakpoints: {
          'mobile-small': { width: 320, height: 568, mobile: true, hasHorizontalOverflow: undefined },
        },
      }),
    });
    const workflowMalformed = new ThemeQaWorkflow(portsMalformed);
    const reportMalformed = await workflowMalformed.validate({
      runId: 'run-malformed-sweep',
      attemptId: 'att-malformed-sweep',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
      multiBreakpoint: true,
    });
    assert.strictEqual(reportMalformed.summary.passed, false);
    assert.strictEqual(reportMalformed.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      reportMalformed.findings?.evidenceGaps?.some((g) => g.includes('malformed or incomplete'))
    );
  });

  it('13. Optional sweep preserved when not requested (no multiBreakpoint input)', async () => {
    const ports = createMockPorts();
    const workflow = new ThemeQaWorkflow(ports);

    const report = await workflow.validate({
      runId: 'run-no-sweep-requested',
      attemptId: 'att-no-sweep-requested',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
    });

    assert.strictEqual(report.summary.passed, true);
    assert.strictEqual(report.summary.verdict, 'PASS');
    assert.strictEqual(report.findings?.evidenceGaps, undefined, 'No evidence gaps when sweep is not requested');
  });

  it('14. Layout overflow scanner evaluation failure or non-object yields INCONCLUSIVE', async () => {
    // Subcase A: eval throws error
    const portsCrash = createMockPorts({
      eval: async (_target: BrowserTarget, script: string) => {
        if (script === layoutScript || script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX') || script.includes('LayoutOverflowEngine')) {
          throw new Error('CDP evaluation timed out');
        }
        if (script === liquidScript || script.includes('ERROR_PATTERNS') || script.includes('LiquidErrorScanner')) {
          return { hasErrors: false, errors: [], scannedElementsCount: 10 };
        }
        return {};
      },
    });
    const workflowCrash = new ThemeQaWorkflow(portsCrash);
    const reportCrash = await workflowCrash.validate({
      runId: 'run-layout-eval-crash',
      attemptId: 'att-layout-eval-crash',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
    });
    assert.strictEqual(reportCrash.summary.passed, false);
    assert.strictEqual(reportCrash.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      reportCrash.findings?.evidenceGaps?.some((g) => g.includes('Layout overflow scanner evaluation failed'))
    );

    // Subcase B: eval returns non-object / missing hasOverflow
    const portsNonObject = createMockPorts({
      eval: async (_target: BrowserTarget, script: string) => {
        if (script === layoutScript || script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX') || script.includes('LayoutOverflowEngine')) {
          return null;
        }
        if (script === liquidScript || script.includes('ERROR_PATTERNS') || script.includes('LiquidErrorScanner')) {
          return { hasErrors: false, errors: [], scannedElementsCount: 10 };
        }
        return {};
      },
    });
    const workflowNonObject = new ThemeQaWorkflow(portsNonObject);
    const reportNonObject = await workflowNonObject.validate({
      runId: 'run-layout-eval-nonobj',
      attemptId: 'att-layout-eval-nonobj',
      workspaceRoot: 'E:/Work/test-theme',
      target: makeTarget(1),
    });
    assert.strictEqual(reportNonObject.summary.passed, false);
    assert.strictEqual(reportNonObject.summary.verdict, 'INCONCLUSIVE');
    assert.ok(
      reportNonObject.findings?.evidenceGaps?.some((g) => g.includes('did not return valid measurement object'))
    );
  });
});
