import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert';
import { withEvalCeiling, evalHardCeilingMs } from '../../src/main/browser/eval-ceiling';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { SplitPaneId } from '../../src/shared/contracts';

/**
 * The never-settling rows pump virtual time instead of waiting the ~3.1s ceiling out in real
 * time: the ceiling is derived (soft + 3s), so no test budget shortens it. Each row proves the
 * refusal is still pending one millisecond before the ceiling and lands exactly at it.
 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('withEvalCeiling & TabDevToolsHost bounded eval', () => {
  // Row a: helper with work that never settles + softBudgetMs ~100 -> rejects with EVAL_HARD_TIMEOUT, terminate called once
  it('a. helper: work that never settles + softBudgetMs ~100 rejects with EVAL_HARD_TIMEOUT and terminates once', { timeout: 6000 }, async () => {
    let terminateCalls = 0;
    let terminateTarget: any = null;
    const mockWc = { isDestroyed: () => false } as any;
    const softBudgetMs = 100;
    const expectedHardBudgetMs = evalHardCeilingMs(softBudgetMs); // max(100+3000, 250) = 3100ms
    assert.strictEqual(expectedHardBudgetMs, 3100);

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled = false;
      const pending = assert.rejects(
        withEvalCeiling({
          wc: mockWc,
          label: 'test never settle',
          softBudgetMs,
          work: () => new Promise<never>(() => {}),
          terminate: async (target) => {
            terminateCalls++;
            terminateTarget = target;
          },
        }).finally(() => {
          settled = true;
        }),
        (err: any) => {
          assert.ok(err instanceof CapabilityError, 'Must reject with CapabilityError');
          assert.strictEqual(err.code, 'EVAL_HARD_TIMEOUT');
          assert.ok(err.message.includes('test never settle did not answer within 3100ms'));
          return true;
        }
      );
      await settle();
      mock.timers.tick(expectedHardBudgetMs - 1);
      await settle();
      assert.strictEqual(settled, false, 'Must await the hard ceiling (3100ms), not refuse earlier');
      assert.strictEqual(terminateCalls, 0, 'Terminate must not run before the hard ceiling');
      mock.timers.tick(1);
      await pending;
      assert.strictEqual(terminateCalls, 1, 'Terminate must be called exactly once');
      assert.strictEqual(terminateTarget, mockWc, 'Terminate must receive the target wc');
    } finally {
      mock.timers.reset();
    }
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
      visibleTerminalSessions: () => [],
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

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled = false;
      const pending = assert.rejects(
        host.getDom().finally(() => {
          settled = true;
        }),
        (err: any) => {
          assert.ok(err instanceof CapabilityError, 'Must be a CapabilityError');
          assert.strictEqual(err.code, 'EVAL_HARD_TIMEOUT');
          assert.ok(err.message.includes('dom dump did not answer within 3100ms'));
          return true;
        }
      );
      await settle();
      mock.timers.tick(3099);
      await settle();
      assert.strictEqual(settled, false, 'Must await the hard ceiling (3100ms), not refuse earlier');
      mock.timers.tick(1);
      await pending;
      await settle();
      assert.ok(
        cdpCommands.some((c) => c.method === 'Runtime.terminateExecution'),
        'Must have invoked Runtime.terminateExecution via CDP'
      );
    } finally {
      mock.timers.reset();
    }
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

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let returned = false;
      // startLens must return cleanly rather than hanging or throwing
      const pending = host.startLens().then(() => {
        returned = true;
      });
      await settle();
      mock.timers.tick(3099);
      await settle();
      assert.strictEqual(returned, false, 'Must await the hard ceiling (3100ms), not give up earlier');
      mock.timers.tick(1);
      await pending;

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

      // When capture fails/times out, GPU_LENS_SCRIPT must NOT be injected and lens must be reset to inactive
      const gpuLensScript = scriptsExecuted.find((s) => s.includes('antifan-gpu-lens'));
      assert.strictEqual(gpuLensScript, undefined, 'GPU_LENS_SCRIPT must not be injected when capture fails');
      assert.strictEqual(host.getIsLensActive(), false, 'Lens must be reset to inactive on capture failure');
    } finally {
      mock.timers.reset();
      console.error = origError;
    }
  });
});
