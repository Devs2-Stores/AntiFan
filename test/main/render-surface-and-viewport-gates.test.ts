import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import type { NativeTabRecord } from '../../src/main/browser/native-tab-host';
import { REFERENCE_MATERIALIZATION_BOUND_MS, type VerificationCaptureEnvelope } from '../../src/main/verification/visual-capture';

const TARGET: BrowserTarget = {
  tabId: 'tab-b',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  runtimeId: 'runtime-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

/** PNG header only: enough for the buffer-length and receipt checks. */
function envelope(data: string, captureMode: 'viewport' | 'full-page', extra: Partial<VerificationCaptureEnvelope> = {}): VerificationCaptureEnvelope {
  return {
    data,
    backend: 'cdp',
    dpr: 1,
    zoom: 1,
    captureMode,
    cssViewport: { width: 1440, height: 900 },
    cssCaptureSize: { width: 1440, height: 900 },
    rasterSize: { width: 1440, height: 900 },
    rasterWidth: 1440,
    rasterHeight: 900,
    timestamp: Date.now(),
    ...extra,
  } as VerificationCaptureEnvelope;
}

interface HostOptions {
  surface?: { vw: number; vh: number } | null;
  surfaceThrows?: Error;
  capture?: (tabId: string) => Promise<VerificationCaptureEnvelope>;
  setViewportSize?: (opts: { width: number; height: number; tabId?: string }) => Promise<boolean> | boolean;
  sessionTabList?: () => unknown[];
  adoptReturns?: boolean;
  evalJs?: (script: string, tabId?: string, paneId?: string, userGesture?: boolean, timeoutMs?: number) => Promise<unknown> | unknown;
}

function buildHost(opts: HostOptions) {
  const calls = { capture: 0, close: [] as string[], geometryRestores: 0, eval: 0, drains: 0 };
  const host: Partial<BrowserHostPort> & Record<string, unknown> = {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-b' }],
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    getManagedTabIds: () => new Set(['tab-b']),
    isTabAllowed: () => true,
    drainTarget: async (): Promise<{ ok: boolean; drained: boolean; resetPerformed: boolean; elapsedMs: number }> => {
      calls.drains++;
      return { ok: true, drained: true, resetPerformed: false, elapsedMs: 1 };
    },
    readRenderSurface: async (): Promise<{ vw: number; vh: number; dpr: number; scrollX: number; scrollY: number; docH: number; readyState: string; hidden: boolean }> => {
      if (opts.surfaceThrows) throw opts.surfaceThrows;
      const s = opts.surface ?? { vw: 1440, vh: 900 };
      return { vw: s.vw, vh: s.vh, dpr: 1, scrollX: 0, scrollY: 0, docH: 5000, readyState: 'complete', hidden: false };
    },
    captureVerificationScreenshot: async (_rect?: unknown, tabId?: string) => {
      calls.capture++;
      if (!opts.capture) throw new Error('capture not configured');
      return opts.capture(tabId || '');
    },
    setViewportSize: async (o: { width: number; height: number; tabId?: string }) => {
      if (!opts.setViewportSize) return true;
      return opts.setViewportSize(o);
    },
    reapplyTabGeometry: async () => {
      calls.geometryRestores++;
      return { before: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, after: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, restored: true, attempts: 1 };
    },
    closeTab: (tabId: string) => {
      calls.close.push(tabId);
      return true;
    },
    createTab: () => 'tab-new',
    adoptChildTab: () => opts.adoptReturns !== false,
    getSessionTabList: opts.sessionTabList,
    evalJs: async (script: string, tabId?: string, paneId?: string, userGesture?: boolean, timeoutMs?: number) => {
      calls.eval++;
      if (opts.evalJs) return opts.evalJs(script, tabId, paneId, userGesture, timeoutMs);
      if (script.includes('innerWidth')) return { innerWidth: 1440, innerHeight: 900 };
      return true;
    },
    navigate: async () => true,
  };
  return { host: host as unknown as BrowserHostPort, calls };
}

describe('Render-surface precondition (no laid-out surface)', () => {
  it('refuses a viewport capture on a 0x0 tab with NO_RENDER_SURFACE and never dispatches the capture', async () => {
    const { host, calls } = buildHost({ surface: { vw: 0, vh: 0 } });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.screenshot(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'NO_RENDER_SURFACE');
        assert.match(err.message, /1440|0x0|no laid-out surface/);
        return true;
      }
    );
    assert.strictEqual(calls.capture, 0, 'a capture must not be dispatched on a tab with no surface');
  });

  it('refuses evaluate by default but allows the diagnostic escape hatch on a 0x0 tab', async () => {
    const { host, calls } = buildHost({ surface: { vw: 0, vh: 0 } });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.eval(TARGET, '1 + 1', 'tab-b', 'desktop', { requireRenderSurface: true }),
      (err: unknown) => (err instanceof CapabilityError ? err.code === 'NO_RENDER_SURFACE' : false)
    );
    const before = calls.eval;
    const value = await port.eval(TARGET, '1 + 1', 'tab-b', 'desktop', { requireRenderSurface: true, allowDegradedSurface: true });
    assert.strictEqual(value, true);
    assert.strictEqual(calls.eval, before + 1, 'the escape hatch must reach the evaluation');
  });

  it('does not gate readers that do not declare the requirement', async () => {
    const { host, calls } = buildHost({ surface: { vw: 0, vh: 0 } });
    const port = new BrowserControlPort(host);
    const before = calls.eval;
    await port.eval(TARGET, 'document.title', 'tab-b', 'desktop');
    assert.strictEqual(calls.eval, before + 1);
  });

  it('refuses capture when the surface cannot be measured at all', async () => {
    const { host } = buildHost({ surfaceThrows: new Error('renderer gone') });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.screenshot(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop'),
      (err: unknown) => (err instanceof CapabilityError ? err.code === 'NO_RENDER_SURFACE' : false)
    );
  });
});

