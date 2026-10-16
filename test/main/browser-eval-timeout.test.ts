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
        assert.ok(msg.includes('[new Promise(()=>{})]'), `expected expression preview suffix, got: ${msg}`);
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
        assert.ok(msg.includes('[new Promise(()=>{})]'), `expected expression preview suffix, got: ${msg}`);
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

describe('TabDevToolsHost.evalJs across a navigation', () => {
  // A stub web contents that can emit Electron's did-start-navigation
  // (event, url, isInPlace, isMainFrame) while a script is pending.
  const makeNavHost = (settle: (emit: (url: string, isInPlace: boolean) => void) => Promise<unknown>) => {
    const listeners = new Set<(...args: unknown[]) => void>();
    const emit = (url: string, isInPlace: boolean) => { for (const l of listeners) l({}, url, isInPlace, true); };
    const wc = {
      isDestroyed: () => false,
      getURL: () => 'https://eval.test/',
      on: (name: string, fn: (...args: unknown[]) => void) => { if (name === 'did-start-navigation') listeners.add(fn); },
      removeListener: (name: string, fn: (...args: unknown[]) => void) => { if (name === 'did-start-navigation') listeners.delete(fn); },
      executeJavaScript: () => settle(emit),
    } as unknown as Electron.WebContents;
    const record = { id: 'tab-1', state: { id: 'tab-1', url: 'https://eval.test/' }, focusedPane: 'desktop' } as unknown as NativeTabRecord;
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
    return { host: new TabDevToolsHost(ctx), listeners };
  };
  const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('a same-document move (pushState, hash) does not cut the script short', async () => {
    const { host } = makeNavHost(async (emit) => { emit('https://eval.test/#reviews', true); return later(50, 42); });
    assert.strictEqual(await host.evalJs('42', 'tab-1', 'desktop', false, 2_000), 42);
  });

  it('a script that finishes within the grace after starting a navigation keeps its result', async () => {
    const { host } = makeNavHost(async (emit) => { emit('https://eval.test/cart', false); return later(100, 'done'); });
    assert.strictEqual(await host.evalJs('x', 'tab-1', 'desktop', false, 5_000), 'done');
  });

  it('a script still pending after a cross-document navigation is refused with the new URL', async () => {
    const { host, listeners } = makeNavHost(async (emit) => { emit('https://eval.test/checkout', false); return new Promise(() => {}); });
    await assert.rejects(
      () => host.evalJs('wait()', 'tab-1', 'desktop', false, 10_000),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_STALE');
        assert.match(err.message, /navigated to https:\/\/eval\.test\/checkout/);
        return true;
      }
    );
    assert.strictEqual(listeners.size, 0, 'the navigation listener is removed');
  });
});

