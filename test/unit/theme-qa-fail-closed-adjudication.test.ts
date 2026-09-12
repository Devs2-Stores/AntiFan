import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ThemeQaWorkflow, ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { VisualSettleReceipt } from '../../src/main/verification/capture-settle';

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
  }): ThemeQaWorkflowPorts => {
    let currentGen = overrides?.initialDocGen ?? 1;
    const hasSettle = overrides?.hasSettleCapture ?? true;

    const browserObj: Record<string, unknown> = {
      dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
      screenshot: async () => ({
        artifactRef: { id: 'art-screenshot', kind: 'screenshot' },
        envelope: {},
      }),
      eval: async (_target: BrowserTarget, script: string) => {
        if (script.includes('LiquidErrorScanner')) {
          return { hasErrors: false, errors: [], scannedElementsCount: 20 };
        }
        if (script.includes('LayoutOverflowEngine')) {
          return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
        }
        if (script.includes('BrokenAssetScanner')) {
          return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
        }
        if (script.includes('HsGateRules')) {
          return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
        }
        if (script.includes('ServerCrashScanner')) {
          return { hasCrash: false, errorsCount: 0, findings: [] };
        }
        return {};
      },
      diagnostics: overrides?.diagnostics ?? (() => ({ console: [], failures: [] })),
      listTabs: () => [{ id: 'tab-1', url: 'https://store.example.com' }],
      getDocumentGeneration: () => currentGen,
    };

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
});