describe('Viewport write verification', () => {
  it('reports VIEWPORT_NOT_APPLIED with a classified cause when the tab never measures the requested size', async () => {
    const { host } = buildHost({
      surface: { vw: 1200, vh: 800 },
      setViewportSize: () => true,
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.setViewport({ width: 1440, height: 900, tabId: 'tab-b' }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'VIEWPORT_NOT_APPLIED');
        assert.deepStrictEqual(err.details as Record<string, unknown> | undefined, {
          tabId: 'tab-b',
          expectedWidth: 1440,
          expectedHeight: 900,
          observedWidth: 1200,
          observedHeight: 800,
          cause: 'geometry-mismatch',
        });
        return true;
      }
    );
  });

  it('reports VIEWPORT_NOT_APPLIED (unmeasurable) when the surface cannot be read', async () => {
    const { host } = buildHost({ surfaceThrows: new Error('no surface') });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.setViewport({ width: 1440, height: 900, tabId: 'tab-b' }),
      (err: unknown) => (err instanceof CapabilityError ? err.code === 'VIEWPORT_NOT_APPLIED' : false)
    );
  });

  it('reports the measured geometry and verified flag once the tab matches the request', async () => {
    const { host } = buildHost({ surface: { vw: 1440, vh: 900 } });
    const port = new BrowserControlPort(host);
    const res = await port.setViewport({ width: 1440, height: 900, tabId: 'tab-b' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.observedWidth, 1440);
    assert.strictEqual(res.observedHeight, 900);
  });
});

describe('Session-scoped tab listing and adoption', () => {
  it('lists agent-plane tabs from the session listing and flags only the bound tab', () => {
    const { host } = buildHost({
      sessionTabList: () => [
        { id: 'tab-b', title: 'Offscreen agent tab', offscreen: true },
        { id: 'tab-child', title: 'Child' },
      ],
    });
    const port = new BrowserControlPort(host);
    const tabs = port.listTabs({ target: TARGET }) as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      tabs.map((t) => [t.id, t.isBoundTab, t.isPrimaryTab]),
      [
        ['tab-b', true, true],
        ['tab-child', false, false],
      ]
    );
  });

  it('lists nothing for a session that owns no tab instead of leaking the user strip', () => {
    const { host } = buildHost({
      sessionTabList: () => [],
    });
    const port = new BrowserControlPort(host);
    assert.deepStrictEqual(port.listTabs({ target: TARGET }), []);
    // The whole-window listing is an explicit request, not a fallback.
    assert.deepStrictEqual(port.listTabs({}), [{ id: 'tab-b' }]);
  });

  it('closes and fails a tab the session cannot adopt instead of leaking it', () => {
    const { host, calls } = buildHost({ adoptReturns: false });
    const port = new BrowserControlPort(host);
    assert.throws(
      () => port.openTab({ url: 'about:blank' }, { target: TARGET }),
      (err: unknown) => (err instanceof CapabilityError ? err.code === 'POLICY_DENIED' : false)
    );
    assert.deepStrictEqual(calls.close, ['tab-new'], 'the unadoptable tab must be closed');
  });
});