describe('TabDevToolsHost evaluation failures cross the Electron boundary readable', () => {
  // What `executeJavaScript` hands Main for an in-page rejection, as measured against the
  // shipped Electron: a native Error arrives as a bare Error carrying only its message (an
  // Error subclass loses its name), a DOMException as `{}` (its name and message are
  // prototype getters), a plain object as its own data, and a thrown null RESOLVES undefined.
  // A child frame's `executeJavaScript` reports a native Error by its `stack` instead.
  const crossElectronBoundary = async (run: () => unknown, lane: 'page' | 'frame'): Promise<unknown> => {
    try {
      return await run();
    } catch (thrown: unknown) {
      if (thrown === null || thrown === undefined) return undefined;
      if (thrown instanceof DOMException) throw { ...thrown };
      if (thrown instanceof Error) throw new Error(lane === 'frame' ? String(thrown.stack) : thrown.message);
      if (typeof thrown === 'object') throw { ...thrown };
      throw thrown;
    }
  };
  const doc = { hidden: false, visibilityState: 'visible' };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = (code: string) => () => new Function('document', 'return ' + code)(doc);
  const runPage = (code: string): Promise<unknown> => crossElectronBoundary(evaluate(code), 'page');
  const runFrame = (code: string): Promise<unknown> => crossElectronBoundary(evaluate(code), 'frame');

  const makeHost = (): TabDevToolsHost => {
    const root = { url: 'https://eval.test/', frameTreeNodeId: 1, framesInSubtree: [] as unknown[], executeJavaScript: runFrame };
    const child = { url: 'https://checkout.example/embed', frameTreeNodeId: 2, executeJavaScript: runFrame };
    root.framesInSubtree = [root, child];
    const wc = { isDestroyed: () => false, executeJavaScript: runPage, mainFrame: root } as unknown as Electron.WebContents;
    const record = {
      id: 'tab-1',
      state: { id: 'tab-1', url: 'https://eval.test/', title: 'Eval', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 },
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

  const invalidSelector = `(() => { throw new DOMException("'#shopify-section-*' is not a valid selector.", 'SyntaxError'); })()`;
  const readable = (pattern: RegExp) => (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${JSON.stringify(err)}`);
    assert.match(err.message, pattern);
    return true;
  };

  it('a DOMException thrown in the page rejects with its name and message', async () => {
    await assert.rejects(
      () => makeHost().evalJs(invalidSelector, 'tab-1', 'desktop', false, 2_000),
      readable(/SyntaxError: '#shopify-section-\*' is not a valid selector\./)
    );
  });

  it('an Error subclass keeps the name that identifies it', async () => {
    const expression = `(() => { class QuotaError extends Error { constructor(m) { super(m); this.name = 'QuotaError'; } } throw new QuotaError('storage full'); })()`;
    await assert.rejects(() => makeHost().evalJs(expression, 'tab-1', 'desktop', false, 2_000), readable(/^QuotaError: storage full$/));
  });

  it('a thrown null is a failure, never a resolved undefined', async () => {
    await assert.rejects(() => makeHost().evalJs('(() => { throw null; })()', 'tab-1', 'desktop', false, 2_000), readable(/^null$/));
  });

  it('a DOMException thrown in a child frame is reported with its name and message', async () => {
    await assert.rejects(
      () => makeHost().evalJsInFrame(invalidSelector, 'checkout.example', 'tab-1', 'desktop', false, 2_000),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${String(err)}`);
        assert.strictEqual(err.code, 'EXECUTION_ERROR');
        assert.match(err.message, /SyntaxError: '#shopify-section-\*' is not a valid selector\./);
        assert.doesNotMatch(err.message, /\[object Object\]/);
        return true;
      }
    );
  });

  it('a child frame failure points at the code that threw, never at the evaluation wrapper', async () => {
    const expression = `(function checkoutStep() { throw new TypeError('cart is empty'); })()`;
    await assert.rejects(
      () => makeHost().evalJsInFrame(expression, 'checkout.example', 'tab-1', 'desktop', false, 2_000),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${String(err)}`);
        assert.match(err.message, /evaluation failed: TypeError: cart is empty\n/);
        assert.match(err.message, /at checkoutStep/);
        assert.doesNotMatch(err.message, /normalizeThrown/);
        return true;
      }
    );
  });

  it('a page whose policy forbids eval still answers through the CDP fallback', async () => {
    // Chromium refuses the wrapper's indirect eval under `script-src` without 'unsafe-eval' with
    // an EvalError; the fallback is chosen by reading that rejection's message in Main, so the
    // normalized message must still carry the policy wording.
    const refused = `(() => { throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \\"script-src 'none'\\"."); })()`;
    const host = makeHost();
    const cdpCalls: string[] = [];
    host.sendCdpCommand = (async (_wc: Electron.WebContents, method: string) => {
      cdpCalls.push(method);
      return { result: { value: { answeredBy: 'cdp' } } };
    }) as typeof host.sendCdpCommand;
    const value = await host.evalJs(refused, 'tab-1', 'desktop', false, 2_000);
    assert.deepStrictEqual(value, { answeredBy: 'cdp' });
    assert.deepStrictEqual(cdpCalls, ['Runtime.evaluate']);
  });

  it('an in-page Event rejection surfaces Event(type) and target instead of empty {}', async () => {
    await assert.rejects(
      () => makeHost().evalJs(`Promise.reject(new Event('error'))`, 'tab-1', 'desktop', false, 2_000),
      (err: unknown) => {
        assert.ok(err instanceof Error, `expected Error, got ${String(err)}`);
        assert.match(err.message, /Event\(error\)/);
        assert.doesNotMatch(err.message, /^\{\}$/);
        return true;
      }
    );

    const eventWithTarget = `(() => {
      const ev = new Event('error');
      Object.defineProperty(ev, 'target', { value: { tagName: 'IMG', src: 'https://cdn.example/missing.png' } });
      return Promise.reject(ev);
    })()`;
    await assert.rejects(
      () => makeHost().evalJs(eventWithTarget, 'tab-1', 'desktop', false, 2_000),
      readable(/Event\(error\) on <img https:\/\/cdn\.example\/missing\.png>/)
    );
  });

  it('an ErrorEvent with a message preserves its message alongside the Event(type) prefix', async () => {
    const errorEventWithTarget = `(() => {
      class ErrorEvent extends Event {
        constructor(type, init) {
          super(type);
          this.message = (init && init.message) || '';
        }
      }
      const ev = new ErrorEvent('error', { message: 'Uncaught ReferenceError: x is not defined' });
      Object.defineProperty(ev, 'target', { value: { tagName: 'SCRIPT', src: 'https://cdn.example/app.js' } });
      return Promise.reject(ev);
    })()`;
    await assert.rejects(
      () => makeHost().evalJs(errorEventWithTarget, 'tab-1', 'desktop', false, 2_000),
      readable(/^Event\(error\) on <script https:\/\/cdn\.example\/app\.js>: Uncaught ReferenceError: x is not defined$/)
    );
  });

  it('a non-Event object carrying a .type property is not mislabelled as Event(...)', async () => {
    const plainWithType = `Promise.reject({ type: 'cors', status: 502 })`;
    await assert.rejects(
      () => makeHost().evalJs(plainWithType, 'tab-1', 'desktop', false, 2_000),
      (err: unknown) => {
        assert.ok(err instanceof Error, `expected Error, got ${String(err)}`);
        assert.doesNotMatch(err.message, /Event\(/);
        assert.match(err.message, /"type":"cors"/);
        return true;
      }
    );

    const blobWithType = `Promise.reject(new Blob(['x'], { type: 'image/png' }))`;
    await assert.rejects(
      () => makeHost().evalJs(blobWithType, 'tab-1', 'desktop', false, 2_000),
      (err: unknown) => {
        assert.ok(err instanceof Error, `expected Error, got ${String(err)}`);
        assert.doesNotMatch(err.message, /Event\(/);
        assert.match(err.message, /Blob: \[object Blob\]/);
        return true;
      }
    );
  });

  it('a child frame evaluation timeout carries the expression preview', async () => {
    await assert.rejects(
      () => makeHost().evalJsInFrame('new Promise(()=>{})', 'checkout.example', 'tab-1', 'desktop', false, 80),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${String(err)}`);
        assert.strictEqual(err.code, 'EXECUTION_ERROR');
        assert.ok(err.message.includes('Evaluation timed out after 80ms (tab visibility: visible) [new Promise(()=>{})]'), `expected timeout with expression preview, got: ${err.message}`);
        return true;
      }
    );
  });
});
