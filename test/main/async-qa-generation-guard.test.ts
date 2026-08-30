import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';

describe('Async QA Generation Guard & Race-Condition Defense', () => {
  const createMockPorts = (initialDocGen = 1) => {
    let currentDocGen = initialDocGen;
    const artifactsMap = new Map<string, { kind: string; data: Buffer }>();
    let artifactCounter = 1;

    return {
      getDocGen: () => currentDocGen,
      setDocGen: (g: number) => { currentDocGen = g; },
      ports: {
        browser: {
          dom: async () => '<html><body><div>Test</div></body></html>',
          screenshot: async () => 'data:image/png;base64,mock',
          eval: async (_target: BrowserTarget, script: string) => {
            if (script.includes('LayoutOverflowEngine')) {
              return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
            }
            if (script.includes('LiquidErrorScanner')) {
              return { hasErrors: false, errors: [], scannedElementsCount: 50 };
            }
            if (script.includes('BrokenAssetScanner')) {
              return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 10, totalStylesheetsScanned: 2 };
            }
            if (script.includes('HsGateRules')) {
              return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
            }
            return {};
          },
          responsiveCheck: async () => ({}),
          diagnostics: () => ({ console: [], failures: [] }),
          listTabs: () => [{ id: 'tab-guard-1', url: 'https://demo.haravan.com' }],
          getDocumentGeneration: () => currentDocGen,
        },
        reload: async (target: BrowserTarget) => {
          // Synthetic reload advances document generation to post-reload state
          currentDocGen++;
          return {
            reloaded: true,
            target: { ...target, documentGeneration: currentDocGen },
          };
        },
        artifacts: {
          stage: (input: { kind: string; data: Buffer }) => {
            const id = `art-${artifactCounter++}`;
            artifactsMap.set(id, { kind: input.kind, data: input.data });
            return { id, kind: input.kind, bytes: input.data.length, createdAt: Date.now() };
          },
          readBytesById: (id: string) => {
            const entry = artifactsMap.get(id);
            if (!entry) throw new Error(`Artifact ${id} not found`);
            return { data: entry.data };
          },
        },
      },
    };
  };

  it('completes validation without self-aborting on synthetic workflow reload', async () => {
    const mock = createMockPorts(1);
    const workflow = new ThemeQaWorkflow(mock.ports as any);

    const target: BrowserTarget = {
      tabId: 'tab-guard-1',
      browserEpoch: 1,
      documentGeneration: 1,
      projectId: 'test-proj',
      workspaceId: 'test-ws',
      runtimeId: 'test-rt',
      url: 'https://demo.haravan.com',
    };

    const report = await workflow.validate({
      runId: 'run-guard-1',
      attemptId: 'att-guard-1',
      target,
      workspaceRoot: 'E:/Work/test-theme',
    });

    assert.ok(report);
    assert.strictEqual(report.summary.passed, true);
    assert.strictEqual(report.summary.totalIssues, 0);
  });

  it('aborts and throws TARGET_STALE when user navigates during scan', async () => {
    const mock = createMockPorts(1);
    // Simulate user navigation advancing document generation during inspect/eval
    const originalEval = mock.ports.browser.eval;
    mock.ports.browser.eval = async (target, script) => {
      mock.setDocGen(99); // External user navigation occurred
      return originalEval(target, script);
    };

    const workflow = new ThemeQaWorkflow(mock.ports as any);

    const target: BrowserTarget = {
      tabId: 'tab-guard-1',
      browserEpoch: 1,
      documentGeneration: 1,
      projectId: 'test-proj',
      workspaceId: 'test-ws',
      runtimeId: 'test-rt',
      url: 'https://demo.haravan.com',
    };

    await assert.rejects(
      async () => {
        await workflow.validate({
          runId: 'run-guard-2',
          attemptId: 'att-guard-2',
          target,
          workspaceRoot: 'E:/Work/test-theme',
        });
      },
      (err: unknown) => {
        return err instanceof CapabilityError && err.code === 'TARGET_STALE';
      }
    );
  });

  it('aborts cleanly when signal is aborted externally', async () => {
    const mock = createMockPorts(1);
    const controller = new AbortController();
    controller.abort();

    const workflow = new ThemeQaWorkflow(mock.ports as any);

    const target: BrowserTarget = {
      tabId: 'tab-guard-1',
      browserEpoch: 1,
      documentGeneration: 1,
      projectId: 'test-proj',
      workspaceId: 'test-ws',
      runtimeId: 'test-rt',
      url: 'https://demo.haravan.com',
    };

    await assert.rejects(
      async () => {
        await workflow.validate({
          runId: 'run-guard-3',
          attemptId: 'att-guard-3',
          target,
          workspaceRoot: 'E:/Work/test-theme',
          signal: controller.signal,
        });
      },
      (err: unknown) => {
        return err instanceof CapabilityError && err.code === 'TARGET_STALE';
      }
    );
  });
});
