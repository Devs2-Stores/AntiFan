import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import type { NativeTabRecord } from '../../src/main/browser/native-tab-host';

const target: BrowserTarget = {
  projectId: 'proj-eval',
  workspaceId: 'ws-eval',
  runtimeId: 'rt-eval',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

describe('Port eval: caller timeoutMs clamp', () => {
  const makeHost = (seen: { timeout?: unknown }): BrowserHostPort => ({
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-1' }],
    getActiveTabId: () => 'tab-1',
    getAutomationTabId: () => 'tab-1',
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => Buffer.from('fake').toString('base64'),
    evalJs: async (_expr: string, _tabId?: string, _paneId?: 'desktop' | 'mobile', _gesture?: boolean, timeoutMs?: number) => {
      seen.timeout = timeoutMs;
      return true;
    },
  });

  it('honours a caller timeoutMs inside the invocation budget', async () => {
    const seen: { timeout?: unknown } = {};
    const port = new BrowserControlPort(makeHost(seen));
    await port.eval(target, 'return 1', undefined, undefined, { timeoutMs: 1234 });
    assert.strictEqual(seen.timeout, 1234);
  });

  it('omits the timeout (host default) when the caller passes none', async () => {
    const seen: { timeout?: unknown } = {};
    const port = new BrowserControlPort(makeHost(seen));
    await port.eval(target, 'return 1');
    assert.strictEqual(seen.timeout, undefined);
  });

  it('refuses an over-budget timeoutMs with the real bound named, never clamps', async () => {
    const seen: { timeout?: unknown } = {};
    const port = new BrowserControlPort(makeHost(seen));
    await assert.rejects(
      () => port.eval(target, 'return 1', undefined, undefined, { timeoutMs: 999_999 }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'INVALID_ARGUMENT');
        const details = err.details as { requestedTimeoutMs?: number; effectiveMaxTimeoutMs?: number };
        assert.strictEqual(details?.requestedTimeoutMs, 999_999);
        assert.strictEqual(details?.effectiveMaxTimeoutMs, 29_000);
        return true;
      }
    );
    assert.strictEqual(seen.timeout, undefined, 'evalJs must not run when the ask exceeds the invocation budget');
  });

  it('rejects non-positive and non-finite timeoutMs before any eval', async () => {
    const seen: { timeout?: unknown } = {};
    const port = new BrowserControlPort(makeHost(seen));
    for (const bad of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => port.eval(target, 'return 1', undefined, undefined, { timeoutMs: bad }),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'INVALID_ARGUMENT');
          return true;
        }
      );
      assert.strictEqual(seen.timeout, undefined, `evalJs must not run for timeoutMs=${bad}`);
    }
  });
});

describe('TabDevToolsHost.evalJs in-page budget guard', () => {
  type ExecuteJs = (code: string, userGesture?: boolean) => Promise<unknown>;

  const makeHost = (executeJavaScript: ExecuteJs): TabDevToolsHost => {
    const wc = {
      isDestroyed: () => false,
      executeJavaScript,
    } as unknown as Electron.WebContents;

    const record = {
      id: 'tab-1',
      state: {
        id: 'tab-1',
        url: 'https://eval.test/',
        title: 'Eval',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
      },
      focusedPane: 'desktop',
    } as unknown as NativeTabRecord;

    const ctx: TabDevToolsContext = {
      getTabWebContents: () => wc,
      getTabRecord: () => record,
      getActiveTabId: () => 'tab-1',
      getAllTabs: function* () {},
      broadcastState: () => {},
      getTabTerminalSession: () => undefined,
      visibleTerminalSessions: () => [],
      resolveTargetWorkspace: () => 'ws-eval',
      resolveAnnotationWorkspace: () => 'ws-eval',
      createTab: () => 'tab-1',
      withTabAgentWorking: async <T>(_id: string, action: () => Promise<T>) => action(),
    };
    return new TabDevToolsHost(ctx);
  };

  // The page wrapper references `document` only to report the real visibility
  // the page measured. In Node there is no DOM, so the harness feeds the stub
  // a `document` binding and returns the IIFE promise verbatim — the in-page
  // timeout rejection surfaces exactly as the bridge would report it.
  const runInPage = (hidden: boolean): ExecuteJs => (code) => {
    const doc = { hidden, visibilityState: hidden ? 'hidden' : 'visible' };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return Promise.resolve(new Function('document', 'return ' + code)(doc));
  };

  it('soft budget timeout reports the real (visible) tab state', async () => {
    const host = makeHost(runInPage(false));
    const started = Date.now();
    await assert.rejects(
      () => host.evalJs('new Promise(()=>{})', 'tab-1', 'desktop', false, 80),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes('Evaluation timed out after'), `expected timeout message, got: ${msg}`);
        assert.ok(msg.includes('tab visibility: visible'), `expected visible suffix, got: ${msg}`);
        return true;
      }
    );
    // The in-page guard fired near its own budget — not the 15s default.
    assert.ok(Date.now() - started < 8_000, '80ms soft budget must fire promptly');
  });

  it('soft budget timeout reports hidden when the page itself reports hidden', async () => {
    const host = makeHost(runInPage(true));
    await assert.rejects(
      () => host.evalJs('new Promise(()=>{})', 'tab-1', 'desktop', false, 80),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes('tab visibility: hidden'), `expected hidden suffix, got: ${msg}`);
        return true;
      }
    );
  });

  it('returns the serialized expression result when it resolves inside the budget', async () => {
    const host = makeHost(runInPage(false));
    const result = await host.evalJs('1+1', 'tab-1', 'desktop', false, 2_000);
    assert.strictEqual(result, 2);
  });

  it('refuses a tab record that does not exist', async () => {
    const wc = { isDestroyed: () => false, executeJavaScript: async () => null } as unknown as Electron.WebContents;
    const ctx: TabDevToolsContext = {
      getTabWebContents: () => wc,
      getTabRecord: () => undefined,
      getActiveTabId: () => 'tab-1',
      getAllTabs: function* () {},
      broadcastState: () => {},
      getTabTerminalSession: () => undefined,
      visibleTerminalSessions: () => [],
      resolveTargetWorkspace: () => 'ws-eval',
      resolveAnnotationWorkspace: () => 'ws-eval',
      createTab: () => 'tab-1',
      withTabAgentWorking: async <T>(_id: string, action: () => Promise<T>) => action(),
    };
    const host = new TabDevToolsHost(ctx);
    await assert.rejects(
      () => host.evalJs('1', 'tab-missing'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        return true;
      }
    );
  });
});