describe('Capture geometry is a transaction', () => {
  it('refuses the bytes and quarantines when the capture admits it could not restore the viewport', async () => {
    const { host } = buildHost({
      capture: async () => envelope(Buffer.from('png-bytes').toString('base64'), 'full-page', {
        viewportTransaction: { before: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, after: null, restored: false, attempts: 2 },
      }),
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.screenshotFullPage(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop'),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'CAPTURE_VIEWPORT_NOT_RESTORED');
        return true;
      }
    );
  });

  it('returns the envelope when the capture proves it restored the viewport', async () => {
    const { host } = buildHost({
      capture: async () => envelope(Buffer.from('png-bytes').toString('base64'), 'full-page', {
        viewportTransaction: { before: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, after: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, restored: true, attempts: 1 },
      }),
    });
    const port = new BrowserControlPort(host);
    const res = await port.screenshotFullPage(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop');
    assert.strictEqual(res.ok, true);
    assert.ok(res.sha256);
  });

  it('refuses a full-page capture whose tab has no surface before creating a capture budget', async () => {
    const { host, calls } = buildHost({ surface: { vw: 0, vh: 0 } });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.screenshotFullPage(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop'),
      (err: unknown) => (err instanceof CapabilityError ? err.code === 'NO_RENDER_SURFACE' : false)
    );
    assert.strictEqual(calls.capture, 0);
  });

  it('drains and restores the target when the execution budget abandons an in-flight capture', async () => {
    const { host, calls } = buildHost({
      capture: () => new Promise<VerificationCaptureEnvelope>(() => {}),
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.screenshotFullPage(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop', { timeoutMs: 120 }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        // Whichever layer notices first — the outer execution budget or the inner
        // capture bound — the caller gets the same truth: a target that needs
        // draining, not a bare budget message hiding a wedged renderer.
        assert.strictEqual(err.code, 'TARGET_BUSY_DRAINING');
        const details = err.details as Record<string, unknown> | undefined;
        assert.strictEqual(details?.quarantined, false, 'a drained target must be released again');
        return true;
      }
    );
    assert.strictEqual(calls.drains, 1, 'an abandoned capture must drain the transport it left busy');
    assert.strictEqual(calls.geometryRestores, 1, 'and must prove the capture geometry was put back');
  });
});

describe('DOM export materialization', () => {
  it('preserves the existing export when materialization fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'antifan-export-'));
    const destination = path.join(dir, 'index.html');
    try {
      await fs.writeFile(destination, 'previous export');
      const { host } = buildHost({ evalJs: async () => { throw new Error('walk failed'); } });
      await assert.rejects(new BrowserControlPort(host).dumpDom(TARGET, destination),
        (error: unknown) => error instanceof CapabilityError && error.code === 'REFERENCE_MATERIALIZATION_INCOMPLETE');
      assert.equal(await fs.readFile(destination, 'utf8'), 'previous export');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unconfirmed walk but permits explicit raw export', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'antifan-export-'));
    const destination = path.join(dir, 'index.html');
    try {
      const { host } = buildHost({ evalJs: async () => null });
      host.getDom = async () => '<html><body>exported</body></html>';
      const port = new BrowserControlPort(host);
      await assert.rejects(port.dumpDom(TARGET, destination),
        (error: unknown) => error instanceof CapabilityError && error.code === 'REFERENCE_MATERIALIZATION_INCOMPLETE');
      await assert.rejects(fs.access(destination));
      await port.dumpDom(TARGET, destination, { materialize: false, clean: false });
      assert.equal(await fs.readFile(destination, 'utf8'), '<html><body>exported</body></html>');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Reference capture fails closed', () => {
  it('refuses to stage a reference when the settle barrier does not complete', async () => {
    const { host } = buildHost({
      evalJs: async (script: string) => {
        if (script.includes('innerWidth')) return { innerWidth: 1440, innerHeight: 900 };
        if (script.includes('img.decode')) return { settled: false, brokenImages: ['https://cdn.example/broken.png'] };
        if (script.includes('document.fonts.ready')) return true;
        if (script.includes('requestAnimationFrame')) return true;
        return { materialized: true, href: 'https://hoplongtech.com/gioi-thieu/', passes: 2, docHeight: 5000, decoded: 0, imagesStillPending: 3 };
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.referenceCapture(TARGET, 'run-1', 'attempt-1', { tabId: 'tab-b', screenshot: false }),
      (err: unknown) => (err instanceof CapabilityError ? err.code === 'SETTLE_INCOMPLETE' : false)
    );
  });

  it('refuses to stage a reference the page cannot identify', async () => {
    const { host } = buildHost({
      evalJs: async (script: string) => {
        if (script.includes('img.decode') || script.includes('document.fonts.ready') || script.includes('requestAnimationFrame')) return true;
        if (script.includes('innerWidth')) return { innerWidth: 1440, innerHeight: 900 };
        return { materialized: true, href: '', passes: 1, docHeight: 5000 };
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.referenceCapture(TARGET, 'run-1', 'attempt-1', { tabId: 'tab-b', screenshot: false }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'REFERENCE_MATERIALIZATION_INCOMPLETE');
        assert.strictEqual((err.details as Record<string, unknown> | undefined)?.cause, 'identity-unavailable');
        return true;
      }
    );
  });

  it('refuses when the materialization walk does not return', async () => {
    const { host } = buildHost({
      evalJs: async (script: string) => {
        if (script.includes('img.decode') || script.includes('document.fonts.ready') || script.includes('requestAnimationFrame')) return true;
        if (script.includes('innerWidth')) return { innerWidth: 1440, innerHeight: 900 };
        return null;
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.referenceCapture(TARGET, 'run-1', 'attempt-1', { tabId: 'tab-b', screenshot: false }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'REFERENCE_MATERIALIZATION_INCOMPLETE');
        assert.strictEqual((err.details as Record<string, unknown> | undefined)?.cause, 'walk-empty');
        return true;
      }
    );
  });

  it('reports why the walk failed instead of blaming its own bound', async () => {
    let walkBudget: number | undefined;
    const { host } = buildHost({
      evalJs: async (script: string, _tabId?: string, _paneId?: string, _userGesture?: boolean, timeoutMs?: number) => {
        if (script.includes('img.decode') || script.includes('document.fonts.ready') || script.includes('requestAnimationFrame')) return true;
        if (script.includes('innerWidth')) return { innerWidth: 1440, innerHeight: 900 };
        walkBudget = timeoutMs;
        throw new Error('Evaluation timed out after 30000ms (note: requestAnimationFrame pauses in background tabs)');
      },
    });
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.referenceCapture(TARGET, 'run-1', 'attempt-1', { tabId: 'tab-b', screenshot: false }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'REFERENCE_MATERIALIZATION_INCOMPLETE');
        const details = err.details as Record<string, unknown> | undefined;
        assert.strictEqual(details?.cause, 'eval-failed');
        assert.match(String(details?.evalError), /timed out/);
        return true;
      }
    );
    // The walk declares its own budget; the in-page execution guard has to hear
    // it, or the script is killed at the guard's default while the failure is
    // reported against a bound the script never reached.
    assert.strictEqual(walkBudget, REFERENCE_MATERIALIZATION_BOUND_MS);
  });
});

describe('Eval execution guard ceiling', () => {
  function buildDevTools() {
    const scripts: string[] = [];
    const wc = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        return 'ok';
      },
    };
    const ctx: TabDevToolsContext = {
      getTabWebContents: () => wc as unknown as Electron.WebContents,
      getTabRecord: () => ({ state: { id: 'tab-b' } }) as unknown as NativeTabRecord,
      getActiveTabId: () => 'tab-b',
      getAllTabs: () => [][Symbol.iterator]() as unknown as IterableIterator<[string, NativeTabRecord]>,
      broadcastState: () => {},
      getTabTerminalSession: () => undefined,
      resolveTargetWorkspace: () => 'E:/Work/project',
      resolveAnnotationWorkspace: () => 'E:/Work/project',
      createTab: () => 'tab-created',
      withTabAgentWorking: (_tabId, action) => action(),
      switchTab: () => true,
    };
    return { devTools: new TabDevToolsHost(ctx), scripts };
  }

  it('honours the caller budget so a long-running walk is not killed at the default ceiling', async () => {
    const { devTools, scripts } = buildDevTools();
    await devTools.evalJs('1 + 1', 'tab-b', 'desktop', false, 25_000);
    const [script = ''] = scripts;
    assert.match(script, /execBudgetMs = 25000;/, 'the in-page guard must run with the budget its caller declared');
  });

  it('keeps the background-tab default ceiling when no budget is given', async () => {
    const { devTools, scripts } = buildDevTools();
    await devTools.evalJs('1 + 1', 'tab-b', 'desktop');
    const [script = ''] = scripts;
    assert.match(script, /execBudgetMs = 15000;/, 'an unbounded caller still gets the requestAnimationFrame-freeze guard');
  });
});
