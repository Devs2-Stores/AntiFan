import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { withEvalCeiling, evalHardCeilingMs } from '../../src/main/browser/eval-ceiling';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { SplitPaneId } from '../../src/shared/contracts';

describe('withEvalCeiling & TabDevToolsHost bounded eval', () => {
  // Row a: helper with work that never settles + softBudgetMs ~100 -> rejects with EVAL_HARD_TIMEOUT, terminate called once
  it('a. helper: work that never settles + softBudgetMs ~100 rejects with EVAL_HARD_TIMEOUT and terminates once', { timeout: 6000 }, async () => {
    let terminateCalls = 0;
    let terminateTarget: any = null;
    const mockWc = { isDestroyed: () => false } as any;
    const softBudgetMs = 100;
    const expectedHardBudgetMs = evalHardCeilingMs(softBudgetMs); // max(100+3000, 250) = 3100ms
    assert.strictEqual(expectedHardBudgetMs, 3100);

    const t0 = Date.now();
    await assert.rejects(
      async () => {
        await withEvalCeiling({
          wc: mockWc,
          label: 'test never settle',
          softBudgetMs,
          work: () => new Promise<never>(() => {}),
          terminate: async (target) => {
            terminateCalls++;
            terminateTarget = target;
          },
        });
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError, 'Must reject with CapabilityError');
        assert.strictEqual(err.code, 'EVAL_HARD_TIMEOUT');
        assert.ok(err.message.includes('test never settle did not answer within 3100ms'));
        return true;
      }
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 3000, `Must await hard ceiling (~3100ms), actual: ${elapsed}ms`);
    assert.strictEqual(terminateCalls, 1, 'Terminate must be called exactly once');
    assert.strictEqual(terminateTarget, mockWc, 'Terminate must receive the target wc');
  });

  // Row b: helper with work that resolves / rejects
  it('b. helper: work that resolves returns value; work that rejects surfaces original error unchanged', async () => {
    // Resolving work
    const result = await withEvalCeiling({
      wc: undefined,
      label: 'test resolve',
      softBudgetMs: 500,
      work: async () => 'hello world',
    });
    assert.strictEqual(result, 'hello world');

    // Rejecting work with custom error
    const customError = new TypeError('custom error');
    await assert.rejects(
      async () => {
        await withEvalCeiling({
          wc: undefined,
          label: 'test reject',
          softBudgetMs: 500,
          work: async () => {
            throw customError;
          },
        });
      },
      (err: any) => {
        assert.strictEqual(err, customError, 'Original error must surface unchanged, not replaced by timeout');
        return true;
      }
    );
  });

  // Harness for host tests
  function createMockHostContext(options: { evalSoftBudgetMs?: number } = {}) {
    const scriptsExecuted: string[] = [];
    const cdpCommands: Array<{ method: string; params: any }> = [];
    let broadcastCount = 0;

    let attached = false;
    const mockWc: any = {
      id: 42,
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        scriptsExecuted.push(script);
        return '<html><body>test</body></html>';
      },
      capturePage: async () => ({
        isEmpty: () => false,
        toPNG: () => Buffer.from([]),
        toDataURL: () => 'data:image/png;base64,mock',
        getSize: () => ({ width: 800, height: 600 }),
      }),
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        once: () => {},
        on: () => {},
        sendCommand: async (method: string, params: any) => {
          cdpCommands.push({ method, params });
          return {};
        },
      },
      on: () => {},
    };

    const tabRecord: any = {
      state: {
        id: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        zoomFactor: 1,
        devicePresetId: 'responsive',
      },
      focusedPane: 'desktop' as SplitPaneId,
      view: { webContents: mockWc },
    };

    const ctx: TabDevToolsContext = {
      getTabWebContents: () => mockWc,
      getTabRecord: () => tabRecord,
      getActiveTabId: () => 'tab-1',
      getAllTabs: () => [[ 'tab-1', tabRecord ]] as any,
      broadcastState: () => {
        broadcastCount++;
      },
      resolveTargetWorkspace: () => '',
      resolveAnnotationWorkspace: () => '',
      getTabTerminalSession: () => undefined,
      createTab: () => 'tab-1',
      withTabAgentWorking: async (_tabId, action) => action(),
      evalSoftBudgetMs: options.evalSoftBudgetMs,
    };

    return { ctx, mockWc, tabRecord, scriptsExecuted, cdpCommands, getBroadcastCount: () => broadcastCount };
  }

  // Row c: getDom with a never-settling mock eval refuses with EVAL_HARD_TIMEOUT
  it('c. getDom with a never-settling mock eval refuses with EVAL_HARD_TIMEOUT instead of hanging', { timeout: 6000 }, async () => {
    const { ctx, mockWc, cdpCommands } = createMockHostContext({
      evalSoftBudgetMs: 100,
    });
    // Make executeJavaScript never settle
    mockWc.executeJavaScript = () => new Promise<never>(() => {});

    const host = new TabDevToolsHost(ctx);

    const t0 = Date.now();
    await assert.rejects(
      async () => {
        await host.getDom();
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError, 'Must be a CapabilityError');
        assert.strictEqual(err.code, 'EVAL_HARD_TIMEOUT');
        assert.ok(err.message.includes('dom dump did not answer within 3100ms'));
        return true;
      }
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 3000, `Must await hard ceiling (~3100ms), actual: ${elapsed}ms`);
    assert.ok(
      cdpCommands.some((c) => c.method === 'Runtime.terminateExecution'),
      'Must have invoked Runtime.terminateExecution via CDP'
    );
  });

  // Row d: startLens with a never-settling capturePage mock returns, failure visible, no fabricated snapshot
  it('d. startLens with a never-settling capturePage mock returns, logs failure, and fabricates no snapshot', { timeout: 6000 }, async () => {
    const { ctx, mockWc, scriptsExecuted } = createMockHostContext({
      evalSoftBudgetMs: 100,
    });
    // Make capturePage never settle
    mockWc.capturePage = () => new Promise<never>(() => {});

    const loggedErrors: any[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => {
      loggedErrors.push(args);
      origError(...args);
    };

    const host = new TabDevToolsHost(ctx);

    try {
      const t0 = Date.now();
      // startLens must return cleanly rather than hanging or throwing
      await host.startLens();
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 3000, `Must await hard ceiling (~3100ms), actual: ${elapsed}ms`);

      // Failure must be visible via explicit log with typed error message
      const lensErrorLog = loggedErrors.find(
        (args) => args[0] === '[tab-devtools-host] Failed to capture page for lens:'
      );
      assert.ok(lensErrorLog, 'Failure must be logged explicitly to console.error');
      const loggedErr = lensErrorLog[1];
      assert.ok(loggedErr instanceof CapabilityError, 'Logged error must be CapabilityError');
      assert.strictEqual(loggedErr.code, 'EVAL_HARD_TIMEOUT');
      assert.ok(loggedErr.message.includes('lens capture did not answer within 3100ms'));

      // No snapshot must be fabricated or injected into window.__antifanLensScreenshot
      const snapshotScript = scriptsExecuted.find((s) => s.includes('window.__antifanLensScreenshot ='));
      assert.strictEqual(snapshotScript, undefined, 'Must not inject snapshot script or substitute blank image');

      // Fire-and-forget GPU_LENS_SCRIPT must still have run
      const gpuLensScript = scriptsExecuted.find((s) => s.includes('antifan-gpu-lens'));
      assert.ok(gpuLensScript, 'GPU_LENS_SCRIPT injection must still run after capture refusal');
    } finally {
      console.error = origError;
    }
  });
});
